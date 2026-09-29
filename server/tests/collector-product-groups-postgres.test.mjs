import './support/dedicated-postgres-test-environment.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPostgresPool, closePostgresPool } from '../db/connection.mjs';
import { createCollectorTask, queueCollectorTaskRun, claimCollectorRun, claimCollectorRunSkus,
  claimCollectorRunProductGroup, saveCollectorRunGroupVariant, releaseCollectorRunProductGroup,
  upsertCollectorRunItem, failCollectorRun, getCollectorRunForAccount } from '../collector-desktop-service.mjs';
const enabled = process.env.SONLI_POSTGRES_TESTS === '1';
const options = { skip: !enabled, timeout: 30000 };
let pool;
before(async () => { if (enabled) { pool=await getPostgresPool(); await getCollectorRunForAccount('absent','absent'); } });
after(async () => { if(enabled) await closePostgresPool(); });
async function fixture(fn) {
 const accountId='group-'+randomUUID(),otherId='other-'+randomUUID();
 await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user')",[accountId,otherId]);
 const run=async (scope='ALL',account=accountId)=>{
  const task=await createCollectorTask({accountId:account,name:'整组验收',taskType:'CATEGORY',configuration:{captureScope:scope}});
  const {run:r}=await queueCollectorTaskRun({accountId:account,taskId:task.id});
  const lease=await claimCollectorRun({accountId:account,runId:r.id,device:{deviceKey:'test-device'}});
  return {accountId:account,runId:r.id,deviceId:lease.device.id,leaseToken:lease.leaseToken};
 };
 try {await fn({accountId,otherId,run});} finally {
  await pool.query('UPDATE collector_tasks SET current_run_id=NULL WHERE account_id=ANY($1::text[])',[[accountId,otherId]]);
  await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[[accountId,otherId]]);
 }
}
const detail=sku=>({id:sku,sku,name:'Товар '+sku,images:[`https://cdn.example.test/${sku}/1.jpg`,`https://cdn.example.test/${sku}/2.jpg`],price:'10.00',currencyCode:'CNY',storefrontPrice:{amount:'10.00',currencyCode:'CNY'}});
const claim=(run,anchorSku,skus)=>claimCollectorRunProductGroup({...run,anchorSku,skus});
const checkpoint=(run,group,anchorSku,sku)=>saveCollectorRunGroupVariant({...run,groupId:group.groupId,anchorSku,variant:detail(sku)});
const finish=(run,group,anchorSku,skus)=>upsertCollectorRunItem({...run,item:{source:'ozon',sourceKey:group.groupId,sourceSku:anchorSku,status:'QUALIFIED',rawPayload:{...detail(anchorSku),collectorGroupId:group.groupId,captureScope:'ALL',variantData:{expectedSkus:skus,variants:skus.map(detail)}}}});

test('different ranking entries and concurrent runs get one group owner, all members dedup before collect-box import',options,async()=>fixture(async({run})=>{
 const a=await run(),b=await run();
 await claimCollectorRunSkus({...a,skus:['101']});await claimCollectorRunSkus({...b,skus:['102']});
 const groups=await Promise.all([claim(a,'101',['101','102','103']),claim(b,'102',['103','102','101'])]);
 assert.deepEqual(groups.map(g=>g.status).sort(),['CLAIMED','COLLECTING']);
 const index=groups[0].status==='CLAIMED'?0:1,owner=index?b:a,other=index?a:b,anchor=index?'102':'101',g=groups[index];
 assert.equal(groups[0].groupId,groups[1].groupId);
 assert.equal((await claim(owner,anchor,['103','101','102'])).groupId,g.groupId,'lost-response replay');
 assert.equal((await claim(owner,anchor==='101'?'102':'101',['101','102','103'])).status,'COLLECTING','queued sibling in same run cannot capture again');
 await assert.rejects(checkpoint(other,g,anchor,'101'),{code:'COLLECTOR_GROUP_NOT_OWNED'});
 await checkpoint(owner,g,anchor,'101');await checkpoint(owner,g,anchor,'102');
 await assert.rejects(finish(owner,g,anchor,['101','102','103']),{code:'COLLECTOR_GROUP_INCOMPLETE'});
 await checkpoint(owner,g,anchor,'103');
 assert.equal((await finish(owner,g,anchor,['101','102','103'])).created,true);
 assert.equal((await finish(owner,g,anchor,['101','102','103'])).created,false);
 assert.deepEqual((await claimCollectorRunSkus({...other,skus:['101','102','103']})).items.map(i=>i.state),['COLLECTED','COLLECTED','COLLECTED']);
 assert.equal((await getCollectorRunForAccount(owner.accountId,owner.runId)).progress.qualifiedCount,1);
}));

test('partial group resumes cached successes, later new siblings keep identity, account and lease boundaries',options,async()=>fixture(async({run,otherId})=>{
 const a=await run();const g=await claim(a,'201',['201','202']);
 await checkpoint(a,g,'201','201');await failCollectorRun({...a,errorCode:'NETWORK'});
 const b=await run();const resumed=await claim(b,'202',['202','201']);
 assert.equal(resumed.groupId,g.groupId);assert.deepEqual(resumed.cachedVariants.map(v=>v.sku),['201']);
 await checkpoint(b,resumed,'202','202');await finish(b,resumed,'202',['201','202']);
 const c=await run();const extended=await claim(c,'203',['203','202','201']);
 assert.equal(extended.groupId,g.groupId);assert.equal(extended.status,'CLAIMED');assert.equal(extended.cachedVariants.length,2);
 await checkpoint(c,extended,'203','203');await finish(c,extended,'203',['203','202','201']);
 const other=await run('ALL',otherId);assert.notEqual((await claim(other,'201',['201','202'])).groupId,g.groupId);
 await assert.rejects(claim({...c,accountId:otherId},'201',['201']),{code:'COLLECTOR_RUN_NOT_FOUND'});
 await assert.rejects(claim({...c,leaseToken:'bad'},'201',['201']),{code:'COLLECTOR_RUN_LEASE_MISMATCH'});
}));

test('legacy single SKU can be rediscovered by ALL without changing CURRENT dedup; group release preserves cached details',options,async()=>fixture(async({run})=>{
 const old=await run('CURRENT');await upsertCollectorRunItem({...old,item:{source:'ozon',sourceKey:'301',sourceSku:'301',status:'QUALIFIED',rawPayload:detail('301')}});
 const current=await run('CURRENT'),all=await run();
 assert.equal((await claimCollectorRunSkus({...current,skus:['301']})).items[0].state,'COLLECTED');
 assert.equal((await claimCollectorRunSkus({...all,skus:['301']})).items[0].state,'CLAIMED');
 const g=await claim(all,'301',['301','302']);await checkpoint(all,g,'301','301');
 await releaseCollectorRunProductGroup({...all,groupId:g.groupId,anchorSku:'301'});
 const next=await run();const resumed=await claim(next,'302',['302','301']);
 assert.equal(resumed.status,'CLAIMED');assert.equal(resumed.cachedVariants.length,1);
}));

test('a later shorter discovery cannot drop previously confirmed unsaved siblings',options,async()=>fixture(async({run})=>{
 const a=await run(),first=await claim(a,'401',['401','402','403']);
 await checkpoint(a,first,'401','402');await failCollectorRun({...a,errorCode:'NETWORK'});
 const b=await run(),second=await claim(b,'402',['402','403']);
 assert.equal(second.groupId,first.groupId);
 assert.deepEqual([...second.skus].sort(),['401','402','403']);
 await checkpoint(b,second,'402','403');
 await assert.rejects(finish(b,second,'402',['402','403']),{code:'COLLECTOR_GROUP_INCOMPLETE'});
 assert.equal((await claimCollectorRunSkus({...b,skus:['401']})).items[0].state,'CLAIMED');
 await checkpoint(b,second,'402','401');await finish(b,second,'402',['401','402','403']);
}));

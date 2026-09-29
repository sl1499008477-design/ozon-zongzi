import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
const enabled=process.env.SONLI_DESKTOP_HTTP_POSTGRES_TESTS==='1';
test('canonical heartbeat and final flush preserve discovered/qualified counts through real CollectorService terminal writes',{skip:!enabled,timeout:30000},()=>{
 assert.equal(process.env.SONLI_ENV_FILE,'/private/tmp/sonli-audit-test.env');
 const profile=mkdtempSync(join(tmpdir(),'sonli-progress-'));
 const probe=`
 import ${JSON.stringify(new URL('../../server/env.mjs',import.meta.url).href)};
 import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
 import * as service from ${JSON.stringify(new URL('../../server/collector-desktop-service.mjs',import.meta.url).href)};
 import {getPostgresPool,closePostgresPool} from ${JSON.stringify(new URL('../../server/db/connection.mjs',import.meta.url).href)};
 import {Collection} from ${JSON.stringify(new URL('../dist-electron/services/collection/collection.services.js',import.meta.url).href)};
 import {normalizeCollectorTask} from ${JSON.stringify(new URL('../dist-electron/services/collector-contract.core.js',import.meta.url).href)};
 assert.equal(new URL(process.env.SONLI_MIGRATION_TEST_DATABASE_URL).pathname,'/sonli_audit_20260910');
 assert.equal(process.env.DATABASE_URL,process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
 const account='desktop-progress-'+randomUUID(),pool=await getPostgresPool(),tasks=[],observed=[];
 assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'sonli_audit_20260910');
 const methods={claim:'claimCollectorRun',heartbeat:'heartbeatCollectorRun',complete:'completeCollectorRun',cancel:'cancelCollectorRun',fail:'failCollectorRun',events:'appendCollectorRunEvent'};
 const calls=[];
 globalThis.__SELLER_CONTEXT__={accountId:account,source:'ozon_seller_analytics',sourceIdentity:'seller-page:2681910'};
 globalThis.__DESKTOP_AXIOS_HANDLER__=async c=>{
  const match=c.url.match(/^\\/collector\\/runs\\/([^/]+)\\/([^/]+)$/);assert.ok(match,c.url);const [,runId,action]=match;
  calls.push({runId,action,progress:c.data?.progress});
  const result=await service[methods[action]]({accountId:account,runId,...c.data});
  if(action==='claim')for(const [sourceKey,status] of [['4624804325','QUALIFIED'],['4624803840','QUALIFIED'],['1585240588','FILTERED_OUT']])await service.upsertCollectorRunItem({accountId:account,runId,deviceId:c.data.deviceId,leaseToken:result.leaseToken,item:{sourceKey,status}});
  return {data:result};
 };
 try{
  await pool.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active')",[account]);
  for(const terminal of ['COMPLETED','CANCELLED','FAILED','WINDOW_CLOSED']){
   const task=await service.createCollectorTask({accountId:account,name:'progress fixture',taskType:'CATEGORY'});tasks.push(task.id);
   const {run}=await service.queueCollectorTaskRun({accountId:account,taskId:task.id,idempotencyKey:randomUUID()});
   const c=new Collection({_id:task.id,taskName:'progress fixture',taskStatus:'pending',isUseCategorySelect:1,progress:{current:99,total:210,totalCount:2}},null);
   c.restoreRun(run);c.preparedClean=true;c.parseService.getDataCount=()=>210;c.process=99;c.targetData=2;c.goodsData=new Map([['a',{}],['b',{}]]);
   let releaseSource;
   c.getHtmlData=async()=>{};c.waitForAllTasks=async()=>{};c.expendShop=async()=>{};
   c.mainWindowService.createCollectionWindow=async()=>{
    if(terminal==='CANCELLED'){await c.cancel();throw Object.assign(Error('cancelled'),{code:'COLLECTION_CANCELLED'});}
    if(terminal==='FAILED')throw Error('fixture sourcing failed');
    if(terminal==='WINDOW_CLOSED'){
     c.getHtmlData=async()=>{queueMicrotask(c.closeHandle);await new Promise(resolve=>{releaseSource=resolve;});};
     return;
    }
    c.reason='success';
   };
   await c.run();
   releaseSource?.();
   const persisted=await service.getCollectorRunForAccount(account,run.id);
   assert.equal(persisted.status,terminal==='WINDOW_CLOSED'?'FAILED':terminal);
   assert.equal(c.heartbeatTimer,null);assert.equal(c.leaseToken,'');assert.equal(c.runId,'');
   assert.equal(persisted.lockExpiresAt,null);
   const storedLease=await pool.query('SELECT lease_token_hash FROM collector_task_runs WHERE id=$1 AND account_id=$2',[run.id,account]);
   assert.equal(Boolean(storedLease.rows[0].lease_token_hash),false);
   if(terminal==='WINDOW_CLOSED')assert.equal(persisted.errorCode,'COLLECTION_WINDOW_CLOSED');
   assert.equal(persisted.totalCount,210);assert.equal(persisted.processedCount,3);assert.equal(persisted.qualifiedCount,2);assert.equal(persisted.filteredCount,1);assert.equal(persisted.failedCount,0);
   const projected=normalizeCollectorTask(await service.getCollectorTaskForAccount(account,task.id));
   assert.deepEqual(projected.progress,{current:0,total:210,totalCount:2,dedup:{collected:0,listed:0,collecting:0},outcomes:{skipped:1,failed:0}});
   const sent=calls.filter(call=>call.runId===run.id);const last=sent.findLastIndex(call=>['complete','cancel','fail'].includes(call.action));assert.equal(sent[last-1].action,'heartbeat');
   assert.deepEqual(sent[last-1].progress,{totalCount:210,qualifiedCount:2,dedup:{collected:0,listed:0,collecting:0}});
   observed.push({terminal,persistedStatus:persisted.status,total:persisted.totalCount,processed:persisted.processedCount,qualified:persisted.qualifiedCount,filtered:persisted.filteredCount,failed:persisted.failedCount,outcomes:projected.progress.outcomes,lockCleared:persisted.lockExpiresAt===null&&storedLease.rows[0].lease_token_hash===''});
  }
  console.log(JSON.stringify(observed));
 }finally{
  await pool.query('DELETE FROM collector_tasks WHERE account_id=$1 AND id=ANY($2::text[])',[account,tasks]);await pool.query('DELETE FROM accounts WHERE id=$1',[account]);await closePostgresPool();
 }
 `;
 try{const r=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',probe],{env:{...process.env,DESKTOP_TEST_USER_DATA:profile},encoding:'utf8',timeout:25000});assert.equal(r.status,0,r.stderr||r.stdout);console.log(r.stdout.trim());}finally{rmSync(profile,{recursive:true,force:true});}
});

import './support/dedicated-postgres-test-environment.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {getPostgresPool,closePostgresPool} from '../db/connection.mjs';
import {completeCollectorRun,retryCollectorRunHandoff,getCollectorRunForAccount,listCollectorRunItems,
  upsertCollectorRunItem,appendCollectorRunEvents,listCollectorRunEvents} from '../collector-desktop-service.mjs';
import {createCollectorHandoffRepository,createCollectorRunHandoffWorker} from '../collector-run-handoff.mjs';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';

const enabled=process.env.SONLI_POSTGRES_TESTS==='1',options={skip:!enabled,timeout:30000};let pool;
before(async()=>{
  if(!enabled)return;
  assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL,'a dedicated temporary test database is required');
  assert.equal(process.env.DATABASE_URL,process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  assert.ok(!['/sonli_local','/postgres','/template0','/template1'].includes(new URL(process.env.DATABASE_URL).pathname));
  pool=await getPostgresPool();await getCollectorRunForAccount('fixture-missing-account','fixture-missing-run');
});
after(async()=>{if(enabled)await closePostgresPool();});

async function fixture(t){
  const token=randomUUID(),suffix=randomUUID(),accountId='handoff-a-'+suffix,otherAccountId='handoff-b-'+suffix;
  const taskId='handoff-task-'+suffix,runId='handoff-run-'+suffix,deviceId='handoff-device-'+suffix,pricingId='handoff-price-'+suffix;
  await pool.query("INSERT INTO accounts(id,username,role,status) VALUES($1,$1,'user','active'),($2,$2,'user','active')",[accountId,otherAccountId]);
  await pool.query("INSERT INTO pricing_config_versions(id,version_no,scope_type,scope_id) VALUES($1,1,'account',$2)",[pricingId,accountId]);
  await pool.query('INSERT INTO collector_devices(id,account_id,device_key) VALUES($1,$2,$1)',[deviceId,accountId]);
  await pool.query("INSERT INTO collector_tasks(id,account_id,task_type,status) VALUES($1,$2,'MARKET','RUNNING')",[taskId,accountId]);
  const configuration={captureScope:'CURRENT',autoSendToAiListing:true,autoStartAiGeneration:true,
    aiListingConfigSnapshot:{config:{targetStoreId:'fixture-store',targetWarehouseId:'fixture-warehouse',manualReview:true}}};
  await pool.query(`INSERT INTO collector_task_runs(id,task_id,account_id,pricing_config_version_id,run_no,status,configuration_snapshot,
    claimed_by_device_id,lease_token_hash,lock_expires_at,started_at) VALUES($1,$2,$3,$4,1,'RUNNING',$5,$6,$7,NOW()+INTERVAL '5 minutes',NOW())`,
    [runId,taskId,accountId,pricingId,{configuration},deviceId,createHash('sha256').update(token).digest('hex')]);
  await pool.query('UPDATE collector_tasks SET current_run_id=$2 WHERE id=$1',[taskId,runId]);
  t.after(async()=>{
    await pool.query('DELETE FROM ai_image_listing_tasks WHERE account_id=ANY($1::text[])',[[accountId,otherAccountId]]);
    await pool.query('UPDATE collector_tasks SET current_run_id=NULL WHERE account_id=ANY($1::text[])',[[accountId,otherAccountId]]);
    await pool.query('DELETE FROM collector_task_runs WHERE account_id=ANY($1::text[])',[[accountId,otherAccountId]]);
    await pool.query('DELETE FROM collector_tasks WHERE account_id=ANY($1::text[])',[[accountId,otherAccountId]]);
    await pool.query('DELETE FROM collector_devices WHERE account_id=ANY($1::text[])',[[accountId,otherAccountId]]);
    await pool.query('DELETE FROM pricing_config_versions WHERE id=$1',[pricingId]);
    await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[[accountId,otherAccountId]]);
  });
  const scope={accountId,runId,deviceId,leaseToken:token};
  return {...scope,otherAccountId,taskId,pricingId,configuration,scope};
}

test('completion and pending handoff commit together, including rollback after the outbox insert',options,async t=>{
  const f=await fixture(t),name='handoff_finish_'+randomUUID().replaceAll('-','');
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.run_id='${f.runId}' AND NEW.event_type='RUN_COMPLETED' THEN RAISE EXCEPTION 'fixture final event failure';END IF;RETURN NEW;END $$;
    CREATE TRIGGER ${name} BEFORE INSERT ON collector_task_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{
    await assert.rejects(completeCollectorRun({...f.scope,resultSummary:{exportedFilePath:'/fixture/export.xlsx',handoff:{status:'COMPLETED'}}}),/fixture final event failure/);
    assert.equal((await getCollectorRunForAccount(f.accountId,f.runId)).status,'RUNNING');
    assert.equal((await pool.query('SELECT count(*)::int n FROM collector_run_handoffs WHERE run_id=$1',[f.runId])).rows[0].n,0);
  }finally{await pool.query(`DROP TRIGGER ${name} ON collector_task_events;DROP FUNCTION ${name}()`);}
  const completed=await completeCollectorRun({...f.scope,resultSummary:{exportedFilePath:'/fixture/export.xlsx',handoff:{status:'COMPLETED'}}});
  assert.equal(completed.status,'COMPLETED');assert.equal(completed.handoff.status,'PENDING');assert.equal(completed.resultSummary.exportedFilePath,'/fixture/export.xlsx');
  const saved=(await pool.query('SELECT account_id,status,body FROM collector_run_handoffs WHERE run_id=$1',[f.runId])).rows[0];
  assert.equal(saved.account_id,f.accountId);assert.equal(saved.status,'PENDING');assert.deepEqual(saved.body,{receipts:{}});
  await assert.rejects(completeCollectorRun(f.scope));assert.equal((await pool.query('SELECT count(*)::int n FROM collector_run_handoffs WHERE run_id=$1',[f.runId])).rows[0].n,1);
});

test('two workers cannot claim the same handoff and expiry preserves DONE receipts with a new lease token',options,async t=>{
  const f=await fixture(t);await completeCollectorRun(f.scope);
  const repository=createCollectorHandoffRepository(pool),claimed=await Promise.all([repository.claim(),repository.claim()]);
  assert.equal(claimed.filter(Boolean).length,1);const first=claimed.find(Boolean);assert.equal(first.runId,f.runId);
  const body={receipts:{complete:{status:'DONE',collectItemId:'fixture-collect',createdTaskIds:['fixture-ai'],reusedTaskIds:[]}}};
  assert.equal(await repository.save(first,body,'PROCESSING'),true);
  await pool.query("UPDATE collector_run_handoffs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE run_id=$1",[f.runId]);
  const resumed=await repository.claim();assert.equal(resumed.runId,f.runId);assert.notEqual(resumed.token,first.token);assert.deepEqual(resumed.body,body);
  assert.equal(await repository.save(first,{receipts:{}},'COMPLETED'),false);assert.equal(await repository.renew(first),false);
  assert.equal(await repository.save(resumed,body,'COMPLETED'),true);
  const run=await getCollectorRunForAccount(f.accountId,f.runId);assert.equal(run.handoff.processed,1);assert.equal(run.handoff.created,1);
});

test('temporary pre-create warehouse failure persists its backoff across worker restart and reuses the saved collect ID',options,async t=>{
  const f=await fixture(t),itemId=f.runId+'-item';
  await pool.query(`INSERT INTO collector_task_items(id,task_id,run_id,account_id,source,source_key,status)
    VALUES($1,$2,$3,$4,'ozon','fixture-sku','QUALIFIED')`,[itemId,f.taskId,f.runId,f.accountId]);
  await completeCollectorRun(f.scope);
  let validations=0,imports=0;
  const deps={repository:createCollectorHandoffRepository(pool),readRun:({accountId,runId})=>getCollectorRunForAccount(accountId,runId),listItems:listCollectorRunItems,
    addSelected:async()=>{imports++;return {results:[{collectorItemId:itemId,collectItemId:'fixture-collect'}],errors:[],missing:[]};},
    createTasks:async()=>{if(++validations===1)throw Object.assign(new Error('RFBS 仓库需要重新验证'),{code:'RFBS_VALIDATION_REQUIRED',retryable:true,definitelyNotCreated:true});
      return {results:[{collectItemId:'fixture-collect',createdTaskIds:['fixture-ai'],reusedTaskIds:[]}],errors:[]};}};
  const started=Date.now();await createCollectorRunHandoffWorker(deps).tick();
  const row=(await pool.query('SELECT status,body,next_run_at,lease_token FROM collector_run_handoffs WHERE run_id=$1',[f.runId])).rows[0];
  assert.equal(row.status,'PENDING');assert.equal(row.lease_token,null);assert.equal(row.body.attempts,1);
  assert.ok(row.next_run_at.getTime()>=started+4900);assert.equal(row.body.receipts[itemId].status,'COLLECTED');
  const restarted=createCollectorRunHandoffWorker(deps);await restarted.tick();assert.equal(validations,1,'another worker cannot claim before the stored deadline');
  await pool.query("UPDATE collector_run_handoffs SET next_run_at=NOW()-INTERVAL '1 second' WHERE run_id=$1",[f.runId]);
  await restarted.tick();assert.equal(validations,2);assert.equal(imports,1);
  const result=(await getCollectorRunForAccount(f.accountId,f.runId)).handoff;assert.equal(result.status,'COMPLETED');assert.equal(result.created,1);
});

test('partial explicit retry keeps DONE work and reuses an AI task whose successful response was lost',options,async t=>{
  const f=await fixture(t),items=['item-a','item-b'].map(suffix=>({id:f.runId+'-'+suffix,sourceKey:suffix}));
  for(const [index,item] of items.entries())await pool.query(`INSERT INTO collector_task_items(id,task_id,run_id,account_id,source,source_key,source_sku,sort_order,status,raw_payload)
    VALUES($1,$2,$3,$4,'ozon',$5,$6,$7,'QUALIFIED',$8)`,[item.id,f.taskId,f.runId,f.accountId,item.sourceKey,String(11000+index),index,{sku:String(11000+index),name:'Товар',images:['https://source.invalid/a']}]);
  await completeCollectorRun(f.scope);
  const aiRepository=createAiListingRepository({pool}),ai=createAiListingService({repository:aiRepository,loadSources:async({collectItemIds})=>collectItemIds.map(id=>({
    collectItemId:id,sku:id,sourceSnapshot:{source:'ozon'},items:[{sku:id,images:['https://source.invalid/a'],listingItem:{weight:100,depth:100,width:100,height:100}}],
  }))});
  const imported=[],calls=[];let loseResponse=true;
  const dependencies={repository:createCollectorHandoffRepository(pool),readRun:({accountId,runId})=>getCollectorRunForAccount(accountId,runId),listItems:listCollectorRunItems,
    addSelected:async input=>{assert.equal(input.accountId,f.accountId);imported.push(input.itemIds[0]);return {results:[{collectorItemId:input.itemIds[0],collectItemId:'collect-'+input.itemIds[0]}],errors:[],missing:[]};},
    createTasks:async input=>{assert.equal(input.accountId,f.accountId);calls.push(input.collectItemIds[0]);const id=input.collectItemIds[0];
      const result=await ai.createFromCollectorRun({accountId:f.accountId,runId:f.runId,config:f.configuration.aiListingConfigSnapshot.config,groups:[{collectItemId:id,skus:[id]}]});
      if(loseResponse&&id.endsWith('item-b'))throw Object.assign(Error('response lost after commit'),{code:'CONNECTION_LOST'});
      return result;
    }};
  await createCollectorRunHandoffWorker(dependencies).tick();const first=(await getCollectorRunForAccount(f.accountId,f.runId)).handoff;assert.equal(first.status,'PARTIAL');assert.equal(first.processed,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_image_listing_tasks WHERE account_id=$1',[f.accountId])).rows[0].n,2);
  await assert.rejects(retryCollectorRunHandoff({accountId:f.otherAccountId,runId:f.runId}),{code:'COLLECTOR_RUN_NOT_FOUND'});
  const retry=await retryCollectorRunHandoff({accountId:f.accountId,runId:f.runId});assert.equal(retry.processed,1);loseResponse=false;
  await createCollectorRunHandoffWorker(dependencies).tick();const done=(await getCollectorRunForAccount(f.accountId,f.runId)).handoff;
  assert.equal(done.status,'COMPLETED');assert.equal(done.processed,2);assert.equal(done.created,1);assert.equal(done.reused,1);
  assert.deepEqual(imported,items.map(i=>i.id));assert.equal(calls.filter(id=>id.endsWith('item-a')).length,1);assert.equal(calls.filter(id=>id.endsWith('item-b')).length,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_image_listing_tasks WHERE account_id=$1',[f.accountId])).rows[0].n,2);
});

test('new shared raw/export records and old explicit exports preserve their public data with account-scoped event batching',options,async t=>{
  const f=await fixture(t),raw={sku:'12345',name:'Товар',images:['https://source.invalid/a'],description:'Описание'};
  const shared=await upsertCollectorRunItem({...f.scope,item:{source:'ozon',sourceKey:'shared',sourceSku:'12345',status:'ENRICHED',rawPayload:raw,exportDataFromRaw:true}});
  assert.deepEqual(shared.item.rawPayload,raw);assert.deepEqual(shared.item.exportData,raw);
  const stored=(await pool.query('SELECT raw_payload,export_data,export_data_from_raw FROM collector_task_items WHERE id=$1',[shared.item.id])).rows[0];
  assert.deepEqual(stored.raw_payload,raw);assert.deepEqual(stored.export_data,{});assert.equal(stored.export_data_from_raw,true);
  const edited={...raw,name:'Измененное экспортное название'};
  const legacy=await upsertCollectorRunItem({...f.scope,item:{source:'ozon',sourceKey:'shared',status:'ENRICHED',exportData:edited}});
  assert.deepEqual(legacy.item.rawPayload,raw);assert.deepEqual(legacy.item.exportData,edited);
  assert.equal((await pool.query('SELECT export_data_from_raw FROM collector_task_items WHERE id=$1',[shared.item.id])).rows[0].export_data_from_raw,false);
  const [again]=await listCollectorRunItems({accountId:f.accountId,runId:f.runId});assert.deepEqual(again.exportData,edited);
  const eventInput={accountId:f.accountId,runId:f.runId,actorType:'device',actorId:f.deviceId,events:[{eventType:'FIRST',message:'a'},{eventType:'SECOND',message:'b',accountId:f.otherAccountId}]};
  const events=await appendCollectorRunEvents(eventInput);assert.equal(events.length,2);assert.ok(events.every(row=>row.accountId===f.accountId));
  await assert.rejects(appendCollectorRunEvents({...eventInput,accountId:f.otherAccountId}),{code:'COLLECTOR_RUN_NOT_FOUND'});
  assert.equal((await listCollectorRunEvents({accountId:f.otherAccountId,runId:f.runId})).length,0);
  assert.deepEqual((await listCollectorRunEvents({accountId:f.accountId,runId:f.runId})).map(e=>e.eventType).filter(e=>['FIRST','SECOND'].includes(e)),['FIRST','SECOND']);
});

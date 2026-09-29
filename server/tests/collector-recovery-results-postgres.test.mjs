import './support/dedicated-postgres-test-environment.mjs';
import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {getPostgresPool,closePostgresPool} from '../db/connection.mjs';
import * as service from '../collector-desktop-service.mjs';
import {createCollectorHttpHandler} from '../collector-routes.mjs';
import {createAiListingRuntime} from '../ai-listing-runtime.mjs';
import {addSelectedCollectorItemsToCollectBox} from '../collector-selection-service.mjs';

const enabled=process.env.SONLI_POSTGRES_TESTS==='1',options={skip:!enabled,timeout:20000};
let pool;
before(async()=>{
  if(!enabled)return;
  assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  assert.ok(!['/sonli_local','/postgres','/template0','/template1'].includes(new URL(process.env.DATABASE_URL).pathname));
  pool=await getPostgresPool();await service.getCollectorRunForAccount('missing','missing');
});
after(async()=>{if(enabled)await closePostgresPool();});
async function fixture(work){
  const accountId='recovery-a-'+randomUUID(),otherId='recovery-b-'+randomUUID();
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user')",[accountId,otherId]);
  const authenticate=async req=>({id:req.headers.authorization==='Bearer b'?otherId:accountId,role:'admin',status:'active'});
  const handler=createCollectorHttpHandler({authenticate});
  const ai=createAiListingRuntime({authenticate,resolvePool:async()=>pool,
    readJson:async req=>{let input='';for await(const chunk of req)input+=chunk;return JSON.parse(input);},
    sendJson:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));},
    validateTarget:async()=>{},generateImage:async()=>assert.fail('history recovery must never call external image generation')});
  const http=createServer(async(req,res)=>{if(!await handler(req,res)&&!await ai.handleRoute(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end('{}');}});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const request=async(path,{method='GET',account='a',body}={})=>{
    const response=await fetch(`http://127.0.0.1:${http.address().port}${path}`,{method,headers:{authorization:`Bearer ${account}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  try{
    const task=await service.createCollectorTask({accountId,name:'恢复验证',taskType:'CATEGORY',configuration:{captureScope:'CURRENT'}});
    const {run}=await service.queueCollectorTaskRun({accountId,taskId:task.id});
    const claim=await service.claimCollectorRun({accountId,runId:run.id,device:{deviceKey:'fixture'}});
    const scope={accountId,runId:run.id,deviceId:claim.device.id,leaseToken:claim.leaseToken};
    const save=(sku,status='QUALIFIED',extra={})=>service.upsertCollectorRunItem({...scope,item:{source:'ozon',sourceKey:sku,sourceSku:sku,status,rawPayload:{sku,nameLabel:'历史商品 '+sku,largeUnused:'x'.repeat(10000)},...extra}});
    await work({accountId,otherId,task,run,scope,save,request});
  }finally{
    await new Promise(resolve=>http.close(resolve));
    await pool.query('UPDATE collector_tasks SET current_run_id=NULL WHERE account_id=ANY($1::text[])',[[accountId,otherId]]);
    await pool.query('DELETE FROM collect_items WHERE account_id=ANY($1::text[])',[[accountId,otherId]]);
    await pool.query('DELETE FROM collect_requests WHERE account_id=ANY($1::text[])',[[accountId,otherId]]);
    await pool.query('DELETE FROM collect_raw_payloads WHERE account_id=ANY($1::text[])',[[accountId,otherId]]);
    await pool.query('DELETE FROM collector_run_handoffs WHERE account_id=ANY($1::text[])',[[accountId,otherId]]);
    // Ingest audit events are intentionally immutable; the dedicated test database owns their cleanup.
    await pool.query('DELETE FROM accounts a WHERE id=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM product_restriction_events e WHERE e.account_id=a.id)',[[accountId,otherId]]);
  }
}

test('task and run reads count saved qualified SKUs separately from groups, including historical rows',options,async()=>fixture(async f=>{
  const group=await f.save('801'),legacy=await f.save('804'),olderGroup=await f.save('806');await f.save('805','FAILED');
  await pool.query('UPDATE collector_task_items SET raw_payload=$2::jsonb WHERE id=$1',[group.item.id,JSON.stringify({sku:'801',captureScope:'ALL',variantData:{variants:[{sku:'801'},{sku:'802'},{sku:'803'}]}})]);
  await pool.query("UPDATE collector_task_items SET raw_payload='{}'::jsonb WHERE id=$1",[legacy.item.id]);
  await pool.query('UPDATE collector_task_items SET raw_payload=$2::jsonb WHERE id=$1',[olderGroup.item.id,JSON.stringify({sku:'806',variants:[{sku:'806'},{sku:'807'}]})]);
  const current=await f.request(`/collector/tasks/${f.task.id}`);
  assert.equal(current.body.task.currentRun.progress.qualifiedCount,3);
  assert.equal(current.body.task.currentRun.progress.qualifiedSkuCount,6);
  const listed=await service.listCollectorTasksForAccount({accountId:f.accountId});
  assert.equal(listed[0].currentRun.progress.qualifiedSkuCount,6);
  const run=(await f.request(`/collector/runs/${f.run.id}`)).body.run;
  assert.equal(run.qualifiedSkuCount,6);assert.equal(run.progress.qualifiedSkuCount,6);
  assert.equal((await f.request(`/collector/tasks/${f.task.id}/runs`)).body.runs[0].progress.qualifiedSkuCount,6);
  assert.equal((await service.getCollectorRunForAccount(f.accountId,f.run.id)).progress.qualifiedSkuCount,undefined,'internal handoff reads do not aggregate all saved products');
  assert.equal((await service.listCollectorTasksForAccount({accountId:f.otherId})).length,0);
  assert.equal(await service.getCollectorRunForAccount(f.otherId,f.run.id),null);
}));

test('HTTP history reads saved unexported successes, paginates and keeps tenant scope without validating legacy payloads',options,async()=>fixture(async f=>{
  const a=await f.save('701'),b=await f.save('702'),c=await f.save('703');await f.save('704','FAILED');
  await service.failCollectorRun({...f.scope,errorCode:'OFFLINE'});
  // Legacy records remain readable even when they no longer satisfy collection input rules.
  await pool.query("UPDATE collector_task_items SET raw_payload='{}',dedup_saved_at=NULL WHERE id=$1",[c.item.id]);
  const results=await f.request(`/collector/runs/${f.run.id}/results?limit=2`);
  assert.equal(results.status,200);assert.equal(results.body.total,3);assert.equal(results.body.items.length,2);
  assert.deepEqual(results.body.items.map(x=>x.id),[a.item.id,b.item.id]);
  assert.equal(results.body.items[0].collectBoxStatus,'NOT_SENT');assert.equal(results.body.items[0].aiStatus,'NOT_SENT');
  assert.equal(results.body.items[0].name,'历史商品 701');assert.equal(results.body.items[0].canSend,true);
  assert.ok(JSON.stringify(results.body).length<3000,'no raw media or export payload in a result page');
  const legacy=(await f.request(`/collector/runs/${f.run.id}/results?offset=2`)).body.items[0];
  assert.equal(legacy.sourceSku,'703');assert.equal(legacy.collectBoxStatus,'UNKNOWN');
  assert.equal((await f.request(`/collector/runs/${f.run.id}/results`,{account:'b'})).status,404);
  const history=await f.request(`/collector/tasks/${f.task.id}/runs?limit=1`);
  assert.equal(history.body.runs[0].id,f.run.id);assert.equal(history.body.runs[0].status,'FAILED');
}));

test('history reports existing collect/AI IDs across runs and uncertain durable receipts instead of inventing unsent state',options,async()=>fixture(async f=>{
  const saved=[];for(const sku of ['711','712','713'])saved.push((await f.save(sku)).item);
  const collect='collect-'+randomUUID(),ai='ai-'+randomUUID();
  await pool.query("INSERT INTO collect_items(id,account_id,source,source_sku) VALUES($1,$2,'ozon','711')",[collect,f.accountId]);
  await pool.query(`INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at)
    VALUES($1,$2,$1,'GENERATION_FAILED',$3,0,0)`,[ai,f.accountId,JSON.stringify({source:{items:[{sku:'711'}],sourceSnapshot:{source:'ozon'}},images:[]})]);
  await pool.query('INSERT INTO collector_ai_sku_owners(account_id,source_sku,task_id) VALUES($1,$2,$3)',[f.accountId,'711',ai]);
  await pool.query("INSERT INTO collector_run_handoffs(run_id,account_id,status,body) VALUES($1,$2,'PARTIAL',$3)",[f.run.id,f.accountId,JSON.stringify({receipts:{[saved[1].id]:{status:'FAILED',error:{message:'response lost'}}}})]);
  const rows=(await f.request(`/collector/runs/${f.run.id}/results`)).body.items;
  assert.equal(rows[0].collectBoxStatus,'SENT');assert.equal(rows[0].collectItemId,collect);
  assert.equal(rows[0].aiStatus,'CREATED');assert.deepEqual(rows[0].aiTasks,[{id:ai,status:'GENERATION_FAILED',deletedAt:null}]);
  assert.equal(rows[1].aiStatus,'UNKNOWN');assert.equal(rows[1].collectBoxStatus,'UNKNOWN');
  assert.equal(rows[2].aiStatus,'NOT_SENT');
  await pool.query("UPDATE collector_task_items SET raw_payload=raw_payload||$2::jsonb WHERE id=$1",[saved[2].id,JSON.stringify({variantData:{variants:[{sku:'713'},{sku:'714'}]}})]);
  await pool.query("INSERT INTO collect_items(id,account_id,source,source_sku) VALUES($1,$2,'ozon','713')",[collect+'-partial',f.accountId]);
  assert.equal((await f.request(`/collector/runs/${f.run.id}/results`)).body.items[2].collectBoxStatus,'UNKNOWN','one existing sibling does not prove the whole captured group was sent');
  await pool.query("UPDATE collector_run_handoffs SET status='PROCESSING' WHERE run_id=$1",[f.run.id]);
  assert.equal((await f.request(`/collector/runs/${f.run.id}/results`)).body.items[2].aiStatus,'NOT_SENT','a collect-only handoff does not start AI');
  await pool.query("UPDATE collector_task_runs SET configuration_snapshot=jsonb_set(configuration_snapshot,'{configuration,autoStartAiGeneration}','true') WHERE id=$1",[f.run.id]);
  assert.equal((await f.request(`/collector/runs/${f.run.id}/results`)).body.items[2].aiStatus,'PROCESSING');
  await pool.query('UPDATE collect_items SET deleted_at=NOW() WHERE id=$1',[collect]);
  await pool.query('UPDATE ai_image_listing_tasks SET deleted_at=1 WHERE id=$1',[ai]);
  const removed=(await f.request(`/collector/runs/${f.run.id}/results`)).body.items[0];
  assert.equal(removed.aiStatus,'BLOCKED');assert.equal(removed.aiTasks[0].id,ai);
}));

test('explicit resume reopens only the current failed run and preserves results/configuration without stealing active leases',options,async()=>fixture(async f=>{
  const success=await f.save('721');await f.save('722','FAILED');
  assert.equal((await f.request(`/collector/runs/${f.run.id}/resume`,{method:'POST'})).body.code,'COLLECTOR_RUN_LEASE_ACTIVE');
  await service.failCollectorRun({...f.scope,errorCode:'OFFLINE'});
  const before=await service.getCollectorRunForAccount(f.accountId,f.run.id);
  assert.equal((await f.request(`/collector/runs/${f.run.id}/resume`,{method:'POST',account:'b'})).status,404);
  const resumed=await f.request(`/collector/runs/${f.run.id}/resume`,{method:'POST'});
  assert.equal(resumed.status,200);assert.equal(resumed.body.run.id,f.run.id);assert.equal(resumed.body.run.status,'QUEUED');
  assert.deepEqual(resumed.body.run.configurationSnapshot,before.configurationSnapshot);assert.equal(resumed.body.run.qualifiedCount,1);
  assert.equal((await pool.query('SELECT last_error_code FROM collector_tasks WHERE id=$1',[f.task.id])).rows[0].last_error_code,'');
  assert.equal(resumed.body.run.resultSummary.resumeRequested,true);
  assert.equal((await f.request(`/collector/runs/${f.run.id}`)).body.run.resultSummary.resumeRequested,true,'a lost resume response cannot erase explicit failed-item retry intent');
  assert.equal((await f.request(`/collector/runs/${f.run.id}/resume`,{method:'POST'})).body.run.status,'QUEUED');
  const claim=await service.claimCollectorRun({accountId:f.accountId,runId:f.run.id,deviceId:f.scope.deviceId});
  const scope={...f.scope,leaseToken:claim.leaseToken};
  await service.upsertCollectorRunItem({...scope,item:{source:'ozon',sourceKey:'722',sourceSku:'722',status:'FILTERED_OUT',retry:true}});
  const rows=await service.listCollectorRunItems({...scope});
  assert.equal(rows.find(x=>x.id===success.item.id).status,'QUALIFIED');assert.equal(rows.find(x=>x.sourceSku==='722').attemptCount,2);
  await service.cancelCollectorRun(scope);
  assert.equal((await f.request(`/collector/runs/${f.run.id}/resume`,{method:'POST'})).body.code,'COLLECTOR_RUN_TERMINAL');
  const next=await service.queueCollectorTaskRun({accountId:f.accountId,taskId:f.task.id});
  assert.equal((await f.request(`/collector/runs/${f.run.id}/resume`,{method:'POST'})).body.code,'COLLECTOR_TASK_RUN_CHANGED');
  assert.equal((await f.request(`/collector/runs/${next.run.id}/resume`,{method:'POST'})).body.run.resultSummary.resumeRequested,true);
  await service.claimCollectorRun({accountId:f.accountId,runId:next.run.id,deviceId:f.scope.deviceId});
  await pool.query("UPDATE collector_task_runs SET lock_expires_at=NOW()-INTERVAL '1 second',result_summary=result_summary-'resumeRequested' WHERE id=$1",[next.run.id]);
  const stale=await f.request(`/collector/runs/${next.run.id}/resume`,{method:'POST'});
  assert.equal(stale.body.run.status,'RUNNING');assert.equal(stale.body.run.resultSummary.resumeRequested,true);
}));

test('saved unexported failed-run results enter collect box once and explicit HTTP AI resend reuses durable PostgreSQL ownership',options,async()=>fixture(async f=>{
  const raw={sku:'731',name:'Светильник',description:'Светильник для комнаты',images:['https://cdn1.ozone.ru/s3/multimedia-test/731.jpg'],
    blackPrice:'35.05',currencyCode:'CNY',packageWeight:100,packageLength:100,packageWidth:100,packageHeight:100};
  const saved=await f.save('731','QUALIFIED',{rawPayload:raw});
  await pool.query(`UPDATE collector_task_runs SET configuration_snapshot=jsonb_set(configuration_snapshot,'{configuration}',$2::jsonb) WHERE id=$1`,
    [f.run.id,JSON.stringify({autoSendToAiListing:true,autoStartAiGeneration:true,aiListingConfigSnapshot:{config:{targetStoreId:'fixture-store',targetWarehouseId:'fixture-wh',manualReview:true,prompt:'Товар'}}})]);
  await service.failCollectorRun({...f.scope,errorCode:'DESKTOP_CLOSED'});
  const select={accountId:f.accountId,runId:f.run.id,itemIds:[saved.item.id]};
  const first=await addSelectedCollectorItemsToCollectBox(select);assert.deepEqual(first.errors,[]);
  const replay=await addSelectedCollectorItemsToCollectBox(select);assert.deepEqual(replay.errors,[]);
  assert.equal(first.results[0].collectItemId,replay.results[0].collectItemId);
  assert.equal((await pool.query('SELECT count(*)::int n FROM collect_items WHERE account_id=$1',[f.accountId])).rows[0].n,1);
  const body={runId:f.run.id,collectItemIds:[first.results[0].collectItemId]};
  assert.equal((await f.request('/ai-listing/tasks/from-collector-run',{method:'POST',body})).status,409);
  assert.equal((await f.request('/ai-listing/tasks/from-collector-run',{method:'POST',account:'b',body:{...body,manual:true}})).status,404);
  const created=await f.request('/ai-listing/tasks/from-collector-run',{method:'POST',body:{...body,manual:true}});
  assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.tasks.length,1);
  const again=await f.request('/ai-listing/tasks/from-collector-run',{method:'POST',body:{...body,manual:true}});
  assert.equal(again.status,201);assert.deepEqual(again.body.results[0].createdTaskIds,[]);
  assert.deepEqual(again.body.results[0].reusedTaskIds,[created.body.tasks[0].id]);
  const row=(await f.request(`/collector/runs/${f.run.id}/results`)).body.items[0];
  assert.equal(row.collectBoxStatus,'SENT');assert.equal(row.aiStatus,'CREATED');assert.equal(row.aiTasks[0].id,created.body.tasks[0].id);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_image_listing_tasks WHERE account_id=$1',[f.accountId])).rows[0].n,1);
}));

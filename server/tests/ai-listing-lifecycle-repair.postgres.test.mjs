import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingStoreRouting} from '../ai-listing-store-routing.mjs';
import {createSkuBilling} from '../ai-sku-billing.mjs';

async function fixture(t){
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='lifecycle_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:5});
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY,role TEXT);INSERT INTO accounts VALUES('a','user'),('b','user');CREATE TABLE ai_user_channel_requests(id TEXT PRIMARY KEY)");
  for(const name of ['106_ai_image_listing.sql','115_ai_sku_billing.sql','135_ai_product_scheduling.sql','140_collector_ai_sku_owners.sql','141_ai_listing_task_controls.sql','150_ai_listing_list_summary.sql'])await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  const repository=createAiListingRepository({pool});let now=Date.now();
  const task=(id,store='store',accountId='a')=>({id,accountId,dedupeKey:id,sourceType:'COLLECT_BOX',sourceId:id,sku:id,name:id,thumbnail:'',
    source:{items:[{sku:id,images:['https://source.invalid/image'],listingItem:{weight:100,depth:100,width:100,height:100}}]},
    images:[{sku:id,index:0,generatedUrl:'https://saved.invalid/image',status:'COMPLETED'}],config:{targetStoreId:store,targetWarehouseId:'warehouse'},
    status:'READY_TO_SUBMIT',submissionId:id,submissionStage:'prepared',submissionStarted:true,createdAt:now,updatedAt:now,nextRunAt:now});
  return {pool,repository,task,now:()=>now,advance:ms=>now+=ms};
}

test('PostgreSQL display progress is account/lease/version guarded and preserves source while pending pause survives',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  const f=await fixture(t),task=f.task('progress');task.status='GENERATING';task.images[0].generatedUrl=null;delete task.submissionStage;delete task.submissionId;
  task.source.largeFrozenEvidence='x'.repeat(100000);await f.repository.create(task);
  const lease=await f.repository.claimNext({now:f.now(),leaseMs:90000,leaseToken:'owner',phase:'generate'}),before=structuredClone(lease.source);
  const scope={accountId:'a',taskId:task.id,expectedVersion:lease.version,leaseToken:'owner',now:f.now(),patch:{generationStage:'saving',updatedAt:f.now()}};
  assert.equal(await f.repository.saveProgress({...scope,accountId:'b'}),null);assert.equal(await f.repository.saveProgress({...scope,leaseToken:'other'}),null);
  await f.pool.query("UPDATE ai_image_listing_tasks SET control_action='pause' WHERE id='progress'");
  const saved=await f.repository.saveProgress(scope);assert.equal(saved.version,lease.version+1);assert.equal(saved.controlAction,'pause');
  assert.equal(await f.repository.saveProgress(scope),null);assert.deepEqual((await f.repository.get({accountId:'a',taskId:task.id})).source,before);
});

test('PostgreSQL whole-product turns finish siblings and charge only distinct completed SKUs',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  const f=await fixture(t);await f.pool.query("INSERT INTO ai_user_wallets(account_id,balance_cents,sku_price_cents) VALUES('a',100,20)");
  const billing=createSkuBilling({pool:f.pool});
  const sources=[['large',['one','two']],['small',['three']]].map(([id,skus])=>({collectItemId:id,sku:skus[0],name:id,
    items:skus.map(sku=>({sku,images:['https://source.invalid/'+sku],listingItem:{weight:100,depth:100,width:100,height:100}}))}));
  const service=createAiListingService({repository:f.repository,billing,clock:f.now,loadSources:async()=>sources,
    generateImage:async input=>({generatedUrl:'https://saved.invalid/'+input.sku})});
  const tasks=await service.createFromCollect({accountId:'a',collectItemIds:['large','small'],idempotencyKey:'all',config:{targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:true}});
  const first=await service.processNext({phase:'generate'});assert.equal(first.id,tasks[0].id);assert.equal(first.status,'AWAITING_REVIEW');
  assert.equal((await service.processNext({phase:'generate'})).id,tasks[1].id);assert.equal(await service.processNext({phase:'generate'}),null);
  await billing.recover();await billing.reconcile({accountId:'a',taskId:tasks[0].id});
  const wallet=(await f.pool.query("SELECT balance_cents::int,reserved_cents::int FROM ai_user_wallets WHERE account_id='a'")).rows[0];
  assert.deepEqual(wallet,{balance_cents:40,reserved_cents:0});assert.equal((await f.pool.query("SELECT count(*)::int n FROM ai_wallet_entries WHERE kind='SKU_CHARGE'")).rows[0].n,3);
});

test('PostgreSQL finalizers select another store while the same store owns a live submission lease',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  const f=await fixture(t);
  for(const [id,store] of [['first','store-1'],['same-store','store-1'],['other-store','store-2']])await f.repository.create(f.task(id,store));
  const claim=token=>f.repository.claimNext({now:f.now(),leaseMs:90000,leaseToken:token,phase:'finalize'});
  const first=await claim('first');assert.equal(first.id,'first');
  assert.equal((await claim('second')).id,'other-store');assert.equal(await claim('third'),null);
  await f.repository.save({task:first,expectedVersion:first.version,leaseToken:'first',now:f.now(),releaseLease:true});
  assert.equal((await claim('fourth')).id,'first');
  f.advance(90001);assert.ok(await claim('after-expiry'));
});

test('PostgreSQL media preparation stays stoppable and cannot cross a competing pause at the external-send CAS',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  const f=await fixture(t);let writes=0,taskId;
  const service=createAiListingService({repository:f.repository,clock:f.now,readSubmission:async input=>{
    const pending=await service.pauseTask({accountId:'a',taskId});assert.equal(pending.controlAction,'pause');
    await input.beforeExternalWrite();writes++;return {status:'COMPLETED'};
  }});
  const prepared=f.task('prepared');taskId=prepared.id;await f.repository.create(prepared);
  assert.equal((await f.repository.listPage({accountId:'a',group:'active'})).tasks[0].taskActions.pause,true);
  const preview=await service.previewTaskAction({accountId:'a',group:'active',action:'pause'});assert.equal(preview.items.length,1);
  assert.equal((await service.processNext({phase:'finalize'})).status,'PAUSED');assert.equal(writes,0);
  const row=await f.repository.get({accountId:'a',taskId});assert.equal(row.submissionExternalWriteStarted,undefined);assert.equal(row.submissionId,'prepared');
});

test('PostgreSQL deleted failure restoration preserves paid identities and only one matching version can restore',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  const f=await fixture(t),task=f.task('rejected');
  Object.assign(task,{status:'SUBMISSION_FAILED',submissionStage:'submitting',submissionExternalWriteStarted:true,submissionKey:'original-key',
    submissionResults:[{sku:'rejected',offerId:'原货号',importStatus:'SUCCEEDED',stockStatus:'FAILED',publicationStatus:'REJECTED'}]});
  await f.repository.create(task);
  await f.pool.query("INSERT INTO collector_ai_sku_owners VALUES('a','rejected','rejected');INSERT INTO ai_wallet_entries(id,account_id,task_id,sku,kind,amount_cents) VALUES('paid','a','rejected','rejected','SKU_CHARGE',-20)");
  const service=createAiListingService({repository:f.repository,clock:f.now});
  await service.deleteTask({accountId:'a',taskId:'rejected',expectedVersion:1});
  const before=await f.repository.get({accountId:'a',taskId:'rejected'});
  const page=await f.repository.listPage({accountId:'a',group:'deleted'});
  assert.equal(page.total,1);assert.equal(page.counts.deleted,1);assert.equal(page.counts.all,0);
  assert.equal(page.tasks[0].deletedAt,before.deletedAt);assert.equal(page.tasks[0].taskActions.resume,true);
  assert.equal((await f.repository.listPage({accountId:'a'})).tasks.length,0);
  assert.equal((await f.repository.listPage({accountId:'b',group:'deleted'})).total,0);
  await assert.rejects(service.resumeTask({accountId:'b',taskId:'rejected',expectedVersion:before.version}),{statusCode:404});
  const input={accountId:'a',taskId:'rejected',expectedVersion:before.version};
  const attempts=await Promise.allSettled([service.resumeTask(input),service.resumeTask(input)]);
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(attempts.find(result=>result.status==='rejected').reason.statusCode,409);
  const after=await f.repository.get({accountId:'a',taskId:'rejected'});
  assert.equal(after.status,'SUBMISSION_FAILED');assert.equal(after.deletedAt,null);assert.equal(after.workPhase,'idle');
  for(const key of ['submissionId','submissionKey','source','images','submissionResults'])assert.deepEqual(after[key],before[key]);
  assert.equal((await f.pool.query("SELECT task_id FROM collector_ai_sku_owners WHERE account_id='a' AND source_sku='rejected'")).rows[0].task_id,'rejected');
  assert.equal((await f.pool.query("SELECT amount_cents::int amount FROM ai_wallet_entries WHERE id='paid'")).rows[0].amount,-20);
  assert.equal(await service.processNext(),null);
});

test('PostgreSQL deleted group batch preview spans pages and skips a changed version without starting work',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  const f=await fixture(t),service=createAiListingService({repository:f.repository,clock:f.now});
  for(const [id,accountId] of [['one','a'],['two','a'],['three','a'],['foreign','b']]){
    const task=f.task(id,'store',accountId);task.status='GENERATING';task.submissionStarted=false;delete task.submissionId;delete task.submissionStage;
    await f.repository.create(task);await service.deleteTask({accountId,taskId:id,expectedVersion:1});
  }
  assert.equal((await f.repository.listPage({accountId:'a',group:'deleted',limit:1})).tasks.length,1);
  const preview=await service.previewTaskAction({accountId:'a',group:'deleted',action:'resume'});assert.equal(preview.items.length,3);
  assert.equal((await service.previewTaskAction({accountId:'a',group:'deleted',action:'retry'})).items.length,0);
  await f.pool.query("UPDATE ai_image_listing_tasks SET version=version+1 WHERE id='two'");
  const result=await service.batchTaskAction({accountId:'a',action:'resume',items:preview.items});
  assert.equal(result.applied,2);assert.equal(result.pending,0);assert.deepEqual(result.skipped.map(row=>row.taskId),['two']);
  assert.equal((await f.repository.listPage({accountId:'a',group:'paused'})).total,2);
  assert.equal((await f.repository.listPage({accountId:'a',group:'deleted'})).total,1);
  assert.equal((await f.repository.listPage({accountId:'b',group:'deleted'})).total,1);
  assert.equal(await service.processNext(),null);
});

test('PostgreSQL concurrent whole-product admissions reserve durably, release on pause, and isolate accounts',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
 const f=await fixture(t);let paid=0,held=0;
 const sources=['one','two'].map(id=>({collectItemId:id,sku:id,name:id,items:[id+'a',id+'b'].map(sku=>({sku,images:['https://source.invalid/'+sku],listingItem:{weight:100,depth:100,width:100,height:100,currency_code:'RUB',price:'20'}}))}));
 const route=createAiListingStoreRouting({pool:f.pool,clock:f.now,validateTarget:async()=>({store:{currencyCode:'RUB'}}),readCredential:async()=>({}),fetchFn:async()=>({ok:true,json:async()=>({daily_create:{limit:2,usage:0},total:{limit:0,usage:0}})})});
 const service=createAiListingService({repository:f.repository,clock:f.now,loadSources:async()=>sources,routeStores:route,
 reserveChannel:async()=>{held++;return {channelId:'fixture',productToken:'fixture',release:async()=>{held--;}};},generateImage:async input=>{paid++;return {generatedUrl:'https://saved.invalid/'+input.sku};}});
 const tasks=await service.createFromCollect({accountId:'a',collectItemIds:['one','two'],idempotencyKey:'quota',config:{targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:true}});
 const results=await Promise.all([service.processNext({phase:'generate'}),service.processNext({phase:'generate'})]);
 assert.equal(results.filter(row=>row.status==='AWAITING_REVIEW').length,1);assert.equal(results.find(row=>row.status==='GENERATING').quotaWait.code,'RESERVED_CAPACITY');assert.equal(paid,2);assert.equal(held,0);
 const page=await f.repository.listPage({accountId:'a'});assert.equal(page.tasks.find(row=>row.quotaWait).quotaWait.code,'RESERVED_CAPACITY');
 const winner=results.find(row=>row.status==='AWAITING_REVIEW');await service.pauseTask({accountId:'a',taskId:winner.id});
 f.advance(15001);assert.equal((await service.processNext({phase:'generate'})).status,'AWAITING_REVIEW');assert.equal(paid,4);
 assert.equal((await f.repository.get({accountId:'a',taskId:winner.id})).status,'PAUSED');
 const other=await service.createFromCollect({accountId:'b',collectItemIds:['one'],idempotencyKey:'other',config:{targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:true}});
 assert.equal((await service.processNext({phase:'generate'})).id,other[0].id);assert.equal(paid,6);
});

test('PostgreSQL resumed partial-image products precede untouched siblings without claiming paused tasks',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
 const f=await fixture(t);
 for(const id of ['untouched','partial','paused']){
  const task=f.task(id);delete task.submissionId;delete task.submissionStage;task.status=id==='paused'?'PAUSED':'GENERATING';
  task.images=[{sku:id,index:0,status:'PENDING',generatedUrl:null},...(id==='untouched'?[]:[{sku:id,index:1,status:'COMPLETED',generatedUrl:'https://saved.invalid/prior'}])];
  await f.repository.create(task);
 }
 const first=await f.repository.claimNext({now:f.now(),leaseMs:90000,leaseToken:'partial',phase:'generate'});assert.equal(first.id,'partial');
 assert.equal((await f.repository.claimNext({now:f.now(),leaseMs:90000,leaseToken:'untouched',phase:'generate'})).id,'untouched');
 assert.equal(await f.repository.claimNext({now:f.now(),leaseMs:90000,leaseToken:'paused',phase:'generate'}),null);
});

test('PostgreSQL legacy review and generating outputs reserve capacity, but created stock-only SKUs do not count twice',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
 const f=await fixture(t);const legacy=f.task('legacy');delete legacy.submissionId;delete legacy.submissionStage;legacy.status='AWAITING_REVIEW';await f.repository.create(legacy);
 const task={...f.task('new'),source:{items:[{sku:'new',listingItem:{currency_code:'RUB',price:'20'}}]}};
 const route=createAiListingStoreRouting({pool:f.pool,clock:f.now,validateTarget:async()=>({store:{currencyCode:'RUB'}}),readCredential:async()=>({}),fetchFn:async()=>({ok:true,json:async()=>({daily_create:{limit:1,usage:0}})})});
 assert.equal((await route({task,commit:async()=>{}})).quotaWait.code,'RESERVED_CAPACITY');
 await f.pool.query("UPDATE ai_image_listing_tasks SET status='GENERATING' WHERE id='legacy'");
 assert.equal((await route({task,commit:async()=>{}})).quotaWait.code,'RESERVED_CAPACITY');
 await f.pool.query(`UPDATE ai_image_listing_tasks SET status='SUBMITTED',body=body||'{"submissionResults":[{"sku":"legacy","importStatus":"SUCCEEDED","stockStatus":"PENDING"}]}'::jsonb WHERE id='legacy'`);
 assert.equal((await route({task,commit:async()=>{}})).selected,true);
});

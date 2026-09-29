import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
const config={targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:true};
function source(sku){return {collectItemId:sku==='c'?'other':'siblings',sku,items:(sku==='c'?['c']:['a','b']).map((s,i)=>({sku:s,images:[`https://source.test/${s}.jpg`],listingItem:{weight:200,depth:100,width:100,height:100,price:String(10+i)}}))};}
test('product preparation and phase scheduling', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
 const schema='product_schedule_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:8});
  await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY); INSERT INTO accounts VALUES('a'),('b')");
  await pool.query(await readFile(new URL('../db/migrations/106_ai_image_listing.sql',import.meta.url),'utf8'));
  for (const [id,status,sourceValue,images] of [
    ['old-z','QUEUED',null,[]],['old-a','GENERATING',{items:[{sku:'old',listingItem:{legacy:true}}]},[{sku:'old',generatedUrl:null}]],
    ['old-final','GENERATING',{items:[{sku:'old',listingItem:{legacy:true}}]},[{sku:'old',generatedUrl:'https://saved.test/old'}]],
    ['old-done','COMPLETED',null,[]]]) {
    await pool.query('INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at) VALUES($1,$2,$1,$3,$4,0,0)',[id,'a',status,{id,source:sourceValue,images}]);
  }
  await pool.query(await readFile(new URL('../db/migrations/135_ai_product_scheduling.sql',import.meta.url),'utf8'));
  const repository=createAiListingRepository({pool});let now=1000,paid=0,failB=false;
  const service=createAiListingService({repository,clock:()=>now,collectSku:async({sku})=>{if(failB&&sku==='b')throw Error('source failed');return source(sku);},generateImage:async({sku})=>{paid++;return {generatedUrl:`https://generated.test/${sku}.jpg`};},submitListing:async()=>assert.fail('generate phase submitted'),billing:{reconcile:async({reserve})=>{if(reserve)paid+=10;return {funded:true};}}});
  const create=(skus,key='batch',accountId='a')=>service.createFromSkus({accountId,skus,idempotencyKey:key,config});
  const clear=()=>pool.query('TRUNCATE ai_image_listing_tasks,ai_listing_account_turns');
  await t.test('migration classifies retained tasks without rewriting frozen legacy metadata',async()=>{
    const old=(await pool.query('SELECT id,work_phase,queue_position,body FROM ai_image_listing_tasks ORDER BY queue_position')).rows;
    assert.deepEqual(old.map(row=>[row.id,row.work_phase]),[['old-a','generate'],['old-done','idle'],['old-final','finalize'],['old-z','prepare']]);
    assert.deepEqual(old[0].body.source.items[0].listingItem,{legacy:true});
    await clear();
  });
  await t.test('three Excel rows become two products before any paid work, aliases resolve and replay stays stable',async()=>{
   const rows=await create(['a','b','c']);assert.equal(rows.length,3);
   assert.equal(await service.processNext({phase:'generate'}),null);
   await service.processNext({phase:'prepare'});assert.equal(paid,0);
   assert.equal(await service.processNext({phase:'generate'}),null);
   await service.processNext({phase:'prepare'});await service.processNext({phase:'prepare'});
   const visible=await service.listTasks({accountId:'a'});assert.equal(visible.length,2);
   const canonical=await service.getTask({accountId:'a',taskId:rows[1].id});assert.equal(canonical.id,rows[0].id);
   assert.deepEqual(canonical.importSkus,['a','b']);assert.deepEqual(canonical.importRows.map(r=>[r.row,r.sku,r.taskId]),[[1,'a',rows[0].id],[2,'b',rows[0].id]]);
   const saved=await repository.get({accountId:'a',taskId:rows[0].id});assert.deepEqual(saved.source.items.map(i=>i.listingItem.price),['10','11']);
   await create(['a','b','c']);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_image_listing_tasks')).rows[0].n,3);
   await assert.rejects(create(['a','c']),{code:'AI_LISTING_IDEMPOTENCY_CONFLICT'});
   await service.processNext({phase:'generate'});assert.equal(paid,12);
   await service.cancelTask({accountId:'a',taskId:rows[1].id});assert.equal((await service.getTask({accountId:'a',taskId:rows[0].id})).status,'CANCELLED');
  });
  await t.test('partial source failure unblocks ready products; later sibling retry aliases without duplicate work',async()=>{
   await clear();paid=0;failB=true;const rows=await create(['a','b','c']);
   for(let i=0;i<3;i++)await service.processNext({phase:'prepare'});
   await service.processNext({phase:'generate'});assert.equal(paid,12);
   failB=false;await service.retryTask({accountId:'a',taskId:rows[1].id});await service.processNext({phase:'prepare'});
   assert.equal((await service.getTask({accountId:'a',taskId:rows[1].id})).id,rows[0].id);assert.equal(paid,12);
  });
  await t.test('cancelled canonical retains successful images and charge identity on failed sibling retry',async()=>{
   await clear();paid=0;failB=true;const rows=await create(['a','b'],'cancelled-canonical');
   await service.processNext({phase:'prepare'});await service.processNext({phase:'prepare'});
   await service.processNext({phase:'generate'});assert.equal(paid,12);
   await service.cancelTask({accountId:'a',taskId:rows[0].id});
   failB=false;await service.retryTask({accountId:'a',taskId:rows[1].id});await service.processNext({phase:'prepare'});
   const resolved=await service.getTask({accountId:'a',taskId:rows[1].id});
   assert.equal(resolved.id,rows[0].id);assert.equal(resolved.status,'CANCELLED');assert.ok(resolved.images.every(i=>i.generatedUrl));
   assert.equal(await service.processNext({phase:'generate'}),null);assert.equal(paid,12);
  });
  await t.test('GRID union over 12 keeps sibling selection as actionable conflict without silently merging',async()=>{
   await clear();
   const grid=createAiListingService({repository,clock:()=>now,collectSku:async({sku})=>({collectItemId:'grid-product',sku:'common',items:[{sku:'common',listingItem:{weight:200,depth:100,width:100,height:100,price:'10'},images:Array.from({length:8},(_,i)=>`https://source.test/${sku}-${i}.jpg`)}]})});
   const rows=await grid.createFromSkus({accountId:'a',skus:['a','b'],idempotencyKey:'grid-limit',config:{...config,generationMode:'GRID'}});
   await grid.processNext({phase:'prepare'});await grid.processNext({phase:'prepare'});
   const canonical=await grid.getTask({accountId:'a',taskId:rows[0].id}),sibling=await grid.getTask({accountId:'a',taskId:rows[1].id});
   assert.equal(canonical.images.length,8);assert.equal(sibling.status,'COLLECTION_FAILED');assert.equal(sibling.id,rows[1].id);
   assert.equal(sibling.images.length,8);assert.match(sibling.errorMessage,/12/);
  });
  await t.test('FIFO recorded order, fair account turns and phase/lease fences',async()=>{
   await clear();const a=await create(['a','c'],'aa'),b=await create(['c'],'bb','b');
   for(let i=0;i<3;i++)await service.processNext({phase:'prepare'});
   const claim=(phase)=>repository.claimNext({now,leaseMs:100,leaseToken:randomUUID(),phase});
   assert.equal(await claim('prepare'),null);assert.equal(await claim('finalize'),null);
   const first=await claim('generate'),second=await claim('generate'),third=await claim('generate');
   assert.deepEqual([first.id,second.id,third.id],[a[0].id,b[0].id,a[1].id]);
   assert.equal(await repository.ownsLease({accountId:'a',taskId:first.id,leaseToken:first.leaseToken,expectedVersion:first.version,now}),true);
   await service.cancelTask({accountId:'a',taskId:first.id});
   assert.equal(await repository.ownsLease({accountId:'a',taskId:first.id,leaseToken:first.leaseToken,expectedVersion:first.version,now}),false);
   assert.equal(await repository.save({task:first,expectedVersion:first.version,leaseToken:first.leaseToken,now}),null);
  });
  await t.test('parallel batch replay is atomic and a late idempotency conflict rolls back inserted rows',async()=>{
   await clear();const [one,two]=await Promise.all([create(['a','b','c'],'race'),create(['a','b','c'],'race')]);
   assert.deepEqual(one.map(row=>row.id),two.map(row=>row.id));
   assert.equal((await pool.query('SELECT count(*)::int n FROM ai_image_listing_tasks')).rows[0].n,3);
   const existing=await repository.get({accountId:'a',taskId:one[0].id});
   await assert.rejects(repository.createBatch([{...existing,id:'must-rollback',dedupeKey:'must-rollback',importBatchId:'rollback'},
     {...existing,importBatchId:'rollback',requestHash:'conflicting-config'}]),{code:'AI_LISTING_IDEMPOTENCY_CONFLICT'});
   assert.equal(await repository.get({accountId:'a',taskId:'must-rollback'}),null);
  });
  await t.test('cancelled in-flight source cannot be saved, and ready unrelated products still proceed',async()=>{
   await clear();const rows=await create(['a','b','c'],'cancel');let entered,finish;
   const reached=new Promise(r=>entered=r),gate=new Promise(r=>finish=r);
   const collector=createAiListingService({repository,clock:()=>now,collectSku:async({sku})=>{if(sku==='b'){entered();await gate;}return source(sku);}});
   await collector.processNext({phase:'prepare'});const running=collector.processNext({phase:'prepare'});await reached;
   await collector.cancelTask({accountId:'a',taskId:rows[1].id});
   await collector.processNext({phase:'prepare'});finish();await running;
   const cancelled=await repository.get({accountId:'a',taskId:rows[1].id});assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.source,null);
   const eligible=(await pool.query("SELECT count(*)::int n FROM ai_image_listing_tasks WHERE work_phase='generate'")).rows[0].n;assert.equal(eligible,2);
  });
  await t.test('account and batch boundaries remain independent; same-batch conflicting snapshots stay uncharged',async()=>{
   await clear();await create(['a'],'batch-1');await create(['b'],'batch-2');await create(['a'],'batch-1','b');
   for(let i=0;i<3;i++)await service.processNext({phase:'prepare'});
   assert.equal((await pool.query("SELECT count(*)::int n FROM ai_image_listing_tasks WHERE work_phase='generate'")).rows[0].n,3);
   await clear();const rows=await create(['a','b'],'conflict');
   const collector=createAiListingService({repository,clock:()=>now,collectSku:async({sku})=>{const result=source(sku);if(sku==='b')result.items[0].listingItem.price='999';return result;}});
   await collector.processNext({phase:'prepare'});await collector.processNext({phase:'prepare'});
   assert.equal((await service.getTask({accountId:'a',taskId:rows[1].id})).status,'COLLECTION_FAILED');
   await service.retryTask({accountId:'a',taskId:rows[1].id});
   assert.equal((await repository.get({accountId:'a',taskId:rows[1].id})).workPhase,'prepare');
   await service.processNext({phase:'prepare'});assert.equal((await service.getTask({accountId:'a',taskId:rows[1].id})).id,rows[0].id);
   await assert.rejects(service.getTask({accountId:'b',taskId:rows[1].id}),{code:'AI_LISTING_TASK_NOT_FOUND'});
  });
  await t.test('generate saves every image before finalize can submit or poll',async()=>{
   await clear();let submissions=0,images=0;
   const pipeline=createAiListingService({repository,clock:()=>now,collectSku:async()=>source('c'),
    generateImage:async()=>{images++;return {generatedUrl:'https://generated.test/c.jpg'};},
    submitListing:async()=>{submissions++;return {submissionId:'submitted'};},readSubmission:async()=>({status:'COMPLETED'})});
   const [row]=await pipeline.createFromSkus({accountId:'a',skus:['c'],idempotencyKey:'pipeline',config:{...config,manualReview:false}});
   assert.equal(await pipeline.processNext({phase:'finalize'}),null);
   await pipeline.processNext({phase:'prepare'});assert.equal(images,0);
   assert.equal((await pipeline.processNext({phase:'generate'})).status,'READY_TO_SUBMIT');assert.equal(images,1);assert.equal(submissions,0);
   assert.equal(await pipeline.processNext({phase:'generate'}),null);
   assert.equal((await pipeline.processNext({phase:'finalize'})).status,'SUBMITTED');assert.equal(submissions,1);
   now+=15000;assert.equal(await pipeline.processNext({phase:'generate'}),null);
   assert.equal((await pipeline.processNext({phase:'finalize'})).status,'COMPLETED');assert.equal(images,1);assert.equal(submissions,1);
   assert.equal((await repository.get({accountId:'a',taskId:row.id})).workPhase,'idle');
  });
 }finally{await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

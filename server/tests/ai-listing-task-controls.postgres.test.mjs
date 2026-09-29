import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';

test('PostgreSQL controls preserve existing data, paid results, ownership and queue order across pages',
  {skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:30000},async()=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const schema='task_controls_'+randomUUID().replaceAll('-','');let pool,release;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:5});
    await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY);INSERT INTO accounts VALUES('a'),('b')");
    await pool.query('CREATE TABLE account_ozon_routes (LIKE public.account_ozon_routes INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
    for(const name of ['106_ai_image_listing.sql','135_ai_product_scheduling.sql']) {
      await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
    }
    const historical={images:[{sku:'old',index:0,generatedUrl:'https://saved.test/old.png',status:'COMPLETED'}],source:{items:[]},config:{targetStoreId:'s'},createdAt:1,updatedAt:1};
    await pool.query("INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at) VALUES('old','a','old','COMPLETED',$1,1,1)",[historical]);
    await pool.query(await readFile(new URL('../db/migrations/141_ai_listing_task_controls.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/150_ai_listing_list_summary.sql',import.meta.url),'utf8'));
    assert.deepEqual((await pool.query("SELECT body FROM ai_image_listing_tasks WHERE id='old'")).rows[0].body,historical);
    const repository=createAiListingRepository({pool});let now=Date.now(),requests=0;
    const config={targetStoreId:'s',targetWarehouseId:'w',manualReview:true};
    const loadSources=async({collectItemIds})=>collectItemIds.map(sku=>({collectItemId:sku,sku,name:sku,
      items:[{sku,images:['https://source.test/1.png','https://source.test/2.png'],listingItem:{weight:100,depth:100,width:100,height:100}}]}));
    const dependencies={repository,loadSources,clock:()=>now,generateImage:async input=>{requests++;return {generatedUrl:`https://saved.test/${input.sku}/${input.index}.png`};}};
    let service=createAiListingService(dependencies);
    const create=async(id,extra={})=>(await service.createFromCollect({accountId:'a',collectItemIds:[id],idempotencyKey:id,config:{...config,...extra}}))[0];
    const tasks=await service.createFromCollect({accountId:'a',collectItemIds:Array.from({length:62},(_,i)=>'sku-'+i),idempotencyKey:'bulk',config});
    const preview=await service.previewTaskAction({accountId:'a',group:'active',action:'pause'});
    assert.equal(preview.items.length,62);assert.equal((await repository.listPage({accountId:'a',group:'active'})).tasks.length,50);
    assert.equal((await service.batchTaskAction({accountId:'b',action:'pause',items:preview.items})).applied,0);
    assert.equal((await service.batchTaskAction({accountId:'a',action:'pause',items:preview.items})).applied,62);
    const paused=await repository.listPage({accountId:'a',group:'paused',offset:50});
    assert.equal(paused.total,62);assert.equal(paused.tasks.length,12);assert.equal(paused.counts.active,0);
    assert.equal(paused.tasks[0].taskActions.resume,true);
    assert.equal((await service.batchTaskAction({accountId:'a',action:'pause',items:preview.items})).applied,0);
    const later=await create('later');
    await service.resumeTask({accountId:'a',taskId:tasks[0].id});
    assert.equal((await service.processNext()).id,later.id);
    assert.equal((await service.processNext()).id,tasks[0].id);
    assert.equal(requests,4);

    let entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
    service=createAiListingService({...dependencies,generateImage:async()=>{requests++;entered();await gate;return {generatedUrl:'https://saved.test/inflight.png'};}});
    const inflight=await create('inflight');const running=service.processNext();await started;
    const before=await repository.get({accountId:'a',taskId:inflight.id});
    const stopping=await service.pauseTask({accountId:'a',taskId:inflight.id,expectedVersion:before.version});
    assert.equal(stopping.controlAction,'pause');
    const pending=await repository.get({accountId:'a',taskId:inflight.id});
    assert.equal(pending.version,before.version);assert.equal(pending.leaseToken,before.leaseToken);
    release();const saved=await running;
    assert.equal(saved.status,'PAUSED');assert.equal(saved.images[0].generatedUrl,'https://saved.test/inflight.png');assert.equal(saved.images[1].generatedUrl,null);
    assert.equal((await repository.get({accountId:'a',taskId:inflight.id})).leaseToken,null);
    assert.equal(requests,5);

    service=createAiListingService(dependencies);
    await service.resumeTask({accountId:'a',taskId:inflight.id});
    assert.equal((await service.processNext()).status,'AWAITING_REVIEW');assert.equal(requests,6);
    await service.deleteTask({accountId:'a',taskId:inflight.id});
    assert.ok((await repository.get({accountId:'a',taskId:inflight.id})).deletedAt);
    await assert.rejects(service.getTask({accountId:'a',taskId:inflight.id}),{statusCode:404});
    assert.ok(!(await service.listTasks({accountId:'a'})).some(task=>task.id===inflight.id));
    assert.equal((await repository.listPage({accountId:'a',view:'completed',storeId:'s'})).tasks[0].id,'old');

    let race;let writes=0;
    service=createAiListingService({...dependencies,routeStores:async({task,commit})=>{
      if(task.images.every(image=>image.generatedUrl))await service.pauseTask({accountId:'a',taskId:race.id});
      await commit({targetStoreId:'s',targetWarehouseId:'w'});return {selected:true};
    },submitListing:async()=>{writes++;return {submissionId:'must-not-send'};}});
    race=await create('submission-race',{manualReview:false});
    const stopped=await service.processNext();assert.equal(stopped.status,'PAUSED');assert.equal(writes,0);
    assert.equal((await repository.get({accountId:'a',taskId:race.id})).submissionStarted,false);

    // Simulate a crash between saving the last paid result and settling the pending control.
    const crash=await create('crash-after-result');
    const claimed=await repository.claimNext({now,leaseMs:90000,leaseToken:'crash-worker'});
    assert.equal(claimed.id,crash.id);
    await service.pauseTask({accountId:'a',taskId:crash.id});
    claimed.status='AWAITING_REVIEW';claimed.images.forEach(image=>Object.assign(image,{status:'COMPLETED',generatedUrl:'https://saved.test/crash.png'}));
    const checkpoint=await repository.save({task:claimed,expectedVersion:claimed.version,leaseToken:'crash-worker',now,releaseLease:true});
    assert.equal(checkpoint.controlAction,'pause');assert.equal(checkpoint.leaseToken,'crash-worker');assert.notEqual(checkpoint.workPhase,'idle');
    now+=90001;
    assert.equal((await service.processNext()).status,'PAUSED');
    assert.equal((await repository.get({accountId:'a',taskId:crash.id})).controlAction,null);

    for(const outcome of ['COMPLETED','FAILED','UNCERTAIN','SUBMITTED']){
      let receiptTask,reads=0,prepares=0;
      const results=[{sku:'receipt-'+outcome,offerId:'original-'+outcome,productId:'901',importStatus:'SUCCEEDED',
        stockStatus:outcome==='COMPLETED'?'COMPLETED':outcome==='FAILED'?'FAILED':'PENDING',errors:outcome==='FAILED'?['STOCK_FAILED']:[]}];
      service=createAiListingService({...dependencies,submitListing:async()=>{prepares++;return {submissionId:'saved-'+outcome};},
        readSubmission:async input=>{
          reads++;assert.equal(input.submissionId,'saved-'+outcome);
          if(reads>1)return {status:'COMPLETED',items:results.map(row=>({...row,stockStatus:'COMPLETED',errors:[]}))};
          await input.beforeExternalWrite();
          assert.equal((await service.pauseTask({accountId:'a',taskId:receiptTask.id})).controlAction,'pause');
          return {status:outcome,items:results};
        }});
      receiptTask=await create('receipt-'+outcome,{manualReview:false});
      await service.processNext({phase:'generate'});await service.processNext({phase:'media'});
      const final=await service.processNext({phase:'finalize'});
      assert.equal(final.status,{COMPLETED:'COMPLETED',FAILED:'SUBMISSION_FAILED',UNCERTAIN:'SUBMISSION_UNCERTAIN',SUBMITTED:'PAUSED'}[outcome]);
      assert.deepEqual(final.submissionResults,results);assert.equal(final.controlAction,null);
      const durable=await repository.get({accountId:'a',taskId:receiptTask.id});
      assert.equal(durable.leaseToken,null);assert.equal(durable.controlAction,null);assert.deepEqual(durable.submissionResults,results);
      if(outcome==='SUBMITTED'){
        await service.resumeTask({accountId:'a',taskId:receiptTask.id});
        assert.equal((await service.processNext({phase:'finalize'})).status,'COMPLETED');assert.equal(prepares,1);assert.equal(reads,2);
      }
    }
  } finally {
    release?.();await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});

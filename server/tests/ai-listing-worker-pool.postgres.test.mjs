import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';
import {createAiListingStoreRouting} from '../ai-listing-store-routing.mjs';
import {createAiListingPurge,AI_LISTING_PURGE_AFTER_MS} from '../ai-listing-purge.mjs';
import {createSkuBilling} from '../ai-sku-billing.mjs';

test('worker four-connection pool drains real media, finalize and due purge with its leader connection retained',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:20000},async t=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='worker_pool_'+randomUUID().replaceAll('-','');let pool,leader;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,application_name:'ai-listing-worker-pool-test',max:4});
  await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY,role TEXT); INSERT INTO accounts VALUES('a','admin'),('b','admin')");
  for(const file of ['106_ai_image_listing.sql','135_ai_product_scheduling.sql','141_ai_listing_task_controls.sql','107_ai_image_listing_submissions.sql','118_ozon_write_rate_reservations.sql','140_collector_ai_sku_owners.sql'])
   await pool.query(await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
  await pool.query('ALTER TABLE ai_image_listing_tasks ADD billable BOOLEAN DEFAULT true');
  for(const table of ['account_ozon_routes','collect_items','product_drafts','product_draft_revisions','product_draft_variants','collect_raw_payloads','collector_media_uploads','submission_snapshots','products','collector_task_items','collector_ozon_enrichment_jobs','collector_ozon_enrichment_task_controls','collector_ozon_enrichment_cache','collect_requests','local_state','ai_wallet_entries','ai_user_channel_requests','platform_product_restrictions'])
   await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
  await pool.query(`CREATE TABLE stores(id text,owner_account_id text,label text,client_id text,currency_code text,currency_source text,currency_synced_at timestamptz,status text);
   CREATE TABLE store_credentials(store_id text,encrypted_api_key text,iv text,auth_tag text,algorithm text,key_version text);
   INSERT INTO store_credentials VALUES('store-a','test','test','test','test','test'),('store-b','test','test','test','test','test');
   CREATE TABLE warehouses(id text,store_id text,warehouse_id text,warehouse_type text,status text,is_active boolean,is_archived boolean);
   CREATE TABLE product_stocks(product_id text,warehouse_id text,store_id text,source text);
   INSERT INTO stores VALUES('store-a','a','test','seller-a','RUB','OZON_SELLER_INFO',NOW(),'active'),('store-b','b','test','seller-b','RUB','OZON_SELLER_INFO',NOW(),'active');
   INSERT INTO warehouses VALUES('warehouse-a','store-a','1001','RFBS','active',true,false),('warehouse-b','store-b','1002','RFBS','active',true,false);`);
  let now=Date.now();const imports=[],stocks=[];
  const quota={daily_create:{limit:100,usage:0},operation_limits:{limit_type:'RATE_LIMIT_PER_MINUTE',limit:100}};
  const readCredential=async(storeId,accountId,client=pool)=>{
   const row=(await client.query('SELECT id,client_id FROM stores WHERE id=$1 AND owner_account_id=$2',[storeId,accountId])).rows[0];
   return row?{id:row.id,clientId:row.client_id,apiKey:'test-only'}:null;
  };
  const ports=createAiListingSubmissionPorts({pool,clock:()=>now,
   readCredential:({accountId,targetStoreId,client})=>readCredential(targetStoreId,accountId,client),
   normalizeItems:async items=>({items}),
   prepareMedia:async({taskId,items,checkControl})=>{
    if(taskId==='media-stop')await admin.query(`UPDATE ${schema}.ai_image_listing_tasks SET control_action='pause' WHERE id=$1`,[taskId]);
    await checkControl?.();return items;
   },
   callOzonSellerApi:async(credential,path,body)=>{
    if(path==='/v2/warehouse/list')return {result:[{warehouse_id:credential.clientId==='seller-a'?'1001':'1002',warehouse_type:'RFBS',status:'active',is_active:true,is_archived:false}]};
    if(path==='/v4/product/info/limit')return quota;
    if(path==='/v3/product/info/list')return {items:body.offer_id.filter(offer=>imports.includes(offer)).map(offer_id=>({offer_id,id:imports.indexOf(offer_id)+1,statuses:{status:'price_sent',is_created:true,moderate_status:'approved'}}))};
    if(path==='/v3/product/import'){imports.push(...body.items.map(item=>item.offer_id));return {result:{task_id:imports.length}};}
    if(path==='/v1/product/import/info')return {result:{items:[{offer_id:imports[Number(body.task_id)-1],product_id:Number(body.task_id),status:'imported',errors:[]}]}};
    if(path==='/v2/products/stocks'){stocks.push(...body.stocks.map(item=>item.offer_id));return {result:body.stocks.map(item=>({...item,updated:true,errors:[]}))};}
    assert.fail('Unexpected Ozon operation '+path);
   }});
  const repository=createAiListingRepository({pool}),billing=createSkuBilling({pool});
  const routeStores=createAiListingStoreRouting({pool,validateTarget:ports.validateTarget,readCredential,clock:()=>now,fetchFn:async()=>({ok:true,json:async()=>quota})});
  const service=createAiListingService({repository,clock:()=>now,billing,
   routeStores:input=>routeStores({...input,commit:async(...args)=>{
    if(input.task.id==='route-stop')await admin.query(`UPDATE ${schema}.ai_image_listing_tasks SET control_action='pause' WHERE id='route-stop'`);
    return input.commit(...args);
   }}),
   submitListing:ports.submitListing,readSubmission:ports.readSubmission});
  const tasks=[];
  for(let n=1;n<=4;n++){
   const accountId=n%2?'a':'b',sku='sku-'+n,config={targetStoreId:'store-'+accountId,targetWarehouseId:'warehouse-'+accountId,brandMode:'PREFER_SOURCE',stock:0,priceMultiplier:'1.00',priceAdjustmentKopecks:'0'};
   const task={id:'task-'+n,accountId,dedupeKey:sku,sku,name:sku,status:'READY_TO_SUBMIT',createdAt:now,nextRunAt:now,submissionKey:sku,config,
    sourceType:'COLLECT_BOX',sourceId:sku,source:{sku,sourceSnapshot:{currency:'RUB',price:'100'},items:[{sku,images:['https://original.test/'+sku],listingItem:{offer_id:sku,name:sku,price:'100',currency_code:'RUB',description_category_id:10,type_id:20,weight:100,depth:100,width:100,height:100}}]},
    images:[{sku,index:0,sourceUrl:'https://original.test/'+sku,generatedUrl:'https://generated.test/'+sku,status:'COMPLETED'}]};
   if(n>2){
    task.submissionId=(await ports.submitListing({accountId,taskId:task.id,idempotencyKey:sku,config,source:task.source,images:task.images,deferImport:true})).submissionId;
    task.submissionStage='prepared';task.submissionStarted=true;
   }
   tasks.push(await repository.create(task));
  }
  await repository.create({id:'due-purge',accountId:'a',dedupeKey:'due-purge',status:'CANCELLED',createdAt:1,nextRunAt:0,source:null,images:[],stoppedFrom:'GENERATING',mediaJournalVersion:1});
  await pool.query('UPDATE ai_image_listing_tasks SET deleted_at=$1 WHERE id=$2',[now-AI_LISTING_PURGE_AFTER_MS-1,'due-purge']);
  const purge=createAiListingPurge({pool,clock:()=>now,reconcileBilling:billing.reconcile,storage:{deleteObjectVersions:async()=>assert.fail('fixture has no owned media')}});
  leader=await pool.connect();await leader.query("SELECT pg_advisory_lock(hashtext('ai-listing-image-worker'))");
  let timer;
  const work=Promise.all([service.processNext({phase:'media'}),service.processNext({phase:'media'}),service.processNext({phase:'finalize'}),service.processNext({phase:'finalize'}),purge.sweep()]);
  const progressed=await Promise.race([work.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1500);})]);clearTimeout(timer);
  if(!progressed){
   const sessions=(await admin.query("SELECT state,query FROM pg_stat_activity WHERE datname=current_database() AND application_name='ai-listing-worker-pool-test'" )).rows;
   t.diagnostic(JSON.stringify({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount,sessions}));
   // Release only the test leader after capturing the deadlock, allowing red runs to cleanly drain.
   await leader.query("SELECT pg_advisory_unlock(hashtext('ai-listing-image-worker'))");leader.release();leader=null;
   // Two media and two finalize holders can still fill all four slots. Rescue
   // only the failed test for cleanup; the assertion keeps this run red.
   pool.options.max=8;await pool.query('SELECT 1');
  }
  await work;
  assert.equal(progressed,true,'leader + real routing/submission/purge must progress without borrowing nested pool connections');
  for(let pass=0;pass<5;pass++){
   now+=16000;
   await Promise.all([service.processNext({phase:'media'}),service.processNext({phase:'media'}),service.processNext({phase:'finalize'}),service.processNext({phase:'finalize'}),purge.sweep()]);
  }
  for(const task of tasks)assert.equal((await repository.get({accountId:task.accountId,taskId:task.id})).status,'COMPLETED',task.id);
  assert.deepEqual(imports.toSorted(),['sku-1','sku-2','sku-3','sku-4']);
  assert.deepEqual(stocks.toSorted(),['sku-1','sku-2','sku-3','sku-4']);
  assert.equal((await repository.get({accountId:'a',taskId:'due-purge'})).purge.state,'COMPLETED');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ozon_write_rate_reservations')).rows[0].n,8);
  assert.equal(pool.waitingCount,0);
  for(const taskId of ['route-stop','media-stop'])await t.test(taskId+' settles pause and billing while only its held connection is available',async()=>{
   const task=structuredClone(tasks[0]);task.id=taskId;task.dedupeKey=taskId;task.sku=taskId;task.submissionKey=taskId;task.nextRunAt=now;
   task.source.sku=taskId;task.source.items[0].sku=taskId;task.source.items[0].listingItem.offer_id=taskId;task.images[0].sku=taskId;
   await repository.create(task);
   const occupied=await Promise.all([pool.connect(),pool.connect()]);let timer;
   try{
    const work=service.processNext({phase:'all'});
    const progressed=await Promise.race([work.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1500);})]);clearTimeout(timer);
    if(!progressed)while(occupied.length)occupied.pop().release();
    const receipt=await work;
    assert.equal(progressed,true,'pause inside held routing/submission client must not wait for another pool slot');
    assert.equal(receipt.status,'PAUSED');
   }finally{clearTimeout(timer);while(occupied.length)occupied.pop().release();}
   const saved=await repository.get({accountId:'a',taskId});
   assert.equal(saved.status,'PAUSED');assert.equal(saved.controlAction,null);assert.equal(saved.leaseToken,null);
   assert.equal(imports.includes(taskId),false);assert.equal(stocks.includes(taskId),false);
  });
 }finally{
  if(leader){await leader.query("SELECT pg_advisory_unlock(hashtext('ai-listing-image-worker'))");leader.release();}
  await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
 }
});

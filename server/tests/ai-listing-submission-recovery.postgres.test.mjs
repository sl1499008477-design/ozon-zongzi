import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';
import {readStoreCredentialV3} from '../listing-pipeline.mjs';
import {encryptSecret} from '../crypto-secrets.mjs';

test('PostgreSQL historical mixed submission recovers only selected inventory and supports pause/resume after restart',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:30000},async()=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});const schema='stock_recovery_'+randomUUID().replaceAll('-','');let pool;
 try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:4});
  await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY); INSERT INTO accounts VALUES('recovery-owner')");
  for(const name of ['106_ai_image_listing.sql','107_ai_image_listing_submissions.sql','135_ai_product_scheduling.sql','141_ai_listing_task_controls.sql','150_ai_listing_list_summary.sql']){
   await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  }
  await pool.query("CREATE TABLE account_ozon_routes(account_id text PRIMARY KEY,route text)");
  let now=Date.now();const accountId='recovery-owner',taskId='legacy-mixed-task',key='existing-submission';
  const submissionId='ail_'+createHash('sha256').update(JSON.stringify([accountId,key])).digest('hex');
  const config={targetStoreId:'original-store',targetWarehouseId:'original-warehouse',stock:5,manualReview:false};
  const variants=[['2333857768','same-offer-safe','90001'],['2335447584','same-offer-warning','90002']];
  const source={sku:'2335447584',items:variants.map(([sku,offer_id])=>({sku,images:[`https://saved.example/${sku}.jpg`],listingItem:{offer_id}}))};
  const images=variants.map(([sku])=>({sku,index:0,status:'COMPLETED',generatedUrl:`https://saved.example/${sku}.jpg`}));
  const results=variants.map(([sku,offerId,productId],i)=>({sku,offerId,productId,importStatus:'SUCCEEDED',stockStatus:'FAILED',
   ...(i?{publicationStatus:'REJECTED'}:{}),errors:[i?'DESCRIPTION_DECLINE':'PRODUCT_IS_NOT_CREATED']}));
  const journal={status:'FAILED',config,items:source.items.map(({listingItem},i)=>({...listingItem,images:[images[i].generatedUrl]})),results,
   stocks:variants.map(([,offer_id])=>({offer_id,warehouse_id:123,stock:5,completed:false})),attempts:[{id:'old',status:'DONE',offerIds:variants.map(x=>x[1]),ozonTaskId:'101'}]};
  await pool.query('INSERT INTO ai_image_listing_submissions(id,account_id,task_id,idempotency_key,body) VALUES($1,$2,$3,$4,$5)',[submissionId,accountId,taskId,key,journal]);
  const repository=createAiListingRepository({pool});
  await repository.create({id:taskId,accountId,dedupeKey:taskId,status:'SUBMITTED',sourceType:'COLLECT_BOX',sourceId:'legacy-source',sku:source.sku,
   name:'SMALLDQ',thumbnail:images[0].generatedUrl,source,images,config,submissionStarted:true,submissionExternalWriteStarted:true,
   submissionId,submissionKey:key,submissionResults:results,createdAt:now-86400000,updatedAt:now,nextRunAt:now});
  const writes=[];
  const ports=createAiListingSubmissionPorts({pool,clock:()=>now,validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:'123'}}),
   readCredential:async({targetStoreId})=>{assert.equal(targetStoreId,'original-store');return {clientId:'test-seller'};},reserveCapacity:async()=>({allowed:true}),
   callOzonSellerApi:async(_credential,path,body)=>{
    if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:90001,statuses:{status:'price_sent',is_created:true,moderate_status:'approved',status_name:'Продается'}}))};
    if(path==='/v2/products/stocks'){writes.push(body.stocks);return {result:body.stocks.map(row=>({...row,updated:true,errors:[]}))};}
    assert.fail(`Unexpected remote write: ${path}`);
   }});
  let service=createAiListingService({repository,...ports,clock:()=>now});
  assert.equal((await service.pauseTask({accountId,taskId})).status,'PAUSED');
  service=createAiListingService({repository,...ports,clock:()=>now});
  assert.equal((await service.resumeTask({accountId,taskId})).status,'SUBMITTED');
  await assert.rejects(service.retryTask({accountId:'another-owner',taskId,skus:['2333857768']}),{statusCode:404});
  await service.retryTask({accountId,taskId,skus:['2333857768']});
  await service.processNext();now+=15000;await service.processNext();
  const result=await service.getTask({accountId,taskId});
  assert.equal(result.status,'SUBMISSION_FAILED');assert.equal(result.submissionResults[0].stockStatus,'COMPLETED');
  assert.equal(result.submissionResults[0].publicationCheck.statusName,'Продается');
  assert.deepEqual(result.submissionResults[1],results[1]);assert.deepEqual(writes.flat().map(row=>row.offer_id),['same-offer-safe']);
  assert.deepEqual(result.images.map(row=>row.generatedUrl),images.map(row=>row.generatedUrl));assert.equal(result.submissionId,submissionId);
  const saved=(await pool.query('SELECT body FROM ai_image_listing_submissions WHERE id=$1',[submissionId])).rows[0].body;
  assert.deepEqual(saved.items,journal.items);assert.equal(saved.attempts.length,1);assert.equal(saved.stocks[0].completed,true);assert.equal(saved.stocks[1].completed,false);
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});

test('four-slot pool progresses two media recoveries and same-store finalization while purge holds a connection',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:10000},async()=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});const schema='recovery_pool_'+randomUUID().replaceAll('-','');let pool,purgeSlot;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:4});
  await pool.query(`CREATE TABLE ai_image_listing_submissions(id text,account_id text,task_id text,body jsonb,updated_at timestamptz);
   CREATE TABLE account_ozon_routes(account_id text PRIMARY KEY,route text);
   CREATE TABLE stores(id text,owner_account_id text,label text,client_id text,currency_code text,currency_source text,currency_synced_at timestamptz,status text);
   CREATE TABLE store_credentials(store_id text,encrypted_api_key text,iv text,auth_tag text,algorithm text,key_version text);
   CREATE TABLE warehouses(id text,store_id text,warehouse_id text,warehouse_type text,status text,is_active boolean,is_archived boolean);
   CREATE TABLE products(id text,store_id text,is_archived boolean);
   CREATE TABLE product_stocks(product_id text,warehouse_id text,store_id text,source text);
   INSERT INTO stores VALUES('store','owner','test','test-client','RUB','OZON_SELLER_INFO',NOW(),'active');
   INSERT INTO warehouses VALUES('warehouse','store','1001','RFBS','active',true,false);`);
  const secret=encryptSecret('test-only-credential');
  await pool.query('INSERT INTO store_credentials VALUES($1,$2,$3,$4,$5,$6)',['store',secret.ciphertext,secret.iv,secret.authTag,secret.algorithm,secret.keyVersion]);
  const config={targetStoreId:'store',targetWarehouseId:'warehouse',stock:5};
  const id=n=>'ail_'+createHash('sha256').update(JSON.stringify(['owner','key-'+n])).digest('hex');
  for(let n=1;n<=3;n++)await pool.query('INSERT INTO ai_image_listing_submissions VALUES($1,$2,$3,$4,NOW())',[id(n),'owner','task-'+n,
   {status:'FAILED',retryAttempt:0,config,items:[{offer_id:'offer-'+n,images:['https://saved.test/'+n+'.jpg']}],
    results:[{sku:'sku-'+n,offerId:'offer-'+n,productId:String(n),importStatus:'SUCCEEDED',stockStatus:n===3?'PENDING':'FAILED',errors:n===3?[]:['PRODUCT_IS_NOT_CREATED']}],
    stocks:[{offer_id:'offer-'+n,warehouse_id:1001,stock:5,completed:false}],attempts:[{id:'original',status:'DONE',offerIds:['offer-'+n]}]}]);
  const writes=[];
  const ports=createAiListingSubmissionPorts({pool,
   // Production uses the same pool for credential reads. Keep this test scoped
   // to its schema while exercising the optional held-client dependency.
   readCredential:async({accountId,targetStoreId,client=pool})=>{
    const result=await client.query('SELECT id,client_id FROM stores WHERE id=$1 AND owner_account_id=$2',[targetStoreId,accountId]);
    return result.rows[0]?{id:result.rows[0].id,clientId:result.rows[0].client_id,apiKey:'test'}:null;
   },reserveCapacity:async()=>({allowed:true}),prepareMedia:async()=>assert.fail('stock recovery must not prepare media'),
   callOzonSellerApi:async(_credential,path,body)=>{
    if(path==='/v2/warehouse/list')return {result:[{warehouse_id:'1001',warehouse_type:'RFBS',status:'active',is_active:true,is_archived:false}]};
    if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:Number(offer_id.slice(-1)),statuses:{status:'price_sent',is_created:true,moderate_status:'approved'}}))};
    if(path==='/v2/products/stocks'){writes.push(body.stocks);return {result:body.stocks.map(row=>({...row,updated:true,errors:[]}))};}
    assert.fail('Unexpected Ozon operation: '+path);
   }});
  const input=n=>({accountId:'owner',taskId:'task-'+n,idempotencyKey:'key-'+n,config,deferImport:true,retryAttempt:1,retrySkus:['sku-'+n],
   source:{items:[{sku:'sku-'+n,listingItem:{offer_id:'offer-'+n}}]},images:[]});
  purgeSlot=await pool.connect();let timer;
  const work=Promise.all([ports.submitListing(input(1)),ports.submitListing(input(2)),ports.readSubmission({accountId:'owner',submissionId:id(3)})]);
  const progressed=await Promise.race([work.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);clearTimeout(timer);
  // Always release the held slot, including the red regression, so failed tests
  // neither hang nor leave a checked-out connection behind.
  purgeSlot.release();purgeSlot=null;const receipts=await work;
  assert.equal(progressed,true,'media/finalize must not wait for a long purge scan to release its connection');
  assert.equal(receipts[2].status,'COMPLETED');assert.deepEqual(writes.flat().map(row=>row.offer_id),['offer-3']);
  for(let n=1;n<=2;n++){
   const body=(await pool.query('SELECT body FROM ai_image_listing_submissions WHERE id=$1',[id(n)])).rows[0].body;
   assert.deepEqual(body.recoverySkus,['sku-'+n]);assert.equal(body.results[0].stockStatus,'PENDING');assert.equal(body.attempts.length,1);
  }
  const held=await pool.connect();try{
   const credential=await readStoreCredentialV3('store','owner',held);
   assert.equal(credential.apiKey,'test-only-credential');assert.equal(await readStoreCredentialV3('store','other',held),null);
   await assert.rejects(ports.validateTarget({accountId:'other',config,client:held}),{code:'TARGET_STORE_NOT_FOUND'});
  }finally{held.release();}
 }finally{purgeSlot?.release();await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

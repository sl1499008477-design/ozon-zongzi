import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';

test('real PostgreSQL media handoff permits fast submission during slow preparation and survives restart',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1',timeout:30000},async()=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});const schema='media_queue_'+randomUUID().replaceAll('-','');let pool,release;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:4});
  await pool.query(`CREATE SEQUENCE ai_listing_queue_position_seq;
   CREATE TABLE ai_image_listing_tasks(id TEXT PRIMARY KEY,account_id TEXT,dedupe_key TEXT,status TEXT,body JSONB,version INTEGER DEFAULT 1,next_run_at BIGINT,created_at BIGINT,lease_token TEXT,lease_expires_at BIGINT,work_phase TEXT,queue_position BIGINT DEFAULT nextval('ai_listing_queue_position_seq'),control_action TEXT,deleted_at BIGINT,UNIQUE(account_id,dedupe_key));
   CREATE TABLE ai_listing_account_turns(account_id TEXT PRIMARY KEY,last_turn BIGINT);CREATE SEQUENCE ai_listing_account_turn_seq;
   CREATE TABLE ai_image_listing_submissions(id TEXT PRIMARY KEY,account_id TEXT,task_id TEXT,idempotency_key TEXT,body JSONB,updated_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(account_id,idempotency_key));
   CREATE TABLE platform_product_restrictions(id TEXT,payload JSONB,updated_at TIMESTAMPTZ);`);
  let now=Date.now(),entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const writes=[];
  const repository=createAiListingRepository({pool});
  const ports=createAiListingSubmissionPorts({pool,clock:()=>now,validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:123}}),readCredential:async()=>({clientId:'fixture'}),normalizeItems:async items=>({items}),reserveCapacity:async()=>({allowed:true}),
   prepareMedia:async({items})=>{if(items[0].offer_id==='slow'){entered();await gate;}return items;},
   callOzonSellerApi:async(_credential,path,body)=>{
    if(path==='/v4/product/info/limit')return {daily_create:{limit:100,usage:0}};
    if(path==='/v3/product/info/list')return {items:body.offer_id.filter(x=>writes.includes(x)).map(offer_id=>({offer_id,id:42,statuses:{status:'price_sent'}}))};
    if(path==='/v3/product/import'){writes.push(body.items[0].offer_id);return {result:{task_id:body.items[0].offer_id==='fast'?100:200}};}
    if(path==='/v1/product/import/info')return {result:{items:[{offer_id:body.task_id===100?'fast':'slow',product_id:42,status:'imported',errors:[]}]}};
    if(path==='/v2/products/stocks')return {result:body.stocks.map(s=>({...s,updated:true,errors:[]}))};
    assert.fail(path);
   }});
  const sources=['slow','fast'].map(sku=>({collectItemId:sku,sku,sourceSnapshot:{currency:'RUB',price:'100'},items:[{sku,images:['https://original/'+sku],listingItem:{offer_id:sku,name:sku,price:'100',currency_code:'RUB',description_category_id:10,type_id:20,weight:100,depth:100,width:100,height:100}}]}));
  const dependencies={repository,clock:()=>now,loadSources:async()=>sources,generateImage:async input=>({generatedUrl:'https://generated/'+input.sku}),submitListing:ports.submitListing,readSubmission:ports.readSubmission};
  let service=createAiListingService(dependencies);
  const tasks=await service.createFromCollect({accountId:'a',collectItemIds:['slow','fast'],idempotencyKey:'pair',config:{targetStoreId:'s',targetWarehouseId:'w',brandMode:'PREFER_SOURCE'}});
  await service.processNext({phase:'generate'});await service.processNext({phase:'generate'});
  const slow=service.processNext({phase:'media'});await started;
  await service.processNext({phase:'media'});assert.deepEqual(writes,[]);
  const fast=await repository.get({accountId:'a',taskId:tasks[1].id});assert.equal(fast.submissionStage,'prepared');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_image_listing_tasks WHERE account_id='a' AND (status IN ('SUBMITTING','SUBMITTED','SUBMISSION_UNCERTAIN') OR (status='READY_TO_SUBMIT' AND body->>'submissionStage'='prepared'))")).rows[0].n,2);
  service=createAiListingService(dependencies); // Process restart after durable preparation.
  await service.processNext({phase:'finalize'});assert.deepEqual(writes,['fast']);
  assert.equal(await service.processNext({phase:'media'}),null,'slow lease is not claimed twice');
  release();await slow;await service.processNext({phase:'finalize'});assert.deepEqual(writes,['fast','slow']);
  now+=16000;await service.processNext({phase:'finalize'});await service.processNext({phase:'finalize'});
  assert.deepEqual(writes,['fast','slow']);
  for(const task of tasks)assert.equal((await repository.get({accountId:'a',taskId:task.id})).status,'COMPLETED');
  await pool.query("UPDATE ai_image_listing_tasks SET status='SUBMITTING',work_phase='finalize',lease_token=NULL,body=body-'submissionStage',next_run_at=$1 WHERE id=$2",[now,tasks[0].id]);
  assert.equal(await repository.claimNext({phase:'media',now,leaseMs:90000,leaseToken:'media'}),null);
  assert.equal((await repository.claimNext({phase:'finalize',now,leaseMs:90000,leaseToken:'final'})).id,tasks[0].id,'legacy null stage remains recoverable');
 }finally{release?.();await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});

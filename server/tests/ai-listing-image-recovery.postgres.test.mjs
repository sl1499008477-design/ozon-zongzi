import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';

test('retained 12-SKU production copy recovers only failed pictures, preserving images, successful siblings and billing',
 {skip:process.env.IMAGE_RECOVERY_EXISTING_DATA!=='1'},async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL}),client=await pool.connect();
 try{
  assert.match(new URL(process.env.DATABASE_URL).pathname,/qa_/);
  await client.query('BEGIN');
  const taskId='ai-listing-deb30bd14d3feeb6ef6b4f3e671b6ea812db3bc9f8dc2a0f6c7449b404b702d9';
  const row=(await client.query('SELECT * FROM ai_image_listing_tasks WHERE id=$1',[taskId])).rows[0];assert.ok(row,'production fixture missing');
  const accountId=row.account_id,scope={accountId,taskId};
  const before=structuredClone(row.body),original=(await client.query('SELECT body FROM ai_image_listing_submissions WHERE account_id=$1 AND id=$2',[accountId,before.submissionId])).rows[0].body;
  const target=original.results.find(r=>r.sku==='4453874197');assert.ok(target);assert.equal(original.results.length,12);
  assert.equal(original.results.filter(r=>r.stockStatus==='COMPLETED').length,11);
  const billing=async()=>(await client.query("SELECT count(*)::int n,COALESCE(sum(amount_cents),0)::text total FROM ai_wallet_entries WHERE task_id=$1",[taskId])).rows[0];
  const billed=await billing(),calls=[];let healthy=false,now=Date.now()+120000;
  const local={query:(...args)=>client.query(...args),connect:async()=>({query:(...args)=>client.query(...args),release(){}})};
  const repository=createAiListingRepository({pool:local});
  const scoped={...repository,claimNext:async input=>{
   const task=await repository.get(scope);if(!['SUBMITTED','READY_TO_SUBMIT'].includes(task.status))return null;
   await client.query('UPDATE ai_image_listing_tasks SET lease_token=$3,lease_expires_at=$4,next_run_at=$5,version=version+1 WHERE account_id=$1 AND id=$2',[accountId,taskId,input.leaseToken,input.now+input.leaseMs,input.now]);
   return repository.get(scope);
  }};
  const ports=createAiListingSubmissionPorts({pool:local,clock:()=>now,readCredential:async()=>({clientId:'isolated-fixture'}),
   validateTarget:async()=>({store:{currencyCode:'CNY'},warehouse:{platformWarehouseId:'123'}}),reserveCapacity:async()=>({allowed:true}),
   callOzonSellerApi:async(_credential,path,body)=>{
    calls.push({path,body:structuredClone(body)});
    if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:Number(target.productId),color_image:[],
     statuses:healthy?{status:'price_sent',is_created:true}:{status:'offer_validated',status_failed:'pics_delivered',is_created:false,status_updated_at:'2026-09-16T08:57:45.507047Z'},
     errors:healthy?[]:[{code:'all_image_failed',level:'ERROR_LEVEL_ERROR'}]}))};
    if(path==='/v2/product/pictures/import')return {task_id:77701};
    if(path==='/v1/product/import/info'){assert.equal(body.task_id,77701);return {result:{items:[{offer_id:target.offerId,product_id:Number(target.productId),status:'imported',errors:[]}]}};}
    if(path==='/v2/product/pictures/info')return {items:[{product_id:Number(target.productId),photo:calls.find(c=>c.path==='/v2/product/pictures/import').body.items[0].images,errors:[]}]};
    if(path==='/v2/products/stocks')return {result:body.stocks.map(stock=>({...stock,updated:true,errors:[]}))};
    assert.fail('Unexpected external operation: '+path);
   }});
  const service=createAiListingService({repository:scoped,clock:()=>now,...ports,generateImage:async()=>assert.fail('Must retain generated images')});
  let result=await service.processNext({phase:'finalize'});assert.equal(result.status,'SUBMISSION_FAILED');assert.equal(result.submissionStage,'image_failed');
  assert.equal(result.taskActions.retry,true);assert.equal(result.taskActions.delete,true);
  const page=await repository.listPage({accountId,group:'failed'});assert.equal(page.tasks.find(t=>t.id===taskId).submissionStage,'image_failed');
  await service.retryTask(scope);await service.processNext({phase:'media'});assert.equal(calls.some(c=>c.path==='/v2/product/pictures/import'),false);
  result=await service.processNext({phase:'finalize'});assert.equal(result.status,'SUBMITTED');assert.equal(result.submissionStage,'repairing_images');
  healthy=true;now+=60000;result=await service.processNext({phase:'finalize'});assert.equal(result.status,'COMPLETED');
  const saved=await repository.get(scope);assert.deepEqual(saved.images,before.images);assert.deepEqual(saved.source,before.source);assert.deepEqual(await billing(),billed);
  const after=(await client.query('SELECT body FROM ai_image_listing_submissions WHERE account_id=$1 AND id=$2',[accountId,before.submissionId])).rows[0].body;
  assert.deepEqual(after.items,original.items);assert.deepEqual(after.results.filter(r=>r.sku!==target.sku),original.results.filter(r=>r.sku!==target.sku));
  assert.equal(after.results.filter(r=>r.stockStatus==='COMPLETED').length,12);
  assert.deepEqual(calls.filter(c=>c.path==='/v2/product/pictures/import').map(c=>c.body.items.map(i=>i.offer_id)),[[target.offerId]]);
  assert.deepEqual(calls.filter(c=>c.path==='/v2/products/stocks').map(c=>c.body.stocks.map(i=>i.offer_id)),[[target.offerId]]);
 }finally{await client.query('ROLLBACK');client.release();await pool.end();}
});

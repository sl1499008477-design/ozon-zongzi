import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {createAiListingService} from '../ai-listing-service.mjs';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';
import {reserveOzonWriteCapacity} from '../ozon-write-rate-limit.mjs';
const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
test('Postgres task and journal preserve partial successes, explicit retries and retained images without source rows', {skip:!enabled},async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();const accountId='ai-repair-'+randomUUID();
 try{
  await client.query('BEGIN');await client.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')",[accountId]);
  const local={query:(...args)=>client.query(...args),connect:async()=>({query:(...args)=>client.query(...args),release(){}})};
  let now=100000,imports=0,images=0;const stocks=[];const sources=['a','b'].map(sku=>({sku,images:['https://source.test/'+sku],categoryResolution:{status:'ACTIVE',currentDescriptionCategoryId:10,currentTypeId:20},listingItem:{offer_id:sku,name:sku,price:'20',currency_code:'RUB',weight:210,depth:120,width:130,height:140}}));
  const source={collectItemId:'deleted',sku:'a',items:sources,sourceSnapshot:{currency:'RUB',price:'20',listingDraft:{variants:[{sku:'b',currency:'RUB',price:'20'}]}}};
  const ports=createAiListingSubmissionPorts({pool:local,clock:()=>now,reserveCapacity:async()=>({allowed:true}),validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:'123'}}),readCredential:async()=>({clientId:'fixture'}),normalizeItems:async items=>({items}),callOzonSellerApi:async(_c,path,body)=>{
   if(path==='/v4/product/info/limit')return {daily_create:{limit:100,usage:0},total:{limit:1000,usage:0},operation_limits:{limit:0,limit_type:'UNSPECIFIED'}};
   if(path==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,id:1,statuses:{status:'price_sent'}}))};
   if(path==='/v3/product/import'){imports++;return {result:{task_id:imports}};}
   if(path==='/v1/product/import/info')return {result:{items:imports===1?[{offer_id:'a',product_id:1,status:'imported',errors:[]},{offer_id:'b',status:'failed',errors:[{code:'ATTRIBUTE_INVALID',level:'error'}]}]:[{offer_id:'b',product_id:2,status:'imported',errors:[]}]}};
   if(path==='/v2/products/stocks'){stocks.push(body.stocks.map(s=>s.offer_id));return {result:body.stocks.map(s=>({...s,updated:true,errors:[]}))};}
   throw Error('unexpected endpoint');
  }});
  const repository=createAiListingRepository({pool:local});
  // Restrict system-worker claim to this transaction's task, so preserved audit
  // data and other concurrently running fixtures are never claimed.
  const scoped={...repository,claimNext:async input=>{const row=(await client.query(`SELECT id FROM ai_image_listing_tasks WHERE account_id=$1 AND status IN ('QUEUED','GENERATING','READY_TO_SUBMIT','SUBMITTED') AND next_run_at<=$2`,[accountId,input.now])).rows[0];if(!row)return null;await client.query('UPDATE ai_image_listing_tasks SET lease_token=$2,lease_expires_at=$3,version=version+1 WHERE id=$1 AND account_id=$4',[row.id,input.leaseToken,input.now+input.leaseMs,accountId]);return repository.get({accountId,taskId:row.id});}};
  const service=createAiListingService({repository:scoped,clock:()=>now,loadSources:async()=>[source],generateImage:async input=>{images++;return {generatedUrl:'https://generated.test/'+input.sku};},...ports});
  const [task]=await service.createFromCollect({accountId,collectItemIds:['deleted'],idempotencyKey:'one',config:{targetStoreId:'store',targetWarehouseId:'warehouse',brandMode:'PREFER_SOURCE'}});
  // Generation yields after each SKU; advance both turns before polling import.
  assert.equal((await service.processNext()).status,'GENERATING');assert.equal(images,1);now+=15000;
  assert.equal((await service.processNext()).status,'SUBMITTED');now+=15000;await service.processNext();let result=await service.getTask({accountId,taskId:task.id});assert.equal(result.status,'SUBMISSION_FAILED');assert.equal(result.submissionResults[0].stockStatus,'COMPLETED');assert.deepEqual(stocks,[['a']]);
  await service.retryTask({accountId,taskId:task.id});await service.processNext();now+=15000;await service.processNext();result=await service.getTask({accountId,taskId:task.id});assert.equal(result.status,'COMPLETED');assert.equal(images,2);assert.equal(imports,2);assert.deepEqual(stocks,[['a'],['b']]);
  const journal=(await client.query('SELECT body FROM ai_image_listing_submissions WHERE account_id=$1',[accountId])).rows[0].body;assert.equal(journal.attempts.length,2);assert.deepEqual(journal.attempts[1].offerIds,['b']);
 }finally{await client.query('ROLLBACK');client.release();await pool.end();}
});
test('Postgres shared seller lock never allocates more than 80 concurrent requests and preserves pair cooldown', {skip:!enabled},async()=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:8});const prefix='ai-capacity-'+randomUUID(),seller=prefix+'seller';const keys=Array.from({length:81},(_,i)=>prefix+i);
 try{
  const results=await Promise.all(keys.map((requestKey,i)=>reserveOzonWriteCapacity({pool,sellerId:seller,operation:'stock',requestKey,units:1,pairKeys:[String(i)],limit:80})));
  assert.equal(results.filter(r=>r.allowed).length,80);assert.equal(results.filter(r=>!r.allowed).length,1);
  const first=await reserveOzonWriteCapacity({pool,sellerId:seller+'pair',operation:'stock',requestKey:prefix+'pair1',units:1,pairKeys:['offer:warehouse'],limit:80});
  const second=await reserveOzonWriteCapacity({pool,sellerId:seller+'pair',operation:'stock',requestKey:prefix+'pair2',units:1,pairKeys:['offer:warehouse'],limit:80});assert.equal(first.allowed,true);assert.equal(second.allowed,false);assert.ok(second.retryAfterMs>0&&second.retryAfterMs<=30000);
 }finally{await pool.query('DELETE FROM ozon_write_rate_reservations WHERE request_key=ANY($1::text[])',[[...keys,prefix+'pair1',prefix+'pair2']]);await pool.end();}
});

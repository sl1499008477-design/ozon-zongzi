import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';

const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
async function fixture(run){
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='quota_submission_'+randomUUID().replaceAll('-','');let pool;
 try{await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:4});
 await pool.query(`CREATE TABLE ai_image_listing_submissions(id text PRIMARY KEY,account_id text,task_id text,body jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE ai_image_listing_tasks(id text,account_id text,status text,deleted_at bigint);`);
 let now=100000;const calls=[];
 const add=async(id,store='store',skus=[id],accountId='account')=>{
  const body={status:'PREPARED',config:{targetStoreId:store,targetWarehouseId:'warehouse',stock:3,ozonRoute:'CN'},items:skus.map(offer_id=>({offer_id,images:['https://saved.test/'+offer_id]})),
  results:skus.map(sku=>({sku,offerId:sku,importStatus:'PENDING',stockStatus:'PENDING',errors:[]})),stocks:skus.map(offer_id=>({offer_id,warehouse_id:11,stock:3,completed:false})),
  attempts:[{id:'attempt-'+id,status:'WAITING',offerIds:skus,retryAt:0}]};
  await pool.query('INSERT INTO ai_image_listing_submissions(id,account_id,task_id,body) VALUES($1,$2,$1,$3)',[id,accountId,body]);
  await pool.query('INSERT INTO ai_image_listing_tasks VALUES($1,$2,$3,null)',[id,accountId,'SUBMITTED']);
 };
 const ports=handler=>createAiListingSubmissionPorts({pool,clock:()=>now,validateTarget:async()=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:'11'}}),
 readCredential:async({accountId,targetStoreId})=>({clientId:targetStoreId,ownerAccountId:accountId,ozonRoute:'CN'}),reserveCapacity:async()=>({allowed:true}),callOzonSellerApi:async(c,path,b)=>{calls.push({store:c.clientId,accountId:c.ownerAccountId,route:c.ozonRoute,path,body:structuredClone(b)});return handler(path,b,c.clientId);}});
 await run({pool,add,ports,calls,advance:ms=>{now+=ms;},read:(p,id,accountId='account')=>p.readSubmission({accountId,submissionId:id})});
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
}

test('PostgreSQL shared store lock serializes imports across worker ports but leaves another store independent',{skip:!enabled,timeout:10000},async()=>fixture(async x=>{
 await x.add('a');await x.add('b');await x.add('c','other');let release,entered;const inside=new Promise(r=>entered=r),hold=new Promise(r=>release=r);let done=false;
 const handler=async(path,b)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import'){if(b.items[0].offer_id==='a'){entered();await hold;}return {result:{task_id:b.items[0].offer_id==='a'?1:2}};}
 if(path==='/v1/product/import/info')return {result:{items:[{offer_id:'a',status:done?'imported':'pending',...(done?{product_id:11}:{}),errors:[]}]}};assert.fail(path);};
 const first=x.read(x.ports(handler),'a');await inside;
 try{assert.equal((await x.read(x.ports(handler),'b')).submissionWait.code,'STORE_QUEUE');await x.read(x.ports(handler),'c');}
 finally{release();await first;}
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items[0].offer_id),['a','c']);
 assert.equal((await x.read(x.ports(handler),'b')).submissionWait.code,'STORE_QUEUE');
 done=true;await x.read(x.ports(handler),'a');await x.read(x.ports(handler),'b');
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items[0].offer_id),['a','c','b']);
}));

test('PostgreSQL durable partial-quota recovery wins over a new group after port restart without duplicating successful SKU',{skip:!enabled,timeout:10000},async()=>fixture(async x=>{
 await x.add('group','store',['a','b']);await x.add('later','store',['c']);let available=false,imports=0;
 const handler=(path,b)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import')return {result:{task_id:++imports}};
 if(path==='/v1/product/import/info')return {result:{items:b.task_id===1?[{offer_id:'a',status:'imported',product_id:11,errors:[]},{offer_id:'b',status:'failed',errors:[{code:'item_limit_exceeded',level:'error'}]}]:[{offer_id:'b',status:'imported',product_id:12,errors:[]}]}};
 if(path==='/v4/product/info/limit')return {daily_create:{limit:100,usage:available?0:100,reset_at:'1970-01-01T00:03:20Z'},total:{limit:1000,usage:10}};assert.fail(path);};
 await x.read(x.ports(handler),'group');await x.read(x.ports(handler),'group');
 const frozen=(await x.pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='group'")).rows[0].body;
 assert.equal(frozen.results[0].importStatus,'SUCCEEDED');assert.equal(frozen.results[1].importStatus,'FAILED');
 await Promise.all([x.read(x.ports(handler),'group'),x.read(x.ports(handler),'later')]);assert.equal(x.calls.filter(c=>c.path==='/v4/product/info/limit').length,1);
 x.advance(100001);available=true;await x.read(x.ports(handler),'later');await x.read(x.ports(handler),'group');
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items.map(i=>i.offer_id)),[['a','b'],['b']]);
 assert.equal(x.calls.filter(c=>c.path==='/v4/product/info/limit').length,2);
 const after=(await x.pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='group'")).rows[0].body;
 assert.deepEqual(after.items,frozen.items);assert.equal(after.results[0].productId,'11');
}));

test('PostgreSQL a paused accepted group is reconciled read-only so a later group can submit',{skip:!enabled,timeout:10000},async()=>fixture(async x=>{
 await x.add('a');await x.add('b');
 await x.pool.query("UPDATE ai_image_listing_tasks SET status='PAUSED' WHERE id='a'");
 const body=(await x.pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='a'")).rows[0].body;
 Object.assign(body.attempts[0],{status:'ACCEPTED',ozonTaskId:'1',preexistingOfferIds:[]});
 await x.pool.query("UPDATE ai_image_listing_submissions SET body=$1 WHERE id='a'",[body]);
 const handler=(path,b)=>{if(path==='/v1/product/import/info')return {result:{items:[{offer_id:'a',status:'imported',product_id:11,errors:[]}]}};
 if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import'){assert.deepEqual(b.items.map(i=>i.offer_id),['b']);return {result:{task_id:2}};}
 assert.fail('paused group cannot write: '+path);};
 await x.read(x.ports(handler),'b');
 const saved=(await x.pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='a'")).rows[0].body;
 assert.equal(saved.attempts[0].status,'DONE');assert.equal(saved.results[0].importStatus,'SUCCEEDED');assert.equal(saved.results[0].stockStatus,'PENDING');
 assert.equal((await x.pool.query("SELECT status FROM ai_image_listing_tasks WHERE id='a'")).rows[0].status,'PAUSED');
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items[0].offer_id),['b']);
}));

test('PostgreSQL existing offer update proceeds despite another group exhausting daily create quota',{skip:!enabled,timeout:10000},async()=>fixture(async x=>{
 await x.add('a');await x.add('b');
 const handler=(path,b)=>{if(path==='/v3/product/info/list')return {items:b.offer_id.includes('b')?[{offer_id:'b',id:22}]:[]};
 if(path==='/v3/product/import'){if(b.items[0].offer_id==='a')throw Object.assign(new Error('limit'),{status:400,body:{ozonCode:'item_limit_exceeded'}});return {result:{task_id:2}};}
 if(path==='/v4/product/info/limit')return {daily_create:{limit:100,usage:100},daily_update:{limit:100,usage:0},total:{limit:1000,usage:100}};assert.fail(path);};
 await x.read(x.ports(handler),'a');const r=await x.read(x.ports(handler),'b');assert.equal(r.quotaWait,undefined);assert.equal(r.storeSwitchEligible,false);
 const saved=(await x.pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='b'")).rows[0].body;
 assert.deepEqual(saved.attempts[0].preexistingOfferIds,['b']);assert.equal(saved.quotaCheck.resolved,false);
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items[0].offer_id),['a','b']);
}));

test('PostgreSQL idle uncertain partial result yields the store queue without performing its pending recovery',{skip:!enabled,timeout:10000},async()=>fixture(async x=>{
 await x.add('old','store',['a','b']);await x.add('next','store',['c']);
 await x.pool.query("UPDATE ai_image_listing_tasks SET status='SUBMISSION_UNCERTAIN' WHERE id='old'");
 const body=(await x.pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='old'")).rows[0].body;
 Object.assign(body.attempts[0],{status:'UNCERTAIN',ozonTaskId:'1',preexistingOfferIds:[]});
 await x.pool.query("UPDATE ai_image_listing_submissions SET body=$1 WHERE id='old'",[body]);
 const handler=(path,b)=>{if(path==='/v1/product/import/info')return {result:{items:[{offer_id:'a',status:'imported',product_id:11,errors:[]},{offer_id:'b',status:'failed',errors:[{code:'item_limit_exceeded',level:'error'}]}]}};
 if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import'){assert.deepEqual(b.items.map(i=>i.offer_id),['c']);return {result:{task_id:2}};}
 assert.fail('idle group cannot write: '+path);};
 await x.read(x.ports(handler),'next');
 const saved=(await x.pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='old'")).rows[0].body;
 assert.equal(saved.attempts[0].status,'DONE');assert.equal(saved.attempts[1].status,'WAITING');assert.equal(saved.results[0].stockStatus,'PENDING');assert.equal(saved.results[1].quotaRecovery,true);
 assert.equal((await x.pool.query("SELECT status FROM ai_image_listing_tasks WHERE id='old'")).rows[0].status,'SUBMISSION_UNCERTAIN');
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items[0].offer_id),['c']);
}));

test('PostgreSQL independent offers proceed while an uncertain original holds its journal lock, but overlapping offers never replay',{skip:!enabled,timeout:10000},async()=>fixture(async x=>{
 await x.add('original','store',['a']);await x.add('independent','store',['b']);await x.add('overlap','store',['a']);
 let holdOriginal=false,originalHeld=false,enteredOriginal,releaseOriginal,enteredNew,releaseNew;
 const originalInside=new Promise(resolve=>enteredOriginal=resolve),originalGate=new Promise(resolve=>releaseOriginal=resolve);
 const newInside=new Promise(resolve=>enteredNew=resolve),newGate=new Promise(resolve=>releaseNew=resolve);
 const handler=async(path,b)=>{
  if(path==='/v3/product/info/list'){
   if(holdOriginal&&!originalHeld&&b.offer_id.includes('a')){originalHeld=true;enteredOriginal();await originalGate;}
   return {items:[]};
  }
  if(path==='/v3/product/import'){
   if(b.items[0].offer_id==='a')throw Object.assign(new Error('synthetic lost import reply'),{status:502,code:'ZONGZI_HTTP_502'});
   assert.deepEqual(b.items.map(item=>item.offer_id),['b']);enteredNew();await newGate;return {result:{task_id:2}};
  }
  if(path==='/v1/product/import/info')return {result:{items:[{offer_id:'b',status:'imported',product_id:22,errors:[]}]}};
  assert.fail('unexpected external write: '+path);
 };
 assert.equal((await x.read(x.ports(handler),'original')).status,'UNCERTAIN');
 holdOriginal=true;const original=x.read(x.ports(handler),'original');await originalInside;
 const independent=x.read(x.ports(handler),'independent');
 try{
  await Promise.race([newInside,independent.then(()=>assert.fail('independent offer must reach import while original is being queried'))]);
  assert.equal((await x.read(x.ports(handler),'overlap')).submissionWait.code,'STORE_QUEUE','a live independent import still owns the store write lock');
 }finally{releaseNew();releaseOriginal();await Promise.all([independent,original]);}
 // Resolve B's accepted import so only A's unknown offer scope can block this retry.
 await x.read(x.ports(handler),'independent');
 const blocked=await x.read(x.ports(handler),'overlap');assert.equal(blocked.submissionWait.code,'STORE_QUEUE');assert.match(blocked.submissionWait.message,/货号.*待核实/);
 await x.read(x.ports(handler),'original');
 const saved=(await x.pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='original'")).rows[0].body;
 assert.equal(saved.attempts[0].status,'UNCERTAIN');assert.equal(saved.results[0].importStatus,'UNKNOWN');assert.equal(saved.config.ozonRoute,'CN');assert.equal(saved.attempts[0].apiRoute,'RU');
 assert.deepEqual(x.calls.filter(call=>call.path==='/v3/product/import').map(call=>call.body.items.map(item=>item.offer_id)),[['a'],['b']]);
 assert.ok(x.calls.every(call=>call.route==='RU'));
}));

test('PostgreSQL missing offer scope or incomplete result rows cannot manufacture a completed original request',{skip:!enabled,timeout:10000},async()=>fixture(async x=>{
 for(const kind of ['empty-scope','missing-result']){
  const id='old-'+kind,next='next-'+kind;
  await x.add(id,kind,['a']);await x.add(next,kind,[kind==='empty-scope'?'b':'a']);
  const body=(await x.pool.query('SELECT body FROM ai_image_listing_submissions WHERE id=$1',[id])).rows[0].body;
  body.status='UNCERTAIN';Object.assign(body.attempts[0],{status:'UNCERTAIN',preexistingOfferIds:[]});
  if(kind==='empty-scope')body.attempts[0].offerIds=[];else body.results=[];
  await x.pool.query('UPDATE ai_image_listing_submissions SET body=$2 WHERE id=$1',[id,body]);
  const port=x.ports(path=>{if(path==='/v3/product/info/list')return {items:[]};assert.fail('unknown original cannot permit another write: '+path);});
  assert.equal((await x.read(port,next)).submissionWait.code,'STORE_QUEUE');
  const saved=(await x.pool.query('SELECT body FROM ai_image_listing_submissions WHERE id=$1',[id])).rows[0].body;
  assert.equal(saved.attempts[0].status,'UNCERTAIN');assert.deepEqual(saved.attempts[0].offerIds,body.attempts[0].offerIds);
 }
 assert.equal(x.calls.filter(call=>call.path==='/v3/product/import').length,0);
}));

test('PostgreSQL unknown submission scopes and reads cannot cross account ownership',{skip:!enabled,timeout:10000},async()=>fixture(async x=>{
 await x.add('foreign','store',['a'],'other-account');await x.add('local','store',['a']);
 const body=(await x.pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='foreign'")).rows[0].body;
 body.status='UNCERTAIN';Object.assign(body.attempts[0],{status:'UNCERTAIN',preexistingOfferIds:[]});
 await x.pool.query("UPDATE ai_image_listing_submissions SET body=$1 WHERE id='foreign'",[body]);
 const port=x.ports(path=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import')return {result:{task_id:1}};assert.fail(path);});
 await assert.rejects(x.read(port,'foreign'),{code:'AI_LISTING_SUBMISSION_NOT_FOUND'});assert.equal(x.calls.length,0);
 await x.read(port,'local');
 assert.deepEqual(x.calls.filter(call=>call.path==='/v3/product/import').map(call=>call.body.items.map(item=>item.offer_id)),[['a']]);
 assert.ok(x.calls.every(call=>call.accountId==='account'));
 assert.deepEqual((await x.pool.query("SELECT body FROM ai_image_listing_submissions WHERE id='foreign'")).rows[0].body,body);
}));

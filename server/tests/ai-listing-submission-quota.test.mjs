import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';
const input=(key='a',store='one',skus=['a','b'])=>({accountId:'account',taskId:key,idempotencyKey:key,deferImport:true,
 config:{targetStoreId:store,targetWarehouseId:store+'-warehouse',stock:5,brandMode:'PREFER_SOURCE',priceMultiplier:'1',priceAdjustmentKopecks:0,autoSwitchStores:true,fallbackStores:[{targetStoreId:'two',targetWarehouseId:'two-warehouse'}]},
 source:{sku:skus[0],sourceSnapshot:{currency:'RUB',price:'20',listingDraft:{variants:skus.slice(1).map(sku=>({sku,currency:'RUB',price:'20'}))}},items:skus.map(sku=>({sku,images:['https://source.test/'+sku],listingItem:{offer_id:sku,name:sku,price:'20',description_category_id:10,type_id:20,weight:200,depth:100,width:100,height:100}}))},
 images:skus.map(sku=>({sku,index:0,generatedUrl:'https://generated.test/'+sku}))});
function setup(handler){let now=100000;const rows=new Map(),calls=[];
 const client={release(){},async query(sql,v){
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(sql.startsWith('SELECT * FROM ai_image_listing_submissions'))return {rows:rows.has(v[1])?[structuredClone(rows.get(v[1]))]:[]};
  if(sql.includes('/* ai-listing-store-submissions */'))return {rows:[...rows.values()].filter(r=>r.account_id===v[0]&&r.body.config.targetStoreId===v[1]).map(row=>structuredClone(row))};
  if(sql.includes('/* ai-listing-store-quota-observation */')){const checks=[...rows.values()].filter(r=>r.account_id===v[0]).flatMap(r=>[r.body,...(r.body.previousStoreAttempts||[])]).filter(b=>b.config.targetStoreId===v[1]&&b.quotaCheck).map(b=>b.quotaCheck).sort((a,b)=>b.checkedAt-a.checkedAt);return {rows:checks.length?[{quota_check:structuredClone(checks[0])}]:[]};}
  if(sql.startsWith('INSERT INTO ai_image_listing_submissions'))rows.set(v[0],{id:v[0],account_id:v[1],task_id:v[2],task_status:'SUBMITTED',created_at:now,body:JSON.parse(v[4])});
  if(sql.startsWith('UPDATE ai_image_listing_submissions'))rows.get(v[1]).body=JSON.parse(v[2]);
  return {rows:[]};}};
 const pool={connect:async()=>client,query:(...args)=>client.query(...args)};
 const create=()=>createAiListingSubmissionPorts({pool,clock:()=>now,normalizeItems:async items=>({items}),reserveCapacity:async()=>({allowed:true}),
  validateTarget:async({config})=>({store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:config.targetStoreId==='two'?'222':'111'}}),
  readCredential:async({targetStoreId})=>({clientId:targetStoreId,ozonRoute:'CN'}),callOzonSellerApi:async(c,path,body)=>{calls.push({store:c.clientId,route:c.ozonRoute,path,body:structuredClone(body)});return handler(path,body,c.clientId);}});
 let ports=create();return {get ports(){return ports;},restart(){ports=create();},calls,rows,advance:ms=>{now+=ms;},read:id=>ports.readSubmission({accountId:'account',submissionId:id})};}
const quotaError=()=>Object.assign(new Error('Ozon quota'),{status:400,code:'ZONGZI_HTTP_400',body:{ozonCode:'item_limit_exceeded'}});
const quota=(usage=100)=>({daily_create:{limit:100,usage,reset_at:'1970-01-01T00:03:20Z'},daily_update:{limit:100,usage:0},total:{limit:1000,usage:20}});
const failed=offer_id=>({offer_id,status:'failed',errors:[{code:'item_limit_exceeded',level:'error'}]});
const success=(offer_id,id=11)=>({offer_id,status:'imported',product_id:id,errors:[]});

test('normal import never queries quota; same store waits only for import result and another store proceeds',async()=>{
 let done=false;const x=setup((path,b)=>{
  if(path==='/v3/product/info/list')return {items:[]};
  if(path==='/v3/product/import')return {result:{task_id:b.items[0].offer_id==='a'?1:2}};
  if(path==='/v1/product/import/info')return {result:{items:b.task_id===1?[done?success('a'):{offer_id:'a',status:'pending',errors:[]}]:[{offer_id:'b',status:'pending',errors:[]}]}};
  assert.fail('unexpected preflight '+path);
 });
 const a=await x.ports.submitListing(input('a','one',['a'])),b=await x.ports.submitListing(input('b','one',['b'])),c=await x.ports.submitListing(input('c','two',['c']));
 await x.read(a.submissionId);assert.equal((await x.read(b.submissionId)).submissionStage,'store_wait');await x.read(c.submissionId);
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items[0].offer_id),['a','c']);
 done=true;await x.read(a.submissionId);await x.read(b.submissionId);
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items[0].offer_id),['a','c','b']);
});

test('partial quota failure survives restart and reimports only quota failed SKU after one shared recovery check',async()=>{
 let available=false,imports=0;const x=setup((path,b)=>{
  if(path==='/v3/product/info/list')return {items:[]};
  if(path==='/v3/product/import'){imports++;return {result:{task_id:imports}};}
  if(path==='/v1/product/import/info')return {result:{items:b.task_id===1?[success('a'),failed('b')]:[success('b',12)]}};
  if(path==='/v4/product/info/limit')return quota(available?0:100);
  assert.fail(path);
 });
 const a=await x.ports.submitListing(input()),b=await x.ports.submitListing(input('later','one',['c']));
 await x.read(a.submissionId);const waiting=await x.read(a.submissionId);
 assert.equal(waiting.quotaWait.code,'DAILY_LIMIT');assert.equal(waiting.items[0].importStatus,'SUCCEEDED');assert.equal(waiting.storeSwitchEligible,false);
 await x.read(b.submissionId);assert.equal(x.calls.filter(c=>c.path==='/v4/product/info/limit').length,1);
 x.restart();x.advance(100001);available=true;await x.read(b.submissionId);await x.read(a.submissionId);
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items.map(i=>i.offer_id)),[['a','b'],['b']]);
 assert.equal(x.calls.filter(c=>c.path==='/v4/product/info/limit').length,2);
});

test('a non-quota failed sibling remains failed while quota-only sibling waits',async()=>{
 const x=setup((path,b)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import')return {result:{task_id:1}};
 if(path==='/v1/product/import/info')return {result:{items:[success('a'),failed('b'),{offer_id:'c',status:'failed',errors:[{code:'ATTRIBUTE_INVALID',level:'error'}]}]}};
 if(path==='/v4/product/info/limit')return quota();assert.fail(path);});
 const a=await x.ports.submitListing(input('a','one',['a','b','c']));await x.read(a.submissionId);const r=await x.read(a.submissionId);
 assert.equal(r.items[1].importStatus,'FAILED');assert.equal(r.items[1].quotaRecovery,true);assert.equal(r.items[2].importStatus,'FAILED');assert.equal(r.storeSwitchEligible,false);
});

test('explicit full quota rejection can switch only to configured target and rebuilds warehouse with frozen images',async()=>{
 const x=setup((path,b,store)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import'){if(store==='one')throw quotaError();return {result:{task_id:8}};}
 if(path==='/v4/product/info/limit')return quota();assert.fail(path);});
 const data=input(),a=await x.ports.submitListing(data);const r=await x.read(a.submissionId);assert.equal(r.storeSwitchEligible,true);
 await assert.rejects(x.ports.submitListing({...data,switchStore:true,config:{...data.config,targetStoreId:'unconfigured',targetWarehouseId:'unconfigured-warehouse'}}),{code:'AI_LISTING_SUBMISSION_IDENTITY_MISMATCH'});
 await x.ports.submitListing({...data,switchStore:true,config:{...data.config,targetStoreId:'two',targetWarehouseId:'two-warehouse'}});
 const saved=x.rows.get(a.submissionId).body;assert.equal(saved.config.targetStoreId,'two');assert.equal(saved.stocks[0].warehouse_id,222);assert.equal(saved.previousStoreAttempts.length,1);
 assert.deepEqual(saved.items[0].images,['https://generated.test/a']);assert.equal(saved.attempts.length,1);await x.read(a.submissionId);
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.store),['one','two']);
});

test('HTTP 429 obeys retry timing without quota lookup and network uncertainty never switches or reimports',async()=>{
 for(const rate of [true,false]){
  const x=setup((path)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import')throw Object.assign(new Error('failure'),rate?{status:429,code:'ZONGZI_HTTP_429',retryAfterMs:120000}:{status:502,code:'ZONGZI_NETWORK_ERROR'});assert.fail(path);});
  const a=await x.ports.submitListing(input());const r=await x.read(a.submissionId);
  assert.equal(r.storeSwitchEligible,false);assert.equal(r.quotaWait,undefined);assert.equal(r.submissionStage,rate?'import_rate_limit':undefined);
  x.advance(60000);x.restart();await x.read(a.submissionId);assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,1);
 }
});

test('quota and validation errors on the same SKU do not enter automatic quota retries',async()=>{
 const x=setup((path)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import')return {result:{task_id:1}};
 if(path==='/v1/product/import/info')return {result:{items:[{offer_id:'a',status:'failed',errors:[{code:'item_limit_exceeded',level:'error'},{code:'ATTRIBUTE_INVALID',level:'error'}]}]}};
 if(path==='/v4/product/info/limit')return quota();assert.fail(path);});
 const a=await x.ports.submitListing(input('a','one',['a']));await x.read(a.submissionId);const r=await x.read(a.submissionId);
 assert.equal(r.items[0].importStatus,'FAILED');assert.equal(r.quotaWait,undefined);assert.equal(x.calls.filter(c=>c.path==='/v4/product/info/limit').length,0);
});

test('after recovery, later ordinary submissions do not periodically requery healthy quota',async()=>{
 let exhausted=true,imports=0;const x=setup((path,b)=>{if(path==='/v3/product/info/list')return {items:[]};
 if(path==='/v3/product/import'){if(exhausted)throw quotaError();imports++;return {result:{task_id:imports}};}
 if(path==='/v1/product/import/info')return {result:{items:[success('a')]}};
 if(path==='/v4/product/info/limit')return quota(exhausted?100:0);assert.fail(path);});
 const a=await x.ports.submitListing(input('a','one',['a']));await x.read(a.submissionId);x.advance(100001);exhausted=false;
 await x.read(a.submissionId);x.advance(60001);await x.read(a.submissionId);await x.read(a.submissionId);
 const reads=x.calls.filter(c=>c.path==='/v4/product/info/limit').length;
 x.advance(600000);const b=await x.ports.submitListing(input('b','one',['b']));await x.read(b.submissionId);
 assert.equal(x.calls.filter(c=>c.path==='/v4/product/info/limit').length,reads);
});

test('known old-store quota remains shared after the rejected group switches stores',async()=>{
 const x=setup((path,b,store)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import'){if(store==='one')throw quotaError();return {result:{task_id:1}};}
 if(path==='/v4/product/info/limit')return quota();assert.fail(path);});
 const data=input(),a=await x.ports.submitListing(data);await x.read(a.submissionId);
 await x.ports.submitListing({...data,switchStore:true,config:{...data.config,targetStoreId:'two',targetWarehouseId:'two-warehouse'}});
 const b=await x.ports.submitListing(input('later','one',['c']));const r=await x.read(b.submissionId);
 assert.equal(r.quotaWait.code,'DAILY_LIMIT');assert.equal(r.storeSwitchEligible,true);
 assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,1);assert.equal(x.calls.filter(c=>c.path==='/v4/product/info/limit').length,1);
});

test('rate limiting is shared by same-store groups without stopping another store',async()=>{
 const x=setup((path,b,store)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import'){if(store==='one')throw Object.assign(new Error('rate'),{status:429,retryAfterMs:120000});return {result:{task_id:1}};}assert.fail(path);});
 const a=await x.ports.submitListing(input('a','one',['a'])),b=await x.ports.submitListing(input('b','one',['b'])),c=await x.ports.submitListing(input('c','two',['c']));
 await x.read(a.submissionId);assert.equal((await x.read(b.submissionId)).submissionWait.code,'RATE_LIMIT');await x.read(c.submissionId);
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.store),['one','two']);
});

test('numeric Ozon code with an explicit item_limit_exceeded token uses quota recovery',async()=>{
 const x=setup(path=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import')throw Object.assign(new Error('limit'),{status:400,body:{ozonCode:'3',ozonMessage:'item_limit_exceeded: upload limit exceeded'}});if(path==='/v4/product/info/limit')return quota();assert.fail(path);});
 const a=await x.ports.submitListing(input());assert.equal((await x.read(a.submissionId)).quotaWait.code,'DAILY_LIMIT');
});

test('legacy unsent quota preflight deadline is cleared but an accepted original request is never resent',async()=>{
 const x=setup((path,b)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import')return {result:{task_id:1}};
 if(path==='/v1/product/import/info')return {result:{items:b.task_id===1?[{offer_id:'a',status:'pending',errors:[]},{offer_id:'b',status:'pending',errors:[]}]:[]}};assert.fail(path);});
 const data=input(),a=await x.ports.submitListing(data),body=x.rows.get(a.submissionId).body;
 body.quotaWait={code:'DAILY_LIMIT',retryAt:9999999};body.retryAt=9999999;body.attempts[0].retryAt=9999999;
 await x.ports.submitListing({...data,deferImport:false});assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,1);
 x.rows.get(a.submissionId).body.quotaWait={code:'DAILY_LIMIT',retryAt:9999999};await x.read(a.submissionId);
 assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,1);
});

test('updates blocked by a daily update quota stay in the existing store',async()=>{
 const x=setup(path=>{if(path==='/v3/product/info/list')return {items:[{offer_id:'a',id:11},{offer_id:'b',id:12}]};if(path==='/v3/product/import')throw quotaError();
 if(path==='/v4/product/info/limit')return {daily_create:{limit:100,usage:0},daily_update:{limit:10,usage:10},total:{limit:1000,usage:10}};assert.fail(path);});
 const a=await x.ports.submitListing(input()),r=await x.read(a.submissionId);assert.equal(r.quotaWait.code,'DAILY_UPDATE_LIMIT');assert.equal(r.storeSwitchEligible,false);
});

for(const state of ['ACCEPTED','UNCERTAIN','IMPORTING'])test(`a later group reconciles a paused ${state} import without writing its inventory or replaying it`,async()=>{
 const x=setup((path,b)=>{if(path==='/v1/product/import/info')return {result:{items:[success('a')]}};
 if(path==='/v3/product/info/list')return {items:b.offer_id.includes('a')?[{offer_id:'a',id:11}]:[]};
 if(path==='/v3/product/import'){assert.deepEqual(b.items.map(i=>i.offer_id),['b']);return {result:{task_id:2}};}assert.fail('paused task write: '+path);});
 const a=await x.ports.submitListing(input('a','one',['a'])),b=await x.ports.submitListing(input('b','one',['b']));
 const old=x.rows.get(a.submissionId);old.task_status='PAUSED';Object.assign(old.body.attempts[0],{status:state,preexistingOfferIds:[],...(state==='ACCEPTED'?{ozonTaskId:'1'}:{})});
 await x.read(b.submissionId);assert.equal(x.rows.get(a.submissionId).body.attempts[0].status,'DONE');
 assert.equal(x.rows.get(a.submissionId).body.results[0].stockStatus,'PENDING');assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,1);
});

test('an unresolved idle original request is isolated while independent offers proceed without replay',async()=>{
 const x=setup((path,b)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import'){assert.deepEqual(b.items.map(i=>i.offer_id),['b']);return {result:{task_id:2}};}assert.fail(path);});
 const a=await x.ports.submitListing(input('a','one',['a'])),b=await x.ports.submitListing(input('b','one',['b']));
 const old=x.rows.get(a.submissionId);old.task_status='SUBMISSION_UNCERTAIN';Object.assign(old.body.attempts[0],{status:'UNCERTAIN',preexistingOfferIds:[]});
 await x.read(b.submissionId);assert.equal(x.rows.get(a.submissionId).body.results[0].importStatus,'UNKNOWN');
 assert.equal(x.rows.get(a.submissionId).body.attempts[0].status,'UNCERTAIN');
 assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items.map(i=>i.offer_id)),[['b']]);
});

test('uncertain original offers still block overlapping groups after restart',async()=>{
 const x=setup(path=>{if(path==='/v3/product/info/list')return {items:[]};assert.fail('must not repeat an uncertain offer: '+path);});
 const a=await x.ports.submitListing(input('a','one',['a'])),b=await x.ports.submitListing(input('b','one',['a','b']));
 Object.assign(x.rows.get(a.submissionId).body.attempts[0],{status:'UNCERTAIN',preexistingOfferIds:[]});
 x.restart();const waiting=await x.read(b.submissionId);
 assert.equal(waiting.submissionWait.code,'STORE_QUEUE');
 assert.match(waiting.submissionWait.message,/货号.*待核实/);
 assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,0);
});

test('uncertainty without a known offer scope cannot release the store',async()=>{
 const x=setup(path=>{if(path==='/v3/product/info/list')return {items:[]};assert.fail('unknown scope cannot authorize import: '+path);});
 const a=await x.ports.submitListing(input('a','one',['a'])),b=await x.ports.submitListing(input('b','one',['b']));
 Object.assign(x.rows.get(a.submissionId).body.attempts[0],{status:'UNCERTAIN',offerIds:[],preexistingOfferIds:[]});
 assert.equal((await x.read(b.submissionId)).submissionWait.code,'STORE_QUEUE');
 assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,0);
});

test('an incomplete result journal cannot prove an uncertain offer succeeded',async()=>{
 const x=setup(path=>{if(path==='/v3/product/info/list')return {items:[]};assert.fail('unconfirmed original offer cannot repeat: '+path);});
 const a=await x.ports.submitListing(input('a','one',['a'])),b=await x.ports.submitListing(input('b','one',['a']));
 const original=x.rows.get(a.submissionId).body;
 Object.assign(original.attempts[0],{status:'UNCERTAIN',preexistingOfferIds:[]});original.results=[];
 assert.equal((await x.read(b.submissionId)).submissionWait?.code,'STORE_QUEUE');
 assert.equal(x.rows.get(a.submissionId).body.attempts[0].status,'UNCERTAIN');
 assert.equal(x.calls.filter(c=>c.path==='/v3/product/import').length,0);
});

test('AI import and result reads use the official API without changing the frozen CN route',async()=>{
 const x=setup((path,b)=>{if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import')return {result:{task_id:1}};
 if(path==='/v1/product/import/info')return {result:{items:[success('a')]}};assert.fail(path);});
 const data=input('a','one',['a']);data.config.ozonRoute='CN';
 const a=await x.ports.submitListing(data);await x.read(a.submissionId);await x.read(a.submissionId);
 assert.ok(x.calls.some(c=>c.path==='/v3/product/import'));
 assert.ok(x.calls.some(c=>c.path==='/v1/product/import/info'));
 assert.ok(x.calls.every(c=>c.route==='RU'));
 assert.equal(data.config.ozonRoute,'CN');assert.equal(x.rows.get(a.submissionId).body.config.ozonRoute,'CN');
 assert.equal(x.rows.get(a.submissionId).body.attempts[0].apiRoute,'RU');
});

test('shared create exhaustion does not block an existing offer update or allow switching it',async()=>{
 const x=setup((path,b)=>{if(path==='/v3/product/info/list')return {items:b.offer_id.includes('b')?[{offer_id:'b',id:22}]:[]};
 if(path==='/v3/product/import'){if(b.items[0].offer_id==='a')throw quotaError();return {result:{task_id:2}};}
 if(path==='/v4/product/info/limit')return quota();assert.fail(path);});
 const a=await x.ports.submitListing(input('a','one',['a']));await x.read(a.submissionId);
 const b=await x.ports.submitListing(input('b','one',['b']));const r=await x.read(b.submissionId);
 assert.equal(r.quotaWait,undefined);assert.equal(r.storeSwitchEligible,false);assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items[0].offer_id),['a','b']);
 assert.deepEqual(x.rows.get(b.submissionId).body.attempts[0].preexistingOfferIds,['b']);
 assert.equal(x.rows.get(b.submissionId).body.quotaCheck.resolved,false,'an update must not clear the exhausted create bucket');
});

test('idle uncertainty resolved to partial quota failure does not claim runnable recovery priority',async()=>{
 const x=setup((path,b)=>{if(path==='/v1/product/import/info')return {result:{items:[success('a'),failed('b')]}};
 if(path==='/v3/product/info/list')return {items:[]};if(path==='/v3/product/import'){assert.deepEqual(b.items.map(i=>i.offer_id),['c']);return {result:{task_id:2}};}
 assert.fail('idle task must not submit or set stock: '+path);});
 const old=await x.ports.submitListing(input('old','one',['a','b'])),next=await x.ports.submitListing(input('next','one',['c']));
 const row=x.rows.get(old.submissionId);row.task_status='SUBMISSION_UNCERTAIN';Object.assign(row.body.attempts[0],{status:'UNCERTAIN',ozonTaskId:'1',preexistingOfferIds:[]});
 await x.read(next.submissionId);
 const saved=x.rows.get(old.submissionId).body;assert.equal(saved.results[0].importStatus,'SUCCEEDED');assert.equal(saved.results[1].quotaRecovery,true);
 assert.equal(saved.attempts[1].status,'WAITING');assert.deepEqual(x.calls.filter(c=>c.path==='/v3/product/import').map(c=>c.body.items.map(i=>i.offer_id)),[['c']]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingSubmissionPorts} from '../ai-listing-submission.mjs';

const sku='4157480005',offer='historical-offer';
const credential=Object.freeze({clientId:'same-seller',apiKey:'fixture-only',ozonRoute:'CN'});
function setup({rows=[{offer_id:offer,id:123,statuses:{status:'price_sent',is_created:true}}],preexistingOfferIds=[],offerIds=[offer],ozonTaskId=null,error}={}){
 const calls=[],scope=[];let beforeWrites=0;
 const journal={id:'historical-submission',account_id:'account',task_id:'historical-task',body:{
  status:'UNCERTAIN',config:{targetStoreId:'same-store',targetWarehouseId:'same-warehouse',ozonRoute:'CN',stock:3},
  items:[{scraped_sku:sku,offer_id:offer,images:['https://saved.test/paid-image.png']}],
  stocks:[{offer_id:offer,warehouse_id:99,stock:3,completed:false}],
  results:[{sku,offerId:offer,importStatus:'UNKNOWN',stockStatus:'PENDING',errors:[]}],
  attempts:[{id:'original-attempt',apiRoute:'CN',status:'UNCERTAIN',offerIds,preexistingOfferIds,ozonTaskId,errorCode:'ZONGZI_HTTP_502'}],
 }};
 const client={release(){},async query(sql,values){
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(sql.startsWith('SELECT * FROM ai_image_listing_submissions')){
   assert.equal(values[0],'account');assert.equal(values[1],journal.id);return {rows:[structuredClone(journal)]};
  }
  if(sql.startsWith('UPDATE ai_image_listing_submissions')){
   assert.equal(values[0],'account');assert.equal(values[1],journal.id);journal.body=JSON.parse(values[2]);
  }
  return {rows:[]};
 }};
 const ports=createAiListingSubmissionPorts({pool:{connect:async()=>client},clock:()=>1000,
  readCredential:async input=>{
   scope.push([input.accountId,input.targetStoreId]);assert.equal(input.accountId,'account');assert.equal(input.targetStoreId,'same-store');return credential;
  },validateTarget:async({accountId,config})=>{
   assert.equal(accountId,'account');assert.equal(config.targetStoreId,'same-store');assert.equal(config.targetWarehouseId,'same-warehouse');
   return {store:{currencyCode:'RUB'},warehouse:{platformWarehouseId:99}};
  },reserveCapacity:async()=>({allowed:true}),callOzonSellerApi:async(c,path,body)=>{
   calls.push({route:c.ozonRoute,path,body:structuredClone(body)});
   assert.equal(c.clientId,credential.clientId);assert.equal(c.apiKey,credential.apiKey);assert.equal(c.ozonRoute,'RU');
   if(path==='/v3/product/info/list'){
    assert.deepEqual(body,{offer_id:offerIds});if(error)throw error;return {items:structuredClone(rows)};
   }
   if(path==='/v1/product/import/info'){
    assert.deepEqual(body,{task_id:1234});return {result:{items:[{offer_id:offer,product_id:123,status:'imported',errors:[]}]}};
   }
   if(path==='/v2/products/stocks'){
    assert.deepEqual(body,{stocks:[{offer_id:offer,warehouse_id:99,stock:3}]});
    return {result:[{offer_id:offer,warehouse_id:99,updated:true,errors:[]}]};
   }
   assert.fail(`recovery must never import or replace paid images: ${path}`);
  }});
 return {journal,calls,scope,read:()=>ports.readSubmission({accountId:'account',submissionId:journal.id,beforeExternalWrite:async()=>{beforeWrites++;}}),beforeWrites:()=>beforeWrites};
}

test('legacy CN 502 without task id uses RU to reconcile the exact offer then resumes saved stock once without reimport',async()=>{
 const x=setup(),before=structuredClone(x.journal.body.items);
 const result=await x.read();assert.equal(result.status,'COMPLETED');
 assert.equal(result.items[0].productId,'123');assert.equal(result.items[0].stockStatus,'COMPLETED');
 assert.equal(x.journal.body.attempts[0].id,'original-attempt');assert.equal(x.journal.body.attempts[0].status,'DONE');
 assert.equal(x.journal.body.attempts[0].apiRoute,'CN','historical import evidence is retained');
 assert.equal(x.journal.body.config.ozonRoute,'CN');assert.equal(credential.ozonRoute,'CN');assert.deepEqual(x.journal.body.items,before);
 assert.deepEqual(x.calls.map(c=>c.path),['/v3/product/info/list','/v3/product/info/list','/v2/products/stocks','/v3/product/info/list']);
 assert.equal(x.beforeWrites(),1);assert.deepEqual(x.scope,[['account','same-store']]);
 await x.read();assert.equal(x.calls.length,4);assert.equal(x.beforeWrites(),1);
});

for(const [name,options] of [
 ['no matching offer',{rows:[]}],
 ['unrelated offer',{rows:[{offer_id:'other-offer',id:321,statuses:{status:'price_sent',is_created:true}}]}],
 ['same offer existed before submission',{preexistingOfferIds:[offer]}],
 ['missing pre-submit observation',{preexistingOfferIds:null}],
 ['duplicate matching identities',{rows:[{offer_id:offer,id:123},{offer_id:offer,id:456}]}],
])test(`RU reconciliation preserves uncertainty without writes when ${name}`,async()=>{
 const x=setup(options);const before=structuredClone(x.journal.body.items);
 for(let i=0;i<2;i++){
  const result=await x.read();assert.equal(result.status,'UNCERTAIN');assert.equal(result.items[0].importStatus,'UNKNOWN');
  assert.equal(x.journal.body.attempts[0].status,'UNCERTAIN');
 }
 assert.deepEqual(x.calls.map(c=>c.path),['/v3/product/info/list','/v3/product/info/list']);
 assert.equal(x.beforeWrites(),0);assert.deepEqual(x.journal.body.items,before);assert.equal(x.journal.body.config.ozonRoute,'CN');
});

test('legacy unknown submission without offer ids remains unresolved and cannot be treated as an empty successful import',async()=>{
 const x=setup({offerIds:[]});const result=await x.read();
 assert.equal(result.status,'UNCERTAIN');assert.deepEqual(x.calls,[]);assert.equal(x.beforeWrites(),0);
});

test('failed RU identity read preserves the old unknown attempt and never submits it again',async()=>{
 const x=setup({error:Object.assign(new Error('temporary RU failure'),{status:503,code:'ZONGZI_HTTP_503'})});
 await assert.rejects(x.read(),{code:'ZONGZI_HTTP_503'});
 assert.equal(x.journal.body.attempts[0].status,'UNCERTAIN');assert.equal(x.beforeWrites(),0);
 assert.deepEqual(x.calls.map(c=>c.path),['/v3/product/info/list']);
});

test('a legacy CN unknown response with an Ozon task id reconciles that task on RU without importing again',async()=>{
 const x=setup({ozonTaskId:'1234'});const result=await x.read();
 assert.equal(result.status,'COMPLETED');assert.equal(x.journal.body.attempts[0].ozonTaskId,'1234');
 assert.deepEqual(x.calls.map(c=>c.path),['/v1/product/import/info','/v3/product/info/list','/v2/products/stocks','/v3/product/info/list']);
 assert.equal(x.journal.body.config.ozonRoute,'CN');assert.equal(x.beforeWrites(),1);
});

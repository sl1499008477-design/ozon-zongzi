import test from 'node:test';
import assert from 'node:assert/strict';
import {callOzonSellerApi} from '../ozon-client.mjs';

test('import quota errors retain safe reason and typed retry hints without exposing credentials or arbitrary details',async()=>{
 const old=globalThis.fetch;const store={clientId:'private-client',apiKey:'private-secret'};
 globalThis.fetch=async()=>new Response(JSON.stringify({code:'RESOURCE_EXHAUSTED',message:'item_limit_exceeded private-secret private-client',details:{secret:'never-expose'}}),{status:429,headers:{'Retry-After':'120','Item-Retry-After':'3','Item-Rate-Limit-Remaining':'0'}});
 try {await assert.rejects(callOzonSellerApi(store,'/v3/product/import',{}),e=>{
  assert.equal(e.body.ozonCode,'RESOURCE_EXHAUSTED');assert.match(e.body.ozonMessage,/item_limit_exceeded/);
  assert.equal(e.retryAfterMs,120000);assert.equal(e.itemRetryAfterMs,180000);assert.equal(e.itemRateLimitRemaining,0);
  assert.doesNotMatch(JSON.stringify(e),/private-client|private-secret|never-expose/);return true;
 });}finally{globalThis.fetch=old;}
});

test('invalid response hints do not invent quota values and other endpoints keep their existing error contract',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({message:'arbitrary private body'}),{status:502,headers:{'Retry-After':'bad','Item-Retry-After':'-5','Item-Rate-Limit-Remaining':'NaN'}});
 try {for(const path of ['/v3/product/import','/v3/product/info/list'])await assert.rejects(callOzonSellerApi({clientId:'x',apiKey:'y'},path,{}),e=>{
  assert.equal(e.retryAfterMs,undefined);assert.equal(e.itemRetryAfterMs,undefined);assert.equal(e.itemRateLimitRemaining,undefined);
  assert.equal(e.body.ozonMessage,undefined);return true;
 });}finally{globalThis.fetch=old;}
});

test('only product identity reads may retry confirmed CN gateway failure on RU without changing the selected route',async()=>{
 const {callOzonProductInfo}=await import('../ozon-client.mjs');const original=Object.freeze({clientId:'seller',apiKey:'secret',ozonRoute:'CN'}),calls=[];
 const body={offer_id:['existing-offer']};
 const result=await callOzonProductInfo(original,body,1000,{},async(c,path,b)=>{calls.push({route:c.ozonRoute,path,body:b});if(c.ozonRoute==='CN')throw Object.assign(Error('502'),{status:502,code:'ZONGZI_HTTP_502'});return {items:[]};});
 assert.deepEqual(result,{items:[]});assert.deepEqual(calls.map(x=>x.route),['CN','RU']);assert.ok(calls.every(x=>x.path==='/v3/product/info/list'&&x.body===body));assert.equal(original.ozonRoute,'CN');
 for(const code of ['ZONGZI_NETWORK_ERROR','ZONGZI_TIMEOUT','ZONGZI_HTTP_403']){
  let count=0;await assert.rejects(callOzonProductInfo(original,body,1000,{},async()=>{count++;throw Object.assign(Error('read failed'),{status:code.endsWith('403')?403:502,code});}));assert.equal(count,1);
 }
});

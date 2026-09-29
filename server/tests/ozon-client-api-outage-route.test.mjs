import test from 'node:test';
import assert from 'node:assert/strict';
import {ozonApiBase,callOzonSellerApi,getOzonSellerApi} from '../ozon-client.mjs';
import {ozonRouteSettings} from '../account-ozon-route.mjs';

const credential=Object.freeze({clientId:'same-client',apiKey:'same-api-key',ozonRoute:'CN'});
const readPaths=['/v1/roles','/v1/seller/info','/v2/warehouse/list','/v3/product/list','/v3/product/info/list',
 '/v5/product/info/prices','/v2/analytics/stock_on_warehouses','/v2/product/info/stocks-by-warehouse/fbs',
 '/v4/posting/fbs/list','/v3/posting/fbo/list','/v3/chat/list','/v3/chat/history','/v4/product/info/limit',
 '/v1/description-category/tree','/v1/product/import/info'];
const writePaths=['/v3/product/import','/v2/products/stocks','/v2/product/pictures/import','/v1/chat/start',
 '/v1/chat/send/message','/v1/actions/products/update','/v2/actions/products/deactivate','/v2/actions/auto-add/products/delete',
 '/v1/product/import/prices','/v1/product/action/timer/update'];

test('all CN Seller API reads and first writes select RU before their single request; account and Seller page remain CN',async()=>{
 const calls=[],original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response('{}');};
 try{
  for(const path of [...readPaths,...writePaths])await callOzonSellerApi(credential,path,{fixture:true});
  await getOzonSellerApi(credential,'/v1/actions');
  assert.equal(calls.length,readPaths.length+writePaths.length+1);
  for(const {url,options} of calls){
   assert.equal(new URL(url).origin,'https://api-seller.ozon.ru');
   assert.equal(options.headers['Client-Id'],'same-client');assert.equal(options.headers['Api-Key'],'same-api-key');
  }
  assert.deepEqual(calls.map(c=>new URL(c.url).pathname),[...readPaths,...writePaths,'/v1/actions']);
  assert.equal(calls.at(-1).options.method,'GET');
  assert.equal(credential.ozonRoute,'CN');assert.equal(ozonRouteSettings('CN').sellerOrigin,'https://seller.ozonru.cn');
 }finally{globalThis.fetch=original;}
});

test('a RU HTTP 502 or lost write response is returned once and never retried on either host',async()=>{
 const original=globalThis.fetch;
 try{
  for(const failure of ['http','network']){
   const urls=[];globalThis.fetch=async url=>{
    urls.push(url);if(failure==='network')throw new TypeError('lost response');
    return new Response('bad gateway',{status:502});
   };
   await assert.rejects(callOzonSellerApi(credential,'/v3/product/import',{items:[{offer_id:'saved-offer'}]}),
    failure==='http'?{status:502,code:'ZONGZI_HTTP_502'}:{status:502,code:'ZONGZI_NETWORK_ERROR'});
   assert.deepEqual(urls,['https://api-seller.ozon.ru/v3/product/import']);
  }
 }finally{globalThis.fetch=original;}
});

test('an explicit RU credential is unchanged',()=>{
 assert.equal(ozonApiBase({...credential,ozonRoute:'RU'}),'https://api-seller.ozon.ru');
});

test('default CN API origin uses RU while LEGACY and local stub overrides remain exact',async()=>{
 const before=process.env.OZON_API_BASE;
 try{
  process.env.OZON_API_BASE='https://api-seller.ozonru.cn';
  const cn=await import('../ozon-client.mjs?outage-default-cn');
  assert.equal(cn.ozonApiBase({clientId:'legacy-unpinned'}),'https://api-seller.ozon.ru');
  assert.equal(cn.ozonApiBase({ozonRoute:'CN'}),'https://api-seller.ozon.ru');
  assert.equal(cn.ozonApiBase({ozonRoute:'LEGACY'}),'https://api-seller.ozonru.cn');
  for(const base of ['http://localhost:4001','http://127.0.0.1:4002','http://[::1]:4003']){
   process.env.OZON_API_BASE=base;const local=await import(`../ozon-client.mjs?outage-stub=${encodeURIComponent(base)}`);
   for(const route of ['CN','RU','LEGACY'])assert.equal(local.ozonApiBase({ozonRoute:route}),base);
  }
  process.env.OZON_API_BASE='https://custom-proxy.example.test';
  const custom=await import('../ozon-client.mjs?outage-custom');
  assert.equal(custom.ozonApiBase({}),'https://custom-proxy.example.test');
  assert.equal(custom.ozonApiBase({ozonRoute:'LEGACY'}),'https://custom-proxy.example.test');
  assert.equal(custom.ozonApiBase({ozonRoute:'CN'}),'https://api-seller.ozon.ru');
 }finally{if(before===undefined)delete process.env.OZON_API_BASE;else process.env.OZON_API_BASE=before;}
});

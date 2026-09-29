import test from 'node:test';
import assert from 'node:assert/strict';
import {readAiListingStoreQuota,createAiListingStoreRouting} from '../ai-listing-store-routing.mjs';
import {createAiListingService} from '../ai-listing-service.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

const quota={daily_create:{limit:100,usage:0},total:{limit:1000,usage:5}};
const credential=Object.freeze({clientId:'fixture-seller',apiKey:'fixture-key',ozonRoute:'CN'});
const badGateway=()=>Object.assign(new Error('fixture HTTP 502'),{status:502,code:'ZONGZI_HTTP_502'});
const items=[{sku:'one',images:['https://source.test/one'],listingItem:{offer_id:'one',name:'Product',price:'20',currency_code:'RUB',description_category_id:10,type_id:20,weight:200,depth:100,width:110,height:120}}];
const source={collectItemId:'collected',sku:'one',sourceSnapshot:{currency:'RUB',price:'20'},items};
const config={targetStoreId:'store',targetWarehouseId:'warehouse',ozonRoute:'CN',brandMode:'PREFER_SOURCE',stock:5,priceMultiplier:'1',priceAdjustmentKopecks:0};
function routeFixture(fetchFn,{now=()=>1000,pending=[]}={}){
 const client={release(){},async query(sql){return {rows:sql.startsWith('SELECT body')?pending:[{locked:true}]};}};
 return createAiListingStoreRouting({pool:{connect:async()=>client},clock:now,
  validateTarget:async()=>({store:{currencyCode:'RUB'}}),readCredential:async(storeId,accountId)=>{
   assert.equal(storeId,'store');assert.equal(accountId,'account');return credential;
  },fetchFn});
}
function quotaFetch(seen,{ruQuota=quota,ruStatus=200,cnStatus=502}={}){
 return async(url,options)=>{
  seen.push(url);
  assert.equal(new URL(url).pathname,'/v4/product/info/limit');
  assert.deepEqual(options.headers,{'Client-Id':'fixture-seller','Api-Key':'fixture-key','Content-Type':'application/json'});
  assert.equal(options.body,'{}');assert.equal(options.method,'POST');
  const status=new URL(url).hostname==='api-seller.ozonru.cn'?cnStatus:ruStatus;
  return {status,ok:status===200,json:async()=>ruQuota};
 };
}

test('UI quota reads CN HTTP 502 through RU once without changing the account credential',async()=>{
 const calls=[];
 const result=await readAiListingStoreQuota({accountId:'account',storeId:'store',readCredential:async()=>credential,
  call:async(c,path,body,timeout)=>{
   calls.push({route:c.ozonRoute,path});assert.equal(c.clientId,credential.clientId);assert.equal(c.apiKey,credential.apiKey);
   assert.deepEqual(body,{});assert.equal(timeout,15000);
   if(c.ozonRoute==='CN')throw badGateway();return quota;
  }});
 assert.deepEqual(result,{storeId:'store',remaining:100});
 assert.deepEqual(calls,[{route:'CN',path:'/v4/product/info/limit'},{route:'RU',path:'/v4/product/info/limit'}]);
 assert.equal(credential.ozonRoute,'CN');
});

for(const [label,route,error] of [
 ['authorization 401','CN',{status:401,code:'ZONGZI_HTTP_401'}],
 ['permission 403','CN',{status:403,code:'ZONGZI_HTTP_403'}],
 ['business 422','CN',{status:422,code:'ZONGZI_HTTP_422'}],
 ['rate limit','CN',{status:429,code:'ZONGZI_HTTP_429'}],
 ['network wrapped as 502','CN',{status:502,code:'ZONGZI_NETWORK_ERROR'}],
 ['timeout','CN',{status:504,code:'ZONGZI_TIMEOUT'}],
 ['non-502 upstream failure','CN',{status:503,code:'ZONGZI_HTTP_503'}],
 ['already Russian route','RU',{status:502,code:'ZONGZI_HTTP_502'}],
 ['legacy route','LEGACY',{status:502,code:'ZONGZI_HTTP_502'}],
])test(`quota does not switch routes for ${label}`,async()=>{
 const routes=[];
 await assert.rejects(readAiListingStoreQuota({accountId:'account',storeId:'store',readCredential:async()=>({...credential,ozonRoute:route}),
  call:async(c)=>{routes.push(c.ozonRoute);throw Object.assign(new Error(label),error);}}),{statusCode:502});
 assert.deepEqual(routes,[route]);
});

test('a successful CN response stays on CN, including incomplete quota data',async()=>{
 for(const value of [quota,{}]){
  const routes=[],request=readAiListingStoreQuota({accountId:'account',storeId:'store',readCredential:async()=>credential,
   call:async c=>{routes.push(c.ozonRoute);return value;}});
  if(value===quota)assert.equal((await request).remaining,100);else await assert.rejects(request,{statusCode:502});
  assert.deepEqual(routes,['CN']);
 }
});


test('target validation no longer depends on either quota route or legacy reservations',async()=>{
 const seen=[],task={accountId:'account',id:'task',config:structuredClone(config),source:structuredClone(source)};
 const before=structuredClone(task),commits=[];
 const result=await routeFixture(quotaFetch(seen,{ruStatus:502}))({task,commit:async(target,reservation)=>commits.push({target,reservation})});
 assert.equal(result.selected,true);assert.equal(commits.length,1);assert.equal(commits[0].reservation,undefined);
 assert.deepEqual(seen,[]);assert.deepEqual(task,before);assert.equal(credential.ozonRoute,'CN');
});

test('a legacy generation wait resumes the same task without querying quota on either route',async()=>{
 let now=1000,generated=0;const seen=[],repository=memoryRepository();
 const routeStores=routeFixture(quotaFetch(seen,{ruStatus:502}));
 const service=createAiListingService({repository,clock:()=>now,readOzonRoute:async()=> 'CN',loadSources:async()=>[structuredClone(source)],routeStores,
  generateImage:async()=>{generated++;return {generatedUrl:'https://generated.test/one'};}});
 const [task]=await service.createFromCollect({accountId:'account',collectItemIds:['collected'],idempotencyKey:'original',config:{...config,manualReview:true}});
 const row=repository.rows.get(task.id);row.quotaWait={code:'QUOTA_UNAVAILABLE',retryAt:61000};row.generationStage='waiting_quota';
 const result=await service.processNext({phase:'generate'});
 assert.equal(result.id,task.id);assert.equal(result.status,'AWAITING_REVIEW');assert.equal(result.quotaWait,undefined);
 assert.equal(result.config.ozonRoute,'CN');assert.equal(generated,1);assert.equal(repository.rows.size,1);assert.deepEqual(seen,[]);
});

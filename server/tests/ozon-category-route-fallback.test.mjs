import assert from 'node:assert/strict';
import test from 'node:test';
import {createOzonCategoryService} from '../ozon-category-service.mjs';

const store={id:'store-a',ownerAccountId:'account-a',clientId:'client',apiKey:'secret',ozonRoute:'CN'};
const scope={accountId:'account-a',store,language:'DEFAULT',descriptionCategoryId:10,typeId:20,attributeId:30};
const tree={result:[{description_category_id:10,category_name:'Home',children:[{type_id:20,type_name:'Cup',children:[]}]}]};

test('CN category reads fall back to RU with the same credentials and preserve the configured route',async()=>{
  const calls=[];
  const api=createOzonCategoryService({callOzonSellerApi:async(target,path,body)=>{
    calls.push({route:target.ozonRoute,path,body});
    assert.equal(target.clientId,store.clientId);assert.equal(target.apiKey,store.apiKey);
    if(target.ozonRoute==='CN')throw Object.assign(new Error('upstream'),{status:502,code:'ZONGZI_HTTP_502'});
    if(path.endsWith('/tree'))return tree;
    return {result:[{id:30,name:'Brand',value:'Нет бренда'}],has_next:false};
  }});
  assert.equal((await api.getCategoryTree(scope)).items.length,1);
  await api.getCategoryAttributes(scope);
  await api.getCategoryAttributeValues({...scope,limit:1});
  await api.searchCategoryAttributeValuesExact({...scope,value:'Нет бренда'});
  assert.deepEqual(calls.map(x=>x.route),['CN','RU','CN','RU','CN','RU','CN','RU']);
  for(let i=0;i<calls.length;i+=2){assert.equal(calls[i].path,calls[i+1].path);assert.deepEqual(calls[i].body,calls[i+1].body);}
  assert.equal(store.ozonRoute,'CN');
  await api.getCategoryTree(scope);assert.equal(calls.length,8);
});

test('healthy CN and explicitly selected RU never try another route',async()=>{
  for(const route of ['CN','RU']){
    const calls=[];const api=createOzonCategoryService({callOzonSellerApi:async target=>{calls.push(target.ozonRoute);return tree;}});
    await api.getCategoryTree({...scope,store:{...store,ozonRoute:route}});assert.deepEqual(calls,[route]);
  }
});

test('missing CN category data and transport failure can recover through RU',async()=>{
  for(const failure of [null,Object.assign(new Error('network'),{code:'ZONGZI_NETWORK_ERROR'})]){
    const calls=[];const api=createOzonCategoryService({callOzonSellerApi:async target=>{
      calls.push(target.ozonRoute);if(target.ozonRoute==='CN'){if(failure)throw failure;return {result:[]};}return tree;
    }});
    assert.equal((await api.getCategoryTree(scope)).items.length,1);assert.deepEqual(calls,['CN','RU']);
  }
});

test('authorization failure and explicit cancellation do not trigger route fallback',async()=>{
  const calls=[];const api=createOzonCategoryService({callOzonSellerApi:async target=>{calls.push(target.ozonRoute);throw Object.assign(new Error('forbidden'),{status:403,code:'ZONGZI_HTTP_403'});}});
  await assert.rejects(api.getCategoryTree(scope),e=>e.diagnostic.sourceStatus===403&&!e.diagnostic.retryable);assert.deepEqual(calls,['CN']);
  const controller=new AbortController();const routes=[];const stopped=createOzonCategoryService({callOzonSellerApi:async target=>{routes.push(target.ozonRoute);controller.abort();throw Object.assign(new Error('aborted'),{code:'ZONGZI_TIMEOUT',status:504});}});
  await assert.rejects(stopped.getCategoryTree({...scope,signal:controller.signal}));assert.deepEqual(routes,['CN']);
});

test('a failed RU fallback preserves the recoverable CN failure for the next automatic check',async()=>{
  const routes=[];const api=createOzonCategoryService({callOzonSellerApi:async target=>{
    routes.push(target.ozonRoute);
    throw Object.assign(new Error('unavailable'),target.ozonRoute==='CN'?{status:502,code:'ZONGZI_HTTP_502'}:{status:403,code:'ZONGZI_HTTP_403'});
  }});
  await assert.rejects(api.getCategoryTree(scope),e=>e.diagnostic.sourceStatus===502&&e.diagnostic.retryable);
  assert.deepEqual(routes,['CN','RU','CN','RU','CN','RU']);
});

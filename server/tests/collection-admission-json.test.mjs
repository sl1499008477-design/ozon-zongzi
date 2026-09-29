import assert from 'node:assert/strict';
import test from 'node:test';
import {createJsonAccountScopedCollectionHandler} from '../account-scoped-collection-routes.mjs';
function fixture(reject=false){
  let state={caches:{collectBox:[]},collectRequests:[]},writing=false,checks=0,saves=0;
  const handler=createJsonAccountScopedCollectionHandler({authenticate:async()=>({id:'account'}),readJson:async req=>req.body,
    normalizeItem:item=>item,loadState:async()=>structuredClone(state),saveState:async next=>{state=structuredClone(next);saves++;},
    stateTransaction:{async run(fn){writing=true;try{return await fn();}finally{writing=false;}}},
    enqueueForCollect:async()=>{},completeLinkedJobsFromCollectEvidence:async()=>{},countAccountItems:s=>s.caches.collectBox.length,
    sendJson:(res,status,body)=>Object.assign(res,{status,body}),sendError:(res,status,message,code)=>Object.assign(res,{status,body:{message,code}}),
    checkAdmission:async({item})=>{assert.equal(writing,false);checks++;if(reject)throw Object.assign(new Error('平台禁售'),{status:422,code:'PRODUCT_RESTRICTION_BLOCK'});return {...item,collectionAdmission:{status:'PASSED'}};}});
  async function collect(requestId='first',name='Товар'){
    const res={};await handler({method:'POST',body:{sourceSku:'1234567',requestId,payload:{sku:'1234567',name,
      description_category_id:123,type_id:456,weightG:1,lengthMm:1,widthMm:1,heightMm:1}}},res,new URL('http://test/sources/ozon/collect'),state);return res;
  }
  return {collect,snapshot:()=>({state,checks,saves})};
}
test('JSON extension admission precedes its state transaction and new captures preserve existing facts and audit',async()=>{
  const f=fixture();assert.equal((await f.collect()).status,200);assert.equal(f.snapshot().checks,1);
  assert.equal((await f.collect('second','Другое')).status,200);
  assert.equal(f.snapshot().checks,2);assert.equal(f.snapshot().state.caches.collectBox[0].name,'Товар');
  assert.equal(f.snapshot().state.collectRequests.length,2);
  assert.equal(f.snapshot().state.collectRequests[1].rawEvidence.payload.name,'Другое');
  assert.equal((await f.collect('second','Другое')).status,200);
  assert.equal(f.snapshot().checks,2,'identical request replay must not call admission');
});
test('JSON extension does not save a prohibited collection result',async()=>{
  const f=fixture(true);assert.equal((await f.collect()).body.code,'PRODUCT_RESTRICTION_BLOCK');
  assert.equal(f.snapshot().saves,0);assert.equal(f.snapshot().state.caches.collectBox.length,0);
});

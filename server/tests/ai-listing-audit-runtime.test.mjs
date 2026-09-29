import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAiListingSource,createAiListingRuntime} from '../ai-listing-runtime.mjs';
import {createAiListingRepository} from '../ai-listing-repository.mjs';
import * as ocr from '../ai-listing-ocr.mjs';

test('frozen category stays with each SKU independently of the collection record',()=>{
  const categoryResolution={status:'ACTIVE',currentDescriptionCategoryId:100,currentTypeId:200};
  const original={id:'collect',sku:'1',images:['https://source/1'],categoryResolution};
  const result=buildAiListingSource(original,'store',()=>[{scraped_sku:'1'}]);
  categoryResolution.currentTypeId=300;
  assert.equal(result.items[0].categoryResolution.currentTypeId,200);
});
test('completed task page is scoped to account and actual submission store and omits full bodies',async()=>{
  const calls=[];const repo=createAiListingRepository({pool:{async query(sql,values){calls.push({sql,values});return {rows:sql.includes('COUNT(*)')?[{total:1}]:[{id:'t',summary:{id:'t',status:'COMPLETED'}}]};}}});
  const page=await repo.listPage({accountId:'a',view:'completed',storeId:'s',limit:10,offset:20});
  assert.equal(page.total,1);assert.equal(page.offset,20);
  assert.ok(calls.every(c=>c.values[0]==='a'));
  const query=calls.find(c=>c.sql.includes('AS summary'));
  assert.match(query.sql,/submissionTarget/);assert.doesNotMatch(query.sql,/SELECT \*/);
});
test('grid capability distinguishes unsupported platform, missing Swift and available Swift',async()=>{
  assert.equal((await ocr.listingOcrCapability({platform:'win32'})).available,false);
  assert.equal((await ocr.listingOcrCapability({platform:'darwin',probe:async()=>{throw Error('missing');}})).available,false);
  assert.equal((await ocr.listingOcrCapability({platform:'darwin',probe:async()=>{}})).available,true);
});
test('temporary RFBS validation failure is actionable and cannot create or charge a task',async()=>{
  const runtime=createAiListingRuntime({
    authenticate:async()=>({id:'a',role:'admin',status:'active'}),
    resolvePool:async()=>({query:async()=>({rows:[]})}),
    repository:{create:async()=>{throw Error('must not create');}},generateImage:async()=>{throw Error('must not generate');},
    validateTarget:async()=>{throw Object.assign(new Error('RFBS 仓库需要重新验证'),{code:'RFBS_VALIDATION_REQUIRED',retryable:true});},
    readJson:async()=>({config:{targetStoreId:'s',targetWarehouseId:'w'},collectItemIds:['c']}),
    sendJson:(res,status,body)=>Object.assign(res,{status,body}),
  });
  const res={};await runtime.handleRoute({method:'POST'},res,new URL('http://localhost/api/ai-listing/tasks/from-collect-box'));
  assert.equal(res.status,503);assert.equal(res.body.code,'RFBS_VALIDATION_REQUIRED');
  assert.match(res.body.message,/仓库.*稍后/);
});


test('task group is applied before pagination and count remains account scoped',async()=>{
 const calls=[];const repo=createAiListingRepository({pool:{async query(sql,values){calls.push({sql,values});return {rows:sql.includes('COUNT(*)')?[{total:8,active:3,failed:2,errors:1,cancelled:2}]:[]};}}});
 const page=await repo.listPage({accountId:'a',group:'failed',limit:1,offset:1});
 assert.equal(page.total,2);assert.equal(page.counts.all,8);assert.equal(page.counts.active,3);
 const query=calls.find(c=>c.sql.includes('AS summary'));assert.match(query.sql,/\$5/);assert.equal(query.values[4],'failed');assert.equal(query.values[0],'a');
});

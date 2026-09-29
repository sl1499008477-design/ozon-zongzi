import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService} from '../ai-listing-service.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

for(const action of ['pause','cancel'])test(`${action} before a healthy sibling paid request still fences work after an unknown result`,async()=>{
  const repository=memoryRepository(),paid=[];
  const source={collectItemId:'mixed',sku:'unknown',name:'Mixed product',items:['unknown','healthy'].map(sku=>({sku,
    images:[`https://source.test/${sku}.png`],
    listingItem:{offer_id:sku,name:sku,price:'12.34',weight:250,depth:120,width:130,height:140}}))};
  let task;
  const service=createAiListingService({repository,clock:()=>1000,loadSources:async()=>[structuredClone(source)],
    reserveChannel:async()=>({channelId:'reserved',productToken:'token',release:async()=>{}}),
    generateImage:async input=>{
      if(input.sku==='unknown')throw Object.assign(new Error('unknown provider result'),{
        code:'RETRYABLE_GATEWAY',deliveryState:'POSSIBLY_SENT'});
      // Both production image ports call this optional hook after local source preparation.
      await service[`${action}Task`]({accountId:'a',taskId:task.id});
      await input.beforeRequest?.();
      paid.push(input.sku);
      return {generatedUrl:'https://generated.test/healthy.png'};
    },
  });
  [task]=await service.createFromCollect({accountId:'a',collectItemIds:['mixed'],idempotencyKey:`mixed-${action}`,
    config:{targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:true}});
  const result=await service.processNext();
  assert.deepEqual(paid,[],'a stop during sibling preparation must prevent a new paid request');
  assert.equal(result.status,action==='pause'?'PAUSED':'CANCELLED');
  assert.equal(result.skuProgress.find(row=>row.sku==='unknown').status,'RESULT_UNKNOWN');
  const healthy=repository.rows.get(task.id).images.find(image=>image.sku==='healthy');
  assert.equal(healthy.generatedUrl,null);
  assert.equal(healthy.attempts,0,'the request was not sent');
});

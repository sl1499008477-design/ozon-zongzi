import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService} from '../ai-listing-service.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

for(const blocked of ['SKIPPED','RESULT_UNKNOWN'])test(`separate worker phases ${blocked==='SKIPPED'?'preserve explicit pricing skips':'hold the whole product for an unknown image result'}`,async()=>{
 const source={collectItemId:'collect-mixed',sku:'blocked',name:'Mixed product',items:['blocked','healthy'].map(sku=>({sku,
  images:[`https://source.test/${sku}.png`],listingItem:{offer_id:sku,name:sku,price:'12.34',weight:250,depth:120,width:130,height:140}}))};
 const repository=memoryRepository(),calls=[],submissions=[],writes=[];
 let now=1000;
 const service=createAiListingService({repository,clock:()=>now,loadSources:async()=>[structuredClone(source)],
  checkSource:async({source})=>({...source,skuPricing:source.items.map(item=>({sku:item.sku,
   status:item.sku==='blocked'&&blocked==='SKIPPED'?'SKIPPED':'READY',reason:'缺少绿标价'}))}),
  generateImage:async input=>{
   calls.push(input.sku);
   if(input.sku==='blocked')throw Object.assign(new Error('unknown provider result'),{code:'RETRYABLE_GATEWAY',deliveryState:'POSSIBLY_SENT'});
   return {generatedUrl:'https://generated.test/healthy.png'};
  },
  submitListing:async input=>{submissions.push({skus:input.source.items.map(item=>item.sku),deferImport:input.deferImport});return {submissionId:'mixed-submission'};},
  readSubmission:async input=>{await input.beforeExternalWrite();writes.push(input.submissionId);return {status:'COMPLETED',
   items:[{sku:'healthy',importStatus:'SUCCEEDED',stockStatus:'COMPLETED'}]};},
 });
 const [task]=await service.createFromCollect({accountId:'a',collectItemIds:['collect-mixed'],idempotencyKey:'mixed-'+blocked,
  config:{targetStoreId:'store',targetWarehouseId:'warehouse'}});
 const generated=await service.processNext({phase:'generate'});
 if(blocked==='RESULT_UNKNOWN'){
  assert.equal(generated.status,'GENERATION_FAILED');
  assert.equal(generated.skuProgress.find(item=>item.sku==='blocked').status,'RESULT_UNKNOWN');
  assert.equal(generated.skuProgress.find(item=>item.sku==='healthy').status,'READY');
  assert.equal(await service.processNext({phase:'media'}),null);assert.equal(await service.processNext({phase:'finalize'}),null);
  assert.deepEqual(calls,['blocked','healthy']);assert.deepEqual(submissions,[]);assert.deepEqual(writes,[]);return;
 }
 assert.equal(generated.status,'READY_TO_SUBMIT');
 assert.equal(await service.processNext({phase:'generate'}),null,'remaining blocked images cannot reclaim a submission task');
 const prepared=await service.processNext({phase:'media'});
 assert.equal(prepared?.status,'READY_TO_SUBMIT');
 assert.deepEqual(submissions,[{skus:['healthy'],deferImport:true}]);
 assert.equal(await service.processNext({phase:'media'}),null,'prepared media belongs to the finalize worker');
 now+=30000;
 const finalized=await service.processNext({phase:'finalize'});
 assert.equal(finalized?.id,task.id);
 assert.equal(finalized.status,blocked==='SKIPPED'?'COMPLETED':'GENERATION_FAILED');
 assert.equal(finalized.skuProgress.find(item=>item.sku==='blocked').status,blocked);
 assert.equal(finalized.skuProgress.find(item=>item.sku==='healthy').status,'COMPLETED');
 assert.deepEqual(calls,blocked==='SKIPPED'?['healthy']:['blocked','healthy']);
 assert.deepEqual(writes,['mixed-submission']);
});

test('a retained legacy GRID with followers retries locally without an image channel',async()=>{
 const source={collectItemId:'retained',sku:'s',name:'Retained product',items:[{sku:'s',images:['https://source.test/1.png','https://source.test/2.png'],
  listingItem:{offer_id:'s',name:'s',price:'12.34',weight:250,depth:120,width:130,height:140}}]};
 const repository=memoryRepository();let slices=0,reservations=0,needsImageChannel;
 const service=createAiListingService({repository,clock:()=>1000,loadSources:async()=>[structuredClone(source)],
  reserveChannel:async()=>{reservations++;throw Object.assign(new Error('no channel'),{code:'AI_GATEWAY_NO_CAPACITY'});},
  generateImageGroup:async input=>{slices++;assert.equal(input.mustReusePaidResult,true);return {images:input.sources.map(row=>({sku:input.sku,index:row.index,generatedUrl:`https://generated.test/${row.index}.png`}))};},
 });
 const [task]=await service.createFromCollect({accountId:'a',collectItemIds:['retained'],idempotencyKey:'retained',
  config:{targetStoreId:'store',targetWarehouseId:'warehouse',generationMode:'GRID',manualReview:true}});
 const row=repository.rows.get(task.id);row.status='GENERATION_FAILED';
 Object.assign(row.images[0],{status:'GENERATION_FAILED',attempts:1,lastError:{code:'AI_LISTING_GRID_GEOMETRY_INVALID'}});
 await service.retryTask({accountId:'a',taskId:task.id},{beforeRetry:async(_task,options)=>{needsImageChannel=options.needsImageChannel;}});
 const result=await service.processNext({phase:'generate'});
 assert.equal(needsImageChannel,false,'unrequested follower slots belong to the retained leader result');
 assert.equal(reservations,0);assert.equal(slices,1);assert.equal(result.status,'AWAITING_REVIEW');
});

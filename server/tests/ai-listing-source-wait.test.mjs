import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService} from '../ai-listing-service.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

const unavailable=(sourceStatus,sourceCode,retryable)=>Object.assign(new Error('private upstream response'),{
  code:'ZONGZI_CATEGORY_TREE_UNAVAILABLE',status:502,diagnostic:{sourceStatus,sourceCode,retryable},
});
async function fixture(checkSource){
  const repository=memoryRepository(),calls={billing:0,channel:0,images:0};let now=1000;
  const source={collectItemId:'collect',sku:'sku',name:'Product',items:[{sku:'sku',images:['https://source.test/1.png'],
    listingItem:{offer_id:'sku',name:'Product',price:'12.34',weight:250,depth:120,width:130,height:140}}]};
  const service=createAiListingService({repository,clock:()=>now,loadSources:async()=>[structuredClone(source)],checkSource,
    billing:{reconcile:async()=>{calls.billing++;return {funded:true};}},
    reserveChannel:async()=>{calls.channel++;return {channelId:'channel',productToken:'token',release:async()=>{}};},
    generateImage:async()=>{calls.images++;const saved=[...repository.rows.values()][0];
      assert.notEqual(saved.generationStage,'waiting_source');assert.equal(saved.errorMessage,null);
      return {generatedUrl:'https://generated.test/1.png'};},
  });
  const [task]=await service.createFromCollect({accountId:'account',collectItemIds:['collect'],idempotencyKey:'source-wait',
    config:{targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:true}});
  return {repository,service,calls,task,advance:ms=>{now+=ms;}};
}

test('temporary category failure releases the lease, waits without paid work, then generates each image once',async()=>{
  let available=false;
  const f=await fixture(async({source})=>{if(!available)throw unavailable(503,'ZONGZI_HTTP_503',true);return source;});
  const waiting=await f.service.processNext({phase:'generate'});
  assert.equal(waiting.status,'GENERATING');assert.equal(waiting.generationStage,'waiting_source');
  assert.match(waiting.errorMessage,/等待.*Ozon.*类目/);assert.doesNotMatch(waiting.errorMessage,/private upstream/);
  const saved=f.repository.rows.get(f.task.id);
  assert.equal(saved.nextRunAt,61000);assert.equal(saved.leaseToken,null);assert.equal(saved.leaseExpiresAt,null);
  assert.deepEqual(f.calls,{billing:0,channel:0,images:0});
  available=true;f.advance(59999);assert.equal(await f.service.processNext({phase:'generate'}),null);
  f.advance(1);const result=await f.service.processNext({phase:'generate'});
  assert.equal(result.status,'AWAITING_REVIEW');assert.equal(result.errorMessage,null);
  assert.equal(result.generationStage,undefined);assert.equal(f.calls.images,1);
  f.advance(90000);assert.equal(await f.service.processNext({phase:'generate'}),null);assert.equal(f.calls.images,1);
});

test('wrapped category authorization and missing-credential failures stop with an actionable message',async()=>{
  for(const [status,code] of [[401,'ZONGZI_HTTP_401'],[403,'ZONGZI_HTTP_403'],[400,'ZONGZI_CREDENTIALS_MISSING']]){
    const f=await fixture(async()=>{throw unavailable(status,code,false);});
    const result=await f.service.processNext({phase:'generate'});
    assert.equal(result.status,'GENERATION_FAILED');assert.match(result.errorMessage,/店铺.*(?:授权|API Key)/);
    assert.doesNotMatch(result.errorMessage,/private upstream/);
    assert.equal(f.repository.rows.get(f.task.id).leaseToken,null);
    f.advance(90000);assert.equal(await f.service.processNext({phase:'generate'}),null);
    assert.equal(f.calls.channel,0);assert.equal(f.calls.images,0);
  }
});

test('pause requested during a failed source read wins over the waiting checkpoint',async()=>{
  let f;f=await fixture(async()=>{
    const pending=await f.service.pauseTask({accountId:'account',taskId:f.task.id});
    assert.equal(pending.controlAction,'pause');throw unavailable(429,'ZONGZI_HTTP_429',true);
  });
  const result=await f.service.processNext({phase:'generate'});
  assert.equal(result.status,'PAUSED');assert.equal(result.controlAction,null);
  assert.equal(f.repository.rows.get(f.task.id).leaseToken,null);
  f.advance(90000);assert.equal(await f.service.processNext({phase:'generate'}),null);
  assert.equal(f.calls.channel,0);assert.equal(f.calls.images,0);
});

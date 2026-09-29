import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService} from '../ai-listing-service.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

async function fixture(status='SUBMISSION_FAILED') {
  const repository=memoryRepository();
  const source={collectItemId:'collect',sku:'sku',name:'Saved product',sourceSnapshot:{source:'ozon'},items:[{
    sku:'sku',images:['https://source.invalid/image.png'],listingItem:{offer_id:'原货号',name:'Original name',weight:100,depth:100,width:100,height:100},
  }]};
  const service=createAiListingService({repository,clock:()=>1000,loadSources:async()=>[structuredClone(source)],
    generateImage:async()=>assert.fail('Restoring a deleted task must not generate'),
    submitListing:async()=>assert.fail('Restoring a deleted task must not submit')});
  const [created]=await service.createFromCollect({accountId:'account',collectItemIds:['collect'],idempotencyKey:'original',
    config:{targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:false}});
  const row=repository.rows.get(created.id);row.status=status;
  if(status==='SUBMISSION_FAILED'){
    Object.assign(row,{submissionId:'original-submission',submissionStarted:true,submissionExternalWriteStarted:true,
      submissionResults:[{sku:'sku',offerId:'原货号',importStatus:'SUCCEEDED',stockStatus:'FAILED',publicationStatus:'REJECTED'}]});
    row.images.forEach(image=>Object.assign(image,{status:'COMPLETED',generatedUrl:'https://saved.invalid/image.png'}));
  }
  await service.deleteTask({accountId:'account',taskId:created.id,expectedVersion:row.version});
  return {service,repository,id:created.id,deleted:structuredClone(repository.rows.get(created.id))};
}

test('deleted imported-but-rejected task restores its original failure and allows revision without regenerating',async()=>{
  const f=await fixture();
  const restored=await f.service.resumeTask({accountId:'account',taskId:f.id,expectedVersion:f.deleted.version});
  assert.equal(restored.id,f.id);assert.equal(restored.status,'SUBMISSION_FAILED');assert.equal(restored.deletedAt,null);
  const row=f.repository.rows.get(f.id);
  for(const key of ['submissionId','submissionKey','source','images','submissionResults'])assert.deepEqual(row[key],f.deleted[key]);
  assert.equal(await f.service.processNext(),null);
  const revised=await f.service.reviseAndRetryTask({accountId:'account',taskId:f.id,expectedVersion:restored.version,
    revisions:[{sku:'sku',name:'Исправленное название'}]});
  assert.equal(revised.status,'READY_TO_SUBMIT');assert.equal(revised.submissionId,'original-submission');
  assert.equal(f.repository.rows.get(f.id).source.items[0].listingItem.offer_id,'原货号');
  assert.deepEqual(f.repository.rows.get(f.id).images,f.deleted.images);
});

test('deleted unfinished task is restored paused and requires another explicit resume before running',async()=>{
  const f=await fixture('GENERATING');
  const restored=await f.service.resumeTask({accountId:'account',taskId:f.id,expectedVersion:f.deleted.version});
  assert.equal(restored.status,'PAUSED');assert.equal(await f.service.processNext(),null);
  assert.equal((await f.service.resumeTask({accountId:'account',taskId:f.id,expectedVersion:restored.version})).status,'GENERATING');
});

test('deleted tasks require owned versioned restore; their detail is read-only and uncertain submissions stay protected',async()=>{
  const f=await fixture();
  await assert.rejects(f.service.getTask({accountId:'account',taskId:f.id}),{statusCode:404});
  const detail=await f.service.getTask({accountId:'account',taskId:f.id,includeDeleted:true});
  assert.equal(detail.deletedAt,1000);assert.equal(detail.taskActions.resume,true);
  assert.deepEqual(Object.entries(detail.taskActions).filter(([,allowed])=>allowed).map(([action])=>action),['resume','permanentDelete']);
  await assert.rejects(f.service.getTask({accountId:'other',taskId:f.id,includeDeleted:true}),{statusCode:404});
  await assert.rejects(f.service.resumeTask({accountId:'other',taskId:f.id,expectedVersion:f.deleted.version}),{statusCode:404});
  await assert.rejects(f.service.resumeTask({accountId:'account',taskId:f.id}),{code:'AI_LISTING_INVALID_INPUT'});
  await assert.rejects(f.service.resumeTask({accountId:'account',taskId:f.id,expectedVersion:f.deleted.version-1}),{statusCode:409});
  assert.deepEqual(f.repository.rows.get(f.id),f.deleted);
  f.repository.rows.get(f.id).stoppedFrom='SUBMISSION_UNCERTAIN';
  const unknown=await f.service.getTask({accountId:'account',taskId:f.id,includeDeleted:true});
  assert.equal(unknown.taskActions.permanentDelete,true);assert.equal(unknown.taskActions.resume,true);
  const restored=await f.service.resumeTask({accountId:'account',taskId:f.id,expectedVersion:f.deleted.version});
  assert.equal(restored.status,'SUBMISSION_UNCERTAIN');assert.equal(await f.service.processNext(),null);
});

test('deleted batch preview and receipts restore only the confirmed versions',async()=>{
  const f=await fixture();
  const preview=await f.service.previewTaskAction({accountId:'account',group:'deleted',action:'resume'});
  assert.deepEqual(preview.items,[{taskId:f.id,expectedVersion:f.deleted.version}]);
  const result=await f.service.batchTaskAction({accountId:'account',action:'resume',items:preview.items});
  assert.equal(result.applied,1);assert.equal(result.pending,0);assert.deepEqual(result.errors,[]);
  const replay=await f.service.batchTaskAction({accountId:'account',action:'resume',items:preview.items});
  assert.equal(replay.applied,0);assert.equal(replay.skipped.length,1);
  assert.equal(f.repository.rows.get(f.id).status,'SUBMISSION_FAILED');
});

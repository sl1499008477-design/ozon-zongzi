import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService} from '../ai-listing-service.mjs';
import {taskActions} from '../ai-listing-task-controls.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

async function fixture() {
  const repository=memoryRepository();let calls=0;
  const service=createAiListingService({repository,clock:()=>1000,
    loadSources:async()=>[{collectItemId:'c',items:[{sku:'s',images:['https://fixture.invalid/source'],listingItem:{weight:100,depth:100,width:100,height:100}}]}],
    generateImage:async()=>assert.fail('Deleting must not generate'),submitListing:async()=>assert.fail('Deleting must not publish')});
  const [created]=await service.createFromCollect({accountId:'a',collectItemIds:['c'],idempotencyKey:'original',config:{targetStoreId:'store',targetWarehouseId:'w'}});
  repository.requestPurge=async input=>{calls++;assert.equal(input.accountId,'a');assert.equal(input.expectedVersion,repository.rows.get(created.id).version);
    const row=repository.rows.get(created.id);row.purge={state:'PENDING',requestedAt:1000};row.version++;return structuredClone(row);};
  return {repository,service,id:created.id,calls:()=>calls};
}

test('permanent deletion is offered only for safely deleted tasks, never as a batch operation',async()=>{
  assert.equal(taskActions({status:'GENERATING'}).permanentDelete,false);
  assert.equal(taskActions({status:'CANCELLED',deletedAt:1,stoppedFrom:'GENERATING'}).permanentDelete,true);
  assert.equal(taskActions({status:'CANCELLED',deletedAt:1,stoppedFrom:'SUBMISSION_UNCERTAIN'}).permanentDelete,false);
  assert.equal(taskActions({status:'CANCELLED',deletedAt:1,controlAction:'delete'}).permanentDelete,false);
  assert.equal(taskActions({status:'CANCELLED',deletedAt:1,permanentlyDeletedAt:2}).permanentDelete,false);
  const f=await fixture();
  await assert.rejects(f.service.previewTaskAction({accountId:'a',group:'deleted',action:'permanentDelete'}),{code:'AI_LISTING_INVALID_INPUT'});
});

test('single permanent deletion requires the owner, deleted state and confirmed version; repeats do not re-run it',async()=>{
  const f=await fixture();const input={accountId:'a',taskId:f.id,expectedVersion:1};
  await assert.rejects(f.service.permanentlyDeleteTask({...input,accountId:'other'}),{statusCode:404});
  await assert.rejects(f.service.permanentlyDeleteTask(input),{statusCode:409});
  const deleted=await f.service.deleteTask(input);
  await assert.rejects(f.service.permanentlyDeleteTask({accountId:'a',taskId:f.id}),{code:'AI_LISTING_INVALID_INPUT'});
  await assert.rejects(f.service.permanentlyDeleteTask(input),{statusCode:409});
  assert.equal(f.calls(),0);
  const accepted=await f.service.permanentlyDeleteTask({...input,expectedVersion:deleted.version});
  assert.equal(accepted.purge.state,'PENDING');
  await assert.rejects(f.service.permanentlyDeleteTask({...input,expectedVersion:deleted.version}),{statusCode:409});
  await assert.rejects(f.service.resumeTask({...input,expectedVersion:accepted.version}),{statusCode:409});
  f.repository.rows.get(f.id).permanentlyDeletedAt=1000;
  assert.equal(f.calls(),1);
  await assert.rejects(f.service.getTask({accountId:'a',taskId:f.id,includeDeleted:true}),{statusCode:404});
  await assert.rejects(f.service.resumeTask({...input,expectedVersion:deleted.version}),{statusCode:404});
  await assert.rejects(f.service.createFromCollect({accountId:'a',collectItemIds:['c'],idempotencyKey:'original',config:{targetStoreId:'store',targetWarehouseId:'w'}}),{code:'AI_LISTING_TASK_PERMANENTLY_DELETED'});
});

test('HTTP single permanent-delete reads the body once, uses the session owner and returns accepted task',async()=>{
  const {createAiListingRuntime}=await import('../ai-listing-runtime.mjs');
  const f=await fixture();const deleted=await f.service.deleteTask({accountId:'a',taskId:f.id,expectedVersion:1});let reads=0;
  const runtime=createAiListingRuntime({repository:f.repository,clock:()=>1000,
    authenticate:async()=>({id:'a',role:'user',status:'active'}),
    readJson:async()=>{reads++;return {expectedVersion:deleted.version,accountId:'other'};},
    sendJson:(res,status,body)=>Object.assign(res,{status,body}),resolvePool:async()=>({query:async()=>({rows:[]})})});
  const res={};assert.equal(await runtime.handleRoute({method:'POST'},res,new URL(`http://localhost/api/ai-listing/tasks/${f.id}/permanent-delete`)),true);
  assert.equal(reads,1);assert.equal(res.status,202);assert.equal(res.body.task.purge.state,'PENDING');assert.equal(f.calls(),1);
});

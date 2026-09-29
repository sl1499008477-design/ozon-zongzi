import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiListingDetailPollDelay,
  aiListingPurgeDetailEvidence,
  shouldClosePurgedAiListingDetail,
  aiListingTaskActions,
  aiListingTaskStatus,
} from '../src/ai-listing-page-state.js';

test('permanent deletion is available only in the deleted view and when the server allows it',()=>{
  const task={deletedAt:1,taskActions:{permanentDelete:true,resume:true}};
  assert.deepEqual(aiListingTaskActions(task),{
    approve:false,pause:false,cancel:false,delete:false,retry:false,resume:true,
  });
  assert.equal(aiListingTaskActions(task,{deletedView:true}).permanentDelete,true);
  assert.equal(aiListingTaskActions({deletedAt:1,taskActions:{permanentDelete:false}},{deletedView:true}).permanentDelete,false);
  assert.equal(aiListingTaskActions({status:'CANCELLED',taskActions:{permanentDelete:true}},{deletedView:true}).permanentDelete,false);
});

test('queued and active purges have distinct labels and cannot be restored or requested again',()=>{
  for(const state of ['PENDING','RUNNING']){
    const task={deletedAt:1,purge:{state,requestedAt:'2026-09-18T01:00:00Z'},taskActions:{resume:true,permanentDelete:true}};
    assert.equal(aiListingTaskStatus(task).label,state==='PENDING'?'排队中':'正在清理');
    assert.match(aiListingTaskStatus(task).description,/尚未完成/);
    assert.deepEqual(aiListingTaskActions(task,{deletedView:true}),{
      approve:false,pause:false,cancel:false,delete:false,retry:false,resume:false,permanentDelete:false,
    });
    assert.equal(aiListingDetailPollDelay(task,true),3000);
  }
});

test('failed purges show the failure and only expose server-authorized permanent-delete retry',()=>{
  const task={deletedAt:1,purge:{state:'FAILED',requestedAt:'2026-09-18T01:00:00Z',errorMessage:'COS 清理失败'},taskActions:{resume:true,retry:true,permanentDelete:true}};
  assert.deepEqual(aiListingTaskActions(task,{deletedView:true}),{
    approve:false,pause:false,cancel:false,delete:false,retry:false,resume:false,permanentDelete:true,
  });
  assert.deepEqual(aiListingTaskStatus(task),{label:'清理失败',color:'red',description:'COS 清理失败'});
});

test('detail closes only for the accepted purge in the same account scope after a confirmed 404',()=>{
  const accepted={taskId:'task-a',scopeKey:'account-a',version:8};
  const input={taskId:'task-a',scopeKey:'account-a',accepted};
  assert.equal(shouldClosePurgedAiListingDetail({...input,error:{status:404}}),true);
  assert.equal(shouldClosePurgedAiListingDetail({...input,error:{status:403}}),false);
  assert.equal(shouldClosePurgedAiListingDetail({...input,error:new Error('network')}),false);
  assert.equal(shouldClosePurgedAiListingDetail({...input,error:{status:404},taskId:'task-b'}),false);
  assert.equal(shouldClosePurgedAiListingDetail({...input,error:{status:404},scopeKey:'account-b'}),false);
  assert.equal(shouldClosePurgedAiListingDetail({...input,error:{status:404},accepted:null}),false);
});

test('scoped purge detail responses provide versioned completion evidence without trusting stale or ordinary details',()=>{
  for(const state of ['PENDING','RUNNING','FAILED']){
    assert.deepEqual(aiListingPurgeDetailEvidence({id:'task-a',version:8,deletedAt:1,purge:{state}},
      {taskId:'task-a',scopeKey:'account-a'}),{taskId:'task-a',scopeKey:'account-a',version:8});
  }
  assert.equal(aiListingPurgeDetailEvidence({id:'task-b',version:8,deletedAt:1,purge:{state:'RUNNING'}},
    {taskId:'task-a',scopeKey:'account-a'}),null);
  assert.equal(aiListingPurgeDetailEvidence({id:'task-a',deletedAt:1,purge:{state:'RUNNING'}},
    {taskId:'task-a',scopeKey:'account-a'}),null);
  assert.equal(aiListingPurgeDetailEvidence({id:'task-a',version:8,deletedAt:1},
    {taskId:'task-a',scopeKey:'account-a'}),null);
});

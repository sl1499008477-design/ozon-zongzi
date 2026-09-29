import test from 'node:test';
import assert from 'node:assert/strict';
import * as handoff from '../collector-run-handoff.mjs';

function fixture(overrides={}) {
  const row={runId:'run',accountId:'account',body:{receipts:{}},token:'lease'};
  let saved;const requests=[];
  const deps={repository:{claim:async()=>row,save:async(_row,body,status)=>{saved={body:structuredClone(body),status};return true;}},
    readRun:async()=>({id:'run',status:'COMPLETED',configurationSnapshot:{configuration:{autoSendToAiListing:true,autoStartAiGeneration:true}}}),
    listItems:async()=>[{id:'item-a'},{id:'item-b'}],
    addSelected:async input=>{requests.push(['collect',input.itemIds]);return{results:input.itemIds.map(id=>({collectorItemId:id,collectItemId:'collect-'+id})),errors:[],missing:[]};},
    createTasks:async input=>{requests.push(['ai',input.collectItemIds]);return{results:input.collectItemIds.map(collectItemId=>({collectItemId,createdTaskIds:['ai-'+collectItemId],reusedTaskIds:[]})),errors:[]};},...overrides};
  return{deps,row,requests,saved:()=>saved};
}

test('server completes handoff without any desktop callback and records a durable receipt',async()=>{
  const f=fixture();await handoff.createCollectorRunHandoffWorker(f.deps).tick();
  assert.equal(f.saved().status,'COMPLETED');
  assert.equal(f.saved().body.receipts['item-a'].status,'DONE');
  assert.equal(f.saved().body.receipts['item-b'].status,'DONE');
  assert.equal(handoff.handoffSummary(f.saved().body,'COMPLETED').created,2);
});

test('handoff restart skips already completed items and does not recreate their AI tasks',async()=>{
  const f=fixture();f.row.body.receipts['item-a']={status:'DONE',createdTaskIds:['existing'],reusedTaskIds:[]};
  await handoff.createCollectorRunHandoffWorker(f.deps).tick();
  assert.deepEqual(f.requests,[['collect',['item-b']],['ai',['collect-item-b']]]);
  assert.equal(f.saved().body.receipts['item-a'].createdTaskIds[0],'existing');
});

test('deleted historical owner is a visible partial failure and successful handoff stays retained',async()=>{
  const f=fixture({createTasks:async()=>({results:[],errors:[{collectItemId:'collect-item-b',code:'AI_LISTING_DELETED_TASK_BLOCKED',message:'历史任务已删除'}]})});
  f.row.body.receipts['item-a']={status:'DONE',createdTaskIds:['existing'],reusedTaskIds:[]};
  await handoff.createCollectorRunHandoffWorker(f.deps).tick();
  assert.equal(f.saved().status,'PARTIAL');assert.equal(f.saved().body.receipts['item-b'].status,'FAILED');
  assert.equal(handoff.handoffSummary(f.saved().body,'PARTIAL').errors.length,1);
});

test('account/run not eligible no longer initiates collection or AI work',async()=>{
  const f=fixture({readRun:async()=>({status:'CANCELLED'})});
  await handoff.createCollectorRunHandoffWorker(f.deps).tick();assert.equal(f.saved().status,'FAILED');assert.deepEqual(f.requests,[]);
});

test('handoff persists task receipts from the public per-source AI result shape, including partial failure',async()=>{
  const f=fixture({createTasks:async({collectItemIds:[collectItemId]})=>({
    results:[{collectItemId,createdTaskIds:['created-'+collectItemId],reusedTaskIds:['reused-'+collectItemId]}],
    tasks:[],errors:collectItemId.endsWith('item-b')?[{code:'AI_LISTING_DELETED_TASK_BLOCKED',message:'历史任务已删除'}]:[],
  })});
  await handoff.createCollectorRunHandoffWorker(f.deps).tick();
  assert.equal(f.saved().status,'PARTIAL');
  assert.deepEqual(f.saved().body.receipts['item-a'].createdTaskIds,['created-collect-item-a']);
  assert.deepEqual(f.saved().body.receipts['item-b'].reusedTaskIds,['reused-collect-item-b']);
  assert.equal(f.saved().body.receipts['item-b'].status,'FAILED');
  const summary=handoff.handoffSummary(f.saved().body,'PARTIAL');
  assert.equal(summary.created,2);assert.equal(summary.reused,2);assert.equal(summary.processed,1);
});

test('known pre-create temporary RFBS failure backs off then resumes the same collect receipt without recreating paid work',async()=>{
  let now=1000,calls=0;const saves=[];
  const f=fixture({listItems:async()=>[{id:'item-a'}],clock:()=>now,createTasks:async()=>{
    if(++calls===1)throw Object.assign(new Error('RFBS 仓库需要重新验证'),{code:'RFBS_VALIDATION_REQUIRED',retryable:true,definitelyNotCreated:true});
    return {results:[{collectItemId:'collect-item-a',createdTaskIds:['existing-ai'],reusedTaskIds:[]}],errors:[]};
  }});
  f.deps.repository.save=async(_row,body,status,nextRunAt)=>{f.row.body=structuredClone(body);saves.push({status,nextRunAt});return true;};
  const worker=handoff.createCollectorRunHandoffWorker(f.deps);await worker.tick();
  assert.equal(saves.at(-1).status,'PENDING');assert.equal(saves.at(-1).nextRunAt,6000);
  assert.equal(f.row.body.receipts['item-a'].status,'COLLECTED');assert.equal(f.row.body.attempts,1);
  now=6000;await worker.tick();
  assert.equal(saves.at(-1).status,'COMPLETED');assert.equal(calls,2);
  assert.deepEqual(f.requests,[['collect',['item-a']]],'retry uses the durable collect ID');
  assert.equal(f.row.body.attempts,undefined);assert.equal(f.row.body.error,undefined);
});

test('temporary RFBS validation stops after three consecutive attempts and keeps an explicit recoverable failure',async()=>{
  const f=fixture({listItems:async()=>[{id:'item-a'},{id:'item-b'}],clock:()=>1000,createTasks:async()=>{
    throw Object.assign(new Error('RFBS 仓库需要重新验证'),{code:'RFBS_VALIDATION_REQUIRED',retryable:true,definitelyNotCreated:true});
  }}),saves=[];
  f.deps.repository.save=async(_row,body,status,nextRunAt)=>{f.row.body=structuredClone(body);saves.push({status,nextRunAt});return true;};
  const worker=handoff.createCollectorRunHandoffWorker(f.deps);
  await worker.tick();await worker.tick();await worker.tick();
  assert.deepEqual(saves.filter(x=>x.status==='PENDING').map(x=>x.nextRunAt),[6000,31000]);
  assert.equal(saves.at(-1).status,'FAILED');assert.equal(f.row.body.attempts,3);
  assert.match(f.row.body.error.message,/3.*重试发送/);
  assert.equal(f.row.body.receipts['item-a'].status,'FAILED');
  assert.deepEqual(f.requests,[['collect',['item-a']]],'the first target failure pauses the rest of the batch');
});

test('RFBS-shaped uncertain or unmarked failures never enter automatic retry',async()=>{
  for(const fields of [{retryable:true},{definitelyNotCreated:true},{retryable:true,definitelyNotCreated:true,code:'OTHER_ERROR'}]){
    const f=fixture({listItems:async()=>[{id:'item-a'}],createTasks:async()=>{throw Object.assign(new Error('failure'),{code:'RFBS_VALIDATION_REQUIRED',...fields});}});
    await handoff.createCollectorRunHandoffWorker(f.deps).tick();
    assert.equal(f.saved().status,'FAILED');assert.equal(f.saved().body.receipts['item-a'].status,'FAILED');
  }
});

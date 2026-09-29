import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {aiListingTaskActions,isAiListingPriceSkipped} from '../src/ai-listing-page-state.js';

const source=readFileSync(new URL('../src/AiListingPage.jsx',import.meta.url),'utf8');
function actionScope(){
  const cleanups=[];
  const start=source.indexOf('  const actionAccountRef='),end=source.indexOf('  const [activeTab',start);
  const ref=new Function('accountId','useRef','useEffect',source.slice(start,end)+'return actionAccountRef;')('A',value=>({current:value}),effect=>cleanups.push(effect()));
  return {ref,unmount:()=>cleanups.forEach(cleanup=>cleanup?.())};
}

for(const transition of ['unmount','switch-account'])test(`batch finishes its sent chunk but starts no further chunks after ${transition}`,async()=>{
  const scope=actionScope(),requests=[];let release,refreshes=0;
  const context={busyAction:'',accountId:'A',actionAccountRef:scope.ref,
    batchPreview:{accountId:'A',action:'resume',group:'deleted',items:Array.from({length:121},(_,i)=>({taskId:String(i),expectedVersion:7})),skipped:[]},
    setBusyAction(){},setBatchResult(){},setBatchPreview(){},setTaskSelection(){},loadTasks:async()=>{refreshes++;},
    request:async(path,options)=>{requests.push({path,...options});if(requests.length===1)await new Promise(resolve=>{release=resolve;});return {applied:50,pending:0,skipped:[],errors:[]};}};
  const start=source.indexOf('  const applyBatch=async()=>'),end=source.indexOf('  const createPanel =',start);
  const apply=new Function(...Object.keys(context),source.slice(start,end)+'return applyBatch;')(...Object.values(context));
  const pending=apply();assert.equal(requests.length,1);assert.equal(requests[0].body.items.length,50);
  if(transition==='unmount')scope.unmount();else scope.ref.current='B';
  release();await pending;
  assert.equal(requests.length,1,'the next 50-task chunk must not be submitted');
  assert.equal(refreshes,0,'the old component must not refresh using the new account credentials');
});

function batchHarness(overrides={}){
  const observed={requests:[],preview:null,result:null,cleared:false};
  const context={busyAction:'',accountId:'A',actionAccountRef:{current:'A'},taskGroup:'deleted',taskStage:'',selectedTasks:[],
    batchPreview:null,aiListingTaskActions,isAiListingPriceSkipped,message:{error(){},info(){}},listResponseVersionRef:{current:0},setTasks(){},
    setBusyAction(){},setBatchResult(value){observed.result=value;},setBatchPreview(value){observed.preview=value;},
    setTaskSelection(){observed.cleared=true;},loadTasks:async()=>{},
    request:async(path,options)=>{observed.requests.push({path,...options});return {items:[],skipped:[]};},...overrides};
  const start=source.indexOf('  const previewBatch=async action=>'),end=source.indexOf('  const createPanel =',start);
  return {...new Function(...Object.keys(context),source.slice(start,end)+'return {previewBatch,applyBatch};')(...Object.values(context)),observed};
}

test('selected batch preview contains only selected eligible task versions, never a group-wide request',async()=>{
  const selectedTasks=[{id:'selected-a',version:7,deletedAt:1,taskActions:{resume:true}},
    {id:'selected-b',version:8,deletedAt:1,purge:{state:'RUNNING'},taskActions:{}}];
  const h=batchHarness({selectedTasks});await h.previewBatch('resume');
  assert.deepEqual(h.observed.requests,[]);
  assert.deepEqual(h.observed.preview.items,[{taskId:'selected-a',expectedVersion:7}]);
  assert.equal(h.observed.preview.total,2);assert.equal(h.observed.preview.selected,true);
  assert.equal(h.observed.preview.skipped[0].taskId,'selected-b');
});

test('permanent batch deletion cannot fall back to all tasks when no row is selected or outside deleted group',async()=>{
  for(const overrides of [{},{taskGroup:'active',selectedTasks:[{id:'a',version:7,taskActions:{permanentDelete:true}}]}]){
    const h=batchHarness(overrides);await h.previewBatch('permanentDelete');
    assert.deepEqual(h.observed.requests,[]);assert.equal(h.observed.preview,null);
  }
});

test('home stage filters never preview an entire task group for bulk actions',async()=>{
  const h=batchHarness({taskGroup:'active',taskStage:'review'});
  await h.previewBatch('pause');
  assert.deepEqual(h.observed.requests,[]);
  assert.equal(h.observed.preview,null);
});

test('permanent batch deletion reuses single-task version checks, counts accepted requests and skips conflicts',async()=>{
  const calls=[],versions=[7,11,13];
  const h=batchHarness({batchPreview:{accountId:'A',group:'deleted',action:'permanentDelete',selected:true,
    items:versions.map((version,i)=>({taskId:`chosen-${i}`,expectedVersion:version})),skipped:[]},
    request:async(path,options)=>{calls.push({path,...options});if(calls.length===2)throw Object.assign(new Error('任务状态已变化'),{status:409});return {task:{purge:{state:'PENDING'}}};}});
  await h.applyBatch();
  assert.deepEqual(calls.map(call=>call.path),['/ai-listing/tasks/chosen-0/permanent-delete','/ai-listing/tasks/chosen-1/permanent-delete','/ai-listing/tasks/chosen-2/permanent-delete']);
  assert.deepEqual(calls.map(call=>call.body),[{expectedVersion:7},{expectedVersion:11},{expectedVersion:13}]);
  assert.equal(h.observed.result.applied,2);assert.equal(h.observed.result.skipped[0].taskId,'chosen-1');
  assert.equal(h.observed.result.processed,3);assert.equal(h.observed.cleared,true);
});

test('an uncertain permanent-delete request stops the batch without automatically resending or claiming completion',async()=>{
  let calls=0;
  const h=batchHarness({batchPreview:{accountId:'A',group:'deleted',action:'permanentDelete',selected:true,
    items:[{taskId:'a',expectedVersion:7},{taskId:'b',expectedVersion:8},{taskId:'c',expectedVersion:9}],skipped:[]},
    request:async()=>{calls++;if(calls===2)throw new Error('network interrupted');return {task:{purge:{state:'PENDING'}}};}});
  await h.applyBatch();assert.equal(calls,2);assert.equal(h.observed.result.applied,1);
  assert.equal(h.observed.result.remaining,2);assert.match(h.observed.result.error,/network/);
});

test('switching account during a permanent batch starts no further task requests',async()=>{
  const ref={current:'A'};let calls=0,refreshes=0;
  const h=batchHarness({actionAccountRef:ref,batchPreview:{accountId:'A',group:'deleted',action:'permanentDelete',selected:true,
    items:[{taskId:'a',expectedVersion:7},{taskId:'b',expectedVersion:8}],skipped:[]},
    loadTasks:async()=>{refreshes++;},request:async()=>{calls++;ref.current='B';return {task:{purge:{state:'PENDING'}}};}});
  await h.applyBatch();assert.equal(calls,1);assert.equal(refreshes,0);assert.equal(h.observed.result,null);
});

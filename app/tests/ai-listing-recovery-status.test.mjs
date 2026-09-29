import test from 'node:test';
import assert from 'node:assert/strict';
import {aiListingActionPayload,aiListingTaskStatus,startAiListingPolling} from '../src/ai-listing-page-state.js';
import * as state from '../src/ai-listing-page-state.js';
test('selected SKU recovery keeps the explicit subset in the request',()=>{
 assert.deepEqual(aiListingActionPayload({version:8},'retry',{skus:['ready-sibling']}),{expectedVersion:8,skus:['ready-sibling']});
 assert.deepEqual(aiListingActionPayload({version:8},'pause',{skus:['ready-sibling']}),{expectedVersion:8});
});
test('mixed submitted result reports inventory counts without claiming inventory success is sale success',()=>{
 const status=aiListingTaskStatus({status:'SUBMITTED',completedSkuCount:1,failedSubmissionSkuCount:4,pendingSubmissionSkuCount:1});
 assert.match(status.description,/库存完成 1/);assert.match(status.description,/失败 4/);assert.match(status.description,/等待 1/);assert.doesNotMatch(status.description,/正常 SKU 已上架/);
});
test('completed inventory with platform warnings is visible as needing card verification',()=>{
 const status=aiListingTaskStatus({status:'COMPLETED',submissionResults:[{stockStatus:'COMPLETED',publicationWarnings:['warning_all_image_failed']}]});
 assert.match(status.label,/待核查/);
});
test('failed list polling backs off and resets after a successful read',async()=>{
 const pending=[],delays=[];let n=0;
 const stop=startAiListingPolling({load:async()=>++n<3?false:true,getInterval:()=>3000,setTimeoutFn:(fn,ms)=>{pending.push(fn);delays.push(ms);return n;},clearTimeoutFn:()=>{}});
 await new Promise(resolve=>setImmediate(resolve));await pending.shift()();await pending.shift()();stop();
 assert.deepEqual(delays,[10000,20000,3000]);
});
test('a failed import cannot also be counted as waiting inventory',()=>{
 const status=aiListingTaskStatus({status:'SUBMISSION_FAILED',submissionResults:[{importStatus:'FAILED',stockStatus:'PENDING'},{importStatus:'SUCCEEDED',stockStatus:'PENDING'}]});
 assert.match(status.description,/失败 1/);assert.match(status.description,/等待 1/);
});
test('paused submitted work describes local processing rather than a new image-generation queue',()=>{
 const status=aiListingTaskStatus({status:'PAUSED',submissionId:'original-submission'});
 assert.match(status.description,/后续|查询/);assert.match(status.description,/已发送|撤回/);assert.doesNotMatch(status.description,/生图/);
});
test('selected SKU controls retain unresolved inventory and pure missing-image recovery entries',()=>{
 const task={status:'SUBMISSION_FAILED',taskActions:{retry:true}};
 assert.equal(state.aiListingCanRetrySku(task,{sku:'pending',importStatus:'SUCCEEDED',stockStatus:'PENDING'}),true);
 assert.equal(state.aiListingCanRetrySku(task,{sku:'picture',importStatus:'SUCCEEDED',stockStatus:'COMPLETED',publicationWarnings:['some_image_failed']}),true);
 assert.equal(state.aiListingCanRetrySku(task,{sku:'done',importStatus:'SUCCEEDED',stockStatus:'COMPLETED'}),false);
 assert.equal(state.aiListingCanRetrySku({...task,taskActions:{retry:false}},{sku:'failed',stockStatus:'FAILED'}),false);
});

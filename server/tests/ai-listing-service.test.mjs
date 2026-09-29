import test from "node:test";
import assert from "node:assert/strict";
import { AI_LISTING_DEFAULT_PROMPT, normalizeAiListingConfig, createAiListingService } from "../ai-listing-service.mjs";
import {taskActions} from '../ai-listing-task-controls.mjs';

import {memoryRepository} from './support/ai-listing-memory-repository.mjs';
const copy = (value) => structuredClone(value&&typeof value==='object'&&!Array.isArray(value)
  ?Object.fromEntries(Object.entries(value).filter(([,item])=>typeof item!=='function')):value);

test('pause and resume keep the same task and append it behind existing work',async()=>{
  const env=setup({source:source(1)});const first=await env.create({manualReview:true});
  const [second]=await env.service.createFromCollect({accountId:'account-a',collectItemIds:['collect-1'],idempotencyKey:'second-task',config:{...config,manualReview:true}});
  const paused=await env.service.pauseTask({accountId:'account-a',taskId:first.id});
  assert.equal(paused.status,'PAUSED');assert.equal(env.calls.length,0);
  await env.service.resumeTask({accountId:'account-a',taskId:first.id});
  assert.ok(env.repository.rows.get(first.id).queuePosition>env.repository.rows.get(second.id).queuePosition);
  assert.equal((await env.service.processNext()).id,second.id);
  assert.equal((await env.service.processNext()).id,first.id);
});

for(const action of ['pause','cancel','delete'])test(`${action} during generation preserves the paid response and stops before the next image`,async()=>{
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});const response=new Promise(resolve=>{release=resolve;});let requests=0;
  const env=setup({source:source(2),generateImage:async()=>{requests++;entered();await response;return {generatedUrl:'https://generated.test/first.png'};}});
  const task=await env.create({manualReview:true});const processing=env.service.processNext();await started;
  const result=await env.service[`${action}Task`]({accountId:'account-a',taskId:task.id});
  assert.equal(result.controlAction,action);assert.equal(result.status,'GENERATING');
  release();await processing;
  const saved=env.repository.rows.get(task.id);
  assert.equal(saved.images[0].generatedUrl,'https://generated.test/first.png');assert.equal(saved.images[1].generatedUrl,null);
  assert.equal(requests,1);assert.equal(saved.status,action==='pause'?'PAUSED':'CANCELLED');assert.equal(saved.controlAction,null);
  if(action==='delete'){
    assert.ok(saved.deletedAt);assert.deepEqual(await env.service.listTasks({accountId:'account-a'}),[]);
    await assert.rejects(env.service.resumeTask({accountId:'account-a',taskId:task.id}));
  }else{
    await env.service.resumeTask({accountId:'account-a',taskId:task.id});await env.service.processNext();
    assert.equal(requests,2);assert.equal(env.repository.rows.get(task.id).images[0].generatedUrl,'https://generated.test/first.png');
  }
});

for(const status of ['GENERATION_FAILED','UPLOAD_FAILED','SUBMISSION_UNCERTAIN'])test(`soft delete ${status} retains submitted identities and restores only the original stopped error`,async()=>{
  const env=setup();const task=await env.create();
  const row=env.repository.rows.get(task.id);
  Object.assign(row,{status,submissionStarted:true,submissionExternalWriteStarted:true,submissionId:'original-journal',
    submissionResults:[{sku:'sku-a',offerId:'original-offer',importStatus:status==='SUBMISSION_UNCERTAIN'?'UNKNOWN':'SUCCEEDED',stockStatus:status==='SUBMISSION_UNCERTAIN'?'PENDING':'COMPLETED'}]});
  Object.assign(row.images[0],{status:'COMPLETED',generatedUrl:'https://saved.test/retained.png'});
  const retained=structuredClone(row);
  await assert.rejects(env.service.deleteTask({accountId:'account-b',taskId:task.id}));
  await assert.rejects(env.service.deleteTask({accountId:'account-a',taskId:task.id,expectedVersion:row.version+1}));
  const deleted=await env.service.deleteTask({accountId:'account-a',taskId:task.id,expectedVersion:row.version});
  assert.ok(deleted.deletedAt);assert.equal(deleted.taskActions.permanentDelete,true);assert.equal(deleted.taskActions.resume,true);
  assert.deepEqual(await env.service.listTasks({accountId:'account-a'}),[]);
  assert.equal((await env.service.getTask({accountId:'account-a',taskId:task.id,includeDeleted:true})).submissionId,'original-journal');
  assert.equal(await env.service.processNext(),null);assert.equal(env.calls.length,0);assert.equal(env.submissions.length,0);
  const saved=env.repository.rows.get(task.id);assert.equal(saved.stoppedFrom,status);
  assert.deepEqual(saved.images,retained.images);assert.deepEqual(saved.submissionResults,retained.submissionResults);
  await assert.rejects(env.service.resumeTask({accountId:'account-b',taskId:task.id,expectedVersion:saved.version}));
  const restored=await env.service.resumeTask({accountId:'account-a',taskId:task.id,expectedVersion:saved.version});
  assert.equal(restored.status,status);assert.equal(restored.deletedAt,null);
  assert.equal(await env.service.processNext(),null);assert.equal(env.calls.length,0);assert.equal(env.submissions.length,0);
  assert.deepEqual(env.repository.rows.get(task.id).submissionResults,retained.submissionResults);
});

test('delete preview includes partial successes and unknown results, and applies only owned unchanged tasks',async()=>{
 const env=setup();const tasks=await env.service.createFromSkus({accountId:'account-a',skus:['partial-one','partial-two','unknown'],idempotencyKey:'errors-delete',config});
 for(const [index,task] of tasks.entries())Object.assign(env.repository.rows.get(task.id),{status:index===2?'SUBMISSION_UNCERTAIN':'GENERATION_FAILED',submissionId:'retained-'+index,submissionStarted:true,submissionExternalWriteStarted:true});
 const preview=await env.service.previewTaskAction({accountId:'account-a',group:'errors',action:'delete'});
 assert.equal(preview.items.length,3);assert.deepEqual(preview.skipped,[]);
 assert.equal((await env.service.batchTaskAction({accountId:'account-b',action:'delete',items:preview.items})).applied,0);
 env.repository.rows.get(tasks[0].id).version++;
 const applied=await env.service.batchTaskAction({accountId:'account-a',action:'delete',items:preview.items});
 assert.equal(applied.applied,2);assert.equal(applied.skipped.length,1);assert.equal(env.repository.rows.size,3);
 assert.equal((await env.service.batchTaskAction({accountId:'account-a',action:'delete',items:preview.items})).applied,0);
 assert.equal(env.calls.length,0);assert.equal(env.submissions.length,0);
});

test('batch preview covers the whole group and applying it cannot expand to new or changed tasks',async()=>{
  const env=setup();const tasks=await env.service.createFromSkus({accountId:'account-a',skus:Array.from({length:62},(_,i)=>`sku-${i}`),idempotencyKey:'batch-controls',config});
  env.repository.rows.get(tasks[60].id).status='GENERATION_FAILED';env.repository.rows.get(tasks[61].id).status='CANCELLED';
  const preview=await env.service.previewTaskAction({accountId:'account-a',group:'active',action:'pause'});
  assert.equal(preview.total,60);assert.equal(preview.items.length,60);
  env.repository.rows.get(tasks[0].id).version++;
  const [late]=await env.service.createFromSkus({accountId:'account-a',skus:['late'],idempotencyKey:'late',config});
  const result=await env.service.batchTaskAction({accountId:'account-a',action:'pause',items:preview.items});
  assert.equal(result.applied,59);assert.equal(result.skipped.length,1);
  assert.equal(env.repository.rows.get(late.id).status,'QUEUED');assert.equal(env.repository.rows.get(tasks[60].id).status,'GENERATION_FAILED');
  const again=await env.service.batchTaskAction({accountId:'account-a',action:'pause',items:preview.items});assert.equal(again.applied,0);
});

const config = { targetStoreId: "store-a", targetWarehouseId: "warehouse-a" };

test('submitted local polling can pause and resume only the same submission without regenerating or resubmitting',async()=>{
 const env=setup({source:source(1)}),task=await env.create();await env.service.processNext();
 const before=structuredClone(env.repository.rows.get(task.id));
 const paused=await env.service.pauseTask({accountId:'account-a',taskId:task.id});
 assert.equal(paused.status,'PAUSED');assert.equal(paused.taskActions.resume,true);assert.equal(await env.service.processNext(),null);
 const resumed=await env.service.resumeTask({accountId:'account-a',taskId:task.id});assert.equal(resumed.status,'SUBMITTED');
 await env.service.processNext();assert.equal(env.submissions.length,1);assert.deepEqual(env.repository.rows.get(task.id).images,before.images);
 assert.equal(env.repository.rows.get(task.id).submissionId,before.submissionId);
});

test('selected retry of a submitted partial failure preserves successful SKU and forwards only authorized recovery scope',async()=>{
 const env=setup({source:source(1)}),task=await env.create();await env.service.processNext();const row=env.repository.rows.get(task.id);
 row.submissionResults=[{sku:row.source.items[0].sku,importStatus:'SUCCEEDED',stockStatus:'FAILED',errors:['PRODUCT_IS_NOT_CREATED']}];
 const sku=row.source.items[0].sku,images=structuredClone(row.images);
 const result=await env.service.retryTask({accountId:'account-a',taskId:task.id,skus:[sku]});assert.equal(result.status,'READY_TO_SUBMIT');
 await env.service.processNext();assert.deepEqual(env.submissions.at(-1).retrySkus,[sku]);assert.deepEqual(env.repository.rows.get(task.id).images,images);
 await assert.rejects(env.service.retryTask({accountId:'account-a',taskId:task.id,skus:['unknown']}),{code:'AI_LISTING_INVALID_INPUT'});
});

test('a submitted failed import has the same selected retry eligibility in list summary and detail',async()=>{
 const env=setup({source:source(1)}),task=await env.create();await env.service.processNext();const row=env.repository.rows.get(task.id);
 const sku=row.source.items[0].sku;
 row.submissionResults=[{sku,importStatus:'FAILED',stockStatus:'PENDING',errors:['VALIDATION_FAILED']}];
 const detail=await env.service.getTask({accountId:'account-a',taskId:task.id});
 const summary=taskActions({status:row.status,submissionId:row.submissionId,failedSubmissionSkuCount:1,imageFailedSkuCount:0});
 assert.equal(summary.retry,true);assert.equal(detail.taskActions.retry,summary.retry);
 const resumed=await env.service.retryTask({accountId:'account-a',taskId:task.id,skus:[sku]});assert.equal(resumed.status,'READY_TO_SUBMIT');
 await env.service.processNext();assert.deepEqual(env.submissions.at(-1).retrySkus,[sku]);
});

test('a media preparation failure exposes phase timings in task details and successful retry clears them',async()=>{
 let attempt=0;const diagnostics={downloadMs:180000,processMs:0,uploadMs:0};
 const env=setup({source:source(1),submitListing:async()=>{if(++attempt===1)throw Object.assign(new Error('视频下载超时'),
  {code:'AI_LISTING_MEDIA_PREPARATION_FAILED',definitelyNotSubmitted:true,mediaStage:'download',mediaDiagnostics:diagnostics});return {submissionId:'original'};}});
 const task=await env.create();await env.service.processNext();
 const failed=await env.service.getTask({accountId:'account-a',taskId:task.id});assert.equal(failed.mediaStage,'download');assert.deepEqual(failed.mediaDiagnostics,diagnostics);
 await env.service.retryTask({accountId:'account-a',taskId:task.id});await env.service.processNext();
 const resumed=await env.service.getTask({accountId:'account-a',taskId:task.id});assert.equal(resumed.mediaStage,undefined);assert.equal(resumed.mediaDiagnostics,undefined);
});

test('pausing during submission polling stops the next stock write at the fence',async()=>{
 let task,stockWrites=0;const env=setup({source:source(1),readSubmission:async input=>{
  await env.service.pauseTask({accountId:'account-a',taskId:task.id});await input.beforeExternalWrite();stockWrites++;return {status:'COMPLETED'};
 }});
 task=await env.create();await env.service.processNext();env.advance(15000);
 const paused=await env.service.processNext();assert.equal(paused.status,'PAUSED');assert.equal(stockWrites,0);
});

test("new preview URL is persisted and returned while submission only receives the formal URL", async () => {
  const env = setup({ source: source(1), generateImage: async () => ({
    generatedUrl: "https://media.test/formal.jpg", previewUrl: "https://media.test/preview.webp", objectKey: "formal.jpg",
  }) });
  const task = await env.create();
  const result = await env.service.processNext();
  assert.equal(result.images[0].previewUrl, "https://media.test/preview.webp");
  assert.equal(env.repository.rows.get(task.id).images[0].previewUrl, "https://media.test/preview.webp");
  assert.deepEqual(Object.keys(env.submissions[0].images[0]).sort(), ["generatedUrl", "index", "sku", "sourceUrl"]);

  delete env.repository.rows.get(task.id).images[0].previewUrl;
  const legacy = await env.service.getTask({ accountId: "account-a", taskId: task.id });
  assert.equal(Object.hasOwn(legacy.images[0], "previewUrl"), false);
});

for(const action of ['pause','cancel'])test(`resume an ungrouped Excel variant after ${action} while the other variant started`,async()=>{
  const env=setup({collectSku:async({sku})=>{const value=source(1);value.sku=sku;value.items[0].sku=sku;return value;}});
  const [first]=await env.service.createFromSkus({accountId:'account-a',skus:['sku-a','sku-b'],idempotencyKey:'pause-one-variant',config:{...config,manualReview:true}});
  await env.service[`${action}Task`]({accountId:'account-a',taskId:first.id});
  assert.equal((await env.service.processNext()).status,'AWAITING_REVIEW');
  await env.service.resumeTask({accountId:'account-a',taskId:first.id});
  const result=await env.service.processNext();assert.equal(result.status,'AWAITING_REVIEW');assert.equal(result.id,first.id);
  assert.deepEqual(env.calls.map(x=>x.sku),['sku-b','sku-a']);
});

test('a confirmed task that merged cannot redirect a versioned action to a different task',async()=>{
  const env=setup();const [first,second]=await env.service.createFromSkus({accountId:'account-a',skus:['a','b'],idempotencyKey:'merge-control',config});
  const original=env.repository.rows.get(first.id);original.status='MERGED';original.mergedTaskId=second.id;
  assert.equal(original.version,env.repository.rows.get(second.id).version);
  await assert.rejects(env.service.pauseTask({accountId:'account-a',taskId:first.id,expectedVersion:first.version}),{statusCode:409});
  assert.equal(env.repository.rows.get(second.id).status,'QUEUED');
});

test('pause wins a race before the durable submission intent without sending an Ozon request',async()=>{
  let task;const env=setup({source:source(1),routeStores:async({task:current,commit})=>{
    if(current.images.every(image=>image.generatedUrl))await env.service.pauseTask({accountId:'account-a',taskId:task.id});
    await commit({targetStoreId:'store-a',targetWarehouseId:'warehouse-a'});return {selected:true};
  }});
  task=await env.create();const result=await env.service.processNext();
  assert.equal(result.status,'PAUSED');assert.equal(env.submissions.length,0);
  assert.equal(env.repository.rows.get(task.id).submissionStarted,false);
  assert.equal(result.images[0].status,'COMPLETED');
});

test('pause after preparation but before a paid request sends nothing and preserves the attempt budget',async()=>{
  let task;const env=setup({source:source(1),reserveChannel:async()=>({channelId:'test',productToken:'token',release:async()=>{}}),
    generateImage:async input=>{
      await input.onProgress('preparing');
      await env.service.pauseTask({accountId:'account-a',taskId:task.id});
      await input.beforeRequest();throw new Error('must stop before paid request');
    }});
  task=await env.create();const result=await env.service.processNext();
  assert.equal(result.status,'PAUSED');assert.equal(env.submissions.length,0);
  assert.equal(env.repository.rows.get(task.id).images[0].attempts,0);
  assert.equal(env.repository.rows.get(task.id).images[0].status,'PENDING');
});

test('a pending pause survives worker expiry and resume never resends an unknown paid request',async()=>{
  const env=setup({source:source(1)});const task=await env.create();
  const row=env.repository.rows.get(task.id);
  Object.assign(row,{status:'GENERATING',leaseToken:'expired',leaseExpiresAt:1100,controlAction:'pause'});
  row.images[0].status='GENERATING';row.images[0].attempts=1;
  env.advance(1000);assert.equal((await env.service.processNext()).status,'PAUSED');
  await env.service.resumeTask({accountId:'account-a',taskId:task.id});
  assert.equal((await env.service.processNext()).status,'GENERATION_FAILED');assert.equal(env.calls.length,0);
});

test('batch retry keeps successful images and submitted identity, while repeat apply and foreign IDs do nothing',async()=>{
  const env=setup({source:source(2)});const task=await env.create();
  const row=env.repository.rows.get(task.id);row.status='GENERATION_FAILED';row.images[0].generatedUrl='https://saved.test/a.jpg';row.images[0].status='COMPLETED';
  const preview=await env.service.previewTaskAction({accountId:'account-a',group:'errors',action:'retry'});
  const foreign=await env.service.batchTaskAction({accountId:'other-account',action:'retry',items:preview.items});assert.equal(foreign.applied,0);
  const retried=await env.service.batchTaskAction({accountId:'account-a',action:'retry',items:preview.items});assert.equal(retried.applied,1);
  assert.equal((await env.service.batchTaskAction({accountId:'account-a',action:'retry',items:preview.items})).applied,0);
  await env.service.processNext();assert.equal(env.calls.length,1);assert.equal(env.submissions[0].images[0].generatedUrl,'https://saved.test/a.jpg');
  const submitted=env.repository.rows.get(task.id);submitted.status='SUBMISSION_UNCERTAIN';const submissionKey=submitted.submissionKey;
  await env.service.retryTask({accountId:'account-a',taskId:task.id});assert.equal(env.repository.rows.get(task.id).submissionKey,submissionKey);
});

test('media preparation failure identifies the file and preserves images without blocking the next product',async()=>{
 let writes=0;
 const message='商品 sku-a 第 2 个视频准备失败：下载超时；已生成图片保留，本商品尚未提交，其他商品继续处理。';
 const secondSource=source();secondSource.collectItemId='collect-2';secondSource.sku='sku-b';secondSource.items[0].sku='sku-b';
 const env=setup({loadSources:async()=>[source(),secondSource],submitListing:async()=>{if(++writes===1)throw Object.assign(new Error(message),{code:'AI_LISTING_MEDIA_PREPARATION_FAILED',definitelyNotSubmitted:true});return {submissionId:'second'};}});
 const [first,second]=await env.service.createFromCollect({accountId:'account-a',collectItemIds:['collect-1','collect-2'],idempotencyKey:'media-pair',config});
 await env.service.processNext();
 const failed=await env.service.getTask({accountId:'account-a',taskId:first.id});
 assert.equal(failed.status,'SUBMISSION_FAILED');assert.equal(failed.errorMessage,message);assert.equal(failed.images.filter(image=>image.generatedUrl).length,8);
 // A separate task remains runnable after the first product's preparation error.
 await env.service.processNext();assert.equal((await env.service.getTask({accountId:'account-a',taskId:second.id})).status,'SUBMITTED');
});

test("missing currency conversion stops only submission with a safe actionable explanation", async () => {
  const env = setup({ submitListing: async () => { throw Object.assign(new Error("DO_NOT_EXPOSE_PROVIDER_DETAILS"), {
    code: "AI_LISTING_CURRENCY_CONVERSION_REQUIRED", definitelyNotSubmitted: true,
  }); } });
  const task = await env.create(); await env.service.processNext();
  const result = await env.service.getTask({ accountId: "account-a", taskId: task.id });
  assert.equal(result.status, "SUBMISSION_FAILED");
  assert.equal(result.images.filter(image => image.generatedUrl).length, 8);
  assert.match(result.errorMessage, /币种.*汇率/);
  assert.ok(!result.errorMessage.includes("DO_NOT_EXPOSE"));
});
function source(count = 8) {
  return { collectItemId: "collect-1", sku: "sku-a", name: "Original product", thumbnail: "https://source.test/a.jpg",
    items: [{ sku: "sku-a", images: Array.from({ length: count }, (_, index) => `https://source.test/${index}.jpg`),
      listingItem: { weight: 250, depth: 120, width: 130, height: 140, name: "Listing only", price: "12.34", attributes: [{ id: 1, value: "DO NOT SEND TO AI" }] } }],
    sourceSnapshot: { privateMetadata: "INTERNAL ONLY" } };
}
function setup(overrides = {}) {
  const repository = overrides.repository || memoryRepository();
  const original = overrides.source || source();
  const calls = []; const submissions = []; let now = 1000;
  const ports = { repository, clock: () => now,
    loadSources: async () => [copy(original)], collectSku: async () => copy(original),
    generateImage: async (input) => { calls.push(copy(input)); return { generatedUrl: `https://generated.test/${input.sku}/${input.index}.png` }; },
    submitListing: async ({checkControl,beforeExternalWrite,...input}) => { if(!input.deferImport)await beforeExternalWrite();submissions.push(copy(input)); return { submissionId: "submission-1" }; },
    readSubmission: async () => ({ status: "COMPLETED" }), ...overrides };
  const service = createAiListingService(ports);
  const create = async (extra = {}) => (await service.createFromCollect({ accountId: "account-a", collectItemIds: ["collect-1"],
    idempotencyKey: "request-1", config: { ...config, ...extra } }))[0];
  return { service, repository, calls, submissions, original, create, advance: (ms) => { now += ms; }, ports };
}

function mixedSource() {
  const original=source(1);
  original.items.push({...structuredClone(original.items[0]),sku:'sku-b',images:['https://source.test/b.jpg']});
  return original;
}
test('missing-green SKU is skipped before generation while its sibling reaches submission',async()=>{
  const env=setup({source:mixedSource(),checkSource:async({source})=>({...source,skuPricing:[
    {sku:'sku-a',status:'SKIPPED',code:'SALE_PRICING_SKU_SKIPPED',reason:'缺少绿标价'},
    {sku:'sku-b',status:'READY',priceBasis:'GREEN_PRICE'},
  ]})});
  const task=await env.create();
  for(let n=0;n<5;n++){await env.service.processNext();env.advance(30000);}
  assert.deepEqual(env.calls.map(row=>row.sku),['sku-b']);
  assert.deepEqual(env.submissions[0].source.items.map(row=>row.sku),['sku-b']);
  const result=await env.service.getTask({accountId:'account-a',taskId:task.id});
  assert.equal(result.status,'COMPLETED');
  assert.equal(result.skuProgress.find(row=>row.sku==='sku-a').status,'SKIPPED');
});
test('unknown paid request blocks first submission of the entire product and retry preserves every successful image',async()=>{
  const calls=[];
  const env=setup({source:mixedSource(),generateImage:async input=>{
    calls.push(input.sku);
    if(input.sku==='sku-a')throw Object.assign(new Error('timeout'),{code:'RETRYABLE_GATEWAY',deliveryState:'POSSIBLY_SENT'});
    return {generatedUrl:'https://generated.test/b.png'};
  }});
  const task=await env.create();
  for(let n=0;n<6;n++){await env.service.processNext();env.advance(30000);}
  let result=await env.service.getTask({accountId:'account-a',taskId:task.id});
  assert.deepEqual(calls,['sku-a','sku-b']);
  assert.equal(result.status,'GENERATION_FAILED');
  assert.equal(env.submissions.length,0);
  assert.equal(result.images.find(image=>image.sku==='sku-b').generatedUrl,'https://generated.test/b.png');
  await env.service.retryTask({accountId:'account-a',taskId:task.id,expectedVersion:result.version});
  for(let n=0;n<3;n++){await env.service.processNext();env.advance(30000);}
  assert.deepEqual(calls,['sku-a','sku-b']);
  result=await env.service.getTask({accountId:'account-a',taskId:task.id});
  assert.equal(result.skuProgress.find(row=>row.sku==='sku-a').status,'RESULT_UNKNOWN');
  assert.equal(env.submissions.length,0);
});

test('a failed variant blocks generation and media handoff until only its missing image is recovered',async()=>{
  for(const phase of ['generate','media']){
    const env=setup({source:mixedSource()});const task=await env.create();
    const row=env.repository.rows.get(task.id);
    row.images[0].status='GENERATION_FAILED';row.images[0].errorMessage='保存的失败原因';
    row.images[1].status='COMPLETED';row.images[1].generatedUrl='https://generated.test/retained-b.png';
    if(phase==='media')Object.assign(row,{status:'SUBMITTING',submissionStarted:true,submissionStage:'preparing_media'});
    const blocked=await env.service.processNext({phase});
    assert.equal(blocked.status,'GENERATION_FAILED',phase);assert.equal(env.submissions.length,0,phase);
    assert.equal(env.calls.length,0,phase);
    await env.service.retryTask({accountId:'account-a',taskId:task.id});
    await env.service.processNext();
    assert.deepEqual(env.calls.map(image=>image.sku),['sku-a'],phase);
    assert.deepEqual(env.submissions[0].source.items.map(item=>item.sku),['sku-a','sku-b'],phase);
    assert.equal(env.submissions[0].images.find(image=>image.sku==='sku-b').generatedUrl,'https://generated.test/retained-b.png');
  }
});

test('an old locally prepared partial product can be read but cannot make its first external write',async()=>{
  let reads=0,writes=0;
  const env=setup({source:mixedSource(),readSubmission:async input=>{
    reads++;assert.equal(input.submissionId,'prepared-original');await input.beforeExternalWrite();writes++;
    return {status:'COMPLETED'};
  }});
  const task=await env.create();const row=env.repository.rows.get(task.id);
  Object.assign(row,{status:'READY_TO_SUBMIT',submissionStage:'prepared',submissionId:'prepared-original',
    submissionStarted:true,submittedSkus:['sku-b']});
  row.images[0].status='GENERATION_FAILED';row.images[0].resultUnknown=true;
  row.images[1].status='COMPLETED';row.images[1].generatedUrl='https://generated.test/retained-b.png';
  const blocked=await env.service.processNext({phase:'finalize'});
  assert.equal(reads,1);assert.equal(writes,0);
  assert.equal(blocked.status,'GENERATION_FAILED');assert.match(blocked.errorMessage,/整组|全部/);
  assert.equal(env.repository.rows.get(task.id).submissionExternalWriteStarted,undefined);
  assert.equal(env.calls.length,0);assert.equal(env.submissions.length,0);
});

test('a complete variant product proceeds through generation, media preparation and the external write fence once',async()=>{
  let writes=0;
  const env=setup({source:mixedSource(),readSubmission:async input=>{
    await input.beforeExternalWrite();writes++;
    return {status:'COMPLETED',items:['sku-a','sku-b'].map(sku=>({sku,importStatus:'SUCCEEDED',stockStatus:'COMPLETED'}))};
  }});
  const task=await env.create();
  assert.equal((await env.service.processNext({phase:'generate'})).status,'READY_TO_SUBMIT');
  assert.deepEqual(env.calls.map(image=>image.sku),['sku-a','sku-b']);assert.equal(env.submissions.length,0);
  await env.service.processNext({phase:'media'});
  assert.equal(env.submissions.length,1);assert.equal(env.submissions[0].deferImport,true);assert.equal(writes,0);
  assert.deepEqual(env.submissions[0].source.items.map(item=>item.sku),['sku-a','sku-b']);
  assert.equal((await env.service.processNext({phase:'finalize'})).status,'COMPLETED');
  assert.equal(writes,1);assert.equal(env.submissions.length,1);
  assert.equal(env.repository.rows.get(task.id).submissionExternalWriteStarted,true);
});

test('historical sent or successful partial products continue original result and stock recovery despite an unknown sibling',async()=>{
  for(const evidence of ['sent','succeeded']){
    let reads=0,writes=0;
    const env=setup({source:mixedSource(),readSubmission:async input=>{
      reads++;assert.equal(input.submissionId,'original');await input.beforeExternalWrite();writes++;
      return {status:'COMPLETED',items:[{sku:'sku-b',importStatus:'SUCCEEDED',stockStatus:'COMPLETED'}]};
    }});
    const task=await env.create();const row=env.repository.rows.get(task.id);
    Object.assign(row,{status:'SUBMITTED',submissionId:'original',submissionStarted:true});
    if(evidence==='sent')row.submissionExternalWriteStarted=true;
    else row.submissionResults=[{sku:'sku-b',importStatus:'SUCCEEDED',stockStatus:'PENDING'}];
    row.images[0].status='GENERATION_FAILED';row.images[0].resultUnknown=true;
    row.images[1].status='COMPLETED';row.images[1].generatedUrl='https://generated.test/retained-b.png';
    const outcome=await env.service.processNext({phase:'finalize'});
    assert.equal(reads,1,evidence);assert.equal(writes,1,evidence);
    assert.equal(outcome.submissionId,'original');assert.equal(outcome.status,'GENERATION_FAILED');
    assert.equal(outcome.submissionResults[0].stockStatus,'COMPLETED');
    assert.equal(env.calls.length,0);assert.equal(env.submissions.length,0);
  }
});
test('a completed task with skipped SKUs requires explicit current pricing adoption to recover only skipped work',async()=>{
  const env=setup({source:mixedSource(),checkSource:async({source,config})=>({...source,skuPricing:source.items.map(row=>({sku:row.sku,
    status:row.sku==='sku-a'&&!config.salePricing?.useBlackPriceWhenGreenMissing?'SKIPPED':'READY',reason:'缺少绿标价'}))})});
  const task=await env.create({salePricingId:'profile'});
  for(let n=0;n<4;n++){await env.service.processNext();env.advance(30000);}
  let result=await env.service.getTask({accountId:'account-a',taskId:task.id});
  assert.equal(result.status,'COMPLETED');assert.equal(result.taskActions.retry,true);
  await assert.rejects(env.service.retryTask({accountId:'account-a',taskId:task.id,expectedVersion:result.version}),{code:'AI_LISTING_PRICING_REFRESH_REQUIRED'});
  await env.service.retryTask({accountId:'account-a',taskId:task.id,expectedVersion:result.version,refreshSalePricing:true},
    {beforeRetry:async()=>({salePricing:{useBlackPriceWhenGreenMissing:true}})});
  for(let n=0;n<4;n++){await env.service.processNext();env.advance(30000);}
  assert.deepEqual(env.calls.map(row=>row.sku),['sku-b','sku-a']);
  result=await env.service.getTask({accountId:'account-a',taskId:task.id});
  assert.equal(result.status,'COMPLETED');assert.equal(result.taskActions.retry,false);
});
test('three definitely-unsent quota failures do not consume the SKU generation attempt budget',async()=>{
  let calls=0;
  const env=setup({source:source(1),generateImage:async()=>{
    if(++calls<=3)throw Object.assign(new Error('quota'),{code:'AI_GATEWAY_QUOTA_EXHAUSTED',deliveryState:'NOT_SENT',channelId:`quota-${calls}`});
    return {generatedUrl:'https://generated.test/after-quota.png'};
  }});
  const task=await env.create();
  for(let n=0;n<3;n++){
    assert.equal((await env.service.processNext()).status,'GENERATING');
    assert.equal(env.repository.rows.get(task.id).images[0].attempts,0);
    env.advance(30000);
  }
  await env.service.processNext();
  assert.equal(calls,4);assert.equal(env.submissions.length,1);
  assert.equal(env.repository.rows.get(task.id).images[0].attempts,1);
});

test('Excel waits durably for extension capture, releases its lease and resumes without another job or early generation', async () => {
  let captured = false;
  const requests = [];
  const env = setup({ collectSku: async request => {
    requests.push(copy(request));
    if (!captured) throw Object.assign(new Error('等待已登录的扩展领取'), {
      code: 'AI_LISTING_COLLECTION_PENDING', collectionJobId: 'wc-one',
    });
    return source(1);
  } });
  const [task] = await env.service.createFromSkus({ accountId: 'account-a', skus: ['1602438352'], idempotencyKey: 'excel-wait', config });
  const first = await env.service.processNext();
  assert.equal(first.status, 'COLLECTING');
  assert.match(first.errorMessage, /扩展/);
  assert.equal(env.calls.length, 0);
  assert.equal(env.repository.rows.get(task.id).leaseToken, null);
  env.advance(30000);
  await env.service.processNext();
  assert.equal(requests[1].collectionJobId, 'wc-one');
  assert.equal(requests[1].taskId, task.id);
  captured = true;
  env.advance(30000);
  await env.service.processNext();
  env.advance(30000);
  await env.service.processNext();
  assert.equal(env.calls.length, 1);
});

test('Excel waits for Seller packaging before freezing captured source, then resumes with completed data', async () => {
  let pending = true;
  const env = setup({ collectSku: async () => ({ ...source(1), enrichmentJobs: [{ sku: 'sku-a', status: pending ? 'PROCESSING' : 'SUCCESS' }] }) });
  const [task] = await env.service.createFromSkus({ accountId: 'account-a', skus: ['1602438352'], idempotencyKey: 'excel-enrichment', config });
  assert.equal((await env.service.processNext()).status, 'COLLECTING');
  assert.equal(env.repository.rows.get(task.id).source, null);
  assert.equal(env.calls.length, 0);
  pending = false;
  env.advance(30000);
  await env.service.processNext();
  env.advance(30000);
  await env.service.processNext();
  assert.equal(env.calls.length, 1);
});

test("generates all eight originals in order, keeps metadata local and stops for review", async () => {
  const env = setup(); const before = copy(env.original); const task = await env.create({ manualReview: true });
  await env.service.processNext();
  assert.deepEqual(env.calls.map(c => c.sourceUrl), env.original.items.flatMap(i => i.images));
  assert.equal(env.submissions.length, 0);
  const done = await env.service.getTask({ accountId: "account-a", taskId: task.id });
  assert.equal(done.status, "AWAITING_REVIEW"); assert.equal(done.images.length, 8);
  assert.equal(done.images[7].generatedUrl, "https://generated.test/sku-a/7.png");
  assert.deepEqual(env.original, before);
  assert.deepEqual(Object.keys(done).sort(), ["id", "version", "taskActions", "controlAction", "deletedAt", "sourceType", "collectItemId", "sku", "name", "thumbnail", "config", "status", "images", "skuProgress", "createdAt", "updatedAt", "errorMessage", "submissionId", "createdSkuCount", "totalSkuCount"].sort());
  assert.ok(!JSON.stringify(done).includes("INTERNAL ONLY"));
  for (const call of env.calls) {
    assert.deepEqual(Object.keys(call).sort(), ["accountId", "taskId", "sku", "index", "sourceUrl", "prompt", "image", "requestKey", "excludeChannelIds"].sort());
    assert.equal(call.prompt, AI_LISTING_DEFAULT_PROMPT);
    assert.deepEqual(call.image, { ratio: "3:4", language: "ru", resolution: "2K", quality: "high" });
  }
});

test("two variant SKUs retain independent ordered images in the listing port", async () => {
  const original = source(2);
  original.items.push({ sku: "sku-b", images: ["https://source.test/b0.jpg", "https://source.test/b1.jpg"], listingItem: { weight: 350, depth: 150, width: 160, height: 170, name: "Variant B" } });
  const env = setup({ source: original }); await env.create(); await env.service.processNext();await env.service.processNext();
  assert.deepEqual(env.calls.map(c => c.sourceUrl), original.items.flatMap(i => i.images));
  assert.deepEqual(env.submissions[0].images.map(({ sku, index, generatedUrl }) => ({ sku, index, generatedUrl })), [
    { sku: "sku-a", index: 0, generatedUrl: "https://generated.test/sku-a/0.png" },
    { sku: "sku-a", index: 1, generatedUrl: "https://generated.test/sku-a/1.png" },
    { sku: "sku-b", index: 0, generatedUrl: "https://generated.test/sku-b/0.png" },
    { sku: "sku-b", index: 1, generatedUrl: "https://generated.test/sku-b/1.png" },
  ]);
  assert.deepEqual(env.submissions[0].source.items, original.items);
});

test("checkpoints successes before an image failure and resumes only missing images after restart", async () => {
  const seen = []; let fail = true;
  const env = setup({ generateImage: async (input) => {
    seen.push(input.index);
    if (input.index === 2 && fail) { fail = false; throw new Error("secret upstream response"); }
    return { generatedUrl: `https://generated.test/${input.index}.png` };
  } });
  const task = await env.create({ manualReview: true }); await env.service.processNext();
  const failed = await env.service.getTask({ accountId: "account-a", taskId: task.id });
  assert.equal(failed.status, "GENERATION_FAILED");
  assert.equal(failed.images[0].generatedUrl, "https://generated.test/0.png");
  assert.ok(!JSON.stringify(failed).includes("secret"));
  const restarted = createAiListingService(env.ports);
  await restarted.retryTask({ accountId: "account-a", taskId: task.id }); await restarted.processNext();
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 2]);
  assert.equal((await restarted.getTask({ accountId: "account-a", taskId: task.id })).status, "AWAITING_REVIEW");
});

test("custom prompt and image options reach only the image port; precise listing config stays local", async () => {
  let sourceConfig;
  const env = setup({ loadSources: async ({ config: value }) => { sourceConfig = value; return [source(1)]; } });
  await env.create({ prompt: "Keep logo exactly", image: { ratio: "1:1", quality: "standard", language: "en", resolution: "1K" },
    brandMode: "PREFER_SOURCE", priceAdjustmentKopecks: -17, priceMultiplier: "1.230000000000000001" });
  await env.service.processNext();
  assert.equal(env.calls[0].prompt, "Keep logo exactly"); assert.equal(env.calls[0].image.ratio, "1:1");
  assert.equal(sourceConfig.prompt, undefined); assert.equal(sourceConfig.image, undefined);
  assert.equal(env.submissions[0].config.prompt, undefined); assert.equal(env.submissions[0].config.image, undefined);
  assert.equal(env.submissions[0].config.priceAdjustmentKopecks, -17);
  assert.equal(env.submissions[0].config.priceMultiplier, "1.230000000000000001");
  assert.equal(env.submissions[0].config.brandMode, "PREFER_SOURCE");
});

test("automatic mode submits once and later polls the same submission", async () => {
  const env = setup(); const task = await env.create(); await env.service.processNext();
  assert.equal(env.submissions.length, 1);
  assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "SUBMITTED");
  env.advance(30000); await env.service.processNext(); await env.service.processNext();
  assert.equal(env.submissions.length, 1);
  assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "COMPLETED");
});

test("approval releases review once without regenerating", async () => {
  const env = setup(); const task = await env.create({ manualReview: true }); await env.service.processNext();
  assert.equal(env.submissions.length, 0);
  await env.service.approveTask({ accountId: "account-a", taskId: task.id }); await env.service.processNext();
  assert.equal(env.submissions.length, 1); assert.equal(env.calls.length, 8);
  await assert.rejects(env.service.approveTask({ accountId: "account-a", taskId: task.id }), { statusCode: 409 });
});

test("get/retry/cancel/approve and list cannot cross accounts", async () => {
  const env = setup(); const task = await env.create();
  for (const action of ["getTask", "retryTask", "cancelTask", "approveTask"]) {
    await assert.rejects(env.service[action]({ accountId: "account-b", taskId: task.id }), { statusCode: 404 });
  }
  assert.deepEqual(await env.service.listTasks({ accountId: "account-b" }), []);
});

test("cancellation during an in-flight image cannot be overwritten or submit", async () => {
  let finish; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const env = setup({ generateImage: async () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  const task = await env.create(); const processing = env.service.processNext(); await entered;
  await env.service.cancelTask({ accountId: "account-a", taskId: task.id });
  finish({ generatedUrl: "https://generated.test/late.png" }); await processing;
  assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "CANCELLED");
  assert.equal(env.submissions.length, 0); assert.equal(await env.service.processNext(), null);
});

test("creation is idempotent per account and rejects changing an existing request config", async () => {
  const env = setup(); const first = await env.create(); const second = await env.create();
  assert.equal(first.id, second.id); assert.equal((await env.service.listTasks({ accountId: "account-a" })).length, 1);
  await assert.rejects(env.create({ stock: 10 }), { statusCode: 409 });
});

test("ambiguous submission pauses, then explicit retry uses stable key and no image regeneration", async () => {
  const sent = []; let fail = true;
  const env = setup({ submitListing: async (input) => {
    sent.push(input.idempotencyKey);
    if (fail) { fail = false; throw new Error("network disappeared after send"); }
    return { submissionId: "submission-1" };
  } });
  const task = await env.create(); await env.service.processNext();
  assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "SUBMISSION_UNCERTAIN");
  await env.service.processNext(); assert.equal(sent.length, 1);
  await env.service.retryTask({ accountId: "account-a", taskId: task.id }); await env.service.processNext();
  assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]); assert.equal(env.calls.length, 8);
});

test("uncertain submission remains non-cancellable after retry and restart before the worker claims it", async () => {
  let sent = 0;
  const env = setup({ submitListing: async () => { sent++; throw new Error("accepted externally, response lost"); } });
  const task = await env.create(); await env.service.processNext();
  assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "SUBMISSION_UNCERTAIN");
  const retried = await env.service.retryTask({ accountId: "account-a", taskId: task.id });
  assert.equal(retried.status, "READY_TO_SUBMIT");
  const restarted = createAiListingService(env.ports);
  await assert.rejects(restarted.cancelTask({ accountId: "account-a", taskId: task.id }), { statusCode: 409 });
  assert.equal((await restarted.getTask({ accountId: "account-a", taskId: task.id })).status, "READY_TO_SUBMIT");
  assert.equal(sent, 1); assert.equal(env.calls.length, 8);
});

test("upload failure has its own status and retains previously stored images", async () => {
  const env = setup({ generateImage: async ({ index }) => {
    if (index === 1) throw Object.assign(new Error("private upload response"), { stage: "upload" });
    return { generatedUrl: "https://generated.test/0.png" };
  } }); const task = await env.create(); await env.service.processNext();
  const failed = await env.service.getTask({ accountId: "account-a", taskId: task.id });
  assert.equal(failed.status, "UPLOAD_FAILED"); assert.equal(failed.images[1].status, "UPLOAD_FAILED");
  assert.equal(failed.images[0].generatedUrl, "https://generated.test/0.png"); assert.equal(env.submissions.length, 0);
});

test("queued SKU collection is persisted before work and retried independently", async () => {
  let attempts = 0;
  const env = setup({ collectSku: async ({ sku, config: value }) => {
    attempts++; assert.equal(sku, "sku-a"); assert.equal(value.prompt, undefined);
    if (attempts === 1) throw new Error("collect unavailable"); return source(1);
  } });
  const [task] = await env.service.createFromSkus({ accountId: "account-a", skus: ["sku-a", "sku-a"], idempotencyKey: "excel-1", config });
  assert.equal(attempts, 0); assert.equal(task.sourceType, "EXCEL");
  await env.service.processNext(); assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "COLLECTION_FAILED");
  await env.service.retryTask({ accountId: "account-a", taskId: task.id }); await env.service.processNext();
  assert.equal(attempts, 2); assert.equal(env.submissions.length, 1);
});

test("expired in-flight generation is not automatically replayed after restart", async () => {
  const env = setup(); const task = await env.create();
  const stored = env.repository.rows.get(task.id);
  stored.status = "GENERATING"; stored.images[0].status = "GENERATING";
  stored.leaseToken = "dead-worker"; stored.leaseExpiresAt = 999;
  await env.service.processNext(); assert.equal(env.calls.length, 0);
  assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "GENERATION_FAILED");
});

test("normalizes only allowed config, defaults switches off and rejects invalid money", () => {
  const value = normalizeAiListingConfig({ ...config, apiKey: "secret" });
  assert.equal(value.brandMode, "FORCE_NO_BRAND"); assert.equal(value.manualReview, false);
  assert.equal(value.stock, 5); assert.equal(value.priceAdjustmentKopecks, 0); assert.equal(value.priceMultiplier, "1");
  assert.equal(value.apiKey, undefined);
  for (const patch of [{ priceAdjustmentKopecks: 0.5 }, { priceMultiplier: 1.2 }, { priceMultiplier: "0" }, { stock: -1 }, { manualReview: "false" }]) {
    assert.throws(() => normalizeAiListingConfig({ ...config, ...patch }), { statusCode: 400 });
  }
});

test("a null configuration produces a client validation error rather than an internal exception", () => {
  assert.throws(() => normalizeAiListingConfig(null), { statusCode: 400 });
});

test("unknown sent submission recovered after restart pauses without invoking the write port", async () => {
  const env = setup(); const task = await env.create();
  const row = env.repository.rows.get(task.id);
  row.status = "SUBMITTING"; row.leaseToken = "dead-worker"; row.leaseExpiresAt = 999;
  await env.service.processNext();
  assert.equal(env.submissions.length, 0); assert.equal(env.calls.length, 0);
  assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "SUBMISSION_UNCERTAIN");
});

test("an active lease prevents another worker from generating the same task", async () => {
  let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const env = setup({ source: source(1), generateImage: async () => {
    started(); return new Promise(resolve => { release = resolve; });
  } });
  await env.create({ manualReview: true });
  const processing = env.service.processNext(); await entered;
  assert.equal(await createAiListingService(env.ports).processNext(), null);
  release({ generatedUrl: "https://generated.test/only.png" });
  assert.equal((await processing).status, "AWAITING_REVIEW");
});

test("lease heartbeat preserves a slow in-flight request without duplicate generation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const env = setup({ source: source(1), generateImage: async () => {
    started(); return new Promise(resolve => { release = resolve; });
  } });
  await env.create({ manualReview: true });
  const processing = env.service.processNext(); await entered;
  for (let index = 0; index < 4; index++) {
    env.advance(30000); t.mock.timers.tick(30000);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(await createAiListingService(env.ports).processNext(), null);
  release({ generatedUrl: "https://generated.test/slow.png" });
  assert.equal((await processing).status, "AWAITING_REVIEW");
});

test("cancel after the atomic external-write fence is rejected without pretending the external write was undone", async () => {
  let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const env = setup({ source: source(1), submitListing: async input => {
    await input.beforeExternalWrite();started(); return new Promise(resolve => { release = resolve; });
  } });
  const task = await env.create(); const processing = env.service.processNext(); await entered;
  await assert.rejects(env.service.cancelTask({ accountId: "account-a", taskId: task.id }), { statusCode: 409 });
  release({ submissionId: "submission-1" }); assert.equal((await processing).status, "SUBMITTED");
});

test("submission failure and poll transport failure retain images and distinguish final from transient results", async () => {
  let pollCount = 0;
  const env = setup({ readSubmission: async () => {
    pollCount++;
    if (pollCount === 1) throw new Error("secret credentials");
    return { status: "FAILED", errorMessage: "unsafe upstream response" };
  } }); const task = await env.create(); await env.service.processNext();
  env.advance(30000); await env.service.processNext();
  assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "SUBMITTED");
  env.advance(30000); await env.service.processNext();
  const failed = await env.service.getTask({ accountId: "account-a", taskId: task.id });
  assert.equal(failed.status, "SUBMISSION_FAILED"); assert.equal(failed.images.filter(image => image.generatedUrl).length, 8);
  assert.ok(!JSON.stringify(failed).includes("unsafe")); assert.equal(env.submissions.length, 1);
});

test("original download failures report the actionable stage without provider details", async () => {
  const env = setup({ generateImage: async () => {
    throw Object.assign(new Error("PRIVATE_DIAGNOSTIC_DETAILS"), { code: "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED" });
  } });
  await env.create();
  const result = await env.service.processNext();
  assert.equal(result.status, "GENERATION_FAILED");
  assert.equal(result.errorMessage, "原图下载被安全检查拦截，请检查图片链接");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_DIAGNOSTIC_DETAILS"));
});


test("gateway capacity failure explains unavailable channels without exposing credentials", async () => {
  const env = setup({ generateImage: async () => {
    throw Object.assign(new Error("PRIVATE_UPSTREAM_RESPONSE"), { code: "AI_GATEWAY_NO_CAPACITY" });
  } });
  await env.create();
  const result = await env.service.processNext();
  assert.match(result.errorMessage, /等待可用通道/);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_UPSTREAM_RESPONSE"));
});

test("interrupted image preserves diagnostics and explicit retry resumes only missing images", async () => {
  let fail = true; const indexes = [];
  const env = setup({ source: source(3), generateImage: async ({ index }) => {
    indexes.push(index);
    if (index === 1 && fail) throw Object.assign(new Error("PRIVATE_PROVIDER_MESSAGE"), { code: "AI_GATEWAY_UNEXPECTED_EOF", requestId: "request-interrupted-1" });
    return { generatedUrl: `https://generated.test/${index}.jpg` };
  } });
  const task = await env.create({ manualReview: true });
  const failed = await env.service.processNext();
  assert.match(failed.errorMessage, /等待自动补试/);
  assert.equal(env.repository.rows.get(task.id).images[1].lastError.requestId, "request-interrupted-1");
  assert.equal(await env.service.processNext(), null);
  fail = false; env.advance(120000);
  assert.equal((await env.service.processNext()).status, "AWAITING_REVIEW");
  assert.deepEqual(indexes, [0, 1, 2, 1]);
});

test("isolated transient failure continues other images and retries once after delay across restart", async () => {
  const indexes = []; let failed = false;
  const env = setup({ source: source(3), generateImage: async ({ index }) => {
    indexes.push(index);
    if (index === 0 && !failed) { failed = true; throw Object.assign(new Error(), { code: "AI_GATEWAY_UNEXPECTED_EOF" }); }
    return { generatedUrl: `https://generated.test/${index}.png` };
  } });
  await env.create({ manualReview: true });
  const first = await env.service.processNext();
  assert.deepEqual(indexes, [0, 1, 2]);
  assert.equal(first.status, "GENERATING");
  assert.equal(env.submissions.length, 0);
  assert.equal(await env.service.processNext(), null);
  env.advance(120000);
  const restarted = createAiListingService(env.ports);
  assert.equal((await restarted.processNext()).status, "AWAITING_REVIEW");
  assert.deepEqual(indexes, [0, 1, 2, 0]);
});

test("two consecutive channel failures pause without attempting all remaining images", async () => {
  const indexes = [];
  const env = setup({ generateImage: async ({ index }) => {
    indexes.push(index); throw Object.assign(new Error(), { code: "AI_GATEWAY_UNEXPECTED_EOF" });
  } });
  await env.create();
  const result = await env.service.processNext();
  assert.deepEqual(indexes, [0, 1]);
  assert.equal(result.status, "GENERATION_FAILED");
  assert.match(result.errorMessage, /连续.*暂停/);
  env.advance(3600000);
  assert.equal(await env.service.processNext(), null);
  assert.equal(env.submissions.length, 0);
});

test("one image gets at most one automatic retry and never submits an incomplete task", async () => {
  let count = 0;
  const env = setup({ source: source(1), generateImage: async () => {
    count++; throw Object.assign(new Error(), { code: "AI_GATEWAY_STREAM_TIMEOUT" });
  } });
  await env.create(); await env.service.processNext(); env.advance(120000);
  const result = await env.service.processNext();
  assert.equal(count, 2); assert.equal(result.status, "GENERATION_FAILED");
  env.advance(3600000); assert.equal(await env.service.processNext(), null);
  assert.equal(env.submissions.length, 0);
});

test("task automatic retry budget stops at three extra calls even with nonconsecutive failures", async () => {
  const counts = new Map();
  const env = setup({ generateImage: async ({ index }) => {
    const count = (counts.get(index) || 0) + 1; counts.set(index, count);
    if (index % 2 === 0 && count === 1) throw Object.assign(new Error(), { code: "AI_GATEWAY_UNEXPECTED_EOF" });
    return { generatedUrl: `https://generated.test/${index}.png` };
  } });
  await env.create(); await env.service.processNext(); env.advance(120000);
  const result = await env.service.processNext();
  assert.equal([...counts.values()].reduce((a,b) => a+b,0), 11);
  assert.equal(result.images.filter(image => image.generatedUrl).length, 7);
  assert.equal(result.status, "GENERATION_FAILED");
  assert.equal(env.submissions.length, 0);
});

test("model configuration failures pause the task before requesting remaining images", async () => {
  for (const code of ["AI_LISTING_MODEL_UNAVAILABLE", "AI_GATEWAY_MODEL_UNAVAILABLE"]) {
    let calls = 0;
    const env = setup({ source: source(3), generateImage: async () => {
      calls++; throw Object.assign(new Error("PRIVATE_UPSTREAM_RESPONSE"), { code });
    } });
    await env.create();
    const result = await env.service.processNext();
    assert.equal(calls, 1);
    assert.equal(result.status, "GENERATION_FAILED");
    assert.match(result.errorMessage, /模型/);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_UPSTREAM_RESPONSE"));
  }
});

test('failed image switches channels while keeping other completed images',async()=>{
 const calls=[];let failures=0;
 const env=setup({source:source(2),generateImage:async input=>{
  calls.push(copy(input));
  if(input.index===0&&failures++<2)throw Object.assign(new Error('failed'),{code:'AI_GATEWAY_UNEXPECTED_EOF',channelId:failures===1?'a':'b'});
  return {generatedUrl:`https://generated.test/${input.taskId}/${input.index}.png`};
 }});
 const task=await env.create({manualReview:true});
 await env.service.processNext();await env.service.processNext();await env.service.processNext();
 assert.deepEqual(calls.map(c=>c.index),[0,1,0,0]);
 assert.deepEqual(calls[3].excludeChannelIds,['a','b']);
 assert.equal(new Set(calls.map(c=>c.requestKey)).size,4);
 assert.equal((await env.service.getTask({accountId:'account-a',taskId:task.id})).status,'AWAITING_REVIEW');
});

test('busy channels wait across service restart without charging an attempt',async()=>{
 let available=false;let sent=0;
 const env=setup({source:source(1),generateImage:async()=>{
  if(!available)throw Object.assign(new Error('busy'),{code:'AI_GATEWAY_NO_CAPACITY'});
  sent++;return{generatedUrl:'https://generated.test/recovered.png'};
 }});
 const task=await env.create({manualReview:true});await env.service.processNext();
 assert.equal(env.repository.rows.get(task.id).images[0].attempts,0);
 assert.equal(sent,0);available=true;env.advance(15000);
 const restarted=createAiListingService(env.ports);await restarted.processNext();
 assert.equal(sent,1);assert.equal((await restarted.getTask({accountId:'account-a',taskId:task.id})).status,'AWAITING_REVIEW');
});

test('result received during cancellation is saved only to its original task',async()=>{
 let resolveA;let started;const start=new Promise(r=>started=r);
 const env=setup({source:source(1),generateImage:input=>{started();return new Promise(r=>resolveA=()=>r({generatedUrl:`https://generated.test/${input.taskId}.png`}));}});
 const a=await env.create({manualReview:true});const pending=env.service.processNext();await start;
 await env.service.cancelTask({accountId:'account-a',taskId:a.id});
 const b=(await env.service.createFromCollect({accountId:'account-a',collectItemIds:['collect-1'],idempotencyKey:'other-product',config:{...config,manualReview:true}}))[0];
 resolveA();await pending;
 assert.equal(env.repository.rows.get(a.id).status,'CANCELLED');
 assert.ok(env.repository.rows.get(a.id).images.every(i=>i.generatedUrl===`https://generated.test/${a.id}.png`));
 assert.ok(env.repository.rows.get(b.id).images.every(i=>!i.generatedUrl));
});

test('GRID groups SKU, caps each at 12, binds out-of-order results and submits matching source snapshot', async () => {
  const original=source(15);original.items.push({...source(2).items[0],sku:'sku-b'});
  const groups=[];
  const env=setup({source:original,generateImageGroup:async input=>{groups.push(copy(input));return {images:input.sources.map(s=>({sku:input.sku,index:s.index,generatedUrl:`https://generated.test/${input.sku}/${s.index}`})).reverse()};}});
  await env.create({generationMode:'GRID'});const done=await env.service.processNext();
  assert.equal(done.status,'SUBMITTED');assert.equal(env.calls.length,0);
  assert.deepEqual(groups.map(g=>g.sources.length),[12,2]);assert.equal(done.images.length,14);
  assert.equal(done.images[12].generatedUrl,'https://generated.test/sku-b/0');
  assert.equal(env.submissions[0].source.items[0].images.length,12);assert.equal(original.items[0].images.length,15);
  assert.equal(env.submissions[0].config.generationMode,undefined);
});
test('GRID channel failure waits and switches for the same SKU without publishing partial group', async()=>{
 let count=0;const requests=[];
 const env=setup({source:source(3),generateImageGroup:async input=>{requests.push(copy(input));if(++count===1)throw Object.assign(new Error('failed'),{code:'RETRYABLE_GATEWAY',channelId:'channel-a'});return {images:input.sources.map(s=>({sku:input.sku,index:s.index,generatedUrl:`https://generated.test/${s.index}`}))};}});
 await env.create({generationMode:'GRID',manualReview:true});let done=await env.service.processNext();assert.equal(done.images.filter(i=>i.generatedUrl).length,0);
 done=await env.service.processNext();assert.equal(done.status,'AWAITING_REVIEW');assert.equal(requests.length,2);assert.deepEqual(requests[1].excludeChannelIds,['channel-a']);assert.notEqual(requests[0].requestKey,requests[1].requestKey);
});
test('GRID rejects another SKU result as a whole',async()=>{
 const env=setup({source:source(2),generateImageGroup:async input=>({images:input.sources.map(s=>({sku:'other',index:s.index,generatedUrl:'https://generated.test/wrong'}))})});
 await env.create({generationMode:'GRID'});const done=await env.service.processNext();assert.equal(done.status,'GENERATION_FAILED');assert.ok(done.images.every(i=>!i.generatedUrl));assert.equal(env.submissions.length,0);
});

test('GRID cancellation saves the complete in-flight group without submitting it',async()=>{
 let resolve,started;const pending=new Promise(r=>resolve=r),entered=new Promise(r=>started=r);
 const env=setup({source:source(2),generateImageGroup:async input=>{started();await pending;return {images:input.sources.map(s=>({sku:input.sku,index:s.index,generatedUrl:'https://generated.test/late'}))};}});
 const task=await env.create({generationMode:'GRID'});const work=env.service.processNext();await entered;
 await env.service.cancelTask({accountId:'account-a',taskId:task.id});resolve();const result=await work;
 assert.equal(result.status,'CANCELLED');assert.ok(result.images.every(i=>i.generatedUrl==='https://generated.test/late'));assert.equal(env.submissions.length,0);
});
test('GRID busy channels do not consume attempts or send individual followers',async()=>{
 let count=0;const env=setup({source:source(3),generateImageGroup:async input=>{if(++count<=4)throw Object.assign(new Error('busy'),{code:'AI_GATEWAY_NO_CAPACITY'});return {images:input.sources.map(s=>({sku:input.sku,index:s.index,generatedUrl:'https://generated.test/ok'}))};}});
 await env.create({generationMode:'GRID',manualReview:true});for(let i=0;i<4;i++){const d=await env.service.processNext();assert.equal(d.status,'GENERATING');env.advance(16000);}
 assert.equal((await env.service.processNext()).status,'AWAITING_REVIEW');assert.equal(env.calls.length,0);
});

test('successful channel retry clears task-level generation error before submitting',async()=>{
 let attempts=0,seen;
 const env=setup({source:source(1),generateImage:async()=>{if(!attempts++)throw Object.assign(new Error('failure'),{channelId:'a',code:'RETRYABLE_GATEWAY'});return {generatedUrl:'https://generated.test/ok'};},submitListing:async()=>{seen=[...env.repository.rows.values()][0];return {submissionId:'submitted'};}});
 await env.create();await env.service.processNext();await env.service.processNext();assert.equal(seen.status,'SUBMITTING');assert.equal(seen.errorMessage,null);
});

test("selected variants alone are generated and submitted; unknown variants are rejected", async()=>{
  const original=source(1);
  original.items.push({...copy(original.items[0]),sku:'sku-b',images:['https://source.test/b.png']});
  const env=setup({source:original});
  const input={accountId:'account-a',collectItemIds:['collect-1'],idempotencyKey:'variants',config,selectedSkus:{'collect-1':['sku-b']}};
  await env.service.createFromCollect(input);
  await env.service.processNext();
  assert.deepEqual(env.calls.map(c=>c.sku),['sku-b']);
  assert.deepEqual(env.submissions[0].source.items.map(i=>i.sku),['sku-b']);
  await assert.rejects(()=>env.service.createFromCollect({...input,idempotencyKey:'bad',selectedSkus:{'collect-1':['unknown']}}));
});

test('target wait reuses images; selected destination is persisted without changing frozen route config',async()=>{
 let available=false;let routingCalls=0;
 const env=setup({routeStores:async({commit})=>{routingCalls++;if(!available)return {selected:false,message:'等待店铺额度'};await commit({targetStoreId:'store-b',targetWarehouseId:'warehouse-b'});return {selected:true};}});
 const task=await env.create({autoSwitchStores:true,fallbackStores:[{targetStoreId:'store-b',targetWarehouseId:'warehouse-b'}]});
 await env.service.processNext();
 assert.equal(env.calls.length,8);assert.equal(env.submissions.length,0);
 assert.equal((await env.service.getTask({accountId:'account-a',taskId:task.id})).status,'READY_TO_SUBMIT');
 available=true;env.advance(300001);await env.service.processNext();
 assert.equal(env.calls.length,8);assert.equal(env.submissions[0].config.targetStoreId,'store-b');
 const saved=await env.service.getTask({accountId:'account-a',taskId:task.id});
 assert.equal(saved.config.targetStoreId,'store-a');assert.equal(saved.submissionTarget.targetStoreId,'store-b');assert.equal(routingCalls,2);
});

test('uncertain submission retry stays on persisted store and never routes again',async()=>{
 let routed=0;let attempts=0;
 const env=setup({routeStores:async({commit})=>{routed++;await commit({targetStoreId:'store-b',targetWarehouseId:'warehouse-b'});return {selected:true};},submitListing:async input=>{assert.equal(input.config.targetStoreId,'store-b');if(++attempts===1)throw new Error('timeout');return {submissionId:'existing'};}});
 const task=await env.create({autoSwitchStores:true,fallbackStores:[{targetStoreId:'store-b',targetWarehouseId:'warehouse-b'}]});
 await env.service.processNext();await env.service.retryTask({accountId:'account-a',taskId:task.id});await env.service.processNext();
 assert.equal(routed,1);assert.equal(env.calls.length,8);
});

test('accepted collected source generates and submits without repeating restriction checks',async()=>{
 let funding=0,checks=0;const env=setup({checkRestrictions:async()=>{checks++;throw Object.assign(new Error('平台禁售：后来新增的规则'),{code:'PRODUCT_RESTRICTION_BLOCK'});},billing:{reconcile:async input=>{if(input.reserve)funding++;return {funded:true};}}});
 const task=await env.create();await env.service.processNext();
 assert.equal(env.calls.length,8);assert.equal(env.submissions.length,1);assert.ok(funding>0);assert.equal(checks,0);
 assert.equal((await env.service.getTask({accountId:'account-a',taskId:task.id})).status,'SUBMITTED');
});

test('rule changed after collection does not block submission to the selected store',async()=>{
 const seen=[];const env=setup({checkRestrictions:async input=>{seen.push(input);if(input.stage==='submit')throw Object.assign(new Error('销售限制待核实：目标仓库禁止'),{code:'PRODUCT_RESTRICTION_REVIEW'});},routeStores:async({commit})=>{await commit({targetStoreId:'store-b',targetWarehouseId:'warehouse-b'});return {selected:true};}});
 const task=await env.create({autoSwitchStores:true,fallbackStores:[{targetStoreId:'store-b',targetWarehouseId:'warehouse-b'}]});await env.service.processNext();
 assert.equal(env.submissions.length,1);assert.equal(env.submissions[0].config.targetStoreId,'store-b');assert.deepEqual(seen,[]);
 const result=await env.service.getTask({accountId:'account-a',taskId:task.id});assert.equal(result.images.filter(i=>i.generatedUrl).length,8);assert.equal(result.status,'SUBMITTED');
});

test('partial result is durable in task DTO; explicit retry advances submission attempt without generating or charging again', async () => {
  const results=[{sku:'sku-a',offerId:'offer-a',importStatus:'SUCCEEDED',stockStatus:'COMPLETED',errors:[]},{sku:'sku-b',offerId:'offer-b',importStatus:'FAILED',stockStatus:'PENDING',errors:['ATTRIBUTE_INVALID']}];
  const env=setup({readSubmission:async()=>({status:'FAILED',items:results})});
  const task=await env.create();await env.service.processNext();env.advance(15000);await env.service.processNext();
  const failed=await env.service.getTask({accountId:'account-a',taskId:task.id});assert.deepEqual(failed.submissionResults,results);
  const imageCalls=env.calls.length;await env.service.retryTask({accountId:'account-a',taskId:task.id});await env.service.processNext();
  assert.equal(env.calls.length,imageCalls);assert.equal(env.submissions[0].retryAttempt,0);assert.equal(env.submissions[1].retryAttempt,1);assert.equal(env.submissions[0].idempotencyKey,env.submissions[1].idempotencyKey);
});

for(const status of ['FAILED','UNCERTAIN'])test(`image submission ${status} retains its actionable stage and safe explanation`,async()=>{
 const stage=status==='FAILED'?'image_failed':'repairing_images';
 const env=setup({readSubmission:async()=>({status,submissionStage:stage,items:[],errorMessage:'unsafe remote details'})});
 const task=await env.create();await env.service.processNext();env.advance(15000);await env.service.processNext();
 const saved=await env.service.getTask({accountId:'account-a',taskId:task.id});
 assert.equal(saved.submissionStage,stage);assert.match(saved.errorMessage,/图片/);assert.doesNotMatch(saved.errorMessage,/unsafe|类目/);
 assert.equal(saved.taskActions.retry,true);assert.equal(saved.taskActions.delete,true);
});

test('unresolved retained source stops before paid generation and funding',async()=>{let funding=0;const env=setup({checkSource:async()=>{throw Object.assign(new Error('category'),{code:'AI_LISTING_CATEGORY_UNRESOLVED'});},billing:{reconcile:async input=>{if(input.reserve)funding++;return {funded:true};}}});const task=await env.create();await env.service.processNext();assert.equal(env.calls.length,0);assert.equal(funding,0);const saved=await env.service.getTask({accountId:'account-a',taskId:task.id});assert.equal(saved.status,'GENERATION_FAILED');assert.match(saved.errorMessage,/保留.*来源/);});

test('accepted category snapshot is retained through generation and submission without a policy recheck',async()=>{
 const original=source(1);Object.assign(original.items[0].listingItem,{description_category_id:10,type_id:20});
 original.items[0].categoryResolution={status:'ACTIVE',sourceDescriptionCategoryId:99,sourceTypeId:20,currentDescriptionCategoryId:10,currentTypeId:20};
 const env=setup({source:original,checkRestrictions:async()=>{throw Object.assign(new Error('later category rule'),{code:'PRODUCT_RESTRICTION_BLOCK'});}});
 const task=await env.create();await env.service.processNext();
 assert.equal(env.calls.length,1);assert.equal(env.submissions.length,1);
 const submitted=env.submissions[0].source.items[0];
 assert.equal(submitted.listingItem.description_category_id,10);assert.equal(submitted.listingItem.type_id,20);
 assert.deepEqual(submitted.categoryResolution,original.items[0].categoryResolution);
 assert.deepEqual(env.repository.rows.get(task.id).source.items[0].categoryResolution,original.items[0].categoryResolution);
});

function pendingCollectSource() {
  const value = source(1);
  delete value.items[0].listingItem.weight;
  value.enrichmentJobs = [{ sku: "sku-a", status: "PENDING" }];
  value.sourceSnapshot = { accountId: "account-a", sku: "sku-a", raw: { description_category_id: 10, type_id: 20 },
    enrichment: { status: "PENDING_ENRICHMENT" } };
  return value;
}

test("collect enrichment waits without billing, releases its lease and resumes after restart with only creation-time SKUs", async () => {
  let current = pendingCollectSource(); const initial = copy(current); const reads = []; const billingCalls = [];
  const env = setup({ loadSources: async input => { reads.push(copy(input)); return [copy(current)]; },
    collectSku: async () => { throw new Error("collect-box must never call the Excel collector"); },
    billing: { reconcile: async input => { billingCalls.push(input); return { funded: true }; } } });
  const created = await env.create();
  assert.equal(created.status, "COLLECTING");
  let stored = env.repository.rows.get(created.id);
  assert.equal(stored.source, null); assert.deepEqual(stored.images, []);
  assert.deepEqual(stored.collectWait.initialSource, initial);
  assert.deepEqual(stored.collectWait.selectedSkus, ["sku-a"]);
  await env.service.processNext();
  stored = env.repository.rows.get(created.id);
  assert.equal(stored.leaseToken, null); assert.equal(stored.leaseExpiresAt, null);
  assert.equal(stored.nextRunAt, 31000);
  env.advance(29999); assert.equal(await env.service.processNext(), null);
  assert.equal(env.calls.length, 0); assert.equal(env.submissions.length, 0); assert.deepEqual(billingCalls, []);
  const restarted = createAiListingService(env.ports);
  current.enrichmentJobs[0].status = "PROCESSING";
  env.advance(1); assert.equal((await restarted.processNext()).status, "COLLECTING");
  assert.equal(env.repository.rows.get(created.id).nextRunAt, 61000);
  assert.deepEqual(billingCalls, []);
  current.items[0].listingItem.weight = 375;
  current.items.push({ sku: "new-sibling", images: ["https://source.test/new.jpg"], listingItem: {} });
  current.enrichmentJobs = [{ sku: "sku-a", status: "SUCCESS" }, { sku: "new-sibling", status: "PENDING" }];
  env.advance(30000); assert.equal((await restarted.processNext()).status, "SUBMITTED");
  assert.equal(billingCalls.filter(call => call.reserve).length, 1);
  assert.ok(billingCalls.some(call => !call.reserve), "normal billing reconciliation resumes after source freeze");
  assert.deepEqual(env.calls.map(call => call.sku), ["sku-a"]);
  assert.deepEqual(env.submissions[0].source.items.map(item => item.sku), ["sku-a"]);
  assert.equal(env.submissions[0].source.items[0].listingItem.weight, 375);
  assert.equal(env.submissions[0].config.targetStoreId, "store-a");
  assert.equal(env.submissions[0].config.targetWarehouseId, "warehouse-a");
  assert.deepEqual(env.repository.rows.get(created.id).collectWait.initialSource, initial);
  assert.ok(reads.every(read => read.accountId === "account-a" && read.collectItemIds.join() === "collect-1"));
});

test("only selected SKU enrichment can block creation; unrelated pending or failed siblings do not", async () => {
  for (const status of ["PENDING", "PROCESSING", "FAILED"]) {
    const current = source(1);
    current.items.push({ sku: "sku-b", images: [], listingItem: {} });
    current.enrichmentJobs = [{ sku: "sku-a", status: "SUCCESS" }, { sku: "sku-b", status }];
    const env = setup({ source: current });
    const [task] = await env.service.createFromCollect({ accountId: "account-a", collectItemIds: ["collect-1"],
      selectedSkus: { "collect-1": ["sku-a"] }, idempotencyKey: "selected", config });
    await env.service.processNext();
    assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "SUBMITTED");
    assert.deepEqual(env.calls.map(call => call.sku), ["sku-a"]);
  }
});

test("selected pending variant cannot expand to the primary or a sibling after Seller completion", async () => {
  const current = source(1);
  current.items.push({ sku: "sku-b", images: [], listingItem: {} });
  current.enrichmentJobs = [{ sku: "sku-b", status: "PENDING" }];
  const env = setup({ loadSources: async () => [copy(current)] });
  const [task] = await env.service.createFromCollect({ accountId: "account-a", collectItemIds: ["collect-1"],
    selectedSkus: { "collect-1": ["sku-b"] }, idempotencyKey: "selected-b", config });
  await env.service.processNext();
  current.items[1] = { ...copy(source(1).items[0]), sku: "sku-b" };
  current.enrichmentJobs[0].status = "SUCCESS";
  env.advance(30000); await env.service.processNext();
  assert.deepEqual(env.calls.map(call => call.sku), ["sku-b"]);
  assert.deepEqual(env.submissions[0].source.items.map(item => item.sku), ["sku-b"]);
  assert.deepEqual(env.repository.rows.get(task.id).collectWait.selectedSkus, ["sku-b"]);
});

test("actual pending jobs wait even when old logistics look complete, while a pending summary alone never enables waiting", async () => {
  const current = source(1); current.enrichmentJobs = [{ sku: "sku-a", status: "PENDING" }];
  const env = setup({ source: current }); const task = await env.create();
  await env.service.processNext();
  assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "COLLECTING");
  assert.equal(env.calls.length, 0);
  const summaryOnly = pendingCollectSource(); delete summaryOnly.enrichmentJobs;
  const missing = setup({ source: summaryOnly });
  await assert.rejects(missing.create(), { code: "AI_LISTING_LOGISTICS_REQUIRED" });
  assert.equal(missing.repository.rows.size, 0);
});

test("new collect task accepts manually repaired images and packaging despite historical Seller FAILED", async () => {
  const current = pendingCollectSource();
  current.enrichmentJobs[0].status = "FAILED";
  current.items[0].listingItem.weight = 450;
  current.items[0].images = ["https://source.test/manually-repaired.jpg"];
  const env = setup({ source: current });
  const task = await env.create({ manualReview: true });
  assert.equal(task.status, "QUEUED");
  const stored = env.repository.rows.get(task.id);
  assert.equal(stored.collectWait, undefined);
  assert.equal(stored.source.items[0].listingItem.weight, 450);
  assert.deepEqual(stored.source.enrichmentJobs, [{ sku: "sku-a", status: "FAILED" }]);
  await env.service.processNext();
  assert.deepEqual(env.calls.map(call => call.sourceUrl), ["https://source.test/manually-repaired.jpg"]);
  assert.equal((await env.service.getTask({ accountId: "account-a", taskId: task.id })).status, "AWAITING_REVIEW");
  assert.equal(env.submissions.length, 0);
});

test("historical Seller FAILED does not bypass the original image or packaging admission boundaries", async () => {
  for (const missing of ["images", "weight"]) {
    const current = source(1); current.enrichmentJobs = [{ sku: "sku-a", status: "FAILED" }];
    if (missing === "images") current.items[0].images = [];
    else delete current.items[0].listingItem.weight;
    const env = setup({ source: current });
    await assert.rejects(env.create(), { code: missing === "images" ? "AI_LISTING_INVALID_INPUT" : "AI_LISTING_LOGISTICS_REQUIRED" });
    assert.equal(env.repository.rows.size, 0); assert.equal(env.calls.length, 0);
  }
});

test("failed, deleted, disappeared-job and changed-SKU pending sources stop with initial evidence and no paid work", async () => {
  for (const change of ["failed", "deleted", "job-missing", "sku-removed", "primary-replaced"]) {
    let current = pendingCollectSource(); const initial = copy(current); let charges = 0;
    const env = setup({ loadSources: async () => current ? [copy(current)] : [],
      collectSku: async () => { throw new Error("must not recollect"); },
      billing: { reconcile: async () => { charges++; return { funded: true }; } } });
    const task = await env.create();
    if (change === "failed") {
      current.enrichmentJobs[0].status = "FAILED";
      current.items[0].listingItem.weight = 450; // An admitted wait still reports failure even with usable packaging.
    }
    if (change === "deleted") current = null;
    if (change === "job-missing") current.enrichmentJobs = [];
    if (change === "sku-removed") current.items[0].sku = "replacement";
    if (change === "primary-replaced") current.sku = "replacement";
    const failed = await env.service.processNext();
    assert.equal(failed.status, "COLLECTION_FAILED", change);
    assert.match(failed.errorMessage, /补全|来源|SKU/, change);
    const row = env.repository.rows.get(task.id);
    assert.equal(row.source, null); assert.equal(row.leaseToken, null);
    assert.deepEqual(row.collectWait.initialSource, initial);
    assert.equal(charges, 0); assert.equal(env.calls.length, 0); assert.equal(env.submissions.length, 0);
  }
});

test("completed enrichment with missing logistics never leaves a half-frozen source and retry still waits for a valid source", async () => {
  const current = pendingCollectSource();
  const env = setup({ loadSources: async () => [copy(current)] }); const task = await env.create();
  current.enrichmentJobs[0].status = "SUCCESS";
  assert.equal((await env.service.processNext()).status, "COLLECTION_FAILED");
  const failed = copy(env.repository.rows.get(task.id));
  assert.equal(failed.source, null); assert.deepEqual(failed.images, []); assert.equal(env.calls.length, 0);
  current.items[0].listingItem.weight = 500;
  await env.service.retryTask({ accountId: "account-a", taskId: task.id });
  assert.equal((await env.service.processNext()).status, "SUBMITTED");
  assert.equal(env.submissions[0].source.items[0].listingItem.weight, 500);
  assert.deepEqual(env.repository.rows.get(task.id).collectWait.initialSource, failed.collectWait.initialSource);
});

test("Excel logistics failure also keeps source null so retry cannot skip collection with empty images", async () => {
  const current = pendingCollectSource(); let collected = 0;
  current.enrichmentJobs[0].status = 'SUCCESS'; // A completed read with no weight is a real failure, not a pending capture.
  const env = setup({ collectSku: async () => { collected++; return copy(current); } });
  const [task] = await env.service.createFromSkus({ accountId: "account-a", skus: ["sku-a"], idempotencyKey: "excel", config });
  assert.equal((await env.service.processNext()).status, "COLLECTION_FAILED");
  assert.equal(env.repository.rows.get(task.id).source, null);
  assert.deepEqual(env.repository.rows.get(task.id).images, []);
  current.items[0].listingItem.weight = 200;
  await env.service.retryTask({ accountId: "account-a", taskId: task.id });
  await env.service.processNext(); assert.equal(collected, 2); assert.equal(env.submissions.length, 1);
});

test("existing frozen or waiting task replays before source lookup even after deletion, with config conflict and account isolation intact", async () => {
  for (const pending of [false, true]) {
    let current = pending ? pendingCollectSource() : source(1); let reads = 0;
    const env = setup({ loadSources: async ({ accountId }) => { reads++; return current && accountId === "account-a" ? [copy(current)] : []; } });
    const created = await env.create({ manualReview: true });
    current = null; reads = 0;
    const restarted = createAiListingService(env.ports);
    const input = { accountId: "account-a", collectItemIds: ["collect-1"], idempotencyKey: "request-1", config: { ...config, manualReview: true } };
    const [replayed] = await restarted.createFromCollect(input);
    assert.equal(replayed.id, created.id); assert.equal(reads, 0);
    await assert.rejects(restarted.createFromCollect({ ...input, config: { ...input.config, stock: 9 } }), { code: "AI_LISTING_IDEMPOTENCY_CONFLICT" });
    assert.equal(reads, 0);
    await assert.rejects(restarted.createFromCollect({ ...input, accountId: "account-b" }), { code: "AI_LISTING_SOURCE_NOT_FOUND" });
    assert.equal(env.repository.rows.size, 1);
    reads = 0;
    const worked = await restarted.processNext();
    assert.equal(worked.status, pending ? "COLLECTION_FAILED" : "AWAITING_REVIEW");
    assert.equal(reads, pending ? 1 : 0);
  }
});

test("explicit SKU selection is part of idempotency, including when the source has been deleted", async () => {
  let current = source(1); const env = setup({ loadSources: async () => current ? [copy(current)] : [] });
  const input = { accountId: "account-a", collectItemIds: ["collect-1"], idempotencyKey: "selected-replay", config,
    selectedSkus: { "collect-1": ["sku-a"] } };
  const [created] = await env.service.createFromCollect(input); current = null;
  const [replayed] = await env.service.createFromCollect(input); assert.equal(replayed.id, created.id);
  await assert.rejects(env.service.createFromCollect({ ...input, selectedSkus: { "collect-1": ["other"] } }), { code: "AI_LISTING_IDEMPOTENCY_CONFLICT" });
});


test("Russian source requirement identifies SKU and field without discarding generated images", async () => {
  const message="SKU 2102714113：上传字段 attributes[4191].value 含中文，请重新采集或补全俄语原文";
  const env=setup({submitListing:async()=>{throw Object.assign(new Error(message),{code:"ZONGZI_PRODUCT_RUSSIAN_REQUIRED",definitelyNotSubmitted:true});}});
  const task=await env.create();await env.service.processNext();
  const result=await env.service.getTask({accountId:"account-a",taskId:task.id});
  assert.equal(result.status,"SUBMISSION_FAILED");assert.equal(result.images.filter(image=>image.generatedUrl).length,8);
  assert.equal(result.errorMessage,message);
});


test('whole product keeps its channel across sibling SKUs then releases before submission', async () => {
  const original=source(2);original.items.push({...copy(original.items[0]),sku:'sku-b'});
  const events=[];let reservations=0;
  const env=setup({source:original,
    reserveChannel:async()=>{reservations++;return {channelId:'owned',productToken:'token',release:async()=>events.push('released')};},
    generateImage:async input=>{await input.beforeRequest();assert.equal(input.channelId,'owned');assert.equal(input.productToken,'token');events.push(input.sku);return {generatedUrl:`https://generated.test/${input.sku}/${input.index}`};},
    submitListing:async()=>{assert.equal(events.at(-1),'released');events.push('submitted');return {submissionId:'submitted'};},
  });
  await env.create();await env.service.processNext();await env.service.processNext();
  assert.equal(reservations,1);assert.deepEqual(events,['sku-a','sku-a','sku-b','sku-b','released','submitted']);
});

test('product admission waits without starting or spending image attempts', async () => {
  const env=setup({reserveChannel:async()=>{throw Object.assign(new Error('busy'),{code:'AI_GATEWAY_NO_CAPACITY'});}});
  const task=await env.create();await env.service.processNext();
  assert.equal(env.calls.length,0);
  const stored=env.repository.rows.get(task.id);
  assert.ok(stored.images.every(image=>!image.attempts));assert.ok(stored.nextRunAt>1000);
});

test('possibly sent channel response pauses instead of automatically paying again', async () => {
  let calls=0,releases=0;
  const env=setup({reserveChannel:async()=>({channelId:'owned',productToken:'token',release:async()=>{releases++;}}),
    generateImage:async()=>{calls++;throw Object.assign(new Error('network'),{channelId:'owned',code:'AI_GATEWAY_UNEXPECTED_EOF',deliveryState:'POSSIBLY_SENT'});},
  });
  const task=await env.create();await env.service.processNext();env.advance(60_000);await env.service.processNext();
  assert.equal(calls,1);assert.equal(releases,1);
  const result=await env.service.getTask({accountId:'account-a',taskId:task.id});
  assert.equal(result.status,'GENERATION_FAILED');assert.match(result.errorMessage,/未知|核实/);
});

test('prepare-only execution freezes source without generating, reserving funds or a channel', async () => {
  let funded=0,reserved=0;
  const env=setup({billing:{reconcile:async input=>{if(input.reserve)funded++;return {funded:true};}},reserveChannel:async()=>{reserved++;}});
  const [task]=await env.service.createFromSkus({accountId:'account-a',skus:['sku-a'],idempotencyKey:'excel',config});
  await env.service.processNext({phase:'prepare'});
  assert.equal(env.calls.length,0);assert.equal(funded,0);assert.equal(reserved,0);
  assert.equal(env.repository.rows.get(task.id).source.items[0].sku,'sku-a');
});

test('cancellation while a product is running retains its channel until that request finishes', async () => {
  let finish,entered;const started=new Promise(resolve=>{entered=resolve;});const waiting=new Promise(resolve=>{finish=resolve;});let released=0;
  const env=setup({reserveChannel:async()=>({channelId:'owned',productToken:'token',release:async()=>{released++;}}),
    generateImage:async input=>{await input.beforeRequest();entered();await waiting;return {generatedUrl:'https://generated.test/late'};},
  });
  const task=await env.create();const run=env.service.processNext();await started;
  await env.service.cancelTask({accountId:'account-a',taskId:task.id});assert.equal(released,0);
  finish();await run;assert.equal(released,1);assert.equal(env.submissions.length,0);
  assert.equal((await env.service.getTask({accountId:'account-a',taskId:task.id})).status,'CANCELLED');
});

test('worker stop saves the in-flight result, sends no next image and requeues remaining work',{timeout:5000},async()=>{
  const {createAiListingRuntime}=await import('../ai-listing-runtime.mjs');
  const env=setup({source:source(2)}),task=await env.create({manualReview:true});
  let enter,finish,calls=0;const reached=new Promise(r=>enter=r),gate=new Promise(r=>finish=r);
  const runtime=createAiListingRuntime({env:{AI_LISTING_CONCURRENCY:'1',AI_LISTING_ADAPTIVE_CONCURRENCY:'0'},clock:()=>1000,
    repository:env.repository,resolvePool:async()=>({query:async()=>({rows:[]})}),checkAccount:async()=>({id:'account-a',role:'admin',status:'active'}),
    generateImage:async input=>{calls++;if(calls===1){enter();await gate;}return {generatedUrl:`https://saved.test/${input.index}`};},
  });
  const starting=runtime.start({mode:'worker'});await Promise.race([reached,starting.then(()=>{throw new Error('No initial image request: '+JSON.stringify([...env.repository.rows.values()]));})]);
  const stopping=runtime.stop();finish();await starting;await stopping;
  assert.equal(calls,1);
  const saved=await env.repository.get({accountId:'account-a',taskId:task.id});
  assert.equal(saved.images[0].generatedUrl,'https://saved.test/0');assert.equal(saved.images[1].generatedUrl,null);
  assert.equal(saved.images[1].status,'PENDING');assert.equal(saved.images[1].attempts,0);assert.equal(saved.status,'GENERATING');assert.equal(saved.leaseToken,null);
});

const badPrice = () => Object.assign(new Error('SKU sku-a 售价计算不通过：7.14 CNY 加 -10.00 后乘 5 不大于 0；请提高售价加减。'), {
  code:'PRICE_FINAL_NOT_POSITIVE',definitelyNotSubmitted:true,
  priceFailure:{code:'PRICE_FINAL_NOT_POSITIVE',sku:'sku-a',currency:'CNY',realPriceKopecks:'714',priceAdjustmentKopecks:-1000,priceMultiplier:'5'},
});
test('price preflight stops this product before reserving a channel or generating images', async()=>{
  let reserved=0;const env=setup({checkSource:async()=>{throw badPrice();},reserveChannel:async()=>{reserved++;return {release:async()=>{}}}});
  const task=await env.create({priceAdjustmentKopecks:-1000,priceMultiplier:'5'});await env.service.processNext();
  const failed=await env.service.getTask({accountId:'account-a',taskId:task.id});assert.equal(failed.status,'GENERATION_FAILED');
  assert.equal(failed.priceFailure.code,'PRICE_FINAL_NOT_POSITIVE');assert.match(failed.errorMessage,/sku-a/);assert.equal(env.calls.length,0);assert.equal(reserved,0);assert.equal(env.submissions.length,0);
});
test('explicit per-product preparation failures let valid sources continue with the same idempotency key',async()=>{
  const sources=['a','b','c'].map(id=>({...source(1),collectItemId:id,sku:id}));delete sources[1].items[0].listingItem.weight;
  const env=setup({loadSources:async()=>structuredClone(sources)}),errors=[];
  const request={accountId:'account-a',collectItemIds:['a','b','c'],idempotencyKey:'partial-batch',config};
  const tasks=await env.service.createFromCollect(request,{onSourceError:row=>errors.push(row)});
  assert.deepEqual(tasks.map(t=>t.collectItemId),['a','c']);assert.equal(env.repository.rows.size,2);
  assert.deepEqual(errors.map(e=>[e.collectItemId,e.code,e.definitelyNotCreated]),[['b','AI_LISTING_LOGISTICS_REQUIRED',true]]);
  const replayErrors=[];const replay=await env.service.createFromCollect(request,{onSourceError:row=>replayErrors.push(row)});
  assert.deepEqual(replay.map(t=>t.id),tasks.map(t=>t.id));assert.equal(replayErrors.length,1);assert.equal(env.repository.rows.size,2);
  for(const task of tasks){await env.service.processNext();env.advance(15000);await env.service.processNext();}
  assert.ok((await env.service.listTasks({accountId:'account-a'})).every(t=>t.status==='COMPLETED'));
});
test('per-source loader errors are classified once while missing ownership and uncertain writes remain fatal',async()=>{
  const good={...source(1),collectItemId:'a'},errors=[];
  const request={accountId:'account-a',collectItemIds:['a','b'],idempotencyKey:'loader-batch',config};
  const env=setup({loadSources:async({onSourceError})=>{onSourceError?.({collectItemId:'b',error:Object.assign(new Error('invalid product'),{code:'AI_LISTING_INVALID_INPUT'})});return [good];}});
  const tasks=await env.service.createFromCollect(request,{onSourceError:row=>errors.push(row)});
  assert.equal(tasks.length,1);assert.equal(errors[0].collectItemId,'b');assert.equal(errors[0].definitelyNotCreated,true);
  const missing=setup({loadSources:async()=>[good]});await assert.rejects(missing.service.createFromCollect(request,{onSourceError:()=>{}}),{code:'AI_LISTING_SOURCE_NOT_FOUND'});assert.equal(missing.repository.rows.size,0);
  const repository=memoryRepository();repository.create=async()=>{throw Object.assign(new Error('write outcome unknown'),{code:'AI_LISTING_LOGISTICS_REQUIRED'});};
  const writing=setup({repository});await assert.rejects(writing.service.createFromCollect({accountId:'account-a',collectItemIds:['collect-1'],idempotencyKey:'write',config},{onSourceError:()=>assert.fail('write errors must not be skipped')}),/write outcome unknown/);
});
test('invalid source price stops only that product before billing and channel use',async()=>{
  const {aiListingItemPrice}=await import('../ai-listing-source-facts.mjs');let checks=0,channels=0;
  const original=source(1);delete original.items[0].listingItem.price;original.sourceSnapshot.currency='CNY';
  const env=setup({source:original,checkSource:async({source,config})=>{checks++;for(const item of source.items)aiListingItemPrice(source,item,config,{currencyCode:'CNY'});return source;},reserveChannel:()=>{channels++;throw new Error('must not reserve');}});
  const task=await env.create();await env.service.processNext();const failed=await env.service.getTask({accountId:'account-a',taskId:task.id});
  assert.equal(failed.status,'GENERATION_FAILED');assert.match(failed.errorMessage,/sku-a.*价格/);assert.equal(failed.priceFailure,undefined);assert.equal(checks,1);assert.equal(channels,0);assert.equal(env.calls.length,0);
});


test('a historical seven-image negative-price task is skipped while another product completes unchanged',async()=>{
 const {aiListingItemPrice}=await import('../ai-listing-source-facts.mjs');
 const sources=['bad','good'].map((id,index)=>({...source(7),collectItemId:id,sourceSnapshot:{currency:'CNY',blackPrice:index?'46.45':'7.65',greenPrice:index?'43.58':'7.20'}}));
 const submitted=[];const env=setup({loadSources:async()=>structuredClone(sources),
  checkSource:async({source,config})=>{for(const group of source.items)aiListingItemPrice(source,group,config,{currencyCode:'CNY'});return source;},
  submitListing:async input=>{for(const group of input.source.items)aiListingItemPrice(input.source,group,input.config,{currencyCode:'CNY'});submitted.push(input);return {submissionId:'good-submit'};}});
 const tasks=await env.service.createFromCollect({accountId:'account-a',collectItemIds:['bad','good'],idempotencyKey:'skip-price',config:{...config,priceAdjustmentKopecks:-1000,priceMultiplier:'5'}});
 const saved=env.repository.rows.get(tasks[0].id);saved.images.forEach((image,index)=>{image.generatedUrl='https://generated.test/existing-'+index;image.status='GENERATED';});saved.status='READY_TO_SUBMIT';
 const previous=structuredClone(saved.images);
 await env.service.processNext();const failed=await env.service.getTask({accountId:'account-a',taskId:tasks[0].id});
 assert.equal(failed.status,'SUBMISSION_FAILED');assert.equal(failed.priceFailure.sku,'sku-a');assert.match(failed.errorMessage,/7\.14 CNY.*-10\.00.*5.*跳过/);assert.equal(env.calls.length,0);assert.equal(submitted.length,0);assert.deepEqual(env.repository.rows.get(tasks[0].id).images,previous);
 await env.service.processNext();env.advance(15000);await env.service.processNext();assert.equal((await env.service.getTask({accountId:'account-a',taskId:tasks[1].id})).status,'COMPLETED');assert.equal(submitted.length,1);assert.equal(submitted[0].config.priceAdjustmentKopecks,-1000);assert.equal(submitted[0].config.priceMultiplier,'5');assert.equal(env.calls.length,7);
});


test('a concurrently listed selected sibling cannot abort other sources or duplicate them on replay',async()=>{
 const sources=['a','b','c'].map(id=>({...source(1),collectItemId:id}));
 sources[1].items[0].sku='remaining-sibling';
 const env=setup({loadSources:async()=>structuredClone(sources)}),errors=[];
 const request={accountId:'account-a',collectItemIds:['a','b','c'],selectedSkus:{b:['already-listed-sibling']},idempotencyKey:'changed-selection',config};
 const first=await env.service.createFromCollect(request,{onSourceError:e=>errors.push(e)});
 assert.deepEqual(first.map(t=>t.collectItemId),['a','c']);assert.equal(env.repository.rows.size,2);
 assert.equal(errors[0].code,'AI_LISTING_SELECTION_CHANGED');assert.equal(errors[0].definitelyNotCreated,true);assert.equal(errors[0].retryable,false);
 const replay=await env.service.createFromCollect(request,{onSourceError:()=>{}});assert.deepEqual(replay.map(t=>t.id),first.map(t=>t.id));assert.equal(env.repository.rows.size,2);
});


test('slow media does not block a second prepared product from final submission',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);const sent=[];
 const second=source();second.collectItemId='collect-2';second.sku='sku-b';second.items[0].sku='sku-b';
 const env=setup({loadSources:async()=>[source(),second],submitListing:async input=>{
  assert.equal(input.deferImport,true);if(input.source.items[0].sku==='sku-a'){entered();await gate;}return {submissionId:input.source.items[0].sku};
 },readSubmission:async input=>{sent.push(input.submissionId);return {status:'COMPLETED'};}});
 const tasks=await env.service.createFromCollect({accountId:'account-a',collectItemIds:['collect-1','collect-2'],idempotencyKey:'parallel-media',config});
 await env.service.processNext({phase:'generate'});await env.service.processNext({phase:'generate'});
 const slow=env.service.processNext({phase:'media'});await started;
 try{
  assert.equal((await env.service.getTask({accountId:'account-a',taskId:tasks[0].id})).submissionStage,'preparing_media');
  await env.service.processNext({phase:'media'});assert.deepEqual(sent,[]);
  await env.service.processNext({phase:'finalize'});assert.deepEqual(sent,['sku-b']);
 }finally{release();await slow;}
 await env.service.processNext({phase:'finalize'});assert.deepEqual(sent,['sku-b','sku-a']);assert.equal(env.calls.length,16);
});

test('an expired media lease resumes preparation instead of claiming an unknown external submission',async()=>{
 const env=setup();const task=await env.create();await env.service.processNext({phase:'generate'});
 const stored=env.repository.rows.get(task.id);Object.assign(stored,{status:'SUBMITTING',submissionStarted:true,submissionStage:'preparing_media',leaseToken:'crashed',leaseExpiresAt:999});
 const resumed=await env.service.processNext({phase:'media'});assert.equal(resumed.status,'READY_TO_SUBMIT');assert.equal(resumed.submissionStage,'prepared');assert.equal(env.submissions[0].deferImport,true);
});


test('generation ignores Ozon admission and clears legacy quota waits while retaining balance checks',async()=>{
 let routeCalls=0,funding=0;
 const env=setup({source:source(1),routeStores:async()=>{routeCalls++;throw Error('quota must not run during generation');},billing:{reconcile:async()=>{funding++;return {funded:true};}}});
 const task=await env.create({manualReview:true});const row=env.repository.rows.get(task.id);
 row.quotaWait={code:'RESERVED_CAPACITY',message:'legacy lock'};row.quotaReservation={storeId:'store-a',required:1};row.generationStage='waiting_quota';
 const result=await env.service.processNext({phase:'generate'});
 assert.equal(result.status,'AWAITING_REVIEW');assert.equal(routeCalls,0);assert.equal(env.calls.length,1);assert.ok(funding>0);
 assert.equal(result.quotaWait,undefined);assert.equal(env.repository.rows.get(task.id).quotaReservation,undefined);
});

test('a normal image channel wait never calls store routing or restores a legacy quota label',async()=>{
 let routeCalls=0;
 const env=setup({source:source(1),routeStores:async()=>{routeCalls++;return {selected:false};},reserveChannel:async()=>{throw Object.assign(Error('busy'),{code:'AI_GATEWAY_NO_CAPACITY'});}});
 const task=await env.create({manualReview:true});
 for(let n=0;n<3;n++){const r=await env.service.processNext({phase:'generate'});assert.equal(r.generationStage,'waiting_channel');assert.equal(r.quotaWait,undefined);env.advance(15000);}
 assert.equal(routeCalls,0);assert.equal(env.calls.length,0);
});

test('submission polling preserves distinct store wait and creation counts independently of stock completion',async()=>{
 const result={status:'SUBMITTED',submissionStage:'store_wait',submissionWait:{code:'STORE_QUEUE',message:'等待同店前一组确认',retryAt:99000},
  submissionTarget:{targetStoreId:'store-a',targetWarehouseId:'warehouse-a'},items:[{sku:'sku-a',importStatus:'SUCCEEDED',stockStatus:'PENDING'},{sku:'sku-b',importStatus:'PENDING',stockStatus:'PENDING'}]};
 const src=source(1);src.items.push({...copy(src.items[0]),sku:'sku-b'});
 const env=setup({source:src,readSubmission:async()=>result});const task=await env.create();await env.service.processNext();env.advance(15000);
 const r=await env.service.processNext();assert.deepEqual(r.submissionWait,result.submissionWait);assert.equal(r.createdSkuCount,1);assert.equal(r.totalSkuCount,2);
 assert.equal(env.repository.rows.get(task.id).nextRunAt,99000);
});


test('a wholly quota-rejected group switches only to configured fallback and preserves the journal and images',async()=>{
 let reads=0;const env=setup({source:source(1),readSubmission:async()=>({status:'SUBMITTED',storeSwitchEligible:true,submissionTarget:{targetStoreId:'store-a',targetWarehouseId:'warehouse-a'},quotaWait:{code:'DAILY_LIMIT',retryAt:999999},items:[{sku:'sku-a',importStatus:'FAILED',errors:['item_limit_exceeded']}]})});
 const task=await env.create({autoSwitchStores:true,fallbackStores:[{targetStoreId:'store-b',targetWarehouseId:'warehouse-b'}]});await env.service.processNext();
 const original=copy(env.repository.rows.get(task.id));env.advance(15000);const queued=await env.service.processNext();
 assert.equal(queued.status,'READY_TO_SUBMIT');assert.equal(queued.submissionTarget.targetStoreId,'store-b');assert.equal(queued.submissionId,original.submissionId);
 assert.deepEqual(env.repository.rows.get(task.id).images,original.images);
 await env.service.processNext();assert.equal(env.submissions.at(-1).switchStore,true);assert.equal(env.submissions.at(-1).config.targetStoreId,'store-b');
 assert.equal(env.calls.length,1);assert.equal(env.submissions.at(-1).idempotencyKey,env.submissions[0].idempotencyKey);
});

for(const state of ['partial','unknown','disabled'])test(`quota store switching refuses ${state} even when an adapter supplies a stale eligibility hint`,async()=>{
 const result={status:'SUBMITTED',storeSwitchEligible:true,quotaWait:{code:'DAILY_LIMIT',retryAt:999999},items:[]};
 if(state==='partial')result.items=[{sku:'sku-a',importStatus:'SUCCEEDED',productId:'11'}];
 if(state==='unknown'){result.status='UNCERTAIN';result.items=[{sku:'sku-a',importStatus:'UNKNOWN'}];}
 const env=setup({source:source(1),readSubmission:async()=>result});const task=await env.create({autoSwitchStores:state!=='disabled',...(state!=='disabled'?{fallbackStores:[{targetStoreId:'store-b',targetWarehouseId:'warehouse-b'}]}:{})});
 await env.service.processNext();env.advance(15000);await env.service.processNext();
 assert.notEqual(env.repository.rows.get(task.id).submissionTarget?.targetStoreId,'store-b');assert.equal(env.submissions.length,1);
});

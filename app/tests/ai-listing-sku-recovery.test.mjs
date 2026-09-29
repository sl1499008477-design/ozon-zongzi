import test from 'node:test';
import assert from 'node:assert/strict';
import * as state from '../src/ai-listing-page-state.js';
test('partial Ozon success remains visible alongside unfinished SKU errors',()=>{
 assert.equal(state.aiListingTaskStatus({status:'GENERATION_FAILED',completedSkuCount:1}).label,'部分待处理');
 assert.equal(state.aiListingTaskStatus({status:'GENERATION_FAILED',completedSkuCount:0}).label,'生图失败');
});

test('SKU status keeps skip reasons, unknown result protection and black-price fallback visible',()=>{
 assert.equal(typeof state.aiListingSkuStatus,'function');
 assert.deepEqual(state.aiListingSkuStatus({status:'SKIPPED',reason:'缺少绿标价，仅跳过此 SKU'}),{
  label:'已跳过',color:'default',description:'缺少绿标价，仅跳过此 SKU',
 });
 assert.match(state.aiListingSkuStatus({status:'RESULT_UNKNOWN',reason:'响应中断'}).description,/响应中断.*不会再次生图/);
 assert.equal(state.aiListingSkuStatus({status:'RESULT_UNKNOWN'}).label,'结果待核实');
 assert.match(state.aiListingSkuStatus({status:'READY',usedBlackPriceFallback:true}).description,/已采用黑标价计算/);
 assert.match(state.aiListingSkuStatus({status:'READY',priceBasis:'BLACK_PRICE_FALLBACK'}).description,/已采用黑标价计算/);
 assert.match(state.aiListingSkuStatus({status:'GENERATION_FAILED',paidResultRetained:true}).description,/已保存完整拼图.*重新切片/);
 assert.equal(state.aiListingSkuStatus({status:'READY'}).label,'待上架');
 assert.equal(state.aiListingSkuStatus({status:'UPLOAD_FAILED'}).label,'图片保存失败');
 assert.equal(state.aiListingSkuStatus({status:'RESULT_UNAVAILABLE'}).label,'原拼图不可用');
 assert.match(state.aiListingSkuStatus({status:'RESULT_UNAVAILABLE',reason:'原付费拼图已不可用，无法重新切片'}).description,/无法重新切片.*普通重试不会重新生图/);
});

test('a pending import receipt takes precedence over generated images being ready for listing',()=>{
 const row={sku:'4157480005',status:'READY',completed:6,total:6};
 const task={status:'SUBMISSION_UNCERTAIN',submissionResults:[{sku:'4157480005',importStatus:'UNKNOWN'}]};
 assert.equal(state.aiListingSkuStatus(row,task).label,'提交结果待核实');
 assert.equal(state.aiListingSkuStatus(row,task).color,'orange');
 assert.match(state.aiListingSkuStatus(row,task).description,/原提交结果/);
 assert.equal(state.aiListingSkuStatus(row,{status:'SUBMISSION_UNCERTAIN'}).label,'提交结果待核实');
 assert.equal(state.aiListingSkuStatus(row,{status:'SUBMITTED',submissionResults:task.submissionResults}).label,'提交结果待核实');
 assert.equal(state.aiListingSkuStatus(row,{status:'SUBMISSION_UNCERTAIN',submissionResults:[{sku:row.sku,importStatus:'PENDING'}]}).label,'待上架');
 assert.equal(state.aiListingSkuStatus({...row,status:'COMPLETED'},task).label,'已完成');
 assert.equal(state.aiListingSkuStatus({...row,status:'SKIPPED'},task).label,'已跳过');
 assert.equal(state.aiListingSkuStatus(row,{status:'GENERATING',submissionResults:[{sku:'another-sku',importStatus:'UNKNOWN'}]}).label,'待上架');
});

test('pending images in a SKU awaiting its original image result are shown as waiting for verification',()=>{
 const image={sku:'unknown-image-sku',index:1,status:'PENDING'};
 const task={skuProgress:[{sku:image.sku,status:'RESULT_UNKNOWN'}]};
 assert.equal(state.aiListingImageStatusLabel(image,task),'等待同组结果核实');
 assert.equal(state.aiListingImageStatusLabel({...image,sku:'another-sku'},task),'等待生图');
 assert.equal(state.aiListingImageStatusLabel({...image,status:'COMPLETED',generatedUrl:'saved.png'},task),'生图完成');
 assert.equal(state.aiListingImageStatusLabel({...image,status:'RESULT_UNKNOWN'},task),'结果待核实');
 assert.equal(state.aiListingImageStatusLabel(image,{images:[{sku:image.sku,status:'RESULT_UNKNOWN'}]}),'等待同组结果核实');
 assert.equal(state.aiListingImageStatusLabel(image),'等待生图');
});

test('current-price refresh is opt-in and absent for unrelated actions or completed tasks',()=>{
 assert.equal(typeof state.aiListingActionPayload,'function');
 assert.equal(typeof state.canRefreshAiListingPricing,'function');
 const task={version:7,status:'GENERATION_FAILED',config:{salePricingId:'profile'}};
 assert.equal(state.canRefreshAiListingPricing(task),true);
 assert.deepEqual(state.aiListingActionPayload(task,'retry'),{expectedVersion:7});
 assert.deepEqual(state.aiListingActionPayload(task,'retry',{refreshSalePricing:true}),{expectedVersion:7,refreshSalePricing:true});
 for(const kind of ['resume','delete','approve'])assert.deepEqual(state.aiListingActionPayload(task,kind,{refreshSalePricing:true}),{expectedVersion:7});
 for(const changed of [{...task,status:'COMPLETED'},{...task,deletedAt:'2026-09-25'},{...task,config:{}}]){
  assert.equal(state.canRefreshAiListingPricing(changed),false);
  assert.deepEqual(state.aiListingActionPayload(changed,'retry',{refreshSalePricing:true}),{expectedVersion:7});
 }
});

test('completed tasks can refresh pricing only when skipped SKUs remain to recover',()=>{
 const partial={version:9,status:'COMPLETED',config:{salePricingId:'profile'},skuProgress:[{sku:'done',status:'COMPLETED'},{sku:'skip',status:'SKIPPED'}],taskActions:{retry:true}};
 assert.equal(state.canRefreshAiListingPricing(partial),true);
 assert.deepEqual(state.aiListingActionPayload(partial,'retry',{refreshSalePricing:true}),{expectedVersion:9,refreshSalePricing:true});
 assert.equal(state.canRefreshAiListingPricing({...partial,skuProgress:[{sku:'done',status:'COMPLETED'}]}),false);
 assert.equal(state.canRefreshAiListingPricing({...partial,deletedAt:'2026-09-25'}),false);
});

import assert from "node:assert/strict";
import test from "node:test";
import * as pageState from "../src/ai-listing-page-state.js";

import {
  AI_LISTING_DEFAULT_PROMPT,
  AI_LISTING_FORM_DEFAULTS,
  aiListingCurrency,
  aiListingTaskActions,
  aiListingTaskProgress,
  collectItemIdsFromSearch,
  groupAiListingImages,
  serializeAiListingConfig,
} from "../src/ai-listing-page-state.js";

test("uses the approved independent AI-listing defaults and exact editable prompt", () => {
  assert.equal(AI_LISTING_FORM_DEFAULTS.manualReview, false);
  assert.equal(AI_LISTING_FORM_DEFAULTS.brandMode, "FORCE_NO_BRAND");
  assert.equal(AI_LISTING_FORM_DEFAULTS.stock, 5);
  assert.equal(AI_LISTING_FORM_DEFAULTS.priceAdjustmentAmount, "0");
  assert.equal(AI_LISTING_FORM_DEFAULTS.priceMultiplier, "1");
  assert.deepEqual(AI_LISTING_FORM_DEFAULTS.image, {
    ratio: "3:4", language: "ru", resolution: "2K", quality: "high",
  });
  assert.equal(AI_LISTING_FORM_DEFAULTS.prompt, AI_LISTING_DEFAULT_PROMPT);
  assert.equal(AI_LISTING_DEFAULT_PROMPT, "请根据这套商品图片重新生成一份适用于 ozon 的全新商品图，产品主体以及产品上的文字、logo 等信息保持不变，生成数量跟这套商品图相同，不要移除图片中既有的卖点、材质、规格型号等信息");
});

test("serializes decimal currency amounts exactly and keeps the multiplier string", () => {
  const config = serializeAiListingConfig({
    ...AI_LISTING_FORM_DEFAULTS,
    targetStoreId: " store-cny ",
    targetWarehouseId: " warehouse-a ",
    priceAdjustmentAmount: "-12.34",
    priceMultiplier: "1.230001",
    brandMode: "PREFER_SOURCE",
    manualReview: true,
    generationMode: "SINGLE",
    image: { ratio: "16:9", language: "zh", resolution: "4K", quality: "auto" },
  });
  assert.deepEqual(config, {
    targetStoreId: "store-cny",
    targetWarehouseId: "warehouse-a",
    stock: 5,
    priceAdjustmentKopecks: -1234,
    priceMultiplier: "1.230001",
    brandMode: "PREFER_SOURCE",
    manualReview: true,
    generationMode: "SINGLE",
    image: { ratio: "16:9", language: "zh", resolution: "4K", quality: "auto" },
    prompt: AI_LISTING_DEFAULT_PROMPT,
  });
  assert.deepEqual(aiListingCurrency("CNY"), { code: "CNY", symbol: "¥", name: "人民币" });
  assert.deepEqual(aiListingCurrency("RUB"), { code: "RUB", symbol: "₽", name: "卢布" });
  assert.throws(() => serializeAiListingConfig({
    ...AI_LISTING_FORM_DEFAULTS,
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    priceAdjustmentAmount: "90071992547409.92",
  }), { code: "AI_LISTING_PRICE_ADJUSTMENT_INVALID" });
  assert.throws(() => serializeAiListingConfig({
    ...AI_LISTING_FORM_DEFAULTS,
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    priceMultiplier: "1.0000001",
  }), { code: "AI_LISTING_PRICE_MULTIPLIER_INVALID" });
});

test("parses only the collect-box query contract and preserves selected order", () => {
  assert.deepEqual(collectItemIdsFromSearch("?source=collect&ids=item-a%2Citem-b"), ["item-a", "item-b"]);
  assert.deepEqual(collectItemIdsFromSearch("?source=excel&ids=item-a"), []);
  assert.deepEqual(collectItemIdsFromSearch("?source=collect&ids=item-a,item-a"), ["item-a"]);
});

test("groups every source-to-output image pair by SKU without a six-image cap", () => {
  const images = Array.from({ length: 9 }, (_, index) => ({
    sku: index < 7 ? "SKU-A" : "SKU-B",
    index: index < 7 ? index : index - 7,
    sourceUrl: `https://source.test/${index}.jpg`,
    generatedUrl: index === 8 ? null : `https://generated.test/${index}.jpg`,
    status: index === 8 ? "GENERATION_FAILED" : "COMPLETED",
  }));
  const groups = groupAiListingImages(images);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].sku, "SKU-A");
  assert.equal(groups[0].images.length, 7);
  assert.equal(groups[1].sku, "SKU-B");
  assert.equal(groups[1].images.length, 2);
  assert.deepEqual(groups.flatMap((group) => group.images), images);
  assert.deepEqual(aiListingTaskProgress({ images }), { completed: 8, total: 9 });
});

test("offers only backend-valid approve, retry, and cancellation actions", () => {
  assert.deepEqual(aiListingTaskActions("AWAITING_REVIEW"), { approve: true, retry: false, cancel: true });
  assert.deepEqual(aiListingTaskActions("GENERATION_FAILED"), { approve: false, retry: true, cancel: true });
  assert.deepEqual(aiListingTaskActions("SUBMISSION_UNCERTAIN"), { approve: false, retry: true, cancel: false });
  assert.deepEqual(aiListingTaskActions("COMPLETED"), { approve: false, retry: false, cancel: false });
});

 test("grid defaults and normalized fixed size",()=>{
 assert.equal(AI_LISTING_FORM_DEFAULTS.generationMode,"GRID");
 const c=serializeAiListingConfig({...AI_LISTING_FORM_DEFAULTS,targetStoreId:"s",targetWarehouseId:"w",image:{ratio:"16:9",resolution:"4K"}});
 assert.equal(c.generationMode,"GRID");assert.equal(c.image.ratio,"3:4");assert.equal(c.image.resolution,"1K");
 });

test('summary progress does not require image URLs',()=>{
  assert.deepEqual(aiListingTaskProgress({progress:{completed:4,total:12}}),{completed:4,total:12});
});

test('GRID creation requires available capability without changing SINGLE or saved config',async()=>{
 const {assertAiListingGenerationAvailable}=await import('../src/ai-listing-page-state.js');
 assert.throws(()=>assertAiListingGenerationAvailable('GRID',null),/智能拼图/);
 assert.throws(()=>assertAiListingGenerationAvailable('GRID',{grid:{available:false,reason:'本机 OCR 不可用'}}),/本机 OCR 不可用/);
 assert.doesNotThrow(()=>assertAiListingGenerationAvailable('GRID',{grid:{available:true}}));
 assert.doesNotThrow(()=>assertAiListingGenerationAvailable('SINGLE',{grid:{available:false}}));
});

test('task polling waits for the response and stops scheduling when closed',async()=>{
 const {startAiListingPolling}=await import('../src/ai-listing-page-state.js');let resolve;let calls=0;const scheduled=[];const cleared=[];
 const stop=startAiListingPolling({load:()=>{calls++;return new Promise(r=>{resolve=r})},setTimeoutFn:fn=>{scheduled.push(fn);return scheduled.length},clearTimeoutFn:id=>cleared.push(id)});
 assert.equal(calls,1);assert.equal(scheduled.length,0);resolve();await new Promise(r=>setImmediate(r));assert.equal(scheduled.length,1);
 scheduled[0]();assert.equal(calls,2);assert.equal(scheduled.length,1);stop();resolve();await new Promise(r=>setImmediate(r));assert.equal(scheduled.length,1);
});

test('generation steps show preparation, generation, slicing and saving separately', () => {
  assert.equal(typeof pageState.aiListingTaskStatus, 'function');
  for (const [generationStage,label] of [['preparing','准备图片中'],['image','AI 生图中'],['slicing','裁切图片中'],['saving','保存图片中'],[undefined,'等待生图']]) {
    const status = pageState.aiListingTaskStatus({status:'GENERATING', generationStage});
    assert.equal(status.label, label);
    assert.equal(status.color, 'processing');
  }
  const waiting = pageState.aiListingTaskStatus({status:'GENERATING', generationStage:'waiting_channel'});
  assert.equal(waiting.label, '等待生图');
  assert.match(waiting.description, /通道|名额/);
  assert.equal(pageState.aiListingTaskStatus({status:'GENERATING', generationStage:'queued'}).label, waiting.label);
  assert.match(pageState.aiListingTaskStatus({status:'GENERATING', generationStage:'slicing'}).description, /裁切/);
});

test('category service waiting is visible and does not override task controls', () => {
  const task={status:'GENERATING',generationStage:'waiting_source',errorMessage:'等待 Ozon 类目服务恢复，1 分钟后自动重试。'};
  const status=pageState.aiListingTaskStatus(task);
  assert.equal(status.label,'等待类目服务');
  assert.equal(status.description,task.errorMessage);
  assert.equal(status.color,'gold');
  assert.equal(pageState.aiListingTaskStatus({...task,quotaWait:{code:'DAILY_LIMIT',message:'之前额度不足'}}).label,'等待类目服务');
  assert.equal(pageState.aiListingTaskStatus({...task,controlAction:'pause'}).label,'正在暂停');
  assert.equal(pageState.aiListingTaskStatus({...task,status:'PAUSED'}).label,'已暂停');
  assert.equal(pageState.aiListingTaskStatus({...task,status:'CANCELLED'}).label,'已取消');
});

test('terminal states take precedence over a leftover generation stage', () => {
  assert.equal(typeof pageState.aiListingTaskStatus, 'function');
  const cancelled = pageState.aiListingTaskStatus({status:'CANCELLED', generationStage:'image'});
  assert.equal(cancelled.label, '已取消');
  assert.equal(cancelled.color, 'default');
  assert.equal(cancelled.description, '');
  const failed = pageState.aiListingTaskStatus({status:'SUBMISSION_FAILED', generationStage:'saving'});
  assert.equal(failed.label, '提交失败');
  assert.equal(failed.color, 'red');
  const priceSkipped = pageState.aiListingTaskStatus({status:'SUBMISSION_FAILED',
    priceFailure:{code:'PRICE_FINAL_NOT_POSITIVE'}});
  assert.equal(priceSkipped.label, '售价无效，已跳过');
});

test('enrichment waits use the same main label without hiding what is missing', () => {
  assert.equal(typeof pageState.aiListingTaskStatus, 'function');
  const collect = pageState.aiListingTaskStatus({status:'COLLECTING',sourceType:'COLLECT_BOX'});
  const batch = pageState.aiListingTaskStatus({status:'GENERATING',generationStage:'waiting_product'});
  assert.equal(collect.label, '等待资料补全');
  assert.equal(batch.label, collect.label);
  assert.equal(batch.color, collect.color);
  assert.match(collect.description, /类目|包装/);
  assert.match(batch.description, /同批/);
  assert.equal(pageState.aiListingTaskStatus({status:'COLLECTING',sourceType:'EXCEL'}).label, '采集中');
});

test('optional and unverified content notices do not claim captured data was lost', () => {
  assert.equal(typeof pageState.aiListingSubmissionNotices, 'function');
  const result = pageState.aiListingSubmissionNotices([{normalizationWarnings:[
    'SKU 1602438352 富内容未记录来源状态，待核实',
    'SKU 1602438352 当前类目另有 16 项可选属性未提交：材质等；未提交不等于抓取失败',
    'SKU 1602438352 普通视频源未提供（可编辑补充）',
    'SKU 1602438352 富内容已保存，但未进入本次请求，请核对字段格式',
    'SKU 1602438352 属性 777 unmapped',
  ]}]);
  assert.equal(result.info.length, 3);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /已保存.*未进入/);
});

test('completed imports display platform warnings and exact attribute details while supporting old code-only records', () => {
  const row = { sku: '2837656637', importStatus: 'SUCCEEDED', stockStatus: 'COMPLETED', errors: [],
    publicationWarnings: ['warning_attribute_values_out_of_range'],
    publicationWarningDetails: [{ code: 'warning_attribute_values_out_of_range', attribute_id: 10175,
      texts: { attribute_name: 'Глубина', description: 'Значение вне диапазона', hint: 'Проверьте размер' } }] };
  const notice = pageState.aiListingSubmissionNotices([row]).warnings.join(' ');
  assert.match(notice, /2837656637.*属性值超出.*10175.*Глубина.*Значение вне диапазона.*Проверьте размер/);
  assert.match(pageState.aiListingSubmissionFailureReason(row), /属性值超出.*10175.*Глубина/);
  const old = { ...row, publicationWarningDetails: undefined, warningMessage: 'warning_attribute_values_out_of_range' };
  assert.match(pageState.aiListingSubmissionNotices([old]).warnings.join(' '), /2837656637.*属性值超出.*未记录具体属性/);
  assert.match(pageState.aiListingSubmissionFailureReason(old), /属性值超出.*未记录具体属性/);
  assert.equal(pageState.aiListingSubmissionFailureReason({ importStatus: 'SUCCEEDED', stockStatus: 'COMPLETED', errors: [] }), '—');
});


test('media preparation and prepared submissions have distinct honest labels',()=>{
 assert.equal(pageState.aiListingTaskStatus({status:'SUBMITTING',submissionStage:'preparing_media'}).label,'准备上架素材中');
 assert.equal(pageState.aiListingTaskStatus({status:'READY_TO_SUBMIT',submissionStage:'prepared'}).label,'等待提交');
 assert.equal(pageState.aiListingTaskStatus({status:'SUBMISSION_FAILED',submissionStage:'preparing_media'}).label,'提交失败');
});


test('submission error summary uses actual SKU outcomes instead of generic category advice', async () => {
 const {aiListingTaskError,aiListingSubmissionFailureReason}=await import('../src/ai-listing-page-state.js');
 const row={sku:'4746690981',importStatus:'SUCCEEDED',stockStatus:'FAILED',errors:['PRODUCT_IS_ARCHIVED']};
 const message=aiListingTaskError({status:'SUBMISSION_FAILED',errorMessage:'部分商品上架失败，请检查逐 SKU 结果后重试失败项；类目错误请先重新确认类目，成功商品不会重提',submissionResults:[row]});
 assert.match(message,/4746690981.*导入成功.*库存.*归档/);assert.doesNotMatch(message,/类目/);
 assert.match(aiListingSubmissionFailureReason(row),/PRODUCT_IS_ARCHIVED/);
 assert.equal(aiListingTaskError({errorMessage:'视频下载超时'}),'视频下载超时');
 assert.match(aiListingTaskError({status:'SUBMISSION_FAILED',submissionResults:[{sku:'2',importStatus:'FAILED',errors:['CATEGORY_NOT_FOUND']}]}),/CATEGORY_NOT_FOUND/);
});
test('pending task controls take precedence over generation labels and server eligibility',()=>{
  for(const [action,label] of [['pause','正在暂停'],['cancel','正在取消'],['delete','正在删除']]){
    const task={status:'GENERATING',generationStage:'image',controlAction:action,taskActions:{pause:false,cancel:false,resume:false,retry:false,delete:false,approve:false}};
    assert.equal(pageState.aiListingTaskStatus(task).label,label);
    assert.match(pageState.aiListingTaskStatus(task).description,/保存当前/);
    assert.deepEqual(pageState.aiListingTaskActions(task),task.taskActions);
  }
  assert.equal(pageState.aiListingTaskStatus({status:'PAUSED',generationStage:'image'}).label,'已暂停');
});

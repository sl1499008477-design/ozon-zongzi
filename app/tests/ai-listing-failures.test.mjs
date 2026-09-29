import assert from 'node:assert/strict';
import test from 'node:test';
import * as state from '../src/ai-listing-page-state.js';

function failedTask(overrides = {}) {
  return { id: 'price-task', sku: 'sku-main', status: 'SUBMISSION_FAILED', submissionId: null,
    priceFailure: { code: 'PRICE_FINAL_NOT_POSITIVE', sku: 'sku-child', currency: 'CNY', realPriceKopecks: 780,
      priceAdjustmentKopecks: -1000, priceMultiplier: '5' }, ...overrides };
}

test('picture failure and pending repair explain the actual step without calling it a stock failure',()=>{
 const task={status:'SUBMISSION_FAILED',submissionResults:[{sku:'4453874197',importStatus:'SUCCEEDED',stockStatus:'FAILED',publicationStatus:'IMAGE_FAILED',failureReason:'Ozon 图片接收失败；重试仅重传本 SKU 图片'}]};
 assert.equal(state.aiListingTaskStatus(task).label,'图片接收失败');
 assert.match(state.aiListingTaskError(task),/4453874197.*图片接收失败/);
 assert.doesNotMatch(state.aiListingTaskError(task),/库存设置失败/);
 const pending={status:'SUBMITTED',submissionResults:[{...task.submissionResults[0],stockStatus:'PENDING',publicationStatus:'IMAGE_REPAIR_PENDING'}]};
 assert.equal(state.aiListingTaskStatus(pending).label,'图片重传处理中');
 assert.equal(state.aiListingTaskStatus({status:'SUBMISSION_FAILED',submissionStage:'image_failed'}).label,'图片接收失败');
 assert.equal(state.aiListingTaskStatus({status:'SUBMITTED',submissionStage:'repairing_images'}).label,'图片重传处理中');
 assert.equal(state.aiListingTaskStatus({status:'SUBMISSION_UNCERTAIN',submissionStage:'repairing_images'}).label,'图片重传结果未知');
 assert.equal(state.aiListingTaskStatus({...pending,status:'CANCELLED'}).label,'已取消');
});

test('submission price failure with seven saved images is skipped only before external submission', () => {
  const legacyTask = failedTask({ images: Array.from({ length: 7 }, (_, index) => ({ id: `image-${index}`, sourceUrl: `https://example.com/source-${index}.jpg`, outputUrl: `https://example.com/generated-${index}.jpg` })) });
  const before = structuredClone(legacyTask);
  assert.equal(state.isAiListingPriceSkipped(legacyTask), true);
  assert.deepEqual(legacyTask, before);
  for (const task of [failedTask({ submissionId: 'import-already-started' }), failedTask({ status: 'SUBMISSION_UNCERTAIN' }),
    failedTask({ status: 'GENERATING' }), failedTask({ priceFailure: null }),
    failedTask({ priceFailure: { code: 'PRICE_MISSING' } }), failedTask({ submissionResults: [{ importStatus: 'UNKNOWN' }] })]) {
    assert.equal(state.isAiListingPriceSkipped(task), false);
  }
});

test('generation price precheck is skipped with the same formula and submission boundaries', () => {
  const task = failedTask({ status: 'GENERATION_FAILED' });
  assert.equal(state.isAiListingPriceSkipped(task), true);
  assert.equal(state.aiListingPriceFailureMessage(task), state.aiListingPriceFailureMessage(failedTask()));
  for (const overrides of [{ submissionId: 'import-already-started' }, { submissionResults: [{ importStatus: 'UNKNOWN' }] },
    { priceFailure: null }, { priceFailure: { code: 'PRICE_MISSING' } }]) {
    assert.equal(state.isAiListingPriceSkipped({ ...task, ...overrides }), false);
  }
});

test('invalid price explanation retains the exact task formula and never invents missing monetary values', () => {
  const task = failedTask(); const before = structuredClone(task);
  assert.equal(state.aiListingPriceFailureMessage(task), 'SKU sku-child：最终售价 =（真实售价 7.80 CNY + 售价加减 -10 CNY）× 5，不大于 0，已跳过上架。');
  assert.deepEqual(task, before);
  const rubles = failedTask({ priceFailure: { ...task.priceFailure, currency: 'RUB', realPriceKopecks: '780', priceAdjustmentKopecks: '-1234', priceMultiplier: '1.230001' } });
  assert.match(state.aiListingPriceFailureMessage(rubles), /7.80 RUB.*-12.34 RUB.*1.230001/);
  assert.equal(state.aiListingPriceFailureMessage(failedTask({ priceFailure: { code: 'PRICE_FINAL_NOT_POSITIVE' }, errorMessage: '原公式计算失败，请查看原售价来源' })), '原公式计算失败，请查看原售价来源');
  assert.equal(state.aiListingPriceFailureMessage(failedTask({ priceFailure: null })), '');
});

test('collect creation reports partial and zero success and only retries definitely uncreated items', () => {
  const result = state.aiListingCreationFeedback({ tasks: [{ id: 'created-a' }], errors: [
    { collectItemId: 'collect-b', code: 'NOT_FOUND', message: '来源已删除', definitelyNotCreated: true },
    { collectItemId: 'collect-c', code: 'UNKNOWN', message: '结果待核对', definitelyNotCreated: false },
  ] }, ['collect-a', 'collect-b', 'collect-c']);
  assert.deepEqual(result.retryCollectItemIds, ['collect-b']);
  assert.equal(result.level, 'warning');
  assert.equal(result.message, '已创建 1 个任务，2 项未创建');
  assert.equal(result.errors[0].collectItemId, 'collect-b');
  assert.equal(result.errors[0].message, '来源已删除');
  const zero = state.aiListingCreationFeedback({ tasks: [], errors: [{ collectItemId: 'collect-a', message: '资料不足', definitelyNotCreated: true }] }, ['collect-a']);
  assert.equal(zero.level, 'error'); assert.match(zero.message, /未创建/);
  assert.deepEqual(zero.retryCollectItemIds, ['collect-a']);
  assert.deepEqual(state.aiListingCreationFeedback({ tasks: [], errors: [{ collectItemId: 'collect-listed', code: 'AI_LISTING_ALREADY_LISTED', message: '商品已成功上架，无需重复创建任务', definitelyNotCreated: true, retryable: false }] }, ['collect-listed']).retryCollectItemIds, []);
  const complete = state.aiListingCreationFeedback({ tasks: [{ id: 'created-b' }], errors: [] }, ['collect-b']);
  assert.equal(complete.level, 'success'); assert.deepEqual(complete.retryCollectItemIds, []);
  assert.equal(state.aiListingCreationFeedback({ tasks: [], errors: [] }, ['collect-a']).level, 'error');
  const excel = state.aiListingCreationFeedback({ tasks: [], errors: [{ rowNumber: 3, rawSku: 'invalid', code: 'INVALID_SKU' }] });
  assert.equal(excel.retryCollectItemIds, null); assert.equal(excel.errors[0].rowNumber, 3);
});

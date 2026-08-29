import assert from "node:assert/strict";
import test from "node:test";

import {
  autoListingActionAvailability,
  autoListingCollectSelectionRows,
  autoListingImportProgress,
  autoListingImportRowPresentation,
  autoListingItemPresentation,
  autoListingTaskRows,
  autoListingTaskDuration,
  autoListingStageDuration,
  autoListingTaskMatchesFilter,
  autoListingTaskProgress,
  autoListingCreatedAtLabel,
} from "../src/auto-listing-view.js";

test("maps stable item states to plain Chinese without exposing AI internals", () => {
  const view = autoListingItemPresentation({
    itemId: "item-a",
    status: "GENERATING",
    failureCode: "",
    prompt: "secret prompt",
    apiKey: "secret",
    objectKey: "internal/key",
    model: "private-model",
  });
  assert.deepEqual(view, {
    itemId: "item-a",
    status: "GENERATING",
    statusLabel: "正在生成图片和内容",
    tone: "processing",
    failureLabel: "",
    actions: { review: false, approve: false, retry: false, regenerate: false, cancel: false },
  });
});

test("import rows distinguish recoverable collection failures from permanent invalid evidence", () => {
  assert.deepEqual(autoListingImportRowPresentation({
    rowNumber: 3, sku: "SKU-3", status: "FAILED", attemptCount: 5,
    errorCode: "OZON_SKU_COLLECTION_FAILED", recoverable: true,
  }), {
    rowNumber: 3, sku: "SKU-3", statusLabel: "采集失败", attemptCount: 5,
    errorLabel: "暂时无法读取 Ozon 商品资料，可以重试", recoverable: true,
  });
  assert.equal(autoListingImportRowPresentation({
    rowNumber: 4, sku: "SKU-4", status: "FAILED", attemptCount: 1,
    errorCode: "AUTO_LISTING_SOURCE_RESULT_INVALID", recoverable: false,
  }).errorLabel, "采集结果不完整，不能自动重试");
});

test("offers only actions allowed by the closed status flow", () => {
  assert.deepEqual(autoListingActionAvailability("READY_FOR_REVIEW"), {
    review: true, approve: true, retry: false, regenerate: true, cancel: true,
  });
  assert.deepEqual(autoListingActionAvailability("RETRYABLE_ERROR"), {
    review: false, approve: false, retry: false, regenerate: false, cancel: true,
  });
  assert.deepEqual(autoListingActionAvailability("SUCCEEDED"), {
    review: true, approve: false, retry: false, regenerate: false, cancel: false,
  });
  assert.deepEqual(autoListingActionAvailability("UNKNOWN"), {
    review: false, approve: false, retry: false, regenerate: false, cancel: false,
  });
});

test("uses the backend action decision only when all five booleans form a closed contract", () => {
  const authorized = { review: false, approve: false, retry: true, regenerate: false, cancel: true };
  assert.deepEqual(autoListingItemPresentation({
    itemId: "item-a", status: "RETRYABLE_ERROR", actions: authorized,
  }).actions, authorized);
  assert.deepEqual(autoListingItemPresentation({
    itemId: "item-a", status: "BLOCKED",
    actions: { review: true, approve: true, retry: true, regenerate: true, cancel: true, admin: true },
  }).actions, { review: false, approve: false, retry: false, regenerate: false, cancel: false });
});

test("missing backend actions fail closed instead of recreating authority from status", () => {
  assert.deepEqual(autoListingItemPresentation({
    itemId: "item-a", status: "READY_FOR_REVIEW",
  }).actions, { review: false, approve: false, retry: false, regenerate: false, cancel: false });
});

test("summarizes import progress while preserving failed siblings", () => {
  const progress = autoListingImportProgress({
    totalRows: 7,
    readyRows: 3,
    failedRows: 1,
    duplicateRows: 1,
    rejectedRows: 1,
    status: "COLLECTING",
  });
  assert.deepEqual(progress, {
    total: 7,
    completed: 6,
    pending: 1,
    ready: 3,
    failed: 1,
    duplicates: 1,
    invalid: 1,
    percent: 86,
    statusLabel: "正在采集商品资料",
  });
});

test("uses safe user-facing copy for known and unknown row failures", () => {
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "RETRYABLE_ERROR", failureCode: "OZON_SKU_COLLECTION_FAILED",
  }).failureLabel, "暂时无法读取 Ozon 商品资料，可以重试");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "BLOCKED", failureCode: "RAW_PRIVATE_DATABASE_ERROR",
  }).failureLabel, "商品暂时无法继续处理，请检查资料或联系管理员");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "RETRYABLE_ERROR", failureCode: "AI_GATEWAY_RATE_LIMITED",
  }).failureLabel, "AI 网关额度或频率受限，请检查额度后重试");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "RETRYABLE_ERROR", failureCode: "CHECKER_UNAVAILABLE",
  }).failureLabel, "图片已生成，但质量检查服务暂时不可用，可以重试");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "RETRYABLE_ERROR", failureCode: "CHECKER_RESPONSE_INVALID",
  }).failureLabel, "图片已生成，但质检结果格式异常；系统自动纠正后仍未通过，可以重试");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "RETRYABLE_ERROR", failureCode: "CHECKER_EVIDENCE_INVALID",
  }).failureLabel, "图片已生成，但质检证据不一致；系统自动纠正后仍未通过，可以重试");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "RETRYABLE_ERROR", failureCode: "RETRYABLE_GATEWAY",
  }).failureLabel, "当前 AI 图片通道暂时不可用，请检查通道后重试");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "RETRYABLE_ERROR",
    failureCode: "AUTO_LISTING_IMAGE_GATEWAY_INVALID",
  }).failureLabel, "图片服务返回异常结果，可以重试；已通过的图片不会重复生成");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "BLOCKED",
    failureCode: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID",
  }).failureLabel, "图片生成规则校验失败，可以重试；已通过的图片不会重复生成");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "BLOCKED",
    failureCode: "OZON_RICH_CONTENT_REJECTED_REQUIRES_REVIEW",
  }).failureLabel, "商品和库存已提交，但 Ozon 拒绝了富文本内容，请检查后重试");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "RETRYABLE_ERROR",
    failureCode: "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED",
  }).failureLabel, "保存生成内容失败，可以重试；已通过的图片不会重复生成");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "BLOCKED",
    failureCode: "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID",
  }).failureLabel, "商品资料中的内部字段未正确排除，可以重试；已通过的图片不会重复生成");
  const imageFailures = [
    ["PRODUCT_IDENTITY_MISMATCH", "生成图片中的商品与采集来源不一致，请重新生成"],
    ["UNVERIFIED_CLAIM", "生成图片含有商品资料未支持的文案或功能信息，请重新生成"],
    ["LANGUAGE_MISMATCH", "生成图片文案不符合俄语或已确认名称，请重新生成"],
    ["PROHIBITED_CONTENT", "生成图片含有不受商品资料支持的承诺、配件关系或推广内容，请重新生成"],
    ["IMAGE_QUALITY_FAILED", "生成图片存在模糊、裁切、遮挡或文字失真，请重新生成"],
    ["CATEGORY_STYLE_MISMATCH", "生成图片与已发布的类目图片策略风格不一致，请重新生成"],
  ];
  for (const [failureCode, expected] of imageFailures) assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "RETRYABLE_ERROR", failureCode,
  }).failureLabel, expected);
});

test("uses fixed category recovery copy without exposing backend details", () => {
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "UPLOADING",
    failureCode: "AUTO_LISTING_CATEGORY_RECOVERY_INVALIDATED",
  }).failureLabel, "Ozon 类目已失效，正在自动修复");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "UPLOADING",
    failureCode: "AUTO_LISTING_CATEGORY_RECOVERY_MATCHED",
  }).failureLabel, "类目已重新匹配，正在继续上架");
  assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "BLOCKED",
    failureCode: "AUTO_LISTING_CATEGORY_RECOVERY_NEEDS_REVIEW",
  }).failureLabel, "无法确认商品类目，请人工选择");
  for (const failureCode of [
    "AUTO_LISTING_CATEGORY_RETRY_TASK_UNKNOWN",
    "AUTO_LISTING_CATEGORY_RECOVERY_PRODUCT_UNKNOWN",
  ]) assert.equal(autoListingItemPresentation({
    itemId: "item-a", status: "UPLOADING", failureCode,
  }).failureLabel, "Ozon 返回结果不明确，正在核对原任务");
});

test("flattens list DTOs with only the owning job identity and canonical real creation time", () => {
  const item = {
    itemId: "item-a", sourceRecordId: "collect-a", targetStoreId: "store-a",
    status: "SOURCE_READY", jobId: "forged", jobCreatedAt: "forged",
    actions: { review: false, approve: false, retry: false, regenerate: false, cancel: true },
    price: {
      currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000",
      greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "0",
      finalPriceKopecks: "14500",
    },
    rawVendorPayload: "<script>secret</script>",
    workflowProgress: {
      phase: "PLAN_CONTENT", state: "RUNNING", attemptCount: 1,
      updatedAt: "2026-08-14T01:02:03.000Z", nextRetryAt: null,
    },
  };
  const rows = autoListingTaskRows([{
    jobId: "job-new",
    createdAt: "2026-08-12T01:02:03.456Z",
    secret: "must-not-copy",
    items: [item],
  }, {
    jobId: "job-invalid-time",
    createdAt: "not-a-time",
    items: [{ itemId: "item-b", status: "BLOCKED" }],
  }]);
  assert.deepEqual(rows, [{
    itemId: "item-a", sourceRecordId: "collect-a", targetStoreId: "store-a",
    status: "SOURCE_READY",
    workflowProgress: {
      phase: "PLAN_CONTENT", state: "RUNNING", attemptCount: 1,
      updatedAt: "2026-08-14T01:02:03.000Z", nextRetryAt: null,
    },
    actions: { review: false, approve: false, retry: false, regenerate: false, cancel: true },
    price: {
      currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000",
      greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "0",
      finalPriceKopecks: "14500",
    },
    jobId: "job-new", jobCreatedAt: "2026-08-12T01:02:03.456Z",
  }, {
    itemId: "item-b", status: "BLOCKED", jobId: "job-invalid-time", jobCreatedAt: null,
  }]);
  assert.equal(rows.some((row) => "secret" in row), false);
});

test("presents durable queue progress with attempts and safe canonical timestamps", () => {
  const item = autoListingItemPresentation({
    itemId: "item-progress", status: "PLANNING",
    workflowProgress: {
      phase: "PLAN_CONTENT", state: "RETRY_WAIT", attemptCount: 2,
      updatedAt: "2026-08-14T01:02:03.000Z", nextRetryAt: "2026-08-14T01:03:03.000Z",
    },
  });
  assert.deepEqual(item.workflowProgress, {
    label: "等待自动重试", detail: "图片内容规划 · 已尝试 2 次",
    updatedLabel: "最后更新 2026-08-14 09:02:03", retryLabel: "下次重试 2026-08-14 09:03:03",
  });
});

test("projects safe AI queue copy while waiting preserves the last completed percentage", () => {
  const actionState = { review: false, approve: false, retry: false, regenerate: false, cancel: true };
  const queueItem = ({ itemId, status, phase, aiQueueState, aiChannelDisplayName, aiChannelSwitching, aiChannelWaitStartedAt }) => ({
    itemId, status, actions: { ...actionState },
    aiQueueState, aiChannelDisplayName, aiChannelSwitching, aiChannelWaitStartedAt,
    workflowProgress: {
      phase, state: aiQueueState === "CALLING_AI" ? "RUNNING" : "QUEUED", attemptCount: 1,
      updatedAt: "2026-08-28T01:02:03.000Z", nextRetryAt: null,
    },
  });
  const rows = autoListingTaskRows([{
    jobId: "job-ai-queue", createdAt: "2026-08-28T01:00:00.000Z", items: [
      queueItem({
        itemId: "waiting", status: "PLANNING", phase: "PLAN_CONTENT",
        aiQueueState: "WAITING_FOR_AI_CHANNEL", aiChannelDisplayName: null,
        aiChannelSwitching: false, aiChannelWaitStartedAt: "2026-08-28T01:01:00.000Z",
      }),
      queueItem({
        itemId: "calling", status: "GENERATING", phase: "GENERATE_IMAGE_SLOT",
        aiQueueState: "CALLING_AI", aiChannelDisplayName: "主通道",
        aiChannelSwitching: false, aiChannelWaitStartedAt: null,
      }),
      queueItem({
        itemId: "switching", status: "GENERATING", phase: "GENERATE_IMAGE_SLOT",
        aiQueueState: "SWITCHING_AI_CHANNEL", aiChannelDisplayName: "故障通道",
        aiChannelSwitching: true, aiChannelWaitStartedAt: "2026-08-28T01:02:00.000Z",
      }),
    ],
  }]);

  assert.deepEqual(rows.map((row) => ({
    state: row.aiQueueState,
    name: row.aiChannelDisplayName,
    switching: row.aiChannelSwitching,
    waitStartedAt: row.aiChannelWaitStartedAt,
  })), [
    { state: "WAITING_FOR_AI_CHANNEL", name: null, switching: false, waitStartedAt: "2026-08-28T01:01:00.000Z" },
    { state: "CALLING_AI", name: "主通道", switching: false, waitStartedAt: null },
    { state: "SWITCHING_AI_CHANNEL", name: "故障通道", switching: true, waitStartedAt: "2026-08-28T01:02:00.000Z" },
  ]);
  assert.deepEqual(rows.map((row) => autoListingItemPresentation(row).aiQueueLabel), [
    "等待可用 AI 通道",
    "正在使用「主通道」生成",
    "原通道暂不可用，正在等待其他通道",
  ]);
  assert.deepEqual(rows.map((row) => autoListingTaskProgress(row).percent), [15, 60, 30]);
  assert.equal(autoListingItemPresentation(rows[0]).workflowProgress.detail, "图片内容规划 · 已尝试 1 次");
});

test("AI queue projection rejects inconsistent values and never passes channel internals", () => {
  const base = {
    itemId: "item-ai-queue", status: "PLANNING",
    aiQueueState: "WAITING_FOR_AI_CHANNEL", aiChannelDisplayName: null,
    aiChannelSwitching: false, aiChannelWaitStartedAt: "2026-08-28T01:02:03.000Z",
    channelId: "channel-secret", connectionId: "connection-secret", connectionVersion: 9,
    executionLeaseToken: "lease-secret", rawGatewayError: "Authorization: Bearer secret",
  };
  const rows = autoListingTaskRows([{
    jobId: "job-ai-queue", createdAt: "2026-08-28T01:00:00.000Z", items: [base],
  }]);
  assert.equal(rows.length, 1);
  assert.doesNotMatch(JSON.stringify(rows), /channel-secret|connection-secret|lease-secret|Bearer secret|connectionVersion/u);
  for (const item of [
    { ...base, aiQueueState: "UNKNOWN" },
    { ...base, aiChannelSwitching: true },
    { ...base, aiChannelWaitStartedAt: "not-a-time" },
    { ...base, aiQueueState: "CALLING_AI", aiChannelDisplayName: null, aiChannelWaitStartedAt: null },
  ]) assert.deepEqual(autoListingTaskRows([{
    jobId: "job-ai-queue", createdAt: "2026-08-28T01:00:00.000Z", items: [item],
  }]), []);
});

test("task rows reject hostile carriers and nested authority without executing accessors", () => {
  const baseItem = {
    itemId: "item-a", status: "SOURCE_READY", sourceRecordId: "collect-a",
    targetStoreId: "store-a",
    actions: { review: false, approve: false, retry: false, regenerate: false, cancel: true },
  };
  const job = (item) => ({
    jobId: "job-a", createdAt: "2026-08-12T01:02:03.000Z", items: [item],
  });
  let getterCalls = 0;
  const itemAccessor = { ...baseItem };
  Object.defineProperty(itemAccessor, "status", {
    enumerable: true,
    get() { getterCalls += 1; return "SOURCE_READY"; },
  });
  const extraAccessor = { ...baseItem };
  Object.defineProperty(extraAccessor, "rawVendorPayload", {
    enumerable: true,
    get() { getterCalls += 1; return "secret"; },
  });
  const nestedAccessor = { ...baseItem, actions: { ...baseItem.actions } };
  Object.defineProperty(nestedAccessor.actions, "review", {
    enumerable: true,
    get() { getterCalls += 1; return false; },
  });
  const priceAccessor = { ...baseItem, price: {
    currency: "RUB", branch: "BLACK_GTE_80", finalPriceKopecks: "14500",
  } };
  Object.defineProperty(priceAccessor.price, "finalPriceKopecks", {
    enumerable: true,
    get() { getterCalls += 1; return "14500"; },
  });
  const progressAccessor = { ...baseItem, workflowProgress: {
    phase: "PLAN_CONTENT", state: "RUNNING", attemptCount: 1,
    updatedAt: "2026-08-14T01:02:03.000Z", nextRetryAt: null,
  } };
  Object.defineProperty(progressAccessor.workflowProgress, "state", {
    enumerable: true,
    get() { getterCalls += 1; return "RUNNING"; },
  });
  const customPrototype = Object.assign(Object.create({ inherited: "raw" }), baseItem);
  const transparent = new Proxy({ ...baseItem }, {});
  const { proxy: revokedItem, revoke: revokeItem } = Proxy.revocable({ ...baseItem }, {});
  revokeItem();
  let trapCalls = 0;
  const trapProxy = (value) => new Proxy(value, {
    getPrototypeOf() { trapCalls += 1; return Object.prototype; },
    ownKeys() { trapCalls += 1; return []; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
    get() { trapCalls += 1; return undefined; },
  });

  for (const candidate of [
    itemAccessor,
    extraAccessor,
    nestedAccessor,
    priceAccessor,
    progressAccessor,
    customPrototype,
    transparent,
    revokedItem,
    trapProxy({ ...baseItem }),
    { ...baseItem, actions: trapProxy({ ...baseItem.actions }) },
    { ...baseItem, price: trapProxy({ currency: "RUB", branch: "BLACK_LT_80", blackKopecks: "7999", realPriceKopecks: "7465", adjustmentKopecks: "0", finalPriceKopecks: "7465" }) },
    { ...baseItem, actions: { ...baseItem.actions, raw: true } },
    { ...baseItem, price: { currency: "RUB", branch: "UNKNOWN", finalPriceKopecks: "14500" } },
    { ...baseItem, workflowProgress: { phase: "PLAN_CONTENT", state: "RUNNING", attemptCount: 1, updatedAt: "bad", nextRetryAt: null } },
    { ...baseItem, workflowProgress: { phase: "PLAN_CONTENT", state: "RUNNING", attemptCount: 1, updatedAt: "2026-08-14T01:02:03.000Z", nextRetryAt: null, raw: true } },
  ]) assert.deepEqual(autoListingTaskRows([job(candidate)]), []);

  const jobAccessor = job(baseItem);
  Object.defineProperty(jobAccessor, "jobId", {
    enumerable: true,
    get() { getterCalls += 1; return "job-a"; },
  });
  assert.deepEqual(autoListingTaskRows([jobAccessor]), []);
  assert.deepEqual(autoListingTaskRows([new Proxy(job(baseItem), {})]), []);
  assert.deepEqual(autoListingTaskRows([trapProxy(job(baseItem))]), []);
  assert.deepEqual(autoListingTaskRows([{ ...job(baseItem), secret: "must-not-copy" }]), [{
    ...baseItem, jobId: "job-a", jobCreatedAt: "2026-08-12T01:02:03.000Z",
  }]);
  const { proxy: revokedJobs, revoke: revokeJobs } = Proxy.revocable([], {});
  revokeJobs();
  assert.deepEqual(autoListingTaskRows(revokedJobs), []);
  assert.equal(getterCalls, 0);
  assert.equal(trapCalls, 0);
});

test("task rows preserve only the expanded public source evidence used by the task center", () => {
  const actions = { review: false, approve: false, retry: false, regenerate: false, cancel: false };
  const rows = autoListingTaskRows([{
    jobId: "job-expanded",
    createdAt: "2026-08-25T00:00:00.000Z",
    items: [{
      itemId: "item-expanded",
      status: "BLOCKED",
      updatedAt: "2026-08-25T00:02:03.000Z",
      sourceRecordId: "collect-expanded",
      sourceOrder: 2,
      sourceThumbnailUrl: "https://example.test/expanded.jpg",
      sourceTitle: "扩展来源商品",
      sourceSku: "SKU-EXPANDED",
      jobCreatedAt: "2026-08-24T23:59:59.000Z",
      failureStage: "UPLOAD",
      actions,
      privateSourcePayload: "must-not-copy",
    }],
  }]);
  assert.deepEqual(rows, [{
    itemId: "item-expanded",
    status: "BLOCKED",
    updatedAt: "2026-08-25T00:02:03.000Z",
    sourceRecordId: "collect-expanded",
    sourceOrder: 2,
    sourceThumbnailUrl: "https://example.test/expanded.jpg",
    sourceTitle: "扩展来源商品",
    sourceSku: "SKU-EXPANDED",
    failureStage: "UPLOAD",
    actions,
    jobId: "job-expanded",
    jobCreatedAt: "2026-08-25T00:00:00.000Z",
  }]);
  assert.equal("privateSourcePayload" in rows[0], false);
});

test("task rows accept exact legacy and multiplier public price evidence without mixing shapes", () => {
  const base = {
    itemId: "item-a", status: "SOURCE_READY", sourceRecordId: "collect-a",
    targetStoreId: "store-a",
  };
  const row = (price) => autoListingTaskRows([{
    jobId: "job-a", createdAt: "2026-08-12T01:02:03.000Z", items: [{ ...base, price }],
  }]);
  const high = {
    currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000",
    greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "-500",
    finalPriceKopecks: "14000",
  };
  const low = {
    currency: "CNY", branch: "BLACK_LT_80", blackKopecks: "7999",
    realPriceKopecks: "7465", adjustmentKopecks: "0", finalPriceKopecks: "7465",
  };
  const multiplierHigh = {
    ...high,
    preMultiplierPriceKopecks: "14000",
    priceMultiplierMicros: "1250000",
    finalPriceKopecks: "17500",
  };
  const multiplierLow = {
    ...low,
    preMultiplierPriceKopecks: "7465",
    priceMultiplierMicros: "1000000",
  };
  assert.deepEqual(row(high)[0].price, high);
  assert.deepEqual(row(low)[0].price, low);
  assert.deepEqual(row(multiplierHigh)[0].price, multiplierHigh);
  assert.deepEqual(row(multiplierLow)[0].price, multiplierLow);
  for (const invalid of [
    { ...high, currency: undefined },
    { ...high, branch: undefined },
    { ...high, blackKopecks: undefined },
    { ...high, greenKopecks: undefined },
    { ...high, realPriceKopecks: undefined },
    { ...high, adjustmentKopecks: undefined },
    { ...high, finalPriceKopecks: undefined },
    { ...low, greenKopecks: "7000" },
    { ...high, raw: "secret" },
    { ...high, currency: "USD" },
    { ...high, branch: "UNKNOWN" },
    { ...high, blackKopecks: "0" },
    { ...high, blackKopecks: "-1" },
    { ...high, greenKopecks: "0" },
    { ...high, greenKopecks: "-1" },
    { ...high, realPriceKopecks: "0" },
    { ...high, realPriceKopecks: "-1" },
    { ...high, finalPriceKopecks: "0" },
    { ...high, finalPriceKopecks: "-1" },
    { ...high, finalPriceKopecks: "+14000" },
    { ...high, greenKopecks: "01" },
    { ...high, adjustmentKopecks: "-0" },
    { ...high, adjustmentKopecks: "+1" },
    { ...high, adjustmentKopecks: "01" },
    { ...high, finalPriceKopecks: "1".repeat(31) },
    { ...high, preMultiplierPriceKopecks: "14000" },
    { ...high, priceMultiplierMicros: "1250000" },
    { ...multiplierHigh, preMultiplierPriceKopecks: undefined },
    { ...multiplierHigh, priceMultiplierMicros: undefined },
    { ...multiplierHigh, preMultiplierPriceKopecks: "0" },
    { ...multiplierHigh, priceMultiplierMicros: "0" },
  ]) assert.deepEqual(row(invalid), [], JSON.stringify(invalid));
});

test("item presentation fails closed for hostile rows and action carriers", () => {
  let calls = 0;
  let trapCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "status", {
    enumerable: true,
    get() { calls += 1; return "SUCCEEDED"; },
  });
  const hostileActions = {
    itemId: "item-a", status: "SUCCEEDED",
    actions: { review: true, approve: false, retry: false, regenerate: false, cancel: false, extra: true },
  };
  const fallback = {
    itemId: "", status: "", statusLabel: "未知状态", tone: "default",
    failureLabel: "",
    actions: { review: false, approve: false, retry: false, regenerate: false, cancel: false },
  };
  const trapped = new Proxy({ itemId: "item-a", status: "SUCCEEDED" }, {
    getPrototypeOf() { trapCalls += 1; return Object.prototype; },
    ownKeys() { trapCalls += 1; return []; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
    get() { trapCalls += 1; return undefined; },
  });
  assert.deepEqual(autoListingItemPresentation(accessor), fallback);
  assert.deepEqual(autoListingItemPresentation(new Proxy({ itemId: "item-a", status: "SUCCEEDED" }, {})), fallback);
  assert.deepEqual(autoListingItemPresentation(trapped), fallback);
  assert.deepEqual(autoListingItemPresentation(hostileActions).actions, fallback.actions);
  assert.equal(calls, 0);
  assert.equal(trapCalls, 0);
});

test("formats persisted timestamps in China time and never substitutes the current time", () => {
  assert.equal(autoListingCreatedAtLabel("2026-08-15T11:13:23.454Z"), "2026-08-15 19:13:23");
  assert.equal(autoListingCreatedAtLabel("2026-08-15T17:30:00.000Z"), "2026-08-16 01:30:00");
  assert.equal(autoListingCreatedAtLabel("2026-08-15T16:00:00.000Z"), "2026-08-16 00:00:00");
  assert.equal(autoListingCreatedAtLabel("not-a-time"), "—");
  assert.equal(autoListingCreatedAtLabel(""), "—");
  assert.equal(autoListingCreatedAtLabel(undefined), "—");
});

test("projects selected collect rows in URL order with display-safe fallbacks", () => {
  const localData = { caches: { collectBox: [
    { id: "collect-a", image: "https://example.test/a.jpg", name: "商品 A", sku: "SKU-A" },
    { id: "collect-b", primaryImage: "https://example.test/b.jpg", title: "商品 B" },
    { id: "collect-c", images: ["https://example.test/c.jpg"], productUrl: "https://ozon.test/c" },
  ] } };
  assert.deepEqual(autoListingCollectSelectionRows(localData, ["collect-b", "collect-a", "collect-c"]), [
    { id: "collect-b", thumbnailUrl: "https://example.test/b.jpg", title: "商品 B", sku: "collect-b" },
    { id: "collect-a", thumbnailUrl: "https://example.test/a.jpg", title: "商品 A", sku: "SKU-A" },
    { id: "collect-c", thumbnailUrl: "https://example.test/c.jpg", title: "https://ozon.test/c", sku: "collect-c" },
  ]);
  assert.deepEqual(autoListingCollectSelectionRows({ collectBox: [{ id: "collect-empty" }] }, ["collect-empty"]), [
    { id: "collect-empty", thumbnailUrl: "", title: "", sku: "collect-empty" },
  ]);
});

test("collect selection skips accessor carriers without disturbing safe URL order", () => {
  let getterCalls = 0;
  const badRow = { id: "collect-bad" };
  for (const key of ["image", "primaryImage", "images", "name", "title", "productUrl", "sku"]) {
    Object.defineProperty(badRow, key, {
      enumerable: true,
      get() { getterCalls += 1; return "must-not-read"; },
    });
  }
  const localData = { collectBox: [
    { id: "collect-a", name: "商品 A", sku: "SKU-A" },
    badRow,
    { id: "collect-b", title: "商品 B", sku: "SKU-B" },
  ] };
  Object.defineProperty(localData, "caches", {
    enumerable: true,
    get() { getterCalls += 1; return { collectBox: [] }; },
  });
  const requested = ["collect-b", "collect-bad", "collect-a"];
  const expected = [
    { id: "collect-b", thumbnailUrl: "", title: "商品 B", sku: "SKU-B" },
    { id: "collect-bad", thumbnailUrl: "", title: "", sku: "collect-bad" },
    { id: "collect-a", thumbnailUrl: "", title: "商品 A", sku: "SKU-A" },
  ];
  assert.deepEqual(autoListingCollectSelectionRows(localData, requested), expected);
  const cache = {};
  Object.defineProperty(cache, "collectBox", {
    enumerable: true,
    get() { getterCalls += 1; return []; },
  });
  assert.deepEqual(autoListingCollectSelectionRows({ caches: cache, collectBox: localData.collectBox }, requested), expected);
  assert.equal(getterCalls, 0);
});

test("derives task progress from the persisted workflow without completing failures", () => {
  assert.equal(autoListingTaskProgress({ status: "UPLOADING" }).percent, 95);
  assert.equal(autoListingTaskProgress({ status: "BLOCKED", failureStage: "UPLOAD" }).percent, 95);
  assert.equal(autoListingTaskProgress({
    status: "RETRYABLE_ERROR", failureStage: "GENERATION",
    workflowProgress: { phase: "GENERATE_IMAGE_SLOT" },
  }).percent, 60);
  assert.equal(autoListingTaskProgress({ status: "CANCELLED", failureStage: "GENERATION" }).percent, 60);
  assert.equal(autoListingTaskProgress({ status: "CANCELLED", failureStage: "UPLOAD" }).percent, 95);
  assert.ok(autoListingTaskProgress({ status: "BLOCKED", failureStage: "UPLOAD" }).percent < 100);
  assert.ok(autoListingTaskProgress({ status: "CANCELLED", failureStage: "UPLOAD" }).percent < 100);
});

test("derives fixed terminal and live active task durations from the job start", () => {
  const start = Date.parse("2026-08-25T00:00:00.000Z");
  assert.deepEqual(autoListingTaskDuration({
    status: "SUCCEEDED", jobCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:02:03.000Z",
  }, Date.parse("2026-08-25T01:00:00.000Z")), { milliseconds: 123000, terminal: true, prefix: "总用时" });
  assert.deepEqual(autoListingTaskDuration({
    status: "BLOCKED", jobCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:02:03.000Z",
  }, Date.parse("2026-08-25T01:00:00.000Z")), { milliseconds: 123000, terminal: true, prefix: "未上架 · 已用时" });
  assert.deepEqual(autoListingTaskDuration({
    status: "READY_FOR_REVIEW", jobCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:02:03.000Z",
  }, start + 180000), { milliseconds: 180000, terminal: false, prefix: "已用时" });
  assert.deepEqual(autoListingTaskDuration({
    status: "CANCELLED", jobCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:02:03.000Z",
  }, Date.parse("2026-08-25T01:00:00.000Z")), { milliseconds: 123000, terminal: true, prefix: "未上架 · 已用时" });
});

test("shows image preparation progress and separates the current upload stage from total task time", () => {
  const [preparing] = autoListingTaskRows([{
    jobId: "job-upload",
    createdAt: "2026-08-25T00:00:00.000Z",
    items: [{
      itemId: "item-upload",
      status: "UPLOADING",
      updatedAt: "2026-08-25T01:00:00.000Z",
      uploadPreparation: { published: 3, total: 12 },
    }],
  }]);
  assert.deepEqual(preparing.uploadPreparation, { published: 3, total: 12 });
  assert.equal(autoListingItemPresentation(preparing).statusLabel, "正在准备图片 3/12");
  assert.equal(autoListingTaskProgress(preparing).percent, 87);
  assert.deepEqual(
    autoListingStageDuration(preparing, Date.parse("2026-08-25T01:02:03.000Z")),
    { milliseconds: 123000, prefix: "当前阶段" },
  );
  assert.deepEqual(
    autoListingTaskDuration(preparing, Date.parse("2026-08-25T01:02:03.000Z")),
    { milliseconds: 3723000, terminal: false, prefix: "已用时" },
  );

  assert.equal(autoListingItemPresentation({
    itemId: "item-ready", status: "UPLOADING", uploadPreparation: { published: 12, total: 12 },
  }).statusLabel, "图片已准备，正在提交到 Ozon");
  assert.equal(autoListingTaskProgress({
    status: "UPLOADING", uploadPreparation: { published: 12, total: 12 },
  }).percent, 95);
  assert.equal(autoListingItemPresentation({ itemId: "item-queued", status: "UPLOAD_QUEUED" }).statusLabel,
    "等待处理上传任务");
  assert.equal(autoListingStageDuration({ status: "GENERATING", updatedAt: "2026-08-25T01:00:00.000Z" }), null);
});

test("matches exactly the seven task center filters", () => {
  const rows = {
    processing: { status: "GENERATING" },
    review: { status: "READY_FOR_REVIEW" },
    preparationFailed: { status: "BLOCKED", failureStage: "PREPARATION" },
    generationFailed: { status: "RETRYABLE_ERROR", failureStage: "GENERATION" },
    uploadFailed: { status: "BLOCKED", failureStage: "UPLOAD" },
    succeeded: { status: "SUCCEEDED" },
    cancelled: { status: "CANCELLED" },
  };
  assert.equal(autoListingTaskMatchesFilter(rows.processing, "all"), true);
  assert.equal(autoListingTaskMatchesFilter(rows.processing, "processing"), true);
  assert.equal(autoListingTaskMatchesFilter(rows.review, "review"), true);
  assert.equal(autoListingTaskMatchesFilter(rows.preparationFailed, "generation-failed"), true);
  assert.equal(autoListingTaskMatchesFilter(rows.generationFailed, "generation-failed"), true);
  assert.equal(autoListingTaskMatchesFilter(rows.uploadFailed, "upload-failed"), true);
  assert.equal(autoListingTaskMatchesFilter(rows.succeeded, "succeeded"), true);
  assert.equal(autoListingTaskMatchesFilter(rows.cancelled, "cancelled"), true);
  assert.equal(autoListingTaskMatchesFilter(rows.uploadFailed, "generation-failed"), false);
  assert.equal(autoListingTaskMatchesFilter(rows.succeeded, "unknown"), false);
});

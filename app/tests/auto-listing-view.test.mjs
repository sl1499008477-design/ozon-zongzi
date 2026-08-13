import assert from "node:assert/strict";
import test from "node:test";

import {
  autoListingActionAvailability,
  autoListingImportProgress,
  autoListingImportRowPresentation,
  autoListingItemPresentation,
  autoListingTaskRows,
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
    customPrototype,
    transparent,
    revokedItem,
    trapProxy({ ...baseItem }),
    { ...baseItem, actions: trapProxy({ ...baseItem.actions }) },
    { ...baseItem, price: trapProxy({ currency: "RUB", branch: "BLACK_LT_80", blackKopecks: "7999", realPriceKopecks: "7465", adjustmentKopecks: "0", finalPriceKopecks: "7465" }) },
    { ...baseItem, actions: { ...baseItem.actions, raw: true } },
    { ...baseItem, price: { currency: "RUB", branch: "UNKNOWN", finalPriceKopecks: "14500" } },
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

test("task rows accept only the two exact canonical public price branches", () => {
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
  assert.deepEqual(row(high)[0].price, high);
  assert.deepEqual(row(low)[0].price, low);
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

test("formats only a persisted timestamp and never substitutes the current time", () => {
  assert.equal(autoListingCreatedAtLabel("2026-08-12T01:02:03.456Z"), "2026-08-12 01:02:03");
  assert.equal(autoListingCreatedAtLabel("not-a-time"), "—");
  assert.equal(autoListingCreatedAtLabel(""), "—");
  assert.equal(autoListingCreatedAtLabel(undefined), "—");
});

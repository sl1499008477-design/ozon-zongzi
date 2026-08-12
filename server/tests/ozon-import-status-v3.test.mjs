import assert from "node:assert/strict";
import { deriveOzonImportStatus } from "../ozon-import-status.mjs";

const success = deriveOzonImportStatus({
  result: {
    items: [
      { offer_id: "offer-1", product_id: 101, status: "imported" },
      { offer_id: "offer-2", product_id: 102, status: "success" },
    ],
  },
}, { expectedOfferIds: ["offer-1", "offer-2"] });
assert.equal(success.status, "SUCCEEDED");
assert.equal(success.done, true);
assert.equal(success.success, 2);
assert.deepEqual(success.items.map((item) => item.classification), ["SUCCEEDED", "SUCCEEDED"]);
assert.deepEqual(success.items.map((item) => item.errorEvidence), [null, null]);
assert.equal(Object.isFrozen(success), true);
assert.equal(Object.isFrozen(success.items), true);
assert.equal(Object.isFrozen(success.items[0].response), true);

const partial = deriveOzonImportStatus({
  result: {
    items: [
      { offer_id: "offer-1", product_id: 101, status: "imported" },
      { offer_id: "offer-2", status: "failed", errors: [{ code: "ATTRIBUTE_INVALID", field: "attribute", message: "属性无效" }] },
    ],
  },
}, { expectedOfferIds: ["offer-1", "offer-2"] });
assert.equal(partial.status, "PARTIAL_SUCCESS");
assert.equal(partial.done, true);
assert.equal(partial.success, 1);
assert.equal(partial.failed, 1);
assert.equal(partial.errorMessage, "Ozon 返回商品导入失败");
assert.equal(partial.items[1].classification, "OTHER_TERMINAL_FAILURE");
assert.equal(partial.items[1].errorEvidence, null);
assert.equal(partial.items[1].response.errors[0].message, "属性无效");
assert.doesNotMatch(JSON.stringify({
  errorMessage: partial.errorMessage,
  errors: partial.items[1].errors,
  errorEvidence: partial.items[1].errorEvidence,
}), /属性无效/);

const checking = deriveOzonImportStatus({
  result: {
    items: [
      { offer_id: "offer-1", status: "imported" },
      { offer_id: "offer-2", status: "processing" },
    ],
  },
}, { expectedOfferIds: ["offer-1", "offer-2"] });
assert.equal(checking.status, "CHECKING");
assert.equal(checking.done, false);
assert.equal(checking.items[1].classification, "CHECKING");

const skippedBatch = deriveOzonImportStatus({
  result: {
    items: [
      { offer_id: "offer-1", status: "skipped", errors: [{ code: "UNKNOWN", field: "unknown" }] },
      { offer_id: "offer-2", status: "failed", errors: [{
        code: "TEST_ONLY_EXACT_CATEGORY_CODE", field: "description_category_id",
      }] },
    ],
  },
}, { expectedOfferIds: ["offer-1", "offer-2"] });
assert.equal(skippedBatch.status, "PARTIAL_SUCCESS");
assert.equal(skippedBatch.items[0].status, "SKIPPED");
assert.equal(skippedBatch.items[0].classification, "OTHER_TERMINAL_FAILURE");
assert.equal(skippedBatch.items.every((item) => item.errorEvidence === null), true);

const rejected = deriveOzonImportStatus({
  result: { status: "validation_error", errors: [{ message: "请求校验失败" }] },
});
assert.equal(rejected.status, "FAILED");
assert.equal(rejected.done, true);
assert.equal(rejected.errorMessage, "Ozon 返回商品导入失败");
assert.doesNotMatch(JSON.stringify(rejected), /请求校验失败/);

let getterReads = 0;
const hostileItem = { status: "failed", errors: [] };
Object.defineProperty(hostileItem, "offer_id", {
  enumerable: true,
  get() { getterReads += 1; throw new Error("status-secret"); },
});
const hostile = deriveOzonImportStatus({ result: { items: [hostileItem] } }, {
  expectedOfferIds: ["offer-1"],
});
assert.equal(getterReads, 0);
assert.equal(hostile.status, "UNKNOWN_RESULT");
assert.equal(hostile.done, false);
assert.doesNotMatch(JSON.stringify(hostile), /status-secret/);

const messageOnly = deriveOzonImportStatus({ result: { items: [{
  offer_id: "offer-1",
  product_id: 0,
  status: "failed",
  errors: [{ code: "UNKNOWN", field: "unknown", message: "category description_category_id invalid" }],
}] } }, { expectedOfferIds: ["offer-1"] });
assert.equal(messageOnly.items[0].classification, "OTHER_TERMINAL_FAILURE");
assert.equal(messageOnly.items[0].errorEvidence, null);
assert.equal(messageOnly.items[0].response.errors[0].message, "category description_category_id invalid");
assert.doesNotMatch(JSON.stringify({
  errorMessage: messageOnly.errorMessage,
  errors: messageOnly.items[0].errors,
  errorEvidence: messageOnly.items[0].errorEvidence,
}), /description_category_id invalid/);

for (const identityFailure of [
  [{ offer_id: "offer-1", status: "imported" }, { offer_id: "offer-1", status: "imported" }],
  [{ offer_id: "offer-1", status: "imported" }],
  [{ offer_id: "offer-1", status: "imported" }, { offer_id: "unexpected", status: "imported" }],
]) {
  const result = deriveOzonImportStatus({ result: { items: identityFailure } }, {
    expectedOfferIds: ["offer-1", "offer-2"],
  });
  assert.equal(result.status, "UNKNOWN_RESULT");
  assert.equal(result.done, false);
  assert.equal(result.items.every((item) => item.classification === "UNKNOWN_RESULT"), true);
}

console.log("ozon import status v3 passed");

import assert from "node:assert/strict";
import { deriveOzonImportStatus } from "../ozon-import-status.mjs";

const success = deriveOzonImportStatus({
  result: {
    items: [
      { offer_id: "offer-1", product_id: 101, status: "imported" },
      { offer_id: "offer-2", product_id: 102, status: "success" },
    ],
  },
});
assert.equal(success.status, "SUCCEEDED");
assert.equal(success.done, true);
assert.equal(success.success, 2);

const partial = deriveOzonImportStatus({
  result: {
    items: [
      { offer_id: "offer-1", product_id: 101, status: "imported" },
      { offer_id: "offer-2", status: "failed", errors: [{ code: "ATTRIBUTE_INVALID", message: "属性无效" }] },
    ],
  },
});
assert.equal(partial.status, "PARTIAL_SUCCESS");
assert.equal(partial.done, true);
assert.equal(partial.success, 1);
assert.equal(partial.failed, 1);
assert.match(partial.errorMessage, /属性无效/);

const checking = deriveOzonImportStatus({
  result: {
    items: [
      { offer_id: "offer-1", status: "imported" },
      { offer_id: "offer-2", status: "processing" },
    ],
  },
});
assert.equal(checking.status, "CHECKING");
assert.equal(checking.done, false);

const rejected = deriveOzonImportStatus({
  result: { status: "validation_error", errors: [{ message: "请求校验失败" }] },
});
assert.equal(rejected.status, "FAILED");
assert.equal(rejected.done, true);
assert.match(rejected.errorMessage, /请求校验失败/);

console.log("ozon import status v3 passed");

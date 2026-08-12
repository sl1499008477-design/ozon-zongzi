import assert from "node:assert/strict";
import test from "node:test";
import * as productionPolicy from "../ozon-category-import-error-policy.mjs";

function failedItem(overrides = {}) {
  return {
    offer_id: "frozen-offer",
    product_id: 0,
    status: "failed",
    errors: [{ code: "EXACT_BUT_UNAPPROVED", field: "description_category_id" }],
    ...overrides,
  };
}

test("production module exposes no rule constructor, mutable policy, or test injection backdoor", () => {
  assert.deepEqual(Object.keys(productionPolicy).sort(), [
    "classifyOzonCategoryImportResult",
    "projectOzonImportCarrier",
    "projectProductionOzonImportErrorEvidence",
  ]);
  assert.equal("createOzonCategoryImportErrorPolicy" in productionPolicy, false);
  assert.equal("OZON_CATEGORY_IMPORT_ERROR_POLICY_V1" in productionPolicy, false);
});

test("fixed empty production V1 never emits explicit evidence for any exact-looking input", () => {
  const result = productionPolicy.classifyOzonCategoryImportResult({
    item: failedItem(), expectedOfferId: "frozen-offer", batchHasPartialOutcome: false,
  });
  assert.deepEqual(result, { classification: "OTHER_TERMINAL_FAILURE", errorEvidence: null });
  assert.equal(Object.isFrozen(result), true);
});

test("production classifies success, checking, terminal failure, skipped, and unknown safely", () => {
  const cases = [
    [{ offer_id: "frozen-offer", product_id: 123, status: "imported", errors: [] }, "SUCCEEDED"],
    [{ offer_id: "frozen-offer", product_id: 0, status: "processing", errors: [] }, "CHECKING"],
    [failedItem({ errors: [{ code: "UNKNOWN", field: "unknown" }] }), "OTHER_TERMINAL_FAILURE"],
    [failedItem({ status: "skipped" }), "OTHER_TERMINAL_FAILURE"],
    [failedItem({ status: "unexpected" }), "UNKNOWN_RESULT"],
  ];
  for (const [item, expected] of cases) {
    const result = productionPolicy.classifyOzonCategoryImportResult({
      item, expectedOfferId: "frozen-offer", batchHasPartialOutcome: false,
    });
    assert.equal(result.classification, expected);
    assert.equal(result.errorEvidence, null);
  }
});

test("success requires an exact positive safe product id", () => {
  const valid = productionPolicy.classifyOzonCategoryImportResult({
    item: { offer_id: "frozen-offer", product_id: Number.MAX_SAFE_INTEGER, status: "imported" },
    expectedOfferId: "frozen-offer",
  });
  assert.deepEqual(valid, { classification: "SUCCEEDED", errorEvidence: null });
  for (const productId of [
    0, -1, 1.5, Number.NaN, undefined, "", " ", "0", "01",
    Number.MAX_SAFE_INTEGER + 1, String(Number.MAX_SAFE_INTEGER + 1), {}, [],
  ]) {
    const item = { offer_id: "frozen-offer", product_id: productId, status: "imported" };
    if (productId === undefined) delete item.product_id;
    const result = productionPolicy.classifyOzonCategoryImportResult({
      item, expectedOfferId: "frozen-offer",
    });
    assert.deepEqual(result, { classification: "UNKNOWN_RESULT", errorEvidence: null });
  }
  assert.equal(productionPolicy.classifyOzonCategoryImportResult({
    item: { offer_id: "frozen-offer", product_id: String(Number.MAX_SAFE_INTEGER), status: "success" },
    expectedOfferId: "frozen-offer",
  }).classification, "SUCCEEDED");
});

test("message wording and non-category fields carry no production authority", () => {
  const cases = [
    failedItem({ errors: [{ code: "UNKNOWN", field: "unknown", message: "description_category_id category invalid" }] }),
    failedItem({ errors: [{ code: "ATTRIBUTE_INVALID", field: "attribute", message: "category" }] }),
    failedItem({ errors: [{ code: "currency_differs_from_contract", field: "currency" }] }),
    failedItem({ errors: [{ code: "AUTH", field: "authorization" }] }),
    failedItem({ errors: [{ code: "THROTTLED", field: "rate_limit" }] }),
    failedItem({ errors: [{ code: "BRAND", field: "brand" }] }),
    failedItem({ errors: [{ code: "WAREHOUSE", field: "warehouse_id" }] }),
    failedItem({ errors: [{ code: "STOCK", field: "stock" }] }),
  ];
  for (const item of cases) {
    const result = productionPolicy.classifyOzonCategoryImportResult({
      item, expectedOfferId: "frozen-offer", batchHasPartialOutcome: false,
    });
    assert.equal(result.classification, "OTHER_TERMINAL_FAILURE");
    assert.equal(result.errorEvidence, null);
  }
});

test("malformed, accessor, proxy, cyclic and oversized carriers fail closed without reads", () => {
  let getterReads = 0;
  const accessor = failedItem();
  Object.defineProperty(accessor, "offer_id", {
    enumerable: true,
    get() { getterReads += 1; throw new Error("source-evidence-secret"); },
  });
  const cyclic = failedItem();
  cyclic.loop = cyclic;
  const transparentProxy = new Proxy(failedItem(), {});
  const revocable = Proxy.revocable(failedItem(), {});
  revocable.revoke();
  for (const item of [
    null, [], accessor, transparentProxy, revocable.proxy, cyclic,
    failedItem({ note: "x".repeat(2_000_001) }),
    failedItem({ errors: Array.from({ length: 5_001 }, () => ({ code: "x", field: "x" })) }),
  ]) {
    const result = productionPolicy.classifyOzonCategoryImportResult({
      item, expectedOfferId: "frozen-offer", batchHasPartialOutcome: false,
    });
    assert.deepEqual(result, { classification: "UNKNOWN_RESULT", errorEvidence: null });
    assert.doesNotMatch(JSON.stringify(result), /source-evidence-secret|credential|authorization/iu);
  }
  assert.equal(getterReads, 0);
});

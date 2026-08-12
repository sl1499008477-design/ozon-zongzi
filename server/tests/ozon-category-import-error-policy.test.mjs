import assert from "node:assert/strict";
import test from "node:test";
import * as productionPolicy from "../ozon-category-import-error-policy.mjs";

const TEST_RULE = Object.freeze({
  code: "TEST_ONLY_EXACT_CATEGORY_CODE",
  field: "description_category_id",
  attributeId: null,
});

function failedItem(overrides = {}) {
  return {
    offer_id: "frozen-offer",
    product_id: 0,
    status: "failed",
    errors: [{ code: TEST_RULE.code, field: TEST_RULE.field }],
    ...overrides,
  };
}

// Test-only fixture for the future non-empty rule contract. It is intentionally not
// imported by production and cannot change the fixed empty V1 production policy.
function classifyWithTestRule({ item, expectedOfferId, batchHasPartialOutcome = false }) {
  const state = typeof item?.status === "string" ? item.status.toLowerCase() : "";
  if (["imported", "success"].includes(state)) return { classification: "SUCCEEDED", errorEvidence: null };
  if (["pending", "processing"].includes(state)) return { classification: "CHECKING", errorEvidence: null };
  if (state === "skipped") return { classification: "OTHER_TERMINAL_FAILURE", errorEvidence: null };
  if (state !== "failed") return { classification: "UNKNOWN_RESULT", errorEvidence: null };
  const productAbsent = item.product_id === 0 || item.product_id === "0" || item.product_id === "" || item.product_id == null;
  const exact = item.offer_id === expectedOfferId && item.errors?.some((error) =>
    error?.code === TEST_RULE.code && error?.field === TEST_RULE.field
      && !Object.hasOwn(error, "attribute_id"));
  if (!productAbsent || batchHasPartialOutcome || !exact) {
    return { classification: "OTHER_TERMINAL_FAILURE", errorEvidence: null };
  }
  const errorEvidence = Object.freeze({
    schemaVersion: "OZON_IMPORT_ERROR_EVIDENCE_V1",
    policyVersion: 77,
    code: TEST_RULE.code,
    field: TEST_RULE.field,
    attributeId: null,
    state: "FAILED",
    offerId: expectedOfferId,
    productId: null,
    classification: "EXPLICIT_CATEGORY_FAILURE",
  });
  return Object.freeze({ classification: "EXPLICIT_CATEGORY_FAILURE", errorEvidence });
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

test("test-only exact-rule engine requires FAILED and suppresses skipped and partial batches", () => {
  const explicit = classifyWithTestRule({ item: failedItem(), expectedOfferId: "frozen-offer" });
  assert.equal(explicit.classification, "EXPLICIT_CATEGORY_FAILURE");
  assert.equal(explicit.errorEvidence.state, "FAILED");
  assert.equal(Object.isFrozen(explicit), true);
  assert.equal(Object.isFrozen(explicit.errorEvidence), true);
  for (const input of [
    { item: failedItem({ status: "skipped" }), expectedOfferId: "frozen-offer" },
    { item: failedItem({ status: "error" }), expectedOfferId: "frozen-offer" },
    { item: failedItem({ status: "rejected" }), expectedOfferId: "frozen-offer" },
    { item: failedItem(), expectedOfferId: "frozen-offer", batchHasPartialOutcome: true },
    { item: failedItem({ product_id: 123 }), expectedOfferId: "frozen-offer" },
    { item: failedItem(), expectedOfferId: "other-offer" },
  ]) {
    const result = classifyWithTestRule(input);
    assert.notEqual(result.classification, "EXPLICIT_CATEGORY_FAILURE");
    assert.equal(result.errorEvidence, null);
  }
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

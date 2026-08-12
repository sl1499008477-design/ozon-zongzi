import assert from "node:assert/strict";
import test from "node:test";
import {
  OZON_CATEGORY_IMPORT_ERROR_POLICY_V1,
  classifyOzonCategoryImportResult,
  createOzonCategoryImportErrorPolicy,
} from "../ozon-category-import-error-policy.mjs";

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
    errors: [{
      code: TEST_RULE.code,
      field: TEST_RULE.field,
    }],
    ...overrides,
  };
}

const testPolicy = createOzonCategoryImportErrorPolicy({
  policyVersion: 77,
  rules: [TEST_RULE],
});

test("production V1 remains empty without an authoritative category-invalid fixture", () => {
  assert.equal(OZON_CATEGORY_IMPORT_ERROR_POLICY_V1.policyVersion, 1);
  assert.deepEqual(OZON_CATEGORY_IMPORT_ERROR_POLICY_V1.rules, []);
  assert.equal(Object.isFrozen(OZON_CATEGORY_IMPORT_ERROR_POLICY_V1), true);
  assert.equal(Object.isFrozen(OZON_CATEGORY_IMPORT_ERROR_POLICY_V1.rules), true);
  assert.deepEqual(classifyOzonCategoryImportResult({
    item: failedItem(), expectedOfferId: "frozen-offer",
  }), { classification: "OTHER_TERMINAL_FAILURE", errorEvidence: null });
});

test("classifier returns all closed lifecycle classifications", () => {
  assert.equal(testPolicy.classify({
    item: { offer_id: "frozen-offer", product_id: 123, status: "imported", errors: [] },
    expectedOfferId: "frozen-offer",
  }).classification, "SUCCEEDED");
  assert.equal(testPolicy.classify({
    item: { offer_id: "frozen-offer", product_id: 0, status: "processing", errors: [] },
    expectedOfferId: "frozen-offer",
  }).classification, "CHECKING");
  assert.equal(testPolicy.classify({
    item: failedItem(), expectedOfferId: "frozen-offer",
  }).classification, "EXPLICIT_CATEGORY_FAILURE");
  assert.equal(testPolicy.classify({
    item: failedItem({ errors: [{ code: "UNKNOWN_CODE", field: "description_category_id" }] }),
    expectedOfferId: "frozen-offer",
  }).classification, "OTHER_TERMINAL_FAILURE");
  assert.equal(testPolicy.classify({
    item: { offer_id: "frozen-offer", product_id: 0, status: "unexpected", errors: [] },
    expectedOfferId: "frozen-offer",
  }).classification, "UNKNOWN_RESULT");
});

test("explicit evidence is an exact versioned recursively frozen DTO", () => {
  const caller = failedItem();
  const result = testPolicy.classify({ item: caller, expectedOfferId: "frozen-offer" });
  assert.deepEqual(result, {
    classification: "EXPLICIT_CATEGORY_FAILURE",
    errorEvidence: {
      schemaVersion: "OZON_IMPORT_ERROR_EVIDENCE_V1",
      policyVersion: 77,
      code: TEST_RULE.code,
      field: "description_category_id",
      attributeId: null,
      state: "FAILED",
      offerId: "frozen-offer",
      productId: null,
      classification: "EXPLICIT_CATEGORY_FAILURE",
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.errorEvidence), true);
  assert.deepEqual(Object.keys(result.errorEvidence), [
    "schemaVersion", "policyVersion", "code", "field", "attributeId", "state",
    "offerId", "productId", "classification",
  ]);
  assert.equal(Object.isFrozen(caller), false);
  assert.equal(Object.isFrozen(caller.errors), false);
});

test("exact code, field and optional attribute identity are all required", () => {
  const numericPolicy = createOzonCategoryImportErrorPolicy({
    policyVersion: 78,
    rules: [{ ...TEST_RULE, field: "attribute", attributeId: 9042 }],
  });
  const cases = [
    failedItem({ errors: [{ code: "OTHER", field: TEST_RULE.field }] }),
    failedItem({ errors: [{ code: TEST_RULE.code, field: "type_id" }] }),
    failedItem({ errors: [{ code: TEST_RULE.code, field: TEST_RULE.field, attribute_id: 9042 }] }),
  ];
  for (const item of cases) {
    assert.notEqual(testPolicy.classify({ item, expectedOfferId: "frozen-offer" }).classification,
      "EXPLICIT_CATEGORY_FAILURE");
  }
  assert.equal(numericPolicy.classify({
    item: failedItem({ errors: [{ code: TEST_RULE.code, field: "attribute", attribute_id: 9042 }] }),
    expectedOfferId: "frozen-offer",
  }).classification, "EXPLICIT_CATEGORY_FAILURE");
  assert.notEqual(numericPolicy.classify({
    item: failedItem({ errors: [{ code: TEST_RULE.code, field: "attribute", attribute_id: 9043 }] }),
    expectedOfferId: "frozen-offer",
  }).classification, "EXPLICIT_CATEGORY_FAILURE");
});

test("offer mismatch, product presence, nonterminal state and partial success cannot be explicit", () => {
  const inputs = [
    { item: failedItem(), expectedOfferId: "other-offer" },
    { item: failedItem({ product_id: 123 }), expectedOfferId: "frozen-offer" },
    { item: failedItem({ status: "processing" }), expectedOfferId: "frozen-offer" },
    { item: failedItem(), expectedOfferId: "frozen-offer", batchHasSucceeded: true },
  ];
  for (const input of inputs) {
    assert.notEqual(testPolicy.classify(input).classification, "EXPLICIT_CATEGORY_FAILURE");
    assert.equal(testPolicy.classify(input).errorEvidence, null);
  }
});

test("message wording and known non-category families carry no authority", () => {
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
    const result = testPolicy.classify({ item, expectedOfferId: "frozen-offer" });
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
  const hostile = [
    null,
    [],
    accessor,
    transparentProxy,
    revocable.proxy,
    cyclic,
    failedItem({ note: "x".repeat(2_000_001) }),
    failedItem({ errors: Array.from({ length: 5_001 }, () => ({ code: "x", field: "x" })) }),
  ];
  for (const item of hostile) {
    const result = testPolicy.classify({ item, expectedOfferId: "frozen-offer" });
    assert.deepEqual(result, { classification: "UNKNOWN_RESULT", errorEvidence: null });
    assert.doesNotMatch(JSON.stringify(result), /source-evidence-secret|credential|authorization/iu);
  }
  assert.equal(getterReads, 0);
});

test("policy creation rejects unsafe or duplicate trusted rules", () => {
  assert.throws(() => createOzonCategoryImportErrorPolicy({
    policyVersion: 0, rules: [],
  }), { code: "OZON_CATEGORY_IMPORT_POLICY_INVALID" });
  assert.throws(() => createOzonCategoryImportErrorPolicy({
    policyVersion: 2, rules: [TEST_RULE, TEST_RULE],
  }), { code: "OZON_CATEGORY_IMPORT_POLICY_INVALID" });
  assert.throws(() => createOzonCategoryImportErrorPolicy({
    policyVersion: 2, rules: [{ ...TEST_RULE, code: "x".repeat(1_001) }],
  }), { code: "OZON_CATEGORY_IMPORT_POLICY_INVALID" });
});

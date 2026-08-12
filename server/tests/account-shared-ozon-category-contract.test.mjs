import assert from "node:assert/strict";
import { types } from "node:util";
import test from "node:test";
import {
  sharedCategorySelection,
  sourceCategoryEvidence,
} from "../account-shared-ozon-category-contract.mjs";

const HASH = "0123456789abcdef".repeat(4);
const CAPTURED_AT = "2026-08-12T01:02:03.000Z";

function evidence(overrides = {}) {
  const input = {
    accountId: "account-a",
    collectItemId: "collect-a",
    sourceVersion: "draft:7",
    productDraftId: "draft-a",
    productDraftVersion: 7,
    ozonProductId: 123456789,
    sourceSku: "SKU-A",
    taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 17028702,
    sourceTypeId: 94405,
    normalizedPath: ["Home", "Cups"],
    attributeSummary: [{ key: "8229", value: "Cup", dictionaryValueId: 94405 }],
    provenance: {
      accountId: "account-a",
      collectItemId: "collect-a",
      sourceKind: "PRODUCT_DRAFT",
      sourceRecordId: "draft-a",
      rawResponseRef: "raw-a",
      rawResponseHash: HASH,
      capturedAt: CAPTURED_AT,
    },
    capturedAt: CAPTURED_AT,
    rawResponseRef: "raw-a",
    rawResponseHash: HASH,
    ...overrides,
  };
  return input;
}

function selection(overrides = {}) {
  return {
    accountId: "account-a",
    sourceDescriptionCategoryId: 17028702,
    sourceTypeId: 94405,
    taxonomyScope: "OZON:DEFAULT",
    currentDescriptionCategoryId: 17028702,
    currentTypeId: 94405,
    status: "ACTIVE",
    source: "SOURCE_DIRECT",
    taxonomyFingerprint: null,
    version: 1,
    evidenceId: "evidence-a",
    validatedAt: null,
    ...overrides,
  };
}

function assertContractRejected(operation) {
  assert.throws(operation, (error) => (
    error?.code === "ACCOUNT_SHARED_OZON_CATEGORY_CONTRACT_INVALID"
      && !String(error?.message).includes("raw-a")
      && !Object.hasOwn(error, "details")
  ));
}

test("source evidence returns an exact deeply immutable plain projection", () => {
  const input = evidence();
  const result = sourceCategoryEvidence(input);

  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.normalizedPath), true);
  assert.equal(Object.isFrozen(result.attributeSummary), true);
  assert.equal(Object.isFrozen(result.attributeSummary[0]), true);
  assert.equal(Object.isFrozen(result.provenance), true);
  assert.deepEqual(Object.keys(result), [
    "accountId", "collectItemId", "sourceVersion", "productDraftId",
    "productDraftVersion", "ozonProductId", "sourceSku", "taxonomyScope",
    "sourceDescriptionCategoryId", "sourceTypeId", "normalizedPath",
    "attributeSummary", "provenance", "capturedAt", "rawResponseRef",
    "rawResponseHash",
  ]);
});

test("source evidence rejects open, executable, cyclic, proxy, and dangerous structures", () => {
  assertContractRejected(() => sourceCategoryEvidence(evidence({ storeId: "store-a" })));

  const accessor = evidence();
  Object.defineProperty(accessor, "sourceSku", { enumerable: true, get: () => "SKU-A" });
  assertContractRejected(() => sourceCategoryEvidence(accessor));

  const cyclic = evidence();
  cyclic.provenance.loop = cyclic.provenance;
  assertContractRejected(() => sourceCategoryEvidence(cyclic));

  const dangerous = evidence();
  Object.defineProperty(dangerous.provenance, "constructor", {
    enumerable: true,
    configurable: true,
    value: "attack",
  });
  assertContractRejected(() => sourceCategoryEvidence(dangerous));

  const proxy = new Proxy(evidence(), {});
  assert.equal(types.isProxy(proxy), true);
  assertContractRejected(() => sourceCategoryEvidence(proxy));

  const nestedAccessor = evidence();
  Object.defineProperty(nestedAccessor.attributeSummary, "0", {
    enumerable: true,
    configurable: true,
    get() { throw new Error("accessor executed"); },
  });
  assertContractRejected(() => sourceCategoryEvidence(nestedAccessor));

  const nestedProxy = evidence();
  nestedProxy.provenance = new Proxy(nestedProxy.provenance, {
    get() { throw new Error("proxy trap executed"); },
  });
  assertContractRejected(() => sourceCategoryEvidence(nestedProxy));

  const provenanceAccessor = evidence();
  Object.defineProperty(provenanceAccessor.provenance, "sourceKind", {
    enumerable: true,
    configurable: true,
    get() { throw new Error("provenance accessor executed"); },
  });
  assertContractRejected(() => sourceCategoryEvidence(provenanceAccessor));
});

test("source evidence requires positive IDs and canonical immutable provenance", () => {
  for (const overrides of [
    { sourceDescriptionCategoryId: 0 },
    { sourceTypeId: -1 },
    { ozonProductId: 1.5 },
    { capturedAt: "2026-08-12T01:02:03Z" },
    { capturedAt: "2026-99-99T01:02:03.000Z" },
    { rawResponseHash: HASH.toUpperCase() },
    { taxonomyScope: " OZON:DEFAULT " },
    { normalizedPath: Array.from({ length: 33 }, (_, index) => `p-${index}`) },
    { sourceSku: "x".repeat(241) },
  ]) assertContractRejected(() => sourceCategoryEvidence(evidence(overrides)));

  assertContractRejected(() => sourceCategoryEvidence(evidence({
    provenance: { ...evidence().provenance, accountId: "account-b" },
  })));
  assertContractRejected(() => sourceCategoryEvidence(evidence({
    provenance: { ...evidence().provenance, collectItemId: "collect-b" },
  })));
  assertContractRejected(() => sourceCategoryEvidence(evidence({
    provenance: { ...evidence().provenance, rawResponseHash: "f".repeat(64) },
  })));
});

test("source evidence closes the enrichment-cache variant without inventing item or draft identity", () => {
  const result = sourceCategoryEvidence(evidence({
    collectItemId: null,
    sourceVersion: HASH,
    productDraftId: null,
    productDraftVersion: null,
    ozonProductId: null,
    sourceSku: "SKU-CACHE",
    normalizedPath: [],
    attributeSummary: [],
    provenance: {
      accountId: "account-a",
      collectItemId: null,
      sourceKind: "ENRICHMENT_CACHE",
      sourceRecordId: "ozon:SKU-CACHE:collector.ozon.enrichment.v1",
      rawResponseRef: "collector_ozon_enrichment_cache:ozon:SKU-CACHE:collector.ozon.enrichment.v1",
      rawResponseHash: HASH,
      capturedAt: CAPTURED_AT,
      enrichmentSource: "ozon",
      enrichmentContractVersion: "collector.ozon.enrichment.v1",
    },
    rawResponseRef: "collector_ozon_enrichment_cache:ozon:SKU-CACHE:collector.ozon.enrichment.v1",
  }));

  assert.equal(result.collectItemId, null);
  assert.equal(result.productDraftId, null);
  assert.equal(result.productDraftVersion, null);
  assert.equal(result.ozonProductId, null);
  assert.equal(result.provenance.sourceKind, "ENRICHMENT_CACHE");
  assert.equal(Object.isFrozen(result.provenance), true);
});

test("shared selection is closed, immutable, account-shared, and preserves unvalidated source-direct state", () => {
  const result = sharedCategorySelection(selection());
  assert.deepEqual(result, selection());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.hasOwn(result, "storeId"), false);
  assert.deepEqual(Object.keys(result), [
    "accountId", "sourceDescriptionCategoryId", "sourceTypeId", "taxonomyScope",
    "currentDescriptionCategoryId", "currentTypeId", "status", "source",
    "taxonomyFingerprint", "version", "evidenceId", "validatedAt",
  ]);
});

test("shared selection accepts only closed state/source values and real taxonomy validation", () => {
  assertContractRejected(() => sharedCategorySelection(selection({ storeId: "store-a" })));
  assertContractRejected(() => sharedCategorySelection(selection({ status: "MATCHED" })));
  assertContractRejected(() => sharedCategorySelection(selection({ source: "LEGACY" })));
  assertContractRejected(() => sharedCategorySelection(selection({ version: 0 })));
  assertContractRejected(() => sharedCategorySelection(selection({ taxonomyFingerprint: HASH })));
  assertContractRejected(() => sharedCategorySelection(selection({ validatedAt: CAPTURED_AT })));
  assertContractRejected(() => sharedCategorySelection(selection({
    source: "OZON_REFRESH",
    taxonomyFingerprint: HASH,
    validatedAt: null,
  })));

  assert.deepEqual(sharedCategorySelection(selection({
    source: "OZON_REFRESH",
    taxonomyFingerprint: HASH,
    validatedAt: CAPTURED_AT,
  })).taxonomyFingerprint, HASH);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createJsonAccountSharedOzonCategoryRepository } from "../account-shared-ozon-category-repository.mjs";
import { createAccountSharedOzonCategoryService } from "../account-shared-ozon-category-service.mjs";

const NOW = "2026-08-12T04:00:00.000Z";
const HASH = crypto.createHash("sha256").update("source").digest("hex");

function sourceInput(overrides = {}) {
  return {
    accountId: "account-a",
    collectItemId: "collect-a",
    sourceVersion: "draft:1",
    productDraftId: "draft-a",
    productDraftVersion: 1,
    ozonProductId: 4862904234,
    sourceSku: "offer-a",
    taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 17028702,
    sourceTypeId: 94405,
    normalizedPath: ["家居", "杯子"],
    attributeSummary: [{ key: "8229", value: "杯子", dictionaryValueId: 94405 }],
    capturedAt: NOW,
    rawResponseRef: "raw-a",
    rawResponseHash: HASH,
    ...structuredClone(overrides),
  };
}

function harness({ lookup = null } = {}) {
  let sequence = 0;
  const state = {
    collectOzonCategorySourceEvidence: [],
    accountOzonSharedCategories: [],
    accountOzonSharedCategoryEvents: [],
  };
  const repository = createJsonAccountSharedOzonCategoryRepository({
    state,
    idFactory: () => `category-id-${++sequence}`,
  });
  const service = createAccountSharedOzonCategoryService({
    repository,
    sourceLookup: lookup,
    now: () => new Date(NOW),
  });
  return { state, repository, service };
}

test("collection source evidence is immutable, replay-idempotent, and versioned", async () => {
  const { state, service } = harness();
  const first = await service.recordCollectionSource(sourceInput());
  const replay = await service.recordCollectionSource(sourceInput());
  await service.recordCollectionSource(sourceInput({
    sourceVersion: "draft:2",
    productDraftVersion: 2,
    rawResponseHash: crypto.createHash("sha256").update("source-2").digest("hex"),
  }));

  assert.deepEqual(replay, first);
  assert.equal(state.collectOzonCategorySourceEvidence.length, 2);
  assert.equal(state.accountOzonSharedCategories.length, 1);
  assert.equal(state.accountOzonSharedCategoryEvents.length, 1);
  assert.deepEqual(state.collectOzonCategorySourceEvidence[0].provenance, {
    accountId: "account-a",
    collectItemId: "collect-a",
    sourceKind: "PRODUCT_DRAFT",
    sourceRecordId: "draft-a",
    rawResponseRef: "raw-a",
    rawResponseHash: HASH,
    capturedAt: NOW,
  });
});
test("public reads are account-shared across stores, tenant-scoped, and exactly projected", async () => {
  const { service } = harness();
  await service.recordCollectionSource(sourceInput());

  const storeA = await service.readForItems({ accountId: "account-a", collectItemIds: ["collect-a"] });
  const storeB = await service.readForItems({ accountId: "account-a", collectItemIds: ["collect-a"] });
  const foreign = await service.readForItems({ accountId: "account-b", collectItemIds: ["collect-a"] });

  assert.deepEqual(storeA, storeB);
  assert.deepEqual(foreign, []);
  assert.deepEqual(Object.keys(storeA[0]), ["collectItemId", "categoryResolution"]);
  assert.deepEqual(Object.keys(storeA[0].categoryResolution), [
    "status", "taxonomyScope", "sourceDescriptionCategoryId", "sourceTypeId",
    "currentDescriptionCategoryId", "currentTypeId", "source", "version",
    "validatedAt", "action", "message",
  ]);
  assert.deepEqual(storeA[0].categoryResolution, {
    status: "ACTIVE",
    taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 17028702,
    sourceTypeId: 94405,
    currentDescriptionCategoryId: 17028702,
    currentTypeId: 94405,
    source: "SOURCE_DIRECT",
    version: 1,
    validatedAt: null,
    action: "NONE",
    message: "使用采集类目准备上架",
  });
  assert.equal(Object.isFrozen(storeA), true);
  assert.equal(Object.isFrozen(storeA[0].categoryResolution), true);
  assert.equal(JSON.stringify(storeA).includes("raw-a"), false);
  assert.equal(JSON.stringify(storeA).includes(HASH), false);
});

test("missing IDs use one exact read lookup before review and only resolved facts are recorded", async () => {
  const calls = [];
  const resolvedHarness = harness({
    lookup: {
      async lookup(input) {
        calls.push(structuredClone(input));
        return {
          status: "RESOLVED",
          ozonProductId: 4862904234,
          sourceSku: "offer-a",
          sourceDescriptionCategoryId: 17028702,
          sourceTypeId: 94405,
          normalizedPath: ["家居", "杯子"],
          attributeSummary: [],
          rawResponseHash: HASH,
          rawResponseRef: "ozon-read:4862904234",
          capturedAt: NOW,
        };
      },
    },
  });
  const resolved = await resolvedHarness.service.resolveCollectionSource({
    ...sourceInput(),
    sourceDescriptionCategoryId: null,
    sourceTypeId: null,
    normalizedPath: [],
    attributeSummary: [],
    lookupContext: { accountId: "account-a", ozonProductId: 4862904234, sourceSku: "offer-a" },
  });
  assert.equal(resolved.categoryResolution.status, "ACTIVE");
  assert.equal(calls.length, 1);
  assert.equal(resolvedHarness.state.collectOzonCategorySourceEvidence.length, 1);

  const unresolvedHarness = harness({
    lookup: { async lookup() { return { status: "UNRESOLVED", reasonCode: "OZON_SOURCE_LOOKUP_UNRESOLVED" }; } },
  });
  const unresolved = await unresolvedHarness.service.resolveCollectionSource({
    ...sourceInput(), sourceDescriptionCategoryId: null, sourceTypeId: null,
    lookupContext: { accountId: "account-a", ozonProductId: null, sourceSku: "offer-a" },
  });
  assert.deepEqual(unresolved.categoryResolution, {
    status: "NEEDS_REVIEW",
    taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: null,
    sourceTypeId: null,
    currentDescriptionCategoryId: null,
    currentTypeId: null,
    source: null,
    version: null,
    validatedAt: null,
    action: "REVIEW",
    message: "无法确认商品类目，请人工选择",
  });
  assert.equal(unresolvedHarness.state.collectOzonCategorySourceEvidence.length, 0);
});

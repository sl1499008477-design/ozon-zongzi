import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingCategoryFreshness } from "../auto-listing-category-freshness.mjs";

const accountId = "account-a";
const source = Object.freeze({
  id: "collect-a",
  categoryEvidence: Object.freeze({
    id: "evidence-a", accountId, sourceDescriptionCategoryId: 17033252,
    sourceTypeId: 94453, taxonomyScope: "OZON:DEFAULT",
  }),
  sharedCategory: Object.freeze({
    id: "shared-a", accountId, evidenceId: "evidence-a", status: "ACTIVE",
    source: "SOURCE_DIRECT", version: 1, sourceDescriptionCategoryId: 17033252,
    sourceTypeId: 94453, currentDescriptionCategoryId: 17033252,
    currentTypeId: 94453, taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null,
  }),
});

test("refreshes one uniquely relocated exact Ozon type with versioned shared transitions", async () => {
  const calls = [];
  const fresh = createAutoListingCategoryFreshness({
    async loadStoreAccess(input) {
      calls.push(["access", input]);
      return { id: "store-a", ownerAccountId: accountId, clientId: "client-a",
        currencyCode: "CNY", apiKey: "test-key" };
    },
    categoryService: {
      async getCategorySnapshot(input) {
        calls.push(["snapshot", { accountId: input.accountId, storeId: input.store.id }]);
        return {
          items: [{ description_category_id: 17029005, disabled: false,
            children: [{ type_id: 94453, disabled: false }] }],
          taxonomyFingerprint: "a".repeat(64), stale: false,
        };
      },
      async getCategoryAttributes(input) {
        calls.push(["attributes", {
          descriptionCategoryId: input.descriptionCategoryId, typeId: input.typeId,
        }]);
        return { items: [{ id: 85, is_required: true }] };
      },
    },
    repository: {
      async invalidateSharedCategory(input) {
        calls.push(["invalidate", input]);
        return { ...source.sharedCategory, status: "INVALIDATED", version: 2,
          safeFailureCode: "OZON_CATEGORY_INVALIDATED" };
      },
      async activateRefreshedCategory(input) {
        calls.push(["activate", input]);
        return { ...source.sharedCategory, currentDescriptionCategoryId: 17029005,
          currentTypeId: 94453, source: "OZON_REFRESH", status: "ACTIVE", version: 3,
          taxonomyFingerprint: "a".repeat(64) };
      },
    },
    now: () => "2026-08-14T00:00:00.000Z",
  });

  assert.deepEqual(await fresh({ accountId, targetStoreId: "store-a", sources: [source] }), {
    status: "REFRESHED",
  });
  assert.deepEqual(calls.map(([name]) => name), [
    "access", "snapshot", "attributes", "invalidate", "activate",
  ]);
  assert.equal(calls[3][1].expectedVersion, 1);
  assert.equal(calls[4][1].expectedVersion, 2);
  assert.equal(calls[4][1].currentDescriptionCategoryId, 17029005);
  assert.equal(calls[4][1].currentTypeId, 94453);
});

test("keeps a current exact pair read-only and rejects ambiguous relocation before transitions", async () => {
  for (const [items, expected] of [
    [[{ description_category_id: 17033252, disabled: false,
      children: [{ type_id: 94453, disabled: false }] }], { status: "CURRENT" }],
    [[
      { description_category_id: 17029005, disabled: false,
        children: [{ type_id: 94453, disabled: false }] },
      { description_category_id: 17033252, disabled: false,
        children: [{ type_id: 94453, disabled: false }] },
    ], { code: "AUTO_LISTING_CATEGORY_NEEDS_REVIEW" }],
  ]) {
    let writes = 0;
    const fresh = createAutoListingCategoryFreshness({
      loadStoreAccess: async () => ({ id: "store-a", ownerAccountId: accountId,
        clientId: "client-a", currencyCode: "CNY", apiKey: "test-key" }),
      categoryService: {
        getCategorySnapshot: async () => ({ items, taxonomyFingerprint: "b".repeat(64), stale: false }),
        getCategoryAttributes: async () => ({ items: [{ id: 85 }] }),
      },
      repository: {
        invalidateSharedCategory: async () => { writes += 1; },
        activateRefreshedCategory: async () => { writes += 1; },
      },
    });
    if (expected.status) assert.deepEqual(await fresh({ accountId, targetStoreId: "store-a", sources: [source] }), expected);
    else await assert.rejects(fresh({ accountId, targetStoreId: "store-a", sources: [source] }), expected);
    assert.equal(writes, 0);
  }
});

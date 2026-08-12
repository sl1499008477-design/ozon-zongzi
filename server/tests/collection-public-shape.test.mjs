import assert from "node:assert/strict";
import test from "node:test";
import {
  publicCollectionItem,
  publicCategoryResolutionSummary,
  publicPersistedCollectionItem,
} from "../collection-public-shape.mjs";

test("public collection shape ignores forged legacyScope without trusted persisted fields", () => {
  assert.deepEqual(publicCollectionItem({
    id: "caller-item",
    storeId: "caller-store",
    dataCollectionStoreId: "caller-data",
    sellerCompanyId: "caller-seller",
    payload: {
      rows: [{
        Client_Id: "forged-client",
        current_data_collection_store_id: "forged-current",
        CURRENT_DATA_COLLECTION_STORE_IDS_BY_ACCOUNT: { forged: "value" },
        dataCollectionStoreIds: ["forged-data"],
        keep: "public",
      }],
    },
    legacyScope: {
      operatingStoreId: "forged-operating",
      dataCollectionStoreId: "forged-data",
      sellerCompanyId: "forged-seller",
      arbitrary: "forged",
    },
  }), {
    id: "caller-item",
    payload: { rows: [{ keep: "public" }] },
  });
});

test("persisted collection shape exposes only the trusted historical whitelist", () => {
  const createdAt = new Date("2026-07-29T00:00:00.000Z");
  assert.deepEqual(publicPersistedCollectionItem({
    id: "persisted-item",
    createdAt,
    storeId: "persisted-operating",
    dataCollectionStoreId: "persisted-data",
    legacyScope: {
      operatingStoreId: "forged-operating",
      dataCollectionStoreId: "forged-data",
      sellerCompanyId: "forged-seller",
      arbitrary: "forged",
    },
  }), {
    id: "persisted-item",
    createdAt,
    legacyScope: {
      operatingStoreId: "persisted-operating",
      dataCollectionStoreId: "persisted-data",
    },
  });
});

test("persisted collection shape preserves only validated listing target business metadata", () => {
  assert.deepEqual(publicPersistedCollectionItem({
    id: "listing-item",
    clientId: "forged-top-client",
    sourceMetadata: { clientId: "forged-source-client", keep: "source" },
    listingDraft: {
      targetStore: {
        id: "target-store",
        label: "Target",
        clientId: "valid-listing-client",
        currencyCode: "RUB",
      },
      categoryResolution: {
        status: "MATCHED",
        method: "MANUAL",
        target: {
          storeId: "target-store",
          descriptionCategoryId: 999,
          typeId: 1000,
        },
      },
      sourceMetadata: { clientId: "forged-draft-source", keep: "draft-source" },
    },
    raw: {
      categoryResolution: {
        status: "MATCHED",
        method: "MANUAL",
        target: { storeId: "must-stay-private", descriptionCategoryId: 1, typeId: 2 },
      },
    },
  }), {
    id: "listing-item",
    sourceMetadata: { keep: "source" },
    listingDraft: {
      targetStore: {
        id: "target-store",
        label: "Target",
        clientId: "valid-listing-client",
        currencyCode: "RUB",
      },
      categoryResolution: {
        status: "MATCHED",
        method: "MANUAL",
        target: {
          storeId: "target-store",
          descriptionCategoryId: 999,
          typeId: 1000,
        },
      },
      sourceMetadata: { keep: "draft-source" },
    },
    raw: {
      categoryResolution: {
        status: "MATCHED",
        method: "MANUAL",
        target: { descriptionCategoryId: 1, typeId: 2 },
      },
    },
  });
});

test("persisted collection shape does not expose a target store from an incomplete marker", () => {
  const publicItem = publicPersistedCollectionItem({
    id: "invalid-target-marker",
    listingDraft: {
      categoryResolution: {
        status: "MATCHED",
        method: "",
        target: { storeId: "private-store", descriptionCategoryId: 999, typeId: 1000 },
      },
    },
  });
  assert.equal(publicItem.listingDraft.categoryResolution.target.storeId, undefined);
});

test("persisted collection shape restores only complete variant target markers", () => {
  const publicItem = publicPersistedCollectionItem({
    id: "variant-target-markers",
    listingDraft: {
      variants: [
        {
          sku: "variant-valid",
          categoryResolution: {
            status: "MATCHED",
            method: "MANUAL",
            target: {
              storeId: "variant-target-store",
              descriptionCategoryId: 1999,
              typeId: 2000,
            },
          },
        },
        {
          sku: "variant-incomplete",
          categoryResolution: {
            status: "MATCHED",
            method: "",
            target: {
              storeId: "must-stay-private",
              descriptionCategoryId: 2999,
              typeId: 3000,
            },
          },
        },
      ],
    },
  });

  assert.equal(
    publicItem.listingDraft.variants[0].categoryResolution.target.storeId,
    "variant-target-store",
  );
  assert.equal(
    publicItem.listingDraft.variants[1].categoryResolution.target.storeId,
    undefined,
  );
  assert.equal(Object.isFrozen(publicItem), true);
  assert.equal(Object.isFrozen(publicItem.listingDraft), true);
  assert.equal(Object.isFrozen(publicItem.listingDraft.variants), true);
  assert.equal(Object.isFrozen(publicItem.listingDraft.variants[0]), true);
  assert.equal(Object.isFrozen(
    publicItem.listingDraft.variants[0].categoryResolution.target,
  ), true);
});

test("public collection and persisted item projections recursively freeze every DTO container", () => {
  const input = {
    id: "deep-freeze",
    payload: { rows: [{ labels: ["one", "two"] }] },
  };
  const direct = publicCollectionItem(input);
  const persisted = publicPersistedCollectionItem(input);
  for (const item of [direct, persisted]) {
    assert.deepEqual(Object.keys(item), ["id", "payload"]);
    assert.equal(Object.isFrozen(item), true);
    assert.equal(Object.isFrozen(item.payload), true);
    assert.equal(Object.isFrozen(item.payload.rows), true);
    assert.equal(Object.isFrozen(item.payload.rows[0]), true);
    assert.equal(Object.isFrozen(item.payload.rows[0].labels), true);
  }
  assert.equal(Object.isFrozen(input), false, "projection does not freeze caller-owned input");
  assert.equal(Object.isFrozen(input.payload), false);
});

test("persisted Ozon projection separates historical source aliases from explicit draft targets", () => {
  const raw = {
    description_category_id: 123,
    type_id: 456,
    listingDraft: { descriptionCategoryId: 777, typeId: 778 },
  };
  const publicItem = publicPersistedCollectionItem({
    id: "historical-ozon-projection",
    source: "ozon",
    description_category_id: 123,
    type_id: 456,
    listingDraft: {
      descriptionCategoryId: 777,
      typeId: 778,
      categoryResolution: {
        status: "MATCHED",
        method: "MANUAL",
        target: {
          storeId: "target-store",
          descriptionCategoryId: 999,
          typeId: 1000,
        },
      },
      variants: [{
        sku: "variant-a",
        description_category_id: 321,
        type_id: 654,
        categoryResolution: {
          status: "MATCHED",
          method: "MANUAL",
          target: {
            storeId: "target-store",
            descriptionCategoryId: 1999,
            typeId: 2000,
          },
        },
      }, {
        sku: "variant-unmarked",
        descriptionCategoryId: 2888,
        typeId: 2999,
      }],
    },
    raw,
  });

  assert.deepEqual(publicItem.sourceCategory, {
    descriptionCategoryId: 123,
    typeIdCandidate: 456,
  });
  assert.equal(Object.hasOwn(publicItem, "description_category_id"), false);
  assert.equal(Object.hasOwn(publicItem, "type_id"), false);
  assert.equal(publicItem.listingDraft.descriptionCategoryId, 999);
  assert.equal(publicItem.listingDraft.typeId, 1000);
  assert.equal(publicItem.listingDraft.variants[0].descriptionCategoryId, 1999);
  assert.equal(publicItem.listingDraft.variants[0].typeId, 2000);
  assert.equal(Object.hasOwn(publicItem.listingDraft.variants[0], "description_category_id"), false);
  assert.equal(Object.hasOwn(publicItem.listingDraft.variants[0], "type_id"), false);
  assert.equal(Object.hasOwn(publicItem.listingDraft.variants[1], "descriptionCategoryId"), false);
  assert.equal(Object.hasOwn(publicItem.listingDraft.variants[1], "typeId"), false);
  assert.deepEqual(publicItem.listingDraft.variants[1].sourceCategory, {
    descriptionCategoryId: 2888,
    typeIdCandidate: 2999,
  });
  assert.deepEqual(publicItem.raw, raw);
});

test("projects an account-scoped category record as a stable public summary", () => {
  const record = {
    id: "private-resolution-id",
    accountId: "private-account",
    collectItemId: "collect-public-summary",
    taxonomyScope: "OZON:DEFAULT",
    status: "ACTIVE",
    sourceDescriptionCategoryId: 17_033_604,
    sourceTypeId: 94_405,
    currentDescriptionCategoryId: 17_028_702,
    currentTypeId: 94_405,
    source: "MANUAL",
    version: 3,
    validatedAt: "2026-08-03T10:00:00.000Z",
    credentialStoreId: "credential-store-private",
    leaseToken: "lease-private",
    leaseExpiresAt: "2026-08-03T10:02:00.000Z",
    attemptCount: 9,
    failureCode: "UPSTREAM_PRIVATE",
    failureDetailSafe: "database failure detail must not be public",
    target_description_category_id: 17_028_703,
    failure_detail_safe: "database column must not be public",
  };

  const summary = publicCategoryResolutionSummary(record);
  assert.deepEqual(summary, {
    status: "ACTIVE",
    taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 17_033_604,
    sourceTypeId: 94_405,
    currentDescriptionCategoryId: 17_028_702,
    currentTypeId: 94_405,
    source: "MANUAL",
    version: 3,
    validatedAt: "2026-08-03T10:00:00.000Z",
    action: "NONE",
    message: "使用采集类目准备上架",
  });
  assert.equal(Object.isFrozen(summary), true);

  const item = publicCollectionItem({
    id: "collect-public-summary",
    sourceCategory: { descriptionCategoryId: 17_033_604, typeIdCandidate: 94_405 },
    categoryResolution: record,
    listingDraft: {
      categoryResolution: {
        status: "MATCHED",
        method: "MANUAL",
        target: { storeId: "legacy-store", descriptionCategoryId: 99, typeId: 100 },
        credentialStoreId: "legacy-credential-private",
        leaseToken: "legacy-lease-private",
        attemptCount: 5,
        failureDetailSafe: "legacy raw failure private",
        failure_detail_safe: "legacy database column private",
        source_type_id: 94_405,
        target_description_category_id: 17_028_702,
        target_type_id: 94_405,
        display_path_json: { internal: ["legacy database path private"] },
        next_attempt_at: "2026-08-03T10:02:00.000Z",
      },
    },
  }, { categoryResolution: record });

  assert.deepEqual(item.sourceCategory, {
    descriptionCategoryId: 17_033_604,
    typeIdCandidate: 94_405,
  });
  assert.equal(item.listingDraft.categoryResolution.target.storeId, "legacy-store");
  assert.deepEqual(item.categoryResolution, publicCategoryResolutionSummary(record));
  for (const forbidden of [
    "credentialStoreId",
    "leaseToken",
    "leaseExpiresAt",
    "attemptCount",
    "failureCode",
    "failureDetailSafe",
    "target_description_category_id",
    "target_type_id",
    "source_type_id",
    "display_path_json",
    "next_attempt_at",
    "failure_detail_safe",
  ]) {
    assert.equal(JSON.stringify(item).includes(forbidden), false, forbidden);
  }
});

test("projects every legacy category-resolution location through a minimal whitelist", () => {
  const forbiddenCategoryField = (value) => {
    if (Array.isArray(value)) return value.find(forbiddenCategoryField);
    if (!value || typeof value !== "object") return null;
    for (const [key, nested] of Object.entries(value)) {
      if (new Set([
        "credentialstoreid", "leasetoken", "lease", "attemptcount", "retryat",
        "failuredetailsafe", "failure", "taxonomyfingerprint", "targetdescriptioncategoryid",
        "failuredetailraw", "failureraw", "targettypeid", "sourcetypeid", "nextattemptat",
        "failurecode", "accountid", "collectitemid",
      ]).has(String(key).replace(/[_-]/g, "").toLowerCase())) return key;
      const found = forbiddenCategoryField(nested);
      if (found) return found;
    }
    return null;
  };
  const legacyResolution = {
    status: "MATCHED",
    method: "MANUAL",
    source: {
      descriptionCategoryId: 101,
      typeName: "Source type",
      typeIdCandidate: 202,
      path: ["Root", "Source type"],
      credential_store_id: "source-credential",
      raw: { lease: "source-lease" },
    },
    target: {
      storeId: "legacy-store",
      descriptionCategoryId: 303,
      typeId: 404,
      credentialStoreId: "target-credential",
      history: { retryAt: "2026-08-03T00:00:00.000Z" },
    },
    resolvedAt: "2026-08-03T00:00:00.000Z",
    history: { attemptCount: 9 },
    raw: { failure_detail_safe: "do not expose", failure_detail_raw: "do not expose" },
    taxonomyFingerprint: "private-fingerprint",
    account_id: "private-account",
    collect_item_id: "private-item",
    source_type_id: 202,
    target_description_category_id: 303,
    target_type_id: 404,
    next_attempt_at: "2026-08-03T00:00:00.000Z",
  };
  const item = publicPersistedCollectionItem({
    id: "legacy-category-whitelist",
    listingDraft: {
      categoryResolution: legacyResolution,
      variants: [{ sku: "v-1", categoryResolution: legacyResolution }],
    },
    raw: { categoryResolution: legacyResolution },
  });

  assert.deepEqual(item.listingDraft.categoryResolution, {
    status: "MATCHED",
    method: "MANUAL",
    source: {
      descriptionCategoryId: 101,
      typeName: "Source type",
      typeIdCandidate: 202,
      path: ["Root", "Source type"],
    },
    target: { storeId: "legacy-store", descriptionCategoryId: 303, typeId: 404 },
    resolvedAt: "2026-08-03T00:00:00.000Z",
  });
  assert.equal(item.listingDraft.variants[0].categoryResolution.target.storeId, "legacy-store");
  assert.equal(forbiddenCategoryField(item.listingDraft.categoryResolution), null);
  assert.equal(forbiddenCategoryField(item.listingDraft.variants[0].categoryResolution), null);
  assert.equal(forbiddenCategoryField(item.raw.categoryResolution), null);
});

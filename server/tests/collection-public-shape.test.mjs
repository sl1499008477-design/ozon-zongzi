import assert from "node:assert/strict";
import test from "node:test";
import {
  publicCollectionItem,
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

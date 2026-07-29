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

test("persisted collection shape preserves only listing target client metadata", () => {
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
      sourceMetadata: { clientId: "forged-draft-source", keep: "draft-source" },
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
      sourceMetadata: { keep: "draft-source" },
    },
  });
});

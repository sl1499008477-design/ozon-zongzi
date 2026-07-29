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
      rows: [{ Client_Id: "forged-client", keep: "public" }],
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

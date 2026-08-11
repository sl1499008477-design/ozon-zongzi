import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyLocalRuntimeData,
  localRuntimeStateFromApi,
} from "../src/local-runtime-state.js";
import { operatingStoreSettingsModel } from "../src/stores-settings-model.js";
import { buildPrepareListingBody } from "../src/collect-box-target-store.js";

const retiredFields = [
  "currentDataCollectionStoreId",
  "dataCollectionStore",
  "dataCollectionStores",
];

test("empty, hydrated, login, account-switch, and logout runtime state have no data-store fields", () => {
  const retiredApiState = {
    currentAccountId: "account-a",
    currentStoreId: "store-a",
    stores: [{ id: "store-a", ownerAccountId: "account-a" }],
    summary: { products: 2 },
    caches: { products: [{ id: "product-a" }] },
    jobs: { "job-a": { id: "job-a" } },
    currentDataCollectionStoreId: "data-store-a",
    dataCollectionStore: { id: "data-store-a" },
    dataCollectionStores: [{ id: "data-store-a" }],
  };
  const states = [
    emptyLocalRuntimeData(),
    localRuntimeStateFromApi(retiredApiState),
    localRuntimeStateFromApi(retiredApiState),
    localRuntimeStateFromApi({ ...retiredApiState, currentAccountId: "account-b" }),
    emptyLocalRuntimeData(),
  ];

  for (const state of states) {
    for (const field of retiredFields) {
      assert.equal(Object.hasOwn(state, field), false, field);
    }
  }
  assert.deepEqual(states[1].stores, retiredApiState.stores);
  assert.deepEqual(states[1].summary, retiredApiState.summary);
  assert.deepEqual(states[1].caches, retiredApiState.caches);
  assert.deepEqual(states[1].jobs, retiredApiState.jobs);
});

test("Stores settings derives only operating-store state even if an old response contains retired data", () => {
  const model = operatingStoreSettingsModel({
    localData: {
      currentStoreId: "store-a",
      stores: [
        { id: "store-a", label: "A", status: "active" },
        { id: "store-disabled", label: "Disabled", status: "disabled" },
      ],
      currentDataCollectionStoreId: "data-store-a",
      dataCollectionStores: [{ id: "data-store-a", sellerCompanyId: "seller-a" }],
      caches: { warehouses: [{ id: "warehouse-a", storeId: "store-a" }] },
      summary: { products: 1 },
    },
    binding: { id: "store-a" },
  });

  assert.deepEqual(model.stores.map((store) => store.id), ["store-a", "store-disabled"]);
  assert.equal(model.currentStoreId, "store-a");
  assert.deepEqual(model.warehouses, [{ id: "warehouse-a", storeId: "store-a" }]);
  assert.deepEqual(model.summary, { products: 1 });
  for (const field of retiredFields) {
    assert.equal(Object.hasOwn(model, field), false, field);
  }
});

test("Stores settings counts warehouses for each exact operating store instead of using the account total", () => {
  const warehouses = [
    ...Array.from({ length: 33 }, (_, index) => ({
      id: `warehouse-a-${index + 1}`,
      storeId: "store-a",
    })),
    { id: "warehouse-b-1", store_id: "store-b" },
    { id: "warehouse-without-store" },
  ];

  const model = operatingStoreSettingsModel({
    localData: {
      currentStoreId: "store-a",
      stores: [
        { id: "store-a", label: "A" },
        { id: "store-b", label: "B" },
      ],
      caches: { warehouses },
    },
    binding: { id: "store-a" },
  });

  assert.deepEqual(model.warehouseCountsByStoreId, {
    "store-a": 33,
    "store-b": 1,
  });
  assert.equal(model.currentWarehouseCount, 33);
});

test("listing form submission remains account collection plus explicit operating-store target", () => {
  assert.deepEqual(buildPrepareListingBody({
    collectItemId: "collect-account-owned",
    targetStoreId: "operating-store-a",
    requestId: "listing-request-a",
  }), {
    collectItemId: "collect-account-owned",
    targetStoreId: "operating-store-a",
    idempotencyKey: "listing-request-a",
  });
});

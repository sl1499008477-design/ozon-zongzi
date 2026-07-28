import assert from "node:assert/strict";

process.env.QH_LOCAL_NO_LISTEN = "1";

const { testExports } = await import("../index.mjs");
const {
  activeStore,
  cacheItemMatchesStore,
  cacheItemsForStore,
  canAccessLocalFile,
  currentStoreIdForAccount,
  ensureAccountState,
  localStatePayload,
  setCurrentStoreForAccount,
  storesForAccount,
  upsertProductByStore,
} = testExports;

const accountA = { id: "acct_a", username: "a", displayName: "A", role: "admin", status: "active" };
const accountB = { id: "acct_b", username: "b", displayName: "B", role: "user", status: "active" };
const state = ensureAccountState({
  accounts: [accountA, accountB],
  sessions: {},
  stores: [
    { id: "store_a", ownerAccountId: accountA.id, label: "A store", clientId: "1" },
    { id: "store_b", ownerAccountId: accountB.id, label: "B store", clientId: "2" },
  ],
  currentAccountId: accountA.id,
  currentStoreId: "store_a",
  currentStoreIdsByAccount: { [accountA.id]: "store_a", [accountB.id]: "store_b" },
  currentDataCollectionStoreIdsByAccount: {},
  dataCollectionStores: [],
  caches: {
    products: [
      { id: "product_a", storeId: "store_a" },
      { id: "product_b", storeId: "store_b" },
      { id: "product_unscoped" },
    ],
    postings: [
      { id: "posting_a", accountId: accountA.id },
      { id: "posting_b", accountId: accountB.id },
    ],
    warehouses: [
      { id: "warehouse_a", localStoreId: "store_a" },
      { id: "warehouse_b", localStoreId: "store_b" },
    ],
    favorites: [
      { id: "favorite_a", storeId: "store_a" },
      { id: "favorite_b", storeId: "store_b" },
    ],
    collectBox: [
      { id: "collect_a", accountId: accountA.id },
      { id: "collect_b", accountId: accountB.id },
    ],
    files: [
      { id: "file_a", key: "a.xlsx", createdBy: accountA.id },
      { id: "file_b", key: "b.xlsx", createdBy: accountB.id },
    ],
  },
  jobs: {
    job_a: { id: "job_a", accountId: accountA.id },
    job_b: { id: "job_b", accountId: accountB.id },
  },
  reports: [],
});

assert.deepEqual(storesForAccount(state, accountA.id).map((store) => store.id), ["store_a"]);
assert.deepEqual(storesForAccount(state, accountB.id).map((store) => store.id), ["store_b"]);
assert.equal(activeStore(state, "store_b", accountA.id), null);
assert.equal(activeStore(state, "store_b", accountB.id)?.id, "store_b");
assert.equal(currentStoreIdForAccount(state, accountB.id), "store_b");

setCurrentStoreForAccount(state, accountB.id, "store_b");
assert.equal(currentStoreIdForAccount(state, accountB.id), "store_b");
assert.equal(state.currentStoreId, "store_a", "switching another account must not mutate the active account context");

const payloadB = localStatePayload(state, { account: accountB, token: "token-b", authenticated: true });
assert.deepEqual(payloadB.stores.map((store) => store.id), ["store_b"]);
assert.equal(payloadB.binding.id, "store_b");
assert.deepEqual(payloadB.caches.collectBox.map((item) => item.id), ["collect_b"]);
assert.deepEqual(payloadB.caches.files.map((file) => file.id), ["file_b"]);
assert.deepEqual(payloadB.caches.products.map((item) => item.id), ["product_b"]);
assert.deepEqual(payloadB.caches.postings.map((item) => item.id), ["posting_b"]);
assert.deepEqual(payloadB.caches.warehouses.map((item) => item.id), ["warehouse_b"]);
assert.deepEqual(payloadB.caches.favorites.map((item) => item.id), ["favorite_b"]);
assert.equal(payloadB.summary.products, 1);
assert.equal(payloadB.summary.postings, 1);
assert.deepEqual(Object.keys(payloadB.jobs), ["job_b"]);

assert.equal(canAccessLocalFile(state.caches.files[0], accountB), false);
assert.equal(canAccessLocalFile(state.caches.files[1], accountB), true);

const duplicateProductIdCache = [];
const firstStore = { id: "same_account_store_1", clientId: "101", label: "First", ownerAccountId: accountA.id };
const secondStore = { id: "same_account_store_2", clientId: "102", label: "Second", ownerAccountId: accountA.id };
upsertProductByStore(duplicateProductIdCache, firstStore, "shared_product", {
  id: "shared_product",
  storeId: firstStore.id,
  clientId: firstStore.clientId,
  title: "first product",
});
upsertProductByStore(duplicateProductIdCache, secondStore, "shared_product", {
  id: "shared_product",
  storeId: secondStore.id,
  clientId: secondStore.clientId,
  title: "second product",
});
assert.equal(duplicateProductIdCache.length, 2, "the same Ozon product id must remain isolated per store");
assert.equal(cacheItemsForStore(duplicateProductIdCache, firstStore)[0]?.title, "first product");
assert.equal(cacheItemsForStore(duplicateProductIdCache, secondStore)[0]?.title, "second product");
assert.equal(cacheItemMatchesStore(duplicateProductIdCache[0], secondStore), false);

console.log("account store isolation smoke passed");

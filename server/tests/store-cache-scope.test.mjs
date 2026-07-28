import assert from "node:assert/strict";
import {
  cacheItemMatchesStore,
  cacheItemsForStore,
  cacheItemScope,
  upsertCacheItemByStore,
  upsertProductByStore,
} from "../store-cache-scope.mjs";

const storeA = { id: "store_a", clientId: "client_a", ownerAccountId: "acct_a" };
const storeB = { id: "store_b", clientId: "client_b", ownerAccountId: "acct_b" };

assert.equal(cacheItemMatchesStore({ id: "p", storeId: "store_a" }, storeA), true);
assert.equal(cacheItemMatchesStore({ id: "p", storeId: "store_a" }, storeB), false);
assert.equal(cacheItemMatchesStore({ id: "p", clientId: "client_a" }, storeA), true);
assert.equal(
  cacheItemMatchesStore(
    { id: "p", storeName: "  SELLER STORE  " },
    { id: "legacy_store", label: "Seller Store" },
  ),
  true,
);
assert.equal(
  cacheItemMatchesStore(
    {
      id: "p",
      storeId: "store_b",
      clientId: "client_a",
      storeName: "Seller Store",
    },
    { ...storeA, label: "Seller Store" },
  ),
  false,
);
assert.deepEqual(cacheItemScope(storeA, "acct_a"), {
  accountId: "acct_a",
  storeId: "store_a",
  storeName: "",
  clientId: "client_a",
});

const products = [];
assert.equal(upsertProductByStore(products, storeA, "same", {
  id: "same",
  title: "A",
  ...cacheItemScope(storeA, "acct_a"),
}), true);
assert.equal(upsertProductByStore(products, storeB, "same", {
  id: "same",
  title: "B",
  ...cacheItemScope(storeB, "acct_b"),
}), true);
assert.equal(upsertProductByStore(products, storeA, "same", {
  id: "same",
  title: "A updated",
  ...cacheItemScope(storeA, "acct_a"),
}), false);
assert.equal(products.length, 2);
assert.equal(cacheItemsForStore(products, storeA)[0].title, "A updated");

const postings = [];
assert.equal(upsertCacheItemByStore(postings, storeA, "posting", {
  posting_number: "posting",
  ...cacheItemScope(storeA, "acct_a"),
}, ["posting_number"]), true);
assert.equal(upsertCacheItemByStore(postings, storeA, "posting", {
  posting_number: "posting",
  status: "updated",
  ...cacheItemScope(storeA, "acct_a"),
}, ["posting_number"]), false);
assert.equal(postings.length, 1);
assert.equal(postings[0].status, "updated");

console.log("store cache scope tests passed");

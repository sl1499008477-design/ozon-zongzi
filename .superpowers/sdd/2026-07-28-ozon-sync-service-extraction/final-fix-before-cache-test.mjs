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
assert.deepEqual(cacheItemScope(storeA, "acct_a"), {
  accountId: "acct_a",
  storeId: "store_a",
  storeName: "",
  clientId: "client_a",
});

const products = [];
upsertProductByStore(products, storeA, "same", {
  id: "same",
  title: "A",
  ...cacheItemScope(storeA, "acct_a"),
});
upsertProductByStore(products, storeB, "same", {
  id: "same",
  title: "B",
  ...cacheItemScope(storeB, "acct_b"),
});
assert.equal(products.length, 2);
assert.equal(cacheItemsForStore(products, storeA)[0].title, "A");

const postings = [];
upsertCacheItemByStore(postings, storeA, "posting", {
  posting_number: "posting",
  ...cacheItemScope(storeA, "acct_a"),
}, ["posting_number"]);
upsertCacheItemByStore(postings, storeA, "posting", {
  posting_number: "posting",
  status: "updated",
  ...cacheItemScope(storeA, "acct_a"),
}, ["posting_number"]);
assert.equal(postings.length, 1);
assert.equal(postings[0].status, "updated");

console.log("store cache scope tests passed");

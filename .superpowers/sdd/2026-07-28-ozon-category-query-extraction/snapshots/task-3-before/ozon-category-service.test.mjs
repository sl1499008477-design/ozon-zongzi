import assert from "node:assert/strict";
import { createOzonCategoryService } from "../ozon-category-service.mjs";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let nowMs = Date.parse("2026-07-28T00:00:00.000Z");
const calls = [];
const callOzonSellerApi = async (store, apiPath, body) => {
  calls.push({ storeId: store.id, apiPath, body });
  if (apiPath.endsWith("/tree")) {
    return {
      result: [{
        description_category_id: 10,
        category_name: "Home",
        children: [{ type_id: 20, type_name: "Cup", children: [] }],
      }],
    };
  }
  return { result: [{ id: 30, name: "Brand", dictionary_id: 40, is_required: true }] };
};

function input({ accountId = "acct-a", storeId = "store-a", language = "ZH_HANS" } = {}) {
  const store = { id: storeId, ownerAccountId: accountId };
  Object.defineProperty(store, "apiKey", {
    enumerable: true,
    get() {
      assert.fail("category cache must not read an API key");
    },
  });
  return { accountId, store, language };
}

const service = createOzonCategoryService({
  callOzonSellerApi,
  now: () => nowMs,
  cacheTtlMs: CACHE_TTL_MS,
});

const treeInput = input();
const firstTree = await service.getCategoryTree(treeInput);
assert.equal(firstTree.meta.source, "OZON_API");
assert.equal(firstTree.items[0].description_category_id, 10);
assert.deepEqual(firstTree.meta, {
  source: "OZON_API",
  fetchedAt: "2026-07-28T00:00:00.000Z",
  expiresAt: "2026-07-28T06:00:00.000Z",
});

const cachedTree = await service.getCategoryTree(treeInput);
assert.equal(cachedTree.meta.source, "OZON_CACHE");
assert.equal(calls.length, 1);

const attributesInput = { ...input(), descriptionCategoryId: 10, typeId: 20 };
const firstAttributes = await service.getCategoryAttributes(attributesInput);
assert.equal(firstAttributes.meta.source, "OZON_API");
assert.deepEqual(firstAttributes.items, [{ id: 30, name: "Brand", dictionary_id: 40, is_required: true }]);
const cachedAttributes = await service.getCategoryAttributes(attributesInput);
assert.equal(cachedAttributes.meta.source, "OZON_CACHE");
assert.equal(calls.length, 2);

await service.getCategoryTree(input({ language: "DEFAULT" }));
await service.getCategoryTree(input({ accountId: "acct-b", storeId: "store-a" }));
await service.getCategoryTree(input({ accountId: "acct-b", storeId: "store-b" }));
assert.equal(calls.length, 5);

const descriptionCategoryId = await service.resolveDescriptionCategoryId({ ...input(), typeId: 20 });
assert.equal(descriptionCategoryId, 10);
assert.equal(calls.length, 5);

nowMs += CACHE_TTL_MS;
const expiredTree = await service.getCategoryTree(treeInput);
assert.equal(expiredTree.meta.source, "OZON_API");
assert.equal(calls.length, 6);

await assert.rejects(
  () => service.getCategoryTree({ accountId: "acct-a", store: { id: "store-a", ownerAccountId: "acct-b" } }),
  (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.code, "OZON_CATEGORY_STORE_FORBIDDEN");
    assert.deepEqual(error.body, { operation: "SCOPE" });
    assert.equal(error.cause, null);
    return true;
  },
);

const sensitiveValue = "secret-upstream-response";
const unavailable = createOzonCategoryService({
  callOzonSellerApi: async () => {
    throw Object.assign(new Error(sensitiveValue), { status: 429 });
  },
});
await assert.rejects(
  () => unavailable.getCategoryTree(input()),
  (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "OZON_CATEGORY_TREE_UNAVAILABLE");
    assert.equal(error.message, "未能从 Ozon 获取真实类目数据，请重试");
    assert.deepEqual(error.body, { operation: "TREE" });
    assert.equal(error.cause, null);
    assert.equal(JSON.stringify(error).includes(sensitiveValue), false);
    return true;
  },
);

const invalid = createOzonCategoryService({ callOzonSellerApi: async () => ({ result: [] }) });
await assert.rejects(
  () => invalid.getCategoryTree(input()),
  (error) => error.status === 502 &&
    error.code === "OZON_CATEGORY_DATA_INVALID" &&
    error.cause === null &&
    JSON.stringify(error.body) === JSON.stringify({ operation: "TREE" }),
);

let ttlNowMs = Date.parse("2026-07-28T00:00:00.000Z");
const nonPositiveTtlService = createOzonCategoryService({
  callOzonSellerApi: async () => ({ result: [{ description_category_id: 49, children: [] }] }),
  now: () => ttlNowMs,
  cacheTtlMs: 0,
});
const nonPositiveTtlTree = await nonPositiveTtlService.getCategoryTree(input({ storeId: "non-positive-ttl-store" }));
assert.equal(
  Date.parse(nonPositiveTtlTree.meta.expiresAt) - Date.parse(nonPositiveTtlTree.meta.fetchedAt),
  CACHE_TTL_MS,
);

const longTtlService = createOzonCategoryService({
  callOzonSellerApi: async () => ({ result: [{ description_category_id: 50, children: [] }] }),
  now: () => ttlNowMs,
  cacheTtlMs: 12 * 60 * 60 * 1000,
});
const longTtlTree = await longTtlService.getCategoryTree(input({ storeId: "ttl-store" }));
assert.equal(
  Date.parse(longTtlTree.meta.expiresAt) - Date.parse(longTtlTree.meta.fetchedAt),
  CACHE_TTL_MS,
);

let collisionApiCalls = 0;
const collisionService = createOzonCategoryService({
  callOzonSellerApi: async () => ({
    result: [{ description_category_id: ++collisionApiCalls, children: [] }],
  }),
});
const firstCollision = await collisionService.getCategoryTree(input({ accountId: "a:b", storeId: "c" }));
const secondCollision = await collisionService.getCategoryTree(input({ accountId: "a", storeId: "b:c" }));
assert.equal(firstCollision.items[0].description_category_id, 1);
assert.equal(secondCollision.meta.source, "OZON_API");
assert.equal(secondCollision.items[0].description_category_id, 2);
assert.equal(collisionApiCalls, 2);

let staleNowMs = Date.parse("2026-07-28T00:00:00.000Z");
let staleRefreshFails = false;
const staleService = createOzonCategoryService({
  now: () => staleNowMs,
  callOzonSellerApi: async () => {
    if (staleRefreshFails) throw Object.assign(new Error("stale-upstream-secret"), { code: "OZON_TIMEOUT" });
    return { result: [{ description_category_id: 60, children: [] }] };
  },
});
const staleInput = input({ storeId: "stale-store" });
await staleService.getCategoryTree(staleInput);
assert.equal((await staleService.getCategoryTree(staleInput)).meta.source, "OZON_CACHE");
staleNowMs += CACHE_TTL_MS;
staleRefreshFails = true;
await assert.rejects(
  () => staleService.getCategoryTree(staleInput),
  (error) => {
    assert.equal(error.status, 504);
    assert.equal(error.code, "OZON_CATEGORY_TREE_UNAVAILABLE");
    assert.equal(error.message, "未能从 Ozon 获取真实类目数据，请重试");
    assert.deepEqual(error.body, { operation: "TREE" });
    assert.equal(error.cause, null);
    assert.equal("items" in error, false);
    return true;
  },
);

const upstreamTree = [{
  description_category_id: 70,
  children: [{ type_id: 71, type_name: "Cup", children: [] }],
}];
const cloneService = createOzonCategoryService({
  callOzonSellerApi: async () => ({ result: upstreamTree }),
});
const cloneInput = input({ storeId: "clone-store" });
const apiTree = await cloneService.getCategoryTree(cloneInput);
apiTree.items[0].children[0].type_name = "mutated API result";
upstreamTree[0].children[0].type_name = "mutated upstream result";
const cloneCachedTree = await cloneService.getCategoryTree(cloneInput);
assert.equal(cloneCachedTree.items[0].children[0].type_name, "Cup");
cloneCachedTree.items[0].children[0].type_name = "mutated cache result";
const cloneCachedTreeAgain = await cloneService.getCategoryTree(cloneInput);
assert.equal(cloneCachedTreeAgain.items[0].children[0].type_name, "Cup");

console.log("ozon category service tests passed");

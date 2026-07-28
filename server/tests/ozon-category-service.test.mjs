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

const valuesInput = {
  ...input({ storeId: "values-store" }),
  descriptionCategoryId: 10,
  typeId: 20,
  attributeId: 30,
  limit: 5000,
};
const valuePages = [
  {
    result: {
      values: [{ id: 1, value: "One" }, { dictionary_value_id: 2, name: "Two" }],
      has_next: true,
    },
  },
  {
    result: [{ id: 3, value: "Three" }],
    has_next: false,
  },
];
const valueCalls = [];
const paginatedValuesService = createOzonCategoryService({
  callOzonSellerApi: async (_store, apiPath, body) => {
    valueCalls.push({ apiPath, body });
    return valuePages.shift();
  },
});
const paginatedValues = await paginatedValuesService.getCategoryAttributeValues(valuesInput);
assert.deepEqual(paginatedValues.items.map((item) => item.id), [1, 2, 3]);
assert.equal(valueCalls[0].apiPath, "/v1/description-category/attribute/values");
assert.equal(valueCalls[0].body.limit, 1000);
assert.equal(valueCalls[1].body.last_value_id, 2);
assert.equal(paginatedValues.meta.source, "OZON_API");

const duplicateValuesService = createOzonCategoryService({
  callOzonSellerApi: async () => ({
    result: [
      { id: 1, value: "One" },
      { id: 1, value: "One" },
      { dictionary_value_id: 2, name: "Two" },
    ],
  }),
});
const duplicateValues = await duplicateValuesService.getCategoryAttributeValues(valuesInput);
assert.deepEqual(duplicateValues.items, [
  { id: 1, value: "One", info: "", picture: "" },
  { id: 2, value: "Two", info: "", picture: "" },
]);

const limitCalls = [];
const limitService = createOzonCategoryService({
  callOzonSellerApi: async (_store, _apiPath, body) => {
    limitCalls.push(body);
    return { result: [] };
  },
});
await limitService.getCategoryAttributeValues({ ...valuesInput, limit: 0 });
await limitService.getCategoryAttributeValues({ ...valuesInput, limit: 6000 });
assert.equal(limitCalls[0].limit, 1);
assert.equal(limitCalls[1].limit, 1000);

const partialFailureCalls = [];
let partialFailureAttempt = 0;
const partialFailureService = createOzonCategoryService({
  callOzonSellerApi: async (_store, _apiPath, body) => {
    partialFailureCalls.push(body);
    partialFailureAttempt += 1;
    if (partialFailureAttempt === 2) throw new Error("upstream failure after first page");
    if (partialFailureAttempt === 1 || partialFailureAttempt === 3) {
      return { result: [{ id: 1, value: "One" }], has_next: true };
    }
    return { result: [{ id: 2, value: "Two" }], has_next: false };
  },
});
await assert.rejects(
  () => partialFailureService.getCategoryAttributeValues(valuesInput),
  (error) => error.code === "OZON_CATEGORY_VALUES_UNAVAILABLE" && error.cause === null,
);
const recoveredValues = await partialFailureService.getCategoryAttributeValues(valuesInput);
assert.deepEqual(recoveredValues.items.map((item) => item.id), [1, 2]);
assert.equal("last_value_id" in partialFailureCalls[2], false);

const repeatedCursorService = createOzonCategoryService({
  callOzonSellerApi: async () => ({
    result: [{ id: 1, value: "One" }],
    has_next: true,
  }),
});
await assert.rejects(
  () => repeatedCursorService.getCategoryAttributeValues(valuesInput),
  (error) => {
    assert.equal(error.code, "OZON_CATEGORY_DATA_INVALID");
    assert.equal(error.cause, null);
    return true;
  },
);

let valuesNowMs = Date.parse("2026-07-28T00:00:00.000Z");
let valuesRefreshFails = false;
const expiredValuesService = createOzonCategoryService({
  now: () => valuesNowMs,
  callOzonSellerApi: async () => {
    if (valuesRefreshFails) throw new Error("stale-values-secret");
    return { result: [{ id: 1, value: "One" }] };
  },
});
const expiredValuesInput = { ...valuesInput, store: input({ storeId: "expired-values-store" }).store };
await expiredValuesService.getCategoryAttributeValues(expiredValuesInput);
valuesNowMs += CACHE_TTL_MS;
valuesRefreshFails = true;
await assert.rejects(
  () => expiredValuesService.getCategoryAttributeValues(expiredValuesInput),
  (error) => error.code === "OZON_CATEGORY_VALUES_UNAVAILABLE" && error.cause === null && !("items" in error),
);

let invalidValuesCalls = 0;
const invalidValuesService = createOzonCategoryService({
  callOzonSellerApi: async () => {
    invalidValuesCalls += 1;
    return invalidValuesCalls === 1 ? { result: {} } : { result: [{ id: 1, value: "One" }] };
  },
});
await assert.rejects(
  () => invalidValuesService.getCategoryAttributeValues(valuesInput),
  (error) => {
    assert.equal(error.code, "OZON_CATEGORY_DATA_INVALID");
    assert.equal(error.cause, null);
    return true;
  },
);
const validAfterInvalid = await invalidValuesService.getCategoryAttributeValues(valuesInput);
assert.equal(validAfterInvalid.meta.source, "OZON_API");
assert.equal(invalidValuesCalls, 2);

const invalidBoundaryCursorCalls = [];
const invalidBoundaryCursorService = createOzonCategoryService({
  callOzonSellerApi: async (_store, _apiPath, body) => {
    invalidBoundaryCursorCalls.push(body);
    return invalidBoundaryCursorCalls.length === 1
      ? { result: [{ id: 0, value: "invalid-cursor" }], has_next: true }
      : { result: [{ id: 2, value: "recovered" }], has_next: false };
  },
});
const invalidBoundaryCursorInput = { ...valuesInput, limit: 1 };
await assert.rejects(
  () => invalidBoundaryCursorService.getCategoryAttributeValues(invalidBoundaryCursorInput),
  (error) => error.code === "OZON_CATEGORY_DATA_INVALID" && error.cause === null,
);
const recoveredAfterInvalidBoundaryCursor = await invalidBoundaryCursorService.getCategoryAttributeValues(invalidBoundaryCursorInput);
assert.equal(recoveredAfterInvalidBoundaryCursor.meta.source, "OZON_API");
assert.equal("last_value_id" in invalidBoundaryCursorCalls[1], false);

const duplicateBoundaryCursorCalls = [];
const duplicateBoundaryCursorService = createOzonCategoryService({
  callOzonSellerApi: async (_store, _apiPath, body) => {
    duplicateBoundaryCursorCalls.push(body);
    if (duplicateBoundaryCursorCalls.length === 1) {
      return { result: [{ id: 1, value: "One" }], has_next: true };
    }
    if (duplicateBoundaryCursorCalls.length === 2) {
      return {
        result: [{ id: 2, value: "Two" }, { id: 1, value: "One" }],
        has_next: true,
      };
    }
    return { result: [{ id: 3, value: "recovered" }], has_next: false };
  },
});
const duplicateBoundaryCursorInput = { ...valuesInput, limit: 2 };
await assert.rejects(
  () => duplicateBoundaryCursorService.getCategoryAttributeValues(duplicateBoundaryCursorInput),
  (error) => error.code === "OZON_CATEGORY_DATA_INVALID" && error.cause === null,
);
const recoveredAfterDuplicateBoundaryCursor = await duplicateBoundaryCursorService.getCategoryAttributeValues(duplicateBoundaryCursorInput);
assert.equal(recoveredAfterDuplicateBoundaryCursor.meta.source, "OZON_API");
assert.equal("last_value_id" in duplicateBoundaryCursorCalls[2], false);

let invalidIdApiCalls = 0;
const invalidIdService = createOzonCategoryService({
  callOzonSellerApi: async () => {
    invalidIdApiCalls += 1;
    return { result: [] };
  },
});
const invalidIdCases = [
  () => invalidIdService.getCategoryAttributes({
    ...input({ storeId: "invalid-id-store" }),
    descriptionCategoryId: 0,
    typeId: 20,
  }),
  () => invalidIdService.getCategoryAttributes({
    ...input({ storeId: "invalid-id-store" }),
    descriptionCategoryId: 10,
    typeId: "not-an-id",
  }),
  () => invalidIdService.getCategoryAttributeValues({
    ...input({ storeId: "invalid-id-store" }),
    descriptionCategoryId: 10,
    typeId: 20,
    attributeId: -1,
  }),
  () => invalidIdService.resolveDescriptionCategoryId({
    ...input({ storeId: "invalid-id-store" }),
    typeId: 1.5,
  }),
];
for (const invoke of invalidIdCases) {
  await assert.rejects(
    invoke,
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "OZON_CATEGORY_DATA_INVALID");
      assert.equal(error.message, "未能从 Ozon 获取真实类目数据，请重试");
      assert.equal(error.cause, null);
      assert.deepEqual(error.body, { operation: "INPUT" });
      return true;
    },
  );
}
assert.equal(invalidIdApiCalls, 0);

let missingTypeApiCalls = 0;
const missingTypeService = createOzonCategoryService({
  callOzonSellerApi: async () => {
    missingTypeApiCalls += 1;
    return {
      result: [{
        description_category_id: 10,
        children: [{ type_id: 20, children: [] }],
      }],
    };
  },
});
await assert.rejects(
  () => missingTypeService.resolveDescriptionCategoryId({
    ...input({ storeId: "missing-type-store" }),
    typeId: 999,
  }),
  (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "OZON_CATEGORY_TYPE_NOT_FOUND");
    assert.equal(error.message, "未能从 Ozon 获取真实类目数据，请重试");
    assert.equal(error.cause, null);
    assert.deepEqual(error.body, { operation: "TYPE" });
    return true;
  },
);
assert.equal(missingTypeApiCalls, 1);

const malformedAttributesService = createOzonCategoryService({
  callOzonSellerApi: async () => ({ result: {} }),
});
await assert.rejects(
  () => malformedAttributesService.getCategoryAttributes({
    ...input({ storeId: "malformed-attributes-store" }),
    descriptionCategoryId: 10,
    typeId: 20,
  }),
  (error) => (
    error.status === 502
    && error.code === "OZON_CATEGORY_DATA_INVALID"
    && error.cause === null
  ),
);

console.log("ozon category service tests passed");

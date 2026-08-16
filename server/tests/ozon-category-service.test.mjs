import assert from "node:assert/strict";
import test from "node:test";
import { buildOzonCategoryRebuildMetadata, createOzonCategoryService } from "../ozon-category-service.mjs";

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

test("treats the Ozon attribute sentinel dictionary_id=0 as no dictionary", () => {
  assert.deepEqual(buildOzonCategoryRebuildMetadata({
    descriptionCategoryId: 17029005,
    typeId: 94453,
    attributes: [{ id: 9048, attribute_complex_id: 0, is_required: true, dictionary_id: 0 }],
  }), {
    descriptionCategoryId: 17029005,
    typeId: 94453,
    attributes: [{
      id: 9048, complexId: 0, required: true, dictionaryId: null, dictionaryValues: [],
    }],
  });
});

test("category reads forward an external abort signal to the Ozon transport", async () => {
  const controller = new AbortController();
  let options;
  const abortable = createOzonCategoryService({
    callOzonSellerApi: async (_store, _path, _body, _timeout, receivedOptions) => {
      options = receivedOptions;
      return { result: [] };
    },
  });
  await abortable.getCategoryAttributes({
    accountId: "acct-a", store: { id: "store-a", ownerAccountId: "acct-a" },
    descriptionCategoryId: 10, typeId: 20, signal: controller.signal,
  });
  assert.equal(options.signal, controller.signal);
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
    assert.deepEqual(error.diagnostic, {
      operation: "TREE",
      sourceCode: "UPSTREAM_ERROR",
      sourceStatus: 429,
      retryable: true,
    });
    assert.equal(JSON.stringify(error).includes(sensitiveValue), false);
    assert.equal(JSON.stringify(error).includes("diagnostic"), false);
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

const exactValuePages = [
  { result: [{ id: 10, value: "Earlier" }], has_next: true },
  { result: [{ id: 20, value: "MQOUO" }], has_next: true },
  { result: [{ id: 30, value: "Later" }], has_next: false },
];
const exactValueCalls = [];
const exactValueService = createOzonCategoryService({
  callOzonSellerApi: async (_store, apiPath, body) => {
    exactValueCalls.push({ apiPath, body });
    return exactValuePages.shift();
  },
});
const exactValues = await exactValueService.getCategoryAttributeValues({
  ...valuesInput,
  matchCandidates: [{ value: "  mqouo  " }],
});
assert.deepEqual(exactValues.items, [{ id: 20, value: "MQOUO", info: "", picture: "" }]);
assert.equal(exactValueCalls.length, 3, "text matches scan to the terminal page to reject ambiguity");
assert.equal(exactValueCalls[1].body.last_value_id, 10);
assert.equal(exactValueCalls[2].body.last_value_id, 20);

const ambiguousTextPages = [
  { result: [{ id: 40, value: "Same" }], has_next: true },
  { result: [{ id: 41, value: " same " }], has_next: false },
];
const ambiguousTextService = createOzonCategoryService({
  callOzonSellerApi: async () => ambiguousTextPages.shift(),
});
assert.deepEqual((await ambiguousTextService.getCategoryAttributeValues({
  ...valuesInput,
  store: { id: "ambiguous-store", ownerAccountId: "acct-a" },
  matchCandidates: [{ value: "same" }],
})).items.map(({ id }) => id), [40, 41]);

const exactIdService = createOzonCategoryService({
  callOzonSellerApi: async () => ({ result: [{ id: 50, value: "same" }], has_next: false }),
});
assert.deepEqual((await exactIdService.getCategoryAttributeValues({
  ...valuesInput,
  store: { id: "exact-id-store", ownerAccountId: "acct-a" },
  matchCandidates: [{ id: 999, value: "same" }],
})).items, [], "an exact source ID must never fall back to matching display text");

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

test("category snapshot fingerprints taxonomy structure instead of translated labels", async () => {
  const snapshotService = createOzonCategoryService({
    callOzonSellerApi: async (_store, apiPath, body) => {
      assert.equal(apiPath, "/v1/description-category/tree");
      return {
        result: [{
          description_category_id: 17028702,
          category_name: body.language === "RU" ? "Дом" : "家居",
          children: [{
            type_id: 94405,
            type_name: body.language === "RU" ? "Кружки" : "杯子",
            children: [],
          }],
        }],
      };
    },
  });
  const store = input({ storeId: "snapshot-language-store" }).store;

  const zh = await snapshotService.getCategorySnapshot(store, "ZH_HANS");
  const ru = await snapshotService.getCategorySnapshot(store, "RU");

  assert.equal(zh.taxonomyScope, "OZON:DEFAULT");
  assert.equal(zh.taxonomyFingerprint, ru.taxonomyFingerprint);
  assert.equal(zh.taxonomyFingerprint, "58218ce9e56381a387e00b9abc7f0c714a034d0eb57859ebbd3ae9ad95b8d371");
  assert.equal(zh.stale, false);
  assert.equal(ru.stale, false);
});

test("category snapshot keeps the last non-empty tree when a refresh is empty", async () => {
  let snapshotNowMs = Date.parse("2026-07-28T00:00:00.000Z");
  let replyWithEmptyTree = false;
  const snapshotService = createOzonCategoryService({
    now: () => snapshotNowMs,
    callOzonSellerApi: async () => ({
      result: replyWithEmptyTree
        ? []
        : [{ description_category_id: 17028702, children: [{ type_id: 94405, children: [] }] }],
    }),
  });
  const store = input({ storeId: "snapshot-stale-store" }).store;
  const first = await snapshotService.getCategorySnapshot(store, "ZH_HANS");

  snapshotNowMs += CACHE_TTL_MS;
  replyWithEmptyTree = true;
  const stale = await snapshotService.getCategorySnapshot(store, "ZH_HANS");

  assert.equal(stale.stale, true);
  assert.deepEqual(stale.items, first.items);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.equal(stale.taxonomyFingerprint, first.taxonomyFingerprint);
  assert.equal(stale.staleReasonCode, "OZON_CATEGORY_DATA_INVALID");
});

test("category snapshot keeps the last non-empty tree when the refresh is unavailable", async () => {
  let snapshotNowMs = Date.parse("2026-07-28T00:00:00.000Z");
  let refreshUnavailable = false;
  const snapshotService = createOzonCategoryService({
    now: () => snapshotNowMs,
    callOzonSellerApi: async () => {
      if (refreshUnavailable) throw Object.assign(new Error("upstream secret"), { code: "OZON_TIMEOUT" });
      return { result: [{ description_category_id: 17028702, children: [{ type_id: 94405, children: [] }] }] };
    },
  });
  const store = input({ storeId: "snapshot-unavailable-store" }).store;
  const first = await snapshotService.getCategorySnapshot(store, "ZH_HANS");

  snapshotNowMs += CACHE_TTL_MS;
  refreshUnavailable = true;
  const stale = await snapshotService.getCategorySnapshot(store, "ZH_HANS");

  assert.equal(stale.stale, true);
  assert.deepEqual(stale.items, first.items);
  assert.equal(stale.taxonomyFingerprint, first.taxonomyFingerprint);
  assert.equal(stale.staleReasonCode, "OZON_CATEGORY_TREE_UNAVAILABLE");
});

test("credential rotation invalidates only the matching account-store category cache", async () => {
  let invalidationNowMs = Date.parse("2026-07-28T00:00:00.000Z");
  const treeCalls = [];
  const invalidationService = createOzonCategoryService({
    now: () => invalidationNowMs,
    callOzonSellerApi: async (store, apiPath) => {
      assert.match(apiPath, /\/tree$/);
      treeCalls.push(store.id);
      return {
        result: [{
          description_category_id: treeCalls.length,
          children: [{ type_id: 94_405, children: [] }],
        }],
      };
    },
  });
  const accountAStoreA = input({ accountId: "invalidate-a", storeId: "store-a" });
  const accountAStoreB = input({ accountId: "invalidate-a", storeId: "store-b" });
  const accountBStoreA = input({ accountId: "invalidate-b", storeId: "store-a" });

  const before = await invalidationService.getCategorySnapshot(accountAStoreA);
  await invalidationService.getCategorySnapshot(accountAStoreB);
  await invalidationService.getCategorySnapshot(accountBStoreA);
  assert.equal(treeCalls.length, 3);

  const removed = invalidationService.invalidateStore({
    accountId: "invalidate-a",
    storeId: "store-a",
  });
  assert.equal(removed > 0, true);

  const after = await invalidationService.getCategorySnapshot(accountAStoreA);
  await invalidationService.getCategorySnapshot(accountAStoreB);
  await invalidationService.getCategorySnapshot(accountBStoreA);
  assert.equal(treeCalls.length, 4);
  assert.notEqual(after.taxonomyFingerprint, before.taxonomyFingerprint);
  invalidationNowMs += 1;
});

test("credential rotation fences a late old-credential response from repopulating category caches", async () => {
  let treeCalls = 0;
  let resolveOldRequest;
  let markOldRequestStarted;
  const oldRequestStarted = new Promise((resolve) => {
    markOldRequestStarted = resolve;
  });
  const raceService = createOzonCategoryService({
    callOzonSellerApi: async (_store, apiPath) => {
      assert.match(apiPath, /\/tree$/);
      treeCalls += 1;
      if (treeCalls === 1) {
        markOldRequestStarted();
        return new Promise((resolve) => {
          resolveOldRequest = resolve;
        });
      }
      return {
        result: [{
          description_category_id: 17_028_702,
          children: [{ type_id: 94_405, children: [] }],
        }],
      };
    },
  });
  const scopedStore = input({ accountId: "race-account", storeId: "race-store" });

  const oldSnapshotPromise = raceService.getCategorySnapshot(scopedStore);
  await oldRequestStarted;
  raceService.invalidateStore({ accountId: "race-account", storeId: "race-store" });
  resolveOldRequest({
    result: [{
      description_category_id: 17_033_604,
      children: [{ type_id: 94_405, children: [] }],
    }],
  });
  const oldSnapshot = await oldSnapshotPromise;

  const currentSnapshot = await raceService.getCategorySnapshot(scopedStore);
  const cachedCurrentSnapshot = await raceService.getCategorySnapshot(scopedStore);

  assert.equal(treeCalls, 2, "the post-rotation read must call Ozon instead of reusing the late old response");
  assert.notEqual(currentSnapshot.taxonomyFingerprint, oldSnapshot.taxonomyFingerprint);
  assert.equal(cachedCurrentSnapshot.taxonomyFingerprint, currentSnapshot.taxonomyFingerprint);
});

for (const cacheCase of [{
  name: "category attributes",
  read: (targetService, scopedStore) => targetService.getCategoryAttributes({
    ...scopedStore,
    descriptionCategoryId: 17_028_702,
    typeId: 94_405,
  }),
  response: (id) => ({ result: [{ id, name: `attribute-${id}` }] }),
}, {
  name: "category attribute values",
  read: (targetService, scopedStore) => targetService.getCategoryAttributeValues({
    ...scopedStore,
    descriptionCategoryId: 17_028_702,
    typeId: 94_405,
    attributeId: 85,
    limit: 1,
  }),
  response: (id) => ({ result: [{ id, value: `value-${id}` }], has_next: false }),
}]) {
  test(`credential rotation fences late old-credential ${cacheCase.name} responses`, async () => {
    let apiCalls = 0;
    let resolveOldRequest;
    let markOldRequestStarted;
    const oldRequestStarted = new Promise((resolve) => {
      markOldRequestStarted = resolve;
    });
    const raceService = createOzonCategoryService({
      callOzonSellerApi: async () => {
        apiCalls += 1;
        if (apiCalls === 1) {
          markOldRequestStarted();
          return new Promise((resolve) => {
            resolveOldRequest = resolve;
          });
        }
        return cacheCase.response(2);
      },
    });
    const scopedStore = input({ accountId: `race-${cacheCase.name}`, storeId: "race-store" });

    const oldResultPromise = cacheCase.read(raceService, scopedStore);
    await oldRequestStarted;
    raceService.invalidateStore({
      accountId: scopedStore.accountId,
      storeId: scopedStore.store.id,
    });
    resolveOldRequest(cacheCase.response(1));
    const oldResult = await oldResultPromise;
    const currentResult = await cacheCase.read(raceService, scopedStore);
    const cachedCurrentResult = await cacheCase.read(raceService, scopedStore);

    assert.equal(apiCalls, 2);
    assert.equal(oldResult.items[0].id, 1);
    assert.equal(currentResult.items[0].id, 2);
    assert.equal(cachedCurrentResult.items[0].id, 2);
    assert.equal(cachedCurrentResult.meta.source, "OZON_CACHE");
  });
}

test("target validation requires an enabled contained type and readable attributes", async () => {
  let validationNowMs = Date.parse("2026-07-28T00:00:00.000Z");
  let attributesReadable = true;
  const validationService = createOzonCategoryService({
    now: () => validationNowMs,
    callOzonSellerApi: async (_store, apiPath) => {
      if (apiPath.endsWith("/tree")) {
        return {
          result: [{
            description_category_id: 17028702,
            children: [{ type_id: 94405, children: [] }],
          }, {
            description_category_id: 17028703,
            children: [{ type_id: 94406, disabled: true, children: [] }],
          }, {
            description_category_id: 17028704,
            children: [{ type_id: 94407, children: [] }],
          }, {
            description_category_id: 17028705,
            disabled: true,
            children: [{ type_id: 94408, children: [] }],
          }],
        };
      }
      if (!attributesReadable) throw Object.assign(new Error("transient upstream failure"), { status: 503 });
      return { result: [] };
    },
  });
  const store = input({ storeId: "target-validation-store" }).store;

  const valid = await validationService.validateTarget(store, {
    descriptionCategoryId: 17028702,
    typeId: 94405,
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.reasonCode, "VALID");
  assert.equal(valid.taxonomyFingerprint, "ab78c17f42eddcbddc47bd20c76b67713a1b68dbaa3a5492ec72c69aa0a8cf9e");
  assert.equal(valid.validatedAt, "2026-07-28T00:00:00.000Z");

  const disabled = await validationService.validateTarget(store, {
    descriptionCategoryId: 17028703,
    typeId: 94406,
  });
  assert.equal(disabled.valid, false);
  assert.equal(disabled.reasonCode, "TYPE_DISABLED");
  assert.equal(disabled.taxonomyFingerprint, valid.taxonomyFingerprint);

  const wrongCategory = await validationService.validateTarget(store, {
    descriptionCategoryId: 17028702,
    typeId: 94407,
  });
  assert.equal(wrongCategory.valid, false);
  assert.equal(wrongCategory.reasonCode, "TYPE_NOT_IN_DESCRIPTION_CATEGORY");

  const disabledCategory = await validationService.validateTarget(store, {
    descriptionCategoryId: 17028705,
    typeId: 94408,
  });
  assert.equal(disabledCategory.valid, false);
  assert.equal(disabledCategory.reasonCode, "DESCRIPTION_CATEGORY_DISABLED");

  validationNowMs += CACHE_TTL_MS;
  attributesReadable = false;
  const attributesUnavailable = await validationService.validateTarget(store, {
    descriptionCategoryId: 17028702,
    typeId: 94405,
  });
  assert.equal(attributesUnavailable.valid, false);
  assert.equal(attributesUnavailable.reasonCode, "ATTRIBUTES_UNAVAILABLE");
  assert.equal(attributesUnavailable.taxonomyFingerprint, valid.taxonomyFingerprint);
});

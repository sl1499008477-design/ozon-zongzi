import assert from "node:assert/strict";
import test from "node:test";
import * as categoryReadinessModule from "../src/category-readiness.js";
import {
  CATEGORY_DATA_ERROR_MESSAGE,
  categoryRequestIsCurrent,
  categoryRequestScope,
  categoryItemScopeIsCurrent,
  categoryTreeLoadFailure,
  categoryTreeLoadStart,
  categoryTreeLoadSuccess,
  categoryReadiness,
  scopedCategoryTrees,
  loadRealCategoryTrees,
  requireCategoryReadiness,
  sourceCategoryEvidenceOf,
  accountSharedCategoryResolution,
  listingCategoryFields,
  categoryConfirmationRequest,
  categoryConfirmationResponse,
} from "../src/category-readiness.js";

const validTree = [{
  description_category_id: 10,
  children: [{ type_id: 20, children: [] }],
}];

test("loads non-empty Ozon items trees for both languages as independent clones", async () => {
  const loaded = await loadRealCategoryTrees({
    readTree: async (language) => ({
      items: structuredClone(validTree),
      meta: { source: "OZON_API", language },
    }),
  });

  assert.equal(loaded.zhTree[0].description_category_id, 10);
  assert.equal(loaded.ruTree[0].children[0].type_id, 20);
  assert.notStrictEqual(loaded.zhTree, validTree);
  assert.notStrictEqual(loaded.zhTree[0].children, validTree[0].children);
  loaded.zhTree[0].children[0].type_id = 99;
  assert.equal(validTree[0].children[0].type_id, 20);
  assert.equal(loaded.ruTree[0].children[0].type_id, 20);
});

test("accepts the existing data array response contract", async () => {
  const loaded = await loadRealCategoryTrees({
    readTree: async () => ({ data: structuredClone(validTree) }),
  });

  assert.equal(loaded.zhTree.length, 1);
  assert.equal(loaded.ruTree.length, 1);
});

test("rejects a missing language tree without accepting a fallback shape", async () => {
  await assert.rejects(
    () => loadRealCategoryTrees({
      readTree: async (language) => {
        if (language === "RU") throw new Error("offline");
        return { items: structuredClone(validTree) };
      },
    }),
    (error) => error.code === "OZON_CATEGORY_UI_UNAVAILABLE" && error.message === CATEGORY_DATA_ERROR_MESSAGE,
  );

  await assert.rejects(
    () => loadRealCategoryTrees({
      readTree: async () => ({ items: [], fallback: structuredClone(validTree) }),
    }),
    (error) => error.code === "OZON_CATEGORY_UI_UNAVAILABLE",
  );
});

test("requires a selected category and a non-empty authentic tree for preview and publish", () => {
  assert.deepEqual(categoryReadiness({
    descriptionCategoryId: 10,
    typeId: 20,
    loading: false,
    error: "",
    treeCount: 1,
  }), { ready: true, message: "" });

  for (const input of [
    { descriptionCategoryId: 10, typeId: 20, loading: true, error: "", treeCount: 1 },
    { descriptionCategoryId: 10, typeId: 20, loading: false, error: "offline", treeCount: 1 },
    { descriptionCategoryId: 10, typeId: 20, loading: false, error: "", treeCount: 0 },
    { descriptionCategoryId: "", typeId: 20, loading: false, error: "", treeCount: 1 },
    { descriptionCategoryId: 10, typeId: "", loading: false, error: "", treeCount: 1 },
  ]) {
    assert.throws(
      () => requireCategoryReadiness(input),
      (error) => error.code === "OZON_CATEGORY_UI_UNAVAILABLE" && error.message === CATEGORY_DATA_ERROR_MESSAGE,
    );
  }
});

test("blocks preview and publish while dictionary values are loading or failed", () => {
  for (const input of [
    {
      descriptionCategoryId: 10,
      typeId: 20,
      loading: false,
      error: "",
      treeCount: 1,
      dictionaryLoading: true,
      dictionaryError: "",
    },
    {
      descriptionCategoryId: 10,
      typeId: 20,
      loading: false,
      error: "",
      treeCount: 1,
      dictionaryLoading: false,
      dictionaryError: CATEGORY_DATA_ERROR_MESSAGE,
    },
  ]) {
    assert.throws(
      () => requireCategoryReadiness(input),
      (error) => error.code === "OZON_CATEGORY_UI_UNAVAILABLE"
        && error.message === CATEGORY_DATA_ERROR_MESSAGE,
    );
  }
});

test("rejects a late category-match response after its request or store-item scope changed", () => {
  const scopeA = categoryRequestScope({ storeId: "store-a", itemId: "item-a" });
  const scopeB = categoryRequestScope({ storeId: "store-b", itemId: "item-a" });

  assert.equal(categoryRequestIsCurrent({
    requestId: 1,
    scope: scopeA,
    currentRequestId: 1,
    currentScope: scopeA,
  }), true);
  assert.equal(categoryRequestIsCurrent({
    requestId: 1,
    scope: scopeA,
    currentRequestId: 2,
    currentScope: scopeB,
  }), false);
});

test("returns only cloned trees scoped to the current store", () => {
  const scoped = scopedCategoryTrees({
    treeStoreId: "store-a",
    currentStoreId: "store-a",
    zhTree: validTree,
    ruTree: validTree,
  });
  scoped.zhTree[0].children[0].type_id = 99;
  assert.equal(validTree[0].children[0].type_id, 20);

  assert.deepEqual(scopedCategoryTrees({
    treeStoreId: "store-a",
    currentStoreId: "store-b",
    zhTree: validTree,
    ruTree: validTree,
  }), { zhTree: [], ruTree: [] });
});

test("keeps a visible retry error while loading and changes it only on current completion", () => {
  assert.deepEqual(categoryTreeLoadStart("prior failure"), {
    zhTree: [],
    ruTree: [],
    treeStoreId: "",
    loading: true,
    error: "prior failure",
  });
  assert.deepEqual(categoryTreeLoadSuccess({
    zhTree: validTree,
    ruTree: validTree,
    storeId: "store-a",
  }), {
    zhTree: validTree,
    ruTree: validTree,
    treeStoreId: "store-a",
    loading: false,
    error: "",
  });
  assert.deepEqual(categoryTreeLoadFailure(), {
    zhTree: [],
    ruTree: [],
    treeStoreId: "",
    loading: false,
    error: CATEGORY_DATA_ERROR_MESSAGE,
  });
});

test("requires explicit matching local and item store scope before consuming an item", () => {
  assert.equal(categoryItemScopeIsCurrent({
    currentStoreId: "store-b",
    localStateStoreId: "store-b",
    itemStoreId: "store-b",
  }), true);
  assert.equal(categoryItemScopeIsCurrent({
    currentStoreId: "store-b",
    localStateStoreId: "store-a",
    itemStoreId: "store-a",
  }), false);
  assert.equal(categoryItemScopeIsCurrent({
    currentStoreId: "store-b",
    localStateStoreId: "store-b",
    itemStoreId: "",
  }), false);
});

test("reads source category evidence without treating it as a target category", () => {
  assert.deepEqual(sourceCategoryEvidenceOf({
    variantData: {
      description_category_id: 17039736,
      categories: [
        { level: 2, title: "家用电器" },
        { level: 3, name: "Заварочный чайник" },
      ],
      attributes: [{
        key: "8229",
        value: "Заварочный чайник",
        dictionary_value_id: 123456,
      }],
    },
  }), {
    descriptionCategoryId: 17039736,
    typeName: "Заварочный чайник",
    typeIdCandidate: 123456,
    path: ["家用电器", "Заварочный чайник"],
  });
});

test("reads Seller source evidence from the enriched listing draft without using manual target fields", () => {
  assert.deepEqual(sourceCategoryEvidenceOf({
    listingDraft: {
      descriptionCategoryId: 880001,
      typeId: 990001,
      sourceCategory: {
        descriptionCategoryId: 17039736,
        typeName: "Seller source",
        typeIdCandidate: 123456,
        path: ["Seller root", "Seller source"],
      },
    },
  }), {
    descriptionCategoryId: 17039736,
    typeName: "Seller source",
    typeIdCandidate: 123456,
    path: ["Seller root", "Seller source"],
  });
});

test("stale empty resolution source does not hide later Seller source evidence", () => {
  assert.deepEqual(sourceCategoryEvidenceOf({
    listingDraft: {
      categoryResolution: {
        source: {
          descriptionCategoryId: 0,
          typeName: "",
          typeIdCandidate: 0,
          path: [],
        },
        target: { descriptionCategoryId: 880001, typeId: 990001 },
      },
      sourceCategory: {
        descriptionCategoryId: 17039736,
        typeName: "Seller source",
        typeIdCandidate: 123456,
        path: ["Seller root", "Seller source"],
      },
    },
  }), {
    descriptionCategoryId: 17039736,
    typeName: "Seller source",
    typeIdCandidate: 123456,
    path: ["Seller root", "Seller source"],
  });
});

test("projects only the account-shared taxonomy and never falls back to a store-bound draft", () => {
  const shared = {
    status: "ACTIVE",
    taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 10,
    sourceTypeId: 20,
    currentDescriptionCategoryId: 30,
    currentTypeId: 40,
    source: "SOURCE_DIRECT",
    version: 3,
    validatedAt: null,
    action: "NONE",
    message: "使用采集类目准备上架",
  };
  const projected = accountSharedCategoryResolution(shared, { taxonomyScope: "OZON:DEFAULT" });
  assert.deepEqual(projected, shared);
  assert.notStrictEqual(projected, shared);
  assert.equal(accountSharedCategoryResolution(shared, { taxonomyScope: "OZON:RU" }), null);
  assert.equal(accountSharedCategoryResolution({
    status: "MATCHED",
    method: "MANUAL",
    target: { storeId: "store-a", descriptionCategoryId: 30, typeId: 40 },
  }), null);
  assert.equal(categoryReadinessModule.categoryResolutionForStore, undefined);
  assert.equal(categoryReadinessModule.categoryResolutionForTarget, undefined);
  assert.equal(categoryReadinessModule.categoryResolutionForCollectionTarget, undefined);
  assert.equal(categoryReadinessModule.listingTargetCategoryFieldsForStore, undefined);
  assert.equal(categoryReadinessModule.manualCategoryResolution, undefined);
});

test("fails closed without executing accessors or revoked proxies", () => {
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, "status", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "ACTIVE";
    },
  });
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const transparent = new Proxy({
    status: "ACTIVE", taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 10, sourceTypeId: 20,
    currentDescriptionCategoryId: 30, currentTypeId: 40,
    source: "SOURCE_DIRECT", version: 1, validatedAt: null,
    action: "NONE", message: "使用采集类目准备上架",
  }, {});
  let trapCalls = 0;
  const trapped = new Proxy({ ...transparent }, {
    getPrototypeOf() { trapCalls += 1; return Object.prototype; },
    ownKeys() { trapCalls += 1; return []; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
    get() { trapCalls += 1; return undefined; },
  });

  assert.equal(accountSharedCategoryResolution(hostile), null);
  assert.equal(accountSharedCategoryResolution(proxy), null);
  assert.equal(accountSharedCategoryResolution(transparent), null);
  assert.equal(accountSharedCategoryResolution(trapped), null);
  assert.equal(getterCalls, 0);
  assert.equal(trapCalls, 0);
});

test("requires the exact complete public shared-summary state contract", () => {
  const active = {
    status: "ACTIVE", taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 10, sourceTypeId: 20,
    currentDescriptionCategoryId: 30, currentTypeId: 40,
    source: "SOURCE_DIRECT", version: 3, validatedAt: null,
    action: "NONE", message: "使用采集类目准备上架",
  };
  const refreshed = {
    ...active, status: "INVALIDATED", source: "OZON_REFRESH",
    validatedAt: "2026-08-12T01:02:03.000Z", action: "WAIT",
    message: "Ozon 类目已失效，正在自动修复",
  };
  const unresolved = {
    status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: null, sourceTypeId: null,
    currentDescriptionCategoryId: null, currentTypeId: null,
    source: null, version: null, validatedAt: null,
    action: "REVIEW", message: "无法确认商品类目，请人工选择",
  };
  for (const valid of [active, refreshed, unresolved]) {
    assert.deepEqual(accountSharedCategoryResolution(valid), valid);
  }
  const invalid = [
    { ...active, extra: "raw" },
    Object.assign(Object.create(null), active),
    { ...active, source: "LEGACY" },
    { ...active, version: 0 },
    { ...active, version: 1.5 },
    { ...active, validatedAt: "2026-08-12 01:02:03Z" },
    { ...active, action: "REVIEW" },
    { ...active, message: "vendor copy" },
    { ...active, currentTypeId: null },
    { ...unresolved, sourceDescriptionCategoryId: 10 },
  ];
  const withSymbol = { ...active };
  withSymbol[Symbol("raw")] = "secret";
  invalid.push(withSymbol);
  for (const candidate of invalid) assert.equal(accountSharedCategoryResolution(candidate), null);
});

test("uses only a valid ACTIVE account-shared category for listing fields", () => {
  const active = {
    status: "ACTIVE",
    taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 17_028_702,
    sourceTypeId: 94_405,
    currentDescriptionCategoryId: 17_028_702,
    currentTypeId: 94_405,
    source: "SOURCE_DIRECT", version: 1, validatedAt: null,
    action: "NONE", message: "使用采集类目准备上架",
  };
  assert.deepEqual(listingCategoryFields(active), { descriptionCategoryId: 17_028_702, typeId: 94_405 });

  for (const resolution of [
    { ...active, status: "INVALIDATED", action: "WAIT", message: "Ozon 类目已失效，正在自动修复" },
    { ...active, status: "NEEDS_REVIEW", action: "REVIEW", message: "无法确认商品类目，请人工选择" },
    { ...active, taxonomyScope: "OZON:RU" },
    { ...active, currentDescriptionCategoryId: 0 },
    { ...active, currentTypeId: -2 },
  ]) assert.deepEqual(listingCategoryFields(resolution), {});
});

test("builds a closed administrator confirmation request with optimistic source identity", () => {
  const request = categoryConfirmationRequest({
    collectItemId: "collect-a",
    expectedSourceVersion: "draft:7",
    descriptionCategoryId: 17_028_702,
    typeId: 94_405,
    taxonomyScope: "OZON:DEFAULT",
    idempotencyKey: "category-confirmation-a",
    correlationId: "category-confirmation-correlation-a",
    targetStoreId: "must-not-leak",
    rawVendorMessage: "must-not-leak",
  });
  assert.deepEqual(request, {
    collectItemId: "collect-a",
    expectedSourceVersion: "draft:7",
    descriptionCategoryId: 17_028_702,
    typeId: 94_405,
    taxonomyScope: "OZON:DEFAULT",
    idempotencyKey: "category-confirmation-a",
    correlationId: "category-confirmation-correlation-a",
  });
  assert.deepEqual(Object.keys(request).sort(), [
    "collectItemId", "correlationId", "descriptionCategoryId", "expectedSourceVersion",
    "idempotencyKey", "taxonomyScope", "typeId",
  ]);
  for (const invalid of [
    { collectItemId: "", expectedSourceVersion: "draft:7" },
    { collectItemId: "collect-a", expectedSourceVersion: "" },
    { collectItemId: "collect-a", expectedSourceVersion: "draft:7", descriptionCategoryId: 0 },
    { collectItemId: "collect-a", expectedSourceVersion: "draft:7", descriptionCategoryId: 1, typeId: 1.5 },
  ]) assert.throws(() => categoryConfirmationRequest({
    descriptionCategoryId: 1,
    typeId: 2,
    taxonomyScope: "OZON:DEFAULT",
    idempotencyKey: "key",
    correlationId: "correlation",
    ...invalid,
  }), { code: "OZON_CATEGORY_CONFIRMATION_INVALID" });
});

test("accepts only a complete exact administrator confirmation response", () => {
  const request = categoryConfirmationRequest({
    collectItemId: "collect-a", expectedSourceVersion: "draft:7",
    descriptionCategoryId: 17_028_702, typeId: 94_405,
    taxonomyScope: "OZON:DEFAULT", idempotencyKey: "key", correlationId: "correlation",
  });
  const categoryResolution = {
    status: "ACTIVE", taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 10, sourceTypeId: 20,
    currentDescriptionCategoryId: 17_028_702, currentTypeId: 94_405,
    source: "MANUAL", version: 2, validatedAt: "2026-08-12T01:02:03.000Z",
    action: "NONE", message: "使用采集类目准备上架",
  };
  const responseInput = { collectItemId: "collect-a", categoryResolution };
  const projected = categoryConfirmationResponse(responseInput, request);
  assert.deepEqual(projected, {
    collectItemId: "collect-a", categoryResolution,
  });
  assert.notEqual(projected, responseInput);
  assert.notEqual(projected.categoryResolution, categoryResolution);
  assert.equal(Object.isFrozen(responseInput), false);
  assert.equal(Object.isFrozen(categoryResolution), false);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.categoryResolution), true);
  let getterCalls = 0;
  const accessor = { collectItemId: "collect-a" };
  Object.defineProperty(accessor, "categoryResolution", {
    enumerable: true,
    get() { getterCalls += 1; return categoryResolution; },
  });
  let trapCalls = 0;
  const trapped = new Proxy({ collectItemId: "collect-a", categoryResolution }, {
    getPrototypeOf() { trapCalls += 1; return Object.prototype; },
    ownKeys() { trapCalls += 1; return []; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
    get() { trapCalls += 1; return undefined; },
  });
  for (const response of [
    { collectItemId: "collect-a" },
    { collectItemId: "collect-a", categoryResolution: { ...categoryResolution, currentTypeId: null } },
    { collectItemId: "collect-b", categoryResolution },
    { collectItemId: "collect-a", categoryResolution, raw: "secret" },
    accessor,
    new Proxy({ collectItemId: "collect-a", categoryResolution }, {}),
    trapped,
  ]) assert.equal(categoryConfirmationResponse(response, request), null);
  assert.equal(getterCalls, 0);
  assert.equal(trapCalls, 0);
});

test("rejects nested confirmation summaries without executing accessors or proxy traps", () => {
  const request = categoryConfirmationRequest({
    collectItemId: "collect-a", expectedSourceVersion: "draft:7",
    descriptionCategoryId: 17_028_702, typeId: 94_405,
    taxonomyScope: "OZON:DEFAULT", idempotencyKey: "key", correlationId: "correlation",
  });
  const categoryResolution = {
    status: "ACTIVE", taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: 10, sourceTypeId: 20,
    currentDescriptionCategoryId: 17_028_702, currentTypeId: 94_405,
    source: "MANUAL", version: 2, validatedAt: "2026-08-12T01:02:03.000Z",
    action: "NONE", message: "使用采集类目准备上架",
  };
  let getterCalls = 0;
  const nestedAccessor = { ...categoryResolution };
  Object.defineProperty(nestedAccessor, "currentTypeId", {
    enumerable: true,
    get() { getterCalls += 1; return 94_405; },
  });
  const transparent = new Proxy({ ...categoryResolution }, {});
  const { proxy: revoked, revoke } = Proxy.revocable({ ...categoryResolution }, {});
  revoke();
  let trapCalls = 0;
  const trapped = new Proxy({ ...categoryResolution }, {
    getPrototypeOf() { trapCalls += 1; return Object.prototype; },
    ownKeys() { trapCalls += 1; return []; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
    get() { trapCalls += 1; return undefined; },
  });

  for (const nested of [nestedAccessor, transparent, revoked, trapped]) {
    assert.equal(categoryConfirmationResponse({
      collectItemId: "collect-a", categoryResolution: nested,
    }, request), null);
  }
  assert.equal(getterCalls, 0);
  assert.equal(trapCalls, 0);
});

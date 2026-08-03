import assert from "node:assert/strict";
import test from "node:test";
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
  categoryResolutionForTarget,
  categoryResolutionForCollectionTarget,
  categoryResolutionForStore,
  listingTargetCategoryFieldsForStore,
  manualCategoryResolution,
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

test("uses a matched resolution only for the currently selected target store", () => {
  const resolution = {
    status: "MATCHED",
    method: "DICTIONARY_VALUE_ID",
    source: { descriptionCategoryId: 10, typeName: "Source", typeIdCandidate: 20, path: [] },
    target: { storeId: "store-a", descriptionCategoryId: 30, typeId: 40 },
    resolvedAt: "2026-08-01T00:00:00.000Z",
  };
  assert.deepEqual(categoryResolutionForStore(resolution, "store-a"), resolution);
  assert.equal(categoryResolutionForStore(resolution, "store-b"), null);
  assert.deepEqual(listingTargetCategoryFieldsForStore(resolution, "store-a"), {
    descriptionCategoryId: 30,
    typeId: 40,
  });
  assert.deepEqual(listingTargetCategoryFieldsForStore(resolution, "store-b"), {});
  assert.deepEqual(listingTargetCategoryFieldsForStore({
    status: "MATCHED",
    method: "",
    source: { descriptionCategoryId: 123, typeIdCandidate: 456 },
    target: { storeId: "store-a", descriptionCategoryId: 999, typeId: 1000 },
  }, "store-a"), {}, "an incomplete marker cannot turn source or historical roots into a target");
});

test("uses taxonomy-scoped shared matches before legacy store-bound drafts", () => {
  const shared = {
    status: "MATCHED",
    taxonomyScope: "OZON:DEFAULT",
    targetDescriptionCategoryId: 17_028_702,
    targetTypeId: 94_405,
    displayPath: { zh: ["运动与休闲", "捞鱼网"], ru: ["Спорт и отдых", "Подсачек"] },
    method: "TYPE_ID_EXACT",
    matchedAt: "2026-08-03T10:00:00.000Z",
    validatedAt: "2026-08-03T10:00:00.000Z",
    action: "NONE",
    message: "类目已匹配",
  };

  const matchedForStoreB = categoryResolutionForTarget(shared, {
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
  });
  assert.deepEqual(matchedForStoreB, shared);
  assert.notStrictEqual(matchedForStoreB, shared);
  assert.deepEqual(listingTargetCategoryFieldsForStore(shared, "store-b"), {
    descriptionCategoryId: 17_028_702,
    typeId: 94_405,
  });
  assert.deepEqual(listingTargetCategoryFieldsForStore({
    status: "MATCHED",
    taxonomyScope: "OZON:DEFAULT",
    targetDescriptionCategoryId: 17_028_702,
    targetTypeId: 94_405,
    method: "",
  }, "store-b"), {
    descriptionCategoryId: 17_028_702,
    typeId: 94_405,
  }, "shared taxonomy results do not require a legacy method marker");
  assert.equal(categoryResolutionForTarget(shared, {
    targetStoreId: "store-b",
    taxonomyScope: "OZON:RU",
  }), null);

  const legacy = {
    status: "MATCHED",
    method: "MANUAL",
    target: { storeId: "store-a", descriptionCategoryId: 30, typeId: 40 },
  };
  assert.deepEqual(categoryResolutionForTarget(legacy, { targetStoreId: "store-a" }), legacy);
  assert.equal(categoryResolutionForTarget(legacy, { targetStoreId: "store-b" }), null);
});

test("uses a shared summary before a legacy draft only when its taxonomy matches", () => {
  const shared = {
    status: "MATCHED",
    taxonomyScope: "OZON:DEFAULT",
    targetDescriptionCategoryId: 11,
    targetTypeId: 22,
    method: "",
  };
  const legacy = {
    status: "MATCHED",
    method: "MANUAL",
    target: { storeId: "store-b", descriptionCategoryId: 33, typeId: 44 },
  };
  const item = {
    categoryResolution: shared,
    listingDraft: { categoryResolution: legacy },
  };

  assert.deepEqual(categoryResolutionForCollectionTarget(item, {
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
  }), shared, "the account-level match must be reusable by another store in the same taxonomy");
  assert.deepEqual(categoryResolutionForCollectionTarget(item, {
    targetStoreId: "store-b",
    taxonomyScope: "OZON:RU",
  }), legacy, "a taxonomy mismatch must fall back to the compatible legacy draft");
  assert.deepEqual(categoryResolutionForCollectionTarget({
    listingDraft: { categoryResolution: legacy },
  }, {
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
  }), legacy, "existing store-bound drafts remain readable");
});

test("does not mark any non-matched or non-positive summary target ready for listing", () => {
  for (const status of [
    "WAITING_ENRICHMENT",
    "WAITING_STORE",
    "QUEUED",
    "MATCHING",
    "RETRYABLE_ERROR",
    "NEEDS_REVIEW",
    "INVALIDATED",
  ]) {
    assert.deepEqual(listingTargetCategoryFieldsForStore({
      status,
      taxonomyScope: "OZON:DEFAULT",
      targetDescriptionCategoryId: 17_028_702,
      targetTypeId: 94_405,
      method: "TYPE_ID_EXACT",
    }, "store-b"), {}, status);
  }

  for (const [targetDescriptionCategoryId, targetTypeId] of [[0, 94_405], [17_028_702, 0], [-1, 94_405]]) {
    assert.deepEqual(listingTargetCategoryFieldsForStore({
      status: "MATCHED",
      taxonomyScope: "OZON:DEFAULT",
      targetDescriptionCategoryId,
      targetTypeId,
      method: "TYPE_ID_EXACT",
    }, "store-b"), {});
  }
});

test("records a manual target-store category selection with its source evidence", () => {
  assert.deepEqual(manualCategoryResolution({
    source: { descriptionCategoryId: 10, typeName: "Source", typeIdCandidate: 20, path: ["Root", "Source"] },
    targetStoreId: "store-a",
    descriptionCategoryId: 30,
    typeId: 40,
    resolvedAt: "2026-08-01T00:00:00.000Z",
  }), {
    status: "MATCHED",
    method: "MANUAL",
    source: { descriptionCategoryId: 10, typeName: "Source", typeIdCandidate: 20, path: ["Root", "Source"] },
    target: { storeId: "store-a", descriptionCategoryId: 30, typeId: 40 },
    resolvedAt: "2026-08-01T00:00:00.000Z",
  });
});

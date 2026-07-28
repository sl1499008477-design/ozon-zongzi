import assert from "node:assert/strict";
import test from "node:test";
import {
  CATEGORY_DATA_ERROR_MESSAGE,
  categoryRequestIsCurrent,
  categoryRequestScope,
  categoryTreeLoadFailure,
  categoryTreeLoadStart,
  categoryTreeLoadSuccess,
  categoryReadiness,
  scopedCategoryTrees,
  loadRealCategoryTrees,
  requireCategoryReadiness,
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

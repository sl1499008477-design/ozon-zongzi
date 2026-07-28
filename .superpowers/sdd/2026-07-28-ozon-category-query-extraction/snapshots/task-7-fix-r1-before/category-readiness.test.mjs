import assert from "node:assert/strict";
import test from "node:test";
import {
  CATEGORY_DATA_ERROR_MESSAGE,
  categoryReadiness,
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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const appRoot = new URL("..", import.meta.url);
const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const vite = await createServer({
  root: fileURLToPath(appRoot),
  server: { middlewareMode: true, hmr: { port: 30_000 + (process.pid % 10_000) } },
});
after(async () => { await vite.close(); });
const appModule = await vite.ssrLoadModule("/src/App.jsx");
const { categoryResolutionView } = await vite.ssrLoadModule("/src/collect-category-resolution-view.js");

const shared = {
  status: "ACTIVE",
  taxonomyScope: "OZON:DEFAULT",
  sourceDescriptionCategoryId: 11,
  sourceTypeId: 22,
  currentDescriptionCategoryId: 33,
  currentTypeId: 44,
  source: "SOURCE_DIRECT",
  version: 7,
  validatedAt: null,
  action: "NONE",
  message: "使用采集类目准备上架",
};

test("collection preview, variant, seed, and draft paths use only the account-shared category", () => {
  const item = {
    id: "collect-a", draftVersion: 8, sku: "sku-a", categoryResolution: shared,
    listingDraft: {
      categoryResolution: {
        status: "MATCHED", method: "MANUAL",
        target: { storeId: "store-a", descriptionCategoryId: 999, typeId: 1000 },
      },
    },
  };
  const common = { item, sku: "sku-a", title: "Shared", price: "100", targetStoreId: "store-b" };
  const preview = appModule.collectEditPreviewPayload(common);
  const rows = appModule.collectEditVariantRows(common);
  const seed = appModule.collectEditCategoryPreviewSeed({ item, targetStoreId: "store-b" });
  const draft = appModule.collectEditDraftVariantCategory({ item, row: rows[0], targetStoreId: "store-b" });
  for (const selected of [preview, rows[0], seed, draft]) {
    assert.deepEqual({
      descriptionCategoryId: selected.description_category_id ?? selected.descriptionCategoryId,
      typeId: selected.type_id ?? selected.typeId,
    }, { descriptionCategoryId: 33, typeId: 44 });
  }
  const mismatched = appModule.collectEditCategoryPreviewSeed({ item, taxonomyScope: "OZON:RU" });
  assert.deepEqual({
    descriptionCategoryId: mismatched.descriptionCategoryId,
    typeId: mismatched.typeId,
  }, { descriptionCategoryId: "", typeId: "" });
});

test("administrator category confirmation intent is exact, versioned, idempotent, and store independent", () => {
  assert.equal(typeof appModule.collectCategoryConfirmationIntent, "function");
  const intent = appModule.collectCategoryConfirmationIntent({
    item: { id: "collect-a", draftVersion: 8 },
    descriptionCategoryId: 55,
    typeId: 66,
    taxonomyScope: "OZON:DEFAULT",
    idempotencyKey: "confirm-a",
    correlationId: "corr-a",
    targetStoreId: "must-not-appear",
  });
  assert.deepEqual(intent, {
    collectItemId: "collect-a",
    expectedSourceVersion: "draft:8",
    descriptionCategoryId: 55,
    typeId: 66,
    taxonomyScope: "OZON:DEFAULT",
    idempotencyKey: "confirm-a",
    correlationId: "corr-a",
  });
  assert.equal("targetStoreId" in intent, false);
  for (const draftVersion of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => appModule.collectCategoryConfirmationIntent({
      item: { id: "collect-a", draftVersion },
      descriptionCategoryId: 55,
      typeId: 66,
      taxonomyScope: "OZON:DEFAULT",
      idempotencyKey: "confirm-a",
      correlationId: "corr-a",
    }), { code: "ZONGZI_CATEGORY_CONFIRMATION_INVALID" });
  }
});

test("collection editor calls only the dedicated administrator confirmation route", () => {
  const collectEditPage = appSource.slice(
    appSource.indexOf("function CollectEditPage"),
    appSource.indexOf("function ImportHistoryPage"),
  );
  assert.match(collectEditPage, /account\?\.role !== "admin"/u);
  assert.match(collectEditPage, /\/ozon\/category-confirmations/u);
  assert.match(appSource, /expectedSourceVersion/u);
  assert.match(appSource, /idempotencyKey/u);
  assert.match(appSource, /correlationId/u);
  assert.doesNotMatch(collectEditPage, /COLLECT_EDIT_AUTO_CATEGORY|\/ozon\/products\/import\/preview/u);
});

test("collection UI contains no store-category matching language and marks manual choice as administrator confirmation", () => {
  for (const forbidden of ["目标店铺类目", "按当前店铺匹配", "等待经营店铺类目", "正在核验目标店铺类目"]) {
    assert.doesNotMatch(appSource, new RegExp(forbidden, "u"));
  }
  assert.match(appSource, /管理员确认类目/u);
  assert.match(appSource, /categoryResolutionView[\s\S]*?from "\.\/collect-category-resolution-view\.js"/u);
  assert.equal(categoryResolutionView(shared).label, "使用采集类目准备上架");
  assert.equal(categoryResolutionView({
    status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT",
    sourceDescriptionCategoryId: null, sourceTypeId: null,
    currentDescriptionCategoryId: null, currentTypeId: null,
    source: null, version: null, validatedAt: null,
    action: "REVIEW", message: "无法确认商品类目，请人工选择",
  }).label, "无法确认商品类目，请人工选择");
});

test("listing history keeps the shared local calendar date helper", () => {
  assert.match(appSource, /localDayKey,[\s\S]*?from "\.\/store-date\.js"/u);
  assert.doesNotMatch(appSource, /localDayFormatter/u);
  assert.match(appSource, /const todayKey = localDayKey\(new Date\(\)\)/u);
});

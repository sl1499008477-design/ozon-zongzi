import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const appRoot = new URL("..", import.meta.url);
const vite = await createServer({
  root: fileURLToPath(appRoot),
  server: {
    middlewareMode: true,
    hmr: { port: 30_000 + (process.pid % 10_000) },
  },
});
const appModule = await vite.ssrLoadModule("/src/App.jsx");

after(async () => {
  await vite.close();
});

const sharedSummary = {
  status: "MATCHED",
  taxonomyScope: "OZON:DEFAULT",
  targetDescriptionCategoryId: 11,
  targetTypeId: 22,
  method: "",
  action: "NONE",
  message: "类目已匹配",
};

const legacyStoreBDraft = {
  status: "MATCHED",
  method: "MANUAL",
  target: { storeId: "store-b", descriptionCategoryId: 33, typeId: 44 },
};

const itemWithSharedAndLegacy = () => ({
  sku: "shared-sku",
  name: "Shared summary product",
  categoryResolution: sharedSummary,
  listingDraft: { categoryResolution: legacyStoreBDraft },
});

test("Collect edit's real App reading path uses taxonomy summaries before legacy store drafts", () => {
  assert.equal(typeof appModule.collectEditPreviewPayload, "function");
  assert.equal(typeof appModule.collectEditVariantRows, "function");
  assert.equal(typeof appModule.collectEditCategoryPreviewSeed, "function");

  const item = itemWithSharedAndLegacy();
  const preview = appModule.collectEditPreviewPayload({
    item,
    sku: "shared-sku",
    title: "Shared summary product",
    price: "100",
    targetStoreId: "store-b",
  });
  assert.equal(preview.description_category_id, 11);
  assert.equal(preview.type_id, 22, "shared MATCHED summaries do not require a method marker");

  const rows = appModule.collectEditVariantRows({
    item,
    sku: "shared-sku",
    title: "Shared summary product",
    price: "100",
    targetStoreId: "store-b",
  });
  assert.deepEqual(
    { descriptionCategoryId: rows[0].descriptionCategoryId, typeId: rows[0].typeId },
    { descriptionCategoryId: 11, typeId: 22 },
  );

  const seed = appModule.collectEditCategoryPreviewSeed({ item, targetStoreId: "store-b" });
  assert.deepEqual(
    { descriptionCategoryId: seed.descriptionCategoryId, typeId: seed.typeId },
    { descriptionCategoryId: "11", typeId: "22" },
    "page state must seed fields from top-level targetDescriptionCategoryId / targetTypeId",
  );

  const mismatchSeed = appModule.collectEditCategoryPreviewSeed({
    item,
    targetStoreId: "store-b",
    taxonomyScope: "OZON:RU",
  });
  assert.deepEqual(
    { descriptionCategoryId: mismatchSeed.descriptionCategoryId, typeId: mismatchSeed.typeId },
    { descriptionCategoryId: "33", typeId: "44" },
    "a different taxonomy must not reuse the shared match",
  );

  const legacySeed = appModule.collectEditCategoryPreviewSeed({
    item: { sku: "legacy-sku", listingDraft: { categoryResolution: legacyStoreBDraft } },
    targetStoreId: "store-b",
  });
  assert.deepEqual(
    { descriptionCategoryId: legacySeed.descriptionCategoryId, typeId: legacySeed.typeId },
    { descriptionCategoryId: "33", typeId: "44" },
    "legacy store-bound drafts stay compatible",
  );
});

test("Collect edit variant rows use the listing draft after a shared mismatch without explicit variants", () => {
  const rows = appModule.collectEditVariantRows({
    item: itemWithSharedAndLegacy(),
    sku: "shared-sku",
    title: "Shared summary product",
    price: "100",
    targetStoreId: "store-b",
    taxonomyScope: "OZON:RU",
  });
  assert.deepEqual(
    { descriptionCategoryId: rows[0].descriptionCategoryId, typeId: rows[0].typeId },
    { descriptionCategoryId: 33, typeId: 44 },
  );
});

test("Collect edit variant rows do not treat the no-variants item root as a legacy variant", () => {
  const rows = appModule.collectEditVariantRows({
    item: {
      sku: "root-legacy-sku",
      categoryResolution: {
        status: "MATCHED",
        method: "MANUAL",
        target: { storeId: "store-b", descriptionCategoryId: 99, typeId: 100 },
      },
      listingDraft: { categoryResolution: legacyStoreBDraft },
    },
    sku: "root-legacy-sku",
    title: "Root legacy product",
    price: "100",
    targetStoreId: "store-b",
  });
  assert.deepEqual(
    { descriptionCategoryId: rows[0].descriptionCategoryId, typeId: rows[0].typeId },
    { descriptionCategoryId: 33, typeId: 44 },
  );
});

test("Collect edit variant rows prefer an explicit legacy variant after a shared mismatch", () => {
  const rows = appModule.collectEditVariantRows({
    item: {
      ...itemWithSharedAndLegacy(),
      variants: [{
        sku: "variant-legacy",
        categoryResolution: {
          status: "MATCHED",
          method: "MANUAL",
          target: { storeId: "store-b", descriptionCategoryId: 77, typeId: 88 },
        },
      }],
    },
    sku: "variant-legacy",
    title: "Shared summary product",
    price: "100",
    targetStoreId: "store-b",
    taxonomyScope: "OZON:RU",
  });
  assert.deepEqual(
    { descriptionCategoryId: rows[0].descriptionCategoryId, typeId: rows[0].typeId },
    { descriptionCategoryId: 77, typeId: 88 },
  );
});

test("Collect edit executes a non-default taxonomy summary through preview, seed, and variants", () => {
  const item = {
    ...itemWithSharedAndLegacy(),
    categoryResolution: {
      status: "MATCHED",
      taxonomyScope: "OZON:RU",
      targetDescriptionCategoryId: 55,
      targetTypeId: 66,
      method: "",
    },
  };
  const preview = appModule.collectEditPreviewPayload({
    item,
    sku: "shared-sku",
    title: "Shared summary product",
    price: "100",
    targetStoreId: "store-b",
    taxonomyScope: "OZON:RU",
  });
  assert.deepEqual(
    { descriptionCategoryId: preview.description_category_id, typeId: preview.type_id },
    { descriptionCategoryId: 55, typeId: 66 },
  );
  const seed = appModule.collectEditCategoryPreviewSeed({
    item,
    targetStoreId: "store-b",
    taxonomyScope: "OZON:RU",
  });
  assert.deepEqual(
    { descriptionCategoryId: seed.descriptionCategoryId, typeId: seed.typeId },
    { descriptionCategoryId: "55", typeId: "66" },
  );
  const rows = appModule.collectEditVariantRows({
    item,
    sku: "shared-sku",
    title: "Shared summary product",
    price: "100",
    targetStoreId: "store-b",
    taxonomyScope: "OZON:RU",
  });
  assert.deepEqual(
    { descriptionCategoryId: rows[0].descriptionCategoryId, typeId: rows[0].typeId },
    { descriptionCategoryId: 55, typeId: 66 },
  );

  const mismatchPreview = appModule.collectEditPreviewPayload({
    item,
    sku: "shared-sku",
    title: "Shared summary product",
    price: "100",
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
  });
  assert.deepEqual(
    { descriptionCategoryId: mismatchPreview.description_category_id, typeId: mismatchPreview.type_id },
    { descriptionCategoryId: 33, typeId: 44 },
    "a mismatched non-default summary must not be reused",
  );
});

test("Collect edit draft-row preparation retains the selected non-default taxonomy", () => {
  assert.equal(typeof appModule.collectEditDraftVariantCategory, "function");
  const item = {
    ...itemWithSharedAndLegacy(),
    categoryResolution: {
      status: "MATCHED",
      taxonomyScope: "OZON:RU",
      targetDescriptionCategoryId: 55,
      targetTypeId: 66,
      method: "",
    },
  };
  const selected = appModule.collectEditDraftVariantCategory({
    item,
    row: { sku: "shared-sku", categoryResolution: item.categoryResolution },
    targetStoreId: "store-b",
    taxonomyScope: "OZON:RU",
  });
  assert.deepEqual(
    {
      descriptionCategoryId: selected.descriptionCategoryId,
      typeId: selected.typeId,
    },
    { descriptionCategoryId: 55, typeId: 66 },
  );

  const mismatched = appModule.collectEditDraftVariantCategory({
    item,
    row: { sku: "shared-sku", categoryResolution: item.categoryResolution },
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
  });
  assert.deepEqual(
    {
      descriptionCategoryId: mismatched.descriptionCategoryId,
      typeId: mismatched.typeId,
    },
    { descriptionCategoryId: 33, typeId: 44 },
  );
});

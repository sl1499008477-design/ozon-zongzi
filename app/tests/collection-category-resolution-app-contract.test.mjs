import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const appRoot = new URL("..", import.meta.url);
const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
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
  assert.match(appSource, /categoryResolutionForCollectionTarget/, "App must import and use one target-category reading path");
  assert.doesNotMatch(appSource, /\bcategoryResolutionForStore\b/, "App must not bypass the unified summary-first path");
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

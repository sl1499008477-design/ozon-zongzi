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

const recoveryManual = {
  status: "MATCHED",
  method: "MANUAL",
  taxonomyScope: "OZON:DEFAULT",
  targetDescriptionCategoryId: 333,
  targetTypeId: 444,
  target: { storeId: "store-b", descriptionCategoryId: 333, typeId: 444 },
};

const recoveryAuto = {
  status: "MATCHED",
  method: "AUTO",
  target: { storeId: "store-b", descriptionCategoryId: 555, typeId: 666 },
};

const unresolvedSharedItem = (status, listingDraft = {}) => ({
  id: `collect-${status.toLowerCase()}`,
  sku: `sku-${status.toLowerCase()}`,
  categoryResolution: { status, taxonomyScope: "OZON:DEFAULT" },
  listingDraft,
});

const categoryIds = (resolution) => ({
  descriptionCategoryId: resolution?.targetDescriptionCategoryId ?? resolution?.target?.descriptionCategoryId,
  typeId: resolution?.targetTypeId ?? resolution?.target?.typeId,
});

test("effective editor resolution lets an interactive current match recover NEEDS_REVIEW and INVALIDATED", () => {
  assert.equal(typeof appModule.collectEditEffectiveCategoryResolution, "function");
  for (const status of ["NEEDS_REVIEW", "INVALIDATED"]) {
    const item = unresolvedSharedItem(status, { categoryResolution: recoveryManual });
    const resolved = appModule.collectEditEffectiveCategoryResolution({
      item,
      itemId: item.id,
      targetStoreId: "store-b",
      taxonomyScope: "OZON:DEFAULT",
      interactivePreview: {
        itemId: item.id,
        targetStoreId: "store-b",
        taxonomyScope: "OZON:DEFAULT",
        resolution: recoveryAuto,
      },
    });
    assert.equal(resolved.method, "AUTO", status);
    assert.deepEqual(categoryIds(resolved), {
      descriptionCategoryId: 555,
      typeId: 666,
    }, status);
  }
});

test("real editor preview, seed, draft, and variants reload a scoped saved MANUAL recovery", () => {
  for (const status of ["NEEDS_REVIEW", "INVALIDATED"]) {
    const item = unresolvedSharedItem(status);
    item.listingDraft = {
      categoryResolution: { ...recoveryManual, itemId: item.id },
    };
    const preview = appModule.collectEditPreviewPayload({
      item,
      sku: item.sku,
      title: "Reloaded manual category",
      price: "100",
      targetStoreId: "store-b",
    });
    const seed = appModule.collectEditCategoryPreviewSeed({
      item,
      targetStoreId: "store-b",
      collectCandidate: true,
    });
    const rows = appModule.collectEditVariantRows({
      item,
      sku: item.sku,
      title: "Reloaded manual category",
      price: "100",
      targetStoreId: "store-b",
    });
    const draftRow = appModule.collectEditDraftVariantCategory({
      item,
      itemId: item.id,
      row: { sku: item.sku },
      targetStoreId: "store-b",
    });

    assert.deepEqual(
      { descriptionCategoryId: preview.description_category_id, typeId: preview.type_id },
      { descriptionCategoryId: 333, typeId: 444 },
      `${status} preview`,
    );
    assert.deepEqual(
      { descriptionCategoryId: seed.descriptionCategoryId, typeId: seed.typeId },
      { descriptionCategoryId: "333", typeId: "444" },
      `${status} seed`,
    );
    assert.deepEqual(
      { descriptionCategoryId: rows[0].descriptionCategoryId, typeId: rows[0].typeId },
      { descriptionCategoryId: 333, typeId: 444 },
      `${status} variants`,
    );
    assert.deepEqual(
      { descriptionCategoryId: draftRow.descriptionCategoryId, typeId: draftRow.typeId },
      { descriptionCategoryId: 333, typeId: 444 },
      `${status} draft`,
    );
    assert.equal(draftRow.categoryResolution.method, "MANUAL", `${status} draft method`);
  }
});

test("effective editor resolution keeps a valid shared MATCHED target ahead of stale preview and MANUAL", () => {
  const item = {
    id: "collect-shared-matched",
    categoryResolution: {
      status: "MATCHED",
      method: "AUTO",
      taxonomyScope: "OZON:DEFAULT",
      targetDescriptionCategoryId: 111,
      targetTypeId: 222,
    },
    listingDraft: { categoryResolution: recoveryManual },
  };
  const resolved = appModule.collectEditEffectiveCategoryResolution({
    item,
    itemId: item.id,
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
    interactivePreview: {
      itemId: item.id,
      targetStoreId: "store-b",
      taxonomyScope: "OZON:DEFAULT",
      resolution: recoveryAuto,
    },
    manualOverride: {
      itemId: item.id,
      targetStoreId: "store-b",
      taxonomyScope: "OZON:DEFAULT",
      resolution: recoveryManual,
    },
  });
  assert.equal(resolved.method, "AUTO");
  assert.deepEqual(categoryIds(resolved), {
    descriptionCategoryId: 111,
    typeId: 222,
  });
});

test("effective editor resolution isolates recovery records and retains Task 6 legacy fallback after a taxonomy mismatch", () => {
  const item = unresolvedSharedItem("NEEDS_REVIEW", {
    categoryResolution: {
      status: "MATCHED",
      method: "MANUAL",
      target: { storeId: "store-b", descriptionCategoryId: 333, typeId: 444 },
    },
  });
  const validPreview = {
    itemId: item.id,
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
    resolution: recoveryAuto,
  };
  for (const mismatch of [
    { itemId: "other-item" },
    { targetStoreId: "store-other" },
    { taxonomyScope: "OZON:RU" },
  ]) {
    const resolved = appModule.collectEditEffectiveCategoryResolution({
      item,
      itemId: item.id,
      targetStoreId: "store-b",
      taxonomyScope: "OZON:DEFAULT",
      interactivePreview: { ...validPreview, ...mismatch },
    });
    assert.equal(resolved.status, "NEEDS_REVIEW", JSON.stringify(mismatch));
  }

  const legacy = appModule.collectEditEffectiveCategoryResolution({
    item,
    itemId: item.id,
    targetStoreId: "store-b",
    taxonomyScope: "OZON:RU",
  });
  assert.equal(legacy.method, "MANUAL");
  assert.deepEqual(categoryIds(legacy), {
    descriptionCategoryId: 333,
    typeId: 444,
  });
});

test("saved and session MANUAL recoveries reject a matching scope record whose target belongs to another store", () => {
  const item = unresolvedSharedItem("NEEDS_REVIEW", {
    categoryResolution: {
      ...recoveryManual,
      target: { storeId: "store-other", descriptionCategoryId: 333, typeId: 444 },
    },
  });
  const saved = appModule.collectEditEffectiveCategoryResolution({
    item,
    itemId: item.id,
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
  });
  assert.equal(saved.status, "NEEDS_REVIEW");

  const session = appModule.collectEditEffectiveCategoryResolution({
    item: unresolvedSharedItem("INVALIDATED"),
    itemId: "collect-invalidated",
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
    manualOverride: {
      itemId: "collect-invalidated",
      targetStoreId: "store-b",
      taxonomyScope: "OZON:DEFAULT",
      resolution: {
        ...recoveryManual,
        target: { storeId: "store-other", descriptionCategoryId: 333, typeId: 444 },
      },
    },
  });
  assert.equal(session.status, "INVALIDATED");

  const savedOtherItem = appModule.collectEditEffectiveCategoryResolution({
    item: unresolvedSharedItem("NEEDS_REVIEW", {
      categoryResolution: { ...recoveryManual, itemId: "other-collect-item" },
    }),
    itemId: "collect-needs-review",
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
  });
  assert.equal(savedOtherItem.status, "NEEDS_REVIEW");
});

const previewRecoveryFixture = ({
  itemId = "collect-preview-a",
  taxonomyScope,
  responseItem = {},
} = {}) => ({
  item: {
    id: itemId,
    sku: "sku-preview-a",
    offer_id: "source-offer-a",
  },
  itemId,
  targetStoreId: "store-b",
  ...(taxonomyScope === undefined ? {} : { taxonomyScope }),
  request: {
    offerId: "listing-offer-a",
    sku: "sku-preview-a",
  },
  responseItems: [{
    offer_id: "listing-offer-a",
    sku: "sku-preview-a",
    description_category_id: 555,
    type_id: 666,
    attributes: [{ id: 4180, values: [{ value: "must not persist" }] }],
    complex_attributes: [{ id: 1, attributes: [{ id: 2 }] }],
    categoryResolution: {
      offerId: "listing-offer-a",
      status: "MATCHED",
      method: "DICTIONARY_VALUE_ID",
      source: { typeName: "untrusted source" },
      target: { storeId: "store-b", descriptionCategoryId: 555, typeId: 666 },
    },
    ...responseItem,
  }],
});

test("preview recovery accepts the real scope-less DEFAULT server contract without retaining raw preview fields", () => {
  assert.equal(typeof appModule.normalizeCollectCategoryPreviewRecovery, "function");
  const recovery = appModule.normalizeCollectCategoryPreviewRecovery(previewRecoveryFixture());
  assert.deepEqual(recovery, {
    itemId: "collect-preview-a",
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
    resolution: {
      status: "MATCHED",
      method: "DICTIONARY_VALUE_ID",
      taxonomyScope: "OZON:DEFAULT",
      targetDescriptionCategoryId: 555,
      targetTypeId: 666,
      target: { storeId: "store-b", descriptionCategoryId: 555, typeId: 666 },
    },
  });
  assert.equal("attributes" in recovery, false);
  assert.equal("complex_attributes" in recovery, false);
  assert.equal("source" in recovery.resolution, false);

  const item = unresolvedSharedItem("NEEDS_REVIEW");
  const currentRecovery = { ...recovery, itemId: item.id };
  const resolved = appModule.collectEditEffectiveCategoryResolution({
    item,
    itemId: item.id,
    targetStoreId: "store-b",
    taxonomyScope: "OZON:DEFAULT",
    interactivePreview: currentRecovery,
  });
  const draft = appModule.collectEditDraftVariantCategory({
    item,
    itemId: item.id,
    row: { sku: item.sku },
    targetStoreId: "store-b",
    interactivePreview: currentRecovery,
  });
  assert.deepEqual(categoryIds(resolved), { descriptionCategoryId: 555, typeId: 666 });
  assert.deepEqual(
    { descriptionCategoryId: draft.descriptionCategoryId, typeId: draft.typeId },
    { descriptionCategoryId: 555, typeId: 666 },
  );
});

test("preview recovery rejects the real scope-less DEFAULT server contract for an RU request", () => {
  assert.equal(
    appModule.normalizeCollectCategoryPreviewRecovery(previewRecoveryFixture({
      taxonomyScope: "OZON:RU",
    })),
    null,
  );
});

test("preview recovery accepts an explicit RU response only for the exact RU request", () => {
  const recovery = appModule.normalizeCollectCategoryPreviewRecovery(previewRecoveryFixture({
    taxonomyScope: "OZON:RU",
    responseItem: {
      categoryResolution: {
        offerId: "listing-offer-a",
        status: "MATCHED",
        method: "DICTIONARY_VALUE_ID",
        taxonomyScope: "OZON:RU",
        target: { storeId: "store-b", descriptionCategoryId: 555, typeId: 666 },
      },
    },
  }));
  assert.deepEqual({
    taxonomyScope: recovery?.taxonomyScope,
    resolutionTaxonomyScope: recovery?.resolution?.taxonomyScope,
    descriptionCategoryId: recovery?.resolution?.targetDescriptionCategoryId,
    typeId: recovery?.resolution?.targetTypeId,
  }, {
    taxonomyScope: "OZON:RU",
    resolutionTaxonomyScope: "OZON:RU",
    descriptionCategoryId: 555,
    typeId: 666,
  });
});

test("preview recovery rejects an explicit response scope that mismatches the RU request", () => {
  assert.equal(
    appModule.normalizeCollectCategoryPreviewRecovery(previewRecoveryFixture({
      taxonomyScope: "OZON:RU",
      responseItem: {
        categoryResolution: {
          offerId: "listing-offer-a",
          status: "MATCHED",
          method: "DICTIONARY_VALUE_ID",
          taxonomyScope: "OZON:DEFAULT",
          target: { storeId: "store-b", descriptionCategoryId: 555, typeId: 666 },
        },
      },
    })),
    null,
  );
});

test("preview recovery rejects an explicitly present empty response scope", () => {
  assert.equal(
    appModule.normalizeCollectCategoryPreviewRecovery(previewRecoveryFixture({
      responseItem: {
        categoryResolution: {
          offerId: "listing-offer-a",
          status: "MATCHED",
          method: "DICTIONARY_VALUE_ID",
          taxonomyScope: "",
          target: { storeId: "store-b", descriptionCategoryId: 555, typeId: 666 },
        },
      },
    })),
    null,
  );
});

test("preview recovery rejects mismatched identity, store, taxonomy, status, and target IDs", () => {
  for (const responseItem of [
    { offer_id: "other-offer" },
    { sku: "other-sku" },
    { collectItemId: "other-collect-item" },
    { categoryResolution: { offerId: "listing-offer-a", status: "MATCHED", method: "DICTIONARY_VALUE_ID", target: { storeId: "store-other", descriptionCategoryId: 555, typeId: 666 } } },
    { categoryResolution: { offerId: "listing-offer-a", status: "MATCHED", method: "DICTIONARY_VALUE_ID", taxonomyScope: "OZON:RU", target: { storeId: "store-b", descriptionCategoryId: 555, typeId: 666 } } },
    { description_category_id: 0 },
    { type_id: 0 },
    { categoryResolution: { offerId: "listing-offer-a", status: "INVALIDATED", method: "DICTIONARY_VALUE_ID", target: { storeId: "store-b", descriptionCategoryId: 555, typeId: 666 } } },
  ]) {
    assert.equal(
      appModule.normalizeCollectCategoryPreviewRecovery(previewRecoveryFixture({ responseItem })),
      null,
      JSON.stringify(responseItem),
    );
  }
});

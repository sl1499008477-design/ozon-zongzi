import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

function frozenConfig() {
  return normalizeAndHashAutoListingConfig({
    targetStoreId: "store-1",
    targetWarehouseId: "warehouse-1",
    stock: 5,
  });
}

function sourceCapture(productMeasurements = {}) {
  return buildAutoListingSourceSnapshot({
    accountId: "account-1",
    sourceType: "COLLECT_BOX",
    sourceRecordId: "collect-1",
    sourceVersion: "1",
    rawResponseRef: "raw-1",
    targetStoreId: "store-1",
    targetStoreCurrency: "RUB",
    productDraft: { id: "draft-1", version: 1 },
    categoryEvidence: {
      id: "category-evidence-1",
      accountId: "account-1",
      sourceDescriptionCategoryId: 123,
      sourceTypeId: 456,
      taxonomyScope: "OZON:DEFAULT",
    },
    sharedCategory: {
      id: "shared-category-1",
      accountId: "account-1",
      version: 1,
      evidenceId: "category-evidence-1",
      status: "ACTIVE",
      source: "SOURCE_DIRECT",
      sourceDescriptionCategoryId: 123,
      sourceTypeId: 456,
      currentDescriptionCategoryId: 123,
      currentTypeId: 456,
      taxonomyScope: "OZON:DEFAULT",
      taxonomyFingerprint: null,
    },
    collectItem: {
      id: "collect-1",
      accountId: "account-1",
      sku: "sku-1",
      listingDraft: {
        sku: "sku-1",
        offerId: "offer-1",
        title: "Product 1",
        descriptionCategoryId: "123",
        typeId: "456",
        categoryResolution: {
          status: "MATCHED",
          method: "taxonomy",
          target: { storeId: "store-1", descriptionCategoryId: "123", typeId: "456" },
          source: { path: ["root"] },
        },
        attributes: [],
        logistics: {},
        productMeasurements,
        blackKopecks: "10000",
        greenKopecks: "8000",
        currency: "RUB",
        images: [],
        variants: [{ sku: "sku-1", offerId: "offer-1" }],
      },
    },
  });
}

test("requested specification image without trusted dimensions reduces only that role", () => {
  const frozen = frozenConfig();
  const result = deriveEffectiveAutoListingImageConfig({
    configSnapshot: frozen.config,
    configHash: frozen.configHash,
    sourceCapture: sourceCapture(),
  });
  assert.deepEqual(result.roles, {
    main: 1,
    sellingPoint: 3,
    detail: 1,
    scene: 1,
    specification: 0,
    infographic: 1,
  });
  assert.equal(result.total, 7);
  assert.deepEqual(result.reasonCodes, ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
});

test("valid effective image configuration preserves exact counts in a recursively frozen value", () => {
  const frozen = frozenConfig();
  const result = deriveEffectiveAutoListingImageConfig({
    configSnapshot: frozen.config,
    configHash: frozen.configHash,
    sourceCapture: sourceCapture({ reliable: true, length: 28, unit: "cm", source: "manufacturer" }),
  });
  assert.deepEqual(result.roles, {
    main: 1,
    sellingPoint: 3,
    detail: 1,
    scene: 1,
    specification: 1,
    infographic: 1,
  });
  assert.equal(result.total, 8);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.roles), true);
  assert.equal(Object.isFrozen(result.reasonCodes), true);
});

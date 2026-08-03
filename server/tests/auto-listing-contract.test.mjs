import assert from "node:assert/strict";
import test from "node:test";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import {
  AUTO_LISTING_IMAGE_ROLES,
  AUTO_LISTING_ITEM_STATUSES,
  normalizeAutoListingConfig,
} from "../auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";

const baseConfig = (overrides = {}) => ({
  targetStoreId: "store-1",
  targetWarehouseId: "warehouse-1",
  stock: 12,
  ...overrides,
});

const expectConfigError = (input, code) => {
  assert.throws(
    () => normalizeAutoListingConfig(input),
    (error) => error?.code === code,
  );
};

const verifiedSnapshot = (productMeasurements, logistics = {}) => buildAutoListingSourceSnapshot({
  accountId: "account-1",
  sourceType: "COLLECT_BOX",
  sourceRecordId: "collect-1",
  sourceVersion: "1",
  rawResponseRef: "raw-1",
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
      logistics,
      productMeasurements,
      blackKopecks: "10000",
      greenKopecks: "8000",
      currency: "RUB",
      images: [],
      variants: [{ sku: "sku-1", offerId: "offer-1" }],
    },
  },
});

test("freezes the ordinary user defaults into a hashable JSON contract", () => {
  assert.deepEqual(normalizeAutoListingConfig(baseConfig()), {
    targetStoreId: "store-1",
    targetWarehouseId: "warehouse-1",
    stock: 12,
    priceAdjustmentKopecks: "0",
    image: {
      ratio: "3:4",
      resolution: "1K",
      quality: "Medium",
      language: "ru",
      roles: {
        main: 1,
        sellingPoint: 3,
        detail: 1,
        scene: 1,
        specification: 1,
        infographic: 1,
      },
      total: 8,
    },
  });
});

test("allows the declared image option values and derives total from role counts", () => {
  const normalized = normalizeAutoListingConfig(baseConfig({
    priceAdjustmentKopecks: "+125",
    image: {
      ratio: "16:9",
      resolution: "4K",
      quality: "Ultra",
      language: "ru",
      total: 13,
      roles: {
        main: 1,
        sellingPoint: 5,
        detail: 2,
        scene: 2,
        specification: 1,
        infographic: 2,
      },
    },
  }));

  assert.equal(normalized.priceAdjustmentKopecks, "125");
  assert.equal(normalized.image.total, 13);
});

test("removes specification images when reliable product dimensions are absent", () => {
  const frozen = normalizeAutoListingConfig(baseConfig());
  const effective = (productMeasurements, logistics = {}) => deriveEffectiveAutoListingImageConfig(frozen, {
    ...verifiedSnapshot(productMeasurements, logistics),
  });
  assert.deepEqual(effective({ reliable: true, length: 28, unit: "cm", source: "manufacturer" }), {
    ratio: "3:4",
    resolution: "1K",
    quality: "Medium",
    language: "ru",
    roles: {
      main: 1,
      sellingPoint: 3,
      detail: 1,
      scene: 1,
      specification: 1,
      infographic: 1,
    },
    total: 8,
    reasonCodes: [],
  });
  for (const measurements of [
    {},
    { reliable: false, length: 28, unit: "cm", source: "manufacturer" },
    { reliable: true, length: 0, unit: "cm", source: "manufacturer" },
    { reliable: true, length: "28", unit: "cm", source: "manufacturer" },
    { reliable: true, length: 28, unit: "", source: "manufacturer" },
    { reliable: true, length: 28, unit: "cm", source: "" },
  ]) {
    assert.deepEqual(effective(measurements).roles.specification, 0);
    assert.deepEqual(effective(measurements).total, 7);
    assert.deepEqual(effective(measurements).reasonCodes, ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
  }
  assert.equal(effective({}, { length: 999, unit: "cm", source: "warehouse" }).roles.specification, 0);
  expectConfigError(baseConfig({ image: { total: 7 } }), "AUTO_LISTING_CONFIG_INVALID");
  assert.throws(
    () => deriveEffectiveAutoListingImageConfig(frozen, { productMeasurements: { reliable: true, length: 28, unit: "cm", source: "forged" } }),
    (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID",
  );
});

test("keeps the requested specification count frozen independently of source evidence", () => {
  const normalized = normalizeAutoListingConfig(baseConfig({ image: { roles: { specification: 0 } } }));
  assert.equal(normalized.image.roles.specification, 0);
  assert.equal(normalized.image.total, 7);
});

test("rejects unsupported image options, role ranges, and derived totals outside 6 through 13", () => {
  expectConfigError(baseConfig({ image: { ratio: "4:4" } }), "AUTO_LISTING_CONFIG_INVALID");
  expectConfigError(baseConfig({ image: { resolution: "8K" } }), "AUTO_LISTING_CONFIG_INVALID");
  expectConfigError(baseConfig({ image: { quality: "Maximum" } }), "AUTO_LISTING_CONFIG_INVALID");
  expectConfigError(baseConfig({ image: { language: "en" } }), "AUTO_LISTING_CONFIG_INVALID");
  expectConfigError(baseConfig({ image: { roles: { main: 2 } } }), "AUTO_LISTING_CONFIG_INVALID");
  expectConfigError(baseConfig({ image: { roles: { sellingPoint: 1 } } }), "AUTO_LISTING_CONFIG_INVALID");
});

test("requires identifiers and validates integer stock and signed integer adjustment", () => {
  expectConfigError(baseConfig({ targetStoreId: "" }), "AUTO_LISTING_CONFIG_INVALID");
  expectConfigError(baseConfig({ targetWarehouseId: "" }), "AUTO_LISTING_CONFIG_INVALID");
  expectConfigError(baseConfig({ stock: 1.5 }), "AUTO_LISTING_CONFIG_INVALID");
  expectConfigError(baseConfig({ stock: 0 }), "AUTO_LISTING_CONFIG_INVALID");
  expectConfigError(baseConfig({ priceAdjustmentKopecks: 500 }), "AUTO_LISTING_CONFIG_INVALID");
  expectConfigError(baseConfig({ priceAdjustmentKopecks: "1.5" }), "AUTO_LISTING_CONFIG_INVALID");
});

test("rejects authority-bearing client configuration fields", () => {
  for (const field of [
    "accountId",
    "strategyVersionId",
    "modelCredentials",
    "modelKey",
    "uploadMode",
    "hasReliableProductDimensions",
  ]) {
    expectConfigError(baseConfig({ [field]: "client-controlled" }), "AUTO_LISTING_CONFIG_FORBIDDEN_FIELD");
  }
});

test("rejects authority-bearing fields in nested objects and arrays", () => {
  expectConfigError(baseConfig({
    metadata: { strategyVersionId: "strategy-client-controlled" },
  }), "AUTO_LISTING_CONFIG_FORBIDDEN_FIELD");
  expectConfigError(baseConfig({
    metadata: [{ uploadMode: "DIRECT" }],
  }), "AUTO_LISTING_CONFIG_FORBIDDEN_FIELD");
});

test("exports the closed image-role and item-status vocabularies", () => {
  assert.deepEqual(AUTO_LISTING_IMAGE_ROLES, [
    "main",
    "sellingPoint",
    "detail",
    "scene",
    "specification",
    "infographic",
  ]);
  assert.deepEqual(AUTO_LISTING_ITEM_STATUSES, [
    "CREATED",
    "SOURCE_READY",
    "PLANNING",
    "GENERATING",
    "READY_FOR_REVIEW",
    "UPLOAD_QUEUED",
    "UPLOADING",
    "SUCCEEDED",
    "RETRYABLE_ERROR",
    "BLOCKED",
    "CANCELLED",
  ]);
});

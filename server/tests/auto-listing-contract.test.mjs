import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_LISTING_IMAGE_ROLES,
  AUTO_LISTING_ITEM_STATUSES,
  normalizeAutoListingConfig,
} from "../auto-listing-contract.mjs";

const baseConfig = (overrides = {}) => ({
  targetStoreId: "store-1",
  targetWarehouseId: "warehouse-1",
  stock: 12,
  hasReliableProductDimensions: true,
  ...overrides,
});

const expectConfigError = (input, code) => {
  assert.throws(
    () => normalizeAutoListingConfig(input),
    (error) => error?.code === code,
  );
};

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
    reasonCodes: [],
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
      total: 999,
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
  assert.deepEqual(normalizeAutoListingConfig(baseConfig({
    hasReliableProductDimensions: false,
    image: { roles: { specification: 1 } },
  })).image, {
    ratio: "3:4",
    resolution: "1K",
    quality: "Medium",
    language: "ru",
    roles: {
      main: 1,
      sellingPoint: 3,
      detail: 1,
      scene: 1,
      specification: 0,
      infographic: 1,
    },
    total: 7,
  });
  assert.deepEqual(normalizeAutoListingConfig(baseConfig({
    hasReliableProductDimensions: false,
  })).reasonCodes, ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
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
  ]) {
    expectConfigError(baseConfig({ [field]: "client-controlled" }), "AUTO_LISTING_CONFIG_FORBIDDEN_FIELD");
  }
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

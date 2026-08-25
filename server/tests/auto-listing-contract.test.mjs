import assert from "node:assert/strict";
import test from "node:test";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import {
  AUTO_LISTING_IMAGE_ROLES,
  AUTO_LISTING_ITEM_STATUSES,
  normalizeAndHashAutoListingConfig,
  normalizeAutoListingConfig,
  verifyAutoListingFrozenConfig,
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

test("historical frozen config remains byte-shape compatible while new multiplier is normalized", () => {
  const historical = baseConfig();
  const frozen = normalizeAndHashAutoListingConfig(historical);
  assert.equal(Object.hasOwn(frozen.config, "priceMultiplierMicros"), false);
  assert.deepEqual(verifyAutoListingFrozenConfig(frozen.config, frozen.configHash).config, frozen.config);
  assert.equal(normalizeAutoListingConfig({ ...historical, priceMultiplierMicros: "+1250000" }).priceMultiplierMicros, "1250000");
  for (const value of ["0", "-1", "1.5", 1000000]) {
    expectConfigError({ ...historical, priceMultiplierMicros: value }, "AUTO_LISTING_CONFIG_INVALID");
  }
});

test("preserves trusted counts and reduces missing reliable product dimensions", () => {
  const frozen = normalizeAndHashAutoListingConfig(baseConfig());
  const effective = (productMeasurements, logistics = {}) => deriveEffectiveAutoListingImageConfig({
    configSnapshot: frozen.config,
    configHash: frozen.configHash,
    sourceCapture: verifiedSnapshot(productMeasurements, logistics),
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
    const reduced = effective(measurements);
    assert.equal(reduced.roles.specification, 0);
    assert.equal(reduced.total, 7);
    assert.deepEqual(reduced.reasonCodes, ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
  }
  const logisticsOnly = effective({}, { length: 999, unit: "cm", source: "warehouse" });
  assert.equal(logisticsOnly.roles.specification, 0);
  assert.equal(logisticsOnly.total, 7);
  assert.deepEqual(logisticsOnly.reasonCodes, ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
  assert.equal(effective({ reliable: true, lengthMm: 280, unit: "mm", source: "manufacturer" }).roles.specification, 1);
  assert.equal(effective({ reliable: true, productDiameter: 28, unit: "cm", source: "manufacturer" }).roles.specification, 1);
  const unknownMeasurementShape = effective({
    reliable: true,
    foo: 28,
    confidence: 0.99,
    sampleCount: 1,
    unit: "cm",
    source: "manufacturer",
  });
  assert.equal(unknownMeasurementShape.roles.specification, 0);
  assert.equal(unknownMeasurementShape.total, 7);
  assert.deepEqual(unknownMeasurementShape.reasonCodes, ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
  expectConfigError(baseConfig({ image: { total: 7 } }), "AUTO_LISTING_CONFIG_INVALID");
  assert.throws(
    () => deriveEffectiveAutoListingImageConfig({
      configSnapshot: frozen.config,
      configHash: frozen.configHash,
      sourceCapture: { productMeasurements: { reliable: true, length: 28, unit: "cm", source: "forged" } },
    }),
    (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID",
  );
  assert.throws(
    () => deriveEffectiveAutoListingImageConfig({
      configSnapshot: frozen.config,
      configHash: undefined,
      sourceCapture: verifiedSnapshot({ reliable: true, length: 28, unit: "cm", source: "manufacturer" }),
    }),
    (error) => error?.code === "AUTO_LISTING_CONFIG_INVALID",
  );
});

test("requires an exact SHA-256 hash for every frozen config verification", () => {
  const frozen = normalizeAndHashAutoListingConfig(baseConfig());
  assert.deepEqual(verifyAutoListingFrozenConfig(frozen.config, frozen.configHash), frozen);
  for (const invalidHash of [undefined, "", "f".repeat(63), "z".repeat(64), "0".repeat(64)]) {
    assert.throws(
      () => verifyAutoListingFrozenConfig(frozen.config, invalidHash),
      (error) => error?.code === "AUTO_LISTING_CONFIG_INVALID",
    );
  }
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

test("limits stock to PostgreSQL INTEGER and adjustment to PostgreSQL signed BIGINT", () => {
  assert.equal(normalizeAutoListingConfig(baseConfig({ stock: 2_147_483_647 })).stock, 2_147_483_647);
  for (const stock of [2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    expectConfigError(baseConfig({ stock }), "AUTO_LISTING_CONFIG_INVALID");
  }
  assert.equal(normalizeAutoListingConfig(baseConfig({ priceAdjustmentKopecks: "9223372036854775807" })).priceAdjustmentKopecks, "9223372036854775807");
  assert.equal(normalizeAutoListingConfig(baseConfig({ priceAdjustmentKopecks: "-9223372036854775808" })).priceAdjustmentKopecks, "-9223372036854775808");
  for (const value of [
    "9223372036854775808", "-9223372036854775809", `1${"0".repeat(10_000)}`,
  ]) {
    expectConfigError(baseConfig({ priceAdjustmentKopecks: value }), "AUTO_LISTING_CONFIG_INVALID");
  }
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

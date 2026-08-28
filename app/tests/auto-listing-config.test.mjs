import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_LISTING_IMAGE_DEFAULTS,
  amountToMinorUnits,
  autoListingCurrencyPresentation,
  autoListingExcelSerializedBodyLimit,
  autoListingTaskErrorMessage,
  autoListingWarehouseOptions,
  deriveAutoListingConfig,
  kopecksToRubles,
  microsToMultiplier,
  multiplierToMicros,
  previewAutoListingPrice,
  readExcelFileAsBase64,
  shouldResetAutoListingAdjustment,
} from "../src/auto-listing-config.js";
import { normalizeAutoListingConfig } from "../../server/auto-listing-contract.mjs";

test("Excel JSON transport allowance follows the backend workbook byte limit including base64 overhead", () => {
  assert.equal(autoListingExcelSerializedBodyLimit(4_194_304), Math.ceil(4_194_304 / 3) * 4 + 256 * 1024);
  assert.throws(() => autoListingExcelSerializedBodyLimit(0), { code: "AUTO_LISTING_EXCEL_FILE_INVALID" });
});

test("formats signed kopecks for the preference form without floating-point conversion", () => {
  assert.equal(kopecksToRubles("0"), "0");
  assert.equal(kopecksToRubles("105"), "1.05");
  assert.equal(kopecksToRubles("-105"), "-1.05");
  assert.equal(kopecksToRubles("900719925474099301"), "9007199254740993.01");
  assert.throws(() => kopecksToRubles("1.5"), { code: "AUTO_LISTING_CONFIG_INVALID" });
  assert.equal(amountToMinorUnits("1.05"), "105");
  assert.equal(amountToMinorUnits("-2.5"), "-250");
  assert.equal(amountToMinorUnits("9007199254740993.01"), "900719925474099301");
  assert.throws(() => amountToMinorUnits("1.005"), { code: "AUTO_LISTING_PRICE_ADJUSTMENT_INVALID" });
});

test("presents only supported target-store currencies and resets adjustments only across currencies", () => {
  assert.deepEqual(autoListingCurrencyPresentation("CNY"), {
    currency: "CNY", name: "人民币", symbol: "¥",
  });
  assert.deepEqual(autoListingCurrencyPresentation("RUB"), {
    currency: "RUB", name: "卢布", symbol: "₽",
  });
  assert.throws(() => autoListingCurrencyPresentation("USD"), {
    code: "PRICE_CURRENCY_UNSUPPORTED",
  });
  assert.equal(shouldResetAutoListingAdjustment("RUB", "CNY"), true);
  assert.equal(shouldResetAutoListingAdjustment("CNY", "CNY"), false);
  assert.equal(shouldResetAutoListingAdjustment(null, "CNY"), false);
});

test("uses the approved ordinary-user defaults and derives total image count", () => {
  const config = deriveAutoListingConfig({
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    stock: 5,
    priceAdjustmentKopecks: "0",
  });

  assert.deepEqual(config.image, AUTO_LISTING_IMAGE_DEFAULTS);
  assert.equal(config.image.total, 6);
  assert.deepEqual(config.image.roles, {
    main: 1,
    sellingPoint: 2,
    detail: 1,
    scene: 1,
    specification: 0,
    infographic: 1,
  });
  assert.equal(config.image.ratio, "3:4");
  assert.equal(config.image.language, "ru");
  assert.equal(config.image.resolution, "1K");
  assert.equal(config.image.quality, "Medium");
  assert.equal("strategy" in config, false);
  assert.equal("model" in config, false);
  assert.equal("apiKey" in config, false);
  assert.equal(config.brandMode, "FORCE_NO_BRAND");
  assert.equal(config.priceMultiplierMicros, "1000000");
});

test("the brand toggle freezes only the two approved upload modes", () => {
  const base = {
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 5,
  };
  assert.equal(deriveAutoListingConfig({ ...base, brandMode: "PREFER_SOURCE" }).brandMode, "PREFER_SOURCE");
  assert.equal(deriveAutoListingConfig({ ...base, brandMode: "FORCE_NO_BRAND" }).brandMode, "FORCE_NO_BRAND");
  assert.throws(() => deriveAutoListingConfig({ ...base, brandMode: "RAW_TEXT" }), {
    code: "AUTO_LISTING_CONFIG_INVALID",
  });
});

test("the category-strategy switch defaults on and freezes only a boolean choice", () => {
  const base = {
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    stock: 5,
  };
  const enabled = deriveAutoListingConfig(base);
  const disabled = deriveAutoListingConfig({ ...base, useCategoryStrategy: false });

  assert.equal(enabled.useCategoryStrategy, true);
  assert.equal(disabled.useCategoryStrategy, false);
  assert.deepEqual(normalizeAutoListingConfig(enabled), enabled);
  assert.deepEqual(normalizeAutoListingConfig(disabled), disabled);
  assert.throws(() => deriveAutoListingConfig({ ...base, useCategoryStrategy: "false" }), {
    code: "AUTO_LISTING_CONFIG_INVALID",
  });
});

test("removes the product-size image when reliable product dimensions are unavailable", () => {
  const config = deriveAutoListingConfig({
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    stock: 1,
    image: { roles: { specification: 1 } },
  }, { hasReliableProductDimensions: false });

  assert.equal(config.image.roles.specification, 0);
  assert.equal(config.image.total, 6);
  assert.deepEqual(normalizeAutoListingConfig(config), config);
});

test("accepts only the approved image ranges and a total from 6 through 13", () => {
  const maximum = deriveAutoListingConfig({
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    stock: 3,
    image: {
      ratio: "16:9",
      resolution: "4K",
      quality: "Ultra",
      language: "ru",
      roles: { main: 1, sellingPoint: 5, detail: 2, scene: 2, specification: 1, infographic: 2 },
    },
  });
  assert.equal(maximum.image.total, 13);

  for (const image of [
    { ratio: "5:4" },
    { resolution: "8K" },
    { quality: "Best" },
    { language: "zh" },
    { roles: { main: 2 } },
    { roles: { sellingPoint: 1 } },
    { roles: { detail: 3 } },
  ]) {
    assert.throws(() => deriveAutoListingConfig({
      targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 1, image,
    }), { code: "AUTO_LISTING_CONFIG_INVALID" });
  }
});

test("signed price adjustment stays an integer kopeck string", () => {
  assert.equal(deriveAutoListingConfig({
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 1,
    priceAdjustmentKopecks: " +00100 ",
  }).priceAdjustmentKopecks, "100");
  assert.equal(deriveAutoListingConfig({
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 1,
    priceAdjustmentKopecks: "-250",
  }).priceAdjustmentKopecks, "-250");
  assert.throws(() => deriveAutoListingConfig({
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 1,
    priceAdjustmentKopecks: "1.5",
  }), { code: "AUTO_LISTING_CONFIG_INVALID" });
});

test("price preview mirrors the approved two-branch formula with integer rounding", () => {
  assert.deepEqual(previewAutoListingPrice({
    currency: "RUB", blackKopecks: "10000", greenKopecks: "8000", adjustmentKopecks: "100",
  }), {
    currency: "RUB",
    branch: "BLACK_GTE_80",
    realPriceKopecks: "14500",
    adjustmentKopecks: "100",
    preMultiplierPriceKopecks: "14600",
    priceMultiplierMicros: "1000000",
    finalPriceKopecks: "14600",
    finalPriceText: "146.00 ₽",
  });
  assert.equal(previewAutoListingPrice({
    currency: "RUB", blackKopecks: "7000", adjustmentKopecks: "0",
  }).realPriceKopecks, "6533");
  assert.throws(() => previewAutoListingPrice({
    currency: "RUB", blackKopecks: "100", adjustmentKopecks: "-100",
  }), { code: "PRICE_FINAL_NOT_POSITIVE" });
  assert.equal(previewAutoListingPrice({
    currency: "CNY", blackKopecks: "10000", greenKopecks: "8000", adjustmentKopecks: "0",
  }).finalPriceText, "¥145.00");
  assert.throws(() => previewAutoListingPrice({
    currency: "USD", blackKopecks: "10000", greenKopecks: "8000", adjustmentKopecks: "0",
  }), { code: "PRICE_CURRENCY_UNSUPPORTED" });
});

test("warehouse choices trust only the exact backend FBS or pending RFBS contract and clear stale store selections", () => {
  const warehouses = [
    { id: "local-1", warehouse_id: "101", storeId: "store-a", name: "Active", listingEligibility: {
      eligible: true, code: "ELIGIBLE_ACTIVE_FBS", fulfillmentType: "FBS", evidenceRequired: false,
    } },
    { id: "local-rfbs", warehouse_id: "1001", storeId: "store-a", name: "CEL-测试", listingEligibility: {
      eligible: false, code: "RFBS_VALIDATION_REQUIRED", fulfillmentType: "RFBS", evidenceRequired: true,
    } },
    { id: "local-2", warehouse_id: "102", storeId: "store-a", name: "Archived FBS", listingEligibility: { eligible: false } },
    { id: "local-3", warehouse_id: "103", storeId: "store-b", name: "Other", listingEligibility: {
      eligible: true, code: "ELIGIBLE_ACTIVE_FBS", fulfillmentType: "FBS", evidenceRequired: false,
    } },
    { id: "local-4", warehouse_id: "104", storeId: "store-a", name: "Looks active by name" },
  ];
  const result = autoListingWarehouseOptions({
    warehouses,
    targetStoreId: "store-a",
    selectedWarehouseId: "103",
  });

  assert.deepEqual(result.options, [
    {
      value: "local-1", label: "Active（FBS）", fulfillmentType: "FBS", evidenceRequired: false,
      statusLabel: "已验证",
    },
    {
      value: "local-rfbs", label: "CEL-测试（RFBS · 创建任务时验证）", fulfillmentType: "RFBS", evidenceRequired: true,
      statusLabel: "创建任务时验证",
    },
  ]);
  assert.equal(result.selectedWarehouseId, "");
});

test("warehouse choices reject RFBS lookalikes, unsupported types, and malformed backend eligibility", () => {
  const pending = {
    eligible: false, code: "RFBS_VALIDATION_REQUIRED", fulfillmentType: "RFBS", evidenceRequired: true,
  };
  const result = autoListingWarehouseOptions({
    targetStoreId: "store-a",
    selectedWarehouseId: "local-valid",
    warehouses: [
      { id: "local-valid", warehouse_id: "1001", storeId: "store-a", name: "Valid", listingEligibility: pending },
      { id: "local-wrong-code", warehouse_id: "1002", storeId: "store-a", name: "Wrong code", listingEligibility: { ...pending, code: "NO_ACTIVE_PRODUCT_ASSOCIATION" } },
      { id: "local-wrong-type", warehouse_id: "1003", storeId: "store-a", name: "Wrong type", listingEligibility: { ...pending, fulfillmentType: "FBO" } },
      { id: "local-wrong-evidence", warehouse_id: "1004", storeId: "store-a", name: "Wrong evidence", listingEligibility: { ...pending, evidenceRequired: false } },
      { id: "local-lookalike", warehouse_id: "1005", storeId: "store-a", name: "Pretends by local field", warehouse_type: "RFBS", listingEligibility: { eligible: false } },
      { id: "local-other-store", warehouse_id: "1006", storeId: "store-b", name: "Other store", listingEligibility: pending },
      { id: "local-fbo", warehouse_id: "1007", storeId: "store-a", name: "FBO", listingEligibility: { eligible: false, code: "UNSUPPORTED_FULFILLMENT_TYPE", fulfillmentType: "FBO", evidenceRequired: false } },
      { warehouse_id: "1008", storeId: "store-a", name: "Missing local identity", listingEligibility: pending },
      { id: "local-missing-platform", storeId: "store-a", name: "Missing platform identity", listingEligibility: pending },
    ],
  });
  assert.deepEqual(result.options.map(({ value }) => value), ["local-valid"]);
  assert.equal(result.selectedWarehouseId, "local-valid");
});

test("task creation explains missing published strategy and REVIEW upload policy", () => {
  assert.equal(autoListingTaskErrorMessage({ code: "AUTO_LISTING_STRATEGY_NOT_PUBLISHED" }),
    "尚未发布自动上架内容策略，请先由管理员发布策略");
  assert.equal(autoListingTaskErrorMessage({ code: "AUTO_LISTING_UPLOAD_POLICY_NOT_PUBLISHED" }),
    "尚未发布自动上架 REVIEW 上传策略，请先由管理员发布策略");
});

test("task creation explains source version conflicts without exposing backend text", () => {
  assert.equal(
    autoListingTaskErrorMessage({
      code: "AUTO_LISTING_SOURCE_VERSION_CONFLICT",
      message: "untrusted raw backend text",
    }),
    "来源资料版本已变化，请刷新后重试",
  );
});

test("task creation explains an unresolved Ozon category dictionary without raw backend text", () => {
  assert.equal(autoListingTaskErrorMessage({
    code: "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED",
    message: "raw brand dictionary secret",
  }), "商品品牌或类目选项未在 Ozon 当前字典中登记，请先补全资料");
});

test("task creation explains unresolved missing-brand fallback without raw backend text", () => {
  assert.equal(autoListingTaskErrorMessage({
    code: "AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED",
    message: "raw missing-brand dictionary secret",
  }), "Ozon 当前类目无法唯一确认“Нет бренда（无品牌）”字典值；请开启“使用采集品牌”并确认商品有品牌，或稍后重试");
});

test("reads a bounded workbook once and returns only request-safe metadata", async () => {
  const bytes = Uint8Array.from([0, 1, 2, 3]);
  let reads = 0;
  const result = await readExcelFileAsBase64({
    name: "skus.xlsx",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: bytes.byteLength,
    async arrayBuffer() {
      reads += 1;
      return bytes.buffer;
    },
  }, { maxBytes: 4 });
  assert.deepEqual(result, {
    name: "skus.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    dataBase64: "AAECAw==",
    sizeBytes: 4,
    contentSha256: "054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8",
  });
  assert.equal(reads, 1);

  await assert.rejects(readExcelFileAsBase64({
    name: "too-large.xlsx", type: result.contentType, size: 5,
    arrayBuffer: async () => assert.fail("oversized files must be rejected before reading"),
  }, { maxBytes: 4 }), { code: "AUTO_LISTING_EXCEL_FILE_TOO_LARGE" });
});

test("converts price multipliers exactly without floating point", () => {
  assert.equal(multiplierToMicros("1"), "1000000");
  assert.equal(multiplierToMicros("1.25"), "1250000");
  assert.equal(multiplierToMicros("0.000001"), "1");
  assert.equal(multiplierToMicros("9223372036854.775807"), "9223372036854775807");
  assert.equal(microsToMultiplier("1250000"), "1.25");
  assert.equal(microsToMultiplier("1"), "0.000001");
  for (const value of ["0", "-1", "1.0000001", "1e2", "", "9223372036854.775808"]) {
    assert.throws(() => multiplierToMicros(value), { code: "AUTO_LISTING_PRICE_MULTIPLIER_INVALID" });
  }
  for (const value of ["0", "-1", "1.5", "9223372036854775808"]) {
    assert.throws(() => microsToMultiplier(value), { code: "AUTO_LISTING_PRICE_MULTIPLIER_INVALID" });
  }
});

test("config sends multiplier micros and preview uses backend ordering and half-up rounding", () => {
  const config = deriveAutoListingConfig({
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 1,
    priceMultiplier: "1.25",
  });
  assert.equal(config.priceMultiplierMicros, "1250000");
  assert.deepEqual(previewAutoListingPrice({
    currency: "RUB", blackKopecks: "10000", greenKopecks: "8000",
    adjustmentKopecks: "100", priceMultiplierMicros: "1250000",
  }), {
    currency: "RUB", branch: "BLACK_GTE_80", realPriceKopecks: "14500",
    adjustmentKopecks: "100", preMultiplierPriceKopecks: "14600",
    priceMultiplierMicros: "1250000", finalPriceKopecks: "18250", finalPriceText: "182.50 ₽",
  });
  assert.equal(previewAutoListingPrice({
    currency: "RUB", blackKopecks: "500000", greenKopecks: "500000", priceMultiplierMicros: "1",
  }).finalPriceKopecks, "1");
});

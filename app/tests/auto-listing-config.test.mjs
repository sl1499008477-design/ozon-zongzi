import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_LISTING_IMAGE_DEFAULTS,
  autoListingExcelSerializedBodyLimit,
  autoListingWarehouseOptions,
  deriveAutoListingConfig,
  kopecksToRubles,
  previewAutoListingPrice,
  readExcelFileAsBase64,
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
});

test("uses the approved ordinary-user defaults and derives total image count", () => {
  const config = deriveAutoListingConfig({
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    stock: 5,
    priceAdjustmentKopecks: "0",
  });

  assert.deepEqual(config.image, AUTO_LISTING_IMAGE_DEFAULTS);
  assert.equal(config.image.total, 8);
  assert.equal(config.image.ratio, "3:4");
  assert.equal(config.image.language, "ru");
  assert.equal(config.image.resolution, "1K");
  assert.equal(config.image.quality, "Medium");
  assert.equal("strategy" in config, false);
  assert.equal("model" in config, false);
  assert.equal("apiKey" in config, false);
});

test("removes the product-size image when reliable product dimensions are unavailable", () => {
  const config = deriveAutoListingConfig({
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    stock: 1,
    image: { roles: { specification: 1 } },
  }, { hasReliableProductDimensions: false });

  assert.equal(config.image.roles.specification, 0);
  assert.equal(config.image.total, 7);
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
    finalPriceKopecks: "14600",
    finalPriceText: "146.00 ₽",
  });
  assert.equal(previewAutoListingPrice({
    currency: "RUB", blackKopecks: "7000", adjustmentKopecks: "0",
  }).realPriceKopecks, "6533");
  assert.throws(() => previewAutoListingPrice({
    currency: "RUB", blackKopecks: "100", adjustmentKopecks: "-100",
  }), { code: "PRICE_FINAL_NOT_POSITIVE" });
});

test("warehouse choices trust only backend eligibility and clear stale selection after a store switch", () => {
  const warehouses = [
    { id: "local-1", warehouse_id: "101", storeId: "store-a", name: "Active", listingEligibility: { eligible: true } },
    { id: "local-2", warehouse_id: "102", storeId: "store-a", name: "Archived FBS", listingEligibility: { eligible: false } },
    { id: "local-3", warehouse_id: "103", storeId: "store-b", name: "Other", listingEligibility: { eligible: true } },
    { id: "local-4", warehouse_id: "104", storeId: "store-a", name: "Looks active by name" },
  ];
  const result = autoListingWarehouseOptions({
    warehouses,
    targetStoreId: "store-a",
    selectedWarehouseId: "103",
  });

  assert.deepEqual(result.options, [{ value: "101", label: "Active" }]);
  assert.equal(result.selectedWarehouseId, "");
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

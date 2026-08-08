import assert from "node:assert/strict";
import test from "node:test";

import { autoListingExcelImportLimits, autoListingExcelRequestBodyLimit } from "../runtime-config.mjs";

test("Excel limits use safe defaults and strictly parse configured integers", () => {
  assert.deepEqual(autoListingExcelImportLimits({}), { maxBytes: 2_097_152, maxRows: 1_000 });
  assert.deepEqual(autoListingExcelImportLimits({
    AUTO_LISTING_EXCEL_MAX_BYTES: " 4194304 ", AUTO_LISTING_EXCEL_MAX_ROWS: "2500",
  }), { maxBytes: 4_194_304, maxRows: 2_500 });
});

test("HTTP JSON body limit safely contains configured workbook base64 and bounded metadata", () => {
  assert.equal(autoListingExcelRequestBodyLimit({ maxBytes: 2_097_152, maxRows: 1_000 }), 3_058_348);
  assert.equal(autoListingExcelRequestBodyLimit({ maxBytes: 4_194_304, maxRows: 2_500 }), 5_854_552);
  assert.throws(() => autoListingExcelRequestBodyLimit({ maxBytes: 0, maxRows: 1_000 }), {
    code: "AUTO_LISTING_EXCEL_LIMIT_INVALID",
  });
});

test("Excel limits reject partial, decimal, zero, negative, and excessive configuration", () => {
  for (const env of [
    { AUTO_LISTING_EXCEL_MAX_BYTES: "12x" },
    { AUTO_LISTING_EXCEL_MAX_ROWS: "1.5" },
    { AUTO_LISTING_EXCEL_MAX_BYTES: "0" },
    { AUTO_LISTING_EXCEL_MAX_ROWS: "-1" },
    { AUTO_LISTING_EXCEL_MAX_BYTES: String(64 * 1024 * 1024 + 1) },
    { AUTO_LISTING_EXCEL_MAX_ROWS: "100001" },
  ]) assert.throws(() => autoListingExcelImportLimits(env), { code: "AUTO_LISTING_EXCEL_LIMIT_INVALID" });
});

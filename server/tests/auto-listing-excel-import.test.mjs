import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import ExcelJS from "exceljs";

const require = createRequire(import.meta.url);
const excelRequire = createRequire(require.resolve("exceljs/package.json"));
const JSZip = excelRequire("jszip");

const parserModule = await import("../auto-listing-excel-import.mjs");
const {
  AUTO_LISTING_EXCEL_IMPORT_LIMITS,
  parseAutoListingSkuWorkbook,
} = parserModule;

async function workbookBuffer(configure) {
  const workbook = new ExcelJS.Workbook();
  await configure(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function mutateArchive(buffer, mutate) {
  const archive = await JSZip.loadAsync(buffer);
  await mutate(archive);
  return archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function prefixMainSpreadsheetNamespace(buffer) {
  return mutateArchive(buffer, async (archive) => {
    const names = [
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
      "xl/styles.xml",
      "xl/sharedStrings.xml",
    ];
    for (const name of names) {
      const file = archive.file(name);
      if (!file) continue;
      const source = await file.async("string");
      const prefixed = source
        .replace(
          'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
          'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        )
        .replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s>])/gu, "<$1x:$2");
      archive.file(name, prefixed);
    }
  });
}

function corruptCentralUncompressedSize(buffer, entryName) {
  const copy = Buffer.from(buffer);
  for (let offset = 0; offset + 46 < copy.length; offset += 1) {
    if (copy.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = copy.readUInt16LE(offset + 28);
    const name = copy.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name !== entryName) continue;
    copy.writeUInt32LE(copy.readUInt32LE(offset + 24) + 1, offset + 24);
    return copy;
  }
  throw new Error(`missing archive entry ${entryName}`);
}

function overwriteCentralUncompressedSizes(buffer, sizes) {
  const copy = Buffer.from(buffer);
  let index = 0;
  for (let offset = 0; offset + 46 < copy.length && index < sizes.length; offset += 1) {
    if (copy.readUInt32LE(offset) !== 0x02014b50) continue;
    copy.writeUInt32LE(sizes[index], offset + 24);
    index += 1;
  }
  assert.equal(index, sizes.length, "archive does not contain enough central entries");
  return copy;
}

function overwriteCentralSizes(buffer, sizes) {
  const copy = Buffer.from(buffer);
  let index = 0;
  for (let offset = 0; offset + 46 < copy.length && index < sizes.length; offset += 1) {
    if (copy.readUInt32LE(offset) !== 0x02014b50) continue;
    copy.writeUInt32LE(sizes[index].compressed, offset + 20);
    copy.writeUInt32LE(sizes[index].uncompressed, offset + 24);
    index += 1;
  }
  assert.equal(index, sizes.length, "archive does not contain enough central entries");
  return copy;
}

function markFirstEntryEncrypted(buffer) {
  const copy = Buffer.from(buffer);
  const local = copy.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const central = copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(local >= 0 && central >= 0);
  copy.writeUInt16LE(copy.readUInt16LE(local + 6) | 1, local + 6);
  copy.writeUInt16LE(copy.readUInt16LE(central + 8) | 1, central + 8);
  return copy;
}

function markArchiveZip64(buffer) {
  const copy = Buffer.from(buffer);
  const eocd = copy.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0);
  copy.writeUInt16LE(0xffff, eocd + 10);
  return copy;
}

async function parseRows(rows, options = {}) {
  const buffer = await workbookBuffer(async (workbook) => {
    const sheet = workbook.addWorksheet(options.sheetName || "Sheet1");
    for (const row of rows) sheet.addRow(row);
  });
  return parseAutoListingSkuWorkbook({
    buffer,
    name: options.name || "skus.xlsx",
    contentType: options.contentType,
    maxRows: options.maxRows,
    maxBytes: options.maxBytes,
  });
}

function assertCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    assert.ok(Number.isInteger(error?.status));
    assert.doesNotMatch(String(error?.message || ""), /zip|xml|stack|password|secret|api.?key/i);
    return true;
  };
}

test("selects the first visible worksheet and ignores earlier hidden sheets", async () => {
  const buffer = await workbookBuffer(async (workbook) => {
    const hidden = workbook.addWorksheet("Hidden");
    hidden.state = "hidden";
    hidden.addRows([["SKU"], ["111111"]]);
    const visible = workbook.addWorksheet("Visible");
    visible.addRows([["SKU"], ["222222"]]);
  });

  const parsed = await parseAutoListingSkuWorkbook({ buffer, name: "visible.xlsx" });
  assert.equal(parsed.sheetName, "Visible");
  assert.deepEqual(parsed.acceptedRows, [{ rowNumber: 2, rawSku: "222222", sku: "222222" }]);
});

test("accepts the three specified headers without depending on case or spacing", async () => {
  for (const header of ["SKU", " 商 品   SKU ", "  oZoN   sKu "]) {
    const parsed = await parseRows([[header], ["4862904234"]]);
    assert.deepEqual(parsed.acceptedRows, [{ rowNumber: 2, rawSku: "4862904234", sku: "4862904234" }]);
  }
});

test("accepts valid OOXML whose main spreadsheet namespace uses an explicit prefix", async () => {
  const base = await workbookBuffer(async (workbook) => {
    workbook.addWorksheet("SKU").addRows([
      ["SKU"],
      ["4381017127"],
      ["3779547127"],
    ]);
  });
  const prefixed = await prefixMainSpreadsheetNamespace(base);

  const parsed = await parseAutoListingSkuWorkbook({ buffer: prefixed, name: "prefixed.xlsx" });

  assert.deepEqual(parsed.acceptedRows, [
    { rowNumber: 2, rawSku: "4381017127", sku: "4381017127" },
    { rowNumber: 3, rawSku: "3779547127", sku: "3779547127" },
  ]);
});

test("normalizes text and safe numeric SKU cells without scientific notation", async () => {
  const parsed = await parseRows([
    ["商品 SKU"],
    [" 000123456 "],
    [1_000_000_000_000],
    [" offer-ABC_01 "],
    [],
    ["   "],
  ]);

  assert.deepEqual(parsed.acceptedRows, [
    { rowNumber: 2, rawSku: " 000123456 ", sku: "000123456" },
    { rowNumber: 3, rawSku: "1000000000000", sku: "1000000000000" },
    { rowNumber: 4, rawSku: " offer-ABC_01 ", sku: "offer-ABC_01" },
  ]);
  assert.deepEqual(parsed.totals, { rows: 3, accepted: 3, rejected: 0, duplicates: 0 });
});

test("keeps the first duplicate and records each later row without accepting it twice", async () => {
  const parsed = await parseRows([
    ["Ozon SKU"],
    [" 123456 "],
    ["654321"],
    ["123456"],
    [123456],
  ]);

  assert.deepEqual(parsed.acceptedRows, [
    { rowNumber: 2, rawSku: " 123456 ", sku: "123456" },
    { rowNumber: 3, rawSku: "654321", sku: "654321" },
  ]);
  assert.deepEqual(parsed.duplicateRows, [
    { rowNumber: 4, rawSku: "123456", sku: "123456", firstRowNumber: 2, code: "DUPLICATE_IN_FILE" },
    { rowNumber: 5, rawSku: "123456", sku: "123456", firstRowNumber: 2, code: "DUPLICATE_IN_FILE" },
  ]);
  assert.deepEqual(parsed.totals, { rows: 4, accepted: 2, rejected: 0, duplicates: 2 });
});

test("records invalid cells by worksheet row while ignoring truly blank rows", async () => {
  const tooLong = "x".repeat(161);
  const parsed = await parseRows([
    ["SKU"],
    ["abc"],
    [" -12 "],
    [12.5],
    [true],
    [9_007_199_254_740_992],
    ["bad\nSKU"],
    [tooLong],
    [""],
    [null],
  ]);

  assert.deepEqual(parsed.acceptedRows, [
    { rowNumber: 2, rawSku: "abc", sku: "abc" },
    { rowNumber: 3, rawSku: " -12 ", sku: "-12" },
  ]);
  assert.deepEqual(parsed.rejectedRows, [
    { rowNumber: 4, rawSku: "12.5", code: "SKU_COLUMN_MUST_BE_TEXT" },
    { rowNumber: 5, rawSku: "true", code: "INVALID_SKU" },
    { rowNumber: 6, rawSku: "9007199254740992", code: "SKU_COLUMN_MUST_BE_TEXT" },
    { rowNumber: 7, rawSku: "bad\nSKU", code: "INVALID_SKU" },
    { rowNumber: 8, rawSku: tooLong, code: "INVALID_SKU" },
  ]);
  assert.deepEqual(parsed.totals, { rows: 7, accepted: 2, rejected: 5, duplicates: 0 });
});

test("never executes formulas and rejects a formula that has no cached result", async () => {
  const buffer = await workbookBuffer(async (workbook) => {
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["SKU"]);
    sheet.getCell("A2").value = { formula: "1+1" };
    sheet.getCell("A3").value = { formula: "2+2", result: "444444" };
  });

  const parsed = await parseAutoListingSkuWorkbook({ buffer, name: "formulas.xlsx" });
  assert.deepEqual(parsed.rejectedRows, [
    { rowNumber: 2, rawSku: "", code: "FORMULA_RESULT_MISSING" },
  ]);
  assert.deepEqual(parsed.acceptedRows, [
    { rowNumber: 3, rawSku: "444444", sku: "444444" },
  ]);
});

test("reads hyperlink display text without following external links", async () => {
  const buffer = await workbookBuffer(async (workbook) => {
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["SKU"]);
    sheet.getCell("A2").value = { text: "4862904234", hyperlink: "https://example.invalid/private" };
  });
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("network must not be used");
  };
  try {
    const parsed = await parseAutoListingSkuWorkbook({ buffer, name: "links.xlsx" });
    assert.deepEqual(parsed.acceptedRows, [{ rowNumber: 2, rawSku: "4862904234", sku: "4862904234" }]);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects numeric SKU display transformations and tells callers to use text cells", async () => {
  const buffer = await workbookBuffer(async (workbook) => {
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["SKU"]);
    const cases = [
      [123, "General"],
      [123, "000000"],
      [123, "0.00E+00"],
      [1234, "#,##0"],
      [123, "$0"],
      [45_000, "yyyy-mm-dd"],
    ];
    for (const [value, numFmt] of cases) {
      const cell = sheet.getCell(sheet.rowCount + 1, 1);
      cell.value = value;
      cell.numFmt = numFmt;
    }
    const formula = sheet.getCell(sheet.rowCount + 1, 1);
    formula.value = { formula: "120+3", result: 123 };
    formula.numFmt = "000000";
  });
  const parsed = await parseAutoListingSkuWorkbook({ buffer, name: "numeric-formats.xlsx" });
  assert.deepEqual(parsed.acceptedRows, [{ rowNumber: 2, rawSku: "123", sku: "123" }]);
  assert.deepEqual(parsed.rejectedRows.map(({ rowNumber, code }) => ({ rowNumber, code })), [
    { rowNumber: 3, code: "SKU_COLUMN_MUST_BE_TEXT" },
    { rowNumber: 4, code: "SKU_COLUMN_MUST_BE_TEXT" },
    { rowNumber: 5, code: "SKU_COLUMN_MUST_BE_TEXT" },
    { rowNumber: 6, code: "SKU_COLUMN_MUST_BE_TEXT" },
    { rowNumber: 7, code: "SKU_COLUMN_MUST_BE_TEXT" },
    { rowNumber: 8, code: "SKU_COLUMN_MUST_BE_TEXT" },
  ]);
});

test("rejects invisible Unicode controls but preserves ordinary Cyrillic and CJK SKUs", async () => {
  const parsed = await parseRows([
    ["SKU"],
    ["товар-中国-001"],
    ["ABC\u200B123"],
    ["ABC\u202E123"],
    ["ABC\uFEFF123"],
    ["ABC\u2066123"],
    ["ABC\u200D123"],
    [`ABC${"\ud800"}123`],
    ["\uFEFFABC123"],
  ]);
  assert.deepEqual(parsed.acceptedRows, [
    { rowNumber: 2, rawSku: "товар-中国-001", sku: "товар-中国-001" },
  ]);
  assert.deepEqual(parsed.rejectedRows.map(({ rowNumber, code }) => ({ rowNumber, code })), [
    { rowNumber: 3, code: "INVALID_SKU" },
    { rowNumber: 4, code: "INVALID_SKU" },
    { rowNumber: 5, code: "INVALID_SKU" },
    { rowNumber: 6, code: "INVALID_SKU" },
    { rowNumber: 7, code: "INVALID_SKU" },
    { rowNumber: 8, code: "INVALID_SKU" },
    { rowNumber: 9, code: "INVALID_SKU" },
  ]);
});

test("preflights compressed expansion, entry count, paths, and declared sizes before parsing", async () => {
  const base = await workbookBuffer(async (workbook) => {
    workbook.addWorksheet("Sheet1").addRows([["SKU"], ["123456"]]);
  });
  const expansion = await mutateArchive(base, async (archive) => {
    archive.file("xl/media/attack.bin", "A".repeat(1024 * 1024));
  });
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: expansion, name: "expansion.xlsx" }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED"),
  );

  const many = await mutateArchive(base, async (archive) => {
    for (let index = 0; index < 32; index += 1) archive.file(`xl/media/${index}.bin`, "x");
  });
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: many, name: "many.xlsx", maxZipEntries: 20 }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED"),
  );

  const pathTraversal = await mutateArchive(base, async (archive) => {
    archive.file("../outside.bin", "x");
  });
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: pathTraversal, name: "path.xlsx" }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_UNSAFE"),
  );

  const mismatch = corruptCentralUncompressedSize(base, "xl/worksheets/sheet1.xml");
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: mismatch, name: "mismatch.xlsx" }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_UNSAFE"),
  );
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: markFirstEntryEncrypted(base), name: "encrypted.xlsx" }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_UNSAFE"),
  );
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: markArchiveZip64(base), name: "zip64.xlsx" }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_UNSAFE"),
  );
});

test("bounds shared strings, worksheet width, and cell count while accepting a legitimate boundary file", async () => {
  const sharedStrings = await workbookBuffer(async (workbook) => {
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["SKU"]);
    for (let index = 0; index < 40; index += 1) sheet.addRow([`unique-sku-${index}-${"x".repeat(20)}`]);
  });
  await assert.rejects(
    parseAutoListingSkuWorkbook({
      buffer: sharedStrings,
      name: "shared.xlsx",
      maxSharedStringsXmlBytes: 256,
    }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED"),
  );

  const ultraWide = await workbookBuffer(async (workbook) => {
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["SKU"]);
    sheet.getCell("A2").value = "123456";
    sheet.getCell("XFD2").value = "sparse";
  });
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: ultraWide, name: "wide.xlsx" }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED"),
  );
  await assert.rejects(
    parseAutoListingSkuWorkbook({
      buffer: await prefixMainSpreadsheetNamespace(ultraWide),
      name: "prefixed-wide.xlsx",
    }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED"),
  );

  await assert.rejects(
    parseAutoListingSkuWorkbook({
      buffer: sharedStrings,
      name: "cells.xlsx",
      maxRows: 19,
      maxWorksheetCells: 20,
    }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED"),
  );
  await assert.rejects(
    parseAutoListingSkuWorkbook({
      buffer: await prefixMainSpreadsheetNamespace(sharedStrings),
      name: "prefixed-cells.xlsx",
      maxRows: 19,
      maxWorksheetCells: 20,
    }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED"),
  );

  const accepted = await parseAutoListingSkuWorkbook({
    buffer: sharedStrings,
    name: "boundary.xlsx",
    maxBytes: sharedStrings.length,
    maxRows: 40,
  });
  assert.equal(accepted.totals.accepted, 40);
});

test("parses a real 100000-row one-column workbook within derived bounded resources", { timeout: 120_000 }, async () => {
  const buffer = await workbookBuffer(async (workbook) => {
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["SKU"]);
    for (let index = 0; index < 100_000; index += 1) {
      sheet.addRow([`SKU-${String(index).padStart(6, "0")}`]);
    }
  });
  const parsed = await parseAutoListingSkuWorkbook({
    buffer,
    name: "100000-skus.xlsx",
    maxRows: 100_000,
    maxBytes: 64 * 1024 * 1024,
  });
  assert.deepEqual(parsed.totals, {
    rows: 100_000,
    accepted: 100_000,
    rejected: 0,
    duplicates: 0,
  });
  assert.equal(parsed.acceptedRows.at(-1)?.sku, "SKU-099999");
});

test("100000-row derived budgets retain absolute compression, entry, and total archive limits", async () => {
  const base = await workbookBuffer(async (workbook) => {
    workbook.addWorksheet("Sheet1").addRows([["SKU"], ["123456"]]);
  });
  const expansion = await mutateArchive(base, async (archive) => {
    archive.file("xl/media/attack.bin", "A".repeat(2 * 1024 * 1024));
  });
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: expansion, name: "compression.xlsx", maxRows: 100_000,
      maxBytes: 64 * 1024 * 1024 }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED"),
  );

  const overEntry = overwriteCentralUncompressedSizes(base, [129 * 1024 * 1024]);
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: overEntry, name: "entry.xlsx", maxRows: 100_000,
      maxBytes: 64 * 1024 * 1024 }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED"),
  );

  const overTotal = overwriteCentralSizes(base, Array.from({ length: 3 }, () => ({
    compressed: 1024 * 1024,
    uncompressed: 70 * 1024 * 1024,
  })));
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: overTotal, name: "total.xlsx", maxRows: 100_000,
      maxBytes: 64 * 1024 * 1024 }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED"),
  );
});

test("terminates isolated parsing at the configured wall-clock deadline", async () => {
  const buffer = await workbookBuffer(async (workbook) => {
    workbook.addWorksheet("Sheet1").addRows([["SKU"], ["123456"]]);
  });
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer, name: "timeout.xlsx", parseTimeoutMs: 1 }),
    assertCode("AUTO_LISTING_EXCEL_PARSE_TIMEOUT"),
  );
});

test("returns stable closed errors for unsupported, empty, corrupt, and empty-workbook files", async () => {
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: Buffer.from("x"), name: "skus.xls" }),
    assertCode("AUTO_LISTING_EXCEL_EXTENSION_UNSUPPORTED"),
  );
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: Buffer.alloc(0), name: "skus.xlsx" }),
    assertCode("AUTO_LISTING_EXCEL_FILE_EMPTY"),
  );
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: Buffer.from("not an xlsx"), name: "skus.xlsx" }),
    assertCode("AUTO_LISTING_EXCEL_ARCHIVE_UNSAFE"),
  );
  const empty = await workbookBuffer(async (workbook) => workbook.addWorksheet("Empty"));
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: empty, name: "empty.xlsx" }),
    assertCode("AUTO_LISTING_EXCEL_WORKBOOK_EMPTY"),
  );
});

test("returns stable errors for no visible sheet, missing header, file limits, and row limits", async () => {
  const hiddenOnly = await workbookBuffer(async (workbook) => {
    const visible = workbook.addWorksheet("Placeholder");
    visible.addRow([]);
    const hidden = workbook.addWorksheet("Hidden");
    hidden.state = "hidden";
    hidden.addRows([["SKU"], ["123456"]]);
    visible.state = "hidden";
  });
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: hiddenOnly, name: "hidden.xlsx" }),
    assertCode("AUTO_LISTING_EXCEL_VISIBLE_SHEET_MISSING"),
  );

  await assert.rejects(
    parseRows([["商品名称"], ["123456"]]),
    assertCode("AUTO_LISTING_EXCEL_SKU_HEADER_MISSING"),
  );

  const valid = await workbookBuffer(async (workbook) => {
    workbook.addWorksheet("Sheet1").addRows([["SKU"], ["123456"]]);
  });
  await assert.rejects(
    parseAutoListingSkuWorkbook({ buffer: valid, name: "large.xlsx", maxBytes: valid.length - 1 }),
    (error) => {
      assertCode("AUTO_LISTING_EXCEL_FILE_TOO_LARGE")(error);
      assert.equal(error.maxBytes, valid.length - 1);
      return true;
    },
  );

  await assert.rejects(
    parseRows([["SKU"], ["111111"], ["222222"], ["333333"]], { maxRows: 2 }),
    (error) => {
      assertCode("AUTO_LISTING_EXCEL_ROW_LIMIT_EXCEEDED")(error);
      assert.equal(error.maxRows, 2);
      return true;
    },
  );
});

test("validates operational limits and exposes only immutable defaults", async () => {
  assert.deepEqual(AUTO_LISTING_EXCEL_IMPORT_LIMITS, {
    maxRows: 1000,
    maxBytes: 2_097_152,
    maxZipEntries: 256,
    maxEntryUncompressedBytes: 8 * 1024 * 1024,
    maxTotalUncompressedBytes: 16 * 1024 * 1024,
    maxCompressionRatio: 200,
    maxWorksheetXmlBytes: 4 * 1024 * 1024,
    maxSharedStringsXmlBytes: 4 * 1024 * 1024,
    maxWorksheetCells: 20_000,
    maxWorksheetColumns: 128,
    parseTimeoutMs: 5_000,
  });
  assert.ok(Object.isFrozen(AUTO_LISTING_EXCEL_IMPORT_LIMITS));

  const valid = await workbookBuffer(async (workbook) => {
    workbook.addWorksheet("Sheet1").addRows([["SKU"], ["123456"]]);
  });
  assert.equal((await parseAutoListingSkuWorkbook({ buffer: valid, name: "large-row-contract.xlsx",
    maxRows: 25_000 })).totals.accepted, 1);
  await assert.rejects(parseAutoListingSkuWorkbook({ buffer: valid, name: "inconsistent-cells.xlsx",
    maxRows: 25_000, maxWorksheetCells: 20_000 }), assertCode("AUTO_LISTING_EXCEL_LIMIT_INVALID"));
  for (const field of Object.keys(AUTO_LISTING_EXCEL_IMPORT_LIMITS)) {
    for (const input of [0, -1, 1.5, "10", Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(
        parseAutoListingSkuWorkbook({ buffer: valid, name: "skus.xlsx", [field]: input }),
        assertCode("AUTO_LISTING_EXCEL_LIMIT_INVALID"),
      );
    }
  }
});

import ExcelJS from "exceljs";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);
const excelRequire = createRequire(require.resolve("exceljs/package.json"));
const JSZip = excelRequire("jszip");

export const AUTO_LISTING_EXCEL_IMPORT_LIMITS = Object.freeze({
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

const MAX_CONFIGURED_ROWS = 100_000;
const MAX_CONFIGURED_BYTES = 64 * 1024 * 1024;
const MAX_CONFIGURED_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_CONFIGURED_ZIP_ENTRIES = 10_000;
const MAX_CONFIGURED_COMPRESSION_RATIO = AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxCompressionRatio;
const MAX_CONFIGURED_WORKSHEET_CELLS = 1_000_000;
const MAX_CONFIGURED_WORKSHEET_COLUMNS = 16_384;
const MAX_CONFIGURED_PARSE_TIMEOUT_MS = 30_000;
const MAX_WORKER_OLD_GENERATION_MB = 384;
const XLSX_EXTENSION = ".xlsx";
const MAIN_SPREADSHEET_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const MAIN_NAMESPACE_PREFIX_DECLARATION = /xmlns:([A-Za-z_][\w.-]*)=["']http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main["']/u;
const SKU_HEADERS = new Set(["sku", "商品sku", "ozonsku"]);
const SKU_MAX_BYTES = 160;
const XML_TEXT_ESCAPE_EXPANSION = 5;
const WORKSHEET_ROW_XML_BUDGET = 128;
const SHARED_STRING_XML_OVERHEAD = 48;
const FORBIDDEN_UNICODE_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function importError(code, message, status = 400, details = {}) {
  return Object.assign(new Error(message), { code, status, ...details });
}

function positiveLimit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw importError(
      "AUTO_LISTING_EXCEL_LIMIT_INVALID",
      "Excel 导入限制配置无效",
      500,
    );
  }
  return value;
}

function derivedResourceLimits(maxRows) {
  // The service contract permits one UTF-8 SKU of at most 160 bytes per row.
  // Shared-string text may expand from "&" to "&amp;" (5 bytes), while the
  // worksheet contains row/cell/index tags. These budgets deliberately cover
  // both shared-string and inline-string writers without making archive limits
  // unbounded. Absolute entry/total caps remain the final zip-bomb boundary.
  const rowsWithHeader = maxRows + 1;
  const worksheetXmlBytes = Math.min(
    MAX_ENTRY_UNCOMPRESSED_BYTES,
    Math.max(
      AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxWorksheetXmlBytes,
      (1024 * 1024) + (rowsWithHeader * (
        WORKSHEET_ROW_XML_BUDGET + (SKU_MAX_BYTES * XML_TEXT_ESCAPE_EXPANSION)
      )),
    ),
  );
  const sharedStringsXmlBytes = Math.min(
    MAX_ENTRY_UNCOMPRESSED_BYTES,
    Math.max(
      AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxSharedStringsXmlBytes,
      (1024 * 1024) + (rowsWithHeader * (
        SHARED_STRING_XML_OVERHEAD + (SKU_MAX_BYTES * XML_TEXT_ESCAPE_EXPANSION)
      )),
    ),
  );
  const entryUncompressedBytes = Math.min(
    MAX_ENTRY_UNCOMPRESSED_BYTES,
    Math.max(
      AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxEntryUncompressedBytes,
      worksheetXmlBytes,
      sharedStringsXmlBytes,
    ),
  );
  const totalUncompressedBytes = Math.min(
    MAX_CONFIGURED_ARCHIVE_BYTES,
    Math.max(
      AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxTotalUncompressedBytes,
      worksheetXmlBytes + sharedStringsXmlBytes + (16 * 1024 * 1024),
    ),
  );
  return Object.freeze({
    worksheetXmlBytes,
    sharedStringsXmlBytes,
    entryUncompressedBytes,
    totalUncompressedBytes,
    parseTimeoutMs: Math.min(
      MAX_CONFIGURED_PARSE_TIMEOUT_MS,
      Math.max(AUTO_LISTING_EXCEL_IMPORT_LIMITS.parseTimeoutMs,
        5_000 + Math.ceil(maxRows / 1_000) * 250),
    ),
    workerOldGenerationSizeMb: Math.min(
      MAX_WORKER_OLD_GENERATION_MB,
      Math.max(128, 128 + Math.ceil(maxRows / 500)),
    ),
  });
}

function archiveError() {
  return importError(
    "AUTO_LISTING_EXCEL_ARCHIVE_UNSAFE",
    "Excel 文件内部结构不符合安全要求",
    400,
  );
}

function archiveLimitError() {
  return importError(
    "AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED",
    "Excel 文件内部内容超过安全限制",
    413,
  );
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeEntryName(bytes, utf8) {
  if (!utf8 && [...bytes].some((byte) => byte > 0x7f)) throw archiveError();
  const name = bytes.toString("utf8");
  if (Buffer.from(name, "utf8").compare(bytes) !== 0) throw archiveError();
  if (
    !name
    || name.includes("\\")
    || name.startsWith("/")
    || /^[a-z]:/iu.test(name)
    || FORBIDDEN_UNICODE_CONTROL.test(name)
    || name.split("/").some((part, index, parts) => (
      part === "." || part === ".." || (!part && index !== parts.length - 1)
    ))
  ) throw archiveError();
  return name;
}

function validateExtraFields(extra) {
  let cursor = 0;
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) throw archiveError();
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > extra.length) throw archiveError();
    if ([0x0001, 0x0017, 0x9901].includes(id)) throw archiveError();
    cursor += size;
  }
}

function locateEocd(buffer) {
  const minimum = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw archiveError();
}

function readArchiveEntries(buffer, limits) {
  const eocd = locateEocd(buffer);
  if (
    buffer.readUInt16LE(eocd + 4) !== 0
    || buffer.readUInt16LE(eocd + 6) !== 0
  ) throw archiveError();
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw archiveError();
  }
  if (buffer.readUInt16LE(eocd + 8) !== entryCount) throw archiveError();
  if (entryCount > limits.maxZipEntries) throw archiveLimitError();
  if (centralOffset + centralSize !== eocd || centralOffset > buffer.length) throw archiveError();

  const entries = [];
  const names = new Set();
  let cursor = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw archiveError();
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || diskStart !== 0 || (flags & ~0x080e) !== 0 || ![0, 8].includes(method)) {
      throw archiveError();
    }
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) throw archiveError();
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    validateExtraFields(buffer.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    const name = decodeEntryName(nameBytes, (flags & 0x0800) !== 0);
    const canonicalName = name.normalize("NFC").toLowerCase();
    if (names.has(canonicalName)) throw archiveError();
    names.add(canonicalName);
    if (uncompressedSize > limits.maxEntryUncompressedBytes) throw archiveLimitError();
    declaredTotal += uncompressedSize;
    if (declaredTotal > limits.maxTotalUncompressedBytes) throw archiveLimitError();
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio)) {
      throw archiveLimitError();
    }
    if (/^xl\/worksheets\/[^/]+\.xml$/iu.test(name) && uncompressedSize > limits.maxWorksheetXmlBytes) {
      throw archiveLimitError();
    }
    if (/^xl\/sharedstrings\.xml$/iu.test(name) && uncompressedSize > limits.maxSharedStringsXmlBytes) {
      throw archiveLimitError();
    }
    entries.push({ name, nameBytes, flags, method, expectedCrc, compressedSize, uncompressedSize, localOffset });
    cursor = next;
  }
  if (cursor !== eocd || entries.length !== entryCount) throw archiveError();
  return { entries, centralOffset };
}

function worksheetColumnNumber(reference) {
  const match = /^([A-Z]+)[1-9][0-9]*$/iu.exec(reference);
  if (!match) return null;
  let value = 0;
  for (const character of match[1].toUpperCase()) value = (value * 26) + character.charCodeAt(0) - 64;
  return value;
}

function validateWorksheetXml(data, limits) {
  const text = data.toString("utf8");
  let cellCount = 0;
  for (const match of text.matchAll(/<(?:[A-Za-z_][\w.-]*:)?c(?:\s[^>]*)?>/giu)) {
    cellCount += 1;
    if (cellCount > limits.maxWorksheetCells) throw archiveLimitError();
    const reference = /\sr=["']([^"']+)["']/iu.exec(match[0])?.[1];
    const column = reference ? worksheetColumnNumber(reference.replace(/\$/gu, "")) : null;
    if (column && column > limits.maxWorksheetColumns) throw archiveLimitError();
  }
  for (const match of text.matchAll(/<(?:[A-Za-z_][\w.-]*:)?dimension\s[^>]*ref=["']([^"']+)["']/giu)) {
    const last = match[1].split(":").at(-1)?.replace(/\$/gu, "");
    const column = last ? worksheetColumnNumber(last) : null;
    const row = last ? Number(/[0-9]+$/u.exec(last)?.[0]) : null;
    if (column && column > limits.maxWorksheetColumns) throw archiveLimitError();
    if (row && row > limits.maxRows + 32) throw archiveLimitError();
  }
}

function preflightWorkbookArchive(buffer, limits) {
  const { entries, centralOffset } = readArchiveEntries(buffer, limits);
  const ranges = [];
  let actualTotal = 0;
  let namespaceNormalizationRequired = false;
  for (const entry of entries) {
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) throw archiveError();
    const localFlags = buffer.readUInt16LE(offset + 6);
    const localMethod = buffer.readUInt16LE(offset + 8);
    const localNameLength = buffer.readUInt16LE(offset + 26);
    const localExtraLength = buffer.readUInt16LE(offset + 28);
    const localName = buffer.subarray(offset + 30, offset + 30 + localNameLength);
    const localExtra = buffer.subarray(offset + 30 + localNameLength, offset + 30 + localNameLength + localExtraLength);
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (
      localFlags !== entry.flags
      || localMethod !== entry.method
      || localName.compare(entry.nameBytes) !== 0
      || dataEnd > centralOffset
    ) throw archiveError();
    validateExtraFields(localExtra);
    if ((localFlags & 0x0008) === 0) {
      if (
        buffer.readUInt32LE(offset + 14) !== entry.expectedCrc
        || buffer.readUInt32LE(offset + 18) !== entry.compressedSize
        || buffer.readUInt32LE(offset + 22) !== entry.uncompressedSize
      ) throw archiveError();
    }
    ranges.push([offset, dataEnd]);
    let data;
    try {
      const compressed = buffer.subarray(dataStart, dataEnd);
      data = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: limits.maxEntryUncompressedBytes + 1 });
    } catch {
      throw archiveError();
    }
    if (data.length !== entry.uncompressedSize || crc32(data) !== entry.expectedCrc) throw archiveError();
    actualTotal += data.length;
    if (actualTotal > limits.maxTotalUncompressedBytes) throw archiveLimitError();
    if (/\.xml$/iu.test(entry.name) && MAIN_NAMESPACE_PREFIX_DECLARATION.test(data.toString("utf8"))) {
      namespaceNormalizationRequired = true;
    }
    if (/^xl\/worksheets\/[^/]+\.xml$/iu.test(entry.name)) validateWorksheetXml(data, limits);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) throw archiveError();
  }
  return { normalizeSpreadsheetNamespaces: namespaceNormalizationRequired };
}

function normalizeSpreadsheetNamespaceXml(source) {
  const declaration = MAIN_NAMESPACE_PREFIX_DECLARATION.exec(source);
  if (!declaration || /\sxmlns=["']/u.test(source)) return source;
  const prefix = declaration[1].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return source
    .replace(declaration[0], `xmlns="${MAIN_SPREADSHEET_NAMESPACE}"`)
    .replace(new RegExp(`<(/?)${prefix}:`, "gu"), "<$1");
}

async function normalizeSpreadsheetNamespaces(buffer) {
  const archive = await JSZip.loadAsync(buffer);
  const files = Object.values(archive.files).filter((file) => !file.dir && /\.xml$/iu.test(file.name));
  for (const file of files) {
    const source = await file.async("string");
    const normalized = normalizeSpreadsheetNamespaceXml(source);
    if (normalized !== source) archive.file(file.name, normalized);
  }
  return Buffer.from(await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

function numberText(value) {
  if (!Number.isFinite(value)) return "";
  const source = String(value);
  if (!/[eE]/.test(source)) return source;
  const [coefficient, exponentText] = source.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [integerPart, fractionPart = ""] = unsigned.split(".");
  const digits = `${integerPart}${fractionPart}`;
  const decimalAt = integerPart.length + exponent;
  const expanded = decimalAt <= 0
    ? `0.${"0".repeat(-decimalAt)}${digits}`
    : decimalAt >= digits.length
      ? `${digits}${"0".repeat(decimalAt - digits.length)}`
      : `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
  return negative ? `-${expanded}` : expanded;
}

function primitiveCell(value) {
  if (value === null || value === undefined || value === "") {
    return { kind: "blank", rawText: "" };
  }
  if (typeof value === "string") return { kind: "value", rawText: value, scalarType: "string" };
  if (typeof value === "number") {
    return { kind: "value", rawText: numberText(value), scalarType: "number", numeric: value };
  }
  if (typeof value === "boolean") {
    return { kind: "value", rawText: String(value), scalarType: "boolean" };
  }
  if (typeof value !== "object") return { kind: "invalid", rawText: "" };

  if (Object.hasOwn(value, "formula") || Object.hasOwn(value, "sharedFormula")) {
    if (value.result === null || value.result === undefined || value.result === "") {
      return { kind: "formulaMissing", rawText: "" };
    }
    const cached = primitiveCell(value.result);
    return cached.kind === "blank"
      ? { kind: "formulaMissing", rawText: "" }
      : { ...cached, fromFormula: true };
  }
  if (typeof value.text === "string" && Object.hasOwn(value, "hyperlink")) {
    return { kind: value.text ? "value" : "blank", rawText: value.text, scalarType: "string" };
  }
  if (Array.isArray(value.richText)) {
    const rawText = value.richText
      .map((part) => typeof part?.text === "string" ? part.text : "")
      .join("");
    return { kind: rawText ? "value" : "blank", rawText, scalarType: "string" };
  }
  return { kind: "invalid", rawText: "" };
}

function headerKey(value) {
  const cell = primitiveCell(value);
  if (cell.kind !== "value") return "";
  return cell.rawText.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

function rowHasValue(row) {
  let hasValue = false;
  row.eachCell({ includeEmpty: false }, (cell) => {
    const value = primitiveCell(cell.value);
    if (value.kind !== "blank" && (value.kind !== "value" || value.rawText.trim())) hasValue = true;
  });
  return hasValue;
}

function locateHeader(sheet) {
  let firstContentRow = null;
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!rowHasValue(row)) continue;
    firstContentRow = row;
    break;
  }
  if (!firstContentRow) return null;

  let skuColumn = null;
  firstContentRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    if (skuColumn === null && SKU_HEADERS.has(headerKey(cell.value))) skuColumn = columnNumber;
  });
  return { rowNumber: firstContentRow.number, skuColumn };
}

function normalizedSku(excelCell) {
  const cell = primitiveCell(excelCell.value);
  if (cell.kind !== "value") {
    if (excelCell.value instanceof Date || excelCell.value?.result instanceof Date) {
      return {
        ...cell,
        rawText: typeof excelCell.text === "string" ? excelCell.text : "",
        sku: null,
        rejectionCode: "SKU_COLUMN_MUST_BE_TEXT",
      };
    }
    return { ...cell, sku: null };
  }
  const sku = cell.rawText.trim();
  const displayedText = typeof excelCell.text === "string" ? excelCell.text.trim() : sku;
  const numericFormatIsCanonical = cell.scalarType !== "number" || (
    displayedText === sku && (!excelCell.numFmt || excelCell.numFmt === "General")
  );
  const scalarIsSafe = cell.scalarType === "string"
    || (cell.scalarType === "number" && Number.isSafeInteger(cell.numeric));
  const textIsSafe = sku.length > 0
    && Buffer.byteLength(sku, "utf8") <= SKU_MAX_BYTES
    && !FORBIDDEN_UNICODE_CONTROL.test(cell.rawText);
  return {
    ...cell,
    rawText: cell.scalarType === "number" && displayedText ? displayedText : cell.rawText,
    sku: scalarIsSafe && numericFormatIsCanonical && textIsSafe ? sku : null,
    rejectionCode: cell.scalarType === "number" && (!scalarIsSafe || !numericFormatIsCanonical)
      ? "SKU_COLUMN_MUST_BE_TEXT"
      : "INVALID_SKU",
  };
}

function isVisibleSheet(sheet) {
  return !sheet.state || sheet.state === "visible";
}

/**
 * Parses one bounded .xlsx workbook into deterministic, row-level SKU results.
 * Excel formulas are never evaluated: only an already cached primitive result
 * may be used. Hyperlinks contribute display text only and are never fetched.
 */
async function parseWorkbookContent(buffer, limits, options = {}) {
  const workbook = new ExcelJS.Workbook();
  try {
    const compatibleBuffer = options.normalizeSpreadsheetNamespaces
      ? await normalizeSpreadsheetNamespaces(buffer)
      : buffer;
    await workbook.xlsx.load(compatibleBuffer);
  } catch {
    throw importError(
      "AUTO_LISTING_EXCEL_WORKBOOK_INVALID",
      "Excel 文件损坏、加密或格式无效",
      400,
    );
  }

  if (!workbook.worksheets.length) {
    throw importError("AUTO_LISTING_EXCEL_WORKBOOK_EMPTY", "Excel 工作簿为空", 400);
  }
  const sheet = workbook.worksheets.find(isVisibleSheet);
  if (!sheet) {
    throw importError(
      "AUTO_LISTING_EXCEL_VISIBLE_SHEET_MISSING",
      "Excel 工作簿没有可见工作表",
      400,
    );
  }

  const header = locateHeader(sheet);
  if (!header) {
    throw importError("AUTO_LISTING_EXCEL_WORKBOOK_EMPTY", "Excel 工作表为空", 400);
  }
  if (header.skuColumn === null) {
    throw importError(
      "AUTO_LISTING_EXCEL_SKU_HEADER_MISSING",
      "Excel 缺少 SKU、商品 SKU 或 Ozon SKU 表头",
      422,
    );
  }
  const worksheetRangeRows = Math.max(0, sheet.rowCount - header.rowNumber);
  if (worksheetRangeRows > limits.maxRows) {
    throw importError(
      "AUTO_LISTING_EXCEL_ROW_LIMIT_EXCEEDED",
      `Excel 数据范围超过 ${limits.maxRows} 行限制`,
      413,
      { maxRows: limits.maxRows },
    );
  }
  if (sheet.columnCount > limits.maxWorksheetColumns) throw archiveLimitError();

  const acceptedRows = [];
  const rejectedRows = [];
  const duplicateRows = [];
  const firstRowBySku = new Map();
  let rows = 0;
  let cells = 0;

  for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.eachCell({ includeEmpty: false }, () => { cells += 1; });
    if (cells > limits.maxWorksheetCells) throw archiveLimitError();
    const parsed = normalizedSku(row.getCell(header.skuColumn));
    if (!parsed.rawText.trim() && !rowHasValue(row)) continue;
    rows += 1;

    if (parsed.kind === "formulaMissing") {
      rejectedRows.push({ rowNumber, rawSku: "", code: "FORMULA_RESULT_MISSING" });
      continue;
    }
    if (!parsed.sku) {
      rejectedRows.push({ rowNumber, rawSku: parsed.rawText, code: parsed.rejectionCode || "INVALID_SKU" });
      continue;
    }

    const firstRowNumber = firstRowBySku.get(parsed.sku);
    if (firstRowNumber !== undefined) {
      duplicateRows.push({
        rowNumber,
        rawSku: parsed.rawText,
        sku: parsed.sku,
        firstRowNumber,
        code: "DUPLICATE_IN_FILE",
      });
      continue;
    }
    firstRowBySku.set(parsed.sku, rowNumber);
    acceptedRows.push({ rowNumber, rawSku: parsed.rawText, sku: parsed.sku });
  }

  return {
    sheetName: sheet.name,
    acceptedRows,
    rejectedRows,
    duplicateRows,
    totals: {
      rows,
      accepted: acceptedRows.length,
      rejected: rejectedRows.length,
      duplicates: duplicateRows.length,
    },
  };
}

function isolatedParse(buffer, limits, options = {}) {
  return new Promise((resolve, reject) => {
    const owned = Uint8Array.from(buffer);
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        kind: "AUTO_LISTING_EXCEL_PARSE_V1",
        buffer: owned.buffer,
        limits,
        normalizeSpreadsheetNamespaces: options.normalizeSpreadsheetNamespaces === true,
      },
      transferList: [owned.buffer],
      resourceLimits: { maxOldGenerationSizeMb: limits.workerOldGenerationSizeMb },
    });
    let settled = false;
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      settle(() => {
        void worker.terminate();
        reject(importError(
          "AUTO_LISTING_EXCEL_PARSE_TIMEOUT",
          "Excel 文件解析超时",
          408,
        ));
      });
    }, limits.parseTimeoutMs);
    timer.unref?.();
    worker.once("message", (message) => settle(() => {
      if (message?.ok) resolve(message.result);
      else reject(importError(
        message?.error?.code || "AUTO_LISTING_EXCEL_WORKBOOK_INVALID",
        message?.error?.message || "Excel 文件损坏、加密或格式无效",
        Number.isInteger(message?.error?.status) ? message.error.status : 400,
        message?.error?.details || {},
      ));
    }));
    worker.once("error", () => settle(() => reject(importError(
      "AUTO_LISTING_EXCEL_WORKBOOK_INVALID",
      "Excel 文件损坏、加密或格式无效",
      400,
    ))));
    worker.once("exit", (code) => {
      if (code !== 0) settle(() => reject(importError(
        "AUTO_LISTING_EXCEL_WORKBOOK_INVALID",
        "Excel 文件损坏、加密或格式无效",
        400,
      )));
    });
  });
}

/**
 * Parses one bounded .xlsx workbook into deterministic, row-level SKU results.
 * The archive is fully preflighted with bounded decompression before ExcelJS,
 * then ExcelJS runs in a memory-limited worker with a hard wall-clock timeout.
 */
export async function parseAutoListingSkuWorkbook(input = {}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name.toLowerCase().endsWith(XLSX_EXTENSION)) {
    throw importError("AUTO_LISTING_EXCEL_EXTENSION_UNSUPPORTED", "仅支持 .xlsx 文件", 415);
  }
  const maxRows = positiveLimit(input.maxRows, AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxRows, MAX_CONFIGURED_ROWS);
  const derived = derivedResourceLimits(maxRows);
  const maxWorksheetCells = input.maxWorksheetCells === undefined
    ? Math.max(AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxWorksheetCells, maxRows + 1)
    : positiveLimit(input.maxWorksheetCells, AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxWorksheetCells,
      MAX_CONFIGURED_WORKSHEET_CELLS);
  if (maxWorksheetCells < maxRows + 1) {
    throw importError("AUTO_LISTING_EXCEL_LIMIT_INVALID", "Excel 单元格限制不能小于行数限制", 422);
  }
  const limits = {
    maxRows,
    maxBytes: positiveLimit(input.maxBytes, AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxBytes, MAX_CONFIGURED_BYTES),
    maxZipEntries: positiveLimit(input.maxZipEntries, AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxZipEntries, MAX_CONFIGURED_ZIP_ENTRIES),
    maxEntryUncompressedBytes: positiveLimit(input.maxEntryUncompressedBytes, derived.entryUncompressedBytes, MAX_ENTRY_UNCOMPRESSED_BYTES),
    maxTotalUncompressedBytes: positiveLimit(input.maxTotalUncompressedBytes, derived.totalUncompressedBytes, MAX_CONFIGURED_ARCHIVE_BYTES),
    maxCompressionRatio: positiveLimit(input.maxCompressionRatio, AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxCompressionRatio, MAX_CONFIGURED_COMPRESSION_RATIO),
    maxWorksheetXmlBytes: positiveLimit(input.maxWorksheetXmlBytes, derived.worksheetXmlBytes, MAX_ENTRY_UNCOMPRESSED_BYTES),
    maxSharedStringsXmlBytes: positiveLimit(input.maxSharedStringsXmlBytes, derived.sharedStringsXmlBytes, MAX_ENTRY_UNCOMPRESSED_BYTES),
    maxWorksheetCells,
    maxWorksheetColumns: positiveLimit(input.maxWorksheetColumns, AUTO_LISTING_EXCEL_IMPORT_LIMITS.maxWorksheetColumns, MAX_CONFIGURED_WORKSHEET_COLUMNS),
    parseTimeoutMs: positiveLimit(input.parseTimeoutMs, derived.parseTimeoutMs, MAX_CONFIGURED_PARSE_TIMEOUT_MS),
    workerOldGenerationSizeMb: derived.workerOldGenerationSizeMb,
  };
  const buffer = Buffer.isBuffer(input.buffer)
    ? input.buffer
    : input.buffer instanceof Uint8Array
      ? Buffer.from(input.buffer.buffer, input.buffer.byteOffset, input.buffer.byteLength)
      : null;
  if (!buffer?.length) throw importError("AUTO_LISTING_EXCEL_FILE_EMPTY", "Excel 文件内容为空", 400);
  if (buffer.length > limits.maxBytes) {
    throw importError(
      "AUTO_LISTING_EXCEL_FILE_TOO_LARGE",
      `Excel 文件超过 ${limits.maxBytes} 字节限制`,
      413,
      { maxBytes: limits.maxBytes },
    );
  }
  const preflight = preflightWorkbookArchive(buffer, limits);
  return isolatedParse(buffer, limits, preflight);
}

function workerSafeError(error) {
  const messages = new Map([
    ["AUTO_LISTING_EXCEL_WORKBOOK_INVALID", ["Excel 文件损坏、加密或格式无效", 400]],
    ["AUTO_LISTING_EXCEL_WORKBOOK_EMPTY", ["Excel 工作簿为空", 400]],
    ["AUTO_LISTING_EXCEL_VISIBLE_SHEET_MISSING", ["Excel 工作簿没有可见工作表", 400]],
    ["AUTO_LISTING_EXCEL_SKU_HEADER_MISSING", ["Excel 缺少 SKU、商品 SKU 或 Ozon SKU 表头", 422]],
    ["AUTO_LISTING_EXCEL_ROW_LIMIT_EXCEEDED", ["Excel 数据范围超过安全行数限制", 413]],
    ["AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED", ["Excel 文件内部内容超过安全限制", 413]],
  ]);
  const [message, status] = messages.get(error?.code)
    || messages.get("AUTO_LISTING_EXCEL_WORKBOOK_INVALID");
  return {
    code: messages.has(error?.code) ? error.code : "AUTO_LISTING_EXCEL_WORKBOOK_INVALID",
    status,
    message,
    details: {
      ...(error?.code === "AUTO_LISTING_EXCEL_ROW_LIMIT_EXCEEDED" && Number.isSafeInteger(error?.maxRows)
        ? { maxRows: error.maxRows }
        : {}),
    },
  };
}

if (!isMainThread && workerData?.kind === "AUTO_LISTING_EXCEL_PARSE_V1") {
  parseWorkbookContent(Buffer.from(workerData.buffer), workerData.limits, {
    normalizeSpreadsheetNamespaces: workerData.normalizeSpreadsheetNamespaces === true,
  }).then(
    (result) => parentPort?.postMessage({ ok: true, result }),
    (error) => parentPort?.postMessage({ ok: false, error: workerSafeError(error) }),
  );
}

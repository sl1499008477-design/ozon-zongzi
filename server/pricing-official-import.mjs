import ExcelJS from "exceljs";
import crypto from "node:crypto";
import { putObjectFromBuffer, removeObject } from "./object-storage.mjs";
import { createOfficialCommissionDraft } from "./pricing-config-service.mjs";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ALLOWED_FULFILLMENTS = new Set(["RFBS", "FBP", "WHD"]);
const MAX_WORKBOOK_BYTES = 8 * 1024 * 1024;
const MAX_WORKBOOK_ROWS = 20_000;

function importError(message, code = "OFFICIAL_COMMISSION_IMPORT_INVALID", status = 422) {
  return Object.assign(new Error(message), { code, status });
}

function cellValue(cell) {
  const value = cell?.value;
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "result")) return value.result;
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text || "").join("");
    if (Object.hasOwn(value, "text")) return value.text;
  }
  return value;
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function decimalPercent(value, context) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw importError(`${context} 的佣金率不是有效数字`);
  const percent = parsed <= 1 ? parsed * 100 : parsed;
  if (percent >= 100) throw importError(`${context} 的佣金率必须小于 100%`);
  return Math.round((percent + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function parseTariffHeader(value) {
  const header = text(value).replace(/,/g, ".");
  const fulfillment = header.match(/\b(RFBS|FBP|WHD)\b/i)?.[1]?.toUpperCase();
  if (!ALLOWED_FULFILLMENTS.has(fulfillment)) return null;
  const range = header.match(/->\s*([0-9.]+)\s*(?:-\s*([0-9.]+)|\+)\s*->/);
  if (!range) return null;
  const minPriceRub = Number(range[1]);
  const maxPriceRub = range[2] === undefined ? null : Number(range[2]);
  if (!Number.isFinite(minPriceRub) || (maxPriceRub !== null && !Number.isFinite(maxPriceRub))) return null;
  return { fulfillment, minPriceRub, maxPriceRub };
}

function tariffColumns(sheet) {
  const columns = [];
  for (let column = 1; column <= sheet.columnCount; column += 1) {
    const parsed = parseTariffHeader(cellValue(sheet.getCell(2, column)));
    if (parsed) columns.push({ ...parsed, column });
  }
  return columns;
}

function sourceDateFromWorkbook(workbook) {
  for (const sheet of workbook.worksheets) {
    for (let row = 1; row <= Math.min(3, sheet.rowCount); row += 1) {
      for (let column = 1; column <= sheet.columnCount; column += 1) {
        const value = text(cellValue(sheet.getCell(row, column)));
        const match = value.match(/starts\s+from\s+(\d{1,2})[/.](\d{1,2})[/.](\d{4})/i);
        if (match) {
          const [, day, month, year] = match;
          return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        }
      }
    }
  }
  return null;
}

function bandLabel({ minPriceRub, maxPriceRub }) {
  return maxPriceRub === null ? `₽${minPriceRub}+` : `₽${minPriceRub}-${maxPriceRub}`;
}

function parseSummaryRules(sheet, source) {
  const tariffs = tariffColumns(sheet);
  if (!tariffs.length) throw importError(`${source.name} 的「MP Tree Tarifs CN」没有识别到 RFBS、FBP 或 WHD 佣金列`);
  const rules = [];
  const fulfillments = new Set(tariffs.map((item) => item.fulfillment));
  for (let row = 3; row <= Math.min(sheet.rowCount, MAX_WORKBOOK_ROWS); row += 1) {
    const marketplaceCategoryRu = text(cellValue(sheet.getCell(row, 4)));
    if (!marketplaceCategoryRu) continue;
    // 该官方汇总表的第 5、6 列实际内容依次为英文、中文，标题语言标记顺序相反。
    const marketplaceCategoryEn = text(cellValue(sheet.getCell(row, 5)));
    const marketplaceCategoryZh = text(cellValue(sheet.getCell(row, 6)));
    for (const tariff of tariffs) {
      const rawRate = cellValue(sheet.getCell(row, tariff.column));
      if (rawRate === null || rawRate === undefined || rawRate === "") continue;
      const commissionRate = decimalPercent(rawRate, `${source.name} 第 ${row} 行`);
      rules.push({
        ruleName: `${marketplaceCategoryZh || marketplaceCategoryRu} · ${tariff.fulfillment} · ${bandLabel(tariff)}`,
        ozonCategoryId: marketplaceCategoryRu,
        categoryKey: marketplaceCategoryRu,
        categoryNameRu: marketplaceCategoryRu,
        categoryNameEn: marketplaceCategoryEn,
        categoryNameZh: marketplaceCategoryZh,
        fulfillmentType: tariff.fulfillment,
        minPriceRub: tariff.minPriceRub,
        maxPriceRub: tariff.maxPriceRub,
        commissionRate,
        priority: 10,
        sourceName: source.name,
        sourceDate: source.sourceDate,
      });
    }
  }
  return { rules, fulfillments: [...fulfillments].sort() };
}

function parseDetailMappings(sheet, allowedFulfillments, source) {
  if (!sheet) return [];
  const tariffs = tariffColumns(sheet).filter((item) => allowedFulfillments.includes(item.fulfillment));
  const mappings = [];
  for (let row = 3; row <= Math.min(sheet.rowCount, MAX_WORKBOOK_ROWS); row += 1) {
    const descriptiveTypeRu = text(cellValue(sheet.getCell(row, 1)));
    const marketplaceCategoryRu = text(cellValue(sheet.getCell(row, 7)));
    if (!descriptiveTypeRu || !marketplaceCategoryRu) continue;
    const tariffJson = {};
    for (const tariff of tariffs) {
      const rawRate = cellValue(sheet.getCell(row, tariff.column));
      if (rawRate === null || rawRate === undefined || rawRate === "") continue;
      tariffJson[tariff.fulfillment] ||= [];
      tariffJson[tariff.fulfillment].push({
        minPriceRub: tariff.minPriceRub,
        maxPriceRub: tariff.maxPriceRub,
        commissionRate: decimalPercent(rawRate, `${source.name} Full ChinaHK 第 ${row} 行`),
      });
    }
    if (!Object.keys(tariffJson).length) continue;
    mappings.push({
      descriptiveTypeRu,
      descriptiveTypeZh: text(cellValue(sheet.getCell(row, 2))),
      descriptiveTypeEn: text(cellValue(sheet.getCell(row, 3))),
      descriptiveCategoryRu: text(cellValue(sheet.getCell(row, 4))),
      descriptiveCategoryZh: text(cellValue(sheet.getCell(row, 5))),
      descriptiveCategoryEn: text(cellValue(sheet.getCell(row, 6))),
      marketplaceCategoryRu,
      marketplaceCategoryZh: text(cellValue(sheet.getCell(row, 8))),
      marketplaceCategoryEn: text(cellValue(sheet.getCell(row, 9))),
      brandName: text(cellValue(sheet.getCell(row, 10))) || "All",
      tariffJson,
    });
  }
  return mappings;
}

export function decodeOfficialWorkbookFile(file = {}) {
  const name = text(file.name);
  if (!name.toLowerCase().endsWith(".xlsx")) throw importError(`仅支持 .xlsx 文件：${name || "未命名文件"}`);
  const raw = String(file.base64 || "");
  const body = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  const buffer = Buffer.from(body, "base64");
  if (!buffer.length) throw importError(`${name} 文件内容为空`);
  if (buffer.length > MAX_WORKBOOK_BYTES) throw importError(`${name} 超过 8MB 导入限制`, "OFFICIAL_COMMISSION_FILE_TOO_LARGE", 413);
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw importError(`${name} 不是有效的 xlsx 文件`);
  return { name, contentType: file.contentType || XLSX_CONTENT_TYPE, buffer };
}

export async function parseOfficialCommissionWorkbook({ name, buffer, contentType = XLSX_CONTENT_TYPE }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const summarySheet = workbook.getWorksheet("MP Tree Tarifs CN");
  if (!summarySheet) throw importError(`${name} 缺少「MP Tree Tarifs CN」工作表`);
  const source = { name, contentType, sourceDate: sourceDateFromWorkbook(workbook) };
  const summary = parseSummaryRules(summarySheet, source);
  const mappings = parseDetailMappings(workbook.getWorksheet("Full ChinaHK"), summary.fulfillments, source);
  if (!summary.rules.length) throw importError(`${name} 没有可导入的官方佣金规则`);
  return {
    ...source,
    fulfillments: summary.fulfillments,
    rules: summary.rules,
    mappings,
    metadata: {
      workbookSheets: workbook.worksheets.map((sheet) => ({ name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount })),
      summaryCategoryCount: new Set(summary.rules.map((rule) => rule.categoryKey)).size,
    },
  };
}

function ruleKey(rule) {
  return [rule.categoryKey, rule.fulfillmentType, rule.minPriceRub, rule.maxPriceRub ?? "∞"].join("|");
}

export function mergeOfficialCommissionImports(imports = []) {
  const rulesByKey = new Map();
  const conflicts = [];
  for (const item of imports) {
    for (const rule of item.rules || []) {
      const key = ruleKey(rule);
      const existing = rulesByKey.get(key);
      if (existing && Number(existing.commissionRate) !== Number(rule.commissionRate)) {
        conflicts.push(`${key}: ${existing.commissionRate}% / ${rule.commissionRate}%`);
        continue;
      }
      rulesByKey.set(key, rule);
    }
  }
  if (conflicts.length) {
    throw importError(`官方佣金表存在冲突：${conflicts.slice(0, 5).join("；")}`, "OFFICIAL_COMMISSION_CONFLICT");
  }
  const rules = [...rulesByKey.values()].sort((left, right) =>
    left.categoryKey.localeCompare(right.categoryKey, "ru") ||
    left.fulfillmentType.localeCompare(right.fulfillmentType) ||
    left.minPriceRub - right.minPriceRub
  );
  const fulfillmentTypes = [...new Set(rules.map((rule) => rule.fulfillmentType))].sort();
  const categoryCount = new Set(rules.map((rule) => rule.categoryKey)).size;
  return {
    rules,
    fulfillmentTypes,
    categoryCount,
    detailMappingCount: imports.reduce((sum, item) => sum + (item.mappings?.length || 0), 0),
  };
}

export const officialCommissionImportLimits = Object.freeze({
  maxFiles: 5,
  maxWorkbookBytes: MAX_WORKBOOK_BYTES,
  contentType: XLSX_CONTENT_TYPE,
});

export async function importOfficialCommissionFiles({ actorId = null, files = [], cloneVersionId = "" } = {}) {
  if (!Array.isArray(files) || !files.length) throw importError("请至少上传一份 Ozon 官方佣金表");
  if (files.length > officialCommissionImportLimits.maxFiles) {
    throw importError(`一次最多导入 ${officialCommissionImportLimits.maxFiles} 份官方佣金表`);
  }
  const decoded = files.map(decodeOfficialWorkbookFile);
  const parsedImports = [];
  for (const file of decoded) parsedImports.push(await parseOfficialCommissionWorkbook(file));
  const merged = mergeOfficialCommissionImports(parsedImports);
  const required = ["RFBS", "FBP", "WHD"];
  const missing = required.filter((type) => !merged.fulfillmentTypes.includes(type));
  if (missing.length) {
    throw importError(`官方佣金表缺少履约类型：${missing.join("、")}`, "OFFICIAL_COMMISSION_FULFILLMENT_MISSING");
  }

  const archivedFiles = [];
  try {
    for (const file of decoded) {
      archivedFiles.push(await putObjectFromBuffer({
        key: `pricing/official-commission/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${file.name}`,
        name: file.name,
        contentType: file.contentType,
        buffer: file.buffer,
      }));
    }
    return await createOfficialCommissionDraft(actorId, {
      cloneVersionId,
      parsedImports,
      archivedFiles,
      merged,
    });
  } catch (error) {
    await Promise.all(archivedFiles.map((file) => removeObject(file.key).catch(() => {})));
    throw error;
  }
}

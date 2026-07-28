import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  mergeOfficialCommissionImports,
  parseOfficialCommissionWorkbook,
} from "../pricing-official-import.mjs";

const workbook = new ExcelJS.Workbook();
const summary = workbook.addWorksheet("MP Tree Tarifs CN");
summary.addRow([null, null, null, null, null, null, "Starts from 01/12/2025"]);
summary.addRow([
  "Блок категорий", "ZH", "EN", "Marcetplace Category", "ZH", "EN",
  "RFBS -> 0 - 1500 -> Тариф, %", "RFBS -> 1500.01 - 5000 -> Тариф, %", "RFBS -> 5000.01+ -> Тариф, %",
  "FBP -> 0 - 1500 -> Тариф, %", "FBP -> 1500.01 - 5000 -> Тариф, %", "FBP -> 5000.01+ -> Тариф, %",
  "WHD -> 0 - 1500 -> Тариф, %", "WHD -> 1500.01 - 5000 -> Тариф, %", "WHD -> 5000.01+ -> Тариф, %",
]);
summary.addRow(["Дом", "Home", "家居", "Освещение", "Lighting", "照明", 0.12, 0.14, 0.18, 0.11, 0.13, 0.17, 0.17, 0.19, 0.21]);

const detail = workbook.addWorksheet("Full ChinaHK");
detail.addRow([null, null, null, null, null, null, null, null, null, "Starts from 01/12/2025"]);
detail.addRow([
  "DescriptiveType", "ZH", "EN", "DescriptiveCategory3", "ZH", "EN", "MP Category", "ZH", "EN", "Brand",
  "RFBS -> 0 - 1500 -> Тариф, %", "RFBS -> 1500.01 - 5000 -> Тариф, %", "RFBS -> 5000.01+ -> Тариф, %",
  "FBP -> 0 - 1500 -> Тариф, %", "FBP -> 1500.01 - 5000 -> Тариф, %", "FBP -> 5000.01+ -> Тариф, %",
  "WHD -> 0 - 1500 -> Тариф, %", "WHD -> 1500.01 - 5000 -> Тариф, %", "WHD -> 5000.01+ -> Тариф, %",
]);
detail.addRow(["Светильник", "灯具", "Light", "Освещение", "照明", "Lighting", "Освещение", "照明", "Lighting", "All", 0.12, 0.14, 0.18, 0.11, 0.13, 0.17, 0.17, 0.19, 0.21]);

const buffer = await workbook.xlsx.writeBuffer();
const parsed = await parseOfficialCommissionWorkbook({ name: "official.xlsx", buffer: Buffer.from(buffer) });
assert.equal(parsed.sourceDate, "2025-12-01");
assert.deepEqual(parsed.fulfillments, ["FBP", "RFBS", "WHD"]);
assert.equal(parsed.rules.length, 9);
assert.equal(parsed.rules.find((rule) => rule.fulfillmentType === "RFBS" && rule.minPriceRub === 0).commissionRate, 12);
assert.equal(parsed.mappings.length, 1);
assert.equal(parsed.mappings[0].tariffJson.WHD[2].commissionRate, 21);

const merged = mergeOfficialCommissionImports([parsed]);
assert.equal(merged.categoryCount, 1);
assert.equal(merged.rules.length, 9);
assert.equal(merged.detailMappingCount, 1);

console.log("pricing official commission parser tests passed");

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  COLLECTOR_EXCEL_COLUMNS,
  COLLECTOR_EXCEL_GROUPS,
  COLLECTOR_EXCEL_IMAGE_COLUMNS,
  COLLECTOR_EXCEL_IMAGE_LIMITS,
  buildCollectorExcelBuffer,
  collectorExcelRowValues,
  downloadCollectorExcelImage,
  resolveCollectorExcelRow,
} from "../collector-excel-service.mjs";

const EXPECTED_KEYS = [
  "id", "link", "cover", "nameLabel", "chineseName", "category3", "commissionRfbs", "commissionFbp",
  "brand", "price", "oPrice", "rating", "reviewCountLabel", "sellerNumber", "followMinPrice",
  "nullableCreateDate", "releaseDate", "salesSchema", "gmvSum", "salesDynamics", "soldCount",
  "avgGmvOnAccDays", "avgOrdersOnAccDays", "sessionCountSearch", "sessionCount", "convToCartSearch",
  "convToCartPdp", "drr", "daysInPromo", "discount", "promoRevenueShare", "daysWithTrafarets",
  "avgPrice", "sumMissedGmv", "accessibility", "avgDeliveryDays", "volume", "length", "width", "height",
  "weight", "fbsPrice", "internalExpress", "logisticsMoney", "endDeliveryFee", "rubExpressPrice",
  "elsePrice", "1688link", "cover2", "cover3", "sourcePrice", "sourceRemark", "resMoney",
  "estimateMoney", "estimateMoneyRub", "myActualProfitPercent", "myProfit", "price1", "oPrice1",
  "followMinPrice1", "sellerNumber1", "otherProfitPercent", "otherProfit",
];

const EXPECTED_HEADERS = [
  "商品ID", "商品链接", "商品主图", "商品名称", "商品名称（中文）", "商品类目", "类目佣金（RFBS）",
  "类目佣金（FBP）", "品牌", "销售价格（₽）", "原价（₽）", "商品评分", "评价次数", "跟卖人数",
  "跟卖最低价", "商品创建日期", "上架时间（天）", "发货模式", "月销售额(₽)", "月销售动态(%)",
  "月销量(件)", "平均日销售额(₽)", "平均日销量(件)", "搜索和目录浏览量", "商品卡片浏览量",
  "搜索和目录加购率(%)", "商品卡片加购率(%)", "广告份额（%）", "参与促销天数", "参与促销折扣(%)",
  "促销活动的转化率(%)", "付费推广天数", "平均价格(₽)", "已错过销售(₽)", "商品可用性(%)",
  "配送时间（天）", "商品体积（升）", "包装长(mm)", "包装宽(mm)", "包装高(mm)", "包装重量(g)",
  "RFBS佣金(元)", "国际物流", "国际物流费用（元）", "尾程派送费", "国内运费（元）",
  "其他费用（提现、货损）（元）", "货源地址", "货源图片", "商品主图", "货源价格（元）", "货源备注",
  "我的售价（元）", "预期售价（元）", "预期售价（卢布）", "我的利润率（%）", "我的利润（元）",
  "对方销售价格（₽）", "对方原价（₽）", "跟卖最低价", "跟卖人数", "对方利润率（%）", "对方利润（元）",
];

const EXPECTED_WIDTHS = [
  15, 30, 20, 30, 30, 20, 15, 15, 20, 15, 15, 10, 10, 10, 15, 15, 15, 15, 15, 15, 10,
  15, 10, 15, 15, 15, 15, 10, 12, 15, 15, 12, 15, 15, 15, 12, 12, 12, 12, 12, 12, 15,
  15, 15, 15, 15, 20, 30, 20, 20, 15, 20, 15, 15, 15, 15, 15, 15, 15, 15, 10, 15, 15,
];

assert.equal(COLLECTOR_EXCEL_COLUMNS.length, 63);
assert.deepEqual(COLLECTOR_EXCEL_COLUMNS.map(({ key }) => key), EXPECTED_KEYS);
assert.deepEqual(COLLECTOR_EXCEL_COLUMNS.map(({ header }) => header), EXPECTED_HEADERS);
assert.deepEqual(COLLECTOR_EXCEL_COLUMNS.map(({ width }) => width), EXPECTED_WIDTHS);
assert.deepEqual(COLLECTOR_EXCEL_IMAGE_COLUMNS, { cover: 3, cover2: 49, cover3: 50 });
assert.deepEqual(
  COLLECTOR_EXCEL_GROUPS.map(({ title, cell, range }) => ({ title, cell, range })),
  [
    { title: "基础信息", cell: "A1", range: "A1:Q1" },
    { title: "销售数据", cell: "R1", range: "R1:AI1" },
    { title: "尺寸重量", cell: "AJ1", range: "AJ1:AN1" },
    { title: "我的定价", cell: "AO1", range: "AO1:BK1" },
  ],
);

function columnNumber(letters) {
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

class FakeCell {
  constructor() {
    this.value = null;
    this.font = null;
    this.alignment = null;
    this.fill = null;
    this.border = null;
  }
}

class FakeRow {
  constructor(number) {
    this.number = number;
    this.cells = new Map();
    this.height = undefined;
    this.font = null;
    this.alignment = null;
    this.fill = null;
    this.border = null;
  }

  getCell(index) {
    if (!this.cells.has(index)) this.cells.set(index, new FakeCell());
    return this.cells.get(index);
  }
}

class FakeWorksheet {
  constructor(name) {
    this.name = name;
    this.rows = new Map();
    this.merges = [];
    this.imagePlacements = [];
    this.maxRow = 0;
    this._columns = [];
  }

  set columns(columns) {
    this._columns = columns.map((column) => ({ ...column }));
  }

  get columns() {
    return this._columns;
  }

  getRow(number) {
    if (!this.rows.has(number)) this.rows.set(number, new FakeRow(number));
    this.maxRow = Math.max(this.maxRow, number);
    return this.rows.get(number);
  }

  getCell(address) {
    const match = String(address).toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!match) throw new Error(`invalid address ${address}`);
    return this.getRow(Number(match[2])).getCell(columnNumber(match[1]));
  }

  mergeCells(range) {
    this.merges.push(range);
  }

  addRow(values) {
    const row = this.getRow(this.maxRow + 1);
    values.forEach((value, index) => {
      row.getCell(index + 1).value = value;
    });
    return row;
  }

  getColumn(index) {
    return this._columns[index - 1];
  }

  addImage(imageId, anchor) {
    this.imagePlacements.push({ imageId, anchor });
  }
}

let capturedWorkbook = null;

class FakeWorkbook {
  constructor() {
    capturedWorkbook = this;
    this.worksheets = [];
    this.images = [];
    this.xlsx = {
      writeBuffer: async () => Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x58, 0x4c, 0x53, 0x58]),
    };
  }

  addWorksheet(name) {
    const worksheet = new FakeWorksheet(name);
    this.worksheets.push(worksheet);
    return worksheet;
  }

  addImage(image) {
    const imageId = this.images.length + 1;
    this.images.push({ imageId, ...image });
    return imageId;
  }
}

const exportPriority = resolveCollectorExcelRow({
  id: "wrapper-id",
  raw_payload: { id: "raw-snake", nameLabel: "raw snake" },
  rawPayload: { id: "raw-camel", nameLabel: "raw camel", price: 800 },
  export_data: { id: "export-snake", nameLabel: "export snake" },
  exportData: { id: "export-camel", nameLabel: "export camel", price: 900 },
});
assert.equal(exportPriority.id, "export-camel");
assert.equal(exportPriority.nameLabel, "export camel");
assert.equal(exportPriority.price, 900);

const legacyScopeRow = resolveCollectorExcelRow({
  id: "legacy-wrapper",
  operatingStoreId: "legacy-operating",
  dataCollectionStoreId: "legacy-data",
  rawPayload: {
    operatingStoreId: "raw-operating",
    dataCollectionStoreId: "raw-data",
    sellerCompanyId: "raw-seller",
  },
  exportData: {
    operatingStoreId: "export-operating",
    dataCollectionStoreId: "export-data",
    sellerCompanyId: "export-seller",
  },
  legacyScope: {
    operatingStoreId: "legacy-operating",
    dataCollectionStoreId: "legacy-data",
  },
});
assert.equal(Object.hasOwn(legacyScopeRow, "operatingStoreId"), false);
assert.equal(Object.hasOwn(legacyScopeRow, "dataCollectionStoreId"), false);
assert.equal(Object.hasOwn(legacyScopeRow, "sellerCompanyId"), false);
assert.equal(Object.hasOwn(legacyScopeRow, "legacyScope"), false);

const nestedScopeRow = resolveCollectorExcelRow({
  id: "nested-scope",
  analytics: {
    series: [{
      ClientId: "retired-client",
      DATA_COLLECTION_STORE: { id: "retired-data" },
      keep: "analytics-value",
    }],
  },
  exportData: {
    nested: {
      seller_company_id: "retired-seller",
      legacy_scope: { arbitrary: "forged" },
      keep: "export-value",
    },
  },
});
assert.deepEqual(nestedScopeRow.analytics, {
  series: [{ keep: "analytics-value" }],
});
assert.deepEqual(nestedScopeRow.nested, { keep: "export-value" });

const rowValues = collectorExcelRowValues({
  rawPayload: { id: "raw", nameLabel: "raw title", price: 800 },
  exportData: { id: "export", nameLabel: "export title", price: 900, otherProfit: 12.5 },
});
assert.equal(rowValues.length, 63);
assert.equal(rowValues[0], "export");
assert.equal(rowValues[3], "export title");
assert.equal(rowValues[9], 900);
assert.equal(rowValues[62], 12.5);

const imageErrors = [];
const downloadCalls = [];
const convertCalls = [];
const items = [
  {
    id: "collector-wrapper",
    rawPayload: {
      id: "ozon-raw",
      nameLabel: "raw name",
      price: 1000,
      cover: "https://img/main-ok.jpg",
      cover2: "https://img/source-ok.webp",
      cover3: "https://img/main-ok.jpg",
    },
    exportData: {
      id: "ozon-export",
      link: "https://ozon.ru/product/ozon-export",
      nameLabel: "export name",
      price: 1200,
      sourcePrice: 23.5,
      myProfit: 8.75,
      cover: "https://img/main-ok.jpg",
      cover2: "https://img/source-ok.webp",
      cover3: "https://img/main-ok.jpg",
    },
  },
  {
    raw_payload: JSON.stringify({
      id: "ozon-raw-only",
      nameLabel: "raw only name",
      price: 700,
      cover: "https://img/download-fail.jpg",
      cover2: "https://img/convert-fail.webp",
    }),
  },
  {
    id: "ozon-direct",
    nameLabel: "direct name",
    sourcePrice: 11,
  },
];

const output = await buildCollectorExcelBuffer(items, {
  exceljs: { Workbook: FakeWorkbook },
  downloadImage: async (url, context) => {
    downloadCalls.push({ url, context });
    if (url.includes("download-fail")) throw Object.assign(new Error("download failed"), { code: "TEST_DOWNLOAD_FAILED" });
    return {
      buffer: Buffer.from(url.includes("source-ok") || url.includes("convert-fail") ? "webp-bytes" : "jpeg-bytes"),
      extension: url.endsWith(".jpg") ? "jpeg" : "webp",
    };
  },
  convertImage: async (buffer, context) => {
    convertCalls.push({ buffer, context });
    if (context.url.includes("convert-fail")) throw Object.assign(new Error("convert failed"), { code: "TEST_CONVERT_FAILED" });
    return context.url.includes("source-ok")
      ? { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), extension: "png" }
      : { buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), extension: "jpeg" };
  },
  onImageError: (error, context) => imageErrors.push({ error, context }),
});

assert.equal(Buffer.isBuffer(output), true);
assert.deepEqual([...output.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
assert.ok(capturedWorkbook);
assert.equal(capturedWorkbook.worksheets.length, 1);
const worksheet = capturedWorkbook.worksheets[0];
assert.equal(worksheet.name, "Sheet1");
assert.deepEqual(worksheet.merges, ["A1:Q1", "R1:AI1", "AJ1:AN1", "AO1:BK1"]);
assert.equal(worksheet.getCell("A1").value, "基础信息");
assert.equal(worksheet.getCell("R1").value, "销售数据");
assert.equal(worksheet.getCell("AJ1").value, "尺寸重量");
assert.equal(worksheet.getCell("AO1").value, "我的定价");

const groupHeader = worksheet.getRow(1);
assert.deepEqual(groupHeader.font, { bold: true, size: 12 });
assert.deepEqual(groupHeader.alignment, { vertical: "middle", horizontal: "center" });
assert.equal(groupHeader.fill.fgColor.argb, "fff3ca");
assert.equal(groupHeader.border.top.style, "thin");
const columnHeader = worksheet.getRow(2);
assert.deepEqual(columnHeader.font, { bold: true, size: 10 });
assert.equal(columnHeader.fill.fgColor.argb, "d9d9d9");
assert.deepEqual(
  EXPECTED_HEADERS,
  Array.from({ length: 63 }, (_, index) => columnHeader.getCell(index + 1).value),
);

const exportedRow = worksheet.getRow(3);
assert.equal(exportedRow.getCell(1).value, "ozon-export");
assert.equal(exportedRow.getCell(2).value, "https://ozon.ru/product/ozon-export");
assert.equal(exportedRow.getCell(4).value, "export name");
assert.equal(exportedRow.getCell(10).value, 1200);
assert.equal(exportedRow.getCell(51).value, 23.5);
assert.equal(exportedRow.getCell(57).value, 8.75);
assert.deepEqual(exportedRow.getCell(63).alignment, {
  vertical: "middle",
  horizontal: "center",
  wrapText: true,
});

const rawFallbackRow = worksheet.getRow(4);
assert.equal(rawFallbackRow.getCell(1).value, "ozon-raw-only");
assert.equal(rawFallbackRow.getCell(4).value, "raw only name");
assert.equal(rawFallbackRow.getCell(10).value, 700);
const directRow = worksheet.getRow(5);
assert.equal(directRow.getCell(1).value, "ozon-direct");
assert.equal(directRow.getCell(4).value, "direct name");
assert.equal(directRow.getCell(51).value, 11);

assert.equal(exportedRow.height, 80);
assert.equal(worksheet.getColumn(3).width, 15);
assert.equal(worksheet.getColumn(49).width, 15);
assert.equal(worksheet.getColumn(50).width, 15);
assert.deepEqual(
  worksheet.imagePlacements.slice(0, 3).map(({ anchor }) => anchor.tl.col),
  [2, 48, 49],
  "images must be placed at 1-based columns 3, 49 and 50",
);
assert.deepEqual(
  worksheet.imagePlacements.slice(0, 3).map(({ anchor }) => anchor.tl.row),
  [2, 2, 2],
);
assert.equal(worksheet.imagePlacements[0].anchor.br.row, 2.999);
assert.equal(worksheet.imagePlacements[0].anchor.editAs, "oneCell");
assert.equal(capturedWorkbook.images.length, 2, "identical main images should reuse one workbook image id");
assert.equal(downloadCalls.filter(({ url }) => url.includes("main-ok")).length, 1);
assert.equal(convertCalls.filter(({ context }) => context.url.includes("main-ok")).length, 1);

assert.ok(imageErrors.some(({ error }) => error.code === "TEST_DOWNLOAD_FAILED"));
assert.ok(imageErrors.some(({ error }) => error.code === "TEST_CONVERT_FAILED"));
assert.equal(worksheet.rows.size, 5, "image errors must not remove headers or data rows");
assert.equal(rawFallbackRow.getCell(1).value, "ozon-raw-only", "image errors must not corrupt row data");

await assert.rejects(
  () => buildCollectorExcelBuffer({}, { exceljs: { Workbook: FakeWorkbook } }),
  (error) => error?.code === "COLLECTOR_EXCEL_ITEMS_INVALID",
);

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);
const onePixelDataUrl = `data:image/png;base64,${onePixelPng.toString("base64")}`;

const decodedDataImage = await downloadCollectorExcelImage(onePixelDataUrl);
assert.equal(decodedDataImage.extension, "png");
assert.deepEqual(decodedDataImage.buffer, onePixelPng);
assert.equal(COLLECTOR_EXCEL_IMAGE_LIMITS.maxRedirects, 3);

await assert.rejects(
  () => downloadCollectorExcelImage("file:///etc/passwd"),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_PROTOCOL_BLOCKED",
);
await assert.rejects(
  () => downloadCollectorExcelImage("http://localhost/image.png"),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_HOST_BLOCKED",
);
await assert.rejects(
  () => downloadCollectorExcelImage("http://169.254.169.254/latest/meta-data"),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_PRIVATE_ADDRESS",
);
await assert.rejects(
  () => downloadCollectorExcelImage("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="),
  (error) => error?.code === "COLLECTOR_EXCEL_DATA_URL_INVALID",
);
await assert.rejects(
  () => downloadCollectorExcelImage(onePixelDataUrl, { maxDataUrlBytes: 32 }),
  (error) => error?.code === "COLLECTOR_EXCEL_DATA_URL_TOO_LARGE",
);
await assert.rejects(
  () => downloadCollectorExcelImage(onePixelDataUrl, { maxImageBytes: 32 }),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_TOO_LARGE",
);

await assert.rejects(
  () => downloadCollectorExcelImage("https://images.sonli.example/a.png", {
    imageDnsLookup: async () => [{ address: "10.0.0.9", family: 4 }],
  }),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_PRIVATE_ADDRESS",
  "a public-looking hostname resolving to a private IP must be blocked before connection",
);
await assert.rejects(
  () => downloadCollectorExcelImage("https://images.sonli.example/a.png", {
    imageDnsLookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  }),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_PRIVATE_ADDRESS",
  "mixed public/private DNS answers must fail closed",
);

function fakeImageRequester(definitions, captures = []) {
  let index = 0;
  return (target, requestOptions, onResponse) => {
    const definition = definitions[Math.min(index, definitions.length - 1)] || {};
    index += 1;
    captures.push({ target: target.href, requestOptions });
    const request = new EventEmitter();
    request.setTimeout = (_timeoutMs, callback) => {
      if (definition.timeout) queueMicrotask(callback);
      return request;
    };
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    request.end = () => {
      if (definition.timeout) return;
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = definition.status ?? 200;
        response.headers = definition.headers || {};
        response.resume = () => {};
        response.destroy = () => {};
        onResponse(response);
        for (const chunk of definition.chunks || []) response.emit("data", chunk);
        response.emit("end");
      });
    };
    return request;
  };
}

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const requestCaptures = [];
const safeHttpImage = await downloadCollectorExcelImage("https://images.sonli.example/a.png", {
  imageDnsLookup: publicDns,
  imageRequest: fakeImageRequester([{
    headers: { "content-type": "image/png", "content-length": String(onePixelPng.length) },
    chunks: [onePixelPng],
  }], requestCaptures),
});
assert.deepEqual(safeHttpImage.buffer, onePixelPng);
assert.equal(requestCaptures.length, 1);
await new Promise((resolve, reject) => {
  requestCaptures[0].requestOptions.lookup("images.sonli.example", {}, (error, address, family) => {
    if (error) reject(error);
    else {
      assert.equal(address, "93.184.216.34");
      assert.equal(family, 4);
      resolve();
    }
  });
});

await assert.rejects(
  () => downloadCollectorExcelImage("https://images.sonli.example/not-image", {
    imageDnsLookup: publicDns,
    imageRequest: fakeImageRequester([{
      headers: { "content-type": "text/html" },
      chunks: [Buffer.from("<html></html>")],
    }]),
  }),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_CONTENT_TYPE_BLOCKED",
);
await assert.rejects(
  () => downloadCollectorExcelImage("https://images.sonli.example/mismatch", {
    imageDnsLookup: publicDns,
    imageRequest: fakeImageRequester([{
      headers: { "content-type": "image/jpeg" },
      chunks: [onePixelPng],
    }]),
  }),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_SIGNATURE_INVALID",
);
await assert.rejects(
  () => downloadCollectorExcelImage("https://images.sonli.example/redirect", {
    imageDnsLookup: publicDns,
    imageRequest: fakeImageRequester([{
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    }]),
  }),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_PRIVATE_ADDRESS",
  "redirect targets must receive the same SSRF validation",
);
await assert.rejects(
  () => downloadCollectorExcelImage("https://images.sonli.example/redirect-loop", {
    imageDnsLookup: publicDns,
    imageRequest: fakeImageRequester([{
      status: 302,
      headers: { location: "/redirect-loop" },
    }]),
    maxImageRedirects: 0,
  }),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_REDIRECT_LIMIT",
);
await assert.rejects(
  () => downloadCollectorExcelImage("https://images.sonli.example/huge", {
    imageDnsLookup: publicDns,
    imageRequest: fakeImageRequester([{
      headers: { "content-type": "image/png", "content-length": "100" },
    }]),
    maxImageBytes: 16,
  }),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_TOO_LARGE",
);
await assert.rejects(
  () => downloadCollectorExcelImage("https://images.sonli.example/slow", {
    imageDnsLookup: publicDns,
    imageRequest: fakeImageRequester([{ timeout: true }]),
  }),
  (error) => error?.code === "COLLECTOR_EXCEL_IMAGE_TIMEOUT",
);

const injectedLimitErrors = [];
await buildCollectorExcelBuffer([{ id: "oversized", cover: "custom:image" }], {
  exceljs: { Workbook: FakeWorkbook },
  downloadImage: async () => ({ buffer: Buffer.alloc(5), extension: "jpeg" }),
  convertImage: async (buffer) => ({ buffer, extension: "jpeg" }),
  maxImageBytes: 4,
  onImageError: (error) => injectedLimitErrors.push(error),
});
assert.ok(injectedLimitErrors.some((error) => error.code === "COLLECTOR_EXCEL_IMAGE_TOO_LARGE"));

const cacheLimitErrors = [];
await buildCollectorExcelBuffer([
  { id: "cache-a", cover: "custom:a" },
  { id: "cache-b", cover: "custom:b" },
], {
  exceljs: { Workbook: FakeWorkbook },
  downloadImage: async () => ({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), extension: "jpeg" }),
  convertImage: async (buffer) => ({ buffer, extension: "jpeg" }),
  maxImageBytes: 8,
  maxImageCacheBytes: 5,
  onImageError: (error) => cacheLimitErrors.push(error),
});
assert.ok(cacheLimitErrors.some((error) => error.code === "COLLECTOR_EXCEL_IMAGE_CACHE_LIMIT"));

console.log("collector excel service tests passed");

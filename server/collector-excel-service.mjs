import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const freezeEntries = (entries) => Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));

export const COLLECTOR_EXCEL_IMAGE_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  maxRedirects: 3,
  maxImageBytes: 8 * 1024 * 1024,
  maxDataUrlBytes: 11 * 1024 * 1024,
  maxImageCacheBytes: 64 * 1024 * 1024,
});

const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

const BLOCKED_IMAGE_HOSTS = new Set([
  "instance-data.ec2.internal",
  "metadata.google.internal",
  "metadata.goog",
]);

// Source of truth: the recovered collector's 63-column export contract.
export const COLLECTOR_EXCEL_COLUMNS = freezeEntries([
  { header: "商品ID", key: "id", width: 15 },
  { header: "商品链接", key: "link", width: 30 },
  { header: "商品主图", key: "cover", width: 20 },
  { header: "商品名称", key: "nameLabel", width: 30 },
  { header: "商品名称（中文）", key: "chineseName", width: 30 },
  { header: "商品类目", key: "category3", width: 20 },
  { header: "类目佣金（RFBS）", key: "commissionRfbs", width: 15 },
  { header: "类目佣金（FBP）", key: "commissionFbp", width: 15 },
  { header: "品牌", key: "brand", width: 20 },
  { header: "销售价格（₽）", key: "price", width: 15 },
  { header: "原价（₽）", key: "oPrice", width: 15 },
  { header: "商品评分", key: "rating", width: 10 },
  { header: "评价次数", key: "reviewCountLabel", width: 10 },
  { header: "跟卖人数", key: "sellerNumber", width: 10 },
  { header: "跟卖最低价", key: "followMinPrice", width: 15 },
  { header: "商品创建日期", key: "nullableCreateDate", width: 15 },
  { header: "上架时间（天）", key: "releaseDate", width: 15 },
  { header: "发货模式", key: "salesSchema", width: 15 },
  { header: "月销售额(₽)", key: "gmvSum", width: 15 },
  { header: "月销售动态(%)", key: "salesDynamics", width: 15 },
  { header: "月销量(件)", key: "soldCount", width: 10 },
  { header: "平均日销售额(₽)", key: "avgGmvOnAccDays", width: 15 },
  { header: "平均日销量(件)", key: "avgOrdersOnAccDays", width: 10 },
  { header: "搜索和目录浏览量", key: "sessionCountSearch", width: 15 },
  { header: "商品卡片浏览量", key: "sessionCount", width: 15 },
  { header: "搜索和目录加购率(%)", key: "convToCartSearch", width: 15 },
  { header: "商品卡片加购率(%)", key: "convToCartPdp", width: 15 },
  { header: "广告份额（%）", key: "drr", width: 10 },
  { header: "参与促销天数", key: "daysInPromo", width: 12 },
  { header: "参与促销折扣(%)", key: "discount", width: 15 },
  { header: "促销活动的转化率(%)", key: "promoRevenueShare", width: 15 },
  { header: "付费推广天数", key: "daysWithTrafarets", width: 12 },
  { header: "平均价格(₽)", key: "avgPrice", width: 15 },
  { header: "已错过销售(₽)", key: "sumMissedGmv", width: 15 },
  { header: "商品可用性(%)", key: "accessibility", width: 15 },
  { header: "配送时间（天）", key: "avgDeliveryDays", width: 12 },
  { header: "商品体积（升）", key: "volume", width: 12 },
  { header: "包装长(mm)", key: "length", width: 12 },
  { header: "包装宽(mm)", key: "width", width: 12 },
  { header: "包装高(mm)", key: "height", width: 12 },
  { header: "包装重量(g)", key: "weight", width: 12 },
  { header: "RFBS佣金(元)", key: "fbsPrice", width: 15 },
  { header: "国际物流", key: "internalExpress", width: 15 },
  { header: "国际物流费用（元）", key: "logisticsMoney", width: 15 },
  { header: "尾程派送费", key: "endDeliveryFee", width: 15 },
  { header: "国内运费（元）", key: "rubExpressPrice", width: 15 },
  { header: "其他费用（提现、货损）（元）", key: "elsePrice", width: 20 },
  { header: "货源地址", key: "1688link", width: 30 },
  { header: "货源图片", key: "cover2", width: 20 },
  { header: "商品主图", key: "cover3", width: 20 },
  { header: "货源价格（元）", key: "sourcePrice", width: 15 },
  { header: "货源备注", key: "sourceRemark", width: 20 },
  { header: "我的售价（元）", key: "resMoney", width: 15 },
  { header: "预期售价（元）", key: "estimateMoney", width: 15 },
  { header: "预期售价（卢布）", key: "estimateMoneyRub", width: 15 },
  { header: "我的利润率（%）", key: "myActualProfitPercent", width: 15 },
  { header: "我的利润（元）", key: "myProfit", width: 15 },
  { header: "对方销售价格（₽）", key: "price1", width: 15 },
  { header: "对方原价（₽）", key: "oPrice1", width: 15 },
  { header: "跟卖最低价", key: "followMinPrice1", width: 15 },
  { header: "跟卖人数", key: "sellerNumber1", width: 10 },
  { header: "对方利润率（%）", key: "otherProfitPercent", width: 15 },
  { header: "对方利润（元）", key: "otherProfit", width: 15 },
]);

export const COLLECTOR_EXCEL_GROUPS = freezeEntries([
  { title: "基础信息", cell: "A1", range: "A1:Q1" },
  { title: "销售数据", cell: "R1", range: "R1:AI1" },
  { title: "尺寸重量", cell: "AJ1", range: "AJ1:AN1" },
  { title: "我的定价", cell: "AO1", range: "AO1:BK1" },
]);

export const COLLECTOR_EXCEL_IMAGE_COLUMNS = Object.freeze({
  cover: 3,
  cover2: 49,
  cover3: 50,
});

const HEADER_BORDER = Object.freeze({
  top: Object.freeze({ style: "thin" }),
  left: Object.freeze({ style: "thin" }),
  bottom: Object.freeze({ style: "thin" }),
  right: Object.freeze({ style: "thin" }),
});

function serviceError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function imageLimits(options = {}) {
  return {
    timeoutMs: positiveInteger(
      options.imageTimeoutMs ?? options.timeoutMs,
      COLLECTOR_EXCEL_IMAGE_LIMITS.timeoutMs,
      { min: 250, max: 60_000 },
    ),
    maxRedirects: positiveInteger(
      options.maxImageRedirects ?? options.maxRedirects,
      COLLECTOR_EXCEL_IMAGE_LIMITS.maxRedirects,
      { min: 0, max: 10 },
    ),
    maxImageBytes: positiveInteger(
      options.maxImageBytes,
      COLLECTOR_EXCEL_IMAGE_LIMITS.maxImageBytes,
      { min: 1, max: 64 * 1024 * 1024 },
    ),
    maxDataUrlBytes: positiveInteger(
      options.maxDataUrlBytes,
      COLLECTOR_EXCEL_IMAGE_LIMITS.maxDataUrlBytes,
      { min: 32, max: 96 * 1024 * 1024 },
    ),
    maxImageCacheBytes: positiveInteger(
      options.maxImageCacheBytes,
      COLLECTOR_EXCEL_IMAGE_LIMITS.maxImageCacheBytes,
      { min: 1, max: 512 * 1024 * 1024 },
    ),
  };
}

function errorWithStatus(message, code, status = 400, details = {}) {
  return Object.assign(serviceError(message, code), { status, ...details });
}

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function ipv4Octets(address) {
  if (isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return octets.length === 4 ? octets : null;
}

function isBlockedIpv4(address) {
  const octets = ipv4Octets(address);
  if (!octets) return true;
  const [a, b, c, d] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 168 && b === 63 && c === 129 && d === 16) return true;
  return false;
}

function ipv6Groups(address) {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase().split("%")[0];
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const ipv4 = ipv4Octets(normalized.slice(separator + 1));
    if (!ipv4) return null;
    normalized = `${normalized.slice(0, separator)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if (omitted < 0 || (halves.length === 1 && omitted !== 0)) return null;
  const groups = [...left, ...Array(omitted).fill("0"), ...right].map((part) => Number.parseInt(part || "0", 16));
  return groups.length === 8 && groups.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? groups
    : null;
}

function isBlockedIpv6(address) {
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [first, second] = groups;
  // Only globally routable unicast is accepted. This rejects loopback,
  // unspecified, IPv4-compatible/mapped, ULA, link-local and multicast.
  if ((first & 0xe000) !== 0x2000) return true;
  if (first === 0x2001 && second === 0x0db8) return true; // documentation
  if (first === 0x2001 && (second & 0xfff0) === 0x0010) return true; // ORCHID
  if (first === 0x2001 && second === 0x0000) return true; // Teredo transition range
  if (first === 0x2002) {
    const third = groups[2];
    const embedded = `${second >> 8}.${second & 0xff}.${third >> 8}.${third & 0xff}`;
    return isBlockedIpv4(embedded);
  }
  return false;
}

function isBlockedIpAddress(address) {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function assertAllowedHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw errorWithStatus("图片 URL 缺少主机名", "COLLECTOR_EXCEL_IMAGE_URL_INVALID");
  }
  if (
    BLOCKED_IMAGE_HOSTS.has(normalized)
    || ["localhost", "localhost.localdomain"].includes(normalized)
    || [".localhost", ".local", ".localdomain", ".internal", ".lan", ".home"].some((suffix) => normalized.endsWith(suffix))
  ) {
    throw errorWithStatus("图片 URL 指向本机、内网或云元数据主机", "COLLECTOR_EXCEL_IMAGE_HOST_BLOCKED");
  }
  if (isIP(normalized) && isBlockedIpAddress(normalized)) {
    throw errorWithStatus("图片 URL 指向本机、私网、链路本地或保留 IP", "COLLECTOR_EXCEL_IMAGE_PRIVATE_ADDRESS");
  }
  return normalized;
}

function remainingTimeout(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw errorWithStatus("图片下载超时", "COLLECTOR_EXCEL_IMAGE_TIMEOUT", 504);
  }
  return remaining;
}

async function promiseBeforeDeadline(promise, deadline) {
  const timeoutMs = remainingTimeout(deadline);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(errorWithStatus("图片下载超时", "COLLECTOR_EXCEL_IMAGE_TIMEOUT", 504)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAllowedAddresses(hostname, { lookupHost = dnsLookup, deadline }) {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
  let resolved;
  try {
    resolved = await promiseBeforeDeadline(
      Promise.resolve().then(() => lookupHost(hostname, { all: true, verbatim: true })),
      deadline,
    );
  } catch (error) {
    if (error?.code === "COLLECTOR_EXCEL_IMAGE_TIMEOUT") throw error;
    throw serviceError("图片主机 DNS 解析失败", "COLLECTOR_EXCEL_IMAGE_DNS_FAILED", error);
  }
  const entries = (Array.isArray(resolved) ? resolved : [resolved]).map((entry) => {
    const address = typeof entry === "string" ? entry : entry?.address;
    const family = Number(typeof entry === "string" ? isIP(entry) : entry?.family || isIP(address));
    return { address: String(address || ""), family };
  });
  if (!entries.length || entries.some(({ address, family }) => ![4, 6].includes(family) || isIP(address) !== family)) {
    throw errorWithStatus("图片主机没有可用的 IP 地址", "COLLECTOR_EXCEL_IMAGE_DNS_INVALID", 502);
  }
  if (entries.some(({ address }) => isBlockedIpAddress(address))) {
    throw errorWithStatus("图片主机 DNS 解析到了本机、私网、链路本地或保留 IP", "COLLECTOR_EXCEL_IMAGE_PRIVATE_ADDRESS");
  }
  return entries;
}

function assertImageBufferSize(buffer, maxImageBytes, stage = "下载") {
  if (buffer.length > maxImageBytes) {
    throw errorWithStatus(
      `图片${stage}后超过单图 ${maxImageBytes} 字节上限`,
      "COLLECTOR_EXCEL_IMAGE_TOO_LARGE",
      413,
      { maxImageBytes, actualBytes: buffer.length },
    );
  }
  return buffer;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Date);
}

function jsonObject(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * exportData/export_data are authoritative. Raw payloads and wrapper metadata
 * only fill fields not present in the export snapshot.
 */
export function resolveCollectorExcelRow(item = {}) {
  const direct = jsonObject(item);
  if (!Object.keys(direct).length) return {};

  const rawSnake = jsonObject(direct.raw_payload);
  const rawCamel = jsonObject(direct.rawPayload);
  const exportSnake = jsonObject(direct.export_data);
  const exportCamel = jsonObject(direct.exportData);
  const wrapper = { ...direct };
  delete wrapper.raw_payload;
  delete wrapper.rawPayload;
  delete wrapper.export_data;
  delete wrapper.exportData;

  const row = {
    ...wrapper,
    ...rawSnake,
    ...rawCamel,
    ...exportSnake,
    ...exportCamel,
  };
  if ((row.id === undefined || row.id === null || row.id === "") && row.sourceSku) row.id = row.sourceSku;
  if ((row.link === undefined || row.link === null || row.link === "") && row.sourceUrl) row.link = row.sourceUrl;
  return row;
}

function cellValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  if (typeof value === "bigint") return value.toString();
  if (isPlainObject(value) && (value.hyperlink || Array.isArray(value.richText))) return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function collectorExcelRowValues(item = {}) {
  const row = resolveCollectorExcelRow(item);
  return COLLECTOR_EXCEL_COLUMNS.map(({ key }) => cellValue(row[key]));
}

function applyHeaderStyle(row, { size, color }) {
  row.font = { bold: true, size };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
  row.border = HEADER_BORDER;
  for (let index = 1; index <= COLLECTOR_EXCEL_COLUMNS.length; index += 1) {
    const cell = row.getCell(index);
    cell.font = { bold: true, size };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.border = HEADER_BORDER;
  }
}

function initializeWorksheet(workbook, sheetName) {
  const worksheet = workbook.addWorksheet(sheetName);
  worksheet.columns = COLLECTOR_EXCEL_COLUMNS.map(({ key, width }) => ({ key, width }));

  const groupRow = worksheet.getRow(1);
  for (const group of COLLECTOR_EXCEL_GROUPS) {
    worksheet.getCell(group.cell).value = group.title;
    worksheet.mergeCells(group.range);
  }
  applyHeaderStyle(groupRow, { size: 12, color: "fff3ca" });

  const headerRow = worksheet.getRow(2);
  COLLECTOR_EXCEL_COLUMNS.forEach((column, index) => {
    headerRow.getCell(index + 1).value = column.header;
  });
  applyHeaderStyle(headerRow, { size: 10, color: "d9d9d9" });
  return worksheet;
}

function toBuffer(value, label = "图片") {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw serviceError(`${label}数据不是 Buffer、Uint8Array 或 ArrayBuffer`, "COLLECTOR_EXCEL_IMAGE_INVALID");
}

function sniffExtension(buffer, hint = "") {
  const normalizedHint = String(hint || "").toLowerCase().replace("jpg", "jpeg");
  if (["png", "jpeg", "gif"].includes(normalizedHint)) return normalizedHint;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "gif";
  throw serviceError("图片格式不是 ExcelJS 支持的 PNG/JPEG/GIF，需要注入 convertImage 转换", "COLLECTOR_EXCEL_IMAGE_CONVERSION_REQUIRED");
}

function normalizeDownloadedImage(value, maxImageBytes) {
  if (isPlainObject(value) && value.buffer !== undefined) {
    const buffer = assertImageBufferSize(toBuffer(value.buffer), maxImageBytes, "下载");
    return {
      buffer,
      extension: value.extension || "",
      contentType: value.contentType || value.content_type || "",
    };
  }
  return { buffer: assertImageBufferSize(toBuffer(value), maxImageBytes, "下载"), extension: "", contentType: "" };
}

function normalizeConvertedImage(value, context, maxImageBytes) {
  const converted = isPlainObject(value) && value.buffer !== undefined
    ? { buffer: toBuffer(value.buffer), extension: value.extension || "" }
    : { buffer: toBuffer(value), extension: "" };
  assertImageBufferSize(converted.buffer, maxImageBytes, "转换");
  const contentTypeExtension = String(context.contentType || "").split("/").pop();
  converted.extension = sniffExtension(
    converted.buffer,
    converted.extension || context.extension || contentTypeExtension,
  );
  return converted;
}

function normalizedContentType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function sniffRasterFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") return "bmp";
  if (
    buffer.length >= 4
    && (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
      || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))
  ) return "tiff";
  if (
    buffer.length >= 16
    && buffer.subarray(4, 8).toString("ascii") === "ftyp"
    && /avif|avis/.test(buffer.subarray(8, Math.min(buffer.length, 64)).toString("ascii"))
  ) return "avif";
  return "";
}

function assertImageSignature(buffer, contentType) {
  const expected = normalizedContentType(contentType).replace(/^image\//, "").replace("jpg", "jpeg");
  const actual = sniffRasterFormat(buffer);
  if (!actual || actual !== expected) {
    throw errorWithStatus(
      `图片内容与 Content-Type 不匹配：声明 ${contentType || "缺失"}，识别为 ${actual || "未知"}`,
      "COLLECTOR_EXCEL_IMAGE_SIGNATURE_INVALID",
      415,
    );
  }
  return buffer;
}

function decodeDataImage(target, limits) {
  if (Buffer.byteLength(target, "utf8") > limits.maxDataUrlBytes) {
    throw errorWithStatus(
      `data 图片 URL 超过 ${limits.maxDataUrlBytes} 字节上限`,
      "COLLECTOR_EXCEL_DATA_URL_TOO_LARGE",
      413,
      { maxDataUrlBytes: limits.maxDataUrlBytes },
    );
  }
  const separator = target.indexOf(",");
  const metadata = separator >= 0 ? target.slice(0, separator) : target;
  const payload = separator >= 0 ? target.slice(separator + 1) : "";
  const match = metadata.match(/^data:image\/(png|jpe?g|gif|webp);base64$/i);
  if (!match || !payload || payload.length % 4 !== 0 || !/^[a-z0-9+/]*={0,2}$/i.test(payload)) {
    throw errorWithStatus(
      "data 图片只允许 PNG/JPEG/GIF/WebP 的规范 base64 编码",
      "COLLECTOR_EXCEL_DATA_URL_INVALID",
    );
  }
  const paddingBytes = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const decodedBytes = payload.length / 4 * 3 - paddingBytes;
  if (decodedBytes > limits.maxImageBytes) {
    throw errorWithStatus(
      `data 图片解码后可能超过单图 ${limits.maxImageBytes} 字节上限`,
      "COLLECTOR_EXCEL_IMAGE_TOO_LARGE",
      413,
      { maxImageBytes: limits.maxImageBytes },
    );
  }
  const buffer = assertImageBufferSize(Buffer.from(payload, "base64"), limits.maxImageBytes, "解码");
  const canonicalPayload = payload.replace(/=+$/, "");
  if (buffer.toString("base64").replace(/=+$/, "") !== canonicalPayload) {
    throw errorWithStatus("data 图片的 base64 编码无效", "COLLECTOR_EXCEL_DATA_URL_INVALID");
  }
  const rawExtension = match[1].toLowerCase();
  const extension = rawExtension === "jpg" ? "jpeg" : rawExtension;
  assertImageSignature(buffer, `image/${extension}`);
  return { buffer, extension, contentType: `image/${extension}` };
}

function validateHttpTarget(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch (error) {
    throw serviceError("图片 URL 无效", "COLLECTOR_EXCEL_IMAGE_URL_INVALID", error);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw errorWithStatus("图片 URL 只允许 http 或 https 协议", "COLLECTOR_EXCEL_IMAGE_PROTOCOL_BLOCKED");
  }
  if (parsed.username || parsed.password) {
    throw errorWithStatus("图片 URL 不允许包含认证信息", "COLLECTOR_EXCEL_IMAGE_URL_CREDENTIALS_BLOCKED");
  }
  if (Buffer.byteLength(parsed.href, "utf8") > 8192) {
    throw errorWithStatus("图片 URL 超过 8192 字节上限", "COLLECTOR_EXCEL_IMAGE_URL_TOO_LONG", 413);
  }
  assertAllowedHostname(parsed.hostname);
  return parsed;
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : String(value || "");
}

async function requestImageOnce(target, { deadline, limits, lookupHost, requestImage }) {
  const hostname = assertAllowedHostname(target.hostname);
  const addresses = await resolveAllowedAddresses(hostname, { lookupHost, deadline });
  const selected = addresses[0];
  const transport = target.protocol === "https:" ? https : http;
  const requestTimeout = remainingTimeout(deadline);

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      callback(value);
    };
    const createRequest = requestImage || transport.request.bind(transport);
    const request = createRequest(target, {
      method: "GET",
      agent: false,
      family: selected.family,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      },
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp,image/tiff;q=0.8",
        "Accept-Encoding": "identity",
        "User-Agent": "Sonli-Collector-Image-Exporter/1.0",
      },
    }, (response) => {
      const status = Number(response.statusCode || 0);
      const location = headerValue(response.headers.location);
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        try {
          finish(resolve, { redirect: new URL(location, target) });
        } catch (error) {
          finish(reject, serviceError("图片重定向 URL 无效", "COLLECTOR_EXCEL_IMAGE_REDIRECT_INVALID", error));
        }
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(reject, errorWithStatus(
          `图片下载失败：HTTP ${status || "未知"}`,
          "COLLECTOR_EXCEL_IMAGE_DOWNLOAD_FAILED",
          502,
        ));
        return;
      }
      const contentType = normalizedContentType(response.headers["content-type"]);
      if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
        response.resume();
        finish(reject, errorWithStatus(
          `图片响应 Content-Type 不受支持：${contentType || "缺失"}`,
          "COLLECTOR_EXCEL_IMAGE_CONTENT_TYPE_BLOCKED",
          415,
        ));
        return;
      }
      const contentEncoding = headerValue(response.headers["content-encoding"]).trim().toLowerCase();
      if (contentEncoding && contentEncoding !== "identity") {
        response.resume();
        finish(reject, errorWithStatus(
          `图片响应不允许 Content-Encoding：${contentEncoding}`,
          "COLLECTOR_EXCEL_IMAGE_CONTENT_ENCODING_BLOCKED",
          415,
        ));
        return;
      }
      const declaredLength = Number(headerValue(response.headers["content-length"]));
      if (Number.isFinite(declaredLength) && declaredLength > limits.maxImageBytes) {
        response.resume();
        finish(reject, errorWithStatus(
          `图片 Content-Length 超过单图 ${limits.maxImageBytes} 字节上限`,
          "COLLECTOR_EXCEL_IMAGE_TOO_LARGE",
          413,
          { maxImageBytes: limits.maxImageBytes, actualBytes: declaredLength },
        ));
        return;
      }
      const chunks = [];
      let totalBytes = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > limits.maxImageBytes) {
          const error = errorWithStatus(
            `图片下载后超过单图 ${limits.maxImageBytes} 字节上限`,
            "COLLECTOR_EXCEL_IMAGE_TOO_LARGE",
            413,
            { maxImageBytes: limits.maxImageBytes, actualBytes: totalBytes },
          );
          finish(reject, error);
          response.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        const buffer = Buffer.concat(chunks, totalBytes);
        try {
          assertImageSignature(buffer, contentType);
          finish(resolve, { buffer, contentType });
        } catch (error) {
          finish(reject, error);
        }
      });
      response.on("aborted", () => finish(reject, errorWithStatus(
        "图片响应在读取完成前中断",
        "COLLECTOR_EXCEL_IMAGE_DOWNLOAD_FAILED",
        502,
      )));
      response.on("error", (error) => finish(reject, serviceError(
        "读取图片响应失败",
        "COLLECTOR_EXCEL_IMAGE_DOWNLOAD_FAILED",
        error,
      )));
    });
    request.setTimeout(requestTimeout, () => {
      request.destroy(errorWithStatus("图片下载超时", "COLLECTOR_EXCEL_IMAGE_TIMEOUT", 504));
    });
    deadlineTimer = setTimeout(() => {
      request.destroy(errorWithStatus("图片下载超时", "COLLECTOR_EXCEL_IMAGE_TIMEOUT", 504));
    }, requestTimeout);
    deadlineTimer.unref?.();
    request.on("error", (error) => {
      if (error?.code === "COLLECTOR_EXCEL_IMAGE_TIMEOUT") finish(reject, error);
      else finish(reject, serviceError("图片下载请求失败", "COLLECTOR_EXCEL_IMAGE_DOWNLOAD_FAILED", error));
    });
    request.end();
  });
}

/**
 * Default downloader with protocol, redirect, DNS/IP, timeout and byte limits.
 * The DNS result is pinned into the actual socket lookup to avoid a second,
 * unchecked resolution between validation and connection.
 */
export async function downloadCollectorExcelImage(url, options = {}) {
  const targetText = String(url || "").trim();
  const limits = imageLimits(options);
  if (targetText.toLowerCase().startsWith("data:")) return decodeDataImage(targetText, limits);
  let target = validateHttpTarget(targetText);
  const deadline = Date.now() + limits.timeoutMs;
  const lookupHost = options.imageDnsLookup || options.lookupHost || dnsLookup;
  for (let redirectCount = 0; ; redirectCount += 1) {
    const result = await requestImageOnce(target, {
      deadline,
      limits,
      lookupHost,
      requestImage: options.imageRequest,
    });
    if (!result.redirect) {
      result.buffer = assertImageBufferSize(result.buffer, limits.maxImageBytes, "下载");
      return result;
    }
    if (redirectCount >= limits.maxRedirects) {
      throw errorWithStatus(
        `图片重定向超过 ${limits.maxRedirects} 次上限`,
        "COLLECTOR_EXCEL_IMAGE_REDIRECT_LIMIT",
        502,
      );
    }
    target = validateHttpTarget(result.redirect.href);
  }
}

async function defaultConvertImage(buffer, context) {
  return {
    buffer,
    extension: sniffExtension(buffer, context.extension || String(context.contentType || "").split("/").pop()),
  };
}

function imageUrl(value) {
  if (typeof value === "string") return value.trim();
  if (isPlainObject(value)) return String(value.url || value.src || "").trim();
  return "";
}

async function resolveExcelJs(options) {
  let moduleValue = options.exceljs || options.excelJs;
  if (!moduleValue) {
    try {
      moduleValue = options.loadExcelJs ? await options.loadExcelJs() : await import("exceljs");
    } catch (error) {
      throw serviceError("缺少 exceljs 运行时依赖，请在服务部署环境提供 exceljs@4.4.x", "COLLECTOR_EXCELJS_MISSING", error);
    }
  }
  const candidate = moduleValue.default || moduleValue;
  const ExcelJS = typeof candidate.Workbook === "function" ? candidate : moduleValue;
  if (typeof ExcelJS?.Workbook !== "function") {
    throw serviceError("exceljs 模块没有 Workbook 导出", "COLLECTOR_EXCELJS_INVALID");
  }
  return ExcelJS;
}

async function reportImageError(callback, error, context) {
  if (typeof callback !== "function") return;
  try {
    await callback(error, context);
  } catch {
    // Diagnostics must never turn an optional image failure into export failure.
  }
}

function imagePlacements(row) {
  const cover = imageUrl(row.cover);
  const cover2 = imageUrl(row.cover2);
  const cover3 = imageUrl(row.cover3) || cover;
  return [
    { kind: "cover", profile: "main", column: COLLECTOR_EXCEL_IMAGE_COLUMNS.cover, url: cover },
    { kind: "cover2", profile: "source", column: COLLECTOR_EXCEL_IMAGE_COLUMNS.cover2, url: cover2 },
    { kind: "cover3", profile: "main", column: COLLECTOR_EXCEL_IMAGE_COLUMNS.cover3, url: cover3 },
  ].filter((placement) => placement.url);
}

function imageCacheKey(profile, url) {
  return `${profile}:${createHash("sha256").update(url).digest("base64url")}`;
}

async function addRowImages({
  workbook,
  worksheet,
  rowObject,
  sourceRow,
  downloadImage,
  convertImage,
  onImageError,
  imageCache,
  imageBudget,
  limits,
}) {
  for (const placement of imagePlacements(sourceRow)) {
    const cacheKey = imageCacheKey(placement.profile, placement.url);
    const context = {
      kind: placement.kind,
      column: placement.column,
      rowNumber: rowObject.number,
      url: placement.url,
      item: sourceRow,
    };
    try {
      const cacheEntry = imageCache.get(cacheKey);
      if (cacheEntry?.error) throw cacheEntry.error;
      let imageId = cacheEntry?.imageId;
      if (!cacheEntry) {
        const downloaded = normalizeDownloadedImage(
          await downloadImage(placement.url, context),
          limits.maxImageBytes,
        );
        const converted = normalizeConvertedImage(
          await convertImage(downloaded.buffer, {
            ...context,
            extension: downloaded.extension,
            contentType: downloaded.contentType,
            maxImageBytes: limits.maxImageBytes,
          }),
          downloaded,
          limits.maxImageBytes,
        );
        if (imageBudget.bytes + converted.buffer.length > limits.maxImageCacheBytes) {
          throw errorWithStatus(
            `工作簿图片累计超过 ${limits.maxImageCacheBytes} 字节上限`,
            "COLLECTOR_EXCEL_IMAGE_CACHE_LIMIT",
            413,
            {
              maxImageCacheBytes: limits.maxImageCacheBytes,
              actualBytes: imageBudget.bytes + converted.buffer.length,
            },
          );
        }
        imageId = workbook.addImage({ buffer: converted.buffer, extension: converted.extension });
        imageCache.set(cacheKey, { imageId });
        imageBudget.bytes += converted.buffer.length;
      }
      rowObject.height = 80;
      worksheet.getColumn(placement.column).width = 15;
      worksheet.addImage(imageId, {
        tl: { col: placement.column - 1, row: rowObject.number - 1 },
        br: { col: placement.column, row: rowObject.number - 1 + 0.999 },
        editAs: "oneCell",
      });
    } catch (error) {
      if (!imageCache.has(cacheKey)) imageCache.set(cacheKey, { error });
      await reportImageError(onImageError, error, context);
    }
  }
}

/**
 * Builds the recovered 63-column collector workbook entirely in memory.
 *
 * @param {Array<object>} items collector_task_items or direct export rows
 * @param {object} options
 * @param {object} [options.exceljs] injected ExcelJS module (tests/bundled runtime)
 * @param {Function} [options.downloadImage] async (url, context) => Buffer|{buffer,extension,contentType}
 * @param {Function} [options.convertImage] async (buffer, context) => Buffer|{buffer,extension}
 * @param {Function} [options.onImageError] optional non-fatal diagnostic callback
 * @returns {Promise<Buffer>} XLSX bytes
 */
export async function buildCollectorExcelBuffer(items, options = {}) {
  if (!Array.isArray(items)) {
    throw serviceError("collector items 必须是数组", "COLLECTOR_EXCEL_ITEMS_INVALID");
  }
  const ExcelJS = await resolveExcelJs(options);
  const workbook = new ExcelJS.Workbook();
  const worksheet = initializeWorksheet(workbook, options.sheetName || "Sheet1");
  const limits = imageLimits(options);
  const downloadImage = options.downloadImage
    || ((url) => downloadCollectorExcelImage(url, options));
  const convertImage = options.convertImage || defaultConvertImage;
  const imageCache = new Map();
  const imageBudget = { bytes: 0 };

  for (const item of items) {
    const sourceRow = resolveCollectorExcelRow(item);
    const rowObject = worksheet.addRow(COLLECTOR_EXCEL_COLUMNS.map(({ key }) => cellValue(sourceRow[key])));
    for (let index = 1; index <= COLLECTOR_EXCEL_COLUMNS.length; index += 1) {
      rowObject.getCell(index).alignment = {
        vertical: "middle",
        horizontal: "center",
        wrapText: true,
      };
    }
    await addRowImages({
      workbook,
      worksheet,
      rowObject,
      sourceRow,
      downloadImage,
      convertImage,
      onImageError: options.onImageError,
      imageCache,
      imageBudget,
      limits,
    });
  }

  const output = await workbook.xlsx.writeBuffer();
  return toBuffer(output, "XLSX");
}

export const createCollectorExcelBuffer = buildCollectorExcelBuffer;

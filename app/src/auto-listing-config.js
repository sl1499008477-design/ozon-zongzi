const RATIOS = new Set(["16:9", "9:16", "2:3", "3:2", "1:1", "3:4", "4:3"]);
const RESOLUTIONS = new Set(["1K", "2K", "4K"]);
const QUALITIES = new Set(["Low", "Medium", "High", "Ultra"]);
const LANGUAGES = new Set(["ru"]);
const ROLE_RANGES = Object.freeze({
  main: [1, 1],
  sellingPoint: [2, 5],
  detail: [1, 2],
  scene: [1, 2],
  specification: [0, 1],
  infographic: [1, 2],
});

const DEFAULT_ROLES = Object.freeze({
  main: 1,
  sellingPoint: 3,
  detail: 1,
  scene: 1,
  specification: 1,
  infographic: 1,
});

export const AUTO_LISTING_IMAGE_DEFAULTS = Object.freeze({
  ratio: "3:4",
  resolution: "1K",
  quality: "Medium",
  language: "ru",
  roles: DEFAULT_ROLES,
  total: 8,
});

function configError(code = "AUTO_LISTING_CONFIG_INVALID") {
  const error = new Error(code);
  error.code = code;
  return error;
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function onlyKeys(value, allowed) {
  return plain(value) && Object.keys(value).every((key) => allowed.has(key));
}

function requiredId(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 240) throw configError();
  return result;
}

function signedInteger(value = "0") {
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value.trim())) throw configError();
  return String(BigInt(value.trim()));
}

export function kopecksToRubles(value = "0") {
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value.trim())) throw configError();
  const amount = BigInt(value.trim());
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  const decimals = fraction === 0n ? "" : `.${String(fraction).padStart(2, "0")}`;
  return `${negative ? "-" : ""}${whole}${decimals}`;
}

function option(value, fallback, allowed) {
  const result = value ?? fallback;
  if (!allowed.has(result)) throw configError();
  return result;
}

function rolesFor(requested = {}, hasReliableProductDimensions) {
  if (!onlyKeys(requested, new Set(Object.keys(ROLE_RANGES)))) throw configError();
  const output = {};
  for (const [role, [minimum, maximum]] of Object.entries(ROLE_RANGES)) {
    let count = requested[role] ?? DEFAULT_ROLES[role];
    if (role === "specification" && !hasReliableProductDimensions) count = 0;
    if (!Number.isInteger(count) || count < minimum || count > maximum) throw configError();
    output[role] = count;
  }
  return Object.freeze(output);
}

export function deriveAutoListingConfig(input = {}, {
  hasReliableProductDimensions = true,
} = {}) {
  if (!onlyKeys(input, new Set([
    "targetStoreId", "targetWarehouseId", "stock", "priceAdjustmentKopecks", "image",
  ])) || !Number.isInteger(input.stock) || input.stock <= 0) throw configError();
  const imageInput = input.image ?? {};
  if (!onlyKeys(imageInput, new Set(["ratio", "resolution", "quality", "language", "roles"]))) {
    throw configError();
  }
  const roles = rolesFor(imageInput.roles ?? {}, hasReliableProductDimensions === true);
  const total = Object.values(roles).reduce((sum, count) => sum + count, 0);
  if (total < 6 || total > 13) throw configError();
  return Object.freeze({
    targetStoreId: requiredId(input.targetStoreId),
    targetWarehouseId: requiredId(input.targetWarehouseId),
    stock: input.stock,
    priceAdjustmentKopecks: signedInteger(input.priceAdjustmentKopecks),
    image: Object.freeze({
      ratio: option(imageInput.ratio, AUTO_LISTING_IMAGE_DEFAULTS.ratio, RATIOS),
      resolution: option(imageInput.resolution, AUTO_LISTING_IMAGE_DEFAULTS.resolution, RESOLUTIONS),
      quality: option(imageInput.quality, AUTO_LISTING_IMAGE_DEFAULTS.quality, QUALITIES),
      language: option(imageInput.language, AUTO_LISTING_IMAGE_DEFAULTS.language, LANGUAGES),
      roles,
      total,
    }),
  });
}

function parseKopecks(value, { positive = false } = {}) {
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value.trim())) throw configError("PRICE_INPUT_INVALID");
  const result = BigInt(value.trim());
  if (positive && result <= 0n) throw configError("PRICE_INPUT_INVALID");
  return result;
}

function roundHalfUp(numerator, denominator) {
  return (numerator + (denominator / 2n)) / denominator;
}

function rubleText(kopecks) {
  const whole = kopecks / 100n;
  const fraction = String(kopecks % 100n).padStart(2, "0");
  return `${whole}.${fraction} ₽`;
}

export function previewAutoListingPrice(input = {}) {
  if (!plain(input) || input.currency !== "RUB") throw configError("PRICE_CURRENCY_NOT_RUB");
  const black = parseKopecks(input.blackKopecks, { positive: true });
  const adjustment = parseKopecks(input.adjustmentKopecks ?? "0");
  let branch;
  let real;
  if (black >= 8_000n) {
    branch = "BLACK_GTE_80";
    const green = parseKopecks(input.greenKopecks, { positive: true });
    if (green > black) throw configError("PRICE_INPUT_INVALID");
    real = roundHalfUp((black - green) * 225n, 100n) + black;
  } else {
    branch = "BLACK_LT_80";
    real = roundHalfUp(black * 10_000n, 10_715n);
  }
  const finalPrice = real + adjustment;
  if (finalPrice <= 0n) throw configError("PRICE_FINAL_NOT_POSITIVE");
  return Object.freeze({
    currency: "RUB",
    branch,
    realPriceKopecks: String(real),
    adjustmentKopecks: String(adjustment),
    finalPriceKopecks: String(finalPrice),
    finalPriceText: rubleText(finalPrice),
  });
}

function firstText(...values) {
  for (const value of values) {
    const result = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
    if (result) return result;
  }
  return "";
}

export function autoListingWarehouseOptions({
  warehouses = [],
  targetStoreId = "",
  selectedWarehouseId = "",
} = {}) {
  const storeId = firstText(targetStoreId);
  const options = (Array.isArray(warehouses) ? warehouses : [])
    .filter((warehouse) => firstText(warehouse?.storeId, warehouse?.store_id) === storeId
      && warehouse?.listingEligibility?.eligible === true)
    .map((warehouse) => ({
      value: firstText(warehouse.warehouse_id, warehouse.warehouseId),
      label: firstText(warehouse.name, warehouse.label, warehouse.warehouse_name, warehouse.warehouse_id),
    }))
    .filter((entry) => entry.value && entry.label);
  const selected = firstText(selectedWarehouseId);
  return Object.freeze({
    options,
    selectedWarehouseId: options.some((entry) => entry.value === selected) ? selected : "",
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") throw configError("AUTO_LISTING_EXCEL_FILE_INVALID");
  let digest;
  try { digest = await subtle.digest("SHA-256", bytes); } catch {
    throw configError("AUTO_LISTING_EXCEL_FILE_INVALID");
  }
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function autoListingExcelSerializedBodyLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) {
    throw configError("AUTO_LISTING_EXCEL_FILE_INVALID");
  }
  return Math.ceil(maxBytes / 3) * 4 + 256 * 1024;
}

export async function readExcelFileAsBase64(file, { maxBytes = 2_097_152 } = {}) {
  const name = typeof file?.name === "string" ? file.name.trim() : "";
  const contentType = typeof file?.type === "string" ? file.type.trim() : "";
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !name.toLowerCase().endsWith(".xlsx") || /[/\\\u0000-\u001f\u007f]/u.test(name)
    || contentType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || !Number.isSafeInteger(file?.size) || file.size < 1
    || typeof file?.arrayBuffer !== "function") {
    throw configError("AUTO_LISTING_EXCEL_FILE_INVALID");
  }
  if (file.size > maxBytes) throw configError("AUTO_LISTING_EXCEL_FILE_TOO_LARGE");
  const buffer = await file.arrayBuffer();
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== file.size || buffer.byteLength > maxBytes) {
    throw configError("AUTO_LISTING_EXCEL_FILE_INVALID");
  }
  const bytes = new Uint8Array(buffer);
  return Object.freeze({
    name,
    contentType,
    dataBase64: bytesToBase64(bytes),
    sizeBytes: bytes.byteLength,
    contentSha256: await sha256Hex(bytes),
  });
}

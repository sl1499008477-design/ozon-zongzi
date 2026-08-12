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

const CURRENCY_PRESENTATIONS = Object.freeze({
  RUB: Object.freeze({ currency: "RUB", name: "卢布", symbol: "₽" }),
  CNY: Object.freeze({ currency: "CNY", name: "人民币", symbol: "¥" }),
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

export function amountToMinorUnits(value = "0") {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? "").trim());
  if (!match) throw configError("AUTO_LISTING_PRICE_ADJUSTMENT_INVALID");
  const amount = (BigInt(match[2]) * 100n) + BigInt((match[3] || "").padEnd(2, "0") || "0");
  return String(match[1] === "-" ? -amount : amount);
}

export function autoListingCurrencyPresentation(value) {
  const currency = typeof value === "string" ? value.trim().toUpperCase() : "";
  const presentation = CURRENCY_PRESENTATIONS[currency];
  if (!presentation) throw configError("PRICE_CURRENCY_UNSUPPORTED");
  return presentation;
}

export function shouldResetAutoListingAdjustment(previousCurrency, nextCurrency) {
  const next = autoListingCurrencyPresentation(nextCurrency).currency;
  if (previousCurrency === null || previousCurrency === undefined || previousCurrency === "") return false;
  return autoListingCurrencyPresentation(previousCurrency).currency !== next;
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

function currencyText(currency, minorUnits) {
  const presentation = autoListingCurrencyPresentation(currency);
  const whole = minorUnits / 100n;
  const fraction = String(minorUnits % 100n).padStart(2, "0");
  const amount = `${whole}.${fraction}`;
  return presentation.currency === "CNY" ? `${presentation.symbol}${amount}` : `${amount} ${presentation.symbol}`;
}

export function previewAutoListingPrice(input = {}) {
  if (!plain(input)) throw configError("PRICE_CURRENCY_UNSUPPORTED");
  const currency = autoListingCurrencyPresentation(input.currency).currency;
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
    currency,
    branch,
    realPriceKopecks: String(real),
    adjustmentKopecks: String(adjustment),
    finalPriceKopecks: String(finalPrice),
    finalPriceText: currencyText(currency, finalPrice),
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
    .filter((warehouse) => {
      if (firstText(warehouse?.storeId, warehouse?.store_id) !== storeId) return false;
      const eligibility = warehouse?.listingEligibility;
      const fulfillmentType = firstText(eligibility?.fulfillmentType).toUpperCase();
      const eligible = eligibility?.eligible === true
        && ((fulfillmentType === "FBS" && eligibility?.evidenceRequired === false)
          || (fulfillmentType === "RFBS" && eligibility?.evidenceRequired === true));
      const pendingRfbs = eligibility?.eligible === false
        && eligibility?.code === "RFBS_VALIDATION_REQUIRED"
        && fulfillmentType === "RFBS"
        && eligibility?.evidenceRequired === true;
      return eligible || pendingRfbs;
    })
    .map((warehouse) => {
      const eligibility = warehouse.listingEligibility;
      const fulfillmentType = firstText(eligibility.fulfillmentType).toUpperCase();
      const pending = eligibility.eligible === false;
      const statusLabel = pending ? "创建任务时验证" : "已验证";
      const localWarehouseId = firstText(warehouse.id);
      const platformWarehouseId = firstText(warehouse.warehouse_id, warehouse.warehouseId);
      if (!localWarehouseId || !platformWarehouseId) return null;
      const name = firstText(warehouse.name, warehouse.label, warehouse.warehouse_name, platformWarehouseId);
      const visibleStatus = pending || fulfillmentType === "RFBS" ? ` · ${statusLabel}` : "";
      return Object.freeze({
        value: localWarehouseId,
        label: `${name}（${fulfillmentType}${visibleStatus}）`,
        fulfillmentType,
        evidenceRequired: eligibility.evidenceRequired === true,
        statusLabel,
      });
    })
    .filter((entry) => entry?.value && entry.label);
  const selected = firstText(selectedWarehouseId);
  return Object.freeze({
    options: Object.freeze(options),
    selectedWarehouseId: options.some((entry) => entry.value === selected) ? selected : "",
  });
}

const AUTO_LISTING_RFBS_ERROR_MESSAGES = Object.freeze({
  AUTO_LISTING_SOURCE_VERSION_CONFLICT: "来源资料版本已变化，请刷新后重试",
  RFBS_WAREHOUSE_NOT_FOUND: "未在当前店铺找到该 RFBS 仓库，请同步仓库后重试",
  RFBS_WAREHOUSE_DISABLED: "该 RFBS 仓库当前不可用，请在 Ozon 启用或改选其他仓库",
  RFBS_WAREHOUSE_SCOPE_MISMATCH: "仓库与当前店铺不匹配，请重新选择店铺和仓库",
  RFBS_WAREHOUSE_CHANGED: "RFBS 仓库信息已变化，请同步仓库后重新选择",
  RFBS_WAREHOUSE_EVIDENCE_EXPIRED: "RFBS 仓库验证已过期，请重试创建任务",
  RFBS_VALIDATION_REQUIRED: "Ozon 仓库验证暂时不可用，请稍后重试",
  AUTO_LISTING_RFBS_VALIDATION_FAILED: "RFBS 仓库验证失败，请稍后重试或联系管理员",
  UNSUPPORTED_FULFILLMENT_TYPE: "该仓库类型暂不支持自动上架，请选择 FBS 或 RFBS 仓库",
  AUTO_LISTING_STRATEGY_NOT_PUBLISHED: "尚未发布自动上架内容策略，请先由管理员发布策略",
  AUTO_LISTING_UPLOAD_POLICY_NOT_PUBLISHED: "尚未发布自动上架 REVIEW 上传策略，请先由管理员发布策略",
});

export function autoListingTaskErrorMessage(error) {
  let code = "";
  let message = "";
  try {
    code = typeof error?.code === "string" ? error.code : "";
    message = typeof error?.message === "string" ? error.message.trim() : "";
  } catch {
    return "任务创建失败";
  }
  return AUTO_LISTING_RFBS_ERROR_MESSAGES[code] || message || "任务创建失败";
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

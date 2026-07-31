import { findRetiredCollectorScopePath } from "./collector-scope-sanitizer.mjs";

export const OZON_ENRICHMENT_CONTRACT_VERSION = "collector.ozon.enrichment.v1";

const REQUIRED_FIELDS = Object.freeze([
  "descriptionCategoryId",
  "weightG",
  "lengthMm",
  "widthMm",
  "heightMm",
]);

const ATTRIBUTE_IDS = Object.freeze({
  weightG: "4497",
  weightKg: "4383",
  lengthMm: "9454",
  widthMm: "9455",
  heightMm: "9456",
});

function contractError(message, status, code, details = {}) {
  return Object.assign(new Error(message), { status, code, ...details });
}

function positiveNumber(value) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  } catch {
    return 0;
  }
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function assertNoRetiredCollectorScope(body) {
  const forbidden = findRetiredCollectorScopePath(body);
  if (forbidden) {
    throw contractError(
      `补全请求不能指定账号或店铺范围：${forbidden}`,
      400,
      "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
    );
  }
}

function assertRequestShape(body, allowedKeys) {
  assertNoRetiredCollectorScope(body);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw contractError("补全请求格式无效", 400, "OZON_ENRICH_REQUEST_INVALID");
  }
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    throw contractError("补全请求包含不允许的字段", 400, "OZON_ENRICH_REQUEST_INVALID");
  }
}

function requiredText(value, label, code) {
  const text = cleanText(value);
  if (!text) throw contractError(`补全请求缺少${label}`, 400, code);
  return text;
}

function attributesByKey(variantData) {
  const attributes = Array.isArray(variantData?.attributes) ? variantData.attributes : [];
  const values = new Map();
  for (const attribute of attributes) {
    const key = cleanText(attribute?.key);
    if (!key) continue;
    const current = values.get(key) || [];
    current.push(attribute?.value);
    values.set(key, current);
  }
  return values;
}

function firstPositive(...values) {
  for (const value of values.flat()) {
    const number = positiveNumber(value);
    if (number) return number;
  }
  return 0;
}

function enrichmentFieldValues(value = {}) {
  const logistics = value?.logistics && typeof value.logistics === "object" ? value.logistics : {};
  return {
    descriptionCategoryId: value?.descriptionCategoryId,
    weightG: value?.weightG ?? logistics.weightG ?? value?.weight,
    lengthMm: value?.lengthMm ?? logistics.lengthMm ?? value?.depth,
    widthMm: value?.widthMm ?? logistics.widthMm ?? value?.width,
    heightMm: value?.heightMm ?? logistics.heightMm ?? value?.height,
  };
}

export function parseOzonEnrichmentRequest(body) {
  assertRequestShape(body, ["requestId", "sku"]);
  return {
    requestId: requiredText(body.requestId, "requestId", "OZON_ENRICH_REQUEST_ID_REQUIRED"),
    sku: requiredText(body.sku, "SKU", "OZON_ENRICH_SKU_REQUIRED"),
  };
}

export function parseOzonBatchEnrichmentRequest(body) {
  assertRequestShape(body, ["requestId", "skus"]);
  const requestId = requiredText(body.requestId, "requestId", "OZON_ENRICH_REQUEST_ID_REQUIRED");
  if (!Array.isArray(body.skus) || !body.skus.length) {
    throw contractError("补全请求缺少 SKU 列表", 400, "OZON_ENRICH_BATCH_SKUS_REQUIRED");
  }
  const skus = [];
  const seen = new Set();
  for (const rawSku of body.skus) {
    const sku = requiredText(rawSku, "SKU", "OZON_ENRICH_SKU_REQUIRED");
    if (!seen.has(sku)) {
      seen.add(sku);
      skus.push(sku);
    }
  }
  if (skus.length >= 21) {
    throw contractError("单次补全最多 20 个 SKU", 400, "OZON_ENRICH_BATCH_LIMIT");
  }
  return { requestId, skus };
}

export function missingOzonRequiredFields(value) {
  const fields = enrichmentFieldValues(value);
  return REQUIRED_FIELDS.filter((field) => !positiveNumber(fields[field]));
}

export function normalizeOzonAgentResult({ sku, variantData, source, capturedAt } = {}) {
  const attributeValues = attributesByKey(variantData);
  const logistics = {
    weightG: firstPositive(
      attributeValues.get(ATTRIBUTE_IDS.weightG),
      (attributeValues.get(ATTRIBUTE_IDS.weightKg) || []).map((value) => positiveNumber(value) * 1000),
      variantData?.weight,
    ),
    lengthMm: firstPositive(attributeValues.get(ATTRIBUTE_IDS.lengthMm), variantData?.depth),
    widthMm: firstPositive(attributeValues.get(ATTRIBUTE_IDS.widthMm), variantData?.width),
    heightMm: firstPositive(attributeValues.get(ATTRIBUTE_IDS.heightMm), variantData?.height),
  };
  const result = {
    status: "COMPLETE",
    contractVersion: OZON_ENRICHMENT_CONTRACT_VERSION,
    sku: cleanText(sku),
    descriptionCategoryId: positiveNumber(variantData?.description_category_id),
    logistics,
    variantData,
    source: cleanText(source),
    capturedAt: cleanText(capturedAt),
  };
  const typeId = positiveNumber(variantData?.type_id);
  if (typeId) result.typeId = typeId;
  const missingFields = missingOzonRequiredFields(result);
  if (missingFields.length) {
    throw contractError(
      `Ozon 商品资料不完整：${missingFields.join(", ")}`,
      422,
      "OZON_ENRICH_INCOMPLETE",
      { missingFields },
    );
  }
  return result;
}

export function assertCompleteOzonCollectPayload(source, payload) {
  if (cleanText(source).toLowerCase() !== "ozon") return;
  const missingFields = missingOzonRequiredFields(payload);
  if (missingFields.length) {
    throw contractError(
      `Ozon 采集商品资料不完整：${missingFields.join(", ")}`,
      422,
      "OZON_COLLECT_INCOMPLETE",
      { missingFields },
    );
  }
}

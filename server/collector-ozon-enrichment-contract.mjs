import { assertOzonRussianProductText } from "./ozon-product-language.mjs";
import { collectedAttributeValues } from "./collector-attribute-values.mjs";
import { findRetiredCollectorScopePath } from "./collector-scope-sanitizer.mjs";
import { missingOzonEnrichmentFields } from "./collect-enrichment-policy.mjs";

export const OZON_ENRICHMENT_CONTRACT_VERSION = "collector.ozon.enrichment.v1";

const ATTRIBUTE_IDS = Object.freeze({
  typeName: "8229",
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
    throw contractError("补全请求格式无效", 400, "ZONGZI_ENRICH_REQUEST_INVALID");
  }
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    throw contractError("补全请求包含不允许的字段", 400, "ZONGZI_ENRICH_REQUEST_INVALID");
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
    current.push(...collectedAttributeValues(attribute).map(value => value?.value));
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

function sourceCategoryEvidence(variantData) {
  const attributes = Array.isArray(variantData?.attributes) ? variantData.attributes : [];
  const typeAttribute = attributes.find(
    (attribute) => cleanText(attribute?.key) === ATTRIBUTE_IDS.typeName,
  );
  const typeValues = collectedAttributeValues(typeAttribute);
  const categories = Array.isArray(variantData?.categories) ? variantData.categories : [];
  const path = [...categories]
    .sort((left, right) => positiveNumber(left?.level) - positiveNumber(right?.level))
    .map((category) => cleanText(category?.title || category?.name))
    .filter((label, index, labels) => label && labels.indexOf(label) === index);
  const evidence = {
    descriptionCategoryId: positiveNumber(variantData?.description_category_id),
    typeName: cleanText(typeValues[0]?.value),
    typeIdCandidate: positiveNumber(
      typeValues[0]?.dictionary_value_id
        ?? typeValues[0]?.dictionaryValueId
        ?? variantData?.type_id
        ?? variantData?.typeId,
    ),
    path,
    attributes: attributes.map((attribute) => {
      const projected = {
        key: cleanText(attribute?.key),
        value: attribute?.value ?? null,
      };
      for (const key of ["values", "collection"]) {
        if (Array.isArray(attribute?.[key])) projected[key] = structuredClone(attribute[key]);
      }
      if (attribute?.dictionary_value_id !== undefined) {
        projected.dictionary_value_id = attribute.dictionary_value_id;
      }
      if (attribute?.dictionaryValueId !== undefined) {
        projected.dictionaryValueId = attribute.dictionaryValueId;
      }
      return projected;
    }).filter((attribute) => attribute.key),
  };
  if (Array.isArray(variantData?.complex_attributes)) {
    evidence.complex_attributes = structuredClone(variantData.complex_attributes);
  }
  return Object.values(evidence).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value),
  )
    ? evidence
    : null;
}

export function parseOzonEnrichmentRequest(body) {
  assertRequestShape(body, ["requestId", "sku"]);
  return {
    requestId: requiredText(body.requestId, "requestId", "ZONGZI_ENRICH_REQUEST_ID_REQUIRED"),
    sku: requiredText(body.sku, "SKU", "ZONGZI_ENRICH_SKU_REQUIRED"),
  };
}

export function parseOzonBatchEnrichmentRequest(body) {
  assertRequestShape(body, ["requestId", "skus"]);
  const requestId = requiredText(body.requestId, "requestId", "ZONGZI_ENRICH_REQUEST_ID_REQUIRED");
  if (!Array.isArray(body.skus) || !body.skus.length) {
    throw contractError("补全请求缺少 SKU 列表", 400, "ZONGZI_ENRICH_BATCH_SKUS_REQUIRED");
  }
  const skus = [];
  const seen = new Set();
  for (const rawSku of body.skus) {
    const sku = requiredText(rawSku, "SKU", "ZONGZI_ENRICH_SKU_REQUIRED");
    if (!seen.has(sku)) {
      seen.add(sku);
      skus.push(sku);
    }
  }
  if (skus.length >= 21) {
    throw contractError("单次补全最多 20 个 SKU", 400, "ZONGZI_ENRICH_BATCH_LIMIT");
  }
  return { requestId, skus };
}

export function missingOzonRequiredFields(value) {
  return missingOzonEnrichmentFields(value);
}

export function normalizeOzonAgentResult({ sku, variantData, source, capturedAt } = {}) {
  assertOzonRussianProductText(variantData, { sku, operation: "采集" });
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
  // The approved source is candidate one. A missing field there must remain
  // unknown rather than being borrowed from a conflicting physical attribute.
  if (Array.isArray(variantData?.packagingCandidates) && variantData.packagingCandidates.length === 2) {
    for (const field of Object.keys(logistics)) {
      logistics[field] = positiveNumber(variantData.packagingCandidates[0]?.[field]);
    }
  }
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
  const sourceCategory = sourceCategoryEvidence(variantData);
  if (sourceCategory) result.sourceCategory = sourceCategory;
  const missingFields = missingOzonRequiredFields(result);
  if (missingFields.includes('descriptionCategoryId')) {
    throw contractError('Ozon 来源类目缺失', 422, 'ZONGZI_ENRICH_INCOMPLETE', { missingFields });
  }
  if (missingFields.length) {
    result.status = 'PARTIAL';
    result.missingFields = missingFields;
    for (const field of missingFields) result.logistics[field] = null;
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
      "ZONGZI_COLLECT_INCOMPLETE",
      { missingFields },
    );
  }
}

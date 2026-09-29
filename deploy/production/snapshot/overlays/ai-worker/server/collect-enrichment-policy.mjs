import { hasChineseProductText } from "./ozon-product-language.mjs";
import { collectedAttributeValues } from "./collector-attribute-values.mjs";
export const OZON_ENRICHMENT_FIELDS = Object.freeze([
  "descriptionCategoryId",
  "weightG",
  "lengthMm",
  "widthMm",
  "heightMm",
]);

function positiveNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  if (typeof value !== "string") return 0;
  const text = value.trim();
  if (!/^[+]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return 0;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function firstPositive(...values) {
  for (const value of values) {
    const number = positiveNumber(value);
    if (number) return number;
  }
  return 0;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function buyerCategoryUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  let url;
  try { url = new URL(value); } catch { return ""; }
  if (url.origin !== "https://www.ozon.ru" || url.username || url.password
    || !/^\/category\/[a-z0-9][a-z0-9-]*-[1-9][0-9]*\/$/iu.test(url.pathname)) return "";
  url.search = "";
  url.hash = "";
  return url.href;
}

export function explicitOzonListingTarget(resolution, { targetStoreId = "" } = {}) {
  if (!plainObject(resolution) || resolution.status !== "MATCHED") return null;
  const method = cleanText(resolution.method);
  const target = plainObject(resolution.target) ? resolution.target : {};
  const storeId = cleanText(target.storeId);
  const expectedStoreId = cleanText(targetStoreId);
  const descriptionCategoryId = positiveNumber(target.descriptionCategoryId);
  const typeId = positiveNumber(target.typeId);
  if (
    !method
    || !storeId
    || (expectedStoreId && storeId !== expectedStoreId)
    || !descriptionCategoryId
    || !typeId
  ) return null;
  return { storeId, descriptionCategoryId, typeId };
}

function enrichmentFieldValues(value = {}) {
  const logistics = value?.logistics && typeof value.logistics === "object" ? value.logistics : {};
  const draft = plainObject(value?.listingDraft) ? value.listingDraft : {};
  const draftLogistics = plainObject(draft.logistics) ? draft.logistics : {};
  const sourceCategory = sourceCategoryEvidence(value);
  const draftSourceCategory = sourceCategoryEvidence(draft);
  return {
    descriptionCategoryId: firstPositive(
      sourceCategory.descriptionCategoryId,
      draftSourceCategory.descriptionCategoryId,
    ),
    weightG: firstPositive(
      value?.packageWeight, value?.weightG, logistics.weightG, value?.weight,
      draft.packageWeight, draft.weightG, draftLogistics.weightG, draft.weight,
    ),
    lengthMm: firstPositive(
      value?.packageLength, value?.lengthMm, logistics.lengthMm, value?.depth,
      draft.packageLength, draft.lengthMm, draftLogistics.lengthMm, draft.depth,
    ),
    widthMm: firstPositive(
      value?.packageWidth, value?.widthMm, logistics.widthMm, value?.width,
      draft.packageWidth, draft.widthMm, draftLogistics.widthMm, draft.width,
    ),
    heightMm: firstPositive(
      value?.packageHeight, value?.heightMm, logistics.heightMm, value?.height,
      draft.packageHeight, draft.heightMm, draftLogistics.heightMm, draft.height,
    ),
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function blankEvidence(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  if (plainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function evidenceMissing(key, value) {
  if (["descriptionCategoryId", "typeIdCandidate", "typeId"].includes(key)) {
    return !positiveNumber(value);
  }
  return blankEvidence(value);
}

function arrayEvidenceKey(value) {
  if (plainObject(value)) {
    const identifier = cleanText(
      value.key ?? value.attribute_id ?? value.attributeId ?? value.id,
    );
    if (identifier) return `object:${identifier}`;
    return `json:${JSON.stringify(value)}`;
  }
  return `${typeof value}:${cleanText(value).toLowerCase()}`;
}

function mergeEvidenceArrays(current, incoming) {
  const merged = Array.isArray(current) ? structuredClone(current) : [];
  const indexes = new Map(merged.map((value, index) => [arrayEvidenceKey(value), index]));
  for (const value of Array.isArray(incoming) ? incoming : []) {
    if (blankEvidence(value)) continue;
    const key = arrayEvidenceKey(value);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, merged.length);
      merged.push(structuredClone(value));
    } else if (plainObject(merged[index]) && plainObject(value)) {
      merged[index] = mergeEvidenceOnlyIntoBlanks(merged[index], value);
    }
  }
  return merged;
}

function mergeEvidenceOnlyIntoBlanks(current, incoming) {
  if (!plainObject(incoming)) return plainObject(current) ? { ...current } : {};
  const merged = plainObject(current) ? structuredClone(current) : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "values" && Array.isArray(merged[key])) continue;
    if (Array.isArray(merged[key]) && Array.isArray(value)) {
      merged[key] = mergeEvidenceArrays(merged[key], value);
    } else if (evidenceMissing(key, merged[key])) {
      if (!evidenceMissing(key, value)) merged[key] = structuredClone(value);
    } else if (plainObject(merged[key]) && plainObject(value)) {
      merged[key] = mergeEvidenceOnlyIntoBlanks(merged[key], value);
    }
  }
  return merged;
}

function categoryTypeEvidenceFromAttributes(category = {}) {
  const attributes = Array.isArray(category?.attributes) ? category.attributes : [];
  const typeAttribute = attributes.find(
    (attribute) => cleanText(attribute?.key) === "8229",
  );
  const typeValues = collectedAttributeValues(typeAttribute);
  return {
    typeName: cleanText(typeValues[0]?.value),
    typeIdCandidate: firstPositive(
      typeValues[0]?.dictionary_value_id,
      typeValues[0]?.dictionaryValueId,
    ),
  };
}

function sourceCategoryEvidence(value = {}) {
  const rawResolutionSource = plainObject(value?.categoryResolution?.source)
    ? value.categoryResolution.source
    : {};
  const resolutionSource = mergeEvidenceOnlyIntoBlanks(
    rawResolutionSource,
    categoryTypeEvidenceFromAttributes(rawResolutionSource),
  );
  const rawDirectSource = plainObject(value?.sourceCategory) ? value.sourceCategory : {};
  const directSource = mergeEvidenceOnlyIntoBlanks(
    rawDirectSource,
    categoryTypeEvidenceFromAttributes(rawDirectSource),
  );
  const variant = plainObject(value?.variantData) ? value.variantData : {};
  const variantAttributes = Array.isArray(variant.attributes) ? variant.attributes : [];
  const variantTypeEvidence = categoryTypeEvidenceFromAttributes({ attributes: variantAttributes });
  const variantCategories = Array.isArray(variant.categories) ? variant.categories : [];
  const variantEvidence = {
    descriptionCategoryId: firstPositive(
      variant.description_category_id,
      variant.descriptionCategoryId,
    ),
    typeName: variantTypeEvidence.typeName,
    typeIdCandidate: firstPositive(
      variantTypeEvidence.typeIdCandidate,
      variant.type_id,
      variant.typeId,
    ),
    path: variantCategories
      .map((category) => cleanText(category?.title || category?.name))
      .filter(Boolean),
    attributes: variantAttributes,
  };
  return mergeEvidenceOnlyIntoBlanks(
    mergeEvidenceOnlyIntoBlanks(resolutionSource, directSource),
    variantEvidence,
  );
}

export function normalizeOzonCollectedSourceEvidence(payload = {}) {
  if (!plainObject(payload)) return {};
  const normalized = structuredClone(payload);
  const normalizedBuyerCategoryUrl = buyerCategoryUrl(payload.buyerCategoryUrl);
  if (normalizedBuyerCategoryUrl) normalized.buyerCategoryUrl = normalizedBuyerCategoryUrl;
  else delete normalized.buyerCategoryUrl;
  const ingressEvidence = mergeEvidenceOnlyIntoBlanks(
    sourceCategoryEvidence(payload),
    {
      descriptionCategoryId: firstPositive(
        payload.description_category_id,
        payload.descriptionCategoryId,
      ),
      typeIdCandidate: firstPositive(
        payload.type_id_candidate,
        payload.typeIdCandidate,
        payload.type_id,
        payload.typeId,
      ),
    },
  );
  if (Object.keys(ingressEvidence).length) normalized.sourceCategory = ingressEvidence;
  for (const key of [
    "description_category_id",
    "descriptionCategoryId",
    "type_id_candidate",
    "typeIdCandidate",
    "type_id",
    "typeId",
  ]) delete normalized[key];
  if (plainObject(normalized.listingDraft)) {
    const normalizeTargetRoots = (draftValue) => {
      if (!plainObject(draftValue)) return draftValue;
      const draft = structuredClone(draftValue);
      const target = explicitOzonListingTarget(draft.categoryResolution);
      const sourceEvidence = mergeEvidenceOnlyIntoBlanks(
        sourceCategoryEvidence(draftValue),
        target ? {} : {
          descriptionCategoryId: firstPositive(
            draftValue.description_category_id,
            draftValue.descriptionCategoryId,
          ),
          typeIdCandidate: firstPositive(
            draftValue.type_id_candidate,
            draftValue.typeIdCandidate,
            draftValue.type_id,
            draftValue.typeId,
          ),
        },
      );
      for (const key of [
        "description_category_id",
        "descriptionCategoryId",
        "type_id_candidate",
        "typeIdCandidate",
        "type_id",
        "typeId",
      ]) delete draft[key];
      if (Object.keys(sourceEvidence).length) draft.sourceCategory = sourceEvidence;
      if (target) {
        draft.descriptionCategoryId = target.descriptionCategoryId;
        draft.typeId = target.typeId;
      }
      return draft;
    };
    const listingDraft = normalizeTargetRoots(normalized.listingDraft);
    if (Array.isArray(listingDraft.variants)) {
      listingDraft.variants = listingDraft.variants.map(normalizeTargetRoots);
    }
    normalized.listingDraft = listingDraft;
  }
  return normalized;
}

export function preserveOzonSourceCategoryEvidence(currentDraft = {}, nextDraft = {}) {
  const current = plainObject(currentDraft) ? currentDraft : {};
  const next = plainObject(nextDraft) ? structuredClone(nextDraft) : {};
  const currentResolution = plainObject(current.categoryResolution)
    ? current.categoryResolution
    : {};
  const nextResolution = plainObject(next.categoryResolution)
    ? next.categoryResolution
    : null;
  const currentSource = mergeEvidenceOnlyIntoBlanks(
    current.sourceCategory,
    currentResolution.source,
  );
  const requestedSource = mergeEvidenceOnlyIntoBlanks(
    next.sourceCategory,
    nextResolution?.source,
  );
  const protectedSource = mergeEvidenceOnlyIntoBlanks(currentSource, requestedSource);
  if (Object.keys(protectedSource).length) next.sourceCategory = protectedSource;
  if (nextResolution) {
    next.categoryResolution = {
      ...nextResolution,
      ...(Object.keys(protectedSource).length
        ? { source: structuredClone(protectedSource) }
        : {}),
    };
  }
  return next;
}

function sanitizeSummaryOverrides(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return {};
  const attemptCount = Number(overrides.attemptCount);
  const summary = {};
  if (Number.isFinite(attemptCount) && attemptCount >= 0) {
    summary.attemptCount = Math.floor(attemptCount);
  }
  if (typeof overrides.nextAttemptAt === "string") {
    summary.nextAttemptAt = cleanText(overrides.nextAttemptAt);
  }
  if (typeof overrides.lastErrorCode === "string") {
    summary.lastErrorCode = cleanText(overrides.lastErrorCode);
  }
  return summary;
}

export function missingOzonEnrichmentFields(payload) {
  const fields = enrichmentFieldValues(payload);
  return OZON_ENRICHMENT_FIELDS.filter((field) => !positiveNumber(fields[field]));
}

export function buildOzonEnrichmentSummary(payload, overrides = {}) {
  const missingFields = missingOzonEnrichmentFields(payload);
  return {
    status: missingFields.length ? "PENDING_ENRICHMENT" : "COMPLETE",
    missingFields,
    attemptCount: 0,
    nextAttemptAt: "",
    lastErrorCode: "",
    ...sanitizeSummaryOverrides(overrides),
  };
}

export function reconcileOzonEnrichmentSummary(payload, previous = null) {
  const current = buildOzonEnrichmentSummary(payload);
  if (current.status !== "PENDING_ENRICHMENT") return current;
  return buildOzonEnrichmentSummary(payload, previous);
}

export function mergeOzonEnrichmentResult(current = {}, result = {}) {
  const draft = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const currentFields = enrichmentFieldValues(draft);
  const resultFields = enrichmentFieldValues(result);
  const currentLogistics = draft.logistics && typeof draft.logistics === "object" ? draft.logistics : {};
  const logistics = { ...currentLogistics };

  const candidates = result.variantData?.packagingCandidates;
  const hasConflict = Array.isArray(candidates) && candidates.length === 2;
  for (const field of OZON_ENRICHMENT_FIELDS.slice(1)) {
    if (!positiveNumber(currentFields[field])) {
      const enriched = positiveNumber(hasConflict ? candidates[0][field] : resultFields[field]);
      if (enriched) logistics[field] = enriched;
    }
  }

  const resultSourceCategory = plainObject(result.sourceCategory)
    ? result.sourceCategory
    : {
        descriptionCategoryId: resultFields.descriptionCategoryId,
        ...(positiveNumber(result?.typeId) ? { typeIdCandidate: positiveNumber(result.typeId) } : {}),
      };
  // User-approved policy: prefer bundle top-level packaging (candidate 1).
  // Keep source evidence, but exclude conflicting physical attribute fallbacks.
  const safeSourceCategory = hasConflict ? {...resultSourceCategory,
    attributes:(resultSourceCategory.attributes || []).filter(a => !['4497','4383','9454','9455','9456'].includes(String(a.key))),
  } : resultSourceCategory;
  const merged = {
    ...draft,
    ...(hasConflict ? {packagingCandidates:structuredClone(candidates)} : {}),
    logistics,
    sourceCategory: mergeEvidenceOnlyIntoBlanks(draft.sourceCategory, safeSourceCategory),
  };
  // Existing draft arrays include deliberate clears. Only a missing field is
  // enriched, and group instances stay intact for the listing builder.
  const complexAttributes = result.variantData?.complex_attributes ?? result.sourceCategory?.complex_attributes;
  if (!Object.hasOwn(draft, "complex_attributes") && Array.isArray(complexAttributes)) {
    merged.complex_attributes = structuredClone(complexAttributes);
  }
  const sourceName = collectedAttributeValues(result.sourceCategory?.attributes?.find(attribute =>
    String(attribute.key ?? attribute.id) === "4180"))
    .map(value => value.value).find(value => value && !hasChineseProductText(value));
  if (sourceName && (!draft.name || hasChineseProductText(draft.name))) merged.name = sourceName;
  if (sourceName && hasChineseProductText(draft.title)) merged.title = sourceName;
  return merged;
}

export function retryDelayMs(attemptCount) {
  const attempt = Math.max(1, Math.floor(Number(attemptCount) || 0));
  if (attempt === 1) return 30_000;
  if (attempt === 2) return 120_000;
  if (attempt === 3) return 600_000;
  if (attempt === 4) return 1_800_000;
  return 3_600_000;
}

export function assertOzonListingReady(payload) {
  const missingFields = missingOzonEnrichmentFields(payload);
  if (!missingFields.length) return;
  throw Object.assign(
    new Error(`Ozon 商品补全资料不完整：${missingFields.join(", ")}`),
    { status: 422, code: "COLLECT_ENRICHMENT_INCOMPLETE", missingFields },
  );
}

export function assertOzonListingLogisticsReady(payload) {
  const missingFields = missingOzonEnrichmentFields(payload)
    .filter((field) => field !== "descriptionCategoryId");
  if (!missingFields.length) return;
  throw Object.assign(
    new Error(`Ozon 商品物流资料不完整：${missingFields.join(", ")}`),
    { status: 422, code: "COLLECT_ENRICHMENT_INCOMPLETE", missingFields },
  );
}

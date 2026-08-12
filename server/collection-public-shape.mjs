import { isRetiredCollectorScopeKey } from "./collector-scope-sanitizer.mjs";
import {
  explicitOzonListingTarget,
  normalizeOzonCollectedSourceEvidence,
} from "./collect-enrichment-policy.mjs";

function canonicalPathKey(key) {
  return String(key || "").replace(/[_-]/g, "").toLowerCase();
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function isListingTargetClientId(path, key) {
  return canonicalPathKey(key) === "clientid"
    && path.length === 2
    && canonicalPathKey(path[0]) === "listingdraft"
    && canonicalPathKey(path[1]) === "targetstore";
}

function withoutPublicCollectionScope(value, path = []) {
  if (Array.isArray(value)) {
    return value.map((nested, index) => withoutPublicCollectionScope(nested, [...path, index]));
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isRetiredCollectorScopeKey(key) && !isListingTargetClientId(path, key)) continue;
    result[key] = withoutPublicCollectionScope(nested, [...path, key]);
  }
  return result;
}

function restoreListingTargetBusinessMetadata(result, source) {
  const restoreResolution = (resultResolution, sourceResolution) => {
    const target = explicitOzonListingTarget(sourceResolution);
    if (!target || !resultResolution) return;
    resultResolution.target = {
      ...(resultResolution.target || {}),
      ...target,
    };
  };
  restoreResolution(
    result?.listingDraft?.categoryResolution,
    source?.listingDraft?.categoryResolution,
  );
  const resultVariants = Array.isArray(result?.listingDraft?.variants)
    ? result.listingDraft.variants
    : [];
  const sourceVariants = Array.isArray(source?.listingDraft?.variants)
    ? source.listingDraft.variants
    : [];
  resultVariants.forEach((variant, index) => restoreResolution(
    variant?.categoryResolution,
    sourceVariants[index]?.categoryResolution,
  ));
  return result;
}

function cleanScopeValue(value) {
  return String(value ?? "").trim();
}

function positiveIdentifier(value) {
  const identifier = Number(value);
  return Number.isSafeInteger(identifier) && identifier > 0 ? identifier : null;
}

function publicInstant(value) {
  if (!value) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

function publicDisplayPath(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const path = {};
  for (const language of ["zh", "ru"]) {
    if (!Array.isArray(value[language])) continue;
    const labels = value[language]
      .map((label) => cleanScopeValue(label))
      .filter(Boolean)
      .slice(0, 32);
    if (labels.length) path[language] = labels;
  }
  return path;
}

const LEGACY_CATEGORY_STATUSES = new Set([
  "PENDING",
  "QUEUED",
  "MATCHING",
  "MATCHED",
  "NEEDS_REVIEW",
  "RETRYABLE_ERROR",
  "INVALIDATED",
  "WAITING_ENRICHMENT",
  "WAITING_STORE",
]);

function publicLegacyCategorySource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptionCategoryId = positiveIdentifier(
    value.descriptionCategoryId ?? value.description_category_id,
  );
  const typeName = cleanScopeValue(value.typeName ?? value.type_name).slice(0, 240);
  const typeIdCandidate = positiveIdentifier(
    value.typeIdCandidate ?? value.type_id_candidate,
  );
  const path = Array.isArray(value.path)
    ? value.path.map((label) => cleanScopeValue(label).slice(0, 240)).filter(Boolean).slice(0, 32)
    : [];
  const source = {
    ...(descriptionCategoryId ? { descriptionCategoryId } : {}),
    ...(typeName ? { typeName } : {}),
    ...(typeIdCandidate ? { typeIdCandidate } : {}),
    ...(path.length ? { path } : {}),
  };
  return Object.keys(source).length ? source : null;
}

function publicLegacyCategoryTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const storeId = cleanScopeValue(value.storeId).slice(0, 240);
  const descriptionCategoryId = positiveIdentifier(
    value.descriptionCategoryId ?? value.description_category_id,
  );
  const typeId = positiveIdentifier(value.typeId ?? value.type_id);
  const target = {
    ...(storeId ? { storeId } : {}),
    ...(descriptionCategoryId ? { descriptionCategoryId } : {}),
    ...(typeId ? { typeId } : {}),
  };
  return Object.keys(target).length ? target : null;
}

// Legacy category records may come from old drafts, variants, or raw snapshots.
// This is the only public contract for them: business status/method/source/target
// and resolution time. Every other field is intentionally discarded.
function publicLegacyCategoryResolution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = cleanScopeValue(value.status).toUpperCase();
  const method = cleanScopeValue(value.method).slice(0, 120);
  const source = publicLegacyCategorySource(value.source);
  const target = publicLegacyCategoryTarget(value.target);
  const resolvedAt = publicInstant(value.resolvedAt);
  const resolution = {
    ...(LEGACY_CATEGORY_STATUSES.has(status) ? { status } : {}),
    ...(method ? { method } : {}),
    ...(source ? { source } : {}),
    ...(target ? { target } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
  };
  return Object.keys(resolution).length ? resolution : null;
}

function projectLegacyCategoryResolutions(value) {
  if (Array.isArray(value)) return value.map(projectLegacyCategoryResolutions);
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (canonicalPathKey(key) === "categoryresolution") {
      const resolution = publicLegacyCategoryResolution(nested);
      if (resolution) result[key] = resolution;
      continue;
    }
    result[key] = projectLegacyCategoryResolutions(nested);
  }
  return result;
}

function categoryResolutionGuidance(status) {
  switch (status) {
    case "ACTIVE":
      return { action: "NONE", message: "使用采集类目准备上架" };
    case "NEEDS_REVIEW":
      return { action: "REVIEW", message: "请手动确认类目" };
    case "RETRYABLE_ERROR":
      return { action: "RETRY", message: "类目匹配暂时失败，请重试" };
    case "INVALIDATED":
      return { action: "REVIEW", message: "类目匹配结果已失效，请重新确认" };
    case "WAITING_ENRICHMENT":
      return { action: "WAIT", message: "等待商品信息补全" };
    case "WAITING_STORE":
      return { action: "WAIT", message: "等待经营店铺可用" };
    case "QUEUED":
    case "MATCHING":
    default:
      return { action: "WAIT", message: "类目匹配中" };
  }
}

export function publicCategoryResolutionSummary(record = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const status = cleanScopeValue(record.status).toUpperCase();
  const taxonomyScope = cleanScopeValue(record.taxonomyScope);
  if (!["ACTIVE", "INVALIDATED", "NEEDS_REVIEW"].includes(status)
    || taxonomyScope !== "OZON:DEFAULT") return null;
  const guidance = categoryResolutionGuidance(status);
  return deepFreeze({
    status,
    taxonomyScope,
    sourceDescriptionCategoryId: positiveIdentifier(record.sourceDescriptionCategoryId),
    sourceTypeId: positiveIdentifier(record.sourceTypeId),
    currentDescriptionCategoryId: positiveIdentifier(record.currentDescriptionCategoryId),
    currentTypeId: positiveIdentifier(record.currentTypeId),
    source: ["SOURCE_DIRECT", "OZON_REFRESH", "MANUAL"].includes(record.source)
      ? record.source : null,
    version: positiveIdentifier(record.version),
    validatedAt: publicInstant(record.validatedAt),
    action: guidance.action,
    message: guidance.message,
  });
}

export function publicCollectionItem(item = {}, {
  trustedLegacyScope = {},
  categoryResolution = null,
} = {}) {
  const sourceId = cleanScopeValue(item?.source || item?.sourceId).toLowerCase();
  const businessItem = sourceId === "ozon"
    ? normalizeOzonCollectedSourceEvidence(item)
    : item;
  const result = businessItem && typeof businessItem === "object" && !Array.isArray(businessItem)
    ? restoreListingTargetBusinessMetadata(
        withoutPublicCollectionScope(businessItem),
        businessItem,
      )
    : {};
  const projectedResult = projectLegacyCategoryResolutions(result);
  const operatingStoreId = cleanScopeValue(
    trustedLegacyScope.operatingStoreId,
  );
  const dataCollectionStoreId = cleanScopeValue(
    trustedLegacyScope.dataCollectionStoreId,
  );

  delete projectedResult.legacyScope;
  delete projectedResult.storeId;
  delete projectedResult.localStoreId;
  delete projectedResult.operatingStoreId;
  delete projectedResult.dataCollectionStoreId;
  delete projectedResult.createdBy;
  delete projectedResult.sellerCompanyId;
  delete projectedResult.categoryResolution;

  const resolutionSummary = publicCategoryResolutionSummary(categoryResolution);
  if (resolutionSummary) projectedResult.categoryResolution = resolutionSummary;

  if (operatingStoreId || dataCollectionStoreId) {
    projectedResult.legacyScope = {
      ...(operatingStoreId ? { operatingStoreId } : {}),
      ...(dataCollectionStoreId ? { dataCollectionStoreId } : {}),
    };
  }
  return deepFreeze(projectedResult);
}

export function publicPersistedCollectionItem(item = {}, { categoryResolution = null } = {}) {
  return publicCollectionItem(item, {
    trustedLegacyScope: {
      operatingStoreId: item?.storeId || item?.localStoreId || item?.operatingStoreId,
      dataCollectionStoreId: item?.dataCollectionStoreId,
    },
    categoryResolution,
  });
}

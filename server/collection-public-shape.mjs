import { isRetiredCollectorScopeKey } from "./collector-scope-sanitizer.mjs";
import {
  explicitOzonListingTarget,
  normalizeOzonCollectedSourceEvidence,
} from "./collect-enrichment-policy.mjs";

function canonicalPathKey(key) {
  return String(key || "").replace(/[_-]/g, "").toLowerCase();
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

const PRIVATE_CATEGORY_RESOLUTION_KEYS = new Set([
  "accountid",
  "collectitemid",
  "sourcetypeid",
  "targetdescriptioncategoryid",
  "targettypeid",
  "taxonomyscope",
  "credentialstoreid",
  "taxonomyfingerprint",
  "displaypath",
  "displaypathjson",
  "leasetoken",
  "leaseexpiresat",
  "attemptcount",
  "nextattemptat",
  "failurecode",
  "failuredetailsafe",
  "failure",
  "matchedat",
  "validatedat",
  "createdat",
  "updatedat",
]);

function removePrivateLegacyCategoryResolutionFields(resolution) {
  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) return;
  for (const key of Object.keys(resolution)) {
    if (PRIVATE_CATEGORY_RESOLUTION_KEYS.has(canonicalPathKey(key))) delete resolution[key];
  }
}

function removePrivateLegacyCategoryResolutionDetails(result) {
  const draft = result?.listingDraft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return;
  removePrivateLegacyCategoryResolutionFields(draft.categoryResolution);
  for (const variant of Array.isArray(draft.variants) ? draft.variants : []) {
    removePrivateLegacyCategoryResolutionFields(variant?.categoryResolution);
  }
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

function categoryResolutionGuidance(status) {
  switch (status) {
    case "MATCHED":
      return { action: "NONE", message: "类目已匹配" };
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
  if (!status || !taxonomyScope) return null;
  const matched = status === "MATCHED";
  const targetDescriptionCategoryId = matched
    ? positiveIdentifier(record.targetDescriptionCategoryId)
    : null;
  const targetTypeId = matched ? positiveIdentifier(record.targetTypeId) : null;
  const guidance = categoryResolutionGuidance(status);
  return {
    status,
    taxonomyScope,
    targetDescriptionCategoryId,
    targetTypeId,
    displayPath: matched ? publicDisplayPath(record.displayPath) : {},
    method: matched ? cleanScopeValue(record.method).slice(0, 120) || null : null,
    matchedAt: matched ? publicInstant(record.matchedAt) : null,
    validatedAt: matched ? publicInstant(record.validatedAt) : null,
    action: guidance.action,
    message: guidance.message,
  };
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
  removePrivateLegacyCategoryResolutionDetails(result);
  const operatingStoreId = cleanScopeValue(
    trustedLegacyScope.operatingStoreId,
  );
  const dataCollectionStoreId = cleanScopeValue(
    trustedLegacyScope.dataCollectionStoreId,
  );

  delete result.legacyScope;
  delete result.storeId;
  delete result.localStoreId;
  delete result.operatingStoreId;
  delete result.dataCollectionStoreId;
  delete result.createdBy;
  delete result.sellerCompanyId;
  delete result.categoryResolution;

  const resolutionSummary = publicCategoryResolutionSummary(categoryResolution);
  if (resolutionSummary) result.categoryResolution = resolutionSummary;

  if (operatingStoreId || dataCollectionStoreId) {
    result.legacyScope = {
      ...(operatingStoreId ? { operatingStoreId } : {}),
      ...(dataCollectionStoreId ? { dataCollectionStoreId } : {}),
    };
  }
  return result;
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

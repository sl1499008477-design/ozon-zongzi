import { isRetiredCollectorScopeKey } from "./collector-scope-sanitizer.mjs";

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

function cleanScopeValue(value) {
  return String(value ?? "").trim();
}

export function publicCollectionItem(item = {}, { trustedLegacyScope = {} } = {}) {
  const result = item && typeof item === "object" && !Array.isArray(item)
    ? withoutPublicCollectionScope(item)
    : {};
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

  if (operatingStoreId || dataCollectionStoreId) {
    result.legacyScope = {
      ...(operatingStoreId ? { operatingStoreId } : {}),
      ...(dataCollectionStoreId ? { dataCollectionStoreId } : {}),
    };
  }
  return result;
}

export function publicPersistedCollectionItem(item = {}) {
  return publicCollectionItem(item, {
    trustedLegacyScope: {
      operatingStoreId: item?.storeId || item?.localStoreId || item?.operatingStoreId,
      dataCollectionStoreId: item?.dataCollectionStoreId,
    },
  });
}

import { withoutCollectorScope } from "./collector-scope-sanitizer.mjs";

function cleanScopeValue(value) {
  return String(value ?? "").trim();
}

export function publicCollectionItem(item = {}, { trustedLegacyScope = {} } = {}) {
  const result = item && typeof item === "object" && !Array.isArray(item)
    ? withoutCollectorScope(item)
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

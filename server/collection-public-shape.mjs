function cleanScopeValue(value) {
  return String(value ?? "").trim();
}

export function publicCollectionItem(item = {}) {
  const result = item && typeof item === "object" && !Array.isArray(item)
    ? { ...item }
    : {};
  const existingLegacyScope = result.legacyScope
    && typeof result.legacyScope === "object"
    && !Array.isArray(result.legacyScope)
    ? result.legacyScope
    : {};
  const storeId = cleanScopeValue(
    result.storeId
    || result.localStoreId
    || result.operatingStoreId
    || existingLegacyScope.storeId,
  );
  const dataCollectionStoreId = cleanScopeValue(
    result.dataCollectionStoreId
    || existingLegacyScope.dataCollectionStoreId,
  );

  delete result.storeId;
  delete result.localStoreId;
  delete result.operatingStoreId;
  delete result.dataCollectionStoreId;
  delete result.createdBy;
  delete result.sellerCompanyId;

  if (storeId || dataCollectionStoreId) {
    result.legacyScope = {
      ...existingLegacyScope,
      storeId,
      dataCollectionStoreId,
    };
  }
  return result;
}

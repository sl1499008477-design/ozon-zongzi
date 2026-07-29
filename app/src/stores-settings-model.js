export function operatingStoreSettingsModel({ localData = {}, binding = null } = {}) {
  const stores = Array.isArray(localData?.stores) ? localData.stores : [];
  const warehouses = Array.isArray(localData?.caches?.warehouses)
    ? localData.caches.warehouses
    : [];
  return {
    stores,
    currentStoreId: String(binding?.id || localData?.currentStoreId || stores[0]?.id || ""),
    warehouses,
    summary: localData?.summary && typeof localData.summary === "object"
      ? localData.summary
      : {},
  };
}

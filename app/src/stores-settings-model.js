export function operatingStoreSettingsModel({ localData = {}, binding = null } = {}) {
  const stores = Array.isArray(localData?.stores) ? localData.stores : [];
  const warehouses = Array.isArray(localData?.caches?.warehouses)
    ? localData.caches.warehouses
    : [];
  const currentStoreId = String(binding?.id || localData?.currentStoreId || stores[0]?.id || "");
  const warehouseCountsByStoreId = {};
  for (const warehouse of warehouses) {
    const storeId = warehouse?.storeId
      ?? warehouse?.store_id
      ?? warehouse?.localStoreId
      ?? warehouse?.operatingStoreId;
    if (storeId === null || storeId === undefined || String(storeId) === "") continue;
    const key = String(storeId);
    warehouseCountsByStoreId[key] = (warehouseCountsByStoreId[key] || 0) + 1;
  }
  return {
    stores,
    currentStoreId,
    warehouses,
    warehouseCountsByStoreId,
    currentWarehouseCount: warehouseCountsByStoreId[currentStoreId] || 0,
    summary: localData?.summary && typeof localData.summary === "object"
      ? localData.summary
      : {},
  };
}

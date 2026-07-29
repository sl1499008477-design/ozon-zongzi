export function eligibleTargetStores(localData = {}) {
  return (Array.isArray(localData.stores) ? localData.stores : [])
    .filter((store) => store?.status !== "disabled" && store?.credentialsSaved === true);
}

export function targetStoreSelection(localData = {}, currentStoreId = "", selectedStoreId = "") {
  const stores = eligibleTargetStores(localData);
  const options = stores.map((store) => {
    const value = String(store?.id || store?.storeId || "").trim();
    const clientId = String(store?.clientId || "").trim();
    const name = String(store?.label || store?.companyName || store?.storeName || "").trim();
    return { value, label: name && name !== clientId ? name : value || "经营店铺" };
  }).filter((option) => option.value);
  const selected = String(selectedStoreId || "").trim();
  const current = String(currentStoreId || "").trim();
  const selectedStore = options.some((option) => option.value === selected)
    ? selected
    : options.find((option) => option.value === current)?.value || options[0]?.value || "";
  return { stores, options, selectedStoreId: selectedStore };
}

export function listingPreparationModel({
  localData = {},
  targetStoreId = "",
  collectItem = null,
} = {}) {
  const targetId = String(targetStoreId || "").trim();
  const targetStore = eligibleTargetStores(localData)
    .find((store) => String(store?.id || store?.storeId || "").trim() === targetId);
  const targetClientId = String(targetStore?.clientId || "").trim();
  const warehouses = (Array.isArray(localData?.caches?.warehouses) ? localData.caches.warehouses : [])
    .filter((warehouse) => {
      const storeId = String(warehouse?.storeId || warehouse?.store_id || "").trim();
      if (storeId) return storeId === targetId;
      const clientId = String(warehouse?.clientId || warehouse?.client_id || "").trim();
      return Boolean(targetClientId && clientId === targetClientId);
    });
  return {
    itemReady: Boolean(collectItem?.id && targetStore),
    targetStoreId: targetStore ? targetId : "",
    categoryStoreId: targetStore ? targetId : "",
    currencyCode: String(
      targetStore?.companyCurrency
      || targetStore?.currencyCode
      || targetStore?.currency
      || "",
    ).trim(),
    warehouses,
  };
}

export function listingSubmissionIntent(current, {
  collectItemId,
  targetStoreId,
  requestId,
} = {}) {
  const itemId = String(collectItemId || "").trim();
  const storeId = String(targetStoreId || "").trim();
  if (
    current?.requestId
    && current.collectItemId === itemId
    && current.targetStoreId === storeId
  ) return current;
  return {
    collectItemId: itemId,
    targetStoreId: storeId,
    requestId: String(requestId || crypto.randomUUID()),
  };
}

export function settleListingSubmissionIntent(current, { definitive = false } = {}) {
  return definitive ? null : current;
}

export function listingSubmissionErrorIsDefinitive(error) {
  const status = Number(error?.status);
  return Number.isInteger(status)
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 429;
}

export function buildPrepareListingBody({ collectItemId, targetStoreId, requestId } = {}) {
  const itemId = String(collectItemId || "").trim();
  const storeId = String(targetStoreId || "").trim();
  if (!itemId) throw new Error("COLLECT_ITEM_REQUIRED");
  if (!storeId) throw new Error("TARGET_STORE_REQUIRED");
  return {
    collectItemId: itemId,
    targetStoreId: storeId,
    idempotencyKey: String(requestId || crypto.randomUUID()),
  };
}

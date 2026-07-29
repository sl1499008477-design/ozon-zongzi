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

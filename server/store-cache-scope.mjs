function cacheItemStoreId(item = {}) {
  return String(
    item.storeId ||
    item.store_id ||
    item.ozonStoreId ||
    item.currentOzonStoreId ||
    item.localStoreId ||
    item.operatingStoreId ||
    "",
  );
}

export function cacheItemMatchesStore(item = {}, store = {}) {
  const expectedStoreId = String(store?.id || "");
  if (!expectedStoreId) return false;
  const itemStoreId = cacheItemStoreId(item);
  if (itemStoreId) return itemStoreId === expectedStoreId;

  const expectedClientId = String(store?.clientId || "");
  const itemClientId = String(item.clientId || item.client_id || item.ozonClientId || "");
  if (itemClientId) return Boolean(expectedClientId) && itemClientId === expectedClientId;

  const expectedNames = new Set(
    [store.label, store.companyName, store.storeName, store.name]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase()),
  );
  const itemStoreName = String(
    item.storeName || item.store_name || item.shopName || item.companyName || "",
  ).trim().toLowerCase();
  return Boolean(itemStoreName) && expectedNames.has(itemStoreName);
}

export function cacheItemsForStore(items, store) {
  return (Array.isArray(items) ? items : []).filter((item) => cacheItemMatchesStore(item, store));
}

export function cacheItemScope(store, accountId = "") {
  return {
    storeId: store.id,
    storeName: store.label || store.companyName || "",
    clientId: store.clientId,
    ...(accountId ? { accountId } : {}),
  };
}

export function upsertCacheItemByStore(list, store, id, value, idFields = ["id"]) {
  const itemId = String(id || "");
  if (!itemId || !store?.id) return false;
  const idx = list.findIndex((item) => {
    const existingId = idFields
      .map((field) => item?.[field])
      .find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
    return String(existingId || "") === itemId && cacheItemMatchesStore(item, store);
  });
  if (idx >= 0) list[idx] = value;
  else list.push(value);
  return idx < 0;
}

export function upsertProductByStore(list, store, id, value) {
  const productId = String(id || "");
  const storeId = String(store?.id || "");
  if (!productId || !storeId) return false;
  const idx = list.findIndex((item) => {
    const itemId = String(item.id || item.product_id || item.offer_id || "");
    return itemId === productId && cacheItemMatchesStore(item, store);
  });
  if (idx >= 0) list[idx] = value;
  else list.push(value);
  return idx < 0;
}

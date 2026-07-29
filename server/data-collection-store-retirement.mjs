const REMOVED_PATH_PREFIXES = [
  "/local/data-collection-stores",
  "/local/current-data-collection-store",
];

export const DATA_COLLECTION_STORE_REMOVED_RESPONSE = Object.freeze({
  ok: false,
  code: "DATA_COLLECTION_STORE_REMOVED",
  message: "数据采集店铺功能已移除，采集数据现在按 sonli 账号归属",
});

export function isRemovedDataCollectionStorePath(pathname = "") {
  const normalized = String(pathname || "");
  return REMOVED_PATH_PREFIXES.some((prefix) =>
    normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export function handleRemovedDataCollectionStoreRoute(req, res, url, { sendJson }) {
  if (!isRemovedDataCollectionStorePath(url?.pathname)) return false;
  sendJson(res, 410, DATA_COLLECTION_STORE_REMOVED_RESPONSE);
  return true;
}

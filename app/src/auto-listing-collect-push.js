function pushError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(id) ? id : "";
}

export function buildAutoListingCollectPush({
  selectedIds = [],
  visibleItems = [],
  accountId = "",
  destination = "ai-listing",
} = {}) {
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
    throw pushError("AUTO_LISTING_COLLECT_SELECTION_EMPTY");
  }
  const scopedAccountId = safeId(accountId);
  if (!scopedAccountId || !Array.isArray(visibleItems)) {
    throw pushError("AUTO_LISTING_COLLECT_SELECTION_INVALID");
  }
  const visible = new Map();
  for (const item of visibleItems) {
    const id = safeId(item?.id);
    if (!id) continue;
    const owner = safeId(item?.accountId || item?.account_id || "");
    if (owner && owner !== scopedAccountId) continue;
    visible.set(id, item);
  }
  const ids = [];
  const seen = new Set();
  for (const candidate of selectedIds) {
    const id = safeId(candidate);
    if (!id || !visible.has(id)) throw pushError("AUTO_LISTING_COLLECT_SELECTION_INVALID");
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (!ids.length || ids.length > 100) throw pushError("AUTO_LISTING_COLLECT_SELECTION_INVALID");
  const targetPath = destination === "ai-listing" ? "/ozon/tools/ai-listing" : "";
  if (!targetPath) throw pushError("AUTO_LISTING_COLLECT_SELECTION_INVALID");
  return Object.freeze({
    ids: Object.freeze(ids),
    path: `${targetPath}?source=collect&ids=${encodeURIComponent(ids.join(","))}`,
  });
}

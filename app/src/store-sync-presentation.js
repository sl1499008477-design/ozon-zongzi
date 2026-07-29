function fetchedCount(result) {
  for (const value of [result?.fetchedCount, result?.details?.fetchedCount]) {
    const count = typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : value;
    if (Number.isSafeInteger(count) && count >= 0) return count;
  }
  return null;
}

export function storeSyncDetailText(state = {}) {
  if (state.status === "SUCCESS") {
    const count = fetchedCount(state.result);
    return count === null ? "同步完成，数量未知" : `已同步 ${count} 条`;
  }
  if (state.status === "FAILED") {
    const reason = String(state.error?.message || "").trim();
    return reason ? `失败原因：${reason}` : "同步失败，请重试";
  }
  return "";
}

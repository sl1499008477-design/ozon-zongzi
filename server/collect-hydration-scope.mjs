export function attachTrustedCollectAccountScope(accountId, items = []) {
  const trustedAccountId = String(accountId || "").trim().slice(0, 240);
  if (!trustedAccountId) {
    throw Object.assign(new Error("采集列表必须指定账号范围"), {
      status: 401,
      code: "COLLECT_ACCOUNT_REQUIRED",
    });
  }
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...(item || {}),
    accountId: trustedAccountId,
  }));
}

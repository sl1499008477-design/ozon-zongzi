function knownAccountId(accounts, accountId) {
  const candidate = String(accountId || "").trim();
  return candidate && (accounts || []).some((account) => String(account?.id || "") === candidate) ? candidate : "";
}

export function resolveLegacyStoreOwner(store = {}, accounts = []) {
  const ownerAccountId = knownAccountId(accounts, store.ownerAccountId);
  if (ownerAccountId) return ownerAccountId;
  if (accounts.length === 1) return String(accounts[0]?.id || "");
  const error = new Error("历史店铺缺少可靠归属，多个账号时必须先完成人工映射");
  error.code = "STORE_OWNER_MAPPING_REQUIRED";
  throw error;
}

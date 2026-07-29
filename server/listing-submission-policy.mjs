function policyError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function clean(value) {
  return String(value || "").trim();
}

export function assertListingPreparationInput({
  accountId,
  collectItemId,
  targetStoreId,
  idempotencyKey,
} = {}) {
  const input = {
    accountId: clean(accountId),
    collectItemId: clean(collectItemId),
    targetStoreId: clean(targetStoreId),
    idempotencyKey: clean(idempotencyKey),
  };
  if (!input.accountId) {
    throw policyError("准备上架必须指定账号范围", 401, "COLLECT_ACCOUNT_REQUIRED");
  }
  if (!input.collectItemId) {
    throw policyError("采集箱条目不存在", 404, "COLLECT_ITEM_NOT_FOUND");
  }
  if (!input.targetStoreId) {
    throw policyError("请选择目标经营店铺", 422, "TARGET_STORE_REQUIRED");
  }
  if (!input.idempotencyKey) {
    throw policyError("准备上架缺少幂等键", 422, "IDEMPOTENCY_KEY_REQUIRED");
  }
  return input;
}

export function validateTargetStoreRecord({
  accountId,
  targetStoreId,
  store,
  requireCredentials = true,
  validatedAt = new Date().toISOString(),
} = {}) {
  const ownerAccountId = clean(store?.ownerAccountId || store?.owner_account_id);
  if (
    !store
    || clean(store.id) !== clean(targetStoreId)
    || ownerAccountId !== clean(accountId)
  ) {
    throw policyError("目标经营店铺不存在或不可用", 404, "TARGET_STORE_NOT_FOUND");
  }
  if (clean(store.status).toLowerCase() === "disabled") {
    throw policyError("目标经营店铺已停用", 409, "TARGET_STORE_DISABLED");
  }
  const credentialsSaved = store.credentialsSaved === true || store.credentials_saved === true;
  if (requireCredentials && (!clean(store.clientId || store.client_id) || !credentialsSaved)) {
    throw policyError("目标经营店铺缺少可用凭据", 409, "TARGET_STORE_CREDENTIALS_REQUIRED");
  }
  return {
    id: clean(store.id),
    label: clean(store.label || store.companyName || store.company_name),
    clientId: clean(store.clientId || store.client_id),
    currencyCode: clean(store.currencyCode || store.currency_code || store.currency),
    validatedAt: new Date(validatedAt).toISOString(),
  };
}

export function resolveLocalListingTarget({
  accountId,
  collectItemId,
  targetStoreId,
  idempotencyKey,
  findStore,
  validatedAt,
} = {}) {
  const input = assertListingPreparationInput({
    accountId,
    collectItemId,
    targetStoreId,
    idempotencyKey,
  });
  const store = typeof findStore === "function"
    ? findStore(input.targetStoreId, input.accountId)
    : null;
  const target = validateTargetStoreRecord({
    accountId: input.accountId,
    targetStoreId: input.targetStoreId,
    store: store ? { ...store, credentialsSaved: Boolean(store.apiKey) } : null,
    validatedAt,
  });
  return { ...input, store, target };
}

export function resolveListingPreparationReplay({
  existing,
  collectItemId,
  targetStoreId,
} = {}) {
  if (!existing) return null;
  if (clean(existing.store_id || existing.storeId) !== clean(targetStoreId)) {
    throw policyError(
      "该幂等键已绑定其他目标经营店铺",
      409,
      "LISTING_TARGET_STORE_CONFLICT",
    );
  }
  if (clean(existing.collect_item_id || existing.collectItemId) !== clean(collectItemId)) {
    throw policyError("该幂等键已用于其他采集商品", 409, "LISTING_IDEMPOTENCY_CONFLICT");
  }
  return existing;
}

export function resolveSubmissionFailureDisposition(error = {}) {
  if (error?.body?.network || Number(error?.status || 0) >= 500) return "RECONCILING";
  if (error?.code === "SUBMISSION_NOT_SENT") return "RETRY_PENDING";
  return "FAILED";
}

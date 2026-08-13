import { types as utilTypes } from "node:util";

function policyError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

export function markListingReplayPreflightError(error) {
  if (error && typeof error === "object") error.preserveExistingListing = true;
  return error;
}

function clean(value) {
  return String(value || "").trim();
}

function safeStoreCarrier(store) {
  try {
    if (!store || typeof store !== "object" || Array.isArray(store) || utilTypes.isProxy(store)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(store))) return null;
    const keys = Reflect.ownKeys(store);
    const descriptors = Object.getOwnPropertyDescriptors(store);
    if (keys.some((key) => typeof key !== "string" || !Object.hasOwn(descriptors[key], "value"))) return null;
    const value = (camel, snake = camel) => descriptors[camel]?.value ?? descriptors[snake]?.value;
    const projected = {
      id: value("id"), ownerAccountId: value("ownerAccountId", "owner_account_id"),
      label: value("label"), companyName: value("companyName", "company_name"),
      clientId: value("clientId", "client_id"), currencyCode: value("currencyCode", "currency_code"),
      currency: value("currency"), status: value("status"),
      currencySource: value("currencySource", "currency_source"),
      currencySyncedAt: value("currencySyncedAt", "currency_synced_at"),
      credentialsSaved: value("credentialsSaved", "credentials_saved"),
    };
    if (["id", "ownerAccountId", "label", "companyName", "clientId", "currencyCode", "currency", "status"]
      .some((key) => projected[key] !== undefined && typeof projected[key] !== "string")
      || ["currencySource", "currencySyncedAt"]
        .some((key) => projected[key] !== undefined && projected[key] !== null && typeof projected[key] !== "string")
      || (projected.credentialsSaved !== undefined && typeof projected.credentialsSaved !== "boolean")) return null;
    return projected;
  } catch { return null; }
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
  const safeStore = safeStoreCarrier(store);
  const ownerAccountId = clean(safeStore?.ownerAccountId);
  if (
    !safeStore
    || clean(safeStore.id) !== clean(targetStoreId)
    || ownerAccountId !== clean(accountId)
  ) {
    throw policyError("目标经营店铺不存在或不可用", 404, "TARGET_STORE_NOT_FOUND");
  }
  if (clean(safeStore.status).toLowerCase() === "disabled") {
    throw policyError("目标经营店铺已停用", 409, "TARGET_STORE_DISABLED");
  }
  const credentialsSaved = safeStore.credentialsSaved === true;
  if (requireCredentials && (!clean(safeStore.clientId) || !credentialsSaved)) {
    throw policyError("目标经营店铺缺少可用凭据", 409, "TARGET_STORE_CREDENTIALS_REQUIRED");
  }
  if (clean(safeStore.currencySource) !== "OZON_SELLER_INFO"
    || Number.isNaN(Date.parse(clean(safeStore.currencySyncedAt)))) {
    throw policyError("店铺币种尚未同步，请先同步店铺资料", 409,
      "AUTO_LISTING_TARGET_STORE_CURRENCY_UNVERIFIED");
  }
  return {
    id: clean(safeStore.id),
    ownerAccountId,
    label: clean(safeStore.label || safeStore.companyName),
    clientId: clean(safeStore.clientId),
    currencyCode: clean(safeStore.currencyCode || safeStore.currency),
    currencySource: clean(safeStore.currencySource),
    currencySyncedAt: clean(safeStore.currencySyncedAt),
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
    throw markListingReplayPreflightError(policyError(
      "该幂等键已绑定其他目标经营店铺",
      409,
      "LISTING_TARGET_STORE_CONFLICT",
    ));
  }
  if (clean(existing.collect_item_id || existing.collectItemId) !== clean(collectItemId)) {
    throw markListingReplayPreflightError(
      policyError("该幂等键已用于其他采集商品", 409, "LISTING_IDEMPOTENCY_CONFLICT"),
    );
  }
  return existing;
}

export function publicQueuedListingSubmission(created, warnings = []) {
  const job = created?.job;
  return {
    ok: true,
    queued: true,
    local: true,
    duplicate: Boolean(created?.duplicate),
    task_id: job?.id,
    result: { task_id: job?.id, localTaskId: job?.id },
    job,
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

export function resolveSubmissionFailureDisposition(error = {}) {
  if (error?.body?.network || Number(error?.status || 0) >= 500) return "RECONCILING";
  if (error?.code === "SUBMISSION_NOT_SENT") return "RETRY_PENDING";
  return "FAILED";
}

export function assertCategoryRecoverySubmissionTransition({
  fromStatus,
  toStatus,
  categoryRecoveryTransaction = false,
} = {}) {
  const allowed = categoryRecoveryTransaction === true
    && ((fromStatus === "CHECKING" && toStatus === "FAILED")
      || (fromStatus === "FAILED" && toStatus === "RETRY_PENDING"));
  if (!allowed) {
    throw policyError(
      "类目恢复状态迁移必须由专用事务执行",
      409,
      "LISTING_CATEGORY_RECOVERY_TRANSITION_FORBIDDEN",
    );
  }
  return true;
}

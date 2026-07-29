import { purgeLegacyDataCollectionStoreArchiveForAccount } from "./legacy-data-collection-store.mjs";

const ACCOUNT_FIELDS = [
  "accountId",
  "account_id",
  "ownerAccountId",
  "owner_account_id",
  "createdBy",
  "created_by",
  "updatedBy",
  "updated_by",
];
const STORE_FIELDS = [
  "storeId",
  "store_id",
  "localStoreId",
  "operatingStoreId",
  "operating_store_id",
];

function normalized(value) {
  return String(value || "").trim();
}

function belongsToAccountScope(value, accountId, storeIds) {
  if (!value || typeof value !== "object") return false;
  if (ACCOUNT_FIELDS.some((field) => normalized(value[field]) === accountId)) return true;
  return STORE_FIELDS.some((field) => storeIds.has(normalized(value[field])));
}

function filterRecord(value, accountId, storeIds) {
  return !belongsToAccountScope(value, accountId, storeIds);
}

function filterMap(value, accountId, storeIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => filterRecord(item, accountId, storeIds)),
  );
}

function rememberRelationalDeletion(
  state,
  accountId,
  storeIds,
  legacyDataStorePurgePolicy,
) {
  const previous = Array.isArray(state.__deletedAccountScopes)
    ? state.__deletedAccountScopes
    : [];
  Object.defineProperty(state, "__deletedAccountScopes", {
    value: [...previous, {
      accountId,
      storeIds: [...storeIds],
      legacyDataStorePurgePolicy,
    }],
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

export function removeAccountScope(
  state,
  rawAccountId,
  {
    actor = { type: "system", id: "account-deletion" },
    reason = "ACCOUNT_DELETION_PRIVACY_ERASURE",
    occurredAt = new Date().toISOString(),
  } = {},
) {
  const accountId = normalized(rawAccountId);
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  if (!accountId || !accounts.some((account) => normalized(account?.id) === accountId)) {
    const error = new Error("账号不存在");
    error.code = "ACCOUNT_NOT_FOUND";
    throw error;
  }
  const legacyArchiveDeletion = purgeLegacyDataCollectionStoreArchiveForAccount(state, {
    accountId,
    archivedAt: occurredAt,
  });

  const stores = Array.isArray(state.stores) ? state.stores : [];
  const storeIds = new Set(
    stores
      .filter((store) => normalized(store?.ownerAccountId) === accountId)
      .map((store) => normalized(store?.id))
      .filter(Boolean),
  );
  const fileObjectKeys = (Array.isArray(state.caches?.files) ? state.caches.files : [])
    .filter((item) => belongsToAccountScope(item, accountId, storeIds))
    .map((item) => normalized(item?.objectKey || item?.object_key || item?.key))
    .filter(Boolean);

  state.accounts = accounts.filter((account) => normalized(account?.id) !== accountId);
  state.stores = stores.filter((store) => !storeIds.has(normalized(store?.id)));
  state.sessions = filterMap(state.sessions, accountId, storeIds);
  state.hashes = filterMap(state.hashes, accountId, storeIds);
  state.leases = filterMap(state.leases, accountId, storeIds);
  state.browserAgents = filterMap(state.browserAgents, accountId, storeIds);
  state.jobs = filterMap(state.jobs, accountId, storeIds);
  state.reports = (Array.isArray(state.reports) ? state.reports : [])
    .filter((item) => filterRecord(item, accountId, storeIds));

  state.caches = state.caches && typeof state.caches === "object" ? state.caches : {};
  for (const [cacheKey, items] of Object.entries(state.caches)) {
    if (!Array.isArray(items)) continue;
    state.caches[cacheKey] = items.filter((item) => filterRecord(item, accountId, storeIds));
  }

  state.currentStoreIdsByAccount =
    state.currentStoreIdsByAccount && typeof state.currentStoreIdsByAccount === "object"
      ? state.currentStoreIdsByAccount
      : {};
  delete state.currentStoreIdsByAccount[accountId];

  if (normalized(state.currentAccountId) === accountId) {
    state.currentAccountId = "";
    state.token = "";
    state.sessionIssuedAt = "";
    state.currentStoreId = "";
  }

  rememberRelationalDeletion(state, accountId, storeIds, {
    actor: {
      type: normalized(actor?.type),
      id: normalized(actor?.id),
    },
    reason: normalized(reason),
    occurredAt: normalized(occurredAt),
  });
  return {
    accountId,
    storeIds: [...storeIds],
    fileObjectKeys: [...new Set(fileObjectKeys)],
    legacyArchivePurgedCount: legacyArchiveDeletion.purgedCount,
  };
}

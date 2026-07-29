import "./env.mjs";
import { assertProductionConfiguration } from "./runtime-config.mjs";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { normalizeOzonImportItems } from "./ozon-import-normalizer.mjs";
import { callOzonSellerApi } from "./ozon-client.mjs";
import { createOzonCategoryService } from "./ozon-category-service.mjs";
import { createOzonCategoryRouteHandler } from "./ozon-category-routes.mjs";
import { createOzonSyncService } from "./ozon-sync-service.mjs";
import { summarizeOrderMoney } from "./order-money-summary.mjs";
import { appendAuditEvent } from "./audit-event.mjs";
import { removeAccountScope } from "./account-deletion.mjs";
import {
  activeAccount,
  activeDataCollectionStore,
  activeStore,
  bearerToken,
  createAccountRecord,
  createAuthSession,
  createDataCollectionStoreId,
  createPasswordHash,
  createStoreId,
  currentDataCollectionStoreIdForAccount,
  currentStoreIdForAccount,
  dataCollectionStoresForAccount,
  findAccountByUsername,
  findSession,
  findStore,
  isAccountExpired,
  normalizeAccountExpiresAt,
  normalizeDataCollectionCompanyId,
  normalizeDataCollectionCompanyIds,
  normalizeDateOnly,
  optionalAuth,
  publicAccount,
  removeSession,
  requireAdmin,
  requireAuth,
  requirePermission,
  revokeAccountSessions,
  setCurrentDataCollectionStoreForAccount,
  setCurrentStoreForAccount,
  storeIdForAccountRequest,
  storesForAccount,
  todayDateOnly,
  verifyPassword,
} from "./account-context.mjs";
import { PERMISSIONS } from "./permissions.mjs";
import {
  cacheItemMatchesStore,
  cacheItemsForStore,
  cacheItemScope,
  upsertCacheItemByStore,
  upsertProductByStore,
} from "./store-cache-scope.mjs";
import {
  disablePersistedOperatingStores,
  loadPersistedState,
  persistenceHealth,
  persistenceMode,
  savePersistedCollectBox,
  savePersistedState,
} from "./persistence.mjs";
import {
  getObjectStream,
  objectStorageHealth,
  objectStorageInfo,
  putObjectFromBase64,
  removeObject,
} from "./object-storage.mjs";
import {
  enqueueObjectDeletions,
} from "./object-cleanup-queue.mjs";
import { createObjectCleanupWorker } from "./object-cleanup-worker.mjs";
import {
  createSubmissionV3,
  getSubmissionJobDetailV3,
  getSubmissionJobV3,
  findListingPreparationReplayV3,
  hydrateLegacyStateWithV3,
  listingPipelineEnabled,
  listingPipelineHealth,
  mirrorCollectItemV3,
  listSubmissionJobsV3,
  prepareCollectItemForListing,
  softDeleteCollectItemsForAccountV4,
  updateCollectItemDraftV4,
} from "./listing-pipeline.mjs";
import { assertListingPreparationInput, publicQueuedListingSubmission, resolveLocalListingTarget, validateTargetStoreRecord } from "./listing-submission-policy.mjs";
import {
  authenticateCollectionRequest,
  backfillCollectionStoresFromLegacy,
  deleteCollectionStoreForAccount,
  getCollectRequestForAccount,
  hydrateCollectionStoresIntoState,
  ingestCollectRequestV4,
  assertCollectorScopeFieldsAbsentV4,
  listCollectionStoresForAccount,
  setCurrentCollectionStoreForAccount,
  upsertCollectionStoreForAccount,
  verifyCollectionStoreForAccount,
} from "./collection-pipeline.mjs";
import {
  calculateWithActivePricing,
  createPricingDraft,
  getActivePricingConfig,
  getPricingVersion,
  listPricingVersions,
  publishPricingVersion,
  savePricingSnapshot,
  updatePricingDraft,
  validatePricingVersion,
} from "./pricing-config-service.mjs";
import { resolveLegacyStoreOwner } from "./ownership-backfill-policy.mjs";
import { handleCollectorPricingRoute } from "./pricing-routes.mjs";
import { importOfficialCommissionFiles } from "./pricing-official-import.mjs";
import {
  createFxProbe,
  deleteFxProbe,
  getFxStatus,
  ingestFxObservations,
  listFxProbes,
  updateFxProbe,
} from "./pricing-fx-service.mjs";
import {
  claimNextBrowserAgentJob,
  sanitizeBrowserAgentJobPayload,
  transitionBrowserAgentJob,
} from "./browser-agent-policy.mjs";
import {
  acquireSyncLease,
  heartbeatSyncLease,
  releaseSyncLease,
  requireActiveSyncLease,
} from "./sync-lease-policy.mjs";
import { createCollectorHttpHandler } from "./collector-routes.mjs";
import { handleCollectorArtifactRoute } from "./collector-artifact-routes.mjs";
import { createJsonAccountScopedCollectionHandler } from "./account-scoped-collection-routes.mjs";
import { publicPersistedCollectionItem } from "./collection-public-shape.mjs";
import { getCollectorTaskForAccount } from "./collector-desktop-service.mjs";
import { collectorAccountChangeReason, collectorParentSessionTokens, createCollectorAuthRuntime } from "./collector-auth-runtime.mjs";
import { createJsonStateTransactionBoundary } from "./json-state-transaction.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
assertProductionConfiguration("api");
const rootDir = path.resolve(__dirname, "..");
const dataDir = process.env.QH_LOCAL_DATA_DIR || path.join(rootDir, "server-data");
const dataFile = path.join(dataDir, "local-state.json");
const port = Number(process.env.QH_LOCAL_API_PORT || process.env.PORT || 3001);
const listenHost = process.env.QH_LOCAL_API_HOST || "127.0.0.1";
let collectionStoreBackfillComplete = false;
const DEFAULT_ADMIN_USERNAME = process.env.SONLI_ADMIN_USERNAME || "admin";
const DEFAULT_ADMIN_PASSWORD = String(process.env.SONLI_ADMIN_PASSWORD || "");
let collectV3BackfillDone = false;

const defaultState = () => ({
  token: "",
  currentAccountId: "",
  sessionIssuedAt: "",
  sessions: {},
  accounts: [],
  currentStoreId: "",
  currentStoreIdsByAccount: {},
  stores: [],
  currentDataCollectionStoreId: "",
  currentDataCollectionStoreIdsByAccount: {},
  dataCollectionStores: [],
  caches: {
    products: [],
    postings: [],
    warehouses: [],
    collectBox: [],
    favorites: [],
    promotions: [],
    returns: [],
    refunds: [],
    announcements: [],
    messageTemplates: [],
    messageHistory: [],
    productTemplates: [],
    watermarkTemplates: [],
    files: [],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
  auditEvents: [],
  pendingObjectDeletions: [],
  updatedAt: new Date().toISOString(),
});

function normalizeCollectBoxListingStates(state) {
  const collectBox = state?.caches?.collectBox;
  if (!Array.isArray(collectBox)) return;
  state.caches.collectBox = collectBox.map((item) => {
    if (
      item?.status === "上架中" &&
      item.listingLastError &&
      !item.listingTaskId &&
      !item.listingJobId
    ) {
      return { ...item, status: "失败" };
    }
    return item;
  });
}

function normalizeListingJobStates(state) {
  if (!state?.jobs || typeof state.jobs !== "object") return;
  for (const job of Object.values(state.jobs)) {
    if (!job?.listing || !job.ozonTaskId) continue;
    if (String(job.status || "").toUpperCase() === "CHECK_FAILED") {
      job.status = "QUEUED";
      job.statusCheckError = job.statusCheckError || job.errorMessage || "Ozon 上架状态查询失败";
      job.statusCheckErrorAt = job.statusCheckErrorAt || job.updatedAt || new Date().toISOString();
      job.statusCheckFailures = Math.max(1, Number(job.statusCheckFailures) || 0);
      job.errorMessage = "";
    }
    if (!job.statusResponse) continue;
    const statusInfo = deriveImportInfoStatus(job.statusResponse);
    if (!statusInfo.done) continue;
    job.status = statusInfo.status;
    job.errorMessage = statusInfo.errorMessage;
    job.statusMessage = statusInfo.statusMessage || "";
    patchCollectBoxFromImportStatus(state, job, job.ozonTaskId, statusInfo);
  }
}

function ensureAccountState(state) {
  state.accounts = Array.isArray(state.accounts) ? state.accounts : [];
  state.stores = Array.isArray(state.stores) ? state.stores : [];
  state.dataCollectionStores = Array.isArray(state.dataCollectionStores) ? state.dataCollectionStores : [];
  state.caches = state.caches && typeof state.caches === "object" ? state.caches : {};
  normalizeCollectBoxListingStates(state);
  normalizeListingJobStates(state);
  state.sessions =
    state.sessions &&
    typeof state.sessions === "object" &&
    !Array.isArray(state.sessions)
      ? state.sessions
      : {};
  const hasAdmin = state.accounts.some((account) => account.role === "admin");
  if (!hasAdmin) {
    if (DEFAULT_ADMIN_PASSWORD.length < 12) {
      const error = new Error("首次启动必须通过 SONLI_ADMIN_PASSWORD 配置至少 12 位管理员密码");
      error.code = "INITIAL_ADMIN_PASSWORD_REQUIRED";
      throw error;
    }
    state.accounts.unshift(createAccountRecord({
      username: DEFAULT_ADMIN_USERNAME,
      password: DEFAULT_ADMIN_PASSWORD,
      displayName: "管理员",
      role: "admin",
    }));
  }
  state.currentDataCollectionStoreIdsByAccount =
    state.currentDataCollectionStoreIdsByAccount &&
    typeof state.currentDataCollectionStoreIdsByAccount === "object" &&
    !Array.isArray(state.currentDataCollectionStoreIdsByAccount)
      ? state.currentDataCollectionStoreIdsByAccount
      : {};
  state.currentStoreIdsByAccount =
    state.currentStoreIdsByAccount &&
    typeof state.currentStoreIdsByAccount === "object" &&
    !Array.isArray(state.currentStoreIdsByAccount)
      ? state.currentStoreIdsByAccount
      : {};
  state.dataCollectionStores = state.dataCollectionStores.map((store) => ({
    ...store,
    ownerAccountId: resolveLegacyStoreOwner(store, state.accounts),
  }));
  state.stores = state.stores.map((store) => ({
    ...store,
    ownerAccountId: resolveLegacyStoreOwner(store, state.accounts),
  }));
  const defaultOwnerAccountId = state.accounts.length === 1 ? String(state.accounts[0]?.id || "") : "";
  if (defaultOwnerAccountId && state.currentStoreId && !state.currentStoreIdsByAccount[defaultOwnerAccountId]) {
    state.currentStoreIdsByAccount[defaultOwnerAccountId] = state.currentStoreId;
  }
  if (defaultOwnerAccountId && state.currentDataCollectionStoreId && !state.currentDataCollectionStoreIdsByAccount[defaultOwnerAccountId]) {
    state.currentDataCollectionStoreIdsByAccount[defaultOwnerAccountId] = state.currentDataCollectionStoreId;
  }
  for (const account of state.accounts) {
    const operatingStoreId = currentStoreIdForAccount(state, account.id);
    if (operatingStoreId) state.currentStoreIdsByAccount[account.id] = operatingStoreId;
    else delete state.currentStoreIdsByAccount[account.id];
    const currentId = currentDataCollectionStoreIdForAccount(state, account.id);
    if (currentId) state.currentDataCollectionStoreIdsByAccount[account.id] = currentId;
    else delete state.currentDataCollectionStoreIdsByAccount[account.id];
  }
  if (state.token && state.currentAccountId && !state.sessions[state.token]) {
    state.sessions[state.token] = {
      token: state.token,
      accountId: state.currentAccountId,
      issuedAt: state.sessionIssuedAt || new Date().toISOString(),
      lastSeenAt: state.sessionIssuedAt || "",
      legacy: true,
    };
  }
  for (const [token, session] of Object.entries(state.sessions)) {
    if (!token || !session || typeof session !== "object") {
      delete state.sessions[token];
      continue;
    }
    const accountId = String(session.accountId || "");
    if (!state.accounts.some((account) => String(account.id || "") === accountId)) {
      delete state.sessions[token];
      continue;
    }
    session.token = session.token || token;
    session.issuedAt = session.issuedAt || new Date().toISOString();
    session.lastSeenAt = session.lastSeenAt || "";
  }
  if (!state.accounts.some((account) => account.id === state.currentAccountId)) {
    state.currentAccountId = "";
    state.sessionIssuedAt = "";
    state.token = "";
  }
  state.currentDataCollectionStoreId = state.currentAccountId
    ? currentDataCollectionStoreIdForAccount(state, state.currentAccountId)
    : "";
  state.currentStoreId = state.currentAccountId
    ? currentStoreIdForAccount(state, state.currentAccountId)
    : "";
  return state;
}

async function loadState() {
  try {
    const parsed = await loadPersistedState({ dataFile });
    if (!parsed) return ensureAccountState(defaultState());
    const storageVersion = Number(parsed.__storageVersion || 0);
    const base = defaultState();
    const state = ensureAccountState({
      ...base,
      ...parsed,
      caches: { ...base.caches, ...(parsed.caches || {}) },
      hashes: { ...base.hashes, ...(parsed.hashes || {}) },
      leases: { ...base.leases, ...(parsed.leases || {}) },
      browserAgents: { ...base.browserAgents, ...(parsed.browserAgents || {}) },
      jobs: { ...base.jobs, ...(parsed.jobs || {}) },
      reports: Array.isArray(parsed.reports) ? parsed.reports : base.reports,
      auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents : base.auditEvents,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : base.accounts,
      stores: Array.isArray(parsed.stores) ? parsed.stores : base.stores,
      currentDataCollectionStoreIdsByAccount:
        parsed.currentDataCollectionStoreIdsByAccount || base.currentDataCollectionStoreIdsByAccount,
      dataCollectionStores: Array.isArray(parsed.dataCollectionStores) ? parsed.dataCollectionStores : base.dataCollectionStores,
    });
    if (storageVersion > 0) {
      Object.defineProperty(state, "__storageVersion", {
        value: storageVersion,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    if (!collectionStoreBackfillComplete) {
      await backfillCollectionStoresFromLegacy(state);
      collectionStoreBackfillComplete = true;
    }
    await hydrateCollectionStoresIntoState(state);
    if (listingPipelineEnabled() && !collectV3BackfillDone) {
      for (const item of state.caches.collectBox || []) {
        await mirrorCollectItemV3(item, {
          accountId: state.currentAccountId,
          storeId: item.storeId || item.localStoreId || state.currentStoreId,
          dataCollectionStoreId: item.dataCollectionStoreId || state.currentDataCollectionStoreId,
          captureRaw: true,
        });
      }
      collectV3BackfillDone = true;
    }
    await hydrateLegacyStateWithV3(state);
    return state;
  } catch (error) {
    if (listingPipelineEnabled()) throw error;
    return ensureAccountState(defaultState());
  }
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await savePersistedState({ dataDir, dataFile, state });
}

const jsonStateTransaction = createJsonStateTransactionBoundary({ enabled: () => persistenceMode() === "json" });
const collectorAuthRuntime = createCollectorAuthRuntime({ loadState, saveState, persistenceMode, stateTransaction: jsonStateTransaction, readJson: readBody, sendJson });
const handleJsonAccountScopedCollectionRoute = createJsonAccountScopedCollectionHandler({
  authenticate: collectorAuthRuntime.authenticateRequest,
  readJson: readBody,
  normalizeItem: normalizeCollectItem,
  saveState,
  sendJson,
  sendError,
  countAccountItems: (state, account) => cacheItemsForAccount(state, "collectBox", account),
});
const ozonSyncService = createOzonSyncService({
  loadState,
  saveState,
});

const ozonCategoryService = createOzonCategoryService();
const objectCleanupWorker = createObjectCleanupWorker({
  loadState, saveState, removeObject,
  stateTransaction: jsonStateTransaction,
});

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ozon-store-id, x-device-fingerprint",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message, code = "LOCAL_ERROR") {
  sendJson(res, status, { ok: false, message, code });
}

const handleOzonCategoryRoute = createOzonCategoryRouteHandler({
  categoryService: ozonCategoryService,
  requireAuth,
  storeIdForAccountRequest,
  activeStore,
  sendJson,
  sendError,
});

async function readBody(req, { maxBytes = 10 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const err = new Error("请求体过大");
      err.status = 413;
      err.code = "REQUEST_BODY_TOO_LARGE";
      throw err;
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("请求体不是有效 JSON");
    err.status = 400;
    throw err;
  }
}

function contentDispositionFileName(name) {
  return `inline; filename*=UTF-8''${encodeURIComponent(String(name || "file"))}`;
}

function publicLocalFile(file = {}) {
  return {
    id: file.id,
    key: file.key,
    name: file.name,
    contentType: file.contentType,
    size: file.size,
    sha256: file.sha256 || "",
    bucket: file.bucket,
    storage: file.storage || "minio",
    createdAt: file.createdAt,
    createdBy: file.createdBy || "",
    url: file.key ? `/local/files/${encodeURIComponent(file.key)}` : "",
  };
}

function ensureFilesCache(state) {
  state.caches.files = Array.isArray(state.caches.files) ? state.caches.files : [];
  return state.caches.files;
}

function canAccessLocalFile(file, account) {
  if (!file || !account) return false;
  return Boolean(file.createdBy) && String(file.createdBy) === String(account.id);
}

function publicStore(store, state = null) {
  if (!store) return null;
  const currency = storeContractCurrencyCode(state, store);
  const credentialsSaved = Boolean(store.apiKey);
  return {
    id: store.id,
    storeId: store.id,
    label: store.label,
    companyName: store.companyName || store.label,
    legalName: store.legalName || store.label,
    inn: store.inn || store.taxId || "",
    taxId: store.taxId || store.inn || "",
    isPremium: store.isPremium === true,
    status: store.status || "",
    clientId: store.clientId,
    apiKeyMasked: credentialsSaved ? "已保存" : "",
    credentialsSaved,
    apiKeyCreatedAt: store.apiKeyCreatedAt || "",
    apiKeyExpiresAt: store.apiKeyExpiresAt || "",
    ownerAccountId: store.ownerAccountId || "",
    currency,
    currencyCode: currency,
    companyCurrency: currency,
    watermarkTemplateId: store.watermarkTemplateId || "",
    sellerCompanyId: store.sellerCompanyId || "",
    sellerCookieSyncedAt: store.sellerCookieSyncedAt || "",
    savedAt: store.savedAt,
    updatedAt: store.updatedAt || store.savedAt,
    profileSyncedAt: store.profileSyncedAt || "",
  };
}

function publicDataCollectionStore(store = {}, state = null, accountId = state?.currentAccountId || "") {
  if (!store?.id) return null;
  return {
    id: store.id,
    label: store.label || "数据采集店铺",
    sellerCompanyId: store.sellerCompanyId || "",
    ownerAccountId: store.ownerAccountId || "",
    status: store.status || "active",
    note: store.note || "",
    isActive: state ? String(currentDataCollectionStoreIdForAccount(state, accountId) || "") === String(store.id || "") : false,
    createdAt: store.createdAt || "",
    updatedAt: store.updatedAt || store.createdAt || "",
    lastVerifiedAt: store.lastVerifiedAt || "",
  };
}

function localAuthPayload(state, options = {}) {
  const account = options.account || activeAccount(state);
  const token = options.token || state.token || "";
  if (!token || !account) {
    const err = new Error("请先登录 sonli");
    err.status = 401;
    throw err;
  }
  const accountStores = storesForAccount(state, account.id);
  const store = activeStore(state, currentStoreIdForAccount(state, account.id), account.id);
  if (!store) {
    const err = new Error("请先在网页端绑定 Ozon 门店");
    err.status = 400;
    throw err;
  }
  return {
    accessToken: token,
    access_token: token,
    token,
    currentOzonStoreId: store.id,
    storeId: store.id,
    user: {
      id: account.id,
      name: account.displayName || account.username,
      phoneNumber: "",
      platform: "local",
    },
    stores: accountStores.map((item) => publicStore(item, state)),
  };
}

function appendRequestAudit(state, req, account, {
  action,
  status = "SUCCESS",
  storeId = "",
  deviceId = "",
  source = "",
  entityType = "operation",
  entityId = "",
  correlationId = "",
  eventId = "",
  metadata = {},
} = {}) {
  const headerDeviceId = String(req?.headers?.["x-device-fingerprint"] || "").trim();
  const resolvedDeviceId = headerDeviceId || String(deviceId || "").trim();
  return appendAuditEvent(state, {
    eventId,
    correlationId,
    action,
    status,
    accountId: account?.id || "",
    storeId,
    deviceId: resolvedDeviceId,
    source: source || (resolvedDeviceId ? "extension" : "web"),
    actorType: account ? "account" : "system",
    actorId: account?.id || "",
    entityType,
    entityId,
    metadata,
  });
}

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: process.env.TZ || "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dayKeyFormatter.format(date);
}

function postingDateKey(posting = {}) {
  return dateKey(
    posting.in_process_at ||
      posting.created_at ||
      posting.shipment_date ||
      posting.delivering_date ||
      posting.syncedAt
  );
}

function summarize(state) {
  const postings = state.caches.postings || [];
  const syncTypes = new Set(["PRODUCTS", "POSTINGS", "WAREHOUSES", "PROMOTIONS"]);
  const today = dateKey();
  const dayMs = 24 * 60 * 60 * 1000;
  const weekKeys = new Set(
    Array.from({ length: 7 }, (_, index) => dateKey(Date.now() - index * dayMs))
  );
  const moneySummary = summarizeOrderMoney(postings, { dateKey, todayKey: today, weekKeys });
  const postingStats = postings.reduce(
    (stats, posting) => {
      const status = String(posting.status || "").toLowerCase();
      const day = postingDateKey(posting);
      if (status) stats.statusCounts[status] = (stats.statusCounts[status] || 0) + 1;
      if (day === today) {
        stats.todayPostings += 1;
      }
      if (weekKeys.has(day)) {
        stats.weekPostings += 1;
      }
      if (status === "awaiting_packaging") stats.awaitingPackaging += 1;
      if (status === "awaiting_deliver") stats.awaitingDeliver += 1;
      if (status.startsWith("awaiting")) stats.pendingPostings += 1;
      return stats;
    },
    {
      todayPostings: 0,
      weekPostings: 0,
      awaitingPackaging: 0,
      awaitingDeliver: 0,
      pendingPostings: 0,
      statusCounts: {},
    }
  );
  return {
    products: state.caches.products?.length || 0,
    postings: postings.length,
    postingsTotal: postings.length,
    ...moneySummary,
    todayPostings: postingStats.todayPostings,
    weekPostings: postingStats.weekPostings,
    awaitingPackaging: postingStats.awaitingPackaging,
    awaitingDeliver: postingStats.awaitingDeliver,
    pendingPostings: postingStats.pendingPostings,
    statusCounts: postingStats.statusCounts,
    warehouses: state.caches.warehouses?.length || 0,
    collectBox: state.caches.collectBox?.length || 0,
    favorites: state.caches.favorites?.length || 0,
    promotions: state.caches.promotions?.length || 0,
    returns: state.caches.returns?.length || 0,
    refunds: state.caches.refunds?.length || 0,
    announcements: state.caches.announcements?.length || 0,
    messageTemplates: state.caches.messageTemplates?.length || 0,
    messageHistory: state.caches.messageHistory?.length || 0,
    productTemplates: state.caches.productTemplates?.length || 0,
    watermarkTemplates: state.caches.watermarkTemplates?.length || 0,
    files: state.caches.files?.length || 0,
    lastSyncAt: state.reports.findLast?.((r) => r.status === "SUCCESS" && syncTypes.has(r.type))?.createdAt || null,
  };
}

function limitedLocalStatePayload(state) {
  const empty = defaultState();
  return {
    ok: true,
    requiresLogin: true,
    token: "",
    account: null,
    accounts: [],
    currentStoreId: "",
    binding: null,
    stores: [],
    currentDataCollectionStoreId: "",
    dataCollectionStore: null,
    dataCollectionStores: [],
    summary: summarize(empty),
    caches: empty.caches,
    jobs: {},
    updatedAt: state.updatedAt,
  };
}

function accountScopedCache(items, account, accountStoreIds) {
  const list = Array.isArray(items) ? items : [];
  const accountId = String(account?.id || "");
  return list.filter((item) => {
    const ownerId = String(item?.accountId || item?.ownerAccountId || item?.createdBy || "");
    if (ownerId) return ownerId === accountId;
    const storeId = String(item?.storeId || item?.localStoreId || item?.operatingStoreId || "");
    return Boolean(storeId) && accountStoreIds.has(storeId);
  });
}

function cacheItemsForAccount(state, cacheKey, account) {
  const storeIds = new Set(
    storesForAccount(state, account?.id).map((store) => String(store.id || "")).filter(Boolean),
  );
  return accountScopedCache(state.caches?.[cacheKey], account, storeIds);
}

function cacheItemBelongsToAccount(state, item, account) {
  return cacheItemsForAccount({ ...state, caches: { scoped: [item] } }, "scoped", account).length === 1;
}

function scopeCacheItemForAccount(item, account, store = null) {
  return {
    ...item,
    accountId: account.id,
    ...(store ? cacheItemScope(store, account.id) : {}),
  };
}

function localStatePayload(state, options = {}) {
  const authenticated = options.authenticated ?? true;
  const account = authenticated ? (options.account || activeAccount(state)) : null;
  const token = options.token || state.token || "";
  if (!authenticated || !account) return limitedLocalStatePayload(state);
  const includeAccounts = options.includeAccounts ?? false;
  const accountStores = storesForAccount(state, account.id);
  const accountCurrentStoreId = currentStoreIdForAccount(state, account.id);
  const accountDataCollectionStores = dataCollectionStoresForAccount(state, account.id);
  const accountCurrentDataCollectionStoreId = currentDataCollectionStoreIdForAccount(state, account.id);
  const accountStoreIds = new Set(accountStores.map((store) => String(store.id || "")).filter(Boolean));
  const visibleJobs = Object.fromEntries(Object.entries(state.jobs || {}).filter(([, job]) =>
    String(job?.accountId || "") === String(account.id),
  ));
  const visibleCollectBox = (state.caches.collectBox || [])
    .filter((item) => String(item?.accountId || "") === String(account.id))
    .map(publicPersistedCollectionItem);
  const visibleFiles = ensureFilesCache(state).filter((file) => canAccessLocalFile(file, account));
  const visibleCaches = {
    products: accountScopedCache(state.caches.products, account, accountStoreIds),
    postings: accountScopedCache(state.caches.postings, account, accountStoreIds),
    warehouses: accountScopedCache(state.caches.warehouses, account, accountStoreIds),
    collectBox: visibleCollectBox,
    favorites: accountScopedCache(state.caches.favorites, account, accountStoreIds),
    promotions: accountScopedCache(state.caches.promotions, account, accountStoreIds),
    returns: accountScopedCache(state.caches.returns, account, accountStoreIds),
    refunds: accountScopedCache(state.caches.refunds, account, accountStoreIds),
    // Announcements are intentionally global broadcasts.
    announcements: state.caches.announcements || [],
    messageTemplates: accountScopedCache(state.caches.messageTemplates, account, accountStoreIds),
    messageHistory: accountScopedCache(state.caches.messageHistory, account, accountStoreIds),
    productTemplates: accountScopedCache(state.caches.productTemplates, account, accountStoreIds),
    watermarkTemplates: accountScopedCache(state.caches.watermarkTemplates, account, accountStoreIds),
    files: visibleFiles,
  };
  return {
    ok: true,
    token,
    account: publicAccount(account),
    accounts: includeAccounts ? (state.accounts || []).map(publicAccount) : [],
    currentStoreId: accountCurrentStoreId,
    binding: publicStore(activeStore(state, accountCurrentStoreId, account.id), state),
    stores: accountStores.map((store) => publicStore(store, state)),
    currentDataCollectionStoreId: accountCurrentDataCollectionStoreId,
    dataCollectionStore: publicDataCollectionStore(activeDataCollectionStore(state, account.id), state, account.id),
    dataCollectionStores: accountDataCollectionStores.map((store) => publicDataCollectionStore(store, state, account.id)),
    summary: summarize({ ...state, caches: visibleCaches, jobs: visibleJobs }),
    caches: {
      ...visibleCaches,
      files: visibleFiles.map(publicLocalFile),
    },
    jobs: visibleJobs,
    updatedAt: state.updatedAt,
  };
}

function upsertById(list, id, value) {
  const key = String(id || "");
  if (!key) return false;
  const idx = list.findIndex((item) => String(item.id || item.product_id || item.posting_number || item.warehouse_id) === key);
  if (idx >= 0) list[idx] = value;
  else list.push(value);
  return idx < 0;
}

function collectItemKey(item) {
  return String(item?.id || item?.sourceExternalId || item?.sku || item?.productUrl || "");
}

async function saveCollectBoxItemAtomic(item, { account, store, dataCollectionStoreId = "" }) {
  const latest = await loadState();
  const latestStore = activeStore(latest, store?.id, account.id);
  if (!latestStore) {
    const error = new Error("经营店铺已被删除或转移");
    error.status = 409;
    throw error;
  }
  const scopedItem = {
    ...scopeCacheItemForAccount(item, account, latestStore),
    localStoreId: latestStore.id,
    dataCollectionStoreId,
  };
  const key = collectItemKey(scopedItem);
  latest.caches.collectBox = (latest.caches.collectBox || []).filter((row) =>
    !(collectItemKey(row) === key && cacheItemBelongsToAccount(latest, row, account))
  );
  latest.caches.collectBox.unshift(scopedItem);
  await saveState(latest);
  await mirrorCollectItemV3(scopedItem, {
    accountId: account.id,
    storeId: latestStore.id,
    dataCollectionStoreId,
    captureRaw: true,
  }).catch((error) => console.warn(`[listing-v3] 采集数据镜像失败: ${error?.message || error}`));
  return { item: scopedItem, state: latest };
}

async function updateCollectBoxItemAtomic(id, patch, { account }) {
  const latest = await loadState();
  const index = (latest.caches.collectBox || []).findIndex((item) =>
    String(item.id) === String(id) && cacheItemBelongsToAccount(latest, item, account),
  );
  if (index < 0) return null;
  const current = latest.caches.collectBox[index];
  latest.caches.collectBox[index] = {
    ...current,
    ...patch,
    id,
    accountId: account.id,
    storeId: current.storeId || current.localStoreId || "",
    localStoreId: current.localStoreId || current.storeId || "",
    dataCollectionStoreId: current.dataCollectionStoreId || "",
    updatedAt: new Date().toISOString(),
  };
  await saveState(latest);
  await mirrorCollectItemV3(latest.caches.collectBox[index], {
    accountId: account.id,
    storeId: latest.caches.collectBox[index].storeId || latest.caches.collectBox[index].localStoreId || "",
    dataCollectionStoreId: latest.caches.collectBox[index].dataCollectionStoreId || "",
  }).catch((error) => console.warn(`[listing-v3] 草稿镜像失败: ${error?.message || error}`));
  return latest.caches.collectBox[index];
}

async function deleteCollectBoxItemsAtomic(latest, ids = [], { account }) {
  const targetIds = new Set(ids.map((id) => String(id || "")).filter(Boolean));
  const visibleBefore = cacheItemsForAccount(latest, "collectBox", account);
  if (!targetIds.size) return { deleted: 0, total: visibleBefore.length, state: latest };
  const before = latest.caches.collectBox || [];
  latest.caches.collectBox = before.filter((item) =>
    !(targetIds.has(String(item.id)) && cacheItemBelongsToAccount(latest, item, account))
  );
  const deleted = before.length - latest.caches.collectBox.length;
  if (deleted > 0) await savePersistedCollectBox({ dataDir, dataFile, state: latest });
  if (deleted > 0) await softDeleteCollectItemsForAccountV4(account.id, [...targetIds]);
  return {
    deleted,
    total: cacheItemsForAccount(latest, "collectBox", account).length,
    state: latest,
  };
}

async function saveCollectBoxBatchAtomic(items, { account, store, dataCollectionStoreId = "" }) {
  const latest = await loadState();
  const latestStore = activeStore(latest, store?.id, account.id);
  if (!latestStore) {
    const error = new Error("经营店铺已被删除或转移");
    error.status = 409;
    throw error;
  }
  latest.caches.collectBox = latest.caches.collectBox || [];
  const scopedItems = items.map((item) => ({
    ...scopeCacheItemForAccount(item, account, latestStore),
    localStoreId: latestStore.id,
    dataCollectionStoreId,
  }));
  for (const item of scopedItems) {
    const key = collectItemKey(item);
    latest.caches.collectBox = latest.caches.collectBox.filter((row) =>
      !(collectItemKey(row) === key && cacheItemBelongsToAccount(latest, row, account))
    );
    latest.caches.collectBox.unshift(item);
  }
  await saveState(latest);
  for (const item of scopedItems) {
    await mirrorCollectItemV3(item, {
      accountId: account.id,
      storeId: latestStore.id,
      dataCollectionStoreId,
      captureRaw: true,
    }).catch((error) => console.warn(`[listing-v3] 批量采集数据镜像失败: ${error?.message || error}`));
  }
  return { state: latest, items: scopedItems };
}

function pageParams(url, defaults = {}) {
  const current = Math.max(1, Number(url.searchParams.get("current") || url.searchParams.get("currentPage") || defaults.current || 1) || 1);
  const pageSize = Math.max(1, Math.min(200, Number(url.searchParams.get("pageSize") || defaults.pageSize || 20) || 20));
  return { current, pageSize };
}

function emptyPage(url, data = []) {
  const { current, pageSize } = pageParams(url);
  return { data, items: data, total: data.length, current, pageSize };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function cleanText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeCurrencyCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "";
}

function productCurrencyCandidates(product = {}) {
  return [
    product.currency_code,
    product.currencyCode,
    product.companyCurrency,
    product.currency,
    product.priceCurrency,
    product.price?.currency_code,
    product.price?.currencyCode,
    product.price?.currency,
    product.price?.price_currency,
    product.marketing_price_currency,
  ].map(normalizeCurrencyCode).filter(Boolean);
}

function inferCurrencyFromProductCache(state, store = null) {
  const products = Array.isArray(state?.caches?.products) ? state.caches.products : [];
  const storeId = String(store?.id || "");
  const scoped = products.filter((product) => !product.storeId || !storeId || String(product.storeId) === storeId);
  const counts = new Map();
  for (const product of scoped.length ? scoped : products) {
    const [code] = productCurrencyCandidates(product);
    if (code) counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function storeContractCurrencyCode(state, store = null) {
  return normalizeCurrencyCode(
    store?.companyCurrency ||
    store?.currency ||
    store?.currencyCode ||
    store?.contractCurrency ||
    store?.defaultCurrency
  ) || inferCurrencyFromProductCache(state, store) || "RUB";
}

function withStoreContractCurrency(state, store, items = []) {
  const currencyCode = storeContractCurrencyCode(state, store);
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    currency_code: currencyCode,
    currencyCode,
  }));
}

function normalizeMessageTemplate(body, existing = {}) {
  const now = new Date().toISOString();
  const templateName = cleanText(
    hasOwn(body, "templateName") ? body.templateName : hasOwn(body, "name") ? body.name : existing.templateName || existing.name,
    80
  );
  if (!templateName) {
    const err = new Error("模板名称必填");
    err.status = 400;
    throw err;
  }
  const categoryValue = cleanText(hasOwn(body, "category") ? body.category : existing.category || "custom", 32);
  const allowedCategories = new Set(["review", "pickup", "custom"]);
  const content = cleanText(hasOwn(body, "content") ? body.content : existing.content || "", 2000);
  return {
    ...existing,
    id: existing.id || crypto.randomUUID(),
    templateName,
    name: templateName,
    category: allowedCategories.has(categoryValue) ? categoryValue : "custom",
    content,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

function normalizeMessageHistoryItem(body, store = null) {
  const now = new Date().toISOString();
  const kindValue = cleanText(body.kind || body.type || "custom", 32);
  const allowedKinds = new Set(["review", "pickup", "custom"]);
  const statusValue = cleanText(body.status || "local_record", 32);
  const allowedStatuses = new Set(["local_record", "success", "failed", "pending"]);
  const sentAt = cleanText(body.sentAt || body.createdAt || now, 40);
  return {
    id: body.id || crypto.randomUUID(),
    kind: allowedKinds.has(kindValue) ? kindValue : "custom",
    receiver: cleanText(body.receiver || body.postingNumber || body.posting_number || "—", 120),
    postingNumber: cleanText(body.postingNumber || body.posting_number || body.receiver || "", 120),
    templateName: cleanText(body.templateName || body.template || "默认模板", 120),
    content: cleanText(body.content || "", 1000),
    status: allowedStatuses.has(statusValue) ? statusValue : "local_record",
    storeId: cleanText(body.storeId || store?.id || "", 80),
    storeName: cleanText(body.storeName || store?.label || store?.companyName || "当前店铺", 120),
    sentAt,
    createdAt: now,
    local: true,
    dryRun: true,
  };
}

function normalizeAnnouncement(body, existing = {}) {
  const now = new Date().toISOString();
  const title = cleanText(hasOwn(body, "title") ? body.title : existing.title, 160);
  if (!title) {
    const err = new Error("公告标题必填");
    err.status = 400;
    throw err;
  }
  const rawSections = Array.isArray(body.sections) ? body.sections : (Array.isArray(existing.sections) ? existing.sections : []);
  const sections = rawSections.slice(0, 12).map((section) => {
    if (Array.isArray(section)) {
      return [
        cleanText(section[0], 80),
        (Array.isArray(section[1]) ? section[1] : []).slice(0, 20).map((text) => cleanText(text, 500)).filter(Boolean),
      ];
    }
    return [
      cleanText(section?.title, 80),
      (Array.isArray(section?.bullets) ? section.bullets : []).slice(0, 20).map((text) => cleanText(text, 500)).filter(Boolean),
    ];
  }).filter(([sectionTitle, bullets]) => sectionTitle || bullets.length);
  return {
    ...existing,
    id: cleanText(body.id || body.announcementId || existing.id || crypto.randomUUID(), 120),
    title,
    level: cleanText(hasOwn(body, "level") ? body.level : existing.level || "通知", 40),
    type: cleanText(hasOwn(body, "type") ? body.type : existing.type || "公告", 60),
    time: cleanText(body.time || body.publishedAt || body.createdAt || existing.time || now, 80),
    summary: cleanText(hasOwn(body, "summary") ? body.summary : existing.summary || "", 800),
    sections,
    read: Boolean(hasOwn(body, "read") ? body.read : existing.read),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    local: true,
  };
}

function normalizeReturnItem(body, kind = "return", store = null) {
  const now = new Date().toISOString();
  const id = cleanText(
    body.id ||
      body.returnId ||
      body.return_id ||
      body.refundId ||
      body.refund_id ||
      body.postingNumber ||
      body.posting_number ||
      crypto.randomUUID(),
    160
  );
  const typeValue = cleanText(body.type || body.kind || kind, 32);
  const statusValue = cleanText(body.status || body.state || "unknown", 60);
  const createdAt = cleanText(
    body.createdAt ||
      body.created_at ||
      body.requestedAt ||
      body.requested_at ||
      body.return_date ||
      now,
    60
  );
  const products = Array.isArray(body.products) ? body.products : [];
  const firstProduct = products[0] || {};
  return {
    ...body,
    id,
    type: typeValue,
    status: statusValue || "unknown",
    postingNumber: cleanText(body.postingNumber || body.posting_number || body.posting || "", 160),
    sku: cleanText(body.sku || body.offer_id || firstProduct.sku || firstProduct.offer_id || "", 160),
    productName: cleanText(body.productName || body.product_name || firstProduct.name || firstProduct.title || "", 300),
    storeId: cleanText(body.storeId || store?.id || "", 80),
    storeName: cleanText(body.storeName || store?.label || store?.companyName || "当前店铺", 120),
    requestedAt: createdAt,
    createdAt,
    updatedAt: now,
    local: true,
  };
}

function normalizeProductTemplate(body, existing = {}, store = null) {
  const now = new Date().toISOString();
  const templateName = cleanText(
    hasOwn(body, "templateName") ? body.templateName : hasOwn(body, "name") ? body.name : existing.templateName || existing.name,
    80
  );
  if (!templateName) {
    const err = new Error("模板名称必填");
    err.status = 400;
    throw err;
  }
  const isDefault = hasOwn(body, "isDefault")
    ? Boolean(body.isDefault)
    : hasOwn(body, "default")
      ? Boolean(body.default)
      : Boolean(existing.isDefault);
  const storeId = cleanText(hasOwn(body, "storeId") ? body.storeId : existing.storeId || store?.id || "", 80);
  const storeName = cleanText(
    hasOwn(body, "storeName") ? body.storeName : existing.storeName || store?.label || store?.companyName || "当前店铺",
    120
  );
  const content = cleanText(hasOwn(body, "content") ? body.content : existing.content || "", 3000);
  return {
    ...existing,
    id: existing.id || crypto.randomUUID(),
    templateName,
    name: templateName,
    storeId,
    storeName,
    isDefault,
    default: isDefault,
    content,
    templateSettings: {
      ...(existing.templateSettings || {}),
      content,
    },
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

function normalizeWatermarkTemplate(body, existing = {}) {
  const now = new Date().toISOString();
  const name = cleanText(
    hasOwn(body, "name") ? body.name : hasOwn(body, "templateName") ? body.templateName : existing.name || existing.templateName,
    80
  );
  if (!name) {
    const err = new Error("模板名称必填");
    err.status = 400;
    throw err;
  }
  const typeValue = cleanText(hasOwn(body, "type") ? body.type : existing.type || "text", 24);
  const allowedTypes = new Set(["text", "border", "image"]);
  const fontSize = Math.max(8, Math.min(120, Number(body.fontSize ?? existing.fontSize ?? 28) || 28));
  const opacity = Math.max(0, Math.min(100, Number(body.opacity ?? existing.opacity ?? 40) || 40));
  const rotate = Math.max(-180, Math.min(180, Number(body.rotate ?? existing.rotate ?? -30) || -30));
  const margin = Math.max(0, Math.min(50, Number(body.margin ?? existing.margin ?? 8) || 8));
  const positionValue = cleanText(hasOwn(body, "position") ? body.position : existing.position || "center", 24);
  const allowedPositions = new Set(["center", "tile", "top-left", "top-right", "bottom-left", "bottom-right"]);
  const isDefault = hasOwn(body, "isDefault") ? Boolean(body.isDefault) : Boolean(existing.isDefault);
  return {
    ...existing,
    id: existing.id || crypto.randomUUID(),
    name,
    templateName: name,
    type: allowedTypes.has(typeValue) ? typeValue : "text",
    text: cleanText(hasOwn(body, "text") ? body.text : existing.text || "", 200),
    font: cleanText(hasOwn(body, "font") ? body.font : existing.font || "system", 40),
    fontSize,
    color: cleanText(hasOwn(body, "color") ? body.color : existing.color || "#ffffff", 24),
    opacity,
    rotate,
    margin,
    position: allowedPositions.has(positionValue) ? positionValue : "center",
    isDefault,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

function localWriteDisabled(res, feature = "该功能") {
  sendError(
    res,
    409,
    `${feature}在本地复刻版中不会直接写入 Ozon。请先在后台绑定并确认真实写入链路后再启用。`,
    "LOCAL_OZON_WRITE_DISABLED",
  );
}

function normalizeCollectItem(raw = {}, sourceId = "") {
  const sku = String(raw.sku || raw.productId || raw.product_id || raw.offer_id || "").trim();
  const productUrl = raw.productUrl || raw.url || raw.link || "";
  return {
    ...raw,
    id: String(raw.id || raw.collectId || raw.sourceExternalId || sku || crypto.randomUUID()),
    sku,
    productUrl,
    name: raw.name || raw.title || raw.productName || sku || productUrl || "—",
    source: raw.source || sourceId || raw.platform || "插件采集",
    status: raw.status || "待处理",
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}


// === Ozon.ru 竞品数据抓取 ===
// 通过 ego-browser CLI 从 ozon.ru 页面抓取商品数据（标题/价格/图片/卖家/品牌等）
// 后备方案：直接 HTTP fetch（可能被反爬拦截）

const EGO_BROWSER_BIN = "/Users/songliang/.local/bin/ego-browser";

function spawnAsync(cmd, args, input, timeoutMs = 60000) {

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`spawn timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`exit ${code}: ${stderr.slice(0, 500)}`));
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runEgoScript(script, timeoutMs = 120000) {
  const tmpFile = path.join("/tmp", `qh-ego-scrape-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  await fs.writeFile(tmpFile, script, "utf8");
  try {
    return await spawnAsync(
      "/bin/zsh",
      ["-lc", `${shellQuote(EGO_BROWSER_BIN)} nodejs < ${shellQuote(tmpFile)}`],
      "",
      timeoutMs,
    );
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

async function scrapeOzonProductBySku(sku) {
  const cleanSku = String(sku || "").trim();
  if (!cleanSku) throw new Error("SKU 不能为空");

  // 策略1：通过 ego-browser 抓取 ozon.ru 搜索页
  const script = `
const task = await useOrCreateTaskSpace('qh-scrape-' + ${JSON.stringify(cleanSku)}.slice(-6));
await openOrReuseTab('https://www.ozon.ru/search/?text=${cleanSku}', { wait: true, timeout: 30 });
await wait(4);
const data = await js(() => {
  const results = [];
  // 从搜索结果页提取商品数据
  const cards = document.querySelectorAll('[data-index]');
  for (let i = 0; i < Math.min(cards.length, 5); i++) {
    const card = cards[i];
    const link = card.querySelector('a[href*="/product/"]');
    if (!link) continue;
    const href = link.getAttribute('href') || '';
    const skuMatch = href.match(/-(\\d+)\/?(?:\?|$)/);
    const title = card.querySelector('span[class*="title"], h3, [class*="title"]')?.textContent?.trim() || '';
    const priceText = card.querySelector('[class*="price"]')?.textContent?.trim() || '';
    const img = card.querySelector('img')?.src || '';
    results.push({
      sku: skuMatch ? skuMatch[1] : '',
      title: title,
      priceText: priceText,
      image: img,
      url: href.startsWith('http') ? href : 'https://www.ozon.ru' + href,
    });
  }
  return JSON.stringify(results);
})();
cliLog(data);
`;
  try {
    const result = await runEgoScript(script, 90000);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const lines = output.trim().split("\n").filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    if (lastLine) {
      try {
        const items = JSON.parse(lastLine);
        if (Array.isArray(items) && items.length > 0) {
          return items;
        }
      } catch {}
    }
  } catch (e) {
    console.error("[scrapeOzonProduct] ego-browser failed:", e.message);
  }

  // 策略2：直接 HTTP fetch ozon.ru 搜索页（后备，可能被反爬）
  try {
    const resp = await fetch(
      `https://www.ozon.ru/search/?text=${encodeURIComponent(cleanSku)}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "ru-RU,ru;q=0.9",
        },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (resp.ok) {
      const html = await resp.text();
      // 从 HTML 中提取 embedded JSON data
      const items = [];
      // Ozon 页面中有 data-state 属性包含商品数据
      const stateMatches = html.match(/data-state="([^"]+)"/g) || [];
      for (const match of stateMatches.slice(0, 50)) {
        try {
          const jsonStr = match.replace(/^data-state="/, "").replace(/"$/, "").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
          const parsed = JSON.parse(jsonStr);
          if (parsed && (parsed.items || parsed.searchResults || parsed.card)) {
            const cardItems = parsed.items || parsed.searchResults || [parsed.card];
            for (const item of cardItems) {
              if (item && (item.sku || item.id)) {
                items.push({
                  sku: String(item.sku || item.id || ""),
                  title: item.title || item.name || "",
                  priceText: String(item.price || item.priceText || ""),
                  image: item.image || (item.images || [])[0] || "",
                  url: item.url || `https://www.ozon.ru/product/${item.sku || item.id}/`,
                });
              }
            }
          }
        } catch {}
      }
      if (items.length > 0) return items;
    }
  } catch (e) {
    console.error("[scrapeOzonProduct] HTTP fetch failed:", e.message);
  }

  return [];
}

async function scrapeOzonProductDetail(sku) {
  const cleanSku = String(sku || "").trim();
  if (!cleanSku) throw new Error("SKU 不能为空");

  // 尝试通过 ego-browser proxy 抓取（端口 3002）
  const EGO_PROXY_URL = process.env.EGO_PROXY_URL || "http://127.0.0.1:3002";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const resp = await fetch(`${EGO_PROXY_URL}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: cleanSku }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      if (data?.ok && data?.data) {
        return data.data;
      }
    }
  } catch (e) {
    console.error("[scrapeOzonProductDetail] ego-proxy failed:", e.message);
  }

  // 后备：直接 spawn ego-browser（在非沙箱环境工作时可用）
  const scriptPath = path.join(__dirname, "scrape-script.js");
  let scriptTemplate;
  try {
    scriptTemplate = await fs.readFile(scriptPath, "utf8");
  } catch {
    return null;
  }
  const script = scriptTemplate.replace(/SKU_PLACEHOLDER/g, JSON.stringify(cleanSku));
  try {
    const result = await runEgoScript(script, 120000);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const lines = output.trim().split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === "SCRAPE_FAILED") break;
      try {
        const parsed = JSON.parse(line);
        if (parsed && (parsed.title || parsed.priceText)) {
          return parsed;
        }
      } catch {}
    }
  } catch (e) {
    console.error("[scrapeOzonProductDetail] direct spawn failed:", e.message);
  }
  return null;
}


function getRequestStore(state, req, fallbackStoreId) {
  const storeId = req.headers["x-ozon-store-id"] || fallbackStoreId || state.currentStoreId;
  const store = activeStore(state, storeId);
  if (!store) {
    const err = new Error("未绑定 Ozon 店铺");
    err.status = 400;
    throw err;
  }
  return store;
}

function normalizeImportTaskStatus(value = "") {
  const status = String(value || "").toLowerCase();
  if (["imported", "success", "processed", "done", "complete", "completed", "finished"].includes(status)) return "SUCCESS";
  if (status === "skipped") return "SKIPPED";
  if (["failed", "error", "rejected", "cancelled", "canceled", "validation_error"].includes(status)) return "FAILED";
  if (["pending", "processing", "created", "queued", "running", "importing", "checking", "in_progress"].includes(status)) return "RUNNING";
  return status ? status.toUpperCase() : "QUEUED";
}

function upsertImportJob(state, patch) {
  const id = String(patch.id || patch.localTaskId || crypto.randomUUID());
  const previous = state.jobs[id] || {};
  const job = {
    ...previous,
    ...patch,
    id,
    localTaskId: id,
    listing: true,
    createdAt: previous.createdAt || patch.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.jobs[id] = job;
  return job;
}

function findImportJobByTaskId(state, taskId) {
  return Object.values(state.jobs || {}).find((row) =>
    String(row.ozonTaskId || row.taskId || row.id) === String(taskId),
  ) || null;
}

function importJobBelongsToAccount(state, job, account) {
  const ownerId = String(job?.accountId || "");
  if (ownerId) return ownerId === String(account?.id || "");
  const storeId = String(job?.storeId || "");
  return Boolean(storeId) && Boolean(activeStore(state, storeId, account?.id));
}

function importInfoItems(data = {}) {
  const result = data?.result && typeof data.result === "object" ? data.result : {};
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(result.products)) return result.products;
  if (Array.isArray(data.products)) return data.products;
  return [];
}

function ozonErrorMessages(value, out = []) {
  if (!value || out.length >= 8) return out;
  if (typeof value === "string") {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      ozonErrorMessages(item, out);
      if (out.length >= 8) break;
    }
    return out;
  }
  if (typeof value === "object") {
    const text = value.message || value.error || value.description || value.code;
    if (text) out.push(String(text));
    for (const key of ["errors", "reasons", "validation_errors", "details"]) {
      if (value[key]) ozonErrorMessages(value[key], out);
      if (out.length >= 8) break;
    }
  }
  return out;
}

function deriveImportInfoStatus(data = {}) {
  const result = data?.result && typeof data.result === "object" ? data.result : {};
  const items = importInfoItems(data);
  const responseErrors = ozonErrorMessages([
    data?.errors,
    data?.error,
    data?.message,
    result?.errors,
    result?.error,
    result?.message,
  ]);
  if (items.length) {
    const statuses = items.map((item) => normalizeImportTaskStatus(item.status || item.state || item.status_name));
    const itemErrors = ozonErrorMessages(items.map((item, index) => [
      item?.errors,
      item?.error,
      item?.message,
      item?.validation_errors,
      item?.reasons,
      ...(statuses[index] === "FAILED" ? [item?.status_description] : []),
    ]));
    const errors = [...responseErrors, ...itemErrors];
    const failed = statuses.filter((status) => status === "FAILED").length;
    const success = statuses.filter((status) => status === "SUCCESS").length;
    const skipped = statuses.filter((status) => status === "SKIPPED").length;
    const done = failed + success + skipped === statuses.length;
    const status = done
      ? (failed > 0
          ? (success > 0 || skipped > 0 ? "PARTIAL_SUCCESS" : "FAILED")
          : (success > 0 ? (skipped > 0 ? "PARTIAL_SUCCESS" : "SUCCESS") : "SKIPPED"))
      : "RUNNING";
    return {
      items,
      failed,
      success,
      skipped,
      done,
      status,
      errorMessage: failed > 0 ? (errors.join("；") || "Ozon 返回部分或全部商品导入失败") : "",
      statusMessage: status === "SKIPPED"
        ? "Ozon 已跳过全部商品，本次任务没有创建或更新商品卡片"
        : (skipped > 0 ? `Ozon 跳过了 ${skipped} 个商品` : ""),
    };
  }
  const directStatus = normalizeImportTaskStatus(
    result.status || result.state || result.status_name || data.status || data.state || data.status_name,
  );
  if (directStatus === "SUCCESS") return { items, failed: 0, success: 1, done: true, status: "SUCCESS", errorMessage: "" };
  if (directStatus === "SKIPPED") return {
    items,
    failed: 0,
    success: 0,
    skipped: 1,
    done: true,
    status: "SKIPPED",
    errorMessage: "",
    statusMessage: "Ozon 已跳过商品，本次任务没有创建或更新商品卡片",
  };
  if (directStatus === "FAILED") return { items, failed: 1, success: 0, done: true, status: "FAILED", errorMessage: responseErrors.join("；") || "Ozon 上架任务失败" };
  if (responseErrors.length) return { items, failed: 1, success: 0, done: true, status: "FAILED", errorMessage: responseErrors.join("；") };
  return { items, failed: 0, success: 0, done: false, status: "RUNNING", errorMessage: "" };
}

function collectPatchFromImportStatus(statusInfo = {}) {
  if (!statusInfo.done) return null;
  const now = new Date().toISOString();
  if (statusInfo.status === "SUCCESS") {
    return {
      status: "已上架",
      listingLastError: "",
      listingCompletedAt: now,
    };
  }
  if (statusInfo.status === "SKIPPED") {
    return {
      status: "已跳过",
      listingLastError: "",
      listingStatusMessage: statusInfo.statusMessage || "Ozon 已跳过商品",
      listingCompletedAt: now,
    };
  }
  if (statusInfo.status === "PARTIAL_SUCCESS") {
    return {
      status: "部分成功",
      listingLastError: statusInfo.errorMessage || "",
      listingStatusMessage: statusInfo.statusMessage || "Ozon 仅处理了部分商品",
      listingCompletedAt: now,
    };
  }
  return {
    status: "失败",
    listingLastError: statusInfo.errorMessage || "Ozon 上架任务失败",
    listingLastErrorAt: now,
  };
}

const importStatusPollableStatuses = new Set(["QUEUED", "RUNNING", "PENDING", "PROCESSING", "CREATED", "SUBMITTED"]);
let importStatusPollTimer = null;
let importStatusPollRunning = false;

function importJobNeedsStatusPoll(job = {}) {
  return Boolean(
    job.pipelineVersion !== "v3"
      && job.listing
      && job.ozonTaskId
      && importStatusPollableStatuses.has(String(job.status || "").toUpperCase()),
  );
}

function patchCollectBoxFromImportStatus(state, job, taskId, statusInfo) {
  const collectPatch = collectPatchFromImportStatus(statusInfo);
  if (!collectPatch || !job.collectBoxId) return;
  const index = (state.caches?.collectBox || []).findIndex((item) =>
    String(item.id) === String(job.collectBoxId)
    && (
      (
        String(item.accountId || "") === String(job.accountId || "")
        && (!job.storeId || String(item.storeId || item.localStoreId || "") === String(job.storeId))
      )
      || (
        (state.accounts || []).length === 1
        && !item.accountId
        && !item.storeId
        && !item.localStoreId
      )
    ),
  );
  if (index < 0) return;
  state.caches.collectBox[index] = {
    ...state.caches.collectBox[index],
    ...collectPatch,
    listingTaskId: taskId,
    listingJobId: job.localTaskId || job.id || "",
    updatedAt: new Date().toISOString(),
  };
}

function applyImportStatusResult(state, job, taskId, data) {
  const statusInfo = deriveImportInfoStatus(data);
  const updatedJob = upsertImportJob(state, {
    ...job,
    status: statusInfo.status,
    statusResponse: data,
    errorMessage: statusInfo.errorMessage,
    statusMessage: statusInfo.statusMessage || "",
    statusCheckError: "",
    statusCheckErrorAt: "",
    statusCheckFailures: 0,
  });
  patchCollectBoxFromImportStatus(state, updatedJob, taskId, statusInfo);
  return { statusInfo, job: updatedJob };
}

function applyImportStatusCheckFailure(state, job, error) {
  return upsertImportJob(state, {
    ...job,
    status: importStatusPollableStatuses.has(String(job.status || "").toUpperCase()) ? job.status : "RUNNING",
    statusCheckError: error?.message || "Ozon 上架状态查询失败",
    statusCheckErrorAt: new Date().toISOString(),
    statusCheckFailures: (Number(job.statusCheckFailures) || 0) + 1,
  });
}

function scheduleImportStatusPolling(delayMs = 15000) {
  if (process.env.QH_LOCAL_NO_LISTEN === "1" || importStatusPollTimer) return;
  importStatusPollTimer = setTimeout(() => {
    importStatusPollTimer = null;
    runPendingImportStatusPolls().catch((error) => {
      console.warn(`[listing-status] background poll failed: ${String(error?.message || error).slice(0, 300)}`);
      scheduleImportStatusPolling(30000);
    });
  }, delayMs);
  importStatusPollTimer.unref?.();
}

async function runPendingImportStatusPolls() {
  if (importStatusPollRunning) return;
  importStatusPollRunning = true;
  try {
    return await jsonStateTransaction.run(async () => {
      const latest = await loadState();
      const jobs = Object.values(latest.jobs || {}).filter(importJobNeedsStatusPoll).slice(0, 20);
      if (!jobs.length) return;
      let changed = false;
      for (const job of jobs) {
        const store = activeStore(latest, job.storeId, job.accountId || latest.currentAccountId);
        if (!store) continue;
        try {
          const data = await callOzonSellerApi(store, "/v1/product/import/info", {
            task_id: Number(job.ozonTaskId) || job.ozonTaskId,
          }, 60000);
          applyImportStatusResult(latest, job, job.ozonTaskId, data);
        } catch (error) {
          applyImportStatusCheckFailure(latest, job, error);
        }
        changed = true;
      }
      if (changed) await saveState(latest);
      if (Object.values(latest.jobs || {}).some(importJobNeedsStatusPoll)) scheduleImportStatusPolling(30000);
    });
  } finally {
    importStatusPollRunning = false;
  }
}

function publicImportTask(job = {}) {
  const {
    clientId,
    items,
    stocks,
    request,
    response,
    statusResponse,
    errorBody,
    ...safe
  } = job;
  return {
    ...safe,
    taskId: job.ozonTaskId || job.taskId || job.id,
    localTaskId: job.localTaskId || job.id,
  };
}

function listImportJobs(state, account) {
  const accepted = new Set(["IMPORT_BY_SKU", "PRODUCT_IMPORT", "PUBLIC_IMPORT", "FOLLOW_FROM_PUBLIC", "STOCK_IMPORT"]);
  return Object.values(state.jobs || {})
    .filter((job) =>
      (job.listing || accepted.has(job.type))
      && importJobBelongsToAccount(state, job, account)
    )
    .map(publicImportTask)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function publicImportPreviewItem(item = {}, raw = {}) {
  return {
    offer_id: item.offer_id || "",
    sku: raw.scraped_sku || raw.sku || raw.offer_id || "",
    name: item.name || "",
    price: item.price || "",
    currency_code: item.currency_code || "",
    description_category_id: item.description_category_id || "",
    type_id: item.type_id || "",
    imageCount: Array.isArray(item.images) ? item.images.length : 0,
    attributeCount: Array.isArray(item.attributes) ? item.attributes.length : 0,
    complexAttributeCount: Array.isArray(item.complex_attributes) ? item.complex_attributes.length : 0,
    attributes: Array.isArray(item.attributes) ? item.attributes : [],
    complex_attributes: Array.isArray(item.complex_attributes) ? item.complex_attributes : [],
    weight: item.weight || "",
    depth: item.depth || "",
    width: item.width || "",
    height: item.height || "",
  };
}

async function previewOzonProductImport(state, req, body) {
  const store = getRequestStore(state, req, body.storeId);
  const rawItems = withStoreContractCurrency(state, store, Array.isArray(body.items) ? body.items.filter(Boolean) : []);
  if (!rawItems.length) {
    const err = new Error("缺少可预检的 items");
    err.status = 400;
    throw err;
  }
  const normalized = await normalizeOzonImportItems(rawItems, {
    strictTypeMatch: !!body.strictTypeMatch,
    getCategoryTree: async () => (
      await ozonCategoryService.getCategoryTree({
        accountId: store.ownerAccountId,
        store,
        language: "DEFAULT",
      })
    ).items,
    getCategoryAttributes: (descriptionCategoryId, typeId) =>
      ozonCategoryService.getCategoryAttributes({
        accountId: store.ownerAccountId,
        store,
        descriptionCategoryId,
        typeId,
        language: "DEFAULT",
      }).then(({ items }) => items),
    getCategoryAttributeValues: (descriptionCategoryId, typeId, attributeId) =>
      ozonCategoryService.getCategoryAttributeValues({
        accountId: store.ownerAccountId,
        store,
        descriptionCategoryId,
        typeId,
        attributeId,
        language: "DEFAULT",
        limit: 5000,
      }).then(({ items }) => items),
  });
  if (normalized.items.length !== rawItems.length) {
    const err = new Error(normalized.warnings?.[0] || `有 ${rawItems.length - normalized.items.length} 个变体未通过上架预检`);
    err.status = 400;
    err.body = {
      ok: false,
      expectedItemCount: rawItems.length,
      normalizedItemCount: normalized.items.length,
      warnings: normalized.warnings || [],
    };
    throw err;
  }
  return {
    ok: true,
    dryRun: true,
    itemCount: normalized.items.length,
    warnings: normalized.warnings || [],
    items: normalized.items.map((item, index) => publicImportPreviewItem(item, rawItems[index] || {})),
  };
}

async function queueCollectSubmissionV3(state, req, body, collectItem, type = "COLLECT_BOX_DRAFT", dependencies = {}) {
  const account = requireAuth(req, state);
  const input = collectItem
    ? assertListingPreparationInput({
        accountId: account.id,
        collectItemId: collectItem.id,
        targetStoreId: body.targetStoreId,
        idempotencyKey: body.idempotencyKey,
      })
    : null;
  const findReplay = dependencies.findListingPreparationReplayV3 || findListingPreparationReplayV3;
  const replay = input ? await findReplay(input) : null;
  if (replay) return publicQueuedListingSubmission(replay);
  const preparation = input
    ? resolveLocalListingTarget({
        ...input,
        findStore: (storeId) => activeStore(state, storeId, account.id),
      })
    : null;
  const store = preparation?.store || getRequestStore(state, req, body.storeId);
  const targetStore = preparation?.target || null;
  const categoryService = dependencies.categoryService || ozonCategoryService;
  const createSubmission = dependencies.createSubmissionV3 || createSubmissionV3;
  const prepareListing = dependencies.prepareCollectItemForListing || prepareCollectItemForListing;
  const rawItems = withStoreContractCurrency(state, store, Array.isArray(body.items) ? body.items.filter(Boolean) : []);
  if (!rawItems.length) {
    const error = new Error("缺少可提交到 Ozon 的商品变体");
    error.status = 400;
    throw error;
  }
  const normalized = await normalizeOzonImportItems(rawItems, {
    strictTypeMatch: !!body.strictTypeMatch,
    getCategoryTree: async () => (
      await categoryService.getCategoryTree({
        accountId: store.ownerAccountId,
        store,
        language: "DEFAULT",
      })
    ).items,
    getCategoryAttributes: (descriptionCategoryId, typeId) =>
      categoryService.getCategoryAttributes({
        accountId: store.ownerAccountId,
        store,
        descriptionCategoryId,
        typeId,
        language: "DEFAULT",
      }).then(({ items }) => items),
    getCategoryAttributeValues: (descriptionCategoryId, typeId, attributeId) =>
      categoryService.getCategoryAttributeValues({
        accountId: store.ownerAccountId,
        store,
        descriptionCategoryId,
        typeId,
        attributeId,
        language: "DEFAULT",
        limit: 5000,
      }).then(({ items }) => items),
  });
  if (normalized.items.length !== rawItems.length) {
    const error = new Error(
      normalized.warnings?.[0]
        || `有 ${rawItems.length - normalized.items.length} 个变体未通过服务端最终校验，未创建上架快照`,
    );
    error.status = 400;
    error.body = {
      ok: false,
      expectedItemCount: rawItems.length,
      normalizedItemCount: normalized.items.length,
      warnings: normalized.warnings || [],
    };
    throw error;
  }
  const submissionCollectItem = collectItem || {
    id: body.collectBoxId || body.collectItemId || `adhoc_${crypto.randomUUID()}`,
    sku: body.sku || body.offerId || rawItems[0]?.sku || rawItems[0]?.scraped_sku || rawItems[0]?.offer_id || "",
    name: rawItems[0]?.name || "",
    storeId: store.id,
    source: type,
    raw: { entry: body.entry || type, items: rawItems },
    listingDraft: { variants: rawItems },
    createdAt: new Date().toISOString(),
  };
  const created = await (preparation ? prepareListing : createSubmission)({
    collectItem: submissionCollectItem,
    collectItemId: submissionCollectItem.id,
    storeId: targetStore?.id || store.id,
    targetStoreId: targetStore?.id || "",
    targetStore,
    accountId: account.id,
    idempotencyKey: preparation?.idempotencyKey || "",
    normalizedItems: normalized.items,
    stocks: Array.isArray(body.stocks) ? body.stocks : [],
    type,
    versions: {
      categoryRuleVersion: process.env.OZON_CATEGORY_RULE_VERSION || "2026-07-v1",
      dictionaryVersion: process.env.OZON_DICTIONARY_VERSION || "live-api",
      richContentRuleVersion: process.env.OZON_RICH_CONTENT_RULE_VERSION || "2026-07-v1",
    },
    retryFailed: body.retryFailed === true,
  });
  return publicQueuedListingSubmission(created, normalized.warnings);
}

function listingFirstText(...values) {
  for (const value of values) {
    const text = cleanText(value, 500);
    if (text) return text;
  }
  return "";
}

function listingNumber(value) {
  const text = String(value ?? "").replace(",", ".").trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : 0;
}

function listingImageList(...values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const rawList = Array.isArray(value) ? value : value ? [value] : [];
    for (const raw of rawList) {
      const url = cleanText(typeof raw === "object" ? raw.file_name || raw.url || raw.src || raw.image || raw.value : raw, 1000);
      if (!url) continue;
      const key = url.split("?")[0].split("#")[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
  }
  return out;
}

function listingAttributeValues(attr = {}) {
  if (Array.isArray(attr.values) && attr.values.length) return attr.values;
  if (Array.isArray(attr.collection) && attr.collection.length) {
    return attr.collection.map((value) => typeof value === "object" ? value : { value }).filter((value) => cleanText(value?.value || value?.name || value?.title));
  }
  if (attr.value != null && String(attr.value).trim()) return [{ value: attr.value }];
  return [];
}

function listingDraftAttributes(draft = {}, item = {}) {
  const source = Array.isArray(draft.categoryAttributes) && draft.categoryAttributes.length
    ? draft.categoryAttributes
    : Array.isArray(item.attributes)
      ? item.attributes
      : [];
  return source
    .map((attr) => {
      const id = Number(attr.id || attr.attribute_id || attr.attributeId || attr.key) || 0;
      const values = listingAttributeValues(attr);
      if (!id || !values.length) return null;
      return {
        id,
        name: attr.name || attr.label || "",
        values,
        is_required: !!attr.required || !!attr.is_required,
      };
    })
    .filter(Boolean);
}

function listingVariantSourceSnapshot(variant = {}, item = {}, rowSku = "", anchorSku = "") {
  const direct = [
    variant.sourceVariant,
    variant._sourceVariant,
    variant.variantData,
    variant.variant_data,
    variant.sv,
  ].find((value) => value && typeof value === "object" && !Array.isArray(value));
  if (direct) return direct;
  if (Array.isArray(variant.attributes) && variant.attributes.length) return variant;
  if (String(rowSku || "") !== String(anchorSku || "")) return {};
  return [
    item._sourceVariant,
    item.sourceVariant,
    item.variantData,
    item.variant_data,
    item.raw?.variantData,
    item.raw?.variant_data,
  ].find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
}

function listingSourceAttribute(source = {}, attributeId) {
  const key = String(attributeId);
  return (Array.isArray(source.attributes) ? source.attributes : []).find((attr) =>
    String(attr?.key ?? attr?.id ?? attr?.attribute_id ?? attr?.attributeId) === key
  );
}

function listingSourceAttributeText(source = {}, attributeId) {
  const attr = listingSourceAttribute(source, attributeId);
  if (!attr) return "";
  if (attr.value !== undefined && attr.value !== null && String(attr.value).trim()) {
    return String(attr.value).trim();
  }
  const first = Array.isArray(attr.collection)
    ? attr.collection.find((value) => cleanText(typeof value === "object" ? value?.value || value?.name || value?.title : value))
    : null;
  return cleanText(typeof first === "object" ? first?.value || first?.name || first?.title : first);
}

function listingSourceImages(source = {}) {
  const primary = listingSourceAttribute(source, 4194);
  const gallery = listingSourceAttribute(source, 4195);
  return listingImageList(
    primary?.value,
    primary?.values,
    primary?.collection,
    gallery?.value,
    gallery?.values,
    gallery?.collection,
    source.images,
    source.image,
  );
}

function listingVariantDraftAttributes(variant = {}, fallback = []) {
  if (Array.isArray(variant.categoryAttributes)) {
    return listingDraftAttributes({ categoryAttributes: variant.categoryAttributes }, {});
  }
  if (Array.isArray(variant.attributes) && variant.attributes.length) {
    return listingDraftAttributes({ categoryAttributes: variant.attributes }, {});
  }
  return fallback;
}

function listingStockRowsFromDraft(draft = {}, item = {}, listingItems = []) {
  const warehouseId = listingFirstText(
    draft.listingWarehouseId,
    draft.warehouseId,
    draft.warehouse_id,
    item.listingWarehouseId,
    item.warehouse_id,
    item.warehouseId,
  );
  if (!warehouseId) return [];
  const stockValue = Math.max(0, Math.floor(listingNumber(listingFirstText(draft.listingStock, draft.stock, item.listingStock, item.stock, "0"))));
  const numericWarehouseId = Number(warehouseId);
  const base = {
    warehouse_id: Number.isFinite(numericWarehouseId) ? numericWarehouseId : warehouseId,
    stock: stockValue,
  };
  const targets = Array.isArray(listingItems) && listingItems.length ? listingItems : [{}];
  return targets.map((listingItem) => {
    const row = { ...base };
    const offerId = listingFirstText(listingItem.offer_id, draft.offerId, item.offer_id, item.offerId);
    if (offerId) row.offer_id = offerId;
    const sku = listingFirstText(listingItem.scraped_sku, draft.sku, item.sku, item.product_id, item.id);
    if (sku) row.sku = Number(sku) || sku;
    return row;
  });
}

function buildCollectBoxListingItems(item = {}) {
  const draft = item.listingDraft && typeof item.listingDraft === "object" ? item.listingDraft : {};
  const sku = listingFirstText(draft.sku, item.sku, item.product_id, item.productId, item.id);
  const baseTitle = listingFirstText(draft.title, item.name, item.title, sku);
  const basePrice = listingNumber(listingFirstText(draft.price, item.price?.price, item.price, item.priceText));
  const currencyCode = normalizeCurrencyCode(listingFirstText(draft.currencyCode, draft.currency_code, item.currency_code, item.currencyCode)) || "CNY";
  const offerPrefix = listingFirstText(draft.offerPrefix, item.offerPrefix, "jz-") || "jz-";
  const sharedImages = listingImageList(draft.images, draft.image, item.images, item.image);
  const anchorDescriptionCategoryId = Number(listingFirstText(
    draft.descriptionCategoryId,
    draft.description_category_id,
    item.description_category_id,
    item.descriptionCategoryId,
  )) || 0;
  const anchorTypeId = Number(listingFirstText(draft.typeId, draft.type_id, item.type_id, item.typeId)) || 0;
  const anchorAttributes = listingDraftAttributes(draft, item);
  const sharedModelName = listingFirstText(draft.modelName, item.modelName, item.model_name, sku);
  const variants = Array.isArray(draft.variants) && draft.variants.length ? draft.variants : [];
  const rows = variants.length ? variants : [{
    sku,
    name: baseTitle,
    sellPrice: basePrice,
    oldPrice: item.old_price || item.oldPrice,
    offerId: listingFirstText(item.offer_id, item.offerId, `${offerPrefix}${sku}`),
    image: sharedImages[0] || "",
  }];
  const matchedAnchorIndex = rows.findIndex((variant) =>
    String(listingFirstText(variant.sku, variant.product_id)) === String(sku)
  );
  const anchorIndex = matchedAnchorIndex >= 0 ? matchedAnchorIndex : 0;

  return rows.map((variant, index) => {
    const rowSku = listingFirstText(variant.sku, variant.product_id, sku);
    const isAnchor = index === anchorIndex;
    const sourceVariant = listingVariantSourceSnapshot(variant, item, rowSku, sku);
    const offerId = listingFirstText(
      variant.offerId,
      variant.offer_id,
      rowSku ? `${offerPrefix}${rowSku}${rows.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : ""}` : "",
    );
    const price = listingNumber(listingFirstText(variant.sellPrice, variant.price, draft.price, item.price?.price, item.price));
    const oldPrice = listingNumber(listingFirstText(variant.oldPrice, variant.old_price, item.old_price, item.oldPrice));
    const ownImages = listingImageList(variant.image, variant.images, variant.picture, listingSourceImages(sourceVariant));
    const variantImages = ownImages.length ? ownImages : sharedImages;
    const variantAttributes = listingVariantDraftAttributes(variant, isAnchor ? anchorAttributes : []);
    const descriptionCategoryId = Number(listingFirstText(
      variant.descriptionCategoryId,
      variant.description_category_id,
      isAnchor ? anchorDescriptionCategoryId : "",
    )) || 0;
    const typeId = Number(listingFirstText(
      variant.typeId,
      variant.type_id,
      isAnchor ? anchorTypeId : "",
    )) || 0;
    const description = listingFirstText(
      variant.description,
      variant.scraped_description,
      isAnchor ? draft.description : "",
    );
    const richContent = listingFirstText(
      variant.richContent,
      variant.rich_content,
      isAnchor ? draft.richContent : "",
    );
    const tags = Array.isArray(variant.tags)
      ? variant.tags
      : (isAnchor && Array.isArray(draft.tags) ? draft.tags : undefined);
    const weight = Math.round(listingNumber(listingFirstText(
      variant.packageWeight,
      variant.weight,
      isAnchor ? draft.packageWeight : "",
    )));
    const depth = Math.round(listingNumber(listingFirstText(
      variant.packageLength,
      variant.depth,
      isAnchor ? draft.packageLength : "",
    )));
    const width = Math.round(listingNumber(listingFirstText(
      variant.packageWidth,
      variant.width,
      isAnchor ? draft.packageWidth : "",
    )));
    const height = Math.round(listingNumber(listingFirstText(
      variant.packageHeight,
      variant.height,
      isAnchor ? draft.packageHeight : "",
    )));
    return {
      offer_id: offerId,
      name: listingFirstText(variant.name, variant.title, baseTitle, rowSku),
      price: price > 0 ? price.toFixed(2) : "",
      old_price: oldPrice > 0 ? oldPrice.toFixed(2) : (price > 0 ? (price * 1.25).toFixed(2) : ""),
      vat: listingFirstText(variant.vat, "0"),
      currency_code: normalizeCurrencyCode(listingFirstText(variant.priceCurrency, variant.currencyCode, variant.currency_code, currencyCode)) || currencyCode,
      images: variantImages,
      scraped_description: description || undefined,
      scraped_sku: rowSku,
      // Ozon uses the shared model name to merge otherwise independent variants.
      scraped_model_name: sharedModelName,
      brand: listingFirstText(variant.brand, isAnchor ? draft.brand : ""),
      _aiHashtags: tags,
      richContent: richContent || undefined,
      videoUrl: listingFirstText(variant.video, variant.videoUrl, variant.video_url) || undefined,
      _sourceVariant: sourceVariant,
      _bundleItem: variant._bundleItem || sourceVariant._bundleItem || {},
      attributes: variantAttributes,
      complex_attributes: Array.isArray(variant.complex_attributes) ? variant.complex_attributes : [],
      bundleComplexAttrs: variant.bundleComplexAttrs || sourceVariant._bundleComplexAttrs || undefined,
      barcode: listingFirstText(variant.barcode, isAnchor ? item.barcode : "") || undefined,
      description_category_id: descriptionCategoryId || undefined,
      type_id: typeId || undefined,
      weight,
      depth,
      width,
      height,
      weight_unit: "g",
      dimension_unit: "mm",
    };
  });
}

function validateCollectBoxListingDraft(item = {}, items = [], stocks = []) {
  const errors = [];
  if (!item?.id) errors.push("采集箱条目不存在");
  if (!items.length) errors.push("缺少可上架的商品变体");
  const offerIds = new Set();
  items.forEach((row, index) => {
    const label = `第 ${index + 1} 个变体`;
    if (!listingFirstText(row.offer_id)) errors.push(`${label} 缺少 SKU 货号`);
    if (!listingFirstText(row.name)) errors.push(`${label} 缺少商品名称`);
    if (listingNumber(row.price) <= 0) errors.push(`${label} 缺少有效售价`);
    if (!listingImageList(row.images).length) errors.push(`${label} 缺少商品图片`);
    if (items.length > 1 && (!row._sourceVariant || !Object.keys(row._sourceVariant).length)) {
      errors.push(`${label} 缺少该 SKU 的完整采集源数据，请在安装新版插件后重新采集该商品`);
    }
    const offerId = listingFirstText(row.offer_id);
    if (offerId) {
      if (offerIds.has(offerId)) errors.push(`SKU 货号重复：${offerId}`);
      offerIds.add(offerId);
    }
  });
  if (!stocks.length) errors.push("缺少上架仓库和库存");
  return errors;
}

async function collectBoxListingRequest(state, req, id, body = {}, { account, dryRun = false } = {}) {
  const frozenReplay = !dryRun && listingPipelineEnabled() ? await findListingPreparationReplayV3({ accountId: account?.id, collectItemId: id, targetStoreId: body.targetStoreId, idempotencyKey: body.idempotencyKey }) : null;
  if (frozenReplay) return publicQueuedListingSubmission(frozenReplay);
  const item = cacheItemsForAccount(state, "collectBox", account)
    .find((row) => String(row.id) === String(id));
  if (!item) {
    const err = new Error("采集箱条目不存在");
    err.status = 404;
    throw err;
  }
  if (!dryRun) {
    const preparation = assertListingPreparationInput({
      accountId: account?.id,
      collectItemId: item.id,
      targetStoreId: body.targetStoreId,
      idempotencyKey: body.idempotencyKey,
    });
    if (!activeStore(state, preparation.targetStoreId, preparation.accountId)) {
      validateTargetStoreRecord({
        accountId: preparation.accountId,
        targetStoreId: preparation.targetStoreId,
        store: null,
      });
    }
  }
  const items = buildCollectBoxListingItems(item);
  const stocks = listingStockRowsFromDraft(item.listingDraft || {}, item, items);
  const errors = validateCollectBoxListingDraft(item, items, stocks);
  if (errors.length) {
    const err = new Error(errors[0]);
    err.status = 400;
    err.body = { ok: false, errors };
    throw err;
  }
  const payload = {
    ...body,
    collectBoxId: item.id,
    sku: listingFirstText(item.listingDraft?.sku, item.sku, items[0]?.scraped_sku),
    entry: body.entry || "COLLECT_BOX_DRAFT",
    items,
    stocks,
  };
  if (dryRun) return previewOzonProductImport(state, req, payload);
  if (!listingPipelineEnabled()) {
    const error = new Error("安全上架任务队列当前不可用，请恢复 PostgreSQL 与 LISTING_PIPELINE_V3 后重试");
    error.status = 503;
    error.code = "LISTING_PIPELINE_REQUIRED";
    throw error;
  }
  return queueCollectSubmissionV3(state, req, payload, item, "COLLECT_BOX_DRAFT");
}

async function mutateLatestStateWithRetry(mutator, maxAttempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const latest = await loadState();
    const result = await mutator(latest);
    if (result?.save === false) return { state: latest, result };
    try {
      await saveState(latest);
      return { state: latest, result };
    } catch (error) {
      lastError = error;
      if (error?.code !== "LOCAL_STATE_VERSION_CONFLICT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError || new Error("本地状态并发更新失败");
}

async function handleFastCollectionRoute(req, res, url) {
  if (!listingPipelineEnabled()) return false;
  const sourceCollectMatch = url.pathname.match(/^\/sources\/([^/]+)\/collect(?:\/batch)?$/);
  const collectRequestMatch = url.pathname.match(/^\/local\/collect-requests\/([^/]+)$/);
  const collectItemMatch = url.pathname.match(/^\/ozon\/collect-box\/([^/]+)$/);
  const isCollectBatchDelete = req.method === "DELETE" && url.pathname === "/ozon/collect-box/batch";
  const isVerify = req.method === "POST" && url.pathname === "/local/data-collection-stores/verify";
  const isCollectMutation = Boolean(collectItemMatch && ["PATCH", "DELETE"].includes(req.method)) || isCollectBatchDelete;
  if (!sourceCollectMatch && !collectRequestMatch && !isVerify && !isCollectMutation) return false;

  try {
    const account = sourceCollectMatch
      ? await collectorAuthRuntime.authenticateRequest(req, "collector.upload")
      : collectRequestMatch
        ? await collectorAuthRuntime.authenticateRequest(req, "collector.job.read")
        : await authenticateCollectionRequest(req);
    if (isVerify) {
      const body = await readBody(req);
      const ids = normalizeDataCollectionCompanyIds([
        body.sellerCompanyId,
        body.companyId,
        body.scCompanyId,
        ...(Array.isArray(body.sellerCompanyIds) ? body.sellerCompanyIds : []),
        ...(Array.isArray(body.companyIds) ? body.companyIds : []),
        ...(Array.isArray(body.scCompanyIds) ? body.scCompanyIds : []),
      ]);
      const verification = await verifyCollectionStoreForAccount(
        account.id,
        ids,
        body.requestId || req.headers["x-request-id"] || "",
      );
      sendJson(res, 200, {
        ok: true,
        store: verification.store,
        dataCollectionStoreId: verification.store.id,
        matchedSellerCompanyId: verification.store.sellerCompanyId,
        switchedDataCollectionStore: verification.switched,
      });
      return true;
    }

    if (collectRequestMatch && req.method === "GET") {
      const request = await getCollectRequestForAccount(account.id, decodeURIComponent(collectRequestMatch[1]));
      if (!request) sendError(res, 404, "采集请求不存在", "COLLECT_REQUEST_NOT_FOUND");
      else sendJson(res, 200, { ok: true, request });
      return true;
    }

    if (collectItemMatch && req.method === "PATCH") {
      const body = await readBody(req);
      const ifMatch = String(req.headers["if-match"] || "").replace(/[^\d]/g, "");
      const expectedVersion = body.expectedVersion ?? (ifMatch ? Number(ifMatch) : null);
      const item = await updateCollectItemDraftV4({
        collectItemId: decodeURIComponent(collectItemMatch[1]),
        accountId: account.id,
        patch: body,
        expectedVersion,
      });
      if (!item) sendError(res, 404, "采集箱条目不存在");
      else sendJson(res, 200, item);
      return true;
    }

    if ((collectItemMatch && req.method === "DELETE") || isCollectBatchDelete) {
      const body = isCollectBatchDelete ? await readBody(req) : {};
      const ids = isCollectBatchDelete
        ? (Array.isArray(body.ids) ? body.ids : [])
        : [decodeURIComponent(collectItemMatch[1])];
      const deleted = await softDeleteCollectItemsForAccountV4(account.id, ids);
      if (!deleted && !isCollectBatchDelete) sendError(res, 404, "采集箱条目不存在");
      else sendJson(res, 200, { ok: true, deleted });
      return true;
    }

    if (sourceCollectMatch && req.method === "POST") {
      const sourceId = decodeURIComponent(sourceCollectMatch[1]);
      const body = await readBody(req);
      const isBatch = url.pathname.endsWith("/batch");
      if (isBatch) assertCollectorScopeFieldsAbsentV4(body);
      const inputs = isBatch
        ? (Array.isArray(body.items) ? body.items : [])
        : [body];
      if (!inputs.length) {
        sendError(res, 422, "采集请求没有商品数据", "COLLECT_ITEMS_EMPTY");
        return true;
      }
      const imported = [];
      const results = [];
      const errors = [];
      for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs[index] && typeof inputs[index] === "object" ? inputs[index] : {};
        try {
          const result = await ingestCollectRequestV4({
            authenticatedAccount: account,
            input: { ...input, source: input.source || sourceId },
          });
          const importedItem = { ...result.item, collectRequestId: result.requestId, duplicate: result.duplicate };
          imported.push(importedItem);
          results.push({
            index,
            sku: input.sourceSku,
            action: result.action || (result.duplicate ? "updated" : "created"),
            collectItemId: result.collectItemId || result.item?.id || "",
            collectRequestId: result.requestId || "",
          });
        } catch (error) {
          if (!isBatch) throw error;
          errors.push({
            index,
            sku: String(input.sourceSku || ""),
            code: error?.code || (error?.status ? `HTTP_${error.status}` : "COLLECT_FAILED"),
            reason: error?.message || "采集失败",
          });
        }
      }
      sendJson(res, 200, isBatch
        ? { ok: errors.length === 0, imported: imported.length, data: imported, results, errors }
        : { ok: true, data: imported[0] || null, requestId: imported[0]?.collectRequestId || "" });
      return true;
    }
  } catch (error) {
    sendError(res, error?.status || 500, error?.message || "采集请求处理失败", error?.code || "COLLECT_REQUEST_FAILED");
    return true;
  }
  return false;
}

const handleCollectorHttpRoute = createCollectorHttpHandler({
  authenticate: collectorAuthRuntime.authenticateRequest,
  readJson: readBody,
  sendJson,
});

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (await collectorAuthRuntime.handleHttpRoute(req, res, url)) return;
  if (await handleCollectorArtifactRoute(req, res, url, {
    authenticate: (request) => collectorAuthRuntime.authenticateRequest(
      request,
      request.method === "GET" ? "collector.job.read" : "collector.upload",
    ),
    readBody,
    sendJson,
    sendError,
  })) return;
  if (await handleCollectorHttpRoute(req, res)) return;
  if (await handleFastCollectionRoute(req, res, url)) return;
  return jsonStateTransaction.run(async () => {
  const state = await loadState();
  if (await handleCollectorPricingRoute(req, res, url, {
    requireAuth,
    readBody,
    sendJson,
    state,
    resolveStoreId: (storeId, { account }) => storeIdForAccountRequest(state, account, storeId),
    resolveTask: (taskId, { account }) => getCollectorTaskForAccount(account.id, taskId),
  })) return;

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "qh-local-api",
      version: "0.13.46.1-local",
      persistence: persistenceMode(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/local/storage/health") {
    let persistence;
    let objectStorage;
    let listingPipeline;
    try {
      persistence = await persistenceHealth({ dataFile });
    } catch (error) {
      persistence = { ok: false, mode: persistenceMode(), message: error.message };
    }
    try {
      objectStorage = await objectStorageHealth();
    } catch (error) {
      objectStorage = { ok: false, ...objectStorageInfo(), message: error.message };
    }
    try {
      listingPipeline = await listingPipelineHealth();
    } catch (error) {
      listingPipeline = { enabled: listingPipelineEnabled(), ok: false, message: error.message };
    }
    sendJson(res, persistence.ok && objectStorage.ok ? 200 : 503, {
      ok: Boolean(persistence.ok && objectStorage.ok),
      persistence,
      objectStorage,
      listingPipeline,
      objectCleanup: {
        pending: Array.isArray(state.pendingObjectDeletions)
          ? state.pendingObjectDeletions.length
          : 0,
      },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/local/state") {
    const token = bearerToken(req);
    const account = optionalAuth(req, state);
    sendJson(res, 200, localStatePayload(state, {
      authenticated: Boolean(account),
      account,
      token,
      includeAccounts: false,
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/local/files") {
    const account = requireAuth(req, state);
    sendJson(res, 200, {
      ok: true,
      files: ensureFilesCache(state).filter((file) => canAccessLocalFile(file, account)).map(publicLocalFile),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/files") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const name = String(body.name || body.fileName || "").trim();
    const base64 = body.base64 || body.content || body.data;
    if (!name || !base64) {
      sendError(res, 400, "文件名称和 base64 内容必填");
      return;
    }
    const stored = await putObjectFromBase64({
      name,
      contentType: body.contentType || body.mimeType || "",
      base64,
    });
    const file = {
      id: `file_${crypto.randomUUID()}`,
      key: stored.key,
      name,
      contentType: stored.contentType,
      size: stored.size,
      sha256: stored.sha256,
      bucket: stored.bucket,
      storage: "minio",
      createdAt: new Date().toISOString(),
      createdBy: account.id,
    };
    ensureFilesCache(state).unshift(file);
    appendRequestAudit(state, req, account, {
      action: "FILE_CREATED",
      storeId: currentStoreIdForAccount(state, account.id),
      entityType: "file",
      entityId: file.id,
      metadata: {
        name: file.name,
        contentType: file.contentType,
        size: file.size,
        sha256: file.sha256,
      },
    });
    await saveState(state);
    sendJson(res, 200, { ok: true, file: publicLocalFile(file), state: localStatePayload(state) });
    return;
  }

  const localFileMatch = url.pathname.match(/^\/local\/files\/(.+)$/);
  if (localFileMatch && req.method === "GET") {
    const account = requireAuth(req, state);
    const key = decodeURIComponent(localFileMatch[1]);
    const file = ensureFilesCache(state).find((item) => item.key === key && canAccessLocalFile(item, account));
    if (!file) {
      sendError(res, 404, "文件不存在", "LOCAL_FILE_NOT_FOUND");
      return;
    }
    const stream = await getObjectStream(key);
    const headers = {
      "Content-Type": file.contentType || "application/octet-stream",
      "Content-Disposition": contentDispositionFileName(file.name),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ozon-store-id, x-device-fingerprint",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    };
    if (file.size) headers["Content-Length"] = String(file.size);
    res.writeHead(200, headers);
    for await (const chunk of stream) res.write(chunk);
    res.end();
    return;
  }

  if (localFileMatch && req.method === "DELETE") {
    const account = requireAuth(req, state);
    const key = decodeURIComponent(localFileMatch[1]);
    const files = ensureFilesCache(state);
    const index = files.findIndex((item) => item.key === key && canAccessLocalFile(item, account));
    if (index < 0) {
      sendError(res, 404, "文件不存在", "LOCAL_FILE_NOT_FOUND");
      return;
    }
    await removeObject(key);
    const [removed] = files.splice(index, 1);
    appendRequestAudit(state, req, account, {
      action: "FILE_DELETED",
      storeId: currentStoreIdForAccount(state, account.id),
      entityType: "file",
      entityId: removed.id,
      metadata: { name: removed.name, sha256: removed.sha256 },
    });
    await saveState(state);
    sendJson(res, 200, { ok: true, removed: publicLocalFile(removed), state: localStatePayload(state) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/accounts/login") {
    const body = await readBody(req);
    const username = String(body.username || body.phoneNumber || body.phone || "").trim();
    const password = String(body.password || "");
    const account = findAccountByUsername(state, username);
    if (!account || !verifyPassword(password, account)) {
      appendRequestAudit(state, req, null, {
        action: "ACCOUNT_LOGIN",
        status: "FAILED",
        entityType: "account_login",
        entityId: crypto.createHash("sha256").update(username.toLowerCase()).digest("hex").slice(0, 24),
        metadata: { reason: "invalid-credentials" },
      });
      await saveState(state);
      sendError(res, 401, "账号或密码错误", "LOCAL_LOGIN_FAILED");
      return;
    }
    if (account.status === "disabled") {
      sendError(res, 403, "账号已被停用，请联系管理员", "LOCAL_ACCOUNT_DISABLED");
      return;
    }
    if (isAccountExpired(account)) {
      sendError(res, 403, "账号登录期限已过期，请联系管理员", "LOCAL_ACCOUNT_EXPIRED");
      return;
    }
    const now = new Date().toISOString();
    const token = createAuthSession(state, account, req);
    account.lastLoginAt = now;
    account.updatedAt = now;
    appendRequestAudit(state, req, account, {
      action: "ACCOUNT_LOGIN",
      entityType: "account",
      entityId: account.id,
    });
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      token,
      account: publicAccount(account),
      state: localStatePayload(state, {
        authenticated: true,
        account,
        token,
        includeAccounts: false,
      }),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/accounts/logout") {
    const token = bearerToken(req);
    const session = findSession(state, token);
    const account = session ? activeAccount(state, session.accountId) : null;
    appendRequestAudit(state, req, account, {
      action: "ACCOUNT_LOGOUT",
      entityType: "account",
      entityId: account?.id || "",
    });
    removeSession(state, token);
    await saveState(state);
    await collectorAuthRuntime.revokeParentSession({
      parentSessionToken: token, accountId: session?.accountId || "", reason: "WEB_LOGOUT", state,
    });
    sendJson(res, 200, { ok: true, state: limitedLocalStatePayload(state) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/local/accounts") {
    requireAdmin(req, state);
    sendJson(res, 200, { ok: true, accounts: state.accounts.map(publicAccount) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/accounts") {
    const admin = requireAdmin(req, state);
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) {
      sendError(res, 400, "账号和初始密码必填");
      return;
    }
    if (findAccountByUsername(state, username)) {
      sendError(res, 409, "账号已存在", "LOCAL_ACCOUNT_EXISTS");
      return;
    }
    const account = createAccountRecord({
      username,
      password,
      displayName: body.displayName || username,
      role: body.role || "user",
      expiresAt: body.expiresAt || "",
      status: body.status || "active",
    });
    state.accounts.push(account);
    appendRequestAudit(state, req, admin, {
      action: "ACCOUNT_CREATED",
      entityType: "account",
      entityId: account.id,
      metadata: { role: account.role, status: account.status, expiresAt: account.expiresAt },
    });
    await saveState(state);
    sendJson(res, 200, { ok: true, account: publicAccount(account), accounts: state.accounts.map(publicAccount) });
    return;
  }

  const accountMatch = url.pathname.match(/^\/local\/accounts\/([^/]+)$/);
  if (accountMatch && req.method === "PATCH") {
    const admin = requireAdmin(req, state);
    const accountId = decodeURIComponent(accountMatch[1]);
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) {
      sendError(res, 404, "账号不存在");
      return;
    }
    const body = await readBody(req);
    if (body.displayName !== undefined) account.displayName = String(body.displayName || account.username).trim();
    if (body.role !== undefined) account.role = body.role === "admin" ? "admin" : "user";
    if (body.status !== undefined) account.status = body.status === "disabled" ? "disabled" : "active";
    if (body.expiresAt !== undefined) account.expiresAt = normalizeAccountExpiresAt(body.expiresAt);
    const passwordChanged = Boolean(body.password);
    if (passwordChanged) Object.assign(account, createPasswordHash(body.password));
    if (account.id === admin.id && account.status === "disabled") {
      sendError(res, 400, "不能停用当前登录的管理员账号");
      return;
    }
    if (account.id === admin.id && account.role !== "admin") {
      sendError(res, 400, "不能取消当前登录账号的管理员权限");
      return;
    }
    const sessionsMustBeRevoked = passwordChanged || account.status === "disabled" || isAccountExpired(account);
    const accountSessionTokens = sessionsMustBeRevoked ? collectorParentSessionTokens(state, account.id) : [];
    if (sessionsMustBeRevoked) {
      revokeAccountSessions(state, account.id);
    }
    account.updatedAt = new Date().toISOString();
    appendRequestAudit(state, req, admin, {
      action: "ACCOUNT_UPDATED",
      entityType: "account",
      entityId: account.id,
      metadata: {
        role: account.role,
        status: account.status,
        expiresAt: account.expiresAt,
        passwordChanged,
        sessionsRevoked: sessionsMustBeRevoked,
      },
    });
    await saveState(state);
    if (sessionsMustBeRevoked) {
      const collectorReason = collectorAccountChangeReason({ passwordChanged, accountExpired: isAccountExpired(account) });
      await collectorAuthRuntime.revokeAccountSessions({
        parentSessionTokens: accountSessionTokens, accountId: account.id, reason: collectorReason, state,
      });
    }
    sendJson(res, 200, { ok: true, account: publicAccount(account), accounts: state.accounts.map(publicAccount) });
    return;
  }

  if (accountMatch && req.method === "DELETE") {
    const admin = requireAdmin(req, state);
    const accountId = decodeURIComponent(accountMatch[1]);
    if (accountId === admin.id) {
      sendError(res, 400, "不能删除当前登录的管理员账号");
      return;
    }
    if (!state.accounts.some((account) => account.id === accountId)) {
      sendError(res, 404, "账号不存在");
      return;
    }
    const accountSessionTokens = collectorParentSessionTokens(state, accountId);
    const deletion = removeAccountScope(state, accountId);
    appendRequestAudit(state, req, admin, {
      action: "ACCOUNT_DELETED",
      entityType: "account",
      entityId: accountId,
      metadata: {
        deletedStoreIds: deletion.storeIds,
        deletedStoreCount: deletion.storeIds.length,
        deletedFileCount: deletion.fileObjectKeys.length,
      },
    });
    enqueueObjectDeletions(state, deletion.fileObjectKeys);
    await saveState(state);
    await collectorAuthRuntime.revokeAccountSessions({
      parentSessionTokens: accountSessionTokens, accountId, reason: "ACCOUNT_DELETED", state,
    });
    const fileCleanup = await objectCleanupWorker.drain(state);
    sendJson(res, 200, {
      ok: true,
      accounts: state.accounts.map(publicAccount),
      fileCleanup: {
        attempted: fileCleanup.attempted,
        failed: fileCleanup.failed,
        pending: fileCleanup.pending,
      },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/binding") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const requestedLabel = String(body.storeName || body.label || "").trim();
    const clientId = String(body.clientId || "").trim();
    const id = createStoreId(clientId);
    const existingAnyAccount = findStore(state, id);
    if (existingAnyAccount && String(existingAnyAccount.ownerAccountId || "") !== String(account.id)) {
      sendError(res, 409, "该 Ozon 门店已绑定到其他 sonli 账号", "STORE_ALREADY_OWNED");
      return;
    }
    const existing = activeStore(state, id, account.id);
    const apiKey = String(body.apiKey || existing?.apiKey || "").trim();
    if (!clientId || !apiKey) {
      sendError(res, 400, "Client-Id 和 Api-Key 必填");
      return;
    }
    const storeName = requestedLabel || existing?.label || "已绑定门店";
    const apiKeyCreatedAt = normalizeDateOnly(body.apiKeyCreatedAt ?? existing?.apiKeyCreatedAt) || todayDateOnly();
    const apiKeyExpiresAt = normalizeDateOnly(body.apiKeyExpiresAt ?? existing?.apiKeyExpiresAt);
    const store = {
      ...(existing || {}),
      id,
      storeId: id,
      ownerAccountId: account.id,
      label: storeName,
      companyName: storeName,
      legalName: storeName,
      clientId,
      apiKey,
      apiKeyCreatedAt,
      apiKeyExpiresAt,
      savedAt: existing?.savedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.stores = [store, ...state.stores.filter((item) => item.id !== id)];
    setCurrentStoreForAccount(state, account.id, id);
    try {
      await ozonSyncService.syncStoreProfile(state, store);
      delete store.profileSyncError;
    } catch (error) {
      store.profileSyncError = String(error?.message || error).slice(0, 240);
    }
    appendRequestAudit(state, req, account, {
      action: existing ? "STORE_BINDING_UPDATED" : "STORE_BINDING_CREATED",
      storeId: store.id,
      entityType: "store",
      entityId: store.id,
      metadata: {
        clientId: store.clientId,
        label: store.label,
        apiKeyCreatedAt: store.apiKeyCreatedAt,
        apiKeyExpiresAt: store.apiKeyExpiresAt,
        profileSyncError: store.profileSyncError || "",
      },
    });
    await saveState(state);
    sendJson(res, 200, { ok: true, token: state.token, store: publicStore(store, state), state: localStatePayload(state) });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/local/binding") {
    const account = requireAuth(req, state);
    const ownedStoreIds = new Set(storesForAccount(state, account.id).map((store) => String(store.id)));
    state.stores = state.stores.filter((store) => !ownedStoreIds.has(String(store.id)));
    setCurrentStoreForAccount(state, account.id, "");
    state.jobs = Object.fromEntries(Object.entries(state.jobs || {}).filter(([, job]) =>
      String(job?.accountId || "") !== String(account.id) && !ownedStoreIds.has(String(job?.storeId || "")),
    ));
    state.reports = (state.reports || []).filter((report) =>
      String(report?.accountId || "") !== String(account.id) && !ownedStoreIds.has(String(report?.storeId || "")),
    );
    appendRequestAudit(state, req, account, {
      action: "STORE_BINDINGS_DELETED",
      entityType: "account_store_scope",
      entityId: account.id,
      metadata: { storeIds: [...ownedStoreIds], storeCount: ownedStoreIds.size },
    });
    await saveState(state);
    await disablePersistedOperatingStores({ accountId: account.id, storeIds: [...ownedStoreIds] });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/current-store") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = String(body.storeId || body.id || "").trim();
    const store = activeStore(state, storeId, account.id);
    if (!store) {
      sendError(res, 404, "门店不存在");
      return;
    }
    setCurrentStoreForAccount(state, account.id, store.id);
    try {
      await ozonSyncService.syncStoreProfile(state, store);
      delete store.profileSyncError;
    } catch (error) {
      store.profileSyncError = String(error?.message || error).slice(0, 240);
      store.updatedAt = new Date().toISOString();
    }
    await saveState(state);
    sendJson(res, 200, { ok: true, store: publicStore(store, state), state: localStatePayload(state) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/data-collection-stores") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    if (listingPipelineEnabled()) {
      const item = await upsertCollectionStoreForAccount(account.id, body);
      await hydrateCollectionStoresIntoState(state);
      sendJson(res, 200, { ok: true, store: item, state: localStatePayload(state, { account, token: bearerToken(req) }) });
      return;
    }
    const sellerCompanyId = normalizeDataCollectionCompanyId(body.sellerCompanyId || body.companyId || body.scCompanyId);
    if (!sellerCompanyId) {
      sendError(res, 400, "Ozon 登录店铺标识必填");
      return;
    }
    const existing = dataCollectionStoresForAccount(state, account.id).find((store) =>
      normalizeDataCollectionCompanyId(store.sellerCompanyId) === sellerCompanyId
    );
    const now = new Date().toISOString();
    const item = {
      ...(existing || {}),
      id: existing?.id || `${createDataCollectionStoreId(sellerCompanyId)}_${crypto.createHash("sha256").update(account.id).digest("hex").slice(0, 6)}`,
      label: cleanText(body.label || existing?.label || `采集店铺 ${sellerCompanyId}`, 120),
      sellerCompanyId,
      ownerAccountId: account.id,
      status: body.status === "disabled" ? "disabled" : "active",
      note: cleanText(body.note || existing?.note || "", 240),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    state.dataCollectionStores = [item, ...(state.dataCollectionStores || []).filter((store) => store.id !== item.id)];
    setCurrentDataCollectionStoreForAccount(state, account.id, item.id);
    await saveState(state);
    sendJson(res, 200, { ok: true, store: publicDataCollectionStore(item, state, account.id), state: localStatePayload(state) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/current-data-collection-store") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = String(body.storeId || body.id || "").trim();
    if (listingPipelineEnabled()) {
      const store = await setCurrentCollectionStoreForAccount(account.id, storeId);
      await hydrateCollectionStoresIntoState(state);
      sendJson(res, 200, { ok: true, store, state: localStatePayload(state, { account, token: bearerToken(req) }) });
      return;
    }
    const store = dataCollectionStoresForAccount(state, account.id).find((item) => String(item.id || "") === storeId);
    if (!store) {
      sendError(res, 404, "数据采集店铺不存在");
      return;
    }
    setCurrentDataCollectionStoreForAccount(state, account.id, store.id);
    store.updatedAt = new Date().toISOString();
    await saveState(state);
    sendJson(res, 200, { ok: true, store: publicDataCollectionStore(store, state, account.id), state: localStatePayload(state) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/data-collection-stores/verify") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const current = activeDataCollectionStore(state, account.id);
    const accountStores = dataCollectionStoresForAccount(state, account.id).filter((store) => store.status !== "disabled");
    if (!current && !accountStores.length) {
      sendError(res, 400, "请先在经营店铺页面设置数据采集店铺");
      return;
    }
    const actualCompanyIds = normalizeDataCollectionCompanyIds([
      body.sellerCompanyId,
      body.companyId,
      body.scCompanyId,
      ...(Array.isArray(body.sellerCompanyIds) ? body.sellerCompanyIds : []),
      ...(Array.isArray(body.companyIds) ? body.companyIds : []),
      ...(Array.isArray(body.scCompanyIds) ? body.scCompanyIds : []),
    ]);
    if (!actualCompanyIds.length) {
      sendError(res, 400, "未检测到当前 Ozon 登录店铺，请先登录 seller.ozon.ru");
      return;
    }
    const expectedCompanyId = normalizeDataCollectionCompanyId(current?.sellerCompanyId);
    const matchedStore = accountStores.find((store) =>
      actualCompanyIds.includes(normalizeDataCollectionCompanyId(store.sellerCompanyId))
    ) || null;
    const verifiedStore = (current && actualCompanyIds.includes(expectedCompanyId)) ? current : matchedStore;
    if (!verifiedStore) {
      const expectedLabel = current?.label || current?.sellerCompanyId || accountStores[0]?.label || "数据采集店铺";
      sendError(res, 409, `当前 Ozon 登录店铺不属于当前 sonli 账号已绑定的数据采集店铺，请切换到「${expectedLabel}」或新增对应数据采集店铺后再采集`);
      return;
    }
    const switchedDataCollectionStore = current?.id && String(current.id) !== String(verifiedStore.id);
    if (switchedDataCollectionStore || !current) {
      setCurrentDataCollectionStoreForAccount(state, account.id, verifiedStore.id);
    }
    verifiedStore.lastVerifiedAt = new Date().toISOString();
    verifiedStore.updatedAt = verifiedStore.lastVerifiedAt;
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      store: publicDataCollectionStore(verifiedStore, state, account.id),
      dataCollectionStoreId: verifiedStore.id,
      matchedSellerCompanyId: normalizeDataCollectionCompanyId(verifiedStore.sellerCompanyId),
      switchedDataCollectionStore,
    });
    return;
  }

  const dataCollectionStoreMatch = url.pathname.match(/^\/local\/data-collection-stores\/([^/]+)$/);
  if (req.method === "DELETE" && dataCollectionStoreMatch) {
    const account = requireAuth(req, state);
    const storeId = decodeURIComponent(dataCollectionStoreMatch[1]);
    if (listingPipelineEnabled()) {
      const deleted = await deleteCollectionStoreForAccount(account.id, storeId);
      if (!deleted) {
        sendError(res, 404, "数据采集店铺不存在");
        return;
      }
      await hydrateCollectionStoresIntoState(state);
      sendJson(res, 200, { ok: true, state: localStatePayload(state, { account, token: bearerToken(req) }) });
      return;
    }
    const before = state.dataCollectionStores || [];
    state.dataCollectionStores = before.filter((store) =>
      String(store.id || "") !== String(storeId) || String(store.ownerAccountId || "") !== String(account.id)
    );
    if (state.dataCollectionStores.length === before.length) {
      sendError(res, 404, "数据采集店铺不存在");
      return;
    }
    if (String(currentDataCollectionStoreIdForAccount(state, account.id) || "") === String(storeId)) {
      setCurrentDataCollectionStoreForAccount(state, account.id, dataCollectionStoresForAccount(state, account.id)[0]?.id || "");
    }
    await saveState(state);
    sendJson(res, 200, { ok: true, state: localStatePayload(state) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/local/stores/refresh-profile") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = String(body.storeId || "").trim();
    const result = await ozonSyncService.refreshStoreProfiles(state, {
      accountId: account.id,
      storeId,
    });
    sendJson(res, 200, { ok: true, ...result, state: localStatePayload(await loadState(), { account, token: bearerToken(req) }) });
    return;
  }

  const localStoreMatch = url.pathname.match(/^\/local\/stores\/([^/]+)$/);
  if (req.method === "PATCH" && localStoreMatch) {
    const account = requireAuth(req, state);
    const storeId = decodeURIComponent(localStoreMatch[1]);
    const store = activeStore(state, storeId, account.id);
    if (!store) {
      sendError(res, 404, "门店不存在");
      return;
    }
    const body = await readBody(req);
    const nextLabel = cleanText(body.label ?? store.label ?? "", 120);
    if (nextLabel) store.label = nextLabel;
    if (Object.hasOwn(body, "apiKeyCreatedAt")) {
      store.apiKeyCreatedAt = normalizeDateOnly(body.apiKeyCreatedAt);
    }
    if (Object.hasOwn(body, "apiKeyExpiresAt")) {
      store.apiKeyExpiresAt = normalizeDateOnly(body.apiKeyExpiresAt);
    }
    const nextApiKey = String(body.apiKey || "").trim();
    if (nextApiKey) {
      store.apiKey = nextApiKey;
      if (!store.apiKeyCreatedAt) store.apiKeyCreatedAt = todayDateOnly();
      try {
        await ozonSyncService.syncStoreProfile(state, store);
        delete store.profileSyncError;
      } catch (error) {
        store.profileSyncError = String(error?.message || error).slice(0, 240);
      }
    }
    store.updatedAt = new Date().toISOString();
    await saveState(state);
    sendJson(res, 200, { ok: true, store: publicStore(store, state), state: localStatePayload(state) });
    return;
  }

  if (req.method === "DELETE" && localStoreMatch) {
    const account = requireAuth(req, state);
    const storeId = decodeURIComponent(localStoreMatch[1]);
    const store = activeStore(state, storeId, account.id);
    if (!store) {
      sendError(res, 404, "门店不存在");
      return;
    }
    state.stores = state.stores.filter((store) => String(store.id) !== String(storeId));
    if (String(currentStoreIdForAccount(state, account.id) || "") === String(storeId)) {
      setCurrentStoreForAccount(state, account.id, storesForAccount(state, account.id)[0]?.id || "");
    }
    appendRequestAudit(state, req, account, {
      action: "STORE_BINDING_DELETED",
      storeId,
      entityType: "store",
      entityId: storeId,
    });
    await saveState(state);
    await disablePersistedOperatingStores({ accountId: account.id, storeIds: [storeId] });
    sendJson(res, 200, { ok: true, state: localStatePayload(state) });
    return;
  }

  const localSyncMatch = url.pathname.match(/^\/local\/sync\/([^/]+)$/);
  if (req.method === "POST" && localSyncMatch) {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const report = await ozonSyncService.runLocalSync(state, {
      accountId: account.id,
      storeId: body.storeId || currentStoreIdForAccount(state, account.id),
      type: localSyncMatch[1],
      jobId: body.jobId,
      deviceId: String(req.headers["x-device-fingerprint"] || body.deviceId || "").trim(),
      source: req.headers["x-device-fingerprint"] ? "extension" : "web",
      postingsSinceDays: body.postingsSinceDays,
    });
    sendJson(res, 200, { ok: true, job: report, state: localStatePayload(await loadState(), { account, token: bearerToken(req) }) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/ozon-stores") {
    const account = requireAuth(req, state);
    sendJson(res, 200, storesForAccount(state, account.id).map((store) => publicStore(store, state)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/captcha") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="36"><rect width="96" height="36" fill="#f5f7fb"/><text x="14" y="24" fill="#1677ff" font-size="18" font-family="Arial">LOCAL</text></svg>`;
    sendJson(res, 200, {
      data: {
        captchaId: "local-captcha",
        imageBase64: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      },
    });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/auth/device/heartbeat") {
    sendJson(res, 200, { ok: true, local: true, at: new Date().toISOString() });
    return;
  }

  const storePatchMatch = url.pathname.match(/^\/auth\/ozon-stores\/([^/]+)$/);
  if (req.method === "PATCH" && storePatchMatch) {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const store = activeStore(state, decodeURIComponent(storePatchMatch[1]), account.id);
    if (!store) {
      sendError(res, 404, "门店不存在");
      return;
    }
    const cookieAuth = body.cookieAuth || {};
    store.sellerCompanyId = cookieAuth.sc_company_id || store.sellerCompanyId || "";
    store.sellerCookieCount = cookieAuth.cookies ? String(cookieAuth.cookies).split(";").filter(Boolean).length : (store.sellerCookieCount || 0);
    store.sellerCookieSyncedAt = new Date().toISOString();
    store.updatedAt = new Date().toISOString();
    await saveState(state);
    sendJson(res, 200, { ok: true, store: publicStore(store, state), sellerCompanyId: store.sellerCompanyId, sellerCookieCount: store.sellerCookieCount });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/send-code") {
    await readBody(req);
    sendError(res, 400, "本地版不支持短信登录，请使用管理员分配的账号密码登录", "LOCAL_SMS_DISABLED");
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/sms/verify") {
    await readBody(req);
    sendError(res, 400, "本地版不支持短信登录，请使用账号密码登录", "LOCAL_SMS_DISABLED");
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/login-password") {
    const body = await readBody(req);
    const username = String(body.username || body.phoneNumber || body.phone || "").trim();
    const password = String(body.password || "");
    const account = findAccountByUsername(state, username);
    if (!account || !verifyPassword(password, account)) {
      sendError(res, 401, "账号或密码错误", "LOCAL_LOGIN_FAILED");
      return;
    }
    if (account.status === "disabled") {
      sendError(res, 403, "账号已被停用，请联系管理员", "LOCAL_ACCOUNT_DISABLED");
      return;
    }
    if (isAccountExpired(account)) {
      sendError(res, 403, "账号登录期限已过期，请联系管理员", "LOCAL_ACCOUNT_EXPIRED");
      return;
    }
    const now = new Date().toISOString();
    const token = createAuthSession(state, account, req);
    account.lastLoginAt = now;
    account.updatedAt = now;
    await saveState(state);
    try {
      sendJson(res, 200, {
        ok: true,
        local: true,
        ...localAuthPayload(state, { account, token }),
        account: publicAccount(account),
      });
    } catch (error) {
      sendError(res, error.status || 400, error.message, "LOCAL_BINDING_REQUIRED");
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/feature-flags/me") {
    sendJson(res, 200, {
      ozon_fleet_serverside: false,
      ozon_public_import: false,
      localClone: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/membership/usage-summary") {
    requireAuth(req, state);
    sendJson(res, 200, {
      plan: "free",
      level: "免费会员",
      canUse: { AI_EDIT: true },
      usage: { aiEditTrialExpired: false },
      limits: {},
      local: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pricing/config/active") {
    const account = requireAuth(req, state);
    const storeId = storeIdForAccountRequest(state, account, url.searchParams.get("storeId"));
    const config = await getActivePricingConfig({ accountId: account.id, storeId });
    sendJson(res, 200, { ok: true, config, scope: { accountId: account.id, storeId } }, config.configHash ? { ETag: `"${config.configHash}"` } : {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/pricing/fx/probes/active") {
    const account = requireAuth(req, state);
    const [probes, status] = await Promise.all([
      listFxProbes({ includeDisabled: false }),
      getFxStatus(),
    ]);
    sendJson(res, 200, { ok: true, probes, rate: status.rate, intervalMinutes: status.intervalMinutes, scope: { accountId: account.id } });
    return;
  }

  if (req.method === "POST" && url.pathname === "/pricing/fx/observations") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const idempotencyKey = String(req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || "").trim();
    if (!idempotencyKey) throw Object.assign(new Error("缺少 Idempotency-Key"), { status: 422, code: "IDEMPOTENCY_KEY_REQUIRED" });
    const result = await ingestFxObservations({
      observations: body.observations || [],
      errors: body.errors || [],
      accountId: account.id,
      deviceId: body.deviceId || "",
      idempotencyKey,
      payloadHash: crypto.createHash("sha256").update(JSON.stringify({ observations: body.observations || [], errors: body.errors || [], deviceId: body.deviceId || "" })).digest("hex"),
    });
    sendJson(res, 201, { ok: true, ...result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/pricing/calculate") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(state, account, body.storeId);
    const { config, result } = await calculateWithActivePricing(body, { accountId: account.id, storeId });
    sendJson(res, 200, { ok: true, result, config: { id: config.id, versionNo: config.versionNo, configHash: config.configHash, effectiveFrom: config.effectiveFrom } });
    return;
  }

  if (req.method === "POST" && url.pathname === "/pricing/snapshots") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const idempotencyKey = String(req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || "").trim();
    if (!idempotencyKey) throw Object.assign(new Error("缺少 Idempotency-Key"), { status: 422, code: "IDEMPOTENCY_KEY_REQUIRED" });
    const storeId = storeIdForAccountRequest(state, account, body.storeId);
    const { config, result } = await calculateWithActivePricing(body.input || body, { accountId: account.id, storeId });
    const snapshot = await savePricingSnapshot({
      accountId: account.id,
      storeId: storeId || null,
      productId: body.productId || null,
      draftId: body.draftId || null,
      submissionSnapshotId: body.submissionSnapshotId || null,
      input: body.input || body,
      result,
      config,
      idempotencyKey,
      payloadHash: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    });
    sendJson(res, 201, { ok: true, snapshot });
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin/pricing/versions") {
    requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    sendJson(res, 200, { ok: true, versions: await listPricingVersions() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin/pricing/fx") {
    requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    sendJson(res, 200, { ok: true, ...(await getFxStatus()) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/pricing/fx/probes") {
    const admin = requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    const body = await readBody(req);
    const probe = await createFxProbe({ sku: body.sku, label: body.label, actorId: admin.id });
    sendJson(res, 201, { ok: true, probe });
    return;
  }

  const pricingFxProbeMatch = url.pathname.match(/^\/admin\/pricing\/fx\/probes\/([^/]+)$/);
  if (pricingFxProbeMatch && req.method === "PATCH") {
    const admin = requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    const body = await readBody(req);
    const probe = await updateFxProbe(decodeURIComponent(pricingFxProbeMatch[1]), { ...body, actorId: admin.id });
    sendJson(res, 200, { ok: true, probe });
    return;
  }
  if (pricingFxProbeMatch && req.method === "DELETE") {
    requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    await deleteFxProbe(decodeURIComponent(pricingFxProbeMatch[1]));
    sendJson(res, 200, { ok: true, deleted: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/pricing/versions") {
    const admin = requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    const body = await readBody(req);
    const config = await createPricingDraft(admin.id, body);
    sendJson(res, 201, { ok: true, config });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/pricing/official-commission/import") {
    const admin = requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    const body = await readBody(req, { maxBytes: 15 * 1024 * 1024 });
    const result = await importOfficialCommissionFiles({
      actorId: admin.id,
      files: body.files,
      cloneVersionId: body.cloneVersionId || "",
    });
    sendJson(res, 201, { ok: true, ...result });
    return;
  }

  const pricingVersionMatch = url.pathname.match(/^\/admin\/pricing\/versions\/([^/]+)$/);
  if (pricingVersionMatch && req.method === "GET") {
    requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    const config = await getPricingVersion(decodeURIComponent(pricingVersionMatch[1]));
    if (!config) {
      sendError(res, 404, "算价配置版本不存在");
      return;
    }
    sendJson(res, 200, { ok: true, config });
    return;
  }

  if (pricingVersionMatch && req.method === "PUT") {
    const admin = requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    const body = await readBody(req);
    const result = await updatePricingDraft(decodeURIComponent(pricingVersionMatch[1]), body, admin.id);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  const pricingValidateMatch = url.pathname.match(/^\/admin\/pricing\/versions\/([^/]+)\/validate$/);
  if (pricingValidateMatch && req.method === "POST") {
    const admin = requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    const validation = await validatePricingVersion(decodeURIComponent(pricingValidateMatch[1]), admin.id);
    sendJson(res, validation.valid ? 200 : 400, { ok: validation.valid, validation });
    return;
  }

  const pricingPublishMatch = url.pathname.match(/^\/admin\/pricing\/versions\/([^/]+)\/publish$/);
  if (pricingPublishMatch && req.method === "POST") {
    const admin = requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    const body = await readBody(req);
    const config = await publishPricingVersion(decodeURIComponent(pricingPublishMatch[1]), admin.id, body.effectiveFrom || new Date().toISOString());
    sendJson(res, 200, { ok: true, config });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/pricing/simulate") {
    requirePermission(req, state, PERMISSIONS.PRICING_MANAGE);
    const body = await readBody(req);
    const { config, result } = await calculateWithActivePricing(body, { accountId: body.accountId || "", storeId: body.storeId || "" });
    sendJson(res, 200, { ok: true, result, config: { id: config.id, versionNo: config.versionNo } });
    return;
  }

  if (req.method === "GET" && url.pathname === "/jidian/balance") {
    requireAuth(req, state);
    sendJson(res, 200, { balance: 0, pointLabel: "极点", local: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/jidian/pricing") {
    requireAuth(req, state);
    sendJson(res, 200, { AI_IMAGE: 50, AI_REWRITE: 20, _meta: { pointAlias: "极点", local: true } });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/watermark-settings") {
    const account = requireAuth(req, state);
    sendJson(res, 200, cacheItemsForAccount(state, "watermarkTemplates", account));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/watermark-settings") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    state.caches.watermarkTemplates = state.caches.watermarkTemplates || [];
    const accountTemplates = cacheItemsForAccount(state, "watermarkTemplates", account);
    const item = scopeCacheItemForAccount(
      normalizeWatermarkTemplate({
        ...body,
        isDefault: hasOwn(body, "isDefault") ? body.isDefault : accountTemplates.length === 0,
      }),
      account,
      store,
    );
    if (item.isDefault) {
      state.caches.watermarkTemplates = state.caches.watermarkTemplates.map((template) => (
        cacheItemBelongsToAccount(state, template, account)
          ? { ...template, isDefault: false }
          : template
      ));
      if (store) store.watermarkTemplateId = item.id;
    }
    state.caches.watermarkTemplates.unshift(item);
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      item,
      state: localStatePayload(state, { account, token: bearerToken(req) }),
      local: true,
    });
    return;
  }

  const watermarkTemplateMatch = url.pathname.match(/^\/ozon\/watermark-settings\/([^/]+)$/);
  if (watermarkTemplateMatch && (req.method === "PUT" || req.method === "DELETE")) {
    const account = requireAuth(req, state);
    const id = decodeURIComponent(watermarkTemplateMatch[1]);
    state.caches.watermarkTemplates = state.caches.watermarkTemplates || [];
    const index = state.caches.watermarkTemplates.findIndex((item) =>
      String(item.id) === String(id) && cacheItemBelongsToAccount(state, item, account),
    );
    if (index < 0) {
      sendError(res, 404, "水印模板不存在");
      return;
    }
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || state.caches.watermarkTemplates[index].storeId || "",
    );
    const store = activeStore(state, storeId, account.id);
    if (req.method === "DELETE") {
      const [removed] = state.caches.watermarkTemplates.splice(index, 1);
      if (store?.watermarkTemplateId === removed.id) {
        const nextTemplate = cacheItemsForAccount(state, "watermarkTemplates", account)[0] || null;
        store.watermarkTemplateId = nextTemplate?.id || "";
        state.caches.watermarkTemplates = state.caches.watermarkTemplates.map((template, templateIndex) => ({
          ...template,
          isDefault: cacheItemBelongsToAccount(state, template, account)
            ? String(template.id) === String(store.watermarkTemplateId)
            : template.isDefault,
        }));
      }
      await saveState(state);
      sendJson(res, 200, {
        ok: true,
        removedId: removed.id,
        state: localStatePayload(state, { account, token: bearerToken(req) }),
        local: true,
      });
      return;
    }
    const body = await readBody(req);
    const item = scopeCacheItemForAccount(
      normalizeWatermarkTemplate(body, state.caches.watermarkTemplates[index]),
      account,
      store,
    );
    if (item.isDefault) {
      state.caches.watermarkTemplates = state.caches.watermarkTemplates.map((template) => (
        !cacheItemBelongsToAccount(state, template, account) || String(template.id) === String(item.id)
          ? template
          : { ...template, isDefault: false }
      ));
      if (store) store.watermarkTemplateId = item.id;
    }
    state.caches.watermarkTemplates[index] = item;
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      item,
      state: localStatePayload(state, { account, token: bearerToken(req) }),
      local: true,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/usage/track") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    state.reports.unshift({
      id: crypto.randomUUID(),
      type: "USAGE_TRACK",
      status: "SUCCESS",
      featureKey: body.featureKey || "",
      client: body.client || "",
      version: body.version || "",
      createdAt: new Date().toISOString(),
    });
    state.reports = state.reports.slice(0, 200);
    appendRequestAudit(state, req, account, {
      action: "USAGE_TRACK",
      storeId: currentStoreIdForAccount(state, account.id),
      entityType: "feature",
      entityId: body.featureKey || "",
      metadata: {
        featureKey: body.featureKey || "",
        client: body.client || "",
        version: body.version || "",
      },
    });
    await saveState(state);
    sendJson(res, 200, { ok: true, local: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/sync/client-intervals") {
    requireAuth(req, state);
    sendJson(res, 200, { postingsMin: 5, productsMin: 30, warehousesMin: 360 });
    return;
  }

  const credMatch = url.pathname.match(/^\/ozon\/stores\/([^/]+)\/sync-credentials$/);
  if (req.method === "GET" && credMatch) {
    const account = requireAuth(req, state);
    const store = activeStore(state, decodeURIComponent(credMatch[1]), account.id);
    if (!store) {
      sendError(res, 404, "门店不存在");
      return;
    }
    appendRequestAudit(state, req, account, {
      action: "SYNC_CREDENTIALS_READ",
      storeId: store.id,
      entityType: "store",
      entityId: store.id,
      metadata: { credentialType: "ozon-api" },
    });
    await saveState(state);
    sendJson(res, 200, { clientId: store.clientId, apiKey: store.apiKey });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/sync/lease/acquire") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(state, account, body.storeId);
    const result = acquireSyncLease(state, {
      accountId: account.id,
      storeId,
      type: body.type,
      deviceId: body.deviceId,
      ttlSeconds: body.ttlSeconds,
    });
    appendRequestAudit(state, req, account, {
      eventId: `audit_lease_${result.leaseId}_acquired`,
      action: "SYNC_LEASE_ACQUIRE",
      status: result.acquired ? "SUCCESS" : "CONFLICT",
      storeId,
      deviceId: body.deviceId,
      source: "extension",
      entityType: "sync_lease",
      entityId: result.leaseId,
      metadata: { type: body.type, idempotent: result.idempotent },
    });
    await saveState(state);
    sendJson(res, 200, {
      acquired: result.acquired,
      leaseId: result.leaseId,
      expiresAt: result.expiresAt,
      idempotent: result.idempotent,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/sync/lease/heartbeat") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const result = heartbeatSyncLease(state, {
      accountId: account.id,
      leaseId: body.leaseId,
      deviceId: body.deviceId,
      ttlSeconds: body.ttlSeconds,
    });
    await saveState(state);
    sendJson(res, 200, { refreshed: result.refreshed, expiresAt: result.expiresAt });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/sync/lease/release") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const result = releaseSyncLease(state, {
      accountId: account.id,
      leaseId: body.leaseId,
      deviceId: body.deviceId,
    });
    appendRequestAudit(state, req, account, {
      eventId: `audit_lease_${body.leaseId}_released`,
      action: "SYNC_LEASE_RELEASE",
      status: result.released ? "SUCCESS" : "NOOP",
      storeId: result.lease?.storeId || "",
      deviceId: body.deviceId,
      source: "extension",
      entityType: "sync_lease",
      entityId: body.leaseId,
    });
    await saveState(state);
    sendJson(res, 200, { released: result.released });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/sync/client-report") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      body.storeId || req.headers["x-ozon-store-id"] || "",
    );
    const jobId = body.clientJobId || body.id || crypto.randomUUID();
    const previous = state.jobs[jobId] || {};
    const report = {
      ...previous,
      ...body,
      id: jobId,
      clientJobId: jobId,
      accountId: account.id,
      storeId,
      updatedAt: new Date().toISOString(),
      createdAt: previous.createdAt || new Date().toISOString(),
    };
    state.jobs[jobId] = report;
    state.reports.unshift(report);
    state.reports = state.reports.slice(0, 200);
    appendRequestAudit(state, req, account, {
      eventId: `audit_client_report_${jobId}_${String(report.status || "UNKNOWN").toLowerCase()}`,
      correlationId: jobId,
      action: "SYNC_CLIENT_REPORT",
      status: report.status || "UNKNOWN",
      storeId,
      deviceId: body.deviceId,
      source: "extension",
      entityType: "sync_job",
      entityId: jobId,
      metadata: {
        type: report.type,
        fetchedCount: report.fetchedCount,
        error: report.error || report.errorMessage || "",
        client: body.client || "",
        version: body.version || "",
      },
    });
    await saveState(state);
    sendJson(res, 200, { ok: true, job: report });
    return;
  }

  if (url.pathname === "/browser-agents/register" && req.method === "POST") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const deviceKey = String(body.deviceKey || body.extensionId || "local-browser-agent");
    const agentId = `local_agent_${crypto.createHash("sha256").update(deviceKey).digest("hex").slice(0, 12)}`;
    const previous = state.browserAgents?.[agentId] || null;
    if (previous && String(previous.accountId || "") !== String(account.id)) {
      sendError(res, 404, "浏览器执行设备不存在", "BROWSER_AGENT_NOT_FOUND");
      return;
    }
    const agent = {
      id: agentId,
      accountId: account.id,
      deviceKey,
      deviceName: body.deviceName || "Chrome Browser Agent",
      extensionId: body.extensionId || "",
      extensionVersion: body.extensionVersion || "",
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
      status: "online",
      local: true,
      registeredAt: previous?.registeredAt || new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };
    state.browserAgents = { ...(state.browserAgents || {}), [agentId]: agent };
    appendRequestAudit(state, req, account, {
      eventId: `audit_browser_agent_${agentId}_registered`,
      action: "BROWSER_AGENT_REGISTER",
      deviceId: agentId,
      source: "extension",
      entityType: "browser_agent",
      entityId: agentId,
      metadata: {
        deviceName: agent.deviceName,
        extensionVersion: agent.extensionVersion,
        capabilities: agent.capabilities,
      },
    });
    await saveState(state);
    sendJson(res, 200, agent);
    return;
  }

  if (url.pathname === "/browser-agents/heartbeat" && req.method === "POST") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const agentId = String(body.deviceId || body.id || "").trim();
    const previous = state.browserAgents?.[agentId] || null;
    if (!agentId || !previous || String(previous.accountId || "") !== String(account.id)) {
      sendError(res, 404, "浏览器执行设备不存在", "BROWSER_AGENT_NOT_FOUND");
      return;
    }
    const agent = {
      ...previous,
      id: agentId,
      accountId: account.id,
      extensionVersion: body.extensionVersion || previous.extensionVersion || "",
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : (previous.capabilities || []),
      status: "online",
      local: true,
      registeredAt: previous.registeredAt || new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };
    state.browserAgents = { ...(state.browserAgents || {}), [agentId]: agent };
    await saveState(state);
    sendJson(res, 200, agent);
    return;
  }

  if (url.pathname === "/browser-agents/jobs/next" && req.method === "GET") {
    const account = requireAuth(req, state);
    const deviceId = url.searchParams.get("deviceId") || "";
    const pending = claimNextBrowserAgentJob(state, {
      accountId: account.id,
      deviceId,
    });
    const agent = state.browserAgents[deviceId];
    state.browserAgents[deviceId] = {
      ...agent,
      deviceId,
      lastHeartbeatAt: new Date().toISOString(),
      registeredAt: agent.registeredAt || new Date().toISOString(),
    };
    await saveState(state);
    if (pending) {
      sendJson(res, 200, { job: pending, idle: false });
    } else {
      sendJson(res, 200, { job: null, idle: true });
    }
    return;
  }

  const browserAgentJobMatch = url.pathname.match(/^\/browser-agents\/jobs\/([^/]+)\/(progress|result|fail)$/);
  if (browserAgentJobMatch && req.method === "POST") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const jobId = decodeURIComponent(browserAgentJobMatch[1]);
    const action = browserAgentJobMatch[2];
    const transition = transitionBrowserAgentJob(state, {
      accountId: account.id,
      deviceId: String(body.deviceId || "").trim(),
      jobId,
      action,
      patch: body,
    });
    const job = transition.job;
    state.reports = Array.isArray(state.reports) ? state.reports : [];
    state.reports.unshift({
      id: crypto.randomUUID(),
      type: `BROWSER_AGENT_${action.toUpperCase()}`,
      status: job.status,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      accountId: job.accountId,
      storeId: job.storeId,
      jobId,
      deviceId: body.deviceId || "",
      createdAt: new Date().toISOString(),
    });
    state.reports = state.reports.slice(0, 200);
    appendRequestAudit(state, req, account, {
      eventId: `audit_browser_job_${jobId}_${transition.toStatus.toLowerCase()}`,
      correlationId: jobId,
      action: `BROWSER_AGENT_${action.toUpperCase()}`,
      status: job.status,
      storeId: job.storeId,
      deviceId: body.deviceId,
      source: "extension",
      entityType: "browser_agent_job",
      entityId: jobId,
      metadata: {
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
      },
    });
    await saveState(state);
    sendJson(res, 200, { ok: true, job, local: true });
    return;
  }

  const jobMatch = url.pathname.match(/^\/ozon\/sync\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    const account = requireAuth(req, state);
    const job = state.jobs[decodeURIComponent(jobMatch[1])] || null;
    if (!job || String(job.accountId || "") !== String(account.id)) {
      sendError(res, 404, "同步任务不存在");
      return;
    }
    sendJson(res, 200, job);
    return;
  }

  const agentJobMatch = url.pathname.match(/^\/browser-agents\/(collection-jobs|market-data-jobs)(?:\/([^/]+))?$/);
  if (agentJobMatch) {
    const account = requireAuth(req, state);
    const kind = agentJobMatch[1];
    const jobId = agentJobMatch[2] ? decodeURIComponent(agentJobMatch[2]) : crypto.randomUUID();
    if (req.method === "POST" && !agentJobMatch[2]) {
      const body = await readBody(req);
      const sku = String(body.sku || "").trim();
      const type = kind === "market-data-jobs" ? "ozon.market_data" : "ozon.collect_variant";
      const storeId = storeIdForAccountRequest(
        state,
        account,
        body.storeId || req.headers["x-ozon-store-id"] || "",
      );
      const job = {
        id: jobId,
        type,
        kind,
        params: { ...sanitizeBrowserAgentJobPayload(body), sku },
        sku,
        accountId: account.id,
        createdBy: account.id,
        storeId,
        status: "PENDING",
        claimedByDeviceId: "",
        claimExpiresAt: "",
        claimAttempt: 0,
        result: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        local: true,
      };
      state.jobs[jobId] = job;
      await saveState(state);
      sendJson(res, 200, job);
      return;
    }
    if (req.method === "GET" && agentJobMatch[2]) {
      const job = state.jobs[jobId] || null;
      if (!job || String(job.accountId || "") !== String(account.id)) {
        sendError(res, 404, "浏览器任务不存在", "BROWSER_AGENT_JOB_NOT_FOUND");
        return;
      }
      if (!activeStore(state, job.storeId, account.id)) {
        sendError(res, 404, "浏览器任务不存在", "BROWSER_AGENT_JOB_NOT_FOUND");
        return;
      }
      sendJson(res, 200, job);
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/ozon/cache/import-with-hash") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      body.storeId || req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    if (!store) {
      sendError(res, 400, "请先选择经营店铺");
      return;
    }
    requireActiveSyncLease(state, {
      accountId: account.id,
      storeId,
      type: "PRODUCTS",
      leaseId: body.leaseId,
      deviceId: body.deviceId,
    });
    const items = Array.isArray(body.items) ? body.items : [];
    const { result } = await mutateLatestStateWithRetry(async (latest) => {
      requireActiveSyncLease(latest, {
        accountId: account.id,
        storeId,
        type: "PRODUCTS",
        leaseId: body.leaseId,
        deviceId: body.deviceId,
      });
      const latestStore = activeStore(latest, storeId, account.id);
      if (!latestStore) {
        const error = new Error("经营店铺已被删除或转移");
        error.status = 409;
        throw error;
      }
      let imported = 0;
      const needRaw = [];
      for (const item of items) {
        const id = String(item.id || item.productId || "");
        if (!id) continue;
        const existing = latest.caches.products.find((row) =>
          String(row.id || row.product_id || row.offer_id || "") === id &&
          cacheItemMatchesStore(row, latestStore),
        ) || null;
        if (!item.raw && !existing) {
          needRaw.push(id);
          continue;
        }
        upsertProductByStore(latest.caches.products, latestStore, id, {
          ...(existing || {}),
          ...(item.raw || {}),
          id,
          ...cacheItemScope(latestStore, account.id),
          contentHash: item.contentHash || existing?.contentHash || "",
          syncedAt: new Date().toISOString(),
        });
        latest.hashes[`PRODUCTS:${latestStore.id}:${id}`] = item.contentHash || "";
        imported += 1;
      }
      return { imported, needRaw, storeId: latestStore.id, save: imported > 0 };
    });
    sendJson(res, 200, { imported: result.imported, needRaw: result.needRaw, storeId: result.storeId });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/postings/cache/import") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      body.storeId || req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    if (!store) {
      sendError(res, 400, "请先选择经营店铺");
      return;
    }
    requireActiveSyncLease(state, {
      accountId: account.id,
      storeId,
      type: "POSTINGS",
      leaseId: body.leaseId,
      deviceId: body.deviceId,
    });
    const items = Array.isArray(body.items) ? body.items : [];
    const { result } = await mutateLatestStateWithRetry(async (latest) => {
      requireActiveSyncLease(latest, {
        accountId: account.id,
        storeId,
        type: "POSTINGS",
        leaseId: body.leaseId,
        deviceId: body.deviceId,
      });
      const latestStore = activeStore(latest, storeId, account.id);
      if (!latestStore) {
        const error = new Error("经营店铺已被删除或转移");
        error.status = 409;
        throw error;
      }
      for (const item of items) {
        const id = String(item.posting_number || item.order_id || item.id || crypto.randomUUID());
        const existing = latest.caches.postings.find((row) =>
          String(row.id || row.posting_number || row.order_id || "") === id &&
          cacheItemMatchesStore(row, latestStore),
        ) || {};
        upsertCacheItemByStore(
          latest.caches.postings,
          latestStore,
          id,
          {
            ...existing,
            ...item,
            id,
            ...cacheItemScope(latestStore, account.id),
            syncedAt: new Date().toISOString(),
          },
          ["id", "posting_number", "order_id"],
        );
      }
      return { imported: items.length, storeId: latestStore.id, save: items.length > 0 };
    });
    sendJson(res, 200, { imported: result.imported, storeId: result.storeId });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/warehouses/cache/import") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    const storeId = storeIdForAccountRequest(
      state,
      account,
      body.storeId || req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    if (!store) {
      sendError(res, 400, "请先选择经营店铺");
      return;
    }
    requireActiveSyncLease(state, {
      accountId: account.id,
      storeId,
      type: "WAREHOUSES",
      leaseId: body.leaseId,
      deviceId: body.deviceId,
    });
    const { result } = await mutateLatestStateWithRetry(async (latest) => {
      requireActiveSyncLease(latest, {
        accountId: account.id,
        storeId,
        type: "WAREHOUSES",
        leaseId: body.leaseId,
        deviceId: body.deviceId,
      });
      const latestStore = activeStore(latest, storeId, account.id);
      if (!latestStore) {
        const error = new Error("经营店铺已被删除或转移");
        error.status = 409;
        throw error;
      }
      const syncedAt = new Date().toISOString();
      const imported = items.map((item) => ({
        ...item,
        id: String(item.warehouse_id || item.id || item.name || crypto.randomUUID()),
        ...cacheItemScope(latestStore, account.id),
        syncedAt,
      }));
      latest.caches.warehouses = [
        ...(latest.caches.warehouses || []).filter((item) => !cacheItemMatchesStore(item, latestStore)),
        ...imported,
      ];
      return { imported: imported.length, storeId: latestStore.id };
    });
    sendJson(res, 200, { imported: result.imported, storeId: result.storeId });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/products/cache/status-counts") {
    const account = requireAuth(req, state);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      url.searchParams.get("storeId") || req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const products = store ? cacheItemsForStore(state.caches.products, store) : [];
    sendJson(res, 200, { ALL: products.length, total: products.length, storeId });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/products/cache") {
    const account = requireAuth(req, state);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      url.searchParams.get("storeId") || req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const products = store ? cacheItemsForStore(state.caches.products, store) : [];
    sendJson(res, 200, { data: products, total: products.length, storeId });
    return;
  }

  const productDataMatch = url.pathname.match(/^\/ozon\/product-data\/([^/]+)$/);
  if (req.method === "GET" && productDataMatch) {
    const account = requireAuth(req, state);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      url.searchParams.get("storeId") || req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const sku = decodeURIComponent(productDataMatch[1]);
    const product = cacheItemsForStore(state.caches.products, store).find((item) =>
      [item.id, item.product_id, item.offer_id, item.sku].some((value) => String(value || "") === String(sku)),
    ) || null;
    sendJson(res, 200, { ok: true, data: product, sku, storeId, local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/product-data/batch") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      body.storeId || req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const skus = Array.isArray(body.skus) ? body.skus : Array.isArray(body.items) ? body.items : [];
    const products = cacheItemsForStore(state.caches.products, store).filter((item) =>
      skus.some((sku) => [item.id, item.product_id, item.offer_id, item.sku].some((value) => String(value || "") === String(sku))),
    );
    sendJson(res, 200, { ok: true, data: products, items: products, total: products.length, storeId, local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/product-data/dims") {
    requireAuth(req, state);
    sendJson(res, 200, { ok: true, imported: 0, local: true });
    return;
  }

  // === 采集箱 SKU 抓取端点 ===
  if (req.method === "POST" && url.pathname === "/ozon/collect-box/scrape") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const dataCollectionStoreId = currentDataCollectionStoreIdForAccount(state, account.id);
    const sku = String(body.sku || body.skuId || "").trim();
    if (!sku) {
      sendError(res, 400, "SKU 不能为空");
      return;
    }
    try {
      const detail = await scrapeOzonProductDetail(sku);
      if (detail && detail.title) {
        const item = normalizeCollectItem({
          sku,
          productUrl: detail.url || `https://www.ozon.ru/product/test-${sku}/`,
          name: detail.title,
          price: detail.price || detail.priceText || "",
          priceText: detail.priceText || "",
          image: detail.primaryImage || (detail.images || [])[0] || "",
          images: detail.images || [],
          variants: Array.isArray(detail.variants) ? detail.variants : [],
          variantData: Array.isArray(detail.variants) && detail.variants.length ? { variants: detail.variants } : undefined,
          seller: detail.sellerName || "",
          sellerLink: detail.sellerLink || "",
          brand: detail.brand || "",
          category: (detail.categories || []).join(" / "),
          rating: detail.rating || null,
          reviewCount: detail.reviewCount || null,
          source: "SKU 抓取",
          status: "已采集",
          raw: { sku, scrapedAt: new Date().toISOString() },
        });
        const saved = await saveCollectBoxItemAtomic(item, { account, store, dataCollectionStoreId });
        sendJson(res, 200, { ok: true, data: publicPersistedCollectionItem(saved.item), scraped: true });
      } else {
        // 抓取失败，仍然创建条目但标记为待处理
        const item = normalizeCollectItem({
          sku,
          name: `SKU ${sku}`,
          source: "SKU 添加（抓取失败）",
          status: "待处理",
          raw: { sku, error: "scrape_failed" },
        });
        const saved = await saveCollectBoxItemAtomic(item, { account, store, dataCollectionStoreId });
        sendJson(res, 200, {
          ok: true,
          data: publicPersistedCollectionItem(saved.item),
          scraped: false,
          error: "未能从 ozon.ru 抓取到商品数据",
        });
      }
    } catch (error) {
      sendError(res, 500, `抓取失败: ${error.message}`);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/collect-box/scrape-search") {
    requireAuth(req, state);
    const body = await readBody(req);
    const sku = String(body.sku || body.query || "").trim();
    if (!sku) {
      sendError(res, 400, "SKU / 搜索词不能为空");
      return;
    }
    try {
      const results = await scrapeOzonProductBySku(sku);
      sendJson(res, 200, { ok: true, data: results, total: results.length });
    } catch (error) {
      sendError(res, 500, `搜索失败: ${error.message}`);
    }
    return;
  }

  if (await handleOzonCategoryRoute({ req, res, url, state })) return;

  if (req.method === "GET" && url.pathname === "/ozon/collect-box") {
    const account = requireAuth(req, state);
    sendJson(
      res,
      200,
      emptyPage(url, cacheItemsForAccount(state, "collectBox", account).map(publicPersistedCollectionItem)),
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/collect-box") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const dataCollectionStoreId = currentDataCollectionStoreIdForAccount(state, account.id);
    const sku = String(body.sku || "").trim();
    const isUrl = /^https?:\/\//i.test(String(body.productUrl || body.url || body.name || ""));
    // 如果有 SKU 且不是 URL，尝试抓取 ozon.ru 数据
    if (sku && !isUrl) {
      try {
        const detail = await scrapeOzonProductDetail(sku);
        if (detail && detail.title) {
          const item = normalizeCollectItem({
            ...body,
            sku,
            productUrl: detail.url || `https://www.ozon.ru/product/test-${sku}/`,
            name: detail.title,
            price: detail.price || detail.priceText || "",
            priceText: detail.priceText || "",
            image: detail.primaryImage || (detail.images || [])[0] || "",
            images: detail.images || [],
            variants: Array.isArray(detail.variants) ? detail.variants : [],
            variantData: Array.isArray(detail.variants) && detail.variants.length ? { variants: detail.variants } : undefined,
            seller: detail.sellerName || "",
            sellerLink: detail.sellerLink || "",
            brand: detail.brand || "",
            category: (detail.categories || []).join(" / "),
            rating: detail.rating || null,
            reviewCount: detail.reviewCount || null,
            source: body.source || "SKU 抓取",
            status: "已采集",
            raw: { sku, scrapedAt: new Date().toISOString() },
          });
          const saved = await saveCollectBoxItemAtomic(item, { account, store, dataCollectionStoreId });
          sendJson(res, 200, publicPersistedCollectionItem(saved.item));
          return;
        }
      } catch (e) {
        // 抓取失败，继续创建普通条目
      }
    }
    const item = normalizeCollectItem(body);
    const saved = await saveCollectBoxItemAtomic(item, { account, store, dataCollectionStoreId });
    sendJson(res, 200, publicPersistedCollectionItem(saved.item));
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/ozon/collect-box/batch") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const result = await deleteCollectBoxItemsAtomic(state, ids, { account });
    sendJson(res, 200, {
      ok: true,
      deleted: result.deleted,
      total: result.total,
    });
    return;
  }

  const collectListingMatch = url.pathname.match(/^\/ozon\/collect-box\/([^/]+)\/listing\/(preview|submit)$/);
  if (req.method === "POST" && collectListingMatch) {
    const account = requireAuth(req, state);
    const id = decodeURIComponent(collectListingMatch[1]);
    const action = collectListingMatch[2];
    const body = await readBody(req);
    try {
      const result = await collectBoxListingRequest(state, req, id, body, {
        account,
        dryRun: action === "preview",
      });
      if (action === "submit" && result?.ok) {
        await updateCollectBoxItemAtomic(id, {
          status: "上架中",
          listingTaskId: result.task_id || result.result?.task_id || "",
          listingJobId: result.job?.localTaskId || result.job?.id || "",
          listingSubmittedAt: new Date().toISOString(),
          listingLastError: "",
        }, { account }).catch(() => null);
      }
      sendJson(res, 200, result);
    } catch (error) {
      const failurePatch = {
        listingLastError: error?.message || (action === "preview" ? "采集箱草稿预检失败" : "采集箱草稿上架失败"),
        listingLastErrorAt: new Date().toISOString(),
      };
      if (action === "submit") {
        failurePatch.status = "失败";
        failurePatch.listingTaskId = "";
        failurePatch.listingJobId = "";
      }
      await updateCollectBoxItemAtomic(id, failurePatch, { account }).catch(() => null);
      sendJson(res, error?.status || 502, {
        ok: false,
        code: error?.code || error?.body?.code || "COLLECT_LISTING_FAILED",
        message: error?.message || (action === "preview" ? "采集箱草稿预检失败" : "采集箱草稿上架失败"),
        ...(error?.body || {}),
      });
    }
    return;
  }

  const collectItemMatch = url.pathname.match(/^\/ozon\/collect-box\/([^/]+)$/);
  if (req.method === "PATCH" && collectItemMatch) {
    const account = requireAuth(req, state);
    const id = decodeURIComponent(collectItemMatch[1]);
    const body = await readBody(req);
    const item = await updateCollectBoxItemAtomic(id, body, { account });
    if (!item) {
      sendError(res, 404, "采集箱条目不存在");
      return;
    }
    sendJson(res, 200, publicPersistedCollectionItem(item));
    return;
  }

  if (req.method === "DELETE" && collectItemMatch) {
    const account = requireAuth(req, state);
    const id = decodeURIComponent(collectItemMatch[1]);
    const result = await deleteCollectBoxItemsAtomic(state, [id], { account });
    if (!result.deleted) {
      sendError(res, 404, "采集箱条目不存在");
      return;
    }
    sendJson(res, 200, {
      ok: true,
      deleted: result.deleted,
      total: result.total,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/collect-box/batch") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const dataCollectionStoreId = currentDataCollectionStoreIdForAccount(state, account.id);
    const imported = items.map((raw) => normalizeCollectItem(raw));
    const saved = await saveCollectBoxBatchAtomic(imported, { account, store, dataCollectionStoreId });
    sendJson(res, 200, {
      ok: true,
      imported: saved.items.length,
      data: saved.items.map(publicPersistedCollectionItem),
      total: cacheItemsForAccount(saved.state, "collectBox", account).length,
    });
    return;
  }

  if (await handleJsonAccountScopedCollectionRoute(req, res, url, state)) return;

  if (req.method === "GET" && url.pathname === "/ozon/favorites") {
    const account = requireAuth(req, state);
    sendJson(res, 200, emptyPage(url, cacheItemsForAccount(state, "favorites", account)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/favorites") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const item = scopeCacheItemForAccount(normalizeCollectItem(body, "favorite"), account, store);
    upsertCacheItemByStore(state.caches.favorites, store, item.id, item);
    await saveState(state);
    sendJson(res, 200, item);
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/warehouses") {
    const account = requireAuth(req, state);
    sendJson(res, 200, cacheItemsForAccount(state, "warehouses", account));
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/returns") {
    const account = requireAuth(req, state);
    const query = cleanText(url.searchParams.get("q") || url.searchParams.get("query") || "", 120).toLowerCase();
    const type = cleanText(url.searchParams.get("type") || "", 32).toLowerCase();
    const status = cleanText(url.searchParams.get("status") || "", 60).toLowerCase();
    const source = [
      ...cacheItemsForAccount(state, "returns", account),
      ...cacheItemsForAccount(state, "refunds", account),
    ];
    const items = source.filter((item) => {
      if (type && !String(item.type || item.kind || "").toLowerCase().includes(type)) return false;
      if (status && !String(item.status || "").toLowerCase().includes(status)) return false;
      if (query) {
        const text = [
          item.id,
          item.postingNumber,
          item.posting_number,
          item.sku,
          item.offer_id,
          item.productName,
          item.product_name,
          item.status,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!text.includes(query)) return false;
      }
      return true;
    });
    sendJson(res, 200, emptyPage(url, items));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/returns/batch") {
    const account = requireAuth(req, state);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const body = await readBody(req);
    const kind = cleanText(body.kind || body.type || "return", 32);
    const target = kind.toLowerCase().includes("refund") ? state.caches.refunds : state.caches.returns;
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200).map((item) =>
      scopeCacheItemForAccount(normalizeReturnItem(item, kind, store), account, store)
    );
    for (const item of items) upsertCacheItemByStore(target, store, item.id, item);
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      created: items.length,
      items,
      state: localStatePayload(state, { account, token: bearerToken(req) }),
      local: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/products/import-by-sku/tasks") {
    const account = requireAuth(req, state);
    const tasks = listImportJobs(state, account);
    sendJson(res, 200, emptyPage(url, tasks));
    return;
  }

  if (req.method === "POST" && url.pathname === "/extension/l1-samples") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    state.reports.unshift({
      id: crypto.randomUUID(),
      type: "L1_SAMPLES",
      status: "SUCCESS",
      sampleCount: Array.isArray(body.samples) ? body.samples.length : 0,
      createdAt: new Date().toISOString(),
    });
    state.reports = state.reports.slice(0, 200);
    appendRequestAudit(state, req, account, {
      action: "EXTENSION_L1_SAMPLES",
      storeId: currentStoreIdForAccount(state, account.id),
      source: "extension",
      entityType: "sample_batch",
      metadata: { sampleCount: Array.isArray(body.samples) ? body.samples.length : 0 },
    });
    await saveState(state);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/selection/bestsellers/snapshot") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    state.reports.unshift({
      id: crypto.randomUUID(),
      type: "BESTSELLERS_SNAPSHOT",
      status: "SUCCESS",
      period: body.period || "",
      itemCount: Array.isArray(body.items) ? body.items.length : 0,
      createdAt: new Date().toISOString(),
    });
    state.reports = state.reports.slice(0, 200);
    appendRequestAudit(state, req, account, {
      action: "BESTSELLERS_SNAPSHOT",
      storeId: currentStoreIdForAccount(state, account.id),
      source: "extension",
      entityType: "selection_snapshot",
      metadata: {
        period: body.period || "",
        itemCount: Array.isArray(body.items) ? body.items.length : 0,
      },
    });
    await saveState(state);
    sendJson(res, 200, { ok: true, imported: Array.isArray(body.items) ? body.items.length : 0 });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/selection/category-mapping") {
    requireAuth(req, state);
    sendJson(res, 200, { ok: true, local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/extension/translate") {
    requireAuth(req, state);
    const body = await readBody(req);
    const texts = Array.isArray(body.texts) ? body.texts : [];
    sendJson(res, 200, { texts, translated: texts, from: body.from || "ru", to: body.to || "zh", local: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/extension/ai-optimize") {
    requireAuth(req, state);
    const body = await readBody(req);
    sendJson(res, 200, { ...body, optimized: false, suggestions: [], local: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/announcements") {
    const account = requireAuth(req, state);
    const query = cleanText(url.searchParams.get("q") || url.searchParams.get("keyword"), 120).toLowerCase();
    const type = cleanText(url.searchParams.get("type"), 60).toLowerCase();
    const records = (state.caches.announcements || []).map((item) => ({
      ...item,
      read: (item.readByAccountIds || []).includes(account.id),
    }));
    const filtered = records.filter((item) => {
      const haystack = [item.title, item.summary, item.level, item.type]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");
      if (query && !haystack.includes(query)) return false;
      if (type && !String(item.type || "").toLowerCase().includes(type)) return false;
      return true;
    });
    sendJson(res, 200, emptyPage(url, filtered));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/announcements/batch") {
    const account = requirePermission(req, state, PERMISSIONS.ANNOUNCEMENT_MANAGE);
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    state.caches.announcements = state.caches.announcements || [];
    for (const item of items.slice(0, 100)) {
      const normalized = normalizeAnnouncement(item);
      upsertById(state.caches.announcements, normalized.id, normalized);
    }
    state.caches.announcements.sort((left, right) => new Date(right.time || right.createdAt || 0) - new Date(left.time || left.createdAt || 0));
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      imported: Math.min(items.length, 100),
      state: localStatePayload(state, { account, token: bearerToken(req) }),
      local: true,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/announcements/read-all") {
    const account = requireAuth(req, state);
    state.caches.announcements = (state.caches.announcements || []).map((item) => ({
      ...item,
      readByAccountIds: [...new Set([...(item.readByAccountIds || []), account.id])],
      updatedAt: new Date().toISOString(),
    }));
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      updated: state.caches.announcements.length,
      state: localStatePayload(state, { account, token: bearerToken(req) }),
      local: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/templates") {
    const account = requireAuth(req, state);
    const templateName = cleanText(url.searchParams.get("templateName"), 80).toLowerCase();
    const defaultFilter = cleanText(url.searchParams.get("default") || url.searchParams.get("isDefault"), 16).toLowerCase();
    const storeFilter = cleanText(url.searchParams.get("store") || url.searchParams.get("storeName"), 120).toLowerCase();
    const templates = cacheItemsForAccount(state, "productTemplates", account);
    const filtered = templates.filter((item) => {
      const itemName = String(item.templateName || item.name || "").toLowerCase();
      const itemStore = String(item.storeName || item.storeId || "").toLowerCase();
      if (templateName && !itemName.includes(templateName)) return false;
      if (storeFilter && !itemStore.includes(storeFilter)) return false;
      if (defaultFilter) {
        const defaultText = item.isDefault ? "是 true 1 yes default" : "否 false 0 no";
        if (!defaultText.includes(defaultFilter)) return false;
      }
      return true;
    });
    sendJson(res, 200, emptyPage(url, filtered));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/templates") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const item = scopeCacheItemForAccount(normalizeProductTemplate(body, {}, store), account, store);
    state.caches.productTemplates = state.caches.productTemplates || [];
    if (item.isDefault) {
      state.caches.productTemplates = state.caches.productTemplates.map((template) => (
        cacheItemBelongsToAccount(state, template, account)
          ? { ...template, isDefault: false, default: false }
          : template
      ));
    }
    state.caches.productTemplates.unshift(item);
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      item,
      state: localStatePayload(state, { account, token: bearerToken(req) }),
      local: true,
    });
    return;
  }

  const productTemplateMatch = url.pathname.match(/^\/ozon\/templates\/([^/]+)$/);
  if (productTemplateMatch && (req.method === "PUT" || req.method === "DELETE")) {
    const account = requireAuth(req, state);
    const id = decodeURIComponent(productTemplateMatch[1]);
    state.caches.productTemplates = state.caches.productTemplates || [];
    const index = state.caches.productTemplates.findIndex((item) =>
      String(item.id) === String(id) && cacheItemBelongsToAccount(state, item, account),
    );
    if (index < 0) {
      sendError(res, 404, "商品模板不存在");
      return;
    }
    if (req.method === "DELETE") {
      const [removed] = state.caches.productTemplates.splice(index, 1);
      await saveState(state);
      sendJson(res, 200, {
        ok: true,
        removedId: removed.id,
        state: localStatePayload(state, { account, token: bearerToken(req) }),
        local: true,
      });
      return;
    }
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || state.caches.productTemplates[index].storeId || "",
    );
    const store = activeStore(state, storeId, account.id);
    const item = scopeCacheItemForAccount(
      normalizeProductTemplate(body, state.caches.productTemplates[index], store),
      account,
      store,
    );
    if (item.isDefault) {
      state.caches.productTemplates = state.caches.productTemplates.map((template) => (
        !cacheItemBelongsToAccount(state, template, account) || String(template.id) === String(item.id)
          ? template
          : { ...template, isDefault: false, default: false }
      ));
    }
    state.caches.productTemplates[index] = item;
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      item,
      state: localStatePayload(state, { account, token: bearerToken(req) }),
      local: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/message-templates") {
    const account = requireAuth(req, state);
    const templateName = cleanText(url.searchParams.get("templateName"), 80).toLowerCase();
    const category = cleanText(url.searchParams.get("category"), 32);
    const contentPreview = cleanText(url.searchParams.get("contentPreview"), 120).toLowerCase();
    const templates = cacheItemsForAccount(state, "messageTemplates", account);
    const filtered = templates.filter((item) => {
      const itemName = String(item.templateName || item.name || "").toLowerCase();
      const itemContent = String(item.content || "").toLowerCase();
      if (templateName && !itemName.includes(templateName)) return false;
      if (category && item.category !== category) return false;
      if (contentPreview && !itemContent.includes(contentPreview)) return false;
      return true;
    });
    sendJson(res, 200, emptyPage(url, filtered));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/message-templates") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const item = scopeCacheItemForAccount(normalizeMessageTemplate(body), account, store);
    state.caches.messageTemplates = state.caches.messageTemplates || [];
    state.caches.messageTemplates.unshift(item);
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      item,
      state: localStatePayload(state, { account, token: bearerToken(req) }),
      local: true,
    });
    return;
  }

  const messageTemplateMatch = url.pathname.match(/^\/ozon\/message-templates\/([^/]+)$/);
  if (messageTemplateMatch && (req.method === "PUT" || req.method === "DELETE")) {
    const account = requireAuth(req, state);
    const id = decodeURIComponent(messageTemplateMatch[1]);
    state.caches.messageTemplates = state.caches.messageTemplates || [];
    const index = state.caches.messageTemplates.findIndex((item) =>
      String(item.id) === String(id) && cacheItemBelongsToAccount(state, item, account),
    );
    if (index < 0) {
      sendError(res, 404, "消息模板不存在");
      return;
    }
    if (req.method === "DELETE") {
      const [removed] = state.caches.messageTemplates.splice(index, 1);
      await saveState(state);
      sendJson(res, 200, {
        ok: true,
        removedId: removed.id,
        state: localStatePayload(state, { account, token: bearerToken(req) }),
        local: true,
      });
      return;
    }
    const body = await readBody(req);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || state.caches.messageTemplates[index].storeId || "",
    );
    const store = activeStore(state, storeId, account.id);
    state.caches.messageTemplates[index] = scopeCacheItemForAccount(
      normalizeMessageTemplate(body, state.caches.messageTemplates[index]),
      account,
      store,
    );
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      item: state.caches.messageTemplates[index],
      state: localStatePayload(state, { account, token: bearerToken(req) }),
      local: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/message-history") {
    const account = requireAuth(req, state);
    const receiver = cleanText(url.searchParams.get("receiver"), 120).toLowerCase();
    const template = cleanText(url.searchParams.get("template") || url.searchParams.get("templateName"), 120).toLowerCase();
    const content = cleanText(url.searchParams.get("content"), 120).toLowerCase();
    const status = cleanText(url.searchParams.get("status"), 32);
    const kind = cleanText(url.searchParams.get("kind"), 32);
    const records = cacheItemsForAccount(state, "messageHistory", account);
    const filtered = records.filter((item) => {
      if (receiver && !String(item.receiver || item.postingNumber || "").toLowerCase().includes(receiver)) return false;
      if (template && !String(item.templateName || "").toLowerCase().includes(template)) return false;
      if (content && !String(item.content || "").toLowerCase().includes(content)) return false;
      if (status && item.status !== status) return false;
      if (kind && item.kind !== kind) return false;
      return true;
    });
    sendJson(res, 200, emptyPage(url, filtered));
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/message-history/batch") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    const storeId = storeIdForAccountRequest(
      state,
      account,
      req.headers["x-ozon-store-id"] || "",
    );
    const store = activeStore(state, storeId, account.id);
    const created = items.slice(0, 200).map((item) =>
      scopeCacheItemForAccount(normalizeMessageHistoryItem(item, store), account, store)
    );
    state.caches.messageHistory = [...created, ...(state.caches.messageHistory || [])].slice(0, 1000);
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      created: created.length,
      items: created,
      state: localStatePayload(state, { account, token: bearerToken(req) }),
      local: true,
      dryRun: true,
    });
    return;
  }

  const templateApplyMatch = url.pathname.match(/^\/ozon\/templates\/([^/]+)\/apply$/);
  if (req.method === "POST" && templateApplyMatch) {
    const account = requireAuth(req, state);
    const id = decodeURIComponent(templateApplyMatch[1]);
    const template = cacheItemsForAccount(state, "productTemplates", account)
      .find((item) => String(item.id) === String(id)) || null;
    if (!template) {
      sendError(res, 404, "商品模板不存在");
      return;
    }
    sendJson(res, 200, {
      ok: true,
      templateId: id,
      templateSettings: template?.templateSettings || {},
      template: template || null,
      local: true,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/ai/optimize-for-rating") {
    requireAuth(req, state);
    const body = await readBody(req);
    sendJson(res, 200, {
      ok: true,
      local: true,
      optimized: false,
      title: body.title || "",
      description: body.description || "",
      attrs: body.currentAttrs || body.attrs || [],
      warnings: ["本地复刻版未接入线上 AI 优化服务"],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/ai/suggest-category") {
    requireAuth(req, state);
    sendJson(res, 200, { ok: true, local: true, suggestions: [], category: null });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/ai/verify-category") {
    requireAuth(req, state);
    sendJson(res, 200, { ok: true, local: true, valid: true, reason: "本地复刻版未接入线上 AI 复核服务" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ozon/products/import/jobs") {
    const account = requireAuth(req, state);
    const storeId = storeIdForAccountRequest(
      state,
      account,
      url.searchParams.get("storeId") || "",
    );
    const jobs = await listSubmissionJobsV3({
      storeId,
      accountId: account.id,
      limit: Number(url.searchParams.get("limit") || 500),
    });
    sendJson(res, 200, { ok: true, data: jobs, total: jobs.length, pipelineVersion: "v3" });
    return;
  }

  const importJobDetailMatch = url.pathname.match(/^\/ozon\/products\/import\/jobs\/([^/]+)$/);
  if (req.method === "GET" && importJobDetailMatch) {
    const account = requireAuth(req, state);
    const job = await getSubmissionJobDetailV3(
      decodeURIComponent(importJobDetailMatch[1]),
      account.id,
    );
    if (!job) {
      sendError(res, 404, "上架任务不存在", "LISTING_JOB_NOT_FOUND");
      return;
    }
    if (String(job.accountId || "") !== String(account.id)) {
      sendError(res, 404, "上架任务不存在", "LISTING_JOB_NOT_FOUND");
      return;
    }
    sendJson(res, 200, { ok: true, job, pipelineVersion: "v3" });
    return;
  }

  const aiDraftMatch = url.pathname.match(/^\/ozon\/collect-box\/([^/]+)\/ai-listing-draft(?:\/(confirm|publish))?$/);
  if (req.method === "POST" && aiDraftMatch) {
    const account = requireAuth(req, state);
    const id = decodeURIComponent(aiDraftMatch[1]);
    const action = aiDraftMatch[2] || "create";
    const item = cacheItemsForAccount(state, "collectBox", account)
      .find((row) => String(row.id) === String(id));
    if (!item) {
      sendError(res, 404, "采集箱条目不存在");
      return;
    }
    if (action === "publish") {
      localWriteDisabled(res, "AI 上架草稿发布");
      return;
    }
    const body = await readBody(req);
    item.aiListingDraft = {
      ...(item.aiListingDraft || {}),
      ...body,
      status: action === "confirm" ? "CONFIRMED_LOCAL" : "DRAFT_LOCAL",
      updatedAt: new Date().toISOString(),
    };
    item.updatedAt = new Date().toISOString();
    await saveState(state);
    sendJson(res, 200, {
      ok: true,
      draft: item.aiListingDraft,
      item: publicPersistedCollectionItem(item),
      local: true,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/products/import/status") {
    const authenticatedAccount = requireAuth(req, state);
    const body = await readBody(req);
    const taskId = body.task_id || body.taskId || "";
    if (!taskId) {
      sendError(res, 400, "缺少 task_id");
      return;
    }
    const v3Job = await getSubmissionJobV3(taskId, authenticatedAccount.id);
    if (v3Job) {
      if (String(v3Job.accountId || "") !== String(authenticatedAccount.id)) {
        sendError(res, 404, "上架任务不存在", "LISTING_JOB_NOT_FOUND");
        return;
      }
      const done = ["SUCCEEDED", "PARTIAL_SUCCESS", "FAILED", "CANCELLED"].includes(String(v3Job.status || "").toUpperCase());
      sendJson(res, 200, {
        ok: true,
        task_id: v3Job.ozonTaskId || v3Job.id,
        local_task_id: v3Job.id,
        status: v3Job.status,
        done,
        queued: !done,
        result: v3Job.statusResponse?.result || { items: v3Job.items || [] },
        job: v3Job,
        local: true,
        pipelineVersion: "v3",
      });
      return;
    }
    const legacyJob = findImportJobByTaskId(state, taskId);
    if (legacyJob && !importJobBelongsToAccount(state, legacyJob, authenticatedAccount)) {
      sendError(res, 404, "上架任务不存在", "LISTING_JOB_NOT_FOUND");
      return;
    }
    const store = getRequestStore(state, req, body.storeId);
    const numericTaskId = Number(taskId);
    try {
      const data = await callOzonSellerApi(store, "/v1/product/import/info", {
        task_id: Number.isFinite(numericTaskId) && numericTaskId > 0 ? numericTaskId : taskId,
      }, 60000);
      const job = legacyJob;
      const statusInfo = job
        ? applyImportStatusResult(state, job, taskId, data).statusInfo
        : deriveImportInfoStatus(data);
      if (job) {
        await saveState(state);
      }
      sendJson(res, 200, {
        ok: true,
        task_id: taskId,
        status: statusInfo.status,
        done: statusInfo.done,
        result: data?.result || data,
        raw: data,
        local: false,
      });
    } catch (error) {
      const job = legacyJob;
      const currentStatus = job?.status || "RUNNING";
      if (job) {
        applyImportStatusCheckFailure(state, job, error);
        await saveState(state);
        scheduleImportStatusPolling(30000);
      }
      sendJson(res, error?.status || 502, {
        ok: false,
        task_id: taskId,
        status: currentStatus,
        done: false,
        check_failed: true,
        error: error?.message || "Ozon 上架状态查询失败",
        ozon: error?.body || null,
        local: false,
      });
    }
    return;
  }

  const disabledWriteEndpoints = new Map([
    ["/ozon/products/prepare-bundle-items", "门户上架准备"],
    ["/ozon/products/import-from-public", "公开商品上架"],
    ["/ozon/products/follow-from-public", "公开商品跟卖"],
  ]);
  if (req.method === "POST" && url.pathname === "/ozon/products/import/preview") {
    requireAuth(req, state);
    const body = await readBody(req);
    try {
      const result = await previewOzonProductImport(state, req, body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error?.status || 502, {
        ok: false,
        dryRun: true,
        message: error?.message || "Ozon 商品上架预检失败",
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.body || {}),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/products/import") {
    requireAuth(req, state);
    const body = await readBody(req);
    if (!listingPipelineEnabled()) {
      sendError(
        res,
        503,
        "安全上架任务队列当前不可用，请恢复 PostgreSQL 与 LISTING_PIPELINE_V3 后重试",
        "LISTING_PIPELINE_REQUIRED",
      );
      return;
    }
    try {
      const result = await queueCollectSubmissionV3(state, req, body, null, "PRODUCT_IMPORT");
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error?.status || 502, {
        ok: false,
        message: error?.message || "Ozon 商品上架失败",
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.body || {}),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/stocks/import") {
    requireAuth(req, state);
    localWriteDisabled(res, "单独库存写入");
    return;
  }
  if (req.method === "POST" && url.pathname === "/ozon/products/import-by-sku") {
    requireAuth(req, state);
    const body = await readBody(req);
    if (!listingPipelineEnabled()) {
      sendError(
        res,
        503,
        "安全上架任务队列当前不可用，请恢复 PostgreSQL 与 LISTING_PIPELINE_V3 后重试",
        "LISTING_PIPELINE_REQUIRED",
      );
      return;
    }
    try {
      const result = await queueCollectSubmissionV3(state, req, body, null, "IMPORT_BY_SKU");
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error?.status || 502, {
        ok: false,
        message: error?.message || "Ozon SKU 上架失败",
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.body || {}),
      });
    }
    return;
  }

  if (req.method === "POST" && disabledWriteEndpoints.has(url.pathname)) {
    requireAuth(req, state);
    localWriteDisabled(res, disabledWriteEndpoints.get(url.pathname));
    return;
  }

  const fleetMatch = url.pathname.match(/^\/ozon\/fleet\/([^/]+)$/);
  if (req.method === "POST" && fleetMatch) {
    requireAuth(req, state);
    sendJson(res, 200, { ok: false, disabled: true, local: true, path: decodeURIComponent(fleetMatch[1]) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/extension/latest") {
    sendJson(res, 200, { version: "0.13.46.1", latestVersion: "0.13.46.1", downloadUrl: "/qh-extension-0.13.46.1.zip" });
    return;
  }

  sendError(res, 404, `未实现的本地接口: ${req.method} ${url.pathname}`, "LOCAL_NOT_FOUND");
  });
}

export const testExports = {
  activeStore,
  buildCollectBoxListingItems,
  cacheItemMatchesStore,
  cacheItemsForStore,
  canAccessLocalFile,
  currentStoreIdForAccount,
  ensureAccountState,
  listingStockRowsFromDraft,
  localStatePayload,
  setCurrentStoreForAccount,
  storesForAccount,
  upsertProductByStore,
  validateCollectBoxListingDraft,
  queueCollectSubmissionV3,
};

export { handle };

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = Number(error?.status || 500);
    sendError(res, status, error?.message || "本地服务异常");
  });
});

if (process.env.QH_LOCAL_NO_LISTEN !== "1") {
  server.listen(port, listenHost, () => {
    console.log(`QH local API listening on http://${listenHost}:${port}`);
    scheduleImportStatusPolling(1000);
    objectCleanupWorker.start();
  });
}

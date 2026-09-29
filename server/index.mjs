import {productCatalogPage} from '../shared/product-catalog.mjs';
import { buildCollectBoxListingItems, listingFirstText, listingNumber, listingImageList } from "./collect-box-listing-items.mjs";
import {findCollectedSku,withoutListedSkus} from "./collection-sku-rules.mjs";
import {listCollectItemsV3} from "./listing-pipeline.mjs";
import {readCollectProgressForAccount} from "./collect-progress-reader.mjs";
import {readCollectSummaryPage} from "./collect-read-summary.mjs";
import {collectCaptureSkus} from "./collect-enrichment-recovery.mjs";
import {reconcileCollectEnrichment} from "./collect-enrichment-reconciler.mjs";
import { verifyDirectRfbsTargets } from "./listing-direct-rfbs.mjs";
import { validateCollectListingWarehouses } from "./collect-listing-warehouse-validation.mjs";
import { createAutoListingRfbsWarehouseVerifier } from "./auto-listing-rfbs-warehouse-verifier.mjs";
import {admitCollectedItem} from "./collection-admission.mjs";
import "./env.mjs";
import { buildOzonEnrichmentSummary } from "./collect-enrichment-policy.mjs";
import { createPostgresCollectorOzonEnrichmentRepository } from "./collector-ozon-enrichment-repository.mjs";
import { handleHealthRoute } from "./health-routes.mjs";
import { assertProductionConfiguration } from "./runtime-config.mjs";
import { createAiListingRuntime } from "./ai-listing-runtime.mjs";
import { createDashboardRuntime } from "./dashboard-runtime.mjs";
import { createMessageRuntime } from "./message-runtime.mjs";
import { createStockRuntime } from './stock-runtime.mjs';
import { createOrderManagementRuntime } from './order-management-runtime.mjs';
import { createOrderInspectionRuntime } from './order-inspection-runtime.mjs';
import { createPromotionRuntime } from "./promotion-runtime.mjs";
import { getPostgresPool, closePostgresPool } from "./db/connection.mjs";
import { createApiLifecycle } from "./api-lifecycle.mjs";
import { captureFormalMirrorBaseline } from "./formal-persistence.mjs";
import { readLocalStateForAccount, readProductCatalogPage, productPageOptions } from "./local-state-reader.mjs";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { readFile } from 'node:fs/promises';
import { normalizeOzonImportItems } from "./ozon-import-normalizer.mjs";
import {createAccountOzonRouteService,createAccountOzonRouteHandler} from './account-ozon-route.mjs';
import { callOzonSellerApi } from "./ozon-client.mjs";
import { createOzonCategoryService } from "./ozon-category-service.mjs";
import { createOzonCategoryRouteHandler } from "./ozon-category-routes.mjs";
import { createOzonSyncService } from "./ozon-sync-service.mjs";
import { appendAuditEvent } from "./audit-event.mjs";
import { removeAccountScope } from "./account-deletion.mjs";
import { migrateLegacyDataCollectionStoreStateForAudit } from "./legacy-data-collection-store.mjs";
import {
  activeAccount,
  activeStore,
  bearerToken,
  createAccountRecord,
  createAuthSession,
  createPasswordHash,
  createStoreId,
  currentStoreIdForAccount,
  findAccountByUsername,
  findSession,
  findStore,
  isAccountExpired,
  normalizeAccountExpiresAt,
  normalizeDateOnly,
  optionalAuth,
  publicAccount,
  removeSession,
  requireAdmin,
  requireAuth,
  requirePermission,
  revokeAccountSessions,
  setCurrentStoreForAccount,
  storeIdForAccountRequest,
  storesForAccount,
  todayDateOnly,
  verifyPassword,
} from "./account-context.mjs";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";
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
  patchLegacyCollectStatusV3,
  readStoreCredentialV3,
  softDeleteCollectItemsForAccountV4,
  updateCollectItemDraftV4,
  updateCollectItemListingStatusV3,
} from "./listing-pipeline.mjs";
import { assertListingPreparationInput, publicQueuedListingSubmission, resolveLocalListingTarget } from "./listing-submission-policy.mjs";
import {
  authenticateCollectionRequest,
  getCollectRequestForAccount,
  ingestCollectRequestV4,
  assertCollectorScopeFieldsAbsentV4,
  preflightCollectRequestsV4,
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
import { createOzonWebCollectionService } from "./ozon-web-collection.mjs";
import { createOzonWebCollectionHttpHandler } from "./ozon-web-collection-routes.mjs";
import { readCollectorAccountCounts } from "./collector-account-status-routes.mjs";
import { handleCollectorArtifactRoute } from "./collector-artifact-routes.mjs";
import { publicPersistedCollectionItem } from "./collection-public-shape.mjs";
import { withoutCollectorScope } from "./collector-scope-sanitizer.mjs";
import { getCollectorTaskForAccount, getCollectorRunForAccount, listCollectorRunItems } from "./collector-desktop-service.mjs";
import { createCollectorHandoffRepository, createCollectorRunHandoffWorker } from './collector-run-handoff.mjs';
import { addSelectedCollectorItemsToCollectBox } from './collector-selection-service.mjs';
import { collectorAccountChangeReason, collectorParentSessionTokens, createCollectorAuthRuntime } from "./collector-auth-runtime.mjs";
import {
  createAccountSharedOzonCategoryComposition,
} from "./account-shared-ozon-category-composition.mjs";
import {
  assertOzonListingLogisticsReady,
  assertOzonListingReady,
  explicitOzonListingTarget,
  normalizeOzonCollectedSourceEvidence,
  preserveOzonSourceCategoryEvidence,
} from "./collect-enrichment-policy.mjs";
import { createJsonStateTransactionBoundary } from "./json-state-transaction.mjs";
import { handleRetiredExtensionSyncRoute } from "./extension-sync-retirement.mjs";
import { handleRemovedDataCollectionStoreRoute } from "./data-collection-store-retirement.mjs";
import { annotateListingWarehouseEligibility } from "./listing-warehouse-eligibility.mjs";
import { createOzonSkuCollectionService } from "./ozon-sku-collection-service.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
assertProductionConfiguration("api");
const rootDir = path.resolve(__dirname, "..");
const dataDir = process.env.QH_LOCAL_DATA_DIR || path.join(rootDir, "server-data");
const dataFile = path.join(dataDir, "local-state.json");
const port = Number(process.env.QH_LOCAL_API_PORT || process.env.PORT || 3001);
const listenHost = process.env.QH_LOCAL_API_HOST || "127.0.0.1";
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

const retiredSecondaryOperationRoutes = Object.freeze([
  ["POST", /^\/local\/sync\/(?:POSTINGS|PROMOTIONS)$/iu],
  ["POST", /^\/ozon\/postings\/cache\/import$/u],
  ["GET", /^\/ozon\/returns$/u],
  ["POST", /^\/ozon\/returns\/batch$/u],
  ["GET", /^\/ozon\/message-templates$/u],
  ["POST", /^\/ozon\/message-templates$/u],
  ["PUT", /^\/ozon\/message-templates\/[^/]+$/u],
  ["DELETE", /^\/ozon\/message-templates\/[^/]+$/u],
  ["GET", /^\/ozon\/message-history$/u],
  ["POST", /^\/ozon\/message-history\/batch$/u],
]);

function handleRetiredSecondaryOperation(req, res, url) {
  const retired = /^\/(?:auto-listing|admin\/auto-listing|extension\/auto-listing)(?:\/|$)/u.test(url.pathname) || retiredSecondaryOperationRoutes.some(
    ([method, pattern]) => method === req.method && pattern.test(url.pathname),
  );
  if (!retired) return false;
  sendJson(res, 410, {
    ok: false,
    code: "FEATURE_RETIRED",
    message: "该运营辅助功能已停用",
  });
  return true;
}

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
  migrateLegacyDataCollectionStoreStateForAudit(state);
  state.caches = state.caches && typeof state.caches === "object" ? state.caches : {};
  delete state.caches.watermarkTemplates;
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
  state.currentStoreIdsByAccount =
    state.currentStoreIdsByAccount &&
    typeof state.currentStoreIdsByAccount === "object" &&
    !Array.isArray(state.currentStoreIdsByAccount)
      ? state.currentStoreIdsByAccount
      : {};
  state.stores = state.stores.map((store) => {
    const { watermarkTemplateId: _retiredWatermarkTemplateId, ...activeStoreFields } = store;
    return {
      ...activeStoreFields,
      ownerAccountId: resolveLegacyStoreOwner(activeStoreFields, state.accounts),
    };
  });
  const defaultOwnerAccountId = state.accounts.length === 1 ? String(state.accounts[0]?.id || "") : "";
  if (defaultOwnerAccountId && state.currentStoreId && !state.currentStoreIdsByAccount[defaultOwnerAccountId]) {
    state.currentStoreIdsByAccount[defaultOwnerAccountId] = state.currentStoreId;
  }
  for (const account of state.accounts) {
    const operatingStoreId = currentStoreIdForAccount(state, account.id);
    if (operatingStoreId) state.currentStoreIdsByAccount[account.id] = operatingStoreId;
    else delete state.currentStoreIdsByAccount[account.id];
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
  state.currentStoreId = state.currentAccountId
    ? currentStoreIdForAccount(state, state.currentAccountId)
    : "";
  return state;
}

async function loadState({ hydrateCatalog = true } = {}) {
  const parsed = await loadPersistedState({ dataFile, hydrateCatalog });
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
  });
  if (storageVersion > 0) {
    Object.defineProperty(state, "__storageVersion", {
      value: storageVersion,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (hydrateCatalog && listingPipelineEnabled() && !collectV3BackfillDone) {
    const pool = await getPostgresPool();
    const existing = new Set((await pool.query("SELECT account_id,id FROM collect_items")).rows
      .map(row => `${row.account_id}:${row.id}`));
    for (const item of state.caches.collectBox || []) {
      if (existing.has(`${item.accountId || state.currentAccountId}:${item.id}`)) continue;
      await mirrorCollectItemV3(item, {
        accountId: state.currentAccountId,
        storeId: item.storeId || item.localStoreId || state.currentStoreId,
        captureRaw: true,
      });
    }
    collectV3BackfillDone = true;
  }
  const ownerIds=[...new Set(state.stores.map(store=>store.ownerAccountId).filter(Boolean))];
  const routes=persistenceMode()==='postgres'&&ownerIds.length
    ?Object.fromEntries((await (await getPostgresPool()).query('SELECT account_id,route FROM account_ozon_routes WHERE account_id=ANY($1::text[])',[ownerIds])).rows.map(row=>[row.account_id,row.route]))
    :Object.fromEntries(Object.entries(state.ozonRoutesByAccount||{}).map(([id,value])=>[id,value.route]));
  for(const store of state.stores)store.ozonRoute=routes[store.ownerAccountId]||'CN';
  if (hydrateCatalog) await hydrateLegacyStateWithV3(state);
  return captureFormalMirrorBaseline(state, { includeCatalog: hydrateCatalog });
}

async function saveState(state, options = {}) {
  state.updatedAt = new Date().toISOString();
  await savePersistedState({ dataDir, dataFile, state, ...options });
}

const jsonStateTransaction = createJsonStateTransactionBoundary({ enabled: () => persistenceMode() === "json" });

function legacyRouteNeedsCatalogHydration(req, url) {
  const method = String(req?.method || "GET").toUpperCase();
  const pathname = String(url?.pathname || "");

  // Deleting an account removes every account-owned compatibility cache.
  if (method === "DELETE" && /^\/local\/accounts\/[^/]+$/.test(pathname)) return true;

  // These compatibility handlers directly read formal product/warehouse rows.
  if (method === "GET" && /^\/ozon\/product-data\/[^/]+$/.test(pathname)) return true;
  if (method === "POST" && pathname === "/ozon/product-data/batch") return true;
  if (method === "GET" && pathname === "/ozon/warehouses") return true;

  // Collection deletion and listing/draft operations consume the hydrated
  // compatibility collect cache. Other collection writes own their fresh load.
  if (method === "DELETE" && (
    pathname === "/ozon/collect-box/batch"
    || /^\/ozon\/collect-box\/[^/]+$/.test(pathname)
  )) return true;
  if (method === "POST" && /^\/ozon\/collect-box\/[^/]+\/ai-listing-draft(?:\/(confirm|publish))?$/.test(pathname)) return true;

  return false;
}

const collectorAuthRuntime = createCollectorAuthRuntime({ loadState, saveState, persistenceMode, stateTransaction: jsonStateTransaction, readJson: readBody, sendJson });
const authenticateAutoListingRequest = async (req) => {
  if (listingPipelineEnabled()) return authenticateCollectionRequest(req);
  return jsonStateTransaction.run(async () => requireAuth(req, await loadState()));
};
const accountOzonRouteService=createAccountOzonRouteService(persistenceMode()==='postgres'
  ?{pool:getPostgresPool}:{loadState:()=>loadState({hydrateCatalog:false}),saveState,transaction:fn=>jsonStateTransaction.run(fn)});
const handleAccountOzonRoute=createAccountOzonRouteHandler({service:accountOzonRouteService,authenticate:authenticateAutoListingRequest,readJson:readBody,sendJson});
const ozonCategoryService = createOzonCategoryService();
const dashboardRuntime = createDashboardRuntime({ authenticate:authenticateAutoListingRequest, sendJson });
const messageRuntime = createMessageRuntime({ authenticate:authenticateAutoListingRequest, readJson:readBody, sendJson });
const stockRuntime = createStockRuntime({ authenticate:authenticateAutoListingRequest, readJson:readBody, sendJson });
const orderManagementRuntime = createOrderManagementRuntime({ authenticate:authenticateAutoListingRequest, readJson:readBody, sendJson });
const orderInspectionRuntime = createOrderInspectionRuntime({ authenticate:authenticateAutoListingRequest, readJson:readBody, sendJson });
const promotionRuntime = createPromotionRuntime({ authenticate:authenticateAutoListingRequest, readJson:readBody, sendJson });
const aiListingRuntime = createAiListingRuntime({
  authenticate: authenticateAutoListingRequest,
  readJson: readBody,
  sendJson,
  buildListingItems: buildCollectBoxListingItems,
});
let collectorHandoffWorker,collectorHandoffStartTimer,collectorHandoffStarting;
async function startCollectorHandoff() {
  const pool = await getPostgresPool();
  // Run through the collector's existing migration gate before querying its outbox.
  await getCollectorRunForAccount('__startup__', '__startup__');
  if (lifecycle.stopping) return;
  collectorHandoffWorker = createCollectorRunHandoffWorker({ repository: createCollectorHandoffRepository(pool),
    readRun: async ({accountId,runId}) => {
      const account = (await pool.query('SELECT status,expires_at FROM accounts WHERE id=$1', [accountId])).rows[0];
      if (!account || account.status !== 'active' || (account.expires_at && new Date(account.expires_at).getTime() <= Date.now())) {
        throw Object.assign(new Error('账号不可用，自动发送已停止'), {code:'COLLECTOR_HANDOFF_ACCOUNT_UNAVAILABLE'});
      }
      const run = await getCollectorRunForAccount(accountId, runId);
      if (run && !await getCollectorTaskForAccount(accountId, run.taskId)) {
        throw Object.assign(new Error('采集任务已删除，未完成的自动发送已停止'), {code:'COLLECTOR_HANDOFF_TASK_DELETED'});
      }
      return run;
    },
    listItems: listCollectorRunItems, addSelected: addSelectedCollectorItemsToCollectBox,
    createTasks: input => aiListingRuntime.createCollectorTasks(input),
  });
  collectorHandoffWorker.start();
}
async function scheduleCollectorHandoffStart() {
  if (lifecycle.stopping) return;
  try { await (collectorHandoffStarting = startCollectorHandoff()); }
  catch {
    console.error('[collector-handoff] startup deferred; retrying in 10 seconds');
    if(!lifecycle.stopping && server.listening)collectorHandoffStartTimer=setTimeout(scheduleCollectorHandoffStart,10000);
  } finally { collectorHandoffStarting = null; }
}
function requiredOptionalFunctionOverride(overrides, name) {
  if (!Object.hasOwn(overrides, name)) return {};
  if (typeof overrides[name] !== "function") {
    throw new TypeError(`${name} override must be a function`);
  }
  return { [name]: overrides[name] };
}

export function createServerAccountSharedOzonCategoryComposition(overrides = {}) {
  const logger = Object.hasOwn(overrides, "logger") ? overrides.logger : console;
  return createAccountSharedOzonCategoryComposition({
    loadState,
    saveState,
    persistenceMode,
    stateTransaction: jsonStateTransaction,
    collectorAuthRuntime,
    authenticateAccount: async (req) => {
      if (listingPipelineEnabled()) return authenticateCollectionRequest(req);
      return jsonStateTransaction.run(async () => requireAuth(req, await loadState()));
    },
    readJson: readBody,
    sendJson,
    sendError,
    normalizeItem: normalizeCollectItem,
    countAccountItems: (state, account) => cacheItemsForAccount(state, "collectBox", account),
    ...requiredOptionalFunctionOverride(overrides, "now"),
    ...requiredOptionalFunctionOverride(overrides, "randomUUID"),
    ...requiredOptionalFunctionOverride(overrides, "sleep"),
    logger,
  });
}
const defaultAccountSharedOzonCategoryComposition =
  createServerAccountSharedOzonCategoryComposition();
const {
  accountSharedOzonCategoryRuntime,
  collectorOzonEnrichmentRuntime,
  handleJsonAccountScopedCollectionRoute,
} = defaultAccountSharedOzonCategoryComposition;
const ozonSyncService = createOzonSyncService({
  loadState,
  saveState,
});
const objectCleanupWorker = createObjectCleanupWorker({
  loadState, saveState, removeObject,
  stateTransaction: jsonStateTransaction,
});

function sendJson(res, status, data, extraHeaders = {}) {
  const serializationStarted=performance.now();
  const body=JSON.stringify(data),bytes=Buffer.byteLength(body);
  const measurement=res.pipelineRead;
  const duration=measurement?performance.now()-measurement.startedAt:null;
  if(measurement&&(duration>5000||bytes>1024*1024))console.info('[pipeline-read]',{route:measurement.route,status,bytes,durationMs:Math.round(duration)});
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ozon-store-id, x-device-fingerprint",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    ...(status!==204?{'Content-Length':bytes}:{}),
    ...(measurement?{'Server-Timing':`app;dur=${duration.toFixed(1)}, serialize;dur=${(performance.now()-serializationStarted).toFixed(1)}`}:{}),
    ...extraHeaders,
  });
  res.end(status===204?undefined:body);
}

function sendError(res, status, message, code = "LOCAL_ERROR", details = {}) {
  sendJson(res, status, { ok: false, message, code, ...(details || {}) });
}

async function resolvePostgresOzonCategoryContext(req, _state, url) {
  const account = await authenticateCollectionRequest(req);
  const requestedStoreId = String(url.searchParams.get("storeId") || req.headers["x-ozon-store-id"] || "").trim();
  const pool = await getPostgresPool();
  const selected = (await pool.query(
    `SELECT id FROM stores WHERE owner_account_id=$1 ${requestedStoreId ? "AND id=$2" : ""}
     ORDER BY is_current DESC, saved_at DESC NULLS LAST, id LIMIT 1`,
    requestedStoreId ? [account.id, requestedStoreId] : [account.id],
  )).rows[0];
  if (!selected && requestedStoreId) {
    throw Object.assign(new Error("经营店铺不存在或不属于当前 sonli 账号"), {
      status:403, code:"STORE_ACCOUNT_FORBIDDEN",
    });
  }
  const store = selected ? await readStoreCredentialV3(selected.id, account.id) : null;
  if (!store) {
    throw Object.assign(new Error("店铺不存在或不属于当前账号"), {
      status:404, code:"STORE_NOT_FOUND",
    });
  }
  return {account, store:{...store, ownerAccountId:account.id}};
}

const handleOzonCategoryRoute = createOzonCategoryRouteHandler({
  categoryService: ozonCategoryService,
  requireAuth,
  storeIdForAccountRequest,
  activeStore,
  sendJson,
  sendError,
  reportError: (diagnostic) => console.warn("[ozon-category]", diagnostic),
});

async function readBody(req, { maxBytes = 10 * 1024 * 1024, requireBody = false } = {}) {
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
  if (!raw) {
    if (requireBody) {
      const err = new Error("请求体不能为空");
      err.status = 400;
      err.code = "REQUEST_BODY_REQUIRED";
      throw err;
    }
    return {};
  }
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
  const currency = String(store.currencySource || "") === "OZON_SELLER_INFO"
    && !Number.isNaN(Date.parse(String(store.currencySyncedAt || "")))
    ? normalizeCurrencyCode(store.currencyCode || store.currency || store.companyCurrency)
    : "";
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
    currencySource: currency ? "OZON_SELLER_INFO" : "",
    currencySyncedAt: currency ? store.currencySyncedAt : "",
    sellerCompanyId: store.sellerCompanyId || "",
    sellerCookieSyncedAt: store.sellerCookieSyncedAt || "",
    savedAt: store.savedAt,
    updatedAt: store.updatedAt || store.savedAt,
    profileSyncedAt: store.profileSyncedAt || "",
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

function summarize(state) {
  const syncTypes = new Set(["PRODUCTS", "WAREHOUSES"]);
  return {
    products: state.caches.products?.length || 0,
    warehouses: state.caches.warehouses?.length || 0,
    collectBox: state.caches.collectBox?.length || 0,
    favorites: state.caches.favorites?.length || 0,
    announcements: state.caches.announcements?.length || 0,
    productTemplates: state.caches.productTemplates?.length || 0,
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
    summary: summarize(empty),
    caches: {
      products: empty.caches.products,
      warehouses: empty.caches.warehouses,
      collectBox: empty.caches.collectBox,
      favorites: empty.caches.favorites,
      announcements: empty.caches.announcements,
      productTemplates: empty.caches.productTemplates,
      files: empty.caches.files,
    },
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

function stableCategorySummaryReadCode(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,119}$/.test(code)
    ? code
    : "CATEGORY_RESOLUTION_SUMMARY_READ_FAILED";
}

function taxonomyScopeForCollectionItem() {
  return "OZON:DEFAULT";
}

async function publicCollectBoxItemsForAccount(
  state,
  account,
  categoryResolutionReadPort = accountSharedOzonCategoryRuntime,
  {ids = null} = {},
) {
  const accountId = String(account?.id || "").trim();
  const items = listingPipelineEnabled() && accountId
    ? await listCollectItemsV3({accountId, ...(ids !== null ? {ids, limit:ids.length} : {})})
    : cacheItemsForAccount(state, "collectBox", account);
  const requestedScopes = new Map(items.map((item) => [
    String(item?.id || ""),
    taxonomyScopeForCollectionItem(item),
  ]).filter(([collectItemId]) => collectItemId));
  if (!accountId || !requestedScopes.size) return items.map(publicPersistedCollectionItem);

  let resolutions = [];
  try {
    resolutions = await categoryResolutionReadPort.readForItems({
      accountId,
      collectItemIds: [...requestedScopes.keys()],
    });
  } catch (error) {
    if (ids !== null) throw error;
    console.error("collect category summary read failed", {
      accountId,
      code: stableCategorySummaryReadCode(error),
    });
  }
  const byCollectItemId = new Map();
  for (const entry of Array.isArray(resolutions) ? resolutions : []) {
    const collectItemId = String(entry?.collectItemId || "");
    const resolution = entry?.categoryResolution;
    if (
      requestedScopes.get(collectItemId) !== String(resolution?.taxonomyScope || "")
      || byCollectItemId.has(collectItemId)
    ) continue;
    byCollectItemId.set(collectItemId, resolution);
  }
  const scopedSkus = ids !== null ? [...new Set(items.flatMap(collectCaptureSkus))] : null;
  const completed = listingPipelineEnabled()
    ? [{status:'COMPLETED',source:{items:(await (await getPostgresPool()).query(`SELECT DISTINCT item->>'sku' AS sku
      FROM ai_image_listing_tasks t CROSS JOIN LATERAL jsonb_array_elements(CASE
        WHEN t.status='COMPLETED' THEN CASE WHEN jsonb_typeof(t.body#>'{source,items}')='array' THEN t.body#>'{source,items}' ELSE '[]'::jsonb END
        ELSE CASE WHEN jsonb_typeof(t.body->'submissionResults')='array' THEN t.body->'submissionResults' ELSE '[]'::jsonb END END) item
      WHERE t.account_id=$1 AND (t.status='COMPLETED' OR t.body->'submissionResults' @> '[{"importStatus":"SUCCEEDED"}]'::jsonb)
        AND (t.status='COMPLETED' OR item->>'importStatus'='SUCCEEDED') AND item->>'sku' IS NOT NULL
        ${scopedSkus === null ? '' : `AND item->>'sku'=ANY($2::text[])`}`,
      scopedSkus === null ? [accountId] : [accountId,scopedSkus]))
      .rows}}] : [];
  return withoutListedSkus(items,completed).map((item) => publicPersistedCollectionItem(item, {
    categoryResolution: byCollectItemId.get(String(item?.id || "")) || null,
  }));
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
  const accountStoreIds = new Set(accountStores.map((store) => String(store.id || "")).filter(Boolean));
  const visibleJobs = Object.fromEntries(Object.entries(state.jobs || {}).filter(([, job]) => {
    if (String(job?.accountId || "") !== String(account.id)) return false;
    return job?.jobKind !== "STORE_SYNC" || !["POSTINGS", "PROMOTIONS"].includes(String(job.type || "").toUpperCase());
  }));
  const visibleCollectBox = (state.caches.collectBox || [])
    .filter((item) => String(item?.accountId || "") === String(account.id))
    .map(publicPersistedCollectionItem);
  const visibleFiles = ensureFilesCache(state).filter((file) => canAccessLocalFile(file, account));
  const visibleCaches = {
    products: accountScopedCache(state.caches.products, account, accountStoreIds),
    warehouses: annotateListingWarehouseEligibility({
      warehouses: accountScopedCache(state.caches.warehouses, account, accountStoreIds),
      products: accountScopedCache(state.listingWarehouseProducts ?? state.caches.products, account, accountStoreIds),
      accountId: account.id,
    }),
    collectBox: visibleCollectBox,
    favorites: accountScopedCache(state.caches.favorites, account, accountStoreIds),
    // Announcements are intentionally global broadcasts.
    announcements: state.caches.announcements || [],
    productTemplates: accountScopedCache(state.caches.productTemplates, account, accountStoreIds),
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

function accountOwnedCollectBoxItem(item, account) {
  return {
    ...withoutCollectorScope(item),
    accountId: account.id,
    createdBy: account.id,
  };
}

async function saveCollectBoxItemAtomic(item, { account }) {
  const existing = listingPipelineEnabled() ? await findCollectedSku(await getPostgresPool(),account.id,item.sku) : null;
  if(existing) return {item:existing,state:await loadState(),duplicate:true};
  item=await admitCollectedItem({accountId:account.id,item},persistenceMode()==='json'?{state:await loadState({hydrateCatalog:false})}:{});
  const latest = await loadState();
  const scopedItem = accountOwnedCollectBoxItem(item, account);
  const key = collectItemKey(scopedItem);
  latest.caches.collectBox = (latest.caches.collectBox || []).filter((row) =>
    !(collectItemKey(row) === key && cacheItemBelongsToAccount(latest, row, account))
  );
  latest.caches.collectBox.unshift(scopedItem);
  await saveState(latest);
  await mirrorCollectItemV3(scopedItem, {
    accountId: account.id,
    captureRaw: true,
  }).catch((error) => console.warn(`[listing-v3] 采集数据镜像失败: ${error?.message || error}`));
  return { item: scopedItem, state: latest };
}

async function updateCollectBoxItemAtomic(id, patch, { account } = {}) {
  const latest = await loadState();
  const index = (latest.caches.collectBox || []).findIndex((item) =>
    String(item.id) === String(id) && cacheItemBelongsToAccount(latest, item, account),
  );
  if (index < 0) return null;
  const current = latest.caches.collectBox[index];
  const safePatch = withoutCollectorScope(patch);
  const restoreTarget = (safeResolution, sourceResolution) => {
    const target = explicitOzonListingTarget(sourceResolution);
    if (!target || !safeResolution) return;
    if (!activeStore(latest, target.storeId, account.id)) {
      throw Object.assign(new Error("目标经营店铺不存在或不可用"), {
        status: 404,
        code: "TARGET_STORE_NOT_FOUND",
      });
    }
    safeResolution.target = { ...(safeResolution.target || {}), ...target };
  };
  restoreTarget(
    safePatch.listingDraft?.categoryResolution,
    patch?.listingDraft?.categoryResolution,
  );
  const safeVariants = Array.isArray(safePatch.listingDraft?.variants)
    ? safePatch.listingDraft.variants
    : [];
  const sourceVariants = Array.isArray(patch?.listingDraft?.variants)
    ? patch.listingDraft.variants
    : [];
  safeVariants.forEach((variant, variantIndex) => restoreTarget(
    variant?.categoryResolution,
    sourceVariants[variantIndex]?.categoryResolution,
  ));
  if (safePatch.listingDraft && typeof safePatch.listingDraft === "object") {
    safePatch.listingDraft = preserveOzonSourceCategoryEvidence(
      current.listingDraft,
      safePatch.listingDraft,
    );
  }
  for (const key of [
    "description_category_id",
    "descriptionCategoryId",
    "type_id_candidate",
    "typeIdCandidate",
    "type_id",
    "typeId",
  ]) delete safePatch[key];
  latest.caches.collectBox[index] = normalizeOzonCollectedSourceEvidence({
    ...current,
    ...safePatch,
    id,
    accountId: account.id,
    createdBy: current.createdBy || account.id,
    updatedAt: new Date().toISOString(),
  });
  await saveState(latest);
  await mirrorCollectItemV3(latest.caches.collectBox[index], {
    accountId: account.id,
  }).catch((error) => console.warn(`[listing-v3] 草稿镜像失败: ${error?.message || error}`));
  return latest.caches.collectBox[index];
}

async function updateCollectBoxListingState(id, patch, {account, currentItem} = {}) {
  if (!listingPipelineEnabled() || persistenceMode() !== "postgres") {
    return updateCollectBoxItemAtomic(id, patch, {account});
  }
  if (!currentItem) return null;
  if (patch.status && !await updateCollectItemListingStatusV3(account.id,id,patch.status)) return null;
  await patchLegacyCollectStatusV3(account.id, id, {
    ...withoutCollectorScope(patch),
    updatedAt:new Date().toISOString(),
  });
  return currentItem;
}

function applyAccountSharedListingCategory(item, resolution, targetStoreId) {
  if (!resolution || typeof resolution !== "object") return item;
  const descriptionCategoryId=Number(resolution?.currentDescriptionCategoryId || 0);
  const typeId=Number(resolution?.currentTypeId || 0);
  const active=resolution.status === "ACTIVE" && descriptionCategoryId>0 && typeId>0 && targetStoreId;
  const categoryResolution=active ? {
    status:"MATCHED",
    method:"ACCOUNT_SHARED_ACTIVE",
    target:{storeId:targetStoreId,descriptionCategoryId,typeId},
  } : {
    status:String(resolution.status || "NEEDS_REVIEW"),
    method:"ACCOUNT_SHARED_CURRENT",
  };
  const draft=item?.listingDraft || {};
  return {
    ...item,
    categoryResolution,
    listingDraft:{
      ...draft,
      categoryResolution,
      ...(Array.isArray(draft.variants) ? {variants:draft.variants.map(variant=>({
        ...variant,categoryResolution,
      }))} : {}),
    },
  };
}

async function syncCommittedCollectListingState({result,updateStatus,logWarning=console.warn}) {
  const patch={
    status:"上架中",
    listingTaskId:result.task_id || result.result?.task_id || "",
    listingJobId:result.job?.localTaskId || result.job?.id || "",
    listingLastError:"",
  };
  try { await updateStatus(patch); }
  catch (error) { logWarning("[collect-listing] committed submission status sync failed", error?.code || error?.message || error); }
  return result;
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

async function saveCollectBoxBatchAtomic(items, { account }) {
  if(listingPipelineEnabled()) {
    const fresh=[];
    for(const item of items) if(!await findCollectedSku(await getPostgresPool(),account.id,item.sku))fresh.push(item);
    items=fresh;
  }
  const admitted=[];
  const admissionContext=persistenceMode()==='json'?{state:await loadState({hydrateCatalog:false})}:{};
  for(const item of items)admitted.push(await admitCollectedItem({accountId:account.id,item},admissionContext));
  items=admitted;
  const latest = await loadState();
  latest.caches.collectBox = latest.caches.collectBox || [];
  const scopedItems = items.map((item) => accountOwnedCollectBoxItem(item, account));
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

function storeContractCurrencyCode(state, store = null) {
  if (String(store?.currencySource || "") !== "OZON_SELLER_INFO"
    || Number.isNaN(Date.parse(String(store?.currencySyncedAt || "")))) return "";
  return normalizeCurrencyCode(store?.currencyCode || store?.currency || store?.companyCurrency);
}

function withStoreContractCurrency(state, store, items = []) {
  const currencyCode = storeContractCurrencyCode(state, store);
  return (Array.isArray(items) ? items : []).map((item) => {
    const declaredCurrencies = [item.currency_code, item.currencyCode]
      .map(normalizeCurrencyCode).filter(Boolean);
    const mismatch = declaredCurrencies.find((code) => currencyCode && code !== currencyCode);
    if (mismatch) {
      throw Object.assign(new Error(`商品 ${item.offer_id || item.sku || ""} 的价格币种 ${mismatch} 与店铺 ${currencyCode} 不一致，请先填写以 ${currencyCode} 计价的售价。`), {
        status: 422,
        code: "IMPORT_CURRENCY_MISMATCH",
      });
    }
    return { ...item, currency_code: currencyCode, currencyCode };
  });
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

function localWriteDisabled(res, feature = "该功能") {
  sendError(
    res,
    409,
    `${feature}在本地复刻版中不会直接写入 Ozon。请先在后台绑定并确认真实写入链路后再启用。`,
    "LOCAL_ZONGZI_WRITE_DISABLED",
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

const ozonSkuCollectionService = createOzonSkuCollectionService({
  findExisting: async ({accountId,sku}) => listingPipelineEnabled() ? findCollectedSku(await getPostgresPool(),accountId,sku) : null,
  scrapeProductDetail: scrapeOzonProductDetail,
  normalizeItem: normalizeCollectItem,
  async saveItem(item, { account }) {
    if (!listingPipelineEnabled() || item?.raw?.error === "scrape_failed") {
      return saveCollectBoxItemAtomic(item, { account });
    }
    // Use the same category evidence and enrichment contracts as extension collection.
    let prepared = accountOwnedCollectBoxItem(item, account);
    try {
      prepared = await resolveAutoListingExcelSourceCategory(item, account);
    } catch (error) {
      // Preserve the collected facts; unresolved categories can be completed later.
      console.warn("[sku-collection] category lookup:", error?.code || "CATEGORY_UNRESOLVED");
    }
    prepared.enrichment = buildOzonEnrichmentSummary(prepared);
    prepared=await admitCollectedItem({accountId:account.id,item:prepared});
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const persisted = await mirrorCollectItemV3(prepared, {
        client, accountId: account.id, captureRaw: true,
      });
      const category = await accountSharedOzonCategoryRuntime.recordCollectionResult({
        postgresExecutor: client, accountId: account.id,
        collectItemId: persisted.collectId, item: prepared,
      });
      if (prepared.enrichment.status === "PENDING_ENRICHMENT") {
        const repository = createPostgresCollectorOzonEnrichmentRepository({ pool: client, transactionOwner: "caller" });
        await repository.enqueueForCollect({
          accountId: account.id, collectItemId: persisted.collectId,
          requestId: crypto.randomUUID(), sku: prepared.sku, refreshBundle: {}, now: new Date(),
        });
      }
      await client.query("COMMIT");
      return { item: { ...prepared, id: persisted.collectId, categoryResolution: category.categoryResolution } };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
});

async function resolveAutoListingExcelSourceCategory(
  item,
  account,
  { loadStateFn = loadState, categoryService = ozonCategoryService, store: suppliedStore = null } = {},
) {
  const scopedItem = accountOwnedCollectBoxItem(item, account);
  const sourceCategory = scopedItem.sourceCategory
    && typeof scopedItem.sourceCategory === "object"
    && !Array.isArray(scopedItem.sourceCategory) ? scopedItem.sourceCategory : {};
  const descriptionCategoryId = Number(sourceCategory.descriptionCategoryId);
  const typeId = Number(sourceCategory.typeIdCandidate ?? sourceCategory.typeId);
  if (Number.isSafeInteger(descriptionCategoryId) && descriptionCategoryId > 0
    && Number.isSafeInteger(typeId) && typeId > 0) return scopedItem;
  const typeName = String(sourceCategory.typeName || "").trim();
  if (!typeName) return scopedItem;
  let store = suppliedStore;
  if (!store) {
    const latest = await loadStateFn();
    store = activeStore(
      latest,
      currentStoreIdForAccount(latest, account.id),
      account.id,
    );
  }
  if (!store) {
    const error = new Error("AUTO_LISTING_SOURCE_STORE_REQUIRED");
    error.code = "AUTO_LISTING_SOURCE_STORE_REQUIRED";
    throw error;
  }
  const resolved = await categoryService.resolveExactTypeByName({
    accountId: account.id,
    store,
    typeName,
    language: "DEFAULT",
  });
  return {
    ...scopedItem,
    sourceCategory: {
      ...sourceCategory,
      descriptionCategoryId: resolved.descriptionCategoryId,
      typeIdCandidate: resolved.typeId,
      typeName: resolved.typeName,
    },
  };
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
let importStatusPollActive;

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
  if (lifecycle.stopping || process.env.QH_LOCAL_NO_LISTEN === "1" || importStatusPollTimer) return;
  importStatusPollTimer = setTimeout(() => {
    importStatusPollTimer = null;
    if (lifecycle.stopping || importStatusPollRunning) return;
    importStatusPollActive = runPendingImportStatusPolls();
    importStatusPollActive.catch((error) => {
      console.warn(`[listing-status] background poll failed: ${String(error?.message || error).slice(0, 300)}`);
      scheduleImportStatusPolling(30000);
    }).finally(() => { importStatusPollActive = null; });
  }, delayMs);
  importStatusPollTimer.unref?.();
}

async function runPendingImportStatusPolls() {
  if (lifecycle.stopping || importStatusPollRunning) return;
  importStatusPollRunning = true;
  try {
    return await jsonStateTransaction.run(async () => {
      // V3 jobs have their own worker. Inspect the legacy job index before
      // restoring catalog data that an idle legacy poller will never use.
      const legacyState = await loadState({ hydrateCatalog: false });
      if (!Object.values(legacyState.jobs || {}).some(importJobNeedsStatusPoll)) return;
      const latest = await loadState();
      const jobs = Object.values(latest.jobs || {}).filter(importJobNeedsStatusPoll).slice(0, 20);
      if (!jobs.length) return;
      let changed = false;
      for (const job of jobs) {
        if (lifecycle.stopping) break;
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

function publicCategoryResolution(resolution) {
  if (!resolution || typeof resolution !== "object") return undefined;
  const source = resolution.source && typeof resolution.source === "object"
    ? {
        descriptionCategoryId: Number(resolution.source.descriptionCategoryId) || 0,
        typeName: String(resolution.source.typeName || ""),
        typeIdCandidate: Number(resolution.source.typeIdCandidate) || 0,
        path: Array.isArray(resolution.source.path)
          ? resolution.source.path.map((value) => String(value || "").trim()).filter(Boolean)
          : [],
      }
    : { descriptionCategoryId: 0, typeName: "", typeIdCandidate: 0, path: [] };
  const result = {
    offerId: String(resolution.offerId || ""),
    status: resolution.status === "MATCHED" ? "MATCHED" : "PENDING",
    source,
    resolvedAt: String(resolution.resolvedAt || ""),
  };
  if (resolution.method) result.method = String(resolution.method);
  if (resolution.reason) result.reason = String(resolution.reason);
  if (resolution.targetStoreId) result.targetStoreId = String(resolution.targetStoreId);
  if (resolution.status === "MATCHED" && resolution.target) {
    result.target = {
      storeId: String(resolution.target.storeId || ""),
      descriptionCategoryId: Number(resolution.target.descriptionCategoryId) || 0,
      typeId: Number(resolution.target.typeId) || 0,
    };
  }
  return result;
}

function publicImportPreviewItem(item = {}, raw = {}, resolution) {
  const safeResolution = publicCategoryResolution(resolution);
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
    ...(safeResolution ? { categoryResolution: safeResolution } : {}),
  };
}

function resolvePreviewCategoryMatchPolicy(body={},override="") {
  if (override === "TARGET_STORE_EXACT") return override;
  return body.entry === "COLLECT_EDIT_AUTO_CATEGORY" ? "TARGET_STORE_EXACT" : "DEFAULT";
}

async function previewOzonProductImport(state, req, body, {categoryMatchPolicy:policyOverride="",collectedSource=false} = {}) {
  const store = getRequestStore(state, req, body.storeId);
  const rawItems = withStoreContractCurrency(state, store, Array.isArray(body.items) ? body.items.filter(Boolean) : []);
  if (!rawItems.length) {
    const err = new Error("缺少可预检的 items");
    err.status = 400;
    throw err;
  }
  const categoryMatchPolicy = collectedSource ? "DEFAULT" : resolvePreviewCategoryMatchPolicy(body,policyOverride);
  const normalized = await normalizeOzonImportItems(rawItems, {
    strictTypeMatch: !!body.strictTypeMatch,
    categoryMatchPolicy,
    trustSuppliedDictionaryIds: collectedSource,
    targetStoreId: store.id,
    allowUnresolvedRequiredDictionaryValues: categoryMatchPolicy === "TARGET_STORE_EXACT",
    getCategoryTree: collectedSource ? undefined : async () => (
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
    getCategoryAttributeValues: (descriptionCategoryId, typeId, attributeId, dictionaryOptions = {}) =>
      ozonCategoryService.getCategoryAttributeValues({
        accountId: store.ownerAccountId,
        store,
        descriptionCategoryId,
        typeId,
        attributeId,
        language: "DEFAULT",
        limit: 5000,
        ...dictionaryOptions,
      }).then(({ items }) => items),
    searchCategoryAttributeValuesExact: (descriptionCategoryId, typeId, attributeId, value) =>
      ozonCategoryService.searchCategoryAttributeValuesExact({
        accountId: store.ownerAccountId, store, descriptionCategoryId, typeId, attributeId, value,
      }).then(({ items }) => items),
  });
  if (normalized.items.length !== rawItems.length) {
    if (categoryMatchPolicy === "TARGET_STORE_EXACT") {
      const normalizedByOfferId = new Map(normalized.items.map((item) => [String(item.offer_id || ""), item]));
      const resolutionByOfferId = new Map(
        (normalized.categoryResolutions || []).map((resolution) => [String(resolution.offerId || ""), resolution]),
      );
      return {
        ok: true,
        dryRun: true,
        itemCount: rawItems.length,
        normalizedItemCount: normalized.items.length,
        warnings: normalized.warnings || [],
        items: rawItems.map((raw) => {
          const offerId = String(raw.offer_id || raw.offerId || "");
          return publicImportPreviewItem(
            normalizedByOfferId.get(offerId) || raw,
            raw,
            resolutionByOfferId.get(offerId),
          );
        }),
      };
    }
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
    items: normalized.items.map((item, index) => {
      const resolution = (normalized.categoryResolutions || []).find(
        (entry) => String(entry.offerId || "") === String(item.offer_id || ""),
      );
      return publicImportPreviewItem(item, rawItems[index] || {}, resolution);
    }),
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
    categoryMatchPolicy: "DEFAULT",
    trustSuppliedDictionaryIds: Boolean(collectItem),
    targetStoreId: store.id,
    getCategoryTree: collectItem ? undefined : async () => (
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
    getCategoryAttributeValues: (descriptionCategoryId, typeId, attributeId, dictionaryOptions = {}) =>
      categoryService.getCategoryAttributeValues({
        accountId: store.ownerAccountId,
        store,
        descriptionCategoryId,
        typeId,
        attributeId,
        language: "DEFAULT",
        limit: 5000,
        ...dictionaryOptions,
      }).then(({ items }) => items),
    searchCategoryAttributeValuesExact: (descriptionCategoryId, typeId, attributeId, value) =>
      categoryService.searchCategoryAttributeValuesExact({
        accountId: store.ownerAccountId, store, descriptionCategoryId, typeId, attributeId, value,
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
  const stockRows = Array.isArray(body.stocks) ? body.stocks : [];
  // This evidence comes only from our official verifier, never from request JSON.
  const directRfbsEvidence = dependencies.verifiedDirectRfbsEvidence?.length
    ? dependencies.verifiedDirectRfbsEvidence : stockRows.length ? await (dependencies.verifyDirectRfbsTargets || verifyDirectRfbsTargets)({
    pool: await getPostgresPool(), accountId: account.id, storeId: store.id, stocks: stockRows,
    readCredential: readStoreCredentialV3, callOzonSellerApi,
    correlationId: `direct-prepare-${crypto.randomUUID()}`,
  }) : [];
  const created = await (preparation ? prepareListing : createSubmission)({
    collectItem: submissionCollectItem,
    collectItemId: submissionCollectItem.id,
    storeId: targetStore?.id || store.id,
    targetStoreId: targetStore?.id || "",
    targetStore,
    accountId: account.id,
    idempotencyKey: preparation?.idempotencyKey || "",
    normalizedItems: normalized.items,
    sourceSkus: rawItems.map(item => cleanText(item.scraped_sku || item.sku || "", 240)),
    stocks: stockRows,
    directRfbsEvidence,
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

function assertCollectListingTargets(items = []) {
  const missingIndex = items.findIndex((row) =>
    listingNumber(row?.description_category_id) <= 0 || listingNumber(row?.type_id) <= 0);
  if (missingIndex < 0) return;
  throw Object.assign(
    new Error(`第 ${missingIndex + 1} 个变体缺少目标店铺类目，请先完成类目匹配`),
    {
      status: 422,
      code: "COLLECT_TARGET_CATEGORY_REQUIRED",
      body: { variantIndex: missingIndex },
    },
  );
}

async function collectBoxListingRequest(state, req, id, body = {}, { account, dryRun = false, scopedItem = null } = {}) {
  const requestedTargetStoreId = cleanText(body.targetStoreId || body.storeId);
  const replayInput = !dryRun && listingPipelineEnabled()
    ? assertListingPreparationInput({
        accountId: account?.id,
        collectItemId: id,
        targetStoreId: requestedTargetStoreId,
        idempotencyKey: body.idempotencyKey,
      })
    : null;
  const item = String(scopedItem?.id || "") === String(id)
    ? scopedItem
    : cacheItemsForAccount(state, "collectBox", account).find((row) => String(row.id) === String(id));
  if (!item) {
    const err = new Error("采集箱条目不存在");
    err.status = 404;
    err.code = "COLLECT_ITEM_NOT_FOUND";
    throw err;
  }
  let replayItems = null;
  const frozenReplay = replayInput
    ? await findListingPreparationReplayV3(replayInput, {
        validateCollectItem(currentItem) {
          replayItems = buildCollectBoxListingItems({
            ...item,
            listingDraft: currentItem.listingDraft,
          }, requestedTargetStoreId);
          replayItems.forEach(assertOzonListingLogisticsReady);
        },
      })
    : null;
  if (!frozenReplay) {
    resolveLocalListingTarget({
      accountId: account?.id,
      collectItemId: item.id,
      targetStoreId: requestedTargetStoreId,
      idempotencyKey: dryRun ? `preview:${item.id}` : body.idempotencyKey,
      findStore: (storeId) => activeStore(state, storeId, account.id),
    });
  }
  const items = replayItems || buildCollectBoxListingItems(item, requestedTargetStoreId);
  if (!frozenReplay) {
    assertCollectListingTargets(items);
    items.forEach(assertOzonListingReady);
  }
  if (frozenReplay) return publicQueuedListingSubmission(frozenReplay);
  const stocks = listingStockRowsFromDraft(item.listingDraft || {}, item, items);
  const errors = validateCollectBoxListingDraft(item, items, stocks);
  if (errors.length) {
    const err = new Error(errors[0]);
    err.status = 400;
    err.body = { ok: false, errors };
    throw err;
  }
  const warehouses = cacheItemsForAccount(state, "warehouses", account);
  const verifier = createAutoListingRfbsWarehouseVerifier({
    callOzonSellerApi,
    readCredential: ({accountId, targetStoreId}) => readStoreCredentialV3(targetStoreId, accountId),
    loadTarget: ({accountId, targetStoreId, targetWarehouseId}) => {
      const w = warehouses.find(w => String(w.id) === targetWarehouseId
        && String(w.storeId || w.store_id) === targetStoreId
        && String(w.accountId || w.account_id || w.ownerAccountId) === accountId);
      return w ? { ...w, warehouse_id: String(w.warehouse_id),
        ...(w.warehouseId != null ? {warehouseId: String(w.warehouseId)} : {}) } : null;
    },
  });
  const verifiedDirectRfbsEvidence = [];
  await validateCollectListingWarehouses({ warehouses, products: cacheItemsForAccount(state, "products", account),
    targetStoreId: requestedTargetStoreId, accountId: account.id, stocks, verifyRfbsWarehouse: async (input) => {
      const evidence = await verifier.verifyRfbsWarehouse(input);
      verifiedDirectRfbsEvidence.push(evidence);
      return evidence;
    } });
  const payload = {
    ...body,
    storeId: requestedTargetStoreId,
    targetStoreId: requestedTargetStoreId,
    collectBoxId: item.id,
    sku: listingFirstText(item.listingDraft?.sku, item.sku, items[0]?.scraped_sku),
    entry: body.entry || "COLLECT_BOX_DRAFT",
    items,
    stocks,
  };
  if (dryRun) return previewOzonProductImport(state, req, payload, {collectedSource:true});
  if (!listingPipelineEnabled()) {
    const error = new Error("安全上架任务队列当前不可用，请恢复 PostgreSQL 与 LISTING_PIPELINE_V3 后重试");
    error.status = 503;
    error.code = "LISTING_PIPELINE_REQUIRED";
    throw error;
  }
  return queueCollectSubmissionV3(state, req, payload, item, "COLLECT_BOX_DRAFT", {verifiedDirectRfbsEvidence});
}

async function respondCollectBoxListingRoute({req,res,state,account,id,action,body,currentItem=null}) {
  try {
    const result = await collectBoxListingRequest(state, req, id, body, {
      account,
      dryRun: action === "preview",
      scopedItem:currentItem,
    });
    if (action === "submit" && result?.ok) {
      await syncCommittedCollectListingState({result,updateStatus:patch=>updateCollectBoxListingState(id, {
        ...patch,listingSubmittedAt:new Date().toISOString(),
      }, {account,currentItem})});
    }
    sendJson(res, 200, result);
  } catch (error) {
    const errorCode = error?.code || error?.body?.code || "COLLECT_LISTING_FAILED";
    const enrichmentIncomplete = errorCode === "COLLECT_ENRICHMENT_INCOMPLETE";
    const failurePatch = {
      listingLastError: error?.message || (action === "preview" ? "采集箱草稿预检失败" : "采集箱草稿上架失败"),
      listingLastErrorAt: new Date().toISOString(),
    };
    if (action === "submit") {
      failurePatch.status = "失败";
      failurePatch.listingTaskId = "";
      failurePatch.listingJobId = "";
    }
    if (!enrichmentIncomplete && !error?.preserveExistingListing) {
      await updateCollectBoxListingState(id, failurePatch, {account,currentItem}).catch(() => null);
    }
    sendJson(res, error?.status || 502, {
      ok: false,
      code: errorCode,
      message: error?.message || (action === "preview" ? "采集箱草稿预检失败" : "采集箱草稿上架失败"),
      ...(Array.isArray(error?.missingFields) ? { missingFields: error.missingFields } : {}),
      ...(error?.body || {}),
    });
  }
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

export async function handleFastCollectionRoute(req, res, url, {
  categoryEvidencePort,
  pipelineEnabled = listingPipelineEnabled,
  authenticateRequest = collectorAuthRuntime.authenticateRequest,
  authenticateMutationRequest = authenticateCollectionRequest,
  ingestCollectRequest = ingestCollectRequestV4,
  updateCollectItemDraft = updateCollectItemDraftV4,
  readCollectProgress = ({accountId, ids}) => readCollectProgressForAccount({
    accountId, ids,
    readItems: scope => publicCollectBoxItemsForAccount(null, {id:scope.accountId}, accountSharedOzonCategoryRuntime, {ids:scope.ids}),
  }),
  readCollectSummary = async input => readCollectSummaryPage({...input,pool:await getPostgresPool()}),
} = {}) {
  if (typeof categoryEvidencePort?.recordCollectionResult !== "function") {
    throw new TypeError("fast collection category evidence port is required");
  }
  const isCollectProgress = req.method === 'GET' && url.pathname === '/ozon/collect-box/progress';
  if (req.method === 'GET' && url.pathname === '/ozon/collect-box/summary') {
    if (!pipelineEnabled()) return false;
    try {
      const account=await authenticateMutationRequest(req);
      const result=await readCollectSummary({accountId:account.id,limit:url.searchParams.get('limit'),offset:url.searchParams.get('offset'),
        status:url.searchParams.get('status')||'',source:url.searchParams.get('source')||'',variant:url.searchParams.get('variant')||''});
      sendJson(res,200,result);
    } catch(error) {
      const code=error.code||'COLLECT_SUMMARY_READ_FAILED';
      if((error.status||500)>=500)console.error('collect summary read failed',{code});
      sendError(res,error.status||500,error.status&&error.status<500?error.message:'采集列表读取失败，请稍后重试',code);
    }
    return true;
  }
  if (isCollectProgress) {
    try {
      if (!pipelineEnabled()) throw Object.assign(new Error('采集进度读取需要 PostgreSQL'), {status:503,code:'COLLECT_PROGRESS_UNAVAILABLE'});
      const account = await authenticateMutationRequest(req);
      const progress = await readCollectProgress({accountId:account.id, ids:url.searchParams.getAll('ids')});
      sendJson(res,200,progress);
    } catch (error) {
      const code = error.code || (/Connection terminated unexpectedly/i.test(error.message || '')
        ? 'DB_CONNECTION_LOST' : 'COLLECT_PROGRESS_READ_FAILED');
      if ((error.status || 500) >= 500) console.error('collect progress read failed', {code, message:error.message});
      sendError(res,error.status||500,error.status && error.status < 500 ? error.message : '采集进度读取失败，请稍后重试',code);
    }
    return true;
  }
  if (!pipelineEnabled()) return false;
  const skuStatusMatch = req.method === 'GET' && url.pathname.match(/^\/collector\/ozon\/sku-status\/(\d{6,16})$/);
  if(skuStatusMatch){
    try {
      const account=await collectorAuthRuntime.authenticateRequest(req,'collector.ozon.read');
      const existing=await findCollectedSku(await getPostgresPool(),account.id,skuStatusMatch[1]);
      sendJson(res,200,{ok:true,status:existing?.collectionState||'AVAILABLE'});
    } catch(error){sendError(res,error.status||500,'无法查询采集状态',error.code||'COLLECT_STATUS_FAILED');}
    return true;
  }
  const sourceCollectMatch = url.pathname.match(/^\/sources\/([^/]+)\/collect(?:\/batch)?$/);
  const collectRequestMatch = url.pathname.match(/^\/local\/collect-requests\/([^/]+)$/);
  const collectItemMatch = url.pathname.match(/^\/ozon\/collect-box\/([^/]+)$/);
  const isCollectBatchDelete = req.method === "DELETE" && url.pathname === "/ozon/collect-box/batch";
  const isCollectMutation = Boolean(collectItemMatch && ["PATCH", "DELETE"].includes(req.method)) || isCollectBatchDelete;
  if (!sourceCollectMatch && !collectRequestMatch && !isCollectMutation) return false;

  try {
    const account = sourceCollectMatch
      ? await authenticateRequest(req, "collector.upload")
      : collectRequestMatch
        ? await collectorAuthRuntime.authenticateRequest(req, "collector.job.read")
        : await authenticateMutationRequest(req);
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
      const item = await updateCollectItemDraft({
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
      const preparedInputs = preflightCollectRequestsV4({
        authenticatedAccount: account,
        inputs,
        source: sourceId,
      });
      const imported = [];
      const results = [];
      const errors = [];
      for (let index = 0; index < preparedInputs.length; index += 1) {
        const { input } = preparedInputs[index];
        try {
          const result = await ingestCollectRequest({
            authenticatedAccount: account,
            input: { ...input, source: input.source || sourceId },
            categoryEvidencePort,
            logger: console,
          });
          const importedItem = { ...result.item, collectRequestId: result.requestId, duplicate: result.duplicate };
          imported.push(importedItem);
          results.push({
            index,
            sku: input.sourceSku,
            action: result.action || (result.duplicate ? "updated" : "created"),
            collectItemId: result.collectItemId || result.item?.id || "",
            collectRequestId: result.requestId || "",
            ...(result.enrichment ? { enrichment: result.enrichment } : {}),
          });
        } catch (error) {
          if (!isBatch) throw error;
          errors.push({
            index,
            sku: String(input.sourceSku || ""),
            code: error?.code || (error?.status ? `HTTP_${error.status}` : "COLLECT_FAILED"),
            reason: error?.message || "采集失败",
            ...(Array.isArray(error?.missingFields) ? { missingFields: [...error.missingFields] } : {}),
          });
        }
      }
      sendJson(res, 200, isBatch
        ? { ok: errors.length === 0, imported: imported.length, data: imported, results, errors }
        : {
            ok: true,
            duplicate: Boolean(imported[0]?.duplicate),
            data: imported[0] || null,
            requestId: imported[0]?.collectRequestId || "",
            ...(imported[0]?.enrichment ? { enrichment: imported[0].enrichment } : {}),
          });
      return true;
    }
  } catch (error) {
    sendError(
      res,
      error?.status || 500,
      error?.message || "采集请求处理失败",
      error?.code || "COLLECT_REQUEST_FAILED",
      error?.missingFields?.length ? { missingFields: error.missingFields } : undefined,
    );
    return true;
  }
  return false;
}

const handleCollectorHttpRoute = createCollectorHttpHandler({
  ozonRouteService:accountOzonRouteService,
  authenticate: collectorAuthRuntime.authenticateRequest,
  readAccountCounts: async (accountId) => {
    if (persistenceMode() === 'postgres') {
      return readCollectorAccountCounts({ pool: await getPostgresPool(), accountId });
    }
    const state = await loadState();
    const account = { id: accountId };
    const stores = storesForAccount(state, accountId);
    const products = cacheItemsForAccount(state, 'products', account);
    return {
      collect: cacheItemsForAccount(state, 'collectBox', account).length,
      products: new Set(stores.flatMap(store => cacheItemsForStore(products, store))).size,
    };
  },
  readJson: readBody,
  sendJson,
});

export function createHttpHandler({
  composition = defaultAccountSharedOzonCategoryComposition,
  categoryResolutionReadPort = composition?.accountSharedOzonCategoryRuntime,
  categoryService = ozonCategoryService,
} = {}) {
  // Legacy full responses can exceed 70 MB. Build one at a time; page and
  // bootstrap reads remain independent so task polling stays responsive.
  let fullStateReadFinished = Promise.resolve();
  if (
    typeof composition?.collectorOzonEnrichmentRuntime?.handleHttpRoute !== "function"
    || typeof composition?.handleJsonAccountScopedCollectionRoute !== "function"
    || typeof composition?.handleCategoryConfirmationRoute !== "function"
    || typeof categoryResolutionReadPort?.readForItems !== "function"
  ) {
    throw new TypeError("server category auto-resolution HTTP composition is required");
  }
  const handlePostgresOzonCategoryRoute = createOzonCategoryRouteHandler({
    categoryService,
    resolveContext: resolvePostgresOzonCategoryContext,
    sendJson,
    sendError,
    reportError: (diagnostic) => console.warn("[ozon-category]", diagnostic),
  });
  const handleWebCollectionRoute = createOzonWebCollectionHttpHandler({
    service: createOzonWebCollectionService({ categoryEvidencePort: composition.accountSharedOzonCategoryRuntime }),
    authenticateWeb: async (request) => {
      if (persistenceMode() !== 'postgres') throw Object.assign(new Error('网页采集需要数据库服务'), { status: 503 });
      return authenticateCollectionRequest(request);
    },
    authenticateCollector: collectorAuthRuntime.authenticateSessionRequest,
    readJson: readBody,
    sendJson,
  });
  return async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if(req.method==='GET'&&['/local/state','/ozon/collect-box/summary','/ozon/collect-box/progress','/ai-listing/tasks'].includes(url.pathname)){
    res.pipelineRead={route:url.pathname,startedAt:performance.now()};
  }
  if (handleRemovedDataCollectionStoreRoute(req, res, url, { sendJson })) return;
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (handleRetiredSecondaryOperation(req, res, url)) return;
  if (await handleHealthRoute(req, res, url, {
    sendJson, dataFile, persistenceMode, persistenceHealth, objectStorageHealth, objectStorageInfo,
    listingPipelineHealth, listingPipelineEnabled,
  })) return;

  if (handleRetiredExtensionSyncRoute(req, res, url, { sendJson })) return;
  if (await handleAccountOzonRoute(req,res)) return;
  if (await collectorAuthRuntime.handleHttpRoute(req, res, url)) return;
  if (await handleWebCollectionRoute(req, res, url)) return;
  if (await composition.handleCategoryConfirmationRoute(req, res, url)) return;
  if (await composition.collectorOzonEnrichmentRuntime.handleHttpRoute(req, res, url)) return;
  if (await dashboardRuntime.handleRoute(req, res, url)) return;
  if (await aiListingRuntime.handleRoute(req, res, url)) return;
  if (await messageRuntime.handleRoute(req, res, url)) return;
  if (await promotionRuntime.handleRoute(req, res, url)) return;
  if (await stockRuntime.handleRoute(req, res, url)) return;
  if (await orderManagementRuntime.handleRoute(req, res, url)) return;
  if (await orderInspectionRuntime.handleRoute(req, res, url)) return;
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
  if (await handleFastCollectionRoute(req, res, url, {
    categoryEvidencePort: composition.accountSharedOzonCategoryRuntime,
    readCollectSummary:async input=>readCollectSummaryPage({...input,pool:await getPostgresPool(),readCategories:scope=>categoryResolutionReadPort.readForItems(scope)}),
    readCollectProgress: ({accountId, ids}) => readCollectProgressForAccount({
      accountId, ids,
      readItems: scope => publicCollectBoxItemsForAccount(null, {id:scope.accountId}, categoryResolutionReadPort, {ids:scope.ids}),
    }),
  })) return;
  if (persistenceMode()==='postgres' && req.method==='GET' && ['/local/state','/ozon/products/cache','/ozon/products/cache/status-counts'].includes(url.pathname)) {
    let account;
    try {account=await authenticateCollectionRequest(req);}
    catch(error){if(url.pathname!=='/local/state'||![401,403].includes(error.status))throw error;sendJson(res,200,limitedLocalStatePayload(defaultState()));return;}
    if(url.pathname==='/ozon/products/cache'&&url.searchParams.get('view')==='page'){
      const storeId=url.searchParams.get('storeId')||req.headers['x-ozon-store-id']||'';
      sendJson(res,200,await readProductCatalogPage({pool:await getPostgresPool(),accountId:account.id,storeId,options:productPageOptions(url.searchParams)}));return;
    }
    const statePlan=localStateRequestPlan(url.searchParams);
    const {bootstrap}=statePlan;
    let releaseFullStateRead;
    if(url.pathname==='/local/state' && statePlan.includeFullCollection){
      const previous=fullStateReadFinished;
      fullStateReadFinished=new Promise(resolve=>{releaseFullStateRead=resolve;});
      await previous;
    }
    try {
    const state=await readLocalStateForAccount({pool:await getPostgresPool(),accountId:account.id,bootstrap,
      storeId:url.pathname==='/local/state'?null:url.searchParams.get('storeId')||req.headers['x-ozon-store-id']||null});
    if(url.pathname==='/local/state'){
      if(statePlan.includeSubmissionJobs && listingPipelineEnabled())for(const job of await listSubmissionJobsV3({accountId:account.id,storeId:state.currentStoreId,limit:500}))state.jobs[job.id]=job;
      const payload=localStatePayload(state,{account:state.accounts?.[0]||account,token:bearerToken(req)});
      if(statePlan.includeFullCollection)payload.caches.collectBox=await publicCollectBoxItemsForAccount(state,account,categoryResolutionReadPort);
      else payload.caches.collectBox=[];
      if(statePlan.collectIds.length){
        const ids=statePlan.collectIds;
        if(ids.length>100||ids.some(id=>!id||id.length>500))throw Object.assign(new Error('请选择最多100件采集商品'),{status:400});
        payload.caches.collectBox=await publicCollectBoxItemsForAccount(state,account,categoryResolutionReadPort,{ids});
      }
      if(!statePlan.includeSubmissionJobs)payload.jobs={};
      payload.summary={...payload.summary,...state.summaryCounts,...(statePlan.includeFullCollection?{collectBox:payload.caches.collectBox.length}:{})};
      sendJson(res,200,payload);
    }else if(url.pathname.endsWith('status-counts'))sendJson(res,200,{ALL:state.summaryCounts.products,total:state.summaryCounts.products,storeId:state.currentStoreId});
    else sendJson(res,200,{data:state.caches.products,total:state.summaryCounts.products,storeId:state.currentStoreId});
    } finally { releaseFullStateRead?.(); }
    return;
  }
  if(req.method==='GET' && url.pathname==='/extension/latest'){
    const {version}=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
    sendJson(res,200,{version,latestVersion:version,downloadUrl:`/ozon 粽子-扩展-v${version}.zip`});return;
  }
  if (req.method === "GET" && url.pathname === "/feature-flags/me") {
    sendJson(res, 200, {
      ozon_fleet_serverside: false,
      ozon_public_import: false,
      localClone: true,
    });
    return;
  }
  if (persistenceMode() === "postgres"
    && await handlePostgresOzonCategoryRoute({req, res, url})) return;
  const scopedCollectListingMatch = url.pathname.match(/^\/ozon\/collect-box\/([^/]+)\/listing\/(preview|submit)$/);
  if (persistenceMode() === "postgres" && req.method === "POST" && scopedCollectListingMatch) {
    const account = await authenticateCollectionRequest(req);
    const id = decodeURIComponent(scopedCollectListingMatch[1]);
    const action = scopedCollectListingMatch[2];
    const body = await readBody(req);
    const targetStoreId = cleanText(body.targetStoreId || body.storeId);
    const state = await readLocalStateForAccount({
      pool:await getPostgresPool(),
      accountId:account.id,
      bootstrap:false,
      storeId:targetStoreId || null,
    });
    let item = (await listCollectItemsV3({accountId:account.id,ids:[id],limit:1}))[0] || null;
    if (item && targetStoreId) {
      const shared = await accountSharedOzonCategoryRuntime.readForItems({
        accountId:account.id,
        collectItemIds:[id],
      });
      const resolution = shared.find(entry=>String(entry?.collectItemId || "") === String(id))?.categoryResolution;
      item = applyAccountSharedListingCategory(item,resolution,targetStoreId);
    }
    state.accounts = [{...(state.accounts?.[0] || {}),...account,status:"active"}];
    state.currentAccountId = account.id;
    state.token = bearerToken(req);
    state.sessions = {[state.token]:{accountId:account.id}};
    state.caches.collectBox = item ? [item] : [];
    await respondCollectBoxListingRoute({req,res,state,account,id,action,body,currentItem:item});
    return;
  }
  return jsonStateTransaction.run(async () => {
  // JSON keeps its historical whole-state behavior. PostgreSQL materializes the
  // relational catalog only for handlers that explicitly own catalog work.
  const hydrateLegacyCatalog = persistenceMode() !== "postgres"
    || legacyRouteNeedsCatalogHydration(req, url);
  let state = await loadState({ hydrateCatalog: hydrateLegacyCatalog });
  if (await handleCollectorPricingRoute(req, res, url, {
    requireAuth,
    readBody,
    sendJson,
    state,
    resolveStoreId: (storeId, { account }) => storeIdForAccountRequest(state, account, storeId),
    resolveTask: (taskId, { account }) => getCollectorTaskForAccount(account.id, taskId),
  })) return;

  if (req.method === "GET" && url.pathname === "/local/state") {
    const token = bearerToken(req);
    const account = optionalAuth(req, state);
    const payload = localStatePayload(state, {
      authenticated: Boolean(account),
      account,
      token,
      includeAccounts: false,
    });
    if (account) {
      payload.caches.collectBox = await publicCollectBoxItemsForAccount(
        state,
        account,
        categoryResolutionReadPort,
      );
    }
    sendJson(res, 200, payload);
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
    const postgresLogin = persistenceMode() === "postgres";
    const bootstrapLogin = postgresLogin && url.searchParams.get("view") === "bootstrap";
    // The existing Web login consumes this response directly, including on a
    // product/collect edit page. Release the write snapshot, then read only this
    // account's current view instead of returning the compatibility catalog.
    if (postgresLogin) state = null;
    const loginState = postgresLogin
      ? await readLocalStateForAccount({ pool: await getPostgresPool(), accountId: account.id, bootstrap: bootstrapLogin })
      : state;
    if (postgresLogin && !bootstrapLogin && listingPipelineEnabled()) {
      for (const job of await listSubmissionJobsV3({ accountId: account.id, storeId: loginState.currentStoreId, limit: 500 })) {
        loginState.jobs[job.id] = job;
      }
    }
    const payload = localStatePayload(loginState, {
      authenticated: true,
      account,
      token,
      includeAccounts: false,
    });
    if (postgresLogin && !bootstrapLogin) {
      payload.caches.collectBox = await publicCollectBoxItemsForAccount(loginState, account, categoryResolutionReadPort);
    }
    if (postgresLogin) payload.summary = {
      ...payload.summary,
      ...loginState.summaryCounts,
      ...(!bootstrapLogin ? { collectBox: payload.caches.collectBox.length } : {}),
    };
    sendJson(res, 200, {
      ok: true,
      token,
      account: publicAccount(account),
      state: payload,
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
    let account = state.accounts.find((item) => item.id === accountId);
    if (!account) {
      sendError(res, 404, "账号不存在");
      return;
    }
    const body = await readBody(req);
    const previousAccount = structuredClone(account);
    const nextAccount = structuredClone(account);
    if (body.displayName !== undefined) nextAccount.displayName = String(body.displayName || nextAccount.username).trim();
    if (body.role !== undefined) nextAccount.role = body.role === "admin" ? "admin" : "user";
    if (body.status !== undefined) nextAccount.status = body.status === "disabled" ? "disabled" : "active";
    if (body.expiresAt !== undefined) nextAccount.expiresAt = normalizeAccountExpiresAt(body.expiresAt);
    const passwordChanged = Boolean(body.password);
    if (passwordChanged) Object.assign(nextAccount, createPasswordHash(body.password));
    if (nextAccount.id === admin.id && nextAccount.status === "disabled") {
      sendError(res, 400, "不能停用当前登录的管理员账号");
      return;
    }
    if (nextAccount.id === admin.id && nextAccount.role !== "admin") {
      sendError(res, 400, "不能取消当前登录账号的管理员权限");
      return;
    }
    const accountRecovered = (
      (previousAccount.status === "disabled" || isAccountExpired(previousAccount))
      && nextAccount.status === "active"
      && !isAccountExpired(nextAccount)
    );
    if (accountRecovered) {
      const recoveryReason = collectorAccountChangeReason({
        passwordChanged,
        accountExpired: isAccountExpired(previousAccount),
      });
      await collectorAuthRuntime.revokeAccountSessions({
        parentSessionTokens: collectorParentSessionTokens(state, accountId),
        accountId,
        reason: recoveryReason,
        state,
      });
      state = await loadState({ hydrateCatalog: false });
      account = state.accounts.find((item) => item.id === accountId);
      if (!account) {
        sendError(res, 404, "账号不存在");
        return;
      }
      revokeAccountSessions(state, accountId);
    }
    Object.assign(account, nextAccount);
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
        sessionsRevoked: sessionsMustBeRevoked || accountRecovered,
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
    const deletionAt = new Date().toISOString();
    const deletion = removeAccountScope(state, accountId, {
      actor: { type: "account", id: admin.id },
      reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
      occurredAt: deletionAt,
    });
    appendRequestAudit(state, req, admin, {
      action: "ACCOUNT_DELETED",
      entityType: "account",
      entityId: accountId,
      metadata: {
        deletedStoreIds: deletion.storeIds,
        deletedStoreCount: deletion.storeIds.length,
        deletedFileCount: deletion.fileObjectKeys.length,
        legacyArchivePurgedCount: deletion.legacyArchivePurgedCount,
        deletedCollectorAuthTicketCount: deletion.deletedCollectorAuthTicketCount,
        deletedCollectorSessionCount: deletion.deletedCollectorSessionCount,
        deletedCollectorOzonEnrichmentCacheCount:
          deletion.deletedCollectorOzonEnrichmentCacheCount,
        deletedCollectorOzonEnrichmentJobCount:
          deletion.deletedCollectorOzonEnrichmentJobCount,
        deletedCollectOzonCategorySourceEvidenceCount:
          deletion.deletedAccountSharedCategoryRecordCounts
            ?.collectOzonCategorySourceEvidence || 0,
        deletedAccountOzonSharedCategoryCount:
          deletion.deletedAccountSharedCategoryRecordCounts
            ?.accountOzonSharedCategories || 0,
        deletedAccountOzonSharedCategoryEventCount:
          deletion.deletedAccountSharedCategoryRecordCounts
            ?.accountOzonSharedCategoryEvents || 0,
        deletedAccountOzonCategoryConfirmationCount:
          deletion.deletedAccountSharedCategoryRecordCounts
            ?.accountOzonCategoryConfirmations || 0,
        deletedCollectOzonCategoryLookupEvidenceCount:
          deletion.deletedAccountSharedCategoryRecordCounts
            ?.collectOzonCategoryLookupEvidence || 0,
        deletedCollectOzonCategoryCurrentSourceCount:
          deletion.deletedAccountSharedCategoryRecordCounts
            ?.collectOzonCategoryCurrentSources || 0,
        deletedCollectOzonCategoryManualConfirmationEvidenceCount:
          deletion.deletedAccountSharedCategoryRecordCounts
            ?.collectOzonCategoryManualConfirmationEvidence || 0,
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
    const keyChanged=existing?.apiKey!==apiKey;
    const apiKeyExpiresAt = normalizeDateOnly(body.apiKeyExpiresAt ?? (keyChanged?'':existing?.apiKeyExpiresAt));
    const store = {
      ...(existing || {}),
      id,
      storeId: id,
      ownerAccountId: account.id,
      ozonRoute:(await accountOzonRouteService.read(account.id)).route,
      label: storeName,
      companyName: storeName,
      legalName: storeName,
      clientId,
      apiKey,
      apiKeyCreatedAt,
      apiKeyExpiresAt,
      ...(keyChanged?{apiKeyExpiryCheckedAt:'',apiKeyExpirySource:''}:{}),
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

  if (req.method === "POST" && url.pathname === "/local/stores/refresh-profile") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const storeId = String(body.storeId || "").trim();
    const result = await ozonSyncService.refreshStoreProfiles(state, {
      accountId: account.id,
      storeId,
    });
    sendJson(res, 200, { ok: true, ...result, state: localStatePayload(await loadState({ hydrateCatalog: hydrateLegacyCatalog }), { account, token: bearerToken(req) }) });
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
      if(nextApiKey!==store.apiKey){
        if(!Object.hasOwn(body,'apiKeyExpiresAt'))store.apiKeyExpiresAt='';
        store.apiKeyExpiryCheckedAt='';store.apiKeyExpirySource='';
      }
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
    try {
      const report = await ozonSyncService.runLocalSync(state, {
        accountId: account.id,
        storeId: body.storeId || currentStoreIdForAccount(state, account.id),
        type: localSyncMatch[1], jobId: body.jobId, requestId: body.requestId,
        deviceId: String(req.headers["x-device-fingerprint"] || body.deviceId || "").trim(),
        source: req.headers["x-device-fingerprint"] ? "extension" : "web",
      });
      sendJson(res, 200, { ok: true, job: report, state: localStatePayload(await loadState({ hydrateCatalog: hydrateLegacyCatalog }), { account, token: bearerToken(req) }) });
    } catch (error) {
      const failure = ozonSyncService.publicSyncErrorResponse(error);
      sendJson(res, failure.status, failure.body);
    }
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
    if(url.searchParams.get('view')==='page')sendJson(res,200,{...productCatalogPage(products,productPageOptions(url.searchParams)),storeId});
    else sendJson(res, 200, { data: products, total: products.length, storeId });
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
    const sku = String(body.sku || body.skuId || "").trim();
    if (!sku) {
      sendError(res, 400, "SKU 不能为空");
      return;
    }
    try {
      const result = await ozonSkuCollectionService.collectOzonSkuForAccount({ account, sku });
      sendJson(res, 200, {
        ok: true,
        data: publicPersistedCollectionItem(result.item),
        scraped: result.scraped,
        duplicate: result.duplicate === true,
        ...(result.scraped || result.duplicate ? {} : { error: "未能从 ozon.ru 抓取到商品数据" }),
      });
    } catch (error) {
      if (error?.code === "ZONGZI_SKU_SCRAPE_EMPTY") {
        sendError(res, 503, "未能抓取到商品资料，本次未新增或覆盖商品。请使用采集助手链接采集；如已有同 SKU 失败记录，请先留存手工资料并删除旧失败记录，再重新采集、发送。", error.code);
        return;
      }
      sendError(res, 500, "抓取失败，请稍后重试", "ZONGZI_SKU_COLLECTION_FAILED");
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
      emptyPage(url, await publicCollectBoxItemsForAccount(
        state,
        account,
        categoryResolutionReadPort,
      )),
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/ozon/collect-box") {
    const account = requireAuth(req, state);
    const body = await readBody(req);
    const sku = String(body.sku || "").trim();
    const isUrl = /^https?:\/\//i.test(String(body.productUrl || body.url || body.name || ""));
    const existing = listingPipelineEnabled() && sku ? await findCollectedSku(await getPostgresPool(),account.id,sku) : null;
    if(existing) { sendJson(res,200,{ok:true,item:existing,data:existing,duplicate:true,action:"skipped"});return; }
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
          const saved = await saveCollectBoxItemAtomic(item, { account });
          sendJson(res, 200, publicPersistedCollectionItem(saved.item));
          return;
        }
      } catch (e) {
        // 抓取失败，继续创建普通条目
      }
    }
    const item = normalizeCollectItem(body);
    const saved = await saveCollectBoxItemAtomic(item, { account });
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
    await respondCollectBoxListingRoute({req,res,state,account,id,action,body});
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
    const imported = items.map((raw) => normalizeCollectItem(raw));
    const saved = await saveCollectBoxBatchAtomic(imported, { account });
    sendJson(res, 200, {
      ok: true,
      imported: saved.items.length,
      data: saved.items.map(publicPersistedCollectionItem),
      total: cacheItemsForAccount(saved.state, "collectBox", account).length,
    });
    return;
  }

  if (await composition.handleJsonAccountScopedCollectionRoute(req, res, url, state)) return;

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

  sendError(res, 404, `未实现的本地接口: ${req.method} ${url.pathname}`, "LOCAL_NOT_FOUND");
  });
  };
}

export function localStateRequestPlan(searchParams) {
  const view=searchParams.get('view');
  const bootstrap=view==='bootstrap';
  const products=view==='products';
  return {
    bootstrap,
    includeFullCollection:!bootstrap&&!products,
    includeSubmissionJobs:!bootstrap&&!products,
    collectIds:bootstrap&&searchParams.has('collectIds')?[...new Set(searchParams.getAll('collectIds'))]:[],
  };
}

const handle = createHttpHandler();

export const testExports = {
  activeStore,
  applyAccountSharedListingCategory,
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
  previewOzonProductImport,
  readBody,
  resolveAutoListingExcelSourceCategory,
  resolvePreviewCategoryMatchPolicy,
  syncCommittedCollectListingState,
};

export { handle };

const server = http.createServer((req, res) => {
  if (lifecycle.stopping) {
    sendJson(res, 503, { ok: false, code: "API_STOPPING", message: "服务正在停止，请稍后重试" }, { Connection: "close" });
    return;
  }
  void lifecycle.trackRequest(() => handle(req, res).catch((error) => {
    const status = Number(error?.status || 500);
    sendError(res, status, error?.message || "本地服务异常");
  }));
});

let enrichmentRepairTimer, enrichmentRepairActive, stopObjectCleanup;
let enrichmentRepairCursor = "";
async function scheduleEnrichmentRepair() {
  if (lifecycle.stopping) return;
  try {
    enrichmentRepairActive = reconcileCollectEnrichment({afterId:enrichmentRepairCursor,enqueueMissing:true});
    const result = await enrichmentRepairActive;
    enrichmentRepairCursor=result.afterId;
  } catch { console.error("[collect-enrichment] recovery failed; will retry"); }
  finally { enrichmentRepairActive = null; }
  if (!lifecycle.stopping && server.listening) enrichmentRepairTimer=setTimeout(scheduleEnrichmentRepair,60_000);
}
const lifecycle = createApiLifecycle({
  server,
  signals: process.env.QH_LOCAL_NO_LISTEN === "1" ? { on() {} } : process,
  stopScheduling() {
    clearTimeout(enrichmentRepairTimer);
    clearTimeout(collectorHandoffStartTimer);
    clearTimeout(importStatusPollTimer);
    importStatusPollTimer = null;
  },
  async drainBackground() {
    const results = await Promise.allSettled([
      stopObjectCleanup?.(),
      collectorHandoffWorker?.stop(),
      collectorHandoffStarting,
      importStatusPollActive,
      enrichmentRepairActive,
    ]);
    if (results.some(result => result.status === "rejected")) throw new Error("API background drain failed");
  },
  closeResources: closePostgresPool,
});

if (process.env.QH_LOCAL_NO_LISTEN !== "1") {
  server.listen(port, listenHost, () => {
    if (lifecycle.stopping) return;
    console.log(`QH local API listening on http://${listenHost}:${port}`);
    scheduleImportStatusPolling(1000);
    stopObjectCleanup = objectCleanupWorker.start();
    if (listingPipelineEnabled()) void lifecycle.start(messageRuntime).catch(() => {
      console.error("[messages] worker failed to start");
    });
    if (listingPipelineEnabled()) void lifecycle.start(orderManagementRuntime).catch(() => {
      console.error("[order-management] worker failed to start");
    });
    if (listingPipelineEnabled()) void lifecycle.start(orderInspectionRuntime).catch(() => {
      console.error("[order-inspection] coordinator failed to start");
    });
    if (listingPipelineEnabled()) void lifecycle.start(stockRuntime).catch(() => {
      console.error("[stocks] worker failed to start");
    });
    if (listingPipelineEnabled()) void lifecycle.start(promotionRuntime).catch(() => {
      console.error("[promotions] worker failed to start");
    });
    if (listingPipelineEnabled()) enrichmentRepairTimer=setTimeout(scheduleEnrichmentRepair,5000);
    if (listingPipelineEnabled()) void scheduleCollectorHandoffStart();
    if (listingPipelineEnabled()) void lifecycle.start(aiListingRuntime, { mode: "prepare" }).catch(() => {
      console.error("[ai-listing] worker failed to start");
    });
  });
}

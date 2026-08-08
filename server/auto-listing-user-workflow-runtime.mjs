import { autoListingEnabled, autoListingExcelImportLimits } from "./runtime-config.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { createPostgresAutoListingImportCleanupRepository } from "./auto-listing-import-cleanup-postgres.mjs";
import { createAutoListingImportCleanupWorker } from "./auto-listing-import-cleanup-worker.mjs";
import { createPostgresAutoListingImportRepository } from "./auto-listing-import-postgres.mjs";
import { createAutoListingImportService } from "./auto-listing-import-service.mjs";
import { parseAutoListingSkuWorkbook } from "./auto-listing-excel-import.mjs";
import { createPostgresAutoListingPreferencesRepository } from "./auto-listing-preferences-postgres.mjs";
import { createAutoListingUserWorkflowService } from "./auto-listing-user-workflow-service.mjs";
import { createAutoListingWorkbookStore } from "./auto-listing-workbook-store.mjs";
import { createPostgresAutoListingSourceOutboxRepository } from "./auto-listing-source-outbox-postgres.mjs";
import { createAutoListingSourceWorker } from "./auto-listing-source-worker.mjs";
import { createPostgresAutoListingImportFinalizationRepository } from "./auto-listing-import-finalization-postgres.mjs";
import { createAutoListingImportFinalizer } from "./auto-listing-import-finalizer.mjs";
import { createPostgresAutoListingImportRecoveryRepository } from "./auto-listing-import-recovery-postgres.mjs";
import { createAutoListingImportRecoveryService } from "./auto-listing-import-recovery-service.mjs";

function runtimeError(code, status, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_USER_DISABLED"
    ? "自动上架功能尚未启用" : "自动上架用户服务暂时不可用");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function safeLog(logger, code, event = "auto_listing.import_cleanup_failed") {
  if (typeof logger?.error !== "function") return;
  try {
    const pending = logger.error(event, { code });
    if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
  } catch { /* best effort */ }
}

export function createAutoListingUserWorkflowRuntime({
  env = process.env,
  getPostgresPool: resolvePool = getPostgresPool,
  createCleanupRepository = createPostgresAutoListingImportCleanupRepository,
  createImportRepository = createPostgresAutoListingImportRepository,
  createPreferencesRepository = createPostgresAutoListingPreferencesRepository,
  createWorkbookStore = createAutoListingWorkbookStore,
  createImportService = createAutoListingImportService,
  createRecoveryRepository = createPostgresAutoListingImportRecoveryRepository,
  createRecoveryService = createAutoListingImportRecoveryService,
  createService = createAutoListingUserWorkflowService,
  createCleanupWorker = createAutoListingImportCleanupWorker,
  createSourceRepository = createPostgresAutoListingSourceOutboxRepository,
  createSourceWorker = createAutoListingSourceWorker,
  createFinalizationRepository = createPostgresAutoListingImportFinalizationRepository,
  createFinalizer = createAutoListingImportFinalizer,
  collectSku = null,
  getAutoListingService = null,
  parseWorkbook = parseAutoListingSkuWorkbook,
  logger = null,
  cleanupIntervalMs = 60_000,
  workflowIntervalMs = 30_000,
} = {}) {
  const factories = [resolvePool, createCleanupRepository, createImportRepository, createPreferencesRepository,
    createWorkbookStore, createImportService, createRecoveryRepository, createRecoveryService,
    createService, createCleanupWorker, createSourceRepository,
    createSourceWorker, createFinalizationRepository, createFinalizer, parseWorkbook];
  if (!env || typeof env !== "object" || Array.isArray(env) || factories.some((factory) => typeof factory !== "function")
    || (collectSku !== null && typeof collectSku !== "function")
    || (getAutoListingService !== null && typeof getAutoListingService !== "function")
    || !Number.isInteger(cleanupIntervalMs) || cleanupIntervalMs < 5_000 || cleanupIntervalMs > 3_600_000
    || !Number.isInteger(workflowIntervalMs) || workflowIntervalMs < 5_000 || workflowIntervalMs > 3_600_000) {
    throw new TypeError("Auto-listing user workflow runtime dependencies are required");
  }
  let dependenciesPromise = null;
  let cleanupTimer = null;
  let cleanupRun = null;
  let workflowTimer = null;
  let workflowRun = null;
  const limits = autoListingExcelImportLimits(env);

  function dependencies() {
    if (!autoListingEnabled(env)) return Promise.reject(runtimeError("AUTO_LISTING_USER_DISABLED", 404));
    if (!dependenciesPromise) {
      const initialization = Promise.resolve().then(async () => {
        let pool;
        try { pool = await resolvePool(); } catch {
          throw runtimeError("AUTO_LISTING_USER_INITIALIZATION_FAILED", 503, true);
        }
        if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
          throw runtimeError("AUTO_LISTING_USER_INITIALIZATION_FAILED", 503, true);
        }
        try {
          const cleanupRepository = createCleanupRepository({ pool });
          const importRepository = createImportRepository({ pool, cleanupRepository, maxRows: limits.maxRows });
          const preferencesRepository = createPreferencesRepository({ pool });
          const workbookStore = createWorkbookStore({ maxBytes: limits.maxBytes });
          const importService = createImportService({
            parseWorkbook, repository: importRepository, workbookStore,
            maxBytes: limits.maxBytes, maxRows: limits.maxRows,
          });
          const recoveryRepository = createRecoveryRepository({ pool });
          const recoveryService = createRecoveryService({ repository: recoveryRepository });
          const service = createService({
            preferencesRepository, importRepository, importService, recoveryService, limits,
          });
          const cleanupWorker = createCleanupWorker({ repository: cleanupRepository, workbookStore, logger });
          if (typeof collectSku !== "function" || typeof getAutoListingService !== "function") {
            throw new Error("missing source workflow ports");
          }
          const sourceRepository = createSourceRepository({ pool });
          const finalizationRepository = createFinalizationRepository({ pool });
          const sourceWorker = createSourceWorker({
            workerId: `auto-listing-source-${process.pid}`,
            repository: sourceRepository,
            collectSku,
          });
          const finalizer = createFinalizer({
            repository: finalizationRepository,
            createExcelJob: async (input) => {
              const autoListingService = await getAutoListingService();
              if (typeof autoListingService?.createExcelAutoListingJob !== "function") {
                throw new Error("invalid auto-listing service");
              }
              return autoListingService.createExcelAutoListingJob(input);
            },
            logger,
          });
          if (!service || typeof service !== "object" || typeof cleanupWorker?.runOnce !== "function"
            || typeof sourceRepository?.listRunnableAccountIds !== "function"
            || typeof finalizationRepository?.listFinalizableAccountIds !== "function"
            || typeof sourceWorker?.processAccount !== "function"
            || typeof finalizer?.finalizeAccount !== "function") {
            throw new Error("invalid runtime shape");
          }
          return Object.freeze({
            service, cleanupWorker, sourceRepository, finalizationRepository, sourceWorker, finalizer,
          });
        } catch (error) {
          if (error?.code === "AUTO_LISTING_USER_INITIALIZATION_FAILED") throw error;
          throw runtimeError("AUTO_LISTING_USER_INITIALIZATION_FAILED", 503, true);
        }
      });
      dependenciesPromise = initialization;
      initialization.catch(() => {
        if (dependenciesPromise === initialization) dependenciesPromise = null;
      });
    }
    return dependenciesPromise;
  }

  async function runCleanup() {
    if (cleanupRun) return cleanupRun;
    cleanupRun = dependencies().then(({ cleanupWorker }) => cleanupWorker.runOnce()).catch((error) => {
      safeLog(logger, typeof error?.code === "string" ? error.code : "AUTO_LISTING_IMPORT_CLEANUP_WORKER_FAILED");
      return null;
    }).finally(() => { cleanupRun = null; });
    return cleanupRun;
  }

  async function runWorkflow() {
    if (workflowRun) return workflowRun;
    workflowRun = dependencies().then(async ({
      sourceRepository, finalizationRepository, sourceWorker, finalizer,
    }) => {
      const [sourceAccounts, finalizationAccounts] = await Promise.all([
        sourceRepository.listRunnableAccountIds({ cursor: null, limit: 100 }),
        finalizationRepository.listFinalizableAccountIds({ cursor: null, limit: 100 }),
      ]);
      const sourceSet = new Set(sourceAccounts);
      const accounts = [...new Set([...sourceAccounts, ...finalizationAccounts])].sort();
      for (const accountId of accounts) {
        if (sourceSet.has(accountId)) {
          try { await sourceWorker.processAccount({ accountId, limit: 10 }); } catch (error) {
            safeLog(logger, typeof error?.code === "string" ? error.code : "AUTO_LISTING_SOURCE_WORKER_FAILED",
              "auto_listing.source_worker_failed");
          }
        }
        try { await finalizer.finalizeAccount({ accountId, limit: 20 }); } catch (error) {
          safeLog(logger, typeof error?.code === "string" ? error.code : "AUTO_LISTING_IMPORT_FINALIZATION_FAILED",
            "auto_listing.import_finalization_failed");
        }
      }
      return true;
    }).catch((error) => {
      safeLog(logger, typeof error?.code === "string" ? error.code : "AUTO_LISTING_SOURCE_WORKFLOW_FAILED",
        "auto_listing.source_workflow_failed");
      return null;
    }).finally(() => { workflowRun = null; });
    return workflowRun;
  }

  async function startCleanupWorker() {
    if (!autoListingEnabled(env)) return false;
    if (cleanupTimer) return true;
    await runCleanup();
    cleanupTimer = setInterval(() => { void runCleanup(); }, cleanupIntervalMs);
    cleanupTimer?.unref?.();
    return true;
  }

  async function stopCleanupWorker() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
    if (cleanupRun) await cleanupRun;
  }

  async function startWorkers() {
    if (!autoListingEnabled(env)) return false;
    await startCleanupWorker();
    if (workflowTimer) return true;
    await runWorkflow();
    workflowTimer = setInterval(() => { void runWorkflow(); }, workflowIntervalMs);
    workflowTimer?.unref?.();
    return true;
  }

  async function stopWorkers() {
    if (workflowTimer) clearInterval(workflowTimer);
    workflowTimer = null;
    if (workflowRun) await workflowRun;
    await stopCleanupWorker();
  }

  return Object.freeze({
    async getService() {
      return (await dependencies()).service;
    },
    startCleanupWorker,
    stopCleanupWorker,
    startWorkers,
    stopWorkers,
  });
}

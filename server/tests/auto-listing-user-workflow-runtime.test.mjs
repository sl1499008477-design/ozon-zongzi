import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingUserWorkflowRuntime } from "../auto-listing-user-workflow-runtime.mjs";

function harness({ enabled = true } = {}) {
  const calls = [];
  const pool = { async query() {}, async connect() {} };
  const cleanupRepository = { enqueueObjectCleanup() {}, listRunnableCleanupAccountIds() {}, claimObjectCleanup() {},
    prepareObjectCleanup() {}, completeObjectCleanup() {}, failObjectCleanup() {} };
  const importRepository = { listImports() {}, findImportByIdempotency() {}, createImportWithRows() {}, enqueueObjectCleanup() {} };
  const preferencesRepository = { getPreferences() {}, savePreferences() {} };
  const workbookStore = { putWorkbook() {}, readWorkbook() {}, removeWorkbook() {} };
  const importService = { createExcelImport() {} };
  const recoveryRepository = { getImportDetail() {}, retryFailedRows() {} };
  const recoveryService = { getImportDetail() {}, retryImport() {} };
  const service = { marker: "service" };
  const cleanupWorker = { async runOnce() { calls.push(["run-cleanup"]); return { completed: 0 }; } };
  const sourceRepository = {
    async listRunnableAccountIds() { calls.push(["source-accounts"]); return ["account-a"]; },
  };
  const finalizationRepository = {
    async listFinalizableAccountIds() { calls.push(["finalize-accounts"]); return ["account-b"]; },
  };
  const sourceWorker = { async processAccount(input) { calls.push(["run-source", input]); return { completed: 0 }; } };
  const finalizer = { async finalizeAccount(input) { calls.push(["run-finalizer", input]); return { finalized: 0 }; } };
  const autoListingService = { async createExcelAutoListingJob() {} };
  const runtime = createAutoListingUserWorkflowRuntime({
    env: { AUTO_LISTING_ENABLED: enabled ? "true" : "false" },
    async getPostgresPool() { calls.push(["pool"]); return pool; },
    createCleanupRepository(input) { calls.push(["cleanup-repository", input]); return cleanupRepository; },
    createImportRepository(input) { calls.push(["import-repository", input]); return importRepository; },
    createPreferencesRepository(input) { calls.push(["preferences-repository", input]); return preferencesRepository; },
    createWorkbookStore(input) { calls.push(["workbook-store", input]); return workbookStore; },
    createImportService(input) { calls.push(["import-service", input]); return importService; },
    createRecoveryRepository(input) { calls.push(["recovery-repository", input]); return recoveryRepository; },
    createRecoveryService(input) { calls.push(["recovery-service", input]); return recoveryService; },
    createService(input) { calls.push(["service", input]); return service; },
    createCleanupWorker(input) { calls.push(["cleanup-worker", input]); return cleanupWorker; },
    createSourceRepository(input) { calls.push(["source-repository", input]); return sourceRepository; },
    createFinalizationRepository(input) { calls.push(["finalization-repository", input]); return finalizationRepository; },
    createSourceWorker(input) { calls.push(["source-worker", input]); return sourceWorker; },
    createFinalizer(input) { calls.push(["finalizer", input]); return finalizer; },
    collectSku: async () => ({}),
    getAutoListingService: async () => autoListingService,
    parseWorkbook: async () => ({}),
  });
  return { runtime, calls, pool, cleanupRepository, importRepository, preferencesRepository,
    workbookStore, importService, recoveryRepository, recoveryService, service, cleanupWorker, sourceRepository,
    finalizationRepository, sourceWorker, finalizer, autoListingService };
}

test("disabled user workflow never connects to PostgreSQL or object storage", async () => {
  const { runtime, calls } = harness({ enabled: false });
  await assert.rejects(runtime.getService(), { code: "AUTO_LISTING_USER_DISABLED" });
  assert.equal(await runtime.startCleanupWorker(), false);
  await runtime.stopCleanupWorker();
  assert.deepEqual(calls, []);
});

test("enabled runtime lazily composes one shared service and cleanup worker", async () => {
  const h = harness();
  assert.deepEqual(h.calls, []);
  assert.equal(await h.runtime.getService(), h.service);
  assert.equal(await h.runtime.getService(), h.service);
  assert.equal(h.calls.filter(([name]) => name === "pool").length, 1);
  assert.deepEqual(h.calls.find(([name]) => name === "cleanup-repository"), ["cleanup-repository", { pool: h.pool }]);
  assert.deepEqual(h.calls.find(([name]) => name === "import-repository"), ["import-repository", {
    pool: h.pool, cleanupRepository: h.cleanupRepository, maxRows: 1_000,
  }]);
  assert.deepEqual(h.calls.find(([name]) => name === "service"), ["service", {
    preferencesRepository: h.preferencesRepository,
    importRepository: h.importRepository,
    importService: h.importService,
    recoveryService: h.recoveryService,
    limits: { maxBytes: 2_097_152, maxRows: 1_000 },
  }]);
  assert.deepEqual(h.calls.find(([name]) => name === "recovery-repository"), ["recovery-repository", { pool: h.pool }]);
  assert.deepEqual(h.calls.find(([name]) => name === "recovery-service"), ["recovery-service", {
    repository: h.recoveryRepository,
  }]);
  assert.deepEqual(h.calls.find(([name]) => name === "workbook-store"), ["workbook-store", { maxBytes: 2_097_152 }]);
});

test("runtime passes strict configured Excel limits to parser service and public workflow", async () => {
  const h = harness();
  h.runtime.stopWorkers();
  const configured = createAutoListingUserWorkflowRuntime({
    env: { AUTO_LISTING_ENABLED: "true", AUTO_LISTING_EXCEL_MAX_BYTES: "4194304", AUTO_LISTING_EXCEL_MAX_ROWS: "2500" },
    async getPostgresPool() { return h.pool; },
    createCleanupRepository: () => h.cleanupRepository,
    createImportRepository(input) { h.calls.push(["configured-import-repository", input]); return h.importRepository; },
    createPreferencesRepository: () => h.preferencesRepository,
    createWorkbookStore: () => h.workbookStore,
    createImportService(input) { h.calls.push(["configured-import-service", input]); return h.importService; },
    createRecoveryRepository: () => h.recoveryRepository,
    createRecoveryService: () => h.recoveryService,
    createService(input) { h.calls.push(["configured-service", input]); return h.service; },
    createCleanupWorker: () => h.cleanupWorker,
    createSourceRepository: () => h.sourceRepository,
    createFinalizationRepository: () => h.finalizationRepository,
    createSourceWorker: () => h.sourceWorker,
    createFinalizer: () => h.finalizer,
    collectSku: async () => ({}), getAutoListingService: async () => h.autoListingService,
    parseWorkbook: async () => ({}),
  });
  await configured.getService();
  assert.equal(h.calls.find(([name]) => name === "configured-import-service")[1].maxBytes, 4_194_304);
  assert.equal(h.calls.find(([name]) => name === "configured-import-service")[1].maxRows, 2_500);
  assert.equal(h.calls.find(([name]) => name === "configured-import-repository")[1].maxRows, 2_500);
  assert.deepEqual(h.calls.find(([name]) => name === "configured-service")[1].limits, { maxBytes: 4_194_304, maxRows: 2_500 });
});

test("default cleanup repository composes the runnable discovery and reference guard used by the worker", async () => {
  const h = harness();
  let composedCleanup;
  const runtime = createAutoListingUserWorkflowRuntime({
    env: { AUTO_LISTING_ENABLED: "true" },
    async getPostgresPool() { return h.pool; },
    createImportRepository({ cleanupRepository }) { composedCleanup = cleanupRepository; return h.importRepository; },
    createPreferencesRepository: () => h.preferencesRepository,
    createWorkbookStore: () => h.workbookStore,
    createImportService: () => h.importService,
    createRecoveryRepository: () => h.recoveryRepository,
    createRecoveryService: () => h.recoveryService,
    createService: () => h.service,
    createCleanupWorker({ repository }) {
      assert.equal(repository, composedCleanup);
      assert.equal(typeof repository.listRunnableCleanupAccountIds, "function");
      assert.equal(typeof repository.prepareObjectCleanup, "function");
      return h.cleanupWorker;
    },
    createSourceRepository: () => h.sourceRepository,
    createFinalizationRepository: () => h.finalizationRepository,
    createSourceWorker: () => h.sourceWorker,
    createFinalizer: () => h.finalizer,
    collectSku: async () => ({}), getAutoListingService: async () => h.autoListingService,
    parseWorkbook: async () => ({}),
  });
  assert.equal(await runtime.getService(), h.service);
});

test("cleanup lifecycle starts once, runs immediately, and stops its timer", async () => {
  const h = harness();
  const timers = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (callback, delay) => {
    const handle = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
    timers.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => { handle.cleared = true; };
  try {
    assert.equal(await h.runtime.startCleanupWorker(), true);
    assert.equal(await h.runtime.startCleanupWorker(), true);
    assert.equal(h.calls.filter(([name]) => name === "run-cleanup").length, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 60_000);
    assert.equal(timers[0].unrefCalled, true);
    await timers[0].callback();
    assert.equal(h.calls.filter(([name]) => name === "run-cleanup").length, 2);
    await h.runtime.stopCleanupWorker();
    assert.equal(timers[0].cleared, true);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("workflow lifecycle processes source accounts and finalization-only accounts without overlap", async () => {
  const h = harness();
  const timers = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (callback, delay) => {
    const handle = { callback, delay, unref() {} };
    timers.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => { handle.cleared = true; };
  try {
    assert.equal(await h.runtime.startWorkers(), true);
    assert.deepEqual(h.calls.filter(([name]) => name === "run-source").map(([, input]) => input.accountId), ["account-a"]);
    assert.deepEqual(h.calls.filter(([name]) => name === "run-finalizer").map(([, input]) => input.accountId).sort(), ["account-a", "account-b"]);
    assert.equal(timers.some((timer) => timer.delay === 30_000), true);
    await h.runtime.stopWorkers();
    assert.equal(timers.every((timer) => timer.cleared), true);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("worker lifecycle methods remain safe when passed as standalone callbacks", async () => {
  const h = harness();
  const { startWorkers, stopWorkers } = h.runtime;
  assert.equal(await startWorkers(), true);
  await stopWorkers();
});

test("initialization failures are safe and retryable", async () => {
  let attempts = 0;
  const runtime = createAutoListingUserWorkflowRuntime({
    env: { AUTO_LISTING_ENABLED: "true" },
    async getPostgresPool() { attempts += 1; throw new Error("password=prod-secret"); },
  });
  await assert.rejects(runtime.getService(), (error) => error?.code === "AUTO_LISTING_USER_INITIALIZATION_FAILED"
    && !/password|prod-secret/iu.test(error.message));
  await assert.rejects(runtime.getService(), { code: "AUTO_LISTING_USER_INITIALIZATION_FAILED" });
  assert.equal(attempts, 2);
});

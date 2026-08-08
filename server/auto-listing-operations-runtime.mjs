const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function operationsError(code = "AUTO_LISTING_OPERATIONS_INVALID", retryable = false) {
  const error = new Error("自动上架后台运行环境暂时不可用");
  error.code = code;
  error.status = code.endsWith("INVALID") ? 422 : 503;
  error.retryable = retryable;
  return error;
}

export function createAutoListingOperationsRuntime({
  enabled,
  getPublicationRuntime,
  getUploadRuntime,
  getReconciliationRuntime,
  cleanupWorkerId = "auto-listing-publication-cleanup",
  cleanupPollIntervalMs = 60_000,
  cleanupBatchLimit = 25,
  timers = globalThis,
  logger = console,
} = {}) {
  if (typeof enabled !== "boolean") throw operationsError();
  if (!enabled) {
    return Object.freeze({
      async start() { return false; },
      async runCleanupOnce() { return false; },
      async stop() {},
    });
  }
  if ([getPublicationRuntime, getUploadRuntime, getReconciliationRuntime]
    .some((value) => typeof value !== "function")
    || !SAFE_ID.test(cleanupWorkerId) || !Number.isSafeInteger(cleanupPollIntervalMs)
    || cleanupPollIntervalMs < 1_000 || cleanupPollIntervalMs > 3_600_000
    || !Number.isSafeInteger(cleanupBatchLimit) || cleanupBatchLimit < 1 || cleanupBatchLimit > 100
    || typeof timers?.setTimeout !== "function" || typeof timers?.clearTimeout !== "function"
    || typeof logger?.log !== "function") throw operationsError();

  let resolved = null;
  let started = false;
  let startPromise = null;
  let cleanupTimer = null;
  let cleanupInFlight = null;

  async function components() {
    if (!resolved) {
      const [publication, upload, reconciliation] = await Promise.all([
        getPublicationRuntime(), getUploadRuntime(), getReconciliationRuntime(),
      ]);
      if (typeof publication?.runCleanupBatch !== "function" || typeof upload?.start !== "function"
        || typeof upload?.stop !== "function" || typeof reconciliation?.start !== "function"
        || typeof reconciliation?.stop !== "function") throw operationsError();
      resolved = Object.freeze({ publication, upload, reconciliation });
    }
    return resolved;
  }

  function observe(code) {
    try { logger.log(Object.freeze({ component: "AUTO_LISTING_OPERATIONS", code })); } catch {}
  }

  async function runCleanupOnce() {
    if (!started) return false;
    if (cleanupInFlight) return cleanupInFlight;
    cleanupInFlight = components()
      .then(({ publication }) => publication.runCleanupBatch({
        workerId: cleanupWorkerId, limit: cleanupBatchLimit,
      }))
      .catch(() => { observe("AUTO_LISTING_PUBLICATION_CLEANUP_FAILED"); return false; })
      .finally(() => { cleanupInFlight = null; });
    return cleanupInFlight;
  }

  function scheduleCleanup() {
    if (!started) return;
    cleanupTimer = timers.setTimeout(async () => {
      cleanupTimer = null;
      await runCleanupOnce();
      scheduleCleanup();
    }, cleanupPollIntervalMs);
  }

  async function start() {
    if (started) return true;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      let value;
      try {
        value = await components();
        await value.upload.start();
        await value.reconciliation.start();
        started = true;
        scheduleCleanup();
        return true;
      } catch {
        started = false;
        if (value) {
          await value.reconciliation.stop().catch(() => {});
          await value.upload.stop().catch(() => {});
        }
        throw operationsError("AUTO_LISTING_OPERATIONS_START_FAILED", true);
      } finally { startPromise = null; }
    })();
    return startPromise;
  }

  async function stop() {
    if (startPromise) await startPromise.catch(() => {});
    const value = resolved;
    started = false;
    if (cleanupTimer !== null) timers.clearTimeout(cleanupTimer);
    cleanupTimer = null;
    if (cleanupInFlight) await cleanupInFlight.catch(() => {});
    if (value) {
      await value.reconciliation.stop().catch(() => {});
      await value.upload.stop().catch(() => {});
    }
  }

  return Object.freeze({ start, runCleanupOnce, stop });
}

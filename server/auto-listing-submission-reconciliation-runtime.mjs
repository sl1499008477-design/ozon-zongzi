import { createPostgresAutoListingSubmissionReconciliationRepository } from "./auto-listing-submission-reconciliation-postgres.mjs";
import { createAutoListingSubmissionReconciliationWorker } from "./auto-listing-submission-reconciliation-worker.mjs";
import { createAutoListingSubmissionReconciler } from "./auto-listing-submission-reconciler.mjs";

function runtimeError() {
  const error = new Error("自动上架结果核对运行环境配置无效");
  error.code = "AUTO_LISTING_RECONCILE_RUNTIME_INVALID";
  error.retryable = false;
  return error;
}

export function createAutoListingSubmissionReconciliationRuntime(config = {}) {
  let enabled;
  try {
    const descriptor = config && typeof config === "object"
      ? Object.getOwnPropertyDescriptor(config, "enabled") : null;
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "boolean") throw runtimeError();
    enabled = descriptor.value;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_RECONCILE_RUNTIME_INVALID") throw error;
    throw runtimeError();
  }
  if (!enabled) {
    return Object.freeze({
      async start() { return false; }, async runOnce() { return false; }, async stop() {},
      async enqueue() { throw runtimeError(); },
    });
  }

  let repository;
  try {
    repository = config.repository || createPostgresAutoListingSubmissionReconciliationRepository({ pool: config.pool });
  } catch { throw runtimeError(); }
  if (typeof repository?.enqueue !== "function") throw runtimeError();
  let reconciler;
  try { reconciler = config.reconciler || createAutoListingSubmissionReconciler({ repository }); }
  catch { throw runtimeError(); }
  const logger = config.logger || { log(record) { console.log(JSON.stringify(record)); } };
  const timers = config.timers || { setTimeout, clearTimeout };
  let worker;
  try {
    worker = createAutoListingSubmissionReconciliationWorker({
      enabled: true,
      repository,
      reconciler,
      workerId: config.workerId || `auto-listing-reconcile-${process.pid}`,
      pollIntervalMs: config.pollIntervalMs ?? 5_000,
      leaseMs: config.leaseMs ?? 30_000,
      baseDelayMs: config.baseDelayMs ?? 5_000,
      maxDelayMs: config.maxDelayMs ?? 900_000,
      maxAttempts: config.maxAttempts ?? 100,
      logger,
      timers,
    });
  } catch { throw runtimeError(); }
  return Object.freeze({
    start: () => worker.start(),
    runOnce: () => worker.runOnce(),
    stop: () => worker.stop(),
    enqueue: (input) => repository.enqueue(input),
  });
}

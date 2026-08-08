import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingOperationsRuntime } from "../auto-listing-operations-runtime.mjs";

function harness({ enabled = true, failReconcileStart = false } = {}) {
  const calls = [];
  const timers = {
    setTimeout(fn, ms) { calls.push(["timer-set", ms]); return { fn }; },
    clearTimeout() { calls.push(["timer-clear"]); },
  };
  const publicationRuntime = {
    async runCleanupBatch(input) { calls.push(["cleanup", input]); return { scanned: 0 }; },
  };
  const uploadRuntime = {
    async start() { calls.push(["upload-start"]); return true; },
    async stop() { calls.push(["upload-stop"]); },
  };
  const reconciliationRuntime = {
    async start() { calls.push(["reconcile-start"]); if (failReconcileStart) throw new Error("failed"); return true; },
    async stop() { calls.push(["reconcile-stop"]); },
  };
  const runtime = createAutoListingOperationsRuntime({
    enabled,
    getPublicationRuntime: async () => { calls.push(["publication-get"]); return publicationRuntime; },
    getUploadRuntime: async () => { calls.push(["upload-get"]); return uploadRuntime; },
    getReconciliationRuntime: async () => { calls.push(["reconcile-get"]); return reconciliationRuntime; },
    cleanupWorkerId: "cleanup-worker-a",
    cleanupPollIntervalMs: 60_000,
    cleanupBatchLimit: 25,
    timers,
    logger: { log(value) { calls.push(["log", value]); } },
  });
  return { runtime, calls, timers };
}

test("operations runtime starts upload and reconciliation before scheduling recoverable publication cleanup", async () => {
  const h = harness();
  assert.equal(await h.runtime.start(), true);
  assert.deepEqual(h.calls.slice(0, 6).map(([name]) => name), [
    "publication-get", "upload-get", "reconcile-get", "upload-start", "reconcile-start", "timer-set",
  ]);
  assert.equal(await h.runtime.start(), true);
  assert.equal(h.calls.filter(([name]) => name === "upload-start").length, 1);
  await h.runtime.runCleanupOnce();
  assert.deepEqual(h.calls.find(([name]) => name === "cleanup")[1], {
    workerId: "cleanup-worker-a", limit: 25,
  });
  await h.runtime.stop();
  assert.equal(h.calls.some(([name]) => name === "timer-clear"), true);
  assert.equal(h.calls.some(([name]) => name === "reconcile-stop"), true);
  assert.equal(h.calls.some(([name]) => name === "upload-stop"), true);
});

test("disabled operations runtime is inert and never resolves databases or storage", async () => {
  let touched = 0;
  const runtime = createAutoListingOperationsRuntime({
    enabled: false,
    getPublicationRuntime: async () => { touched += 1; },
    getUploadRuntime: async () => { touched += 1; },
    getReconciliationRuntime: async () => { touched += 1; },
  });
  assert.equal(await runtime.start(), false);
  assert.equal(await runtime.runCleanupOnce(), false);
  await runtime.stop();
  assert.equal(touched, 0);
});

test("partial startup rolls back already-started workers and may be retried", async () => {
  const h = harness({ failReconcileStart: true });
  await assert.rejects(h.runtime.start(), { code: "AUTO_LISTING_OPERATIONS_START_FAILED" });
  assert.equal(h.calls.some(([name]) => name === "upload-stop"), true);
  assert.equal(h.calls.some(([name]) => name === "timer-set"), false);
  await assert.rejects(h.runtime.start(), { code: "AUTO_LISTING_OPERATIONS_START_FAILED" });
  assert.equal(h.calls.filter(([name]) => name === "upload-start").length, 2);
});

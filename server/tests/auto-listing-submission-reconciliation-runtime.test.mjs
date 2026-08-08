import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingSubmissionReconciliationRuntime } from "../auto-listing-submission-reconciliation-runtime.mjs";

test("disabled reconciliation runtime is inert and never reads the database pool", async () => {
  let reads = 0;
  const pool = new Proxy({}, { get() { reads += 1; throw new Error("must not read"); } });
  const runtime = createAutoListingSubmissionReconciliationRuntime({ enabled: false, pool });
  assert.equal(await runtime.start(), false);
  assert.equal(await runtime.runOnce(), false);
  await runtime.stop();
  assert.equal(reads, 0);
});

test("enabled runtime exposes one durable enqueue boundary and delegates worker lifecycle", async () => {
  const calls = [];
  const repository = {
    async enqueue(input) { calls.push(["enqueue", input]); return { taskId: "task-a", duplicate: false }; },
    async leaseNext() { calls.push(["lease"]); return null; },
    async completeLease() { throw new Error("not reached"); },
    async rescheduleLease() { throw new Error("not reached"); },
    async deadLetterLease() { throw new Error("not reached"); },
    async loadReconciliationEvidence() { throw new Error("not reached"); },
    async applyReconciliation() { throw new Error("not reached"); },
  };
  const runtime = createAutoListingSubmissionReconciliationRuntime({
    enabled: true,
    repository,
    workerId: "worker-a",
    pollIntervalMs: 1_000,
    leaseMs: 30_000,
    baseDelayMs: 2_000,
    maxDelayMs: 10_000,
    maxAttempts: 5,
    logger: { log() {} },
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  assert.deepEqual(await runtime.enqueue({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
    submissionJobId: "submission-a", correlationId: "enqueue-a",
  }), { taskId: "task-a", duplicate: false });
  assert.equal(await runtime.runOnce(), false);
  assert.deepEqual(calls.map(([kind]) => kind), ["enqueue", "lease"]);
});

test("enabled runtime fails closed when no PostgreSQL repository can be composed", () => {
  assert.throws(() => createAutoListingSubmissionReconciliationRuntime({ enabled: true }), {
    code: "AUTO_LISTING_RECONCILE_RUNTIME_INVALID",
  });
});

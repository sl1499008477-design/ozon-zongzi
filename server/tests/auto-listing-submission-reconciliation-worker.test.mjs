import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingSubmissionReconciliationWorker } from "../auto-listing-submission-reconciliation-worker.mjs";

const task = Object.freeze({
  accountId: "account-a",
  jobId: "job-a",
  itemId: "item-a",
  submissionLinkId: "link-a",
  submissionJobId: "submission-a",
  taskId: "reconcile-a",
  leaseToken: "lease-a",
  attemptCount: 2,
});

function harness({ result = { status: "SUCCEEDED", linkStatus: "SUCCEEDED" }, failure = null } = {}) {
  const calls = [];
  const repository = {
    async leaseNext(input) { calls.push(["lease", input]); return structuredClone(task); },
    async completeLease(input) { calls.push(["complete", input]); return true; },
    async rescheduleLease(input) { calls.push(["reschedule", input]); return true; },
    async deadLetterLease(input) { calls.push(["dead", input]); return true; },
  };
  const reconciler = {
    async reconcile(input) {
      calls.push(["reconcile", input]);
      if (failure) throw failure;
      return result;
    },
  };
  return { calls, worker: createAutoListingSubmissionReconciliationWorker({
    enabled: true,
    repository,
    reconciler,
    workerId: "worker-a",
    pollIntervalMs: 1_000,
    leaseMs: 30_000,
    baseDelayMs: 2_000,
    maxDelayMs: 10_000,
    maxAttempts: 5,
    logger: { log(record) { calls.push(["log", record]); } },
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
  }) };
}

test("a terminal reconciliation completes the exact lease after the database result is applied", async () => {
  const { worker, calls } = harness();
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(calls.map(([kind]) => kind), ["lease", "reconcile", "complete"]);
  assert.deepEqual(calls[1][1], {
    accountId: "account-a", itemId: "item-a", submissionLinkId: "link-a",
    correlationId: "reconcile-a:2",
  });
  assert.deepEqual(calls[2][1], {
    accountId: "account-a", taskId: "reconcile-a", leaseToken: "lease-a",
    correlationId: "reconcile-a:2", evidence: { itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED" },
  });
});

test("an unresolved local submission is rescheduled with bounded exponential backoff", async () => {
  const { worker, calls } = harness({ result: { status: "UPLOADING", linkStatus: "SUBMITTED" } });
  await worker.runOnce();
  const command = calls.find(([kind]) => kind === "reschedule")[1];
  assert.equal(command.delayMs, 4_000);
  assert.equal(command.errorCode, null);
  assert.deepEqual(command.evidence, { itemStatus: "UPLOADING", linkStatus: "SUBMITTED" });
  assert.equal(calls.some(([kind]) => kind === "complete"), false);
});

test("retryable failures keep only a safe code and never log the raw secret", async () => {
  const failure = new Error("password=raw-secret");
  failure.code = "AUTO_LISTING_RECONCILE_DATABASE_FAILED";
  failure.retryable = true;
  const { worker, calls } = harness({ failure });
  await worker.runOnce();
  const command = calls.find(([kind]) => kind === "reschedule")[1];
  assert.equal(command.errorCode, "AUTO_LISTING_RECONCILE_DATABASE_FAILED");
  assert.equal(JSON.stringify(calls).includes("raw-secret"), false);
});

test("permanent failures and the attempt ceiling dead-letter once without reconciling again", async () => {
  const permanent = new Error("unsafe raw body");
  permanent.code = "AUTO_LISTING_RECONCILE_EVIDENCE_INVALID";
  permanent.retryable = false;
  const first = harness({ failure: permanent });
  await first.worker.runOnce();
  assert.equal(first.calls.filter(([kind]) => kind === "dead").length, 1);

  const ceiling = harness();
  ceiling.calls.length = 0;
  const original = ceiling.worker;
  // A separate repository supplies an already exhausted lease.
  const calls = [];
  const worker = createAutoListingSubmissionReconciliationWorker({
    enabled: true,
    repository: {
      async leaseNext() { return { ...task, attemptCount: 6 }; },
      async completeLease() { throw new Error("must not complete"); },
      async rescheduleLease() { throw new Error("must not reschedule"); },
      async deadLetterLease(input) { calls.push(input); return true; },
    },
    reconciler: { async reconcile() { throw new Error("must not reconcile"); } },
    workerId: "worker-a", pollIntervalMs: 1_000, leaseMs: 30_000,
    baseDelayMs: 2_000, maxDelayMs: 10_000, maxAttempts: 5,
    logger: { log() {} }, timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal(calls[0].errorCode, "AUTO_LISTING_RECONCILE_ATTEMPT_LIMIT_REACHED");
  assert.ok(original);
});

test("maxAttempts counts actual reconciliation attempts, so the final allowed attempt still runs", async () => {
  let reconciled = 0;
  let completed = 0;
  const worker = createAutoListingSubmissionReconciliationWorker({
    enabled: true,
    repository: {
      async leaseNext() { return { ...task, attemptCount: 5 }; },
      async completeLease() { completed += 1; return true; },
      async rescheduleLease() { throw new Error("must not reschedule"); },
      async deadLetterLease() { throw new Error("must not dead-letter"); },
    },
    reconciler: { async reconcile() { reconciled += 1; return { status: "SUCCEEDED", linkStatus: "SUCCEEDED" }; } },
    workerId: "worker-a", pollIntervalMs: 1_000, leaseMs: 30_000,
    baseDelayMs: 2_000, maxDelayMs: 10_000, maxAttempts: 5,
    logger: { log() {} }, timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  await worker.runOnce();
  assert.deepEqual({ reconciled, completed }, { reconciled: 1, completed: 1 });
});

test("disabled worker never touches PostgreSQL or starts a timer", async () => {
  let touched = 0;
  const worker = createAutoListingSubmissionReconciliationWorker({
    enabled: false,
    repository: new Proxy({}, { get() { touched += 1; return async () => null; } }),
    reconciler: new Proxy({}, { get() { touched += 1; return async () => null; } }),
    timers: { setTimeout() { touched += 1; }, clearTimeout() { touched += 1; } },
  });
  assert.equal(await worker.start(), false);
  assert.equal(await worker.runOnce(), false);
  await worker.stop();
  assert.equal(touched, 0);
});

test("worker configuration rejects proxy traps and accessors without exposing their raw values", () => {
  assert.throws(() => createAutoListingSubmissionReconciliationWorker(new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error("password=raw-secret"); },
  })), (error) => error?.code === "AUTO_LISTING_RECONCILE_WORKER_INVALID"
    && !/password|raw-secret/iu.test(error.message));

  let reads = 0;
  const config = { enabled: true };
  Object.defineProperty(config, "repository", {
    enumerable: true, get() { reads += 1; throw new Error("apiKey=raw-secret"); },
  });
  assert.throws(() => createAutoListingSubmissionReconciliationWorker(config), {
    code: "AUTO_LISTING_RECONCILE_WORKER_INVALID",
  });
  assert.equal(reads, 0);
});

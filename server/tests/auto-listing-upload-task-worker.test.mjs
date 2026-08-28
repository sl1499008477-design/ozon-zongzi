import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingUploadTaskWorker } from "../auto-listing-upload-task-worker.mjs";

const task = Object.freeze({
  taskId: "task-a", accountId: "account-a", jobId: "job-a", itemId: "item-a",
  actor: Object.freeze({ id: "account-a", role: "user" }), expectedStatusVersion: 6,
  leaseToken: "lease-a", attemptCount: 1, itemStatus: "UPLOAD_QUEUED", itemStatusVersion: 6,
});

function harness({ error = null } = {}) {
  const calls = [];
  const worker = createAutoListingUploadTaskWorker({
    enabled: true,
    repository: {
      async listRunnableAccounts(input) { calls.push(["accounts", input]); return ["account-a"]; },
      async leaseNext(input) { calls.push(["lease", input]); return { ...task }; },
      async completeLease(input) { calls.push(["complete", input]); },
      async rescheduleLease(input) { calls.push(["reschedule", input]); },
      async deadLetterLease(input) { calls.push(["dead", input]); },
    },
    uploadService: {
      async submitAutoListingItem(input) {
        calls.push(["submit", input]);
        if (error) throw error;
        return { itemId: "item-a", status: "SUBMITTED", submissionJobId: "submission-a",
          submissionSnapshotId: "snapshot-a", duplicate: false };
      },
    },
    workerId: "worker-a", accountScanLimit: 100, pollIntervalMs: 1_000, leaseMs: 30_000,
    baseDelayMs: 2_000, maxDelayMs: 10_000, maxAttempts: 5,
    logger: { log(value) { calls.push(["log", value]); } },
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  return { worker, calls };
}

test("worker claims within one explicit tenant and invokes only the closed upload service input", async () => {
  const { worker, calls } = harness();
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(calls.map(([name]) => name), ["accounts", "lease", "submit", "complete"]);
  assert.deepEqual(calls[0][1], { afterAccountId: null, limit: 100 });
  assert.deepEqual(calls[1][1], { accountId: "account-a", workerId: "worker-a", leaseMs: 30_000 });
  assert.deepEqual(calls[2][1], {
    actor: { id: "account-a", role: "user" }, itemId: "item-a",
    expectedStatusVersion: 6, correlationId: "task-a:1",
  });
  assert.equal(JSON.stringify(calls).includes("apiKey"), false);
});

test("worker leaves batch-order eligibility at the repository claim boundary", async () => {
  const calls = [];
  const worker = createAutoListingUploadTaskWorker({ enabled: true,
    repository: {
      async listRunnableAccounts(input) { calls.push(["accounts", input]); return ["account-a"]; },
      async leaseNext(input) { calls.push(["lease", input]); return null; },
      async completeLease() { calls.push(["complete"]); },
      async rescheduleLease() { calls.push(["reschedule"]); },
      async deadLetterLease() { calls.push(["dead"]); },
    },
    uploadService: { async submitAutoListingItem() { calls.push(["submit"]); } },
    workerId: "worker-a", accountScanLimit: 100, pollIntervalMs: 1_000, leaseMs: 30_000,
    baseDelayMs: 2_000, maxDelayMs: 10_000, maxAttempts: 5,
    logger: { log() {} }, timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  assert.equal(await worker.runOnce(), false);
  assert.deepEqual(calls.map(([name]) => name), ["accounts", "lease"]);
});

test("worker paginates tenant ids and discovers an account added after startup", async () => {
  const calls = [];
  let scan = 0;
  const repository = {
    async listRunnableAccounts(input) {
      calls.push(["accounts", input]);
      scan += 1;
      if (scan === 1) return ["account-a"];
      if (scan === 2) return [];
      return ["account-new"];
    },
    async leaseNext(input) {
      calls.push(["lease", input]);
      return input.accountId === "account-new"
        ? { ...task, accountId: "account-new", actor: { id: "account-new", role: "user" } } : null;
    },
    async completeLease(input) { calls.push(["complete", input]); },
    async rescheduleLease() {}, async deadLetterLease() {},
  };
  const worker = createAutoListingUploadTaskWorker({ enabled: true, repository,
    uploadService: { async submitAutoListingItem() { return { itemId: "item-a", status: "SUBMITTED",
      submissionJobId: "submission-a", submissionSnapshotId: "snapshot-a", duplicate: false }; } },
    workerId: "worker-a", accountScanLimit: 1, pollIntervalMs: 1_000, leaseMs: 30_000,
    baseDelayMs: 2_000, maxDelayMs: 10_000, maxAttempts: 5,
    logger: { log() {} }, timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  assert.equal(await worker.runOnce(), false);
  assert.equal(await worker.runOnce(), true);
  assert.equal(calls.some(([kind, input]) => kind === "lease" && input.accountId === "account-new"), true);
});

test("safe pre-submission release hands off to the new durable generation", async () => {
  const error = new Error("raw secret");
  error.code = "AUTO_LISTING_UPLOAD_RETRYABLE";
  error.retryable = true;
  const { worker, calls } = harness({ error });
  await worker.runOnce();
  assert.equal(calls.some(([name]) => name === "reschedule"), false);
  const complete = calls.find(([name]) => name === "complete")[1];
  assert.deepEqual(complete.evidence, { outcome: "HANDED_OFF", code: "AUTO_LISTING_UPLOAD_RETRYABLE" });
  assert.equal(JSON.stringify(calls).includes("raw secret"), false);
});

test("a cancelled or advanced item drains its old task as STALE without invoking upload", async () => {
  const calls = [];
  const worker = createAutoListingUploadTaskWorker({ enabled: true,
    repository: {
      async listRunnableAccounts() { return ["account-a"]; },
      async leaseNext() { return { ...task, itemStatus: "CANCELLED", itemStatusVersion: 7 }; },
      async completeLease(input) { calls.push(["complete", input]); },
      async rescheduleLease() {}, async deadLetterLease() {},
    },
    uploadService: { async submitAutoListingItem() { calls.push(["submit"]); } },
    workerId: "worker-a", accountScanLimit: 100, pollIntervalMs: 1_000, leaseMs: 30_000,
    baseDelayMs: 2_000, maxDelayMs: 10_000, maxAttempts: 5,
    logger: { log() {} }, timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  await worker.runOnce();
  assert.equal(calls.some(([kind]) => kind === "submit"), false);
  assert.deepEqual(calls[0][1].evidence, { outcome: "STALE", code: "AUTO_LISTING_UPLOAD_TASK_STALE" });
});

test("attempt exhaustion dead-letters through the repository business-blocking command", async () => {
  const calls = [];
  const worker = createAutoListingUploadTaskWorker({ enabled: true,
    repository: {
      async listRunnableAccounts() { return ["account-a"]; },
      async leaseNext() { return { ...task, attemptCount: 6 }; },
      async completeLease() { throw new Error("must not complete"); },
      async rescheduleLease() { throw new Error("must not retry"); },
      async deadLetterLease(input) { calls.push(input); },
    },
    uploadService: { async submitAutoListingItem() { throw new Error("must not submit"); } },
    workerId: "worker-a", accountScanLimit: 100, pollIntervalMs: 1_000, leaseMs: 30_000,
    baseDelayMs: 2_000, maxDelayMs: 10_000, maxAttempts: 5,
    logger: { log() {} }, timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  await worker.runOnce();
  assert.equal(calls[0].errorCode, "AUTO_LISTING_UPLOAD_ATTEMPT_LIMIT_REACHED");
  assert.deepEqual(calls[0].evidence, {
    outcome: "BLOCKED", code: "AUTO_LISTING_UPLOAD_ATTEMPT_LIMIT_REACHED",
  });
});

test("transient pre-claim failures retry, while ambiguous or terminal state outcomes do not create a second upload", async () => {
  const transient = new Error("unsafe");
  transient.code = "AUTO_LISTING_UPLOAD_REPOSITORY_FAILED";
  transient.retryable = true;
  const retry = harness({ error: transient });
  await retry.worker.runOnce();
  assert.equal(retry.calls.find(([name]) => name === "reschedule")[1].delayMs, 2_000);

  for (const code of ["AUTO_LISTING_UPLOAD_UNCERTAIN", "AUTO_LISTING_UPLOAD_STATE_INVALID", "AUTO_LISTING_UPLOAD_BLOCKED"]) {
    const terminal = new Error("unsafe");
    terminal.code = code;
    terminal.retryable = true;
    const result = harness({ error: terminal });
    await result.worker.runOnce();
    assert.equal(result.calls.some(([name]) => name === "reschedule"), false);
    assert.equal(result.calls.filter(([name]) => name === "dead").length, code === "AUTO_LISTING_UPLOAD_UNCERTAIN" ? 1 : 0);
    assert.equal(result.calls.filter(([name]) => name === "complete").length, code === "AUTO_LISTING_UPLOAD_UNCERTAIN" ? 0 : 1);
  }
});

test("disabled worker is inert", async () => {
  let touched = 0;
  const worker = createAutoListingUploadTaskWorker({ enabled: false,
    repository: new Proxy({}, { get() { touched += 1; } }),
    uploadService: new Proxy({}, { get() { touched += 1; } }),
  });
  assert.equal(await worker.start(), false);
  assert.equal(await worker.runOnce(), false);
  await worker.stop();
  assert.equal(touched, 0);
});

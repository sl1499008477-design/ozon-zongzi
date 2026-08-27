import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingAiRetryService } from "../auto-listing-ai-retry-service.mjs";

const command = Object.freeze({
  accountId: "account-a",
  jobId: "job-a",
  itemId: "item-a",
  expectedStatusVersion: 4,
  idempotencyKey: "retry-command-a",
});

test("retry service forwards one closed account-scoped command and exposes only a stable result", async () => {
  const calls = [];
  const service = createAutoListingAiRetryService({
    repository: Object.freeze({
      async retryAutoListingAiItem(input) {
        calls.push(input);
        return { status: "GENERATING", statusVersion: 5, recoveryPoint: "GENERATION", enqueued: 2, duplicate: false };
      },
    }),
  });
  assert.deepEqual(await service.retry(command), {
    status: "GENERATING", statusVersion: 5, recoveryPoint: "GENERATION", enqueued: 2, duplicate: false,
  });
  assert.deepEqual(calls, [command]);
});

test("retry service accepts the repository result for a 77-slot multi-variant retry", async () => {
  const service = createAutoListingAiRetryService({
    repository: Object.freeze({
      async retryAutoListingAiItem() {
        return { status: "GENERATING", statusVersion: 5, recoveryPoint: "GENERATION", enqueued: 77, duplicate: false };
      },
    }),
  });

  assert.equal((await service.retry(command)).enqueued, 77);
});

test("retry service rejects open inputs, unsafe scopes and raw repository failures", async () => {
  const service = createAutoListingAiRetryService({
    repository: Object.freeze({
      async retryAutoListingAiItem() { throw new Error("password=raw host=production"); },
    }),
  });
  for (const input of [
    { ...command, unexpected: true },
    { ...command, accountId: "https://secret.invalid" },
    { ...command, expectedStatusVersion: 0 },
    { ...command, idempotencyKey: "x".repeat(241) },
  ]) await assert.rejects(service.retry(input), { code: "AUTO_LISTING_AI_RETRY_INVALID" });
  await assert.rejects(service.retry(command), (error) => error?.code === "AUTO_LISTING_AI_RETRY_FAILED"
    && error.retryable === true && !/password|production|raw/iu.test(error.message));
});

test("retry service preserves only its stable repository conflict/not-recoverable codes", async () => {
  for (const code of ["AUTO_LISTING_AI_RETRY_VERSION_CONFLICT", "AUTO_LISTING_AI_RETRY_NOT_RECOVERABLE"] ) {
    const service = createAutoListingAiRetryService({
      repository: Object.freeze({
        async retryAutoListingAiItem() {
          const error = new Error("safe repository boundary");
          error.code = code;
          error.retryable = false;
          throw error;
        },
      }),
    });
    await assert.rejects(service.retry(command), { code });
  }
});

test("retry service factory rejects extra, accessor and proxy configuration without invoking hidden values", () => {
  const repository = Object.freeze({ async retryAutoListingAiItem() {} });
  assert.throws(() => createAutoListingAiRetryService({ repository, extra: true }), {
    code: "AUTO_LISTING_AI_RETRY_INVALID",
  });
  let reads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "repository", {
    enumerable: true,
    get() { reads += 1; return repository; },
  });
  assert.throws(() => createAutoListingAiRetryService(accessor), {
    code: "AUTO_LISTING_AI_RETRY_INVALID",
  });
  assert.equal(reads, 0);
  assert.throws(() => createAutoListingAiRetryService(new Proxy({}, {
    ownKeys() { throw new Error("password=raw"); },
  })), (error) => error?.code === "AUTO_LISTING_AI_RETRY_INVALID"
    && !/password|raw/iu.test(error.message));
});

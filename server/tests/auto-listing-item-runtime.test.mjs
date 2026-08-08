import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingItemRuntime } from "../auto-listing-item-runtime.mjs";

test("item runtime stays dormant while disabled", async () => {
  let calls = 0;
  const runtime = createAutoListingItemRuntime({
    env: { AUTO_LISTING_ENABLED: "false" },
    async getPostgresPool() { calls += 1; },
  });
  await assert.rejects(runtime.getService(), { code: "AUTO_LISTING_ITEM_DISABLED" });
  assert.equal(calls, 0);
});

test("item runtime lazily composes one shared action and retry service", async () => {
  const calls = [];
  const pool = { async query() {}, async connect() {} };
  const actionRepository = { cancelItem() {}, regenerateItem() {} };
  const retryRepository = { retryAutoListingAiItem() {} };
  const retryService = { retry() {} };
  const reviewRepository = { loadReviewEvidence() {} };
  const reviewService = { getReview() {} };
  const itemService = { cancelItem() {}, regenerateItem() {}, retryItem() {}, getReview() {} };
  const runtime = createAutoListingItemRuntime({
    env: { AUTO_LISTING_ENABLED: "true" },
    async getPostgresPool() { calls.push(["pool"]); return pool; },
    createActionRepository(input) { calls.push(["action", input]); return actionRepository; },
    createRetryRepository(input) { calls.push(["retry-repo", input]); return retryRepository; },
    createRetryService(input) { calls.push(["retry-service", input]); return retryService; },
    createReviewRepository(input) { calls.push(["review-repo", input]); return reviewRepository; },
    createReviewService(input) { calls.push(["review-service", input]); return reviewService; },
    createItemService(input) { calls.push(["item-service", input]); return itemService; },
  });
  assert.equal(await runtime.getService(), itemService);
  assert.equal(await runtime.getService(), itemService);
  assert.deepEqual(calls, [
    ["pool"], ["action", { pool }], ["retry-repo", { pool }],
    ["retry-service", { repository: retryRepository }],
    ["review-repo", { pool }],
    ["review-service", { repository: reviewRepository }],
    ["item-service", { actionRepository, retryService, reviewService }],
  ]);
});

test("failed initialization is redacted and retryable", async () => {
  let calls = 0;
  const runtime = createAutoListingItemRuntime({
    env: { AUTO_LISTING_ENABLED: "true" },
    async getPostgresPool() { calls += 1; throw new Error("password=secret"); },
  });
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(runtime.getService(), (error) => error?.code === "AUTO_LISTING_ITEM_INITIALIZATION_FAILED"
      && error.retryable === true && !/password|secret/i.test(error.message));
  }
  assert.equal(calls, 2);
});

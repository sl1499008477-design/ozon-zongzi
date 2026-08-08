import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingItemService } from "../auto-listing-item-service.mjs";

const actor = Object.freeze({ id: "account-a", role: "user" });
const input = Object.freeze({
  actor, jobId: "job-a", itemId: "item-a", expectedStatusVersion: 5,
  idempotencyKey: "command-a", correlationId: "correlation-a",
});

test("item service derives account authority only from the actor for all commands", async () => {
  const calls = [];
  const service = createAutoListingItemService({
    actionRepository: {
      async cancelItem(value) { calls.push(["cancel", value]); return { status: "CANCELLED", statusVersion: 6, action: "CANCEL", duplicate: false }; },
      async regenerateItem(value) { calls.push(["regenerate", value]); return { status: "PLANNING", statusVersion: 6, action: "REGENERATE", duplicate: false }; },
      async approveItem(value) { calls.push(["approve", value]); return { status: "UPLOAD_QUEUED", statusVersion: 6, action: "APPROVE_UPLOAD", duplicate: false }; },
    },
    retryService: {
      async retry(value) { calls.push(["retry", value]); return { status: "GENERATING", statusVersion: 6, recoveryPoint: "GENERATION", enqueued: 2, duplicate: false }; },
    },
    reviewService: {
      async getReview(value) { calls.push(["review", value]); return { itemId: "item-a", statusVersion: 5, images: [] }; },
    },
  });
  assert.equal((await service.cancelItem(input)).status, "CANCELLED");
  assert.equal((await service.regenerateItem(input)).status, "PLANNING");
  assert.equal((await service.approveItem(input)).status, "UPLOAD_QUEUED");
  assert.equal((await service.retryItem(input)).status, "GENERATING");
  assert.equal((await service.getReview({ actor, itemId: "item-a" })).itemId, "item-a");
  const expectedAction = {
    accountId: "account-a", actorAccountId: "account-a", jobId: "job-a", itemId: "item-a",
    expectedStatusVersion: 5, idempotencyKey: "command-a", correlationId: "correlation-a",
  };
  assert.deepEqual(calls, [
    ["cancel", expectedAction],
    ["regenerate", expectedAction],
    ["approve", expectedAction],
    ["retry", {
      accountId: "account-a", jobId: "job-a", itemId: "item-a",
      expectedStatusVersion: 5, idempotencyKey: "command-a",
    }],
    ["review", { actor, itemId: "item-a" }],
  ]);
});

test("item service rejects permission and open or forged command input before dependencies", async () => {
  let calls = 0;
  const service = createAutoListingItemService({
    actionRepository: { async cancelItem() { calls += 1; }, async regenerateItem() { calls += 1; }, async approveItem() { calls += 1; } },
    retryService: { async retry() { calls += 1; } },
    reviewService: { async getReview() { calls += 1; } },
  });
  for (const value of [
    { ...input, actor: { id: "", role: "readonly" } },
    { ...input, accountId: "account-b" },
    { ...input, expectedStatusVersion: 0 },
    { ...input, itemId: "https://invalid.test" },
  ]) await assert.rejects(service.cancelItem(value));
  assert.equal(calls, 0);
});

test("item service passes review authority only as the authenticated actor and item id", async () => {
  const calls = [];
  const service = createAutoListingItemService({
    actionRepository: { async cancelItem() {}, async regenerateItem() {}, async approveItem() {} },
    retryService: { async retry() {} },
    reviewService: {
      async getReview(value) { calls.push(value); return { itemId: "item-a", statusVersion: 5 }; },
    },
  });
  assert.deepEqual(await service.getReview({ actor, itemId: "item-a" }), {
    itemId: "item-a", statusVersion: 5,
  });
  assert.deepEqual(calls, [{ actor, itemId: "item-a" }]);
  await assert.rejects(service.getReview({ actor, itemId: "item-a", accountId: "account-b" }));
  assert.equal(calls.length, 1);
});

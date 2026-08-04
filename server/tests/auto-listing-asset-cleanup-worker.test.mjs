import assert from "node:assert/strict";
import test from "node:test";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createMemoryAssetCleanupRepository } from "../auto-listing-asset-cleanup-repository.mjs";
import { createAutoListingAssetCleanupWorker } from "../auto-listing-asset-cleanup-worker.mjs";

const hash = (character) => character.repeat(64);
function obligation(slotKey) {
  const value = {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
    visualGroupKey: "main", slotKey, attemptIdentityHash: hash("a"),
    inputHash: hash("b"), attemptNo: 1, contentHash: hash("c"),
    reason: "RECORD_STORED_FAILED", originalErrorCode: "AUTO_LISTING_ASSET_REPOSITORY_FAILED",
  };
  value.objectKey = buildGeneratedAssetObjectKey(value);
  return value;
}

test("cleanup worker isolates removal errors and reports claimed/completed/failed", async () => {
  const now = Date.parse("2026-08-04T00:00:00.000Z");
  let sequence = 0;
  const repository = createMemoryAssetCleanupRepository({ now: () => now, token: () => `claim-${++sequence}` });
  const first = await repository.recordAssetCleanupRequired(obligation("first"));
  const second = await repository.recordAssetCleanupRequired(obligation("second"));
  const removed = [];
  const worker = createAutoListingAssetCleanupWorker({
    repository,
    storage: {
      async removeObject(objectKey) {
        removed.push(objectKey);
        if (objectKey === first.objectKey) throw Object.assign(new Error("secret backend detail"), { code: "E_STORAGE_OFFLINE" });
      },
    },
    logger: { error() {} },
  });
  const summary = await worker.run({ accountId: "account-a", workerId: "worker-a", limit: 2, leaseMs: 5_000 });
  assert.deepEqual(summary, { claimed: 2, completed: 1, failed: 1 });
  assert.deepEqual(removed, [first.objectKey, second.objectKey]);
  const rows = await repository.listAssetCleanupObligations({ accountId: "account-a" });
  const failed = rows.find((row) => row.objectKey === first.objectKey);
  const completed = rows.find((row) => row.objectKey === second.objectKey);
  assert.equal(failed.status, "PENDING");
  assert.equal(completed.status, "COMPLETED");
  assert.equal(failed.lastErrorCode, "AUTO_LISTING_ASSET_REMOVE_FAILED");
  assert.equal(failed.attemptCount, 1);
  assert.equal(failed.nextRetryAt, now + 5 * 60_000);
});

test("cleanup worker validates scope and has no cross-account or duplicate side effects", async () => {
  const now = Date.parse("2026-08-04T00:00:00.000Z");
  const repository = createMemoryAssetCleanupRepository({ now: () => now, token: () => "claim-a" });
  await repository.recordAssetCleanupRequired(obligation("only"));
  let removals = 0;
  const worker = createAutoListingAssetCleanupWorker({
    repository,
    storage: { async removeObject() { removals += 1; } },
  });
  assert.deepEqual(await worker.run({ accountId: "account-b", workerId: "worker-b", limit: 10, leaseMs: 5_000 }), { claimed: 0, completed: 0, failed: 0 });
  assert.deepEqual(await worker.run({ accountId: "account-a", workerId: "worker-a", limit: 10, leaseMs: 5_000 }), { claimed: 1, completed: 1, failed: 0 });
  assert.deepEqual(await worker.run({ accountId: "account-a", workerId: "worker-a", limit: 10, leaseMs: 5_000 }), { claimed: 0, completed: 0, failed: 0 });
  assert.equal(removals, 1);
  await assert.rejects(worker.run({ accountId: " account-a", workerId: "worker-a", limit: 10, leaseMs: 5_000 }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_INVALID");
  await assert.rejects(worker.run({ accountId: "account-a", workerId: "worker-a", limit: 10, leaseMs: 5_000, now }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_INVALID");
});

test("cleanup worker rejects a claimed cross-account object key without deleting it", async () => {
  let removals = 0;
  let logs = 0;
  const foreign = {
    ...obligation("foreign"), id: "cleanup-a", accountId: "account-b", status: "PROCESSING",
    claimOwner: "worker-a", claimToken: "claim-a",
  };
  const worker = createAutoListingAssetCleanupWorker({
    repository: {
      async claimAssetCleanupObligations() {
        return [foreign];
      },
      async completeAssetCleanup() {},
      async failAssetCleanup() {},
    },
    storage: { async removeObject() { removals += 1; } },
    logger: { error() { logs += 1; return Promise.reject(new Error("logger offline")); } },
  });
  assert.deepEqual(
    await worker.run({ accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 5_000 }),
    { claimed: 1, completed: 0, failed: 1 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(removals, 0);
  assert.equal(logs, 1);
});

test("cleanup worker isolates complete and fail persistence errors and continues its batch", async () => {
  const rows = ["complete-fails", "remove-fails", "success"].map((slotKey, index) => ({
    ...obligation(slotKey), id: `cleanup-${index}`, status: "PROCESSING", attemptCount: 1,
    claimOwner: "worker-a", claimToken: `claim-${index}`,
  }));
  const completed = [];
  const failed = [];
  const removals = [];
  let logs = 0;
  const worker = createAutoListingAssetCleanupWorker({
    repository: {
      async claimAssetCleanupObligations() { return rows; },
      async completeAssetCleanup(value) {
        completed.push(value.id);
        if (value.id === "cleanup-0") throw new Error("complete offline");
      },
      async failAssetCleanup(value) {
        failed.push(value.id);
        if (value.id === "cleanup-1") throw new Error("fail offline");
      },
    },
    storage: {
      async removeObject(objectKey, options) {
        assert.deepEqual(options, { accountId: "account-a" });
        removals.push(objectKey);
        if (objectKey === rows[1].objectKey) throw new Error("remove offline");
      },
    },
    logger: { error() { logs += 1; return Promise.reject(new Error("logger offline")); } },
  });
  const summary = await worker.run({
    accountId: "account-a", workerId: "worker-a", limit: 3, leaseMs: 5_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(summary, { claimed: 3, completed: 1, failed: 2 });
  assert.equal(summary.claimed, summary.completed + summary.failed);
  assert.deepEqual(completed, ["cleanup-0", "cleanup-2"]);
  assert.deepEqual(failed, ["cleanup-1"]);
  assert.equal(removals.length, 3);
  assert.equal(logs, 2);
});

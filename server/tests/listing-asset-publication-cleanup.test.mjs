import assert from "node:assert/strict";
import test from "node:test";

import { createListingAssetPublicationCleanupWorker } from "../listing-asset-publication-cleanup.mjs";

const task = Object.freeze({
  id: "cleanup-a", accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
  assetId: "asset-a", contentHash: "a".repeat(64), publicObjectKey: "listing-media/v1/aa/file.png",
  publicationVersion: "LISTING_MEDIA_V1", publicBaseUrl: "https://media.example.com/ozon/",
  publicPrefix: "listing-media/v1", reasonCode: "RECORD_UNCERTAIN", status: "DELETING",
  attemptCount: 1, leaseToken: "lease-a", leaseExpiresAt: "2026-08-08T00:05:00.000Z", claimed: true,
});

function harness(claim = task) {
  const calls = [];
  const events = [];
  const repository = {
    async claimCleanup(input) { calls.push(["claim", input]); return claim; },
    async completeCleanup(input) { calls.push(["complete", input]); return { ...task, status: "CLEANED", leaseToken: null, leaseExpiresAt: null }; },
    async failCleanup(input) { calls.push(["fail", input]); return { ...task, status: "PENDING", leaseToken: null, leaseExpiresAt: null }; },
  };
  const worker = createListingAssetPublicationCleanupWorker({
    repository,
    async removePublicObject(input) { calls.push(["remove", input]); },
    resolvePolicy(version) {
      calls.push(["policy", version]);
      return { publicationVersion: "LISTING_MEDIA_V1", baseUrl: "https://media.example.com/ozon/", prefix: "listing-media/v1" };
    },
    logger: { warn(event) { events.push(event); } },
  });
  return { worker, calls, events };
}

const request = { accountId: "account-a", cleanupId: "cleanup-a", workerId: "worker-a" };

test("cleanup worker deletes only a claimed, unreferenced task under its frozen policy", async () => {
  const h = harness();
  const result = await h.worker.processCleanup(request);
  assert.equal(result.status, "CLEANED");
  assert.deepEqual(h.calls.map(([name]) => name), ["claim", "policy", "remove", "complete"]);
  assert.deepEqual(h.calls.find(([name]) => name === "remove")[1], { key: task.publicObjectKey });
});

test("referenced, already cleaned, or busy tasks are idempotent and never delete", async () => {
  for (const row of [
    { ...task, status: "REFERENCED", claimed: false, leaseToken: null, leaseExpiresAt: null },
    { ...task, status: "CLEANED", claimed: false, leaseToken: null, leaseExpiresAt: null },
  ]) {
    const h = harness(row);
    const result = await h.worker.processCleanup(request);
    assert.equal(result.status, row.status);
    assert.deepEqual(h.calls.map(([name]) => name), ["claim"]);
  }
  const busy = harness({ ...task, claimed: false });
  await assert.rejects(busy.worker.processCleanup(request), { code: "LISTING_ASSET_PUBLICATION_CLEANUP_BUSY" });
  assert.equal(busy.calls.some(([name]) => name === "remove"), false);
});

test("policy mismatch and ambiguous removal persist retry state without secret/key logs", async () => {
  const mismatch = harness();
  mismatch.worker = createListingAssetPublicationCleanupWorker({
    repository: {
      async claimCleanup() { return task; },
      async completeCleanup() { throw new Error("must not run"); },
      async failCleanup(input) { mismatch.calls.push(["fail", input]); return { ...task, status: "PENDING" }; },
    },
    async removePublicObject() { mismatch.calls.push(["remove"]); },
    resolvePolicy() { return { publicationVersion: "LISTING_MEDIA_V2", baseUrl: task.publicBaseUrl, prefix: task.publicPrefix }; },
    logger: { warn(event) { mismatch.events.push(event); } },
  });
  await assert.rejects(mismatch.worker.processCleanup(request), { code: "LISTING_ASSET_PUBLICATION_CLEANUP_POLICY_UNAVAILABLE" });
  assert.equal(mismatch.calls.some(([name]) => name === "remove"), false);
  assert.equal(mismatch.calls.at(-1)[1].errorCode, "LISTING_ASSET_PUBLICATION_CLEANUP_POLICY_UNAVAILABLE");

  const failed = harness();
  failed.worker = createListingAssetPublicationCleanupWorker({
    repository: {
      async claimCleanup() { return task; },
      async completeCleanup() { throw new Error("must not run"); },
      async failCleanup(input) { failed.calls.push(["fail", input]); return { ...task, status: "PENDING" }; },
    },
    async removePublicObject() { throw new Error(`storage failed at ${task.publicObjectKey}`); },
    resolvePolicy() { return { publicationVersion: task.publicationVersion, baseUrl: task.publicBaseUrl, prefix: task.publicPrefix }; },
    logger: { warn(event) { failed.events.push(event); } },
  });
  await assert.rejects(failed.worker.processCleanup(request), { code: "LISTING_ASSET_PUBLICATION_CLEANUP_FAILED" });
  assert.equal(failed.calls.at(-1)[1].errorCode, "LISTING_ASSET_PUBLICATION_CLEANUP_FAILED");
  assert.equal(JSON.stringify(failed.events).includes(task.publicObjectKey), false);
  assert.equal(JSON.stringify(failed.events).includes("storage failed"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createMemoryAssetCleanupRepository, createPostgresAssetCleanupRepository } from "../auto-listing-asset-cleanup-repository.mjs";

const hash = (character) => character.repeat(64);
const cleanup = (overrides = {}) => {
  const value = {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a",
    visualGroupKey: "main", slotKey: "cover", attemptIdentityHash: hash("a"),
    inputHash: hash("b"), attemptNo: 2, contentHash: hash("c"),
    reason: "RECORD_STORED_FAILED", originalErrorCode: "AUTO_LISTING_ASSET_REPOSITORY_FAILED",
    ...overrides,
  };
  value.objectKey ??= buildGeneratedAssetObjectKey(value);
  return value;
};

test("cleanup obligations are durable-shaped, account-scoped, and idempotent by account plus object key", async () => {
  let timestamp = 1_000;
  const repository = createMemoryAssetCleanupRepository({ now: () => timestamp++ });
  const first = await repository.recordAssetCleanupRequired(cleanup());
  const repeated = await repository.recordAssetCleanupRequired(cleanup());
  assert.deepEqual(repeated, first);
  assert.equal(first.status, "PENDING");
  assert.equal(first.attemptCount, 0);
  assert.equal(first.createdAt, 1_000);
  assert.equal(first.updatedAt, 1_000);
  assert.equal(first.nextRetryAt, 1_000);
  assert.deepEqual((await repository.listAssetCleanupObligations({ accountId: "account-a" })).map(({ objectKey }) => objectKey), [first.objectKey]);
  assert.deepEqual(await repository.listAssetCleanupObligations({ accountId: "account-b" }), []);
  await assert.rejects(repository.recordAssetCleanupRequired(cleanup({ reason: "OTHER_REASON" })), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_CONFLICT");
});

test("cleanup repository rejects malformed or cross-account object identity without persisting", async () => {
  const repository = createMemoryAssetCleanupRepository();
  for (const mutate of [
    (value) => { value.accountId = " account-a"; },
    (value) => { value.attemptIdentityHash = "bad"; },
    (value) => { value.attemptNo = 0; },
    (value) => { value.originalErrorCode = "bad\ncode"; },
    (value) => { value.objectKey = buildGeneratedAssetObjectKey({ ...value, accountId: "account-b" }); },
  ]) {
    const value = cleanup(); mutate(value);
    await assert.rejects(repository.recordAssetCleanupRequired(value), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_INVALID");
  }
  assert.deepEqual(await repository.listAssetCleanupObligations({ accountId: "account-a" }), []);
  await assert.rejects(repository.listAssetCleanupObligations({ accountId: " account-a" }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_INVALID");
});

test("cleanup claim leases are account-scoped, exclusive, CAS-fenced, and reclaimable after expiry", async () => {
  let timestamp = Date.parse("2026-08-04T00:00:00.000Z");
  let sequence = 0;
  const repository = createMemoryAssetCleanupRepository({ now: () => timestamp, token: () => `claim-${++sequence}` });
  const pending = await repository.recordAssetCleanupRequired(cleanup());
  const [claimed] = await repository.claimAssetCleanupObligations({
    accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 1_000, now: timestamp,
  });
  assert.equal(claimed.id, pending.id);
  assert.equal(claimed.status, "PROCESSING");
  assert.equal(claimed.attemptCount, 1);
  assert.equal(claimed.claimOwner, "worker-a");
  assert.equal(claimed.claimToken, "claim-1:1");
  assert.equal(claimed.claimExpiresAt, timestamp + 1_000);
  assert.deepEqual(await repository.claimAssetCleanupObligations({
    accountId: "account-a", workerId: "worker-b", limit: 1, leaseMs: 1_000, now: timestamp,
  }), []);
  assert.deepEqual(await repository.claimAssetCleanupObligations({
    accountId: "account-b", workerId: "worker-b", limit: 1, leaseMs: 1_000, now: timestamp + 1_001,
  }), []);
  timestamp += 1_001;
  const [reclaimed] = await repository.claimAssetCleanupObligations({
    accountId: "account-a", workerId: "worker-b", limit: 1, leaseMs: 1_000, now: timestamp,
  });
  assert.equal(reclaimed.claimToken, "claim-2:2");
  assert.equal(reclaimed.attemptCount, 2);
  await assert.rejects(repository.completeAssetCleanup({
    accountId: "account-a", id: pending.id, workerId: "worker-a", claimToken: claimed.claimToken, now: timestamp,
  }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_CLAIM_REJECTED");
  const completed = await repository.completeAssetCleanup({
    accountId: "account-a", id: pending.id, workerId: "worker-b", claimToken: reclaimed.claimToken, now: timestamp,
  });
  assert.equal(completed.status, "COMPLETED");
  await assert.rejects(repository.completeAssetCleanup({
    accountId: "account-a", id: pending.id, workerId: "worker-b", claimToken: reclaimed.claimToken, now: timestamp,
  }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_CLAIM_REJECTED");
});

test("PostgreSQL cleanup claim rejects an oversized nonce before a database query", async () => {
  let queries = 0;
  const repository = createPostgresAssetCleanupRepository({
    pool: { async query() { queries += 1; return { rows: [] }; } },
    token: () => "x".repeat(121),
  });
  await assert.rejects(repository.claimAssetCleanupObligations({
    accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 5_000,
  }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_INVALID");
  assert.equal(queries, 0);
});

test("cleanup failure releases the lease with bounded deterministic exponential backoff", async () => {
  let timestamp = Date.parse("2026-08-04T00:00:00.000Z");
  let sequence = 0;
  const repository = createMemoryAssetCleanupRepository({
    now: () => timestamp,
    token: () => `claim-${++sequence}`,
    baseRetryMs: 1_000,
    maxRetryMs: 4_000,
  });
  await repository.recordAssetCleanupRequired(cleanup());
  for (const [attempt, delay] of [[1, 1_000], [2, 2_000], [3, 4_000], [4, 4_000]]) {
    const [claimed] = await repository.claimAssetCleanupObligations({
      accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 500, now: timestamp,
    });
    assert.equal(claimed.attemptCount, attempt);
    const failed = await repository.failAssetCleanup({
      accountId: "account-a", id: claimed.id, workerId: "worker-a", claimToken: claimed.claimToken,
      errorCode: "AUTO_LISTING_ASSET_REMOVE_FAILED", now: timestamp,
    });
    assert.equal(failed.status, "PENDING");
    assert.equal(failed.lastErrorCode, "AUTO_LISTING_ASSET_REMOVE_FAILED");
    assert.equal(failed.nextRetryAt, timestamp + delay);
    assert.deepEqual(await repository.claimAssetCleanupObligations({
      accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 500, now: timestamp + delay - 1,
    }), []);
    timestamp += delay;
  }
});

test("cleanup failure accepts only a closed stable error code and preserves the active lease on rejection", async () => {
  for (const errorCode of ["backend secret", "lower_case", " BAD_CODE", "BAD\nCODE", "A".repeat(121)]) {
    const repository = createMemoryAssetCleanupRepository({ token: () => "claim-a" });
    await repository.recordAssetCleanupRequired(cleanup());
    const [claimed] = await repository.claimAssetCleanupObligations({
      accountId: "account-a", workerId: "worker-a", limit: 1, leaseMs: 5_000,
    });
    await assert.rejects(repository.failAssetCleanup({
      accountId: "account-a", id: claimed.id, workerId: "worker-a", claimToken: claimed.claimToken, errorCode,
    }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_INVALID", errorCode);
    const [row] = await repository.listAssetCleanupObligations({ accountId: "account-a" });
    assert.equal(row.status, "PROCESSING");
    assert.equal(row.lastErrorCode, undefined);
  }
});

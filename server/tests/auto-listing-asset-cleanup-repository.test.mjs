import assert from "node:assert/strict";
import test from "node:test";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createMemoryAssetCleanupRepository } from "../auto-listing-asset-cleanup-repository.mjs";

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

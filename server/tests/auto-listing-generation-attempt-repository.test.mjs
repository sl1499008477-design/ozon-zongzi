import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryGenerationAttemptRepository } from "../auto-listing-generation-attempt-repository.mjs";

const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", visualGroupKey: "group-a", slotKey: "main" });
const attemptIdentityHash = "a".repeat(64);
const inputHash = "b".repeat(64);
const complete = (lease, identity = attemptIdentityHash) => ({ ...scope, attemptIdentityHash: identity, inputHash, ...lease, objectKey: "auto-listing/a.png", contentHash: "c".repeat(64), contentType: "image/png", width: 768, height: 1024, size: 123, profileId: "profile-a", profileVersion: 1, modelName: "image-a", planHash: "d".repeat(64), sourceHash: "e".repeat(64), strategyHash: "f".repeat(64), configHash: "1".repeat(64), visualGroupsHash: "2".repeat(64), promptTemplateVersion: "v1", checkerEvidence: { ok: true }, sourceAssetEvidence: [] });

test("one preliminary identity owns the lease, binds final bytes, and reuses accepted work", async () => {
  let timestamp = 100; let sequence = 0;
  const repository = createMemoryGenerationAttemptRepository({ now: () => timestamp, leaseMs: 10, token: () => `lease-${++sequence}` });
  const first = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, maxAttempts: 3 });
  assert.deepEqual(await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, maxAttempts: 3 }), { status: "IN_PROGRESS" });
  timestamp = 111;
  const retry = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, maxAttempts: 3 });
  assert.deepEqual(retry, { status: "RESERVED", attemptNo: 2, leaseToken: "lease-2" });
  assert.deepEqual(await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash, inputHash, ...retry }), { status: "BOUND", inputHash });
  const accepted = await repository.completeGenerationAttempt(complete(retry));
  assert.equal(accepted.status, "ACCEPTED");
  const reused = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, maxAttempts: 3 });
  assert.equal(reused.status, "EXISTING_ACCEPTED"); assert.equal(reused.record.attemptNo, 2);
});

test("CAS terminal transitions reject wrong scope or lease and do not mutate another item", async () => {
  const repository = createMemoryGenerationAttemptRepository({ token: () => "lease-a" });
  const lease = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, maxAttempts: 2 });
  await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash, inputHash, ...lease });
  await assert.rejects(repository.completeGenerationAttempt(complete({ ...lease, accountId: "account-b" })), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  await assert.rejects(repository.rejectGenerationAttempt({ ...scope, attemptIdentityHash, inputHash, ...lease, leaseToken: "wrong", code: "POLICY" }), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  assert.equal(repository.snapshot()[0].status, "GENERATING");
});

test("final input binding returns accepted reuse or a stable conflict before duplicate side effects", async () => {
  let sequence = 0;
  const repository = createMemoryGenerationAttemptRepository({ token: () => `lease-${++sequence}` });
  const firstIdentity = "3".repeat(64);
  const secondIdentity = "4".repeat(64);
  const first = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash: firstIdentity, maxAttempts: 3 });
  const second = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash: secondIdentity, maxAttempts: 3 });
  assert.deepEqual(await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash: firstIdentity, inputHash, ...first }), { status: "BOUND", inputHash });
  assert.deepEqual(await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash: secondIdentity, inputHash, ...second }), { status: "VERSION_CONFLICT" });
  await repository.completeGenerationAttempt(complete(first, firstIdentity));
  const thirdIdentity = "5".repeat(64);
  const third = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash: thirdIdentity, maxAttempts: 3 });
  const reused = await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash: thirdIdentity, inputHash, ...third });
  assert.equal(reused.status, "EXISTING_ACCEPTED");
  assert.equal(reused.record.inputHash, inputHash);
});

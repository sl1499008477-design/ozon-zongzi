import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryGenerationAttemptRepository } from "../auto-listing-generation-attempt-repository.mjs";

const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", visualGroupKey: "group-a", slotKey: "main", inputHash: "a".repeat(64) });
const complete = (lease) => ({ ...scope, ...lease, objectKey: "auto-listing/a.png", contentHash: "b".repeat(64), contentType: "image/png", width: 768, height: 1024, size: 123, profileId: "profile-a", profileVersion: 1, modelName: "image-a", planHash: "c".repeat(64), sourceHash: "d".repeat(64), strategyHash: "e".repeat(64), configHash: "f".repeat(64), visualGroupsHash: "1".repeat(64), promptTemplateVersion: "v1", checkerEvidence: { ok: true }, sourceAssetEvidence: [] });

test("one active scoped input owns the lease, expired work creates a new attempt, and accepted work is immutable reuse", async () => {
  let timestamp = 100; let sequence = 0;
  const repository = createMemoryGenerationAttemptRepository({ now: () => timestamp, leaseMs: 10, token: () => `lease-${++sequence}` });
  const first = await repository.reserveGenerationAttempt({ ...scope, maxAttempts: 3 });
  assert.deepEqual(await repository.reserveGenerationAttempt({ ...scope, maxAttempts: 3 }), { status: "IN_PROGRESS" });
  timestamp = 111;
  const retry = await repository.reserveGenerationAttempt({ ...scope, maxAttempts: 3 });
  assert.deepEqual(retry, { status: "RESERVED", attemptNo: 2, leaseToken: "lease-2" });
  const accepted = await repository.completeGenerationAttempt(complete(retry));
  assert.equal(accepted.status, "ACCEPTED");
  const reused = await repository.reserveGenerationAttempt({ ...scope, maxAttempts: 3 });
  assert.equal(reused.status, "EXISTING_ACCEPTED"); assert.equal(reused.record.attemptNo, 2);
});

test("CAS terminal transitions reject wrong scope or lease and do not mutate another item", async () => {
  const repository = createMemoryGenerationAttemptRepository({ token: () => "lease-a" });
  const lease = await repository.reserveGenerationAttempt({ ...scope, maxAttempts: 2 });
  await assert.rejects(repository.completeGenerationAttempt(complete({ ...lease, accountId: "account-b" })), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  await assert.rejects(repository.rejectGenerationAttempt({ ...scope, ...lease, leaseToken: "wrong", code: "POLICY" }), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  assert.equal(repository.snapshot()[0].status, "GENERATING");
});

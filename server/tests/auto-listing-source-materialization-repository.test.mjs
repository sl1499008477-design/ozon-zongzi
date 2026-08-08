import assert from "node:assert/strict";
import test from "node:test";

const HASHES = Object.freeze({ source: "a".repeat(64), input: "b".repeat(64), content: "c".repeat(64) });
const scope = Object.freeze({
  accountId: "account-a",
  jobId: "job-a",
  itemId: "item-a",
  parentPlanId: "plan-a",
  sourceAssetId: "source-a",
  sourceRefHash: HASHES.source,
  inputHash: HASHES.input,
  expectedStatusVersion: 4,
});

const repositoryModule = () => import(`../auto-listing-source-materialization-repository.mjs?test=${Date.now()}-${Math.random()}`);
const segment = (value) => Buffer.from(value, "utf8").toString("base64url");
const objectKey = (attemptNo = 1, contentHash = HASHES.content) => [
  "auto-listing/source/v1",
  ...[scope.accountId, scope.jobId, scope.itemId, scope.parentPlanId, scope.sourceAssetId].map(segment),
  scope.sourceRefHash,
  `attempt-${attemptNo}`,
  scope.inputHash,
  `${contentHash}.png`,
].join("/");
const evidence = (lease, overrides = {}) => ({
  ...scope,
  attemptId: lease.attemptId,
  attemptNo: lease.attemptNo,
  leaseToken: lease.leaseToken,
  objectKeyVersion: "SOURCE_V1",
  objectKey: objectKey(lease.attemptNo),
  contentHash: HASHES.content,
  contentType: "image/png",
  width: 900,
  height: 1200,
  sizeBytes: 1234,
  ...overrides,
});

test("reserve is closed, validates the complete account/job/item/plan/source fence and returns the frozen lease", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  const repository = createMemorySourceMaterializationRepository({
    now: () => 1_000,
    token: () => "lease-a",
    id: () => "materialization-a",
  });
  const reserved = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  assert.deepEqual(reserved, {
    status: "RESERVED",
    attemptId: "materialization-a",
    attemptNo: 1,
    leaseToken: "lease-a:1",
    leaseExpiresAt: "1970-01-01T00:01:01.000Z",
    ...scope,
  });
  for (const invalid of [
    { ...scope, maxAttempts: 3, unexpected: true },
    { ...scope, maxAttempts: 3, accountId: "account-b" },
    { ...scope, maxAttempts: 3, sourceRefHash: "not-a-hash" },
    { ...scope, maxAttempts: 3, accountId: "account\u0000a" },
    { ...scope, maxAttempts: 3, expectedStatusVersion: 0 },
    { ...scope, maxAttempts: 4 },
  ]) {
    if (invalid.accountId === "account-b") invalid.accountId = "https://secret.invalid/?token=x";
    await assert.rejects(repository.reserveSourceMaterialization(invalid), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID" });
  }
});

test("cancelled and stale reservations do not create attempts", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  let state = { status: "CANCELLED", statusVersion: 4 };
  const repository = createMemorySourceMaterializationRepository({ readItemState: async () => state });
  assert.deepEqual(await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 }), { status: "CANCELLED" });
  state = { status: "PLANNING", statusVersion: 5 };
  assert.deepEqual(await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 }), { status: "STALE" });
  assert.deepEqual(repository.snapshot(), []);
});

test("one active attempt exists, an expired database-time lease is reclaimed, and stale ABA tokens fail", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  let time = 2_000; let nonce = 0;
  const repository = createMemorySourceMaterializationRepository({
    now: () => time,
    leaseMs: 10,
    token: () => `lease-${++nonce}`,
    id: () => `materialization-${nonce}`,
  });
  const first = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  assert.deepEqual(await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 }), { status: "IN_PROGRESS" });
  time = 2_011;
  const second = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  assert.equal(second.attemptNo, 2);
  assert.notEqual(second.leaseToken, first.leaseToken);
  await assert.rejects(repository.failSourceMaterialization({
    ...scope, attemptId: first.attemptId, attemptNo: first.attemptNo, leaseToken: first.leaseToken,
    errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED", errorRetryable: true,
  }), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED" });
  assert.equal(repository.snapshot()[0].errorCode, "AUTO_LISTING_SOURCE_LEASE_EXPIRED");
});

test("stored evidence is an exact SOURCE_V1 CAS and accepted evidence is immutable", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  const repository = createMemorySourceMaterializationRepository({ now: () => 3_000, token: () => "lease-a", id: () => "materialization-a" });
  const lease = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  const stored = await repository.recordStoredSourceMaterialization(evidence(lease));
  assert.equal(stored.status, "STORED");
  assert.equal(stored.objectKeyVersion, "SOURCE_V1");
  await assert.rejects(repository.completeSourceMaterialization(evidence(lease, { sizeBytes: 999 })), {
    code: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED",
  });
  const accepted = await repository.completeSourceMaterialization(evidence(lease));
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.leaseToken, null);
  assert.equal(accepted.acceptedAt, "1970-01-01T00:00:03.000Z");
  await assert.rejects(repository.failSourceMaterialization({
    ...scope, attemptId: lease.attemptId, attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
    errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED", errorRetryable: true,
  }), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED" });
});

test("stored evidence enforces the same 40 million pixel limit as PostgreSQL", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  const repository = createMemorySourceMaterializationRepository({
    now: () => 3_000,
    token: () => "lease-pixels",
    id: () => "materialization-pixels",
  });
  const lease = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  await assert.rejects(
    repository.recordStoredSourceMaterialization(evidence(lease, { width: 100_000, height: 100_000 })),
    { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID" },
  );
  assert.equal(repository.snapshot()[0].status, "MATERIALIZING");
});

test("stored and accepted rows allow PNG, JPEG and WebP only with the exact versioned object key", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  for (const [contentType, extension] of [["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"]]) {
    const repository = createMemorySourceMaterializationRepository({ token: () => `lease-${extension}`, id: () => `materialization-${extension}` });
    const lease = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
    const current = evidence(lease, { contentType });
    current.objectKey = current.objectKey.replace(/\.png$/u, `.${extension}`);
    assert.equal((await repository.recordStoredSourceMaterialization(current)).status, "STORED");
    assert.equal((await repository.completeSourceMaterialization(current)).status, "ACCEPTED");
  }
  for (const mutation of [
    (value) => { value.objectKeyVersion = "LEGACY_V1"; },
    (value) => { value.objectKey = value.objectKey.replace(`/${segment(scope.accountId)}/`, `/${segment("account-b")}/`); },
    (value) => { value.objectKey = `${value.objectKey}?source=https://private.invalid/secret`; },
    (value) => { value.contentType = "image/gif"; },
  ]) {
    const repository = createMemorySourceMaterializationRepository({ token: () => "lease-invalid", id: () => "materialization-invalid" });
    const lease = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
    const value = evidence(lease); mutation(value);
    await assert.rejects(repository.recordStoredSourceMaterialization(value), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID" });
    assert.equal(repository.snapshot()[0].status, "MATERIALIZING");
  }
});

test("accepted replay returns full verified evidence and consumes no new attempt", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  let nonce = 0;
  const repository = createMemorySourceMaterializationRepository({ token: () => `lease-${++nonce}`, id: () => `materialization-${nonce}` });
  const lease = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  await repository.recordStoredSourceMaterialization(evidence(lease));
  const accepted = await repository.completeSourceMaterialization(evidence(lease));
  const replay = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  assert.equal(replay.status, "EXISTING_ACCEPTED");
  assert.deepEqual(replay.record, accepted);
  assert.equal(nonce, 1);
  assert.equal(repository.snapshot().length, 1);
});

test("an expired STORED attempt is reclaimed with a fresh fence and zero-new-I/O evidence", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  let time = 3_500; let nonce = 0;
  const repository = createMemorySourceMaterializationRepository({
    now: () => time, leaseMs: 10, token: () => `lease-${++nonce}`, id: () => `materialization-${nonce}`,
  });
  const first = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  const stored = await repository.recordStoredSourceMaterialization(evidence(first));
  time = 3_511;
  const resumed = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  assert.equal(resumed.status, "RESERVED_STORED");
  assert.deepEqual(Object.keys(resumed).sort(), ["record", "status"]);
  assert.equal(resumed.record.attemptId, first.attemptId);
  assert.equal(resumed.record.attemptNo, first.attemptNo);
  assert.notEqual(resumed.record.leaseToken, first.leaseToken);
  assert.equal(resumed.record.objectKey, stored.objectKey);
  assert.equal(repository.snapshot().length, 1);
  assert.equal((await repository.completeSourceMaterialization(evidence(resumed.record))).status, "ACCEPTED");
});

test("three failed attempts are terminal and the fourth reservation is exhausted", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  let nonce = 0;
  const repository = createMemorySourceMaterializationRepository({ token: () => `lease-${++nonce}`, id: () => `materialization-${nonce}` });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const lease = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
    assert.equal(lease.attemptNo, attempt);
    const failed = await repository.failSourceMaterialization({
      ...scope, attemptId: lease.attemptId, attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
      errorCode: attempt === 3 ? "AUTO_LISTING_SOURCE_IMAGE_INVALID" : "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
      errorRetryable: attempt < 3,
    });
    assert.equal(failed.status, "FAILED");
  }
  assert.deepEqual(await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 }), { status: "ATTEMPTS_EXHAUSTED" });
});

test("owner transitions require unexpired lease, unchanged statusVersion and closed safe failure evidence", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  let time = 4_000;
  let state = { status: "PLANNING", statusVersion: 4 };
  const repository = createMemorySourceMaterializationRepository({ now: () => time, leaseMs: 10, readItemState: async () => state, token: () => "lease-a" });
  const lease = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  for (const changed of [
    { accountId: "account-b" },
    { parentPlanId: "plan-b" },
    { sourceAssetId: "source-b" },
    { sourceRefHash: "d".repeat(64) },
    { inputHash: "e".repeat(64) },
    { attemptNo: 2 },
    { attemptId: "other" },
    { leaseToken: "stale" },
  ]) {
    await assert.rejects(repository.failSourceMaterialization({
      ...scope, attemptId: lease.attemptId, attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
      errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED", errorRetryable: true, ...changed,
    }), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED" });
  }
  await assert.rejects(repository.failSourceMaterialization({
    ...scope, attemptId: lease.attemptId, attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
    errorCode: "https://secret.invalid/?token=x", errorRetryable: true,
  }), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID" });
  state = { status: "PLANNING", statusVersion: 5 };
  await assert.rejects(repository.recordStoredSourceMaterialization(evidence(lease)), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED" });
  state = { status: "PLANNING", statusVersion: 4 }; time = 4_011;
  await assert.rejects(repository.failSourceMaterialization({
    ...scope, attemptId: lease.attemptId, attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
    errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED", errorRetryable: true,
  }), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED" });
});

test("accepted listing is exact-plan and account scoped, bounded, sorted and returns no URL plaintext", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  let nonce = 0;
  const repository = createMemorySourceMaterializationRepository({ token: () => `lease-${++nonce}`, id: () => `materialization-${nonce}` });
  for (const sourceAssetId of ["source-b", "source-a"]) {
    const currentScope = { ...scope, sourceAssetId };
    const lease = await repository.reserveSourceMaterialization({ ...currentScope, maxAttempts: 3 });
    const currentEvidence = evidence({ ...lease, sourceAssetId }, { sourceAssetId });
    currentEvidence.objectKey = objectKey(lease.attemptNo).replace(segment(scope.sourceAssetId), segment(sourceAssetId));
    await repository.recordStoredSourceMaterialization(currentEvidence);
    await repository.completeSourceMaterialization(currentEvidence);
  }
  const rows = await repository.listAcceptedSourceMaterializations({ accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-a", expectedStatusVersion: 4 });
  assert.deepEqual(rows.map((row) => row.sourceAssetId), ["source-a", "source-b"]);
  assert.doesNotMatch(JSON.stringify(rows), /https?:|query|redirect|responseBody/i);
  assert.deepEqual(await repository.listAcceptedSourceMaterializations({ accountId: "account-b", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-a", expectedStatusVersion: 4 }), []);
  await assert.rejects(repository.listAcceptedSourceMaterializations({ accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-a", expectedStatusVersion: 4, extra: true }), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID" });
});

test("accepted listing is fenced by the exact expected status version", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  let nonce = 0;
  const repository = createMemorySourceMaterializationRepository({
    token: () => `lease-version-${++nonce}`,
    id: () => `materialization-version-${nonce}`,
  });
  for (const expectedStatusVersion of [4, 5]) {
    const currentScope = { ...scope, expectedStatusVersion };
    const lease = await repository.reserveSourceMaterialization({ ...currentScope, maxAttempts: 3 });
    const currentEvidence = evidence(lease, { expectedStatusVersion });
    await repository.recordStoredSourceMaterialization(currentEvidence);
    await repository.completeSourceMaterialization(currentEvidence);
  }
  const rows = await repository.listAcceptedSourceMaterializations({
    accountId: scope.accountId,
    jobId: scope.jobId,
    itemId: scope.itemId,
    parentPlanId: scope.parentPlanId,
    expectedStatusVersion: 4,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].expectedStatusVersion, 4);
});

test("source-object cleanup obligations are account scoped, exact and idempotent", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  const repository = createMemorySourceMaterializationRepository({ token: () => "lease-cleanup", id: () => "materialization-cleanup" });
  const lease = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  const orphan = evidence(lease);
  const request = {
    accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, parentPlanId: scope.parentPlanId,
    sourceAssetId: scope.sourceAssetId, materializationAttemptId: lease.attemptId,
    sourceRefHash: scope.sourceRefHash, inputHash: scope.inputHash, expectedStatusVersion: scope.expectedStatusVersion,
    attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
    objectKeyVersion: orphan.objectKeyVersion, objectKey: orphan.objectKey, contentHash: orphan.contentHash,
    contentType: orphan.contentType, width: orphan.width, height: orphan.height, sizeBytes: orphan.sizeBytes,
    reasonCode: "AUTO_LISTING_SOURCE_OBJECT_UNREFERENCED",
    originalErrorCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED",
  };
  const first = await repository.recordSourceObjectCleanupRequired(request);
  const replay = await repository.recordSourceObjectCleanupRequired(request);
  assert.equal(first.status, "PENDING");
  assert.deepEqual(replay, first);
  assert.deepEqual(Object.fromEntries(Object.keys(request).map((key) => [key, first[key]])), request);
  assert.equal(repository.snapshot()[0].status, "MATERIALIZING");
  assert.doesNotMatch(JSON.stringify(first), /https?:|sourceUrl|redirect|responseBody/i);
  await assert.rejects(repository.recordSourceObjectCleanupRequired({ ...request, accountId: "account-b" }), {
    code: "AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT",
  });
});

test("an expired source-materialization lease cannot create a new cleanup obligation", async () => {
  const { createMemorySourceMaterializationRepository } = await repositoryModule();
  let clock = 1_000;
  const repository = createMemorySourceMaterializationRepository({
    now: () => clock, leaseMs: 10, token: () => "lease-expired-cleanup", id: () => "materialization-expired-cleanup",
  });
  const lease = await repository.reserveSourceMaterialization({ ...scope, maxAttempts: 3 });
  const orphan = evidence(lease);
  clock = 1_011;
  await assert.rejects(repository.recordSourceObjectCleanupRequired({
    accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, parentPlanId: scope.parentPlanId,
    sourceAssetId: scope.sourceAssetId, materializationAttemptId: lease.attemptId,
    sourceRefHash: scope.sourceRefHash, inputHash: scope.inputHash, expectedStatusVersion: scope.expectedStatusVersion,
    attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
    objectKeyVersion: orphan.objectKeyVersion, objectKey: orphan.objectKey, contentHash: orphan.contentHash,
    contentType: orphan.contentType, width: orphan.width, height: orphan.height, sizeBytes: orphan.sizeBytes,
    reasonCode: "AUTO_LISTING_SOURCE_OBJECT_UNREFERENCED",
    originalErrorCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED",
  }), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT" });
});

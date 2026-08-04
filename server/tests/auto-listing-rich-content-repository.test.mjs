import assert from "node:assert/strict";
import test from "node:test";

const scope = Object.freeze({
  accountId: "account-a",
  jobId: "job-a",
  itemId: "item-a",
  planId: "plan-a",
});
const hashes = Object.freeze({
  inputHash: "1".repeat(64),
  planHash: "2".repeat(64),
  sourceHash: "3".repeat(64),
  factRegistryHash: "4".repeat(64),
  assetHash: "5".repeat(64),
  promptHash: "6".repeat(64),
});
const fact = Object.freeze({
  factId: "fact.capacity",
  field: "attributes.capacity",
  kind: "CAPACITY",
  value: "500 мл",
  numericValue: 500,
  unit: "мл",
  sourcePath: "attributes.capacity",
});
const assets = Object.freeze(Array.from({ length: 6 }, (_, index) => Object.freeze({
  assetId: index === 0 ? "asset-main" : `asset-${index + 1}`,
  role: index === 0 ? "MAIN" : "SELLING_POINT",
  slotKey: index === 0 ? "main:main:01" : `main:selling-point:0${index}`,
  contentHash: String(index + 1).repeat(64),
  objectKeyVersion: "ATTEMPT_V2",
  objectKey: `auto-listing/v2/exact-${index + 1}.png`,
})));
const reservationInput = (overrides = {}) => ({
  ...scope,
  ...hashes,
  profileId: "profile-a",
  profileVersion: 3,
  modelName: "text-model",
  promptTemplateVersion: "rich-v1",
  sourceFactEvidence: [fact],
  assetEvidence: assets,
  requestEvidence: {
    requestKey: `auto-listing-rich-${hashes.inputHash}`,
    schemaVersion: "AUTO_LISTING_RICH_CONTENT_V1",
  },
  maxAttempts: 3,
  ...overrides,
});
const acceptedContent = Object.freeze({
  version: "AUTO_LISTING_RICH_CONTENT_V1",
  language: "ru",
  blocks: [
    { type: "HERO_IMAGE", assetId: "asset-main" },
    { type: "HEADING", text: "Объём 500 мл", sourceFactIds: ["fact.capacity"] },
    { type: "TEXT", text: "Объём 500 мл", sourceFactIds: ["fact.capacity"] },
  ],
});
const completeInput = (lease, overrides = {}) => ({
  ...reservationInput(),
  ...lease,
  richContent: acceptedContent,
  outputHash: "8".repeat(64),
  checkerResult: {
    accepted: true,
    validator: "AUTO_LISTING_RICH_CONTENT_V1",
    sourceFactIds: ["fact.capacity"],
    assetIds: ["asset-main"],
  },
  gatewayRequestId: "gateway-rich-1",
  modelEvidence: {
    requestedTextModel: "text-model",
    gatewayReportedTextModel: "text-model",
    gatewayReportedTextModelPresent: true,
  },
  ...overrides,
});

async function repositoryModule() {
  return import("../auto-listing-rich-content-repository.mjs");
}

test("reservation persists and echoes the complete frozen input before gateway work", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const repository = createMemoryRichContentRepository({ token: () => "lease-1" });
  const lease = await repository.reserveRichContentAttempt(reservationInput());
  assert.deepEqual(lease, {
    status: "RESERVED",
    attemptNo: 1,
    leaseToken: "lease-1",
    inputHash: hashes.inputHash,
    promptHash: hashes.promptHash,
  });
  assert.deepEqual(repository.snapshot()[0].sourceFactEvidence, [fact]);
  assert.deepEqual(repository.snapshot()[0].assetEvidence, assets);
});

test("same active full-scope input is concurrent-idempotent and lease expiry creates one retry", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  let now = 100;
  let sequence = 0;
  const repository = createMemoryRichContentRepository({
    now: () => now,
    leaseMs: 10,
    token: () => `lease-${++sequence}`,
  });
  await repository.reserveRichContentAttempt(reservationInput());
  assert.deepEqual(await repository.reserveRichContentAttempt(reservationInput()), { status: "IN_PROGRESS" });
  now = 111;
  const retry = await repository.reserveRichContentAttempt(reservationInput());
  assert.equal(retry.status, "RESERVED");
  assert.equal(retry.attemptNo, 2);
  assert.equal(repository.snapshot()[0].status, "FAILED");
  assert.equal(repository.snapshot()[0].errorCode, "LEASE_EXPIRED");
  assert.equal(repository.snapshot()[0].errorRetryable, true);
});

test("accepted completion clears its lease and exact replay returns immutable evidence", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const repository = createMemoryRichContentRepository({ token: () => "lease-accepted" });
  const lease = await repository.reserveRichContentAttempt(reservationInput());
  const accepted = await repository.completeRichContentAttempt(completeInput(lease));
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.leaseToken, null);
  assert.equal(accepted.leaseExpiresAt, null);
  const replay = await repository.reserveRichContentAttempt(reservationInput());
  assert.equal(replay.status, "EXISTING_ACCEPTED");
  assert.deepEqual(replay.record, accepted);
});

test("every terminal transition is fenced by exact account scope, input, attempt, and lease", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  for (const mutation of [
    { accountId: "account-b" },
    { inputHash: "9".repeat(64) },
    { attemptNo: 2 },
    { leaseToken: "wrong" },
  ]) {
    const repository = createMemoryRichContentRepository({ token: () => "lease-fence" });
    const lease = await repository.reserveRichContentAttempt(reservationInput());
    await assert.rejects(
      repository.completeRichContentAttempt(completeInput({ ...lease, ...mutation })),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
    );
    assert.equal(repository.snapshot()[0].status, "GENERATING");
  }
});

test("policy rejection is terminal nonretryable while gateway failure is recoverable", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const rejectedRepo = createMemoryRichContentRepository({ token: () => "lease-reject" });
  const rejectedLease = await rejectedRepo.reserveRichContentAttempt(reservationInput());
  const rejected = await rejectedRepo.rejectRichContentAttempt({
    ...reservationInput(),
    ...rejectedLease,
    errorCode: "AUTO_LISTING_RICH_CONTENT_POLICY_REJECTED",
    errorRetryable: false,
  });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.errorRetryable, false);
  assert.equal(rejected.leaseToken, null);

  const failedRepo = createMemoryRichContentRepository({ token: () => "lease-fail" });
  const failedLease = await failedRepo.reserveRichContentAttempt(reservationInput());
  const failed = await failedRepo.failRichContentAttempt({
    ...reservationInput(),
    ...failedLease,
    errorCode: "RETRYABLE_GATEWAY",
    errorRetryable: true,
  });
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.errorRetryable, true);
  assert.equal(failed.leaseToken, null);
});

test("expired leases cannot complete and terminal input cannot overwrite frozen reservation evidence", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  let now = 100;
  const expiredRepository = createMemoryRichContentRepository({ now: () => now, leaseMs: 10, token: () => "lease-expired" });
  const expiredLease = await expiredRepository.reserveRichContentAttempt(reservationInput());
  now = 111;
  await assert.rejects(expiredRepository.completeRichContentAttempt(completeInput(expiredLease)),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID");
  assert.equal(expiredRepository.snapshot()[0].status, "GENERATING");

  const repository = createMemoryRichContentRepository({ token: () => "lease-frozen" });
  const lease = await repository.reserveRichContentAttempt(reservationInput());
  await assert.rejects(repository.completeRichContentAttempt(completeInput(lease, { planHash: "9".repeat(64) })),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID");
  assert.equal(repository.snapshot()[0].planHash, hashes.planHash);
});

test("direct repository acceptance requires six assets and complete deterministic terminal evidence", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  await assert.rejects(
    createMemoryRichContentRepository().reserveRichContentAttempt(reservationInput({ assetEvidence: assets.slice(0, 5) })),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
  );
  for (const mutate of [
    (value) => { value.modelEvidence = {}; },
    (value) => { value.checkerResult = { accepted: true }; },
    (value) => { value.outputHash = ""; },
    (value) => { value.gatewayRequestId = ""; },
  ]) {
    const repository = createMemoryRichContentRepository({ token: () => "lease-direct" });
    const lease = await repository.reserveRichContentAttempt(reservationInput());
    const value = completeInput(lease); mutate(value);
    await assert.rejects(repository.completeRichContentAttempt(value),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID");
    assert.equal(repository.snapshot()[0].status, "GENERATING");
  }
});

test("PostgreSQL repository maps raw database transition failures to one stable safe error", async () => {
  const { createPostgresRichContentRepository } = await repositoryModule();
  const pool = { async query() { throw new Error("secret raw database message"); } };
  const repository = createPostgresRichContentRepository({ pool, token: () => "lease-pg", id: () => "rich-pg" });
  await assert.rejects(repository.reserveRichContentAttempt(reservationInput()), (error) => {
    assert.equal(error?.code, "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED");
    assert.equal(error?.retryable, true);
    assert.doesNotMatch(error?.message || "", /secret raw database/i);
    return true;
  });
});

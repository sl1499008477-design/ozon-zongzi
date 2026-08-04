import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildGeneratedAssetObjectKey, verifyPersistedAcceptedGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { evaluateGeneratedCheckerEvidence } from "../auto-listing-result-checker.mjs";

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
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const sourceReference = Object.freeze({
  assetId: "source-asset", contentHash: "a".repeat(64), contentType: "image/png",
  width: 768, height: 1024, size: 1024,
});
const checkerResult = Object.freeze({
  matchesProduct: true, claimsVerified: true, russianText: true, quality: "PASS",
  prohibitedContent: false, reasons: [],
  evidence: {
    identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: [sourceReference.assetId] },
    claims: [{ text: "Объём 500 мл", sourceFactId: fact.factId, field: fact.field, value: fact.value, numericValue: fact.numericValue, unit: fact.unit }],
    detectedTexts: ["Объём 500 мл"], language: "ru", qualityFlags: [], prohibitedFlags: [],
  },
});
const checkerModelEvidence = Object.freeze({
  requestedTextModel: "text-model", gatewayReportedTextModel: "text-model", gatewayReportedTextModelPresent: true,
});
const assetEvidence = (index) => {
  const assetId = index === 0 ? "asset-main" : `asset-${index + 1}`;
  const slotKey = index === 0 ? "main:main:01" : `main:selling-point:0${index}`;
  const role = index === 0 ? "MAIN" : "SELLING_POINT";
  const contentHash = String(index + 1).repeat(64);
  const attemptIdentityHash = String(index + 10).repeat(64).slice(0, 64);
  const inputHash = String(index + 20).repeat(64).slice(0, 64);
  const keyInput = { ...scope, visualGroupKey: "main", slotKey, attemptIdentityHash, attemptNo: 1, inputHash, contentHash };
  const checkerEvidence = evaluateGeneratedCheckerEvidence({
    checkerResult, references: [sourceReference], facts: [fact], checkerModel: "text-model",
    profile: { id: "profile-a", accountId: scope.accountId, configVersion: 3 },
    templateVersion: "image-v1", requestId: `checker-${assetId}`, generatedHash: contentHash,
    checkerModelEvidence, textRequired: true,
  }).evidence;
  return Object.freeze({
    assetId, status: "ACCEPTED", ...scope, visualGroupKey: "main", slotKey, role,
    attemptIdentityHash, attemptNo: 1, inputHash, generationSize: "768x1024",
    contentHash, objectKeyVersion: "ATTEMPT_V2", objectKey: buildGeneratedAssetObjectKey(keyInput),
    contentType: "image/png", width: 768, height: 1024, size: 2048,
    gatewayRequestId: `gateway-${assetId}`, checkerRequestId: `checker-${assetId}`,
    modelEvidence: { requestedImageModel: "image-model", gatewayReportedImageModel: "image-model", gatewayReportedImageModelPresent: true, orchestratorModel: "" },
    profileId: "profile-a", profileVersion: 3, modelName: "image-model",
    planHash: hashes.planHash, sourceHash: hashes.sourceHash, strategyHash: "a".repeat(64),
    configHash: "b".repeat(64), visualGroupsHash: "c".repeat(64), promptTemplateVersion: "image-v1",
    promptHash: String(index + 30).repeat(64).slice(0, 64), checkerEvidence,
    sourceAssetEvidence: [sourceReference], regeneration: null,
  });
};
const assets = Object.freeze(Array.from({ length: 6 }, (_, index) => assetEvidence(index)));
const reservationInput = (overrides = {}) => ({
  ...scope,
  ...hashes,
  profileId: "profile-a",
  profileVersion: 3,
  modelName: "text-model",
  promptTemplateVersion: "rich-v1",
  sourceFactEvidence: [structuredClone(fact)],
  assetEvidence: structuredClone(assets),
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
    { type: "HEADING", text: "Объём 500 мл", sourceFactIds: ["fact.capacity"], factBindings: [{ sourceFactId: fact.factId, field: fact.field, value: fact.value, numericValue: fact.numericValue, unit: fact.unit }] },
    { type: "TEXT", text: "Объём 500 мл", sourceFactIds: ["fact.capacity"], factBindings: [{ sourceFactId: fact.factId, field: fact.field, value: fact.value, numericValue: fact.numericValue, unit: fact.unit }] },
  ],
});
const completeInput = (lease, overrides = {}) => ({
  ...reservationInput(),
  ...lease,
  richContent: acceptedContent,
  outputHash: digest(acceptedContent),
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
  const candidate = completeInput(lease);
  const { validateRichContentDocument } = await import("../auto-listing-rich-content.mjs");
  const checked = validateRichContentDocument({
    richContent: candidate.richContent,
    factRegistry: candidate.sourceFactEvidence,
    acceptedAssets: candidate.assetEvidence,
    scope,
  });
  for (const entry of candidate.assetEvidence) {
    assert.equal(verifyPersistedAcceptedGeneratedAssetObjectKey(entry), true, entry.assetId);
  }
  assert.equal(checked.valid, true, checked.checkerResult.code);
  assert.deepEqual(checked.checkerResult, candidate.checkerResult);
  assert.equal(candidate.outputHash, digest(candidate.richContent));
  const accepted = await repository.completeRichContentAttempt(candidate);
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.leaseToken, null);
  assert.equal(accepted.leaseExpiresAt, null);
  const replay = await repository.reserveRichContentAttempt(reservationInput());
  assert.equal(replay.status, "EXISTING_ACCEPTED");
  assert.deepEqual(replay.record, accepted);
});

test("accepted evidence allows group-specific checker facts to be a subset of the frozen registry", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const repository = createMemoryRichContentRepository({ token: () => "lease-group-facts" });
  const extraFact = {
    factId: "fact.material",
    field: "attributes.material",
    kind: "MATERIAL",
    value: "Сталь",
    numericValue: null,
    unit: null,
    sourcePath: "attributes.material",
  };
  const reservedInput = reservationInput({
    sourceFactEvidence: [structuredClone(fact), extraFact],
  });
  const lease = await repository.reserveRichContentAttempt(reservedInput);
  const accepted = await repository.completeRichContentAttempt({
    ...completeInput(lease),
    sourceFactEvidence: reservedInput.sourceFactEvidence,
    assetEvidence: reservedInput.assetEvidence,
  });
  assert.equal(accepted.status, "ACCEPTED");
});

test("accepted evidence allows the Task 4 gateway to omit its reported image model", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const repository = createMemoryRichContentRepository({ token: () => "lease-image-model" });
  const omittedModelAssets = structuredClone(assets);
  for (const asset of omittedModelAssets) {
    asset.modelEvidence = {
      requestedImageModel: "image-model",
      gatewayReportedImageModel: "",
      gatewayReportedImageModelPresent: false,
      orchestratorModel: "",
    };
  }
  const reservedInput = reservationInput({ assetEvidence: omittedModelAssets });
  const lease = await repository.reserveRichContentAttempt(reservedInput);
  const accepted = await repository.completeRichContentAttempt({
    ...completeInput(lease),
    assetEvidence: reservedInput.assetEvidence,
  });
  assert.equal(accepted.status, "ACCEPTED");
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
  const zeroSizeAssets = structuredClone(assets);
  zeroSizeAssets[0].generationSize = "0x0";
  await assert.rejects(
    createMemoryRichContentRepository().reserveRichContentAttempt(reservationInput({ assetEvidence: zeroSizeAssets })),
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

test("direct repository completion rejects invented content and every corrupt frozen evidence shape", async () => {
  const corruptions = [
    ["invented rich content", (value) => { value.richContent = { invented: true }; }],
    ["JSON null fact", (value) => { value.sourceFactEvidence = [null]; }],
    ["forged object key", (value) => { value.assetEvidence[0].objectKey = "forged/object.png"; }],
    ["forged object key version", (value) => { value.assetEvidence[0].objectKeyVersion = "FORGED"; }],
    ["zero generation size", (value) => { value.assetEvidence[0].generationSize = "0x0"; }],
    ["extra request key", (value) => { value.requestEvidence.extra = true; }],
    ["extra model key", (value) => { value.modelEvidence.extra = true; }],
    ["extra checker key", (value) => { value.checkerResult.extra = true; }],
    ["unknown checker fact", (value) => { value.checkerResult.sourceFactIds = ["missing-fact"]; }],
    ["wrong output hash", (value) => { value.outputHash = "9".repeat(64); }],
  ];
  const { createMemoryRichContentRepository } = await repositoryModule();
  for (const [label, mutate] of corruptions) {
    const repository = createMemoryRichContentRepository({ token: () => "lease-corrupt" });
    const lease = await repository.reserveRichContentAttempt(reservationInput());
    const value = completeInput(lease); mutate(value);
    await assert.rejects(repository.completeRichContentAttempt(value),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID", label);
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

test("PostgreSQL repository maps connection acquisition failures without leaking raw messages", async () => {
  const { createPostgresRichContentRepository } = await repositoryModule();
  const pool = {
    async query() { throw new Error("query must not be used"); },
    async connect() { throw new Error("secret raw database connect message"); },
  };
  const repository = createPostgresRichContentRepository({ pool, token: () => "lease-connect", id: () => "rich-connect" });
  await assert.rejects(repository.reserveRichContentAttempt(reservationInput()), (error) => {
    assert.equal(error?.code, "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED");
    assert.equal(error?.retryable, true);
    assert.doesNotMatch(error?.message || "", /secret raw database connect/i);
    return true;
  });
});

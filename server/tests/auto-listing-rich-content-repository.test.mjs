import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildGeneratedAssetObjectKey, verifyPersistedAcceptedGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { buildImageGenerationAttemptIdentity, buildImageGenerationInput } from "../auto-listing-image-generator.mjs";
import { buildRichContentEvidenceIdentity } from "../auto-listing-rich-content.mjs";
import { evaluateGeneratedCheckerEvidence } from "../auto-listing-result-checker.mjs";

const scope = Object.freeze({
  accountId: "account-a",
  jobId: "job-a",
  itemId: "item-a",
  planId: "plan-a",
});
const hashes = Object.freeze({
  planHash: "2".repeat(64),
  sourceHash: "3".repeat(64),
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
const generationProfile = Object.freeze({ id: "profile-a", accountId: scope.accountId, configVersion: 3, textModel: "text-model", imageModel: "image-model" });
const generationPlan = Object.freeze({
  planHash: hashes.planHash,
  sourceHash: hashes.sourceHash,
  strategyHash: "a".repeat(64),
  configHash: "b".repeat(64),
  visualGroupsHash: "c".repeat(64),
});
const assetEvidence = (index) => {
  const assetId = index === 0 ? "asset-main" : `asset-${index + 1}`;
  const slotKey = index === 0 ? "main:main:01" : `main:selling-point:0${index}`;
  const role = index === 0 ? "MAIN" : "SELLING_POINT";
  const contentHash = String(index + 1).repeat(64);
  const slot = { slotKey, visualGroupKey: "main", role, textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: [sourceReference.assetId] };
  const generation = { ratio: "3:4", resolution: "1K", size: "768x1024", quality: "medium" };
  const generationScope = { ...scope, visualGroupKey: "main", slotKey };
  const attemptIdentityHash = buildImageGenerationAttemptIdentity({
    scope: generationScope,
    plan: generationPlan,
    slot,
    preliminaryEvidence: [{ assetId: sourceReference.assetId, evidenceKind: "CONTENT_HASH", evidenceRefHash: sourceReference.contentHash }],
    profile: generationProfile,
    imageModel: generationProfile.imageModel,
    ...generation,
    templateVersion: "image-v1",
    regeneration: null,
  });
  const generatedInput = buildImageGenerationInput({
    plan: generationPlan,
    slot,
    references: [sourceReference],
    profile: generationProfile,
    imageModel: generationProfile.imageModel,
    ...generation,
    templateVersion: "image-v1",
    regeneration: null,
  });
  const inputHash = generatedInput.inputHash;
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
    promptHash: generatedInput.promptHash, checkerEvidence,
    sourceAssetEvidence: [sourceReference], regeneration: null,
  });
};
const assets = Object.freeze(Array.from({ length: 6 }, (_, index) => assetEvidence(index)));
const reservationInput = (overrides = {}) => {
  const base = {
    ...scope,
    planHash: overrides.planHash ?? hashes.planHash,
    sourceHash: overrides.sourceHash ?? hashes.sourceHash,
    profileId: overrides.profileId ?? "profile-a",
    profileVersion: overrides.profileVersion ?? 3,
    modelName: overrides.modelName ?? "text-model",
    promptTemplateVersion: overrides.promptTemplateVersion ?? "rich-v1",
    sourceFactEvidence: overrides.sourceFactEvidence ?? [structuredClone(fact)],
    assetEvidence: overrides.assetEvidence ?? structuredClone(assets),
  };
  const identity = buildRichContentEvidenceIdentity({
    scope, planHash: base.planHash, sourceHash: base.sourceHash,
    sourceFactEvidence: base.sourceFactEvidence, assetEvidence: base.assetEvidence,
    profileId: base.profileId, profileVersion: base.profileVersion,
    modelName: base.modelName, promptTemplateVersion: base.promptTemplateVersion,
  });
  return {
    ...base,
    factRegistryHash: identity.factRegistryHash,
    assetHash: identity.assetHash,
    promptHash: identity.promptHash,
    inputHash: identity.inputHash,
    requestEvidence: {
      requestKey: `auto-listing-rich-${identity.inputHash}`,
      schemaVersion: "AUTO_LISTING_RICH_CONTENT_V1",
    },
    maxAttempts: 3,
    ...overrides,
  };
};
const identityInput = (value) => ({
  scope: Object.fromEntries(Object.keys(scope).map((key) => [key, value[key]])),
  planHash: value.planHash,
  sourceHash: value.sourceHash,
  sourceFactEvidence: value.sourceFactEvidence,
  assetEvidence: value.assetEvidence,
  profileId: value.profileId,
  profileVersion: value.profileVersion,
  modelName: value.modelName,
  promptTemplateVersion: value.promptTemplateVersion,
});
const extraFact = (sourcePath) => ({
  factId: "fact.extra",
  field: "attributes.extra",
  kind: "MATERIAL",
  value: "безопасный материал",
  numericValue: null,
  unit: null,
  sourcePath,
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

test("canonical evidence rejects public domains in every prompt-projected field", () => {
  const cases = [
    ["factId", (value) => { value.sourceFactEvidence[0].factId = "private.example.cn"; }],
    ["field", (value) => { value.sourceFactEvidence[0].field = "private.example.uk"; }],
    ["kind", (value) => { value.sourceFactEvidence[0].kind = "private.example.de"; }],
    ["value", (value) => { value.sourceFactEvidence[0].value = "private.example.cloud"; }],
    ["unit", (value) => { value.sourceFactEvidence[0].unit = "пример.рф"; }],
    ["assetId", (value) => { value.assetEvidence[0].assetId = "xn--e1afmkfd.xn--p1ai"; }],
    ["role", (value) => { value.assetEvidence[0].role = "例子.中国"; }],
    ["slotKey", (value) => { value.assetEvidence[0].slotKey = "private.example.cloud"; }],
  ];
  for (const [label, mutate] of cases) {
    const value = reservationInput();
    mutate(value);
    assert.throws(
      () => buildRichContentEvidenceIdentity(identityInput(value)),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID",
      label,
    );
  }
});

test("canonical evidence enforces collection and closed-row limits before structured cloning", () => {
  const baseline = reservationInput();
  const tooManyFacts = Array.from({ length: 257 }, () => () => "uncloneable");
  const tooManyAssets = Array.from({ length: 21 }, () => () => "uncloneable");
  const openFacts = [{ ...structuredClone(fact), extra: () => "uncloneable" }];
  const oversizedUtf8Facts = [{ ...structuredClone(fact), sourcePath: "路".repeat(342) }];
  for (const sourceFactEvidence of [tooManyFacts, openFacts, oversizedUtf8Facts]) {
    assert.throws(
      () => buildRichContentEvidenceIdentity({ ...identityInput(baseline), sourceFactEvidence }),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID",
    );
  }
  assert.throws(
    () => buildRichContentEvidenceIdentity({ ...identityInput(baseline), assetEvidence: tooManyAssets }),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID",
  );
});

test("memory reservation applies UTF-8 byte ceilings to non-prompt evidence", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  for (const sourcePath of ["路".repeat(341), `p${"😀".repeat(255)}`]) {
    const input = reservationInput({ sourceFactEvidence: [structuredClone(fact), extraFact(sourcePath)] });
    assert.equal((await createMemoryRichContentRepository().reserveRichContentAttempt(input)).status, "RESERVED");
  }
  for (const sourcePath of ["路".repeat(342), `p${"😀".repeat(256)}`]) {
    const input = reservationInput();
    input.sourceFactEvidence.push(extraFact(sourcePath));
    await assert.rejects(
      createMemoryRichContentRepository().reserveRichContentAttempt(input),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
    );
  }
});

test("memory completion applies UTF-8 byte ceilings to terminal audit strings", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const validRepository = createMemoryRichContentRepository({ token: () => "lease-byte-valid" });
  const validLease = await validRepository.reserveRichContentAttempt(reservationInput());
  assert.equal((await validRepository.completeRichContentAttempt(completeInput(validLease, {
    gatewayRequestId: "😀".repeat(60),
  }))).status, "ACCEPTED");

  const invalidRepository = createMemoryRichContentRepository({ token: () => "lease-byte-invalid" });
  const invalidLease = await invalidRepository.reserveRichContentAttempt(reservationInput());
  await assert.rejects(
    invalidRepository.completeRichContentAttempt(completeInput(invalidLease, { gatewayRequestId: "😀".repeat(61) })),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
  );
  assert.equal(invalidRepository.snapshot()[0].status, "GENERATING");
});

test("reservation persists and echoes the complete frozen input before gateway work", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const repository = createMemoryRichContentRepository({ token: () => "lease-1" });
  const lease = await repository.reserveRichContentAttempt(reservationInput());
  const expected = reservationInput();
  assert.deepEqual(lease, {
    status: "RESERVED",
    attemptNo: 1,
    leaseToken: "lease-1",
    inputHash: expected.inputHash,
    promptHash: expected.promptHash,
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
    ...reservedInput,
    ...lease,
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
    ...reservedInput,
    ...lease,
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

test("the same policy-rejected input is terminally replayed without creating attempt two", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const repository = createMemoryRichContentRepository({ token: () => "lease-policy-replay" });
  const lease = await repository.reserveRichContentAttempt(reservationInput());
  await repository.rejectRichContentAttempt({
    ...reservationInput(),
    ...lease,
    errorCode: "AUTO_LISTING_RICH_CONTENT_POLICY_REJECTED",
    errorRetryable: false,
  });
  assert.deepEqual(await repository.reserveRichContentAttempt(reservationInput()), {
    status: "REJECTED",
    code: "AUTO_LISTING_RICH_CONTENT_POLICY_REJECTED",
  });
  assert.equal(repository.snapshot().length, 1);
  assert.equal(repository.snapshot()[0].attemptNo, 1);
});

for (const contentType of ["image/jpeg", "image/webp"]) {
  test(`accepted Task 4 ${contentType} source evidence remains valid at the rich repository boundary`, async () => {
    const { createMemoryRichContentRepository } = await repositoryModule();
    const repository = createMemoryRichContentRepository({ token: () => `lease-${contentType}` });
    const compatibleAssets = structuredClone(assets);
    for (const asset of compatibleAssets) {
      asset.sourceAssetEvidence[0].contentType = contentType;
      asset.checkerEvidence.sourceAssets[0].contentType = contentType;
    }
    const input = reservationInput({ assetEvidence: compatibleAssets });
    const lease = await repository.reserveRichContentAttempt(input);
    const accepted = await repository.completeRichContentAttempt({
      ...completeInput(lease),
      ...input,
      ...lease,
    });
    assert.equal(accepted.status, "ACCEPTED");
  });
}

function recomputeClaimedRichInputHash(input) {
  input.inputHash = digest({
    scope,
    planHash: input.planHash,
    sourceHash: input.sourceHash,
    factRegistryHash: input.factRegistryHash,
    assetHash: input.assetHash,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    modelName: input.modelName,
    promptTemplateVersion: input.promptTemplateVersion,
    language: "ru",
    promptHash: input.promptHash,
  });
  input.requestEvidence.requestKey = `auto-listing-rich-${input.inputHash}`;
}

for (const [label, mutate] of [
  ["fact registry hash", (input) => { input.factRegistryHash = "7".repeat(64); recomputeClaimedRichInputHash(input); }],
  ["asset hash", (input) => { input.assetHash = "8".repeat(64); recomputeClaimedRichInputHash(input); }],
  ["prompt hash", (input) => { input.promptHash = "9".repeat(64); recomputeClaimedRichInputHash(input); }],
  ["input hash", (input) => {
    input.inputHash = "a".repeat(64);
    input.requestEvidence.requestKey = `auto-listing-rich-${input.inputHash}`;
  }],
]) {
  test(`reservation rejects a forged but well-formed ${label}`, async () => {
    const { createMemoryRichContentRepository } = await repositoryModule();
    const input = reservationInput(); mutate(input);
    await assert.rejects(
      createMemoryRichContentRepository().reserveRichContentAttempt(input),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
    );
  });
}

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
  const insufficientAssets = reservationInput();
  insufficientAssets.assetEvidence = insufficientAssets.assetEvidence.slice(0, 5);
  await assert.rejects(
    createMemoryRichContentRepository().reserveRichContentAttempt(insufficientAssets),
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

test("PostgreSQL reserve and complete reject forged canonical hashes before any query", async () => {
  const { createPostgresRichContentRepository } = await repositoryModule();
  let queries = 0;
  const pool = { async query() { queries += 1; throw new Error("query must not run"); } };
  const repository = createPostgresRichContentRepository({ pool, token: () => "lease-hash", id: () => "rich-hash" });
  const forgedReserve = reservationInput({ factRegistryHash: "7".repeat(64) });
  await assert.rejects(repository.reserveRichContentAttempt(forgedReserve),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID");
  const forgedComplete = completeInput({ attemptNo: 1, leaseToken: "lease-hash" }, { assetHash: "8".repeat(64) });
  await assert.rejects(repository.completeRichContentAttempt(forgedComplete),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID");
  assert.equal(queries, 0);
});

test("PostgreSQL reserve and complete enforce UTF-8 bytes before any query", async () => {
  const { createPostgresRichContentRepository } = await repositoryModule();
  let queries = 0;
  const pool = { async query() { queries += 1; throw new Error("query must not run"); } };
  const repository = createPostgresRichContentRepository({ pool, token: () => "lease-bytes", id: () => "rich-bytes" });
  const oversizedSourcePath = reservationInput();
  oversizedSourcePath.sourceFactEvidence.push(extraFact("路".repeat(342)));
  await assert.rejects(
    repository.reserveRichContentAttempt(oversizedSourcePath),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
  );
  await assert.rejects(
    repository.completeRichContentAttempt(completeInput(
      { attemptNo: 1, leaseToken: "lease-bytes" },
      { gatewayRequestId: "😀".repeat(61) },
    )),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
  );
  assert.equal(queries, 0);
});

test("PostgreSQL repository maps release failures to the stable safe repository error", async () => {
  const { createPostgresRichContentRepository } = await repositoryModule();
  const client = {
    async query(sql) {
      if (/SELECT id FROM auto_listing_job_items/u.test(sql)) return { rowCount: 1, rows: [{ id: scope.itemId }] };
      if (/SELECT \* FROM ai_rich_content_results/u.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT 1 FROM ai_rich_content_results/u.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT COALESCE\(MAX\(attempt_no\)/u.test(sql)) return { rowCount: 1, rows: [{ attempt_no: 0 }] };
      return { rowCount: 1, rows: [] };
    },
    release() { throw new Error("secret raw release message"); },
  };
  const pool = { async query() { throw new Error("pool query must not run"); }, async connect() { return client; } };
  const repository = createPostgresRichContentRepository({ pool, token: () => "lease-release", id: () => "rich-release" });
  await assert.rejects(repository.reserveRichContentAttempt(reservationInput()), (error) => {
    assert.equal(error?.code, "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED");
    assert.equal(error?.retryable, true);
    assert.doesNotMatch(error?.message || "", /secret raw release/i);
    return true;
  });
});

test("PostgreSQL reservation replays a policy rejection before any new insert", async () => {
  const { createPostgresRichContentRepository } = await repositoryModule();
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (/SELECT id FROM auto_listing_job_items/u.test(sql)) return { rowCount: 1, rows: [{ id: scope.itemId }] };
      if (/SELECT \* FROM ai_rich_content_results/u.test(sql)) return { rowCount: 0, rows: [] };
      if (/status='REJECTED'/u.test(sql)) return { rowCount: 1, rows: [{ exists: 1 }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = { async query() { throw new Error("pool query must not run"); }, async connect() { return client; } };
  const repository = createPostgresRichContentRepository({ pool, token: () => "lease-rejected-pg", id: () => "rich-rejected-pg" });
  assert.deepEqual(await repository.reserveRichContentAttempt(reservationInput()), {
    status: "REJECTED",
    code: "AUTO_LISTING_RICH_CONTENT_POLICY_REJECTED",
  });
  assert.equal(statements.some((sql) => /INSERT INTO ai_rich_content_results/u.test(sql)), false);
});

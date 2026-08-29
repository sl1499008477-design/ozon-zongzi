import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildGeneratedAssetObjectKey, verifyPersistedAcceptedGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { buildImageGenerationAttemptIdentity, buildImageGenerationInput } from "../auto-listing-image-generator.mjs";
import { buildRichContentEvidenceIdentity } from "../auto-listing-rich-content.mjs";
import { acceptSoftCheckerFailureForManualReview, evaluateGeneratedCheckerEvidence } from "../auto-listing-result-checker.mjs";

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
const assetEvidence = (index, {
  templateVersion = "image-v1",
  checkerResultValue = checkerResult,
  checkerFacts = [fact],
  claimEvidenceFactIds,
} = {}) => {
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
    templateVersion,
    regeneration: null,
  });
  const generatedInput = buildImageGenerationInput({
    plan: generationPlan,
    slot,
    references: [sourceReference],
    profile: generationProfile,
    imageModel: generationProfile.imageModel,
    ...generation,
    templateVersion,
    regeneration: null,
  });
  const inputHash = generatedInput.inputHash;
  const keyInput = { ...scope, visualGroupKey: "main", slotKey, attemptIdentityHash, attemptNo: 1, inputHash, contentHash };
  const checkerEvidence = evaluateGeneratedCheckerEvidence({
    checkerResult: checkerResultValue, references: [sourceReference], facts: checkerFacts, checkerModel: "text-model",
    profile: { id: "profile-a", accountId: scope.accountId, configVersion: 3 },
    templateVersion, requestId: `checker-${assetId}`, generatedHash: contentHash,
    checkerModelEvidence, textRequired: true,
    ...(claimEvidenceFactIds ? { claimEvidenceFactIds } : {}),
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
    configHash: "b".repeat(64), visualGroupsHash: "c".repeat(64), promptTemplateVersion: templateVersion,
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
    expectedStatusVersion: 7,
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

test("canonical evidence treats identifiers as internal metadata but rejects public domains in prompt-projected fields", () => {
  for (const mutate of [
    (value) => { value.sourceFactEvidence[0].factId = "private.example.cn"; },
    (value) => { value.sourceFactEvidence[0].field = "private.example.uk"; },
  ]) {
    const value = reservationInput();
    mutate(value);
    assert.doesNotThrow(() => buildRichContentEvidenceIdentity(identityInput(value)));
  }
  const cases = [
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
  for (const sourcePath of ["路".repeat(341)]) {
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

test("memory completion accepts only the explicit deterministic rich-content fallback evidence", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const repository = createMemoryRichContentRepository({ token: () => "lease-fallback" });
  const lease = await repository.reserveRichContentAttempt(reservationInput());
  const accepted = await repository.completeRichContentAttempt(completeInput(lease, {
    gatewayRequestId: `auto-listing-rich-fallback-${reservationInput().inputHash}`,
    modelEvidence: {
      requestedTextModel: "text-model",
      gatewayReportedTextModel: "",
      gatewayReportedTextModelPresent: false,
    },
  }));
  assert.equal(accepted.status, "ACCEPTED");

  for (const mutate of [
    (value) => { value.gatewayRequestId = "gateway-rich-1"; },
    (value) => { value.modelEvidence.gatewayReportedTextModel = "text-model"; },
    (value) => { value.modelEvidence.requestedTextModel = "other-model"; },
  ]) {
    const next = createMemoryRichContentRepository({ token: () => "lease-invalid-fallback" });
    const nextLease = await next.reserveRichContentAttempt(reservationInput());
    const value = completeInput(nextLease, {
      gatewayRequestId: `auto-listing-rich-fallback-${reservationInput().inputHash}`,
      modelEvidence: {
        requestedTextModel: "text-model",
        gatewayReportedTextModel: "",
        gatewayReportedTextModelPresent: false,
      },
    });
    mutate(value);
    await assert.rejects(next.completeRichContentAttempt(value),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID");
  }
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

test("reservation keeps accepted checker facts immutable when rich facts add derived numeric metadata", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const legacyFact = {
    ...structuredClone(fact),
    value: "Объём, мл: 500",
    numericValue: null,
    unit: null,
  };
  const normalizedFact = { ...legacyFact, numericValue: 500, unit: "ml" };
  const legacyAssets = structuredClone(assets);
  for (const asset of legacyAssets) {
    const legacyCheckerResult = structuredClone(checkerResult);
    legacyCheckerResult.evidence.claims = [{
      text: legacyFact.value,
      sourceFactId: legacyFact.factId,
      field: legacyFact.field,
      value: legacyFact.value,
      numericValue: null,
      unit: null,
    }];
    legacyCheckerResult.evidence.detectedTexts = [legacyFact.value];
    asset.checkerEvidence = evaluateGeneratedCheckerEvidence({
      checkerResult: legacyCheckerResult,
      references: asset.sourceAssetEvidence,
      facts: [legacyFact],
      checkerModel: "text-model",
      profile: { id: "profile-a", accountId: scope.accountId, configVersion: 3 },
      templateVersion: asset.promptTemplateVersion,
      requestId: asset.checkerRequestId,
      generatedHash: asset.contentHash,
      checkerModelEvidence,
      textRequired: true,
    }).evidence;
  }
  const input = reservationInput({ sourceFactEvidence: [normalizedFact], assetEvidence: legacyAssets });

  const result = await createMemoryRichContentRepository({ token: () => "lease-derived-numeric" })
    .reserveRichContentAttempt(input);

  assert.equal(result.status, "RESERVED");
  assert.deepEqual(input.assetEvidence[0].checkerEvidence.sourceFacts, [legacyFact]);
});

test("reservation reuses accepted images whose frozen checker facts include excluded operational facts", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const operationalFact = {
    factId: "fact.attribute.9048.0",
    field: "attributes[0].values[0]",
    kind: "ATTRIBUTE:internal-model",
    value: "Название модели (для объединения в одну карточку): 019d2e6c74ed7ca59b6e879584910440",
    numericValue: null,
    unit: null,
    sourcePath: "attributes[0].values[0]",
  };
  const historicalAssets = Array.from({ length: 6 }, (_, index) => assetEvidence(index, {
    checkerFacts: [fact, operationalFact],
    claimEvidenceFactIds: [fact.factId],
  }));
  const input = reservationInput({
    sourceFactEvidence: [structuredClone(fact)],
    assetEvidence: historicalAssets,
  });

  const result = await createMemoryRichContentRepository({ token: () => "lease-operational-superset" })
    .reserveRichContentAttempt(input);

  assert.equal(result.status, "RESERVED");
  assert.deepEqual(input.assetEvidence[0].checkerEvidence.sourceFacts, [fact, operationalFact]);
});

test("V6 reservation canonicalizes only redundant checker claim projection", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const v6Assets = Array.from({ length: 6 }, (_, index) => assetEvidence(index, index === 0 ? {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    claimEvidenceFactIds: [fact.factId],
  } : undefined)).map((asset) => structuredClone(asset));
  const storedClaim = v6Assets[0].checkerEvidence.checkerResult.evidence.claims[0];
  storedClaim.field = `${fact.field}#dictionaryValueId=41834`;
  storedClaim.numericValue = 80;
  storedClaim.unit = "Вт";

  const input = reservationInput({ assetEvidence: v6Assets });
  const result = await createMemoryRichContentRepository({ token: () => "lease-v6-projection" })
    .reserveRichContentAttempt(input);

  assert.equal(result.status, "RESERVED");
  assert.equal(input.assetEvidence[0].checkerEvidence.checkerResult.evidence.claims[0].field,
    `${fact.field}#dictionaryValueId=41834`);
});

test("rich-content reservation accepts an already-approved V6 manual-review warning on every attempt", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const warningAsset = structuredClone(assetEvidence(0, {
    templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    claimEvidenceFactIds: [fact.factId],
  }));
  const softResult = evaluateGeneratedCheckerEvidence({
    checkerResult: {
      ...structuredClone(checkerResult),
      quality: "FAIL",
      evidence: { ...structuredClone(checkerResult.evidence), qualityFlags: ["SUBJECT_NOT_DOMINANT"] },
    },
    references: warningAsset.sourceAssetEvidence,
    facts: [fact],
    checkerModel: "text-model",
    profile: { id: "profile-a", accountId: scope.accountId, configVersion: 3 },
    templateVersion: warningAsset.promptTemplateVersion,
    requestId: warningAsset.checkerRequestId,
    generatedHash: warningAsset.contentHash,
    checkerModelEvidence,
    textRequired: true,
    claimEvidenceFactIds: [fact.factId],
  });
  warningAsset.checkerEvidence = acceptSoftCheckerFailureForManualReview(softResult).evidence;
  for (const attemptNo of [1, 2, 3]) {
    const current = structuredClone(warningAsset);
    current.attemptNo = attemptNo;
    current.objectKey = buildGeneratedAssetObjectKey(current);
    const warningAssets = [current, ...assets.slice(1).map((asset) => structuredClone(asset))];
    const accepted = await createMemoryRichContentRepository()
      .reserveRichContentAttempt(reservationInput({ assetEvidence: warningAssets }));
    assert.equal(accepted.status, "RESERVED");
  }
});

test("reservation treats accepted checker semantics as opaque but keeps its immutable envelope fenced", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const acceptedAssets = structuredClone(assets);
  for (const asset of acceptedAssets) {
    asset.checkerEvidence.checkerResult.evidence.presentationAudit = {
      version: "future-checker-v1",
      warnings: [],
    };
  }

  const accepted = await createMemoryRichContentRepository()
    .reserveRichContentAttempt(reservationInput({ assetEvidence: acceptedAssets }));
  assert.equal(accepted.status, "RESERVED");

  acceptedAssets[0].checkerEvidence.generatedHash = "0".repeat(64);
  await assert.rejects(
    createMemoryRichContentRepository().reserveRichContentAttempt(
      reservationInput({ assetEvidence: acceptedAssets }),
    ),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
  );
});

test("reservation rejects a numeric projection that disagrees with the immutable fact value", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const legacyFact = {
    ...structuredClone(fact),
    value: "Объём, мл: 500",
    numericValue: null,
    unit: null,
  };
  const inconsistentFact = { ...legacyFact, numericValue: 600, unit: "ml" };
  const legacyAssets = structuredClone(assets);
  for (const asset of legacyAssets) {
    const legacyCheckerResult = structuredClone(checkerResult);
    legacyCheckerResult.evidence.claims = [{
      text: legacyFact.value,
      sourceFactId: legacyFact.factId,
      field: legacyFact.field,
      value: legacyFact.value,
      numericValue: null,
      unit: null,
    }];
    legacyCheckerResult.evidence.detectedTexts = [legacyFact.value];
    asset.checkerEvidence = evaluateGeneratedCheckerEvidence({
      checkerResult: legacyCheckerResult,
      references: asset.sourceAssetEvidence,
      facts: [legacyFact],
      checkerModel: "text-model",
      profile: { id: "profile-a", accountId: scope.accountId, configVersion: 3 },
      templateVersion: asset.promptTemplateVersion,
      requestId: asset.checkerRequestId,
      generatedHash: asset.contentHash,
      checkerModelEvidence,
      textRequired: true,
    }).evidence;
  }

  await assert.rejects(
    createMemoryRichContentRepository({ token: () => "lease-inconsistent-numeric" })
      .reserveRichContentAttempt(reservationInput({
        sourceFactEvidence: [inconsistentFact],
        assetEvidence: legacyAssets,
      })),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
  );
});

test("reservation revalidates complete category-style checker evidence", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const categoryStyle = {
    overallStyle: "Яркая коммерческая инфографика",
    prohibitedPatterns: ["Не копировать товар образца"],
    role: "Показывать преимущества товара",
    composition: "Крупный товар по центру",
    background: "Контрастный цветной фон",
    textDensity: "Средняя плотность текста",
    layout: "Заголовок сверху, факты рядом с товаром",
  };
  const categoryStyleReferences = [{
    evidenceId: "category-style-evidence-1",
    sku: "style-sku-1",
    contentHash: "f".repeat(64),
    contentType: "image/jpeg",
    width: 900,
    height: 1200,
    size: 4096,
  }];
  const styledAssets = structuredClone(assets);
  for (const asset of styledAssets) {
    const styledCheckerResult = structuredClone(checkerResult);
    styledCheckerResult.matchesCategoryStyle = true;
    styledCheckerResult.evidence.categoryStyle = {
      matches: true,
      referenceEvidenceIds: categoryStyleReferences.map(({ evidenceId }) => evidenceId),
    };
    asset.checkerEvidence = evaluateGeneratedCheckerEvidence({
      checkerResult: styledCheckerResult,
      references: asset.sourceAssetEvidence,
      facts: [structuredClone(fact)],
      checkerModel: "text-model",
      profile: { id: "profile-a", accountId: scope.accountId, configVersion: 3 },
      templateVersion: asset.promptTemplateVersion,
      requestId: asset.checkerRequestId,
      generatedHash: asset.contentHash,
      checkerModelEvidence,
      textRequired: true,
      categoryStyle,
      categoryStyleReferences,
    }).evidence;
  }
  const input = reservationInput({ assetEvidence: styledAssets });
  const result = await createMemoryRichContentRepository({ token: () => "lease-style" })
    .reserveRichContentAttempt(input);
  assert.equal(result.status, "RESERVED");
});

test("reservation accepts a checker that inspected only the first product anchor", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  const secondaryReference = {
    assetId: "source-detail",
    contentHash: "f".repeat(64),
    contentType: "image/png",
    width: 768,
    height: 1024,
    size: 1536,
  };
  const anchoredAssets = structuredClone(assets);
  anchoredAssets[1].sourceAssetEvidence.push(secondaryReference);

  const accepted = await createMemoryRichContentRepository()
    .reserveRichContentAttempt(reservationInput({ assetEvidence: anchoredAssets }));
  assert.equal(accepted.status, "RESERVED");

  const forgedAssets = structuredClone(anchoredAssets);
  forgedAssets[1].checkerEvidence = evaluateGeneratedCheckerEvidence({
    checkerResult: {
      ...structuredClone(checkerResult),
      evidence: {
        ...structuredClone(checkerResult.evidence),
        identity: {
          ...structuredClone(checkerResult.evidence.identity),
          sourceAssetIds: [secondaryReference.assetId],
        },
      },
    },
    references: [secondaryReference],
    facts: [fact],
    checkerModel: "text-model",
    profile: { id: "profile-a", accountId: scope.accountId, configVersion: 3 },
    templateVersion: "image-v1",
    requestId: "checker-forged-secondary",
    generatedHash: forgedAssets[1].contentHash,
    checkerModelEvidence,
    textRequired: true,
  }).evidence;
  await assert.rejects(
    createMemoryRichContentRepository().reserveRichContentAttempt(
      reservationInput({ assetEvidence: forgedAssets }),
    ),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
  );
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

test("channel release reclaims the same rich attempt with a fresh exact lease and no retry budget", async () => {
  const { createMemoryRichContentRepository } = await repositoryModule();
  let sequence = 0;
  const repository = createMemoryRichContentRepository({ token: () => `channel-lease-${++sequence}` });
  const input = reservationInput();
  const first = await repository.reserveRichContentAttempt(input);
  const released = await repository.releaseRichContentAttempt({
    ...input, ...first, errorCode: "AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED",
  });
  assert.equal(released.status, "GENERATING");
  assert.equal(released.attemptNo, 1);
  assert.equal(released.leaseToken, first.leaseToken);
  assert.equal(released.leaseOwner, "AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED");

  const reclaimed = await repository.reserveRichContentAttempt(input);
  assert.equal(reclaimed.status, "RESERVED");
  assert.equal(reclaimed.attemptNo, 1);
  assert.notEqual(reclaimed.leaseToken, first.leaseToken);
  assert.deepEqual(await repository.reserveRichContentAttempt(input), { status: "IN_PROGRESS" });

  await assert.rejects(repository.releaseRichContentAttempt({
    ...input, ...first, errorCode: "AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED",
  }), (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID");
  const current = repository.snapshot()[0];
  assert.equal(current.status, "GENERATING");
  assert.equal(current.leaseToken, reclaimed.leaseToken);
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

test("PostgreSQL default rich-content lease outlives the bounded two-minute model call", async () => {
  const { createPostgresRichContentRepository } = await repositoryModule();
  let insertValues = null;
  const client = {
    async query(sql, values = []) {
      if (/SELECT id FROM auto_listing_job_items/u.test(sql)) return { rowCount: 1, rows: [{ id: scope.itemId }] };
      if (/SELECT \* FROM ai_rich_content_results/u.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT 1 FROM ai_rich_content_results/u.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT COALESCE\(MAX\(attempt_no\)/u.test(sql)) return { rowCount: 1, rows: [{ attempt_no: 0 }] };
      if (/INSERT INTO ai_rich_content_results/u.test(sql)) insertValues = values;
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = { async query() { throw new Error("pool query must not run"); }, async connect() { return client; } };
  const repository = createPostgresRichContentRepository({
    pool, token: () => "lease-duration", id: () => "rich-duration",
  });

  assert.equal((await repository.reserveRichContentAttempt(reservationInput({
    gatewayConnectionId: "connection-b", gatewayConnectionVersion: 9,
  }))).status, "RESERVED");
  assert.equal(insertValues?.includes(300_000), true);
  assert.equal(insertValues?.includes("connection-b"), true);
  assert.equal(insertValues?.includes(9), true);
});

test("PostgreSQL rich reservation locks only the current generating item version and active plan before attempt writes", async () => {
  const { createPostgresRichContentRepository } = await repositoryModule();
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (/SELECT id FROM auto_listing_job_items/u.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const repository = createPostgresRichContentRepository({
    pool: { async connect() { return client; }, async query() { throw new Error("pool query must not run"); } },
    token: () => "lease-stale-version", id: () => "rich-stale-version",
  });

  await assert.rejects(
    repository.reserveRichContentAttempt(reservationInput()),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID",
  );
  const boundary = statements.find(({ sql }) => /SELECT id FROM auto_listing_job_items/u.test(sql));
  assert.match(boundary.sql, /account_id=\$1.*job_id=\$2.*id=\$3/isu);
  assert.match(boundary.sql, /status='GENERATING'.*status_version=\$4.*active_content_plan_id=\$5/isu);
  assert.deepEqual(boundary.values, [scope.accountId, scope.jobId, scope.itemId, 7, scope.planId]);
  assert.equal(statements.some(({ sql }) => /(?:UPDATE|INSERT INTO) ai_rich_content_results/u.test(sql)), false);
  assert.equal(statements.at(-1).sql, "ROLLBACK");
});

test("PostgreSQL rich terminal and release writes share the exact live item version and active-plan fence", async () => {
  const { createPostgresRichContentRepository } = await repositoryModule();
  const input = reservationInput({ gatewayConnectionId: "connection-a", gatewayConnectionVersion: 4 });
  for (const [name, invoke] of [
    ["complete", (repository) => repository.completeRichContentAttempt(completeInput(
      { attemptNo: 1, leaseToken: "lease-a" },
      { expectedStatusVersion: 7, gatewayConnectionId: "connection-a", gatewayConnectionVersion: 4 },
    ))],
    ["reject", (repository) => repository.rejectRichContentAttempt({
      ...input, attemptNo: 1, leaseToken: "lease-a", errorCode: "POLICY", errorRetryable: false,
    })],
    ["fail", (repository) => repository.failRichContentAttempt({
      ...input, attemptNo: 1, leaseToken: "lease-a", errorCode: "GATEWAY", errorRetryable: true,
    })],
    ["release", (repository) => repository.releaseRichContentAttempt({
      ...input, attemptNo: 1, leaseToken: "lease-a",
      errorCode: "AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED",
    })],
  ]) {
    let statement = null;
    const repository = createPostgresRichContentRepository({ pool: { async query(sql, values) {
      statement = { sql, values };
      return { rowCount: 0, rows: [] };
    } } });
    await assert.rejects(invoke(repository),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID", name);
    assert.match(statement.sql, /WITH current_item AS[\s\S]*FOR UPDATE[\s\S]*UPDATE ai_rich_content_results/iu, name);
    assert.match(statement.sql, /FROM auto_listing_job_items AS item/iu, name);
    assert.match(statement.sql, /item\.account_id=\$1.*item\.job_id=\$2.*item\.id=\$3/isu, name);
    assert.match(statement.sql, /item\.status='GENERATING'/iu, name);
    assert.match(statement.sql, /item\.status_version=\$\d+/iu, name);
    assert.match(statement.sql, /item\.active_content_plan_id=\$4/iu, name);
  }
});

test("PostgreSQL rich channel release uses the full scope evidence attempt and token fence", async () => {
  const { createPostgresRichContentRepository } = await repositoryModule();
  const input = reservationInput();
  let transition = null;
  const pool = {
    async query(sql, values) {
      transition = { sql, values };
      return {
        rowCount: 1,
        rows: [{
          id: "rich-channel-1", account_id: scope.accountId, job_id: scope.jobId,
          item_id: scope.itemId, plan_id: scope.planId, input_hash: input.inputHash,
          attempt_no: 1, status: "GENERATING", lease_owner: "AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED",
          lease_token: "rich-channel-token", lease_expires_at: new Date(),
          error_code: null, error_retryable: null,
          accepted_at: null, plan_hash: input.planHash, source_hash: input.sourceHash,
          fact_registry_hash: input.factRegistryHash, asset_hash: input.assetHash,
          prompt_hash: input.promptHash, profile_id: input.profileId,
          profile_version: input.profileVersion, model_name: input.modelName,
          prompt_template_version: input.promptTemplateVersion,
          source_fact_evidence: input.sourceFactEvidence, asset_evidence: input.assetEvidence,
          request_evidence: input.requestEvidence,
        }],
      };
    },
  };
  const repository = createPostgresRichContentRepository({ pool });
  const released = await repository.releaseRichContentAttempt({
    ...input, attemptNo: 1, leaseToken: "rich-channel-token",
    errorCode: "AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED",
  });

  assert.equal(released.status, "GENERATING");
  assert.equal(released.attemptNo, 1);
  assert.equal(released.leaseOwner, "AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED");
  assert.match(transition.sql, /account_id=\$1.*item_id=\$3.*input_hash=\$5.*attempt_no=\$6/isu);
  assert.match(transition.sql, /lease_token=\$7/isu);
  assert.match(transition.sql, /plan_hash=.*source_hash=.*fact_registry_hash=.*asset_hash=.*prompt_hash=/isu);
  assert.match(transition.sql, /gateway_connection_id IS NOT DISTINCT FROM \$20/iu);
  assert.equal(transition.values[6], "rich-channel-token");
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

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { sha256 } from "../auto-listing-asset-store.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const load = () => import("../auto-listing-source-materializer.mjs");
const H = (char) => char.repeat(64);
const SOURCE_URL = "https://cdn.example.test/image.png?token=do-not-persist";
const SOURCE_REF_HASH = crypto.createHash("sha256").update(SOURCE_URL).digest("hex");
const SOURCE_ASSET_ID = `source-url-${SOURCE_REF_HASH.slice(0, 24)}`;
const CATEGORY_EVIDENCE = Object.freeze({
  id: "category-evidence-a", accountId: "account-a",
  sourceDescriptionCategoryId: 170, sourceTypeId: 99,
  taxonomyScope: "OZON:DEFAULT",
});
const SHARED_CATEGORY = Object.freeze({
  id: "shared-category-a", accountId: "account-a", version: 1,
  evidenceId: CATEGORY_EVIDENCE.id, status: "ACTIVE", source: "SOURCE_DIRECT",
  sourceDescriptionCategoryId: 170, sourceTypeId: 99,
  currentDescriptionCategoryId: 170, currentTypeId: 99,
  taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null,
});
function sourceCapture({ listingImages = [SOURCE_URL], variantImages = [SOURCE_URL], variants } = {}) {
  return buildAutoListingSourceSnapshot({
  accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-a", sourceVersion: "1",
  targetStoreId: "store-a", targetStoreCurrency: "RUB",
  categoryEvidence: CATEGORY_EVIDENCE, sharedCategory: SHARED_CATEGORY,
  collectItem: {
    id: "collect-a", accountId: "account-a",
    listingDraft: {
      sku: "sku-a", title: "Товар", brand: "Brand", currency: "RUB", blackKopecks: "10000", greenKopecks: "8000",
      categoryResolution: { status: "MATCHED", method: "taxonomy", target: { storeId: "store-a", descriptionCategoryId: "170", typeId: "99" } },
      descriptionCategoryId: "170", typeId: "99", attributes: [], logistics: {}, productMeasurements: {}, images: listingImages,
      variants: variants ?? [{ sku: "sku-a", offerId: "offer-a", name: "Товар", currency: "RUB", blackKopecks: "10000", greenKopecks: "8000", images: variantImages }],
    },
  },
  productDraft: { id: "draft-a", version: 1 }, rawResponseRef: "raw-a", rawResponseHash: "raw-hash-a",
  });
}
const SOURCE_CAPTURE = sourceCapture();
const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", parentPlanId: "plan-a", sourceAssetId: SOURCE_ASSET_ID, expectedStatusVersion: 7 });

function frozenSourceSnapshot(overrides = {}) {
  return { accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, sourceSnapshotId: "snapshot-a", sourceCapture: structuredClone(SOURCE_CAPTURE), ...overrides };
}

function parentPlan(reference = { assetId: scope.sourceAssetId, sourceRefHash: SOURCE_REF_HASH, contentHash: null, sourceRef: null, evidenceKind: "SOURCE_REF_HASH" }, sourceHash = SOURCE_CAPTURE.snapshotHash) {
  const groups = [{ visualGroupKey: "group-a", sourceSkus: ["sku-a"], variantIds: ["variant-a"], referenceImages: [reference], factEvidence: [], reasonCodes: ["COMPLETE_APPEARANCE_EVIDENCE"] }];
  const visualBase = { sourceHash, groups, reasonCodes: ["COMPLETE_APPEARANCE_EVIDENCE"] };
  const visualGroups = { ...visualBase, visualGroupsHash: sha256(visualBase) };
  const plan = { version: 1, language: "ru", slots: [] };
  return { id: scope.parentPlanId, sourceAccountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, sourceSnapshotId: "snapshot-a", sourceHash, planHash: sha256(plan), plan, visualGroupsHash: visualGroups.visualGroupsHash, visualGroups };
}

async function downloaded() {
  const bytes = await sharp({ create: { width: 9, height: 12, channels: 4, background: "green" } }).png().toBuffer();
  return { bytes, contentHash: sha256(bytes), contentType: "image/png", width: 9, height: 12, sizeBytes: bytes.length };
}

function exactReservation(input, overrides = {}) {
  return { status: "RESERVED", ...input, attemptId: "attempt-a", attemptNo: 1, leaseToken: "lease-a", leaseExpiresAt: "2026-08-04T01:00:00.000Z", ...overrides };
}

function repository(overrides = {}) {
  return {
    async reserveSourceMaterialization(input) { return exactReservation(input); },
    async recordStoredSourceMaterialization(value) { return { ...value, leaseExpiresAt: "2026-08-04T01:00:00.000Z", status: "STORED" }; },
    async recordSourceObjectCleanupRequired(value) { return { ...value, status: "PENDING" }; },
    async completeSourceMaterialization(value) { return { ...value, status: "ACCEPTED", acceptedAt: "2026-08-04T00:00:00.000Z", leaseToken: null, leaseExpiresAt: null }; },
    async failSourceMaterialization(value) { return { ...value, status: "FAILED", leaseToken: null, leaseExpiresAt: null }; },
    ...overrides,
  };
}

async function analysisFixture({
  expectedAssetCount = 1,
  execution = { attemptNo: 1, maxAttempts: 3 },
  capture = SOURCE_CAPTURE,
  sourceAsset,
} = {}) {
  const { SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION, enumerateSourceImageAssets } = await import("../auto-listing-source-image-intelligence-contract.mjs");
  const { createMemorySourceImageIntelligenceRepository } = await import("../auto-listing-source-image-intelligence-repository.mjs");
  const intelligenceRepository = createMemorySourceImageIntelligenceRepository({
    now: () => new Date("2026-08-04T00:00:00.000Z"),
    id: () => "analysis-run-a",
    token: () => "analysis-token-a",
  });
  const analysisRun = await intelligenceRepository.reserveAnalysisRun({
    accountId: scope.accountId,
    jobId: scope.jobId,
    itemId: scope.itemId,
    sourceSnapshotId: "snapshot-a",
    expectedStatusVersion: scope.expectedStatusVersion,
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    sourceSnapshotHash: capture.snapshotHash,
    sourceAssetSetHash: H("d"),
    inputHash: H("e"),
    promptTemplateVersion: "source-image-analysis-v1",
    profileId: "profile-a",
    profileVersion: 1,
    modelName: "vision-model",
    expectedAssetCount,
  });
  return {
    scope: {
      accountId: scope.accountId,
      jobId: scope.jobId,
      itemId: scope.itemId,
      expectedStatusVersion: scope.expectedStatusVersion,
    },
    analysisRun,
    sourceAsset: sourceAsset ?? enumerateSourceImageAssets({ sourceCapture: capture })[0],
    sourceSnapshot: frozenSourceSnapshot({ sourceCapture: structuredClone(capture) }),
    execution,
    intelligenceRepository,
  };
}

test("analysis materialization resolves an enumerated asset without a parent plan and records complete SOURCE_V2 evidence", async () => {
  const { materializeSourceImageForAnalysis } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const input = await analysisFixture();
  const bytes = await downloaded();
  input.repository = createMemorySourceMaterializationRepository({
    now: () => Date.parse("2026-08-04T00:00:00.000Z"),
    token: () => "analysis-lease",
    id: () => "analysis-attempt",
  });
  input.downloader = { async downloadSourceImage() { return bytes; } };
  input.storage = {
    async putObjectFromBuffer(value) {
      return { key: value.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes };
    },
    async getObjectBuffer() { return bytes.bytes; },
  };

  const result = await materializeSourceImageForAnalysis(input);

  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.sourceAssetId, SOURCE_ASSET_ID);
  assert.equal(result.sourceOrdinal, 0);
  assert.deepEqual(result.owner, { kind: "SOURCE_IMAGE_ANALYSIS", id: input.analysisRun.id });
  assert.equal(result.objectKeyVersion, "SOURCE_V2");
  assert.match(result.objectKey, /^auto-listing\/source\/v2\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/analysis-run\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\//u);
  assert.deepEqual(
    Object.fromEntries(["objectKey", "contentHash", "contentType", "width", "height", "sizeBytes", "sourceRefHash"].map((key) => [key, result[key]])),
    {
      objectKey: result.objectKey,
      contentHash: bytes.contentHash,
      contentType: bytes.contentType,
      width: bytes.width,
      height: bytes.height,
      sizeBytes: bytes.sizeBytes,
      sourceRefHash: SOURCE_REF_HASH,
    },
  );
  assert.equal(Object.hasOwn(result, "parentPlanId"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.owner), true);

  const replay = await input.intelligenceRepository.markAssetMaterialized({
    accountId: input.scope.accountId,
    jobId: input.scope.jobId,
    itemId: input.scope.itemId,
    analysisRunId: input.analysisRun.id,
    expectedStatusVersion: input.scope.expectedStatusVersion,
    sourceAssetId: result.sourceAssetId,
    sourceOrdinal: result.sourceOrdinal,
    sourceRefHash: result.sourceRefHash,
    objectKey: result.objectKey,
    contentHash: result.contentHash,
    contentType: result.contentType,
    sizeBytes: result.sizeBytes,
  });
  assert.equal(replay.status, "MATERIALIZED", "analysis wrapper must persist the accepted storage facts before returning");
});

test("analysis materialization accepts only the exact Task 1 enumerated source asset", async () => {
  const { materializeSourceImageForAnalysis } = await load();
  const { enumerateSourceImageAssets } = await import("../auto-listing-source-image-intelligence-contract.mjs");
  const forgedUrl = "https://cdn.example.test/forged.png";
  const capture = SOURCE_CAPTURE;
  const legal = enumerateSourceImageAssets({ sourceCapture: capture })[0];
  const forgedHash = crypto.createHash("sha256").update(forgedUrl).digest("hex");
  const candidates = [
    {
      ...legal,
      sourceAssetId: `source-url-${forgedHash.slice(0, 24)}`,
      sourceRefHash: forgedHash,
    },
    { ...legal, sourceOrdinal: legal.sourceOrdinal + 1 },
    { ...legal, sourceRefHash: H("f") },
    { ...legal, contentHash: H("c") },
    { ...legal, memberships: legal.memberships.map((membership, index) => index === 0 ? { ...membership, mediaOrdinal: membership.mediaOrdinal + 1 } : membership) },
  ];
  for (const sourceAsset of candidates) {
    let reservations = 0;
    const input = await analysisFixture({ capture, sourceAsset });
    input.repository = repository({ async reserveSourceMaterialization() { reservations += 1; } });
    input.downloader = { async downloadSourceImage() { throw new Error("must not download"); } };
    input.storage = {};
    await assert.rejects(materializeSourceImageForAnalysis(input), {
      code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID",
    });
    assert.equal(reservations, 0);
  }
});

test("analysis rejects sparse, accessor, symbol, extra-key and Proxy source assets before reservation", async (t) => {
  const { materializeSourceImageForAnalysis } = await load();
  const { enumerateSourceImageAssets } = await import("../auto-listing-source-image-intelligence-contract.mjs");
  const legal = structuredClone(enumerateSourceImageAssets({ sourceCapture: SOURCE_CAPTURE })[0]);
  const sparse = { ...legal, memberships: new Array(legal.memberships.length) };
  let getterCalls = 0;
  const accessor = { ...legal };
  Object.defineProperty(accessor, "sourceAssetId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return getterCalls <= 5 ? legal.sourceAssetId : "forged-source-asset";
    },
  });
  const symbol = { ...legal };
  symbol[Symbol("extra")] = true;
  let membershipGetterCalls = 0;
  const membershipAccessor = { ...legal, memberships: legal.memberships.map((membership) => ({ ...membership })) };
  Object.defineProperty(membershipAccessor.memberships[0], "variantId", {
    enumerable: true,
    get() {
      membershipGetterCalls += 1;
      return legal.memberships[0].variantId;
    },
  });
  const membershipSymbolValue = { ...legal.memberships[0] };
  membershipSymbolValue[Symbol("extra")] = true;
  const candidates = [
    ["sparse memberships", sparse],
    ["accessor", accessor],
    ["symbol", symbol],
    ["extra string key", { ...legal, extra: true }],
    ["Proxy", new Proxy(structuredClone(legal), {})],
    ["membership accessor", membershipAccessor],
    ["membership symbol", { ...legal, memberships: [membershipSymbolValue] }],
    ["membership extra key", { ...legal, memberships: [{ ...legal.memberships[0], extra: true }] }],
    ["membership Proxy", { ...legal, memberships: [new Proxy({ ...legal.memberships[0] }, {})] }],
  ];
  for (const [name, sourceAsset] of candidates) {
    await t.test(name, async () => {
      let reservations = 0;
      const input = await analysisFixture({ sourceAsset });
      input.repository = repository({
        async reserveSourceMaterialization() {
          reservations += 1;
          return { status: "CANCELLED" };
        },
      });
      input.downloader = { async downloadSourceImage() { throw new Error("must not download"); } };
      input.storage = {};
      await assert.rejects(materializeSourceImageForAnalysis(input), {
        code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID",
      });
      assert.equal(reservations, 0);
    });
  }
  assert.equal(getterCalls, 0, "strict cloning must reject the accessor without invoking it");
  assert.equal(membershipGetterCalls, 0, "strict cloning must reject a membership accessor without invoking it");
});

test("analysis materializes a sibling-SKU asset with its exact variant membership", async () => {
  const { materializeSourceImageForAnalysis } = await load();
  const { enumerateSourceImageAssets } = await import("../auto-listing-source-image-intelligence-contract.mjs");
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const firstUrl = "https://cdn.example.test/duplicate-pair-first.png";
  const secondUrl = "https://cdn.example.test/duplicate-pair-second.png";
  const capture = sourceCapture({
    listingImages: [firstUrl],
    variants: [
      {
        sku: "sku-a", offerId: "offer-a", name: "Товар A", currency: "RUB",
        blackKopecks: "10000", greenKopecks: "8000", images: [firstUrl],
        evidence: { variantId: "variant-a" },
      },
      {
        sku: "sku-b", offerId: "offer-b", name: "Товар B", currency: "RUB",
        blackKopecks: "10000", greenKopecks: "8000", images: [secondUrl],
        evidence: { variantId: "variant-b" },
      },
    ],
  });
  const enumerated = enumerateSourceImageAssets({ sourceCapture: capture });
  assert.equal(enumerated.length, 2);
  assert.deepEqual(enumerated[1].memberships, [{
    variantId: "variant-b", sku: "sku-b", mediaOrdinal: 0,
  }]);
  const input = await analysisFixture({ capture, sourceAsset: structuredClone(enumerated[1]), expectedAssetCount: 2 });
  const bytes = await downloaded();
  let downloadedUrl;
  input.repository = createMemorySourceMaterializationRepository({
    token: () => "duplicate-pair-lease",
    id: () => "duplicate-pair-attempt",
  });
  input.downloader = {
    async downloadSourceImage(value) {
      downloadedUrl = value.sourceUrl;
      return bytes;
    },
  };
  input.storage = {
    async putObjectFromBuffer(value) {
      return { key: value.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes };
    },
    async getObjectBuffer() { return bytes.bytes; },
  };
  const result = await materializeSourceImageForAnalysis(input);

  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.sourceAssetId, enumerated[1].sourceAssetId);
  assert.equal(result.sourceOrdinal, 1);
  assert.equal(downloadedUrl, secondUrl);
});

test("analysis accepts a legal plain source-asset DTO", async () => {
  const { materializeSourceImageForAnalysis } = await load();
  const { enumerateSourceImageAssets } = await import("../auto-listing-source-image-intelligence-contract.mjs");
  const legalDto = structuredClone(enumerateSourceImageAssets({ sourceCapture: SOURCE_CAPTURE })[0]);
  const input = await analysisFixture({ sourceAsset: legalDto });
  let reservation;
  input.repository = repository({
    async reserveSourceMaterialization(value) {
      reservation = value;
      return { status: "CANCELLED" };
    },
  });
  input.downloader = {};
  input.storage = {};

  assert.deepEqual(await materializeSourceImageForAnalysis(input), {
    status: "SKIPPED",
    reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_CANCELLED",
  });
  assert.equal(reservation.sourceAssetId, legalDto.sourceAssetId);
});

test("analysis uses the trusted enumerated record after reservation even if the caller mutates its plain DTO", async () => {
  const { materializeSourceImageForAnalysis } = await load();
  const { enumerateSourceImageAssets } = await import("../auto-listing-source-image-intelligence-contract.mjs");
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const callerAsset = structuredClone(enumerateSourceImageAssets({ sourceCapture: SOURCE_CAPTURE })[0]);
  const input = await analysisFixture({ sourceAsset: callerAsset });
  const actualRepository = createMemorySourceMaterializationRepository({
    token: () => "caller-mutation-lease",
    id: () => "caller-mutation-attempt",
  });
  input.repository = {
    ...actualRepository,
    async reserveSourceMaterialization(value) {
      const reservation = await actualRepository.reserveSourceMaterialization(value);
      callerAsset.sourceAssetId = "forged-after-verification";
      callerAsset.sourceOrdinal = 999;
      callerAsset.sourceRefHash = H("f");
      callerAsset.memberships = [];
      return reservation;
    },
  };
  const bytes = await downloaded();
  input.downloader = { async downloadSourceImage() { return bytes; } };
  input.storage = {
    async putObjectFromBuffer(value) {
      return { key: value.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes };
    },
    async getObjectBuffer() { return bytes.bytes; },
  };
  const actualIntelligenceRepository = input.intelligenceRepository;
  let materializedEvidence;
  input.intelligenceRepository = {
    ...actualIntelligenceRepository,
    async markAssetMaterialized(value) {
      materializedEvidence = value;
      return actualIntelligenceRepository.markAssetMaterialized(value);
    },
  };

  const result = await materializeSourceImageForAnalysis(input);

  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.sourceAssetId, SOURCE_ASSET_ID);
  assert.equal(result.sourceOrdinal, 0);
  assert.equal(materializedEvidence.sourceAssetId, SOURCE_ASSET_ID);
  assert.equal(materializedEvidence.sourceOrdinal, 0);
});

test("analysis execution retry budget must exactly match the source download policy", async () => {
  const { materializeSourceImageForAnalysis } = await load();
  const input = await analysisFixture({ execution: { attemptNo: 1, maxAttempts: 2 } });
  let reservations = 0;
  input.repository = repository({ async reserveSourceMaterialization() { reservations += 1; } });
  input.downloader = { async downloadSourceImage() { throw new Error("must not download"); } };
  input.storage = {};
  await assert.rejects(materializeSourceImageForAnalysis(input), {
    code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID",
  });
  assert.equal(reservations, 0);
});

test("a final unsupported source image becomes one terminal assessment", async () => {
  const { materializeSourceImageForAnalysis } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const input = await analysisFixture({ execution: { attemptNo: 3, maxAttempts: 3 } });
  input.repository = createMemorySourceMaterializationRepository({ token: () => "unsupported-lease", id: () => "unsupported-attempt" });
  input.downloader = {
    async downloadSourceImage() {
      const error = new Error("unsafe raw media detail");
      error.code = "AUTO_LISTING_SOURCE_MEDIA_UNSUPPORTED";
      error.retryable = false;
      throw error;
    },
  };
  input.storage = {};

  assert.deepEqual(await materializeSourceImageForAnalysis(input), {
    status: "TERMINAL",
    sourceAssetId: SOURCE_ASSET_ID,
    terminalStatus: "UNSUPPORTED_MEDIA",
  });
  const assessments = await input.intelligenceRepository.listRunAssessments({
    accountId: input.scope.accountId,
    jobId: input.scope.jobId,
    itemId: input.scope.itemId,
    analysisRunId: input.analysisRun.id,
    expectedStatusVersion: input.scope.expectedStatusVersion,
  });
  assert.equal(assessments.length, 1);
  assert.deepEqual(
    { sourceAssetId: assessments[0].sourceAssetId, terminalStatus: assessments[0].terminalStatus, errorCode: assessments[0].errorCode },
    { sourceAssetId: SOURCE_ASSET_ID, terminalStatus: "UNSUPPORTED_MEDIA", errorCode: "AUTO_LISTING_SOURCE_MEDIA_UNSUPPORTED" },
  );
});

test("a retryable non-final analysis download failure remains a workflow retry", async () => {
  const { materializeSourceImageForAnalysis } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const input = await analysisFixture({ execution: { attemptNo: 1, maxAttempts: 3 } });
  input.repository = createMemorySourceMaterializationRepository({ token: () => "retry-lease", id: () => "retry-attempt" });
  input.downloader = {
    async downloadSourceImage() {
      const error = new Error("raw remote failure");
      error.code = "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED";
      error.retryable = true;
      throw error;
    },
  };
  input.storage = {};

  await assert.rejects(materializeSourceImageForAnalysis(input), {
    code: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
    retryable: true,
  });
  assert.deepEqual(await input.intelligenceRepository.listRunAssessments({
    accountId: input.scope.accountId,
    jobId: input.scope.jobId,
    itemId: input.scope.itemId,
    analysisRunId: input.analysisRun.id,
    expectedStatusVersion: input.scope.expectedStatusVersion,
  }), []);
});

test("analysis retries a failed final terminal write from the last safe materialization failure without external I/O", async () => {
  const { materializeSourceImageForAnalysis } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const input = await analysisFixture({ execution: { attemptNo: 1, maxAttempts: 3 } });
  input.repository = createMemorySourceMaterializationRepository({
    token: () => "terminal-replay-lease",
    id: () => `terminal-replay-attempt-${input.repository?.snapshot?.().length ?? 0}`,
  });
  let downloads = 0;
  input.downloader = {
    async downloadSourceImage() {
      downloads += 1;
      const error = new Error("raw remote failure");
      error.code = "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED";
      error.retryable = true;
      throw error;
    },
  };
  input.storage = {
    async putObjectFromBuffer() { throw new Error("must not store"); },
    async getObjectBuffer() { throw new Error("must not read"); },
  };
  const actualIntelligenceRepository = input.intelligenceRepository;
  let terminalWrites = 0;
  input.intelligenceRepository = {
    ...actualIntelligenceRepository,
    async markAssetUnavailable(value) {
      terminalWrites += 1;
      if (terminalWrites === 1) {
        const error = new Error("temporary Task 2 write failure");
        error.code = "AUTO_LISTING_SOURCE_IMAGE_REPOSITORY_FAILED";
        error.retryable = true;
        throw error;
      }
      return actualIntelligenceRepository.markAssetUnavailable(value);
    },
  };

  for (const attemptNo of [1, 2]) {
    input.execution = { attemptNo, maxAttempts: 3 };
    await assert.rejects(materializeSourceImageForAnalysis(input), {
      code: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
      retryable: true,
    });
  }
  input.execution = { attemptNo: 3, maxAttempts: 3 };
  await assert.rejects(materializeSourceImageForAnalysis(input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_REPOSITORY_FAILED",
    retryable: true,
  });

  const result = await materializeSourceImageForAnalysis(input);
  assert.deepEqual(result, {
    status: "TERMINAL",
    sourceAssetId: SOURCE_ASSET_ID,
    terminalStatus: "DOWNLOAD_FAILED",
  });
  assert.equal(downloads, 3, "terminal replay must not repeat download or storage");
  assert.equal(terminalWrites, 2);
  const assessments = await actualIntelligenceRepository.listRunAssessments({
    accountId: input.scope.accountId,
    jobId: input.scope.jobId,
    itemId: input.scope.itemId,
    analysisRunId: input.analysisRun.id,
    expectedStatusVersion: input.scope.expectedStatusVersion,
  });
  assert.equal(assessments.length, 1);
  assert.equal(assessments[0].errorCode, "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED");
  assert.equal(assessments[0].sourceOrdinal, 0);
});

test("analysis claim conflicts remain workflow errors and never become terminal assessments", async () => {
  const { materializeSourceImageForAnalysis } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const input = await analysisFixture({ execution: { attemptNo: 3, maxAttempts: 3 } });
  const actual = createMemorySourceMaterializationRepository({ token: () => "claim-lease", id: () => "claim-attempt" });
  input.repository = {
    ...actual,
    async recordStoredSourceMaterialization() {
      const error = new Error("claim changed");
      error.code = "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED";
      throw error;
    },
  };
  const bytes = await downloaded();
  input.downloader = { async downloadSourceImage() { return bytes; } };
  input.storage = {
    async putObjectFromBuffer(value) {
      return { key: value.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes };
    },
    async getObjectBuffer() { return bytes.bytes; },
    async removeObject() {},
  };

  await assert.rejects(materializeSourceImageForAnalysis(input), {
    code: "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED",
  });
  assert.deepEqual(await input.intelligenceRepository.listRunAssessments({
    accountId: input.scope.accountId,
    jobId: input.scope.jobId,
    itemId: input.scope.itemId,
    analysisRunId: input.analysisRun.id,
    expectedStatusVersion: input.scope.expectedStatusVersion,
  }), []);
});

test("materialization input is deterministic and binds the exact closed scope, parent plan and sourceRefHash", async () => {
  const { buildSourceMaterializationInput } = await load();
  const first = buildSourceMaterializationInput({ scope, parentPlan: parentPlan() });
  const second = buildSourceMaterializationInput({ scope: { ...scope }, parentPlan: structuredClone(parentPlan()) });
  assert.deepEqual(first, second);
  const nextStatusVersion = buildSourceMaterializationInput({ scope: { ...scope, expectedStatusVersion: scope.expectedStatusVersion + 1 }, parentPlan: parentPlan() });
  assert.equal(nextStatusVersion.sourceRefHash, first.sourceRefHash);
  assert.notEqual(nextStatusVersion.inputHash, first.inputHash, "status-version fencing must not collide with a prior accepted unique input");
  assert.match(first.sourceRefHash, /^[a-f0-9]{64}$/u);
  assert.match(first.inputHash, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(first, "sourceUrl"), false);
  assert.throws(() => buildSourceMaterializationInput({ scope: { ...scope, extra: true }, parentPlan: parentPlan() }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  assert.throws(() => buildSourceMaterializationInput({ scope: { ...scope, accountId: "other" }, parentPlan: parentPlan() }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  assert.throws(() => buildSourceMaterializationInput({
    scope,
    parentPlan: parentPlan(),
    policy: { policyVersion: "SOURCE_DOWNLOAD_V1", timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024, maxPixels: 40_000_000, maxRedirects: 3, maxAttempts: 3, forbidHttpsDowngrade: true, apiKey: "forbidden" },
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  for (const policy of [
    { ...structuredClone((await import("../auto-listing-source-downloader.mjs")).AUTO_LISTING_SOURCE_DOWNLOAD_POLICY), maxBytes: 8 * 1024 * 1024 + 1 },
    { ...structuredClone((await import("../auto-listing-source-downloader.mjs")).AUTO_LISTING_SOURCE_DOWNLOAD_POLICY), maxPixels: 40_000_001 },
    { ...structuredClone((await import("../auto-listing-source-downloader.mjs")).AUTO_LISTING_SOURCE_DOWNLOAD_POLICY), maxRedirects: 4 },
    { ...structuredClone((await import("../auto-listing-source-downloader.mjs")).AUTO_LISTING_SOURCE_DOWNLOAD_POLICY), maxAttempts: 2 },
  ]) {
    assert.throws(() => buildSourceMaterializationInput({ scope, parentPlan: parentPlan(), policy }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  for (const accountId of ["https://credentials.example.test", "account-api-key-secret", "密".repeat(81)]) {
    assert.throws(() => buildSourceMaterializationInput({
      scope: { ...scope, accountId },
      parentPlan: { ...parentPlan(), sourceAccountId: accountId },
    }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
});

test("materializer rejects CONTENT_HASH, forged parent hash, and ambiguous source evidence before reservation", async () => {
  const { materializeSourceAsset } = await load();
  const inputs = [
    parentPlan({ assetId: scope.sourceAssetId, sourceRefHash: null, contentHash: H("c"), sourceRef: null, evidenceKind: "CONTENT_HASH" }),
    { ...parentPlan(), planHash: H("0") },
    (() => { const value = parentPlan(); value.visualGroups.groups[0].referenceImages.push({ ...value.visualGroups.groups[0].referenceImages[0], sourceRef: "https://other.example.test/a.png" }); return value; })(),
  ];
  for (const candidate of inputs) {
    let reserves = 0;
    await assert.rejects(materializeSourceAsset({ scope, parentPlan: candidate, sourceSnapshot: frozenSourceSnapshot(), repository: repository({ async reserveSourceMaterialization() { reserves += 1; } }), downloader: { async downloadSourceImage() { throw new Error("must not download"); } }, storage: {} }), (error) => /^AUTO_LISTING_SOURCE_(?:ALREADY_MATERIALIZED|MATERIALIZATION_INPUT_INVALID)$/u.test(error?.code || ""));
    assert.equal(reserves, 0);
  }
});

test("materializer requires one exact frozen snapshot and rejects missing, duplicate or cross-scope evidence before reservation", async () => {
  const { materializeSourceAsset } = await load();
  const missingReference = parentPlan({
    assetId: `source-url-${H("f").slice(0, 24)}`,
    sourceRefHash: H("f"),
    contentHash: null,
    sourceRef: null,
    evidenceKind: "SOURCE_REF_HASH",
  });
  const candidates = [
    { parentPlan: parentPlan(), sourceSnapshot: undefined },
    { parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot({ accountId: "account-b" }) },
    { parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot({ jobId: "job-b" }) },
    { parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot({ itemId: "item-b" }) },
    { parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot({ sourceSnapshotId: "snapshot-latest" }) },
    { parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot({ sourceCapture: [SOURCE_CAPTURE, SOURCE_CAPTURE] }) },
    { parentPlan: missingReference, sourceSnapshot: frozenSourceSnapshot() },
  ];
  for (const candidate of candidates) {
    let reservations = 0;
    await assert.rejects(materializeSourceAsset({
      scope,
      ...candidate,
      repository: repository({ async reserveSourceMaterialization() { reservations += 1; } }),
      downloader: { async downloadSourceImage() { throw new Error("must not download"); } },
      storage: {},
    }), { code: "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID" });
    assert.equal(reservations, 0);
  }
});

test("reservation happens before the only download and accepted completion", async () => {
  const { materializeSourceAsset } = await load();
  const bytes = await downloaded();
  const calls = [];
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({
      async reserveSourceMaterialization(input) { calls.push("reserve"); return exactReservation(input); },
      async recordStoredSourceMaterialization(value) { calls.push("record-stored"); return { ...value, leaseExpiresAt: "2026-08-04T01:00:00.000Z", status: "STORED" }; },
      async completeSourceMaterialization(value) { calls.push("complete"); return { ...value, status: "ACCEPTED", acceptedAt: "2026-08-04T00:00:00.000Z", leaseToken: null, leaseExpiresAt: null }; },
    }),
    downloader: { async downloadSourceImage() { calls.push("download"); return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { calls.push("put"); return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { calls.push("read"); return bytes.bytes; },
    },
  });
  assert.deepEqual(calls, ["reserve", "download", "put", "read", "record-stored", "complete"]);
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.sourceRefHash.length, 64);
  assert.equal(JSON.stringify(result).includes("cdn.example"), false);
});

test("reservation cannot swap the exact frozen snapshot URL before download", async () => {
  const { materializeSourceAsset } = await load();
  const bytes = await downloaded();
  const mutablePlan = parentPlan();
  const mutableSnapshot = frozenSourceSnapshot();
  const originalUrl = SOURCE_URL;
  let downloadedUrl;
  const result = await materializeSourceAsset({
    scope, parentPlan: mutablePlan, sourceSnapshot: mutableSnapshot,
    repository: repository({
      async reserveSourceMaterialization(input) {
        mutableSnapshot.sourceCapture.snapshot.variants[0].media[0] = "https://attacker.example.test/swapped.png";
        return exactReservation(input);
      },
    }),
    downloader: { async downloadSourceImage(input) { downloadedUrl = input.sourceUrl; return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { return bytes.bytes; },
    },
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(downloadedUrl, originalUrl);
});

test("the production memory repository composes with the materializer without timestamp or record-shape adapters", async () => {
  const { materializeSourceAsset } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const bytes = await downloaded();
  const actualRepository = createMemorySourceMaterializationRepository({
    now: () => Date.parse("2026-08-04T00:00:00.000Z"), token: () => "lease-production", id: () => "attempt-production",
  });
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: actualRepository,
    downloader: { async downloadSourceImage() { return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { return bytes.bytes; },
    },
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.sourceAssetId, scope.sourceAssetId);
});

test("a production repository records cleanup even when the object was never recorded on the attempt row", async () => {
  const { materializeSourceAsset } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const bytes = await downloaded();
  const actual = createMemorySourceMaterializationRepository({
    now: () => Date.parse("2026-08-04T00:00:00.000Z"), token: () => "lease-cleanup", id: () => "attempt-cleanup",
  });
  let cleanupRecord;
  const wrapped = {
    ...actual,
    async recordStoredSourceMaterialization() { throw new Error("database failed before evidence was stored"); },
    async recordSourceObjectCleanupRequired(input) {
      cleanupRecord = await actual.recordSourceObjectCleanupRequired(input);
      return cleanupRecord;
    },
  };
  await assert.rejects(materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: wrapped,
    downloader: { async downloadSourceImage() { return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { return bytes.bytes; },
      async removeObject() { throw new Error("object store temporarily unavailable"); },
    },
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED" && error?.retryable === true);
  assert.equal(cleanupRecord?.status, "PENDING");
  assert.equal(cleanupRecord?.materializationAttemptId, "attempt-cleanup");
});

test("cancelled and stale reservations acknowledge with zero downloader or storage calls", async () => {
  const { materializeSourceAsset } = await load();
  for (const status of ["CANCELLED", "STALE"]) {
    let externalCalls = 0;
    const result = await materializeSourceAsset({
      scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: repository({ async reserveSourceMaterialization() { return { status }; } }),
      downloader: { async downloadSourceImage() { externalCalls += 1; } },
      storage: { async putObjectFromBuffer() { externalCalls += 1; }, async getObjectBuffer() { externalCalls += 1; } },
    });
    assert.deepEqual(result, { status: "SKIPPED", reasonCode: status === "CANCELLED" ? "AUTO_LISTING_SOURCE_MATERIALIZATION_CANCELLED" : "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
    assert.equal(externalCalls, 0);
  }
});

test("an in-progress duplicate acknowledges and exhausted attempts fail non-retryable with zero external calls", async () => {
  const { materializeSourceAsset } = await load();
  for (const status of ["IN_PROGRESS", "ATTEMPTS_EXHAUSTED"]) {
    let externalCalls = 0;
    const action = materializeSourceAsset({
      scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: repository({ async reserveSourceMaterialization() { return { status }; } }),
      downloader: { async downloadSourceImage() { externalCalls += 1; } },
      storage: { async putObjectFromBuffer() { externalCalls += 1; }, async getObjectBuffer() { externalCalls += 1; } },
    });
    if (status === "IN_PROGRESS") {
      assert.deepEqual(await action, { status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_IN_PROGRESS" });
    } else {
      await assert.rejects(action, (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_ATTEMPTS_EXHAUSTED" && error?.retryable === false);
    }
    assert.equal(externalCalls, 0);
  }
});

test("cancellation discovered while recording stored evidence removes the object and acknowledges without acceptance", async () => {
  const { materializeSourceAsset } = await load();
  const bytes = await downloaded();
  let removed = 0; let completed = 0;
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({
      async recordStoredSourceMaterialization() {
        const error = new Error("raw database message");
        error.code = "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED";
        throw error;
      },
      async completeSourceMaterialization() { completed += 1; throw new Error("must not complete"); },
      async failSourceMaterialization() { throw new Error("must not fail a cancelled claim"); },
    }),
    downloader: { async downloadSourceImage() { return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { return bytes.bytes; },
      async removeObject() { removed += 1; },
    },
  });
  assert.deepEqual(result, { status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
  assert.equal(removed, 1);
  assert.equal(completed, 0);
});

test("cancellation discovered at completion removes the stored object before acknowledging", async () => {
  const { materializeSourceAsset } = await load();
  const bytes = await downloaded();
  let removed = 0;
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({
      async completeSourceMaterialization() {
        const error = new Error("raw database message");
        error.code = "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED";
        throw error;
      },
    }),
    downloader: { async downloadSourceImage() { return bytes; } },
    storage: {
      async putObjectFromBuffer(input) { return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes }; },
      async getObjectBuffer() { return bytes.bytes; },
      async removeObject() { removed += 1; },
    },
  });
  assert.deepEqual(result, { status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
  assert.equal(removed, 1);
});

test("an exact accepted replay makes zero downloader and storage calls even if the remote content changes", async () => {
  const { buildSourceMaterializationInput, materializeSourceAsset } = await load();
  const built = buildSourceMaterializationInput({ scope, parentPlan: parentPlan() });
  const accepted = {
    ...scope, sourceRefHash: built.sourceRefHash, inputHash: built.inputHash, expectedStatusVersion: scope.expectedStatusVersion,
    attemptId: "attempt-a", attemptNo: 1, status: "ACCEPTED", objectKeyVersion: "SOURCE_V1",
    contentHash: H("c"), contentType: "image/png", width: 9, height: 12, sizeBytes: 90, acceptedAt: "2026-08-04T00:00:00.000Z",
    leaseToken: null, leaseExpiresAt: null, errorCode: null, errorRetryable: null,
  };
  const { buildSourceAssetObjectKey } = await import("../auto-listing-source-asset-store.mjs");
  accepted.objectKey = buildSourceAssetObjectKey(accepted);
  let externalCalls = 0;
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: repository({ async reserveSourceMaterialization() { return { status: "EXISTING_ACCEPTED", record: accepted }; } }),
    downloader: { async downloadSourceImage() { externalCalls += 1; return downloaded(); } },
    storage: { async putObjectFromBuffer() { externalCalls += 1; }, async getObjectBuffer() { externalCalls += 1; } },
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.contentHash, H("c"));
  assert.equal(externalCalls, 0);
});

test("a reclaimed STORED attempt is read back before completion with zero download or write calls", async () => {
  const { buildSourceMaterializationInput, materializeSourceAsset } = await load();
  const { buildSourceAssetObjectKey } = await import("../auto-listing-source-asset-store.mjs");
  const built = buildSourceMaterializationInput({ scope, parentPlan: parentPlan() });
  const bytes = await downloaded();
  const stored = {
    ...scope, sourceRefHash: built.sourceRefHash, inputHash: built.inputHash,
    attemptId: "attempt-a", attemptNo: 1, leaseToken: "reclaimed-lease", leaseExpiresAt: "2026-08-04T01:00:00.000Z",
    status: "STORED", objectKeyVersion: "SOURCE_V1", contentHash: bytes.contentHash, contentType: bytes.contentType,
    width: bytes.width, height: bytes.height, sizeBytes: bytes.sizeBytes,
  };
  stored.objectKey = buildSourceAssetObjectKey(stored);
  let downloads = 0; let writes = 0; let reads = 0; let completed = 0;
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({
      async reserveSourceMaterialization() { return { status: "RESERVED_STORED", record: stored }; },
      async completeSourceMaterialization(value) { completed += 1; return { ...value, status: "ACCEPTED", acceptedAt: "2026-08-04T00:00:00.000Z", leaseToken: null, leaseExpiresAt: null }; },
    }),
    downloader: { async downloadSourceImage() { downloads += 1; } },
    storage: {
      async putObjectFromBuffer() { writes += 1; },
      async getObjectBuffer() { reads += 1; return bytes.bytes; },
    },
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.contentHash, bytes.contentHash);
  assert.equal(completed, 1);
  assert.deepEqual({ downloads, writes, reads }, { downloads: 0, writes: 0, reads: 1 });
});

test("accepted replay fails closed on cross-scope, wrong hash or forged object evidence", async () => {
  const { buildSourceMaterializationInput, materializeSourceAsset } = await load();
  const built = buildSourceMaterializationInput({ scope, parentPlan: parentPlan() });
  const base = { ...scope, sourceRefHash: built.sourceRefHash, inputHash: built.inputHash, attemptId: "attempt-a", attemptNo: 1, status: "ACCEPTED", objectKeyVersion: "SOURCE_V1", objectKey: "forged", contentHash: H("c"), contentType: "image/png", width: 9, height: 12, sizeBytes: 90, acceptedAt: "2026-08-04T00:00:00.000Z", leaseToken: null, leaseExpiresAt: null, errorCode: null, errorRetryable: null };
  for (const record of [{ ...base, accountId: "other" }, { ...base, inputHash: H("d") }, base]) {
    await assert.rejects(materializeSourceAsset({ scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: repository({ async reserveSourceMaterialization() { return { status: "EXISTING_ACCEPTED", record }; } }), downloader: {}, storage: {} }), (error) => error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_REPLAY_INVALID");
  }
});

test("download failure is persisted with only a closed safe error code and never the source URL", async () => {
  const { materializeSourceAsset } = await load();
  let failure;
  await assert.rejects(materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({ async failSourceMaterialization(value) { failure = value; return { ...value, status: "FAILED", leaseToken: null, leaseExpiresAt: null }; } }),
    downloader: { async downloadSourceImage() { const error = new Error("https://cdn.example.test/?token=secret socket failed"); error.code = "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED"; error.retryable = true; throw error; } },
    storage: {},
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED" && error?.retryable === true
    && !/cdn|secret|socket/u.test(error.message) && !error.cause);
  assert.equal(failure.errorCode, "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED");
  assert.equal(failure.errorRetryable, true);
  assert.equal(JSON.stringify(failure).includes("cdn.example"), false);
});

test("legacy materialization does not expose the analysis-only unsupported-media failure code", async () => {
  const { materializeSourceAsset } = await load();
  let failure;
  await assert.rejects(materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({ async failSourceMaterialization(value) { failure = value; return { ...value, status: "FAILED", leaseToken: null, leaseExpiresAt: null }; } }),
    downloader: {
      async downloadSourceImage() {
        const error = new Error("unsupported raw media");
        error.code = "AUTO_LISTING_SOURCE_MEDIA_UNSUPPORTED";
        error.retryable = false;
        throw error;
      },
    },
    storage: {},
  }), {
    code: "AUTO_LISTING_SOURCE_MATERIALIZATION_FAILED",
    retryable: true,
  });
  assert.equal(failure.errorCode, "AUTO_LISTING_SOURCE_MATERIALIZATION_FAILED");
  assert.equal(failure.errorRetryable, true);
});

test("cancellation discovered while persisting a download failure acknowledges without raw errors or later effects", async () => {
  const { materializeSourceAsset } = await load();
  const result = await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(),
    repository: repository({
      async failSourceMaterialization() {
        const error = new Error("raw database url and secret");
        error.code = "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED";
        throw error;
      },
    }),
    downloader: { async downloadSourceImage() { const error = new Error("raw socket url"); error.code = "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED"; error.retryable = true; throw error; } },
    storage: {},
  });
  assert.deepEqual(result, { status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
});

test("an expired completion lease cannot later accept a STORED record whose object was removed", async () => {
  const { materializeSourceAsset } = await load();
  const { createMemorySourceMaterializationRepository } = await import("../auto-listing-source-materialization-repository.mjs");
  const bytes = await downloaded();
  let clock = 1_000;
  let nonce = 0;
  const actual = createMemorySourceMaterializationRepository({
    now: () => clock,
    leaseMs: 10,
    token: () => `lease-${++nonce}`,
    id: () => `attempt-expired-completion-${nonce}`,
  });
  const wrapped = {
    ...actual,
    async recordStoredSourceMaterialization(input) {
      const value = await actual.recordStoredSourceMaterialization(input);
      clock = 1_011;
      return value;
    },
  };
  let exists = false;
  let removals = 0;
  const storage = {
    async putObjectFromBuffer(input) {
      exists = true;
      return { key: input.key, sha256: bytes.contentHash, contentType: bytes.contentType, size: bytes.sizeBytes };
    },
    async getObjectBuffer() { if (!exists) throw new Error("missing object"); return bytes.bytes; },
    async removeObject() { removals += 1; exists = false; },
  };
  assert.deepEqual(await materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: wrapped,
    downloader: { async downloadSourceImage() { return bytes; } }, storage,
  }), { status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
  assert.equal(exists, false);

  await assert.rejects(materializeSourceAsset({
    scope, parentPlan: parentPlan(), sourceSnapshot: frozenSourceSnapshot(), repository: actual,
    downloader: { async downloadSourceImage() { throw new Error("must not use the remote URL for a STORED recovery"); } },
    storage,
  }), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_STORAGE_UNAVAILABLE" && error?.retryable === true);
  assert.equal(actual.snapshot()[0].status, "FAILED");
  assert.equal(removals, 2, "both stale completion and failed recovery must leave no unreferenced object");
});

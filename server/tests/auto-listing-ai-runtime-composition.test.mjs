import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  createAutoListingAiProductionDependencies,
  createAutoListingAiProductionOutboxRelay,
  createAutoListingPlanDiagnosticProductionPorts,
  createDefaultAutoListingAiProductionDependencies,
  createDefaultAutoListingAiProductionOutboxRelay,
} from "../auto-listing-ai-runtime-composition.mjs";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createMemoryImageGroupCheckRepository } from "../auto-listing-image-group-check-repository.mjs";
import { SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION } from "../auto-listing-source-image-intelligence-contract.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import {
  AUTO_LISTING_AI_CURRENT_LEGACY_QUEUE,
  AUTO_LISTING_AI_CURRENT_LEGACY_QUEUE_OPTIONS,
  AUTO_LISTING_AI_CURRENT_WORK_QUEUE,
  AUTO_LISTING_AI_CURRENT_WORK_QUEUE_OPTIONS,
  createAutoListingAiWorkPublisher,
  createAutoListingAiWorkQueueAdapter,
  createLegacyAutoListingAiOutboxPublisher,
  createLegacyAutoListingAiQueueAdapter,
} from "../auto-listing-ai-queue.mjs";

const phases = Object.freeze({
  planContent: async () => ({ id: "plan-a" }),
  materializeSourceAsset: async () => ({ status: "ACCEPTED" }),
  finalizeMaterializedPlan: async () => ({ id: "derived-a" }),
  generateImageSlot: async () => ({ status: "ACCEPTED" }),
  generateRichContent: async () => ({ status: "ACCEPTED" }),
});

function enabledEnv(overrides = {}) {
  return {
    AUTO_LISTING_ENABLED: "1",
    AUTO_LISTING_AI_ENABLED: "1",
    AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "ACCOUNT_A_AI_KEY,ACCOUNT_B_AI_KEY",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "https://gateway.example.test/tenant/v1",
    DATABASE_URL: "postgres://runtime.invalid/sonli",
    MINIO_ENDPOINT: "storage.internal",
    MINIO_ACCESS_KEY: "storage-access",
    MINIO_SECRET_KEY: "storage-secret-value",
    MINIO_BUCKET: "auto-listing",
    ACCOUNT_A_AI_KEY: "account-a-secret",
    ACCOUNT_B_AI_KEY: "account-b-secret",
    AUTO_LISTING_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
    AUTO_LISTING_CREDENTIAL_KEY_VERSION: "runtime-v1",
    ...overrides,
  };
}

function context(message, profile) {
  return Object.freeze({
    accountId: message.accountId,
    jobId: message.accountId === "account-a" ? "job-a" : "job-b",
    itemId: message.itemId,
    status: "PLANNING",
    statusVersion: message.expectedStatusVersion,
    activeContentPlanId: null,
    phaseInput: Object.freeze({ gatewayProfile: Object.freeze(profile) }),
  });
}

function testPorts(events) {
  const repository = (name) => ({ name });
  return Object.freeze({
    createBoss(input) { events.push(["boss", input]); return { name: "boss-a" }; },
    async loadCredentialKey({ env }) {
      events.push(["credential-key", env.AUTO_LISTING_CREDENTIAL_KEY_VERSION]);
      return Buffer.alloc(32, 7);
    },
    createCipher(input) {
      events.push(["cipher", input.keyVersion]);
      return Object.freeze({ decrypt() { return "connection-secret"; } });
    },
    createCredentialRepository({ pool }) {
      events.push(["credential-repository", pool]);
      return Object.freeze({ async loadConnectionForSecretResolution() {} });
    },
    createCredentialResolver(input) {
      events.push(["credential-resolver", input]);
      return Object.freeze({ async resolveSecret() { return "connection-secret"; } });
    },
    createGateway({ readSecret, resolveSecret, gatewayPolicy, allowLocalGateway }) {
      events.push(["gateway", gatewayPolicy, allowLocalGateway]);
      return Object.freeze({
        readSecret,
        resolveSecret,
        async createTextResponse() { throw new Error("real AI must not be called by composition"); },
        async generateImage() { throw new Error("real AI must not be called by composition"); },
        async inspectImage() { throw new Error("real AI must not be called by composition"); },
      });
    },
    createWorkflow(input) {
      events.push(["workflow", input]);
      return Object.freeze({
        async stageInitialPlanWork() { throw new Error("job staging must not be called by worker composition"); },
        async applyPhaseOutcome(input) {
          events.push(["apply-outcome", input]);
          return Object.freeze({ applied: true });
        },
        async requeueChannelFailure(input) {
          events.push(["requeue-channel", input]);
          return Object.freeze({ requeued: true });
        },
      });
    },
    createContentPlanRepository({ pool }) { events.push(["content", pool]); return repository("content"); },
    createContentPlanEvidenceRepository({ pool }) {
      events.push(["content-evidence", pool]);
      return Object.freeze({
        async recordResponse() {},
        async recordValidation() {},
        async loadOutcome() {},
      });
    },
    createSourceMaterializationRepository({ pool }) { events.push(["source", pool]); return repository("source"); },
    createGenerationRepository({ pool }) { events.push(["generation", pool]); return repository("generation"); },
    createRichContentRepository({ pool }) { events.push(["rich", pool]); return repository("rich"); },
    createDownloader() {
      events.push(["downloader"]);
      return Object.freeze({ async downloadSourceImage() { throw new Error("network must not be called"); } });
    },
    createStorage({ env }) {
      events.push(["storage", env.MINIO_BUCKET]);
      return Object.freeze({
        async putObjectFromBuffer() { throw new Error("storage must not be called"); },
        async getObjectBuffer() { throw new Error("storage must not be called"); },
        async removeObject() { throw new Error("storage must not be called"); },
      });
    },
    createSourceAssetLoader({ pool, storage }) {
      events.push(["source-loader", pool, storage]);
      return Object.freeze({ async loadSourceAsset() { throw new Error("loader must not be called"); } });
    },
    createContextLoader(options) {
      events.push(["context-loader", options]);
      assert.equal(Object.hasOwn(options, "gatewayProfile"), false);
      return async (message) => context(message, message.accountId === "account-a" ? {
        id: "profile-a", accountId: "account-a", configVersion: 3,
        apiKeyEnvName: "ACCOUNT_A_AI_KEY",
      } : {
        id: "profile-b", accountId: "account-b", configVersion: 9,
        apiKeyEnvName: "ACCOUNT_B_AI_KEY",
      });
    },
    orchestratePhase(input, services) {
      events.push(["orchestrate", input, services]);
      return Object.freeze({ disposition: "ACK" });
    },
    phaseServices: phases,
  });
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function reconciliationSourceCapture() {
  const image = { assetId: "source-back", contentHash: hash("source-back") };
  return buildAutoListingSourceSnapshot({
    accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-a", sourceVersion: "1",
    targetStoreId: "store-a", targetStoreCurrency: "RUB",
    categoryEvidence: {
      id: "category-evidence-a", accountId: "account-a", sourceDescriptionCategoryId: 170,
      sourceTypeId: 99, taxonomyScope: "OZON:DEFAULT",
    },
    sharedCategory: {
      id: "shared-category-a", accountId: "account-a", version: 1, evidenceId: "category-evidence-a",
      status: "ACTIVE", source: "SOURCE_DIRECT", sourceDescriptionCategoryId: 170, sourceTypeId: 99,
      currentDescriptionCategoryId: 170, currentTypeId: 99, taxonomyScope: "OZON:DEFAULT",
      taxonomyFingerprint: null,
    },
    collectItem: { id: "collect-a", accountId: "account-a", listingDraft: {
      sku: "sku-a", title: "Thermos", brand: "Brand", currency: "RUB",
      blackKopecks: "10000", greenKopecks: "8000",
      categoryResolution: {
        status: "MATCHED", method: "taxonomy",
        target: { storeId: "store-a", descriptionCategoryId: "170", typeId: "99" },
      },
      images: [image],
      variants: [{
        sku: "sku-a", offerId: "offer-sku-a", name: "sku-a", currency: "RUB",
        blackKopecks: "10000", greenKopecks: "8000", images: [image],
      }],
    } },
    productDraft: { id: "draft-a", version: 1 }, rawResponseRef: "raw-a", rawResponseHash: hash("raw-a"),
  });
}

function reconciliationAssessment({ uncertainMarking = false, usable = true } = {}) {
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    sourceAssetId: "source-back", sourceOrdinal: 0, objectKey: "source/source-back.png",
    contentHash: hash("source-back"), parentSourceAssetId: null, terminalStatus: "ANALYZED",
    contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [{ kind: "BACK", confidence: "CONFIRMED", reasonCodes: ["VISIBLE_BACK"] }],
    subjectBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    quality: { confidence: "CONFIRMED", usable, reasonCodes: usable ? [] : ["LOW_QUALITY"] },
    ocrRegions: [],
    markings: uncertainMarking ? [{
      kind: "UNCERTAIN_MARKING", region: { x: 0.25, y: 0.25, width: 0.2, height: 0.1 },
      confidence: "UNCERTAIN", reasonCodes: ["SUBJECT_OVERLAP"],
    }] : [],
    perceptualDuplicateGroup: null, duplicateOfSourceAssetId: null,
    eligibleUses: usable ? ["IDENTITY_ANCHOR", "TARGET_VIEW"] : ["UNUSABLE"], reasonCodes: [],
  };
  return { ...value, assessmentHash: hash(value) };
}

async function runtimeReconciler(downstreamCalls) {
  const basePorts = testPorts([]);
  const dependencies = await createAutoListingAiProductionDependencies({
    env: enabledEnv(),
    resolvePool: async () => Object.freeze({ async query() {}, async connect() {} }),
    ports: Object.freeze({
      ...basePorts,
      phaseServices: Object.freeze({
        ...phases,
        async planContent() { downstreamCalls.push("PLAN_CONTENT"); },
        async finalizeMaterializedPlan() { downstreamCalls.push("FINALIZE_MATERIALIZED_PLAN"); },
        async generateImageSlot() { downstreamCalls.push("GENERATE_IMAGE_SLOT"); },
        async generateRichContent() { downstreamCalls.push("GENERATE_RICH_CONTENT"); },
      }),
      orchestratePhase: (input, services) => services.reconcileSourceImageAnalysis(input),
    }),
  });
  return dependencies.orchestrate;
}

function reconciliationInput({ assessments, repository }) {
  return {
    sourceCapture: reconciliationSourceCapture(),
    assessments: assessments.map((assessment) => ({ assessment })),
    decisions: [], repository,
    scope: { accountId: "account-a", jobId: "job-a", itemId: "item-a", expectedStatusVersion: 1 },
    run: { id: "analysis-run-a" }, summaryInputHash: "f".repeat(64),
  };
}

test("runtime reconciliation persists a zero-eligible confirmation summary before downstream paid phases", async () => {
  const downstreamCalls = [];
  const reconcile = await runtimeReconciler(downstreamCalls);
  const repositoryResult = Object.freeze({ id: "analysis-run-a", status: "CONFIRMATION_REQUIRED" });
  let acceptSummaryCalls = 0;
  const repository = Object.freeze({
    async acceptSummary(input) {
      acceptSummaryCalls += 1;
      assert.equal(input.analysisRunId, "analysis-run-a");
      assert.equal(input.inputHash, "f".repeat(64));
      assert.deepEqual(input.summary.eligibleAssetIds, []);
      assert.equal(input.summary.requiredConfirmations.length, 1);
      assert.equal(input.summary.requiredConfirmations[0].sourceAssetId, "source-back");
      return repositoryResult;
    },
  });

  const result = await reconcile(reconciliationInput({
    assessments: [reconciliationAssessment({ uncertainMarking: true })], repository,
  }));

  assert.equal(result, repositoryResult);
  assert.equal(acceptSummaryCalls, 1);
  assert.deepEqual(downstreamCalls, []);
});

test("runtime reconciliation rejects zero eligible assets without confirmations before persistence", async () => {
  const downstreamCalls = [];
  const reconcile = await runtimeReconciler(downstreamCalls);
  let acceptSummaryCalls = 0;
  await assert.rejects(reconcile(reconciliationInput({
    assessments: [reconciliationAssessment({ usable: false })],
    repository: Object.freeze({ async acceptSummary() { acceptSummaryCalls += 1; } }),
  })), { code: "AUTO_LISTING_SOURCE_IMAGE_EVIDENCE_INSUFFICIENT", retryable: false });
  assert.equal(acceptSummaryCalls, 0);
  assert.deepEqual(downstreamCalls, []);
});

test("runtime reconciliation rejects empty assessments before persistence", async () => {
  const downstreamCalls = [];
  const reconcile = await runtimeReconciler(downstreamCalls);
  let acceptSummaryCalls = 0;
  await assert.rejects(reconcile(reconciliationInput({
    assessments: [],
    repository: Object.freeze({ async acceptSummary() { acceptSummaryCalls += 1; } }),
  })), { code: "AUTO_LISTING_SOURCE_IMAGE_EVIDENCE_INSUFFICIENT", retryable: false });
  assert.equal(acceptSummaryCalls, 0);
  assert.deepEqual(downstreamCalls, []);
});

test("production worker passes the enabled DIRECT server gate into its durable workflow", async () => {
  const events = [];
  const pool = Object.freeze({ async query() {}, async connect() {} });
  await createAutoListingAiProductionDependencies({
    env: enabledEnv({ AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "true" }),
    resolvePool: async () => pool,
    ports: testPorts(events),
  });

  assert.deepEqual(events.find(([name]) => name === "workflow")[1], {
    pool,
    directUploadAllowed: true,
  });
});

test("production composition keeps account/job-frozen profiles per message and has no global profile selector", async () => {
  const events = [];
  const env = enabledEnv({
    AUTO_LISTING_AI_PROFILE_ID: "must-not-be-read",
    AUTO_LISTING_AI_PROFILE_VERSION: "999",
  });
  const pool = Object.freeze({ async query() {}, async connect() {} });
  let pools = 0;
  const dependencies = await createAutoListingAiProductionDependencies({
    env,
    resolvePool: async () => { pools += 1; return pool; },
    ports: testPorts(events),
  });

  assert.equal(pools, 1);
  assert.deepEqual(Object.keys(dependencies).sort(), ["bossFactory", "executionRepository", "loadContext", "orchestrate", "sourceImageAnalyzer", "workflow"]);
  const workerInput = { ...dependencies, enabled: true };
  assert.equal(workerInput.sourceImageAnalyzer, dependencies.sourceImageAnalyzer);
  assert.equal(typeof workerInput.sourceImageAnalyzer, "function");
  assert.equal(events.filter(([name]) => name === "gateway").length, 1);
  assert.equal(events.filter(([name]) => name === "boss").length, 0);
  const options = events.find(([name]) => name === "context-loader")[1];
  assert.deepEqual(Object.keys(options).sort(), [
    "contentPlanEvidenceRepository", "contentPlanRepository", "downloader", "gateway", "generationRepository", "imageGroupCheckRepository", "imageGroupChecker", "logger", "maxAttempts",
    "planPromptTemplateVersion", "pool", "prohibitedClaims", "referenceProjector", "richContentLeaseOwner",
    "richContentMaxAttempts", "richContentRepository", "sourceAnalysisAssetLoader", "sourceAssetLoader",
    "sourceImageDerivativeRepository", "sourceImageIntelligenceRepository",
    "sourceMaterializationRepository", "storage",
  ]);
  assert.equal(options.planPromptTemplateVersion, "AUTO_LISTING_CONTENT_PLAN_V3");
  assert.equal(options.maxAttempts, 3);
  assert.equal(options.richContentMaxAttempts, 5);
  assert.equal(typeof options.referenceProjector, "function");
  assert.equal(typeof options.imageGroupCheckRepository.loadOutcome, "function");
  assert.equal(typeof options.imageGroupCheckRepository.recordOutcome, "function");
  assert.equal(typeof options.sourceImageDerivativeRepository.loadAttempt, "function");
  assert.equal(typeof options.sourceImageDerivativeRepository.recordGeneratedCandidate, "function");
  assert.equal(typeof options.sourceImageDerivativeRepository.recordCheckResult, "function");
  await dependencies.orchestrate({ marker: "phase-service-check" });
  const composedServices = events.find(([name, input]) => name === "orchestrate"
    && input?.marker === "phase-service-check")[2];
  assert.equal(typeof composedServices.cleanSourceImageOverlay, "function");
  assert.equal(typeof composedServices.checkSourceImageCleanup, "function");

  const message = (accountId, itemId) => ({
    contractVersion: "V1", accountId, itemId, phase: "PLAN_CONTENT",
    expectedStatusVersion: 1, correlationId: `correlation-${accountId}`,
  });
  const accountA = await dependencies.loadContext(message("account-a", "item-a"));
  const accountB = await dependencies.loadContext(message("account-b", "item-b"));
  assert.deepEqual(
    [accountA.phaseInput.gatewayProfile.id, accountA.phaseInput.gatewayProfile.configVersion],
    ["profile-a", 3],
  );
  assert.deepEqual(
    [accountB.phaseInput.gatewayProfile.id, accountB.phaseInput.gatewayProfile.configVersion],
    ["profile-b", 9],
  );

  const gateway = options.gateway;
  assert.equal(gateway.readSecret(accountA.phaseInput.gatewayProfile.apiKeyEnvName), "account-a-secret");
  assert.equal(gateway.readSecret(accountB.phaseInput.gatewayProfile.apiKeyEnvName), "account-b-secret");
  assert.equal(gateway.readSecret("MINIO_SECRET_KEY"), undefined);
  assert.equal(await gateway.resolveSecret({
    accountId: "account-a", connectionId: "connection-a", connectionVersion: 1,
  }), "connection-secret");
  assert.equal(JSON.stringify(dependencies).includes("secret"), false);
  assert.deepEqual(Object.keys(dependencies.workflow), ["applyOutcome"]);
  const appliedMessage = message("account-a", "item-a");
  const appliedOutcome = Object.freeze({
    contractVersion: "V1", disposition: "ACK", phase: "PLAN_CONTENT", outcome: "PLAN_READY",
    retryable: false, failureCode: null, correlationId: appliedMessage.correlationId,
    failureScope: null, deliveryState: null, retryAfterMs: null,
  });
  assert.deepEqual(await dependencies.workflow.applyOutcome({
    message: appliedMessage, outcome: appliedOutcome, execution: null,
  }), { applied: true });
  assert.deepEqual(events.find(([name]) => name === "apply-outcome")[1], {
    message: appliedMessage, outcome: appliedOutcome, execution: null,
  });
  assert.deepEqual(Object.keys(dependencies.executionRepository).sort(), ["adopt", "renew", "requeueChannelFailure"]);
  assert.deepEqual(await dependencies.bossFactory(), { name: "boss-a" });
  assert.equal(events.filter(([name]) => name === "boss").length, 1);
});

test("source analysis loader reuses immutable bytes from an earlier run in the same item scope", async () => {
  const events = [];
  const bytes = Buffer.from("immutable-source-image");
  const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const encode = (value) => Buffer.from(value, "utf8").toString("base64url");
  const accountId = "account-a";
  const jobId = "job-a";
  const itemId = "item-a";
  const sourceAssetId = "source-a";
  const currentRunId = "source-image-run-current";
  const ownerRunId = "source-image-run-earlier";
  const objectKey = [
    "auto-listing", "source", "v2", encode(accountId), encode(jobId), encode(itemId), "analysis-run",
    encode(ownerRunId), encode(sourceAssetId), "e".repeat(64), "attempt-1", "f".repeat(64),
    `${contentHash}.jpg`,
  ].join("/");
  let contextOptions;
  const basePorts = testPorts(events);
  await createAutoListingAiProductionDependencies({
    env: enabledEnv(),
    resolvePool: async () => Object.freeze({ async query() {}, async connect() {} }),
    ports: Object.freeze({
      ...basePorts,
      createStorage() {
        return Object.freeze({
          async putObjectFromBuffer() { throw new Error("must not write"); },
          async getObjectBuffer(key) { assert.equal(key, objectKey); return bytes; },
          async removeObject() { throw new Error("must not remove"); },
        });
      },
      createContextLoader(options) {
        contextOptions = options;
        return async () => { throw new Error("context must not load"); };
      },
    }),
  });

  assert.deepEqual(await contextOptions.sourceAnalysisAssetLoader.loadSourceAsset({
    scope: { accountId, jobId, itemId, expectedStatusVersion: 4 },
    run: { id: currentRunId, accountId, jobId, itemId, expectedStatusVersion: 4 },
    materializedAsset: {
      sourceAssetId, objectKey, contentHash, contentType: "image/jpeg", sizeBytes: bytes.length,
    },
  }), { bytes, contentType: "image/jpeg" });
});

test("production group checker reads and verifies scoped accepted objects only when the group phase executes", async () => {
  const events = [];
  const bytesByKey = new Map();
  let storageReads = 0;
  let gatewayCalls = 0;
  let leaseChecks = 0;
  const base = testPorts(events);
  const ports = Object.freeze({
    ...base,
    createStorage() {
      events.push(["storage", "auto-listing"]);
      return Object.freeze({
        async putObjectFromBuffer() { throw new Error("must not write"); },
        async removeObject() { throw new Error("must not remove"); },
        async getObjectBuffer(objectKey) {
          storageReads += 1;
          const bytes = bytesByKey.get(objectKey);
          if (!bytes) throw new Error("missing test object");
          return Buffer.from(bytes);
        },
      });
    },
    createGateway() {
      events.push(["gateway", { allowedSecretEnvNames: [] }, false]);
      return Object.freeze({
        async createTextResponse() { throw new Error("not used"); },
        async generateImage() { throw new Error("not used"); },
        async inspectImage(request) {
          gatewayCalls += 1;
          return {
            requestId: "group-gateway-request-a",
            modelEvidence: {
              requestedTextModel: request.model,
              gatewayReportedTextModel: request.model,
              gatewayReportedTextModelPresent: true,
            },
            value: {
              acceptedSlotKeys: ["detail-1", "info-1", "main-1", "scene-1", "sell-1", "sell-2"],
              duplicateSlotKeys: [], viewMismatchSlotKeys: [], identityMismatchSlotKeys: [], reasonCodes: [],
            },
          };
        },
        readSecret() {}, async resolveSecret() {},
      });
    },
  });
  await createAutoListingAiProductionDependencies({
    env: enabledEnv(),
    resolvePool: async () => Object.freeze({ async query() {}, async connect() {} }),
    ports,
  });
  const options = events.find(([name]) => name === "context-loader")[1];
  assert.equal(storageReads, 0, "composition and DB context creation must not read image bytes");

  const summaryValue = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    coverageMap: {
      FRONT: { assetIds: ["source-a"], preciseViewpoints: ["FRONT"], tentativeAssetIds: [] },
      COMPLETE_PRODUCT: {
        confirmedFamilyCount: 1, confirmedFamilies: ["FRONT"], requiredFamilyCount: 1,
        prohibitedViews: ["BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"],
      },
    },
    factCandidates: [], markingDecisions: [], eligibleAssetIds: ["source-a"], excludedAssetIds: [],
    requiredConfirmations: [], symmetryClass: "ASYMMETRIC", reasonCodes: [],
  };
  const summary = { ...summaryValue, summaryHash: hash(summaryValue) };
  const roles = ["MAIN", "SELLING_POINT", "SELLING_POINT", "DETAIL", "SCENE", "INFOGRAPHIC"];
  const slotKeys = ["main-1", "sell-1", "sell-2", "detail-1", "scene-1", "info-1"];
  const plan = {
    id: "plan-derived", sourceAccountId: "account-a", jobId: "job-a", itemId: "item-a",
    sourceImageAnalysisRunId: "run-a", sourceImageIntelligenceHash: summary.summaryHash,
    planHash: hash("group-plan"),
    plan: { version: 3, slots: slotKeys.map((slotKey, index) => ({
      slotKey, visualGroupKey: "group-a", role: roles[index], order: index + 1,
      targetView: "FRONT", evidenceMode: index === 0 ? "DIRECT" : "COMPOSITION_ONLY",
      referenceAssetIds: ["source-a"], sourceFactIds: [],
      prohibitedViews: ["BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"],
      identityAssetId: "source-a", selectionReasonCodes: ["SOURCE_VIEW_EVIDENCE_SELECTED"],
    })) },
  };
  const acceptedAssets = slotKeys.map((slotKey, index) => {
    const bytes = Buffer.from(`accepted-generated-${slotKey}`);
    const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
    const identity = {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
      visualGroupKey: "group-a", slotKey, attemptIdentityHash: String(index + 1).repeat(64),
      attemptNo: 1, inputHash: String(index + 2).repeat(64), contentHash,
    };
    const objectKey = buildGeneratedAssetObjectKey(identity);
    bytesByKey.set(objectKey, bytes);
    return {
      id: `asset-${index + 1}`, status: "ACCEPTED", ...identity,
      role: roles[index], objectKeyVersion: "ATTEMPT_V2", objectKey,
      contentType: "image/png", width: 768, height: 1024, size: bytes.length,
      expectedStatusVersion: 7,
      checkerEvidence: { generatedHash: contentHash, checkerResult: { evidence: {
        targetViewMatched: true, prohibitedViewVisible: false,
        intrinsicMarkingsPreserved: true, externalOverlayDetected: false, unsupportedFactIds: [],
      } } },
    };
  });
  const result = await options.imageGroupChecker({
    scope: {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
      visualGroupKey: "group-a", expectedStatusVersion: 7,
    },
    plan,
    acceptedAssets,
    sourceImageIntelligence: summary,
    repository: createMemoryImageGroupCheckRepository(),
    gateway: options.gateway,
    gatewayProfile: {
      id: "profile-a", accountId: "account-a", configVersion: 3, textModel: "checker-model",
      connectionId: "connection-a", connectionVersion: 3,
    },
    analysisRun: { id: "run-a" },
    gatewayExecution: {
      channelId: "channel-a", connectionId: "connection-a", connectionVersion: 3,
      idleTimeoutMs: 300_000,
    },
    correlationId: "correlation-a",
    assertLeaseActive() { leaseChecks += 1; },
  });

  assert.equal(result.status, "ACCEPTED");
  assert.equal(storageReads, 6);
  assert.ok(leaseChecks >= storageReads * 2, "every object read must be fenced before and after storage I/O");
  assert.equal(gatewayCalls, 1);
});

test("production worker carries the same development-only local gateway opt-in as administrator testing", async () => {
  const events = [];
  await createAutoListingAiProductionDependencies({
    env: enabledEnv({
      AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "true",
      AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "http://127.0.0.1:8080/v1",
    }),
    resolvePool: async () => Object.freeze({ async query() {}, async connect() {} }),
    ports: testPorts(events),
  });
  const gateway = events.find(([name]) => name === "gateway");
  assert.equal(gateway[2], true);

  const productionEvents = [];
  await assert.rejects(createAutoListingAiProductionDependencies({
    env: enabledEnv({
      NODE_ENV: "production",
      AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "true",
      AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "http://127.0.0.1:8080/v1",
    }),
    resolvePool: async () => { productionEvents.push("pool"); return {}; },
    ports: testPorts(productionEvents),
  }), { code: "AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID" });
  assert.deepEqual(productionEvents, []);
});

test("production worker internally allowlists the encrypted sentinel without reading it from env", async () => {
  const events = [];
  await createAutoListingAiProductionDependencies({
    env: enabledEnv({ AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "",
      SUB2API_ENCRYPTED_KEY: "must-not-be-read-as-legacy" }),
    resolvePool: async () => Object.freeze({ async query() {}, async connect() {} }),
    ports: testPorts(events),
  });
  const gatewayEvent = events.find(([name]) => name === "gateway");
  assert.deepEqual(gatewayEvent[1].allowedSecretEnvNames, ["SUB2API_ENCRYPTED_KEY"]);
  const gateway = events.find(([name]) => name === "context-loader")[1].gateway;
  assert.equal(gateway.readSecret("SUB2API_ENCRYPTED_KEY"), undefined);
});

test("production composition fails safely on missing database or storage configuration before any factory", async () => {
  for (const env of [
    enabledEnv({ DATABASE_URL: "" }),
    enabledEnv({ MINIO_SECRET_KEY: "" }),
    enabledEnv({ MINIO_PORT: "not-a-port" }),
    enabledEnv({ MINIO_USE_SSL: "sometimes" }),
    enabledEnv({ AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "" }),
  ]) {
    const events = [];
    let pools = 0;
    await assert.rejects(
      createAutoListingAiProductionDependencies({
        env,
        resolvePool: async () => { pools += 1; throw new Error("password=raw-secret"); },
        ports: testPorts(events),
      }),
      (error) => error?.code === "AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID"
        && !/password|raw-secret|storage-secret-value/iu.test(error?.message || ""),
    );
    assert.equal(pools, 0);
    assert.deepEqual(events, []);
  }
});

test("production composition input and ports are closed before database or external initialization", async () => {
  const env = enabledEnv();
  const base = { env, resolvePool: async () => ({ query() {}, connect() {} }), ports: testPorts([]) };
  await assert.rejects(
    createAutoListingAiProductionDependencies({ ...base, profileId: "global-profile" }),
    (error) => error?.code === "AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID",
  );
  await assert.rejects(
    createAutoListingAiProductionDependencies({
      ...base,
      ports: { ...base.ports, selectLatestProfile: async () => null },
    }),
    (error) => error?.code === "AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID",
  );
});

test("production composition rejects an incomplete content-plan evidence repository before loading context", async () => {
  const events = [];
  const ports = testPorts(events);
  await assert.rejects(
    createAutoListingAiProductionDependencies({
      env: enabledEnv(),
      resolvePool: async () => Object.freeze({ async query() {}, async connect() {} }),
      ports: Object.freeze({
        ...ports,
        createContentPlanEvidenceRepository() {
          return Object.freeze({ async recordResponse() {} });
        },
      }),
    }),
    (error) => error?.code === "AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED",
  );
  assert.equal(events.some(([name]) => name === "context-loader"), false);
});

test("production composition accepts the host process.env object shape while still projecting closed configuration", async () => {
  const env = Object.assign(Object.create({ runtimeEnvironment: true }), enabledEnv());
  const events = [];
  const pool = Object.freeze({ async query() {}, async connect() {} });
  const dependencies = await createAutoListingAiProductionDependencies({
    env,
    resolvePool: async () => pool,
    ports: testPorts(events),
  });
  assert.deepEqual(Object.keys(dependencies).sort(), ["bossFactory", "executionRepository", "loadContext", "orchestrate", "sourceImageAnalyzer", "workflow"]);
});

test("the real production dependency graph composes without starting PgBoss, MinIO, Sub2API or Ozon", async () => {
  let queries = 0;
  let connections = 0;
  const pool = Object.freeze({
    async query() { queries += 1; throw new Error("must remain lazy"); },
    async connect() { connections += 1; throw new Error("must remain lazy"); },
  });
  const dependencies = await createDefaultAutoListingAiProductionDependencies({
    env: enabledEnv(),
    resolvePool: async () => pool,
  });
  assert.deepEqual(Object.keys(dependencies).sort(), ["bossFactory", "executionRepository", "loadContext", "orchestrate", "sourceImageAnalyzer", "workflow"]);
  assert.equal(queries, 0);
  assert.equal(connections, 0);
});

test("text-only diagnostic production ports reuse the closed credential boundary without image or storage work", async () => {
  const events = [];
  const pool = Object.freeze({ async query() {}, async connect() {} });
  const gateway = Object.freeze({
    async createTextResponse() {},
    async generateImage() { throw new Error("diagnostic must not generate images"); },
    async inspectImage() { throw new Error("diagnostic must not inspect images"); },
  });
  const evidenceRepository = Object.freeze({
    async recordResponse() {}, async recordValidation() {}, async loadOutcome() {},
  });
  const ports = Object.freeze({
    async loadCredentialKey() { events.push("key"); return Buffer.alloc(32, 7); },
    createCipher() { events.push("cipher"); return {}; },
    createCredentialRepository(input) { events.push(["credentials", input]); return {}; },
    createCredentialResolver() { events.push("resolver"); return { async resolveSecret() {} }; },
    createGateway(input) { events.push(["gateway", input]); return gateway; },
    createEvidenceRepository(input) { events.push(["evidence", input]); return evidenceRepository; },
  });
  const result = await createAutoListingPlanDiagnosticProductionPorts({
    env: enabledEnv(), resolvePool: async () => pool, ports,
  });
  assert.deepEqual(result, { pool, gateway, evidenceRepository });
  assert.equal(events.some((entry) => Array.isArray(entry) && entry[0] === "storage"), false);
  assert.equal(events.filter((entry) => Array.isArray(entry) && entry[0] === "gateway").length, 1);
});

test("production relay discovers runnable accounts from the shared outbox in fair pages and starts with replay", async () => {
  const events = [];
  const pages = new Map([
    [null, ["account-a", "account-b"]],
    ["account-b", ["account-c"]],
    ["account-c", []],
  ]);
  const repository = {
    async listRunnableAutoListingAiAccountIds(input) {
      events.push(["discover", input]);
      return pages.get(input.afterAccountId) || [];
    },
    async claimAutoListingAiMessages(input) { events.push(["claim", input.accountId]); return []; },
    async claimLegacyAutoListingAiMessages(input) { events.push(["legacy-claim", input.accountId]); return []; },
    async claimAutoListingAiWork(input) { events.push(["v3-claim", input.accountId]); return []; },
    async markAutoListingAiWorkPublished() { throw new Error("no rows"); },
    async releaseUnpublishedAutoListingAiWork() { throw new Error("no rows"); },
    async renewAutoListingAiMessageLease() { throw new Error("no rows"); },
    async completeAutoListingAiMessage() {},
    async failAutoListingAiMessage() {},
    async reconcileDeadLegacyAutoListingAiMessages() { events.push(["legacy-dead"]); return { recovered: 0 }; },
    async reconcileDeadAutoListingAiMessages() { events.push(["generic-dead"]); throw new Error("must stay fenced"); },
    async reconcileInterruptedAutoListingAiItems() { return { recovered: 0 }; },
  };
  const boss = {
    async start() { events.push(["boss-start"]); },
    async createQueue(name) { events.push(["queue", name]); },
    async send() { throw new Error("empty outbox must not send"); },
    async stop() { events.push(["boss-stop"]); },
  };
  const ticks = [];
  const ports = Object.freeze({
    createBoss() { events.push(["boss-create"]); return boss; },
    createOutboxRepository({ pool }) { events.push(["repository", pool]); return repository; },
    createQueueAdapter: createLegacyAutoListingAiQueueAdapter,
    createPublisher(options) {
      return createLegacyAutoListingAiOutboxPublisher({
        ...options,
        timers: {
          setTimeout, clearTimeout,
          setInterval(callback) { ticks.push(callback); return { unref() {} }; },
          clearInterval() { events.push(["timer-stop"]); },
        },
        intervalMs: 5_000,
      });
    },
    createWorkQueueAdapter: createAutoListingAiWorkQueueAdapter,
    createWorkPublisher(options) {
      return createAutoListingAiWorkPublisher({
        ...options,
        timers: {
          setTimeout, clearTimeout,
          setInterval(callback) { ticks.push(callback); return { unref() {} }; },
          clearInterval() { events.push(["work-timer-stop"]); },
        },
        intervalMs: 5_000,
      });
    },
  });
  const pool = Object.freeze({ async query() {}, async connect() {} });
  const relay = await createAutoListingAiProductionOutboxRelay({
    env: enabledEnv(), resolvePool: async () => pool, ports,
  });

  assert.deepEqual(Object.keys(relay).sort(), ["start", "stop"]);
  assert.equal(events.some(([name]) => name === "boss-create" || name === "discover"), false);
  assert.equal(await relay.start(), true);
  assert.equal(ticks.length, 2);
  await Promise.all(ticks.map((tick) => tick()));
  await Promise.all(ticks.map((tick) => tick()));
  await relay.stop();

  assert.deepEqual(events.filter(([name]) => name === "discover").map(([, input]) => input), [
    { afterAccountId: null, limit: 100 },
    { afterAccountId: null, limit: 100 },
    { afterAccountId: "account-b", limit: 100 },
    { afterAccountId: "account-b", limit: 100 },
    { afterAccountId: "account-c", limit: 100 },
    { afterAccountId: "account-c", limit: 100 },
    { afterAccountId: null, limit: 100 },
    { afterAccountId: null, limit: 100 },
  ]);
  assert.deepEqual(events.filter(([name]) => name === "claim").map(([, accountId]) => accountId), []);
  assert.deepEqual(events.filter(([name]) => name === "legacy-claim").map(([, accountId]) => accountId), [
    "account-a", "account-b", "account-c", "account-a", "account-b",
  ]);
  assert.deepEqual(events.filter(([name]) => name === "v3-claim").map(([, accountId]) => accountId), [
    "account-a", "account-b", "account-c", "account-a", "account-b",
  ]);
  assert.deepEqual(events.filter(([name]) => name === "queue").map(([, name]) => name).sort(), [
    "auto-listing-ai-v2", "auto-listing-ai-v3",
  ]);
  assert.equal(events.filter(([name]) => name === "legacy-dead").length, 5);
  assert.equal(events.some(([name]) => name === "generic-dead"), false);
  assert.equal(events.filter(([name]) => name === "boss-create").length, 2);
  assert.equal(events.filter(([name]) => name === "boss-stop").length, 2);
  assert.equal(events.filter(([name]) => name === "timer-stop").length, 1);
  assert.equal(events.filter(([name]) => name === "work-timer-stop").length, 1);
});

test("default production relay is lazy, uses the same database configuration and does not query before start", async () => {
  let pools = 0;
  let queries = 0;
  let connections = 0;
  const relay = await createDefaultAutoListingAiProductionOutboxRelay({
    env: enabledEnv(),
    resolvePool: async () => {
      pools += 1;
      return {
        async query() { queries += 1; throw new Error("must remain lazy"); },
        async connect() { connections += 1; throw new Error("must remain lazy"); },
      };
    },
  });
  assert.deepEqual(Object.keys(relay).sort(), ["start", "stop"]);
  assert.deepEqual({ pools, queries, connections }, { pools: 1, queries: 0, connections: 0 });
});

test("default production relay runs bounded v2 legacy and v3 connection cycles without crossing claim kinds", async () => {
  const events = [];
  const pool = Object.freeze({ async query() {}, async connect() {} });
  const repository = Object.freeze({
    async listRunnableAutoListingAiAccountIds(input) { events.push(["discover", input]); return ["account-a"]; },
    async claimLegacyAutoListingAiMessages(input) { events.push(["legacy-claim", input]); return []; },
    async claimAutoListingAiMessages() { events.push(["generic-claim"]); throw new Error("must not claim generic work"); },
    async claimAutoListingAiWork(input) { events.push(["v3-claim", input]); return []; },
    async markAutoListingAiWorkPublished() { throw new Error("no rows"); },
    async releaseUnpublishedAutoListingAiWork() { throw new Error("no rows"); },
    async renewAutoListingAiMessageLease() { throw new Error("no rows"); },
    async completeAutoListingAiMessage() { throw new Error("no rows"); },
    async failAutoListingAiMessage() { throw new Error("no rows"); },
    async reconcileDeadLegacyAutoListingAiMessages(input) { events.push(["reconcile-legacy-dead", input]); return { recovered: 0 }; },
    async reconcileDeadAutoListingAiMessages() { events.push(["reconcile-generic-dead"]); throw new Error("must not reconcile generic rows"); },
    async reconcileInterruptedAutoListingAiItems(input) { events.push(["reconcile-interrupted", input]); return { recovered: 0 }; },
  });
  const boss = Object.freeze({
    async start() { events.push(["boss-start"]); },
    async createQueue(name, options) { events.push(["queue", name, options]); },
    async send() { events.push(["send"]); throw new Error("empty outbox must not publish"); },
    async stop() { events.push(["boss-stop"]); },
  });

  const relay = await createDefaultAutoListingAiProductionOutboxRelay({
    env: enabledEnv(),
    resolvePool: async () => pool,
  }, Object.freeze({
    createBoss(input) { events.push(["boss-create", input]); return boss; },
    createOutboxRepository(input) { events.push(["repository", input]); return repository; },
  }));

  assert.deepEqual(events, [["repository", { pool }]]);
  assert.equal(await relay.start(), true);
  await relay.stop();

  assert.deepEqual(events.filter(([name]) => name === "discover"), [
    ["discover", { afterAccountId: null, limit: 100 }],
    ["discover", { afterAccountId: null, limit: 100 }],
  ]);
  assert.deepEqual(events.filter(([name]) => name === "legacy-claim"), [[
    "legacy-claim",
    { accountId: "account-a", workerId: "auto-listing-ai-outbox-relay-v1", limit: 1, leaseMs: 30_000 },
  ]]);
  assert.deepEqual(events.filter(([name]) => name === "v3-claim"), [[
    "v3-claim",
    { accountId: "account-a", workerId: "auto-listing-ai-work-relay-v3", limit: 1, leaseMs: 30_000 },
  ]]);
  assert.equal(events.some(([name]) => name === "generic-claim" || name === "send"), false);
  assert.deepEqual(events.filter(([name]) => name === "reconcile-legacy-dead"), [
    ["reconcile-legacy-dead", { accountId: "account-a", limit: 1 }],
  ]);
  assert.equal(events.some(([name]) => name === "reconcile-generic-dead"), false);
  const queues = events.filter(([name]) => name === "queue");
  assert.deepEqual(queues.map(([, name]) => name).sort(), [
    AUTO_LISTING_AI_CURRENT_LEGACY_QUEUE,
    AUTO_LISTING_AI_CURRENT_WORK_QUEUE,
  ]);
  assert.deepEqual(new Map(queues.map(([, name, options]) => [name, options])), new Map([
    [AUTO_LISTING_AI_CURRENT_LEGACY_QUEUE, AUTO_LISTING_AI_CURRENT_LEGACY_QUEUE_OPTIONS],
    [AUTO_LISTING_AI_CURRENT_WORK_QUEUE, AUTO_LISTING_AI_CURRENT_WORK_QUEUE_OPTIONS],
  ]));
  assert.equal(queues.every((queue) => !Object.hasOwn(queue[2], "expireInSeconds")), true);
  assert.equal(events.filter(([name]) => name === "boss-create").length, 2);
  assert.equal(events.filter(([name]) => name === "boss-stop").length, 2);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { projectCategoryStrategyGuidanceV2 } from "../auto-listing-category-strategy-contract.mjs";
import { normalizeListingImage } from "../auto-listing-asset-store.mjs";
import { buildFixedSkeleton } from "../auto-listing-fixed-skeleton.mjs";
import { createMemoryImageGroupCheckRepository } from "../auto-listing-image-group-check-repository.mjs";
import { checkImageGroup } from "../auto-listing-image-group-checker.mjs";
import { buildImageGenerationInput } from "../auto-listing-image-generator.mjs";
import { checkGeneratedAsset } from "../auto-listing-result-checker.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import {
  analyzeSourceImageBatch,
  buildSourceImageAnalysisBatches,
} from "../auto-listing-source-image-analyzer.mjs";
import { createAutoListingSourceImageDecisionService } from "../auto-listing-source-image-decision-service.mjs";
import {
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS,
  enumerateSourceImageAssets,
  verifySourceImageIntelligenceSummary,
} from "../auto-listing-source-image-intelligence-contract.mjs";
import { createMemorySourceImageIntelligenceRepository } from "../auto-listing-source-image-intelligence-repository.mjs";
import { reconcileSourceImageAssessments } from "../auto-listing-source-image-reconciler.mjs";
import {
  duplicatesAndBroken,
  intrinsicLogoAndOverlay,
  moreThanTenImages,
  multiViewComplete,
  singleViewWithText,
  subjectOverlayAmbiguous,
  twoProductsOneChannel,
} from "./fixtures/auto-listing-source-image-intelligence.mjs";

const roles = Object.freeze({
  MAIN: 1,
  SELLING_POINT: 1,
  INFOGRAPHIC: 1,
  SCENE: 1,
  DETAIL: 1,
  SPECIFICATION: 1,
});
const textDensityByRole = Object.freeze({
  MAIN: "NONE",
  SELLING_POINT: "MEDIUM",
  INFOGRAPHIC: "MEDIUM",
  SCENE: "LIGHT",
  DETAIL: "LIGHT",
  SPECIFICATION: "HEAVY",
});
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" && !Buffer.isBuffer(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => crypto.createHash("sha256").update(
  Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)),
).digest("hex");
const closedAssessmentStatuses = new Set([
  "ANALYZED",
  "DUPLICATE_REUSED",
  "DOWNLOAD_FAILED",
  "UNSUPPORTED_MEDIA",
]);
const countTerminalAssessments = (assessmentRows) => assessmentRows
  .filter(({ terminalStatus }) => closedAssessmentStatuses.has(terminalStatus)).length;
const generatedBytes = await sharp({
  create: { width: 768, height: 1024, channels: 3, background: "#315a91" },
}).png().toBuffer();
const retryBytes = await sharp({
  create: { width: 768, height: 1024, channels: 3, background: "#6f3a91" },
}).png().toBuffer();

function representativeSourceImageFixtures() {
  return [
    multiViewComplete,
    singleViewWithText,
    intrinsicLogoAndOverlay,
    subjectOverlayAmbiguous,
    duplicatesAndBroken,
    moreThanTenImages,
    twoProductsOneChannel,
  ];
}

function throwingOzonWriter() {
  const calls = [];
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "calls") return calls;
      if (property === Symbol.toStringTag) return "ThrowingOzonWriter";
      return async () => {
        calls.push(String(property));
        throw Object.assign(new Error("Ozon writes are forbidden in the Task 12 journey"), {
          code: "AUTO_LISTING_TEST_OZON_WRITE_FORBIDDEN",
        });
      };
    },
  });
}

function exactCategoryStyle() {
  const role = (textDensity) => ({
    composition: "Чёткая предметная композиция",
    background: "Светлый нейтральный фон",
    textDensity,
    layout: "Последовательная визуальная иерархия",
  });
  return projectCategoryStrategyGuidanceV2({
    overallStyle: "Сдержанная техническая презентация товара",
    prohibitedPatterns: ["Не использовать сторонние логотипы"],
    roles: {
      MAIN: role("NONE"), SELLING_POINT: role("MEDIUM"), DETAIL: role("LIGHT"),
      SCENE: role("LIGHT"), SPECIFICATION: role("HEAVY"), INFOGRAPHIC: role("MEDIUM"),
    },
  });
}

function chargedChannel(capacity) {
  assert.ok(Number.isInteger(capacity) && capacity > 0);
  let running = 0;
  let maxRunning = 0;
  const waiters = [];
  const callCounts = new Map();
  async function acquire() {
    if (running < capacity) {
      running += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
  }
  function release() {
    running -= 1;
    const next = waiters.shift();
    if (next) {
      running += 1;
      next();
    }
  }
  return Object.freeze({
    async call(kind, work) {
      await acquire();
      maxRunning = Math.max(maxRunning, running);
      callCounts.set(kind, (callCounts.get(kind) || 0) + 1);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await work();
      } finally {
        release();
      }
    },
    snapshot() {
      return Object.freeze({
        maxConcurrentChargedCallsByChannel: maxRunning,
        callCounts: Object.freeze(Object.fromEntries([...callCounts].sort())),
      });
    },
  });
}

function sourceCapture(product, productIndex) {
  const accountId = "account-a";
  const collectItemId = `collect-${product.name}`;
  const images = product.assets.map(({ assetId, bytes }) => ({
    assetId,
    contentHash: digest(bytes || `unavailable:${assetId}`),
  }));
  return buildAutoListingSourceSnapshot({
    accountId,
    sourceType: "COLLECT_BOX",
    sourceRecordId: collectItemId,
    sourceVersion: "1",
    targetStoreId: "store-a",
    targetStoreCurrency: "RUB",
    categoryEvidence: {
      id: `category-evidence-${productIndex}`,
      accountId,
      sourceDescriptionCategoryId: 170,
      sourceTypeId: 99,
      taxonomyScope: "OZON:DEFAULT",
    },
    sharedCategory: {
      id: `shared-category-${productIndex}`,
      accountId,
      version: 1,
      evidenceId: `category-evidence-${productIndex}`,
      status: "ACTIVE",
      source: "SOURCE_DIRECT",
      sourceDescriptionCategoryId: 170,
      sourceTypeId: 99,
      currentDescriptionCategoryId: 170,
      currentTypeId: 99,
      taxonomyScope: "OZON:DEFAULT",
      taxonomyFingerprint: null,
    },
    collectItem: {
      id: collectItemId,
      accountId,
      listingDraft: {
        sku: `sku-${product.name}`,
        title: `Товар ${product.name}`,
        brand: product.name === "markings" ? "Acme" : "Brand",
        currency: "RUB",
        blackKopecks: "10000",
        greenKopecks: "8000",
        categoryAttributes: product.structuredFacts,
        categoryResolution: {
          status: "MATCHED",
          method: "taxonomy",
          target: { storeId: "store-a", descriptionCategoryId: "170", typeId: "99" },
        },
        images,
        variants: [{
          sku: `sku-${product.name}`,
          offerId: `offer-${product.name}`,
          name: `sku-${product.name}`,
          currency: "RUB",
          blackKopecks: "10000",
          greenKopecks: "8000",
          images,
        }],
      },
    },
    productDraft: { id: `draft-${product.name}`, version: 1 },
    rawResponseRef: `raw-${product.name}`,
    rawResponseHash: digest(`raw-${product.name}`),
  });
}

function observationFor(asset) {
  return {
    sourceAssetId: asset.assetId,
    contentKinds: [...asset.contentKinds],
    viewpoints: asset.viewpoint === "UNKNOWN" ? [] : [{
      kind: asset.viewpoint,
      confidence: "CONFIRMED",
      reasonCodes: [`VISIBLE_${asset.viewpoint}`],
    }],
    subjectBounds: asset.subjectBounds,
    quality: asset.quality,
    ocrRegions: asset.ocrRegions,
    markings: asset.markings,
    perceptualDuplicateGroup: asset.perceptualDuplicateGroup,
    eligibleUses: asset.eligibleUses,
    reasonCodes: asset.reasonCodes,
  };
}

function plannerContext({ summary = null, product, sourceCaptureValue, materializedById }) {
  const eligibleIds = summary?.eligibleAssetIds || product.assets
    .filter(({ terminalFailure }) => terminalFailure === null)
    .slice(0, 3)
    .map(({ assetId }) => assetId);
  const visualGroupKey = "group-a";
  const factRegistry = [{
    factId: "fact.identity.name",
    field: "identity.primaryName",
    kind: "IDENTITY_NAME",
    value: sourceCaptureValue.snapshot.identity.primaryName,
    numericValue: null,
    unit: null,
    sourcePath: "identity.primaryName",
    visualGroupKeys: [],
  }, ...(summary?.factCandidates || []).filter(({ status }) => status === "CONFIRMED").map((fact) => ({
    factId: fact.sourceFactId,
    field: `source.${fact.kind.toLowerCase()}`,
    kind: fact.kind,
    value: fact.value,
    numericValue: null,
    unit: null,
    sourcePath: "sourceImageIntelligence.factCandidates",
    visualGroupKeys: [visualGroupKey],
  }))];
  return {
    factRegistry,
    plannerContext: {
      plannerInput: {
        requestedRoleCounts: roles,
        imagesPerVisualGroup: 6,
        visualGroups: [{
          visualGroupKey,
          referenceImages: eligibleIds.map((assetId) => ({
            assetId,
            sourceRefHash: null,
            contentHash: materializedById.get(assetId)?.contentHash || digest(`legacy:${assetId}`),
            evidenceKind: "CONTENT_HASH",
          })),
          factEvidence: [],
          requiredPreserve: ["форма товара", "цвет товара"],
          reasonCodes: ["COMPLETE_APPEARANCE_EVIDENCE"],
        }],
        factRegistry,
        roleSubstitutions: [],
        textDensityByRole,
        prohibitedClaims: ["CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY"],
        language: "ru",
        ratio: "3:4",
        resolution: "1K",
        quality: "Medium",
        promptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
        ...(summary ? { sourceImageIntelligence: summary } : {}),
      },
    },
  };
}

function normalizedSlotEvidence(slots) {
  return slots.map((slot) => ({
    slotKey: slot.slotKey,
    role: slot.role,
    targetView: slot.targetView,
    evidenceMode: slot.evidenceMode,
    referenceAssetIds: [...slot.referenceAssetIds],
    sourceFactIds: [...slot.sourceFactIds],
    prohibitedViews: [...slot.prohibitedViews],
    prohibitedOverlayTexts: [...slot.prohibitedOverlayTexts],
    identityAssetId: slot.identityAssetId,
    selectionReasonCodes: [...slot.selectionReasonCodes],
  }));
}

function checkerValue(slot) {
  return {
    matchesProduct: true,
    matchesCategoryStyle: true,
    claimsVerified: true,
    russianText: true,
    quality: "PASS",
    prohibitedContent: false,
    reasons: [],
    evidence: {
      identity: {
        color: true,
        shape: true,
        accessoryCount: true,
        sourceAssetIds: [...slot.referenceAssetIds],
      },
      categoryStyle: { matches: true, referenceEvidenceIds: [] },
      claims: [],
      detectedTexts: [],
      language: "ru",
      qualityFlags: [],
      prohibitedFlags: [],
      targetViewMatched: true,
      prohibitedViewVisible: false,
      intrinsicMarkingsPreserved: true,
      externalOverlayDetected: false,
      unsupportedFactIds: [],
    },
  };
}

function groupEvidence(slots, retrySlotKey = null) {
  return {
    acceptedSlotKeys: slots.map(({ slotKey }) => slotKey).filter((slotKey) => slotKey !== retrySlotKey),
    duplicateSlotKeys: retrySlotKey ? [retrySlotKey] : [],
    viewMismatchSlotKeys: [],
    identityMismatchSlotKeys: [],
    reasonCodes: retrySlotKey ? ["IMAGE_GROUP_DUPLICATE_VIEW"] : [],
  };
}

async function runLegacyProduct({ product, productIndex, planningContract, scheduler }) {
  const capture = sourceCapture(product, productIndex);
  const materializedById = new Map(product.assets.filter(({ bytes }) => bytes).map((asset) => [asset.assetId, {
    sourceAssetId: asset.assetId,
    contentHash: digest(asset.bytes),
  }]));
  const { plannerContext: context, factRegistry } = plannerContext({
    product,
    sourceCaptureValue: capture,
    materializedById,
  });
  const skeleton = await scheduler.call("PLAN_CONTENT", async () => buildFixedSkeleton({ plannerContext: context }));
  const styleHash = digest({ mode: "GENERIC", planningContract });
  const plan = {
    id: `plan-${product.name}`,
    sourceAccountId: "account-a",
    jobId: `job-${product.name}`,
    itemId: `item-${product.name}`,
    planningContract,
    strategyVersionId: "strategy-generic-v1",
    planHash: digest({ product: product.name, plan: skeleton.plan }),
    sourceHash: capture.snapshotHash,
    strategyHash: styleHash,
    configHash: digest("config-v1"),
    visualGroupsHash: digest(context.plannerInput.visualGroups),
    plan: skeleton.plan,
    factRegistry,
  };
  const hashes = [];
  for (const slot of skeleton.plan.slots) {
    const references = slot.referenceAssetIds.map((assetId) => ({
      assetId,
      contentHash: materializedById.get(assetId)?.contentHash || digest(`legacy:${assetId}`),
    }));
    hashes.push(buildImageGenerationInput({
      plan,
      slot,
      references,
      profile: { id: "profile-a", configVersion: 3 },
      imageModel: "image-model",
      ratio: "3:4",
      resolution: "1K",
      size: "768x1024",
      quality: "medium",
      templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
      regeneration: null,
    }).inputHash);
    await scheduler.call("GENERATE_IMAGE_SLOT", async () => true);
  }
  await scheduler.call("GENERATE_RICH_CONTENT", async () => true);
  return {
    assessmentCount: 0,
    terminalAssessmentCount: 0,
    analysisRunCount: 0,
    legacyJourneyCompleted: skeleton.plan.version === 2 && hashes.length === 6
      && hashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)),
    status: "READY_FOR_REVIEW",
    sourceImageSummaryHash: null,
    slotEvidence: [],
    styleHash,
    outputSlotCount: 6,
    analysisBatchCount: 0,
    terminalStatusCounts: {},
  };
}

async function runIntelligentProduct({
  product,
  productIndex,
  categoryStrategy,
  scheduler,
  manualDecision = false,
  forceGroupRetry = false,
}) {
  const capture = sourceCapture(product, productIndex);
  const enumerated = enumerateSourceImageAssets({ sourceCapture: capture });
  let nextId = 0;
  const repository = createMemorySourceImageIntelligenceRepository({
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    id: (kind) => `${kind}-${product.name}-${++nextId}`,
    token: () => `token-${product.name}`,
  });
  const run = await repository.reserveAnalysisRun({
    accountId: "account-a",
    jobId: `job-${product.name}`,
    itemId: `item-${product.name}`,
    expectedStatusVersion: 1,
    sourceSnapshotId: `snapshot-${product.name}`,
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    sourceSnapshotHash: capture.snapshotHash,
    sourceAssetSetHash: digest(enumerated),
    inputHash: digest({ capture: capture.snapshotHash, assets: enumerated }),
    promptTemplateVersion: "source-image-analysis-v1",
    profileId: "profile-a",
    profileVersion: 3,
    modelName: "vision-model",
    expectedAssetCount: enumerated.length,
  });
  const scope = {
    accountId: run.accountId,
    jobId: run.jobId,
    itemId: run.itemId,
    analysisRunId: run.id,
    expectedStatusVersion: run.expectedStatusVersion,
  };
  const fixtureAssets = new Map(product.assets.map((asset) => [asset.assetId, asset]));
  const materialized = [];
  const materializedById = new Map();
  for (const source of enumerated) {
    const asset = fixtureAssets.get(source.sourceAssetId);
    if (asset.terminalFailure) {
      await repository.markAssetUnavailable({
        ...scope,
        sourceAssetId: source.sourceAssetId,
        sourceOrdinal: source.sourceOrdinal,
        terminalStatus: asset.terminalFailure,
        errorCode: asset.terminalFailure === "DOWNLOAD_FAILED"
          ? "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED"
          : "AUTO_LISTING_SOURCE_MEDIA_UNSUPPORTED",
      });
      continue;
    }
    const metadata = await sharp(asset.bytes).metadata();
    const record = {
      sourceAssetId: source.sourceAssetId,
      sourceOrdinal: source.sourceOrdinal,
      sizeBytes: asset.bytes.length,
      contentHash: digest(asset.bytes),
      objectKey: `auto-listing/source/v2/account-a/job-${product.name}/item-${product.name}/analysis-run/${run.id}/${source.sourceAssetId}/object.${asset.contentType === "image/jpeg" ? "jpg" : "png"}`,
      contentType: asset.contentType,
      width: metadata.width,
      height: metadata.height,
      bytes: asset.bytes,
    };
    await repository.markAssetMaterialized({
      ...scope,
      sourceAssetId: record.sourceAssetId,
      sourceOrdinal: record.sourceOrdinal,
      sourceRefHash: digest(`source-ref:${record.sourceAssetId}`),
      objectKey: record.objectKey,
      contentHash: record.contentHash,
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
    });
    materialized.push(Object.fromEntries([
      "sourceAssetId", "sourceOrdinal", "sizeBytes", "contentHash", "objectKey", "contentType",
    ].map((key) => [key, record[key]])));
    materializedById.set(record.sourceAssetId, record);
  }
  const terminalBeforeAnalysis = await repository.listRunAssessments(scope);
  const batches = buildSourceImageAnalysisBatches({
    materializedAssets: materialized,
    terminalAssessments: terminalBeforeAnalysis,
  });
  const profile = {
    id: "profile-a",
    accountId: "account-a",
    configVersion: 3,
    textModel: "vision-model",
    connectionId: "connection-a",
    connectionVersion: 4,
  };
  const gatewayExecution = {
    channelId: "channel-a",
    connectionId: "connection-a",
    connectionVersion: 4,
    idleTimeoutMs: 300_000,
  };
  const analysisGateway = {
    async analyzeSourceImages(input) {
      return scheduler.call("ANALYZE_SOURCE_IMAGE_BATCH", async () => ({
        observations: input.images.map(({ sourceAssetId }) => observationFor(fixtureAssets.get(sourceAssetId))),
      }));
    },
  };
  const sourceAssetLoader = {
    async loadSourceAsset({ materializedAsset }) {
      const record = materializedById.get(materializedAsset.sourceAssetId);
      return { bytes: Buffer.from(record.bytes), contentType: record.contentType };
    },
  };
  for (const batch of batches) {
    await analyzeSourceImageBatch({
      scope,
      run,
      batch,
      repository,
      sourceAssetLoader,
      gateway: analysisGateway,
      profile,
      gatewayExecution,
      assertLeaseActive() {},
    });
  }
  const assessmentRows = await repository.listRunAssessments(scope);
  const assessments = assessmentRows.map(({ assessment }) => assessment).filter(Boolean);
  const perceptualDuplicateGroups = Object.fromEntries([...new Set(assessments
    .map(({ perceptualDuplicateGroup }) => perceptualDuplicateGroup).filter(Boolean))].sort().map((group) => [
    group,
    assessments.filter(({ perceptualDuplicateGroup }) => perceptualDuplicateGroup === group)
      .map(({ sourceAssetId }) => sourceAssetId).sort(),
  ]));
  const initialSummary = reconcileSourceImageAssessments({
    sourceCapture: capture,
    assessments,
    decisions: [],
  });
  verifySourceImageIntelligenceSummary(initialSummary);
  const acceptedInitialRun = await repository.acceptSummary({
    ...scope,
    inputHash: digest({ run: run.inputHash, summary: initialSummary.summaryHash }),
    summary: initialSummary,
  });
  let activeRun = acceptedInitialRun;
  let summary = initialSummary;
  let manualDecisionEvidence = null;
  if (initialSummary.requiredConfirmations.length && manualDecision) {
    const parentBefore = structuredClone(await repository.loadAcceptedSummary(scope));
    const analysisCallsBefore = scheduler.snapshot().callCounts.ANALYZE_SOURCE_IMAGE_BATCH || 0;
    const target = initialSummary.requiredConfirmations[0].sourceAssetId;
    const decisionInput = {
      accountId: scope.accountId,
      jobId: scope.jobId,
      itemId: scope.itemId,
      analysisRunId: run.id,
      sourceAssetId: target,
      decision: "EXTERNAL_OVERLAY_EXCLUDE",
      expectedStatusVersion: run.expectedStatusVersion + 1,
      idempotencyKey: `exclude-${target}`,
      correlationId: `correlation-${product.name}`,
    };
    const service = createAutoListingSourceImageDecisionService({ repository });
    const publicDecision = await service.recordDecision(decisionInput);
    const decisionRecord = await repository.recordSourceImageDecision(decisionInput);
    const derivedScope = {
      accountId: scope.accountId,
      jobId: scope.jobId,
      itemId: scope.itemId,
      analysisRunId: decisionRecord.derivedRun.id,
      expectedStatusVersion: decisionRecord.derivedRun.expectedStatusVersion,
    };
    const derivedRows = await repository.listRunAssessments(derivedScope);
    summary = reconcileSourceImageAssessments({
      sourceCapture: capture,
      assessments: derivedRows.map(({ assessment }) => assessment).filter(Boolean),
      decisions: [{
        sourceAssetId: decisionRecord.decision.sourceAssetId,
        decision: decisionRecord.decision.decision,
        decisionHash: decisionRecord.decision.decisionHash,
      }],
    });
    activeRun = await repository.acceptSummary({
      ...derivedScope,
      inputHash: digest({ run: decisionRecord.derivedRun.inputHash, summary: summary.summaryHash }),
      summary,
    });
    const parentAfter = await repository.loadAcceptedSummary(scope);
    manualDecisionEvidence = {
      publicDecision,
      statusVersionIncrement: decisionRecord.derivedRun.expectedStatusVersion - run.expectedStatusVersion,
      derivedRunId: decisionRecord.derivedRun.id,
      parentRunId: decisionRecord.derivedRun.parentRunId,
      parentSummaryImmutable: JSON.stringify(parentAfter) === JSON.stringify(parentBefore),
      resultHashesReused: derivedRows.map(({ resultHash }) => resultHash).join(":")
        === assessmentRows.map(({ resultHash }) => resultHash).join(":"),
      resumePhase: decisionRecord.outbox.phase,
      analysisCallsBefore,
      analysisCallsAfter: scheduler.snapshot().callCounts.ANALYZE_SOURCE_IMAGE_BATCH || 0,
    };
  }
  if (summary.requiredConfirmations.length && !manualDecision) {
    const statusCounts = Object.fromEntries([...new Set(assessmentRows.map(({ terminalStatus }) => terminalStatus))]
      .sort().map((status) => [status, assessmentRows.filter((row) => row.terminalStatus === status).length]));
    return {
      assessmentCount: assessmentRows.length,
      terminalAssessmentCount: countTerminalAssessments(assessmentRows),
      status: "BLOCKED",
      analysisRunCount: 1,
      legacyJourneyCompleted: false,
      sourceImageSummaryHash: summary.summaryHash,
      slotEvidence: [],
      styleHash: digest(categoryStrategy || { mode: "GENERIC" }),
      outputSlotCount: 0,
      generationAttemptIds: [],
      analysisBatchCount: batches.length,
      terminalStatusCounts: statusCounts,
      sourceMetrics: {
        textOnly: assessments.filter(({ contentKinds }) => contentKinds.includes("TEXT_ONLY")).length,
        productMarkings: summary.markingDecisions.filter(({ kind }) => kind === "PRODUCT_MARKING").length,
        externalOverlays: summary.markingDecisions.filter(({ kind }) => kind === "EXTERNAL_OVERLAY").length,
        requiredConfirmations: summary.requiredConfirmations.length,
        confirmedFacts: summary.factCandidates.filter(({ status }) => status === "CONFIRMED").length,
        perceptualDuplicateGroups,
        eligibleAssetIds: [...summary.eligibleAssetIds],
        excludedAssetIds: [...summary.excludedAssetIds],
        generationReferenceAssetIds: [],
      },
      manualDecisionEvidence,
    };
  }
  const { plannerContext: context, factRegistry } = plannerContext({
    summary,
    product,
    sourceCaptureValue: capture,
    materializedById,
  });
  const skeleton = await scheduler.call("PLAN_CONTENT", async () => buildFixedSkeleton({ plannerContext: context }));
  const styleHash = digest(categoryStrategy || { mode: "GENERIC", version: 1 });
  const plan = {
    id: `plan-${product.name}`,
    sourceAccountId: "account-a",
    jobId: run.jobId,
    itemId: run.itemId,
    planningContract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    strategyVersionId: categoryStrategy ? "strategy-exact-v1" : "strategy-generic-v1",
    sourceImageAnalysisRunId: activeRun.id,
    sourceImageIntelligenceHash: summary.summaryHash,
    planHash: digest({ source: summary.summaryHash, plan: skeleton.plan }),
    sourceHash: capture.snapshotHash,
    strategyHash: styleHash,
    configHash: digest("config-v1"),
    visualGroupsHash: digest(context.plannerInput.visualGroups),
    plan: skeleton.plan,
    factRegistry,
    visualGroups: { groups: [{ visualGroupKey: "group-a" }] },
  };
  const acceptedAssets = [];
  async function generateAndCheck(slot, attemptNo = 1) {
    const referenceRecords = slot.referenceAssetIds.map((assetId) => materializedById.get(assetId));
    const references = referenceRecords.map(({ sourceAssetId, contentHash }) => ({
      assetId: sourceAssetId,
      contentHash,
    }));
    const generationInput = buildImageGenerationInput({
      plan,
      slot,
      references,
      sourceImageIntelligenceSummary: summary,
      profile: { id: "profile-a", configVersion: 3 },
      imageModel: "image-model",
      ratio: "3:4",
      resolution: "1K",
      size: "768x1024",
      quality: "medium",
      templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
      regeneration: null,
    });
    const generated = await scheduler.call("GENERATE_IMAGE_SLOT", async () => Buffer.from(attemptNo === 1 ? generatedBytes : retryBytes));
    const normalized = await normalizeListingImage({ bytes: generated, ratio: "3:4", resolution: "1K" });
    const bytes = normalized.bytes;
    const sourceReferences = referenceRecords.map((record) => ({
      assetId: record.sourceAssetId,
      contentHash: record.contentHash,
      contentType: record.contentType,
      width: record.width,
      height: record.height,
      size: record.sizeBytes,
      bytes: record.bytes,
    }));
    const selectedFacts = slot.sourceFactIds.map((factId) => {
      const fact = factRegistry.find((candidate) => candidate.factId === factId);
      return Object.fromEntries([
        "factId", "field", "kind", "value", "numericValue", "unit", "sourcePath",
      ].map((key) => [key, fact[key]]));
    });
    const checked = await checkGeneratedAsset({
      generated: { bytes: generated },
      ratio: "3:4",
      resolution: "1K",
      profile: { id: "profile-a", accountId: "account-a", configVersion: 3 },
      checkerModel: "checker-model",
      templateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
      claimEvidenceFactIds: [...slot.sourceFactIds],
      textRequired: false,
      scope: { correlationId: `check-${product.name}-${slot.slotKey}-${attemptNo}`, requestKey: `check-${digest(slot.slotKey).slice(0, 24)}-${attemptNo}` },
      facts: selectedFacts,
      references: sourceReferences,
      slot,
      sourceImageGenerationEvidence: generationInput.sourceImageGenerationEvidence,
      gateway: {
        async inspectImage() {
          return scheduler.call("CHECK_IMAGE_SLOT", async () => ({
            requestId: `checker-${product.name}-${slot.slotKey}-${attemptNo}`,
            modelEvidence: {
              requestedTextModel: "checker-model",
              gatewayReportedTextModel: "checker-model",
              gatewayReportedTextModelPresent: true,
            },
            value: checkerValue(slot),
          }));
        },
      },
    });
    assert.equal(checked.accepted, true);
    const contentHash = digest(bytes);
    return {
      id: `generated-${product.name}-${slot.slotKey}-attempt-${attemptNo}`,
      status: "ACCEPTED",
      accountId: "account-a",
      jobId: run.jobId,
      itemId: run.itemId,
      planId: plan.id,
      visualGroupKey: slot.visualGroupKey,
      slotKey: slot.slotKey,
      role: slot.role,
      contentHash,
      contentType: "image/png",
      width: normalized.width,
      height: normalized.height,
      size: bytes.length,
      bytes,
      inputHash: generationInput.inputHash,
      checkerEvidence: checked.evidence,
    };
  }
  for (const slot of skeleton.plan.slots) acceptedAssets.push(await generateAndCheck(slot));
  const groupRepository = createMemoryImageGroupCheckRepository({
    id: () => `group-check-${product.name}`,
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  let groupCall = 0;
  const retrySlotKey = forceGroupRetry ? skeleton.plan.slots[1].slotKey : null;
  async function runGroupCheck() {
    return checkImageGroup({
      scope: {
        accountId: "account-a",
        jobId: run.jobId,
        itemId: run.itemId,
        planId: plan.id,
        visualGroupKey: "group-a",
        expectedStatusVersion: activeRun.expectedStatusVersion,
      },
      plan,
      generatedAssets: acceptedAssets,
      sourceImageIntelligence: summary,
      repository: groupRepository,
      gateway: {
        async inspectImage() {
          groupCall += 1;
          const rejectSlot = retrySlotKey && groupCall === 1 ? retrySlotKey : null;
          return scheduler.call("CHECK_IMAGE_GROUP", async () => ({
            requestId: `group-check-${product.name}-${groupCall}`,
            modelEvidence: {
              requestedTextModel: "checker-model",
              gatewayReportedTextModel: "checker-model",
              gatewayReportedTextModelPresent: true,
            },
            value: groupEvidence(skeleton.plan.slots, rejectSlot),
          }));
        },
      },
      profile: {
        id: "profile-a",
        accountId: "account-a",
        configVersion: 3,
        textModel: "checker-model",
        connectionId: null,
        connectionVersion: null,
      },
      gatewayExecution: null,
      assertLeaseActive() {},
    });
  }
  const acceptedBeforeRetry = acceptedAssets.map(({ id }) => id);
  let groupResult = await runGroupCheck();
  let retryEvidence = null;
  if (groupResult.status === "RETRY_QUEUED") {
    assert.deepEqual(groupResult.retrySlotKeys, [retrySlotKey]);
    const retryIndex = skeleton.plan.slots.findIndex(({ slotKey }) => slotKey === retrySlotKey);
    acceptedAssets[retryIndex] = await generateAndCheck(skeleton.plan.slots[retryIndex], 2);
    groupResult = await runGroupCheck();
    retryEvidence = {
      retrySlotKey,
      beforeAssetIds: acceptedBeforeRetry,
      afterAssetIds: acceptedAssets.map(({ id }) => id),
      stableSiblingAssetIds: acceptedBeforeRetry.filter((_id, index) => index !== retryIndex),
      regeneratedAssetIds: [acceptedAssets[retryIndex].id],
    };
  }
  assert.equal(groupResult.status, "ACCEPTED");
  await scheduler.call("GENERATE_RICH_CONTENT", async () => digest({
    summaryHash: summary.summaryHash,
    acceptedAssetIds: acceptedAssets.map(({ id }) => id),
    factIds: factRegistry.map(({ factId }) => factId),
  }));
  const statusCounts = Object.fromEntries([...new Set(assessmentRows.map(({ terminalStatus }) => terminalStatus))]
    .sort().map((status) => [status, assessmentRows.filter((row) => row.terminalStatus === status).length]));
  return {
    assessmentCount: assessmentRows.length,
    terminalAssessmentCount: countTerminalAssessments(assessmentRows),
    status: "READY_FOR_REVIEW",
    analysisRunCount: manualDecisionEvidence ? 2 : 1,
    legacyJourneyCompleted: false,
    sourceImageSummaryHash: summary.summaryHash,
    slotEvidence: normalizedSlotEvidence(skeleton.plan.slots),
    styleHash,
    outputSlotCount: acceptedAssets.length,
    generationAttemptIds: acceptedAssets.map(({ id }) => id),
    analysisBatchCount: batches.length,
    terminalStatusCounts: statusCounts,
    sourceMetrics: {
      textOnly: assessments.filter(({ contentKinds }) => contentKinds.includes("TEXT_ONLY")).length,
      productMarkings: summary.markingDecisions.filter(({ kind }) => kind === "PRODUCT_MARKING").length,
      externalOverlays: summary.markingDecisions.filter(({ kind }) => kind === "EXTERNAL_OVERLAY").length,
      requiredConfirmations: summary.requiredConfirmations.length,
      confirmedFacts: summary.factCandidates.filter(({ status }) => status === "CONFIRMED").length,
      perceptualDuplicateGroups,
      eligibleAssetIds: [...summary.eligibleAssetIds],
      excludedAssetIds: [...summary.excludedAssetIds],
      generationReferenceAssetIds: [...new Set(skeleton.plan.slots
        .flatMap(({ referenceAssetIds }) => referenceAssetIds))].sort(),
    },
    manualDecisionEvidence,
    retryEvidence,
  };
}

async function runSourceImageJourney({
  fixture,
  channelCount = 1,
  categoryStrategy = null,
  planningContract = "FIXED_SKELETON_SOURCE_IMAGE_V1",
  ozon = throwingOzonWriter(),
  manualDecision = false,
  forceGroupRetry = false,
}) {
  const scheduler = chargedChannel(channelCount);
  const productResults = await Promise.all(fixture.products.map((product, productIndex) => planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
    ? runIntelligentProduct({ product, productIndex, categoryStrategy, scheduler, manualDecision, forceGroupRetry })
    : runLegacyProduct({ product, productIndex, planningContract, scheduler })));
  const channel = scheduler.snapshot();
  const summaryHashes = productResults.map(({ sourceImageSummaryHash }) => sourceImageSummaryHash).filter(Boolean);
  const styleHashes = [...new Set(productResults.map(({ styleHash }) => styleHash))];
  return Object.freeze({
    assessmentCount: productResults.reduce((total, result) => total + result.assessmentCount, 0),
    terminalAssessmentCount: productResults.reduce((total, result) => total + result.terminalAssessmentCount, 0),
    status: productResults.some(({ status }) => status === "BLOCKED") ? "BLOCKED" : "READY_FOR_REVIEW",
    ozonWriteCalls: ozon.calls.length,
    maxConcurrentChargedCallsByChannel: channel.maxConcurrentChargedCallsByChannel,
    sourceImageSummaryHash: summaryHashes.length === 1 ? summaryHashes[0] : digest(summaryHashes),
    slotEvidence: productResults.length === 1 ? productResults[0].slotEvidence
      : productResults.flatMap(({ slotEvidence }) => slotEvidence),
    styleHash: styleHashes.length === 1 ? styleHashes[0] : digest(styleHashes),
    analysisRunCount: productResults.reduce((total, result) => total + result.analysisRunCount, 0),
    legacyJourneyCompleted: productResults.every(({ legacyJourneyCompleted }) => legacyJourneyCompleted),
    outputSlotCount: productResults.reduce((total, result) => total + result.outputSlotCount, 0),
    generationAttemptIds: productResults.flatMap(({ generationAttemptIds = [] }) => generationAttemptIds),
    chargedCallCounts: channel.callCounts,
    productResults,
  });
}

test("component fixture harness exercises closed source-image contracts without external writes", async () => {
  for (const fixture of representativeSourceImageFixtures()) {
    const result = await runSourceImageJourney({ fixture, channelCount: 1, ozon: throwingOzonWriter() });
    assert.equal(result.assessmentCount, fixture.uniqueSourceAssetCount);
    assert.equal(result.terminalAssessmentCount, fixture.uniqueSourceAssetCount);
    assert.equal(result.status, fixture.requiresConfirmation ? "BLOCKED" : "READY_FOR_REVIEW");
    assert.equal(result.ozonWriteCalls, 0);
  }
});

test("two products share one channel without overlapping charged calls", async () => {
  const result = await runSourceImageJourney({ fixture: twoProductsOneChannel, channelCount: 1, ozon: throwingOzonWriter() });
  assert.equal(result.maxConcurrentChargedCallsByChannel, 1);
});

test("two products use two available channels concurrently without duplicating a generation attempt", async () => {
  const result = await runSourceImageJourney({
    fixture: twoProductsOneChannel,
    channelCount: 2,
    ozon: throwingOzonWriter(),
  });

  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.equal(result.maxConcurrentChargedCallsByChannel, 2);
  assert.equal(result.generationAttemptIds.length, 12);
  assert.equal(new Set(result.generationAttemptIds).size, 12);
  assert.equal(result.ozonWriteCalls, 0);
});

test("category strategy changes style only and reuses the same source evidence semantics", async () => {
  const generic = await runSourceImageJourney({ fixture: multiViewComplete, categoryStrategy: null, ozon: throwingOzonWriter() });
  const styled = await runSourceImageJourney({ fixture: multiViewComplete, categoryStrategy: exactCategoryStyle(), ozon: throwingOzonWriter() });
  assert.equal(styled.sourceImageSummaryHash, generic.sourceImageSummaryHash);
  assert.deepEqual(styled.slotEvidence, generic.slotEvidence);
  assert.notEqual(styled.styleHash, generic.styleHash);
});

test("historical contracts never require a source image analysis run", async () => {
  for (const planningContract of ["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"]) {
    const result = await runSourceImageJourney({ fixture: singleViewWithText, planningContract, ozon: throwingOzonWriter() });
    assert.equal(result.analysisRunCount, 0);
    assert.equal(result.legacyJourneyCompleted, true);
  }
});

test("external-overlay exclusion derives an immutable run and resumes at reconciliation without another analysis call", async () => {
  const result = await runSourceImageJourney({
    fixture: subjectOverlayAmbiguous,
    manualDecision: true,
    ozon: throwingOzonWriter(),
  });
  const evidence = result.productResults[0].manualDecisionEvidence;
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.equal(evidence.statusVersionIncrement, 2);
  assert.notEqual(evidence.derivedRunId, evidence.parentRunId);
  assert.equal(evidence.parentSummaryImmutable, true);
  assert.equal(evidence.resultHashesReused, true);
  assert.equal(evidence.resumePhase, "RECONCILE_SOURCE_IMAGE_ANALYSIS");
  assert.equal(evidence.analysisCallsAfter, evidence.analysisCallsBefore);
});

test("group-quality retry regenerates only the affected slot and preserves accepted siblings", async () => {
  const result = await runSourceImageJourney({
    fixture: multiViewComplete,
    forceGroupRetry: true,
    ozon: throwingOzonWriter(),
  });
  const retry = result.productResults[0].retryEvidence;
  const changed = retry.beforeAssetIds.filter((assetId, index) => assetId !== retry.afterAssetIds[index]);
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.equal(result.outputSlotCount, 6);
  assert.equal(changed.length, 1);
  assert.deepEqual(retry.stableSiblingAssetIds, retry.beforeAssetIds.filter((assetId) => !changed.includes(assetId)));
  assert.deepEqual(retry.regeneratedAssetIds, retry.afterAssetIds.filter((assetId) => !retry.beforeAssetIds.includes(assetId)));
  assert.equal(result.chargedCallCounts.GENERATE_IMAGE_SLOT, 7);
  assert.equal(result.chargedCallCounts.CHECK_IMAGE_GROUP, 2);
});

test("all captured assets participate across two-image batches while six output slots remain independent", async () => {
  const many = await runSourceImageJourney({ fixture: moreThanTenImages, ozon: throwingOzonWriter() });
  assert.equal(many.assessmentCount, 13);
  assert.equal(many.productResults[0].analysisBatchCount, 7);
  assert.equal(many.outputSlotCount, 6);

  const broken = await runSourceImageJourney({ fixture: duplicatesAndBroken, ozon: throwingOzonWriter() });
  assert.equal(broken.productResults[0].terminalAssessmentCount, 6);
  assert.deepEqual(broken.productResults[0].terminalStatusCounts, {
    ANALYZED: 3,
    DOWNLOAD_FAILED: 1,
    DUPLICATE_REUSED: 1,
    UNSUPPORTED_MEDIA: 1,
  });
  assert.deepEqual(broken.productResults[0].sourceMetrics.perceptualDuplicateGroups["near-front"], [
    "duplicate-exact",
    "duplicate-front",
    "duplicate-near",
  ]);

  const text = await runSourceImageJourney({ fixture: singleViewWithText, ozon: throwingOzonWriter() });
  assert.equal(text.productResults[0].sourceMetrics.textOnly, 3);
  assert.ok(text.productResults[0].sourceMetrics.confirmedFacts >= 2);

  const markings = await runSourceImageJourney({ fixture: intrinsicLogoAndOverlay, ozon: throwingOzonWriter() });
  assert.equal(markings.productResults[0].sourceMetrics.productMarkings, 1);
  assert.equal(markings.productResults[0].sourceMetrics.externalOverlays, 1);
  assert.ok(markings.productResults[0].sourceMetrics.eligibleAssetIds.includes("marking-front"));
  assert.ok(markings.productResults[0].sourceMetrics.excludedAssetIds.includes("marking-overlay"));
  assert.ok(markings.productResults[0].sourceMetrics.generationReferenceAssetIds.includes("marking-front"));
  assert.ok(!markings.productResults[0].sourceMetrics.generationReferenceAssetIds.includes("marking-overlay"));

  const ambiguous = await runSourceImageJourney({ fixture: subjectOverlayAmbiguous, ozon: throwingOzonWriter() });
  assert.equal(ambiguous.productResults[0].sourceMetrics.requiredConfirmations, 1);
  assert.equal(ambiguous.status, "BLOCKED");
});

test("V2 analyzes eight source images as four two-image batches, retains every text region, and still plans six outputs", async () => {
  const viewpoints = ["FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "DETAIL", "SCENE"];
  const assets = await Promise.all(viewpoints.map(async (viewpoint, index) => {
    const bytes = await sharp({
      create: {
        width: 30 + index,
        height: 34 + index,
        channels: 3,
        background: { r: 20 + index * 20, g: 70 + index * 10, b: 150 - index * 10 },
      },
    }).png().toBuffer();
    const sourceText = `卖点 ${index + 1}`;
    return Object.freeze({
      assetId: `eight-v2-${index + 1}`,
      bytes,
      contentType: "image/png",
      contentKinds: Object.freeze(["MIXED"]),
      viewpoint,
      subjectBounds: Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }),
      quality: Object.freeze({ confidence: "CONFIRMED", usable: true, reasonCodes: [] }),
      ocrRegions: Object.freeze([Object.freeze({
        text: sourceText,
        region: null,
        language: "zh",
        confidence: "CONFIRMED",
      })]),
      semanticTextRegions: Object.freeze([Object.freeze({
        sourceText,
        language: "zh",
        region: null,
        confidence: "CONFIRMED",
        semanticKind: "SELLING_POINT",
        normalizedMeaning: sourceText,
        sequence: null,
        reasonCodes: Object.freeze([]),
      })]),
      markings: Object.freeze([Object.freeze({
        kind: "PRODUCT_MARKING",
        region: null,
        confidence: "CONFIRMED",
        reasonCodes: Object.freeze(["TEST_PRODUCT_TEXT"]),
      })]),
      perceptualDuplicateGroup: null,
      eligibleUses: Object.freeze(["TARGET_VIEW", "TEXT_FACT"]),
      reasonCodes: Object.freeze([]),
    });
  }));
  const product = Object.freeze({ name: "eight-v2", assets: Object.freeze(assets), structuredFacts: Object.freeze([]) });
  const capture = sourceCapture(product, 0);
  const enumerated = enumerateSourceImageAssets({ sourceCapture: capture });
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  const materializedById = new Map(enumerated.map((source) => {
    const asset = byId.get(source.sourceAssetId);
    return [source.sourceAssetId, {
      sourceAssetId: source.sourceAssetId,
      sourceOrdinal: source.sourceOrdinal,
      sizeBytes: asset.bytes.length,
      contentHash: digest(asset.bytes),
      objectKey: `auto-listing/source/v2/account-a/job-eight/item-eight/run-eight/${source.sourceAssetId}/object.png`,
      contentType: asset.contentType,
      bytes: asset.bytes,
    }];
  }));
  const batches = buildSourceImageAnalysisBatches({
    materializedAssets: [...materializedById.values()].map(({ bytes: _bytes, ...record }) => record),
    terminalAssessments: [],
  });
  assert.deepEqual(batches.map(({ assets: batchAssets }) => batchAssets.length), [2, 2, 2, 2]);

  const run = Object.freeze({
    id: "run-eight-v2",
    accountId: "account-a",
    jobId: "job-eight",
    itemId: "item-eight",
    expectedStatusVersion: 1,
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2,
    inputHash: digest("run-eight-v2"),
    profileId: "profile-a",
    profileVersion: 1,
    modelName: "vision-model",
  });
  const scope = Object.freeze({
    accountId: run.accountId,
    jobId: run.jobId,
    itemId: run.itemId,
    expectedStatusVersion: run.expectedStatusVersion,
  });
  const assessments = [];
  const repository = Object.freeze({
    async listRunAssessments() { return []; },
    async recordBatchAssessments(value) {
      assessments.push(...value.assessments);
      return {
        status: "ACCEPTED",
        analysisBatchId: value.analysisBatchId,
        inputHash: value.inputHash,
        resultHash: value.resultHash,
        assessmentCount: value.assessments.length,
      };
    },
  });
  const profile = Object.freeze({
    id: "profile-a",
    accountId: "account-a",
    configVersion: 1,
    textModel: "vision-model",
    connectionId: "connection-a",
    connectionVersion: 1,
  });
  const gatewayExecution = Object.freeze({
    channelId: "channel-a",
    connectionId: "connection-a",
    connectionVersion: 1,
    idleTimeoutMs: 300_000,
  });
  for (const batch of batches) {
    await analyzeSourceImageBatch({
      scope,
      run,
      batch,
      repository,
      sourceAssetLoader: {
        async loadSourceAsset({ materializedAsset }) {
          const record = materializedById.get(materializedAsset.sourceAssetId);
          return { bytes: Buffer.from(record.bytes), contentType: record.contentType };
        },
      },
      gateway: {
        async analyzeSourceImages(input) {
          return {
            observations: input.images.map(({ sourceAssetId }) => {
              const asset = byId.get(sourceAssetId);
              return {
                sourceAssetId,
                contentKinds: [...asset.contentKinds],
                viewpoints: [{ kind: asset.viewpoint, confidence: "CONFIRMED", reasonCodes: [] }],
                subjectBounds: asset.subjectBounds,
                quality: asset.quality,
                ocrRegions: [...asset.ocrRegions],
                semanticTextRegions: [...asset.semanticTextRegions],
                markings: [...asset.markings],
                perceptualDuplicateGroup: null,
                eligibleUses: [...asset.eligibleUses],
                reasonCodes: [],
              };
            }),
          };
        },
      },
      profile,
      gatewayExecution,
      async assertLeaseActive() {},
    });
  }

  assert.equal(assessments.length, 8);
  assert.equal(assessments.every((assessment) => assessment.semanticTextRegions.length === 1), true);
  const summary = reconcileSourceImageAssessments({
    sourceCapture: capture,
    assessments,
    decisions: [],
    acceptedDerivativeBindings: [],
  });
  assert.equal(summary.factCandidates.filter(({ kind }) => kind === "IMAGE_SELLING_POINT").length, 8);
  const skeleton = buildFixedSkeleton({
    plannerContext: plannerContext({ summary, product, sourceCaptureValue: capture, materializedById }).plannerContext,
  });
  assert.equal(skeleton.plan.slots.length, 6);
});

async function trialRunnerHarness(overrides = {}) {
  const runner = await import("../../scripts/run-auto-listing-source-image-intelligence-trial.mjs");
  const gatewayConstructions = [];
  const reviewPolicy = Object.freeze({ mode: "REVIEW" });
  return {
    runner,
    gatewayConstructions,
    input: {
      argv: [
        "--collect-item-id", "collect_9a5cc7e1da9b50dd2642d078",
        "--channel-capacity", "1",
        "--stop-at", "READY_FOR_REVIEW",
        "--confirm-paid-ai",
      ],
      env: { AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1_ENABLED: "true" },
      uploadStrategy: "REVIEW",
      ozonWriter: runner.createThrowingOzonWriter(),
      loadPreflight: async () => ({
        accountId: "account-a",
        capturedSourceImageCount: 13,
        uploadPolicy: reviewPolicy,
        profiles: [{ id: "profile-a", configVersion: 3, enabled: true }],
        channels: [{ channelId: "channel-a", enabled: true, requiresRevalidation: false, status: "AVAILABLE" }],
      }),
      reloadUploadPolicy: async () => reviewPolicy,
      gatewayFactory: async () => { gatewayConstructions.push(true); return {}; },
      runTrial: async () => { throw new Error("paid branch must not run in Task 12 tests"); },
      writeLine() {},
      ...overrides,
    },
  };
}

test("trial execution evidence uses durable attempts when both items finish on the same channel", async () => {
  const { runner } = await trialRunnerHarness();
  const itemIds = ["item-1", "item-2"];
  const evidence = runner.summarizeTrialExecutionEvidence({
    itemIds,
    expectedConnections: [
      { connectionId: "connection-a", connectionVersion: 1 },
      { connectionId: "connection-b", connectionVersion: 1 },
    ],
    itemRows: [
      { id: "item-1", last_ai_connection_id: "connection-b", last_ai_connection_version: 1 },
      { id: "item-2", last_ai_connection_id: "connection-b", last_ai_connection_version: 1 },
    ],
    attemptRows: [
      { item_id: "item-1", attempt_id: "cleanup:edit:1",
        connection_id: "connection-a", connection_version: 1 },
      { item_id: "item-1", attempt_id: "image:generate:1",
        connection_id: "connection-b", connection_version: 1 },
      { item_id: "item-2", attempt_id: "image:generate:2",
        connection_id: "connection-b", connection_version: 1 },
    ],
  });

  assert.equal(evidence.distinctConnectionCount, 2);
  assert.equal(evidence.lastConnectionCount, 1);
  assert.equal(evidence.attemptCount, 3);
  assert.equal(evidence.duplicateAttemptIdCount, 0);
  assert.deepEqual(evidence.connectionUsage, [
    { itemId: "item-1", connectionId: "connection-a", connectionVersion: 1, attemptCount: 1 },
    { itemId: "item-1", connectionId: "connection-b", connectionVersion: 1, attemptCount: 1 },
    { itemId: "item-2", connectionId: "connection-b", connectionVersion: 1, attemptCount: 1 },
  ]);
});

test("trial execution evidence rejects an attempt from an unapproved connection", async () => {
  const { runner } = await trialRunnerHarness();
  assert.throws(() => runner.summarizeTrialExecutionEvidence({
    itemIds: ["item-1", "item-2"],
    expectedConnections: [
      { connectionId: "connection-a", connectionVersion: 1 },
      { connectionId: "connection-b", connectionVersion: 1 },
    ],
    itemRows: [
      { id: "item-1", last_ai_connection_id: "connection-a", last_ai_connection_version: 1 },
      { id: "item-2", last_ai_connection_id: "connection-b", last_ai_connection_version: 1 },
    ],
    attemptRows: [
      { item_id: "item-1", attempt_id: "cleanup:1",
        connection_id: "connection-a", connection_version: 1 },
      { item_id: "item-2", attempt_id: "image:2",
        connection_id: "connection-c", connection_version: 1 },
    ],
  }), { code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_EXECUTION_EVIDENCE_INVALID" });
});

for (const guard of [
  ["feature flag", { env: {} }, "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_FLAG_REQUIRED"],
  ["exact collect item", {
    argv: ["--collect-item-id", "collect-wrong", "--channel-capacity", "1", "--stop-at", "READY_FOR_REVIEW", "--confirm-paid-ai"],
  }, "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_COLLECT_ITEM_REQUIRED"],
  ["single channel capacity", {
    argv: ["--collect-item-id", "collect_9a5cc7e1da9b50dd2642d078", "--channel-capacity", "2", "--stop-at", "READY_FOR_REVIEW", "--confirm-paid-ai"],
  }, "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_CHANNEL_CAPACITY_REQUIRED"],
  ["review stop status", {
    argv: ["--collect-item-id", "collect_9a5cc7e1da9b50dd2642d078", "--channel-capacity", "1", "--stop-at", "SUCCEEDED", "--confirm-paid-ai"],
  }, "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_STOP_STATUS_REQUIRED"],
  ["forced review upload strategy", { uploadStrategy: "DIRECT" }, "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_REVIEW_UPLOAD_REQUIRED"],
  ["throwing Ozon writer", { ozonWriter: Object.freeze({}) }, "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_STUB_REQUIRED"],
  ["explicit paid confirmation", {
    argv: ["--collect-item-id", "collect_9a5cc7e1da9b50dd2642d078", "--channel-capacity", "1", "--stop-at", "READY_FOR_REVIEW"],
  }, "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_CONFIRMATION_REQUIRED"],
]) {
  test(`trial runner ${guard[0]} guard fails before gateway construction`, async () => {
    const harness = await trialRunnerHarness(guard[1]);
    await assert.rejects(harness.runner.runGuardedTrial(harness.input), { code: guard[2] });
    assert.equal(harness.gatewayConstructions.length, 0);
  });
}

test("trial runner reports the bounded paid-call estimate without constructing a gateway", async () => {
  const harness = await trialRunnerHarness();
  assert.deepEqual(harness.runner.estimatePaidCalls({ capturedSourceImageCount: 13 }), {
    capturedSourceImageCount: 13,
    analysisBatchCalls: 3,
    cleanupAttemptsReserved: 0,
    cleanupEditCalls: 0,
    cleanupCheckCalls: 0,
    planContentCalls: 1,
    slotGenerationCalls: 6,
    perSlotCheckCalls: 6,
    groupCheckCalls: 1,
    richContentCalls: 1,
    baselinePaidCalls: 18,
    hardPaidCallLimit: 512,
  });
  assert.equal(harness.gatewayConstructions.length, 0);
});

test("trial estimate charges one edit and one checker call for every reserved cleanup attempt", async () => {
  const { runner } = await trialRunnerHarness();

  assert.deepEqual(runner.estimatePaidCalls({
    capturedSourceImageCount: 8,
    cleanupAttemptsReserved: 2,
  }), {
    capturedSourceImageCount: 8,
    analysisBatchCalls: 2,
    cleanupAttemptsReserved: 2,
    cleanupEditCalls: 2,
    cleanupCheckCalls: 2,
    planContentCalls: 1,
    slotGenerationCalls: 6,
    perSlotCheckCalls: 6,
    groupCheckCalls: 1,
    richContentCalls: 1,
    baselinePaidCalls: 21,
    hardPaidCallLimit: 512,
  });
});

test("trial runner preflight-only prints the real estimate without confirmation or runtime construction", async () => {
  const events = [];
  const harness = await trialRunnerHarness({
    argv: [
      "--collect-item-id", "collect_9a5cc7e1da9b50dd2642d078",
      "--channel-capacity", "1",
      "--stop-at", "READY_FOR_REVIEW",
      "--preflight-only",
    ],
    loadPreflight: async () => {
      events.push("preflight");
      return {
        accountId: "account-a",
        capturedSourceImageCount: 13,
        uploadPolicy: { mode: "REVIEW" },
        profiles: [{ id: "profile-a", configVersion: 3, enabled: true }],
        channels: [{ channelId: "channel-a", enabled: true, requiresRevalidation: false, status: "AVAILABLE" }],
      };
    },
    writeLine: (line) => events.push(JSON.parse(line).event === "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ESTIMATE"
      ? "estimate" : "terminal"),
    reloadUploadPolicy: async () => { events.push("unexpected-recheck"); return { mode: "REVIEW" }; },
    gatewayFactory: async () => { events.push("unexpected-runtime"); return {}; },
    runTrial: async () => { events.push("unexpected-run"); return {}; },
  });

  const result = await harness.runner.runGuardedTrial(harness.input);
  assert.deepEqual(result, {
    status: "PREFLIGHT_ONLY",
    estimate: harness.runner.estimatePaidCalls({ capturedSourceImageCount: 13 }),
  });
  assert.deepEqual(events, ["preflight", "estimate"]);
  assert.equal(harness.gatewayConstructions.length, 0);
});

test("trial runner hard budget covers every paid phase and rejects call nineteen before the gateway", async () => {
  const { runner } = await trialRunnerHarness();
  let gatewayCalls = 0;
  const gateway = Object.freeze({
    async analyzeSourceImages() { gatewayCalls += 1; return {}; },
    async createTextResponse() { gatewayCalls += 1; return {}; },
    async generateImage() { gatewayCalls += 1; return {}; },
    async inspectImage() { gatewayCalls += 1; return {}; },
    async listModels() { throw new Error("catalog is outside the paid trial"); },
    async testCapabilities() { throw new Error("capability probe is outside the paid trial"); },
  });
  const budget = runner.createTrialPaidCallBudget({ hardPaidCallLimit: 18 });
  const call = (phase, method) => budget.wrapGateway({ phase, gateway })[method]({});

  await call("ANALYZE_SOURCE_IMAGE_BATCH", "analyzeSourceImages");
  await Promise.all(Array.from({ length: 2 }, () => call("ANALYZE_SOURCE_IMAGE_BATCH", "createTextResponse")));
  await assert.rejects(budget.wrapGateway({ phase: "PLAN_CONTENT", gateway }).listModels(), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_GATEWAY_BOUNDARY_INVALID",
  });
  await call("PLAN_CONTENT", "createTextResponse");
  for (let index = 0; index < 6; index += 1) {
    await call("GENERATE_IMAGE_SLOT", "generateImage");
    await call("GENERATE_IMAGE_SLOT", "inspectImage");
  }
  await call("CHECK_IMAGE_GROUP", "inspectImage");
  await call("GENERATE_RICH_CONTENT", "createTextResponse");

  assert.deepEqual(budget.snapshot(), {
    paidCalls: 18,
    hardPaidCallLimit: 18,
    callsByKind: {
      ANALYZE_SOURCE_IMAGE_BATCH: 3,
      CHECK_IMAGE_GROUP: 1,
      CHECK_IMAGE_SLOT: 6,
      GENERATE_IMAGE_SLOT: 6,
      GENERATE_RICH_CONTENT: 1,
      PLAN_CONTENT: 1,
    },
  });
  await assert.rejects(call("GENERATE_RICH_CONTENT", "createTextResponse"), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_CALL_LIMIT_EXCEEDED",
  });
  assert.equal(gatewayCalls, 18);
});

test("trial paid boundary includes both source cleanup phases", async () => {
  const { runner } = await trialRunnerHarness();
  const calls = [];
  const gateway = Object.freeze({
    async generateImage() { calls.push("edit"); return {}; },
    async createTextResponse() { calls.push("check"); return {}; },
  });
  const budget = runner.createTrialPaidCallBudget({ hardPaidCallLimit: 4 });

  await budget.wrapGateway({ phase: "CLEAN_SOURCE_IMAGE_OVERLAY", gateway }).generateImage({});
  await budget.wrapGateway({ phase: "CHECK_SOURCE_IMAGE_CLEANUP", gateway }).createTextResponse({});

  assert.deepEqual(calls, ["edit", "check"]);
  assert.deepEqual(budget.snapshot(), {
    paidCalls: 2,
    hardPaidCallLimit: 4,
    callsByKind: {
      CHECK_SOURCE_IMAGE_CLEANUP: 1,
      CLEAN_SOURCE_IMAGE_OVERLAY: 1,
    },
  });
});

test("resumed trial budget counts prior paid calls and rejects a nineteenth total call", async () => {
  const { runner } = await trialRunnerHarness();
  let gatewayCalls = 0;
  const gateway = Object.freeze({
    async createTextResponse() { gatewayCalls += 1; return {}; },
  });
  const budget = runner.createTrialPaidCallBudget({ hardPaidCallLimit: 18, paidCallsUsed: 2 });
  const wrapped = budget.wrapGateway({ phase: "PLAN_CONTENT", gateway });

  for (let index = 0; index < 16; index += 1) await wrapped.createTextResponse({});

  assert.equal(budget.snapshot().paidCalls, 18);
  await assert.rejects(wrapped.createTextResponse({}), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_CALL_LIMIT_EXCEEDED",
  });
  assert.equal(gatewayCalls, 16);
});

test("approved resumed trial allows only calls nineteen through twenty-one", async () => {
  const { runner } = await trialRunnerHarness();
  let gatewayCalls = 0;
  const gateway = Object.freeze({
    async createTextResponse() { gatewayCalls += 1; return {}; },
  });
  const budget = runner.createTrialPaidCallBudget({ hardPaidCallLimit: 21, paidCallsUsed: 18 });
  const wrapped = budget.wrapGateway({ phase: "GENERATE_RICH_CONTENT", gateway });

  for (let index = 0; index < 3; index += 1) await wrapped.createTextResponse({});

  assert.deepEqual(budget.snapshot(), {
    paidCalls: 21,
    hardPaidCallLimit: 21,
    callsByKind: { GENERATE_RICH_CONTENT: 3 },
  });
  await assert.rejects(wrapped.createTextResponse({}), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_CALL_LIMIT_EXCEEDED",
  });
  assert.equal(gatewayCalls, 3);
});

test("unlimited authorization still keeps a high emergency per-run fuse after prior calls", async () => {
  const { runner } = await trialRunnerHarness();
  let gatewayCalls = 0;
  const gateway = Object.freeze({
    async createTextResponse() { gatewayCalls += 1; return {}; },
  });
  const budget = runner.createTrialPaidCallBudget({ hardPaidCallLimit: 256, paidCallsUsed: 21 });
  const wrapped = budget.wrapGateway({ phase: "GENERATE_RICH_CONTENT", gateway });

  for (let index = 0; index < 235; index += 1) await wrapped.createTextResponse({});

  assert.deepEqual(budget.snapshot(), {
    paidCalls: 256,
    hardPaidCallLimit: 256,
    callsByKind: { GENERATE_RICH_CONTENT: 235 },
  });
  await assert.rejects(wrapped.createTextResponse({}), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_CALL_LIMIT_EXCEEDED",
  });
  assert.equal(gatewayCalls, 235);
});

test("trial budget exposes a completed group-check envelope without exposing its request", async () => {
  const { runner } = await trialRunnerHarness();
  const observed = [];
  const response = {
    requestId: "group-request-a",
    modelEvidence: { requestedTextModel: "gpt-5.4" },
    value: { acceptedSlotKeys: ["slot-a"] },
  };
  const budget = runner.createTrialPaidCallBudget({
    hardPaidCallLimit: 256,
    onPaidResponse(value) { observed.push(value); },
  });
  const gateway = Object.freeze({ async inspectImage() { return response; } });

  await budget.wrapGateway({ phase: "CHECK_IMAGE_GROUP", gateway }).inspectImage({ secret: "not-observed" });

  assert.deepEqual(observed, [{
    phase: "CHECK_IMAGE_GROUP",
    method: "inspectImage",
    kind: "CHECK_IMAGE_GROUP",
    response,
  }]);
});

test("trial diagnostics expose only structural source-analysis defects", async () => {
  const { runner } = await trialRunnerHarness();
  const summary = runner.summarizeSourceImageAnalysisResponse({ value: { observations: [{
    sourceAssetId: "asset-a",
    contentKinds: ["PRODUCT_VIEW", "PRODUCT_VIEW"],
    viewpoints: [],
    subjectBounds: { x: 0.8, y: 0, width: 0.4, height: 0.5 },
    quality: null,
    ocrRegions: [{ text: " SECRET TEXT ", region: null, language: "ru", confidence: "TENTATIVE" }],
    markings: [],
    perceptualDuplicateGroup: "group one",
    eligibleUses: ["DETAIL", "DETAIL"],
    reasonCodes: ["not-valid"],
  }] } });

  assert.deepEqual(summary, {
    observationCount: 1,
    duplicateSourceAssetIdCount: 0,
    duplicateContentKindCount: 1,
    duplicateEligibleUseCount: 1,
    invalidReasonCodeCount: 1,
    invalidBoundsCount: 1,
    invalidBoundsKinds: { NORMALIZED_GEOMETRY: 1 },
    invalidOcrTextCount: 1,
    invalidDuplicateGroupCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(summary), /SECRET|asset-a|PRODUCT_VIEW|DETAIL|group one/iu);
});

test("trial diagnostics recognize accepted 0-1000 integer bounds as structurally valid", async () => {
  const { runner } = await trialRunnerHarness();
  const summary = runner.summarizeSourceImageAnalysisResponse({ value: { observations: [{
    sourceAssetId: "asset-a",
    contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [],
    subjectBounds: { x: 100, y: 100, width: 800, height: 800 },
    quality: null,
    ocrRegions: [{
      text: "Технические характеристики",
      region: { x: 100, y: 700, width: 700, height: 80 },
      language: "ru",
      confidence: "TENTATIVE",
    }],
    markings: [{
      kind: "PRODUCT_MARKING",
      region: { x: 200, y: 200, width: 200, height: 100 },
      confidence: "TENTATIVE",
      reasonCodes: [],
    }],
    perceptualDuplicateGroup: null,
    eligibleUses: ["IDENTITY_ANCHOR"],
    reasonCodes: [],
  }] } });

  assert.equal(summary.invalidBoundsCount, 0);
  assert.deepEqual(summary.invalidBoundsKinds, {});
});

test("trial diagnostics recognize repairable normalized right-bottom endpoints", async () => {
  const { runner } = await trialRunnerHarness();
  const summary = runner.summarizeSourceImageAnalysisResponse({ value: { observations: [{
    sourceAssetId: "asset-a",
    contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [],
    subjectBounds: { x: 0.2, y: 0.3, width: 0.9, height: 0.8 },
    quality: null,
    ocrRegions: [],
    markings: [],
    perceptualDuplicateGroup: null,
    eligibleUses: ["IDENTITY_ANCHOR"],
    reasonCodes: [],
  }] } });

  assert.equal(summary.invalidBoundsCount, 0);
  assert.deepEqual(summary.invalidBoundsKinds, {});
});

test("trial polling maps public job items by their collect source record in requested order", async () => {
  const { runner } = await trialRunnerHarness();
  const collectItemIds = [
    "collect_9a5cc7e1da9b50dd2642d078",
    "collect_1c0c66c95d4203ef65c00489",
  ];
  const items = runner.selectTrialJobItems({ items: [
    { id: "item-2", sourceRecordId: collectItemIds[1], sourceOrder: 2 },
    { id: "item-1", sourceRecordId: collectItemIds[0], sourceOrder: 1 },
  ] }, collectItemIds);

  assert.deepEqual(items.map(({ id }) => id), ["item-1", "item-2"]);
});

test("dual trial keeps processing an active item after its peer reaches a safe terminal status", async () => {
  const { runner } = await trialRunnerHarness();

  assert.equal(runner.trialBatchHasSettledFailure([
    { status: "GENERATING" },
    { status: "BLOCKED" },
  ], 2), false);
  assert.equal(runner.trialBatchHasSettledFailure([
    { status: "READY_FOR_REVIEW" },
    { status: "BLOCKED" },
  ], 2), true);
  assert.equal(runner.trialBatchHasSettledFailure([
    { status: "RETRYABLE_ERROR" },
    { status: "CANCELLED" },
  ], 2), true);
});

test("resumed trial passes its declared prior paid-call count into the production budget", async () => {
  let observedPaidCalls = null;
  const harness = await trialRunnerHarness({
    argv: [
      "--collect-item-id", "collect_9a5cc7e1da9b50dd2642d078",
      "--channel-capacity", "1",
      "--stop-at", "READY_FOR_REVIEW",
      "--paid-calls-used", "2",
      "--confirm-paid-ai",
    ],
    gatewayFactory: async ({ paidCallBudget }) => {
      observedPaidCalls = paidCallBudget.snapshot().paidCalls;
      return {};
    },
    runTrial: async () => ({ status: "READY_FOR_REVIEW" }),
  });

  const result = await harness.runner.runGuardedTrial(harness.input);

  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.equal(observedPaidCalls, 2);
});

test("trial runner production dependency wrapper budgets context gateways and fails closed on the legacy analyzer seam", async () => {
  const { runner } = await trialRunnerHarness();
  let gatewayCalls = 0;
  let legacyAnalyzerCalls = 0;
  const gateway = Object.freeze({
    async analyzeSourceImages() { gatewayCalls += 1; return { observations: [] }; },
    async createTextResponse() { gatewayCalls += 1; return {}; },
    async generateImage() { gatewayCalls += 1; return {}; },
    async inspectImage() { gatewayCalls += 1; return {}; },
  });
  const paidCallBudget = runner.createTrialPaidCallBudget({ hardPaidCallLimit: 18 });
  const wrapped = runner.wrapTrialProductionAiDependencies({
    paidCallBudget,
    dependencies: Object.freeze({
      marker: "production-dependencies",
      async loadContext() { return { status: "PLANNING", phaseInput: { gateway } }; },
      async sourceImageAnalyzer() { legacyAnalyzerCalls += 1; return {}; },
    }),
  });
  const context = await wrapped.loadContext({ message: { phase: "ANALYZE_SOURCE_IMAGE_BATCH" } });
  await context.phaseInput.gateway.analyzeSourceImages({});
  await assert.rejects(wrapped.sourceImageAnalyzer({}), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_GATEWAY_BOUNDARY_INVALID",
  });
  assert.equal(wrapped.marker, "production-dependencies");
  assert.equal(gatewayCalls, 1);
  assert.equal(legacyAnalyzerCalls, 0);
  assert.equal(paidCallBudget.snapshot().paidCalls, 1);
});

test("trial runner rejects an argv capacity of one when persisted effective capacity is not exactly one", async () => {
  const harness = await trialRunnerHarness({
    loadPreflight: async () => ({
      accountId: "account-a",
      capturedSourceImageCount: 13,
      uploadPolicy: { mode: "REVIEW" },
      profiles: [{ id: "profile-a", configVersion: 3, enabled: true }],
      channels: [
        { channelId: "channel-a", enabled: true, requiresRevalidation: false, status: "AVAILABLE" },
        { channelId: "channel-b", enabled: true, requiresRevalidation: false, status: "AVAILABLE" },
      ],
    }),
  });
  await assert.rejects(harness.runner.runGuardedTrial(harness.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_EFFECTIVE_CAPACITY_REQUIRED",
  });
  assert.equal(harness.gatewayConstructions.length, 0);
});

test("trial runner rejects a second enabled channel even while that channel is busy", async () => {
  const harness = await trialRunnerHarness({
    loadPreflight: async () => ({
      accountId: "account-a",
      capturedSourceImageCount: 13,
      uploadPolicy: { mode: "REVIEW" },
      profiles: [{ id: "profile-a", configVersion: 3, enabled: true }],
      channels: [
        { channelId: "channel-a", enabled: true, requiresRevalidation: false, status: "AVAILABLE" },
        { channelId: "channel-b", enabled: true, requiresRevalidation: false, status: "BUSY" },
      ],
    }),
  });
  await assert.rejects(harness.runner.runGuardedTrial(harness.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_EFFECTIVE_CAPACITY_REQUIRED",
  });
  assert.equal(harness.gatewayConstructions.length, 0);
});

test("trial runner permits only the two approved products on two distinct ready connections", async () => {
  const firstCollectItemId = "collect_9a5cc7e1da9b50dd2642d078";
  const secondCollectItemId = "collect_1c0c66c95d4203ef65c00489";
  const events = [];
  const harness = await trialRunnerHarness({
    argv: [
      "--collect-item-id", firstCollectItemId,
      "--collect-item-id", secondCollectItemId,
      "--channel-capacity", "2",
      "--stop-at", "READY_FOR_REVIEW",
      "--confirm-paid-ai",
    ],
    loadPreflight: async ({ collectItemIds }) => {
      assert.deepEqual(collectItemIds, [firstCollectItemId, secondCollectItemId]);
      return {
        accountId: "account-a",
        capturedSourceImages: [
          { collectItemId: firstCollectItemId, count: 6 },
          { collectItemId: secondCollectItemId, count: 1 },
        ],
        uploadPolicy: { mode: "REVIEW" },
        profiles: [{ id: "profile-a", configVersion: 3, enabled: true }],
        channels: [
          { channelId: "channel-a", connectionId: "connection-a", connectionVersion: 1,
            enabled: true, requiresRevalidation: false, status: "AVAILABLE" },
          { channelId: "channel-b", connectionId: "connection-b", connectionVersion: 1,
            enabled: true, requiresRevalidation: false, status: "AVAILABLE" },
        ],
      };
    },
    writeLine: (line) => events.push(JSON.parse(line)),
    gatewayFactory: async ({ channelCapacity }) => {
      assert.equal(channelCapacity, 2);
      return { kind: "dual-runtime" };
    },
    runTrial: async ({ collectItemIds, channelCapacity }) => {
      assert.deepEqual(collectItemIds, [firstCollectItemId, secondCollectItemId]);
      assert.equal(channelCapacity, 2);
      return { status: "READY_FOR_REVIEW" };
    },
  });

  const result = await harness.runner.runGuardedTrial(harness.input);

  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.deepEqual(events[0].estimate, {
    items: [
      { collectItemId: firstCollectItemId, capturedSourceImageCount: 6,
        cleanupAttemptsReserved: 0, baselinePaidCalls: 16 },
      { collectItemId: secondCollectItemId, capturedSourceImageCount: 1,
        cleanupAttemptsReserved: 0, baselinePaidCalls: 16 },
    ],
    baselinePaidCalls: 32,
    hardPaidCallLimit: 512,
  });
});

test("dual trial rejects repeated upstream connection identities before runtime construction", async () => {
  const harness = await trialRunnerHarness({
    argv: [
      "--collect-item-id", "collect_9a5cc7e1da9b50dd2642d078",
      "--collect-item-id", "collect_1c0c66c95d4203ef65c00489",
      "--channel-capacity", "2",
      "--stop-at", "READY_FOR_REVIEW",
      "--confirm-paid-ai",
    ],
    loadPreflight: async () => ({
      accountId: "account-a",
      capturedSourceImages: [
        { collectItemId: "collect_9a5cc7e1da9b50dd2642d078", count: 6 },
        { collectItemId: "collect_1c0c66c95d4203ef65c00489", count: 1 },
      ],
      uploadPolicy: { mode: "REVIEW" },
      profiles: [{ id: "profile-a", configVersion: 3, enabled: true }],
      channels: [
        { channelId: "channel-a", connectionId: "connection-a", connectionVersion: 1,
          enabled: true, requiresRevalidation: false, status: "AVAILABLE" },
        { channelId: "channel-b", connectionId: "connection-a", connectionVersion: 1,
          enabled: true, requiresRevalidation: false, status: "AVAILABLE" },
      ],
    }),
  });

  await assert.rejects(harness.runner.runGuardedTrial(harness.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_EFFECTIVE_CAPACITY_REQUIRED",
  });
  assert.equal(harness.gatewayConstructions.length, 0);
});

test("dual trial rejects any collect item outside the approved pair", async () => {
  const harness = await trialRunnerHarness({
    argv: [
      "--collect-item-id", "collect_9a5cc7e1da9b50dd2642d078",
      "--collect-item-id", "collect-not-approved",
      "--channel-capacity", "2",
      "--stop-at", "READY_FOR_REVIEW",
      "--confirm-paid-ai",
    ],
  });

  await assert.rejects(harness.runner.runGuardedTrial(harness.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_COLLECT_ITEM_REQUIRED",
  });
  assert.equal(harness.gatewayConstructions.length, 0);
});

test("dual trial resumes only its two exact expired assignments", async () => {
  const collectItemIds = [
    "collect_9a5cc7e1da9b50dd2642d078",
    "collect_1c0c66c95d4203ef65c00489",
  ];
  const channels = collectItemIds.map((collectItemId, index) => ({
    channelId: `channel-${index + 1}`,
    connectionId: `connection-${index + 1}`,
    connectionVersion: 1,
    assignedItemId: `item-${index + 1}`,
    enabled: true,
    requiresRevalidation: false,
    status: "BUSY",
  }));
  const harness = await trialRunnerHarness({
    argv: [
      "--collect-item-id", collectItemIds[0],
      "--collect-item-id", collectItemIds[1],
      "--channel-capacity", "2",
      "--stop-at", "READY_FOR_REVIEW",
      "--confirm-paid-ai",
    ],
    loadPreflight: async () => ({
      accountId: "account-a",
      capturedSourceImages: collectItemIds.map((collectItemId) => ({ collectItemId, count: 1 })),
      uploadPolicy: { mode: "REVIEW" },
      profiles: [{ id: "profile-a", configVersion: 3, enabled: true }],
      channels,
      resumeAssignments: collectItemIds.map((collectItemId, index) => ({
        idempotencyKey: "source-image-v2-cleanup-dual-trial-v4",
        collectItemId,
        jobId: "dual-job",
        itemId: `item-${index + 1}`,
        itemStatus: "GENERATING",
        itemStatusVersion: 4,
        channelId: `channel-${index + 1}`,
        assignedStatusVersion: 4,
        leaseActive: false,
      })),
    }),
    runTrial: async () => ({ status: "READY_FOR_REVIEW" }),
  });

  const result = await harness.runner.runGuardedTrial(harness.input);
  assert.equal(result.status, "READY_FOR_REVIEW");
});

test("trial runner resumes its exact busy channel only after the prior execution lease expired", async () => {
  const events = [];
  const collectItemId = "collect_9a5cc7e1da9b50dd2642d078";
  const itemId = "trial-job-item-001";
  const harness = await trialRunnerHarness({
    loadPreflight: async () => ({
      accountId: "account-a",
      capturedSourceImageCount: 6,
      uploadPolicy: { mode: "REVIEW" },
      profiles: [{ id: "profile-a", configVersion: 3, enabled: true }],
      channels: [{
        channelId: "channel-a", assignedItemId: itemId,
        enabled: true, requiresRevalidation: false, status: "BUSY",
      }],
      resumeAssignment: {
        idempotencyKey: `source-image-v2-cleanup-trial-${collectItemId}`,
        collectItemId,
        jobId: "trial-job",
        itemId,
        itemStatus: "PLANNING",
        itemStatusVersion: 2,
        channelId: "channel-a",
        assignedStatusVersion: 2,
        leaseActive: false,
      },
    }),
    writeLine: (line) => events.push(JSON.parse(line).event === "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ESTIMATE"
      ? "estimate" : "terminal"),
    reloadUploadPolicy: async () => ({ mode: "REVIEW" }),
    gatewayFactory: async () => { events.push("runtime"); return {}; },
    runTrial: async () => { events.push("run"); return { status: "READY_FOR_REVIEW" }; },
  });

  const result = await harness.runner.runGuardedTrial(harness.input);

  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.deepEqual(events, ["estimate", "runtime", "run", "terminal"]);
});

test("trial runner validates production preflight, prints estimate, rechecks review, constructs runtime, then runs a safe fake", async () => {
  const events = [];
  const harness = await trialRunnerHarness({
    argv: [
      "--",
      "--collect-item-id", "collect_9a5cc7e1da9b50dd2642d078",
      "--channel-capacity", "1",
      "--stop-at", "READY_FOR_REVIEW",
      "--confirm-paid-ai",
    ],
    loadPreflight: async () => {
      events.push("preflight");
      return {
        accountId: "account-a",
        capturedSourceImageCount: 13,
        uploadPolicy: { mode: "REVIEW" },
        profiles: [{ id: "profile-a", configVersion: 3, enabled: true }],
        channels: [{ channelId: "channel-a", enabled: true, requiresRevalidation: false, status: "AVAILABLE" }],
      };
    },
    writeLine: (line) => events.push(JSON.parse(line).event === "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ESTIMATE"
      ? "estimate" : "terminal"),
    gatewayFactory: async () => { events.push("runtime"); return { kind: "safe-fake-runtime" }; },
    reloadUploadPolicy: async () => { events.push("review-recheck"); return { mode: "REVIEW" }; },
    runTrial: async ({ gateway }) => { events.push("safe-fake-run"); return { status: "READY_FOR_REVIEW", gateway }; },
  });
  const result = await harness.runner.runGuardedTrial(harness.input);
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.deepEqual(events, ["preflight", "estimate", "review-recheck", "runtime", "safe-fake-run", "terminal"]);
});

test("trial runner accepts a cleanup-review block only when the Ozon writer has zero calls", async () => {
  const safe = await trialRunnerHarness({
    runTrial: async () => ({ status: "BLOCKED", itemStatuses: ["BLOCKED"] }),
  });
  assert.equal((await safe.runner.runGuardedTrial(safe.input)).status, "BLOCKED");

  const unsafe = await trialRunnerHarness({
    runTrial: async ({ ozonWriter }) => {
      try { await ozonWriter.createProduct({}); } catch {}
      return { status: "BLOCKED", itemStatuses: ["BLOCKED"] };
    },
  });
  await assert.rejects(unsafe.runner.runGuardedTrial(unsafe.input), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_WRITE_FORBIDDEN",
  });
});

test("trial runner throwing Ozon port rejects every method shape", async () => {
  const { runner } = await trialRunnerHarness();
  const writer = runner.createThrowingOzonWriter();
  await assert.rejects(writer.createProduct({}), { code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_WRITE_FORBIDDEN" });
  await assert.rejects(writer.updateImages({}), { code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_WRITE_FORBIDDEN" });
  assert.deepEqual(writer.calls, ["createProduct", "updateImages"]);
});

test("trial runner permits only the four production Ozon read paths and blocks writes before transport", async () => {
  const { runner } = await trialRunnerHarness();
  const delegated = [];
  const readTransport = runner.createTrialOzonReadTransport({
    async transport(...args) {
      delegated.push(args);
      return { items: [] };
    },
  });
  const allowedPaths = [
    "/v1/description-category/tree",
    "/v1/description-category/attribute",
    "/v1/description-category/attribute/values",
    "/v2/warehouse/list",
  ];
  for (const apiPath of allowedPaths) {
    await readTransport({ clientId: "client-a" }, apiPath, { language: "DEFAULT" }, 60_000, { signal: null });
  }
  await assert.rejects(
    readTransport({ clientId: "client-a" }, "/v3/product/import", { items: [] }),
    { code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_READ_PATH_FORBIDDEN" },
  );
  await assert.rejects(
    readTransport({ clientId: "client-a" }, "/v1/unknown/read", {}),
    { code: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_READ_PATH_FORBIDDEN" },
  );
  assert.deepEqual(readTransport.calls, allowedPaths);
  assert.equal(delegated.length, allowedPaths.length);
  assert.deepEqual(delegated.map((args) => args[1]), allowedPaths);
  const runnerSource = await readFile(new URL("../../scripts/run-auto-listing-source-image-intelligence-trial.mjs", import.meta.url), "utf8");
  assert.match(runnerSource, /callOzonSellerApi:\s*ozonReadTransport/u);
  assert.doesNotMatch(runnerSource, /callOzonSellerApi:\s*ozonWriter/u);
});

test("production trial budgets cleanup attempts from only the current source-image analysis run", async () => {
  const runnerSource = await readFile(
    new URL("../../scripts/run-auto-listing-source-image-intelligence-trial.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    runnerSource,
    /derivative\.analysis_run_id=item\.current_source_image_analysis_run_id/u,
  );
});

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

function memoryProductionStorage() {
  const objects = new Map();
  return Object.freeze({
    objects,
    port: Object.freeze({
      async putObjectFromBuffer(input) {
        const bytes = Buffer.from(input.buffer);
        if (input.ifNoneMatch === "*" && objects.has(input.key)) {
          throw Object.assign(new Error("exists"), { code: "PreconditionFailed", statusCode: 412 });
        }
        objects.set(input.key, bytes);
        return Object.freeze({
          key: input.key,
          sha256: digest(bytes),
          contentType: input.contentType,
          size: bytes.length,
          etag: digest(`etag:${input.key}:${digest(bytes)}`),
          versionId: digest(`version:${input.key}:${digest(bytes)}`),
        });
      },
      async getObjectBuffer(key) {
        if (!objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
        return Buffer.from(objects.get(key));
      },
      async removeObject(key) { objects.delete(key); },
    }),
  });
}

function validFillFromSchema(schema) {
  const fillSchema = schema?.properties?.fills;
  const fills = {};
  for (const slotKey of fillSchema?.required || []) {
    const claimsSchema = fillSchema.properties[slotKey].properties.claims;
    const claimCount = claimsSchema.minItems || 0;
    if (claimCount === 0) {
      fills[slotKey] = { claims: [] };
      continue;
    }
    const claimSchema = claimsSchema.items;
    const allowedTexts = claimSchema.properties.text.enum || [];
    const allowedKinds = claimSchema.properties.claimType.enum || [];
    const factIdSchema = claimSchema.properties.sourceFactIds.items;
    const allowedFactIds = factIdSchema.enum || [];
    fills[slotKey] = {
      claims: Array.from({ length: claimCount }, (_, index) => ({
        text: allowedTexts[Math.min(index, allowedTexts.length - 1)],
        claimType: allowedKinds[Math.min(index, allowedKinds.length - 1)],
        sourceFactIds: [allowedFactIds[Math.min(index, allowedFactIds.length - 1)]],
      })),
    };
  }
  return { version: 1, language: "ru", fills };
}

function parseLastPromptJson(prompt) {
  const line = String(prompt).slice(String(prompt).lastIndexOf("\n") + 1);
  return JSON.parse(line);
}

function parsePlannerPromptJson(prompt) {
  const value = String(prompt);
  const start = value.indexOf("<UNTRUSTED_SOURCE_FACTS_JSON>\n");
  const end = value.indexOf("\n</UNTRUSTED_SOURCE_FACTS_JSON>", start);
  assert.ok(start >= 0 && end > start);
  return JSON.parse(value.slice(start + "<UNTRUSTED_SOURCE_FACTS_JSON>\n".length, end));
}

function validLegacyPlanFromPrompt(prompt) {
  const input = parsePlannerPromptJson(prompt);
  const identity = input.factRegistry.find(({ kind }) => kind === "IDENTITY_NAME") || input.factRegistry[0];
  assert.ok(identity);
  const slots = [];
  let order = 0;
  for (const group of input.visualGroups) {
    for (const role of ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]) {
      const count = input.requestedRoleCounts[role];
      for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        const claims = role === "MAIN" ? [] : [{
          text: String(identity.value),
          claimType: identity.kind,
          sourceFactIds: [identity.factId],
        }];
        slots.push({
          slotKey: `${group.visualGroupKey}:${role.toLowerCase().replaceAll("_", "-")}:${String(ordinal).padStart(2, "0")}`,
          visualGroupKey: group.visualGroupKey,
          role,
          order: order += 1,
          textDensity: role === "MAIN" ? "NONE" : input.textDensityByRole[role],
          claims,
          sourceFactIds: [identity.factId],
          referenceAssetIds: group.referenceImages.map(({ assetId }) => assetId),
          preserve: [...group.requiredPreserve],
          prohibitedClaims: [...input.prohibitedClaims],
        });
      }
    }
  }
  return { version: 1, language: "ru", slots };
}

function fakeProductionGateway({ fixtureProducts, chargedCalls, forceGroupRetry = false }) {
  let sequence = 0;
  async function charged(kind, operation) {
    chargedCalls.running += 1;
    chargedCalls.maximum = Math.max(chargedCalls.maximum, chargedCalls.running);
    chargedCalls.kinds.push(kind);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await operation();
    } finally { chargedCalls.running -= 1; }
  }
  return Object.freeze({
    async analyzeSourceImages(input) {
      const serializedFacts = JSON.stringify(input.sourceFacts);
      const fixtureProduct = fixtureProducts.find((candidate) => serializedFacts.includes(candidate.name))
        || fixtureProducts[0];
      const assets = fixtureProduct.assets;
      return charged("ANALYZE_SOURCE_IMAGE_BATCH", async () => ({
        observations: input.images.map((image) => observationFor({
          ...assets[image.sourceOrdinal],
          assetId: image.sourceAssetId,
        })),
      }));
    },
    async createTextResponse(input) {
      return charged(input.jsonSchema?.properties?.fills ? "PLAN_CONTENT" : "GENERATE_RICH_CONTENT", async () => {
        if (input.jsonSchema?.properties?.fills) {
          chargedCalls.plannerInputs = chargedCalls.plannerInputs || [];
          chargedCalls.plannerInputs.push(parsePlannerPromptJson(input.prompt));
          return {
            requestId: `plan-${sequence += 1}`,
            modelEvidence: {
              requestedTextModel: input.model,
              gatewayReportedTextModel: input.model,
              gatewayReportedTextModelPresent: true,
            },
            value: validFillFromSchema(input.jsonSchema),
          };
        }
        if (input.jsonSchema?.properties?.slots) {
          return {
            requestId: `plan-${sequence += 1}`,
            modelEvidence: {
              requestedTextModel: input.model,
              gatewayReportedTextModel: input.model,
              gatewayReportedTextModelPresent: true,
            },
            value: validLegacyPlanFromPrompt(input.prompt),
          };
        }
        throw Object.assign(new Error("deterministic rich fallback"), {
          code: "GATEWAY_TIMEOUT",
          retryable: true,
        });
      });
    },
    async generateImage(input) {
      return charged("GENERATE_IMAGE_SLOT", async () => {
        chargedCalls.imageGenerationCalls = (chargedCalls.imageGenerationCalls || 0) + 1;
        return {
          requestId: `image-${sequence += 1}`,
          bytes: forceGroupRetry && chargedCalls.imageGenerationCalls > 6 ? retryBytes : generatedBytes,
          modelEvidence: {
            requestedImageModel: input.model,
            gatewayReportedImageModel: input.model,
            gatewayReportedImageModelPresent: true,
            orchestratorModel: "",
          },
        };
      });
    },
    async inspectImage(input) {
      return charged(input.jsonSchema?.properties?.acceptedSlotKeys ? "CHECK_IMAGE_GROUP" : "CHECK_IMAGE_SLOT", async () => {
        const evidence = parseLastPromptJson(input.prompt);
        if (input.jsonSchema?.properties?.acceptedSlotKeys) {
          const slotKeys = evidence.slots.map(({ slotKey }) => slotKey);
          chargedCalls.groupCheckCalls = (chargedCalls.groupCheckCalls || 0) + 1;
          const retrySlotKey = forceGroupRetry && chargedCalls.groupCheckCalls === 1 ? slotKeys[1] : null;
          return {
            requestId: `group-${sequence += 1}`,
            modelEvidence: {
              requestedTextModel: input.model,
              gatewayReportedTextModel: input.model,
              gatewayReportedTextModelPresent: true,
            },
            value: {
              acceptedSlotKeys: slotKeys.filter((slotKey) => slotKey !== retrySlotKey),
              duplicateSlotKeys: retrySlotKey ? [retrySlotKey] : [],
              viewMismatchSlotKeys: [],
              identityMismatchSlotKeys: [],
              reasonCodes: retrySlotKey ? ["IMAGE_GROUP_DUPLICATE_VIEW"] : [],
            },
          };
        }
        const plannedFactIds = Object.hasOwn(evidence, "plannedClaimSourceFactIds")
          ? new Set(evidence.plannedClaimSourceFactIds)
          : null;
        const plannedFacts = plannedFactIds === null
          ? [(evidence.facts || []).find(({ kind }) => kind === "IDENTITY_NAME") || evidence.facts?.[0]].filter(Boolean)
          : (evidence.facts || []).filter(({ factId }) => plannedFactIds.has(factId));
        chargedCalls.checks.push({
          role: evidence.visualBrief?.role ?? null,
          plannedFactIds: plannedFactIds === null ? null : [...plannedFactIds],
          factIds: (evidence.facts || []).map(({ factId }) => factId),
          requiredClaimTexts: evidence.visualBrief?.requiredClaimTexts || [],
          plannedFacts,
          sourceAssetIds: evidence.orderedSourceAssetIds || [],
        });
        const claims = plannedFacts.map((fact) => ({
          text: fact.value,
          sourceFactId: fact.factId,
          field: fact.field,
          value: fact.value,
          numericValue: fact.numericValue ?? null,
          unit: fact.unit ?? null,
        }));
        return {
          requestId: `check-${sequence += 1}`,
          modelEvidence: {
            requestedTextModel: input.model,
            gatewayReportedTextModel: input.model,
            gatewayReportedTextModelPresent: true,
          },
          value: {
            matchesProduct: true,
            matchesCategoryStyle: true,
            claimsVerified: true,
            russianText: true,
            quality: "PASS",
            prohibitedContent: false,
            reasons: [],
            evidence: {
              identity: {
                color: true,
                shape: true,
                accessoryCount: true,
                sourceAssetIds: evidence.orderedSourceAssetIds,
              },
              categoryStyle: {
                matches: true,
                referenceEvidenceIds: evidence.categoryStyleReferenceEvidenceIds || [],
              },
              claims,
              detectedTexts: [...new Set(claims.map(({ text }) => text))],
              language: "ru",
              qualityFlags: [],
              prohibitedFlags: [],
              ...(evidence.sourceImageGenerationEvidence ? {
                targetViewMatched: true,
                prohibitedViewVisible: false,
                intrinsicMarkingsPreserved: true,
                externalOverlayDetected: false,
                unsupportedFactIds: [],
              } : {}),
            },
          },
        };
      });
    },
  });
}

async function seedPostgresJourney(admin, {
  accountId, suffix, product, urls, pool, strictCategoryStyle = false,
}) {
  const collectItemId = `collect-${suffix}`;
  const productDraftId = `draft-${suffix}`;
  const rawId = `raw-${suffix}`;
  const categoryEvidenceId = `category-evidence-${suffix}`;
  const storeId = `store-${suffix}`;
  const warehouseId = `warehouse-${suffix}`;
  const strategyId = `strategy-${suffix}`;
  const policyId = `policy-${suffix}`;
  const profileId = `profile-${suffix}`;
  const connectionId = `connection-${suffix}`;
  const channelId = `channel-${suffix}`;
  const listingDraft = {
    sku: `sku-${suffix}`,
    offerId: `offer-${suffix}`,
    title: `Товар ${product.name}`,
    brand: "Бренд",
    descriptionCategoryId: "170",
    typeId: "99",
    currency: "RUB",
    blackKopecks: "10000",
    greenKopecks: "8000",
    attributes: product.structuredFacts,
    logistics: {},
    productMeasurements: {},
    categoryResolution: {
      status: "MATCHED",
      method: "taxonomy",
      target: { storeId, descriptionCategoryId: "170", typeId: "99" },
    },
    images: urls,
    variants: [{
      sku: `sku-${suffix}`,
      offerId: `offer-${suffix}`,
      name: `Товар ${product.name}`,
      currency: "RUB",
      blackKopecks: "10000",
      greenKopecks: "8000",
      images: urls,
      evidence: {
        contractVersion: 1,
        variantId: `variant-${suffix}`,
        appearanceStatus: "COMPLETE",
        appearanceFacts: [{ factId: "fact.material", kind: "MATERIAL", value: "сталь" }],
        sizeFacts: [],
      },
    }],
  };
  await admin.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
    [accountId, `user-${suffix}`],
  );
  await admin.query(
    `INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id,currency_code,currency_source,currency_synced_at)
     VALUES ($1,'Task12 store','Task12 store',$2,'active',$3,'RUB','OZON_SELLER_INFO',NOW())`,
    [storeId, `client-${suffix}`, accountId],
  );
  await admin.query(
    `INSERT INTO store_credentials
      (store_id,client_id,encrypted_api_key,iv,auth_tag,algorithm,key_version)
     VALUES ($1,$2,'task12-cipher','task12-iv','task12-tag','aes-256-gcm','task12-v1')`,
    [storeId, `client-${suffix}`],
  );
  await admin.query(
    `INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
     VALUES ($1,$2,'1001','FBS','active',TRUE,FALSE)`,
    [warehouseId, storeId],
  );
  await admin.query(
    `INSERT INTO products (id,store_id,product_id,sku,offer_id,name,status)
     VALUES ($1,$2,$3,$4,$5,'Task12 warehouse evidence','ACTIVE')`,
    [`product-${suffix}`, storeId, `product-${suffix}`, listingDraft.sku, listingDraft.offerId],
  );
  await admin.query(
    `INSERT INTO product_stocks (product_id,warehouse_id,store_id,sku,offer_id,source,present)
     VALUES ($1,$2,$3,$4,$5,'fbs',1)`,
    [`product-${suffix}`, warehouseId, storeId, listingDraft.sku, listingDraft.offerId],
  );
  await admin.query(
    "INSERT INTO collect_items (id,account_id,status,source_sku,source_url) VALUES ($1,$2,'COLLECTED',$3,$4)",
    [collectItemId, accountId, listingDraft.sku, `https://www.ozon.ru/product/${suffix}`],
  );
  await admin.query(
    `INSERT INTO collect_raw_payloads
      (id,collect_item_id,account_id,source_sku,source_url,payload_hash,collector_version,payload,collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,'task12',$7::JSONB,NOW())`,
    [rawId, collectItemId, accountId, listingDraft.sku, `https://www.ozon.ru/product/${suffix}`,
      digest(rawId), JSON.stringify({ normalized: { listingDraft } })],
  );
  await admin.query(
    `INSERT INTO product_drafts
      (id,collect_item_id,source_payload_id,version,data_hash,data,normalizer_version,category_rule_version,dictionary_version)
     VALUES ($1,$2,$3,1,$4,$5::JSONB,'task12','task12','task12')`,
    [productDraftId, collectItemId, rawId, digest(productDraftId), JSON.stringify(listingDraft)],
  );
  await admin.query(
    `INSERT INTO product_draft_revisions (id,draft_id,version,data_hash,data,changed_by,change_reason)
     VALUES ($1,$2,1,$3,$4::JSONB,$5,'task12 journey')`,
    [`revision-${suffix}`, productDraftId, digest(productDraftId), JSON.stringify(listingDraft), accountId],
  );
  await admin.query("UPDATE collect_items SET current_draft_id=$1 WHERE account_id=$2 AND id=$3",
    [productDraftId, accountId, collectItemId]);
  await admin.query(
    `INSERT INTO collect_ozon_category_source_evidence
      (id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
       source_description_category_id,source_type_id,taxonomy_scope,captured_at,raw_response_hash,
       raw_response_ref,product_raw_response_ref,provenance)
     VALUES ($1,$2,'PRODUCT_DRAFT',$3,'1',$4,$3,170,99,'OZON:DEFAULT',NOW(),$5,$6,$6,'{}'::JSONB)`,
    [categoryEvidenceId, accountId, productDraftId, collectItemId, digest(rawId), rawId],
  );
  await admin.query(
    `INSERT INTO collect_ozon_category_current_sources
      (account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,source_version)
     VALUES ($1,$2,$3,'PRODUCT_DRAFT',$4,'1')`,
    [accountId, collectItemId, categoryEvidenceId, productDraftId],
  );
  await admin.query(
    `INSERT INTO account_ozon_shared_categories
      (id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
       current_description_category_id,current_type_id,status,source,version,source_evidence_id,validated_at)
     VALUES ($1,$2,170,99,'OZON:DEFAULT',170,99,'ACTIVE','SOURCE_DIRECT',1,$3,NOW())`,
    [`shared-${suffix}`, accountId, categoryEvidenceId],
  );
  await admin.query(
    `INSERT INTO ai_content_strategy_versions
      (id,account_id,strategy_key,version,status,content,content_hash,published_at,published_by,created_by)
     VALUES ($1,$2,'default',1,$4,$5::JSONB,$3,
       CASE WHEN $4='PUBLISHED' THEN NOW() ELSE NULL END,
       CASE WHEN $4='PUBLISHED' THEN $2 ELSE NULL END,$2)`,
    [strategyId, accountId, digest("strategy"), strictCategoryStyle ? "DRAFT" : "PUBLISHED",
      JSON.stringify({ schemaVersion: strictCategoryStyle ? "V2" : "V1" })],
  );
  if (strictCategoryStyle) {
    const ruleId = `style-rule-${suffix}`;
    const guidance = exactCategoryStyle();
    await admin.query(
      `INSERT INTO ai_content_strategy_rules
        (id,account_id,strategy_version_id,rule_kind,rule_order,category_id,rule)
       VALUES ($1,$2,$3,'EXACT_CATEGORY',1,'170',$4::JSONB)`,
      [ruleId, accountId, strategyId, JSON.stringify({
        ruleId,
        ruleOrder: 1,
        matchType: "EXACT_CATEGORY_TYPE_V2",
        scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99 },
        overallStyle: guidance.overallStyle,
        prohibitedPatterns: guidance.prohibitedPatterns,
        roleGuidance: guidance.roles,
        sampleSetHash: digest(`category-samples:${suffix}`),
        analysisAttemptId: `category-analysis-attempt-${suffix}`,
        analysisResultId: `category-analysis-result-${suffix}`,
      })],
    );
    await admin.query(
      `UPDATE ai_content_strategy_versions SET status='PUBLISHED',published_at=NOW(),published_by=$2
        WHERE id=$1 AND account_id=$2`,
      [strategyId, accountId],
    );
    await admin.query(
      `INSERT INTO auto_listing_category_strategy_drafts
        (id,account_id,taxonomy_scope,description_category_id,type_id,draft_version,status,
         source_collect_item_id,source_product_draft_id,source_product_draft_version,expected_source_version,
         idempotency_key,correlation_id,request_hash,actor_account_id)
       VALUES ($1,$2,'OZON:DEFAULT',170,99,1,'PUBLISHED',$3,$4,1,'draft:1',$5,$6,$7,$2)`,
      [`category-draft-${suffix}`, accountId, collectItemId, productDraftId,
        `category-draft-key-${suffix}`, `category-draft-correlation-${suffix}`, digest(`category-draft:${suffix}`)],
    );
    await admin.query(
      `UPDATE auto_listing_category_strategy_account_settings
          SET mode='REQUIRE_EXACT_STRATEGY',version=version+1,idempotency_key=$2,
              correlation_id=$3,request_hash=$4,actor_account_id=$1,updated_at=NOW()
        WHERE account_id=$1`,
      [accountId, `category-setting-key-${suffix}`, `category-setting-correlation-${suffix}`,
        digest(`category-setting:${suffix}`)],
    );
  }
  await admin.query(
    `INSERT INTO auto_listing_upload_policy_versions
      (id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
       publication_origin,publication_base_url,publication_prefix,publication_version,publication_policy_hash)
     VALUES ($1,$2,'REVIEW',TRUE,1,'task12 journey',$2,$2,NOW(),'https://media.invalid',
       'https://media.invalid/','listing-media/v1','LISTING_MEDIA_V1',$3)`,
    [policyId, accountId, digest("policy")],
  );
  await admin.query(
    `INSERT INTO ai_gateway_connection_versions
      (account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
       fingerprint,status,idempotency_key,request_hash,correlation_id,created_by)
     VALUES ($1,$2,1,'Task12 channel','https://gateway.invalid','cipher','iv','tag','aes-256-gcm','task12-v1',
       $3,'PENDING',$4,$5,$6,$1)`,
    [accountId, connectionId, digest(`fingerprint:${suffix}`), `connection-key-${suffix}`,
      digest("connection-request"), `connection-correlation-${suffix}`],
  );
  await admin.query(
    `UPDATE ai_gateway_connection_versions
        SET status='VALIDATED',status_version=2,validation_result='{"outcome":"PASSED"}'::JSONB,
            validation_hash=$3,validated_at=NOW(),validated_by=$1
      WHERE account_id=$1 AND id=$2 AND version=1`,
    [accountId, connectionId, digest("connection-validation")],
  );
  await admin.query(
    `UPDATE ai_gateway_connection_versions
        SET status='ACTIVE',status_version=3,activated_at=NOW(),activated_by=$1
      WHERE account_id=$1 AND id=$2 AND version=1`,
    [accountId, connectionId],
  );
  const { createAutoListingAiSettingsPostgres } = await import("../auto-listing-ai-settings-postgres.mjs");
  const settings = createAutoListingAiSettingsPostgres({ pool });
  const syncTask = await settings.enqueueModelSync({
    accountId,
    actorId: accountId,
    connectionId,
    connectionVersion: 1,
    expectedConnectionStatusVersion: 3,
    idempotencyKey: `catalog-sync-${suffix}`,
    correlationId: `catalog-sync-${suffix}`,
    maxAttempts: 5,
    syncPurpose: "CATALOG_SYNC",
  });
  const syncLease = await settings.claimModelSync({
    accountId,
    workerId: `catalog-worker-${suffix}`,
    leaseMs: 30_000,
  });
  await settings.completeModelSync({
    accountId,
    workerId: `catalog-worker-${suffix}`,
    taskId: syncTask.id,
    leaseVersion: syncLease.leaseVersion,
    leaseToken: syncLease.leaseToken,
    correlationId: `catalog-complete-${suffix}`,
    catalog: { models: [{ id: "text-model" }, { id: "image-model" }] },
    capabilityResult: {
      outcome: "PASSED",
      checkedAt: new Date().toISOString(),
      text: true,
      image: true,
    },
  });
  await admin.query(
    `INSERT INTO ai_gateway_profiles
      (id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
       text_model,image_model,config_version,enabled,connection_id,connection_version)
     VALUES ($1,$2,'Task12 profile','https://gateway.invalid','SUB2API_ENCRYPTED_KEY',
       'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,TRUE,$3,1)`,
    [profileId, accountId, connectionId],
  );
  await admin.query(
    `INSERT INTO auto_listing_ai_profile_channels
      (account_id,profile_id,profile_version,channel_id,display_name,connection_id,connection_version,channel_order)
     VALUES ($1,$2,1,$3,'Task12 channel',$4,1,1)`,
    [accountId, profileId, channelId, connectionId],
  );
  return Object.freeze({ accountId, collectItemId, storeId, warehouseId, profileId, channelId });
}

async function seedAdditionalPostgresJourneyItem(admin, {
  accountId, suffix, product, urls, storeId, warehouseId,
}) {
  const collectItemId = `collect-${suffix}`;
  const productDraftId = `draft-${suffix}`;
  const rawId = `raw-${suffix}`;
  const categoryEvidenceId = `category-evidence-${suffix}`;
  const material = product.structuredFacts.find(({ kind }) => kind === "MATERIAL")?.value || "сталь";
  const listingDraft = {
    sku: `sku-${suffix}`,
    offerId: `offer-${suffix}`,
    title: `Товар ${product.name}`,
    brand: "Бренд",
    descriptionCategoryId: "170",
    typeId: "99",
    currency: "RUB",
    blackKopecks: "10000",
    greenKopecks: "8000",
    attributes: product.structuredFacts,
    logistics: {},
    productMeasurements: {},
    categoryResolution: {
      status: "MATCHED",
      method: "taxonomy",
      target: { storeId, descriptionCategoryId: "170", typeId: "99" },
    },
    images: urls,
    variants: [{
      sku: `sku-${suffix}`,
      offerId: `offer-${suffix}`,
      name: `Товар ${product.name}`,
      currency: "RUB",
      blackKopecks: "10000",
      greenKopecks: "8000",
      images: urls,
      evidence: {
        contractVersion: 1,
        variantId: `variant-${suffix}`,
        appearanceStatus: "COMPLETE",
        appearanceFacts: [{ factId: "fact.material", kind: "MATERIAL", value: material }],
        sizeFacts: [],
      },
    }],
  };
  await admin.query(
    `INSERT INTO products (id,store_id,product_id,sku,offer_id,name,status)
     VALUES ($1,$2,$3,$4,$5,'Task12 warehouse evidence','ACTIVE')`,
    [`product-${suffix}`, storeId, `product-${suffix}`, listingDraft.sku, listingDraft.offerId],
  );
  await admin.query(
    `INSERT INTO product_stocks (product_id,warehouse_id,store_id,sku,offer_id,source,present)
     VALUES ($1,$2,$3,$4,$5,'fbs',1)`,
    [`product-${suffix}`, warehouseId, storeId, listingDraft.sku, listingDraft.offerId],
  );
  await admin.query(
    "INSERT INTO collect_items (id,account_id,status,source_sku,source_url) VALUES ($1,$2,'COLLECTED',$3,$4)",
    [collectItemId, accountId, listingDraft.sku, `https://www.ozon.ru/product/${suffix}`],
  );
  await admin.query(
    `INSERT INTO collect_raw_payloads
      (id,collect_item_id,account_id,source_sku,source_url,payload_hash,collector_version,payload,collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,'task12',$7::JSONB,NOW())`,
    [rawId, collectItemId, accountId, listingDraft.sku, `https://www.ozon.ru/product/${suffix}`,
      digest(rawId), JSON.stringify({ normalized: { listingDraft } })],
  );
  await admin.query(
    `INSERT INTO product_drafts
      (id,collect_item_id,source_payload_id,version,data_hash,data,normalizer_version,category_rule_version,dictionary_version)
     VALUES ($1,$2,$3,1,$4,$5::JSONB,'task12','task12','task12')`,
    [productDraftId, collectItemId, rawId, digest(productDraftId), JSON.stringify(listingDraft)],
  );
  await admin.query(
    `INSERT INTO product_draft_revisions (id,draft_id,version,data_hash,data,changed_by,change_reason)
     VALUES ($1,$2,1,$3,$4::JSONB,$5,'task12 journey')`,
    [`revision-${suffix}`, productDraftId, digest(productDraftId), JSON.stringify(listingDraft), accountId],
  );
  await admin.query("UPDATE collect_items SET current_draft_id=$1 WHERE account_id=$2 AND id=$3",
    [productDraftId, accountId, collectItemId]);
  await admin.query(
    `INSERT INTO collect_ozon_category_source_evidence
      (id,account_id,source_kind,source_record_id,source_version,collect_item_id,product_draft_id,
       source_description_category_id,source_type_id,taxonomy_scope,captured_at,raw_response_hash,
       raw_response_ref,product_raw_response_ref,provenance)
     VALUES ($1,$2,'PRODUCT_DRAFT',$3,'1',$4,$3,170,99,'OZON:DEFAULT',NOW(),$5,$6,$6,'{}'::JSONB)`,
    [categoryEvidenceId, accountId, productDraftId, collectItemId, digest(rawId), rawId],
  );
  await admin.query(
    `INSERT INTO collect_ozon_category_current_sources
      (account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,source_version)
     VALUES ($1,$2,$3,'PRODUCT_DRAFT',$4,'1')`,
    [accountId, collectItemId, categoryEvidenceId, productDraftId],
  );
  return Object.freeze({ collectItemId, product, urls, suffix });
}

async function runPostgresSourceImageJourney({
  fixture,
  manualDecision = false,
  forceGroupRetry = false,
  compareCategoryStrategy = false,
  planningContract = "FIXED_SKELETON_SOURCE_IMAGE_V1",
}) {
  const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
  const [{ Pool }, runtimeModule, compositionModule, repositoryModule, phaseContextModule,
    workflowModule, orchestratorModule, planRepositoryModule, planEvidenceModule,
    sourceMaterializationRepositoryModule, sourceMaterializerModule, generationModule, cleanupModule,
    richRepositoryModule, richContentModule,
    sourceLoaderModule, contentPlannerModule, materializedPlanModule, imageGeneratorModule,
    reviewPreviewModule, reviewRepositoryModule, outboxModule, queueModule, serviceModule,
    sourceImageRepositoryModule] = await Promise.all([
    import("pg"),
    import("../auto-listing-runtime.mjs"),
    import("../auto-listing-ai-runtime-composition.mjs"),
    import("../auto-listing-repository.mjs"),
    import("../auto-listing-ai-phase-context-postgres.mjs"),
    import("../auto-listing-ai-workflow-postgres.mjs"),
    import("../auto-listing-ai-orchestrator.mjs"),
    import("../auto-listing-content-plan-repository.mjs"),
    import("../auto-listing-content-plan-evidence-postgres.mjs"),
    import("../auto-listing-source-materialization-repository.mjs"),
    import("../auto-listing-source-materializer.mjs"),
    import("../auto-listing-generation-attempt-postgres.mjs"),
    import("../auto-listing-asset-cleanup-repository.mjs"),
    import("../auto-listing-rich-content-repository.mjs"),
    import("../auto-listing-rich-content.mjs"),
    import("../auto-listing-materialized-source-loader.mjs"),
    import("../auto-listing-content-planner.mjs"),
    import("../auto-listing-materialized-plan.mjs"),
    import("../auto-listing-image-generator.mjs"),
    import("../auto-listing-review-preview.mjs"),
    import("../auto-listing-review-postgres.mjs"),
    import("../auto-listing-ai-outbox-postgres.mjs"),
    import("../auto-listing-ai-queue.mjs"),
    import("../auto-listing-service.mjs"),
    import("../auto-listing-source-image-intelligence-repository.mjs"),
  ]);
  const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
  const adminPool = new Pool({ connectionString, max: 1 });
  const admin = await adminPool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `task12_source_journey_${suffix}`;
  let pool;
  let runtime;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
    const migrations = (await readdir(migrationsDirectory)).filter((name) => /^\d{3}_.+\.sql$/u.test(name)).sort();
    for (const migration of migrations) await admin.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });
    const accountId = `account-${suffix}`;
    const seededProducts = fixture.products.map((product, index) => {
      const productSuffix = index === 0 ? suffix : `${suffix}-${index + 1}`;
      const urls = product.assets.map((_asset, assetIndex) =>
        `https://source.invalid/${productSuffix}/${assetIndex + 1}`);
      return { product, productSuffix, urls, productDraftId: `draft-${productSuffix}` };
    });
    const firstProduct = seededProducts[0];
    const ids = await seedPostgresJourney(admin, {
      accountId,
      suffix: firstProduct.productSuffix,
      product: firstProduct.product,
      urls: firstProduct.urls,
      pool,
      strictCategoryStyle: compareCategoryStrategy,
    });
    const collectItemIds = [ids.collectItemId];
    for (const entry of seededProducts.slice(1)) {
      const additional = await seedAdditionalPostgresJourneyItem(admin, {
        accountId,
        suffix: entry.productSuffix,
        product: entry.product,
        urls: entry.urls,
        storeId: ids.storeId,
        warehouseId: ids.warehouseId,
      });
      collectItemIds.push(additional.collectItemId);
    }
    const productByDraftId = new Map(seededProducts.map((entry) => [entry.productDraftId, entry]));
    const urlAssets = new Map(seededProducts.flatMap(({ product, urls }) =>
      urls.map((url, index) => [url, product.assets[index]])));
    const storage = memoryProductionStorage();
    const chargedCalls = { running: 0, maximum: 0, kinds: [], checks: [], groupCheckCalls: 0 };
    const planStrategyCaptures = new Map();
    const gateway = fakeProductionGateway({ fixtureProducts: fixture.products, chargedCalls, forceGroupRetry });
    const ozonCalls = [];
    const throwingOzon = async (...args) => {
      ozonCalls.push(args[1] || "unknown");
      throw Object.assign(new Error("Ozon is forbidden in Task12"), { code: "AUTO_LISTING_TEST_OZON_FORBIDDEN" });
    };
    const handlers = new Map();
    const queuedJobs = [];
    const publishedQueueJobIds = new Set();
    let queueJobsRunning = 0;
    let maxConcurrentQueueJobs = 0;
    let generationQueueJobsRunning = 0;
    let maxConcurrentGenerationQueueJobs = 0;
    let groupRetryBefore = null;
    const boss = Object.freeze({
      on() {},
      async start() {},
      async createQueue() {},
      async work(name, _options, handler) { handlers.set(name, handler); return `worker-${name}`; },
      async send(name, data, options) {
        if (publishedQueueJobIds.has(options.id)) return null;
        publishedQueueJobIds.add(options.id);
        queuedJobs.push({ name, data, id: options.id });
        return options.id;
      },
      async flush() {
        const jobs = queuedJobs.splice(0);
        await Promise.all(jobs.map(async (job) => {
          const handler = handlers.get(job.name);
          assert.equal(typeof handler, "function");
          const generation = job.data?.message?.phase === "GENERATE_IMAGE_SLOT";
          queueJobsRunning += 1;
          maxConcurrentQueueJobs = Math.max(maxConcurrentQueueJobs, queueJobsRunning);
          if (generation) {
            generationQueueJobsRunning += 1;
            maxConcurrentGenerationQueueJobs = Math.max(
              maxConcurrentGenerationQueueJobs,
              generationQueueJobsRunning,
            );
          }
          try {
            const [outcome] = await handler([{ id: job.id, data: job.data }]);
            assert.equal(outcome.status, "completed", JSON.stringify(outcome));
          } finally {
            queueJobsRunning -= 1;
            if (generation) generationQueueJobsRunning -= 1;
          }
        }));
        if (forceGroupRetry && chargedCalls.groupCheckCalls === 1 && groupRetryBefore === null) {
          groupRetryBefore = await loadGroupRetrySnapshot();
        }
      },
      async stop() {},
    });
    const outboxRepository = outboxModule.createPostgresAiOutboxRepository({ pool });
    const workflow = workflowModule.createPostgresAutoListingAiWorkflow({ pool, directUploadAllowed: false });
    const runtimeEnv = {
      AUTO_LISTING_ENABLED: "true",
      AUTO_LISTING_AI_ENABLED: "true",
      AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1_ENABLED: planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1" ? "true" : "false",
      AUTO_LISTING_UPLOAD_ENABLED: "false",
      AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "false",
      AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "SUB2API_ENCRYPTED_KEY",
      AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "https://gateway.invalid",
      AUTO_LISTING_CREDENTIAL_KEY_VERSION: "task12-v1",
      AUTO_LISTING_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 5).toString("base64url"),
      DATABASE_URL: connectionString,
      MINIO_ENDPOINT: "storage.invalid",
      MINIO_ACCESS_KEY: "task12-access",
      MINIO_SECRET_KEY: "task12-secret",
      MINIO_BUCKET: "task12",
      PG_BOSS_SCHEMA: "task12_queue",
      LISTING_PIPELINE_V3: "1",
    };
    const ports = Object.freeze({
      createBoss: () => boss,
      createGateway: () => gateway,
      createWorkflow: async () => workflow,
      createContentPlanRepository: ({ pool: current }) => planRepositoryModule.createPostgresContentPlanRepository({ pool: current }),
      createContentPlanEvidenceRepository: ({ pool: current }) => planEvidenceModule.createPostgresContentPlanEvidenceRepository({ pool: current }),
      createSourceMaterializationRepository: ({ pool: current }) => sourceMaterializationRepositoryModule.createPostgresSourceMaterializationRepository({ pool: current }),
      createGenerationRepository: ({ pool: current }) => {
        const attempts = generationModule.createPostgresGenerationAttemptRepository({ pool: current });
        const cleanup = cleanupModule.createPostgresAssetCleanupRepository({ pool: current });
        return Object.freeze({ ...attempts, recordAssetCleanupRequired: (input) => cleanup.recordAssetCleanupRequired(input) });
      },
      createRichContentRepository: ({ pool: current }) => richRepositoryModule.createPostgresRichContentRepository({ pool: current }),
      createDownloader: () => Object.freeze({
        async downloadSourceImage({ sourceUrl }) {
          const asset = urlAssets.get(sourceUrl);
          if (asset?.terminalFailure) {
            const code = asset.terminalFailure === "UNSUPPORTED_MEDIA"
              ? "AUTO_LISTING_SOURCE_MEDIA_UNSUPPORTED"
              : "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED";
            throw Object.assign(new Error("fixture unavailable"), { code, retryable: false });
          }
          if (!asset?.bytes) throw Object.assign(new Error("fixture unavailable"), {
            code: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
            retryable: false,
          });
          const metadata = await sharp(asset.bytes).metadata();
          return Object.freeze({
            bytes: Buffer.from(asset.bytes),
            contentHash: digest(asset.bytes),
            contentType: asset.contentType,
            width: metadata.width,
            height: metadata.height,
            sizeBytes: asset.bytes.length,
          });
        },
      }),
      createStorage: () => storage.port,
      createSourceAssetLoader: (options) => sourceLoaderModule.createActiveMaterializedSourceAssetLoader(options),
      createContextLoader: (options) => phaseContextModule.createPostgresAutoListingAiPhaseContextLoader(options),
      orchestratePhase: (input, services) => orchestratorModule.orchestrateAutoListingAiPhase(input, services),
      phaseServices: Object.freeze({
        planContent: async (input) => {
          planStrategyCaptures.set(input.itemId, structuredClone(input.strategyCapture));
          return contentPlannerModule.createContentPlan(input);
        },
        materializeSourceAsset: sourceMaterializerModule.materializeSourceAsset,
        finalizeMaterializedPlan: materializedPlanModule.finalizeMaterializedPlan,
        generateImageSlot: (input) => imageGeneratorModule.generateImageSlot({
          ...input,
          cacheReviewPreview: reviewPreviewModule.cacheAutoListingReviewPreview,
        }),
        generateRichContent: richContentModule.generateRichContent,
      }),
      loadCredentialKey: async () => Buffer.alloc(32, 4),
      createCipher: () => Object.freeze({}),
      createCredentialRepository: () => Object.freeze({}),
      createCredentialResolver: () => Object.freeze({ async resolveSecret() { return "task12-secret"; } }),
    });
    const productionAiWorkerDependencies = await compositionModule.createAutoListingAiProductionDependencies({
      env: runtimeEnv,
      resolvePool: async () => pool,
      ports,
    });
    const createAiWorkerDependencies = async () => productionAiWorkerDependencies;
    let itemIds = [];
    async function loadGroupRetrySnapshot() {
      assert.equal(itemIds.length, 1);
      const item = (await pool.query(
        `SELECT active_content_plan_id FROM auto_listing_job_items
          WHERE account_id=$1 AND id=$2`,
        [accountId, itemIds[0]],
      )).rows[0];
      assert.equal(typeof item?.active_content_plan_id, "string");
      const plan = (await pool.query(
        `SELECT visual_groups FROM ai_content_plans
          WHERE account_id=$1 AND item_id=$2 AND id=$3`,
        [accountId, itemIds[0], item.active_content_plan_id],
      )).rows[0];
      const visualGroups = typeof plan?.visual_groups === "string"
        ? JSON.parse(plan.visual_groups) : plan?.visual_groups;
      const referenceAssetIds = [...new Set((visualGroups?.groups || []).flatMap((group) =>
        (group.referenceImages || []).map(({ assetId }) => assetId)))].sort();
      const assets = (await pool.query(
        `SELECT DISTINCT ON (slot_key) slot_key,id,content_hash
           FROM ai_generation_assets
          WHERE account_id=$1 AND item_id=$2 AND plan_id=$3 AND status='ACCEPTED'
          ORDER BY slot_key,accepted_at DESC NULLS LAST,created_at DESC,id DESC`,
        [accountId, itemIds[0], item.active_content_plan_id],
      )).rows.map((entry) => ({
        slotKey: entry.slot_key,
        assetId: entry.id,
        contentHash: entry.content_hash,
      }));
      return Object.freeze({
        referenceAssetIds,
        assets: assets.sort((left, right) => left.slotKey.localeCompare(right.slotKey)),
      });
    }
    const relayIntervals = new Map();
    let relayIntervalSequence = 0;
    const relayTimers = Object.freeze({
      setTimeout,
      clearTimeout,
      setInterval(callback) {
        const token = Object.freeze({ id: relayIntervalSequence += 1, unref() {} });
        relayIntervals.set(token, callback);
        return token;
      },
      clearInterval(token) { relayIntervals.delete(token); },
    });
    async function drainAiWork() {
      for (let cycle = 0; cycle < 100; cycle += 1) {
        for (let claim = 0; claim < 16; claim += 1) {
          await Promise.all([...relayIntervals.values()].map((tick) => tick()));
        }
        await boss.flush();
        const current = itemIds.length ? (await pool.query(
          "SELECT status FROM auto_listing_job_items WHERE account_id=$1 AND id=ANY($2::TEXT[])",
          [accountId, itemIds],
        )).rows.map(({ status }) => status) : [];
        if (current.length === itemIds.length
          && current.every((status) => ["READY_FOR_REVIEW", "BLOCKED", "RETRYABLE_ERROR"].includes(status))) {
          return true;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("Task12 production relay did not converge");
    }
    const createAiOutboxRelay = async () => {
      const relay = await compositionModule.createAutoListingAiProductionOutboxRelay({
        env: runtimeEnv,
        resolvePool: async () => pool,
        ports: Object.freeze({
          createBoss: () => boss,
          createOutboxRepository: () => outboxRepository,
          createQueueAdapter: (options) => queueModule.createCurrentLegacyAutoListingAiQueueAdapter(options),
          createPublisher: (options) => queueModule.createCurrentLegacyAutoListingAiOutboxPublisher({
            ...options,
            timers: relayTimers,
            intervalMs: 1,
          }),
          createWorkQueueAdapter: (options) => queueModule.createCurrentAutoListingAiWorkQueueAdapter(options),
          createWorkPublisher: (options) => queueModule.createCurrentAutoListingAiWorkPublisher({
            ...options,
            timers: relayTimers,
            intervalMs: 1,
          }),
        }),
      });
      return Object.freeze({
        async start() {
          await relay.start();
          return drainAiWork();
        },
        async stop() { await relay.stop(); },
      });
    };
    runtime = runtimeModule.createAutoListingRuntime({
      env: runtimeEnv,
      getPostgresPool: async () => pool,
      createService: planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
        ? serviceModule.createAutoListingService
        : (options) => serviceModule.createAutoListingService({
          ...options,
          selectPlanningContract: () => planningContract,
        }),
      createAiWorkerDependencies,
      createAiOutboxRelay,
      createListingBasePreparer: async () => async ({ source, pricingEvidence }) => {
        const entry = productByDraftId.get(source.productDraft.id);
        assert.ok(entry, source.productDraft.id);
        return {
          productDraft: {
            id: source.productDraft.id,
            version: source.productDraft.version,
            dataHash: source.productDraft.dataHash,
          },
          pricingEvidence: { ...pricingEvidence, evidenceHash: digest(pricingEvidence) },
          richContentAttributeSupported: true,
          variants: [{
            sourceVariantId: `variant-${entry.productSuffix}`,
            sourceSku: `sku-${entry.productSuffix}`,
            item: {
              offer_id: `offer-${entry.productSuffix}`,
              name: `Товар ${entry.product.name}`,
              price: "100.00",
              currency_code: "RUB",
              description_category_id: 170,
              type_id: 99,
              primary_image: entry.urls[0],
              images: entry.urls,
              weight: 100,
              weight_unit: "g",
              depth: 100,
              width: 100,
              height: 100,
              dimension_unit: "mm",
              attributes: [],
            },
          }],
          versions: { normalizerVersion: "task12", categoryRuleVersion: "task12", dictionaryVersion: "task12" },
        };
      },
      createCategoryFreshness: async () => async () => ({ status: "CURRENT" }),
      callOzonSellerApi: throwingOzon,
      logger: null,
    });
    const service = await runtime.getService();
    const jobModes = compareCategoryStrategy
      ? [{ name: "generic", useCategoryStrategy: false }, { name: "styled", useCategoryStrategy: true }]
      : [{ name: "default", useCategoryStrategy: undefined }];
    const createdJobs = [];
    for (const mode of jobModes) {
      createdJobs.push(await service.createAutoListingJob({
        actor: { id: accountId, role: "admin" },
        collectItemIds,
        idempotencyKey: `task12-${mode.name}-${suffix}`,
        correlationId: `task12-correlation-${mode.name}-${suffix}`,
        config: {
        targetStoreId: ids.storeId,
        targetWarehouseId: ids.warehouseId,
        stock: 5,
        priceAdjustmentKopecks: "0",
        ...(mode.useCategoryStrategy === undefined ? {} : { useCategoryStrategy: mode.useCategoryStrategy }),
        image: {
          ratio: "3:4",
          resolution: "1K",
          quality: "Medium",
          language: "ru",
          roles: { main: 1, sellingPoint: 1, detail: 1, scene: 1, specification: 1, infographic: 1 },
        },
        },
      }));
    }
    const created = createdJobs[0];
    const initialJobs = await Promise.all(createdJobs.map((job) => service.getAutoListingJob({
      actor: { id: accountId, role: "admin" }, jobId: job.jobId,
    })));
    itemIds = initialJobs.flatMap((job) => job.items.map(({ itemId: value }) => value));
    await runtime.startAiWorker();
    let review = { items: (await Promise.all(createdJobs.map((job) => service.getAutoListingJob({
      actor: { id: accountId, role: "admin" }, jobId: job.jobId,
    })))).flatMap((job) => job.items) };
    let manualDecisionEvidence = null;
    if (manualDecision) {
      const blocked = (await pool.query(
        `SELECT status,status_version,current_source_image_analysis_run_id
           FROM auto_listing_job_items WHERE account_id=$1 AND job_id=$2 AND id=$3`,
        [accountId, created.jobId, itemIds[0]],
      )).rows[0];
      assert.equal(blocked.status, "BLOCKED");
      const parentBefore = (await pool.query(
        `SELECT id,status,expected_status_version,summary,summary_hash,input_hash,parent_run_id,derivation_kind
           FROM auto_listing_source_image_analysis_runs WHERE account_id=$1 AND id=$2`,
        [accountId, blocked.current_source_image_analysis_run_id],
      )).rows[0];
      const parentHashes = (await pool.query(
        `SELECT source_asset_id,input_hash,result_hash FROM auto_listing_source_image_assessments
          WHERE account_id=$1 AND analysis_run_id=$2 AND record_status='ACCEPTED'
          ORDER BY source_asset_id`,
        [accountId, parentBefore.id],
      )).rows;
      const confirmation = parentBefore.summary?.requiredConfirmations?.[0];
      assert.equal(typeof confirmation?.sourceAssetId, "string");
      const analysisCallsBefore = chargedCalls.kinds.filter((kind) => kind === "ANALYZE_SOURCE_IMAGE_BATCH").length;
      const sourceRepository = sourceImageRepositoryModule.createPostgresSourceImageIntelligenceRepository({ pool });
      const decisionService = createAutoListingSourceImageDecisionService({ repository: sourceRepository });
      const decision = await decisionService.recordDecision({
        accountId,
        jobId: created.jobId,
        itemId: itemIds[0],
        analysisRunId: parentBefore.id,
        sourceAssetId: confirmation.sourceAssetId,
        decision: "EXTERNAL_OVERLAY_EXCLUDE",
        expectedStatusVersion: blocked.status_version,
        idempotencyKey: `task12-decision-${suffix}`,
        correlationId: `task12-decision-correlation-${suffix}`,
      });
      const derived = (await pool.query(
        `SELECT id,status,expected_status_version,parent_run_id,derivation_kind
           FROM auto_listing_source_image_analysis_runs WHERE account_id=$1 AND id=$2`,
        [accountId, decision.analysisRunId],
      )).rows[0];
      const derivedHashes = (await pool.query(
        `SELECT source_asset_id,input_hash,result_hash FROM auto_listing_source_image_assessments
          WHERE account_id=$1 AND analysis_run_id=$2 AND record_status='ACCEPTED'
          ORDER BY source_asset_id`,
        [accountId, decision.analysisRunId],
      )).rows;
      const resume = (await pool.query(
        `SELECT phase FROM auto_listing_ai_outbox
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND phase_target_id=$4
            AND expected_status_version=$5 ORDER BY created_at DESC,id DESC LIMIT 1`,
        [accountId, created.jobId, itemIds[0], decision.analysisRunId, decision.statusVersion],
      )).rows[0];
      await drainAiWork();
      review = await service.getAutoListingJob({
        actor: { id: accountId, role: "admin" },
        jobId: created.jobId,
      });
      const parentAfter = (await pool.query(
        `SELECT id,status,expected_status_version,summary,summary_hash,input_hash,parent_run_id,derivation_kind
           FROM auto_listing_source_image_analysis_runs WHERE account_id=$1 AND id=$2`,
        [accountId, parentBefore.id],
      )).rows[0];
      const analysisCallsAfter = chargedCalls.kinds.filter((kind) => kind === "ANALYZE_SOURCE_IMAGE_BATCH").length;
      manualDecisionEvidence = Object.freeze({
        decision: "EXTERNAL_OVERLAY_EXCLUDE",
        statusVersionIncrement: decision.statusVersion - blocked.status_version,
        parentImmutable: JSON.stringify(parentAfter) === JSON.stringify(parentBefore)
          && derived.parent_run_id === parentBefore.id && derived.derivation_kind === "MANUAL_DECISION",
        resultHashesReused: JSON.stringify(derivedHashes) === JSON.stringify(parentHashes),
        resumePhase: resume?.phase,
        additionalAnalysisCalls: analysisCallsAfter - analysisCallsBefore,
      });
    }
    const row = review.items[0];
    const evidence = await pool.query(
      `SELECT i.id,i.failure_code,i.failure_detail_safe,
         (SELECT COUNT(*)::INTEGER FROM auto_listing_source_image_assessments a
           WHERE a.account_id=$1 AND a.item_id=i.id AND a.analysis_run_id=i.current_source_image_analysis_run_id) assessments,
         (SELECT COUNT(*)::INTEGER FROM auto_listing_source_image_assessments a
           WHERE a.account_id=$1 AND a.item_id=i.id AND a.analysis_run_id=i.current_source_image_analysis_run_id
             AND a.record_status='ACCEPTED') terminal_assessments,
         (SELECT COUNT(DISTINCT g.slot_key)::INTEGER FROM ai_generation_assets g
           WHERE g.account_id=$1 AND g.item_id=i.id AND g.plan_id=i.active_content_plan_id AND g.status='ACCEPTED') generated_assets,
         (SELECT COUNT(*)::INTEGER FROM ai_generation_assets g
           WHERE g.account_id=$1 AND g.item_id=i.id AND g.plan_id=i.active_content_plan_id AND g.status='ACCEPTED') generated_asset_history
       FROM auto_listing_job_items i WHERE i.account_id=$1 AND i.id=ANY($2::TEXT[])
       ORDER BY ARRAY_POSITION($2::TEXT[],i.id)`,
      [accountId, itemIds],
    );
    const sourceRows = await pool.query(
      `SELECT i.id,
         (SELECT run.summary FROM auto_listing_source_image_analysis_runs AS run
           WHERE run.account_id=i.account_id AND run.job_id=i.job_id AND run.item_id=i.id
             AND run.id=i.current_source_image_analysis_run_id) AS source_summary,
         COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
             'sourceAssetId',assessment.source_asset_id,
             'sourceOrdinal',assessment.source_ordinal,
             'terminalStatus',assessment.terminal_status,
             'assessment',assessment.assessment
           ) ORDER BY assessment.source_ordinal NULLS LAST,assessment.source_asset_id)
           FROM auto_listing_source_image_assessments AS assessment
          WHERE assessment.account_id=i.account_id AND assessment.job_id=i.job_id
            AND assessment.item_id=i.id AND assessment.analysis_run_id=i.current_source_image_analysis_run_id),
          '[]'::JSONB) AS assessments,
         (SELECT plan.visual_groups FROM ai_content_plans AS plan
           WHERE plan.account_id=i.account_id AND plan.job_id=i.job_id AND plan.item_id=i.id
             AND plan.id=i.active_content_plan_id) AS visual_groups
       FROM auto_listing_job_items AS i
       WHERE i.account_id=$1 AND i.id=ANY($2::TEXT[])
       ORDER BY ARRAY_POSITION($2::TEXT[],i.id)`,
      [accountId, itemIds],
    );
    const phaseRows = await pool.query(
      "SELECT DISTINCT phase FROM auto_listing_ai_outbox WHERE account_id=$1 AND item_id=ANY($2::TEXT[])",
      [accountId, itemIds],
    );
    const validationRows = await pool.query(
      `SELECT response.item_id,validation.issues
         FROM auto_listing_content_plan_validation_results AS validation
         JOIN auto_listing_content_plan_responses AS response
           ON response.account_id=validation.account_id AND response.id=validation.response_id
        WHERE validation.account_id=$1 AND response.item_id=ANY($2::TEXT[])
        ORDER BY validation.validated_at DESC,validation.id DESC`,
      [accountId, itemIds],
    );
    const seenPhases = new Set(phaseRows.rows.map(({ phase }) => phase));
    const reviewRepository = reviewRepositoryModule.createPostgresAutoListingReviewRepository({ pool });
    const reviewEvidence = await Promise.all(review.items.map((current) => current.status === "READY_FOR_REVIEW"
      ? reviewRepository.loadReviewEvidence({ accountId, itemId: current.itemId })
      : null));
    const sourceEvidence = sourceRows.rows.map((sourceRow, itemIndex) => {
      const product = fixture.products[itemIndex % fixture.products.length];
      const assessments = sourceRow.assessments || [];
      const fixtureAssetIdBySourceAssetId = new Map(assessments.map((assessment) => [
        assessment.sourceAssetId,
        product.assets[assessment.sourceOrdinal]?.assetId || assessment.sourceAssetId,
      ]));
      const translateAssetId = (assetId) => fixtureAssetIdBySourceAssetId.get(assetId) || assetId;
      const terminalStatusCounts = {};
      const perceptualDuplicateGroups = {};
      for (const assessment of assessments) {
        terminalStatusCounts[assessment.terminalStatus] = (terminalStatusCounts[assessment.terminalStatus] || 0) + 1;
        const group = assessment.assessment?.perceptualDuplicateGroup;
        if (typeof group === "string") {
          perceptualDuplicateGroups[group] = perceptualDuplicateGroups[group] || [];
          perceptualDuplicateGroups[group].push(translateAssetId(assessment.sourceAssetId));
        }
      }
      for (const assetIds of Object.values(perceptualDuplicateGroups)) assetIds.sort();
      const summary = sourceRow.source_summary || {};
      const visualGroups = sourceRow.visual_groups || {};
      return Object.freeze({
        textOnlyCount: assessments.filter((entry) => entry.assessment?.contentKinds?.includes("TEXT_ONLY")).length,
        confirmedFactCount: (summary.factCandidates || []).filter(({ status }) => status === "CONFIRMED").length,
        facts: (summary.factCandidates || []).map((fact) => Object.freeze({
          kind: fact.kind,
          value: fact.value,
          status: fact.status,
          confirmationMethod: fact.confirmationMethod,
          reasonCodes: Object.freeze([...fact.reasonCodes]),
        })),
        productMarkingCount: (summary.markingDecisions || []).filter(({ kind }) => kind === "PRODUCT_MARKING").length,
        externalOverlayCount: (summary.markingDecisions || []).filter(({ kind }) => kind === "EXTERNAL_OVERLAY").length,
        eligibleAssetIds: (summary.eligibleAssetIds || []).map(translateAssetId).sort(),
        excludedAssetIds: (summary.excludedAssetIds || []).map(translateAssetId).sort(),
        generationReferenceAssetIds: [...new Set((visualGroups.groups || []).flatMap((group) =>
          (group.referenceImages || []).map(({ assetId }) => translateAssetId(assetId))))].sort(),
        terminalStatusCounts: Object.freeze(terminalStatusCounts),
        terminalStatusByAssetId: Object.freeze(Object.fromEntries(assessments
          .map((assessment) => [translateAssetId(assessment.sourceAssetId), assessment.terminalStatus])
          .sort(([left], [right]) => left.localeCompare(right)))),
        perceptualDuplicateGroups: Object.freeze(perceptualDuplicateGroups),
      });
    });
    const phaseOrder = [
      "MATERIALIZE_SOURCE_ASSET", "ANALYZE_SOURCE_IMAGE_BATCH", "RECONCILE_SOURCE_IMAGE_ANALYSIS",
      "PLAN_CONTENT", "FINALIZE_MATERIALIZED_PLAN", "GENERATE_IMAGE_SLOT", "CHECK_IMAGE_GROUP",
      "GENERATE_RICH_CONTENT",
    ];
    let groupRetryEvidence = null;
    if (forceGroupRetry) {
      const after = await loadGroupRetrySnapshot();
      assert.ok(groupRetryBefore);
      const beforeBySlot = new Map(groupRetryBefore.assets.map((asset) => [asset.slotKey, asset]));
      const changed = after.assets.filter((asset) => {
        const before = beforeBySlot.get(asset.slotKey);
        return before?.assetId !== asset.assetId || before?.contentHash !== asset.contentHash;
      });
      const stable = after.assets.filter((asset) => {
        const before = beforeBySlot.get(asset.slotKey);
        return before?.assetId === asset.assetId && before?.contentHash === asset.contentHash;
      });
      groupRetryEvidence = Object.freeze({
        changedAssetIds: changed.map(({ assetId }) => assetId),
        changedContentHashes: changed.map(({ contentHash }) => contentHash),
        previousChangedAssetIds: changed.map(({ slotKey }) => beforeBySlot.get(slotKey)?.assetId),
        previousChangedContentHashes: changed.map(({ slotKey }) => beforeBySlot.get(slotKey)?.contentHash),
        stableSiblingAssetIds: stable.map(({ assetId }) => assetId),
        sourceReferenceAssetIdsStable: JSON.stringify(after.referenceAssetIds)
          === JSON.stringify(groupRetryBefore.referenceAssetIds),
        groupCheckCalls: chargedCalls.groupCheckCalls,
      });
    }
    let categoryStrategyEvidence = null;
    if (compareCategoryStrategy) {
      assert.equal(itemIds.length, 2);
      const planRows = (await pool.query(
        `SELECT item.id,plan.strategy_hash,plan.source_image_intelligence_hash,plan.plan
           FROM auto_listing_job_items AS item
           JOIN ai_content_plans AS plan
             ON plan.account_id=item.account_id AND plan.job_id=item.job_id
              AND plan.item_id=item.id AND plan.id=item.active_content_plan_id
          WHERE item.account_id=$1 AND item.id=ANY($2::TEXT[])
          ORDER BY ARRAY_POSITION($2::TEXT[],item.id)`,
        [accountId, itemIds],
      )).rows;
      assert.equal(planRows.length, 2);
      const genericCapture = planStrategyCaptures.get(itemIds[0]);
      const styledCapture = planStrategyCaptures.get(itemIds[1]);
      const plannerInputs = chargedCalls.plannerInputs || [];
      const styledPrompt = plannerInputs.find((input) => Object.hasOwn(input, "categoryRoleGuidance"));
      categoryStrategyEvidence = Object.freeze({
        genericMatchedBy: genericCapture?.strategySnapshot?.matchedBy,
        styledMatchedBy: styledCapture?.strategySnapshot?.matchedBy,
        planStrategyHashesMatchCaptures: planRows[0].strategy_hash === genericCapture?.strategyHash
          && planRows[1].strategy_hash === styledCapture?.strategyHash,
        sourceSummaryHashEqual: planRows[0].source_image_intelligence_hash
          === planRows[1].source_image_intelligence_hash,
        slotEvidenceEqual: JSON.stringify(normalizedSlotEvidence(planRows[0].plan.slots))
          === JSON.stringify(normalizedSlotEvidence(planRows[1].plan.slots)),
        styleHashChanged: planRows[0].strategy_hash !== planRows[1].strategy_hash,
        promptGuidanceCount: plannerInputs.filter((input) => Object.hasOwn(input, "categoryRoleGuidance")).length,
        styledPromptMatchedBy: styledPrompt?.categoryRoleGuidance?.matchedBy,
      });
    }
    let historicalContractEvidence = null;
    if (planningContract !== "FIXED_SKELETON_SOURCE_IMAGE_V1") {
      const historical = (await pool.query(
        `SELECT item.planning_contract,item.current_source_image_analysis_run_id,
                plan.skeleton_hash,plan.source_image_analysis_run_id,plan.source_image_intelligence_hash,
                (SELECT COUNT(*)::INTEGER FROM auto_listing_source_image_analysis_runs AS run
                  WHERE run.account_id=item.account_id AND run.job_id=item.job_id AND run.item_id=item.id) AS analysis_runs,
                (SELECT COUNT(*)::INTEGER FROM auto_listing_source_image_assessments AS assessment
                  WHERE assessment.account_id=item.account_id AND assessment.job_id=item.job_id
                    AND assessment.item_id=item.id) AS analysis_assessments,
                (SELECT COUNT(*)::INTEGER FROM auto_listing_ai_outbox AS outbox
                  WHERE outbox.account_id=item.account_id AND outbox.job_id=item.job_id AND outbox.item_id=item.id
                    AND outbox.phase IN ('ANALYZE_SOURCE_IMAGE_BATCH','RECONCILE_SOURCE_IMAGE_ANALYSIS')) AS analysis_outbox
           FROM auto_listing_job_items AS item
           JOIN ai_content_plans AS plan
             ON plan.account_id=item.account_id AND plan.job_id=item.job_id
            AND plan.item_id=item.id AND plan.id=item.active_content_plan_id
          WHERE item.account_id=$1 AND item.id=$2`,
        [accountId, itemIds[0]],
      )).rows[0];
      assert.ok(historical);
      historicalContractEvidence = Object.freeze({
        planningContract: historical.planning_contract,
        analysisRunCount: historical.analysis_runs,
        analysisAssessmentCount: historical.analysis_assessments,
        analysisOutboxCount: historical.analysis_outbox,
        analysisGatewayCallCount: chargedCalls.kinds.filter((kind) => kind === "ANALYZE_SOURCE_IMAGE_BATCH").length,
        currentAnalysisRunId: historical.current_source_image_analysis_run_id,
        planAnalysisRunId: historical.source_image_analysis_run_id,
        planIntelligenceHash: historical.source_image_intelligence_hash,
        skeletonHash: historical.skeleton_hash,
      });
    }
    return Object.freeze({
      status: row.status,
      itemStatuses: review.items.map(({ status }) => status),
      itemFailureCodes: evidence.rows.map(({ failure_code: code }) => code),
      itemFailureDetails: evidence.rows.map(({ failure_detail_safe: detail }) => detail),
      planValidationIssues: validationRows.rows.map(({ item_id: itemId, issues }) => ({ itemId, issues })),
      perItemAssessmentCounts: evidence.rows.map(({ assessments }) => assessments),
      perItemTerminalAssessmentCounts: evidence.rows.map(({ terminal_assessments: count }) => count),
      perItemOutputSlotCounts: evidence.rows.map(({ generated_assets: count }) => count),
      perItemOutputHistoryCounts: evidence.rows.map(({ generated_asset_history: count }) => count),
      assessmentCount: evidence.rows.reduce((sum, current) => sum + current.assessments, 0),
      terminalAssessmentCount: evidence.rows.reduce((sum, current) => sum + current.terminal_assessments, 0),
      analysisBatchCount: chargedCalls.kinds.filter((kind) => kind === "ANALYZE_SOURCE_IMAGE_BATCH").length,
      outputSlotCount: evidence.rows.reduce((sum, current) => sum + current.generated_assets, 0),
      outputHistoryCount: evidence.rows.reduce((sum, current) => sum + current.generated_asset_history, 0),
      generatedReviewAssetCount: reviewEvidence.reduce((sum, current) => sum + (current?.images.length ?? 0), 0),
      ozonCalls: ozonCalls.length,
      productionRelayPublications: publishedQueueJobIds.size,
      maxConcurrentChargedCallsByChannel: chargedCalls.maximum,
      maxConcurrentQueueJobs,
      maxConcurrentGenerationQueueJobs,
      phases: phaseOrder.filter((phase) => seenPhases.has(phase)),
      checkerInputs: chargedCalls.checks,
      sourceEvidence,
      manualDecisionEvidence,
      groupRetryEvidence,
      categoryStrategyEvidence,
      historicalContractEvidence,
    });
  } finally {
    try { await runtime?.stopAiWorker(); } catch {}
    try { await pool?.end(); } catch {}
    try { await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); } catch {}
    admin.release();
    await adminPool.end();
  }
}

const postgresJourneyEnabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1"
  && Boolean(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);

if (!postgresJourneyEnabled) {
  test("complete source-image journey requires an explicitly disposable PostgreSQL database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("fresh PostgreSQL runs a real service, durable outbox and production worker to review with fake externals", {
    timeout: 120_000,
  }, async () => {
    const result = await runPostgresSourceImageJourney({ fixture: multiViewComplete });

    assert.equal(result.status, "READY_FOR_REVIEW", JSON.stringify(result));
    assert.equal(result.assessmentCount, multiViewComplete.uniqueSourceAssetCount);
    assert.equal(result.terminalAssessmentCount, multiViewComplete.uniqueSourceAssetCount);
    assert.equal(result.outputSlotCount, 6);
    assert.equal(result.generatedReviewAssetCount, 6);
    assert.equal(result.ozonCalls, 0);
    assert.equal(result.productionRelayPublications, 18);
    assert.equal(result.maxConcurrentChargedCallsByChannel, 1);
    assert.deepEqual(result.phases, [
      "MATERIALIZE_SOURCE_ASSET",
      "ANALYZE_SOURCE_IMAGE_BATCH",
      "RECONCILE_SOURCE_IMAGE_ANALYSIS",
      "PLAN_CONTENT",
      "FINALIZE_MATERIALIZED_PLAN",
      "GENERATE_IMAGE_SLOT",
      "CHECK_IMAGE_GROUP",
      "GENERATE_RICH_CONTENT",
    ]);
  });

  test("fresh PostgreSQL drives the remaining deterministic source-image fixtures through production review", {
    timeout: 300_000,
  }, async () => {
    const text = await runPostgresSourceImageJourney({ fixture: singleViewWithText });
    assert.equal(text.status, "READY_FOR_REVIEW", JSON.stringify(text));
    assert.equal(text.assessmentCount, singleViewWithText.uniqueSourceAssetCount);
    assert.equal(text.terminalAssessmentCount, singleViewWithText.uniqueSourceAssetCount);
    assert.equal(text.sourceEvidence[0].textOnlyCount, 3);
    assert.deepEqual(text.sourceEvidence[0].facts.find(({ kind }) => kind === "MATERIAL"), {
      kind: "MATERIAL",
      value: "сталь",
      status: "CONFIRMED",
      confirmationMethod: "STRUCTURED_FACT_MATCH",
      reasonCodes: ["SOURCE_FACT_STRUCTURED_MATCH"],
    });
    assert.deepEqual(text.sourceEvidence[0].facts.find(({ kind }) => kind === "PACKAGE_QUANTITY"), {
      kind: "PACKAGE_QUANTITY",
      value: "3",
      status: "CONFIRMED",
      confirmationMethod: "STRUCTURED_FACT_MATCH",
      reasonCodes: ["SOURCE_FACT_STRUCTURED_MATCH"],
    });
    assert.deepEqual(text.sourceEvidence[0].facts.find(({ kind }) => kind === "FORBIDDEN_TEXT"), {
      kind: "FORBIDDEN_TEXT",
      value: "Скидка 50% seller.example",
      status: "REJECTED",
      confirmationMethod: "REJECTED_FORBIDDEN_TEXT",
      reasonCodes: ["SOURCE_FACT_FORBIDDEN_TEXT_REJECTED"],
    });
    for (const assetId of ["single-text-material", "single-text-quantity", "single-text-promo"]) {
      assert.ok(!text.sourceEvidence[0].generationReferenceAssetIds.includes(assetId));
    }
    assert.ok(text.sourceEvidence[0].generationReferenceAssetIds.includes("single-front"));
    assert.equal(text.outputSlotCount, 6);
    assert.equal(text.ozonCalls, 0);

    const markings = await runPostgresSourceImageJourney({ fixture: intrinsicLogoAndOverlay });
    assert.equal(markings.status, "READY_FOR_REVIEW", JSON.stringify(markings));
    assert.equal(markings.sourceEvidence[0].productMarkingCount, 1);
    assert.equal(markings.sourceEvidence[0].externalOverlayCount, 1);
    assert.ok(markings.sourceEvidence[0].eligibleAssetIds.includes("marking-front"));
    assert.ok(markings.sourceEvidence[0].excludedAssetIds.includes("marking-overlay"));
    assert.ok(markings.sourceEvidence[0].generationReferenceAssetIds.includes("marking-front"));
    assert.ok(!markings.sourceEvidence[0].generationReferenceAssetIds.includes("marking-overlay"));
    assert.equal(markings.outputSlotCount, 6);
    assert.equal(markings.ozonCalls, 0);

    const broken = await runPostgresSourceImageJourney({ fixture: duplicatesAndBroken });
    assert.equal(broken.status, "READY_FOR_REVIEW", JSON.stringify(broken));
    assert.equal(broken.terminalAssessmentCount, duplicatesAndBroken.uniqueSourceAssetCount);
    assert.deepEqual(broken.sourceEvidence[0].terminalStatusCounts, {
      ANALYZED: 3,
      DOWNLOAD_FAILED: 1,
      DUPLICATE_REUSED: 1,
      UNSUPPORTED_MEDIA: 1,
    });
    assert.deepEqual(broken.sourceEvidence[0].terminalStatusByAssetId, {
      "duplicate-corrupt": "UNSUPPORTED_MEDIA",
      "duplicate-exact": "DUPLICATE_REUSED",
      "duplicate-front": "ANALYZED",
      "duplicate-low": "ANALYZED",
      "duplicate-near": "ANALYZED",
      "duplicate-unavailable": "DOWNLOAD_FAILED",
    });
    assert.deepEqual(broken.sourceEvidence[0].perceptualDuplicateGroups["near-front"], [
      "duplicate-exact",
      "duplicate-front",
      "duplicate-near",
    ]);
    assert.equal(broken.outputSlotCount, 6);
    assert.equal(broken.ozonCalls, 0);

    const many = await runPostgresSourceImageJourney({ fixture: moreThanTenImages });
    assert.equal(many.status, "READY_FOR_REVIEW", JSON.stringify(many));
    assert.equal(many.assessmentCount, moreThanTenImages.uniqueSourceAssetCount);
    assert.equal(many.terminalAssessmentCount, moreThanTenImages.uniqueSourceAssetCount);
    assert.equal(many.analysisBatchCount, 7);
    assert.equal(many.outputSlotCount, 6);
    assert.equal(many.generatedReviewAssetCount, 6);
    assert.equal(many.ozonCalls, 0);
  });

  test("fresh PostgreSQL serializes two products through one production AI channel", {
    timeout: 120_000,
  }, async () => {
    const result = await runPostgresSourceImageJourney({ fixture: twoProductsOneChannel });

    assert.deepEqual(result.itemStatuses, ["READY_FOR_REVIEW", "READY_FOR_REVIEW"], JSON.stringify(result));
    assert.deepEqual(result.perItemAssessmentCounts, [4, 4]);
    assert.deepEqual(result.perItemTerminalAssessmentCounts, [4, 4]);
    assert.deepEqual(result.perItemOutputSlotCounts, [6, 6]);
    assert.equal(result.productionRelayPublications, 34);
    assert.equal(result.maxConcurrentChargedCallsByChannel, 1);
    assert.equal(result.ozonCalls, 0);
  });

  test("fresh PostgreSQL resumes a manual overlay exclusion through the durable reconcile outbox", {
    timeout: 120_000,
  }, async () => {
    const result = await runPostgresSourceImageJourney({
      fixture: subjectOverlayAmbiguous,
      manualDecision: true,
    });

    assert.equal(result.status, "READY_FOR_REVIEW", JSON.stringify(result));
    assert.deepEqual(result.manualDecisionEvidence, {
      decision: "EXTERNAL_OVERLAY_EXCLUDE",
      statusVersionIncrement: 1,
      parentImmutable: true,
      resultHashesReused: true,
      resumePhase: "RECONCILE_SOURCE_IMAGE_ANALYSIS",
      additionalAnalysisCalls: 0,
    });
  });

  test("fresh PostgreSQL group retry changes one accepted asset and preserves five siblings", {
    timeout: 120_000,
  }, async () => {
    const result = await runPostgresSourceImageJourney({ fixture: multiViewComplete, forceGroupRetry: true });
    assert.equal(result.status, "READY_FOR_REVIEW", JSON.stringify(result));
    assert.equal(result.groupRetryEvidence.changedAssetIds.length, 1);
    assert.notDeepEqual(
      result.groupRetryEvidence.changedAssetIds,
      result.groupRetryEvidence.previousChangedAssetIds,
    );
    assert.notDeepEqual(
      result.groupRetryEvidence.changedContentHashes,
      result.groupRetryEvidence.previousChangedContentHashes,
    );
    assert.equal(result.groupRetryEvidence.stableSiblingAssetIds.length, 5);
    assert.equal(result.groupRetryEvidence.sourceReferenceAssetIdsStable, true);
    assert.equal(result.groupRetryEvidence.groupCheckCalls, 2);
    assert.equal(result.outputSlotCount, 6);
    assert.equal(result.outputHistoryCount, 7);
    assert.equal(result.generatedReviewAssetCount, 6);
    assert.equal(result.ozonCalls, 0);
  });

  test("fresh PostgreSQL category strategy changes production style without changing source evidence", {
    timeout: 120_000,
  }, async () => {
    const result = await runPostgresSourceImageJourney({ fixture: multiViewComplete, compareCategoryStrategy: true });
    assert.deepEqual(result.itemStatuses, ["READY_FOR_REVIEW", "READY_FOR_REVIEW"], JSON.stringify(result));
    assert.equal(result.categoryStrategyEvidence.genericMatchedBy, "DEFAULT");
    assert.equal(result.categoryStrategyEvidence.styledMatchedBy, "EXACT_CATEGORY_TYPE_V2");
    assert.equal(result.categoryStrategyEvidence.planStrategyHashesMatchCaptures, true);
    assert.equal(result.categoryStrategyEvidence.sourceSummaryHashEqual, true);
    assert.equal(result.categoryStrategyEvidence.slotEvidenceEqual, true);
    assert.equal(result.categoryStrategyEvidence.styleHashChanged, true);
    assert.equal(result.categoryStrategyEvidence.promptGuidanceCount, 1);
    assert.equal(result.categoryStrategyEvidence.styledPromptMatchedBy, "EXACT_CATEGORY_TYPE_V2");
    assert.equal(result.ozonCalls, 0);
  });

  test("fresh PostgreSQL keeps both historical planning contracts outside source analysis", {
    timeout: 120_000,
  }, async () => {
    for (const planningContract of ["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"]) {
      const result = await runPostgresSourceImageJourney({ fixture: multiViewComplete, planningContract });
      assert.equal(result.status, "READY_FOR_REVIEW", JSON.stringify(result));
      assert.equal(result.historicalContractEvidence.planningContract, planningContract);
      assert.equal(result.historicalContractEvidence.analysisRunCount, 0);
      assert.equal(result.historicalContractEvidence.analysisAssessmentCount, 0);
      assert.equal(result.historicalContractEvidence.analysisOutboxCount, 0);
      assert.equal(result.historicalContractEvidence.analysisGatewayCallCount, 0);
      assert.equal(result.historicalContractEvidence.currentAnalysisRunId, null);
      assert.equal(result.historicalContractEvidence.planAnalysisRunId, null);
      assert.equal(result.historicalContractEvidence.planIntelligenceHash, null);
      if (planningContract === "LEGACY_FULL_PLAN_V3") {
        assert.equal(result.historicalContractEvidence.skeletonHash, null);
      } else {
        assert.match(result.historicalContractEvidence.skeletonHash, /^[a-f0-9]{64}$/u);
      }
      assert.equal(result.ozonCalls, 0);
    }
  });
}

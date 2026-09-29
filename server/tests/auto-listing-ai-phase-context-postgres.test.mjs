import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import sharp from "sharp";

import {
  createPostgresAutoListingAiContextLoader,
  createPostgresAutoListingAiPhaseContextLoader,
  loadImageGroupCheckInput,
  loadFrozenAutoListingPlanningInput,
  loadMaterializeAnalysisInput,
  loadSourceImageBatchInput,
  loadSourceImageCleanupCheckInput,
  loadSourceImageCleanupInput,
  loadSourceImageReconcileInput,
  projectAutoListingGenerationReferences,
} from "../auto-listing-ai-phase-context-postgres.mjs";
import { buildSourceImageAnalysisBatches } from "../auto-listing-source-image-analyzer.mjs";
import { autoListingAiMessageDedupeKey } from "../auto-listing-ai-message.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { sha256 } from "../auto-listing-asset-store.mjs";
import { deriveSourceImageCleanupAttempt } from "../auto-listing-source-image-cleanup-contract.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const H = (character) => character.repeat(64);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const PROHIBITED = ["CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY"];

function rawMessage(phase, overrides = {}) {
  const v3 = ["ANALYZE_SOURCE_IMAGE_BATCH", "CLEAN_SOURCE_IMAGE_OVERLAY",
    "CHECK_SOURCE_IMAGE_CLEANUP", "RECONCILE_SOURCE_IMAGE_ANALYSIS", "CHECK_IMAGE_GROUP"].includes(phase);
  return {
    contractVersion: v3 ? "V3" : "V1",
    accountId: "account-a",
    itemId: "item-a",
    phase,
    expectedStatusVersion: 7,
    correlationId: "correlation-a",
    ...(phase === "MATERIALIZE_SOURCE_ASSET" ? { sourceAssetId: "source-a" } : {}),
    ...(phase === "ANALYZE_SOURCE_IMAGE_BATCH" ? { analysisBatchId: "batch-a" } : {}),
    ...(["CLEAN_SOURCE_IMAGE_OVERLAY", "CHECK_SOURCE_IMAGE_CLEANUP"].includes(phase)
      ? { analysisRunId: "run-a", derivativeAttemptId: "source-image-derivative-placeholder" } : {}),
    ...(phase === "RECONCILE_SOURCE_IMAGE_ANALYSIS" ? { analysisRunId: "run-a" } : {}),
    ...(phase === "GENERATE_IMAGE_SLOT" ? { slotKey: "main-1" } : {}),
    ...(phase === "CHECK_IMAGE_GROUP" ? { visualGroupKey: "group-a" } : {}),
    ...overrides,
  };
}

function execution(overrides = {}) {
  return {
    outboxId: "outbox-a",
    dispatchGeneration: 4,
    channelId: "channel-a",
    connectionId: "connection-a",
    connectionVersion: 1,
    leaseOwner: "worker-a",
    leaseToken: "worker-token-a",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function contextRequest(phase, executionOverrides = {}) {
  return { message: rawMessage(phase), execution: execution(executionOverrides) };
}

function message(phase, overrides = {}) {
  return { message: rawMessage(phase, overrides), execution: execution() };
}

function boundary(overrides = {}) {
  return {
    job_id: "job-a",
    status: "PLANNING",
    status_version: 7,
    active_content_plan_id: null,
    snapshot_id: "snapshot-a",
    ...overrides,
  };
}

const builtSource = buildAutoListingSourceSnapshot({
  accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-a", sourceVersion: "version-a",
  targetStoreCurrency: "RUB",
  categoryEvidence: {
    id: "evidence-a", accountId: "account-a", sourceDescriptionCategoryId: 170,
    sourceTypeId: 99, taxonomyScope: "OZON:DEFAULT",
  },
  sharedCategory: {
    id: "shared-a", accountId: "account-a", version: 1, evidenceId: "evidence-a",
    status: "ACTIVE", source: "SOURCE_DIRECT", sourceDescriptionCategoryId: 170,
    sourceTypeId: 99, currentDescriptionCategoryId: 170, currentTypeId: 99,
    taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null,
  },
  collectItem: { id: "collect-a", accountId: "account-a", listingDraft: {
    sku: "sku-a", title: "商品 A", brand: "Brand A",
    blackKopecks: "8000", greenKopecks: "7000",
    categoryResolution: { status: "MATCHED", method: "taxonomy", target: { storeId: "store-a", descriptionCategoryId: "170", typeId: "99" } },
    descriptionCategoryId: "170", typeId: "99", productStyle: "UNKNOWN", currency: "RUB",
    attributes: [], logistics: { length: 10, width: 10, height: 10, dimensionUnit: "mm" },
    productMeasurements: {}, images: [{ assetId: "source-a", contentHash: H("3") }],
    variants: [{ sku: "sku-a", offerId: "offer-a", name: "商品 A", images: [{ assetId: "source-a", contentHash: H("3") }] }],
  } },
  productDraft: { id: "draft-a", version: 1 }, rawResponseRef: "raw-ref-a", rawResponseHash: "raw-hash-a",
});
const snapshot = builtSource.snapshot;
const SOURCE_HASH = builtSource.snapshotHash;

const { config: configSnapshot, configHash: CONFIG_HASH } = normalizeAndHashAutoListingConfig({
  targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 5, priceAdjustmentKopecks: "0",
  image: {
    ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru",
    roles: { main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1 },
  },
});
const { config: genericConfigSnapshot, configHash: GENERIC_CONFIG_HASH } = normalizeAndHashAutoListingConfig({
  targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 5,
  priceAdjustmentKopecks: "0", useCategoryStrategy: false,
  image: {
    ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru",
    roles: { main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1 },
  },
});

function basePlanRow(overrides = {}) {
  const slots = [
    { slotKey: "main-1", visualGroupKey: "group-a", role: "MAIN", order: 1, textDensity: "NONE", claims: [], sourceFactIds: ["fact-a"], referenceAssetIds: ["source-a"], preserve: ["商品 A"], prohibitedClaims: PROHIBITED },
    { slotKey: "sell-1", visualGroupKey: "group-a", role: "SELLING_POINT", order: 2, textDensity: "LIGHT", claims: [], sourceFactIds: ["fact-a"], referenceAssetIds: ["source-a"], preserve: ["商品 A"], prohibitedClaims: PROHIBITED },
    { slotKey: "sell-2", visualGroupKey: "group-a", role: "SELLING_POINT", order: 3, textDensity: "LIGHT", claims: [], sourceFactIds: ["fact-a"], referenceAssetIds: ["source-a"], preserve: ["商品 A"], prohibitedClaims: PROHIBITED },
    { slotKey: "detail-1", visualGroupKey: "group-a", role: "DETAIL", order: 4, textDensity: "LIGHT", claims: [], sourceFactIds: ["fact-a"], referenceAssetIds: ["source-a"], preserve: ["商品 A"], prohibitedClaims: PROHIBITED },
    { slotKey: "scene-1", visualGroupKey: "group-a", role: "SCENE", order: 5, textDensity: "LIGHT", claims: [], sourceFactIds: ["fact-a"], referenceAssetIds: ["source-a"], preserve: ["商品 A"], prohibitedClaims: PROHIBITED },
    { slotKey: "info-1", visualGroupKey: "group-a", role: "INFOGRAPHIC", order: 6, textDensity: "LIGHT", claims: [], sourceFactIds: ["fact-a"], referenceAssetIds: ["source-a"], preserve: ["商品 A"], prohibitedClaims: PROHIBITED },
  ];
  return {
    id: "plan-parent", account_id: "account-a", job_id: "job-a", item_id: "item-a",
    source_snapshot_id: "snapshot-a", strategy_version_id: "strategy-v1", profile_id: "profile-a",
    strategy_hash: H("a"), config_hash: CONFIG_HASH, source_hash: SOURCE_HASH, input_hash: H("d"),
    planner_model: "text-model", profile_version: 3, prompt_template_version: "planner-v1",
    plan: { version: 1, language: "ru", slots }, plan_hash: H("e"), visual_groups_hash: H("f"),
    visual_groups: { sourceHash: SOURCE_HASH, visualGroupsHash: H("f"), reasonCodes: [], groups: [{
      visualGroupKey: "group-a", sourceSkus: ["sku-a"], variantIds: ["variant-a"], factEvidence: [], reasonCodes: [],
      referenceImages: [{ assetId: "source-a", sourceRefHash: H("1"), contentHash: null, sourceRef: null, evidenceKind: "SOURCE_REF_HASH" }],
    }] },
    fact_registry: [{ factId: "fact-a", field: "identity.primaryName", kind: "TEXT", value: "商品 A", numericValue: null, unit: null, sourcePath: "identity.primaryName", dictionaryValueId: null, visualGroupKeys: ["group-a"] }],
    regeneration: null, gateway_request_id: "gateway-plan-a", parent_plan_id: null,
    derivation_kind: null, materialization_set_hash: null,
    planning_contract: "LEGACY_FULL_PLAN_V3", skeleton_hash: null,
    ...overrides,
  };
}

function derivedPlanRow() {
  const parent = basePlanRow();
  return {
    ...parent,
    id: "plan-derived",
    parent_plan_id: "plan-parent",
    derivation_kind: "SOURCE_MATERIALIZATION",
    materialization_set_hash: H("2"),
    visual_groups: {
      ...parent.visual_groups,
      groups: parent.visual_groups.groups.map((group) => ({
        ...group,
        referenceImages: group.referenceImages.map((entry) => ({
          ...entry, contentHash: H("3"), evidenceKind: "CONTENT_HASH",
        })),
      })),
    },
  };
}

function generationProjectionPlan() {
  const row = derivedPlanRow();
  return {
    id: row.id,
    sourceAccountId: row.account_id,
    jobId: row.job_id,
    itemId: row.item_id,
    sourceSnapshotId: row.source_snapshot_id,
    strategyVersionId: row.strategy_version_id,
    profileId: row.profile_id,
    strategyHash: row.strategy_hash,
    configHash: row.config_hash,
    sourceHash: row.source_hash,
    inputHash: row.input_hash,
    plannerModel: row.planner_model,
    profileVersion: row.profile_version,
    promptTemplateVersion: row.prompt_template_version,
    plan: structuredClone(row.plan),
    planHash: row.plan_hash,
    visualGroupsHash: row.visual_groups_hash,
    visualGroups: structuredClone(row.visual_groups),
    factRegistry: structuredClone(row.fact_registry),
    regeneration: row.regeneration,
    gatewayRequestId: row.gateway_request_id,
    planningContract: row.planning_contract,
    skeletonHash: row.skeleton_hash,
    parentPlanId: row.parent_plan_id,
    derivationKind: row.derivation_kind,
    materializationSetHash: row.materialization_set_hash,
  };
}

function multiGroupProjectionPlan() {
  const plan = generationProjectionPlan();
  const roles = ["MAIN", "SELLING_POINT", "SELLING_POINT", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"];
  const slotsFor = (visualGroupKey, assetId) => roles.map((role, index) => ({
    slotKey: `${visualGroupKey}:${role.toLowerCase().replaceAll("_", "-")}:${String(roles.slice(0, index + 1).filter((entry) => entry === role).length).padStart(2, "0")}`,
    visualGroupKey,
    role,
    order: index + 1,
    textDensity: role === "MAIN" ? "NONE" : "LIGHT",
    claims: [],
    sourceFactIds: ["fact-a"],
    referenceAssetIds: [assetId],
    preserve: ["商品 A"],
    prohibitedClaims: PROHIBITED,
  }));
  plan.plan.slots = [...slotsFor("group-a", "source-a"), ...slotsFor("group-b", "source-b")];
  plan.visualGroups.groups.push({
    ...structuredClone(plan.visualGroups.groups[0]),
    visualGroupKey: "group-b",
    sourceSkus: ["sku-b"],
    variantIds: ["variant-b"],
    referenceImages: [{
      assetId: "source-b", sourceRefHash: H("8"), contentHash: H("9"),
      sourceRef: null, evidenceKind: "CONTENT_HASH",
    }],
  });
  plan.factRegistry[0].visualGroupKeys = ["group-a", "group-b"];
  return plan;
}

const profileColumns = {
  profile_id: "profile-a", profile_account_id: "account-a", profile_config_version: 3,
  profile_base_url: "https://gateway.invalid", profile_api_key_env_name: "SUB2API_ENCRYPTED_KEY",
  profile_text_protocol: "SUB2API_RESPONSES", profile_image_protocol: "SUB2API_OPENAI_IMAGES",
  profile_text_model: "text-model", profile_image_model: "image-model", profile_enabled: false,
  profile_connection_id: "connection-a", profile_connection_version: 1,
  execution_channel_id: "channel-a", execution_connection_id: "connection-a",
  execution_connection_version: 1, execution_connection_base_url: "https://gateway.invalid",
};

function planBundle(plan = basePlanRow(), overrides = {}) {
  return {
    ...plan,
    snapshot: structuredClone(snapshot), snapshot_hash: SOURCE_HASH, raw_response_ref: "raw-ref-a",
    config_snapshot: structuredClone(configSnapshot), config_hash_from_job: CONFIG_HASH,
    strategy_key: "strategy-a", ...profileColumns, ...overrides,
  };
}

function acceptedAsset(index, plan = derivedPlanRow()) {
  const slot = plan.plan.slots[index];
  return {
    id: `asset-${index + 1}`, account_id: "account-a", job_id: "job-a", item_id: "item-a", plan_id: "plan-derived",
    visual_group_key: slot.visualGroupKey, slot_key: slot.slotKey, role: slot.role,
    attempt_identity_hash: H("4"), attempt_no: 1, input_hash: H("5"), generation_size: "768x1024",
    status: "ACCEPTED", content_hash: H("6"), object_key_version: "GENERATED_ASSET_V1",
    object_key: `generated/account-a/asset-${index + 1}.png`, content_type: "image/png", width: 768,
    height: 1024, size_bytes: 1024, gateway_request_id: `gateway-${index + 1}`,
    checker_request_id: `checker-${index + 1}`, model_evidence: { requestedImageModel: "image-model" },
    profile_id: "profile-a", profile_version: 3, model_name: "image-model", plan_hash: H("e"),
    source_hash: SOURCE_HASH, strategy_hash: H("a"), config_hash: CONFIG_HASH, visual_groups_hash: H("f"),
    prompt_template_version: "planner-v1", prompt_hash: H("7"), checker_result: { valid: true },
    source_asset_evidence: [{ assetId: "source-a", contentHash: H("3"), contentType: "image/png", width: 768, height: 1024, size: 1000 }],
    regeneration: null, expected_status_version: 7,
  };
}

function scriptedPool(steps) {
  const calls = [];
  const control = [];
  let releases = 0;
  const pool = {
    calls,
    control,
    get releases() { return releases; },
    async query(sql, values) {
      calls.push({ sql, values });
      const step = steps.shift();
      assert.ok(step, `unexpected query: ${sql}`);
      if (typeof step === "function") return step(sql, values);
      if (step instanceof Error) throw step;
      return { rows: step };
    },
    async connect() {
      return {
        async query(sql, values) {
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
            control.push(sql);
            return { rows: [] };
          }
          return pool.query(sql, values);
        },
        release() { releases += 1; },
      };
    },
  };
  return pool;
}

function dependencies(pool, overrides = {}) {
  return {
    pool,
    gateway: { name: "gateway" },
    contentPlanRepository: { name: "plan-repository" },
    contentPlanEvidenceRepository: { name: "plan-evidence-repository" },
    sourceMaterializationRepository: { name: "materialization-repository" },
    generationRepository: { name: "generation-repository" },
    richContentRepository: { name: "rich-repository" },
    downloader: { name: "downloader" }, storage: { name: "storage" },
    sourceAssetLoader: { name: "source-loader" }, logger: null,
    referenceProjector: projectAutoListingGenerationReferences,
    planPromptTemplateVersion: "planner-v1", prohibitedClaims: PROHIBITED,
    maxAttempts: 3, richContentMaxAttempts: 5, richContentLeaseOwner: "rich-worker",
    ...overrides,
  };
}

function analysisBoundary(overrides = {}) {
  return {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", status: "PLANNING",
    statusVersion: 7, activeContentPlanId: null, snapshotId: "snapshot-a",
    planningContract: "FIXED_SKELETON_SOURCE_IMAGE_V1", currentAnalysisRunId: "run-a",
    ...overrides,
  };
}

function analysisRunRow(status, overrides = {}) {
  return {
    id: "run-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
    source_snapshot_id: "snapshot-a", expected_status_version: 7,
    intelligence_contract_version: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1",
    source_snapshot_hash: SOURCE_HASH, source_asset_set_hash: H("8"), input_hash: H("9"),
    prompt_template_version: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_V1", profile_id: "profile-a",
    profile_version: 3, model_name: "text-model", expected_asset_count: 1,
    terminal_asset_count: status === "RECONCILING" || status === "ACCEPTED" ? 1 : 0,
    status, parent_run_id: null, derivation_kind: "INITIAL", summary_hash: null,
    summary: null, decision_set: [], ...overrides,
  };
}

function acceptedSourceSummary() {
  const value = {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1",
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
  return { ...value, summaryHash: hash(value) };
}

function cleanupAssessment(contentHash, overrides = {}) {
  const value = {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    sourceAssetId: "source-a", sourceOrdinal: 0,
    objectKey: "auto-listing/source/v2/account/job/item/analysis-run/run/source/input/attempt-1/output/source.png",
    contentHash, parentSourceAssetId: null, terminalStatus: "ANALYZED",
    contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [{ kind: "FRONT", confidence: "CONFIRMED", reasonCodes: [] }],
    subjectBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: [] },
    ocrRegions: [], semanticTextRegions: [],
    markings: [
      { kind: "EXTERNAL_OVERLAY", region: { x: 0.02, y: 0.02, width: 0.2, height: 0.08 }, confidence: "CONFIRMED", reasonCodes: ["FIXED_CANVAS_POSITION"] },
      { kind: "PRODUCT_MARKING", region: { x: 0.3, y: 0.3, width: 0.4, height: 0.3 }, confidence: "CONFIRMED", reasonCodes: ["SURFACE_PERSPECTIVE"] },
    ],
    perceptualDuplicateGroup: null, duplicateOfSourceAssetId: null,
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW"], reasonCodes: [],
    ...overrides,
  };
  return { ...value, assessmentHash: hash(value) };
}

function sourceImageDerivedPlanRow(summary = acceptedSourceSummary()) {
  const plan = {
    ...derivedPlanRow(), planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1", skeleton_hash: H("7"),
    source_image_analysis_run_id: "run-a", source_image_intelligence_hash: summary.summaryHash,
  };
  plan.plan = {
    ...plan.plan,
    version: 3,
    slots: plan.plan.slots.map((slot, index) => ({
      ...slot,
      requestedRole: slot.role,
      substitutionReasonCode: null,
      targetView: "FRONT",
      evidenceMode: index === 0 ? "DIRECT" : "COMPOSITION_ONLY",
      prohibitedViews: ["BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"],
      prohibitedOverlayTexts: [],
      identityAssetId: "source-a",
      selectionReasonCodes: ["SOURCE_VIEW_EVIDENCE_SELECTED", "IDENTITY_REFERENCE_SELECTED"],
    })),
  };
  return plan;
}

function publishedV2Rule(mainDensity = "NONE") {
  return {
    matchType: "EXACT_CATEGORY_TYPE_V2",
    scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99 },
    overallStyle: "clean commercial catalogue",
    prohibitedPatterns: ["avoid competitor branding"],
    roleGuidance: Object.fromEntries([
      "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
    ].map((role) => [role, {
      composition: `${role} composition`, background: `${role} background`,
      textDensity: role === "MAIN" ? mainDensity : "LIGHT", layout: `${role} layout`,
    }])),
    sampleSetHash: H("a"),
    analysisAttemptId: "category-analysis-attempt-a",
    analysisResultId: "category-analysis-result-a",
  };
}

test("factory alias is stable and rejects non-closed messages before querying", async () => {
  assert.equal(createPostgresAutoListingAiContextLoader, createPostgresAutoListingAiPhaseContextLoader);
  const pool = scriptedPool([]);
  const loadContext = createPostgresAutoListingAiPhaseContextLoader(dependencies(pool));
  await assert.rejects(loadContext({ ...message("PLAN_CONTENT"), extra: true }), {
    code: "AUTO_LISTING_AI_PHASE_CONTEXT_INVALID", retryable: false,
  });
  assert.equal(pool.calls.length, 0);
  assert.throws(() => createPostgresAutoListingAiPhaseContextLoader({
    ...dependencies(pool),
    gatewayProfile: { id: "profile-global-must-not-win", configVersion: 99 },
  }), { code: "AUTO_LISTING_AI_PHASE_CONTEXT_INVALID", retryable: false });
});

test("first query is account+item scoped and a cross-account miss closes without later reads", async () => {
  const pool = scriptedPool([[]]);
  const loadContext = createPostgresAutoListingAiPhaseContextLoader(dependencies(pool));
  assert.equal(await loadContext(message("PLAN_CONTENT", { accountId: "account-b" })), null);
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].values, ["account-b", "item-a"]);
  assert.match(pool.calls[0].sql, /WHERE\s+i\.account_id=\$1\s+AND\s+i\.id=\$2/iu);
  assert.match(pool.calls[0].sql, /FOR SHARE/iu);
});

test("stale and CANCELLED rows return only the minimal closed context with zero phase reads", async () => {
  for (const row of [boundary({ status_version: 8 }), boundary({ status: "CANCELLED" })]) {
    const pool = scriptedPool([[row]]);
    const loadContext = createPostgresAutoListingAiPhaseContextLoader(dependencies(pool));
    assert.deepEqual(await loadContext(message("PLAN_CONTENT")), {
      accountId: "account-a", jobId: "job-a", itemId: "item-a", status: row.status,
      statusVersion: row.status_version, activeContentPlanId: null, phaseInput: {},
    });
    assert.equal(pool.calls.length, 1);
    assert.deepEqual(pool.control, ["BEGIN", "COMMIT"]);
    assert.equal(pool.releases, 1);
  }
});

test("source-image phase loaders bind the exact current run, target, snapshot and charged execution", async () => {
  const intelligenceRepository = { name: "intelligence-repository" };
  const analysisAssetLoader = { name: "analysis-asset-loader" };
  const checker = async () => null;
  const commonOverrides = { sourceImageIntelligenceRepository: intelligenceRepository,
    sourceAnalysisAssetLoader: analysisAssetLoader, imageGroupChecker: checker };

  const materializePool = scriptedPool([
    [analysisRunRow("MATERIALIZING")],
    [{ snapshot: structuredClone(snapshot), snapshot_hash: SOURCE_HASH, raw_response_ref: "raw-ref-a" }],
  ]);
  const materialize = await loadMaterializeAnalysisInput(
    dependencies(materializePool, commonOverrides), rawMessage("MATERIALIZE_SOURCE_ASSET"), analysisBoundary(),
    { attemptNo: 3, maxAttempts: 3 },
  );
  assert.equal(materialize.analysisRun.id, "run-a");
  assert.equal(materialize.sourceAsset.sourceAssetId, "source-a");
  assert.equal(materialize.intelligenceRepository, intelligenceRepository);
  assert.deepEqual(materialize.execution, { attemptNo: 3, maxAttempts: 3 });

  const materialized = {
    sourceAssetId: "source-a", sourceOrdinal: 0, sizeBytes: 1024, contentHash: H("3"),
    objectKey: "source-images/account-a/source-a.webp", contentType: "image/webp",
  };
  const [batch] = buildSourceImageAnalysisBatches({ materializedAssets: [materialized], terminalAssessments: [] });
  const batchPool = scriptedPool([
    [analysisRunRow("ANALYZING")],
    [{
      source_asset_id: materialized.sourceAssetId, source_ordinal: 0, record_status: "MATERIALIZED",
      object_key: materialized.objectKey, content_hash: materialized.contentHash,
      content_type: materialized.contentType, size_bytes: 1024, terminal_status: null,
      analysis_batch_id: null, input_hash: null, result_hash: null, assessment: null, error_code: null,
    }],
    [{ ...profileColumns }],
  ]);
  const batchInput = await loadSourceImageBatchInput(
    dependencies(batchPool, commonOverrides),
    rawMessage("ANALYZE_SOURCE_IMAGE_BATCH", { analysisBatchId: batch.analysisBatchId }),
    analysisBoundary(), execution(),
  );
  assert.equal(batchInput.batch.analysisBatchId, batch.analysisBatchId);
  assert.equal(batchInput.sourceAssetLoader, analysisAssetLoader);
  assert.deepEqual(batchInput.gatewayExecution, {
    channelId: "channel-a", connectionId: "connection-a", connectionVersion: 1, idleTimeoutMs: 300_000,
  });

  const reconcilePool = scriptedPool([
    [analysisRunRow("RECONCILING")],
    [{
      source_asset_id: "source-a", source_ordinal: 0, record_status: "ACCEPTED",
      object_key: materialized.objectKey, content_hash: materialized.contentHash,
      content_type: materialized.contentType, size_bytes: 1024, terminal_status: "ANALYZED",
      analysis_batch_id: batch.analysisBatchId, input_hash: H("4"), result_hash: H("5"),
      assessment: { sourceAssetId: "source-a" }, error_code: null,
    }],
    [{ snapshot: structuredClone(snapshot), snapshot_hash: SOURCE_HASH, raw_response_ref: "raw-ref-a" }],
  ]);
  const reconcile = await loadSourceImageReconcileInput(
    dependencies(reconcilePool, commonOverrides), rawMessage("RECONCILE_SOURCE_IMAGE_ANALYSIS"), analysisBoundary(),
  );
  assert.equal(reconcile.run.status, "RECONCILING");
  assert.equal(reconcile.assessments[0].resultHash, H("5"));
  assert.match(reconcile.summaryInputHash, /^[a-f0-9]{64}$/u);
  assert.equal(reconcile.repository, intelligenceRepository);
});

test("cleanup phase loaders rebuild trusted regions, retry reasons and image bytes from durable evidence", async () => {
  const originalBytes = await sharp({
    create: { width: 24, height: 32, channels: 3, background: { r: 240, g: 20, b: 20 } },
  }).png().toBuffer();
  const candidateBytes = await sharp({
    create: { width: 24, height: 32, channels: 3, background: { r: 230, g: 30, b: 30 } },
  }).png().toBuffer();
  const originalContentHash = sha256(originalBytes);
  const candidateContentHash = sha256(candidateBytes);
  const assessment = cleanupAssessment(originalContentHash);
  const runOverrides = {
    intelligence_contract_version: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    prompt_template_version: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_V2",
  };
  const cleanupAttempt = deriveSourceImageCleanupAttempt({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "run-a",
    expectedStatusVersion: 7, assessment, attemptNo: 2,
    previousReasonCodes: ["OVERLAY_REMAINS"],
  });
  const generatedAttempt = {
    ...deriveSourceImageCleanupAttempt({
      accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "run-a",
      expectedStatusVersion: 7, assessment, attemptNo: 1, previousReasonCodes: [],
    }),
    status: "GENERATED",
    generatedObjectKey: "auto-listing/source-derivative/v1/account/job/item/run/source/input/attempt-1/candidate.png",
    generatedContentHash: candidateContentHash,
    generatedContentType: "image/png",
    generatedWidth: 24,
    generatedHeight: 32,
    generatedSizeBytes: candidateBytes.length,
  };
  const evidenceRow = (attempt, previous = null) => ({
    source_asset_id: "source-a", source_ordinal: 0, record_status: "ACCEPTED",
    object_key: assessment.objectKey, content_hash: originalContentHash,
    content_type: "image/png", size_bytes: originalBytes.length, terminal_status: "ANALYZED",
    assessment: structuredClone(assessment), derivative_attempt_no: attempt.attemptNo,
    previous_status: previous?.status ?? null,
    previous_check_result: previous?.checkResult ?? null,
  });
  const sourceAssetLoader = {
    async loadSourceAsset({ scope, run, materializedAsset }) {
      assert.deepEqual(scope, {
        accountId: "account-a", jobId: "job-a", itemId: "item-a", expectedStatusVersion: 7,
      });
      assert.equal(run.id, "run-a");
      assert.equal(materializedAsset.sourceAssetId, "source-a");
      return { bytes: Buffer.from(originalBytes), contentType: "image/png" };
    },
  };
  const cleanRepository = {
    async loadAttempt(scope) {
      assert.equal(scope.derivativeAttemptId, cleanupAttempt.derivativeAttemptId);
      return { ...cleanupAttempt, status: "RESERVED" };
    },
  };
  const cleanPool = scriptedPool([
    [analysisRunRow("RECONCILING", runOverrides)],
    [evidenceRow(cleanupAttempt, {
      status: "REJECTED", checkResult: { reasonCodes: ["OVERLAY_REMAINS"] },
    })],
    [{ ...profileColumns }],
  ]);
  const cleanInput = await loadSourceImageCleanupInput(dependencies(cleanPool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: sourceAssetLoader,
    sourceImageDerivativeRepository: cleanRepository, imageGroupChecker: async () => null,
  }), rawMessage("CLEAN_SOURCE_IMAGE_OVERLAY", {
    derivativeAttemptId: cleanupAttempt.derivativeAttemptId,
  }), analysisBoundary(), execution());
  assert.deepEqual(cleanInput.cleanupInput, cleanupAttempt.cleanupInput);
  assert.equal(cleanInput.attempt.status, "RESERVED");
  assert.equal(cleanInput.original.contentHash, originalContentHash);
  assert.deepEqual([cleanInput.original.width, cleanInput.original.height], [24, 32]);
  assert.equal(cleanInput.repository, cleanRepository);
  assert.equal(cleanInput.cleanupRecorder, null);
  assert.deepEqual(cleanInput.gatewayExecution, {
    channelId: "channel-a", connectionId: "connection-a", connectionVersion: 1, idleTimeoutMs: 300_000,
  });

  const checkRepository = {
    async loadAttempt(scope) {
      assert.equal(scope.derivativeAttemptId, generatedAttempt.derivativeAttemptId);
      return structuredClone(generatedAttempt);
    },
  };
  const checkPool = scriptedPool([
    [analysisRunRow("RECONCILING", runOverrides)],
    [evidenceRow(generatedAttempt)],
    [{ ...profileColumns }],
  ]);
  const checkInput = await loadSourceImageCleanupCheckInput(dependencies(checkPool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: sourceAssetLoader,
    sourceImageDerivativeRepository: checkRepository,
    storage: { async getObjectBuffer(key) {
      assert.equal(key, generatedAttempt.generatedObjectKey);
      return Buffer.from(candidateBytes);
    } },
    imageGroupChecker: async () => null,
  }), rawMessage("CHECK_SOURCE_IMAGE_CLEANUP", {
    derivativeAttemptId: generatedAttempt.derivativeAttemptId,
  }), analysisBoundary(), execution());
  assert.equal(checkInput.attempt.status, "GENERATED");
  assert.equal(checkInput.original.contentHash, originalContentHash);
  assert.equal(checkInput.candidate.contentHash, candidateContentHash);
  assert.deepEqual([checkInput.candidate.width, checkInput.candidate.height], [24, 32]);
  assert.equal(checkInput.repository, checkRepository);
});

test("source-image batch loader preserves immutable batches under production dedupe order and accepted replay", async () => {
  const intelligenceRepository = { name: "intelligence-repository" };
  const analysisAssetLoader = { name: "analysis-asset-loader" };
  const commonOverrides = {
    sourceImageIntelligenceRepository: intelligenceRepository,
    sourceAnalysisAssetLoader: analysisAssetLoader,
    imageGroupChecker: async () => null,
  };
  const mebibyte = 1024 * 1024;
  const sizes = [8, 8, 8, 6, 3, 7, 7, 7, 7, 2];
  const assets = sizes.map((size, index) => ({
    sourceAssetId: `s16-${index}`, sourceOrdinal: index, sizeBytes: size * mebibyte,
    contentHash: H(String((index % 9) + 1)),
    objectKey: `source-images/account-a/s16-${index}.webp`, contentType: "image/webp",
  }));
  const batches = buildSourceImageAnalysisBatches({ materializedAssets: assets, terminalAssessments: [] });
  assert.deepEqual(batches.map(({ assets: batchAssets, aggregateBytes }) => [
    batchAssets.length, aggregateBytes / mebibyte,
  ]), [[2, 16], [2, 14], [2, 10], [2, 14], [2, 9]]);

  const messages = batches.map(({ analysisBatchId }) => rawMessage("ANALYZE_SOURCE_IMAGE_BATCH", { analysisBatchId }));
  const productionOrder = [...messages].sort((left, right) => autoListingAiMessageDedupeKey(left)
    .localeCompare(autoListingAiMessageDedupeKey(right)));
  assert.deepEqual(productionOrder.map(({ analysisBatchId }) => batches
    .findIndex((batch) => batch.analysisBatchId === analysisBatchId) + 1), [5, 3, 1, 4, 2]);

  const rowFor = (asset, acceptedBatchIndexes) => {
    const batchIndex = batches.findIndex(({ assets: batchAssets }) => batchAssets
      .some(({ sourceAssetId }) => sourceAssetId === asset.sourceAssetId));
    const accepted = acceptedBatchIndexes.includes(batchIndex);
    return {
      source_asset_id: asset.sourceAssetId, source_ordinal: asset.sourceOrdinal,
      record_status: accepted ? "ACCEPTED" : "MATERIALIZED", object_key: asset.objectKey,
      content_hash: asset.contentHash, content_type: asset.contentType, size_bytes: asset.sizeBytes,
      terminal_status: accepted ? "ANALYZED" : null,
      analysis_batch_id: accepted ? batches[batchIndex].analysisBatchId : null,
      input_hash: accepted ? H(String(batchIndex + 4)) : null,
      result_hash: accepted ? H(String(batchIndex + 7)) : null,
      assessment: accepted ? { sourceAssetId: asset.sourceAssetId } : null, error_code: null,
    };
  };
  const cases = [
    { message: productionOrder[0], accepted: [], status: "ANALYZING" },
    { message: productionOrder[0], accepted: [4], status: "ANALYZING" },
    { message: productionOrder[1], accepted: [4], status: "ANALYZING" },
    { message: productionOrder[2], accepted: [4, 2], status: "ANALYZING" },
    { message: productionOrder[3], accepted: [4, 2, 0], status: "ANALYZING" },
    { message: productionOrder[4], accepted: [4, 2, 0, 3], status: "ANALYZING" },
    { message: productionOrder[4], accepted: [0, 1, 2, 3, 4], status: "RECONCILING" },
  ];
  for (const fixture of cases) {
    const pool = scriptedPool([
      [analysisRunRow(fixture.status, {
        expected_asset_count: assets.length,
        terminal_asset_count: fixture.accepted.reduce((total, index) => total + batches[index].assets.length, 0),
      })],
      assets.map((asset) => rowFor(asset, fixture.accepted)),
      [{ ...profileColumns }],
    ]);
    const loaded = await loadSourceImageBatchInput(dependencies(pool, commonOverrides), fixture.message,
      analysisBoundary(), execution());
    const expected = batches.find(({ analysisBatchId }) => analysisBatchId === fixture.message.analysisBatchId);
    assert.equal(loaded.batch.analysisBatchId, expected.analysisBatchId);
    assert.deepEqual(loaded.batch.assets.map(({ sourceAssetId }) => sourceAssetId),
      expected.assets.map(({ sourceAssetId }) => sourceAssetId));
  }
});

test("source-image reconcile loader safely replays after accepted or confirmation persistence", async () => {
  const materialized = {
    sourceAssetId: "source-a", sourceOrdinal: 0, sizeBytes: 1024, contentHash: H("3"),
    objectKey: "source-images/account-a/source-a.webp", contentType: "image/webp",
  };
  const [batch] = buildSourceImageAnalysisBatches({ materializedAssets: [materialized], terminalAssessments: [] });
  for (const status of ["ACCEPTED", "CONFIRMATION_REQUIRED"]) {
    const summaryHash = status === "ACCEPTED" ? H("6") : H("7");
    const pool = scriptedPool([
      [analysisRunRow(status, {
        terminal_asset_count: 1, summary_hash: summaryHash,
        summary: { summaryHash, requiredConfirmations: status === "ACCEPTED" ? [] : [{ id: "confirmation-a" }] },
      })],
      [{
        source_asset_id: materialized.sourceAssetId, source_ordinal: 0, record_status: "ACCEPTED",
        object_key: materialized.objectKey, content_hash: materialized.contentHash,
        content_type: materialized.contentType, size_bytes: materialized.sizeBytes, terminal_status: "ANALYZED",
        analysis_batch_id: batch.analysisBatchId, input_hash: H("4"), result_hash: H("5"),
        assessment: { sourceAssetId: materialized.sourceAssetId }, error_code: null,
      }],
      [{ snapshot: structuredClone(snapshot), snapshot_hash: SOURCE_HASH, raw_response_ref: "raw-ref-a" }],
    ]);
    const loaded = await loadSourceImageReconcileInput(dependencies(pool, {
      sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {}, imageGroupChecker: async () => null,
    }), rawMessage("RECONCILE_SOURCE_IMAGE_ANALYSIS"), analysisBoundary());
    assert.equal(loaded.run.status, status);
    assert.equal(loaded.assessments[0].sourceAssetId, "source-a");
  }
});

test("V2 reconcile loader includes only repository-accepted derivative bindings in its immutable input hash", async () => {
  const binding = {
    sourceAssetId: "source-a", mode: "CLEANED", effectiveContentHash: H("6"),
    derivativeAttemptId: "derivative-a", cleanupEvidenceHash: H("7"),
  };
  const calls = [];
  const derivativeRepository = {
    async listAcceptedBindings(input) { calls.push(input); return [binding]; },
  };
  const pool = scriptedPool([
    [analysisRunRow("RECONCILING", {
      intelligence_contract_version: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
      prompt_template_version: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_V2",
    })],
    [{
      source_asset_id: "source-a", source_ordinal: 0, record_status: "ACCEPTED",
      object_key: "source-images/account-a/source-a.webp", content_hash: H("3"),
      content_type: "image/webp", size_bytes: 1024, terminal_status: "ANALYZED",
      analysis_batch_id: "batch-a", input_hash: H("4"), result_hash: H("5"),
      assessment: { sourceAssetId: "source-a" }, error_code: null,
    }],
    [{ snapshot: structuredClone(snapshot), snapshot_hash: SOURCE_HASH, raw_response_ref: "raw-ref-a" }],
  ]);

  const loaded = await loadSourceImageReconcileInput(dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceImageDerivativeRepository: derivativeRepository,
    sourceAnalysisAssetLoader: {}, imageGroupChecker: async () => null,
  }), rawMessage("RECONCILE_SOURCE_IMAGE_ANALYSIS"), analysisBoundary());

  assert.deepEqual(loaded.acceptedDerivativeBindings, [binding]);
  assert.deepEqual(calls, [{
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "run-a",
  }]);
  const withoutBindingHash = hash({
    runInputHash: loaded.run.inputHash,
    assessmentHashes: [{ sourceAssetId: "source-a", resultHash: H("5") }],
    decisions: [], acceptedDerivativeBindings: [],
  });
  assert.notEqual(loaded.summaryInputHash, withoutBindingHash);
});

test("V2 reconcile loader inherits the nearest accepted derivative across a manual-decision run", async () => {
  const inherited = {
    sourceAssetId: "source-a", mode: "CLEANED", effectiveContentHash: H("6"),
    derivativeAttemptId: "derivative-parent", cleanupEvidenceHash: H("7"),
  };
  const calls = [];
  const derivativeRepository = {
    async listAcceptedBindings(input) {
      calls.push(input.analysisRunId);
      return input.analysisRunId === "run-parent" ? [inherited] : [];
    },
  };
  const pool = scriptedPool([
    [analysisRunRow("RECONCILING", {
      intelligence_contract_version: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
      prompt_template_version: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_V2",
      parent_run_id: "run-parent", derivation_kind: "MANUAL_DECISION",
      decision_set: [{ sourceAssetId: "source-a", decision: "PRODUCT_MARKING", decisionHash: H("2") }],
    })],
    [{
      source_asset_id: "source-a", source_ordinal: 0, record_status: "ACCEPTED",
      object_key: "source-images/account-a/source-a.webp", content_hash: H("3"),
      content_type: "image/webp", size_bytes: 1024, terminal_status: "ANALYZED",
      analysis_batch_id: "batch-a", input_hash: H("4"), result_hash: H("5"),
      assessment: { sourceAssetId: "source-a" }, error_code: null,
    }],
    [{ id: "run-parent", parent_run_id: null, depth: 1 }],
    [{ snapshot: structuredClone(snapshot), snapshot_hash: SOURCE_HASH, raw_response_ref: "raw-ref-a" }],
  ]);

  const loaded = await loadSourceImageReconcileInput(dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceImageDerivativeRepository: derivativeRepository,
    sourceAnalysisAssetLoader: {}, imageGroupChecker: async () => null,
  }), rawMessage("RECONCILE_SOURCE_IMAGE_ANALYSIS"), analysisBoundary());

  assert.deepEqual(calls, ["run-a", "run-parent"]);
  assert.deepEqual(loaded.acceptedDerivativeBindings, [inherited]);
});

test("source-image planning refuses the current run before its accepted summary", async () => {
  const pool = scriptedPool([
    [boundary({ planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1", current_source_image_analysis_run_id: "run-a" })],
    [planBundle(undefined, {
      id: undefined, account_id: undefined, job_id: undefined, item_id: undefined,
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    })],
    [],
    [analysisRunRow("RECONCILING")],
  ]);
  await assert.rejects(createPostgresAutoListingAiPhaseContextLoader(dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {}, imageGroupChecker: async () => null,
  }))(message("PLAN_CONTENT", { contractVersion: "V3" })), {
    code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false,
  });
  assert.equal(pool.calls.some(({ sql }) => /buildVisualGroups/iu.test(sql)), false);
});

test("frozen diagnostic planning reuses the accepted current summary from the earlier planning version", async () => {
  const summary = acceptedSourceSummary();
  const pool = scriptedPool([
    [planBundle(undefined, {
      id: undefined, account_id: undefined, job_id: undefined, item_id: undefined,
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    })],
    [],
    [analysisRunRow("ACCEPTED", {
      expected_status_version: 7, summary_hash: summary.summaryHash, summary,
    })],
  ]);
  const loaded = await loadFrozenAutoListingPlanningInput(dependencies(pool), analysisBoundary({
    status: "BLOCKED", statusVersion: 8,
  }));
  assert.equal(loaded.sourceImageAnalysisRun.id, "run-a");
  assert.equal(loaded.sourceImageIntelligenceSummary.summaryHash, summary.summaryHash);
  assert.match(pool.calls[2].sql, /expected_status_version<=\$5/iu);
});

test("retried source-image planning reuses the accepted current summary from an earlier status version", async () => {
  const summary = acceptedSourceSummary();
  const pool = scriptedPool([
    [boundary({
      status: "PLANNING",
      status_version: 8,
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-a",
    })],
    [planBundle(undefined, {
      id: undefined, account_id: undefined, job_id: undefined, item_id: undefined,
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    })],
    [],
    [analysisRunRow("ACCEPTED", {
      expected_status_version: 7, summary_hash: summary.summaryHash, summary,
    })],
  ]);

  const loaded = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {}, imageGroupChecker: async () => null,
  }))(message("PLAN_CONTENT", { contractVersion: "V3", expectedStatusVersion: 8 }));

  assert.equal(loaded.phaseInput.sourceImageAnalysisRun.expectedStatusVersion, 7);
  assert.equal(loaded.phaseInput.sourceImageIntelligenceSummary.summaryHash, summary.summaryHash);
  assert.match(pool.calls[3].sql, /expected_status_version<=\$5/iu);
});

test("image-group loader binds accepted assets to the accepted current summary and injected checker", async () => {
  const summary = acceptedSourceSummary();
  const checker = async () => null;
  const repository = { name: "image-group-check-repository" };
  const sourcePlan = sourceImageDerivedPlanRow(summary);
  let storageReads = 0;
  const pool = scriptedPool([
    [planBundle(sourcePlan)],
    [analysisRunRow("ACCEPTED", { summary_hash: summary.summaryHash, summary })],
    sourcePlan.plan.slots.map((unused, index) => acceptedAsset(index, sourcePlan)),
    [],
  ]);
  const loaded = await loadImageGroupCheckInput(dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {}, imageGroupChecker: checker,
    imageGroupCheckRepository: repository,
    storage: { async getObjectBuffer() { storageReads += 1; throw new Error("must stay outside transaction"); } },
  }), rawMessage("CHECK_IMAGE_GROUP"), analysisBoundary({
    status: "GENERATING", activeContentPlanId: "plan-derived",
  }), execution());
  assert.equal(loaded.checker, checker);
  assert.equal(loaded.repository, repository);
  assert.equal(loaded.gateway.name, "gateway");
  assert.equal(loaded.gatewayProfile.id, "profile-a");
  assert.equal(loaded.sourceImageIntelligence.summaryHash, summary.summaryHash);
  assert.equal(loaded.analysisRun.id, "run-a");
  assert.equal(loaded.acceptedAssets.length, 6);
  assert.deepEqual(loaded.frozenAcceptedSlotKeys, []);
  assert.equal(loaded.acceptedAssets.every(({ visualGroupKey }) => visualGroupKey === "group-a"), true);
  assert.equal(storageReads, 0);
  assert.deepEqual(Object.keys(loaded).sort(), [
    "acceptedAssets", "analysisRun", "checker", "frozenAcceptedSlotKeys", "gateway", "gatewayExecution",
    "gatewayProfile", "plan", "repository", "sourceImageIntelligence",
  ].sort());
  assert.match(pool.calls[2].sql, /SELECT DISTINCT ON \(asset\.slot_key\)/iu);
  assert.match(pool.calls[2].sql,
    /FROM \(\s*SELECT DISTINCT ON \(asset\.slot_key\)[\s\S]*\) AS ranked\s+WHERE ranked\.status='ACCEPTED'/iu);
  assert.match(pool.calls[2].sql, /asset\.expected_status_version<=\$5/iu);
  assert.match(pool.calls[2].sql,
    /ORDER BY asset\.slot_key ASC,asset\.expected_status_version DESC NULLS LAST,\s*asset\.created_at DESC,asset\.attempt_no DESC/iu);
  assert.doesNotMatch(pool.calls[2].sql, /ORDER BY[\s\S]*asset\.accepted_at DESC/iu);
  assert.match(pool.calls[2].sql,
    /NOT EXISTS \(\s*SELECT 1\s+FROM auto_listing_events AS skipped[\s\S]*skipped\.event_type='AI_IMAGE_SLOT_SKIPPED'/iu,
    "a valid same/newer skip must be able to supersede an older accepted slot");
  assert.match(pool.calls[2].sql,
    /\(skipped\.details->>'statusVersion'\)::BIGINT>=ranked\.expected_status_version[\s\S]*\(skipped\.details->>'statusVersion'\)::BIGINT<=\$5/iu);
  assert.match(pool.calls[2].sql, /skipped\.created_at>=ranked\.asset_created_at/iu,
    "an earlier skip must not supersede a replacement accepted later");
  assert.deepEqual(pool.calls[2].values, ["account-a", "job-a", "item-a", "plan-derived", 7]);
});

test("image-group recovery freezes only unchanged slots accepted by the previous group check", async () => {
  const summary = acceptedSourceSummary();
  const sourcePlan = sourceImageDerivedPlanRow(summary);
  const currentAssets = sourcePlan.plan.slots.map((unused, index) => ({
    ...acceptedAsset(index, sourcePlan),
    expected_status_version: index === 2 ? 9 : 7,
  }));
  const previousAcceptedSlotKeys = sourcePlan.plan.slots
    .map(({ slotKey }) => slotKey)
    .filter((slotKey) => slotKey !== sourcePlan.plan.slots[2].slotKey);
  const pool = scriptedPool([
    [planBundle(sourcePlan)],
    [analysisRunRow("ACCEPTED", {
      expected_status_version: 7, summary_hash: summary.summaryHash, summary,
    })],
    currentAssets,
    [{
      expected_status_version: 8,
      status: "REJECTED",
      result: {
        acceptedSlotKeys: previousAcceptedSlotKeys,
        retrySlotKeys: [sourcePlan.plan.slots[2].slotKey],
      },
    }],
  ]);

  const loaded = await loadImageGroupCheckInput(dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {},
    imageGroupChecker: async () => null, imageGroupCheckRepository: {},
  }), rawMessage("CHECK_IMAGE_GROUP", { expectedStatusVersion: 9 }), analysisBoundary({
    status: "GENERATING", statusVersion: 9, activeContentPlanId: "plan-derived",
  }), execution());

  assert.deepEqual(loaded.frozenAcceptedSlotKeys, [...previousAcceptedSlotKeys].sort());
  assert.match(pool.calls[3].sql, /FROM auto_listing_image_group_checks/iu);
  assert.match(pool.calls[3].sql, /expected_status_version<\$6/iu);
  assert.deepEqual(pool.calls[3].values, [
    "account-a", "job-a", "item-a", "plan-derived", "group-a", 9,
  ]);
});

test("a malformed historical group result cannot block a current group check", async () => {
  const summary = acceptedSourceSummary();
  const sourcePlan = sourceImageDerivedPlanRow(summary);
  const pool = scriptedPool([
    [planBundle(sourcePlan)],
    [analysisRunRow("ACCEPTED", {
      expected_status_version: 7, summary_hash: summary.summaryHash, summary,
    })],
    sourcePlan.plan.slots.map((unused, index) => acceptedAsset(index, sourcePlan)),
    [{ expected_status_version: 6, status: "REJECTED", result: "legacy-invalid-json" }],
  ]);

  const loaded = await loadImageGroupCheckInput(dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {},
    imageGroupChecker: async () => null, imageGroupCheckRepository: {},
  }), rawMessage("CHECK_IMAGE_GROUP"), analysisBoundary({
    status: "GENERATING", activeContentPlanId: "plan-derived",
  }), execution());

  assert.deepEqual(loaded.frozenAcceptedSlotKeys, []);
  assert.equal(loaded.acceptedAssets.length, 6);
});

test("image-group loader binds an accepted immutable parent run across the finalize status-version advance", async () => {
  const summary = acceptedSourceSummary();
  const checker = async () => null;
  const sourcePlan = sourceImageDerivedPlanRow(summary);
  const laterBoundary = analysisBoundary({
    status: "GENERATING", statusVersion: 8, activeContentPlanId: "plan-derived",
  });
  const laterMessage = rawMessage("CHECK_IMAGE_GROUP", { expectedStatusVersion: 8 });
  const options = (pool) => dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {}, imageGroupChecker: checker,
    imageGroupCheckRepository: {},
  });
  const acceptedParent = analysisRunRow("ACCEPTED", {
    expected_status_version: 7, summary_hash: summary.summaryHash, summary,
  });

  const happyPool = scriptedPool([
    [planBundle(sourcePlan)], [acceptedParent],
    sourcePlan.plan.slots.map((unused, index) => acceptedAsset(index, sourcePlan)),
    [],
  ]);
  const loaded = await loadImageGroupCheckInput(options(happyPool), laterMessage, laterBoundary, execution());
  assert.equal(loaded.analysisRun.expectedStatusVersion, 7);
  assert.equal(loaded.analysisRun.id, laterBoundary.currentAnalysisRunId);
  assert.equal(loaded.analysisRun.summaryHash, sourcePlan.source_image_intelligence_hash);
  assert.deepEqual(loaded.gatewayExecution, {
    channelId: "channel-a", connectionId: "connection-a", connectionVersion: 1, idleTimeoutMs: 300_000,
  });
  assert.match(happyPool.calls[1].sql, /expected_status_version<=\$5/iu);

  for (const fixture of [
    { boundary: { currentAnalysisRunId: "run-other" }, run: acceptedParent },
    { run: { ...acceptedParent, expected_status_version: 9 } },
    { run: { ...acceptedParent, status: "RECONCILING" } },
    { run: { ...acceptedParent, summary_hash: H("5"), summary: { ...summary, summaryHash: H("5") } } },
    { run: { ...acceptedParent, account_id: "account-b" } },
  ]) {
    const pool = scriptedPool([[planBundle(sourcePlan)], [fixture.run]]);
    await assert.rejects(loadImageGroupCheckInput(options(pool), laterMessage, {
      ...laterBoundary, ...fixture.boundary,
    }, execution()), { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false });
    assert.equal(pool.calls.some(({ sql }) => /FROM ai_generation_assets AS asset/iu.test(sql)), false);
  }
});

test("image-group loader requires exact durable skipped evidence for optional target slots", async () => {
  const summary = acceptedSourceSummary();
  const checker = async () => null;
  const sourcePlan = sourceImageDerivedPlanRow(summary);
  sourcePlan.plan.slots.push({
    ...structuredClone(sourcePlan.plan.slots[5]),
    slotKey: "optional-detail-2",
    role: "DETAIL",
    order: 7,
  });
  const currentBoundary = analysisBoundary({
    status: "GENERATING", statusVersion: 8, activeContentPlanId: "plan-derived",
  });
  const currentMessage = rawMessage("CHECK_IMAGE_GROUP", { expectedStatusVersion: 8 });
  const acceptedParent = analysisRunRow("ACCEPTED", {
    expected_status_version: 7, summary_hash: summary.summaryHash, summary,
  });
  const accepted = sourcePlan.plan.slots.slice(0, 6)
    .map((unused, index) => acceptedAsset(index, sourcePlan));
  const skipped = (overrides = {}) => ({
    account_id: "account-a",
    job_id: "job-a",
    item_id: "item-a",
    plan_id: "plan-derived",
    slot_key: "optional-detail-2",
    status_version: "8",
    ...overrides,
  });
  const options = (pool) => dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {}, imageGroupChecker: checker,
    imageGroupCheckRepository: {},
  });

  const happyPool = scriptedPool([
    [planBundle(sourcePlan)], [acceptedParent], accepted, [skipped()], [],
  ]);
  const loaded = await loadImageGroupCheckInput(
    options(happyPool), currentMessage, currentBoundary, execution(),
  );
  assert.equal(loaded.acceptedAssets.length, 6);
  assert.equal(loaded.acceptedAssets.some(({ slotKey }) => slotKey === "optional-detail-2"), false);
  assert.equal(happyPool.calls.length, 5);
  assert.match(happyPool.calls[3].sql, /event_type='AI_IMAGE_SLOT_SKIPPED'/iu);
  assert.match(happyPool.calls[3].sql, /details->>'planId'=\$4/iu);
  assert.match(happyPool.calls[3].sql, /details->>'slotKey'=ANY\(\$6::TEXT\[\]\)/iu);
  assert.deepEqual(happyPool.calls[3].values, [
    "account-a", "job-a", "item-a", "plan-derived", 8, ["optional-detail-2"],
  ]);

  for (const rows of [
    [],
    [skipped({ status_version: "9" })],
    [skipped({ account_id: "account-b" })],
    [skipped({ plan_id: "plan-other" })],
    [skipped({ slot_key: "main-1" })],
  ]) {
    const pool = scriptedPool([[planBundle(sourcePlan)], [acceptedParent], accepted, rows]);
    await assert.rejects(loadImageGroupCheckInput(
      options(pool), currentMessage, currentBoundary, execution(),
    ), { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false });
  }

  const allAcceptedPool = scriptedPool([
    [planBundle(sourcePlan)], [acceptedParent],
    sourcePlan.plan.slots.map((unused, index) => acceptedAsset(index, sourcePlan)),
    [],
  ]);
  const allAccepted = await loadImageGroupCheckInput(
    options(allAcceptedPool), currentMessage, currentBoundary, execution(),
  );
  assert.equal(allAccepted.acceptedAssets.length, 7);
  assert.equal(allAcceptedPool.calls.length, 4);
});

test("a rejected group gives only its named replacement slot a fresh QUALITY_RETRY lineage", async () => {
  const summary = acceptedSourceSummary();
  const sourcePlan = sourceImageDerivedPlanRow(summary);
  const acceptedRun = analysisRunRow("ACCEPTED", {
    expected_status_version: 7, summary_hash: summary.summaryHash, summary,
  });
  const rejectedCheck = {
    id: "image-group-check-rejected-a",
    visual_group_key: "group-a",
    expected_status_version: 8,
    status: "REJECTED",
    result: { retrySlotKeys: ["sell-1"] },
  };
  const load = async (slotKey) => {
    const pool = scriptedPool([
      [boundary({
        status: "GENERATING", status_version: 8, active_content_plan_id: "plan-derived",
        planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
        current_source_image_analysis_run_id: "run-a",
      })],
      [planBundle(sourcePlan, {
        config_snapshot: structuredClone(genericConfigSnapshot),
        config_hash_from_job: GENERIC_CONFIG_HASH,
      })],
      [acceptedRun],
      [rejectedCheck],
    ]);
    const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool, {
      sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {},
      imageGroupChecker: async () => null, imageGroupCheckRepository: {},
    }))(message("GENERATE_IMAGE_SLOT", { expectedStatusVersion: 8, slotKey }));
    assert.match(pool.calls[3].sql, /FROM auto_listing_image_group_checks/iu);
    assert.match(pool.calls[3].sql, /visual_group_key=\$5/iu);
    assert.match(pool.calls[3].sql, /ORDER BY expected_status_version DESC/iu);
    return context.phaseInput.regeneration;
  };

  assert.deepEqual(await load("sell-1"), {
    requestId: "image-group-check-rejected-a", reason: "QUALITY_RETRY",
  });
  assert.equal(await load("main-1"), null, "an accepted sibling must keep its original attempt lineage");
});

test("an isolated skipped-slot recovery gives only that slot a fresh QUALITY_RETRY lineage", async () => {
  const summary = acceptedSourceSummary();
  const sourcePlan = sourceImageDerivedPlanRow(summary);
  const acceptedRun = analysisRunRow("ACCEPTED", {
    expected_status_version: 7, summary_hash: summary.summaryHash, summary,
  });
  const pool = scriptedPool([
    [boundary({
      status: "GENERATING", status_version: 8, active_content_plan_id: "plan-derived",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-a",
    })],
    [planBundle(sourcePlan, {
      config_snapshot: structuredClone(genericConfigSnapshot),
      config_hash_from_job: GENERIC_CONFIG_HASH,
    })],
    [acceptedRun],
    [{
      evidence_kind: "SLOT_RECOVERY",
      id: "slot-recovery-event-a",
      visual_group_key: "group-a",
      expected_status_version: 8,
      status: "RECOVERY",
      result: { retrySlotKeys: ["sell-1"] },
    }],
  ]);
  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {},
    imageGroupChecker: async () => null, imageGroupCheckRepository: {},
  }))(message("GENERATE_IMAGE_SLOT", { expectedStatusVersion: 8, slotKey: "sell-1" }));

  assert.deepEqual(context.phaseInput.regeneration, {
    requestId: "slot-recovery-event-a", reason: "QUALITY_RETRY",
  });
  assert.match(pool.calls[3].sql, /AI_IMAGE_SLOT_RECOVERY_QUEUED/iu);
  assert.match(pool.calls[3].sql, /details->'retrySlotKeys' \? \$7/iu);
  assert.deepEqual(pool.calls[3].values, [
    "account-a", "job-a", "item-a", "plan-derived", "group-a", 8, "sell-1",
  ]);
});

test("PLAN_CONTENT loads the exact snapshot, frozen config/strategy and configured profile version", async () => {
  const pool = scriptedPool([
    [boundary()],
    [planBundle(undefined, { id: undefined, account_id: undefined, job_id: undefined, item_id: undefined })],
    [{ id: "rule-a", rule_order: 1, rule_kind: "EXACT_CATEGORY", category_id: "different-category", ancestor_category_id: null, product_style: null, rule: { style: "VISUAL_FIRST", textDensityByRole: {} } }],
  ]);
  const options = dependencies(pool);
  const context = await createPostgresAutoListingAiPhaseContextLoader(options)(message("PLAN_CONTENT"));
  assert.deepEqual(Object.keys(context).sort(), ["accountId", "activeContentPlanId", "itemId", "jobId", "phaseInput", "status", "statusVersion"].sort());
  assert.deepEqual(Object.keys(context.phaseInput).sort(), [
    "sourceSnapshotId", "gatewayProfile", "gateway", "repository", "sourceCapture", "strategyCapture",
    "configCapture", "visualGroupsCapture", "promptTemplateVersion", "prohibitedClaims", "regeneration",
    "planningContract", "evidenceRepository", "gatewayExecution",
  ].sort());
  assert.equal(context.phaseInput.sourceSnapshotId, "snapshot-a");
  assert.equal(context.phaseInput.planningContract, "LEGACY_FULL_PLAN_V3");
  assert.equal(context.phaseInput.gateway, options.gateway);
  assert.equal(context.phaseInput.repository, options.contentPlanRepository);
  assert.equal(context.phaseInput.evidenceRepository, options.contentPlanEvidenceRepository);
  assert.equal(context.phaseInput.gatewayProfile.apiKeyEnvName, "SUB2API_ENCRYPTED_KEY");
  assert.equal(context.phaseInput.gatewayProfile.apiKey, undefined);
  assert.equal(context.phaseInput.gatewayProfile.enabled, true);
  assert.equal(context.phaseInput.gatewayProfile.connectionId, "connection-a");
  assert.equal(context.phaseInput.gatewayProfile.connectionVersion, 1);
  assert.deepEqual(context.phaseInput.configCapture, { configSnapshot, configHash: CONFIG_HASH });
  assert.equal(context.phaseInput.strategyCapture.strategySnapshot.strategyVersionId, "strategy-v1");
  assert.equal(context.phaseInput.strategyCapture.strategySnapshot.matchedBy, "DEFAULT");
  assert.match(context.phaseInput.strategyCapture.strategyHash, /^[a-f0-9]{64}$/u);
  assert.equal(context.phaseInput.visualGroupsCapture.sourceHash, SOURCE_HASH);
  assert.deepEqual(context.phaseInput.prohibitedClaims, PROHIBITED);
  assert.equal(context.phaseInput.regeneration, null);
  assert.deepEqual(pool.calls[1].values, [
    "account-a", "job-a", "item-a", "snapshot-a",
    "channel-a", "connection-a", 1, "worker-a", "worker-token-a",
  ]);
  assert.match(pool.calls[1].sql,
    /p\.account_id=j\.account_id\s+AND\s+p\.id=j\.ai_profile_id\s+AND\s+p\.config_version=j\.ai_profile_version/iu);
  assert.match(pool.calls[1].sql, /p\.connection_id AS profile_connection_id/iu);
  assert.match(pool.calls[1].sql, /p\.connection_version AS profile_connection_version/iu);
  assert.doesNotMatch(pool.calls[1].sql, /p\.enabled IS TRUE/iu);
  assert.doesNotMatch(pool.calls[1].sql, /ORDER\s+BY|LIMIT\s+1/iu);
  assert.deepEqual(pool.calls[2].values, ["account-a", "strategy-v1"]);
});

test("PLAN_CONTENT keeps frozen models but routes only through the exact adopted channel connection", async () => {
  const pool = scriptedPool([
    [boundary()],
    [planBundle(undefined, {
      id: undefined, account_id: undefined, job_id: undefined, item_id: undefined,
      execution_channel_id: "channel-b",
      execution_connection_id: "connection-b",
      execution_connection_version: 7,
      execution_connection_base_url: "https://leased-gateway.invalid",
    })],
    [],
  ]);

  const loaded = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
    contextRequest("PLAN_CONTENT", {
      channelId: "channel-b", connectionId: "connection-b", connectionVersion: 7,
    }),
  );

  assert.equal(loaded.phaseInput.gatewayProfile.id, "profile-a");
  assert.equal(loaded.phaseInput.gatewayProfile.configVersion, 3);
  assert.equal(loaded.phaseInput.gatewayProfile.textModel, "text-model");
  assert.equal(loaded.phaseInput.gatewayProfile.imageModel, "image-model");
  assert.equal(loaded.phaseInput.gatewayProfile.baseUrl, "https://leased-gateway.invalid");
  assert.equal(loaded.phaseInput.gatewayProfile.connectionId, "connection-b");
  assert.equal(loaded.phaseInput.gatewayProfile.connectionVersion, 7);
  assert.deepEqual(loaded.phaseInput.gatewayExecution, {
    channelId: "channel-b",
    connectionId: "connection-b",
    connectionVersion: 7,
    idleTimeoutMs: 300_000,
  });
  assert.equal(Object.isFrozen(loaded.phaseInput.gatewayExecution), true);
  assert.match(pool.calls[1].sql, /JOIN auto_listing_ai_profile_channels/iu);
  assert.match(pool.calls[1].sql, /JOIN ai_gateway_connection_versions/iu);
  for (const value of ["channel-b", "connection-b", 7, "worker-a", "worker-token-a"]) {
    assert.equal(pool.calls[1].values.includes(value), true);
  }
  assert.doesNotMatch(pool.calls[1].sql, /ORDER\s+BY|LIMIT\s+1/iu);
});

test("exact routing rejects a mismatched adopted channel instead of falling back to the profile connection", async () => {
  const pool = scriptedPool([[boundary()], []]);
  await assert.rejects(
    createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(contextRequest("PLAN_CONTENT", {
      channelId: "channel-b", connectionId: "connection-b", connectionVersion: 7,
    })),
    { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false },
  );
  assert.equal(pool.calls.length, 2);
});

test("PLAN_CONTENT hydrates the exact published V2 rule from the job-frozen version without current-policy drift", async () => {
  const pool = scriptedPool([
    [boundary()],
    [planBundle(undefined, {
      id: undefined, account_id: undefined, job_id: undefined, item_id: undefined,
      strategy_version_id: "strategy-frozen-v2",
    })],
    [{
      id: "category-rule-row-a", rule_order: 7, rule_kind: "EXACT_CATEGORY",
      category_id: "170", ancestor_category_id: null, product_style: null,
      rule: publishedV2Rule(),
    }],
  ]);
  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(message("PLAN_CONTENT"));
  const frozen = context.phaseInput.strategyCapture.strategySnapshot;
  assert.equal(frozen.matchedBy, "EXACT_CATEGORY_TYPE_V2");
  assert.equal(frozen.strategyVersionId, "strategy-frozen-v2");
  assert.equal(frozen.ruleId, "category-rule-row-a");
  assert.deepEqual(frozen.scope, {
    taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99,
  });
  assert.equal(frozen.sampleSetHash, H("a"));
  assert.equal(frozen.analysisAttemptId, "category-analysis-attempt-a");
  assert.equal(frozen.analysisResultId, "category-analysis-result-a");
  assert.equal(Object.isFrozen(frozen), true);
  assert.deepEqual(pool.calls[2].values, ["account-a", "strategy-frozen-v2"]);
  assert.doesNotMatch(pool.calls[2].sql, /status='PUBLISHED'|ORDER\s+BY.*published|LIMIT\s+1/iu);
});

test("PLAN_CONTENT keeps the frozen generic strategy when category strategy is OFF", async () => {
  const pool = scriptedPool([
    [boundary()],
    [planBundle(undefined, {
      id: undefined, account_id: undefined, job_id: undefined, item_id: undefined,
      config_snapshot: structuredClone(genericConfigSnapshot),
      config_hash_from_job: GENERIC_CONFIG_HASH,
      strategy_version_id: "strategy-frozen-v2",
    })],
    [{
      id: "category-rule-row-a", rule_order: 7, rule_kind: "EXACT_CATEGORY",
      category_id: "170", ancestor_category_id: null, product_style: null,
      rule: publishedV2Rule(),
    }],
  ]);

  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(message("PLAN_CONTENT"));

  assert.equal(context.phaseInput.configCapture.configSnapshot.useCategoryStrategy, false);
  assert.equal(context.phaseInput.strategyCapture.strategySnapshot.matchedBy, "DEFAULT");
  assert.equal(context.phaseInput.strategyCapture.strategySnapshot.ruleId, null);
  assert.equal(pool.calls.some(({ sql }) => /FROM ai_content_strategy_rules/.test(sql)), false);
});

test("PLAN_CONTENT rejects an unknown persisted planning contract before strategy reads", async () => {
  const pool = scriptedPool([
    [boundary()],
    [planBundle(undefined, {
      id: undefined, account_id: undefined, job_id: undefined, item_id: undefined,
      planning_contract: "FUTURE_OPEN_CONTRACT",
    })],
  ]);
  await assert.rejects(
    createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(message("PLAN_CONTENT")),
    { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false },
  );
  assert.equal(pool.calls.length, 2);
});

test("a regenerate command becomes immutable USER_REQUESTED planner evidence", async () => {
  const pool = scriptedPool([
    [boundary()],
    [planBundle(undefined, {
      id: undefined, account_id: undefined, job_id: undefined, item_id: undefined,
      regeneration_request_id: "auto-listing-command-regenerate-a",
    })],
    [{ id: "rule-a", rule_order: 1, rule_kind: "EXACT_CATEGORY", category_id: "different-category", ancestor_category_id: null, product_style: null, rule: { style: "VISUAL_FIRST", textDensityByRole: {} } }],
  ]);
  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(message("PLAN_CONTENT"));
  assert.deepEqual(context.phaseInput.regeneration, {
    requestId: "auto-listing-command-regenerate-a", reason: "USER_REQUESTED",
  });
  assert.match(pool.calls[1].sql, /LEFT JOIN auto_listing_user_commands AS command/i);
  assert.match(pool.calls[1].sql, /command\.result_status_version=i\.status_version/i);
});

test("MATERIALIZE and FINALIZE load only the explicit active plan, never a latest plan", async () => {
  for (const phase of ["MATERIALIZE_SOURCE_ASSET", "FINALIZE_MATERIALIZED_PLAN"]) {
    const row = planBundle(basePlanRow());
    const pool = scriptedPool([[boundary({ active_content_plan_id: "plan-parent" })], [row]]);
    const options = dependencies(pool);
    const context = await createPostgresAutoListingAiPhaseContextLoader(options)(message(phase));
    assert.equal(context.phaseInput.parentPlan.id, "plan-parent");
    assert.equal(context.phaseInput.parentPlan.planningContract, "LEGACY_FULL_PLAN_V3");
    assert.equal(context.phaseInput.parentPlan.skeletonHash, null);
    if (phase === "MATERIALIZE_SOURCE_ASSET") {
      assert.equal(context.phaseInput.repository, options.sourceMaterializationRepository);
      assert.equal(context.phaseInput.sourceSnapshot.sourceSnapshotId, "snapshot-a");
      assert.equal(context.phaseInput.downloader, options.downloader);
    }
    assert.deepEqual(pool.calls[1].values.slice(0, 5), ["account-a", "job-a", "item-a", "plan-parent", "snapshot-a"]);
    assert.doesNotMatch(pool.calls[1].sql, /ORDER\s+BY|LIMIT\s+1|MAX\s*\(/iu);
  }
});

test("FINALIZE exposes the source-materialization read and content-plan write as one use-case repository", async () => {
  const pool = scriptedPool([
    [boundary({ active_content_plan_id: "plan-parent" })],
    [planBundle(basePlanRow())],
  ]);
  const accepted = [{ sourceAssetId: "source-a", status: "ACCEPTED" }];
  const derived = { id: "plan-derived" };
  const options = dependencies(pool, {
    sourceMaterializationRepository: {
      async listAcceptedSourceMaterializations(input) {
        return input.parentPlanId === "plan-parent" ? accepted : [];
      },
    },
    contentPlanRepository: {
      async createDerivedMaterializedPlan(input) {
        return input.derivedPlan.id === "plan-derived" ? derived : null;
      },
    },
  });

  const context = await createPostgresAutoListingAiPhaseContextLoader(options)(message("FINALIZE_MATERIALIZED_PLAN"));
  assert.equal(typeof context.phaseInput.repository.listAcceptedSourceMaterializations, "function");
  assert.equal(typeof context.phaseInput.repository.createDerivedMaterializedPlan, "function");
  assert.equal(await context.phaseInput.repository.listAcceptedSourceMaterializations({ parentPlanId: "plan-parent" }), accepted);
  assert.equal(await context.phaseInput.repository.createDerivedMaterializedPlan({ derivedPlan: { id: "plan-derived" } }), derived);
});

test("intelligent FINALIZE filters a 101-row analysis run to planned assets in SQL without materializing again", async () => {
  const sourcePlan = basePlanRow({
    planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1", skeleton_hash: H("7"),
    source_image_analysis_run_id: "run-a", source_image_intelligence_hash: H("6"),
  });
  const acceptedRows = Array.from({ length: 101 }, (_, index) => {
    const sourceAssetId = index === 0 ? "source-a" : `source-excluded-${String(index).padStart(3, "0")}`;
    return {
      id: `materialization-${sourceAssetId}`, account_id: "account-a", job_id: "job-a", item_id: "item-a",
      source_analysis_run_id: "run-a", source_asset_id: sourceAssetId,
      source_ref_hash: index === 0 ? H("1") : H("4"), input_hash: index === 0 ? H("2") : H("5"),
      expected_status_version: 7, attempt_no: 1, status: "ACCEPTED", lease_owner: null, lease_token: null,
      lease_expires_at: null, object_key_version: "SOURCE_V2", object_key: `sources/account-a/${sourceAssetId}.png`,
      content_hash: index === 0 ? H("3") : H("6"), content_type: "image/png",
      width: 768, height: 1024, size_bytes: 1024,
      accepted_at: "2026-08-30T00:00:00.000Z", error_code: null, error_retryable: null,
      created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:00.000Z",
    };
  });
  const pool = scriptedPool([
    [boundary({
      active_content_plan_id: "plan-parent", planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-a",
    })],
    [planBundle(sourcePlan)],
    [analysisRunRow("ACCEPTED", { summary_hash: H("6"), summary: { summaryHash: H("6") } })],
    [{ id: "run-a", expected_status_version: 7 }],
    (sql, values) => ({
      rows: Array.isArray(values?.[5])
        ? acceptedRows.filter(({ source_asset_id: sourceAssetId }) => values[5].includes(sourceAssetId))
        : acceptedRows,
    }),
  ]);
  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
    message("FINALIZE_MATERIALIZED_PLAN"),
  );
  assert.equal(context.phaseInput.parentPlan.sourceImageAnalysisRunId, "run-a");
  assert.deepEqual(context.phaseInput.sourceMaterializationScope, {
    analysisRunId: "run-a", expectedStatusVersion: 7,
  });
  assert.equal(pool.calls.some(({ sql }) => /FROM auto_listing_source_image_analysis_runs/iu.test(sql)), true);
  const lineageQueries = pool.calls.filter(({ sql }) => /WITH RECURSIVE current_run/iu.test(sql));
  assert.equal(lineageQueries.length, 1);
  assert.match(lineageQueries[0].sql, /CARDINALITY\(child\.path\)<100/iu);
  assert.match(lineageQueries[0].sql, /UNNEST\(\$5::TEXT\[\]\)/iu);
  assert.match(lineageQueries[0].sql, /assessment\.account_id=\$1[\s\S]*assessment\.job_id=\$2[\s\S]*assessment\.item_id=\$3/iu);
  assert.match(lineageQueries[0].sql, /attempt\.account_id=assessment\.account_id[\s\S]*attempt\.item_id=assessment\.item_id/iu);
  assert.match(lineageQueries[0].sql, /source_analysis_run_id=candidate\.id[\s\S]*expected_status_version=candidate\.expected_status_version/iu);
  assert.match(lineageQueries[0].sql,
    /EXISTS\s*\([\s\S]*FROM lineage AS input_owner[\s\S]*input_owner\.input_hash=candidate\.input_hash/iu);
  assert.match(lineageQueries[0].sql, /source_asset_id=planned\.source_asset_id[\s\S]*status='ACCEPTED'/iu);
  assert.match(lineageQueries[0].sql, /ORDER BY \(lineage\.id IS NULL\),lineage\.depth NULLS LAST[\s\S]*LIMIT 1/iu);
  assert.deepEqual(lineageQueries[0].values, ["account-a", "job-a", "item-a", "run-a", ["source-a"]]);
  const accepted = await context.phaseInput.repository.listAcceptedSourceMaterializations({
    accountId: "account-a", jobId: "job-a", itemId: "item-a",
    sourceImageAnalysisRunId: "run-a", expectedStatusVersion: 7,
  });
  assert.deepEqual(accepted.map(({ sourceAssetId }) => sourceAssetId), ["source-a"]);
  assert.deepEqual(accepted[0].owner, { kind: "SOURCE_IMAGE_ANALYSIS", id: "run-a" });
  const materializationQuery = pool.calls.at(-1);
  assert.match(materializationQuery.sql, /source_asset_id\s*=\s*ANY\(\$6::text\[\]\)/iu);
  assert.match(materializationQuery.sql, /status='ACCEPTED'[\s\S]*LIMIT 101/iu);
  assert.doesNotMatch(materializationQuery.sql, /parent_plan_id/iu);
  assert.deepEqual(materializationQuery.values, ["account-a", "job-a", "item-a", "run-a", 7, ["source-a"]]);

  const mismatch = scriptedPool([
    [boundary({
      active_content_plan_id: "plan-parent", planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-a",
    })],
    [planBundle(sourcePlan)],
    [analysisRunRow("ACCEPTED", { summary_hash: H("5"), summary: { summaryHash: H("5") } })],
  ]);
  await assert.rejects(
    createPostgresAutoListingAiPhaseContextLoader(dependencies(mismatch))(message("FINALIZE_MATERIALIZED_PLAN")),
    { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false },
  );
  assert.equal(mismatch.calls.some(({ sql }) => /source_materialization_attempts/iu.test(sql)), false);
});

test("retried intelligent FINALIZE reuses the accepted current analysis from an earlier status version", async () => {
  const sourcePlan = basePlanRow({
    planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1", skeleton_hash: H("7"),
    source_image_analysis_run_id: "run-a", source_image_intelligence_hash: H("6"),
  });
  const pool = scriptedPool([
    [boundary({
      status_version: 8,
      active_content_plan_id: "plan-parent",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-a",
    })],
    [planBundle(sourcePlan)],
    [analysisRunRow("ACCEPTED", {
      expected_status_version: 7, summary_hash: H("6"), summary: { summaryHash: H("6") },
    })],
    [{ id: "run-a", expected_status_version: 7 }],
  ]);

  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
    message("FINALIZE_MATERIALIZED_PLAN", { expectedStatusVersion: 8 }),
  );

  assert.equal(context.phaseInput.parentPlan.sourceImageAnalysisRunId, "run-a");
  assert.deepEqual(context.phaseInput.sourceMaterializationScope, {
    analysisRunId: "run-a", expectedStatusVersion: 7,
  });
  assert.match(pool.calls[2].sql, /expected_status_version<=\$5/iu);
});

test("retried intelligent FINALIZE resolves copied assessment bytes to their exact accepted materialization owner", async () => {
  const sourcePlan = basePlanRow({
    planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1", skeleton_hash: H("7"),
    source_image_analysis_run_id: "run-retry", source_image_intelligence_hash: H("6"),
  });
  const pool = scriptedPool([
    [boundary({
      status_version: 10,
      active_content_plan_id: "plan-parent",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-retry",
    })],
    [planBundle(sourcePlan)],
    [analysisRunRow("ACCEPTED", {
      id: "run-retry", expected_status_version: 8,
      summary_hash: H("6"), summary: { summaryHash: H("6") },
    })],
    [{ id: "run-root", expected_status_version: 6 }],
  ]);

  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
    message("FINALIZE_MATERIALIZED_PLAN", { expectedStatusVersion: 10 }),
  );

  assert.deepEqual(context.phaseInput.sourceMaterializationScope, {
    analysisRunId: "run-root", expectedStatusVersion: 6,
  });
  const provenanceQuery = pool.calls.at(-1);
  assert.match(provenanceQuery.sql, /auto_listing_source_image_assessments\s+AS\s+assessment/iu);
  assert.match(provenanceQuery.sql, /assessment\.analysis_run_id=\$4/iu);
  assert.match(provenanceQuery.sql, /attempt\.object_key=assessment\.object_key/iu);
  assert.match(provenanceQuery.sql, /attempt\.content_hash=assessment\.content_hash/iu);
  assert.match(provenanceQuery.sql, /candidate\.source_snapshot_hash=current_run\.source_snapshot_hash/iu);
});

test("manual-decision FINALIZE resolves one immutable root materialization owner inside the same analysis lineage", async () => {
  const sourcePlan = basePlanRow({
    planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1", skeleton_hash: H("7"),
    source_image_analysis_run_id: "run-derived", source_image_intelligence_hash: H("6"),
  });
  const derivedRun = analysisRunRow("ACCEPTED", {
    id: "run-derived",
    parent_run_id: "run-root",
    expected_status_version: 8,
    summary_hash: H("6"),
    summary: { summaryHash: H("6") },
  });
  const pool = scriptedPool([
    [boundary({
      status_version: 8,
      active_content_plan_id: "plan-parent",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-derived",
    })],
    [planBundle(sourcePlan)],
    [derivedRun],
    [{ id: "run-root", expected_status_version: 7 }],
  ]);

  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
    message("FINALIZE_MATERIALIZED_PLAN", { expectedStatusVersion: 8 }),
  );

  assert.deepEqual(context.phaseInput.sourceMaterializationScope, {
    analysisRunId: "run-root",
    expectedStatusVersion: 7,
  });
  const lineageQuery = pool.calls.at(-1);
  assert.match(lineageQuery.sql, /WITH RECURSIVE current_run/iu);
  assert.match(lineageQuery.sql, /parent_run_id IS NULL/iu);
  assert.deepEqual(lineageQuery.values, ["account-a", "job-a", "item-a", "run-derived", ["source-a"]]);
});

test("MATERIALIZE rejects a sourceAssetId that is not evidence in the active plan", async () => {
  const pool = scriptedPool([
    [boundary({ active_content_plan_id: "plan-parent" })],
    [planBundle(basePlanRow())],
  ]);
  await assert.rejects(
    createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
      message("MATERIALIZE_SOURCE_ASSET", { sourceAssetId: "source-other" }),
    ),
    { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false },
  );
});

test("GENERATE_IMAGE_SLOT uses the active derived plan, exact slot and frozen image config", async () => {
  const plan = derivedPlanRow();
  plan.strategy_version_id = "strategy-frozen-v2";
  plan.plan.slots[0].textDensity = "MEDIUM";
  const row = planBundle(plan);
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [row],
    [{
      id: "category-rule-row-a", rule_order: 7, rule_kind: "EXACT_CATEGORY",
      category_id: "170", ancestor_category_id: null, product_style: null,
      rule: publishedV2Rule("MEDIUM"),
    }],
    [],
  ]);
  const options = dependencies(pool);
  const context = await createPostgresAutoListingAiPhaseContextLoader(options)(message("GENERATE_IMAGE_SLOT"));
  assert.equal(context.phaseInput.plan.id, "plan-derived");
  assert.equal(context.phaseInput.slot.slotKey, "main-1");
  assert.equal(context.phaseInput.profile.id, "profile-a");
  assert.equal(context.phaseInput.imageModel, "image-model");
  assert.equal(context.phaseInput.ratio, "3:4");
  assert.equal(context.phaseInput.resolution, "1K");
  assert.equal(context.phaseInput.size, "768x1024");
  assert.equal(context.phaseInput.quality, "medium");
  assert.equal(context.phaseInput.maxAttempts, 3);
  assert.deepEqual(context.phaseInput.categoryStyle, {
    overallStyle: "clean commercial catalogue",
    prohibitedPatterns: ["avoid competitor branding"],
    role: "MAIN",
    composition: "MAIN composition",
    background: "MAIN background",
    textDensity: "MEDIUM",
    layout: "MAIN layout",
  });
  assert.deepEqual(context.phaseInput.categoryStyleReferences, []);
  assert.equal(context.phaseInput.repository, options.generationRepository);
  assert.equal(context.phaseInput.slot, context.phaseInput.plan.plan.slots[0]);
  assert.deepEqual(Object.keys(context.phaseInput.plan.factRegistry[0]).sort(), [
    "factId", "kind", "sourcePath", "value", "visualGroupKeys",
  ]);
  assert.deepEqual(pool.calls[1].values, [
    "account-a", "job-a", "item-a", "plan-derived", "snapshot-a",
    "channel-a", "connection-a", 1, "worker-a", "worker-token-a",
  ]);
  assert.deepEqual(pool.calls[2].values, ["account-a", "strategy-frozen-v2"]);
  assert.doesNotMatch(pool.calls[1].sql, /latest|ORDER\s+BY|LIMIT\s+1/iu);
});

test("GENERATE_IMAGE_SLOT does not restore category style when category strategy is OFF", async () => {
  const plan = derivedPlanRow();
  plan.strategy_version_id = "strategy-frozen-v2";
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [planBundle(plan, {
      config_snapshot: structuredClone(genericConfigSnapshot),
      config_hash_from_job: GENERIC_CONFIG_HASH,
    })],
    [{
      id: "category-rule-row-a", rule_order: 7, rule_kind: "EXACT_CATEGORY",
      category_id: "170", ancestor_category_id: null, product_style: null,
      rule: publishedV2Rule(),
    }],
  ]);

  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
    message("GENERATE_IMAGE_SLOT"),
  );

  assert.equal(context.phaseInput.categoryStyle, null);
  assert.deepEqual(context.phaseInput.categoryStyleReferences, []);
  assert.equal(pool.calls.some(({ sql }) => /FROM ai_content_strategy_rules/.test(sql)), false);
});

test("V6 main image may raise copy density without discarding the frozen category style", async () => {
  const plan = derivedPlanRow();
  plan.strategy_version_id = "strategy-frozen-v2";
  plan.prompt_template_version = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  plan.planning_contract = "FIXED_SKELETON_V1";
  plan.skeleton_hash = H("9");
  plan.plan.slots[0].textDensity = "HEAVY";
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [planBundle(plan)],
    [{
      id: "category-rule-row-a", rule_order: 7, rule_kind: "EXACT_CATEGORY",
      category_id: "170", ancestor_category_id: null, product_style: null,
      rule: publishedV2Rule("NONE"),
    }],
    [],
  ]);

  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
    message("GENERATE_IMAGE_SLOT"),
  );

  assert.equal(context.phaseInput.categoryStyle.textDensity, "HEAVY");
  assert.equal(context.phaseInput.categoryStyle.composition, "MAIN composition");
  assert.equal(context.phaseInput.categoryStyle.background, "MAIN background");
});

test("V6 copy-free slots keep category style while overriding text density to NONE", async () => {
  const plan = derivedPlanRow();
  plan.strategy_version_id = "strategy-frozen-v2";
  plan.prompt_template_version = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  plan.planning_contract = "FIXED_SKELETON_V1";
  plan.skeleton_hash = H("9");
  const slot = plan.plan.slots.find(({ slotKey }) => slotKey === "sell-1");
  slot.textDensity = "NONE";
  slot.claims = [];
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [planBundle(plan)],
    [{
      id: "category-rule-row-a", rule_order: 7, rule_kind: "EXACT_CATEGORY",
      category_id: "170", ancestor_category_id: null, product_style: null,
      rule: publishedV2Rule(),
    }],
    [],
  ]);

  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
    message("GENERATE_IMAGE_SLOT", { slotKey: "sell-1" }),
  );

  assert.equal(context.phaseInput.slot.claims.length, 0);
  assert.equal(context.phaseInput.maxAttempts, 3);
  assert.equal(context.phaseInput.categoryStyle.textDensity, "NONE");
  assert.equal(context.phaseInput.categoryStyle.composition, "SELLING_POINT composition");
  assert.equal(context.phaseInput.categoryStyle.background, "SELLING_POINT background");
});

test("non-main slots keep the cheaper two-attempt limit when a visual group has spare coverage", async () => {
  const plan = derivedPlanRow();
  plan.strategy_version_id = "strategy-frozen-v2";
  plan.prompt_template_version = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  plan.planning_contract = "FIXED_SKELETON_V1";
  plan.skeleton_hash = H("9");
  plan.plan.slots.push({
    ...structuredClone(plan.plan.slots.find(({ slotKey }) => slotKey === "sell-2")),
    slotKey: "sell-3",
    order: 7,
  });
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [planBundle(plan)],
    [{
      id: "category-rule-row-a", rule_order: 7, rule_kind: "EXACT_CATEGORY",
      category_id: "170", ancestor_category_id: null, product_style: null,
      rule: publishedV2Rule(),
    }],
    [],
  ]);

  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
    message("GENERATE_IMAGE_SLOT", { slotKey: "sell-1" }),
  );

  assert.equal(context.phaseInput.maxAttempts, 2);
});

test("GENERATE_IMAGE_SLOT loads clear cross-SKU style evidence cited by the frozen published rule", async () => {
  const plan = derivedPlanRow();
  plan.strategy_version_id = "strategy-frozen-v2";
  plan.plan.slots[0].textDensity = "MEDIUM";
  const row = planBundle(plan);
  const styleBytes = await sharp({ create: { width: 900, height: 1200, channels: 4, background: "#cc3366" } }).webp().toBuffer();
  const styleHash = sha256(styleBytes);
  const roleEvidence = {
    MAIN: { confidence: 0.95, evidenceIds: ["tiny-main-a", "clear-main-a", "clear-main-b"] },
  };
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [row],
    [{
      id: "category-rule-row-a", rule_order: 7, rule_kind: "EXACT_CATEGORY",
      category_id: "170", ancestor_category_id: null, product_style: null,
      rule: publishedV2Rule("MEDIUM"),
    }],
    [{
      id: "category-analysis-result-a", account_id: "account-a", sample_set_id: "sample-set-a",
      sample_set_hash: H("a"), raw_response: { evidenceSummary: { roleEvidence, commonPatterns: [] } },
    }],
    [
      { id: "tiny-main-a", sample_id: "sample-a", sku: "sku-a", role: "MAIN", ordinal: 0, analysis_object_key: "category-strategy/account-a/draft-a/sample-set-a/sample-a/tiny.webp", analysis_content_hash: styleHash, content_type: "image/webp", width: 50, height: 50 },
      { id: "clear-main-a", sample_id: "sample-a", sku: "sku-a", role: "DETAIL", ordinal: 1, analysis_object_key: "category-strategy/account-a/draft-a/sample-set-a/sample-a/clear-a.webp", analysis_content_hash: styleHash, content_type: "image/webp", width: 900, height: 1200 },
      { id: "clear-main-b", sample_id: "sample-b", sku: "sku-b", role: "DETAIL", ordinal: 1, analysis_object_key: "category-strategy/account-a/draft-a/sample-set-a/sample-b/clear-b.webp", analysis_content_hash: styleHash, content_type: "image/webp", width: 900, height: 1200 },
    ],
  ]);
  const options = dependencies(pool, {
    storage: { async getObjectBuffer() { throw new Error("database context must not read object storage"); } },
  });

  const context = await createPostgresAutoListingAiPhaseContextLoader(options)(message("GENERATE_IMAGE_SLOT"));

  assert.deepEqual(context.phaseInput.categoryStyleReferences.map(({ evidenceId, sku, width, height, objectKey }) => ({ evidenceId, sku, width, height, objectKey })), [
    { evidenceId: "clear-main-a", sku: "sku-a", width: 900, height: 1200, objectKey: "category-strategy/account-a/draft-a/sample-set-a/sample-a/clear-a.webp" },
  ]);
  assert.equal(context.phaseInput.categoryStyleReferences.some(({ bytes }) => bytes), false);
  assert.deepEqual(pool.calls[3].values, ["account-a", "category-analysis-result-a", H("a")]);
  assert.deepEqual(pool.calls[4].values, ["account-a", "sample-set-a", ["tiny-main-a", "clear-main-a", "clear-main-b"]]);
});

test("different visual groups reuse one stable cited category style anchor", async () => {
  const styleBytes = await sharp({ create: { width: 900, height: 1200, channels: 4, background: "#3366cc" } }).webp().toBuffer();
  const styleHash = sha256(styleBytes);
  const evidenceIds = ["style-a", "style-b", "style-c", "style-d"];
  const rows = evidenceIds.map((id, index) => ({
    id, sample_id: `sample-${index}`, sku: `sku-${index}`, role: "DETAIL", ordinal: 1,
    analysis_object_key: `category-strategy/account-a/draft-a/sample-set-a/sample-${index}/${id}.webp`,
    analysis_content_hash: styleHash, content_type: "image/webp", width: 900, height: 1200,
  }));
  const load = async ({ visualGroupKey, slotKey }) => {
    const plan = derivedPlanRow();
    plan.strategy_version_id = "strategy-frozen-v2";
    plan.visual_groups.groups[0].visualGroupKey = visualGroupKey;
    plan.plan.slots = plan.plan.slots.map((slot, index) => ({
      ...slot, visualGroupKey, ...(index === 0 ? { slotKey, textDensity: "MEDIUM" } : {}),
    }));
    plan.fact_registry[0].visualGroupKeys = [visualGroupKey];
    const pool = scriptedPool([
      [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
      [planBundle(plan)],
      [{ id: "category-rule-row-a", rule_order: 7, rule_kind: "EXACT_CATEGORY", category_id: "170",
        ancestor_category_id: null, product_style: null, rule: publishedV2Rule("MEDIUM") }],
      [{ id: "category-analysis-result-a", account_id: "account-a", sample_set_id: "sample-set-a",
        sample_set_hash: H("a"), raw_response: { evidenceSummary: {
          roleEvidence: { MAIN: { confidence: 0.95, evidenceIds } }, commonPatterns: [],
        } } }],
      rows,
    ]);
    const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool, {
      storage: { async getObjectBuffer() { throw new Error("database context must not read object storage"); } },
    }))(message("GENERATE_IMAGE_SLOT", { slotKey }));
    return context.phaseInput.categoryStyleReferences.map(({ evidenceId }) => evidenceId);
  };

  assert.deepEqual(await load({ visualGroupKey: "group-a", slotKey: "main-1" }), ["style-a"]);
  assert.deepEqual(await load({ visualGroupKey: "group-b", slotKey: "main-b" }), ["style-a"]);
});

test("GENERATE_IMAGE_SLOT rejects category-sample object keys before any image-model call", async () => {
  const plan = derivedPlanRow();
  plan.visual_groups.groups[0].referenceImages[0].objectKey =
    "category-strategy/account-a/draft-a/sample-set-a/sample-a/analysis.webp";
  let imageModelCalls = 0;
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [planBundle(plan)],
  ]);
  await assert.rejects(
    createPostgresAutoListingAiPhaseContextLoader(dependencies(pool, {
      gateway: { async generateImage() { imageModelCalls += 1; } },
    }))(message("GENERATE_IMAGE_SLOT")),
    { code: "AUTO_LISTING_CATEGORY_STRATEGY_REFERENCE_FORBIDDEN", retryable: false },
  );
  assert.equal(imageModelCalls, 0);
  assert.deepEqual(pool.control, ["BEGIN", "ROLLBACK"]);
});

test("GENERATE_IMAGE_SLOT rejects category-sample keys in final prompt claims before any image-model call", async () => {
  const plan = derivedPlanRow();
  plan.plan.slots[0].claims = [{
    text: "Сталь category-strategy/account-a/draft-a/sample.webp",
    claimType: "ATTRIBUTE:steel", sourceFactIds: ["fact-a"],
  }];
  let imageModelCalls = 0;
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [planBundle(plan)],
  ]);
  await assert.rejects(
    createPostgresAutoListingAiPhaseContextLoader(dependencies(pool, {
      gateway: { async generateImage() { imageModelCalls += 1; } },
    }))(message("GENERATE_IMAGE_SLOT")),
    { code: "AUTO_LISTING_CATEGORY_STRATEGY_REFERENCE_FORBIDDEN", retryable: false },
  );
  assert.equal(imageModelCalls, 0);
  assert.deepEqual(pool.control, ["BEGIN", "ROLLBACK"]);
});

test("generation reference projector accepts only closed current-source materializations", () => {
  const plan = generationProjectionPlan();
  const slot = plan.plan.slots[0];
  const projected = projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived", plan, slot,
  });
  assert.deepEqual(projected.references, [{
    assetId: "source-a", sourceRefHash: H("1"), contentHash: H("3"),
    sourceRef: null, evidenceKind: "CONTENT_HASH",
  }]);
  assert.deepEqual(projected.slot, slot);
  assert.deepEqual(projected.plan.plan.slots[0], slot);
  assert.notEqual(projected.plan, plan);
  assert.equal(Object.isFrozen(projected.plan), true);

  const multiGroup = multiGroupProjectionPlan();
  const multiProjected = projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
    plan: multiGroup, slot: multiGroup.plan.slots[8],
  });
  assert.equal(multiProjected.plan.plan.slots.length, 16);
  assert.equal(multiProjected.slot.visualGroupKey, "group-b");
  assert.equal(multiProjected.references[0].assetId, "source-b");

  const overAggregateCap = generationProjectionPlan();
  overAggregateCap.plan.slots = Array.from({ length: 1_001 }, (_, index) => ({
    ...structuredClone(overAggregateCap.plan.slots[0]),
    slotKey: `slot-${index + 1}`,
  }));
  assert.throws(() => projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
    plan: overAggregateCap, slot: overAggregateCap.plan.slots[0],
  }), { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID" });

  const directContent = structuredClone(plan);
  directContent.visualGroups.groups[0].referenceImages[0].sourceRefHash = null;
  assert.doesNotThrow(() => projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
    plan: directContent, slot: directContent.plan.slots[0],
  }));

  const approved = structuredClone(plan);
  approved.visualGroups.groups[0].referenceImages[0].objectKey = "approved/account-a/source-a.webp";
  assert.throws(() => projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived", plan: approved, slot,
  }), { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID" });

  const ordinaryText = structuredClone(plan);
  ordinaryText.gatewayRequestId = "ordinary-category-strategy-text";
  assert.doesNotThrow(() => projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived", plan: ordinaryText, slot,
  }));

  const extraPlan = structuredClone(plan);
  extraPlan.productLabel = "extra";
  assert.throws(() => projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived", plan: extraPlan, slot,
  }), { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID" });

  const leakedClaim = structuredClone(plan);
  leakedClaim.plan.slots[0].claims = [{
    text: "Сталь category-strategy/account-a/draft-a/sample.webp",
    claimType: "ATTRIBUTE:steel", sourceFactIds: ["fact-a"],
  }];
  assert.throws(() => projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
    plan: leakedClaim, slot: leakedClaim.plan.slots[0],
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_REFERENCE_FORBIDDEN" });

  let getterReads = 0;
  const accessorPlan = structuredClone(plan);
  Object.defineProperty(accessorPlan.plan.slots[0], "claims", {
    enumerable: true,
    get() { getterReads += 1; return []; },
  });
  assert.throws(() => projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
    plan: accessorPlan, slot: accessorPlan.plan.slots[0],
  }), { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID" });
  assert.equal(getterReads, 0);

  let proxyTraps = 0;
  const proxyPlan = structuredClone(plan);
  proxyPlan.plan.slots[0].claims = new Proxy([], { get() { proxyTraps += 1; throw new Error("trap"); } });
  assert.throws(() => projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
    plan: proxyPlan, slot: proxyPlan.plan.slots[0],
  }), { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID" });
  assert.equal(proxyTraps, 0);
});

test("generation reference projector accepts closed V2 role-substitution metadata", () => {
  const plan = generationProjectionPlan();
  plan.plan.version = 2;
  plan.plan.slots = plan.plan.slots.map((slot, index) => ({
    ...slot,
    requestedRole: index === 3 ? "SPECIFICATION" : slot.role,
    substitutionReasonCode: index === 3 ? "PRODUCT_DIMENSIONS_UNAVAILABLE" : null,
  }));
  const slot = plan.plan.slots[3];

  const projected = projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived", plan, slot,
  });

  assert.equal(projected.plan.plan.version, 2);
  assert.equal(projected.slot.role, "DETAIL");
  assert.equal(projected.slot.requestedRole, "SPECIFICATION");
  assert.equal(projected.slot.substitutionReasonCode, "PRODUCT_DIMENSIONS_UNAVAILABLE");
});

test("generation reference projector closes V3 view and identity evidence before image generation", () => {
  const plan = generationProjectionPlan();
  plan.planningContract = "FIXED_SKELETON_SOURCE_IMAGE_V1";
  plan.skeletonHash = H("7");
  plan.sourceImageAnalysisRunId = "run-a";
  plan.sourceImageIntelligenceHash = H("6");
  plan.plan.version = 3;
  plan.plan.slots = plan.plan.slots.map((slot) => ({
    ...slot, requestedRole: slot.role, substitutionReasonCode: null,
    targetView: "FRONT_RIGHT_3_4", evidenceMode: "SYNTHESIZED_SAFE", prohibitedViews: ["BACK"],
    prohibitedOverlayTexts: [], identityAssetId: "source-a",
    selectionReasonCodes: ["SOURCE_VIEW_EVIDENCE_SELECTED", "IDENTITY_REFERENCE_SELECTED"],
  }));
  const projected = projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
    plan, slot: plan.plan.slots[0],
  });
  assert.equal(projected.slot.identityAssetId, "source-a");
  assert.equal(projected.slot.targetView, "FRONT_RIGHT_3_4");
  assert.equal(projected.slot.evidenceMode, "SYNTHESIZED_SAFE");

  for (const mutate of [
    (slot) => { slot.targetView = "UNKNOWN"; },
    (slot) => { slot.identityAssetId = "source-other"; },
    (slot) => { slot.referenceAssetIds = ["source-a", "source-b", "source-c", "source-d"]; },
  ]) {
    const invalid = structuredClone(plan);
    mutate(invalid.plan.slots[0]);
    assert.throws(() => projectAutoListingGenerationReferences({
      accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived",
      plan: invalid, slot: invalid.plan.slots[0],
    }), { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID" });
  }
});

test("generation reference projector resolves a frozen cross-variant structure reference from the same plan", () => {
  const plan = multiGroupProjectionPlan();
  plan.planningContract = "FIXED_SKELETON_SOURCE_IMAGE_V1";
  plan.skeletonHash = H("7");
  plan.sourceImageAnalysisRunId = "run-a";
  plan.sourceImageIntelligenceHash = H("6");
  plan.plan.version = 3;
  plan.plan.slots = plan.plan.slots.map((slot) => ({
    ...slot,
    requestedRole: slot.role,
    substitutionReasonCode: null,
    targetView: "FRONT",
    evidenceMode: "DIRECT",
    prohibitedViews: ["BACK"],
    prohibitedOverlayTexts: [],
    identityAssetId: slot.referenceAssetIds[0],
    selectionReasonCodes: ["SOURCE_VIEW_EVIDENCE_SELECTED", "IDENTITY_REFERENCE_SELECTED"],
  }));
  const slot = plan.plan.slots.find((entry) => entry.visualGroupKey === "group-a" && entry.role === "MAIN");
  slot.referenceAssetIds = ["source-b", "source-a"];
  slot.identityAssetId = "source-a";
  slot.evidenceMode = "SYNTHESIZED_SAFE";
  slot.selectionReasonCodes = ["CROSS_VARIANT_STRUCTURE_REFERENCE_SELECTED", "IDENTITY_REFERENCE_SELECTED"];

  const projected = projectAutoListingGenerationReferences({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-derived", plan, slot,
  });

  assert.deepEqual(projected.references.map(({ assetId }) => assetId), ["source-b", "source-a"]);
  assert.equal(projected.slot.identityAssetId, "source-a");
});

test("GENERATE_RICH_CONTENT loads accepted assets only inside the exact active-plan scope", async () => {
  const plan = derivedPlanRow();
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [planBundle(plan)],
    plan.plan.slots.map((_, index) => acceptedAsset(index, plan)),
  ]);
  const options = dependencies(pool);
  const context = await createPostgresAutoListingAiPhaseContextLoader(options)(message("GENERATE_RICH_CONTENT"));
  assert.equal(context.phaseInput.plan.id, "plan-derived");
  assert.equal(context.phaseInput.plan.accountId, "account-a");
  assert.equal(context.phaseInput.plan.planId, "plan-derived");
  assert.equal(context.phaseInput.acceptedAssets.length, 6);
  assert.equal(context.phaseInput.acceptedAssets[0].errorCode, undefined);
  assert.equal(context.phaseInput.factRegistry, context.phaseInput.plan.factRegistry);
  assert.equal(context.phaseInput.repository, options.richContentRepository);
  assert.equal(context.phaseInput.maxAttempts, 5);
  assert.deepEqual(pool.calls[2].values, ["account-a", "job-a", "item-a", "plan-derived", 7]);
  assert.match(pool.calls[2].sql, /status='ACCEPTED'/u);
  assert.match(pool.calls[2].sql,
    /ranked\.plan_prompt_template_version='AUTO_LISTING_CONTENT_PLAN_FILL_V6'[\s\S]*ranked\.planned_slot_contract->>'role'='MAIN'/iu,
    "rich-content input must retain a V6 MAIN whose product title is required independently of claims");
  assert.doesNotMatch(pool.calls[2].sql, /latest|ORDER\s+BY.*created|LIMIT\s+1/iu);
});

test("legacy rich-content loading preserves accepted assets without a status-version lineage", async () => {
  const plan = derivedPlanRow();
  const legacyAssets = plan.plan.slots.map((_, index) => ({
    ...acceptedAsset(index, plan), expected_status_version: null,
  }));
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [planBundle(plan)],
    legacyAssets,
  ]);

  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(
    message("GENERATE_RICH_CONTENT"),
  );

  assert.equal(context.phaseInput.acceptedAssets.length, 6);
  assert.equal(context.phaseInput.acceptedAssets.every(({ expectedStatusVersion }) => expectedStatusVersion === null), true);
  assert.match(pool.calls[2].sql, /asset\.expected_status_version IS NULL OR asset\.expected_status_version<=\$5/iu);
  assert.match(pool.calls[2].sql, /asset\.expected_status_version DESC NULLS LAST/iu);
  assert.match(pool.calls[2].sql,
    /ranked\.expected_status_version IS NULL\s+OR \(skipped\.details->>'statusVersion'\)::BIGINT>=ranked\.expected_status_version/iu,
    "a valid newer skip must supersede an older legacy accepted asset");
  assert.match(pool.calls[2].sql,
    /\(skipped\.details->>'statusVersion'\)::BIGINT<=\$5[\s\S]*skipped\.created_at>=ranked\.asset_created_at/iu,
    "a future skip must not apply and an earlier skip must lose to a later accepted asset");
});

test("source-image V3 rich-content and group checking reject unversioned accepted assets", async () => {
  const summary = acceptedSourceSummary();
  const plan = sourceImageDerivedPlanRow(summary);
  const acceptedRun = analysisRunRow("ACCEPTED", {
    expected_status_version: 7, summary_hash: summary.summaryHash, summary,
  });
  const unversionedAssets = plan.plan.slots.map((_, index) => ({
    ...acceptedAsset(index, plan), expected_status_version: null,
  }));
  const v3BoundaryRow = boundary({
    status: "GENERATING",
    active_content_plan_id: "plan-derived",
    planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    current_source_image_analysis_run_id: "run-a",
  });
  const options = (pool) => dependencies(pool, {
    sourceImageIntelligenceRepository: {}, sourceAnalysisAssetLoader: {},
    imageGroupChecker: async () => null, imageGroupCheckRepository: {},
  });

  const richPool = scriptedPool([
    [v3BoundaryRow], [planBundle(plan)], [acceptedRun], unversionedAssets,
  ]);
  await assert.rejects(
    createPostgresAutoListingAiPhaseContextLoader(options(richPool))(message("GENERATE_RICH_CONTENT")),
    { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false },
  );

  const groupPool = scriptedPool([[planBundle(plan)], [acceptedRun], unversionedAssets]);
  await assert.rejects(
    loadImageGroupCheckInput(
      options(groupPool), rawMessage("CHECK_IMAGE_GROUP"),
      analysisBoundary({ status: "GENERATING", activeContentPlanId: "plan-derived" }), execution(),
    ),
    { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false },
  );
});

test("GENERATE_RICH_CONTENT accepts more than 20 assets only as complete 6-13 image visual groups", async () => {
  const plan = derivedPlanRow();
  const sourceSlots = structuredClone(plan.plan.slots);
  const sourceGroup = structuredClone(plan.visual_groups.groups[0]);
  plan.plan.slots = [];
  plan.visual_groups.groups = [];
  for (let groupIndex = 0; groupIndex < 4; groupIndex += 1) {
    const visualGroupKey = `group-${groupIndex}`;
    plan.visual_groups.groups.push({ ...structuredClone(sourceGroup), visualGroupKey });
    plan.plan.slots.push(...sourceSlots.map((slot, slotIndex) => ({
      ...structuredClone(slot), visualGroupKey, slotKey: `${visualGroupKey}-slot-${slotIndex}`,
    })));
  }
  const assets = plan.plan.slots.map((_, index) => acceptedAsset(index, plan));
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [planBundle(plan)],
    assets,
  ]);
  const context = await createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(message("GENERATE_RICH_CONTENT"));
  assert.equal(context.phaseInput.acceptedAssets.length, 24);
});

test("GENERATE_RICH_CONTENT rejects any accepted asset outside the closed scope", async () => {
  const plan = derivedPlanRow();
  const assets = plan.plan.slots.map((_, index) => acceptedAsset(index, plan));
  assets[3].account_id = "account-other";
  const pool = scriptedPool([
    [boundary({ status: "GENERATING", active_content_plan_id: "plan-derived" })],
    [planBundle(plan)],
    assets,
  ]);
  await assert.rejects(
    createPostgresAutoListingAiPhaseContextLoader(dependencies(pool))(message("GENERATE_RICH_CONTENT")),
    { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false },
  );
});

test("database and malformed evidence failures expose only fixed safe codes", async () => {
  const db = scriptedPool([new Error("password=raw-secret database.internal")]);
  await assert.rejects(
    createPostgresAutoListingAiPhaseContextLoader(dependencies(db))(message("PLAN_CONTENT")),
    (error) => error?.code === "AUTO_LISTING_AI_PHASE_CONTEXT_DB_FAILED"
      && error.retryable === true && !/password|secret|internal/iu.test(error.message),
  );

  const malformed = scriptedPool([[boundary({ job_id: "job other" })]]);
  await assert.rejects(
    createPostgresAutoListingAiPhaseContextLoader(dependencies(malformed))(message("PLAN_CONTENT")),
    (error) => error?.code === "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID"
      && error.retryable === false,
  );
});

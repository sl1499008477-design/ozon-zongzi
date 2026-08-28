import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import {
  createPostgresAutoListingAiContextLoader,
  createPostgresAutoListingAiPhaseContextLoader,
  projectAutoListingGenerationReferences,
} from "../auto-listing-ai-phase-context-postgres.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { sha256 } from "../auto-listing-asset-store.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const H = (character) => character.repeat(64);
const PROHIBITED = ["CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY"];

function message(phase, overrides = {}) {
  return {
    contractVersion: "V1",
    accountId: "account-a",
    itemId: "item-a",
    phase,
    expectedStatusVersion: 7,
    correlationId: "correlation-a",
    ...(phase === "MATERIALIZE_SOURCE_ASSET" ? { sourceAssetId: "source-a" } : {}),
    ...(phase === "GENERATE_IMAGE_SLOT" ? { slotKey: "main-1" } : {}),
    ...overrides,
  };
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
    regeneration: null,
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
    "planningContract", "evidenceRepository",
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
  assert.deepEqual(pool.calls[1].values, ["account-a", "job-a", "item-a", "snapshot-a"]);
  assert.match(pool.calls[1].sql,
    /p\.account_id=j\.account_id\s+AND\s+p\.id=j\.ai_profile_id\s+AND\s+p\.config_version=j\.ai_profile_version/iu);
  assert.match(pool.calls[1].sql, /p\.connection_id AS profile_connection_id/iu);
  assert.match(pool.calls[1].sql, /p\.connection_version AS profile_connection_version/iu);
  assert.doesNotMatch(pool.calls[1].sql, /p\.enabled IS TRUE/iu);
  assert.doesNotMatch(pool.calls[1].sql, /ORDER\s+BY|LIMIT\s+1/iu);
  assert.deepEqual(pool.calls[2].values, ["account-a", "strategy-v1"]);
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
  assert.deepEqual(pool.calls[1].values, ["account-a", "job-a", "item-a", "plan-derived", "snapshot-a"]);
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
  assert.equal(context.phaseInput.maxAttempts, 2);
  assert.equal(context.phaseInput.categoryStyle.textDensity, "NONE");
  assert.equal(context.phaseInput.categoryStyle.composition, "SELLING_POINT composition");
  assert.equal(context.phaseInput.categoryStyle.background, "SELLING_POINT background");
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
  assert.deepEqual(pool.calls[2].values, ["account-a", "job-a", "item-a", "plan-derived"]);
  assert.match(pool.calls[2].sql, /status='ACCEPTED'/u);
  assert.doesNotMatch(pool.calls[2].sql, /latest|ORDER\s+BY.*created|LIMIT\s+1/iu);
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

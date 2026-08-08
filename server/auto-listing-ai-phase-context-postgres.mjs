import crypto from "node:crypto";

import { resolveAiContentStrategy } from "./ai-content-strategy.mjs";
import {
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";
import { buildVisualGroups } from "./auto-listing-visual-groups.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const MAX_VERSION = 2_147_483_647;
const PHASE_STATUS = Object.freeze({
  PLAN_CONTENT: "PLANNING",
  MATERIALIZE_SOURCE_ASSET: "PLANNING",
  FINALIZE_MATERIALIZED_PLAN: "PLANNING",
  GENERATE_IMAGE_SLOT: "GENERATING",
  GENERATE_RICH_CONTENT: "GENERATING",
});
const REQUIRED_PROHIBITED_CLAIMS = Object.freeze([
  "CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY",
]);
const FACTORY_KEYS = new Set([
  "pool", "gateway", "contentPlanRepository", "sourceMaterializationRepository",
  "generationRepository", "richContentRepository", "downloader", "storage",
  "sourceAssetLoader", "logger", "planPromptTemplateVersion", "prohibitedClaims",
  "maxAttempts", "richContentLeaseOwner",
]);
const PLAN_COLUMNS = `
  p.id,p.account_id,p.job_id,p.item_id,p.source_snapshot_id,p.strategy_version_id,p.profile_id,
  p.strategy_hash,p.config_hash,p.source_hash,p.input_hash,p.planner_model,p.profile_version,
  p.prompt_template_version,p.plan,p.plan_hash,p.visual_groups_hash,p.visual_groups,p.fact_registry,
  p.regeneration,p.gateway_request_id,p.parent_plan_id,p.derivation_kind,p.materialization_set_hash`;

function contextError(code, retryable = false) {
  const error = new Error("自动上架 AI 阶段资料暂时无法读取");
  error.code = code;
  error.retryable = retryable;
  return error;
}

const invalid = () => contextError("AUTO_LISTING_AI_PHASE_CONTEXT_INVALID", false);
const evidenceInvalid = () => contextError("AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", false);
const databaseFailed = () => contextError("AUTO_LISTING_AI_PHASE_CONTEXT_DB_FAILED", true);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validVersion(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_VERSION;
}

function validHash(value) {
  return typeof value === "string" && HASH.test(value);
}

function validText(value, maxBytes = 240) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function jsonValue(value) {
  if (plainObject(value) || Array.isArray(value) || value === null) return value;
  if (typeof value !== "string") throw evidenceInvalid();
  try {
    const parsed = JSON.parse(value);
    if (!plainObject(parsed) && !Array.isArray(parsed) && parsed !== null) throw evidenceInvalid();
    return parsed;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID") throw error;
    throw evidenceInvalid();
  }
}

function exactSingleRow(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1 || !plainObject(result.rows[0])) {
    throw evidenceInvalid();
  }
  return result.rows[0];
}

function zeroOrOneRow(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length > 1) throw evidenceInvalid();
  return result.rows[0] || null;
}

function normalizeBoundary(row, message) {
  if (!plainObject(row) || !isSafeAutoListingAiIdentifier(row.job_id)
    || !validText(row.status, 64) || !validVersion(row.status_version)
    || !isSafeAutoListingAiIdentifier(row.snapshot_id)
    || !(row.active_content_plan_id === null || isSafeAutoListingAiIdentifier(row.active_content_plan_id))) {
    throw evidenceInvalid();
  }
  return Object.freeze({
    accountId: message.accountId,
    jobId: row.job_id,
    itemId: message.itemId,
    status: row.status,
    statusVersion: row.status_version,
    activeContentPlanId: row.active_content_plan_id,
    snapshotId: row.snapshot_id,
  });
}

function closedContext(boundary, phaseInput = {}) {
  return Object.freeze({
    accountId: boundary.accountId,
    jobId: boundary.jobId,
    itemId: boundary.itemId,
    status: boundary.status,
    statusVersion: boundary.statusVersion,
    activeContentPlanId: boundary.activeContentPlanId,
    phaseInput: Object.freeze(phaseInput),
  });
}

function sourceCapture(row) {
  const capture = {
    snapshot: jsonValue(row.snapshot),
    snapshotHash: row.snapshot_hash,
    rawResponseRef: row.raw_response_ref,
  };
  if (!plainObject(capture.snapshot) || !validHash(capture.snapshotHash)
    || !(capture.rawResponseRef === null || validText(capture.rawResponseRef, 2048))) throw evidenceInvalid();
  return capture;
}

function configCapture(row) {
  const capture = {
    configSnapshot: jsonValue(row.config_snapshot),
    configHash: row.config_hash_from_job,
  };
  if (!plainObject(capture.configSnapshot) || !validHash(capture.configHash)) throw evidenceInvalid();
  return capture;
}

function gatewayProfile(row) {
  const profile = {
    id: row.profile_id,
    accountId: row.profile_account_id,
    configVersion: row.profile_config_version,
    baseUrl: row.profile_base_url,
    apiKeyEnvName: row.profile_api_key_env_name,
    textProtocol: row.profile_text_protocol,
    imageProtocol: row.profile_image_protocol,
    textModel: row.profile_text_model,
    imageModel: row.profile_image_model,
    connectionId: row.profile_connection_id ?? null,
    connectionVersion: row.profile_connection_version === null || row.profile_connection_version === undefined
      ? null : Number(row.profile_connection_version),
    // The job already froze this exact profile version while it was enabled. A later publication
    // may disable the profile row, but must not silently switch or invalidate in-flight jobs.
    enabled: true,
  };
  const encryptedReference = profile.apiKeyEnvName === "SUB2API_ENCRYPTED_KEY";
  const hasConnection = profile.connectionId !== null || profile.connectionVersion !== null;
  if (![profile.id, profile.accountId].every(isSafeAutoListingAiIdentifier)
    || !validVersion(profile.configVersion) || !validText(profile.baseUrl, 2048)
    || !validText(profile.apiKeyEnvName) || !validText(profile.textProtocol)
    || !validText(profile.imageProtocol) || !validText(profile.textModel)
    || !validText(profile.imageModel)
    || (hasConnection && (!isSafeAutoListingAiIdentifier(profile.connectionId)
      || !validVersion(profile.connectionVersion)))
    || encryptedReference !== hasConnection) throw evidenceInvalid();
  return Object.freeze(profile);
}

function mapRule(row) {
  if (!plainObject(row) || !isSafeAutoListingAiIdentifier(row.id)
    || !Number.isInteger(Number(row.rule_order)) || Number(row.rule_order) < 1
    || !validText(row.rule_kind, 64) || !plainObject(jsonValue(row.rule))) throw evidenceInvalid();
  const rule = jsonValue(row.rule);
  return {
    ruleId: row.id,
    ruleOrder: Number(row.rule_order),
    matchType: row.rule_kind,
    categoryId: row.rule_kind === "ANCESTOR_CATEGORY" ? row.ancestor_category_id : row.category_id,
    productStyle: row.product_style,
    style: rule.style,
    textDensityByRole: rule.textDensityByRole,
  };
}

function strategyCapture(row, ruleRows, capture) {
  if (!isSafeAutoListingAiIdentifier(row.strategy_version_id)
    || !isSafeAutoListingAiIdentifier(row.strategy_key)) throw evidenceInvalid();
  let strategySnapshot;
  try {
    const source = capture.snapshot;
    strategySnapshot = resolveAiContentStrategy({
      strategyVersion: { strategyId: row.strategy_key, strategyVersionId: row.strategy_version_id },
      rules: ruleRows.map(mapRule),
      product: {
        descriptionCategoryId: source.targetCategory?.descriptionCategoryId,
        categoryAncestors: (source.targetCategory?.ancestorCategoryIds || [])
          .map((categoryId, index) => ({ categoryId, distance: index + 1 })),
        productStyle: source.source?.productStyle,
      },
    });
  } catch {
    throw evidenceInvalid();
  }
  return Object.freeze({ strategySnapshot, strategyHash: sha256(strategySnapshot) });
}

function mapPlan(row, { rich = false } = {}) {
  const base = {
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
    plan: jsonValue(row.plan),
    planHash: row.plan_hash,
    visualGroupsHash: row.visual_groups_hash,
    visualGroups: jsonValue(row.visual_groups),
    factRegistry: jsonValue(row.fact_registry),
    regeneration: jsonValue(row.regeneration),
    gatewayRequestId: row.gateway_request_id,
  };
  if ([base.id, base.sourceAccountId, base.jobId, base.itemId, base.sourceSnapshotId,
    base.strategyVersionId, base.profileId].some((value) => !isSafeAutoListingAiIdentifier(value))
    || !validVersion(base.profileVersion)
    || [base.strategyHash, base.configHash, base.sourceHash, base.inputHash, base.planHash,
      base.visualGroupsHash].some((value) => !validHash(value))
    || !validText(base.plannerModel) || !validText(base.promptTemplateVersion)
    || !plainObject(base.plan) || !plainObject(base.visualGroups) || !Array.isArray(base.factRegistry)
    || !(base.regeneration === null || plainObject(base.regeneration))
    || !(base.gatewayRequestId === null || validText(base.gatewayRequestId))) throw evidenceInvalid();
  const derived = row.parent_plan_id === null ? base : {
    ...base,
    parentPlanId: row.parent_plan_id,
    derivationKind: row.derivation_kind,
    materializationSetHash: row.materialization_set_hash,
  };
  if (row.parent_plan_id !== null
    && (!isSafeAutoListingAiIdentifier(derived.parentPlanId)
      || derived.derivationKind !== "SOURCE_MATERIALIZATION"
      || !validHash(derived.materializationSetHash))) throw evidenceInvalid();
  return rich ? { ...derived, accountId: base.sourceAccountId, planId: base.id } : derived;
}

function assertPlanScope(plan, boundary) {
  if (plan.sourceAccountId !== boundary.accountId || plan.jobId !== boundary.jobId
    || plan.itemId !== boundary.itemId || plan.sourceSnapshotId === undefined
    || plan.id !== boundary.activeContentPlanId) throw evidenceInvalid();
}

function generationSize(ratio, resolution) {
  const longEdge = { "1K": 1024, "2K": 2048, "4K": 4096 }[resolution];
  const parts = typeof ratio === "string" ? ratio.match(/^(16|9|2|3|1|4):(9|16|3|2|1|4|3)$/u) : null;
  if (!longEdge || !parts) throw evidenceInvalid();
  const left = Number(parts[1]);
  const right = Number(parts[2]);
  if (left === right) return `${longEdge}x${longEdge}`;
  return left > right
    ? `${longEdge}x${Math.round(longEdge * right / left)}`
    : `${Math.round(longEdge * left / right)}x${longEdge}`;
}

function findSlot(plan, slotKey) {
  const slots = Array.isArray(plan.plan?.slots)
    ? plan.plan.slots.filter((slot) => plainObject(slot) && slot.slotKey === slotKey) : [];
  if (slots.length !== 1) throw evidenceInvalid();
  return slots[0];
}

function mapAcceptedAsset(row) {
  if (!plainObject(row)) throw evidenceInvalid();
  return {
    id: row.id,
    status: row.status,
    accountId: row.account_id,
    jobId: row.job_id,
    itemId: row.item_id,
    planId: row.plan_id,
    visualGroupKey: row.visual_group_key,
    slotKey: row.slot_key,
    role: row.role,
    attemptIdentityHash: row.attempt_identity_hash,
    attemptNo: row.attempt_no,
    inputHash: row.input_hash,
    generationSize: row.generation_size,
    contentHash: row.content_hash,
    objectKeyVersion: row.object_key_version,
    objectKey: row.object_key,
    contentType: row.content_type,
    width: row.width,
    height: row.height,
    size: Number(row.size_bytes),
    gatewayRequestId: row.gateway_request_id,
    checkerRequestId: row.checker_request_id,
    modelEvidence: jsonValue(row.model_evidence),
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    modelName: row.model_name,
    planHash: row.plan_hash,
    sourceHash: row.source_hash,
    strategyHash: row.strategy_hash,
    configHash: row.config_hash,
    visualGroupsHash: row.visual_groups_hash,
    promptTemplateVersion: row.prompt_template_version,
    promptHash: row.prompt_hash,
    checkerEvidence: jsonValue(row.checker_result),
    sourceAssetEvidence: jsonValue(row.source_asset_evidence),
    regeneration: jsonValue(row.regeneration),
  };
}

function validateOptions(options) {
  if (!plainObject(options) || !options.pool || typeof options.pool.query !== "function"
    || typeof options.pool.connect !== "function"
    || Object.keys(options).length !== FACTORY_KEYS.size
    || Object.keys(options).some((key) => !FACTORY_KEYS.has(key))
    || !validText(options.planPromptTemplateVersion)
    || !Array.isArray(options.prohibitedClaims)
    || options.prohibitedClaims.length !== REQUIRED_PROHIBITED_CLAIMS.length
    || REQUIRED_PROHIBITED_CLAIMS.some((claim) => !options.prohibitedClaims.includes(claim))
    || !validVersion(options.maxAttempts) || options.maxAttempts > 3
    || !isSafeAutoListingAiIdentifier(options.richContentLeaseOwner)) throw invalid();
  for (const key of ["gateway", "contentPlanRepository", "sourceMaterializationRepository",
    "generationRepository", "richContentRepository", "downloader", "storage", "sourceAssetLoader"]) {
    if (!options[key] || typeof options[key] !== "object") throw invalid();
  }
  if (!(options.logger === null || typeof options.logger === "object")) throw invalid();
}

async function safeQuery(pool, sql, values) {
  try {
    return await pool.query(sql, values);
  } catch {
    throw databaseFailed();
  }
}

async function loadBoundary(pool, message) {
  const result = await safeQuery(pool,
    `SELECT i.job_id,i.status,i.status_version,i.active_content_plan_id,i.snapshot_id
       FROM auto_listing_job_items i
       JOIN auto_listing_jobs j ON j.account_id=i.account_id AND j.id=i.job_id
      WHERE i.account_id=$1 AND i.id=$2
      FOR SHARE OF i`,
    [message.accountId, message.itemId]);
  const row = zeroOrOneRow(result);
  return row ? normalizeBoundary(row, message) : null;
}

async function loadPlanInput(options, message, boundary) {
  const bundle = exactSingleRow(await safeQuery(options.pool,
    `SELECT s.snapshot,s.snapshot_hash,s.raw_response_ref,
            j.config_snapshot,j.config_hash AS config_hash_from_job,j.strategy_version_id,
            v.strategy_key,
            command.id AS regeneration_request_id,
            p.id AS profile_id,p.account_id AS profile_account_id,p.config_version AS profile_config_version,
            p.base_url AS profile_base_url,p.api_key_env_name AS profile_api_key_env_name,
            p.text_protocol AS profile_text_protocol,p.image_protocol AS profile_image_protocol,
            p.text_model AS profile_text_model,p.image_model AS profile_image_model,p.enabled AS profile_enabled,
            p.connection_id AS profile_connection_id,p.connection_version AS profile_connection_version
       FROM auto_listing_job_items i
       JOIN auto_listing_jobs j ON j.account_id=i.account_id AND j.id=i.job_id
       JOIN auto_listing_source_snapshots s ON s.account_id=i.account_id AND s.id=i.snapshot_id
       JOIN ai_content_strategy_versions v ON v.account_id=j.account_id AND v.id=j.strategy_version_id
       JOIN ai_gateway_profiles p ON p.account_id=j.account_id AND p.id=j.ai_profile_id
                                 AND p.config_version=j.ai_profile_version
       LEFT JOIN auto_listing_user_commands AS command
         ON command.account_id=i.account_id AND command.job_id=i.job_id AND command.item_id=i.id
        AND command.action='REGENERATE' AND command.result_status='PLANNING'
        AND command.result_status_version=i.status_version
      WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3 AND i.snapshot_id=$4`,
    [boundary.accountId, boundary.jobId, boundary.itemId, boundarySnapshot(boundary)]));
  const capture = sourceCapture(bundle);
  const rulesResult = await safeQuery(options.pool,
    `SELECT id,rule_order,rule_kind,category_id,ancestor_category_id,product_style,rule
       FROM ai_content_strategy_rules
      WHERE account_id=$1 AND strategy_version_id=$2
      ORDER BY rule_order ASC,id ASC`,
    [boundary.accountId, bundle.strategy_version_id]);
  if (!rulesResult || !Array.isArray(rulesResult.rows)) throw evidenceInvalid();
  let visualGroupsCapture;
  try { visualGroupsCapture = buildVisualGroups({ sourceCapture: capture }); } catch { throw evidenceInvalid(); }
  const regenerationRequestId = bundle.regeneration_request_id ?? null;
  if (!(regenerationRequestId === null || isSafeAutoListingAiIdentifier(regenerationRequestId))) {
    throw evidenceInvalid();
  }
  return {
    sourceSnapshotId: boundarySnapshot(boundary),
    gatewayProfile: gatewayProfile(bundle),
    gateway: options.gateway,
    repository: options.contentPlanRepository,
    sourceCapture: capture,
    strategyCapture: strategyCapture(bundle, rulesResult.rows, capture),
    configCapture: configCapture(bundle),
    visualGroupsCapture,
    promptTemplateVersion: options.planPromptTemplateVersion,
    prohibitedClaims: [...options.prohibitedClaims].sort(),
    regeneration: regenerationRequestId === null ? null : {
      requestId: regenerationRequestId,
      reason: "USER_REQUESTED",
    },
  };
}

function boundarySnapshot(boundary) {
  return boundary.snapshotId;
}

async function loadActiveBundle(options, boundary) {
  if (!isSafeAutoListingAiIdentifier(boundary.activeContentPlanId)) throw evidenceInvalid();
  return exactSingleRow(await safeQuery(options.pool,
    `SELECT ${PLAN_COLUMNS},
            s.snapshot,s.snapshot_hash,s.raw_response_ref,
            j.config_snapshot,j.config_hash AS config_hash_from_job,
            gp.id AS profile_id,gp.account_id AS profile_account_id,gp.config_version AS profile_config_version,
            gp.base_url AS profile_base_url,gp.api_key_env_name AS profile_api_key_env_name,
            gp.text_protocol AS profile_text_protocol,gp.image_protocol AS profile_image_protocol,
            gp.text_model AS profile_text_model,gp.image_model AS profile_image_model,gp.enabled AS profile_enabled,
            gp.connection_id AS profile_connection_id,gp.connection_version AS profile_connection_version
       FROM auto_listing_job_items i
       JOIN auto_listing_jobs j ON j.account_id=i.account_id AND j.id=i.job_id
       JOIN ai_content_plans p ON p.account_id=i.account_id AND p.job_id=i.job_id
                              AND p.item_id=i.id AND p.id=i.active_content_plan_id
       JOIN auto_listing_source_snapshots s ON s.account_id=i.account_id AND s.id=i.snapshot_id
                                           AND s.id=p.source_snapshot_id
       JOIN ai_gateway_profiles gp ON gp.account_id=p.account_id AND gp.id=p.profile_id
                                  AND gp.config_version=p.profile_version
      WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3
        AND i.active_content_plan_id=$4 AND i.snapshot_id=$5`,
    [boundary.accountId, boundary.jobId, boundary.itemId, boundary.activeContentPlanId,
      boundarySnapshot(boundary)]));
}

function assertSourceAssetInPlan(plan, sourceAssetId) {
  const references = Array.isArray(plan.visualGroups?.groups)
    ? plan.visualGroups.groups.flatMap((group) => Array.isArray(group?.referenceImages)
      ? group.referenceImages : []) : [];
  if (references.filter((entry) => entry?.assetId === sourceAssetId).length !== 1) throw evidenceInvalid();
}

async function loadMaterializeInput(options, message, boundary) {
  const row = await loadActiveBundle(options, boundary);
  const parentPlan = mapPlan(row);
  assertPlanScope(parentPlan, boundary);
  assertSourceAssetInPlan(parentPlan, message.sourceAssetId);
  return {
    parentPlan,
    sourceSnapshot: {
      accountId: boundary.accountId,
      jobId: boundary.jobId,
      itemId: boundary.itemId,
      sourceSnapshotId: boundarySnapshot(boundary),
      sourceCapture: sourceCapture(row),
    },
    policy: undefined,
    repository: options.sourceMaterializationRepository,
    downloader: options.downloader,
    storage: options.storage,
    logger: options.logger,
  };
}

async function loadFinalizeInput(options, boundary) {
  const parentPlan = mapPlan(await loadActiveBundle(options, boundary));
  assertPlanScope(parentPlan, boundary);
  return { parentPlan, repository: options.contentPlanRepository };
}

function assertDerivedPlan(plan) {
  if (plan.derivationKind !== "SOURCE_MATERIALIZATION"
    || !isSafeAutoListingAiIdentifier(plan.parentPlanId)
    || !validHash(plan.materializationSetHash)
    || !Array.isArray(plan.visualGroups?.groups)
    || plan.visualGroups.groups.flatMap((group) => group?.referenceImages || [])
      .some((entry) => entry?.evidenceKind !== "CONTENT_HASH" || !validHash(entry?.contentHash))) {
    throw evidenceInvalid();
  }
}

async function loadImageInput(options, message, boundary) {
  const row = await loadActiveBundle(options, boundary);
  const plan = mapPlan(row);
  assertPlanScope(plan, boundary);
  assertDerivedPlan(plan);
  const config = configCapture(row).configSnapshot;
  const profile = gatewayProfile(row);
  const ratio = config.image?.ratio;
  const resolution = config.image?.resolution;
  return {
    plan,
    slot: findSlot(plan, message.slotKey),
    sourceAssetLoader: options.sourceAssetLoader,
    repository: options.generationRepository,
    gateway: options.gateway,
    profile,
    imageModel: profile.imageModel,
    ratio,
    resolution,
    size: generationSize(ratio, resolution),
    quality: typeof config.image?.quality === "string" ? config.image.quality.toLowerCase() : null,
    templateVersion: plan.promptTemplateVersion,
    regeneration: plan.regeneration,
    storage: options.storage,
    logger: options.logger,
    maxAttempts: options.maxAttempts,
  };
}

async function loadAcceptedAssets(options, boundary) {
  const result = await safeQuery(options.pool,
    `SELECT id,account_id,job_id,item_id,plan_id,visual_group_key,slot_key,role,
            attempt_identity_hash,attempt_no,input_hash,generation_size,status,content_hash,
            object_key_version,object_key,content_type,width,height,size_bytes,gateway_request_id,
            checker_request_id,model_evidence,profile_id,profile_version,model_name,plan_hash,
            source_hash,strategy_hash,config_hash,visual_groups_hash,prompt_template_version,
            prompt_hash,checker_result,source_asset_evidence,regeneration
       FROM ai_generation_assets
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND status='ACCEPTED'
      ORDER BY slot_key ASC,id ASC`,
    [boundary.accountId, boundary.jobId, boundary.itemId, boundary.activeContentPlanId]);
  if (!result || !Array.isArray(result.rows)) throw evidenceInvalid();
  const assets = result.rows.map(mapAcceptedAsset);
  const ids = new Set();
  const slots = new Set();
  for (const asset of assets) {
    if (asset.accountId !== boundary.accountId || asset.jobId !== boundary.jobId
      || asset.itemId !== boundary.itemId || asset.planId !== boundary.activeContentPlanId
      || asset.status !== "ACCEPTED" || !isSafeAutoListingAiIdentifier(asset.id)
      || !isSafeAutoListingAiIdentifier(asset.slotKey) || ids.has(asset.id) || slots.has(asset.slotKey)) {
      throw evidenceInvalid();
    }
    ids.add(asset.id);
    slots.add(asset.slotKey);
  }
  return assets;
}

async function loadRichInput(options, boundary) {
  const row = await loadActiveBundle(options, boundary);
  const plan = mapPlan(row, { rich: true });
  assertPlanScope(plan, boundary);
  assertDerivedPlan(plan);
  const acceptedAssets = await loadAcceptedAssets(options, boundary);
  const plannedSlots = new Map(plan.plan.slots.map((slot) => [slot?.slotKey, slot]));
  const plannedGroups = new Set(plan.visualGroups.groups.map((group) => group?.visualGroupKey));
  if (plannedSlots.size !== plan.plan.slots.length || acceptedAssets.length < 6
    || plannedGroups.size !== plan.visualGroups.groups.length || plannedGroups.size < 1) throw evidenceInvalid();
  const assetsByGroup = new Map([...plannedGroups].map((key) => [key, []]));
  for (const asset of acceptedAssets) {
    const slot = plannedSlots.get(asset.slotKey);
    if (!slot || slot.visualGroupKey !== asset.visualGroupKey || slot.role !== asset.role
      || !assetsByGroup.has(asset.visualGroupKey)) throw evidenceInvalid();
    assetsByGroup.get(asset.visualGroupKey).push(asset);
  }
  if ([...assetsByGroup.values()].some((assets) => assets.length < 6 || assets.length > 13
    || assets.filter((asset) => asset.role === "MAIN").length !== 1)) throw evidenceInvalid();
  return {
    plan,
    profile: gatewayProfile(row),
    gateway: options.gateway,
    repository: options.richContentRepository,
    factRegistry: plan.factRegistry,
    acceptedAssets,
    planHash: plan.planHash,
    sourceHash: plan.sourceHash,
    promptTemplateVersion: plan.promptTemplateVersion,
    maxAttempts: options.maxAttempts,
    leaseOwner: options.richContentLeaseOwner,
  };
}

export function createPostgresAutoListingAiPhaseContextLoader(options = {}) {
  validateOptions(options);
  return async function loadContext(rawMessage) {
    let message;
    try { message = normalizeAutoListingAiMessage(rawMessage); } catch { throw invalid(); }
    let client;
    let transactionOpen = false;
    try {
      client = await options.pool.connect();
      if (!client || typeof client.query !== "function" || typeof client.release !== "function") throw databaseFailed();
      await client.query("BEGIN");
      transactionOpen = true;
      const runtimeOptions = { ...options, pool: client };
      const boundary = await loadBoundary(client, message);
      let result;
      if (boundary === null) result = null;
      // Keep stale and cancelled deliveries cheap and closed. The worker ACKs
      // them before orchestration, so no phase evidence is loaded.
      else if (boundary.status === "CANCELLED"
        || boundary.statusVersion !== message.expectedStatusVersion
        || boundary.status !== PHASE_STATUS[message.phase]) result = closedContext(boundary);
      else {
        let phaseInput;
        if (message.phase === "PLAN_CONTENT") phaseInput = await loadPlanInput(runtimeOptions, message, boundary);
        else if (message.phase === "MATERIALIZE_SOURCE_ASSET") phaseInput = await loadMaterializeInput(runtimeOptions, message, boundary);
        else if (message.phase === "FINALIZE_MATERIALIZED_PLAN") phaseInput = await loadFinalizeInput(runtimeOptions, boundary);
        else if (message.phase === "GENERATE_IMAGE_SLOT") phaseInput = await loadImageInput(runtimeOptions, message, boundary);
        else phaseInput = await loadRichInput(runtimeOptions, boundary);
        result = closedContext(boundary, phaseInput);
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try { await client?.query("ROLLBACK"); } catch {}
      }
      if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_AI_PHASE_CONTEXT_")) throw error;
      throw databaseFailed();
    } finally {
      try { client?.release(); } catch {}
    }
  };
}

export const createPostgresAutoListingAiContextLoader = createPostgresAutoListingAiPhaseContextLoader;

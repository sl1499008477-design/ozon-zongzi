import crypto from "node:crypto";
import { types } from "node:util";

import { resolveAiContentStrategy } from "./ai-content-strategy.mjs";
import {
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";
import { inspectSourceListingImage } from "./auto-listing-asset-store.mjs";
import {
  AUTO_LISTING_AI_WORK_CONTRACT_VERSION,
  normalizeAutoListingAiWorkMessage,
} from "./auto-listing-ai-work-message.mjs";
import { buildVisualGroups } from "./auto-listing-visual-groups.mjs";
import { buildSourceImageAnalysisBatches } from "./auto-listing-source-image-analyzer.mjs";
import {
  enumerateSourceImageAssets,
  verifySourceImageIntelligenceSummary,
} from "./auto-listing-source-image-intelligence-contract.mjs";
import { deriveSourceImageCleanupAttempt } from "./auto-listing-source-image-cleanup-contract.mjs";
import { loadStoredSourceImageDerivative } from "./auto-listing-source-image-derivative-store.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const MAX_VERSION = 2_147_483_647;
const MINIMUM_ACCEPTED_IMAGES_PER_GROUP = 6;
const LOAD_CONTEXT_KEYS = new Set(["message", "execution"]);
const MATERIALIZE_CONTEXT_KEYS = new Set(["message", "execution", "phaseAttempt"]);
const PHASE_ATTEMPT_KEYS = new Set(["attemptNo", "maxAttempts"]);
const PHASE_STATUS = Object.freeze({
  PLAN_CONTENT: "PLANNING",
  MATERIALIZE_SOURCE_ASSET: "PLANNING",
  ANALYZE_SOURCE_IMAGE_BATCH: "PLANNING",
  CLEAN_SOURCE_IMAGE_OVERLAY: "PLANNING",
  CHECK_SOURCE_IMAGE_CLEANUP: "PLANNING",
  RECONCILE_SOURCE_IMAGE_ANALYSIS: "PLANNING",
  FINALIZE_MATERIALIZED_PLAN: "PLANNING",
  GENERATE_IMAGE_SLOT: "GENERATING",
  CHECK_IMAGE_GROUP: "GENERATING",
  GENERATE_RICH_CONTENT: "GENERATING",
});
const REQUIRED_PROHIBITED_CLAIMS = Object.freeze([
  "CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY",
]);
const FACTORY_KEYS = new Set([
  "pool", "gateway", "contentPlanRepository", "contentPlanEvidenceRepository", "sourceMaterializationRepository",
  "generationRepository", "richContentRepository", "downloader", "storage",
  "sourceAssetLoader", "logger", "planPromptTemplateVersion", "prohibitedClaims",
  "maxAttempts", "richContentMaxAttempts", "richContentLeaseOwner", "referenceProjector",
  "sourceImageIntelligenceRepository", "sourceAnalysisAssetLoader", "imageGroupChecker",
  "imageGroupCheckRepository", "sourceImageDerivativeRepository",
]);
const OPTIONAL_FACTORY_KEYS = new Set([
  "sourceImageIntelligenceRepository", "sourceAnalysisAssetLoader", "imageGroupChecker",
  "imageGroupCheckRepository", "sourceImageDerivativeRepository",
]);
const REFERENCE_PROJECTOR_KEYS = new Set([
  "accountId", "jobId", "itemId", "planId", "plan", "slot",
]);
const REFERENCE_KEYS = new Set([
  "assetId", "sourceRefHash", "contentHash", "sourceRef", "evidenceKind",
]);
const GENERATION_PLAN_KEYS = new Set([
  "id", "sourceAccountId", "jobId", "itemId", "sourceSnapshotId", "strategyVersionId", "profileId",
  "strategyHash", "configHash", "sourceHash", "inputHash", "plannerModel", "profileVersion",
  "promptTemplateVersion", "plan", "planHash", "visualGroupsHash", "visualGroups", "factRegistry",
  "regeneration", "gatewayRequestId", "planningContract", "skeletonHash", "parentPlanId",
  "derivationKind", "materializationSetHash",
]);
const GENERATION_PLAN_KEYS_SOURCE_IMAGE = new Set([
  ...GENERATION_PLAN_KEYS, "sourceImageAnalysisRunId", "sourceImageIntelligenceHash",
]);
const PLAN_BODY_KEYS = new Set(["version", "language", "slots"]);
const SLOT_KEYS_V1 = new Set([
  "slotKey", "visualGroupKey", "role", "order", "textDensity", "claims", "sourceFactIds",
  "referenceAssetIds", "preserve", "prohibitedClaims",
]);
const SLOT_KEYS_V2 = new Set([...SLOT_KEYS_V1, "requestedRole", "substitutionReasonCode"]);
const SLOT_KEYS_V3 = new Set([
  ...SLOT_KEYS_V2,
  "targetView", "evidenceMode", "prohibitedViews", "prohibitedOverlayTexts",
  "identityAssetId", "selectionReasonCodes",
]);
const CLAIM_KEYS = new Set(["text", "claimType", "sourceFactIds"]);
const VISUAL_GROUPS_KEYS = new Set(["sourceHash", "visualGroupsHash", "reasonCodes", "groups"]);
const VISUAL_GROUP_KEYS = new Set([
  "visualGroupKey", "sourceSkus", "variantIds", "referenceImages", "factEvidence", "reasonCodes",
]);
const VISUAL_FACT_KEYS = new Set(["factId", "kind", "value"]);
const FACT_REGISTRY_KEYS = new Set(["factId", "kind", "value", "sourcePath", "visualGroupKeys"]);
const FACT_REGISTRY_DICTIONARY_KEYS = new Set([...FACT_REGISTRY_KEYS, "dictionaryValueId"]);
const LEGACY_FACT_REGISTRY_KEYS = new Set([
  ...FACT_REGISTRY_DICTIONARY_KEYS, "field", "numericValue", "unit",
]);
const REGENERATION_KEYS = new Set(["requestId", "reason"]);
const ROLES = new Set(["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]);
const TEXT_DENSITIES = new Set(["NONE", "LIGHT", "MEDIUM", "HEAVY"]);
const TARGET_VIEWS = new Set([
  "FRONT", "BACK", "LEFT", "RIGHT", "FRONT_LEFT_3_4", "FRONT_RIGHT_3_4",
  "BACK_LEFT_3_4", "BACK_RIGHT_3_4", "TOP", "BOTTOM", "INTERIOR", "DETAIL", "SCENE", "PACKAGE", "ROTATIONAL",
]);
const EVIDENCE_MODES = new Set([
  "DIRECT", "ADJACENT", "COMPOSITION_ONLY", "SUBSTITUTED", "SYNTHESIZED_SAFE",
]);
const PLAN_COLUMNS = `
  p.id,p.account_id,p.job_id,p.item_id,p.source_snapshot_id,p.strategy_version_id,p.profile_id,
  p.strategy_hash,p.config_hash,p.source_hash,p.input_hash,p.planner_model,p.profile_version,
  p.prompt_template_version,p.plan,p.plan_hash,p.visual_groups_hash,p.visual_groups,p.fact_registry,
  p.regeneration,p.gateway_request_id,p.parent_plan_id,p.derivation_kind,p.materialization_set_hash,
  p.planning_contract,p.skeleton_hash,p.source_image_analysis_run_id,p.source_image_intelligence_hash`;

function contextError(code, retryable = false) {
  const error = new Error("自动上架 AI 阶段资料暂时无法读取");
  error.code = code;
  error.retryable = retryable;
  return error;
}

const invalid = () => contextError("AUTO_LISTING_AI_PHASE_CONTEXT_INVALID", false);
const evidenceInvalid = () => contextError("AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", false);
const databaseFailed = () => contextError("AUTO_LISTING_AI_PHASE_CONTEXT_DB_FAILED", true);
const forbiddenCategoryReference = () => contextError("AUTO_LISTING_CATEGORY_STRATEGY_REFERENCE_FORBIDDEN", false);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !types.isProxy(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactObject(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function normalizeContextRequest(raw) {
  if (!exactObject(raw, LOAD_CONTEXT_KEYS) && !exactObject(raw, MATERIALIZE_CONTEXT_KEYS)) throw invalid();
  let message;
  try { message = normalizeAutoListingAiMessage(raw.message); } catch { throw invalid(); }
  let phaseAttempt = null;
  if (Object.hasOwn(raw, "phaseAttempt")) {
    if (message.phase !== "MATERIALIZE_SOURCE_ASSET" || !exactObject(raw.phaseAttempt, PHASE_ATTEMPT_KEYS)
      || !Number.isInteger(raw.phaseAttempt.attemptNo) || raw.phaseAttempt.attemptNo < 1
      || raw.phaseAttempt.maxAttempts !== 3 || raw.phaseAttempt.attemptNo > raw.phaseAttempt.maxAttempts) throw invalid();
    phaseAttempt = Object.freeze({ ...raw.phaseAttempt });
  }
  if (raw.execution === null) return Object.freeze({ message, execution: null, phaseAttempt });
  try {
    const work = normalizeAutoListingAiWorkMessage({
      workContractVersion: AUTO_LISTING_AI_WORK_CONTRACT_VERSION,
      message,
      execution: raw.execution,
    });
    return Object.freeze({ message: work.message, execution: work.execution, phaseAttempt });
  } catch {
    throw invalid();
  }
}

function cloneReferenceData(value, active = new Set(), depth = 0, state = { nodes: 0 }) {
  if (depth > 32 || state.nodes++ > 20_000) throw evidenceInvalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw evidenceInvalid();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 4_096) throw evidenceInvalid();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) throw evidenceInvalid();
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1_000) throw evidenceInvalid();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) throw evidenceInvalid();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw evidenceInvalid();
        return cloneReferenceData(descriptor.value, active, depth + 1, state);
      });
    }
    if (!plainObject(value)) throw evidenceInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)
        || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw evidenceInvalid();
      output[key] = cloneReferenceData(descriptor.value, active, depth + 1, state);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function containsCategorySampleObjectKey(value) {
  if (typeof value === "string") return /category-strategy\//u.test(value);
  if (Array.isArray(value)) return value.some(containsCategorySampleObjectKey);
  return plainObject(value) && Object.values(value).some(containsCategorySampleObjectKey);
}

function closedStringArray(value, { minimum = 0, maximum = 100, maxBytes = 2_048 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
    || value.some((entry) => !validText(entry, maxBytes))) throw evidenceInvalid();
  return [...value];
}

function rejectCategoryPromptCarrier(value) {
  if (containsCategorySampleObjectKey(value)) throw forbiddenCategoryReference();
}

function projectGenerationClaim(value) {
  if (!exactObject(value, CLAIM_KEYS) || !validText(value.text, 2_048)
    || !validText(value.claimType, 240)) throw evidenceInvalid();
  const claim = {
    text: value.text,
    claimType: value.claimType,
    sourceFactIds: closedStringArray(value.sourceFactIds, { minimum: 1, maximum: 50, maxBytes: 240 }),
  };
  rejectCategoryPromptCarrier(claim);
  return claim;
}

function projectGenerationSlot(value, planVersion = 1) {
  const keys = planVersion === 3 ? SLOT_KEYS_V3 : planVersion === 2 ? SLOT_KEYS_V2 : SLOT_KEYS_V1;
  if (!exactObject(value, keys) || !isSafeAutoListingAiIdentifier(value.slotKey)
    || !isSafeAutoListingAiIdentifier(value.visualGroupKey) || !ROLES.has(value.role)
    || !Number.isInteger(value.order) || value.order < 1 || value.order > 13
    || !TEXT_DENSITIES.has(value.textDensity) || !Array.isArray(value.claims)
    || value.claims.length > 50) throw evidenceInvalid();
  if (planVersion >= 2 && (!ROLES.has(value.requestedRole)
    || !(value.substitutionReasonCode === null
      || value.substitutionReasonCode === "PRODUCT_DIMENSIONS_UNAVAILABLE"))) throw evidenceInvalid();
  const slot = {
    slotKey: value.slotKey,
    visualGroupKey: value.visualGroupKey,
    role: value.role,
    order: value.order,
    textDensity: value.textDensity,
    claims: value.claims.map(projectGenerationClaim),
    sourceFactIds: closedStringArray(value.sourceFactIds, { maximum: 100, maxBytes: 240 }),
    referenceAssetIds: closedStringArray(value.referenceAssetIds, { minimum: 1, maximum: planVersion === 3 ? 3 : 7, maxBytes: 240 }),
    preserve: closedStringArray(value.preserve, { minimum: 1, maximum: 100 }),
    prohibitedClaims: closedStringArray(value.prohibitedClaims, { maximum: 20, maxBytes: 240 }),
    ...(planVersion >= 2 ? {
      requestedRole: value.requestedRole,
      substitutionReasonCode: value.substitutionReasonCode,
    } : {}),
    ...(planVersion === 3 ? {
      targetView: value.targetView,
      evidenceMode: value.evidenceMode,
      prohibitedViews: closedStringArray(value.prohibitedViews, { maximum: 20, maxBytes: 240 }),
      prohibitedOverlayTexts: closedStringArray(value.prohibitedOverlayTexts, { maximum: 100, maxBytes: 2_048 }),
      identityAssetId: value.identityAssetId,
      selectionReasonCodes: closedStringArray(value.selectionReasonCodes, { minimum: 1, maximum: 20, maxBytes: 240 }),
    } : {}),
  };
  if (planVersion === 3 && (!TARGET_VIEWS.has(slot.targetView) || !EVIDENCE_MODES.has(slot.evidenceMode)
    || !isSafeAutoListingAiIdentifier(slot.identityAssetId)
    || !slot.referenceAssetIds.includes(slot.identityAssetId))) throw evidenceInvalid();
  if (slot.referenceAssetIds.length !== new Set(slot.referenceAssetIds).size) throw evidenceInvalid();
  rejectCategoryPromptCarrier(slot);
  return slot;
}

function projectGenerationFact(value) {
  const validShape = [FACT_REGISTRY_KEYS, FACT_REGISTRY_DICTIONARY_KEYS, LEGACY_FACT_REGISTRY_KEYS]
    .some((allowed) => exactObject(value, allowed));
  if (!validShape || !validText(value.factId, 240) || !validText(value.kind, 240)
    || !validText(value.value, 2_048) || !validText(value.sourcePath, 2_048)) throw evidenceInvalid();
  const fact = {
    factId: value.factId,
    kind: value.kind,
    value: value.value,
    sourcePath: value.sourcePath,
    visualGroupKeys: closedStringArray(value.visualGroupKeys, { maximum: 100, maxBytes: 240 }),
  };
  rejectCategoryPromptCarrier(fact);
  return fact;
}

function projectGenerationVisualGroups(value) {
  if (!exactObject(value, VISUAL_GROUPS_KEYS) || !validHash(value.sourceHash)
    || !validHash(value.visualGroupsHash) || !Array.isArray(value.groups)
    || !value.groups.length || value.groups.length > 100) throw evidenceInvalid();
  const groups = value.groups.map((group) => {
    if (!exactObject(group, VISUAL_GROUP_KEYS) || !isSafeAutoListingAiIdentifier(group.visualGroupKey)
      || !Array.isArray(group.referenceImages) || !group.referenceImages.length
      || !Array.isArray(group.factEvidence) || group.factEvidence.length > 1_000) throw evidenceInvalid();
    const factEvidence = group.factEvidence.map((fact) => {
      if (!exactObject(fact, VISUAL_FACT_KEYS) || !validText(fact.factId, 240)
        || !validText(fact.kind, 240) || !validText(fact.value, 2_048)) throw evidenceInvalid();
      return { factId: fact.factId, kind: fact.kind, value: fact.value };
    });
    const referenceImages = group.referenceImages.map((reference) => {
      if (containsCategorySampleObjectKey(reference)) throw forbiddenCategoryReference();
      if (!exactObject(reference, REFERENCE_KEYS) || !isSafeAutoListingAiIdentifier(reference.assetId)
        || !(reference.sourceRefHash === null || validHash(reference.sourceRefHash))
        || !validHash(reference.contentHash)
        || reference.sourceRef !== null || reference.evidenceKind !== "CONTENT_HASH") throw evidenceInvalid();
      return { ...reference };
    });
    if (referenceImages.length !== new Set(referenceImages.map(({ assetId }) => assetId)).size) throw evidenceInvalid();
    return {
      visualGroupKey: group.visualGroupKey,
      sourceSkus: closedStringArray(group.sourceSkus, { minimum: 1, maximum: 1_000, maxBytes: 240 }),
      variantIds: closedStringArray(group.variantIds, { minimum: 1, maximum: 1_000, maxBytes: 240 }),
      referenceImages,
      factEvidence,
      reasonCodes: closedStringArray(group.reasonCodes, { maximum: 100, maxBytes: 240 }),
    };
  });
  return {
    sourceHash: value.sourceHash,
    visualGroupsHash: value.visualGroupsHash,
    reasonCodes: closedStringArray(value.reasonCodes, { maximum: 100, maxBytes: 240 }),
    groups,
  };
}

function projectGenerationPlan(value) {
  const planKeys = value?.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
    ? GENERATION_PLAN_KEYS_SOURCE_IMAGE : GENERATION_PLAN_KEYS;
  if (!exactObject(value, planKeys)
    || ![value.id, value.sourceAccountId, value.jobId, value.itemId, value.sourceSnapshotId,
      value.strategyVersionId, value.profileId, value.parentPlanId].every(isSafeAutoListingAiIdentifier)
    || ![value.strategyHash, value.configHash, value.sourceHash, value.inputHash, value.planHash,
      value.visualGroupsHash, value.materializationSetHash].every(validHash)
    || !validText(value.plannerModel) || !validVersion(value.profileVersion)
    || !validText(value.promptTemplateVersion) || value.derivationKind !== "SOURCE_MATERIALIZATION"
    || !["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1", "FIXED_SKELETON_SOURCE_IMAGE_V1"].includes(value.planningContract)
    || (value.planningContract === "LEGACY_FULL_PLAN_V3" && value.skeletonHash !== null)
    || (["FIXED_SKELETON_V1", "FIXED_SKELETON_SOURCE_IMAGE_V1"].includes(value.planningContract)
      && !validHash(value.skeletonHash))
    || (value.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
      && (!isSafeAutoListingAiIdentifier(value.sourceImageAnalysisRunId)
        || !validHash(value.sourceImageIntelligenceHash)))
    || !(value.gatewayRequestId === null || validText(value.gatewayRequestId))
    || !(value.regeneration === null || exactObject(value.regeneration, REGENERATION_KEYS))
    || !exactObject(value.plan, PLAN_BODY_KEYS) || ![1, 2, 3].includes(value.plan.version) || value.plan.language !== "ru"
    || ((value.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1") !== (value.plan.version === 3))
    || !Array.isArray(value.plan.slots) || value.plan.slots.length < 6 || value.plan.slots.length > 1_000
    || !Array.isArray(value.factRegistry) || !value.factRegistry.length) throw evidenceInvalid();
  if (value.regeneration !== null && (!validText(value.regeneration.requestId)
    || !["USER_REQUESTED", "QUALITY_RETRY", "ADMIN_RETRY"].includes(value.regeneration.reason))) {
    throw evidenceInvalid();
  }
  const slots = value.plan.slots.map((slot) => projectGenerationSlot(slot, value.plan.version));
  if (slots.length !== new Set(slots.map(({ slotKey }) => slotKey)).size) throw evidenceInvalid();
  const factRegistry = value.factRegistry.map(projectGenerationFact);
  const visualGroups = projectGenerationVisualGroups(value.visualGroups);
  const visualGroupKeys = new Set(visualGroups.groups.map(({ visualGroupKey }) => visualGroupKey));
  if (visualGroupKeys.size !== visualGroups.groups.length
    || slots.some(({ visualGroupKey }) => !visualGroupKeys.has(visualGroupKey))) throw evidenceInvalid();
  for (const visualGroupKey of visualGroupKeys) {
    const groupSlotCount = slots.filter((slot) => slot.visualGroupKey === visualGroupKey).length;
    if (groupSlotCount < 6 || groupSlotCount > 13) throw evidenceInvalid();
  }
  return {
    ...value,
    plan: { version: value.plan.version, language: "ru", slots },
    visualGroups,
    factRegistry,
    regeneration: value.regeneration === null ? null : { ...value.regeneration },
  };
}

function freeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => freeze(entry, seen));
  return Object.freeze(value);
}

export function projectAutoListingGenerationReferences(rawInput = {}) {
  let input;
  try { input = cloneReferenceData(rawInput); } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID") throw error;
    throw evidenceInvalid();
  }
  if (!exactObject(input, REFERENCE_PROJECTOR_KEYS)
    || ![input.accountId, input.jobId, input.itemId, input.planId].every(isSafeAutoListingAiIdentifier)
    || !plainObject(input.plan) || !plainObject(input.slot)) throw evidenceInvalid();
  const plan = projectGenerationPlan(input.plan);
  if (plan.id !== input.planId || plan.sourceAccountId !== input.accountId
    || plan.jobId !== input.jobId || plan.itemId !== input.itemId) throw evidenceInvalid();
  const projectedInputSlot = projectGenerationSlot(input.slot, plan.plan.version);
  const slots = plan.plan.slots.filter(({ slotKey }) => slotKey === projectedInputSlot.slotKey);
  if (slots.length !== 1
    || JSON.stringify(canonical(slots[0])) !== JSON.stringify(canonical(projectedInputSlot))) throw evidenceInvalid();
  const slot = slots[0];
  const groups = plan.visualGroups.groups.filter((group) => group.visualGroupKey === slot.visualGroupKey);
  if (groups.length !== 1 || !Array.isArray(groups[0].referenceImages)) throw evidenceInvalid();
  const groupAssetIds = new Set(groups[0].referenceImages.map(({ assetId }) => assetId));
  const crossVariantStructure = plan.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
    && plan.plan.version === 3
    && slot.evidenceMode === "SYNTHESIZED_SAFE"
    && slot.selectionReasonCodes.includes("CROSS_VARIANT_STRUCTURE_REFERENCE_SELECTED");
  if (crossVariantStructure && (!groupAssetIds.has(slot.identityAssetId)
    || slot.referenceAssetIds.length < 2)) throw evidenceInvalid();
  const byId = new Map();
  const referenceGroups = crossVariantStructure ? plan.visualGroups.groups : groups;
  for (const group of referenceGroups) for (const reference of group.referenceImages) {
    const known = byId.get(reference.assetId);
    if (known && JSON.stringify(canonical(known)) !== JSON.stringify(canonical(reference))) throw evidenceInvalid();
    byId.set(reference.assetId, reference);
  }
  const selected = slot.referenceAssetIds.map((assetId) => byId.get(assetId));
  if (selected.some((reference) => !reference)) throw evidenceInvalid();
  return freeze({ plan, slot, references: selected.map((reference) => ({ ...reference })) });
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

function canonicalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw evidenceInvalid();
  return date.toISOString();
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
    planningContract: row.planning_contract ?? null,
    currentAnalysisRunId: row.current_source_image_analysis_run_id ?? null,
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

function gatewayProfile(row, execution) {
  const exactExecution = execution && execution !== null;
  const profile = {
    id: row.profile_id,
    accountId: row.profile_account_id,
    configVersion: row.profile_config_version,
    baseUrl: exactExecution ? row.execution_connection_base_url : row.profile_base_url,
    apiKeyEnvName: row.profile_api_key_env_name,
    textProtocol: row.profile_text_protocol,
    imageProtocol: row.profile_image_protocol,
    textModel: row.profile_text_model,
    imageModel: row.profile_image_model,
    connectionId: exactExecution ? row.execution_connection_id : row.profile_connection_id ?? null,
    connectionVersion: exactExecution
      ? Number(row.execution_connection_version)
      : row.profile_connection_version === null || row.profile_connection_version === undefined
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
    || encryptedReference !== hasConnection
    || (exactExecution && (row.execution_channel_id !== execution.channelId
      || profile.connectionId !== execution.connectionId
      || profile.connectionVersion !== execution.connectionVersion))) throw evidenceInvalid();
  return Object.freeze(profile);
}

function projectedGatewayExecution(execution) {
  if (execution === undefined) return undefined;
  if (execution === null) return null;
  return Object.freeze({
    channelId: execution.channelId,
    connectionId: execution.connectionId,
    connectionVersion: execution.connectionVersion,
    idleTimeoutMs: 300_000,
  });
}

function gatewayRouteSql({ profileAlias, itemAlias, execution, firstParameter }) {
  if (execution === undefined) return { projection: "", joins: "", predicate: "", values: [] };
  if (execution === null) {
    return {
      projection: "",
      joins: "",
      predicate: `AND ${profileAlias}.connection_id IS NULL AND ${profileAlias}.connection_version IS NULL`,
      values: [],
    };
  }
  const p = Array.from({ length: 5 }, (_, index) => `$${firstParameter + index}`);
  return {
    projection: `,
            channel.channel_id AS execution_channel_id,
            connection.id AS execution_connection_id,
            connection.version AS execution_connection_version,
            connection.base_url AS execution_connection_base_url`,
    joins: `
       JOIN auto_listing_ai_profile_channels AS channel
         ON channel.account_id=${profileAlias}.account_id
        AND channel.profile_id=${profileAlias}.id
        AND channel.profile_version=${profileAlias}.config_version
        AND channel.channel_id=${p[0]}
        AND channel.connection_id=${p[1]}
        AND channel.connection_version=${p[2]}
        AND channel.assigned_job_id=${itemAlias}.job_id
        AND channel.assigned_item_id=${itemAlias}.id
        AND channel.assigned_status_version=${itemAlias}.status_version
        AND channel.execution_lease_owner=${p[3]}
        AND channel.execution_lease_token=${p[4]}
        AND channel.execution_lease_expires_at > NOW()
       JOIN ai_gateway_connection_versions AS connection
         ON connection.account_id=channel.account_id
        AND connection.id=channel.connection_id
        AND connection.version=channel.connection_version`,
    predicate: "",
    values: [execution.channelId, execution.connectionId, execution.connectionVersion,
      execution.leaseOwner, execution.leaseToken],
  };
}

function mapRule(row) {
  if (!plainObject(row) || !isSafeAutoListingAiIdentifier(row.id)
    || !Number.isInteger(Number(row.rule_order)) || Number(row.rule_order) < 1
    || !validText(row.rule_kind, 64) || !plainObject(jsonValue(row.rule))) throw evidenceInvalid();
  const rule = jsonValue(row.rule);
  if (rule.matchType === "EXACT_CATEGORY_TYPE_V2") {
    return { ...rule, ruleId: row.id, ruleOrder: Number(row.rule_order) };
  }
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

function strategyCapture(row, ruleRows, capture, useCategoryStrategy = true) {
  if (!isSafeAutoListingAiIdentifier(row.strategy_version_id)
    || !isSafeAutoListingAiIdentifier(row.strategy_key)) throw evidenceInvalid();
  let strategySnapshot;
  try {
    const source = capture.snapshot;
    strategySnapshot = resolveAiContentStrategy({
      strategyVersion: { strategyId: row.strategy_key, strategyVersionId: row.strategy_version_id },
      rules: useCategoryStrategy ? ruleRows.map(mapRule) : [],
      product: {
        taxonomyScope: source.targetCategory?.taxonomyScope,
        descriptionCategoryId: source.targetCategory?.descriptionCategoryId,
        typeId: source.targetCategory?.typeId,
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
    planningContract: row.planning_contract,
    skeletonHash: row.skeleton_hash,
    ...(row.planning_contract === "FIXED_SKELETON_SOURCE_IMAGE_V1" ? {
      sourceImageAnalysisRunId: row.source_image_analysis_run_id,
      sourceImageIntelligenceHash: row.source_image_intelligence_hash,
    } : {}),
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
  if (!["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1", "FIXED_SKELETON_SOURCE_IMAGE_V1"].includes(base.planningContract)
    || (base.planningContract === "LEGACY_FULL_PLAN_V3" && base.skeletonHash !== null)
    || (["FIXED_SKELETON_V1", "FIXED_SKELETON_SOURCE_IMAGE_V1"].includes(base.planningContract)
      && !validHash(base.skeletonHash))
    || (base.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
      && (!isSafeAutoListingAiIdentifier(base.sourceImageAnalysisRunId)
        || !validHash(base.sourceImageIntelligenceHash)))) throw evidenceInvalid();
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
    expectedStatusVersion: row.expected_status_version,
  };
}

function validateOptions(options) {
  if (!plainObject(options) || !options.pool || typeof options.pool.query !== "function"
    || typeof options.pool.connect !== "function"
    || Object.keys(options).some((key) => !FACTORY_KEYS.has(key))
    || [...FACTORY_KEYS].filter((key) => !OPTIONAL_FACTORY_KEYS.has(key))
      .some((key) => !Object.hasOwn(options, key))
    || !validText(options.planPromptTemplateVersion)
    || !Array.isArray(options.prohibitedClaims)
    || options.prohibitedClaims.length !== REQUIRED_PROHIBITED_CLAIMS.length
    || REQUIRED_PROHIBITED_CLAIMS.some((claim) => !options.prohibitedClaims.includes(claim))
    || !validVersion(options.maxAttempts) || options.maxAttempts > 3
    || !validVersion(options.richContentMaxAttempts) || options.richContentMaxAttempts > 5
    || !isSafeAutoListingAiIdentifier(options.richContentLeaseOwner)) throw invalid();
  for (const key of ["gateway", "contentPlanRepository", "contentPlanEvidenceRepository", "sourceMaterializationRepository",
    "generationRepository", "richContentRepository", "downloader", "storage", "sourceAssetLoader"]) {
    if (!options[key] || typeof options[key] !== "object") throw invalid();
  }
  if (typeof options.referenceProjector !== "function") throw invalid();
  if (options.sourceImageIntelligenceRepository !== undefined
    && (!options.sourceImageIntelligenceRepository || typeof options.sourceImageIntelligenceRepository !== "object")) throw invalid();
  if (options.sourceAnalysisAssetLoader !== undefined
    && (!options.sourceAnalysisAssetLoader || typeof options.sourceAnalysisAssetLoader !== "object")) throw invalid();
  if (options.imageGroupChecker !== undefined && typeof options.imageGroupChecker !== "function") throw invalid();
  if (options.imageGroupCheckRepository !== undefined
    && (!options.imageGroupCheckRepository || typeof options.imageGroupCheckRepository !== "object")) throw invalid();
  if (options.sourceImageDerivativeRepository !== undefined
    && (!options.sourceImageDerivativeRepository || typeof options.sourceImageDerivativeRepository !== "object")) throw invalid();
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
    `SELECT i.job_id,i.status,i.status_version,i.active_content_plan_id,i.snapshot_id,
            i.planning_contract,i.current_source_image_analysis_run_id
       FROM auto_listing_job_items i
       JOIN auto_listing_jobs j ON j.account_id=i.account_id AND j.id=i.job_id
      WHERE i.account_id=$1 AND i.id=$2
      FOR SHARE OF i`,
    [message.accountId, message.itemId]);
  const row = zeroOrOneRow(result);
  return row ? normalizeBoundary(row, message) : null;
}

async function loadPlanInput(options, message, boundary, execution, { allowEarlierAnalysisStatusVersion = false } = {}) {
  const route = gatewayRouteSql({ profileAlias: "p", itemAlias: "i", execution, firstParameter: 5 });
  const bundle = exactSingleRow(await safeQuery(options.pool,
    `SELECT i.planning_contract,s.snapshot,s.snapshot_hash,s.raw_response_ref,
            j.config_snapshot,j.config_hash AS config_hash_from_job,j.strategy_version_id,
            v.strategy_key,
            command.id AS regeneration_request_id,
            p.id AS profile_id,p.account_id AS profile_account_id,p.config_version AS profile_config_version,
            p.base_url AS profile_base_url,p.api_key_env_name AS profile_api_key_env_name,
            p.text_protocol AS profile_text_protocol,p.image_protocol AS profile_image_protocol,
            p.text_model AS profile_text_model,p.image_model AS profile_image_model,p.enabled AS profile_enabled,
            p.connection_id AS profile_connection_id,p.connection_version AS profile_connection_version
            ${route.projection}
       FROM auto_listing_job_items i
       JOIN auto_listing_jobs j ON j.account_id=i.account_id AND j.id=i.job_id
       JOIN auto_listing_source_snapshots s ON s.account_id=i.account_id AND s.id=i.snapshot_id
       JOIN ai_content_strategy_versions v ON v.account_id=j.account_id AND v.id=j.strategy_version_id
       JOIN ai_gateway_profiles p ON p.account_id=j.account_id AND p.id=j.ai_profile_id
                                 AND p.config_version=j.ai_profile_version
       ${route.joins}
       LEFT JOIN auto_listing_user_commands AS command
         ON command.account_id=i.account_id AND command.job_id=i.job_id AND command.item_id=i.id
        AND command.action='REGENERATE' AND command.result_status='PLANNING'
        AND command.result_status_version=i.status_version
      WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3 AND i.snapshot_id=$4
        ${route.predicate}`,
    [boundary.accountId, boundary.jobId, boundary.itemId, boundarySnapshot(boundary), ...route.values]));
  if (!["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1", "FIXED_SKELETON_SOURCE_IMAGE_V1"].includes(bundle.planning_contract)) {
    throw evidenceInvalid();
  }
  const capture = sourceCapture(bundle);
  const frozenConfig = configCapture(bundle);
  const useCategoryStrategy = frozenConfig.configSnapshot.useCategoryStrategy !== false;
  const rulesResult = useCategoryStrategy ? await safeQuery(options.pool,
    `SELECT id,rule_order,rule_kind,category_id,ancestor_category_id,product_style,rule
       FROM ai_content_strategy_rules
      WHERE account_id=$1 AND strategy_version_id=$2
      ORDER BY rule_order ASC,id ASC`,
    [boundary.accountId, bundle.strategy_version_id]) : { rows: [] };
  if (!rulesResult || !Array.isArray(rulesResult.rows)) throw evidenceInvalid();
  let visualGroupsCapture;
  let analysisRun;
  if (bundle.planning_contract === "FIXED_SKELETON_SOURCE_IMAGE_V1") {
    analysisRun = await loadCurrentAnalysisRun(options, boundary, {
      allowEarlierStatusVersion: allowEarlierAnalysisStatusVersion,
    });
    if (analysisRun.status !== "ACCEPTED" || !validHash(analysisRun.summaryHash)
      || !plainObject(analysisRun.summary)) throw evidenceInvalid();
    try { verifySourceImageIntelligenceSummary(analysisRun.summary); } catch { throw evidenceInvalid(); }
    if (analysisRun.summary.summaryHash !== analysisRun.summaryHash) throw evidenceInvalid();
  } else {
    try { visualGroupsCapture = buildVisualGroups({ sourceCapture: capture }); } catch { throw evidenceInvalid(); }
  }
  const regenerationRequestId = bundle.regeneration_request_id ?? null;
  if (!(regenerationRequestId === null || isSafeAutoListingAiIdentifier(regenerationRequestId))) {
    throw evidenceInvalid();
  }
  return {
    sourceSnapshotId: boundarySnapshot(boundary),
    planningContract: bundle.planning_contract,
    gatewayProfile: gatewayProfile(bundle, execution),
    ...(execution === undefined ? {} : { gatewayExecution: projectedGatewayExecution(execution) }),
    gateway: options.gateway,
    repository: options.contentPlanRepository,
    evidenceRepository: options.contentPlanEvidenceRepository,
    sourceCapture: capture,
    strategyCapture: strategyCapture(bundle, rulesResult.rows, capture, useCategoryStrategy),
    configCapture: frozenConfig,
    ...(analysisRun ? {
      sourceImageAnalysisRun: analysisRun,
      sourceImageIntelligenceSummary: analysisRun.summary,
    } : { visualGroupsCapture }),
    promptTemplateVersion: options.planPromptTemplateVersion,
    prohibitedClaims: [...options.prohibitedClaims].sort(),
    regeneration: regenerationRequestId === null ? null : {
      requestId: regenerationRequestId,
      reason: "USER_REQUESTED",
    },
  };
}

export async function loadFrozenAutoListingPlanningInput(options, boundary) {
  return loadPlanInput(options, null, boundary, undefined, { allowEarlierAnalysisStatusVersion: true });
}

function boundarySnapshot(boundary) {
  return boundary.snapshotId;
}

function mapAnalysisRun(row, boundary, { allowEarlierStatusVersion = false } = {}) {
  const statusVersionMatches = allowEarlierStatusVersion
    ? validVersion(row?.expected_status_version) && row.expected_status_version <= boundary.statusVersion
    : row?.expected_status_version === boundary.statusVersion;
  if (!plainObject(row) || !isSafeAutoListingAiIdentifier(row.id)
    || row.account_id !== boundary.accountId || row.job_id !== boundary.jobId || row.item_id !== boundary.itemId
    || row.id !== boundary.currentAnalysisRunId || row.source_snapshot_id !== boundary.snapshotId
    || !statusVersionMatches || !validHash(row.source_snapshot_hash)
    || !validHash(row.source_asset_set_hash) || !validHash(row.input_hash)
    || !validText(row.intelligence_contract_version) || !validText(row.prompt_template_version)
    || !isSafeAutoListingAiIdentifier(row.profile_id) || !validVersion(row.profile_version)
    || !validText(row.model_name) || !validText(row.status, 64)
    || !Number.isInteger(row.expected_asset_count) || row.expected_asset_count < 1) throw evidenceInvalid();
  return Object.freeze({
    id: row.id, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    sourceSnapshotId: row.source_snapshot_id, expectedStatusVersion: row.expected_status_version,
    contractVersion: row.intelligence_contract_version, sourceSnapshotHash: row.source_snapshot_hash,
    sourceAssetSetHash: row.source_asset_set_hash, inputHash: row.input_hash,
    promptTemplateVersion: row.prompt_template_version, profileId: row.profile_id,
    profileVersion: row.profile_version, modelName: row.model_name,
    expectedAssetCount: row.expected_asset_count, terminalAssetCount: row.terminal_asset_count,
    status: row.status, parentRunId: row.parent_run_id, derivationKind: row.derivation_kind,
    summaryHash: row.summary_hash, summary: jsonValue(row.summary),
    decisionSet: jsonValue(row.decision_set) || [],
  });
}

async function loadCurrentAnalysisRun(options, boundary, { allowEarlierStatusVersion = false } = {}) {
  if (boundary.planningContract !== "FIXED_SKELETON_SOURCE_IMAGE_V1"
    || !isSafeAutoListingAiIdentifier(boundary.currentAnalysisRunId)) throw evidenceInvalid();
  const row = exactSingleRow(await safeQuery(options.pool,
    `SELECT * FROM auto_listing_source_image_analysis_runs
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND id=$4
        AND expected_status_version${allowEarlierStatusVersion ? "<=" : "="}$5 FOR SHARE`,
    [boundary.accountId, boundary.jobId, boundary.itemId, boundary.currentAnalysisRunId,
      boundary.statusVersion]));
  return mapAnalysisRun(row, boundary, { allowEarlierStatusVersion });
}

async function loadSourceMaterializationScope(options, boundary, sourceAssetIds) {
  const row = exactSingleRow(await safeQuery(options.pool,
    `WITH RECURSIVE current_run AS (
       SELECT * FROM auto_listing_source_image_analysis_runs
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND id=$4
     ), lineage AS (
       SELECT id,parent_run_id,expected_status_version,input_hash,0 AS depth,ARRAY[id]::TEXT[] AS path
         FROM current_run
       UNION ALL
       SELECT parent.id,parent.parent_run_id,parent.expected_status_version,parent.input_hash,
              child.depth+1,child.path || parent.id
         FROM auto_listing_source_image_analysis_runs AS parent
         JOIN lineage AS child ON parent.id=child.parent_run_id
        WHERE parent.account_id=$1 AND parent.job_id=$2 AND parent.item_id=$3
          AND NOT parent.id=ANY(child.path) AND CARDINALITY(child.path)<100
     ), lineage_guard AS (
       SELECT COUNT(*) FILTER (WHERE parent_run_id IS NULL)::INTEGER AS root_count FROM lineage
     )
     SELECT candidate.id,candidate.expected_status_version
       FROM current_run
       JOIN auto_listing_source_image_analysis_runs AS candidate
         ON candidate.account_id=current_run.account_id
        AND candidate.job_id=current_run.job_id
        AND candidate.item_id=current_run.item_id
        AND candidate.source_snapshot_id=current_run.source_snapshot_id
        AND candidate.source_snapshot_hash=current_run.source_snapshot_hash
        AND candidate.source_asset_set_hash=current_run.source_asset_set_hash
        AND candidate.intelligence_contract_version=current_run.intelligence_contract_version
        AND candidate.prompt_template_version=current_run.prompt_template_version
        AND candidate.profile_id=current_run.profile_id
        AND candidate.profile_version=current_run.profile_version
        AND candidate.model_name=current_run.model_name
        AND candidate.expected_status_version<=current_run.expected_status_version
       LEFT JOIN lineage ON lineage.id=candidate.id
       CROSS JOIN lineage_guard AS guard
      WHERE guard.root_count=1
        AND (lineage.id IS NOT NULL OR EXISTS (
          SELECT 1 FROM lineage AS input_owner
           WHERE input_owner.input_hash=candidate.input_hash
        ))
        AND NOT EXISTS (
          SELECT 1 FROM UNNEST($5::TEXT[]) AS planned(source_asset_id)
           WHERE NOT EXISTS (
             SELECT 1
               FROM auto_listing_source_image_assessments AS assessment
               JOIN auto_listing_source_materialization_attempts AS attempt
                 ON attempt.account_id=assessment.account_id
                AND attempt.job_id=assessment.job_id
                AND attempt.item_id=assessment.item_id
                AND attempt.source_asset_id=assessment.source_asset_id
                AND attempt.source_ref_hash=assessment.source_ref_hash
                AND attempt.object_key=assessment.object_key
                AND attempt.content_hash=assessment.content_hash
                AND attempt.content_type=assessment.content_type
                AND attempt.size_bytes=assessment.size_bytes
                AND attempt.source_analysis_run_id=candidate.id
                AND attempt.expected_status_version=candidate.expected_status_version
                AND attempt.status='ACCEPTED'
              WHERE assessment.account_id=$1 AND assessment.job_id=$2 AND assessment.item_id=$3
                AND assessment.analysis_run_id=$4
                AND assessment.expected_status_version=current_run.expected_status_version
                AND assessment.source_asset_id=planned.source_asset_id
                AND assessment.record_status='ACCEPTED'
                AND assessment.terminal_status IN ('ANALYZED','DUPLICATE_REUSED','CONFIRMATION_REQUIRED')
           )
        )
      ORDER BY (lineage.id IS NULL),lineage.depth NULLS LAST,
               candidate.expected_status_version DESC,candidate.id
      LIMIT 1`,
    [boundary.accountId, boundary.jobId, boundary.itemId, boundary.currentAnalysisRunId, sourceAssetIds]));
  if (!isSafeAutoListingAiIdentifier(row.id)
    || !validVersion(row.expected_status_version)
    || row.expected_status_version > boundary.statusVersion) throw evidenceInvalid();
  return Object.freeze({
    analysisRunId: row.id,
    expectedStatusVersion: row.expected_status_version,
  });
}

async function loadAcceptedAnalysisForPlan(options, boundary, plan) {
  const analysisRun = await loadCurrentAnalysisRun(options, boundary, { allowEarlierStatusVersion: true });
  let summary;
  try { summary = verifySourceImageIntelligenceSummary(analysisRun.summary); }
  catch { throw evidenceInvalid(); }
  if (analysisRun.status !== "ACCEPTED" || !validHash(analysisRun.summaryHash)
    || analysisRun.contractVersion !== summary.contractVersion
    || summary.summaryHash !== analysisRun.summaryHash
    || plan.sourceImageAnalysisRunId !== analysisRun.id
    || plan.sourceImageIntelligenceHash !== analysisRun.summaryHash) throw evidenceInvalid();
  return Object.freeze({ ...analysisRun, summary });
}

async function loadActiveBundle(options, boundary, execution) {
  if (!isSafeAutoListingAiIdentifier(boundary.activeContentPlanId)) throw evidenceInvalid();
  const route = gatewayRouteSql({ profileAlias: "gp", itemAlias: "i", execution, firstParameter: 6 });
  return exactSingleRow(await safeQuery(options.pool,
    `SELECT ${PLAN_COLUMNS},
            s.snapshot,s.snapshot_hash,s.raw_response_ref,
            j.config_snapshot,j.config_hash AS config_hash_from_job,
            v.strategy_key,
            gp.id AS profile_id,gp.account_id AS profile_account_id,gp.config_version AS profile_config_version,
            gp.base_url AS profile_base_url,gp.api_key_env_name AS profile_api_key_env_name,
            gp.text_protocol AS profile_text_protocol,gp.image_protocol AS profile_image_protocol,
            gp.text_model AS profile_text_model,gp.image_model AS profile_image_model,gp.enabled AS profile_enabled,
            gp.connection_id AS profile_connection_id,gp.connection_version AS profile_connection_version
            ${route.projection}
       FROM auto_listing_job_items i
       JOIN auto_listing_jobs j ON j.account_id=i.account_id AND j.id=i.job_id
       JOIN ai_content_plans p ON p.account_id=i.account_id AND p.job_id=i.job_id
                              AND p.item_id=i.id AND p.id=i.active_content_plan_id
                              AND p.planning_contract=i.planning_contract
       JOIN auto_listing_source_snapshots s ON s.account_id=i.account_id AND s.id=i.snapshot_id
                                           AND s.id=p.source_snapshot_id
       JOIN ai_content_strategy_versions v ON v.account_id=p.account_id AND v.id=p.strategy_version_id
       JOIN ai_gateway_profiles gp ON gp.account_id=p.account_id AND gp.id=p.profile_id
                                  AND gp.config_version=p.profile_version
       ${route.joins}
      WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3
        AND i.active_content_plan_id=$4 AND i.snapshot_id=$5
        ${route.predicate}`,
    [boundary.accountId, boundary.jobId, boundary.itemId, boundary.activeContentPlanId,
      boundarySnapshot(boundary), ...route.values]));
}

const CATEGORY_STYLE_REFERENCE_LIMIT = 1;
const CATEGORY_STYLE_REFERENCE_MIN_EDGE = 256;

function categoryStyleEvidenceIds(rawResponse, role) {
  const summary = jsonValue(rawResponse)?.evidenceSummary;
  if (!plainObject(summary) || !plainObject(summary.roleEvidence)) return [];
  const ids = [];
  const add = (values) => {
    if (!Array.isArray(values)) return;
    for (const value of values) if (validText(value) && !ids.includes(value)) ids.push(value);
  };
  add(summary.roleEvidence[role]?.evidenceIds);
  if (Array.isArray(summary.commonPatterns)) {
    for (const pattern of summary.commonPatterns) add(pattern?.evidenceIds);
  }
  for (const evidence of Object.values(summary.roleEvidence)) add(evidence?.evidenceIds);
  return ids.slice(0, 120);
}

function selectCategoryStyleRows(rows, evidenceIds) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const clear = evidenceIds.map((id) => byId.get(id)).filter((row) => row
    && validText(row.id) && validText(row.sample_id) && validText(row.sku)
    && validText(row.analysis_object_key, 1_024) && validHash(row.analysis_content_hash)
    && ["image/jpeg", "image/png", "image/webp"].includes(row.content_type)
    && Number.isInteger(Number(row.width)) && Number(row.width) >= CATEGORY_STYLE_REFERENCE_MIN_EDGE
    && Number.isInteger(Number(row.height)) && Number(row.height) >= CATEGORY_STYLE_REFERENCE_MIN_EDGE);
  const distinct = [];
  const skus = new Set();
  for (const row of clear) {
    if (skus.has(row.sku)) continue;
    skus.add(row.sku);
    distinct.push(row);
  }
  return distinct.slice(0, CATEGORY_STYLE_REFERENCE_LIMIT);
}

async function loadCategoryStyleReferences(options, plan, slot, snapshot) {
  const result = await safeQuery(options.pool,
    `SELECT id,account_id,sample_set_id,sample_set_hash,raw_response
       FROM auto_listing_category_strategy_analysis_results
      WHERE account_id=$1 AND id=$2 AND sample_set_hash=$3`,
    [plan.sourceAccountId, snapshot.analysisResultId, snapshot.sampleSetHash]);
  if (!result || !Array.isArray(result.rows) || result.rows.length > 1) throw evidenceInvalid();
  if (!result.rows.length) return [];
  const analysis = result.rows[0];
  if (!validText(analysis.sample_set_id) || analysis.sample_set_hash !== snapshot.sampleSetHash) throw evidenceInvalid();
  const evidenceIds = categoryStyleEvidenceIds(analysis.raw_response, slot.role);
  if (!evidenceIds.length) return [];
  const imageResult = await safeQuery(options.pool,
    `SELECT image.id,image.sample_id,sample.sku,image.role,image.ordinal,
            image.analysis_object_key,image.analysis_content_hash,image.content_type,image.width,image.height
       FROM auto_listing_category_strategy_sample_images image
       JOIN auto_listing_category_strategy_samples sample
         ON sample.account_id=image.account_id AND sample.id=image.sample_id
      WHERE image.account_id=$1 AND image.sample_set_id=$2 AND image.id=ANY($3::TEXT[])`,
    [plan.sourceAccountId, analysis.sample_set_id, evidenceIds]);
  if (!imageResult || !Array.isArray(imageResult.rows)) throw evidenceInvalid();
  const selected = selectCategoryStyleRows(imageResult.rows, evidenceIds);
  return Object.freeze(selected.map((row) => {
    if (!row.analysis_object_key.startsWith(`category-strategy/${plan.sourceAccountId}/`)) throw evidenceInvalid();
    return Object.freeze({
      evidenceId: row.id,
      sku: row.sku,
      objectKey: row.analysis_object_key,
      contentHash: row.analysis_content_hash,
      contentType: row.content_type,
      width: Number(row.width),
      height: Number(row.height),
    });
  }));
}

async function loadCategoryStyle(options, row, plan, slot, useCategoryStrategy = true) {
  if (!useCategoryStrategy) {
    return { categoryStyle: null, categoryStyleReferences: Object.freeze([]) };
  }
  const rulesResult = await safeQuery(options.pool,
    `SELECT id,rule_order,rule_kind,category_id,ancestor_category_id,product_style,rule
       FROM ai_content_strategy_rules
      WHERE account_id=$1 AND strategy_version_id=$2
      ORDER BY rule_order ASC,id ASC`,
    [plan.sourceAccountId, plan.strategyVersionId]);
  if (!rulesResult || !Array.isArray(rulesResult.rows)) throw evidenceInvalid();
  const capture = strategyCapture(row, rulesResult.rows, sourceCapture(row));
  const snapshot = capture.strategySnapshot;
  if (snapshot.matchedBy !== "EXACT_CATEGORY_TYPE_V2") {
    return { categoryStyle: null, categoryStyleReferences: Object.freeze([]) };
  }
  const guidance = snapshot.roleGuidance?.[slot.role];
  const productLedMainDensityOverride = plan.promptTemplateVersion === "AUTO_LISTING_CONTENT_PLAN_FILL_V6"
    && slot.role === "MAIN" && slot.textDensity === "HEAVY";
  const copyFreeDensityOverride = plan.promptTemplateVersion === "AUTO_LISTING_CONTENT_PLAN_FILL_V6"
    && slot.textDensity === "NONE" && slot.claims.length === 0;
  const slotDensityOverride = productLedMainDensityOverride || copyFreeDensityOverride;
  if (!plainObject(guidance)
    || !validText(snapshot.overallStyle, 4_000)
    || !Array.isArray(snapshot.prohibitedPatterns) || snapshot.prohibitedPatterns.length > 20
    || snapshot.prohibitedPatterns.some((entry) => !validText(entry, 4_000))
    || !validText(guidance.composition, 4_000)
    || !validText(guidance.background, 4_000)
    || (!slotDensityOverride && guidance.textDensity !== slot.textDensity)
    || !validText(guidance.layout, 4_000)) throw evidenceInvalid();
  const style = {
    overallStyle: snapshot.overallStyle,
    prohibitedPatterns: [...snapshot.prohibitedPatterns],
    role: slot.role,
    composition: guidance.composition,
    background: guidance.background,
    textDensity: slotDensityOverride ? slot.textDensity : guidance.textDensity,
    layout: guidance.layout,
  };
  rejectCategoryPromptCarrier(style);
  return {
    categoryStyle: freeze(style),
    categoryStyleReferences: await loadCategoryStyleReferences(options, plan, slot, snapshot),
  };
}

function assertSourceAssetInPlan(plan, sourceAssetId) {
  const references = Array.isArray(plan.visualGroups?.groups)
    ? plan.visualGroups.groups.flatMap((group) => Array.isArray(group?.referenceImages)
      ? group.referenceImages : []) : [];
  if (references.filter((entry) => entry?.assetId === sourceAssetId).length !== 1) throw evidenceInvalid();
}

async function loadAnalysisSnapshot(options, boundary) {
  const row = exactSingleRow(await safeQuery(options.pool,
    `SELECT snapshot,snapshot_hash,raw_response_ref
       FROM auto_listing_source_snapshots
      WHERE account_id=$1 AND id=$2 FOR SHARE`,
    [boundary.accountId, boundary.snapshotId]));
  return sourceCapture(row);
}

async function loadAnalysisProfile(options, boundary, run, execution) {
  const route = gatewayRouteSql({ profileAlias: "profile", itemAlias: "item", execution, firstParameter: 7 });
  const row = exactSingleRow(await safeQuery(options.pool,
    `SELECT profile.id AS profile_id,profile.account_id AS profile_account_id,
            profile.config_version AS profile_config_version,profile.base_url AS profile_base_url,
            profile.api_key_env_name AS profile_api_key_env_name,profile.text_protocol AS profile_text_protocol,
            profile.image_protocol AS profile_image_protocol,profile.text_model AS profile_text_model,
            profile.image_model AS profile_image_model,profile.enabled AS profile_enabled,
            profile.connection_id AS profile_connection_id,profile.connection_version AS profile_connection_version
            ${route.projection}
       FROM auto_listing_job_items item
       JOIN ai_gateway_profiles profile ON profile.account_id=item.account_id
        AND profile.id=$5 AND profile.config_version=$6
       ${route.joins}
      WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3
        AND item.current_source_image_analysis_run_id=$4 ${route.predicate}`,
    [boundary.accountId, boundary.jobId, boundary.itemId, run.id, run.profileId, run.profileVersion,
      ...route.values]));
  const profile = gatewayProfile(row, execution);
  if (profile.textModel !== run.modelName) throw evidenceInvalid();
  return profile;
}

export async function loadMaterializeAnalysisInput(options, message, boundary,
  phaseAttempt = { attemptNo: 1, maxAttempts: 3 }) {
  if (!exactObject(phaseAttempt, PHASE_ATTEMPT_KEYS) || !Number.isInteger(phaseAttempt.attemptNo)
    || phaseAttempt.attemptNo < 1 || phaseAttempt.maxAttempts !== 3
    || phaseAttempt.attemptNo > phaseAttempt.maxAttempts) throw evidenceInvalid();
  const analysisRun = await loadCurrentAnalysisRun(options, boundary);
  if (!["MATERIALIZING", "ANALYZING"].includes(analysisRun.status)) throw evidenceInvalid();
  const capture = await loadAnalysisSnapshot(options, boundary);
  let assets;
  try { assets = enumerateSourceImageAssets({ sourceCapture: capture }); } catch { throw evidenceInvalid(); }
  const matches = assets.filter(({ sourceAssetId }) => sourceAssetId === message.sourceAssetId);
  if (matches.length !== 1) throw evidenceInvalid();
  return {
    analysisRun,
    sourceAsset: matches[0],
    sourceSnapshot: {
      accountId: boundary.accountId, jobId: boundary.jobId, itemId: boundary.itemId,
      sourceSnapshotId: boundary.snapshotId, sourceCapture: capture,
    },
    execution: { ...phaseAttempt },
    policy: undefined,
    repository: options.sourceMaterializationRepository,
    intelligenceRepository: options.sourceImageIntelligenceRepository,
    downloader: options.downloader,
    storage: options.storage,
    logger: options.logger,
  };
}

async function loadAnalysisAssessmentRows(options, boundary, run) {
  const result = await safeQuery(options.pool,
    `SELECT source_asset_id,source_ordinal,record_status,object_key,content_hash,content_type,size_bytes,
            terminal_status,analysis_batch_id,input_hash,result_hash,assessment,error_code
       FROM auto_listing_source_image_assessments
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND analysis_run_id=$4
        AND expected_status_version=$5
      ORDER BY source_ordinal NULLS LAST,source_asset_id`,
    [boundary.accountId, boundary.jobId, boundary.itemId, run.id, boundary.statusVersion]);
  if (!result || !Array.isArray(result.rows)) throw evidenceInvalid();
  return result.rows;
}

export async function loadSourceImageBatchInput(options, message, boundary, execution) {
  const run = await loadCurrentAnalysisRun(options, boundary);
  if (!["ANALYZING", "RECONCILING", "ACCEPTED", "CONFIRMATION_REQUIRED"].includes(run.status)) {
    throw evidenceInvalid();
  }
  const rows = await loadAnalysisAssessmentRows(options, boundary, run);
  if (rows.length !== run.expectedAssetCount) throw evidenceInvalid();
  const terminalAssessments = rows.filter((row) => row.record_status === "ACCEPTED"
    && ["DOWNLOAD_FAILED", "UNSUPPORTED_MEDIA"].includes(row.terminal_status)).map((row) => ({
    sourceAssetId: row.source_asset_id, terminalStatus: row.terminal_status,
  }));
  const materializedAssets = rows.filter((row) => row.record_status === "MATERIALIZED"
    || (row.record_status === "ACCEPTED"
      && ["ANALYZED", "DUPLICATE_REUSED", "CONFIRMATION_REQUIRED"].includes(row.terminal_status))).map((row) => ({
    sourceAssetId: row.source_asset_id, sourceOrdinal: row.source_ordinal, sizeBytes: Number(row.size_bytes),
    contentHash: row.content_hash, objectKey: row.object_key, contentType: row.content_type,
  }));
  if (materializedAssets.length + terminalAssessments.length !== rows.length) throw evidenceInvalid();
  let batches;
  try { batches = buildSourceImageAnalysisBatches({ materializedAssets, terminalAssessments }); }
  catch { throw evidenceInvalid(); }
  const matches = batches.filter(({ analysisBatchId }) => analysisBatchId === message.analysisBatchId);
  if (matches.length !== 1) throw evidenceInvalid();
  return {
    run,
    batch: matches[0],
    profile: await loadAnalysisProfile(options, boundary, run, execution),
    repository: options.sourceImageIntelligenceRepository,
    sourceAssetLoader: options.sourceAnalysisAssetLoader,
    gateway: options.gateway,
    gatewayExecution: projectedGatewayExecution(execution),
  };
}

async function loadCleanupEvidenceRow(options, message, boundary, run) {
  const row = exactSingleRow(await safeQuery(options.pool,
    `SELECT assessment.source_asset_id,assessment.source_ordinal,assessment.record_status,
            assessment.object_key,assessment.content_hash,assessment.content_type,assessment.size_bytes,
            assessment.terminal_status,assessment.assessment,
            derivative.attempt_no AS derivative_attempt_no,
            previous.status AS previous_status,previous.check_result AS previous_check_result
       FROM auto_listing_source_image_derivatives AS derivative
       JOIN auto_listing_source_image_assessments AS assessment
         ON assessment.account_id=derivative.account_id AND assessment.job_id=derivative.job_id
        AND assessment.item_id=derivative.item_id AND assessment.analysis_run_id=derivative.analysis_run_id
        AND assessment.source_asset_id=derivative.source_asset_id
        AND assessment.expected_status_version=derivative.expected_status_version
       LEFT JOIN auto_listing_source_image_derivatives AS previous
         ON previous.account_id=derivative.account_id AND previous.job_id=derivative.job_id
        AND previous.item_id=derivative.item_id AND previous.analysis_run_id=derivative.analysis_run_id
        AND previous.source_asset_id=derivative.source_asset_id
        AND previous.expected_status_version=derivative.expected_status_version
        AND previous.attempt_no=derivative.attempt_no-1
      WHERE derivative.account_id=$1 AND derivative.job_id=$2 AND derivative.item_id=$3
        AND derivative.analysis_run_id=$4 AND derivative.expected_status_version=$5
        AND derivative.derivative_attempt_id=$6
      FOR SHARE OF derivative,assessment`,
    [boundary.accountId, boundary.jobId, boundary.itemId, run.id,
      boundary.statusVersion, message.derivativeAttemptId]));
  if (row.record_status !== "ACCEPTED" || row.terminal_status !== "ANALYZED"
    || !isSafeAutoListingAiIdentifier(row.source_asset_id)
    || !Number.isInteger(Number(row.derivative_attempt_no))
    || Number(row.derivative_attempt_no) < 1 || Number(row.derivative_attempt_no) > 3
    || !validText(row.object_key, 2_048) || !validHash(row.content_hash)
    || !["image/png", "image/jpeg", "image/webp"].includes(row.content_type)
    || !Number.isSafeInteger(Number(row.size_bytes)) || Number(row.size_bytes) < 1) throw evidenceInvalid();
  const assessment = jsonValue(row.assessment);
  if (!plainObject(assessment) || assessment.sourceAssetId !== row.source_asset_id
    || assessment.objectKey !== row.object_key || assessment.contentHash !== row.content_hash) throw evidenceInvalid();
  return Object.freeze({ ...row, derivative_attempt_no: Number(row.derivative_attempt_no), assessment });
}

function cleanupPreviousReasonCodes(row) {
  if (row.derivative_attempt_no === 1) {
    if (row.previous_status !== null && row.previous_status !== undefined) throw evidenceInvalid();
    return [];
  }
  const result = jsonValue(row.previous_check_result);
  if (row.previous_status !== "REJECTED" || !plainObject(result)
    || !Array.isArray(result.reasonCodes) || result.reasonCodes.length < 1
    || result.reasonCodes.length > 20 || new Set(result.reasonCodes).size !== result.reasonCodes.length
    || result.reasonCodes.some((code) => typeof code !== "string"
      || !/^[A-Z][A-Z0-9_]{0,119}$/u.test(code))) throw evidenceInvalid();
  return [...result.reasonCodes];
}

function cleanupAttemptScope(boundary, run, sourceAssetId, derivativeAttemptId) {
  return Object.freeze({
    accountId: boundary.accountId,
    jobId: boundary.jobId,
    itemId: boundary.itemId,
    analysisRunId: run.id,
    sourceAssetId,
    expectedStatusVersion: boundary.statusVersion,
    derivativeAttemptId,
  });
}

function assertDerivedCleanupAttempt(attempt, expected) {
  const fields = [
    "accountId", "jobId", "itemId", "analysisRunId", "sourceAssetId",
    "expectedStatusVersion", "derivativeAttemptId", "inputHash", "attemptNo",
    "originalContentHash", "overlayDecisionHash", "promptVersion",
  ];
  if (!plainObject(attempt) || fields.some((key) => attempt[key] !== expected[key])) throw evidenceInvalid();
}

async function loadCleanupOriginal(options, boundary, run, row) {
  if (!options.sourceAnalysisAssetLoader
    || typeof options.sourceAnalysisAssetLoader.loadSourceAsset !== "function") throw evidenceInvalid();
  let loaded;
  try {
    loaded = await options.sourceAnalysisAssetLoader.loadSourceAsset({
      scope: {
        accountId: boundary.accountId, jobId: boundary.jobId, itemId: boundary.itemId,
        expectedStatusVersion: boundary.statusVersion,
      },
      run,
      materializedAsset: {
        sourceAssetId: row.source_asset_id,
        sourceOrdinal: row.source_ordinal,
        sizeBytes: Number(row.size_bytes),
        contentHash: row.content_hash,
        objectKey: row.object_key,
        contentType: row.content_type,
      },
    });
  } catch { throw evidenceInvalid(); }
  let inspected;
  try {
    inspected = await inspectSourceListingImage({
      bytes: loaded?.bytes,
      maxInputBytes: 8 * 1024 * 1024,
      maxInputPixels: 40_000_000,
    });
  } catch { throw evidenceInvalid(); }
  if (loaded?.contentType !== row.content_type || inspected.contentType !== row.content_type
    || inspected.contentHash !== row.content_hash || inspected.bytes.length !== Number(row.size_bytes)) {
    throw evidenceInvalid();
  }
  return Object.freeze({
    bytes: Buffer.from(inspected.bytes), contentType: inspected.contentType,
    contentHash: inspected.contentHash, width: inspected.width, height: inspected.height,
  });
}

async function loadCleanupCore(options, message, boundary) {
  if (!options.sourceImageDerivativeRepository
    || typeof options.sourceImageDerivativeRepository.loadAttempt !== "function") throw evidenceInvalid();
  const run = await loadCurrentAnalysisRun(options, boundary);
  if (run.id !== message.analysisRunId || run.contractVersion !== "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2"
    || !["RECONCILING", "ACCEPTED", "CONFIRMATION_REQUIRED"].includes(run.status)) throw evidenceInvalid();
  const row = await loadCleanupEvidenceRow(options, message, boundary, run);
  const scope = cleanupAttemptScope(boundary, run, row.source_asset_id, message.derivativeAttemptId);
  let attempt;
  try { attempt = await options.sourceImageDerivativeRepository.loadAttempt(scope); }
  catch { throw evidenceInvalid(); }
  if (!attempt) throw evidenceInvalid();
  const previousReasonCodes = cleanupPreviousReasonCodes(row);
  let expected;
  try {
    expected = deriveSourceImageCleanupAttempt({
      accountId: boundary.accountId,
      jobId: boundary.jobId,
      itemId: boundary.itemId,
      analysisRunId: run.id,
      expectedStatusVersion: boundary.statusVersion,
      assessment: row.assessment,
      attemptNo: row.derivative_attempt_no,
      previousReasonCodes,
    });
  } catch { throw evidenceInvalid(); }
  assertDerivedCleanupAttempt(attempt, expected);
  return Object.freeze({
    run,
    attempt: Object.freeze(structuredClone(attempt)),
    cleanupInput: expected.cleanupInput,
    original: await loadCleanupOriginal(options, boundary, run, row),
  });
}

export async function loadSourceImageCleanupInput(options, message, boundary, execution) {
  const loaded = await loadCleanupCore(options, message, boundary);
  if (!["RESERVED", "GENERATED", "ACCEPTED", "REJECTED"].includes(loaded.attempt.status)) {
    throw evidenceInvalid();
  }
  return {
    attempt: loaded.attempt,
    cleanupInput: loaded.cleanupInput,
    original: loaded.original,
    profile: await loadAnalysisProfile(options, boundary, loaded.run, execution),
    gateway: options.gateway,
    repository: options.sourceImageDerivativeRepository,
    storage: options.storage,
    cleanupRecorder: null,
    gatewayExecution: projectedGatewayExecution(execution),
  };
}

export async function loadSourceImageCleanupCheckInput(options, message, boundary, execution) {
  const loaded = await loadCleanupCore(options, message, boundary);
  if (loaded.attempt.status !== "GENERATED") throw evidenceInvalid();
  let candidate;
  try {
    candidate = await loadStoredSourceImageDerivative({ attempt: loaded.attempt, storage: options.storage });
  } catch { throw evidenceInvalid(); }
  return {
    attempt: loaded.attempt,
    original: loaded.original,
    candidate,
    profile: await loadAnalysisProfile(options, boundary, loaded.run, execution),
    gateway: options.gateway,
    repository: options.sourceImageDerivativeRepository,
    gatewayExecution: projectedGatewayExecution(execution),
  };
}

async function loadAnalysisRunAncestorIds(options, boundary, run) {
  if (run.parentRunId === null) return [];
  const result = await safeQuery(options.pool,
    `WITH RECURSIVE lineage AS (
       SELECT parent.id,parent.parent_run_id,1 AS depth,ARRAY[current.id,parent.id]::TEXT[] AS path
         FROM auto_listing_source_image_analysis_runs AS current
         JOIN auto_listing_source_image_analysis_runs AS parent
           ON parent.account_id=current.account_id AND parent.job_id=current.job_id
          AND parent.item_id=current.item_id AND parent.id=current.parent_run_id
        WHERE current.account_id=$1 AND current.job_id=$2 AND current.item_id=$3 AND current.id=$4
       UNION ALL
       SELECT parent.id,parent.parent_run_id,child.depth+1,child.path || parent.id
         FROM lineage AS child
         JOIN auto_listing_source_image_analysis_runs AS parent
           ON parent.account_id=$1 AND parent.job_id=$2 AND parent.item_id=$3
          AND parent.id=child.parent_run_id
        WHERE child.depth<99 AND NOT parent.id=ANY(child.path)
     ) SELECT id,parent_run_id,depth FROM lineage ORDER BY depth`,
    [boundary.accountId, boundary.jobId, boundary.itemId, run.id]);
  if (!result || !Array.isArray(result.rows) || result.rows.length < 1 || result.rows.length > 99) {
    throw evidenceInvalid();
  }
  let expectedId = run.parentRunId;
  const ids = [];
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index];
    if (!plainObject(row) || row.id !== expectedId || row.depth !== index + 1
      || !isSafeAutoListingAiIdentifier(row.id)
      || !(row.parent_run_id === null || isSafeAutoListingAiIdentifier(row.parent_run_id))) {
      throw evidenceInvalid();
    }
    ids.push(row.id);
    expectedId = row.parent_run_id;
  }
  if (expectedId !== null || new Set(ids).size !== ids.length) throw evidenceInvalid();
  return ids;
}

async function loadAcceptedDerivativeBindingsForLineage(options, boundary, run) {
  const runIds = [run.id, ...await loadAnalysisRunAncestorIds(options, boundary, run)];
  const bySourceAssetId = new Map();
  for (const analysisRunId of runIds) {
    let bindings;
    try {
      bindings = await options.sourceImageDerivativeRepository.listAcceptedBindings({
        accountId: boundary.accountId,
        jobId: boundary.jobId,
        itemId: boundary.itemId,
        analysisRunId,
      });
    } catch { throw evidenceInvalid(); }
    if (!Array.isArray(bindings)) throw evidenceInvalid();
    const seen = new Set();
    for (const binding of bindings) {
      if (!plainObject(binding) || !isSafeAutoListingAiIdentifier(binding.sourceAssetId)
        || seen.has(binding.sourceAssetId)) throw evidenceInvalid();
      seen.add(binding.sourceAssetId);
      if (!bySourceAssetId.has(binding.sourceAssetId)) {
        bySourceAssetId.set(binding.sourceAssetId, structuredClone(binding));
      }
    }
  }
  return [...bySourceAssetId.values()].sort((left, right) =>
    left.sourceAssetId.localeCompare(right.sourceAssetId, "en"));
}

export async function loadSourceImageReconcileInput(options, message, boundary) {
  const run = await loadCurrentAnalysisRun(options, boundary);
  if (run.id !== message.analysisRunId
    || !["RECONCILING", "ACCEPTED", "CONFIRMATION_REQUIRED"].includes(run.status)) throw evidenceInvalid();
  const rows = await loadAnalysisAssessmentRows(options, boundary, run);
  if (rows.length !== run.expectedAssetCount || rows.some(({ record_status }) => record_status !== "ACCEPTED")) {
    throw evidenceInvalid();
  }
  const assessments = rows.map((row) => ({
    sourceAssetId: row.source_asset_id, terminalStatus: row.terminal_status,
    resultHash: row.result_hash, assessment: jsonValue(row.assessment),
  }));
  let acceptedDerivativeBindings = [];
  if (run.contractVersion === "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2") {
    if (!options.sourceImageDerivativeRepository
      || typeof options.sourceImageDerivativeRepository.listAcceptedBindings !== "function") throw evidenceInvalid();
    acceptedDerivativeBindings = await loadAcceptedDerivativeBindingsForLineage(options, boundary, run);
  }
  return {
    run,
    sourceCapture: await loadAnalysisSnapshot(options, boundary),
    assessments,
    decisions: run.decisionSet,
    acceptedDerivativeBindings,
    repository: options.sourceImageIntelligenceRepository,
    summaryInputHash: sha256({
      runInputHash: run.inputHash,
      assessmentHashes: assessments.map(({ sourceAssetId, resultHash }) => ({ sourceAssetId, resultHash })),
      decisions: run.decisionSet,
      acceptedDerivativeBindings,
    }),
  };
}

async function loadMaterializeInput(options, message, boundary, execution) {
  const row = await loadActiveBundle(options, boundary, execution);
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

async function loadFinalizeInput(options, boundary, execution) {
  const parentPlan = mapPlan(await loadActiveBundle(options, boundary, execution));
  assertPlanScope(parentPlan, boundary);
  let sourceMaterializationScope = null;
  if (parentPlan.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1") {
    const analysisRun = await loadCurrentAnalysisRun(options, boundary, { allowEarlierStatusVersion: true });
    if (analysisRun.status !== "ACCEPTED" || parentPlan.sourceImageAnalysisRunId !== analysisRun.id
      || parentPlan.sourceImageIntelligenceHash !== analysisRun.summaryHash) throw evidenceInvalid();
  }
  const plannedSourceAssetIds = new Set(parentPlan.visualGroups.groups
    .flatMap((group) => group.referenceImages.map(({ assetId }) => assetId)));
  if (parentPlan.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1") {
    sourceMaterializationScope = await loadSourceMaterializationScope(
      options, boundary, [...plannedSourceAssetIds],
    );
  }
  const listAcceptedSourceMaterializations = parentPlan.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
    ? async (input) => {
      if (!exactObject(input, new Set(["accountId", "jobId", "itemId", "sourceImageAnalysisRunId", "expectedStatusVersion"]))
        || input.accountId !== boundary.accountId || input.jobId !== boundary.jobId || input.itemId !== boundary.itemId
        || input.sourceImageAnalysisRunId !== sourceMaterializationScope.analysisRunId
        || input.expectedStatusVersion !== sourceMaterializationScope.expectedStatusVersion) throw evidenceInvalid();
      const result = await safeQuery(options.pool,
        `SELECT * FROM auto_listing_source_materialization_attempts
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND source_analysis_run_id=$4
            AND expected_status_version=$5 AND source_asset_id = ANY($6::text[]) AND status='ACCEPTED'
          ORDER BY source_asset_id,attempt_no LIMIT 101`,
        [boundary.accountId, boundary.jobId, boundary.itemId, sourceMaterializationScope.analysisRunId,
          sourceMaterializationScope.expectedStatusVersion, [...plannedSourceAssetIds]]);
      if (!Array.isArray(result?.rows) || result.rows.length > 100) throw evidenceInvalid();
      return result.rows.filter((row) => plannedSourceAssetIds.has(row.source_asset_id)).map((row) => ({
        attemptId: row.id,
        accountId: row.account_id,
        jobId: row.job_id,
        itemId: row.item_id,
        owner: { kind: "SOURCE_IMAGE_ANALYSIS", id: row.source_analysis_run_id },
        sourceAssetId: row.source_asset_id,
        sourceRefHash: row.source_ref_hash,
        inputHash: row.input_hash,
        expectedStatusVersion: row.expected_status_version,
        attemptNo: row.attempt_no,
        status: row.status,
        leaseOwner: row.lease_owner,
        leaseToken: row.lease_token,
        leaseExpiresAt: row.lease_expires_at,
        objectKeyVersion: row.object_key_version,
        objectKey: row.object_key,
        contentHash: row.content_hash,
        contentType: row.content_type,
        width: row.width,
        height: row.height,
        sizeBytes: row.size_bytes,
        acceptedAt: canonicalTime(row.accepted_at),
        errorCode: row.error_code,
        errorRetryable: row.error_retryable,
        createdAt: canonicalTime(row.created_at),
        updatedAt: canonicalTime(row.updated_at),
      }));
    }
    : (input) => options.sourceMaterializationRepository.listAcceptedSourceMaterializations(input);
  return {
    parentPlan,
    ...(sourceMaterializationScope === null ? {} : { sourceMaterializationScope }),
    repository: Object.freeze({
      listAcceptedSourceMaterializations,
      createDerivedMaterializedPlan: (input) => options.contentPlanRepository
        .createDerivedMaterializedPlan(input),
    }),
  };
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

async function loadImageInput(options, message, boundary, execution) {
  const row = await loadActiveBundle(options, boundary, execution);
  const persistedPlan = mapPlan(row);
  assertPlanScope(persistedPlan, boundary);
  assertDerivedPlan(persistedPlan);
  const sourceImageAnalysisRun = persistedPlan.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
    ? await loadAcceptedAnalysisForPlan(options, boundary, persistedPlan)
    : null;
  let groupRegeneration = null;
  if (sourceImageAnalysisRun) {
    const targetSlot = findSlot(persistedPlan, message.slotKey);
    const latestGroupCheck = await safeQuery(options.pool,
      `WITH latest_group_check AS (
         SELECT 'GROUP_CHECK'::TEXT AS evidence_kind,id,visual_group_key,
                expected_status_version,status,result,completed_at,created_at
           FROM auto_listing_image_group_checks
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
            AND visual_group_key=$5 AND expected_status_version<=$6
          ORDER BY expected_status_version DESC,completed_at DESC NULLS LAST,created_at DESC,id DESC
          LIMIT 1
       ), latest_slot_recovery AS (
         SELECT 'SLOT_RECOVERY'::TEXT AS evidence_kind,id,$5::TEXT AS visual_group_key,
                transition_version AS expected_status_version,'RECOVERY'::TEXT AS status,
                jsonb_build_object('retrySlotKeys',details->'retrySlotKeys') AS result,
                NULL::TIMESTAMPTZ AS completed_at,created_at
           FROM auto_listing_events
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3
            AND event_type='AI_IMAGE_SLOT_RECOVERY_QUEUED'
            AND details->>'planId'=$4 AND details->'retrySlotKeys' ? $7
            AND transition_version IS NOT NULL AND transition_version<=$6
          ORDER BY transition_version DESC,created_at DESC,id DESC
          LIMIT 1
       )
       SELECT evidence_kind,id,visual_group_key,expected_status_version,status,result
         FROM (
           SELECT * FROM latest_group_check
           UNION ALL
           SELECT * FROM latest_slot_recovery
         ) AS quality_retry
        ORDER BY expected_status_version DESC,
                 CASE WHEN evidence_kind='GROUP_CHECK' THEN 0 ELSE 1 END,
                 completed_at DESC NULLS LAST,created_at DESC,id DESC
        LIMIT 1`,
      [boundary.accountId, boundary.jobId, boundary.itemId, persistedPlan.id,
        targetSlot.visualGroupKey, boundary.statusVersion, message.slotKey]);
    if (!latestGroupCheck || !Array.isArray(latestGroupCheck.rows)
      || latestGroupCheck.rows.length > 1) throw evidenceInvalid();
    if (latestGroupCheck.rows.length === 1) {
      const check = latestGroupCheck.rows[0];
      const result = jsonValue(check.result);
      const evidenceKind = check.evidence_kind ?? "GROUP_CHECK";
      if (!isSafeAutoListingAiIdentifier(check.id)
        || check.visual_group_key !== targetSlot.visualGroupKey
        || !validVersion(check.expected_status_version)
        || check.expected_status_version > boundary.statusVersion
        || !plainObject(result) || !Array.isArray(result.retrySlotKeys)) throw evidenceInvalid();
      if (evidenceKind === "GROUP_CHECK" && !["ACCEPTED", "REJECTED"].includes(check.status)) {
        throw evidenceInvalid();
      }
      if (evidenceKind === "SLOT_RECOVERY"
        && (check.status !== "RECOVERY" || !result.retrySlotKeys.includes(message.slotKey))) {
        throw evidenceInvalid();
      }
      if (!new Set(["GROUP_CHECK", "SLOT_RECOVERY"]).has(evidenceKind)) throw evidenceInvalid();
      if ((evidenceKind === "GROUP_CHECK" && check.status === "REJECTED"
          && result.retrySlotKeys.includes(message.slotKey))
        || evidenceKind === "SLOT_RECOVERY") {
        groupRegeneration = { requestId: check.id, reason: "QUALITY_RETRY" };
      }
    }
  }
  const config = configCapture(row).configSnapshot;
  const profile = gatewayProfile(row, execution);
  const projected = options.referenceProjector({
    accountId: boundary.accountId,
    jobId: boundary.jobId,
    itemId: boundary.itemId,
    planId: persistedPlan.id,
    plan: persistedPlan,
    slot: findSlot(persistedPlan, message.slotKey),
  });
  if (!plainObject(projected) || !plainObject(projected.plan) || !plainObject(projected.slot)
    || !Array.isArray(projected.references)) throw evidenceInvalid();
  const { plan, slot } = projected;
  const { categoryStyle, categoryStyleReferences } = await loadCategoryStyle(
    options, row, plan, slot, config.useCategoryStrategy !== false,
  );
  const ratio = config.image?.ratio;
  const resolution = config.image?.resolution;
  const groupSlotCount = plan.plan.slots.filter(
    (candidate) => candidate.visualGroupKey === slot.visualGroupKey,
  ).length;
  return {
    plan,
    slot,
    categoryStyle,
    categoryStyleReferences,
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
    regeneration: groupRegeneration ?? plan.regeneration,
    storage: options.storage,
    logger: options.logger,
    maxAttempts: slot.role === "MAIN" || groupSlotCount === MINIMUM_ACCEPTED_IMAGES_PER_GROUP
      ? options.maxAttempts
      : Math.min(options.maxAttempts, 2),
    gatewayExecution: projectedGatewayExecution(execution),
    ...(sourceImageAnalysisRun
      ? { sourceImageIntelligenceSummary: sourceImageAnalysisRun.summary }
      : {}),
  };
}

async function loadAcceptedAssets(options, boundary, { allowUnversionedLegacyAssets = false } = {}) {
  const result = await safeQuery(options.pool,
    `SELECT ranked.*
       FROM (
         SELECT DISTINCT ON (asset.slot_key)
                asset.id,asset.account_id,asset.job_id,asset.item_id,asset.plan_id,
                asset.visual_group_key,asset.slot_key,asset.role,asset.attempt_identity_hash,
                asset.attempt_no,asset.input_hash,asset.generation_size,asset.status,asset.content_hash,
                asset.object_key_version,asset.object_key,asset.content_type,asset.width,asset.height,
                asset.size_bytes,asset.gateway_request_id,asset.checker_request_id,asset.model_evidence,
                asset.profile_id,asset.profile_version,asset.model_name,asset.plan_hash,asset.source_hash,
                asset.strategy_hash,asset.config_hash,asset.visual_groups_hash,asset.prompt_template_version,
                asset.prompt_hash,asset.checker_result,asset.source_asset_evidence,asset.regeneration,
                asset.expected_status_version,asset.created_at AS asset_created_at,
                plan.prompt_template_version AS plan_prompt_template_version,
                planned_slot AS planned_slot_contract
           FROM ai_generation_assets AS asset
           JOIN ai_content_plans AS plan
             ON plan.account_id=asset.account_id AND plan.job_id=asset.job_id
               AND plan.item_id=asset.item_id AND plan.id=asset.plan_id
           CROSS JOIN LATERAL jsonb_array_elements(plan.plan->'slots') AS planned_slot
          WHERE asset.account_id=$1 AND asset.job_id=$2 AND asset.item_id=$3 AND asset.plan_id=$4
            AND (asset.expected_status_version IS NULL OR asset.expected_status_version<=$5)
            AND planned_slot->>'slotKey'=asset.slot_key
          ORDER BY asset.slot_key ASC,asset.expected_status_version DESC NULLS LAST,
                   asset.created_at DESC,asset.attempt_no DESC,asset.id DESC
       ) AS ranked
      WHERE ranked.status='ACCEPTED'
        AND NOT EXISTS (
          SELECT 1
            FROM auto_listing_events AS skipped
           WHERE skipped.account_id=ranked.account_id
             AND skipped.job_id=ranked.job_id
             AND skipped.item_id=ranked.item_id
             AND skipped.event_type='AI_IMAGE_SLOT_SKIPPED'
             AND skipped.details->>'planId'=ranked.plan_id
             AND skipped.details->>'slotKey'=ranked.slot_key
             AND CASE WHEN skipped.details->>'statusVersion' ~ '^[1-9][0-9]{0,9}$'
                      THEN (ranked.expected_status_version IS NULL
                        OR (skipped.details->>'statusVersion')::BIGINT>=ranked.expected_status_version)
                        AND (skipped.details->>'statusVersion')::BIGINT<=$5
                      ELSE FALSE END
             AND skipped.created_at>=ranked.asset_created_at
        )
        AND (ranked.plan_prompt_template_version NOT IN ('AUTO_LISTING_CONTENT_PLAN_FILL_V3','AUTO_LISTING_CONTENT_PLAN_FILL_V4','AUTO_LISTING_CONTENT_PLAN_FILL_V5','AUTO_LISTING_CONTENT_PLAN_FILL_V6')
          OR jsonb_array_length(ranked.planned_slot_contract->'claims')>0
          OR (ranked.plan_prompt_template_version='AUTO_LISTING_CONTENT_PLAN_FILL_V6'
            AND ranked.planned_slot_contract->>'role'='MAIN')
          OR ranked.checker_result->>'textForbidden'='true')
      ORDER BY ranked.slot_key ASC`,
    [boundary.accountId, boundary.jobId, boundary.itemId, boundary.activeContentPlanId,
      boundary.statusVersion]);
  if (!result || !Array.isArray(result.rows)) throw evidenceInvalid();
  const assets = result.rows.map(mapAcceptedAsset);
  const ids = new Set();
  const slots = new Set();
  for (const asset of assets) {
    const statusVersionValid = validVersion(asset.expectedStatusVersion)
      || (allowUnversionedLegacyAssets && asset.expectedStatusVersion === null);
    if (asset.accountId !== boundary.accountId || asset.jobId !== boundary.jobId
      || asset.itemId !== boundary.itemId || asset.planId !== boundary.activeContentPlanId
      || asset.status !== "ACCEPTED" || !isSafeAutoListingAiIdentifier(asset.id)
      || !isSafeAutoListingAiIdentifier(asset.slotKey)
      || !statusVersionValid
      || (asset.expectedStatusVersion !== null && asset.expectedStatusVersion > boundary.statusVersion)
      || ids.has(asset.id) || slots.has(asset.slotKey)) {
      throw evidenceInvalid();
    }
    ids.add(asset.id);
    slots.add(asset.slotKey);
  }
  return assets;
}

async function loadSkippedTargetSlots(options, boundary, missingSlotKeys) {
  const result = await safeQuery(options.pool,
    `SELECT account_id,job_id,item_id,details->>'planId' AS plan_id,
            details->>'slotKey' AS slot_key,details->>'statusVersion' AS status_version
       FROM auto_listing_events
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3
        AND event_type='AI_IMAGE_SLOT_SKIPPED' AND details->>'planId'=$4
        AND CASE WHEN details->>'statusVersion' ~ '^[1-9][0-9]{0,9}$'
                 THEN (details->>'statusVersion')::BIGINT <= $5 ELSE FALSE END
        AND details->>'slotKey'=ANY($6::TEXT[])
      ORDER BY details->>'slotKey',transition_version DESC,id DESC`,
    [boundary.accountId, boundary.jobId, boundary.itemId, boundary.activeContentPlanId,
      boundary.statusVersion, missingSlotKeys]);
  if (!result || !Array.isArray(result.rows)) throw evidenceInvalid();
  const missing = new Set(missingSlotKeys);
  const skipped = new Set();
  for (const row of result.rows) {
    const statusVersion = Number(row.status_version);
    if (row.account_id !== boundary.accountId || row.job_id !== boundary.jobId
      || row.item_id !== boundary.itemId || row.plan_id !== boundary.activeContentPlanId
      || !missing.has(row.slot_key) || !validVersion(statusVersion)
      || statusVersion > boundary.statusVersion) throw evidenceInvalid();
    skipped.add(row.slot_key);
  }
  return skipped;
}

async function loadRichInput(options, boundary, execution) {
  const row = await loadActiveBundle(options, boundary, execution);
  const plan = mapPlan(row, { rich: true });
  assertPlanScope(plan, boundary);
  assertDerivedPlan(plan);
  if (plan.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1") {
    await loadAcceptedAnalysisForPlan(options, boundary, plan);
  }
  const acceptedAssets = await loadAcceptedAssets(options, boundary, {
    allowUnversionedLegacyAssets: plan.planningContract !== "FIXED_SKELETON_SOURCE_IMAGE_V1",
  });
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
    profile: gatewayProfile(row, execution),
    gateway: options.gateway,
    repository: options.richContentRepository,
    factRegistry: plan.factRegistry,
    acceptedAssets,
    planHash: plan.planHash,
    sourceHash: plan.sourceHash,
    promptTemplateVersion: plan.promptTemplateVersion,
    maxAttempts: options.richContentMaxAttempts,
    leaseOwner: options.richContentLeaseOwner,
    gatewayExecution: projectedGatewayExecution(execution),
  };
}

export async function loadImageGroupCheckInput(options, message, boundary, execution) {
  const row = await loadActiveBundle(options, boundary, execution);
  const plan = mapPlan(row, { rich: true });
  assertPlanScope(plan, boundary);
  assertDerivedPlan(plan);
  if (plan.planningContract !== "FIXED_SKELETON_SOURCE_IMAGE_V1") throw evidenceInvalid();
  const analysisRun = await loadAcceptedAnalysisForPlan(options, boundary, plan);
  const groups = plan.visualGroups.groups.filter((group) => group?.visualGroupKey === message.visualGroupKey);
  if (groups.length !== 1) throw evidenceInvalid();
  const acceptedAssets = (await loadAcceptedAssets(options, boundary))
    .filter(({ visualGroupKey }) => visualGroupKey === message.visualGroupKey);
  const plannedSlots = plan.plan.slots.filter(({ visualGroupKey }) => visualGroupKey === message.visualGroupKey);
  const plannedSlotKeys = new Set(plannedSlots.map(({ slotKey }) => slotKey));
  const acceptedSlotKeys = new Set(acceptedAssets.map(({ slotKey }) => slotKey));
  if (plannedSlotKeys.size !== plannedSlots.length || acceptedSlotKeys.size !== acceptedAssets.length
    || acceptedAssets.length < 6 || acceptedAssets.length > 13
    || acceptedAssets.some(({ slotKey }) => !plannedSlotKeys.has(slotKey))) throw evidenceInvalid();
  if (acceptedAssets.length !== plannedSlots.length) {
    const missingSlotKeys = [...plannedSlotKeys].filter((slotKey) => !acceptedSlotKeys.has(slotKey)).sort();
    const skippedSlotKeys = await loadSkippedTargetSlots(options, boundary, missingSlotKeys);
    if (skippedSlotKeys.size !== missingSlotKeys.length
      || missingSlotKeys.some((slotKey) => !skippedSlotKeys.has(slotKey))) throw evidenceInvalid();
  }
  const previousCheck = await safeQuery(options.pool,
    `SELECT expected_status_version,status,result
       FROM auto_listing_image_group_checks
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
        AND visual_group_key=$5 AND expected_status_version<$6
        AND status IN ('ACCEPTED','REJECTED')
      ORDER BY expected_status_version DESC,completed_at DESC NULLS LAST,created_at DESC,id DESC
      LIMIT 1`,
    [boundary.accountId, boundary.jobId, boundary.itemId, boundary.activeContentPlanId,
      message.visualGroupKey, boundary.statusVersion]);
  if (!previousCheck || !Array.isArray(previousCheck.rows) || previousCheck.rows.length > 1) {
    throw evidenceInvalid();
  }
  let frozenAcceptedSlotKeys = [];
  if (previousCheck.rows.length === 1) {
    const previous = previousCheck.rows[0];
    const previousVersion = Number(previous?.expected_status_version);
    let previousResult = null;
    try { previousResult = jsonValue(previous?.result); } catch { /* optional recovery hint */ }
    const previousAcceptedSlotKeys = previousResult?.acceptedSlotKeys;
    const reliablePreviousEvidence = validVersion(previousVersion)
      && previousVersion < boundary.statusVersion
      && ["ACCEPTED", "REJECTED"].includes(previous?.status)
      && Array.isArray(previousAcceptedSlotKeys)
      && new Set(previousAcceptedSlotKeys).size === previousAcceptedSlotKeys.length
      && previousAcceptedSlotKeys.every((slotKey) =>
        isSafeAutoListingAiIdentifier(slotKey) && plannedSlotKeys.has(slotKey));
    if (reliablePreviousEvidence) {
      const assetBySlotKey = new Map(acceptedAssets.map((asset) => [asset.slotKey, asset]));
      frozenAcceptedSlotKeys = previousAcceptedSlotKeys.filter((slotKey) => {
        const asset = assetBySlotKey.get(slotKey);
        return asset && validVersion(asset.expectedStatusVersion)
          && asset.expectedStatusVersion <= previousVersion;
      }).sort();
    }
  }
  return {
    plan,
    acceptedAssets,
    frozenAcceptedSlotKeys,
    sourceImageIntelligence: analysisRun.summary,
    gatewayProfile: gatewayProfile(row, execution),
    gateway: options.gateway,
    repository: options.imageGroupCheckRepository,
    checker: options.imageGroupChecker,
    analysisRun,
    gatewayExecution: projectedGatewayExecution(execution),
  };
}

export function createPostgresAutoListingAiPhaseContextLoader(options = {}) {
  validateOptions(options);
  return async function loadContext(rawRequest) {
    const { message, execution, phaseAttempt } = normalizeContextRequest(rawRequest);
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
        if (message.phase === "PLAN_CONTENT") phaseInput = await loadPlanInput(
          runtimeOptions,
          message,
          boundary,
          execution,
          { allowEarlierAnalysisStatusVersion: boundary.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1" },
        );
        else if (message.phase === "MATERIALIZE_SOURCE_ASSET" && boundary.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1") {
          phaseInput = await loadMaterializeAnalysisInput(runtimeOptions, message, boundary, phaseAttempt ?? undefined);
        }
        else if (message.phase === "MATERIALIZE_SOURCE_ASSET") phaseInput = await loadMaterializeInput(runtimeOptions, message, boundary, execution);
        else if (message.phase === "ANALYZE_SOURCE_IMAGE_BATCH") phaseInput = await loadSourceImageBatchInput(runtimeOptions, message, boundary, execution);
        else if (message.phase === "CLEAN_SOURCE_IMAGE_OVERLAY") phaseInput = await loadSourceImageCleanupInput(runtimeOptions, message, boundary, execution);
        else if (message.phase === "CHECK_SOURCE_IMAGE_CLEANUP") phaseInput = await loadSourceImageCleanupCheckInput(runtimeOptions, message, boundary, execution);
        else if (message.phase === "RECONCILE_SOURCE_IMAGE_ANALYSIS") phaseInput = await loadSourceImageReconcileInput(runtimeOptions, message, boundary);
        else if (message.phase === "FINALIZE_MATERIALIZED_PLAN") phaseInput = await loadFinalizeInput(runtimeOptions, boundary, execution);
        else if (message.phase === "GENERATE_IMAGE_SLOT") phaseInput = await loadImageInput(runtimeOptions, message, boundary, execution);
        else if (message.phase === "CHECK_IMAGE_GROUP") phaseInput = await loadImageGroupCheckInput(runtimeOptions, message, boundary, execution);
        else phaseInput = await loadRichInput(runtimeOptions, boundary, execution);
        result = closedContext(boundary, phaseInput);
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try { await client?.query("ROLLBACK"); } catch {}
      }
      if (typeof error?.code === "string" && (error.code.startsWith("AUTO_LISTING_AI_PHASE_CONTEXT_")
        || error.code === "AUTO_LISTING_CATEGORY_STRATEGY_REFERENCE_FORBIDDEN")) throw error;
      throw databaseFailed();
    } finally {
      try { client?.release(); } catch {}
    }
  };
}

export const createPostgresAutoListingAiContextLoader = createPostgresAutoListingAiPhaseContextLoader;

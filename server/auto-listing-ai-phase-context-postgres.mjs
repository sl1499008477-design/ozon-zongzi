import crypto from "node:crypto";
import { types } from "node:util";

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
  "pool", "gateway", "contentPlanRepository", "contentPlanEvidenceRepository", "sourceMaterializationRepository",
  "generationRepository", "richContentRepository", "downloader", "storage",
  "sourceAssetLoader", "logger", "planPromptTemplateVersion", "prohibitedClaims",
  "maxAttempts", "richContentLeaseOwner", "referenceProjector",
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
const PLAN_BODY_KEYS = new Set(["version", "language", "slots"]);
const SLOT_KEYS = new Set([
  "slotKey", "visualGroupKey", "role", "order", "textDensity", "claims", "sourceFactIds",
  "referenceAssetIds", "preserve", "prohibitedClaims",
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
const PLAN_COLUMNS = `
  p.id,p.account_id,p.job_id,p.item_id,p.source_snapshot_id,p.strategy_version_id,p.profile_id,
  p.strategy_hash,p.config_hash,p.source_hash,p.input_hash,p.planner_model,p.profile_version,
  p.prompt_template_version,p.plan,p.plan_hash,p.visual_groups_hash,p.visual_groups,p.fact_registry,
  p.regeneration,p.gateway_request_id,p.parent_plan_id,p.derivation_kind,p.materialization_set_hash,
  p.planning_contract,p.skeleton_hash`;

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

function projectGenerationSlot(value) {
  if (!exactObject(value, SLOT_KEYS) || !isSafeAutoListingAiIdentifier(value.slotKey)
    || !isSafeAutoListingAiIdentifier(value.visualGroupKey) || !ROLES.has(value.role)
    || !Number.isInteger(value.order) || value.order < 1 || value.order > 13
    || !TEXT_DENSITIES.has(value.textDensity) || !Array.isArray(value.claims)
    || value.claims.length > 50) throw evidenceInvalid();
  const slot = {
    slotKey: value.slotKey,
    visualGroupKey: value.visualGroupKey,
    role: value.role,
    order: value.order,
    textDensity: value.textDensity,
    claims: value.claims.map(projectGenerationClaim),
    sourceFactIds: closedStringArray(value.sourceFactIds, { maximum: 100, maxBytes: 240 }),
    referenceAssetIds: closedStringArray(value.referenceAssetIds, { minimum: 1, maximum: 7, maxBytes: 240 }),
    preserve: closedStringArray(value.preserve, { minimum: 1, maximum: 100 }),
    prohibitedClaims: closedStringArray(value.prohibitedClaims, { maximum: 20, maxBytes: 240 }),
  };
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
  if (!exactObject(value, GENERATION_PLAN_KEYS)
    || ![value.id, value.sourceAccountId, value.jobId, value.itemId, value.sourceSnapshotId,
      value.strategyVersionId, value.profileId, value.parentPlanId].every(isSafeAutoListingAiIdentifier)
    || ![value.strategyHash, value.configHash, value.sourceHash, value.inputHash, value.planHash,
      value.visualGroupsHash, value.materializationSetHash].every(validHash)
    || !validText(value.plannerModel) || !validVersion(value.profileVersion)
    || !validText(value.promptTemplateVersion) || value.derivationKind !== "SOURCE_MATERIALIZATION"
    || !["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(value.planningContract)
    || (value.planningContract === "LEGACY_FULL_PLAN_V3" && value.skeletonHash !== null)
    || (value.planningContract === "FIXED_SKELETON_V1" && !validHash(value.skeletonHash))
    || !(value.gatewayRequestId === null || validText(value.gatewayRequestId))
    || !(value.regeneration === null || exactObject(value.regeneration, REGENERATION_KEYS))
    || !exactObject(value.plan, PLAN_BODY_KEYS) || value.plan.version !== 1 || value.plan.language !== "ru"
    || !Array.isArray(value.plan.slots) || value.plan.slots.length < 6 || value.plan.slots.length > 1_000
    || !Array.isArray(value.factRegistry) || !value.factRegistry.length) throw evidenceInvalid();
  if (value.regeneration !== null && (!validText(value.regeneration.requestId)
    || !["USER_REQUESTED", "QUALITY_RETRY", "ADMIN_RETRY"].includes(value.regeneration.reason))) {
    throw evidenceInvalid();
  }
  const slots = value.plan.slots.map(projectGenerationSlot);
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
    plan: { version: 1, language: "ru", slots },
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
  const projectedInputSlot = projectGenerationSlot(input.slot);
  const slots = plan.plan.slots.filter(({ slotKey }) => slotKey === projectedInputSlot.slotKey);
  if (slots.length !== 1
    || JSON.stringify(canonical(slots[0])) !== JSON.stringify(canonical(projectedInputSlot))) throw evidenceInvalid();
  const slot = slots[0];
  const groups = plan.visualGroups.groups.filter((group) => group.visualGroupKey === slot.visualGroupKey);
  if (groups.length !== 1 || !Array.isArray(groups[0].referenceImages)) throw evidenceInvalid();
  const byId = new Map();
  for (const reference of groups[0].referenceImages) {
    if (byId.has(reference.assetId)) throw evidenceInvalid();
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
  if (!["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(base.planningContract)
    || (base.planningContract === "LEGACY_FULL_PLAN_V3" && base.skeletonHash !== null)
    || (base.planningContract === "FIXED_SKELETON_V1" && !validHash(base.skeletonHash))) throw evidenceInvalid();
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
  for (const key of ["gateway", "contentPlanRepository", "contentPlanEvidenceRepository", "sourceMaterializationRepository",
    "generationRepository", "richContentRepository", "downloader", "storage", "sourceAssetLoader"]) {
    if (!options[key] || typeof options[key] !== "object") throw invalid();
  }
  if (typeof options.referenceProjector !== "function") throw invalid();
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
    `SELECT i.planning_contract,s.snapshot,s.snapshot_hash,s.raw_response_ref,
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
  if (!["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(bundle.planning_contract)) {
    throw evidenceInvalid();
  }
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
    planningContract: bundle.planning_contract,
    gatewayProfile: gatewayProfile(bundle),
    gateway: options.gateway,
    repository: options.contentPlanRepository,
    evidenceRepository: options.contentPlanEvidenceRepository,
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

export async function loadFrozenAutoListingPlanningInput(options, boundary) {
  return loadPlanInput(options, null, boundary);
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
                              AND p.planning_contract=i.planning_contract
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
  const persistedPlan = mapPlan(row);
  assertPlanScope(persistedPlan, boundary);
  assertDerivedPlan(persistedPlan);
  const config = configCapture(row).configSnapshot;
  const profile = gatewayProfile(row);
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
  const ratio = config.image?.ratio;
  const resolution = config.image?.resolution;
  return {
    plan,
    slot,
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
      if (typeof error?.code === "string" && (error.code.startsWith("AUTO_LISTING_AI_PHASE_CONTEXT_")
        || error.code === "AUTO_LISTING_CATEGORY_STRATEGY_REFERENCE_FORBIDDEN")) throw error;
      throw databaseFailed();
    } finally {
      try { client?.release(); } catch {}
    }
  };
}

export const createPostgresAutoListingAiContextLoader = createPostgresAutoListingAiPhaseContextLoader;

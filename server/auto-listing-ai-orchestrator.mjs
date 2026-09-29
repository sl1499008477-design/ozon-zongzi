import {
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";

const INPUT_KEYS = Object.freeze(["message", "context"]);
const LEASED_INPUT_KEYS = Object.freeze(["message", "context", "assertLeaseActive"]);
const CONTEXT_KEYS = Object.freeze([
  "accountId", "jobId", "itemId", "status", "statusVersion", "activeContentPlanId", "phaseInput",
]);
const SERVICE_KEYS = Object.freeze([
  "planContent", "materializeSourceAsset", "materializeSourceImageForAnalysis", "analyzeSourceImageBatch",
  "cleanSourceImageOverlay", "checkSourceImageCleanup", "reconcileSourceImageAnalysis",
  "finalizeMaterializedPlan", "generateImageSlot", "checkImageGroup",
  "generateRichContent",
]);
const PHASE_INPUT_KEYS = Object.freeze({
  PLAN_CONTENT: Object.freeze([
    "sourceSnapshotId", "gatewayProfile", "gateway", "repository", "evidenceRepository", "sourceCapture", "strategyCapture",
    "configCapture", "visualGroupsCapture", "promptTemplateVersion", "prohibitedClaims", "regeneration",
    "planningContract", "gatewayExecution",
  ]),
  PLAN_CONTENT_SOURCE_IMAGE: Object.freeze([
    "sourceSnapshotId", "gatewayProfile", "gateway", "repository", "evidenceRepository", "sourceCapture", "strategyCapture",
    "configCapture", "sourceImageAnalysisRun", "sourceImageIntelligenceSummary", "promptTemplateVersion",
    "prohibitedClaims", "regeneration", "planningContract", "gatewayExecution",
  ]),
  MATERIALIZE_SOURCE_ASSET: Object.freeze([
    "parentPlan", "sourceSnapshot", "policy", "repository", "downloader", "storage", "logger",
  ]),
  MATERIALIZE_SOURCE_IMAGE_ANALYSIS: Object.freeze([
    "analysisRun", "sourceAsset", "sourceSnapshot", "execution", "policy", "repository",
    "intelligenceRepository", "downloader", "storage", "logger",
  ]),
  ANALYZE_SOURCE_IMAGE_BATCH: Object.freeze([
    "run", "batch", "profile", "repository", "sourceAssetLoader", "gateway", "gatewayExecution",
  ]),
  CLEAN_SOURCE_IMAGE_OVERLAY: Object.freeze([
    "attempt", "cleanupInput", "original", "profile", "gateway", "repository", "storage",
    "cleanupRecorder", "gatewayExecution",
  ]),
  CHECK_SOURCE_IMAGE_CLEANUP: Object.freeze([
    "attempt", "original", "candidate", "profile", "gateway", "repository", "gatewayExecution",
  ]),
  RECONCILE_SOURCE_IMAGE_ANALYSIS: Object.freeze([
    "run", "sourceCapture", "assessments", "decisions", "acceptedDerivativeBindings",
    "repository", "summaryInputHash",
  ]),
  FINALIZE_MATERIALIZED_PLAN: Object.freeze(["parentPlan", "repository"]),
  FINALIZE_MATERIALIZED_PLAN_SOURCE_IMAGE: Object.freeze([
    "parentPlan", "sourceMaterializationScope", "repository",
  ]),
  GENERATE_IMAGE_SLOT: Object.freeze([
    "plan", "slot", "categoryStyle", "categoryStyleReferences", "sourceAssetLoader", "repository", "gateway", "profile", "imageModel", "ratio",
    "resolution", "size", "quality", "templateVersion", "regeneration", "storage", "logger", "maxAttempts", "gatewayExecution",
  ]),
  GENERATE_IMAGE_SLOT_SOURCE_IMAGE: Object.freeze([
    "plan", "slot", "categoryStyle", "categoryStyleReferences", "sourceAssetLoader", "repository", "gateway", "profile", "imageModel", "ratio",
    "resolution", "size", "quality", "templateVersion", "regeneration", "storage", "logger", "maxAttempts", "gatewayExecution",
    "sourceImageIntelligenceSummary",
  ]),
  GENERATE_RICH_CONTENT: Object.freeze([
    "plan", "profile", "gateway", "repository", "factRegistry", "acceptedAssets", "planHash", "sourceHash",
    "promptTemplateVersion", "maxAttempts", "leaseOwner", "gatewayExecution",
  ]),
  CHECK_IMAGE_GROUP: Object.freeze([
    "plan", "acceptedAssets", "frozenAcceptedSlotKeys", "sourceImageIntelligence", "gatewayProfile", "gateway",
    "repository", "checker", "analysisRun", "gatewayExecution",
  ]),
});
const GATEWAY_EXECUTION_KEYS = Object.freeze([
  "channelId", "connectionId", "connectionVersion", "idleTimeoutMs",
]);
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
const SUCCESS_OUTCOME = Object.freeze({
  PLAN_CONTENT: "PLAN_READY",
  MATERIALIZE_SOURCE_ASSET: "SOURCE_ASSET_ACCEPTED",
  ANALYZE_SOURCE_IMAGE_BATCH: "SOURCE_IMAGE_BATCH_ACCEPTED",
  CLEAN_SOURCE_IMAGE_OVERLAY: "SOURCE_IMAGE_CLEANUP_GENERATED",
  CHECK_SOURCE_IMAGE_CLEANUP: "SOURCE_IMAGE_CLEANUP_ACCEPTED",
  RECONCILE_SOURCE_IMAGE_ANALYSIS: "SOURCE_IMAGE_ANALYSIS_READY",
  FINALIZE_MATERIALIZED_PLAN: "MATERIALIZED_PLAN_READY",
  GENERATE_IMAGE_SLOT: "IMAGE_SLOT_ACCEPTED",
  CHECK_IMAGE_GROUP: "IMAGE_GROUP_ACCEPTED",
  GENERATE_RICH_CONTENT: "CONTENT_READY_FOR_REVIEW",
});
const FALLBACK_FAILURE = Object.freeze({
  PLAN_CONTENT: "AUTO_LISTING_CONTENT_PLAN_FAILED",
  MATERIALIZE_SOURCE_ASSET: "AUTO_LISTING_SOURCE_MATERIALIZATION_FAILED",
  ANALYZE_SOURCE_IMAGE_BATCH: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_FAILED",
  CLEAN_SOURCE_IMAGE_OVERLAY: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_FAILED",
  CHECK_SOURCE_IMAGE_CLEANUP: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_FAILED",
  RECONCILE_SOURCE_IMAGE_ANALYSIS: "AUTO_LISTING_SOURCE_IMAGE_RECONCILIATION_FAILED",
  FINALIZE_MATERIALIZED_PLAN: "AUTO_LISTING_MATERIALIZED_PLAN_FAILED",
  GENERATE_IMAGE_SLOT: "AUTO_LISTING_IMAGE_FAILED",
  CHECK_IMAGE_GROUP: "AUTO_LISTING_IMAGE_GROUP_CHECK_FAILED",
  GENERATE_RICH_CONTENT: "AUTO_LISTING_RICH_CONTENT_FAILED",
});
const CHANNEL_TRANSIENT_CODES = new Set([
  "AI_GATEWAY_NETWORK_FAILED",
  "AI_GATEWAY_RATE_LIMITED",
  "AI_GATEWAY_IDLE_TIMEOUT",
  "AI_GATEWAY_UNEXPECTED_EOF",
  "INVALID_GATEWAY_RESPONSE",
  "RETRYABLE_GATEWAY",
  "GATEWAY_TIMEOUT",
  "AI_GATEWAY_NO_CAPACITY",
]);
const CHANNEL_REVALIDATION_CODES = new Set([
  "AI_GATEWAY_UNAUTHORIZED",
  "AI_GATEWAY_MODEL_NOT_FOUND",
  "AI_GATEWAY_CAPABILITY_INVALID",
  "NON_RETRYABLE_AUTH",
  "AI_GATEWAY_QUOTA_EXHAUSTED",
]);
const RESERVATION_BUSY_CODES = new Set([
  "AUTO_LISTING_CONTENT_PLAN_IN_PROGRESS",
  "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_IN_PROGRESS",
  "AUTO_LISTING_IMAGE_IN_PROGRESS",
  "AUTO_LISTING_IMAGE_GROUP_CHECK_IN_PROGRESS",
  "AUTO_LISTING_RICH_CONTENT_IN_PROGRESS",
]);
const RESERVATION_BUSY_RETRY_MS = 30_000;
const NOT_SENT_CHANNEL_CODES = new Set([
  "AI_GATEWAY_RATE_LIMITED",
  "AI_GATEWAY_QUOTA_EXHAUSTED",
  "AI_GATEWAY_NO_CAPACITY",
  ...CHANNEL_REVALIDATION_CODES,
]);
const DELIVERY_STATES = new Set(["NOT_SENT", "POSSIBLY_SENT"]);
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_FAILURE_CODES = Object.freeze({
  PLAN_CONTENT: new Set([
    "AI_GATEWAY_RATE_LIMITED",
    "AUTO_LISTING_CONTENT_PLANNER_INPUT_INVALID", "AUTO_LISTING_CONTENT_PLAN_GATEWAY_FAILED",
    "AUTO_LISTING_CONTENT_PLAN_INVALID", "AUTO_LISTING_CONTENT_PLAN_REPOSITORY_FAILED",
    "AUTO_LISTING_CONTENT_PLAN_RESERVATION_FAILED", "AUTO_LISTING_CONTENT_PLAN_VERSION_CONFLICT",
    "AUTO_LISTING_REFERENCE_IMAGE_REQUIRED", "AUTO_LISTING_VISUAL_EVIDENCE_INVALID",
  ]),
  MATERIALIZE_SOURCE_ASSET: new Set([
    "AUTO_LISTING_SOURCE_ALREADY_MATERIALIZED", "AUTO_LISTING_SOURCE_ASSET_CLEANUP_PERSIST_FAILED",
    "AUTO_LISTING_SOURCE_ASSET_INVALID", "AUTO_LISTING_SOURCE_ASSET_STORAGE_UNAVAILABLE",
    "AUTO_LISTING_SOURCE_ASSET_STORAGE_UNVERIFIED", "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED",
    "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED", "AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID",
    "AUTO_LISTING_SOURCE_IMAGE_INVALID", "AUTO_LISTING_SOURCE_IMAGE_TOO_LARGE",
    "AUTO_LISTING_SOURCE_MATERIALIZATION_ATTEMPTS_EXHAUSTED",
    "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED",
    "AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID", "AUTO_LISTING_SOURCE_MATERIALIZATION_REPLAY_INVALID",
    "AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED",
    "AUTO_LISTING_SOURCE_MATERIALIZATION_RESERVATION_FAILED",
  ]),
  ANALYZE_SOURCE_IMAGE_BATCH: new Set([
    "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_INPUT_INVALID", "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID",
    "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_REPOSITORY_FAILED",
  ]),
  CLEAN_SOURCE_IMAGE_OVERLAY: new Set([
    "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_GATEWAY_INVALID",
    "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_REPOSITORY_FAILED",
    "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_REPOSITORY_FAILED",
    "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORAGE_UNAVAILABLE",
    "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORAGE_UNVERIFIED",
  ]),
  CHECK_SOURCE_IMAGE_CLEANUP: new Set([
    "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_GATEWAY_INVALID",
    "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_REPOSITORY_FAILED",
    "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_REPOSITORY_FAILED",
    "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORAGE_UNAVAILABLE",
    "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORAGE_UNVERIFIED",
  ]),
  RECONCILE_SOURCE_IMAGE_ANALYSIS: new Set([
    "AUTO_LISTING_SOURCE_IMAGE_RECONCILIATION_INPUT_INVALID",
    "AUTO_LISTING_SOURCE_IMAGE_EVIDENCE_INSUFFICIENT",
    "AUTO_LISTING_SOURCE_IMAGE_REPOSITORY_FAILED",
  ]),
  FINALIZE_MATERIALIZED_PLAN: new Set([
    "AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID", "AUTO_LISTING_MATERIALIZED_PLAN_INPUT_INVALID",
    "AUTO_LISTING_MATERIALIZED_PLAN_REPOSITORY_CONFLICT", "AUTO_LISTING_MATERIALIZED_PLAN_REPOSITORY_FAILED",
  ]),
  GENERATE_IMAGE_SLOT: new Set([
    "AUTO_LISTING_ASSET_CLEANUP_PERSIST_FAILED", "AUTO_LISTING_ASSET_DECODE_FAILED",
    "AUTO_LISTING_ASSET_DIMENSIONS_INVALID", "AUTO_LISTING_ASSET_INVALID",
    "AUTO_LISTING_ASSET_REPOSITORY_FAILED", "AUTO_LISTING_ASSET_SCOPE_INVALID",
    "AUTO_LISTING_ASSET_STORAGE_UNAVAILABLE", "AUTO_LISTING_ASSET_STORAGE_UNVERIFIED",
    "AUTO_LISTING_ASSET_TOO_LARGE", "AUTO_LISTING_IMAGE_ATTEMPTS_EXHAUSTED",
    "CHECKER_UNAVAILABLE", "CHECKER_RESPONSE_INVALID", "CHECKER_EVIDENCE_INVALID", "RETRYABLE_GATEWAY",
    "PRODUCT_IDENTITY_MISMATCH", "UNVERIFIED_CLAIM", "LANGUAGE_MISMATCH",
    "PROHIBITED_CONTENT", "IMAGE_QUALITY_FAILED", "CATEGORY_STYLE_MISMATCH",
    "BLUR", "CROP", "OBSTRUCTION", "TEXT_DISTORTION", "DIMENSION_ANNOTATION_MISSING",
    "ROLE_MISMATCH", "DETAIL_NOT_CLOSEUP", "SUBJECT_NOT_DOMINANT",
    "LABEL_OVERLAP", "LABEL_READABILITY_LOW",
    "AUTO_LISTING_IMAGE_EXISTING_CORRUPT", "AUTO_LISTING_IMAGE_GATEWAY_INVALID",
    "AUTO_LISTING_IMAGE_INPUT_INVALID", "AUTO_LISTING_IMAGE_REPOSITORY_FAILED",
    "AUTO_LISTING_IMAGE_RESERVATION_FAILED", "AUTO_LISTING_IMAGE_VERSION_CONFLICT",
    "AUTO_LISTING_SOURCE_ASSET_INVALID", "AUTO_LISTING_SOURCE_ASSET_NOT_MATERIALIZED",
    "AUTO_LISTING_SOURCE_ASSET_UNAVAILABLE",
  ]),
  CHECK_IMAGE_GROUP: new Set([
    "AUTO_LISTING_IMAGE_GROUP_CHECK_UNAVAILABLE", "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID",
    "AUTO_LISTING_IMAGE_GROUP_CHECK_FAILED", "AI_GATEWAY_RATE_LIMITED",
  ]),
  GENERATE_RICH_CONTENT: new Set([
    "AUTO_LISTING_RICH_CONTENT_ATTEMPTS_EXHAUSTED", "AUTO_LISTING_RICH_CONTENT_COMPLETE_FAILED",
    "AUTO_LISTING_RICH_CONTENT_EXISTING_CORRUPT", "AUTO_LISTING_RICH_CONTENT_GATEWAY_EVIDENCE_INVALID",
    "AUTO_LISTING_RICH_CONTENT_GATEWAY_FAILED", "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID",
    "AUTO_LISTING_RICH_CONTENT_IN_PROGRESS", "AUTO_LISTING_RICH_CONTENT_OUTPUT_INVALID",
    "AUTO_LISTING_RICH_CONTENT_POLICY_REJECTED", "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED",
  ]),
});

function invalid() {
  const error = new Error("自动上架 AI 阶段编排输入无效");
  error.code = "AUTO_LISTING_AI_ORCHESTRATOR_INPUT_INVALID";
  error.retryable = false;
  return error;
}

function imageGroupResultInvalid() {
  const error = new Error("自动上架整组图片检查结果无效");
  error.code = "AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID";
  error.retryable = false;
  return error;
}

function plainObject(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  } catch {
    return false;
  }
}

function exactKeys(value, expected) {
  try {
    if (!plainObject(value)) return false;
    const actual = Reflect.ownKeys(value);
    return actual.length === expected.length
      && actual.every((key) => typeof key === "string" && expected.includes(key));
  } catch {
    return false;
  }
}

function exactDataKeys(value, expected) {
  try {
    if (!exactKeys(value, expected)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return expected.every((key) => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key], "value"));
  } catch {
    return false;
  }
}

function validVersion(value) {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function safeId(value) {
  return isSafeAutoListingAiIdentifier(value);
}

function outcome(message, disposition, value, failureCode = null, retryable = false, metadata = {}) {
  return Object.freeze({
    contractVersion: "V1",
    disposition,
    phase: message.phase,
    outcome: value,
    retryable,
    failureCode,
    correlationId: message.correlationId,
    failureScope: metadata.failureScope ?? null,
    deliveryState: metadata.deliveryState ?? null,
    retryAfterMs: metadata.retryAfterMs ?? null,
  });
}

function ownErrorValue(error, key) {
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, key) : null;
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function channelFailure(message, error) {
  const code = ownErrorValue(error, "code");
  const adapterModelNotFound = code === "AI_GATEWAY_MODEL_UNAVAILABLE" || (code === "NON_RETRYABLE_GATEWAY" && ownErrorValue(error, "status") === 404);
  const failureScope = CHANNEL_TRANSIENT_CODES.has(code) ? "CHANNEL_TRANSIENT"
    : CHANNEL_REVALIDATION_CODES.has(code) || adapterModelNotFound ? "CHANNEL_REVALIDATION" : null;
  if (failureScope === null) return null;
  const explicitDelivery = ownErrorValue(error, "deliveryState");
  const deliveryState = DELIVERY_STATES.has(explicitDelivery)
    ? explicitDelivery : NOT_SENT_CHANNEL_CODES.has(code) || adapterModelNotFound ? "NOT_SENT" : "POSSIBLY_SENT";
  const explicitRetryAfter = ownErrorValue(error, "retryAfterMs");
  const retryAfterMs = Number.isInteger(explicitRetryAfter)
    && explicitRetryAfter >= 0 && explicitRetryAfter <= MAX_RETRY_AFTER_MS
    ? explicitRetryAfter : null;
  return outcome(message, "RETRY", "FAILED", code, true, {
    failureScope,
    deliveryState,
    retryAfterMs,
  });
}

function stableFailureCode(error, phase) {
  return typeof error?.code === "string" && SAFE_FAILURE_CODES[phase]?.has(error.code)
    ? error.code : FALLBACK_FAILURE[phase];
}

function assertServices(value) {
  if (!exactDataKeys(value, SERVICE_KEYS) || SERVICE_KEYS.some((key) => typeof value[key] !== "function")) throw invalid();
}

function scopeMatchesPlan(plan, context) {
  return plainObject(plan) && safeId(plan.id)
    && plan.sourceAccountId === context.accountId
    && plan.jobId === context.jobId
    && plan.itemId === context.itemId;
}

function isFinalMaterializedPlan(plan, context) {
  if (!scopeMatchesPlan(plan, context)
    || plan.id !== context.activeContentPlanId
    || !safeId(plan.parentPlanId)
    || plan.parentPlanId === plan.id
    || plan.derivationKind !== "SOURCE_MATERIALIZATION"
    || !HASH.test(plan.materializationSetHash || "")
    || !plainObject(plan.plan) || !Array.isArray(plan.plan.slots)
    || !plainObject(plan.visualGroups) || !Array.isArray(plan.visualGroups.groups)
    || plan.visualGroups.groups.length < 1) return false;
  const references = plan.visualGroups.groups.flatMap((group) => Array.isArray(group?.referenceImages)
    ? group.referenceImages : [null]);
  return references.length > 0 && references.every((reference) => plainObject(reference)
    && safeId(reference.assetId)
    && reference.evidenceKind === "CONTENT_HASH"
    && HASH.test(reference.contentHash || "")
    && reference.sourceRef === null);
}

function assertContext(rawContext, message) {
  if (!exactKeys(rawContext, CONTEXT_KEYS)) throw invalid();
  let context;
  try {
    context = {
      accountId: rawContext.accountId,
      jobId: rawContext.jobId,
      itemId: rawContext.itemId,
      status: rawContext.status,
      statusVersion: rawContext.statusVersion,
      activeContentPlanId: rawContext.activeContentPlanId,
    };
  } catch {
    throw invalid();
  }
  if (![context.accountId, context.jobId, context.itemId].every(safeId)
    || context.accountId !== message.accountId || context.itemId !== message.itemId
    || typeof context.status !== "string" || !context.status
    || !validVersion(context.statusVersion)
    || !(context.activeContentPlanId === null || safeId(context.activeContentPlanId))) throw invalid();
  return context;
}

function assertPhaseInput(rawContext, phase) {
  let phaseInput;
  try { phaseInput = rawContext.phaseInput; } catch { throw invalid(); }
  const keys = phase === "MATERIALIZE_SOURCE_ASSET" && plainObject(phaseInput)
    && Object.hasOwn(phaseInput, "analysisRun")
    ? PHASE_INPUT_KEYS.MATERIALIZE_SOURCE_IMAGE_ANALYSIS
    : phase === "PLAN_CONTENT" && phaseInput?.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
      ? PHASE_INPUT_KEYS.PLAN_CONTENT_SOURCE_IMAGE
      : phase === "FINALIZE_MATERIALIZED_PLAN"
        && phaseInput?.parentPlan?.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
        ? PHASE_INPUT_KEYS.FINALIZE_MATERIALIZED_PLAN_SOURCE_IMAGE
      : phase === "GENERATE_IMAGE_SLOT"
        && phaseInput?.plan?.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
        ? PHASE_INPUT_KEYS.GENERATE_IMAGE_SLOT_SOURCE_IMAGE : PHASE_INPUT_KEYS[phase];
  if (!exactDataKeys(phaseInput, keys)) throw invalid();
  return phaseInput;
}

function validGatewayExecution(value) {
  return value === null || (exactDataKeys(value, GATEWAY_EXECUTION_KEYS)
    && safeId(value.channelId) && safeId(value.connectionId)
    && validVersion(value.connectionVersion) && value.idleTimeoutMs === 300_000);
}

function validateParentPhaseInput(phaseInput, context) {
  return scopeMatchesPlan(phaseInput.parentPlan, context)
    && phaseInput.parentPlan.id === context.activeContentPlanId;
}

function validateImagePhaseInput(phaseInput, context, message) {
  const selectedSlot = phaseInput.slot;
  const sourceImagePlan = phaseInput.plan?.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1";
  return isFinalMaterializedPlan(phaseInput.plan, context)
    && (!sourceImagePlan || (plainObject(phaseInput.sourceImageIntelligenceSummary)
      && HASH.test(phaseInput.sourceImageIntelligenceSummary.summaryHash || "")
      && phaseInput.plan.sourceImageIntelligenceHash === phaseInput.sourceImageIntelligenceSummary.summaryHash))
    && plainObject(selectedSlot)
    && selectedSlot.slotKey === message.slotKey
    && safeId(selectedSlot.visualGroupKey)
    && phaseInput.plan.plan.slots.filter((candidate) => candidate?.slotKey === message.slotKey).length === 1
    && phaseInput.plan.plan.slots.some((candidate) => candidate === selectedSlot
      || (candidate?.slotKey === selectedSlot.slotKey
        && candidate?.visualGroupKey === selectedSlot.visualGroupKey
        && candidate?.role === selectedSlot.role));
}

function validateAcceptedAssets(phaseInput, context) {
  const assets = phaseInput.acceptedAssets;
  const slots = new Map(phaseInput.plan.plan.slots.map((entry) => [entry?.slotKey, entry]));
  if (!Array.isArray(assets) || assets.length < 6
    || slots.size !== phaseInput.plan.plan.slots.length) return false;
  const assetIds = new Set();
  const slotKeys = new Set();
  const groups = new Map();
  for (const asset of assets) {
    const planned = slots.get(asset?.slotKey);
    if (!plainObject(asset) || !safeId(asset.id) || asset.status !== "ACCEPTED"
      || asset.accountId !== context.accountId || asset.jobId !== context.jobId || asset.itemId !== context.itemId
      || asset.planId !== context.activeContentPlanId || !planned
      || asset.visualGroupKey !== planned.visualGroupKey || asset.role !== planned.role
      || assetIds.has(asset.id) || slotKeys.has(asset.slotKey)) return false;
    assetIds.add(asset.id);
    slotKeys.add(asset.slotKey);
    const group = groups.get(asset.visualGroupKey) || [];
    group.push(asset);
    groups.set(asset.visualGroupKey, group);
  }
  return groups.size === phaseInput.plan.visualGroups.groups.length
    && [...groups.values()].every((group) => group.length >= 6 && group.length <= 13
      && group.filter((asset) => asset.role === "MAIN").length === 1);
}

function validateTargetGroupAcceptedAssets(phaseInput, context, visualGroupKey) {
  const assets = phaseInput.acceptedAssets;
  const slots = new Map(phaseInput.plan.plan.slots.map((entry) => [entry?.slotKey, entry]));
  if (!Array.isArray(assets) || assets.length < 6 || assets.length > 13
    || slots.size !== phaseInput.plan.plan.slots.length) return false;
  const assetIds = new Set();
  const slotKeys = new Set();
  for (const asset of assets) {
    const planned = slots.get(asset?.slotKey);
    if (!plainObject(asset) || !safeId(asset.id) || asset.status !== "ACCEPTED"
      || asset.accountId !== context.accountId || asset.jobId !== context.jobId || asset.itemId !== context.itemId
      || asset.planId !== context.activeContentPlanId || !planned
      || asset.visualGroupKey !== visualGroupKey || planned.visualGroupKey !== visualGroupKey
      || asset.role !== planned.role || assetIds.has(asset.id) || slotKeys.has(asset.slotKey)) return false;
    assetIds.add(asset.id);
    slotKeys.add(asset.slotKey);
  }
  return assets.filter((asset) => asset.role === "MAIN").length === 1;
}

function validateRichPhaseInput(phaseInput, context) {
  return isFinalMaterializedPlan(phaseInput.plan, context)
    && phaseInput.planHash === phaseInput.plan.planHash
    && phaseInput.sourceHash === phaseInput.plan.sourceHash
    && validateAcceptedAssets(phaseInput, context);
}

function validateAnalysisRun(run, context, message, { allowEarlierStatusVersion = false } = {}) {
  return plainObject(run) && safeId(run.id) && run.id === (message.analysisRunId ?? run.id)
    && run.accountId === context.accountId && run.jobId === context.jobId && run.itemId === context.itemId
    && validVersion(run.expectedStatusVersion)
    && (allowEarlierStatusVersion
      ? run.expectedStatusVersion <= context.statusVersion
      : run.expectedStatusVersion === context.statusVersion);
}

function validateAnalysisMaterializeInput(phaseInput, context, message) {
  return validateAnalysisRun(phaseInput.analysisRun, context, message)
    && plainObject(phaseInput.sourceAsset) && phaseInput.sourceAsset.sourceAssetId === message.sourceAssetId;
}

function validateAnalysisBatchInput(phaseInput, context, message) {
  return validateAnalysisRun(phaseInput.run, context, message)
    && plainObject(phaseInput.batch) && phaseInput.batch.analysisBatchId === message.analysisBatchId;
}

function validateCleanupAttemptInput(phaseInput, context, message, expectedStatuses) {
  const attempt = phaseInput.attempt;
  return plainObject(attempt)
    && attempt.accountId === context.accountId && attempt.jobId === context.jobId
    && attempt.itemId === context.itemId && attempt.analysisRunId === message.analysisRunId
    && attempt.derivativeAttemptId === message.derivativeAttemptId
    && safeId(attempt.sourceAssetId) && attempt.expectedStatusVersion === context.statusVersion
    && expectedStatuses.includes(attempt.status);
}

function validateGroupInput(phaseInput, context, message) {
  const acceptedSlotKeys = new Set(phaseInput.acceptedAssets?.map((asset) => asset?.slotKey));
  return isFinalMaterializedPlan(phaseInput.plan, context)
    && phaseInput.plan.visualGroups.groups.some((group) => group?.visualGroupKey === message.visualGroupKey)
    && validateTargetGroupAcceptedAssets(phaseInput, context, message.visualGroupKey)
    && Array.isArray(phaseInput.frozenAcceptedSlotKeys)
    && new Set(phaseInput.frozenAcceptedSlotKeys).size === phaseInput.frozenAcceptedSlotKeys.length
    && phaseInput.frozenAcceptedSlotKeys.every((slotKey) =>
      safeId(slotKey) && acceptedSlotKeys.has(slotKey))
    && validateAnalysisRun(phaseInput.analysisRun, context, message, { allowEarlierStatusVersion: true })
    && plainObject(phaseInput.sourceImageIntelligence)
    && HASH.test(phaseInput.sourceImageIntelligence.summaryHash || "")
    && (phaseInput.plan.sourceImageIntelligenceHash === undefined
      || phaseInput.plan.sourceImageIntelligenceHash === phaseInput.sourceImageIntelligence.summaryHash)
    && plainObject(phaseInput.gatewayProfile) && plainObject(phaseInput.gateway)
    && plainObject(phaseInput.repository)
    && typeof phaseInput.checker === "function";
}

function assertSuccessfulResult(result, phase, context, message, phaseInput) {
  if (!plainObject(result)) throw invalid();
  if (phase === "PLAN_CONTENT") {
    if (!safeId(result.id) || result.accountId !== context.accountId
      || result.jobId !== context.jobId || result.itemId !== context.itemId
      || (context.activeContentPlanId !== null && result.id !== context.activeContentPlanId)) throw invalid();
    return;
  }
  if (phase === "MATERIALIZE_SOURCE_ASSET") {
    if (Object.hasOwn(phaseInput, "analysisRun")) {
      if (!["ACCEPTED", "TERMINAL"].includes(result.status)
        || result.sourceAssetId !== message.sourceAssetId) throw invalid();
      return;
    }
    if (result.status !== "ACCEPTED" || result.accountId !== context.accountId || result.jobId !== context.jobId
      || result.itemId !== context.itemId || result.parentPlanId !== context.activeContentPlanId
      || result.sourceAssetId !== message.sourceAssetId) throw invalid();
    return;
  }
  if (phase === "ANALYZE_SOURCE_IMAGE_BATCH") {
    if (!["ACCEPTED", "EXISTING_ACCEPTED"].includes(result.status)
      || result.analysisBatchId !== message.analysisBatchId) throw invalid();
    return;
  }
  if (phase === "CLEAN_SOURCE_IMAGE_OVERLAY") {
    if (!["GENERATED", "ACCEPTED", "REJECTED"].includes(result.status)
      || result.derivativeAttemptId !== message.derivativeAttemptId
      || result.sourceAssetId !== phaseInput.attempt.sourceAssetId) throw invalid();
    return;
  }
  if (phase === "CHECK_SOURCE_IMAGE_CLEANUP") {
    if (!["ACCEPTED", "REJECTED"].includes(result.status)
      || result.derivativeAttemptId !== message.derivativeAttemptId
      || result.sourceAssetId !== phaseInput.attempt.sourceAssetId) throw invalid();
    return;
  }
  if (phase === "RECONCILE_SOURCE_IMAGE_ANALYSIS") {
    if (!["ACCEPTED", "CONFIRMATION_REQUIRED"].includes(result.status)
      || result.id !== message.analysisRunId || result.accountId !== context.accountId
      || result.jobId !== context.jobId || result.itemId !== context.itemId) throw invalid();
    return;
  }
  if (phase === "FINALIZE_MATERIALIZED_PLAN") {
    const derivedContext = { ...context, activeContentPlanId: result.id };
    if (!isFinalMaterializedPlan(result, derivedContext)
      || result.parentPlanId !== phaseInput.parentPlan.id) throw invalid();
    return;
  }
  if (phase === "GENERATE_IMAGE_SLOT") {
    if (result.status !== "ACCEPTED" || result.accountId !== context.accountId || result.jobId !== context.jobId
      || result.itemId !== context.itemId || result.planId !== context.activeContentPlanId
      || result.slotKey !== message.slotKey || result.role !== phaseInput.slot.role) throw invalid();
    return;
  }
  if (phase === "CHECK_IMAGE_GROUP") {
    if (!["ACCEPTED", "RETRY_QUEUED"].includes(result.status)
      || result.accountId !== context.accountId || result.jobId !== context.jobId
      || result.itemId !== context.itemId || result.planId !== context.activeContentPlanId
      || result.visualGroupKey !== message.visualGroupKey) throw imageGroupResultInvalid();
    if (result.status === "RETRY_QUEUED") {
      const targetSlotKeys = new Set(phaseInput.acceptedAssets
        .filter((asset) => asset.visualGroupKey === message.visualGroupKey)
        .map((asset) => asset.slotKey));
      if (!Array.isArray(result.retrySlotKeys) || result.retrySlotKeys.length < 1
        || new Set(result.retrySlotKeys).size !== result.retrySlotKeys.length
        || result.retrySlotKeys.some((slotKey) => !targetSlotKeys.has(slotKey))) {
        throw imageGroupResultInvalid();
      }
    }
    return;
  }
  if (phase === "GENERATE_RICH_CONTENT" && Array.isArray(result.results)) {
    const groupKeys = new Set(phaseInput.acceptedAssets.map((asset) => asset.visualGroupKey));
    if (result.status !== "ACCEPTED" || result.accountId !== context.accountId || result.jobId !== context.jobId
      || result.itemId !== context.itemId || result.planId !== context.activeContentPlanId
      || result.results.length !== groupKeys.size
      || result.results.some((entry) => !plainObject(entry) || !groupKeys.has(entry.visualGroupKey)
        || entry.status !== "ACCEPTED" || entry.accountId !== context.accountId || entry.jobId !== context.jobId
        || entry.itemId !== context.itemId || entry.planId !== context.activeContentPlanId)
      || new Set(result.results.map((entry) => entry.visualGroupKey)).size !== groupKeys.size) throw invalid();
    return;
  }
  if (result.status !== "ACCEPTED" || result.accountId !== context.accountId || result.jobId !== context.jobId
    || result.itemId !== context.itemId || result.planId !== context.activeContentPlanId) throw invalid();
}

function serviceFailure(message, error, { allowReservationBusy = false } = {}) {
  if (allowReservationBusy && RESERVATION_BUSY_CODES.has(error?.code)) {
    return outcome(message, "RETRY", "IN_PROGRESS", error.code, true, {
      failureScope: "RESERVATION_BUSY",
      retryAfterMs: RESERVATION_BUSY_RETRY_MS,
    });
  }
  const channel = channelFailure(message, error);
  if (channel) return channel;
  if (message.phase === "GENERATE_IMAGE_SLOT" && error?.retryable !== true) {
    if (error?.itemOutcome === "BLOCKED") {
      return outcome(message, "FAIL", "FAILED", "AUTO_LISTING_MAIN_IMAGE_REQUIRED", true, { failureScope: "BUSINESS" });
    }
    if (error?.itemOutcome === "CONTINUE_WITHOUT_SLOT") {
      return outcome(message, "ACK", "IMAGE_SLOT_SKIPPED", "AUTO_LISTING_IMAGE_POLICY_REJECTED", false);
    }
    if (error?.itemOutcome === "ITEM_INCOMPLETE") {
      return outcome(message, "FAIL", "FAILED", "AUTO_LISTING_MINIMUM_IMAGE_COUNT_NOT_MET", true, { failureScope: "BUSINESS" });
    }
  }
  const retryable = error?.retryable === true;
  return outcome(message, retryable ? "RETRY" : "FAIL", "FAILED", stableFailureCode(error, message.phase), retryable, {
    failureScope: "BUSINESS",
  });
}

function assertLeaseActive(assertActive) {
  try {
    assertActive();
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_EXECUTION_LEASE_LOST") throw error;
    throw invalid();
  }
}

async function invokePhase(message, context, phaseInput, services, assertActive) {
  assertLeaseActive(assertActive);
  if (message.phase === "PLAN_CONTENT") return services.planContent({
    ...phaseInput,
    accountId: context.accountId,
    jobId: context.jobId,
    itemId: context.itemId,
    expectedStatusVersion: message.expectedStatusVersion,
    correlationId: message.correlationId,
    assertLeaseActive: assertActive,
  });
  if (message.phase === "MATERIALIZE_SOURCE_ASSET" && Object.hasOwn(phaseInput, "analysisRun")) {
    return services.materializeSourceImageForAnalysis({
      ...phaseInput,
      scope: {
        accountId: context.accountId,
        jobId: context.jobId,
        itemId: context.itemId,
        expectedStatusVersion: message.expectedStatusVersion,
      },
    });
  }
  if (message.phase === "MATERIALIZE_SOURCE_ASSET") return services.materializeSourceAsset({
    ...phaseInput,
    scope: {
      accountId: context.accountId,
      jobId: context.jobId,
      itemId: context.itemId,
      parentPlanId: context.activeContentPlanId,
      sourceAssetId: message.sourceAssetId,
      expectedStatusVersion: message.expectedStatusVersion,
    },
  });
  if (message.phase === "ANALYZE_SOURCE_IMAGE_BATCH") return services.analyzeSourceImageBatch({
    ...phaseInput,
    scope: {
      accountId: context.accountId,
      jobId: context.jobId,
      itemId: context.itemId,
      expectedStatusVersion: message.expectedStatusVersion,
    },
    assertLeaseActive: assertActive,
  });
  if (message.phase === "CLEAN_SOURCE_IMAGE_OVERLAY") return services.cleanSourceImageOverlay({
    ...phaseInput,
    scope: {
      accountId: context.accountId,
      jobId: context.jobId,
      itemId: context.itemId,
      analysisRunId: message.analysisRunId,
      sourceAssetId: phaseInput.attempt.sourceAssetId,
      expectedStatusVersion: message.expectedStatusVersion,
      derivativeAttemptId: message.derivativeAttemptId,
      inputHash: phaseInput.attempt.inputHash,
      attemptNo: phaseInput.attempt.attemptNo,
    },
    assertLeaseActive: assertActive,
  });
  if (message.phase === "CHECK_SOURCE_IMAGE_CLEANUP") return services.checkSourceImageCleanup({
    ...phaseInput,
    scope: {
      accountId: context.accountId,
      jobId: context.jobId,
      itemId: context.itemId,
      analysisRunId: message.analysisRunId,
      sourceAssetId: phaseInput.attempt.sourceAssetId,
      expectedStatusVersion: message.expectedStatusVersion,
      derivativeAttemptId: message.derivativeAttemptId,
    },
    assertLeaseActive: assertActive,
  });
  if (message.phase === "RECONCILE_SOURCE_IMAGE_ANALYSIS") return services.reconcileSourceImageAnalysis({
    ...phaseInput,
    scope: {
      accountId: context.accountId,
      jobId: context.jobId,
      itemId: context.itemId,
      expectedStatusVersion: message.expectedStatusVersion,
    },
  });
  if (message.phase === "FINALIZE_MATERIALIZED_PLAN") return services.finalizeMaterializedPlan({
    ...phaseInput,
    scope: {
      accountId: context.accountId,
      jobId: context.jobId,
      itemId: context.itemId,
      parentPlanId: context.activeContentPlanId,
      expectedStatusVersion: message.expectedStatusVersion,
    },
  });
  if (message.phase === "GENERATE_IMAGE_SLOT") return services.generateImageSlot({
    ...phaseInput,
    scope: {
      accountId: context.accountId,
      jobId: context.jobId,
      itemId: context.itemId,
      planId: context.activeContentPlanId,
      visualGroupKey: phaseInput.slot.visualGroupKey,
      slotKey: message.slotKey,
      expectedStatusVersion: message.expectedStatusVersion,
    },
    correlationId: message.correlationId,
    assertLeaseActive: assertActive,
  });
  if (message.phase === "CHECK_IMAGE_GROUP") return services.checkImageGroup({
    ...phaseInput,
    scope: {
      accountId: context.accountId,
      jobId: context.jobId,
      itemId: context.itemId,
      planId: context.activeContentPlanId,
      visualGroupKey: message.visualGroupKey,
      expectedStatusVersion: message.expectedStatusVersion,
    },
    correlationId: message.correlationId,
    assertLeaseActive: assertActive,
  });
  const byGroup = new Map();
  for (const asset of phaseInput.acceptedAssets) {
    const group = byGroup.get(asset.visualGroupKey) || [];
    group.push(asset);
    byGroup.set(asset.visualGroupKey, group);
  }
  const results = [];
  for (const visualGroupKey of [...byGroup.keys()].sort()) {
    assertLeaseActive(assertActive);
    const result = await services.generateRichContent({
      ...phaseInput,
      acceptedAssets: byGroup.get(visualGroupKey),
      visualGroupKey,
      accountId: context.accountId,
      jobId: context.jobId,
      itemId: context.itemId,
      planId: context.activeContentPlanId,
      expectedStatusVersion: message.expectedStatusVersion,
      correlationId: message.correlationId,
      assertLeaseActive: assertActive,
    });
    assertLeaseActive(assertActive);
    results.push({ ...result, visualGroupKey });
  }
  return {
    status: "ACCEPTED", accountId: context.accountId, jobId: context.jobId, itemId: context.itemId,
    planId: context.activeContentPlanId, results,
  };
}

/**
 * Pure phase dispatcher. The worker owns context loading, transitions, events,
 * queue semantics and runtime composition. This function performs no lookups,
 * state writes, logging or side effects beyond one injected phase service.
 */
export async function orchestrateAutoListingAiPhase(input = {}, dependencies = {}) {
  const leased = exactDataKeys(input, LEASED_INPUT_KEYS) && typeof input.assertLeaseActive === "function";
  if (!exactKeys(input, INPUT_KEYS) && !leased) throw invalid();
  let message;
  try { message = normalizeAutoListingAiMessage(input.message); } catch { throw invalid(); }
  const context = assertContext(input.context, message);

  if (context.status === "CANCELLED") {
    return outcome(message, "ACK", "CANCELLED", "AUTO_LISTING_AI_ITEM_CANCELLED", false);
  }
  if (context.statusVersion !== message.expectedStatusVersion
    || context.status !== PHASE_STATUS[message.phase]) {
    return outcome(message, "ACK", "STALE", "AUTO_LISTING_AI_STATUS_STALE", false);
  }

  const phaseInput = assertPhaseInput(input.context, message.phase);
  if (["PLAN_CONTENT", "ANALYZE_SOURCE_IMAGE_BATCH", "CLEAN_SOURCE_IMAGE_OVERLAY",
    "CHECK_SOURCE_IMAGE_CLEANUP", "GENERATE_IMAGE_SLOT", "CHECK_IMAGE_GROUP",
    "GENERATE_RICH_CONTENT"].includes(message.phase)
    && !validGatewayExecution(phaseInput.gatewayExecution)) throw invalid();
  assertServices(dependencies);

  if (message.phase === "MATERIALIZE_SOURCE_ASSET" && Object.hasOwn(phaseInput, "analysisRun")) {
    if (!validateAnalysisMaterializeInput(phaseInput, context, message)) throw invalid();
  } else if (message.phase === "MATERIALIZE_SOURCE_ASSET" || message.phase === "FINALIZE_MATERIALIZED_PLAN") {
    if (isFinalMaterializedPlan(phaseInput.parentPlan, context)) {
      return message.phase === "FINALIZE_MATERIALIZED_PLAN"
        ? outcome(message, "ACK", "MATERIALIZED_PLAN_READY", null, false)
        : outcome(message, "ACK", "STALE", "AUTO_LISTING_AI_PHASE_ALREADY_COMPLETED", false);
    }
    if (!validateParentPhaseInput(phaseInput, context)) throw invalid();
  } else if (message.phase === "ANALYZE_SOURCE_IMAGE_BATCH") {
    if (!validateAnalysisBatchInput(phaseInput, context, message)) throw invalid();
  } else if (message.phase === "CLEAN_SOURCE_IMAGE_OVERLAY") {
    if (!validateCleanupAttemptInput(phaseInput, context, message,
      ["RESERVED", "GENERATED", "ACCEPTED", "REJECTED"])) throw invalid();
  } else if (message.phase === "CHECK_SOURCE_IMAGE_CLEANUP") {
    if (!validateCleanupAttemptInput(phaseInput, context, message, ["GENERATED"])) throw invalid();
  } else if (message.phase === "RECONCILE_SOURCE_IMAGE_ANALYSIS") {
    if (!validateAnalysisRun(phaseInput.run, context, message)) throw invalid();
  } else if (message.phase === "GENERATE_IMAGE_SLOT") {
    if (!validateImagePhaseInput(phaseInput, context, message)) throw invalid();
  } else if (message.phase === "CHECK_IMAGE_GROUP") {
    if (!validateGroupInput(phaseInput, context, message)) throw invalid();
  } else if (message.phase === "GENERATE_RICH_CONTENT") {
    if (!validateRichPhaseInput(phaseInput, context)) throw invalid();
  }

  try {
    const result = await invokePhase(message, context, phaseInput, dependencies,
      leased ? input.assertLeaseActive : () => {});
    if (message.phase === "MATERIALIZE_SOURCE_ASSET" && result?.status === "SKIPPED") {
      if (result.reasonCode === "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE") {
        return outcome(message, "ACK", "STALE", result.reasonCode, false);
      }
      if (result.reasonCode === "AUTO_LISTING_SOURCE_MATERIALIZATION_CANCELLED") {
        return outcome(message, "ACK", "CANCELLED", result.reasonCode, false);
      }
      if (result.reasonCode === "AUTO_LISTING_SOURCE_MATERIALIZATION_IN_PROGRESS") {
        return outcome(message, "RETRY", "IN_PROGRESS", result.reasonCode, true, { failureScope: "BUSINESS" });
      }
      throw invalid();
    }
    assertSuccessfulResult(result, message.phase, context, message, phaseInput);
    const successfulOutcome = message.phase === "MATERIALIZE_SOURCE_ASSET"
      && Object.hasOwn(phaseInput, "analysisRun") ? "SOURCE_ASSET_TERMINAL"
      : message.phase === "CHECK_IMAGE_GROUP" && result.status === "RETRY_QUEUED"
        ? "IMAGE_GROUP_RETRY_QUEUED"
        : message.phase === "CHECK_SOURCE_IMAGE_CLEANUP" && result.status === "REJECTED"
          ? "SOURCE_IMAGE_CLEANUP_REJECTED" : SUCCESS_OUTCOME[message.phase];
    return outcome(message, "ACK", successfulOutcome, null, false);
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_EXECUTION_LEASE_LOST") throw error;
    return serviceFailure(message, error, { allowReservationBusy: leased });
  }
}

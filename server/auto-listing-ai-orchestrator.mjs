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
  "planContent", "materializeSourceAsset", "finalizeMaterializedPlan", "generateImageSlot", "generateRichContent",
]);
const PHASE_INPUT_KEYS = Object.freeze({
  PLAN_CONTENT: Object.freeze([
    "sourceSnapshotId", "gatewayProfile", "gateway", "repository", "evidenceRepository", "sourceCapture", "strategyCapture",
    "configCapture", "visualGroupsCapture", "promptTemplateVersion", "prohibitedClaims", "regeneration",
    "planningContract", "gatewayExecution",
  ]),
  MATERIALIZE_SOURCE_ASSET: Object.freeze([
    "parentPlan", "sourceSnapshot", "policy", "repository", "downloader", "storage", "logger",
  ]),
  FINALIZE_MATERIALIZED_PLAN: Object.freeze(["parentPlan", "repository"]),
  GENERATE_IMAGE_SLOT: Object.freeze([
    "plan", "slot", "categoryStyle", "categoryStyleReferences", "sourceAssetLoader", "repository", "gateway", "profile", "imageModel", "ratio",
    "resolution", "size", "quality", "templateVersion", "regeneration", "storage", "logger", "maxAttempts", "gatewayExecution",
  ]),
  GENERATE_RICH_CONTENT: Object.freeze([
    "plan", "profile", "gateway", "repository", "factRegistry", "acceptedAssets", "planHash", "sourceHash",
    "promptTemplateVersion", "maxAttempts", "leaseOwner", "gatewayExecution",
  ]),
});
const GATEWAY_EXECUTION_KEYS = Object.freeze([
  "channelId", "connectionId", "connectionVersion", "idleTimeoutMs",
]);
const PHASE_STATUS = Object.freeze({
  PLAN_CONTENT: "PLANNING",
  MATERIALIZE_SOURCE_ASSET: "PLANNING",
  FINALIZE_MATERIALIZED_PLAN: "PLANNING",
  GENERATE_IMAGE_SLOT: "GENERATING",
  GENERATE_RICH_CONTENT: "GENERATING",
});
const SUCCESS_OUTCOME = Object.freeze({
  PLAN_CONTENT: "PLAN_READY",
  MATERIALIZE_SOURCE_ASSET: "SOURCE_ASSET_ACCEPTED",
  FINALIZE_MATERIALIZED_PLAN: "MATERIALIZED_PLAN_READY",
  GENERATE_IMAGE_SLOT: "IMAGE_SLOT_ACCEPTED",
  GENERATE_RICH_CONTENT: "CONTENT_READY_FOR_REVIEW",
});
const FALLBACK_FAILURE = Object.freeze({
  PLAN_CONTENT: "AUTO_LISTING_CONTENT_PLAN_FAILED",
  MATERIALIZE_SOURCE_ASSET: "AUTO_LISTING_SOURCE_MATERIALIZATION_FAILED",
  FINALIZE_MATERIALIZED_PLAN: "AUTO_LISTING_MATERIALIZED_PLAN_FAILED",
  GENERATE_IMAGE_SLOT: "AUTO_LISTING_IMAGE_FAILED",
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
]);
const CHANNEL_REVALIDATION_CODES = new Set([
  "AI_GATEWAY_UNAUTHORIZED",
  "AI_GATEWAY_MODEL_NOT_FOUND",
  "AI_GATEWAY_CAPABILITY_INVALID",
  "NON_RETRYABLE_AUTH",
]);
const NOT_SENT_CHANNEL_CODES = new Set([
  "AI_GATEWAY_RATE_LIMITED",
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
  const adapterModelNotFound = code === "NON_RETRYABLE_GATEWAY" && ownErrorValue(error, "status") === 404;
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
  if (!exactDataKeys(phaseInput, PHASE_INPUT_KEYS[phase])) throw invalid();
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
  return isFinalMaterializedPlan(phaseInput.plan, context)
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

function validateRichPhaseInput(phaseInput, context) {
  return isFinalMaterializedPlan(phaseInput.plan, context)
    && phaseInput.planHash === phaseInput.plan.planHash
    && phaseInput.sourceHash === phaseInput.plan.sourceHash
    && validateAcceptedAssets(phaseInput, context);
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
    if (result.status !== "ACCEPTED" || result.accountId !== context.accountId || result.jobId !== context.jobId
      || result.itemId !== context.itemId || result.parentPlanId !== context.activeContentPlanId
      || result.sourceAssetId !== message.sourceAssetId) throw invalid();
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

function serviceFailure(message, error) {
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
  if (["PLAN_CONTENT", "GENERATE_IMAGE_SLOT", "GENERATE_RICH_CONTENT"].includes(message.phase)
    && !validGatewayExecution(phaseInput.gatewayExecution)) throw invalid();
  assertServices(dependencies);

  if (message.phase === "MATERIALIZE_SOURCE_ASSET" || message.phase === "FINALIZE_MATERIALIZED_PLAN") {
    if (isFinalMaterializedPlan(phaseInput.parentPlan, context)) {
      return message.phase === "FINALIZE_MATERIALIZED_PLAN"
        ? outcome(message, "ACK", "MATERIALIZED_PLAN_READY", null, false)
        : outcome(message, "ACK", "STALE", "AUTO_LISTING_AI_PHASE_ALREADY_COMPLETED", false);
    }
    if (!validateParentPhaseInput(phaseInput, context)) throw invalid();
  } else if (message.phase === "GENERATE_IMAGE_SLOT") {
    if (!validateImagePhaseInput(phaseInput, context, message)) throw invalid();
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
    return outcome(message, "ACK", SUCCESS_OUTCOME[message.phase], null, false);
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_EXECUTION_LEASE_LOST") throw error;
    return serviceFailure(message, error);
  }
}

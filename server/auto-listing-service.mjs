import { types as utilTypes } from "node:util";
import {
  normalizeAndHashAutoListingConfig,
  verifyAutoListingFrozenConfig,
} from "./auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "./auto-listing-item-image-config.mjs";
import {
  isSafeAutoListingBlockedCancellationFailure,
  isSafeAutoListingPlanningRetryFailure,
  isSafeAutoListingPreOzonRetryFailure,
} from "./auto-listing-state-machine.mjs";
import { AUTO_LISTING_PLANNING_CONTRACTS } from "./auto-listing-planning-contract.mjs";
import { calculateAutoListingPrice } from "./auto-listing-pricing.mjs";
import { normalizeAutoListingCurrency } from "./auto-listing-currency.mjs";
import { resolveAiContentStrategy } from "./ai-content-strategy.mjs";
import {
  buildAutoListingBlockedSourceEvidence,
  buildAutoListingSourceSnapshot,
  finalizeAutoListingSourceAttributes,
} from "./auto-listing-source-snapshot.mjs";
import { validateTargetStoreRecord } from "./listing-submission-policy.mjs";
import {
  assertListingWarehouseEligible,
  listingWarehouseEligibility,
} from "./listing-warehouse-eligibility.mjs";
import { selectAutoListingUploadPolicyForNewJob } from "./auto-listing-upload-policy.mjs";
import { assertPermission, hasPermission, PERMISSIONS } from "./permissions.mjs";

const REQUEST_KEYS = new Set(["actor", "collectItemIds", "idempotencyKey", "config", "correlationId"]);
const PRICE_STRING_FIELDS = ["blackKopecks", "greenKopecks", "realPriceKopecks", "adjustmentKopecks", "preMultiplierPriceKopecks", "priceMultiplierMicros", "finalPriceKopecks"];
const BLOCKED_SOURCE_FAILURE_CODES = new Set([
  "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED",
  "AUTO_LISTING_SOURCE_SKU_REQUIRED",
  "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB",
  "AUTO_LISTING_SOURCE_CURRENCY_UNSUPPORTED",
  "AUTO_LISTING_SOURCE_CURRENCY_MISMATCH",
]);
const CATEGORY_STRATEGY_MODES = new Set(["LEGACY_FALLBACK", "REQUIRE_EXACT_STRATEGY"]);
const CATEGORY_STRATEGY_DRAFT_STATUSES = new Set([
  "COLLECTING", "SAMPLES_READY", "ANALYZING", "DRAFT_READY", "PUBLISHED", "NEEDS_REVIEW",
]);

function error(code, status = 422) {
  const result = new Error(code);
  result.code = code;
  result.status = status;
  return result;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

const COLLECT_SOURCE_KEYS = new Set([
  "id", "accountId", "sourceVersion", "rawResponseRef", "rawResponseHash", "rawCollectedAt",
  "categoryEvidence", "sharedCategory", "collectItem", "productDraft",
]);
const EXCEL_SOURCE_KEYS = new Set([...COLLECT_SOURCE_KEYS, "collectItemId"]);
const CATEGORY_EVIDENCE_KEYS = new Set([
  "id", "accountId", "sourceDescriptionCategoryId", "sourceTypeId", "taxonomyScope",
]);
const SHARED_CATEGORY_KEYS = new Set([
  "id", "accountId", "version", "evidenceId", "status", "source",
  "sourceDescriptionCategoryId", "sourceTypeId", "currentDescriptionCategoryId", "currentTypeId",
  "taxonomyScope", "taxonomyFingerprint",
]);

function projectSourceCategoryCarrier(accountId, sourceType, rawSource) {
  if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)
    || utilTypes.isProxy(rawSource)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(rawSource))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(rawSource);
  const isExcel = sourceType === "EXCEL_SKU";
  if (!isExcel && sourceType !== "COLLECT_BOX") throw new TypeError();
  const source = closedDataObject(rawSource, isExcel ? EXCEL_SOURCE_KEYS : COLLECT_SOURCE_KEYS);
  const evidence = closedDataObject(source.categoryEvidence, CATEGORY_EVIDENCE_KEYS);
  const shared = closedDataObject(source.sharedCategory, SHARED_CATEGORY_KEYS);
  const positiveId = (value) => /^[1-9][0-9]*$/u.test(String(value ?? ""));
  const fingerprint = shared.taxonomyFingerprint;
  if (!(text(source.id) && (!isExcel || text(source.collectItemId))
    && source.accountId === accountId && text(evidence.id) && text(shared.id)
    && evidence.accountId === accountId && shared.accountId === accountId
    && shared.status === "ACTIVE"
    && shared.taxonomyScope === "OZON:DEFAULT" && evidence.taxonomyScope === "OZON:DEFAULT"
    && String(shared.sourceDescriptionCategoryId) === String(evidence.sourceDescriptionCategoryId)
    && String(shared.sourceTypeId) === String(evidence.sourceTypeId)
    && [evidence.sourceDescriptionCategoryId, evidence.sourceTypeId,
      shared.currentDescriptionCategoryId, shared.currentTypeId].every(positiveId)
    && ["SOURCE_DIRECT", "OZON_REFRESH", "MANUAL"].includes(shared.source)
    && (fingerprint === null || fingerprint === "" || (typeof fingerprint === "string" && /^[0-9a-f]{64}$/u.test(fingerprint)))
    && Number.isSafeInteger(shared.version) && shared.version > 0)) throw new TypeError();
  const projected = Object.freeze({ ...source, categoryEvidence: Object.freeze(evidence), sharedCategory: Object.freeze(shared) });
  const authorization = Object.freeze({
    collectItemId: text(source.collectItemId || source.id),
    evidenceId: text(evidence.id),
    sharedCategoryId: text(shared.id),
    sharedCategoryVersion: shared.version,
    sourceDescriptionCategoryId: Number(evidence.sourceDescriptionCategoryId),
    sourceTypeId: Number(evidence.sourceTypeId),
    descriptionCategoryId: Number(shared.currentDescriptionCategoryId),
    typeId: Number(shared.currentTypeId),
    taxonomyScope: shared.taxonomyScope,
    taxonomyFingerprint: shared.taxonomyFingerprint || "",
    provenance: shared.source,
  });
  const scope = Object.freeze({
    taxonomyScope: shared.taxonomyScope,
    descriptionCategoryId: Number(shared.currentDescriptionCategoryId),
    typeId: Number(shared.currentTypeId),
  });
  return Object.freeze({ source: projected, authorization, scope });
}

function scopeKey(scope) {
  return `${scope.taxonomyScope}\u001f${scope.descriptionCategoryId}\u001f${scope.typeId}`;
}

function closedDataObject(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expectedKeys.size || keys.some((key) => typeof key !== "string"
    || !expectedKeys.has(key) || descriptors[key]?.enumerable !== true
    || !Object.hasOwn(descriptors[key], "value"))) throw new TypeError();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function closedDenseArray(value, maximum = 100) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== value.length + 1 || descriptors.length?.value !== value.length) throw new TypeError();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new TypeError();
    return descriptor.value;
  });
}

function projectExactCategoryScope(value) {
  const scope = closedDataObject(value, new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]));
  if (scope.taxonomyScope !== "OZON:DEFAULT"
    || !Number.isSafeInteger(scope.descriptionCategoryId) || scope.descriptionCategoryId < 1
    || !Number.isSafeInteger(scope.typeId) || scope.typeId < 1) throw new TypeError();
  return Object.freeze({ ...scope });
}

function projectCategoryStrategyControl(value) {
  try {
    const control = closedDataObject(value, new Set(["mode", "version", "drafts"]));
    if (!CATEGORY_STRATEGY_MODES.has(control.mode)
      || !Number.isSafeInteger(control.version) || control.version < 1) throw new TypeError();
    const drafts = closedDenseArray(control.drafts).map((raw) => {
      const draft = closedDataObject(raw, new Set(["scope", "draftId", "status"]));
      const draftId = text(draft.draftId);
      if (!draftId || draftId.length > 240 || !CATEGORY_STRATEGY_DRAFT_STATUSES.has(draft.status)) throw new TypeError();
      return Object.freeze({ scope: projectExactCategoryScope(draft.scope), draftId, status: draft.status });
    });
    if (new Set(drafts.map((draft) => scopeKey(draft.scope))).size !== drafts.length) throw new TypeError();
    return Object.freeze({ mode: control.mode, version: control.version, drafts: Object.freeze(drafts) });
  } catch {
    throw error("AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", 500);
  }
}

function exactV1TypeIdentity(rule, expectedScope) {
  try {
    if (!rule || typeof rule !== "object" || utilTypes.isProxy(rule)) throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(rule, "exactScope");
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new TypeError();
    const projected = closedDataObject(descriptor.value,
      new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]));
    return projected.taxonomyScope === expectedScope.taxonomyScope
      && Number(projected.descriptionCategoryId) === expectedScope.descriptionCategoryId
      && Number(projected.typeId) === expectedScope.typeId;
  } catch {
    return false;
  }
}

function projectPublishedBundle(value) {
  if (value === null || value === undefined) return null;
  try {
    const bundle = closedDataObject(value, new Set(["strategyVersion", "rules"]));
    const strategyVersion = closedDataObject(bundle.strategyVersion,
      new Set(["strategyId", "strategyVersionId"]));
    for (const identifier of [strategyVersion.strategyId, strategyVersion.strategyVersionId]) {
      if (!text(identifier) || text(identifier).length > 240) throw new TypeError();
    }
    return Object.freeze({
      strategyVersion: Object.freeze({
        strategyId: text(strategyVersion.strategyId),
        strategyVersionId: text(strategyVersion.strategyVersionId),
      }),
      rules: Object.freeze(closedDenseArray(bundle.rules, 10_000)),
    });
  } catch {
    throw error("AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", 500);
  }
}

function findPublishedRule(published, ruleId) {
  try {
    const bundle = closedDataObject(published, new Set(["strategyVersion", "rules"]));
    return closedDenseArray(bundle.rules, 10_000).find((rawRule) => {
      if (!rawRule || typeof rawRule !== "object" || utilTypes.isProxy(rawRule)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(rawRule, "ruleId");
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value")
        && descriptor.value === ruleId;
    }) || null;
  } catch {
    throw error("AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", 500);
  }
}

function resolveForExactScope(published, scope) {
  try {
    return resolveAiContentStrategy({
      strategyVersion: published.strategyVersion,
      rules: published.rules,
      product: {
        taxonomyScope: scope.taxonomyScope,
        descriptionCategoryId: String(scope.descriptionCategoryId),
        typeId: String(scope.typeId),
        categoryAncestors: [],
        productStyle: "UNKNOWN",
      },
    });
  } catch {
    throw error("AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", 500);
  }
}

function strategyRequired({ scope, sourceCollectItemId, control, actor }) {
  const canManage = hasPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
  const draft = control.drafts.find((candidate) => scopeKey(candidate.scope) === scopeKey(scope));
  const details = {
    scope,
    sourceCollectItemId,
    status: draft?.status || "NOT_CONFIGURED",
    canManage,
    ...(canManage && draft ? { draftId: draft.draftId } : {}),
  };
  const failure = error("AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED", 409);
  failure.details = Object.freeze(details);
  return failure;
}

function assertRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !REQUEST_KEYS.has(key))) {
    throw error("AUTO_LISTING_REQUEST_INVALID");
  }
  const ids = input.collectItemIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 1000 || ids.some((id) => !text(id))) throw error("AUTO_LISTING_REQUEST_INVALID");
  const collectItemIds = [...new Set(ids.map(text))];
  if (collectItemIds.length < 1 || collectItemIds.length > 100) throw error("AUTO_LISTING_REQUEST_INVALID");
  const idempotencyKey = text(input.idempotencyKey);
  const correlationId = text(input.correlationId);
  if (!idempotencyKey || idempotencyKey.length > 240 || !correlationId || correlationId.length > 240) {
    throw error("AUTO_LISTING_REQUEST_INVALID");
  }
  return { collectItemIds, idempotencyKey, correlationId };
}

function priceInput(snapshot, adjustmentKopecks, priceMultiplierMicros) {
  return {
    blackKopecks: snapshot.priceEvidence.blackKopecks,
    greenKopecks: snapshot.priceEvidence.greenKopecks,
    currency: snapshot.priceEvidence.currency,
    adjustmentKopecks,
    priceMultiplierMicros,
  };
}

function categoryAncestors(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.map((categoryId, index) => ({ categoryId: String(categoryId), distance: index + 1 }))
    .filter((entry) => entry.categoryId);
}

function strategyFor(snapshot, source, published, useCategoryStrategy = true) {
  return resolveAiContentStrategy({
    strategyVersion: published.strategyVersion,
    rules: useCategoryStrategy ? published.rules : [],
    product: {
      taxonomyScope: snapshot.targetCategory.taxonomyScope,
      descriptionCategoryId: snapshot.targetCategory.descriptionCategoryId,
      typeId: String(snapshot.targetCategory.typeId),
      categoryAncestors: categoryAncestors(snapshot.targetCategory.ancestorCategoryIds),
      productStyle: snapshot.source.productStyle,
    },
  });
}

function buildJobItems({
  accountId, sourceType, sources, targetStore, config, configHash, published, selectPlanningContract,
}) {
  return sources.map((source, sourceIndex) => {
    const sourceOrder = sourceIndex + 1;
    const sourceRecordId = text(source.id);
    const collectItemId = text(source.collectItemId || source.id);
    const planningContract = selectPlanningContract({ accountId, sourceType, collectItemId });
    if (!Object.values(AUTO_LISTING_PLANNING_CONTRACTS).includes(planningContract)) {
      throw error("AUTO_LISTING_PLANNING_CONTRACT_INVALID", 500);
    }
    let captured;
    try {
      captured = buildAutoListingSourceSnapshot({
        accountId,
        sourceType,
        sourceRecordId,
        collectItemId,
        sourceVersion: source.sourceVersion,
        collectItem: source.collectItem,
        productDraft: source.productDraft,
        rawResponseRef: source.rawResponseRef,
        rawResponseHash: source.rawResponseHash,
        rawCollectedAt: source.rawCollectedAt,
        categoryEvidence: source.categoryEvidence,
        sharedCategory: source.sharedCategory,
        targetStoreId: targetStore.id,
        targetStoreCurrency: targetStore.currencyCode,
      });
    } catch (caught) {
      const failureCode = text(caught?.code);
      if (!BLOCKED_SOURCE_FAILURE_CODES.has(failureCode)) throw caught;
      const blocked = buildAutoListingBlockedSourceEvidence({
        accountId,
        sourceType,
        sourceRecordId,
        sourceVersion: source.sourceVersion,
        productDraft: source.productDraft,
        rawResponseRef: source.rawResponseRef,
        rawResponseHash: source.rawResponseHash,
        rawCollectedAt: source.rawCollectedAt,
        failureCode,
      });
      return {
        sourceType, sourceRecordId, collectItemId, sourceVersion: source.sourceVersion, planningContract,
        blockedEvidence: blocked.blockedEvidence, snapshotHash: blocked.snapshotHash,
        rawResponseRef: blocked.rawResponseRef, targetStoreId: targetStore.id,
        targetWarehouseId: config.targetWarehouseId, sourceOrder, status: "BLOCKED", failureCode,
      };
    }
    const base = {
      sourceType, sourceRecordId, collectItemId, sourceVersion: source.sourceVersion, planningContract,
      snapshot: captured.snapshot, snapshotHash: captured.snapshotHash,
      rawResponseRef: captured.rawResponseRef, targetStoreId: targetStore.id,
      targetWarehouseId: config.targetWarehouseId, sourceOrder,
      effectiveImageConfig: deriveEffectiveAutoListingImageConfig({
        configSnapshot: config, configHash, sourceCapture: captured,
      }),
    };
    const strategy = strategyFor(captured.snapshot, source, published, config.useCategoryStrategy !== false);
    try {
      return {
        ...base, strategyId: strategy.strategyId, strategyVersionId: strategy.strategyVersionId,
        ruleId: strategy.ruleId, style: strategy.style, matchedBy: strategy.matchedBy,
        status: "SOURCE_READY",
        price: calculateAutoListingPrice(priceInput(
          captured.snapshot, config.priceAdjustmentKopecks, config.priceMultiplierMicros,
        )),
      };
    } catch (caught) {
      return {
        ...base, strategyId: strategy.strategyId, strategyVersionId: strategy.strategyVersionId,
        ruleId: strategy.ruleId, style: strategy.style, matchedBy: strategy.matchedBy,
        status: "BLOCKED", failureCode: text(caught?.code) || "AUTO_LISTING_ITEM_BLOCKED",
      };
    }
  });
}

function safePrice(value) {
  const currency = normalizeAutoListingCurrency(value?.currency);
  if (!value || typeof value !== "object" || Array.isArray(value) || !currency
    || !["BLACK_GTE_80", "BLACK_LT_80"].includes(value.branch)) return undefined;
  const price = { currency, branch: value.branch };
  for (const field of PRICE_STRING_FIELDS) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== "string" || !/^[+-]?\d+$/.test(value[field])) return undefined;
    price[field] = value[field];
  }
  return price;
}

function safeString(value, max = 512) {
  return typeof value === "string" && value.length <= max ? value : null;
}

function safeTimestamp(value) {
  if (typeof value === "string" && value.length <= 80) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return null;
}

function safeItemActions(source) {
  const status = safeString(source.status) || "";
  const hasReview = Boolean(safeString(source.activeContentPlanId) || safeString(source.active_content_plan_id));
  const recoveryPoint = safeString(source.recoveryPoint) || safeString(source.recovery_point) || "";
  const failureCode = safeString(source.failureCode) || safeString(source.failure_code) || "";
  const recoverableBlockedFailure = status === "BLOCKED" && [
    "AUTO_LISTING_MAIN_IMAGE_REQUIRED",
    "AUTO_LISTING_MINIMUM_IMAGE_COUNT_NOT_MET",
    "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID",
    "AUTO_LISTING_RICH_CONTENT_ATTEMPTS_EXHAUSTED",
    "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID",
  ].includes(failureCode);
  const uploadPolicyPreflightBlocked = status === "BLOCKED"
    && isSafeAutoListingPreOzonRetryFailure(failureCode);
  const recoverableBlockedPlanningFailure = status === "BLOCKED"
    && isSafeAutoListingPlanningRetryFailure(failureCode);
  const cancellable = ["CREATED", "SOURCE_READY", "PLANNING", "GENERATING", "READY_FOR_REVIEW", "UPLOAD_QUEUED", "RETRYABLE_ERROR"].includes(status)
    || (status === "BLOCKED" && isSafeAutoListingBlockedCancellationFailure(failureCode));
  return Object.freeze({
    review: hasReview && ["READY_FOR_REVIEW", "SUCCEEDED"].includes(status),
    approve: hasReview && (status === "READY_FOR_REVIEW" || uploadPolicyPreflightBlocked),
    retry: (status === "RETRYABLE_ERROR" && ["PLANNING", "GENERATION"].includes(recoveryPoint))
      || recoverableBlockedFailure || recoverableBlockedPlanningFailure,
    regenerate: hasReview && status === "READY_FOR_REVIEW",
    cancel: cancellable,
  });
}

function failureStageFor(source) {
  const status = safeString(source.status) || "";
  if (!["RETRYABLE_ERROR", "BLOCKED", "CANCELLED"].includes(status)) return null;
  const recoveryPoint = safeString(source.recoveryPoint) || safeString(source.recovery_point) || "";
  if (recoveryPoint === "UPLOAD") return "UPLOAD";
  if (recoveryPoint === "GENERATION") return "GENERATION";
  if (recoveryPoint === "PLANNING") return "PREPARATION";
  const code = safeString(source.failureCode) || safeString(source.failure_code) || "";
  if (/^(?:AUTO_LISTING_(?:UPLOAD|DIRECT|PUBLICATION|RECONCILE)_|OZON_(?:SUBMISSION|RICH_CONTENT)_)/u.test(code)) return "UPLOAD";
  if (safeString(source.activeContentPlanId) || safeString(source.active_content_plan_id)) return "GENERATION";
  return "PREPARATION";
}

const EMPTY_AI_QUEUE_PROJECTION = Object.freeze({
  aiQueueState: null,
  aiChannelDisplayName: null,
  aiChannelSwitching: false,
  aiChannelWaitStartedAt: null,
});

function safeAiQueueProjection(source) {
  if (!["PLANNING", "GENERATING"].includes(safeString(source.status))) return EMPTY_AI_QUEUE_PROJECTION;
  const state = safeString(source.aiQueueState);
  if (!["WAITING_FOR_AI_CHANNEL", "CALLING_AI", "SWITCHING_AI_CHANNEL"].includes(state)) {
    return EMPTY_AI_QUEUE_PROJECTION;
  }
  const rawDisplayName = safeString(source.aiChannelDisplayName, 200);
  const displayName = rawDisplayName && rawDisplayName.trim()
    && !/[\u0000-\u001f\u007f]/u.test(rawDisplayName) ? rawDisplayName : null;
  const switching = source.aiChannelSwitching === true;
  const waitStartedAt = source.aiChannelWaitStartedAt === null
    ? null : safeTimestamp(source.aiChannelWaitStartedAt);
  const waitDate = waitStartedAt === null ? null : new Date(waitStartedAt);
  const canonicalWaitStartedAt = waitDate && Number.isFinite(waitDate.getTime())
    ? waitDate.toISOString() : null;
  if (switching !== (state === "SWITCHING_AI_CHANNEL")
    || (state === "CALLING_AI" && (!displayName || source.aiChannelWaitStartedAt !== null))
    || (state !== "CALLING_AI" && !canonicalWaitStartedAt)) return EMPTY_AI_QUEUE_PROJECTION;
  return Object.freeze({
    aiQueueState: state,
    aiChannelDisplayName: displayName,
    aiChannelSwitching: switching,
    aiChannelWaitStartedAt: state === "CALLING_AI" ? null : canonicalWaitStartedAt,
  });
}

function safeItem(item = {}, jobCreatedAt = null) {
  const source = item.source || item;
  const workflowProgress = safeWorkflowProgress(source.workflowProgress);
  const aiQueueProjection = safeAiQueueProjection(source);
  return {
    itemId: safeString(source.id) || safeString(source.itemId),
    status: safeString(source.status),
    ...(Number.isSafeInteger(source.statusVersion ?? source.status_version)
      && Number(source.statusVersion ?? source.status_version) > 0
      ? { statusVersion: Number(source.statusVersion ?? source.status_version) } : {}),
    createdAt: safeTimestamp(source.createdAt) || safeTimestamp(source.created_at),
    updatedAt: safeTimestamp(source.updatedAt) || safeTimestamp(source.updated_at),
    targetStoreId: safeString(source.targetStoreId) || safeString(source.target_store_id),
    targetWarehouseId: safeString(source.targetWarehouseId) || safeString(source.target_warehouse_id),
    sourceRecordId: safeString(source.sourceRecordId) || safeString(source.source_record_id),
    sourceVersion: safeString(source.sourceVersion) || safeString(source.source_version),
    sourceHash: safeString(source.sourceHash) || safeString(source.source_hash) || safeString(source.snapshotHash) || safeString(source.snapshot_hash),
    ...(Number.isSafeInteger(source.sourceOrder ?? source.source_order)
      && Number(source.sourceOrder ?? source.source_order) > 0
      ? { sourceOrder: Number(source.sourceOrder ?? source.source_order) } : {}),
    sourceThumbnailUrl: safeString(source.sourceThumbnailUrl) || safeString(source.source_thumbnail_url) || "",
    sourceTitle: safeString(source.sourceTitle) || safeString(source.source_title) || "",
    sourceSku: safeString(source.sourceSku) || safeString(source.source_sku) || "",
    jobCreatedAt,
    failureStage: failureStageFor(source),
    ...(safePrice(source.price) ? { price: safePrice(source.price) } : {}),
    ...(safeString(source.failureCode) || safeString(source.failure_code) ? { failureCode: safeString(source.failureCode) || safeString(source.failure_code) } : {}),
    ...(workflowProgress ? { workflowProgress } : {}),
    ...aiQueueProjection,
    actions: safeItemActions(source),
  };
}

function safeWorkflowProgress(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const keys = ["phase", "state", "attemptCount", "updatedAt", "nextRetryAt"];
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) =>
      descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) return null;
    const phase = safeString(descriptors.phase.value);
    const state = descriptors.state.value;
    const attemptCount = descriptors.attemptCount.value;
    const updatedAt = safeTimestamp(descriptors.updatedAt.value);
    const nextRetryAt = descriptors.nextRetryAt.value === null ? null : safeTimestamp(descriptors.nextRetryAt.value);
    const canonicalTimestamp = (candidate) => {
      if (!candidate) return false;
      const parsed = new Date(candidate);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString() === candidate;
    };
    if (!["PLAN_CONTENT", "MATERIALIZE_SOURCE_ASSET", "FINALIZE_MATERIALIZED_PLAN", "GENERATE_IMAGE_SLOT", "GENERATE_RICH_CONTENT"].includes(phase)
      || !["QUEUED", "RUNNING", "RETRY_WAIT", "COMPLETED", "FAILED"].includes(state)
      || !Number.isSafeInteger(attemptCount) || attemptCount < 0 || !canonicalTimestamp(updatedAt)
      || (state === "RETRY_WAIT" ? !canonicalTimestamp(nextRetryAt) : nextRetryAt !== null)) return null;
    return { phase, state, attemptCount, updatedAt, nextRetryAt };
  } catch {
    return null;
  }
}

function safeJob(row = {}) {
  if (!row) return null;
  const createdAt = safeTimestamp(row.createdAt) || safeTimestamp(row.created_at);
  return {
    jobId: safeString(row.id) || safeString(row.jobId),
    sourceType: safeString(row.sourceType) || safeString(row.source_type) || "COLLECT_BOX",
    status: safeString(row.status) || "CREATED",
    correlationId: safeString(row.correlationId) || safeString(row.correlation_id),
    createdAt,
    updatedAt: safeTimestamp(row.updatedAt) || safeTimestamp(row.updated_at),
    items: (Array.isArray(row.items) ? row.items : []).map((item) => safeItem(item, createdAt)),
  };
}

function requireRepository(repository) {
  const required = ["loadCollectSources", "loadTargetStore", "loadTargetWarehouse", "loadPublishedStrategy",
    "loadCategoryStrategyControl",
    "loadPublishedUploadPolicies", "acquireCategoryPreparationLease", "releaseCategoryPreparationLease",
    "getJobByIdempotencyKey",
    "createJobGraph", "getJob", "listJobs"];
  if (!repository || required.some((name) => typeof repository[name] !== "function")) {
    throw new TypeError("Auto listing repository dependencies are required");
  }
  return repository;
}

function requireRfbsWarehouseVerifier(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.length !== 1 || keys[0] !== "verifyRfbsWarehouse"
      || descriptors.verifyRfbsWarehouse?.enumerable !== true
      || !Object.hasOwn(descriptors.verifyRfbsWarehouse, "value")
      || typeof descriptors.verifyRfbsWarehouse.value !== "function"
      || utilTypes.isProxy(descriptors.verifyRfbsWarehouse.value)) throw new TypeError();
    return Object.freeze({ verifyRfbsWarehouse: descriptors.verifyRfbsWarehouse.value });
  } catch {
    throw new TypeError("Auto listing RFBS warehouse verifier dependency is required");
  }
}

function categoryLeaseSignal(value) {
  if (!(value instanceof AbortSignal)) throw error("AUTO_LISTING_CATEGORY_LEASE_INVALID", 500);
  return value;
}

function assertCategoryLeaseActive(signal) {
  if (!signal.aborted) return;
  if (signal.reason?.code === "AUTO_LISTING_CATEGORY_LEASE_EXPIRED") throw signal.reason;
  throw error("AUTO_LISTING_CATEGORY_LEASE_EXPIRED", 409);
}

export function createAutoListingService({
  repository,
  prepareListingBase,
  rfbsWarehouseVerifier,
  ensureCategoryFresh = async () => Object.freeze({ status: "CURRENT" }),
  uploadPolicyGates = {},
  selectPlanningContract = () => AUTO_LISTING_PLANNING_CONTRACTS.LEGACY,
  observability = null,
} = {}) {
  const storage = requireRepository(repository);
  if (typeof prepareListingBase !== "function") {
    throw new TypeError("Auto listing base preparer dependency is required");
  }
  if (typeof ensureCategoryFresh !== "function") {
    throw new TypeError("Auto listing category freshness dependency is required");
  }
  if (typeof selectPlanningContract !== "function" || utilTypes.isProxy(selectPlanningContract)) {
    throw new TypeError("Auto listing planning contract selector dependency is required");
  }
  if (!(observability === null || typeof observability?.observe === "function")) {
    throw new TypeError("Auto listing category strategy observability dependency is invalid");
  }
  const verifier = requireRfbsWarehouseVerifier(rfbsWarehouseVerifier);
  const observationStartedAt = () => Date.now();
  async function observe(input) {
    if (!observability) return;
    try { await observability.observe(input); } catch {}
  }
  function strictObservation(gate) {
    const selected = gate?.graph?.mode === "REQUIRE_EXACT_STRATEGY" ? gate.graph.scopes?.[0] : null;
    if (!selected) return null;
    return Object.freeze({
      scope: Object.freeze({ taxonomyScope: selected.taxonomyScope,
        descriptionCategoryId: selected.descriptionCategoryId, typeId: selected.typeId }),
      strategyVersionId: gate.published.strategyVersion.strategyVersionId,
    });
  }
  function replayStrictObservation(replay) {
    try {
      if (!replay || typeof replay !== "object" || Array.isArray(replay) || utilTypes.isProxy(replay)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(replay))) return null;
      const replayDescriptors = Object.getOwnPropertyDescriptors(replay);
      const itemsDescriptor = replayDescriptors.items;
      if (!itemsDescriptor || !Object.hasOwn(itemsDescriptor, "value")) return null;
      const items = itemsDescriptor.value;
      if (!Array.isArray(items) || utilTypes.isProxy(items) || Object.getPrototypeOf(items) !== Array.prototype) return null;
      const itemDescriptor = Object.getOwnPropertyDescriptor(items, "0");
      if (!itemDescriptor || !Object.hasOwn(itemDescriptor, "value")) return null;
      const item = itemDescriptor.value;
      if (!item || typeof item !== "object" || Array.isArray(item) || utilTypes.isProxy(item)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return null;
      const itemDescriptors = Object.getOwnPropertyDescriptors(item);
      const value = (key) => itemDescriptors[key]?.enumerable === true
        && Object.hasOwn(itemDescriptors[key], "value") ? itemDescriptors[key].value : undefined;
      const candidate = value("categoryStrategyScope");
      if (value("categoryStrategyMode") !== "REQUIRE_EXACT_STRATEGY" || !candidate
        || typeof candidate !== "object" || Array.isArray(candidate) || utilTypes.isProxy(candidate)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))) return null;
      const scopeDescriptors = Object.getOwnPropertyDescriptors(candidate);
      const scopeValue = (key) => scopeDescriptors[key]?.enumerable === true
        && Object.hasOwn(scopeDescriptors[key], "value") ? scopeDescriptors[key].value : undefined;
      const taxonomyScope = scopeValue("taxonomyScope");
      const descriptionCategoryId = scopeValue("descriptionCategoryId");
      const typeId = scopeValue("typeId");
      const strategyVersionId = value("strategyVersionId");
      if (taxonomyScope !== "OZON:DEFAULT"
        || !/^[1-9][0-9]*$/u.test(String(descriptionCategoryId ?? ""))
        || !/^[1-9][0-9]*$/u.test(String(typeId ?? ""))
        || !text(strategyVersionId)) return null;
      return Object.freeze({ strategyVersionId: text(strategyVersionId), scope: Object.freeze({
        taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: Number(descriptionCategoryId),
        typeId: Number(typeId),
      }) });
    } catch {
      return null;
    }
  }
  async function observeContinue({ accountId, observation, correlationId, outcome, startedAt }) {
    if (!observation) return;
    await observe({ metric: "category_strategy_continue_create_total", accountId,
      draftId: null, sessionId: null, attemptId: null,
      strategyVersionId: observation.strategyVersionId, scope: observation.scope,
      correlationId, outcome, startedAt });
  }
  async function evaluateCategoryStrategyGate({ accountId, actor, sourceType, sources, useCategoryStrategy = true,
    correlationId = "category-strategy-required", startedAt = observationStartedAt() }) {
    let projectedSources;
    try {
      projectedSources = closedDenseArray(sources)
        .map((source) => projectSourceCategoryCarrier(accountId, sourceType, source));
    } catch {
      throw error("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", 409);
    }
    if (projectedSources.length < 1) {
      throw error("AUTO_LISTING_SOURCE_NOT_FOUND", 404);
    }
    const uniqueScopeSources = [...new Map(projectedSources.map(({ scope, authorization }) => {
      return [scopeKey(scope), Object.freeze({ scope, sourceCollectItemId: authorization.collectItemId })];
    })).values()];
    const uniqueScopes = uniqueScopeSources.map(({ scope }) => scope);
    if (!useCategoryStrategy) {
      let rawPublished;
      try {
        rawPublished = await storage.loadPublishedStrategy({ accountId });
      } catch {
        throw error("AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", 500);
      }
      const published = projectPublishedBundle(rawPublished);
      if (!published) throw error("AUTO_LISTING_STRATEGY_NOT_PUBLISHED", 409);
      return Object.freeze({
        published,
        sources: Object.freeze(projectedSources.map(({ source }) => source)),
        authorizations: Object.freeze(projectedSources.map(({ authorization }) => authorization)),
        graph: undefined,
      });
    }
    let rawControl;
    let rawPublished;
    try {
      rawControl = await storage.loadCategoryStrategyControl({ accountId, scopes: uniqueScopes });
      rawPublished = await storage.loadPublishedStrategy({ accountId });
    } catch {
      throw error("AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", 500);
    }
    const control = projectCategoryStrategyControl(rawControl);
    const published = projectPublishedBundle(rawPublished);
    if (control.mode === "LEGACY_FALLBACK") {
      if (!published) {
        throw error("AUTO_LISTING_STRATEGY_NOT_PUBLISHED", 409);
      }
      return Object.freeze({
        published,
        sources: Object.freeze(projectedSources.map(({ source }) => source)),
        authorizations: Object.freeze(projectedSources.map(({ authorization }) => authorization)),
        graph: Object.freeze({ mode: control.mode, policyVersion: control.version, scopes: Object.freeze([]) }),
      });
    }
    if (!published) {
      await observe({ metric: "category_strategy_required_total", accountId, draftId: null,
        sessionId: null, attemptId: null, strategyVersionId: null, scope: uniqueScopes[0],
        correlationId, outcome: "blocked",
        startedAt });
      throw strategyRequired({ ...uniqueScopeSources[0], control, actor });
    }
    const selectedScopes = [];
    for (const { scope, sourceCollectItemId } of uniqueScopeSources) {
      const resolved = resolveForExactScope(published, scope);
      const rawRule = findPublishedRule(published, resolved.ruleId);
      const accepted = resolved.matchedBy === "EXACT_CATEGORY_TYPE_V2"
        || (resolved.matchedBy === "EXACT_CATEGORY" && rawRule && exactV1TypeIdentity(rawRule, scope));
      if (!accepted) {
        await observe({ metric: "category_strategy_required_total", accountId, draftId: null,
          sessionId: null, attemptId: null, strategyVersionId: null, scope,
          correlationId, outcome: "blocked",
          startedAt });
        throw strategyRequired({ scope, sourceCollectItemId, control, actor });
      }
      selectedScopes.push(Object.freeze({ ...scope, ruleId: resolved.ruleId }));
    }
    return Object.freeze({
      published,
      sources: Object.freeze(projectedSources.map(({ source }) => source)),
      authorizations: Object.freeze(projectedSources.map(({ authorization }) => authorization)),
      graph: Object.freeze({
        mode: control.mode,
        policyVersion: control.version,
        scopes: Object.freeze(selectedScopes),
      }),
    });
  }
  async function createFromSources({
    accountId, actor, sourceType, sources, idempotencyKey, correlationId, config, configHash,
    targetStore: suppliedStore = null, categoryStrategyGate: suppliedCategoryStrategyGate = null,
  }) {
    const categoryStrategyGate = suppliedCategoryStrategyGate
      || await evaluateCategoryStrategyGate({ accountId, actor, sourceType, sources,
        useCategoryStrategy: config.useCategoryStrategy !== false,
        correlationId, startedAt: observationStartedAt() });
    sources = categoryStrategyGate.sources;
    const store = suppliedStore || await storage.loadTargetStore({ accountId, targetStoreId: config.targetStoreId });
    const targetStore = suppliedStore || validateTargetStoreRecord({ accountId, targetStoreId: config.targetStoreId, store });
    const targetStoreCurrency = normalizeAutoListingCurrency(targetStore.currencyCode);
    if (!targetStoreCurrency || targetStoreCurrency !== targetStore.currencyCode) {
      throw error("AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED", 422);
    }
    const categoryLease = await storage.acquireCategoryPreparationLease({
      accountId,
      items: categoryStrategyGate.authorizations,
    });
    let leaseOutcome = "FAILED";
    let leaseJobId = null;
    let primaryError = null;
    try {
      const signal = categoryLeaseSignal(categoryLease.signal);
      assertCategoryLeaseActive(signal);
      const warehouseEvidence = await storage.loadTargetWarehouse({
        accountId,
        targetStoreId: config.targetStoreId,
        targetWarehouseId: config.targetWarehouseId,
      });
      const warehouse = warehouseEvidence?.warehouse;
      if (!warehouse
        || text(warehouse.id) !== config.targetWarehouseId
        || text(warehouse.storeId || warehouse.store_id) !== config.targetStoreId
        || text(warehouse.accountId || warehouse.account_id || warehouse.ownerAccountId) !== accountId
        || !text(warehouse.warehouse_id || warehouse.warehouseId)) {
        throw error("AUTO_LISTING_WAREHOUSE_NOT_FOUND", 404);
      }
      const eligibilityInput = {
        warehouse,
        products: warehouseEvidence?.products || [],
        targetStoreId: config.targetStoreId,
        accountId,
      };
      const eligibility = listingWarehouseEligibility(eligibilityInput);
      const selectable = eligibility.eligible === true
        || (eligibility.fulfillmentType === "RFBS"
          && eligibility.code === "RFBS_VALIDATION_REQUIRED"
          && eligibility.evidenceRequired === true);
      if (!selectable) assertListingWarehouseEligible(eligibilityInput);
      const published = categoryStrategyGate.published;
      const uploadPolicy = selectAutoListingUploadPolicyForNewJob({
        accountId,
        policies: await storage.loadPublishedUploadPolicies({ accountId }),
        directUploadAllowed: uploadPolicyGates.directUploadAllowed === true,
        uploadEnabled: uploadPolicyGates.uploadEnabled === true,
        listingPipelineEnabled: uploadPolicyGates.listingPipelineEnabled === true,
      });
      const items = buildJobItems({
        accountId, sourceType, sources, targetStore, config, configHash, published, selectPlanningContract,
      });
      assertCategoryLeaseActive(signal);
      const preparedResults = await Promise.allSettled(items.map(async (item) => {
        if (item.status !== "SOURCE_READY") return item;
        assertCategoryLeaseActive(signal);
        const source = sources[item.sourceOrder - 1];
        const preparedListingBase = await prepareListingBase({
          accountId,
          brandMode: config.brandMode || "PREFER_SOURCE",
          source,
          targetStore,
          targetCategory: item.snapshot.targetCategory,
          pricingEvidence: {
            currency: item.snapshot.priceEvidence.currency,
            currencySource: item.snapshot.priceEvidence.currencySource,
            blackKopecks: item.snapshot.priceEvidence.blackKopecks,
            greenKopecks: item.snapshot.priceEvidence.greenKopecks || null,
          },
          variantPricingEvidence: item.snapshot.variants.map((variant) => ({
            sourceSku: variant.sku,
            currency: variant.priceEvidence.currency,
            ...(variant.priceEvidence.currencySource === undefined
              ? {} : { currencySource: variant.priceEvidence.currencySource }),
            blackKopecks: String(variant.priceEvidence.blackKopecks ?? ""),
            greenKopecks: variant.priceEvidence.greenKopecks === undefined
              || variant.priceEvidence.greenKopecks === null
              || variant.priceEvidence.greenKopecks === ""
              ? null : String(variant.priceEvidence.greenKopecks),
          })),
          signal,
        });
        const { contentAttributes, ...listingBaseTemplate } = preparedListingBase;
        const hasManualAttributes = item.snapshot.attributes.some((attribute) =>
          attribute && typeof attribute === "object" && !Array.isArray(attribute)
          && typeof attribute.name === "string" && attribute.name.trim()
          && Array.isArray(attribute.values) && attribute.values.some((entry) => {
            const value = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.value : entry;
            return Boolean((typeof value === "string" && value.trim())
              || (typeof value === "number" && Number.isFinite(value)));
          }));
        const sourceCapture = finalizeAutoListingSourceAttributes(
          item,
          hasManualAttributes || !Array.isArray(contentAttributes)
            ? item.snapshot.attributes : contentAttributes,
        );
        return {
          ...item,
          ...sourceCapture,
          sourceVersion: sourceCapture.snapshot.source.sourceVersion,
          effectiveImageConfig: deriveEffectiveAutoListingImageConfig({
            configSnapshot: config,
            configHash,
            sourceCapture,
          }),
          listingBaseTemplate,
        };
      }));
      const preparationFailure = preparedResults.find((result) => result.status === "rejected");
      assertCategoryLeaseActive(signal);
      if (preparationFailure) throw preparationFailure.reason;
      const preparedItems = preparedResults.map((result) => result.value);
      const warehouseValidation = eligibility.fulfillmentType === "RFBS"
        ? await verifier.verifyRfbsWarehouse({
          accountId,
          actorAccountId: accountId,
          targetStoreId: config.targetStoreId,
          targetWarehouseId: config.targetWarehouseId,
          correlationId,
          signal,
        })
        : null;
      assertCategoryLeaseActive(signal);
      const created = await storage.createJobGraph({
        accountId,
        actorAccountId: accountId,
        sourceType,
        idempotencyKey,
        correlationId,
        configSnapshot: config,
        configHash,
        strategyVersionId: published.strategyVersion.strategyVersionId,
        categoryStrategyGate: categoryStrategyGate.graph,
        uploadPolicyVersionId: uploadPolicy.id,
        categoryPreparationLeaseId: categoryLease.leaseId,
        categoryPreparationSignal: signal,
        warehouseValidation,
        items: preparedItems,
      });
      leaseJobId = text(created?.id);
      if (!leaseJobId) throw error("AUTO_LISTING_REPOSITORY_INVALID", 500);
      leaseOutcome = created?.duplicate === true ? "REPLAYED" : "COMMITTED";
      return safeJob(created);
    } catch (caught) {
      primaryError = caught;
      if (categoryLease.signal?.aborted) leaseOutcome = "TIMEOUT";
      if (leaseOutcome !== "TIMEOUT" && (caught?.code === "AUTO_LISTING_SOURCE_VERSION_CONFLICT"
        || caught?.code === "AUTO_LISTING_CATEGORY_LEASE_NOT_ACTIVE"
        || caught?.code === "AUTO_LISTING_CATEGORY_LEASE_EXPIRED")) {
        leaseOutcome = "CONFLICT";
      }
      throw caught;
    } finally {
      try {
        await storage.releaseCategoryPreparationLease({
          accountId, leaseId: categoryLease.leaseId, outcome: leaseOutcome,
          ...(leaseJobId ? { jobId: leaseJobId } : {}),
        });
      } catch (releaseError) {
        if (!primaryError) throw releaseError;
      }
    }
  }

  return {
    async createAutoListingJob(input = {}) {
      assertPermission(input.actor, PERMISSIONS.TENANT_OPERATE);
      const { collectItemIds, idempotencyKey, correlationId } = assertRequest(input);
      const requestStartedAt = observationStartedAt();
      const accountId = text(input.actor.id);
      if (!accountId) throw error("AUTO_LISTING_REQUEST_INVALID");
      const { config, configHash } = normalizeAndHashAutoListingConfig(input.config);
      const replay = await storage.getJobByIdempotencyKey({ accountId, idempotencyKey });
      if (replay) {
        await observeContinue({ accountId, observation: observability ? replayStrictObservation(replay) : null, correlationId,
          outcome: "replay", startedAt: requestStartedAt });
        return safeJob(replay);
      }
      let sources = await storage.loadCollectSources({ accountId, collectItemIds });
      let categoryStrategyGate = await evaluateCategoryStrategyGate({
        accountId, actor: input.actor, sourceType: "COLLECT_BOX", sources, correlationId,
        useCategoryStrategy: config.useCategoryStrategy !== false,
        startedAt: requestStartedAt,
      });
      sources = categoryStrategyGate.sources;
      const strictStartedAt = requestStartedAt;
      let strict = strictObservation(categoryStrategyGate);
      try {
      if (sources.length !== collectItemIds.length) throw error("AUTO_LISTING_SOURCE_NOT_FOUND", 404);
      const freshness = await ensureCategoryFresh({
        accountId, targetStoreId: config.targetStoreId, sources,
      });
      if (!freshness || !["CURRENT", "REFRESHED"].includes(freshness.status)) {
        throw error("AUTO_LISTING_CATEGORY_REFRESH_REQUIRED", 409);
      }
      if (freshness.status === "REFRESHED") {
        sources = await storage.loadCollectSources({ accountId, collectItemIds });
        categoryStrategyGate = await evaluateCategoryStrategyGate({
          accountId, actor: input.actor, sourceType: "COLLECT_BOX", sources, correlationId,
          useCategoryStrategy: config.useCategoryStrategy !== false,
          startedAt: requestStartedAt,
        });
        sources = categoryStrategyGate.sources;
        strict = strictObservation(categoryStrategyGate);
        if (sources.length !== collectItemIds.length) throw error("AUTO_LISTING_CATEGORY_REFRESH_REQUIRED", 409);
      }
      const created = await createFromSources({
        accountId, actor: input.actor, sourceType: "COLLECT_BOX", sources, idempotencyKey, correlationId,
        config, configHash, categoryStrategyGate,
      });
      await observeContinue({ accountId, observation: strict, correlationId,
        outcome: "success", startedAt: strictStartedAt });
      return created;
      } catch (caught) {
        if (strict) await observeContinue({ accountId, observation: strict, correlationId,
          outcome: caught?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED" ? "strategy_changed" : "failed",
          startedAt: strictStartedAt });
        throw caught;
      }
    },
    async createExcelAutoListingJob(input = {}) {
      assertPermission(input.actor, PERMISSIONS.TENANT_OPERATE);
      const requestStartedAt = observationStartedAt();
      const accountId = text(input.actor?.id);
      const importFileId = text(input.importFileId);
      if (!accountId || !importFileId || importFileId.length > 240
        || typeof storage.loadExcelImportContext !== "function"
        || typeof storage.loadExcelImportSources !== "function") {
        throw error("AUTO_LISTING_REQUEST_INVALID");
      }
      const file = await storage.loadExcelImportContext({ accountId, importFileId });
      if (!file || file.accountId !== accountId || file.id !== importFileId
        || !text(file.idempotencyKey) || !text(file.correlationId)) {
        throw error("AUTO_LISTING_IMPORT_NOT_FINALIZABLE", 409);
      }
      let frozen;
      try { frozen = verifyAutoListingFrozenConfig(file.configSnapshot, file.configHash); } catch {
        throw error("AUTO_LISTING_IMPORT_NOT_FINALIZABLE", 409);
      }
      const replay = await storage.getJobByIdempotencyKey({ accountId, idempotencyKey: file.idempotencyKey });
      if (replay) {
        await observeContinue({ accountId, observation: observability ? replayStrictObservation(replay) : null,
          correlationId: file.correlationId, outcome: "replay", startedAt: requestStartedAt });
        return safeJob(replay);
      }
      const store = await storage.loadTargetStore({ accountId, targetStoreId: frozen.config.targetStoreId });
      const targetStore = validateTargetStoreRecord({
        accountId, targetStoreId: frozen.config.targetStoreId, store,
      });
      const targetStoreCurrency = normalizeAutoListingCurrency(targetStore.currencyCode);
      if (!targetStoreCurrency || targetStoreCurrency !== targetStore.currencyCode) {
        throw error("AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED", 422);
      }
      const context = await storage.loadExcelImportSources({ accountId, importFileId });
      const loadedFile = context?.importFile;
      const sources = context?.sources;
      let loadedFrozen = null;
      try {
        loadedFrozen = loadedFile
          ? verifyAutoListingFrozenConfig(loadedFile.configSnapshot, loadedFile.configHash) : null;
      } catch {
        throw error("AUTO_LISTING_IMPORT_NOT_FINALIZABLE", 409);
      }
      if (!loadedFile || loadedFile.accountId !== accountId || loadedFile.id !== importFileId
        || loadedFile.status !== "COLLECTING" || loadedFile.statusVersion !== file.statusVersion
        || loadedFile.idempotencyKey !== file.idempotencyKey || loadedFile.correlationId !== file.correlationId
        || loadedFile.configHash !== file.configHash || loadedFrozen?.configHash !== frozen.configHash
        || !Number.isInteger(loadedFile.statusVersion) || loadedFile.statusVersion < 1
        || !Number.isInteger(loadedFile.acceptedRows) || !Number.isInteger(loadedFile.readyRows)
        || !Number.isInteger(loadedFile.failedRows)
        || loadedFile.readyRows + loadedFile.failedRows !== loadedFile.acceptedRows || loadedFile.readyRows < 1
        || !Array.isArray(sources) || sources.length !== loadedFile.readyRows
        || sources.some((source) => !text(source?.id) || !text(source?.collectItemId))) {
        throw error("AUTO_LISTING_IMPORT_NOT_FINALIZABLE", 409);
      }
      const categoryStrategyGate = await evaluateCategoryStrategyGate({ accountId, actor: input.actor,
        sourceType: "EXCEL_SKU", sources, useCategoryStrategy: frozen.config.useCategoryStrategy !== false,
        correlationId: file.correlationId, startedAt: requestStartedAt });
      const strict = strictObservation(categoryStrategyGate);
      try {
        const created = await createFromSources({
          accountId, actor: input.actor, sourceType: "EXCEL_SKU", sources,
          idempotencyKey: file.idempotencyKey, correlationId: file.correlationId,
          config: frozen.config, configHash: frozen.configHash, targetStore, categoryStrategyGate,
        });
        await observeContinue({ accountId, observation: strict, correlationId: file.correlationId,
          outcome: "success", startedAt: requestStartedAt });
        return created;
      } catch (caught) {
        await observeContinue({ accountId, observation: strict, correlationId: file.correlationId,
          outcome: caught?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED" ? "strategy_changed" : "failed",
          startedAt: requestStartedAt });
        throw caught;
      }
    },
    async getAutoListingJob({ actor, jobId } = {}) {
      assertPermission(actor, PERMISSIONS.TENANT_OPERATE);
      const accountId = text(actor?.id);
      const row = await storage.getJob({ accountId, jobId: text(jobId) });
      if (!row) throw error("AUTO_LISTING_JOB_NOT_FOUND", 404);
      return safeJob(row);
    },
    async listAutoListingJobs({ actor, limit = 20 } = {}) {
      assertPermission(actor, PERMISSIONS.TENANT_OPERATE);
      const accountId = text(actor?.id);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error("AUTO_LISTING_REQUEST_INVALID");
      const rows = await storage.listJobs({ accountId, limit });
      return (Array.isArray(rows) ? rows : []).map(safeJob);
    },
  };
}

export const createAutoListingJob = (dependencies, input) => createAutoListingService(dependencies).createAutoListingJob(input);
export const createExcelAutoListingJob = (dependencies, input) => createAutoListingService(dependencies).createExcelAutoListingJob(input);
export const getAutoListingJob = (dependencies, input) => createAutoListingService(dependencies).getAutoListingJob(input);
export const listAutoListingJobs = (dependencies, input) => createAutoListingService(dependencies).listAutoListingJobs(input);

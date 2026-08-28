import crypto from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  assertAutoListingTransition,
  nextAutoListingStatus,
  recoveryPointForRetryableFailure,
} from "./auto-listing-state-machine.mjs";
import {
  verifyAutoListingBlockedSourceEvidence,
  verifyAutoListingSourceSnapshot,
} from "./auto-listing-source-snapshot.mjs";
import { assertListingWarehouseEligible } from "./listing-warehouse-eligibility.mjs";
import { validateTargetStoreRecord } from "./listing-submission-policy.mjs";
import { resolveAiContentStrategy } from "./ai-content-strategy.mjs";
import { calculateAutoListingPrice } from "./auto-listing-pricing.mjs";
import {
  AUTO_LISTING_IMAGE_ROLES,
  normalizeAutoListingConfig,
  verifyAutoListingFrozenConfig,
} from "./auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "./auto-listing-item-image-config.mjs";
import { freezeAutoListingListingBase } from "./auto-listing-overlay.mjs";

const JOB_IDEMPOTENCY_CONSTRAINT = "auto_listing_jobs_account_id_idempotency_key_key";
const WAREHOUSE_EVIDENCE_KEYS = Object.freeze([
  "schemaVersion", "accountId", "storeId", "warehouseRecordId", "platformWarehouseId",
  "fulfillmentType", "status", "outcome", "observedAt", "expiresAt", "evidenceHash",
  "correlationId", "actorAccountId",
]);
const BLOCKED_SOURCE_FAILURE_CODES = new Set([
  "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED",
  "AUTO_LISTING_SOURCE_SKU_REQUIRED",
  "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB",
  "AUTO_LISTING_SOURCE_CURRENCY_UNSUPPORTED",
  "AUTO_LISTING_SOURCE_CURRENCY_MISMATCH",
]);
const SOURCE_SNAPSHOT_CONTRACT_VERSION = "AUTO_LISTING_SOURCE_SNAPSHOT_V2";
const CATEGORY_STRATEGY_MODES = new Set(["LEGACY_FALLBACK", "REQUIRE_EXACT_STRATEGY"]);
const EFFECTIVE_IMAGE_AUDIT_KEYS = new Set(["roles", "total", "reasonCodes"]);
const EFFECTIVE_IMAGE_ROLE_KEYS = new Set(AUTO_LISTING_IMAGE_ROLES);

function repositoryError(code, status = 422) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function requiredAccountId(value) {
  const accountId = typeof value === "string" ? value.trim() : "";
  if (!accountId) throw repositoryError("AUTO_LISTING_ACCOUNT_REQUIRED", 401);
  return accountId;
}

function requiredText(value, code = "AUTO_LISTING_REPOSITORY_INVALID") {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw repositoryError(code);
  return result;
}

function sourceSnapshotVersion(row = {}) {
  const payloadIdentity = row.payload_hash || row.raw_response_ref || "missing";
  const businessVersion = row.draft_id
    ? `draft:${row.draft_version}:${payloadIdentity}`
    : `raw:${payloadIdentity}`;
  return `${businessVersion}:${SOURCE_SNAPSHOT_CONTRACT_VERSION}`;
}

function categoryAuthorityFromRow(scope, row = {}) {
  const positive = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };
  const evidence = {
    id: typeof row.evidence_id === "string" ? row.evidence_id.trim() : "",
    accountId: typeof row.evidence_account_id === "string" ? row.evidence_account_id.trim() : "",
    sourceDescriptionCategoryId: positive(row.source_description_category_id),
    sourceTypeId: positive(row.source_type_id),
    taxonomyScope: typeof row.taxonomy_scope === "string" ? row.taxonomy_scope.trim() : "",
  };
  const shared = {
    id: typeof row.shared_category_id === "string" ? row.shared_category_id.trim() : "",
    accountId: typeof row.shared_category_account_id === "string" ? row.shared_category_account_id.trim() : "",
    version: positive(row.shared_category_version),
    evidenceId: typeof row.shared_category_evidence_id === "string" ? row.shared_category_evidence_id.trim() : "",
    status: row.shared_category_status,
    source: row.shared_category_source,
    sourceDescriptionCategoryId: evidence.sourceDescriptionCategoryId,
    sourceTypeId: evidence.sourceTypeId,
    currentDescriptionCategoryId: positive(row.current_description_category_id),
    currentTypeId: positive(row.current_type_id),
    taxonomyScope: evidence.taxonomyScope,
    taxonomyFingerprint: row.taxonomy_fingerprint,
  };
  if (!evidence.id || evidence.accountId !== scope || !evidence.sourceDescriptionCategoryId
    || !evidence.sourceTypeId || evidence.taxonomyScope !== "OZON:DEFAULT" || !shared.id || shared.accountId !== scope
    || !shared.version || !shared.evidenceId || shared.status !== "ACTIVE"
    || !["SOURCE_DIRECT", "OZON_REFRESH", "MANUAL"].includes(shared.source)
    || !shared.currentDescriptionCategoryId || !shared.currentTypeId
    || !(shared.taxonomyFingerprint === null
      || (typeof shared.taxonomyFingerprint === "string" && /^[0-9a-f]{64}$/u.test(shared.taxonomyFingerprint)))) {
    throw repositoryError("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", 409);
  }
  return { categoryEvidence: evidence, sharedCategory: shared };
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function plainJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closedRepositoryObject(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expectedKeys.size || keys.some((key) => typeof key !== "string"
    || !expectedKeys.has(key) || descriptors[key]?.enumerable !== true
    || !Object.hasOwn(descriptors[key], "value"))) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function closedRepositoryArray(value, maximum) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1 || descriptors.length?.value !== value.length) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    return descriptor.value;
  });
}

function effectiveImageAuditDetails(value) {
  const audit = closedRepositoryObject(value, EFFECTIVE_IMAGE_AUDIT_KEYS);
  const rawRoles = closedRepositoryObject(audit.roles, EFFECTIVE_IMAGE_ROLE_KEYS);
  let roles;
  let total;
  try {
    ({ image: { roles, total } } = normalizeAutoListingConfig({
      targetStoreId: "effective-image-audit",
      targetWarehouseId: "effective-image-audit",
      stock: 1,
      image: { roles: rawRoles, total: audit.total },
    }));
  } catch {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const reasonCodes = closedRepositoryArray(audit.reasonCodes, 1);
  if (reasonCodes.some((code) => code !== "PRODUCT_DIMENSIONS_UNAVAILABLE")
    || reasonCodes.length !== new Set(reasonCodes).size) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return Object.freeze({
    roles: Object.freeze(roles),
    total,
    reasonCodes: Object.freeze(reasonCodes),
  });
}

function exactCategoryStrategyScope(value) {
  const scope = closedRepositoryObject(value, new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]));
  if (scope.taxonomyScope !== "OZON:DEFAULT"
    || !Number.isSafeInteger(scope.descriptionCategoryId) || scope.descriptionCategoryId < 1
    || !Number.isSafeInteger(scope.typeId) || scope.typeId < 1) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return Object.freeze(scope);
}

function categoryStrategyGate(value) {
  if (value === undefined) return null;
  const gate = closedRepositoryObject(value, new Set(["mode", "policyVersion", "scopes"]));
  if (!CATEGORY_STRATEGY_MODES.has(gate.mode)
    || !Number.isSafeInteger(gate.policyVersion) || gate.policyVersion < 1) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const scopes = closedRepositoryArray(gate.scopes, 100).map((raw) => {
    const item = closedRepositoryObject(raw,
      new Set(["taxonomyScope", "descriptionCategoryId", "typeId", "ruleId"]));
    const ruleId = requiredText(item.ruleId);
    return Object.freeze({ ...exactCategoryStrategyScope({ taxonomyScope: item.taxonomyScope,
      descriptionCategoryId: item.descriptionCategoryId, typeId: item.typeId }), ruleId });
  });
  if ((gate.mode === "LEGACY_FALLBACK" && scopes.length !== 0)
    || (gate.mode === "REQUIRE_EXACT_STRATEGY" && scopes.length === 0)
    || new Set(scopes.map((scope) => `${scope.taxonomyScope}:${scope.descriptionCategoryId}:${scope.typeId}`)).size !== scopes.length) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return Object.freeze({ mode: gate.mode, policyVersion: gate.policyVersion, scopes: Object.freeze(scopes) });
}

function eventDetailsError() {
  return repositoryError("AUTO_LISTING_EVENT_DETAILS_INVALID");
}

function recoveryPointMismatchError() {
  return repositoryError("AUTO_LISTING_RECOVERY_POINT_MISMATCH");
}

function recoveryPointEvidenceError() {
  return repositoryError("AUTO_LISTING_RECOVERY_POINT_INVALID");
}

function transitionEventId(itemId, transitionVersion) {
  if (!Number.isInteger(transitionVersion) || transitionVersion < 1) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return `${itemId}_${String(transitionVersion + 1).padStart(2, "0")}`;
}

function recoveryPointFromLegacyFailure(event, row, accountId, { legacyNullVersion = false } = {}) {
  if (!plainJsonObject(event) || event.account_id !== accountId || event.job_id !== row.job_id
    || event.item_id !== row.id || event.event_type !== "RETRYABLE_FAILURE"
    || event.to_status !== "RETRYABLE_ERROR" || !plainJsonObject(event.details)
    || typeof row.failure_code !== "string" || !row.failure_code
    || (legacyNullVersion
      ? event.id !== transitionEventId(row.id, row.status_version) || event.transition_version !== null
      : event.transition_version !== row.status_version)
    || event.details.failureCode !== row.failure_code) {
    throw recoveryPointEvidenceError();
  }
  let recoveryPoint;
  try {
    recoveryPoint = recoveryPointForRetryableFailure(event.from_status);
  } catch {
    throw recoveryPointEvidenceError();
  }
  if (event.details.recoveryPoint !== recoveryPoint) throw recoveryPointEvidenceError();
  return recoveryPoint;
}

function safeEventDetails(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw eventDetailsError();
  const allowed = new Set(["failureCode", "recoveryPoint", "attempt"]);
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!allowed.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw eventDetailsError();
    if (key === "attempt") {
      if (!Number.isInteger(nested) || nested < 0 || nested > 1_000_000) throw eventDetailsError();
      output.attempt = nested;
    } else {
      if (typeof nested !== "string" || !/^[A-Z0-9_:-]{1,160}$/.test(nested)) throw eventDetailsError();
      output[key] = nested;
    }
  }
  return output;
}

async function loadWarehouseWithClient(client, { accountId, targetStoreId, targetWarehouseId }) {
  const warehouseResult = await client.query(
    `SELECT w.id,w.store_id,w.warehouse_id,w.name,w.warehouse_type,w.status,w.is_active,w.is_archived,
            s.owner_account_id
       FROM warehouses w JOIN stores s ON s.id=w.store_id
      WHERE w.id=$1 AND w.store_id=$2 AND s.owner_account_id=$3`,
    [targetWarehouseId, targetStoreId, accountId],
  );
  const row = warehouseResult.rows[0];
  if (!row) return { warehouse: null, products: [] };
  const associations = await client.query(
    `SELECT ps.source
       FROM product_stocks ps
       JOIN products p ON p.id=ps.product_id AND p.store_id=$2
       JOIN stores s ON s.id=p.store_id AND s.owner_account_id=$3
      WHERE ps.warehouse_id=$1 AND ps.store_id=$2
        AND COALESCE(p.status,'') <> 'ARCHIVED'
        AND COALESCE(p.raw->>'is_archived','false') <> 'true'`,
    [row.id, targetStoreId, accountId],
  );
  return {
    warehouse: { id: row.id, storeId: row.store_id, accountId: row.owner_account_id, warehouse_id: row.warehouse_id,
      name: row.name, warehouse_type: row.warehouse_type, status: row.status, is_active: row.is_active, is_archived: row.is_archived },
    products: associations.rows.map((association) => ({ accountId, storeId: targetStoreId,
      warehouse_stocks: [{ warehouse_id: row.warehouse_id, source: association.source }] })),
  };
}

async function lockTargetWarehouseEvidenceWithClient(client, {
  accountId, targetStoreId, targetWarehouseId, warehouseValidation = null,
}) {
  const storeResult = await client.query(
    `SELECT s.id,s.owner_account_id,s.label,s.company_name,s.client_id,s.currency_code,
            s.currency_source,s.currency_synced_at,s.status
       FROM stores s
      WHERE s.id=$1 AND s.owner_account_id=$2
      FOR SHARE OF s`,
    [targetStoreId, accountId],
  );
  const storeRow = storeResult.rows[0];
  const credentialResult = storeRow
    ? await client.query(
      `SELECT sc.store_id
         FROM store_credentials sc
         JOIN stores s ON s.id=sc.store_id AND s.owner_account_id=$2
        WHERE sc.store_id=$1
        FOR SHARE OF sc`,
      [storeRow.id, accountId],
    )
    : { rows: [] };
  const store = storeRow && {
    id: storeRow.id,
    ownerAccountId: storeRow.owner_account_id,
    label: storeRow.label,
    companyName: storeRow.company_name,
    clientId: storeRow.client_id,
    currencyCode: storeRow.currency_code,
    currencySource: storeRow.currency_source,
    currencySyncedAt: storeRow.currency_synced_at instanceof Date
      ? storeRow.currency_synced_at.toISOString() : storeRow.currency_synced_at,
    status: storeRow.status,
    credentialsSaved: credentialResult.rows.length > 0,
  };
  validateTargetStoreRecord({ accountId, targetStoreId, store });

  const warehouseResult = await client.query(
    `SELECT w.id,w.store_id,w.warehouse_id,w.name,w.warehouse_type,w.status,w.is_active,w.is_archived
       FROM warehouses w
       JOIN stores s ON s.id=w.store_id AND s.owner_account_id=$3
      WHERE w.id=$1 AND w.store_id=$2
      FOR SHARE OF w`,
    [targetWarehouseId, targetStoreId, accountId],
  );
  const warehouseRow = warehouseResult.rows[0];
  if (!warehouseRow) throw repositoryError("AUTO_LISTING_WAREHOUSE_NOT_FOUND", 404);
  const associationResult = await client.query(
    `SELECT p.id AS product_id,p.store_id AS product_store_id,p.status AS product_status,
            p.is_archived AS product_is_archived,
            COALESCE(p.raw->>'is_archived','false') = 'true' AS product_raw_is_archived,
            ps.warehouse_id,ps.source
       FROM product_stocks ps
       JOIN products p ON p.id=ps.product_id AND p.store_id=$2
       JOIN stores s ON s.id=p.store_id AND s.owner_account_id=$3
      WHERE ps.warehouse_id=$1 AND ps.store_id=$2
      ORDER BY p.id ASC,ps.source ASC
      FOR SHARE OF p,ps`,
    [warehouseRow.id, targetStoreId, accountId],
  );
  const productsById = new Map();
  for (const row of associationResult.rows) {
    const product = productsById.get(row.product_id) || {
      accountId,
      storeId: row.product_store_id,
      status: row.product_status,
      is_archived: row.product_is_archived === true || row.product_raw_is_archived === true,
      warehouse_stocks: [],
    };
    product.warehouse_stocks.push({ warehouse_id: warehouseRow.warehouse_id, source: row.source });
    productsById.set(row.product_id, product);
  }
  const warehouse = {
    id: warehouseRow.id,
    storeId: warehouseRow.store_id,
    accountId,
    warehouse_id: warehouseRow.warehouse_id,
    name: warehouseRow.name,
    warehouse_type: warehouseRow.warehouse_type,
    status: warehouseRow.status,
    is_active: warehouseRow.is_active,
    is_archived: warehouseRow.is_archived,
  };
  const platformWarehouseId = typeof warehouse.warehouse_id === "string" ? warehouse.warehouse_id.trim() : "";
  if (!platformWarehouseId || platformWarehouseId.toLowerCase().startsWith("wh_")) {
    const failure = repositoryError("LISTING_WAREHOUSE_NOT_ELIGIBLE", 422);
    failure.body = { reason: "WAREHOUSE_ID_MISSING" };
    throw failure;
  }
  assertListingWarehouseEligible({
    warehouse,
    products: [...productsById.values()],
    targetStoreId,
    accountId,
    validationEvidence: warehouseValidation,
  });
  return { warehouse, products: [...productsById.values()] };
}

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function eventDetails(item, categoryStrategyGate) {
  const targetCategory = item.snapshot?.targetCategory;
  return {
    sourceRecordId: item.sourceRecordId,
    sourceVersion: item.sourceVersion,
    sourceHash: item.snapshotHash,
    strategyId: item.strategyId,
    strategyVersionId: item.strategyVersionId,
    ruleId: item.ruleId,
    style: item.style,
    matchedBy: item.matchedBy,
    planningContract: item.planningContract,
    categoryStrategyMode: categoryStrategyGate?.mode || null,
    categoryStrategyScope: targetCategory ? {
      taxonomyScope: targetCategory.taxonomyScope,
      descriptionCategoryId: targetCategory.descriptionCategoryId,
      typeId: targetCategory.typeId,
    } : null,
    ...(item.effectiveImageConfig ? { effectiveImageConfig: effectiveImageAuditDetails({
      roles: item.effectiveImageConfig.roles,
      total: item.effectiveImageConfig.total,
      reasonCodes: item.effectiveImageConfig.reasonCodes,
    }) } : {}),
    ...(item.price ? { price: item.price } : {}),
    ...(item.failureCode ? { failureCode: item.failureCode } : {}),
  };
}

function itemWorkflowProgress(item) {
  const phase = typeof item.progress_phase === "string" ? item.progress_phase : "";
  if (!phase) return null;
  const attempts = Number(item.progress_attempts);
  let state = null;
  if (["RETRYABLE_ERROR", "BLOCKED"].includes(item.status) || item.progress_state === "DEAD") state = "FAILED";
  else if (item.progress_state === "PENDING") state = attempts > 0 ? "RETRY_WAIT" : "QUEUED";
  else if (["LEASED", "PROCESSING"].includes(item.progress_state)) state = "RUNNING";
  else if (["SUCCEEDED", "COMPLETED"].includes(item.progress_state)) state = "COMPLETED";
  if (!state) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  return {
    phase,
    state,
    attemptCount: Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : 0,
    updatedAt: item.progress_updated_at || null,
    nextRetryAt: state === "RETRY_WAIT" ? (item.progress_next_retry_at || null) : null,
  };
}

const EMPTY_AI_QUEUE_PROJECTION = Object.freeze({
  aiQueueState: null,
  aiChannelDisplayName: null,
  aiChannelSwitching: false,
  aiChannelWaitStartedAt: null,
});

function itemAiQueueProjection(item) {
  if (!["PLANNING", "GENERATING"].includes(item.status)) return EMPTY_AI_QUEUE_PROJECTION;
  const state = item.ai_queue_state;
  if (state === undefined || state === null) return EMPTY_AI_QUEUE_PROJECTION;
  if (!["WAITING_FOR_AI_CHANNEL", "CALLING_AI", "SWITCHING_AI_CHANNEL"].includes(state)) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const displayName = item.ai_channel_display_name === null
    ? null : typeof item.ai_channel_display_name === "string"
      && item.ai_channel_display_name.trim().length > 0
      && item.ai_channel_display_name.length <= 200
      && !/[\u0000-\u001f\u007f]/u.test(item.ai_channel_display_name)
      ? item.ai_channel_display_name : undefined;
  const switching = item.ai_channel_switching === true;
  const waitStartedAt = item.ai_channel_wait_started_at ?? null;
  const validWaitStartedAt = waitStartedAt instanceof Date
    ? Number.isFinite(waitStartedAt.getTime())
    : typeof waitStartedAt === "string" && Number.isFinite(Date.parse(waitStartedAt));
  if (displayName === undefined
    || switching !== (state === "SWITCHING_AI_CHANNEL")
    || (state === "CALLING_AI" && (displayName === null || waitStartedAt !== null))
    || (state !== "CALLING_AI" && !validWaitStartedAt)) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return Object.freeze({
    aiQueueState: state,
    aiChannelDisplayName: displayName,
    aiChannelSwitching: switching,
    aiChannelWaitStartedAt: state === "CALLING_AI" ? null : waitStartedAt,
  });
}

function mapJob(row, items, events) {
  const validatedEvents = events.map((event) => {
    if (event.event_type !== "SOURCE_CAPTURED") return event;
    if (!plainJsonObject(event.details)) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    if (!Object.hasOwn(event.details, "effectiveImageConfig")) return event;
    return {
      ...event,
      details: {
        ...event.details,
        effectiveImageConfig: effectiveImageAuditDetails(event.details.effectiveImageConfig),
      },
    };
  });
  const eventsByItem = new Map();
  for (const event of validatedEvents) {
    if (!event.item_id) continue;
    const list = eventsByItem.get(event.item_id) || [];
    list.push(event);
    eventsByItem.set(event.item_id, list);
  }
  return {
    id: row.id,
    accountId: row.account_id,
    sourceType: row.source_type,
    status: row.status,
    correlationId: row.correlation_id,
    warehouseValidationEvidenceId: row.warehouse_validation_evidence_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((item) => {
      const audit = (eventsByItem.get(item.id) || [])
        .find((event) => ["SOURCE_CAPTURED", "BLOCK"].includes(event.event_type))?.details || {};
      const workflowProgress = itemWorkflowProgress(item);
      const aiQueueProjection = itemAiQueueProjection(item);
      return {
        id: item.id,
        status: item.status,
        statusVersion: Number(item.status_version),
        recoveryPoint: item.recovery_point || null,
        activeContentPlanId: item.active_content_plan_id || null,
        planningContract: item.planning_contract,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        targetStoreId: item.target_store_id,
        targetWarehouseId: item.target_warehouse_id,
        sourceRecordId: item.source_record_id,
        sourceVersion: item.source_version,
        sourceHash: item.snapshot_hash,
        sourceOrder: Number.isSafeInteger(item.source_order) ? item.source_order : null,
        sourceThumbnailUrl: typeof item.source_thumbnail_url === "string" ? item.source_thumbnail_url : "",
        sourceTitle: typeof item.source_title === "string" ? item.source_title : "",
        sourceSku: typeof item.source_sku === "string" ? item.source_sku : "",
        strategyId: audit.strategyId || null,
        strategyVersionId: audit.strategyVersionId || row.strategy_version_id || null,
        ruleId: audit.ruleId || null,
        style: audit.style || null,
        matchedBy: audit.matchedBy || null,
        categoryStrategyMode: audit.categoryStrategyMode || null,
        categoryStrategyScope: audit.categoryStrategyScope || null,
        ...(audit.price ? { price: audit.price } : {}),
        ...(item.failure_code ? { failureCode: item.failure_code } : {}),
        ...(workflowProgress ? { workflowProgress } : {}),
        ...aiQueueProjection,
      };
    }),
    events: validatedEvents.map((event) => ({
      id: event.id,
      itemId: event.item_id,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      eventType: event.event_type,
      correlationId: event.correlation_id,
      details: event.details,
      createdAt: event.created_at,
    })),
  };
}

async function readJobWithClient(client, accountId, jobId, selectedItemIds = null) {
  const selection = Array.isArray(selectedItemIds)
    ? [...new Set(selectedItemIds.filter((id) => typeof id === "string" && id))]
    : null;
  if (Array.isArray(selectedItemIds) && selection.length !== selectedItemIds.length) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const jobResult = await client.query(
    `SELECT id,account_id,source_type,status,strategy_version_id,warehouse_validation_evidence_id,
            correlation_id,created_at,updated_at
       FROM auto_listing_jobs WHERE id=$1 AND account_id=$2`,
    [jobId, accountId],
  );
  const job = jobResult.rows[0];
  if (!job) return null;
  const itemResult = await client.query(
    `SELECT i.id,i.status,i.status_version,i.recovery_point,i.active_content_plan_id,i.planning_contract,
            i.target_store_id,i.target_warehouse_id,i.failure_code,i.created_at,i.updated_at,i.source_order,
            s.source_record_id,s.source_version,s.snapshot_hash,
            CASE WHEN jsonb_typeof(s.snapshot#>'{media,images,0}')='string'
                 THEN s.snapshot#>>'{media,images,0}' ELSE '' END AS source_thumbnail_url,
            COALESCE(s.snapshot#>>'{identity,primaryName}','') AS source_title,
            COALESCE(s.snapshot#>>'{identity,primarySku}','') AS source_sku,
            progress.phase AS progress_phase,progress.state AS progress_state,
            progress.attempts AS progress_attempts,progress.updated_at AS progress_updated_at,
            progress.next_retry_at AS progress_next_retry_at,
            ai_projection.queue_state AS ai_queue_state,
            ai_projection.channel_display_name AS ai_channel_display_name,
            COALESCE(ai_projection.channel_switching,FALSE) AS ai_channel_switching,
            ai_projection.wait_started_at AS ai_channel_wait_started_at
       FROM auto_listing_job_items i
       JOIN auto_listing_source_snapshots s ON s.id=i.snapshot_id AND s.account_id=$2
       LEFT JOIN LATERAL (
         SELECT progress.phase,progress.state,
                CASE WHEN progress.phase='PLAN_CONTENT' THEN GREATEST(
                  progress.attempts,
                  (SELECT COUNT(*)::INTEGER FROM auto_listing_content_plan_attempts planner_attempt
                    WHERE planner_attempt.account_id=$2 AND planner_attempt.job_id=$1
                      AND planner_attempt.item_id=i.id)
                ) ELSE progress.attempts END AS attempts,
                progress.updated_at,progress.next_retry_at
           FROM auto_listing_ai_outbox progress
          WHERE progress.account_id=$2 AND progress.job_id=$1 AND progress.item_id=i.id
            AND progress.contract_version='V1'
          ORDER BY progress.created_at DESC,progress.id DESC
          LIMIT 1
       ) progress ON TRUE
       LEFT JOIN LATERAL (
         SELECT CASE
                  WHEN assigned_channel.execution_lease_expires_at > NOW()
                    AND ai_queue.state='PROCESSING' AND ai_queue.lease_expires_at > NOW()
                    AND assigned_channel.execution_lease_owner=ai_queue.lease_owner
                    AND assigned_channel.execution_lease_token=ai_queue.lease_token
                    AND assigned_channel.execution_lease_expires_at=ai_queue.lease_expires_at
                    THEN 'CALLING_AI'
                  WHEN assigned_channel.channel_id IS NOT NULL THEN 'WAITING_FOR_AI_CHANNEL'
                  WHEN ai_queue.state='PENDING' AND ai_queue.last_error_code IN (
                    'AI_GATEWAY_NETWORK_FAILED','AI_GATEWAY_RATE_LIMITED','AI_GATEWAY_IDLE_TIMEOUT',
                    'AI_GATEWAY_UNEXPECTED_EOF','INVALID_GATEWAY_RESPONSE','RETRYABLE_GATEWAY',
                    'GATEWAY_TIMEOUT','AI_GATEWAY_UNAUTHORIZED','AI_GATEWAY_MODEL_NOT_FOUND',
                    'AI_GATEWAY_CAPABILITY_INVALID','NON_RETRYABLE_AUTH'
                  ) THEN 'SWITCHING_AI_CHANNEL'
                  WHEN available_channel.channel_id IS NULL THEN 'WAITING_FOR_AI_CHANNEL'
                  ELSE NULL
                END AS queue_state,
                CASE
                  WHEN assigned_channel.channel_id IS NOT NULL THEN assigned_channel.display_name
                  WHEN ai_queue.state='PENDING' AND ai_queue.last_error_code IN (
                    'AI_GATEWAY_NETWORK_FAILED','AI_GATEWAY_RATE_LIMITED','AI_GATEWAY_IDLE_TIMEOUT',
                    'AI_GATEWAY_UNEXPECTED_EOF','INVALID_GATEWAY_RESPONSE','RETRYABLE_GATEWAY',
                    'GATEWAY_TIMEOUT','AI_GATEWAY_UNAUTHORIZED','AI_GATEWAY_MODEL_NOT_FOUND',
                    'AI_GATEWAY_CAPABILITY_INVALID','NON_RETRYABLE_AUTH'
                  ) THEN failed_channel.display_name
                  ELSE NULL
                END AS channel_display_name,
                (assigned_channel.channel_id IS NULL AND ai_queue.state='PENDING'
                  AND ai_queue.last_error_code IN (
                    'AI_GATEWAY_NETWORK_FAILED','AI_GATEWAY_RATE_LIMITED','AI_GATEWAY_IDLE_TIMEOUT',
                    'AI_GATEWAY_UNEXPECTED_EOF','INVALID_GATEWAY_RESPONSE','RETRYABLE_GATEWAY',
                    'GATEWAY_TIMEOUT','AI_GATEWAY_UNAUTHORIZED','AI_GATEWAY_MODEL_NOT_FOUND',
                    'AI_GATEWAY_CAPABILITY_INVALID','NON_RETRYABLE_AUTH'
                  )) AS channel_switching,
                CASE
                  WHEN assigned_channel.execution_lease_expires_at > NOW()
                    AND ai_queue.state='PROCESSING' AND ai_queue.lease_expires_at > NOW()
                    AND assigned_channel.execution_lease_owner=ai_queue.lease_owner
                    AND assigned_channel.execution_lease_token=ai_queue.lease_token
                    AND assigned_channel.execution_lease_expires_at=ai_queue.lease_expires_at
                    THEN NULL
                  ELSE COALESCE(ai_queue.next_retry_at,ai_queue.available_at)
                END AS wait_started_at
           FROM auto_listing_ai_outbox AS ai_queue
           JOIN auto_listing_jobs AS ai_job
             ON ai_job.account_id=ai_queue.account_id AND ai_job.id=ai_queue.job_id
           LEFT JOIN LATERAL (
             SELECT assigned_channel.channel_id,assigned_channel.display_name,
                    assigned_channel.execution_lease_owner,assigned_channel.execution_lease_token,
                    assigned_channel.execution_lease_expires_at
               FROM auto_listing_ai_profile_channels AS assigned_channel
              WHERE assigned_channel.account_id=ai_queue.account_id
                AND assigned_channel.profile_id=ai_job.ai_profile_id
                AND assigned_channel.profile_version=ai_job.ai_profile_version
                AND assigned_channel.assigned_job_id=ai_queue.job_id
                AND assigned_channel.assigned_item_id=ai_queue.item_id
                AND assigned_channel.assigned_status_version=i.status_version
              ORDER BY assigned_channel.channel_order,assigned_channel.channel_id
              LIMIT 1
           ) assigned_channel ON TRUE
           LEFT JOIN LATERAL (
             SELECT available_channel.channel_id
               FROM auto_listing_ai_profile_channels AS available_channel
              WHERE available_channel.account_id=ai_queue.account_id
                AND available_channel.profile_id=ai_job.ai_profile_id
                AND available_channel.profile_version=ai_job.ai_profile_version
                AND available_channel.enabled IS TRUE
                AND available_channel.requires_revalidation IS FALSE
                AND (available_channel.cooldown_until IS NULL OR available_channel.cooldown_until<=NOW())
                AND available_channel.assigned_job_id IS NULL
              ORDER BY available_channel.channel_order,available_channel.channel_id
              LIMIT 1
           ) available_channel ON TRUE
           LEFT JOIN LATERAL (
             SELECT failed_channel.display_name
               FROM auto_listing_ai_profile_channels AS failed_channel
              WHERE failed_channel.account_id=ai_queue.account_id
                AND failed_channel.profile_id=ai_job.ai_profile_id
                AND failed_channel.profile_version=ai_job.ai_profile_version
                AND failed_channel.connection_id=i.last_ai_connection_id
                AND failed_channel.connection_version=i.last_ai_connection_version
              ORDER BY failed_channel.channel_order,failed_channel.channel_id
              LIMIT 1
           ) failed_channel ON TRUE
          WHERE ai_queue.account_id=$2 AND ai_queue.job_id=$1 AND ai_queue.item_id=i.id
            AND ai_queue.expected_status_version=i.status_version
            AND ai_queue.contract_version='V1'
            AND ai_queue.phase IN ('PLAN_CONTENT','MATERIALIZE_SOURCE_ASSET','FINALIZE_MATERIALIZED_PLAN',
                                   'GENERATE_IMAGE_SLOT','GENERATE_RICH_CONTENT')
            AND i.status IN ('PLANNING','GENERATING')
            AND ((ai_queue.state='PENDING' AND COALESCE(ai_queue.next_retry_at,ai_queue.available_at)<=NOW())
              OR ai_queue.state='PROCESSING')
            AND EXISTS (
              SELECT 1 FROM auto_listing_ai_profile_channels AS profile_channel
               WHERE profile_channel.account_id=ai_queue.account_id
                 AND profile_channel.profile_id=ai_job.ai_profile_id
                 AND profile_channel.profile_version=ai_job.ai_profile_version
            )
          ORDER BY ai_queue.created_at DESC,ai_queue.id DESC
          LIMIT 1
       ) ai_projection ON TRUE
      WHERE i.job_id=$1 AND i.account_id=$2
        ${selection ? "AND i.id=ANY($3::text[])" : ""}
      ORDER BY i.source_order ASC,i.id ASC`,
    selection ? [jobId, accountId, selection] : [jobId, accountId],
  );
  const eventResult = await client.query(
    `SELECT id,item_id,from_status,to_status,event_type,correlation_id,details,created_at
       FROM auto_listing_events
      WHERE job_id=$1 AND account_id=$2
        ${selection ? "AND (item_id IS NULL OR item_id=ANY($3::text[]))" : ""}
      ORDER BY created_at ASC,id ASC`,
    selection ? [jobId, accountId, selection] : [jobId, accountId],
  );
  return mapJob(job, itemResult.rows, eventResult.rows);
}

function canonicalWarehouseValidation(value, graph) {
  if (value === null || value === undefined) return null;
  if (!plainJsonObject(value)) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  const keys = Object.keys(value);
  if (keys.length !== WAREHOUSE_EVIDENCE_KEYS.length
    || keys.some((key) => !WAREHOUSE_EVIDENCE_KEYS.includes(key))) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const text = {};
  for (const key of WAREHOUSE_EVIDENCE_KEYS) {
    const candidate = value[key];
    if (typeof candidate !== "string" || candidate !== candidate.trim() || !candidate
      || candidate.length > 500 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    text[key] = candidate;
  }
  if (text.schemaVersion !== "AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1"
    || text.fulfillmentType !== "RFBS" || text.status !== "ACTIVE" || text.outcome !== "PASSED"
    || text.accountId !== graph.accountId || text.actorAccountId !== graph.actorAccountId
    || text.storeId !== graph.configSnapshot.targetStoreId
    || text.warehouseRecordId !== graph.configSnapshot.targetWarehouseId
    || text.correlationId !== graph.correlationId
    || !/^[a-f0-9]{64}$/.test(text.evidenceHash)
    || /^wh_/iu.test(text.platformWarehouseId)) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const observed = new Date(text.observedAt);
  const expires = new Date(text.expiresAt);
  if (!Number.isFinite(observed.getTime()) || !Number.isFinite(expires.getTime())
    || observed.toISOString() !== text.observedAt || expires.toISOString() !== text.expiresAt
    || expires.getTime() <= observed.getTime()) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const normalized = {
    schemaVersion: text.schemaVersion,
    accountId: text.accountId,
    storeId: text.storeId,
    warehouseRecordId: text.warehouseRecordId,
    platformWarehouseId: text.platformWarehouseId,
    fulfillmentType: text.fulfillmentType,
    status: text.status,
    outcome: text.outcome,
    observedAt: text.observedAt,
    expiresAt: text.expiresAt,
    correlationId: text.correlationId,
    actorAccountId: text.actorAccountId,
  };
  const expectedHash = crypto.createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
  if (text.evidenceHash !== expectedHash) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  return Object.freeze({ ...normalized, evidenceHash: text.evidenceHash });
}

function persistedWarehouseValidation(row) {
  if (!row) return null;
  const timestamp = (value) => value instanceof Date ? value.toISOString() : String(value);
  return {
    schemaVersion: row.schema_version,
    accountId: row.account_id,
    storeId: row.store_id,
    warehouseRecordId: row.warehouse_record_id,
    platformWarehouseId: row.platform_warehouse_id,
    fulfillmentType: row.fulfillment_type,
    status: row.status,
    outcome: row.outcome,
    observedAt: timestamp(row.observed_at),
    expiresAt: timestamp(row.expires_at),
    correlationId: row.correlation_id,
    actorAccountId: row.actor_account_id,
    evidenceHash: row.evidence_hash,
  };
}

async function assertReplayWarehouseBindingWithClient(client, graph, job) {
  const evidenceId = job?.warehouseValidationEvidenceId || null;
  if (!graph.warehouseValidation) {
    if (evidenceId !== null) throw repositoryError("AUTO_LISTING_WAREHOUSE_EVIDENCE_CONFLICT", 409);
    return;
  }
  if (!evidenceId) throw repositoryError("AUTO_LISTING_WAREHOUSE_EVIDENCE_CONFLICT", 409);
  const result = await client.query(
    `SELECT id,account_id,store_id,warehouse_record_id,platform_warehouse_id,schema_version,
            fulfillment_type,status,outcome,observed_at,expires_at,evidence_hash,correlation_id,
            actor_account_id,raw_response_ref
       FROM auto_listing_rfbs_warehouse_evidence
      WHERE account_id=$1 AND id=$2`,
    [graph.accountId, evidenceId],
  );
  const row = result.rows[0];
  if (!row || row.raw_response_ref !== null
    || !sameJson(persistedWarehouseValidation(row), graph.warehouseValidation)) {
    throw repositoryError("AUTO_LISTING_WAREHOUSE_EVIDENCE_CONFLICT", 409);
  }
}

function assertGraph(graph) {
  if (!graph || typeof graph !== "object") throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  const accountId = requiredAccountId(graph.accountId);
  const idempotencyKey = requiredText(graph.idempotencyKey);
  const categoryPreparationLeaseId = requiredText(graph.categoryPreparationLeaseId);
  if (graph.categoryPreparationSignal !== undefined
    && !(graph.categoryPreparationSignal instanceof AbortSignal)) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  if (!["COLLECT_BOX", "EXCEL_SKU"].includes(graph.sourceType)
    || requiredText(graph.actorAccountId) !== accountId || !requiredText(graph.strategyVersionId)
    || !requiredText(graph.uploadPolicyVersionId)
    || !Array.isArray(graph.items) || !graph.items.length) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  let frozenConfig;
  try {
    frozenConfig = verifyAutoListingFrozenConfig(graph.configSnapshot, graph.configHash);
  } catch {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const { config: configSnapshot, configHash } = frozenConfig;
  const warehouseValidation = canonicalWarehouseValidation(graph.warehouseValidation, {
    ...graph, accountId, configSnapshot,
  });
  const items = graph.items.map((item) => {
    const collectItemId = graph.sourceType === "EXCEL_SKU"
      ? requiredText(item?.collectItemId) : requiredText(item?.sourceRecordId);
    if (!item || typeof item !== "object" || item.sourceType !== graph.sourceType
      || !requiredText(item.sourceRecordId) || !requiredText(item.sourceVersion)
      || !requiredText(item.targetStoreId) || !requiredText(item.targetWarehouseId)
      || !Number.isInteger(item.sourceOrder) || item.sourceOrder < 1
      || !["SOURCE_READY", "BLOCKED"].includes(item.status)) {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    if (!["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(item.planningContract)) {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    if (item.targetStoreId !== configSnapshot.targetStoreId || item.targetWarehouseId !== configSnapshot.targetWarehouseId) {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    const sourceBusinessBlocked = item.status === "BLOCKED" && BLOCKED_SOURCE_FAILURE_CODES.has(item.failureCode);
    if (sourceBusinessBlocked) {
      if (Object.hasOwn(item, "snapshot") || !Object.hasOwn(item, "blockedEvidence")
        || ["strategyId", "strategyVersionId", "ruleId", "style", "matchedBy", "price", "effectiveImageConfig", "listingBaseTemplate"].some((key) => Object.hasOwn(item, key))) {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      let captured;
      try { captured = verifyAutoListingBlockedSourceEvidence(item); } catch { throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID"); }
      if (captured.blockedEvidence.accountId !== accountId
        || captured.blockedEvidence.sourceRecordId !== item.sourceRecordId
        || captured.blockedEvidence.sourceVersion !== item.sourceVersion
        || captured.blockedEvidence.sourceType !== item.sourceType
        || captured.blockedEvidence.failureCode !== item.failureCode) {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      return { ...item, collectItemId, ...captured };
    }
    if (Object.hasOwn(item, "blockedEvidence")) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    let captured;
    try { captured = verifyAutoListingSourceSnapshot(item); } catch { throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID"); }
    if (captured.snapshot.identity.accountId !== accountId
      || captured.snapshot.identity.sourceRecordId !== item.sourceRecordId
      || captured.snapshot.identity.sourceVersion !== item.sourceVersion
      || captured.snapshot.identity.sourceType !== item.sourceType
      || captured.rawResponseRef !== captured.snapshot.rawEvidence.rawResponseRef
      || captured.snapshot.targetCategory.schemaVersion !== "AUTO_LISTING_ACCOUNT_CATEGORY_V2") {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    let effectiveImageConfig;
    try {
      effectiveImageConfig = deriveEffectiveAutoListingImageConfig({ configSnapshot, configHash, sourceCapture: captured });
    } catch {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    if (!plainJsonObject(item.effectiveImageConfig) || !sameJson(item.effectiveImageConfig, effectiveImageConfig)) {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    if (item.status === "SOURCE_READY") {
      if (item.failureCode || item.strategyVersionId !== graph.strategyVersionId || !requiredText(item.strategyId)
        || !(item.ruleId === null || requiredText(item.ruleId))
        || !["VISUAL_FIRST", "PARAMETER_FIRST", "DEMONSTRATION_FIRST", "SPECIFICATION_FIRST", "BALANCED_DEFAULT"].includes(item.style)
        || !["EXACT_CATEGORY_TYPE_V2", "EXACT_CATEGORY", "ANCESTOR_CATEGORY", "PRODUCT_STYLE", "DEFAULT"].includes(item.matchedBy)
        || !plainJsonObject(item.price)) {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      let calculated;
      try {
        calculated = calculateAutoListingPrice({ ...captured.snapshot.priceEvidence,
          adjustmentKopecks: configSnapshot.priceAdjustmentKopecks,
          priceMultiplierMicros: configSnapshot.priceMultiplierMicros });
      } catch {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      if (!samePrice(item.price, calculated)) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      const listingBaseTemplate = verifiedListingBaseTemplate({
        accountId,
        collectItemId,
        targetStoreId: item.targetStoreId,
        snapshotId: "preflight-snapshot",
        item: { ...item, snapshot: captured.snapshot },
      });
      return { ...item, collectItemId, ...captured, price: calculated, effectiveImageConfig, listingBaseTemplate };
    } else if (!/^AUTO_LISTING_[A-Z0-9_]+$|^PRICE_[A-Z0-9_]+$/.test(requiredText(item.failureCode))) {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    if (Object.hasOwn(item, "listingBaseTemplate")) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    return { ...item, collectItemId, ...captured, effectiveImageConfig };
  });
  if (new Set(items.map((item) => item.sourceOrder)).size !== items.length
    || items.some((item, index) => item.sourceOrder !== index + 1)) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return { ...graph, accountId, idempotencyKey, categoryPreparationLeaseId,
    configSnapshot, configHash, warehouseValidation, categoryStrategyGate: categoryStrategyGate(graph.categoryStrategyGate), items };
}

function sourceVersionConflict() {
  return repositoryError("AUTO_LISTING_SOURCE_VERSION_CONFLICT", 409);
}

function verifyPersistedSourceEvidence(item, persistedSnapshot) {
  const snapshotId = typeof persistedSnapshot?.id === "string" ? persistedSnapshot.id.trim() : "";
  if (!snapshotId) throw sourceVersionConflict();
  try {
    if (Object.hasOwn(item, "blockedEvidence")) {
      const persisted = verifyAutoListingBlockedSourceEvidence({
        blockedEvidence: persistedSnapshot.snapshot,
        snapshotHash: persistedSnapshot.snapshot_hash,
        rawResponseRef: persistedSnapshot.raw_response_ref,
      });
      if (persisted.snapshotHash !== item.snapshotHash || persisted.rawResponseRef !== item.rawResponseRef
        || !sameJson(persisted.blockedEvidence, item.blockedEvidence)) {
        throw sourceVersionConflict();
      }
    } else {
      const persisted = verifyAutoListingSourceSnapshot({
        snapshot: persistedSnapshot.snapshot,
        snapshotHash: persistedSnapshot.snapshot_hash,
        rawResponseRef: persistedSnapshot.raw_response_ref,
      });
      if (persisted.snapshotHash !== item.snapshotHash || persisted.rawResponseRef !== item.rawResponseRef
        || !sameJson(persisted.snapshot, item.snapshot)) {
        throw sourceVersionConflict();
      }
    }
  } catch (caught) {
    if (caught?.code === "AUTO_LISTING_SOURCE_VERSION_CONFLICT") throw caught;
    throw sourceVersionConflict();
  }
  return snapshotId;
}

function sameJson(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function samePrice(left, right) {
  if (!plainJsonObject(left) || !plainJsonObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])) return true;
  const legacyKeys = rightKeys.filter((key) => !["preMultiplierPriceKopecks", "priceMultiplierMicros"].includes(key));
  return right.priceMultiplierMicros === "1000000" && leftKeys.length === legacyKeys.length
    && leftKeys.every((key, index) => key === legacyKeys[index] && left[key] === right[key]);
}

function exactCategoryAuthorizationItem(value) {
  const keys = ["collectItemId", "evidenceId", "sharedCategoryId", "sharedCategoryVersion",
    "sourceDescriptionCategoryId", "sourceTypeId", "descriptionCategoryId", "typeId",
    "taxonomyScope", "taxonomyFingerprint", "provenance"];
  const positive = (nested) => Number.isSafeInteger(nested) && nested > 0;
  if (!plainJsonObject(value) || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key)) || !requiredText(value.collectItemId)
    || !requiredText(value.evidenceId) || !requiredText(value.sharedCategoryId)
    || !positive(value.sharedCategoryVersion)
    || !positive(value.sourceDescriptionCategoryId) || !positive(value.sourceTypeId)
    || !positive(value.descriptionCategoryId) || !positive(value.typeId)
    || value.taxonomyScope !== "OZON:DEFAULT"
    || !(value.taxonomyFingerprint === ""
      || (typeof value.taxonomyFingerprint === "string" && /^[0-9a-f]{64}$/u.test(value.taxonomyFingerprint)))
    || !["SOURCE_DIRECT", "OZON_REFRESH", "MANUAL"].includes(value.provenance)) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return { ...value, collectItemId: requiredText(value.collectItemId) };
}

const LISTING_BASE_TEMPLATE_KEYS = new Set([
  "productDraft", "pricingEvidence", "richContentAttributeSupported", "variants", "versions",
]);

function verifiedListingBaseTemplate({ accountId, collectItemId, targetStoreId, snapshotId, item }) {
  const template = item?.listingBaseTemplate;
  if (!plainJsonObject(template) || Object.keys(template).length !== LISTING_BASE_TEMPLATE_KEYS.size
    || Object.keys(template).some((key) => !LISTING_BASE_TEMPLATE_KEYS.has(key))) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  let frozen;
  try {
    frozen = freezeAutoListingListingBase({
      accountId,
      jobId: "preflight-job",
      itemId: "preflight-item",
      sourceSnapshotId: snapshotId,
      collectItemId,
      targetStoreId,
      ...template,
    });
  } catch {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const frozenVariantPrices = frozen.variants.every((variant) => Object.hasOwn(variant, "pricingEvidence"));
  const snapshotVariants = new Map(item.snapshot.variants.map((variant) => [variant.sku, variant]));
  const variantPricesMatchSnapshot = !frozenVariantPrices || (
    snapshotVariants.size === frozen.variants.length
    && frozen.variants.every((variant) => {
      const sourceVariant = snapshotVariants.get(variant.sourceSku);
      const sourcePrice = sourceVariant?.priceEvidence;
      return sourcePrice
        && variant.pricingEvidence.currency === sourcePrice.currency
        && variant.pricingEvidence.currencySource === sourcePrice.currencySource
        && variant.pricingEvidence.blackKopecks === String(sourcePrice.blackKopecks)
        && variant.pricingEvidence.greenKopecks === (
          sourcePrice.greenKopecks === null ? null : String(sourcePrice.greenKopecks)
        );
    })
  );
  if (frozen.productDraft.id !== item.snapshot.source.productDraftId
    || frozen.productDraft.version !== item.snapshot.source.productDraftVersion
    || frozen.pricingEvidence.currency !== item.snapshot.priceEvidence.currency
    || frozen.pricingEvidence.currencySource !== item.snapshot.priceEvidence.currencySource
    || frozen.pricingEvidence.blackKopecks !== item.snapshot.priceEvidence.blackKopecks
    || frozen.pricingEvidence.greenKopecks !== (item.snapshot.priceEvidence.greenKopecks || null)
    || !variantPricesMatchSnapshot
    || frozen.variants.some((variant) =>
      Number(variant.item?.description_category_id) !== Number(item.snapshot.targetCategory.descriptionCategoryId)
      || Number(variant.item?.type_id) !== Number(item.snapshot.targetCategory.typeId))) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return {
    productDraft: frozen.productDraft,
    pricingEvidence: frozen.pricingEvidence,
    richContentAttributeSupported: frozen.richContentAttributeSupported,
    variants: frozen.variants,
    versions: frozen.versions,
  };
}

function publishedRules(rows) {
  return rows.map((row) => {
    const stored = plainJsonObject(row.rule) ? row.rule : {};
    if (stored.matchType === "EXACT_CATEGORY_TYPE_V2") {
      return { ...stored, ruleId: stored.ruleId || row.id, ruleOrder: Number(row.rule_order) };
    }
    const mapped = {
      ruleId: stored.ruleId || row.id, ruleOrder: Number(row.rule_order), matchType: row.rule_kind,
      categoryId: row.rule_kind === "ANCESTOR_CATEGORY" ? row.ancestor_category_id : row.category_id,
      productStyle: row.product_style, style: stored.style, textDensityByRole: stored.textDensityByRole,
    };
    if (row.rule_kind === "EXACT_CATEGORY" && plainJsonObject(stored.exactScope)) {
      mapped.exactScope = stored.exactScope;
    }
    return mapped;
  });
}

function sameExactScope(left, right) {
  return plainJsonObject(left) && left.taxonomyScope === right.taxonomyScope
    && Number(left.descriptionCategoryId) === right.descriptionCategoryId
    && Number(left.typeId) === right.typeId;
}

function assertCurrentCategoryStrategyGate(graph, setting, rules, strategy) {
  const gate = graph.categoryStrategyGate;
  if (!gate) return;
  const mode = setting?.mode || "LEGACY_FALLBACK";
  const version = Number(setting?.version || 1);
  if (mode !== gate.mode || version !== gate.policyVersion) {
    throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_CHANGED", 409);
  }
  if (gate.mode === "LEGACY_FALLBACK") return;
  for (const scope of gate.scopes) {
    let resolved;
    try {
      resolved = resolveAiContentStrategy({
        strategyVersion: { strategyId: strategy.strategy_key, strategyVersionId: graph.strategyVersionId },
        rules,
        product: { taxonomyScope: scope.taxonomyScope,
          descriptionCategoryId: String(scope.descriptionCategoryId), typeId: String(scope.typeId),
          categoryAncestors: [], productStyle: "UNKNOWN" },
      });
    } catch {
      throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_CHANGED", 409);
    }
    const selected = rules.find((rule) => rule.ruleId === resolved.ruleId);
    const exact = resolved.matchedBy === "EXACT_CATEGORY_TYPE_V2"
      || (resolved.matchedBy === "EXACT_CATEGORY" && sameExactScope(selected?.exactScope, scope));
    if (!exact || resolved.ruleId !== scope.ruleId) {
      throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_CHANGED", 409);
    }
  }
}

function validInitialAiStageOutcome(value) {
  try {
    if (!plainJsonObject(value)) return false;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.length === 2
      && keys.every((key) => typeof key === "string" && ["status", "statusVersion"].includes(key))
      && ["status", "statusVersion"].every((key) => descriptors[key]?.enumerable === true
        && Object.hasOwn(descriptors[key], "value"))
      && descriptors.status.value === "PLANNING"
      && descriptors.statusVersion.value === 2;
  } catch {
    return false;
  }
}

export function createAutoListingRepository({
  pool,
  idFactory = defaultIdFactory,
  now = () => new Date(),
  stageInitialPlanWork = null,
  categoryLeaseWaitTimeoutMs = 5_000,
  categoryLeaseHoldTimeoutMs = 600_000,
} = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("PostgreSQL pool is required for auto listing repository");
  }
  if (typeof now !== "function") throw new TypeError("Auto listing repository clock must be a function");
  if (stageInitialPlanWork !== null && typeof stageInitialPlanWork !== "function") {
    throw new TypeError("Auto listing initial AI workflow port must be a function or null");
  }
  if (!Number.isInteger(categoryLeaseWaitTimeoutMs) || categoryLeaseWaitTimeoutMs < 10
    || categoryLeaseWaitTimeoutMs > 30_000
    || !Number.isInteger(categoryLeaseHoldTimeoutMs) || categoryLeaseHoldTimeoutMs < 1_000
    || categoryLeaseHoldTimeoutMs > 900_000) {
    throw new TypeError("Auto listing category lease timeouts are invalid");
  }
  const newId = (prefix) => requiredText(idFactory(prefix), "AUTO_LISTING_REPOSITORY_INVALID");
  const activeCategoryLeases = new Map();
  const categoryLeaseMapKey = (accountId, leaseId) => `${accountId}\u001f${leaseId}`;

  async function connectForCategoryLease() {
    let timer;
    let timedOut = false;
    const pending = Promise.resolve().then(() => pool.connect());
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(repositoryError("AUTO_LISTING_CATEGORY_LEASE_TIMEOUT", 503));
      }, categoryLeaseWaitTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
      if (timedOut) pending.then((client) => client.release()).catch(() => {});
    }
  }

  function expireCategoryLease(accountId, leaseId) {
    const held = activeCategoryLeases.get(categoryLeaseMapKey(accountId, leaseId));
    if (!held) return;
    const failure = repositoryError("AUTO_LISTING_CATEGORY_LEASE_EXPIRED", 409);
    held.expired = true;
    held.controller.abort(failure);
  }

  function assertCategoryPreparationSignal(graph) {
    if (!graph.categoryPreparationSignal?.aborted) return;
    const reason = graph.categoryPreparationSignal.reason;
    if (reason && typeof reason === "object" && typeof reason.code === "string") throw reason;
    throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE", 503);
  }

  async function lockCategoryGraphHandoffWithClient(client, graph) {
    assertCategoryPreparationSignal(graph);
    const sharedCategoryIds = [...new Set(graph.items
      .filter((item) => Object.hasOwn(item, "snapshot"))
      .map((item) => requiredText(item.snapshot.targetCategory.sharedCategoryId)))];
    if (!sharedCategoryIds.length) return;
    const keys = await client.query(
      `/* auto-listing-category-graph-lock-keys */
       SELECT input.shared_category_id,
              account_ozon_shared_category_lease_key($1,input.shared_category_id)::text AS lock_key
         FROM unnest($2::text[]) AS input(shared_category_id)`,
      [graph.accountId, sharedCategoryIds],
    );
    if (keys.rows.length !== sharedCategoryIds.length
      || new Set(keys.rows.map((row) => row.shared_category_id)).size !== sharedCategoryIds.length) {
      throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE", 503);
    }
    const lockKeys = keys.rows.map((row) => requiredText(row.lock_key))
      .sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
    for (const lockKey of lockKeys) {
      const taken = await client.query(
        "SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked",
        [lockKey],
      );
      if (taken.rows[0]?.locked !== true) {
        throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE", 503);
      }
      assertCategoryPreparationSignal(graph);
    }
  }

  async function assertCategoryGraphLeaseActiveWithClient(client, graph) {
    assertCategoryPreparationSignal(graph);
    const result = await client.query(
      `/* auto-listing-category-graph-lease-active */ SELECT lease.id
         FROM auto_listing_category_preparation_leases lease
         JOIN pg_stat_activity activity
           ON activity.pid=lease.holder_backend_pid
          AND activity.datname=current_database()
          AND activity.backend_start=lease.holder_backend_started_at
        WHERE lease.account_id=$1 AND lease.id=$2 AND lease.state='ACTIVE'
          AND lease.finalized_job_id IS NULL AND lease.expires_at>clock_timestamp()`,
      [graph.accountId, graph.categoryPreparationLeaseId],
    );
    if (result.rows.length !== 1) {
      throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE", 503);
    }
    assertCategoryPreparationSignal(graph);
  }

  const loadExcelImportContext = async ({ accountId, importFileId } = {}) => {
    const scope = requiredAccountId(accountId);
    const fileId = requiredText(importFileId);
    const result = await pool.query(
      `SELECT id,account_id,status,status_version,accepted_rows,ready_rows,failed_rows,
              config_snapshot,config_hash,idempotency_key,correlation_id
         FROM auto_listing_import_files
        WHERE account_id=$1 AND id=$2`,
      [scope, fileId],
    );
    const file = result.rows?.[0];
    if (!file) return null;
    if (file.account_id !== scope || file.id !== fileId) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    return {
      id: file.id, accountId: file.account_id, status: file.status,
      statusVersion: Number(file.status_version), acceptedRows: Number(file.accepted_rows),
      readyRows: Number(file.ready_rows), failedRows: Number(file.failed_rows),
      configSnapshot: file.config_snapshot, configHash: file.config_hash,
      idempotencyKey: file.idempotency_key, correlationId: file.correlation_id,
    };
  };

  return {
    loadExcelImportContext,
    async loadCollectSources({ accountId, collectItemIds } = {}) {
      const scope = requiredAccountId(accountId);
      const ids = Array.isArray(collectItemIds) ? [...new Set(collectItemIds.map((id) => requiredText(id)))] : [];
      if (!ids.length) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      const result = await pool.query(
        `SELECT c.id,c.account_id,c.source,c.source_sku,c.summary,
                d.id AS draft_id,d.version AS draft_version,d.data_hash AS draft_data_hash,d.data AS draft_data,
                d.normalizer_version,d.category_rule_version,d.dictionary_version,
                raw.id AS raw_response_ref,raw.payload AS raw_payload,raw.payload_hash,raw.collected_at,
                evidence.id AS evidence_id,evidence.account_id AS evidence_account_id,
                evidence.source_description_category_id,evidence.source_type_id,evidence.taxonomy_scope,
                shared.id AS shared_category_id,shared.account_id AS shared_category_account_id,
                shared.version AS shared_category_version,shared.source_evidence_id AS shared_category_evidence_id,
                shared.status AS shared_category_status,shared.source AS shared_category_source,
                shared.current_description_category_id,shared.current_type_id,shared.taxonomy_fingerprint
           FROM collect_items c
           LEFT JOIN product_drafts d ON d.id=c.current_draft_id AND d.collect_item_id=c.id
           LEFT JOIN LATERAL (
             SELECT id,payload,payload_hash,collected_at FROM collect_raw_payloads
              WHERE collect_item_id=c.id AND account_id=c.account_id
                AND ((d.id IS NOT NULL AND id=d.source_payload_id) OR d.id IS NULL)
              ORDER BY created_at DESC,id DESC LIMIT 1
           ) raw ON TRUE
           JOIN collect_ozon_category_current_sources current_category
             ON current_category.account_id=c.account_id AND current_category.collect_item_id=c.id
           JOIN collect_ozon_category_source_evidence evidence
             ON evidence.account_id=current_category.account_id
            AND evidence.id=current_category.source_evidence_id
            AND evidence.collect_item_id=current_category.collect_item_id
            AND evidence.source_kind=current_category.source_kind
            AND evidence.source_record_id=current_category.source_record_id
            AND evidence.source_version=current_category.source_version
           JOIN account_ozon_shared_categories shared
             ON shared.account_id=c.account_id
            AND shared.source_description_category_id=evidence.source_description_category_id
            AND shared.source_type_id=evidence.source_type_id
            AND shared.taxonomy_scope=evidence.taxonomy_scope
            AND shared.status='ACTIVE'
          WHERE c.account_id=$1 AND c.id=ANY($2::text[]) AND c.deleted_at IS NULL
          ORDER BY array_position($2::text[],c.id)`,
        [scope, ids],
      );
      return result.rows.map((row) => {
        const categoryAuthority = categoryAuthorityFromRow(scope, row);
        const rawNormalized = row.raw_payload?.normalized && typeof row.raw_payload.normalized === "object"
          ? row.raw_payload.normalized : {};
        return {
          id: row.id,
          accountId: row.account_id,
          sourceVersion: sourceSnapshotVersion(row),
          rawResponseRef: row.raw_response_ref || null,
          rawResponseHash: row.payload_hash || null,
          rawCollectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : null,
          ...categoryAuthority,
          collectItem: {
            ...rawNormalized,
            id: row.id,
            accountId: row.account_id,
            source: row.source,
            sourceSku: row.source_sku,
            summary: row.summary,
            listingDraft: row.draft_data || rawNormalized.listingDraft || {},
          },
          productDraft: row.draft_id ? {
            id: row.draft_id,
            version: Number(row.draft_version || 1),
            dataHash: row.draft_data_hash,
            normalizerVersion: row.normalizer_version,
            categoryRuleVersion: row.category_rule_version,
            dictionaryVersion: row.dictionary_version,
          } : null,
        };
      });
    },

    async loadExcelImportSources({ accountId, importFileId } = {}) {
      const scope = requiredAccountId(accountId);
      const fileId = requiredText(importFileId);
      const file = await loadExcelImportContext({ accountId: scope, importFileId: fileId });
      if (!file) return null;
      const sourceResult = await pool.query(
        `SELECT r.id AS row_id,r.collect_item_id,c.account_id,c.source,c.source_sku,c.summary,
                d.id AS draft_id,d.version AS draft_version,d.data_hash AS draft_data_hash,d.data AS draft_data,
                d.normalizer_version,d.category_rule_version,d.dictionary_version,
                raw.id AS raw_response_ref,raw.payload AS raw_payload,raw.payload_hash,raw.collected_at,
                evidence.id AS evidence_id,evidence.account_id AS evidence_account_id,
                evidence.source_description_category_id,evidence.source_type_id,evidence.taxonomy_scope,
                shared.id AS shared_category_id,shared.account_id AS shared_category_account_id,
                shared.version AS shared_category_version,shared.source_evidence_id AS shared_category_evidence_id,
                shared.status AS shared_category_status,shared.source AS shared_category_source,
                shared.current_description_category_id,shared.current_type_id,shared.taxonomy_fingerprint
           FROM auto_listing_import_rows r
           JOIN collect_items c
             ON c.id=r.collect_item_id AND c.account_id=r.account_id AND c.deleted_at IS NULL
           LEFT JOIN product_drafts d ON d.id=c.current_draft_id AND d.collect_item_id=c.id
           LEFT JOIN LATERAL (
             SELECT id,payload,payload_hash,collected_at FROM collect_raw_payloads
              WHERE collect_item_id=c.id AND account_id=c.account_id
                AND ((d.id IS NOT NULL AND id=d.source_payload_id) OR d.id IS NULL)
              ORDER BY created_at DESC,id DESC LIMIT 1
           ) raw ON TRUE
           JOIN collect_ozon_category_current_sources current_category
             ON current_category.account_id=c.account_id AND current_category.collect_item_id=c.id
           JOIN collect_ozon_category_source_evidence evidence
             ON evidence.account_id=current_category.account_id
            AND evidence.id=current_category.source_evidence_id
            AND evidence.collect_item_id=current_category.collect_item_id
            AND evidence.source_kind=current_category.source_kind
            AND evidence.source_record_id=current_category.source_record_id
            AND evidence.source_version=current_category.source_version
           JOIN account_ozon_shared_categories shared
             ON shared.account_id=c.account_id
            AND shared.source_description_category_id=evidence.source_description_category_id
            AND shared.source_type_id=evidence.source_type_id
            AND shared.taxonomy_scope=evidence.taxonomy_scope
            AND shared.status='ACTIVE'
          WHERE r.account_id=$1 AND r.import_file_id=$2 AND r.status='READY'
          ORDER BY r.row_number,r.id`,
        [scope, fileId],
      );
      const sources = sourceResult.rows.map((row) => {
        if (row.account_id !== scope) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
        const categoryAuthority = categoryAuthorityFromRow(scope, row);
        const rawNormalized = row.raw_payload?.normalized && typeof row.raw_payload.normalized === "object"
          ? row.raw_payload.normalized : {};
        return {
          id: row.row_id,
          collectItemId: row.collect_item_id,
          accountId: row.account_id,
          sourceVersion: sourceSnapshotVersion(row),
          rawResponseRef: row.raw_response_ref || null,
          rawResponseHash: row.payload_hash || null,
          rawCollectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : null,
          ...categoryAuthority,
          collectItem: {
            ...rawNormalized,
            id: row.collect_item_id,
            accountId: row.account_id,
            source: row.source,
            sourceSku: row.source_sku,
            summary: row.summary,
            listingDraft: row.draft_data || rawNormalized.listingDraft || {},
          },
          productDraft: row.draft_id ? {
            id: row.draft_id,
            version: Number(row.draft_version || 1),
            dataHash: row.draft_data_hash,
            normalizerVersion: row.normalizer_version,
            categoryRuleVersion: row.category_rule_version,
            dictionaryVersion: row.dictionary_version,
          } : null,
        };
      });
      return {
        importFile: {
          ...file,
        },
        sources,
      };
    },

    async acquireCategoryPreparationLease({ accountId, items } = {}) {
      const scope = requiredAccountId(accountId);
      const checked = Array.isArray(items) && items.length >= 1 && items.length <= 100
        ? items.map(exactCategoryAuthorizationItem) : [];
      if (!checked.length) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      const byCollectItem = new Map();
      for (const item of checked) {
        if (byCollectItem.has(item.collectItemId)) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
        byCollectItem.set(item.collectItemId, item);
      }
      const client = await connectForCategoryLease();
      let backendPid = 0;
      let leaseId = "";
      const controller = new AbortController();
      const onClientError = (caught) => {
        if (!leaseId) return;
        const mapKey = categoryLeaseMapKey(scope, leaseId);
        const held = activeCategoryLeases.get(mapKey);
        if (held?.client !== client) return;
        activeCategoryLeases.delete(mapKey);
        clearTimeout(held.timer);
        controller.abort(repositoryError("AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE", 503));
        try { client.release(caught || repositoryError("AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE", 503)); } catch {}
      };
      client.on?.("error", onClientError);
      try {
        const backend = (await client.query(
          `SELECT activity.pid::int AS pid,activity.backend_start::text AS backend_started_at
             FROM pg_stat_activity activity
            WHERE activity.pid=pg_backend_pid() AND activity.datname=current_database()`,
        )).rows[0];
        backendPid = Number(backend?.pid);
        if (!Number.isSafeInteger(backendPid) || backendPid < 1) {
          throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE", 503);
        }
        const backendStartedAt = String(backend?.backend_started_at || "");
        if (!backendStartedAt) throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE", 503);
        const resolved = [];
        for (const item of checked) {
          const row = (await client.query(
            `/* auto-listing-category-preparation-lease-key */
             SELECT current_category.collect_item_id,shared.id AS shared_category_id,
                    account_ozon_shared_category_lease_key(shared.account_id,shared.id)::text AS lock_key
               FROM collect_ozon_category_current_sources current_category
               JOIN collect_ozon_category_source_evidence evidence
                 ON evidence.account_id=current_category.account_id
                AND evidence.id=current_category.source_evidence_id
                AND evidence.collect_item_id=current_category.collect_item_id
                AND evidence.source_kind=current_category.source_kind
                AND evidence.source_record_id=current_category.source_record_id
                AND evidence.source_version=current_category.source_version
               JOIN account_ozon_shared_categories shared
                 ON shared.account_id=evidence.account_id
                AND shared.source_description_category_id=evidence.source_description_category_id
                AND shared.source_type_id=evidence.source_type_id
                AND shared.taxonomy_scope=evidence.taxonomy_scope
              WHERE current_category.account_id=$1 AND current_category.collect_item_id=$2
                AND evidence.id=$3 AND shared.id=$4 AND shared.version=$5
                AND shared.status='ACTIVE'
                AND shared.current_description_category_id=$6 AND shared.current_type_id=$7
                AND shared.taxonomy_scope=$8 AND COALESCE(shared.taxonomy_fingerprint,'')=$9
                AND evidence.source_description_category_id=$10 AND evidence.source_type_id=$11
                AND shared.source=$12`,
            [scope, item.collectItemId, item.evidenceId, item.sharedCategoryId,
              item.sharedCategoryVersion, item.descriptionCategoryId, item.typeId,
              item.taxonomyScope, item.taxonomyFingerprint, item.sourceDescriptionCategoryId,
              item.sourceTypeId, item.provenance],
          )).rows[0];
          if (!row) throw sourceVersionConflict();
          resolved.push({ item, lockKey: requiredText(row.lock_key) });
        }
        const lockKeys = [...new Set(resolved.map(({ lockKey }) => lockKey))]
          .sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
        await client.query("SELECT set_config('lock_timeout',$1,FALSE)", [`${categoryLeaseWaitTimeoutMs}ms`]);
        await client.query("SELECT set_config('statement_timeout',$1,FALSE)", [`${categoryLeaseWaitTimeoutMs + 1_000}ms`]);
        for (const lockKey of lockKeys) {
          try {
            await client.query("SELECT pg_advisory_lock_shared($1::bigint) AS locked", [lockKey]);
          } catch (caught) {
            if (["55P03", "57014"].includes(caught?.code)) {
              throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_TIMEOUT", 503);
            }
            throw caught;
          }
        }
        await client.query("SELECT set_config('lock_timeout','0',FALSE),set_config('statement_timeout','0',FALSE)");
        for (const { item } of resolved) {
          const fenced = await client.query(
            `/* auto-listing-category-preparation-lease-fence */ SELECT shared.id
               FROM collect_ozon_category_current_sources current_category
               JOIN collect_ozon_category_source_evidence evidence
                 ON evidence.account_id=current_category.account_id
                AND evidence.id=current_category.source_evidence_id
                AND evidence.collect_item_id=current_category.collect_item_id
                AND evidence.source_kind=current_category.source_kind
                AND evidence.source_record_id=current_category.source_record_id
                AND evidence.source_version=current_category.source_version
               JOIN account_ozon_shared_categories shared
                 ON shared.account_id=evidence.account_id
                AND shared.source_description_category_id=evidence.source_description_category_id
                AND shared.source_type_id=evidence.source_type_id
                AND shared.taxonomy_scope=evidence.taxonomy_scope
              WHERE current_category.account_id=$1 AND current_category.collect_item_id=$2
                AND evidence.id=$3 AND shared.id=$4 AND shared.version=$5
                AND shared.status='ACTIVE'
                AND shared.current_description_category_id=$6 AND shared.current_type_id=$7
                AND shared.taxonomy_scope=$8 AND COALESCE(shared.taxonomy_fingerprint,'')=$9
                AND evidence.source_description_category_id=$10 AND evidence.source_type_id=$11
                AND shared.source=$12`,
            [scope, item.collectItemId, item.evidenceId, item.sharedCategoryId,
              item.sharedCategoryVersion, item.descriptionCategoryId, item.typeId,
              item.taxonomyScope, item.taxonomyFingerprint, item.sourceDescriptionCategoryId,
              item.sourceTypeId, item.provenance],
          );
          if (fenced.rows.length !== 1) throw sourceVersionConflict();
        }
        const acquiredAt = new Date(now());
        if (!Number.isFinite(acquiredAt.getTime())) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
        const expiresAt = new Date(acquiredAt.getTime() + categoryLeaseHoldTimeoutMs);
        leaseId = newId("auto_listing_category_lease");
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO auto_listing_category_preparation_leases (
             id,account_id,holder_backend_pid,holder_backend_started_at,state,acquired_at,expires_at
           ) VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6)`,
          [leaseId, scope, backendPid, backendStartedAt, acquiredAt.toISOString(), expiresAt.toISOString()],
        );
        for (const item of checked) {
          await client.query(
            `INSERT INTO auto_listing_category_preparation_lease_items (
               account_id,lease_id,collect_item_id,evidence_id,shared_category_id,
               shared_category_version,source_description_category_id,source_type_id,
               description_category_id,type_id,taxonomy_scope,taxonomy_fingerprint,provenance
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [scope, leaseId, item.collectItemId, item.evidenceId, item.sharedCategoryId,
              item.sharedCategoryVersion, item.sourceDescriptionCategoryId, item.sourceTypeId,
              item.descriptionCategoryId, item.typeId, item.taxonomyScope,
              item.taxonomyFingerprint, item.provenance],
          );
        }
        await client.query("COMMIT");
        const timer = setTimeout(() => { expireCategoryLease(scope, leaseId); }, categoryLeaseHoldTimeoutMs);
        timer.unref?.();
        activeCategoryLeases.set(categoryLeaseMapKey(scope, leaseId), {
          accountId: scope, backendPid, client, timer, controller, expired: false, onClientError,
        });
        return Object.freeze({ leaseId, expiresAt: expiresAt.toISOString(), signal: controller.signal });
      } catch (caught) {
        await client.query("ROLLBACK").catch(() => {});
        await client.query("SELECT pg_advisory_unlock_all()").catch(() => {});
        client.off?.("error", onClientError);
        try { client.release(caught); } catch {}
        throw caught;
      }
    },

    async releaseCategoryPreparationLease({ accountId, leaseId, outcome, jobId } = {}) {
      const scope = requiredAccountId(accountId);
      const id = requiredText(leaseId);
      if (!["COMMITTED", "REPLAYED", "FAILED", "CONFLICT", "TIMEOUT"].includes(outcome)) {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      const jobBoundOutcome = outcome === "COMMITTED" || outcome === "REPLAYED";
      const boundJobId = jobBoundOutcome ? requiredText(jobId) : null;
      if (!jobBoundOutcome && jobId != null) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      const expectedState = outcome === "TIMEOUT" ? "EXPIRED" : "RELEASED";
      const terminalMatches = (row) => Boolean(row)
        && row.state === expectedState
        && row.outcome === outcome
        && (outcome === "COMMITTED" ? row.finalized_job_id === boundJobId : row.finalized_job_id == null)
        && (outcome === "REPLAYED" ? row.replayed_job_id === boundJobId : row.replayed_job_id == null);
      const readTerminal = async (queryable) => (await queryable.query(
        `SELECT id,state,outcome,finalized_job_id,replayed_job_id
           FROM auto_listing_category_preparation_leases
          WHERE account_id=$1 AND id=$2`,
        [scope, id],
      )).rows[0];
      const mapKey = categoryLeaseMapKey(scope, id);
      const held = activeCategoryLeases.get(mapKey);
      if (!held || held.accountId !== scope) {
        if (terminalMatches(await readTerminal(pool))) return Object.freeze({ released: true });
        throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_NOT_ACTIVE", 409);
      }
      activeCategoryLeases.delete(mapKey);
      clearTimeout(held.timer);
      let failed = null;
      try {
        const updated = await held.client.query(
          `UPDATE auto_listing_category_preparation_leases
              SET state=CASE WHEN $4='TIMEOUT' THEN 'EXPIRED' ELSE 'RELEASED' END,
                  outcome=$4,
                  finalized_job_id=CASE WHEN $4='COMMITTED' THEN $5 ELSE NULL END,
                  replayed_job_id=CASE WHEN $4='REPLAYED' THEN $5 ELSE NULL END,
                  released_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE account_id=$1 AND id=$2 AND holder_backend_pid=$3 AND state='ACTIVE'
              AND (
                ($4='COMMITTED' AND EXISTS (
                  SELECT 1 FROM auto_listing_jobs job
                   WHERE job.account_id=$1 AND job.id=$5
                     AND job.category_preparation_lease_id=$2
                ))
                OR ($4='REPLAYED' AND EXISTS (
                  SELECT 1 FROM auto_listing_jobs job
                   WHERE job.account_id=$1 AND job.id=$5
                     AND job.category_preparation_lease_id IS NOT NULL
                     AND job.category_preparation_lease_id<>$2
                ))
                OR ($4 IN ('FAILED','CONFLICT','TIMEOUT') AND $5 IS NULL)
              )
            RETURNING id,state,outcome,finalized_job_id,replayed_job_id`,
          [scope, id, held.backendPid, outcome, boundJobId],
        );
        const terminal = updated.rows[0] || await readTerminal(held.client);
        if (!terminalMatches(terminal)) {
          throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_NOT_ACTIVE", 409);
        }
      } catch (caught) {
        failed = caught;
      } finally {
        await held.client.query("SELECT pg_advisory_unlock_all()").catch(() => {});
        held.client.off?.("error", held.onClientError);
        try { held.client.release(failed || undefined); } catch {}
      }
      if (failed) throw failed;
      return Object.freeze({ released: true });
    },

    async recoverCategoryPreparationLeases({ accountId } = {}) {
      const scope = requiredAccountId(accountId);
      const result = await pool.query(
        `UPDATE auto_listing_category_preparation_leases lease
            SET state=CASE WHEN lease.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'ORPHANED' END,
                outcome=CASE WHEN lease.expires_at<=clock_timestamp() THEN 'TIMEOUT' ELSE 'CRASHED' END,
                released_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE lease.account_id=$1 AND lease.state='ACTIVE'
            AND NOT EXISTS (SELECT 1 FROM pg_stat_activity activity WHERE activity.pid=lease.holder_backend_pid)
          RETURNING id,state`,
        [scope],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({ id: row.id, state: row.state })));
    },

    async loadTargetStore({ accountId, targetStoreId } = {}) {
      const scope = requiredAccountId(accountId);
      const storeId = requiredText(targetStoreId);
      const result = await pool.query(
        `SELECT s.id,s.owner_account_id,s.label,s.company_name,s.client_id,s.currency_code,
                s.currency_source,s.currency_synced_at,s.status,
                EXISTS (SELECT 1 FROM store_credentials sc WHERE sc.store_id=s.id) AS credentials_saved
           FROM stores s WHERE s.id=$1 AND s.owner_account_id=$2`,
        [storeId, scope],
      );
      const row = result.rows[0];
      return row ? {
        id: row.id,
        ownerAccountId: row.owner_account_id,
        label: row.label,
        companyName: row.company_name,
        clientId: row.client_id,
        currencyCode: row.currency_code,
        currencySource: row.currency_source,
        currencySyncedAt: row.currency_synced_at instanceof Date
          ? row.currency_synced_at.toISOString() : row.currency_synced_at,
        status: row.status,
        credentialsSaved: row.credentials_saved === true,
      } : null;
    },

    async loadTargetWarehouse({ accountId, targetStoreId, targetWarehouseId } = {}) {
      const scope = requiredAccountId(accountId);
      const storeId = requiredText(targetStoreId);
      const warehouseId = requiredText(targetWarehouseId);
      return loadWarehouseWithClient(pool, { accountId: scope, targetStoreId: storeId, targetWarehouseId: warehouseId });
    },

    async loadCategoryStrategyControl({ accountId, scopes } = {}) {
      const scope = requiredAccountId(accountId);
      if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 100) {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      const checked = scopes.map(exactCategoryStrategyScope);
      const keys = checked.map((entry) => `${entry.taxonomyScope}:${entry.descriptionCategoryId}:${entry.typeId}`);
      if (new Set(keys).size !== keys.length) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      const settingResult = await pool.query(
        `SELECT mode,version FROM auto_listing_category_strategy_account_settings
          WHERE account_id=$1`,
        [scope],
      );
      const setting = settingResult.rows[0] || { mode: "LEGACY_FALLBACK", version: 1 };
      if (!CATEGORY_STRATEGY_MODES.has(setting.mode)
        || !Number.isSafeInteger(Number(setting.version)) || Number(setting.version) < 1) {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      const taxonomyScopes = checked.map((entry) => entry.taxonomyScope);
      const descriptionCategoryIds = checked.map((entry) => entry.descriptionCategoryId);
      const typeIds = checked.map((entry) => entry.typeId);
      const draftResult = await pool.query(
        `SELECT draft.id,draft.taxonomy_scope,draft.description_category_id,draft.type_id,draft.status
           FROM UNNEST($2::TEXT[],$3::BIGINT[],$4::BIGINT[]) AS requested(taxonomy_scope,description_category_id,type_id)
           JOIN auto_listing_category_strategy_drafts draft
             ON draft.account_id=$1 AND draft.taxonomy_scope=requested.taxonomy_scope
            AND draft.description_category_id=requested.description_category_id
            AND draft.type_id=requested.type_id AND draft.ended_at IS NULL
          ORDER BY draft.taxonomy_scope,draft.description_category_id,draft.type_id,draft.id`,
        [scope, taxonomyScopes, descriptionCategoryIds, typeIds],
      );
      return Object.freeze({
        mode: setting.mode,
        version: Number(setting.version),
        drafts: Object.freeze(draftResult.rows.map((row) => Object.freeze({
          scope: Object.freeze({ taxonomyScope: row.taxonomy_scope,
            descriptionCategoryId: Number(row.description_category_id), typeId: Number(row.type_id) }),
          draftId: row.id,
          status: row.status,
        }))),
      });
    },

    async loadPublishedStrategy({ accountId } = {}) {
      const scope = requiredAccountId(accountId);
      const versionResult = await pool.query(
        `SELECT id,strategy_key,version,content FROM ai_content_strategy_versions
          WHERE account_id=$1 AND strategy_key='default' AND status='PUBLISHED'
          ORDER BY version DESC,id ASC LIMIT 1`,
        [scope],
      );
      const version = versionResult.rows[0];
      if (!version) return null;
      const ruleResult = await pool.query(
        `SELECT id,rule_order,rule_kind,category_id,ancestor_category_id,product_style,rule
           FROM ai_content_strategy_rules
          WHERE account_id=$1 AND strategy_version_id=$2
          ORDER BY rule_order ASC,id ASC`,
        [scope, version.id],
      );
      return {
        strategyVersion: { strategyId: version.strategy_key, strategyVersionId: version.id },
        rules: publishedRules(ruleResult.rows),
      };
    },

    async loadPublishedUploadPolicies({ accountId } = {}) {
      const scope = requiredAccountId(accountId);
      const result = await pool.query(
        `SELECT id,account_id,version,mode,enabled,published_by,published_at
           FROM auto_listing_upload_policy_versions
          WHERE account_id=$1 AND enabled IS TRUE
            AND published_by IS NOT NULL AND published_at IS NOT NULL
            AND publication_origin IS NOT NULL
            AND publication_base_url IS NOT NULL
            AND publication_prefix IS NOT NULL
            AND publication_version IS NOT NULL
            AND publication_policy_hash ~ '^[a-f0-9]{64}$'
          ORDER BY version DESC,id ASC`,
        [scope],
      );
      return result.rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        version: Number(row.version),
        mode: row.mode,
        enabled: row.enabled === true,
        publishedBy: row.published_by,
        publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at),
      }));
    },

    async createJobGraph(graphInput) {
      const graph = assertGraph(graphInput);
      const heldCategoryLease = activeCategoryLeases.get(categoryLeaseMapKey(
        graph.accountId, graph.categoryPreparationLeaseId,
      ));
      const borrowedCategoryLeaseClient = heldCategoryLease?.accountId === graph.accountId
        ? heldCategoryLease.client : null;
      const client = borrowedCategoryLeaseClient || await pool.connect();
      let committed = false;
      try {
        await client.query("BEGIN");
        const replay = await client.query(
          `SELECT id FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [graph.accountId, graph.idempotencyKey],
        );
        if (replay.rows[0]) {
          const existing = await readJobWithClient(client, graph.accountId, replay.rows[0].id);
          await assertReplayWarehouseBindingWithClient(client, graph, existing);
          await client.query("COMMIT");
          committed = true;
          return { ...existing, duplicate: true };
        }
        // Global mutation order matches category-strategy publish/rollback: account fence first.
        // All narrower category/settings/strategy locks are acquired only after this row lock.
        const accountFence = await client.query(
          "SELECT id FROM accounts WHERE id=$1 FOR UPDATE",
          [graph.accountId],
        );
        if (accountFence.rows.length !== 1) {
          throw repositoryError("AUTO_LISTING_ACCOUNT_REQUIRED", 401);
        }
        await lockCategoryGraphHandoffWithClient(client, graph);
        await assertCategoryGraphLeaseActiveWithClient(client, graph);
        await lockTargetWarehouseEvidenceWithClient(client, {
          accountId: graph.accountId,
          targetStoreId: graph.configSnapshot.targetStoreId,
          targetWarehouseId: graph.configSnapshot.targetWarehouseId,
          warehouseValidation: graph.warehouseValidation,
        });
        const strategy = await client.query(
          `SELECT strategy_key FROM ai_content_strategy_versions
            WHERE id=$1 AND account_id=$2 AND status='PUBLISHED' FOR SHARE`,
          [graph.strategyVersionId, graph.accountId],
        );
        if (!strategy.rows[0]) throw repositoryError("AUTO_LISTING_STRATEGY_NOT_PUBLISHED", 409);
        const categoryStrategySetting = graph.categoryStrategyGate ? await client.query(
          `SELECT mode,version FROM auto_listing_category_strategy_account_settings
            WHERE account_id=$1 FOR SHARE`,
          [graph.accountId],
        ) : { rows: [] };
        if (graph.categoryStrategyGate?.mode === "REQUIRE_EXACT_STRATEGY") {
          const leasedScopes = await client.query(
            `SELECT DISTINCT taxonomy_scope,description_category_id,type_id
              FROM auto_listing_category_preparation_lease_items
              WHERE account_id=$1 AND lease_id=$2
              ORDER BY taxonomy_scope,description_category_id,type_id`,
            [graph.accountId, graph.categoryPreparationLeaseId],
          );
          const current = leasedScopes.rows.map((row) => `${row.taxonomy_scope}:${Number(row.description_category_id)}:${Number(row.type_id)}`);
          const selected = graph.categoryStrategyGate.scopes
            .map((entry) => `${entry.taxonomyScope}:${entry.descriptionCategoryId}:${entry.typeId}`);
          if (current.length !== selected.length || current.some((entry) => !selected.includes(entry))) {
            throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_CHANGED", 409);
          }
        }
        const uploadPolicy = await client.query(
          `SELECT id FROM auto_listing_upload_policy_versions
            WHERE account_id=$1 AND id=$2 AND enabled IS TRUE
              AND published_by IS NOT NULL AND published_at IS NOT NULL
              AND publication_origin IS NOT NULL
              AND publication_base_url IS NOT NULL
              AND publication_prefix IS NOT NULL
              AND publication_version IS NOT NULL
              AND publication_policy_hash ~ '^[a-f0-9]{64}$'
            FOR SHARE`,
          [graph.accountId, graph.uploadPolicyVersionId],
        );
        if (!uploadPolicy.rows[0]) throw repositoryError("AUTO_LISTING_UPLOAD_POLICY_NOT_PUBLISHED", 409);
        let aiProfileId = null;
        let aiProfileVersion = null;
        if (stageInitialPlanWork) {
          const profiles = await client.query(
            `SELECT id,config_version,connection_id,connection_version,text_model,image_model FROM ai_gateway_profiles
              WHERE account_id=$1 AND enabled IS TRUE
              FOR SHARE`,
            [graph.accountId],
          );
          if (profiles.rows.length === 0) {
            throw repositoryError("AUTO_LISTING_AI_PROFILE_NOT_CONFIGURED", 409);
          }
          if (profiles.rows.length !== 1) {
            throw repositoryError("AUTO_LISTING_AI_PROFILE_AMBIGUOUS", 409);
          }
          aiProfileId = requiredText(profiles.rows[0].id);
          aiProfileVersion = Number(profiles.rows[0].config_version);
          if (!Number.isInteger(aiProfileVersion) || aiProfileVersion < 1) {
            throw repositoryError("AUTO_LISTING_AI_PROFILE_NOT_CONFIGURED", 409);
          }
          const selectedProfile = profiles.rows[0];
          const hasConnectionId = selectedProfile.connection_id !== null
            && selectedProfile.connection_id !== undefined;
          const hasConnectionVersion = selectedProfile.connection_version !== null
            && selectedProfile.connection_version !== undefined;
          if (hasConnectionId !== hasConnectionVersion) {
            throw repositoryError("AUTO_LISTING_AI_PROFILE_NOT_CONFIGURED", 409);
          }
          if (hasConnectionId) {
            const connectionId = requiredText(selectedProfile.connection_id,
              "AUTO_LISTING_AI_PROFILE_NOT_CONFIGURED");
            const connectionVersion = Number(selectedProfile.connection_version);
            const textModel = requiredText(selectedProfile.text_model,
              "AUTO_LISTING_AI_PROFILE_NOT_CONFIGURED");
            const imageModel = requiredText(selectedProfile.image_model,
              "AUTO_LISTING_AI_PROFILE_NOT_CONFIGURED");
            if (!Number.isInteger(connectionVersion) || connectionVersion < 1) {
              throw repositoryError("AUTO_LISTING_AI_PROFILE_NOT_CONFIGURED", 409);
            }
            const latestCatalog = await client.query(
              `SELECT catalog.catalog
                 FROM ai_gateway_model_catalogs catalog
                 JOIN ai_gateway_model_sync_tasks task
                   ON task.account_id=catalog.account_id AND task.id=catalog.sync_task_id
                  AND task.connection_id=catalog.connection_id
                  AND task.connection_version=catalog.connection_version
                WHERE catalog.account_id=$1 AND catalog.connection_id=$2
                  AND catalog.connection_version=$3
                  AND task.status='SUCCEEDED' AND task.sync_purpose='CATALOG_SYNC'
                ORDER BY catalog.created_at DESC,catalog.id DESC
                LIMIT 1
                FOR SHARE OF catalog,task`,
              [graph.accountId, connectionId, connectionVersion],
            );
            const models = latestCatalog.rows[0]?.catalog?.models;
            const modelIds = Array.isArray(models) ? new Set(models
              .map((model) => plainJsonObject(model) && typeof model.id === "string" ? model.id : null)
              .filter(Boolean)) : new Set();
            if (!modelIds.has(textModel) || !modelIds.has(imageModel)) {
              throw repositoryError("AUTO_LISTING_AI_ACTIVE_MODEL_UNAVAILABLE", 409);
            }
          }
        }
        const currentRules = graph.configSnapshot.useCategoryStrategy === false ? [] : publishedRules((await client.query(
          `SELECT id,rule_order,rule_kind,category_id,ancestor_category_id,product_style,rule
             FROM ai_content_strategy_rules WHERE account_id=$1 AND strategy_version_id=$2
             ORDER BY rule_order ASC,id ASC`,
          [graph.accountId, graph.strategyVersionId],
        )).rows);
        assertCurrentCategoryStrategyGate(graph, categoryStrategySetting.rows[0], currentRules, strategy.rows[0]);
        for (const item of graph.items) {
          const source = graph.sourceType === "EXCEL_SKU" && item.status === "SOURCE_READY"
            ? await client.query(
              `SELECT d.id AS draft_id,d.version AS draft_version,d.data_hash AS draft_data_hash
                 FROM auto_listing_import_rows r
                 JOIN auto_listing_import_files f
                   ON f.account_id=r.account_id AND f.id=r.import_file_id AND f.status='COLLECTING'
                 JOIN collect_items c
                   ON c.account_id=r.account_id AND c.id=r.collect_item_id AND c.deleted_at IS NULL
                 JOIN product_drafts d
                   ON d.id=c.current_draft_id AND d.collect_item_id=c.id
                WHERE r.id=$1 AND r.collect_item_id=$2 AND r.account_id=$3 AND r.status='READY'
                FOR SHARE OF r,f,c,d`,
              [item.sourceRecordId, item.collectItemId, graph.accountId],
            )
            : graph.sourceType === "EXCEL_SKU"
              ? await client.query(
                `SELECT NULL::TEXT AS draft_id,NULL::INTEGER AS draft_version,NULL::TEXT AS draft_data_hash
                   FROM auto_listing_import_rows r
                   JOIN auto_listing_import_files f
                     ON f.account_id=r.account_id AND f.id=r.import_file_id AND f.status='COLLECTING'
                   JOIN collect_items c
                     ON c.account_id=r.account_id AND c.id=r.collect_item_id AND c.deleted_at IS NULL
                  WHERE r.id=$1 AND r.collect_item_id=$2 AND r.account_id=$3 AND r.status='READY'
                  FOR SHARE OF r,f,c`,
                [item.sourceRecordId, item.collectItemId, graph.accountId],
              )
              : item.status === "SOURCE_READY" ? await client.query(
              `SELECT d.id AS draft_id,d.version AS draft_version,d.data_hash AS draft_data_hash
                 FROM collect_items c
                 JOIN product_drafts d ON d.id=c.current_draft_id AND d.collect_item_id=c.id
                WHERE c.id=$1 AND c.account_id=$2 AND c.deleted_at IS NULL
                FOR SHARE OF c,d`,
              [item.sourceRecordId, graph.accountId],
            ) : await client.query(
              `SELECT NULL::TEXT AS draft_id,NULL::INTEGER AS draft_version,NULL::TEXT AS draft_data_hash
                 FROM collect_items c
                WHERE c.id=$1 AND c.account_id=$2 AND c.deleted_at IS NULL
                FOR SHARE OF c`,
              [item.sourceRecordId, graph.accountId],
            );
          if (!source.rows[0]) throw repositoryError("AUTO_LISTING_SOURCE_NOT_FOUND", 404);
          if (item.status === "SOURCE_READY" && item.strategyId !== strategy.rows[0].strategy_key) {
            throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
          }
          if (Object.hasOwn(item, "snapshot")) {
            const category = item.snapshot.targetCategory;
            const categoryFence = await client.query(
              `/* auto-listing-shared-category-fence */ SELECT shared.id
                 FROM collect_ozon_category_current_sources current_category
                 JOIN collect_ozon_category_source_evidence evidence
                   ON evidence.account_id=current_category.account_id
                  AND evidence.id=current_category.source_evidence_id
                  AND evidence.collect_item_id=current_category.collect_item_id
                  AND evidence.source_kind=current_category.source_kind
                  AND evidence.source_record_id=current_category.source_record_id
                  AND evidence.source_version=current_category.source_version
                 JOIN account_ozon_shared_categories shared
                   ON shared.account_id=evidence.account_id
                  AND shared.source_description_category_id=evidence.source_description_category_id
                  AND shared.source_type_id=evidence.source_type_id
                  AND shared.taxonomy_scope=evidence.taxonomy_scope
                 JOIN auto_listing_category_preparation_leases category_lease
                   ON category_lease.account_id=current_category.account_id
                  AND category_lease.id=$13 AND category_lease.state='ACTIVE'
                  AND category_lease.expires_at>clock_timestamp()
                  AND category_lease.finalized_job_id IS NULL
                 JOIN pg_stat_activity category_lease_backend
                   ON category_lease_backend.pid=category_lease.holder_backend_pid
                  AND category_lease_backend.datname=current_database()
                  AND category_lease_backend.backend_start=category_lease.holder_backend_started_at
                 JOIN auto_listing_category_preparation_lease_items category_lease_item
                   ON category_lease_item.account_id=category_lease.account_id
                  AND category_lease_item.lease_id=category_lease.id
                  AND category_lease_item.collect_item_id=current_category.collect_item_id
                  AND category_lease_item.evidence_id=evidence.id
                  AND category_lease_item.shared_category_id=shared.id
                  AND category_lease_item.shared_category_version=shared.version
                WHERE current_category.account_id=$1 AND current_category.collect_item_id=$2
                  AND evidence.id=$3 AND shared.id=$4 AND shared.version=$5
                  AND shared.status='ACTIVE'
                  AND shared.current_description_category_id=$6
                  AND shared.current_type_id=$7
                  AND shared.taxonomy_scope=$8
                  AND COALESCE(shared.taxonomy_fingerprint,'')=$9
                  AND evidence.source_description_category_id=$10
                  AND evidence.source_type_id=$11
                  AND shared.source=$12
                  AND category_lease_item.source_description_category_id=$10
                  AND category_lease_item.source_type_id=$11
                  AND category_lease_item.description_category_id=$6
                  AND category_lease_item.type_id=$7
                  AND category_lease_item.taxonomy_scope=$8
                  AND category_lease_item.taxonomy_fingerprint=$9
                  AND category_lease_item.provenance=$12`,
              [graph.accountId, item.collectItemId, category.evidenceId, category.sharedCategoryId,
                category.sharedCategoryVersion, category.descriptionCategoryId, category.typeId,
                category.taxonomyScope, category.taxonomyFingerprint,
                category.sourceDescriptionCategoryId, category.sourceTypeId, category.provenance,
                graph.categoryPreparationLeaseId],
            );
            if (categoryFence.rows.length !== 1) throw sourceVersionConflict();
          }
          if (item.status === "SOURCE_READY") {
            const draft = source.rows[0];
            if (draft.draft_id !== item.listingBaseTemplate.productDraft.id
              || Number(draft.draft_version) !== item.listingBaseTemplate.productDraft.version
              || draft.draft_data_hash !== item.listingBaseTemplate.productDraft.dataHash) {
              throw sourceVersionConflict();
            }
            const resolved = resolveAiContentStrategy({
              strategyVersion: { strategyId: strategy.rows[0].strategy_key, strategyVersionId: graph.strategyVersionId },
              rules: currentRules,
              product: { taxonomyScope: item.snapshot.targetCategory.taxonomyScope,
                descriptionCategoryId: item.snapshot.targetCategory.descriptionCategoryId,
                typeId: item.snapshot.targetCategory.typeId,
                categoryAncestors: (item.snapshot.targetCategory.ancestorCategoryIds || []).map((categoryId, index) => ({ categoryId, distance: index + 1 })),
                productStyle: item.snapshot.source.productStyle },
            });
            if (item.strategyId !== resolved.strategyId || item.strategyVersionId !== resolved.strategyVersionId
              || item.ruleId !== resolved.ruleId || item.style !== resolved.style || item.matchedBy !== resolved.matchedBy) {
              throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
            }
            const price = calculateAutoListingPrice({ ...item.snapshot.priceEvidence,
              adjustmentKopecks: graph.configSnapshot.priceAdjustmentKopecks,
              priceMultiplierMicros: graph.configSnapshot.priceMultiplierMicros });
            if (!samePrice(item.price, price)) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
          }
        }
        await assertCategoryGraphLeaseActiveWithClient(client, graph);
        const jobId = newId("auto_listing_job");
        let warehouseValidationEvidenceId = null;
        if (graph.warehouseValidation) {
          warehouseValidationEvidenceId = newId("auto_listing_rfbs_warehouse_evidence");
          const evidence = graph.warehouseValidation;
          await client.query(
            `INSERT INTO auto_listing_rfbs_warehouse_evidence (
               id,account_id,store_id,warehouse_record_id,platform_warehouse_id,schema_version,
               fulfillment_type,status,outcome,observed_at,expires_at,evidence_hash,correlation_id,
               actor_account_id,raw_response_ref
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15)
             RETURNING id`,
            [warehouseValidationEvidenceId, evidence.accountId, evidence.storeId,
              evidence.warehouseRecordId, evidence.platformWarehouseId, evidence.schemaVersion,
              evidence.fulfillmentType, evidence.status, evidence.outcome, evidence.observedAt,
              evidence.expiresAt, evidence.evidenceHash, evidence.correlationId,
              evidence.actorAccountId, null],
          );
          await client.query(
            `INSERT INTO audit_events (
               event_id,account_id,store_id,action,entity_type,entity_id,correlation_id,metadata,
               status,actor_type,actor_id,source,occurred_at
             ) VALUES ($1,$2,$3,'AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED',
               'auto_listing_rfbs_warehouse_evidence',$4,$5,$6::jsonb,'SUCCESS','account',$7,
               'auto-listing-repository',STATEMENT_TIMESTAMP())`,
            [`AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED:${warehouseValidationEvidenceId}`,
              graph.accountId, evidence.storeId, warehouseValidationEvidenceId,
              evidence.correlationId, json({ warehouseRecordId: evidence.warehouseRecordId,
                platformWarehouseId: evidence.platformWarehouseId, evidenceHash: evidence.evidenceHash,
                observedAt: evidence.observedAt, expiresAt: evidence.expiresAt }), evidence.actorAccountId],
          );
        }
        await client.query(
          `INSERT INTO auto_listing_jobs (
             id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
             strategy_version_id,upload_policy_version_id,ai_profile_id,ai_profile_version,created_by,
             correlation_id,warehouse_validation_evidence_id,category_preparation_lease_id
           ) VALUES ($1,$2,$3,'CREATED',$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [jobId, graph.accountId, graph.sourceType, graph.idempotencyKey, json(graph.configSnapshot), graph.configHash,
            graph.strategyVersionId, graph.uploadPolicyVersionId, aiProfileId, aiProfileVersion,
            graph.actorAccountId, graph.correlationId, warehouseValidationEvidenceId,
            graph.categoryPreparationLeaseId],
        );
        for (const item of graph.items) {
          const proposedSnapshotId = newId("auto_listing_snapshot");
          const insertedSnapshot = await client.query(
            `INSERT INTO auto_listing_source_snapshots (
               id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref
             ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
             ON CONFLICT (account_id,source_type,source_record_id,source_version) DO NOTHING
             RETURNING id,snapshot,snapshot_hash,raw_response_ref`,
            [proposedSnapshotId, graph.accountId, item.sourceType, item.sourceRecordId, item.sourceVersion,
              json(item.snapshot ?? item.blockedEvidence), item.snapshotHash, item.rawResponseRef],
          );
          const persistedSnapshot = insertedSnapshot.rows[0] || (await client.query(
            `SELECT id,snapshot,snapshot_hash,raw_response_ref FROM auto_listing_source_snapshots
              WHERE account_id=$1 AND source_type=$2 AND source_record_id=$3 AND source_version=$4 FOR SHARE`,
            [graph.accountId, item.sourceType, item.sourceRecordId, item.sourceVersion],
          )).rows[0];
          const snapshotId = verifyPersistedSourceEvidence(item, persistedSnapshot);
          const itemId = `${jobId}_item_${String(item.sourceOrder).padStart(3, "0")}`;
          await client.query(
            `INSERT INTO auto_listing_job_items (
               id,job_id,account_id,snapshot_id,source_order,target_store_id,target_warehouse_id,status,status_version,
               visual_group_count,failure_code,failure_detail_safe,planning_contract
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,0,$9,$10,$11)`,
            [itemId, jobId, graph.accountId, snapshotId, item.sourceOrder, item.targetStoreId, item.targetWarehouseId,
              item.status, item.failureCode || null, item.failureCode ? item.failureCode : null,
              item.planningContract],
          );
          await client.query(
            `INSERT INTO auto_listing_events (
               id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,correlation_id,details
             ) VALUES ($1,$2,$3,$4,$5,NULL,'CREATED','CREATED',$6,$7::jsonb)`,
            [`${itemId}_01`, graph.accountId, jobId, itemId, graph.actorAccountId,
              graph.correlationId, json({ sourceRecordId: item.sourceRecordId, sourceVersion: item.sourceVersion, sourceHash: item.snapshotHash })],
          );
          const blocked = item.status === "BLOCKED";
          await client.query(
            `INSERT INTO auto_listing_events (
               id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,correlation_id,details
             ) VALUES ($1,$2,$3,$4,$5,'CREATED',$6,$7,$8,$9::jsonb)`,
            [`${itemId}_02`, graph.accountId, jobId, itemId, graph.actorAccountId,
              blocked ? "BLOCKED" : "SOURCE_READY", blocked ? "BLOCK" : "SOURCE_CAPTURED", graph.correlationId,
              json(eventDetails(item, graph.categoryStrategyGate))],
          );
          if (!blocked) {
            const listingBase = freezeAutoListingListingBase({
              accountId: graph.accountId,
              jobId,
              itemId,
              sourceSnapshotId: snapshotId,
              collectItemId: item.collectItemId,
              targetStoreId: item.targetStoreId,
              ...item.listingBaseTemplate,
            });
            await client.query(
              `INSERT INTO auto_listing_listing_bases (
                 id,account_id,job_id,item_id,source_snapshot_id,collect_item_id,target_store_id,
                 product_draft_id,product_draft_version,product_draft_data_hash,ozon_ready_variants,
                 pricing_evidence,rich_content_attribute_supported,listing_base_version,canonical_hash,
                 normalizer_version,category_rule_version,dictionary_version
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18)`,
              [newId("auto_listing_base"), graph.accountId, jobId, itemId, snapshotId, item.collectItemId,
                item.targetStoreId, listingBase.productDraft.id, listingBase.productDraft.version,
                listingBase.productDraft.dataHash, json(listingBase.variants), json(listingBase.pricingEvidence),
                listingBase.richContentAttributeSupported, listingBase.version, listingBase.canonicalHash,
                listingBase.versions.normalizerVersion, listingBase.versions.categoryRuleVersion,
                listingBase.versions.dictionaryVersion],
            );
          }
          if (!blocked && stageInitialPlanWork) {
            await assertCategoryGraphLeaseActiveWithClient(client, graph);
            const staged = await stageInitialPlanWork({
              client,
              accountId: graph.accountId,
              jobId,
              itemId,
              actorAccountId: graph.actorAccountId,
              expectedStatusVersion: 1,
              correlationId: graph.correlationId,
            });
            if (!validInitialAiStageOutcome(staged)) {
              throw repositoryError("AUTO_LISTING_AI_INITIAL_STAGE_INVALID", 500);
            }
          }
        }
        await assertCategoryGraphLeaseActiveWithClient(client, graph);
        const created = await readJobWithClient(client, graph.accountId, jobId);
        await assertCategoryGraphLeaseActiveWithClient(client, graph);
        await client.query("COMMIT");
        committed = true;
        return created;
      } catch (caught) {
        if (!committed) await client.query("ROLLBACK").catch(() => {});
        if (caught?.code === "23505" && caught?.constraint === JOB_IDEMPOTENCY_CONSTRAINT) {
          const existing = await pool.query(
            `SELECT id FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2`,
            [graph.accountId, graph.idempotencyKey],
          );
          if (existing.rows[0]) {
            const replayClient = await pool.connect();
            try {
              const replay = await readJobWithClient(replayClient, graph.accountId, existing.rows[0].id);
              await assertReplayWarehouseBindingWithClient(replayClient, graph, replay);
              return { ...replay, duplicate: true };
            } finally {
              replayClient.release();
            }
          }
        }
        if (caught?.code === "23514"
          && /category preparation lease cannot commit/u.test(String(caught.message || ""))) {
          const lease = (await pool.query(
            `SELECT lease.state,lease.expires_at<=clock_timestamp() AS expired,
                    EXISTS (
                      SELECT 1 FROM pg_stat_activity activity
                       WHERE activity.pid=lease.holder_backend_pid
                         AND activity.datname=current_database()
                         AND activity.backend_start=lease.holder_backend_started_at
                    ) AS backend_active
               FROM auto_listing_category_preparation_leases lease
              WHERE lease.account_id=$1 AND lease.id=$2`,
            [graph.accountId, graph.categoryPreparationLeaseId],
          )).rows[0];
          if (lease?.expired === true) {
            throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_EXPIRED", 409);
          }
          if (!lease || lease.backend_active !== true) {
            throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE", 503);
          }
          throw repositoryError("AUTO_LISTING_CATEGORY_LEASE_NOT_ACTIVE", 409);
        }
        throw caught;
      } finally {
        if (!borrowedCategoryLeaseClient) client.release();
      }
    },

    async getJob({ accountId, jobId } = {}) {
      const scope = requiredAccountId(accountId);
      return readJobWithClient(pool, scope, requiredText(jobId, "AUTO_LISTING_JOB_NOT_FOUND"));
    },

    async getJobByIdempotencyKey({ accountId, idempotencyKey } = {}) {
      const scope = requiredAccountId(accountId);
      const key = requiredText(idempotencyKey);
      const result = await pool.query(
        `SELECT id FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2`,
        [scope, key],
      );
      return result.rows[0] ? readJobWithClient(pool, scope, result.rows[0].id) : null;
    },

    async listJobs({ accountId, limit = 20 } = {}) {
      const scope = requiredAccountId(accountId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      const ranked = await pool.query(
        `WITH ranked_items AS (
           SELECT job.id AS job_id,item.id AS item_id,job.created_at AS job_created_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY snapshot.source_record_id,item.target_store_id
                    ORDER BY job.created_at DESC,job.id DESC,item.id ASC
                  ) AS item_rank
             FROM auto_listing_jobs job
             JOIN auto_listing_job_items item
               ON item.job_id=job.id AND item.account_id=job.account_id
             JOIN auto_listing_source_snapshots snapshot
               ON snapshot.id=item.snapshot_id AND snapshot.account_id=job.account_id
            WHERE job.account_id=$1
         ), latest_items AS (
           SELECT job_id,item_id,job_created_at
             FROM ranked_items
            WHERE item_rank=1
            ORDER BY job_created_at DESC,job_id DESC,item_id ASC
            LIMIT $2
         )
         SELECT job_id,item_id FROM latest_items
          ORDER BY job_created_at DESC,job_id DESC,item_id ASC`,
        [scope, limit],
      );
      const selectedByJob = new Map();
      for (const row of ranked.rows) {
        if (typeof row?.job_id !== "string" || !row.job_id
          || typeof row?.item_id !== "string" || !row.item_id) {
          throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
        }
        const ids = selectedByJob.get(row.job_id) || [];
        ids.push(row.item_id);
        selectedByJob.set(row.job_id, ids);
      }
      const result = [];
      for (const [jobId, itemIds] of selectedByJob) {
        const job = await readJobWithClient(pool, scope, jobId, itemIds);
        if (!job || job.items.length !== itemIds.length) {
          throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
        }
        result.push(job);
      }
      return result;
    },

    async updateItemStatus({
      accountId, itemId, expectedStatusVersion, eventType, actorAccountId, correlationId, details = {},
    } = {}) {
      const scope = requiredAccountId(accountId);
      const id = requiredText(itemId);
      if (!Number.isInteger(expectedStatusVersion) || expectedStatusVersion < 1
        || !requiredText(eventType) || requiredText(actorAccountId) !== scope || !requiredText(correlationId)) {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      const safeDetails = safeEventDetails(details);
      if (["BLOCK", "RETRYABLE_FAILURE"].includes(eventType) && !safeDetails.failureCode) {
        throw eventDetailsError();
      }
      if (["RETRY_PLANNING", "RETRY_GENERATION", "RETRY_UPLOAD"].includes(eventType)
        && (safeDetails.failureCode || safeDetails.recoveryPoint)) {
        throw eventDetailsError();
      }
      const client = await pool.connect();
      let committed = false;
      try {
        await client.query("BEGIN");
        const current = await client.query(
          `SELECT id,job_id,status,status_version,recovery_point,failure_code FROM auto_listing_job_items
            WHERE id=$1 AND account_id=$2 FOR UPDATE`,
          [id, scope],
        );
        const row = current.rows[0];
        if (!row) throw repositoryError("AUTO_LISTING_JOB_NOT_FOUND", 404);
        if (row.status_version !== expectedStatusVersion) throw repositoryError("AUTO_LISTING_VERSION_CONFLICT", 409);
        const isRetryableFailure = eventType === "RETRYABLE_FAILURE";
        const isRetry = ["RETRY_PLANNING", "RETRY_GENERATION", "RETRY_UPLOAD"].includes(eventType);
        let recoveryPoint = null;
        if (isRetryableFailure) {
          recoveryPoint = recoveryPointForRetryableFailure(row.status);
          if (safeDetails.recoveryPoint && safeDetails.recoveryPoint !== recoveryPoint) {
            throw recoveryPointMismatchError();
          }
        } else if (isRetry) {
          recoveryPoint = row.recovery_point;
          if (!recoveryPoint) {
            const legacyFailure = await client.query(
              `SELECT e.id,e.account_id,e.job_id,e.item_id,e.event_type,e.from_status,e.to_status,e.transition_version,e.details
                 FROM auto_listing_events e
                 JOIN auto_listing_jobs j ON j.id=e.job_id AND j.account_id=e.account_id
                WHERE e.account_id=$1 AND e.item_id=$2 AND e.job_id=$3 AND j.account_id=$1
                  AND e.transition_version=$4`,
              [scope, id, row.job_id, row.status_version],
            );
            const versionedFailure = legacyFailure.rows[0];
            if (versionedFailure) {
              recoveryPoint = recoveryPointFromLegacyFailure(versionedFailure, row, scope);
            } else {
              const legacyById = await client.query(
                `SELECT e.id,e.account_id,e.job_id,e.item_id,e.event_type,e.from_status,e.to_status,e.transition_version,e.details
                   FROM auto_listing_events e
                   JOIN auto_listing_jobs j ON j.id=e.job_id AND j.account_id=e.account_id
                  WHERE e.account_id=$1 AND e.item_id=$2 AND e.job_id=$3 AND j.account_id=$1
                    AND e.id=$4 AND e.transition_version IS NULL`,
                [scope, id, row.job_id, transitionEventId(id, row.status_version)],
              );
              recoveryPoint = recoveryPointFromLegacyFailure(legacyById.rows[0], row, scope, { legacyNullVersion: true });
            }
          }
        }
        const nextStatus = nextAutoListingStatus(row.status, eventType, recoveryPoint);
        assertAutoListingTransition(row.status, eventType, nextStatus, recoveryPoint);
        const failureCode = ["BLOCK", "RETRYABLE_FAILURE"].includes(eventType)
          ? safeDetails.failureCode : null;
        const persistedRecoveryPoint = isRetryableFailure ? recoveryPoint : null;
        const persistedDetails = isRetryableFailure
          ? { ...safeDetails, recoveryPoint }
          : safeDetails;
        const updated = await client.query(
          `UPDATE auto_listing_job_items SET status=$1,status_version=status_version+1,
                  failure_code=$2,failure_detail_safe=$2,recovery_point=$3,updated_at=NOW()
            WHERE id=$4 AND account_id=$5 AND status_version=$6
            RETURNING id,status,status_version`,
          [nextStatus, failureCode, persistedRecoveryPoint, id, scope, expectedStatusVersion],
        );
        const updatedItem = updated.rows[0];
        const transitionVersion = expectedStatusVersion + 1;
        if (!updatedItem || updatedItem.status_version !== transitionVersion) {
          throw repositoryError("AUTO_LISTING_VERSION_CONFLICT", 409);
        }
        await client.query(
          `INSERT INTO auto_listing_events (
             id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,correlation_id,transition_version,details
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [transitionEventId(id, transitionVersion), scope, row.job_id, id,
            actorAccountId, row.status, nextStatus, eventType, correlationId, transitionVersion, json(persistedDetails)],
        );
        await client.query("COMMIT");
        committed = true;
        return updated.rows[0];
      } catch (caught) {
        if (!committed) await client.query("ROLLBACK").catch(() => {});
        throw caught;
      } finally {
        client.release();
      }
    },
  };
}

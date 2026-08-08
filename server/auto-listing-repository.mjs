import crypto from "node:crypto";
import {
  assertAutoListingTransition,
  nextAutoListingStatus,
  recoveryPointForRetryableFailure,
} from "./auto-listing-state-machine.mjs";
import {
  verifyAutoListingBlockedSourceEvidence,
  verifyAutoListingSourceSnapshot,
} from "./auto-listing-source-snapshot.mjs";
import { assertListingStockSelectionEligible } from "./listing-warehouse-eligibility.mjs";
import { validateTargetStoreRecord } from "./listing-submission-policy.mjs";
import { resolveAiContentStrategy } from "./ai-content-strategy.mjs";
import { calculateAutoListingPrice } from "./auto-listing-pricing.mjs";
import {
  verifyAutoListingFrozenConfig,
} from "./auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "./auto-listing-item-image-config.mjs";
import { freezeAutoListingListingBase } from "./auto-listing-overlay.mjs";

const JOB_IDEMPOTENCY_CONSTRAINT = "auto_listing_jobs_account_id_idempotency_key_key";
const BLOCKED_SOURCE_FAILURE_CODES = new Set([
  "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED",
  "AUTO_LISTING_SOURCE_SKU_REQUIRED",
  "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB",
]);

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

function json(value) {
  return JSON.stringify(value ?? null);
}

function plainJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

async function lockTargetWarehouseEvidenceWithClient(client, { accountId, targetStoreId, targetWarehouseId }) {
  const storeResult = await client.query(
    `SELECT s.id,s.owner_account_id,s.label,s.company_name,s.client_id,s.currency_code,s.status
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
  assertListingStockSelectionEligible({
    warehouses: [warehouse],
    products: [...productsById.values()],
    stocks: [{ warehouse_id: platformWarehouseId }],
    targetStoreId,
    accountId,
  });
  return { warehouse, products: [...productsById.values()] };
}

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function eventDetails(item) {
  return {
    sourceRecordId: item.sourceRecordId,
    sourceVersion: item.sourceVersion,
    sourceHash: item.snapshotHash,
    strategyId: item.strategyId,
    strategyVersionId: item.strategyVersionId,
    ruleId: item.ruleId,
    style: item.style,
    matchedBy: item.matchedBy,
    ...(item.price ? { price: item.price } : {}),
    ...(item.failureCode ? { failureCode: item.failureCode } : {}),
  };
}

function mapJob(row, items, events) {
  const eventsByItem = new Map();
  for (const event of events) {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((item) => {
      const audit = (eventsByItem.get(item.id) || [])
        .find((event) => ["SOURCE_CAPTURED", "BLOCK"].includes(event.event_type))?.details || {};
      return {
        id: item.id,
        status: item.status,
        statusVersion: Number(item.status_version),
        recoveryPoint: item.recovery_point || null,
        activeContentPlanId: item.active_content_plan_id || null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        targetStoreId: item.target_store_id,
        targetWarehouseId: item.target_warehouse_id,
        sourceRecordId: item.source_record_id,
        sourceVersion: item.source_version,
        sourceHash: item.snapshot_hash,
        strategyId: audit.strategyId || null,
        strategyVersionId: audit.strategyVersionId || row.strategy_version_id || null,
        ruleId: audit.ruleId || null,
        style: audit.style || null,
        matchedBy: audit.matchedBy || null,
        ...(audit.price ? { price: audit.price } : {}),
        ...(item.failure_code ? { failureCode: item.failure_code } : {}),
      };
    }),
    events: events.map((event) => ({
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

async function readJobWithClient(client, accountId, jobId) {
  const jobResult = await client.query(
    `SELECT id,account_id,source_type,status,strategy_version_id,correlation_id,created_at,updated_at
       FROM auto_listing_jobs WHERE id=$1 AND account_id=$2`,
    [jobId, accountId],
  );
  const job = jobResult.rows[0];
  if (!job) return null;
  const itemResult = await client.query(
    `SELECT i.id,i.status,i.status_version,i.recovery_point,i.active_content_plan_id,
            i.target_store_id,i.target_warehouse_id,i.failure_code,i.created_at,i.updated_at,
            s.source_record_id,s.source_version,s.snapshot_hash
       FROM auto_listing_job_items i
       JOIN auto_listing_source_snapshots s ON s.id=i.snapshot_id AND s.account_id=$2
      WHERE i.job_id=$1 AND i.account_id=$2
      ORDER BY i.id ASC`,
    [jobId, accountId],
  );
  const eventResult = await client.query(
    `SELECT id,item_id,from_status,to_status,event_type,correlation_id,details,created_at
       FROM auto_listing_events
      WHERE job_id=$1 AND account_id=$2
      ORDER BY created_at ASC,id ASC`,
    [jobId, accountId],
  );
  return mapJob(job, itemResult.rows, eventResult.rows);
}

function assertGraph(graph) {
  if (!graph || typeof graph !== "object") throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  const accountId = requiredAccountId(graph.accountId);
  const idempotencyKey = requiredText(graph.idempotencyKey);
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
  const items = graph.items.map((item) => {
    const collectItemId = graph.sourceType === "EXCEL_SKU"
      ? requiredText(item?.collectItemId) : requiredText(item?.sourceRecordId);
    if (!item || typeof item !== "object" || item.sourceType !== graph.sourceType
      || !requiredText(item.sourceRecordId) || !requiredText(item.sourceVersion)
      || !requiredText(item.targetStoreId) || !requiredText(item.targetWarehouseId)
      || !Number.isInteger(item.sourceOrder) || item.sourceOrder < 0
      || !["SOURCE_READY", "BLOCKED"].includes(item.status)) {
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
      || (item.status === "SOURCE_READY" && captured.snapshot.targetCategory.targetStoreId !== item.targetStoreId)) {
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
        || !["EXACT_CATEGORY", "ANCESTOR_CATEGORY", "PRODUCT_STYLE", "DEFAULT"].includes(item.matchedBy)
        || !plainJsonObject(item.price)) {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      let calculated;
      try {
        calculated = calculateAutoListingPrice({ ...captured.snapshot.priceEvidence,
          adjustmentKopecks: configSnapshot.priceAdjustmentKopecks });
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
  if (new Set(items.map((item) => item.sourceOrder)).size !== items.length) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return { ...graph, accountId, idempotencyKey, configSnapshot, configHash, items };
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
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
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
  if (frozen.productDraft.id !== item.snapshot.source.productDraftId
    || frozen.productDraft.version !== item.snapshot.source.productDraftVersion
    || frozen.pricingEvidence.currency !== item.snapshot.priceEvidence.currency
    || frozen.pricingEvidence.blackKopecks !== item.snapshot.priceEvidence.blackKopecks
    || frozen.pricingEvidence.greenKopecks !== (item.snapshot.priceEvidence.greenKopecks || null)) {
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
  return rows.map((rule) => ({
    ruleId: rule.id, ruleOrder: Number(rule.rule_order), matchType: rule.rule_kind,
    categoryId: rule.rule_kind === "ANCESTOR_CATEGORY" ? rule.ancestor_category_id : rule.category_id,
    productStyle: rule.product_style, style: rule.rule?.style, textDensityByRole: rule.rule?.textDensityByRole,
  }));
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
} = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("PostgreSQL pool is required for auto listing repository");
  }
  if (typeof now !== "function") throw new TypeError("Auto listing repository clock must be a function");
  if (stageInitialPlanWork !== null && typeof stageInitialPlanWork !== "function") {
    throw new TypeError("Auto listing initial AI workflow port must be a function or null");
  }
  const newId = (prefix) => requiredText(idFactory(prefix), "AUTO_LISTING_REPOSITORY_INVALID");

  return {
    async loadCollectSources({ accountId, collectItemIds } = {}) {
      const scope = requiredAccountId(accountId);
      const ids = Array.isArray(collectItemIds) ? [...new Set(collectItemIds.map((id) => requiredText(id)))] : [];
      if (!ids.length) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      const result = await pool.query(
        `SELECT c.id,c.account_id,c.source,c.source_sku,c.summary,
                d.id AS draft_id,d.version AS draft_version,d.data_hash AS draft_data_hash,d.data AS draft_data,
                d.normalizer_version,d.category_rule_version,d.dictionary_version,
                raw.id AS raw_response_ref,raw.payload AS raw_payload,raw.payload_hash,raw.collected_at
           FROM collect_items c
           LEFT JOIN product_drafts d ON d.id=c.current_draft_id AND d.collect_item_id=c.id
           LEFT JOIN LATERAL (
             SELECT id,payload,payload_hash,collected_at FROM collect_raw_payloads
              WHERE collect_item_id=c.id AND account_id=c.account_id
                AND ((d.id IS NOT NULL AND id=d.source_payload_id) OR d.id IS NULL)
              ORDER BY created_at DESC,id DESC LIMIT 1
           ) raw ON TRUE
          WHERE c.account_id=$1 AND c.id=ANY($2::text[]) AND c.deleted_at IS NULL
          ORDER BY array_position($2::text[],c.id)`,
        [scope, ids],
      );
      return result.rows.map((row) => {
        const rawNormalized = row.raw_payload?.normalized && typeof row.raw_payload.normalized === "object"
          ? row.raw_payload.normalized : {};
        return {
          id: row.id,
          accountId: row.account_id,
          sourceVersion: row.draft_id
            ? `draft:${row.draft_version}:${row.payload_hash || row.raw_response_ref || "missing"}`
            : `raw:${row.payload_hash || row.raw_response_ref || "missing"}`,
          rawResponseRef: row.raw_response_ref || null,
          rawResponseHash: row.payload_hash || null,
          rawCollectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : null,
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
      const fileResult = await pool.query(
        `SELECT id,account_id,status,status_version,accepted_rows,ready_rows,failed_rows,
                config_snapshot,config_hash,idempotency_key,correlation_id
           FROM auto_listing_import_files
          WHERE account_id=$1 AND id=$2`,
        [scope, fileId],
      );
      const file = fileResult.rows?.[0];
      if (!file) return null;
      if (file.account_id !== scope || file.id !== fileId) {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      const sourceResult = await pool.query(
        `SELECT r.id AS row_id,r.collect_item_id,c.account_id,c.source,c.source_sku,c.summary,
                d.id AS draft_id,d.version AS draft_version,d.data_hash AS draft_data_hash,d.data AS draft_data,
                d.normalizer_version,d.category_rule_version,d.dictionary_version,
                raw.id AS raw_response_ref,raw.payload AS raw_payload,raw.payload_hash,raw.collected_at
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
          WHERE r.account_id=$1 AND r.import_file_id=$2 AND r.status='READY'
          ORDER BY r.row_number,r.id`,
        [scope, fileId],
      );
      const sources = sourceResult.rows.map((row) => {
        if (row.account_id !== scope) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
        const rawNormalized = row.raw_payload?.normalized && typeof row.raw_payload.normalized === "object"
          ? row.raw_payload.normalized : {};
        return {
          id: row.row_id,
          collectItemId: row.collect_item_id,
          accountId: row.account_id,
          sourceVersion: row.draft_id
            ? `draft:${row.draft_version}:${row.payload_hash || row.raw_response_ref || "missing"}`
            : `raw:${row.payload_hash || row.raw_response_ref || "missing"}`,
          rawResponseRef: row.raw_response_ref || null,
          rawResponseHash: row.payload_hash || null,
          rawCollectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : null,
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
          id: file.id, accountId: file.account_id, status: file.status,
          statusVersion: Number(file.status_version), acceptedRows: Number(file.accepted_rows),
          readyRows: Number(file.ready_rows), failedRows: Number(file.failed_rows),
          configSnapshot: file.config_snapshot, configHash: file.config_hash,
          idempotencyKey: file.idempotency_key, correlationId: file.correlation_id,
        },
        sources,
      };
    },

    async loadTargetStore({ accountId, targetStoreId } = {}) {
      const scope = requiredAccountId(accountId);
      const storeId = requiredText(targetStoreId);
      const result = await pool.query(
        `SELECT s.id,s.owner_account_id,s.label,s.company_name,s.client_id,s.currency_code,s.status,
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

    async loadPublishedStrategy({ accountId } = {}) {
      const scope = requiredAccountId(accountId);
      const versionResult = await pool.query(
        `SELECT id,strategy_key,version,content FROM ai_content_strategy_versions
          WHERE account_id=$1 AND status='PUBLISHED'
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
        rules: ruleResult.rows.map((rule) => ({
          ruleId: rule.id,
          ruleOrder: Number(rule.rule_order),
          matchType: rule.rule_kind,
          categoryId: rule.rule_kind === "ANCESTOR_CATEGORY" ? rule.ancestor_category_id : rule.category_id,
          productStyle: rule.product_style,
          style: rule.rule?.style,
          textDensityByRole: rule.rule?.textDensityByRole,
        })),
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
      const client = await pool.connect();
      let committed = false;
      try {
        await client.query("BEGIN");
        const replay = await client.query(
          `SELECT id FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [graph.accountId, graph.idempotencyKey],
        );
        if (replay.rows[0]) {
          const existing = await readJobWithClient(client, graph.accountId, replay.rows[0].id);
          await client.query("COMMIT");
          committed = true;
          return { ...existing, duplicate: true };
        }
        await lockTargetWarehouseEvidenceWithClient(client, {
          accountId: graph.accountId,
          targetStoreId: graph.configSnapshot.targetStoreId,
          targetWarehouseId: graph.configSnapshot.targetWarehouseId,
        });
        const strategy = await client.query(
          `SELECT strategy_key FROM ai_content_strategy_versions
            WHERE id=$1 AND account_id=$2 AND status='PUBLISHED' FOR SHARE`,
          [graph.strategyVersionId, graph.accountId],
        );
        if (!strategy.rows[0]) throw repositoryError("AUTO_LISTING_STRATEGY_NOT_PUBLISHED", 409);
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
            `SELECT id,config_version FROM ai_gateway_profiles
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
        }
        const rules = await client.query(
          `SELECT id,rule_order,rule_kind,category_id,ancestor_category_id,product_style,rule
             FROM ai_content_strategy_rules WHERE account_id=$1 AND strategy_version_id=$2
             ORDER BY rule_order ASC,id ASC`,
          [graph.accountId, graph.strategyVersionId],
        );
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
          if (item.status === "SOURCE_READY") {
            const draft = source.rows[0];
            if (draft.draft_id !== item.listingBaseTemplate.productDraft.id
              || Number(draft.draft_version) !== item.listingBaseTemplate.productDraft.version
              || draft.draft_data_hash !== item.listingBaseTemplate.productDraft.dataHash) {
              throw sourceVersionConflict();
            }
            const resolved = resolveAiContentStrategy({
              strategyVersion: { strategyId: strategy.rows[0].strategy_key, strategyVersionId: graph.strategyVersionId },
              rules: publishedRules(rules.rows),
              product: { descriptionCategoryId: item.snapshot.targetCategory.descriptionCategoryId,
                categoryAncestors: item.snapshot.targetCategory.ancestorCategoryIds.map((categoryId, index) => ({ categoryId, distance: index + 1 })),
                productStyle: item.snapshot.source.productStyle },
            });
            if (item.strategyId !== resolved.strategyId || item.strategyVersionId !== resolved.strategyVersionId
              || item.ruleId !== resolved.ruleId || item.style !== resolved.style || item.matchedBy !== resolved.matchedBy) {
              throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
            }
            const price = calculateAutoListingPrice({ ...item.snapshot.priceEvidence,
              adjustmentKopecks: graph.configSnapshot.priceAdjustmentKopecks });
            if (!samePrice(item.price, price)) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
          }
        }
        const jobId = newId("auto_listing_job");
        await client.query(
          `INSERT INTO auto_listing_jobs (
             id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
             strategy_version_id,upload_policy_version_id,ai_profile_id,ai_profile_version,created_by,correlation_id
           ) VALUES ($1,$2,$3,'CREATED',$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)`,
          [jobId, graph.accountId, graph.sourceType, graph.idempotencyKey, json(graph.configSnapshot), graph.configHash,
            graph.strategyVersionId, graph.uploadPolicyVersionId, aiProfileId, aiProfileVersion,
            graph.actorAccountId, graph.correlationId],
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
               id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,
               visual_group_count,failure_code,failure_detail_safe
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,0,$8,$9)`,
            [itemId, jobId, graph.accountId, snapshotId, item.targetStoreId, item.targetWarehouseId,
              item.status, item.failureCode || null, item.failureCode ? item.failureCode : null],
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
              json(eventDetails(item))],
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
        const created = await readJobWithClient(client, graph.accountId, jobId);
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
              return { ...replay, duplicate: true };
            } finally {
              replayClient.release();
            }
          }
        }
        throw caught;
      } finally {
        client.release();
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
      const jobs = await pool.query(
        `SELECT id FROM auto_listing_jobs WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,
        [scope, limit],
      );
      const result = [];
      for (const row of jobs.rows) result.push(await readJobWithClient(pool, scope, row.id));
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

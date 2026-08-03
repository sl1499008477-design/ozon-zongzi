import crypto from "node:crypto";
import {
  assertAutoListingTransition,
  nextAutoListingStatus,
  recoveryPointForRetryableFailure,
} from "./auto-listing-state-machine.mjs";
import { verifyAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";
import { assertListingStockSelectionEligible } from "./listing-warehouse-eligibility.mjs";
import { resolveAiContentStrategy } from "./ai-content-strategy.mjs";
import { calculateAutoListingPrice } from "./auto-listing-pricing.mjs";
import {
  verifyAutoListingFrozenConfig,
} from "./auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "./auto-listing-item-image-config.mjs";

const JOB_IDEMPOTENCY_CONSTRAINT = "auto_listing_jobs_account_id_idempotency_key_key";

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

function recoveryPointFromLatestLegacyFailure(event, row, accountId) {
  if (!plainJsonObject(event) || event.account_id !== accountId || event.job_id !== row.job_id
    || event.item_id !== row.id || event.event_type !== "RETRYABLE_FAILURE"
    || event.to_status !== "RETRYABLE_ERROR" || !plainJsonObject(event.details)
    || typeof row.failure_code !== "string" || !row.failure_code
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
    `SELECT i.id,i.status,i.target_store_id,i.target_warehouse_id,i.failure_code,i.created_at,i.updated_at,
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
  if (requiredText(graph.actorAccountId) !== accountId || !requiredText(graph.strategyVersionId)
    || !Array.isArray(graph.items) || !graph.items.length) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  let frozenConfig;
  try {
    frozenConfig = verifyAutoListingFrozenConfig(graph.configSnapshot, graph.configHash);
  } catch {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  const { config: configSnapshot, configHash } = frozenConfig;
  const items = graph.items.map((item) => {
    if (!item || typeof item !== "object" || item.sourceType !== graph.sourceType
      || !requiredText(item.sourceRecordId) || !requiredText(item.sourceVersion)
      || !requiredText(item.targetStoreId) || !requiredText(item.targetWarehouseId)
      || !Number.isInteger(item.sourceOrder) || item.sourceOrder < 0
      || !["SOURCE_READY", "BLOCKED"].includes(item.status)) {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    const captured = verifyAutoListingSourceSnapshot(item);
    if (captured.snapshot.identity.accountId !== accountId
      || captured.snapshot.identity.sourceRecordId !== item.sourceRecordId
      || captured.snapshot.identity.sourceVersion !== item.sourceVersion
      || captured.snapshot.identity.sourceType !== item.sourceType) {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    if (captured.rawResponseRef !== captured.snapshot.rawEvidence.rawResponseRef
      || item.targetStoreId !== configSnapshot.targetStoreId
      || item.targetWarehouseId !== configSnapshot.targetWarehouseId
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
      return { ...item, ...captured, price: calculated, effectiveImageConfig };
    } else if (!/^AUTO_LISTING_[A-Z0-9_]+$|^PRICE_[A-Z0-9_]+$/.test(requiredText(item.failureCode))) {
      throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
    }
    return { ...item, ...captured, effectiveImageConfig };
  });
  if (new Set(items.map((item) => item.sourceOrder)).size !== items.length) {
    throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  }
  return { ...graph, accountId, idempotencyKey, configSnapshot, configHash, items };
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

function publishedRules(rows) {
  return rows.map((rule) => ({
    ruleId: rule.id, ruleOrder: Number(rule.rule_order), matchType: rule.rule_kind,
    categoryId: rule.rule_kind === "ANCESTOR_CATEGORY" ? rule.ancestor_category_id : rule.category_id,
    productStyle: rule.product_style, style: rule.rule?.style, textDensityByRole: rule.rule?.textDensityByRole,
  }));
}

export function createAutoListingRepository({ pool, idFactory = defaultIdFactory, now = () => new Date() } = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("PostgreSQL pool is required for auto listing repository");
  }
  if (typeof now !== "function") throw new TypeError("Auto listing repository clock must be a function");
  const newId = (prefix) => requiredText(idFactory(prefix), "AUTO_LISTING_REPOSITORY_INVALID");

  return {
    async loadCollectSources({ accountId, collectItemIds } = {}) {
      const scope = requiredAccountId(accountId);
      const ids = Array.isArray(collectItemIds) ? [...new Set(collectItemIds.map((id) => requiredText(id)))] : [];
      if (!ids.length) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      const result = await pool.query(
        `SELECT c.id,c.account_id,c.source,c.source_sku,c.summary,
                d.id AS draft_id,d.version AS draft_version,d.data AS draft_data,
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
          productDraft: row.draft_id ? { id: row.draft_id, version: Number(row.draft_version || 1) } : null,
        };
      });
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
        const strategy = await client.query(
          `SELECT strategy_key FROM ai_content_strategy_versions
            WHERE id=$1 AND account_id=$2 AND status='PUBLISHED' FOR SHARE`,
          [graph.strategyVersionId, graph.accountId],
        );
        if (!strategy.rows[0]) throw repositoryError("AUTO_LISTING_STRATEGY_NOT_PUBLISHED", 409);
        const rules = await client.query(
          `SELECT id,rule_order,rule_kind,category_id,ancestor_category_id,product_style,rule
             FROM ai_content_strategy_rules WHERE account_id=$1 AND strategy_version_id=$2
             ORDER BY rule_order ASC,id ASC`,
          [graph.accountId, graph.strategyVersionId],
        );
        for (const item of graph.items) {
          const source = await client.query(
            `SELECT 1 FROM collect_items
              WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL FOR SHARE`,
            [item.sourceRecordId, graph.accountId],
          );
          if (!source.rows[0]) throw repositoryError("AUTO_LISTING_SOURCE_NOT_FOUND", 404);
          if (item.status === "SOURCE_READY" && item.strategyId !== strategy.rows[0].strategy_key) {
            throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
          }
          if (item.status === "SOURCE_READY") {
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
          const target = await loadWarehouseWithClient(client, {
            accountId: graph.accountId, targetStoreId: item.targetStoreId, targetWarehouseId: item.targetWarehouseId,
          });
          if (!target.warehouse) throw repositoryError("AUTO_LISTING_WAREHOUSE_NOT_FOUND", 404);
          const platformWarehouseId = typeof target.warehouse.warehouse_id === "string"
            ? target.warehouse.warehouse_id.trim() : "";
          if (!platformWarehouseId || platformWarehouseId.toLowerCase().startsWith("wh_")) {
            const failure = repositoryError("LISTING_WAREHOUSE_NOT_ELIGIBLE", 422);
            failure.body = { reason: "WAREHOUSE_ID_MISSING" };
            throw failure;
          }
          assertListingStockSelectionEligible({
            warehouses: [target.warehouse], products: target.products,
            stocks: [{ warehouse_id: target.warehouse.warehouse_id }],
            targetStoreId: item.targetStoreId, accountId: graph.accountId,
          });
        }
        const jobId = newId("auto_listing_job");
        await client.query(
          `INSERT INTO auto_listing_jobs (
             id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
             strategy_version_id,created_by,correlation_id
           ) VALUES ($1,$2,$3,'CREATED',$4,$5::jsonb,$6,$7,$8,$9)`,
          [jobId, graph.accountId, graph.sourceType, graph.idempotencyKey, json(graph.configSnapshot), graph.configHash,
            graph.strategyVersionId, graph.actorAccountId, graph.correlationId],
        );
        for (const item of graph.items) {
          const proposedSnapshotId = newId("auto_listing_snapshot");
          const insertedSnapshot = await client.query(
            `INSERT INTO auto_listing_source_snapshots (
               id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref
             ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
             ON CONFLICT (account_id,source_type,source_record_id,source_version) DO NOTHING
             RETURNING id,snapshot_hash`,
            [proposedSnapshotId, graph.accountId, item.sourceType, item.sourceRecordId, item.sourceVersion,
              json(item.snapshot), item.snapshotHash, item.rawResponseRef],
          );
          const persistedSnapshot = insertedSnapshot.rows[0] || (await client.query(
            `SELECT id,snapshot_hash FROM auto_listing_source_snapshots
              WHERE account_id=$1 AND source_type=$2 AND source_record_id=$3 AND source_version=$4 FOR SHARE`,
            [graph.accountId, item.sourceType, item.sourceRecordId, item.sourceVersion],
          )).rows[0];
          if (!persistedSnapshot || persistedSnapshot.snapshot_hash !== item.snapshotHash) {
            throw repositoryError("AUTO_LISTING_SOURCE_VERSION_CONFLICT", 409);
          }
          const snapshotId = persistedSnapshot.id;
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
              `SELECT e.account_id,e.job_id,e.item_id,e.event_type,e.from_status,e.to_status,e.details
                 FROM auto_listing_events e
                 JOIN auto_listing_jobs j ON j.id=e.job_id AND j.account_id=e.account_id
                WHERE e.account_id=$1 AND e.item_id=$2 AND e.job_id=$3 AND j.account_id=$1
                ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
              [scope, id, row.job_id],
            );
            recoveryPoint = recoveryPointFromLatestLegacyFailure(legacyFailure.rows[0], row, scope);
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
        if (!updated.rows[0]) throw repositoryError("AUTO_LISTING_VERSION_CONFLICT", 409);
        await client.query(
          `INSERT INTO auto_listing_events (
             id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,correlation_id,details
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [`${id}_${String(expectedStatusVersion + 2).padStart(2, "0")}`, scope, row.job_id, id,
            actorAccountId, row.status, nextStatus, eventType, correlationId, json(persistedDetails)],
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

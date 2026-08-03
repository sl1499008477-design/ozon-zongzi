import crypto from "node:crypto";

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
      ORDER BY i.created_at ASC,i.id ASC`,
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
  if (!Array.isArray(graph.items) || !graph.items.length) throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
  return { ...graph, accountId, idempotencyKey };
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
                raw.id AS raw_response_ref,raw.payload AS raw_payload
           FROM collect_items c
           LEFT JOIN product_drafts d ON d.id=c.current_draft_id AND d.collect_item_id=c.id
           LEFT JOIN LATERAL (
             SELECT id,payload FROM collect_raw_payloads
              WHERE collect_item_id=c.id AND account_id=c.account_id
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
          sourceVersion: String(row.draft_version || 1),
          rawResponseRef: row.raw_response_ref || null,
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
      const warehouseResult = await pool.query(
        `SELECT w.id,w.store_id,w.warehouse_id,w.name,w.warehouse_type,w.status,w.is_active,w.is_archived,
                s.owner_account_id
           FROM warehouses w JOIN stores s ON s.id=w.store_id
          WHERE w.id=$1 AND w.store_id=$2 AND s.owner_account_id=$3`,
        [warehouseId, storeId, scope],
      );
      const row = warehouseResult.rows[0];
      if (!row) return { warehouse: null, products: [] };
      const associations = await pool.query(
        `SELECT ps.source
           FROM product_stocks ps
           JOIN products p ON p.id=ps.product_id AND p.store_id=$2
           JOIN stores s ON s.id=p.store_id AND s.owner_account_id=$3
          WHERE ps.warehouse_id=$1 AND ps.store_id=$2
            AND COALESCE(p.status,'') <> 'ARCHIVED'
            AND COALESCE(p.raw->>'is_archived','false') <> 'true'`,
        [row.id, storeId, scope],
      );
      return {
        warehouse: {
          id: row.id,
          storeId: row.store_id,
          accountId: row.owner_account_id,
          warehouse_id: row.warehouse_id,
          name: row.name,
          warehouse_type: row.warehouse_type,
          status: row.status,
          is_active: row.is_active,
          is_archived: row.is_archived,
        },
        products: associations.rows.map((association) => ({
          accountId: scope,
          storeId,
          warehouse_stocks: [{ warehouse_id: row.warehouse_id, source: association.source }],
        })),
      };
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
          const existingSnapshot = await client.query(
            `SELECT id,snapshot_hash FROM auto_listing_source_snapshots
              WHERE account_id=$1 AND source_type=$2 AND source_record_id=$3 AND source_version=$4 FOR SHARE`,
            [graph.accountId, item.sourceType, item.sourceRecordId, item.sourceVersion],
          );
          let snapshotId = existingSnapshot.rows[0]?.id;
          if (snapshotId) {
            if (existingSnapshot.rows[0].snapshot_hash !== item.snapshotHash) {
              throw repositoryError("AUTO_LISTING_SOURCE_VERSION_CONFLICT", 409);
            }
          } else {
            snapshotId = newId("auto_listing_snapshot");
            await client.query(
              `INSERT INTO auto_listing_source_snapshots (
                 id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref
               ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
              [snapshotId, graph.accountId, item.sourceType, item.sourceRecordId, item.sourceVersion,
                json(item.snapshot), item.snapshotHash, item.rawResponseRef],
            );
          }
          const itemId = newId("auto_listing_item");
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

    async updateItemStatus({ accountId, itemId, expectedStatusVersion, status, failureCode = null } = {}) {
      const scope = requiredAccountId(accountId);
      const id = requiredText(itemId);
      if (!Number.isInteger(expectedStatusVersion) || expectedStatusVersion < 1 || !requiredText(status)) {
        throw repositoryError("AUTO_LISTING_REPOSITORY_INVALID");
      }
      const updated = await pool.query(
        `UPDATE auto_listing_job_items SET status=$1,status_version=status_version+1,
                failure_code=$2,failure_detail_safe=$2,updated_at=NOW()
          WHERE id=$3 AND account_id=$4 AND status_version=$5
          RETURNING id,status,status_version`,
        [status, failureCode, id, scope, expectedStatusVersion],
      );
      if (updated.rows[0]) return updated.rows[0];
      const exists = await pool.query(
        `SELECT 1 FROM auto_listing_job_items WHERE id=$1 AND account_id=$2`,
        [id, scope],
      );
      if (!exists.rows[0]) throw repositoryError("AUTO_LISTING_JOB_NOT_FOUND", 404);
      throw repositoryError("AUTO_LISTING_VERSION_CONFLICT", 409);
    },
  };
}

import crypto from "node:crypto";
import { verifyAutoListingFrozenConfig } from "./auto-listing-contract.mjs";
import { listingWarehouseEligibility } from "./listing-warehouse-eligibility.mjs";
import { validateTargetStoreRecord } from "./listing-submission-policy.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function preferenceError(code, status = 422, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_PREFERENCES_PERSIST_FAILED"
    ? "自动上架偏好设置暂时无法保存" : code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw preferenceError("AUTO_LISTING_PREFERENCES_INVALID");
  return result;
}

function fromRow(row) {
  if (!row) return null;
  return Object.freeze({
    accountId: row.account_id,
    targetStoreId: row.target_store_id,
    targetWarehouseId: row.target_warehouse_id,
    stock: Number(row.stock),
    priceAdjustmentKopecks: String(row.price_adjustment_kopecks),
    image: row.image_config,
    configVersion: Number(row.config_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function eventId(accountId, idempotencyKey) {
  return `audit_auto_listing_pref_${crypto.createHash("sha256").update(`${accountId}\0${idempotencyKey}`, "utf8").digest("hex").slice(0, 40)}`;
}

function normalizeInput(input) {
  const accountId = id(input?.accountId);
  if (id(input?.actorId) !== accountId) throw preferenceError("AUTO_LISTING_PREFERENCES_INVALID");
  const expectedVersion = Number(input?.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2_147_483_646) {
    throw preferenceError("AUTO_LISTING_PREFERENCES_INVALID");
  }
  let frozen;
  try { frozen = verifyAutoListingFrozenConfig(input.config, input.configHash); } catch {
    throw preferenceError("AUTO_LISTING_PREFERENCES_INVALID");
  }
  return {
    accountId,
    actorId: accountId,
    expectedVersion,
    idempotencyKey: id(input.idempotencyKey),
    correlationId: id(input.correlationId),
    config: frozen.config,
    configHash: frozen.configHash,
  };
}

function validateTarget(row, input) {
  try {
    validateTargetStoreRecord({
      accountId: input.accountId,
      targetStoreId: input.config.targetStoreId,
      store: row ? {
        id: row.store_id,
        ownerAccountId: row.owner_account_id,
        status: row.store_status,
        clientId: row.client_id,
        credentialsSaved: row.credentials_saved === true,
      } : null,
    });
    const eligibility = listingWarehouseEligibility({
      warehouse: row ? {
        id: row.warehouse_record_id,
        storeId: row.store_id,
        accountId: row.owner_account_id,
        warehouse_id: row.warehouse_id,
        warehouse_type: row.warehouse_type,
        status: row.warehouse_status,
        is_active: row.is_active,
        is_archived: row.is_archived,
      } : null,
      targetStoreId: input.config.targetStoreId,
      accountId: input.accountId,
      hasActiveProductAssociation: row?.has_active_product_association === true,
    });
    if (!eligibility.eligible || row?.warehouse_record_id !== input.config.targetWarehouseId) {
      throw preferenceError("LISTING_WAREHOUSE_NOT_ELIGIBLE", 422);
    }
  } catch (error) {
    if (["TARGET_STORE_NOT_FOUND", "TARGET_STORE_DISABLED", "TARGET_STORE_CREDENTIALS_REQUIRED",
      "LISTING_WAREHOUSE_NOT_ELIGIBLE"].includes(error?.code)) throw error;
    throw preferenceError("LISTING_WAREHOUSE_NOT_ELIGIBLE", 422);
  }
}

async function rollback(client) {
  try { await client.query("ROLLBACK"); } catch { /* best effort */ }
}

export function createPostgresAutoListingPreferencesRepository({ pool } = {}) {
  if (typeof pool?.query !== "function" || typeof pool?.connect !== "function") {
    throw preferenceError("AUTO_LISTING_PREFERENCES_INVALID");
  }
  const direct = async (sql, params) => {
    try { return await pool.query(sql, params); } catch {
      throw preferenceError("AUTO_LISTING_PREFERENCES_PERSIST_FAILED", 503, true);
    }
  };
  return Object.freeze({
    async getPreferences(input = {}) {
      const accountId = id(input.accountId);
      const result = await direct("SELECT * FROM auto_listing_preferences WHERE account_id=$1", [accountId]);
      const row = fromRow(result.rows?.[0]);
      if (row && row.accountId !== accountId) throw preferenceError("AUTO_LISTING_PREFERENCES_PERSIST_FAILED", 503, true);
      return row;
    },

    async savePreferences(rawInput = {}) {
      const input = normalizeInput(rawInput);
      const auditId = eventId(input.accountId, input.idempotencyKey);
      const requestHash = hash({
        accountId: input.accountId, expectedVersion: input.expectedVersion, configHash: input.configHash,
      });
      let client;
      try { client = await pool.connect(); } catch {
        throw preferenceError("AUTO_LISTING_PREFERENCES_PERSIST_FAILED", 503, true);
      }
      let committed = false;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '25s'");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
        const account = await client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [input.accountId]);
        if (!account.rows?.[0]) throw preferenceError("AUTO_LISTING_PREFERENCES_ACCOUNT_NOT_FOUND", 404);
        const audit = await client.query(
          `SELECT metadata FROM audit_events
            WHERE event_id=$1 AND account_id=$2 AND action='AUTO_LISTING_PREFERENCES_SAVE'
            FOR UPDATE`,
          [auditId, input.accountId],
        );
        const replay = audit.rows?.[0]?.metadata;
        if (replay) {
          if (replay.requestHash !== requestHash || replay.configHash !== input.configHash
            || !replay.config || !Number.isInteger(replay.configVersion)) {
            throw preferenceError("AUTO_LISTING_PREFERENCES_IDEMPOTENCY_CONFLICT", 409);
          }
          await client.query("COMMIT");
          committed = true;
          return Object.freeze({ accountId: input.accountId, ...replay.config, configVersion: replay.configVersion });
        }
        const currentResult = await client.query(
          "SELECT * FROM auto_listing_preferences WHERE account_id=$1 FOR UPDATE",
          [input.accountId],
        );
        const current = fromRow(currentResult.rows?.[0]);
        const currentVersion = current?.configVersion ?? 0;
        if (currentVersion !== input.expectedVersion) {
          throw preferenceError("AUTO_LISTING_PREFERENCES_VERSION_CONFLICT", 409);
        }
        const target = await client.query(
          `SELECT s.id AS store_id,s.owner_account_id,s.status AS store_status,s.client_id,
                  EXISTS(SELECT 1 FROM store_credentials sc WHERE sc.store_id=s.id) AS credentials_saved,
                  w.id AS warehouse_record_id,w.warehouse_id,w.warehouse_type,w.status AS warehouse_status,
                  w.is_active,w.is_archived,
                  EXISTS(
                    SELECT 1 FROM product_stocks ps
                    JOIN products p ON p.id=ps.product_id AND p.store_id=s.id
                    WHERE ps.store_id=s.id AND ps.warehouse_id=w.id
                      AND COALESCE(ps.source,'')='fbs'
                      AND COALESCE(p.status,'') <> 'ARCHIVED'
                      AND COALESCE(p.raw->>'is_archived','false') <> 'true'
                  ) AS has_active_product_association
             FROM stores s JOIN warehouses w ON w.store_id=s.id
            WHERE s.owner_account_id=$1 AND s.id=$2 AND w.id=$3
            FOR UPDATE OF s,w`,
          [input.accountId, input.config.targetStoreId, input.config.targetWarehouseId],
        );
        validateTarget(target.rows?.[0], input);
        const nextVersion = currentVersion + 1;
        const savedResult = current ? await client.query(
          `UPDATE auto_listing_preferences
              SET target_store_id=$2,target_warehouse_id=$3,stock=$4,price_adjustment_kopecks=$5,
                  image_config=$6::JSONB,config_version=$7,updated_by=$1,updated_at=NOW()
            WHERE account_id=$1 AND config_version=$8 RETURNING *`,
          [input.accountId, input.config.targetStoreId, input.config.targetWarehouseId, input.config.stock,
            input.config.priceAdjustmentKopecks, JSON.stringify(input.config.image), nextVersion, currentVersion],
        ) : await client.query(
          `INSERT INTO auto_listing_preferences (
             account_id,target_store_id,target_warehouse_id,stock,price_adjustment_kopecks,
             image_config,config_version,updated_by
           ) VALUES ($1,$2,$3,$4,$5,$6::JSONB,1,$1) RETURNING *`,
          [input.accountId, input.config.targetStoreId, input.config.targetWarehouseId, input.config.stock,
            input.config.priceAdjustmentKopecks, JSON.stringify(input.config.image)],
        );
        const saved = fromRow(savedResult.rows?.[0]);
        if (!saved || saved.accountId !== input.accountId || saved.configVersion !== nextVersion) {
          throw preferenceError("AUTO_LISTING_PREFERENCES_PERSIST_FAILED", 503, true);
        }
        const metadata = {
          requestHash,
          configHash: input.configHash,
          configVersion: saved.configVersion,
          config: input.config,
        };
        const insertedAudit = await client.query(
          `INSERT INTO audit_events (
             event_id,account_id,store_id,action,status,actor_type,actor_id,device_id,source,
             entity_type,entity_id,correlation_id,metadata,occurred_at,created_at
           ) VALUES ($1,$2,$3,'AUTO_LISTING_PREFERENCES_SAVE','SUCCESS','account',$2,'','auto-listing-user',
             'auto_listing_preferences',$2,$4,$5::JSONB,NOW(),NOW())
           ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING RETURNING event_id`,
          [auditId, input.accountId, input.config.targetStoreId, input.correlationId, JSON.stringify(metadata)],
        );
        if (insertedAudit.rowCount !== 1) throw preferenceError("AUTO_LISTING_PREFERENCES_IDEMPOTENCY_CONFLICT", 409);
        await client.query("COMMIT");
        committed = true;
        return saved;
      } catch (error) {
        if (!committed) await rollback(client);
        if (typeof error?.code === "string" && (
          error.code.startsWith("AUTO_LISTING_PREFERENCES_")
          || error.code.startsWith("TARGET_STORE_") || error.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE"
        )) throw error;
        throw preferenceError("AUTO_LISTING_PREFERENCES_PERSIST_FAILED", 503, true);
      } finally {
        try { client.release(); } catch { /* best effort */ }
      }
    },
  });
}

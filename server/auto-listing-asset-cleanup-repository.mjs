import crypto from "node:crypto";
import { GENERATED_ASSET_OBJECT_KEY_VERSIONS, verifyGeneratedAssetObjectKey } from "./auto-listing-asset-store.mjs";

const HASH = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/;
const SCOPE_KEYS = ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey"];
const IMMUTABLE_KEYS = [...SCOPE_KEYS, "attemptIdentityHash", "inputHash", "attemptNo", "objectKeyVersion", "objectKey", "contentHash", "reason", "originalErrorCode"];
const clean = (value, max = 240) => typeof value === "string" && value.trim() && value === value.trim()
  && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
const copy = (value) => structuredClone(value);
const DEFAULT_BASE_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRY_MS = 24 * 60 * 60 * 1000;

function problem(code) {
  const error = new Error("图片清理义务无效");
  error.code = code;
  error.retryable = code === "AUTO_LISTING_ASSET_CLEANUP_REPOSITORY_FAILED";
  return error;
}

function milliseconds(value) {
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(result)) throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  return result;
}

function lifecycleConfig({ baseRetryMs, maxRetryMs }) {
  if (!Number.isInteger(baseRetryMs) || baseRetryMs < 1 || !Number.isInteger(maxRetryMs) || maxRetryMs < baseRetryMs) {
    throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  }
  return { baseRetryMs, maxRetryMs };
}

function claimRequest(input) {
  const accountId = account(input);
  const workerId = clean(input?.workerId);
  if (!workerId || !Number.isInteger(input?.limit) || input.limit < 1 || input.limit > 100
    || !Number.isInteger(input?.leaseMs) || input.leaseMs < 1 || input.leaseMs > 24 * 60 * 60 * 1000) {
    throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  }
  return { accountId, workerId, limit: input.limit, leaseMs: input.leaseMs };
}

function ownership(input, { requireError = false } = {}) {
  const value = {
    accountId: account(input),
    id: clean(input?.id),
    workerId: clean(input?.workerId),
    claimToken: clean(input?.claimToken),
    errorCode: requireError ? clean(input?.errorCode) : null,
  };
  if (!value.id || !value.workerId || !value.claimToken || (requireError && !ERROR_CODE.test(value.errorCode))) {
    throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  }
  return value;
}

const retryDelay = (attemptCount, { baseRetryMs, maxRetryMs }) => Math.min(
  maxRetryMs,
  baseRetryMs * (2 ** Math.min(Math.max(attemptCount - 1, 0), 30)),
);

function normalized(input) {
  if (!input || !SCOPE_KEYS.every((key) => clean(input[key])) || !HASH.test(input.attemptIdentityHash || "")
    || !HASH.test(input.inputHash || "") || !HASH.test(input.contentHash || "")
    || !Number.isInteger(input.attemptNo) || input.attemptNo < 1 || input.attemptNo > 3
    || input.objectKeyVersion !== GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
    || !clean(input.reason) || !clean(input.originalErrorCode) || !verifyGeneratedAssetObjectKey(input)) {
    throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  }
  return Object.freeze(Object.fromEntries(IMMUTABLE_KEYS.map((key) => [key, input[key]])));
}

const dedupeKey = (value) => crypto.createHash("sha256")
  .update(`${value.accountId}\u0000${value.attemptIdentityHash}\u0000${value.attemptNo}\u0000${value.objectKey}`).digest("hex");
const same = (left, right) => IMMUTABLE_KEYS.every((key) => left[key] === right[key]);
const account = (value) => {
  const accountId = clean(value?.accountId);
  if (!accountId) throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  return accountId;
};

export function createMemoryAssetCleanupRepository({
  now = () => Date.now(),
  token = () => crypto.randomUUID(),
  findGenerationAssetReference = async () => null,
  baseRetryMs = DEFAULT_BASE_RETRY_MS,
  maxRetryMs = DEFAULT_MAX_RETRY_MS,
} = {}) {
  if (typeof now !== "function" || typeof token !== "function" || typeof findGenerationAssetReference !== "function") {
    throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  }
  const retryConfig = lifecycleConfig({ baseRetryMs, maxRetryMs });
  const rows = new Map();
  const replace = (row) => { rows.set(row.dedupeKey, Object.freeze(row)); return copy(row); };
  const claimed = (value) => {
    const row = [...rows.values()].find((candidate) => candidate.id === value.id && candidate.accountId === value.accountId);
    const timestamp = milliseconds(now());
    if (!row || row.status !== "PROCESSING" || row.claimOwner !== value.workerId
      || row.claimToken !== value.claimToken || row.claimExpiresAt <= timestamp) {
      throw problem("AUTO_LISTING_ASSET_CLEANUP_CLAIM_REJECTED");
    }
    return { row, timestamp };
  };
  return Object.freeze({
    async recordAssetCleanupRequired(input) {
      const value = normalized(input);
      const key = dedupeKey(value);
      const existing = rows.get(key);
      if (existing) {
        if (!same(existing, value)) throw problem("AUTO_LISTING_ASSET_CLEANUP_CONFLICT");
        return copy(existing);
      }
      const timestamp = milliseconds(now());
      const row = Object.freeze({ id: `cleanup-${key}`, dedupeKey: key, ...value, status: "PENDING", attemptCount: 0,
        createdAt: timestamp, updatedAt: timestamp, nextRetryAt: timestamp });
      rows.set(key, row);
      return copy(row);
    },
    async listAssetCleanupObligations(input) {
      const accountId = account(input);
      return [...rows.values()].filter((row) => row.accountId === accountId).map(copy);
    },
    async claimAssetCleanupObligations(input) {
      const request = claimRequest(input);
      const timestamp = milliseconds(now());
      const candidates = [...rows.values()]
        .filter((row) => row.accountId === request.accountId
          && ((row.status === "PENDING" && row.nextRetryAt <= timestamp)
            || (row.status === "PROCESSING" && row.claimExpiresAt <= timestamp)))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .slice(0, request.limit);
      return candidates.map((row) => {
        const nonce = clean(token(), 120);
        const claimToken = nonce ? `${nonce}:${row.attemptCount + 1}` : "";
        if (!clean(claimToken)) throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
        return replace({ ...row, status: "PROCESSING", attemptCount: row.attemptCount + 1,
          claimToken, claimOwner: request.workerId, claimExpiresAt: timestamp + request.leaseMs, updatedAt: timestamp });
      });
    },
    async completeAssetCleanup(input) {
      const value = ownership(input);
      const { row, timestamp } = claimed(value);
      return replace({ ...row, status: "COMPLETED", claimToken: null, claimOwner: null,
        claimExpiresAt: null, updatedAt: timestamp });
    },
    async adoptAssetCleanupIfReferenced(input) {
      const value = ownership(input);
      const { row, timestamp } = claimed(value);
      const reference = await findGenerationAssetReference({ accountId: row.accountId, objectKey: row.objectKey });
      if (reference == null) return Object.freeze({ status: "UNREFERENCED" });
      if (reference.accountId !== row.accountId || reference.objectKey !== row.objectKey
        || !clean(reference.id) || !clean(reference.status)) throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
      const record = replace({ ...row, status: "ADOPTED", claimToken: null, claimOwner: null, claimExpiresAt: null,
        adoptedAt: timestamp, adoptedGenerationAssetId: reference.id,
        adoptedGenerationAssetStatus: reference.status, updatedAt: timestamp });
      return Object.freeze({ status: "ADOPTED", record });
    },
    async failAssetCleanup(input) {
      const value = ownership(input, { requireError: true });
      const { row, timestamp } = claimed(value);
      return replace({ ...row, status: "PENDING", claimToken: null, claimOwner: null, claimExpiresAt: null,
        lastErrorCode: value.errorCode, nextRetryAt: timestamp + retryDelay(row.attemptCount, retryConfig), updatedAt: timestamp });
    },
  });
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id, dedupeKey: row.dedupe_key, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    planId: row.plan_id, visualGroupKey: row.visual_group_key, slotKey: row.slot_key,
    attemptIdentityHash: row.attempt_identity_hash, inputHash: row.input_hash, attemptNo: row.attempt_no,
    objectKeyVersion: row.object_key_version, objectKey: row.object_key, contentHash: row.content_hash, reason: row.reason, originalErrorCode: row.original_error_code,
    status: row.status, attemptCount: row.attempt_count, claimToken: row.claim_token, claimOwner: row.claim_owner,
    claimExpiresAt: row.claim_expires_at, lastErrorCode: row.last_error_code,
    adoptedAt: row.adopted_at, adoptedGenerationAssetId: row.adopted_generation_asset_id,
    adoptedGenerationAssetStatus: row.adopted_generation_asset_status,
    createdAt: row.created_at, updatedAt: row.updated_at, nextRetryAt: row.next_retry_at,
  };
}

export function createPostgresAssetCleanupRepository({
  pool,
  token = () => crypto.randomUUID(),
  baseRetryMs = DEFAULT_BASE_RETRY_MS,
  maxRetryMs = DEFAULT_MAX_RETRY_MS,
} = {}) {
  if (typeof pool?.query !== "function" || typeof token !== "function") throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  const retryConfig = lifecycleConfig({ baseRetryMs, maxRetryMs });
  const query = async (...args) => {
    try { return await pool.query(...args); } catch { throw problem("AUTO_LISTING_ASSET_CLEANUP_REPOSITORY_FAILED"); }
  };
  return Object.freeze({
    async recordAssetCleanupRequired(input) {
      const value = normalized(input); const key = dedupeKey(value); const timestamp = new Date();
      const parameters = [`cleanup-${key}`, key, ...IMMUTABLE_KEYS.map((field) => value[field]), timestamp];
      const inserted = await query(
        `INSERT INTO auto_listing_asset_cleanup_obligations (
          id,dedupe_key,account_id,job_id,item_id,plan_id,visual_group_key,slot_key,
          attempt_identity_hash,input_hash,attempt_no,object_key_version,object_key,content_hash,reason,original_error_code,
          status,attempt_count,created_at,updated_at,next_retry_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'PENDING',0,$17,$17,$17)
        ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`, parameters);
      let row = fromRow(inserted.rows?.[0]);
      if (!row) {
        const found = await query("SELECT * FROM auto_listing_asset_cleanup_obligations WHERE account_id=$1 AND dedupe_key=$2", [value.accountId, key]);
        row = fromRow(found.rows?.[0]);
      }
      if (!row || !same(row, value)) throw problem("AUTO_LISTING_ASSET_CLEANUP_CONFLICT");
      return Object.freeze(row);
    },
    async listAssetCleanupObligations(input) {
      const accountId = account(input);
      const result = await query("SELECT * FROM auto_listing_asset_cleanup_obligations WHERE account_id=$1 ORDER BY created_at,id", [accountId]);
      return (result.rows || []).map(fromRow);
    },
    async claimAssetCleanupObligations(input) {
      const request = claimRequest(input);
      const nonce = clean(token(), 120);
      if (!nonce) throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
      const result = await query(
        `WITH candidates AS (
           SELECT id FROM auto_listing_asset_cleanup_obligations
           WHERE account_id=$1
             AND ((status='PENDING' AND next_retry_at <= NOW())
               OR (status='PROCESSING' AND claim_expires_at <= NOW()))
           ORDER BY created_at,id
           LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         UPDATE auto_listing_asset_cleanup_obligations AS obligation
         SET status='PROCESSING',attempt_count=obligation.attempt_count+1,
             claim_owner=$3,claim_token=$4 || ':' || (obligation.attempt_count+1)::text,
             claim_expires_at=NOW()+($5 * INTERVAL '1 millisecond'),updated_at=NOW()
         FROM candidates
         WHERE obligation.id=candidates.id AND obligation.account_id=$1
         RETURNING obligation.*`,
        [request.accountId, request.limit, request.workerId, nonce, request.leaseMs],
      );
      return (result.rows || []).map(fromRow);
    },
    async completeAssetCleanup(input) {
      const value = ownership(input);
      const result = await query(
        `UPDATE auto_listing_asset_cleanup_obligations
         SET status='COMPLETED',claim_token=NULL,claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW()
         WHERE account_id=$1 AND id=$2 AND status='PROCESSING' AND claim_owner=$3 AND claim_token=$4
           AND claim_expires_at > NOW()
         RETURNING *`,
        [value.accountId, value.id, value.workerId, value.claimToken],
      );
      const row = fromRow(result.rows?.[0]);
      if (!row) throw problem("AUTO_LISTING_ASSET_CLEANUP_CLAIM_REJECTED");
      return row;
    },
    async adoptAssetCleanupIfReferenced(input) {
      const value = ownership(input);
      const result = await query(
        `WITH owned AS MATERIALIZED (
           SELECT obligation.id,obligation.account_id,obligation.object_key
           FROM auto_listing_asset_cleanup_obligations AS obligation
           WHERE obligation.account_id=$1 AND obligation.id=$2 AND obligation.status='PROCESSING'
             AND obligation.claim_owner=$3 AND obligation.claim_token=$4 AND obligation.claim_expires_at > NOW()
           FOR UPDATE
         ), reference AS (
           SELECT asset.id,asset.status
           FROM ai_generation_assets AS asset
           JOIN owned ON asset.account_id=owned.account_id AND asset.object_key=owned.object_key
           ORDER BY asset.created_at,asset.id
           LIMIT 1
         ), adopted AS (
           UPDATE auto_listing_asset_cleanup_obligations AS obligation
           SET status='ADOPTED',claim_token=NULL,claim_owner=NULL,claim_expires_at=NULL,
               adopted_at=NOW(),adopted_generation_asset_id=reference.id,
               adopted_generation_asset_status=reference.status,updated_at=NOW()
           FROM owned,reference
           WHERE obligation.id=owned.id AND obligation.account_id=owned.account_id
           RETURNING obligation.*
         )
         SELECT EXISTS(SELECT 1 FROM owned) AS ownership_matched,
                EXISTS(SELECT 1 FROM reference) AS reference_found,
                (SELECT row_to_json(adopted) FROM adopted) AS adopted_record`,
        [value.accountId, value.id, value.workerId, value.claimToken],
      );
      const disposition = result.rows?.[0];
      if (!disposition?.ownership_matched) throw problem("AUTO_LISTING_ASSET_CLEANUP_CLAIM_REJECTED");
      if (!disposition.reference_found) return Object.freeze({ status: "UNREFERENCED" });
      const record = fromRow(disposition.adopted_record);
      if (!record || record.status !== "ADOPTED") throw problem("AUTO_LISTING_ASSET_CLEANUP_REPOSITORY_FAILED");
      return Object.freeze({ status: "ADOPTED", record });
    },
    async failAssetCleanup(input) {
      const value = ownership(input, { requireError: true });
      const result = await query(
        `UPDATE auto_listing_asset_cleanup_obligations
         SET status='PENDING',claim_token=NULL,claim_owner=NULL,claim_expires_at=NULL,
             last_error_code=$5,
             next_retry_at=NOW()+(
               LEAST($6::bigint,$7::bigint * CAST(POWER(2,LEAST(GREATEST(attempt_count-1,0),30)) AS bigint))
               * INTERVAL '1 millisecond'
             ),updated_at=NOW()
         WHERE account_id=$1 AND id=$2 AND status='PROCESSING' AND claim_owner=$3 AND claim_token=$4
           AND claim_expires_at > NOW()
         RETURNING *`,
        [value.accountId, value.id, value.workerId, value.claimToken, value.errorCode, retryConfig.maxRetryMs, retryConfig.baseRetryMs],
      );
      const row = fromRow(result.rows?.[0]);
      if (!row) throw problem("AUTO_LISTING_ASSET_CLEANUP_CLAIM_REJECTED");
      return row;
    },
  });
}

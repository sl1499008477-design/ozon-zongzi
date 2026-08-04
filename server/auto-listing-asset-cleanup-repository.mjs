import crypto from "node:crypto";
import { buildGeneratedAssetObjectKey } from "./auto-listing-asset-store.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SCOPE_KEYS = ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey"];
const IMMUTABLE_KEYS = [...SCOPE_KEYS, "attemptIdentityHash", "inputHash", "attemptNo", "objectKey", "contentHash", "reason", "originalErrorCode"];
const clean = (value, max = 240) => typeof value === "string" && value.trim() && value === value.trim()
  && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
const copy = (value) => structuredClone(value);

function problem(code) {
  const error = new Error("图片清理义务无效");
  error.code = code;
  error.retryable = code === "AUTO_LISTING_ASSET_CLEANUP_REPOSITORY_FAILED";
  return error;
}

function normalized(input) {
  if (!input || !SCOPE_KEYS.every((key) => clean(input[key])) || !HASH.test(input.attemptIdentityHash || "")
    || !HASH.test(input.inputHash || "") || !HASH.test(input.contentHash || "")
    || !Number.isInteger(input.attemptNo) || input.attemptNo < 1 || input.attemptNo > 3
    || !clean(input.reason) || !clean(input.originalErrorCode)) throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  let expectedObjectKey;
  try { expectedObjectKey = buildGeneratedAssetObjectKey(input); } catch { throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID"); }
  if (input.objectKey !== expectedObjectKey) throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  return Object.freeze(Object.fromEntries(IMMUTABLE_KEYS.map((key) => [key, input[key]])));
}

const dedupeKey = (value) => crypto.createHash("sha256").update(`${value.accountId}\u0000${value.objectKey}`).digest("hex");
const same = (left, right) => IMMUTABLE_KEYS.every((key) => left[key] === right[key]);
const account = (value) => {
  const accountId = clean(value?.accountId);
  if (!accountId) throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  return accountId;
};

export function createMemoryAssetCleanupRepository({ now = () => Date.now() } = {}) {
  if (typeof now !== "function") throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  const rows = new Map();
  return Object.freeze({
    async recordAssetCleanupRequired(input) {
      const value = normalized(input);
      const key = dedupeKey(value);
      const existing = rows.get(key);
      if (existing) {
        if (!same(existing, value)) throw problem("AUTO_LISTING_ASSET_CLEANUP_CONFLICT");
        return copy(existing);
      }
      const timestamp = now();
      const row = Object.freeze({ id: `cleanup-${key}`, dedupeKey: key, ...value, status: "PENDING", attemptCount: 0,
        createdAt: timestamp, updatedAt: timestamp, nextRetryAt: timestamp });
      rows.set(key, row);
      return copy(row);
    },
    async listAssetCleanupObligations(input) {
      const accountId = account(input);
      return [...rows.values()].filter((row) => row.accountId === accountId).map(copy);
    },
  });
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id, dedupeKey: row.dedupe_key, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    planId: row.plan_id, visualGroupKey: row.visual_group_key, slotKey: row.slot_key,
    attemptIdentityHash: row.attempt_identity_hash, inputHash: row.input_hash, attemptNo: row.attempt_no,
    objectKey: row.object_key, contentHash: row.content_hash, reason: row.reason, originalErrorCode: row.original_error_code,
    status: row.status, attemptCount: row.attempt_count, createdAt: row.created_at, updatedAt: row.updated_at, nextRetryAt: row.next_retry_at,
  };
}

export function createPostgresAssetCleanupRepository({ pool, now = () => new Date() } = {}) {
  if (typeof pool?.query !== "function" || typeof now !== "function") throw problem("AUTO_LISTING_ASSET_CLEANUP_INVALID");
  const query = async (...args) => {
    try { return await pool.query(...args); } catch { throw problem("AUTO_LISTING_ASSET_CLEANUP_REPOSITORY_FAILED"); }
  };
  return Object.freeze({
    async recordAssetCleanupRequired(input) {
      const value = normalized(input); const key = dedupeKey(value); const timestamp = now();
      const parameters = [`cleanup-${key}`, key, ...IMMUTABLE_KEYS.map((field) => value[field]), timestamp];
      const inserted = await query(
        `INSERT INTO auto_listing_asset_cleanup_obligations (
          id,dedupe_key,account_id,job_id,item_id,plan_id,visual_group_key,slot_key,
          attempt_identity_hash,input_hash,attempt_no,object_key,content_hash,reason,original_error_code,
          status,attempt_count,created_at,updated_at,next_retry_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PENDING',0,$16,$16,$16)
        ON CONFLICT (account_id, object_key) DO NOTHING RETURNING *`, parameters);
      let row = fromRow(inserted.rows?.[0]);
      if (!row) {
        const found = await query("SELECT * FROM auto_listing_asset_cleanup_obligations WHERE account_id=$1 AND object_key=$2", [value.accountId, value.objectKey]);
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
  });
}

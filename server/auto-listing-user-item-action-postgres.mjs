import crypto from "node:crypto";

import {
  autoListingAiMessageDedupeKey,
  canonicalizeAutoListingAiMessage,
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";
import { nextAutoListingStatus } from "./auto-listing-state-machine.mjs";
import { enqueueAutoListingUploadTask } from "./auto-listing-upload-task-postgres.mjs";

const INPUT_KEYS = new Set([
  "accountId", "actorAccountId", "jobId", "itemId", "expectedStatusVersion",
  "idempotencyKey", "correlationId",
]);
const MAX_VERSION = 2_147_483_647;
const STATEMENT_TIMEOUT_MS = 25_000;
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_TRANSACTION_TIMEOUT_MS = 30_000;

function actionError(code, retryable = false) {
  const error = new Error("自动上架商品操作失败");
  error.code = code;
  error.retryable = retryable;
  return error;
}

const invalid = () => actionError("AUTO_LISTING_USER_ACTION_INVALID");
const conflict = () => actionError("AUTO_LISTING_USER_ACTION_CONFLICT");
const notAllowed = () => actionError("AUTO_LISTING_USER_ACTION_NOT_ALLOWED");
const failed = () => actionError("AUTO_LISTING_USER_ACTION_FAILED", true);

function ownCode(error) {
  try {
    const descriptor = error && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
  } catch { return null; }
}

function closed(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw invalid();
    const keys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (keys.length !== INPUT_KEYS.size || keys.some((key) => typeof key !== "string"
      || !INPUT_KEYS.has(key) || descriptors[key]?.enumerable !== true
      || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (ownCode(error) === "AUTO_LISTING_USER_ACTION_INVALID") throw error;
    throw invalid();
  }
}

function input(raw) {
  const value = closed(raw);
  for (const key of ["accountId", "actorAccountId", "jobId", "itemId", "idempotencyKey", "correlationId"]) {
    if (!isSafeAutoListingAiIdentifier(value[key])) throw invalid();
  }
  if (value.actorAccountId !== value.accountId
    || !Number.isInteger(value.expectedStatusVersion) || value.expectedStatusVersion < 1
    || value.expectedStatusVersion >= MAX_VERSION) throw invalid();
  return Object.freeze(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function identity(value, action) {
  const requestHash = sha256(JSON.stringify({
    accountId: value.accountId, actorAccountId: value.actorAccountId, jobId: value.jobId,
    itemId: value.itemId, expectedStatusVersion: value.expectedStatusVersion,
    idempotencyKey: value.idempotencyKey, correlationId: value.correlationId, action,
  }));
  return Object.freeze({ requestHash, commandId: `auto-listing-command-${requestHash}` });
}

async function query(client, sql, values = []) {
  try { return await client.query(sql, values); } catch (error) {
    if (String(ownCode(error) || "").startsWith("AUTO_LISTING_USER_ACTION_")) throw error;
    throw failed();
  }
}

async function configure(client) {
  await query(client,
    `SELECT set_config('statement_timeout',$1,TRUE),
            set_config('lock_timeout',$2,TRUE),
            set_config('idle_in_transaction_session_timeout',$3,TRUE)`,
    [String(STATEMENT_TIMEOUT_MS), String(LOCK_TIMEOUT_MS), String(IDLE_TRANSACTION_TIMEOUT_MS)]);
}

function replay(row, value, action, requestHash) {
  if (!row) return null;
  if (row.account_id !== value.accountId || row.actor_account_id !== value.actorAccountId
    || row.job_id !== value.jobId || row.item_id !== value.itemId || row.action !== action
    || row.expected_status_version !== value.expectedStatusVersion
    || row.idempotency_key !== value.idempotencyKey || row.correlation_id !== value.correlationId
    || row.request_hash !== requestHash || typeof row.result_status !== "string"
    || !Number.isInteger(row.result_status_version)
    || row.result_status_version !== value.expectedStatusVersion + 1) throw conflict();
  return Object.freeze({
    status: row.result_status, statusVersion: row.result_status_version, action, duplicate: true,
  });
}

function planMessage(value, expectedStatusVersion) {
  return normalizeAutoListingAiMessage({
    contractVersion: "V1", accountId: value.accountId, itemId: value.itemId,
    phase: "PLAN_CONTENT", expectedStatusVersion, correlationId: value.correlationId,
  });
}

async function execute(pool, raw, action) {
  const value = input(raw);
  const { requestHash, commandId } = identity(value, action);
  let client;
  let committed = false;
  try {
    client = await pool.connect();
    if (!client || typeof client.query !== "function") throw failed();
    await query(client, "BEGIN");
    await configure(client);
    const previous = await query(client,
      `SELECT account_id,job_id,item_id,actor_account_id,action,expected_status_version,
              idempotency_key,correlation_id,request_hash,result_status,result_status_version
         FROM auto_listing_user_commands
        WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [value.accountId, value.idempotencyKey]);
    const duplicate = replay(previous?.rows?.[0] || null, value, action, requestHash);
    if (duplicate) {
      await query(client, "COMMIT");
      committed = true;
      return duplicate;
    }
    const boundary = await query(client,
      `SELECT i.status,i.status_version
         FROM auto_listing_job_items AS i
         JOIN auto_listing_jobs AS j ON j.account_id=i.account_id AND j.id=i.job_id
        WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3
        FOR UPDATE OF i`,
      [value.accountId, value.jobId, value.itemId]);
    const row = boundary?.rowCount === 1 ? boundary.rows?.[0] : null;
    if (!row) throw actionError("AUTO_LISTING_USER_ACTION_NOT_FOUND");
    if (row.status_version !== value.expectedStatusVersion) throw conflict();
    let nextStatus;
    try { nextStatus = nextAutoListingStatus(row.status, action); } catch { throw notAllowed(); }
    if ((action === "REGENERATE" && nextStatus !== "PLANNING")
      || (action === "CANCEL" && nextStatus !== "CANCELLED")
      || (action === "APPROVE_UPLOAD" && nextStatus !== "UPLOAD_QUEUED")) throw notAllowed();
    const nextVersion = value.expectedStatusVersion + 1;
    const updated = await query(client,
      `UPDATE auto_listing_job_items
          SET status=$5,status_version=status_version+1,
              active_content_plan_id=CASE WHEN $5='PLANNING' THEN NULL ELSE active_content_plan_id END,
              recovery_point=NULL,failure_code=NULL,failure_detail_safe=NULL,updated_at=NOW()
        WHERE account_id=$1 AND job_id=$2 AND id=$3 AND status_version=$4 AND status=$6
        RETURNING status,status_version`,
      [value.accountId, value.jobId, value.itemId, value.expectedStatusVersion, nextStatus, row.status]);
    if (updated?.rowCount !== 1 || updated.rows?.[0]?.status !== nextStatus
      || updated.rows[0].status_version !== nextVersion) throw conflict();
    const commandInsert = await query(client,
      `INSERT INTO auto_listing_user_commands (
         id,account_id,job_id,item_id,actor_account_id,action,expected_status_version,
         idempotency_key,correlation_id,request_hash,result_status,result_status_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [commandId, value.accountId, value.jobId, value.itemId, value.actorAccountId, action,
        value.expectedStatusVersion, value.idempotencyKey, value.correlationId, requestHash,
        nextStatus, nextVersion]);
    if (commandInsert?.rowCount !== 1) throw conflict();
    const eventInsert = await query(client,
      `INSERT INTO auto_listing_events (
         id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,
         correlation_id,details,transition_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::JSONB,$11)
       RETURNING id`,
      [`${commandId}-event`, value.accountId, value.jobId, value.itemId, value.actorAccountId,
        row.status, nextStatus, action, value.correlationId,
        JSON.stringify({ commandId, idempotencyKeyHash: sha256(value.idempotencyKey) }), nextVersion]);
    if (eventInsert?.rowCount !== 1) throw conflict();
    if (action === "REGENERATE") {
      const message = planMessage(value, nextVersion);
      const dedupeKey = autoListingAiMessageDedupeKey(message);
      const outbox = await query(client,
        `INSERT INTO auto_listing_ai_outbox (
           id,account_id,job_id,item_id,slot_key,event_type,dedupe_key,payload,state,attempts,
           available_at,contract_version,phase,phase_target_id,expected_status_version,
           correlation_id,next_retry_at
         ) VALUES ($1,$2,$3,$4,NULL,'PLAN_CONTENT',$5,$6::JSONB,'PENDING',0,NOW(),
           'V1','PLAN_CONTENT',NULL,$7,$8,NOW())
         RETURNING id`,
        [`auto-listing-outbox-${dedupeKey}`, value.accountId, value.jobId, value.itemId,
          dedupeKey, canonicalizeAutoListingAiMessage(message), nextVersion, value.correlationId]);
      if (outbox?.rowCount !== 1) throw conflict();
    }
    if (action === "APPROVE_UPLOAD") {
      await enqueueAutoListingUploadTask({ client, accountId: value.accountId, jobId: value.jobId,
        itemId: value.itemId, actorAccountId: value.actorAccountId, expectedStatusVersion: nextVersion,
        correlationId: value.correlationId, enqueueReason: "REVIEW_APPROVED" });
    }
    await query(client, "COMMIT");
    committed = true;
    return Object.freeze({ status: nextStatus, statusVersion: nextVersion, action, duplicate: false });
  } catch (error) {
    if (client?.query && !committed) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    if (String(ownCode(error) || "").startsWith("AUTO_LISTING_USER_ACTION_")) throw error;
    throw failed();
  } finally {
    try { client?.release?.(); } catch {}
  }
}

export function createPostgresAutoListingUserItemActionRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("PostgreSQL pool is required for auto-listing user item actions");
  }
  return Object.freeze({
    cancelItem: (value) => execute(pool, value, "CANCEL"),
    regenerateItem: (value) => execute(pool, value, "REGENERATE"),
    approveItem: (value) => execute(pool, value, "APPROVE_UPLOAD"),
  });
}

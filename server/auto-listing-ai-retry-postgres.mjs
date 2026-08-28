import crypto from "node:crypto";

import {
  autoListingAiMessageDedupeKey,
  canonicalizeAutoListingAiMessage,
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";
import { isSafeAutoListingPlanningRetryFailure } from "./auto-listing-state-machine.mjs";

const INPUT_KEYS = new Set(["accountId", "jobId", "itemId", "expectedStatusVersion", "idempotencyKey"]);
const FACTORY_KEYS = new Set(["pool"]);
const STATEMENT_TIMEOUT_MS = 25_000;
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_TRANSACTION_TIMEOUT_MS = 30_000;
const MAX_PLAN_SLOTS = 1_000;
const RECOVERABLE_BLOCKED_FAILURES = new Set([
  "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID",
  "AUTO_LISTING_MAIN_IMAGE_REQUIRED",
  "AUTO_LISTING_MINIMUM_IMAGE_COUNT_NOT_MET",
  "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID",
  "AUTO_LISTING_RICH_CONTENT_ATTEMPTS_EXHAUSTED",
]);

function retryError(code, retryable = false) {
  const error = new Error("自动上架 AI 重试数据操作失败");
  error.code = code;
  error.retryable = retryable;
  return error;
}

const invalid = () => retryError("AUTO_LISTING_AI_RETRY_INVALID");
const failed = () => retryError("AUTO_LISTING_AI_RETRY_FAILED", true);
const conflict = () => retryError("AUTO_LISTING_AI_RETRY_VERSION_CONFLICT");
const notRecoverable = () => retryError("AUTO_LISTING_AI_RETRY_NOT_RECOVERABLE");

function ownErrorCode(error) {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string"
      ? descriptor.value : null;
  } catch {
    return null;
  }
}

function closed(raw, keys) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw invalid();
    const own = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (ownErrorCode(error) === "AUTO_LISTING_AI_RETRY_INVALID") throw error;
    throw invalid();
  }
}

function input(raw) {
  const value = closed(raw, INPUT_KEYS);
  for (const key of ["accountId", "jobId", "itemId", "idempotencyKey"]) {
    if (!isSafeAutoListingAiIdentifier(value[key])) throw invalid();
  }
  if (!Number.isInteger(value.expectedStatusVersion) || value.expectedStatusVersion < 1
    || value.expectedStatusVersion >= 2_147_483_647) throw invalid();
  return value;
}

function deterministicId(prefix, value) {
  return `${prefix}-${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function safeQuery(client, sql, values = []) {
  try { return await client.query(sql, values); } catch (error) {
    if (ownErrorCode(error)?.startsWith("AUTO_LISTING_AI_RETRY_")) throw error;
    throw failed();
  }
}

async function configureTransaction(client) {
  await safeQuery(client,
    `SELECT set_config('statement_timeout',$1,TRUE),
            set_config('lock_timeout',$2,TRUE),
            set_config('idle_in_transaction_session_timeout',$3,TRUE)`,
    [String(STATEMENT_TIMEOUT_MS), String(LOCK_TIMEOUT_MS), String(IDLE_TRANSACTION_TIMEOUT_MS)]);
}

function plannedSlots(raw) {
  const values = raw && typeof raw === "object" && Array.isArray(raw.slots) ? raw.slots : null;
  if (!values || values.length < 1 || values.length > MAX_PLAN_SLOTS) throw notRecoverable();
  const slots = new Map();
  for (const slot of values) {
    if (!isSafeAutoListingAiIdentifier(slot?.slotKey) || !isSafeAutoListingAiIdentifier(slot?.role)
      || !isSafeAutoListingAiIdentifier(slot?.visualGroupKey) || slots.has(slot.slotKey)) throw notRecoverable();
    slots.set(slot.slotKey, Object.freeze({
      slotKey: slot.slotKey, role: slot.role, visualGroupKey: slot.visualGroupKey,
    }));
  }
  return slots;
}

function retryMessage(value, phase, expectedStatusVersion, target = null, correlationId) {
  const key = phase === "GENERATE_IMAGE_SLOT" ? "slotKey" : null;
  return normalizeAutoListingAiMessage({
    contractVersion: "V1", accountId: value.accountId, itemId: value.itemId,
    phase, expectedStatusVersion, correlationId, ...(key ? { [key]: target } : {}),
  });
}

function messageEvidence(messages) {
  return messages.map((message) => Object.freeze({
    phase: message.phase,
    target: message.slotKey ?? message.sourceAssetId ?? null,
  })).sort((left, right) => `${left.phase}:${left.target || ""}`.localeCompare(`${right.phase}:${right.target || ""}`));
}

async function replay(client, value, eventId, idempotencyHash) {
  const result = await safeQuery(client,
    `SELECT from_status,to_status,transition_version,details,correlation_id
       FROM auto_listing_events
      WHERE id=$1 AND account_id=$2 AND job_id=$3 AND item_id=$4 AND event_type IN ('RETRY_PLANNING','RETRY_GENERATION')`,
    [eventId, value.accountId, value.jobId, value.itemId]);
  const row = result?.rowCount === 1 ? result.rows?.[0] : null;
  if (!row) return null;
  const details = row.details;
  const sourceStatus = details?.sourceStatus || "RETRYABLE_ERROR";
  if (row.from_status !== sourceStatus
    || !["RETRYABLE_ERROR", "BLOCKED"].includes(sourceStatus)
    || !Number.isInteger(row.transition_version) || row.transition_version !== value.expectedStatusVersion + 1
    || !details || details.idempotencyKeyHash !== idempotencyHash
    || details.requestedStatusVersion !== value.expectedStatusVersion
    || !["PLANNING", "GENERATION"].includes(details.recoveryPoint)
    || !Array.isArray(details.messages) || !isSafeAutoListingAiIdentifier(row.correlation_id)) throw conflict();
  const outbox = await safeQuery(client,
    `SELECT phase,phase_target_id FROM auto_listing_ai_outbox
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND correlation_id=$4
        AND expected_status_version=$5 AND contract_version='V1'`,
    [value.accountId, value.jobId, value.itemId, row.correlation_id, row.transition_version]);
  const evidence = (outbox.rows || []).map((entry) => ({ phase: entry.phase, target: entry.phase_target_id ?? null }));
  if (evidence.length < 1 || JSON.stringify([...evidence].sort((a, b) =>
    `${a.phase}:${a.target || ""}`.localeCompare(`${b.phase}:${b.target || ""}`)))
    !== JSON.stringify([...details.messages].sort((a, b) =>
      `${a.phase}:${a.target || ""}`.localeCompare(`${b.phase}:${b.target || ""}`)))) throw conflict();
  return Object.freeze({
    status: row.to_status,
    statusVersion: row.transition_version,
    recoveryPoint: details.recoveryPoint,
    enqueued: evidence.length,
    duplicate: true,
  });
}

async function buildGenerationMessages(client, value, row, nextVersion, correlationId) {
  if (!isSafeAutoListingAiIdentifier(row.active_content_plan_id)) throw notRecoverable();
  const planResult = await safeQuery(client,
    `SELECT p.plan FROM ai_content_plans AS p
      WHERE p.account_id=$1 AND p.job_id=$2 AND p.item_id=$3 AND p.id=$4`,
    [value.accountId, value.jobId, value.itemId, row.active_content_plan_id]);
  if (planResult?.rowCount !== 1) throw notRecoverable();
  const slots = plannedSlots(planResult.rows[0].plan);
  const acceptedResult = await safeQuery(client,
    `SELECT DISTINCT asset.slot_key
       FROM ai_generation_assets AS asset
       JOIN ai_content_plans AS plan
         ON plan.account_id=asset.account_id AND plan.job_id=asset.job_id
           AND plan.item_id=asset.item_id AND plan.id=asset.plan_id
       CROSS JOIN LATERAL jsonb_array_elements(plan.plan->'slots') AS planned_slot
      WHERE asset.account_id=$1 AND asset.job_id=$2 AND asset.item_id=$3 AND asset.plan_id=$4
        AND asset.status='ACCEPTED' AND planned_slot->>'slotKey'=asset.slot_key
        AND (plan.prompt_template_version NOT IN ('AUTO_LISTING_CONTENT_PLAN_FILL_V3','AUTO_LISTING_CONTENT_PLAN_FILL_V4','AUTO_LISTING_CONTENT_PLAN_FILL_V5','AUTO_LISTING_CONTENT_PLAN_FILL_V6')
          OR jsonb_array_length(planned_slot->'claims')>0
          OR asset.checker_result->>'textForbidden'='true')`,
    [value.accountId, value.jobId, value.itemId, row.active_content_plan_id]);
  const skippedResult = await safeQuery(client,
    `SELECT DISTINCT details->>'slotKey' AS slot_key FROM auto_listing_events
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND event_type='AI_IMAGE_SLOT_SKIPPED'
        AND details->>'planId'=$4`,
    [value.accountId, value.jobId, value.itemId, row.active_content_plan_id]);
  const accepted = new Set((acceptedResult.rows || []).map((entry) => entry.slot_key));
  const skipped = new Set((skippedResult.rows || []).map((entry) => entry.slot_key));
  if ([...accepted, ...skipped].some((slotKey) => !slots.has(slotKey))) throw notRecoverable();
  const slotValues = [...slots.values()];
  const incomplete = slotValues.filter((slot) => !accepted.has(slot.slotKey) && !skipped.has(slot.slotKey));
  const recoverySlots = new Map(incomplete.map((slot) => [slot.slotKey, slot]));
  const groups = new Map();
  for (const slot of slotValues) {
    const group = groups.get(slot.visualGroupKey) || [];
    group.push(slot);
    groups.set(slot.visualGroupKey, group);
  }
  for (const groupSlots of groups.values()) {
    const skippedSlots = groupSlots.filter((slot) => skipped.has(slot.slotKey))
      .sort((left, right) => left.slotKey.localeCompare(right.slotKey));
    const main = groupSlots.find((slot) => slot.role === "MAIN");
    if (!main) throw notRecoverable();
    for (const slot of skippedSlots) recoverySlots.set(slot.slotKey, slot);
  }
  if (recoverySlots.size > 0) {
    return [...recoverySlots.values()].sort((a, b) => a.slotKey.localeCompare(b.slotKey)).map((slot) =>
      retryMessage(value, "GENERATE_IMAGE_SLOT", nextVersion, slot.slotKey, correlationId));
  }
  const allGroupsReady = [...groups.values()].every((groupSlots) => {
    const main = groupSlots.find((slot) => slot.role === "MAIN");
    return main && accepted.has(main.slotKey)
      && groupSlots.filter((slot) => accepted.has(slot.slotKey)).length >= 6;
  });
  if (!allGroupsReady) throw notRecoverable();
  return [retryMessage(value, "GENERATE_RICH_CONTENT", nextVersion, null, correlationId)];
}

async function insertOutbox(client, value, message) {
  const dedupeKey = autoListingAiMessageDedupeKey(message);
  const target = message.slotKey ?? null;
  const result = await safeQuery(client,
    `INSERT INTO auto_listing_ai_outbox (
       id,account_id,job_id,item_id,slot_key,event_type,dedupe_key,payload,state,attempts,available_at,
       contract_version,phase,phase_target_id,expected_status_version,correlation_id,next_retry_at
     ) VALUES ($1,$2,$3,$4,CASE WHEN $5='GENERATE_IMAGE_SLOT' THEN $7 ELSE NULL END,
       $5,$6,$8::JSONB,'PENDING',0,NOW(),'V1',$5,$7,$9,$10,NOW())
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [deterministicId("ai-outbox", dedupeKey), value.accountId, value.jobId, value.itemId,
      message.phase, dedupeKey, target, canonicalizeAutoListingAiMessage(message),
      message.expectedStatusVersion, message.correlationId]);
  if (result?.rowCount !== 1) throw conflict();
}

export function createPostgresAutoListingAiRetryRepository(rawOptions = {}) {
  const options = closed(rawOptions, FACTORY_KEYS);
  const pool = options.pool;
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") throw invalid();
  return Object.freeze({
    async retryAutoListingAiItem(rawInput = {}) {
      const value = input(rawInput);
      const idempotencyHash = digest(value.idempotencyKey);
      const eventId = deterministicId("ai-retry", [
        value.accountId, value.jobId, value.itemId, String(value.expectedStatusVersion), idempotencyHash,
      ].join("\0"));
      const correlationId = deterministicId("ai-retry-correlation", eventId);
      let client;
      let committed = false;
      try {
        client = await pool.connect();
        if (!client || typeof client.query !== "function") throw failed();
        await safeQuery(client, "BEGIN");
        await configureTransaction(client);
        const boundary = await safeQuery(client,
          `SELECT i.status,i.status_version,i.recovery_point,i.active_content_plan_id,i.failure_code
             FROM auto_listing_job_items AS i
             JOIN auto_listing_jobs AS j ON j.account_id=i.account_id AND j.id=i.job_id
            WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3
            FOR UPDATE OF i`,
          [value.accountId, value.jobId, value.itemId]);
        if (boundary?.rowCount !== 1) throw retryError("AUTO_LISTING_AI_RETRY_NOT_FOUND");
        const existing = await replay(client, value, eventId, idempotencyHash);
        if (existing) {
          await safeQuery(client, "COMMIT");
          committed = true;
          return existing;
        }
        const row = boundary.rows[0];
        if (row.status_version !== value.expectedStatusVersion) throw conflict();
        const sourceStatus = row.status;
        const recoveryPoint = sourceStatus === "RETRYABLE_ERROR"
          ? row.recovery_point
          : sourceStatus === "BLOCKED" && isSafeAutoListingPlanningRetryFailure(row.failure_code)
            ? "PLANNING"
          : sourceStatus === "BLOCKED" && RECOVERABLE_BLOCKED_FAILURES.has(row.failure_code)
            ? "GENERATION" : null;
        if (sourceStatus !== "RETRYABLE_ERROR" && sourceStatus !== "BLOCKED") throw conflict();
        if (!["PLANNING", "GENERATION"].includes(recoveryPoint)) throw notRecoverable();
        const nextVersion = value.expectedStatusVersion + 1;
        const toStatus = recoveryPoint === "PLANNING" ? "PLANNING" : "GENERATING";
        if (recoveryPoint === "GENERATION") {
          await safeQuery(client,
            `UPDATE ai_generation_assets
                SET status='FAILED',lease_token=NULL,lease_expires_at=NULL,
                    error_code='AUTO_LISTING_IMAGE_RETRY_SUPERSEDED',error_retryable=TRUE,updated_at=NOW()
              WHERE account_id=$1 AND job_id=$2 AND item_id=$3
                AND expected_status_version < $4 AND plan_id=$5 AND status='GENERATING'`,
            [value.accountId, value.jobId, value.itemId, value.expectedStatusVersion, row.active_content_plan_id]);
        }
        let messages = recoveryPoint === "PLANNING"
          ? [retryMessage(value, "PLAN_CONTENT", nextVersion, null, correlationId)]
          : await buildGenerationMessages(client, value, row, nextVersion, correlationId);
        if (messages.length < 1 || messages.length > MAX_PLAN_SLOTS) throw notRecoverable();
        messages = messages.map((message) => normalizeAutoListingAiMessage(message));
        const updated = await safeQuery(client,
          `UPDATE auto_listing_job_items
              SET status=$5,status_version=status_version+1,recovery_point=NULL,
                  failure_code=NULL,failure_detail_safe=NULL,updated_at=NOW()
            WHERE account_id=$1 AND job_id=$2 AND id=$3 AND status_version=$4 AND status=$6
            RETURNING status,status_version`,
          [value.accountId, value.jobId, value.itemId, value.expectedStatusVersion, toStatus, sourceStatus]);
        if (updated?.rowCount !== 1 || updated.rows[0].status !== toStatus
          || updated.rows[0].status_version !== nextVersion) throw conflict();
        const details = Object.freeze({
          idempotencyKeyHash: idempotencyHash,
          requestedStatusVersion: value.expectedStatusVersion,
          sourceStatus,
          recoveryPoint,
          messages: messageEvidence(messages),
        });
        const event = await safeQuery(client,
          `INSERT INTO auto_listing_events (
             id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,
             correlation_id,details,transition_version
           ) VALUES ($1,$2,$3,$4,$2,$5,$6,$7,$8,$9::JSONB,$10)
           RETURNING id`,
          [eventId, value.accountId, value.jobId, value.itemId, sourceStatus, toStatus,
            recoveryPoint === "PLANNING" ? "RETRY_PLANNING" : "RETRY_GENERATION",
            correlationId, JSON.stringify(details), nextVersion]);
        if (event?.rowCount !== 1) throw conflict();
        for (const message of messages) await insertOutbox(client, value, message);
        await safeQuery(client, "COMMIT");
        committed = true;
        return Object.freeze({
          status: toStatus, statusVersion: nextVersion, recoveryPoint,
          enqueued: messages.length, duplicate: false,
        });
      } catch (error) {
        if (client?.query && !committed) {
          try { await client.query("ROLLBACK"); } catch {}
        }
        if (ownErrorCode(error)?.startsWith("AUTO_LISTING_AI_RETRY_")) throw error;
        throw failed();
      } finally {
        try { client?.release?.(); } catch {}
      }
    },
  });
}

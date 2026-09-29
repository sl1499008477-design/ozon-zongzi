import crypto from "node:crypto";

import {
  AUTO_LISTING_AI_MESSAGE_CONTRACT_VERSION,
  autoListingAiMessagePhaseTarget,
  autoListingAiMessageDedupeKey,
  canonicalizeAutoListingAiMessage,
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";
import {
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS,
  enumerateSourceImageAssets,
} from "./auto-listing-source-image-intelligence-contract.mjs";
import { buildSourceImageAnalysisBatches } from "./auto-listing-source-image-analyzer.mjs";
import {
  deriveSourceImageCleanupAttempt,
  sourceImageCleanupCandidate,
} from "./auto-listing-source-image-cleanup-contract.mjs";
import { normalizeAutoListingAiWorkMessage } from "./auto-listing-ai-work-message.mjs";
import { nextAutoListingStatus, recoveryPointForRetryableFailure } from "./auto-listing-state-machine.mjs";
import { enqueueAutoListingUploadTask } from "./auto-listing-upload-task-postgres.mjs";

const STAGE_KEYS = new Set([
  "client", "accountId", "jobId", "itemId", "actorAccountId",
  "expectedStatusVersion", "correlationId",
]);
const FACTORY_KEYS = new Set(["pool", "directUploadAllowed"]);
const APPLY_KEYS = new Set([
  "client", "accountId", "jobId", "itemId", "expectedStatusVersion", "correlationId",
  "phase", "phaseTargetId", "outcome",
]);
const FACTORY_APPLY_KEYS = new Set(["message", "outcome", "execution"]);
const LEGACY_FACTORY_APPLY_KEYS = new Set(["message", "outcome"]);
const OUTCOME_KEYS = new Set([
  "contractVersion", "disposition", "phase", "outcome", "retryable", "failureCode", "correlationId",
  "failureScope", "deliveryState", "retryAfterMs",
]);
const PHASE_STATUS = Object.freeze({
  PLAN_CONTENT: "PLANNING",
  MATERIALIZE_SOURCE_ASSET: "PLANNING",
  ANALYZE_SOURCE_IMAGE_BATCH: "PLANNING",
  CLEAN_SOURCE_IMAGE_OVERLAY: "PLANNING",
  CHECK_SOURCE_IMAGE_CLEANUP: "PLANNING",
  RECONCILE_SOURCE_IMAGE_ANALYSIS: "PLANNING",
  FINALIZE_MATERIALIZED_PLAN: "PLANNING",
  GENERATE_IMAGE_SLOT: "GENERATING",
  CHECK_IMAGE_GROUP: "GENERATING",
  GENERATE_RICH_CONTENT: "GENERATING",
});
const SUCCESS_OUTCOME = Object.freeze({
  PLAN_CONTENT: new Set(["PLAN_READY"]),
  MATERIALIZE_SOURCE_ASSET: new Set(["SOURCE_ASSET_ACCEPTED", "SOURCE_ASSET_TERMINAL", "STALE", "CANCELLED"]),
  ANALYZE_SOURCE_IMAGE_BATCH: new Set(["SOURCE_IMAGE_BATCH_ACCEPTED"]),
  CLEAN_SOURCE_IMAGE_OVERLAY: new Set(["SOURCE_IMAGE_CLEANUP_GENERATED"]),
  CHECK_SOURCE_IMAGE_CLEANUP: new Set([
    "SOURCE_IMAGE_CLEANUP_ACCEPTED", "SOURCE_IMAGE_CLEANUP_REJECTED",
  ]),
  RECONCILE_SOURCE_IMAGE_ANALYSIS: new Set(["SOURCE_IMAGE_ANALYSIS_READY"]),
  FINALIZE_MATERIALIZED_PLAN: new Set(["MATERIALIZED_PLAN_READY"]),
  GENERATE_IMAGE_SLOT: new Set(["IMAGE_SLOT_ACCEPTED", "IMAGE_SLOT_SKIPPED"]),
  CHECK_IMAGE_GROUP: new Set(["IMAGE_GROUP_ACCEPTED", "IMAGE_GROUP_RETRY_QUEUED"]),
  GENERATE_RICH_CONTENT: new Set(["CONTENT_READY_FOR_REVIEW"]),
});
const TARGET_PHASES = new Set([
  "MATERIALIZE_SOURCE_ASSET", "ANALYZE_SOURCE_IMAGE_BATCH", "RECONCILE_SOURCE_IMAGE_ANALYSIS",
  "CLEAN_SOURCE_IMAGE_OVERLAY", "CHECK_SOURCE_IMAGE_CLEANUP", "GENERATE_IMAGE_SLOT", "CHECK_IMAGE_GROUP",
]);
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const MAX_VERSION = 2_147_483_647;
const STATEMENT_TIMEOUT_MS = 25_000;
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_TRANSACTION_TIMEOUT_MS = 30_000;
const CHANNEL_FAILURE_SCOPES = new Set(["CHANNEL_TRANSIENT", "CHANNEL_REVALIDATION"]);
const RESERVATION_BUSY_SCOPE = "RESERVATION_BUSY";
const RESERVATION_BUSY_CODE = Object.freeze({
  PLAN_CONTENT: "AUTO_LISTING_CONTENT_PLAN_IN_PROGRESS",
  ANALYZE_SOURCE_IMAGE_BATCH: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_IN_PROGRESS",
  GENERATE_IMAGE_SLOT: "AUTO_LISTING_IMAGE_IN_PROGRESS",
  CHECK_IMAGE_GROUP: "AUTO_LISTING_IMAGE_GROUP_CHECK_IN_PROGRESS",
  GENERATE_RICH_CONTENT: "AUTO_LISTING_RICH_CONTENT_IN_PROGRESS",
});
const FAILURE_SCOPES = new Set([null, "BUSINESS", RESERVATION_BUSY_SCOPE, ...CHANNEL_FAILURE_SCOPES]);
const DELIVERY_STATES = new Set([null, "NOT_SENT", "POSSIBLY_SENT"]);
const DEFAULT_CHANNEL_COOLDOWN_MS = 60_000;
const MAX_CHANNEL_COOLDOWN_MS = 86_400_000;
const MAX_UNCERTAIN_RESULT_COUNT = 5;
const MAX_IMAGE_GROUP_ACCEPTED_CANDIDATES_PER_SLOT = 4;
const MAX_IMAGE_SLOT_RECOVERY_ROUNDS = 2;
const SOFT_IMAGE_GROUP_REASON_CODES = new Set([
  "IMAGE_GROUP_DUPLICATE_VIEW", "IMAGE_GROUP_VIEW_MISMATCH",
]);
const SOURCE_IMAGE_ANALYSIS_CONTRACT_VERSION = SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2;
const SOURCE_IMAGE_ANALYSIS_PROMPT_VERSION = "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_V3";

function workflowError(code, retryable = false) {
  const error = new Error("自动上架 AI 工作流推进失败");
  error.code = code;
  error.retryable = retryable;
  return error;
}

const invalid = () => workflowError("AUTO_LISTING_AI_WORKFLOW_INVALID");
const conflict = () => workflowError("AUTO_LISTING_AI_WORKFLOW_VERSION_CONFLICT");
const failed = () => workflowError("AUTO_LISTING_AI_WORKFLOW_DATABASE_FAILED", true);
const retryNotFinal = () => workflowError("AUTO_LISTING_AI_WORKFLOW_RETRY_NOT_FINAL");

function plainData(value, keys) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !("value" in descriptors[key]))) throw invalid();
    return Object.fromEntries(ownKeys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_WORKFLOW_INVALID") throw error;
    throw invalid();
  }
}

function factoryOptions(raw) {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw invalid();
    const ownKeys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (!ownKeys.includes("pool") || ownKeys.length < 1 || ownKeys.length > FACTORY_KEYS.size
      || ownKeys.some((key) => typeof key !== "string" || !FACTORY_KEYS.has(key)
        || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    const directUploadAllowed = ownKeys.includes("directUploadAllowed")
      ? descriptors.directUploadAllowed.value : false;
    if (typeof directUploadAllowed !== "boolean") throw invalid();
    return { pool: descriptors.pool.value, directUploadAllowed };
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_WORKFLOW_INVALID") throw error;
    throw invalid();
  }
}

function identifier(value) {
  if (!isSafeAutoListingAiIdentifier(value)) throw invalid();
  return value;
}

function version(value) {
  if (!Number.isInteger(value) || value < 1 || value >= MAX_VERSION) throw invalid();
  return value;
}

function deterministicId(prefix, value) {
  return `${prefix}-${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function digestJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function query(client, sql, values) {
  try { return await client.query(sql, values); } catch (error) {
    if (error?.code?.startsWith?.("AUTO_LISTING_AI_WORKFLOW_")) throw error;
    throw failed();
  }
}

async function configureTransaction(client) {
  await query(client,
    `SELECT set_config('statement_timeout',$1,TRUE),
            set_config('lock_timeout',$2,TRUE),
            set_config('idle_in_transaction_session_timeout',$3,TRUE)`,
    [String(STATEMENT_TIMEOUT_MS), String(LOCK_TIMEOUT_MS), String(IDLE_TRANSACTION_TIMEOUT_MS)]);
}

function stageInput(raw) {
  const input = plainData(raw, STAGE_KEYS);
  if (!input.client || typeof input.client.query !== "function") throw invalid();
  for (const key of ["accountId", "jobId", "itemId", "actorAccountId", "correlationId"]) identifier(input[key]);
  if (input.actorAccountId !== input.accountId) throw invalid();
  version(input.expectedStatusVersion);
  return input;
}

function planMessage(input, expectedStatusVersion) {
  return normalizeAutoListingAiMessage({
    contractVersion: AUTO_LISTING_AI_MESSAGE_CONTRACT_VERSION,
    accountId: input.accountId,
    itemId: input.itemId,
    phase: "PLAN_CONTENT",
    expectedStatusVersion,
    correlationId: input.correlationId,
  });
}

function phaseMessage(input, phase, expectedStatusVersion, target = null) {
  const targetKey = phase === "MATERIALIZE_SOURCE_ASSET" ? "sourceAssetId"
    : phase === "ANALYZE_SOURCE_IMAGE_BATCH" ? "analysisBatchId"
      : ["CLEAN_SOURCE_IMAGE_OVERLAY", "CHECK_SOURCE_IMAGE_CLEANUP"].includes(phase) ? "derivativeAttemptId"
      : phase === "RECONCILE_SOURCE_IMAGE_ANALYSIS" ? "analysisRunId"
        : phase === "GENERATE_IMAGE_SLOT" ? "slotKey"
          : phase === "CHECK_IMAGE_GROUP" ? "visualGroupKey" : null;
  return normalizeAutoListingAiMessage({
    contractVersion: AUTO_LISTING_AI_MESSAGE_CONTRACT_VERSION,
    accountId: input.accountId, itemId: input.itemId, phase,
    expectedStatusVersion, correlationId: input.correlationId,
    ...(["CLEAN_SOURCE_IMAGE_OVERLAY", "CHECK_SOURCE_IMAGE_CLEANUP"].includes(phase)
      ? { analysisRunId: input.analysisRunId } : {}),
    ...(targetKey ? { [targetKey]: target } : {}),
  });
}

function validatedOutcome(rawOutcome, phase, correlationId, {
  allowChannelRetry = false,
  allowReservationBusy = false,
} = {}) {
  const result = plainData(rawOutcome, OUTCOME_KEYS);
  if (result.contractVersion !== "V1" || result.phase !== phase
    || result.correlationId !== correlationId
    || !["ACK", "RETRY", "FAIL"].includes(result.disposition)
    || typeof result.outcome !== "string" || typeof result.retryable !== "boolean"
    || !FAILURE_SCOPES.has(result.failureScope) || !DELIVERY_STATES.has(result.deliveryState)
    || !(result.retryAfterMs === null || (Number.isInteger(result.retryAfterMs)
      && result.retryAfterMs >= 0 && result.retryAfterMs <= MAX_CHANNEL_COOLDOWN_MS))
    || (result.disposition === "ACK" && (result.failureScope !== null
      || result.deliveryState !== null || result.retryAfterMs !== null))
    || (result.failureScope === "BUSINESS" && (result.deliveryState !== null || result.retryAfterMs !== null))
    || (result.failureScope === RESERVATION_BUSY_SCOPE && (result.disposition !== "RETRY"
      || result.deliveryState !== null || !Number.isInteger(result.retryAfterMs) || result.retryAfterMs < 1
      || result.failureCode !== RESERVATION_BUSY_CODE[phase]))
    || (CHANNEL_FAILURE_SCOPES.has(result.failureScope) && result.deliveryState === null)) throw invalid();
  if (result.disposition === "RETRY"
    && !((allowChannelRetry && CHANNEL_FAILURE_SCOPES.has(result.failureScope))
      || (allowReservationBusy && result.failureScope === RESERVATION_BUSY_SCOPE))) throw retryNotFinal();
  if (result.disposition === "ACK") {
    if (result.retryable || !SUCCESS_OUTCOME[phase].has(result.outcome)
      || !(result.failureCode === null || SAFE_FAILURE_CODE.test(result.failureCode))) throw invalid();
  } else if (!SAFE_FAILURE_CODE.test(result.failureCode || "")) throw invalid();
  return result;
}

function executionInput(message, rawExecution) {
  if (rawExecution === null) return null;
  try {
    return normalizeAutoListingAiWorkMessage({
      workContractVersion: "CHANNEL_WORK_V1",
      message,
      execution: rawExecution,
    }).execution;
  } catch {
    throw invalid();
  }
}

function factoryApplyEnvelope(raw) {
  try {
    const keys = Reflect.ownKeys(raw || {});
    const expected = keys.length === FACTORY_APPLY_KEYS.size
      ? FACTORY_APPLY_KEYS : LEGACY_FACTORY_APPLY_KEYS;
    const value = plainData(raw, expected);
    return { ...value, execution: Object.hasOwn(value, "execution") ? value.execution : null };
  } catch {
    throw invalid();
  }
}

function applyInput(raw) {
  const input = plainData(raw, APPLY_KEYS);
  if (!input.client || typeof input.client.query !== "function") throw invalid();
  for (const key of ["accountId", "jobId", "itemId", "correlationId"]) identifier(input[key]);
  version(input.expectedStatusVersion);
  if (!Object.hasOwn(PHASE_STATUS, input.phase)) throw invalid();
  if (TARGET_PHASES.has(input.phase)) identifier(input.phaseTargetId);
  else if (input.phaseTargetId !== null) throw invalid();
  const result = validatedOutcome(input.outcome, input.phase, input.correlationId);
  return { ...input, outcome: result };
}

function applied(status, statusVersion, enqueued = 0) {
  return Object.freeze({ disposition: "APPLIED", status, statusVersion, enqueued });
}

function ignored(disposition, row) {
  return Object.freeze({ disposition, status: row?.status ?? null,
    statusVersion: row?.status_version ?? null, enqueued: 0 });
}

function sourceReferences(visualGroups) {
  if (!visualGroups || typeof visualGroups !== "object" || Array.isArray(visualGroups)
    || !Array.isArray(visualGroups.groups)) throw conflict();
  const refs = new Map();
  for (const group of visualGroups.groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.referenceImages)) throw conflict();
    for (const ref of group.referenceImages) {
      if (ref?.evidenceKind !== "SOURCE_REF_HASH") continue;
      if (!isSafeAutoListingAiIdentifier(ref.assetId) || !HASH.test(ref.sourceRefHash || "")
        || ref.contentHash !== null) throw conflict();
      if (refs.has(ref.assetId) && refs.get(ref.assetId) !== ref.sourceRefHash) throw conflict();
      refs.set(ref.assetId, ref.sourceRefHash);
    }
  }
  return [...refs].sort(([a], [b]) => a.localeCompare(b));
}

function planSlots(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || !Array.isArray(plan.slots)) throw conflict();
  const slots = new Map();
  for (const slot of plan.slots) {
    const visualGroupKey = slot?.visualGroupKey ?? null;
    if (!isSafeAutoListingAiIdentifier(slot?.slotKey) || !isSafeAutoListingAiIdentifier(slot?.role)
      || !(visualGroupKey === null || isSafeAutoListingAiIdentifier(visualGroupKey))
      || slots.has(slot.slotKey)) throw conflict();
    slots.set(slot.slotKey, Object.freeze({ role: slot.role, visualGroupKey }));
  }
  if (slots.size < 1) throw conflict();
  return slots;
}

async function lockBoundary(input) {
  const result = await query(input.client,
    `SELECT i.status,i.status_version,i.active_content_plan_id,i.planning_contract,
            i.current_source_image_analysis_run_id
       FROM auto_listing_job_items AS i
      WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3
      FOR UPDATE`,
    [input.accountId, input.jobId, input.itemId]);
  return result?.rowCount === 1 ? result.rows?.[0] : null;
}

async function loadActivePlan(input, { parent = null } = {}) {
  const result = await query(input.client,
    `SELECT p.id,p.parent_plan_id,p.derivation_kind,p.visual_groups,p.plan,
            p.source_image_analysis_run_id,p.source_image_intelligence_hash
       FROM auto_listing_job_items AS i
       JOIN ai_content_plans AS p
         ON p.account_id=i.account_id AND p.job_id=i.job_id AND p.item_id=i.id
        AND p.id=i.active_content_plan_id
      WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3`,
    [input.accountId, input.jobId, input.itemId]);
  const plan = result?.rowCount === 1 ? result.rows?.[0] : null;
  if (!plan || !isSafeAutoListingAiIdentifier(plan.id)) throw conflict();
  if (parent === true && plan.parent_plan_id !== null) throw conflict();
  if (parent === false && (!isSafeAutoListingAiIdentifier(plan.parent_plan_id)
    || plan.derivation_kind !== "SOURCE_MATERIALIZATION")) throw conflict();
  return plan;
}

async function audit(input, row, eventType, details = {}) {
  const event = await insertEvent(input.client, { ...input, actorAccountId: input.accountId }, {
    fromStatus: row.status, toStatus: row.status, eventType, transitionVersion: null, details,
  });
  if (event?.rowCount !== 1) throw conflict();
}

function softImageGroupFailure(result) {
  return Array.isArray(result?.reasonCodes) && result.reasonCodes.length > 0
    && result.reasonCodes.every((code) => SOFT_IMAGE_GROUP_REASON_CODES.has(code))
    && Array.isArray(result?.identityMismatchSlotKeys)
    && result.identityMismatchSlotKeys.length === 0;
}

async function exhaustedImageGroupKeys(input, planId) {
  const result = await query(input.client,
    `SELECT DISTINCT details->>'visualGroupKey' AS visual_group_key
       FROM auto_listing_events
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3
        AND event_type='AI_IMAGE_GROUP_RETRY_EXHAUSTED'
        AND details->>'planId'=$4`,
    [input.accountId, input.jobId, input.itemId, planId]);
  if (!result || !Array.isArray(result.rows)
    || result.rows.some(({ visual_group_key: key }) => !isSafeAutoListingAiIdentifier(key))) throw conflict();
  return new Set(result.rows.map(({ visual_group_key: key }) => key));
}

async function enqueue(input, message) {
  const result = await insertOutbox(input.client, input.jobId, message);
  if (result?.rowCount !== 1) throw conflict();
  return 1;
}

async function requeueCompletedMessage(input, message) {
  const target = autoListingAiMessagePhaseTarget(message);
  const dedupeKey = autoListingAiMessageDedupeKey(message);
  return query(input.client,
    `WITH requeued AS (
       UPDATE auto_listing_ai_outbox
          SET state='PENDING',available_at=NOW(),next_retry_at=NOW(),
              lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
              dispatch_contract_version=NULL,publication_id=NULL,published_at=NULL,
              last_error_code=NULL,last_error_safe=NULL,updated_at=NOW()
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND dedupe_key=$4
          AND contract_version=$5 AND phase=$6 AND expected_status_version=$7
          AND correlation_id=$8 AND phase_target_id IS NOT DISTINCT FROM $9
          AND state='COMPLETED'
        RETURNING id
     )
     SELECT id FROM requeued
     UNION ALL
     SELECT id FROM auto_listing_ai_outbox
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND dedupe_key=$4
        AND contract_version=$5 AND phase=$6 AND expected_status_version=$7
        AND correlation_id=$8 AND phase_target_id IS NOT DISTINCT FROM $9
        AND state='PENDING' AND NOT EXISTS (SELECT 1 FROM requeued)`,
    [message.accountId, input.jobId, message.itemId, dedupeKey, message.contractVersion,
      message.phase, message.expectedStatusVersion, message.correlationId, target]);
}

async function enqueueOrRequeueCompleted(input, message) {
  const existing = await requeueCompletedMessage(input, message);
  if (existing?.rowCount === 1) return 1;
  if (existing?.rowCount !== 0) throw conflict();
  return enqueue(input, message);
}

async function transition(input, row, eventType, toStatus, failureCode = null) {
  if (nextAutoListingStatus(row.status, eventType) !== toStatus) throw conflict();
  const nextVersion = row.status_version + 1;
  const recoveryPoint = toStatus === "RETRYABLE_ERROR" ? recoveryPointForRetryableFailure(row.status) : null;
  const updated = await query(input.client,
    `UPDATE auto_listing_job_items
        SET status=$5,status_version=status_version+1,recovery_point=$6,
            failure_code=$7,failure_detail_safe=$7,updated_at=NOW()
      WHERE account_id=$1 AND job_id=$2 AND id=$3 AND status_version=$4 AND status=$8
      RETURNING status,status_version`,
    [input.accountId, input.jobId, input.itemId, input.expectedStatusVersion,
      toStatus, recoveryPoint, failureCode, row.status]);
  if (updated?.rowCount !== 1 || updated.rows?.[0]?.status !== toStatus
    || updated.rows[0].status_version !== nextVersion) throw conflict();
  const event = await insertEvent(input.client, { ...input, actorAccountId: input.accountId }, {
    fromStatus: row.status, toStatus, eventType, transitionVersion: nextVersion,
    details: failureCode ? { failureCode, recoveryPoint } : { phase: input.phase },
  });
  if (event?.rowCount !== 1) throw conflict();
  return nextVersion;
}

async function insertEvent(client, input, { fromStatus, toStatus, eventType, transitionVersion, details }) {
  const identity = [input.accountId, input.jobId, input.itemId, eventType,
    transitionVersion ?? "audit", input.correlationId, JSON.stringify(details)].join("\0");
  return query(client,
    `WITH inserted AS (
       INSERT INTO auto_listing_events (
         id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,
         correlation_id,details,transition_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::JSONB,$11)
       ON CONFLICT (id) DO NOTHING RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id FROM auto_listing_events
      WHERE id=$1 AND account_id=$2 AND job_id=$3 AND item_id=$4 AND actor_account_id=$5
        AND from_status=$6 AND to_status=$7 AND event_type=$8 AND correlation_id=$9
        AND details=$10::JSONB AND transition_version IS NOT DISTINCT FROM $11
        AND NOT EXISTS (SELECT 1 FROM inserted)`,
    [deterministicId("ai-event", identity), input.accountId, input.jobId, input.itemId,
      input.actorAccountId, fromStatus, toStatus, eventType, input.correlationId,
      JSON.stringify(details), transitionVersion],
  );
}

async function insertOutbox(client, jobId, message) {
  const dedupeKey = autoListingAiMessageDedupeKey(message);
  const target = autoListingAiMessagePhaseTarget(message);
  return query(client,
    `WITH inserted AS (
       INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,slot_key,event_type,dedupe_key,payload,state,attempts,available_at,
         contract_version,phase,phase_target_id,expected_status_version,correlation_id,next_retry_at,
         lease_owner,lease_token,lease_expires_at,publication_id,published_at,dead_at,last_error_code,last_error_safe
       ) VALUES (
         $1,$2,$3,$4,CASE WHEN $5='GENERATE_IMAGE_SLOT' THEN $7 ELSE NULL END,
         $5,$6,$8::JSONB,'PENDING',0,NOW(),$11,$5,$7,$9,$10,NOW(),
         NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
       ) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id FROM auto_listing_ai_outbox
      WHERE dedupe_key=$6 AND id=$1 AND account_id=$2 AND job_id=$3 AND item_id=$4
        AND event_type=$5 AND payload=$8::JSONB AND contract_version=$11 AND phase=$5
        AND phase_target_id IS NOT DISTINCT FROM $7 AND expected_status_version=$9
        AND correlation_id=$10 AND NOT EXISTS (SELECT 1 FROM inserted)`,
    [deterministicId("ai-outbox", dedupeKey), message.accountId, jobId, message.itemId,
      message.phase, dedupeKey, target, canonicalizeAutoListingAiMessage(message),
      message.expectedStatusVersion, message.correlationId, message.contractVersion],
  );
}

async function loadCurrentAnalysisState(input, row) {
  if (!isSafeAutoListingAiIdentifier(row.current_source_image_analysis_run_id)) throw conflict();
  const runResult = await query(input.client,
    `SELECT * FROM auto_listing_source_image_analysis_runs
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND id=$4
        AND expected_status_version=$5 FOR SHARE`,
    [input.accountId, input.jobId, input.itemId, row.current_source_image_analysis_run_id,
      row.status_version]);
  const run = runResult?.rowCount === 1 ? runResult.rows?.[0] : null;
  if (!run) throw conflict();
  const assessments = await query(input.client,
    `SELECT source_asset_id,source_ordinal,record_status,object_key,content_hash,content_type,size_bytes,
            terminal_status,analysis_batch_id,result_hash,assessment
       FROM auto_listing_source_image_assessments
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND analysis_run_id=$4
        AND expected_status_version=$5
      ORDER BY source_ordinal NULLS LAST,source_asset_id`,
    [input.accountId, input.jobId, input.itemId, run.id, row.status_version]);
  if (!assessments || !Array.isArray(assessments.rows)) throw conflict();
  return { run, assessments: assessments.rows };
}

function stableAnalysisBatches(rows) {
  const materializedAssets = rows.filter(({ record_status }) => record_status === "MATERIALIZED").map((entry) => ({
    sourceAssetId: entry.source_asset_id, sourceOrdinal: entry.source_ordinal,
    sizeBytes: Number(entry.size_bytes), contentHash: entry.content_hash,
    objectKey: entry.object_key, contentType: entry.content_type,
  }));
  const terminalAssessments = rows.filter((entry) => entry.record_status === "ACCEPTED"
    && ["DOWNLOAD_FAILED", "UNSUPPORTED_MEDIA"].includes(entry.terminal_status)).map((entry) => ({
    sourceAssetId: entry.source_asset_id, terminalStatus: entry.terminal_status,
  }));
  try { return buildSourceImageAnalysisBatches({ materializedAssets, terminalAssessments }); }
  catch { throw conflict(); }
}

function parsedAssessment(value) {
  try {
    const assessment = typeof value === "string" ? JSON.parse(value) : value;
    if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) throw conflict();
    return assessment;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_WORKFLOW_VERSION_CONFLICT") throw error;
    throw conflict();
  }
}

function cleanupCandidateRows(assessments) {
  const candidates = [];
  for (const row of assessments) {
    if (row.record_status !== "ACCEPTED" || !row.assessment) continue;
    const assessment = parsedAssessment(row.assessment);
    let candidate;
    try { candidate = sourceImageCleanupCandidate(assessment); } catch { throw conflict(); }
    if (candidate) candidates.push({ row, assessment, candidate });
  }
  return candidates;
}

async function reserveCleanupAttempt(input, run, assessment, attemptNo, previousReasonCodes) {
  let attempt;
  try {
    attempt = deriveSourceImageCleanupAttempt({
      accountId: input.accountId,
      jobId: input.jobId,
      itemId: input.itemId,
      analysisRunId: run.id,
      expectedStatusVersion: input.expectedStatusVersion,
      assessment,
      attemptNo,
      previousReasonCodes,
    });
  } catch { throw conflict(); }
  const result = await query(input.client,
    `WITH inserted AS (
       INSERT INTO auto_listing_source_image_derivatives (
         id,account_id,job_id,item_id,analysis_run_id,source_asset_id,expected_status_version,
         derivative_attempt_id,input_hash,attempt_no,original_content_hash,overlay_decision_hash,
         prompt_version,status,lease_token
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'RESERVED',$14)
       ON CONFLICT (account_id,analysis_run_id,source_asset_id,input_hash,attempt_no) DO NOTHING
       RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id FROM auto_listing_source_image_derivatives
      WHERE account_id=$2 AND job_id=$3 AND item_id=$4 AND analysis_run_id=$5
        AND source_asset_id=$6 AND expected_status_version=$7 AND derivative_attempt_id=$8
        AND input_hash=$9 AND attempt_no=$10 AND original_content_hash=$11
        AND overlay_decision_hash=$12 AND prompt_version=$13 AND status='RESERVED'
        AND NOT EXISTS (SELECT 1 FROM inserted)`,
    [deterministicId("source-image-derivative-row", attempt.derivativeAttemptId),
      attempt.accountId, attempt.jobId, attempt.itemId, attempt.analysisRunId, attempt.sourceAssetId,
      attempt.expectedStatusVersion, attempt.derivativeAttemptId, attempt.inputHash, attempt.attemptNo,
      attempt.originalContentHash, attempt.overlayDecisionHash, attempt.promptVersion,
      deterministicId("source-image-derivative-lease", attempt.derivativeAttemptId)]);
  if (result?.rowCount !== 1) throw conflict();
  return attempt;
}

async function loadCleanupAttempt(input, row) {
  if (!isSafeAutoListingAiIdentifier(row.current_source_image_analysis_run_id)) throw conflict();
  const result = await query(input.client,
    `SELECT derivative_attempt_id,analysis_run_id,source_asset_id,expected_status_version,
            attempt_no,status,check_result
       FROM auto_listing_source_image_derivatives
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND analysis_run_id=$4
        AND expected_status_version=$5 AND derivative_attempt_id=$6 FOR SHARE`,
    [input.accountId, input.jobId, input.itemId, row.current_source_image_analysis_run_id,
      row.status_version, input.phaseTargetId]);
  const attempt = result?.rowCount === 1 ? result.rows?.[0] : null;
  if (!attempt || attempt.derivative_attempt_id !== input.phaseTargetId
    || attempt.analysis_run_id !== row.current_source_image_analysis_run_id
    || !isSafeAutoListingAiIdentifier(attempt.source_asset_id)
    || Number(attempt.expected_status_version) !== row.status_version
    || !Number.isInteger(Number(attempt.attempt_no))) throw conflict();
  return { ...attempt, attempt_no: Number(attempt.attempt_no) };
}

async function loadCleanupAssessment(input, row, sourceAssetId) {
  const result = await query(input.client,
    `SELECT assessment FROM auto_listing_source_image_assessments
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND analysis_run_id=$4
        AND expected_status_version=$5 AND source_asset_id=$6 AND record_status='ACCEPTED' FOR SHARE`,
    [input.accountId, input.jobId, input.itemId, row.current_source_image_analysis_run_id,
      row.status_version, sourceAssetId]);
  if (result?.rowCount !== 1) throw conflict();
  return parsedAssessment(result.rows?.[0]?.assessment);
}

async function cleanupConverged(input, row) {
  const result = await query(input.client,
    `SELECT a.source_asset_id,a.record_status,a.assessment,d.attempt_no,d.status AS derivative_status
       FROM auto_listing_source_image_assessments AS a
       LEFT JOIN auto_listing_source_image_derivatives AS d
         ON d.account_id=a.account_id AND d.job_id=a.job_id AND d.item_id=a.item_id
        AND d.analysis_run_id=a.analysis_run_id AND d.source_asset_id=a.source_asset_id
        AND d.expected_status_version=a.expected_status_version
      WHERE a.account_id=$1 AND a.job_id=$2 AND a.item_id=$3 AND a.analysis_run_id=$4
        AND a.expected_status_version=$5
      ORDER BY a.source_ordinal NULLS LAST,a.source_asset_id,d.attempt_no`,
    [input.accountId, input.jobId, input.itemId, row.current_source_image_analysis_run_id,
      row.status_version]);
  if (!result || !Array.isArray(result.rows)) throw conflict();
  const grouped = new Map();
  for (const entry of result.rows) {
    const current = grouped.get(entry.source_asset_id) || {
      source_asset_id: entry.source_asset_id,
      record_status: entry.record_status,
      assessment: entry.assessment,
      derivatives: [],
    };
    if (entry.derivative_status) current.derivatives.push({
      attemptNo: Number(entry.attempt_no), status: entry.derivative_status,
    });
    grouped.set(entry.source_asset_id, current);
  }
  const candidates = cleanupCandidateRows([...grouped.values()]);
  if (candidates.length < 1) throw conflict();
  return candidates.every(({ row: candidate }) => {
    const derivatives = grouped.get(candidate.source_asset_id)?.derivatives || [];
    return derivatives.some(({ status }) => status === "ACCEPTED")
      || derivatives.some(({ status, attemptNo }) => status === "REJECTED" && attemptNo === 3);
  });
}

function cleanupReasonCodes(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || !Array.isArray(parsed.reasonCodes)
      || !parsed.reasonCodes.every((code) => typeof code === "string")) throw conflict();
    return parsed.reasonCodes;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_WORKFLOW_VERSION_CONFLICT") throw error;
    throw conflict();
  }
}

async function advanceCleanupAttempt(input, row, attempt, eventType) {
  const run = { id: attempt.analysis_run_id };
  if (attempt.status === "REJECTED" && attempt.attempt_no < 3) {
    const assessment = await loadCleanupAssessment(input, row, attempt.source_asset_id);
    const next = await reserveCleanupAttempt(
      input, run, assessment, attempt.attempt_no + 1, cleanupReasonCodes(attempt.check_result),
    );
    await audit(input, row, eventType, {
      analysisRunId: run.id,
      derivativeAttemptId: attempt.derivative_attempt_id,
      sourceAssetId: attempt.source_asset_id,
      attemptNo: attempt.attempt_no,
      status: attempt.status,
      nextDerivativeAttemptId: next.derivativeAttemptId,
    });
    const enqueued = await enqueue(input, phaseMessage(
      { ...input, analysisRunId: run.id }, "CLEAN_SOURCE_IMAGE_OVERLAY",
      row.status_version, next.derivativeAttemptId,
    ));
    return applied(row.status, row.status_version, enqueued);
  }

  await audit(input, row, eventType, {
    analysisRunId: run.id,
    derivativeAttemptId: attempt.derivative_attempt_id,
    sourceAssetId: attempt.source_asset_id,
    attemptNo: attempt.attempt_no,
    status: attempt.status,
  });
  if (attempt.status === "GENERATED") {
    const enqueued = await enqueue(input, phaseMessage(
      { ...input, analysisRunId: run.id }, "CHECK_SOURCE_IMAGE_CLEANUP",
      row.status_version, attempt.derivative_attempt_id,
    ));
    return applied(row.status, row.status_version, enqueued);
  }
  if (!["ACCEPTED", "REJECTED"].includes(attempt.status)
    || (attempt.status === "REJECTED" && attempt.attempt_no !== 3)) throw conflict();
  if (!await cleanupConverged(input, row)) return applied(row.status, row.status_version, 0);
  const enqueued = await enqueue(input, phaseMessage(
    input, "RECONCILE_SOURCE_IMAGE_ANALYSIS", row.status_version, run.id,
  ));
  return applied(row.status, row.status_version, enqueued);
}

export async function stageInitialPlanWork(rawInput = {}) {
  const input = stageInput(rawInput);
  const boundary = await query(input.client,
    `SELECT i.status,i.status_version,i.planning_contract,i.snapshot_id,
            i.current_source_image_analysis_run_id,s.snapshot,s.snapshot_hash,s.raw_response_ref,
            j.ai_profile_id,j.ai_profile_version,profile.text_model
       FROM auto_listing_job_items AS i
       JOIN auto_listing_jobs AS j ON j.account_id=i.account_id AND j.id=i.job_id
       JOIN auto_listing_source_snapshots AS s ON s.account_id=i.account_id AND s.id=i.snapshot_id
       JOIN ai_gateway_profiles AS profile ON profile.account_id=j.account_id AND profile.id=j.ai_profile_id
        AND profile.config_version=j.ai_profile_version
      WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3
      FOR UPDATE OF i`,
    [input.accountId, input.jobId, input.itemId],
  );
  const row = boundary?.rows?.[0];
  if (boundary?.rowCount !== 1 || !row
    || !isSafeAutoListingAiIdentifier(row.ai_profile_id)
    || !Number.isInteger(row.ai_profile_version) || row.ai_profile_version < 1) throw conflict();
  const nextVersion = input.expectedStatusVersion + 1;
  if (row.planning_contract === "FIXED_SKELETON_SOURCE_IMAGE_V1") {
    const sourceCapture = {
      snapshot: row.snapshot,
      snapshotHash: row.snapshot_hash,
      rawResponseRef: row.raw_response_ref ?? null,
    };
    let sourceAssets;
    try { sourceAssets = enumerateSourceImageAssets({ sourceCapture }); } catch { throw conflict(); }
    if (sourceAssets.length < 1 || !HASH.test(row.snapshot_hash || "")
      || !isSafeAutoListingAiIdentifier(row.snapshot_id) || typeof row.text_model !== "string"
      || !row.text_model.trim()) throw conflict();
    const sourceAssetSetHash = digestJson(sourceAssets);
    const runInputHash = digestJson({
      contractVersion: SOURCE_IMAGE_ANALYSIS_CONTRACT_VERSION,
      sourceSnapshotHash: row.snapshot_hash,
      sourceAssetSetHash,
      promptTemplateVersion: SOURCE_IMAGE_ANALYSIS_PROMPT_VERSION,
      profileId: row.ai_profile_id,
      profileVersion: row.ai_profile_version,
      modelName: row.text_model,
    });
    const runId = deterministicId("source-image-run", [input.accountId, input.jobId, input.itemId,
      nextVersion, runInputHash].join("\0"));
    if (row.status === "PLANNING" && row.status_version === nextVersion) {
      if (row.current_source_image_analysis_run_id !== runId) throw conflict();
      return Object.freeze({ status: "PLANNING", statusVersion: nextVersion });
    }
    if (row.status !== "SOURCE_READY" || row.status_version !== input.expectedStatusVersion
      || row.current_source_image_analysis_run_id !== null) throw conflict();
    const updated = await query(input.client,
      `UPDATE auto_listing_job_items
          SET status='PLANNING',status_version=status_version+1,recovery_point=NULL,
              failure_code=NULL,failure_detail_safe=NULL,updated_at=NOW()
        WHERE account_id=$1 AND job_id=$2 AND id=$3
          AND status='SOURCE_READY' AND status_version=$4
        RETURNING status,status_version`,
      [input.accountId, input.jobId, input.itemId, input.expectedStatusVersion]);
    if (updated?.rowCount !== 1 || updated.rows?.[0]?.status !== "PLANNING"
      || updated.rows[0].status_version !== nextVersion) throw conflict();
    const run = await query(input.client,
      `INSERT INTO auto_listing_source_image_analysis_runs (
        id,account_id,job_id,item_id,source_snapshot_id,expected_status_version,intelligence_contract_version,
        source_snapshot_hash,source_asset_set_hash,input_hash,prompt_template_version,profile_id,profile_version,
        model_name,expected_asset_count,status,parent_run_id,derivation_kind,decision_set,decision_set_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'MATERIALIZING',NULL,'INITIAL','[]'::JSONB,$16)
      RETURNING id`,
      [runId, input.accountId, input.jobId, input.itemId, row.snapshot_id, nextVersion,
        SOURCE_IMAGE_ANALYSIS_CONTRACT_VERSION, row.snapshot_hash, sourceAssetSetHash, runInputHash,
        SOURCE_IMAGE_ANALYSIS_PROMPT_VERSION, row.ai_profile_id, row.ai_profile_version,
        row.text_model, sourceAssets.length, digestJson([])]);
    const pointed = await query(input.client,
      `UPDATE auto_listing_job_items SET current_source_image_analysis_run_id=$4
        WHERE account_id=$1 AND job_id=$2 AND id=$3 AND status_version=$5
          AND current_source_image_analysis_run_id IS NULL RETURNING id`,
      [input.accountId, input.jobId, input.itemId, runId, nextVersion]);
    if (run?.rowCount !== 1 || pointed?.rowCount !== 1) throw conflict();
    const event = await insertEvent(input.client, input, {
      fromStatus: "SOURCE_READY", toStatus: "PLANNING", eventType: "START_PLANNING",
      transitionVersion: nextVersion, details: { phase: "MATERIALIZE_SOURCE_ASSET", analysisRunId: runId },
    });
    if (event?.rowCount !== 1) throw conflict();
    for (const { sourceAssetId } of sourceAssets) {
      await enqueue(input, phaseMessage(input, "MATERIALIZE_SOURCE_ASSET", nextVersion, sourceAssetId));
    }
    return Object.freeze({ status: "PLANNING", statusVersion: nextVersion });
  }
  if (row.status === "PLANNING" && row.status_version === nextVersion) {
    const message = planMessage(input, nextVersion);
    const eventDetails = { phase: "PLAN_CONTENT" };
    const eventIdentity = [input.accountId, input.jobId, input.itemId, "START_PLANNING",
      nextVersion, input.correlationId, JSON.stringify(eventDetails)].join("\0");
    const dedupeKey = autoListingAiMessageDedupeKey(message);
    const staged = await query(input.client,
      `SELECT (
         EXISTS (
           SELECT 1 FROM auto_listing_events
            WHERE id=$8 AND account_id=$1 AND job_id=$2 AND item_id=$3 AND actor_account_id=$4
              AND from_status='SOURCE_READY' AND to_status='PLANNING' AND event_type='START_PLANNING'
              AND transition_version=$5 AND correlation_id=$6 AND details=$9::JSONB
         ) AND EXISTS (
           SELECT 1 FROM auto_listing_ai_outbox
            WHERE id=$10 AND account_id=$1 AND job_id=$2 AND item_id=$3 AND contract_version=$12
              AND phase='PLAN_CONTENT' AND expected_status_version=$5 AND correlation_id=$6
              AND event_type='PLAN_CONTENT' AND phase_target_id IS NULL
              AND dedupe_key=$7 AND payload=$11::JSONB
         )
       ) AS staged`,
      [input.accountId, input.jobId, input.itemId, input.actorAccountId,
        nextVersion, input.correlationId, dedupeKey,
        deterministicId("ai-event", eventIdentity), JSON.stringify(eventDetails),
        deterministicId("ai-outbox", dedupeKey), canonicalizeAutoListingAiMessage(message),
        message.contractVersion],
    );
    if (staged?.rowCount === 1 && staged.rows?.[0]?.staged === true) {
      return Object.freeze({ status: "PLANNING", statusVersion: nextVersion });
    }
    throw conflict();
  }
  if (row.status !== "SOURCE_READY" || row.status_version !== input.expectedStatusVersion) throw conflict();
  const updated = await query(input.client,
    `UPDATE auto_listing_job_items
        SET status='PLANNING',status_version=status_version+1,recovery_point=NULL,
            failure_code=NULL,failure_detail_safe=NULL,updated_at=NOW()
      WHERE account_id=$1 AND job_id=$2 AND id=$3
        AND status='SOURCE_READY' AND status_version=$4
      RETURNING status,status_version`,
    [input.accountId, input.jobId, input.itemId, input.expectedStatusVersion],
  );
  if (updated?.rowCount !== 1 || updated.rows?.[0]?.status !== "PLANNING"
    || updated.rows[0].status_version !== nextVersion) throw conflict();
  const event = await insertEvent(input.client, input, {
    fromStatus: "SOURCE_READY", toStatus: "PLANNING", eventType: "START_PLANNING",
    transitionVersion: nextVersion, details: { phase: "PLAN_CONTENT" },
  });
  const outbox = await insertOutbox(input.client, input.jobId, planMessage(input, nextVersion));
  if (event?.rowCount !== 1 || outbox?.rowCount !== 1) throw conflict();
  return Object.freeze({ status: "PLANNING", statusVersion: nextVersion });
}

export async function applyAutoListingAiPhaseOutcome(rawInput = {}, runtime = {}) {
  const input = applyInput(rawInput);
  const directUploadAllowed = runtime?.directUploadAllowed === true;
  const row = await lockBoundary(input);
  if (!row) return ignored("STALE", null);
  if (row.status === "CANCELLED") return ignored("CANCELLED", row);
  if (row.status_version !== input.expectedStatusVersion || row.status !== PHASE_STATUS[input.phase]) {
    return ignored("STALE", row);
  }

  if (input.outcome.disposition === "FAIL") {
    const retryable = input.outcome.retryable === true;
    const toStatus = retryable ? "RETRYABLE_ERROR" : "BLOCKED";
    const nextVersion = await transition(input, row, retryable ? "RETRYABLE_FAILURE" : "BLOCK",
      toStatus, input.outcome.failureCode);
    return applied(toStatus, nextVersion, 0);
  }

  if (input.outcome.outcome === "STALE") return ignored("STALE", row);
  if (input.outcome.outcome === "CANCELLED") return ignored("CANCELLED", row);

  if (input.phase === "MATERIALIZE_SOURCE_ASSET"
    && row.planning_contract === "FIXED_SKELETON_SOURCE_IMAGE_V1") {
    const { run, assessments } = await loadCurrentAnalysisState(input, row);
    const target = assessments.filter(({ source_asset_id }) => source_asset_id === input.phaseTargetId);
    if (target.length !== 1 || !["MATERIALIZED", "ACCEPTED"].includes(target[0].record_status)) throw conflict();
    await audit(input, row, "AI_SOURCE_ASSET_TERMINAL", {
      analysisRunId: run.id, sourceAssetId: input.phaseTargetId,
    });
    if (assessments.length !== run.expected_asset_count) return applied(row.status, row.status_version, 0);
    const batches = stableAnalysisBatches(assessments);
    let enqueued = 0;
    for (const batch of batches) {
      enqueued += await enqueue(input,
        phaseMessage(input, "ANALYZE_SOURCE_IMAGE_BATCH", row.status_version, batch.analysisBatchId));
    }
    if (batches.length === 0) {
      enqueued += await enqueue(input,
        phaseMessage(input, "RECONCILE_SOURCE_IMAGE_ANALYSIS", row.status_version, run.id));
    }
    return applied(row.status, row.status_version, enqueued);
  }

  if (input.phase === "ANALYZE_SOURCE_IMAGE_BATCH") {
    const { run, assessments } = await loadCurrentAnalysisState(input, row);
    const acceptedBatch = assessments.filter((entry) => entry.analysis_batch_id === input.phaseTargetId
      && entry.record_status === "ACCEPTED");
    if (acceptedBatch.length < 1) throw conflict();
    await audit(input, row, "AI_SOURCE_IMAGE_BATCH_ACCEPTED", {
      analysisRunId: run.id, analysisBatchId: input.phaseTargetId,
    });
    if (assessments.length !== run.expected_asset_count
      || assessments.some(({ record_status }) => record_status !== "ACCEPTED")) {
      return applied(row.status, row.status_version, 0);
    }
    const enqueued = await enqueue(input,
      phaseMessage(input, "RECONCILE_SOURCE_IMAGE_ANALYSIS", row.status_version, run.id));
    return applied(row.status, row.status_version, enqueued);
  }

  if (input.phase === "CLEAN_SOURCE_IMAGE_OVERLAY") {
    const attempt = await loadCleanupAttempt(input, row);
    if (!["GENERATED", "ACCEPTED", "REJECTED"].includes(attempt.status)) throw conflict();
    return advanceCleanupAttempt(input, row, attempt, "AI_SOURCE_IMAGE_CLEANUP_GENERATED");
  }

  if (input.phase === "CHECK_SOURCE_IMAGE_CLEANUP") {
    const attempt = await loadCleanupAttempt(input, row);
    const expectedAttemptStatus = input.outcome.outcome === "SOURCE_IMAGE_CLEANUP_ACCEPTED"
      ? "ACCEPTED" : input.outcome.outcome === "SOURCE_IMAGE_CLEANUP_REJECTED" ? "REJECTED" : null;
    if (attempt.status !== expectedAttemptStatus) throw conflict();
    return advanceCleanupAttempt(input, row, attempt, "AI_SOURCE_IMAGE_CLEANUP_CHECKED");
  }

  if (input.phase === "RECONCILE_SOURCE_IMAGE_ANALYSIS") {
    const { run } = await loadCurrentAnalysisState(input, row);
    if (run.id !== input.phaseTargetId) throw conflict();
    const summary = typeof run.summary === "string" ? JSON.parse(run.summary) : run.summary;
    if (run.status === "CONFIRMATION_REQUIRED") {
      const nextVersion = await transition(input, row, "BLOCK", "BLOCKED",
        "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED");
      return applied("BLOCKED", nextVersion, 0);
    }
    if (run.status !== "ACCEPTED" || !HASH.test(run.summary_hash || "")
      || summary?.summaryHash !== run.summary_hash || !Array.isArray(summary?.eligibleAssetIds)
      || summary.eligibleAssetIds.length < 1) {
      const nextVersion = await transition(input, row, "BLOCK", "BLOCKED",
        "AUTO_LISTING_SOURCE_IMAGE_EVIDENCE_INSUFFICIENT");
      return applied("BLOCKED", nextVersion, 0);
    }
    await audit(input, row, "AI_SOURCE_IMAGE_ANALYSIS_READY", {
      analysisRunId: run.id, summaryHash: run.summary_hash,
    });
    const enqueued = await enqueue(input, phaseMessage(input, "PLAN_CONTENT", row.status_version));
    return applied(row.status, row.status_version, enqueued);
  }

  if (input.phase === "PLAN_CONTENT") {
    const plan = await loadActivePlan(input, { parent: true });
    if (row.planning_contract === "FIXED_SKELETON_SOURCE_IMAGE_V1") {
      if (plan.source_image_analysis_run_id !== row.current_source_image_analysis_run_id
        || !HASH.test(plan.source_image_intelligence_hash || "")) throw conflict();
      await audit(input, row, "AI_PLAN_READY", { planId: plan.id, sourceReferenceCount: 0 });
      const enqueued = await enqueue(input,
        phaseMessage(input, "FINALIZE_MATERIALIZED_PLAN", row.status_version));
      return applied(row.status, row.status_version, enqueued);
    }
    const refs = sourceReferences(plan.visual_groups);
    await audit(input, row, "AI_PLAN_READY", { planId: plan.id, sourceReferenceCount: refs.length });
    let enqueued = 0;
    if (refs.length === 0) {
      enqueued += await enqueue(input, phaseMessage(input, "FINALIZE_MATERIALIZED_PLAN", row.status_version));
    } else {
      for (const [sourceAssetId] of refs) {
        enqueued += await enqueue(input,
          phaseMessage(input, "MATERIALIZE_SOURCE_ASSET", row.status_version, sourceAssetId));
      }
    }
    return applied(row.status, row.status_version, enqueued);
  }

  if (input.phase === "MATERIALIZE_SOURCE_ASSET") {
    const plan = await loadActivePlan(input, { parent: true });
    const refs = sourceReferences(plan.visual_groups);
    if (!refs.some(([assetId]) => assetId === input.phaseTargetId)) throw conflict();
    const accepted = await query(input.client,
      `SELECT DISTINCT source_asset_id,source_ref_hash
         FROM auto_listing_source_materialization_attempts
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND parent_plan_id=$4
          AND expected_status_version=$5 AND status='ACCEPTED'`,
      [input.accountId, input.jobId, input.itemId, plan.id, row.status_version]);
    const expectedRefs = new Map(refs);
    const acceptedIds = new Set();
    for (const value of accepted?.rows || []) {
      if (expectedRefs.get(value.source_asset_id) !== value.source_ref_hash) throw conflict();
      acceptedIds.add(value.source_asset_id);
    }
    if (!acceptedIds.has(input.phaseTargetId)) throw conflict();
    await audit(input, row, "AI_SOURCE_ASSET_ACCEPTED", {
      planId: plan.id, sourceAssetId: input.phaseTargetId,
    });
    let enqueued = 0;
    if (refs.every(([assetId]) => acceptedIds.has(assetId))) {
      enqueued = await enqueue(input, phaseMessage(input, "FINALIZE_MATERIALIZED_PLAN", row.status_version));
    }
    return applied(row.status, row.status_version, enqueued);
  }

  if (input.phase === "FINALIZE_MATERIALIZED_PLAN") {
    const plan = await loadActivePlan(input, { parent: false });
    const slots = planSlots(plan.plan);
    const nextVersion = await transition(input, row, "PLAN_READY", "GENERATING");
    let enqueued = 0;
    for (const slotKey of [...slots.keys()].sort()) {
      enqueued += await enqueue(input, phaseMessage(input, "GENERATE_IMAGE_SLOT", nextVersion, slotKey));
    }
    return applied("GENERATING", nextVersion, enqueued);
  }

  if (input.phase === "GENERATE_IMAGE_SLOT") {
    const plan = await loadActivePlan(input, { parent: false });
    const slots = planSlots(plan.plan);
    if (!slots.has(input.phaseTargetId)) throw conflict();
    const eventType = input.outcome.outcome === "IMAGE_SLOT_SKIPPED"
      ? "AI_IMAGE_SLOT_SKIPPED" : "AI_IMAGE_SLOT_ACCEPTED";
    await audit(input, row, eventType, {
      planId: plan.id,
      slotKey: input.phaseTargetId,
      statusVersion: row.status_version,
    });
    const terminal = await query(input.client,
       `WITH planned AS (
         SELECT slot->>'slotKey' AS slot_key,slot->>'role' AS role,
                slot->>'visualGroupKey' AS visual_group_key
           FROM ai_content_plans p CROSS JOIN LATERAL jsonb_array_elements(p.plan->'slots') AS slot
          WHERE p.account_id=$1 AND p.job_id=$2 AND p.item_id=$3 AND p.id=$4
       ), latest_group_checks AS (
         SELECT DISTINCT ON (visual_group_key)
                visual_group_key,status,expected_status_version,result
           FROM auto_listing_image_group_checks
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
            AND expected_status_version<=$5
          ORDER BY visual_group_key,expected_status_version DESC,
                   completed_at DESC NULLS LAST,created_at DESC,id DESC
       ), accepted AS (
         SELECT DISTINCT ON (asset.slot_key) asset.slot_key,asset.role,asset.created_at
           FROM ai_generation_assets AS asset
           JOIN ai_content_plans AS plan
             ON plan.account_id=asset.account_id AND plan.job_id=asset.job_id
               AND plan.item_id=asset.item_id AND plan.id=asset.plan_id
           CROSS JOIN LATERAL jsonb_array_elements(plan.plan->'slots') AS planned_slot
          WHERE asset.account_id=$1 AND asset.job_id=$2 AND asset.item_id=$3 AND asset.plan_id=$4
            AND asset.status='ACCEPTED' AND planned_slot->>'slotKey'=asset.slot_key
            AND (asset.expected_status_version IS NULL OR asset.expected_status_version<=$5)
            AND NOT EXISTS (
              SELECT 1 FROM latest_group_checks AS group_check
               WHERE group_check.visual_group_key=planned_slot->>'visualGroupKey'
                 AND group_check.status='REJECTED'
                 AND group_check.result->'retrySlotKeys' ? asset.slot_key
                 AND COALESCE(asset.expected_status_version,0)<=group_check.expected_status_version
            )
            AND (plan.prompt_template_version NOT IN ('AUTO_LISTING_CONTENT_PLAN_FILL_V3','AUTO_LISTING_CONTENT_PLAN_FILL_V4','AUTO_LISTING_CONTENT_PLAN_FILL_V5','AUTO_LISTING_CONTENT_PLAN_FILL_V6')
              OR jsonb_array_length(planned_slot->'claims')>0
              OR (plan.prompt_template_version='AUTO_LISTING_CONTENT_PLAN_FILL_V6'
                AND planned_slot->>'role'='MAIN')
              OR asset.checker_result->>'textForbidden'='true')
          ORDER BY asset.slot_key,asset.expected_status_version DESC NULLS LAST,
                   asset.created_at DESC,asset.attempt_no DESC,asset.id DESC
       ), skipped AS (
         SELECT DISTINCT ON (details->>'slotKey') details->>'slotKey' AS slot_key,created_at
           FROM auto_listing_events
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND event_type='AI_IMAGE_SLOT_SKIPPED'
            AND details->>'planId'=$4 AND details->>'statusVersion'=$5::TEXT
          ORDER BY details->>'slotKey',created_at DESC,id DESC
       )
       SELECT p.slot_key,p.role,p.visual_group_key,
              CASE WHEN s.slot_key IS NOT NULL AND (a.slot_key IS NULL OR s.created_at>=a.created_at)
                     THEN 'SKIPPED'
                   WHEN a.slot_key IS NOT NULL THEN 'ACCEPTED' ELSE 'PENDING' END AS terminal_status
         FROM planned p
         LEFT JOIN accepted a ON a.slot_key=p.slot_key AND a.role=p.role
         LEFT JOIN skipped s ON s.slot_key=p.slot_key`,
      [input.accountId, input.jobId, input.itemId, plan.id, row.status_version]);
    if (terminal?.rowCount !== slots.size) throw conflict();
    const terminalRows = terminal.rows || [];
    if (terminalRows.some((asset) => asset.terminal_status === "PENDING")) {
      return applied(row.status, row.status_version, 0);
    }
    const acceptedRows = terminalRows.filter((asset) => asset.terminal_status === "ACCEPTED");
    const acceptedByGroup = new Map();
    for (const asset of acceptedRows) {
      const key = asset.visual_group_key || "__single_group__";
      const group = acceptedByGroup.get(key) || [];
      group.push(asset);
      acceptedByGroup.set(key, group);
    }
    const plannedGroupKeys = new Set(terminalRows.map((asset) => asset.visual_group_key || "__single_group__"));
    const sufficient = acceptedByGroup.size === plannedGroupKeys.size
      && [...acceptedByGroup.values()].every((assets) => assets.length >= 6 && assets.length <= 13
        && assets.some((asset) => asset.role === "MAIN"));
    if (!sufficient) {
      const skippedSlotKeys = terminalRows.filter((asset) => asset.terminal_status === "SKIPPED")
        .map((asset) => asset.slot_key).sort();
      if (skippedSlotKeys.length > 0) {
        const recoveries = await query(input.client,
          `SELECT retry_slot.slot_key,COUNT(recovery.id)::INTEGER AS recovery_count
             FROM unnest($5::TEXT[]) AS retry_slot(slot_key)
             LEFT JOIN auto_listing_events AS recovery
               ON recovery.account_id=$1 AND recovery.job_id=$2 AND recovery.item_id=$3
              AND recovery.event_type='AI_IMAGE_SLOT_RECOVERY_QUEUED'
              AND recovery.details->>'planId'=$4
              AND recovery.details->'retrySlotKeys' ? retry_slot.slot_key
            GROUP BY retry_slot.slot_key
            ORDER BY retry_slot.slot_key`,
          [input.accountId, input.jobId, input.itemId, plan.id, skippedSlotKeys]);
        if (!recoveries || !Array.isArray(recoveries.rows)
          || recoveries.rows.length !== skippedSlotKeys.length) throw conflict();
        const recoveryCounts = new Map(recoveries.rows.map((entry) =>
          [entry.slot_key, Number(entry.recovery_count)]));
        if (recoveryCounts.size !== skippedSlotKeys.length
          || skippedSlotKeys.some((slotKey) => !Number.isSafeInteger(recoveryCounts.get(slotKey))
            || recoveryCounts.get(slotKey) < 0)) throw conflict();
        const exhausted = skippedSlotKeys.some((slotKey) =>
          recoveryCounts.get(slotKey) >= MAX_IMAGE_SLOT_RECOVERY_ROUNDS);
        if (!exhausted) {
          const retryVersion = row.status_version + 1;
          const advanced = await query(input.client,
            `UPDATE auto_listing_job_items
                SET status_version=status_version+1,recovery_point=NULL,
                    failure_code=NULL,failure_detail_safe=NULL,updated_at=NOW()
              WHERE account_id=$1 AND job_id=$2 AND id=$3
                AND status='GENERATING' AND status_version=$4
              RETURNING status,status_version`,
            [input.accountId, input.jobId, input.itemId, row.status_version]);
          if (advanced?.rowCount !== 1 || advanced.rows?.[0]?.status !== "GENERATING"
            || advanced.rows[0].status_version !== retryVersion) throw conflict();
          const recoveryRound = Math.max(...skippedSlotKeys.map((slotKey) =>
            recoveryCounts.get(slotKey))) + 1;
          const event = await insertEvent(input.client, { ...input, actorAccountId: input.accountId }, {
            fromStatus: "GENERATING",
            toStatus: "GENERATING",
            eventType: "AI_IMAGE_SLOT_RECOVERY_QUEUED",
            transitionVersion: retryVersion,
            details: {
              planId: plan.id,
              previousStatusVersion: row.status_version,
              retrySlotKeys: skippedSlotKeys,
              recoveryRound,
            },
          });
          if (event?.rowCount !== 1) throw conflict();
          let enqueued = 0;
          for (const slotKey of skippedSlotKeys) {
            enqueued += await enqueue(input,
              phaseMessage(input, "GENERATE_IMAGE_SLOT", retryVersion, slotKey));
          }
          return applied("GENERATING", retryVersion, enqueued);
        }
      }
      const nextVersion = await transition(input, row, "BLOCK", "BLOCKED",
        "AUTO_LISTING_MINIMUM_IMAGE_COUNT_NOT_MET");
      return applied("BLOCKED", nextVersion, 0);
    }
    let enqueued = 0;
    if (row.planning_contract === "FIXED_SKELETON_SOURCE_IMAGE_V1") {
      const checks = await query(input.client,
        `SELECT DISTINCT ON (visual_group_key) visual_group_key,status
           FROM auto_listing_image_group_checks
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
            AND expected_status_version<=$5
          ORDER BY visual_group_key,expected_status_version DESC,
                   completed_at DESC NULLS LAST,created_at DESC,id DESC`,
        [input.accountId, input.jobId, input.itemId, plan.id, row.status_version]);
      if (!checks || !Array.isArray(checks.rows)) throw conflict();
      const acceptedGroupKeys = new Set(checks.rows.filter(({ status }) => status === "ACCEPTED")
        .map(({ visual_group_key: key }) => key));
      if ([...plannedGroupKeys].some((key) => !acceptedGroupKeys.has(key))) {
        const exhaustedGroupKeys = await exhaustedImageGroupKeys(input, plan.id);
        for (const key of exhaustedGroupKeys) {
          if (plannedGroupKeys.has(key)) acceptedGroupKeys.add(key);
        }
      }
      for (const visualGroupKey of [...plannedGroupKeys].sort()) {
        if (acceptedGroupKeys.has(visualGroupKey)) continue;
        enqueued += await enqueueOrRequeueCompleted(input,
          phaseMessage(input, "CHECK_IMAGE_GROUP", row.status_version, visualGroupKey));
      }
    } else {
      enqueued = await enqueue(input, phaseMessage(input, "GENERATE_RICH_CONTENT", row.status_version));
    }
    return applied(row.status, row.status_version, enqueued);
  }

  if (input.phase === "CHECK_IMAGE_GROUP") {
    const plan = await loadActivePlan(input, { parent: false });
    const groupKeys = new Set((plan.visual_groups?.groups || []).map((group) => group?.visualGroupKey)
      .filter(isSafeAutoListingAiIdentifier));
    if (!groupKeys.has(input.phaseTargetId)) throw conflict();
    const checks = await query(input.client,
      `SELECT DISTINCT ON (visual_group_key) id,visual_group_key,expected_status_version,status,result
         FROM auto_listing_image_group_checks
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
          AND expected_status_version<=$5
        ORDER BY visual_group_key,expected_status_version DESC,
                 completed_at DESC NULLS LAST,created_at DESC,id DESC`,
      [input.accountId, input.jobId, input.itemId, plan.id, row.status_version]);
    if (!checks || !Array.isArray(checks.rows)) throw conflict();
    const byGroup = new Map(checks.rows.map((entry) => [entry.visual_group_key, entry]));
    const current = byGroup.get(input.phaseTargetId);
    if (!current || current.expected_status_version !== row.status_version) throw conflict();
    const result = typeof current.result === "string" ? JSON.parse(current.result) : current.result;
    if (input.outcome.outcome === "IMAGE_GROUP_RETRY_QUEUED") {
      const retrySlotKeys = result?.retrySlotKeys;
      if (current.status !== "REJECTED" || !Array.isArray(retrySlotKeys) || retrySlotKeys.length < 1
        || new Set(retrySlotKeys).size !== retrySlotKeys.length) throw conflict();
      const slots = planSlots(plan.plan);
      const orderedRetrySlotKeys = [...retrySlotKeys].sort();
      if (orderedRetrySlotKeys.some((slotKey) => slots.get(slotKey)?.visualGroupKey !== input.phaseTargetId)) {
        throw conflict();
      }
      const attempts = await query(input.client,
        `WITH retry_slots AS (
           SELECT slot->>'slotKey' AS slot_key,slot->>'role' AS role
             FROM ai_content_plans AS plan
             CROSS JOIN LATERAL jsonb_array_elements(plan.plan->'slots') AS slot
            WHERE plan.account_id=$1 AND plan.job_id=$2 AND plan.item_id=$3 AND plan.id=$4
              AND slot->>'slotKey'=ANY($5::TEXT[])
         )
         SELECT planned.slot_key,planned.role,
                COUNT(asset.id) FILTER (WHERE asset.status='ACCEPTED')::INTEGER AS attempt_count
           FROM retry_slots AS planned
           LEFT JOIN ai_generation_assets AS asset
             ON asset.account_id=$1 AND asset.job_id=$2 AND asset.item_id=$3 AND asset.plan_id=$4
            AND asset.slot_key=planned.slot_key
          GROUP BY planned.slot_key,planned.role
          ORDER BY planned.slot_key`,
        [input.accountId, input.jobId, input.itemId, plan.id, orderedRetrySlotKeys]);
      if (!attempts || !Array.isArray(attempts.rows) || attempts.rows.length !== orderedRetrySlotKeys.length) {
        throw conflict();
      }
      const attemptsBySlot = new Map(attempts.rows.map((entry) => [entry.slot_key, entry]));
      if (attemptsBySlot.size !== orderedRetrySlotKeys.length
        || orderedRetrySlotKeys.some((slotKey) => {
          const entry = attemptsBySlot.get(slotKey);
          const planned = slots.get(slotKey);
          const count = Number(entry?.attempt_count);
          return !entry || entry.role !== planned?.role || !Number.isSafeInteger(count) || count < 1;
        })) throw conflict();
      const exhausted = orderedRetrySlotKeys.some((slotKey) =>
        Number(attemptsBySlot.get(slotKey).attempt_count)
          >= MAX_IMAGE_GROUP_ACCEPTED_CANDIDATES_PER_SLOT);
      if (exhausted) {
        if (!softImageGroupFailure(result)) {
          const nextVersion = await transition(input, row, "BLOCK", "BLOCKED",
            "AUTO_LISTING_IMAGE_GROUP_RETRY_LIMIT_REACHED");
          return applied("BLOCKED", nextVersion, 0);
        }
        const warning = {
          planId: plan.id,
          visualGroupKey: input.phaseTargetId,
          retrySlotKeys: orderedRetrySlotKeys,
          reasonCodes: [...result.reasonCodes].sort(),
        };
        await audit(input, row, "AI_IMAGE_GROUP_RETRY_EXHAUSTED", warning);
        const terminalGroupKeys = new Set(checks.rows
          .filter(({ status }) => status === "ACCEPTED")
          .map(({ visual_group_key: key }) => key));
        terminalGroupKeys.add(input.phaseTargetId);
        if ([...groupKeys].some((key) => !terminalGroupKeys.has(key))) {
          const previouslyExhausted = await exhaustedImageGroupKeys(input, plan.id);
          for (const key of previouslyExhausted) {
            if (groupKeys.has(key)) terminalGroupKeys.add(key);
          }
        }
        const enqueued = [...groupKeys].every((key) => terminalGroupKeys.has(key))
          ? await enqueue(input, phaseMessage(input, "GENERATE_RICH_CONTENT", row.status_version)) : 0;
        return applied(row.status, row.status_version, enqueued);
      }
      const retryVersion = row.status_version + 1;
      const advanced = await query(input.client,
        `UPDATE auto_listing_job_items
            SET status_version=status_version+1,recovery_point=NULL,
                failure_code=NULL,failure_detail_safe=NULL,updated_at=NOW()
          WHERE account_id=$1 AND job_id=$2 AND id=$3
            AND status='GENERATING' AND status_version=$4
          RETURNING status,status_version`,
        [input.accountId, input.jobId, input.itemId, row.status_version]);
      if (advanced?.rowCount !== 1 || advanced.rows?.[0]?.status !== "GENERATING"
        || advanced.rows[0].status_version !== retryVersion) throw conflict();
      const event = await insertEvent(input.client, { ...input, actorAccountId: input.accountId }, {
        fromStatus: "GENERATING",
        toStatus: "GENERATING",
        eventType: "AI_IMAGE_GROUP_RETRY_QUEUED",
        transitionVersion: retryVersion,
        details: { planId: plan.id, visualGroupKey: input.phaseTargetId, retrySlotKeys: orderedRetrySlotKeys },
      });
      if (event?.rowCount !== 1) throw conflict();
      let enqueued = 0;
      for (const slotKey of orderedRetrySlotKeys) {
        enqueued += await enqueue(input,
          phaseMessage(input, "GENERATE_IMAGE_SLOT", retryVersion, slotKey));
      }
      return applied(row.status, retryVersion, enqueued);
    }
    if (current.status !== "ACCEPTED") throw conflict();
    await audit(input, row, "AI_IMAGE_GROUP_ACCEPTED", {
      planId: plan.id, visualGroupKey: input.phaseTargetId,
    });
    const terminalGroupKeys = new Set(checks.rows.filter(({ status }) => status === "ACCEPTED")
      .map(({ visual_group_key: key }) => key));
    if ([...groupKeys].some((key) => !terminalGroupKeys.has(key))) {
      const previouslyExhausted = await exhaustedImageGroupKeys(input, plan.id);
      for (const key of previouslyExhausted) {
        if (groupKeys.has(key)) terminalGroupKeys.add(key);
      }
    }
    if ([...groupKeys].some((key) => !terminalGroupKeys.has(key))) {
      return applied(row.status, row.status_version, 0);
    }
    const enqueued = await enqueue(input,
      phaseMessage(input, "GENERATE_RICH_CONTENT", row.status_version));
    return applied(row.status, row.status_version, enqueued);
  }

  const plan = await loadActivePlan(input, { parent: false });
  const evidence = await query(input.client,
    `WITH planned AS (
       SELECT DISTINCT group_row->>'visualGroupKey' AS group_key
         FROM ai_content_plans p
         CROSS JOIN LATERAL jsonb_array_elements(p.visual_groups->'groups') AS group_row
        WHERE p.account_id=$1 AND p.job_id=$2 AND p.item_id=$3 AND p.id=$4
     ), accepted_results AS (
       SELECT r.id,r.accepted_at,r.created_at,MIN(asset->>'visualGroupKey') AS group_key,
              COUNT(DISTINCT asset->>'visualGroupKey')::INTEGER AS group_count
         FROM ai_rich_content_results r
         CROSS JOIN LATERAL jsonb_array_elements(r.asset_evidence) AS asset
        WHERE r.account_id=$1 AND r.job_id=$2 AND r.item_id=$3 AND r.plan_id=$4 AND r.status='ACCEPTED'
        GROUP BY r.id,r.accepted_at,r.created_at
     ), accepted_groups AS (
       SELECT DISTINCT ON (group_key) group_key
         FROM accepted_results
        WHERE group_count=1
        ORDER BY group_key,accepted_at DESC NULLS LAST,created_at DESC,id DESC
     )
     SELECT (SELECT COUNT(*) FROM planned) AS planned_group_count,
            (SELECT COUNT(*) FROM accepted_groups a JOIN planned p USING(group_key)) AS accepted_group_count,
            (SELECT COUNT(*) FROM accepted_results a
              WHERE group_count<>1 OR NOT EXISTS (SELECT 1 FROM planned p WHERE p.group_key=a.group_key)) AS invalid_result_count,
            0::INTEGER AS duplicate_group_count`,
    [input.accountId, input.jobId, input.itemId, plan.id]);
  const coverage = evidence?.rowCount === 1 ? evidence.rows?.[0] : null;
  const plannedCount = Number(coverage?.planned_group_count);
  if (!Number.isSafeInteger(plannedCount) || plannedCount < 1
    || Number(coverage?.accepted_group_count) !== plannedCount
    || Number(coverage?.invalid_result_count) !== 0) throw conflict();
  const policy = await query(input.client,
    `SELECT policy.mode,policy.enabled
       FROM auto_listing_jobs AS job
       JOIN auto_listing_upload_policy_versions AS policy
         ON policy.account_id=job.account_id AND policy.id=job.upload_policy_version_id
      WHERE job.account_id=$1 AND job.id=$2
        AND policy.enabled IS TRUE AND policy.published_by IS NOT NULL AND policy.published_at IS NOT NULL
      FOR SHARE OF policy`,
    [input.accountId, input.jobId]);
  const mode = policy?.rowCount === 1 ? policy.rows?.[0]?.mode : null;
  if (row.planning_contract !== "FIXED_SKELETON_V1"
    && row.planning_contract !== "FIXED_SKELETON_SOURCE_IMAGE_V1"
    && row.planning_contract !== "LEGACY_FULL_PLAN_V3"
    && row.planning_contract !== undefined) {
    throw conflict();
  }
  if (mode === "DIRECT" && !directUploadAllowed) {
    const nextVersion = await transition(input, row, "BLOCK", "BLOCKED", "AUTO_LISTING_DIRECT_UPLOAD_DISABLED");
    return applied("BLOCKED", nextVersion, 0);
  }
  if (mode === "DIRECT") {
    const nextVersion = await transition(input, row, "CONTENT_READY_FOR_DIRECT_UPLOAD", "UPLOAD_QUEUED");
    await enqueueAutoListingUploadTask({ client: input.client, accountId: input.accountId, jobId: input.jobId,
      itemId: input.itemId, actorAccountId: input.accountId, expectedStatusVersion: nextVersion,
      correlationId: input.correlationId, enqueueReason: "DIRECT_READY" });
    return applied("UPLOAD_QUEUED", nextVersion, 1);
  }
  if (mode !== "REVIEW") throw conflict();
  const nextVersion = await transition(input, row, "CONTENT_READY_FOR_REVIEW", "READY_FOR_REVIEW");
  return applied("READY_FOR_REVIEW", nextVersion, 0);
}

async function lockExecutionFence(client, message, execution) {
  const result = await query(client,
    `SELECT outbox.id,outbox.job_id,outbox.uncertain_result_count,
            item.status,item.status_version,channel.enabled
       FROM auto_listing_ai_outbox AS outbox
       JOIN auto_listing_job_items AS item
         ON item.account_id=outbox.account_id AND item.job_id=outbox.job_id AND item.id=outbox.item_id
       JOIN auto_listing_ai_profile_channels AS channel
         ON channel.account_id=outbox.account_id
        AND channel.assigned_job_id=outbox.job_id AND channel.assigned_item_id=outbox.item_id
      WHERE outbox.account_id=$1 AND outbox.id=$2 AND outbox.item_id=$3
        AND outbox.dispatch_generation=$4
        AND outbox.publication_id=outbox.dedupe_key || ':' || outbox.dispatch_generation
        AND outbox.dispatch_contract_version='CHANNEL_WORK_V1' AND outbox.state='PROCESSING'
        AND outbox.expected_status_version=$5
        AND outbox.lease_owner=$6 AND outbox.lease_token=$7 AND outbox.lease_expires_at>NOW()
        AND item.status_version=outbox.expected_status_version
        AND channel.channel_id=$8 AND channel.connection_id=$9 AND channel.connection_version=$10
        AND channel.assigned_status_version=outbox.expected_status_version
        AND channel.execution_lease_owner=$6 AND channel.execution_lease_token=$7
        AND channel.execution_lease_expires_at=outbox.lease_expires_at
        AND channel.execution_lease_expires_at>NOW()
      FOR UPDATE OF outbox,item,channel`,
    [message.accountId, execution.outboxId, message.itemId, execution.dispatchGeneration,
      message.expectedStatusVersion, execution.leaseOwner, execution.leaseToken,
      execution.channelId, execution.connectionId, execution.connectionVersion],
  );
  return result?.rowCount === 1 ? result.rows?.[0] : null;
}

async function finishExecution(client, message, execution, result, resetChannelHealth) {
  const outbox = await query(client,
    `UPDATE auto_listing_ai_outbox
        SET state='COMPLETED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            next_retry_at=NULL,last_error_code=NULL,last_error_safe=NULL,updated_at=NOW()
      WHERE account_id=$1 AND id=$2 AND item_id=$3 AND dispatch_generation=$4
        AND state='PROCESSING' AND lease_owner=$5 AND lease_token=$6
      RETURNING id`,
    [message.accountId, execution.outboxId, message.itemId, execution.dispatchGeneration,
      execution.leaseOwner, execution.leaseToken],
  );
  const keepAssignment = ["PLANNING", "GENERATING"].includes(result.status);
  const channel = await query(client,
    `UPDATE auto_listing_ai_profile_channels
        SET execution_lease_owner=NULL,execution_lease_token=NULL,execution_lease_expires_at=NULL,
            assigned_job_id=CASE WHEN enabled AND $8 THEN assigned_job_id ELSE NULL END,
            assigned_item_id=CASE WHEN enabled AND $8 THEN assigned_item_id ELSE NULL END,
            assigned_status_version=CASE WHEN enabled AND $8 THEN $10::INTEGER ELSE NULL END,
            assigned_at=CASE WHEN enabled AND $8 THEN assigned_at ELSE NULL END,
            consecutive_failure_count=CASE WHEN $9 THEN 0 ELSE consecutive_failure_count END,
            last_error_code=CASE WHEN $9 AND cooldown_until<=NOW() THEN NULL ELSE last_error_code END,
            cooldown_until=CASE WHEN $9 AND cooldown_until<=NOW() THEN NULL ELSE cooldown_until END,
            updated_at=NOW()
      WHERE account_id=$1 AND channel_id=$2 AND assigned_item_id=$3
        AND assigned_status_version=$4 AND execution_lease_owner=$5 AND execution_lease_token=$6
        AND connection_id=$7
      RETURNING channel_id`,
    [message.accountId, execution.channelId, message.itemId, message.expectedStatusVersion,
      execution.leaseOwner, execution.leaseToken, execution.connectionId, keepAssignment, resetChannelHealth,
      result.statusVersion],
  );
  if (outbox?.rowCount !== 1 || channel?.rowCount !== 1) throw conflict();
}

async function requeueExecution(client, message, execution, outcome, fence, runtime) {
  const uncertain = outcome.deliveryState === "POSSIBLY_SENT";
  const nextUncertainCount = Number(fence.uncertain_result_count) + (uncertain ? 1 : 0);
  if (uncertain && nextUncertainCount >= MAX_UNCERTAIN_RESULT_COUNT) {
    const terminalOutcome = Object.freeze({
      contractVersion: "V1", disposition: "FAIL", phase: message.phase, outcome: "FAILED",
      retryable: true, failureCode: "AUTO_LISTING_AI_RESULT_UNCERTAIN",
      correlationId: message.correlationId,
      failureScope: "BUSINESS", deliveryState: null, retryAfterMs: null,
    });
    const result = await applyAutoListingAiPhaseOutcome({
      client, accountId: message.accountId, jobId: fence.job_id, itemId: message.itemId,
      expectedStatusVersion: message.expectedStatusVersion, correlationId: message.correlationId,
      phase: message.phase, phaseTargetId: autoListingAiMessagePhaseTarget(message),
      outcome: terminalOutcome,
    }, runtime);
    const count = await query(client,
      `UPDATE auto_listing_ai_outbox SET uncertain_result_count=$7,updated_at=NOW()
        WHERE account_id=$1 AND id=$2 AND item_id=$3 AND dispatch_generation=$4
          AND lease_owner=$5 AND lease_token=$6 RETURNING id`,
      [message.accountId, execution.outboxId, message.itemId, execution.dispatchGeneration,
        execution.leaseOwner, execution.leaseToken, MAX_UNCERTAIN_RESULT_COUNT],
    );
    if (count?.rowCount !== 1) throw conflict();
    const cooldownMs = outcome.retryAfterMs ?? DEFAULT_CHANNEL_COOLDOWN_MS;
    const failedChannel = await query(client,
      `UPDATE auto_listing_ai_profile_channels
          SET cooldown_until=NOW()+($8 * INTERVAL '1 millisecond'),
              requires_revalidation=requires_revalidation OR $9,
              last_error_code=$7,consecutive_failure_count=consecutive_failure_count+1,updated_at=NOW()
        WHERE account_id=$1 AND channel_id=$2 AND assigned_item_id=$3
          AND assigned_status_version=$4 AND execution_lease_owner=$5 AND execution_lease_token=$6
        RETURNING channel_id`,
      [message.accountId, execution.channelId, message.itemId, message.expectedStatusVersion,
        execution.leaseOwner, execution.leaseToken, outcome.failureCode, cooldownMs,
        outcome.failureScope === "CHANNEL_REVALIDATION"],
    );
    if (failedChannel?.rowCount !== 1) throw conflict();
    await finishExecution(client, message, execution, result, false);
    return result;
  }

  const cooldownMs = outcome.retryAfterMs ?? DEFAULT_CHANNEL_COOLDOWN_MS;
  const channel = await query(client,
    `UPDATE auto_listing_ai_profile_channels
        SET cooldown_until=NOW()+($8 * INTERVAL '1 millisecond'),
            requires_revalidation=requires_revalidation OR $9,
            last_error_code=$7,consecutive_failure_count=consecutive_failure_count+1,
            assigned_job_id=NULL,assigned_item_id=NULL,assigned_status_version=NULL,assigned_at=NULL,
            execution_lease_owner=NULL,execution_lease_token=NULL,execution_lease_expires_at=NULL,updated_at=NOW()
      WHERE account_id=$1 AND channel_id=$2 AND assigned_item_id=$3
        AND assigned_status_version=$4 AND execution_lease_owner=$5 AND execution_lease_token=$6
      RETURNING channel_id`,
    [message.accountId, execution.channelId, message.itemId, message.expectedStatusVersion,
      execution.leaseOwner, execution.leaseToken, outcome.failureCode, cooldownMs,
      outcome.failureScope === "CHANNEL_REVALIDATION"],
  );
  const outbox = await query(client,
    `UPDATE auto_listing_ai_outbox
        SET state='PENDING',publication_id=NULL,published_at=NULL,dispatch_queued_at=NULL,
            lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_retry_at=NOW(),
            uncertain_result_count=$7,last_error_code=$8,last_error_safe=NULL,updated_at=NOW()
      WHERE account_id=$1 AND id=$2 AND item_id=$3 AND dispatch_generation=$4
        AND state='PROCESSING' AND lease_owner=$5 AND lease_token=$6
      RETURNING id`,
    [message.accountId, execution.outboxId, message.itemId, execution.dispatchGeneration,
      execution.leaseOwner, execution.leaseToken, nextUncertainCount, outcome.failureCode],
  );
  if (channel?.rowCount !== 1 || outbox?.rowCount !== 1) throw conflict();
  return Object.freeze({ disposition: "REQUEUED", status: fence.status,
    statusVersion: fence.status_version, enqueued: 0, uncertainResultCount: nextUncertainCount });
}

async function deferBusyReservation(client, message, execution, outcome, fence) {
  const channel = await query(client,
    `UPDATE auto_listing_ai_profile_channels
        SET execution_lease_owner=NULL,execution_lease_token=NULL,execution_lease_expires_at=NULL,updated_at=NOW()
      WHERE account_id=$1 AND channel_id=$2 AND assigned_item_id=$3
        AND assigned_status_version=$4 AND execution_lease_owner=$5 AND execution_lease_token=$6
        AND connection_id=$7 AND connection_version=$8
      RETURNING channel_id`,
    [message.accountId, execution.channelId, message.itemId, message.expectedStatusVersion,
      execution.leaseOwner, execution.leaseToken, execution.connectionId, execution.connectionVersion],
  );
  const outbox = await query(client,
    `UPDATE auto_listing_ai_outbox
        SET state='PENDING',publication_id=NULL,published_at=NULL,dispatch_queued_at=NULL,
            lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            next_retry_at=NOW()+($7 * INTERVAL '1 millisecond'),
            last_error_code=NULL,last_error_safe=NULL,updated_at=NOW()
      WHERE account_id=$1 AND id=$2 AND item_id=$3 AND dispatch_generation=$4
        AND state='PROCESSING' AND lease_owner=$5 AND lease_token=$6
      RETURNING id`,
    [message.accountId, execution.outboxId, message.itemId, execution.dispatchGeneration,
      execution.leaseOwner, execution.leaseToken, outcome.retryAfterMs],
  );
  if (channel?.rowCount !== 1 || outbox?.rowCount !== 1) throw conflict();
  return Object.freeze({ disposition: "DEFERRED", status: fence.status,
    statusVersion: fence.status_version, enqueued: 0 });
}

export function createPostgresAutoListingAiWorkflow(rawOptions = {}) {
  const options = factoryOptions(rawOptions);
  const pool = options.pool;
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") throw invalid();
  return Object.freeze({
    stageInitialPlanWork,
    async applyPhaseOutcome(rawInput = {}) {
      const envelope = factoryApplyEnvelope(rawInput);
      let message;
      try { message = normalizeAutoListingAiMessage(envelope.message); } catch { throw invalid(); }
      const execution = executionInput(message, envelope.execution);
      const normalizedOutcome = validatedOutcome(envelope.outcome, message.phase, message.correlationId, {
        allowReservationBusy: execution !== null,
      });
      let client;
      try {
        client = await pool.connect();
        if (!client || typeof client.query !== "function") throw failed();
        await query(client, "BEGIN");
        await configureTransaction(client);
        const fence = execution ? await lockExecutionFence(client, message, execution) : null;
        const scope = execution ? null : await query(client,
          `SELECT job_id FROM auto_listing_job_items WHERE account_id=$1 AND id=$2`,
          [message.accountId, message.itemId]);
        const jobId = execution ? fence?.job_id : scope?.rowCount === 1 ? scope.rows?.[0]?.job_id : null;
        if (!isSafeAutoListingAiIdentifier(jobId)) {
          await query(client, "COMMIT");
          return ignored("STALE", null);
        }
        if (normalizedOutcome.failureScope === RESERVATION_BUSY_SCOPE) {
          const deferred = await deferBusyReservation(client, message, execution, normalizedOutcome, fence);
          await query(client, "COMMIT");
          return deferred;
        }
        const target = autoListingAiMessagePhaseTarget(message);
        const result = await applyAutoListingAiPhaseOutcome({
          client, accountId: message.accountId, jobId, itemId: message.itemId,
          expectedStatusVersion: message.expectedStatusVersion, correlationId: message.correlationId,
          phase: message.phase, phaseTargetId: target, outcome: normalizedOutcome,
        }, { directUploadAllowed: options.directUploadAllowed });
        if (execution) {
          await finishExecution(client, message, execution, result, normalizedOutcome.disposition === "ACK");
        }
        await query(client, "COMMIT");
        return result;
      } catch (error) {
        if (client?.query) {
          try { await client.query("ROLLBACK"); } catch {}
        }
        if (error?.code?.startsWith?.("AUTO_LISTING_AI_WORKFLOW_")) throw error;
        throw failed();
      } finally {
        try { client?.release?.(); } catch {}
      }
    },
    async requeueChannelFailure(rawInput = {}) {
      const envelope = plainData(rawInput, FACTORY_APPLY_KEYS);
      let message;
      try { message = normalizeAutoListingAiMessage(envelope.message); } catch { throw invalid(); }
      const outcome = validatedOutcome(envelope.outcome, message.phase, message.correlationId, {
        allowChannelRetry: true,
      });
      if (!CHANNEL_FAILURE_SCOPES.has(outcome.failureScope)) throw invalid();
      const execution = executionInput(message, envelope.execution);
      if (!execution) throw invalid();
      let client;
      try {
        client = await pool.connect();
        if (!client || typeof client.query !== "function") throw failed();
        await query(client, "BEGIN");
        await configureTransaction(client);
        const fence = await lockExecutionFence(client, message, execution);
        if (!fence) {
          await query(client, "COMMIT");
          return ignored("STALE", null);
        }
        const result = await requeueExecution(client, message, execution, outcome, fence, {
          directUploadAllowed: options.directUploadAllowed,
        });
        await query(client, "COMMIT");
        return result;
      } catch (error) {
        if (client?.query) {
          try { await client.query("ROLLBACK"); } catch {}
        }
        if (error?.code?.startsWith?.("AUTO_LISTING_AI_WORKFLOW_")) throw error;
        throw failed();
      } finally {
        try { client?.release?.(); } catch {}
      }
    },
  });
}

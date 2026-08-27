import crypto from "node:crypto";
import { types } from "node:util";

import { loadFrozenAutoListingPlanningInput } from "./auto-listing-ai-phase-context-postgres.mjs";
import {
  buildPlannerInput,
  CONTENT_PLAN_JSON_SCHEMA,
} from "./auto-listing-content-planner.mjs";
import {
  buildContentPlanFillSchema,
  buildFixedSkeleton,
} from "./auto-listing-fixed-skeleton.mjs";

const INPUT_KEYS = new Set([
  "accountId", "actorAccountId", "jobId", "itemId", "sourceSnapshotId",
  "expectedStatusVersion", "costConfirmed", "idempotencyKey", "correlationId",
]);
const COMPLETE_KEYS = new Set(["accountId", "runId", "status", "failureCode"]);
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const FAILURE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const PROHIBITED_CLAIMS = Object.freeze([
  "CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY",
]);

function contextError(code, status = 409) {
  const error = new Error(code === "AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID"
    ? "规划诊断请求无效" : "该任务当前不能执行规划诊断");
  error.code = code;
  error.status = status;
  error.retryable = false;
  return error;
}

const invalid = () => contextError("AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID", 400);
const notEligible = () => contextError("AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_ELIGIBLE", 409);
const conflict = () => contextError("AUTO_LISTING_PLAN_DIAGNOSTIC_IDEMPOTENCY_CONFLICT", 409);
const responseUnknown = () => contextError("AUTO_LISTING_PLAN_DIAGNOSTIC_RESPONSE_UNKNOWN", 409);
const failed = () => contextError("AUTO_LISTING_PLAN_DIAGNOSTIC_CONTEXT_FAILED", 500);

function exactDataObject(value, keys) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    return actual.length === keys.size && actual.every((key) => typeof key === "string" && keys.has(key)
      && descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key], "value"));
  } catch {
    return false;
  }
}

const safeId = (value) => typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
const validVersion = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;

function projectCommand(value) {
  if (!exactDataObject(value, INPUT_KEYS)
    || ![value.accountId, value.actorAccountId, value.jobId, value.itemId, value.sourceSnapshotId,
      value.idempotencyKey, value.correlationId].every(safeId)
    || value.accountId !== value.actorAccountId || !validVersion(value.expectedStatusVersion)
    || value.costConfirmed !== true) throw invalid();
  return value;
}

function projectComplete(value) {
  if (!exactDataObject(value, COMPLETE_KEYS) || !safeId(value.accountId) || !safeId(value.runId)
    || !["ACCEPTED", "REJECTED", "FAILED"].includes(value.status)
    || !((value.status === "FAILED" && typeof value.failureCode === "string" && FAILURE.test(value.failureCode))
      || (value.status !== "FAILED" && value.failureCode === null))) throw invalid();
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function autoListingPlanDiagnosticRequestHash(value) {
  const input = projectCommand(value);
  return sha256({
    accountId: input.accountId,
    actorAccountId: input.actorAccountId,
    jobId: input.jobId,
    itemId: input.itemId,
    sourceSnapshotId: input.sourceSnapshotId,
    expectedStatusVersion: input.expectedStatusVersion,
    costConfirmed: true,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
  });
}

function sameExisting(row, input, requestHash) {
  return row?.account_id === input.accountId && row.job_id === input.jobId
    && row.item_id === input.itemId && row.source_snapshot_id === input.sourceSnapshotId
    && Number(row.expected_status_version) === input.expectedStatusVersion
    && row.idempotency_key === input.idempotencyKey && row.request_hash === requestHash
    && row.correlation_id === input.correlationId && row.actor_account_id === input.actorAccountId
    && row.cost_confirmed === true && safeId(row.id);
}

function boundary(row, input) {
  if (!row || row.account_id !== input.accountId || row.job_id !== input.jobId || row.item_id !== input.itemId
    || row.snapshot_id !== input.sourceSnapshotId || row.status !== "BLOCKED"
    || Number(row.status_version) !== input.expectedStatusVersion
    || typeof row.failure_code !== "string" || !/^AUTO_LISTING_CONTENT_PLAN_[A-Z0-9_]+$/u.test(row.failure_code)) {
    throw notEligible();
  }
  return Object.freeze({
    accountId: input.accountId,
    jobId: input.jobId,
    itemId: input.itemId,
    snapshotId: input.sourceSnapshotId,
  });
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

async function defaultBuildFrozenDiagnostic({ client, boundary: frozenBoundary, correlationId }) {
  const phaseInput = await loadFrozenAutoListingPlanningInput({
    pool: client,
    gateway: null,
    contentPlanRepository: null,
    contentPlanEvidenceRepository: null,
    planPromptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_V3",
    prohibitedClaims: PROHIBITED_CLAIMS,
  }, frozenBoundary);
  const plannerContext = buildPlannerInput({
    sourceCapture: phaseInput.sourceCapture,
    strategyCapture: phaseInput.strategyCapture,
    configCapture: phaseInput.configCapture,
    visualGroupsCapture: phaseInput.visualGroupsCapture,
    profileRef: {
      id: phaseInput.gatewayProfile.id,
      configVersion: phaseInput.gatewayProfile.configVersion,
      textModel: phaseInput.gatewayProfile.textModel,
    },
    promptTemplateVersion: phaseInput.planningContract === "FIXED_SKELETON_V1"
      ? "AUTO_LISTING_CONTENT_PLAN_FILL_V6" : phaseInput.promptTemplateVersion,
    prohibitedClaims: phaseInput.prohibitedClaims,
    regeneration: phaseInput.regeneration,
  });
  const skeleton = phaseInput.planningContract === "FIXED_SKELETON_V1"
    ? buildFixedSkeleton({ plannerContext }) : null;
  const frozenFacts = skeleton || plannerContext.plannerInput;
  return deepFreeze({
    planningContract: phaseInput.planningContract,
    inputHash: plannerContext.inputHash,
    skeletonHash: skeleton?.skeletonHash ?? null,
    profileId: phaseInput.gatewayProfile.id,
    profileVersion: phaseInput.gatewayProfile.configVersion,
    gatewayProfile: phaseInput.gatewayProfile,
    model: plannerContext.plannerInput.plannerModel,
    templateVersion: plannerContext.plannerInput.promptTemplateVersion,
    correlationId,
    request: {
      schema: skeleton ? buildContentPlanFillSchema(skeleton) : CONTENT_PLAN_JSON_SCHEMA,
      text: [
        skeleton
          ? "系统已经生成全部图片结构。只填写俄语文案 claims；不得新增、删除、改名或覆盖任何图片位置和结构字段。"
          : "根据以下冻结的只读商品事实生成俄语图片 ContentPlan。不得修改或输出任何上架字段。",
        "<UNTRUSTED_SOURCE_FACTS_JSON>",
        JSON.stringify(canonical(frozenFacts)),
        "</UNTRUSTED_SOURCE_FACTS_JSON>",
      ].join("\n"),
    },
    validationContext: { plannerContext, skeleton },
  });
}

function release(client) {
  try { client?.release?.(); } catch {}
}

async function rollback(client) {
  try { await client?.query?.("ROLLBACK"); } catch {}
}

export function createPostgresAutoListingPlanDiagnosticContextRepository({
  pool,
  id = () => `content-plan-diagnostic-${crypto.randomUUID()}`,
  buildFrozenDiagnostic = defaultBuildFrozenDiagnostic,
  now = () => Date.now(),
  staleRunningMs = 130_000,
} = {}) {
  if (typeof pool?.connect !== "function" || typeof id !== "function"
    || typeof buildFrozenDiagnostic !== "function" || typeof now !== "function"
    || !Number.isSafeInteger(staleRunningMs) || staleRunningMs < 120_000 || staleRunningMs > 600_000) throw invalid();

  async function reserve(raw) {
    const input = projectCommand(raw);
    const runId = id();
    if (!safeId(runId)) throw invalid();
    const requestHash = autoListingPlanDiagnosticRequestHash(input);
    let client;
    let transaction = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      transaction = true;
      const existingResult = await client.query(
        `SELECT * FROM auto_listing_content_plan_diagnostic_runs
          WHERE account_id=$1 AND idempotency_key=$2
          FOR UPDATE`,
        [input.accountId, input.idempotencyKey],
      );
      const existing = existingResult.rows?.[0] || null;
      if (existing) {
        if (existingResult.rowCount !== 1 || !sameExisting(existing, input, requestHash)) throw conflict();
        if (["ACCEPTED", "REJECTED"].includes(existing.status)) {
          await client.query("COMMIT");
          transaction = false;
          return Object.freeze({ status: "EXISTING", runId: existing.id });
        }
        if (existing.status === "RUNNING") {
          const updatedAt = new Date(existing.updated_at).getTime();
          if (!Number.isFinite(updatedAt)) throw failed();
          if (now() - updatedAt < staleRunningMs) {
            await client.query("COMMIT");
            transaction = false;
            return Object.freeze({ status: "IN_PROGRESS", runId: existing.id });
          }
          const marked = await client.query(
            `UPDATE auto_listing_content_plan_diagnostic_runs
                SET status='FAILED',failure_code='AUTO_LISTING_PLAN_DIAGNOSTIC_RESPONSE_UNKNOWN',
                    completed_at=STATEMENT_TIMESTAMP(),updated_at=STATEMENT_TIMESTAMP()
              WHERE account_id=$1 AND id=$2 AND status='RUNNING'
              RETURNING id,status`,
            [input.accountId, existing.id],
          );
          if (marked.rowCount !== 1 || marked.rows?.[0]?.id !== existing.id) throw conflict();
          await client.query("COMMIT");
          transaction = false;
          throw responseUnknown();
        }
        throw notEligible();
      }
      const boundaryResult = await client.query(
        `SELECT item.account_id,item.job_id,item.id AS item_id,item.snapshot_id,
                item.status,item.status_version,item.failure_code
           FROM auto_listing_job_items AS item
           JOIN auto_listing_jobs AS job
             ON job.account_id=item.account_id AND job.id=item.job_id
          WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3 AND item.snapshot_id=$4
          FOR UPDATE OF item`,
        [input.accountId, input.jobId, input.itemId, input.sourceSnapshotId],
      );
      if (boundaryResult.rowCount !== 1) throw notEligible();
      const frozenBoundary = boundary(boundaryResult.rows?.[0], input);
      const prepared = await buildFrozenDiagnostic({
        client,
        boundary: frozenBoundary,
        correlationId: input.correlationId,
      });
      if (!prepared || !["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(prepared.planningContract)
        || !HASH.test(prepared.inputHash || "")
        || !((prepared.planningContract === "LEGACY_FULL_PLAN_V3" && prepared.skeletonHash === null)
          || (prepared.planningContract === "FIXED_SKELETON_V1" && HASH.test(prepared.skeletonHash || "")))
        || !safeId(prepared.profileId) || !validVersion(prepared.profileVersion)) throw failed();
      const diagnosticRequestKey = `auto-listing-plan-diagnostic-${sha256({
        accountId: input.accountId,
        jobId: input.jobId,
        itemId: input.itemId,
        sourceSnapshotId: input.sourceSnapshotId,
        idempotencyKey: input.idempotencyKey,
      })}`;
      const inserted = await client.query(
        `INSERT INTO auto_listing_content_plan_diagnostic_runs (
           id,account_id,job_id,item_id,source_snapshot_id,expected_status_version,
           profile_id,profile_version,planning_contract,input_hash,skeleton_hash,
           idempotency_key,request_hash,correlation_id,actor_account_id,status,cost_confirmed
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'RUNNING',TRUE)
         RETURNING id,account_id,job_id,item_id,source_snapshot_id,status`,
        [runId, input.accountId, input.jobId, input.itemId, input.sourceSnapshotId,
          input.expectedStatusVersion, prepared.profileId, prepared.profileVersion,
          prepared.planningContract, prepared.inputHash, prepared.skeletonHash,
          input.idempotencyKey, requestHash, input.correlationId, input.actorAccountId],
      );
      const row = inserted.rows?.[0];
      if (inserted.rowCount !== 1 || row?.id !== runId || row.status !== "RUNNING") throw failed();
      await client.query("COMMIT");
      transaction = false;
      return deepFreeze({
        status: "RESERVED",
        runId,
        accountId: input.accountId,
        jobId: input.jobId,
        itemId: input.itemId,
        sourceSnapshotId: input.sourceSnapshotId,
        ...prepared,
        requestKey: diagnosticRequestKey,
      });
    } catch (error) {
      if (transaction) await rollback(client);
      if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_PLAN_DIAGNOSTIC_")) throw error;
      throw failed();
    } finally {
      release(client);
    }
  }

  async function complete(raw) {
    const input = projectComplete(raw);
    let client;
    try {
      client = await pool.connect();
      const result = await client.query(
        `UPDATE auto_listing_content_plan_diagnostic_runs
            SET status=$3,failure_code=$4,completed_at=STATEMENT_TIMESTAMP(),updated_at=STATEMENT_TIMESTAMP()
          WHERE account_id=$1 AND id=$2 AND status='RUNNING'
          RETURNING id,account_id,status`,
        [input.accountId, input.runId, input.status, input.failureCode],
      );
      if (result.rowCount === 0) {
        const existing = await client.query(
          `SELECT id,account_id,status,failure_code
             FROM auto_listing_content_plan_diagnostic_runs
            WHERE account_id=$1 AND id=$2`,
          [input.accountId, input.runId],
        );
        const row = existing.rows?.[0];
        if (existing.rowCount !== 1 || row?.id !== input.runId || row.account_id !== input.accountId
          || row.status !== input.status || (row.failure_code ?? null) !== input.failureCode) throw conflict();
        return Object.freeze({ status: input.status });
      }
      if (result.rowCount !== 1 || result.rows?.[0]?.id !== input.runId
        || result.rows[0].account_id !== input.accountId || result.rows[0].status !== input.status) throw conflict();
      return Object.freeze({ status: input.status });
    } catch (error) {
      if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_PLAN_DIAGNOSTIC_")) throw error;
      throw failed();
    } finally {
      release(client);
    }
  }

  return Object.freeze({ reserve, complete });
}

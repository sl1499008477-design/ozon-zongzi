import { types } from "node:util";

const INPUT_KEYS = new Set(["accountId", "jobId", "itemId"]);
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,239}$/u;
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;

class UnsafeRow extends Error {}

function repositoryError(code) {
  const error = new Error(code === "AUTO_LISTING_PLAN_DIAGNOSTIC_REPOSITORY_INVALID"
    ? "规划诊断查询条件无效" : "规划诊断暂时无法读取");
  error.code = code;
  error.retryable = code.endsWith("_FAILED");
  return error;
}

const invalid = () => repositoryError("AUTO_LISTING_PLAN_DIAGNOSTIC_REPOSITORY_INVALID");
const failed = () => repositoryError("AUTO_LISTING_PLAN_DIAGNOSTIC_REPOSITORY_FAILED");

function safeId(value) {
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
}

function exactInput(value) {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    return keys.length === INPUT_KEYS.size && keys.every((key) => typeof key === "string" && INPUT_KEYS.has(key)
      && descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key], "value"));
  } catch {
    return false;
  }
}

function cloneData(value, state, depth = 0) {
  if (depth > MAX_DEPTH || state.nodes >= MAX_NODES) throw new UnsafeRow();
  state.nodes += 1;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsafeRow();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.active.has(value)) throw new UnsafeRow();
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 20_000) throw new UnsafeRow();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (keys.length !== allowed.size || keys.some((key) => typeof key !== "string" || !allowed.has(key))
        || descriptors.length?.value !== value.length) throw new UnsafeRow();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new UnsafeRow();
        return cloneData(descriptor.value, state, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new UnsafeRow();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== "string" || !descriptor || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, "value") || ["__proto__", "constructor", "prototype"].includes(key)) throw new UnsafeRow();
      output[key] = cloneData(descriptor.value, state, depth + 1);
    }
    return output;
  } catch (error) {
    if (error instanceof UnsafeRow) throw error;
    throw new UnsafeRow();
  } finally {
    state.active.delete(value);
  }
}

function jsonValue(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return cloneData(parsed, { nodes: 0, active: new Set() });
  } catch {
    throw new UnsafeRow();
  }
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new UnsafeRow();
  return date.toISOString();
}

function mapRow(row, scope) {
  try {
    if (!row || typeof row !== "object" || types.isProxy(row)
      || row.account_id !== scope.accountId || row.job_id !== scope.jobId || row.item_id !== scope.itemId
      || !safeId(row.id) || !((safeId(row.attempt_id) && row.diagnostic_run_id == null)
        || (row.attempt_id == null && safeId(row.diagnostic_run_id)))) throw new UnsafeRow();
    return {
      responseId: row.id,
      attemptId: row.attempt_id ?? null,
      diagnosticRunId: row.diagnostic_run_id ?? null,
      planningContract: row.planning_contract,
      model: row.model_name,
      promptTemplateVersion: row.prompt_template_version,
      gatewayRequestId: row.gateway_request_id ?? null,
      receivedAt: timestamp(row.received_at),
      response: jsonValue(row.response),
      validation: {
        status: row.validation_status,
        validatorVersion: row.validator_version,
        issues: jsonValue(row.issues),
        validatedAt: timestamp(row.validated_at),
      },
    };
  } catch {
    throw failed();
  }
}

export function createPostgresAutoListingPlanDiagnosticRepository({ pool } = {}) {
  if (typeof pool?.query !== "function") throw invalid();
  return Object.freeze({
    async loadLatest(raw) {
      if (!exactInput(raw) || !safeId(raw.accountId) || !safeId(raw.jobId) || !safeId(raw.itemId)) throw invalid();
      const scope = { accountId: raw.accountId, jobId: raw.jobId, itemId: raw.itemId };
      try {
        const result = await pool.query(
          `SELECT response.id,response.account_id,response.job_id,response.item_id,
                  response.attempt_id,response.diagnostic_run_id,response.planning_contract,
                  response.model_name,response.prompt_template_version,response.gateway_request_id,
                  response.received_at,response.response,
                  validation.status AS validation_status,validation.validator_version,
                  validation.issues,validation.validated_at
             FROM auto_listing_content_plan_responses AS response
             JOIN auto_listing_job_items AS item
               ON item.account_id=response.account_id AND item.job_id=response.job_id
              AND item.id=response.item_id
             JOIN auto_listing_content_plan_validation_results AS validation
               ON validation.account_id=response.account_id AND validation.response_id=response.id
            WHERE response.account_id=$1 AND response.job_id=$2 AND response.item_id=$3
            ORDER BY response.received_at DESC,response.id DESC
            LIMIT 1`,
          [scope.accountId, scope.jobId, scope.itemId],
        );
        if (result.rowCount === 0) return null;
        if (result.rowCount !== 1) throw failed();
        return mapRow(result.rows?.[0], scope);
      } catch (error) {
        if (error?.code === "AUTO_LISTING_PLAN_DIAGNOSTIC_REPOSITORY_FAILED") throw error;
        throw failed();
      }
    },
  });
}

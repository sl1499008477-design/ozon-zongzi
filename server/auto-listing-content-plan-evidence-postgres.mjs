import crypto from "node:crypto";
import { types } from "node:util";

const HASH = /^[a-f0-9]{64}$/u;
const CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const CONTRACTS = new Set(["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1", "FIXED_SKELETON_SOURCE_IMAGE_V1"]);
const RESPONSE_KEYS = new Set([
  "accountId", "jobId", "itemId", "sourceSnapshotId", "owner", "planningContract",
  "inputHash", "skeletonHash", "profileId", "profileVersion", "modelName",
  "promptTemplateVersion", "gatewayRequestId", "response", "gatewayConnectionId", "gatewayConnectionVersion",
]);
const INTELLIGENT_RESPONSE_KEYS = new Set([...RESPONSE_KEYS, "sourceImageAnalysisRunId", "sourceImageIntelligenceHash"]);
const LOAD_KEYS = new Set([
  "accountId", "jobId", "itemId", "sourceSnapshotId", "owner", "planningContract",
  "inputHash", "skeletonHash", "profileId", "profileVersion", "gatewayConnectionId", "gatewayConnectionVersion",
]);
const INTELLIGENT_LOAD_KEYS = new Set([...LOAD_KEYS, "sourceImageAnalysisRunId", "sourceImageIntelligenceHash"]);
const OWNER_KEYS = new Set(["kind", "id"]);
const VALIDATION_KEYS = new Set(["accountId", "responseId", "status", "validatorVersion", "issues"]);
const ISSUE_KEYS = new Set(["code", "slotKey", "claimIndex", "field", "expected", "actual"]);
const LEGACY_ROOT_KEYS = new Set(["version", "language", "slots"]);
const FIXED_ROOT_KEYS = new Set(["version", "language", "fills"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_VALUE = /^(?:sk-(?:proj-)?[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,}|Bearer\s+\S+)$/iu;
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;
const MAX_ARRAY = 20_000;
const MAX_SLOTS = 1_000;
const MAX_STRING = 2_000_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

class CarrierInvalid extends Error {}

function evidenceError(code, message, retryable) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

const invalid = () => evidenceError("AUTO_LISTING_CONTENT_PLAN_EVIDENCE_INVALID", "图片规划证据无效", false);
const conflict = () => evidenceError("AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT", "图片规划证据不一致", false);
const unavailable = () => evidenceError("AUTO_LISTING_CONTENT_PLAN_EVIDENCE_FAILED", "图片规划证据暂时无法保存", true);

function safeId(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= 240 && /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeText(value, max = 240) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= max && !/[\u0000-\u001f\u007f]/u.test(value)
    && !SECRET_VALUE.test(value);
}

function plain(value) {
  try {
    return value !== null && typeof value === "object" && !types.isProxy(value) && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  } catch {
    return false;
  }
}

function exact(value, keys) {
  try {
    if (!plain(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    return actual.length === keys.size && actual.every((key) => typeof key === "string" && keys.has(key)
      && descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key], "value"));
  } catch {
    return false;
  }
}

function cloneData(value, state, depth = 0) {
  if (depth > MAX_DEPTH || state.nodes >= MAX_NODES) throw new CarrierInvalid();
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CarrierInvalid();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING || SECRET_VALUE.test(value)) throw new CarrierInvalid();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.active.has(value)) throw new CarrierInvalid();
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ARRAY) throw new CarrierInvalid();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const actual = Reflect.ownKeys(descriptors);
      const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (actual.length !== allowed.size || actual.some((key) => typeof key !== "string" || !allowed.has(key))
        || descriptors.length?.value !== value.length) throw new CarrierInvalid();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new CarrierInvalid();
        return cloneData(descriptor.value, state, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new CarrierInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (actual.length > 10_000 || actual.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key))) {
      throw new CarrierInvalid();
    }
    const output = Object.create(null);
    for (const key of actual) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new CarrierInvalid();
      output[key] = cloneData(descriptor.value, state, depth + 1);
    }
    return output;
  } catch (error) {
    if (error instanceof CarrierInvalid) throw error;
    throw new CarrierInvalid();
  } finally {
    state.active.delete(value);
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

const canonicalText = (value) => JSON.stringify(canonical(value));
const sha256 = (value) => crypto.createHash("sha256").update(canonicalText(value)).digest("hex");
const sameJson = (left, right) => canonicalText(left) === canonicalText(right);

function projectedData(value) {
  try {
    return cloneData(value, { nodes: 0, active: new Set() });
  } catch {
    throw invalid();
  }
}

function projectOwner(value) {
  const owner = projectedData(value);
  if (!exact(owner, OWNER_KEYS) || !["ATTEMPT", "DIAGNOSTIC"].includes(owner.kind) || !safeId(owner.id)) throw invalid();
  return owner;
}

function assertContract(value, skeletonHash, input) {
  if (!CONTRACTS.has(value)) throw invalid();
  if (value === "LEGACY_FULL_PLAN_V3" && skeletonHash !== null) throw invalid();
  if (["FIXED_SKELETON_V1", "FIXED_SKELETON_SOURCE_IMAGE_V1"].includes(value)
    && !HASH.test(skeletonHash || "")) throw invalid();
  if (value === "FIXED_SKELETON_SOURCE_IMAGE_V1") {
    if (!safeId(input.sourceImageAnalysisRunId) || !HASH.test(input.sourceImageIntelligenceHash || "")) throw invalid();
  } else if (Object.hasOwn(input, "sourceImageAnalysisRunId") || Object.hasOwn(input, "sourceImageIntelligenceHash")) throw invalid();
}

function projectResponseCommand(raw) {
  const input = projectedData(raw);
  if (input?.owner?.kind === "DIAGNOSTIC" && !Object.hasOwn(input, "gatewayConnectionId")
    && !Object.hasOwn(input, "gatewayConnectionVersion")) {
    input.gatewayConnectionId = null;
    input.gatewayConnectionVersion = null;
  }
  if (!exact(input, input.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
    ? INTELLIGENT_RESPONSE_KEYS : RESPONSE_KEYS)) throw invalid();
  for (const key of ["accountId", "jobId", "itemId", "sourceSnapshotId", "profileId"]) {
    if (!safeId(input[key])) throw invalid();
  }
  if (!HASH.test(input.inputHash || "") || !Number.isInteger(input.profileVersion)
    || input.profileVersion < 1 || input.profileVersion > 2_147_483_647
    || !safeText(input.modelName) || !safeText(input.promptTemplateVersion)
    || !(input.gatewayRequestId === null || safeText(input.gatewayRequestId))) throw invalid();
  input.owner = projectOwner(input.owner);
  if (!((input.gatewayConnectionId === null && input.gatewayConnectionVersion === null)
    || (safeId(input.gatewayConnectionId) && Number.isInteger(input.gatewayConnectionVersion)
      && input.gatewayConnectionVersion >= 1 && input.gatewayConnectionVersion <= 2_147_483_647))
    || (input.owner.kind === "DIAGNOSTIC" && input.gatewayConnectionId !== null)) throw invalid();
  assertContract(input.planningContract, input.skeletonHash, input);
  const fixed = ["FIXED_SKELETON_V1", "FIXED_SKELETON_SOURCE_IMAGE_V1"].includes(input.planningContract);
  const rootKeys = fixed ? FIXED_ROOT_KEYS : LEGACY_ROOT_KEYS;
  if (!exact(input.response, rootKeys)) throw invalid();
  if (fixed) {
    if (!plain(input.response.fills) || Object.keys(input.response.fills).length > MAX_SLOTS) throw invalid();
  } else if (!Array.isArray(input.response.slots) || input.response.slots.length > MAX_SLOTS) throw invalid();
  const serialized = canonicalText(input.response);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES) throw invalid();
  return deepFreeze(input);
}

function projectIssue(value) {
  if (!exact(value, ISSUE_KEYS) || !CODE.test(value.code || "")
    || !(value.slotKey === null || (typeof value.slotKey === "string" && value.slotKey.length <= 500))
    || !(value.claimIndex === null || (Number.isSafeInteger(value.claimIndex) && value.claimIndex >= 0))
    || !(value.field === null || (typeof value.field === "string" && value.field.length <= 240))
    || ![value.expected, value.actual].every((entry) => entry === null
      || (typeof entry === "string" && entry.length <= 160 && !SECRET_VALUE.test(entry)))) throw invalid();
  return value;
}

function projectValidationCommand(raw) {
  const input = projectedData(raw);
  if (!exact(input, VALIDATION_KEYS) || !safeId(input.accountId) || !safeId(input.responseId)
    || !["ACCEPTED", "REJECTED"].includes(input.status) || !safeText(input.validatorVersion)
    || !Array.isArray(input.issues) || input.issues.length > 100) throw invalid();
  input.issues.forEach(projectIssue);
  if ((input.status === "ACCEPTED" && input.issues.length !== 0)
    || (input.status === "REJECTED" && input.issues.length < 1)) throw invalid();
  if (Buffer.byteLength(canonicalText(input.issues), "utf8") > 1_048_576) throw invalid();
  return deepFreeze(input);
}

function projectLoadScope(raw) {
  const input = projectedData(raw);
  if (input?.owner?.kind === "DIAGNOSTIC" && !Object.hasOwn(input, "gatewayConnectionId")
    && !Object.hasOwn(input, "gatewayConnectionVersion")) {
    input.gatewayConnectionId = null;
    input.gatewayConnectionVersion = null;
  }
  if (!exact(input, input.planningContract === "FIXED_SKELETON_SOURCE_IMAGE_V1"
    ? INTELLIGENT_LOAD_KEYS : LOAD_KEYS)) throw invalid();
  for (const key of ["accountId", "jobId", "itemId", "sourceSnapshotId", "profileId"]) {
    if (!safeId(input[key])) throw invalid();
  }
  if (!HASH.test(input.inputHash || "") || !Number.isInteger(input.profileVersion)
    || input.profileVersion < 1 || input.profileVersion > 2_147_483_647) throw invalid();
  input.owner = projectOwner(input.owner);
  if (!((input.gatewayConnectionId === null && input.gatewayConnectionVersion === null)
    || (safeId(input.gatewayConnectionId) && Number.isInteger(input.gatewayConnectionVersion)
      && input.gatewayConnectionVersion >= 1 && input.gatewayConnectionVersion <= 2_147_483_647))
    || (input.owner.kind === "DIAGNOSTIC" && input.gatewayConnectionId !== null)) throw invalid();
  assertContract(input.planningContract, input.skeletonHash, input);
  return deepFreeze(input);
}

function dateText(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw conflict();
  return date.toISOString();
}

function mapResponse(row) {
  if (!row) return null;
  const response = projectedData(typeof row.response === "string" ? JSON.parse(row.response) : row.response);
  const owner = row.attempt_id === null || row.attempt_id === undefined
    ? { kind: "DIAGNOSTIC", id: row.diagnostic_run_id }
    : { kind: "ATTEMPT", id: row.attempt_id };
  const mapped = {
    id: row.id,
    accountId: row.account_id,
    jobId: row.job_id,
    itemId: row.item_id,
    sourceSnapshotId: row.source_snapshot_id,
    owner,
    planningContract: row.planning_contract,
    inputHash: row.input_hash,
    skeletonHash: row.skeleton_hash ?? null,
    ...(row.planning_contract === "FIXED_SKELETON_SOURCE_IMAGE_V1" ? {
      sourceImageAnalysisRunId: row.source_image_analysis_run_id,
      sourceImageIntelligenceHash: row.source_image_intelligence_hash,
    } : {}),
    profileId: row.profile_id,
    profileVersion: Number(row.profile_version),
    modelName: row.model_name,
    promptTemplateVersion: row.prompt_template_version,
    gatewayRequestId: row.gateway_request_id ?? null,
    response,
    responseHash: row.response_hash,
    receivedAt: dateText(row.received_at),
  };
  if (!safeId(mapped.id) || !HASH.test(mapped.responseHash || "") || sha256(mapped.response) !== mapped.responseHash) throw conflict();
  return deepFreeze(mapped);
}

function mapValidation(row) {
  if (!row) return null;
  const issues = projectedData(typeof row.issues === "string" ? JSON.parse(row.issues) : row.issues);
  const mapped = {
    id: row.id ?? row.validation_id,
    accountId: row.account_id,
    responseId: row.response_id,
    status: row.status ?? row.validation_status,
    validatorVersion: row.validator_version,
    issues,
    validatedAt: dateText(row.validated_at),
  };
  projectValidationCommand({
    accountId: mapped.accountId,
    responseId: mapped.responseId,
    status: mapped.status,
    validatorVersion: mapped.validatorVersion,
    issues: mapped.issues,
  });
  if (!safeId(mapped.id)) throw conflict();
  return deepFreeze(mapped);
}

function responseMatches(record, input) {
  return record.accountId === input.accountId && record.jobId === input.jobId
    && record.itemId === input.itemId && record.sourceSnapshotId === input.sourceSnapshotId
    && record.owner.kind === input.owner.kind && record.owner.id === input.owner.id
    && record.planningContract === input.planningContract && record.inputHash === input.inputHash
    && record.skeletonHash === input.skeletonHash && record.profileId === input.profileId
    && (record.sourceImageAnalysisRunId ?? null) === (input.sourceImageAnalysisRunId ?? null)
    && (record.sourceImageIntelligenceHash ?? null) === (input.sourceImageIntelligenceHash ?? null)
    && record.profileVersion === input.profileVersion && record.modelName === input.modelName
    && record.promptTemplateVersion === input.promptTemplateVersion
    && record.gatewayRequestId === input.gatewayRequestId && sameJson(record.response, input.response)
    && record.responseHash === sha256(input.response);
}

function validationMatches(record, input) {
  return record.accountId === input.accountId && record.responseId === input.responseId
    && record.status === input.status && record.validatorVersion === input.validatorVersion
    && sameJson(record.issues, input.issues);
}

async function rollback(client) {
  try { await client?.query("ROLLBACK"); } catch {}
}

function release(client) {
  try { client?.release?.(); } catch {}
}

function known(error) {
  return ["AUTO_LISTING_CONTENT_PLAN_EVIDENCE_INVALID", "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT"].includes(error?.code);
}

export function createPostgresContentPlanEvidenceRepository({
  pool,
  responseId = () => `content-plan-response-${crypto.randomUUID()}`,
  validationId = () => `content-plan-validation-${crypto.randomUUID()}`,
} = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof responseId !== "function" || typeof validationId !== "function") {
    throw invalid();
  }

  async function recordResponse(rawCommand) {
    const input = projectResponseCommand(rawCommand);
    const nextId = responseId();
    if (!safeId(nextId)) throw invalid();
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const ownerColumn = input.owner.kind === "ATTEMPT" ? "attempt_id" : "diagnostic_run_id";
      const ownerTable = input.owner.kind === "ATTEMPT"
        ? "auto_listing_content_plan_attempts" : "auto_listing_content_plan_diagnostic_runs";
      const locked = await client.query(
        `SELECT id,account_id,job_id,item_id,source_snapshot_id,profile_id,profile_version,
                planning_contract,input_hash,skeleton_hash,source_image_analysis_run_id,source_image_intelligence_hash,
                ${input.owner.kind === "ATTEMPT" ? "gateway_connection_id,gateway_connection_version" : "NULL AS gateway_connection_id,NULL::INTEGER AS gateway_connection_version"}
           FROM ${ownerTable}
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND source_snapshot_id=$4 AND id=$5
          FOR UPDATE`,
        [input.accountId, input.jobId, input.itemId, input.sourceSnapshotId, input.owner.id],
      );
      const owner = locked.rows?.[0];
      if (!owner || owner.id !== input.owner.id || owner.account_id !== input.accountId
        || owner.job_id !== input.jobId || owner.item_id !== input.itemId
        || owner.source_snapshot_id !== input.sourceSnapshotId || owner.profile_id !== input.profileId
        || Number(owner.profile_version) !== input.profileVersion
        || (owner.gateway_connection_id ?? null) !== input.gatewayConnectionId
        || (owner.gateway_connection_version === null || owner.gateway_connection_version === undefined
          ? null : Number(owner.gateway_connection_version)) !== input.gatewayConnectionVersion
        || owner.planning_contract !== input.planningContract || owner.input_hash !== input.inputHash
        || (owner.skeleton_hash ?? null) !== input.skeletonHash
        || (owner.source_image_analysis_run_id ?? null) !== (input.sourceImageAnalysisRunId ?? null)
        || (owner.source_image_intelligence_hash ?? null) !== (input.sourceImageIntelligenceHash ?? null)) throw conflict();
      const existing = await client.query(
        `SELECT * FROM auto_listing_content_plan_responses
          WHERE account_id=$1 AND ${ownerColumn}=$2`,
        [input.accountId, input.owner.id],
      );
      if (existing.rowCount > 0) {
        const mapped = mapResponse(existing.rows[0]);
        if (!responseMatches(mapped, input)) throw conflict();
        await client.query("COMMIT");
        return mapped;
      }
      const inserted = await client.query(
        `INSERT INTO auto_listing_content_plan_responses (
           id,account_id,job_id,item_id,source_snapshot_id,attempt_id,diagnostic_run_id,
           planning_contract,input_hash,skeleton_hash,profile_id,profile_version,model_name,
           prompt_template_version,gateway_request_id,response,response_hash,
           source_image_analysis_run_id,source_image_intelligence_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::JSONB,$17,$18,$19)
         RETURNING *`,
        [nextId, input.accountId, input.jobId, input.itemId, input.sourceSnapshotId,
          input.owner.kind === "ATTEMPT" ? input.owner.id : null,
          input.owner.kind === "DIAGNOSTIC" ? input.owner.id : null,
          input.planningContract, input.inputHash, input.skeletonHash, input.profileId,
          input.profileVersion, input.modelName, input.promptTemplateVersion,
          input.gatewayRequestId, canonicalText(input.response), sha256(input.response),
          input.sourceImageAnalysisRunId ?? null, input.sourceImageIntelligenceHash ?? null],
      );
      const mapped = mapResponse(inserted.rows?.[0]);
      if (inserted.rowCount !== 1 || !responseMatches(mapped, input)) throw conflict();
      await client.query("COMMIT");
      return mapped;
    } catch (error) {
      await rollback(client);
      if (known(error)) throw error;
      throw unavailable();
    } finally {
      release(client);
    }
  }

  async function recordValidation(rawCommand) {
    const input = projectValidationCommand(rawCommand);
    const nextId = validationId();
    if (!safeId(nextId)) throw invalid();
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const response = await client.query(
        `SELECT * FROM auto_listing_content_plan_responses
          WHERE account_id=$1 AND id=$2
          FOR UPDATE`,
        [input.accountId, input.responseId],
      );
      if (response.rowCount !== 1) throw conflict();
      const existing = await client.query(
        `SELECT * FROM auto_listing_content_plan_validation_results
          WHERE account_id=$1 AND response_id=$2`,
        [input.accountId, input.responseId],
      );
      if (existing.rowCount > 0) {
        const mapped = mapValidation(existing.rows[0]);
        if (!validationMatches(mapped, input)) throw conflict();
        await client.query("COMMIT");
        return mapped;
      }
      const inserted = await client.query(
        `INSERT INTO auto_listing_content_plan_validation_results (
           id,account_id,response_id,status,validator_version,issues
         ) VALUES ($1,$2,$3,$4,$5,$6::JSONB)
         RETURNING *`,
        [nextId, input.accountId, input.responseId, input.status, input.validatorVersion,
          canonicalText(input.issues)],
      );
      const mapped = mapValidation(inserted.rows?.[0]);
      if (inserted.rowCount !== 1 || !validationMatches(mapped, input)) throw conflict();
      await client.query("COMMIT");
      return mapped;
    } catch (error) {
      await rollback(client);
      if (known(error)) throw error;
      throw unavailable();
    } finally {
      release(client);
    }
  }

  async function loadOutcome(rawScope) {
    const scope = projectLoadScope(rawScope);
    let client;
    try {
      client = await pool.connect();
      const ownerColumn = scope.owner.kind === "ATTEMPT" ? "attempt_id" : "diagnostic_run_id";
      const result = await client.query(
        `SELECT response.*,
                validation.id AS validation_id,validation.status AS validation_status,
                validation.validator_version,validation.issues,validation.validated_at
           FROM auto_listing_content_plan_responses AS response
           LEFT JOIN auto_listing_content_plan_validation_results AS validation
             ON validation.account_id=response.account_id AND validation.response_id=response.id
          WHERE response.account_id=$1 AND response.job_id=$2 AND response.item_id=$3
            AND response.source_snapshot_id=$4 AND response.${ownerColumn}=$5
            AND response.planning_contract=$6 AND response.input_hash=$7
            AND response.skeleton_hash IS NOT DISTINCT FROM $8
            AND response.profile_id=$9 AND response.profile_version=$10
            AND response.source_image_analysis_run_id IS NOT DISTINCT FROM $11
            AND response.source_image_intelligence_hash IS NOT DISTINCT FROM $12
            ${scope.owner.kind === "ATTEMPT" ? `AND EXISTS (
              SELECT 1 FROM auto_listing_content_plan_attempts AS attempt
               WHERE attempt.account_id=response.account_id AND attempt.id=response.attempt_id
                 AND attempt.job_id=response.job_id AND attempt.item_id=response.item_id
                 AND attempt.expected_status_version=(
                   SELECT item.status_version FROM auto_listing_job_items AS item
                    WHERE item.account_id=attempt.account_id AND item.job_id=attempt.job_id
                      AND item.id=attempt.item_id
                 )
                 AND attempt.gateway_connection_id IS NOT DISTINCT FROM $13
                 AND attempt.gateway_connection_version IS NOT DISTINCT FROM $14
            )` : ""}`,
        [scope.accountId, scope.jobId, scope.itemId, scope.sourceSnapshotId, scope.owner.id,
          scope.planningContract, scope.inputHash, scope.skeletonHash, scope.profileId, scope.profileVersion,
          scope.sourceImageAnalysisRunId ?? null, scope.sourceImageIntelligenceHash ?? null,
          ...(scope.owner.kind === "ATTEMPT"
            ? [scope.gatewayConnectionId, scope.gatewayConnectionVersion] : [])],
      );
      if (result.rowCount === 0) return null;
      if (result.rowCount !== 1) throw conflict();
      const response = mapResponse(result.rows[0]);
      const validation = result.rows[0].validation_id === null || result.rows[0].validation_id === undefined
        ? null : mapValidation({
          id: result.rows[0].validation_id,
          account_id: result.rows[0].account_id,
          response_id: result.rows[0].id,
          status: result.rows[0].validation_status,
          validator_version: result.rows[0].validator_version,
          issues: result.rows[0].issues,
          validated_at: result.rows[0].validated_at,
        });
      return deepFreeze({ response, validation });
    } catch (error) {
      if (known(error)) throw error;
      throw unavailable();
    } finally {
      release(client);
    }
  }

  return Object.freeze({ recordResponse, recordValidation, loadOutcome });
}

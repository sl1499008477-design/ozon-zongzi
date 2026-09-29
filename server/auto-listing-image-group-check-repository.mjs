import crypto from "node:crypto";

const HASH = /^[a-f0-9]{64}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,299}$/u;
const RESULT_KEYS = new Set([
  "accepted", "acceptedSlotKeys", "duplicateSlotKeys", "viewMismatchSlotKeys",
  "identityMismatchSlotKeys", "retrySlotKeys", "reasonCodes",
]);
const LOAD_KEYS = new Set([
  "accountId", "jobId", "itemId", "planId", "sourceImageAnalysisRunId",
  "expectedStatusVersion", "visualGroupKey", "inputHash",
]);
const RECORD_KEYS = new Set([
  ...LOAD_KEYS, "result", "resultHash", "gatewayRequestId", "modelEvidence",
  "gatewayConnectionId", "gatewayConnectionVersion",
]);
const MODEL_EVIDENCE_KEYS = new Set([
  "requestedTextModel", "gatewayReportedTextModel", "gatewayReportedTextModelPresent",
]);
const ALLOWED_REASON_CODES = new Set([
  "IMAGE_GROUP_DUPLICATE_VIEW", "IMAGE_GROUP_VIEW_MISMATCH", "IMAGE_GROUP_IDENTITY_MISMATCH",
  "IMAGE_GROUP_INTRINSIC_MARKING_INCONSISTENT", "IMAGE_GROUP_UNSUPPORTED_STRUCTURE",
]);
const FACTORY_KEYS = new Set(["now", "id"]);

function failure(code = "AUTO_LISTING_IMAGE_GROUP_CHECK_REPOSITORY_FAILED", retryable = true) {
  const error = new Error(code);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactObject(value, keys) {
  try {
    return plainObject(value) && Reflect.ownKeys(value).length === keys.size
      && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.has(key));
  } catch { return false; }
}

function safeId(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 240 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function validModelId(value) {
  return typeof value === "string" && value === value.trim() && MODEL_ID.test(value);
}

function validVersion(value) {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function stringArray(value, { allowEmpty = true, code = false } = {}) {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= 13
    && new Set(value).size === value.length
    && value.every((entry) => code
      ? typeof entry === "string" && /^[A-Z][A-Z0-9_]{0,119}$/u.test(entry)
      : safeId(entry));
}

function validReasonSemantics(value) {
  const reasons = new Set(value.reasonCodes);
  const hasDuplicate = value.duplicateSlotKeys.length > 0;
  const hasViewMismatch = value.viewMismatchSlotKeys.length > 0;
  const hasIdentityMismatch = value.identityMismatchSlotKeys.length > 0;
  const identityReasons = [
    "IMAGE_GROUP_IDENTITY_MISMATCH",
    "IMAGE_GROUP_INTRINSIC_MARKING_INCONSISTENT",
    "IMAGE_GROUP_UNSUPPORTED_STRUCTURE",
  ].filter((code) => reasons.has(code));
  const hasIssue = hasDuplicate || hasViewMismatch || hasIdentityMismatch;
  return (hasIssue ? reasons.size > 0 : reasons.size === 0)
    && reasons.has("IMAGE_GROUP_DUPLICATE_VIEW") === hasDuplicate
    && reasons.has("IMAGE_GROUP_VIEW_MISMATCH") === hasViewMismatch
    && (identityReasons.length > 0) === hasIdentityMismatch;
}

function validResult(value) {
  if (!(exactObject(value, RESULT_KEYS) && typeof value.accepted === "boolean"
    && stringArray(value.acceptedSlotKeys)
    && stringArray(value.duplicateSlotKeys)
    && stringArray(value.viewMismatchSlotKeys)
    && stringArray(value.identityMismatchSlotKeys)
    && stringArray(value.retrySlotKeys)
    && stringArray(value.reasonCodes, { code: true })
    && value.reasonCodes.every((code) => ALLOWED_REASON_CODES.has(code))
    && validReasonSemantics(value))) return false;
  const issues = [
    ...value.duplicateSlotKeys, ...value.viewMismatchSlotKeys, ...value.identityMismatchSlotKeys,
  ];
  const issueSet = new Set(issues);
  const retrySet = new Set(value.retrySlotKeys);
  return retrySet.size === value.retrySlotKeys.length
    && issueSet.size === retrySet.size && [...issueSet].every((slotKey) => retrySet.has(slotKey))
    && value.acceptedSlotKeys.every((slotKey) => !retrySet.has(slotKey))
    && value.accepted === (value.retrySlotKeys.length === 0);
}

function validModelEvidence(value) {
  return exactObject(value, MODEL_EVIDENCE_KEYS)
    && validModelId(value.requestedTextModel)
    && typeof value.gatewayReportedTextModel === "string"
    && typeof value.gatewayReportedTextModelPresent === "boolean"
    && (value.gatewayReportedTextModelPresent
      ? validModelId(value.gatewayReportedTextModel)
      : value.gatewayReportedTextModel === "");
}

function validateLoad(input) {
  if (!exactObject(input, LOAD_KEYS)
    || ![input.accountId, input.jobId, input.itemId, input.planId,
      input.sourceImageAnalysisRunId, input.visualGroupKey].every(safeId)
    || !validVersion(input.expectedStatusVersion) || !HASH.test(input.inputHash || "")) {
    throw failure("AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID", false);
  }
  return input;
}

function validateRecord(input) {
  if (!exactObject(input, RECORD_KEYS)) {
    throw failure("AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID", false);
  }
  validateLoad(Object.fromEntries([...LOAD_KEYS].map((key) => [key, input[key]])));
  const connectionPair = (input.gatewayConnectionId === null && input.gatewayConnectionVersion === null)
    || (safeId(input.gatewayConnectionId) && validVersion(input.gatewayConnectionVersion));
  if (!validResult(input.result) || !HASH.test(input.resultHash || "")
    || input.resultHash !== digest(input.result)
    || !safeId(input.gatewayRequestId) || !validModelEvidence(input.modelEvidence) || !connectionPair) {
    throw failure("AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID", false);
  }
  return input;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw failure();
  return date.toISOString();
}

const clone = (value) => structuredClone(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const keyOf = (value) => [...LOAD_KEYS].map((key) => value[key]).join("\u0001");

function publicRecord(row) {
  return clone({
    id: row.id,
    accountId: row.accountId,
    jobId: row.jobId,
    itemId: row.itemId,
    planId: row.planId,
    sourceImageAnalysisRunId: row.sourceImageAnalysisRunId,
    expectedStatusVersion: row.expectedStatusVersion,
    visualGroupKey: row.visualGroupKey,
    inputHash: row.inputHash,
    resultHash: row.resultHash,
    status: row.status,
    result: row.result,
    errorCode: null,
    gatewayRequestId: row.gatewayRequestId,
    modelEvidence: row.modelEvidence,
    gatewayConnection: row.gatewayConnectionId === null ? null : {
      id: row.gatewayConnectionId, version: row.gatewayConnectionVersion,
    },
    createdAt: iso(row.createdAt),
    completedAt: iso(row.completedAt),
  });
}

function mappedRow(row) {
  if (!row) return null;
  const result = typeof row.result === "string" ? JSON.parse(row.result) : row.result;
  const modelEvidence = typeof row.model_evidence === "string"
    ? JSON.parse(row.model_evidence) : row.model_evidence;
  const mapped = {
    id: row.id, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    planId: row.plan_id, sourceImageAnalysisRunId: row.source_image_analysis_run_id,
    expectedStatusVersion: Number(row.expected_status_version), visualGroupKey: row.visual_group_key,
    inputHash: row.input_hash, resultHash: row.result_hash, status: row.status,
    result, gatewayRequestId: row.gateway_request_id, modelEvidence,
    gatewayConnectionId: row.gateway_connection_id ?? null,
    gatewayConnectionVersion: row.gateway_connection_version == null
      ? null : Number(row.gateway_connection_version),
    createdAt: row.created_at, completedAt: row.completed_at,
  };
  validateRecord({
    ...Object.fromEntries([...LOAD_KEYS].map((key) => [key, mapped[key]])),
    result: mapped.result, resultHash: mapped.resultHash, gatewayRequestId: mapped.gatewayRequestId,
    modelEvidence: mapped.modelEvidence, gatewayConnectionId: mapped.gatewayConnectionId,
    gatewayConnectionVersion: mapped.gatewayConnectionVersion,
  });
  if (mapped.status !== (mapped.result.accepted ? "ACCEPTED" : "REJECTED")) throw failure();
  return publicRecord(mapped);
}

export function createMemoryImageGroupCheckRepository(options = {}) {
  if (!plainObject(options) || Object.keys(options).some((key) => !FACTORY_KEYS.has(key))) {
    throw failure("AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID", false);
  }
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => `image-group-check-${crypto.randomUUID()}`);
  if (typeof now !== "function" || typeof id !== "function") {
    throw failure("AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID", false);
  }
  const rows = new Map();
  return Object.freeze({
    async loadOutcome(rawInput) {
      const input = validateLoad(rawInput);
      const row = rows.get(keyOf(input));
      return row ? publicRecord(row) : null;
    },
    async recordOutcome(rawInput) {
      const input = validateRecord(rawInput);
      const key = keyOf(input);
      const existing = rows.get(key);
      if (existing) {
        if (existing.resultHash !== input.resultHash || !same(existing.result, input.result)
          || existing.gatewayRequestId !== input.gatewayRequestId
          || !same(existing.modelEvidence, input.modelEvidence)
          || existing.gatewayConnectionId !== input.gatewayConnectionId
          || existing.gatewayConnectionVersion !== input.gatewayConnectionVersion) {
          throw failure("AUTO_LISTING_IMAGE_GROUP_CHECK_CONFLICT", false);
        }
        return publicRecord(existing);
      }
      const generatedId = id("image-group-check");
      if (!safeId(generatedId)) throw failure();
      const timestamp = iso(now());
      const row = {
        ...clone(input), id: generatedId, status: input.result.accepted ? "ACCEPTED" : "REJECTED",
        createdAt: timestamp, completedAt: timestamp,
      };
      rows.set(key, row);
      return publicRecord(row);
    },
  });
}

export function createPostgresImageGroupCheckRepository(options = {}) {
  if (!plainObject(options) || !options.pool || typeof options.pool.query !== "function"
    || (options.id !== undefined && typeof options.id !== "function")
    || Object.keys(options).some((key) => !["pool", "id"].includes(key))) {
    throw failure("AUTO_LISTING_IMAGE_GROUP_CHECK_INPUT_INVALID", false);
  }
  const id = options.id ?? (() => `image-group-check-${crypto.randomUUID()}`);

  async function query(sql, values) {
    try { return await options.pool.query(sql, values); }
    catch { throw failure(); }
  }

  async function loadOutcome(rawInput) {
    const input = validateLoad(rawInput);
    const result = await query(
      `SELECT id,account_id,job_id,item_id,plan_id,source_image_analysis_run_id,
              expected_status_version,visual_group_key,input_hash,result_hash,status,result,error_code,
              gateway_request_id,model_evidence,gateway_connection_id,gateway_connection_version,
              created_at,completed_at
         FROM auto_listing_image_group_checks
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
          AND source_image_analysis_run_id=$5 AND expected_status_version=$6
          AND visual_group_key=$7 AND input_hash=$8`,
      [input.accountId, input.jobId, input.itemId, input.planId, input.sourceImageAnalysisRunId,
        input.expectedStatusVersion, input.visualGroupKey, input.inputHash],
    );
    if (!result || !Array.isArray(result.rows) || result.rows.length > 1) throw failure();
    return result.rows.length === 0 ? null : mappedRow(result.rows[0]);
  }

  return Object.freeze({
    loadOutcome,
    async recordOutcome(rawInput) {
      const input = validateRecord(rawInput);
      const generatedId = id("image-group-check");
      if (!safeId(generatedId)) throw failure();
      const result = await query(
        `INSERT INTO auto_listing_image_group_checks (
           id,account_id,job_id,item_id,plan_id,source_image_analysis_run_id,
           expected_status_version,visual_group_key,input_hash,result_hash,status,result,error_code,
           created_at,completed_at,gateway_request_id,model_evidence,
           gateway_connection_id,gateway_connection_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::JSONB,NULL,
                   STATEMENT_TIMESTAMP(),STATEMENT_TIMESTAMP(),$13,$14::JSONB,$15,$16)
         ON CONFLICT (account_id,job_id,item_id,plan_id,visual_group_key,input_hash) DO NOTHING
         RETURNING id,account_id,job_id,item_id,plan_id,source_image_analysis_run_id,
                   expected_status_version,visual_group_key,input_hash,result_hash,status,result,error_code,
                   gateway_request_id,model_evidence,gateway_connection_id,gateway_connection_version,
                   created_at,completed_at`,
        [generatedId, input.accountId, input.jobId, input.itemId, input.planId,
          input.sourceImageAnalysisRunId, input.expectedStatusVersion, input.visualGroupKey,
          input.inputHash, input.resultHash, input.result.accepted ? "ACCEPTED" : "REJECTED",
          JSON.stringify(input.result), input.gatewayRequestId, JSON.stringify(input.modelEvidence),
          input.gatewayConnectionId, input.gatewayConnectionVersion],
      );
      if (!result || !Array.isArray(result.rows) || result.rows.length > 1) throw failure();
      const stored = result.rows.length === 1 ? mappedRow(result.rows[0]) : await loadOutcome(
        Object.fromEntries([...LOAD_KEYS].map((key) => [key, input[key]])),
      );
      if (!stored || stored.resultHash !== input.resultHash || !same(stored.result, input.result)
        || stored.gatewayRequestId !== input.gatewayRequestId
        || !same(stored.modelEvidence, input.modelEvidence)
        || !same(stored.gatewayConnection, input.gatewayConnectionId === null ? null : {
          id: input.gatewayConnectionId, version: input.gatewayConnectionVersion,
        })) throw failure("AUTO_LISTING_IMAGE_GROUP_CHECK_CONFLICT", false);
      return stored;
    },
  });
}

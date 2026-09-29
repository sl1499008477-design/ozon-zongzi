import crypto from "node:crypto";

const HASH = /^[a-f0-9]{64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SCOPE_KEYS = new Set([
  "accountId", "jobId", "itemId", "analysisRunId", "sourceAssetId",
  "expectedStatusVersion", "derivativeAttemptId",
]);
const RESERVE_KEYS = new Set([
  ...SCOPE_KEYS, "inputHash", "attemptNo", "originalContentHash", "overlayDecisionHash", "promptVersion",
]);
const GENERATED_KEYS = new Set([
  ...SCOPE_KEYS, "generatedObjectKey", "generatedContentHash", "generatedContentType",
  "generatedWidth", "generatedHeight", "generatedSizeBytes", "editGatewayRequestId",
  "editModelEvidence", "editGatewayConnectionId", "editGatewayConnectionVersion",
]);
const CHECK_KEYS = new Set([
  ...SCOPE_KEYS, "checkResult", "cleanupEvidenceHash", "checkerGatewayRequestId",
  "checkerModelEvidence", "checkerGatewayConnectionId", "checkerGatewayConnectionVersion",
]);
const RUN_SCOPE_KEYS = new Set(["accountId", "jobId", "itemId", "analysisRunId"]);
const CHECK_RESULT_KEYS = new Set([
  "contractVersion", "derivativeAttemptId", "sourceAssetId", "originalContentHash",
  "candidateContentHash", "overlayRemoved", "productIdentityPreserved", "nativeMarksPreserved",
  "geometryPreserved", "noInventedContent", "reasonCodes",
]);
const IMAGE_MODEL_EVIDENCE_KEYS = new Set([
  "requestedImageModel", "gatewayReportedImageModel", "gatewayReportedImageModelPresent", "orchestratorModel",
]);
const TEXT_MODEL_EVIDENCE_KEYS = new Set([
  "requestedTextModel", "gatewayReportedTextModel", "gatewayReportedTextModelPresent",
]);
const TERMINAL = new Set(["ACCEPTED", "REJECTED", "FAILED"]);
const FACTORY_KEYS = new Set(["query", "now", "id", "leaseToken"]);

function failure(code = "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_REPOSITORY_FAILED", retryable = true) {
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
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value)
    && !/(?:https?|ftp|file|data):|www\.|@|api[_-]?key|password|secret|bearer|authorization|cookie|token/iu.test(value);
}

function validVersion(value) {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function validateScope(input) {
  if (!exactObject(input, SCOPE_KEYS)
    || ![input.accountId, input.jobId, input.itemId, input.analysisRunId,
      input.sourceAssetId, input.derivativeAttemptId].every(safeId)
    || !validVersion(input.expectedStatusVersion)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID", false);
  }
  return input;
}

function validateReserve(input) {
  if (!exactObject(input, RESERVE_KEYS)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID", false);
  }
  validateScope(Object.fromEntries([...SCOPE_KEYS].map((key) => [key, input[key]])));
  if (![input.inputHash, input.originalContentHash, input.overlayDecisionHash].every((value) => HASH.test(value || ""))
    || !Number.isInteger(input.attemptNo) || input.attemptNo < 1 || input.attemptNo > 3
    || !safeId(input.promptVersion)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID", false);
  }
  return input;
}

function validConnection(id, version) {
  return (id === null && version === null) || (safeId(id) && validVersion(version));
}

function validModel(value, keys, requestedKey, reportedKey, presentKey) {
  return exactObject(value, keys) && safeId(value[requestedKey])
    && typeof value[reportedKey] === "string" && typeof value[presentKey] === "boolean"
    && (value[presentKey] ? safeId(value[reportedKey]) : value[reportedKey] === "")
    && (!keys.has("orchestratorModel") || typeof value.orchestratorModel === "string");
}

function validateGenerated(input) {
  if (!exactObject(input, GENERATED_KEYS)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID", false);
  }
  validateScope(Object.fromEntries([...SCOPE_KEYS].map((key) => [key, input[key]])));
  if (typeof input.generatedObjectKey !== "string"
    || !input.generatedObjectKey.startsWith("auto-listing/source-derivative/v1/")
    || Buffer.byteLength(input.generatedObjectKey, "utf8") > 2048 || /[?#]/u.test(input.generatedObjectKey)
    || !HASH.test(input.generatedContentHash || "")
    || !["image/png", "image/jpeg", "image/webp"].includes(input.generatedContentType)
    || !Number.isInteger(input.generatedWidth) || input.generatedWidth < 1
    || !Number.isInteger(input.generatedHeight) || input.generatedHeight < 1
    || input.generatedWidth * input.generatedHeight > 40_000_000
    || !Number.isInteger(input.generatedSizeBytes) || input.generatedSizeBytes < 1
    || input.generatedSizeBytes > 8 * 1024 * 1024
    || !safeId(input.editGatewayRequestId)
    || !validModel(input.editModelEvidence, IMAGE_MODEL_EVIDENCE_KEYS,
      "requestedImageModel", "gatewayReportedImageModel", "gatewayReportedImageModelPresent")
    || !validConnection(input.editGatewayConnectionId, input.editGatewayConnectionVersion)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID", false);
  }
  return input;
}

function acceptedCheck(result) {
  return result.overlayRemoved && result.productIdentityPreserved && result.nativeMarksPreserved
    && result.geometryPreserved && result.noInventedContent;
}

function validateCheck(input) {
  if (!exactObject(input, CHECK_KEYS)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID", false);
  }
  validateScope(Object.fromEntries([...SCOPE_KEYS].map((key) => [key, input[key]])));
  const result = input.checkResult;
  if (!exactObject(result, CHECK_RESULT_KEYS)
    || result.contractVersion !== "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_V1"
    || result.derivativeAttemptId !== input.derivativeAttemptId
    || result.sourceAssetId !== input.sourceAssetId
    || !HASH.test(result.originalContentHash || "") || !HASH.test(result.candidateContentHash || "")
    || ![result.overlayRemoved, result.productIdentityPreserved, result.nativeMarksPreserved,
      result.geometryPreserved, result.noInventedContent].every((value) => typeof value === "boolean")
    || !Array.isArray(result.reasonCodes) || new Set(result.reasonCodes).size !== result.reasonCodes.length
    || !result.reasonCodes.every((code) => ERROR_CODE.test(code))
    || (acceptedCheck(result) ? result.reasonCodes.length !== 0 : result.reasonCodes.length === 0)
    || !HASH.test(input.cleanupEvidenceHash || "") || input.cleanupEvidenceHash !== digest(result)
    || !safeId(input.checkerGatewayRequestId)
    || !validModel(input.checkerModelEvidence, TEXT_MODEL_EVIDENCE_KEYS,
      "requestedTextModel", "gatewayReportedTextModel", "gatewayReportedTextModelPresent")
    || !validConnection(input.checkerGatewayConnectionId, input.checkerGatewayConnectionVersion)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID", false);
  }
  return input;
}

function validateRunScope(input) {
  if (!exactObject(input, RUN_SCOPE_KEYS)
    || ![input.accountId, input.jobId, input.itemId, input.analysisRunId].every(safeId)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID", false);
  }
  return input;
}

const clone = (value) => structuredClone(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const scopeKey = (value) => [value.accountId, value.jobId, value.itemId, value.analysisRunId,
  value.sourceAssetId, value.expectedStatusVersion, value.derivativeAttemptId].join("\u0001");
const acceptedKey = (value) => [value.accountId, value.jobId, value.itemId,
  value.analysisRunId, value.sourceAssetId].join("\u0001");
const uniqueInputKey = (value) => [value.accountId, value.analysisRunId, value.sourceAssetId,
  value.inputHash, value.attemptNo].join("\u0001");

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw failure();
  return date.toISOString();
}

function publicRow(row) {
  return clone({
    id: row.id,
    accountId: row.accountId,
    jobId: row.jobId,
    itemId: row.itemId,
    analysisRunId: row.analysisRunId,
    sourceAssetId: row.sourceAssetId,
    expectedStatusVersion: row.expectedStatusVersion,
    derivativeAttemptId: row.derivativeAttemptId,
    inputHash: row.inputHash,
    attemptNo: row.attemptNo,
    originalContentHash: row.originalContentHash,
    overlayDecisionHash: row.overlayDecisionHash,
    promptVersion: row.promptVersion,
    status: row.status,
    leaseToken: row.leaseToken,
    generatedObjectKey: row.generatedObjectKey ?? null,
    generatedContentHash: row.generatedContentHash ?? null,
    generatedContentType: row.generatedContentType ?? null,
    generatedWidth: row.generatedWidth ?? null,
    generatedHeight: row.generatedHeight ?? null,
    generatedSizeBytes: row.generatedSizeBytes ?? null,
    editGatewayRequestId: row.editGatewayRequestId ?? null,
    editModelEvidence: row.editModelEvidence ?? null,
    editGatewayConnection: row.editGatewayConnectionId == null ? null : {
      id: row.editGatewayConnectionId, version: row.editGatewayConnectionVersion,
    },
    checkResult: row.checkResult ?? null,
    cleanupEvidenceHash: row.cleanupEvidenceHash ?? null,
    checkerGatewayRequestId: row.checkerGatewayRequestId ?? null,
    checkerModelEvidence: row.checkerModelEvidence ?? null,
    checkerGatewayConnection: row.checkerGatewayConnectionId == null ? null : {
      id: row.checkerGatewayConnectionId, version: row.checkerGatewayConnectionVersion,
    },
    createdAt: iso(row.createdAt),
    generatedAt: row.generatedAt == null ? null : iso(row.generatedAt),
    completedAt: row.completedAt == null ? null : iso(row.completedAt),
  });
}

function sameReserve(row, input) {
  return [...RESERVE_KEYS].every((key) => row[key] === input[key]);
}

function sameGenerated(row, input) {
  return [...GENERATED_KEYS].filter((key) => !SCOPE_KEYS.has(key))
    .every((key) => same(row[key], input[key]));
}

function sameCheck(row, input) {
  return [...CHECK_KEYS].filter((key) => !SCOPE_KEYS.has(key))
    .every((key) => same(row[key], input[key]));
}

function buildMemory(options) {
  const rows = new Map();
  const uniqueInputs = new Map();
  const accepted = new Map();
  const now = options.now;
  const makeId = options.id;
  const makeLeaseToken = options.leaseToken;

  function find(input) { return rows.get(scopeKey(input)) || null; }
  function requireRow(input) {
    const row = find(input);
    if (!row) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_NOT_FOUND", false);
    return row;
  }

  return Object.freeze({
    async reserveAttempt(rawInput) {
      const input = validateReserve(rawInput);
      const key = scopeKey(input);
      const existing = rows.get(key);
      if (existing) {
        if (!sameReserve(existing, input)) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CONFLICT", false);
        return publicRow(existing);
      }
      const uniqueKey = uniqueInputKey(input);
      if (uniqueInputs.has(uniqueKey)) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CONFLICT", false);
      const id = makeId("source-image-derivative");
      const leaseToken = makeLeaseToken("source-image-derivative");
      if (![id, leaseToken].every(safeId)) throw failure();
      const row = { ...clone(input), id, leaseToken, status: "RESERVED", createdAt: iso(now()) };
      rows.set(key, row);
      uniqueInputs.set(uniqueKey, key);
      return publicRow(row);
    },
    async recordGeneratedCandidate(rawInput) {
      const input = validateGenerated(rawInput);
      const row = requireRow(input);
      if (TERMINAL.has(row.status)) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_TERMINAL", false);
      if (row.status === "GENERATED") {
        if (!sameGenerated(row, input)) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CONFLICT", false);
        return publicRow(row);
      }
      if (row.status !== "RESERVED") throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CONFLICT", false);
      Object.assign(row, clone(input), { status: "GENERATED", generatedAt: iso(now()) });
      return publicRow(row);
    },
    async recordCheckResult(rawInput) {
      const input = validateCheck(rawInput);
      const row = requireRow(input);
      if (TERMINAL.has(row.status)) {
        if ((row.status === "ACCEPTED" || row.status === "REJECTED") && sameCheck(row, input)) return publicRow(row);
        throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_TERMINAL", false);
      }
      if (row.status !== "GENERATED" || input.checkResult.originalContentHash !== row.originalContentHash
        || input.checkResult.candidateContentHash !== row.generatedContentHash) {
        throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CONFLICT", false);
      }
      const isAccepted = acceptedCheck(input.checkResult);
      const bindingKey = acceptedKey(row);
      if (isAccepted && accepted.has(bindingKey)) {
        throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_ACCEPTED_CONFLICT", false);
      }
      Object.assign(row, clone(input), {
        status: isAccepted ? "ACCEPTED" : "REJECTED",
        completedAt: iso(now()),
      });
      if (isAccepted) accepted.set(bindingKey, scopeKey(row));
      return publicRow(row);
    },
    async loadAttempt(rawInput) {
      const input = validateScope(rawInput);
      const row = find(input);
      return row ? publicRow(row) : null;
    },
    async listAcceptedBindings(rawInput) {
      const input = validateRunScope(rawInput);
      return [...rows.values()].filter((row) => row.status === "ACCEPTED"
        && row.accountId === input.accountId && row.jobId === input.jobId
        && row.itemId === input.itemId && row.analysisRunId === input.analysisRunId)
        .sort((left, right) => left.sourceAssetId.localeCompare(right.sourceAssetId, "en"))
        .map((row) => ({
          sourceAssetId: row.sourceAssetId,
          mode: "CLEANED",
          effectiveContentHash: row.generatedContentHash,
          derivativeAttemptId: row.derivativeAttemptId,
          cleanupEvidenceHash: row.cleanupEvidenceHash,
        }));
    },
  });
}

const ROW_COLUMNS = `id,account_id,job_id,item_id,analysis_run_id,source_asset_id,
  expected_status_version,derivative_attempt_id,input_hash,attempt_no,original_content_hash,
  overlay_decision_hash,prompt_version,status,lease_token,generated_object_key,generated_content_hash,
  generated_content_type,generated_width,generated_height,generated_size_bytes,edit_gateway_request_id,
  edit_model_evidence,edit_gateway_connection_id,edit_gateway_connection_version,check_result,
  cleanup_evidence_hash,checker_gateway_request_id,checker_model_evidence,checker_gateway_connection_id,
  checker_gateway_connection_version,created_at,generated_at,completed_at`;

function mappedRow(row) {
  if (!row) return null;
  const json = (value) => typeof value === "string" ? JSON.parse(value) : value;
  return {
    id: row.id, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    analysisRunId: row.analysis_run_id, sourceAssetId: row.source_asset_id,
    expectedStatusVersion: Number(row.expected_status_version), derivativeAttemptId: row.derivative_attempt_id,
    inputHash: row.input_hash, attemptNo: Number(row.attempt_no), originalContentHash: row.original_content_hash,
    overlayDecisionHash: row.overlay_decision_hash, promptVersion: row.prompt_version, status: row.status,
    leaseToken: row.lease_token, generatedObjectKey: row.generated_object_key,
    generatedContentHash: row.generated_content_hash, generatedContentType: row.generated_content_type,
    generatedWidth: row.generated_width == null ? null : Number(row.generated_width),
    generatedHeight: row.generated_height == null ? null : Number(row.generated_height),
    generatedSizeBytes: row.generated_size_bytes == null ? null : Number(row.generated_size_bytes),
    editGatewayRequestId: row.edit_gateway_request_id, editModelEvidence: json(row.edit_model_evidence),
    editGatewayConnectionId: row.edit_gateway_connection_id,
    editGatewayConnectionVersion: row.edit_gateway_connection_version == null ? null : Number(row.edit_gateway_connection_version),
    checkResult: json(row.check_result), cleanupEvidenceHash: row.cleanup_evidence_hash,
    checkerGatewayRequestId: row.checker_gateway_request_id,
    checkerModelEvidence: json(row.checker_model_evidence),
    checkerGatewayConnectionId: row.checker_gateway_connection_id,
    checkerGatewayConnectionVersion: row.checker_gateway_connection_version == null
      ? null : Number(row.checker_gateway_connection_version),
    createdAt: row.created_at, generatedAt: row.generated_at, completedAt: row.completed_at,
  };
}

function buildPostgres(options) {
  const execute = async (text, values) => {
    try { return await options.query(text, values); }
    catch (caught) {
      if (caught?.code === "23505" && String(caught.constraint || "").includes("one_accepted")) {
        throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_ACCEPTED_CONFLICT", false);
      }
      if (caught?.code && String(caught.code).startsWith("AUTO_LISTING_")) throw caught;
      throw failure();
    }
  };

  async function load(input) {
    const result = await execute(`SELECT ${ROW_COLUMNS} FROM auto_listing_source_image_derivatives
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND analysis_run_id=$4
        AND source_asset_id=$5 AND expected_status_version=$6 AND derivative_attempt_id=$7`, [
      input.accountId, input.jobId, input.itemId, input.analysisRunId, input.sourceAssetId,
      input.expectedStatusVersion, input.derivativeAttemptId,
    ]);
    return mappedRow(result.rows[0]);
  }

  return Object.freeze({
    async reserveAttempt(rawInput) {
      const input = validateReserve(rawInput);
      const id = options.id("source-image-derivative");
      const token = options.leaseToken("source-image-derivative");
      if (![id, token].every(safeId)) throw failure();
      const result = await execute(`INSERT INTO auto_listing_source_image_derivatives (
          id,account_id,job_id,item_id,analysis_run_id,source_asset_id,expected_status_version,
          derivative_attempt_id,input_hash,attempt_no,original_content_hash,overlay_decision_hash,
          prompt_version,status,lease_token
        ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'RESERVED',$14
          FROM auto_listing_job_items AS item
          JOIN auto_listing_source_image_analysis_runs AS run
            ON run.account_id=item.account_id AND run.job_id=item.job_id AND run.item_id=item.id AND run.id=$5
          JOIN auto_listing_source_image_assessments AS assessment
            ON assessment.account_id=run.account_id AND assessment.job_id=run.job_id
            AND assessment.item_id=run.item_id AND assessment.analysis_run_id=run.id
            AND assessment.source_asset_id=$6
         WHERE item.account_id=$2 AND item.job_id=$3 AND item.id=$4
           AND item.status_version=$7 AND item.current_source_image_analysis_run_id=$5
        ON CONFLICT DO NOTHING RETURNING ${ROW_COLUMNS}`, [
        id, input.accountId, input.jobId, input.itemId, input.analysisRunId, input.sourceAssetId,
        input.expectedStatusVersion, input.derivativeAttemptId, input.inputHash, input.attemptNo,
        input.originalContentHash, input.overlayDecisionHash, input.promptVersion, token,
      ]);
      const row = mappedRow(result.rows[0]) || await load(input);
      if (!row) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_NOT_FOUND", false);
      if (!sameReserve(row, input)) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CONFLICT", false);
      return publicRow(row);
    },
    async recordGeneratedCandidate(rawInput) {
      const input = validateGenerated(rawInput);
      const result = await execute(`UPDATE auto_listing_source_image_derivatives SET
          status='GENERATED',generated_object_key=$8,generated_content_hash=$9,generated_content_type=$10,
          generated_width=$11,generated_height=$12,generated_size_bytes=$13,edit_gateway_request_id=$14,
          edit_model_evidence=$15::JSONB,edit_gateway_connection_id=$16,edit_gateway_connection_version=$17,
          generated_at=STATEMENT_TIMESTAMP()
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND analysis_run_id=$4 AND source_asset_id=$5
          AND expected_status_version=$6 AND derivative_attempt_id=$7 AND status='RESERVED'
        RETURNING ${ROW_COLUMNS}`, [input.accountId, input.jobId, input.itemId, input.analysisRunId,
        input.sourceAssetId, input.expectedStatusVersion, input.derivativeAttemptId, input.generatedObjectKey,
        input.generatedContentHash, input.generatedContentType, input.generatedWidth, input.generatedHeight,
        input.generatedSizeBytes, input.editGatewayRequestId, JSON.stringify(input.editModelEvidence),
        input.editGatewayConnectionId, input.editGatewayConnectionVersion]);
      const row = mappedRow(result.rows[0]) || await load(input);
      if (!row) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_NOT_FOUND", false);
      if (TERMINAL.has(row.status)) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_TERMINAL", false);
      if (row.status !== "GENERATED" || !sameGenerated(row, input)) {
        throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CONFLICT", false);
      }
      return publicRow(row);
    },
    async recordCheckResult(rawInput) {
      const input = validateCheck(rawInput);
      const status = acceptedCheck(input.checkResult) ? "ACCEPTED" : "REJECTED";
      const result = await execute(`UPDATE auto_listing_source_image_derivatives SET
          status=$8,check_result=$9::JSONB,cleanup_evidence_hash=$10,checker_gateway_request_id=$11,
          checker_model_evidence=$12::JSONB,checker_gateway_connection_id=$13,
          checker_gateway_connection_version=$14,completed_at=STATEMENT_TIMESTAMP()
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND analysis_run_id=$4 AND source_asset_id=$5
          AND expected_status_version=$6 AND derivative_attempt_id=$7 AND status='GENERATED'
          AND original_content_hash=$15 AND generated_content_hash=$16
        RETURNING ${ROW_COLUMNS}`, [input.accountId, input.jobId, input.itemId, input.analysisRunId,
        input.sourceAssetId, input.expectedStatusVersion, input.derivativeAttemptId, status,
        JSON.stringify(input.checkResult), input.cleanupEvidenceHash, input.checkerGatewayRequestId,
        JSON.stringify(input.checkerModelEvidence), input.checkerGatewayConnectionId,
        input.checkerGatewayConnectionVersion, input.checkResult.originalContentHash,
        input.checkResult.candidateContentHash]);
      const row = mappedRow(result.rows[0]) || await load(input);
      if (!row) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_NOT_FOUND", false);
      if ((row.status === "ACCEPTED" || row.status === "REJECTED") && sameCheck(row, input)) return publicRow(row);
      if (TERMINAL.has(row.status)) throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_TERMINAL", false);
      throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CONFLICT", false);
    },
    async loadAttempt(rawInput) {
      const input = validateScope(rawInput);
      const row = await load(input);
      return row ? publicRow(row) : null;
    },
    async listAcceptedBindings(rawInput) {
      const input = validateRunScope(rawInput);
      const result = await execute(`SELECT source_asset_id,generated_content_hash,derivative_attempt_id,
          cleanup_evidence_hash FROM auto_listing_source_image_derivatives
        WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND analysis_run_id=$4 AND status='ACCEPTED'
        ORDER BY source_asset_id`, [input.accountId, input.jobId, input.itemId, input.analysisRunId]);
      return result.rows.map((row) => ({ sourceAssetId: row.source_asset_id, mode: "CLEANED",
        effectiveContentHash: row.generated_content_hash, derivativeAttemptId: row.derivative_attempt_id,
        cleanupEvidenceHash: row.cleanup_evidence_hash }));
    },
  });
}

export function createAutoListingSourceImageDerivativeRepository(options = {}) {
  if (!plainObject(options) || Object.keys(options).some((key) => !FACTORY_KEYS.has(key))
    || (options.query !== undefined && typeof options.query !== "function")) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID", false);
  }
  const configured = {
    query: options.query,
    now: options.now ?? (() => new Date()),
    id: options.id ?? (() => `source-image-derivative-${crypto.randomUUID()}`),
    leaseToken: options.leaseToken ?? (() => `source-image-derivative-lease-${crypto.randomUUID()}`),
  };
  if (![configured.now, configured.id, configured.leaseToken].every((value) => typeof value === "function")) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID", false);
  }
  return configured.query ? buildPostgres(configured) : buildMemory(configured);
}


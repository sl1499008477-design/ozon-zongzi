import crypto from "node:crypto";
import {
  GENERATED_ASSET_OBJECT_KEY_VERSIONS,
  verifyGeneratedAssetObjectKey,
} from "./auto-listing-asset-store.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const GENERATION_SIZE = /^[1-9][0-9]*x[1-9][0-9]*$/u;
const ROLES = new Set(["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]);
const SCOPE_KEYS = Object.freeze([
  "accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "expectedStatusVersion",
]);
const RESERVE_KEYS = new Set([...SCOPE_KEYS, "attemptIdentityHash", "generationSize", "maxAttempts"]);
const OWNER_KEYS = Object.freeze([
  ...SCOPE_KEYS, "attemptIdentityHash", "inputHash", "generationSize", "attemptNo", "leaseToken",
]);
const BIND_KEYS = new Set(OWNER_KEYS);
const STORED_KEYS = Object.freeze([
  "objectKeyVersion", "objectKey", "contentHash", "contentType", "width", "height", "size",
]);
const STORE_KEYS = new Set([...OWNER_KEYS, ...STORED_KEYS]);
const FIND_KEYS = new Set([...OWNER_KEYS, "contentHash"]);
const COMPLETE_KEYS = new Set([
  ...OWNER_KEYS, "role", ...STORED_KEYS, "checkerEvidence", "gatewayRequestId", "checkerRequestId",
  "modelEvidence", "profileId", "profileVersion", "modelName", "promptHash", "planHash", "sourceHash",
  "strategyHash", "configHash", "visualGroupsHash", "promptTemplateVersion", "sourceAssetEvidence", "regeneration",
]);
const REJECT_KEYS = new Set([
  ...OWNER_KEYS, "role", ...STORED_KEYS, "code", "retryable", "checkerEvidence", "gatewayRequestId",
  "checkerRequestId", "modelEvidence",
]);
const FAIL_KEYS = new Set([
  ...OWNER_KEYS, "role", "code", "retryable", "gatewayRequestId", "checkerRequestId",
]);
const RELEASE_KEYS = new Set([...OWNER_KEYS, "errorCode"]);
const FACTORY_KEYS = new Set(["pool", "leaseMs", "token", "id"]);
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 67_108_864;

function failure(code) {
  const messages = {
    AUTO_LISTING_IMAGE_ATTEMPT_INVALID: "图片生成记录无效",
    AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED: "图片生成租约已失效",
    AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT: "图片生成记录不一致",
    AUTO_LISTING_IMAGE_ATTEMPT_REPOSITORY_FAILED: "图片生成记录暂时不可用",
  };
  const error = new Error(messages[code] || messages.AUTO_LISTING_IMAGE_ATTEMPT_INVALID);
  error.code = code;
  error.retryable = code === "AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED"
    || code === "AUTO_LISTING_IMAGE_ATTEMPT_REPOSITORY_FAILED";
  return error;
}

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exactObject(value, keys) {
  try {
    return plainObject(value) && Object.keys(value).length === keys.size
      && Object.keys(value).every((key) => keys.has(key));
  } catch {
    return false;
  }
}
function safeIdentifier(value, maximum = 240) {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/(?:https?|ftp|file|data):|www\.|@|api[_-]?key|password|passwd|secret|bearer|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token/iu.test(value);
}
function safeJson(value, { nullable = false, nonempty = false, maximum = 262_144 } = {}) {
  if (nullable && value === null) return true;
  if (!plainObject(value) && !Array.isArray(value)) return false;
  if (nonempty && Object.keys(value).length === 0) return false;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= maximum
      && !serialized.includes("\u0000");
  } catch {
    return false;
  }
}
function dateIso(value) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT");
  return new Date(timestamp).toISOString();
}
function validateScope(input) {
  if (!SCOPE_KEYS.slice(0, 6).every((key) => safeIdentifier(input?.[key]))
    || !Number.isInteger(input?.expectedStatusVersion) || input.expectedStatusVersion < 1
    || input.expectedStatusVersion > 2_147_483_647) {
    throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  }
}
function validateReserve(input) {
  if (!exactObject(input, RESERVE_KEYS)) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  validateScope(input);
  if (!HASH.test(input.attemptIdentityHash || "") || !GENERATION_SIZE.test(input.generationSize || "")
    || !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 3) {
    throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  }
  return input;
}
function validateOwner(input, keys) {
  if (!exactObject(input, keys)) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  validateScope(input);
  if (!HASH.test(input.attemptIdentityHash || "") || !HASH.test(input.inputHash || "")
    || !GENERATION_SIZE.test(input.generationSize || "")
    || !Number.isInteger(input.attemptNo) || input.attemptNo < 1 || input.attemptNo > 3
    || !safeIdentifier(input.leaseToken)) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  return input;
}
function validStoredEvidence(input) {
  return input.objectKeyVersion === GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
    && HASH.test(input.contentHash || "") && input.contentType === "image/png"
    && Number.isInteger(input.width) && input.width > 0 && input.width <= 100_000
    && Number.isInteger(input.height) && input.height > 0 && input.height <= 100_000
    && input.width * input.height <= MAX_IMAGE_PIXELS
    && Number.isInteger(input.size) && input.size > 0 && input.size <= MAX_IMAGE_BYTES
    && verifyGeneratedAssetObjectKey(input);
}
function validateStored(input, keys = STORE_KEYS) {
  validateOwner(input, keys);
  if (!validStoredEvidence(input)) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  return input;
}
function validateComplete(input) {
  validateStored(input, COMPLETE_KEYS);
  if (!ROLES.has(input.role) || !safeIdentifier(input.profileId)
    || !Number.isInteger(input.profileVersion) || input.profileVersion < 1
    || !safeIdentifier(input.modelName) || !safeIdentifier(input.promptTemplateVersion)
    || ![input.promptHash, input.planHash, input.sourceHash, input.strategyHash, input.configHash, input.visualGroupsHash]
      .every((value) => HASH.test(value || ""))
    || !safeIdentifier(input.gatewayRequestId) || !safeIdentifier(input.checkerRequestId)
    || !safeJson(input.checkerEvidence, { nonempty: true }) || !safeJson(input.modelEvidence, { nonempty: true })
    || !Array.isArray(input.sourceAssetEvidence) || input.sourceAssetEvidence.length < 1
    || input.sourceAssetEvidence.length > 7 || !safeJson(input.sourceAssetEvidence, { nonempty: true })
    || !safeJson(input.regeneration, { nullable: true })) {
    throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  }
  return input;
}
function validateReject(input) {
  validateStored(input, REJECT_KEYS);
  if (!ROLES.has(input.role) || !ERROR_CODE.test(input.code || "") || typeof input.retryable !== "boolean"
    || !safeIdentifier(input.gatewayRequestId) || !safeIdentifier(input.checkerRequestId)
    || !safeJson(input.checkerEvidence, { nonempty: true }) || !safeJson(input.modelEvidence, { nonempty: true })) {
    throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  }
  return input;
}
function validateFail(input) {
  validateOwner(input, FAIL_KEYS);
  if (!ROLES.has(input.role) || !ERROR_CODE.test(input.code || "") || typeof input.retryable !== "boolean"
    || !(input.gatewayRequestId === null || safeIdentifier(input.gatewayRequestId))
    || !(input.checkerRequestId === null || safeIdentifier(input.checkerRequestId))) {
    throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  }
  return input;
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    planId: row.plan_id, profileId: row.profile_id, visualGroupKey: row.visual_group_key,
    slotKey: row.slot_key, role: row.role, inputHash: row.input_hash,
    attemptNo: row.attempt_no, status: row.status, gatewayRequestId: row.gateway_request_id,
    checkerRequestId: row.checker_request_id, modelName: row.model_name,
    profileVersion: row.profile_version, promptHash: row.prompt_hash,
    objectKeyVersion: row.object_key_version, objectKey: row.object_key, contentHash: row.content_hash,
    contentType: row.content_type, width: row.width, height: row.height,
    size: row.size_bytes == null ? null : Number(row.size_bytes),
    checkerEvidence: row.checker_result, errorCode: row.error_code, errorRetryable: row.error_retryable,
    acceptedAt: row.accepted_at, planHash: row.plan_hash, sourceHash: row.source_hash,
    strategyHash: row.strategy_hash, configHash: row.config_hash, visualGroupsHash: row.visual_groups_hash,
    promptTemplateVersion: row.prompt_template_version, sourceAssetEvidence: row.source_asset_evidence,
    modelEvidence: row.model_evidence, regeneration: row.regeneration, leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at, attemptIdentityHash: row.attempt_identity_hash,
    generationSize: row.generation_size, finalInputBoundAt: row.final_input_bound_at,
    expectedStatusVersion: row.expected_status_version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function publicRecord(row) {
  const value = structuredClone(row);
  for (const key of ["acceptedAt", "leaseExpiresAt", "finalInputBoundAt", "createdAt", "updatedAt"]) {
    if (value[key] != null) value[key] = dateIso(value[key]);
  }
  return value;
}
function acceptedRecordValid(record) {
  return record?.status === "ACCEPTED" && record.leaseToken === null && record.leaseExpiresAt === null
    && record.finalInputBoundAt !== null && record.acceptedAt !== null && record.errorCode === null
    && record.errorRetryable === null && ROLES.has(record.role) && validStoredEvidence(record)
    && safeIdentifier(record.profileId) && Number.isInteger(record.profileVersion) && record.profileVersion > 0
    && safeIdentifier(record.modelName) && safeIdentifier(record.promptTemplateVersion)
    && safeIdentifier(record.gatewayRequestId) && safeIdentifier(record.checkerRequestId)
    && [record.promptHash, record.planHash, record.sourceHash, record.strategyHash, record.configHash, record.visualGroupsHash]
      .every((value) => HASH.test(value || ""))
    && safeJson(record.checkerEvidence, { nonempty: true }) && safeJson(record.modelEvidence, { nonempty: true })
    && Array.isArray(record.sourceAssetEvidence) && record.sourceAssetEvidence.length >= 1
    && record.sourceAssetEvidence.length <= 7 && safeJson(record.sourceAssetEvidence, { nonempty: true })
    && safeJson(record.regeneration, { nullable: true });
}

function scopeValues(input) {
  return SCOPE_KEYS.map((key) => input[key]);
}
function ownerValues(input) {
  return [...scopeValues(input), input.attemptIdentityHash, input.inputHash, input.generationSize, input.attemptNo, input.leaseToken];
}

export function createPostgresGenerationAttemptRepository(options = {}) {
  if (!exactObject(options, FACTORY_KEYS) && !(
    plainObject(options) && Object.keys(options).every((key) => FACTORY_KEYS.has(key))
  )) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  const { pool } = options;
  const leaseMs = options.leaseMs ?? 60_000;
  const token = options.token ?? (() => crypto.randomUUID());
  const id = options.id ?? (() => `generation-${crypto.randomUUID()}`);
  if ((typeof pool?.connect !== "function" && typeof pool?.query !== "function")
    || typeof token !== "function" || typeof id !== "function"
    || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 24 * 60 * 60 * 1000) {
    throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  }

  async function query(text, parameters) {
    try { return await pool.query(text, parameters); }
    catch (cause) {
      if (cause?.code?.startsWith?.("AUTO_LISTING_IMAGE_ATTEMPT_")) throw cause;
      throw failure("AUTO_LISTING_IMAGE_ATTEMPT_REPOSITORY_FAILED");
    }
  }
  async function transaction(work) {
    let client;
    try {
      client = typeof pool.connect === "function" ? await pool.connect() : pool;
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (cause) {
      if (client) { try { await client.query("ROLLBACK"); } catch {} }
      if (cause?.code?.startsWith?.("AUTO_LISTING_IMAGE_ATTEMPT_")) throw cause;
      throw failure("AUTO_LISTING_IMAGE_ATTEMPT_REPOSITORY_FAILED");
    } finally {
      if (client && client !== pool) {
        try { await client.release(); } catch { throw failure("AUTO_LISTING_IMAGE_ATTEMPT_REPOSITORY_FAILED"); }
      }
    }
  }

  async function lockRuntimeScope(client, input) {
    const result = await client.query(
      `SELECT item.status,item.status_version,item.active_content_plan_id,
              plan.profile_id,plan.profile_version,profile.image_model,selected_slot.role
       FROM auto_listing_job_items AS item
       JOIN ai_content_plans AS plan
         ON plan.account_id=item.account_id AND plan.job_id=item.job_id
        AND plan.item_id=item.id AND plan.id=$4
       JOIN ai_gateway_profiles AS profile
         ON profile.account_id=plan.account_id AND profile.id=plan.profile_id
        AND profile.config_version=plan.profile_version
       JOIN LATERAL (
         SELECT slot->>'role' AS role
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(plan.plan->'slots')='array'
           THEN plan.plan->'slots' ELSE '[]'::JSONB END) AS slots(slot)
         WHERE slot->>'visualGroupKey'=$5 AND slot->>'slotKey'=$6
       ) AS selected_slot ON TRUE
       WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3
       FOR UPDATE OF item`, scopeValues(input).slice(0, 6),
    );
    if (result.rowCount !== 1 || !ROLES.has(result.rows[0]?.role)
      || !safeIdentifier(result.rows[0]?.profile_id) || !safeIdentifier(result.rows[0]?.image_model)
      || !Number.isInteger(result.rows[0]?.profile_version)) {
      throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
    }
    const state = result.rows[0];
    if (state.status === "CANCELLED") return { disposition: "CANCELLED", state };
    if (state.status !== "GENERATING" || state.status_version !== input.expectedStatusVersion
      || state.active_content_plan_id !== input.planId) return { disposition: "STALE", state };
    return { disposition: "CURRENT", state };
  }

  async function reserveGenerationAttempt(rawInput) {
    const input = validateReserve(rawInput);
    let nonce; let attemptId;
    try { nonce = token(); attemptId = id(); } catch { throw failure("AUTO_LISTING_IMAGE_ATTEMPT_REPOSITORY_FAILED"); }
    if (!safeIdentifier(nonce) || !safeIdentifier(attemptId)) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_REPOSITORY_FAILED");
    return transaction(async (client) => {
      const runtime = await lockRuntimeScope(client, input);
      if (runtime.disposition !== "CURRENT") return { status: runtime.disposition };
      const values = [...scopeValues(input), input.attemptIdentityHash, input.generationSize];
      const accepted = await client.query(
        `SELECT * FROM ai_generation_assets
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
           AND visual_group_key=$5 AND slot_key=$6 AND expected_status_version=$7
           AND attempt_identity_hash=$8 AND generation_size=$9 AND status='ACCEPTED'
         FOR UPDATE`, values,
      );
      if (accepted.rowCount) {
        const record = fromRow(accepted.rows[0]);
        if (accepted.rowCount !== 1 || !acceptedRecordValid(record)) {
          throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT");
        }
        return { status: "EXISTING_ACCEPTED", record: publicRecord(record) };
      }
      const active = await client.query(
        `SELECT id FROM ai_generation_assets
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
           AND visual_group_key=$5 AND slot_key=$6 AND expected_status_version=$7
           AND attempt_identity_hash=$8 AND generation_size=$9
           AND status='GENERATING' AND lease_expires_at > NOW()
         FOR UPDATE`, values,
      );
      if (active.rowCount) return { status: "IN_PROGRESS" };
      await client.query(
        `UPDATE ai_generation_assets
         SET status='FAILED',lease_token=NULL,lease_expires_at=NULL,
             error_code='AUTO_LISTING_IMAGE_LEASE_EXPIRED',error_retryable=TRUE,updated_at=NOW()
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
           AND visual_group_key=$5 AND slot_key=$6 AND expected_status_version=$7
           AND attempt_identity_hash=$8 AND generation_size=$9
           AND status='GENERATING' AND lease_expires_at <= NOW()`, values,
      );
      const attempts = await client.query(
        `SELECT COALESCE(MAX(attempt_no),0)::INTEGER AS attempt_no
         FROM ai_generation_assets
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
           AND visual_group_key=$5 AND slot_key=$6 AND expected_status_version=$7
           AND attempt_identity_hash=$8 AND generation_size=$9`, values,
      );
      const attemptNo = Number(attempts.rows?.[0]?.attempt_no || 0) + 1;
      if (attemptNo > input.maxAttempts) return { status: "ATTEMPTS_EXHAUSTED" };
      const inserted = await client.query(
        `INSERT INTO ai_generation_assets (
           id,account_id,job_id,item_id,plan_id,profile_id,visual_group_key,slot_key,role,
           input_hash,attempt_no,status,model_name,profile_version,prompt_hash,lease_token,
           lease_expires_at,attempt_identity_hash,generation_size,expected_status_version
         ) VALUES ($10,$1,$2,$3,$4,$11,$5,$6,$12,$8,$13,'GENERATING',$14,$15,$8,
           $16::TEXT || ':' || $13::INTEGER::TEXT,NOW()+($17::INTEGER * INTERVAL '1 millisecond'),$8,$9,$7)
         RETURNING *`, [...values, attemptId, runtime.state.profile_id, runtime.state.role, attemptNo,
          runtime.state.image_model, runtime.state.profile_version, nonce, leaseMs],
      );
      const record = fromRow(inserted.rows?.[0]);
      if (inserted.rowCount !== 1 || record?.status !== "GENERATING"
        || record.expectedStatusVersion !== input.expectedStatusVersion
        || record.attemptIdentityHash !== input.attemptIdentityHash
        || record.generationSize !== input.generationSize) {
        throw failure("AUTO_LISTING_IMAGE_ATTEMPT_REPOSITORY_FAILED");
      }
      return {
        status: "RESERVED", attemptNo: record.attemptNo, leaseToken: record.leaseToken,
        generationSize: record.generationSize, leaseExpiresAt: dateIso(record.leaseExpiresAt),
      };
    });
  }

  async function bindGenerationAttemptInput(rawInput) {
    const input = validateOwner(rawInput, BIND_KEYS);
    return transaction(async (client) => {
      const runtime = await lockRuntimeScope(client, input);
      if (runtime.disposition !== "CURRENT") throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED");
      const base = ownerValues(input);
      const owned = await client.query(
        `SELECT * FROM ai_generation_assets
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
           AND visual_group_key=$5 AND slot_key=$6 AND expected_status_version=$7
           AND attempt_identity_hash=$8 AND generation_size=$10 AND attempt_no=$11
           AND lease_token=$12 AND status='GENERATING' AND lease_expires_at > NOW()
           AND (final_input_bound_at IS NULL OR input_hash=$9)
         FOR UPDATE`, base,
      );
      const row = fromRow(owned.rows?.[0]);
      if (owned.rowCount !== 1 || !row) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED");
      if (row.finalInputBoundAt !== null) {
        if (row.inputHash !== input.inputHash) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT");
        return { status: "BOUND", inputHash: row.inputHash };
      }
      const conflict = await client.query(
        `SELECT * FROM ai_generation_assets
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4
           AND visual_group_key=$5 AND slot_key=$6 AND expected_status_version=$7
           AND input_hash=$8 AND generation_size=$9 AND id<>$10 AND (status='ACCEPTED'
             OR (status='GENERATING' AND final_input_bound_at IS NOT NULL))
         FOR UPDATE`, [...scopeValues(input), input.inputHash, input.generationSize, row.id],
      );
      if (conflict.rowCount) {
        if (conflict.rowCount !== 1) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT");
        let acceptedRecord = null;
        if (conflict.rows[0].status === "ACCEPTED") {
          acceptedRecord = fromRow(conflict.rows[0]);
          if (!acceptedRecordValid(acceptedRecord)) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT");
        }
        const ended = await client.query(
          `UPDATE ai_generation_assets SET status='FAILED',lease_token=NULL,lease_expires_at=NULL,
             error_code=$2,error_retryable=$3,updated_at=NOW()
           WHERE id=$1 AND status='GENERATING' AND lease_token=$4 AND lease_expires_at > NOW()`,
          [row.id, conflict.rows[0].status === "ACCEPTED" ? "AUTO_LISTING_IMAGE_FINAL_INPUT_REUSED" : "AUTO_LISTING_IMAGE_FINAL_INPUT_VERSION_CONFLICT",
            conflict.rows[0].status !== "ACCEPTED", input.leaseToken],
        );
        if (ended.rowCount !== 1) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED");
        if (conflict.rows[0].status === "ACCEPTED") {
          return { status: "EXISTING_ACCEPTED", record: publicRecord(acceptedRecord) };
        }
        return { status: "VERSION_CONFLICT" };
      }
      const bound = await client.query(
        `UPDATE ai_generation_assets AS attempt
         SET input_hash=$9,final_input_bound_at=NOW(),updated_at=NOW()
         FROM auto_listing_job_items AS item
         WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3 AND attempt.plan_id=$4
           AND attempt.visual_group_key=$5 AND attempt.slot_key=$6 AND attempt.expected_status_version=$7
           AND attempt.attempt_identity_hash=$8 AND attempt.generation_size=$10 AND attempt.attempt_no=$11
           AND attempt.lease_token=$12 AND attempt.status='GENERATING' AND attempt.lease_expires_at > NOW()
           AND attempt.input_hash=attempt.attempt_identity_hash AND attempt.final_input_bound_at IS NULL
           AND item.account_id=attempt.account_id AND item.job_id=attempt.job_id AND item.id=attempt.item_id
           AND item.status='GENERATING' AND item.status_version=attempt.expected_status_version
           AND item.active_content_plan_id=attempt.plan_id
         RETURNING attempt.*`, base,
      );
      const record = fromRow(bound.rows?.[0]);
      if (bound.rowCount !== 1 || record?.inputHash !== input.inputHash || record.finalInputBoundAt === null) {
        throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED");
      }
      return { status: "BOUND", inputHash: record.inputHash };
    });
  }

  async function transition(rawInput, kind) {
    let input;
    if (kind === "STORE") input = validateStored(rawInput);
    else if (kind === "COMPLETE") input = validateComplete(rawInput);
    else if (kind === "REJECT") input = validateReject(rawInput);
    else input = validateFail(rawInput);
    const base = ownerValues(input);
    let statement; let parameters;
    if (kind === "STORE") {
      statement = `UPDATE ai_generation_assets AS attempt
        SET object_key_version=$13,object_key=$14,content_hash=$15,content_type=$16,
            width=$17,height=$18,size_bytes=$19,updated_at=NOW()
        FROM auto_listing_job_items AS item
        WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3 AND attempt.plan_id=$4
          AND attempt.visual_group_key=$5 AND attempt.slot_key=$6 AND attempt.expected_status_version=$7
          AND attempt.attempt_identity_hash=$8 AND attempt.input_hash=$9 AND attempt.generation_size=$10
          AND attempt.attempt_no=$11 AND attempt.lease_token=$12 AND attempt.status='GENERATING'
          AND attempt.final_input_bound_at IS NOT NULL AND attempt.lease_expires_at > NOW()
          AND ((attempt.object_key_version IS NULL AND attempt.object_key IS NULL
            AND attempt.content_hash IS NULL AND attempt.content_type IS NULL
            AND attempt.width IS NULL AND attempt.height IS NULL AND attempt.size_bytes IS NULL)
            OR (attempt.object_key_version=$13 AND attempt.object_key=$14
              AND attempt.content_hash=$15 AND attempt.content_type=$16 AND attempt.width=$17
              AND attempt.height=$18 AND attempt.size_bytes=$19))
          AND item.account_id=attempt.account_id AND item.job_id=attempt.job_id AND item.id=attempt.item_id
          AND item.status='GENERATING' AND item.status_version=attempt.expected_status_version
          AND item.active_content_plan_id=attempt.plan_id
        RETURNING attempt.*`;
      parameters = [...base, ...STORED_KEYS.map((key) => input[key])];
    } else if (kind === "COMPLETE") {
      statement = `UPDATE ai_generation_assets AS attempt
        SET status='ACCEPTED',lease_token=NULL,lease_expires_at=NULL,accepted_at=NOW(),updated_at=NOW(),
            role=$13,object_key_version=$14,object_key=$15,content_hash=$16,content_type=$17,
            width=$18,height=$19,size_bytes=$20,checker_result=$21::JSONB,gateway_request_id=$22,
            checker_request_id=$23,model_evidence=$24::JSONB,profile_id=$25,profile_version=$26,
            model_name=$27,prompt_hash=$28,plan_hash=$29,source_hash=$30,strategy_hash=$31,
            config_hash=$32,visual_groups_hash=$33,prompt_template_version=$34,
            source_asset_evidence=$35::JSONB,regeneration=$36::JSONB,error_code=NULL,error_retryable=NULL
        FROM auto_listing_job_items AS item,ai_content_plans AS plan,ai_gateway_profiles AS profile
        WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3 AND attempt.plan_id=$4
          AND attempt.visual_group_key=$5 AND attempt.slot_key=$6 AND attempt.expected_status_version=$7
          AND attempt.attempt_identity_hash=$8 AND attempt.input_hash=$9 AND attempt.generation_size=$10
          AND attempt.attempt_no=$11 AND attempt.lease_token=$12 AND attempt.status='GENERATING'
          AND attempt.final_input_bound_at IS NOT NULL AND attempt.lease_expires_at > NOW()
          AND attempt.object_key_version=$14 AND attempt.object_key=$15
          AND attempt.content_hash=$16 AND attempt.content_type=$17 AND attempt.width=$18
          AND attempt.height=$19 AND attempt.size_bytes=$20
          AND item.account_id=attempt.account_id AND item.job_id=attempt.job_id AND item.id=attempt.item_id
          AND item.status='GENERATING' AND item.status_version=attempt.expected_status_version
          AND item.active_content_plan_id=attempt.plan_id
          AND plan.account_id=attempt.account_id AND plan.job_id=attempt.job_id AND plan.item_id=attempt.item_id
          AND plan.id=attempt.plan_id AND plan.profile_id=$25 AND plan.profile_version=$26
          AND plan.plan_hash=$29 AND plan.source_hash=$30 AND plan.strategy_hash=$31 AND plan.config_hash=$32
          AND plan.visual_groups_hash=$33 AND plan.prompt_template_version=$34
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(plan.plan->'slots') AS slots(slot)
            WHERE slot->>'visualGroupKey'=attempt.visual_group_key AND slot->>'slotKey'=attempt.slot_key
              AND slot->>'role'=$13)
          AND profile.account_id=plan.account_id AND profile.id=plan.profile_id
          AND profile.config_version=plan.profile_version AND profile.image_model=$27
        RETURNING attempt.*`;
      parameters = [...base, input.role, ...STORED_KEYS.map((key) => input[key]), JSON.stringify(input.checkerEvidence),
        input.gatewayRequestId, input.checkerRequestId, JSON.stringify(input.modelEvidence), input.profileId,
        input.profileVersion, input.modelName, input.promptHash, input.planHash, input.sourceHash, input.strategyHash,
        input.configHash, input.visualGroupsHash, input.promptTemplateVersion, JSON.stringify(input.sourceAssetEvidence),
        input.regeneration === null ? null : JSON.stringify(input.regeneration)];
    } else if (kind === "REJECT") {
      statement = `UPDATE ai_generation_assets AS attempt
        SET status='REJECTED',lease_token=NULL,lease_expires_at=NULL,updated_at=NOW(),role=$13,
            object_key_version=$14,object_key=$15,content_hash=$16,content_type=$17,width=$18,height=$19,
            size_bytes=$20,error_code=$21,error_retryable=$22,checker_result=$23::JSONB,
            gateway_request_id=$24,checker_request_id=$25,model_evidence=$26::JSONB
        FROM auto_listing_job_items AS item,ai_content_plans AS plan
        WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3 AND attempt.plan_id=$4
          AND attempt.visual_group_key=$5 AND attempt.slot_key=$6 AND attempt.expected_status_version=$7
          AND attempt.attempt_identity_hash=$8 AND attempt.input_hash=$9 AND attempt.generation_size=$10
          AND attempt.attempt_no=$11 AND attempt.lease_token=$12 AND attempt.status='GENERATING'
          AND attempt.final_input_bound_at IS NOT NULL AND attempt.lease_expires_at > NOW()
          AND attempt.object_key_version=$14 AND attempt.object_key=$15
          AND attempt.content_hash=$16 AND attempt.content_type=$17 AND attempt.width=$18
          AND attempt.height=$19 AND attempt.size_bytes=$20
          AND item.account_id=attempt.account_id AND item.job_id=attempt.job_id AND item.id=attempt.item_id
          AND item.status='GENERATING' AND item.status_version=attempt.expected_status_version
          AND item.active_content_plan_id=attempt.plan_id
          AND plan.account_id=attempt.account_id AND plan.job_id=attempt.job_id AND plan.item_id=attempt.item_id
          AND plan.id=attempt.plan_id AND EXISTS (SELECT 1 FROM jsonb_array_elements(plan.plan->'slots') AS slots(slot)
            WHERE slot->>'visualGroupKey'=attempt.visual_group_key AND slot->>'slotKey'=attempt.slot_key
              AND slot->>'role'=$13)
        RETURNING attempt.*`;
      parameters = [...base, input.role, ...STORED_KEYS.map((key) => input[key]), input.code, input.retryable,
        JSON.stringify(input.checkerEvidence), input.gatewayRequestId, input.checkerRequestId, JSON.stringify(input.modelEvidence)];
    } else {
      statement = `UPDATE ai_generation_assets AS attempt
        SET status='FAILED',lease_token=NULL,lease_expires_at=NULL,updated_at=NOW(),role=$13,
            error_code=$14,error_retryable=$15,gateway_request_id=COALESCE($16::TEXT,attempt.gateway_request_id),
            checker_request_id=COALESCE($17::TEXT,attempt.checker_request_id)
        FROM auto_listing_job_items AS item,ai_content_plans AS plan
        WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3 AND attempt.plan_id=$4
          AND attempt.visual_group_key=$5 AND attempt.slot_key=$6 AND attempt.expected_status_version=$7
          AND attempt.attempt_identity_hash=$8 AND attempt.input_hash=$9 AND attempt.generation_size=$10
          AND attempt.attempt_no=$11 AND attempt.lease_token=$12 AND attempt.status='GENERATING'
          AND attempt.lease_expires_at > NOW()
          AND item.account_id=attempt.account_id AND item.job_id=attempt.job_id AND item.id=attempt.item_id
          AND item.status='GENERATING' AND item.status_version=attempt.expected_status_version
          AND item.active_content_plan_id=attempt.plan_id
          AND plan.account_id=attempt.account_id AND plan.job_id=attempt.job_id AND plan.item_id=attempt.item_id
          AND plan.id=attempt.plan_id AND EXISTS (SELECT 1 FROM jsonb_array_elements(plan.plan->'slots') AS slots(slot)
            WHERE slot->>'visualGroupKey'=attempt.visual_group_key AND slot->>'slotKey'=attempt.slot_key
              AND slot->>'role'=$13)
        RETURNING attempt.*`;
      parameters = [...base, input.role, input.code, input.retryable, input.gatewayRequestId, input.checkerRequestId];
    }
    const result = await query(statement, parameters);
    const record = fromRow(result.rows?.[0]);
    if (result.rowCount !== 1 || !record) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED");
    if (kind === "STORE" && !validStoredEvidence(record)) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT");
    if (kind === "COMPLETE" && !acceptedRecordValid(record)) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT");
    if (kind === "REJECT" && record.status !== "REJECTED") throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT");
    if (kind === "FAIL" && record.status !== "FAILED") throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT");
    return publicRecord(record);
  }

  return Object.freeze({
    reserveGenerationAttempt,
    bindGenerationAttemptInput,
    recordStoredGenerationAsset: (input) => transition(input, "STORE"),
    completeGenerationAttempt: (input) => transition(input, "COMPLETE"),
    rejectGenerationAttempt: (input) => transition(input, "REJECT"),
    failGenerationAttempt: (input) => transition(input, "FAIL"),
    async releaseGenerationLease(rawInput) {
      const input = validateOwner(rawInput, RELEASE_KEYS);
      if (!ERROR_CODE.test(input.errorCode || "")) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
      const result = await query(
        `UPDATE ai_generation_assets AS attempt
         SET status='FAILED',lease_token=NULL,lease_expires_at=NULL,updated_at=NOW(),
             error_code=$13,error_retryable=TRUE
         FROM auto_listing_job_items AS item
         WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3 AND attempt.plan_id=$4
           AND attempt.visual_group_key=$5 AND attempt.slot_key=$6 AND attempt.expected_status_version=$7
           AND attempt.attempt_identity_hash=$8 AND attempt.input_hash=$9 AND attempt.generation_size=$10
           AND attempt.attempt_no=$11 AND attempt.lease_token=$12 AND attempt.status='GENERATING'
           AND attempt.lease_expires_at > NOW()
           AND item.account_id=attempt.account_id AND item.job_id=attempt.job_id AND item.id=attempt.item_id
           AND item.status='GENERATING' AND item.status_version=attempt.expected_status_version
           AND item.active_content_plan_id=attempt.plan_id
         RETURNING attempt.*`, [...ownerValues(input), input.errorCode],
      );
      const record = fromRow(result.rows?.[0]);
      if (result.rowCount !== 1 || record?.status !== "FAILED") {
        throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED");
      }
      return publicRecord(record);
    },
    async findStoredGenerationAsset(rawInput) {
      const input = validateOwner(rawInput, FIND_KEYS);
      if (!HASH.test(input.contentHash || "")) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
      const result = await query(
        `SELECT attempt.* FROM ai_generation_assets AS attempt
         JOIN auto_listing_job_items AS item
           ON item.account_id=attempt.account_id AND item.job_id=attempt.job_id AND item.id=attempt.item_id
         WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3 AND attempt.plan_id=$4
           AND attempt.visual_group_key=$5 AND attempt.slot_key=$6 AND attempt.expected_status_version=$7
           AND attempt.attempt_identity_hash=$8 AND attempt.input_hash=$9 AND attempt.generation_size=$10
           AND attempt.attempt_no=$11 AND attempt.lease_token=$12 AND attempt.status='GENERATING'
           AND attempt.lease_expires_at > NOW() AND attempt.final_input_bound_at IS NOT NULL
           AND attempt.content_hash=$13 AND attempt.object_key_version='ATTEMPT_V2'
           AND item.status='GENERATING' AND item.status_version=attempt.expected_status_version
           AND item.active_content_plan_id=attempt.plan_id`, [...ownerValues(input), input.contentHash],
      );
      if (!result.rowCount) return null;
      const record = fromRow(result.rows[0]);
      if (result.rowCount !== 1 || !validStoredEvidence(record)) throw failure("AUTO_LISTING_IMAGE_ATTEMPT_CONFLICT");
      return publicRecord(record);
    },
  });
}

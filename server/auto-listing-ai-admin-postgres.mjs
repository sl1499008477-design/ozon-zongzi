import crypto from "node:crypto";
import { types } from "node:util";

import {
  projectCategoryStrategyGuidanceV2,
  projectRussianCategoryStrategyGuidanceV2,
} from "./auto-listing-category-strategy-contract.mjs";

const FACTORY_KEYS = new Set(["pool"]);
const CATEGORY_STRATEGY_PUBLISH_KEYS = new Set([
  "accountId", "actorId", "draftId", "expectedDraftVersion",
  "expectedPublishedStrategyVersionId", "idempotencyKey", "correlationId",
]);
const CATEGORY_STRATEGY_ROLLBACK_KEYS = new Set([
  "accountId", "actorId", "targetStrategyVersionId",
  "expectedPublishedStrategyVersionId", "idempotencyKey", "correlationId",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITY_AUTHORIZATION_SCHEMA = "AI_GATEWAY_CAPABILITY_AUTHORIZATION_V1";
const CAPABILITY_AUTHORIZATION_ACTION = "AUTO_LISTING_AI_PROFILE_CAPABILITY_AUTHORIZED";
const CAPABILITY_SUBCALL_TERMINAL_ACTION = "AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_TERMINATED";
const CATEGORY_STRATEGY_PUBLISH_ACTION = "AUTO_LISTING_CATEGORY_STRATEGY_PUBLISH";
const CATEGORY_STRATEGY_ROLLBACK_ACTION = "AUTO_LISTING_CATEGORY_STRATEGY_ROLLBACK";
const CAPABILITY_SUBCALL_COMPLETION_REASONS = new Map([
  ["PRE_SEND_ABORTED", "FAILED"],
  ["PRE_SEND_FAILED", "FAILED"],
  ["PROVIDER_REJECTED", "FAILED"],
  ["PROVIDER_ACCEPTED", "SUCCEEDED"],
]);
const CAPABILITY_EXECUTION_KEYS = new Set([
  "accountId", "profileId", "configVersion", "attemptId", "correlationId", "fence", "leaseVersion", "leaseToken",
  "purpose", "authorizationHash", "requestKey", "connectionId", "connectionVersion",
  "expectedConnectionStatus", "expectedConnectionStatusVersion", "probe",
]);
const CAPABILITY_FEATURES = new Set([
  "STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG", "IMAGE_DECODE_JPEG", "IMAGE_DECODE_WEBP",
]);
const CAPABILITY_ERROR_CODES = new Set([
  "AI_GATEWAY_PROFILE_INVALID", "AI_GATEWAY_PROFILE_DISABLED", "AI_GATEWAY_REQUEST_INVALID",
  "AI_GATEWAY_SECRET_MISSING", "AI_GATEWAY_PROTOCOL_UNSUPPORTED", "AI_GATEWAY_MODEL_MISMATCH",
  "AI_GATEWAY_INPUT_UNSUPPORTED", "GATEWAY_REDIRECT_BLOCKED", "GATEWAY_TIMEOUT", "GATEWAY_CANCELLED",
  "RETRYABLE_GATEWAY", "NON_RETRYABLE_AUTH", "NON_RETRYABLE_GATEWAY", "INVALID_GATEWAY_RESPONSE",
  "AI_GATEWAY_CAPABILITY_FAILED",
]);

function repositoryError(code, status = 422, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED"
    ? "自动上架 AI 管理数据暂时不可用" : code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function invalid() {
  return repositoryError("AUTO_LISTING_AI_ADMIN_REPOSITORY_INVALID");
}

function databaseFailed() {
  return repositoryError("AUTO_LISTING_AI_ADMIN_DATABASE_FAILED", 503, true);
}

function closedFactory(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw invalid();
    const keys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (keys.length !== FACTORY_KEYS.size || keys.some((key) => typeof key !== "string" || !FACTORY_KEYS.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    return { pool: descriptors.pool.value };
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_ADMIN_REPOSITORY_INVALID") throw error;
    throw invalid();
  }
}

function closedCategoryStrategyCommand(raw, keys) {
  try {
    if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw invalid();
    const ownKeys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    return Object.fromEntries(ownKeys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_ADMIN_REPOSITORY_INVALID") throw error;
    throw invalid();
  }
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw invalid();
  return result;
}

function version(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_646) throw invalid();
  return value;
}

function sha256(value) {
  if (typeof value !== "string" || !SHA256.test(value)) throw invalid();
  return value;
}

function sameActor(input) {
  const accountId = id(input?.accountId);
  if (id(input?.actorId) !== accountId) throw invalid();
  return accountId;
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw invalid();
    return [key, canonical(value[key])];
  }));
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function deterministicId(prefix, ...values) {
  return `${prefix}_${crypto.createHash("sha256").update(values.join("\0"), "utf8").digest("hex").slice(0, 40)}`;
}

function activationFromAuditRow(row) {
  const action = row?.activation_action ?? row?.action ?? null;
  const rawOccurredAt = row?.activation_occurred_at ?? row?.occurred_at ?? null;
  const actorId = row?.activation_actor_id ?? row?.actor_id ?? null;
  if (action === null && rawOccurredAt === null && actorId === null) return null;
  if (!["AUTO_LISTING_AI_PROFILE_PUBLISH", "AUTO_LISTING_AI_PROFILE_ROLLBACK"].includes(action)) return null;
  const occurredAt = rawOccurredAt instanceof Date ? rawOccurredAt.toISOString() : rawOccurredAt;
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))
    || typeof actorId !== "string" || !SAFE_ID.test(actorId)) throw invalid();
  return {
    kind: action === "AUTO_LISTING_AI_PROFILE_PUBLISH" ? "PUBLISH" : "ROLLBACK",
    occurredAt: new Date(occurredAt).toISOString(),
    actorId,
  };
}

function profileRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    displayName: row.display_name,
    configVersion: Number(row.config_version),
    baseUrl: row.base_url,
    apiKeyEnvName: row.api_key_env_name,
    textProtocol: row.text_protocol,
    imageProtocol: row.image_protocol,
    textModel: row.text_model,
    imageModel: row.image_model,
    enabled: row.enabled === true,
    capabilityResult: row.capability_result || {},
    capabilityCheckedAt: row.capability_checked_at instanceof Date
      ? row.capability_checked_at.toISOString() : row.capability_checked_at ?? null,
    connectionId: row.connection_id ?? null,
    connectionVersion: row.connection_version == null ? null : Number(row.connection_version),
    activation: activationFromAuditRow(row),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
  };
}

function capabilitySecretRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    version: Number(row.version),
    displayName: row.display_name,
    baseUrl: row.base_url,
    status: row.status,
    encryptedSecret: {
      algorithm: row.algorithm,
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
      fingerprint: row.fingerprint,
    },
  };
}

function capabilityExecutionSecretRow(row) {
  if (!row) return null;
  const connectionId = row.connection_id ?? null;
  const result = {
    accountId: row.account_id,
    profileId: row.profile_id,
    configVersion: Number(row.config_version),
    apiKeyEnvName: row.api_key_env_name,
    connection: null,
  };
  if (connectionId !== null) {
    result.connection = {
      id: connectionId,
      accountId: row.account_id,
      version: Number(row.connection_version),
      status: row.connection_status,
      statusVersion: Number(row.connection_status_version),
      encryptedSecret: {
        algorithm: row.algorithm,
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        keyVersion: row.key_version,
        fingerprint: row.fingerprint,
      },
    };
  }
  return result;
}

function strategyRow(row, rules) {
  if (!row) return null;
  const result = {
    id: row.id,
    accountId: row.account_id,
    strategyKey: row.strategy_key,
    version: Number(row.version),
    status: row.status,
    content: row.content,
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at ?? null,
  };
  const hydratedRules = rules ?? row.rules;
  if (hydratedRules) result.rules = hydratedRules;
  return result;
}

async function query(target, sql, params = []) {
  try {
    return await target.query(sql, params);
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_AI_ADMIN_")) throw error;
    throw databaseFailed();
  }
}

async function lockAccount(client, accountId) {
  const result = await query(client, "SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [accountId]);
  if (!result?.rows?.[0]) throw repositoryError("AUTO_LISTING_AI_ADMIN_SCOPE_NOT_FOUND", 404);
}

async function requireCategoryStrategyMutationEnabled(client, accountId) {
  const result = await query(client,
    `SELECT mode FROM auto_listing_category_strategy_account_settings
      WHERE account_id=$1 FOR UPDATE`,
    [accountId]);
  if (result.rows[0]?.mode !== "REQUIRE_EXACT_STRATEGY") {
    throw repositoryError("AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY", 409);
  }
}

function auditIdentity(action, accountId, idempotencyKey) {
  return deterministicId("audit_ai_admin", action, accountId, idempotencyKey);
}

async function loadAudit(client, { action, accountId, idempotencyKey, requestHash }) {
  const eventId = auditIdentity(action, accountId, idempotencyKey);
  const result = await query(client,
    `SELECT metadata,occurred_at,actor_id,action,$3::TEXT AS expected_request_hash
       FROM audit_events
      WHERE event_id=$1 AND account_id=$2 AND action=$4
      FOR UPDATE`,
    [eventId, accountId, requestHash, action]);
  const metadata = result?.rows?.[0]?.metadata;
  if (!metadata) return { eventId, metadata: null, activation: null };
  if (metadata.requestHash !== requestHash) throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
  return { eventId, metadata, activation: activationFromAuditRow(result.rows[0]) };
}

async function requireCategoryStrategyCommandLedger(client, {
  action, accountId, idempotencyKey, requestHash,
}) {
  const categoryEvents = await query(client,
    `SELECT CASE
       WHEN event_type='PUBLISHED' THEN '${CATEGORY_STRATEGY_PUBLISH_ACTION}'
       WHEN event_type='ACCOUNT_SETTINGS_CHANGED' THEN 'TRANSITION_ACCOUNT_POLICY'
       WHEN event_payload->>'event'='DRAFT_CREATED' THEN 'CREATE_DRAFT'
       WHEN event_payload->>'event'='SAMPLING_SESSION_STARTED' THEN 'START_SAMPLING_SESSION'
       WHEN event_payload->>'event'='SAMPLE_SET_COMMITTED' THEN 'COMMIT_SAMPLE_SET'
       ELSE 'UNKNOWN'
     END AS action,request_hash
       FROM auto_listing_category_strategy_events
      WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
    [accountId, idempotencyKey]);
  const auditIds = [
    auditIdentity(CATEGORY_STRATEGY_PUBLISH_ACTION, accountId, idempotencyKey),
    auditIdentity(CATEGORY_STRATEGY_ROLLBACK_ACTION, accountId, idempotencyKey),
  ];
  const adminAudits = await query(client,
    `SELECT action,metadata->>'requestHash' AS request_hash
       FROM audit_events
      WHERE account_id=$1 AND event_id=ANY($2::TEXT[]) FOR UPDATE`,
    [accountId, auditIds]);
  const entries = [...categoryEvents.rows, ...adminAudits.rows];
  if (entries.some((entry) => entry.action !== action || entry.request_hash !== requestHash)) {
    throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
  }
}

async function insertAudit(client, {
  eventId, action, accountId, actorId, correlationId, entityType, entityId, metadata,
  status = "SUCCESS", actorType = "account",
}) {
  if (!["account", "system"].includes(actorType)) throw invalid();
  const result = await query(client,
    `INSERT INTO audit_events (
       event_id,account_id,store_id,action,status,actor_type,actor_id,device_id,source,
       entity_type,entity_id,correlation_id,metadata,occurred_at,created_at
     ) VALUES ($1,$2,NULL,$3,$9,$10,$4,'','auto-listing-ai-admin',$5,$6,$7,$8::JSONB,NOW(),NOW())
     ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
     RETURNING event_id,action,actor_id,occurred_at`,
    [eventId, accountId, action, actorId, entityType, entityId, correlationId,
      JSON.stringify(metadata), status, actorType]);
  if (result?.rowCount !== 1) throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
  return result.rows[0];
}

async function insertConnectionEvent(client, {
  accountId, connectionId, connectionVersion, eventType, statusVersion, actorId, correlationId, payload = {},
}) {
  const eventId = deterministicId("aigconn_event", accountId, connectionId,
    String(connectionVersion), String(statusVersion));
  await query(client,
    `INSERT INTO ai_gateway_connection_events (
       account_id,id,connection_id,connection_version,event_type,status_version,
       actor_id,correlation_id,payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::JSONB)`,
    [accountId, eventId, connectionId, connectionVersion, eventType, statusVersion,
      actorId, correlationId, JSON.stringify(payload)]);
}

async function insertConnectionAudit(client, {
  action, accountId, actorId, correlationId, connectionId, connectionVersion,
  statusVersion, idempotencyKey, requestHash, metadata = {},
}) {
  await insertAudit(client, {
    eventId: auditIdentity(action, accountId, idempotencyKey), action, accountId, actorId,
    correlationId, entityType: "ai_gateway_connection_version", entityId: connectionId,
    metadata: { requestHash, connectionVersion, statusVersion, ...metadata },
  });
}

async function transaction(pool, operation) {
  let client;
  try {
    client = await pool.connect();
  } catch {
    throw databaseFailed();
  }
  let committed = false;
  try {
    await query(client, "BEGIN");
    const result = await operation(client);
    await query(client, "COMMIT");
    committed = true;
    return result;
  } catch (error) {
    if (!committed) await query(client, "ROLLBACK").catch(() => {});
    throw error;
  } finally {
    try { client.release(); } catch { /* best effort */ }
  }
}

function profileRequest(input) {
  const accountId = sameActor(input);
  const profile = canonical(input.profile);
  if (profile.configVersion !== 1) throw invalid();
  return {
    accountId,
    actorId: accountId,
    idempotencyKey: id(input.idempotencyKey),
    correlationId: id(input.correlationId),
    profile,
  };
}

function profilePublishRequest(input) {
  const accountId = sameActor(input);
  return {
    accountId,
    actorId: accountId,
    profileId: id(input.profileId),
    configVersion: version(input.configVersion),
    idempotencyKey: id(input.idempotencyKey),
    correlationId: id(input.correlationId),
  };
}

function capabilityPassed(row) {
  const capability = row?.capability_result;
  const features = Array.isArray(capability?.features) ? capability.features : [];
  const checkedAt = capability?.checkedAt;
  const storedCheckedAt = row?.capability_checked_at instanceof Date
    ? row.capability_checked_at.toISOString() : String(row?.capability_checked_at || "");
  return capability?.outcome === "PASSED"
    && features.includes("STRUCTURED_TEXT") && features.includes("IMAGE_GENERATION")
    && capability?.models?.text === row.text_model && capability?.models?.image === row.image_model
    && typeof checkedAt === "string" && checkedAt === storedCheckedAt;
}

async function requireActiveSuccessorCapabilityFence(target, profile) {
  const result = await query(target,
    `SELECT current.id AS active_profile_id,binding.catalog_id
       FROM ai_gateway_profiles successor
       JOIN ai_gateway_profile_binding_events binding
         ON binding.account_id=successor.account_id AND binding.profile_id=successor.id
        AND binding.config_version=successor.config_version
        AND binding.connection_id=successor.connection_id
        AND binding.connection_version=successor.connection_version
       JOIN ai_gateway_profiles current
         ON current.account_id=successor.account_id AND current.enabled IS TRUE
        AND current.connection_id=successor.connection_id
        AND current.connection_version=successor.connection_version
        AND (current.id<>successor.id OR current.config_version<>successor.config_version)
      WHERE successor.account_id=$1 AND successor.id=$2 AND successor.config_version=$3
        AND successor.connection_id=$4 AND successor.connection_version=$5
        AND successor.enabled IS FALSE
        AND binding.catalog_id=(
          SELECT catalog.id
            FROM ai_gateway_model_catalogs catalog
            JOIN ai_gateway_model_sync_tasks task
              ON task.account_id=catalog.account_id AND task.id=catalog.sync_task_id
             AND task.connection_id=catalog.connection_id
             AND task.connection_version=catalog.connection_version
           WHERE catalog.account_id=successor.account_id
             AND catalog.connection_id=successor.connection_id
             AND catalog.connection_version=successor.connection_version
             AND task.status='SUCCEEDED' AND task.sync_purpose='CATALOG_SYNC'
           ORDER BY catalog.created_at DESC,catalog.id DESC
           LIMIT 1)
      FOR UPDATE OF successor,current`,
    [profile.accountId, profile.id, profile.configVersion,
      profile.connectionId, profile.connectionVersion]);
  if (result.rows.length > 1) {
    throw repositoryError("AUTO_LISTING_AI_PROFILE_AMBIGUOUS", 409);
  }
  if (!result.rows[0]) {
    throw repositoryError("AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED", 409);
  }
  return result.rows[0];
}

function capabilityBeginRequest(input) {
  const accountId = sameActor(input);
  const purpose = input.purpose === undefined ? "PROFILE_CAPABILITY" : id(input.purpose);
  if (!["PROFILE_CAPABILITY", "ROLLBACK_CAPABILITY"].includes(purpose)
    || input.costConfirmed !== true) throw invalid();
  return {
    accountId,
    actorId: accountId,
    profileId: id(input.profileId),
    configVersion: version(input.configVersion),
    correlationId: id(input.correlationId),
    attemptId: id(input.attemptId),
    requestKey: sha256(input.requestKey),
    purpose,
    costConfirmed: true,
  };
}

function capabilityResult(value) {
  const result = canonical(value);
  const keys = ["outcome", "features", "latencyMs", "models", "checkedAt", "errorCode"];
  if (!result || Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))
    || !["PASSED", "FAILED"].includes(result.outcome)
    || !result.models || typeof result.models.text !== "string" || !result.models.text
    || typeof result.models.image !== "string" || !result.models.image
    || typeof result.checkedAt !== "string" || Number.isNaN(Date.parse(result.checkedAt))) throw invalid();
  if (result.outcome === "PASSED") {
    if (!Array.isArray(result.features) || result.features.length !== 3
      || !result.features.every((feature) => CAPABILITY_FEATURES.has(feature))
      || !result.features.includes("STRUCTURED_TEXT") || !result.features.includes("IMAGE_GENERATION")
      || !result.features.some((feature) => feature.startsWith("IMAGE_DECODE_"))
      || !Number.isFinite(result.latencyMs) || result.latencyMs < 0 || result.errorCode !== null) throw invalid();
  } else if (!Array.isArray(result.features) || result.features.length !== 0 || result.latencyMs !== null
    || !CAPABILITY_ERROR_CODES.has(result.errorCode)) throw invalid();
  return result;
}

function capabilityCompleteRequest(input) {
  const begin = capabilityBeginRequest(input);
  const fence = Number(input.fence);
  const leaseVersion = Number(input.leaseVersion);
  if (!Number.isSafeInteger(fence) || fence < 1 || !Number.isSafeInteger(leaseVersion) || leaseVersion < 1) throw invalid();
  return { ...begin, fence, leaseVersion, leaseToken: id(input.leaseToken),
    capabilityResult: capabilityResult(input.capabilityResult) };
}

async function requireConnectionCapabilityFence(client, profile, purpose) {
  if (profile.connectionId === null) {
    if (purpose !== "PROFILE_CAPABILITY") {
      throw repositoryError("AUTO_LISTING_AI_PROFILE_ROLLBACK_NOT_READY", 409);
    }
    return { id: null, version: null, status: "LEGACY", status_version: 0, retired_at: null };
  }
  const result = await query(client,
    `SELECT c.id,c.version,c.status,c.status_version,c.retired_at,latest.id AS catalog_id
       FROM ai_gateway_connection_versions c
       JOIN LATERAL (
         SELECT catalog.id,catalog.catalog
           FROM ai_gateway_model_catalogs catalog
           JOIN ai_gateway_model_sync_tasks task
             ON task.account_id=catalog.account_id AND task.id=catalog.sync_task_id
            AND task.connection_id=catalog.connection_id
            AND task.connection_version=catalog.connection_version
          WHERE catalog.account_id=c.account_id
            AND catalog.connection_id=c.id AND catalog.connection_version=c.version
            AND task.status='SUCCEEDED' AND task.sync_purpose='CATALOG_SYNC'
          ORDER BY catalog.created_at DESC,catalog.id DESC
          LIMIT 1
       ) latest ON TRUE
      WHERE c.account_id=$1 AND c.id=$2 AND c.version=$3
        AND (($6='ROLLBACK_CAPABILITY' AND c.status='RETIRED')
          OR ($6='PROFILE_CAPABILITY' AND c.status IN ('VALIDATED','ACTIVE')))
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(latest.catalog->'models') model
                    WHERE model->>'id'=$4)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(latest.catalog->'models') model
                    WHERE model->>'id'=$5)
      FOR UPDATE OF c`,
    [profile.accountId, profile.connectionId, profile.connectionVersion,
      profile.textModel, profile.imageModel, purpose]);
  if (!result?.rows?.[0]) {
    throw repositoryError(purpose === "ROLLBACK_CAPABILITY"
      ? "AUTO_LISTING_AI_PROFILE_ROLLBACK_NOT_READY"
      : "AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED", 409);
  }
  if (purpose === "PROFILE_CAPABILITY" && result.rows[0].status === "ACTIVE") {
    await requireActiveSuccessorCapabilityFence(client, profile);
  }
  return result.rows[0];
}

function capabilityAuthorization(input, connectionFence) {
  const evidence = {
    schemaVersion: CAPABILITY_AUTHORIZATION_SCHEMA,
    accountId: input.accountId,
    actorId: input.actorId,
    profileId: input.profileId,
    configVersion: input.configVersion,
    attemptId: input.attemptId,
    correlationId: input.correlationId,
    purpose: input.purpose,
    costConfirmed: true,
    requestKey: input.requestKey,
    targetConnectionId: connectionFence.id ?? null,
    targetConnectionVersion: connectionFence.version == null ? null : Number(connectionFence.version),
    targetConnectionStatus: connectionFence.status,
    targetConnectionStatusVersion: Number(connectionFence.status_version),
  };
  return Object.freeze({ ...evidence, authorizationHash: hash(evidence) });
}

function capabilityExecutionFromAttempt(row) {
  if (!row || row.authorization_schema_version !== CAPABILITY_AUTHORIZATION_SCHEMA
    || !SHA256.test(row.authorization_hash) || !SHA256.test(row.request_key)) return null;
  return Object.freeze({
    accountId: row.account_id,
    profileId: row.profile_id,
    configVersion: Number(row.config_version),
    attemptId: row.id,
    correlationId: row.correlation_id,
    fence: Number(row.fence),
    leaseVersion: Number(row.lease_version),
    leaseToken: row.lease_token,
    purpose: row.purpose,
    authorizationHash: row.authorization_hash,
    requestKey: row.request_key,
    connectionId: row.target_connection_id ?? null,
    connectionVersion: row.target_connection_version == null ? null : Number(row.target_connection_version),
    expectedConnectionStatus: row.target_connection_status,
    expectedConnectionStatusVersion: Number(row.target_connection_status_version),
  });
}

async function insertCapabilityAuthorizationAudit(client, input, attemptRow) {
  const execution = capabilityExecutionFromAttempt(attemptRow);
  if (!execution) throw databaseFailed();
  await insertAudit(client, {
    eventId: auditIdentity(CAPABILITY_AUTHORIZATION_ACTION, input.accountId,
      `${input.attemptId}:${execution.leaseVersion}`),
    action: CAPABILITY_AUTHORIZATION_ACTION,
    accountId: input.accountId,
    actorId: input.actorId,
    correlationId: input.correlationId,
    entityType: "ai_gateway_profile",
    entityId: input.profileId,
    status: "SUCCESS",
    metadata: {
      requestHash: execution.authorizationHash,
      schemaVersion: CAPABILITY_AUTHORIZATION_SCHEMA,
      attemptId: execution.attemptId,
      fence: execution.fence,
      leaseVersion: execution.leaseVersion,
      leaseTokenHash: hash(execution.leaseToken),
      requestKey: execution.requestKey,
      purpose: execution.purpose,
      costConfirmed: true,
      targetConnectionId: execution.connectionId,
      targetConnectionVersion: execution.connectionVersion,
      targetConnectionStatus: execution.expectedConnectionStatus,
      targetConnectionStatusVersion: execution.expectedConnectionStatusVersion,
      authorizationHash: execution.authorizationHash,
      authorizedAt: attemptRow.authorized_at instanceof Date
        ? attemptRow.authorized_at.toISOString() : attemptRow.authorized_at,
    },
  });
  return execution;
}

function capabilityExecutionRequest(rawInput) {
  const input = canonical(rawInput);
  const keys = input && typeof input === "object" ? Object.keys(input) : [];
  if (!input || keys.length !== CAPABILITY_EXECUTION_KEYS.size
    || keys.some((key) => !CAPABILITY_EXECUTION_KEYS.has(key))) throw invalid();
  const accountId = id(input.accountId);
  if (id(input.profileId) !== input.profileId || id(input.attemptId) !== input.attemptId
    || id(input.correlationId) !== input.correlationId
    || id(input.leaseToken) !== input.leaseToken) throw invalid();
  const connectionBacked = ["VALIDATED", "ACTIVE", "RETIRED"].includes(input.expectedConnectionStatus);
  const purpose = id(input.purpose);
  if (!["PROFILE_CAPABILITY", "ROLLBACK_CAPABILITY"].includes(purpose)
    || !["REACHABILITY", "TEXT", "IMAGE"].includes(input.probe)
    || (purpose === "PROFILE_CAPABILITY"
      && !["VALIDATED", "ACTIVE", "LEGACY"].includes(input.expectedConnectionStatus))
    || (purpose === "ROLLBACK_CAPABILITY" && input.expectedConnectionStatus !== "RETIRED")) throw invalid();
  const result = {
    accountId,
    profileId: input.profileId,
    configVersion: version(input.configVersion),
    attemptId: input.attemptId,
    correlationId: input.correlationId,
    fence: version(input.fence),
    leaseVersion: version(input.leaseVersion),
    leaseToken: input.leaseToken,
    purpose,
    authorizationHash: sha256(input.authorizationHash),
    requestKey: sha256(input.requestKey),
    connectionId: connectionBacked ? id(input.connectionId) : null,
    connectionVersion: connectionBacked ? version(input.connectionVersion) : null,
    expectedConnectionStatus: input.expectedConnectionStatus,
    expectedConnectionStatusVersion: connectionBacked ? version(input.expectedConnectionStatusVersion) : 0,
    probe: input.probe,
  };
  if (!connectionBacked && (input.connectionId !== null || input.connectionVersion !== null
    || input.expectedConnectionStatus !== "LEGACY" || input.expectedConnectionStatusVersion !== 0)) throw invalid();
  return result;
}

function capabilitySubcallProviderIdentity(execution) {
  const providerRequestKey = crypto.createHash("sha256").update(JSON.stringify({
    schemaVersion: "AI_GATEWAY_CAPABILITY_SUBCALL_V1",
    accountId: execution.accountId,
    attemptId: execution.attemptId,
    fence: execution.fence,
    requestKey: execution.requestKey,
    stage: execution.probe,
  }), "utf8").digest("hex");
  return Object.freeze({
    providerRequestKey,
    providerCorrelationId: `cap_${providerRequestKey.slice(0, 40)}`,
  });
}

function capabilitySubcallCompleteRequest(rawInput) {
  const input = canonical(rawInput);
  const outcome = input?.outcome;
  const reason = input?.reason;
  if (!input || !["SUCCEEDED", "FAILED"].includes(outcome)
    || CAPABILITY_SUBCALL_COMPLETION_REASONS.get(reason) !== outcome) throw invalid();
  const { outcome: _outcome, reason: _reason, ...executionInput } = input;
  return { ...capabilityExecutionRequest(executionInput), outcome, reason };
}

async function loadCapabilitySubcallTerminalEvidence(target, input, identity, { forUpdate = false } = {}) {
  const result = await query(target,
    `SELECT reservation.status,reservation.provider_request_key,reservation.provider_correlation_id,
            reservation.reservation_version,reservation.terminal_reason,
            EXISTS (
              SELECT 1 FROM audit_events terminal_event
               WHERE terminal_event.account_id=reservation.account_id
                 AND terminal_event.action=$7 AND terminal_event.status='SUCCESS'
                 AND terminal_event.entity_type='ai_gateway_profile'
                 AND terminal_event.entity_id=$8
                 AND terminal_event.correlation_id=$9
                 AND terminal_event.metadata->>'attemptId'=reservation.attempt_id
                 AND terminal_event.metadata->>'stage'=reservation.stage
                 AND terminal_event.metadata->>'outcome'=$10
                 AND terminal_event.metadata->>'reason'=$11
                 AND terminal_event.metadata->>'providerRequestKey'=reservation.provider_request_key
                 AND terminal_event.metadata->>'providerRequestKeyHash'=$12
                 AND terminal_event.metadata->>'providerCorrelationId'=reservation.provider_correlation_id
                 AND (terminal_event.metadata->>'reservationVersion')::INTEGER=reservation.reservation_version
            ) AS terminal_audit_matches
       FROM ai_gateway_capability_subcall_reservations reservation
      WHERE reservation.account_id=$1 AND reservation.attempt_id=$2 AND reservation.stage=$3
        AND reservation.lease_version=$4 AND reservation.provider_request_key=$5
        AND reservation.provider_correlation_id=$6
      ${forUpdate ? "FOR UPDATE OF reservation" : ""}`,
    [input.accountId, input.attemptId, input.probe, input.leaseVersion,
      identity.providerRequestKey, identity.providerCorrelationId,
      CAPABILITY_SUBCALL_TERMINAL_ACTION, input.profileId, input.correlationId,
      input.outcome, input.reason, hash(identity.providerRequestKey)]);
  const row = result.rows[0];
  return row?.status === input.outcome
    && row.terminal_reason === input.reason
    && row.provider_request_key === identity.providerRequestKey
    && row.provider_correlation_id === identity.providerCorrelationId
    && row.terminal_audit_matches === true
    ? row : null;
}

async function loadCapabilitySubcallPreparedEvidence(target, input, identity) {
  const result = await query(target,
    `SELECT attempt.id,attempt.status,attempt.account_id,attempt.profile_id,attempt.config_version,
            profile.api_key_env_name,attempt.target_connection_id AS connection_id,
            attempt.target_connection_version AS connection_version,
            connection.status AS connection_status,connection.status_version AS connection_status_version,
            connection.ciphertext,connection.iv,connection.auth_tag,connection.algorithm,
            connection.key_version,connection.fingerprint,
            reservation.status AS reservation_status,reservation.reservation_version,
            reservation.provider_request_key,reservation.provider_correlation_id,
            EXISTS (
              SELECT 1 FROM audit_events prepared_event
               WHERE prepared_event.account_id=reservation.account_id
                 AND prepared_event.action=$7 AND prepared_event.status='SUCCESS'
                 AND prepared_event.entity_type='ai_gateway_profile' AND prepared_event.entity_id=$8
                 AND prepared_event.correlation_id=$9
                 AND prepared_event.metadata->>'attemptId'=reservation.attempt_id
                 AND prepared_event.metadata->>'stage'=reservation.stage
                 AND prepared_event.metadata->>'providerRequestKey'=reservation.provider_request_key
                 AND prepared_event.metadata->>'providerRequestKeyHash'=$10
                 AND prepared_event.metadata->>'providerCorrelationId'=reservation.provider_correlation_id
                 AND (prepared_event.metadata->>'leaseVersion')::INTEGER=reservation.lease_version
                 AND (prepared_event.metadata->>'reservationVersion')::INTEGER=reservation.reservation_version
            ) AS prepared_audit_matches
       FROM ai_gateway_capability_subcall_reservations reservation
       JOIN ai_gateway_capability_attempts attempt
         ON attempt.account_id=reservation.account_id AND attempt.id=reservation.attempt_id
       JOIN ai_gateway_profiles profile
         ON profile.account_id=attempt.account_id AND profile.id=attempt.profile_id
        AND profile.config_version=attempt.config_version
       LEFT JOIN ai_gateway_connection_versions connection
         ON connection.account_id=attempt.account_id AND connection.id=attempt.target_connection_id
        AND connection.version=attempt.target_connection_version
      WHERE reservation.account_id=$1 AND reservation.attempt_id=$2 AND reservation.stage=$3
        AND reservation.lease_version=$4 AND reservation.status IN ('PREPARED','SENDING')
        AND reservation.provider_request_key=$5 AND reservation.provider_correlation_id=$6
        AND attempt.profile_id=$8 AND attempt.correlation_id=$9 AND attempt.config_version=$11
        AND attempt.fence=$12 AND attempt.lease_version=$4 AND attempt.lease_token=$13
        AND attempt.status='RUNNING' AND attempt.authorization_schema_version=$14
        AND attempt.purpose=$15 AND attempt.cost_confirmed IS TRUE
        AND attempt.authorization_hash=$16 AND attempt.request_key=$17
        AND attempt.target_connection_id IS NOT DISTINCT FROM $18
        AND attempt.target_connection_version IS NOT DISTINCT FROM $19
        AND attempt.target_connection_status=$20 AND attempt.target_connection_status_version=$21
        AND profile.connection_id IS NOT DISTINCT FROM attempt.target_connection_id
        AND profile.connection_version IS NOT DISTINCT FROM attempt.target_connection_version
        AND EXISTS (
          SELECT 1 FROM audit_events authorization_event
           WHERE authorization_event.account_id=attempt.account_id
             AND authorization_event.action=$23 AND authorization_event.status='SUCCESS'
             AND authorization_event.entity_type='ai_gateway_profile'
             AND authorization_event.entity_id=attempt.profile_id
             AND authorization_event.correlation_id=attempt.correlation_id
             AND authorization_event.metadata->>'schemaVersion'=$14
             AND authorization_event.metadata->>'attemptId'=attempt.id
             AND (authorization_event.metadata->>'fence')::BIGINT=attempt.fence
             AND (authorization_event.metadata->>'leaseVersion')::INTEGER=attempt.lease_version
             AND authorization_event.metadata->>'leaseTokenHash'=$22
             AND authorization_event.metadata->>'authorizationHash'=attempt.authorization_hash
             AND authorization_event.metadata->>'requestKey'=attempt.request_key
             AND authorization_event.metadata->>'purpose'=attempt.purpose
             AND authorization_event.metadata->'costConfirmed'='true'::JSONB
        )
        AND (($20='LEGACY' AND attempt.target_connection_id IS NULL AND connection.id IS NULL)
          OR ($20 IN ('VALIDATED','ACTIVE','RETIRED') AND connection.status=$20
            AND connection.status_version=$21))`,
    [input.accountId, input.attemptId, input.probe, input.leaseVersion,
      identity.providerRequestKey, identity.providerCorrelationId,
      "AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_RESERVED", input.profileId,
      input.correlationId, hash(identity.providerRequestKey), input.configVersion, input.fence,
      input.leaseToken, CAPABILITY_AUTHORIZATION_SCHEMA, input.purpose,
      input.authorizationHash, input.requestKey, input.connectionId, input.connectionVersion,
      input.expectedConnectionStatus, input.expectedConnectionStatusVersion, hash(input.leaseToken),
      CAPABILITY_AUTHORIZATION_ACTION]);
  const row = result.rows[0];
  const secret = capabilityExecutionSecretRow(row);
  if (secret && input.expectedConnectionStatus === "ACTIVE") {
    try {
      await requireActiveSuccessorCapabilityFence(target, {
        accountId: input.accountId, id: input.profileId, configVersion: input.configVersion,
        connectionId: input.connectionId, connectionVersion: input.connectionVersion,
      });
    } catch (error) {
      if (["AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED",
        "AUTO_LISTING_AI_PROFILE_AMBIGUOUS"].includes(error?.code)) return null;
      throw error;
    }
  }
  return secret && ["PREPARED", "SENDING"].includes(row.reservation_status)
    && row.provider_request_key === identity.providerRequestKey
    && row.provider_correlation_id === identity.providerCorrelationId
    && row.prepared_audit_matches === true
    ? { ...secret, ...identity } : null;
}

async function assertNoActivePaidReservation(client, accountId) {
  await query(client,
    "SELECT auto_listing_cleanup_expired_prepared_capability_subcalls($1) AS cleaned_count",
    [accountId]);
  const active = await query(client,
    `SELECT id FROM ai_gateway_capability_subcall_reservations
      WHERE account_id=$1 AND status IN ('PREPARED','SENDING')
      ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [accountId]);
  if (active.rows[0]) {
    throw repositoryError("AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", 409, true);
  }
}

async function quarantineLegacyCapabilityAttempts(client, input) {
  const quarantined = await query(client,
    `UPDATE ai_gateway_capability_attempts
        SET status='STALE',
            completion_hash=MD5('AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED:' || account_id || ':' || id)
              || MD5(id || ':' || account_id || ':AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED'),
            response=JSONB_BUILD_OBJECT('profileId',profile_id,'configVersion',config_version,
              'outcome','STALE','errorCode','AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED'),
            completed_at=NOW()
      WHERE account_id=$1 AND profile_id=$2 AND config_version=$3
        AND status='RUNNING' AND authorization_schema_version IS NULL
      RETURNING id,fence,correlation_id,completion_hash`,
    [input.accountId, input.profileId, input.configVersion]);
  for (const row of quarantined.rows) {
    await insertAudit(client, {
      eventId: auditIdentity("AUTO_LISTING_AI_PROFILE_CAPABILITY_UPGRADE_QUARANTINED",
        input.accountId, row.id),
      action: "AUTO_LISTING_AI_PROFILE_CAPABILITY_UPGRADE_QUARANTINED",
      accountId: input.accountId, actorId: "runtime-quarantine",
      correlationId: row.correlation_id, entityType: "ai_gateway_profile", entityId: input.profileId,
      status: "FAILED", actorType: "system", metadata: {
        requestHash: row.completion_hash,
        schemaVersion: "AI_GATEWAY_LEGACY_CAPABILITY_QUARANTINE_V1",
        attemptId: row.id, fence: Number(row.fence), outcome: "STALE",
        errorCode: "AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED",
      },
    });
  }
  const blocked = await query(client,
    `SELECT id FROM ai_gateway_capability_attempts
      WHERE account_id=$1 AND profile_id=$2 AND config_version=$3
        AND status='STALE' AND authorization_schema_version IS NULL
        AND response->>'errorCode'='AUTO_LISTING_AI_LEGACY_CAPABILITY_QUARANTINED'
      LIMIT 1 FOR UPDATE`, [input.accountId, input.profileId, input.configVersion]);
  return Boolean(blocked.rows[0]);
}

async function prepareCapabilitySubcallReservation(client, input) {
  const identity = capabilitySubcallProviderIdentity(input);
  const reservationId = deterministicId("aigcap_subcall", input.accountId, input.attemptId, input.probe);
  const existing = await query(client,
    `SELECT id,status,lease_version,reservation_version,provider_request_key,provider_correlation_id
       FROM ai_gateway_capability_subcall_reservations
      WHERE account_id=$1 AND attempt_id=$2 AND stage=$3 FOR UPDATE`,
    [input.accountId, input.attemptId, input.probe]);
  let reservation = existing.rows[0];
  if (reservation && (reservation.provider_request_key !== identity.providerRequestKey
    || reservation.provider_correlation_id !== identity.providerCorrelationId)) {
    throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
  }
  if (!reservation) {
    reservation = (await query(client,
      `INSERT INTO ai_gateway_capability_subcall_reservations (
         id,account_id,attempt_id,profile_id,config_version,attempt_fence,lease_version,
         stage,status,provider_request_key,provider_correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PREPARED',$9,$10)
       RETURNING id,status,lease_version,reservation_version,provider_request_key,provider_correlation_id`,
      [reservationId, input.accountId, input.attemptId, input.profileId, input.configVersion,
        input.fence, input.leaseVersion, input.probe,
        identity.providerRequestKey, identity.providerCorrelationId])).rows[0];
  } else if (Number(reservation.lease_version) < input.leaseVersion) {
    reservation = (await query(client,
      `UPDATE ai_gateway_capability_subcall_reservations
          SET lease_version=$4,reservation_version=reservation_version+1,
              status=CASE WHEN status='SENDING' THEN 'SENDING' ELSE 'PREPARED' END,
              prepared_at=NOW(),
              sending_at=CASE WHEN status='SENDING' THEN sending_at ELSE NULL END,
              completed_at=NULL,terminal_reason=NULL
        WHERE account_id=$1 AND attempt_id=$2 AND stage=$3 AND lease_version<$4
        RETURNING id,status,lease_version,reservation_version,provider_request_key,provider_correlation_id`,
      [input.accountId, input.attemptId, input.probe, input.leaseVersion])).rows[0];
  } else if (Number(reservation.lease_version) !== input.leaseVersion
    || !["PREPARED", "SENDING"].includes(reservation.status)) {
    throw repositoryError("AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", 409, true);
  }
  const requestHash = hash({ action: "AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_RESERVED",
    attemptId: input.attemptId, stage: input.probe, providerRequestKey: identity.providerRequestKey,
    reservationVersion: Number(reservation.reservation_version) });
  const audit = await loadAudit(client, {
    action: "AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_RESERVED", accountId: input.accountId,
    idempotencyKey: `${input.attemptId}:${input.probe}:${reservation.reservation_version}`, requestHash,
  });
  if (!audit.metadata) {
    await insertAudit(client, {
      ...audit, action: "AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_RESERVED",
      accountId: input.accountId, actorId: input.accountId, correlationId: input.correlationId,
      entityType: "ai_gateway_profile", entityId: input.profileId, metadata: {
        requestHash, attemptId: input.attemptId, stage: input.probe,
        providerRequestKey: identity.providerRequestKey,
        providerRequestKeyHash: hash(identity.providerRequestKey),
        providerCorrelationId: identity.providerCorrelationId,
        leaseVersion: input.leaseVersion, reservationVersion: Number(reservation.reservation_version),
      },
    });
  }
  return identity;
}

async function activatePublishedConnection(client, { input, profile, requestHash }) {
  const currentResult = await query(client,
    `SELECT id,version,status_version
       FROM ai_gateway_connection_versions
      WHERE account_id=$1 AND status='ACTIVE'
      FOR UPDATE`,
    [input.accountId]);
  if (currentResult.rows.length > 1) {
    throw repositoryError("AUTO_LISTING_AI_PROFILE_AMBIGUOUS", 409);
  }
  const targetAlreadyActive = profile.connectionId !== null && currentResult.rows.some((current) => (
    current.id === profile.connectionId && Number(current.version) === profile.connectionVersion
  ));
  for (const current of currentResult.rows) {
    if (current.id === profile.connectionId && Number(current.version) === profile.connectionVersion) continue;
    const retired = (await query(client,
      `UPDATE ai_gateway_connection_versions
          SET status='RETIRED',status_version=status_version+1,
              retired_at=NOW(),retired_by=$4
        WHERE account_id=$1 AND id=$2 AND version=$3 AND status='ACTIVE'
        RETURNING id,version,status_version`,
      [input.accountId, current.id, Number(current.version), input.actorId])).rows[0];
    if (!retired) throw repositoryError("AUTO_LISTING_AI_PROFILE_VERSION_CONFLICT", 409);
    await insertConnectionEvent(client, {
      accountId: input.accountId, connectionId: current.id, connectionVersion: Number(current.version),
      eventType: "RETIRED", statusVersion: Number(retired.status_version), actorId: input.actorId,
      correlationId: input.correlationId,
      payload: profile.connectionId === null
        ? { supersededByProfileId: profile.id, supersededByProfileVersion: profile.configVersion }
        : { supersededById: profile.connectionId, supersededByVersion: profile.connectionVersion },
    });
    await insertConnectionAudit(client, {
      action: "AUTO_LISTING_AI_CONNECTION_RETIRED", accountId: input.accountId, actorId: input.actorId,
      correlationId: input.correlationId, connectionId: current.id,
      connectionVersion: Number(current.version), statusVersion: Number(retired.status_version),
      idempotencyKey: `${input.idempotencyKey}:retired:${current.id}:${current.version}`,
      requestHash, metadata: profile.connectionId === null
        ? { supersededByProfileId: profile.id, supersededByProfileVersion: profile.configVersion }
        : { supersededById: profile.connectionId, supersededByVersion: profile.connectionVersion },
    });
  }
  if (profile.connectionId === null || targetAlreadyActive) return;
  const activated = (await query(client,
    `UPDATE ai_gateway_connection_versions
        SET status='ACTIVE',status_version=status_version+1,
            activated_at=NOW(),activated_by=$4
      WHERE account_id=$1 AND id=$2 AND version=$3 AND status='VALIDATED'
      RETURNING id,version,status_version`,
    [input.accountId, profile.connectionId, profile.connectionVersion, input.actorId])).rows[0];
  if (!activated) throw repositoryError("AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED", 409);
  await insertConnectionEvent(client, {
    accountId: input.accountId, connectionId: profile.connectionId,
    connectionVersion: profile.connectionVersion, eventType: "ACTIVATED",
    statusVersion: Number(activated.status_version), actorId: input.actorId,
    correlationId: input.correlationId, payload: { profileId: profile.id, configVersion: profile.configVersion },
  });
  await insertConnectionAudit(client, {
    action: "AUTO_LISTING_AI_CONNECTION_ACTIVATE", accountId: input.accountId, actorId: input.actorId,
    correlationId: input.correlationId, connectionId: profile.connectionId,
    connectionVersion: profile.connectionVersion, statusVersion: Number(activated.status_version),
    idempotencyKey: `${input.idempotencyKey}:activated`, requestHash,
    metadata: { profileId: profile.id, configVersion: profile.configVersion },
  });
}

function capabilityAttemptRow(row, profile) {
  if (!row) return null;
  const result = {
    profile,
    attemptId: row.id,
    fence: Number(row.fence),
    status: row.status,
    response: row.response ?? null,
    leaseVersion: Number(row.lease_version),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at ?? null,
  };
  const capabilityExecution = capabilityExecutionFromAttempt(row);
  if (capabilityExecution) result.capabilityExecution = capabilityExecution;
  return result;
}

function strategyCreateRequest(input) {
  const accountId = sameActor(input);
  return {
    accountId,
    actorId: accountId,
    strategyKey: id(input.strategyKey),
    version: version(input.version),
    idempotencyKey: id(input.idempotencyKey),
    correlationId: id(input.correlationId),
    content: canonical(input.content),
    rules: canonical(input.rules),
  };
}

function strategyPublishRequest(input) {
  const accountId = sameActor(input);
  return {
    accountId,
    actorId: accountId,
    strategyKey: id(input.strategyKey),
    strategyVersionId: id(input.strategyVersionId),
    version: version(input.version),
    idempotencyKey: id(input.idempotencyKey),
    correlationId: id(input.correlationId),
  };
}

function categoryStrategyPublishRequest(rawInput) {
  const input = closedCategoryStrategyCommand(rawInput, CATEGORY_STRATEGY_PUBLISH_KEYS);
  const accountId = sameActor(input);
  return {
    accountId,
    actorId: accountId,
    draftId: id(input.draftId),
    expectedDraftVersion: version(input.expectedDraftVersion),
    expectedPublishedStrategyVersionId: id(input.expectedPublishedStrategyVersionId),
    idempotencyKey: id(input.idempotencyKey),
    correlationId: id(input.correlationId),
  };
}

function categoryStrategyRollbackRequest(rawInput) {
  const input = closedCategoryStrategyCommand(rawInput, CATEGORY_STRATEGY_ROLLBACK_KEYS);
  const accountId = sameActor(input);
  return {
    accountId,
    actorId: accountId,
    targetStrategyVersionId: id(input.targetStrategyVersionId),
    expectedPublishedStrategyVersionId: id(input.expectedPublishedStrategyVersionId),
    idempotencyKey: id(input.idempotencyKey),
    correlationId: id(input.correlationId),
  };
}

function hydrateStoredStrategyRule(row) {
  const stored = canonical(row.rule || {});
  if (stored.matchType === "EXACT_CATEGORY_TYPE_V2") {
    return canonical({ ...stored, ruleId: stored.ruleId || row.id, ruleOrder: Number(row.rule_order) });
  }
  const rule = {
    ruleId: stored.ruleId || row.id,
    ruleOrder: Number(row.rule_order),
    matchType: row.rule_kind,
    style: stored.style,
    textDensityByRole: stored.textDensityByRole,
  };
  if (row.rule_kind === "PRODUCT_STYLE") rule.productStyle = row.product_style;
  else rule.categoryId = row.category_id ?? row.ancestor_category_id;
  return canonical(rule);
}

async function loadStrategyBundle(target, { accountId, strategyVersionId, strategyKey = "default", lock = false }) {
  const versionResult = await query(target,
    `SELECT id,account_id,strategy_key,version,status,content,content_hash,published_at,created_at
       FROM ai_content_strategy_versions
      WHERE account_id=$1 AND id=$2 AND strategy_key=$3${lock ? " FOR UPDATE" : ""}`,
    [accountId, strategyVersionId, strategyKey]);
  if (!versionResult.rows[0]) return null;
  const rulesResult = await query(target,
    `SELECT id,rule_kind,rule_order,category_id,ancestor_category_id,product_style,rule
       FROM ai_content_strategy_rules
      WHERE account_id=$1 AND strategy_version_id=$2
      ORDER BY rule_order,id${lock ? " FOR UPDATE" : ""}`,
    [accountId, strategyVersionId]);
  return { ...strategyRow(versionResult.rows[0]), rules: rulesResult.rows.map(hydrateStoredStrategyRule),
    storedRules: rulesResult.rows };
}

async function requireStrategyVersionAvailable(client, { accountId, strategyKey, version: nextVersion }) {
  const result = await query(client,
    `SELECT id FROM ai_content_strategy_versions
      WHERE account_id=$1 AND strategy_key=$2 AND version=$3 FOR UPDATE`,
    [accountId, strategyKey, nextVersion]);
  if (result.rows[0]) throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
}

function exactCategoryScope(rule, draft) {
  return rule?.matchType === "EXACT_CATEGORY_TYPE_V2"
    && rule.scope?.taxonomyScope === draft.taxonomy_scope
    && rule.scope?.descriptionCategoryId === Number(draft.description_category_id)
    && rule.scope?.typeId === Number(draft.type_id);
}

export function createAutoListingAiAdminPostgres(rawOptions = {}) {
  const { pool } = closedFactory(rawOptions);
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") throw invalid();

  return Object.freeze({
    async loadConnectionForCapabilitySecretResolution(rawInput = {}) {
      const input = canonical(rawInput);
      if (!input || Object.keys(input).length !== 3) throw invalid();
      const accountId = id(input.accountId);
      const connectionId = id(input.connectionId);
      const connectionVersion = version(input.connectionVersion);
      const result = await query(pool,
        `SELECT * FROM ai_gateway_connection_versions
          WHERE account_id=$1 AND id=$2 AND version=$3
            AND status IN ('VALIDATED','ACTIVE','RETIRED')`,
        [accountId, connectionId, connectionVersion]);
      return capabilitySecretRow(result?.rows?.[0]);
    },

    async loadCapabilityExecutionForSecretResolution(rawInput = {}) {
      const input = capabilityExecutionRequest(rawInput);
      const identity = capabilitySubcallProviderIdentity(input);
      const operation = () => transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const loaded = await query(client,
          `SELECT a.id,a.status,a.account_id,a.profile_id,a.config_version,
                  p.api_key_env_name,a.target_connection_id AS connection_id,
                  a.target_connection_version AS connection_version,
                  c.status AS connection_status,c.status_version AS connection_status_version,
                  c.ciphertext,c.iv,c.auth_tag,c.algorithm,c.key_version,c.fingerprint
             FROM ai_gateway_capability_attempts a
             JOIN ai_gateway_profiles p
               ON p.account_id=a.account_id AND p.id=a.profile_id AND p.config_version=a.config_version
             LEFT JOIN ai_gateway_connection_versions c
               ON c.account_id=a.account_id AND c.id=a.target_connection_id
              AND c.version=a.target_connection_version
            WHERE a.account_id=$1 AND a.profile_id=$2 AND a.config_version=$3
              AND a.id=$4 AND a.fence=$5 AND a.lease_version=$6 AND a.lease_token=$7
              AND a.status='RUNNING' AND a.lease_expires_at > NOW()
              AND a.authorization_schema_version=$8 AND a.purpose=$9
              AND a.cost_confirmed IS TRUE AND a.authorization_hash=$10 AND a.request_key=$11
              AND a.target_connection_id IS NOT DISTINCT FROM $12
              AND a.target_connection_version IS NOT DISTINCT FROM $13
              AND a.target_connection_status=$14 AND a.target_connection_status_version=$15
              AND p.connection_id IS NOT DISTINCT FROM a.target_connection_id
              AND p.connection_version IS NOT DISTINCT FROM a.target_connection_version
              AND NOT EXISTS (
                SELECT 1 FROM ai_gateway_capability_attempts newer
                 WHERE newer.account_id=a.account_id AND newer.profile_id=a.profile_id
                   AND newer.config_version=a.config_version AND newer.fence>a.fence
              )
              AND EXISTS (
                SELECT 1 FROM audit_events authorization_event
                 WHERE authorization_event.account_id=a.account_id
                   AND authorization_event.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_AUTHORIZED'
                   AND authorization_event.status='SUCCESS'
                   AND authorization_event.entity_type='ai_gateway_profile'
                   AND authorization_event.entity_id=a.profile_id
                   AND authorization_event.correlation_id=a.correlation_id
                   AND authorization_event.metadata->>'schemaVersion'=$8
                   AND authorization_event.metadata->>'attemptId'=a.id
                   AND (authorization_event.metadata->>'fence')::BIGINT=a.fence
                   AND (authorization_event.metadata->>'leaseVersion')::INTEGER=a.lease_version
                   AND authorization_event.metadata->>'leaseTokenHash'=$16
                   AND authorization_event.metadata->>'authorizationHash'=a.authorization_hash
                   AND authorization_event.metadata->>'requestKey'=a.request_key
                   AND authorization_event.metadata->>'purpose'=a.purpose
                   AND authorization_event.metadata->'costConfirmed'='true'::JSONB
              )
              AND (($14='LEGACY' AND a.purpose='PROFILE_CAPABILITY'
                    AND a.target_connection_id IS NULL AND c.id IS NULL)
                OR ($14 IN ('VALIDATED','ACTIVE','RETIRED') AND c.status=$14 AND c.status_version=$15))
            FOR UPDATE OF a,p`,
          [input.accountId, input.profileId, input.configVersion, input.attemptId, input.fence,
            input.leaseVersion, input.leaseToken, CAPABILITY_AUTHORIZATION_SCHEMA, input.purpose,
            input.authorizationHash, input.requestKey, input.connectionId, input.connectionVersion,
            input.expectedConnectionStatus, input.expectedConnectionStatusVersion, hash(input.leaseToken)]);
        let row = capabilityExecutionSecretRow(loaded.rows[0]);
        if (row && input.expectedConnectionStatus === "ACTIVE") {
          try {
            await requireActiveSuccessorCapabilityFence(client, {
              accountId: input.accountId, id: input.profileId, configVersion: input.configVersion,
              connectionId: input.connectionId, connectionVersion: input.connectionVersion,
            });
          } catch (error) {
            if (!["AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED",
              "AUTO_LISTING_AI_PROFILE_AMBIGUOUS"].includes(error?.code)) throw error;
            row = null;
          }
        }
        if (row) {
          const providerIdentity = await prepareCapabilitySubcallReservation(client, input);
          return { ...row, ...providerIdentity };
        }

        const diagnostic = await query(client,
          `SELECT status,lease_expires_at > NOW() AS lease_live,correlation_id,actor_id
             FROM ai_gateway_capability_attempts
            WHERE account_id=$1 AND profile_id=$2 AND config_version=$3 AND id=$4
              AND fence=$5 AND lease_version=$6 AND lease_token=$7
              AND authorization_schema_version=$8 AND purpose=$9
              AND cost_confirmed IS TRUE AND authorization_hash=$10 AND request_key=$11
            FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion, input.attemptId, input.fence,
            input.leaseVersion, input.leaseToken, CAPABILITY_AUTHORIZATION_SCHEMA, input.purpose,
            input.authorizationHash, input.requestKey]);
        if (!diagnostic.rows[0] || diagnostic.rows[0].status !== "RUNNING"
          || diagnostic.rows[0].lease_live !== true) {
          throw repositoryError("AUTO_LISTING_AI_ADMIN_CAPABILITY_EXECUTION_LEASE_CONFLICT", 409);
        }

        const staleResponse = {
          profileId: input.profileId,
          configVersion: input.configVersion,
          outcome: "STALE",
          errorCode: "AI_GATEWAY_PROFILE_VERSION_CONFLICT",
          probe: input.probe,
        };
        const staleHash = hash({ action: "AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST",
          attemptId: input.attemptId, fence: input.fence, leaseVersion: input.leaseVersion,
          authorizationHash: input.authorizationHash, outcome: "STALE" });
        const terminal = await query(client,
          `UPDATE ai_gateway_capability_attempts
              SET status='STALE',completion_hash=$8,response=$9::JSONB,completed_at=NOW()
            WHERE account_id=$1 AND profile_id=$2 AND config_version=$3 AND id=$4
              AND fence=$5 AND lease_version=$6 AND lease_token=$7 AND status='RUNNING'
            RETURNING id`,
          [input.accountId, input.profileId, input.configVersion, input.attemptId, input.fence,
            input.leaseVersion, input.leaseToken, staleHash, JSON.stringify(staleResponse)]);
        if (terminal.rowCount !== 1) {
          throw repositoryError("AUTO_LISTING_AI_ADMIN_CAPABILITY_EXECUTION_LEASE_CONFLICT", 409);
        }
        const audit = await loadAudit(client, {
          action: "AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST", accountId: input.accountId,
          idempotencyKey: input.attemptId, requestHash: staleHash,
        });
        if (!audit.metadata) {
          await insertAudit(client, {
            ...audit, action: "AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST",
            accountId: input.accountId, actorId: diagnostic.rows[0].actor_id,
            correlationId: diagnostic.rows[0].correlation_id,
            entityType: "ai_gateway_profile", entityId: input.profileId,
            status: "FAILED", metadata: { requestHash: staleHash, entityId: input.profileId,
              configVersion: input.configVersion, attemptId: input.attemptId, fence: input.fence,
              leaseVersion: input.leaseVersion, purpose: input.purpose, costConfirmed: true,
              outcome: "STALE", errorCode: "AI_GATEWAY_PROFILE_VERSION_CONFLICT", stale: true },
          });
        }
        return { stale: true };
      }).then((result) => {
        if (result?.stale === true) {
          throw repositoryError("AUTO_LISTING_AI_ADMIN_CAPABILITY_EXECUTION_STALE", 409);
        }
        return result;
      });
      try {
        return await operation();
      } catch (error) {
        if (error?.code !== "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED") throw error;
        try {
          const prepared = await loadCapabilitySubcallPreparedEvidence(pool, input, identity);
          if (prepared) return prepared;
          return await operation();
        } catch (recoveryError) {
          if (recoveryError?.code !== "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED") throw recoveryError;
          throw error;
        }
      }
    },

    async markCapabilitySubcallSending(rawInput = {}) {
      const input = capabilityExecutionRequest(rawInput);
      const identity = capabilitySubcallProviderIdentity(input);
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const updated = await query(client,
          `UPDATE ai_gateway_capability_subcall_reservations reservation
              SET status='SENDING',sending_at=COALESCE(reservation.sending_at,NOW()),
                  ever_sending_at=COALESCE(reservation.ever_sending_at,reservation.sending_at,NOW()),
                  terminal_reason=NULL
             FROM ai_gateway_capability_attempts attempt
            WHERE reservation.account_id=$1 AND reservation.attempt_id=$2 AND reservation.stage=$3
              AND reservation.lease_version=$4 AND reservation.status IN ('PREPARED','SENDING')
              AND reservation.provider_request_key=$5 AND reservation.provider_correlation_id=$6
              AND attempt.account_id=reservation.account_id AND attempt.id=reservation.attempt_id
              AND attempt.status='RUNNING' AND attempt.fence=$7 AND attempt.lease_version=$4
              AND attempt.lease_token=$8 AND attempt.lease_expires_at>NOW()
              AND attempt.authorization_hash=$9 AND attempt.request_key=$10
              AND attempt.purpose=$11 AND attempt.correlation_id=$12
            RETURNING reservation.provider_request_key,reservation.provider_correlation_id,
                      reservation.reservation_version`,
          [input.accountId, input.attemptId, input.probe, input.leaseVersion,
            identity.providerRequestKey, identity.providerCorrelationId, input.fence,
            input.leaseToken, input.authorizationHash, input.requestKey, input.purpose,
            input.correlationId]);
        const row = updated.rows[0];
        if (!row) throw repositoryError("AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", 409, true);
        const requestHash = hash({ action: "AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_SENDING",
          attemptId: input.attemptId, stage: input.probe,
          providerRequestKey: identity.providerRequestKey,
          reservationVersion: Number(row.reservation_version) });
        const audit = await loadAudit(client, {
          action: "AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_SENDING", accountId: input.accountId,
          idempotencyKey: `${input.attemptId}:${input.probe}:${row.reservation_version}`, requestHash,
        });
        if (!audit.metadata) {
          await insertAudit(client, {
            ...audit, action: "AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_SENDING",
            accountId: input.accountId, actorId: input.accountId, correlationId: input.correlationId,
            entityType: "ai_gateway_profile", entityId: input.profileId, metadata: {
              requestHash, attemptId: input.attemptId, stage: input.probe,
              providerRequestKey: identity.providerRequestKey,
              providerRequestKeyHash: hash(identity.providerRequestKey),
              providerCorrelationId: identity.providerCorrelationId,
              leaseVersion: input.leaseVersion, reservationVersion: Number(row.reservation_version),
            },
          });
        }
        return identity;
      });
    },

    async completeCapabilitySubcall(rawInput = {}) {
      const input = capabilitySubcallCompleteRequest(rawInput);
      const identity = capabilitySubcallProviderIdentity(input);
      try {
        return await transaction(pool, async (client) => {
          await lockAccount(client, input.accountId);
          const completed = await query(client,
            `UPDATE ai_gateway_capability_subcall_reservations reservation
                SET status=$5,completed_at=NOW(),terminal_reason=$14
               FROM ai_gateway_capability_attempts attempt
              WHERE reservation.account_id=$1 AND reservation.attempt_id=$2 AND reservation.stage=$3
                AND reservation.lease_version=$4 AND reservation.status IN ('PREPARED','SENDING')
                AND ((reservation.status='PREPARED' AND reservation.ever_sending_at IS NULL
                      AND $14 IN ('PRE_SEND_ABORTED','PRE_SEND_FAILED'))
                  OR (reservation.status='SENDING'
                      AND $14 IN ('PROVIDER_REJECTED','PROVIDER_ACCEPTED')))
                AND reservation.provider_request_key=$12 AND reservation.provider_correlation_id=$13
                AND attempt.account_id=reservation.account_id AND attempt.id=reservation.attempt_id
                AND attempt.status='RUNNING' AND attempt.fence=$6 AND attempt.lease_version=$4
                AND attempt.lease_token=$7 AND attempt.authorization_hash=$8
                AND attempt.request_key=$9 AND attempt.purpose=$10 AND attempt.correlation_id=$11
              RETURNING reservation.status,reservation.provider_request_key,
                        reservation.provider_correlation_id,reservation.reservation_version`,
            [input.accountId, input.attemptId, input.probe, input.leaseVersion, input.outcome,
              input.fence, input.leaseToken, input.authorizationHash, input.requestKey,
              input.purpose, input.correlationId, identity.providerRequestKey,
              identity.providerCorrelationId, input.reason]);
          const row = completed.rows[0];
          if (!row) {
            const replay = await loadCapabilitySubcallTerminalEvidence(client, input, identity,
              { forUpdate: true });
            if (replay) return { terminal: true, duplicate: true, reconciled: false };
            throw repositoryError("AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", 409, true);
          }
          const requestHash = hash({ action: CAPABILITY_SUBCALL_TERMINAL_ACTION,
            attemptId: input.attemptId, stage: input.probe, outcome: input.outcome,
            reason: input.reason, providerRequestKey: identity.providerRequestKey,
            reservationVersion: Number(row.reservation_version) });
          const audit = await loadAudit(client, {
            action: CAPABILITY_SUBCALL_TERMINAL_ACTION, accountId: input.accountId,
            idempotencyKey: `${input.attemptId}:${input.probe}:${row.reservation_version}`, requestHash,
          });
          if (!audit.metadata) {
            await insertAudit(client, {
              ...audit, action: CAPABILITY_SUBCALL_TERMINAL_ACTION,
              accountId: input.accountId, actorId: input.accountId,
              correlationId: input.correlationId, entityType: "ai_gateway_profile",
              entityId: input.profileId, metadata: {
                requestHash, attemptId: input.attemptId, stage: input.probe,
                outcome: input.outcome, reason: input.reason,
                providerRequestKey: identity.providerRequestKey,
                providerRequestKeyHash: hash(identity.providerRequestKey),
                providerCorrelationId: identity.providerCorrelationId,
                leaseVersion: input.leaseVersion,
                reservationVersion: Number(row.reservation_version),
              },
            });
          }
          return { terminal: true, duplicate: false, reconciled: false };
        });
      } catch (error) {
        try {
          const replay = await loadCapabilitySubcallTerminalEvidence(pool, input, identity);
          if (replay) return { terminal: true, duplicate: true, reconciled: true };
        } catch {
          // Preserve the original failure when exact terminal evidence cannot be proven.
        }
        throw error;
      }
    },

    async createProfile(rawInput = {}) {
      const input = profileRequest(rawInput);
      const action = "AUTO_LISTING_AI_PROFILE_CREATE";
      const requestHash = hash({ action, accountId: input.accountId, profile: input.profile });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const audit = await loadAudit(client, { ...input, action, requestHash });
        if (audit.metadata) {
          const found = await query(client,
            `SELECT id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                    text_model,image_model,enabled,capability_result,capability_checked_at,
                    connection_id,connection_version,created_at
               FROM ai_gateway_profiles
              WHERE account_id=$1 AND id=$2 AND config_version=$3`,
            [input.accountId, audit.metadata.entityId, audit.metadata.configVersion]);
          const row = profileRow(found?.rows?.[0]);
          if (!row || row.accountId !== input.accountId) throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          return { ...row, duplicate: true };
        }
        const profileId = deterministicId("ai_profile", input.accountId, input.idempotencyKey);
        const inserted = await query(client,
          `INSERT INTO ai_gateway_profiles (
             id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
             text_model,image_model,config_version,enabled,created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,$11)
           RETURNING id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                     text_model,image_model,enabled,capability_result,capability_checked_at,
                     connection_id,connection_version,created_at`,
          [profileId, input.accountId, input.profile.displayName, input.profile.baseUrl, input.profile.apiKeyEnvName,
            input.profile.textProtocol, input.profile.imageProtocol, input.profile.textModel, input.profile.imageModel,
            input.profile.configVersion, input.actorId]);
        const row = profileRow(inserted?.rows?.[0]);
        if (!row || row.accountId !== input.accountId || row.configVersion !== 1) throw databaseFailed();
        await insertAudit(client, {
          ...input, ...audit, action, entityType: "ai_gateway_profile", entityId: row.id,
          metadata: { requestHash, entityId: row.id, configVersion: row.configVersion },
        });
        return { ...row, duplicate: false };
      });
    },

    async listProfiles(rawInput = {}) {
      const accountId = id(rawInput.accountId);
      const result = await query(pool,
        `SELECT id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                text_model,image_model,enabled,capability_result,capability_checked_at,
                connection_id,connection_version,created_at
           FROM ai_gateway_profiles
          WHERE account_id=$1
          ORDER BY created_at ASC,id ASC`,
        [accountId]);
      return result.rows.map(profileRow);
    },

    async beginCapabilityTest(rawInput = {}) {
      const input = capabilityBeginRequest(rawInput);
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const loaded = await query(client,
          `SELECT id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                  text_model,image_model,enabled,capability_result,capability_checked_at,
                  connection_id,connection_version,created_at
             FROM ai_gateway_profiles
            WHERE account_id=$1 AND id=$2 AND config_version=$3 FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion]);
        const profile = profileRow(loaded.rows[0]);
        if (!profile || profile.accountId !== input.accountId) return null;
        if (await quarantineLegacyCapabilityAttempts(client, input)) {
          return { legacyCapabilityQuarantined: true };
        }
        const existing = await query(client,
          `SELECT attempt.id,attempt.fence,attempt.account_id,attempt.profile_id,attempt.config_version,
                  attempt.correlation_id,attempt.status,attempt.response,attempt.lease_version,
                  attempt.lease_token,attempt.lease_expires_at,attempt.authorization_schema_version,
                  attempt.purpose,attempt.cost_confirmed,attempt.authorization_hash,attempt.request_key,
                  attempt.actor_id,attempt.target_connection_id,attempt.target_connection_version,
                  attempt.target_connection_status,attempt.target_connection_status_version,attempt.authorized_at,
                  EXISTS (
                    SELECT 1 FROM audit_events confirmation
                     WHERE confirmation.account_id=attempt.account_id
                       AND confirmation.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST'
                       AND confirmation.entity_type='ai_gateway_profile'
                       AND confirmation.entity_id=attempt.profile_id
                       AND confirmation.metadata->>'attemptId'=attempt.id
                       AND confirmation.metadata->>'purpose'=$5
                       AND confirmation.metadata->'costConfirmed'='true'::JSONB
                  ) AS confirmation_matches
             FROM ai_gateway_capability_attempts attempt
            WHERE account_id=$1 AND profile_id=$2 AND config_version=$3 AND correlation_id=$4
            FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion, input.correlationId, input.purpose]);
        if (existing.rows[0]) {
          if (existing.rows[0].id !== input.attemptId) {
            throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          }
          if (["PASSED", "FAILED", "STALE"].includes(existing.rows[0].status)) {
            if (existing.rows[0].confirmation_matches !== true) {
              throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
            }
            if (existing.rows[0].authorization_schema_version === CAPABILITY_AUTHORIZATION_SCHEMA
              && (existing.rows[0].purpose !== input.purpose
                || existing.rows[0].request_key !== input.requestKey
                || existing.rows[0].actor_id !== input.actorId)) {
              throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
            }
            return { ...capabilityAttemptRow(existing.rows[0], profile), duplicate: true, reclaimed: false };
          }
        }
        const connectionFence = await requireConnectionCapabilityFence(client, profile, input.purpose);
        const authorization = capabilityAuthorization(input, connectionFence);
        if (existing.rows[0]) {
          const existingExecution = capabilityExecutionFromAttempt(existing.rows[0]);
          if (!existingExecution || existingExecution.requestKey !== input.requestKey
            || existingExecution.purpose !== input.purpose
            || existingExecution.connectionId !== authorization.targetConnectionId
            || existingExecution.connectionVersion !== authorization.targetConnectionVersion
            || existingExecution.expectedConnectionStatus !== authorization.targetConnectionStatus
            || existingExecution.expectedConnectionStatusVersion !== authorization.targetConnectionStatusVersion) {
            throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          }
          if (existing.rows[0].status === "RUNNING") {
            const leaseToken = `caplease_${crypto.randomUUID().replaceAll("-", "")}`;
            const reclaimed = await query(client,
              `UPDATE ai_gateway_capability_attempts
                  SET lease_version=lease_version+1,lease_token=$5,lease_expires_at=NOW()+INTERVAL '10 minutes'
                WHERE account_id=$1 AND profile_id=$2 AND config_version=$3 AND id=$4
                  AND status='RUNNING' AND lease_expires_at<=NOW()
                RETURNING id,fence,account_id,profile_id,config_version,correlation_id,status,response,
                          lease_version,lease_token,lease_expires_at,authorization_schema_version,
                          purpose,cost_confirmed,authorization_hash,request_key,actor_id,
                          target_connection_id,target_connection_version,target_connection_status,
                          target_connection_status_version,authorized_at`,
              [input.accountId, input.profileId, input.configVersion, input.attemptId, leaseToken]);
            if (reclaimed.rows[0]) {
              await query(client,
                `UPDATE ai_gateway_capability_subcall_reservations
                    SET lease_version=$3,reservation_version=reservation_version+1,
                        status=CASE WHEN status='SENDING' THEN 'SENDING' ELSE 'PREPARED' END,
                        prepared_at=NOW(),
                        sending_at=CASE WHEN status='SENDING' THEN sending_at ELSE NULL END,
                        completed_at=NULL,terminal_reason=NULL
                  WHERE account_id=$1 AND attempt_id=$2 AND lease_version<$3`,
                [input.accountId, input.attemptId, Number(reclaimed.rows[0].lease_version)]);
              await insertCapabilityAuthorizationAudit(client, input, reclaimed.rows[0]);
              return { ...capabilityAttemptRow(reclaimed.rows[0], profile), duplicate: false, reclaimed: true };
            }
          }
          return { ...capabilityAttemptRow(existing.rows[0], profile), duplicate: true, reclaimed: false };
        }
        const leaseToken = `caplease_${crypto.randomUUID().replaceAll("-", "")}`;
        let inserted;
        try {
          inserted = await client.query(
            `INSERT INTO ai_gateway_capability_attempts (
             id,account_id,profile_id,config_version,correlation_id,status,lease_token,lease_expires_at,
             authorization_schema_version,purpose,cost_confirmed,authorization_hash,request_key,actor_id,
             target_connection_id,target_connection_version,target_connection_status,
             target_connection_status_version,authorized_at
           ) VALUES ($1,$2,$3,$4,$5,'RUNNING',$6,NOW()+INTERVAL '10 minutes',
             $7,$8,TRUE,$9,$10,$11,$12,$13,$14,$15,NOW())
           RETURNING id,fence,account_id,profile_id,config_version,correlation_id,status,response,
                     lease_version,lease_token,lease_expires_at,authorization_schema_version,
                     purpose,cost_confirmed,authorization_hash,request_key,actor_id,
                     target_connection_id,target_connection_version,target_connection_status,
                     target_connection_status_version,authorized_at`,
            [input.attemptId, input.accountId, input.profileId, input.configVersion, input.correlationId, leaseToken,
              CAPABILITY_AUTHORIZATION_SCHEMA, input.purpose, authorization.authorizationHash, input.requestKey,
              input.actorId, authorization.targetConnectionId, authorization.targetConnectionVersion,
              authorization.targetConnectionStatus, authorization.targetConnectionStatusVersion]);
        } catch (error) {
          if (error?.code === "23505") {
            throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          }
          throw databaseFailed();
        }
        const attempt = capabilityAttemptRow(inserted.rows[0], profile);
        if (!attempt || attempt.status !== "RUNNING") throw databaseFailed();
        await insertCapabilityAuthorizationAudit(client, input, inserted.rows[0]);
        return { ...attempt, duplicate: false, reclaimed: false };
      }).then((result) => {
        if (result?.legacyCapabilityQuarantined === true) {
          throw repositoryError("AUTO_LISTING_AI_ADMIN_LEGACY_CAPABILITY_QUARANTINED", 409);
        }
        return result;
      });
    },

    async completeCapabilityTest(rawInput = {}) {
      const input = capabilityCompleteRequest(rawInput);
      const action = "AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST";
      const completionHash = hash({ action, accountId: input.accountId, profileId: input.profileId,
        configVersion: input.configVersion, attemptId: input.attemptId, fence: input.fence,
        leaseVersion: input.leaseVersion, purpose: input.purpose, costConfirmed: input.costConfirmed,
        requestKey: input.requestKey,
        capabilityResult: input.capabilityResult });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const loaded = await query(client,
          `SELECT id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                  text_model,image_model,enabled,capability_result,capability_checked_at,
                  connection_id,connection_version,created_at
             FROM ai_gateway_profiles
            WHERE account_id=$1 AND id=$2 AND config_version=$3 FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion]);
        const profile = profileRow(loaded.rows[0]);
        if (!profile || profile.accountId !== input.accountId) {
          throw repositoryError("AUTO_LISTING_AI_PROFILE_NOT_FOUND", 404);
        }
        const found = await query(client,
          `SELECT id,fence,account_id,profile_id,config_version,correlation_id,status,completion_hash,response,
                  lease_version,lease_token,authorization_schema_version,purpose,cost_confirmed,
                  authorization_hash,request_key,actor_id,target_connection_id,target_connection_version,
                  target_connection_status,target_connection_status_version,authorized_at,
                  lease_expires_at > NOW() AS lease_live
             FROM ai_gateway_capability_attempts
            WHERE account_id=$1 AND profile_id=$2 AND config_version=$3 AND id=$4
            FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion, input.attemptId]);
        const attempt = found.rows[0];
        if (!attempt || Number(attempt.fence) !== input.fence || attempt.correlation_id !== input.correlationId
          || Number(attempt.lease_version) !== input.leaseVersion || attempt.lease_token !== input.leaseToken
          || attempt.authorization_schema_version !== CAPABILITY_AUTHORIZATION_SCHEMA
          || attempt.purpose !== input.purpose || attempt.cost_confirmed !== true
          || attempt.request_key !== input.requestKey || attempt.actor_id !== input.actorId) {
          throw repositoryError("AI_GATEWAY_PROFILE_VERSION_CONFLICT", 409);
        }
        if (attempt.status !== "RUNNING") {
          if (attempt.status === "STALE" && attempt.response) {
            return { applied: false, stale: true, duplicate: true, response: attempt.response };
          }
          if (attempt.completion_hash !== completionHash || !attempt.response) {
            throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          }
          return { applied: attempt.status !== "STALE", stale: attempt.status === "STALE",
            duplicate: true, response: attempt.response };
        }
        const activeReservation = await query(client,
          `SELECT id FROM ai_gateway_capability_subcall_reservations
            WHERE account_id=$1 AND attempt_id=$2 AND status IN ('PREPARED','SENDING')
            LIMIT 1 FOR UPDATE`, [input.accountId, input.attemptId]);
        if (activeReservation.rows[0]) {
          throw repositoryError("AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", 409, true);
        }
        let connectionStale = false;
        try {
          const connectionFence = await requireConnectionCapabilityFence(client, profile, input.purpose);
          connectionStale = (connectionFence.id ?? null) !== (attempt.target_connection_id ?? null)
            || (connectionFence.version == null ? null : Number(connectionFence.version))
              !== (attempt.target_connection_version == null ? null : Number(attempt.target_connection_version))
            || connectionFence.status !== attempt.target_connection_status
            || Number(connectionFence.status_version) !== Number(attempt.target_connection_status_version);
        } catch (error) {
          if (!["AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED",
            "AUTO_LISTING_AI_PROFILE_ROLLBACK_NOT_READY",
            "AUTO_LISTING_AI_PROFILE_AMBIGUOUS"].includes(error?.code)) throw error;
          connectionStale = true;
        }
        const newest = await query(client,
          `SELECT id,fence FROM ai_gateway_capability_attempts
            WHERE account_id=$1 AND profile_id=$2 AND config_version=$3
            ORDER BY fence DESC LIMIT 1 FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion]);
        const formalProfileProtected = input.purpose === "PROFILE_CAPABILITY" && profile.enabled === true;
        const stale = attempt.lease_live !== true || connectionStale || formalProfileProtected
          || newest.rows[0]?.id !== input.attemptId
          || Number(newest.rows[0]?.fence) !== input.fence;
        let enabled = profile.enabled;
        if (!stale) {
          const updated = await query(client,
            `UPDATE ai_gateway_profiles
                SET capability_result=$4::JSONB,capability_checked_at=$5,
                    enabled=CASE WHEN $6='FAILED' THEN FALSE ELSE enabled END,updated_at=NOW()
              WHERE account_id=$1 AND id=$2 AND config_version=$3
              RETURNING enabled`,
            [input.accountId, input.profileId, input.configVersion, JSON.stringify(input.capabilityResult),
              input.capabilityResult.checkedAt, input.capabilityResult.outcome]);
          if (updated.rowCount !== 1) throw repositoryError("AI_GATEWAY_PROFILE_VERSION_CONFLICT", 409);
          enabled = updated.rows[0].enabled === true;
        }
        const response = {
          profileId: input.profileId,
          configVersion: input.configVersion,
          ...input.capabilityResult,
          enabled,
        };
        const terminalStatus = stale ? "STALE" : input.capabilityResult.outcome;
        const completed = await query(client,
          `UPDATE ai_gateway_capability_attempts
              SET status=$7,completion_hash=$8,response=$9::JSONB,completed_at=NOW()
            WHERE account_id=$1 AND profile_id=$2 AND config_version=$3 AND id=$4
              AND lease_version=$5 AND lease_token=$6 AND status='RUNNING'
            RETURNING id`,
          [input.accountId, input.profileId, input.configVersion, input.attemptId,
            input.leaseVersion, input.leaseToken, terminalStatus, completionHash, JSON.stringify(response)]);
        if (completed.rowCount !== 1) throw repositoryError("AI_GATEWAY_PROFILE_VERSION_CONFLICT", 409);
        const audit = await loadAudit(client, {
          action, accountId: input.accountId, idempotencyKey: input.attemptId, requestHash: completionHash,
        });
        if (!audit.metadata) {
          await insertAudit(client, {
            ...audit, action, accountId: input.accountId, actorId: input.actorId,
            correlationId: input.correlationId, entityType: "ai_gateway_profile", entityId: input.profileId,
            status: !stale && input.capabilityResult.outcome === "PASSED" ? "SUCCESS" : "FAILED",
            metadata: { requestHash: completionHash, entityId: input.profileId,
              configVersion: input.configVersion, attemptId: input.attemptId, fence: input.fence,
              leaseVersion: input.leaseVersion, purpose: input.purpose, costConfirmed: true,
              outcome: input.capabilityResult.outcome, errorCode: input.capabilityResult.errorCode, stale },
          });
        }
        return { applied: !stale, stale, duplicate: false, response };
      });
    },

    async publishProfile(rawInput = {}) {
      const input = profilePublishRequest(rawInput);
      const action = "AUTO_LISTING_AI_PROFILE_PUBLISH";
      const requestHash = hash({ action, accountId: input.accountId, profileId: input.profileId,
        configVersion: input.configVersion });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const audit = await loadAudit(client, { ...input, action, requestHash });
        if (audit.metadata) {
          const replay = await query(client,
            `SELECT id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                    text_model,image_model,enabled,capability_result,capability_checked_at,
                    connection_id,connection_version,created_at
               FROM ai_gateway_profiles
              WHERE account_id=$1 AND id=$2 AND config_version=$3`,
            [input.accountId, audit.metadata.entityId, audit.metadata.configVersion]);
          const row = profileRow(replay.rows[0]);
          if (!row || row.accountId !== input.accountId) throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          return { ...row, activation: audit.activation, duplicate: true };
        }
        await assertNoActivePaidReservation(client, input.accountId);
        const target = await query(client,
          `SELECT id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                  text_model,image_model,enabled,capability_result,capability_checked_at,
                  connection_id,connection_version,created_at
             FROM ai_gateway_profiles
            WHERE account_id=$1 AND id=$2 AND config_version=$3 FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion]);
        const rawTarget = target.rows[0];
        if (!rawTarget || rawTarget.account_id !== input.accountId) throw repositoryError("AUTO_LISTING_AI_PROFILE_NOT_FOUND", 404);
        if (rawTarget.enabled === true) throw repositoryError("AUTO_LISTING_AI_PROFILE_VERSION_CONFLICT", 409);
        if (!capabilityPassed(rawTarget)) throw repositoryError("AUTO_LISTING_AI_PROFILE_CAPABILITY_REQUIRED", 409);
        const profile = profileRow(rawTarget);
        await requireConnectionCapabilityFence(client, profile, "PROFILE_CAPABILITY");
        if (profile.connectionId === null) {
          const priorPublication = await query(client,
            `SELECT 1 FROM audit_events
              WHERE account_id=$1 AND action='AUTO_LISTING_AI_PROFILE_PUBLISH'
                AND status='SUCCESS' AND entity_type='ai_gateway_profile' AND entity_id=$2
              LIMIT 1
              FOR UPDATE`,
            [input.accountId, input.profileId]);
          if (priorPublication.rows[0]) {
            throw repositoryError("AUTO_LISTING_AI_PROFILE_ROLLBACK_NOT_READY", 409);
          }
        }
        const enabled = await query(client,
          `SELECT id,config_version FROM ai_gateway_profiles
            WHERE account_id=$1 AND enabled IS TRUE
            FOR UPDATE`,
          [input.accountId]);
        if (enabled.rows.length > 1) throw repositoryError("AUTO_LISTING_AI_PROFILE_AMBIGUOUS", 409);
        await query(client,
          `UPDATE ai_gateway_profiles
              SET enabled=FALSE,capability_result='{}'::JSONB,
                  capability_checked_at=NULL,updated_at=NOW()
            WHERE account_id=$1 AND enabled IS TRUE AND (id<>$2 OR config_version<>$3)
            RETURNING id`,
          [input.accountId, input.profileId, input.configVersion]);
        await activatePublishedConnection(client, { input, profile, requestHash });
        const published = await query(client,
          `UPDATE ai_gateway_profiles SET enabled=TRUE,updated_at=NOW()
            WHERE account_id=$1 AND id=$2 AND config_version=$3
            RETURNING id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                      text_model,image_model,enabled,capability_result,capability_checked_at,
                      connection_id,connection_version,created_at`,
          [input.accountId, input.profileId, input.configVersion]);
        const row = profileRow(published.rows[0]);
        if (!row || !row.enabled || row.accountId !== input.accountId) throw databaseFailed();
        const activation = activationFromAuditRow(await insertAudit(client, {
          ...input, ...audit, action, entityType: "ai_gateway_profile", entityId: row.id,
          metadata: { requestHash, entityId: row.id, configVersion: row.configVersion },
        }));
        return { ...row, activation, duplicate: false };
      });
    },

    async prepareProfileRollback(rawInput = {}) {
      const input = profilePublishRequest(rawInput);
      const action = "AUTO_LISTING_AI_PROFILE_ROLLBACK";
      const intentAction = "AUTO_LISTING_AI_PROFILE_ROLLBACK_INTENT";
      const requestHash = hash({ action, accountId: input.accountId, profileId: input.profileId,
        configVersion: input.configVersion });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const completed = await loadAudit(client, { ...input, action, requestHash });
        if (completed.metadata) {
          const replay = await query(client,
            `SELECT id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                    text_model,image_model,enabled,capability_result,capability_checked_at,
                    connection_id,connection_version,created_at
               FROM ai_gateway_profiles
              WHERE account_id=$1 AND id=$2 AND config_version=$3`,
            [input.accountId, completed.metadata.entityId, completed.metadata.configVersion]);
          const row = profileRow(replay.rows[0]);
          if (!row || row.accountId !== input.accountId) {
            throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          }
          return { completed: true, duplicate: true,
            profile: { ...row, activation: completed.activation } };
        }
        const intent = await loadAudit(client, { ...input, action: intentAction, requestHash });
        if (!intent.metadata) {
          const target = await query(client,
            `SELECT id,account_id,config_version FROM ai_gateway_profiles
              WHERE account_id=$1 AND id=$2 AND config_version=$3`,
            [input.accountId, input.profileId, input.configVersion]);
          if (!target.rows[0]) throw repositoryError("AUTO_LISTING_AI_PROFILE_NOT_FOUND", 404);
          await insertAudit(client, {
            ...intent, action: intentAction, accountId: input.accountId, actorId: input.actorId,
            correlationId: input.correlationId, entityType: "ai_gateway_profile", entityId: input.profileId,
            status: "PENDING", metadata: { requestHash, entityId: input.profileId,
              configVersion: input.configVersion, purpose: "ROLLBACK_CAPABILITY", costConfirmed: true },
          });
        }
        return { completed: false, duplicate: intent.metadata !== null, profile: null };
      });
    },

    async rollbackProfile(rawInput = {}) {
      const input = profilePublishRequest(rawInput);
      const action = "AUTO_LISTING_AI_PROFILE_ROLLBACK";
      const requestHash = hash({ action, accountId: input.accountId, profileId: input.profileId,
        configVersion: input.configVersion });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const audit = await loadAudit(client, { ...input, action, requestHash });
        if (audit.metadata) {
          const replay = await query(client,
            `SELECT id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                    text_model,image_model,enabled,capability_result,capability_checked_at,
                    connection_id,connection_version,created_at
               FROM ai_gateway_profiles
              WHERE account_id=$1 AND id=$2 AND config_version=$3`,
            [input.accountId, audit.metadata.entityId, audit.metadata.configVersion]);
          const replayRow = profileRow(replay.rows[0]);
          if (!replayRow) throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          return { ...replayRow, activation: audit.activation, duplicate: true };
        }
        await assertNoActivePaidReservation(client, input.accountId);
        const target = await query(client,
          `SELECT id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                  text_model,image_model,enabled,capability_result,capability_checked_at,
                  connection_id,connection_version,created_at
             FROM ai_gateway_profiles
            WHERE account_id=$1 AND id=$2 AND config_version=$3 FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion]);
        const rawTarget = target.rows[0];
        if (!rawTarget || rawTarget.account_id !== input.accountId) {
          throw repositoryError("AUTO_LISTING_AI_PROFILE_NOT_FOUND", 404);
        }
        if (!capabilityPassed(rawTarget)) {
          throw repositoryError("AUTO_LISTING_AI_PROFILE_CAPABILITY_REQUIRED", 409);
        }
        const profile = profileRow(rawTarget);
        if (profile.connectionId === null) {
          throw repositoryError("AUTO_LISTING_AI_PROFILE_ROLLBACK_NOT_READY", 409);
        }
        const connectionFence = await requireConnectionCapabilityFence(client, profile, "ROLLBACK_CAPABILITY");
        const attemptResult = await query(client,
          `SELECT a.id,a.completed_at
             FROM ai_gateway_capability_attempts a
             JOIN audit_events capability_audit
               ON capability_audit.account_id=a.account_id
              AND capability_audit.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST'
              AND capability_audit.entity_type='ai_gateway_profile'
              AND capability_audit.entity_id=a.profile_id
              AND capability_audit.metadata->>'attemptId'=a.id
              AND capability_audit.metadata->>'purpose'='ROLLBACK_CAPABILITY'
            WHERE a.account_id=$1 AND a.profile_id=$2 AND a.config_version=$3
              AND a.status='PASSED' AND a.response->>'outcome'='PASSED'
              AND a.response->>'checkedAt'=$4 AND (a.response->>'checkedAt')::TIMESTAMPTZ >= $5
              AND a.completed_at >= $5
              AND (a.response - 'profileId' - 'configVersion' - 'enabled')=$6::JSONB
            ORDER BY a.fence DESC
            LIMIT 1
            FOR UPDATE OF a`,
          [input.accountId, input.profileId, input.configVersion, profile.capabilityCheckedAt,
            connectionFence.retired_at, JSON.stringify(profile.capabilityResult)]);
        const attempt = attemptResult.rows[0];
        if (!attempt) throw repositoryError("AUTO_LISTING_AI_PROFILE_ROLLBACK_NOT_READY", 409);
        const validationHash = hash(profile.capabilityResult);
        const rollbackEvidence = {
          schemaVersion: "AI_GATEWAY_PROFILE_ROLLBACK_CAPABILITY_V1",
          attemptId: attempt.id,
          profileId: profile.id,
          configVersion: profile.configVersion,
          checkedAt: profile.capabilityCheckedAt,
        };
        const rollbackEvidenceHash = hash(rollbackEvidence);
        const validated = (await query(client,
          `UPDATE ai_gateway_connection_versions
              SET status='VALIDATED',status_version=status_version+1,
                  validation_result=$4::JSONB,validation_hash=$5,
                  validated_at=NOW(),validated_by=$6,
                  rollback_evidence=$8::JSONB,rollback_evidence_hash=$9
            WHERE account_id=$1 AND id=$2 AND version=$3
              AND status='RETIRED' AND status_version=$7
            RETURNING id,version,status_version`,
          [input.accountId, profile.connectionId, profile.connectionVersion,
            JSON.stringify(profile.capabilityResult), validationHash, input.actorId,
            Number(connectionFence.status_version), JSON.stringify(rollbackEvidence), rollbackEvidenceHash])).rows[0];
        if (!validated) throw repositoryError("AUTO_LISTING_AI_PROFILE_VERSION_CONFLICT", 409);
        await insertConnectionEvent(client, {
          accountId: input.accountId, connectionId: profile.connectionId,
          connectionVersion: profile.connectionVersion, eventType: "ROLLBACK_VALIDATED",
          statusVersion: Number(validated.status_version), actorId: input.actorId,
          correlationId: input.correlationId,
          payload: { validationHash, rollbackEvidenceHash, purpose: "ROLLBACK_CAPABILITY" },
        });
        await insertConnectionAudit(client, {
          action: "AUTO_LISTING_AI_CONNECTION_VALIDATED", accountId: input.accountId,
          actorId: input.actorId, correlationId: input.correlationId,
          connectionId: profile.connectionId, connectionVersion: profile.connectionVersion,
          statusVersion: Number(validated.status_version),
          idempotencyKey: `${input.idempotencyKey}:rollback-validated`, requestHash,
          metadata: { validationHash, rollbackEvidenceHash, purpose: "ROLLBACK_CAPABILITY" },
        });
        const enabled = await query(client,
          `SELECT id,config_version FROM ai_gateway_profiles
            WHERE account_id=$1 AND enabled IS TRUE
            FOR UPDATE`,
          [input.accountId]);
        if (enabled.rows.length > 1) throw repositoryError("AUTO_LISTING_AI_PROFILE_AMBIGUOUS", 409);
        await query(client,
          `UPDATE ai_gateway_profiles
              SET enabled=FALSE,capability_result='{}'::JSONB,
                  capability_checked_at=NULL,updated_at=NOW()
            WHERE account_id=$1 AND enabled IS TRUE AND (id<>$2 OR config_version<>$3)
            RETURNING id`,
          [input.accountId, input.profileId, input.configVersion]);
        await activatePublishedConnection(client, { input, profile, requestHash });
        const published = await query(client,
          `UPDATE ai_gateway_profiles SET enabled=TRUE,updated_at=NOW()
            WHERE account_id=$1 AND id=$2 AND config_version=$3
            RETURNING id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                      text_model,image_model,enabled,capability_result,capability_checked_at,
                      connection_id,connection_version,created_at`,
          [input.accountId, input.profileId, input.configVersion]);
        const row = profileRow(published.rows[0]);
        if (!row || !row.enabled || row.accountId !== input.accountId) throw databaseFailed();
        const activation = activationFromAuditRow(await insertAudit(client, {
          ...input, ...audit, action, entityType: "ai_gateway_profile", entityId: row.id,
          metadata: { requestHash, entityId: row.id, configVersion: row.configVersion,
            purpose: "ROLLBACK_CAPABILITY", attemptId: attempt.id },
        }));
        return { ...row, activation, duplicate: false };
      });
    },

    async createStrategyVersion(rawInput = {}) {
      const input = strategyCreateRequest(rawInput);
      const action = "AUTO_LISTING_AI_STRATEGY_VERSION_CREATE";
      const contentHash = hash({ content: input.content, rules: input.rules });
      const requestHash = hash({ action, accountId: input.accountId, strategyKey: input.strategyKey,
        version: input.version, contentHash });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const audit = await loadAudit(client, { ...input, action, requestHash });
        if (audit.metadata) {
          const replay = await query(client,
            `SELECT id,account_id,strategy_key,version,status,content,content_hash,published_at,created_at
               FROM ai_content_strategy_versions
              WHERE account_id=$1 AND id=$2 AND strategy_key=$3 AND version=$4`,
            [input.accountId, audit.metadata.entityId, input.strategyKey, input.version]);
          const row = strategyRow(replay.rows[0]);
          if (!row || replay.rows[0].content_hash !== contentHash) {
            throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          }
          return { ...row, duplicate: true };
        }
        const existing = await query(client,
          `SELECT id,account_id,strategy_key,version,status,content,content_hash,published_at,created_at
             FROM ai_content_strategy_versions
            WHERE account_id=$1 AND strategy_key=$2 AND version=$3
            FOR UPDATE`,
          [input.accountId, input.strategyKey, input.version]);
        if (existing.rows[0]) {
          if (existing.rows[0].content_hash !== contentHash) throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
          return { ...strategyRow(existing.rows[0]), duplicate: true };
        }
        const strategyVersionId = deterministicId("ai_strategy", input.accountId, input.strategyKey, String(input.version));
        const inserted = await query(client,
          `INSERT INTO ai_content_strategy_versions (
             id,account_id,strategy_key,version,status,content,content_hash,created_by
           ) VALUES ($1,$2,$3,$4,'DRAFT',$5::JSONB,$6,$7)
           RETURNING id,account_id,strategy_key,version,status,content,content_hash,published_at,created_at`,
          [strategyVersionId, input.accountId, input.strategyKey, input.version,
            JSON.stringify(input.content), contentHash, input.actorId]);
        const row = strategyRow(inserted.rows[0]);
        if (!row || row.accountId !== input.accountId) throw databaseFailed();
        for (const rule of input.rules) {
          const ruleId = deterministicId("ai_rule", input.accountId, row.id, rule.ruleId);
          const categoryId = rule.matchType === "EXACT_CATEGORY" ? rule.categoryId : null;
          const ancestorCategoryId = rule.matchType === "ANCESTOR_CATEGORY" ? rule.categoryId : null;
          const productStyle = rule.matchType === "PRODUCT_STYLE" ? rule.productStyle : null;
          await query(client,
            `INSERT INTO ai_content_strategy_rules (
               id,account_id,strategy_version_id,rule_kind,rule_order,category_id,ancestor_category_id,product_style,rule
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::JSONB)`,
            [ruleId, input.accountId, row.id, rule.matchType, rule.ruleOrder,
              categoryId, ancestorCategoryId, productStyle,
              JSON.stringify({ ruleId: rule.ruleId, style: rule.style, textDensityByRole: rule.textDensityByRole })]);
        }
        await insertAudit(client, {
          ...input, ...audit, action, entityType: "ai_content_strategy_version", entityId: row.id,
          metadata: { requestHash, entityId: row.id, strategyKey: row.strategyKey, version: row.version },
        });
        return { ...row, rules: input.rules, duplicate: false };
      });
    },

    async listStrategyVersions(rawInput = {}) {
      const accountId = id(rawInput.accountId);
      const strategyKey = id(rawInput.strategyKey);
      const result = await query(pool,
        `SELECT v.id,v.account_id,v.strategy_key,v.version,v.status,v.content,v.content_hash,v.published_at,v.created_at,
                COALESCE((
                  SELECT jsonb_agg((CASE WHEN r.rule->>'matchType'='EXACT_CATEGORY_TYPE_V2'
                    THEN r.rule || jsonb_build_object(
                      'ruleId',COALESCE(r.rule->>'ruleId',r.id),'ruleOrder',r.rule_order
                    )
                    ELSE jsonb_build_object(
                      'ruleId',COALESCE(r.rule->>'ruleId',r.id),'ruleOrder',r.rule_order,'matchType',r.rule_kind,
                      'style',r.rule->>'style','textDensityByRole',r.rule->'textDensityByRole'
                    ) || CASE WHEN r.rule_kind='PRODUCT_STYLE'
                      THEN jsonb_build_object('productStyle',r.product_style)
                      ELSE jsonb_build_object('categoryId',COALESCE(r.category_id,r.ancestor_category_id)) END
                    END)
                    ORDER BY r.rule_order,r.id)
                  FROM ai_content_strategy_rules r
                  WHERE r.account_id=v.account_id AND r.strategy_version_id=v.id
                ),'[]'::JSONB) AS rules
           FROM ai_content_strategy_versions v
          WHERE v.account_id=$1 AND v.strategy_key=$2
          ORDER BY version ASC,id ASC`,
        [accountId, strategyKey]);
      return result.rows.map((row) => strategyRow(row));
    },

    async publishCategoryStrategyDraft(rawInput = {}) {
      const input = categoryStrategyPublishRequest(rawInput);
      const action = CATEGORY_STRATEGY_PUBLISH_ACTION;
      const commandHash = hash({ action, ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCategoryStrategyCommandLedger(client, {
          ...input, action, requestHash: commandHash,
        });
        const audit = await loadAudit(client, { ...input, action, requestHash: commandHash });
        if (audit.metadata) {
          const replay = await loadStrategyBundle(client, {
            accountId: input.accountId,
            strategyVersionId: audit.metadata.entityId,
            lock: true,
          });
          if (!replay || !["PUBLISHED", "RETIRED"].includes(replay.status)) {
            throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          }
          delete replay.storedRules;
          return { ...replay, status: "PUBLISHED", idempotencyKey: input.idempotencyKey, duplicate: true };
        }
        await requireCategoryStrategyMutationEnabled(client, input.accountId);
        const draftResult = await query(client,
          `SELECT * FROM auto_listing_category_strategy_drafts
            WHERE account_id=$1 AND id=$2 FOR UPDATE`,
          [input.accountId, input.draftId]);
        const draft = draftResult.rows[0];
        if (!draft) throw repositoryError("AUTO_LISTING_AI_STRATEGY_NOT_FOUND", 404);
        if (Number(draft.draft_version) !== input.expectedDraftVersion || draft.status !== "DRAFT_READY") {
          throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        }
        const source = await query(client,
          `SELECT item.id
             FROM collect_items item
             JOIN product_drafts product_draft
               ON product_draft.collect_item_id=item.id AND product_draft.id=item.current_draft_id
             JOIN collect_ozon_category_current_sources pointer
               ON pointer.account_id=item.account_id AND pointer.collect_item_id=item.id
              AND pointer.source_kind='PRODUCT_DRAFT' AND pointer.source_record_id=product_draft.id
              AND pointer.source_version IN (product_draft.version::TEXT,'draft:' || product_draft.version::TEXT)
             JOIN collect_ozon_category_source_evidence evidence
               ON evidence.account_id=pointer.account_id AND evidence.id=pointer.source_evidence_id
              AND evidence.collect_item_id=pointer.collect_item_id
              AND evidence.source_kind=pointer.source_kind
              AND evidence.source_record_id=pointer.source_record_id
              AND evidence.source_version=pointer.source_version
             JOIN account_ozon_shared_categories shared
               ON shared.account_id=evidence.account_id
              AND shared.source_description_category_id=evidence.source_description_category_id
              AND shared.source_type_id=evidence.source_type_id
              AND shared.taxonomy_scope=evidence.taxonomy_scope
              AND shared.current_description_category_id=$7
              AND shared.current_type_id=$8
              AND shared.status='ACTIVE'
            WHERE item.account_id=$1 AND item.id=$2
              AND product_draft.id=$3 AND product_draft.version=$4
              AND $5='draft:' || product_draft.version::TEXT
              AND evidence.taxonomy_scope=$6
            FOR UPDATE OF item,product_draft,pointer,shared`,
          [input.accountId, draft.source_collect_item_id, draft.source_product_draft_id,
            draft.source_product_draft_version, draft.expected_source_version, draft.taxonomy_scope,
            draft.description_category_id, draft.type_id]);
        if (!source.rows[0]) throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        const analysis = await query(client,
          `SELECT result.id,result.guidance,result.guidance_hash,result.sample_set_hash,
                  result.attempt_id,result.sample_set_id
             FROM auto_listing_category_strategy_analysis_results result
             JOIN auto_listing_category_strategy_analysis_attempts attempt
               ON attempt.account_id=result.account_id AND attempt.id=result.attempt_id
              AND attempt.draft_id=result.draft_id AND attempt.sample_set_id=result.sample_set_id
              AND attempt.sample_set_hash=result.sample_set_hash
             JOIN auto_listing_category_strategy_sample_sets sample_set
               ON sample_set.account_id=result.account_id AND sample_set.id=result.sample_set_id
              AND sample_set.draft_id=result.draft_id AND sample_set.status='SEALED'
              AND sample_set.sample_set_hash=result.sample_set_hash
             JOIN auto_listing_category_strategy_events final_event
               ON final_event.account_id=result.account_id AND final_event.draft_id=result.draft_id
              AND final_event.taxonomy_scope=result.taxonomy_scope
              AND final_event.description_category_id=result.description_category_id
              AND final_event.type_id=result.type_id AND final_event.event_type='DRAFT_EVENT'
              AND final_event.event_payload->>'resultId'=result.id
              AND final_event.event_payload->>'draftVersion'=$6::TEXT
              AND final_event.event_payload->>'status'='DRAFT_READY'
              AND final_event.event_payload->>'event' IN ('ANALYSIS_RESULT_RECORDED','ANALYSIS_MANUAL_EDITED')
            WHERE result.account_id=$1 AND result.draft_id=$2
              AND result.taxonomy_scope=$3 AND result.description_category_id=$4 AND result.type_id=$5
            FOR UPDATE OF result,attempt,sample_set,final_event`,
          [input.accountId, input.draftId, draft.taxonomy_scope,
            draft.description_category_id, draft.type_id, input.expectedDraftVersion]);
        if (analysis.rows.length !== 1) throw repositoryError("AUTO_LISTING_AI_STRATEGY_NOT_PUBLISHABLE", 409);
        let guidance;
        try {
          guidance = projectRussianCategoryStrategyGuidanceV2(analysis.rows[0].guidance);
        } catch {
          throw repositoryError("AUTO_LISTING_AI_STRATEGY_NOT_PUBLISHABLE", 409);
        }
        const currentResult = await query(client,
          `SELECT id FROM ai_content_strategy_versions
            WHERE account_id=$1 AND strategy_key='default' AND status='PUBLISHED' FOR UPDATE`,
          [input.accountId]);
        if (currentResult.rows.length !== 1
          || currentResult.rows[0].id !== input.expectedPublishedStrategyVersionId) {
          throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        }
        const current = await loadStrategyBundle(client, {
          accountId: input.accountId,
          strategyVersionId: input.expectedPublishedStrategyVersionId,
          lock: true,
        });
        if (!current || current.status !== "PUBLISHED") {
          throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        }
        const matching = current.rules.filter((rule) => exactCategoryScope(rule, draft));
        if (matching.length > 1) throw repositoryError("AUTO_LISTING_AI_STRATEGY_PUBLISHED_AMBIGUOUS", 409);
        const preservedRows = current.storedRules.filter((_, index) => !exactCategoryScope(current.rules[index], draft));
        const replacementOrder = matching[0]?.ruleOrder
          ?? (current.rules.reduce((maximum, rule) => Math.max(maximum, Number(rule.ruleOrder) || 0), 0) + 1);
        const nextVersion = Number(current.version) + 1;
        await requireStrategyVersionAvailable(client, {
          accountId: input.accountId, strategyKey: "default", version: nextVersion,
        });
        const strategyVersionId = deterministicId("ai_strategy", input.accountId, "default", String(nextVersion));
        const replacementRule = canonical({
          ruleId: deterministicId("category_rule", input.accountId, draft.taxonomy_scope,
            String(draft.description_category_id), String(draft.type_id), strategyVersionId),
          ruleOrder: replacementOrder,
          matchType: "EXACT_CATEGORY_TYPE_V2",
          scope: {
            taxonomyScope: draft.taxonomy_scope,
            descriptionCategoryId: Number(draft.description_category_id),
            typeId: Number(draft.type_id),
          },
          overallStyle: guidance.overallStyle,
          prohibitedPatterns: guidance.prohibitedPatterns,
          roleGuidance: guidance.roles,
          sampleSetHash: analysis.rows[0].sample_set_hash,
          analysisAttemptId: analysis.rows[0].attempt_id,
          analysisResultId: analysis.rows[0].id,
        });
        const preservedRules = preservedRows.map(hydrateStoredStrategyRule);
        const compiledRules = [...preservedRules, replacementRule]
          .sort((left, right) => left.ruleOrder - right.ruleOrder || left.ruleId.localeCompare(right.ruleId));
        const content = canonical({
          schemaVersion: "V2",
          previousStrategyVersionId: current.id,
          sourceCategoryStrategyDraftId: input.draftId,
        });
        const contentHash = hash({ content, rules: compiledRules });
        await query(client,
          `INSERT INTO ai_content_strategy_versions
             (id,account_id,strategy_key,version,status,content,content_hash,created_by)
           VALUES ($1,$2,'default',$3,'DRAFT',$4::JSONB,$5,$2)`,
          [strategyVersionId, input.accountId, nextVersion, JSON.stringify(content), contentHash]);
        for (const row of preservedRows) {
          const logicalId = row.rule?.ruleId || row.id;
          await query(client,
            `INSERT INTO ai_content_strategy_rules
               (id,account_id,strategy_version_id,rule_kind,rule_order,category_id,
                ancestor_category_id,product_style,rule)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::JSONB)`,
            [deterministicId("ai_rule", input.accountId, strategyVersionId, logicalId), input.accountId,
              strategyVersionId, row.rule_kind, row.rule_order, row.category_id,
              row.ancestor_category_id, row.product_style, JSON.stringify(row.rule)]);
        }
        await query(client,
          `INSERT INTO ai_content_strategy_rules
             (id,account_id,strategy_version_id,rule_kind,rule_order,category_id,rule)
           VALUES ($1,$2,$3,'EXACT_CATEGORY',$4,$5,$6::JSONB)`,
          [deterministicId("ai_rule", input.accountId, strategyVersionId, replacementRule.ruleId),
            input.accountId, strategyVersionId, replacementRule.ruleOrder,
            String(replacementRule.scope.descriptionCategoryId), JSON.stringify(replacementRule)]);
        const retired = await query(client,
          `UPDATE ai_content_strategy_versions SET status='RETIRED'
            WHERE account_id=$1 AND id=$2 AND strategy_key='default' AND status='PUBLISHED'
            RETURNING id`,
          [input.accountId, current.id]);
        if (retired.rowCount !== 1) throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        const publishedResult = await query(client,
          `UPDATE ai_content_strategy_versions
              SET status='PUBLISHED',published_at=STATEMENT_TIMESTAMP(),published_by=$2
            WHERE account_id=$1 AND id=$3 AND strategy_key='default' AND version=$4 AND status='DRAFT'
            RETURNING id`,
          [input.accountId, input.actorId, strategyVersionId, nextVersion]);
        if (publishedResult.rowCount !== 1) throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        const advanced = await query(client,
          `UPDATE auto_listing_category_strategy_drafts
              SET status='PUBLISHED',draft_version=draft_version+1,
                  updated_at=STATEMENT_TIMESTAMP(),ended_at=STATEMENT_TIMESTAMP()
            WHERE account_id=$1 AND id=$2 AND draft_version=$3 AND status='DRAFT_READY'
            RETURNING draft_version`,
          [input.accountId, input.draftId, input.expectedDraftVersion]);
        if (advanced.rowCount !== 1) throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        await query(client,
          `INSERT INTO auto_listing_category_strategy_events
             (id,account_id,draft_id,taxonomy_scope,description_category_id,type_id,event_type,
              analysis_result_id,published_strategy_version_id,event_payload,idempotency_key,
              correlation_id,request_hash,actor_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,'PUBLISHED',$7,$8,$9::JSONB,$10,$11,$12,$2)`,
          [deterministicId("category_strategy_publish_event", input.accountId, input.idempotencyKey),
            input.accountId, input.draftId, draft.taxonomy_scope, draft.description_category_id,
            draft.type_id, analysis.rows[0].id, strategyVersionId,
            JSON.stringify({ previousStrategyVersionId: current.id, version: nextVersion }),
            input.idempotencyKey, input.correlationId, commandHash]);
        await insertAudit(client, {
          ...input, ...audit, action, entityType: "ai_content_strategy_version", entityId: strategyVersionId,
          metadata: { requestHash: commandHash, entityId: strategyVersionId,
            previousStrategyVersionId: current.id, version: nextVersion, draftId: input.draftId },
        });
        const published = await loadStrategyBundle(client, {
          accountId: input.accountId,
          strategyVersionId,
        });
        delete published.storedRules;
        return { ...published, idempotencyKey: input.idempotencyKey, duplicate: false };
      });
    },

    async rollbackCategoryStrategyVersion(rawInput = {}) {
      const input = categoryStrategyRollbackRequest(rawInput);
      const action = CATEGORY_STRATEGY_ROLLBACK_ACTION;
      const commandHash = hash({ action, ...input });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        await requireCategoryStrategyCommandLedger(client, {
          ...input, action, requestHash: commandHash,
        });
        const audit = await loadAudit(client, { ...input, action, requestHash: commandHash });
        if (audit.metadata) {
          const replay = await loadStrategyBundle(client, {
            accountId: input.accountId,
            strategyVersionId: audit.metadata.entityId,
            lock: true,
          });
          if (!replay || !["PUBLISHED", "RETIRED"].includes(replay.status)) {
            throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          }
          delete replay.storedRules;
          return { ...replay, status: "PUBLISHED", idempotencyKey: input.idempotencyKey, duplicate: true };
        }
        await requireCategoryStrategyMutationEnabled(client, input.accountId);
        const currentResult = await query(client,
          `SELECT id FROM ai_content_strategy_versions
            WHERE account_id=$1 AND strategy_key='default' AND status='PUBLISHED' FOR UPDATE`,
          [input.accountId]);
        if (currentResult.rows.length !== 1
          || currentResult.rows[0].id !== input.expectedPublishedStrategyVersionId) {
          throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        }
        const current = await loadStrategyBundle(client, {
          accountId: input.accountId,
          strategyVersionId: input.expectedPublishedStrategyVersionId,
          lock: true,
        });
        const target = await loadStrategyBundle(client, {
          accountId: input.accountId,
          strategyVersionId: input.targetStrategyVersionId,
          lock: true,
        });
        if (!target || !["PUBLISHED", "RETIRED"].includes(target.status)) {
          throw repositoryError("AUTO_LISTING_AI_STRATEGY_NOT_FOUND", 404);
        }
        if (!current || current.status !== "PUBLISHED") {
          throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        }
        const nextVersion = Number(current.version) + 1;
        await requireStrategyVersionAvailable(client, {
          accountId: input.accountId, strategyKey: "default", version: nextVersion,
        });
        const strategyVersionId = deterministicId("ai_strategy", input.accountId, "default", String(nextVersion));
        const rules = target.storedRules.map(hydrateStoredStrategyRule);
        const content = canonical({
          schemaVersion: target.content?.schemaVersion === "V1" ? "V1" : "V2",
          previousStrategyVersionId: current.id,
          rollbackOfStrategyVersionId: target.id,
        });
        const contentHash = hash({ content, rules });
        await query(client,
          `INSERT INTO ai_content_strategy_versions
             (id,account_id,strategy_key,version,status,content,content_hash,created_by)
           VALUES ($1,$2,'default',$3,'DRAFT',$4::JSONB,$5,$2)`,
          [strategyVersionId, input.accountId, nextVersion, JSON.stringify(content), contentHash]);
        for (const row of target.storedRules) {
          const logicalId = row.rule?.ruleId || row.id;
          await query(client,
            `INSERT INTO ai_content_strategy_rules
               (id,account_id,strategy_version_id,rule_kind,rule_order,category_id,
                ancestor_category_id,product_style,rule)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::JSONB)`,
            [deterministicId("ai_rule", input.accountId, strategyVersionId, logicalId), input.accountId,
              strategyVersionId, row.rule_kind, row.rule_order, row.category_id,
              row.ancestor_category_id, row.product_style, JSON.stringify(row.rule)]);
        }
        const retired = await query(client,
          `UPDATE ai_content_strategy_versions SET status='RETIRED'
            WHERE account_id=$1 AND id=$2 AND strategy_key='default' AND status='PUBLISHED'
            RETURNING id`,
          [input.accountId, current.id]);
        if (retired.rowCount !== 1) throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        const publishedResult = await query(client,
          `UPDATE ai_content_strategy_versions
              SET status='PUBLISHED',published_at=STATEMENT_TIMESTAMP(),published_by=$2
            WHERE account_id=$1 AND id=$3 AND strategy_key='default' AND version=$4 AND status='DRAFT'
            RETURNING id`,
          [input.accountId, input.actorId, strategyVersionId, nextVersion]);
        if (publishedResult.rowCount !== 1) throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        await insertAudit(client, {
          ...input, ...audit, action, entityType: "ai_content_strategy_version", entityId: strategyVersionId,
          metadata: { requestHash: commandHash, entityId: strategyVersionId,
            previousStrategyVersionId: current.id, rollbackOfStrategyVersionId: target.id, version: nextVersion },
        });
        const rolledBack = await loadStrategyBundle(client, {
          accountId: input.accountId,
          strategyVersionId,
        });
        delete rolledBack.storedRules;
        return { ...rolledBack, idempotencyKey: input.idempotencyKey, duplicate: false };
      });
    },

    async publishStrategyVersion(rawInput = {}) {
      const input = strategyPublishRequest(rawInput);
      const action = "AUTO_LISTING_AI_STRATEGY_VERSION_PUBLISH";
      const requestHash = hash({ action, accountId: input.accountId, strategyKey: input.strategyKey,
        strategyVersionId: input.strategyVersionId, version: input.version });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const audit = await loadAudit(client, { ...input, action, requestHash });
        if (audit.metadata) {
          const replay = await query(client,
            `SELECT id,account_id,strategy_key,version,status,content,content_hash,published_at,created_at
               FROM ai_content_strategy_versions
              WHERE account_id=$1 AND id=$2 AND strategy_key=$3 AND version=$4`,
            [input.accountId, audit.metadata.entityId, input.strategyKey, input.version]);
          const row = strategyRow(replay.rows[0]);
          if (!row || row.accountId !== input.accountId) throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          return { ...row, duplicate: true };
        }
        const target = await query(client,
          `SELECT id,account_id,strategy_key,version,status,content,content_hash,published_at,created_at
             FROM ai_content_strategy_versions
            WHERE account_id=$1 AND id=$2 AND strategy_key=$3 AND version=$4
            FOR UPDATE`,
          [input.accountId, input.strategyVersionId, input.strategyKey, input.version]);
        const targetRow = target.rows[0];
        if (!targetRow || targetRow.account_id !== input.accountId) throw repositoryError("AUTO_LISTING_AI_STRATEGY_NOT_FOUND", 404);
        if (!["DRAFT", "PUBLISHED"].includes(targetRow.status)) throw repositoryError("AUTO_LISTING_AI_STRATEGY_NOT_PUBLISHABLE", 409);
        const current = await query(client,
          `SELECT id,version FROM ai_content_strategy_versions
            WHERE account_id=$1 AND strategy_key=$2 AND status='PUBLISHED'
            FOR UPDATE`,
          [input.accountId, input.strategyKey]);
        if (current.rows.length > 1) throw repositoryError("AUTO_LISTING_AI_STRATEGY_PUBLISHED_AMBIGUOUS", 409);
        const previous = current.rows[0];
        if (previous && previous.id !== input.strategyVersionId) {
          await query(client,
            `UPDATE ai_content_strategy_versions SET status='RETIRED'
              WHERE account_id=$1 AND id=$2 AND status='PUBLISHED'
              RETURNING id`,
            [input.accountId, previous.id]);
        }
        let row = strategyRow(targetRow);
        if (targetRow.status !== "PUBLISHED") {
          const published = await query(client,
            `UPDATE ai_content_strategy_versions
                SET status='PUBLISHED',published_at=NOW(),published_by=$5
              WHERE account_id=$1 AND id=$2 AND strategy_key=$3 AND version=$4 AND status='DRAFT'
              RETURNING id,account_id,strategy_key,version,status,content,content_hash,published_at,created_at`,
            [input.accountId, input.strategyVersionId, input.strategyKey, input.version, input.actorId]);
          row = strategyRow(published.rows[0]);
          if (!row || row.status !== "PUBLISHED") throw repositoryError("AUTO_LISTING_AI_STRATEGY_VERSION_CONFLICT", 409);
        }
        await insertAudit(client, {
          ...input, ...audit, action, entityType: "ai_content_strategy_version", entityId: row.id,
          metadata: { requestHash, entityId: row.id, strategyKey: row.strategyKey, version: row.version },
        });
        return { ...row, duplicate: false };
      });
    },
  });
}

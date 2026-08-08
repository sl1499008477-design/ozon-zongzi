import crypto from "node:crypto";

const FACTORY_KEYS = new Set(["pool"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ENCRYPTED_SECRET_KEYS = [
  "algorithm", "authTag", "ciphertext", "fingerprint", "iv", "keyVersion",
];

function repositoryError(code, status = 422, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED"
    ? "自动上架 AI 设置数据暂时不可用"
    : code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function invalid() {
  return repositoryError("AUTO_LISTING_AI_SETTINGS_REPOSITORY_INVALID");
}

function databaseFailed() {
  return repositoryError("AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED", 503, true);
}

function capabilityRequired() {
  return repositoryError("AUTO_LISTING_AI_SETTINGS_CAPABILITY_REQUIRED", 422);
}

function plainRecord(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  if (!plainRecord(value)) throw invalid();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw invalid();
  return value;
}

function closedFactory(raw) {
  try {
    exactKeys(raw, FACTORY_KEYS);
    return { pool: raw.pool };
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_SETTINGS_REPOSITORY_INVALID") throw error;
    throw invalid();
  }
}

function identifier(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw invalid();
  return result;
}

function positiveInteger(value, maximum = 2_147_483_646) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw invalid();
  return value;
}

function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
  return value;
}

function nonEmpty(value, maximum = 4096) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || Buffer.byteLength(result, "utf8") > maximum) throw invalid();
  return result;
}

function safeText(value, maximum = 1000) {
  const result = nonEmpty(value, maximum);
  if (/\r|\n|\u0000/u.test(result)) throw invalid();
  return result;
}

function accountActor(input) {
  const accountId = identifier(input.accountId);
  if (identifier(input.actorId) !== accountId) throw invalid();
  return accountId;
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw invalid();
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw invalid();
    return [key, canonical(value[key])];
  }));
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function leaseIdentityHash(workerId, leaseVersion, leaseTokenDigest) {
  return hash({ workerId, leaseVersion, leaseTokenDigest });
}

function deterministicId(prefix, ...parts) {
  return `${prefix}_${crypto.createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 40)}`;
}

function normalizedBaseUrl(value) {
  const raw = nonEmpty(value, 2048);
  let parsed;
  try { parsed = new URL(raw); } catch { throw invalid(); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw invalid();
  return parsed.href.replace(/\/$/u, "");
}

function encryptedSecret(value) {
  exactKeys(value, ENCRYPTED_SECRET_KEYS);
  const result = {
    algorithm: nonEmpty(value.algorithm, 40),
    ciphertext: nonEmpty(value.ciphertext, 65_536),
    iv: nonEmpty(value.iv, 1024),
    authTag: nonEmpty(value.authTag, 1024),
    keyVersion: identifier(value.keyVersion),
    fingerprint: nonEmpty(value.fingerprint, 512),
  };
  if (result.algorithm !== "aes-256-gcm") throw invalid();
  return result;
}

function jsonObject(value, maximumBytes) {
  const result = canonical(value);
  if (!plainRecord(result) || Object.keys(result).length === 0) throw invalid();
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximumBytes) throw invalid();
  return result;
}

function isoTimestamp(value) {
  const timestamp = typeof value === "string" ? value : "";
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) throw invalid();
  return new Date(timestamp).toISOString();
}

function connectionDto(row, duplicate = false) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    version: Number(row.version),
    displayName: row.display_name,
    baseUrl: row.base_url,
    fingerprint: row.fingerprint,
    keyVersion: row.key_version,
    status: row.status,
    statusVersion: Number(row.status_version),
    validationResult: row.validation_result ?? null,
    validatedAt: row.validated_at ?? null,
    activatedAt: row.activated_at ?? null,
    retiredAt: row.retired_at ?? null,
    createdAt: row.created_at ?? null,
    duplicate,
  };
}

function secretResolutionDto(row) {
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

function taskDto(row, duplicate = false) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    connectionId: row.connection_id,
    connectionVersion: Number(row.connection_version),
    status: row.status,
    statusVersion: Number(row.status_version),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    leaseVersion: Number(row.lease_version),
    availableAt: row.available_at ?? null,
    completedAt: row.completed_at ?? null,
    lastErrorCode: row.last_error_code ?? null,
    lastErrorSafe: row.last_error_safe ?? null,
    createdAt: row.created_at ?? null,
    duplicate,
  };
}

function catalogDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    connectionId: row.connection_id,
    connectionVersion: Number(row.connection_version),
    syncTaskId: row.sync_task_id,
    catalog: row.catalog,
    catalogHash: row.catalog_hash,
    capabilityResult: row.capability_result,
    capabilityHash: row.capability_hash,
    testedAt: row.tested_at,
    createdAt: row.created_at ?? null,
  };
}

function profileDto(row, duplicate = false) {
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
    capabilityResult: row.capability_result ?? {},
    capabilityCheckedAt: row.capability_checked_at ?? null,
    connectionId: row.connection_id,
    connectionVersion: row.connection_version == null ? null : Number(row.connection_version),
    createdAt: row.created_at ?? null,
    duplicate,
  };
}

async function query(target, sql, params = []) {
  try {
    return await target.query(sql, params);
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_AI_SETTINGS_")) throw error;
    throw databaseFailed();
  }
}

async function transaction(pool, operation, begin = "BEGIN") {
  let client;
  try { client = await pool.connect(); } catch { throw databaseFailed(); }
  let committed = false;
  try {
    await query(client, begin);
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

async function lockAccount(client, accountId) {
  const result = await query(client, "SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [accountId]);
  if (!result?.rows?.[0]) throw repositoryError("AUTO_LISTING_AI_SETTINGS_SCOPE_NOT_FOUND", 404);
}

function auditId(action, accountId, idempotencyKey) {
  return deterministicId("audit_ai_settings", action, accountId, idempotencyKey);
}

async function loadAudit(client, { action, accountId, idempotencyKey, requestHash }) {
  const eventId = auditId(action, accountId, idempotencyKey);
  const result = await query(client,
    `SELECT metadata
       FROM audit_events
      WHERE event_id=$1 AND account_id=$2 AND action=$3
      FOR UPDATE`,
    [eventId, accountId, action]);
  const metadata = result?.rows?.[0]?.metadata ?? null;
  if (metadata && metadata.requestHash !== requestHash) {
    throw repositoryError("AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", 409);
  }
  return { eventId, metadata };
}

async function insertAudit(client, {
  eventId, action, accountId, actorType, actorId, correlationId, entityType, entityId, metadata,
}) {
  const result = await query(client,
    `INSERT INTO audit_events (
       event_id,account_id,store_id,action,status,actor_type,actor_id,device_id,source,
       entity_type,entity_id,correlation_id,metadata,occurred_at,created_at
     ) VALUES ($1,$2,NULL,$3,'SUCCESS',$4,$5,'','auto-listing-ai-settings',
       $6,$7,$8,$9::JSONB,NOW(),NOW())
     ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
     RETURNING event_id`,
    [eventId, accountId, action, actorType, actorId, entityType, entityId, correlationId, JSON.stringify(metadata)]);
  if (result?.rowCount !== 1) throw repositoryError("AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", 409);
}

async function insertConnectionEvent(client, {
  accountId, connectionId, connectionVersion, eventType, statusVersion, actorId, correlationId, payload = {},
}) {
  const id = deterministicId("aigconn_event", accountId, connectionId, connectionVersion, statusVersion);
  await query(client,
    `INSERT INTO ai_gateway_connection_events (
       account_id,id,connection_id,connection_version,event_type,status_version,
       actor_id,correlation_id,payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::JSONB)`,
    [accountId, id, connectionId, connectionVersion, eventType, statusVersion,
      actorId, correlationId, JSON.stringify(payload)]);
}

async function insertSyncEvent(client, row, eventType, actorId, correlationId, payload = {}) {
  const id = deterministicId("aigsync_event", row.account_id, row.id, row.status_version);
  await query(client,
    `INSERT INTO ai_gateway_model_sync_events (
       account_id,id,task_id,connection_id,connection_version,event_type,status_version,
       lease_version,actor_id,correlation_id,payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::JSONB)`,
    [row.account_id, id, row.id, row.connection_id, row.connection_version, eventType,
      row.status_version, row.lease_version, actorId, correlationId, JSON.stringify(payload)]);
}

async function auditMutation(client, {
  action, accountId, actorId, actorType = "account", correlationId, entityType, entityId, idempotencyKey, requestHash, metadata = {},
}) {
  await insertAudit(client, {
    eventId: auditId(action, accountId, idempotencyKey),
    action,
    accountId,
    actorType,
    actorId,
    correlationId,
    entityType,
    entityId,
    metadata: { requestHash, entityId, ...metadata },
  });
}

function createConnectionRequest(raw) {
  const input = exactKeys(raw, [
    "accountId", "actorId", "baseUrl", "correlationId", "displayName", "encryptedSecret", "idempotencyKey",
  ]);
  const accountId = accountActor(input);
  return {
    accountId,
    actorId: accountId,
    idempotencyKey: identifier(input.idempotencyKey),
    correlationId: identifier(input.correlationId),
    displayName: nonEmpty(input.displayName, 200),
    baseUrl: normalizedBaseUrl(input.baseUrl),
    encryptedSecret: encryptedSecret(input.encryptedSecret),
  };
}

function validationRequest(raw) {
  const input = exactKeys(raw, [
    "accountId", "actorId", "connectionId", "connectionVersion", "correlationId",
    "expectedStatusVersion", "idempotencyKey", "rollbackCapabilityEvidence", "validationResult",
  ]);
  const accountId = accountActor(input);
  const validationResult = jsonObject(input.validationResult, 262_144);
  isoTimestamp(validationResult.checkedAt);
  if (validationResult.outcome !== "PASSED") throw invalid();
  let rollbackCapabilityEvidence = null;
  if (input.rollbackCapabilityEvidence !== null) {
    const evidence = exactKeys(input.rollbackCapabilityEvidence, [
      "capabilityHash", "catalogHash", "catalogId", "schemaVersion",
    ]);
    if (evidence.schemaVersion !== "AI_GATEWAY_ROLLBACK_CAPABILITY_V1"
      || !HASH.test(evidence.capabilityHash) || !HASH.test(evidence.catalogHash)) throw invalid();
    rollbackCapabilityEvidence = {
      schemaVersion: evidence.schemaVersion,
      catalogId: identifier(evidence.catalogId),
      catalogHash: evidence.catalogHash,
      capabilityHash: evidence.capabilityHash,
    };
  }
  return {
    accountId,
    actorId: accountId,
    connectionId: identifier(input.connectionId),
    connectionVersion: positiveInteger(input.connectionVersion),
    expectedStatusVersion: positiveInteger(input.expectedStatusVersion),
    idempotencyKey: identifier(input.idempotencyKey),
    correlationId: identifier(input.correlationId),
    validationResult,
    rollbackCapabilityEvidence,
  };
}

function enqueueRequest(raw) {
  const input = exactKeys(raw, [
    "accountId", "actorId", "connectionId", "connectionVersion", "correlationId",
    "expectedConnectionStatusVersion", "idempotencyKey", "maxAttempts",
  ]);
  const accountId = accountActor(input);
  return {
    accountId,
    actorId: accountId,
    connectionId: identifier(input.connectionId),
    connectionVersion: positiveInteger(input.connectionVersion),
    expectedConnectionStatusVersion: positiveInteger(input.expectedConnectionStatusVersion),
    idempotencyKey: identifier(input.idempotencyKey),
    correlationId: identifier(input.correlationId),
    maxAttempts: boundedInteger(input.maxAttempts, 1, 20),
  };
}

function leaseRequest(raw) {
  const input = exactKeys(raw, ["accountId", "leaseMs", "workerId"]);
  return {
    accountId: identifier(input.accountId),
    workerId: identifier(input.workerId),
    leaseMs: boundedInteger(input.leaseMs, 1, 3_600_000),
  };
}

function completionRequest(raw) {
  const input = exactKeys(raw, [
    "accountId", "capabilityResult", "catalog", "correlationId", "leaseToken",
    "leaseVersion", "taskId", "workerId",
  ]);
  const capabilityResult = jsonObject(input.capabilityResult, 262_144);
  const testedAt = isoTimestamp(capabilityResult.checkedAt);
  const catalog = jsonObject(input.catalog, 1_048_576);
  if (capabilityResult.outcome !== "PASSED" || capabilityResult.text !== true
    || capabilityResult.image !== true
    || !Array.isArray(catalog.models)
    || !catalog.models.some((model) => model?.id && Array.isArray(model.capabilities) && model.capabilities.includes("TEXT"))
    || !catalog.models.some((model) => model?.id && Array.isArray(model.capabilities) && model.capabilities.includes("IMAGE"))) {
    throw capabilityRequired();
  }
  return {
    accountId: identifier(input.accountId),
    workerId: identifier(input.workerId),
    taskId: identifier(input.taskId),
    leaseVersion: positiveInteger(input.leaseVersion),
    leaseToken: identifier(input.leaseToken),
    correlationId: identifier(input.correlationId),
    catalog,
    capabilityResult,
    testedAt,
  };
}

function failureRequest(raw) {
  const input = exactKeys(raw, [
    "accountId", "correlationId", "errorCode", "errorSafe", "leaseToken", "leaseVersion",
    "retryDelayMs", "retryable", "taskId", "workerId",
  ]);
  if (typeof input.retryable !== "boolean") throw invalid();
  return {
    accountId: identifier(input.accountId),
    workerId: identifier(input.workerId),
    taskId: identifier(input.taskId),
    leaseVersion: positiveInteger(input.leaseVersion),
    leaseToken: identifier(input.leaseToken),
    correlationId: identifier(input.correlationId),
    errorCode: identifier(input.errorCode),
    errorSafe: safeText(input.errorSafe),
    retryable: input.retryable,
    retryDelayMs: boundedInteger(input.retryDelayMs, 0, 86_400_000),
  };
}

function profileRequest(raw) {
  const input = exactKeys(raw, [
    "accountId", "actorId", "catalogId", "connectionId", "connectionVersion", "correlationId",
    "displayName", "idempotencyKey", "imageModel", "imageProtocol", "textModel", "textProtocol",
  ]);
  const accountId = accountActor(input);
  const textProtocol = identifier(input.textProtocol);
  const imageProtocol = identifier(input.imageProtocol);
  if (textProtocol !== "SUB2API_RESPONSES"
    || !["SUB2API_RESPONSES_IMAGE_TOOL", "SUB2API_OPENAI_IMAGES"].includes(imageProtocol)) throw invalid();
  return {
    accountId,
    actorId: accountId,
    connectionId: identifier(input.connectionId),
    connectionVersion: positiveInteger(input.connectionVersion),
    catalogId: identifier(input.catalogId),
    displayName: nonEmpty(input.displayName, 200),
    textModel: nonEmpty(input.textModel, 300),
    imageModel: nonEmpty(input.imageModel, 300),
    textProtocol,
    imageProtocol,
    idempotencyKey: identifier(input.idempotencyKey),
    correlationId: identifier(input.correlationId),
  };
}

function catalogHasModel(catalog, modelId, capability) {
  return Array.isArray(catalog?.models) && catalog.models.some((model) => model?.id === modelId
    && Array.isArray(model.capabilities) && model.capabilities.includes(capability));
}

export function createAutoListingAiSettingsPostgres(rawOptions = {}) {
  const { pool } = closedFactory(rawOptions);
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") throw invalid();

  return Object.freeze({
    async createPendingConnection(rawInput = {}) {
      const input = createConnectionRequest(rawInput);
      const action = "AUTO_LISTING_AI_CONNECTION_CREATE";
      const requestHash = hash({ action, accountId: input.accountId, displayName: input.displayName,
        baseUrl: input.baseUrl, encryptedSecret: input.encryptedSecret });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const existing = await query(client,
          `SELECT *, $3::TEXT AS expected_request_hash
             FROM ai_gateway_connection_versions
            WHERE account_id=$1 AND idempotency_key=$2
            FOR UPDATE`,
          [input.accountId, input.idempotencyKey, requestHash]);
        if (existing?.rows?.[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            throw repositoryError("AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", 409);
          }
          return connectionDto(existing.rows[0], true);
        }
        const connectionId = deterministicId("aigconn", input.accountId, input.idempotencyKey);
        const inserted = await query(client,
          `INSERT INTO ai_gateway_connection_versions (
             account_id,id,version,display_name,base_url,
             ciphertext,iv,auth_tag,algorithm,key_version,fingerprint,
             status,status_version,idempotency_key,request_hash,correlation_id,created_by
           ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',1,$11,$12,$13,$14)
           RETURNING *`,
          [input.accountId, connectionId, input.displayName, input.baseUrl,
            input.encryptedSecret.ciphertext, input.encryptedSecret.iv, input.encryptedSecret.authTag,
            input.encryptedSecret.algorithm, input.encryptedSecret.keyVersion, input.encryptedSecret.fingerprint,
            input.idempotencyKey, requestHash, input.correlationId, input.actorId]);
        const row = inserted.rows[0];
        await insertConnectionEvent(client, {
          accountId: input.accountId, connectionId, connectionVersion: 1,
          eventType: "PENDING_CREATED", statusVersion: 1, actorId: input.actorId,
          correlationId: input.correlationId, payload: { requestHash },
        });
        await auditMutation(client, {
          action, ...input, entityType: "ai_gateway_connection_version", entityId: connectionId,
          requestHash, metadata: { connectionVersion: 1 },
        });
        return connectionDto(row, false);
      });
    },

    async loadConnectionForSecretResolution(rawInput = {}) {
      const input = exactKeys(rawInput, ["accountId", "connectionId", "connectionVersion"]);
      const accountId = identifier(input.accountId);
      const connectionId = identifier(input.connectionId);
      const connectionVersion = positiveInteger(input.connectionVersion);
      const result = await query(pool,
        `SELECT * FROM ai_gateway_connection_versions
          WHERE account_id=$1 AND id=$2 AND version=$3 AND status='ACTIVE'`,
        [accountId, connectionId, connectionVersion]);
      return secretResolutionDto(result?.rows?.[0]);
    },

    async markConnectionValidated(rawInput = {}) {
      const input = validationRequest(rawInput);
      const operationAction = "AUTO_LISTING_AI_CONNECTION_ACTIVATE";
      const requestHash = hash({ action: operationAction, accountId: input.accountId,
        connectionId: input.connectionId, connectionVersion: input.connectionVersion,
        expectedStatusVersion: input.expectedStatusVersion, validationResult: input.validationResult,
        rollbackCapabilityEvidence: input.rollbackCapabilityEvidence });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const replay = await loadAudit(client, { ...input, action: operationAction, requestHash });
        if (replay.metadata) {
          const found = await query(client,
            `SELECT * FROM ai_gateway_connection_versions
              WHERE account_id=$1 AND id=$2 AND version=$3`,
            [input.accountId, input.connectionId, input.connectionVersion]);
          return { ...connectionDto(found?.rows?.[0], true), duplicate: true };
        }
        const selected = await query(client,
          `SELECT * FROM ai_gateway_connection_versions
            WHERE account_id=$1 AND id=$2 AND version=$3
            FOR UPDATE`,
          [input.accountId, input.connectionId, input.connectionVersion]);
        const original = selected?.rows?.[0];
        if (!original) throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_FOUND", 404);
        if (Number(original.status_version) !== input.expectedStatusVersion
          || !["PENDING", "RETIRED"].includes(original.status)) {
          throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT", 409);
        }
        if (original.status === "PENDING" && input.rollbackCapabilityEvidence !== null) throw invalid();
        if (original.status === "RETIRED" && input.rollbackCapabilityEvidence === null) {
          throw repositoryError("AUTO_LISTING_AI_SETTINGS_ROLLBACK_EVIDENCE_REQUIRED", 409);
        }
        if (original.status === "RETIRED") {
          const evidence = input.rollbackCapabilityEvidence;
          const catalog = (await query(client,
            `SELECT * FROM ai_gateway_model_catalogs
              WHERE account_id=$1 AND id=$2 AND connection_id=$3 AND connection_version=$4
                AND catalog_hash=$5 AND capability_hash=$6
                AND capability_result->>'outcome'='PASSED'
                AND capability_result->>'text'='true'
                AND capability_result->>'image'='true'
              FOR UPDATE`,
            [input.accountId, evidence.catalogId, input.connectionId, input.connectionVersion,
              evidence.catalogHash, evidence.capabilityHash])).rows[0];
          if (!catalog || hash(input.validationResult) !== catalog.capability_hash) {
            throw repositoryError("AUTO_LISTING_AI_SETTINGS_ROLLBACK_EVIDENCE_REQUIRED", 409);
          }
        }
        const validationHash = hash(input.validationResult);
        const rollbackEvidenceHash = input.rollbackCapabilityEvidence === null
          ? null : hash(input.rollbackCapabilityEvidence);
        const validated = (await query(client,
          `UPDATE ai_gateway_connection_versions
              SET status='VALIDATED',status_version=status_version+1,
                  validation_result=$4::JSONB,validation_hash=$5,
                  validated_at=NOW(),validated_by=$6,
                  rollback_evidence=$8::JSONB,rollback_evidence_hash=$9
            WHERE account_id=$1 AND id=$2 AND version=$3 AND status_version=$7
            RETURNING *`,
          [input.accountId, input.connectionId, input.connectionVersion,
            JSON.stringify(input.validationResult), validationHash, input.actorId, input.expectedStatusVersion,
            input.rollbackCapabilityEvidence === null ? null : JSON.stringify(input.rollbackCapabilityEvidence),
            rollbackEvidenceHash])).rows[0];
        const validationEvent = original.status === "RETIRED" ? "ROLLBACK_VALIDATED" : "VALIDATED";
        await insertConnectionEvent(client, {
          accountId: input.accountId, connectionId: input.connectionId,
          connectionVersion: input.connectionVersion, eventType: validationEvent,
          statusVersion: validated.status_version, actorId: input.actorId,
          correlationId: input.correlationId, payload: { validationHash, rollbackEvidenceHash },
        });
        await auditMutation(client, {
          action: "AUTO_LISTING_AI_CONNECTION_VALIDATED", ...input,
          entityType: "ai_gateway_connection_version", entityId: input.connectionId,
          idempotencyKey: `${input.idempotencyKey}:validated`, requestHash,
          metadata: { connectionVersion: input.connectionVersion, statusVersion: Number(validated.status_version),
            validationHash, rollbackEvidenceHash },
        });

        const currentResult = await query(client,
          `SELECT * FROM ai_gateway_connection_versions
            WHERE account_id=$1 AND status='ACTIVE'
            FOR UPDATE`,
          [input.accountId]);
        for (const current of currentResult.rows) {
          if (current.id === input.connectionId && Number(current.version) === input.connectionVersion) continue;
          const retired = (await query(client,
            `UPDATE ai_gateway_connection_versions
                SET status='RETIRED',status_version=status_version+1,
                    retired_at=NOW(),retired_by=$4
              WHERE account_id=$1 AND id=$2 AND version=$3 AND status='ACTIVE'
              RETURNING *`,
            [input.accountId, current.id, current.version, input.actorId])).rows[0];
          await insertConnectionEvent(client, {
            accountId: input.accountId, connectionId: current.id,
            connectionVersion: Number(current.version), eventType: "RETIRED",
            statusVersion: retired.status_version, actorId: input.actorId,
            correlationId: input.correlationId,
            payload: { supersededById: input.connectionId, supersededByVersion: input.connectionVersion },
          });
          await auditMutation(client, {
            action: "AUTO_LISTING_AI_CONNECTION_RETIRED", ...input,
            entityType: "ai_gateway_connection_version", entityId: current.id,
            idempotencyKey: `${input.idempotencyKey}:retired:${current.id}:${current.version}`,
            requestHash, metadata: { connectionVersion: Number(current.version), statusVersion: Number(retired.status_version) },
          });
        }
        const active = (await query(client,
          `UPDATE ai_gateway_connection_versions
              SET status='ACTIVE',status_version=status_version+1,
                  activated_at=NOW(),activated_by=$4
            WHERE account_id=$1 AND id=$2 AND version=$3 AND status='VALIDATED'
            RETURNING *`,
          [input.accountId, input.connectionId, input.connectionVersion, input.actorId])).rows[0];
        await insertConnectionEvent(client, {
          accountId: input.accountId, connectionId: input.connectionId,
          connectionVersion: input.connectionVersion, eventType: "ACTIVATED",
          statusVersion: active.status_version, actorId: input.actorId,
          correlationId: input.correlationId, payload: { validationHash, rollbackEvidenceHash },
        });
        await auditMutation(client, {
          action: operationAction, ...input,
          entityType: "ai_gateway_connection_version", entityId: input.connectionId,
          requestHash, metadata: { connectionVersion: input.connectionVersion,
            statusVersion: Number(active.status_version), validationHash, rollbackEvidenceHash },
        });
        return connectionDto(active, false);
      });
    },

    async loadSettingsOverview(rawInput = {}) {
      const input = exactKeys(rawInput, ["accountId"]);
      const accountId = identifier(input.accountId);
      return transaction(pool, async (client) => {
        const connections = await query(client, `SELECT * FROM ai_gateway_connection_versions WHERE account_id=$1 ORDER BY created_at DESC,fence DESC`, [accountId]);
        const catalogs = await query(client, `SELECT * FROM ai_gateway_model_catalogs WHERE account_id=$1 ORDER BY created_at DESC`, [accountId]);
        const tasks = await query(client, `SELECT * FROM ai_gateway_model_sync_tasks WHERE account_id=$1 ORDER BY created_at DESC`, [accountId]);
        const profiles = await query(client, `SELECT * FROM ai_gateway_profiles WHERE account_id=$1 ORDER BY created_at DESC`, [accountId]);
        const safeConnections = connections.rows.map((row) => connectionDto(row));
        return {
          accountId,
          activeConnection: safeConnections.find((row) => row.status === "ACTIVE") ?? null,
          connections: safeConnections,
          catalogs: catalogs.rows.map(catalogDto),
          syncTasks: tasks.rows.map(taskDto),
          profiles: profiles.rows.map(profileDto),
        };
      }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    },

    async enqueueModelSync(rawInput = {}) {
      const input = enqueueRequest(rawInput);
      const action = "AUTO_LISTING_AI_MODEL_SYNC_ENQUEUE";
      const requestHash = hash({ action, accountId: input.accountId, connectionId: input.connectionId,
        connectionVersion: input.connectionVersion,
        expectedConnectionStatusVersion: input.expectedConnectionStatusVersion,
        maxAttempts: input.maxAttempts });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const replay = await loadAudit(client, { ...input, action, requestHash });
        if (replay.metadata) {
          const found = await query(client,
            "SELECT * FROM ai_gateway_model_sync_tasks WHERE account_id=$1 AND id=$2",
            [input.accountId, replay.metadata.entityId]);
          return taskDto(found?.rows?.[0], true);
        }
        const connection = (await query(client,
          `SELECT * FROM ai_gateway_connection_versions
            WHERE account_id=$1 AND id=$2 AND version=$3 AND status='ACTIVE'
            FOR UPDATE`,
          [input.accountId, input.connectionId, input.connectionVersion])).rows[0];
        if (!connection) throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_ACTIVE", 409);
        if (Number(connection.status_version) !== input.expectedConnectionStatusVersion) {
          throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT", 409);
        }
        const runnable = (await query(client,
          `SELECT id FROM ai_gateway_model_sync_tasks
            WHERE account_id=$1 AND connection_id=$2 AND connection_version=$3
              AND status IN ('PENDING','LEASED','FAILED')
            FOR UPDATE`,
          [input.accountId, input.connectionId, input.connectionVersion])).rows[0];
        if (runnable) throw repositoryError("AUTO_LISTING_AI_SETTINGS_SYNC_ALREADY_RUNNABLE", 409);
        const taskId = deterministicId("aigsync", input.accountId, input.idempotencyKey);
        const inserted = await query(client,
          `INSERT INTO ai_gateway_model_sync_tasks (
             account_id,id,connection_id,connection_version,status,status_version,
             attempt_count,max_attempts,request_hash,idempotency_key,correlation_id,created_by
           ) VALUES ($1,$2,$3,$4,'PENDING',1,0,$5,$6,$7,$8,$9)
           RETURNING *`,
          [input.accountId, taskId, input.connectionId, input.connectionVersion,
            input.maxAttempts, requestHash, input.idempotencyKey, input.correlationId, input.actorId]);
        const row = inserted.rows[0];
        await insertSyncEvent(client, row, "ENQUEUED", input.actorId, input.correlationId, { requestHash });
        await auditMutation(client, {
          action, ...input, entityType: "ai_gateway_model_sync_task", entityId: taskId,
          requestHash, metadata: { connectionId: input.connectionId, connectionVersion: input.connectionVersion },
        });
        return taskDto(row, false);
      });
    },

    async listRunnableSyncAccountIds(rawInput = {}) {
      const input = exactKeys(rawInput, ["afterAccountId", "limit"]);
      const afterAccountId = input.afterAccountId === null ? "" : identifier(input.afterAccountId);
      const limit = boundedInteger(input.limit, 1, 1000);
      const result = await query(pool,
        `SELECT account_id
          FROM ai_gateway_model_sync_tasks
          WHERE account_id > $1
            AND (((status IN ('PENDING','FAILED') AND available_at <= NOW())
                  AND attempt_count < max_attempts)
              OR (status='LEASED' AND lease_expires_at <= NOW()))
          GROUP BY account_id
          ORDER BY account_id
          LIMIT $2`,
        [afterAccountId, limit]);
      return result.rows.map((row) => row.account_id);
    },

    async claimModelSync(rawInput = {}) {
      const input = leaseRequest(rawInput);
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const selected = await query(client,
          `SELECT * FROM ai_gateway_model_sync_tasks
            WHERE account_id=$1
              AND (((status IN ('PENDING','FAILED') AND available_at <= NOW())
                    AND attempt_count < max_attempts)
                OR (status='LEASED' AND lease_expires_at <= NOW()))
            ORDER BY available_at,created_at,id
            FOR UPDATE SKIP LOCKED
            LIMIT 1`,
          [input.accountId]);
        const current = selected?.rows?.[0];
        if (!current) return null;
        const reclaimed = current.status === "LEASED";
        if (reclaimed && Number(current.attempt_count) >= Number(current.max_attempts)) {
          const expiredLeaseIdentityHash = leaseIdentityHash(current.lease_owner,
            Number(current.lease_version), current.lease_token);
          const dead = (await query(client,
            `UPDATE ai_gateway_model_sync_tasks
                SET status='DEAD',status_version=status_version+1,
                    lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,
                    last_error_code='AUTO_LISTING_AI_MODEL_SYNC_ATTEMPTS_EXHAUSTED',
                    last_error_safe='model sync attempts exhausted',
                    completed_at=NOW(),updated_at=NOW()
              WHERE account_id=$1 AND id=$2 AND status='LEASED' AND lease_expires_at <= NOW()
              RETURNING *`,
            [input.accountId, current.id])).rows[0];
          if (!dead) throw repositoryError("AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", 409);
          const correlationId = `${dead.id}:${dead.lease_version}:expired`;
          await insertSyncEvent(client, dead, "DEAD", input.workerId, correlationId,
            { errorCode: "AUTO_LISTING_AI_MODEL_SYNC_ATTEMPTS_EXHAUSTED", expiredLease: true });
          const requestHash = hash({ action: "AUTO_LISTING_AI_MODEL_SYNC_DEAD", accountId: input.accountId,
            taskId: dead.id, leaseVersion: Number(dead.lease_version), expiredLease: true });
          await auditMutation(client, {
            action: "AUTO_LISTING_AI_MODEL_SYNC_DEAD", accountId: input.accountId,
            actorType: "worker", actorId: input.workerId, correlationId,
            entityType: "ai_gateway_model_sync_task", entityId: dead.id,
            idempotencyKey: `${dead.id}:${dead.lease_version}:DEAD`, requestHash,
            metadata: { leaseVersion: Number(dead.lease_version), leaseIdentityHash: expiredLeaseIdentityHash,
              expiredLease: true },
          });
          return null;
        }
        const leaseToken = `aiglease_${crypto.randomBytes(16).toString("hex")}`;
        const leaseTokenDigest = hash({ leaseToken });
        const updated = (await query(client,
          `UPDATE ai_gateway_model_sync_tasks
              SET status='LEASED',status_version=status_version+1,
                  attempt_count=attempt_count+1,lease_version=lease_version+1,
                  lease_token=$3,lease_owner=$4,
                  lease_expires_at=NOW()+($5::BIGINT * INTERVAL '1 millisecond'),
                  last_error_code=NULL,last_error_safe=NULL,updated_at=NOW()
            WHERE account_id=$1 AND id=$2
            RETURNING *`,
          [input.accountId, current.id, leaseTokenDigest, input.workerId, input.leaseMs])).rows[0];
        const correlationId = `${updated.id}:${updated.lease_version}`;
        const leaseIdentity = leaseIdentityHash(input.workerId,
          Number(updated.lease_version), leaseTokenDigest);
        await insertSyncEvent(client, updated, "LEASED", input.workerId, correlationId,
          { leaseIdentityHash: leaseIdentity, reclaimed });
        const requestHash = hash({ action: "AUTO_LISTING_AI_MODEL_SYNC_LEASE", accountId: input.accountId,
          taskId: updated.id, leaseVersion: Number(updated.lease_version), workerId: input.workerId });
        await auditMutation(client, {
          action: "AUTO_LISTING_AI_MODEL_SYNC_LEASE", accountId: input.accountId,
          actorType: "worker", actorId: input.workerId, correlationId, entityType: "ai_gateway_model_sync_task",
          entityId: updated.id, idempotencyKey: `${updated.id}:${updated.lease_version}`,
          requestHash, metadata: { leaseVersion: Number(updated.lease_version),
            leaseIdentityHash: leaseIdentity, reclaimed },
        });
        return {
          taskId: updated.id,
          accountId: updated.account_id,
          connectionId: updated.connection_id,
          connectionVersion: Number(updated.connection_version),
          attemptCount: Number(updated.attempt_count),
          maxAttempts: Number(updated.max_attempts),
          leaseVersion: Number(updated.lease_version),
          leaseToken,
          leaseExpiresAt: updated.lease_expires_at,
          reclaimed,
        };
      });
    },

    async completeModelSync(rawInput = {}) {
      const input = completionRequest(rawInput);
      const catalogHash = hash(input.catalog);
      const capabilityHash = hash(input.capabilityResult);
      const leaseTokenDigest = hash({ leaseToken: input.leaseToken });
      const leaseIdentity = leaseIdentityHash(input.workerId, input.leaseVersion, leaseTokenDigest);
      const action = "AUTO_LISTING_AI_MODEL_SYNC_SUCCEEDED";
      const idempotencyKey = `${input.taskId}:${input.leaseVersion}:succeeded`;
      const requestHash = hash({ action, accountId: input.accountId,
        taskId: input.taskId, leaseIdentityHash: leaseIdentity, catalogHash, capabilityHash });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const selected = await query(client,
          "SELECT * FROM ai_gateway_model_sync_tasks WHERE account_id=$1 AND id=$2 FOR UPDATE",
          [input.accountId, input.taskId]);
        const task = selected?.rows?.[0];
        if (!task) throw repositoryError("AUTO_LISTING_AI_SETTINGS_SYNC_NOT_FOUND", 404);
        if (task.status === "SUCCEEDED") {
          const replay = await loadAudit(client, {
            action, accountId: input.accountId, idempotencyKey, requestHash,
          });
          if (!replay.metadata) throw repositoryError("AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", 409);
          const found = (await query(client,
            "SELECT * FROM ai_gateway_model_catalogs WHERE account_id=$1 AND sync_task_id=$2",
            [input.accountId, input.taskId])).rows[0];
          if (!found || found.catalog_hash !== catalogHash || found.capability_hash !== capabilityHash) {
            throw repositoryError("AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", 409);
          }
          return { ...taskDto(task, true), catalog: catalogDto(found), duplicate: true };
        }
        if (task.status !== "LEASED" || task.lease_owner !== input.workerId
          || task.lease_token !== leaseTokenDigest
          || Number(task.lease_version) !== input.leaseVersion) {
          throw repositoryError("AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", 409);
        }
        const catalogId = deterministicId("aigcatalog", input.accountId, input.taskId, catalogHash, capabilityHash);
        const catalogRow = (await query(client,
          `INSERT INTO ai_gateway_model_catalogs (
             account_id,id,connection_id,connection_version,sync_task_id,
             catalog,catalog_hash,capability_result,capability_hash,tested_at
           ) VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7,$8::JSONB,$9,$10)
           RETURNING *`,
          [input.accountId, catalogId, task.connection_id, task.connection_version, input.taskId,
            JSON.stringify(input.catalog), catalogHash, JSON.stringify(input.capabilityResult), capabilityHash, input.testedAt])).rows[0];
        const updated = (await query(client,
          `UPDATE ai_gateway_model_sync_tasks
              SET status='SUCCEEDED',status_version=status_version+1,
                  lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,
                  completed_at=NOW(),updated_at=NOW()
            WHERE account_id=$1 AND id=$2
              AND status='LEASED' AND lease_owner=$3 AND lease_version=$4
              AND lease_token=$5 AND lease_expires_at > NOW()
            RETURNING *`,
          [input.accountId, input.taskId, input.workerId, input.leaseVersion,
            leaseTokenDigest])).rows[0];
        if (!updated) throw repositoryError("AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", 409);
        await insertSyncEvent(client, updated, "SUCCEEDED", input.workerId, input.correlationId,
          { catalogId, catalogHash, capabilityHash });
        await auditMutation(client, {
          action, accountId: input.accountId,
          actorType: "worker", actorId: input.workerId, correlationId: input.correlationId,
          entityType: "ai_gateway_model_sync_task", entityId: input.taskId,
          idempotencyKey, requestHash,
          metadata: { catalogId, catalogHash, capabilityHash, leaseVersion: input.leaseVersion,
            leaseIdentityHash: leaseIdentity },
        });
        return { ...taskDto(updated, false), catalog: catalogDto(catalogRow) };
      });
    },

    async failModelSync(rawInput = {}) {
      const input = failureRequest(rawInput);
      const leaseTokenDigest = hash({ leaseToken: input.leaseToken });
      const leaseIdentity = leaseIdentityHash(input.workerId, input.leaseVersion, leaseTokenDigest);
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const selected = await query(client,
          "SELECT * FROM ai_gateway_model_sync_tasks WHERE account_id=$1 AND id=$2 FOR UPDATE",
          [input.accountId, input.taskId]);
        const task = selected?.rows?.[0];
        if (!task) throw repositoryError("AUTO_LISTING_AI_SETTINGS_SYNC_NOT_FOUND", 404);
        const status = input.retryable && Number(task.attempt_count) < Number(task.max_attempts) ? "FAILED" : "DEAD";
        const action = `AUTO_LISTING_AI_MODEL_SYNC_${status}`;
        const requestHash = hash({ action, accountId: input.accountId, taskId: input.taskId,
          leaseIdentityHash: leaseIdentity, errorCode: input.errorCode,
          errorSafe: input.errorSafe, retryable: input.retryable, retryDelayMs: input.retryDelayMs });
        if (task.status === status && Number(task.lease_version) === input.leaseVersion) {
          const replay = await loadAudit(client, {
            action,
            accountId: input.accountId,
            idempotencyKey: `${input.taskId}:${input.leaseVersion}:${status}`,
            requestHash,
          });
          if (replay.metadata) return taskDto(task, true);
        }
        if (task.status !== "LEASED" || task.lease_owner !== input.workerId
          || task.lease_token !== leaseTokenDigest
          || Number(task.lease_version) !== input.leaseVersion) {
          throw repositoryError("AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", 409);
        }
        const updated = (await query(client,
          `UPDATE ai_gateway_model_sync_tasks
              SET status=$3,status_version=status_version+1,
                  lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,
                  available_at=CASE WHEN $3='FAILED'
                    THEN NOW()+($4::BIGINT * INTERVAL '1 millisecond') ELSE available_at END,
                  last_error_code=$5,last_error_safe=$6,
                  completed_at=CASE WHEN $3='DEAD' THEN NOW() ELSE NULL END,
                  updated_at=NOW()
            WHERE account_id=$1 AND id=$2
              AND status='LEASED' AND lease_owner=$7 AND lease_version=$8
              AND lease_token=$9 AND lease_expires_at > NOW()
            RETURNING *`,
          [input.accountId, input.taskId, status, input.retryDelayMs, input.errorCode, input.errorSafe,
            input.workerId, input.leaseVersion, leaseTokenDigest])).rows[0];
        if (!updated) throw repositoryError("AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", 409);
        await insertSyncEvent(client, updated, status, input.workerId, input.correlationId,
          { errorCode: input.errorCode, retryable: input.retryable });
        await auditMutation(client, {
          action, accountId: input.accountId, actorType: "worker", actorId: input.workerId,
          correlationId: input.correlationId, entityType: "ai_gateway_model_sync_task",
          entityId: input.taskId, idempotencyKey: `${input.taskId}:${input.leaseVersion}:${status}`,
          requestHash, metadata: { leaseVersion: input.leaseVersion, leaseIdentityHash: leaseIdentity,
            errorCode: input.errorCode, retryable: input.retryable },
        });
        return taskDto(updated, false);
      });
    },

    async createProfileFromSelection(rawInput = {}) {
      const input = profileRequest(rawInput);
      const action = "AUTO_LISTING_AI_PROFILE_BIND";
      const requestHash = hash({ action, accountId: input.accountId, connectionId: input.connectionId,
        connectionVersion: input.connectionVersion, catalogId: input.catalogId,
        displayName: input.displayName, textModel: input.textModel, imageModel: input.imageModel,
        textProtocol: input.textProtocol, imageProtocol: input.imageProtocol });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const replay = await loadAudit(client, { ...input, action, requestHash });
        if (replay.metadata) {
          const found = await query(client,
            "SELECT * FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2 AND config_version=$3",
            [input.accountId, replay.metadata.entityId, replay.metadata.configVersion]);
          return profileDto(found?.rows?.[0], true);
        }
        const connection = (await query(client,
          `SELECT * FROM ai_gateway_connection_versions
            WHERE account_id=$1 AND id=$2 AND version=$3 AND status='ACTIVE'
            FOR UPDATE`,
          [input.accountId, input.connectionId, input.connectionVersion])).rows[0];
        if (!connection) throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_ACTIVE", 409);
        const catalog = (await query(client,
          `SELECT * FROM ai_gateway_model_catalogs
            WHERE account_id=$1 AND id=$2
              AND connection_id=$3 AND connection_version=$4
            FOR UPDATE`,
          [input.accountId, input.catalogId, input.connectionId, input.connectionVersion])).rows[0];
        if (!catalog) throw repositoryError("AUTO_LISTING_AI_SETTINGS_CATALOG_NOT_FOUND", 404);
        if (catalog.capability_result?.outcome !== "PASSED"
          || catalog.capability_result?.text !== true
          || catalog.capability_result?.image !== true
          || !catalogHasModel(catalog.catalog, input.textModel, "TEXT")
          || !catalogHasModel(catalog.catalog, input.imageModel, "IMAGE")) {
          throw repositoryError("AUTO_LISTING_AI_SETTINGS_MODEL_SELECTION_INVALID");
        }
        const profileId = deterministicId("aigprofile", input.accountId, input.idempotencyKey);
        const inserted = await query(client,
          `INSERT INTO ai_gateway_profiles (
             id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
             text_model,image_model,config_version,capability_result,capability_checked_at,
             enabled,created_by,connection_id,connection_version
           ) VALUES ($1,$2,$3,$4,'SUB2API_ENCRYPTED_KEY',$5,$6,$7,$8,1,$9::JSONB,$10,
             FALSE,$2,$11,$12)
           RETURNING *`,
          [profileId, input.accountId, input.displayName, connection.base_url,
            input.textProtocol, input.imageProtocol, input.textModel, input.imageModel,
            JSON.stringify(catalog.capability_result), catalog.tested_at,
            input.connectionId, input.connectionVersion]);
        const row = inserted.rows[0];
        const bindingEventId = deterministicId("aigprofile_event", input.accountId, profileId, 1);
        await query(client,
          `INSERT INTO ai_gateway_profile_binding_events (
             account_id,id,profile_id,config_version,connection_id,connection_version,
             catalog_id,actor_id,correlation_id,payload
           ) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9::JSONB)`,
          [input.accountId, bindingEventId, profileId, input.connectionId, input.connectionVersion,
            input.catalogId, input.actorId, input.correlationId,
            JSON.stringify({ catalogHash: catalog.catalog_hash, textModel: input.textModel, imageModel: input.imageModel })]);
        await auditMutation(client, {
          action, ...input, entityType: "ai_gateway_profile", entityId: profileId,
          requestHash, metadata: { configVersion: 1, connectionId: input.connectionId,
            connectionVersion: input.connectionVersion, catalogId: input.catalogId },
        });
        return profileDto(row, false);
      });
    },
  });
}

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

function overviewPageSize(value) {
  return boundedInteger(value, 1, 10);
}

function overviewCursor(value, kind) {
  if (value === null) return null;
  const keys = kind === "connections" ? ["createdAt", "fence", "id"] : ["createdAt", "id"];
  const input = exactKeys(value, keys);
  const result = { createdAt: isoTimestamp(input.createdAt), id: identifier(input.id) };
  if (kind === "connections") {
    const fence = typeof input.fence === "string" ? input.fence : "";
    if (!/^[1-9][0-9]{0,18}$/u.test(fence)) throw invalid();
    result.fence = fence;
  }
  return result;
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

function dtoTimestamp(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
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
    validatedAt: dtoTimestamp(row.validated_at),
    activatedAt: dtoTimestamp(row.activated_at),
    retiredAt: dtoTimestamp(row.retired_at),
    createdAt: dtoTimestamp(row.created_at),
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
    syncPurpose: row.sync_purpose,
    targetConnectionStatusVersion: Number(row.target_connection_status_version),
    status: row.status,
    statusVersion: Number(row.status_version),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    leaseVersion: Number(row.lease_version),
    availableAt: dtoTimestamp(row.available_at),
    completedAt: dtoTimestamp(row.completed_at),
    lastErrorCode: row.last_error_code ?? null,
    lastErrorSafe: row.last_error_safe ?? null,
    createdAt: dtoTimestamp(row.created_at),
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
    rollbackEvidenceIdentity: row.rollback_evidence_identity ?? null,
    testedAt: dtoTimestamp(row.tested_at),
    createdAt: dtoTimestamp(row.created_at),
  };
}

function profileActivationDto(row) {
  const action = row?.activation_action ?? null;
  const occurredAt = dtoTimestamp(row?.activation_occurred_at);
  const actorId = row?.activation_actor_id ?? null;
  if (action === null && occurredAt === null && actorId === null) return null;
  if (!["AUTO_LISTING_AI_PROFILE_PUBLISH", "AUTO_LISTING_AI_PROFILE_ROLLBACK"].includes(action)
    || typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))
    || typeof actorId !== "string" || !SAFE_ID.test(actorId)) throw invalid();
  return {
    kind: action === "AUTO_LISTING_AI_PROFILE_PUBLISH" ? "PUBLISH" : "ROLLBACK",
    occurredAt,
    actorId,
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
    capabilityCheckedAt: dtoTimestamp(row.capability_checked_at),
    connectionId: row.connection_id,
    connectionVersion: row.connection_version == null ? null : Number(row.connection_version),
    activation: profileActivationDto(row),
    createdAt: dtoTimestamp(row.created_at),
    duplicate,
  };
}

function connectionPageCursor(row) {
  if (!row) return null;
  const fence = String(row.fence ?? "");
  if (!/^[1-9][0-9]{0,18}$/u.test(fence)) throw invalid();
  return { createdAt: dtoTimestamp(row.created_at), fence, id: identifier(row.id) };
}

function profilePageCursor(row) {
  if (!row) return null;
  return { createdAt: dtoTimestamp(row.created_at), id: identifier(row.id) };
}

async function query(target, sql, params = []) {
  try {
    return await target.query(sql, params);
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_AI_SETTINGS_")) throw error;
    if (error?.code === "23514"
      && error?.message === "active paid capability subcall blocks connection state transition") {
      throw repositoryError("AUTO_LISTING_AI_SETTINGS_CAPABILITY_SUBCALL_CONFLICT", 409, true);
    }
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

async function loadAttemptOutcome(client, {
  accountId, taskId, leaseVersion, workerId, leaseTokenDigest, leaseIdentity, resultHash,
}) {
  const result = await query(client,
    `SELECT * FROM ai_gateway_model_sync_attempt_outcomes
      WHERE account_id=$1 AND task_id=$2 AND lease_version=$3
      FOR UPDATE`,
    [accountId, taskId, leaseVersion]);
  const outcome = result?.rows?.[0] ?? null;
  if (outcome && (outcome.lease_owner !== workerId
    || outcome.lease_token_digest !== leaseTokenDigest
    || outcome.lease_identity_hash !== leaseIdentity
    || outcome.result_hash !== resultHash)) {
    throw repositoryError("AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", 409);
  }
  return outcome;
}

async function insertAttemptOutcome(client, {
  task, leaseOwner, leaseTokenDigest, leaseIdentity, outcome, resultHash,
  taskSnapshot, catalogId = null, catalogHash = null, capabilityHash = null,
  rollbackEvidenceIdentity = null,
}) {
  await query(client,
    `INSERT INTO ai_gateway_model_sync_attempt_outcomes (
       account_id,task_id,connection_id,connection_version,lease_version,
       lease_owner,lease_token_digest,lease_identity_hash,outcome,result_hash,
       task_snapshot,catalog_id,catalog_hash,capability_hash,rollback_evidence_identity
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::JSONB,$12,$13,$14,$15)`,
    [task.account_id, task.id, task.connection_id, task.connection_version, task.lease_version,
      leaseOwner, leaseTokenDigest, leaseIdentity, outcome, resultHash,
      JSON.stringify(taskSnapshot), catalogId, catalogHash, capabilityHash, rollbackEvidenceIdentity]);
}

async function terminalizeExpiredRollbackFence(client, task, {
  actorId, correlationId, resultHash = null, leaseIdentity = null, requireLiveLease = false,
}) {
  const updated = (await query(client,
    `UPDATE ai_gateway_model_sync_tasks t
        SET status='DEAD',status_version=status_version+1,
            lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,
            last_error_code='AUTO_LISTING_AI_ROLLBACK_FENCE_EXPIRED',
            last_error_safe='rollback connection fence expired',
            completed_at=NOW(),updated_at=NOW()
      WHERE t.account_id=$1 AND t.id=$2
        AND t.sync_purpose='ROLLBACK_CAPABILITY'
        AND t.status IN ('PENDING','FAILED','LEASED')
        AND ($3::BOOLEAN=FALSE OR (t.status='LEASED' AND t.lease_owner=$4
          AND t.lease_version=$5 AND t.lease_token=$6 AND t.lease_expires_at > NOW()))
        AND NOT EXISTS (
          SELECT 1 FROM ai_gateway_connection_versions c
          WHERE c.account_id=t.account_id AND c.id=t.connection_id AND c.version=t.connection_version
            AND c.status='RETIRED' AND c.status_version=t.target_connection_status_version
        )
      RETURNING t.*`,
    [task.account_id, task.id, requireLiveLease, task.lease_owner,
      task.lease_version, task.lease_token])).rows[0];
  if (!updated) return null;
  if (task.status === "LEASED") {
    const outcomeResultHash = resultHash ?? hash({
      errorCode: "AUTO_LISTING_AI_ROLLBACK_FENCE_EXPIRED",
      errorSafe: "rollback connection fence expired", retryable: false, retryDelayMs: 0,
    });
    const outcomeLeaseIdentity = leaseIdentity ?? leaseIdentityHash(task.lease_owner,
      Number(task.lease_version), task.lease_token);
    await insertAttemptOutcome(client, {
      task: updated, leaseOwner: task.lease_owner, leaseTokenDigest: task.lease_token,
      leaseIdentity: outcomeLeaseIdentity, outcome: "DEAD", resultHash: outcomeResultHash,
      taskSnapshot: taskDto(updated, false),
    });
  }
  await insertSyncEvent(client, updated, "DEAD", actorId, correlationId,
    { errorCode: "AUTO_LISTING_AI_ROLLBACK_FENCE_EXPIRED", targetConnectionStatusVersion: Number(task.target_connection_status_version) });
  const action = "AUTO_LISTING_AI_MODEL_SYNC_DEAD";
  const requestHash = hash({ action, accountId: task.account_id, taskId: task.id,
    leaseVersion: Number(task.lease_version), statusVersion: Number(updated.status_version),
    errorCode: "AUTO_LISTING_AI_ROLLBACK_FENCE_EXPIRED" });
  await auditMutation(client, {
    action, accountId: task.account_id, actorType: "worker", actorId, correlationId,
    entityType: "ai_gateway_model_sync_task", entityId: task.id,
    idempotencyKey: `${task.id}:${task.lease_version}:rollback-fence:${updated.status_version}`,
    requestHash, metadata: { leaseVersion: Number(task.lease_version),
      statusVersion: Number(updated.status_version), targetConnectionStatusVersion: Number(task.target_connection_status_version),
      errorCode: "AUTO_LISTING_AI_ROLLBACK_FENCE_EXPIRED" },
  });
  return updated;
}

function createConnectionRequest(raw) {
  if (!plainRecord(raw)) throw invalid();
  const hasConnectionId = Object.hasOwn(raw, "connectionId");
  const input = exactKeys(raw, [
    "accountId", "actorId", "baseUrl", "correlationId", "displayName", "encryptedSecret", "idempotencyKey",
    ...(hasConnectionId ? ["connectionId"] : []),
  ]);
  const accountId = accountActor(input);
  const idempotencyKey = identifier(input.idempotencyKey);
  const connectionId = deterministicId("aigconn", accountId, idempotencyKey);
  if (hasConnectionId && identifier(input.connectionId) !== connectionId) throw invalid();
  return {
    accountId,
    actorId: accountId,
    connectionId,
    idempotencyKey,
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
      "capabilityHash", "catalogHash", "catalogId", "evidenceIdentity", "schemaVersion",
      "targetConnectionStatusVersion", "taskId",
    ]);
    if (evidence.schemaVersion !== "AI_GATEWAY_ROLLBACK_CAPABILITY_V2"
      || !HASH.test(evidence.capabilityHash) || !HASH.test(evidence.catalogHash)
      || !HASH.test(evidence.evidenceIdentity)) throw invalid();
    rollbackCapabilityEvidence = {
      schemaVersion: evidence.schemaVersion,
      taskId: identifier(evidence.taskId),
      catalogId: identifier(evidence.catalogId),
      catalogHash: evidence.catalogHash,
      capabilityHash: evidence.capabilityHash,
      evidenceIdentity: evidence.evidenceIdentity,
      targetConnectionStatusVersion: positiveInteger(evidence.targetConnectionStatusVersion),
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
  const baseKeys = [
    "accountId", "actorId", "connectionId", "connectionVersion", "correlationId",
    "expectedConnectionStatusVersion", "idempotencyKey", "maxAttempts",
  ];
  if (!plainRecord(raw)) throw invalid();
  const input = exactKeys(raw, Object.hasOwn(raw, "syncPurpose")
    ? [...baseKeys, "syncPurpose"] : baseKeys);
  const accountId = accountActor(input);
  const syncPurpose = input.syncPurpose === undefined ? "CATALOG_SYNC" : identifier(input.syncPurpose);
  if (!["CATALOG_SYNC", "ROLLBACK_CAPABILITY"].includes(syncPurpose)) throw invalid();
  const maxAttempts = boundedInteger(input.maxAttempts, 1, 20);
  if (syncPurpose === "CATALOG_SYNC" && maxAttempts !== 5) throw invalid();
  return {
    accountId,
    actorId: accountId,
    connectionId: identifier(input.connectionId),
    connectionVersion: positiveInteger(input.connectionVersion),
    expectedConnectionStatusVersion: positiveInteger(input.expectedConnectionStatusVersion),
    idempotencyKey: identifier(input.idempotencyKey),
    correlationId: identifier(input.correlationId),
    maxAttempts,
    syncPurpose,
  };
}

function leaseRequest(raw) {
  if (!plainRecord(raw)) throw invalid();
  const input = exactKeys(raw, Object.hasOwn(raw, "syncPurpose")
    ? ["accountId", "leaseMs", "syncPurpose", "workerId"]
    : ["accountId", "leaseMs", "workerId"]);
  const syncPurpose = input.syncPurpose === undefined ? null : identifier(input.syncPurpose);
  if (syncPurpose !== null && !["CATALOG_SYNC", "ROLLBACK_CAPABILITY"].includes(syncPurpose)) throw invalid();
  return {
    accountId: identifier(input.accountId),
    workerId: identifier(input.workerId),
    leaseMs: boundedInteger(input.leaseMs, 1, 3_600_000),
    syncPurpose,
  };
}

function runnableAccountsRequest(raw) {
  if (!plainRecord(raw)) throw invalid();
  const input = exactKeys(raw, Object.hasOwn(raw, "syncPurpose")
    ? ["afterAccountId", "limit", "syncPurpose"]
    : ["afterAccountId", "limit"]);
  const syncPurpose = input.syncPurpose === undefined ? null : identifier(input.syncPurpose);
  if (syncPurpose !== null && !["CATALOG_SYNC", "ROLLBACK_CAPABILITY"].includes(syncPurpose)) throw invalid();
  return {
    afterAccountId: input.afterAccountId === null ? "" : identifier(input.afterAccountId),
    limit: boundedInteger(input.limit, 1, 1000),
    syncPurpose,
  };
}

function rollbackSecretRequest(raw) {
  const input = exactKeys(raw, [
    "accountId", "leaseToken", "leaseVersion", "taskId", "workerId",
  ]);
  return {
    accountId: identifier(input.accountId),
    taskId: identifier(input.taskId),
    workerId: identifier(input.workerId),
    leaseVersion: positiveInteger(input.leaseVersion),
    leaseToken: identifier(input.leaseToken),
  };
}

function catalogSecretRequest(raw) {
  const input = exactKeys(raw, [
    "accountId", "leaseToken", "leaseVersion", "minimumLeaseRemainingMs", "taskId", "workerId",
  ]);
  return {
    accountId: identifier(input.accountId),
    taskId: identifier(input.taskId),
    workerId: identifier(input.workerId),
    leaseVersion: positiveInteger(input.leaseVersion),
    leaseToken: identifier(input.leaseToken),
    minimumLeaseRemainingMs: boundedInteger(input.minimumLeaseRemainingMs, 15_001, 75_000),
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

function requireRollbackCapabilityResult(capabilityResult, task) {
  exactKeys(capabilityResult, [
    "checkedAt", "checks", "connectionId", "connectionVersion", "outcome", "schemaVersion",
  ]);
  const checks = exactKeys(capabilityResult.checks, ["authentication", "modelsEndpoint"]);
  if (capabilityResult.schemaVersion !== "AI_GATEWAY_ROLLBACK_TEST_RESULT_V1"
    || capabilityResult.outcome !== "PASSED"
    || capabilityResult.connectionId !== task.connection_id
    || capabilityResult.connectionVersion !== Number(task.connection_version)
    || checks.authentication !== true || checks.modelsEndpoint !== true
    || Date.parse(capabilityResult.checkedAt) < Date.parse(task.created_at)) {
    throw repositoryError("AUTO_LISTING_AI_SETTINGS_ROLLBACK_EVIDENCE_REQUIRED", 409);
  }
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

function catalogHasModel(catalog, modelId) {
  return Array.isArray(catalog?.models) && catalog.models.some((model) => model?.id === modelId);
}

function channelDto(row) {
  if (!row) return null;
  return { channelId: row.channel_id, displayName: row.display_name, channelOrder: Number(row.channel_order),
    enabled: row.enabled === true, status: row.status, connectionDisplayName: row.connection_display_name,
    connectionId: row.connection_id, connectionVersion: Number(row.connection_version),
    assignedItemId: row.assigned_item_id ?? null, cooldownUntil: dtoTimestamp(row.cooldown_until),
    requiresRevalidation: row.requires_revalidation === true, lastErrorCode: row.last_error_code ?? null };
}

function channelCandidateDto(row) {
  if (!row) return null;
  return { connectionId: row.connection_id, connectionVersion: Number(row.connection_version),
    connectionDisplayName: row.connection_display_name };
}

function channelListRequest(raw) {
  const input = exactKeys(raw, ["accountId", "profileId", "profileVersion"]);
  return { accountId: identifier(input.accountId), profileId: identifier(input.profileId),
    profileVersion: positiveInteger(input.profileVersion) };
}

function addChannelRequest(raw) {
  const input = exactKeys(raw, ["accountId", "profileId", "profileVersion", "connectionId", "connectionVersion", "displayName", "actorAccountId"]);
  const accountId = identifier(input.accountId);
  if (identifier(input.actorAccountId) !== accountId) throw invalid();
  return { accountId, actorAccountId: accountId, profileId: identifier(input.profileId),
    profileVersion: positiveInteger(input.profileVersion), connectionId: identifier(input.connectionId),
    connectionVersion: positiveInteger(input.connectionVersion), displayName: safeText(input.displayName, 200) };
}

function channelEnabledRequest(raw) {
  const input = exactKeys(raw, ["accountId", "profileId", "profileVersion", "channelId", "enabled", "actorAccountId"]);
  const accountId = identifier(input.accountId);
  if (identifier(input.actorAccountId) !== accountId || typeof input.enabled !== "boolean") throw invalid();
  return { accountId, actorAccountId: accountId, profileId: identifier(input.profileId),
    profileVersion: positiveInteger(input.profileVersion), channelId: identifier(input.channelId), enabled: input.enabled };
}

export function createAutoListingAiSettingsPostgres(rawOptions = {}) {
  const { pool } = closedFactory(rawOptions);
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") throw invalid();

  return Object.freeze({
    connectionIdForIntent(rawInput = {}) {
      const input = exactKeys(rawInput, ["accountId", "idempotencyKey"]);
      return deterministicId("aigconn", identifier(input.accountId), identifier(input.idempotencyKey));
    },

    async createPendingConnection(rawInput = {}) {
      const input = createConnectionRequest(rawInput);
      const action = "AUTO_LISTING_AI_CONNECTION_CREATE";
      const requestHash = hash({ action, accountId: input.accountId, displayName: input.displayName,
        baseUrl: input.baseUrl, encryptedSecret: {
          algorithm: input.encryptedSecret.algorithm,
          keyVersion: input.encryptedSecret.keyVersion,
          fingerprint: input.encryptedSecret.fingerprint,
        } });
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
        const connectionId = input.connectionId;
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
          WHERE account_id=$1 AND id=$2 AND version=$3 AND status IN ('VALIDATED','ACTIVE','RETIRED')`,
        [accountId, connectionId, connectionVersion]);
      return secretResolutionDto(result?.rows?.[0]);
    },

    async loadCatalogSyncConnectionForSecretResolution(rawInput = {}) {
      const input = catalogSecretRequest(rawInput);
      const leaseTokenDigest = hash({ leaseToken: input.leaseToken });
      const result = await query(pool,
        `SELECT c.*,
                (c.status IN ('PENDING','VALIDATED','ACTIVE')
                  AND c.status_version=t.target_connection_status_version)
                  AS catalog_connection_fence_matches
           FROM ai_gateway_model_sync_tasks t
           JOIN ai_gateway_connection_versions c
             ON c.account_id=t.account_id
            AND c.id=t.connection_id
            AND c.version=t.connection_version
          WHERE t.account_id=$1 AND t.id=$2
            AND t.sync_purpose='CATALOG_SYNC'
            AND t.status='LEASED' AND t.lease_owner=$3 AND t.lease_version=$4
            AND t.lease_token=$6
            AND t.lease_expires_at > NOW()+($5::BIGINT * INTERVAL '1 millisecond')`,
        [input.accountId, input.taskId, input.workerId, input.leaseVersion,
          input.minimumLeaseRemainingMs, leaseTokenDigest]);
      const connection = result?.rows?.[0];
      if (!connection) {
        throw repositoryError("AUTO_LISTING_AI_SETTINGS_CATALOG_LEASE_CONFLICT", 409);
      }
      if (connection.catalog_connection_fence_matches !== true) {
        throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT", 409);
      }
      return secretResolutionDto(connection);
    },

    async loadRollbackConnectionForSecretResolution(rawInput = {}) {
      const input = rollbackSecretRequest(rawInput);
      const leaseTokenDigest = hash({ leaseToken: input.leaseToken });
      const result = await query(pool,
        `SELECT c.*
           FROM ai_gateway_model_sync_tasks t
           JOIN ai_gateway_connection_versions c
             ON c.account_id=t.account_id
            AND c.id=t.connection_id
            AND c.version=t.connection_version
          WHERE t.account_id=$1 AND t.id=$2
            AND t.sync_purpose='ROLLBACK_CAPABILITY'
            AND t.status='LEASED' AND t.lease_owner=$3 AND t.lease_version=$4
            AND t.lease_token=$5 AND t.lease_expires_at > NOW()
            AND c.status='RETIRED'
            AND c.status_version=t.target_connection_status_version`,
        [input.accountId, input.taskId, input.workerId, input.leaseVersion, leaseTokenDigest]);
      const connection = result?.rows?.[0];
      if (!connection) {
        throw repositoryError("AUTO_LISTING_AI_SETTINGS_ROLLBACK_LEASE_CONFLICT", 409);
      }
      return secretResolutionDto(connection);
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
        const validationHash = hash(input.validationResult);
        if (original.status === "RETIRED") {
          const evidence = input.rollbackCapabilityEvidence;
          const catalog = (await query(client,
            `SELECT c.*,o.lease_identity_hash AS outcome_lease_identity_hash
              FROM ai_gateway_model_catalogs c
              JOIN ai_gateway_model_sync_tasks t
                ON t.account_id=c.account_id AND t.id=c.sync_task_id
               AND t.connection_id=c.connection_id AND t.connection_version=c.connection_version
              JOIN ai_gateway_model_sync_attempt_outcomes o
                ON o.account_id=t.account_id AND o.task_id=t.id
               AND o.connection_id=t.connection_id AND o.connection_version=t.connection_version
               AND o.outcome='SUCCEEDED' AND o.catalog_id=c.id
              WHERE c.account_id=$1 AND c.id=$2
                AND c.connection_id=$3 AND c.connection_version=$4
                AND c.sync_task_id=$5 AND c.catalog_hash=$6 AND c.capability_hash=$7
                AND c.rollback_evidence_identity=$8
                AND t.status='SUCCEEDED' AND t.sync_purpose='ROLLBACK_CAPABILITY'
                AND t.target_connection_status_version=$9
                AND t.result_evidence_identity=$8
                AND o.rollback_evidence_identity=$8
              FOR UPDATE`,
            [input.accountId, evidence.catalogId, input.connectionId, input.connectionVersion,
              evidence.taskId, evidence.catalogHash, evidence.capabilityHash, evidence.evidenceIdentity,
              evidence.targetConnectionStatusVersion])).rows[0];
          const expectedEvidenceIdentity = catalog ? hash({
            schemaVersion: "AI_GATEWAY_ROLLBACK_EVIDENCE_V1",
            accountId: input.accountId, taskId: evidence.taskId,
            connectionId: input.connectionId, connectionVersion: input.connectionVersion,
            targetConnectionStatusVersion: evidence.targetConnectionStatusVersion,
            leaseIdentityHash: catalog.outcome_lease_identity_hash,
            catalogHash: evidence.catalogHash, capabilityHash: evidence.capabilityHash,
          }) : null;
          if (!catalog || evidence.targetConnectionStatusVersion !== input.expectedStatusVersion
            || validationHash !== catalog.capability_hash
            || evidence.evidenceIdentity !== expectedEvidenceIdentity) {
            throw repositoryError("AUTO_LISTING_AI_SETTINGS_ROLLBACK_EVIDENCE_REQUIRED", 409);
          }
          const consumed = await query(client,
            `INSERT INTO ai_gateway_rollback_evidence_consumptions (
               account_id,catalog_id,task_id,connection_id,connection_version,
               target_connection_status_version,evidence_identity,validation_hash,actor_id,correlation_id
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT DO NOTHING
             RETURNING catalog_id`,
            [input.accountId, evidence.catalogId, evidence.taskId, input.connectionId,
              input.connectionVersion, evidence.targetConnectionStatusVersion,
              evidence.evidenceIdentity, validationHash, input.actorId, input.correlationId]);
          if (consumed.rowCount !== 1) {
            throw repositoryError("AUTO_LISTING_AI_SETTINGS_ROLLBACK_EVIDENCE_CONSUMED", 409);
          }
        }
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
        const catalogs = await query(client, `SELECT * FROM ai_gateway_model_catalogs WHERE account_id=$1 ORDER BY created_at DESC,id DESC`, [accountId]);
        const tasks = await query(client, `SELECT * FROM ai_gateway_model_sync_tasks WHERE account_id=$1 ORDER BY created_at DESC`, [accountId]);
        const profiles = await query(client,
          `SELECT p.*,
                  latest_activation.action AS activation_action,
                  latest_activation.occurred_at AS activation_occurred_at,
                  latest_activation.actor_id AS activation_actor_id
             FROM ai_gateway_profiles p
             LEFT JOIN LATERAL (
               SELECT activation.action,activation.occurred_at,activation.actor_id
                 FROM audit_events activation
                WHERE activation.account_id=p.account_id
                  AND activation.entity_type='ai_gateway_profile'
                  AND activation.entity_id=p.id
                  AND activation.metadata->>'entityId'=p.id
                  AND activation.metadata->>'configVersion'=p.config_version::TEXT
                  AND activation.status='SUCCESS'
                  AND activation.actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
                  AND activation.action IN (
                    'AUTO_LISTING_AI_PROFILE_PUBLISH','AUTO_LISTING_AI_PROFILE_ROLLBACK'
                  )
                ORDER BY activation.occurred_at DESC,activation.event_id DESC NULLS LAST,activation.id DESC
                LIMIT 1
             ) latest_activation ON TRUE
            WHERE p.account_id=$1
            ORDER BY p.created_at DESC,p.id DESC`, [accountId]);
        const safeConnections = connections.rows.map((row) => connectionDto(row));
        return {
          accountId,
          activeConnection: safeConnections.find((row) => row.status === "ACTIVE") ?? null,
          connections: safeConnections,
          catalogs: catalogs.rows.map(catalogDto),
          syncTasks: tasks.rows.map((row) => taskDto(row)),
          profiles: profiles.rows.map((row) => profileDto(row)),
        };
      }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    },

    async loadSettingsOverviewPage(rawInput = {}) {
      const input = exactKeys(rawInput, ["accountId", "connectionCursor", "profileCursor", "pageSize"]);
      const accountId = identifier(input.accountId);
      const connectionCursor = overviewCursor(input.connectionCursor, "connections");
      const profileCursor = overviewCursor(input.profileCursor, "profiles");
      const pageSize = overviewPageSize(input.pageSize);
      return transaction(pool, async (client) => {
        const connectionParams = connectionCursor
          ? [accountId, connectionCursor.createdAt, connectionCursor.fence, connectionCursor.id, pageSize + 1]
          : [accountId, pageSize + 1];
        const connectionRows = (await query(client,
          `SELECT * FROM ai_gateway_connection_versions
            WHERE account_id=$1
              ${connectionCursor ? "AND (created_at,fence,id) < ($2::TIMESTAMPTZ,$3::BIGINT,$4)" : ""}
            ORDER BY created_at DESC,fence DESC,id DESC
            LIMIT $${connectionParams.length}`,
          connectionParams)).rows;
        const activeConnectionRow = (await query(client,
          `SELECT * FROM ai_gateway_connection_versions
            WHERE account_id=$1 AND status='ACTIVE'
            ORDER BY activated_at DESC NULLS LAST,created_at DESC,fence DESC,id DESC
            LIMIT 1`, [accountId])).rows[0] ?? null;

        const profileParams = profileCursor
          ? [accountId, profileCursor.createdAt, profileCursor.id, pageSize + 1]
          : [accountId, pageSize + 1];
        const profileRows = (await query(client,
          `SELECT p.*,
                  latest_activation.action AS activation_action,
                  latest_activation.occurred_at AS activation_occurred_at,
                  latest_activation.actor_id AS activation_actor_id
             FROM ai_gateway_profiles p
             LEFT JOIN LATERAL (
               SELECT activation.action,activation.occurred_at,activation.actor_id
                 FROM audit_events activation
                WHERE activation.account_id=p.account_id
                  AND activation.entity_type='ai_gateway_profile'
                  AND activation.entity_id=p.id
                  AND activation.metadata->>'entityId'=p.id
                  AND activation.metadata->>'configVersion'=p.config_version::TEXT
                  AND activation.status='SUCCESS'
                  AND activation.actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
                  AND activation.action IN (
                    'AUTO_LISTING_AI_PROFILE_PUBLISH','AUTO_LISTING_AI_PROFILE_ROLLBACK'
                  )
                ORDER BY activation.occurred_at DESC,activation.event_id DESC NULLS LAST,activation.id DESC
                LIMIT 1
             ) latest_activation ON TRUE
            WHERE p.account_id=$1
              ${profileCursor ? "AND (p.created_at,p.id) < ($2::TIMESTAMPTZ,$3)" : ""}
            ORDER BY p.created_at DESC,p.id DESC
            LIMIT $${profileParams.length}`,
          profileParams)).rows;
        const activeProfileRow = (await query(client,
          `SELECT p.*,
                  latest_activation.action AS activation_action,
                  latest_activation.occurred_at AS activation_occurred_at,
                  latest_activation.actor_id AS activation_actor_id
             FROM ai_gateway_profiles p
             LEFT JOIN LATERAL (
               SELECT activation.action,activation.occurred_at,activation.actor_id
                 FROM audit_events activation
                WHERE activation.account_id=p.account_id
                  AND activation.entity_type='ai_gateway_profile'
                  AND activation.entity_id=p.id
                  AND activation.metadata->>'entityId'=p.id
                  AND activation.metadata->>'configVersion'=p.config_version::TEXT
                  AND activation.status='SUCCESS'
                  AND activation.actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
                  AND activation.action IN (
                    'AUTO_LISTING_AI_PROFILE_PUBLISH','AUTO_LISTING_AI_PROFILE_ROLLBACK'
                  )
                ORDER BY activation.occurred_at DESC,activation.event_id DESC NULLS LAST,activation.id DESC
                LIMIT 1
             ) latest_activation ON TRUE
            WHERE p.account_id=$1 AND p.enabled=TRUE
            ORDER BY p.created_at DESC,p.id DESC
            LIMIT 1`, [accountId])).rows[0] ?? null;

        const visibleConnections = connectionRows.slice(0, pageSize);
        const visibleProfiles = profileRows.slice(0, pageSize);
        const references = new Map();
        for (const row of [...visibleConnections, activeConnectionRow,
          ...visibleProfiles, activeProfileRow].filter(Boolean)) {
          const id = row.connection_id ?? row.id;
          const version = row.connection_version ?? row.version;
          if (typeof id === "string" && Number.isSafeInteger(Number(version)) && Number(version) > 0) {
            references.set(`${id}\0${version}`, { id, version: Number(version) });
          }
        }
        const refs = [...references.values()];
        let catalogs = [];
        let tasks = [];
        if (refs.length > 0) {
          const ids = refs.map((row) => row.id);
          const versions = refs.map((row) => row.version);
          catalogs = (await query(client,
            `WITH refs(connection_id,connection_version) AS (
               SELECT * FROM UNNEST($2::TEXT[],$3::INTEGER[])
             )
             SELECT DISTINCT ON (c.connection_id,c.connection_version) c.*
               FROM refs r
               JOIN ai_gateway_model_catalogs c
                 ON c.account_id=$1 AND c.connection_id=r.connection_id
                AND c.connection_version=r.connection_version
               JOIN ai_gateway_model_sync_tasks t
                 ON t.account_id=c.account_id AND t.id=c.sync_task_id
                AND t.connection_id=c.connection_id AND t.connection_version=c.connection_version
              WHERE t.sync_purpose='CATALOG_SYNC' AND t.status='SUCCEEDED'
              ORDER BY c.connection_id,c.connection_version,c.created_at DESC,c.id DESC`,
            [accountId, ids, versions])).rows;
          const catalogIds = catalogs.map((row) => row.id);
          tasks = (await query(client,
            `WITH refs(connection_id,connection_version) AS (
               SELECT * FROM UNNEST($2::TEXT[],$3::INTEGER[])
             ), latest AS (
               SELECT latest_task.*
                 FROM refs r
                 CROSS JOIN LATERAL (
                   SELECT t.* FROM ai_gateway_model_sync_tasks t
                    WHERE t.account_id=$1 AND t.connection_id=r.connection_id
                      AND t.connection_version=r.connection_version AND t.sync_purpose='CATALOG_SYNC'
                    ORDER BY t.created_at DESC,t.id DESC LIMIT 1
                 ) latest_task
             ), evidence AS (
               SELECT t.* FROM ai_gateway_model_sync_tasks t
                JOIN ai_gateway_model_catalogs c
                  ON c.account_id=t.account_id AND c.sync_task_id=t.id
               WHERE t.account_id=$1 AND c.id=ANY($4::TEXT[])
             )
             SELECT DISTINCT ON (bounded.id) bounded.*
               FROM (SELECT * FROM latest UNION ALL SELECT * FROM evidence) bounded
              ORDER BY bounded.id,bounded.created_at DESC`,
            [accountId, ids, versions, catalogIds])).rows;
        }
        return {
          accountId,
          activeConnection: connectionDto(activeConnectionRow),
          activeProfile: profileDto(activeProfileRow),
          connections: visibleConnections.map((row) => connectionDto(row)),
          catalogs: catalogs.map(catalogDto),
          syncTasks: tasks.map((row) => taskDto(row)),
          profiles: visibleProfiles.map((row) => profileDto(row)),
          pageInfo: {
            connections: {
              pageSize,
              next: connectionRows.length > pageSize
                ? connectionPageCursor(visibleConnections.at(-1)) : null,
            },
            profiles: {
              pageSize,
              next: profileRows.length > pageSize ? profilePageCursor(visibleProfiles.at(-1)) : null,
            },
          },
        };
      }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    },

    async loadSettingsCatalog(rawInput = {}) {
      const input = exactKeys(rawInput, ["accountId", "catalogId"]);
      const accountId = identifier(input.accountId);
      const catalogId = identifier(input.catalogId);
      const result = await query(pool,
        `SELECT c.*,connection.status AS connection_status
           FROM ai_gateway_model_catalogs c
           JOIN ai_gateway_model_sync_tasks task
             ON task.account_id=c.account_id AND task.id=c.sync_task_id
            AND task.connection_id=c.connection_id AND task.connection_version=c.connection_version
           JOIN ai_gateway_connection_versions connection
             ON connection.account_id=c.account_id AND connection.id=c.connection_id
            AND connection.version=c.connection_version
          WHERE c.account_id=$1 AND c.id=$2
            AND task.sync_purpose='CATALOG_SYNC' AND task.status='SUCCEEDED'
            AND NOT EXISTS (
              SELECT 1 FROM ai_gateway_model_catalogs newer
              JOIN ai_gateway_model_sync_tasks newer_task
                ON newer_task.account_id=newer.account_id AND newer_task.id=newer.sync_task_id
             WHERE newer.account_id=c.account_id AND newer.connection_id=c.connection_id
               AND newer.connection_version=c.connection_version
               AND newer_task.sync_purpose='CATALOG_SYNC' AND newer_task.status='SUCCEEDED'
               AND (newer.created_at,newer.id) > (c.created_at,c.id)
            )
          LIMIT 1`, [accountId, catalogId]);
      const row = result.rows[0] ?? null;
      if (!row) throw repositoryError("AUTO_LISTING_AI_SETTINGS_CATALOG_NOT_FOUND", 404);
      return {
        catalog: catalogDto(row),
        canCreateProfile: ["VALIDATED", "ACTIVE"].includes(row.connection_status),
      };
    },

    async loadSettingsConnection(rawInput = {}) {
      const input = exactKeys(rawInput, ["accountId", "connectionId", "connectionVersion"]);
      const result = await query(pool,
        `SELECT * FROM ai_gateway_connection_versions
          WHERE account_id=$1 AND id=$2 AND version=$3
          LIMIT 1`, [identifier(input.accountId), identifier(input.connectionId),
          positiveInteger(input.connectionVersion)]);
      return connectionDto(result.rows[0] ?? null);
    },

    async listProfileChannels(rawInput = {}) {
      const input = channelListRequest(rawInput);
      return transaction(pool, async (client) => {
        const channels = await query(client,
          `SELECT channel.*, connection.display_name AS connection_display_name,
                  CASE WHEN channel.requires_revalidation THEN 'REQUIRES_REVALIDATION'
                       WHEN NOT channel.enabled THEN 'DISABLED'
                       WHEN channel.cooldown_until > NOW() THEN 'COOLDOWN'
                       WHEN channel.assigned_item_id IS NOT NULL THEN 'BUSY' ELSE 'AVAILABLE' END AS status
             FROM auto_listing_ai_profile_channels channel
             JOIN ai_gateway_connection_versions connection ON connection.account_id=channel.account_id
              AND connection.id=channel.connection_id AND connection.version=channel.connection_version
            WHERE channel.account_id=$1 AND channel.profile_id=$2 AND channel.profile_version=$3
            ORDER BY channel.channel_order`, [input.accountId, input.profileId, input.profileVersion]);
        const candidates = await query(client,
          `SELECT connection.id AS connection_id,connection.version AS connection_version,
                  connection.display_name AS connection_display_name
             FROM ai_gateway_profiles profile
             JOIN ai_gateway_connection_versions connection
               ON connection.account_id=profile.account_id AND connection.status='VALIDATED'
             JOIN LATERAL (
               SELECT catalog.catalog FROM ai_gateway_model_catalogs catalog
               JOIN ai_gateway_model_sync_tasks task ON task.account_id=catalog.account_id AND task.id=catalog.sync_task_id
                 AND task.connection_id=catalog.connection_id AND task.connection_version=catalog.connection_version
                WHERE catalog.account_id=connection.account_id AND catalog.connection_id=connection.id
                  AND catalog.connection_version=connection.version AND task.sync_purpose='CATALOG_SYNC'
                  AND task.status='SUCCEEDED' ORDER BY catalog.created_at DESC,catalog.id DESC LIMIT 1
             ) evidence ON TRUE
            WHERE profile.account_id=$1 AND profile.id=$2 AND profile.config_version=$3 AND profile.enabled=TRUE
              AND profile.text_protocol='SUB2API_RESPONSES'
              AND profile.image_protocol IN ('SUB2API_RESPONSES_IMAGE_TOOL','SUB2API_OPENAI_IMAGES')
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(evidence.catalog->'models') model WHERE model->>'id'=profile.text_model)
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(evidence.catalog->'models') model WHERE model->>'id'=profile.image_model)
              AND NOT EXISTS (SELECT 1 FROM auto_listing_ai_profile_channels channel
                WHERE channel.account_id=profile.account_id AND channel.profile_id=profile.id
                  AND channel.profile_version=profile.config_version AND channel.connection_id=connection.id
                  AND channel.connection_version=connection.version)
            ORDER BY connection.display_name,connection.id,connection.version`,
          [input.accountId, input.profileId, input.profileVersion]);
        return { channels: channels.rows.map(channelDto), channelCandidates: candidates.rows.map(channelCandidateDto) };
      }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    },

    async addProfileChannel(rawInput = {}) {
      const input = addChannelRequest(rawInput);
      const action = "AUTO_LISTING_AI_PROFILE_CHANNEL_ADD";
      const requestHash = hash({ action, accountId: input.accountId, profileId: input.profileId,
        profileVersion: input.profileVersion, connectionId: input.connectionId, connectionVersion: input.connectionVersion });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const profile = (await query(client,
          `SELECT * FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2 AND config_version=$3 AND enabled=TRUE FOR UPDATE`,
          [input.accountId, input.profileId, input.profileVersion])).rows[0];
        if (!profile) throw repositoryError("AUTO_LISTING_AI_PROFILE_CHANNEL_NOT_CURRENT", 409);
        const compatible = (await query(client,
          `SELECT connection.id FROM ai_gateway_connection_versions connection JOIN LATERAL (
             SELECT catalog.catalog FROM ai_gateway_model_catalogs catalog
             JOIN ai_gateway_model_sync_tasks task ON task.account_id=catalog.account_id AND task.id=catalog.sync_task_id
               AND task.connection_id=catalog.connection_id AND task.connection_version=catalog.connection_version
              WHERE catalog.account_id=connection.account_id AND catalog.connection_id=connection.id
                AND catalog.connection_version=connection.version AND task.sync_purpose='CATALOG_SYNC'
                AND task.status='SUCCEEDED' ORDER BY catalog.created_at DESC,catalog.id DESC LIMIT 1
           ) evidence ON TRUE
           WHERE connection.account_id=$1 AND connection.id=$2 AND connection.version=$3 AND connection.status='VALIDATED'
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(evidence.catalog->'models') model WHERE model->>'id'=$4)
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(evidence.catalog->'models') model WHERE model->>'id'=$5)
           FOR UPDATE OF connection`,
          [input.accountId, input.connectionId, input.connectionVersion, profile.text_model, profile.image_model])).rows[0];
        if (!compatible) throw repositoryError("AUTO_LISTING_AI_PROFILE_CHANNEL_CONNECTION_INCOMPATIBLE", 409);
        const next = (await query(client,
          `SELECT COALESCE(MAX(channel_order),0)+1 AS channel_order FROM auto_listing_ai_profile_channels
            WHERE account_id=$1 AND profile_id=$2 AND profile_version=$3`,
          [input.accountId, input.profileId, input.profileVersion])).rows[0];
        const channelId = deterministicId("aigchannel", input.accountId, input.profileId, input.profileVersion,
          input.connectionId, input.connectionVersion);
        await query(client,
          `INSERT INTO auto_listing_ai_profile_channels (
             account_id,profile_id,profile_version,channel_id,display_name,connection_id,connection_version,channel_order
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [input.accountId, input.profileId, input.profileVersion, channelId, input.displayName,
            input.connectionId, input.connectionVersion, Number(next.channel_order)]);
        const row = (await query(client,
          `SELECT channel.*,connection.display_name AS connection_display_name,'AVAILABLE' AS status
             FROM auto_listing_ai_profile_channels channel JOIN ai_gateway_connection_versions connection
               ON connection.account_id=channel.account_id AND connection.id=channel.connection_id
              AND connection.version=channel.connection_version
            WHERE channel.account_id=$1 AND channel.profile_id=$2 AND channel.profile_version=$3 AND channel.channel_id=$4`,
          [input.accountId, input.profileId, input.profileVersion, channelId])).rows[0];
        await auditMutation(client, { action, accountId: input.accountId, actorId: input.actorAccountId,
          correlationId: `channel:${channelId}`, entityType: "auto_listing_ai_profile_channel", entityId: channelId,
          idempotencyKey: channelId, requestHash, metadata: { profileId: input.profileId,
            profileVersion: input.profileVersion, channelId, connectionId: input.connectionId,
            connectionVersion: input.connectionVersion, action: "ADD", result: "SUCCESS" } });
        return channelDto(row);
      });
    },

    async setProfileChannelEnabled(rawInput = {}) {
      const input = channelEnabledRequest(rawInput);
      const action = "AUTO_LISTING_AI_PROFILE_CHANNEL_SET_ENABLED";
      const requestHash = hash({ action, accountId: input.accountId, profileId: input.profileId,
        profileVersion: input.profileVersion, channelId: input.channelId, enabled: input.enabled });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const current = (await query(client,
          `SELECT channel.*,connection.status AS connection_status FROM auto_listing_ai_profile_channels channel
             JOIN ai_gateway_connection_versions connection ON connection.account_id=channel.account_id
              AND connection.id=channel.connection_id AND connection.version=channel.connection_version
            WHERE channel.account_id=$1 AND channel.profile_id=$2 AND channel.profile_version=$3 AND channel.channel_id=$4
            FOR UPDATE OF channel,connection`, [input.accountId, input.profileId, input.profileVersion, input.channelId])).rows[0];
        if (!current) throw repositoryError("AUTO_LISTING_AI_PROFILE_CHANNEL_NOT_FOUND", 404);
        if (input.enabled && current.requires_revalidation === true
          && !["VALIDATED", "ACTIVE"].includes(current.connection_status)) {
          throw repositoryError("AUTO_LISTING_AI_PROFILE_CHANNEL_REVALIDATION_REQUIRED", 409);
        }
        const updated = (await query(client,
          `UPDATE auto_listing_ai_profile_channels SET enabled=$5,
             requires_revalidation=CASE WHEN $5 AND requires_revalidation THEN FALSE ELSE requires_revalidation END,
             updated_at=NOW() WHERE account_id=$1 AND profile_id=$2 AND profile_version=$3 AND channel_id=$4 RETURNING *`,
          [input.accountId, input.profileId, input.profileVersion, input.channelId, input.enabled])).rows[0];
        const row = (await query(client,
          `SELECT channel.*,connection.display_name AS connection_display_name,
             CASE WHEN channel.requires_revalidation THEN 'REQUIRES_REVALIDATION' WHEN NOT channel.enabled THEN 'DISABLED'
                  WHEN channel.cooldown_until > NOW() THEN 'COOLDOWN' WHEN channel.assigned_item_id IS NOT NULL THEN 'BUSY'
                  ELSE 'AVAILABLE' END AS status
             FROM auto_listing_ai_profile_channels channel JOIN ai_gateway_connection_versions connection
               ON connection.account_id=channel.account_id AND connection.id=channel.connection_id
              AND connection.version=channel.connection_version
            WHERE channel.account_id=$1 AND channel.profile_id=$2 AND channel.profile_version=$3 AND channel.channel_id=$4`,
          [input.accountId, input.profileId, input.profileVersion, updated.channel_id])).rows[0];
        await auditMutation(client, { action, accountId: input.accountId, actorId: input.actorAccountId,
          correlationId: `channel:${input.channelId}`, entityType: "auto_listing_ai_profile_channel", entityId: input.channelId,
          idempotencyKey: `${input.channelId}:${input.enabled}`, requestHash, metadata: { profileId: input.profileId,
            profileVersion: input.profileVersion, channelId: input.channelId, action: input.enabled ? "ENABLE" : "DISABLE",
            result: "SUCCESS" } });
        return channelDto(row);
      });
    },

    async enqueueModelSync(rawInput = {}) {
      const input = enqueueRequest(rawInput);
      const action = "AUTO_LISTING_AI_MODEL_SYNC_ENQUEUE";
      const requestHash = hash({ action, accountId: input.accountId, connectionId: input.connectionId,
        connectionVersion: input.connectionVersion,
        expectedConnectionStatusVersion: input.expectedConnectionStatusVersion,
        maxAttempts: input.maxAttempts, syncPurpose: input.syncPurpose });
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
            WHERE account_id=$1 AND id=$2 AND version=$3
              AND (($4='CATALOG_SYNC' AND status IN ('PENDING','VALIDATED','ACTIVE'))
                OR ($4='ROLLBACK_CAPABILITY' AND status='RETIRED'))
            FOR UPDATE`,
          [input.accountId, input.connectionId, input.connectionVersion, input.syncPurpose])).rows[0];
        if (!connection) throw repositoryError(input.syncPurpose === "ROLLBACK_CAPABILITY"
          ? "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_RETIRED"
          : "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_ACTIVE", 409);
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
             account_id,id,connection_id,connection_version,sync_purpose,
             target_connection_status_version,status,status_version,
             attempt_count,max_attempts,request_hash,idempotency_key,correlation_id,created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,'PENDING',1,0,$7,$8,$9,$10,$11)
           RETURNING *`,
          [input.accountId, taskId, input.connectionId, input.connectionVersion, input.syncPurpose,
            input.expectedConnectionStatusVersion, input.maxAttempts, requestHash,
            input.idempotencyKey, input.correlationId, input.actorId]);
        const row = inserted.rows[0];
        await insertSyncEvent(client, row, "ENQUEUED", input.actorId, input.correlationId, { requestHash });
        await auditMutation(client, {
          action, ...input, entityType: "ai_gateway_model_sync_task", entityId: taskId,
          requestHash, metadata: { connectionId: input.connectionId,
            connectionVersion: input.connectionVersion, syncPurpose: input.syncPurpose,
            targetConnectionStatusVersion: input.expectedConnectionStatusVersion },
        });
        return taskDto(row, false);
      });
    },

    async listRunnableSyncAccountIds(rawInput = {}) {
      const input = runnableAccountsRequest(rawInput);
      const result = await query(pool,
        `SELECT account_id
          FROM ai_gateway_model_sync_tasks
          WHERE account_id > $1
            AND ($3::TEXT IS NULL OR sync_purpose=$3)
            AND (((status IN ('PENDING','FAILED') AND available_at <= NOW())
                  AND attempt_count < max_attempts)
              OR (status='LEASED' AND lease_expires_at <= NOW()))
          GROUP BY account_id
          ORDER BY account_id
          LIMIT $2`,
        [input.afterAccountId, input.limit, input.syncPurpose]);
      return result.rows.map((row) => row.account_id);
    },

    async claimModelSync(rawInput = {}) {
      const input = leaseRequest(rawInput);
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const selected = await query(client,
          `SELECT * FROM ai_gateway_model_sync_tasks
            WHERE account_id=$1
              AND ($2::TEXT IS NULL OR sync_purpose=$2)
              AND (((status IN ('PENDING','FAILED') AND available_at <= NOW())
                    AND attempt_count < max_attempts)
                OR (status='LEASED' AND lease_expires_at <= NOW()))
            ORDER BY available_at,created_at,id
            FOR UPDATE SKIP LOCKED
            LIMIT 1`,
          [input.accountId, input.syncPurpose]);
        const current = selected?.rows?.[0];
        if (!current) return null;
        const reclaimed = current.status === "LEASED";
        if (current.sync_purpose === "ROLLBACK_CAPABILITY") {
          const fence = await query(client,
            `SELECT 1 FROM ai_gateway_connection_versions
              WHERE account_id=$1 AND id=$2 AND version=$3
                AND status='RETIRED' AND status_version=$4`,
            [current.account_id, current.connection_id, current.connection_version,
              current.target_connection_status_version]);
          if (!fence?.rows?.[0]) {
            await terminalizeExpiredRollbackFence(client, current, {
              actorId: input.workerId, correlationId: `${current.id}:rollback-fence-expired`,
            });
            return null;
          }
        }
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
          const resultHash = hash({ errorCode: "AUTO_LISTING_AI_MODEL_SYNC_ATTEMPTS_EXHAUSTED",
            errorSafe: "model sync attempts exhausted", retryable: false, retryDelayMs: 0 });
          await insertAttemptOutcome(client, {
            task: dead, leaseOwner: current.lease_owner, leaseTokenDigest: current.lease_token,
            leaseIdentity: expiredLeaseIdentityHash, outcome: "DEAD", resultHash,
            taskSnapshot: taskDto(dead, false),
          });
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
              AND (sync_purpose <> 'ROLLBACK_CAPABILITY' OR EXISTS (
                SELECT 1 FROM ai_gateway_connection_versions c
                WHERE c.account_id=ai_gateway_model_sync_tasks.account_id
                  AND c.id=ai_gateway_model_sync_tasks.connection_id
                  AND c.version=ai_gateway_model_sync_tasks.connection_version
                  AND c.status='RETIRED'
                  AND c.status_version=ai_gateway_model_sync_tasks.target_connection_status_version
              ))
            RETURNING *`,
          [input.accountId, current.id, leaseTokenDigest, input.workerId, input.leaseMs])).rows[0];
        if (!updated) {
          await terminalizeExpiredRollbackFence(client, current, {
            actorId: input.workerId, correlationId: `${current.id}:rollback-fence-expired`,
          });
          return null;
        }
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
        if (updated.sync_purpose === "CATALOG_SYNC" && Number(updated.max_attempts) !== 5) {
          const errorCode = "AUTO_LISTING_AI_MODEL_SYNC_ATTEMPT_POLICY_INVALID";
          const errorSafe = "catalog sync attempt policy is unsupported";
          const dead = (await query(client,
            `UPDATE ai_gateway_model_sync_tasks
                SET status='DEAD',status_version=status_version+1,
                    lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,
                    last_error_code=$6,last_error_safe=$7,
                    completed_at=NOW(),updated_at=NOW()
              WHERE account_id=$1 AND id=$2
                AND status='LEASED' AND lease_owner=$3 AND lease_version=$4
                AND lease_token=$5 AND lease_expires_at > NOW()
              RETURNING *`,
            [input.accountId, updated.id, input.workerId, updated.lease_version,
              leaseTokenDigest, errorCode, errorSafe])).rows[0];
          if (!dead) throw repositoryError("AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", 409);
          const deadCorrelationId = `${dead.id}:${dead.lease_version}:attempt-policy`;
          const resultHash = hash({ errorCode, errorSafe, retryable: false, retryDelayMs: 0 });
          await insertAttemptOutcome(client, {
            task: dead, leaseOwner: input.workerId, leaseTokenDigest, leaseIdentity,
            outcome: "DEAD", resultHash, taskSnapshot: taskDto(dead, false),
          });
          await insertSyncEvent(client, dead, "DEAD", input.workerId, deadCorrelationId,
            { errorCode, historicalMaxAttempts: Number(updated.max_attempts) });
          const deadRequestHash = hash({
            action: "AUTO_LISTING_AI_MODEL_SYNC_DEAD", accountId: input.accountId,
            taskId: dead.id, leaseVersion: Number(dead.lease_version), errorCode,
          });
          await auditMutation(client, {
            action: "AUTO_LISTING_AI_MODEL_SYNC_DEAD", accountId: input.accountId,
            actorType: "worker", actorId: input.workerId, correlationId: deadCorrelationId,
            entityType: "ai_gateway_model_sync_task", entityId: dead.id,
            idempotencyKey: `${dead.id}:${dead.lease_version}:attempt-policy`,
            requestHash: deadRequestHash,
            metadata: { leaseVersion: Number(dead.lease_version), leaseIdentityHash: leaseIdentity,
              errorCode, historicalMaxAttempts: Number(updated.max_attempts) },
          });
          return null;
        }
        return {
          taskId: updated.id,
          accountId: updated.account_id,
          connectionId: updated.connection_id,
          connectionVersion: Number(updated.connection_version),
          syncPurpose: updated.sync_purpose,
          targetConnectionStatusVersion: Number(updated.target_connection_status_version),
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
      const resultHash = hash({ catalogHash, capabilityHash });
      const requestHash = hash({ action, accountId: input.accountId,
        taskId: input.taskId, leaseIdentityHash: leaseIdentity, catalogHash, capabilityHash });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const attemptReplay = await loadAttemptOutcome(client, {
          ...input, leaseTokenDigest, leaseIdentity, resultHash,
        });
        if (attemptReplay) {
          if (attemptReplay.outcome === "DEAD"
            && attemptReplay.task_snapshot?.lastErrorCode === "AUTO_LISTING_AI_ROLLBACK_FENCE_EXPIRED") {
            return { ...attemptReplay.task_snapshot, duplicate: true };
          }
          if (attemptReplay.outcome !== "SUCCEEDED") {
            throw repositoryError("AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", 409);
          }
          const found = (await query(client,
            `SELECT * FROM ai_gateway_model_catalogs
              WHERE account_id=$1 AND id=$2 AND sync_task_id=$3`,
            [input.accountId, attemptReplay.catalog_id, input.taskId])).rows[0];
          if (!found) throw repositoryError("AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", 409);
          return { ...attemptReplay.task_snapshot, catalog: catalogDto(found), duplicate: true };
        }
        const selected = await query(client,
          "SELECT * FROM ai_gateway_model_sync_tasks WHERE account_id=$1 AND id=$2 FOR UPDATE",
          [input.accountId, input.taskId]);
        const task = selected?.rows?.[0];
        if (!task) throw repositoryError("AUTO_LISTING_AI_SETTINGS_SYNC_NOT_FOUND", 404);
        if (task.status !== "LEASED" || task.lease_owner !== input.workerId
          || task.lease_token !== leaseTokenDigest
          || Number(task.lease_version) !== input.leaseVersion) {
          throw repositoryError("AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", 409);
        }
        let rollbackEvidenceIdentity = null;
        if (task.sync_purpose === "CATALOG_SYNC") {
          const fence = await query(client,
            `SELECT status,status_version FROM ai_gateway_connection_versions
              WHERE account_id=$1 AND id=$2 AND version=$3
                AND status IN ('PENDING','VALIDATED','ACTIVE') AND status_version=$4
              FOR KEY SHARE`,
            [task.account_id, task.connection_id, task.connection_version,
              task.target_connection_status_version]);
          if (!fence?.rows?.[0]) {
            throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT", 409);
          }
        } else if (task.sync_purpose === "ROLLBACK_CAPABILITY") {
          const fence = await query(client,
            `SELECT 1 FROM ai_gateway_connection_versions
              WHERE account_id=$1 AND id=$2 AND version=$3
                AND status='RETIRED' AND status_version=$4`,
            [task.account_id, task.connection_id, task.connection_version,
              task.target_connection_status_version]);
          if (!fence?.rows?.[0]) {
            const dead = await terminalizeExpiredRollbackFence(client, task, {
              actorId: input.workerId, correlationId: input.correlationId,
              resultHash, leaseIdentity, requireLiveLease: true,
            });
            if (!dead) throw repositoryError("AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", 409);
            return taskDto(dead, false);
          }
          requireRollbackCapabilityResult(input.capabilityResult, task);
          rollbackEvidenceIdentity = hash({
            schemaVersion: "AI_GATEWAY_ROLLBACK_EVIDENCE_V1",
            accountId: input.accountId, taskId: input.taskId,
            connectionId: task.connection_id, connectionVersion: Number(task.connection_version),
            targetConnectionStatusVersion: Number(task.target_connection_status_version),
            leaseIdentityHash: leaseIdentity, catalogHash, capabilityHash,
          });
        }
        const catalogId = deterministicId("aigcatalog", input.accountId, input.taskId, catalogHash, capabilityHash);
        const updated = (await query(client,
            `UPDATE ai_gateway_model_sync_tasks
              SET status='SUCCEEDED',status_version=status_version+1,
                  lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,
                  result_evidence_identity=$6,completed_at=NOW(),updated_at=NOW()
            WHERE account_id=$1 AND id=$2
              AND status='LEASED' AND lease_owner=$3 AND lease_version=$4
              AND lease_token=$5 AND lease_expires_at > NOW()
              AND ((sync_purpose='CATALOG_SYNC' AND EXISTS (
                  SELECT 1 FROM ai_gateway_connection_versions c
                  WHERE c.account_id=ai_gateway_model_sync_tasks.account_id
                    AND c.id=ai_gateway_model_sync_tasks.connection_id
                    AND c.version=ai_gateway_model_sync_tasks.connection_version
                    AND c.status IN ('PENDING','VALIDATED','ACTIVE')
                    AND c.status_version=ai_gateway_model_sync_tasks.target_connection_status_version
                )) OR (sync_purpose='ROLLBACK_CAPABILITY' AND EXISTS (
                  SELECT 1 FROM ai_gateway_connection_versions c
                  WHERE c.account_id=ai_gateway_model_sync_tasks.account_id
                    AND c.id=ai_gateway_model_sync_tasks.connection_id
                    AND c.version=ai_gateway_model_sync_tasks.connection_version
                    AND c.status='RETIRED'
                    AND c.status_version=ai_gateway_model_sync_tasks.target_connection_status_version
                )))
            RETURNING *`,
          [input.accountId, input.taskId, input.workerId, input.leaseVersion,
            leaseTokenDigest, rollbackEvidenceIdentity])).rows[0];
        if (!updated) throw repositoryError("AUTO_LISTING_AI_SETTINGS_LEASE_CONFLICT", 409);
        await insertAttemptOutcome(client, {
          task: updated, leaseOwner: input.workerId, leaseTokenDigest, leaseIdentity,
          outcome: "SUCCEEDED", resultHash, taskSnapshot: taskDto(updated, false),
          catalogId, catalogHash, capabilityHash, rollbackEvidenceIdentity,
        });
        const catalogRow = (await query(client,
          `INSERT INTO ai_gateway_model_catalogs (
             account_id,id,connection_id,connection_version,sync_task_id,
             catalog,catalog_hash,capability_result,capability_hash,
             rollback_evidence_identity,tested_at
           ) VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7,$8::JSONB,$9,$10,$11)
           RETURNING *`,
          [input.accountId, catalogId, task.connection_id, task.connection_version, input.taskId,
            JSON.stringify(input.catalog), catalogHash, JSON.stringify(input.capabilityResult), capabilityHash,
            rollbackEvidenceIdentity, input.testedAt])).rows[0];
        if (task.sync_purpose === "CATALOG_SYNC") {
          const pending = (await query(client,
            `SELECT status,status_version FROM ai_gateway_connection_versions
              WHERE account_id=$1 AND id=$2 AND version=$3
                AND status_version=$4
              FOR UPDATE`,
            [input.accountId, task.connection_id, task.connection_version,
              task.target_connection_status_version])).rows[0];
          if (!pending) throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT", 409);
          if (pending.status === "PENDING") {
            const validationResult = {
              schemaVersion: "AI_GATEWAY_CONNECTION_TEST_V1",
              outcome: "PASSED",
              checkedAt: input.testedAt,
              checks: { authentication: true, modelsEndpoint: true },
              catalogId,
              catalogHash,
            };
            const validationHash = hash(validationResult);
            const validated = (await query(client,
              `UPDATE ai_gateway_connection_versions
                  SET status='VALIDATED',status_version=status_version+1,
                      validation_result=$5::JSONB,validation_hash=$6,
                      validated_at=NOW(),validated_by=$7
                WHERE account_id=$1 AND id=$2 AND version=$3
                  AND status='PENDING' AND status_version=$4
                RETURNING *`,
              [input.accountId, task.connection_id, task.connection_version,
                task.target_connection_status_version, JSON.stringify(validationResult),
                validationHash, input.workerId])).rows[0];
            if (!validated) throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT", 409);
            await insertConnectionEvent(client, {
              accountId: input.accountId, connectionId: task.connection_id,
              connectionVersion: Number(task.connection_version), eventType: "VALIDATED",
              statusVersion: Number(validated.status_version), actorId: input.workerId,
              correlationId: input.correlationId,
              payload: { validationHash, catalogId, catalogHash, purpose: "MANUAL_CATALOG_SYNC" },
            });
            const validationAction = "AUTO_LISTING_AI_CONNECTION_VALIDATED";
            const validationRequestHash = hash({
              action: validationAction, accountId: input.accountId, taskId: input.taskId,
              connectionId: task.connection_id, connectionVersion: Number(task.connection_version),
              targetConnectionStatusVersion: Number(task.target_connection_status_version),
              catalogId, catalogHash, validationHash,
            });
            await auditMutation(client, {
              action: validationAction, accountId: input.accountId, actorType: "worker",
              actorId: input.workerId, correlationId: input.correlationId,
              entityType: "ai_gateway_connection_version", entityId: task.connection_id,
              idempotencyKey: `${input.taskId}:connection-validated`, requestHash: validationRequestHash,
              metadata: { connectionVersion: Number(task.connection_version),
                statusVersion: Number(validated.status_version), validationHash,
                catalogId, catalogHash, purpose: "MANUAL_CATALOG_SYNC" },
            });
          } else if (!["VALIDATED", "ACTIVE"].includes(pending.status)) {
            throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT", 409);
          }
        }
        await insertSyncEvent(client, updated, "SUCCEEDED", input.workerId, input.correlationId,
          { catalogId, catalogHash, capabilityHash, rollbackEvidenceIdentity });
        await auditMutation(client, {
          action, accountId: input.accountId,
          actorType: "worker", actorId: input.workerId, correlationId: input.correlationId,
          entityType: "ai_gateway_model_sync_task", entityId: input.taskId,
          idempotencyKey, requestHash,
          metadata: { catalogId, catalogHash, capabilityHash, leaseVersion: input.leaseVersion,
            leaseIdentityHash: leaseIdentity, rollbackEvidenceIdentity },
        });
        return { ...taskDto(updated, false), catalog: catalogDto(catalogRow) };
      });
    },

    async failModelSync(rawInput = {}) {
      const input = failureRequest(rawInput);
      const leaseTokenDigest = hash({ leaseToken: input.leaseToken });
      const leaseIdentity = leaseIdentityHash(input.workerId, input.leaseVersion, leaseTokenDigest);
      const resultHash = hash({ errorCode: input.errorCode, errorSafe: input.errorSafe,
        retryable: input.retryable, retryDelayMs: input.retryDelayMs });
      return transaction(pool, async (client) => {
        await lockAccount(client, input.accountId);
        const attemptReplay = await loadAttemptOutcome(client, {
          ...input, leaseTokenDigest, leaseIdentity, resultHash,
        });
        if (attemptReplay) {
          if (!["FAILED", "DEAD"].includes(attemptReplay.outcome)) {
            throw repositoryError("AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", 409);
          }
          return { ...attemptReplay.task_snapshot, duplicate: true };
        }
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
        await insertAttemptOutcome(client, {
          task: updated, leaseOwner: input.workerId, leaseTokenDigest, leaseIdentity,
          outcome: status, resultHash, taskSnapshot: taskDto(updated, false),
        });
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
            WHERE account_id=$1 AND id=$2 AND version=$3 AND status IN ('VALIDATED','ACTIVE')
            FOR UPDATE`,
          [input.accountId, input.connectionId, input.connectionVersion])).rows[0];
        if (!connection) throw repositoryError("AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_ACTIVE", 409);
        const catalog = (await query(client,
          `SELECT ai_gateway_model_catalogs.* FROM ai_gateway_model_catalogs
            JOIN ai_gateway_model_sync_tasks selected_task
              ON selected_task.account_id=ai_gateway_model_catalogs.account_id
             AND selected_task.id=ai_gateway_model_catalogs.sync_task_id
             AND selected_task.connection_id=ai_gateway_model_catalogs.connection_id
             AND selected_task.connection_version=ai_gateway_model_catalogs.connection_version
            WHERE ai_gateway_model_catalogs.account_id=$1 AND ai_gateway_model_catalogs.id=$2
              AND ai_gateway_model_catalogs.connection_id=$3
              AND ai_gateway_model_catalogs.connection_version=$4
              AND selected_task.status='SUCCEEDED' AND selected_task.sync_purpose='CATALOG_SYNC'
              AND NOT EXISTS (
                SELECT 1 FROM ai_gateway_model_catalogs newer
                JOIN ai_gateway_model_sync_tasks newer_task
                  ON newer_task.account_id=newer.account_id AND newer_task.id=newer.sync_task_id
                 AND newer_task.connection_id=newer.connection_id
                 AND newer_task.connection_version=newer.connection_version
                WHERE newer.account_id=ai_gateway_model_catalogs.account_id
                  AND newer.connection_id=ai_gateway_model_catalogs.connection_id
                  AND newer.connection_version=ai_gateway_model_catalogs.connection_version
                  AND newer_task.status='SUCCEEDED' AND newer_task.sync_purpose='CATALOG_SYNC'
                  AND (newer.created_at,newer.id) > (ai_gateway_model_catalogs.created_at,ai_gateway_model_catalogs.id)
              )
            FOR UPDATE OF ai_gateway_model_catalogs`,
          [input.accountId, input.catalogId, input.connectionId, input.connectionVersion])).rows[0];
        if (!catalog) throw repositoryError("AUTO_LISTING_AI_SETTINGS_CATALOG_NOT_FOUND", 404);
        if (!catalogHasModel(catalog.catalog, input.textModel)
          || !catalogHasModel(catalog.catalog, input.imageModel)) {
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

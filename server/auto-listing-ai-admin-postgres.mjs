import crypto from "node:crypto";

const FACTORY_KEYS = new Set(["pool"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
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

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw invalid();
  return result;
}

function version(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_646) throw invalid();
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

function auditIdentity(action, accountId, idempotencyKey) {
  return deterministicId("audit_ai_admin", action, accountId, idempotencyKey);
}

async function loadAudit(client, { action, accountId, idempotencyKey, requestHash }) {
  const eventId = auditIdentity(action, accountId, idempotencyKey);
  const result = await query(client,
    `SELECT metadata,$3::TEXT AS expected_request_hash
       FROM audit_events
      WHERE event_id=$1 AND account_id=$2 AND action=$4
      FOR UPDATE`,
    [eventId, accountId, requestHash, action]);
  const metadata = result?.rows?.[0]?.metadata;
  if (!metadata) return { eventId, metadata: null };
  if (metadata.requestHash !== requestHash) throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
  return { eventId, metadata };
}

async function insertAudit(client, {
  eventId, action, accountId, actorId, correlationId, entityType, entityId, metadata, status = "SUCCESS",
}) {
  const result = await query(client,
    `INSERT INTO audit_events (
       event_id,account_id,store_id,action,status,actor_type,actor_id,device_id,source,
       entity_type,entity_id,correlation_id,metadata,occurred_at,created_at
     ) VALUES ($1,$2,NULL,$3,$9,'account',$4,'','auto-listing-ai-admin',$5,$6,$7,$8::JSONB,NOW(),NOW())
     ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
     RETURNING event_id`,
    [eventId, accountId, action, actorId, entityType, entityId, correlationId, JSON.stringify(metadata), status]);
  if (result?.rowCount !== 1) throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
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
  if (profile.connectionId === null) return null;
  const requiredStatus = purpose === "ROLLBACK_CAPABILITY" ? "RETIRED" : "VALIDATED";
  const result = await query(client,
    `SELECT c.id,c.status_version,c.retired_at,latest.id AS catalog_id
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
        AND c.status='${requiredStatus}'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(latest.catalog->'models') model
                    WHERE model->>'id'=$4)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(latest.catalog->'models') model
                    WHERE model->>'id'=$5)
      FOR UPDATE OF c`,
    [profile.accountId, profile.connectionId, profile.connectionVersion,
      profile.textModel, profile.imageModel]);
  if (!result?.rows?.[0]) {
    throw repositoryError(purpose === "ROLLBACK_CAPABILITY"
      ? "AUTO_LISTING_AI_PROFILE_ROLLBACK_NOT_READY"
      : "AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED", 409);
  }
  return result.rows[0];
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
  if (profile.connectionId === null) return;
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
  return {
    profile,
    attemptId: row.id,
    fence: Number(row.fence),
    status: row.status,
    response: row.response ?? null,
    leaseVersion: Number(row.lease_version),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at ?? null,
  };
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
            AND status IN ('VALIDATED','RETIRED')`,
        [accountId, connectionId, connectionVersion]);
      return capabilitySecretRow(result?.rows?.[0]);
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
        const existing = await query(client,
          `SELECT attempt.id,attempt.fence,attempt.account_id,attempt.profile_id,attempt.config_version,
                  attempt.correlation_id,attempt.status,attempt.response,attempt.lease_version,
                  attempt.lease_token,attempt.lease_expires_at,
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
            return { ...capabilityAttemptRow(existing.rows[0], profile), duplicate: true, reclaimed: false };
          }
        }
        await requireConnectionCapabilityFence(client, profile, input.purpose);
        if (existing.rows[0]) {
          if (existing.rows[0].status === "RUNNING") {
            const leaseToken = `caplease_${crypto.randomUUID().replaceAll("-", "")}`;
            const reclaimed = await query(client,
              `UPDATE ai_gateway_capability_attempts
                  SET lease_version=lease_version+1,lease_token=$5,lease_expires_at=NOW()+INTERVAL '10 minutes'
                WHERE account_id=$1 AND profile_id=$2 AND config_version=$3 AND id=$4
                  AND status='RUNNING' AND lease_expires_at<=NOW()
                RETURNING id,fence,account_id,profile_id,config_version,correlation_id,status,response,
                          lease_version,lease_token,lease_expires_at`,
              [input.accountId, input.profileId, input.configVersion, input.attemptId, leaseToken]);
            if (reclaimed.rows[0]) {
              return { ...capabilityAttemptRow(reclaimed.rows[0], profile), duplicate: false, reclaimed: true };
            }
          }
          return { ...capabilityAttemptRow(existing.rows[0], profile), duplicate: true, reclaimed: false };
        }
        const leaseToken = `caplease_${crypto.randomUUID().replaceAll("-", "")}`;
        const inserted = await query(client,
          `INSERT INTO ai_gateway_capability_attempts (
             id,account_id,profile_id,config_version,correlation_id,status,lease_token,lease_expires_at
           ) VALUES ($1,$2,$3,$4,$5,'RUNNING',$6,NOW()+INTERVAL '10 minutes')
           RETURNING id,fence,account_id,profile_id,config_version,correlation_id,status,response,
                     lease_version,lease_token,lease_expires_at`,
          [input.attemptId, input.accountId, input.profileId, input.configVersion, input.correlationId, leaseToken]);
        const attempt = capabilityAttemptRow(inserted.rows[0], profile);
        if (!attempt || attempt.status !== "RUNNING") throw databaseFailed();
        return { ...attempt, duplicate: false, reclaimed: false };
      });
    },

    async completeCapabilityTest(rawInput = {}) {
      const input = capabilityCompleteRequest(rawInput);
      const action = "AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST";
      const completionHash = hash({ action, accountId: input.accountId, profileId: input.profileId,
        configVersion: input.configVersion, attemptId: input.attemptId, fence: input.fence,
        leaseVersion: input.leaseVersion, purpose: input.purpose, costConfirmed: input.costConfirmed,
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
                  lease_version,lease_token
             FROM ai_gateway_capability_attempts
            WHERE account_id=$1 AND profile_id=$2 AND config_version=$3 AND id=$4
            FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion, input.attemptId]);
        const attempt = found.rows[0];
        if (!attempt || Number(attempt.fence) !== input.fence || attempt.correlation_id !== input.correlationId
          || Number(attempt.lease_version) !== input.leaseVersion || attempt.lease_token !== input.leaseToken) {
          throw repositoryError("AI_GATEWAY_PROFILE_VERSION_CONFLICT", 409);
        }
        if (attempt.status !== "RUNNING") {
          if (attempt.completion_hash !== completionHash || !attempt.response) {
            throw repositoryError("AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT", 409);
          }
          return { applied: attempt.status !== "STALE", stale: attempt.status === "STALE",
            duplicate: true, response: attempt.response };
        }
        await requireConnectionCapabilityFence(client, profile, input.purpose);
        const newest = await query(client,
          `SELECT id,fence FROM ai_gateway_capability_attempts
            WHERE account_id=$1 AND profile_id=$2 AND config_version=$3
            ORDER BY fence DESC LIMIT 1 FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion]);
        const stale = newest.rows[0]?.id !== input.attemptId || Number(newest.rows[0]?.fence) !== input.fence;
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
          return { ...row, duplicate: true };
        }
        const target = await query(client,
          `SELECT id,account_id,display_name,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
                  text_model,image_model,enabled,capability_result,capability_checked_at,
                  connection_id,connection_version,created_at
             FROM ai_gateway_profiles
            WHERE account_id=$1 AND id=$2 AND config_version=$3 FOR UPDATE`,
          [input.accountId, input.profileId, input.configVersion]);
        const rawTarget = target.rows[0];
        if (!rawTarget || rawTarget.account_id !== input.accountId) throw repositoryError("AUTO_LISTING_AI_PROFILE_NOT_FOUND", 404);
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
          `UPDATE ai_gateway_profiles SET enabled=FALSE,updated_at=NOW()
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
        await insertAudit(client, {
          ...input, ...audit, action, entityType: "ai_gateway_profile", entityId: row.id,
          metadata: { requestHash, entityId: row.id, configVersion: row.configVersion },
        });
        return { ...row, duplicate: false };
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
          return { completed: true, duplicate: true, profile: row };
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
          return { ...replayRow, duplicate: true };
        }
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
          `UPDATE ai_gateway_profiles SET enabled=FALSE,updated_at=NOW()
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
        await insertAudit(client, {
          ...input, ...audit, action, entityType: "ai_gateway_profile", entityId: row.id,
          metadata: { requestHash, entityId: row.id, configVersion: row.configVersion,
            purpose: "ROLLBACK_CAPABILITY", attemptId: attempt.id },
        });
        return { ...row, duplicate: false };
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
                  SELECT jsonb_agg((jsonb_build_object(
                    'ruleId',COALESCE(r.rule->>'ruleId',r.id),'ruleOrder',r.rule_order,'matchType',r.rule_kind,
                    'style',r.rule->>'style','textDensityByRole',r.rule->'textDensityByRole'
                  ) || CASE WHEN r.rule_kind='PRODUCT_STYLE'
                    THEN jsonb_build_object('productStyle',r.product_style)
                    ELSE jsonb_build_object('categoryId',COALESCE(r.category_id,r.ancestor_category_id)) END)
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

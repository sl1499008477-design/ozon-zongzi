import crypto from "node:crypto";
import {
  autoListingAiMessagePhaseTarget,
  autoListingAiMessageDedupeKey,
  canonicalizeAutoListingAiMessage,
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";
import {
  AUTO_LISTING_AI_WORK_CONTRACT_VERSION,
  normalizeAutoListingAiWorkMessage,
} from "./auto-listing-ai-work-message.mjs";

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/;
const SENSITIVE_CODE_FRAGMENT = /(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|CREDENTIAL|AUTHORIZATION|BEARER|COOKIE|SESSION_?ID|PRIVATE_?KEY)/u;
const DEFAULT_BASE_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const FACTORY_KEYS = new Set(["pool", "token", "id", "baseRetryMs", "maxRetryMs", "maxAttempts"]);

function problem(code) {
  const error = new Error("自动上架 AI 发件箱操作无效");
  error.code = code;
  error.retryable = code === "AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED";
  return error;
}

function identifier(value) {
  if (!isSafeAutoListingAiIdentifier(value)) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  return value;
}

function exactKeys(value, allowed) {
  const keys = Object.keys(value).sort();
  return allowed.some((candidate) => {
    const expected = [...candidate].sort();
    return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  });
}

function plainInput(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !descriptors[key]?.enumerable || !("value" in descriptors[key]))) {
      throw new Error("invalid");
    }
    const snapshot = Object.create(null);
    for (const key of keys) snapshot[key] = descriptors[key].value;
    return snapshot;
  } catch {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }
}

function factoryOptions(raw) {
  const options = plainInput(raw);
  if (Object.keys(options).some((key) => !FACTORY_KEYS.has(key))) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  return options;
}

function positiveInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  return value;
}

function errorCode(value) {
  if (typeof value !== "string" || !ERROR_CODE.test(value) || SENSITIVE_CODE_FRAGMENT.test(value)) {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }
  return value;
}

function listInput(raw) {
  const input = plainInput(raw);
  if (!exactKeys(input, [["accountId"], ["accountId", "limit"], ["accountId", "limit", "afterId"]])) {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }
  return {
    accountId: identifier(input.accountId),
    limit: input.limit === undefined ? 100 : positiveInteger(input.limit, 100),
    afterId: input.afterId === undefined ? null : identifier(input.afterId),
  };
}

function accountDiscoveryInput(raw) {
  const input = plainInput(raw);
  if (!exactKeys(input, [["afterAccountId", "limit"]])) {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }
  return {
    afterAccountId: input.afterAccountId === null ? null : identifier(input.afterAccountId),
    limit: positiveInteger(input.limit, 100),
  };
}

function reconcileInput(raw) {
  const input = plainInput(raw);
  if (!exactKeys(input, [["accountId", "limit"]])) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  return {
    accountId: identifier(input.accountId),
    limit: positiveInteger(input.limit, 100),
  };
}

function claimInput(raw) {
  const input = plainInput(raw);
  if (!exactKeys(input, [["accountId", "workerId", "limit", "leaseMs"]])) {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }
  return {
    accountId: identifier(input.accountId),
    workerId: identifier(input.workerId),
    limit: positiveInteger(input.limit, 100),
    leaseMs: positiveInteger(input.leaseMs, 24 * 60 * 60 * 1000),
  };
}

function ownershipInput(raw, { lease = false, failure = false } = {}) {
  const input = plainInput(raw);
  const keys = ["accountId", "itemId", "id", "workerId", "leaseToken", ...(lease ? ["leaseMs"] : []), ...(failure ? ["errorCode"] : [])];
  if (!exactKeys(input, [keys])) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  return {
    accountId: identifier(input.accountId),
    itemId: identifier(input.itemId),
    id: identifier(input.id),
    workerId: identifier(input.workerId),
    leaseToken: identifier(input.leaseToken),
    leaseMs: lease ? positiveInteger(input.leaseMs, 24 * 60 * 60 * 1000) : null,
    errorCode: failure ? errorCode(input.errorCode) : null,
  };
}

function publicationOwnershipInput(raw) {
  const input = plainInput(raw);
  const keys = ["accountId", "itemId", "id", "workerId", "leaseToken", "publicationId"];
  if (!exactKeys(input, [keys])) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  return {
    accountId: identifier(input.accountId),
    itemId: identifier(input.itemId),
    id: identifier(input.id),
    workerId: identifier(input.workerId),
    leaseToken: identifier(input.leaseToken),
    publicationId: identifier(input.publicationId),
  };
}

function adoptWorkInput(raw) {
  const input = plainInput(raw);
  const keys = [
    "accountId", "itemId", "id", "publicationId", "dispatchGeneration",
    "relayOwner", "relayToken", "workerId", "workerLeaseToken", "leaseMs",
  ];
  if (!exactKeys(input, [keys])) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  return {
    accountId: identifier(input.accountId),
    itemId: identifier(input.itemId),
    id: identifier(input.id),
    publicationId: identifier(input.publicationId),
    dispatchGeneration: positiveInteger(input.dispatchGeneration, 2_147_483_647),
    relayOwner: identifier(input.relayOwner),
    relayToken: identifier(input.relayToken),
    workerId: identifier(input.workerId),
    workerLeaseToken: identifier(input.workerLeaseToken),
    leaseMs: positiveInteger(input.leaseMs, 24 * 60 * 60 * 1000),
  };
}

function renewWorkInput(raw) {
  const input = plainInput(raw);
  const keys = [
    "accountId", "itemId", "id", "publicationId", "dispatchGeneration",
    "workerId", "leaseToken", "leaseMs",
  ];
  if (!exactKeys(input, [keys])) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  return {
    accountId: identifier(input.accountId),
    itemId: identifier(input.itemId),
    id: identifier(input.id),
    publicationId: identifier(input.publicationId),
    dispatchGeneration: positiveInteger(input.dispatchGeneration, 2_147_483_647),
    workerId: identifier(input.workerId),
    leaseToken: identifier(input.leaseToken),
    leaseMs: positiveInteger(input.leaseMs, 24 * 60 * 60 * 1000),
  };
}

function mapRow(row) {
  if (!row) return null;
  let message;
  try {
    message = normalizeAutoListingAiMessage(row.payload);
    if (message.accountId !== row.account_id || message.itemId !== row.item_id
      || message.phase !== row.phase || message.contractVersion !== row.contract_version
      || autoListingAiMessagePhaseTarget(message) !== row.phase_target_id
      || autoListingAiMessageDedupeKey(message) !== row.dedupe_key) throw new Error("mismatch");
  } catch {
    throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
  }
  if (!["PENDING", "PROCESSING", "COMPLETED", "DEAD"].includes(row.state)
    || !Number.isSafeInteger(row.attempts) || row.attempts < 0) {
    throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
  }
  return Object.freeze({
    id: row.id,
    dedupeKey: row.dedupe_key,
    accountId: row.account_id,
    itemId: row.item_id,
    message,
    status: row.state,
    attemptCount: row.attempts,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    lastErrorCode: row.last_error_code,
    nextAttemptAt: row.next_retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.published_at,
    deadAt: row.dead_at,
  });
}

function mapWorkRow(row) {
  if (!row || !Number.isSafeInteger(row.dispatch_generation) || row.dispatch_generation < 1
    || !(row.lease_expires_at instanceof Date)) {
    throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
  }
  const message = mapRow(row)?.message;
  let workMessage;
  try {
    workMessage = normalizeAutoListingAiWorkMessage({
      workContractVersion: AUTO_LISTING_AI_WORK_CONTRACT_VERSION,
      message,
      execution: {
        outboxId: row.id,
        dispatchGeneration: row.dispatch_generation,
        channelId: row.channel_id,
        connectionId: row.connection_id,
        connectionVersion: row.connection_version,
        leaseOwner: row.lease_owner,
        leaseToken: row.lease_token,
        leaseExpiresAt: row.lease_expires_at.toISOString(),
      },
    });
  } catch {
    throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
  }
  return Object.freeze({
    accountId: row.account_id,
    itemId: row.item_id,
    id: row.id,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    publicationId: row.publication_id,
    workMessage,
  });
}

export function createPostgresAiOutboxRepository(rawOptions = {}) {
  const options = factoryOptions(rawOptions);
  const pool = options.pool;
  const token = options.token ?? (() => crypto.randomUUID());
  const id = options.id ?? ((dedupeKey) => `ai-outbox-${dedupeKey}`);
  const baseRetryMs = options.baseRetryMs ?? DEFAULT_BASE_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let poolQuery;
  let poolConnect;
  try {
    poolQuery = pool?.query;
    poolConnect = pool?.connect;
  } catch { throw problem("AUTO_LISTING_AI_OUTBOX_INVALID"); }
  if (typeof poolQuery !== "function" || typeof poolConnect !== "function"
    || typeof token !== "function" || typeof id !== "function"
    || !Number.isSafeInteger(baseRetryMs) || baseRetryMs < 1
    || !Number.isSafeInteger(maxRetryMs) || maxRetryMs < baseRetryMs
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }
  const query = async (...args) => {
    try { return await poolQuery.call(pool, ...args); } catch { throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED"); }
  };
  const claimed = (result) => {
    const row = mapRow(result.rows?.[0]);
    if (!row) throw problem("AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
    return row;
  };
  const transaction = async (operation) => {
    let client;
    let clientQuery;
    let release;
    let transactionStarted = false;
    try {
      client = await poolConnect.call(pool);
      try {
        clientQuery = client?.query;
        release = client?.release;
      } catch { throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED"); }
      if (typeof clientQuery !== "function" || typeof release !== "function") {
        throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
      }
      await clientQuery.call(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
      transactionStarted = true;
      const value = await operation((...args) => clientQuery.call(client, ...args));
      await clientQuery.call(client, "COMMIT");
      transactionStarted = false;
      return value;
    } catch (error) {
      if (transactionStarted && typeof clientQuery === "function") {
        try { await clientQuery.call(client, "ROLLBACK"); } catch {}
      }
      if (error?.code === "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED"
        || error?.code === "AUTO_LISTING_AI_OUTBOX_INVALID") throw error;
      throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
    } finally {
      if (typeof release === "function") {
        try { release.call(client); } catch {}
      }
    }
  };
  const reconcileDeadMessages = async (input) => {
    const request = reconcileInput(input);
    const frozenLegacyJoin = `
             JOIN auto_listing_jobs AS job
               ON job.account_id=o.account_id AND job.id=o.job_id
             JOIN ai_gateway_profiles AS profile
               ON profile.account_id=job.account_id AND profile.id=job.ai_profile_id
              AND profile.config_version=job.ai_profile_version
              AND profile.connection_id IS NULL`;
    const result = await query(
      `WITH candidates AS MATERIALIZED (
           SELECT o.id AS outbox_id,o.account_id,o.job_id,o.item_id,o.phase,
                  o.correlation_id,o.last_error_code,i.status,i.status_version
             FROM auto_listing_ai_outbox AS o
             JOIN auto_listing_job_items AS i
               ON i.account_id=o.account_id AND i.job_id=o.job_id AND i.id=o.item_id${frozenLegacyJoin}
            WHERE o.account_id=$1 AND o.contract_version IN ('V1','V2','V3') AND o.state='DEAD'
              AND o.dispatch_contract_version IS NULL
              AND i.status_version=o.expected_status_version
              AND ((o.phase IN ('PLAN_CONTENT','MATERIALIZE_SOURCE_ASSET','ANALYZE_SOURCE_IMAGE_BATCH',
                    'RECONCILE_SOURCE_IMAGE_ANALYSIS','CLEAN_SOURCE_IMAGE_OVERLAY',
                    'CHECK_SOURCE_IMAGE_CLEANUP','FINALIZE_MATERIALIZED_PLAN')
                    AND i.status='PLANNING')
                OR (o.phase IN ('GENERATE_IMAGE_SLOT','CHECK_IMAGE_GROUP','GENERATE_RICH_CONTENT')
                    AND i.status='GENERATING'))
            ORDER BY o.dead_at,o.id
            LIMIT $2 FOR UPDATE OF i SKIP LOCKED
         ), updated AS (
           UPDATE auto_listing_job_items AS i
              SET status='RETRYABLE_ERROR',status_version=i.status_version+1,
                  recovery_point=CASE WHEN i.status='PLANNING' THEN 'PLANNING' ELSE 'GENERATION' END,
                  failure_code='AUTO_LISTING_AI_OUTBOX_DEAD',
                  failure_detail_safe='AUTO_LISTING_AI_OUTBOX_DEAD',updated_at=NOW()
             FROM candidates AS c
            WHERE i.account_id=c.account_id AND i.job_id=c.job_id AND i.id=c.item_id
              AND i.status=c.status AND i.status_version=c.status_version
           RETURNING c.*,i.status_version AS transition_version,i.recovery_point
         ), inserted AS (
           INSERT INTO auto_listing_events (
             id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,
             correlation_id,details,transition_version
           )
           SELECT 'ai-dead-recovery-' || md5(account_id || chr(31) || outbox_id),
                  account_id,job_id,item_id,account_id,status,'RETRYABLE_ERROR','RETRYABLE_FAILURE',
                  correlation_id,
                  jsonb_build_object('failureCode','AUTO_LISTING_AI_OUTBOX_DEAD',
                    'recoveryPoint',recovery_point,'outboxId',outbox_id),
                  transition_version
             FROM updated
           RETURNING item_id
         ) SELECT item_id FROM inserted`,
      [request.accountId, request.limit],
    );
    const rows = result.rows || [];
    if (!Array.isArray(rows) || rows.length > request.limit
      || rows.some((row) => !isSafeAutoListingAiIdentifier(row?.item_id))) {
      throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
    }
    return Object.freeze({ recovered: rows.length });
  };

  return Object.freeze({
    async listRunnableAutoListingAiAccountIds(input) {
      const request = accountDiscoveryInput(input);
      const result = await query(
        `SELECT outbox.account_id
         FROM auto_listing_ai_outbox AS outbox
         JOIN auto_listing_jobs AS job
           ON job.account_id=outbox.account_id AND job.id=outbox.job_id
         JOIN ai_gateway_profiles AS profile
           ON profile.account_id=job.account_id AND profile.id=job.ai_profile_id
          AND profile.config_version=job.ai_profile_version
         WHERE outbox.contract_version IN ('V1','V2','V3')
           AND ($1::TEXT IS NULL OR outbox.account_id > $1)
           AND ((outbox.state='PENDING' AND outbox.next_retry_at <= NOW()
                 AND (profile.connection_id IS NOT NULL
                   OR (outbox.dispatch_contract_version IS NULL AND outbox.attempts < $3)))
             OR (outbox.state='PROCESSING' AND outbox.lease_expires_at <= NOW()
                 AND (profile.connection_id IS NOT NULL
                   OR (outbox.dispatch_contract_version IS NULL AND outbox.attempts < $3)))
             OR (profile.connection_id IS NULL AND outbox.state='DEAD'
               AND outbox.dispatch_contract_version IS NULL AND EXISTS (
               SELECT 1 FROM auto_listing_job_items AS i
                WHERE i.account_id=outbox.account_id
                  AND i.job_id=outbox.job_id
                  AND i.id=outbox.item_id
                  AND i.status_version=outbox.expected_status_version
                  AND ((outbox.phase IN ('PLAN_CONTENT','MATERIALIZE_SOURCE_ASSET','ANALYZE_SOURCE_IMAGE_BATCH',
                        'RECONCILE_SOURCE_IMAGE_ANALYSIS','CLEAN_SOURCE_IMAGE_OVERLAY',
                        'CHECK_SOURCE_IMAGE_CLEANUP','FINALIZE_MATERIALIZED_PLAN')
                        AND i.status='PLANNING')
                    OR (outbox.phase IN ('GENERATE_IMAGE_SLOT','CHECK_IMAGE_GROUP','GENERATE_RICH_CONTENT')
                        AND i.status='GENERATING'))
             ))
             OR (profile.connection_id IS NULL AND outbox.state='COMPLETED'
               AND outbox.dispatch_contract_version IS NULL
               AND outbox.published_at <= NOW()-INTERVAL '3 hours'
               AND EXISTS (
                 SELECT 1 FROM auto_listing_job_items AS i
                  WHERE i.account_id=outbox.account_id
                    AND i.job_id=outbox.job_id
                    AND i.id=outbox.item_id
                    AND i.status_version=outbox.expected_status_version
                    AND i.status IN ('PLANNING','GENERATING')
                    AND i.updated_at <= NOW()-INTERVAL '3 hours'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM auto_listing_ai_outbox AS live
                  WHERE live.account_id=outbox.account_id
                    AND live.job_id=outbox.job_id
                    AND live.item_id=outbox.item_id
                    AND live.expected_status_version=outbox.expected_status_version
                    AND live.state IN ('PENDING','PROCESSING')
               )))
         GROUP BY outbox.account_id
         ORDER BY outbox.account_id
         LIMIT $2`,
        [request.afterAccountId, request.limit, maxAttempts],
      );
      const rows = result.rows || [];
      if (!Array.isArray(rows) || rows.length > request.limit) {
        throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
      }
      let accountIds;
      try { accountIds = rows.map((row) => identifier(row?.account_id)); } catch {
        throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
      }
      if (new Set(accountIds).size !== accountIds.length) {
        throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
      }
      return Object.freeze(accountIds);
    },

    async reconcileDeadAutoListingAiMessages(input) {
      return reconcileDeadMessages(input);
    },

    async reconcileDeadLegacyAutoListingAiMessages(input) {
      return reconcileDeadMessages(input);
    },

    async reconcileInterruptedAutoListingAiItems(input) {
      const request = reconcileInput(input);
      const result = await query(
        `WITH candidates AS MATERIALIZED (
           SELECT i.account_id,i.job_id,i.id AS item_id,i.status,i.status_version,j.correlation_id
             FROM auto_listing_job_items AS i
             JOIN auto_listing_jobs AS j ON j.account_id=i.account_id AND j.id=i.job_id
             JOIN ai_gateway_profiles AS profile
               ON profile.account_id=j.account_id AND profile.id=j.ai_profile_id
              AND profile.config_version=j.ai_profile_version AND profile.connection_id IS NULL
            WHERE i.account_id=$1 AND i.status IN ('PLANNING','GENERATING')
              AND i.updated_at <= NOW()-INTERVAL '3 hours'
              AND EXISTS (
                SELECT 1 FROM auto_listing_ai_outbox AS done
                 WHERE done.account_id=i.account_id AND done.job_id=i.job_id AND done.item_id=i.id
                   AND done.contract_version IN ('V1','V2','V3') AND done.state='COMPLETED'
                   AND done.dispatch_contract_version IS NULL
                   AND done.expected_status_version=i.status_version
                   AND done.published_at <= NOW()-INTERVAL '3 hours'
              )
              AND NOT EXISTS (
                SELECT 1 FROM auto_listing_ai_outbox AS live
                 WHERE live.account_id=i.account_id AND live.job_id=i.job_id AND live.item_id=i.id
                   AND live.contract_version IN ('V1','V2','V3') AND live.expected_status_version=i.status_version
                   AND live.state IN ('PENDING','PROCESSING')
              )
            ORDER BY i.updated_at,i.id
            LIMIT $2 FOR UPDATE OF i SKIP LOCKED
         ), updated AS (
           UPDATE auto_listing_job_items AS i
              SET status='RETRYABLE_ERROR',status_version=i.status_version+1,
                  recovery_point=CASE WHEN i.status='PLANNING' THEN 'PLANNING' ELSE 'GENERATION' END,
                  failure_code='AUTO_LISTING_AI_WORKER_INTERRUPTED',
                  failure_detail_safe='AUTO_LISTING_AI_WORKER_INTERRUPTED',updated_at=NOW()
             FROM candidates AS c
            WHERE i.account_id=c.account_id AND i.job_id=c.job_id AND i.id=c.item_id
              AND i.status=c.status AND i.status_version=c.status_version
           RETURNING c.*,i.status_version AS transition_version,i.recovery_point
         ), inserted AS (
           INSERT INTO auto_listing_events (
             id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,
             correlation_id,details,transition_version
           )
           SELECT 'ai-interrupted-recovery-' || md5(account_id || chr(31) || item_id || chr(31) || status_version::TEXT),
                  account_id,job_id,item_id,account_id,status,'RETRYABLE_ERROR','RETRYABLE_FAILURE',
                  correlation_id,
                  jsonb_build_object('failureCode','AUTO_LISTING_AI_WORKER_INTERRUPTED',
                    'recoveryPoint',recovery_point,'interruptedStatusVersion',status_version),
                  transition_version
             FROM updated
           RETURNING item_id
         ) SELECT item_id FROM inserted`,
        [request.accountId, request.limit],
      );
      const rows = result.rows || [];
      if (!Array.isArray(rows) || rows.length > request.limit
        || rows.some((row) => !isSafeAutoListingAiIdentifier(row?.item_id))) {
        throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
      }
      return Object.freeze({ recovered: rows.length });
    },

    async enqueueAutoListingAiMessage(input) {
      let message;
      let dedupeKey;
      try {
        message = normalizeAutoListingAiMessage(input);
        dedupeKey = autoListingAiMessageDedupeKey(message);
      } catch {
        throw problem("AUTO_LISTING_AI_MESSAGE_INVALID");
      }
      let recordId;
      try { recordId = identifier(id(dedupeKey)); } catch { throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED"); }
      const target = autoListingAiMessagePhaseTarget(message);
      const parameters = [
        recordId, message.accountId, message.itemId, message.phase, dedupeKey,
        canonicalizeAutoListingAiMessage(message), message.contractVersion, target,
        message.expectedStatusVersion, message.correlationId,
      ];
      const inserted = await query(
        `INSERT INTO auto_listing_ai_outbox (
           id,account_id,job_id,item_id,slot_key,event_type,dedupe_key,payload,state,attempts,available_at,
           contract_version,phase,phase_target_id,expected_status_version,correlation_id,next_retry_at,
           lease_owner,lease_token,lease_expires_at,publication_id,published_at,dead_at,last_error_code,last_error_safe
         )
         SELECT $1,item.account_id,item.job_id,item.id,
           CASE WHEN $4='GENERATE_IMAGE_SLOT' THEN $8 ELSE NULL END,
           $4,$5,$6::JSONB,'PENDING',0,NOW(),$7,$4,$8,$9,$10,NOW(),
           NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
         FROM auto_listing_job_items AS item
         WHERE item.account_id=$2 AND item.id=$3
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING *`,
        parameters,
      );
      let row = mapRow(inserted.rows?.[0]);
      if (!row) {
        const existing = await query(
          "SELECT * FROM auto_listing_ai_outbox WHERE account_id=$1 AND dedupe_key=$2 AND contract_version IN ('V1','V2','V3')",
          [message.accountId, dedupeKey],
        );
        row = mapRow(existing.rows?.[0]);
      }
      if (!row || canonicalizeAutoListingAiMessage(row.message) !== canonicalizeAutoListingAiMessage(message)) {
        throw problem("AUTO_LISTING_AI_OUTBOX_CONFLICT");
      }
      return row;
    },

    async listAutoListingAiOutbox(input) {
      const request = listInput(input);
      let cursor = null;
      if (request.afterId !== null) {
        const found = await query(
          "SELECT created_at,id FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2 AND contract_version IN ('V1','V2','V3')",
          [request.accountId, request.afterId],
        );
        cursor = found.rows?.[0] || null;
        if (!cursor) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
      }
      const result = await query(
        `SELECT * FROM auto_listing_ai_outbox
         WHERE account_id=$1 AND contract_version IN ('V1','V2','V3')
           AND ($3::TIMESTAMPTZ IS NULL OR (created_at,id) > ($3::TIMESTAMPTZ,$4::TEXT))
         ORDER BY created_at,id LIMIT $2`,
        [request.accountId, request.limit, cursor?.created_at ?? null, cursor?.id ?? null],
      );
      return (result.rows || []).map(mapRow);
    },

    async claimAutoListingAiMessages(input) {
      const request = claimInput(input);
      let nonce;
      try { nonce = identifier(token()); } catch { throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED"); }
      let client;
      let clientQuery;
      let release;
      let transactionStarted = false;
      try {
        client = await poolConnect.call(pool);
        try {
          clientQuery = client?.query;
          release = client?.release;
        } catch { throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED"); }
        if (typeof clientQuery !== "function" || typeof release !== "function") {
          throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
        }
        await clientQuery.call(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
        transactionStarted = true;
        const locked = await clientQuery.call(
          client,
          `WITH exhausted AS (
             UPDATE auto_listing_ai_outbox AS exhausted_outbox
                SET state='DEAD',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                    last_error_code='AUTO_LISTING_AI_LEASE_EXHAUSTED',dead_at=NOW(),next_retry_at=NULL,updated_at=NOW()
              WHERE exhausted_outbox.account_id=$1 AND exhausted_outbox.contract_version IN ('V1','V2','V3')
                AND exhausted_outbox.dispatch_contract_version IS NULL
                AND exhausted_outbox.state='PROCESSING'
                AND exhausted_outbox.lease_expires_at <= NOW() AND exhausted_outbox.attempts >= $3
                AND EXISTS (
                  SELECT 1
                    FROM auto_listing_jobs AS exhausted_job
                    JOIN ai_gateway_profiles AS exhausted_profile
                      ON exhausted_profile.account_id=exhausted_job.account_id
                     AND exhausted_profile.id=exhausted_job.ai_profile_id
                     AND exhausted_profile.config_version=exhausted_job.ai_profile_version
                     AND exhausted_profile.connection_id IS NULL
                   WHERE exhausted_job.account_id=exhausted_outbox.account_id
                     AND exhausted_job.id=exhausted_outbox.job_id
                )
              RETURNING exhausted_outbox.id
           )
           SELECT job.id AS job_id
             FROM auto_listing_jobs AS job
             JOIN ai_gateway_profiles AS profile
               ON profile.account_id=job.account_id AND profile.id=job.ai_profile_id
              AND profile.config_version=job.ai_profile_version
              AND profile.connection_id IS NULL
             JOIN LATERAL (
               SELECT outbox.created_at,outbox.id
                 FROM auto_listing_ai_outbox AS outbox
                 JOIN auto_listing_job_items AS item
                   ON item.account_id=outbox.account_id AND item.job_id=outbox.job_id AND item.id=outbox.item_id
                WHERE outbox.account_id=job.account_id AND outbox.job_id=job.id
                  AND outbox.contract_version IN ('V1','V2','V3') AND outbox.dispatch_contract_version IS NULL
                  AND outbox.attempts < $3
                  AND ((outbox.state='PENDING' AND outbox.next_retry_at <= NOW())
                    OR (outbox.state='PROCESSING' AND outbox.lease_expires_at <= NOW()))
                  AND NOT EXISTS (
                    SELECT 1 FROM auto_listing_job_items AS predecessor
                     WHERE predecessor.account_id=item.account_id AND predecessor.job_id=item.job_id
                       AND predecessor.source_order < item.source_order
                       AND predecessor.status NOT IN ('SUCCEEDED','READY_FOR_REVIEW','RETRYABLE_ERROR','BLOCKED','CANCELLED')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM auto_listing_ai_outbox AS live
                     WHERE live.account_id=outbox.account_id AND live.job_id=outbox.job_id
                       AND live.id<>outbox.id AND live.contract_version IN ('V1','V2','V3')
                       AND live.state='PROCESSING' AND live.lease_expires_at > NOW()
                  )
                ORDER BY outbox.created_at,outbox.id
                LIMIT 1
             ) AS earliest ON TRUE
            WHERE job.account_id=$1
            ORDER BY earliest.created_at,earliest.id,job.id
            LIMIT $2 FOR UPDATE OF job SKIP LOCKED`,
          [request.accountId, request.limit, maxAttempts],
        );
        const lockedRows = locked.rows || [];
        if (!Array.isArray(lockedRows) || lockedRows.length > request.limit
          || lockedRows.some((row) => !isSafeAutoListingAiIdentifier(row?.job_id))) {
          throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
        }
        const jobIds = lockedRows.map((row) => row.job_id);
        let rows = [];
        if (jobIds.length > 0) {
          const result = await clientQuery.call(
            client,
            `WITH candidates AS MATERIALIZED (
               SELECT candidate.id
                 FROM unnest($6::TEXT[]) WITH ORDINALITY AS locked(job_id,lock_order)
                 CROSS JOIN LATERAL (
                   SELECT outbox.id
                     FROM auto_listing_ai_outbox AS outbox
                     JOIN auto_listing_job_items AS item
                       ON item.account_id=outbox.account_id AND item.job_id=outbox.job_id AND item.id=outbox.item_id
                     JOIN auto_listing_jobs AS frozen_job
                       ON frozen_job.account_id=outbox.account_id AND frozen_job.id=outbox.job_id
                     JOIN ai_gateway_profiles AS profile
                       ON profile.account_id=frozen_job.account_id AND profile.id=frozen_job.ai_profile_id
                      AND profile.config_version=frozen_job.ai_profile_version
                      AND profile.connection_id IS NULL
                    WHERE outbox.account_id=$1 AND outbox.job_id=locked.job_id
                      AND outbox.contract_version IN ('V1','V2','V3') AND outbox.dispatch_contract_version IS NULL
                      AND outbox.attempts < $5
                      AND ((outbox.state='PENDING' AND outbox.next_retry_at <= NOW())
                        OR (outbox.state='PROCESSING' AND outbox.lease_expires_at <= NOW()))
                      AND NOT EXISTS (
                        SELECT 1 FROM auto_listing_job_items AS predecessor
                         WHERE predecessor.account_id=item.account_id AND predecessor.job_id=item.job_id
                           AND predecessor.source_order < item.source_order
                           AND predecessor.status NOT IN ('SUCCEEDED','READY_FOR_REVIEW','RETRYABLE_ERROR','BLOCKED','CANCELLED')
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM auto_listing_ai_outbox AS live
                         WHERE live.account_id=outbox.account_id AND live.job_id=outbox.job_id
                           AND live.id<>outbox.id AND live.contract_version IN ('V1','V2','V3')
                           AND live.state='PROCESSING' AND live.lease_expires_at > NOW()
                      )
                    ORDER BY outbox.created_at,outbox.id
                    LIMIT 1 FOR UPDATE OF outbox SKIP LOCKED
                 ) AS candidate
                ORDER BY locked.lock_order
             )
             UPDATE auto_listing_ai_outbox AS outbox
                SET state='PROCESSING',attempts=outbox.attempts+1,lease_owner=$2,
                    lease_token=$3 || ':' || (outbox.attempts+1)::TEXT,
                    lease_expires_at=NOW()+($4 * INTERVAL '1 millisecond'),updated_at=NOW()
               FROM candidates
              WHERE outbox.id=candidates.id AND outbox.account_id=$1
                AND outbox.dispatch_contract_version IS NULL
                AND EXISTS (
                  SELECT 1
                    FROM auto_listing_jobs AS claimed_job
                    JOIN ai_gateway_profiles AS claimed_profile
                      ON claimed_profile.account_id=claimed_job.account_id
                     AND claimed_profile.id=claimed_job.ai_profile_id
                     AND claimed_profile.config_version=claimed_job.ai_profile_version
                     AND claimed_profile.connection_id IS NULL
                   WHERE claimed_job.account_id=outbox.account_id
                     AND claimed_job.id=outbox.job_id
                )
              RETURNING outbox.*`,
            [request.accountId, request.workerId, nonce, request.leaseMs, maxAttempts, jobIds],
          );
          rows = (result.rows || []).map(mapRow);
        }
        await clientQuery.call(client, "COMMIT");
        transactionStarted = false;
        return rows;
      } catch {
        if (transactionStarted && typeof clientQuery === "function") {
          try { await clientQuery.call(client, "ROLLBACK"); } catch {}
        }
        throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
      } finally {
        if (typeof release === "function") {
          try { release.call(client); } catch {}
        }
      }
    },

    async claimLegacyAutoListingAiMessages(input) {
      return this.claimAutoListingAiMessages(input);
    },

    async claimAutoListingAiWork(input) {
      const request = claimInput(input);
      let client;
      let clientQuery;
      let release;
      let transactionStarted = false;
      try {
        client = await poolConnect.call(pool);
        try {
          clientQuery = client?.query;
          release = client?.release;
        } catch { throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED"); }
        if (typeof clientQuery !== "function" || typeof release !== "function") {
          throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
        }
        await clientQuery.call(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
        transactionStarted = true;
        await clientQuery.call(
          client,
          `/* auto-listing-retire-superseded-ai-work */
           WITH candidates AS MATERIALIZED (
             SELECT outbox.id,outbox.account_id,outbox.job_id,outbox.item_id,
                    outbox.expected_status_version
               FROM auto_listing_ai_outbox AS outbox
               JOIN auto_listing_job_items AS item
                 ON item.account_id=outbox.account_id
                AND item.job_id=outbox.job_id
                AND item.id=outbox.item_id
              WHERE outbox.account_id=$1
                AND outbox.contract_version IN ('V1','V2','V3')
                AND (outbox.state='PENDING'
                  OR (outbox.state='PROCESSING' AND outbox.lease_expires_at <= NOW()))
                AND (
                  item.status_version<>outbox.expected_status_version
                  OR item.status NOT IN ('PLANNING','GENERATING')
                  OR (item.status='PLANNING' AND outbox.phase NOT IN (
                    'PLAN_CONTENT','MATERIALIZE_SOURCE_ASSET','ANALYZE_SOURCE_IMAGE_BATCH',
                    'RECONCILE_SOURCE_IMAGE_ANALYSIS','CLEAN_SOURCE_IMAGE_OVERLAY',
                    'CHECK_SOURCE_IMAGE_CLEANUP','FINALIZE_MATERIALIZED_PLAN'
                  ))
                  OR (item.status='GENERATING' AND outbox.phase NOT IN (
                    'GENERATE_IMAGE_SLOT','CHECK_IMAGE_GROUP','GENERATE_RICH_CONTENT'
                  ))
                )
              ORDER BY outbox.created_at,outbox.id
              LIMIT $2
              FOR UPDATE OF outbox SKIP LOCKED
           ), retired AS (
             UPDATE auto_listing_ai_outbox AS outbox
                SET state='COMPLETED',dispatch_contract_version=NULL,
                    publication_id=outbox.dedupe_key,published_at=NOW(),dispatch_queued_at=NULL,
                    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_retry_at=NULL,
                    last_error_code=NULL,last_error_safe=NULL,dead_at=NULL,updated_at=NOW()
               FROM candidates
              WHERE outbox.account_id=candidates.account_id AND outbox.id=candidates.id
              RETURNING candidates.account_id,candidates.job_id,candidates.item_id,
                        candidates.expected_status_version
           ), released AS (
             UPDATE auto_listing_ai_profile_channels AS channel
                SET assigned_job_id=NULL,assigned_item_id=NULL,assigned_status_version=NULL,assigned_at=NULL,
                    execution_lease_owner=NULL,execution_lease_token=NULL,
                    execution_lease_expires_at=NULL,updated_at=NOW()
              WHERE EXISTS (
                SELECT 1 FROM retired
                 WHERE retired.account_id=channel.account_id
                   AND retired.job_id=channel.assigned_job_id
                   AND retired.item_id=channel.assigned_item_id
                   AND retired.expected_status_version=channel.assigned_status_version
              )
              RETURNING channel.channel_id
           )
           SELECT (SELECT COUNT(*)::INTEGER FROM retired) AS retired_count,
                  (SELECT COUNT(*)::INTEGER FROM released) AS released_count`,
          [request.accountId, 1000],
        );
        const rows = [];
        for (let index = 0; index < request.limit; index += 1) {
          const selected = await clientQuery.call(
            client,
            `SELECT outbox.*,job.ai_profile_id,job.ai_profile_version,
                    item.status AS item_status,item.status_version AS item_status_version,
                    channel.channel_id,channel.connection_id,channel.connection_version,
                    channel.candidate_assigned_job_id,channel.candidate_assigned_item_id,
                    channel.candidate_assigned_status_version,
                    assignment.channel_id AS assignment_channel_id,
                    assignment.assigned_status_version AS assignment_status_version,
                    assignment.exact AS assignment_exact,assignment.stale AS assignment_stale,
                    NOW()+($2 * INTERVAL '1 millisecond') AS claim_lease_expires_at
               FROM auto_listing_ai_outbox AS outbox
               JOIN auto_listing_jobs AS job
                 ON job.account_id=outbox.account_id AND job.id=outbox.job_id
               JOIN ai_gateway_profiles AS profile
                 ON profile.account_id=job.account_id AND profile.id=job.ai_profile_id
                AND profile.config_version=job.ai_profile_version
                AND profile.connection_id IS NOT NULL AND profile.connection_version IS NOT NULL
               JOIN auto_listing_job_items AS item
                 ON item.account_id=outbox.account_id AND item.job_id=outbox.job_id AND item.id=outbox.item_id
               LEFT JOIN LATERAL (
                 SELECT assigned.channel_id,assigned.assigned_status_version,
                        assigned.assigned_status_version=outbox.expected_status_version AS exact,
                        (assigned.assigned_status_version<>outbox.expected_status_version
                          AND (assigned.execution_lease_expires_at IS NULL
                            OR assigned.execution_lease_expires_at <= NOW())
                          AND (assigned_item.status NOT IN ('PLANNING','GENERATING')
                            OR NOT EXISTS (
                              SELECT 1 FROM auto_listing_ai_outbox AS recoverable
                               WHERE recoverable.account_id=assigned.account_id
                                 AND recoverable.job_id=assigned.assigned_job_id
                                 AND recoverable.item_id=assigned.assigned_item_id
                                 AND recoverable.expected_status_version=assigned.assigned_status_version
                                 AND recoverable.contract_version IN ('V1','V2','V3')
                                 AND recoverable.state IN ('PENDING','PROCESSING')
                            ))) AS stale
                   FROM auto_listing_ai_profile_channels AS assigned
                   JOIN auto_listing_job_items AS assigned_item
                     ON assigned_item.account_id=assigned.account_id
                    AND assigned_item.job_id=assigned.assigned_job_id
                    AND assigned_item.id=assigned.assigned_item_id
                  WHERE assigned.account_id=outbox.account_id
                    AND assigned.assigned_job_id=outbox.job_id
                    AND assigned.assigned_item_id=outbox.item_id
                  LIMIT 1
                  FOR UPDATE OF assigned SKIP LOCKED
               ) AS assignment ON TRUE
               JOIN LATERAL (
                 SELECT candidate.channel_id,candidate.connection_id,candidate.connection_version,
                        candidate.assigned_job_id AS candidate_assigned_job_id,
                        candidate.assigned_item_id AS candidate_assigned_item_id,
                        candidate.assigned_status_version AS candidate_assigned_status_version,
                        (assignment.exact IS TRUE AND candidate.channel_id=assignment.channel_id) AS fixed
                   FROM auto_listing_ai_profile_channels AS candidate
                   JOIN ai_gateway_connection_versions AS connection
                     ON connection.account_id=candidate.account_id
                    AND connection.id=candidate.connection_id
                    AND connection.version=candidate.connection_version
                   LEFT JOIN auto_listing_job_items AS assigned_item
                     ON assigned_item.account_id=candidate.account_id
                    AND assigned_item.job_id=candidate.assigned_job_id
                    AND assigned_item.id=candidate.assigned_item_id
                  WHERE candidate.account_id=job.account_id
                    AND candidate.profile_id=job.ai_profile_id
                    AND candidate.profile_version=job.ai_profile_version
                    AND (candidate.enabled IS TRUE
                      OR (assignment.exact IS TRUE AND candidate.channel_id=assignment.channel_id))
                    AND candidate.requires_revalidation IS FALSE
                    AND (candidate.cooldown_until IS NULL OR candidate.cooldown_until <= NOW())
                    AND connection.status IN ('ACTIVE','VALIDATED','RETIRED')
                    AND (candidate.execution_lease_expires_at IS NULL OR candidate.execution_lease_expires_at <= NOW())
                    AND (
                      (assignment.exact IS TRUE AND candidate.channel_id=assignment.channel_id)
                      OR (
                        (assignment.stale IS TRUE OR (assignment.channel_id IS NULL AND NOT EXISTS (
                          SELECT 1 FROM auto_listing_ai_profile_channels AS assigned_probe
                           WHERE assigned_probe.account_id=outbox.account_id
                             AND assigned_probe.assigned_job_id=outbox.job_id
                             AND assigned_probe.assigned_item_id=outbox.item_id
                        )))
                        AND (
                          candidate.assigned_job_id IS NULL
                          OR (assignment.stale IS TRUE AND candidate.channel_id=assignment.channel_id)
                          OR (outbox.attempts > 0 AND outbox.last_error_code IS NOT NULL
                            AND candidate.assigned_item_id IS DISTINCT FROM outbox.item_id
                            AND NOT EXISTS (
                              SELECT 1 FROM auto_listing_ai_outbox AS assigned_recovery
                               WHERE assigned_recovery.account_id=candidate.account_id
                                 AND assigned_recovery.job_id=candidate.assigned_job_id
                                 AND assigned_recovery.item_id=candidate.assigned_item_id
                                 AND assigned_recovery.expected_status_version=candidate.assigned_status_version
                                 AND assigned_recovery.contract_version IN ('V1','V2','V3')
                                 AND assigned_recovery.state IN ('PENDING','PROCESSING')
                                 AND assigned_recovery.attempts > 0
                                 AND assigned_recovery.last_error_code IS NOT NULL
                            )
                            AND NOT EXISTS (
                              SELECT 1 FROM auto_listing_ai_outbox AS assigned_continuation
                               WHERE assigned_continuation.account_id=candidate.account_id
                                 AND assigned_continuation.job_id=candidate.assigned_job_id
                                 AND assigned_continuation.item_id=candidate.assigned_item_id
                                 AND assigned_continuation.expected_status_version=candidate.assigned_status_version
                                 AND assigned_continuation.contract_version IN ('V1','V2','V3')
                                 AND assigned_continuation.state IN ('PENDING','PROCESSING')
                            ))
                          OR (candidate.execution_lease_expires_at IS NULL OR candidate.execution_lease_expires_at <= NOW())
                            AND (assigned_item.status NOT IN ('PLANNING','GENERATING')
                              OR NOT EXISTS (
                                SELECT 1 FROM auto_listing_ai_outbox AS recoverable
                                 WHERE recoverable.account_id=candidate.account_id
                                   AND recoverable.job_id=candidate.assigned_job_id
                                   AND recoverable.item_id=candidate.assigned_item_id
                                   AND recoverable.expected_status_version=candidate.assigned_status_version
                                   AND recoverable.contract_version IN ('V1','V2','V3')
                                   AND recoverable.state IN ('PENDING','PROCESSING')
                              ))
                        )
                      )
                    )
                  ORDER BY
                    CASE WHEN assignment.exact IS TRUE AND candidate.channel_id=assignment.channel_id THEN 0
                         WHEN candidate.connection_id=item.last_ai_connection_id
                          AND candidate.connection_version=item.last_ai_connection_version THEN 1
                         ELSE 2 END,
                    candidate.channel_order,candidate.channel_id
                  LIMIT 1
                  FOR UPDATE OF candidate SKIP LOCKED
               ) AS channel ON TRUE
              WHERE outbox.account_id=$1 AND outbox.contract_version IN ('V1','V2','V3')
                AND ((outbox.state='PENDING' AND COALESCE(outbox.next_retry_at,outbox.available_at) <= NOW())
                  OR (outbox.state='PROCESSING' AND outbox.lease_expires_at <= NOW()))
                AND item.status_version=outbox.expected_status_version
                AND ((outbox.phase IN ('PLAN_CONTENT','MATERIALIZE_SOURCE_ASSET','ANALYZE_SOURCE_IMAGE_BATCH',
                      'RECONCILE_SOURCE_IMAGE_ANALYSIS','CLEAN_SOURCE_IMAGE_OVERLAY',
                      'CHECK_SOURCE_IMAGE_CLEANUP','FINALIZE_MATERIALIZED_PLAN')
                      AND item.status='PLANNING')
                  OR (outbox.phase IN ('GENERATE_IMAGE_SLOT','CHECK_IMAGE_GROUP','GENERATE_RICH_CONTENT')
                      AND item.status='GENERATING'))
                AND NOT EXISTS (
                  SELECT 1 FROM auto_listing_ai_outbox AS live
                   WHERE live.account_id=outbox.account_id AND live.job_id=outbox.job_id
                     AND live.item_id=outbox.item_id AND live.id<>outbox.id
                     AND live.contract_version IN ('V1','V2','V3') AND live.state='PROCESSING'
                     AND live.lease_expires_at > NOW()
                )
              ORDER BY CASE
                         WHEN outbox.attempts > 0 AND outbox.last_error_code IS NOT NULL THEN 0
                         WHEN channel.fixed THEN 1 ELSE 2
                       END,
                       COALESCE(outbox.next_retry_at,outbox.available_at),job.created_at,item.source_order,
                       outbox.created_at,outbox.id
              LIMIT 1
              FOR UPDATE OF outbox,item SKIP LOCKED`,
            [request.accountId, request.leaseMs],
          );
          const candidate = selected.rows?.[0];
          if (!candidate) break;
          let leaseToken;
          try { leaseToken = identifier(token()); } catch {
            throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
          }
          const leaseExpiresAt = candidate.claim_lease_expires_at;
          const staleAssignment = candidate.assignment_stale === true && candidate.assignment_exact !== true;
          if (staleAssignment) {
            const cleared = await clientQuery.call(
              client,
              `UPDATE auto_listing_ai_profile_channels AS stale
                  SET assigned_job_id=NULL,assigned_item_id=NULL,assigned_status_version=NULL,assigned_at=NULL,
                      execution_lease_owner=NULL,execution_lease_token=NULL,execution_lease_expires_at=NULL,updated_at=NOW()
                WHERE stale.account_id=$1 AND stale.channel_id=$2
                  AND stale.assigned_job_id=$3 AND stale.assigned_item_id=$4
                  AND stale.assigned_status_version=$5
                  AND (stale.execution_lease_expires_at IS NULL OR stale.execution_lease_expires_at <= NOW())
                  AND (EXISTS (
                    SELECT 1 FROM auto_listing_job_items AS assigned_item
                     WHERE assigned_item.account_id=stale.account_id
                       AND assigned_item.job_id=stale.assigned_job_id
                       AND assigned_item.id=stale.assigned_item_id
                       AND assigned_item.status NOT IN ('PLANNING','GENERATING')
                  ) OR NOT EXISTS (
                    SELECT 1 FROM auto_listing_ai_outbox AS recoverable
                     WHERE recoverable.account_id=stale.account_id
                       AND recoverable.job_id=stale.assigned_job_id
                       AND recoverable.item_id=stale.assigned_item_id
                       AND recoverable.expected_status_version=stale.assigned_status_version
                       AND recoverable.contract_version IN ('V1','V2','V3')
                       AND recoverable.state IN ('PENDING','PROCESSING')
                  ))
                RETURNING channel_id`,
              [request.accountId, candidate.assignment_channel_id, candidate.job_id,
                candidate.item_id, candidate.assignment_status_version],
            );
            if (cleared.rows?.length !== 1) throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
          }
          const selectedChannelWasCleared = staleAssignment
            && candidate.channel_id === candidate.assignment_channel_id;
          const channelUpdate = await clientQuery.call(
            client,
            `UPDATE auto_listing_ai_profile_channels
                SET assigned_job_id=$5,assigned_item_id=$6,assigned_status_version=$7,assigned_at=NOW(),
                    execution_lease_owner=$8,execution_lease_token=$9,execution_lease_expires_at=$10,updated_at=NOW()
              WHERE account_id=$1 AND profile_id=$2 AND profile_version=$3 AND channel_id=$4
                AND assigned_job_id IS NOT DISTINCT FROM $11
                AND assigned_item_id IS NOT DISTINCT FROM $12
                AND assigned_status_version IS NOT DISTINCT FROM $13
                AND (enabled IS TRUE OR (assigned_job_id=$5 AND assigned_item_id=$6
                  AND assigned_status_version=$7))
                AND requires_revalidation IS FALSE
                AND (cooldown_until IS NULL OR cooldown_until <= NOW())
                AND (execution_lease_expires_at IS NULL OR execution_lease_expires_at <= NOW())
              RETURNING channel_id,connection_id,connection_version`,
            [request.accountId, candidate.ai_profile_id, candidate.ai_profile_version, candidate.channel_id,
              candidate.job_id, candidate.item_id, candidate.expected_status_version, request.workerId,
              leaseToken, leaseExpiresAt,
              selectedChannelWasCleared ? null : candidate.candidate_assigned_job_id,
              selectedChannelWasCleared ? null : candidate.candidate_assigned_item_id,
              selectedChannelWasCleared ? null : candidate.candidate_assigned_status_version],
          );
          if (channelUpdate.rows?.length !== 1) throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
          const itemUpdate = await clientQuery.call(
            client,
            `UPDATE auto_listing_job_items
                SET last_ai_connection_id=$4,last_ai_connection_version=$5,last_ai_channel_assigned_at=NOW(),updated_at=NOW()
              WHERE account_id=$1 AND job_id=$2 AND id=$3 AND status_version=$6
              RETURNING id`,
            [request.accountId, candidate.job_id, candidate.item_id, candidate.connection_id,
              candidate.connection_version, candidate.expected_status_version],
          );
          if (itemUpdate.rows?.length !== 1) throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
          const claimedWork = await clientQuery.call(
            client,
            `UPDATE auto_listing_ai_outbox
                SET state='PROCESSING',attempts=attempts+1,dispatch_contract_version='CHANNEL_WORK_V1',
                    dispatch_generation=dispatch_generation+1,dispatch_queued_at=NOW(),
                    publication_id=dedupe_key || ':' || (dispatch_generation+1)::TEXT,published_at=NULL,
                    lease_owner=$3,lease_token=$4,lease_expires_at=$5,updated_at=NOW()
              WHERE account_id=$1 AND id=$2 AND item_id=$6
                AND ((state='PENDING' AND COALESCE(next_retry_at,available_at) <= NOW())
                  OR (state='PROCESSING' AND lease_expires_at <= NOW()))
              RETURNING *`,
            [request.accountId, candidate.id, request.workerId, leaseToken, leaseExpiresAt, candidate.item_id],
          );
          const claimedRow = claimedWork.rows?.[0];
          if (!claimedRow) throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
          rows.push(mapWorkRow({
            ...claimedRow,
            channel_id: candidate.channel_id,
            connection_id: candidate.connection_id,
            connection_version: candidate.connection_version,
          }));
        }
        await clientQuery.call(client, "COMMIT");
        transactionStarted = false;
        return rows;
      } catch (error) {
        if (transactionStarted && typeof clientQuery === "function") {
          try { await clientQuery.call(client, "ROLLBACK"); } catch {}
        }
        if (error?.code === "AUTO_LISTING_AI_OUTBOX_INVALID") throw error;
        throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
      } finally {
        if (typeof release === "function") {
          try { release.call(client); } catch {}
        }
      }
    },

    async markAutoListingAiWorkPublished(input) {
      const value = publicationOwnershipInput(input);
      const result = await query(
        `UPDATE auto_listing_ai_outbox AS outbox
            SET published_at=COALESCE(outbox.published_at,NOW()),updated_at=NOW()
          WHERE outbox.account_id=$1 AND outbox.id=$2 AND outbox.item_id=$3
            AND outbox.lease_owner=$4 AND outbox.lease_token=$5
            AND outbox.publication_id=$6 AND outbox.dispatch_contract_version='CHANNEL_WORK_V1'
            AND outbox.dispatch_generation > 0
            AND outbox.publication_id=outbox.dedupe_key || ':' || outbox.dispatch_generation
            AND outbox.state='PROCESSING'
            AND outbox.lease_expires_at > NOW()
            AND EXISTS (
              SELECT 1 FROM auto_listing_ai_profile_channels AS channel
               WHERE channel.account_id=outbox.account_id
                 AND channel.assigned_job_id=outbox.job_id AND channel.assigned_item_id=outbox.item_id
                 AND channel.assigned_status_version=outbox.expected_status_version
                 AND channel.execution_lease_owner=outbox.lease_owner
                 AND channel.execution_lease_token=outbox.lease_token
                 AND channel.execution_lease_expires_at=outbox.lease_expires_at
                 AND channel.execution_lease_expires_at > NOW()
            )
          RETURNING outbox.id`,
        [value.accountId, value.id, value.itemId, value.workerId, value.leaseToken, value.publicationId],
      );
      if (result.rows?.length !== 1) throw problem("AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
      return Object.freeze({ published: true });
    },

    async releaseUnpublishedAutoListingAiWork(input) {
      const value = publicationOwnershipInput(input);
      return transaction(async (txQuery) => {
        const locked = await txQuery(
          `SELECT outbox.job_id,outbox.expected_status_version,outbox.dispatch_generation,channel.channel_id
             FROM auto_listing_ai_outbox AS outbox
             JOIN auto_listing_ai_profile_channels AS channel
               ON channel.account_id=outbox.account_id
              AND channel.assigned_job_id=outbox.job_id AND channel.assigned_item_id=outbox.item_id
            WHERE outbox.account_id=$1 AND outbox.id=$2 AND outbox.item_id=$3
              AND outbox.lease_owner=$4 AND outbox.lease_token=$5 AND outbox.publication_id=$6
              AND outbox.dispatch_contract_version='CHANNEL_WORK_V1' AND outbox.dispatch_generation > 0
              AND outbox.publication_id=outbox.dedupe_key || ':' || outbox.dispatch_generation
              AND outbox.state='PROCESSING' AND outbox.published_at IS NULL
              AND outbox.lease_expires_at > NOW()
              AND channel.execution_lease_owner=outbox.lease_owner
              AND channel.assigned_status_version=outbox.expected_status_version
              AND channel.execution_lease_token=outbox.lease_token
              AND channel.execution_lease_expires_at=outbox.lease_expires_at
              AND channel.execution_lease_expires_at > NOW()
            FOR UPDATE OF outbox,channel`,
          [value.accountId, value.id, value.itemId, value.workerId, value.leaseToken, value.publicationId],
        );
        const fence = locked.rows?.[0];
        if (!fence) throw problem("AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
        const outbox = await txQuery(
          `UPDATE auto_listing_ai_outbox
              SET state='PENDING',publication_id=NULL,published_at=NULL,dispatch_queued_at=NULL,
                  lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_retry_at=NOW(),updated_at=NOW()
            WHERE account_id=$1 AND id=$2 AND item_id=$3 AND lease_owner=$4 AND lease_token=$5
              AND publication_id=$6 AND dispatch_generation=$7
            RETURNING id`,
          [value.accountId, value.id, value.itemId, value.workerId, value.leaseToken,
            value.publicationId, fence.dispatch_generation],
        );
        const channel = await txQuery(
          `UPDATE auto_listing_ai_profile_channels
              SET execution_lease_owner=NULL,execution_lease_token=NULL,execution_lease_expires_at=NULL,updated_at=NOW()
            WHERE account_id=$1 AND channel_id=$2 AND assigned_job_id=$3 AND assigned_item_id=$4
              AND assigned_status_version=$7
              AND execution_lease_owner=$5 AND execution_lease_token=$6
            RETURNING channel_id`,
          [value.accountId, fence.channel_id, fence.job_id, value.itemId, value.workerId, value.leaseToken,
            fence.expected_status_version],
        );
        if (outbox.rows?.length !== 1 || channel.rows?.length !== 1) {
          throw problem("AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
        }
        return Object.freeze({ released: true });
      });
    },

    async adoptAutoListingAiWork(input) {
      const value = adoptWorkInput(input);
      return transaction(async (txQuery) => {
        const locked = await txQuery(
          `SELECT outbox.*,channel.channel_id,channel.connection_id,channel.connection_version,
                  NOW()+($8 * INTERVAL '1 millisecond') AS next_lease_expires_at
             FROM auto_listing_ai_outbox AS outbox
             JOIN auto_listing_ai_profile_channels AS channel
               ON channel.account_id=outbox.account_id
              AND channel.assigned_job_id=outbox.job_id AND channel.assigned_item_id=outbox.item_id
            WHERE outbox.account_id=$1 AND outbox.id=$2 AND outbox.item_id=$3
              AND outbox.publication_id=$4 AND outbox.dispatch_generation=$5
              AND outbox.publication_id=outbox.dedupe_key || ':' || outbox.dispatch_generation
              AND outbox.lease_owner=$6 AND outbox.lease_token=$7
              AND outbox.dispatch_contract_version='CHANNEL_WORK_V1' AND outbox.state='PROCESSING'
              AND outbox.published_at IS NOT NULL AND outbox.lease_expires_at > NOW()
              AND channel.execution_lease_owner=$6 AND channel.execution_lease_token=$7
              AND channel.assigned_status_version=outbox.expected_status_version
              AND channel.execution_lease_expires_at=outbox.lease_expires_at
              AND channel.execution_lease_expires_at > NOW()
            FOR UPDATE OF outbox,channel`,
          [value.accountId, value.id, value.itemId, value.publicationId, value.dispatchGeneration,
            value.relayOwner, value.relayToken, value.leaseMs],
        );
        const fence = locked.rows?.[0];
        if (!fence) throw problem("AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
        const expiry = fence.next_lease_expires_at;
        const outbox = await txQuery(
          `UPDATE auto_listing_ai_outbox
              SET lease_owner=$6,lease_token=$7,lease_expires_at=$8,updated_at=NOW()
            WHERE account_id=$1 AND id=$2 AND item_id=$3 AND publication_id=$4 AND dispatch_generation=$5
              AND lease_owner=$9 AND lease_token=$10
            RETURNING *`,
          [value.accountId, value.id, value.itemId, value.publicationId, value.dispatchGeneration,
            value.workerId, value.workerLeaseToken, expiry, value.relayOwner, value.relayToken],
        );
        const channel = await txQuery(
          `UPDATE auto_listing_ai_profile_channels
              SET execution_lease_owner=$5,execution_lease_token=$6,execution_lease_expires_at=$7,updated_at=NOW()
            WHERE account_id=$1 AND channel_id=$2 AND assigned_job_id=$3 AND assigned_item_id=$4
              AND assigned_status_version=$10
              AND execution_lease_owner=$8 AND execution_lease_token=$9
            RETURNING channel_id`,
          [value.accountId, fence.channel_id, fence.job_id, value.itemId, value.workerId,
            value.workerLeaseToken, expiry, value.relayOwner, value.relayToken, fence.expected_status_version],
        );
        if (outbox.rows?.length !== 1 || channel.rows?.length !== 1) {
          throw problem("AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
        }
        return mapWorkRow({
          ...outbox.rows[0], channel_id: fence.channel_id,
          connection_id: fence.connection_id, connection_version: fence.connection_version,
        });
      });
    },

    async renewAutoListingAiWorkLease(input) {
      const value = renewWorkInput(input);
      return transaction(async (txQuery) => {
        const locked = await txQuery(
          `SELECT outbox.*,channel.channel_id,channel.connection_id,channel.connection_version,
                  NOW()+($8 * INTERVAL '1 millisecond') AS next_lease_expires_at
             FROM auto_listing_ai_outbox AS outbox
             JOIN auto_listing_ai_profile_channels AS channel
               ON channel.account_id=outbox.account_id
              AND channel.assigned_job_id=outbox.job_id AND channel.assigned_item_id=outbox.item_id
            WHERE outbox.account_id=$1 AND outbox.id=$2 AND outbox.item_id=$3
              AND outbox.publication_id=$4 AND outbox.dispatch_generation=$5
              AND outbox.publication_id=outbox.dedupe_key || ':' || outbox.dispatch_generation
              AND outbox.lease_owner=$6 AND outbox.lease_token=$7
              AND outbox.dispatch_contract_version='CHANNEL_WORK_V1' AND outbox.state='PROCESSING'
              AND outbox.lease_expires_at > NOW()
              AND channel.execution_lease_owner=$6 AND channel.execution_lease_token=$7
              AND channel.assigned_status_version=outbox.expected_status_version
              AND channel.execution_lease_expires_at=outbox.lease_expires_at
              AND channel.execution_lease_expires_at > NOW()
            FOR UPDATE OF outbox,channel`,
          [value.accountId, value.id, value.itemId, value.publicationId, value.dispatchGeneration,
            value.workerId, value.leaseToken, value.leaseMs],
        );
        const fence = locked.rows?.[0];
        if (!fence) throw problem("AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
        const expiry = fence.next_lease_expires_at;
        const outbox = await txQuery(
          `UPDATE auto_listing_ai_outbox SET lease_expires_at=$8,updated_at=NOW()
            WHERE account_id=$1 AND id=$2 AND item_id=$3 AND publication_id=$4 AND dispatch_generation=$5
              AND lease_owner=$6 AND lease_token=$7 RETURNING *`,
          [value.accountId, value.id, value.itemId, value.publicationId, value.dispatchGeneration,
            value.workerId, value.leaseToken, expiry],
        );
        const channel = await txQuery(
          `UPDATE auto_listing_ai_profile_channels SET execution_lease_expires_at=$7,updated_at=NOW()
            WHERE account_id=$1 AND channel_id=$2 AND assigned_job_id=$3 AND assigned_item_id=$4
              AND assigned_status_version=$8
              AND execution_lease_owner=$5 AND execution_lease_token=$6 RETURNING channel_id`,
          [value.accountId, fence.channel_id, fence.job_id, value.itemId,
            value.workerId, value.leaseToken, expiry, fence.expected_status_version],
        );
        if (outbox.rows?.length !== 1 || channel.rows?.length !== 1) {
          throw problem("AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
        }
        return mapWorkRow({
          ...outbox.rows[0], channel_id: fence.channel_id,
          connection_id: fence.connection_id, connection_version: fence.connection_version,
        });
      });
    },

    async renewAutoListingAiMessageLease(input) {
      const value = ownershipInput(input, { lease: true });
      return claimed(await query(
        `UPDATE auto_listing_ai_outbox
         SET lease_expires_at=NOW()+($6 * INTERVAL '1 millisecond'),updated_at=NOW()
         WHERE account_id=$1 AND id=$2 AND item_id=$3 AND lease_owner=$4 AND lease_token=$5
           AND contract_version IN ('V1','V2','V3') AND dispatch_contract_version IS NULL
           AND state='PROCESSING' AND lease_expires_at > NOW()
           AND EXISTS (
             SELECT 1 FROM auto_listing_jobs AS frozen_job
             JOIN ai_gateway_profiles AS frozen_profile
               ON frozen_profile.account_id=frozen_job.account_id
              AND frozen_profile.id=frozen_job.ai_profile_id
              AND frozen_profile.config_version=frozen_job.ai_profile_version
              AND frozen_profile.connection_id IS NULL
            WHERE frozen_job.account_id=auto_listing_ai_outbox.account_id
              AND frozen_job.id=auto_listing_ai_outbox.job_id
           )
         RETURNING *`,
        [value.accountId, value.id, value.itemId, value.workerId, value.leaseToken, value.leaseMs],
      ));
    },

    async completeAutoListingAiMessage(input) {
      const value = ownershipInput(input);
      return claimed(await query(
        `UPDATE auto_listing_ai_outbox
         SET state='COMPLETED',publication_id=dedupe_key,published_at=NOW(),next_retry_at=NULL,
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,last_error_safe=NULL,updated_at=NOW()
         WHERE account_id=$1 AND id=$2 AND item_id=$3 AND lease_owner=$4 AND lease_token=$5
           AND contract_version IN ('V1','V2','V3') AND dispatch_contract_version IS NULL
           AND state='PROCESSING' AND lease_expires_at > NOW()
           AND EXISTS (
             SELECT 1 FROM auto_listing_jobs AS frozen_job
             JOIN ai_gateway_profiles AS frozen_profile
               ON frozen_profile.account_id=frozen_job.account_id
              AND frozen_profile.id=frozen_job.ai_profile_id
              AND frozen_profile.config_version=frozen_job.ai_profile_version
              AND frozen_profile.connection_id IS NULL
            WHERE frozen_job.account_id=auto_listing_ai_outbox.account_id
              AND frozen_job.id=auto_listing_ai_outbox.job_id
           )
         RETURNING *`,
        [value.accountId, value.id, value.itemId, value.workerId, value.leaseToken],
      ));
    },

    async failAutoListingAiMessage(input) {
      const value = ownershipInput(input, { failure: true });
      return claimed(await query(
        `UPDATE auto_listing_ai_outbox
         SET state=CASE WHEN attempts >= $6 THEN 'DEAD' ELSE 'PENDING' END,
           lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=$7,last_error_safe=NULL,
           next_retry_at=CASE WHEN attempts >= $6 THEN NULL ELSE NOW()+(
             LEAST($8 * POWER(2,LEAST(GREATEST(attempts-1,0),30)),$9) * INTERVAL '1 millisecond') END,
           dead_at=CASE WHEN attempts >= $6 THEN NOW() ELSE NULL END,updated_at=NOW()
         WHERE account_id=$1 AND id=$2 AND item_id=$3 AND lease_owner=$4 AND lease_token=$5
           AND contract_version IN ('V1','V2','V3') AND dispatch_contract_version IS NULL
           AND state='PROCESSING' AND lease_expires_at > NOW()
           AND EXISTS (
             SELECT 1 FROM auto_listing_jobs AS frozen_job
             JOIN ai_gateway_profiles AS frozen_profile
               ON frozen_profile.account_id=frozen_job.account_id
              AND frozen_profile.id=frozen_job.ai_profile_id
              AND frozen_profile.config_version=frozen_job.ai_profile_version
              AND frozen_profile.connection_id IS NULL
            WHERE frozen_job.account_id=auto_listing_ai_outbox.account_id
              AND frozen_job.id=auto_listing_ai_outbox.job_id
           )
         RETURNING *`,
        [value.accountId, value.id, value.itemId, value.workerId, value.leaseToken, maxAttempts, value.errorCode, baseRetryMs, maxRetryMs],
      ));
    },

    async deadLetterAutoListingAiMessage(input) {
      const value = ownershipInput(input, { failure: true });
      return claimed(await query(
        `UPDATE auto_listing_ai_outbox
         SET state='DEAD',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
           last_error_code=$6,last_error_safe=NULL,next_retry_at=NULL,dead_at=NOW(),updated_at=NOW()
         WHERE account_id=$1 AND id=$2 AND item_id=$3 AND lease_owner=$4 AND lease_token=$5
           AND contract_version IN ('V1','V2','V3') AND dispatch_contract_version IS NULL
           AND state='PROCESSING' AND lease_expires_at > NOW()
           AND EXISTS (
             SELECT 1 FROM auto_listing_jobs AS frozen_job
             JOIN ai_gateway_profiles AS frozen_profile
               ON frozen_profile.account_id=frozen_job.account_id
              AND frozen_profile.id=frozen_job.ai_profile_id
              AND frozen_profile.config_version=frozen_job.ai_profile_version
              AND frozen_profile.connection_id IS NULL
            WHERE frozen_job.account_id=auto_listing_ai_outbox.account_id
              AND frozen_job.id=auto_listing_ai_outbox.job_id
           )
         RETURNING *`,
        [value.accountId, value.id, value.itemId, value.workerId, value.leaseToken, value.errorCode],
      ));
    },
  });
}

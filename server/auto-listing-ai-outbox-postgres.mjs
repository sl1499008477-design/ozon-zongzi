import crypto from "node:crypto";
import {
  autoListingAiMessageDedupeKey,
  canonicalizeAutoListingAiMessage,
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";

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

function phaseTarget(message) {
  if (message.phase === "MATERIALIZE_SOURCE_ASSET") return message.sourceAssetId;
  if (message.phase === "GENERATE_IMAGE_SLOT") return message.slotKey;
  return null;
}

function mapRow(row) {
  if (!row) return null;
  let message;
  try {
    message = normalizeAutoListingAiMessage(row.payload);
    if (message.accountId !== row.account_id || message.itemId !== row.item_id
      || message.phase !== row.phase || message.contractVersion !== row.contract_version
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

export function createPostgresAiOutboxRepository(rawOptions = {}) {
  const options = factoryOptions(rawOptions);
  const pool = options.pool;
  const token = options.token ?? (() => crypto.randomUUID());
  const id = options.id ?? ((dedupeKey) => `ai-outbox-${dedupeKey}`);
  const baseRetryMs = options.baseRetryMs ?? DEFAULT_BASE_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let poolQuery;
  try { poolQuery = pool?.query; } catch { throw problem("AUTO_LISTING_AI_OUTBOX_INVALID"); }
  if (typeof poolQuery !== "function" || typeof token !== "function" || typeof id !== "function"
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

  return Object.freeze({
    async listRunnableAutoListingAiAccountIds(input) {
      const request = accountDiscoveryInput(input);
      const result = await query(
        `SELECT account_id
         FROM auto_listing_ai_outbox
         WHERE contract_version='V1'
           AND ($1::TEXT IS NULL OR account_id > $1)
           AND ((state='PENDING' AND attempts < $3 AND next_retry_at <= NOW())
             OR (state='PROCESSING' AND lease_expires_at <= NOW())
             OR (state='DEAD' AND EXISTS (
               SELECT 1 FROM auto_listing_job_items AS i
                WHERE i.account_id=auto_listing_ai_outbox.account_id
                  AND i.job_id=auto_listing_ai_outbox.job_id
                  AND i.id=auto_listing_ai_outbox.item_id
                  AND i.status_version=auto_listing_ai_outbox.expected_status_version
                  AND ((auto_listing_ai_outbox.phase IN ('PLAN_CONTENT','MATERIALIZE_SOURCE_ASSET','FINALIZE_MATERIALIZED_PLAN')
                        AND i.status='PLANNING')
                    OR (auto_listing_ai_outbox.phase IN ('GENERATE_IMAGE_SLOT','GENERATE_RICH_CONTENT')
                        AND i.status='GENERATING'))
             ))
             OR (state='COMPLETED' AND published_at <= NOW()-INTERVAL '3 hours'
               AND EXISTS (
                 SELECT 1 FROM auto_listing_job_items AS i
                  WHERE i.account_id=auto_listing_ai_outbox.account_id
                    AND i.job_id=auto_listing_ai_outbox.job_id
                    AND i.id=auto_listing_ai_outbox.item_id
                    AND i.status_version=auto_listing_ai_outbox.expected_status_version
                    AND i.status IN ('PLANNING','GENERATING')
                    AND i.updated_at <= NOW()-INTERVAL '3 hours'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM auto_listing_ai_outbox AS live
                  WHERE live.account_id=auto_listing_ai_outbox.account_id
                    AND live.job_id=auto_listing_ai_outbox.job_id
                    AND live.item_id=auto_listing_ai_outbox.item_id
                    AND live.expected_status_version=auto_listing_ai_outbox.expected_status_version
                    AND live.state IN ('PENDING','PROCESSING')
               )))
         GROUP BY account_id
         ORDER BY account_id
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
      const request = reconcileInput(input);
      const result = await query(
        `WITH candidates AS MATERIALIZED (
           SELECT o.id AS outbox_id,o.account_id,o.job_id,o.item_id,o.phase,
                  o.correlation_id,o.last_error_code,i.status,i.status_version
             FROM auto_listing_ai_outbox AS o
             JOIN auto_listing_job_items AS i
               ON i.account_id=o.account_id AND i.job_id=o.job_id AND i.id=o.item_id
            WHERE o.account_id=$1 AND o.contract_version='V1' AND o.state='DEAD'
              AND i.status_version=o.expected_status_version
              AND ((o.phase IN ('PLAN_CONTENT','MATERIALIZE_SOURCE_ASSET','FINALIZE_MATERIALIZED_PLAN')
                    AND i.status='PLANNING')
                OR (o.phase IN ('GENERATE_IMAGE_SLOT','GENERATE_RICH_CONTENT')
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
    },

    async reconcileInterruptedAutoListingAiItems(input) {
      const request = reconcileInput(input);
      const result = await query(
        `WITH candidates AS MATERIALIZED (
           SELECT i.account_id,i.job_id,i.id AS item_id,i.status,i.status_version,j.correlation_id
             FROM auto_listing_job_items AS i
             JOIN auto_listing_jobs AS j ON j.account_id=i.account_id AND j.id=i.job_id
            WHERE i.account_id=$1 AND i.status IN ('PLANNING','GENERATING')
              AND i.updated_at <= NOW()-INTERVAL '3 hours'
              AND EXISTS (
                SELECT 1 FROM auto_listing_ai_outbox AS done
                 WHERE done.account_id=i.account_id AND done.job_id=i.job_id AND done.item_id=i.id
                   AND done.contract_version='V1' AND done.state='COMPLETED'
                   AND done.expected_status_version=i.status_version
                   AND done.published_at <= NOW()-INTERVAL '3 hours'
              )
              AND NOT EXISTS (
                SELECT 1 FROM auto_listing_ai_outbox AS live
                 WHERE live.account_id=i.account_id AND live.job_id=i.job_id AND live.item_id=i.id
                   AND live.contract_version='V1' AND live.expected_status_version=i.status_version
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
      const target = phaseTarget(message);
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
          "SELECT * FROM auto_listing_ai_outbox WHERE account_id=$1 AND dedupe_key=$2 AND contract_version='V1'",
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
          "SELECT created_at,id FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2 AND contract_version='V1'",
          [request.accountId, request.afterId],
        );
        cursor = found.rows?.[0] || null;
        if (!cursor) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
      }
      const result = await query(
        `SELECT * FROM auto_listing_ai_outbox
         WHERE account_id=$1 AND contract_version='V1'
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
      const result = await query(
        `WITH exhausted AS (
           UPDATE auto_listing_ai_outbox
           SET state='DEAD',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
             last_error_code='AUTO_LISTING_AI_LEASE_EXHAUSTED',dead_at=NOW(),next_retry_at=NULL,updated_at=NOW()
           WHERE account_id=$1 AND contract_version='V1' AND state='PROCESSING'
             AND lease_expires_at <= NOW() AND attempts >= $6
           RETURNING id
         ), candidates AS MATERIALIZED (
           SELECT outbox.id
             FROM auto_listing_ai_outbox AS outbox
             JOIN auto_listing_job_items AS item
               ON item.account_id=outbox.account_id AND item.job_id=outbox.job_id AND item.id=outbox.item_id
            WHERE outbox.account_id=$1 AND outbox.contract_version='V1' AND outbox.attempts < $6
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
                   AND live.id<>outbox.id AND live.contract_version='V1'
                   AND live.state='PROCESSING' AND live.lease_expires_at > NOW()
              )
            ORDER BY outbox.created_at,outbox.id
            LIMIT $2 FOR UPDATE OF outbox SKIP LOCKED
         )
         UPDATE auto_listing_ai_outbox AS outbox
         SET state='PROCESSING',attempts=outbox.attempts+1,lease_owner=$3,
           lease_token=$4 || ':' || (outbox.attempts+1)::TEXT,
           lease_expires_at=NOW()+($5 * INTERVAL '1 millisecond'),updated_at=NOW()
         FROM candidates
         WHERE outbox.id=candidates.id AND outbox.account_id=$1
         RETURNING outbox.*`,
        [request.accountId, request.limit, request.workerId, nonce, request.leaseMs, maxAttempts],
      );
      return (result.rows || []).map(mapRow);
    },

    async renewAutoListingAiMessageLease(input) {
      const value = ownershipInput(input, { lease: true });
      return claimed(await query(
        `UPDATE auto_listing_ai_outbox
         SET lease_expires_at=NOW()+($6 * INTERVAL '1 millisecond'),updated_at=NOW()
         WHERE account_id=$1 AND id=$2 AND item_id=$3 AND lease_owner=$4 AND lease_token=$5
           AND contract_version='V1' AND state='PROCESSING' AND lease_expires_at > NOW()
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
           AND contract_version='V1' AND state='PROCESSING' AND lease_expires_at > NOW()
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
           AND contract_version='V1' AND state='PROCESSING' AND lease_expires_at > NOW()
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
           AND contract_version='V1' AND state='PROCESSING' AND lease_expires_at > NOW()
         RETURNING *`,
        [value.accountId, value.id, value.itemId, value.workerId, value.leaseToken, value.errorCode],
      ));
    },
  });
}

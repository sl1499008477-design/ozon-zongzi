let jsonOperationQueue = Promise.resolve();

function repositoryError(message, code = "OZON_ENRICHMENT_PERSISTENCE_FAILED", status = 500) {
  return Object.assign(new Error(message), { code, status });
}

function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw repositoryError(
      `Ozon enrichment ${field} is required`,
      "OZON_ENRICHMENT_SCOPE_REQUIRED",
      400,
    );
  }
  return normalized;
}

function enrichmentKey(value = {}) {
  const source = requiredText(value.source, "source").toLowerCase();
  if (source !== "ozon") {
    throw repositoryError(
      "Ozon enrichment source must be ozon",
      "OZON_ENRICHMENT_SOURCE_UNSUPPORTED",
      400,
    );
  }
  return {
    accountId: requiredText(value.accountId, "accountId"),
    source,
    sku: requiredText(value.sku, "sku"),
    contractVersion: requiredText(value.contractVersion, "contractVersion"),
  };
}

function requiredDate(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw repositoryError(
      `Ozon enrichment ${field} is invalid`,
      "OZON_ENRICHMENT_DATE_INVALID",
      400,
    );
  }
  return date;
}

function optionalIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sameCacheKey(record, key) {
  return record?.accountId === key.accountId
    && record?.source === key.source
    && record?.sku === key.sku
    && record?.contractVersion === key.contractVersion;
}

function serializeJsonOperation(operation) {
  const flight = jsonOperationQueue.catch(() => {}).then(operation);
  jsonOperationQueue = flight;
  return flight;
}

function restoreFields(state, snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot.existed) state[snapshot.fieldName] = snapshot.value;
    else delete state[snapshot.fieldName];
  }
}

function cacheFromRow(row = {}) {
  if (!row.account_id && !row.accountId) return null;
  return {
    accountId: String(row.account_id ?? row.accountId),
    source: String(row.source ?? ""),
    sku: String(row.sku ?? ""),
    contractVersion: String(row.contract_version ?? row.contractVersion ?? ""),
    status: row.status ?? null,
    result: copy(row.result_json ?? row.result ?? null),
    error: copy(row.error_json ?? row.error ?? null),
    responseHash: row.response_hash ?? row.responseHash ?? null,
    executorSessionId:
      row.last_executor_session_id ?? row.executorSessionId ?? null,
    capturedAt: optionalIso(row.captured_at ?? row.capturedAt),
    expiresAt: optionalIso(row.expires_at ?? row.expiresAt),
    leaseOwner: row.lease_owner ?? row.leaseOwner ?? null,
    leaseExpiresAt: optionalIso(row.lease_expires_at ?? row.leaseExpiresAt),
    updatedAt: optionalIso(row.updated_at ?? row.updatedAt),
  };
}

function jobFromRow(row = {}) {
  if (!row.id) return null;
  return {
    id: String(row.id),
    accountId: String(row.account_id ?? row.accountId ?? ""),
    requestId: String(row.request_id ?? row.requestId ?? ""),
    sku: String(row.sku ?? ""),
    status: String(row.status ?? ""),
    preferredSessionId:
      row.preferred_session_id ?? row.preferredSessionId ?? null,
    claimedSessionId: row.claimed_session_id ?? row.claimedSessionId ?? null,
    claimExpiresAt: optionalIso(row.claim_expires_at ?? row.claimExpiresAt),
    refreshBundle: copy(row.refresh_bundle ?? row.refreshBundle ?? {}),
    deadlineAt: optionalIso(row.deadline_at ?? row.deadlineAt),
    result: copy(row.result_json ?? row.result ?? null),
    error: copy(row.error_json ?? row.error ?? null),
    createdAt: optionalIso(row.created_at ?? row.createdAt),
    updatedAt: optionalIso(row.updated_at ?? row.updatedAt),
    completedAt: optionalIso(row.completed_at ?? row.completedAt),
  };
}

function cacheRecord(key, existing = {}) {
  return {
    accountId: key.accountId,
    source: key.source,
    sku: key.sku,
    contractVersion: key.contractVersion,
    status: existing.status ?? null,
    result: copy(existing.result ?? null),
    error: copy(existing.error ?? null),
    responseHash: existing.responseHash ?? null,
    executorSessionId: existing.executorSessionId ?? null,
    capturedAt: existing.capturedAt ?? null,
    expiresAt: existing.expiresAt ?? null,
    leaseOwner: existing.leaseOwner ?? null,
    leaseExpiresAt: existing.leaseExpiresAt ?? null,
    updatedAt: existing.updatedAt ?? null,
  };
}

function newJob(input) {
  const createdAt = requiredDate(input.createdAt, "createdAt").toISOString();
  return {
    id: requiredText(input.id, "job id"),
    accountId: requiredText(input.accountId, "accountId"),
    requestId: requiredText(input.requestId, "requestId"),
    sku: requiredText(input.sku, "sku"),
    status: "PENDING",
    preferredSessionId: input.preferredSessionId
      ? requiredText(input.preferredSessionId, "preferredSessionId")
      : null,
    claimedSessionId: null,
    claimExpiresAt: null,
    refreshBundle: copy(input.refreshBundle ?? {}),
    deadlineAt: requiredDate(input.deadlineAt, "deadlineAt").toISOString(),
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
}

function jobLookupInput(input = {}) {
  return {
    accountId: requiredText(input.accountId, "accountId"),
    jobId: requiredText(input.jobId, "jobId"),
  };
}

function terminalJobError(record, collectorSessionId, now) {
  if (!record) {
    return repositoryError("Ozon enrichment job was not found", "OZON_ENRICHMENT_JOB_NOT_FOUND", 404);
  }
  if (record.status === "SUCCESS" || record.status === "FAILED") {
    return repositoryError(
      "Ozon enrichment job is already terminal",
      "OZON_ENRICHMENT_JOB_TERMINAL",
      409,
    );
  }
  if (
    record.status !== "PROCESSING"
    || record.claimedSessionId !== collectorSessionId
    || !record.claimExpiresAt
    || new Date(record.claimExpiresAt).getTime() <= now.getTime()
  ) {
    return repositoryError(
      "Collector session does not own the Ozon enrichment job",
      "OZON_ENRICHMENT_JOB_OWNERSHIP",
      409,
    );
  }
  return null;
}

export function createJsonCollectorOzonEnrichmentRepository({
  state,
  persist = async () => {},
} = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("Ozon enrichment JSON state required");
  }

  function requireScopedCollectorSession(accountId, sessionId, now = null) {
    if (!Array.isArray(state.collectorSessions)) return;
    const session = state.collectorSessions.find((record) => record?.id === sessionId);
    const expired = now && session?.expiresAt
      && new Date(session.expiresAt).getTime() <= now.getTime();
    if (!session || session.accountId !== accountId || session.revokedAt || expired) {
      throw repositoryError(
        "Collector session is outside the Ozon enrichment account scope",
        "OZON_ENRICHMENT_SESSION_SCOPE",
        403,
      );
    }
  }

  async function commitMutation(fieldNames, mutate) {
    const snapshots = fieldNames.map((fieldName) => ({
      fieldName,
      existed: Object.hasOwn(state, fieldName),
      value: copy(state[fieldName]),
    }));
    try {
      const result = mutate();
      await persist(state);
      return copy(result);
    } catch (error) {
      restoreFields(state, snapshots);
      throw error;
    }
  }

  function cacheEntries() {
    return Array.isArray(state.collectorOzonEnrichmentCache)
      ? state.collectorOzonEnrichmentCache
      : [];
  }

  function jobEntries() {
    return Array.isArray(state.collectorOzonEnrichmentJobs)
      ? state.collectorOzonEnrichmentJobs
      : [];
  }

  async function readCache({ key: rawKey, now, includeExpired = false }) {
    const key = enrichmentKey(rawKey);
    const at = requiredDate(now, "now");
    const found = cacheEntries().find((record) => sameCacheKey(record, key));
    if (!found?.status) return null;
    if (!includeExpired && (!found.expiresAt || new Date(found.expiresAt).getTime() <= at.getTime())) {
      return null;
    }
    return copy(found);
  }

  async function tryAcquireCacheLease({ key: rawKey, leaseOwner, leaseExpiresAt, now }) {
    const key = enrichmentKey(rawKey);
    const owner = requiredText(leaseOwner, "leaseOwner");
    const expires = requiredDate(leaseExpiresAt, "leaseExpiresAt");
    const at = requiredDate(now, "now");
    return serializeJsonOperation(async () => {
      const existing = cacheEntries().find((record) => sameCacheKey(record, key));
      const heldByOther = existing?.leaseOwner
        && existing.leaseOwner !== owner
        && existing.leaseExpiresAt
        && new Date(existing.leaseExpiresAt).getTime() > at.getTime();
      if (heldByOther) return null;
      return commitMutation(["collectorOzonEnrichmentCache"], () => {
        state.collectorOzonEnrichmentCache = cacheEntries();
        let mutable = state.collectorOzonEnrichmentCache.find((record) => sameCacheKey(record, key));
        if (!mutable) {
          mutable = cacheRecord(key);
          state.collectorOzonEnrichmentCache.push(mutable);
        }
        mutable.leaseOwner = owner;
        mutable.leaseExpiresAt = expires.toISOString();
        mutable.updatedAt = at.toISOString();
        return mutable;
      });
    });
  }

  async function releaseCacheLease({ key: rawKey, leaseOwner }) {
    const key = enrichmentKey(rawKey);
    const owner = requiredText(leaseOwner, "leaseOwner");
    return serializeJsonOperation(async () => {
      const existing = cacheEntries().find((record) => sameCacheKey(record, key));
      if (!existing || existing.leaseOwner !== owner) return false;
      return commitMutation(["collectorOzonEnrichmentCache"], () => {
        const mutable = state.collectorOzonEnrichmentCache.find((record) => sameCacheKey(record, key));
        mutable.leaseOwner = null;
        mutable.leaseExpiresAt = null;
        return true;
      });
    });
  }

  async function writeCache({
    key: rawKey,
    status,
    result,
    error,
    responseHash,
    executorSessionId,
    capturedAt,
    expiresAt,
  }) {
    const key = enrichmentKey(rawKey);
    const captured = requiredDate(capturedAt, "capturedAt");
    const expires = requiredDate(expiresAt, "expiresAt");
    if (executorSessionId) {
      requireScopedCollectorSession(key.accountId, executorSessionId, captured);
    }
    return serializeJsonOperation(() => commitMutation(["collectorOzonEnrichmentCache"], () => {
      state.collectorOzonEnrichmentCache = cacheEntries();
      let mutable = state.collectorOzonEnrichmentCache.find((record) => sameCacheKey(record, key));
      if (!mutable) {
        mutable = cacheRecord(key);
        state.collectorOzonEnrichmentCache.push(mutable);
      }
      mutable.status = status;
      mutable.result = copy(result ?? null);
      mutable.error = copy(error ?? null);
      mutable.responseHash = requiredText(responseHash, "responseHash");
      mutable.executorSessionId = executorSessionId
        ? requiredText(executorSessionId, "executorSessionId")
        : null;
      mutable.capturedAt = captured.toISOString();
      mutable.expiresAt = expires.toISOString();
      mutable.leaseOwner = null;
      mutable.leaseExpiresAt = null;
      mutable.updatedAt = captured.toISOString();
      return mutable;
    }));
  }

  async function writeCompleteCache(input) {
    return writeCache({ ...input, status: "COMPLETE", error: null });
  }

  async function writeNegativeCache(input) {
    return writeCache({
      ...input,
      status: "ERROR",
      result: null,
      executorSessionId: null,
    });
  }

  async function createOrGetJob(input) {
    const candidate = newJob(input);
    if (candidate.preferredSessionId) {
      requireScopedCollectorSession(
        candidate.accountId,
        candidate.preferredSessionId,
        requiredDate(candidate.createdAt, "createdAt"),
      );
    }
    return serializeJsonOperation(async () => {
      const existing = jobEntries().find((record) =>
        record.accountId === candidate.accountId
        && record.requestId === candidate.requestId
        && record.sku === candidate.sku);
      if (existing) return copy(existing);
      return commitMutation(["collectorOzonEnrichmentJobs"], () => {
        state.collectorOzonEnrichmentJobs = jobEntries();
        state.collectorOzonEnrichmentJobs.push(candidate);
        return candidate;
      });
    });
  }

  async function claimNextJob({ accountId, collectorSessionId, now, claimExpiresAt }) {
    const scopedAccountId = requiredText(accountId, "accountId");
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    requireScopedCollectorSession(scopedAccountId, sessionId, at);
    const claimExpiry = requiredDate(claimExpiresAt, "claimExpiresAt");
    return serializeJsonOperation(async () => {
      const active = jobEntries().filter((record) =>
        record.accountId === scopedAccountId
        && record.status === "PROCESSING"
        && record.claimExpiresAt
        && new Date(record.claimExpiresAt).getTime() > at.getTime()).length;
      if (active >= 4) return null;
      const candidate = jobEntries()
        .filter((record) =>
          record.accountId === scopedAccountId
          && (record.status === "PENDING" || (
            record.status === "PROCESSING"
            && record.claimExpiresAt
            && new Date(record.claimExpiresAt).getTime() <= at.getTime()
          ))
          && new Date(record.deadlineAt).getTime() > at.getTime()
          && (!record.preferredSessionId || record.preferredSessionId === sessionId))
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
      if (!candidate) return null;
      return commitMutation(["collectorOzonEnrichmentJobs"], () => {
        candidate.status = "PROCESSING";
        candidate.claimedSessionId = sessionId;
        candidate.claimExpiresAt = claimExpiry.toISOString();
        candidate.updatedAt = at.toISOString();
        return candidate;
      });
    });
  }

  async function finishJob({
    accountId,
    collectorSessionId,
    jobId,
    result,
    error,
    now,
    status,
  }) {
    const lookup = jobLookupInput({ accountId, jobId });
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    requireScopedCollectorSession(lookup.accountId, sessionId, at);
    return serializeJsonOperation(async () => {
      const record = jobEntries().find((item) =>
        item.accountId === lookup.accountId && item.id === lookup.jobId);
      const invalid = terminalJobError(record, sessionId, at);
      if (invalid) throw invalid;
      return commitMutation(["collectorOzonEnrichmentJobs"], () => {
        record.status = status;
        record.result = copy(result ?? null);
        record.error = copy(error ?? null);
        record.completedAt = at.toISOString();
        record.updatedAt = at.toISOString();
        return record;
      });
    });
  }

  async function completeJob(input) {
    return finishJob({ ...input, status: "SUCCESS", error: null });
  }

  async function failJob(input) {
    return finishJob({ ...input, status: "FAILED", result: null });
  }

  async function readJob(input) {
    const lookup = jobLookupInput(input);
    const found = jobEntries().find((record) =>
      record.accountId === lookup.accountId && record.id === lookup.jobId);
    return found ? copy(found) : null;
  }

  return Object.freeze({
    readCache,
    tryAcquireCacheLease,
    releaseCacheLease,
    writeCompleteCache,
    writeNegativeCache,
    createOrGetJob,
    claimNextJob,
    completeJob,
    failJob,
    readJob,
  });
}

export function createPostgresCollectorOzonEnrichmentRepository({ pool } = {}) {
  if (!pool?.query) throw new TypeError("Ozon enrichment PostgreSQL pool required");

  async function query(sql, params) {
    try {
      return await pool.query(sql, params);
    } catch (error) {
      if (error?.code?.startsWith("OZON_ENRICHMENT_")) throw error;
      throw repositoryError("Ozon enrichment PostgreSQL operation failed");
    }
  }

  async function readCache({ key: rawKey, now, includeExpired = false }) {
    const key = enrichmentKey(rawKey);
    const at = requiredDate(now, "now");
    const result = await query(
      `SELECT *
         FROM collector_ozon_enrichment_cache
        WHERE account_id=$1 AND source=$2 AND sku=$3 AND contract_version=$4
          AND status IS NOT NULL
          AND ($6::boolean OR expires_at>$5)`,
      [key.accountId, key.source, key.sku, key.contractVersion, at, includeExpired],
    );
    return result.rows[0] ? cacheFromRow(result.rows[0]) : null;
  }

  async function tryAcquireCacheLease({ key: rawKey, leaseOwner, leaseExpiresAt, now }) {
    const key = enrichmentKey(rawKey);
    const owner = requiredText(leaseOwner, "leaseOwner");
    const expires = requiredDate(leaseExpiresAt, "leaseExpiresAt");
    const at = requiredDate(now, "now");
    const result = await query(
      `INSERT INTO collector_ozon_enrichment_cache (
         account_id, source, sku, contract_version, lease_owner, lease_expires_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id, source, sku, contract_version) DO UPDATE
       SET lease_owner = EXCLUDED.lease_owner,
           lease_expires_at = EXCLUDED.lease_expires_at,
           updated_at = EXCLUDED.updated_at
       WHERE collector_ozon_enrichment_cache.lease_expires_at <= EXCLUDED.updated_at
          OR collector_ozon_enrichment_cache.lease_owner = EXCLUDED.lease_owner
       RETURNING account_id, source, sku, contract_version, lease_owner, lease_expires_at`,
      [key.accountId, key.source, key.sku, key.contractVersion, owner, expires, at],
    );
    return result.rows[0] ? cacheFromRow(result.rows[0]) : null;
  }

  async function releaseCacheLease({ key: rawKey, leaseOwner }) {
    const key = enrichmentKey(rawKey);
    const owner = requiredText(leaseOwner, "leaseOwner");
    const result = await query(
      `UPDATE collector_ozon_enrichment_cache
          SET lease_owner=NULL, lease_expires_at='-infinity', updated_at=NOW()
        WHERE account_id=$1 AND source=$2 AND sku=$3 AND contract_version=$4
          AND lease_owner=$5`,
      [key.accountId, key.source, key.sku, key.contractVersion, owner],
    );
    return Number(result.rowCount || 0) > 0;
  }

  async function writeCompleteCache({
    key: rawKey,
    result: enrichmentResult,
    responseHash,
    executorSessionId,
    capturedAt,
    expiresAt,
  }) {
    const key = enrichmentKey(rawKey);
    const captured = requiredDate(capturedAt, "capturedAt");
    const expires = requiredDate(expiresAt, "expiresAt");
    const response = requiredText(responseHash, "responseHash");
    const executor = requiredText(executorSessionId, "executorSessionId");
    const saved = await query(
      `INSERT INTO collector_ozon_enrichment_cache (
         account_id, source, sku, contract_version, status, result_json, error_json,
         response_hash, last_executor_session_id, captured_at, expires_at,
         lease_owner, lease_expires_at, updated_at
       )
       SELECT $1,$2,$3,$4,'COMPLETE',$5::jsonb,NULL,$6,$7,$8,$9,NULL,'-infinity',$8
         FROM collector_sessions AS executor
        WHERE executor.account_id=$1 AND executor.id=$7
          AND executor.revoked_at IS NULL AND executor.expires_at>$8
       ON CONFLICT (account_id, source, sku, contract_version) DO UPDATE SET
         status='COMPLETE', result_json=EXCLUDED.result_json, error_json=NULL,
         response_hash=EXCLUDED.response_hash,
         last_executor_session_id=EXCLUDED.last_executor_session_id,
         captured_at=EXCLUDED.captured_at, expires_at=EXCLUDED.expires_at,
         lease_owner=NULL, lease_expires_at='-infinity', updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [
        key.accountId,
        key.source,
        key.sku,
        key.contractVersion,
        JSON.stringify(enrichmentResult ?? null),
        response,
        executor,
        captured,
        expires,
      ],
    );
    if (!saved.rows[0]) {
      throw repositoryError(
        "Collector session is outside the Ozon enrichment account scope",
        "OZON_ENRICHMENT_SESSION_SCOPE",
        403,
      );
    }
    return cacheFromRow(saved.rows[0]);
  }

  async function writeNegativeCache({
    key: rawKey,
    error,
    responseHash,
    capturedAt,
    expiresAt,
  }) {
    const key = enrichmentKey(rawKey);
    const captured = requiredDate(capturedAt, "capturedAt");
    const expires = requiredDate(expiresAt, "expiresAt");
    const response = requiredText(responseHash, "responseHash");
    const saved = await query(
      `INSERT INTO collector_ozon_enrichment_cache (
         account_id, source, sku, contract_version, status, result_json, error_json,
         response_hash, last_executor_session_id, captured_at, expires_at,
         lease_owner, lease_expires_at, updated_at
       ) VALUES ($1,$2,$3,$4,'ERROR',NULL,$5::jsonb,$6,NULL,$7,$8,NULL,'-infinity',$7)
       ON CONFLICT (account_id, source, sku, contract_version) DO UPDATE SET
         status='ERROR', result_json=NULL, error_json=EXCLUDED.error_json,
         response_hash=EXCLUDED.response_hash, last_executor_session_id=NULL,
         captured_at=EXCLUDED.captured_at, expires_at=EXCLUDED.expires_at,
         lease_owner=NULL, lease_expires_at='-infinity', updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [
        key.accountId,
        key.source,
        key.sku,
        key.contractVersion,
        JSON.stringify(error ?? null),
        response,
        captured,
        expires,
      ],
    );
    return cacheFromRow(saved.rows[0]);
  }

  async function createOrGetJob(input) {
    const record = newJob(input);
    const result = await query(
      `INSERT INTO collector_ozon_enrichment_jobs (
         id, account_id, request_id, sku, status, refresh_bundle,
         preferred_session_id, deadline_at, created_at, updated_at
       )
       SELECT $1,$2,$3,$4,'PENDING',$5::jsonb,$6,$7,$8,$8
         FROM accounts AS account
         LEFT JOIN collector_sessions AS preferred
           ON preferred.id=$6 AND preferred.account_id=$2
          AND preferred.revoked_at IS NULL AND preferred.expires_at>$8
        WHERE account.id=$2 AND ($6::text IS NULL OR preferred.id IS NOT NULL)
       ON CONFLICT (account_id, request_id, sku) DO UPDATE
       SET account_id=EXCLUDED.account_id
       RETURNING *`,
      [
        record.id,
        record.accountId,
        record.requestId,
        record.sku,
        JSON.stringify(record.refreshBundle),
        record.preferredSessionId,
        requiredDate(record.deadlineAt, "deadlineAt"),
        requiredDate(record.createdAt, "createdAt"),
      ],
    );
    if (!result.rows[0]) {
      throw repositoryError(
        "Preferred Collector session is outside the Ozon enrichment account scope",
        "OZON_ENRICHMENT_SESSION_SCOPE",
        403,
      );
    }
    return jobFromRow(result.rows[0]);
  }

  async function claimNextJob({ accountId, collectorSessionId, now, claimExpiresAt }) {
    const scopedAccountId = requiredText(accountId, "accountId");
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    const claimExpiry = requiredDate(claimExpiresAt, "claimExpiresAt");
    if (!pool.connect) throw new TypeError("Ozon enrichment PostgreSQL pool.connect required");
    const client = await pool.connect();
    let began = false;
    try {
      await client.query("BEGIN");
      began = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [scopedAccountId],
      );
      const active = await client.query(
        `SELECT COUNT(*)
           FROM collector_ozon_enrichment_jobs
          WHERE account_id=$1 AND status='PROCESSING' AND claim_expires_at>$2`,
        [scopedAccountId, at],
      );
      if (Number(active.rows[0]?.count || 0) >= 4) {
        await client.query("COMMIT");
        began = false;
        return null;
      }
      const claimed = await client.query(
        `WITH candidate AS (
           SELECT job.id
             FROM collector_ozon_enrichment_jobs AS job
             JOIN collector_sessions AS session
               ON session.id=$2 AND session.account_id=$1
              AND session.revoked_at IS NULL AND session.expires_at>$3
            WHERE job.account_id=$1
              AND (
                job.status='PENDING'
                OR (job.status='PROCESSING' AND job.claim_expires_at<=$3)
              )
              AND job.deadline_at>$3
              AND (job.preferred_session_id IS NULL OR job.preferred_session_id=$2)
            ORDER BY CASE WHEN job.preferred_session_id=$2 THEN 0 ELSE 1 END,
                     job.created_at,
                     job.id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE collector_ozon_enrichment_jobs AS job
            SET status='PROCESSING', claimed_session_id=$2,
                claim_expires_at=$4, updated_at=$3
           FROM candidate
          WHERE job.id=candidate.id AND job.account_id=$1
         RETURNING job.*`,
        [scopedAccountId, sessionId, at, claimExpiry],
      );
      await client.query("COMMIT");
      began = false;
      return claimed.rows[0] ? jobFromRow(claimed.rows[0]) : null;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original transaction error.
        }
      }
      if (error?.code?.startsWith("OZON_ENRICHMENT_")) throw error;
      throw repositoryError("Ozon enrichment PostgreSQL claim failed");
    } finally {
      client.release();
    }
  }

  async function terminalWrite({
    accountId,
    collectorSessionId,
    jobId,
    now,
    status,
    payload,
  }) {
    const lookup = jobLookupInput({ accountId, jobId });
    const sessionId = requiredText(collectorSessionId, "collectorSessionId");
    const at = requiredDate(now, "now");
    const resultColumn = status === "SUCCESS" ? "result_json" : "error_json";
    const otherColumn = status === "SUCCESS" ? "error_json" : "result_json";
    const updated = await query(
      `UPDATE collector_ozon_enrichment_jobs
          SET status='${status}', ${resultColumn}=$5::jsonb, ${otherColumn}=NULL,
              completed_at=$4, updated_at=$4
        WHERE account_id=$1 AND claimed_session_id=$2 AND id=$3
          AND status='PROCESSING' AND claim_expires_at>$4
          AND EXISTS (SELECT 1 FROM collector_sessions AS session
                       WHERE session.id=$2 AND session.account_id=$1
                         AND session.revoked_at IS NULL AND session.expires_at>$4)
       RETURNING *`,
      [lookup.accountId, sessionId, lookup.jobId, at, JSON.stringify(payload ?? null)],
    );
    if (updated.rows[0]) return jobFromRow(updated.rows[0]);
    const found = await query(
      `SELECT * FROM collector_ozon_enrichment_jobs
        WHERE account_id=$1 AND id=$2`,
      [lookup.accountId, lookup.jobId],
    );
    throw terminalJobError(
      found.rows[0] ? jobFromRow(found.rows[0]) : null,
      sessionId,
      at,
    );
  }

  async function completeJob(input) {
    return terminalWrite({ ...input, status: "SUCCESS", payload: input.result });
  }

  async function failJob(input) {
    return terminalWrite({ ...input, status: "FAILED", payload: input.error });
  }

  async function readJob(input) {
    const lookup = jobLookupInput(input);
    const result = await query(
      `SELECT * FROM collector_ozon_enrichment_jobs
        WHERE account_id=$1 AND id=$2`,
      [lookup.accountId, lookup.jobId],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  return Object.freeze({
    readCache,
    tryAcquireCacheLease,
    releaseCacheLease,
    writeCompleteCache,
    writeNegativeCache,
    createOrGetJob,
    claimNextJob,
    completeJob,
    failJob,
    readJob,
  });
}

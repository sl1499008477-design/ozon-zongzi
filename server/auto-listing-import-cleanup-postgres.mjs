import crypto from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_ERROR = /^[A-Z][A-Z0-9_]{0,119}$/u;
const REASON = "AUTO_LISTING_IMPORT_ORPHANED_WORKBOOK";

function cleanupError(code, status = 422, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_IMPORT_CLEANUP_REPOSITORY_FAILED"
    ? "自动上架导入文件清理暂时不可用" : code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function id(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(normalized)) throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_INVALID");
  return normalized;
}

function objectKey(accountId, importId, value) {
  const key = typeof value === "string" ? value.trim() : "";
  const expected = `auto-listing/imports/v1/${accountId}/${importId}/workbook.xlsx`;
  if (key !== expected || Buffer.byteLength(key, "utf8") > 1024) {
    throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_INVALID");
  }
  return key;
}

function deterministicId(accountId, key) {
  return `import_cleanup_${crypto.createHash("sha256").update(`${accountId}\0${key}`, "utf8").digest("hex").slice(0, 40)}`;
}

function fromRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    accountId: row.account_id,
    importId: row.import_id,
    objectKey: row.object_key,
    reasonCode: row.reason_code,
    status: row.status,
    statusVersion: Number(row.status_version),
    attemptCount: Number(row.attempt_count),
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  });
}

function same(row, input) {
  return row?.id === input.id && row?.accountId === input.accountId && row?.importId === input.importId
    && row?.objectKey === input.objectKey && row?.reasonCode === REASON;
}

function ownership(input, { error = false } = {}) {
  const value = {
    accountId: id(input?.accountId),
    id: id(input?.id),
    workerId: id(input?.workerId),
    leaseToken: id(input?.leaseToken),
  };
  if (error) {
    value.errorCode = typeof input?.errorCode === "string" ? input.errorCode.trim() : "";
    if (!SAFE_ERROR.test(value.errorCode)) throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_INVALID");
  }
  return value;
}

export function createPostgresAutoListingImportCleanupRepository({
  pool,
  token = () => crypto.randomUUID(),
} = {}) {
  if (typeof pool?.query !== "function" || typeof token !== "function") {
    throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_INVALID");
  }
  const query = async (sql, params) => {
    try { return await pool.query(sql, params); } catch {
      throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_REPOSITORY_FAILED", 503, true);
    }
  };
  return Object.freeze({
    async listRunnableCleanupAccountIds(input = {}) {
      const afterAccountId = input.afterAccountId === null || input.afterAccountId === undefined
        ? null : id(input.afterAccountId);
      const limit = Number(input.limit ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_INVALID");
      }
      const result = await query(
        `SELECT DISTINCT account_id COLLATE "C" AS account_id
           FROM auto_listing_import_object_cleanup
          WHERE (
            (status='PENDING' AND available_at <= NOW())
            OR (status='PROCESSING' AND lease_expires_at <= NOW())
          ) AND ($1::TEXT IS NULL OR (account_id COLLATE "C") > ($1::TEXT COLLATE "C"))
          ORDER BY account_id LIMIT $2`,
        [afterAccountId, limit],
      );
      return (result.rows || []).map((row) => id(row.account_id));
    },

    async enqueueObjectCleanup(input = {}) {
      const accountId = id(input.accountId);
      const importId = id(input.importId);
      const key = objectKey(accountId, importId, input.objectKey);
      if (input.reasonCode !== REASON) throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_INVALID");
      const normalized = { id: deterministicId(accountId, key), accountId, importId, objectKey: key };
      const inserted = await query(
        `INSERT INTO auto_listing_import_object_cleanup (
           id,account_id,import_id,object_key,reason_code
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (account_id,object_key) DO NOTHING
         RETURNING *`,
        [normalized.id, accountId, importId, key, REASON],
      );
      let row = fromRow(inserted.rows?.[0]);
      if (!row) {
        const found = await query(
          "SELECT * FROM auto_listing_import_object_cleanup WHERE account_id=$1 AND object_key=$2",
          [accountId, key],
        );
        row = fromRow(found.rows?.[0]);
      }
      if (!same(row, normalized)) throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_CONFLICT", 409);
      return row;
    },

    async claimObjectCleanup(input = {}) {
      const accountId = id(input.accountId);
      const workerId = id(input.workerId);
      const limit = Number(input.limit);
      const leaseMs = Number(input.leaseMs);
      const nonce = id(token());
      if (!Number.isInteger(limit) || limit < 1 || limit > 100
        || !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
        throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_INVALID");
      }
      const result = await query(
        `WITH candidates AS (
           SELECT id FROM auto_listing_import_object_cleanup
            WHERE account_id=$1 AND (
              (status='PENDING' AND available_at <= NOW())
              OR (status='PROCESSING' AND lease_expires_at <= NOW())
            )
            ORDER BY available_at,created_at,id
            LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         UPDATE auto_listing_import_object_cleanup AS cleanup
            SET status='PROCESSING',status_version=cleanup.status_version+1,
                attempt_count=cleanup.attempt_count+1,lease_owner=$3,
                lease_token=$4 || ':' || (cleanup.attempt_count+1)::TEXT,
                lease_expires_at=NOW()+($5 * INTERVAL '1 millisecond'),updated_at=NOW()
           FROM candidates
          WHERE cleanup.account_id=$1 AND cleanup.id=candidates.id
          RETURNING cleanup.*`,
        [accountId, limit, workerId, nonce, leaseMs],
      );
      return (result.rows || []).map((row) => {
        const mapped = fromRow(row);
        if (mapped?.accountId !== accountId || mapped?.status !== "PROCESSING"
          || mapped?.leaseOwner !== workerId || !mapped?.leaseToken) {
          throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_REPOSITORY_FAILED", 503, true);
        }
        return mapped;
      });
    },

    async prepareObjectCleanup(input = {}) {
      const value = ownership(input);
      const result = await query(
        `WITH account_scope AS MATERIALIZED (
           SELECT id FROM accounts WHERE id=$1 FOR UPDATE
         ), claimed AS MATERIALIZED (
           SELECT cleanup.*,
                  EXISTS (
                    SELECT 1 FROM auto_listing_import_files AS import_file
                     WHERE import_file.account_id=cleanup.account_id
                       AND import_file.object_key=cleanup.object_key
                  ) AS is_referenced
             FROM auto_listing_import_object_cleanup AS cleanup
             JOIN account_scope ON account_scope.id=cleanup.account_id
            WHERE cleanup.account_id=$1 AND cleanup.id=$2 AND cleanup.status='PROCESSING'
              AND cleanup.lease_owner=$3 AND cleanup.lease_token=$4
              AND cleanup.lease_expires_at > NOW()
            FOR UPDATE
         ), completed AS (
           UPDATE auto_listing_import_object_cleanup AS cleanup
              SET status='COMPLETED',status_version=cleanup.status_version+1,
                  lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                  lease_cas_token=$4,completed_at=NOW(),updated_at=NOW()
             FROM claimed
            WHERE cleanup.account_id=claimed.account_id AND cleanup.id=claimed.id
              AND claimed.is_referenced
           RETURNING cleanup.*
         )
         SELECT completed.*,FALSE AS delete_required FROM completed
         UNION ALL
         SELECT cleanup.*,TRUE AS delete_required
           FROM auto_listing_import_object_cleanup AS cleanup
           JOIN claimed ON claimed.account_id=cleanup.account_id AND claimed.id=cleanup.id
          WHERE NOT claimed.is_referenced`,
        [value.accountId, value.id, value.workerId, value.leaseToken],
      );
      const raw = result.rows?.[0];
      const row = fromRow(raw);
      if (!row || row.accountId !== value.accountId || typeof raw.delete_required !== "boolean") {
        throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_CLAIM_REJECTED", 409);
      }
      return Object.freeze({ deleteRequired: raw.delete_required, cleanup: row });
    },

    async completeObjectCleanup(input = {}) {
      const value = ownership(input);
      const result = await query(
        `UPDATE auto_listing_import_object_cleanup
            SET status='COMPLETED',status_version=status_version+1,
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                lease_cas_token=$4,completed_at=NOW(),updated_at=NOW()
          WHERE account_id=$1 AND id=$2 AND status='PROCESSING'
            AND lease_owner=$3 AND lease_token=$4 AND lease_expires_at > NOW()
          RETURNING *`,
        [value.accountId, value.id, value.workerId, value.leaseToken],
      );
      const row = fromRow(result.rows?.[0]);
      if (!row || row.accountId !== value.accountId || row.status !== "COMPLETED") {
        throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_CLAIM_REJECTED", 409);
      }
      return row;
    },

    async failObjectCleanup(input = {}) {
      const value = ownership(input, { error: true });
      const result = await query(
        `UPDATE auto_listing_import_object_cleanup
            SET status='PENDING',status_version=status_version+1,
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,lease_cas_token=$4,
                last_error_code=$5,
                available_at=NOW()+(
                  LEAST(86400000::BIGINT,30000::BIGINT * CAST(POWER(2,LEAST(GREATEST(attempt_count-1,0),20)) AS BIGINT))
                  * INTERVAL '1 millisecond'
                ),updated_at=NOW()
          WHERE account_id=$1 AND id=$2 AND status='PROCESSING'
            AND lease_owner=$3 AND lease_token=$4 AND lease_expires_at > NOW()
          RETURNING *`,
        [value.accountId, value.id, value.workerId, value.leaseToken, value.errorCode],
      );
      const row = fromRow(result.rows?.[0]);
      if (!row || row.accountId !== value.accountId || row.status !== "PENDING") {
        throw cleanupError("AUTO_LISTING_IMPORT_CLEANUP_CLAIM_REJECTED", 409);
      }
      return row;
    },
  });
}

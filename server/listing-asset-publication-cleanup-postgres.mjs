import crypto from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw new TypeError("LISTING_ASSET_PUBLICATION_CLEANUP_REPOSITORY_INVALID");
  return result;
}

function hash(value) {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError("LISTING_ASSET_PUBLICATION_CLEANUP_REPOSITORY_INVALID");
  return value;
}

function map(row, claimed = false) {
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    planId: row.plan_id, assetId: row.asset_id, contentHash: row.content_hash,
    publicObjectKey: row.public_object_key, publicationVersion: row.publication_version,
    publicBaseUrl: row.public_base_url, publicPrefix: row.public_prefix, reasonCode: row.reason_code,
    status: row.status, attemptCount: row.attempt_count, leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at == null ? null : new Date(row.lease_expires_at).toISOString(),
    claimed,
  };
}

const COLUMNS = `id,account_id,job_id,item_id,plan_id,asset_id,content_hash,public_object_key,
  publication_version,public_base_url,public_prefix,reason_code,status,attempt_count,lease_token,lease_expires_at`;

const INSERT_SQL = `
  INSERT INTO auto_listing_asset_publication_cleanup (
    id,account_id,job_id,item_id,plan_id,asset_id,content_hash,public_object_key,
    publication_version,public_base_url,public_prefix,reason_code,status
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING')
  ON CONFLICT (account_id,asset_id,content_hash,publication_version,public_object_key) DO NOTHING
  RETURNING ${COLUMNS}
`;

const SELECT_EXACT_SQL = `SELECT ${COLUMNS} FROM auto_listing_asset_publication_cleanup
  WHERE account_id=$1 AND asset_id=$2 AND content_hash=$3 AND publication_version=$4 AND public_object_key=$5 LIMIT 1`;

const SELECT_TASK_SQL = `SELECT ${COLUMNS} FROM auto_listing_asset_publication_cleanup
  WHERE account_id=$1 AND id=$2 FOR UPDATE`;

export function createPostgresListingAssetPublicationCleanupRepository({
  pool,
  randomUUID = crypto.randomUUID,
  token = crypto.randomUUID,
  clock = () => new Date(),
  leaseMs = 5 * 60_000,
} = {}) {
  if (typeof pool?.query !== "function" || typeof pool?.connect !== "function") {
    throw new TypeError("Listing asset publication cleanup PostgreSQL pool is required");
  }
  if (typeof randomUUID !== "function" || typeof token !== "function" || typeof clock !== "function"
    || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60_000) {
    throw new TypeError("Listing asset publication cleanup PostgreSQL dependencies are invalid");
  }

  return Object.freeze({
    async listRunnableCleanupTasks({ limit = 25 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("LISTING_ASSET_PUBLICATION_CLEANUP_REPOSITORY_INVALID");
      }
      const result = await pool.query(
        `SELECT account_id,id FROM auto_listing_asset_publication_cleanup
         WHERE status='PENDING' OR (status='DELETING' AND lease_expires_at<=NOW())
         ORDER BY updated_at ASC,created_at ASC,id ASC LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => Object.freeze({ accountId: id(row.account_id), cleanupId: id(row.id) }));
    },

    async recordCleanupRequired(value = {}) {
      const values = [
        `cleanup-${randomUUID()}`, id(value.accountId), id(value.jobId), id(value.itemId), id(value.planId),
        id(value.assetId), hash(value.contentHash), value.publicObjectKey, id(value.publicationVersion),
        value.publicBaseUrl, value.publicPrefix, id(value.reasonCode),
      ];
      const inserted = await pool.query(INSERT_SQL, values);
      if (inserted.rows[0]) return map(inserted.rows[0]);
      const existing = await pool.query(SELECT_EXACT_SQL, [values[1], values[5], values[6], values[8], values[7]]);
      return map(existing.rows[0]);
    },

    async claimCleanup({ accountId, cleanupId, workerId } = {}) {
      const scope = [id(accountId), id(cleanupId)];
      id(workerId);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = map((await client.query(SELECT_TASK_SQL, scope)).rows[0]);
        if (!selected) { await client.query("COMMIT"); return null; }
        if (["CLEANED", "REFERENCED"].includes(selected.status)) {
          await client.query("COMMIT");
          return selected;
        }
        const now = clock();
        if (selected.status === "DELETING" && Date.parse(selected.leaseExpiresAt || "") > now.getTime()) {
          await client.query("COMMIT");
          return selected;
        }
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2,0))",
          [selected.publicObjectKey, selected.publicationVersion],
        );
        const referenced = (await client.query(
          `SELECT 1 FROM auto_listing_asset_publications
           WHERE public_object_key=$1 AND publication_version=$2 LIMIT 1`,
          [selected.publicObjectKey, selected.publicationVersion],
        )).rows[0];
        if (referenced) {
          const result = await client.query(
            `UPDATE auto_listing_asset_publication_cleanup
             SET status='REFERENCED',lease_token=NULL,lease_expires_at=NULL,updated_at=$3
             WHERE account_id=$1 AND id=$2 RETURNING ${COLUMNS}`,
            [scope[0], scope[1], now],
          );
          await client.query("COMMIT");
          return map(result.rows[0]);
        }
        const leaseToken = `lease-${token()}`;
        const expiresAt = new Date(now.getTime() + leaseMs);
        const result = await client.query(
          `UPDATE auto_listing_asset_publication_cleanup
           SET status='DELETING',attempt_count=attempt_count+1,lease_token=$3,lease_expires_at=$4,
             last_error_code=NULL,updated_at=$5
           WHERE account_id=$1 AND id=$2 RETURNING ${COLUMNS}`,
          [scope[0], scope[1], leaseToken, expiresAt, now],
        );
        await client.query("COMMIT");
        return map(result.rows[0], true);
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally { client.release(); }
    },

    async completeCleanup({ accountId, cleanupId, leaseToken } = {}) {
      const result = await pool.query(
        `UPDATE auto_listing_asset_publication_cleanup
         SET status='CLEANED',lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=NOW()
         WHERE account_id=$1 AND id=$2 AND status='DELETING' AND lease_token=$3
         RETURNING ${COLUMNS}`,
        [id(accountId), id(cleanupId), id(leaseToken)],
      );
      return map(result.rows[0]);
    },

    async failCleanup({ accountId, cleanupId, leaseToken, errorCode } = {}) {
      if (typeof errorCode !== "string" || !ERROR_CODE.test(errorCode)) {
        throw new TypeError("LISTING_ASSET_PUBLICATION_CLEANUP_REPOSITORY_INVALID");
      }
      const result = await pool.query(
        `UPDATE auto_listing_asset_publication_cleanup
         SET status='PENDING',lease_token=NULL,lease_expires_at=NULL,last_error_code=$4,updated_at=NOW()
         WHERE account_id=$1 AND id=$2 AND status='DELETING' AND lease_token=$3
         RETURNING ${COLUMNS}`,
        [id(accountId), id(cleanupId), id(leaseToken), errorCode],
      );
      return map(result.rows[0]);
    },
  });
}

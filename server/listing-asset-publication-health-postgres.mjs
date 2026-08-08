import crypto from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw new TypeError("LISTING_ASSET_PUBLICATION_HEALTH_REPOSITORY_INVALID");
  return result;
}

function date(value) {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError("LISTING_ASSET_PUBLICATION_HEALTH_REPOSITORY_INVALID");
  return result;
}

function map(row) {
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id, publicationVersion: row.publication_version,
    publicBaseUrl: row.public_base_url, publicPrefix: row.public_prefix, outcome: row.outcome,
    evidence: row.evidence, checkedByAccountId: row.checked_by_account_id,
    checkedAt: new Date(row.checked_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
  };
}

const COLUMNS = `id,account_id,publication_version,public_base_url,public_prefix,outcome,evidence,
  checked_by_account_id,checked_at,expires_at`;

export function createPostgresListingAssetPublicationHealthRepository({ pool, randomUUID = crypto.randomUUID } = {}) {
  if (typeof pool?.query !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("Listing asset publication health PostgreSQL dependencies are required");
  }
  return Object.freeze({
    async recordEvidence(value = {}) {
      const checkedAt = date(value.checkedAt);
      const expiresAt = date(value.expiresAt);
      if (!value.evidence || typeof value.evidence !== "object" || Array.isArray(value.evidence)
        || !["PASSED", "FAILED"].includes(value.outcome) || expiresAt <= checkedAt) {
        throw new TypeError("LISTING_ASSET_PUBLICATION_HEALTH_REPOSITORY_INVALID");
      }
      const result = await pool.query(
        `INSERT INTO auto_listing_asset_publication_health_evidence (
          id,account_id,publication_version,public_base_url,public_prefix,outcome,evidence,
          checked_by_account_id,checked_at,expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8,$9,$10) RETURNING ${COLUMNS}`,
        [`health-${randomUUID()}`, id(value.accountId), id(value.publicationVersion), value.publicBaseUrl,
          value.publicPrefix, value.outcome, JSON.stringify(value.evidence), id(value.checkedByAccountId), checkedAt, expiresAt],
      );
      return map(result.rows[0]);
    },

    async findReadyEvidence({ accountId, publicationVersion, publicBaseUrl, publicPrefix, now } = {}) {
      const result = await pool.query(
        `SELECT ${COLUMNS} FROM auto_listing_asset_publication_health_evidence
         WHERE account_id=$1 AND publication_version=$2 AND public_base_url=$3 AND public_prefix=$4
           AND outcome='PASSED' AND expires_at>$5
         ORDER BY checked_at DESC,id DESC LIMIT 1`,
        [id(accountId), id(publicationVersion), publicBaseUrl, publicPrefix, date(now)],
      );
      return map(result.rows[0]);
    },
  });
}

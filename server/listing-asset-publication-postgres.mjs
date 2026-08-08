import crypto from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw new TypeError("LISTING_ASSET_PUBLICATION_REPOSITORY_INVALID");
  return result;
}

function mapAsset(row) {
  if (!row) return null;
  return {
    accountId: row.account_id, jobId: row.job_id, itemId: row.item_id, planId: row.plan_id,
    assetId: row.id, visualGroupKey: row.visual_group_key, slotKey: row.slot_key, role: row.role,
    status: row.status, objectKeyVersion: row.object_key_version, objectKey: row.object_key,
    attemptIdentityHash: row.attempt_identity_hash, attemptNo: row.attempt_no, inputHash: row.input_hash,
    contentHash: row.content_hash, contentType: row.content_type, sizeBytes: Number(row.size_bytes),
    width: row.width, height: row.height,
  };
}

function mapPublication(row) {
  if (!row) return null;
  return {
    accountId: row.account_id, jobId: row.job_id, itemId: row.item_id, planId: row.plan_id,
    assetId: row.asset_id, visualGroupKey: row.visual_group_key, slotKey: row.slot_key, role: row.role,
    status: "ACCEPTED", publishedUrl: row.public_url, publicObjectKey: row.public_object_key,
    contentHash: row.content_hash, contentType: row.content_type, sizeBytes: Number(row.size_bytes),
    width: row.width, height: row.height, publicationVersion: row.publication_version,
    publicBaseUrl: row.public_base_url, publicPrefix: row.public_prefix,
  };
}

const FIND_SQL = `
  SELECT publication.account_id,publication.job_id,publication.item_id,publication.plan_id,
    publication.asset_id,publication.visual_group_key,publication.slot_key,publication.role,
    publication.content_hash,publication.content_type,publication.size_bytes,publication.width,
    publication.height,publication.public_object_key,publication.public_url,publication.publication_version,
    publication.public_base_url,publication.public_prefix
  FROM auto_listing_asset_publications AS publication
  JOIN ai_generation_assets AS asset
    ON publication.account_id=asset.account_id
      AND publication.job_id=asset.job_id
      AND publication.item_id=asset.item_id
      AND publication.plan_id=asset.plan_id
      AND publication.asset_id=asset.id
      AND publication.visual_group_key=asset.visual_group_key
      AND publication.slot_key=asset.slot_key
      AND publication.role=asset.role
      AND publication.content_hash=asset.content_hash
      AND publication.content_type=asset.content_type
      AND publication.size_bytes=asset.size_bytes
      AND publication.width=asset.width
      AND publication.height=asset.height
      AND publication.private_object_key=asset.object_key
      AND asset.status='ACCEPTED'
      AND asset.object_key_version='ATTEMPT_V2'
  JOIN auto_listing_job_items AS item
    ON item.account_id=asset.account_id AND item.job_id=asset.job_id AND item.id=asset.item_id
      AND asset.plan_id=item.active_content_plan_id
  WHERE publication.account_id=$1 AND publication.item_id=$2 AND publication.asset_id=$3
    AND publication.publication_version=$4
  LIMIT 1
`;

const LOAD_ASSET_SQL = `
  SELECT asset.id,asset.account_id,asset.job_id,asset.item_id,asset.plan_id,
    asset.visual_group_key,asset.slot_key,asset.role,asset.status,asset.object_key_version,
    asset.object_key,asset.attempt_identity_hash,asset.attempt_no,asset.input_hash,
    asset.content_hash,asset.content_type,asset.size_bytes,asset.width,asset.height
  FROM ai_generation_assets AS asset
  JOIN auto_listing_job_items AS item
    ON item.account_id=asset.account_id AND item.job_id=asset.job_id AND item.id=asset.item_id
      AND asset.plan_id=item.active_content_plan_id
  WHERE asset.account_id=$1 AND asset.item_id=$2 AND asset.id=$3 AND asset.status='ACCEPTED'
    AND asset.object_key_version='ATTEMPT_V2'
  LIMIT 1
`;

const INSERT_SQL = `
  INSERT INTO auto_listing_asset_publications (
    id,account_id,job_id,item_id,plan_id,asset_id,visual_group_key,slot_key,role,
    content_hash,content_type,size_bytes,width,height,private_object_key,public_object_key,
    public_url,publication_version,public_base_url,public_prefix,published_by_account_id
  )
  SELECT $1,asset.account_id,asset.job_id,asset.item_id,asset.plan_id,asset.id,
    asset.visual_group_key,asset.slot_key,asset.role,asset.content_hash,asset.content_type,
    asset.size_bytes,asset.width,asset.height,asset.object_key,$7,$8,$9,$10,$11,$12
  FROM ai_generation_assets AS asset
  JOIN auto_listing_job_items AS item
    ON item.account_id=asset.account_id AND item.job_id=asset.job_id AND item.id=asset.item_id
      AND asset.plan_id=item.active_content_plan_id
  WHERE asset.account_id=$2 AND asset.job_id=$3 AND asset.item_id=$4
    AND asset.plan_id=$5 AND asset.id=$6 AND asset.status='ACCEPTED'
    AND asset.object_key_version='ATTEMPT_V2' AND $12=asset.account_id
  ON CONFLICT (account_id,asset_id,content_hash,publication_version) DO NOTHING
  RETURNING account_id,job_id,item_id,plan_id,asset_id,visual_group_key,slot_key,role,
    content_hash,content_type,size_bytes,width,height,public_object_key,public_url,publication_version,
    public_base_url,public_prefix
`;

export function createPostgresListingAssetPublicationRepository({ pool, randomUUID = crypto.randomUUID } = {}) {
  if (typeof pool?.query !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("Listing asset publication PostgreSQL dependencies are required");
  }
  async function findPublication({ accountId, itemId, assetId, publicationVersion } = {}) {
    const values = [id(accountId), id(itemId), id(assetId), id(publicationVersion)];
    const result = await pool.query(FIND_SQL, values);
    return mapPublication(result.rows[0]);
  }
  return Object.freeze({
    findPublication,

    async loadAcceptedAsset({ accountId, itemId, assetId } = {}) {
      const result = await pool.query(LOAD_ASSET_SQL, [id(accountId), id(itemId), id(assetId)]);
      return mapAsset(result.rows[0]);
    },

    async recordPublication(value = {}) {
      const values = [
        `publication-${randomUUID()}`,
        id(value.accountId), id(value.jobId), id(value.itemId), id(value.planId), id(value.assetId),
        value.publicObjectKey, value.publishedUrl, id(value.publicationVersion), value.publicBaseUrl,
        value.publicPrefix, id(value.publishedByAccountId),
      ];
      const inserted = await pool.query(INSERT_SQL, values);
      if (inserted.rows[0]) return mapPublication(inserted.rows[0]);
      return findPublication({
        accountId: values[1], itemId: values[3], assetId: values[5], publicationVersion: values[8],
      });
    },
  });
}

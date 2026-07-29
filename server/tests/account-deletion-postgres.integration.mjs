import "../env.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { closePostgresPool, getPostgresPool, postgresEnabled } from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import { deleteRemovedAccountScopes } from "../formal-persistence.mjs";
import { readLegacyDataCollectionStoresForAudit } from "../legacy-data-collection-store.mjs";

if (!postgresEnabled()) {
  console.log("account deletion PostgreSQL integration skipped: PostgreSQL is not configured");
  process.exit(0);
}

const suffix = crypto.randomUUID();
const accountId = `delete_account_${suffix}`;
const storeId = `delete_store_${suffix}`;
const snapshotId = `delete_snapshot_${suffix}`;
const jobId = `delete_job_${suffix}`;
const auditEntityId = `delete_audit_${suffix}`;
const collectItemId = `delete_collect_item_${suffix}`;
const rawPayloadId = `delete_raw_payload_${suffix}`;
const collectRequestId = `delete_collect_request_${suffix}`;
const legacyDataStoreId = `delete_legacy_data_store_${suffix}`;
const legacyVerificationRequestId = `delete_legacy_verification_${suffix}`;
const legacyPurgeEventId =
  `legacy-data-store-purge:${accountId}:2026-07-30T10:00:00.000Z`;
const accountBId = `delete_account_b_${suffix}`;
const legacyDataStoreBId = `delete_legacy_data_store_b_${suffix}`;
const accountBVerificationRequestId = `keep_b_verification_${suffix}`;
const pool = await getPostgresPool();

try {
  await runMigrations(pool);
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,'Delete Test','user','active')",
    [accountId, `delete-${suffix}`],
  );
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,'Keep B','user','active')",
    [accountBId, `keep-b-${suffix}`],
  );
  await pool.query(
    "INSERT INTO stores (id,owner_account_id,label,client_id,status) VALUES ($1,$2,'Delete Store',$3,'active')",
    [storeId, accountId, `delete-client-${suffix}`],
  );
  await pool.query(
    "INSERT INTO data_collection_stores (id,seller_company_id) VALUES ($1,$2)",
    [legacyDataStoreId, `delete-seller-${suffix}`],
  );
  await pool.query(
    `INSERT INTO account_data_collection_stores (
       account_id,data_collection_store_id,label,is_current
     ) VALUES ($1,$2,'Delete legacy evidence',TRUE)`,
    [accountId, legacyDataStoreId],
  );
  await pool.query(
    `INSERT INTO collection_store_verifications (
       account_id,data_collection_store_id,seller_company_id,matched,request_id
     ) VALUES ($1,$2,$3,TRUE,$4)`,
    [accountId, legacyDataStoreId, `delete-seller-${suffix}`, legacyVerificationRequestId],
  );
  await pool.query(
    "INSERT INTO data_collection_stores (id,seller_company_id) VALUES ($1,$2)",
    [legacyDataStoreBId, `keep-b-seller-${suffix}`],
  );
  await pool.query(
    `INSERT INTO account_data_collection_stores (
       account_id,data_collection_store_id,label,is_current
     ) VALUES ($1,$2,'Keep B legacy evidence',TRUE)`,
    [accountBId, legacyDataStoreBId],
  );
  await pool.query(
    `INSERT INTO collection_store_verifications (
       account_id,data_collection_store_id,seller_company_id,matched,request_id
     ) VALUES ($1,$2,$3,TRUE,$4)`,
    [
      accountBId,
      legacyDataStoreId,
      `delete-seller-${suffix}`,
      accountBVerificationRequestId,
    ],
  );

  assert.deepEqual(
    (await readLegacyDataCollectionStoresForAudit(pool, { accountId }))
      .map((record) => record.id)
      .sort(),
    [legacyDataStoreId],
  );
  assert.deepEqual(
    (await readLegacyDataCollectionStoresForAudit(pool, { accountId: accountBId }))
      .map((record) => record.id)
      .sort(),
    [legacyDataStoreBId],
  );
  await pool.query(
    `INSERT INTO collect_items (id, account_id, store_id, source, identity_key, source_sku, summary)
     VALUES ($1, $2, $3, 'ozon', $4, 'delete-sku', '{}'::jsonb)`,
    [collectItemId, accountId, storeId, `delete-identity-${suffix}`],
  );
  await pool.query(
    `INSERT INTO collect_raw_payloads (
       id, collect_item_id, account_id, store_id, payload_hash, payload
     ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
    [rawPayloadId, collectItemId, accountId, storeId, `delete-payload-${suffix}`],
  );
  await pool.query(
    `INSERT INTO collect_requests (
       id, idempotency_key, account_id, store_id, source, source_sku, request_hash, content_hash, collect_item_id
     ) VALUES ($1, $2, $3, $4, 'ozon', 'delete-sku', $5, $6, $7)`,
    [collectRequestId, `delete-request-${suffix}`, accountId, storeId, `delete-request-hash-${suffix}`, `delete-content-hash-${suffix}`, collectItemId],
  );
  await pool.query(
    `INSERT INTO submission_snapshots (
       id,account_id,store_id,idempotency_key,snapshot_hash,items
     ) VALUES ($1,$2,$3,$4,$5,'[]'::jsonb)`,
    [snapshotId, accountId, storeId, `delete-key-${suffix}`, `delete-hash-${suffix}`],
  );
  await pool.query(
    `INSERT INTO submission_jobs (
       id,snapshot_id,account_id,store_id,correlation_id
     ) VALUES ($1,$2,$3,$4,$5)`,
    [jobId, snapshotId, accountId, storeId, `delete-correlation-${suffix}`],
  );
  await pool.query(
    `INSERT INTO audit_events (
       account_id,store_id,action,entity_type,entity_id
     ) VALUES ($1,$2,'TEST_ACCOUNT_DELETE','account',$3)`,
    [accountId, storeId, auditEntityId],
  );

  const state = {};
  Object.defineProperty(state, "__deletedAccountScopes", {
    value: [{
      accountId,
      storeIds: [storeId],
      legacyDataStorePurgePolicy: {
        actor: { type: "account", id: accountId },
        reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
        occurredAt: "2026-07-30T10:00:00.000Z",
      },
    }],
    enumerable: false,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await deleteRemovedAccountScopes(client, state);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM accounts WHERE id=$1) account_count,
       (SELECT COUNT(*)::int FROM stores WHERE id=$2) store_count,
       (SELECT COUNT(*)::int FROM submission_jobs WHERE id=$3) job_count,
       (SELECT COUNT(*)::int FROM submission_snapshots WHERE id=$4) snapshot_count,
       (SELECT COUNT(*)::int FROM collect_items WHERE id=$5) collect_item_count,
       (SELECT COUNT(*)::int FROM collect_raw_payloads WHERE id=$6) raw_payload_count,
       (SELECT COUNT(*)::int FROM collect_requests WHERE id=$7) collect_request_count,
       (SELECT COUNT(*)::int FROM audit_events WHERE entity_id=$8) audit_count,
       (SELECT account_id FROM audit_events WHERE entity_id=$8 LIMIT 1) audit_account_id,
       (SELECT store_id FROM audit_events WHERE entity_id=$8 LIMIT 1) audit_store_id,
       (SELECT COUNT(*)::int FROM data_collection_stores WHERE id=$9) legacy_store_count,
       (SELECT COUNT(*)::int FROM account_data_collection_stores
        WHERE data_collection_store_id=$9) legacy_membership_count,
       (SELECT COUNT(*)::int FROM collection_store_verifications
        WHERE request_id=$10) legacy_verification_count,
       (SELECT COUNT(*)::int FROM audit_events WHERE event_id=$11) legacy_purge_audit_count,
       (SELECT account_id FROM audit_events WHERE event_id=$11) legacy_purge_audit_account_id,
       (SELECT metadata FROM audit_events WHERE event_id=$11) legacy_purge_metadata,
       (SELECT COUNT(*)::int FROM data_collection_stores WHERE id=$12) account_b_legacy_store_count,
       (SELECT COUNT(*)::int FROM account_data_collection_stores
        WHERE account_id=$13 AND data_collection_store_id=$12) account_b_legacy_membership_count,
       (SELECT COUNT(*)::int FROM collection_store_verifications
        WHERE account_id=$13 AND request_id=$14) account_b_verification_count,
       (SELECT data_collection_store_id FROM collection_store_verifications
        WHERE account_id=$13 AND request_id=$14) account_b_verification_store_id`,
    [
      accountId,
      storeId,
      jobId,
      snapshotId,
      collectItemId,
      rawPayloadId,
      collectRequestId,
      auditEntityId,
      legacyDataStoreId,
      legacyVerificationRequestId,
      legacyPurgeEventId,
      legacyDataStoreBId,
      accountBId,
      accountBVerificationRequestId,
    ],
  );
  assert.deepEqual(counts.rows[0], {
    account_count: 0,
    store_count: 0,
    job_count: 0,
    snapshot_count: 0,
    collect_item_count: 0,
    raw_payload_count: 0,
    collect_request_count: 0,
    audit_count: 1,
    audit_account_id: null,
    audit_store_id: null,
    legacy_store_count: 0,
    legacy_membership_count: 0,
    legacy_verification_count: 0,
    legacy_purge_audit_count: 1,
    legacy_purge_audit_account_id: null,
    legacy_purge_metadata: {
      reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
      legacyRecordCount: 1,
      verificationDeletedCount: 1,
      membershipDeletedCount: 1,
      orphanStoreDeletedCount: 1,
    },
    account_b_legacy_store_count: 1,
    account_b_legacy_membership_count: 1,
    account_b_verification_count: 1,
    account_b_verification_store_id: null,
  });
  console.log("account deletion PostgreSQL integration passed");
} finally {
  await pool.query("DELETE FROM audit_events WHERE entity_id=$1", [auditEntityId]).catch(() => {});
  await pool.query("DELETE FROM audit_events WHERE event_id=$1", [legacyPurgeEventId]).catch(() => {});
  await pool.query("DELETE FROM accounts WHERE id=$1", [accountBId]).catch(() => {});
  await pool.query("DELETE FROM data_collection_stores WHERE id=$1", [legacyDataStoreBId]).catch(() => {});
  await closePostgresPool();
}

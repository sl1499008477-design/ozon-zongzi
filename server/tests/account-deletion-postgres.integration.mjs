import "../env.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { closePostgresPool, getPostgresPool, postgresEnabled } from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import { deleteRemovedAccountScopes } from "../formal-persistence.mjs";

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
const pool = await getPostgresPool();

try {
  await runMigrations(pool);
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,'Delete Test','user','active')",
    [accountId, `delete-${suffix}`],
  );
  await pool.query(
    "INSERT INTO stores (id,owner_account_id,label,client_id,status) VALUES ($1,$2,'Delete Store',$3,'active')",
    [storeId, accountId, `delete-client-${suffix}`],
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
    value: [{ accountId, storeIds: [storeId] }],
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
       (SELECT COUNT(*)::int FROM audit_events WHERE entity_id=$5) audit_count,
       (SELECT account_id FROM audit_events WHERE entity_id=$5 LIMIT 1) audit_account_id,
       (SELECT store_id FROM audit_events WHERE entity_id=$5 LIMIT 1) audit_store_id`,
    [accountId, storeId, jobId, snapshotId, auditEntityId],
  );
  assert.deepEqual(counts.rows[0], {
    account_count: 0,
    store_count: 0,
    job_count: 0,
    snapshot_count: 0,
    audit_count: 1,
    audit_account_id: null,
    audit_store_id: null,
  });
  console.log("account deletion PostgreSQL integration passed");
} finally {
  await pool.query("DELETE FROM audit_events WHERE entity_id=$1", [auditEntityId]).catch(() => {});
  await closePostgresPool();
}

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createPostgresAutoListingUploadTaskRepository,
  enqueueAutoListingUploadTask,
} from "../auto-listing-upload-task-postgres.mjs";
import { createPostgresAutoListingUserItemActionRepository } from "../auto-listing-user-item-action-postgres.mjs";

const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1"
  && Boolean(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

test("PostgreSQL queue scans all tenants, leases the real user role, drains stale work and blocks exhausted work", {
  skip: !enabled, timeout: 60_000,
}, async () => {
  const { Pool } = await import("pg");
  const adminPool = new Pool({ connectionString, max: 2 });
  const admin = await adminPool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `auto_listing_upload_task_${suffix}`;
  let pool;
  async function fixture(name, { status = "UPLOAD_QUEUED", enqueue = true } = {}) {
    const ids = Object.fromEntries(["account", "store", "warehouse", "snapshot", "job", "item"]
      .map((key) => [key, `${name}-${key}-${suffix}`]));
    await admin.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
      [ids.account, `${name}-${suffix}`]);
    await admin.query("INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
      [ids.store, name, `${name}-client-${suffix}`, ids.account]);
    await admin.query(`INSERT INTO warehouses
      (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
      VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)`, [ids.warehouse, ids.store, `${name}-platform-${suffix}`]);
    await admin.query(`INSERT INTO auto_listing_source_snapshots
      (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash)
      VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::jsonb,$4)`,
      [ids.snapshot, ids.account, `${name}-source-${suffix}`, "a".repeat(64)]);
    await admin.query(`INSERT INTO auto_listing_jobs
      (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,created_by,correlation_id)
      VALUES ($1,$2,'COLLECT_BOX','CREATED',$3,'{}'::jsonb,$4,$2,$5)`,
      [ids.job, ids.account, `${name}-job-${suffix}`, "b".repeat(64), `${name}-corr-${suffix}`]);
    await admin.query(`INSERT INTO auto_listing_job_items
      (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
      [ids.item, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse, status]);
    if (enqueue) {
      await enqueueAutoListingUploadTask({ client: admin, accountId: ids.account, jobId: ids.job,
        itemId: ids.item, actorAccountId: ids.account, expectedStatusVersion: 1,
        correlationId: `${name}-corr-${suffix}`, enqueueReason: "DIRECT_READY" });
    }
    return ids;
  }
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}, public`);
    for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
      await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` });
    const tenantA = await fixture("a");
    const tenantB = await fixture("b");
    const tenantC = await fixture("c", { status: "READY_FOR_REVIEW", enqueue: false });
    const repository = createPostgresAutoListingUploadTaskRepository({ pool });

    const approved = await createPostgresAutoListingUserItemActionRepository({ pool }).approveItem({
      accountId: tenantC.account, actorAccountId: tenantC.account, jobId: tenantC.job, itemId: tenantC.item,
      expectedStatusVersion: 1, idempotencyKey: `approve-${suffix}`, correlationId: `c-corr-${suffix}`,
    });
    assert.deepEqual(approved, {
      status: "UPLOAD_QUEUED", statusVersion: 2, action: "APPROVE_UPLOAD", duplicate: false,
    });
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM auto_listing_upload_tasks
        WHERE account_id=$1 AND item_id=$2 AND expected_status_version=2 AND enqueue_reason='REVIEW_APPROVED'`,
      [tenantC.account, tenantC.item])).rows[0].count), 1);

    assert.deepEqual(await repository.listRunnableAccounts({ afterAccountId: null, limit: 100 }),
      [tenantA.account, tenantB.account, tenantC.account].sort());
    const leaseA = await repository.leaseNext({ accountId: tenantA.account, workerId: "worker-a", leaseMs: 30_000 });
    assert.deepEqual(leaseA.actor, { id: tenantA.account, role: "user" });
    assert.deepEqual({ status: leaseA.itemStatus, version: leaseA.itemStatusVersion },
      { status: "UPLOAD_QUEUED", version: 1 });
    assert.equal(await repository.leaseNext({ accountId: tenantB.account, workerId: "worker-a", leaseMs: 30_000 })
      .then((value) => value.accountId), tenantB.account);

    // Return B to a runnable task, then advance its item so a restarted worker
    // can explicitly drain the task as stale instead of spinning forever.
    const leasedB = (await pool.query(
      "SELECT id,lease_token FROM auto_listing_upload_tasks WHERE account_id=$1", [tenantB.account])).rows[0];
    await repository.rescheduleLease({ accountId: tenantB.account, taskId: leasedB.id,
      leaseToken: leasedB.lease_token, correlationId: `${leasedB.id}:1`, delayMs: 100,
      errorCode: "AUTO_LISTING_UPLOAD_TASK_DATABASE_FAILED", evidence: {
        outcome: "STALE", code: "AUTO_LISTING_UPLOAD_TASK_DATABASE_FAILED",
      } });
    await pool.query("UPDATE auto_listing_job_items SET status='CANCELLED',status_version=2 WHERE account_id=$1 AND id=$2",
      [tenantB.account, tenantB.item]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const staleLease = await repository.leaseNext({ accountId: tenantB.account, workerId: "worker-a", leaseMs: 30_000 });
    assert.deepEqual({ status: staleLease.itemStatus, version: staleLease.itemStatusVersion },
      { status: "CANCELLED", version: 2 });
    await repository.completeLease({ accountId: tenantB.account, taskId: staleLease.taskId,
      leaseToken: staleLease.leaseToken, correlationId: `${staleLease.taskId}:${staleLease.attemptCount}`,
      evidence: { outcome: "STALE", code: "AUTO_LISTING_UPLOAD_TASK_STALE" } });

    await repository.deadLetterLease({ accountId: tenantA.account, taskId: leaseA.taskId,
      leaseToken: leaseA.leaseToken, correlationId: `${leaseA.taskId}:${leaseA.attemptCount}`,
      errorCode: "AUTO_LISTING_UPLOAD_ATTEMPT_LIMIT_REACHED",
      evidence: { outcome: "BLOCKED", code: "AUTO_LISTING_UPLOAD_ATTEMPT_LIMIT_REACHED" } });
    assert.deepEqual((await pool.query(
      "SELECT status,status_version,failure_code FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
      [tenantA.account, tenantA.item])).rows[0], {
      status: "BLOCKED", status_version: 2, failure_code: "AUTO_LISTING_UPLOAD_ATTEMPT_LIMIT_REACHED",
    });
    assert.equal((await pool.query(
      "SELECT state FROM auto_listing_upload_tasks WHERE account_id=$1", [tenantA.account])).rows[0].state, "DEAD");
    assert.equal(Number((await pool.query(
      "SELECT COUNT(*)::int AS count FROM auto_listing_events WHERE account_id=$1 AND item_id=$2 AND event_type='UPLOAD_DISPATCH_DEAD'",
      [tenantA.account, tenantA.item])).rows[0].count), 1);
  } finally {
    await pool?.end();
    try {
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    } finally { admin.release(); await adminPool.end(); }
  }
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
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
      (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1,1)`,
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
    await admin.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
      await admin.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [migration.replace(/\.sql$/u, "")]);
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

test("PostgreSQL upload claims preserve same-job source order without blocking independent jobs or later AI work", {
  skip: !enabled, timeout: 60_000,
}, async () => {
  const { Pool } = await import("pg");
  const adminPool = new Pool({ connectionString, max: 2 });
  const admin = await adminPool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `auto_listing_upload_order_${suffix}`;
  const accountId = `order-account-${suffix}`;
  const storeId = `order-store-${suffix}`;
  const warehouseId = `order-warehouse-${suffix}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}, public`);
    for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
      await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` });
    await admin.query(
      "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
      [accountId, `order-${suffix}`],
    );
    await admin.query(
      "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,'Order','Order',$2,'active',$3)",
      [storeId, `order-client-${suffix}`, accountId],
    );
    await admin.query(`INSERT INTO warehouses
      (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
      VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)`,
    [warehouseId, storeId, `order-platform-${suffix}`]);

    async function createJob(name, itemStatuses) {
      const jobId = `${name}-job-${suffix}`;
      await admin.query(`INSERT INTO auto_listing_jobs
        (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,created_by,correlation_id)
        VALUES ($1,$2,'COLLECT_BOX','CREATED',$3,'{}'::jsonb,$4,$2,$5)`,
      [jobId, accountId, `${name}-job-${suffix}`, "b".repeat(64), `${name}-corr-${suffix}`]);
      const items = [];
      for (const [index, status] of itemStatuses.entries()) {
        const sourceOrder = index + 1;
        const itemId = `${name}-item-${sourceOrder}-${suffix}`;
        const snapshotId = `${name}-snapshot-${sourceOrder}-${suffix}`;
        await admin.query(`INSERT INTO auto_listing_source_snapshots
          (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash)
          VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::jsonb,$4)`,
        [snapshotId, accountId, `${name}-source-${sourceOrder}-${suffix}`, "a".repeat(64)]);
        await admin.query(`INSERT INTO auto_listing_job_items
          (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,
           status,status_version,source_order)
          VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)`,
        [itemId, jobId, accountId, snapshotId, storeId, warehouseId, status, sourceOrder]);
        items.push(itemId);
      }
      return { jobId, items };
    }

    async function enqueue(jobId, itemId, name) {
      await enqueueAutoListingUploadTask({ client: admin, accountId, jobId, itemId,
        actorAccountId: accountId, expectedStatusVersion: 1,
        correlationId: `${name}-upload-${suffix}`, enqueueReason: "DIRECT_READY" });
    }

    const repository = createPostgresAutoListingUploadTaskRepository({ pool,
      randomUUID: () => `order-${crypto.randomUUID()}` });
    const lease = () => repository.leaseNext({ accountId, workerId: "order-worker", leaseMs: 30_000 });
    const complete = (task) => repository.completeLease({ accountId, taskId: task.taskId,
      leaseToken: task.leaseToken, correlationId: `${task.taskId}:${task.attemptCount}`,
      evidence: { outcome: "STALE", code: "AUTO_LISTING_UPLOAD_TASK_STALE" } });

    for (const predecessorStatus of ["READY_FOR_REVIEW", "UPLOADING", "UPLOAD_QUEUED"]) {
      const name = `blocked-${predecessorStatus.toLowerCase()}`;
      const { jobId, items } = await createJob(name, [predecessorStatus, "UPLOAD_QUEUED"]);
      await enqueue(jobId, items[1], name);
      assert.equal(await lease(), null, `${predecessorStatus} predecessor must hold the later upload`);
    }

    for (const predecessorStatus of ["SUCCEEDED", "RETRYABLE_ERROR", "BLOCKED", "CANCELLED"]) {
      const name = `terminal-${predecessorStatus.toLowerCase()}`;
      const { jobId, items } = await createJob(name, [predecessorStatus, "UPLOAD_QUEUED"]);
      await enqueue(jobId, items[1], name);
      const task = await lease();
      assert.equal(task?.itemId, items[1], `${predecessorStatus} predecessor must release the later upload`);
      await complete(task);
    }

    const blockedJob = await createJob("independent-blocked", ["READY_FOR_REVIEW", "UPLOAD_QUEUED"]);
    await enqueue(blockedJob.jobId, blockedJob.items[1], "independent-blocked");
    const independentJob = await createJob("independent-runnable", ["UPLOAD_QUEUED"]);
    await enqueue(independentJob.jobId, independentJob.items[0], "independent-runnable");
    const independentTask = await lease();
    assert.equal(independentTask?.itemId, independentJob.items[0]);
    await complete(independentTask);

    const aiProgressJob = await createJob("ai-progress", ["UPLOADING", "GENERATING"]);
    await admin.query(`UPDATE auto_listing_job_items
      SET status='UPLOAD_QUEUED',updated_at=NOW() WHERE account_id=$1 AND job_id=$2 AND id=$3`,
    [accountId, aiProgressJob.jobId, aiProgressJob.items[1]]);
    await enqueue(aiProgressJob.jobId, aiProgressJob.items[1], "ai-progress");
    assert.deepEqual((await pool.query(
      "SELECT status FROM auto_listing_job_items WHERE account_id=$1 AND job_id=$2 AND id=$3",
      [accountId, aiProgressJob.jobId, aiProgressJob.items[1]],
    )).rows[0], { status: "UPLOAD_QUEUED" });
    assert.equal(await lease(), null, "later AI completion must not overtake an uploading predecessor");

    const orderedJob = await createJob("ordered", ["CANCELLED", "UPLOAD_QUEUED", "UPLOAD_QUEUED"]);
    await admin.query("BEGIN");
    try {
      await enqueue(orderedJob.jobId, orderedJob.items[2], "ordered-third");
      await enqueue(orderedJob.jobId, orderedJob.items[1], "ordered-second");
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    const taskIdOrder = (await admin.query(`SELECT item_id
      FROM auto_listing_upload_tasks WHERE account_id=$1 AND job_id=$2 ORDER BY id`,
    [accountId, orderedJob.jobId])).rows.map((row) => row.item_id);
    assert.equal(taskIdOrder.length, 2);
    const expectedFirstItemId = taskIdOrder[1];
    await admin.query(`UPDATE auto_listing_job_items
      SET source_order=source_order+10 WHERE account_id=$1 AND job_id=$2 AND source_order IN (2,3)`,
    [accountId, orderedJob.jobId]);
    await admin.query(`UPDATE auto_listing_job_items
      SET source_order=CASE id WHEN $3 THEN 2 ELSE 3 END
      WHERE account_id=$1 AND job_id=$2 AND source_order IN (12,13)`,
    [accountId, orderedJob.jobId, expectedFirstItemId]);
    assert.equal((await lease())?.itemId, expectedFirstItemId,
      "source_order must break equal schedule times before task creation order");
  } finally {
    await pool?.end();
    try {
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    } finally { admin.release(); await adminPool.end(); }
  }
});

test("standard pipeline retains product success as PARTIAL_SUCCESS when stock sync fails and replay never reimports", {
  skip: !enabled, timeout: 60_000,
}, async () => {
  const { Pool } = await import("pg");
  const adminPool = new Pool({ connectionString, max: 2 });
  const admin = await adminPool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `auto_listing_partial_success_${suffix}`;
  const ids = Object.fromEntries(["account", "store", "warehouse", "snapshot", "submissionJob", "submissionItem"]
    .map((key) => [key, `${key}-${suffix}`]));
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/v3/product/import") {
      response.end(JSON.stringify({ result: { task_id: 123456 } }));
      return;
    }
    if (request.url === "/v1/product/import/info") {
      response.end(JSON.stringify({ result: { items: [
        { offer_id: "offer-rfbs", product_id: 987654, status: "imported" },
      ] } }));
      return;
    }
    if (request.url === "/v2/products/stocks") {
      response.statusCode = 503;
      response.end(JSON.stringify({ code: "STOCK_TEMPORARY_FAILURE" }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  let worker;
  let closePostgresPool;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.equal(typeof address, "object");
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}, public`);
    for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
      await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    await admin.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
      await admin.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [migration.replace(/\.sql$/u, "")]);
    }
    process.env.APP_ENCRYPTION_KEY = `rfbs-task5-${suffix}-local-test-key-material`;
    process.env.LISTING_PIPELINE_V3 = "1";
    process.env.OZON_API_BASE = `http://127.0.0.1:${address.port}`;
    const databaseUrl = new URL(connectionString);
    databaseUrl.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = databaseUrl.toString();
    const { encryptSecret } = await import("../crypto-secrets.mjs");
    const encrypted = encryptSecret("fake-ozon-api-key");
    await admin.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
      [ids.account, `partial-${suffix}`]);
    await admin.query("INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,'Partial','Partial',$2,'active',$3)",
      [ids.store, `client-${suffix}`, ids.account]);
    await admin.query(`INSERT INTO warehouses
      (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
      VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)`,
      [ids.warehouse, ids.store, `platform-${suffix}`]);
    await admin.query(`INSERT INTO store_credentials
      (store_id,client_id,encrypted_api_key,iv,auth_tag,algorithm,key_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ids.store, `client-${suffix}`, encrypted.ciphertext, encrypted.iv, encrypted.authTag,
        encrypted.algorithm, encrypted.keyVersion]);
    await admin.query(`INSERT INTO submission_snapshots
      (id,account_id,store_id,idempotency_key,snapshot_hash,item_count,items,stocks)
      VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,$7::jsonb)`,
      [ids.snapshot, ids.account, ids.store, `partial-${suffix}`, "a".repeat(64),
        JSON.stringify([{ offer_id: "offer-rfbs", name: "RFBS product" }]),
        JSON.stringify([{ offer_id: "offer-rfbs", warehouse_id: `platform-${suffix}`, stock: 5 }])]);
    await admin.query(`INSERT INTO submission_jobs
      (id,snapshot_id,account_id,store_id,type,status,correlation_id,item_count)
      VALUES ($1,$2,$3,$4,'AUTO_LISTING','QUEUE_PENDING',$5,1)`,
      [ids.submissionJob, ids.snapshot, ids.account, ids.store, `partial-${suffix}`]);
    await admin.query(`INSERT INTO submission_items
      (id,job_id,snapshot_id,variant_key,sort_order,sku,offer_id,status,product_id)
      VALUES ($1,$2,$3,'offer-rfbs',0,'source-rfbs','offer-rfbs','PENDING','')`,
      [ids.submissionItem, ids.submissionJob, ids.snapshot]);

    ({ processListingQueueMessage: worker } = await import(`../listing-worker.mjs?partial=${suffix}`));
    ({ closePostgresPool } = await import("../db/connection.mjs"));
    await worker({ submissionJobId: ids.submissionJob, action: "submit" });
    await worker({ submissionJobId: ids.submissionJob, action: "check" });
    const completed = (await admin.query(
      `SELECT status,ozon_task_id,success_count,failed_count,error_code,result_summary
         FROM submission_jobs WHERE id=$1`, [ids.submissionJob])).rows[0];
    assert.deepEqual({ status: completed.status, task: completed.ozon_task_id,
      success: completed.success_count, failed: completed.failed_count, code: completed.error_code }, {
      status: "PARTIAL_SUCCESS", task: "123456", success: 1, failed: 0,
      code: "OZON_STOCK_WRITE_FAILED",
    });
    assert.deepEqual(completed.result_summary, { success: 1, failed: 0, skipped: 0, stockCount: 1 });
    assert.equal(calls.filter((path) => path === "/v3/product/import").length, 1);
    assert.equal(calls.filter((path) => path === "/v1/product/import/info").length, 1);
    assert.equal(calls.filter((path) => path === "/v2/products/stocks").length, 1);

    await worker({ submissionJobId: ids.submissionJob, action: "submit" });
    await worker({ submissionJobId: ids.submissionJob, action: "check" });
    assert.equal(calls.filter((path) => path === "/v3/product/import").length, 1);
    assert.equal((await admin.query("SELECT status FROM submission_jobs WHERE id=$1", [ids.submissionJob]))
      .rows[0].status, "PARTIAL_SUCCESS");

    const conflictSnapshotId = `conflict-snapshot-${suffix}`;
    const conflictJobId = `conflict-job-${suffix}`;
    const conflictItemId = `conflict-item-${suffix}`;
    await admin.query(`INSERT INTO submission_snapshots
      (id,account_id,store_id,idempotency_key,snapshot_hash,item_count,items,stocks)
      VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,'[]'::jsonb)`,
      [conflictSnapshotId, ids.account, ids.store, `conflict-${suffix}`, "c".repeat(64),
        JSON.stringify([{ offer_id: "offer-rfbs", name: "Conflict product" }])]);
    await admin.query(`INSERT INTO submission_jobs
      (id,snapshot_id,account_id,store_id,type,status,ozon_task_id,correlation_id,item_count)
      VALUES ($1,$2,$3,$4,'COLLECT_BOX_DRAFT','OZON_ACCEPTED','123456',$5,1)`,
      [conflictJobId, conflictSnapshotId, ids.account, ids.store, `conflict-${suffix}`]);
    await admin.query(`INSERT INTO submission_items
      (id,job_id,snapshot_id,variant_key,sort_order,sku,offer_id,status,product_id)
      VALUES ($1,$2,$3,'offer-rfbs',0,'source-rfbs','offer-rfbs','SUCCEEDED','777777')`,
      [conflictItemId, conflictJobId, conflictSnapshotId]);
    await worker({ submissionJobId: conflictJobId, action: "check" });
    const reconciledConflict = (await admin.query(
      "SELECT status,error_code FROM submission_jobs WHERE id=$1", [conflictJobId],
    )).rows[0];
    assert.deepEqual(reconciledConflict, {
      status: "RECONCILING", error_code: "OZON_IMPORT_RESULT_CONFLICT",
    });
    assert.deepEqual((await admin.query(
      "SELECT status,product_id FROM submission_items WHERE id=$1", [conflictItemId],
    )).rows[0], { status: "SUCCEEDED", product_id: "777777" });
  } finally {
    await closePostgresPool?.().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    delete process.env.DATABASE_URL;
    delete process.env.OZON_API_BASE;
    delete process.env.APP_ENCRYPTION_KEY;
    delete process.env.LISTING_PIPELINE_V3;
    try {
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    } finally { admin.release(); await adminPool.end(); }
  }
});

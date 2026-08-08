import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPostgresAiOutboxRepository } from "../auto-listing-ai-outbox-postgres.mjs";
import { createPostgresAutoListingAiRetryRepository } from "../auto-listing-ai-retry-postgres.mjs";

const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(connectionString);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

if (!enabled) {
  test("AI controlled retry PostgreSQL integration requires an explicitly disposable database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("controlled retry is account-scoped, transactional, replay-idempotent and preserves DEAD evidence", {
    timeout: 60_000,
  }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 2 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_retry_${suffix}`;
    const schemaSql = quote(schema);
    let pool;
    const ids = Object.fromEntries([
      "account", "otherAccount", "store", "warehouse", "strategy", "snapshot", "job", "item",
    ].map((key) => [key, `${key}-${suffix}`]));
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` });
      for (const accountId of [ids.account, ids.otherAccount]) {
        await admin.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
      }
      await admin.query(
        "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
        [ids.store, `Store ${suffix}`, `client-${suffix}`, ids.account],
      );
      await admin.query(
        "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
        [ids.warehouse, ids.store, `warehouse-${suffix}`],
      );
      await admin.query(
        "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'default',1,'PUBLISHED','{}'::JSONB,$3)",
        [ids.strategy, ids.account, "a".repeat(64)],
      );
      await admin.query(
        "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
        [ids.snapshot, ids.account, `record-${suffix}`, "b".repeat(64)],
      );
      await admin.query(
        "INSERT INTO auto_listing_jobs (id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,correlation_id) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6)",
        [ids.job, ids.account, `job-${suffix}`, "c".repeat(64), ids.strategy, `correlation-${suffix}`],
      );
      await admin.query(
        `INSERT INTO auto_listing_job_items
           (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,recovery_point)
         VALUES ($1,$2,$3,$4,$5,$6,'RETRYABLE_ERROR',3,'PLANNING')`,
        [ids.item, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse],
      );

      const outbox = createPostgresAiOutboxRepository({ pool, maxAttempts: 1, token: () => "retry-old-dead" });
      const historical = await outbox.enqueueAutoListingAiMessage({
        contractVersion: "V1", accountId: ids.account, itemId: ids.item, phase: "PLAN_CONTENT",
        expectedStatusVersion: 2, correlationId: `historical-${suffix}`,
      });
      const [claim] = await outbox.claimAutoListingAiMessages({
        accountId: ids.account, workerId: "retry-test-publisher", limit: 1, leaseMs: 60_000,
      });
      await outbox.failAutoListingAiMessage({
        accountId: ids.account, itemId: ids.item, id: claim.id,
        workerId: "retry-test-publisher", leaseToken: claim.leaseToken,
        errorCode: "AUTO_LISTING_AI_QUEUE_PUBLISH_FAILED",
      });

      const retry = createPostgresAutoListingAiRetryRepository({ pool });
      const command = {
        accountId: ids.account, jobId: ids.job, itemId: ids.item,
        expectedStatusVersion: 3, idempotencyKey: `retry-${suffix}`,
      };
      assert.deepEqual(await retry.retryAutoListingAiItem(command), {
        status: "PLANNING", statusVersion: 4, recoveryPoint: "PLANNING", enqueued: 1, duplicate: false,
      });
      assert.deepEqual(await retry.retryAutoListingAiItem(command), {
        status: "PLANNING", statusVersion: 4, recoveryPoint: "PLANNING", enqueued: 1, duplicate: true,
      });
      await assert.rejects(retry.retryAutoListingAiItem({ ...command, accountId: ids.otherAccount }), {
        code: "AUTO_LISTING_AI_RETRY_NOT_FOUND",
      });

      assert.deepEqual((await admin.query(
        "SELECT status,status_version,recovery_point FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
        [ids.account, ids.item],
      )).rows[0], { status: "PLANNING", status_version: 4, recovery_point: null });
      assert.equal((await admin.query(
        "SELECT COUNT(*)::INTEGER AS count FROM auto_listing_events WHERE account_id=$1 AND item_id=$2 AND event_type='RETRY_PLANNING'",
        [ids.account, ids.item],
      )).rows[0].count, 1);
      assert.equal((await admin.query(
        "SELECT COUNT(*)::INTEGER AS count FROM auto_listing_ai_outbox WHERE account_id=$1 AND item_id=$2 AND phase='PLAN_CONTENT' AND expected_status_version=4",
        [ids.account, ids.item],
      )).rows[0].count, 1);
      assert.equal((await admin.query(
        "SELECT state FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2",
        [ids.account, historical.id],
      )).rows[0].state, "DEAD");
    } finally {
      await pool?.end().catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      admin.release();
      await adminPool.end();
    }
  });
}

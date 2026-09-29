import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPostgresAiOutboxRepository } from "../auto-listing-ai-outbox-postgres.mjs";

const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(connectionString);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

if (!enabled) {
  test("AI recovery PostgreSQL integration requires an explicitly disposable database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("DEAD and interrupted recovery are account scoped, restart safe and concurrent-idempotent", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 2 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_recovery_${suffix}`;
    const schemaSql = quote(schema);
    let pool;
    const ids = Object.fromEntries([
      "account", "otherAccount", "store", "warehouse", "strategy", "snapshot", "job", "item", "interruptedItem",
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
        await admin.query(
          `INSERT INTO ai_gateway_profiles (
             id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
             text_model,image_model,config_version,enabled
           ) VALUES ($1,$2,'Legacy','https://gateway.invalid','LEGACY_AI_KEY',
             'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1,FALSE)`,
          [`profile-${accountId}`, accountId],
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
        `INSERT INTO auto_listing_jobs (
           id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,correlation_id,
           ai_profile_id,ai_profile_version
         ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,$7,1)`,
        [ids.job, ids.account, `job-${suffix}`, "c".repeat(64), ids.strategy, `correlation-${suffix}`,
          `profile-${ids.account}`],
      );
      for (const [itemId, status, version, sourceOrder] of [[ids.item, "PLANNING", 2, 1], [ids.interruptedItem, "GENERATING", 5, 2]]) {
        await admin.query(
          `INSERT INTO auto_listing_job_items
             (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()-INTERVAL '4 hours')`,
          [itemId, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse, status, version, sourceOrder],
        );
      }

      const repository = createPostgresAiOutboxRepository({ pool, maxAttempts: 1, token: () => "lease-dead" });
      const deadMessage = {
        contractVersion: "V1", accountId: ids.account, itemId: ids.item, phase: "PLAN_CONTENT",
        expectedStatusVersion: 2, correlationId: `correlation-${suffix}`,
      };
      await repository.enqueueAutoListingAiMessage(deadMessage);
      const [claim] = await repository.claimAutoListingAiMessages({
        accountId: ids.account, workerId: "publisher-recovery", limit: 1, leaseMs: 60_000,
      });
      await repository.failAutoListingAiMessage({
        accountId: ids.account, itemId: ids.item, id: claim.id,
        workerId: "publisher-recovery", leaseToken: claim.leaseToken,
        errorCode: "AUTO_LISTING_AI_QUEUE_PUBLISH_FAILED",
      });
      assert.deepEqual(await repository.listRunnableAutoListingAiAccountIds({
        afterAccountId: null, limit: 100,
      }), [ids.account], "an unreconciled DEAD row must remain discoverable");

      assert.deepEqual(await Promise.all([
        repository.reconcileDeadAutoListingAiMessages({ accountId: ids.account, limit: 10 }),
        repository.reconcileDeadAutoListingAiMessages({ accountId: ids.account, limit: 10 }),
      ]).then((values) => values.map((value) => value.recovered).sort()), [0, 1]);
      assert.deepEqual(await createPostgresAiOutboxRepository({ pool }).reconcileDeadAutoListingAiMessages({
        accountId: ids.account, limit: 10,
      }), { recovered: 0 });
      assert.deepEqual(await repository.reconcileDeadAutoListingAiMessages({
        accountId: ids.otherAccount, limit: 10,
      }), { recovered: 0 });
      assert.deepEqual(await repository.listRunnableAutoListingAiAccountIds({
        afterAccountId: null, limit: 100,
      }), [], "historical DEAD evidence must stop reappearing after its item fence advances");

      const interruptedMessage = {
        contractVersion: "V1", accountId: ids.account, itemId: ids.interruptedItem,
        phase: "GENERATE_RICH_CONTENT", expectedStatusVersion: 5, correlationId: `correlation-${suffix}`,
      };
      const interrupted = await repository.enqueueAutoListingAiMessage(interruptedMessage);
      await admin.query(
        `UPDATE auto_listing_ai_outbox
            SET state='COMPLETED',publication_id=dedupe_key,published_at=NOW()-INTERVAL '4 hours',
                next_retry_at=NULL,updated_at=NOW()-INTERVAL '4 hours'
          WHERE account_id=$1 AND id=$2`,
        [ids.account, interrupted.id],
      );
      assert.deepEqual(await repository.listRunnableAutoListingAiAccountIds({
        afterAccountId: null, limit: 100,
      }), [ids.account]);
      assert.deepEqual(await repository.reconcileInterruptedAutoListingAiItems({
        accountId: ids.account, limit: 10,
      }), { recovered: 1 });
      assert.deepEqual(await repository.reconcileInterruptedAutoListingAiItems({
        accountId: ids.account, limit: 10,
      }), { recovered: 0 });
      assert.deepEqual(await repository.listRunnableAutoListingAiAccountIds({
        afterAccountId: null, limit: 100,
      }), []);

      const items = (await admin.query(
        "SELECT id,status,status_version,recovery_point,failure_code FROM auto_listing_job_items WHERE id=ANY($1::TEXT[]) ORDER BY id",
        [[ids.item, ids.interruptedItem]],
      )).rows;
      assert.equal(items.every((row) => row.status === "RETRYABLE_ERROR"), true);
      assert.equal(items.every((row) => row.status_version === (row.id === ids.item ? 3 : 6)), true);
      assert.deepEqual(new Set(items.map((row) => row.recovery_point)), new Set(["PLANNING", "GENERATION"]));
      assert.equal((await admin.query(
        "SELECT COUNT(*)::INTEGER AS count FROM auto_listing_events WHERE item_id=ANY($1::TEXT[]) AND event_type='RETRYABLE_FAILURE'",
        [[ids.item, ids.interruptedItem]],
      )).rows[0].count, 2);
      assert.equal((await admin.query(
        "SELECT state FROM auto_listing_ai_outbox WHERE account_id=$1 AND id=$2",
        [ids.account, claim.id],
      )).rows[0].state, "DEAD", "the append-only DEAD evidence must remain unchanged");
    } finally {
      await pool?.end().catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      admin.release();
      await adminPool.end();
    }
  });
}

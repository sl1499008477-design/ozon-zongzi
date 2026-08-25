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
  test("batch-order PostgreSQL claims require an explicitly disposable database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("PostgreSQL claim serializes each batch while allowing independent jobs", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 2 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_batch_order_${suffix}`;
    const schemaSql = quote(schema);
    const ids = Object.fromEntries([
      "account", "store", "warehouse", "jobA", "jobB",
      "jobAItem1", "jobAItem2", "jobBItem1", "jobBItem2",
    ].map((key) => [key, `${key}-${suffix}`]));
    let pool;
    let firstClient;
    let secondClient;

    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file))
        .sort();
      for (const migration of migrations) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` });

      await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [ids.account, `user-${suffix}`],
      );
      await admin.query(
        "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
        [ids.store, `Store ${suffix}`, `client-${suffix}`, ids.account],
      );
      await admin.query(
        "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
        [ids.warehouse, ids.store, `platform-${suffix}`],
      );

      for (const [jobId, itemIds] of [
        [ids.jobA, [ids.jobAItem1, ids.jobAItem2]],
        [ids.jobB, [ids.jobBItem1, ids.jobBItem2]],
      ]) {
        await admin.query(
          `INSERT INTO auto_listing_jobs (
             id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
             created_by,correlation_id
           ) VALUES ($1,$2,'COLLECT_BOX','CREATED',$3,'{}'::JSONB,$4,$2,$5)`,
          [jobId, ids.account, `idem-${jobId}`, "a".repeat(64), `corr-${jobId}`],
        );
        for (const [index, itemId] of itemIds.entries()) {
          const snapshotId = `snapshot-${itemId}`;
          await admin.query(
            `INSERT INTO auto_listing_source_snapshots (
               id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash
             ) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)`,
            [snapshotId, ids.account, `record-${itemId}`, "b".repeat(64)],
          );
          await admin.query(
            `INSERT INTO auto_listing_job_items (
               id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,
               status,status_version,source_order
             ) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',1,$7)`,
            [itemId, jobId, ids.account, snapshotId, ids.store, ids.warehouse, index + 1],
          );
        }
      }

      let token = 0;
      const repository = createPostgresAiOutboxRepository({
        pool,
        id: (dedupeKey) => `outbox-${dedupeKey.slice(0, 32)}`,
        token: () => `batch-order-${++token}`,
      });
      const enqueue = ({ itemId, expectedStatusVersion = 1, phase = "PLAN_CONTENT", slotKey }) => repository.enqueueAutoListingAiMessage({
        contractVersion: "V1",
        accountId: ids.account,
        itemId,
        phase,
        expectedStatusVersion,
        correlationId: `corr-${itemId}-${expectedStatusVersion}`,
        ...(slotKey === undefined ? {} : { slotKey }),
      });
      for (const slotKey of ["slot-a", "slot-b", "slot-c"]) {
        await enqueue({ itemId: ids.jobAItem1, phase: "GENERATE_IMAGE_SLOT", slotKey });
      }
      for (const itemId of [ids.jobAItem2, ids.jobBItem1, ids.jobBItem2]) {
        await enqueue({ itemId });
      }

      const claimWith = (targetRepository, limit = 10) => targetRepository.claimAutoListingAiMessages({
        accountId: ids.account,
        workerId: "batch-order-worker",
        limit,
        leaseMs: 60_000,
      });
      const claim = (limit = 10) => claimWith(repository, limit);
      const complete = (row) => repository.completeAutoListingAiMessage({
        accountId: ids.account,
        itemId: row.itemId,
        id: row.id,
        workerId: "batch-order-worker",
        leaseToken: row.leaseToken,
      });

      const firstClaims = await claim();
      assert.deepEqual(firstClaims.map((row) => row.itemId).sort(), [ids.jobAItem1, ids.jobBItem1].sort());
      assert.equal(firstClaims.some((row) => row.itemId === ids.jobAItem2), false);

      const jobAItem1Claim = firstClaims.find((row) => row.itemId === ids.jobAItem1);
      const jobBItem1Claim = firstClaims.find((row) => row.itemId === ids.jobBItem1);
      await complete(jobAItem1Claim);
      await complete(jobBItem1Claim);

      firstClient = await pool.connect();
      await firstClient.query("BEGIN");
      const firstRepository = createPostgresAiOutboxRepository({
        pool: firstClient,
        token: () => "batch-order-first-transaction",
      });
      const secondJobAClaim = (await claimWith(firstRepository, 1))[0];
      assert.equal(secondJobAClaim.itemId, ids.jobAItem1);

      await admin.query(
        "UPDATE auto_listing_job_items SET status='BLOCKED',updated_at=NOW() WHERE account_id=$1 AND id=$2",
        [ids.account, ids.jobBItem1],
      );
      secondClient = await pool.connect();
      await secondClient.query("BEGIN");
      const secondRepository = createPostgresAiOutboxRepository({
        pool: secondClient,
        token: () => "batch-order-second-transaction",
      });
      const concurrentClaims = await claimWith(secondRepository);
      assert.deepEqual(concurrentClaims.map((row) => row.itemId), [ids.jobBItem2]);
      await secondClient.query("COMMIT");
      secondClient.release();
      secondClient = null;
      await firstClient.query("COMMIT");
      firstClient.release();
      firstClient = null;

      await complete(secondJobAClaim);
      await complete(concurrentClaims[0]);
      const finalSameItemClaim = (await claim(1))[0];
      assert.equal(finalSameItemClaim.itemId, ids.jobAItem1);
      await complete(finalSameItemClaim);

      await admin.query(
        "UPDATE auto_listing_job_items SET status='UPLOAD_QUEUED',updated_at=NOW() WHERE account_id=$1 AND id=$2",
        [ids.account, ids.jobAItem1],
      );
      assert.deepEqual(await claim(), []);
      await admin.query(
        "UPDATE auto_listing_job_items SET status='UPLOADING',updated_at=NOW() WHERE account_id=$1 AND id=$2",
        [ids.account, ids.jobAItem1],
      );
      assert.deepEqual(await claim(), []);
      await admin.query(
        "UPDATE auto_listing_job_items SET status='BLOCKED',updated_at=NOW() WHERE account_id=$1 AND id=$2",
        [ids.account, ids.jobAItem1],
      );

      const jobAItem2Claim = (await claim(1))[0];
      assert.equal(jobAItem2Claim.itemId, ids.jobAItem2);

      await admin.query(
        `UPDATE auto_listing_job_items
            SET status='PLANNING',status_version=status_version+1,updated_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [ids.account, ids.jobAItem1],
      );
      await enqueue({ itemId: ids.jobAItem1, expectedStatusVersion: 2 });
      assert.deepEqual(await claim(), []);

      await complete(jobAItem2Claim);
      await admin.query(
        "UPDATE auto_listing_job_items SET status='BLOCKED',updated_at=NOW() WHERE account_id=$1 AND id=$2",
        [ids.account, ids.jobAItem2],
      );
      const retryClaim = (await claim(1))[0];
      assert.equal(retryClaim.itemId, ids.jobAItem1);
      assert.equal(retryClaim.message.expectedStatusVersion, 2);
      await admin.query(
        "UPDATE auto_listing_ai_outbox SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
        [ids.account, retryClaim.id],
      );
      const expiredReclaim = (await claim(1))[0];
      assert.equal(expiredReclaim.id, retryClaim.id);
      assert.equal(expiredReclaim.attempts, retryClaim.attempts + 1);
      assert.notEqual(expiredReclaim.leaseToken, retryClaim.leaseToken);
    } finally {
      if (secondClient) {
        await secondClient.query("ROLLBACK").catch(() => {});
        secondClient.release();
      }
      if (firstClient) {
        await firstClient.query("ROLLBACK").catch(() => {});
        firstClient.release();
      }
      if (pool) await pool.end();
      await admin.query("SET search_path TO public").catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      admin.release();
      await adminPool.end();
    }
  });
}

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

function graph(accountId, idempotencyKey, suffix, overrides = {}) {
  return {
    accountId,
    actorAccountId: accountId,
    sourceType: "COLLECT_BOX",
    idempotencyKey,
    correlationId: `corr-${suffix}`,
    configSnapshot: { targetStoreId: `store-${accountId}`, targetWarehouseId: `warehouse-${accountId}` },
    configHash: `config-${suffix}`,
    strategyVersionId: `strategy-version-${accountId}`,
    items: [{
      sourceType: "COLLECT_BOX",
      sourceRecordId: `collect-${suffix}`,
      sourceVersion: "1",
      snapshot: { identity: { primarySku: `sku-${suffix}` }, source: { sourceVersion: "1" } },
      snapshotHash: `snapshot-${suffix}`,
      rawResponseRef: `raw-${suffix}`,
      targetStoreId: `store-${accountId}`,
      targetWarehouseId: `warehouse-${accountId}`,
      status: "SOURCE_READY",
      strategyId: `strategy-${accountId}`,
      strategyVersionId: `strategy-version-${accountId}`,
      style: "BALANCED_DEFAULT",
      matchedBy: "DEFAULT",
      price: { currency: "RUB", finalPriceKopecks: "14500" },
    }],
    ...overrides,
  };
}

if (!enabled) {
  test("auto listing PostgreSQL integration is explicitly gated to a dedicated migration database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("PostgreSQL repository rolls back graphs, scopes replays, preserves snapshots and orders events", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_task4_${suffix}`;
    const schemaSql = quoteIdentifier(schema);
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
      await client.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort()) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      for (const accountId of [accountA, accountB]) {
        await client.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
          [accountId, `user-${accountId}`],
        );
        await client.query(
          `INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id)
           VALUES ($1,$2,$2,$3,'active',$4)`,
          [`store-${accountId}`, `Store ${accountId}`, `client-${accountId}`, accountId],
        );
        await client.query(
          `INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived)
           VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)`,
          [`warehouse-${accountId}`, `store-${accountId}`, `platform-${accountId}`],
        );
        await client.query(
          `INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash)
           VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)`,
          [`strategy-version-${accountId}`, accountId, `strategy-${accountId}`, `strategy-hash-${accountId}`],
        );
      }
      const scopedPool = {
        async connect() {
          const connection = await pool.connect();
          await connection.query(`SET search_path TO ${schemaSql}, public`);
          return connection;
        },
        async query(sql, params) {
          return client.query(sql, params);
        },
      };
      const repository = createAutoListingRepository({ pool: scopedPool });

      const bad = graph(accountA, "rollback-key", "rollback", {
        items: [
          graph(accountA, "x", "rollback-one").items[0],
          { ...graph(accountA, "x", "rollback-two").items[0], targetStoreId: "missing-store" },
        ],
      });
      await assert.rejects(repository.createJobGraph(bad));
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_jobs")).rows[0].count), 0);
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_source_snapshots")).rows[0].count), 0);
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_events")).rows[0].count), 0);

      const created = await repository.createJobGraph(graph(accountA, "shared-key", "a"));
      const replay = await repository.createJobGraph(graph(accountA, "shared-key", "different-payload"));
      const other = await repository.createJobGraph(graph(accountB, "shared-key", "b"));
      assert.equal(replay.duplicate, true);
      assert.equal(replay.id, created.id);
      assert.notEqual(other.id, created.id);
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_jobs")).rows[0].count), 2);

      const item = created.items[0];
      const snapshotBefore = await client.query(
        `SELECT snapshot,snapshot_hash FROM auto_listing_source_snapshots
          WHERE account_id=$1 AND source_record_id='collect-a'`, [accountA],
      );
      await repository.updateItemStatus({ accountId: accountA, itemId: item.id, expectedStatusVersion: 1, status: "PLANNING" });
      await assert.rejects(
        repository.updateItemStatus({ accountId: accountA, itemId: item.id, expectedStatusVersion: 1, status: "GENERATING" }),
        (error) => error?.code === "AUTO_LISTING_VERSION_CONFLICT",
      );
      const snapshotAfter = await client.query(
        `SELECT snapshot,snapshot_hash FROM auto_listing_source_snapshots
          WHERE account_id=$1 AND source_record_id='collect-a'`, [accountA],
      );
      assert.deepEqual(snapshotAfter.rows, snapshotBefore.rows);
      assert.equal(typeof repository.updateSnapshot, "undefined");

      const scoped = await repository.getJob({ accountId: accountA, jobId: created.id });
      assert.deepEqual(scoped.events.map((event) => event.eventType), ["CREATED", "SOURCE_CAPTURED"]);
      assert.equal(await repository.getJob({ accountId: accountB, jobId: created.id }), null);
      assert.deepEqual((await repository.listJobs({ accountId: accountB, limit: 10 })).map((job) => job.id), [other.id]);
    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });
}

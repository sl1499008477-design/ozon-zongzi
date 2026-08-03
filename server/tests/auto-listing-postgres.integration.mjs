import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

function graph(accountId, idempotencyKey, suffix, overrides = {}) {
  const sourceRecordId = `collect-${suffix}`;
  const sourceVersion = "1";
  const captured = buildAutoListingSourceSnapshot({
    accountId,
    sourceType: "COLLECT_BOX",
    sourceRecordId,
    sourceVersion,
    rawResponseRef: `raw-${suffix}`,
    rawResponseHash: `raw-hash-${suffix}`,
    collectItem: {
      id: sourceRecordId,
      accountId,
      sku: `sku-${suffix}`,
      listingDraft: {
        sku: `sku-${suffix}`,
        offerId: `offer-${suffix}`,
        title: `Product ${suffix}`,
        currency: "RUB", blackKopecks: "10000", greenKopecks: "8000", images: [], variants: [{ sku: `sku-${suffix}`, offerId: `offer-${suffix}` }],
        categoryResolution: { status: "MATCHED", method: "test", target: { storeId: `store-${accountId}`, descriptionCategoryId: "123", typeId: "456" }, source: { path: [] } },
      },
    },
  });
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
      sourceRecordId,
      sourceVersion,
      snapshot: captured.snapshot,
      snapshotHash: captured.snapshotHash,
      rawResponseRef: captured.rawResponseRef,
      targetStoreId: `store-${accountId}`,
      targetWarehouseId: `warehouse-${accountId}`,
      sourceOrder: 0,
      status: "SOURCE_READY",
      strategyId: `strategy-${accountId}`,
      strategyVersionId: `strategy-version-${accountId}`,
      style: "BALANCED_DEFAULT",
      matchedBy: "DEFAULT",
      price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500" },
    }],
    ...overrides,
  };
}

async function registerGraphSources(client, graphInput) {
  for (const item of graphInput.items) {
    await client.query(
      `INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary)
       VALUES ($1,$2,'test',$3,$4,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [item.sourceRecordId, graphInput.accountId, `identity-${item.sourceRecordId}`, item.snapshot.identity.primarySku],
    );
  }
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
          "INSERT INTO products (id,store_id,product_id,sku,status,raw) VALUES ($1,$2,$3,$4,'active','{}'::jsonb)",
          [`product-${accountId}`, `store-${accountId}`, `product-${accountId}`, `sku-${accountId}`],
        );
        await client.query(
          "INSERT INTO product_stocks (product_id,warehouse_id,store_id,source) VALUES ($1,$2,$3,'fbs')",
          [`product-${accountId}`, `warehouse-${accountId}`, `store-${accountId}`],
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

      const linkedCollect = `collect-linked-${suffix}`;
      const rawOne = `raw-one-${suffix}`;
      const rawTwo = `raw-two-${suffix}`;
      const linkedDraft = `draft-linked-${suffix}`;
      await client.query(
        `INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary)
         VALUES ($1,$2,'test',$3,'sku-linked','{}'::jsonb)`,
        [linkedCollect, accountA, `identity-linked-${suffix}`],
      );
      for (const [id, payloadHash, collectedAt] of [[rawOne, "payload-one", "2026-08-04T00:00:00.000Z"], [rawTwo, "payload-two", "2026-08-05T00:00:00.000Z"]]) {
        await client.query(
          `INSERT INTO collect_raw_payloads (id,collect_item_id,account_id,source_sku,payload_hash,payload,collected_at)
           VALUES ($1,$2,$3,'sku-linked',$4,'{"normalized":{"name":"linked"}}'::jsonb,$5::timestamptz)`,
          [id, linkedCollect, accountA, payloadHash, collectedAt],
        );
      }
      await client.query(
        `INSERT INTO product_drafts (id,collect_item_id,source_payload_id,version,data_hash,data)
         VALUES ($1,$2,$3,7,'draft-hash','{}'::jsonb)`,
        [linkedDraft, linkedCollect, rawOne],
      );
      await client.query("UPDATE collect_items SET current_draft_id=$1 WHERE id=$2 AND account_id=$3", [linkedDraft, linkedCollect, accountA]);
      const linked = await repository.loadCollectSources({ accountId: accountA, collectItemIds: [linkedCollect] });
      assert.equal(linked[0].rawResponseRef, rawOne);
      assert.equal(linked[0].rawResponseHash, "payload-one");
      assert.equal(linked[0].rawCollectedAt, "2026-08-04T00:00:00.000Z");

      const bad = graph(accountA, "rollback-key", "rollback", {
        items: [
          graph(accountA, "x", "rollback-one").items[0],
          { ...graph(accountA, "x", "rollback-two").items[0], sourceOrder: 1 },
        ],
      });
      await registerGraphSources(client, bad);
      await client.query(
        `INSERT INTO auto_listing_source_snapshots (
           id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          `baseline-conflict-${suffix}`, accountA, bad.items[1].sourceType, bad.items[1].sourceRecordId,
          bad.items[1].sourceVersion, JSON.stringify(bad.items[1].snapshot), "different-existing-hash", bad.items[1].rawResponseRef,
        ],
      );
      const malformed = graph(accountA, "malformed-key", "malformed");
      await registerGraphSources(client, malformed);
      malformed.items[0].snapshot = { identity: { accountId: accountA } };
      await assert.rejects(repository.createJobGraph(malformed), (error) => error?.code === "AUTO_LISTING_SOURCE_INVALID");
      await assert.rejects(repository.createJobGraph(bad));
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_jobs")).rows[0].count), 0);
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_source_snapshots")).rows[0].count), 1);
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_events")).rows[0].count), 0);

      const createdInput = graph(accountA, "shared-key", "a");
      const replayInput = graph(accountA, "shared-key", "different-payload");
      const otherInput = graph(accountB, "shared-key", "b");
      await registerGraphSources(client, createdInput);
      await registerGraphSources(client, replayInput);
      await registerGraphSources(client, otherInput);
      const created = await repository.createJobGraph(createdInput);
      const replay = await repository.createJobGraph(replayInput);
      const other = await repository.createJobGraph(otherInput);
      assert.equal(replay.duplicate, true);
      assert.equal(replay.id, created.id);
      assert.notEqual(other.id, created.id);
      assert.equal(Number((await client.query("SELECT count(*)::int AS count FROM auto_listing_jobs")).rows[0].count), 2);

      const item = created.items[0];
      const snapshotBefore = await client.query(
        `SELECT snapshot,snapshot_hash FROM auto_listing_source_snapshots
          WHERE account_id=$1 AND source_record_id='collect-a'`, [accountA],
      );
      await assert.rejects(
        repository.updateItemStatus({ accountId: accountA, itemId: item.id, expectedStatusVersion: 1, eventType: "UPLOAD_SUCCEEDED", actorAccountId: accountA, correlationId: "bad" }),
        (error) => error?.code === "AUTO_LISTING_TRANSITION_FORBIDDEN",
      );
      await repository.updateItemStatus({ accountId: accountA, itemId: item.id, expectedStatusVersion: 1, eventType: "START_PLANNING", actorAccountId: accountA, correlationId: "plan" });
      await assert.rejects(
        repository.updateItemStatus({ accountId: accountA, itemId: item.id, expectedStatusVersion: 1, eventType: "PLAN_READY", actorAccountId: accountA, correlationId: "stale" }),
        (error) => error?.code === "AUTO_LISTING_VERSION_CONFLICT",
      );
      const snapshotAfter = await client.query(
        `SELECT snapshot,snapshot_hash FROM auto_listing_source_snapshots
          WHERE account_id=$1 AND source_record_id='collect-a'`, [accountA],
      );
      assert.deepEqual(snapshotAfter.rows, snapshotBefore.rows);
      assert.equal(typeof repository.updateSnapshot, "undefined");

      const scoped = await repository.getJob({ accountId: accountA, jobId: created.id });
      assert.deepEqual(scoped.events.map((event) => event.eventType), ["CREATED", "SOURCE_CAPTURED", "START_PLANNING"]);
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

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";
import { buildAutoListingSourceSnapshot, canonicalAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(databaseUrl);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

function graph(accountId, idempotencyKey, suffix, overrides = {}) {
  const sourceRecordId = `collect-${suffix}`;
  const sourceVersion = "1";
  const { config, configHash } = normalizeAndHashAutoListingConfig({
    targetStoreId: `store-${accountId}`,
    targetWarehouseId: `warehouse-${accountId}`,
    stock: 1,
    priceAdjustmentKopecks: "0",
  });
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
    configSnapshot: config,
    configHash,
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
      ruleId: null,
      style: "BALANCED_DEFAULT",
      matchedBy: "DEFAULT",
      price: { currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000", realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500" },
      effectiveImageConfig: deriveEffectiveAutoListingImageConfig({
        configSnapshot: config, configHash, sourceCapture: captured,
      }),
    }],
    ...overrides,
  };
}

function withChangedSourceHash(input) {
  const changed = structuredClone(input);
  changed.items[0].snapshot.rawEvidence.rawResponseHash = "different-raw-hash";
  changed.items[0].snapshotHash = crypto.createHash("sha256")
    .update(canonicalAutoListingSourceSnapshot(changed.items[0].snapshot)).digest("hex");
  return changed;
}

function twoConnectionSnapshotBarrier(scopedPool, timeoutMs = 5_000) {
  let arrivals = 0;
  let settled = false;
  let abortCause = null;
  let resolveBarrier;
  const barrier = new Promise((resolve) => { resolveBarrier = resolve; });
  const abort = (cause = new Error("snapshot insertion barrier aborted")) => {
    if (settled) return;
    settled = true;
    abortCause = cause;
    clearTimeout(timeout);
    resolveBarrier();
  };
  const timeout = setTimeout(() => abort(new Error(`snapshot insertion barrier timed out after ${timeoutMs}ms (arrivals=${arrivals})`)), timeoutMs);
  const release = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolveBarrier();
  };
  return {
    query: (...args) => scopedPool.query(...args),
    abort,
    dispose: () => abort(new Error("snapshot insertion barrier disposed")),
    async connect() {
      const connection = await scopedPool.connect();
      return {
        async query(sql, params) {
          if (/INSERT INTO auto_listing_source_snapshots/.test(sql)) {
            arrivals += 1;
            if (arrivals === 2) release();
            await barrier;
            if (abortCause) throw abortCause;
          }
          return connection.query(sql, params);
        },
        release: () => connection.release(),
      };
    },
  };
}

async function runBarrierRace(repository, barrier, inputs) {
  const tasks = inputs.map((input) => repository.createJobGraph(input).catch((error) => {
    barrier.abort(error);
    throw error;
  }));
  try {
    return await Promise.allSettled(tasks);
  } finally {
    barrier.dispose();
  }
}

function twoConnectionTargetEvidenceBarrier(scopedPool, timeoutMs = 5_000) {
  let settled = false;
  let abortCause = null;
  let resolveLocked;
  let resolveProceed;
  const locked = new Promise((resolve) => { resolveLocked = resolve; });
  const proceed = new Promise((resolve) => { resolveProceed = resolve; });
  const finish = (cause = null) => {
    if (settled) return;
    settled = true;
    abortCause = cause;
    clearTimeout(timeout);
    resolveProceed();
  };
  const timeout = setTimeout(() => finish(new Error(`target evidence barrier timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    query: (...args) => scopedPool.query(...args),
    waitForLock: () => locked,
    release: () => finish(),
    dispose: () => finish(new Error("target evidence barrier disposed")),
    async connect() {
      const connection = await scopedPool.connect();
      return {
        async query(sql, params) {
          const result = await connection.query(sql, params);
          if (/FROM product_stocks ps/.test(sql) && /FOR SHARE OF p,ps/.test(sql)) {
            resolveLocked();
            await proceed;
            if (abortCause) throw abortCause;
          }
          return result;
        },
        release: () => connection.release(),
      };
    },
  };
}

async function assertStillWaiting(promise, timeoutMs = 80) {
  const state = await Promise.race([
    promise.then(() => "settled", () => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), timeoutMs)),
  ]);
  assert.equal(state, "waiting");
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

test("snapshot insertion barrier aborts a waiting peer without an internal rejected promise", async () => {
  const barrier = twoConnectionSnapshotBarrier({
    query: async () => ({ rows: [] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  }, 100);
  const connection = await barrier.connect();
  const waiting = connection.query("INSERT INTO auto_listing_source_snapshots (id) VALUES ('one')");
  const cause = new Error("pre-barrier worker failed");
  barrier.abort(cause);
  await assert.rejects(waiting, (error) => error === cause);
  barrier.dispose();

  const noParticipant = twoConnectionSnapshotBarrier({ query: async () => ({ rows: [] }), connect: async () => ({}) }, 100);
  noParticipant.abort(new Error("no participants"));
  noParticipant.dispose();
});

if (!enabled) {
  test("auto listing PostgreSQL integration is explicitly gated to a dedicated migration database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("PostgreSQL repository rolls back graphs, scopes replays, preserves snapshots and orders events", { timeout: 20_000 }, async () => {
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
          "INSERT INTO store_credentials (store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES ($1,$2,'ciphertext','iv','tag')",
          [`store-${accountId}`, `client-${accountId}`],
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
      await repository.updateItemStatus({
        accountId: accountA, itemId: item.id, expectedStatusVersion: 2, eventType: "RETRYABLE_FAILURE",
        actorAccountId: accountA, correlationId: "planning-failure", details: { failureCode: "AUTO_LISTING_TRANSIENT" },
      });
      const failureState = (await client.query(
        "SELECT status,status_version,failure_code,recovery_point FROM auto_listing_job_items WHERE id=$1", [item.id],
      )).rows[0];
      assert.deepEqual(failureState, {
        status: "RETRYABLE_ERROR", status_version: 3, failure_code: "AUTO_LISTING_TRANSIENT", recovery_point: "PLANNING",
      });
      assert.deepEqual((await client.query(
        "SELECT transition_version,details FROM auto_listing_events WHERE item_id=$1 AND event_type='RETRYABLE_FAILURE'", [item.id],
      )).rows[0], {
        transition_version: 3,
        details: { failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "PLANNING" },
      });
      const retryEventCount = Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [item.id],
      )).rows[0].count);
      await assert.rejects(
        repository.updateItemStatus({ accountId: accountA, itemId: item.id, expectedStatusVersion: 3, eventType: "RETRY_GENERATION", actorAccountId: accountA, correlationId: "wrong-retry" }),
        (error) => error?.code === "AUTO_LISTING_TRANSITION_FORBIDDEN",
      );
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [item.id],
      )).rows[0].count), retryEventCount);
      await repository.updateItemStatus({
        accountId: accountA, itemId: item.id, expectedStatusVersion: 3, eventType: "RETRY_PLANNING",
        actorAccountId: accountA, correlationId: "correct-retry",
      });
      assert.deepEqual((await client.query(
        "SELECT status,status_version,failure_code,recovery_point FROM auto_listing_job_items WHERE id=$1", [item.id],
      )).rows[0], {
        status: "PLANNING", status_version: 4, failure_code: null, recovery_point: null,
      });
      const snapshotAfter = await client.query(
        `SELECT snapshot,snapshot_hash FROM auto_listing_source_snapshots
          WHERE account_id=$1 AND source_record_id='collect-a'`, [accountA],
      );
      assert.deepEqual(snapshotAfter.rows, snapshotBefore.rows);
      assert.equal(typeof repository.updateSnapshot, "undefined");

      const scoped = await repository.getJob({ accountId: accountA, jobId: created.id });
      assert.deepEqual(scoped.events.map((event) => event.eventType), [
        "CREATED", "SOURCE_CAPTURED", "START_PLANNING", "RETRYABLE_FAILURE", "RETRY_PLANNING",
      ]);
      assert.equal(await repository.getJob({ accountId: accountB, jobId: created.id }), null);
      assert.deepEqual((await repository.listJobs({ accountId: accountB, limit: 10 })).map((job) => job.id), [other.id]);

      const duplicateEvent = graph(accountA, "duplicate-transition-event", "duplicate-transition-event");
      await registerGraphSources(client, duplicateEvent);
      const duplicateJob = await repository.createJobGraph(duplicateEvent);
      const duplicateItem = duplicateJob.items[0];
      await client.query(
        `INSERT INTO auto_listing_events (
           id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,correlation_id,transition_version,details
         ) VALUES ($1,$2,$3,$4,$5,'SOURCE_READY','PLANNING','TEST_DUPLICATE',$6,2,'{}'::jsonb)`,
        [`duplicate-transition-${suffix}`, accountA, duplicateJob.id, duplicateItem.id, accountA, `duplicate-${suffix}`],
      );
      const duplicateEventCount = Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [duplicateItem.id],
      )).rows[0].count);
      await assert.rejects(
        repository.updateItemStatus({
          accountId: accountA, itemId: duplicateItem.id, expectedStatusVersion: 1, eventType: "START_PLANNING",
          actorAccountId: accountA, correlationId: "duplicate-transition",
        }),
        (error) => error?.code === "23505",
      );
      assert.deepEqual((await client.query(
        "SELECT status,status_version FROM auto_listing_job_items WHERE id=$1", [duplicateItem.id],
      )).rows[0], { status: "SOURCE_READY", status_version: 1 });
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [duplicateItem.id],
      )).rows[0].count), duplicateEventCount);

      const sharedLeft = graph(accountA, "race-same-left", "race-same");
      const sharedRight = graph(accountA, "race-same-right", "race-same");
      await registerGraphSources(client, sharedLeft);
      const sameHashBarrier = twoConnectionSnapshotBarrier(scopedPool);
      const sameHashRepository = createAutoListingRepository({ pool: sameHashBarrier });
      const sameHashResults = await runBarrierRace(sameHashRepository, sameHashBarrier, [sharedLeft, sharedRight]);
      assert.equal(sameHashResults.every((result) => result.status === "fulfilled"), true);
      const [sharedOne, sharedTwo] = sameHashResults.map((result) => result.value);
      assert.notEqual(sharedOne.id, sharedTwo.id);
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_source_snapshots WHERE account_id=$1 AND source_record_id='collect-race-same'",
        [accountA],
      )).rows[0].count), 1);

      const conflictLeft = graph(accountA, "race-conflict-left", "race-conflict");
      const conflictRight = withChangedSourceHash(graph(accountA, "race-conflict-right", "race-conflict"));
      await registerGraphSources(client, conflictLeft);
      const conflictBarrier = twoConnectionSnapshotBarrier(scopedPool);
      const conflictRepository = createAutoListingRepository({ pool: conflictBarrier });
      const conflictResults = await runBarrierRace(conflictRepository, conflictBarrier, [conflictLeft, conflictRight]);
      assert.equal(conflictResults.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(conflictResults.find((result) => result.status === "rejected")?.reason?.code, "AUTO_LISTING_SOURCE_VERSION_CONFLICT");
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1 AND idempotency_key IN ('race-conflict-left','race-conflict-right')",
        [accountA],
      )).rows[0].count), 1);

      const eventFailure = graph(accountA, "event-failure", "event-failure");
      await registerGraphSources(client, eventFailure);
      const eventJob = await repository.createJobGraph(eventFailure);
      const eventItem = eventJob.items[0];
      await repository.updateItemStatus({
        accountId: accountA, itemId: eventItem.id, expectedStatusVersion: 1, eventType: "START_PLANNING",
        actorAccountId: accountA, correlationId: "event-failure-planning",
      });
      const eventCountBefore = Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [eventItem.id],
      )).rows[0].count);
      await client.query(`CREATE OR REPLACE FUNCTION ${schemaSql}.fail_task4_status_event()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.event_type = 'RETRYABLE_FAILURE' THEN RAISE EXCEPTION 'forced event failure'; END IF;
          RETURN NEW;
        END; $$`);
      await client.query(`CREATE TRIGGER fail_task4_status_event BEFORE INSERT ON auto_listing_events
        FOR EACH ROW EXECUTE FUNCTION ${schemaSql}.fail_task4_status_event()`);
      await assert.rejects(
        repository.updateItemStatus({
          accountId: accountA, itemId: eventItem.id, expectedStatusVersion: 2, eventType: "RETRYABLE_FAILURE",
          actorAccountId: accountA, correlationId: "event-failure", details: { failureCode: "AUTO_LISTING_TRANSIENT" },
        }),
      );
      const afterEventFailure = (await client.query(
        "SELECT status,status_version,failure_code,recovery_point FROM auto_listing_job_items WHERE id=$1", [eventItem.id],
      )).rows[0];
      assert.deepEqual(afterEventFailure, { status: "PLANNING", status_version: 2, failure_code: null, recovery_point: null });
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_events WHERE item_id=$1", [eventItem.id],
      )).rows[0].count), eventCountBefore);
    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });

  test("PostgreSQL target evidence locks invalidating warehouse and stock writes until a job commits", { timeout: 20_000 }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_task8_${suffix}`;
    const schemaSql = quoteIdentifier(schema);
    const accountId = `account-task8-${suffix}`;
    const storeId = `store-${accountId}`;
    const warehouseId = `warehouse-${accountId}`;
    const productId = `product-${accountId}`;
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
    try {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
      await client.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort()) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
        [accountId, `user-${accountId}`],
      );
      await client.query(
        "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
        [storeId, `Store ${accountId}`, `client-${accountId}`, accountId],
      );
      await client.query(
        "INSERT INTO store_credentials (store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES ($1,$2,'ciphertext','iv','tag')",
        [storeId, `client-${accountId}`],
      );
      await client.query(
        "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
        [warehouseId, storeId, `platform-${accountId}`],
      );
      await client.query(
        "INSERT INTO products (id,store_id,product_id,sku,status,raw) VALUES ($1,$2,$3,$4,'active','{}'::jsonb)",
        [productId, storeId, productId, `sku-${accountId}`],
      );
      await client.query(
        "INSERT INTO product_stocks (product_id,warehouse_id,store_id,source) VALUES ($1,$2,$3,'fbs')",
        [productId, warehouseId, storeId],
      );
      await client.query(
        "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)",
        [`strategy-version-${accountId}`, accountId, `strategy-${accountId}`, `strategy-hash-${accountId}`],
      );

      const runInvalidationRace = async ({ suffix: graphSuffix, sql, params }) => {
        const input = graph(accountId, `task8-${graphSuffix}`, graphSuffix);
        await registerGraphSources(client, input);
        const barrier = twoConnectionTargetEvidenceBarrier(scopedPool);
        const repository = createAutoListingRepository({ pool: barrier });
        const invalidator = await pool.connect();
        let creation;
        let invalidating;
        try {
          await invalidator.query(`SET search_path TO ${schemaSql}, public`);
          creation = repository.createJobGraph(input);
          await barrier.waitForLock();
          invalidating = invalidator.query(sql, params);
          await assertStillWaiting(invalidating);
          barrier.release();
          const created = await creation;
          await invalidating;
          return created;
        } finally {
          barrier.dispose();
          await creation?.catch(() => {});
          await invalidating?.catch(() => {});
          invalidator.release();
        }
      };

      const warehouseJob = await runInvalidationRace({
        suffix: "warehouse-update",
        sql: "UPDATE warehouses SET is_active=FALSE WHERE id=$1 AND store_id=$2",
        params: [warehouseId, storeId],
      });
      assert.ok(warehouseJob.id);
      assert.equal((await client.query("SELECT is_active FROM warehouses WHERE id=$1", [warehouseId])).rows[0].is_active, false);
      await client.query("UPDATE warehouses SET is_active=TRUE WHERE id=$1", [warehouseId]);

      const stockJob = await runInvalidationRace({
        suffix: "stock-delete",
        sql: "DELETE FROM product_stocks WHERE product_id=$1 AND warehouse_id=$2 AND store_id=$3 AND source='fbs'",
        params: [productId, warehouseId, storeId],
      });
      assert.ok(stockJob.id);
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM product_stocks WHERE product_id=$1 AND warehouse_id=$2", [productId, warehouseId],
      )).rows[0].count), 0);

      const invalidFirst = graph(accountId, "task8-invalid-first", "invalid-first");
      await registerGraphSources(client, invalidFirst);
      await assert.rejects(
        createAutoListingRepository({ pool: scopedPool }).createJobGraph(invalidFirst),
        (error) => error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE",
      );
      assert.equal(Number((await client.query(
        "SELECT count(*)::int AS count FROM auto_listing_jobs WHERE account_id=$1", [accountId],
      )).rows[0].count), 2);
    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });
}

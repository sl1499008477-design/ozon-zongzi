import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import "../env.mjs";
import { closePostgresPool, getPostgresPool, postgresEnabled } from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import {
  appendCollectorRunEvent,
  canTransitionCollectorRun,
  canTransitionCollectorTask,
  cancelCollectorRun,
  claimCollectorRun,
  completeCollectorRun,
  createCollectorExport,
  createCollectorTask,
  getCollectorExportForAccount,
  getCollectorTaskForAccount,
  heartbeatCollectorRun,
  listCollectorCategoryMappings,
  listCollectorMarketSnapshots,
  listCollectorRunEvents,
  listCollectorRunItems,
  listCollectorTasksPageForAccount,
  queueCollectorTaskRun,
  requestCollectorRunCancellation,
  softDeleteCollectorTask,
  updateCollectorExport,
  upsertCollectorCategoryMapping,
  upsertCollectorMarketSnapshot,
  upsertCollectorRunItem,
} from "../collector-desktop-service.mjs";

assert.equal(canTransitionCollectorTask("NOT_STARTED", "QUEUED"), true);
assert.equal(canTransitionCollectorTask("RUNNING", "COMPLETED"), true);
assert.equal(canTransitionCollectorTask("COMPLETED", "RUNNING"), false);
assert.equal(canTransitionCollectorRun("QUEUED", "RUNNING"), true);
assert.equal(canTransitionCollectorRun("COMPLETED", "RUNNING"), false);

if (!postgresEnabled()) {
  console.log("collector desktop integration skipped: PostgreSQL is not configured");
  process.exit(0);
}

const suffix = crypto.randomUUID();
const accountA = `collector_account_a_${suffix}`;
const accountB = `collector_account_b_${suffix}`;
const accountCascade = `collector_account_cascade_${suffix}`;
const operatingStoreId = `collector_operating_${suffix}`;
const collectionStoreA = `collector_data_a_${suffix}`;
const collectionStoreB = `collector_data_b_${suffix}`;
const sellerCompanyA = `${Date.now()}`.slice(-10) + "11";
const sellerCompanyB = `${Date.now()}`.slice(-10) + "22";
const collectItemId = `collector_box_${suffix}`;
const noStoreCollectItemId = `collector_no_store_${suffix}`;
const foreignPricingVersionId = `collector_foreign_pricing_${suffix}`;
const deviceKey = `collector-device-${suffix}`;
const legacyTaskId = `collector_legacy_task_${suffix}`;
const pool = await getPostgresPool();

async function cleanup() {
  await pool.query("DELETE FROM collector_market_snapshots WHERE account_id=ANY($1::text[])", [[accountA, accountB]]);
  await pool.query("DELETE FROM collector_category_mappings WHERE account_id=ANY($1::text[])", [[accountA, accountB]]);
  await pool.query(
    `UPDATE collector_tasks SET current_run_id=NULL WHERE account_id=ANY($1::text[])`,
    [[accountA, accountB]],
  );
  await pool.query("DELETE FROM collector_task_runs WHERE account_id=ANY($1::text[])", [[accountA, accountB]]);
  await pool.query("DELETE FROM collector_tasks WHERE account_id=ANY($1::text[])", [[accountA, accountB]]);
  await pool.query("DELETE FROM collector_devices WHERE account_id=ANY($1::text[])", [[accountA, accountB]]);
  await pool.query("DELETE FROM collect_items WHERE id=ANY($1::text[])", [[collectItemId, noStoreCollectItemId]]);
  await pool.query("DELETE FROM pricing_config_versions WHERE id=$1", [foreignPricingVersionId]);
  await pool.query(
    "DELETE FROM account_data_collection_stores WHERE account_id=ANY($1::text[])",
    [[accountA, accountB]],
  );
  await pool.query(
    "DELETE FROM data_collection_stores WHERE id=ANY($1::text[])",
    [[collectionStoreA, collectionStoreB]],
  );
  await pool.query("DELETE FROM stores WHERE id=$1", [operatingStoreId]);
  await pool.query("DELETE FROM accounts WHERE id=ANY($1::text[])", [[accountA, accountB, accountCascade]]);
}

async function assertMigrationRejectsUnownedLegacyRow() {
  const migration = await readFile(
    new URL("../db/migrations/019_account_scoped_collection_and_collector_sessions.sql", import.meta.url),
    "utf8",
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE collect_items ALTER COLUMN account_id DROP NOT NULL");
    await client.query("ALTER TABLE collect_raw_payloads ALTER COLUMN account_id DROP NOT NULL");
    await client.query(
      `INSERT INTO collect_items (id, account_id, source, identity_key, source_sku, summary)
       VALUES ($1, NULL, 'ozon', '', 'unowned-sku', '{}'::jsonb)`,
      [`unowned_collect_item_${suffix}`],
    );
    await client.query(
      `INSERT INTO collect_raw_payloads (id, collect_item_id, account_id, payload_hash, payload)
       VALUES ($1, $2, NULL, $3, '{}'::jsonb)`,
      [`unowned_raw_payload_${suffix}`, `unowned_collect_item_${suffix}`, `unowned-payload-hash-${suffix}`],
    );
    await assert.rejects(
      client.query(migration),
      (error) => error?.message.includes("collect_raw_payloads") && error?.message.includes(`unowned_raw_payload_${suffix}`),
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

try {
  await runMigrations(pool);
  await cleanup();
  await pool.query(
    `INSERT INTO accounts (id,username,display_name,role,status,created_at,updated_at)
     VALUES ($1,$2,$2,'user','active',NOW(),NOW()),($3,$4,$4,'user','active',NOW(),NOW()),($5,$6,$6,'user','active',NOW(),NOW())`,
    [accountA, `collector-a-${suffix}`, accountB, `collector-b-${suffix}`, accountCascade, `collector-cascade-${suffix}`],
  );
  await pool.query(
    `INSERT INTO collect_items (id, account_id, store_id, data_collection_store_id, source, identity_key, source_sku, summary)
     VALUES ($1, $2, NULL, NULL, 'ozon', $3, 'no-store-sku', '{}'::jsonb)`,
    [noStoreCollectItemId, accountA, `no-store-identity-${suffix}`],
  );
  const noStoreCollection = await pool.query(
    "SELECT store_id, data_collection_store_id FROM collect_items WHERE id=$1",
    [noStoreCollectItemId],
  );
  assert.deepEqual(noStoreCollection.rows[0], { store_id: null, data_collection_store_id: null }, "采集阶段可不绑定经营店铺或数据采集店铺");
  await pool.query("INSERT INTO sessions (token, account_id) VALUES ($1, $2)", [`ticket-parent-${suffix}`, accountA]);
  await pool.query(
    `INSERT INTO collector_auth_tickets (id, ticket_hash, account_id, parent_session_token, permissions, expires_at)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, NOW() + INTERVAL '1 hour')`,
    [`ticket-${suffix}`, `ticket-hash-${suffix}`, accountA, `ticket-parent-${suffix}`],
  );
  const consumed = await pool.query(
    "UPDATE collector_auth_tickets SET consumed_at=NOW() WHERE ticket_hash=$1 AND consumed_at IS NULL RETURNING id",
    [`ticket-hash-${suffix}`],
  );
  const consumedAgain = await pool.query(
    "UPDATE collector_auth_tickets SET consumed_at=NOW() WHERE ticket_hash=$1 AND consumed_at IS NULL RETURNING id",
    [`ticket-hash-${suffix}`],
  );
  assert.equal(consumed.rowCount, 1);
  assert.equal(consumedAgain.rowCount, 0);
  await pool.query("INSERT INTO sessions (token, account_id) VALUES ($1, $2)", [`cascade-parent-${suffix}`, accountCascade]);
  await pool.query(
    `INSERT INTO collector_sessions (
       id, token_hash, account_id, parent_session_token, device_fingerprint, extension_version, permissions, expires_at
     ) VALUES ($1, $2, $3, $4, 'cascade-device', 'test', '[]'::jsonb, NOW() + INTERVAL '1 hour')`,
    [`collector-session-${suffix}`, `collector-session-hash-${suffix}`, accountCascade, `cascade-parent-${suffix}`],
  );
  await pool.query(
    `INSERT INTO collector_auth_tickets (id, ticket_hash, account_id, parent_session_token, permissions, expires_at)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, NOW() + INTERVAL '1 hour')`,
    [`cascade-ticket-${suffix}`, `cascade-ticket-hash-${suffix}`, accountCascade, `cascade-parent-${suffix}`],
  );
  await pool.query("DELETE FROM accounts WHERE id=$1", [accountCascade]);
  const cascadeCounts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM collector_auth_tickets WHERE account_id=$1) AS ticket_count,
       (SELECT COUNT(*)::int FROM collector_sessions WHERE account_id=$1) AS session_count`,
    [accountCascade],
  );
  assert.deepEqual(cascadeCounts.rows[0], { ticket_count: 0, session_count: 0 });
  await pool.query(
    `INSERT INTO stores (id,owner_account_id,label,client_id,status,updated_at)
     VALUES ($1,$2,'Collector Operating Store',$3,'active',NOW())`,
    [operatingStoreId, accountA, `collector-client-${suffix}`],
  );
  await pool.query(
    `INSERT INTO data_collection_stores (id,seller_company_id)
     VALUES ($1,$2),($3,$4)`,
    [collectionStoreA, sellerCompanyA, collectionStoreB, sellerCompanyB],
  );
  await pool.query(
    `INSERT INTO account_data_collection_stores (
       account_id,data_collection_store_id,label,status,is_current,last_verified_at
     ) VALUES
       ($1,$2,'Default but stale','active',TRUE,NULL),
       ($1,$3,'Verified Seller','active',FALSE,NOW())`,
    [accountA, collectionStoreA, collectionStoreB],
  );

  const storelessTask = await createCollectorTask({
    accountId: accountB,
    name: "无店铺账号任务",
    taskType: "SELLER_ANALYTICS",
  });
  assert.equal(storelessTask.accountId, accountB);
  assert.equal(storelessTask.operatingStoreId, null);
  assert.equal(Object.hasOwn(storelessTask, "dataCollectionStoreId"), false);

  const task = await createCollectorTask({
    accountId: accountA,
    name: `Seller Analytics ${suffix}`,
    taskType: "SELLER_ANALYTICS",
    concurrency: 4,
    configuration: {
      period: "MONTHLY",
      categoryId: "root-1",
      nested: {
        operatingStoreId,
        dataCollectionStoreId: collectionStoreA,
        sellerCompanyId: sellerCompanyA,
        keep: true,
      },
    },
  });
  assert.equal(task.status, "NOT_STARTED");
  assert.equal(task.operatingStoreId, null);
  assert.equal(Object.hasOwn(task, "dataCollectionStoreId"), false);
  assert.deepEqual(task.configuration.nested, { keep: true });
  assert.equal(await getCollectorTaskForAccount(accountB, task.id), null);

  await pool.query(
    `INSERT INTO collector_tasks (
       id,account_id,operating_store_id,data_collection_store_id,name,task_type,source,created_by
     ) VALUES ($1,$2,$3,$4,'Legacy scoped task','SELLER_ANALYTICS','ozon',$2)`,
    [legacyTaskId, accountA, operatingStoreId, collectionStoreA],
  );
  const legacyTask = await getCollectorTaskForAccount(accountA, legacyTaskId);
  assert.equal(legacyTask.operatingStoreId, null);
  assert.equal(Object.hasOwn(legacyTask, "dataCollectionStoreId"), false);
  assert.deepEqual(legacyTask.legacyScope, {
    operatingStoreId,
    dataCollectionStoreId: collectionStoreA,
  });

  const page = await listCollectorTasksPageForAccount({
    accountId: accountA,
    taskName: "Seller Analytics",
    page: 1,
    pageSize: 10,
  });
  assert.equal(page.total, 1);
  assert.equal(page.tasks[0].id, task.id);

  await pool.query(
    `INSERT INTO pricing_config_versions (
       id,version_no,scope_type,scope_id,status,effective_from,config_hash,note
     ) VALUES ($1,9001,'account',$2,'ACTIVE',NOW()-INTERVAL '1 minute',$1,'foreign account only')`,
    [foreignPricingVersionId, accountB],
  );
  await assert.rejects(
    queueCollectorTaskRun({
      accountId: accountA,
      taskId: task.id,
      pricingConfigVersionId: foreignPricingVersionId,
    }),
    (error) => error?.code === "COLLECTOR_PRICING_CONFIG_UNAVAILABLE",
  );

  const queued = await queueCollectorTaskRun({
    accountId: accountA,
    taskId: task.id,
    idempotencyKey: `collector-run-${suffix}`,
  });
  assert.equal(queued.duplicate, false);
  assert.equal(queued.run.status, "QUEUED");
  assert.equal(queued.run.operatingStoreId, null);
  assert.equal(Object.hasOwn(queued.run, "dataCollectionStoreId"), false);
  assert.equal(Object.hasOwn(queued.run.configurationSnapshot, "sellerCompanyId"), false);
  assert.equal(Object.hasOwn(queued.run.configurationSnapshot, "dataCollectionStoreId"), false);
  assert.ok(queued.run.pricingConfigVersionId);

  const duplicate = await queueCollectorTaskRun({
    accountId: accountA,
    taskId: task.id,
    idempotencyKey: `collector-run-${suffix}`,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.run.id, queued.run.id);

  const claimed = await claimCollectorRun({
    accountId: accountA,
    runId: queued.run.id,
    deviceId: deviceKey,
    device: { name: "Integration Mac", platform: "darwin", arch: "arm64", appVersion: "test" },
    leaseSeconds: 90,
  });
  assert.equal(claimed.run.status, "RUNNING");
  assert.ok(claimed.leaseToken);

  await assert.rejects(
    heartbeatCollectorRun({
      accountId: accountA,
      runId: queued.run.id,
      deviceId: deviceKey,
      leaseToken: "wrong-token",
    }),
    (error) => error?.code === "COLLECTOR_RUN_LEASE_MISMATCH",
  );
  const heartbeat = await heartbeatCollectorRun({
    accountId: accountA,
    runId: queued.run.id,
    deviceId: deviceKey,
    leaseToken: claimed.leaseToken,
    progress: { totalCount: 1 },
  });
  assert.equal(heartbeat.run.totalCount, 1);

  await pool.query(
    `INSERT INTO collect_items (
       id,account_id,store_id,data_collection_store_id,source,identity_key,
       source_sku,status,summary
     ) VALUES ($1,$2,$3,$4,'ozon',$5,$6,'COLLECTED','{}'::jsonb)`,
    [collectItemId, accountA, operatingStoreId, collectionStoreB, `identity-${suffix}`, `sku-${suffix}`],
  );
  const historicalDataStore = await pool.query(
    "SELECT data_collection_store_id FROM collect_items WHERE id=$1",
    [collectItemId],
  );
  assert.equal(historicalDataStore.rows[0]?.data_collection_store_id, collectionStoreB, "已有采集记录保留原数据采集店铺证据");
  const firstItem = await upsertCollectorRunItem({
    accountId: accountA,
    runId: queued.run.id,
    deviceId: deviceKey,
    leaseToken: claimed.leaseToken,
    item: {
      collectItemId,
      source: "ozon",
      sourceKey: `sku-${suffix}`,
      sourceSku: `sku-${suffix}`,
      status: "DISCOVERED",
      rawPayload: { title: "Ozon source" },
    },
  });
  assert.equal(firstItem.created, true);
  assert.equal(firstItem.item.operatingStoreId, null);
  assert.equal(Object.hasOwn(firstItem.item, "dataCollectionStoreId"), false);
  const completedItem = await upsertCollectorRunItem({
    accountId: accountA,
    runId: queued.run.id,
    deviceId: deviceKey,
    leaseToken: claimed.leaseToken,
    item: {
      source: "ozon",
      sourceKey: `sku-${suffix}`,
      status: "QUALIFIED",
      analytics: { gmv: 1000, sold: 12 },
      pricing: { profit: 22.5 },
    },
  });
  assert.equal(completedItem.created, false);
  assert.deepEqual(completedItem.item.rawPayload, { title: "Ozon source" });
  assert.equal(completedItem.item.collectItemId, collectItemId);
  assert.equal((await listCollectorRunItems({ accountId: accountA, runId: queued.run.id })).length, 1);
  assert.equal((await listCollectorRunItems({ accountId: accountB, runId: queued.run.id })).length, 0);

  const snapshot = await upsertCollectorMarketSnapshot({
    accountId: accountA,
    runId: queued.run.id,
    source: "ozon_seller_analytics",
    snapshotKey: `seller-page:${suffix}:sku-${suffix}:monthly`,
    sourceSku: `sku-${suffix}`,
    categoryId: "leaf-1",
    period: "MONTHLY",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    requestId: `snapshot-${suffix}`,
    metrics: { gmv: 1000, sold: 12 },
    payload: { sku: `sku-${suffix}`, title: "Analytics row" },
  });
  assert.equal(snapshot.operatingStoreId, null);
  assert.equal(Object.hasOwn(snapshot, "dataCollectionStoreId"), false);
  assert.equal(snapshot.source, "ozon_seller_analytics");
  assert.equal((await listCollectorMarketSnapshots({
    accountId: accountA,
    source: "ozon_seller_analytics",
  })).length, 1);
  assert.equal((await listCollectorMarketSnapshots({
    accountId: accountB,
    source: "ozon_seller_analytics",
  })).length, 0);

  const mapping = await upsertCollectorCategoryMapping({
    accountId: accountA,
    source: "ozon_seller_analytics",
    rootCategoryId: "root-1",
    rootCategoryName: "Root",
    leafCategoryId: "leaf-1",
    leafCategoryName: "Leaf",
  });
  assert.equal(mapping.leafCategoryId, "leaf-1");
  assert.equal((await listCollectorCategoryMappings({
    accountId: accountA,
    source: "ozon_seller_analytics",
    rootCategoryId: "root-1",
  })).length, 1);
  assert.equal((await listCollectorCategoryMappings({
    accountId: accountB,
    source: "ozon_seller_analytics",
    rootCategoryId: "root-1",
  })).length, 0);

  await appendCollectorRunEvent({
    accountId: accountA,
    runId: queued.run.id,
    eventType: "DESKTOP_LOG",
    message: "integration event",
    actorType: "device",
    actorId: claimed.device.id,
  });
  assert.ok((await listCollectorRunEvents({ accountId: accountA, runId: queued.run.id }))
    .some((event) => event.eventType === "DESKTOP_LOG"));

  const completed = await completeCollectorRun({
    accountId: accountA,
    runId: queued.run.id,
    deviceId: deviceKey,
    leaseToken: claimed.leaseToken,
    resultSummary: { qualifiedCount: 1 },
  });
  assert.equal(completed.status, "COMPLETED");

  const exportRecord = await createCollectorExport({
    accountId: accountA,
    runId: queued.run.id,
    fileName: "collector.xlsx",
  });
  assert.equal(exportRecord.operatingStoreId, null);
  assert.equal(Object.hasOwn(exportRecord, "dataCollectionStoreId"), false);
  assert.equal(await getCollectorExportForAccount(accountB, exportRecord.id), null);
  const generatingExport = await updateCollectorExport({
    accountId: accountA,
    exportId: exportRecord.id,
    patch: { status: "GENERATING" },
  });
  assert.equal(generatingExport.status, "GENERATING");
  const readyExport = await updateCollectorExport({
    accountId: accountA,
    exportId: exportRecord.id,
    patch: {
      status: "READY",
      objectKey: `collector/${suffix}.xlsx`,
      size: 1024,
      itemCount: 1,
      sha256: "a".repeat(64),
    },
  });
  assert.equal(readyExport.status, "READY");

  const rerun = await queueCollectorTaskRun({
    accountId: accountA,
    taskId: task.id,
    idempotencyKey: `collector-rerun-${suffix}`,
  });
  const rerunClaim = await claimCollectorRun({
    accountId: accountA,
    runId: rerun.run.id,
    deviceId: deviceKey,
  });
  const cancelRequested = await requestCollectorRunCancellation({
    accountId: accountA,
    runId: rerun.run.id,
  });
  assert.equal(cancelRequested.cancelRequested, true);
  const cancelledHeartbeat = await heartbeatCollectorRun({
    accountId: accountA,
    runId: rerun.run.id,
    deviceId: deviceKey,
    leaseToken: rerunClaim.leaseToken,
  });
  assert.equal(cancelledHeartbeat.cancelRequested, true);
  const cancelled = await cancelCollectorRun({
    accountId: accountA,
    runId: rerun.run.id,
    deviceId: deviceKey,
    leaseToken: rerunClaim.leaseToken,
    resultSummary: { reason: "user_request" },
  });
  assert.equal(cancelled.status, "CANCELLED");

  const staleRun = await queueCollectorTaskRun({
    accountId: accountA,
    taskId: task.id,
    idempotencyKey: `collector-stale-${suffix}`,
  });
  await claimCollectorRun({
    accountId: accountA,
    runId: staleRun.run.id,
    deviceId: deviceKey,
  });
  await pool.query(
    "UPDATE collector_task_runs SET lock_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",
    [staleRun.run.id],
  );
  const staleCancelled = await requestCollectorRunCancellation({
    accountId: accountA,
    runId: staleRun.run.id,
  });
  assert.equal(staleCancelled.status, "CANCELLED");

  assert.equal(await softDeleteCollectorTask(accountA, task.id), true);
  assert.equal(await getCollectorTaskForAccount(accountA, task.id), null);
  const collectItemStillExists = await pool.query("SELECT id FROM collect_items WHERE id=$1", [collectItemId]);
  assert.equal(collectItemStillExists.rowCount, 1, "删除任务不能级联删除采集箱商品");
  await assertMigrationRejectsUnownedLegacyRow();

  console.log("collector desktop integration passed");
} finally {
  await cleanup();
  await closePostgresPool();
}

import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const operatingStoreId = `collector_operating_${suffix}`;
const collectionStoreA = `collector_data_a_${suffix}`;
const collectionStoreB = `collector_data_b_${suffix}`;
const sellerCompanyA = `${Date.now()}`.slice(-10) + "11";
const sellerCompanyB = `${Date.now()}`.slice(-10) + "22";
const collectItemId = `collector_box_${suffix}`;
const foreignPricingVersionId = `collector_foreign_pricing_${suffix}`;
const deviceKey = `collector-device-${suffix}`;
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
  await pool.query("DELETE FROM collect_items WHERE id=$1", [collectItemId]);
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
  await pool.query("DELETE FROM accounts WHERE id=ANY($1::text[])", [[accountA, accountB]]);
}

try {
  await runMigrations(pool);
  await cleanup();
  await pool.query(
    `INSERT INTO accounts (id,username,display_name,role,status,created_at,updated_at)
     VALUES ($1,$2,$2,'user','active',NOW(),NOW()),($3,$4,$4,'user','active',NOW(),NOW())`,
    [accountA, `collector-a-${suffix}`, accountB, `collector-b-${suffix}`],
  );
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

  await assert.rejects(
    createCollectorTask({
      accountId: accountB,
      operatingStoreId,
      name: "越权任务",
      taskType: "SELLER_ANALYTICS",
    }),
    (error) => error?.code === "COLLECTOR_OPERATING_STORE_UNAVAILABLE",
  );

  const task = await createCollectorTask({
    accountId: accountA,
    operatingStoreId,
    dataCollectionStoreId: collectionStoreA,
    name: `Seller Analytics ${suffix}`,
    taskType: "SELLER_ANALYTICS",
    concurrency: 4,
    configuration: { period: "MONTHLY", categoryId: "root-1" },
  });
  assert.equal(task.status, "NOT_STARTED");
  assert.equal(task.dataCollectionStoreId, collectionStoreA);
  assert.equal(await getCollectorTaskForAccount(accountB, task.id), null);

  const page = await listCollectorTasksPageForAccount({
    accountId: accountA,
    taskName: "Seller Analytics",
    page: 1,
    pageSize: 10,
  });
  assert.equal(page.total, 1);
  assert.equal(page.tasks[0].id, task.id);

  await assert.rejects(
    queueCollectorTaskRun({ accountId: accountA, taskId: task.id }),
    (error) => error?.code === "COLLECTOR_DATA_STORE_VERIFICATION_REQUIRED",
  );

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
      dataCollectionStoreId: collectionStoreB,
      pricingConfigVersionId: foreignPricingVersionId,
    }),
    (error) => error?.code === "COLLECTOR_PRICING_CONFIG_UNAVAILABLE",
  );

  const queued = await queueCollectorTaskRun({
    accountId: accountA,
    taskId: task.id,
    dataCollectionStoreId: collectionStoreB,
    idempotencyKey: `collector-run-${suffix}`,
  });
  assert.equal(queued.duplicate, false);
  assert.equal(queued.run.status, "QUEUED");
  assert.equal(queued.run.dataCollectionStoreId, collectionStoreB);
  assert.notEqual(queued.run.dataCollectionStoreId, task.dataCollectionStoreId);
  assert.equal(queued.run.configurationSnapshot.sellerCompanyId, sellerCompanyB);
  assert.ok(queued.run.pricingConfigVersionId);

  const duplicate = await queueCollectorTaskRun({
    accountId: accountA,
    taskId: task.id,
    dataCollectionStoreId: collectionStoreB,
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

  await assert.rejects(
    upsertCollectorMarketSnapshot({
      accountId: accountA,
      operatingStoreId,
      dataCollectionStoreId: collectionStoreB,
      sellerCompanyId: sellerCompanyA,
      runId: queued.run.id,
      sourceSku: `sku-${suffix}`,
      period: "MONTHLY",
      payload: { sku: `sku-${suffix}` },
    }),
    (error) => error?.code === "COLLECTOR_SELLER_COMPANY_MISMATCH",
  );
  const snapshot = await upsertCollectorMarketSnapshot({
    accountId: accountA,
    operatingStoreId,
    dataCollectionStoreId: collectionStoreB,
    sellerCompanyId: sellerCompanyB,
    runId: queued.run.id,
    sourceSku: `sku-${suffix}`,
    categoryId: "leaf-1",
    period: "MONTHLY",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    requestId: `snapshot-${suffix}`,
    metrics: { gmv: 1000, sold: 12 },
    payload: { sku: `sku-${suffix}`, title: "Analytics row" },
  });
  assert.equal(snapshot.dataCollectionStoreId, collectionStoreB);
  assert.equal((await listCollectorMarketSnapshots({
    accountId: accountA,
    operatingStoreId,
    dataCollectionStoreId: collectionStoreB,
    sellerCompanyId: sellerCompanyB,
  })).length, 1);

  const mapping = await upsertCollectorCategoryMapping({
    accountId: accountA,
    operatingStoreId,
    dataCollectionStoreId: collectionStoreB,
    sellerCompanyId: sellerCompanyB,
    rootCategoryId: "root-1",
    rootCategoryName: "Root",
    leafCategoryId: "leaf-1",
    leafCategoryName: "Leaf",
  });
  assert.equal(mapping.leafCategoryId, "leaf-1");
  assert.equal((await listCollectorCategoryMappings({
    accountId: accountA,
    operatingStoreId,
    dataCollectionStoreId: collectionStoreB,
    rootCategoryId: "root-1",
  })).length, 1);

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
    dataCollectionStoreId: collectionStoreB,
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
    dataCollectionStoreId: collectionStoreB,
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

  console.log("collector desktop integration passed");
} finally {
  await cleanup();
  await closePostgresPool();
}

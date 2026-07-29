import "../env.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getPostgresPool, closePostgresPool, postgresEnabled } from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import {
  createSubmissionV3,
  listCollectItemsV3,
  mirrorCollectItemV3,
  softDeleteCollectItemsV3,
} from "../listing-pipeline.mjs";

if (!postgresEnabled()) {
  console.log("listing pipeline v3 integration skipped: PostgreSQL is not configured");
  process.exit(0);
}

const suffix = crypto.randomUUID();
const accountId = `test_account_${suffix}`;
const storeId = `test_store_${suffix}`;
const collectId = `test_collect_${suffix}`;
const pool = await getPostgresPool();

async function cleanup() {
  const jobs = await pool.query("SELECT id, snapshot_id FROM submission_jobs WHERE collect_item_id=$1", [collectId]);
  const jobIds = jobs.rows.map((row) => row.id);
  const snapshotIds = jobs.rows.map((row) => row.snapshot_id);
  if (jobIds.length) {
    await pool.query("DELETE FROM outbox_events WHERE aggregate_id=ANY($1::text[])", [jobIds]);
    await pool.query("DELETE FROM audit_events WHERE entity_id=ANY($1::text[])", [jobIds]);
    await pool.query("DELETE FROM submission_jobs WHERE id=ANY($1::text[])", [jobIds]);
  }
  if (snapshotIds.length) await pool.query("DELETE FROM submission_snapshots WHERE id=ANY($1::text[])", [snapshotIds]);
  await pool.query("DELETE FROM collect_items WHERE id=$1", [collectId]);
  await pool.query("DELETE FROM collect_raw_payloads WHERE collect_item_id=$1", [collectId]);
  await pool.query("DELETE FROM stores WHERE id=$1", [storeId]);
  await pool.query("DELETE FROM accounts WHERE id=$1", [accountId]);
}

try {
  await runMigrations(pool);
  await cleanup();
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$3,'admin','active')",
    [accountId, `pipeline-${suffix}`, "Pipeline Test"],
  );
  await pool.query(
    "INSERT INTO stores (id,owner_account_id,label,client_id,status) VALUES ($1,$2,$3,$4,'active')",
    [storeId, accountId, "Pipeline Test Store", `client-${suffix}`],
  );

  const baseItem = {
    id: collectId,
    accountId,
    storeId,
    sku: "source-sku-1",
    name: "原始采集标题",
    createdBy: "legacy-creator",
    sellerCompanyId: "legacy-seller",
    images: ["https://example.invalid/1.jpg"],
    listingDraft: {
      sku: "source-sku-1",
      title: "预处理标题",
      price: "100.00",
      variants: [{ sku: "source-sku-1", offerId: "offer-1", price: "100.00" }],
    },
    collectedAt: new Date().toISOString(),
  };

  const first = await mirrorCollectItemV3(baseItem, { accountId, storeId, captureRaw: true });
  assert.equal(first.version, 1);
  const [publicItem] = await listCollectItemsV3({ accountId });
  assert.equal("createdBy" in publicItem, false);
  assert.equal("sellerCompanyId" in publicItem, false);
  const edited = await mirrorCollectItemV3({
    ...baseItem,
    listingDraft: { ...baseItem.listingDraft, title: "用户修改标题" },
  }, { accountId, storeId, captureRaw: false });
  assert.equal(edited.version, 2);
  let counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM collect_raw_payloads WHERE collect_item_id=$1) raw_count,
       (SELECT COUNT(*)::int FROM product_draft_revisions r JOIN product_drafts d ON d.id=r.draft_id WHERE d.collect_item_id=$1) revision_count`,
    [collectId],
  );
  assert.equal(counts.rows[0].raw_count, 1);
  assert.equal(counts.rows[0].revision_count, 2);

  await mirrorCollectItemV3({ ...baseItem, name: "重新采集标题" }, { accountId, storeId, captureRaw: true });
  counts = await pool.query("SELECT COUNT(*)::int AS count FROM collect_raw_payloads WHERE collect_item_id=$1", [collectId]);
  assert.equal(counts.rows[0].count, 2);

  const normalizedItems = [{
    offer_id: "offer-1",
    name: "用户修改标题",
    price: "100.00",
    currency_code: "CNY",
    images: ["https://example.invalid/1.jpg"],
    description_category_id: 1,
    type_id: 2,
    attributes: [],
  }];
  const created = await createSubmissionV3({
    collectItem: { ...baseItem, listingDraft: { ...baseItem.listingDraft, title: "用户修改标题" } },
    accountId,
    storeId,
    normalizedItems,
    stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
  });
  assert.equal(created.duplicate, false);
  normalizedItems[0].name = "外部对象被修改";
  const snapshot = await pool.query("SELECT items FROM submission_snapshots WHERE id=$1", [created.job.snapshotId]);
  assert.equal(snapshot.rows[0].items[0].name, "用户修改标题");

  const duplicate = await createSubmissionV3({
    collectItem: { ...baseItem, listingDraft: { ...baseItem.listingDraft, title: "用户修改标题" } },
    accountId,
    storeId,
    normalizedItems: [{ ...normalizedItems[0], name: "用户修改标题" }],
    stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.id, created.job.id);

  await pool.query("UPDATE submission_jobs SET status='FAILED', completed_at=NOW(), updated_at=NOW() WHERE id=$1", [created.job.id]);
  const retry = await createSubmissionV3({
    collectItem: { ...baseItem, listingDraft: { ...baseItem.listingDraft, title: "用户修改标题" } },
    accountId,
    storeId,
    normalizedItems: [{ ...normalizedItems[0], name: "用户修改标题" }],
    stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
    retryFailed: true,
  });
  assert.equal(retry.duplicate, false);
  assert.notEqual(retry.job.id, created.job.id);
  const duplicateRetry = await createSubmissionV3({
    collectItem: { ...baseItem, listingDraft: { ...baseItem.listingDraft, title: "用户修改标题" } },
    accountId,
    storeId,
    normalizedItems: [{ ...normalizedItems[0], name: "用户修改标题" }],
    stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
    retryFailed: true,
  });
  assert.equal(duplicateRetry.duplicate, true);
  assert.equal(duplicateRetry.job.id, retry.job.id);

  assert.equal(await softDeleteCollectItemsV3(accountId, [collectId]), 1);
  const deleted = await pool.query("SELECT deleted_at FROM collect_items WHERE id=$1", [collectId]);
  assert.ok(deleted.rows[0].deleted_at);
  console.log("listing pipeline v3 integration passed");
} finally {
  await cleanup();
  await closePostgresPool();
}

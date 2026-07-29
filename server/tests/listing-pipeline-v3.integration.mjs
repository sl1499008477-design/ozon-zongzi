import "../env.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encryptSecret } from "../crypto-secrets.mjs";
import { getPostgresPool, closePostgresPool, postgresEnabled } from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import {
  assertUsableOperatingStore,
  createSubmissionV3,
  listCollectItemsV3,
  mirrorCollectItemV3,
  prepareCollectItemForListing,
  softDeleteCollectItemsV3,
} from "../listing-pipeline.mjs";

if (!postgresEnabled()) {
  console.log("listing pipeline v3 integration skipped: PostgreSQL is not configured");
  process.exit(0);
}

const suffix = crypto.randomUUID();
const accountId = `test_account_${suffix}`;
const foreignAccountId = `test_foreign_account_${suffix}`;
const storeId = `test_store_${suffix}`;
const secondStoreId = `test_store_second_${suffix}`;
const foreignStoreId = `test_store_foreign_${suffix}`;
const disabledStoreId = `test_store_disabled_${suffix}`;
const noCredentialStoreId = `test_store_no_credential_${suffix}`;
const collectId = `test_collect_${suffix}`;
const storeIds = [storeId, secondStoreId, foreignStoreId, disabledStoreId, noCredentialStoreId];
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
  await pool.query("DELETE FROM stores WHERE id=ANY($1::text[])", [storeIds]);
  await pool.query("DELETE FROM accounts WHERE id=ANY($1::text[])", [[accountId, foreignAccountId]]);
}

async function saveCredential(targetStoreId, clientId) {
  const encrypted = encryptSecret(`secret-${targetStoreId}`);
  await pool.query(
    `INSERT INTO store_credentials (
       store_id,client_id,encrypted_api_key,iv,auth_tag,algorithm,key_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      targetStoreId,
      clientId,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      encrypted.algorithm,
      encrypted.keyVersion,
    ],
  );
}

try {
  await runMigrations(pool);
  await cleanup();
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$3,'admin','active')",
    [accountId, `pipeline-${suffix}`, "Pipeline Test"],
  );
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$3,'user','active')",
    [foreignAccountId, `pipeline-foreign-${suffix}`, "Pipeline Foreign Test"],
  );
  await pool.query(
    "INSERT INTO stores (id,owner_account_id,label,client_id,status,is_current,currency_code) VALUES ($1,$2,$3,$4,'active',TRUE,'RUB')",
    [storeId, accountId, "Pipeline Test Store", `client-${suffix}`],
  );
  await pool.query(
    `INSERT INTO stores (id,owner_account_id,label,client_id,status,is_current,currency_code)
     VALUES
       ($1,$5,'Pipeline Second Store',$6,'active',FALSE,'RUB'),
       ($2,$7,'Foreign Secret Store',$8,'active',FALSE,'RUB'),
       ($3,$5,'Pipeline Disabled Store',$9,'disabled',FALSE,'RUB'),
       ($4,$5,'Pipeline No Credential Store',$10,'active',FALSE,'RUB')`,
    [
      secondStoreId,
      foreignStoreId,
      disabledStoreId,
      noCredentialStoreId,
      accountId,
      `client-second-${suffix}`,
      foreignAccountId,
      `client-foreign-${suffix}`,
      `client-disabled-${suffix}`,
      `client-no-credential-${suffix}`,
    ],
  );
  await saveCredential(storeId, `client-${suffix}`);
  await saveCredential(secondStoreId, `client-second-${suffix}`);
  await saveCredential(foreignStoreId, `client-foreign-${suffix}`);
  await saveCredential(disabledStoreId, `client-disabled-${suffix}`);

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
  const created = await prepareCollectItemForListing({
    collectItem: { ...baseItem, listingDraft: { ...baseItem.listingDraft, title: "用户修改标题" } },
    accountId,
    collectItemId: collectId,
    targetStoreId: storeId,
    idempotencyKey: `prepare-${suffix}`,
    normalizedItems,
    stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
  });
  assert.equal(created.duplicate, false);
  normalizedItems[0].name = "外部对象被修改";
  const snapshot = await pool.query(
    "SELECT items,store_id,idempotency_key FROM submission_snapshots WHERE id=$1",
    [created.job.snapshotId],
  );
  assert.equal(snapshot.rows[0].items[0].name, "用户修改标题");
  assert.equal(snapshot.rows[0].store_id, storeId);

  await pool.query("UPDATE stores SET is_current=FALSE WHERE owner_account_id=$1", [accountId]);
  await pool.query("UPDATE stores SET is_current=TRUE WHERE id=$1", [secondStoreId]);

  const duplicate = await prepareCollectItemForListing({
    collectItem: { ...baseItem, listingDraft: { ...baseItem.listingDraft, title: "用户修改标题" } },
    accountId,
    collectItemId: collectId,
    targetStoreId: storeId,
    idempotencyKey: `prepare-${suffix}`,
    normalizedItems: [{ ...normalizedItems[0], name: "用户修改标题" }],
    stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.id, created.job.id);
  assert.equal(duplicate.job.storeId, storeId);
  const frozenRows = await pool.query(
    `SELECT s.store_id AS snapshot_store_id,j.store_id AS job_store_id
     FROM submission_snapshots s JOIN submission_jobs j ON j.snapshot_id=s.id
     WHERE s.id=$1`,
    [created.job.snapshotId],
  );
  assert.deepEqual(frozenRows.rows[0], {
    snapshot_store_id: storeId,
    job_store_id: storeId,
  });
  await assert.rejects(
    prepareCollectItemForListing({
      collectItem: baseItem,
      accountId,
      collectItemId: collectId,
      targetStoreId: secondStoreId,
      idempotencyKey: `prepare-${suffix}`,
      normalizedItems: [{ ...normalizedItems[0], name: "用户修改标题" }],
      stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
    }),
    (error) => error?.status === 409 && error?.code === "LISTING_TARGET_STORE_CONFLICT",
  );

  await assert.rejects(
    assertUsableOperatingStore({ accountId, storeId: foreignStoreId }),
    (error) => {
      assert.equal(error?.status, 404);
      assert.equal(error?.code, "TARGET_STORE_NOT_FOUND");
      assert.doesNotMatch(error?.message || "", /Foreign Secret Store|client-foreign/);
      return true;
    },
  );
  await assert.rejects(
    assertUsableOperatingStore({ accountId, storeId: disabledStoreId }),
    (error) => error?.status === 409 && error?.code === "TARGET_STORE_DISABLED",
  );
  await assert.rejects(
    assertUsableOperatingStore({ accountId, storeId: noCredentialStoreId }),
    (error) => error?.status === 409 && error?.code === "TARGET_STORE_CREDENTIALS_REQUIRED",
  );

  const audit = await pool.query(
    "SELECT metadata FROM audit_events WHERE entity_id=$1 AND action='LISTING_SUBMIT'",
    [created.job.id],
  );
  assert.deepEqual(audit.rows[0].metadata.targetStore, {
    id: storeId,
    label: "Pipeline Test Store",
    clientId: `client-${suffix}`,
    currencyCode: "RUB",
    validatedAt: audit.rows[0].metadata.targetStore.validatedAt,
  });
  assert.doesNotMatch(
    JSON.stringify(audit.rows[0].metadata),
    /secret-|encrypted_api_key|apiKey|authTag|credential/i,
  );

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

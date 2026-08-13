import "../env.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { encryptSecret } from "../crypto-secrets.mjs";
import { deriveOzonImportStatus } from "../ozon-import-status.mjs";
import { getPostgresPool, closePostgresPool, postgresEnabled } from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import {
  assertListingStocksBelongToTarget,
  assertUsableOperatingStore,
  createSubmissionV3,
  getSubmissionJobDetailV3,
  getSubmissionJobV3,
  listCollectItemsV3,
  loadSubmissionWorkV3,
  mirrorCollectItemV3,
  prepareCollectItemForListing,
  projectSubmissionItemPublicResultV3,
  softDeleteCollectItemsForAccountV4,
  updateSubmissionItemsV3,
} from "../listing-pipeline.mjs";

const safeProjection = projectSubmissionItemPublicResultV3({
  sku: "safe-sku",
  offer_id: "safe-offer",
  status: "FAILED",
  product_id: "",
  error_code: "UNKNOWN",
  error_message: "raw-third-party-secret",
  response: {
    schemaVersion: "OZON_SUBMISSION_ITEM_RESPONSE_V1",
    rawResponse: { message: "raw-third-party-secret", credential: "secret" },
    errorEvidence: null,
  },
});
assert.deepEqual(safeProjection, {
  sku: "safe-sku",
  offer_id: "safe-offer",
  status: "FAILED",
  product_id: "",
  errors: [{ code: "OZON_ITEM_RESULT", message: "Ozon 返回商品导入失败" }],
  errorEvidence: null,
});
assert.doesNotMatch(JSON.stringify(safeProjection), /raw-third-party-secret|credential/iu);

function persistSubmissionItems(jobId, items, scope) {
  return updateSubmissionItemsV3({ ...scope, jobId, items });
}

function normalizedImportItems(rawItems) {
  const expectedOfferIds = rawItems.map((item) => item.offer_id);
  const result = deriveOzonImportStatus({ result: { items: rawItems } }, { expectedOfferIds });
  assert.equal(result.items.length, rawItems.length);
  return result.items;
}

if (!postgresEnabled()) {
  console.log("listing pipeline v3 integration skipped: PostgreSQL is not configured");
  process.exit(0);
}

const suffix = crypto.randomUUID();
const routeStateTable = `listing_route_${suffix.replaceAll("-", "_")}`;
const accountId = `test_account_${suffix}`;
const foreignAccountId = `test_foreign_account_${suffix}`;
const storeId = `test_store_${suffix}`;
const secondStoreId = `test_store_second_${suffix}`;
const foreignStoreId = `test_store_foreign_${suffix}`;
const disabledStoreId = `test_store_disabled_${suffix}`;
const noCredentialStoreId = `test_store_no_credential_${suffix}`;
const collectId = `test_collect_${suffix}`;
const changedPayloadCollectId = `test_collect_changed_payload_${suffix}`;
const raceCollectId = `test_collect_race_${suffix}`;
const autoListingCollectId = `test_collect_auto_listing_${suffix}`;
const foreignScopeSnapshotId = `test_foreign_scope_snapshot_${suffix}`;
const foreignScopeJobId = `test_foreign_scope_job_${suffix}`;
const foreignScopeItemId = `test_foreign_scope_item_${suffix}`;
const collectIds = [collectId, changedPayloadCollectId, raceCollectId, autoListingCollectId];
const warehouseAId = `wh_${crypto.createHash("sha256").update(`${storeId}|1`).digest("hex").slice(0, 24)}`;
const warehouseBId = `wh_${crypto.createHash("sha256").update(`${secondStoreId}|2`).digest("hex").slice(0, 24)}`;
const warehouseFboId = `wh_${crypto.createHash("sha256").update(`${storeId}|3`).digest("hex").slice(0, 24)}`;
const warehouseArchivedOnlyId = `wh_${crypto.createHash("sha256").update(`${storeId}|4`).digest("hex").slice(0, 24)}`;
const storeIds = [storeId, secondStoreId, foreignStoreId, disabledStoreId, noCredentialStoreId];
const pool = await getPostgresPool();
let routeDataDir = "";

async function requestJson(handle, pathname, body, token) {
  const payload = JSON.stringify(body || {});
  const req = Readable.from([Buffer.from(payload)]);
  req.method = "POST";
  req.url = pathname;
  req.headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  const res = {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(text = "") { this.body = String(text || ""); },
  };
  await handle(req, res);
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

async function cleanup() {
  await pool.query("DELETE FROM submission_jobs WHERE id=$1", [foreignScopeJobId]);
  await pool.query("DELETE FROM submission_snapshots WHERE id=$1", [foreignScopeSnapshotId]);
  const jobs = await pool.query("SELECT id, snapshot_id FROM submission_jobs WHERE collect_item_id=ANY($1::text[])", [collectIds]);
  const jobIds = jobs.rows.map((row) => row.id);
  const snapshotIds = jobs.rows.map((row) => row.snapshot_id);
  if (jobIds.length) {
    await pool.query("DELETE FROM outbox_events WHERE aggregate_id=ANY($1::text[])", [jobIds]);
    await pool.query("DELETE FROM audit_events WHERE entity_id=ANY($1::text[])", [jobIds]);
    await pool.query("DELETE FROM submission_jobs WHERE id=ANY($1::text[])", [jobIds]);
  }
  if (snapshotIds.length) await pool.query("DELETE FROM submission_snapshots WHERE id=ANY($1::text[])", [snapshotIds]);
  await pool.query("DELETE FROM collect_items WHERE id=ANY($1::text[])", [collectIds]);
  await pool.query("DELETE FROM collect_raw_payloads WHERE collect_item_id=ANY($1::text[])", [collectIds]);
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
    `INSERT INTO stores (
       id,owner_account_id,label,client_id,status,is_current,currency_code,currency_source,currency_synced_at
     ) VALUES ($1,$2,$3,$4,'active',TRUE,'RUB','OZON_SELLER_INFO','2026-08-13T00:00:00.000Z')`,
    [storeId, accountId, "Pipeline Test Store", `client-${suffix}`],
  );
  await pool.query(
    `INSERT INTO stores (
       id,owner_account_id,label,client_id,status,is_current,currency_code,currency_source,currency_synced_at
     )
     VALUES
       ($1,$5,'Pipeline Second Store',$6,'active',FALSE,'RUB','OZON_SELLER_INFO','2026-08-13T00:00:00.000Z'),
       ($2,$7,'Foreign Secret Store',$8,'active',FALSE,'RUB','OZON_SELLER_INFO','2026-08-13T00:00:00.000Z'),
       ($3,$5,'Pipeline Disabled Store',$9,'disabled',FALSE,'RUB','OZON_SELLER_INFO','2026-08-13T00:00:00.000Z'),
       ($4,$5,'Pipeline No Credential Store',$10,'active',FALSE,'RUB','OZON_SELLER_INFO','2026-08-13T00:00:00.000Z')`,
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
  await pool.query(
    `INSERT INTO warehouses (id,store_id,warehouse_id,name,warehouse_type,status,is_active,is_archived)
     VALUES
       ($1,$5,'1','Store A FBS','FBS','active',TRUE,FALSE),
       ($2,$6,'2','Store B FBS','FBS','active',TRUE,FALSE),
       ($3,$5,'3','Store A FBO','FBO','active',TRUE,FALSE),
       ($4,$5,'4','Store A Archived Only FBS','FBS','active',TRUE,FALSE)`,
    [warehouseAId, warehouseBId, warehouseFboId, warehouseArchivedOnlyId, storeId, secondStoreId],
  );
  await pool.query(
    `INSERT INTO products (id,store_id,product_id,sku,status,is_archived)
     VALUES
       ($1,$4,'active-fbs-product','active-fbs-sku','active',FALSE),
       ($2,$5,'second-fbs-product','second-fbs-sku','active',FALSE),
       ($3,$4,'archived-fbs-product','archived-fbs-sku','archived',TRUE)`,
    [`product_active_${suffix}`, `product_second_${suffix}`, `product_archived_${suffix}`, storeId, secondStoreId],
  );
  await pool.query(
    `INSERT INTO product_stocks (product_id,warehouse_id,store_id,sku,source,present,reserved)
     VALUES
       ($1,$4,$6,'active-fbs-sku','fbs',0,0),
       ($2,$5,$7,'second-fbs-sku','fbs',5,0),
       ($3,$8,$6,'archived-fbs-sku','fbs',5,0)`,
    [
      `product_active_${suffix}`,
      `product_second_${suffix}`,
      `product_archived_${suffix}`,
      warehouseAId,
      warehouseBId,
      storeId,
      secondStoreId,
      warehouseArchivedOnlyId,
    ],
  );

  assert.equal(await assertListingStocksBelongToTarget({
    accountId,
    storeId,
    stocks: [{ warehouse_id: 1, stock: 0 }],
  }), true);
  for (const { warehouseId, reason } of [
    { warehouseId: 3, reason: "UNSUPPORTED_FULFILLMENT_TYPE" },
    { warehouseId: 4, reason: "NO_ACTIVE_PRODUCT_ASSOCIATION" },
    { warehouseId: 2, reason: "STORE_SCOPE_MISMATCH" },
    { warehouseId: warehouseAId, reason: "STORE_SCOPE_MISMATCH" },
  ]) {
    await assert.rejects(
      assertListingStocksBelongToTarget({
        accountId,
        storeId,
        stocks: [{ warehouse_id: warehouseId, stock: 5 }],
      }),
      (error) => error?.status === 422
        && error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE"
        && error?.body?.reason === reason,
    );
  }

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
      descriptionCategoryId: 1,
      logistics: { weightG: 100, lengthMm: 100, widthMm: 100, heightMm: 100 },
      variants: [{ sku: "source-sku-1", offerId: "offer-1", price: "100.00" }],
    },
    collectedAt: new Date().toISOString(),
  };
  const changedPayloadItem = {
    ...baseItem,
    id: changedPayloadCollectId,
    sku: "source-sku-changed-payload",
    status: "已上架",
    listingTaskId: "existing-payload-task",
    listingJobId: "existing-payload-job",
    listingDraft: {
      ...baseItem.listingDraft,
      sku: "source-sku-changed-payload",
      title: "Changed payload item",
      variants: [{ sku: "source-sku-changed-payload", offerId: "offer-changed-payload", price: "100.00" }],
    },
  };

  const first = await mirrorCollectItemV3(baseItem, { accountId, storeId, captureRaw: true });
  assert.equal(first.version, 1);
  await mirrorCollectItemV3(changedPayloadItem, { accountId, storeId, captureRaw: true });
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
    weight: 100,
    depth: 100,
    width: 100,
    height: 100,
    attributes: [],
  }];
  const autoListingItem = {
    ...baseItem,
    id: autoListingCollectId,
    sku: "source-sku-auto",
    listingDraft: {
      ...baseItem.listingDraft,
      sku: "source-sku-auto",
      title: "Frozen source title",
      sourceCategory: { descriptionCategoryId: 1 },
      variants: [{ sku: "source-sku-auto", offerId: "offer-auto", price: "100.00" }],
    },
  };
  const frozenAutoDraft = await mirrorCollectItemV3(autoListingItem, {
    accountId, storeId, captureRaw: true,
  });
  const autoSubmission = await createSubmissionV3({
    collectItem: { ...autoListingItem, listingDraft: { title: "stale caller draft must never mirror" } },
    accountId,
    targetStoreId: storeId,
    idempotencyKey: `auto-listing-${suffix}`,
    normalizedItems: [{ ...normalizedItems[0], offer_id: "offer-auto", name: "AI overlay title" }],
    stocks: [{ offer_id: "offer-auto", warehouse_id: 1, stock: 5 }],
    type: "AUTO_LISTING",
    frozenProductDraft: {
      id: frozenAutoDraft.draftId,
      version: frozenAutoDraft.version,
      dataHash: frozenAutoDraft.dataHash,
    },
  });
  assert.equal(autoSubmission.duplicate, false);
  const autoFbsWork = await loadSubmissionWorkV3(autoSubmission.job.id);
  assert.equal(autoFbsWork.rfbs_authorization_required, false);
  for (const field of ["rfbs_handoff_id", "rfbs_account_id", "rfbs_store_id",
    "rfbs_local_warehouse_id", "rfbs_platform_warehouse_id", "rfbs_fulfillment_type",
    "rfbs_link_identity_evidence_id", "rfbs_attempt_authorization_evidence_id",
    "rfbs_reserved_attempt_id", "rfbs_submission_link_id",
    "rfbs_business_idempotency_key"]) assert.equal(autoFbsWork[field], null);
  assert.equal(autoFbsWork.rfbs_handoff_materialization_required, false);
  assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count FROM submission_rfbs_handoffs
    WHERE submission_job_id=$1`, [autoSubmission.job.id])).rows[0].count), 0);
  const frozenAfterSubmission = await pool.query(
    `SELECT d.version,d.data_hash,d.data,s.items
       FROM product_drafts d
       JOIN submission_snapshots s ON s.id=$2
      WHERE d.id=$1`,
    [frozenAutoDraft.draftId, autoSubmission.job.snapshotId],
  );
  assert.equal(Number(frozenAfterSubmission.rows[0].version), frozenAutoDraft.version);
  assert.equal(frozenAfterSubmission.rows[0].data_hash, frozenAutoDraft.dataHash);
  assert.equal(frozenAfterSubmission.rows[0].data.title, "Frozen source title");
  assert.equal(frozenAfterSubmission.rows[0].items[0].name, "AI overlay title");
  await assert.rejects(createSubmissionV3({
    collectItem: autoListingItem, accountId, targetStoreId: storeId,
    idempotencyKey: `auto-listing-stale-${suffix}`,
    normalizedItems: [{ ...normalizedItems[0], offer_id: "offer-auto", name: "AI overlay title" }],
    stocks: [{ offer_id: "offer-auto", warehouse_id: 1, stock: 5 }], type: "AUTO_LISTING",
    frozenProductDraft: { id: frozenAutoDraft.draftId, version: frozenAutoDraft.version + 1,
      dataHash: frozenAutoDraft.dataHash },
  }), { code: "AUTO_LISTING_SOURCE_DRAFT_CHANGED", definitelyNotSubmitted: true });
  const beforeIncomplete = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM submission_snapshots WHERE collect_item_id=$1) AS snapshot_count,
       (SELECT COUNT(*)::int FROM submission_jobs WHERE collect_item_id=$1) AS job_count,
       (SELECT COUNT(*)::int FROM outbox_events WHERE aggregate_id IN (
         SELECT id FROM submission_jobs WHERE collect_item_id=$1
       )) AS outbox_count`,
    [collectId],
  );
  await assert.rejects(
    prepareCollectItemForListing({
      collectItem: {
        ...baseItem,
        listingDraft: {
          ...baseItem.listingDraft,
          descriptionCategoryId: 1,
          logistics: {},
          enrichment: { status: "COMPLETE", missingFields: [] },
        },
      },
      accountId,
      collectItemId: collectId,
      targetStoreId: storeId,
      idempotencyKey: `incomplete-${suffix}`,
      normalizedItems: [{
        ...normalizedItems[0],
        weight: 0,
        depth: 0,
        width: 0,
        height: 0,
      }],
      stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
    }),
    (error) => error?.status === 422
      && error?.code === "COLLECT_ENRICHMENT_INCOMPLETE"
      && assert.deepEqual(error.missingFields, ["weightG", "lengthMm", "widthMm", "heightMm"]) === undefined,
  );
  const afterIncomplete = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM submission_snapshots WHERE collect_item_id=$1) AS snapshot_count,
       (SELECT COUNT(*)::int FROM submission_jobs WHERE collect_item_id=$1) AS job_count,
       (SELECT COUNT(*)::int FROM outbox_events WHERE aggregate_id IN (
         SELECT id FROM submission_jobs WHERE collect_item_id=$1
       )) AS outbox_count`,
    [collectId],
  );
  assert.deepEqual(afterIncomplete.rows[0], beforeIncomplete.rows[0]);
  const created = await prepareCollectItemForListing({
    collectItem: {
      ...baseItem,
      listingDraft: {
        ...baseItem.listingDraft,
        title: "用户修改标题",
        descriptionCategoryId: 1,
        logistics: { weightG: 100, lengthMm: 100, widthMm: 100, heightMm: 100 },
      },
    },
    accountId,
    collectItemId: collectId,
    targetStoreId: storeId,
    idempotencyKey: `prepare-${suffix}`,
    normalizedItems,
    stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
  });
  assert.equal(created.duplicate, false);
  const createdOzonTaskId = `ozon-task-created-${suffix}`;
  const autoOzonTaskId = `ozon-task-auto-${suffix}`;
  await pool.query("UPDATE submission_jobs SET ozon_task_id=$2 WHERE id=$1", [created.job.id, createdOzonTaskId]);
  await pool.query("UPDATE submission_jobs SET ozon_task_id=$2 WHERE id=$1", [autoSubmission.job.id, autoOzonTaskId]);
  normalizedItems[0].name = "外部对象被修改";
  const snapshot = await pool.query(
    "SELECT items,store_id,idempotency_key FROM submission_snapshots WHERE id=$1",
    [created.job.snapshotId],
  );
  assert.equal(snapshot.rows[0].items[0].name, "用户修改标题");
  assert.equal(snapshot.rows[0].store_id, storeId);

  const createdScope = {
    accountId,
    snapshotId: created.job.snapshotId,
    ozonTaskId: createdOzonTaskId,
    statusVersion: 1,
  };
  await pool.query(`INSERT INTO submission_snapshots
    (id,account_id,store_id,idempotency_key,snapshot_hash,item_count,items,stocks)
    VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,'[]'::jsonb)`,
  [foreignScopeSnapshotId, foreignAccountId, foreignStoreId, `foreign-scope-${suffix}`,
    "f".repeat(64), JSON.stringify([{ offer_id: "offer-1", name: "Foreign same offer" }])]);
  await pool.query(`INSERT INTO submission_jobs
    (id,snapshot_id,account_id,store_id,type,status,ozon_task_id,correlation_id,item_count)
    VALUES ($1,$2,$3,$4,'COLLECT_BOX_DRAFT','CHECKING',$5,$6,1)`,
  [foreignScopeJobId, foreignScopeSnapshotId, foreignAccountId, foreignStoreId,
    createdOzonTaskId, `foreign-scope-${suffix}`]);
  await pool.query(`INSERT INTO submission_items
    (id,job_id,snapshot_id,variant_key,sort_order,sku,offer_id,status,product_id)
    VALUES ($1,$2,$3,'offer-1',0,'foreign-source','offer-1','PENDING','')`,
  [foreignScopeItemId, foreignScopeJobId, foreignScopeSnapshotId]);
  const crossAccountFailureItems = normalizedImportItems([{
    offer_id: "offer-1", sku: "foreign-source", product_id: 0, status: "failed",
    errors: [{ code: "UNKNOWN", field: "unknown", message: "cross-account-same-identity-secret" }],
  }]);
  await assert.rejects(persistSubmissionItems(
    foreignScopeJobId, crossAccountFailureItems, createdScope,
  ), (error) => error?.code === "OZON_IMPORT_RESULT_SCOPE_MISMATCH"
    && !/cross-account-same-identity-secret/iu.test(error.message));
  assert.deepEqual((await pool.query(
    "SELECT status,product_id FROM submission_items WHERE id=$1", [foreignScopeItemId],
  )).rows[0], { status: "PENDING", product_id: "" });
  assert.equal(Number((await pool.query(
    "SELECT COUNT(*)::int AS count FROM submission_events WHERE job_id=$1", [foreignScopeJobId],
  )).rows[0].count), 0);
  const beforeForeignScope = await pool.query(
    `SELECT
       (SELECT status FROM submission_items WHERE job_id=$1 AND offer_id='offer-1') AS item_status,
       (SELECT COUNT(*)::int FROM submission_events WHERE job_id=$1) AS event_count`,
    [created.job.id],
  );
  await assert.rejects(updateSubmissionItemsV3(created.job.id, [{
    offerId: "offer-1", status: "FAILED", productId: "",
    response: { message: "legacy-signature-secret" }, errorEvidence: null,
  }]), (error) => error?.code === "OZON_IMPORT_RESULT_SCOPE_MISMATCH"
    && !/legacy-signature-secret/iu.test(error.message));
  const wrongOfferItems = normalizedImportItems([{
    offer_id: "wrong-offer", sku: "source-sku", product_id: 0, status: "failed",
    credential: "secret",
    errors: [{ code: "UNKNOWN", field: "unknown", message: "raw-third-party-secret" }],
  }]);
  await assert.rejects(persistSubmissionItems(
    created.job.id, wrongOfferItems, createdScope,
  ), (error) => error?.code === "OZON_IMPORT_OFFER_IDENTITY_MISMATCH"
    && error?.retryable === false && error?.cause === null
    && !/raw-third-party-secret|credential/iu.test(error.message));
  let persistedImportResult = await pool.query(
    "SELECT status,response FROM submission_items WHERE job_id=$1 AND offer_id='offer-1'",
    [created.job.id],
  );
  assert.equal(persistedImportResult.rows[0].status, "PENDING");
  await assert.rejects(persistSubmissionItems(created.job.id, crossAccountFailureItems,
    { ...createdScope, accountId: foreignAccountId }),
  (error) => error?.code === "OZON_IMPORT_RESULT_SCOPE_MISMATCH"
    && !/foreign-scope-secret/iu.test(error.message));
  await assert.rejects(persistSubmissionItems(created.job.id, crossAccountFailureItems,
    { ...createdScope, ozonTaskId: `wrong-${createdOzonTaskId}` }),
  (error) => error?.code === "OZON_IMPORT_RESULT_SCOPE_MISMATCH"
    && !/wrong-task-secret/iu.test(error.message));
  await assert.rejects(persistSubmissionItems(created.job.id, crossAccountFailureItems,
    { ...createdScope, snapshotId: foreignScopeSnapshotId }),
  (error) => error?.code === "OZON_IMPORT_RESULT_SCOPE_MISMATCH"
    && !/wrong-snapshot-secret/iu.test(error.message));
  const afterForeignScope = await pool.query(
    `SELECT
       (SELECT status FROM submission_items WHERE job_id=$1 AND offer_id='offer-1') AS item_status,
       (SELECT COUNT(*)::int FROM submission_events WHERE job_id=$1) AS event_count`,
    [created.job.id],
  );
  assert.deepEqual(afterForeignScope.rows[0], beforeForeignScope.rows[0]);

  const persistedFailureItems = normalizedImportItems([{
    offer_id: "offer-1", sku: "source-sku", product_id: 0, status: "failed",
    message: "raw-third-party-secret", credential: "secret",
    errors: [{ code: "UNKNOWN", field: "unknown", message: "raw-third-party-secret" }],
  }]);
  await persistSubmissionItems(created.job.id, persistedFailureItems, createdScope);
  persistedImportResult = await pool.query(
    "SELECT status,response FROM submission_items WHERE job_id=$1 AND offer_id='offer-1'",
    [created.job.id],
  );
  assert.equal(persistedImportResult.rows[0].status, "FAILED");
  assert.equal(persistedImportResult.rows[0].response.schemaVersion, "OZON_SUBMISSION_ITEM_RESPONSE_V1");
  assert.equal(persistedImportResult.rows[0].response.rawResponse.message, "raw-third-party-secret");
  assert.equal(persistedImportResult.rows[0].response.errorEvidence, null);
  const beforeReplayEvents = Number((await pool.query(
    "SELECT COUNT(*)::int AS count FROM submission_events WHERE job_id=$1", [created.job.id],
  )).rows[0].count);
  await persistSubmissionItems(created.job.id, normalizedImportItems([{
    offer_id: "offer-1", sku: "source-sku", product_id: 0, status: "failed",
    errors: [{ code: "UNKNOWN", field: "unknown", message: "idempotent-backend-replay" }],
  }]), createdScope);
  const afterReplayEvents = Number((await pool.query(
    "SELECT COUNT(*)::int AS count FROM submission_events WHERE job_id=$1", [created.job.id],
  )).rows[0].count);
  assert.equal(afterReplayEvents, beforeReplayEvents);
  await assert.rejects(persistSubmissionItems(created.job.id, normalizedImportItems([{
    offer_id: "offer-1", sku: "source-sku", product_id: 0, status: "processing",
    message: "stale-checking-secret", errors: [],
  }]), createdScope), (error) => error?.code === "OZON_IMPORT_RESULT_CONFLICT"
    && error?.retryable === false && error?.cause === null
    && !/stale-checking-secret/iu.test(error.message));
  persistedImportResult = await pool.query(
    "SELECT status,product_id,response FROM submission_items WHERE job_id=$1 AND offer_id='offer-1'",
    [created.job.id],
  );
  assert.equal(persistedImportResult.rows[0].status, "FAILED");

  const successfulAutoItems = normalizedImportItems([{
    offer_id: "offer-auto", sku: "source-auto", product_id: 991001, status: "imported", errors: [],
  }]);
  await persistSubmissionItems(autoSubmission.job.id, successfulAutoItems,
    { accountId, snapshotId: autoSubmission.job.snapshotId, ozonTaskId: autoOzonTaskId, statusVersion: 1 });
  await persistSubmissionItems(autoSubmission.job.id, successfulAutoItems,
    { accountId, snapshotId: autoSubmission.job.snapshotId, ozonTaskId: autoOzonTaskId, statusVersion: 1 });
  for (const conflict of [
    { offer_id: "offer-auto", product_id: 0, status: "processing", errors: [], message: "terminal-conflict-secret" },
    { offer_id: "offer-auto", product_id: 0, status: "failed", errors: [{ code: "UNKNOWN", field: "unknown" }], message: "terminal-conflict-secret" },
    { offer_id: "offer-auto", product_id: 991002, status: "imported", errors: [], message: "terminal-conflict-secret" },
  ]) {
    await assert.rejects(persistSubmissionItems(autoSubmission.job.id,
      normalizedImportItems([conflict]),
      { accountId, snapshotId: autoSubmission.job.snapshotId, ozonTaskId: autoOzonTaskId, statusVersion: 1 }),
    (error) => error?.code === "OZON_IMPORT_RESULT_CONFLICT"
      && !/terminal-conflict-secret/iu.test(error.message));
  }
  const immutableSuccess = await pool.query(
    "SELECT status,product_id FROM submission_items WHERE job_id=$1", [autoSubmission.job.id],
  );
  assert.deepEqual(immutableSuccess.rows[0], { status: "SUCCEEDED", product_id: "991001" });

  const invalidSuccessSubmission = await createSubmissionV3({
    collectItem: baseItem,
    accountId,
    storeId,
    normalizedItems: [
      { ...normalizedItems[0], offer_id: "offer-invalid-a", name: "Invalid A" },
      { ...normalizedItems[0], offer_id: "offer-invalid-b", name: "Invalid B" },
    ],
    stocks: [
      { offer_id: "offer-invalid-a", warehouse_id: 1, stock: 1 },
      { offer_id: "offer-invalid-b", warehouse_id: 1, stock: 1 },
    ],
  });
  const invalidSuccessTaskId = `ozon-task-invalid-success-${suffix}`;
  await pool.query("UPDATE submission_jobs SET ozon_task_id=$2 WHERE id=$1", [
    invalidSuccessSubmission.job.id, invalidSuccessTaskId,
  ]);
  const invalidSuccessScope = {
    accountId,
    snapshotId: invalidSuccessSubmission.job.snapshotId,
    ozonTaskId: invalidSuccessTaskId,
    statusVersion: 1,
  };
  const validClosedItems = normalizedImportItems([
    {
      offer_id: "offer-invalid-a", sku: "source-invalid-a", product_id: 0,
      status: "failed", errors: [{ code: "UNKNOWN", field: "unknown" }],
    },
    { offer_id: "offer-invalid-b", sku: "source-invalid-b", product_id: 0, status: "processing", errors: [] },
  ]);
  const malformedClosedItems = [];
  for (const key of [
    "index", "sku", "offerId", "productId", "status", "errors", "classification", "errorEvidence", "response",
  ]) {
    const missing = { ...validClosedItems[0] };
    delete missing[key];
    malformedClosedItems.push([missing, validClosedItems[1]]);
    malformedClosedItems.push([{ ...validClosedItems[0], [key]: undefined }, validClosedItems[1]]);
  }
  malformedClosedItems.push(
    [{ ...validClosedItems[0], unexpected: true }, validClosedItems[1]],
    [{ ...validClosedItems[0], index: -1 }, validClosedItems[1]],
    [{ ...validClosedItems[0], index: 1.5 }, validClosedItems[1]],
    [{ ...validClosedItems[0], sku: 1 }, validClosedItems[1]],
    [{ ...validClosedItems[0], sku: "s".repeat(241) }, validClosedItems[1]],
    [{ ...validClosedItems[0], offerId: "offer-invalid-b" }, validClosedItems[1]],
    [{ ...validClosedItems[0], classification: "SUCCEEDED" }, validClosedItems[1]],
    [{ ...validClosedItems[0], status: "CHECKING" }, validClosedItems[1]],
    [{ ...validClosedItems[0], errors: [] }, validClosedItems[1]],
    [{ ...validClosedItems[0], errorEvidence: { credential: "contract-secret" } }, validClosedItems[1]],
    [{ ...validClosedItems[0], response: {} }, validClosedItems[1]],
    [{ ...validClosedItems[0], response: {
      offer_id: "offer-invalid-a", sku: "source-invalid-a", product_id: 991,
      status: "imported", errors: [],
    } }, validClosedItems[1]],
    [{ ...validClosedItems[0], response: {
      ...validClosedItems[0].response, offer_id: "response-other-offer",
    } }, validClosedItems[1]],
    [{ ...validClosedItems[1], productId: null }, validClosedItems[0]],
  );
  const accessorItem = { ...validClosedItems[0] };
  Object.defineProperty(accessorItem, "response", {
    enumerable: true,
    get() { throw new Error("contract-accessor-secret"); },
  });
  const cyclicResponse = { ...validClosedItems[0].response };
  cyclicResponse.self = cyclicResponse;
  const revoked = Proxy.revocable({ ...validClosedItems[0] }, {});
  revoked.revoke();
  malformedClosedItems.push(
    [accessorItem, validClosedItems[1]],
    [new Proxy({ ...validClosedItems[0] }, {}), validClosedItems[1]],
    [revoked.proxy, validClosedItems[1]],
    [{ ...validClosedItems[0], response: cyclicResponse }, validClosedItems[1]],
    [{ ...validClosedItems[0], response: { ...validClosedItems[0].response, note: "x".repeat(2_000_001) } }, validClosedItems[1]],
  );
  const originalPoolConnect = pool.connect;
  const originalPoolQuery = pool.query;
  let malformedDatabaseCalls = 0;
  pool.connect = function countedConnect(...args) {
    malformedDatabaseCalls += 1;
    return originalPoolConnect.apply(this, args);
  };
  pool.query = function countedQuery(...args) {
    malformedDatabaseCalls += 1;
    return originalPoolQuery.apply(this, args);
  };
  try {
    for (const items of malformedClosedItems) {
      await assert.rejects(
        persistSubmissionItems(invalidSuccessSubmission.job.id, items, invalidSuccessScope),
        (error) => error?.code === "OZON_IMPORT_RESULT_CONTRACT_INVALID"
          && error?.retryable === false && error?.cause === null
          && !/contract-(?:secret|accessor)/iu.test(error.message),
      );
    }
  } finally {
    pool.connect = originalPoolConnect;
    pool.query = originalPoolQuery;
  }
  assert.equal(malformedDatabaseCalls, 0);
  const invalidBefore = await pool.query(
    `SELECT
       (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('offer',offer_id,'status',status,'product',product_id) ORDER BY offer_id)
        FROM submission_items WHERE job_id=$1) AS items,
       (SELECT COUNT(*)::int FROM submission_events WHERE job_id=$1) AS events`,
    [invalidSuccessSubmission.job.id],
  );
  const invalidRepositoryProductIds = [
    0, -1, 1.5, Number.NaN, undefined, "", " ", "0", "01",
    Number.MAX_SAFE_INTEGER + 1, String(Number.MAX_SAFE_INTEGER + 1), {}, [], null,
  ];
  const validSuccessForTampering = normalizedImportItems([
    { offer_id: "offer-invalid-a", sku: "source-invalid-a", product_id: 123, status: "imported", errors: [] },
    { offer_id: "offer-invalid-b", sku: "source-invalid-b", product_id: 0, status: "processing", errors: [] },
  ]);
  for (const productId of invalidRepositoryProductIds) {
    const invalidItem = {
      ...validSuccessForTampering[0], productId,
    };
    if (productId === undefined) delete invalidItem.productId;
    await assert.rejects(persistSubmissionItems(invalidSuccessSubmission.job.id, [
      invalidItem,
      validSuccessForTampering[1],
    ], invalidSuccessScope), (error) => error?.code === "OZON_IMPORT_RESULT_CONTRACT_INVALID"
      && error?.retryable === false && error?.cause === null);
  }
  for (const status of ["CHECKING", "FAILED", "SKIPPED", "UNKNOWN_RESULT"]) {
    await assert.rejects(persistSubmissionItems(invalidSuccessSubmission.job.id, [
      { ...validClosedItems[0], status, productId: "123" },
      validClosedItems[1],
    ], invalidSuccessScope), { code: "OZON_IMPORT_RESULT_CONTRACT_INVALID", retryable: false, cause: null });
  }
  await assert.rejects(persistSubmissionItems(invalidSuccessSubmission.job.id, [
    { ...validSuccessForTampering[0], unexpected: true },
    validSuccessForTampering[1],
  ], invalidSuccessScope), { code: "OZON_IMPORT_RESULT_CONTRACT_INVALID", retryable: false, cause: null });
  const mixedInvalidSuccess = deriveOzonImportStatus({ result: { items: [
    { offer_id: "offer-invalid-a", status: "imported", product_id: 0 },
    { offer_id: "offer-invalid-b", status: "imported", product_id: 123456 },
  ] } }, { expectedOfferIds: ["offer-invalid-a", "offer-invalid-b"] });
  assert.equal(mixedInvalidSuccess.status, "UNKNOWN_RESULT");
  const ignoredInvalidSuccess = await persistSubmissionItems(
    invalidSuccessSubmission.job.id, mixedInvalidSuccess.items, invalidSuccessScope,
  );
  assert.deepEqual(ignoredInvalidSuccess, { applied: false, ignored: true, idempotent: false });
  const invalidAfter = await pool.query(
    `SELECT
       (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('offer',offer_id,'status',status,'product',product_id) ORDER BY offer_id)
        FROM submission_items WHERE job_id=$1) AS items,
       (SELECT COUNT(*)::int FROM submission_events WHERE job_id=$1) AS events`,
    [invalidSuccessSubmission.job.id],
  );
  assert.deepEqual(invalidAfter.rows[0], invalidBefore.rows[0]);

  const batchSubmission = await createSubmissionV3({
    collectItem: baseItem,
    accountId,
    storeId,
    normalizedItems: [
      { ...normalizedItems[0], offer_id: "offer-batch-a", name: "Batch A" },
      { ...normalizedItems[0], offer_id: "offer-batch-b", name: "Batch B" },
    ],
    stocks: [
      { offer_id: "offer-batch-a", warehouse_id: 1, stock: 1 },
      { offer_id: "offer-batch-b", warehouse_id: 1, stock: 1 },
    ],
  });
  const batchOzonTaskId = `ozon-task-batch-${suffix}`;
  await pool.query("UPDATE submission_jobs SET ozon_task_id=$2 WHERE id=$1", [batchSubmission.job.id, batchOzonTaskId]);
  const batchScope = {
    accountId,
    snapshotId: batchSubmission.job.snapshotId,
    ozonTaskId: batchOzonTaskId,
    statusVersion: 1,
  };
  const mixedBatchItems = normalizedImportItems([
    { offer_id: "offer-batch-a", sku: "source-batch-a", product_id: 0, status: "processing", errors: [] },
    { offer_id: "offer-batch-b", sku: "source-batch-b", product_id: 991101, status: "imported", errors: [] },
  ]);
  await persistSubmissionItems(batchSubmission.job.id, mixedBatchItems, batchScope);
  const exactMixedReplay = await persistSubmissionItems(batchSubmission.job.id, mixedBatchItems, batchScope);
  assert.deepEqual(exactMixedReplay, { applied: false, ignored: false, idempotent: true });
  const ignoredUnknown = await persistSubmissionItems(batchSubmission.job.id, normalizedImportItems([
    { offer_id: "offer-batch-a", sku: "source-batch-a", product_id: 0, status: "unexpected", errors: [] },
    { offer_id: "offer-batch-b", sku: "source-batch-b", product_id: 991101, status: "imported", errors: [] },
  ]), batchScope);
  assert.deepEqual(ignoredUnknown, { applied: false, ignored: true, idempotent: false });
  await assert.rejects(persistSubmissionItems(batchSubmission.job.id, normalizedImportItems([
    { offer_id: "offer-batch-a", sku: "source-batch-a", product_id: 991102, status: "imported", errors: [] },
    { offer_id: "offer-batch-b", sku: "source-batch-b", product_id: 0, status: "failed", errors: [{ code: "UNKNOWN", field: "unknown" }] },
  ]), batchScope), { code: "OZON_IMPORT_RESULT_CONFLICT", retryable: false, cause: null });
  const atomicBatch = await pool.query(
    "SELECT offer_id,status,product_id FROM submission_items WHERE job_id=$1 ORDER BY offer_id",
    [batchSubmission.job.id],
  );
  assert.deepEqual(atomicBatch.rows, [
    { offer_id: "offer-batch-a", status: "CHECKING", product_id: "" },
    { offer_id: "offer-batch-b", status: "SUCCEEDED", product_id: "991101" },
  ]);

  const historicalEvidence = {
    schemaVersion: "OZON_IMPORT_ERROR_EVIDENCE_V1", policyVersion: 1,
    code: "HISTORICAL_REVIEWED_CATEGORY_CODE", field: "description_category_id",
    attributeId: null, state: "FAILED", offerId: "offer-1", productId: null,
    classification: "EXPLICIT_CATEGORY_FAILURE",
  };
  await pool.query(
    `UPDATE submission_items SET response=JSONB_BUILD_OBJECT(
       'schemaVersion','OZON_SUBMISSION_ITEM_RESPONSE_V1','rawResponse','{}'::jsonb,
       'errorEvidence',$2::jsonb) WHERE job_id=$1`,
    [created.job.id, JSON.stringify(historicalEvidence)],
  );
  await assert.rejects(persistSubmissionItems(created.job.id, normalizedImportItems([{
    offer_id: "offer-1", sku: "source-sku", product_id: 0, status: "failed",
    errors: [{ code: "UNKNOWN", field: "unknown", message: "stale-unknown-secret" }],
  }]), createdScope), (error) => error?.code === "OZON_IMPORT_RESULT_CONFLICT"
    && !/stale-unknown-secret/iu.test(error.message));
  const preservedHistoricalEvidence = await pool.query(
    "SELECT response->'errorEvidence' AS evidence FROM submission_items WHERE job_id=$1",
    [created.job.id],
  );
  assert.deepEqual(preservedHistoricalEvidence.rows[0].evidence, historicalEvidence);
  const publicImportJob = await getSubmissionJobV3(created.job.id, accountId);
  assert.equal(publicImportJob.items[0].errorEvidence, null);
  assert.doesNotMatch(JSON.stringify(publicImportJob), /raw-third-party-secret|credential/iu);
  assert.equal(await getSubmissionJobV3(created.job.id, foreignAccountId), null);
  await pool.query(
    "UPDATE submission_jobs SET error_code='UNKNOWN',error_message='job-third-party-secret',status_message='status-third-party-secret' WHERE id=$1",
    [created.job.id],
  );
  await pool.query(
    "UPDATE submission_events SET message='event-third-party-secret' WHERE job_id=$1",
    [created.job.id],
  );
  const closedPublicJob = await getSubmissionJobV3(created.job.id, accountId);
  const closedPublicDetail = await getSubmissionJobDetailV3(created.job.id, accountId);
  assert.doesNotMatch(JSON.stringify({ closedPublicJob, closedPublicDetail }), /third-party-secret/iu);
  assert.equal(closedPublicJob.errorMessage, "商品上架失败，请重试或联系管理员");

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
      normalizedItems: [{
        ...normalizedItems[0],
        name: "用户修改标题",
        weight: 0,
        depth: 0,
        width: 0,
        height: 0,
      }],
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
    ownerAccountId: accountId,
    label: "Pipeline Test Store",
    clientId: `client-${suffix}`,
    currencyCode: "RUB",
    currencySource: "OZON_SELLER_INFO",
    currencySyncedAt: "2026-08-13T00:00:00.000Z",
    validatedAt: audit.rows[0].metadata.targetStore.validatedAt,
  });
  assert.doesNotMatch(
    JSON.stringify(audit.rows[0].metadata),
    /secret-|encrypted_api_key|apiKey|authTag|credential/i,
  );

  await assert.rejects(
    prepareCollectItemForListing({
      collectItem: baseItem,
      accountId,
      collectItemId: collectId,
      targetStoreId: storeId,
      idempotencyKey: `wrong-warehouse-${suffix}`,
      normalizedItems: [{ ...normalizedItems[0], name: "Wrong warehouse target" }],
      stocks: [{ offer_id: "offer-1", warehouse_id: 2, stock: 5 }],
    }),
    (error) => error?.status === 422
      && error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE"
      && error?.body?.reason === "STORE_SCOPE_MISMATCH",
  );

  await pool.query("UPDATE stores SET status='disabled' WHERE id=$1", [storeId]);
  const disabledTargetReplay = await prepareCollectItemForListing({
    collectItem: baseItem,
    accountId,
    collectItemId: collectId,
    targetStoreId: storeId,
    idempotencyKey: `prepare-${suffix}`,
    normalizedItems: [{ ...normalizedItems[0], name: "Ignored replay payload" }],
    stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
  });
  assert.equal(disabledTargetReplay.duplicate, true);
  assert.equal(disabledTargetReplay.job.id, created.job.id);

  await pool.query("UPDATE stores SET status='active' WHERE id=$1", [storeId]);
  await pool.query("DELETE FROM store_credentials WHERE store_id=$1", [storeId]);
  const credentialRemovedReplay = await prepareCollectItemForListing({
    collectItem: baseItem,
    accountId,
    collectItemId: collectId,
    targetStoreId: storeId,
    idempotencyKey: `prepare-${suffix}`,
    normalizedItems: [{ ...normalizedItems[0], name: "Ignored replay payload" }],
    stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
  });
  assert.equal(credentialRemovedReplay.duplicate, true);
  assert.equal(credentialRemovedReplay.job.id, created.job.id);
  await saveCredential(storeId, `client-${suffix}`);

  const concurrentCallerKey = `concurrent-prepare-${suffix}`;
  const concurrentResults = await Promise.allSettled(
    Array.from({ length: 12 }, () => prepareCollectItemForListing({
      collectItem: baseItem,
      accountId,
      collectItemId: collectId,
      targetStoreId: storeId,
      idempotencyKey: concurrentCallerKey,
      normalizedItems: [{ ...normalizedItems[0], name: "Concurrent preparation" }],
      stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
    })),
  );
  assert.deepEqual(
    concurrentResults.map((result) => result.status),
    Array(12).fill("fulfilled"),
  );
  assert.equal(
    new Set(concurrentResults.map((result) => result.value.job.id)).size,
    1,
  );
  const concurrentDatabaseKey = crypto.createHash("sha256")
    .update(["listing-prepare", accountId, concurrentCallerKey].join("|"))
    .digest("hex");
  const concurrentRows = await pool.query(
    `SELECT
       COUNT(DISTINCT s.id)::int AS snapshot_count,
       COUNT(DISTINCT j.id)::int AS job_count
     FROM submission_snapshots s
     LEFT JOIN submission_jobs j ON j.snapshot_id=s.id
     WHERE s.idempotency_key=$1 AND s.account_id=$2`,
    [concurrentDatabaseKey, accountId],
  );
  assert.deepEqual(concurrentRows.rows[0], {
    snapshot_count: 1,
    job_count: 1,
  });

  const raceItem = {
    ...baseItem,
    id: raceCollectId,
    sku: "source-sku-race",
    listingDraft: { ...baseItem.listingDraft, sku: "source-sku-race" },
  };
  await mirrorCollectItemV3(raceItem, { accountId, storeId, captureRaw: true });
  const raceIdempotencyKey = `delete-race-${suffix}`;
  const raceDatabaseKey = crypto.createHash("sha256")
    .update(["listing-prepare", accountId, raceIdempotencyKey].join("|"))
    .digest("hex");
  const blocker = await pool.connect();
  let raceListingPromise;
  let raceDeletePromise;
  let raceResults = [];
  try {
    await blocker.query("BEGIN");
    const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [raceDatabaseKey]);
    raceListingPromise = prepareCollectItemForListing({
      collectItem: raceItem,
      accountId,
      collectItemId: raceCollectId,
      targetStoreId: storeId,
      idempotencyKey: raceIdempotencyKey,
      normalizedItems: [{ ...normalizedItems[0], offer_id: "offer-race", scraped_sku: "source-sku-race" }],
      stocks: [{ offer_id: "offer-race", warehouse_id: 1, stock: 5 }],
    });
    let listingBlocked = false;
    for (let attempt = 0; attempt < 100 && !listingBlocked; attempt += 1) {
      const blocked = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1",
        [blockerPid],
      );
      listingBlocked = blocked.rowCount > 0;
      if (!listingBlocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(listingBlocked, true, "listing preparation must reach the held idempotency lock");
    raceDeletePromise = softDeleteCollectItemsForAccountV4(accountId, [raceCollectId]);
    let deleteBlockedByListing = false;
    for (let attempt = 0; attempt < 100 && !deleteBlockedByListing; attempt += 1) {
      const blocked = await pool.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE query LIKE 'UPDATE collect_items SET deleted_at=NOW()%'
            AND cardinality(pg_blocking_pids(pid)) > 0
          LIMIT 1`,
      );
      deleteBlockedByListing = blocked.rowCount > 0;
      if (!deleteBlockedByListing) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(deleteBlockedByListing, true, "soft delete must wait for the listing transaction's item lock");
  } finally {
    await blocker.query("COMMIT").catch(() => null);
    blocker.release();
    raceResults = await Promise.allSettled([raceListingPromise, raceDeletePromise].filter(Boolean));
  }
  assert.deepEqual(raceResults.map((result) => result.status), ["fulfilled", "fulfilled"]);
  assert.equal(raceResults[1].value, 1);
  const deletedRaceItem = await pool.query("SELECT deleted_at,status FROM collect_items WHERE id=$1", [raceCollectId]);
  assert.ok(deletedRaceItem.rows[0].deleted_at);
  assert.equal(deletedRaceItem.rows[0].status, "DELETED");
  await assert.rejects(
    prepareCollectItemForListing({
      collectItem: raceItem,
      accountId,
      collectItemId: raceCollectId,
      targetStoreId: storeId,
      idempotencyKey: `deleted-${suffix}`,
      normalizedItems: [{ ...normalizedItems[0], offer_id: "offer-race", scraped_sku: "source-sku-race" }],
      stocks: [{ offer_id: "offer-race", warehouse_id: 1, stock: 5 }],
    }),
    (error) => error?.status === 404 && error?.code === "COLLECT_ITEM_NOT_FOUND",
  );

  const routeToken = `listing-route-token-${suffix}`;
  routeDataDir = await mkdtemp(path.join(os.tmpdir(), "listing-route-replay-"));
  await writeFile(path.join(routeDataDir, "local-state.json"), JSON.stringify({
    token: routeToken,
    currentAccountId: accountId,
    sessionIssuedAt: "2026-07-29T00:00:00.000Z",
    accounts: [
      { id: accountId, username: `pipeline-${suffix}`, displayName: "Pipeline Test", role: "admin", status: "active" },
      { id: foreignAccountId, username: `pipeline-foreign-${suffix}`, displayName: "Pipeline Foreign Test", role: "user", status: "active" },
    ],
    currentStoreId: "",
    stores: [
      { id: foreignStoreId, ownerAccountId: foreignAccountId, label: "Foreign Secret Store", clientId: `client-foreign-${suffix}`, apiKey: "route-foreign-key", status: "active", currencyCode: "RUB" },
    ],
    caches: {
      collectBox: [{
        ...baseItem,
        accountId,
        listingDraft: {
          ...baseItem.listingDraft,
          title: "用户修改标题",
          description: "Route replay description",
          descriptionCategoryId: 1,
          typeId: 2,
          packageWeight: "100",
          packageLength: "100",
          packageWidth: "100",
          packageHeight: "100",
          listingWarehouseId: "1",
          listingStock: "5",
          images: ["https://example.invalid/1.jpg"],
        },
      }, {
        ...changedPayloadItem,
        accountId,
        listingDraft: {
          ...changedPayloadItem.listingDraft,
          description: "Changed payload replay description",
          descriptionCategoryId: 1,
          typeId: 2,
          packageWeight: "100",
          packageLength: "100",
          packageWidth: "100",
          packageHeight: "100",
          listingWarehouseId: "1",
          listingStock: "5",
          images: ["https://example.invalid/changed-payload.jpg"],
        },
      }],
      warehouses: [
        { id: warehouseAId, warehouse_id: "1", storeId, name: "Store A FBS", warehouse_type: "FBS", status: "active" },
        { id: warehouseBId, warehouse_id: "2", storeId: secondStoreId, name: "Store B FBS", warehouse_type: "FBS", status: "active" },
      ],
    },
    jobs: {},
    reports: [],
  }), "utf8");
  process.env.QH_LOCAL_DATA_DIR = routeDataDir;
  process.env.QH_LOCAL_NO_LISTEN = "1";
  process.env.QH_LOCAL_NO_DOTENV = "1";
  process.env.POSTGRES_STATE_TABLE = routeStateTable;
  process.env.SONLI_ADMIN_PASSWORD = "task5-route-test-admin-password";
  await pool.query("UPDATE stores SET status='disabled' WHERE id=$1", [storeId]);
  const originalFetch = globalThis.fetch;
  let routeExternalCalls = 0;
  globalThis.fetch = async () => {
    routeExternalCalls += 1;
    throw new Error("replay must not call Ozon");
  };
  try {
    const { handle } = await import("../index.mjs");
    const routeReplay = await requestJson(
      handle,
      `/ozon/collect-box/${encodeURIComponent(collectId)}/listing/submit`,
      {
        targetStoreId: storeId,
        idempotencyKey: `prepare-${suffix}`,
      },
      routeToken,
    );
    assert.equal(routeReplay.status, 200, JSON.stringify(routeReplay.body));
    assert.equal(routeReplay.body.job.id, created.job.id);
    assert.equal(routeExternalCalls, 0);
    const replayBlocker = await pool.connect();
    let concurrentReplayPromise;
    let concurrentDraftUpdatePromise;
    let concurrentReplayResult;
    try {
      await replayBlocker.query("BEGIN");
      const replayBlockerPid = Number((await replayBlocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const replayDatabaseKey = crypto.createHash("sha256")
        .update(["listing-prepare", accountId, `prepare-${suffix}`].join("|"))
        .digest("hex");
      await replayBlocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [replayDatabaseKey]);
      concurrentReplayPromise = requestJson(
        handle,
        `/ozon/collect-box/${encodeURIComponent(collectId)}/listing/submit`,
        { targetStoreId: storeId, idempotencyKey: `prepare-${suffix}` },
        routeToken,
      );
      let replayBlocked = false;
      for (let attempt = 0; attempt < 100 && !replayBlocked; attempt += 1) {
        const blocked = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1",
          [replayBlockerPid],
        );
        replayBlocked = blocked.rowCount > 0;
        if (!replayBlocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(replayBlocked, true, "route replay must reach the held idempotency lock");
      concurrentDraftUpdatePromise = pool.query(
        `UPDATE product_drafts
            SET data=data-'logistics'-'packageWeight'-'packageLength'-'packageWidth'-'packageHeight'
          WHERE collect_item_id=$1`,
        [collectId],
      );
      let draftUpdateBlocked = false;
      for (let attempt = 0; attempt < 100 && !draftUpdateBlocked; attempt += 1) {
        const blocked = await pool.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE query LIKE 'UPDATE product_drafts%SET data=data%'
              AND cardinality(pg_blocking_pids(pid)) > 0
            LIMIT 1`,
        );
        draftUpdateBlocked = blocked.rowCount > 0;
        if (!draftUpdateBlocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(draftUpdateBlocked, true, "route replay must hold the current draft stable through validation");
    } finally {
      await replayBlocker.query("COMMIT").catch(() => null);
      replayBlocker.release();
      [concurrentReplayResult] = await Promise.all([
        concurrentReplayPromise,
        concurrentDraftUpdatePromise,
      ]);
    }
    assert.equal(concurrentReplayResult.status, 200, JSON.stringify(concurrentReplayResult.body));
    assert.equal(concurrentReplayResult.body.job.id, created.job.id);
    const persistedStatusBeforeIncomplete = await pool.query(
      "SELECT status FROM collect_items WHERE id=$1",
      [collectId],
    );
    const replayStateBefore = JSON.parse(await readFile(path.join(routeDataDir, "local-state.json"), "utf8"));
    const replayItemBefore = replayStateBefore.caches.collectBox.find((item) => item.id === collectId);
    const replayRowsBefore = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM submission_snapshots WHERE collect_item_id=$1) AS snapshot_count,
         (SELECT COUNT(*)::int FROM submission_jobs WHERE collect_item_id=$1) AS job_count,
         (SELECT COUNT(*)::int FROM outbox_events WHERE aggregate_id IN (
           SELECT id FROM submission_jobs WHERE collect_item_id=$1
         )) AS outbox_count`,
      [collectId],
    );
    const incompleteReplay = await requestJson(
      handle,
      `/ozon/collect-box/${encodeURIComponent(collectId)}/listing/submit`,
      { targetStoreId: storeId, idempotencyKey: `prepare-${suffix}` },
      routeToken,
    );
    assert.equal(incompleteReplay.status, 422, JSON.stringify(incompleteReplay.body));
    assert.equal(incompleteReplay.body.code, "COLLECT_ENRICHMENT_INCOMPLETE");
    assert.deepEqual(incompleteReplay.body.missingFields, ["weightG", "lengthMm", "widthMm", "heightMm"]);
    const replayRowsAfter = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM submission_snapshots WHERE collect_item_id=$1) AS snapshot_count,
         (SELECT COUNT(*)::int FROM submission_jobs WHERE collect_item_id=$1) AS job_count,
         (SELECT COUNT(*)::int FROM outbox_events WHERE aggregate_id IN (
           SELECT id FROM submission_jobs WHERE collect_item_id=$1
         )) AS outbox_count`,
      [collectId],
    );
    assert.deepEqual(replayRowsAfter.rows[0], replayRowsBefore.rows[0]);
    const incompleteStatus = await pool.query("SELECT status FROM collect_items WHERE id=$1", [collectId]);
    assert.equal(incompleteStatus.rows[0].status, persistedStatusBeforeIncomplete.rows[0].status);
    const replayStateAfter = JSON.parse(await readFile(path.join(routeDataDir, "local-state.json"), "utf8"));
    const replayItemAfter = replayStateAfter.caches.collectBox.find((item) => item.id === collectId);
    assert.deepEqual(
      {
        status: replayItemAfter.status,
        listingTaskId: replayItemAfter.listingTaskId,
        listingJobId: replayItemAfter.listingJobId,
      },
      {
        status: replayItemBefore.status,
        listingTaskId: replayItemBefore.listingTaskId,
        listingJobId: replayItemBefore.listingJobId,
      },
    );
    assert.equal(routeExternalCalls, 0);
    const changedTargetReplay = await requestJson(
      handle,
      `/ozon/collect-box/${encodeURIComponent(collectId)}/listing/submit`,
      { targetStoreId: secondStoreId, idempotencyKey: `prepare-${suffix}` },
      routeToken,
    );
    assert.equal(changedTargetReplay.status, 409);
    assert.equal(changedTargetReplay.body.code, "LISTING_TARGET_STORE_CONFLICT");
    const changedTargetState = JSON.parse(await readFile(path.join(routeDataDir, "local-state.json"), "utf8"));
    const changedTargetItem = changedTargetState.caches.collectBox.find((item) => item.id === collectId);
    assert.deepEqual(
      {
        status: changedTargetItem.status,
        listingTaskId: changedTargetItem.listingTaskId,
        listingJobId: changedTargetItem.listingJobId,
      },
      {
        status: replayItemBefore.status,
        listingTaskId: replayItemBefore.listingTaskId,
        listingJobId: replayItemBefore.listingJobId,
      },
    );
    const changedTargetRows = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM submission_snapshots WHERE collect_item_id=ANY($1::text[])) AS snapshot_count,
         (SELECT COUNT(*)::int FROM submission_jobs WHERE collect_item_id=ANY($1::text[])) AS job_count,
         (SELECT COUNT(*)::int FROM outbox_events WHERE aggregate_id IN (
           SELECT id FROM submission_jobs WHERE collect_item_id=ANY($1::text[])
         )) AS outbox_count`,
      [[collectId, changedPayloadCollectId]],
    );
    assert.deepEqual(changedTargetRows.rows[0], replayRowsBefore.rows[0]);
    const changedPayloadBefore = JSON.parse(await readFile(path.join(routeDataDir, "local-state.json"), "utf8"))
      .caches.collectBox.find((item) => item.id === changedPayloadCollectId);
    const changedPayloadReplay = await requestJson(
      handle,
      `/ozon/collect-box/${encodeURIComponent(changedPayloadCollectId)}/listing/submit`,
      { targetStoreId: storeId, idempotencyKey: `prepare-${suffix}` },
      routeToken,
    );
    assert.equal(changedPayloadReplay.status, 409);
    assert.equal(changedPayloadReplay.body.code, "LISTING_IDEMPOTENCY_CONFLICT");
    const changedPayloadState = JSON.parse(await readFile(path.join(routeDataDir, "local-state.json"), "utf8"));
    const changedPayloadAfter = changedPayloadState.caches.collectBox.find((item) => item.id === changedPayloadCollectId);
    assert.deepEqual(
      {
        status: changedPayloadAfter.status,
        listingTaskId: changedPayloadAfter.listingTaskId,
        listingJobId: changedPayloadAfter.listingJobId,
      },
      {
        status: changedPayloadBefore.status,
        listingTaskId: changedPayloadBefore.listingTaskId,
        listingJobId: changedPayloadBefore.listingJobId,
      },
    );
    const changedPayloadRows = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM submission_snapshots WHERE collect_item_id=ANY($1::text[])) AS snapshot_count,
         (SELECT COUNT(*)::int FROM submission_jobs WHERE collect_item_id=ANY($1::text[])) AS job_count,
         (SELECT COUNT(*)::int FROM outbox_events WHERE aggregate_id IN (
           SELECT id FROM submission_jobs WHERE collect_item_id=ANY($1::text[])
         )) AS outbox_count`,
      [[collectId, changedPayloadCollectId]],
    );
    assert.deepEqual(changedPayloadRows.rows[0], replayRowsBefore.rows[0]);
    const changedIdempotencyIncomplete = await requestJson(
      handle,
      `/ozon/collect-box/${encodeURIComponent(collectId)}/listing/submit`,
      { targetStoreId: storeId, idempotencyKey: `changed-${suffix}` },
      routeToken,
    );
    assert.equal(changedIdempotencyIncomplete.status, 404);
    assert.equal(changedIdempotencyIncomplete.body.code, "TARGET_STORE_NOT_FOUND");
    const missingTarget = await requestJson(
      handle,
      `/ozon/collect-box/${encodeURIComponent(collectId)}/listing/submit`,
      { targetStoreId: storeId, idempotencyKey: `unlinked-new-${suffix}` },
      routeToken,
    );
    const foreignTarget = await requestJson(
      handle,
      `/ozon/collect-box/${encodeURIComponent(collectId)}/listing/submit`,
      { targetStoreId: foreignStoreId, idempotencyKey: `foreign-new-${suffix}` },
      routeToken,
    );
    assert.deepEqual(
      [missingTarget.status, missingTarget.body.code, foreignTarget.status, foreignTarget.body.code],
      [404, "TARGET_STORE_NOT_FOUND", 404, "TARGET_STORE_NOT_FOUND"],
    );
    assert.doesNotMatch(JSON.stringify(foreignTarget.body), /Foreign Secret Store|client-foreign/i);
    assert.equal(routeExternalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await pool.query("UPDATE stores SET status='active' WHERE id=$1", [storeId]);

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

  assert.equal(await softDeleteCollectItemsForAccountV4(accountId, [collectId]), 1);
  const deleted = await pool.query("SELECT deleted_at FROM collect_items WHERE id=$1", [collectId]);
  assert.ok(deleted.rows[0].deleted_at);
  console.log("listing pipeline v3 integration passed");
} finally {
  if (routeDataDir) await rm(routeDataDir, { recursive: true, force: true });
  await pool.query(`DROP TABLE IF EXISTS ${routeStateTable}`);
  await cleanup();
  await closePostgresPool();
}

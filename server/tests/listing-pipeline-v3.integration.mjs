import "../env.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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
const collectIds = [collectId, changedPayloadCollectId, raceCollectId];
const warehouseAId = `wh_${crypto.createHash("sha256").update(`${storeId}|1`).digest("hex").slice(0, 24)}`;
const warehouseBId = `wh_${crypto.createHash("sha256").update(`${secondStoreId}|2`).digest("hex").slice(0, 24)}`;
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
  await pool.query(
    `INSERT INTO warehouses (id,store_id,warehouse_id,name,warehouse_type,status,is_active,is_archived)
     VALUES
       ($1,$3,'1','Store A FBS','FBS','active',TRUE,FALSE),
       ($2,$4,'2','Store B FBS','FBS','active',TRUE,FALSE)`,
    [warehouseAId, warehouseBId, storeId, secondStoreId],
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
    label: "Pipeline Test Store",
    clientId: `client-${suffix}`,
    currencyCode: "RUB",
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
    (error) => error?.status === 409 && error?.code === "LISTING_WAREHOUSE_TARGET_MISMATCH",
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
    raceDeletePromise = softDeleteCollectItemsV3(accountId, [raceCollectId]);
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
    assert.equal(incompleteStatus.rows[0].status, replayItemBefore.status);
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

  assert.equal(await softDeleteCollectItemsV3(accountId, [collectId]), 1);
  const deleted = await pool.query("SELECT deleted_at FROM collect_items WHERE id=$1", [collectId]);
  assert.ok(deleted.rows[0].deleted_at);
  console.log("listing pipeline v3 integration passed");
} finally {
  if (routeDataDir) await rm(routeDataDir, { recursive: true, force: true });
  await pool.query(`DROP TABLE IF EXISTS ${routeStateTable}`);
  await cleanup();
  await closePostgresPool();
}

import "./support/dedicated-postgres-test-environment.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { closePostgresPool, getPostgresPool, postgresEnabled } from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import {
  ingestCollectRequestV4,
} from "../collection-pipeline.mjs";
import {
  softDeleteCollectItemsForAccountV4,
  updateCollectItemDraftV4,
} from "../listing-pipeline.mjs";

if (!postgresEnabled()) {
  console.log("collection pipeline v4 integration skipped: PostgreSQL is not configured");
  process.exit(0);
}

const suffix = crypto.randomUUID();
const accountA = `collect_v4_a_${suffix}`;
const accountB = `collect_v4_b_${suffix}`;
const accountCascade = `collect_v4_cascade_${suffix}`;
const storeId = `collect_v4_store_${suffix}`;
const storeIdB = `collect_v4_store_b_${suffix}`;
const sku = `sku-${suffix}`;
const noStoreCollectItemId = `collect_v4_no_store_${suffix}`;
const pool = await getPostgresPool();
const collectIds = [];

async function cleanup() {
  await pool.query("DELETE FROM collector_ozon_enrichment_jobs WHERE account_id=ANY($1::text[])", [[accountA, accountB, accountCascade]]);
  await pool.query("DELETE FROM collect_requests WHERE collect_item_id=ANY($1::text[]) OR account_id=ANY($2::text[])", [[...collectIds, noStoreCollectItemId], [accountA, accountB, accountCascade]]);
  await pool.query("DELETE FROM collect_raw_payloads WHERE collect_item_id=ANY($1::text[]) OR account_id=ANY($2::text[])", [[...collectIds, noStoreCollectItemId], [accountA, accountB, accountCascade]]);
  await pool.query("DELETE FROM collect_items WHERE id=ANY($1::text[]) OR account_id=ANY($2::text[])", [[...collectIds, noStoreCollectItemId], [accountA, accountB, accountCascade]]);
  await pool.query("DELETE FROM stores WHERE id=ANY($1::text[])", [[storeId, storeIdB]]);
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
    `INSERT INTO accounts (id,username,display_name,role,status)
     VALUES ($1,$2,$2,'admin','active'),($3,$4,$4,'user','active'),($5,$6,$6,'user','active')`,
    [accountA, `collect-a-${suffix}`, accountB, `collect-b-${suffix}`, accountCascade, `collect-cascade-${suffix}`],
  );
  await pool.query(
    `INSERT INTO stores (id,owner_account_id,label,client_id,status)
     VALUES ($1,$2,$3,$4,'active'),($5,$6,$7,$8,'active')`,
    [
      storeId, accountA, "Collect V4 Store", `collect-client-${suffix}`,
      storeIdB, accountB, "Collect V4 Store B", `collect-client-b-${suffix}`,
    ],
  );

  const item = {
    id: sku,
    sku,
    name: "V4 原始标题",
    descriptionCategoryId: 17000001,
    logistics: {
      weightG: 500,
      lengthMm: 300,
      widthMm: 200,
      heightMm: 100,
    },
    images: ["https://example.invalid/v4.jpg"],
    variants: [{ sku: `${sku}-red`, offerId: `${sku}-offer-red`, name: "红色" }],
    listingDraft: {
      sku,
      title: "V4 预处理标题",
      price: "100.00",
      variants: [{ sku: `${sku}-red`, offerId: `${sku}-offer-red`, name: "红色" }],
    },
    collectedAt: new Date().toISOString(),
  };

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

  const first = await ingestCollectRequestV4({
    authenticatedAccount: { id: accountA },
    input: {
      source: "ozon",
      sourceSku: sku,
      sourceUrl: `https://www.ozon.ru/product/${sku}/`,
      requestId: `idem-${suffix}`,
      capturedAt: item.collectedAt,
      payload: item,
    },
  });
  collectIds.push(first.collectItemId);
  assert.equal(first.duplicate, false);
  assert.equal(first.enrichment.status, "COMPLETE");
  assert.deepEqual(first.item.enrichment, first.enrichment);

  const publicSku = `public-${suffix}`;
  const publicRequestId = `public-request-${suffix}`;
  const publicFirst = await ingestCollectRequestV4({
    authenticatedAccount: { id: accountA },
    input: {
      source: "ozon",
      sourceSku: publicSku,
      requestId: publicRequestId,
      payload: { sku: publicSku, name: "Public-first V4 item" },
    },
  });
  collectIds.push(publicFirst.collectItemId);
  assert.equal(publicFirst.enrichment.status, "PENDING_ENRICHMENT");
  assert.deepEqual(publicFirst.enrichment.missingFields, [
    "descriptionCategoryId",
    "weightG",
    "lengthMm",
    "widthMm",
    "heightMm",
  ]);
  const publicReplay = await ingestCollectRequestV4({
    authenticatedAccount: { id: accountA },
    input: {
      source: "ozon",
      sourceSku: publicSku,
      requestId: publicRequestId,
      payload: { sku: publicSku, name: "Public-first V4 item" },
    },
  });
  assert.equal(publicReplay.duplicate, true);
  assert.equal(publicReplay.collectItemId, publicFirst.collectItemId);
  const linkedJob = await pool.query(
    `SELECT account_id,collect_item_id,request_id,sku,status
       FROM collector_ozon_enrichment_jobs
      WHERE account_id=$1 AND request_id=$2 AND sku=$3`,
    [accountA, publicRequestId, publicSku],
  );
  assert.deepEqual(linkedJob.rows, [{
    account_id: accountA,
    collect_item_id: publicFirst.collectItemId,
    request_id: publicRequestId,
    sku: publicSku,
    status: "PENDING",
  }]);
  const historicalDataStore = await pool.query(
    "SELECT data_collection_store_id FROM collect_items WHERE id=$1",
    [first.collectItemId],
  );
  assert.equal(historicalDataStore.rows[0]?.data_collection_store_id, null, "新采集记录不写入数据采集店铺");

  const duplicate = await ingestCollectRequestV4({
    authenticatedAccount: { id: accountA },
    input: {
      source: "ozon",
      sourceSku: sku,
      requestId: `idem-${suffix}`,
      payload: item,
    },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.collectItemId, first.collectItemId);
  await assert.rejects(
    ingestCollectRequestV4({
      authenticatedAccount: { id: accountA },
      input: {
        source: "ozon",
        sourceSku: sku,
        requestId: `idem-${suffix}`,
        payload: { ...item, name: "不同请求内容" },
      },
    }),
    (error) => error?.code === "COLLECT_REQUEST_CONFLICT" && error?.status === 409,
  );
  const afterReuse = await pool.query(
    "SELECT status FROM collect_requests WHERE account_id=$1 AND id=$2",
    [accountA, first.requestId],
  );
  assert.equal(afterReuse.rows[0]?.status, "SUCCEEDED", "复用幂等键失败不能污染已成功请求");

  await ingestCollectRequestV4({
    authenticatedAccount: { id: accountA },
    input: {
      source: "ozon",
      sourceSku: sku,
      requestId: `idem-content-${suffix}`,
      capturedAt: new Date(Date.now() + 1000).toISOString(),
      payload: item,
    },
  });
  const rawCount = await pool.query("SELECT COUNT(*)::int count FROM collect_raw_payloads WHERE collect_item_id=$1", [first.collectItemId]);
  assert.equal(rawCount.rows[0].count, 1, "只改变采集时间不能新增原始内容版本");

  await pool.query(
    "UPDATE collect_items SET summary=summary-'enrichment' WHERE id=$1 AND account_id=$2",
    [first.collectItemId, accountA],
  );
  await pool.query(
    "UPDATE collect_raw_payloads SET payload=payload #- '{normalized,enrichment}' WHERE collect_item_id=$1 AND account_id=$2",
    [first.collectItemId, accountA],
  );
  const legacyCanonical = await ingestCollectRequestV4({
    authenticatedAccount: { id: accountA },
    input: {
      source: "ozon",
      sourceSku: sku,
      requestId: `idem-legacy-no-summary-${suffix}`,
      payload: { sku, name: "Legacy canonical must supply completeness" },
    },
  });
  assert.equal(legacyCanonical.enrichment.status, "COMPLETE");
  assert.deepEqual(legacyCanonical.enrichment.missingFields, []);
  const legacyCanonicalJobs = await pool.query(
    "SELECT COUNT(*)::int count FROM collector_ozon_enrichment_jobs WHERE account_id=$1 AND collect_item_id=$2",
    [accountA, first.collectItemId],
  );
  assert.equal(legacyCanonicalJobs.rows[0].count, 0,
    "legacy canonical evidence must not enqueue a spurious enrichment job");

  const edited = await updateCollectItemDraftV4({
    collectItemId: first.collectItemId,
    accountId: accountA,
    expectedVersion: 1,
    patch: { listingDraft: { ...item.listingDraft, title: "用户修改标题" } },
  });
  assert.equal(edited.draftVersion, 2);
  await pool.query(
    `UPDATE collect_items
        SET status='COMPLETE',summary=jsonb_set(summary,'{enrichment}',$3::jsonb,TRUE)
      WHERE id=$1 AND account_id=$2`,
    [first.collectItemId, accountA, JSON.stringify({ status: "COMPLETE", missingFields: [], attemptCount: 2 })],
  );
  const recollected = await ingestCollectRequestV4({
    authenticatedAccount: { id: accountA },
    input: {
      source: "ozon",
      sourceSku: sku,
      requestId: `idem-after-manual-${suffix}`,
      payload: {
        ...item,
        name: "公共重采标题不能覆盖人工结果",
        laterPublicEvidence: "new-evidence",
      },
    },
  });
  assert.equal(recollected.collectItemId, first.collectItemId);
  assert.equal(recollected.item.status, "COMPLETE");
  assert.equal(recollected.item.name, "V4 原始标题");
  assert.equal(recollected.item.laterPublicEvidence, "new-evidence");
  assert.equal(recollected.item.listingDraft.title, "用户修改标题");
  assert.equal(recollected.draftVersion, 2);
  const recollectCounts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM collect_items WHERE account_id=$1 AND source_sku=$2) item_count,
       (SELECT COUNT(*)::int FROM collect_requests WHERE account_id=$1 AND source_sku=$2 AND status='SUCCEEDED') request_count,
       (SELECT COUNT(*)::int FROM collector_ozon_enrichment_jobs WHERE account_id=$1 AND collect_item_id=$3) job_count`,
    [accountA, sku, first.collectItemId],
  );
  assert.deepEqual(recollectCounts.rows[0], { item_count: 1, request_count: 4, job_count: 0 });
  await assert.rejects(
    updateCollectItemDraftV4({
      collectItemId: first.collectItemId,
      accountId: accountA,
      expectedVersion: 1,
      patch: { listingDraft: { ...item.listingDraft, title: "过期页面覆盖" } },
    }),
    (error) => error?.code === "DRAFT_VERSION_CONFLICT" && error?.status === 409,
  );

  const originalRequest = await pool.query(
    "SELECT status FROM collect_requests WHERE account_id=$1 AND id=$2",
    [accountA, first.requestId],
  );
  assert.equal(originalRequest.rows[0]?.status, "SUCCEEDED", "跨账号失败不能污染原账号幂等请求");
  const secondAccount = await ingestCollectRequestV4({
    authenticatedAccount: { id: accountB },
    input: {
      source: "ozon",
      sourceSku: sku,
      requestId: `idem-${suffix}`,
      payload: item,
    },
  });
  collectIds.push(secondAccount.collectItemId);
  assert.notEqual(secondAccount.collectItemId, first.collectItemId, "不同账号采集相同 SKU 必须隔离");

  assert.equal(await softDeleteCollectItemsForAccountV4(accountB, [first.collectItemId]), 0, "账号 B 不能删除账号 A 的采集记录");
  assert.equal(await softDeleteCollectItemsForAccountV4(accountA, [first.collectItemId]), 1);

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
  await assertMigrationRejectsUnownedLegacyRow();
  console.log("collection pipeline v4 integration passed");
} finally {
  await cleanup();
  await closePostgresPool();
}

import "../env.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { closePostgresPool, getPostgresPool, postgresEnabled } from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import {
  ingestCollectRequestV4,
  upsertCollectionStoreForAccount,
  verifyCollectionStoreForAccount,
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
const storeId = `collect_v4_store_${suffix}`;
const storeIdB = `collect_v4_store_b_${suffix}`;
const sellerCompanyId = String(Date.now()).slice(-10) + String(Math.floor(Math.random() * 9999)).padStart(4, "0");
const sellerCompanyIdB = `${sellerCompanyId}7`;
const sku = `sku-${suffix}`;
const pool = await getPostgresPool();
const collectIds = [];

async function cleanup() {
  if (collectIds.length) {
    await pool.query("DELETE FROM collect_requests WHERE collect_item_id=ANY($1::text[]) OR account_id=ANY($2::text[])", [collectIds, [accountA, accountB]]);
    await pool.query("DELETE FROM collect_items WHERE id=ANY($1::text[])", [collectIds]);
  }
  await pool.query("DELETE FROM account_data_collection_stores WHERE account_id=ANY($1::text[])", [[accountA, accountB]]);
  await pool.query("DELETE FROM collection_store_verifications WHERE account_id=ANY($1::text[])", [[accountA, accountB]]);
  await pool.query("DELETE FROM data_collection_stores WHERE seller_company_id=ANY($1::text[])", [[sellerCompanyId, sellerCompanyIdB]]);
  await pool.query("DELETE FROM stores WHERE id=ANY($1::text[])", [[storeId, storeIdB]]);
  await pool.query("DELETE FROM accounts WHERE id=ANY($1::text[])", [[accountA, accountB]]);
}

try {
  await runMigrations(pool);
  await cleanup();
  await pool.query(
    `INSERT INTO accounts (id,username,display_name,role,status)
     VALUES ($1,$2,$2,'admin','active'),($3,$4,$4,'user','active')`,
    [accountA, `collect-a-${suffix}`, accountB, `collect-b-${suffix}`],
  );
  await pool.query(
    `INSERT INTO stores (id,owner_account_id,label,client_id,status)
     VALUES ($1,$2,$3,$4,'active'),($5,$6,$7,$8,'active')`,
    [
      storeId, accountA, "Collect V4 Store", `collect-client-${suffix}`,
      storeIdB, accountB, "Collect V4 Store B", `collect-client-b-${suffix}`,
    ],
  );

  const collectionA = await upsertCollectionStoreForAccount(accountA, {
    label: "测试采集店铺",
    sellerCompanyId,
  });
  await assert.rejects(
    upsertCollectionStoreForAccount(accountB, {
      label: "测试采集店铺 B",
      sellerCompanyId,
    }),
    (error) => error?.code === "DATA_COLLECTION_STORE_ALREADY_OWNED" && error?.status === 409,
  );
  const unmatchedCompanyId = `${sellerCompanyId}99`;
  await assert.rejects(
    verifyCollectionStoreForAccount(accountA, [unmatchedCompanyId], `verify-mismatch-${suffix}`),
    (error) => error?.status === 409,
  );
  const failedAudit = await pool.query(
    "SELECT COUNT(*)::int count FROM collection_store_verifications WHERE account_id=$1 AND seller_company_id=$2 AND matched=FALSE",
    [accountA, unmatchedCompanyId],
  );
  assert.equal(failedAudit.rows[0].count, 1, "失败的数据采集店铺校验必须独立留痕");
  const verified = await verifyCollectionStoreForAccount(accountA, [sellerCompanyId], `verify-${suffix}`);
  assert.equal(verified.store.id, collectionA.id);

  const item = {
    id: sku,
    sku,
    name: "V4 原始标题",
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

  await assert.rejects(
    ingestCollectRequestV4({
      accountId: accountA,
      storeId,
      source: "ozon",
      item,
      idempotencyKey: `missing-collection-store-${suffix}`,
    }),
    (error) => error?.code === "DATA_COLLECTION_STORE_REQUIRED" && error?.status === 409,
  );

  const first = await ingestCollectRequestV4({
    accountId: accountA,
    storeId,
    dataCollectionStoreId: collectionA.id,
    source: "ozon",
    item,
    idempotencyKey: `idem-${suffix}`,
  });
  collectIds.push(first.collectItemId);
  assert.equal(first.duplicate, false);

  const duplicate = await ingestCollectRequestV4({
    accountId: accountA,
    storeId,
    dataCollectionStoreId: collectionA.id,
    source: "ozon",
    item,
    idempotencyKey: `idem-${suffix}`,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.collectItemId, first.collectItemId);
  await assert.rejects(
    ingestCollectRequestV4({
      accountId: accountA,
      storeId,
      dataCollectionStoreId: collectionA.id,
      source: "ozon",
      item: { ...item, name: "不同请求内容" },
      idempotencyKey: `idem-${suffix}`,
    }),
    (error) => error?.code === "IDEMPOTENCY_KEY_REUSED" && error?.status === 409,
  );
  const afterReuse = await pool.query(
    "SELECT status FROM collect_requests WHERE account_id=$1 AND idempotency_key=$2",
    [accountA, `idem-${suffix}`],
  );
  assert.equal(afterReuse.rows[0]?.status, "SUCCEEDED", "复用幂等键失败不能污染已成功请求");

  await ingestCollectRequestV4({
    accountId: accountA,
    storeId,
    dataCollectionStoreId: collectionA.id,
    source: "ozon",
    item: { ...item, collectedAt: new Date(Date.now() + 1000).toISOString() },
    idempotencyKey: `idem-content-${suffix}`,
  });
  const rawCount = await pool.query("SELECT COUNT(*)::int count FROM collect_raw_payloads WHERE collect_item_id=$1", [first.collectItemId]);
  assert.equal(rawCount.rows[0].count, 1, "只改变采集时间不能新增原始内容版本");

  const edited = await updateCollectItemDraftV4({
    collectItemId: first.collectItemId,
    accountId: accountA,
    expectedVersion: 1,
    patch: { listingDraft: { ...item.listingDraft, title: "用户修改标题" } },
  });
  assert.equal(edited.draftVersion, 2);
  await assert.rejects(
    updateCollectItemDraftV4({
      collectItemId: first.collectItemId,
      accountId: accountA,
      expectedVersion: 1,
      patch: { listingDraft: { ...item.listingDraft, title: "过期页面覆盖" } },
    }),
    (error) => error?.code === "DRAFT_VERSION_CONFLICT" && error?.status === 409,
  );

  const boundB = await upsertCollectionStoreForAccount(accountB, {
    label: "测试采集店铺 B",
    sellerCompanyId: sellerCompanyIdB,
  });
  const collectionB = (await verifyCollectionStoreForAccount(accountB, [sellerCompanyIdB], `verify-b-${suffix}`)).store;
  assert.equal(collectionB.id, boundB.id);
  await assert.rejects(
    ingestCollectRequestV4({
      accountId: accountB,
      storeId,
      dataCollectionStoreId: collectionB.id,
      source: "ozon",
      item,
      idempotencyKey: `forbidden-store-${suffix}`,
    }),
    (error) => error?.code === "STORE_ACCOUNT_FORBIDDEN" && error?.status === 403,
  );
  const originalRequest = await pool.query(
    "SELECT status FROM collect_requests WHERE account_id=$1 AND idempotency_key=$2",
    [accountA, `idem-${suffix}`],
  );
  assert.equal(originalRequest.rows[0]?.status, "SUCCEEDED", "跨账号失败不能污染原账号幂等请求");
  const secondAccount = await ingestCollectRequestV4({
    accountId: accountB,
    storeId: storeIdB,
    dataCollectionStoreId: collectionB.id,
    source: "ozon",
    item,
    idempotencyKey: `idem-${suffix}`,
  });
  collectIds.push(secondAccount.collectItemId);
  assert.notEqual(secondAccount.collectItemId, first.collectItemId, "不同账号采集相同 SKU 必须隔离");

  assert.equal(await softDeleteCollectItemsForAccountV4(accountB, [first.collectItemId]), 0, "账号 B 不能删除账号 A 的采集记录");
  assert.equal(await softDeleteCollectItemsForAccountV4(accountA, [first.collectItemId]), 1);
  console.log("collection pipeline v4 integration passed");
} finally {
  await cleanup();
  await closePostgresPool();
}

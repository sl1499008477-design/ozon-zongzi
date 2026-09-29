import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('real normalization and submission creation retain exact source identities independently of API payload/deletion', {
  skip: process.env.SONLI_POSTGRES_TESTS !== '1',
}, async t => {
  const url = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
  assert.ok(url, 'explicit dedicated PostgreSQL URL required');
  assert.equal(process.env.DATABASE_URL, url);
  assert.ok(!['sonli_local', 'postgres', 'template0', 'template1'].includes(decodeURIComponent(new URL(url).pathname.slice(1))));
  process.env.LISTING_PIPELINE_V3 = '1';
  process.env.APP_ENCRYPTION_KEY = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'listing-source-identity-'));
  process.env.QH_LOCAL_DATA_DIR = directory;
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => { externalCalls++; throw Error('no external HTTP allowed in this database fixture'); };
  const { getPostgresPool, closePostgresPool } = await import('../db/connection.mjs');
  const { runMigrations } = await import('../db/migrate.mjs');
  const { mirrorCollectItemV3 } = await import('../listing-pipeline.mjs');
  const { encryptSecret } = await import('../crypto-secrets.mjs');
  const { findCollectorSkuHistory } = await import('../collector-sku-history.mjs');
  const { purgeCollectedItems } = await import('../collection-purge.mjs');
  const { testExports } = await import('../index.mjs');
  const pool = await getPostgresPool();
  const accountId = `source-account-${randomUUID()}`, storeId = `source-store-${randomUUID()}`;
  const token = randomUUID();
  const state = { token, currentAccountId: accountId, sessionIssuedAt: new Date().toISOString(),
    accounts: [{ id: accountId, username: accountId, role: 'admin', status: 'active' }],
    currentStoreId: storeId, stores: [{ id: storeId, ownerAccountId: accountId, label: 'Source identity fixture',
      clientId: storeId, apiKey: 'fixture-only-key', status: 'active', currencyCode: 'CNY',
      currencySource: 'OZON_SELLER_INFO', currencySyncedAt: new Date().toISOString() }] };
  const categoryService = {
    getCategoryTree: async () => ({ items: [{ description_category_id: 1, children: [{ type_id: 3, type_name: 'Fixture' }] }] }),
    getCategoryAttributes: async () => ({ items: [4180, 4191, 4194, 4195, 4497, 9454, 9455, 9456].map(id => ({ id })) }),
    getCategoryAttributeValues: async () => ({ items: [] }),
  };
  const raw = (sku, offerId) => ({ ...(sku ? { scraped_sku: sku } : {}), offer_id: offerId, product_id: '999999999',
    name: 'Source identity fixture', price: '151.76', currency_code: 'CNY',
    images: ['https://example.test/source.jpg'], description_category_id: 1, type_id: 3,
    weight: 100, depth: 100, width: 100, height: 100 });
  async function prepare(items, source = 'ozon', suppliedSource = source) {
    const collectItem = { id: `source-collect-${randomUUID()}`, sku: '86001', source, name: 'Source identity fixture',
      listingDraft: { descriptionCategoryId: 1, variants: items.map(item => ({ sku: item.scraped_sku || '', offerId: item.offer_id })) } };
    await mirrorCollectItemV3(collectItem, { accountId, storeId });
    const body = { targetStoreId: storeId, idempotencyKey: randomUUID(), items, stocks: [] };
    const request = { headers: { authorization: `Bearer ${token}`, 'x-ozon-store-id': storeId } };
    const result = await testExports.queueCollectSubmissionV3(state, request, body, { ...collectItem, source: suppliedSource }, 'COLLECT_BOX_DRAFT', { categoryService });
    const job = (await pool.query('SELECT id,snapshot_id FROM submission_jobs WHERE collect_item_id=$1 AND account_id=$2', [collectItem.id, accountId])).rows[0];
    assert.ok(result.ok);
    assert.ok(job);
    return { collectItemId: collectItem.id, job };
  }
  try {
    // Application services use their real pool/migration path, always pointing at the dedicated clone.
    await runMigrations(pool);
    await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')", [accountId]);
    await pool.query(`INSERT INTO stores(id,label,client_id,owner_account_id,status,currency_code,currency_source,currency_synced_at)
      VALUES($1,$1,$1,$2,'active','CNY','OZON_SELLER_INFO',NOW())`, [storeId, accountId]);
    const key = encryptSecret('fixture-only-key');
    await pool.query(`INSERT INTO store_credentials(store_id,client_id,encrypted_api_key,iv,auth_tag,algorithm,key_version)
      VALUES($1,$1,$2,$3,$4,$5,$6)`, [storeId, key.ciphertext, key.iv, key.authTag, key.algorithm, key.keyVersion]);

    await t.test('per-variant sources survive normalization; absent source SKU never borrows offer/product/root identity', async () => {
      const items = [raw('86001', 'target-offer-a'), raw('86002', 'target-offer-b'), raw('', '86003')];
      const { job, collectItemId } = await prepare(items);
      const rows = (await pool.query('SELECT sku,source,offer_id FROM submission_items WHERE job_id=$1 ORDER BY sort_order', [job.id])).rows;
      assert.deepEqual(rows, [
        { sku: '86001', source: 'ozon', offer_id: 'target-offer-a' },
        { sku: '86002', source: 'ozon', offer_id: 'target-offer-b' },
        { sku: '', source: 'ozon', offer_id: '86003' },
      ]);
      const apiItems = (await pool.query('SELECT items FROM submission_snapshots WHERE id=$1', [job.snapshot_id])).rows[0].items;
      for (const item of apiItems) {
        assert.equal(item.scraped_sku, undefined);
        assert.equal(item.sku, undefined);
        assert.equal(item.source, undefined);
      }
      // Simulate only persisted import outcomes; no worker or Ozon import is invoked.
      await pool.query("UPDATE submission_items SET status=CASE WHEN sort_order=1 THEN 'FAILED' ELSE 'SUCCEEDED' END WHERE job_id=$1", [job.id]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await purgeCollectedItems(client, accountId, [collectItemId]);
        const history = await findCollectorSkuHistory(client, accountId, ['86001', '86002', '86003', '999999999', 'target-offer-a']);
        assert.deepEqual([...history.values()], [{ sku: '86001', state: 'LISTED', submissionJobId: job.id }]);
      } finally { await client.query('ROLLBACK'); client.release(); }
    });

    await t.test('frozen platform comes from the account-scoped stored collection, not the caller projection', async () => {
      const { job, collectItemId } = await prepare([raw('86101', 'target-other-source')], '1688', 'ozon');
      assert.equal((await pool.query('SELECT source FROM submission_items WHERE job_id=$1', [job.id])).rows[0].source, '1688');
      assert.equal((await pool.query('SELECT source FROM collect_items WHERE id=$1', [collectItemId])).rows[0].source, '1688');
    });
    assert.equal(externalCalls, 0);
  } finally {
    const jobs = (await pool.query('SELECT id,snapshot_id FROM submission_jobs WHERE account_id=$1', [accountId])).rows;
    const jobIds = jobs.map(row => row.id), snapshots = jobs.map(row => row.snapshot_id);
    await pool.query('DELETE FROM outbox_events WHERE aggregate_id=ANY($1::text[])', [jobIds]);
    await pool.query('DELETE FROM audit_events WHERE account_id=$1', [accountId]);
    await pool.query('DELETE FROM submission_jobs WHERE id=ANY($1::text[])', [jobIds]);
    await pool.query('DELETE FROM submission_snapshots WHERE id=ANY($1::text[])', [snapshots]);
    await pool.query('DELETE FROM collect_items WHERE account_id=$1', [accountId]);
    await pool.query('DELETE FROM collect_raw_payloads WHERE account_id=$1', [accountId]);
    await pool.query('DELETE FROM stores WHERE id=$1', [storeId]);
    await pool.query('DELETE FROM accounts WHERE id=$1', [accountId]);
    await closePostgresPool();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

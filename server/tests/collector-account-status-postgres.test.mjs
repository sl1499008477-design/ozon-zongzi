import assert from 'node:assert/strict';
import test from 'node:test';
import { readCollectorAccountCounts } from '../collector-account-status-routes.mjs';

// Explicit opt-in: fixtures live only in session-local temporary tables and roll back.
test('PostgreSQL account counts isolate stores and preserve a partly listed 43-SKU group', {
  skip: process.env.OZON_AUTH_LOCAL_POSTGRES_TESTS !== '1',
}, async () => {
  await import('../env.mjs');
  const { Pool } = await import('pg');
  const { postgresConfig } = await import('../db/connection.mjs');
  const config = postgresConfig();
  const host = config.connectionString ? new URL(config.connectionString).hostname : config.host;
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(host), 'temporary fixtures are restricted to local PostgreSQL');
  const pool = new Pool({ ...config, max: 1 });
  const client = await pool.connect();
  let pending = Promise.resolve();
  const transactionPool = { query: (...args) => (pending = pending.then(() => client.query(...args))) };
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE stores(id text,owner_account_id text) ON COMMIT DROP;
      CREATE TEMP TABLE products(id text,store_id text) ON COMMIT DROP;
      CREATE TEMP TABLE collect_items(id text,account_id text,source_sku text,current_draft_id text,deleted_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE product_drafts(id text,collect_item_id text,data jsonb) ON COMMIT DROP;
      CREATE TEMP TABLE collect_raw_payloads(collect_item_id text,account_id text,payload jsonb,created_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE ai_image_listing_tasks(account_id text,status text,body jsonb) ON COMMIT DROP;
      INSERT INTO stores VALUES ('a-1','a'),('a-2','a'),('b-1','b');
      INSERT INTO products VALUES ('1','a-1'),('2','a-2'),('3','a-2'),('4','b-1');
      INSERT INTO collect_items VALUES ('group','a','2102714113','draft-group',NULL),
        ('listed','a','9999999999',NULL,NULL),('pending','a','8888888888',NULL,NULL),
        ('deleted','a','7777777777',NULL,NOW()),('other','b','6666666666',NULL,NULL),
        ('legacy','a','5555555555',NULL,NULL);
      INSERT INTO collect_raw_payloads VALUES ('legacy','a','{"normalized":{"variants":[{"sku":"5555555555"},{"sku":"5555555556"}]}}',NOW());`);
    const variants = ['2102714113', ...Array.from({ length: 42 }, (_, i) => String(2102713500 + i))].map(sku => ({ sku }));
    await client.query('INSERT INTO product_drafts VALUES ($1,$2,$3)', ['draft-group', 'group', JSON.stringify({ variants })]);
    await client.query('INSERT INTO ai_image_listing_tasks VALUES ($1,$2,$3)', ['a', 'COMPLETED',
      JSON.stringify({ source: { items: [{ sku: '2102714113' }, { sku: '9999999999' }, { sku: '5555555555' }] } })]);
    assert.deepEqual(await readCollectorAccountCounts({ pool: transactionPool, accountId: 'a' }), { collect: 3, products: 3 });
    assert.deepEqual(await readCollectorAccountCounts({ pool: transactionPool, accountId: 'b' }), { collect: 1, products: 1 });
    assert.deepEqual(await readCollectorAccountCounts({ pool: transactionPool, accountId: 'absent' }), { collect: 0, products: 0 });
    await client.query('INSERT INTO ai_image_listing_tasks VALUES ($1,$2,$3)', ['a', 'FAILED', JSON.stringify({
      submissionResults: [...variants.slice(1), { sku: '5555555556' }].map(row => ({ ...row, importStatus: 'SUCCEEDED' })),
    })]);
    assert.deepEqual(await readCollectorAccountCounts({ pool: transactionPool, accountId: 'a' }), { collect: 1, products: 3 });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});

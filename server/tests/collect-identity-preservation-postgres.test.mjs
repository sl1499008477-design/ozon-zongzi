import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { mirrorCollectItemV3 } from '../listing-pipeline.mjs';

const enabled = process.env.SONLI_POSTGRES_TESTS === '1';

async function withFixture(run) {
  assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL, 'a dedicated PostgreSQL test database is required');
  assert.equal(process.env.DATABASE_URL, process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  process.env.LISTING_PIPELINE_V3 = '1';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  const suffix = randomUUID();
  const accountA = 'identity-a-' + suffix, accountB = 'identity-b-' + suffix;
  const identityKey = createHash('sha256').update(suffix).digest('hex');
  const item = { id: 'identity-collect-' + suffix, sku: 'identity-sku-' + suffix, source: 'ozon',
    name: 'Stored identity', status: 'COMPLETE', listingDraft: { title: 'Original draft', price: '100.00' } };
  const context = { client, accountId: accountA, identityKey };
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user')", [accountA, accountB]);
    await mirrorCollectItemV3(item, context);
    await run({ client, accountA, accountB, identityKey, item, context });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

test('mirroring an existing collect item without an identity preserves its key while updating the draft', { skip: !enabled }, async () => {
  await withFixture(async ({ client, accountA, identityKey, item }) => {
    for (const supplied of [undefined, '']) {
      await mirrorCollectItemV3({ ...item, status: 'CHECKING', listingDraft: { ...item.listingDraft, title: 'Edited draft' } },
        { client, accountId: accountA, ...(supplied === undefined ? {} : { identityKey: supplied }) });
      const row = (await client.query(`SELECT c.identity_key,c.status,d.data->>'title' AS title
        FROM collect_items c JOIN product_drafts d ON d.id=c.current_draft_id WHERE c.id=$1`, [item.id])).rows[0];
      assert.equal(row.identity_key, identityKey, 'omitted/empty mirror context must not erase the stored dedupe identity');
      assert.equal(row.status, 'CHECKING');
      assert.equal(row.title, 'Edited draft');
    }
  });
});

test('the account identity unique index still rejects duplicates and allows another account', { skip: !enabled }, async () => {
  await withFixture(async ({ client, accountB, item, context, identityKey }) => {
    await client.query('SAVEPOINT duplicate_identity');
    await assert.rejects(mirrorCollectItemV3({ ...item, id: item.id + '-duplicate' }, context),
      error => error.code === '23505' && error.constraint === 'collect_items_account_identity_key_uq');
    await client.query('ROLLBACK TO SAVEPOINT duplicate_identity');
    await mirrorCollectItemV3({ ...item, id: item.id + '-other-account' }, { ...context, accountId: accountB });
    assert.equal((await client.query('SELECT count(*)::int AS count FROM collect_items WHERE identity_key=$1', [identityKey])).rows[0].count, 2);
    await mirrorCollectItemV3({ ...item, id: item.id + '-unkeyed' }, { client, accountId: accountB });
    assert.equal((await client.query('SELECT identity_key FROM collect_items WHERE id=$1', [item.id + '-unkeyed'])).rows[0].identity_key, '',
      'new inserts keep their existing empty-key behavior');
  });
});

test('a mirror from another account cannot overwrite the existing row or its identity', { skip: !enabled }, async () => {
  await withFixture(async ({ client, accountB, item, context }) => {
    const before = (await client.query('SELECT to_jsonb(c) AS row FROM collect_items c WHERE id=$1', [item.id])).rows[0].row;
    await client.query('SAVEPOINT other_account');
    await assert.rejects(mirrorCollectItemV3(item, { ...context, accountId: accountB }),
      error => error.code === 'COLLECT_ITEM_NOT_FOUND');
    await client.query('ROLLBACK TO SAVEPOINT other_account');
    const after = (await client.query('SELECT to_jsonb(c) AS row FROM collect_items c WHERE id=$1', [item.id])).rows[0].row;
    assert.deepEqual(after, before);
  });
});

import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPostgresPool, closePostgresPool } from '../db/connection.mjs';
import { runMigrations } from '../db/migrate.mjs';
import { listCollectItemsV3 } from '../listing-pipeline.mjs';

test('saved collect details retain media and edited variants without transferring unused raw captures', {
  skip: process.env.SONLI_POSTGRES_TESTS !== '1', timeout: 60000,
}, async () => {
  const pool = await getPostgresPool();
  const accountId = `detail-transfer-${randomUUID()}`;
  const id = `${accountId}-item`, draftId = `${id}-draft`;
  const originalQuery = pool.query.bind(pool);
  const image = 'https://media.example.test/first.jpg';
  const video = 'https://media.example.test/product.mp4';
  const normalized = {
    sku: '2032280055', name: 'Смеситель', images: [image], videos: [video],
    description: 'Сохранённое описание',
    variants: [{ sku: '2032280055', images: [image], videos: [video] }],
    listingDraft: { name: 'Previous title' },
  };
  const draft = { name: 'Edited title', variants: [
    { sku: '2032280055', images: [image], videos: [video], attributes: [{ id: 1, values: [{ value: 'Белый' }] }] },
    { sku: '1656069840', images: ['https://media.example.test/second.jpg'], description: 'Second variant' },
  ] };
  let receivedBytes = 0;
  try {
    await runMigrations(pool);
    await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user')", [accountId]);
    await pool.query("INSERT INTO collect_items(id,account_id,source_sku,source_url) VALUES($1,$2,$3,$4)",
      [id, accountId, normalized.sku, `https://www.ozon.ru/product/${normalized.sku}/`]);
    await pool.query(`INSERT INTO collect_raw_payloads(id,collect_item_id,account_id,payload_hash,payload)
      VALUES($1,$2,$3,'fixture',jsonb_build_object('normalized',$4::jsonb,'raw',repeat('unused browser capture ',100000)))`,
      [`${id}-raw`, id, accountId, JSON.stringify(normalized)]);
    await pool.query("INSERT INTO product_drafts(id,collect_item_id,data_hash,data,version) VALUES($1,$2,'fixture',$3,3)",
      [draftId, id, JSON.stringify(draft)]);
    await pool.query('UPDATE collect_items SET current_draft_id=$2 WHERE id=$1', [id, draftId]);
    pool.query = async (...args) => {
      const result = await originalQuery(...args);
      if (result.rows.some(row => row.id === id)) receivedBytes += Buffer.byteLength(JSON.stringify(result.rows));
      return result;
    };
    const [saved] = await listCollectItemsV3({ accountId, ids: [id] });
    assert.equal(saved.name, 'Смеситель');
    assert.equal(saved.description, 'Сохранённое описание');
    assert.deepEqual(saved.images, [image]);
    assert.deepEqual(saved.videos, [video]);
    assert.deepEqual(saved.variants, normalized.variants);
    assert.deepEqual(saved.listingDraft, draft);
    assert.equal(saved.draftVersion, 3);
    assert.equal((await listCollectItemsV3({ accountId: `${accountId}-other`, ids: [id] })).length, 0);
    assert.ok(receivedBytes < 20000, `unused capture reached the API process: ${receivedBytes} bytes`);
  } finally {
    pool.query = originalQuery;
    await pool.query('DELETE FROM collect_items WHERE account_id=$1', [accountId]);
    await pool.query('DELETE FROM collect_raw_payloads WHERE account_id=$1', [accountId]);
    await pool.query('DELETE FROM accounts WHERE id=$1', [accountId]);
    await closePostgresPool();
  }
});

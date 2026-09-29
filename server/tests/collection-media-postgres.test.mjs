import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPostgresPool, closePostgresPool, postgresEnabled } from '../db/connection.mjs';
import { runMigrations } from '../db/migrate.mjs';
import { ingestCollectRequestV4 } from '../collection-pipeline.mjs';
import { listCollectItemsV3, updateCollectItemDraftV4 } from '../listing-pipeline.mjs';
import { buildCollectBoxListingItems } from '../collect-box-listing-items.mjs';
import { buildAiListingSource } from '../ai-listing-runtime.mjs';
import { prepareAiListingItems } from '../ai-listing-submission.mjs';
import { normalizeOzonImportItems } from '../ozon-import-normalizer.mjs';

const enabled = process.env.SONLI_POSTGRES_TESTS === '1'
  && !!process.env.SONLI_MIGRATION_TEST_DATABASE_URL && postgresEnabled();
const fields = ['description', 'richContent', 'videos', 'color_image', 'videoCoverUrl'];
const schema = [4191, 11254, 7199, 21841, 21837, 21845].map(id => ({ id, is_required: false }));
const normalize = items => normalizeOzonImportItems(items, { strictTypeMatch: true,
  getCategoryAttributes: async () => schema, getCategoryAttributeValues: async () => [] });
const attributeValues = (row, id) => (row.attributes || []).find(attribute => attribute.id === id)?.values;
const complexValues = (row, id) => (row.complex_attributes || []).flatMap(group => group.attributes)
  .find(attribute => attribute.id === id)?.values;

function product(sku, index) {
  const images = [1, 2].map(number => `https://source.example.test/${sku}/${number}.jpg`);
  const description = `<p>Полное описание товара ${sku}. Материал и комплектация сохранены.</p>`;
  const richContent = JSON.stringify({ version: 0.3, content: [
    { widgetName: 'raTextBlock', text: { content: [`Описание ${sku}`] } },
    { widgetName: 'raShowcase', blocks: [{ img: { src: images[0] } }] },
  ] });
  return { sku, name: `Инспекционное зеркало ${sku}`, price: '100', sellPrice: '100', currencyCode: 'CNY',
    images, description, richContent,
    videos: [{ url: `https://source.example.test/${sku}/video.mp4`, coverUrl: `https://source.example.test/${sku}/poster.jpg` }],
    color_image: `https://source.example.test/${sku}/color.jpg`, videoCoverUrl: `https://source.example.test/${sku}/cover.mov`,
    contentDiagnostics: Object.fromEntries(fields.map(field => [field, { status: 'provided', source: 'product_page' }])),
    descriptionCategoryId: 123, typeId: 456,
    logistics: { weightG: 102 + index, lengthMm: 317 + index, widthMm: 304 + index, heightMm: 41 + index },
    sourceCategory: { descriptionCategoryId: 123, typeId: 456, attributes: [
      { key: '7199', values: [{ value: `Металл ${sku}`, dictionary_value_id: 42 + index }] },
      { key: '4191', values: [{ value: description }] },
      { key: '11254', values: [{ value: richContent }] },
    ] },
  };
}

function assertImported(row, source, { generated = false, cleared = false } = {}) {
  assert.ok(row.offer_id.includes(source.sku), 'the import row keeps its own SKU offer');
  assert.deepEqual(row.images, generated
    ? [0, 1].map(index => `https://generated.example.test/${source.sku}/${index}.jpg`) : source.images);
  assert.deepEqual([row.weight, row.depth, row.width, row.height],
    [source.logistics.weightG, source.logistics.lengthMm, source.logistics.widthMm, source.logistics.heightMm]);
  assert.equal(row.weight_unit, 'g');
  assert.equal(row.dimension_unit, 'mm');
  if (cleared) {
    for (const id of [4191, 11254, 7199]) assert.equal(attributeValues(row, id), undefined, `manual clear for ${id}`);
    for (const id of [21841, 21845]) assert.equal(complexValues(row, id), undefined, `manual clear for ${id}`);
    assert.equal(Boolean(row.color_image), false);
    return;
  }
  assert.deepEqual(attributeValues(row, 7199), source.sourceCategory.attributes[0].values);
  assert.equal(attributeValues(row, 4191)?.[0].value, source.description);
  const rich = JSON.parse(attributeValues(row, 11254)?.[0].value);
  assert.equal(rich.content[0].text.content[0], `Описание ${source.sku}`);
  assert.equal(rich.content[1].blocks[0].img.src,
    generated ? `https://generated.example.test/${source.sku}/0.jpg` : source.images[0]);
  assert.deepEqual(complexValues(row, 21841), [{ value: source.videos[0].url }]);
  assert.deepEqual(complexValues(row, 21845), [{ value: source.videoCoverUrl }]);
  assert.equal(row.color_image, source.color_image);
}

test('real PostgreSQL collection retains own-SKU optional content and respects persisted manual clears in direct and AI import', {
  skip: enabled ? false : 'requires SONLI_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL (dedicated test database)',
  timeout: 90000,
}, async t => {
  assert.equal(process.env.DATABASE_URL, process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  process.env.LISTING_PIPELINE_V3 = '1';
  const pool = await getPostgresPool();
  const accountId = `collection-media-${randomUUID()}`;
  const targetStoreId = `media-target-${randomUUID()}`;
  const target = { status: 'MATCHED', method: 'MANUAL', target: { storeId: targetStoreId, descriptionCategoryId: 123, typeId: 456 } };
  const originalFetch = globalThis.fetch;
  let createdAccount = false, externalCalls = 0;
  globalThis.fetch = async () => { externalCalls++; throw Error('external HTTP is forbidden in this PostgreSQL fixture'); };
  const readSaved = async id => {
    const rows = await listCollectItemsV3({ accountId, ids: [id] });
    assert.equal(rows.length, 1);
    assert.deepEqual(await listCollectItemsV3({ accountId: `${accountId}-other`, ids: [id] }), [],
      'the public collection read must not expose another account\'s saved draft');
    return rows[0];
  };
  async function imports(saved) {
    const before = structuredClone(saved);
    const source = buildAiListingSource(saved, targetStoreId, buildCollectBoxListingItems);
    const images = source.items.flatMap(group => group.images.map((_, index) => ({ sku: group.sku, index,
      generatedUrl: `https://generated.example.test/${group.sku}/${index}.jpg` })));
    const direct = (await normalize(buildCollectBoxListingItems(saved, targetStoreId))).items;
    const ai = await prepareAiListingItems({ accountId, source, images,
      config: { targetStoreId, priceAdjustmentKopecks: 0, priceMultiplier: '1', brandMode: 'PREFER_SOURCE' },
    }, { currencyCode: 'CNY' }, { normalizeItems: normalize });
    assert.deepEqual(saved, before, 'preparing imports must not mutate the previously saved draft');
    return { direct, ai };
  }
  try {
    await runMigrations(pool);
    await pool.query("INSERT INTO accounts(id,username,role,status) VALUES($1,$1,'user','active')", [accountId]);
    createdAccount = true;
    for (const grouped of [false, true]) await t.test(grouped ? 'two SKUs and a sibling-only clear' : 'single SKU and a root clear', async () => {
      const originals = grouped ? [product('9100011201', 1), product('9100011202', 2)] : [product('9100011101', 0)];
      const payload = { ...structuredClone(originals[0]), ...(grouped ? { variantData: { variants: structuredClone(originals) } } : {}) };
      const ingested = await ingestCollectRequestV4({ authenticatedAccount: { id: accountId }, input: {
        source: 'ozon', sourceSku: payload.sku, sourceUrl: `https://www.ozon.ru/product/${payload.sku}/`,
        requestId: randomUUID(), payload,
      } });
      assert.ok(ingested.collectItemId);
      let saved = await readSaved(ingested.collectItemId);
      const initialDraft = structuredClone(saved.listingDraft);
      initialDraft.categoryResolution = target;
      await updateCollectItemDraftV4({ collectItemId: saved.id, accountId, expectedVersion: saved.draftVersion,
        patch: { listingDraft: initialDraft } });
      saved = await readSaved(saved.id);
      const persistedRows = grouped ? saved.listingDraft.variants : [saved.listingDraft];
      assert.equal(persistedRows.length, originals.length);
      for (const [index, row] of persistedRows.entries()) {
        for (const field of fields) assert.deepEqual(row[field], originals[index][field], `persisted ${row.sku}: ${field}`);
        assert.deepEqual(row.images, originals[index].images);
        assert.deepEqual(row.contentDiagnostics, originals[index].contentDiagnostics);
      }
      const { direct, ai } = await imports(saved);
      assert.equal(direct.length, originals.length);
      assert.equal(ai.length, originals.length);
      for (const [index, original] of originals.entries()) {
        assertImported(direct[index], original);
        assertImported(ai[index], original, { generated: true });
      }
      const editedDraft = structuredClone(saved.listingDraft);
      const clearIndex = originals.length - 1;
      const clearedRow = grouped ? editedDraft.variants[clearIndex] : editedDraft;
      Object.assign(clearedRow, { description: '', descriptionHTML: '', richContent: '', videos: [], color_image: '',
        videoCoverUrl: '', videoUrl: '', videoCover: '', categoryAttributes: [{ id: 7199, values: [] }],
        contentDiagnostics: Object.fromEntries(fields.map(field => [field, { status: 'not_provided', source: 'manual' }])),
      });
      await updateCollectItemDraftV4({ collectItemId: saved.id, accountId, expectedVersion: saved.draftVersion,
        patch: { listingDraft: editedDraft } });
      const reloaded = await readSaved(saved.id);
      const reloadedClear = grouped ? reloaded.listingDraft.variants[clearIndex] : reloaded.listingDraft;
      assert.deepEqual(reloadedClear.contentDiagnostics, clearedRow.contentDiagnostics);
      assert.equal(reloadedClear.description, '');
      assert.equal(reloaded.description, originals[0].description, 'original source remains available behind the saved edits');
      const after = await imports(reloaded);
      for (const [index, original] of originals.entries()) {
        assertImported(after.direct[index], original, { cleared: index === clearIndex });
        assertImported(after.ai[index], original, { generated: true, cleared: index === clearIndex });
      }
      assert.deepEqual((await readSaved(saved.id)).listingDraft, reloaded.listingDraft, 'read/build/normalize leaves database draft unchanged');
    });
    assert.equal(externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    try {
      if (createdAccount) {
        for (const table of ['collector_ozon_enrichment_jobs', 'collect_requests', 'collect_raw_payloads', 'collect_items'])
          await pool.query(`DELETE FROM ${table} WHERE account_id=$1`, [accountId]);
        await pool.query('DELETE FROM accounts WHERE id=$1', [accountId]);
        assert.equal((await pool.query('SELECT COUNT(*)::int count FROM accounts WHERE id=$1', [accountId])).rows[0].count, 0);
      }
    } finally { await closePostgresPool(); }
  }
});

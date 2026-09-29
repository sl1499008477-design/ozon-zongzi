import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiListingRuntime, loadAiListingCollectSources } from '../ai-listing-runtime.mjs';
import { normalizeAiListingConfig } from '../ai-listing-service.mjs';
import { normalizeOzonImportItems } from '../ozon-import-normalizer.mjs';

const record = {
  id: 'collected-worker-source', sku: '1602438352', name: 'Инспекционное зеркало', currencyCode: 'CNY',
  images: ['https://cdn.example.test/original-one.jpg', 'https://cdn.example.test/original-two.jpg'],
  listingDraft: {
    sku: '1602438352', title: 'Инспекционное зеркало', price: '100', currencyCode: 'CNY',
    packageWeight: 102, packageLength: 317, packageWidth: 304, packageHeight: 41,
    categoryResolution: { status: 'MATCHED', method: 'MANUAL', target: {
      storeId: 'worker-store', descriptionCategoryId: 83250454, typeId: 341100888,
    } },
    sourceCategory: { attributes: [
      { key: '7199', values: [{ dictionary_value_id: 42, value: 'Сталь' }] },
      { key: '4191', values: [{ value: 'Полное описание из сохранённого источника' }] },
    ] },
    videos: [{ url: 'https://cdn.example.test/product.mp4' }],
    color_image: 'https://cdn.example.test/swatch.jpg',
  },
};

test('standalone source loading builds the real import payload without an HTTP-entry builder injection', async () => {
  const before = structuredClone(record);
  const sources = await loadAiListingCollectSources({
    accountId: 'worker-owner', collectItemIds: [record.id], config: { targetStoreId: 'worker-store' },
    pool: { query: async () => ({ rows: [] }) }, readCollectItems: async () => [record],
  });
  const normalized = await normalizeOzonImportItems(sources[0].items.map(item => item.listingItem), { strictTypeMatch: true });
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].offer_id, 'jz-1602438352');
  assert.deepEqual(normalized.items[0].images, ['https://cdn.example.test/original-one.jpg', 'https://cdn.example.test/original-two.jpg']);
  assert.deepEqual([normalized.items[0].weight, normalized.items[0].depth, normalized.items[0].width, normalized.items[0].height], [102, 317, 304, 41]);
  assert.equal(normalized.items[0].attributes.find(attribute => attribute.id === 7199)?.values[0].dictionary_value_id, 42);
  assert.equal(normalized.items[0].attributes.find(attribute => attribute.id === 4191)?.values[0].value, 'Полное описание из сохранённого источника');
  assert.equal(normalized.items[0].complex_attributes.flatMap(group => group.attributes)
    .find(attribute => attribute.id === 21841)?.values[0].value, 'https://cdn.example.test/product.mp4');
  assert.deepEqual(record, before);
});

test('standalone runtime prepares Excel source with its default builder before any image work', async () => {
  let row = {
    id: 'standalone-excel', accountId: 'worker-owner', sourceType: 'EXCEL', sourceId: record.sku,
    source: null, images: [], status: 'QUEUED', config: normalizeAiListingConfig({
      targetStoreId: 'worker-store', targetWarehouseId: 'worker-warehouse',
    }), createdAt: 1, updatedAt: 1, nextRunAt: 1, version: 1,
  };
  let claimed = false;
  const runtime = createAiListingRuntime({
    resolvePool: async () => ({ query: async () => ({ rows: [] }) }),
    repository: {
      get: async () => structuredClone(row),
      claimNext: async ({ leaseToken }) => {
        if (claimed) return null;
        claimed = true; row.leaseToken = leaseToken;
        return structuredClone(row);
      },
      save: async ({ task, releaseLease }) => {
        row = { ...structuredClone(task), version: row.version + 1,
          leaseToken: releaseLease ? null : task.leaseToken };
        return structuredClone(row);
      },
    },
    checkAccount: async () => ({ id: 'worker-owner', role: 'admin', status: 'active' }),
    validateTarget: async () => ({}), collectSku: async () => ({ item: structuredClone(record) }),
    generateImage: async () => assert.fail('preparation must not start paid generation'),
  });
  try { await runtime.start({ mode: 'prepare' }); }
  finally { await runtime.stop(); }
  assert.equal(row.status, 'GENERATING', row.errorMessage);
  assert.equal(row.source.collectItemId, record.id);
  assert.equal(row.source.items[0].listingItem.scraped_sku, '1602438352');
  assert.equal(row.source.items[0].listingItem.weight, 102);
  assert.equal(row.images.length, 2);
  assert.equal(row.leaseToken, null);
});

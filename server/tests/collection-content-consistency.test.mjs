import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCollectRequestV4 } from '../collection-pipeline.mjs';
import { buildCollectItemDraftV4 } from '../listing-pipeline.mjs';
import { buildAiListingSource } from '../ai-listing-runtime.mjs';
import { prepareAiListingItems } from '../ai-listing-submission.mjs';
import { normalizeOzonImportItems } from '../ozon-import-normalizer.mjs';
import { testExports } from '../index.mjs';

const target = { status: 'MATCHED', method: 'MANUAL', target: { storeId: 'target', descriptionCategoryId: 123, typeId: 456 } };
const config = { targetStoreId: 'target', priceAdjustmentKopecks: 0, priceMultiplier: '1', brandMode: 'PREFER_SOURCE' };
const fields = ['description', 'richContent', 'videos', 'color_image', 'videoCoverUrl'];
const product = sku => ({ sku, name: 'Инспекционное зеркало', price: '100', sellPrice: '100', currencyCode: 'CNY',
  images: [`https://cdn.example.test/${sku}/1.jpg`, `https://cdn.example.test/${sku}/2.jpg`],
  description: '<p>Полное описание зеркала</p>',
  richContent: JSON.stringify({ content: [{ widgetName: 'raTextBlock', text: { content: [`Описание ${sku}`] } }], version: 0.3 }),
  videos: [{ url: `https://cdn.example.test/${sku}/video.mp4`, coverUrl: `https://cdn.example.test/${sku}/poster.jpg` }],
  color_image: `https://cdn.example.test/${sku}/color.jpg`, videoCoverUrl: `https://cdn.example.test/${sku}/cover.mp4`,
  contentDiagnostics: Object.fromEntries(fields.map(key => [key, { status: 'provided', source: 'product_page' }])),
  packageWeight: 102, packageLength: 317, packageWidth: 304, packageHeight: 41,
  sourceCategory: { attributes: [{ key: '7199', values: [{ value: 'Металл', dictionary_value_id: 42 }] }] },
});
const normalize = items => normalizeOzonImportItems(items, { strictTypeMatch: true,
  getCategoryAttributes: async () => [4191, 11254, 7199, 21841, 21837, 21845].map(id => ({ id, is_required: false })),
});
function savedProduct(payload) {
  const row = prepareCollectRequestV4({ authenticatedAccount: { id: 'media-owner' }, input: {
    source: 'ozon', sourceSku: payload.sku, requestId: 'media-request', payload,
  } }).normalizedItem;
  row.categoryResolution = target;
  row.listingDraft = buildCollectItemDraftV4(row);
  return JSON.parse(JSON.stringify(row));
}
async function aiBody(saved) {
  const source = buildAiListingSource(saved, 'target', testExports.buildCollectBoxListingItems);
  const images = source.items.flatMap(group => group.images.map((_, index) => ({ sku: group.sku, index,
    generatedUrl: `https://generated.example.test/${group.sku}/${index}.jpg` })));
  return prepareAiListingItems({ source, images, config }, { currencyCode: 'CNY' }, { normalizeItems: normalize });
}

test('root and per-SKU ingress preserve provided optional media through saved draft, direct and AI import fields', async () => {
  for (const grouped of [false, true]) {
    const payload = product('1602438352');
    if (grouped) payload.variants = [structuredClone(payload), product('2258957029')];
    const saved = savedProduct(payload), before = structuredClone(saved);
    const direct = (await normalize(testExports.buildCollectBoxListingItems(saved, 'target'))).items;
    const generated = await aiBody(saved);
    const expected = grouped ? payload.variants : [payload];
    for (const [i, source] of expected.entries()) for (const result of [direct[i], generated[i]]) {
      assert.equal(result.color_image, source.color_image);
      assert.equal(result.attributes.find(attr => attr.id === 7199)?.values[0].dictionary_value_id, 42);
      assert.equal(result.attributes.find(attr => attr.id === 11254)?.values[0].value, source.richContent);
      const media = result.complex_attributes.flatMap(group => group.attributes);
      assert.equal(media.find(attr => attr.id === 21841)?.values[0].value, source.videos[0].url);
      assert.equal(media.find(attr => attr.id === 21845)?.values[0].value, source.videoCoverUrl);
      assert.equal(result.weight, 102);
    }
    assert.deepEqual(saved, before);
  }
});

test('root rich-content and video clears survive direct and AI generation without reviving retained raw content', async () => {
  const saved = savedProduct(product('1602438352'));
  Object.assign(saved.listingDraft, { richContent: '', videos: [], videoCoverUrl: '', color_image: '', videoUrl: '', videoCover: '' });
  for (const field of ['richContent', 'videos', 'videoCoverUrl', 'color_image']) saved.listingDraft.contentDiagnostics[field] = { status: 'not_provided', source: 'manual' };
  const rows = testExports.buildCollectBoxListingItems(saved, 'target');
  assert.equal(rows[0].richContent, '', 'the builder must carry a saved clear to the normalizer');
  for (const result of [(await normalize(rows)).items[0], (await aiBody(saved))[0]]) {
    assert.equal(result.attributes.some(attr => attr.id === 11254), false);
    assert.equal(Boolean(result.color_image), false);
    assert.equal((result.complex_attributes || []).flatMap(group => group.attributes).some(attr => [21841,21845].includes(attr.id)), false);
  }
});

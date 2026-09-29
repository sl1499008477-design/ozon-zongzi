import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCollectBoxListingItems } from '../collect-box-listing-items.mjs';
import { mergeSkuEnrichment } from '../collect-enrichment-recovery.mjs';
import { normalizeOzonAgentResult } from '../collector-ozon-enrichment-contract.mjs';
import { normalizeOzonImportItems } from '../ozon-import-normalizer.mjs';

test('single-SKU listing consumes enriched attributes despite an earlier partial buyer snapshot', () => {
  const result = normalizeOzonAgentResult({ sku: '1602438352', variantData: {
    description_category_id: 83250454, type_id: 341100888, weight: 102, depth: 317, width: 304, height: 41,
    attributes: [
      { key: '8229', values: [{ value: 'Зеркало', dictionary_value_id: 341100888 }] },
      { key: '9024', values: [{ value: 'GLA1892' }] },
      { key: '85', values: [{ value: 'Без бренда', dictionary_value_id: 123 }] },
    ],
  } });
  const partial = { attributes: [{ key: '11254', value: '{"content":[]}' }], videos: [{ url: 'https://example.test/video.mp4' }] };
  const draft = mergeSkuEnrichment({ sku: '1602438352', categoryAttributes: [{ id: 85, values: [] }] }, result);
  const item = { sku: '1602438352', variantData: partial, listingDraft: draft };
  const before = structuredClone(item);
  const [row] = buildCollectBoxListingItems(item);
  assert.equal(row.offer_id, 'GLA1892');
  assert.equal(row._sourceVariant.attributes.find(a => a.key === '8229').values[0].dictionary_value_id, 341100888);
  assert.equal(row._sourceVariant.attributes.find(a => a.key === '11254').value, '{"content":[]}');
  assert.deepEqual(row._sourceVariant.videos, partial.videos);
  assert.deepEqual(row.attributes.find(a => a.id === 85).values, [], 'explicit user clearing stays authoritative');
  assert.deepEqual([row.weight, row.depth, row.width, row.height], [102, 317, 304, 41]);
  assert.deepEqual(item, before, 'reading an item does not mutate persisted data');
});

test('enriched attributes fill only missing IDs and never leak from the anchor into siblings', () => {
  const item = { sku: '1', variantData: { attributes: [{ key: '9024', values: [] }] }, listingDraft: {
    sku: '1', sourceCategory: { descriptionCategoryId: 123, attributes: [{ key: '9024', value: 'anchor-article' }] },
    variants: [
      { sku: '1' },
      { sku: '2', sourceVariant: { attributes: [{ key: '10096', values: [] }] }, sourceCategory: { attributes: [
        { key: '10096', value: 'Красный' }, { key: '9024', value: 'own-article' },
      ] } },
      { sku: '3' },
    ],
  } };
  const rows = buildCollectBoxListingItems(item);
  assert.deepEqual(rows[0]._sourceVariant.attributes.find(a => a.key === '9024').values, []);
  assert.equal(rows[1].offer_id, 'own-article');
  assert.deepEqual(rows[1]._sourceVariant.attributes.find(a => a.key === '10096').values, []);
  assert.ok(!rows[2]._sourceVariant.attributes?.some(a => a.key === '9024'));
  assert.notEqual(rows[2].offer_id, 'anchor-article');
});

test('historical empty attribute placeholders accept enriched values but explicit value arrays remain authoritative', () => {
  for (const placeholder of [{ key: '9024' }, { key: '9024', value: '' }, { key: '9024', value: null }]) {
    const item = { sku: '1602438352', variantData: { attributes: [placeholder] }, listingDraft: {
      sourceCategory: { attributes: [{ key: '9024', values: [{ value: 'GLA1892' }] }] },
    } };
    assert.equal(buildCollectBoxListingItems(item)[0].offer_id, 'GLA1892');
  }
});

test('search snapshot text consumes matching enriched dictionary IDs before listing without another dictionary lookup', async () => {
  const item = { sku: '2099894613', variantData: { attributes: [{ key: '85', value: 'Belz' }] }, listingDraft: {
    logistics: { weightG: 6600, lengthMm: 820, widthMm: 390, heightMm: 125 },
    sourceCategory: { attributes: [{ key: '85', values: [{ value: 'Belz', dictionary_value_id: 971410541 }] }] },
  } };
  const before = structuredClone(item);
  const [row] = buildCollectBoxListingItems(item);
  const brand = row._sourceVariant.attributes.find(a => a.key === '85');
  assert.deepEqual(brand.values, [{ value: 'Belz', dictionary_value_id: 971410541 }]);
  let dictionaryReads = 0;
  const result = await normalizeOzonImportItems([{ ...row, description_category_id: 64766017, type_id: 94630 }], {
    getCategoryAttributes: async () => [{ id: 85, is_required: true, dictionary_id: 287 }],
    getCategoryAttributeValues: async () => { dictionaryReads++; throw Error('Unexpected repeat brand lookup'); },
  });
  assert.equal(result.items[0].attributes.find(a => a.id === 85).values[0].dictionary_value_id, 971410541);
  assert.equal(dictionaryReads, 0);
  assert.deepEqual(item, before);
});

test('dictionary completion preserves conflicting text, supplied IDs, explicit arrays and each SKU scope', () => {
  const variants = [
    { sku: '1', sourceVariant: { attributes: [{ key: '85', value: 'Changed brand' }] } },
    { sku: '2', sourceVariant: { attributes: [{ key: '85', value: 'Belz', dictionary_value_id: 10 }] } },
    { sku: '3', sourceVariant: { attributes: [{ key: '85', values: [] }] } },
    { sku: '4', sourceVariant: { attributes: [{ key: '85', values: [{ value: 'Belz' }] }] } },
    { sku: '5', sourceVariant: { attributes: [{ key: '85', value: 'Belz' }] } },
  ];
  for (const variant of variants.slice(0, 4)) variant.sourceCategory = {
    attributes: [{ key: '85', values: [{ value: 'Belz', dictionary_value_id: 971410541 }] }],
  };
  const item = { sku: '1', listingDraft: { sourceCategory: variants[0].sourceCategory, variants } };
  const before = structuredClone(item);
  const rows = buildCollectBoxListingItems(item);
  for (const [index, row] of rows.entries()) assert.deepEqual(row._sourceVariant.attributes, variants[index].sourceVariant.attributes);
  assert.deepEqual(item, before);
});

test('dictionary completion compares legacy name/title text and never treats missing text as agreement', () => {
  for (const alias of ['name', 'title']) for (const enriched of [
    { dictionary_value_id: 971410541 },
    { [alias]: 'Other brand', dictionary_value_id: 971410541 },
  ]) {
    const original = { key: '85', collection: [{ [alias]: 'Edited brand' }] };
    const item = { sku: '2099894613', variantData: { attributes: [original] }, listingDraft: {
      sourceCategory: { attributes: [{ key: '85', values: [enriched] }] },
    } };
    assert.deepEqual(buildCollectBoxListingItems(item)[0]._sourceVariant.attributes, [original]);
  }
});

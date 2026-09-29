import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOzonImportItems } from '../ozon-import-normalizer.mjs';
import { createAutoListingListingBasePreparer } from '../auto-listing-listing-base-preparer.mjs';

const china = { id: 4389, complex_id: 0, values: [{ dictionary_value_id: 90296, value: 'Китай' }] };
const russia = { id: 4389, values: [{ dictionary_value_id: 90295, value: 'Россия' }] };
const countryMetadata = { id: 4389, name: 'Страна-изготовитель', dictionary_id: 1935, is_required: false };
const item = (overrides = {}) => ({
  offer_id: 'country-test', scraped_sku: 'source-country-test', name: 'Товар', price: '100.00',
  currency_code: 'CNY', description_category_id: 48159484, type_id: 970856518,
  weight: 500, depth: 200, width: 100, height: 50, images: ['https://example.test/image.jpg'], ...overrides,
});

test('all new listing variants use China regardless of source, draft, bundle or missing country', async () => {
  const inputs = [
    item({ model_name: 'unchanged-model', attributes: [russia, { id: 9048, values: [{ value: 'unchanged-model' }] }] }),
    item({ attributes: [{ id: 4389, values: [] }], _sourceVariant: { attributes: [{ key: '4389', values: russia.values }] } }),
    item({ _bundleItem: { attributes: [russia] } }),
    item(),
  ];
  const before = structuredClone(inputs);
  const result = await normalizeOzonImportItems(inputs, { strictTypeMatch: true,
    getCategoryAttributes: async () => [countryMetadata, { id: 9048 }],
    getCategoryAttributeValues: async () => { assert.fail('verified country ID needs no per-SKU dictionary request'); },
  });
  assert.equal(result.items.length, inputs.length);
  for (const product of result.items) {
    assert.deepEqual(product.attributes.filter(a => a.id === 4389), [china]);
    assert.equal(product.price, '100.00');
    assert.deepEqual(product.images, inputs[0].images);
  }
  assert.equal(result.items[0].attributes.find(a => a.id === 9048).values[0].value, 'unchanged-model');
  assert.deepEqual(inputs, before, 'collected facts remain intact');
});

test('country default respects category support and strict metadata validation', async () => {
  const unsupported = await normalizeOzonImportItems([item({ attributes: [russia] })], {
    strictTypeMatch: true, getCategoryAttributes: async () => [{ id: 9048 }],
  });
  assert.equal(unsupported.items[0].attributes.some(a => a.id === 4389), false);
  const strict = await normalizeOzonImportItems([item({ _sourceVariant: { attributes: [russia] } })], {
    strictTypeMatch: true, categoryMatchPolicy: 'SOURCE_CATEGORY_STRICT',
    sourceCategory: { kind: 'UNIQUE_MATCH', descriptionCategoryId: 48159484, typeId: 970856518 },
    currentCategoryMetadata: { descriptionCategoryId: 48159484, typeId: 970856518, attributes: [
      { id: 4389, complexId: 0, required: false, dictionaryId: 1935,
        dictionaryValues: [{ id: 90295, value: 'Россия' }, { id: 90296, value: 'Китай' }] },
    ] },
  });
  assert.deepEqual(strict.items[0].attributes, [china]);
});

test('automatic listing preparation and category rebuild keep China for every variant', async () => {
  const rawItems = [item({ offer_id: 'with-russia', sku: 'source-russia', attributes: [russia] }),
    item({ offer_id: 'without-country', sku: 'source-empty' })];
  const original = structuredClone(rawItems);
  const dictionaryQueries = [];
  const prepare = createAutoListingListingBasePreparer({
    loadStoreAccess: async () => ({ id: 'store', ownerAccountId: 'account', clientId: 'fixture', apiKey: 'fixture', currencyCode: 'CNY' }),
    buildRawItems: () => rawItems,
    categoryService: {
      getCategoryAttributes: async () => ({ items: [countryMetadata] }),
      getCategoryAttributeValues: async input => {
        dictionaryQueries.push(input);
        return { items: [{ id: 90295, value: 'Россия' }, { id: 90296, value: 'Китай' }] };
      },
    },
  });
  const result = await prepare({
    accountId: 'account', targetStore: { id: 'store', ownerAccountId: 'account' },
    source: { productDraft: { id: 'draft', version: 1, dataHash: '1'.repeat(64) } },
    targetCategory: { schemaVersion: 'AUTO_LISTING_ACCOUNT_CATEGORY_V2', evidenceId: 'evidence',
      sharedCategoryId: 'shared', sharedCategoryVersion: 1, sourceDescriptionCategoryId: 48159484,
      sourceTypeId: 970856518, descriptionCategoryId: 48159484, typeId: 970856518,
      taxonomyScope: 'OZON:DEFAULT', taxonomyFingerprint: '', provenance: 'MANUAL' },
    pricingEvidence: { currency: 'CNY', currencySource: 'TARGET_STORE', blackKopecks: '10000', greenKopecks: null },
  });
  assert.equal(result.variants.length, 2);
  for (const variant of result.variants) assert.deepEqual(variant.item.attributes, [china]);
  assert.equal(dictionaryQueries.length, 1);
  assert.ok(dictionaryQueries[0].matchCandidates.some(c => c.id === 90296 || c.value === 'Китай'));
  assert.deepEqual(rawItems, original);
});

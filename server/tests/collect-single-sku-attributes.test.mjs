import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { addSelectedCollectorItemsToCollectBox } from '../collector-selection-service.mjs';
import { prepareCollectRequestV4 } from '../collection-pipeline.mjs';
import { buildCollectItemDraftV4 } from '../listing-pipeline.mjs';
import { normalizeOzonAgentResult } from '../collector-ozon-enrichment-contract.mjs';
import { mergeSkuEnrichment } from '../collect-enrichment-recovery.mjs';
import { buildAiListingSource } from '../ai-listing-runtime.mjs';
import { prepareAiListingItems } from '../ai-listing-submission.mjs';
import { normalizeOzonImportItems } from '../ozon-import-normalizer.mjs';
import { testExports } from '../index.mjs';

// Representative saved desktop product; no live SKU or remote writes are used.
const ordinary = Array.from({ length: 110 }, (_, index) => ({ key: String(6000 + index),
  values: [{ value: 'Значение', dictionary_value_id: 7000 + index }] }));
ordinary[1].values = [{ value: 'Синий', dictionary_value_id: 777 }, { dictionary_value_id: 778 }];
const target = { status: 'MATCHED', method: 'MANUAL', target: { storeId: 'target', descriptionCategoryId: 123, typeId: 456 } };
const copyForStorage = value => JSON.parse(JSON.stringify(value));

async function savedDesktopItem(complexAttributes) {
  let item;
  const selected = await addSelectedCollectorItemsToCollectBox({ accountId: 'single-account', runId: 'desktop-run', itemIds: ['desktop-item'] }, {
    getCollectorRunForAccount: async (accountId, id) => ({ accountId, id }),
    listCollectorRunItems: async () => [{ id: 'desktop-item', source: 'ozon', sourceSku: 'single-own', rawPayload: {
      sku: 'single-own', name: 'Светильник', price: '100', currencyCode: 'CNY',
      images: Array.from({ length: 7 }, (_, index) => `https://cdn.example.test/own/${index}.jpg`),
      description: 'Полное описание светильника',
    } }],
    ingestCollectRequestV4: async request => {
      assert.equal(Object.hasOwn(request.input.payload, 'variants'), false, 'real desktop collectPayload must not synthesize variants');
      const prepared = prepareCollectRequestV4(request);
      item = copyForStorage(prepared.normalizedItem);
      item.categoryResolution = target;
      item.listingDraft = buildCollectItemDraftV4(item);
      assert.deepEqual(item.listingDraft.variants, []);
      return { collectItemId: item.id, requestId: prepared.persistedRequestId, duplicate: false };
    },
    linkCollectorItem: async () => {},
  });
  assert.equal(selected.added, 1);
  const enrichment = normalizeOzonAgentResult({ sku: 'single-own', variantData: {
    description_category_id: 123, type_id: 456, weight: 500, depth: 300, width: 200, height: 100, attributes: ordinary,
    ...(complexAttributes ? { complex_attributes: complexAttributes } : {}),
  } });
  item.listingDraft = mergeSkuEnrichment(item.listingDraft, enrichment);
  return copyForStorage(item);
}

async function importBodyFor(item) {
  const source = buildAiListingSource(item, 'target', testExports.buildCollectBoxListingItems);
  const generated = source.items.flatMap(group => group.images.map((_, index) => ({ sku: group.sku, index,
    generatedUrl: `https://cdn.example.test/generated/${group.sku}/${index}.jpg` })));
  const items = await prepareAiListingItems({ accountId: 'single-account', source, images: generated,
    config: { stock: 5, priceAdjustmentKopecks: -1000, priceMultiplier: '5', brandMode: 'PREFER_SOURCE' },
  }, { currencyCode: 'CNY' }, {
    normalizeItems: rows => normalizeOzonImportItems(rows, { strictTypeMatch: true,
      getCategoryAttributes: async () => [...ordinary.map(attr => Number(attr.key)), 300, 4191, 9048, 21841, 21837].map(id => ({ id })),
      getCategoryAttributeValues: async () => [],
    }),
  });
  return { source, body: copyForStorage({ items }) };
}

const ordinaryAttributes = item => item.attributes.filter(attr => attr.id >= 6000 && attr.id < 6110);

test('desktop single SKU without variants keeps all 110 saved Seller attributes through AI import body', async () => {
  const saved = await savedDesktopItem();
  const before = structuredClone(saved);
  assert.equal(saved.accountId, 'single-account');
  assert.deepEqual(saved.listingDraft.variants, []);
  assert.deepEqual(saved.listingDraft.sourceCategory.attributes.map(({ key, values }) => ({ key, values })), ordinary);
  const { source, body } = await importBodyFor(saved);
  assert.equal(ordinaryAttributes(body.items[0]).length, 110);
  for (const expected of ordinary) {
    assert.deepEqual(body.items[0].attributes.find(attr => attr.id === Number(expected.key)).values, expected.values);
  }
  assert.deepEqual(source.items[0].listingItem._sourceVariant.attributes, saved.listingDraft.sourceCategory.attributes);
  assert.deepEqual(source.items[0].images, saved.images);
  assert.equal(body.items[0].images.length, 7);
  assert.equal(body.items[0].price, '450.00');
  assert.deepEqual(saved, before, 'reading a saved source must not alter its persisted draft');
});

test('single-SKU manual values and per-attribute empty arrays override retained Seller evidence', async () => {
  const saved = await savedDesktopItem();
  saved.attributes = [{ id: 6001, values: [{ value: 'Устаревший', dictionary_value_id: 999 }] }];
  saved.listingDraft.categoryAttributes = [
    { id: 6001, values: [{ value: 'Ручной', dictionary_value_id: 20001 }] },
    { id: 6002, values: [] },
  ];
  const before = structuredClone(saved);
  const { source, body } = await importBodyFor(saved);
  assert.deepEqual(body.items[0].attributes.find(attr => attr.id === 6001).values, saved.listingDraft.categoryAttributes[0].values);
  assert.equal(body.items[0].attributes.some(attr => attr.id === 6002), false, 'manual clear must not revive a source dictionary ID');
  assert.deepEqual(body.items[0].attributes.find(attr => attr.id === 6109)?.values, ordinary[109].values);
  assert.deepEqual(source.items[0].listingItem.attributes.find(attr => attr.id === 6002).values, []);
  assert.deepEqual(saved, before);
});

test('an explicitly empty draft edit array is not replaced by historical item attributes', async () => {
  const saved = await savedDesktopItem();
  saved.attributes = [{ id: 6001, values: [{ value: 'Устаревший', dictionary_value_id: 999 }] }];
  saved.listingDraft.categoryAttributes = [];
  const [row] = testExports.buildCollectBoxListingItems(saved, 'target');
  assert.deepEqual(row.attributes, []);
});

test('existing per-variant source carriers keep precedence and siblings never borrow anchor draft attributes', async () => {
  const saved = await savedDesktopItem();
  const ownSource = { sku: 'single-own', attributes: [{ key: '6001', values: [{ value: 'Красный', dictionary_value_id: 8101 }] }] };
  const siblingSource = { sku: 'sibling', attributes: [{ key: '6001', values: [{ value: 'Белый', dictionary_value_id: 8102 }] }] };
  saved.listingDraft.variants = [ownSource, siblingSource].map(source => ({ sku: source.sku, name: 'Светильник',
    sellPrice: '100', currencyCode: 'CNY', images: [`https://cdn.example.test/${source.sku}.jpg`], sourceVariant: source,
    packageWeight: 500, packageLength: 300, packageWidth: 200, packageHeight: 100,
  }));
  const rows = testExports.buildCollectBoxListingItems(saved, 'target');
  assert.strictEqual(rows[0]._sourceVariant, ownSource);
  assert.strictEqual(rows[1]._sourceVariant, siblingSource);
  const { body } = await importBodyFor(saved);
  assert.deepEqual(body.items.map(item => ordinaryAttributes(item).map(attr => attr.values)), [
    [ownSource.attributes[0].values], [siblingSource.attributes[0].values],
  ]);
  delete saved.listingDraft.variants[1].sourceVariant;
  const missing = testExports.buildCollectBoxListingItems(saved, 'target')[1];
  assert.deepEqual(missing._sourceVariant, {});
  assert.deepEqual(missing.attributes, []);
  saved.listingDraft.variants = [];
  const legacySource = { attributes: [{ key: '4195', values: [{ value: 'https://cdn.example.test/legacy-detail.jpg' }] }] };
  saved._sourceVariant = legacySource;
  const [legacyRow] = testExports.buildCollectBoxListingItems(saved, 'target');
  assert.strictEqual(legacyRow._sourceVariant, legacySource);
  assert.ok(legacyRow.images.includes('https://cdn.example.test/legacy-detail.jpg'), 'existing source galleries keep their prior fallback');
});


test('single-SKU complex groups survive final direct and AI payloads while explicit draft clears stay empty', async () => {
  const groups = [
    { attributes: [{ id: 21841, complex_id: 100001, values: [{ value: 'https://cdn.example.test/own/video.mp4' }] },
      { id: 21837, complex_id: 100001, values: [{ value: 'Видео товара' }] }] },
    { attributes: [{ id: 300, complex_id: 77, values: [{ value: 'Первый', dictionary_value_id: 901 }] }] },
    { attributes: [{ id: 300, complex_id: 77, values: [{ dictionary_value_id: 902 }] }] },
  ];
  const saved = await savedDesktopItem(groups);
  assert.deepEqual(saved.listingDraft.complex_attributes, groups);
  // AI already restores root groups during preparation; a builder's empty top-level array alone is not data loss.
  assert.deepEqual((await importBodyFor(saved)).body.items[0].complex_attributes, groups);
  const direct = await normalizeOzonImportItems(testExports.buildCollectBoxListingItems(saved, 'target'), { strictTypeMatch: true });
  assert.deepEqual(direct.items[0].complex_attributes, groups);
  saved.listingDraft.complex_attributes = [];
  assert.deepEqual(saved.listingDraft.sourceCategory.complex_attributes, groups, 'historical source evidence remains for traceability');
  assert.deepEqual((await importBodyFor(saved)).body.items[0].complex_attributes || [], []);
  const cleared = await normalizeOzonImportItems(testExports.buildCollectBoxListingItems(saved, 'target'), { strictTypeMatch: true });
  assert.deepEqual(cleared.items[0].complex_attributes || [], []);
});

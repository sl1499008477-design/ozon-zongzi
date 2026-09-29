// Read-only reproduction of FORCE_NO_BRAND publication defects.
// Run: node --test server/tests/ai-listing-no-brand-publication.test.mjs
// No DB, network, filesystem writes, or external publication occurs.
// Regression coverage for the real preparation and normalization pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAiListingItems } from '../ai-listing-submission.mjs';
import { normalizeOzonImportItems } from '../ozon-import-normalizer.mjs';
import { buildCollectBoxListingItems } from '../collect-box-listing-items.mjs';

const input = () => ({
  accountId: 'review-account',
  config: { stock: 5, priceAdjustmentKopecks: 0, priceMultiplier: '1', brandMode: 'FORCE_NO_BRAND' },
  source: { sku: 'sku', sourceSnapshot: { currency: 'RUB', blackPrice: '100', greenPrice: '80' }, items: [{
    sku: 'sku', images: ['https://original.test/a.jpg'], listingItem: {
      scraped_sku: 'sku', offer_id: 'offer', name: 'Пылесос Xiaomi', brand: 'Xiaomi',
      price: '100', currency_code: 'RUB', description_category_id: 10, type_id: 20,
      weight: 100, depth: 100, width: 100, height: 100,
      attributes: [{ id: 85, values: [{ value: 'Xiaomi', dictionary_value_id: 88 }] }],
    },
  }] },
  images: [{ sku: 'sku', index: 0, generatedUrl: 'https://generated.test/a.jpg' }],
});
const ids = [85, 4180, 4191, 23171, 11254, 21837, 21841];
const options = {
  resolveNoBrand: async () => ({ dictionary_value_id: 777, value: 'Нет бренда' }),
  normalizeItems: items => normalizeOzonImportItems(items, {
    strictTypeMatch: true,
    getCategoryTree: async () => [{ description_category_id: 10, children: [{ type_id: 20 }] }],
    getCategoryAttributes: async () => ids.map(id => ({ id })),
  }),
};
const attr = (item, id) => item.attributes.find(value => value.id === id)?.values;
async function publish(data) {
  const before = structuredClone(data);
  const [result] = await prepareAiListingItems(data, { currencyCode: 'RUB' }, options);
  assert.deepEqual(data, before, 'source input must remain unchanged');
  assert.deepEqual(result.images, ['https://generated.test/a.jpg']);
  assert.equal(attr(result, 85)[0].value, 'Нет бренда');
  return result;
}

// normalizeAttributeValues currently accepts strings plus value/name/title.
// The helper only cleans value.value. The fourth case is more subtle: empty
// cleaned value falls back to the original name in the normalizer.
for (const [label, values] of [
  ['name fallback', [{ name: 'Пылесос Xiaomi 120 Вт' }]],
  ['title fallback', [{ title: 'Пылесос Xiaomi 120 Вт' }]],
  ['primitive string', ['Пылесос Xiaomi 120 Вт']],
  ['empty value revives original name', [{ value: 'Xiaomi', name: 'Xiaomi' }]],
]) {
  test(`description cleaning accepts ${label}`, async () => {
    const data = input();
    data.source.items[0].listingItem.attributes.push({ id: 4191, values });
    const result = await publish(data);
    assert.doesNotMatch(JSON.stringify(attr(result, 4191) || []), /xiaomi/i);
    if (label !== 'empty value revives original name') assert.match(attr(result, 4191)[0].value, /120 Вт/);
  });
}

test('attributeId is a supported attribute identity in the final normalizer', async () => {
  const data = input();
  data.source.items[0].listingItem.attributes.push({ attributeId: 4191, values: [{ value: 'Пылесос Xiaomi 120 Вт' }] });
  assert.equal(attr(await publish(data), 4191)[0].value, 'Пылесос 120 Вт');
});

for (const [label, text] of [
  ['split across inline tags', 'Xia<b>omi</b>'],
  ['encoded with a numeric HTML entity', 'Xi&#97;omi'],
]) {
  test(`description removes a brand ${label}`, async () => {
    const data = input();
    data.source.items[0].listingItem.descriptionHTML = `<p>Пылесос ${text}, мощность 120 Вт</p>`;
    assert.equal(attr(await publish(data), 4191)[0].value, '<p>Пылесос, мощность 120 Вт</p>');
  });
}

test('rich text cleanup preserves media URLs embedded in an HTML string', async () => {
  const data = input();
  const url = 'https://cdn.example/Xiaomi.jpg';
  data.source.items[0].listingItem.richContent = JSON.stringify({ version: 0.3, content: [{
    widgetName: 'raTextBlock', text: { content: [`<p>Xiaomi <img src="${url}"/></p>`] },
  }] });
  const rich = JSON.parse(attr(await publish(data), 11254)[0].value);
  const html = rich.content[0].text.content[0];
  assert.ok(html.includes(url), `media URL changed: ${html}`);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /xiaomi/i);
});

test('removing a comma-separated brand hashtag preserves the adjacent ordinary hashtag', async () => {
  const data = input();
  data.source.items[0].listingItem.attributes.push({ id: 23171, values: [{ value: '#xiaomi,#пылесос' }] });
  assert.equal(attr(await publish(data), 23171)?.[0].value, '#пылесос');
});

test('a brand-only first video title does not shift the remaining video title onto the first URL', async () => {
  const data = input();
  const urls = ['https://cdn.example/a.mp4', 'https://cdn.example/b.mp4'];
  data.source.items[0].listingItem.complex_attributes = [{ attributes: [
    { complex_id: 100001, id: 21841, values: urls.map(value => ({ value })) },
    { complex_id: 100001, id: 21837, values: [{ value: 'Xiaomi' }, { value: 'Второе видео' }] },
  ] }];
  const result = await publish(data);
  const attributes = result.complex_attributes[0].attributes;
  const names = attributes.find(value => value.id === 21837)?.values.map(value => value.value) || [];
  assert.deepEqual(attributes.find(value => value.id === 21841).values.map(value => value.value), urls);
  assert.equal(names.length, urls.length, `video title positions were lost: ${JSON.stringify(names)}`);
  assert.equal(names[1], 'Второе видео');
  assert.ok(names[0], 'use a neutral fallback such as Видео 1 when cleaning erases an entire title');
  assert.doesNotMatch(names[0], /xiaomi/i);
});

test('the collected root brand is used when the listing projection lacks a brand attribute', async () => {
  const data = input();
  const raw = { sku: 'sku', brand: 'Xiaomi', name: 'Пылесос Xiaomi', currency: 'RUB', currency_code: 'RUB',
    blackPrice: '100', greenPrice: '80', images: ['https://original.test/a.jpg'],
    listingDraft: { currencyCode: 'RUB', packageWeight: 100, packageLength: 100, packageWidth: 100, packageHeight: 100 },
  };
  const [listingItem] = buildCollectBoxListingItems(raw, 'store');
  Object.assign(listingItem, { description_category_id: 10, type_id: 20 });
  data.source.sourceSnapshot = raw;
  data.source.items[0].listingItem = listingItem;
  assert.equal((await publish(data)).name, 'Пылесос');
});

test('encoded brand text is removed without decoding or rewriting HTML media attributes', async () => {
  const data = input();
  const item = data.source.items[0].listingItem;
  item.brand = "L'Oréal";
  item.attributes = [];
  item.descriptionHTML = '<p>Косметика L&#39;Or&eacute;al</p>';
  const url = 'https://cdn.example/Xiaomi.jpg?x=1&amp;y=2';
  item.richContent = JSON.stringify({version: 0.3, content: [{widgetName: 'raTextBlock', text: {
    content: [`<p>L'Or<b>&eacute;al</b> <img src="${url}" title="2 > 1"/></p>`],
  }}]});
  const result = await publish(data);
  assert.equal(attr(result, 4191)[0].value, '<p>Косметика </p>');
  const rich = JSON.parse(attr(result, 11254)[0].value).content[0].text.content[0];
  assert.ok(rich.includes(url));
  assert.ok(rich.includes('title="2 > 1"'));
  assert.doesNotMatch(rich, /Or|&eacute;al/);
});

test('each SKU uses its own source brand, preserving another brand used as an ordinary word', async () => {
  const data = input();
  const first = data.source.items[0];
  first.listingItem.name = 'Пылесос Xiaomi Nova';
  const second = structuredClone(first);
  second.sku = 'sku2';
  second.listingItem.scraped_sku = 'sku2';
  second.listingItem.offer_id = 'offer2';
  second.listingItem.name = 'Пылесос Nova';
  second.listingItem.brand = 'Nova';
  second.listingItem.attributes = [{id: 85, values: [{value: 'Nova'}]}];
  second.listingItem._sourceVariant = {brand: 'Nova', blackPrice: '100', greenPrice: '80', currency: 'RUB'};
  data.source.items.push(second);
  data.images.push({sku: 'sku2', index: 0, generatedUrl: 'https://generated.test/b.jpg'});
  const before = structuredClone(data);
  const result = await prepareAiListingItems(data, {currencyCode: 'RUB'}, options);
  assert.equal(result[0].name, 'Пылесос Nova');
  assert.equal(result[1].name, 'Пылесос');
  assert.deepEqual(data, before);
});

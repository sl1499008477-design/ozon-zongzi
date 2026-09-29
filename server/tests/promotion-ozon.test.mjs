import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromotionOzon } from '../promotion-ozon.mjs';

// Fixed excerpts of the 2026-09-10 official/live read responses in
// /private/tmp/sonli-actions-research-zgUtRj. Only long action descriptions and
// unrelated price commissions/indexes are omitted. No credentials or live calls.
const credential = { clientId: 'fixture-client', apiKey: 'fixture-key' };
const p1 = '1723277596', p2 = '1723277624', p3 = '1723277788';
const action = {
  id: 1977747, title: 'Эластичный бустинг. Без ограничения срока действия',
  date_start: '2025-03-19T21:00:44Z', date_end: '2026-12-31T20:59:59Z',
  potential_products_count: 1, is_participating: true, participating_products_count: 47,
  action_type: 'ELASTIC_BOOSTING', banned_products_count: 0, with_targeting: false,
  discount_type: 'CURRENCY', discount_value: 0, order_amount: 0, freeze_date: '',
  is_voucher_action: false, auto_add_dates: ['2026-09-10T21:00:00Z', '2026-09-17T21:00:00Z'],
};
const manual = {
  id: 1723277596, price: 875, action_price: 132, max_action_price: 126, add_mode: 'MANUAL',
  stock: 0, min_stock: 0, alert_max_action_price_failed: false, alert_max_action_price: 0,
  current_boost: 15, price_min_elastic: 126, price_max_elastic: 101, min_boost: 15, max_boost: 55,
};
const auto = {
  id: 1723277788, price: 1025, action_price: 201, max_action_price: 204, add_mode: 'AUTO',
  stock: 0, min_stock: 0, alert_max_action_price_failed: false, alert_max_action_price: 0,
  current_boost: 17.9, price_min_elastic: 204, price_max_elastic: 163, min_boost: 15, max_boost: 55,
};
const candidate = {
  id: 1723277596, price: 875, action_price: 0, max_action_price: 112, add_mode: 'NOT_SET',
  stock: 0, min_stock: 0, alert_max_action_price_failed: false, alert_max_action_price: 0,
  current_boost: 0, price_min_elastic: 112, price_max_elastic: 112, min_boost: 0, max_boost: 0,
};
const future = {
  product_id: 1723277596, offer_id: '30 см-теплый свет_ob_JqyHm', sku: 2102714113,
  name: 'Уличный настенный светильник,220V IP65Уличный настенный светильник,220V IP65 Материал из алюминиевого сплава',
  price: 875, max_discount_price: 126, min_seller_price: 0, marketplace_seller_price: 114,
  action_price_to_auto_add: 115, min_action_quantity: 0, quantity_to_auto_add: 0, currency: 'CNY', add_mode: 'AUTO',
};
const prices = [
  { product_id: 1723277596, offer_id: '30 см-теплый свет_ob_JqyHm', price: { auto_action_enabled: false, currency_code: 'CNY', marketing_seller_price: 114, min_price: 0, old_price: 875, price: 875, retail_price: 0, vat: 0, auto_add_to_ozon_actions_list_enabled: true, net_price: 0 } },
  { product_id: 1723277624, offer_id: '30 см-белый свет_ob_qC_-Y', price: { auto_action_enabled: false, currency_code: 'CNY', marketing_seller_price: 111, min_price: 0, old_price: 875, price: 875, retail_price: 0, vat: 0, auto_add_to_ozon_actions_list_enabled: true, net_price: 0 } },
  { product_id: 1723277788, offer_id: '50 см-теплый свет_ob_pXX23', price: { auto_action_enabled: false, currency_code: 'CNY', marketing_seller_price: 179, min_price: 0, old_price: 1025, price: 1025, retail_price: 0, vat: 0, auto_add_to_ozon_actions_list_enabled: true, net_price: 0 } },
];
// Product-info stock shape is separate from promotion allocation. Quantities
// here are controlled boundary cases; they are not claimed as live inventory.
const details = [
  { id: 1723277596, offer_id: future.offer_id, sku: 2102714113, name: future.name, description_category_id: 17028982, type_id: 970, is_archived: false, statuses: { status_name: 'Продается' }, stocks: { has_stock: true, stocks: [{ source: 'fbs', sku: 2102714113, present: 9, reserved: 2 }, { source: 'fbo', sku: 2102714113, present: 5, reserved: 1 }] } },
  { id: 1723277624, stocks: { has_stock: false, stocks: [] } },
  { id: 1723277788 },
];
const copy = value => structuredClone(value);
const invalid = error => error.code === 'PROMOTION_ZONGZI_RESPONSE_INVALID';
const unknown = error => error.code === 'PROMOTION_ZONGZI_RESULT_UNKNOWN' && error.uncertain === true;

function fixture(overrides = {}) {
  const requests = [];
  const page = (items, at, cursorKey) => ({ products: items.slice(at, at + 1), total: items.length, [cursorKey]: String(at + 1) });
  async function call(c, path, body) {
    assert.equal(c, credential);
    requests.push({ path, body: copy(body) });
    if (overrides[path]) return copy(await overrides[path](body));
    if (path === '/v5/product/info/prices') {
      assert.equal(body.filter.visibility, 'ALL');
      const at = Number(body.cursor || 0);
      return { items: copy(prices.slice(at, at + 1)), total: 3, cursor: String(at + 1) };
    }
    if (path === '/v2/actions/candidates') return { result: page([candidate, { ...candidate, id: 1723277624, max_action_price: 108 }], Number(body.last_id || 0), 'last_id') };
    if (path === '/v2/actions/products') return { result: page([manual, auto], Number(body.last_id || 0), 'last_id') };
    if (path === '/v2/actions/auto-add/products/list') {
      assert.ok(body.limit > 0 && body.limit <= 100);
      if (body.auto_add_date === '2026-09-10T21:00:00Z') return { products: [], total: 0 };
      assert.equal(body.auto_add_date, '2026-09-17T21:00:00Z');
      return { products: copy([future, { ...future, product_id: 1723277624, sku: 2102713279, offer_id: prices[1].offer_id, action_price_to_auto_add: 118 }].slice(body.offset, body.offset + 1)), total: 2 };
    }
    if (path === '/v3/product/info/list') return { items: copy(details.filter(row => body.product_id.map(String).includes(String(row.id)))) };
    if (path === '/v1/product/action/timer/status') return { statuses: [{ product_id: 1723277596, expired_at: '2026-10-10T12:00:00Z', min_price_for_auto_actions_enabled: true }] };
    throw new Error(`Unexpected external request: ${path}`);
  }
  const get = async (c, path) => {
    assert.equal(c, credential); assert.equal(path, '/v1/actions');
    return copy(overrides.actions || { result: [action] });
  };
  return { ozon: createPromotionOzon({ call, get }), requests };
}

test('snapshot follows short pages and real cursor/offset envelopes without losing current or future members', async () => {
  const { ozon, requests } = fixture();
  const snapshot = await ozon.snapshot(credential);
  assert.deepEqual(snapshot.actions.map(a => ({ id: a.id, title: a.title, type: a.type, isVoucher: a.isVoucher, startAt: a.startAt, endAt: a.endAt, freezeAt: a.freezeAt, autoAddDates: a.autoAddDates, candidates: a.candidates.map(c => [c.productId, c.maxPrice, c.minQuantity]) })), [{ id: '1977747', title: action.title, type: 'ELASTIC_BOOSTING', isVoucher: false, startAt: '2025-03-19T21:00:44Z', endAt: '2026-12-31T20:59:59Z', freezeAt: null, autoAddDates: action.auto_add_dates, candidates: [[p1, '112', 0], [p2, '108', 0]] }]);
  assert.deepEqual(snapshot.memberships.map(m => ({ actionId: m.actionId, productId: m.productId, batchAt: m.batchAt, mode: m.mode, price: m.price, quantity: m.quantity, currency: m.currency })), [
    { actionId: '1977747', productId: p1, batchAt: '', mode: 'MANUAL', price: '132', quantity: 0, currency: 'CNY' },
    { actionId: '1977747', productId: p3, batchAt: '', mode: 'AUTO', price: '201', quantity: 0, currency: 'CNY' },
    { actionId: '1977747', productId: p1, batchAt: '2026-09-17T21:00:00Z', mode: 'AUTO', price: '115', quantity: 0, currency: 'CNY' },
    { actionId: '1977747', productId: p2, batchAt: '2026-09-17T21:00:00Z', mode: 'AUTO', price: '118', quantity: 0, currency: 'CNY' },
  ]);
  assert.equal(snapshot.products.length, 3);
  assert.deepEqual(requests.filter(r => r.path.endsWith('/prices')).map(r => r.body.cursor || ''), ['', '1', '2']);
  assert.deepEqual(requests.filter(r => r.path === '/v2/actions/products').map(r => r.body.last_id || ''), ['', '1']);
  assert.deepEqual(requests.filter(r => r.path.endsWith('/auto-add/products/list')).map(r => [r.body.auto_add_date, r.body.offset]), [['2026-09-10T21:00:00Z', 0], ['2026-09-17T21:00:00Z', 0], ['2026-09-17T21:00:00Z', 1]]);
  assert.ok(Number.isFinite(Date.parse(snapshot.fetchedAt)));
});

test('product contract preserves currency/zero costs and uses actual stock minus reservations, never campaign stock', async () => {
  const result = await fixture().ozon.snapshot(credential);
  assert.deepEqual(result.products.find(p => p.productId === p1), {
    productId: p1, offerId: future.offer_id, sku: '2102714113', name: future.name,
    categoryId: '17028982', typeId: '970', imageUrl: null, currency: 'CNY', basePrice: '875', currentPrice: '114', minPrice: '0', netPrice: '0',
    availableStock: 11, archived: false, status: 'Продается', autoAddEnabled: true, minPriceEnabled: true, minPriceExpiresAt: '2026-10-10T12:00:00Z',
  });
  assert.equal(result.products.find(p => p.productId === p2).availableStock, 0);
  assert.equal(result.products.find(p => p.productId === p3).availableStock, null);
});

test('product thumbnails use the primary photo, then gallery; missing photos do not remove products', async()=>{
  const {ozon}=fixture({'/v3/product/info/list':()=>({items:[
    {...details[0],primary_image:['https://cdn.example/primary.jpg'],images:['https://cdn.example/gallery.jpg']},
    {...details[1],primary_image:[],images:['https://cdn.example/second.jpg']},details[2],
  ]})});
  const result=await ozon.snapshot(credential);
  assert.deepEqual(result.products.map(p=>p.imageUrl),['https://cdn.example/primary.jpg','https://cdn.example/second.jpg',null]);
});

test('missing metadata, timer and inventory remain null without suppressing AUTO exits', async () => {
  const { ozon } = fixture({ '/v3/product/info/list': () => ({ items: [] }), '/v1/product/action/timer/status': () => ({ statuses: [] }) });
  const result = await ozon.snapshot(credential);
  const product = result.products.find(p => p.productId === p3);
  for (const field of ['sku', 'name', 'categoryId', 'typeId', 'availableStock', 'archived', 'status', 'minPriceEnabled', 'minPriceExpiresAt']) assert.equal(product[field], null, field);
  assert.equal(result.memberships.find(m => m.productId === p3).mode, 'AUTO');
});

test('missing price rows do not erase members or invent RUB, prices or inventory', async () => {
  const { ozon } = fixture({ '/v5/product/info/prices': () => ({ items: [], total: 0, cursor: '' }) });
  const result = await ozon.snapshot(credential);
  const product = result.products.find(p => p.productId === p3);
  for (const field of ['currency', 'basePrice', 'currentPrice', 'minPrice', 'netPrice', 'availableStock', 'autoAddEnabled']) assert.equal(product[field], null, field);
  assert.equal(result.memberships.find(m => m.productId === p3).currency, null);
  assert.equal(result.memberships.find(m => m.batchAt && m.productId === p1).currency, 'CNY');
});

test('decimal strings retain precision; future currency and unknown add modes are not inferred from another product', async () => {
  const { ozon } = fixture({
    '/v5/product/info/prices': () => ({ items: [{ ...prices[0], price: { price: '875.10', marketing_seller_price: '114.01', min_price: '80.00', net_price: null, currency_code: 'CNY' } }], total: 1, cursor: '' }),
    '/v2/actions/products': () => ({ result: { products: [{ ...auto, add_mode: 'NOT_SET' }], total: 1, last_id: 'last' } }),
    '/v2/actions/auto-add/products/list': () => ({ products: [{ ...future, currency: 'RUB', add_mode: 'MANUAL', action_price_to_auto_add: '115.25' }], total: 1 }),
  });
  const result = await ozon.snapshot(credential);
  assert.equal(result.products.find(p => p.productId === p1).basePrice, '875.10');
  assert.equal(result.products.find(p => p.productId === p1).currentPrice, '114.01');
  assert.equal(result.products.find(p => p.productId === p1).minPrice, '80.00');
  assert.equal(result.products.find(p => p.productId === p1).netPrice, null);
  assert.equal(result.memberships[0].mode, 'UNKNOWN');
  assert.deepEqual(result.memberships.slice(1).map(m => [m.currency, m.mode, m.price]), [['RUB', 'MANUAL', '115.25'], ['RUB', 'MANUAL', '115.25']]);
});

test('an incomplete price record never borrows another response currency or promotional price', async () => {
  const { ozon } = fixture({
    '/v5/product/info/prices': () => ({ items: [{ product_id: 1723277596, price: { price: '875.10' } }], total: 1, cursor: '' }),
    '/v2/actions/auto-add/products/list': () => ({ products: [{ ...future, currency: 'RUB' }], total: 1 }),
  });
  const result = await ozon.snapshot(credential);
  const product = result.products.find(p => p.productId === p1);
  assert.equal(product.basePrice, '875.10');
  for (const field of ['currency', 'currentPrice', 'minPrice', 'netPrice']) assert.equal(product[field], null, field);
  assert.equal(result.memberships.find(m => m.productId === p1 && !m.batchAt).currency, null);
  assert.equal(result.memberships.find(m => m.batchAt).currency, 'RUB');
});

for (const path of ['/v5/product/info/prices', '/v2/actions/candidates', '/v2/actions/products', '/v2/actions/auto-add/products/list']) {
  test(`snapshot rejects a failed later page of ${path} instead of publishing a partial snapshot`, async () => {
    const failure = Object.assign(new Error('fixture upstream failure'), { status: 503 });
    const { ozon } = fixture({ [path]: body => {
      if (body.cursor || body.last_id || body.offset) throw failure;
      if (path.endsWith('/prices')) return { items: [prices[0]], total: 2, cursor: 'next' };
      if (path.endsWith('/list')) return { products: [future], total: 2 };
      return { result: { products: [manual], total: 2, last_id: 'next' } };
    } });
    await assert.rejects(ozon.snapshot(credential), error => error === failure);
  });
}

for (const [name, response] of [
  ['unknown envelope', { result: {} }],
  ['empty page before declared total', { result: { products: [], total: 2, last_id: '' } }],
  ['missing continuation cursor', { result: { products: [manual], total: 2, last_id: '' } }],
  ['repeated page/cursor', { result: { products: [manual], total: 3, last_id: 'same' } }],
]) {
  test(`snapshot rejects ${name}`, async () => {
    const { ozon } = fixture({ '/v2/actions/products': () => response });
    await assert.rejects(ozon.snapshot(credential), invalid);
  });
}

test('empty official lists produce an empty snapshot without synthetic products', async () => {
  const { ozon } = fixture({ actions: { result: [] }, '/v5/product/info/prices': () => ({ items: [], total: 0, cursor: '' }) });
  const result = await ozon.snapshot(credential);
  assert.deepEqual([result.actions, result.products, result.memberships], [[], [], []]);
});

test('unconfirmed reservation counts remain unknown and repeated stock identities are not double counted', async () => {
  const { ozon } = fixture({ '/v3/product/info/list': () => ({ items: [
    { ...details[0], stocks: { has_stock: true, stocks: [{ source: 'fbs', sku: 2102714113, present: 9 }] } },
    { ...details[1], stocks: { has_stock: true, stocks: [{ source: 'fbs', sku: 2102713279, present: 8, reserved: 3 }, { source: 'fbs', sku: 2102713279, present: 8, reserved: 3 }] } },
  ] }) });
  const result = await ozon.snapshot(credential);
  assert.equal(result.products.find(p => p.productId === p1).availableStock, null);
  assert.equal(result.products.find(p => p.productId === p2).availableStock, 5);
});

function writing(response, failure) {
  const requests = [];
  const ozon = createPromotionOzon({
    get: async () => { throw new Error('Unexpected GET during write'); },
    call: async (c, path, body) => {
      assert.equal(c, credential); requests.push({ path, body: copy(body) });
      if (failure) throw failure;
      return copy(typeof response === 'function' ? await response(path, body) : response);
    },
  });
  return { ozon, requests };
}

test('activate sends the official price/stock payload and reports partial rejection by product', async () => {
  const { ozon, requests } = writing({ active_product_ids: [1723277596], deactivated_product_ids: [], rejected: [{ product_id: 1723277624, reason: 'PRICE_TOO_HIGH' }], warnings: [] });
  assert.deepEqual(await ozon.activate(credential, { actionId: '1977747', products: [{ productId: p1, price: '110.25', currency: 'CNY', quantity: 4 }, { productId: p2, price: '108', currency: 'CNY', quantity: 2 }] }), { acceptedIds: [p1], deactivatedIds: [], rejected: [{ productId: p2, reason: 'PRICE_TOO_HIGH' }], warnings: [] });
  assert.deepEqual(requests, [{ path: '/v1/actions/products/update', body: { action_id: 1977747, products: [{ product_id: 1723277596, action_price: { amount: '110.25', currency: 'CNY' }, stock: 4 }, { product_id: 1723277624, action_price: { amount: '108', currency: 'CNY' }, stock: 2 }] } }]);
});

for (const [name, optionalQuantity] of [['missing', {}], ['undefined', { quantity: undefined }], ['null', { quantity: null }]]) {
  test(`activate omits stock for ${name} quantity and includes a provided positive quantity`, async () => {
    const { ozon, requests } = writing({ active_product_ids: [1723277596, 1723277624], deactivated_product_ids: [], rejected: [], warnings: [] });
    const result = await ozon.activate(credential, { actionId: '1977747', products: [
      { productId: p1, price: '110.25', currency: 'CNY', ...optionalQuantity },
      { productId: p2, price: '108', currency: 'CNY', quantity: 1 },
    ] });
    assert.deepEqual(result, { acceptedIds: [p1, p2], deactivatedIds: [], rejected: [], warnings: [] });
    assert.deepEqual(requests, [{ path: '/v1/actions/products/update', body: { action_id: 1977747, products: [
      { product_id: 1723277596, action_price: { amount: '110.25', currency: 'CNY' } },
      { product_id: 1723277624, action_price: { amount: '108', currency: 'CNY' }, stock: 1 },
    ] } }]);
  });
}

for (const quantity of [0, -1, 1.5]) {
  test(`activate rejects quantity ${quantity} before any external request`, async () => {
    const { ozon, requests } = writing({ result: { product_ids: [1723277596], rejected: [] } });
    await assert.rejects(ozon.activate(credential, { actionId: '1977747', products: [{ productId: p1, price: '110.25', quantity }] }), error => error.code === 'PROMOTION_ZONGZI_INPUT_INVALID');
    assert.equal(requests.length, 0);
  });
}

test('activate validates a later batch quantity before writing any earlier positive or mixed optional rows', async () => {
  for (const mixed of [false, true]) {
    const products = Array.from({ length: 1001 }, (_, i) => ({ productId: String(10000 + i), price: '110.25', quantity: 1 }));
    if (mixed) {
      delete products[0].quantity;
      products[1].quantity = null;
      products[2].quantity = undefined;
    }
    products.at(-1).quantity = 0;
    const { ozon, requests } = writing((path, body) => ({ result: { product_ids: body.products.map(p => p.product_id), rejected: [] } }));
    await assert.rejects(ozon.activate(credential, { actionId: '1977747', products }), error => error.code === 'PROMOTION_ZONGZI_INPUT_INVALID');
    assert.equal(requests.length, 0);
  }
});

test('deactivate only removes the requested current membership', async () => {
  const { ozon, requests } = writing({ result: { product_ids: [1723277596], rejected: [] } });
  assert.deepEqual(await ozon.deactivate(credential, { actionId: '1977747', productIds: [p1] }), { acceptedIds: [p1], rejected: [] });
  assert.deepEqual(requests, [{ path: '/v2/actions/products/deactivate', body: { action_id: 1977747, product_ids: [1723277596] } }]);
});

test('cancelFuture uses string uint64 IDs and preserves the exact UTC batch', async () => {
  const { ozon, requests } = writing({ product_ids: [p1] });
  assert.deepEqual(await ozon.cancelFuture(credential, { actionId: '1977747', batchAt: '2026-09-17T21:00:00Z', productIds: [p1] }), { acceptedIds: [p1], rejected: [] });
  assert.deepEqual(requests, [{ path: '/v2/actions/auto-add/products/delete', body: { action_id: '1977747', auto_add_date: '2026-09-17T21:00:00Z', product_ids: [p1] } }]);
});

test('protectPrices writes only the four floor fields and exposes the documented auto-action refusal', async () => {
  const { ozon, requests } = writing({ result: [
    { product_id: 1723277596, offer_id: 'fixture', updated: true, errors: [] },
    { product_id: 1723277624, offer_id: 'fixture-2', updated: false, errors: [{ code: 'action_price_enabled_min_price_missing', message: 'Minimum price could not be updated' }] },
  ] });
  const result = await ozon.protectPrices(credential, { products: [{ productId: p1, minPrice: '80.10', currency: 'CNY', price: '1', autoAddEnabled: false }, { productId: p2, minPrice: '90', currency: 'CNY' }] });
  assert.deepEqual(result.acceptedIds, [p1]);
  assert.equal(result.rejected[0].productId, p2);
  assert.match(result.rejected[0].reason, /action_price_enabled_min_price_missing/);
  assert.deepEqual(requests, [{ path: '/v1/product/import/prices', body: { prices: [
    { product_id: 1723277596, min_price: '80.10', currency_code: 'CNY', min_price_for_auto_actions_enabled: true },
    { product_id: 1723277624, min_price: '90', currency_code: 'CNY', min_price_for_auto_actions_enabled: true },
  ] } }]);
});

test('an explicitly rejected whole request is propagated without changing switches or retrying', async () => {
  const refusal = Object.assign(new Error('Ozon refused'), { status: 400, code: 'ZONGZI_HTTP_400' });
  const { ozon, requests } = writing(null, refusal);
  await assert.rejects(ozon.protectPrices(credential, { products: [{ productId: p1, minPrice: '80', currency: 'CNY' }] }), error => error === refusal);
  assert.equal(requests.length, 1);
});

for (const [method, input, response] of [
  ['activate', { actionId: '1977747', products: [{ productId: p1, price: '110', currency: 'CNY', quantity: 1 }] }, { active_product_ids: [], deactivated_product_ids: [], rejected: [], warnings: [] }],
  ['deactivate', { actionId: '1977747', productIds: [p1] }, {}],
  ['cancelFuture', { actionId: '1977747', batchAt: '2026-09-17T21:00:00Z', productIds: [p1] }, { product_ids: [] }],
  ['protectPrices', { products: [{ productId: p1, minPrice: '80', currency: 'CNY' }] }, { result: [] }],
]) {
  test(`${method} rejects an empty/unknown success list for a nonempty write`, async () => {
    await assert.rejects(writing(response).ozon[method](credential, input), unknown);
  });
}

test('all explicitly rejected products is a known result even when acceptedIds is empty', async () => {
  const { ozon } = writing({ result: { product_ids: [], rejected: [{ product_id: 1723277596, reason: 'NOT_ALLOWED' }] } });
  assert.deepEqual(await ozon.deactivate(credential, { actionId: '1977747', productIds: [p1] }), { acceptedIds: [], rejected: [{ productId: p1, reason: 'NOT_ALLOWED' }] });
});

for (const response of [
  { result: { product_ids: [1723277596], rejected: [] } },
  { result: { product_ids: [1723277596, 1723277624], rejected: [{ product_id: 1723277596, reason: 'CONFLICT' }] } },
  { result: { product_ids: [1723277596, 9999999], rejected: [] } },
]) {
  test('unaccounted, contradictory or unrelated write IDs are uncertain rather than inferred as accepted', async () => {
    await assert.rejects(writing(response).ozon.deactivate(credential, { actionId: '1977747', productIds: [p1, p2] }), unknown);
  });
}

test('network failure is identifiable as uncertain and does not retry an external write', async () => {
  const { ozon, requests } = writing(null, Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
  await assert.rejects(ozon.deactivate(credential, { actionId: '1977747', productIds: [p1] }), unknown);
  assert.equal(requests.length, 1);
});

test('renewPrices confirms the documented bodyless update using the timer status, without price writes', async () => {
  const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
  const { ozon, requests } = writing(path => path.endsWith('/update') ? {} : { statuses: [{ product_id: 1723277596, min_price_for_auto_actions_enabled: true, expired_at: expiry }] });
  assert.deepEqual(await ozon.renewPrices(credential, { productIds: [p1] }), { acceptedIds: [p1], rejected: [] });
  assert.deepEqual(requests.map(r => [r.path, r.body]), [['/v1/product/action/timer/update', { product_ids: [p1] }], ['/v1/product/action/timer/status', { product_ids: [p1] }]]);
});

test('an existing but unrenewed timer does not turn an empty update response into success', async () => {
  const { ozon } = writing(path => path.endsWith('/update') ? {} : { statuses: [{ product_id: 1723277596, min_price_for_auto_actions_enabled: true, expired_at: new Date(Date.now() + 86400000).toISOString() }] });
  await assert.rejects(ozon.renewPrices(credential, { productIds: [p1] }), unknown);
});

test('invalid price/currency and unsafe numeric IDs are rejected before any external write', async () => {
  const { ozon, requests } = writing({});
  for (const product of [{ productId: p1, minPrice: '', currency: 'CNY' }, { productId: p1, minPrice: '80', currency: '' }, { productId: 9007199254740992, minPrice: '80', currency: 'CNY' }]) {
    await assert.rejects(ozon.protectPrices(credential, { products: [product] }), error => error.code === 'PROMOTION_ZONGZI_INPUT_INVALID');
  }
  assert.equal(requests.length, 0);
});

test('official batch sizes cover every product and metadata request without skipping the last partial batch', async () => {
  const productIds = Array.from({ length: 1001 }, (_, i) => String(10000 + i));
  const readRequests = [];
  const ozon = createPromotionOzon({
    get: async () => ({ result: [] }),
    call: async (c, path, body) => {
      assert.equal(c, credential); readRequests.push({ path, body });
      if (path === '/v5/product/info/prices') {
        const start = Number(body.cursor || 0);
        return { items: productIds.slice(start, start + body.limit).map(id => ({ product_id: id })), total: 1001, cursor: String(start + body.limit) };
      }
      const ids = body.product_id || body.product_ids;
      assert.ok(ids.length <= 1000);
      if (path === '/v3/product/info/list') return { items: ids.map(id => ({ id })) };
      if (path === '/v1/product/action/timer/status') return { statuses: [] };
      throw new Error('unexpected request');
    },
  });
  const result = await ozon.snapshot(credential);
  assert.equal(result.products.length, 1001);
  assert.equal(result.products.at(-1).productId, '11000');
  assert.deepEqual(readRequests.filter(r => r.path === '/v3/product/info/list').map(r => r.body.product_id.length), [1000, 1]);
  const writer = writing((path, body) => ({ product_ids: body.product_ids }));
  const writeResult = await writer.ozon.cancelFuture(credential, { actionId: '1977747', batchAt: '2026-09-17T21:00:00Z', productIds });
  assert.equal(writeResult.acceptedIds.length, 1001);
  assert.equal(writeResult.acceptedIds.at(-1), '11000');
  assert.deepEqual(writer.requests.map(r => r.body.product_ids.length), [1000, 1]);
});

test('an unknown later write batch stops immediately and preserves earlier confirmed outcomes', async () => {
  const ids = Array.from({ length: 2001 }, (_, i) => String(10000 + i));
  const { ozon, requests } = writing((path, body) => body.product_ids[0] === 10000 ? { result: { product_ids: body.product_ids, rejected: [] } } : { result: { product_ids: [], rejected: [] } });
  await assert.rejects(ozon.deactivate(credential, { actionId: '1977747', productIds: ids }), error => {
    assert.ok(unknown(error));
    assert.equal(error.partialResult.acceptedIds.length, 1000);
    assert.equal(error.partialResult.acceptedIds.at(-1), '10999');
    return true;
  });
  assert.equal(requests.length, 2);
});

test('all write input is checked before the first batch can cause a partial external write', async () => {
  const products = Array.from({ length: 1001 }, (_, i) => ({ productId: String(10000 + i), minPrice: '80', currency: 'CNY' }));
  products.at(-1).minPrice = '';
  const { ozon, requests } = writing({});
  await assert.rejects(ozon.protectPrices(credential, { products }), error => error.code === 'PROMOTION_ZONGZI_INPUT_INVALID');
  assert.equal(requests.length, 0);
});

function targetFixture(overrides = {}) {
  const state = {
    actions: [copy(action), { ...copy(action), id: 4253043 }],
    current: [{ ...copy(manual), add_mode: 'AUTO' }, copy(auto)],
    candidates: [copy(candidate), { ...copy(candidate), id: 1723277624, max_action_price: 108 }],
    future: [copy(future), { ...copy(future), product_id: 1723277624 }],
    prices: copy(prices), details: copy(details),
    timers: [{ product_id: 1723277596, expired_at: '2026-10-10T12:00:00Z', min_price_for_auto_actions_enabled: true }],
  };
  const requests = [];
  const ozon = createPromotionOzon({
    get: async (c, path) => {
      assert.equal(c, credential); assert.equal(path, '/v1/actions');
      requests.push({ path }); return { result: copy(state.actions) };
    },
    call: async (c, path, body) => {
      assert.equal(c, credential); requests.push({ path, body: copy(body) });
      if (overrides[path]) return copy(await overrides[path](body, state));
      if (path === '/v5/product/info/prices') {
        assert.equal(body.filter.visibility, 'ALL');
        assert.ok(body.filter.product_id.length > 0 && body.filter.product_id.length <= 1000, 'prices must have a nonempty target filter');
        const rows = state.prices.filter(row => body.filter.product_id.map(String).includes(String(row.product_id)));
        const at = Number(body.cursor || 0);
        return { items: copy(rows.slice(at, at + 1)), total: rows.length, cursor: String(at + 1) };
      }
      if (path === '/v2/actions/products' || path === '/v2/actions/candidates') {
        assert.equal(String(body.action_id), '1977747');
        const rows = path.endsWith('/candidates') ? state.candidates : state.current;
        const at = Number(body.last_id || 0);
        return { result: { products: copy(rows.slice(at, at + 1)), total: rows.length, last_id: String(at + 1) } };
      }
      if (path === '/v2/actions/auto-add/products/list') {
        assert.equal(String(body.action_id), '1977747');
        assert.equal(body.auto_add_date, '2026-09-17T21:00:00Z');
        return { products: copy(state.future.slice(body.offset, body.offset + 1)), total: state.future.length };
      }
      if (path === '/v3/product/info/list') return { items: copy(state.details.filter(row => body.product_id.map(String).includes(String(row.id)))) };
      if (path === '/v1/product/action/timer/status') return { statuses: copy(state.timers.filter(row => body.product_ids.map(String).includes(String(row.product_id)))) };
      throw new Error(`Unexpected or writing endpoint during target refresh: ${path}`);
    },
  });
  return { ozon, state, requests };
}

test('refreshTargets EXIT re-reads later-batch AUTO to MANUAL changes and freeze/currency without a catalog scan', async () => {
  const { ozon, state, requests } = targetFixture();
  const first = await ozon.refreshTargets(credential, { operation: 'EXIT', actionId: '1977747', productIds: [p1] });
  assert.deepEqual(first.memberships.map(m => [m.productId, m.mode, m.currency]), [[p1, 'AUTO', 'CNY']]);
  assert.deepEqual(first.products.map(p => p.productId), [p1]);
  state.current[1].add_mode = 'MANUAL';
  state.actions[0].freeze_date = '2026-09-10T15:00:00Z';
  state.prices[2].price.currency_code = 'RUB';
  const boundary = requests.length;
  const second = await ozon.refreshTargets(credential, { operation: 'EXIT', actionId: '1977747', productIds: [p3] });
  assert.deepEqual(second.memberships.map(m => [m.productId, m.mode, m.currency]), [[p3, 'MANUAL', 'RUB']]);
  assert.deepEqual(second.products.map(p => p.productId), [p3]);
  assert.equal(second.products[0].availableStock, null);
  assert.deepEqual(second.actions.map(a => [a.id, a.freezeAt, a.candidates]), [['1977747', '2026-09-10T15:00:00Z', []]]);
  assert.equal(first.actions[0].freezeAt, null);
  assert.deepEqual(requests.slice(boundary).map(r => r.path), ['/v1/actions', '/v2/actions/products', '/v2/actions/products', '/v5/product/info/prices']);
  assert.deepEqual(requests.filter(r => r.path.endsWith('/prices')).map(r => r.body.filter.product_id), [[p1], [p3]]);
  assert.ok(Number.isFinite(Date.parse(second.fetchedAt)));
});

test('refreshTargets CANCEL_FUTURE reads only the requested batch and reflects a new MANUAL membership', async () => {
  const { ozon, state, requests } = targetFixture();
  const input = { operation: 'CANCEL_FUTURE', actionId: '1977747', batchAt: '2026-09-17T21:00:00Z', productIds: [p2] };
  const first = await ozon.refreshTargets(credential, input);
  assert.deepEqual(first.memberships.map(m => [m.productId, m.mode, m.batchAt]), [[p2, 'AUTO', input.batchAt]]);
  state.future[1].add_mode = 'MANUAL'; state.future[1].action_price_to_auto_add = '99.50';
  state.prices[1].price.min_price = '100';
  const second = await ozon.refreshTargets(credential, input);
  assert.deepEqual(second.memberships.map(m => [m.productId, m.mode, m.price]), [[p2, 'MANUAL', '99.50']]);
  assert.deepEqual(second.products.map(p => [p.productId, p.minPrice]), [[p2, '100']]);
  assert.equal(requests.filter(r => r.path === '/v1/actions').length, 2);
  assert.deepEqual(requests.filter(r => r.path.endsWith('/auto-add/products/list')).map(r => r.body.offset), [0, 1, 0, 1]);
  assert.ok(requests.every(r => ['/v1/actions', '/v2/actions/auto-add/products/list', '/v5/product/info/prices'].includes(r.path)));
});

test('refreshTargets stops querying a removed future batch while returning the latest action dates', async () => {
  const { ozon, state, requests } = targetFixture();
  state.actions[0].auto_add_dates = ['2026-09-10T21:00:00Z'];
  const result = await ozon.refreshTargets(credential, { operation: 'CANCEL_FUTURE', actionId: '1977747', batchAt: '2026-09-17T21:00:00Z', productIds: [p1] });
  assert.deepEqual(result.memberships, []);
  assert.deepEqual(result.actions[0].autoAddDates, ['2026-09-10T21:00:00Z']);
  assert.deepEqual(requests.map(r => r.path), ['/v1/actions', '/v5/product/info/prices']);
});

test('refreshTargets JOIN observes changed candidate ceiling, current membership, actual stock and price on each call', async () => {
  const { ozon, state, requests } = targetFixture();
  state.current = [];
  const input = { operation: 'JOIN', actionId: '1977747', productIds: [p1] };
  const first = await ozon.refreshTargets(credential, input);
  assert.deepEqual(first.actions[0].candidates.map(c => [c.productId, c.maxPrice, c.minQuantity]), [[p1, '112', 0]]);
  assert.deepEqual(first.memberships, []);
  assert.equal(first.products[0].availableStock, 11);
  state.candidates[0].max_action_price = 105;
  state.current = [{ ...manual, add_mode: 'MANUAL' }];
  state.details[0].stocks.stocks = [{ source: 'fbs', sku: 2102714113, present: 9, reserved: 8 }];
  state.prices[0].price.price = '800.10'; state.prices[0].price.marketing_seller_price = '102.50';
  const second = await ozon.refreshTargets(credential, input);
  assert.deepEqual(second.actions[0].candidates.map(c => [c.productId, c.maxPrice, c.minQuantity]), [[p1, '105', 0]]);
  assert.deepEqual(second.memberships.map(m => [m.productId, m.mode]), [[p1, 'MANUAL']]);
  assert.equal(second.products[0].availableStock, 1);
  assert.equal(second.products[0].basePrice, '800.10');
  assert.equal(second.products[0].currentPrice, '102.50');
  assert.deepEqual(second.products.map(p => p.productId), [p1]);
  assert.deepEqual(requests.filter(r => r.path === '/v3/product/info/list').map(r => r.body.product_id), [[p1], [p1]]);
  assert.ok(!requests.some(r => r.path.includes('/auto-add/') || r.path.includes('/timer/')));
});

function allMembershipsFixture(overrides = {}) {
  const current = {
    '1977747': [{ ...manual, id: Number(p2) }],
    '4253043': [{ ...manual, id: Number(p2) }, manual, auto],
  };
  const futureBatches = {
    '1977747': {
      '2026-09-10T21:00:00Z': [],
      '2026-09-17T21:00:00Z': [{ ...future, product_id: Number(p2) }, { ...future, add_mode: 'MANUAL' }],
    },
    '4253043': {
      '2026-09-10T21:00:00Z': [{ ...future, product_id: Number(p2) }, { ...future, currency: 'RUB', action_price_to_auto_add: '99.50' }],
      '2026-09-17T21:00:00Z': [{ ...future, product_id: Number(p2) }, { ...future, product_id: Number(p3), add_mode: 'NOT_SET' }],
    },
  };
  const result = targetFixture({
    '/v2/actions/products': body => {
      const rows = current[body.action_id], at = Number(body.last_id || 0);
      return { result: { products: rows.slice(at, at + 1), total: rows.length, last_id: String(at + 1) } };
    },
    '/v2/actions/auto-add/products/list': body => {
      const rows = futureBatches[body.action_id][body.auto_add_date];
      return { products: rows.slice(body.offset, body.offset + 1), total: rows.length };
    },
    ...overrides,
  });
  return { ...result, current, futureBatches };
}

test('refreshTargets JOIN includeAllMemberships completes all current and future pages while returning only target products and action', async () => {
  const { ozon, requests } = allMembershipsFixture();
  const result = await ozon.refreshTargets(credential, { operation: 'JOIN', actionId: '1977747', productIds: [p1, p3], includeAllMemberships: true });
  assert.deepEqual(result.actions.map(a => [a.id, a.candidates.map(c => [c.productId, c.maxPrice, c.minQuantity])]), [['1977747', [[p1, '112', 0]]]]);
  assert.deepEqual(result.memberships.map(m => ({ actionId: m.actionId, productId: m.productId, batchAt: m.batchAt, mode: m.mode, price: m.price, quantity: m.quantity, currency: m.currency })), [
    { actionId: '1977747', productId: p1, batchAt: '2026-09-17T21:00:00Z', mode: 'MANUAL', price: '115', quantity: 0, currency: 'CNY' },
    { actionId: '4253043', productId: p1, batchAt: '', mode: 'MANUAL', price: '132', quantity: 0, currency: 'CNY' },
    { actionId: '4253043', productId: p3, batchAt: '', mode: 'AUTO', price: '201', quantity: 0, currency: 'CNY' },
    { actionId: '4253043', productId: p1, batchAt: '2026-09-10T21:00:00Z', mode: 'AUTO', price: '99.50', quantity: 0, currency: 'RUB' },
    { actionId: '4253043', productId: p3, batchAt: '2026-09-17T21:00:00Z', mode: 'UNKNOWN', price: '115', quantity: 0, currency: 'CNY' },
  ]);
  assert.deepEqual(result.products.map(p => [p.productId, p.currentPrice, p.currency, p.availableStock]), [[p1, '114', 'CNY', 11], [p3, '179', 'CNY', null]]);
  assert.equal(requests.filter(r => r.path === '/v1/actions').length, 1);
  assert.deepEqual(requests.filter(r => r.path.endsWith('/candidates')).map(r => r.body.action_id), [1977747, 1977747]);
  assert.deepEqual(requests.filter(r => r.path.endsWith('/prices')).map(r => r.body.filter.product_id), [[p1, p3], [p1, p3]]);
  assert.deepEqual(requests.filter(r => r.path === '/v3/product/info/list').map(r => r.body.product_id), [[p1, p3]]);
  assert.deepEqual(requests.filter(r => r.path === '/v2/actions/products').map(r => [r.body.action_id, r.body.last_id || '']), [[1977747, ''], [4253043, ''], [4253043, '1'], [4253043, '2']]);
  assert.deepEqual(requests.filter(r => r.path.includes('/auto-add/')).map(r => [r.body.action_id, r.body.auto_add_date, r.body.offset]), [
    ['1977747', '2026-09-10T21:00:00Z', 0], ['1977747', '2026-09-17T21:00:00Z', 0], ['1977747', '2026-09-17T21:00:00Z', 1],
    ['4253043', '2026-09-10T21:00:00Z', 0], ['4253043', '2026-09-10T21:00:00Z', 1],
    ['4253043', '2026-09-17T21:00:00Z', 0], ['4253043', '2026-09-17T21:00:00Z', 1],
  ]);
  assert.ok(!requests.some(r => r.path.includes('/timer/')));
});

test('refreshTargets JOIN includeAllMemberships observes memberships when the target action disappears without borrowing future prices', async () => {
  const { ozon, state } = allMembershipsFixture({ '/v5/product/info/prices': () => ({ items: [], total: 0, cursor: '' }) });
  state.actions = state.actions.filter(a => a.id === 4253043);
  const result = await ozon.refreshTargets(credential, { operation: 'JOIN', actionId: '1977747', productIds: [p1], includeAllMemberships: true });
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.memberships.map(m => [m.actionId, m.productId, m.batchAt]), [['4253043', p1, ''], ['4253043', p1, '2026-09-10T21:00:00Z']]);
  for (const field of ['basePrice', 'currentPrice', 'currency']) assert.equal(result.products[0][field], null, field);
  assert.equal(result.products[0].availableStock, 11);
});

for (const [kind, path, actionId, batchAt] of [
  ['other current', '/v2/actions/products', '4253043', ''],
  ['other future', '/v2/actions/auto-add/products/list', '4253043', '2026-09-17T21:00:00Z'],
  ['own future', '/v2/actions/auto-add/products/list', '1977747', '2026-09-17T21:00:00Z'],
]) {
  test(`refreshTargets JOIN includeAllMemberships rejects a failed later ${kind} page even after finding the target`, async () => {
    const failure = Object.assign(new Error('later membership page failed'), { status: 503 });
    const { ozon } = allMembershipsFixture({ [path]: body => {
      const selected = String(body.action_id) === actionId && (!batchAt || body.auto_add_date === batchAt);
      if (selected && (body.last_id || body.offset)) throw failure;
      return batchAt
        ? { products: selected ? [future] : [], total: selected ? 2 : 0 }
        : { result: { products: selected ? [manual] : [], total: selected ? 2 : 0, last_id: 'next' } };
    } });
    await assert.rejects(ozon.refreshTargets(credential, { operation: 'JOIN', actionId: '1977747', productIds: [p1], includeAllMemberships: true }), error => error === failure);
  });
}

test('refreshTargets JOIN includeAllMemberships rejects incomplete other current and future pagination', async () => {
  for (const overrides of [
    { '/v2/actions/products': body => ({ result: { products: [manual], total: String(body.action_id) === '4253043' ? 2 : 1, last_id: '' } }) },
    { '/v2/actions/auto-add/products/list': body => ({ products: body.offset ? [] : [future], total: String(body.action_id) === '4253043' ? 2 : 1 }) },
  ]) {
    await assert.rejects(allMembershipsFixture(overrides).ozon.refreshTargets(credential, { operation: 'JOIN', actionId: '1977747', productIds: [p1], includeAllMemberships: true }), invalid);
  }
});

test('refreshTargets JOIN includeAllMemberships rejects incomplete action batches and duplicate actions', async () => {
  for (const change of [state => { state.actions[1].auto_add_dates = ['invalid date']; }, state => { state.actions.push(copy(state.actions[1])); }]) {
    const { ozon, state } = allMembershipsFixture();
    change(state);
    await assert.rejects(ozon.refreshTargets(credential, { operation: 'JOIN', actionId: '1977747', productIds: [p1], includeAllMemberships: true }), invalid);
  }
});

for (const operation of ['JOIN', 'EXIT', 'CANCEL_FUTURE', 'SET_FLOOR', 'RENEW_FLOOR']) {
  test(`refreshTargets ${operation} keeps the existing read scope when includeAllMemberships is false or inapplicable`, async () => {
    const { ozon, requests } = targetFixture();
    const input = { operation, actionId: '1977747', batchAt: '2026-09-17T21:00:00Z', productIds: [p1] };
    const { fetchedAt, ...expected } = await ozon.refreshTargets(credential, input);
    const baseline = requests.splice(0);
    const { fetchedAt: nextFetchedAt, ...actual } = await ozon.refreshTargets(credential, { ...input, includeAllMemberships: operation !== 'JOIN' });
    assert.deepEqual(actual, expected);
    assert.deepEqual(requests, baseline);
  });
}

for (const operation of ['SET_FLOOR', 'RENEW_FLOOR']) {
  test(`refreshTargets ${operation} reads only target prices and timer status`, async () => {
    const { ozon, state, requests } = targetFixture();
    state.prices[0].price.min_price = '80.10';
    const result = await ozon.refreshTargets(credential, { operation, productIds: [p1, p3] });
    assert.deepEqual([result.actions, result.memberships], [[], []]);
    assert.deepEqual(result.products.map(p => [p.productId, p.minPrice, p.minPriceEnabled, p.availableStock]), [[p1, '80.10', true, null], [p3, '0', null, null]]);
    assert.equal(result.products[0].minPriceExpiresAt, '2026-10-10T12:00:00Z');
    assert.deepEqual(requests.map(r => r.path), ['/v5/product/info/prices', '/v5/product/info/prices', '/v1/product/action/timer/status']);
    assert.ok(requests.filter(r => r.path.endsWith('/prices')).every(r => JSON.stringify(r.body.filter.product_id) === JSON.stringify([p1, p3])));
  });
}

test('refreshTargets keeps missing metadata null and no-longer-listed actions absent', async () => {
  const { ozon, state, requests } = targetFixture({ '/v5/product/info/prices': () => ({ items: [], total: 0, cursor: '' }) });
  state.actions = [];
  const result = await ozon.refreshTargets(credential, { operation: 'EXIT', actionId: '1977747', productIds: [p1] });
  assert.deepEqual([result.actions, result.memberships], [[], []]);
  assert.deepEqual(result.products.map(p => p.productId), [p1]);
  for (const field of ['basePrice', 'currency', 'availableStock']) assert.equal(result.products[0][field], null);
  assert.deepEqual(requests.map(r => r.path), ['/v1/actions', '/v5/product/info/prices']);
});

for (const [operation, path] of [
  ['EXIT', '/v2/actions/products'], ['JOIN', '/v2/actions/candidates'],
  ['CANCEL_FUTURE', '/v2/actions/auto-add/products/list'], ['SET_FLOOR', '/v5/product/info/prices'],
]) {
  test(`refreshTargets ${operation} fails if a later required page fails even after finding a target`, async () => {
    const failure = Object.assign(new Error('later page failed'), { status: 503 });
    const { ozon } = targetFixture({ [path]: body => {
      if (body.last_id || body.cursor || body.offset) throw failure;
      if (path.endsWith('/prices')) return { items: [prices[0]], total: 2, cursor: 'next' };
      if (path.endsWith('/list')) return { products: [future], total: 2 };
      return { result: { products: [manual], total: 2, last_id: 'next' } };
    } });
    await assert.rejects(ozon.refreshTargets(credential, { operation, actionId: '1977747', batchAt: '2026-09-17T21:00:00Z', productIds: [p1, p2] }), error => error === failure);
  });
}

test('refreshTargets rejects truncated member pagination and unrelated filtered price IDs', async () => {
  for (const overrides of [
    { '/v2/actions/products': () => ({ result: { products: [manual], total: 2, last_id: '' } }) },
    { '/v5/product/info/prices': () => ({ items: [prices[1]], total: 1, cursor: '' }) },
  ]) {
    await assert.rejects(targetFixture(overrides).ozon.refreshTargets(credential, { operation: 'EXIT', actionId: '1977747', productIds: [p1] }), invalid);
  }
});

test('refreshTargets never sends an empty target filter or accepts an unknown operation', async () => {
  const { ozon, requests } = targetFixture();
  const empty = await ozon.refreshTargets(credential, { operation: 'JOIN', actionId: '1977747', productIds: [] });
  assert.deepEqual([empty.actions, empty.products, empty.memberships], [[], [], []]);
  await assert.rejects(ozon.refreshTargets(credential, { operation: 'ALL', productIds: [p1] }), error => error.code === 'PROMOTION_ZONGZI_INPUT_INVALID');
  await assert.rejects(ozon.refreshTargets(credential, { operation: 'CANCEL_FUTURE', actionId: '1977747', productIds: [p1] }), error => error.code === 'PROMOTION_ZONGZI_INPUT_INVALID');
  assert.equal(requests.length, 0);
});

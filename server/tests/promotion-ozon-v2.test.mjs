import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromotionOzon } from '../promotion-ozon.mjs';

const credential = { clientId: 'fixture', apiKey: 'fixture' };
const money = (amount, currency = 'CNY') => ({ amount, currency });
const action = { id: 17, title: '促销', action_type: 'ELASTIC_BOOSTING', is_voucher_action: false, auto_add_dates: ['2026-10-20T00:00:00Z'] };
const price = { product_id: 101, price: { price: '200', marketing_seller_price: '150', min_price: '0', currency_code: 'CNY' } };

function reading(clock = () => Date.parse('2026-10-13T00:00:00Z'), { currentPrice = money('140.10'), futurePrice = money('125.30', 'RUB'), currentMode = 'SELLER' } = {}) {
  const calls = [];
  const ozon = createPromotionOzon({ clock, get: async () => ({ result: [action] }), call: async (_credential, path, body) => {
    calls.push({ path, body });
    if (path === '/v5/product/info/prices') return { items: [price], total: 1, cursor: '' };
    if (path === '/v2/actions/candidates') return { products: [{ id: 101, max_action_price: money('1827.25'), marketplace_seller_price: money('150') }], total: 1, last_id: '' };
    if (path === '/v2/actions/products') return { products: [{ id: 101, action_price: currentPrice, max_action_price: money('1827.25'), marketplace_seller_price: money('150'), add_mode: currentMode }], total: 1, last_id: '' };
    if (path === '/v2/actions/auto-add/products/list') return { products: [{ product_id: 102, action_price_to_auto_add: futurePrice, marketplace_seller_price: money('129', 'RUB'), max_discount_price: money('130', 'RUB'), currency: 'RUB', add_mode: false }], total: 1 };
    if (path === '/v3/product/info/list') return { items: [] };
    if (path === '/v1/product/action/timer/status') return { statuses: [] };
    throw new Error(`Unexpected ${path}`);
  } });
  return { ozon, calls };
}

test('v2 snapshot carries Money amounts and currencies without borrowing product price currency', async () => {
  const { ozon, calls } = reading();
  const result = await ozon.snapshot(credential);
  assert.equal(result.priceSemantics, 'CEILING');
  assert.equal(result.actions[0].isVoucher, false);
  assert.deepEqual(result.actions[0].candidates[0], { productId: '101', maxPrice: '1827.25', currency: 'CNY', currentSellerPrice: '150', sellerPriceCurrency: 'CNY', minQuantity: null });
  assert.deepEqual(result.memberships.map(m => [m.productId, m.mode, m.price, m.currency, m.maxPrice, m.currentSellerPrice, m.priceSemantics]), [
    ['101', 'MANUAL', '140.10', 'CNY', '1827.25', '150', 'CEILING'],
    ['102', 'AUTO', '125.30', 'RUB', '130', '129', 'CEILING'],
  ]);
  assert.ok(calls.some(c => c.path === '/v2/actions/products'));
  assert.ok(calls.some(c => c.path === '/v2/actions/auto-add/products/list'));
});

test('price semantics changes at October 13 UTC for full and targeted reads', async () => {
  const { ozon } = reading(() => Date.parse('2026-10-12T23:59:59Z'));
  assert.equal((await ozon.snapshot(credential)).priceSemantics, 'FIXED');
  const targeted = await ozon.refreshTargets(credential, { operation: 'EXIT', actionId: '17', productIds: ['101'] });
  assert.equal(targeted.priceSemantics, 'FIXED');
  assert.equal(targeted.memberships[0].priceSemantics, 'FIXED');
});

test('incomplete Money never borrows a currency from catalog price or future row', async () => {
  const { ozon } = reading(undefined, { currentPrice: { amount: '140.10' }, futurePrice: { amount: '125.30' } });
  const result = await ozon.snapshot(credential);
  assert.deepEqual(result.memberships.map(m => [m.price, m.currency]), [['140.10', null], ['125.30', null]]);
});

test('an unexpected boolean current mode remains UNKNOWN', async () => {
  const { ozon } = reading(undefined, { currentMode: false });
  assert.equal((await ozon.snapshot(credential)).memberships[0].mode, 'UNKNOWN');
});

test('v2 top-level short pages continue until the declared total', async () => {
  const requests = [];
  const ozon = createPromotionOzon({ get: async () => ({ result: [{ ...action, auto_add_dates: [] }] }), call: async (_credential, path, body) => {
    requests.push({ path, body });
    if (path === '/v5/product/info/prices') return { items: [], total: 0, cursor: '' };
    if (path === '/v2/actions/candidates' || path === '/v2/actions/products') {
      const second = body.last_id === 'next';
      const row = { id: second ? 102 : 101, action_price: money(second ? '120' : '110'), max_action_price: money('130'), add_mode: 'AUTO' };
      return { products: [row], total: 2, last_id: second ? '' : 'next' };
    }
    if (path === '/v3/product/info/list') return { items: [] };
    if (path === '/v1/product/action/timer/status') return { statuses: [] };
    throw new Error(`Unexpected ${path}`);
  } });
  const result = await ozon.snapshot(credential);
  assert.deepEqual(result.actions[0].candidates.map(c => c.productId), ['101', '102']);
  assert.deepEqual(result.memberships.map(m => m.productId), ['101', '102']);
  assert.deepEqual(requests.filter(r => r.path === '/v2/actions/products').map(r => r.body.last_id || ''), ['', 'next']);
});

test('future fallback never attaches another Money currency to the base price', async () => {
  const ozon = createPromotionOzon({ get: async () => ({ result: [action] }), call: async (_credential, path) => {
    if (path === '/v5/product/info/prices') return { items: [], total: 0, cursor: '' };
    if (path === '/v2/actions/candidates' || path === '/v2/actions/products') return { products: [], total: 0, last_id: '' };
    if (path === '/v2/actions/auto-add/products/list') return { products: [{ product_id: 102, price: money('200', 'CNY'), marketplace_seller_price: money('100', 'RUB'), min_seller_price: money('90', 'RUB'), action_price_to_auto_add: money('80', 'RUB'), add_mode: true }], total: 1 };
    if (path === '/v3/product/info/list') return { items: [] };
    if (path === '/v1/product/action/timer/status') return { statuses: [] };
    throw new Error(`Unexpected ${path}`);
  } });
  const result = await ozon.snapshot(credential);
  const product = result.products[0];
  assert.deepEqual([product.currency, product.basePrice, product.currentPrice, product.minPrice], ['CNY', '200', null, null]);
  assert.deepEqual([result.memberships[0].mode, result.memberships[0].currency], ['MANUAL', 'RUB']);
});

function writing(response) {
  const calls = [];
  const ozon = createPromotionOzon({ call: async (_credential, path, body) => {
    calls.push({ path, body });
    return response;
  } });
  return { ozon, calls };
}

test('activate sends precise Money and preserves all update outcome categories', async () => {
  const { ozon, calls } = writing({ active_product_ids: [101], deactivated_product_ids: [102], rejected: [], warnings: [] });
  const result = await ozon.activate(credential, { actionId: '17', products: [
    { productId: '101', price: '140.10', currency: 'CNY', quantity: 2 },
    { productId: '102', price: '125.30', currency: 'RUB' },
  ] });
  assert.deepEqual(calls, [{ path: '/v1/actions/products/update', body: { action_id: 17, products: [
    { product_id: 101, action_price: money('140.10'), stock: 2 },
    { product_id: 102, action_price: money('125.30', 'RUB') },
  ] } }]);
  assert.deepEqual(result, { acceptedIds: ['101'], deactivatedIds: ['102'], rejected: [], warnings: [] });
});

test('updateForExit accepts only deactivated IDs; active IDs remain explicit refusals', async () => {
  const { ozon, calls } = writing({ active_product_ids: [101], deactivated_product_ids: [102], rejected: [], warnings: [] });
  const result = await ozon.updateForExit(credential, { actionId: '17', products: [
    { productId: '101', price: '140', currency: 'CNY' }, { productId: '102', price: '125', currency: 'RUB' },
  ] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/v1/actions/products/update');
  assert.deepEqual(result, { acceptedIds: ['102'], deactivatedIds: ['102'], rejected: [{ productId: '101', reason: '平台仍保留商品参与活动' }], warnings: [] });
});

test('missing currency and incomplete update receipt never cause a write retry', async () => {
  const { ozon, calls } = writing({ active_product_ids: [101], deactivated_product_ids: [], rejected: [], warnings: [] });
  await assert.rejects(ozon.activate(credential, { actionId: '17', products: [{ productId: '101', price: '140' }] }), e => e.code === 'PROMOTION_ZONGZI_INPUT_INVALID');
  assert.equal(calls.length, 0);
  await assert.rejects(ozon.activate(credential, { actionId: '17', products: [
    { productId: '101', price: '140', currency: 'CNY' }, { productId: '102', price: '125', currency: 'CNY' },
  ] }), e => e.code === 'PROMOTION_ZONGZI_RESULT_UNKNOWN');
  assert.equal(calls.length, 1);
});

test('v2 removal receipts use top-level product IDs', async () => {
  const { ozon, calls } = writing({ product_ids: [101] });
  assert.deepEqual(await ozon.deactivate(credential, { actionId: '17', productIds: ['101'] }), { acceptedIds: ['101'], rejected: [] });
  assert.deepEqual(calls, [{ path: '/v2/actions/products/deactivate', body: { action_id: 17, product_ids: [101] } }]);
});

test('update warnings use requested product IDs and retain warning text', async () => {
  const { ozon } = writing({ active_product_ids: [101], deactivated_product_ids: [], rejected: [], warnings: [
    { product_id: 101, reason: 'LIMIT_CHANGED' },
    { product_id: 999, reason: 'OTHER_PRODUCT' },
    { product_id: 102, message: 'unrelated row' },
  ] });
  const result = await ozon.activate(credential, { actionId: '17', products: [{ productId: '101', price: '110', currency: 'CNY' }] });
  assert.deepEqual(result.warnings, [{ productId: '101', reason: 'LIMIT_CHANGED' }]);
});

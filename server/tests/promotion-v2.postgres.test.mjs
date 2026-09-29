import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPromotionOzon } from '../promotion-ozon.mjs';
import { createPromotionService } from '../promotion-service.mjs';

const money = amount => ({ amount, currency: 'CNY' });
const now = Date.parse('2026-10-14T12:00:00Z');
const futureAt = '2026-10-20T12:00:00Z';
const actions = [
  { id: 11, title: '动态折扣', action_type: 'ELASTIC_BOOSTING', is_voucher_action: false, date_end: '2026-11-01T00:00:00Z', auto_add_dates: [futureAt] },
  { id: 12, title: '促销码', action_type: 'DISCOUNT', is_voucher_action: true, date_end: '2026-11-01T00:00:00Z', auto_add_dates: [] },
];
const rule = (name, actionId, productId, extra = {}) => ({
  name, enabled: false, actionIds: [actionId], productIds: [productId], categoryIds: [],
  minStock: 1, maxDiscountPercent: null, quantity: null,
  schedule: { mode: 'DAILY', time: '21:00', timeZone: 'Asia/Shanghai' }, ...extra,
});

test('Seller v2 Money snapshot, rules, writes, exit and uncertain receipt use real service and adapter', {
  skip: process.env.SONLI_POSTGRES_TESTS !== '1',
}, async () => {
  assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  assert.equal(process.env.DATABASE_URL, process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  const schema = `promotion_v2_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 10 });
    await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT,expires_at TIMESTAMPTZ); CREATE TABLE stores(id TEXT PRIMARY KEY,owner_account_id TEXT,status TEXT); CREATE TABLE products(store_id TEXT,product_id TEXT,image_url TEXT); INSERT INTO accounts VALUES('a','active',NULL); INSERT INTO stores VALUES('s','a','active')");
    await pool.query(await readFile(new URL('../db/migrations/129_promotion_management.sql', import.meta.url), 'utf8'));

    const state = {
      current: new Map([[11, [{ id: 103, action_price: money('70.00'), max_action_price: money('75.00'), marketplace_seller_price: money('90.00'), add_mode: 'AUTO' }]], [12, []]]),
      future: [{ product_id: 103, action_price_to_auto_add: money('70.00'), max_discount_price: money('75.00'), marketplace_seller_price: money('90.00'), add_mode: false }],
      writes: [], loseNextReceipt: false,
    };
    const credential = { clientId: 'fixture', apiKey: 'fixture' };
    const get = async (c, path) => {
      assert.equal(c, credential);
      assert.equal(path, '/v1/actions');
      return { result: actions };
    };
    const call = async (c, path, body) => {
      assert.equal(c, credential);
      if (path === '/v5/product/info/prices') {
        const ids = body.filter.product_id?.map(String) ?? ['101', '102', '103'];
        return { items: ids.map(id => ({ product_id: Number(id), price: { price: '100.00', marketing_seller_price: '90.00', min_price: '0', currency_code: 'CNY' } })), total: ids.length, cursor: '' };
      }
      if (path === '/v2/actions/candidates') {
        const id = body.action_id === 11 ? 101 : 102;
        return { products: [{ id, max_action_price: money('70.00'), marketplace_seller_price: money('90.00'), min_stock: 1 }], total: 1, last_id: '' };
      }
      if (path === '/v2/actions/products') {
        const rows = state.current.get(body.action_id);
        assert.ok(rows, `unexpected action ${body.action_id}`);
        return { products: structuredClone(rows), total: rows.length, last_id: '' };
      }
      if (path === '/v2/actions/auto-add/products/list') {
        assert.equal(String(body.action_id), '11');
        assert.equal(body.auto_add_date, futureAt);
        return { products: structuredClone(state.future), total: state.future.length };
      }
      if (path === '/v3/product/info/list') return { items: body.product_id.map(id => ({ id: Number(id), name: `SKU ${id}`, offer_id: `offer-${id}`, is_archived: false, stocks: { stocks: [{ source: 'fbo', sku: Number(id), warehouse_id: 1, present: 10, reserved: 0 }] } })) };
      if (path === '/v1/product/action/timer/status') return { statuses: [] };
      state.writes.push({ path, body: structuredClone(body) });
      if (path === '/v1/actions/products/update') {
        const active = [], deactivated = [];
        for (const row of body.products) {
          if (body.action_id === 11 && row.product_id === 103 && row.action_price.amount === '100.00') {
            state.current.set(11, state.current.get(11).filter(x => x.id !== 103));
            deactivated.push(103);
          } else {
            const current = state.current.get(body.action_id).filter(x => x.id !== row.product_id);
            current.push({ id: row.product_id, action_price: row.action_price, max_action_price: money('70.00'), marketplace_seller_price: money('90.00'), add_mode: 'SELLER', ...(row.stock ? { stock: row.stock } : {}) });
            state.current.set(body.action_id, current);
            active.push(row.product_id);
          }
        }
        if (state.loseNextReceipt) {
          state.loseNextReceipt = false;
          throw Object.assign(new Error('fixture lost write receipt'), { status: 504 });
        }
        return { active_product_ids: active, deactivated_product_ids: deactivated, rejected: [], warnings: active.includes(101) ? [{ product_id: 101, reason: 'PRICE_CEILING' }] : [] };
      }
      if (path === '/v2/actions/auto-add/products/delete') {
        state.future = state.future.filter(x => !body.product_ids.includes(String(x.product_id)));
        return { product_ids: body.product_ids };
      }
      throw new Error(`unexpected API path ${path}`);
    };
    const ozon = createPromotionOzon({ call, get, clock: () => now });
    const service = createPromotionService({ pool, ozon, clock: () => now, readCredential: async () => credential });
    const scope = { accountId: 'a', storeId: 's' };

    await service.syncStore(scope);
    const overview = await service.overview(scope);
    assert.equal(overview.priceSemantics, 'CEILING');
    assert.deepEqual(overview.actions.map(x => [x.id, x.isVoucher]), [['11', false], ['12', true]]);
    assert.deepEqual(overview.memberships.map(x => [x.productId, x.mode, x.batchAt]), [['103', 'AUTO', ''], ['103', 'AUTO', futureAt]]);
    assert.deepEqual(overview.products.map(x => [x.productId, x.currency, x.basePrice, x.currentPrice, x.availableStock]), [
      ['101', 'CNY', '100.00', '90.00', 10], ['102', 'CNY', '100.00', '90.00', 10], ['103', 'CNY', '100.00', '90.00', 10],
    ]);

    await service.saveRule(scope, rule('动态折扣上限', '11', '101', { maxDiscountPercent: 40 }));
    const capped = (await service.overview(scope)).rules.find(x => x.name === '动态折扣上限');
    let preview = await service.preview(scope, { source: 'RULE', ruleId: capped.id });
    assert.equal(preview.items.length, 0);
    assert.match(preview.skipped[0].reason, /无法确认.*实际卖家价|折扣幅度超过/);
    assert.equal(state.writes.length, 0);

    await service.saveRule(scope, rule('动态折扣报名', '11', '101'));
    const dynamic = (await service.overview(scope)).rules.find(x => x.name === '动态折扣报名');
    preview = await service.preview(scope, { source: 'RULE', ruleId: dynamic.id });
    assert.deepEqual(preview.items.map(x => [x.productId, x.price, x.currency, x.quantity]), [['101', '70.00', 'CNY', null]]);
    await service.execute(scope, preview.id);
    await service.processNext();
    let record = (await service.overview(scope)).records.find(x => x.id === preview.id);
    assert.equal(record.status, 'COMPLETED');
    assert.deepEqual(record.items[0].warnings, ['PRICE_CEILING']);
    assert.deepEqual(state.writes.at(-1), { path: '/v1/actions/products/update', body: { action_id: 11, products: [{ product_id: 101, action_price: money('70.00') }] } });
    const afterJoin = state.writes.length;
    assert.equal((await service.reconcile(scope, preview.id)).status, 'COMPLETED');
    assert.equal(state.writes.length, afterJoin);

    await service.saveRule(scope, rule('促销码报名', '12', '102', { quantity: 3 }));
    const voucher = (await service.overview(scope)).rules.find(x => x.name === '促销码报名');
    preview = await service.preview(scope, { source: 'RULE', ruleId: voucher.id });
    assert.deepEqual(preview.items.map(x => [x.productId, x.price, x.quantity]), [['102', '70.00', 3]]);
    await service.execute(scope, preview.id);
    await service.processNext();
    assert.equal((await service.overview(scope)).records.find(x => x.id === preview.id).status, 'COMPLETED');
    assert.deepEqual(state.writes.at(-1), { path: '/v1/actions/products/update', body: { action_id: 12, products: [{ product_id: 102, action_price: money('70.00'), stock: 3 }] } });

    state.current.get(12)[0].add_mode = 'SELLER';
    preview = await service.preview(scope, { source: 'EXIT' });
    assert.deepEqual(preview.items.map(x => [x.operation, x.productId]), [['EXIT', '103'], ['CANCEL_FUTURE', '103']]);
    assert.deepEqual(preview.items.find(x => x.operation === 'EXIT').price, '100.00');
    await service.execute(scope, preview.id);
    await service.processNext();
    record = (await service.overview(scope)).records.find(x => x.id === preview.id);
    assert.equal(record.status, 'COMPLETED');
    assert.ok(state.writes.some(x => x.path === '/v1/actions/products/update' && x.body.action_id === 11 && x.body.products[0].product_id === 103 && x.body.products[0].action_price.amount === '100.00'));
    assert.ok(state.writes.some(x => x.path === '/v2/actions/auto-add/products/delete' && x.body.action_id === '11' && x.body.auto_add_date === futureAt && x.body.product_ids[0] === '103'));
    assert.equal(state.current.get(12)[0].add_mode, 'SELLER');
    assert.equal(state.future.length, 0);

    // The platform applied the write but its acknowledgement disappeared.
    state.current.set(11, state.current.get(11).filter(x => x.id !== 101));
    preview = await service.preview(scope, { source: 'RULE', ruleId: dynamic.id });
    await service.execute(scope, preview.id);
    state.loseNextReceipt = true;
    const beforeUnknown = state.writes.length;
    await service.processNext();
    assert.equal(state.writes.length, beforeUnknown + 1);
    record = (await service.overview(scope)).records.find(x => x.id === preview.id);
    assert.equal(record.status, 'COMPLETED');
    assert.equal((await service.reconcile(scope, preview.id)).status, 'COMPLETED');
    await service.processNext();
    assert.equal(state.writes.length, beforeUnknown + 1, 'a lost receipt must not resend the applied write');
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardCount, dashboardMoney, dashboardTodos } from '../src/dashboard-model.js';

test('missing and failed dashboard sections never become a zero statistic', () => {
  assert.equal(dashboardCount(null, 'orders', 'pendingCount'), null);
  assert.equal(dashboardCount({ orders: { pendingCount: null } }, 'orders', 'pendingCount'), null);
  assert.equal(dashboardCount({ orders: { pendingCount: 0 } }, 'orders', 'pendingCount'), 0);
  assert.equal(dashboardCount({ orders: { pendingCount: 8 }, errors: { orders: 'read failed' } }, 'orders', 'pendingCount'), null);
});

test('wallet cents retain exact digits beyond the safe floating point range', () => {
  assert.equal(dashboardMoney('28001', 'CNY'), '¥ 280.01');
  assert.equal(dashboardMoney('0', 'CNY'), '¥ 0.00');
  assert.equal(dashboardMoney('900719925474099301', 'CNY'), '¥ 9,007,199,254,740,993.01');
  assert.equal(dashboardMoney('-1', 'CNY'), '¥ -0.01');
  assert.equal(dashboardMoney(null, 'CNY'), '—');
});

test('priority work uses account counts and current-store stock, with no invented zero tasks', () => {
  const summary = {
    ai: { review: 3, failed: 1 }, inspection: { unreadCount: 2 },
    products: { outOfStock: 0, lowStock: 5, attentionCount: 5 }, errors: {},
  };
  const rows = dashboardTodos(summary, true);
  assert.deepEqual(rows.map(row => [row.id, row.count]), [['review', 3], ['failed', 1], ['inspection', 2], ['stock', 5]]);
  const failureLink = new URL(rows[1].path, 'http://local');
  assert.equal(failureLink.searchParams.get('group'), 'all');
  assert.equal(failureLink.searchParams.get('stage'), 'failed');
  assert.match(rows[3].title, /低库存/);
  assert.equal(new URL(rows[3].path, 'http://local').searchParams.get('stock'), '低库存');
  assert.deepEqual(dashboardTodos(summary, false).map(row => row.id), ['review', 'failed', 'inspection']);
});

test('failed source counts cannot appear as actionable work and all-zero data has no priority rows', () => {
  assert.deepEqual(dashboardTodos({ ai: { review: 2, failed: 3 }, errors: { ai: 'unavailable' } }, true), []);
  assert.deepEqual(dashboardTodos({ ai: { review: 0, failed: 0 }, inspection: { unreadCount: 0 }, products: { outOfStock: 0, lowStock: 0 } }, true), []);
});

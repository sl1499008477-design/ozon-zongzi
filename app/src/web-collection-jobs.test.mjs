import test from 'node:test';
import assert from 'node:assert/strict';
import { webCollectionIntent, webCollectionJobView } from './web-collection-jobs.js';

test('retries reuse a request number, but another SKU or scope receives its own intent', () => {
  const one = webCollectionIntent(null, { sku: '3252770347', scope: 'ALL' }, () => 'first');
  assert.deepEqual(one, { sku: '3252770347', scope: 'ALL', requestId: 'first' });
  assert.equal(webCollectionIntent(one, { sku: one.sku, scope: 'ALL' }), one);
  assert.equal(webCollectionIntent(one, { sku: one.sku, scope: 'CURRENT' }, () => 'second').requestId, 'second');
  assert.equal(webCollectionIntent(one, { sku: '3252771243', scope: 'ALL' }, () => 'third').requestId, 'third');
});

test('completed capture is not advertised as enriched or listed; waiting has a recovery action', () => {
  assert.equal(webCollectionJobView({ status: 'COMPLETED' }).label, '资料已回传');
  assert.equal(webCollectionJobView({ status: 'COMPLETED' }).canCancel, false);
  assert.equal(webCollectionJobView({ status: 'COMPLETED', result: { duplicate: true } }).label, '已跳过重复采集');
  assert.equal(webCollectionJobView({ status: 'WAITING' }).retryLabel, '已处理，继续采集');
  assert.equal(webCollectionJobView({ status: 'PROCESSING' }).canRetry, false);
  assert.equal(webCollectionJobView({ status: 'FAILED' }).canRetry, true);
  assert.equal(webCollectionJobView({ status: 'CANCELLED' }).canCancel, false);
});

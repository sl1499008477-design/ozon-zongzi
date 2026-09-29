import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../ai-listing-runtime.mjs';

const input = { accountId: 'owner', sku: '1602438352', taskId: 'ai-one', config: { targetStoreId: 'store' } };
test('Excel uses the same durable extension queue and the persisted job ID after an active-job conflict', async () => {
  let creates = 0;
  const job = { id: 'wc-existing-web-job', status: 'QUEUED', message: '等待已登录的扩展领取' };
  const source = { collectItemId: 'collect-one', sku: input.sku, items: [{ sku: input.sku, images: ['image'] }] };
  const ports = { findExisting: async () => null, webCollection: {
    create: async request => { creates++; assert.equal(request.scope, 'CURRENT'); assert.equal(request.accountId, 'owner'); return structuredClone(job); },
    get: async request => { assert.deepEqual(request, { accountId: 'owner', id: job.id }); return structuredClone(job); },
  }, loadSources: async request => { assert.deepEqual(request.collectItemIds, ['collect-one']); assert.equal(request.accountId, 'owner'); return [source]; } };
  await assert.rejects(() => runtime.collectAiListingSkuSource(input, ports), { code: 'AI_LISTING_COLLECTION_PENDING', collectionJobId: job.id });
  job.status = 'COMPLETED'; job.result = { collectItemId: 'collect-one' };
  assert.deepEqual(await runtime.collectAiListingSkuSource({ ...input, collectionJobId: job.id }, ports), source);
  assert.equal(creates, 1);
});
test('Excel reuses saved account-scoped products and reports failed capture without creating a placeholder', async () => {
  const source = { collectItemId: 'saved', items: [{ sku: input.sku, images: ['image'] }] };
  const ports = { findExisting: async request => { assert.deepEqual(request, { accountId: 'owner', sku: input.sku }); return 'saved'; },
    webCollection: { create: () => assert.fail('saved product must not be collected again'),
      get: async () => ({ id: 'failed', status: 'FAILED', message: '图片读取失败' }) }, loadSources: async () => [source] };
  assert.deepEqual(await runtime.collectAiListingSkuSource(input, ports), source);
  await assert.rejects(() => runtime.collectAiListingSkuSource({ ...input, collectionJobId: 'failed' }, ports), { code: 'AI_LISTING_COLLECTION_FAILED', message: '图片读取失败' });
});

test('Excel cannot substitute an unrequested sibling after its requested SKU was already listed', async () => {
  await assert.rejects(() => runtime.collectAiListingSkuSource(input, { findExisting: async () => 'group', webCollection: {},
    loadSources: async () => [{ collectItemId: 'group', items: [{ sku: '2258957029', images: ['sibling'] }] }],
  }), { code: 'AI_LISTING_ALREADY_LISTED' });
});

test('an Excel row selects only its requested SKU from an existing collected group', async () => {
  const source = { collectItemId: 'group', sku: 'parent', items: [
    { sku: input.sku, images: ['own-image'] }, { sku: '2258957029', images: ['sibling'] },
  ], enrichmentJobs: [{ sku: input.sku, status: 'SUCCESS' }, { sku: '2258957029', status: 'PENDING' }] };
  const result = await runtime.collectAiListingSkuSource(input, { findExisting: async () => 'group', webCollection: {}, loadSources: async () => [source] });
  assert.deepEqual(result.items.map(item => item.sku), [input.sku]);
  assert.deepEqual(result.enrichmentJobs, [{ sku: input.sku, status: 'SUCCESS' }]);
  assert.equal(source.items.length, 2, 'saved group remains unchanged');
});

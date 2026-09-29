import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { normalizeOzonAgentResult } from '../collector-ozon-enrichment-contract.mjs';
import { mergeOzonEnrichmentResult } from '../collect-enrichment-policy.mjs';
import { createCollectorOzonEnrichmentRuntime } from '../collector-ozon-enrichment-runtime.mjs';
import { createJsonStateTransactionBoundary } from '../json-state-transaction.mjs';
import { normalizeOzonImportItems } from '../ozon-import-normalizer.mjs';
import { testExports } from '../index.mjs';

// Representative Seller product evidence, not a claim about a live SKU's media.
const groups = [
  { attributes: [
    { id: 21841, complex_id: 100001, values: [{ value: 'https://cdn.example.test/own/video.mp4' }] },
    { id: 21837, complex_id: 100001, values: [{ value: 'Видео товара' }] },
  ] },
  { attributes: [{ id: 21845, complex_id: 100002, values: [{ value: 'https://cdn.example.test/own/cover.mp4' }] }] },
  { attributes: [{ id: 300, complex_id: 77, values: [{ value: 'Первый', dictionary_value_id: 901 }] }] },
  { attributes: [{ id: 300, complex_id: 77, values: [{ dictionary_value_id: 902 }] }] },
];
const ordinary = Array.from({ length: 110 }, (_, index) => ({ key: String(6000 + index), values: [{ value: 'Значение', dictionary_value_id: index + 1 }] }));
const source = {
  description_category_id: 123, type_id: 456, weight: 500, depth: 300, width: 200, height: 100,
  attributes: [...ordinary, ...[['4497', 500], ['9454', 300], ['9455', 200], ['9456', 100]].map(([key, value]) => ({ key, values: [{ value }] }))],
  complex_attributes: groups,
};

test('normalization keeps every supplied ordinary attribute and each complex group', () => {
  const normalized = normalizeOzonAgentResult({ sku: 'own', variantData: source });
  assert.equal(normalized.sourceCategory.attributes.length, 114);
  assert.deepEqual(normalized.sourceCategory.attributes.find(attr => attr.key === '6109').values, [{ value: 'Значение', dictionary_value_id: 110 }]);
  assert.deepEqual(normalized.sourceCategory.complex_attributes, groups);
});

test('enrichment fills missing complex evidence and leaves saved SKU media and explicit edits intact', () => {
  const normalized = normalizeOzonAgentResult({ sku: 'own', variantData: source });
  const original = { sku: 'own', images: ['https://cdn.example.test/own/1.jpg', 'https://cdn.example.test/own/2.jpg'],
    videos: [{ url: 'https://cdn.example.test/own/original.mp4', coverUrl: 'https://cdn.example.test/own/poster.jpg' }],
    description: '<p>Полное исходное описание</p>', categoryAttributes: [{ id: 85, values: [] }], logistics: { weightG: 777 } };
  const before = structuredClone(original);
  const merged = mergeOzonEnrichmentResult(original, normalized);
  assert.deepEqual(merged.complex_attributes, groups);
  for (const key of ['images', 'videos', 'description', 'categoryAttributes']) assert.deepEqual(merged[key], before[key]);
  assert.equal(merged.logistics.weightG, 777);
  assert.deepEqual(original, before);
  for (const edit of [[], [{ attributes: [{ id: 300, complex_id: 77, values: [] }] }]]) {
    assert.deepEqual(mergeOzonEnrichmentResult({ ...original, complex_attributes: edit }, normalized).complex_attributes, edit);
  }
});

async function withHttpRuntime(run) {
  const now = new Date('2026-09-14T01:00:00.000Z');
  const context = { sellerCompanyId: '12345', revision: 1, observedAt: now.toISOString() };
  const session = { collectorSessionId: 'collector-media', accountId: 'account-media', permissions: ['collector.ozon.read'] };
  const own = { sku: 'own', name: 'Светильник', sellPrice: '100', images: Array.from({ length: 9 }, (_, i) => `https://cdn.example.test/own/${i + 1}.jpg`),
    videos: [{ url: 'https://cdn.example.test/own/video.mp4', coverUrl: 'https://cdn.example.test/own/poster.jpg' }],
    description: '<p>Полное исходное описание</p>', logistics: { weightG: 777 } };
  const sibling = { sku: 'sibling', name: 'Другой светильник', images: ['https://cdn.example.test/sibling/1.jpg'],
    videos: [{ url: 'https://cdn.example.test/sibling/video.mp4' }], description: 'Описание другого SKU' };
  let persisted = {
    collectorSessions: [{ id: session.collectorSessionId, accountId: session.accountId, expiresAt: '2027-01-01T00:00:00.000Z', sellerContext: context }],
    caches: { collectBox: [{ id: 'collect-media', accountId: session.accountId, sku: 'own', status: 'PENDING_ENRICHMENT', draftVersion: 3,
      listingDraft: { sku: 'own', categoryResolution: { status: 'MATCHED', method: 'MANUAL', target: { storeId: 'target', descriptionCategoryId: 123, typeId: 456 } }, variants: [own, sibling] } }] },
    collectorOzonEnrichmentJobs: [{ id: 'job-media', accountId: session.accountId, collectItemId: 'collect-media', requestId: 'request-media', sku: 'own',
      status: 'PROCESSING', claimedSessionId: session.collectorSessionId, claimFence: 'fence-media', captureContext: context,
      claimExpiresAt: '2026-09-14T01:01:00.000Z', deadlineAt: '2027-01-01T00:00:00.000Z',
      createdAt: now.toISOString(), updatedAt: now.toISOString(), nextAttemptAt: now.toISOString(), attemptCount: 1 }],
  };
  const runtime = createCollectorOzonEnrichmentRuntime({
    loadState: async () => structuredClone(persisted), saveState: async state => { persisted = JSON.parse(JSON.stringify(state)); },
    persistenceMode: () => 'json', stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async () => session, authenticateAccount: async () => ({ id: session.accountId }),
    readJson: testExports.readBody, sendJson(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
    now: () => new Date(now),
  });
  const server = http.createServer((req, res) => runtime.handleHttpRoute(req, res, new URL(req.url, 'http://127.0.0.1')).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const post = async variantData => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/collector/ozon/enrichment-jobs/job-media/result`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variantData, captureContext: context, claimFence: 'fence-media' }),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ post, state: () => structuredClone(persisted), own, sibling }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('real HTTP result preserves complex groups through stored per-SKU draft and existing listing builder', async () => {
  await withHttpRuntime(async h => {
    const response = await h.post(source);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const state = h.state();
    assert.equal(state.collectorOzonEnrichmentJobs[0].status, 'SUCCESS');
    const item = state.caches.collectBox[0];
    const [own, sibling] = item.listingDraft.variants;
    assert.equal(item.draftVersion, 4);
    assert.deepEqual(own.complex_attributes, groups);
    assert.equal(own.sourceCategory.attributes.length, 114);
    for (const key of ['images', 'videos', 'description']) assert.deepEqual(own[key], h.own[key]);
    assert.deepEqual(sibling, h.sibling);
    const rows = testExports.buildCollectBoxListingItems(item, 'target');
    assert.deepEqual(rows[0].complex_attributes, groups);
    const imported = await normalizeOzonImportItems([rows[0]], { strictTypeMatch: true,
      getCategoryAttributes: async () => [21841, 21837, 21845, 300, 4191, 9048, ...ordinary.map(attr => Number(attr.key))].map(id => ({ id })),
      getCategoryAttributeValues: async () => [],
    });
    assert.deepEqual(imported.items[0].complex_attributes, groups);
    assert.equal(imported.items[0].attributes.find(attr => attr.id === 4191).values[0].value, '<p>Полное исходное описание</p>');
    assert.deepEqual(imported.items[0].images, h.own.images);
    assert.equal(imported.items[0].primary_image, h.own.images[0]);
  });
});

test('HTTP keeps legacy clients compatible and rejects oversized or unsafe complex evidence before saving', async () => {
  await withHttpRuntime(async h => {
    const before = h.state();
    const excessive = { ...source, attributes: Array.from({ length: 1001 }, (_, i) => ({ key: String(i + 1), values: [{ value: 'Значение' }] })) };
    const tooMany = await h.post(excessive);
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.message, /1000/);
    for (const complex_attributes of [
      {}, [{ attributes: [{ id: 21845, complex_id: 0, values: [{ value: 'https://cdn.example.test/cover.mp4' }] }] }],
      [{ attributes: [{ id: 21845, complex_id: 100002, values: [{ value: 'x', cookie: 'invalid' }] }] }],
      [{ attributes: [{ id: 21845, complex_id: 100002, values: [{ dictionary_value_id: 0 }] }] }],
    ]) assert.equal((await h.post({ ...source, complex_attributes })).status, 400);
    const oversized = await h.post({ ...source, attributes: [{ key: '4191', value: 'a'.repeat(10 * 1024 * 1024) }] });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.code, 'REQUEST_BODY_TOO_LARGE');
    assert.deepEqual(h.state(), before);
    const legacy = { ...source }; delete legacy.complex_attributes;
    const accepted = await h.post(legacy);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  });
});

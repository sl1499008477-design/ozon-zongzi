const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const contract = require('../lib/ozon-enrichment-contract.js');
const { create } = require('../lib/ozon-collect-coordinator.js');

const SKU = '4862904234';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function completeResult(sku = SKU, overrides = {}) {
  return {
    status: 'COMPLETE',
    contractVersion: 'collector.ozon.enrichment.v1',
    sku,
    descriptionCategoryId: 123,
    typeId: 456,
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    variantData: {
      variant_id: `variant-${sku}`,
      _searchMeta: { skus: [{ sku }] },
      description_category_id: 123,
      type_id: 456,
      attributes: [
        { key: '4497', value: '500' },
        { key: '9454', value: '300' },
        { key: '9455', value: '200' },
        { key: '9456', value: '100' },
      ],
    },
    source: 'BACKEND_FLEET',
    capturedAt: '2026-07-31T00:00:00.000Z',
    cache: { hit: false, expiresAt: '2026-07-31T06:00:00.000Z' },
    ...overrides,
  };
}

function localCompleteResult(sku = SKU) {
  return contract.normalizeVariantData({
    sku,
    source: 'EXTENSION_SELLER_CAPTURE',
    capturedAt: '2026-07-31T00:01:00.000Z',
    variantData: completeResult(sku).variantData,
  });
}

function codedError(code, message = code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function loadSharedMessageWrapper(response) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'content', 'shared-utils.js'),
    'utf8',
  );
  const document = {
    createElement: () => ({
      style: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      setAttribute() {},
      appendChild() {},
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    }),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} },
    documentElement: { classList: { contains() { return false; } }, lang: 'ru' },
  };
  const chrome = {
    storage: {
      local: { get: (_key, callback) => callback?.({}), set() {} },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage: (_message, callback) => callback(response),
      onMessage: { addListener() {} },
      getURL: () => '',
      id: 'test',
    },
  };
  const location = { hostname: 'www.ozon.ru', href: 'https://www.ozon.ru/', pathname: '/', search: '' };
  const history = { pushState() {}, replaceState() {} };
  const window = { document, location, history, navigator: {}, addEventListener() {}, isSecureContext: true };
  const sandbox = {
    window,
    document,
    chrome,
    location,
    history,
    navigator: {},
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: function MutationObserver() { this.observe = () => {}; },
    CustomEvent: function CustomEvent() {},
    dispatchEvent() {},
    fetch: () => Promise.reject(new Error('network disabled')),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'shared-utils.js' });
  return window.sendMessage;
}

test('shared message wrapper preserves Task 6 stable error metadata for the coordinator', async () => {
  const sendMessage = loadSharedMessageWrapper({
    ok: false,
    status: 422,
    code: 'OZON_ENRICH_INCOMPLETE',
    error: 'safe backend detail',
    missingFields: ['heightMm', 'descriptionCategoryId'],
    retryable: true,
  });

  await assert.rejects(
    sendMessage('enrichOzonCollect', { requestId: 'stable', sku: SKU }),
    (error) => error?.code === 'OZON_ENRICH_INCOMPLETE'
      && error?.status === 422
      && error?.retryable === true
      && JSON.stringify(error?.missingFields) === JSON.stringify(['heightMm', 'descriptionCategoryId']),
  );
});

test('one SKU prefetch shares its promise, stores one result, and never uploads', async () => {
  const enrichment = deferred();
  const calls = [];
  const coordinator = create({
    now: () => 1000,
    sendMessage(action, payload) {
      calls.push({ action, payload });
      assert.equal(action, 'enrichOzonCollect');
      return enrichment.promise;
    },
  });

  assert.deepEqual(coordinator.getState(SKU), {
    status: 'IDLE',
    requestId: 'ozon-collect-1000-1-4862904234',
  });
  const first = coordinator.prefetch({ sku: SKU });
  const second = coordinator.prefetch({ sku: ` ${SKU} ` });
  assert.strictEqual(second, first, 'same-SKU prefetch must expose the stable in-flight promise');
  assert.equal(coordinator.getState(SKU).status, 'PREFETCHING');
  assert.equal(calls.length, 1);

  const expected = completeResult();
  enrichment.resolve(expected);
  assert.deepEqual(await first, expected);
  assert.strictEqual(await coordinator.prefetch({ sku: SKU }), await first);
  assert.equal(coordinator.getState(SKU).status, 'READY');
  assert.deepEqual(calls.map(({ action }) => action), ['enrichOzonCollect']);
});

test('concurrent collect clicks share one enrichment and one upload before SUCCESS', async () => {
  const enrichment = deferred();
  const upload = deferred();
  const calls = [];
  const coordinator = create({
    now: () => 2000,
    sendMessage(action, payload) {
      calls.push({ action, payload });
      if (action === 'enrichOzonCollect') return enrichment.promise;
      if (action === 'pushSourceCollect') return upload.promise;
      throw new Error(`unexpected action ${action}`);
    },
  });
  const raw = {
    sku: 'WRONG-SKU',
    name: 'search card title',
    image: 'https://cdn.test/card.jpg',
    images: ['https://cdn.test/card.jpg'],
    hashtags: ['#fixture'],
    marketingPrice: '1099',
    marketingPriceCurrency: 'RUB',
    soldCount: 72,
    views: 900,
  };
  const rawSnapshot = structuredClone(raw);

  const first = coordinator.collect({ sku: SKU, raw });
  const second = coordinator.collect({ sku: SKU, raw });
  assert.strictEqual(second, first, 'concurrent clicks must reuse the same collection promise');
  assert.equal(coordinator.getState(SKU).status, 'PREFETCHING');
  enrichment.resolve(completeResult());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(coordinator.getState(SKU).status, 'SAVING');
  assert.equal(calls.filter(({ action }) => action === 'pushSourceCollect').length, 1);
  assert.notEqual(coordinator.getState(SKU).status, 'SUCCESS');
  const uploadCall = calls.find(({ action }) => action === 'pushSourceCollect');
  assert.equal(uploadCall.payload.sourceId, 'ozon');
  assert.equal(uploadCall.payload.requestId, calls[0].payload.requestId);
  assert.deepEqual(uploadCall.payload.raw, {
    ...raw,
    sku: SKU,
    description_category_id: 123,
    type_id: 456,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    weight_unit: 'g',
    dimension_unit: 'mm',
    variantData: completeResult().variantData,
  });
  assert.deepEqual(raw, rawSnapshot, 'collection must not mutate the page payload');

  upload.resolve({ dedupeHit: false, lastAt: null, result: { id: 'collect-1' } });
  assert.deepEqual(await first, { dedupeHit: false, result: { id: 'collect-1' } });
  assert.equal(coordinator.getState(SKU).status, 'SUCCESS');
  assert.strictEqual(await coordinator.collect({ sku: SKU, raw }), await first);
  assert.equal(calls.filter(({ action }) => action === 'pushSourceCollect').length, 1);
});

test('auth failures enter BLOCKED_AUTH with approved Chinese guidance and no upload', async () => {
  const coordinator = create({
    sendMessage: async () => {
      throw codedError('COLLECTOR_AUTH_REQUIRED', 'backend detail must not replace approved guidance', {
        status: 401,
      });
    },
  });

  await assert.rejects(
    coordinator.collect({ sku: SKU, raw: { sku: SKU } }),
    (error) => error?.code === 'COLLECTOR_AUTH_REQUIRED' && error?.message === '请先登录 Web',
  );
  const state = coordinator.getState(SKU);
  assert.equal(state.status, 'BLOCKED_AUTH');
  assert.equal(state.error.message, '请先登录 Web');
});

test('incomplete enrichment enters ERROR with a stable ordered missing-field message', async () => {
  const calls = [];
  const coordinator = create({
    sendMessage: async (action) => {
      calls.push(action);
      throw codedError('OZON_ENRICH_INCOMPLETE', 'unordered backend message', {
        status: 422,
        missingFields: ['heightMm', 'descriptionCategoryId', 'widthMm', 'heightMm'],
        retryable: true,
      });
    },
  });

  await assert.rejects(
    coordinator.prefetch({ sku: SKU }),
    (error) => error?.message === '缺少：类目、宽、高'
      && error?.code === 'OZON_ENRICH_INCOMPLETE'
      && error?.retryable === true,
  );
  assert.equal(coordinator.getState(SKU).status, 'ERROR');
  assert.equal(calls.includes('pushSourceCollect'), false);
});

test('a complete local v1 fallback may upload after backend failure', async () => {
  const calls = [];
  const fallbackCalls = [];
  const coordinator = create({
    now: () => 3000,
    sendMessage: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'enrichOzonCollect') {
        throw codedError('OZON_ENRICH_UPSTREAM_FAILED', 'temporary backend failure', {
          status: 502,
          retryable: true,
        });
      }
      return { dedupeHit: true, result: { id: 'local-fallback-collect' } };
    },
  });

  const outcome = await coordinator.collect({
    sku: SKU,
    raw: { sku: SKU, name: 'local title' },
    async localFallback(input) {
      fallbackCalls.push(input);
      return localCompleteResult();
    },
  });

  assert.deepEqual(fallbackCalls, [{ sku: SKU }]);
  assert.deepEqual(outcome, { dedupeHit: true, result: { id: 'local-fallback-collect' } });
  assert.equal(coordinator.getState(SKU).status, 'SUCCESS');
  assert.deepEqual(calls.map(({ action }) => action), ['enrichOzonCollect', 'pushSourceCollect']);
});

test('an incomplete or non-v1 local fallback cannot upload or reach SUCCESS', async () => {
  for (const fallback of [
    () => ({
      ...localCompleteResult(),
      logistics: { weightG: 500, lengthMm: 300, widthMm: 0, heightMm: 100 },
    }),
    () => ({ ...localCompleteResult(), contractVersion: 'collector.ozon.enrichment.v2' }),
    () => ({
      ...localCompleteResult(),
      descriptionCategoryId: '123',
      logistics: { weightG: '500', lengthMm: '300', widthMm: '200', heightMm: '100' },
      source: 123,
    }),
  ]) {
    const calls = [];
    const coordinator = create({
      sendMessage: async (action) => {
        calls.push(action);
        throw codedError('OZON_ENRICH_UPSTREAM_FAILED', 'backend unavailable', { retryable: true });
      },
    });

    await assert.rejects(coordinator.collect({
      sku: SKU,
      raw: { sku: SKU },
      localFallback: fallback,
    }));
    assert.equal(coordinator.getState(SKU).status, 'ERROR');
    assert.equal(calls.includes('pushSourceCollect'), false);
    assert.notEqual(coordinator.getState(SKU).status, 'SUCCESS');
  }
});

test('a local fallback cannot upload variantData belonging to a different SKU', async () => {
  const calls = [];
  const coordinator = create({
    sendMessage: async (action) => {
      calls.push(action);
      if (action === 'enrichOzonCollect') {
        throw codedError('OZON_ENRICH_UPSTREAM_FAILED', 'backend unavailable', {
          retryable: true,
        });
      }
      return { dedupeHit: false, result: { id: 'must-not-upload' } };
    },
  });
  const crossSkuResult = localCompleteResult();
  crossSkuResult.variantData._searchMeta = { skus: [{ sku: 'DIFFERENT-SKU' }] };

  await assert.rejects(
    coordinator.collect({
      sku: SKU,
      raw: { sku: SKU },
      localFallback: () => crossSkuResult,
    }),
    (error) => error?.code === 'OZON_ENRICH_CONTRACT_MISMATCH',
  );
  assert.equal(calls.includes('pushSourceCollect'), false);
  assert.equal(coordinator.getState(SKU).status, 'ERROR');
});

test('network upload retry reuses the stable request ID and complete result', async () => {
  const calls = [];
  let uploadAttempt = 0;
  const coordinator = create({
    now: () => 4000,
    sendMessage: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'enrichOzonCollect') return completeResult();
      uploadAttempt += 1;
      if (uploadAttempt === 1) {
        throw codedError('NETWORK_ERROR', 'socket unavailable', { retryable: true });
      }
      return { dedupeHit: false, result: { id: 'retry-ok' } };
    },
  });

  await assert.rejects(
    coordinator.collect({ sku: SKU, raw: { sku: SKU } }),
    (error) => error?.message === '网络错误，请稍后重试',
  );
  assert.equal(coordinator.getState(SKU).status, 'ERROR');
  assert.notEqual(coordinator.getState(SKU).status, 'SUCCESS');

  assert.deepEqual(
    await coordinator.collect({ sku: SKU, raw: { sku: SKU } }),
    { dedupeHit: false, result: { id: 'retry-ok' } },
  );
  const enrichCalls = calls.filter(({ action }) => action === 'enrichOzonCollect');
  const uploadCalls = calls.filter(({ action }) => action === 'pushSourceCollect');
  assert.equal(enrichCalls.length, 1, 'upload retry must reuse the stored complete result');
  assert.equal(uploadCalls.length, 2);
  assert.equal(uploadCalls[0].payload.requestId, enrichCalls[0].payload.requestId);
  assert.equal(uploadCalls[1].payload.requestId, enrichCalls[0].payload.requestId);
  assert.deepEqual(uploadCalls[1].payload.raw, uploadCalls[0].payload.raw);
  assert.equal(coordinator.getState(SKU).status, 'SUCCESS');
});

test('prefetchBatch preserves first-seen order and splits 21 new SKUs into 20 and 1', async () => {
  const input = Array.from({ length: 21 }, (_, index) => String(9000000000 + index));
  const calls = [];
  const coordinator = create({
    now: () => 5000,
    sendMessage: async (action, payload) => {
      calls.push({ action, payload });
      assert.equal(action, 'enrichOzonCollectBatch');
      return payload.skus.map((sku) => ({ sku, status: 'COMPLETE', result: completeResult(sku) }));
    },
  });

  const results = await coordinator.prefetchBatch({
    skus: [input[0], input[1], input[0], ...input.slice(2)],
  });
  assert.deepEqual(results.map(({ sku }) => sku), input);
  assert.deepEqual(calls.map(({ payload }) => payload.skus.length), [20, 1]);
  assert.deepEqual(calls.flatMap(({ payload }) => payload.skus), input);
  assert.equal(calls.some(({ action }) => action === 'pushSourceCollect'), false);
  assert.equal(input.every((sku) => coordinator.getState(sku).status === 'READY'), true);
});

test('prefetchBatch reuses READY entries and isolates per-item errors', async () => {
  const readySku = '7000000001';
  const goodSku = '7000000002';
  const badSku = '7000000003';
  const calls = [];
  const coordinator = create({
    now: () => 6000,
    sendMessage: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'enrichOzonCollect') return completeResult(readySku);
      return [
        { sku: goodSku, status: 'COMPLETE', result: completeResult(goodSku) },
        {
          sku: badSku,
          status: 'ERROR',
          error: {
            code: 'OZON_ENRICH_NOT_FOUND',
            message: 'backend detail',
            missingFields: [],
            retryable: true,
          },
        },
      ];
    },
  });

  const ready = await coordinator.prefetch({ sku: readySku });
  const results = await coordinator.prefetchBatch({ skus: [readySku, goodSku, badSku] });
  assert.strictEqual(results[0], ready);
  assert.equal(results[1].sku, goodSku);
  assert.equal(results[2].sku, badSku);
  assert.equal(results[2].status, 'ERROR');
  assert.equal(results[2].error.message, '未找到该商品的完整资料');
  assert.deepEqual(
    calls.find(({ action }) => action === 'enrichOzonCollectBatch').payload.skus,
    [goodSku, badSku],
  );
  assert.equal(coordinator.getState(readySku).status, 'READY');
  assert.equal(coordinator.getState(goodSku).status, 'READY');
  assert.equal(coordinator.getState(badSku).status, 'ERROR');
});

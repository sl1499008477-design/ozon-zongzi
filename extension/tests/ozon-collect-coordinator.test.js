const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const contract = require('../lib/ozon-enrichment-contract.js');
const { create, getPageCoordinator } = require('../lib/ozon-collect-coordinator.js');

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
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    sendMessage(action, payload) {
      calls.push({ action, payload });
      assert.equal(action, 'enrichOzonCollect');
      return enrichment.promise;
    },
  });

  assert.deepEqual(coordinator.getState(SKU), {
    status: 'IDLE',
    requestId: 'ozon-collect-1000-11111111-1111-4111-8111-111111111111-1-4862904234',
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

test('coordinator instances created in the same millisecond use distinct high-entropy request IDs', () => {
  const first = create({
    now: () => 1000,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    sendMessage: async () => completeResult(),
  });
  const second = create({
    now: () => 1000,
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
    sendMessage: async () => completeResult(),
  });

  const firstId = first.getState(SKU).requestId;
  const secondId = second.getState(SKU).requestId;
  assert.notEqual(firstId, secondId);
  assert.match(firstId, /11111111-1111-4111-8111-111111111111/);
  assert.match(secondId, /22222222-2222-4222-8222-222222222222/);
});

test('page integrations reuse one global coordinator instance', () => {
  const first = getPageCoordinator({
    now: () => 1000,
    randomUUID: () => '33333333-3333-4333-8333-333333333333',
    sendMessage: async () => completeResult(),
  });
  const second = getPageCoordinator({
    now: () => 2000,
    randomUUID: () => '44444444-4444-4444-8444-444444444444',
    sendMessage: async () => completeResult(),
  });

  assert.strictEqual(second, first);
  assert.match(first.getState(SKU).requestId, /33333333-3333-4333-8333-333333333333/);
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

  upload.resolve({ dedupeHit: false, result: { id: 'collect-1' } });
  assert.deepEqual(await first, { dedupeHit: false, result: { id: 'collect-1' } });
  assert.equal(coordinator.getState(SKU).status, 'SUCCESS');
  assert.strictEqual(await coordinator.collect({ sku: SKU, raw }), await first);
  assert.equal(calls.filter(({ action }) => action === 'pushSourceCollect').length, 1);
});

test('final upload preserves page-only rich and multivariant fields while server enrichment stays authoritative', async () => {
  const calls = [];
  const coordinator = create({
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    randomUUID: () => '55555555-5555-4555-8555-555555555555',
    async sendMessage(action, payload) {
      calls.push({ action, payload });
      if (action === 'enrichOzonCollect') return completeResult();
      if (action === 'pushSourceCollect') {
        return { dedupeHit: false, result: { id: 'preserved-product' } };
      }
      throw new Error(`unexpected action ${action}`);
    },
  });
  const variants = [
    { sku: SKU, name: 'Blue', sourceVariant: { description_category_id: 999 } },
    { sku: '4862904235', name: 'Red', sourceVariant: { description_category_id: 998 } },
  ];

  await coordinator.collect({
    sku: SKU,
    raw: {
      sku: SKU,
      name: 'Page title',
      images: ['https://cdn.test/page.jpg'],
      videoUrl: 'https://cdn.test/video.mp4',
      sellerName: 'Page seller',
      variantData: {
        variant_id: 'page-variant',
        _searchMeta: { skus: [{ sku: SKU }] },
        description_category_id: 999,
        description: 'Page description',
        hashtags: ['#page'],
        variants,
        attributes: [
          { key: '4497', value: '1' },
          { key: '11254', value: '{"content":"page rich content"}' },
        ],
      },
    },
  });

  const upload = calls.find(({ action }) => action === 'pushSourceCollect').payload.raw;
  assert.equal(upload.name, 'Page title');
  assert.deepEqual(upload.images, ['https://cdn.test/page.jpg']);
  assert.equal(upload.videoUrl, 'https://cdn.test/video.mp4');
  assert.equal(upload.sellerName, 'Page seller');
  assert.equal(upload.variantData.description_category_id, 123);
  assert.equal(upload.variantData.description, 'Page description');
  assert.deepEqual(upload.variantData.hashtags, ['#page']);
  assert.deepEqual(upload.variantData.variants, variants);
  assert.deepEqual(
    upload.variantData.attributes.filter(({ key }) => ['4497', '11254'].includes(String(key))),
    [
      { key: '4497', value: '500' },
      { key: '11254', value: '{"content":"page rich content"}' },
    ],
  );
});

test('malformed upload resolutions stay ERROR and never become SUCCESS', async () => {
  class UploadEnvelope {
    constructor(result) {
      this.dedupeHit = false;
      this.result = result;
    }
  }
  class UploadResult {
    constructor() {
      this.id = 'class-instance';
    }
  }
  for (const response of [
    undefined,
    { dedupeHit: false, result: null },
    { dedupeHit: 0, result: { id: 'bad-boolean' } },
    { dedupeHit: false, result: { id: 'extra-key' }, lastAt: null },
    { dedupeHit: false, result: [] },
    { dedupeHit: false, result: new Date('2026-07-31T00:00:00.000Z') },
    { dedupeHit: false, result: new Map([['id', 'map-instance']]) },
    { dedupeHit: false, result: new Set(['set-instance']) },
    { dedupeHit: false, result: new UploadResult() },
    new UploadEnvelope({ id: 'class-envelope' }),
    Object.assign(() => {}, { dedupeHit: false, result: { id: 'function-envelope' } }),
  ]) {
    const coordinator = create({
      sendMessage: async (action) => action === 'enrichOzonCollect'
        ? completeResult()
        : response,
    });

    await assert.rejects(
      coordinator.collect({ sku: SKU, raw: { sku: SKU } }),
      (error) => error?.code === 'COLLECTOR_UPLOAD_FAILED',
    );
    assert.equal(coordinator.getState(SKU).status, 'ERROR');
  }
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

test('upload 401 and 403 enter BLOCKED_AUTH even when the stable code is absent', async () => {
  for (const [status, expectedCode, expectedMessage] of [
    [401, 'COLLECTOR_AUTH_REQUIRED', '请先登录 Web'],
    [403, 'COLLECTOR_PERMISSION_DENIED', '请重新连接 Web 采集授权'],
  ]) {
    const coordinator = create({
      sendMessage: async (action) => {
        if (action === 'enrichOzonCollect') return completeResult();
        throw Object.assign(new Error('unsafe upstream upload detail'), { status });
      },
    });

    await assert.rejects(
      coordinator.collect({ sku: SKU, raw: { sku: SKU } }),
      (error) => error?.code === expectedCode && error?.message === expectedMessage,
    );
    assert.equal(coordinator.getState(SKU).status, 'BLOCKED_AUTH');
  }
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

test('background prefetch reuses ERROR until collect explicitly retries', async () => {
  const calls = [];
  let enrichAttempt = 0;
  const coordinator = create({
    sendMessage: async (action) => {
      calls.push(action);
      if (action === 'enrichOzonCollect') {
        enrichAttempt += 1;
        if (enrichAttempt === 1) {
          throw codedError('OZON_ENRICH_UPSTREAM_FAILED', 'temporary outage', {
            status: 502,
            retryable: true,
          });
        }
        return completeResult();
      }
      return { dedupeHit: false, result: { id: 'explicit-retry' } };
    },
  });

  await assert.rejects(coordinator.prefetch({ sku: SKU }));
  await assert.rejects(coordinator.prefetch({ sku: SKU }));
  assert.equal(calls.filter((action) => action === 'enrichOzonCollect').length, 1);

  assert.deepEqual(
    await coordinator.collect({ sku: SKU, raw: { sku: SKU } }),
    { dedupeHit: false, result: { id: 'explicit-retry' } },
  );
  assert.equal(calls.filter((action) => action === 'enrichOzonCollect').length, 2);
  assert.equal(calls.filter((action) => action === 'pushSourceCollect').length, 1);
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
  const firstRaw = {
    sku: SKU,
    price: '1099',
    soldCount: 72,
    hashtags: ['#first'],
    stats: { views: 900 },
  };
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
    coordinator.collect({ sku: SKU, raw: firstRaw }),
    (error) => error?.message === '网络错误，请稍后重试',
  );
  assert.equal(coordinator.getState(SKU).status, 'ERROR');
  assert.notEqual(coordinator.getState(SKU).status, 'SUCCESS');
  const firstUpload = calls.find(({ action }) => action === 'pushSourceCollect');
  const firstUploadJson = JSON.stringify(firstUpload.payload);
  assert.equal(Object.isFrozen(firstUpload.payload), true);
  assert.equal(firstUpload.payload.capturedAt, new Date(4000).toISOString());
  assert.equal(Object.isFrozen(firstUpload.payload.raw), true);
  assert.equal(Object.isFrozen(firstUpload.payload.raw.hashtags), true);
  assert.equal(Object.isFrozen(firstUpload.payload.raw.stats), true);
  firstRaw.price = '9999';
  firstRaw.soldCount = 999;
  firstRaw.hashtags.push('#mutated');
  firstRaw.stats.views = 9999;

  assert.deepEqual(
    await coordinator.collect({
      sku: SKU,
      raw: {
        sku: SKU,
        price: '2222',
        soldCount: 222,
        hashtags: ['#second'],
        stats: { views: 2222 },
      },
    }),
    { dedupeHit: false, result: { id: 'retry-ok' } },
  );
  const enrichCalls = calls.filter(({ action }) => action === 'enrichOzonCollect');
  const uploadCalls = calls.filter(({ action }) => action === 'pushSourceCollect');
  assert.equal(enrichCalls.length, 1, 'upload retry must reuse the stored complete result');
  assert.equal(uploadCalls.length, 2);
  assert.equal(uploadCalls[0].payload.requestId, enrichCalls[0].payload.requestId);
  assert.equal(uploadCalls[1].payload.requestId, enrichCalls[0].payload.requestId);
  assert.equal(JSON.stringify(uploadCalls[1].payload), firstUploadJson);
  assert.deepEqual(uploadCalls[1].payload.raw, uploadCalls[0].payload.raw);
  assert.equal(coordinator.getState(SKU).status, 'SUCCESS');
});

test('non-JSON collection payloads fail with one stable error and never expose clone details', async () => {
  const circular = { sku: SKU, label: 'cycle-root' };
  circular.self = circular;
  for (const raw of [
    { sku: SKU, unsafeCount: 1n },
    circular,
  ]) {
    const calls = [];
    const coordinator = create({
      sendMessage: async (action, payload) => {
        calls.push({ action, payload });
        if (action === 'enrichOzonCollect') return completeResult();
        return { dedupeHit: false, result: { id: 'must-not-upload' } };
      },
    });

    await assert.rejects(
      coordinator.collect({ sku: SKU, raw }),
      (error) => {
        assert.equal(error?.code, 'COLLECT_PAYLOAD_INVALID');
        assert.equal(error?.status, 422);
        assert.equal(error?.retryable, false);
        assert.equal(error?.message, '采集数据格式无效，请刷新页面后重试');
        assert.doesNotMatch(
          `${error?.code} ${error?.message}`,
          /BigInt|circular|cyclic|constructor|property|JSON/i,
        );
        return true;
      },
    );
    assert.equal(calls.some(({ action }) => action === 'pushSourceCollect'), false);
    assert.equal(coordinator.getState(SKU).status, 'ERROR');
    assert.equal(coordinator.getState(SKU).error.code, 'COLLECT_PAYLOAD_INVALID');
  }
});

test('undefined payload values keep standard JSON omission and array-null semantics', async () => {
  let uploaded;
  const coordinator = create({
    now: () => 7000,
    sendMessage: async (action, payload) => {
      if (action === 'enrichOzonCollect') return completeResult();
      uploaded = payload;
      return { dedupeHit: false, result: { id: 'undefined-json-ok' } };
    },
  });

  assert.deepEqual(
    await coordinator.collect({
      sku: SKU,
      raw: {
        sku: SKU,
        omitted: undefined,
        nested: { kept: 'yes', omitted: undefined },
        list: [1, undefined, 3],
      },
    }),
    { dedupeHit: false, result: { id: 'undefined-json-ok' } },
  );
  assert.equal(Object.hasOwn(uploaded.raw, 'omitted'), false);
  assert.deepEqual(uploaded.raw.nested, { kept: 'yes' });
  assert.deepEqual(uploaded.raw.list, [1, null, 3]);
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

test('repeated batch prefetch reuses ERROR and BLOCKED_AUTH until a click retries one SKU', async () => {
  const failedSku = '7100000001';
  const authSku = '7100000002';
  const calls = [];
  const coordinator = create({
    sendMessage: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'enrichOzonCollectBatch') {
        return [
          {
            sku: failedSku,
            status: 'ERROR',
            error: {
              code: 'OZON_ENRICH_UPSTREAM_FAILED',
              message: 'backend unavailable',
              missingFields: [],
              retryable: true,
            },
          },
          {
            sku: authSku,
            status: 'ERROR',
            error: {
              code: 'COLLECTOR_AUTH_REQUIRED',
              message: 'login expired',
              missingFields: [],
              retryable: false,
            },
          },
        ];
      }
      if (action === 'enrichOzonCollect') return completeResult(authSku);
      return { dedupeHit: false, result: { id: 'auth-recovered' } };
    },
  });

  const first = await coordinator.prefetchBatch({ skus: [failedSku, authSku] });
  const second = await coordinator.prefetchBatch({ skus: [failedSku, authSku] });
  assert.equal(first[0].status, 'ERROR');
  assert.equal(first[1].status, 'ERROR');
  assert.equal(second[0].error.code, 'OZON_ENRICH_UPSTREAM_FAILED');
  assert.equal(second[1].error.code, 'COLLECTOR_AUTH_REQUIRED');
  assert.equal(calls.filter(({ action }) => action === 'enrichOzonCollectBatch').length, 1);
  assert.equal(coordinator.getState(failedSku).status, 'ERROR');
  assert.equal(coordinator.getState(authSku).status, 'BLOCKED_AUTH');

  assert.deepEqual(
    await coordinator.collect({ sku: authSku, raw: { sku: authSku } }),
    { dedupeHit: false, result: { id: 'auth-recovered' } },
  );
  assert.equal(calls.filter(({ action }) => action === 'enrichOzonCollect').length, 1);
});

test('user-initiated batch retry recovers a failed or blocked anchor with its stable request ID', async () => {
  for (const [code, expectedState] of [
    ['OZON_ENRICH_UPSTREAM_FAILED', 'ERROR'],
    ['COLLECTOR_AUTH_REQUIRED', 'BLOCKED_AUTH'],
  ]) {
    const sku = code === 'COLLECTOR_AUTH_REQUIRED' ? '7200000002' : '7200000001';
    const calls = [];
    const coordinator = create({
      now: () => 8000,
      randomUUID: () => code === 'COLLECTOR_AUTH_REQUIRED'
        ? '77777777-7777-4777-8777-777777777777'
        : '66666666-6666-4666-8666-666666666666',
      async sendMessage(action, payload) {
        calls.push({ action, payload });
        if (action === 'enrichOzonCollect') {
          throw codedError(code, code);
        }
        if (action === 'enrichOzonCollectBatch') {
          return [{ sku, status: 'COMPLETE', result: completeResult(sku) }];
        }
        throw new Error(`unexpected action ${action}`);
      },
    });

    await assert.rejects(coordinator.prefetch({ sku }));
    const requestId = coordinator.getState(sku).requestId;
    assert.equal(coordinator.getState(sku).status, expectedState);

    const background = await coordinator.prefetchBatch({ skus: [sku] });
    assert.equal(background[0].status, 'ERROR');
    assert.equal(calls.filter(({ action }) => action === 'enrichOzonCollectBatch').length, 0);

    const recovered = await coordinator.prefetchBatch({ skus: [sku], retryFailed: true });
    assert.equal(recovered[0].sku, sku);
    assert.equal(coordinator.getState(sku).status, 'READY');
    const retryCall = calls.find(({ action }) => action === 'enrichOzonCollectBatch');
    assert.deepEqual(retryCall.payload.skus, [sku]);
    assert.equal(retryCall.payload.requestId, requestId);
  }
});

test('failed user batch retry replaces the stored error and keeps the stable request ID', async () => {
  const sku = '7200000003';
  const calls = [];
  const coordinator = create({
    now: () => 8500,
    randomUUID: () => '99999999-9999-4999-8999-999999999999',
    async sendMessage(action, payload) {
      calls.push({ action, payload });
      if (action === 'enrichOzonCollect') {
        throw codedError('OZON_ENRICH_UPSTREAM_FAILED', 'first failure');
      }
      if (action === 'enrichOzonCollectBatch') {
        return [{
          sku,
          status: 'ERROR',
          error: {
            code: 'OZON_ENRICH_INCOMPLETE',
            message: 'missing dimensions after retry',
            missingFields: ['lengthMm', 'widthMm'],
            retryable: true,
          },
        }];
      }
      throw new Error(`unexpected action ${action}`);
    },
  });

  await assert.rejects(coordinator.prefetch({ sku }));
  const requestId = coordinator.getState(sku).requestId;
  const retried = await coordinator.prefetchBatch({ skus: [sku], retryFailed: true });

  assert.equal(retried[0].status, 'ERROR');
  assert.equal(retried[0].error.code, 'OZON_ENRICH_INCOMPLETE');
  assert.deepEqual(retried[0].error.missingFields, ['lengthMm', 'widthMm']);
  assert.equal(coordinator.getState(sku).error.message, '缺少：长、宽');
  assert.equal(coordinator.getState(sku).requestId, requestId);
  assert.equal(calls.at(-1).payload.requestId, requestId);
});

test('concurrent user batch retries isolate the failed sibling and share one retry and upload', async () => {
  const anchorSku = '7300000001';
  const failedSiblingSku = '7300000002';
  const retry = deferred();
  const upload = deferred();
  const calls = [];
  let batchAttempt = 0;
  const coordinator = create({
    now: () => 9000,
    randomUUID: () => '88888888-8888-4888-8888-888888888888',
    sendMessage(action, payload) {
      calls.push({ action, payload });
      if (action === 'enrichOzonCollectBatch') {
        batchAttempt += 1;
        if (batchAttempt === 1) {
          return Promise.resolve([
            { sku: anchorSku, status: 'COMPLETE', result: completeResult(anchorSku) },
            {
              sku: failedSiblingSku,
              status: 'ERROR',
              error: {
                code: 'OZON_ENRICH_INCOMPLETE',
                message: 'missing sibling weight',
                missingFields: ['weightG'],
                retryable: true,
              },
            },
          ]);
        }
        return retry.promise;
      }
      if (action === 'pushSourceCollect') return upload.promise;
      throw new Error(`unexpected action ${action}`);
    },
  });

  const initial = await coordinator.prefetchBatch({ skus: [anchorSku, failedSiblingSku] });
  assert.equal(initial[0].sku, anchorSku);
  assert.equal(initial[1].status, 'ERROR');
  const failedRequestId = coordinator.getState(failedSiblingSku).requestId;

  const userFlow = async () => {
    const gated = await coordinator.prefetchBatch({
      skus: [anchorSku, failedSiblingSku],
      retryFailed: true,
    });
    assert.deepEqual(gated.map(({ sku }) => sku), [anchorSku, failedSiblingSku]);
    return coordinator.collect({ sku: anchorSku, raw: { sku: anchorSku } });
  };
  const first = userFlow();
  const second = userFlow();

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(batchAttempt, 2);
  const retryCalls = calls.filter(({ action }) => action === 'enrichOzonCollectBatch');
  assert.deepEqual(retryCalls[1].payload.skus, [failedSiblingSku]);
  assert.equal(retryCalls[1].payload.requestId, failedRequestId);
  assert.equal(coordinator.getState(anchorSku).status, 'READY');
  assert.equal(coordinator.getState(failedSiblingSku).status, 'PREFETCHING');

  retry.resolve([{
    sku: failedSiblingSku,
    status: 'COMPLETE',
    result: completeResult(failedSiblingSku),
  }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(({ action }) => action === 'pushSourceCollect').length, 1);
  upload.resolve({ dedupeHit: false, result: { id: 'shared-product-upload' } });

  assert.strictEqual(await second, await first);
  assert.equal(coordinator.getState(failedSiblingSku).status, 'READY');
  assert.equal(calls.filter(({ action }) => action === 'enrichOzonCollectBatch').length, 2);
  assert.equal(calls.filter(({ action }) => action === 'pushSourceCollect').length, 1);
});

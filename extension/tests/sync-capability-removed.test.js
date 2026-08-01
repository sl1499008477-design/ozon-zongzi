const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { chromeMatchPatternCovers } = require('./helpers/chrome-match-pattern.js');

const extensionRoot = path.resolve(
  process.env.SONLI_EXTENSION_ROOT || path.join(__dirname, '..'),
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'),
);

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

function createStorageArea(initial = {}) {
  const state = { ...initial };
  const select = (keys) => {
    if (keys == null) return { ...state };
    if (typeof keys === 'string') return { [keys]: state[keys] };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, state[key]]));
    }
    return Object.fromEntries(
      Object.entries(keys).map(([key, fallback]) => [
        key,
        state[key] === undefined ? fallback : state[key],
      ]),
    );
  };
  return {
    state,
    get(keys, callback) {
      const result = select(keys);
      if (callback) callback(result);
      else return Promise.resolve(result);
    },
    set(values, callback) {
      Object.assign(state, values || {});
      if (callback) callback();
      else return Promise.resolve();
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
      if (callback) callback();
      else return Promise.resolve();
    },
  };
}

function loadServiceWorker({
  fetchImpl,
  sellerCapture = false,
  executeScriptImpl,
  localInitial = {},
  rejectPendingUploadWrite = false,
} = {}) {
  const workerPath = path.join(extensionRoot, manifest.background.service_worker);
  const runtimeOnInstalled = createEvent();
  const runtimeOnStartup = createEvent();
  const runtimeOnMessage = createEvent();
  const alarmsOnAlarm = createEvent();
  const createdAlarms = [];
  const fetchCalls = [];
  const executeScriptCalls = [];
  const intervalCalls = [];
  const runtimeSendMessageCalls = [];
  const importedScripts = [];
  const session = createStorageArea({
    sonliCollectorSession: {
      collectorToken: 'csess_behavior_test_secret_123456789',
      expiresAt: '2099-01-01T00:00:00.000Z',
      account: { id: 'account-behavior', displayName: 'Behavior' },
      permissions: [
        'collector.upload',
        'collector.job.read',
        'collector.config.read',
        'collector.ozon.read',
      ],
    },
  });
  const local = createStorageArea(localInitial);
  if (rejectPendingUploadWrite) {
    const set = local.set.bind(local);
    local.set = (values, callback) => {
      if (
        Object.hasOwn(values || {}, 'sonliCollectorPendingUploads')
        && (
          rejectPendingUploadWrite === 'all'
          || values.sonliCollectorPendingUploads.length > 0
        )
      ) {
        const error = Object.assign(
          new Error('unsafe storage cst_do-not-leak-queue-write'),
          { code: 'EVIL_STORAGE_WRITE_FAILURE' },
        );
        if (callback) {
          callback();
          return undefined;
        }
        return Promise.reject(error);
      }
      return set(values, callback);
    };
  }
  const sync = createStorageArea();
  const event = createEvent();
  let context;
  const chrome = {
    action: { openPopup: async () => {} },
    alarms: {
      create(name, options) {
        createdAlarms.push({ name, options });
      },
      onAlarm: alarmsOnAlarm,
    },
    contextMenus: {
      removeAll(callback) {
        callback?.();
      },
      create() {},
      onClicked: event,
    },
    cookies: {
      getAll: async () => sellerCapture
        ? [{ name: 'sc_company_id', value: '1234', domain: '.seller.ozon.ru' }]
        : [],
    },
    notifications: {
      create() {},
      clear() {},
      onClicked: event,
    },
    runtime: {
      id: 'sync-capability-test',
      getManifest: () => manifest,
      getPlatformInfo(callback) {
        callback?.({});
      },
      getURL: (entry) => `chrome-extension://sync-capability-test/${entry}`,
      lastError: null,
      onInstalled: runtimeOnInstalled,
      onMessage: runtimeOnMessage,
      onStartup: runtimeOnStartup,
      async sendMessage(...args) {
        runtimeSendMessageCalls.push(args);
        throw new Error('service worker must not self-send searchVariants');
      },
    },
    scripting: {
      async executeScript(input) {
        executeScriptCalls.push(input);
        const result = executeScriptImpl ? await executeScriptImpl(input) : [];
        return vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(result))})`, context);
      },
    },
    storage: { local, session, sync },
    tabs: {
      create: async () => ({ id: 1 }),
      onCreated: event,
      onRemoved: event,
      onUpdated: event,
      query: async () => sellerCapture
        ? [{
            id: 9,
            url: 'https://seller.ozon.ru/app/products',
            status: 'complete',
            active: true,
          }]
        : [],
      reload() {},
      remove: async () => {},
      sendMessage: async () => null,
      update: async () => ({}),
    },
  };
  context = vm.createContext({
    AbortController,
    AbortSignal,
    Blob,
    FormData,
    Headers,
    Intl,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    atob,
    btoa,
    chrome,
    clearInterval() {},
    clearTimeout() {},
    console: {
      error() {},
      info() {},
      log() {},
      warn() {},
    },
    crypto: webcrypto,
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), options });
      if (fetchImpl) return fetchImpl(String(url), options);
      return new Response(JSON.stringify({ ok: true, data: { id: 'collected-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    globalThis: null,
    navigator: {
      hardwareConcurrency: 8,
      language: 'en-US',
      platform: 'test',
      userAgent: 'service-worker-behavior-test',
    },
    setInterval(callback, delay) {
      intervalCalls.push({ callback, delay });
      return intervalCalls.length;
    },
    setTimeout(callback, delay = 0) {
      if (delay <= 1000) queueMicrotask(callback);
      return { delay };
    },
  });
  context.globalThis = context;
  context.self = context;
  context.importScripts = (...entries) => {
    for (const entry of entries) {
      importedScripts.push(entry);
      const file = path.resolve(path.dirname(workerPath), entry);
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(workerPath, 'utf8'), context, {
    filename: workerPath,
  });
  assert.equal(runtimeOnMessage.listeners.length, 1, 'service worker must register one message handler');
  return {
    context,
    createdAlarms,
    executeScriptCalls,
    fetchCalls,
    importedScripts,
    intervalCalls,
    local,
    runtimeOnMessage,
    runtimeOnStartup,
    runtimeSendMessageCalls,
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function sendRuntimeMessage(harness, message, sender = {}) {
  let response;
  harness.runtimeOnMessage.listeners[0](message, sender, (value) => {
    response = value;
  });
  await settle();
  return response;
}

test('installed manifest cannot request Seller API while retaining visible seller capture', () => {
  for (const sellerApiUrl of [
    'https://api-seller.ozon.ru/v3/product/info/list',
    'http://api-seller.ozon.ru/v2/posting/fbo/list',
  ]) {
    assert.equal(
      manifest.host_permissions.some((pattern) =>
        chromeMatchPatternCovers(pattern, sellerApiUrl)),
      false,
      `effective host permissions must exclude ${sellerApiUrl}`,
    );
  }
  for (const captureUrl of [
    'https://www.ozon.ru/product/example-123456789/',
    'https://seller.ozon.ru/app/products',
    'https://ozon.kz/product/example-123456789/',
    'https://www.ozon.kz/search/?text=example',
  ]) {
    assert.equal(
      manifest.host_permissions.some((pattern) =>
        chromeMatchPatternCovers(pattern, captureUrl)),
      true,
      `visible capture must retain ${captureUrl}`,
    );
  }
});

test('actual service worker starts without retired sync modules or sync alarms', async () => {
  const harness = loadServiceWorker();
  for (const listener of harness.runtimeOnStartup.listeners) listener();
  await settle();
  assert.equal(
    harness.importedScripts.some((entry) => /(?:sync-engine|opi-client|lease-client|sync-state|diff-index)/.test(entry)),
    false,
  );
  assert.equal(
    harness.createdAlarms.some(({ name }) => /client-sync|PRODUCTS|POSTINGS|WAREHOUSES/i.test(name)),
    false,
  );
  assert.equal(typeof harness.context.JzCollectorClient?.upload, 'function');
  assert.equal(typeof harness.context.JzOzonEnrichmentContract?.normalizeResult, 'function');
  assert.equal(typeof harness.context.JzCollectorOzonAgent?.create, 'function');
  assert.equal(typeof harness.context.JzCollectorOzonClient?.create, 'function');
  const enrichmentImports = harness.importedScripts.filter((entry) =>
    /ozon-enrichment/.test(entry));
  assert.deepEqual(enrichmentImports, [
    '../lib/ozon-enrichment-contract.js',
    'collector-ozon-enrichment-agent.js',
    'collector-ozon-enrichment-client.js',
  ]);
});

test('Ozon enrichment runtime messages keep the service worker alive while cold capture runs', async () => {
  const harness = loadServiceWorker();
  const sender = {
    tab: { id: 7, url: 'https://www.ozon.ru/product/example-4862904234/' },
    url: 'https://www.ozon.ru/product/example-4862904234/',
  };
  const single = await sendRuntimeMessage(harness, {
    action: 'enrichOzonCollect',
    requestId: 'keepalive-single',
    sku: '4862904234',
    invalid: true,
  }, sender);
  const batch = await sendRuntimeMessage(harness, {
    action: 'enrichOzonCollectBatch',
    requestId: 'keepalive-batch',
    skus: ['4862904234', '2780832763'],
    invalid: true,
  }, sender);

  assert.equal(single.ok, false);
  assert.equal(batch.ok, false);
  assert.deepEqual(
    harness.intervalCalls.map(({ delay }) => delay),
    [15_000, 15_000],
    'single and batch enrichment must both hold the MV3 service worker open',
  );
});

test('Ozon enrichment runtime messages are exact, Collector-authenticated, and preserve stable errors', async () => {
  const completeResult = {
    status: 'COMPLETE',
    contractVersion: 'collector.ozon.enrichment.v1',
    sku: '4862904234',
    descriptionCategoryId: 123,
    typeId: 456,
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    variantData: {
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
  };
  const successHarness = loadServiceWorker({
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, '/api/collector/ozon/enrich');
      return new Response(JSON.stringify({ ok: true, data: completeResult }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const sender = {
    tab: { id: 7, url: 'https://www.ozon.ru/product/example-4862904234/' },
    url: 'https://www.ozon.ru/product/example-4862904234/',
  };
  const rejected = await sendRuntimeMessage(successHarness, {
    action: 'enrichOzonCollect',
    requestId: 'runtime-invalid',
    sku: '4862904234',
    storeId: 'store-attacker',
  }, sender);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.code, 'OZON_ENRICH_REQUEST_INVALID');
  assert.equal(rejected.error, 'Ozon 商品补全请求格式无效');
  assert.deepEqual([...rejected.missingFields], []);
  assert.equal(rejected.retryable, false);
  assert.equal(successHarness.fetchCalls.length, 0);

  const success = await sendRuntimeMessage(successHarness, {
    action: 'enrichOzonCollect',
    requestId: 'runtime-success',
    sku: '4862904234',
  }, sender);
  assert.equal(success.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(success.data)), completeResult);
  assert.equal(successHarness.fetchCalls.length, 1);
  assert.deepEqual(JSON.parse(successHarness.fetchCalls[0].options.body), {
    requestId: 'runtime-success',
    sku: '4862904234',
  });
  assert.equal(
    successHarness.fetchCalls.some(({ url }) => /\/ozon\/sync|api-seller\.ozon\.ru/.test(url)),
    false,
  );

  const errorHarness = loadServiceWorker({
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      code: 'OZON_ENRICH_INCOMPLETE',
      message: 'missing cst_do-not-leak-runtime-secret',
      missingFields: ['weightG'],
      retryable: true,
    }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const failed = await sendRuntimeMessage(errorHarness, {
    action: 'enrichOzonCollect',
    requestId: 'runtime-failed',
    sku: '4862904234',
  }, sender);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 422);
  assert.equal(failed.code, 'OZON_ENRICH_INCOMPLETE');
  assert.deepEqual([...failed.missingFields], ['weightG']);
  assert.equal(failed.retryable, true);
  assert.doesNotMatch(failed.error, /do-not-leak|cst_/);
});

test('held enrichment directly invokes the local visible Seller capture and posts its safe projection', async () => {
  const sku = '4862904234';
  const variantData = {
    sku,
    description_category_id: 123,
    type_id: 456,
    categories: [
      { id: 100, level: 2, name: '家用电器', title: '家用电器', company_id: 'must-not-cross' },
      { id: 123, level: 3, name: 'Заварочный чайник', title: 'Заварочный чайник' },
    ],
    attributes: [
      { key: '8229', value: 'Заварочный чайник', dictionary_value_id: 456 },
      { key: '4497', value: '500' },
      { key: '9454', value: '300' },
      { key: '9455', value: '200' },
      { key: '9456', value: '100' },
    ],
  };
  const completeResult = {
    status: 'COMPLETE',
    contractVersion: 'collector.ozon.enrichment.v1',
    sku,
    descriptionCategoryId: 123,
    typeId: 456,
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    variantData,
    source: 'EXTENSION_SELLER_CAPTURE',
    capturedAt: '2026-07-31T00:00:00.000Z',
    cache: { hit: false, expiresAt: '2026-07-31T06:00:00.000Z' },
  };
  let resolvePublic;
  const publicResponse = new Promise((resolve) => { resolvePublic = resolve; });
  let nextCalls = 0;
  let postedVariantData = null;
  const harness = loadServiceWorker({
    sellerCapture: true,
    executeScriptImpl: async (input) => {
      assert.equal(input.args[0], '/search');
      assert.equal(input.args[1].company_id, '1234');
      return [{ result: { ok: true, data: { variants: [variantData] } } }];
    },
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/collector/ozon/enrich') return publicResponse;
      if (pathname === '/api/collector/ozon/enrichment-jobs/next') {
        nextCalls += 1;
        return new Response(JSON.stringify({
          ok: true,
          job: nextCalls === 1
            ? { id: 'job-local', requestId: 'runtime-local', sku, refreshBundle: false }
            : null,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === '/api/collector/ozon/enrichment-jobs/job-local/result') {
        postedVariantData = JSON.parse(options.body).variantData;
        resolvePublic(new Response(JSON.stringify({ ok: true, data: completeResult }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pathname === '/api/collector/ozon/enrichment-jobs/job-local/fail') {
        resolvePublic(new Response(JSON.stringify({
          ok: false,
          code: 'OZON_ENRICH_UPSTREAM_FAILED',
          message: 'capture failed',
          missingFields: [],
          retryable: true,
        }), { status: 502, headers: { 'content-type': 'application/json' } }));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected Collector path: ${pathname}`);
    },
  });

  const response = await Promise.race([
    new Promise((resolve) => {
      harness.runtimeOnMessage.listeners[0]({
        action: 'enrichOzonCollect',
        requestId: 'runtime-local',
        sku,
      }, {}, resolve);
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`local enrichment wiring did not settle: ${JSON.stringify({
        fetchPaths: harness.fetchCalls.slice(0, 10).map(({ url }) => new URL(url).pathname),
        fetchCount: harness.fetchCalls.length,
        executePaths: harness.executeScriptCalls.map(({ args }) => args?.[0]),
        runtimeSelfSends: harness.runtimeSendMessageCalls.length,
      })}`)),
      500,
    )),
  ]);

  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(postedVariantData)), {
    description_category_id: 123,
    type_id: 456,
    categories: [
      { id: 100, level: 2, name: '家用电器', title: '家用电器' },
      { id: 123, level: 3, name: 'Заварочный чайник', title: 'Заварочный чайник' },
    ],
    attributes: variantData.attributes,
  });
  assert.equal(harness.executeScriptCalls.length, 1);
  assert.equal(harness.runtimeSendMessageCalls.length, 0);
});

test('collector client exposes no arbitrary credentialed transport', async () => {
  const harness = loadServiceWorker();
  for (const method of ['request', 'getJob', 'getConfig']) {
    assert.equal(
      typeof harness.context.JzCollectorClient?.[method],
      'undefined',
      `${method} must not be a public Collector transport`,
    );
  }
  assert.deepEqual(
    Object.keys(harness.context.JzCollectorClient).sort(),
    ['setContext', 'upload'],
  );
});

test('retired, absolute and traversal queue paths fail before Collector fetch', async () => {
  const harness = loadServiceWorker();
  const maliciousPaths = [
    '/ozon/sync/lease/acquire',
    '/ozon/sync/client-report',
    '/ozon/cache/import-with-hash',
    '/local/sync/PRODUCTS',
    'https://evil.example/collector',
    '/../ozon/sync/lease/acquire',
  ];
  harness.local.state.sonliCollectorPendingUploads = maliciousPaths.map(
    (entryPath, index) => ({
      requestId: `malicious-${index}`,
      path: entryPath,
      body: { source: 'ozon', payload: {} },
      ownerAccountId: 'account-behavior',
      ownerSessionIdentity: 'account:account-behavior',
      queuedAt: '2026-07-29T00:00:00.000Z',
    }),
  );
  const response = await sendRuntimeMessage(
    harness,
    {
      action: 'pushSourceCollect',
      sourceId: 'ozon',
      requestId: 'safe-after-malicious-queue',
      raw: { sku: '123456789' },
    },
    {
      tab: { id: 7, url: 'https://www.ozon.ru/product/example-123456789/' },
      url: 'https://www.ozon.ru/product/example-123456789/',
    },
  );
  assert.equal(response?.ok, true);
  assert.equal(
    harness.fetchCalls.some(({ url }) =>
      maliciousPaths.some((entryPath) => url.endsWith(entryPath))),
    false,
  );
  assert.deepEqual(
    harness.fetchCalls.map(({ url }) => new URL(url).pathname),
    ['/api/sources/ozon/collect'],
  );
});

test('source route injection is rejected before Collector fetch', async () => {
  for (const sourceId of [
    '../ozon/sync/lease/acquire',
    'https://evil.example/collector',
    'ozon?next=/ozon/sync/client-report',
  ]) {
    const harness = loadServiceWorker();
    const response = await sendRuntimeMessage(
      harness,
      {
        action: 'pushSourceCollect',
        sourceId,
        requestId: 'malicious-source-route',
        raw: { sku: '123456789' },
      },
      {
        tab: { id: 7, url: 'https://www.ozon.ru/product/example-123456789/' },
        url: 'https://www.ozon.ru/product/example-123456789/',
      },
    );
    assert.notEqual(response?.ok, true);
    assert.equal(
      harness.fetchCalls.some(({ url }) => url.includes('/sources/')),
      false,
      sourceId,
    );
  }
});

test('retired manual and sync-request messages cannot trigger sync fetches', async () => {
  const harness = loadServiceWorker();
  const manualResponse = await sendRuntimeMessage(
    harness,
    {
      type: 'jzManualSync',
      portalProtocol: 'JZ_ERP',
      storeId: 'store-1',
      syncType: 'PRODUCTS',
    },
    { url: 'https://qh.jizhangerp.com/app' },
  );
  const syncRequestResponse = await sendRuntimeMessage(
    harness,
    {
      kind: 'sync.request',
      storeId: 'store-1',
      syncType: 'POSTINGS',
    },
    { url: 'chrome-extension://sync-capability-test/content.js' },
  );
  await settle();
  assert.notEqual(manualResponse?.ok, true);
  assert.notEqual(syncRequestResponse?.ok, true);
  assert.equal(
    harness.fetchCalls.some(({ url }) =>
      /api-seller\.ozon\.ru|\/ozon\/sync\/|sync-credentials|cache\/import-with-hash/.test(url)),
    false,
  );
});

test('visible-page capture upload still reaches the collector client', async () => {
  const harness = loadServiceWorker();
  const response = await sendRuntimeMessage(
    harness,
    {
      action: 'pushSourceCollect',
      sourceId: 'ozon',
      requestId: 'capture-behavior-1',
      raw: {
        sku: '123456789',
        url: 'https://www.ozon.ru/product/example-123456789/',
        title: 'Visible product',
      },
    },
    {
      tab: { id: 7, url: 'https://www.ozon.ru/product/example-123456789/' },
      url: 'https://www.ozon.ru/product/example-123456789/',
    },
  );
  assert.equal(response?.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(response.data)),
    { dedupeHit: false, result: { id: 'collected-1' } },
  );
  assert.equal(
    harness.fetchCalls.some(({ url, options }) =>
      url.endsWith('/sources/ozon/collect')
      && options.headers?.authorization === 'Collector csess_behavior_test_secret_123456789'),
    true,
  );
  const captureRequest = harness.fetchCalls.find(({ url }) =>
    url.endsWith('/sources/ozon/collect'));
  const captureBody = JSON.parse(captureRequest.options.body);
  for (const field of [
    'accountId',
    'storeId',
    'operatingStoreId',
    'dataCollectionStoreId',
    'sellerCompanyId',
  ]) {
    assert.equal(Object.hasOwn(captureBody, field), false, field);
  }
});

test('collector upload non-2xx responses expose only stable sanitized error metadata', async () => {
  const sender = {
    tab: { id: 7, url: 'https://www.ozon.ru/product/example-123456789/' },
    url: 'https://www.ozon.ru/product/example-123456789/',
  };
  for (const fixture of [
    {
      status: 401,
      body: {
        code: 'EVIL_SECRET_CODE',
        message: 'raw cst_do-not-leak-upload-secret',
        missingFields: ['heightMm', 'authorization'],
        retryable: false,
        token: 'csess_do-not-leak-upload-token',
      },
      expected: {
        code: 'COLLECTOR_AUTH_REQUIRED',
        error: '请先登录 Web',
        missingFields: ['heightMm'],
        retryable: false,
      },
    },
    {
      status: 403,
      body: { message: 'raw bearer do-not-leak', retryable: false },
      expected: {
        code: 'COLLECTOR_PERMISSION_DENIED',
        error: '请重新连接 Web 采集授权',
        missingFields: [],
        retryable: false,
      },
    },
    {
      status: 422,
      body: {
        code: 'OZON_COLLECT_INCOMPLETE',
        message: 'raw backend detail',
        missingFields: ['widthMm', 'arbitrary'],
        retryable: false,
      },
      expected: {
        code: 'OZON_COLLECT_INCOMPLETE',
        error: '商品资料不完整，未写入采集箱',
        missingFields: ['widthMm'],
        retryable: false,
      },
    },
  ]) {
    const harness = loadServiceWorker({
      fetchImpl: async () => new Response(JSON.stringify(fixture.body), {
        status: fixture.status,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const response = await sendRuntimeMessage(harness, {
      action: 'pushSourceCollect',
      sourceId: 'ozon',
      requestId: `upload-error-${fixture.status}`,
      raw: { sku: '123456789' },
    }, sender);
    assert.deepEqual(
      {
        ok: response.ok,
        status: response.status,
        code: response.code,
        error: response.error,
        missingFields: [...(response.missingFields || [])],
        retryable: response.retryable,
      },
      { ok: false, status: fixture.status, ...fixture.expected },
    );
    assert.doesNotMatch(JSON.stringify(response), /do-not-leak|cst_|csess_|bearer|raw backend/i);
  }
});

test('collector upload retries preserve the exact captured body across a service-worker restart', async () => {
  const sender = {
    tab: { id: 7, url: 'https://www.ozon.ru/product/example-123456789/' },
    url: 'https://www.ozon.ru/product/example-123456789/',
  };
  const message = {
    action: 'pushSourceCollect',
    sourceId: 'ozon',
    requestId: 'stable-restart-request',
    capturedAt: '2026-07-31T08:09:10.123Z',
    raw: { sku: '123456789', title: 'Original title' },
  };
  const failure = () => new Response(JSON.stringify({
    code: 'COLLECTOR_UPLOAD_FAILED',
    message: 'raw backend cst_do-not-leak-restart',
    retryable: true,
  }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });

  const firstHarness = loadServiceWorker({ fetchImpl: failure });
  const first = await sendRuntimeMessage(firstHarness, message, sender);
  assert.equal(first.code, 'COLLECTOR_UPLOAD_FAILED');
  assert.equal(first.queued, true);
  const firstBody = firstHarness.fetchCalls.at(-1).options.body;

  const restartedHarness = loadServiceWorker({
    fetchImpl: failure,
    localInitial: structuredClone(firstHarness.local.state),
  });
  const second = await sendRuntimeMessage(restartedHarness, message, sender);
  assert.deepEqual(
    {
      status: second.status,
      code: second.code,
      retryable: second.retryable,
      missingFields: [...(second.missingFields || [])],
      queued: second.queued,
      queueWriteFailed: second.queueWriteFailed,
    },
    {
      status: 500,
      code: 'COLLECTOR_UPLOAD_FAILED',
      retryable: true,
      missingFields: [],
      queued: true,
      queueWriteFailed: false,
    },
  );
  assert.equal(
    restartedHarness.fetchCalls.every(({ options }) => options.body === firstBody),
    true,
    'queued replay and direct retry must send the byte-identical body',
  );
  assert.doesNotMatch(JSON.stringify(second), /COLLECT_REQUEST_CONFLICT|do-not-leak|cst_/i);

  const changed = await sendRuntimeMessage(restartedHarness, {
    ...message,
    raw: { sku: '123456789', title: 'Changed title' },
  }, sender);
  assert.equal(changed.status, 500);
  assert.equal(changed.code, 'COLLECTOR_UPLOAD_FAILED');
  assert.equal(changed.queued, false);
  assert.equal(changed.queueWriteFailed, true);
  assert.doesNotMatch(JSON.stringify(changed), /COLLECT_REQUEST_CONFLICT|do-not-leak|cst_/i);
  assert.equal(
    restartedHarness.local.state.sonliCollectorPendingUploads[0].body.payload.title,
    'Original title',
    'conflicting raw data must not replace the persisted request body',
  );
});

test('collector upload keeps the original sanitized HTTP envelope when queue storage fails', async () => {
  const harness = loadServiceWorker({
    rejectPendingUploadWrite: true,
    fetchImpl: async () => new Response(JSON.stringify({
      code: 'OZON_COLLECT_INCOMPLETE',
      message: 'raw backend cst_do-not-leak-http',
      missingFields: ['heightMm', 'authorization'],
      retryable: false,
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const response = await sendRuntimeMessage(harness, {
    action: 'pushSourceCollect',
    sourceId: 'ozon',
    requestId: 'queue-write-failure',
    capturedAt: '2026-07-31T08:09:10.123Z',
    raw: { sku: '123456789' },
  }, {
    tab: { id: 7, url: 'https://www.ozon.ru/product/example-123456789/' },
    url: 'https://www.ozon.ru/product/example-123456789/',
  });

  assert.deepEqual(
    {
      ok: response.ok,
      status: response.status,
      code: response.code,
      error: response.error,
      missingFields: [...(response.missingFields || [])],
      retryable: response.retryable,
      queued: response.queued,
      queueWriteFailed: response.queueWriteFailed,
    },
    {
      ok: false,
      status: 503,
      code: 'OZON_COLLECT_INCOMPLETE',
      error: '商品资料不完整，未写入采集箱',
      missingFields: ['heightMm'],
      retryable: false,
      queued: false,
      queueWriteFailed: true,
    },
  );
  assert.doesNotMatch(JSON.stringify(response), /EVIL_STORAGE|do-not-leak|cst_|raw backend/i);

  const flushFailureHarness = loadServiceWorker({
    rejectPendingUploadWrite: 'all',
    fetchImpl: async () => {
      throw new Error('fetch must not run after queue flush storage failure');
    },
  });
  const flushFailure = await sendRuntimeMessage(flushFailureHarness, {
    action: 'pushSourceCollect',
    sourceId: 'ozon',
    requestId: 'queue-flush-write-failure',
    capturedAt: '2026-07-31T08:09:10.123Z',
    raw: { sku: '123456789' },
  }, {
    tab: { id: 7, url: 'https://www.ozon.ru/product/example-123456789/' },
    url: 'https://www.ozon.ru/product/example-123456789/',
  });
  assert.deepEqual(
    {
      ok: flushFailure.ok,
      status: flushFailure.status,
      code: flushFailure.code,
      error: flushFailure.error,
      missingFields: [...(flushFailure.missingFields || [])],
      retryable: flushFailure.retryable,
      queued: flushFailure.queued,
      queueWriteFailed: flushFailure.queueWriteFailed,
    },
    {
      ok: false,
      status: 0,
      code: 'COLLECTOR_UPLOAD_FAILED',
      error: '采集上传失败，请稍后重试',
      missingFields: [],
      retryable: true,
      queued: false,
      queueWriteFailed: true,
    },
  );
  assert.doesNotMatch(JSON.stringify(flushFailure), /EVIL_STORAGE|do-not-leak|cst_|unsafe storage/i);
});

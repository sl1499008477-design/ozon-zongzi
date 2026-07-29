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

function loadServiceWorker() {
  const workerPath = path.join(extensionRoot, manifest.background.service_worker);
  const runtimeOnInstalled = createEvent();
  const runtimeOnStartup = createEvent();
  const runtimeOnMessage = createEvent();
  const alarmsOnAlarm = createEvent();
  const createdAlarms = [];
  const fetchCalls = [];
  const importedScripts = [];
  const session = createStorageArea({
    sonliCollectorSession: {
      collectorToken: 'csess_behavior_test_secret_123456789',
      expiresAt: '2099-01-01T00:00:00.000Z',
      account: { id: 'account-behavior', displayName: 'Behavior' },
      permissions: ['collector.upload', 'collector.job.read', 'collector.config.read'],
    },
  });
  const local = createStorageArea();
  const sync = createStorageArea();
  const event = createEvent();
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
    cookies: { getAll: async () => [] },
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
    },
    scripting: { executeScript: async () => [] },
    storage: { local, session, sync },
    tabs: {
      create: async () => ({ id: 1 }),
      onCreated: event,
      onRemoved: event,
      onUpdated: event,
      query: async () => [],
      reload() {},
      remove: async () => {},
      sendMessage: async () => null,
      update: async () => ({}),
    },
  };
  const context = vm.createContext({
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
    setInterval() {
      return 1;
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
    fetchCalls,
    importedScripts,
    local,
    runtimeOnMessage,
    runtimeOnStartup,
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

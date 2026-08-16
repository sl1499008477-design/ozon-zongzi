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
const AVAILABILITY_PATH = '/api/collector/ozon/enrichment-jobs/available';
const trustedWebSender = {
  url: 'http://127.0.0.1:3000/app',
  tab: { id: 20, url: 'http://127.0.0.1:3000/app' },
};
const COLLECTOR_SESSION_KEY = 'sonliCollectorSession';
const COLLECTOR_GENERATION_KEY = 'sonliCollectorAuthGeneration';
const COLLECTOR_INCARNATION_KEY = 'sonliCollectorAuthIncarnation';
const G1 = 'generation_G1_1234';
const G2 = 'generation_G2_5678';

function availabilityResponse(url, options, available) {
  assert.equal(new URL(url).pathname, AVAILABILITY_PATH);
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), {});
  assert.equal(Object.hasOwn(options, 'credentials'), false);
  const headers = new Headers(options.headers);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.match(headers.get('authorization') || '', /^Collector /);
  assert.equal(headers.has('cookie'), false);
  assert.doesNotMatch(options.body, /seller|company|store|cookie/i);
  return new Response(JSON.stringify({ ok: true, available }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createInjectedWebTabHarness({ runtimeSendMessageImpl } = {}) {
  const runtimeOnMessage = createEvent();
  const executedFiles = [];
  const posts = [];
  const runtimeMessages = [];
  const sentRuntimeMessages = [];
  const windowListeners = new Map();
  const windowObject = {
    location: { origin: 'http://127.0.0.1:3000' },
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    postMessage(message, targetOrigin) {
      posts.push({ message, targetOrigin });
    },
  };
  let context;
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: runtimeOnMessage,
      sendMessage(message, callback) {
        sentRuntimeMessages.push(message);
        if (!runtimeSendMessageImpl) {
          callback?.(null);
          return;
        }
        Promise.resolve(runtimeSendMessageImpl(message)).then(
          (response) => callback?.(response),
          () => callback?.(null),
        );
      },
    },
  };
  context = vm.createContext({
    chrome,
    clearTimeout() {},
    console: {
      error() {},
      info() {},
      log() {},
      warn() {},
    },
    crypto: webcrypto,
    globalThis: null,
    self: null,
    setTimeout(callback, milliseconds) {
      return { callback, milliseconds };
    },
    window: windowObject,
  });
  context.globalThis = context;
  context.self = context;

  return {
    executedFiles,
    posts,
    runtimeMessages,
    sentRuntimeMessages,
    listenerCount: () => runtimeOnMessage.listeners.length,
    async executeScript({ files = [] }) {
      for (const relativePath of files) {
        executedFiles.push(relativePath);
        const file = path.join(extensionRoot, relativePath);
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
      }
      return [];
    },
    async sendRuntimeMessage(message) {
      runtimeMessages.push(message);
      if (runtimeOnMessage.listeners.length === 0) {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return new Promise((resolve, reject) => {
        for (const listener of runtimeOnMessage.listeners) {
          let responded = false;
          const keepChannelOpen = listener(
            message,
            { url: windowObject.location.origin },
            (value) => {
              responded = true;
              resolve(value);
            },
          );
          if (responded || keepChannelOpen === true) return;
        }
        reject(new Error('Could not establish connection. Receiving end does not exist.'));
      });
    },
    async emitWebMessage(data) {
      const listener = windowListeners.get('message');
      assert.ok(listener, 'collector auth content flow must register a Web message listener');
      await listener({
        source: windowObject,
        origin: windowObject.location.origin,
        data,
      });
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
  collectorExchangeImpl,
  sellerCapture = false,
  executeScriptImpl,
  tabCreateImpl,
  tabGetImpl,
  tabQueryImpl,
  tabSendMessageImpl,
  tabUpdateImpl,
  windowUpdateImpl,
  localInitial = {},
  rejectPendingUploadWrite = false,
} = {}) {
  const workerPath = path.join(extensionRoot, manifest.background.service_worker);
  const runtimeOnInstalled = createEvent();
  const runtimeOnStartup = createEvent();
  const runtimeOnMessage = createEvent();
  const alarmsOnAlarm = createEvent();
  const createdAlarms = [];
  const cookieQueries = [];
  const fetchCalls = [];
  const executeScriptCalls = [];
  const intervalCalls = [];
  const runtimeSendMessageCalls = [];
  const importedScripts = [];
  const removedTabs = [];
  const reloadedTabs = [];
  const createdTabs = [];
  const sentTabMessages = [];
  const tabGetCalls = [];
  const tabQueryCalls = [];
  const updatedTabs = [];
  const updatedWindows = [];
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
    ...(sellerCapture ? {
      'sonliSellerCompanyContext:current': {
        companyId: '1234',
        observedAt: Date.now(),
        revision: 1,
        tabId: 9,
      },
      'sonliSellerCompanyContext:9': {
        companyId: '1234',
        observedAt: Date.now(),
        revision: 1,
        tabId: 9,
      },
    } : {}),
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
      getAll: async (query) => {
        cookieQueries.push(query);
        return sellerCapture
          ? [{ name: 'sc_company_id', value: '1234', domain: '.seller.ozon.ru' }]
          : [];
      },
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
      create: async (options) => {
        createdTabs.push(options);
        return tabCreateImpl ? tabCreateImpl(options) : { id: 1 };
      },
      get: async (tabId) => {
        tabGetCalls.push(tabId);
        return tabGetImpl
          ? tabGetImpl(tabId)
          : { id: tabId, url: 'https://seller.ozon.ru/app' };
      },
      onCreated: event,
      onRemoved: event,
      onUpdated: event,
      query: async (query = {}) => {
        tabQueryCalls.push(query);
        if (tabQueryImpl) return tabQueryImpl(query);
        const requestedUrls = Array.isArray(query.url) ? query.url : [query.url].filter(Boolean);
        const requestsSeller = !requestedUrls.length
          || requestedUrls.includes('https://seller.ozon.ru/*');
        return sellerCapture && requestsSeller
          ? [{
              id: 9,
              url: 'https://seller.ozon.ru/app/products',
              status: 'complete',
              active: true,
            }]
          : [];
      },
      reload(tabId) { reloadedTabs.push(tabId); },
      remove: async (tabId) => { removedTabs.push(tabId); },
      sendMessage: async (tabId, message) => {
        sentTabMessages.push({ tabId, message });
        return tabSendMessageImpl ? tabSendMessageImpl(tabId, message) : null;
      },
      update: async (tabId, update) => {
        updatedTabs.push({ tabId, update });
        return tabUpdateImpl ? tabUpdateImpl(tabId, update) : {};
      },
    },
    windows: {
      update: async (windowId, update) => {
        updatedWindows.push({ windowId, update });
        return windowUpdateImpl ? windowUpdateImpl(windowId, update) : {};
      },
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
      if (entry === '../lib/collector-session.js' && collectorExchangeImpl) {
        const collectorSessionApi = context.JzCollectorSession;
        context.JzCollectorSession = Object.freeze({
          ...collectorSessionApi,
          createCollectorSessionManager(options) {
            const manager = collectorSessionApi.createCollectorSessionManager(options);
            return Object.freeze({
              ...manager,
              exchangeCollectorTicket: collectorExchangeImpl,
            });
          },
        });
      }
    }
  };
  vm.runInContext(fs.readFileSync(workerPath, 'utf8'), context, {
    filename: workerPath,
  });
  assert.equal(runtimeOnMessage.listeners.length, 1, 'service worker must register one message handler');
  return {
    context,
    alarmsOnAlarm,
    cookieQueries,
    createdAlarms,
    createdTabs,
    executeScriptCalls,
    fetchCalls,
    importedScripts,
    intervalCalls,
    local,
    removedTabs,
    reloadedTabs,
    runtimeOnInstalled,
    runtimeOnMessage,
    runtimeOnStartup,
    runtimeSendMessageCalls,
    sentTabMessages,
    session,
    tabGetCalls,
    tabQueryCalls,
    updatedTabs,
    updatedWindows,
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

function sendRuntimeMessageUntilResponse(harness, message, sender = {}) {
  return new Promise((resolve) => {
    harness.runtimeOnMessage.listeners[0](message, sender, resolve);
  });
}

async function loadCollectorAuthContent(workerHarness, sender = trustedWebSender) {
  const webTab = createInjectedWebTabHarness({
    runtimeSendMessageImpl: (message) => sendRuntimeMessageUntilResponse(
      workerHarness,
      message,
      sender,
    ),
  });
  await webTab.executeScript({
    files: [
      'lib/web-bridge-policy.js',
      'lib/collector-auth-flow.js',
      'content/sync-auth.js',
    ],
  });
  return webTab;
}

const collectorReady = (generationId) => ({
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.ready',
  generationId,
});

const collectorResponse = (requestId, generationId, suffix) => ({
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.response',
  requestId,
  generationId,
  ticket: `ctt_real_flow_ticket_${suffix}_123456789`,
  expiresAt: '2099-01-01T00:00:00.000Z',
});

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
  assert.equal(
    harness.importedScripts.includes('../lib/seller-recovery-tab.js'),
    true,
    'service worker package must import the Seller recovery helper',
  );
});

test('openFrontend preserves exact non-login navigation without reusing a Web tab', async () => {
  const harness = loadServiceWorker({
    tabQueryImpl: async () => [{
      id: 17,
      windowId: 8,
      url: 'http://127.0.0.1:3000/ozon/dashboard',
    }],
  });

  const response = await sendRuntimeMessage(harness, {
    action: 'openFrontend',
    path: '/ozon/products/list',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.createdTabs)), [{
    url: 'http://127.0.0.1:3000/ozon/products/list',
    active: true,
  }]);
  assert.deepEqual(harness.updatedTabs, []);
  assert.deepEqual(harness.updatedWindows, []);
  assert.deepEqual(harness.sentTabMessages, []);
});

test('openFrontend reuses a trusted Web tab only for the exact login path', async () => {
  const harness = loadServiceWorker({
    tabQueryImpl: async () => [{
      id: 17,
      windowId: 8,
      url: 'http://127.0.0.1:3000/ozon/dashboard',
    }],
    tabSendMessageImpl: async (_tabId, message) => ({
      ok: true,
      requested: true,
      requestId: message.requestId,
    }),
  });

  const response = await sendRuntimeMessage(harness, {
    action: 'openFrontend',
    path: '/login',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { opened: true, reused: true, tabId: 17 },
  });
  assert.deepEqual(harness.createdTabs, []);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.updatedTabs)), [{
    tabId: 17,
    update: { active: true },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.updatedWindows)), [{
    windowId: 8,
    update: { focused: true },
  }]);
  assert.deepEqual(harness.sentTabMessages.map(({ tabId }) => tabId), [17]);
  assert.equal(harness.sentTabMessages[0].message.action, 'collector.auth.request');
  assert.match(harness.sentTabMessages[0].message.requestId, /^collector-/);
});

test('openFrontend returns top-level failure when the login opener cannot open a tab', async () => {
  const harness = loadServiceWorker({
    tabQueryImpl: async () => {
      throw new Error('tab query unavailable');
    },
  });

  const response = await sendRuntimeMessage(harness, {
    action: 'openFrontend',
    path: '/login',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: false,
    error: 'OPEN_FRONTEND_FAILED',
  });
});

test('Collector auth routes query HTTPS brand pages plus the explicit local HTTP allowlist', async () => {
  const harness = loadServiceWorker({ tabQueryImpl: async () => [] });

  await sendRuntimeMessage(harness, { action: 'openFrontend', path: '/login' });
  await sendRuntimeMessage(harness, { action: 'requestCollectorAuth' });

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.tabQueryCalls.map(({ url }) => url))),
    [
      [
        'https://qh.jizhangerp.com/*',
        'http://localhost:3000/*',
        'http://127.0.0.1:3000/*',
        'http://store.localhost:3000/*',
      ],
      [
        'https://qh.jizhangerp.com/*',
        'http://localhost:3000/*',
        'http://127.0.0.1:3000/*',
        'http://store.localhost:3000/*',
      ],
      [
        'https://qh.jizhangerp.com/*',
        'http://localhost:3000/*',
        'http://127.0.0.1:3000/*',
        'http://store.localhost:3000/*',
      ],
    ],
  );
});

test('requestCollectorAuth chooses one authoritative trusted Web tab deterministically', async (t) => {
  const cases = [
    {
      name: 'active tab before a more recently accessed inactive tab',
      tabs: [
        { id: 17, active: false, lastAccessed: 900 },
        { id: 19, active: true, lastAccessed: 100 },
      ],
      selectedTabId: 19,
    },
    {
      name: 'greatest finite lastAccessed when active state ties',
      tabs: [
        { id: 17, active: false, lastAccessed: 100 },
        { id: 19, active: false, lastAccessed: 900 },
      ],
      selectedTabId: 19,
    },
    {
      name: 'finite lastAccessed before a non-finite value',
      tabs: [
        { id: 17, active: false, lastAccessed: Number.POSITIVE_INFINITY },
        { id: 19, active: false, lastAccessed: 100 },
      ],
      selectedTabId: 19,
    },
    {
      name: 'lowest tab ID as the stable final tie-break',
      tabs: [
        { id: 19, active: false, lastAccessed: 900 },
        { id: 17, active: false, lastAccessed: 900 },
      ],
      selectedTabId: 17,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const harness = loadServiceWorker({
        tabQueryImpl: async () => scenario.tabs,
        tabSendMessageImpl: async (_tabId, message) => ({
          ok: true,
          requested: true,
          requestId: message.requestId,
        }),
      });

      const response = await sendRuntimeMessage(harness, { action: 'requestCollectorAuth' });

      assert.deepEqual(JSON.parse(JSON.stringify(response)), {
        ok: true,
        data: { requested: 1 },
      });
      assert.deepEqual(
        harness.sentTabMessages.map(({ tabId }) => tabId),
        [scenario.selectedTabId],
      );
    });
  }
});

test('requestCollectorAuth falls through when the authoritative tab has no receiver', async () => {
  const harness = loadServiceWorker({
    tabQueryImpl: async () => [
      { id: 19, url: 'http://127.0.0.1:3000/login', active: true, lastAccessed: 100 },
      { id: 17, url: 'http://127.0.0.1:3000/login', active: false, lastAccessed: 900 },
    ],
    tabGetImpl: async (tabId) => ({ id: tabId, url: 'http://127.0.0.1:3000/login' }),
    tabSendMessageImpl: async (tabId, message) => {
      if (tabId === 19) {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return { ok: true, requested: true, requestId: message.requestId };
    },
  });

  const response = await sendRuntimeMessage(harness, { action: 'requestCollectorAuth' });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 1 },
  });
  assert.deepEqual(harness.sentTabMessages.map(({ tabId }) => tabId), [19, 19, 17]);
  assert.equal(
    harness.sentTabMessages[0].message.requestId,
    harness.sentTabMessages[1].message.requestId,
  );
  assert.deepEqual(harness.tabGetCalls, [19]);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(harness.executeScriptCalls.map(({ target, files }) => ({ target, files }))),
    ),
    [
      { target: { tabId: 19 }, files: ['lib/web-bridge-policy.js'] },
      { target: { tabId: 19 }, files: ['lib/collector-auth-flow.js'] },
      { target: { tabId: 19 }, files: ['content/sync-auth.js'] },
    ],
  );
});

test('no-receiver recovery stops before injection when the selected tab navigated away', async () => {
  const harness = loadServiceWorker({
    tabQueryImpl: async () => [
      { id: 19, url: 'http://127.0.0.1:3000/login', active: true, lastAccessed: 100 },
      { id: 17, url: 'http://127.0.0.1:3000/login', active: false, lastAccessed: 900 },
    ],
    tabGetImpl: async (tabId) => ({ id: tabId, url: 'https://attacker.example/login' }),
    tabSendMessageImpl: async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  });

  const response = await sendRuntimeMessage(harness, { action: 'requestCollectorAuth' });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 0 },
  });
  assert.deepEqual(harness.sentTabMessages.map(({ tabId }) => tabId), [19]);
  assert.deepEqual(harness.tabGetCalls, [19]);
  assert.deepEqual(harness.executeScriptCalls, []);
});

test('no-receiver recovery stops before injection when the selected tab lookup fails', async () => {
  const harness = loadServiceWorker({
    tabQueryImpl: async () => [
      { id: 19, url: 'http://127.0.0.1:3000/login', active: true, lastAccessed: 100 },
      { id: 17, url: 'http://127.0.0.1:3000/login', active: false, lastAccessed: 900 },
    ],
    tabGetImpl: async () => {
      throw new Error('No tab with id: 19');
    },
    tabSendMessageImpl: async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  });

  const response = await sendRuntimeMessage(harness, { action: 'requestCollectorAuth' });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 0 },
  });
  assert.deepEqual(harness.sentTabMessages.map(({ tabId }) => tabId), [19]);
  assert.deepEqual(harness.tabGetCalls, [19]);
  assert.deepEqual(harness.executeScriptCalls, []);
});

test('production requestCollectorAuth routes recovery through only one real content flow', async () => {
  const tabUrl = 'http://127.0.0.1:3000/ozon/dashboard';
  const tabSenders = new Map([
    [17, { url: tabUrl, tab: { id: 17, url: tabUrl } }],
    [19, { url: tabUrl, tab: { id: 19, url: tabUrl } }],
  ]);
  const webTabs = new Map();
  const worker = loadServiceWorker({
    tabQueryImpl: async () => [
      { id: 17, url: tabUrl, active: false, lastAccessed: 900 },
      { id: 19, url: tabUrl, active: true, lastAccessed: 100 },
    ],
    tabSendMessageImpl: (tabId, message) => webTabs.get(tabId).sendRuntimeMessage(message),
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/extension/collector-auth/exchange') {
        assert.equal(JSON.parse(options.body).ticket, 'ctt_real_flow_ticket_selected_123456789');
        return new Response(JSON.stringify({
          data: {
            collectorToken: 'csess_authoritative_selected_123456789',
            expiresAt: '2099-01-01T00:00:00.000Z',
            account: { id: 'account-authoritative-selected', displayName: 'Selected' },
            permissions: ['collector.upload', 'collector.ozon.read'],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, false);
      throw new Error(`unexpected authoritative selection path: ${pathname}`);
    },
  });
  webTabs.set(17, await loadCollectorAuthContent(worker, tabSenders.get(17)));
  webTabs.set(19, await loadCollectorAuthContent(worker, tabSenders.get(19)));
  const unselectedRequestsBefore = webTabs.get(17).posts.length;
  const selectedRequestsBefore = webTabs.get(19).posts.length;

  const response = await sendRuntimeMessage(worker, { action: 'requestCollectorAuth' });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 1 },
  });
  assert.equal(webTabs.get(17).posts.length, unselectedRequestsBefore);
  assert.equal(webTabs.get(19).posts.length, selectedRequestsBefore + 1);
  assert.deepEqual(webTabs.get(17).sentRuntimeMessages, []);

  const selectedRequest = webTabs.get(19).posts.at(-1).message;
  await webTabs.get(19).emitWebMessage(collectorResponse(
    selectedRequest.requestId,
    G2,
    'selected',
  ));

  assert.deepEqual(
    JSON.parse(JSON.stringify(webTabs.get(19).sentRuntimeMessages.map((message) => ({
      action: message.action,
      generationId: message.generationId,
    })))),
    [
      { action: 'collector.auth.begin', generationId: G2 },
      { action: 'collector.auth.exchange', generationId: G2 },
    ],
  );
  assert.deepEqual(webTabs.get(17).sentRuntimeMessages, []);
  assert.equal(worker.session.state[COLLECTOR_GENERATION_KEY], G2);
  assert.equal(
    worker.session.state[COLLECTOR_SESSION_KEY].account.id,
    'account-authoritative-selected',
  );
  assert.equal(
    worker.fetchCalls.filter(({ url }) => (
      new URL(url).pathname === '/api/extension/collector-auth/exchange'
    )).length,
    1,
  );
});

test('openFrontend injects collector auth into the same worker-selected no-receiver tab once', async () => {
  const webTab = createInjectedWebTabHarness();
  const harness = loadServiceWorker({
    executeScriptImpl: (input) => webTab.executeScript(input),
    tabGetImpl: async (tabId) => ({
      id: tabId,
      url: 'http://127.0.0.1:3000/ozon/dashboard',
    }),
    tabQueryImpl: async () => [{
      id: 17,
      windowId: 8,
      url: 'http://127.0.0.1:3000/ozon/dashboard',
    }],
    tabSendMessageImpl: (_tabId, message) => webTab.sendRuntimeMessage(message),
  });

  const response = await sendRuntimeMessage(harness, {
    action: 'openFrontend',
    path: '/login',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { opened: true, reused: true, tabId: 17 },
  });
  assert.equal(webTab.listenerCount(), 1);
  assert.equal(webTab.runtimeMessages.length, 2);
  assert.equal(webTab.runtimeMessages[0].action, 'collector.auth.request');
  assert.match(webTab.runtimeMessages[0].requestId, /^collector-/);
  assert.equal(webTab.runtimeMessages[1].requestId, webTab.runtimeMessages[0].requestId);
  assert.deepEqual(harness.sentTabMessages.map(({ tabId }) => tabId), [17, 17]);
  assert.equal(new Set(webTab.runtimeMessages.map(({ requestId }) => requestId)).size, 1);
  assert.equal(webTab.posts.length, 1, 'only the injected selected flow requests a ticket');
  assert.deepEqual(webTab.executedFiles, [
    'lib/web-bridge-policy.js',
    'lib/collector-auth-flow.js',
    'content/sync-auth.js',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.executeScriptCalls)), [
    {
      target: { tabId: 17 },
      files: ['lib/web-bridge-policy.js'],
    },
    {
      target: { tabId: 17 },
      files: ['lib/collector-auth-flow.js'],
    },
    {
      target: { tabId: 17 },
      files: ['content/sync-auth.js'],
    },
  ]);
});

test('install and startup never reload or remove user-owned Seller tabs', async () => {
  const harness = loadServiceWorker({ sellerCapture: true });
  for (const listener of harness.runtimeOnInstalled.listeners) listener();
  for (const listener of harness.runtimeOnStartup.listeners) listener();
  await settle();
  assert.deepEqual(harness.reloadedTabs, []);
  assert.deepEqual(harness.removedTabs, []);
});

test('successful Collector exchange refreshes only open Ozon buyer pages', async () => {
  const buyerPatterns = [
    'https://ozon.ru/*',
    'https://www.ozon.ru/*',
    'https://ozon.kz/*',
    'https://www.ozon.kz/*',
  ];
  const harness = loadServiceWorker({
    tabQueryImpl: async (query) => (
      JSON.stringify(query.url) === JSON.stringify(buyerPatterns)
        ? [{ id: 31 }, { id: 32 }]
        : []
    ),
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/extension/collector-auth/exchange') {
        return new Response(JSON.stringify({
          data: {
            collectorToken: 'csess_refresh_success_123456789',
            expiresAt: '2099-01-01T00:00:00.000Z',
            account: { id: 'account-refresh', displayName: 'Refresh' },
            permissions: ['collector.upload', 'collector.ozon.read'],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === AVAILABILITY_PATH) {
        return availabilityResponse(url, options, false);
      }
      throw new Error(`unexpected refresh path: ${pathname}`);
    },
  });

  await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    generationId: G1,
  }, trustedWebSender);
  const exchanged = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: 'exchange-refresh-success',
    generationId: G1,
    ticket: 'ctt_refresh_success_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedWebSender);
  await settle();

  assert.equal(exchanged.ok, true);
  assert.deepEqual(harness.reloadedTabs, [31, 32]);
  assert.ok(harness.tabQueryCalls.some(({ url }) => (
    JSON.stringify(url) === JSON.stringify(buyerPatterns)
  )));
  assert.equal(harness.tabQueryCalls.some(({ url }) => (
    JSON.stringify(url).includes('seller.ozon.ru')
  )), false);
});

test('failed Collector exchange never refreshes an Ozon page', async () => {
  const harness = loadServiceWorker({
    collectorExchangeImpl: async () => {
      throw Object.assign(new Error('expired'), {
        status: 401,
        code: 'COLLECTOR_TICKET_EXPIRED',
      });
    },
    tabQueryImpl: async () => [{ id: 31 }],
  });

  await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    generationId: G1,
  }, trustedWebSender);
  const exchanged = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: 'exchange-refresh-failure',
    generationId: G1,
    ticket: 'ctt_refresh_failure_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedWebSender);
  await settle();

  assert.equal(exchanged.ok, false);
  assert.equal(exchanged.code, 'COLLECTOR_TICKET_EXPIRED');
  assert.deepEqual(harness.reloadedTabs, []);
});

test('autonomous enrichment drain runs every minute and kicks on startup, pending upload, and session exchange', async () => {
  const nextPath = '/api/collector/ozon/enrichment-jobs/next';
  const startupHarness = loadServiceWorker({
    sellerCapture: true,
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, true);
      if (pathname === nextPath) {
        return new Response(JSON.stringify({ ok: true, job: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected startup path: ${pathname}`);
    },
  });
  for (const listener of startupHarness.runtimeOnStartup.listeners) listener();
  await settle();
  const enrichmentAlarms = startupHarness.createdAlarms
    .filter(({ name }) => name === 'collectorOzonEnrichmentTick');
  assert.equal(enrichmentAlarms.length, 1);
  assert.equal(enrichmentAlarms[0].options.periodInMinutes, 1);
  assert.equal(
    startupHarness.fetchCalls.filter(({ url }) => new URL(url).pathname === nextPath).length,
    1,
  );
  for (const listener of startupHarness.alarmsOnAlarm.listeners) {
    listener({ name: 'collectorOzonEnrichmentTick' });
  }
  await settle();
  assert.equal(
    startupHarness.fetchCalls.filter(({ url }) => new URL(url).pathname === nextPath).length,
    2,
  );

  const uploadHarness = loadServiceWorker({
    sellerCapture: true,
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/sources/ozon/collect') {
        return new Response(JSON.stringify({
          duplicate: false,
          data: { id: 'public-first', enrichment: { status: 'PENDING_ENRICHMENT' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === nextPath) {
        return new Response(JSON.stringify({ ok: true, job: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, true);
      throw new Error(`unexpected upload path: ${pathname}`);
    },
  });
  const uploaded = await sendRuntimeMessage(uploadHarness, {
    action: 'pushSourceCollect',
    sourceId: 'ozon',
    requestId: 'public-first-kick',
    raw: { sku: '4862904234', name: 'Public title' },
  });
  await settle();
  assert.equal(uploaded.ok, true);
  assert.equal(
    uploadHarness.fetchCalls.filter(({ url }) => new URL(url).pathname === nextPath).length,
    1,
  );

  const exchangeHarness = loadServiceWorker({
    sellerCapture: true,
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/extension/collector-auth/exchange') {
        return new Response(JSON.stringify({
          data: {
            collectorToken: 'csess_exchanged_behavior_test_123456789',
            expiresAt: '2099-01-01T00:00:00.000Z',
            account: { id: 'account-exchanged', displayName: 'Exchanged' },
            permissions: ['collector.upload', 'collector.ozon.read'],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === nextPath) {
        return new Response(JSON.stringify({ ok: true, job: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, true);
      throw new Error(`unexpected exchange path: ${pathname}`);
    },
  });
  const begun = await sendRuntimeMessage(exchangeHarness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    generationId: 'generation_A_1234',
  }, trustedWebSender);
  assert.deepEqual(JSON.parse(JSON.stringify(begun)), {
    ok: true,
    data: { changed: true },
  });

  const exchanged = await sendRuntimeMessage(exchangeHarness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: 'exchange-kick',
    generationId: 'generation_A_1234',
    ticket: 'ctt_exchange_kick_secret_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedWebSender);
  await settle();
  assert.equal(exchanged.ok, true);
  assert.equal(
    exchangeHarness.fetchCalls.filter(({ url }) => new URL(url).pathname === nextPath).length,
    1,
  );
});

test('Collector portal generations fence stale exchange and stale logout', async () => {
  const exchangePath = '/api/extension/collector-auth/exchange';
  const harness = loadServiceWorker({
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === exchangePath) {
        return new Response(JSON.stringify({
          data: {
            collectorToken: 'csess_generation_g2_secret_123456789',
            expiresAt: '2099-01-01T00:00:00.000Z',
            account: { id: 'account-generation-g2', displayName: 'Generation G2' },
            permissions: ['collector.upload', 'collector.ozon.read'],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, false);
      throw new Error(`unexpected generation route path: ${pathname}`);
    },
  });

  const begunG1 = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    generationId: 'generation_G1_1234',
  }, trustedWebSender);
  assert.deepEqual(JSON.parse(JSON.stringify(begunG1)), {
    ok: true,
    data: { changed: true },
  });

  const begunG2 = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    generationId: 'generation_G2_5678',
  }, trustedWebSender);
  assert.deepEqual(JSON.parse(JSON.stringify(begunG2)), {
    ok: true,
    data: { changed: true },
  });

  const staleExchange = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: 'exchange-generation-g1-stale',
    generationId: 'generation_G1_1234',
    ticket: 'ctt_exchange_generation_g1_secret_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedWebSender);
  assert.equal(staleExchange.ok, false);
  assert.equal(staleExchange.code, 'COLLECTOR_AUTH_GENERATION_CHANGED');
  assert.equal(
    harness.fetchCalls.filter(({ url }) => new URL(url).pathname === exchangePath).length,
    0,
    'a stale generation must be rejected before external exchange',
  );
  assert.equal(
    harness.fetchCalls.filter(({ url }) => new URL(url).pathname === AVAILABILITY_PATH).length,
    0,
    'a rejected stale exchange must not kick enrichment',
  );
  assert.doesNotMatch(JSON.stringify(staleExchange), /ctt_exchange_generation_g1_secret/);

  const exchangedG2 = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: 'exchange-generation-g2',
    generationId: 'generation_G2_5678',
    ticket: 'ctt_exchange_generation_g2_secret_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedWebSender);
  assert.equal(exchangedG2.ok, true);

  const staleLogout = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.logout',
    generationId: 'generation_G1_1234',
  }, trustedWebSender);
  assert.deepEqual(JSON.parse(JSON.stringify(staleLogout)), {
    ok: true,
    data: { cleared: false },
  });

  const auth = await sendRuntimeMessage(harness, { action: 'getAuth' });
  assert.equal(auth.ok, true);
  assert.equal(auth.data.authenticated, true);
  assert.equal(auth.data.account.id, 'account-generation-g2');
});

test('authoritative content recovery re-begins Web G1 after internal logout', async () => {
  let exchangeCount = 0;
  const worker = loadServiceWorker({
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/extension/collector-auth/exchange') {
        exchangeCount += 1;
        return new Response(JSON.stringify({
          data: {
            collectorToken: `csess_real_recovery_${exchangeCount}_123456789`,
            expiresAt: '2099-01-01T00:00:00.000Z',
            account: { id: `account-recovery-${exchangeCount}`, displayName: 'Recovery' },
            permissions: ['collector.upload', 'collector.ozon.read'],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, false);
      throw new Error(`unexpected authoritative recovery path: ${pathname}`);
    },
  });
  const webTab = await loadCollectorAuthContent(worker);

  await webTab.sendRuntimeMessage({
    action: 'collector.auth.request',
    requestId: 'collector-initial-recovery-g1',
  });
  await webTab.emitWebMessage(collectorReady(G1));
  const firstRequest = webTab.posts.at(-1).message;
  await webTab.emitWebMessage(collectorResponse(firstRequest.requestId, G1, 'g1-first'));
  assert.equal(worker.session.state[COLLECTOR_GENERATION_KEY], G1);
  assert.equal(worker.session.state[COLLECTOR_SESSION_KEY].account.id, 'account-recovery-1');

  assert.deepEqual(
    JSON.parse(JSON.stringify(await sendRuntimeMessage(worker, { action: 'logout' }))),
    { ok: true },
  );
  assert.equal(worker.session.state[COLLECTOR_SESSION_KEY], undefined);
  assert.equal(worker.session.state[COLLECTOR_GENERATION_KEY], undefined);

  assert.deepEqual(
    JSON.parse(JSON.stringify(await webTab.sendRuntimeMessage({ action: 'collector.auth.request' }))),
    { ok: false, requested: false, requestId: '' },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await webTab.sendRuntimeMessage({
      action: 'collector.auth.request',
      requestId: 'collector-recovery-g1',
    }))),
    { ok: true, requested: true, requestId: 'collector-recovery-g1' },
  );
  const recoveryRequest = webTab.posts.at(-1).message;
  await webTab.emitWebMessage(collectorResponse(recoveryRequest.requestId, G1, 'g1-recovery'));

  assert.deepEqual(
    JSON.parse(JSON.stringify(webTab.sentRuntimeMessages.map(({ action, generationId }) => ({
      action,
      generationId,
    })))),
    [
      { action: 'collector.auth.begin', generationId: G1 },
      { action: 'collector.auth.exchange', generationId: G1 },
      { action: 'collector.auth.begin', generationId: G1 },
      { action: 'collector.auth.exchange', generationId: G1 },
    ],
  );
  assert.equal(worker.session.state[COLLECTOR_GENERATION_KEY], G1);
  assert.equal(worker.session.state[COLLECTOR_SESSION_KEY].account.id, 'account-recovery-2');
});

test('authoritative content recovery adopts only current Web G2 over cached G1', async () => {
  let exchangeCount = 0;
  const worker = loadServiceWorker({
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/extension/collector-auth/exchange') {
        exchangeCount += 1;
        return new Response(JSON.stringify({
          data: {
            collectorToken: `csess_real_current_web_${exchangeCount}_123456789`,
            expiresAt: '2099-01-01T00:00:00.000Z',
            account: { id: `account-current-web-${exchangeCount}`, displayName: 'Current Web' },
            permissions: ['collector.upload', 'collector.ozon.read'],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, false);
      throw new Error(`unexpected current Web recovery path: ${pathname}`);
    },
  });
  const webTab = await loadCollectorAuthContent(worker);

  await webTab.sendRuntimeMessage({
    action: 'collector.auth.request',
    requestId: 'collector-initial-current-web-g1',
  });
  await webTab.emitWebMessage(collectorReady(G1));
  const firstRequest = webTab.posts.at(-1).message;
  await webTab.emitWebMessage(collectorResponse(firstRequest.requestId, G1, 'g1'));

  assert.deepEqual(
    JSON.parse(JSON.stringify(await webTab.sendRuntimeMessage({ action: 'collector.auth.request' }))),
    { ok: false, requested: false, requestId: '' },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await webTab.sendRuntimeMessage({
      action: 'collector.auth.request',
      requestId: 'collector-recovery-g2',
    }))),
    { ok: true, requested: true, requestId: 'collector-recovery-g2' },
  );
  const recoveryRequest = webTab.posts.at(-1).message;
  await webTab.emitWebMessage(collectorResponse(recoveryRequest.requestId, G2, 'g2'));

  assert.deepEqual(
    JSON.parse(JSON.stringify(webTab.sentRuntimeMessages.map(({ action, generationId }) => ({
      action,
      generationId,
    })))),
    [
      { action: 'collector.auth.begin', generationId: G1 },
      { action: 'collector.auth.exchange', generationId: G1 },
      { action: 'collector.auth.begin', generationId: G2 },
      { action: 'collector.auth.exchange', generationId: G2 },
    ],
  );
  assert.equal(worker.session.state[COLLECTOR_GENERATION_KEY], G2);
  assert.equal(worker.session.state[COLLECTOR_SESSION_KEY].account.id, 'account-current-web-2');
});

test('authoritative same-G1 recovery fences a logout-before deferred exchange incarnation', async () => {
  const oldExchangeResponse = deferred();
  const newExchangeResponse = deferred();
  let exchangeCalls = 0;
  const worker = loadServiceWorker({
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/extension/collector-auth/exchange') {
        exchangeCalls += 1;
        return exchangeCalls === 1
          ? oldExchangeResponse.promise
          : newExchangeResponse.promise;
      }
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, false);
      throw new Error(`unexpected same-G1 ABA recovery path: ${pathname}`);
    },
  });
  const oldWebTab = await loadCollectorAuthContent(worker);

  await oldWebTab.sendRuntimeMessage({
    action: 'collector.auth.request',
    requestId: 'collector-initial-old-incarnation-g1',
  });
  await oldWebTab.emitWebMessage(collectorReady(G1));
  const oldRequest = oldWebTab.posts.at(-1).message;
  const oldFlowExchange = oldWebTab.emitWebMessage(
    collectorResponse(oldRequest.requestId, G1, 'old-incarnation'),
  );
  while (exchangeCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  const oldIncarnation = worker.session.state[COLLECTOR_INCARNATION_KEY];

  assert.deepEqual(
    JSON.parse(JSON.stringify(await sendRuntimeMessage(worker, { action: 'logout' }))),
    { ok: true },
  );
  assert.equal(worker.session.state[COLLECTOR_SESSION_KEY], undefined);
  assert.equal(worker.session.state[COLLECTOR_GENERATION_KEY], undefined);
  assert.equal(worker.session.state[COLLECTOR_INCARNATION_KEY], undefined);

  const recoveryWebTab = await loadCollectorAuthContent(worker);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await recoveryWebTab.sendRuntimeMessage({
      action: 'collector.auth.request',
    }))),
    { ok: false, requested: false, requestId: '' },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await recoveryWebTab.sendRuntimeMessage({
      action: 'collector.auth.request',
      requestId: 'collector-recovery-g1-new-incarnation',
    }))),
    {
      ok: true,
      requested: true,
      requestId: 'collector-recovery-g1-new-incarnation',
    },
  );
  const recoveryRequest = recoveryWebTab.posts.at(-1).message;
  const newFlowExchange = recoveryWebTab.emitWebMessage(
    collectorResponse(recoveryRequest.requestId, G1, 'new-incarnation'),
  );
  while (exchangeCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  const newIncarnation = worker.session.state[COLLECTOR_INCARNATION_KEY];

  oldExchangeResponse.resolve(new Response(JSON.stringify({
    data: {
      collectorToken: 'csess_old_incarnation_must_not_restore_123456789',
      expiresAt: '2099-01-01T00:00:00.000Z',
      account: { id: 'account-old-incarnation', displayName: 'Old Incarnation' },
      permissions: ['collector.upload', 'collector.ozon.read'],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await oldFlowExchange;

  assert.equal(worker.session.state[COLLECTOR_SESSION_KEY], undefined);
  assert.notEqual(newIncarnation, oldIncarnation);
  assert.equal(worker.session.state[COLLECTOR_GENERATION_KEY], G1);
  assert.equal(worker.session.state[COLLECTOR_INCARNATION_KEY], newIncarnation);

  newExchangeResponse.resolve(new Response(JSON.stringify({
    data: {
      collectorToken: 'csess_new_incarnation_123456789',
      expiresAt: '2099-01-01T00:00:00.000Z',
      account: { id: 'account-new-incarnation', displayName: 'New Incarnation' },
      permissions: ['collector.upload', 'collector.ozon.read'],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await newFlowExchange;

  assert.equal(worker.session.state[COLLECTOR_SESSION_KEY].account.id, 'account-new-incarnation');
  assert.equal(worker.session.state[COLLECTOR_GENERATION_KEY], G1);
  assert.equal(worker.session.state[COLLECTOR_INCARNATION_KEY], newIncarnation);
});

test('Collector exchange errors expose only finite status and sanitized stable code', async () => {
  const ticket = 'ctt_exchange_error_secret_123456789';
  const harness = loadServiceWorker({
    collectorExchangeImpl: async () => {
      const error = new Error(`exchange rejected for ${ticket}`);
      error.status = Symbol(`503-${ticket}`);
      error.code = `UPSTREAM_${ticket}`;
      throw error;
    },
  });

  const begun = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    generationId: 'generation_error_1234',
  }, trustedWebSender);
  assert.equal(begun.ok, true);

  const response = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: 'exchange-error-envelope',
    generationId: 'generation_error_1234',
    ticket,
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedWebSender);

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: false,
    status: 0,
    code: 'COLLECTOR_AUTH_FAILED',
    error: 'exchange rejected for [REDACTED]',
  });
  assert.doesNotMatch(JSON.stringify(response), /ctt_exchange_error_secret/);
});

test('logout never reloads or removes a user-owned Seller tab', async () => {
  const harness = loadServiceWorker({ sellerCapture: true });
  const response = await sendRuntimeMessage(harness, { action: 'logout' });
  await settle();
  assert.equal(response.ok, true);
  assert.deepEqual(harness.reloadedTabs, []);
  assert.deepEqual(harness.removedTabs, []);
});

test('internal logout invalidates a held exchange generation before its response can restore a session', async () => {
  const exchangeStarted = deferred();
  const exchangeResponse = deferred();
  const harness = loadServiceWorker({
    sellerCapture: true,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/extension/collector-auth/exchange') {
        exchangeStarted.resolve();
        return exchangeResponse.promise;
      }
      throw new Error(`unexpected internal logout path: ${pathname}`);
    },
  });

  const begun = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    generationId: 'generation_G1_1234',
  }, trustedWebSender);
  assert.equal(begun.ok, true);

  const heldExchangeResponse = deferred();
  harness.runtimeOnMessage.listeners[0]({
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: 'internal-logout-held-exchange',
    generationId: 'generation_G1_1234',
    ticket: 'ctt_internal_logout_secret_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedWebSender, heldExchangeResponse.resolve);
  await exchangeStarted.promise;

  const logout = await sendRuntimeMessage(harness, { action: 'logout' });
  assert.deepEqual(JSON.parse(JSON.stringify(logout)), { ok: true });
  assert.deepEqual(harness.reloadedTabs, []);
  assert.deepEqual(harness.removedTabs, []);

  exchangeResponse.resolve(new Response(JSON.stringify({
    data: {
      collectorToken: 'csess_internal_logout_must_not_restore_123456789',
      expiresAt: '2099-01-01T00:00:00.000Z',
      account: { id: 'account-internal-logout', displayName: 'Internal Logout' },
      permissions: ['collector.upload', 'collector.ozon.read'],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));

  const exchange = await heldExchangeResponse.promise;
  assert.equal(exchange.ok, false);
  assert.equal(exchange.code, 'COLLECTOR_AUTH_GENERATION_CHANGED');
  assert.doesNotMatch(JSON.stringify(exchange), /ctt_internal_logout_secret|csess_internal_logout/);

  const auth = await sendRuntimeMessage(harness, { action: 'getAuth' });
  assert.equal(auth.ok, true);
  assert.equal(auth.data.authenticated, false);
  assert.equal(auth.data.account, null);
  assert.deepEqual(JSON.parse(JSON.stringify(auth.data.permissions)), []);
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
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, false);
      if (pathname === '/api/collector/ozon/enrich') {
        return new Response(JSON.stringify({ ok: true, data: completeResult }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected runtime success path: ${pathname}`);
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
  assert.deepEqual(successHarness.fetchCalls.map(({ url }) => new URL(url).pathname).sort(), [
    '/api/collector/ozon/enrich',
    AVAILABILITY_PATH,
  ].sort());
  const enrichCall = successHarness.fetchCalls.find(
    ({ url }) => new URL(url).pathname === '/api/collector/ozon/enrich',
  );
  const availabilityCall = successHarness.fetchCalls.find(
    ({ url }) => new URL(url).pathname === AVAILABILITY_PATH,
  );
  assert.deepEqual(JSON.parse(enrichCall.options.body), {
    requestId: 'runtime-success',
    sku: '4862904234',
  });
  assert.deepEqual(JSON.parse(availabilityCall.options.body), {});
  assert.equal(
    successHarness.fetchCalls.some(({ url }) => /\/ozon\/sync|api-seller\.ozon\.ru/.test(url)),
    false,
  );

  const errorHarness = loadServiceWorker({
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, false);
      if (pathname === '/api/collector/ozon/enrich') {
        return new Response(JSON.stringify({
          ok: false,
          code: 'OZON_ENRICH_INCOMPLETE',
          message: 'missing cst_do-not-leak-runtime-secret',
          missingFields: ['weightG'],
          retryable: true,
        }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected runtime error path: ${pathname}`);
    },
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
  let postedResultBody = null;
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
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, true);
      if (pathname === '/api/collector/ozon/enrichment-jobs/next') {
        nextCalls += 1;
        return new Response(JSON.stringify({
          ok: true,
          job: nextCalls === 1
            ? {
              id: 'job-local',
              requestId: 'runtime-local',
              sku,
              refreshBundle: false,
              claimFence: 'claim-local',
            }
            : null,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === '/api/collector/ozon/enrichment-jobs/job-local/result') {
        postedResultBody = JSON.parse(options.body);
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
  const normalizedResultBody = JSON.parse(JSON.stringify(postedResultBody));
  assert.deepEqual(normalizedResultBody.variantData, {
    description_category_id: 123,
    type_id: 456,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    attributes: variantData.attributes,
  });
  assert.deepEqual(normalizedResultBody.captureContext, {
    sellerCompanyId: '1234',
    revision: 1,
    observedAt: normalizedResultBody.captureContext.observedAt,
  });
  assert.equal(Number.isNaN(Date.parse(normalizedResultBody.captureContext.observedAt)), false);
  assert.equal(normalizedResultBody.claimFence, 'claim-local');
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

test('retired privileged actions reject without network, browser, cookie, or storage side effects', async () => {
  const harness = loadServiceWorker();
  const retiredMessages = [
    { action: 'addFavorite', product: { id: 'retired-product' } },
    { action: 'aiListingDraftConfirm', draftId: 'retired-draft' },
    { action: 'aiListingDraftCreate', body: { title: 'retired' } },
    { action: 'aiListingDraftPublish', draftId: 'retired-draft' },
    { action: 'aiOptimize', title: 'retired' },
    { action: 'checkSellerCookies' },
    { action: 'checkUpdate' },
    { action: 'collectBatch', products: [{ id: 'retired-product' }] },
    { action: 'collectProduct', product: { id: 'retired-product' } },
    { action: 'fetchOzonPublicProduct', sku: '123456789' },
    { action: 'focusSellerRecoveryTab' },
    { action: 'getFavCount' },
    { action: 'importStock', items: [{ sku: 'retired-sku', stock: 1 }] },
    { action: 'pushToCollectBox', items: [{ id: 'retired-product' }] },
    { action: 'refreshBackend' },
    { action: 'savePricingSnapshot', body: { productId: 'retired-product' } },
  ];
  await settle();
  const localBefore = JSON.parse(JSON.stringify(harness.local.state));
  const sessionBefore = JSON.parse(JSON.stringify(harness.session.state));

  for (const message of retiredMessages) {
    const response = await sendRuntimeMessage(harness, message);
    assert.deepEqual(
      JSON.parse(JSON.stringify(response)),
      { ok: false, error: '未知消息类型' },
      message.action,
    );
  }

  assert.deepEqual(harness.fetchCalls, []);
  assert.deepEqual(harness.cookieQueries, []);
  assert.deepEqual(harness.createdTabs, []);
  assert.deepEqual(harness.executeScriptCalls, []);
  assert.deepEqual(harness.updatedTabs, []);
  assert.deepEqual(harness.updatedWindows, []);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.local.state)), localBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.session.state)), sessionBefore);
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

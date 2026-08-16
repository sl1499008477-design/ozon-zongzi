const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const extensionRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const trustedSender = {
  url: 'http://127.0.0.1:3000/app',
  tab: { id: 17, url: 'http://127.0.0.1:3000/app' },
};

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
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
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
      key,
      state[key] === undefined ? fallback : state[key],
    ]));
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

function loadServiceWorker({ activationResult }) {
  const workerPath = path.join(extensionRoot, manifest.background.service_worker);
  const runtimeOnMessage = createEvent();
  const event = createEvent();
  const activationCalls = [];
  const local = createStorageArea();
  const session = createStorageArea();
  const sync = createStorageArea();
  let context;
  const chrome = {
    action: {
      openPopup: async () => {},
      setBadgeBackgroundColor() {},
      setBadgeText() {},
    },
    alarms: { create() {}, onAlarm: event },
    contextMenus: { removeAll(callback) { callback?.(); }, create() {}, onClicked: event },
    cookies: { getAll: async () => [] },
    notifications: { create() {}, clear() {}, onClicked: event },
    runtime: {
      id: 'service-worker-collector-auth-test',
      getManifest: () => manifest,
      getPlatformInfo(callback) { callback?.({}); },
      getURL: (entry) => `chrome-extension://service-worker-collector-auth-test/${entry}`,
      lastError: null,
      onInstalled: event,
      onMessage: runtimeOnMessage,
      onStartup: event,
      sendMessage: async () => null,
    },
    scripting: { executeScript: async () => [] },
    storage: { local, session, sync },
    tabs: {
      create: async () => ({ id: 1 }),
      get: async (tabId) => ({ id: tabId, url: 'https://seller.ozon.ru/app' }),
      onCreated: event,
      onRemoved: event,
      onUpdated: event,
      query: async () => [],
      reload() {},
      remove: async () => {},
      sendMessage: async () => null,
      update: async () => ({}),
    },
    windows: { update: async () => ({}) },
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
    console: { error() {}, info() {}, log() {}, warn() {} },
    crypto: webcrypto,
    fetch: async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    globalThis: null,
    navigator: {
      hardwareConcurrency: 8,
      language: 'en-US',
      platform: 'test',
      userAgent: 'service-worker-collector-auth-test',
    },
    setInterval() { return 1; },
    setTimeout() { return 1; },
  });
  context.globalThis = context;
  context.self = context;
  context.importScripts = (...entries) => {
    for (const entry of entries) {
      const file = path.resolve(path.dirname(workerPath), entry);
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
      if (entry === '../lib/collector-session.js') {
        const collectorSessionApi = context.JzCollectorSession;
        context.JzCollectorSession = Object.freeze({
          ...collectorSessionApi,
          createCollectorSessionManager(options) {
            const manager = collectorSessionApi.createCollectorSessionManager(options);
            return Object.freeze({
              ...manager,
              async activateCollectorGeneration(input) {
                activationCalls.push(JSON.parse(JSON.stringify(input)));
                return activationResult;
              },
            });
          },
        });
      }
    }
  };
  vm.runInContext(fs.readFileSync(workerPath, 'utf8'), context, { filename: workerPath });
  assert.equal(runtimeOnMessage.listeners.length, 1);
  return { activationCalls, runtimeOnMessage };
}

async function sendCollectorBegin(harness, accountIdHint = 'account-a') {
  return new Promise((resolve) => {
    harness.runtimeOnMessage.listeners[0]({
      portalProtocol: 'SONLI_COLLECTOR_AUTH',
      action: 'collector.auth.begin',
      generationId: 'generation_A_1234',
      accountIdHint,
    }, trustedSender, resolve);
  });
}

test('collector auth begin passes the account hint and returns a token-free reused projection', async () => {
  const harness = loadServiceWorker({
    activationResult: {
      changed: true,
      reused: true,
      authenticated: true,
      collectorToken: 'cst_must_not_escape_service_worker_123456789',
      account: { id: 'account-a', displayName: 'Account A' },
      permissions: ['collector.upload'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  });

  const response = await sendCollectorBegin(harness);

  assert.deepEqual(harness.activationCalls, [{
    generationId: 'generation_A_1234',
    accountIdHint: 'account-a',
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: {
      changed: true,
      reused: true,
      authenticated: true,
      account: { id: 'account-a', displayName: 'Account A' },
      permissions: ['collector.upload'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  });
  assert.equal(JSON.stringify(response).includes('cst_must_not_escape'), false);
});

test('collector auth begin returns unauthenticated public fields when reuse does not succeed', async () => {
  const harness = loadServiceWorker({
    activationResult: {
      changed: true,
      reused: false,
      authenticated: true,
      collectorToken: 'cst_false_auth_must_not_escape_123456789',
      account: { id: 'account-a', displayName: 'Account A' },
      permissions: ['collector.upload'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  });

  const response = await sendCollectorBegin(harness);

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: {
      changed: true,
      reused: false,
      authenticated: false,
      account: null,
      permissions: [],
      expiresAt: '',
    },
  });
  assert.equal(JSON.stringify(response).includes('cst_false_auth'), false);
});

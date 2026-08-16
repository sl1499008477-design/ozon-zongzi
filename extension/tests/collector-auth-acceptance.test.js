const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { webcrypto } = require('node:crypto');

const webBridgePolicy = require('../lib/web-bridge-policy.js');
const collectorAuthFlow = require('../lib/collector-auth-flow.js');
const {
  COLLECTOR_PERMISSIONS,
  COLLECTOR_SESSION_STORAGE_KEY,
} = require('../lib/collector-session.js');

const extensionRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const workerPath = path.join(extensionRoot, 'background/service-worker.js');
const syncAuthPath = path.join(extensionRoot, 'content/sync-auth.js');
const popupPath = path.join(extensionRoot, 'popup/popup.js');
const sellerStatusControllerPath = path.join(
  extensionRoot,
  'lib/seller-context-status-controller.js',
);
const webBridgePath = path.join(repositoryRoot, 'app/src/collector-auth-bridge.js');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const START = Date.parse('2030-01-01T00:00:00.000Z');
const GENERATION = 'generation_acceptance_1234';
const STATUS_KEY = 'sonliCollectorAuthStatus';
const STATUS_KEYS = [
  'account',
  'attemptNumber',
  'expiresAt',
  'generationId',
  'nextRetryAt',
  'phase',
  'publicCode',
  'startedAt',
  'updatedAt',
  'version',
];
const trustedWebSender = {
  url: 'http://127.0.0.1:3000/app',
  tab: { id: 17, url: 'http://127.0.0.1:3000/app' },
};
const extensionSender = {
  id: 'collector-auth-acceptance',
  url: 'chrome-extension://collector-auth-acceptance/popup/popup.html',
};

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const flush = async (turns = 300) => {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(...args) {
      return listeners.map((listener) => listener(...args));
    },
  };
}

function createFakeClock(start = START) {
  let current = start;
  let sequence = 0;
  const timers = [];
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [current])); }
    static now() { return current; }
  }
  const setTimer = (callback, delay = 0) => {
    const timer = {
      callback,
      cancelled: false,
      dueAt: current + Math.max(0, Number(delay) || 0),
      id: ++sequence,
    };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (timer) => {
    if (timer) timer.cancelled = true;
  };
  const advance = async (milliseconds) => {
    const target = current + milliseconds;
    let guard = 0;
    while (true) {
      const next = timers
        .filter((timer) => !timer.cancelled && timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) break;
      assert.ok(++guard < 500, 'fake timer loop must stay bounded');
      next.cancelled = true;
      current = next.dueAt;
      await next.callback();
      await flush();
    }
    current = target;
    await flush();
  };
  return {
    Date: FixtureDate,
    advance,
    clearTimer,
    now: () => current,
    setTimer,
    timers,
  };
}

function selectStorage(state, keys) {
  if (keys == null) return { ...state };
  if (typeof keys === 'string') return { [keys]: state[keys] };
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((key) => [key, state[key]]));
  }
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
    key,
    state[key] === undefined ? fallback : state[key],
  ]));
}

function createStorageArea(areaName, onChanged, initial = {}) {
  const state = clone(initial);
  return {
    state,
    get(keys, callback) {
      const result = clone(selectStorage(state, keys));
      if (callback) callback(result);
      else return Promise.resolve(result);
    },
    set(values, callback) {
      const changes = {};
      for (const [key, value] of Object.entries(values || {})) {
        changes[key] = { oldValue: clone(state[key]), newValue: clone(value) };
        state[key] = clone(value);
      }
      if (Object.keys(changes).length) onChanged.emit(changes, areaName);
      if (callback) callback();
      else return Promise.resolve();
    },
    remove(keys, callback) {
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.hasOwn(state, key)) {
          changes[key] = { oldValue: clone(state[key]), newValue: undefined };
          delete state[key];
        }
      }
      if (Object.keys(changes).length) onChanged.emit(changes, areaName);
      if (callback) callback();
      else return Promise.resolve();
    },
  };
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value); else this.values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.options = [];
    this.selectedIndex = 0;
    this.value = '';
    this._innerHTML = '';
    this._textContent = '';
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  appendChild(child) {
    this.children.push(child);
    if (this.tagName === 'SELECT') this.options.push(child);
    return child;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelector() {
    if (!this._nested) this._nested = new FakeElement('span');
    return this._nested;
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value || '');
    this.children = [];
    if (this.tagName === 'SELECT') this.options = [];
  }
  get textContent() {
    return [
      this._textContent,
      this._innerHTML,
      ...this.children.map((child) => child.textContent),
    ].join('');
  }
  set textContent(value) {
    this._textContent = String(value || '');
    this._innerHTML = '';
    this.children = [];
  }
}

class FakeDocument {
  constructor() {
    this.title = '__BRAND_DISPLAY_NAME__';
    this.body = new FakeElement('body');
    this.elements = new Map();
  }
  getElementById(id) {
    if (!this.elements.has(id)) {
      const tagName = id === 'store-select'
        ? 'select'
        : id.endsWith('-btn') ? 'button' : 'div';
      const element = new FakeElement(tagName, id);
      this.elements.set(id, element);
      if (id === 'web-login-btn' || id === 'collector-auth-recheck-btn') {
        const svg = new FakeElement('svg');
        const labelId = id === 'web-login-btn'
          ? 'web-login-label'
          : 'collector-auth-recheck-label';
        const label = new FakeElement('span', labelId);
        label.textContent = id === 'web-login-btn' ? '前往登录' : '重新检查';
        this.elements.set(labelId, label);
        element.appendChild(svg);
        element.appendChild(label);
      }
    }
    return this.elements.get(id);
  }
  createElement(tagName) { return new FakeElement(tagName); }
  createTreeWalker() {
    return { currentNode: null, nextNode() { return false; } };
  }
  querySelectorAll() { return []; }
}

class FakePageWindow {
  constructor(origin = 'http://127.0.0.1:3000') {
    this.location = { origin };
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }
  postMessage(data, targetOrigin) {
    if (targetOrigin !== this.location.origin) return;
    const event = { data: clone(data), origin: this.location.origin, source: this };
    for (const listener of this.listeners.get('message') || []) {
      Promise.resolve().then(() => listener(event)).catch(() => {});
    }
  }
}

function safeStatus(status) {
  assert.deepEqual(Object.keys(status).sort(), STATUS_KEYS);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /collectorToken|bearer|fingerprint|cst_|ctt_/i);
  if (status.account) {
    assert.deepEqual(Object.keys(status.account).sort(), ['displayName', 'id']);
  }
  return status;
}

function createBrowserHarness({
  contentOrigin = 'http://127.0.0.1:3000',
  expectedContentListenerCount = 1,
  initialSession = null,
  exchangeResponses = [],
} = {}) {
  const clock = createFakeClock();
  const storageOnChanged = createEvent();
  const contentOnMessage = createEvent();
  const workerOnMessage = createEvent();
  const alarmOnAlarm = createEvent();
  const runtimeOnInstalled = createEvent();
  const runtimeOnStartup = createEvent();
  const contextMenusOnClicked = createEvent();
  const notificationsOnClicked = createEvent();
  const tabsOnCreated = createEvent();
  const tabsOnRemoved = createEvent();
  const tabsOnUpdated = createEvent();
  const local = createStorageArea('local', storageOnChanged);
  const session = createStorageArea('session', storageOnChanged, initialSession
    ? { [COLLECTOR_SESSION_STORAGE_KEY]: initialSession }
    : {});
  const sync = createStorageArea('sync', storageOnChanged);
  const workerMessages = [];
  const tabMessages = [];
  const exchangeCalls = [];
  const alarmCreates = [];
  const importedEntries = [];
  let exchangeIndex = 0;

  const sendWorker = (message, sender = trustedWebSender) => {
    workerMessages.push({ message: clone(message), sender: clone(sender) });
    return new Promise((resolve) => {
      assert.equal(workerOnMessage.listeners.length, 1);
      workerOnMessage.listeners[0](clone(message), clone(sender), resolve);
    });
  };
  const sendContent = (message) => new Promise((resolve) => {
    tabMessages.push(clone(message));
    const listener = contentOnMessage.listeners[0];
    if (!listener) {
      resolve(null);
      return;
    }
    listener(clone(message), {}, resolve);
  });

  const chrome = {
    action: {
      openPopup: async () => {},
      setBadgeBackgroundColor() {},
      setBadgeText() {},
    },
    alarms: {
      async clear() { return true; },
      create(name, options) { alarmCreates.push({ name, options: clone(options) }); },
      onAlarm: alarmOnAlarm,
    },
    contextMenus: {
      removeAll(callback) { callback?.(); }, create() {}, onClicked: contextMenusOnClicked,
    },
    cookies: { getAll: async () => [] },
    notifications: { create() {}, clear() {}, onClicked: notificationsOnClicked },
    runtime: {
      id: 'collector-auth-acceptance',
      getManifest: () => manifest,
      getPlatformInfo(callback) { callback?.({}); },
      getURL: (entry) => `chrome-extension://collector-auth-acceptance/${entry}`,
      lastError: null,
      onInstalled: runtimeOnInstalled,
      onMessage: workerOnMessage,
      onStartup: runtimeOnStartup,
      sendMessage: async () => null,
    },
    scripting: { executeScript: async () => [] },
    storage: { local, session, sync, onChanged: storageOnChanged },
    tabs: {
      create: async () => ({ id: 1 }),
      get: async (tabId) => ({ id: tabId, url: trustedWebSender.url }),
      onCreated: tabsOnCreated,
      onRemoved: tabsOnRemoved,
      onUpdated: tabsOnUpdated,
      query: async () => [{
        id: 17,
        active: true,
        lastAccessed: clock.now(),
        url: trustedWebSender.url,
      }],
      reload() {},
      remove: async () => {},
      sendMessage: (_tabId, message) => sendContent(message),
      update: async () => ({}),
    },
    windows: { update: async () => ({}) },
  };
  const context = vm.createContext({
    AbortController,
    AbortSignal,
    Blob,
    FormData,
    Headers,
    Intl,
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    atob,
    btoa,
    chrome,
    clearInterval() {},
    clearTimeout: clock.clearTimer,
    console: { error() {}, info() {}, log() {}, warn() {} },
    crypto: webcrypto,
    Date: clock.Date,
    fetch: async (url, options) => {
      if (!String(url).endsWith('/extension/collector-auth/exchange')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      exchangeCalls.push({ url: String(url), options: clone({
        method: options?.method,
        body: options?.body,
      }) });
      const behavior = exchangeResponses[Math.min(exchangeIndex, exchangeResponses.length - 1)];
      exchangeIndex += 1;
      if (behavior instanceof Error) throw behavior;
      const status = Number(behavior?.status || 200);
      const body = behavior?.body || {
        data: {
          collectorToken: `cst_acceptance_exchange_${exchangeIndex}_123456789`,
          account: { id: 'account-a', displayName: '账号 A' },
          permissions: [...COLLECTOR_PERMISSIONS],
          expiresAt: '2030-01-01T01:00:00.000Z',
        },
      };
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
    globalThis: null,
    navigator: {
      hardwareConcurrency: 8,
      language: 'zh-CN',
      platform: 'test',
      userAgent: 'collector-auth-acceptance',
    },
    setInterval() { return 1; },
    setTimeout: clock.setTimer,
  });
  context.globalThis = context;
  context.self = context;
  context.importScripts = (...entries) => {
    for (const entry of entries) {
      importedEntries.push(entry);
      const file = path.resolve(path.dirname(workerPath), entry);
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(workerPath, 'utf8'), context, { filename: workerPath });
  assert.equal(workerOnMessage.listeners.length, 1);

  const pageWindow = new FakePageWindow(contentOrigin);
  const contentChrome = {
    runtime: {
      lastError: null,
      onMessage: contentOnMessage,
      sendMessage(message, callback) {
        sendWorker(message, trustedWebSender).then(callback);
      },
    },
  };
  const contentContext = vm.createContext({
    chrome: contentChrome,
    clearTimeout: clock.clearTimer,
    crypto: webcrypto,
    Date: clock.Date,
    globalThis: null,
    JzCollectorAuthFlow: collectorAuthFlow,
    JzWebBridgePolicy: webBridgePolicy,
    Math,
    setTimeout: clock.setTimer,
    window: pageWindow,
  });
  contentContext.globalThis = contentContext;
  vm.runInContext(fs.readFileSync(syncAuthPath, 'utf8'), contentContext, {
    filename: syncAuthPath,
  });
  assert.equal(contentOnMessage.listeners.length, expectedContentListenerCount);

  const popupDocument = new FakeDocument();
  const popupWindowListeners = new Map();
  const popupMessages = [];
  const popupResponses = [];
  const pageRequests = [];
  pageWindow.addEventListener('message', (event) => {
    if (event.data?.action === 'collector.auth.request') {
      pageRequests.push(event.data.requestId);
    }
  });
  const popupChrome = {
    runtime: {
      getURL: chrome.runtime.getURL,
      sendMessage(message, callback) {
        popupMessages.push(clone(message));
        if (message.action === 'getAuth') {
          const status = session.state[STATUS_KEY];
          callback({
            ok: true,
            data: {
              authenticated: status?.phase === 'AUTHENTICATED',
              account: status?.account || null,
              expiresAt: status?.expiresAt || '',
              backendUrl: 'http://127.0.0.1:3000/api',
            },
          });
          return;
        }
        const fixtureResponses = {
          getSellerContextStatus: {
            ok: true,
            data: { status: 'READY', companyId: '2681910', observedAt: clock.now() },
          },
          getStores: { ok: false, error: '[401] Unauthorized' },
          checkSellerCookies: { ok: true, data: { has_cookies: false, sellerCompanyIds: [] } },
          getCollectCount: { ok: true, data: { total: 0 } },
          getProductStatusCounts: { ok: true, data: {} },
          listFollowSellTasks: { ok: true, data: { items: [] } },
          getUpdateInfo: {
            ok: true,
            data: { hasUpdate: false, currentVersion: manifest.version },
          },
        };
        if (fixtureResponses[message.action]) {
          callback(fixtureResponses[message.action]);
          return;
        }
        sendWorker(message, extensionSender).then((response) => {
          popupResponses.push({ action: message.action, response: clone(response) });
          callback(response);
        });
      },
    },
    storage: { local, session, onChanged: storageOnChanged },
    tabs: {
      async query() { return []; },
      async sendMessage() { return { ok: true }; },
      async create() {},
      async update() {},
    },
    windows: { async create() {}, async update() {} },
  };
  const popupContext = {
    chrome: popupChrome,
    console: { error() {}, info() {}, log() {}, warn() {} },
    Date: clock.Date,
    document: popupDocument,
    Intl,
    navigator: {
      hardwareConcurrency: 8,
      language: 'zh-CN',
      platform: 'test',
      userAgent: 'collector-auth-acceptance',
    },
    NodeFilter: { SHOW_TEXT: 4 },
    URL,
    alert() {},
    clearInterval() {},
    clearTimeout: clock.clearTimer,
    setInterval() { return 1; },
    setTimeout: clock.setTimer,
    window: {
      screen: { width: 1440, height: 900, colorDepth: 24 },
      close() {},
      confirm: () => true,
      addEventListener(type, listener) { popupWindowListeners.set(type, listener); },
    },
  };
  vm.runInNewContext(fs.readFileSync(sellerStatusControllerPath, 'utf8'), popupContext, {
    filename: sellerStatusControllerPath,
  });
  vm.runInNewContext(fs.readFileSync(popupPath, 'utf8'), popupContext, {
    filename: popupPath,
  });

  const popupObservations = [];
  storageOnChanged.addListener((changes, area) => {
    const next = changes?.[STATUS_KEY]?.newValue;
    if (area === 'session' && next) {
      popupObservations.push({
        status: clone(next),
        tip: popupDocument.getElementById('login-tip').textContent,
      });
    }
  });

  return {
    alarmCreates,
    alarmOnAlarm,
    clock,
    contentInstallGuard: contentContext.__JZ_COLLECTOR_SYNC_AUTH_INSTALLED__,
    contentListenerCount: () => contentOnMessage.listeners.length,
    exchangeCalls,
    importedEntries,
    pageWindow,
    pageRequests,
    popupDocument,
    popupMessages,
    popupResponses,
    popupObservations,
    session,
    receiveContent: sendContent,
    requestCollectorAuth() {
      return sendWorker({ action: 'requestCollectorAuth' }, extensionSender);
    },
    sendWorker,
    tabMessages,
    workerMessages,
    async installWebBridge({ accountId = 'account-a', requestTicket } = {}) {
      const bridge = await import(`${pathToFileURL(webBridgePath).href}?acceptance=${Math.random()}`);
      return bridge.installCollectorAuthBridge({
        accountId,
        generationId: GENERATION,
        isLoggedIn: () => true,
        requestTicket,
        windowObject: pageWindow,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      });
    },
    async status() {
      const response = await sendWorker({ action: 'getCollectorAuthStatus' }, extensionSender);
      return safeStatus(response.data);
    },
    unloadPopup() { popupWindowListeners.get('unload')?.(); },
  };
}

const validSession = () => ({
  collectorToken: 'cst_acceptance_reuse_123456789',
  expiresAt: '2030-01-01T01:00:00.000Z',
  account: { id: 'account-a', displayName: '账号 A' },
  permissions: [...COLLECTOR_PERMISSIONS],
});

test('content script does not discover Web auth until selected by the worker', async (t) => {
  const runtime = createBrowserHarness();
  t.after(() => runtime.unloadPopup());
  const removeBridge = await runtime.installWebBridge({
    requestTicket: async () => ({
      ticket: 'ctt_acceptance_selected_123456789',
      expiresAt: '2030-01-01T00:01:00.000Z',
    }),
  });
  t.after(removeBridge);

  await flush();
  assert.deepEqual(runtime.pageRequests, []);

  await runtime.requestCollectorAuth();
  await flush();
  assert.equal(runtime.pageRequests.length, 1);
  assert.match(runtime.pageRequests[0], /^collector-/);
});

test('content script installs no guard or runtime listener on an untrusted origin', async (t) => {
  for (const contentOrigin of [
    'https://attacker.example',
    'http://qh.jizhangerp.com',
    'https://sub.qh.jizhangerp.com',
    'http://127.0.0.1:3001',
  ]) {
    await t.test(contentOrigin, async (subtest) => {
      const runtime = createBrowserHarness({
        contentOrigin,
        expectedContentListenerCount: 0,
      });
      subtest.after(() => runtime.unloadPopup());

      assert.equal(runtime.contentInstallGuard, undefined);
      assert.equal(runtime.contentListenerCount(), 0);
      assert.equal(await runtime.receiveContent({
        action: 'collector.auth.request',
        requestId: 'collector-untrusted-origin-attempt',
      }), null);
      assert.deepEqual(runtime.pageRequests, []);
    });
  }
});

test('content script installs on the exact HTTPS brand origin', (t) => {
  const runtime = createBrowserHarness({ contentOrigin: 'https://qh.jizhangerp.com' });
  t.after(() => runtime.unloadPopup());

  assert.equal(runtime.contentInstallGuard, true);
  assert.equal(runtime.contentListenerCount(), 1);
  assert.deepEqual(runtime.pageRequests, []);
});

test('real Web→sync-auth→service-worker wiring reuses a same-account session within fake 500 ms', async (t) => {
  const runtime = createBrowserHarness({ initialSession: validSession() });
  t.after(() => runtime.unloadPopup());
  await flush();
  assert.ok(runtime.popupMessages.some(({ action }) => action === 'getCollectorAuthStatus'));

  let ticketRequests = 0;
  const startedAt = runtime.clock.now();
  const removeBridge = await runtime.installWebBridge({
    requestTicket: async () => {
      ticketRequests += 1;
      throw new Error('same-account reuse must not request a ticket');
    },
  });
  t.after(removeBridge);
  await flush();
  await runtime.requestCollectorAuth();
  await flush();

  assert.equal(ticketRequests, 0);
  assert.ok(runtime.clock.now() - startedAt <= 500);
  const status = await runtime.status();
  assert.equal(status.phase, 'AUTHENTICATED');
  assert.equal(status.generationId, GENERATION);
  const begin = runtime.workerMessages.find(
    ({ message }) => message.action === 'collector.auth.begin',
  )?.message;
  assert.equal(begin?.accountIdHint, 'account-a');
  assert.equal(runtime.popupDocument.getElementById('login-tip').textContent, '采集会话已连接');
  assert.equal(
    runtime.workerMessages.filter(({ message }) => message.action === 'collector.auth.exchange').length,
    0,
  );
});

test('first real authentication emits exactly one accepted, ticket, and exchange', async (t) => {
  const runtime = createBrowserHarness();
  t.after(() => runtime.unloadPopup());
  let ticketRequests = 0;
  const removeBridge = await runtime.installWebBridge({
    requestTicket: async () => {
      ticketRequests += 1;
      return {
        ticket: 'ctt_acceptance_first_123456789',
        expiresAt: '2030-01-01T00:01:00.000Z',
      };
    },
  });
  t.after(removeBridge);
  await flush();
  await runtime.requestCollectorAuth();
  await flush(600);

  assert.equal(ticketRequests, 1);
  assert.equal(
    runtime.workerMessages.filter(({ message }) => message.action === 'collector.auth.accepted').length,
    1,
  );
  assert.equal(
    runtime.workerMessages.filter(({ message }) => message.action === 'collector.auth.exchange').length,
    1,
  );
  assert.equal(runtime.exchangeCalls.length, 1);
  assert.equal((await runtime.status()).phase, 'AUTHENTICATED');
});

test('two tabs cannot issue tickets for one worker attempt', async (t) => {
  const runtime = createBrowserHarness();
  t.after(() => runtime.unloadPopup());
  let ticketRequests = 0;
  const removeBridge = await runtime.installWebBridge({
    requestTicket: async () => {
      ticketRequests += 1;
      return {
        ticket: 'ctt_acceptance_selected_tab_123456789',
        expiresAt: '2030-01-01T00:01:00.000Z',
      };
    },
  });
  t.after(removeBridge);
  await flush();
  await runtime.requestCollectorAuth();
  await flush(600);

  const requestId = runtime.tabMessages[0]?.requestId;
  const secondTabSender = {
    url: trustedWebSender.url,
    tab: { id: 18, url: trustedWebSender.url },
  };
  await runtime.sendWorker({
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId,
    generationId: GENERATION,
    ticket: 'ctt_acceptance_unselected_tab_123456789',
    expiresAt: '2030-01-01T00:01:00.000Z',
  }, secondTabSender);

  assert.equal(ticketRequests, 1);
  assert.equal(runtime.exchangeCalls.length, 1);
});

test('accepted response timeout retries through the coordinator after 31 seconds plus backoff', async (t) => {
  const runtime = createBrowserHarness();
  t.after(() => runtime.unloadPopup());
  const tickets = [deferred(), deferred()];
  let ticketRequests = 0;
  const removeBridge = await runtime.installWebBridge({
    requestTicket: () => tickets[ticketRequests++].promise,
  });
  t.after(removeBridge);
  await flush();
  await runtime.requestCollectorAuth();
  await flush();

  assert.equal(ticketRequests, 1);
  assert.equal(
    runtime.workerMessages.filter(({ message }) => message.action === 'collector.auth.accepted').length,
    1,
  );
  assert.equal((await runtime.status()).phase, 'REQUESTING_TICKET');

  await runtime.clock.advance(30_999);
  assert.equal(ticketRequests, 1);
  await runtime.clock.advance(1);
  assert.equal(ticketRequests, 1, 'response timeout first enters the bounded retry state');
  await runtime.clock.advance(1_000);
  assert.equal(ticketRequests, 2, 'the coordinator alone starts the next worker attempt');
  assert.equal(
    runtime.workerMessages.filter(({ message }) => message.action === 'collector.auth.accepted').length,
    2,
  );

  tickets[1].resolve({
    ticket: 'ctt_acceptance_second_123456789',
    expiresAt: '2030-01-01T00:01:00.000Z',
  });
  await flush(600);
  assert.equal(runtime.exchangeCalls.length, 1);
  assert.equal((await runtime.status()).phase, 'AUTHENTICATED');
});

test('real transient failure projects RETRY_WAIT and the coordinator resumes through sync-auth once', async (t) => {
  const transient = Object.assign(new Error('network detail must remain private'), {
    code: 'ECONNRESET',
  });
  const runtime = createBrowserHarness({ exchangeResponses: [transient, {}] });
  t.after(() => runtime.unloadPopup());
  let ticketRequests = 0;
  const removeBridge = await runtime.installWebBridge({
    requestTicket: async () => ({
      ticket: `ctt_acceptance_retry_${++ticketRequests}_123456789`,
      expiresAt: '2030-01-01T00:01:00.000Z',
    }),
  });
  t.after(removeBridge);
  await flush();
  await runtime.requestCollectorAuth();
  await flush(600);

  const retry = await runtime.status();
  assert.equal(retry.phase, 'RETRY_WAIT');
  assert.equal(retry.publicCode, 'LOCAL_SERVICE_UNAVAILABLE');
  assert.equal(retry.nextRetryAt, '2030-01-01T00:00:01.000Z');
  assert.equal(runtime.exchangeCalls.length, 1);

  await runtime.clock.advance(1_000);
  await flush(600);
  assert.equal(runtime.tabMessages.length, 2, 'one coordinator resume follows the initial worker selection');
  assert.equal(ticketRequests, 2);
  assert.equal(runtime.exchangeCalls.length, 2);
  assert.equal((await runtime.status()).phase, 'AUTHENTICATED');
});

test('real popup runtime consumes every credential-free privileged status through onChanged', async (t) => {
  const actionRuntime = createBrowserHarness({ exchangeResponses: [{
    status: 403,
    body: { code: 'COLLECTOR_PERMISSION_DENIED', message: 'private permission detail' },
  }] });
  t.after(() => actionRuntime.unloadPopup());
  const removeActionBridge = await actionRuntime.installWebBridge({
    requestTicket: async () => ({
      ticket: 'ctt_acceptance_action_123456789',
      expiresAt: '2030-01-01T00:01:00.000Z',
    }),
  });
  t.after(removeActionBridge);
  await flush();
  await actionRuntime.requestCollectorAuth();
  await flush(600);
  assert.equal((await actionRuntime.status()).phase, 'ACTION_REQUIRED');

  const transient = Object.assign(new Error('transport secret'), { code: 'ECONNRESET' });
  const progressRuntime = createBrowserHarness({ exchangeResponses: [transient, {}] });
  t.after(() => progressRuntime.unloadPopup());
  await flush();
  const waitingSnapshot = progressRuntime.popupResponses.find(
    ({ action }) => action === 'getCollectorAuthStatus',
  )?.response?.data;
  safeStatus(waitingSnapshot);
  assert.equal(waitingSnapshot.phase, 'WAITING_FOR_WEB');
  assert.equal(progressRuntime.popupDocument.getElementById('login-tip').textContent,
    '等待 Web 端登录');
  const removeProgressBridge = await progressRuntime.installWebBridge({
    requestTicket: async () => ({
      ticket: `ctt_acceptance_progress_${progressRuntime.exchangeCalls.length + 1}_123456789`,
      expiresAt: '2030-01-01T00:01:00.000Z',
    }),
  });
  t.after(removeProgressBridge);
  await flush();
  await progressRuntime.requestCollectorAuth();
  await flush(600);
  await progressRuntime.clock.advance(1_000);
  await flush(600);

  const observations = [
    { status: waitingSnapshot, tip: '等待 Web 端登录' },
    ...progressRuntime.popupObservations,
    ...actionRuntime.popupObservations,
  ];
  const phases = new Set();
  for (const observation of observations) {
    safeStatus(observation.status);
    phases.add(observation.status.phase);
    assert.doesNotMatch(
      observation.tip,
      /ctt_|cst_|collectorToken|authorization|bearer|fingerprint|private|secret/i,
    );
  }
  assert.deepEqual(phases, new Set([
    'WAITING_FOR_WEB',
    'DISCOVERING_WEB',
    'REQUESTING_TICKET',
    'EXCHANGING',
    'RETRY_WAIT',
    'AUTHENTICATED',
    'ACTION_REQUIRED',
  ]), JSON.stringify(observations));
  assert.ok(progressRuntime.popupMessages.some(({ action }) => action === 'getCollectorAuthStatus'));
  assert.equal(progressRuntime.popupDocument.getElementById('login-tip').textContent, '采集会话已连接');
  assert.equal(actionRuntime.popupDocument.getElementById('login-tip').textContent,
    '当前账号无采集权限，请联系管理员');
});

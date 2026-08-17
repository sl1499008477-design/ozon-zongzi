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

function createFakeClock(start = Date.parse('2030-01-01T00:00:00.000Z')) {
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
      milliseconds: delay,
    };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (timer) => { if (timer) timer.cancelled = true; };
  const advance = async (milliseconds) => {
    const target = current + milliseconds;
    while (true) {
      const next = timers
        .filter((timer) => !timer.cancelled && timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) break;
      next.cancelled = true;
      current = next.dueAt;
      await next.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    current = target;
    await Promise.resolve();
    await Promise.resolve();
  };
  return { Date: FixtureDate, advance, clearTimer, setTimer, timers };
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

function loadServiceWorker({
  activationResult,
  clock,
  clearResult,
  exchangeError = null,
  exchangeResult = null,
  initialSession = {},
  statusFailure = null,
  tabs = [],
  tabGet,
  tabMessage,
} = {}) {
  const workerPath = path.join(extensionRoot, manifest.background.service_worker);
  const runtimeOnMessage = createEvent();
  const alarmsOnAlarm = createEvent();
  const contextMenusOnClicked = createEvent();
  const notificationsOnClicked = createEvent();
  const runtimeOnInstalled = createEvent();
  const runtimeOnStartup = createEvent();
  const tabsOnCreated = createEvent();
  const tabsOnRemoved = createEvent();
  const tabsOnUpdated = createEvent();
  const activationCalls = [];
  const exchangeCalls = [];
  const alarmCreates = [];
  const alarmClears = [];
  const tabMessages = [];
  const tabQueries = [];
  const tabGets = [];
  const importedEntries = [];
  const scriptExecutions = [];
  const scheduledTimeouts = [];
  const local = createStorageArea();
  const session = createStorageArea(initialSession);
  const sessionGet = session.get.bind(session);
  const sessionSet = session.set.bind(session);
  session.get = (keys, callback) => {
    const requestedKeys = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : []);
    if (statusFailure?.get === true && requestedKeys.includes('sonliCollectorAuthStatus')) {
      const failure = Promise.reject(new Error('status projection read failed'));
      if (callback) { void failure.catch(() => {}); return undefined; }
      return failure;
    }
    return sessionGet(keys, callback);
  };
  session.set = (values, callback) => {
    const status = values?.sonliCollectorAuthStatus;
    if (status && statusFailure?.setPhase === status.phase) {
      const failure = Promise.reject(new Error('status projection write failed'));
      if (callback) { void failure.catch(() => {}); return undefined; }
      return failure;
    }
    return sessionSet(values, callback);
  };
  const sync = createStorageArea();
  let context;
  const chrome = {
    action: {
      openPopup: async () => {},
      setBadgeBackgroundColor() {},
      setBadgeText() {},
    },
    alarms: {
      clear: async (name) => { alarmClears.push(name); return true; },
      create(name, options) { alarmCreates.push({ name, options: { ...options } }); },
      onAlarm: alarmsOnAlarm,
    },
    contextMenus: {
      removeAll(callback) { callback?.(); }, create() {}, onClicked: contextMenusOnClicked,
    },
    cookies: { getAll: async () => [] },
    notifications: { create() {}, clear() {}, onClicked: notificationsOnClicked },
    runtime: {
      id: 'service-worker-collector-auth-test',
      getManifest: () => manifest,
      getPlatformInfo(callback) { callback?.({}); },
      getURL: (entry) => `chrome-extension://service-worker-collector-auth-test/${entry}`,
      lastError: null,
      onInstalled: runtimeOnInstalled,
      onMessage: runtimeOnMessage,
      onStartup: runtimeOnStartup,
      sendMessage: async () => null,
    },
    scripting: {
      executeScript: async (input) => {
        scriptExecutions.push(JSON.parse(JSON.stringify(input)));
        return [];
      },
    },
    storage: { local, session, sync },
    tabs: {
      create: async () => ({ id: 1 }),
      get: async (tabId) => {
        tabGets.push(tabId);
        return tabGet
          ? tabGet(tabId)
          : { id: tabId, url: 'https://seller.ozon.ru/app' };
      },
      onCreated: tabsOnCreated,
      onRemoved: tabsOnRemoved,
      onUpdated: tabsOnUpdated,
      query: async (query) => {
        tabQueries.push(JSON.parse(JSON.stringify(query || {})));
        return tabs;
      },
      reload() {},
      remove: async () => {},
      sendMessage: async (tabId, message) => {
        tabMessages.push({ tabId, message: JSON.parse(JSON.stringify(message)) });
        return tabMessage
          ? tabMessage(tabId, message)
          : { ok: true, requested: true, requestId: message.requestId };
      },
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
    clearTimeout: clock?.clearTimer || ((timer) => { if (timer) timer.cancelled = true; }),
    console: { error() {}, info() {}, log() {}, warn() {} },
    crypto: webcrypto,
    Date: clock?.Date || Date,
    fetch: async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    globalThis: null,
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    navigator: {
      hardwareConcurrency: 8,
      language: 'en-US',
      platform: 'test',
      userAgent: 'service-worker-collector-auth-test',
    },
    setInterval() { return 1; },
    setTimeout(callback, milliseconds) {
      const timer = clock
        ? clock.setTimer(callback, milliseconds)
        : { callback, milliseconds, cancelled: false };
      scheduledTimeouts.push(timer);
      return timer;
    },
  });
  context.globalThis = context;
  context.self = context;
  context.importScripts = (...entries) => {
    for (const entry of entries) {
      importedEntries.push(entry);
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
              async exchangeCollectorTicket(input) {
                exchangeCalls.push(JSON.parse(JSON.stringify(input)));
                if (exchangeError) throw exchangeError;
                if (exchangeResult) return exchangeResult;
                return manager.exchangeCollectorTicket(input);
              },
              async clearCollectorGeneration(generationId) {
                if (clearResult !== undefined) return clearResult;
                return manager.clearCollectorGeneration(generationId);
              },
            });
          },
        });
      }
    }
  };
  vm.runInContext(fs.readFileSync(workerPath, 'utf8'), context, { filename: workerPath });
  assert.equal(runtimeOnMessage.listeners.length, 1);
  return {
    activationCalls,
    alarmClears,
    alarmCreates,
    alarmsOnAlarm,
    exchangeCalls,
    importedEntries,
    runtimeOnMessage,
    runtimeOnStartup,
    session,
    scheduledTimeouts,
    scriptExecutions,
    tabMessages,
    tabGets,
    tabQueries,
    availableTabs: tabs,
  };
}

let collectorAttemptSequence = 0;
async function sendCollectorBegin(harness, accountIdHint = 'account-a') {
  if (!harness.availableTabs.some(({ id }) => id === trustedSender.tab.id)) {
    harness.availableTabs.push({
      id: trustedSender.tab.id,
      active: true,
      lastAccessed: 10,
      url: trustedSender.url,
    });
  }
  collectorAttemptSequence += 1;
  await sendRuntime(harness, { action: 'retryCollectorAuth' });
  harness.activeTestRequestId = harness.tabMessages.at(-1).message.requestId;
  return sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    requestId: harness.activeTestRequestId,
    generationId: 'generation_A_1234',
    accountIdHint,
  }, trustedSender);
}

const extensionSender = {
  id: 'service-worker-collector-auth-test',
  url: 'chrome-extension://service-worker-collector-auth-test/popup/popup.html',
};

async function sendRuntime(harness, message, sender = extensionSender) {
  return new Promise((resolve) => {
    harness.runtimeOnMessage.listeners[0](message, sender, resolve);
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await Promise.resolve();
  }
  assert.fail('condition was not reached');
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

test('service worker imports the coordinator before session code and exposes only a privileged closed status', async () => {
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    tabs: [{ id: 99, active: true, lastAccessed: 10 }],
  });
  assert.ok(
    harness.importedEntries.indexOf('../lib/collector-auth-coordinator.js')
      < harness.importedEntries.indexOf('../lib/collector-session.js'),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.tabMessages.length, 0, 'cold boot with no pending status stays idle');

  const response = await sendRuntime(harness, { action: 'getCollectorAuthStatus' });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: {
      version: 1,
      phase: 'WAITING_FOR_WEB',
      generationId: '',
      startedAt: '',
      updatedAt: '',
      attemptNumber: 0,
      nextRetryAt: '',
      publicCode: '',
      account: null,
      expiresAt: '',
    },
  });
  assert.equal(JSON.stringify(response).includes('sonliCollectorSession'), false);

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await sendRuntime(harness, { action: 'getCollectorAuthStatus' }, trustedSender),
    )),
    { ok: false },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await sendRuntime(harness, { action: 'getCollectorAuthStatus', token: 'never' }),
    )),
    { ok: false },
  );
  for (const sender of [
    { id: 'service-worker-collector-auth-test' },
    { id: 'service-worker-collector-auth-test', url: 'not a URL' },
    {
      id: 'service-worker-collector-auth-test',
      url: 'chrome-extension://different-extension/popup.html',
    },
  ]) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(
        await sendRuntime(harness, { action: 'getCollectorAuthStatus' }, sender),
      )),
      { ok: false },
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(
        await sendRuntime(harness, { action: 'retryCollectorAuth' }, sender),
      )),
      { ok: false },
    );
  }
});

test('one retry selects only one trusted Web tab', async () => {
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    tabs: [
      { id: 10, active: true, lastAccessed: 200 },
      { id: 11, active: false, lastAccessed: 100 },
    ],
  });

  await sendRuntime(harness, { action: 'retryCollectorAuth' });

  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10]);
  assert.deepEqual(harness.scriptExecutions, []);
  assert.equal(harness.tabMessages[0].message.action, 'collector.auth.request');
  assert.match(harness.tabMessages[0].message.requestId, /^collector-/);
});

test('worker attempt rejects a mismatched sender tab or request ID before activation', async () => {
  const harness = loadServiceWorker({
    activationResult: { changed: true, reused: false, authenticated: false },
    tabs: [{ id: 17, active: true, lastAccessed: 10 }],
  });
  await sendRuntime(harness, { action: 'retryCollectorAuth' });
  const selectedRequestId = harness.tabMessages.at(-1).message.requestId;
  const begin = (requestId, sender) => sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    requestId,
    generationId: 'generation_A_1234',
    accountIdHint: 'account-a',
  }, sender);

  const before = {
    status: JSON.parse(JSON.stringify(
      (await sendRuntime(harness, { action: 'getCollectorAuthStatus' })).data,
    )),
    timers: harness.scheduledTimeouts
      .filter(({ milliseconds }) => [2_500, 31_000].includes(milliseconds))
      .map(({ milliseconds, cancelled }) => ({ milliseconds, cancelled })),
    session: JSON.parse(JSON.stringify(harness.session.state)),
  };

  assert.equal((await begin(selectedRequestId, {
    ...trustedSender,
    tab: { ...trustedSender.tab, id: 18 },
  })).ok, false);
  for (const invalidRequestId of [undefined, 'not canonical!', 'collector-other-attempt']) {
    const response = await begin(invalidRequestId, trustedSender);
    assert.deepEqual(JSON.parse(JSON.stringify(response)), {
      ok: false,
      error: 'PORTAL_BRIDGE_FORBIDDEN',
    });
  }
  assert.equal(harness.activationCalls.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(
    (await sendRuntime(harness, { action: 'getCollectorAuthStatus' })).data,
  )), before.status);
  assert.deepEqual(
    harness.scheduledTimeouts
      .filter(({ milliseconds }) => [2_500, 31_000].includes(milliseconds))
      .map(({ milliseconds, cancelled }) => ({ milliseconds, cancelled })),
    before.timers,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(harness.session.state)), before.session);

  assert.equal((await begin(selectedRequestId, trustedSender)).ok, true);
  assert.equal(harness.activationCalls.length, 1);
});

test('an ambiguous connection error from the first trusted tab fails closed', async () => {
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    tabs: [
      { id: 10, active: true, lastAccessed: 200 },
      { id: 11, active: false, lastAccessed: 100 },
    ],
    tabMessage: async (tabId, message) => {
      if (tabId === 10) throw new Error('Could not establish connection');
      return { ok: true, requested: true, requestId: message.requestId };
    },
  });

  const response = await sendRuntime(harness, { action: 'requestCollectorAuth' });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 0 },
  });
  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10]);
  assert.deepEqual(harness.scriptExecutions, []);
});

test('only the exact no-receiver error can recover or fall through', async (t) => {
  for (const errorMessage of [
    'The message port closed before a response was received.',
    'could not establish connection. receiving end does not exist.',
    'Could not establish connection. Receiving end does not exist. Retry later.',
    'Receiving end does not exist.',
  ]) {
    await t.test(errorMessage, async () => {
      const harness = loadServiceWorker({
        activationResult: { changed: false },
        tabs: [
          { id: 10, url: 'http://127.0.0.1:3000/login', active: true, lastAccessed: 200 },
          { id: 11, url: 'http://127.0.0.1:3000/login', active: false, lastAccessed: 100 },
        ],
        tabGet: async (tabId) => ({
          id: tabId,
          url: 'http://127.0.0.1:3000/login',
        }),
        tabMessage: async () => {
          throw new Error(errorMessage);
        },
      });

      const response = await sendRuntime(harness, { action: 'requestCollectorAuth' });

      assert.deepEqual(JSON.parse(JSON.stringify(response)), {
        ok: true,
        data: { requested: 0 },
      });
      assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10]);
      assert.deepEqual(harness.tabGets, []);
      assert.deepEqual(harness.scriptExecutions, []);
    });
  }
});

test('a negative response from the first trusted tab fails closed without trying another tab', async () => {
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    tabs: [
      { id: 10, active: true, lastAccessed: 200 },
      { id: 11, active: false, lastAccessed: 100 },
    ],
    tabMessage: async (_tabId, message) => ({
      ok: false,
      requested: true,
      requestId: message.requestId,
    }),
  });

  const response = await sendRuntime(harness, { action: 'requestCollectorAuth' });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 0 },
  });
  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10]);
  assert.deepEqual(harness.scriptExecutions, []);
});

test('a declined response from the first trusted tab fails closed without trying another tab', async () => {
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    tabs: [
      { id: 10, active: true, lastAccessed: 200 },
      { id: 11, active: false, lastAccessed: 100 },
    ],
    tabMessage: async (_tabId, message) => ({
      ok: true,
      requested: false,
      requestId: message.requestId,
    }),
  });

  const response = await sendRuntime(harness, { action: 'requestCollectorAuth' });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 0 },
  });
  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10]);
  assert.deepEqual(harness.scriptExecutions, []);
});

test('a mismatched response ID from the first trusted tab fails closed without trying another tab', async () => {
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    tabs: [
      { id: 10, active: true, lastAccessed: 200 },
      { id: 11, active: false, lastAccessed: 100 },
    ],
    tabMessage: async () => ({
      ok: true,
      requested: true,
      requestId: 'collector-different-attempt',
    }),
  });

  const response = await sendRuntime(harness, { action: 'requestCollectorAuth' });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 0 },
  });
  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10]);
  assert.deepEqual(harness.scriptExecutions, []);
});

test('a non-connection error from the first trusted tab fails closed without trying another tab', async () => {
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    tabs: [
      { id: 10, active: true, lastAccessed: 200 },
      { id: 11, active: false, lastAccessed: 100 },
    ],
    tabMessage: async () => {
      throw new Error('Tab access denied');
    },
  });

  const response = await sendRuntime(harness, { action: 'requestCollectorAuth' });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 0 },
  });
  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10]);
  assert.deepEqual(harness.scriptExecutions, []);
});

test('caller-supplied collector auth request IDs cannot bypass coordinator ownership', async (t) => {
  for (const requestId of [
    '',
    'request-without-prefix',
    'collector-invalid_character',
    `collector-${'a'.repeat(119)}`,
  ]) {
    await t.test(JSON.stringify(requestId), async () => {
      const harness = loadServiceWorker({
        activationResult: { changed: false },
        tabs: [{ id: 10, active: true, lastAccessed: 200 }],
      });
      const queriesBefore = harness.tabQueries.length;

      const response = await sendRuntime(harness, {
        action: 'requestCollectorAuth',
        requestId,
      });

      assert.deepEqual(JSON.parse(JSON.stringify(response)), {
        ok: true,
        data: { requested: 0 },
      });
      assert.equal(harness.tabQueries.length, queriesBefore);
      assert.deepEqual(harness.tabMessages, []);
    });
  }

  await t.test('canonical explicit ID is also rejected before discovery', async () => {
    const harness = loadServiceWorker({
      activationResult: { changed: false },
      tabs: [{ id: 10, active: true, lastAccessed: 200 }],
    });
    const queriesBefore = harness.tabQueries.length;

    const response = await sendRuntime(harness, {
      action: 'requestCollectorAuth',
      requestId: 'collector-explicit-attempt-1',
    });

    assert.deepEqual(JSON.parse(JSON.stringify(response)), {
      ok: true,
      data: { requested: 0 },
    });
    assert.equal(harness.tabQueries.length, queriesBefore);
    assert.deepEqual(harness.tabMessages, []);
  });
});

test('manual collector auth retry publishes WEB_TAB_UNAVAILABLE when no trusted Web tab exists', async () => {
  const unavailable = loadServiceWorker({ activationResult: { changed: false } });
  const unavailableResponse = await sendRuntime(unavailable, { action: 'retryCollectorAuth' });
  assert.deepEqual(JSON.parse(JSON.stringify(unavailableResponse.data)), {
    requested: 0,
  });
  const unavailableStatus = await sendRuntime(unavailable, { action: 'getCollectorAuthStatus' });
  assert.equal(unavailableStatus.data.phase, 'WAITING_FOR_WEB');
  assert.equal(unavailableStatus.data.publicCode, 'WEB_TAB_UNAVAILABLE');

  const available = loadServiceWorker({
    activationResult: { changed: false },
    tabs: [{ id: 9, active: true, lastAccessed: 10 }],
  });
  const availableResponse = await sendRuntime(available, { action: 'retryCollectorAuth' });
  assert.deepEqual(JSON.parse(JSON.stringify(availableResponse.data)), { requested: 1 });
  assert.deepEqual(available.tabMessages, [{
    tabId: 9,
    message: {
      action: 'collector.auth.request',
      requestId: available.tabMessages[0].message.requestId,
    },
  }]);
  assert.match(available.tabMessages[0].message.requestId, /^collector-/);
  const availableStatus = await sendRuntime(available, { action: 'getCollectorAuthStatus' });
  assert.equal(availableStatus.data.phase, 'DISCOVERING_WEB');
});

test('trusted normalized accepted and existing begin/exchange routes update status without exposing credentials', async () => {
  const harness = loadServiceWorker({
    activationResult: { changed: true, reused: false, authenticated: false },
    clearResult: true,
    exchangeResult: {
      collectorToken: 'cst_service_worker_only_123456789',
      account: { id: 'account-a', displayName: 'Account A', token: 'never' },
      permissions: ['collector.upload'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  });

  await sendCollectorBegin(harness);
  let status = await sendRuntime(harness, { action: 'getCollectorAuthStatus' });
  assert.equal(status.data.phase, 'REQUESTING_TICKET');

  const acceptedResponse = await sendRuntime(harness, {
    protocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.accepted',
    requestId: harness.activeTestRequestId,
    generationId: 'generation_A_1234',
  }, trustedSender);
  assert.deepEqual(JSON.parse(JSON.stringify(acceptedResponse)), { ok: true });

  assert.deepEqual(JSON.parse(JSON.stringify(await sendRuntime(harness, {
      protocol: 'SONLI_COLLECTOR_AUTH',
      action: 'collector.auth.accepted',
      requestId: harness.activeTestRequestId,
      generationId: 'generation_A_1234',
      token: 'never',
    }, trustedSender))), { ok: false, error: 'PORTAL_BRIDGE_FORBIDDEN' });

  const exchange = await sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: harness.activeTestRequestId,
    generationId: 'generation_A_1234',
    ticket: 'ctt_exchange_only_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedSender);
  assert.equal(exchange.ok, true);
  status = await sendRuntime(harness, { action: 'getCollectorAuthStatus' });
  assert.deepEqual(JSON.parse(JSON.stringify(status.data.account)), {
    id: 'account-a', displayName: 'Account A',
  });
  assert.equal(status.data.phase, 'AUTHENTICATED');
  assert.equal(status.data.expiresAt, '2099-01-01T00:00:00.000Z');
  assert.equal(JSON.stringify(status).includes('ctt_exchange_only'), false);
  assert.equal(JSON.stringify(status).includes('cst_service_worker_only'), false);

  const logout = await sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.logout',
    generationId: 'generation_A_1234',
  }, trustedSender);
  assert.deepEqual(JSON.parse(JSON.stringify(logout)), { ok: true, data: { cleared: true } });
  status = await sendRuntime(harness, { action: 'getCollectorAuthStatus' });
  assert.equal(status.data.phase, 'WAITING_FOR_WEB');
  assert.equal(status.data.publicCode, 'WEB_LOGIN_REQUIRED');

  await sendCollectorBegin(harness);
  await sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: harness.activeTestRequestId,
    generationId: 'generation_A_1234',
    ticket: 'ctt_exchange_only_second_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedSender);
  assert.equal((await sendRuntime(
    harness, { action: 'getCollectorAuthStatus' },
  )).data.phase, 'AUTHENTICATED');
  await sendRuntime(harness, { action: 'logout' });
  status = await sendRuntime(harness, { action: 'getCollectorAuthStatus' });
  assert.equal(status.data.phase, 'WAITING_FOR_WEB');
  assert.equal(status.data.publicCode, 'WEB_LOGIN_REQUIRED');
});

test('closed Web failure reaches coordinator and exchange outer budget survives the 50-60 second window', async () => {
  let resolveExchange;
  const exchangeResult = new Promise((resolve) => { resolveExchange = resolve; });
  const harness = loadServiceWorker({
    activationResult: { changed: true, reused: false, authenticated: false },
    exchangeResult,
  });
  await sendCollectorBegin(harness);
  const failure = await sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.failure',
    requestId: harness.activeTestRequestId,
    generationId: 'generation_A_1234',
    publicCode: 'WEB_LOGIN_REQUIRED',
  }, trustedSender);
  assert.deepEqual(JSON.parse(JSON.stringify(failure)), { ok: true });
  assert.equal((await sendRuntime(harness, { action: 'getCollectorAuthStatus' })).data.publicCode, 'WEB_LOGIN_REQUIRED');

  await sendCollectorBegin(harness);
  const timeoutCountBeforeExchange = harness.scheduledTimeouts.length;
  const pending = sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: harness.activeTestRequestId,
    generationId: 'generation_A_1234',
    ticket: 'ctt_budget_only_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedSender);
  await waitFor(() => harness.exchangeCalls.length === 1);
  const exchangeTimeouts = harness.scheduledTimeouts.slice(timeoutCountBeforeExchange);
  const outerBudget = exchangeTimeouts.find(({ milliseconds }) => milliseconds >= 60_000);
  assert.ok(outerBudget && outerBudget.milliseconds > 60_000);
  assert.equal(exchangeTimeouts.some(({ milliseconds }) => milliseconds === 50_000), false);
  resolveExchange({
    collectorToken: 'cst_budget_only_123456789',
    account: { id: 'account-a', displayName: 'Account A' },
    permissions: ['collector.upload'],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  assert.equal((await pending).ok, true);
});

test('stale generation failure keeps the current generation on the selected worker attempt', async () => {
  const harness = loadServiceWorker({
    activationResult: { changed: true, reused: false, authenticated: false },
    exchangeResult: {
      account: { id: 'account-current', displayName: 'Current' },
      permissions: ['collector.upload'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  });
  await sendCollectorBegin(harness);
  const requestId = harness.activeTestRequestId;
  await sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    requestId,
    generationId: 'generation_B_5678',
  }, trustedSender);

  await sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.failure',
    requestId,
    generationId: 'generation_A_1234',
    publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
  }, trustedSender);

  const exchange = await sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId,
    generationId: 'generation_B_5678',
    ticket: 'ctt_current_generation_only_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedSender);
  assert.equal(exchange.ok, true);
});

test('expired worker attempt rejects its late begin before activation and rotates tabs', async () => {
  const clock = createFakeClock();
  const harness = loadServiceWorker({
    activationResult: { changed: true, reused: false, authenticated: false },
    clock,
    tabs: [
      { id: 10, active: true, lastAccessed: 20, url: trustedSender.url },
      { id: 11, active: false, lastAccessed: 10, url: trustedSender.url },
    ],
  });
  await sendRuntime(harness, { action: 'retryCollectorAuth' });
  const requestId = harness.tabMessages[0].message.requestId;
  const firstSender = {
    ...trustedSender,
    tab: { ...trustedSender.tab, id: 10 },
  };
  await sendRuntime(harness, {
    protocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.accepted',
    requestId,
    generationId: 'generation_A_1234',
  }, firstSender);

  await clock.advance(31_000);
  await waitFor(async () => (
    await sendRuntime(harness, { action: 'getCollectorAuthStatus' })
  ).data.phase === 'RETRY_WAIT');
  const activationCount = harness.activationCalls.length;

  const lateBegin = await sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    requestId,
    generationId: 'generation_A_1234',
  }, firstSender);
  assert.deepEqual(JSON.parse(JSON.stringify(lateBegin)), {
    ok: false,
    error: 'PORTAL_BRIDGE_FORBIDDEN',
  });
  assert.equal(harness.activationCalls.length, activationCount);

  const retryTimer = clock.timers.find(
    ({ cancelled, milliseconds }) => !cancelled && milliseconds >= 900 && milliseconds <= 1_100,
  );
  assert.equal(retryTimer?.milliseconds, 1_000);
  await clock.advance(1_000);
  await waitFor(() => harness.tabMessages.length === 2);
  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10, 11]);
});

test('selected-tab transport failure after begin fails the exact lease and schedules retry', async () => {
  const clock = createFakeClock();
  let harness;
  harness = loadServiceWorker({
    activationResult: { changed: true, reused: false, authenticated: false },
    clock,
    tabs: [{ id: 10, active: true, lastAccessed: 20, url: trustedSender.url }],
    tabMessage: async (tabId, message) => {
      const sender = { ...trustedSender, tab: { ...trustedSender.tab, id: tabId } };
      const begin = await sendRuntime(harness, {
        portalProtocol: 'SONLI_COLLECTOR_AUTH',
        action: 'collector.auth.begin',
        requestId: message.requestId,
        generationId: 'generation_transport_1234',
      }, sender);
      assert.equal(begin.ok, true);
      throw new Error('selected tab closed before acknowledgement');
    },
  });

  const response = await sendRuntime(harness, { action: 'retryCollectorAuth' });
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), { requested: 1 });
  assert.equal((await sendRuntime(
    harness, { action: 'getCollectorAuthStatus' },
  )).data.phase, 'REQUESTING_TICKET');

  await clock.advance(31_000);
  await waitFor(async () => (
    await sendRuntime(harness, { action: 'getCollectorAuthStatus' })
  ).data.phase === 'RETRY_WAIT');
  const status = await sendRuntime(harness, { action: 'getCollectorAuthStatus' });
  assert.equal(status.data.phase, 'RETRY_WAIT');
  assert.equal(status.data.publicCode, 'LOCAL_SERVICE_UNAVAILABLE');
  assert.ok(harness.alarmCreates.some(({ name }) => name === 'collectorAuthRetry'));

  const lateAccepted = await sendRuntime(harness, {
    protocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.accepted',
    requestId: harness.tabMessages[0].message.requestId,
    generationId: 'generation_transport_1234',
  }, { ...trustedSender, tab: { ...trustedSender.tab, id: 10 } });
  assert.deepEqual(JSON.parse(JSON.stringify(lateAccepted)), {
    ok: false,
    error: 'PORTAL_BRIDGE_FORBIDDEN',
  });
});

test('unresponsive first trusted tab times out once and the second tab succeeds', async () => {
  const clock = createFakeClock();
  const firstTab = new Promise(() => {});
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    clock,
    tabs: [
      { id: 10, active: true, lastAccessed: 20, url: trustedSender.url },
      { id: 11, active: false, lastAccessed: 10, url: trustedSender.url },
    ],
    tabMessage: async (tabId, message) => (
      tabId === 10
        ? firstTab
        : { ok: true, requested: true, requestId: message.requestId }
    ),
  });

  const pending = sendRuntime(harness, { action: 'retryCollectorAuth' });
  await waitFor(() => harness.tabMessages.length === 1);
  await clock.advance(2_500);
  await waitFor(() => harness.tabMessages.length === 2);

  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10, 11]);
  assert.deepEqual(JSON.parse(JSON.stringify((await pending).data)), { requested: 1 });
  const status = await sendRuntime(harness, { action: 'getCollectorAuthStatus' });
  assert.equal(status.data.phase, 'DISCOVERING_WEB');
});

test('hung transport after begin settles so the 31-second watchdog can retry the next tab', async () => {
  const clock = createFakeClock();
  let harness;
  harness = loadServiceWorker({
    activationResult: { changed: true, reused: false, authenticated: false },
    clock,
    tabs: [
      { id: 10, active: true, lastAccessed: 20, url: trustedSender.url },
      { id: 11, active: false, lastAccessed: 10, url: trustedSender.url },
    ],
    tabMessage: async (tabId, message) => {
      if (tabId === 11) {
        return { ok: true, requested: true, requestId: message.requestId };
      }
      const begin = await sendRuntime(harness, {
        portalProtocol: 'SONLI_COLLECTOR_AUTH',
        action: 'collector.auth.begin',
        requestId: message.requestId,
        generationId: 'generation_hung_begin_1234',
      }, { ...trustedSender, tab: { ...trustedSender.tab, id: tabId } });
      assert.equal(begin.ok, true);
      return new Promise(() => {});
    },
  });

  const first = sendRuntime(harness, { action: 'retryCollectorAuth' });
  await waitFor(() => harness.activationCalls.length === 1);
  await clock.advance(31_000);
  await waitFor(async () => (
    await sendRuntime(harness, { action: 'getCollectorAuthStatus' })
  ).data.phase === 'RETRY_WAIT');
  await clock.advance(1_000);
  await waitFor(() => harness.tabMessages.length === 2);

  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10, 11]);
  assert.deepEqual(JSON.parse(JSON.stringify((await first).data)), { requested: 1 });
});

test('accepted before tab acknowledgement is a successful transition, not a negative response', async () => {
  let resolveTabResponse;
  const tabResponse = new Promise((resolve) => { resolveTabResponse = resolve; });
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    tabs: [{ id: 10, active: true, lastAccessed: 20, url: trustedSender.url }],
    tabMessage: () => tabResponse,
  });

  const pending = sendRuntime(harness, { action: 'retryCollectorAuth' });
  await waitFor(() => harness.tabMessages.length === 1);
  const requestId = harness.tabMessages[0].message.requestId;
  const accepted = await sendRuntime(harness, {
    protocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.accepted',
    requestId,
    generationId: 'generation_accepted_first_1234',
  }, { ...trustedSender, tab: { ...trustedSender.tab, id: 10 } });
  assert.deepEqual(JSON.parse(JSON.stringify(accepted)), { ok: true });
  assert.deepEqual(JSON.parse(JSON.stringify((await pending).data)), { requested: 1 });
  assert.equal((await sendRuntime(
    harness, { action: 'getCollectorAuthStatus' },
  )).data.phase, 'REQUESTING_TICKET');

  resolveTabResponse({ ok: false, requested: false, requestId });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal((await sendRuntime(
    harness, { action: 'getCollectorAuthStatus' },
  )).data.phase, 'REQUESTING_TICKET');
});

test('two hung trusted tabs are each attempted once before terminal waiting', async () => {
  const clock = createFakeClock();
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    clock,
    tabs: [
      { id: 10, active: true, lastAccessed: 20, url: trustedSender.url },
      { id: 11, active: false, lastAccessed: 10, url: trustedSender.url },
    ],
    tabMessage: () => new Promise(() => {}),
  });

  const pending = sendRuntime(harness, { action: 'retryCollectorAuth' });
  await waitFor(() => harness.tabMessages.length === 1);
  await clock.advance(2_500);
  await waitFor(() => harness.tabMessages.length === 2);
  await clock.advance(2_500);

  assert.deepEqual(JSON.parse(JSON.stringify((await pending).data)), { requested: 0 });
  const status = await sendRuntime(harness, { action: 'getCollectorAuthStatus' });
  assert.equal(status.data.phase, 'WAITING_FOR_WEB');
  assert.equal(status.data.publicCode, 'WEB_TAB_UNAVAILABLE');
  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10, 11]);
  await clock.advance(60_000);
  assert.equal(harness.tabMessages.length, 2);
});

test('transient exchange failure schedules retry and duplicate alarm resumes are single-flight', async () => {
  let resolveTabMessage;
  const tabMessagePromise = new Promise((resolve) => { resolveTabMessage = resolve; });
  let tabRequestNumber = 0;
  const harness = loadServiceWorker({
    activationResult: { changed: true, reused: false, authenticated: false },
    exchangeError: Object.assign(new Error('secret transport detail'), {
      code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR',
      status: 0,
    }),
    tabs: [{ id: 17, active: true, lastAccessed: 10 }],
    tabMessage: (_tabId, message) => {
      tabRequestNumber += 1;
      return tabRequestNumber === 1
        ? { ok: true, requested: true, requestId: message.requestId }
        : tabMessagePromise;
    },
  });
  await sendCollectorBegin(harness);
  const failed = await sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: harness.activeTestRequestId,
    generationId: 'generation_A_1234',
    ticket: 'ctt_retry_only_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedSender);
  assert.equal(failed.ok, false);
  const retryStatus = await sendRuntime(harness, { action: 'getCollectorAuthStatus' });
  assert.equal(retryStatus.data.phase, 'RETRY_WAIT');
  assert.equal(retryStatus.data.publicCode, 'LOCAL_SERVICE_UNAVAILABLE');
  assert.ok(harness.alarmCreates.some(({ name }) => name === 'collectorAuthRetry'));
  Object.assign(harness.session.state.sonliCollectorAuthStatus, {
    startedAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    nextRetryAt: '2020-01-01T00:00:01.000Z',
  });

  for (const listener of harness.alarmsOnAlarm.listeners) {
    listener({ name: 'collectorAuthRetry' });
    listener({ name: 'collectorAuthRetry' });
  }
  await waitFor(() => harness.tabMessages.length === 1);
  assert.equal(harness.tabMessages.length, 1);
  resolveTabMessage({ ok: true, requested: true });
});

test('status projection storage failures cannot reverse successful exchange or block logout', async () => {
  const statusFailure = { get: false, setPhase: 'AUTHENTICATED' };
  const harness = loadServiceWorker({
    activationResult: { changed: true, reused: false, authenticated: false },
    exchangeResult: {
      collectorToken: 'cst_authoritative_session_123456789',
      account: { id: 'account-a', displayName: 'Account A' },
      permissions: ['collector.upload'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    statusFailure,
  });
  await sendCollectorBegin(harness);
  const exchanged = await sendRuntime(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: harness.activeTestRequestId,
    generationId: 'generation_A_1234',
    ticket: 'ctt_storage_failure_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedSender);
  assert.equal(exchanged.ok, true, 'installed session remains the authoritative exchange result');

  statusFailure.setPhase = '';
  statusFailure.get = true;
  const logout = await sendRuntime(harness, { action: 'logout' });
  assert.deepEqual(JSON.parse(JSON.stringify(logout)), { ok: true });
});

test('a projection read failure after Web acknowledgement cannot duplicate the tab request', async () => {
  const statusFailure = { get: false, setPhase: '' };
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    statusFailure,
    tabs: [{ id: 21, active: true, lastAccessed: 10 }],
    tabMessage: async (_tabId, message) => {
      statusFailure.get = true;
      return { ok: true, requested: true, requestId: message.requestId };
    },
  });
  const response = await sendRuntime(harness, { action: 'retryCollectorAuth' });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 1 },
  });
  assert.equal(harness.tabMessages.length, 1);
});

test('a projection failure after a negative Web acknowledgement cannot duplicate the tab request', async () => {
  const statusFailure = { get: false, setPhase: '' };
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    statusFailure,
    tabs: [{ id: 22, active: true, lastAccessed: 10 }],
    tabMessage: async () => {
      statusFailure.get = true;
      return { ok: true, requested: false };
    },
  });
  const response = await sendRuntime(harness, { action: 'retryCollectorAuth' });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { requested: 0 },
  });
  assert.equal(harness.tabMessages.length, 1);
});

test('cold evaluation resumes one due retry and overlapping startup events join it', async () => {
  let resolveTabMessage;
  const tabMessagePromise = new Promise((resolve) => { resolveTabMessage = resolve; });
  const harness = loadServiceWorker({
    activationResult: { changed: false },
    initialSession: {
      sonliCollectorAuthStatus: {
        version: 1,
        phase: 'RETRY_WAIT',
        generationId: 'generation_A_1234',
        startedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        attemptNumber: 1,
        nextRetryAt: '2020-01-01T00:00:01.000Z',
        publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
        account: null,
        expiresAt: '',
      },
    },
    tabs: [{ id: 8, active: true, lastAccessed: 10 }],
    tabMessage: () => tabMessagePromise,
  });
  assert.equal(harness.alarmsOnAlarm.listeners.length, 1);
  assert.equal(harness.runtimeOnStartup.listeners.length, 1);
  await waitFor(() => harness.tabMessages.length === 1);
  harness.runtimeOnStartup.listeners[0]();
  harness.runtimeOnStartup.listeners[0]();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.tabMessages.length, 1);
  resolveTabMessage({ ok: true, requested: true });
});

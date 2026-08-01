const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const policy = require('../lib/seller-identity-policy.js');
const recoveryTab = require('../lib/seller-recovery-tab.js');
const { installObserver } = require('../lib/seller-company-context.js');
const {
  CURRENT_STORAGE_KEY,
  createSellerCompanyContextRuntime,
} = require('../lib/seller-company-context-runtime.js');

const NOW = 1_800_000_000_000;

function createStorageArea(initial = {}) {
  const state = { ...initial };
  return {
    state,
    async get(keys) {
      if (keys == null) return { ...state };
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(selected
        .filter((key) => Object.hasOwn(state, key))
        .map((key) => [key, state[key]]));
    },
    async set(values) {
      Object.assign(state, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
  };
}

function requiredContext() {
  return Object.assign(new Error('SELLER_CONTEXT_REQUIRED'), {
    code: 'SELLER_CONTEXT_REQUIRED',
  });
}

test('trusted top-frame observations advance one global revision in arrival order', async () => {
  const session = createStorageArea();
  const clock = { now: NOW };
  const tabs = [
    { id: 7, url: 'https://seller.ozon.ru/app/products', active: true },
    { id: 8, url: 'https://seller.ozon.ru/app/settings', active: false },
  ];
  const runtime = createSellerCompanyContextRuntime({
    chromeApi: {
      cookies: { getAll: async () => [] },
      scripting: { executeScript: async () => [] },
      storage: { session },
      tabs: { query: async () => tabs },
    },
    now: () => clock.now,
    policy,
    recoveryTab,
    stabilizationWindowMs: 1_000,
  });

  for (const sender of [
    { tab: tabs[0] },
    { frameId: 1, tab: tabs[0] },
    { frameId: 0, tab: { id: 9, url: 'http://seller.ozon.ru/app' } },
    { frameId: 0, tab: { id: 10, url: 'https://seller.ozon.ru.evil.example/app' } },
    { frameId: 0, tab: { id: 11, url: 'https://seller.ozon.ru:444/app' } },
  ]) {
    await assert.rejects(
      () => runtime.rememberFromSender(sender, '2681910'),
      /SELLER_CONTEXT_REQUIRED/,
    );
  }
  assert.equal(session.state[CURRENT_STORAGE_KEY], undefined);

  const first = await runtime.rememberFromSender(
    { frameId: 0, tab: tabs[0] },
    '2681910',
  );
  assert.deepEqual(first, {
    companyId: '2681910', revision: 1, observedAt: NOW, sellerTabId: 7,
  });
  const oldSnapshot = await runtime.snapshotCurrent();

  clock.now += 100;
  const duplicate = await runtime.rememberFromSender(
    { frameId: 0, tab: tabs[1] },
    '2681910',
  );
  assert.equal(duplicate.revision, 1, 'same Company ID must not increment revision');
  assert.equal(duplicate.observedAt, NOW + 100);
  assert.equal(duplicate.sellerTabId, 8, 'latest trusted tab must become the current evidence');
  assert.equal(
    await runtime.isSnapshotCurrent(oldSnapshot),
    true,
    'refreshing the same Company ID must keep a frozen revision current',
  );

  clock.now += 100;
  const switched = await runtime.rememberFromSender(
    { frameId: 0, tab: tabs[0] },
    '7311458',
  );
  assert.equal(switched.revision, 2, 'a changed Company ID must increment revision');
  assert.deepEqual(session.state[CURRENT_STORAGE_KEY], {
    companyId: '7311458', observedAt: NOW + 200, revision: 2, tabId: 7,
  });
  assert.equal(await runtime.isSnapshotCurrent(oldSnapshot), false);

  const recovering = await runtime.resolveCurrentWithRecovery();
  assert.deepEqual(recovering, { status: 'RECOVERING' });
  assert.equal(Object.hasOwn(recovering, 'companyId'), false, 'flapping must not guess an ID');

  clock.now += 1_001;
  assert.deepEqual(await runtime.resolveCurrentWithRecovery(), {
    status: 'READY',
    companyId: '7311458',
    revision: 2,
    observedAt: NOW + 200,
    sellerTabId: 7,
  });
});

test('one tab switching Company IDs remains RECOVERING during stabilization', async () => {
  const session = createStorageArea();
  const clock = { now: NOW };
  const tab = { id: 7, url: 'https://seller.ozon.ru/app/products', active: true };
  const runtime = createSellerCompanyContextRuntime({
    chromeApi: {
      scripting: { executeScript: async () => [] },
      storage: { session },
      tabs: { query: async () => [tab] },
    },
    now: () => clock.now,
    policy,
    recoveryTab,
    stabilizationWindowMs: 1_000,
  });
  await runtime.rememberFromSender({ frameId: 0, tab }, '2681910');
  clock.now += 100;
  await runtime.rememberFromSender({ frameId: 0, tab }, '7311458');

  const recovering = await runtime.resolveCurrentWithRecovery();
  assert.deepEqual(recovering, { status: 'RECOVERING' });
  assert.equal(Object.hasOwn(recovering, 'companyId'), false);
});

test('Seller request hook advances runtime through A to B to A and stabilizes on latest A', async () => {
  const session = createStorageArea();
  const clock = { now: NOW };
  const tab = { id: 7, url: 'https://seller.ozon.ru/app/products', active: true };
  const runtime = createSellerCompanyContextRuntime({
    chromeApi: {
      scripting: { executeScript: async () => [] },
      storage: { session },
      tabs: { query: async () => [tab] },
    },
    now: () => clock.now,
    policy,
    recoveryTab,
    stabilizationWindowMs: 1_000,
  });
  const pageRoot = {
    fetch: async () => ({ ok: true }),
  };
  const writes = [];
  const uninstall = installObserver({
    root: pageRoot,
    onCompanyId(companyId) {
      writes.push(runtime.rememberFromSender({ frameId: 0, tab }, companyId));
    },
  });
  const observe = async (companyId) => {
    await pageRoot.fetch('/api/v1/search', {
      headers: { 'x-o3-company-id': companyId },
    });
    return writes.at(-1);
  };

  const firstSnapshot = await observe('2681910');
  clock.now += 100;
  const secondSnapshot = await observe('7311458');
  assert.equal(await runtime.isSnapshotCurrent(firstSnapshot), false);
  assert.deepEqual(await runtime.resolveCurrentWithRecovery(), { status: 'RECOVERING' });
  clock.now += 100;
  await observe('2681910');

  assert.deepEqual((await Promise.all(writes)).map((entry) => entry.revision), [1, 2, 3]);
  assert.deepEqual(session.state[CURRENT_STORAGE_KEY], {
    companyId: '2681910', observedAt: NOW + 200, revision: 3, tabId: 7,
  });
  assert.equal(await runtime.isSnapshotCurrent(secondSnapshot), false);
  assert.deepEqual(await runtime.resolveCurrentWithRecovery(), { status: 'RECOVERING' });

  clock.now += 1_001;
  assert.deepEqual(await runtime.resolveCurrentWithRecovery(), {
    status: 'READY',
    companyId: '2681910',
    revision: 3,
    observedAt: NOW + 200,
    sellerTabId: 7,
  });
  uninstall();
});

function createRecoveryHarness({ userTabs = [], onSleep, helperUrl, updateError, onUpdate } = {}) {
  const session = createStorageArea();
  const createdTabOptions = [];
  const removedTabs = [];
  const reloadedTabs = [];
  const focusedTabs = [];
  const bridgeQueries = [];
  const liveTabs = new Map(userTabs.map((tab) => [tab.id, { ...tab }]));
  let nextTabId = 70;
  let sleepCount = 0;
  let current = null;
  const chromeApi = {
    scripting: {
      async executeScript(input) {
        bridgeQueries.push(input);
        return [];
      },
    },
    storage: { session },
    tabs: {
      async create(options) {
        createdTabOptions.push({ ...options });
        const tab = {
          id: nextTabId++,
          url: helperUrl || options.url,
          active: options.active,
        };
        liveTabs.set(tab.id, tab);
        return tab;
      },
      async get(tabId) {
        const tab = liveTabs.get(tabId);
        if (!tab) throw new Error('No tab');
        return { ...tab };
      },
      async query() {
        return [...liveTabs.values()].map((tab) => ({ ...tab }));
      },
      async reload(tabId) {
        reloadedTabs.push(tabId);
      },
      async remove(tabId) {
        removedTabs.push(tabId);
        liveTabs.delete(tabId);
      },
      async update(tabId, options) {
        focusedTabs.push({ tabId, options: { ...options } });
        await onUpdate?.({ session, tabId, options });
        if (updateError) throw updateError;
        return { ...liveTabs.get(tabId), ...options };
      },
    },
  };
  const manager = recoveryTab.createSellerRecoveryTabManager({
    chromeApi,
    policy,
    readCurrent: async () => {
      if (!current) throw requiredContext();
      return current;
    },
    sleep: async (milliseconds) => {
      sleepCount += 1;
      await onSleep?.({
        liveTabs,
        setCurrent(value) { current = value; },
        sleepCount,
        milliseconds,
      });
    },
  });
  return {
    bridgeQueries,
    createdTabOptions,
    focusedTabs,
    manager,
    reloadedTabs,
    removedTabs,
    session,
    getSleepCount() { return sleepCount; },
    liveTabs,
    setCurrent(value) { current = value; },
  };
}

test('recovery queries existing Seller bridges without navigating user tabs', async () => {
  const userTab = { id: 7, url: 'https://seller.ozon.ru/app/products', active: true };
  const harness = createRecoveryHarness({
    userTabs: [userTab],
    onSleep({ setCurrent, sleepCount }) {
      if (sleepCount === 1) {
        setCurrent({
          companyId: '2681910', revision: 4, observedAt: NOW, sellerTabId: userTab.id,
        });
      }
    },
  });
  const result = await harness.manager.resolveCurrentWithRecovery({
    pollIntervalMs: 10,
    probeTimeoutMs: 20,
    timeoutMs: 40,
  });
  assert.equal(result.status, 'READY');
  assert.deepEqual(harness.createdTabOptions, []);
  assert.deepEqual(harness.reloadedTabs, []);
  assert.deepEqual(harness.removedTabs, []);
  assert.deepEqual(harness.bridgeQueries.map((call) => call.target.tabId), [7]);
});

test('recovery creates and closes only its session-tagged inactive helper', async () => {
  const userTab = { id: 7, url: 'https://seller.ozon.ru/app/products', active: true };
  let helperId = 0;
  const harness = createRecoveryHarness({
    userTabs: [userTab],
    onSleep({ liveTabs, setCurrent, sleepCount }) {
      if (sleepCount === 2) {
        helperId = [...liveTabs.keys()].find((tabId) => tabId !== userTab.id);
        setCurrent({
          companyId: '2681910', revision: 1, observedAt: NOW, sellerTabId: helperId,
        });
      }
    },
  });
  const result = await harness.manager.resolveCurrentWithRecovery({
    pollIntervalMs: 10,
    probeTimeoutMs: 10,
    timeoutMs: 40,
  });
  assert.equal(result.status, 'READY');
  assert.deepEqual(harness.createdTabOptions, [{
    url: 'https://seller.ozon.ru/app', active: false,
  }]);
  assert.deepEqual(harness.reloadedTabs, []);
  assert.deepEqual(harness.removedTabs, [helperId]);
  assert.equal(harness.removedTabs.includes(userTab.id), false);
});

test('login retains one helper and focuses that same tab', async () => {
  const harness = createRecoveryHarness({ helperUrl: 'https://seller.ozon.ru/signin' });
  const first = await harness.manager.resolveCurrentWithRecovery({
    pollIntervalMs: 10,
    probeTimeoutMs: 10,
    timeoutMs: 20,
  });
  assert.deepEqual(first, { status: 'LOGIN_REQUIRED', helperTabId: 70 });
  const sleepCountAfterFirst = harness.getSleepCount();
  const queryCountAfterFirst = harness.bridgeQueries.length;
  const second = await harness.manager.resolveCurrentWithRecovery({
    pollIntervalMs: 10,
    probeTimeoutMs: 10,
    timeoutMs: 20,
  });
  assert.deepEqual(second, first);
  assert.equal(harness.getSleepCount(), sleepCountAfterFirst, 'stable login must not poll again');
  assert.equal(harness.bridgeQueries.length, queryCountAfterFirst, 'stable login must not probe again');
  assert.equal(harness.createdTabOptions.length, 1);
  assert.deepEqual(harness.removedTabs, []);
  await harness.manager.focusLoginHelper();
  assert.deepEqual(harness.focusedTabs, [{ tabId: 70, options: { active: true } }]);
});

test('timeout reports LOGIN_REQUIRED and retains the same helper', async () => {
  const harness = createRecoveryHarness();
  const options = { pollIntervalMs: 10, probeTimeoutMs: 10, timeoutMs: 20 };
  const first = await harness.manager.resolveCurrentWithRecovery(options);
  const sleepCountAfterFirst = harness.getSleepCount();
  const queryCountAfterFirst = harness.bridgeQueries.length;
  const second = await harness.manager.resolveCurrentWithRecovery(options);
  assert.deepEqual(first, { status: 'LOGIN_REQUIRED', helperTabId: 70 });
  assert.deepEqual(second, first);
  assert.equal(harness.getSleepCount(), sleepCountAfterFirst, 'stable timeout must not poll again');
  assert.equal(harness.bridgeQueries.length, queryCountAfterFirst, 'stable timeout must not probe again');
  assert.deepEqual(harness.createdTabOptions, [{
    url: 'https://seller.ozon.ru/app', active: false,
  }]);
  assert.deepEqual(harness.removedTabs, []);
});

test('a stale helper focus failure clears its tag so the caller can open a fresh login tab', async () => {
  const harness = createRecoveryHarness({
    helperUrl: 'https://seller.ozon.ru/signin',
    updateError: new Error('tab closed'),
  });
  await harness.manager.resolveCurrentWithRecovery({ pollIntervalMs: 10, probeTimeoutMs: 10, timeoutMs: 20 });
  assert.equal(await harness.manager.focusLoginHelper(), false);
  assert.equal(harness.session.state[recoveryTab.HELPER_STORAGE_KEY], undefined);
});

test('a failed old-helper focus cannot delete a concurrently replaced helper tag', async () => {
  const harness = createRecoveryHarness({
    helperUrl: 'https://seller.ozon.ru/signin',
    updateError: new Error('tab closed'),
    onUpdate: async ({ session }) => {
      await session.set({ [recoveryTab.HELPER_STORAGE_KEY]: { tabId: 71, active: false } });
    },
  });
  await harness.manager.resolveCurrentWithRecovery({ pollIntervalMs: 10, probeTimeoutMs: 10, timeoutMs: 20 });
  assert.equal(await harness.manager.focusLoginHelper(), false);
  assert.deepEqual(harness.session.state[recoveryTab.HELPER_STORAGE_KEY], { tabId: 71, active: false });
});

test('a helper navigated outside Seller is never focused or closed as extension-owned', async () => {
  const harness = createRecoveryHarness();
  const first = await harness.manager.resolveCurrentWithRecovery({
    pollIntervalMs: 10,
    probeTimeoutMs: 10,
    timeoutMs: 20,
  });
  assert.deepEqual(first, { status: 'LOGIN_REQUIRED', helperTabId: 70 });

  harness.liveTabs.get(70).url = 'https://example.com/login';
  harness.setCurrent({
    companyId: '2681910', revision: 1, observedAt: NOW, sellerTabId: 7,
  });
  assert.equal((await harness.manager.resolveCurrentWithRecovery()).status, 'READY');
  assert.deepEqual(harness.removedTabs, [], 'a user-navigated tab must not be closed');
  assert.equal(await harness.manager.focusLoginHelper(), false);
  assert.deepEqual(harness.focusedTabs, [], 'a user-navigated tab must not be focused');
  assert.equal(harness.session.state[recoveryTab.HELPER_STORAGE_KEY], undefined);
});

test('service worker routes recovery through the revisioned runtime', () => {
  const source = readFileSync(
    path.join(__dirname, '../background/service-worker.js'),
    'utf8',
  );
  assert.match(source, /canCapture:[\s\S]*?resolveCurrentWithRecovery\(\)/);
  assert.match(source, /getSellerCompanyIdCandidates[\s\S]*?resolveCurrentWithRecovery\(\)/);
});

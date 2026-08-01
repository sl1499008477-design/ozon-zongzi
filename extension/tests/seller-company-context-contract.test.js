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
      tabs: {
        async get(tabId) { return tabs.find((tab) => tab.id === tabId); },
        query: async () => tabs,
      },
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
      tabs: {
        async get(tabId) { return tab.id === tabId ? tab : null; },
        query: async () => [tab],
      },
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
      tabs: {
        async get(tabId) { return tab.id === tabId ? tab : null; },
        query: async () => [tab],
      },
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

function createRecoveryHarness({
  userTabs = [],
  onSleep,
  helperUrl,
  updateError,
  onRemove,
  onUpdate,
} = {}) {
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
        await onRemove?.({ session, tabId, liveTabs });
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

test('ordinary recovery closes its inactive helper after resolving company context', async () => {
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
  assert.equal(harness.session.state[recoveryTab.HELPER_STORAGE_KEY], undefined);
  assert.equal(harness.removedTabs.includes(userTab.id), false);
});

test('collection recovery never leases the stale snapshot of a cleaned helper', async () => {
  let firstHelperId = 0;
  let secondHelperId = 0;
  const harness = createRecoveryHarness({
    onSleep({ liveTabs, setCurrent, sleepCount }) {
      if (sleepCount === 2) {
        firstHelperId = [...liveTabs.keys()][0];
        setCurrent({
          companyId: '2681910', revision: 1, observedAt: NOW, sellerTabId: firstHelperId,
        });
      }
      if (sleepCount === 4) {
        secondHelperId = [...liveTabs.keys()][0];
        setCurrent({
          companyId: '2681910', revision: 1, observedAt: NOW, sellerTabId: secondHelperId,
        });
      }
    },
  });
  const options = { pollIntervalMs: 10, probeTimeoutMs: 10, timeoutMs: 40 };

  const ordinary = await harness.manager.resolveCurrentWithRecovery(options);
  assert.equal(ordinary.sellerTabId, firstHelperId);
  assert.deepEqual(harness.removedTabs, [firstHelperId]);

  const lease = await harness.manager.acquireCurrentWithRecovery(options);
  assert.notEqual(secondHelperId, firstHelperId);
  assert.equal(lease.snapshot.sellerTabId, secondHelperId);
  assert.equal(harness.createdTabOptions.length, 2);
  assert.deepEqual(harness.removedTabs, [firstHelperId]);
  assert.equal(await lease.release(), true);
  assert.deepEqual(harness.removedTabs, [firstHelperId, secondHelperId]);
});

test('an explicit recovery lease retains its helper until capture releases it', async () => {
  let helperId = 0;
  const harness = createRecoveryHarness({
    onSleep({ liveTabs, setCurrent, sleepCount }) {
      if (sleepCount === 2) {
        helperId = [...liveTabs.keys()][0];
        setCurrent({
          companyId: '2681910', revision: 1, observedAt: NOW, sellerTabId: helperId,
        });
      }
    },
  });

  const lease = await harness.manager.acquireCurrentWithRecovery({
    pollIntervalMs: 10,
    probeTimeoutMs: 10,
    timeoutMs: 40,
  });

  assert.equal(lease.snapshot.status, 'READY');
  assert.equal(lease.snapshot.sellerTabId, helperId);
  assert.deepEqual(harness.removedTabs, []);
  assert.deepEqual(harness.session.state[recoveryTab.HELPER_STORAGE_KEY], {
    tabId: helperId,
    active: false,
  });
  assert.equal(await lease.release(), true);
  assert.deepEqual(harness.removedTabs, [helperId]);
  assert.equal(harness.session.state[recoveryTab.HELPER_STORAGE_KEY], undefined);
  assert.equal(await lease.release(), false, 'a lease release must be idempotent');
});

test('ordinary callers cannot close a helper retained for collection', async () => {
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
  const lease = await harness.manager.acquireCurrentWithRecovery({
    pollIntervalMs: 10,
    probeTimeoutMs: 10,
    timeoutMs: 40,
  });

  harness.setCurrent({
    companyId: '2681910', revision: 1, observedAt: NOW, sellerTabId: userTab.id,
  });
  const ordinary = await harness.manager.resolveCurrentWithRecovery();
  assert.equal(ordinary.sellerTabId, userTab.id);
  assert.deepEqual(harness.removedTabs, []);
  assert.equal(await lease.release(), true);
  assert.deepEqual(harness.removedTabs, [helperId]);
  assert.equal(harness.removedTabs.includes(userTab.id), false);
});

test('concurrent collection leases close their helper only after the final release', async () => {
  let helperId = 0;
  const harness = createRecoveryHarness({
    onSleep({ liveTabs, setCurrent, sleepCount }) {
      if (sleepCount === 2) {
        helperId = [...liveTabs.keys()][0];
        setCurrent({
          companyId: '2681910', revision: 1, observedAt: NOW, sellerTabId: helperId,
        });
      }
    },
  });
  const options = { pollIntervalMs: 10, probeTimeoutMs: 10, timeoutMs: 40 };

  const [first, second, ordinary] = await Promise.all([
    harness.manager.acquireCurrentWithRecovery(options),
    harness.manager.acquireCurrentWithRecovery(options),
    harness.manager.resolveCurrentWithRecovery(options),
  ]);

  assert.equal(first.snapshot.sellerTabId, helperId);
  assert.equal(second.snapshot.sellerTabId, helperId);
  assert.equal(ordinary.sellerTabId, helperId);
  assert.equal(harness.createdTabOptions.length, 1);
  assert.deepEqual(harness.removedTabs, []);
  assert.equal(await first.release(), true);
  assert.deepEqual(harness.removedTabs, []);
  assert.equal(await second.release(), true);
  assert.deepEqual(harness.removedTabs, [helperId]);
});

test('a lease never closes a concurrently replaced helper tag', async () => {
  let helperId = 0;
  const harness = createRecoveryHarness({
    onSleep({ liveTabs, setCurrent, sleepCount }) {
      if (sleepCount === 2) {
        helperId = [...liveTabs.keys()][0];
        setCurrent({
          companyId: '2681910', revision: 1, observedAt: NOW, sellerTabId: helperId,
        });
      }
    },
  });
  const lease = await harness.manager.acquireCurrentWithRecovery({
    pollIntervalMs: 10,
    probeTimeoutMs: 10,
    timeoutMs: 40,
  });
  harness.liveTabs.set(71, {
    id: 71, url: 'https://seller.ozon.ru/app/products', active: false,
  });
  await harness.session.set({
    [recoveryTab.HELPER_STORAGE_KEY]: { tabId: 71, active: false },
  });

  assert.equal(await lease.release(), true);
  assert.deepEqual(harness.removedTabs, []);
  assert.deepEqual(harness.session.state[recoveryTab.HELPER_STORAGE_KEY], {
    tabId: 71,
    active: false,
  });
});

test('closing an old leased helper preserves a replacement tag installed concurrently', async () => {
  let helperId = 0;
  const harness = createRecoveryHarness({
    onSleep({ liveTabs, setCurrent, sleepCount }) {
      if (sleepCount === 2) {
        helperId = [...liveTabs.keys()][0];
        setCurrent({
          companyId: '2681910', revision: 1, observedAt: NOW, sellerTabId: helperId,
        });
      }
    },
    async onRemove({ session, liveTabs }) {
      liveTabs.set(71, {
        id: 71, url: 'https://seller.ozon.ru/app/products', active: false,
      });
      await session.set({
        [recoveryTab.HELPER_STORAGE_KEY]: { tabId: 71, active: false },
      });
    },
  });
  const lease = await harness.manager.acquireCurrentWithRecovery({
    pollIntervalMs: 10,
    probeTimeoutMs: 10,
    timeoutMs: 40,
  });

  assert.equal(await lease.release(), true);
  assert.deepEqual(harness.removedTabs, [helperId]);
  assert.deepEqual(harness.session.state[recoveryTab.HELPER_STORAGE_KEY], {
    tabId: 71,
    active: false,
  });
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
  const userTab = { id: 7, url: 'https://seller.ozon.ru/app/products', active: true };
  const harness = createRecoveryHarness({ userTabs: [userTab] });
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
  assert.match(source, /createCollectorSellerContextLeaseBridge\(\{[\s\S]*?runtime: sellerCompanyContextRuntime/);
  assert.match(source, /sellerContextRuntime: collectorSellerContextLeaseBridge\.sellerContextRuntime/);
  assert.match(source, /canCapture: collectorSellerContextLeaseBridge\.canCapture/);
  assert.match(source, /getSellerCompanyIdCandidates[\s\S]*?resolveCurrentWithRecovery\(\)/);
});

function extractWorkerHelper(source, startToken, endToken, name) {
  const start = source.indexOf(startToken);
  assert.notEqual(start, -1, `${name} start must exist`);
  const end = source.indexOf(endToken, start);
  assert.notEqual(end, -1, `${name} end must exist`);
  return new Function(`${source.slice(start, end)}\nreturn ${name};`)();
}

test('Collector lease bridge acquires only while resolving so cancellation cannot orphan a helper', async () => {
  const source = readFileSync(
    path.join(__dirname, '../background/service-worker.js'),
    'utf8',
  );
  const createCollectorSellerContextLeaseBridge = extractWorkerHelper(
    source,
    'const createCollectorSellerContextLeaseBridge = ({',
    '\n\n  const collectorSessionManager',
    'createCollectorSellerContextLeaseBridge',
  );
  const retainedSnapshot = Object.freeze({
    status: 'READY',
    companyId: '2681910',
    revision: 3,
    observedAt: NOW,
    sellerTabId: 70,
  });
  let acquisitions = 0;
  let directRecoveries = 0;
  let releases = 0;
  const runtime = {
    async acquireCurrentWithRecovery() {
      acquisitions += 1;
      let released = false;
      return {
        snapshot: retainedSnapshot,
        async release() {
          if (released) return false;
          released = true;
          releases += 1;
          return true;
        },
      };
    },
    async resolveCurrentWithRecovery() {
      directRecoveries += 1;
      throw new Error('the retained path must not recover or open again');
    },
    async isSnapshotCurrent(snapshot) {
      return snapshot === retainedSnapshot;
    },
  };
  const bridge = createCollectorSellerContextLeaseBridge({
    runtime,
    readyStatus: 'READY',
  });

  assert.equal(await bridge.canCapture(), true);
  assert.equal(acquisitions, 0, 'the preflight gate must not acquire an ownerless lease');
  const resolved = await bridge.sellerContextRuntime.resolveCurrentWithRecovery();
  assert.strictEqual(resolved, retainedSnapshot);
  assert.equal(acquisitions, 1);
  assert.equal(directRecoveries, 0);
  assert.equal(await bridge.sellerContextRuntime.isSnapshotCurrent(resolved), true);
  assert.equal(await bridge.sellerContextRuntime.releaseSnapshot({ ...resolved }), true,
    'the agent normalizes the snapshot into a new object before release');
  assert.equal(releases, 1);
});

test('Collector read-only capture fills real /search physical gaps from public PDP and never creates a bundle', async () => {
  const source = readFileSync(
    path.join(__dirname, '../background/service-worker.js'),
    'utf8',
  );
  const readOzonPublicPhysicalsInPage = extractWorkerHelper(
    source,
    'const readOzonPublicPhysicalsInPage = async (',
    '\n\n  const fetchReadOnlyOzonPublicPhysicals',
    'readOzonPublicPhysicalsInPage',
  );
  const normalizeSearchVariantToSv = extractWorkerHelper(
    source,
    'const normalizeSearchVariantToSv = (v) => {',
    '\n\n  /**',
    'normalizeSearchVariantToSv',
  );
  const readSellerSearchVariants = extractWorkerHelper(
    source,
    'const readSellerSearchVariants = async ({',
    '\n\n  const searchVariantsLocal',
    'readSellerSearchVariants',
  );
  const enrichSellerSearchItems = extractWorkerHelper(
    source,
    'const enrichSellerSearchItems = async ({',
    '\n\n  const readSellerSearchVariants',
    'enrichSellerSearchItems',
  );
  const calls = [];
  const fetched = await readSellerSearchVariants({
    sku: '4862904234',
    companyId: '2681910',
    preferTabId: 70,
    requestOptions: { timeoutMs: 6_000 },
    normalizeVariant: normalizeSearchVariantToSv,
    async fetchPortal(...args) {
      calls.push(args);
      return {
        variants: [{
          variant_id: 'variant-1',
          description_category_id: 17_000_001,
          skus: [{ sku: '4862904234' }],
          variant_name: 'Real search response intentionally has no physical fields',
        }],
      };
    },
  });
  const publicPhysicals = await readOzonPublicPhysicalsInPage(
    '4862904234',
    6_000,
    async () => ({
      ok: true,
      async json() {
        return {
          widgetStates: {
            'webShortCharacteristics-1': JSON.stringify({
              characteristics: [
                { title: { textRs: [{ content: 'Вес товара' }] }, values: [{ text: '0.2kg' }] },
                { title: { textRs: [{ content: 'Вес товара с упаковкой' }] }, values: [{ text: '0.5kg' }] },
                { title: { textRs: [{ content: 'Длина товара' }] }, values: [{ text: '12cm' }] },
                { title: { textRs: [{ content: 'Длина упаковки' }] }, values: [{ text: '30cm' }] },
                { title: { textRs: [{ content: 'Ширина' }] }, values: [{ text: '99' }] },
                { title: { textRs: [{ content: 'Ширина упаковки, см' }] }, values: [{ text: '20' }] },
                { title: { textRs: [{ content: 'Высота упаковки' }] }, values: [{ text: '10cm' }] },
              ],
            }),
          },
        };
      },
    }),
  );
  let bundleCalls = 0;
  let publicCalls = 0;
  const items = await enrichSellerSearchItems({
    readOnly: true,
    items: fetched.items,
    sku: '4862904234',
    companyId: '2681910',
    async fetchBundle() { bundleCalls += 1; throw new Error('write endpoint forbidden'); },
    mergeBundle(value) { return value; },
    async fetchPublicPhysicals() { publicCalls += 1; return publicPhysicals; },
    mergePublicPhysicals(sourceVariant, physicals) {
      const attributes = [...sourceVariant.attributes];
      for (const [key, field] of [
        ['4497', 'weight'],
        ['9454', 'depth'],
        ['9455', 'width'],
        ['9456', 'height'],
      ]) attributes.push({ key, value: String(physicals[field]) });
      return { ...sourceVariant, ...physicals, attributes };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/search');
  assert.equal(calls[0][2].urlPrefix, '/api/v1');
  assert.equal(calls[0][2].preferTabId, 70);
  assert.equal(publicCalls, 1);
  assert.equal(bundleCalls, 0);
  assert.deepEqual(publicPhysicals, { weight: 500, depth: 300, width: 200, height: 100 });

  const ambiguousUnitless = await readOzonPublicPhysicalsInPage(
    '4862904234',
    6_000,
    async () => ({
      ok: true,
      async json() {
        return {
          widgetStates: {
            characteristics: JSON.stringify({
              characteristics: [
                { name: 'Вес товара', value: '500' },
                { name: 'Длина товара', value: '300' },
                { name: 'Ширина товара', value: '200' },
                { name: 'Высота товара', value: '100' },
              ],
            }),
          },
        };
      },
    }),
  );
  assert.equal(ambiguousUnitless, null);

  const combinedDimensions = await readOzonPublicPhysicalsInPage(
    '4862904234',
    6_000,
    async () => ({
      ok: true,
      async json() {
        return {
          widgetStates: {
            characteristics: JSON.stringify({
              characteristics: [
                { name: 'Вес брутто, кг', value: '0.5' },
                { name: 'Габариты упаковки, см', value: '30×20×10' },
              ],
            }),
          },
        };
      },
    }),
  );
  assert.deepEqual(combinedDimensions, {
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
  });

  const combinedValueUnit = await readOzonPublicPhysicalsInPage(
    '4862904234',
    6_000,
    async () => ({
      ok: true,
      async json() {
        return {
          widgetStates: {
            characteristics: JSON.stringify({
              characteristics: [
                { name: 'Вес брутто', value: '0.5 кг' },
                { name: 'Габариты упаковки', value: '30×20×10 см' },
              ],
            }),
          },
        };
      },
    }),
  );
  assert.deepEqual(combinedValueUnit, combinedDimensions);

  const responseBodyDeadline = await readOzonPublicPhysicalsInPage(
    '4862904234',
    5,
    async (_url, options) => ({
      ok: true,
      json: () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({
          widgetStates: {
            characteristics: JSON.stringify({
              characteristics: [{ name: 'Вес брутто, кг', value: '0.5' }],
            }),
          },
        }), 30);
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }),
    }),
  );
  assert.equal(responseBodyDeadline, null);
  assert.deepEqual(
    items[0].attributes.filter(({ key }) => ['4497', '9454', '9455', '9456'].includes(key)),
    [
      { key: '4497', value: '500' },
      { key: '9454', value: '300' },
      { key: '9455', value: '200' },
      { key: '9456', value: '100' },
    ],
  );
});

test('read-only public physical capture reuses an existing buyer tab without creating or closing tabs', async () => {
  const source = readFileSync(
    path.join(__dirname, '../background/service-worker.js'),
    'utf8',
  );
  const fetchReadOnlyOzonPublicPhysicals = extractWorkerHelper(
    source,
    'const fetchReadOnlyOzonPublicPhysicals = async ({',
    '\n\n  /**',
    'fetchReadOnlyOzonPublicPhysicals',
  );
  const calls = [];
  const result = await fetchReadOnlyOzonPublicPhysicals({
    sku: '4862904234',
    deadlineAt: NOW + 10_000,
    now: () => NOW,
    requestOptionsForDeadline() { return { timeoutMs: 6_000 }; },
    async queryTabs(query) {
      calls.push(['query', query]);
      return [{ id: 91, status: 'complete', url: 'https://www.ozon.ru/product/4862904234' }];
    },
    async executeInTab(tabId, args) {
      calls.push(['execute', tabId, args]);
      return { weight: 500, depth: 300, width: 200, height: 100 };
    },
  });

  assert.deepEqual(result, { weight: 500, depth: 300, width: 200, height: 100 });
  assert.equal(calls[0][0], 'query');
  assert.deepEqual(calls[1], ['execute', 91, ['4862904234', 6_000]]);
  assert.doesNotMatch(
    source.slice(
      source.indexOf('const fetchReadOnlyOzonPublicPhysicals = async ({'),
      source.indexOf('\n\n  /**', source.indexOf('const fetchReadOnlyOzonPublicPhysicals = async ({')),
    ),
    /tabs\.(?:create|remove|update)\s*\(/,
  );
});

test('a frozen Seller tab is reused without opening or selecting another tab', async () => {
  const source = readFileSync(
    path.join(__dirname, '../background/service-worker.js'),
    'utf8',
  );
  const resolveSellerPortalTargetTab = extractWorkerHelper(
    source,
    'const resolveSellerPortalTargetTab = async ({',
    '\n\n  const fetchSellerPortal',
    'resolveSellerPortalTargetTab',
  );
  let ensures = 0;
  const frozen = { id: 70, url: 'https://seller.ozon.ru/app/products' };
  const resolved = await resolveSellerPortalTargetTab({
    preferTabId: 70,
    tabsApi: { async get() { return frozen; } },
    identityPolicy: policy,
    async ensureTab() { ensures += 1; return { id: 99 }; },
  });
  assert.strictEqual(resolved, frozen);
  assert.equal(ensures, 0);

  await assert.rejects(resolveSellerPortalTargetTab({
    preferTabId: 70,
    tabsApi: { async get() { return { id: 70, url: 'https://example.com/' }; } },
    identityPolicy: policy,
    async ensureTab() { ensures += 1; return { id: 99 }; },
  }), (error) => error?.code === 'SELLER_CONTEXT_CHANGED');
  assert.equal(ensures, 0, 'a stale frozen tab must fail closed, not create another tab');
});

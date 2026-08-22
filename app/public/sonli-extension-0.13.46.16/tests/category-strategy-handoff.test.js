const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCategoryStrategyReturnNavigation,
  projectBrowserUrl,
  projectSamplingPageUrl,
} = require('../lib/category-strategy-handoff.js');

const VALID = 'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/'
  + '?zongziCategoryStrategySession=session-a';
const LEGACY_PRODUCT = 'https://www.ozon.ru/product/'
  + 'mqouo-shkaf-skladnoy-turisticheskiy-1941181573/'
  + '?zongziCategoryStrategySession=session-a';

test('sampling browser URL accepts one exact Ozon category session URL', () => {
  assert.equal(projectBrowserUrl(VALID), VALID);
  assert.equal(projectBrowserUrl(LEGACY_PRODUCT), LEGACY_PRODUCT);
});

test('sampling page URL must be the exact category page for the active session', () => {
  assert.equal(projectSamplingPageUrl(VALID, 'session-a'), VALID);
  for (const [url, sessionId] of [
    [LEGACY_PRODUCT, 'session-a'],
    [VALID, 'session-b'],
    [`${VALID}&sorting=rating`, 'session-a'],
  ]) assert.throws(() => projectSamplingPageUrl(url, sessionId), {
    code: 'CATEGORY_STRATEGY_HANDOFF_URL_INVALID',
  });
});

test('sampling browser URL rejects every authority, path, query, and identifier escape', () => {
  const accessor = {};
  Object.defineProperty(accessor, 'toString', { enumerable: true, get() {
    throw new Error('must not execute');
  } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [
    '',
    ` ${VALID}`,
    'https://attacker.test/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a',
    'https://user:pass@www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a',
    'http://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a',
    'https://www.ozon.ru/category/17028922/?zongziCategoryStrategySession=session-a',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/brand-1/?zongziCategoryStrategySession=session-a',
    'https://www.ozon.ru/product/17028922/?zongziCategoryStrategySession=session-a',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a&secret=x',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=session-a&zongziCategoryStrategySession=session-b',
    'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/?zongziCategoryStrategySession=%2Funsafe',
    `${VALID}#fragment`,
    'x'.repeat(2_049),
    accessor,
    revoked.proxy,
  ]) assert.throws(() => projectBrowserUrl(value), {
    code: 'CATEGORY_STRATEGY_HANDOFF_URL_INVALID',
  });
});

test('successful sampling returns to the exact strategy draft before closing the Ozon tab', async () => {
  assert.equal(typeof createCategoryStrategyReturnNavigation, 'function');
  const state = {};
  const calls = [];
  const navigation = createCategoryStrategyReturnNavigation({
    storageSession: {
      async get(key) { return { [key]: state[key] }; },
      async set(values) { Object.assign(state, values); },
      async remove(key) { delete state[key]; },
    },
    allowedOrigins: ['http://127.0.0.1:3000'],
    async updateTab(tabId, update) { calls.push({ action: 'update', tabId, update }); },
    async updateWindow(windowId, update) { calls.push({ action: 'focus', windowId, update }); },
    async createTab(options) { calls.push({ action: 'create', options }); return { id: 88 }; },
    async removeTab(tabId) { calls.push({ action: 'remove', tabId }); },
  });
  await navigation.remember({
    browserUrl: VALID,
    returnTabId: 17,
    returnWindowId: 8,
    returnUrl: 'http://127.0.0.1:3000/ozon/tools/category-strategies?draftId=draft-a',
    samplingTabId: 29,
  });

  assert.deepEqual(await navigation.complete({ sessionId: 'session-a', samplingTabId: 29 }), {
    returned: true,
    closed: true,
  });
  assert.deepEqual(calls, [
    { action: 'update', tabId: 17, update: {
      url: 'http://127.0.0.1:3000/ozon/tools/category-strategies?draftId=draft-a', active: true,
    } },
    { action: 'focus', windowId: 8, update: { focused: true } },
    { action: 'remove', tabId: 29 },
  ]);
  assert.deepEqual(state, {});
});

test('failed or unrelated return navigation never closes the current tab', async () => {
  assert.equal(typeof createCategoryStrategyReturnNavigation, 'function');
  const state = {};
  const removed = [];
  const navigation = createCategoryStrategyReturnNavigation({
    storageSession: {
      async get(key) { return { [key]: state[key] }; },
      async set(values) { Object.assign(state, values); },
      async remove(key) { delete state[key]; },
    },
    allowedOrigins: ['http://127.0.0.1:3000'],
    async updateTab() { throw new Error('return tab disappeared'); },
    async updateWindow() {},
    async createTab() { throw new Error('cannot create return tab'); },
    async removeTab(tabId) { removed.push(tabId); },
  });
  await navigation.remember({
    browserUrl: VALID,
    returnTabId: 17,
    returnWindowId: 8,
    returnUrl: 'http://127.0.0.1:3000/ozon/tools/category-strategies?draftId=draft-a',
    samplingTabId: 29,
  });

  assert.deepEqual(await navigation.complete({ sessionId: 'session-a', samplingTabId: 30 }), {
    returned: false,
    closed: false,
  });
  assert.deepEqual(await navigation.complete({ sessionId: 'session-a', samplingTabId: 29 }), {
    returned: false,
    closed: false,
  });
  assert.deepEqual(removed, []);
});

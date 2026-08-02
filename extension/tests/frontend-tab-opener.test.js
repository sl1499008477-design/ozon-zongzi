const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createFrontendTabOpener,
} = require('../lib/frontend-tab-opener.js');

const makeHarness = ({
  tabs = [],
  createResult = { id: 29 },
  updateTabError = null,
  requestAuthError = null,
} = {}) => {
  const updatedTabs = [];
  const updatedWindows = [];
  const createdTabs = [];
  const requestedAuthTabs = [];

  const opener = createFrontendTabOpener({
    queryTabs: async () => tabs,
    updateTab: async (id, update) => {
      updatedTabs.push({ id, update });
      if (updateTabError) throw updateTabError;
    },
    updateWindow: async (id, update) => {
      updatedWindows.push({ id, update });
    },
    createTab: async (options) => {
      createdTabs.push(options);
      return createResult;
    },
    requestCollectorAuth: async (tabId) => {
      requestedAuthTabs.push(tabId);
      if (requestAuthError) throw requestAuthError;
    },
  });

  return {
    ...opener,
    createdTabs,
    requestedAuthTabs,
    updatedTabs,
    updatedWindows,
  };
};

test('reuses the first trusted tab with an integer id without changing its URL', async () => {
  const {
    open,
    createdTabs,
    requestedAuthTabs,
    updatedTabs,
    updatedWindows,
  } = makeHarness({
    tabs: [
      { id: 'invalid', windowId: 2, url: 'https://ignored.example/' },
      { id: 17, windowId: 8, url: 'https://store.jizhangerp.com/ozon/dashboard' },
      { id: 19, windowId: 9, url: 'http://127.0.0.1:3000/ozon/products' },
    ],
  });

  assert.deepEqual(await open({ url: 'http://127.0.0.1:3000/login' }), {
    opened: true,
    reused: true,
    tabId: 17,
  });
  assert.deepEqual(updatedTabs, [{ id: 17, update: { active: true } }]);
  assert.deepEqual(updatedWindows, [{ id: 8, update: { focused: true } }]);
  assert.deepEqual(createdTabs, []);
  assert.deepEqual(requestedAuthTabs, [17]);
});

test('creates one active tab when no trusted tab has an integer id', async () => {
  const { open, createdTabs, requestedAuthTabs } = makeHarness({
    tabs: [{ id: '17', windowId: 8 }],
    createResult: { id: 31 },
  });
  const url = 'http://127.0.0.1:3000/login';

  assert.deepEqual(await open({ url }), {
    opened: true,
    reused: false,
    tabId: 31,
  });
  assert.deepEqual(createdTabs, [{ url, active: true }]);
  assert.deepEqual(requestedAuthTabs, [31]);
});

test('creates exactly one active tab when focusing the trusted tab fails', async () => {
  const { open, createdTabs, requestedAuthTabs } = makeHarness({
    tabs: [{ id: 17, windowId: 8 }],
    createResult: { id: 32 },
    updateTabError: new Error('tab disappeared'),
  });
  const url = 'http://127.0.0.1:3000/login';

  assert.deepEqual(await open({ url }), {
    opened: true,
    reused: false,
    tabId: 32,
  });
  assert.deepEqual(createdTabs, [{ url, active: true }]);
  assert.deepEqual(requestedAuthTabs, [32]);
});

test('keeps the opened result when collector authentication messaging rejects', async () => {
  const { open, createdTabs, requestedAuthTabs } = makeHarness({
    createResult: { id: 33 },
    requestAuthError: new Error('receiving end does not exist'),
  });

  assert.deepEqual(await open({ url: 'https://store.jizhangerp.com/login' }), {
    opened: true,
    reused: false,
    tabId: 33,
  });
  assert.equal(createdTabs.length, 1);
  assert.deepEqual(requestedAuthTabs, [33]);
});

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
  requestAuthErrors = [],
} = {}) => {
  const updatedTabs = [];
  const updatedWindows = [];
  const createdTabs = [];
  const injectedAuthTabs = [];
  const requestedAuthTabs = [];
  const authEvents = [];
  let requestAuthCall = 0;

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
      authEvents.push({ type: 'request', tabId });
      const error = requestAuthErrors[requestAuthCall] || requestAuthError;
      requestAuthCall += 1;
      if (error) throw error;
    },
    injectCollectorAuth: async (tabId) => {
      injectedAuthTabs.push(tabId);
      authEvents.push({ type: 'inject', tabId });
    },
  });

  return {
    ...opener,
    authEvents,
    createdTabs,
    injectedAuthTabs,
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
  const {
    open,
    createdTabs,
    injectedAuthTabs,
    requestedAuthTabs,
  } = makeHarness({
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
  assert.deepEqual(injectedAuthTabs, []);
});

test('injects collector auth into a reused tab on no receiver and retries exactly once', async () => {
  const {
    open,
    authEvents,
    createdTabs,
    injectedAuthTabs,
    requestedAuthTabs,
  } = makeHarness({
    tabs: [{ id: 17, windowId: 8 }],
    requestAuthErrors: [
      new Error('Could not establish connection. Receiving end does not exist.'),
    ],
  });

  assert.deepEqual(await open({ url: 'http://127.0.0.1:3000/login' }), {
    opened: true,
    reused: true,
    tabId: 17,
  });
  assert.deepEqual(createdTabs, []);
  assert.deepEqual(injectedAuthTabs, [17]);
  assert.deepEqual(requestedAuthTabs, [17, 17]);
  assert.deepEqual(authEvents, [
    { type: 'request', tabId: 17 },
    { type: 'inject', tabId: 17 },
    { type: 'request', tabId: 17 },
  ]);
});

test('does not inject collector auth for a reused tab on other messaging failures', async () => {
  const {
    open,
    injectedAuthTabs,
    requestedAuthTabs,
  } = makeHarness({
    tabs: [{ id: 18, windowId: 9 }],
    requestAuthError: new Error('The message port closed before a response was received.'),
  });

  assert.deepEqual(await open({ url: 'http://127.0.0.1:3000/login' }), {
    opened: true,
    reused: true,
    tabId: 18,
  });
  assert.deepEqual(requestedAuthTabs, [18]);
  assert.deepEqual(injectedAuthTabs, []);
});

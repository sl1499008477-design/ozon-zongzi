const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  companyIdFromSellerSwitcher,
  installObserver,
  normalizeCompanyId,
  sellerSwitcherEntryFromText,
} = require('../lib/seller-company-context.js');

assert.equal(normalizeCompanyId('2681910'), '2681910');
assert.equal(normalizeCompanyId(' 2681910 '), '2681910');
assert.equal(normalizeCompanyId('123'), '');
assert.equal(normalizeCompanyId('2681910-token'), '');

assert.equal(companyIdFromSellerSwitcher({
  activeName: 'zehai',
  entries: [
    { name: 'zehai', companyId: '2681910' },
    { name: 'tangguo', companyId: '3468478' },
  ],
}), '2681910');
assert.equal(companyIdFromSellerSwitcher({
  activeName: 'zehai',
  entries: [
    { name: 'zehai', companyId: '2681910' },
    { name: 'zehai', companyId: '3468478' },
  ],
}), '', 'same-name multi-company switchers must fail closed');
assert.equal(companyIdFromSellerSwitcher({
  activeName: 'missing',
  entries: [{ name: 'zehai', companyId: '2681910' }],
}), '', 'the active company name must match a visible switcher entry');

assert.deepEqual(
  sellerSwitcherEntryFromText('zehaiSeller ID 2681910'),
  { name: 'zehai', companyId: '2681910' },
  'current Seller switcher DOM concatenates the company name and Seller ID without whitespace',
);

const loadMainWorldHook = ({ origin, topFrame = true, delayedSwitcher = false }) => {
  const listeners = new Map();
  const posted = [];
  const timers = [];
  let observedCallback = null;
  let switcherReady = !delayedSwitcher;
  let switcherExpanded = false;
  const window = {
    location: { origin },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
  };
  window.top = topFrame ? window : {};
  const switcherHeader = {
    innerText: 'zehai',
    querySelector: () => null,
    getAttribute: (name) => (name === 'aria-expanded' && switcherExpanded ? 'true' : null),
    click() { switcherExpanded = !switcherExpanded; },
  };
  const document = delayedSwitcher ? {
    querySelector: (selector) => (
      selector === '[data-onboarding-target="headerCompanyName"]' && switcherReady
        ? switcherHeader
        : null
    ),
    querySelectorAll: () => (switcherExpanded ? [
      { innerText: 'zehaiSeller ID 2681910' },
      { innerText: 'tangguoSeller ID 3468478' },
    ] : []),
  } : undefined;
  const context = vm.createContext({
    JzSellerCompanyContext: {
      companyIdFromSellerSwitcher,
      installObserver({ onCompanyId }) {
        observedCallback = onCompanyId;
      },
      normalizeCompanyId,
      sellerSwitcherEntryFromText,
    },
    document,
    setTimeout: delayedSwitcher
      ? (callback) => {
          timers.push(callback);
          return timers.length;
        }
      : undefined,
    URL,
    globalThis: null,
    window,
  });
  context.globalThis = context;
  vm.runInContext(readFileSync(
    path.join(__dirname, '../content/seller-company-context-hook.js'),
    'utf8',
  ), context);
  return {
    listeners,
    observed: () => observedCallback,
    posted,
    setSwitcherReady(value) { switcherReady = value; },
    timers,
    async runNextTimer() {
      const callback = timers.shift();
      if (typeof callback === 'function') callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
    window,
  };
};

const exactTopHook = loadMainWorldHook({ origin: 'https://seller.ozon.ru' });
assert.equal(typeof exactTopHook.observed(), 'function');
exactTopHook.observed()('2681910');
assert.equal(exactTopHook.posted.length, 1);

const portHook = loadMainWorldHook({ origin: 'https://seller.ozon.ru:444' });
assert.equal(portHook.observed(), null, 'non-exact Seller origins must not install the observer');

const framedHook = loadMainWorldHook({ origin: 'https://seller.ozon.ru', topFrame: false });
assert.equal(framedHook.observed(), null, 'non-top frames must not install the observer');

class FakeXMLHttpRequest {
  constructor() {
    this.headers = [];
  }

  setRequestHeader(name, value) {
    this.headers.push([name, value]);
  }
}

const originalFetch = async (...args) => ({ ok: true, args });
const root = {
  fetch: originalFetch,
  XMLHttpRequest: FakeXMLHttpRequest,
};
const observed = [];
const uninstall = installObserver({
  root,
  onCompanyId: (companyId) => observed.push(companyId),
});

(async () => {
  const delayedHook = loadMainWorldHook({
    origin: 'https://seller.ozon.ru',
    delayedSwitcher: true,
  });
  await delayedHook.runNextTimer();
  delayedHook.setSwitcherReady(true);
  for (let index = 0; index < 6 && delayedHook.posted.length === 0; index += 1) {
    await delayedHook.runNextTimer();
  }
  assert.deepEqual(JSON.parse(JSON.stringify(delayedHook.posted)), [{
    message: {
      __jzSellerCompanyContext: 1,
      type: 'JZ_SELLER_COMPANY_CONTEXT',
      companyId: '2681910',
    },
    targetOrigin: 'https://seller.ozon.ru',
  }], 'the hook must wait for the Seller SPA header before publishing its exact company');

  await root.fetch('/api/v1/search', {
    headers: {
      accept: 'application/json',
      'x-o3-company-id': '2681910',
    },
  });
  await root.fetch('/api/v1/search', {
    headers: [
      ['X-O3-COMPANY-ID', '2681910'],
      ['authorization', 'must-not-be-observed'],
    ],
  });
  await root.fetch('/api/v1/search', {
    headers: {
      'x-o3-company-id': 'invalid',
    },
  });
  await root.fetch('/api/composer-api.bx/_action/setUserCookies', {
    method: 'POST',
    body: JSON.stringify({
      cookies: [{
        name: 'sc_company_id',
        value: '9021436',
        params: 'path=/;domain=.ozon.ru;',
      }],
    }),
  });
  await root.fetch('https://untrusted.example/api/composer-api.bx/_action/setUserCookies', {
    method: 'POST',
    body: JSON.stringify({
      cookies: [{ name: 'sc_company_id', value: '8000001' }],
    }),
  });

  const xhr = new root.XMLHttpRequest();
  xhr.setRequestHeader('x-o3-company-id', '7311458');
  xhr.setRequestHeader('authorization', 'must-not-be-observed');

  assert.deepEqual(
    observed,
    ['2681910', '9021436', '7311458'],
    'observer should emit each valid Seller company once and ignore unrelated request data',
  );
  assert.deepEqual(xhr.headers, [
    ['x-o3-company-id', '7311458'],
    ['authorization', 'must-not-be-observed'],
  ]);

  uninstall();
  assert.equal(root.fetch, originalFetch, 'uninstall should restore the page fetch function');
  console.log('seller company context observer tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

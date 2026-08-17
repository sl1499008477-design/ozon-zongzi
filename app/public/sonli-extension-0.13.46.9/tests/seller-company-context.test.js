const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  installObserver,
  normalizeCompanyId,
} = require('../lib/seller-company-context.js');

assert.equal(normalizeCompanyId('2681910'), '2681910');
assert.equal(normalizeCompanyId(' 2681910 '), '2681910');
assert.equal(normalizeCompanyId('123'), '');
assert.equal(normalizeCompanyId('2681910-token'), '');

const loadMainWorldHook = ({ origin, topFrame = true }) => {
  const listeners = new Map();
  const posted = [];
  let observedCallback = null;
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
  const context = vm.createContext({
    JzSellerCompanyContext: {
      installObserver({ onCompanyId }) {
        observedCallback = onCompanyId;
      },
      normalizeCompanyId,
    },
    URL,
    globalThis: null,
    window,
  });
  context.globalThis = context;
  vm.runInContext(readFileSync(
    path.join(__dirname, '../content/seller-company-context-hook.js'),
    'utf8',
  ), context);
  return { listeners, observed: () => observedCallback, posted, window };
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

const assert = require('node:assert/strict');
const {
  installObserver,
  normalizeCompanyId,
} = require('../lib/seller-company-context.js');

assert.equal(normalizeCompanyId('2681910'), '2681910');
assert.equal(normalizeCompanyId(' 2681910 '), '2681910');
assert.equal(normalizeCompanyId('123'), '');
assert.equal(normalizeCompanyId('2681910-token'), '');

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

  const xhr = new root.XMLHttpRequest();
  xhr.setRequestHeader('x-o3-company-id', '7311458');
  xhr.setRequestHeader('authorization', 'must-not-be-observed');

  assert.deepEqual(
    observed,
    ['2681910', '7311458'],
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

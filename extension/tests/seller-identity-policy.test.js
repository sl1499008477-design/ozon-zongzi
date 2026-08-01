const assert = require('node:assert/strict');
const {
  resolveTrustedSellerCompanyContext,
  resolveTrustedSellerCompanyId,
  isTrustedSellerTab,
  resolveSellerMessageIdentity,
} = require('../lib/seller-identity-policy.js');
assert.equal(isTrustedSellerTab({ url: 'https://seller.ozon.ru/app/dashboard/main' }), true);
assert.equal(isTrustedSellerTab({ url: 'https://www.ozon.ru/product/1' }), false);
assert.equal(resolveTrustedSellerCompanyId([{ name: 'sc_company_id', value: '1234', domain: 'seller.ozon.ru' }]), '1234');
assert.equal(resolveTrustedSellerCompanyId([{ name: 'sc_company_id', value: '5678', domain: '.ozon.ru' }]), '5678');
assert.throws(() => resolveTrustedSellerCompanyId([{ name: 'sc_company_id', value: '1234', domain: 'seller.ozon.ru' }, { name: 'sc_company_id', value: '5678', domain: 'seller.ozon.ru' }]));
assert.throws(() => resolveTrustedSellerCompanyId([{ name: 'sc_company_id', value: '1234', domain: 'evil.example' }]));

const now = 1_800_000_000_000;
const sellerTabs = [
  { id: 7, url: 'https://seller.ozon.ru/app/dashboard/main', active: true },
];
assert.deepEqual(
  resolveTrustedSellerCompanyContext({
    cookies: [{ name: 'sc_company_id', value: '1234', domain: 'seller.ozon.ru' }],
    observations: [],
    sellerTabs,
    now,
  }),
  { companyId: '1234', sellerTabId: 7, source: 'cookie' },
);
assert.deepEqual(
  resolveTrustedSellerCompanyContext({
    cookies: [],
    observations: [{ tabId: 7, companyId: '2681910', observedAt: now - 1_000 }],
    sellerTabs,
    now,
  }),
  { companyId: '2681910', sellerTabId: 7, source: 'observed' },
);
assert.deepEqual(
  resolveTrustedSellerCompanyContext({
    cookies: [{ name: 'sc_company_id', value: '2681910', domain: 'seller.ozon.ru' }],
    observations: [{ tabId: 7, companyId: '2681910', observedAt: now - 1_000 }],
    sellerTabs,
    now,
  }),
  { companyId: '2681910', sellerTabId: 7, source: 'cookie+observed' },
);
assert.throws(
  () => resolveTrustedSellerCompanyContext({
    cookies: [{ name: 'sc_company_id', value: '1234', domain: 'seller.ozon.ru' }],
    observations: [{ tabId: 7, companyId: '2681910', observedAt: now - 1_000 }],
    sellerTabs,
    now,
  }),
  /SELLER_COMPANY_CONTEXT_CONFLICT/,
);
assert.throws(
  () => resolveTrustedSellerCompanyContext({
    cookies: [],
    observations: [
      { tabId: 7, companyId: '2681910', observedAt: now - 1_000 },
      { tabId: 8, companyId: '7311458', observedAt: now - 1_000 },
    ],
    sellerTabs: [
      ...sellerTabs,
      { id: 8, url: 'https://seller.ozon.ru/app/products', active: false },
    ],
    now,
  }),
  /SELLER_COMPANY_CONTEXT_CONFLICT/,
);
assert.throws(
  () => resolveTrustedSellerCompanyContext({
    cookies: [],
    observations: [{ tabId: 7, companyId: '2681910', observedAt: now - 600_001 }],
    sellerTabs,
    now,
    ttlMs: 600_000,
  }),
  /SELLER_COMPANY_CONTEXT_REQUIRED/,
);
assert.throws(
  () => resolveTrustedSellerCompanyContext({
    cookies: [],
    observations: [{ tabId: 99, companyId: '2681910', observedAt: now - 1_000 }],
    sellerTabs: [{ id: 99, url: 'https://evil.example/app', active: true }],
    now,
  }),
  /SELLER_CONTEXT_REQUIRED/,
);
;(async () => {
  const cookies = [{ name: 'sc_company_id', value: '1234', domain: 'seller.ozon.ru' }, { name: 'session', value: 'safe', domain: 'seller.ozon.ru' }];
  const trusted = await resolveSellerMessageIdentity({
    findSellerTabs: async () => [{ id: 7, url: 'https://seller.ozon.ru/app/dashboard/main', active: true }],
    getCookies: async () => cookies,
  });
  assert.equal(trusted.companyId, '1234');
  assert.equal(trusted.cookies.length, 2);
  const observed = await resolveSellerMessageIdentity({
    findSellerTabs: async () => sellerTabs,
    getCookies: async (details) => details?.name === 'sc_company_id' ? [] : cookies.filter((cookie) => cookie.name !== 'sc_company_id'),
    getObservedContexts: async () => [
      { tabId: 7, companyId: '2681910', observedAt: now - 1_000 },
    ],
    now: () => now,
  });
  assert.equal(observed.companyId, '2681910');
  assert.equal(observed.source, 'observed');
  await assert.rejects(() => resolveSellerMessageIdentity({ findSellerTabs: async () => [], getCookies: async () => cookies }), /SELLER_CONTEXT_REQUIRED/);
  await assert.rejects(() => resolveSellerMessageIdentity({ findSellerTabs: async () => [{ id: 7, url: 'https://seller.ozon.ru/' }], getCookies: async () => [{ name: 'sc_company_id', value: '9999', domain: 'evil.example' }] }), /sc_company_id/);
  console.log('seller message route policy tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
console.log('seller identity policy tests passed');

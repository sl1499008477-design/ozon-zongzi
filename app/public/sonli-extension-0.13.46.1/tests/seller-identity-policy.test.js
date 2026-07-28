const assert = require('node:assert/strict');
const { resolveTrustedSellerCompanyId, isTrustedSellerTab, resolveSellerMessageIdentity } = require('../lib/seller-identity-policy.js');
assert.equal(isTrustedSellerTab({ url: 'https://seller.ozon.ru/app/dashboard/main' }), true);
assert.equal(isTrustedSellerTab({ url: 'https://www.ozon.ru/product/1' }), false);
assert.equal(resolveTrustedSellerCompanyId([{ name: 'sc_company_id', value: '1234', domain: 'seller.ozon.ru' }]), '1234');
assert.throws(() => resolveTrustedSellerCompanyId([{ name: 'sc_company_id', value: '1234', domain: 'seller.ozon.ru' }, { name: 'sc_company_id', value: '5678', domain: 'seller.ozon.ru' }]));
assert.throws(() => resolveTrustedSellerCompanyId([{ name: 'sc_company_id', value: '1234', domain: 'evil.example' }]));
;(async () => {
  const cookies = [{ name: 'sc_company_id', value: '1234', domain: 'seller.ozon.ru' }, { name: 'session', value: 'safe', domain: 'seller.ozon.ru' }];
  const trusted = await resolveSellerMessageIdentity({
    findSellerTabs: async () => [{ id: 7, url: 'https://seller.ozon.ru/app/dashboard/main', active: true }],
    getCookies: async () => cookies,
  });
  assert.equal(trusted.companyId, '1234');
  assert.equal(trusted.cookies.length, 2);
  await assert.rejects(() => resolveSellerMessageIdentity({ findSellerTabs: async () => [], getCookies: async () => cookies }), /SELLER_CONTEXT_REQUIRED/);
  await assert.rejects(() => resolveSellerMessageIdentity({ findSellerTabs: async () => [{ id: 7, url: 'https://seller.ozon.ru/' }], getCookies: async () => [{ name: 'sc_company_id', value: '9999', domain: 'evil.example' }] }), /sc_company_id/);
  console.log('seller message route policy tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
console.log('seller identity policy tests passed');

const assert = require('node:assert/strict');
const policy = require('../lib/seller-identity-policy.js');
const {
  createSellerCompanyContextRuntime,
} = require('../lib/seller-company-context-runtime.js');

const sessionState = {};
const sellerTabs = [
  { id: 7, url: 'https://seller.ozon.ru/app/settings/performance-api', active: true },
];
const chromeApi = {
  cookies: {
    getAll: async () => [],
  },
  storage: {
    session: {
      get: async (keys) => Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys])
          .filter((key) => Object.prototype.hasOwnProperty.call(sessionState, key))
          .map((key) => [key, sessionState[key]]),
      ),
      set: async (values) => Object.assign(sessionState, values),
    },
  },
  tabs: {
    query: async () => sellerTabs,
  },
};
const now = 1_800_000_000_000;
const runtime = createSellerCompanyContextRuntime({
  chromeApi,
  policy,
  now: () => now,
});

(async () => {
  await assert.rejects(
    () => runtime.rememberFromSender(
      { tab: { id: 99, url: 'https://evil.example/app' } },
      '2681910',
    ),
    /SELLER_CONTEXT_REQUIRED/,
  );
  await assert.rejects(
    () => runtime.rememberFromSender(
      { tab: sellerTabs[0] },
      'invalid',
    ),
    /SELLER_COMPANY_CONTEXT_INVALID/,
  );

  await runtime.rememberFromSender({ tab: sellerTabs[0] }, '2681910');
  assert.deepEqual(await runtime.resolveCurrent(), {
    companyId: '2681910',
    sellerTabId: 7,
    source: 'observed',
  });
  assert.deepEqual(
    sessionState['sonliSellerCompanyContext:7'],
    { companyId: '2681910', observedAt: now },
  );

  console.log('seller company context runtime tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

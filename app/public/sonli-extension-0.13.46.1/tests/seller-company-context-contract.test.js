const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
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

const createRecoveryHarness = ({
  tabs = sellerTabs,
  cookies = [],
  observeAfterSleep = true,
} = {}) => {
  const recoveryState = {};
  const reloadCalls = [];
  let currentTime = now;
  let sleepCalls = 0;
  const recoveryChromeApi = {
    cookies: {
      getAll: async () => cookies,
    },
    storage: {
      session: {
        get: async (keys) => Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys])
            .filter((key) => Object.prototype.hasOwnProperty.call(recoveryState, key))
            .map((key) => [key, recoveryState[key]]),
        ),
        set: async (values) => Object.assign(recoveryState, values),
      },
    },
    tabs: {
      query: async () => tabs,
      reload: async (tabId) => {
        reloadCalls.push(tabId);
      },
    },
  };
  const sleep = async (milliseconds) => {
    sleepCalls += 1;
    currentTime += milliseconds;
    if (observeAfterSleep && sleepCalls === 1 && tabs[0]) {
      recoveryState[`sonliSellerCompanyContext:${tabs[0].id}`] = {
        companyId: '2681910',
        observedAt: currentTime,
      };
    }
  };
  return {
    reloadCalls,
    runtime: createSellerCompanyContextRuntime({
      chromeApi: recoveryChromeApi,
      policy,
      now: () => currentTime,
      sleep,
    }),
  };
};

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

  const successfulRecovery = createRecoveryHarness();
  assert.equal(
    typeof successfulRecovery.runtime.resolveCurrentWithRecovery,
    'function',
    'runtime must expose resolveCurrentWithRecovery',
  );
  const [firstResolution, secondResolution] = await Promise.all([
    successfulRecovery.runtime.resolveCurrentWithRecovery({ timeoutMs: 2_000, pollIntervalMs: 10 }),
    successfulRecovery.runtime.resolveCurrentWithRecovery({ timeoutMs: 2_000, pollIntervalMs: 10 }),
  ]);
  assert.deepEqual(firstResolution, {
    companyId: '2681910',
    sellerTabId: 7,
    source: 'observed',
  });
  assert.deepEqual(secondResolution, firstResolution);
  assert.deepEqual(successfulRecovery.reloadCalls, [7]);

  const missingSeller = createRecoveryHarness({ tabs: [] });
  await assert.rejects(
    () => missingSeller.runtime.resolveCurrentWithRecovery({ timeoutMs: 20, pollIntervalMs: 10 }),
    /SELLER_CONTEXT_REQUIRED/,
  );
  assert.deepEqual(missingSeller.reloadCalls, []);

  const conflictingContext = createRecoveryHarness({
    cookies: [{ name: 'sc_company_id', value: '1234', domain: 'seller.ozon.ru' }],
  });
  await conflictingContext.runtime.rememberFromSender({ tab: sellerTabs[0] }, '2681910');
  await assert.rejects(
    () => conflictingContext.runtime.resolveCurrentWithRecovery({ timeoutMs: 20, pollIntervalMs: 10 }),
    /SELLER_COMPANY_CONTEXT_CONFLICT/,
  );
  assert.deepEqual(conflictingContext.reloadCalls, []);

  const timedOutRecovery = createRecoveryHarness({ observeAfterSleep: false });
  await assert.rejects(
    () => timedOutRecovery.runtime.resolveCurrentWithRecovery({ timeoutMs: 20, pollIntervalMs: 10 }),
    /SELLER_CONTEXT_RECOVERY_FAILED/,
  );
  await assert.rejects(
    () => timedOutRecovery.runtime.resolveCurrentWithRecovery({ timeoutMs: 20, pollIntervalMs: 10 }),
    /SELLER_CONTEXT_RECOVERY_FAILED/,
  );
  assert.deepEqual(timedOutRecovery.reloadCalls, [7]);

  const serviceWorkerSource = readFileSync(
    path.join(__dirname, '../background/service-worker.js'),
    'utf8',
  );
  assert.match(
    serviceWorkerSource,
    /canCapture:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?sellerCompanyContextRuntime\.resolveCurrentWithRecovery\(\)/,
    'Ozon capture availability must recover a stale Seller context',
  );
  assert.match(
    serviceWorkerSource,
    /const getSellerCompanyIdCandidates[\s\S]*?sellerCompanyContextRuntime\.resolveCurrentWithRecovery\(\)/,
    'Seller product lookup must recover a stale Seller context',
  );
  assert.match(
    serviceWorkerSource,
    /SELLER_CONTEXT_RECOVERY_FAILED/,
    'Seller recovery timeout must keep a stable error code',
  );

  console.log('seller company context runtime tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

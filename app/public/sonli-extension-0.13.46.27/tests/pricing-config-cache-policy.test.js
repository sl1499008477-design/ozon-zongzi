const assert = require('node:assert/strict');
const { createPricingConfigCache } = require('../lib/pricing-config-cache.js');

;(async () => {
const storage = new Map();
const cache = createPricingConfigCache({
  ttlMs: 1000,
  now: () => 10_000,
  read: async (key) => storage.get(key),
  write: async (key, value) => storage.set(key, value),
});
const scope = { backendOrigin: 'https://api.example.test', accountId: 'account-a', storeId: 'store-a' };
await cache.put(scope, { id: 'config-a' });
assert.deepEqual(await cache.get(scope), { id: 'config-a' });
assert.equal(await cache.get({ ...scope, backendOrigin: 'https://other.example.test' }), null);
assert.equal(await cache.get({ ...scope, accountId: 'account-b' }), null);
assert.equal(await cache.get({ ...scope, storeId: 'store-b' }), null);
assert.equal(await cache.get({ ...scope, storeId: '' }), null);
const expired = createPricingConfigCache({ ttlMs: 1, now: () => 20_000, read: async (key) => storage.get(key), write: async () => {} });
assert.equal(await expired.get(scope), null);
await assert.rejects(
  () => cache.load({ ...scope, storeId: 'store-missing' }, async () => { throw new Error('offline'); }),
  /PRICING_CONFIG_UNAVAILABLE/,
);
assert.deepEqual(await cache.load(scope, async () => ({ id: 'config-fresh' })), { id: 'config-fresh' });
console.log('pricing config cache policy tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

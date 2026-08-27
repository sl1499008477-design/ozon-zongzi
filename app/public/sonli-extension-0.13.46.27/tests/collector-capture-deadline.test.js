const assert = require('node:assert/strict');
const {
  portalRequestOptions,
} = require('../lib/collector-capture-deadline.js');

const now = 1_800_000_000_000;

assert.deepEqual(portalRequestOptions({ now }), {
  timeoutMs: 30000,
  allowOzonTab: true,
  singleStrategy: false,
});

assert.deepEqual(portalRequestOptions({
  deadlineAt: now + 20_000,
  now,
}), {
  timeoutMs: 6000,
  allowOzonTab: false,
  singleStrategy: true,
});

assert.deepEqual(portalRequestOptions({
  deadlineAt: now + 4_500,
  now,
}), {
  timeoutMs: 3000,
  allowOzonTab: false,
  singleStrategy: true,
});

assert.throws(
  () => portalRequestOptions({ deadlineAt: now + 1_500, now }),
  (error) => error?.code === 'OZON_ENRICH_UPSTREAM_FAILED',
);

console.log('collector capture deadline tests passed');

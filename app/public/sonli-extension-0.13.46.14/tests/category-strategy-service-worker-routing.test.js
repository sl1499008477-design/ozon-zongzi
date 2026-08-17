const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const worker = fs.readFileSync(
  path.join(__dirname, '../background/service-worker.js'),
  'utf8',
);
const sharedUtils = fs.readFileSync(
  path.join(__dirname, '../content/shared-utils.js'),
  'utf8',
);

const observation = worker.indexOf(
  "const sellerContextObservation = message?.action === 'sellerCompanyContextObserved'",
);
const handler = worker.indexOf('const handle = async () => {', observation);
const categorySwitch = worker.indexOf('switch (message?.action) {', handler);
const categoryReadiness = worker.indexOf("case 'CATEGORY_STRATEGY_READINESS':", categorySwitch);
const collectorAuth = worker.indexOf(
  'await collectorSessionManager.beginCollectorOperation()',
  categoryReadiness,
);
const getAuth = worker.indexOf("case 'getAuth':", categoryReadiness);
const getCollectorAuthStatus = worker.indexOf("case 'getCollectorAuthStatus':", getAuth);

assert.notEqual(observation, -1);
assert.notEqual(handler, -1);
assert.notEqual(categorySwitch, -1);
assert.notEqual(categoryReadiness, -1);
assert.notEqual(collectorAuth, -1);
assert.notEqual(getAuth, -1);
assert.notEqual(getCollectorAuthStatus, -1);

const readinessRoute = worker.slice(categoryReadiness, collectorAuth);
assert.match(readinessRoute, /categoryStrategySamplingClient\.ready\(\)/);
assert.doesNotMatch(readinessRoute, /beginCollectorOperation\(\)/);

const getAuthRoute = worker.slice(getAuth, getCollectorAuthStatus);
assert.match(worker.slice(collectorAuth, getAuth), /getBackendUrl\(\)/);
assert.match(getAuthRoute, /authenticated: Boolean\(collectorSession\)/);

const pageCapture = worker.slice(
  worker.indexOf('const captureCategoryStrategyPage = async'),
  worker.indexOf('const captureCategoryStrategyCard = async'),
);
assert.match(pageCapture, /categoryStrategySha256Hex\(\{[\s\S]*kind: 'OZON_CATEGORY_PAGE_V1',[\s\S]*sourceUrl/);
assert.doesNotMatch(pageCapture, /captureCategoryStrategyPayload/);

const cardCapture = worker.slice(
  worker.indexOf('const captureCategoryStrategyCard = async'),
  worker.indexOf('\n\n  function apiPathForLog', worker.indexOf('const captureCategoryStrategyCard = async')),
);
assert.match(cardCapture, /expectedBuyerCategoryId/);
assert.ok(cardCapture.includes('const buyerCategoryMatch = /-([1-9][0-9]*)\\/$/.exec'));
assert.match(cardCapture, /productScope: captured\.scope \|\| pageFact\.pageScope/);

assert.match(
  worker,
  /const CATEGORY_STRATEGY_LONG_ACTIONS = new Set\(\['CATEGORY_STRATEGY_SAMPLES_CONFIRM'\]\)/,
);
assert.match(
  worker,
  /CATEGORY_STRATEGY_LONG_ACTIONS\.has\(message\?\.action\)[\s\S]*?\? 150_000/,
);
assert.match(
  worker,
  /KEEP_ALIVE_ACTIONS\.has\(message\?\.action\)[\s\S]*?CATEGORY_STRATEGY_LONG_ACTIONS\.has\(message\?\.action\)/,
);
assert.match(
  sharedUtils,
  /const LONG_ACTIONS = \[[^\]]*'CATEGORY_STRATEGY_SAMPLES_CONFIRM'[^\]]*\]/,
);

console.log('category strategy service-worker routing tests passed');

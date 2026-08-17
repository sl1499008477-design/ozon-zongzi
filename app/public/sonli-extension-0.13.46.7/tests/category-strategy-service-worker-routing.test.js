const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const worker = fs.readFileSync(
  path.join(__dirname, '../background/service-worker.js'),
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

console.log('category strategy service-worker routing tests passed');

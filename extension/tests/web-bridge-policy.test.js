const assert = require('node:assert/strict');
const {
  COLLECTOR_AUTH_PROTOCOL,
  createCollectorAuthRequest,
  isTrustedWebBridgeSender,
  normalizeCollectorAuthResponse,
} = require('../lib/web-bridge-policy.js');
const fs = require('node:fs');
const syncAuthSource = fs.readFileSync('extension/content/sync-auth.js', 'utf8');

assert.deepEqual(createCollectorAuthRequest('request-1'), {
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.request',
  requestId: 'request-1',
});
assert.deepEqual(normalizeCollectorAuthResponse({
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId: 'request-1',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
  token: 'web-bearer',
  storeId: 'store-1',
}, 'request-1'), {
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId: 'request-1',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
});
assert.equal(normalizeCollectorAuthResponse({
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId: 'wrong-request',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
}, 'request-1'), null);
assert.equal(isTrustedWebBridgeSender({ url: 'http://127.0.0.1:3000/' }), true);
assert.equal(isTrustedWebBridgeSender({ url: 'http://127.0.0.1:3001/' }), false);
assert.equal(isTrustedWebBridgeSender({ url: 'http://localhost:3000/' }), true);
assert.equal(isTrustedWebBridgeSender({ url: 'https://qh.jizhangerp.com/' }), true);
assert.equal(isTrustedWebBridgeSender({ url: 'https://evil.qh.jizhangerp.com.evil/' }), false);
assert.equal(isTrustedWebBridgeSender({ url: 'https://evil.example/' }), false);
assert.doesNotMatch(syncAuthSource, /syncAuthFromWeb|SONLI_WEB_CONTROL|localStorage\.getItem\(['"]token['"]\)/);
assert.match(syncAuthSource, /window\.location\.origin/);
assert.doesNotMatch(syncAuthSource, /postMessage\([^)]*,\s*['"]\*['"]\s*\)/s);
assert.match(syncAuthSource, /normalizeCollectorAuthResponse/);
assert.match(syncAuthSource, /MAX_TICKET_EXCHANGE_ATTEMPTS\s*=\s*2/);
const workerSource = fs.readFileSync('extension/background/service-worker.js', 'utf8');
assert.doesNotMatch(workerSource, /case ['"]syncAuthFromWeb['"]|case ['"]tryWebSync['"]/);
assert.match(workerSource, /collector\.auth\.exchange/);
assert.match(workerSource, /'\.\.\/lib\/collector-session\.js'/);
assert.doesNotMatch(workerSource, /STORAGE_KEYS\.(?:token|storeId)/);
assert.match(workerSource, /collectorSessionManager\.collectorFetch\(entry\.path/);
assert.match(workerSource, /collectorSessionManager\.beginCollectorOperation\(\)/);
assert.match(workerSource, /collectorOperation/);
assert.match(workerSource, /permission: 'collector\.upload'/);
assert.match(workerSource, /collectorSessionManager\.enqueueRetryablePendingUpload\(/);
assert.match(workerSource, /JzCollectorSession\.withoutCollectorScope\(raw\)/);
assert.match(
  workerSource,
  /enqueueRetryablePendingUpload\(\s*pendingUpload,\s*response\.status,\s*collectorOperation,?\s*\)/,
);
assert.doesNotMatch(
  workerSource,
  /function clearWebAuthTabs|localStorage\.(?:getItem|setItem|removeItem)\(\s*['"](?:token|user|currentOzonStoreId|ozonStoreId)['"]\)/,
);
const sharedUtilsSource = fs.readFileSync('extension/content/shared-utils.js', 'utf8');
assert.doesNotMatch(sharedUtilsSource, /ozonAuthToken|ozonStoreId/);
assert.match(sharedUtilsSource, /loggedIn: Boolean\(authenticated\)/);
console.log('web bridge policy tests passed');

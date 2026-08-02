const assert = require('node:assert/strict');
const {
  COLLECTOR_AUTH_PROTOCOL,
  createCollectorAuthRequest,
  isTrustedWebBridgeSender,
  normalizeCollectorAuthLogout,
  normalizeCollectorAuthReady,
  normalizeCollectorAuthResponse,
} = require('../lib/web-bridge-policy.js');
const fs = require('node:fs');
const syncAuthSource = fs.readFileSync('extension/content/sync-auth.js', 'utf8');
const collectorAuthFlowSource = fs.readFileSync('extension/lib/collector-auth-flow.js', 'utf8');

assert.deepEqual(createCollectorAuthRequest('request-1'), {
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.request',
  requestId: 'request-1',
});
assert.deepEqual(normalizeCollectorAuthReady({
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.ready',
  generationId: 'generation_A_1234',
}), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.ready',
  generationId: 'generation_A_1234',
});
assert.deepEqual(normalizeCollectorAuthLogout({
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.logout',
  generationId: 'generation_A_1234',
}), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.logout',
  generationId: 'generation_A_1234',
});
assert.deepEqual(normalizeCollectorAuthReady(Object.assign(Object.create(null), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.ready',
  generationId: 'generation_A_1234',
})), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.ready',
  generationId: 'generation_A_1234',
});
for (const unsafe of [
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready', generationId: 'generation_A_1234', token: 'never' },
  { protocol: 'OTHER', action: 'collector.auth.ready', generationId: 'generation_A_1234' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.response', generationId: 'generation_A_1234' },
  Object.assign(Object.create({ inherited: true }), {
    protocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.ready',
    generationId: 'generation_A_1234',
  }),
]) assert.equal(normalizeCollectorAuthReady(unsafe), null);
for (const unsafe of [
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.logout' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.logout', generationId: 'generation/A/1234' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.logout', generationId: 'generation_A_1234', accountId: 'never' },
  ['SONLI_COLLECTOR_AUTH', 'collector.auth.logout', 'generation_A_1234'],
]) assert.equal(normalizeCollectorAuthLogout(unsafe), null);
assert.deepEqual(normalizeCollectorAuthResponse({
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId: 'request-1',
  generationId: 'generation_A_1234',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
}, 'request-1'), {
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId: 'request-1',
  generationId: 'generation_A_1234',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
});
assert.equal(normalizeCollectorAuthResponse({
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId: 'wrong-request',
  generationId: 'generation_A_1234',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
}, 'request-1'), null);
for (const extra of ['token', 'storeId', 'accountId']) {
  assert.equal(normalizeCollectorAuthResponse({
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: 'collector.auth.response',
    requestId: 'request-1',
    generationId: 'generation_A_1234',
    ticket: 'ctt_ticket_secret_123456789',
    expiresAt: '2030-01-01T00:01:00.000Z',
    [extra]: 'never',
  }, 'request-1'), null);
}
assert.equal(normalizeCollectorAuthResponse(Object.assign(
  Object.create({ inherited: true }),
  {
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: 'collector.auth.response',
    requestId: 'request-1',
    generationId: 'generation_A_1234',
    ticket: 'ctt_ticket_secret_123456789',
    expiresAt: '2030-01-01T00:01:00.000Z',
  },
), 'request-1'), null);
assert.equal(normalizeCollectorAuthResponse({
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId: 123,
  generationId: 'generation_A_1234',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
}, '123'), null);
const responseWithHiddenAccount = {
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId: 'request-1',
  generationId: 'generation_A_1234',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
};
Object.defineProperty(responseWithHiddenAccount, 'accountId', { value: 'never' });
assert.equal(normalizeCollectorAuthResponse(responseWithHiddenAccount, 'request-1'), null);
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
assert.doesNotMatch(syncAuthSource, /passiveReadyConsumed|MAX_BRIDGE_REQUESTS|exchangeInFlight/);
assert.match(collectorAuthFlowSource, /MAX_TICKET_EXCHANGE_ATTEMPTS\s*=\s*2/);
assert.match(collectorAuthFlowSource, /MAX_BRIDGE_REQUESTS\s*=\s*10/);
assert.match(collectorAuthFlowSource, /BRIDGE_RETRY_MS\s*=\s*1000/);
const workerSource = fs.readFileSync('extension/background/service-worker.js', 'utf8');
assert.doesNotMatch(workerSource, /case ['"]syncAuthFromWeb['"]|case ['"]tryWebSync['"]/);
assert.match(workerSource, /collector\.auth\.exchange/);
assert.match(workerSource, /'\.\.\/lib\/collector-session\.js'/);
assert.doesNotMatch(workerSource, /STORAGE_KEYS\.(?:token|storeId)/);
assert.match(workerSource, /JzCollectorClient\.upload\(/);
assert.match(workerSource, /collectorSessionManager\.beginCollectorOperation\(\)/);
assert.match(workerSource, /collectorOperation/);
assert.match(workerSource, /clearCollectorSession\(\s*collectorOperation\s*\)/);
const collectorClientSource = fs.readFileSync('extension/background/collector-client.js', 'utf8');
assert.match(collectorClientSource, /permission|collector\.upload/);
assert.match(collectorClientSource, /enqueueRetryablePendingUpload\(/);
assert.match(collectorClientSource, /JzCollectorSession\.withoutCollectorScope\(safeRaw\)/);
assert.doesNotMatch(
  workerSource,
  /function clearWebAuthTabs|localStorage\.(?:getItem|setItem|removeItem)\(\s*['"](?:token|user|currentOzonStoreId|ozonStoreId)['"]\)/,
);
const sharedUtilsSource = fs.readFileSync('extension/content/shared-utils.js', 'utf8');
assert.doesNotMatch(sharedUtilsSource, /ozonAuthToken|ozonStoreId/);
assert.match(sharedUtilsSource, /loggedIn: Boolean\(authenticated\)/);
console.log('web bridge policy tests passed');

const assert = require('node:assert/strict');
const {
  COLLECTOR_AUTH_PROTOCOL,
  createCollectorAuthRequest,
  isTrustedWebBridgeSender,
  normalizeCollectorAuthAccepted,
  normalizeCollectorAuthFailure,
  normalizeCollectorAuthLogout,
  normalizeCollectorAuthReady,
  normalizeCollectorAuthReadyV2,
  normalizeCollectorAuthResponse,
} = require('../lib/web-bridge-policy.js');
const fs = require('node:fs');
const syncAuthSource = fs.readFileSync('extension/content/sync-auth.js', 'utf8');

assert.deepEqual(createCollectorAuthRequest('collector-attempt-1'), {
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.request',
  requestId: 'collector-attempt-1',
});
for (const unsafe of ['', ' request-1 ', 'request-without-prefix', 'collector-invalid_id', 'r'.repeat(129)]) {
  assert.throws(() => createCollectorAuthRequest(unsafe));
}
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
assert.deepEqual(normalizeCollectorAuthReadyV2({
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.ready.v2',
  generationId: 'generation_A_1234',
  accountId: 'account-a',
}), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.ready.v2',
  generationId: 'generation_A_1234',
  accountIdHint: 'account-a',
});
assert.deepEqual(normalizeCollectorAuthReadyV2(Object.assign(Object.create(null), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.ready.v2',
  generationId: 'generation_A_1234',
  accountId: 'account-a',
})), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.ready.v2',
  generationId: 'generation_A_1234',
  accountIdHint: 'account-a',
});
for (const unsafe of [
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready.v2', generationId: 'generation_A_1234' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready.v2', generationId: 'generation_A_1234', accountId: '' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready.v2', generationId: 'generation_A_1234', accountId: ' account-a ' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready.v2', generationId: 'generation_A_1234', accountId: 'a'.repeat(129) },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready.v2', generationId: 'generation_A_1234', accountId: 'account-a', ticket: 'never' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready.v2', generationId: 'generation_A_1234', accountId: 'account-a', token: 'never' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready', generationId: 'generation_A_1234', accountId: 'account-a' },
  Object.assign(Object.create({ inherited: true }), {
    protocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.ready.v2',
    generationId: 'generation_A_1234',
    accountId: 'account-a',
  }),
]) assert.equal(normalizeCollectorAuthReadyV2(unsafe), null);
assert.deepEqual(normalizeCollectorAuthAccepted({
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.accepted',
  requestId: 'collector-attempt-1',
  generationId: 'generation_A_1234',
}, 'collector-attempt-1'), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.accepted',
  requestId: 'collector-attempt-1',
  generationId: 'generation_A_1234',
});
assert.deepEqual(normalizeCollectorAuthAccepted(Object.assign(Object.create(null), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.accepted',
  requestId: 'collector-attempt-1',
  generationId: 'generation_A_1234',
}), 'collector-attempt-1'), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.accepted',
  requestId: 'collector-attempt-1',
  generationId: 'generation_A_1234',
});
for (const unsafe of [
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.accepted', requestId: 'wrong-request', generationId: 'generation_A_1234' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.accepted', requestId: ' request-1 ', generationId: 'generation_A_1234' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.accepted', requestId: 'request-without-prefix', generationId: 'generation_A_1234' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.accepted', requestId: 'r'.repeat(129), generationId: 'generation_A_1234' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.accepted', requestId: 'collector-attempt-1', generationId: 'too-short' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.accepted', requestId: 'collector-attempt-1', generationId: 'generation_A_1234', ticket: 'never' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.accepted', requestId: 'collector-attempt-1', generationId: 'generation_A_1234', token: 'never' },
  Object.assign(Object.create({ inherited: true }), {
    protocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.accepted',
    requestId: 'collector-attempt-1',
    generationId: 'generation_A_1234',
  }),
]) assert.equal(normalizeCollectorAuthAccepted(unsafe, 'collector-attempt-1'), null);
assert.deepEqual(normalizeCollectorAuthFailure({
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.failure',
  requestId: 'collector-attempt-1',
  generationId: 'generation_A_1234',
  publicCode: 'WEB_LOGIN_REQUIRED',
}, 'collector-attempt-1'), {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.failure',
  requestId: 'collector-attempt-1',
  generationId: 'generation_A_1234',
  publicCode: 'WEB_LOGIN_REQUIRED',
});
for (const unsafe of [
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.failure', requestId: 'collector-attempt-1', generationId: 'generation_A_1234', publicCode: 'RAW_SERVER_ERROR' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.failure', requestId: 'wrong', generationId: 'generation_A_1234', publicCode: 'WEB_LOGIN_REQUIRED' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.failure', requestId: 'collector-attempt-1', generationId: 'generation_A_1234', publicCode: 'WEB_LOGIN_REQUIRED', error: 'never' },
  { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.failure', generationId: 'generation_A_1234', publicCode: 'WEB_LOGIN_REQUIRED' },
]) assert.equal(normalizeCollectorAuthFailure(unsafe, 'collector-attempt-1'), null);
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
  requestId: 'collector-attempt-1',
  generationId: 'generation_A_1234',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
}, 'collector-attempt-1'), {
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId: 'collector-attempt-1',
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
}, 'collector-attempt-1'), null);
assert.equal(normalizeCollectorAuthResponse({
  protocol: COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId: ' request-1 ',
  generationId: 'generation_A_1234',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
}, 'collector-attempt-1'), null);
for (const extra of ['token', 'storeId', 'accountId']) {
  assert.equal(normalizeCollectorAuthResponse({
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: 'collector.auth.response',
    requestId: 'collector-attempt-1',
    generationId: 'generation_A_1234',
    ticket: 'ctt_ticket_secret_123456789',
    expiresAt: '2030-01-01T00:01:00.000Z',
    [extra]: 'never',
  }, 'collector-attempt-1'), null);
}
assert.equal(normalizeCollectorAuthResponse(Object.assign(
  Object.create({ inherited: true }),
  {
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: 'collector.auth.response',
    requestId: 'collector-attempt-1',
    generationId: 'generation_A_1234',
    ticket: 'ctt_ticket_secret_123456789',
    expiresAt: '2030-01-01T00:01:00.000Z',
  },
), 'collector-attempt-1'), null);
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
  requestId: 'collector-attempt-1',
  generationId: 'generation_A_1234',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
};
Object.defineProperty(responseWithHiddenAccount, 'accountId', { value: 'never' });
assert.equal(normalizeCollectorAuthResponse(responseWithHiddenAccount, 'collector-attempt-1'), null);
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
assert.doesNotMatch(syncAuthSource, /collector\.auth\.release|createCollectorAuthRelease|releaseRequest/);
assert.doesNotMatch(syncAuthSource, /passiveReadyConsumed|MAX_BRIDGE_REQUESTS|exchangeInFlight/);
const workerSource = fs.readFileSync('extension/background/service-worker.js', 'utf8');
assert.doesNotMatch(workerSource, /case ['"]syncAuthFromWeb['"]|case ['"]tryWebSync['"]/);
assert.match(workerSource, /collector\.auth\.exchange/);
assert.match(workerSource, /'\.\.\/lib\/collector-session\.js'/);
assert.doesNotMatch(workerSource, /STORAGE_KEYS\.(?:token|storeId)/);
assert.match(workerSource, /JzCollectorClient\.upload\(/);
assert.match(workerSource, /collectorSessionManager\.beginCollectorOperation\(\)/);
assert.match(workerSource, /collectorOperation/);
assert.match(workerSource, /collectorSessionManager\.logoutCollectorSession\(\)/);
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

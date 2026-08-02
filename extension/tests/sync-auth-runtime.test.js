const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../lib/web-bridge-policy.js');

const source = fs.readFileSync('extension/content/sync-auth.js', 'utf8');
const windowListeners = new Map();
const runtimeListeners = [];
const timers = [];
const posts = [];
const exchanges = [];
let resolveExchange;

const windowObject = {
  location: { origin: 'http://127.0.0.1:3000' },
  addEventListener(type, listener) { windowListeners.set(type, listener); },
  postMessage(message, targetOrigin) { posts.push({ message, targetOrigin }); },
};

const sandbox = {
  globalThis: { JzWebBridgePolicy: policy },
  window: windowObject,
  crypto: { randomUUID: () => `request-${posts.length + 1}` },
  setTimeout(callback, milliseconds) {
    timers.push({ callback, milliseconds });
    return timers.length;
  },
  clearTimeout() {},
  chrome: {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        exchanges.push(message);
        resolveExchange = () => callback({ ok: true });
      },
      onMessage: {
        addListener(listener) { runtimeListeners.push(listener); },
      },
    },
  },
};

vm.runInNewContext(source, sandbox, { filename: 'sync-auth.js' });
vm.runInNewContext(source, sandbox, { filename: 'sync-auth-reinjected.js' });

(async () => {
assert.equal(posts.length, 1, 'reinjecting sync-auth must not post a second initial request');
assert.equal(timers.length, 1, 'reinjecting sync-auth must not schedule another retry timer');
assert.equal(runtimeListeners.length, 1, 'reinjecting sync-auth must not duplicate runtime listeners');
assert.equal(posts[0].targetOrigin, 'http://127.0.0.1:3000');
for (let requestCallback = 1; requestCallback <= 10; requestCallback += 1) {
  const retry = timers.shift();
  assert.equal(retry?.milliseconds, 1000);
  retry?.callback();
  assert.equal(posts.length, Math.min(requestCallback + 1, 10));
}

await windowListeners.get('message')({
  source: windowObject,
  origin: windowObject.location.origin,
  data: {
    protocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.ready',
  },
});
assert.equal(posts.length, 11, 'ready must start a fresh bounded request cycle');
assert.equal(posts.at(-1).message.action, 'collector.auth.request');
await windowListeners.get('message')({
  source: windowObject,
  origin: windowObject.location.origin,
  data: {
    protocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.ready',
  },
});
assert.equal(posts.length, 11, 'duplicate passive ready must not reset the bounded cycle');

for (const event of [
  {
    source: {},
    origin: windowObject.location.origin,
    data: { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready' },
  },
  {
    source: windowObject,
    origin: 'https://evil.example',
    data: { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready' },
  },
  {
    source: windowObject,
    origin: windowObject.location.origin,
    data: { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready', token: 'never' },
  },
]) {
  await windowListeners.get('message')(event);
  assert.equal(posts.length, 11);
}

const activeRequest = posts.at(-1).message;
const exchangePending = windowListeners.get('message')({
  source: windowObject,
  origin: windowObject.location.origin,
  data: {
    protocol: policy.COLLECTOR_AUTH_PROTOCOL,
    action: 'collector.auth.response',
    requestId: activeRequest.requestId,
    ticket: 'ctt_runtime_test_ticket_123456789',
    expiresAt: '2030-01-01T00:01:00.000Z',
  },
});

assert.equal(exchanges.length, 1);
assert.equal(exchanges[0].ticket, 'ctt_runtime_test_ticket_123456789');
await windowListeners.get('message')({
  source: windowObject,
  origin: windowObject.location.origin,
  data: { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready' },
});
assert.equal(posts.length, 11, 'ready must not restart while ticket exchange is in flight');
assert.equal(exchanges.length, 1, 'ready must not start another exchange while one is in flight');

resolveExchange();
await exchangePending;
await windowListeners.get('message')({
  source: windowObject,
  origin: windowObject.location.origin,
  data: { protocol: 'SONLI_COLLECTOR_AUTH', action: 'collector.auth.ready' },
});
assert.equal(posts.length, 11, 'ready must not restart after authentication succeeds');
assert.equal(exchanges.length, 1, 'ready must not exchange again after authentication succeeds');
for (const timer of timers.splice(0)) timer.callback();
assert.equal(posts.length, 11);

assert.equal(runtimeListeners.length, 1);
const response = {};
runtimeListeners[0]({ action: 'collector.auth.request' }, null, (value) => Object.assign(response, value));
assert.deepEqual(response, { ok: true, requested: true });
assert.equal(posts.length, 12, 'runtime recheck must recover after the prior Collector session expires');

const recoveryRequest = posts.at(-1).message;
const recoveryExchangePending = windowListeners.get('message')({
  source: windowObject,
  origin: windowObject.location.origin,
  data: {
    protocol: policy.COLLECTOR_AUTH_PROTOCOL,
    action: 'collector.auth.response',
    requestId: recoveryRequest.requestId,
    ticket: 'ctt_runtime_recovery_ticket_123456789',
    expiresAt: '2030-01-01T00:02:00.000Z',
  },
});
assert.equal(exchanges.length, 2);
assert.equal(exchanges[1].ticket, 'ctt_runtime_recovery_ticket_123456789');

const blockedRecovery = {};
runtimeListeners[0]({ action: 'collector.auth.request' }, null, (value) => Object.assign(blockedRecovery, value));
assert.deepEqual(blockedRecovery, { ok: true, requested: false });
assert.equal(posts.length, 12, 'runtime recheck must not overlap an exchange already in flight');

resolveExchange();
await recoveryExchangePending;

console.log('sync auth runtime tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

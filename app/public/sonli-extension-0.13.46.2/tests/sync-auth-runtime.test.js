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
        callback({ ok: true });
      },
      onMessage: {
        addListener(listener) { runtimeListeners.push(listener); },
      },
    },
  },
};

vm.runInNewContext(source, sandbox, { filename: 'sync-auth.js' });

(async () => {
assert.equal(posts.length, 1);
assert.equal(posts[0].targetOrigin, 'http://127.0.0.1:3000');
const firstRetry = timers.shift();
assert.equal(firstRetry.milliseconds, 1000);

firstRetry.callback();
assert.equal(posts.length, 2);
const secondRetry = timers.shift();
assert.equal(secondRetry?.milliseconds, 1000);

secondRetry?.callback();
assert.equal(posts.length, 3);

const activeRequest = posts.at(-1).message;
await windowListeners.get('message')({
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
for (const timer of timers.splice(0)) timer.callback();
assert.equal(posts.length, 3);

assert.equal(runtimeListeners.length, 1);
const response = {};
runtimeListeners[0]({ action: 'collector.auth.request' }, null, (value) => Object.assign(response, value));
assert.deepEqual(response, { ok: true, requested: true });
assert.equal(posts.length, 4);

console.log('sync auth runtime tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

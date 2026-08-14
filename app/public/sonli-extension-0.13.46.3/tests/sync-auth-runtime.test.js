const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../lib/web-bridge-policy.js');

const flowSource = fs.readFileSync('extension/lib/collector-auth-flow.js', 'utf8');
const syncAuthSource = fs.readFileSync('extension/content/sync-auth.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
const trustedWebScripts = manifest.content_scripts.find(({ js = [] }) => (
  js.includes('content/sync-auth.js')
))?.js || [];

assert.deepEqual(trustedWebScripts.slice(-2), [
  'lib/collector-auth-flow.js',
  'content/sync-auth.js',
]);

const G1 = 'generation_G1_1234';
const G2 = 'generation_G2_5678';
const G3 = 'generation_G3_9012';
const windowListeners = new Map();
const runtimeListeners = [];
const timers = [];
const posts = [];
const runtimeCalls = [];
let requestSequence = 0;
let activeExchanges = 0;
let maximumConcurrentExchanges = 0;

const windowObject = {
  location: { origin: 'http://127.0.0.1:3000' },
  addEventListener(type, listener) { windowListeners.set(type, listener); },
  postMessage(message, targetOrigin) { posts.push({ message, targetOrigin }); },
};

const sandbox = {
  globalThis: { JzWebBridgePolicy: policy },
  window: windowObject,
  crypto: { randomUUID: () => `request-${++requestSequence}` },
  setTimeout(callback, milliseconds) {
    const timer = { callback, milliseconds, cancelled: false };
    timers.push(timer);
    return timer;
  },
  clearTimeout(timer) {
    if (timer) timer.cancelled = true;
  },
  chrome: {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        const call = { message, callback, resolved: false };
        runtimeCalls.push(call);
        if (message.action === 'collector.auth.exchange') {
          activeExchanges += 1;
          maximumConcurrentExchanges = Math.max(maximumConcurrentExchanges, activeExchanges);
        }
      },
      onMessage: {
        addListener(listener) { runtimeListeners.push(listener); },
      },
    },
  },
};

const asLocalRecord = (value) => JSON.parse(JSON.stringify(value));
const messageEvent = (data, overrides = {}) => ({
  source: windowObject,
  origin: windowObject.location.origin,
  data,
  ...overrides,
});
const emit = (data, overrides) => windowListeners.get('message')(
  messageEvent(data, overrides),
);
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const findPendingRuntime = (action, generationId) => runtimeCalls.find((call) => (
  !call.resolved
  && call.message.action === action
  && (generationId === undefined || call.message.generationId === generationId)
));
const resolveRuntime = (action, generationId, result) => {
  const call = findPendingRuntime(action, generationId);
  assert.ok(call, `expected pending ${action} for ${generationId || 'any generation'}`);
  call.resolved = true;
  if (call.message.action === 'collector.auth.exchange') activeExchanges -= 1;
  call.callback(result);
  return call;
};
const ready = (generationId) => ({
  protocol: policy.COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.ready',
  generationId,
});
const logout = (generationId) => ({
  protocol: policy.COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.logout',
  generationId,
});
const response = (requestId, generationId, suffix) => ({
  protocol: policy.COLLECTOR_AUTH_PROTOCOL,
  action: 'collector.auth.response',
  requestId,
  generationId,
  ticket: `ctt_runtime_ticket_${suffix}`,
  expiresAt: `2030-01-01T00:0${suffix}:00.000Z`,
});

vm.runInNewContext(flowSource, sandbox, { filename: 'collector-auth-flow.js' });
vm.runInNewContext(syncAuthSource, sandbox, { filename: 'sync-auth.js' });
vm.runInNewContext(syncAuthSource, sandbox, { filename: 'sync-auth-reinjected.js' });

(async () => {
  assert.equal(posts.length, 1, 'installation starts exactly one discovery request');
  assert.equal(timers.length, 1, 'installation starts exactly one bounded retry timer');
  assert.equal(runtimeListeners.length, 1, 'reinjection does not duplicate runtime listeners');
  assert.equal(posts[0].targetOrigin, windowObject.location.origin);

  for (const malformed of [
    messageEvent(ready(G1), { source: {} }),
    messageEvent(ready(G1), { origin: 'https://evil.example' }),
    messageEvent({ ...ready(G1), token: 'never' }),
    messageEvent({ ...logout(G1), accountId: 'never' }),
    messageEvent({ ...response('request-1', G1, '1'), storeId: 'never' }),
  ]) {
    await windowListeners.get('message')(malformed);
  }
  assert.equal(runtimeCalls.length, 0);
  assert.equal(posts.length, 1);

  const g1Ready = emit(ready(G1));
  await tick();
  const beginG1 = findPendingRuntime('collector.auth.begin', G1);
  assert.deepEqual(asLocalRecord(beginG1.message), {
    portalProtocol: policy.COLLECTOR_AUTH_PROTOCOL,
    action: 'collector.auth.begin',
    generationId: G1,
  });
  resolveRuntime('collector.auth.begin', G1, { ok: true });
  await g1Ready;
  assert.equal(posts.length, 2);
  assert.equal(timers[0].cancelled, true, 'ready cancels discovery retry');
  const g1Request = posts.at(-1).message;

  await emit(ready(G1));
  assert.equal(runtimeCalls.length, 1, 'duplicate G1 does not begin twice');
  assert.equal(posts.length, 2, 'duplicate G1 does not restart its request cycle');

  const g1Exchange = emit(response(g1Request.requestId, G1, '1'));
  await tick();
  const exchangeG1 = findPendingRuntime('collector.auth.exchange', G1);
  assert.deepEqual(asLocalRecord(exchangeG1.message), {
    portalProtocol: policy.COLLECTOR_AUTH_PROTOCOL,
    action: 'collector.auth.exchange',
    requestId: g1Request.requestId,
    generationId: G1,
    ticket: 'ctt_runtime_ticket_1',
    expiresAt: '2030-01-01T00:01:00.000Z',
  });

  const g2Ready = emit(ready(G2));
  await tick();
  assert.ok(findPendingRuntime('collector.auth.begin', G2), 'G2 enters the background fence during G1 exchange');
  resolveRuntime('collector.auth.begin', G2, { ok: true });
  await g2Ready;
  assert.equal(posts.length, 2, 'G2 waits for the single in-flight exchange');
  assert.equal(runtimeCalls.filter(({ message }) => message.action === 'collector.auth.exchange').length, 1);

  resolveRuntime('collector.auth.exchange', G1, { ok: true });
  await g1Exchange;
  assert.equal(posts.length, 3, 'stale G1 success does not authenticate desired G2');
  const g2Request = posts.at(-1).message;

  const g2Exchange = emit(response(g2Request.requestId, G2, '2'));
  await tick();
  assert.equal(runtimeCalls.filter(({ message }) => message.action === 'collector.auth.exchange').length, 2);
  resolveRuntime('collector.auth.exchange', G2, { ok: true });
  await g2Exchange;

  const staleLogout = emit(logout(G1));
  await tick();
  const logoutG1 = findPendingRuntime('collector.auth.logout', G1);
  assert.deepEqual(asLocalRecord(logoutG1.message), {
    portalProtocol: policy.COLLECTOR_AUTH_PROTOCOL,
    action: 'collector.auth.logout',
    generationId: G1,
  });
  resolveRuntime('collector.auth.logout', G1, { ok: true, data: { cleared: false } });
  await staleLogout;
  await emit(ready(G2));
  assert.equal(posts.length, 3, 'stale G1 logout leaves authenticated G2 locally intact');

  const matchingLogout = emit(logout(G2));
  await tick();
  resolveRuntime('collector.auth.logout', G2, { ok: true, data: { cleared: true } });
  await matchingLogout;

  const g3Ready = emit(ready(G3));
  await tick();
  resolveRuntime('collector.auth.begin', G3, { ok: true });
  await g3Ready;
  assert.equal(posts.length, 4, 'G3 relogin is accepted without reloading the page');
  const g3Request = posts.at(-1).message;
  const g3Exchange = emit(response(g3Request.requestId, G3, '3'));
  await tick();
  resolveRuntime('collector.auth.exchange', G3, { ok: true });
  await g3Exchange;

  const authoritativeResponse = {};
  assert.equal(runtimeListeners[0](
    { action: 'collector.auth.request' },
    null,
    (value) => Object.assign(authoritativeResponse, value),
  ), false);
  assert.deepEqual(authoritativeResponse, { ok: true, requested: true });
  assert.equal(posts.length, 5, 'authoritative recovery discovers the current Web generation');

  const recoveryRequest = posts.at(-1).message;
  const recoveryExchange = emit(response(recoveryRequest.requestId, G1, '4'));
  await tick();
  const blockedResponse = {};
  runtimeListeners[0](
    { action: 'collector.auth.request' },
    null,
    (value) => Object.assign(blockedResponse, value),
  );
  assert.deepEqual(blockedResponse, { ok: true, requested: false });
  assert.ok(
    findPendingRuntime('collector.auth.begin', G1),
    'authoritative discovery begins the current Web G1 before exchange',
  );
  resolveRuntime('collector.auth.begin', G1, { ok: true });
  await tick();
  assert.ok(findPendingRuntime('collector.auth.exchange', G1));
  resolveRuntime('collector.auth.exchange', G1, { ok: true });
  await recoveryExchange;

  assert.equal(maximumConcurrentExchanges, 1, 'runtime adapter never overlaps ticket exchanges');
  assert.equal(runtimeCalls.every(({ message }) => (
    message.portalProtocol === policy.COLLECTOR_AUTH_PROTOCOL
  )), true);
  console.log('sync auth runtime tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

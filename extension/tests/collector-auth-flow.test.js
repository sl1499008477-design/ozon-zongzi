const assert = require('node:assert/strict');
const test = require('node:test');
const { createCollectorAuthFlow } = require('../lib/collector-auth-flow.js');

const G1 = 'generation_G1_1234';
const G2 = 'generation_G2_5678';
const R1 = 'collector-attempt-1';
const R2 = 'collector-attempt-2';

const deferred = () => {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
};

const response = (requestId, generationId, suffix = '1') => ({
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.response',
  requestId,
  generationId,
  ticket: `ctt_flow_ticket_${suffix}`,
  expiresAt: `2030-01-01T00:0${suffix}:00.000Z`,
});

function createHarness({ beginGeneration, exchangeTicket } = {}) {
  const begins = [];
  const clears = [];
  const exchanges = [];
  const failures = [];
  const requests = [];
  const flow = createCollectorAuthFlow({
    postRequest(requestId) { requests.push(requestId); },
    async beginGeneration(generationId, accountIdHint, requestId) {
      begins.push({ requestId, generationId, accountIdHint });
      return beginGeneration
        ? beginGeneration({ requestId, generationId, accountIdHint })
        : { ok: true };
    },
    async clearGeneration(generationId) {
      clears.push(generationId);
      return { ok: true };
    },
    async exchangeTicket(payload) {
      exchanges.push(payload);
      return exchangeTicket ? exchangeTicket(payload) : { ok: true };
    },
    async failAuthentication(payload) {
      failures.push(payload);
      return { ok: true };
    },
  });
  return { begins, clears, exchanges, failures, flow, requests };
}

test('flow requires only the single-request adapters', () => {
  assert.throws(() => createCollectorAuthFlow(), /function dependencies/);
  assert.doesNotThrow(() => createHarness());
});

test('authoritative request forwards and returns the exact worker request ID', () => {
  const harness = createHarness();
  assert.deepEqual(harness.flow.requestAuthoritatively(R1), {
    requested: true,
    requestId: R1,
  });
  assert.deepEqual(harness.requests, [R1]);
  for (const requestId of ['', 'request-without-prefix', 'collector-invalid_id']) {
    assert.deepEqual(harness.flow.requestAuthoritatively(requestId), {
      requested: false,
      requestId: '',
    });
  }
});

test('one worker request owns no content retry timer or page release', async () => {
  const harness = createHarness();
  assert.deepEqual(harness.flow.requestAuthoritatively(R1), {
    requested: true,
    requestId: R1,
  });
  await harness.flow.handleReady({ generationId: G1 });
  await harness.flow.handleResponse(response(R1, G1));
  assert.deepEqual(harness.requests, [R1]);
  assert.equal(harness.exchanges.length, 1);
});

test('worker-selected ready adopts its generation with the same request ID before posting once', async () => {
  const harness = createHarness();
  const outcome = await harness.flow.requestAuthoritatively(R1, 'account-a', {
    generationId: G1,
    accountIdHint: 'account-a',
  });
  assert.deepEqual(outcome, { accepted: true, requested: true, requestId: R1 });
  assert.deepEqual(harness.begins, [{
    requestId: R1,
    generationId: G1,
    accountIdHint: 'account-a',
  }]);
  assert.deepEqual(harness.requests, [R1]);
});

test('authenticated generation reuse completes without requesting a ticket', async () => {
  const harness = createHarness({
    beginGeneration: async () => ({ ok: true, data: { authenticated: true } }),
  });
  assert.deepEqual(await harness.flow.requestAuthoritatively(R1, 'account-a', {
    generationId: G1,
    accountIdHint: 'account-a',
  }), { accepted: true, requested: false, authenticated: true });
  assert.deepEqual(harness.requests, []);
});

test('discovery response adopts the Web generation and exchanges the same worker identity', async () => {
  const harness = createHarness();
  harness.flow.requestAuthoritatively(R1, 'account-a');
  assert.deepEqual(await harness.flow.handleResponse(response(R1, G1)), {
    accepted: true,
    authenticated: true,
  });
  assert.deepEqual(harness.begins, [{
    requestId: R1,
    generationId: G1,
    accountIdHint: 'account-a',
  }]);
  assert.deepEqual(harness.exchanges[0], {
    requestId: R1,
    generationId: G1,
    ticket: 'ctt_flow_ticket_1',
    expiresAt: '2030-01-01T00:01:00.000Z',
  });
});

test('accepted and failure reject stale request or generation identities', async () => {
  const harness = createHarness();
  await harness.flow.requestAuthoritatively(R1, '', { generationId: G1 });
  assert.deepEqual(harness.flow.handleAccepted({ requestId: R2, generationId: G1 }), {
    accepted: false,
    reason: 'stale-request',
  });
  assert.deepEqual(await harness.flow.handleFailure({
    requestId: R1,
    generationId: G2,
    publicCode: 'WEB_LOGIN_REQUIRED',
  }), { accepted: false, reason: 'stale-generation' });
  assert.deepEqual(harness.failures, []);
});

test('closed failure forwards its exact request identity once', async () => {
  const harness = createHarness();
  harness.flow.requestAuthoritatively(R1);
  assert.deepEqual(await harness.flow.handleFailure({
    requestId: R1,
    generationId: G1,
    publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
  }), { accepted: true });
  assert.deepEqual(harness.failures, [{
    requestId: R1,
    generationId: G1,
    publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
  }]);
  assert.deepEqual(await harness.flow.handleFailure({
    requestId: R1,
    generationId: G1,
    publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
  }), { accepted: false, reason: 'stale-request' });
});

test('one exchange in flight rejects a replacement worker request', async () => {
  const pending = deferred();
  const harness = createHarness({ exchangeTicket: () => pending.promise });
  harness.flow.requestAuthoritatively(R1);
  const exchange = harness.flow.handleResponse(response(R1, G1));
  for (let turn = 0; turn < 10 && harness.exchanges.length === 0; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(harness.exchanges.length, 1);
  assert.deepEqual(harness.flow.requestAuthoritatively(R2), {
    requested: false,
    requestId: R2,
  });
  pending.resolve({ ok: true });
  await exchange;
  assert.equal(harness.exchanges.length, 1);
});

test('matching logout clears only the adopted generation', async () => {
  const harness = createHarness();
  await harness.flow.requestAuthoritatively(R1, '', { generationId: G1 });
  assert.deepEqual(await harness.flow.handleLogout({ generationId: G2 }), {
    accepted: false,
    reason: 'stale-generation',
  });
  assert.deepEqual(await harness.flow.handleLogout({ generationId: G1 }), {
    accepted: true,
    cleared: true,
  });
  assert.deepEqual(harness.clears, [G2, G1]);
});

test('failed exchange does not retry or release from content flow', async () => {
  const harness = createHarness({
    exchangeTicket: async () => ({ ok: false, code: 'COLLECTOR_TICKET_EXPIRED' }),
  });
  harness.flow.requestAuthoritatively(R1);
  await harness.flow.handleResponse(response(R1, G1));
  assert.deepEqual(harness.requests, [R1]);
  assert.equal(harness.exchanges.length, 1);
});

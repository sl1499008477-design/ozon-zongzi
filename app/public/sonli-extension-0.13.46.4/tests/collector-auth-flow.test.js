const assert = require('node:assert/strict');
const test = require('node:test');
const { createCollectorAuthFlow } = require('../lib/collector-auth-flow.js');

const G1 = 'generation_G1_1234';
const G2 = 'generation_G2_5678';
const G3 = 'generation_G3_9012';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, reject, resolve };
};

const response = (requestId, generationId, suffix = '1') => ({
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.response',
  requestId,
  generationId,
  ticket: `ctt_flow_ticket_${suffix}`,
  expiresAt: `2030-01-01T00:0${suffix}:00.000Z`,
});

const createHarness = ({ beginGeneration, clearGeneration, exchangeTicket } = {}) => {
  const begins = [];
  const beginHints = [];
  const clears = [];
  const exchanges = [];
  const requests = [];
  const timers = [];
  let nextRequestId = 0;
  let now = 0;
  const harness = {
    begins,
    beginHints,
    clears,
    exchanges,
    requests,
    timers,
  };
  harness.flow = createCollectorAuthFlow({
    newRequestId: () => `request-${++nextRequestId}`,
    postRequest(requestId) { requests.push(requestId); },
    async beginGeneration(generationId) {
      begins.push(generationId);
      beginHints.push(arguments[1]);
      if (beginGeneration) return beginGeneration(generationId, arguments[1]);
      return { ok: true };
    },
    async clearGeneration(generationId) {
      clears.push(generationId);
      if (clearGeneration) return clearGeneration(generationId);
      return { ok: true };
    },
    async exchangeTicket(payload) {
      exchanges.push(payload);
      if (exchangeTicket) return exchangeTicket(payload);
      return { ok: true };
    },
    setTimer(callback, milliseconds) {
      const timer = {
        callback,
        milliseconds,
        dueAt: now + milliseconds,
        cancelled: false,
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.cancelled = true;
    },
  });
  harness.advanceTime = (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const timer = timers
        .filter((candidate) => !candidate.cancelled && !candidate.ran && candidate.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!timer) break;
      now = timer.dueAt;
      timer.ran = true;
      timer.callback();
    }
    now = target;
  };
  return harness;
};

test('duplicate ready begins and requests a generation only once', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1 });
  const duplicate = await harness.flow.handleReady({ generationId: G1 });

  assert.deepEqual(harness.begins, [G1]);
  assert.deepEqual(harness.requests, ['request-1']);
  assert.deepEqual(duplicate, { accepted: false, reason: 'duplicate-generation' });
});

test('V2 ready begins with its account hint and the following legacy ready is ignored', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1, accountIdHint: 'account-a' });
  const legacyDuplicate = await harness.flow.handleReady({ generationId: G1 });

  assert.deepEqual(harness.begins, [G1]);
  assert.deepEqual(harness.beginHints, ['account-a']);
  assert.deepEqual(harness.requests, ['request-1']);
  assert.deepEqual(legacyDuplicate, { accepted: false, reason: 'duplicate-generation' });
});

test('an explicitly authenticated begin reuses the session without requesting a ticket', async () => {
  const harness = createHarness({
    beginGeneration: async () => ({
      ok: true,
      data: { authenticated: true, reused: true },
    }),
  });

  assert.deepEqual(
    await harness.flow.handleReady({ generationId: G1, accountIdHint: 'account-a' }),
    { accepted: true, requested: false, authenticated: true },
  );
  assert.deepEqual(harness.requests, []);
  assert.deepEqual(harness.flow.requestAuthoritatively(), { requested: true });
  assert.deepEqual(harness.requests, ['request-1']);
});

test('ready waits for its serialized begin before requesting a ticket', async () => {
  const begin = deferred();
  const harness = createHarness({ beginGeneration: () => begin.promise });

  const readyPending = harness.flow.handleReady({ generationId: G1 });
  await Promise.resolve();
  assert.deepEqual(harness.begins, [G1]);
  assert.equal(harness.requests.length, 0);
  assert.deepEqual(harness.flow.requestAuthoritatively(), { requested: false });
  assert.equal(harness.requests.length, 0, 'authoritative request cannot bypass pending begin');

  begin.resolve({ ok: true });
  assert.deepEqual(await readyPending, { accepted: true, requested: true });
  assert.deepEqual(harness.requests, ['request-1']);
});

test('rejected ready begin rolls back so the same generation can retry', async () => {
  let beginCount = 0;
  const harness = createHarness({
    beginGeneration: async () => {
      beginCount += 1;
      if (beginCount === 1) throw new Error('begin unavailable');
      return { ok: true };
    },
  });

  assert.deepEqual(await harness.flow.handleReady({ generationId: G1 }), {
    accepted: false,
    reason: 'begin-failed',
  });
  assert.deepEqual(await harness.flow.handleReady({ generationId: G1 }), {
    accepted: true,
    requested: true,
  });
  assert.deepEqual(harness.begins, [G1, G1]);
  assert.deepEqual(harness.requests, ['request-1']);
});

test('failed discovery begin permits the adopted generation ready to recover', async () => {
  let beginCount = 0;
  const harness = createHarness({
    beginGeneration: async () => {
      beginCount += 1;
      return { ok: beginCount > 1 };
    },
  });

  harness.flow.startDiscovery();
  assert.deepEqual(
    await harness.flow.handleResponse(response('request-1', G1)),
    { accepted: false, reason: 'begin-failed' },
  );
  assert.deepEqual(await harness.flow.handleReady({ generationId: G1 }), {
    accepted: true,
    requested: true,
  });
  assert.deepEqual(harness.begins, [G1, G1]);
  assert.deepEqual(harness.requests, ['request-1', 'request-2']);
});

test('discovery response adopts its generation before exchanging', async () => {
  const harness = createHarness();

  assert.deepEqual(harness.flow.startDiscovery(), { requested: true });
  const result = await harness.flow.handleResponse(response('request-1', G1));

  assert.deepEqual(harness.begins, [G1]);
  assert.equal(harness.exchanges.length, 1);
  assert.deepEqual(harness.exchanges[0], {
    requestId: 'request-1',
    generationId: G1,
    ticket: 'ctt_flow_ticket_1',
    expiresAt: '2030-01-01T00:01:00.000Z',
  });
  assert.deepEqual(result, { accepted: true, authenticated: true });
});

test('discovery response cannot replace a newer ready generation', async () => {
  const harness = createHarness();

  harness.flow.startDiscovery();
  await harness.flow.handleReady({ generationId: G2 });
  const result = await harness.flow.handleResponse(response('request-1', G1));

  assert.equal(result.accepted, false);
  assert.deepEqual(harness.begins, [G2]);
  assert.equal(harness.exchanges.length, 0);
});

test('each request accepts only its bound generation', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1 });
  assert.deepEqual(
    await harness.flow.handleResponse(response('request-1', G2)),
    { accepted: false, reason: 'stale-generation' },
  );
  assert.equal(harness.exchanges.length, 0);
  await harness.flow.handleReady({ generationId: G2 });
  const staleG1 = await harness.flow.handleResponse(response('request-1', G1));
  const mislabeledG1 = await harness.flow.handleResponse(response('request-2', G1));

  assert.equal(staleG1.accepted, false);
  assert.deepEqual(mislabeledG1, { accepted: false, reason: 'stale-generation' });
  assert.equal(harness.exchanges.length, 0);
});

test('new ready enters the background fence during exchange and only latest pending generation proceeds', async () => {
  const firstExchange = deferred();
  const harness = createHarness({
    exchangeTicket: ({ generationId }) => generationId === G1
      ? firstExchange.promise
      : Promise.resolve({ ok: true }),
  });

  await harness.flow.handleReady({ generationId: G1 });
  const g1Exchange = harness.flow.handleResponse(response('request-1', G1));
  await Promise.resolve();
  assert.equal(harness.exchanges.length, 1);

  await harness.flow.handleReady({ generationId: G2 });
  await harness.flow.handleReady({ generationId: G3 });
  assert.deepEqual(harness.begins, [G1, G2, G3]);
  assert.equal(harness.exchanges.length, 1, 'generation handoff must not overlap exchanges');
  assert.deepEqual(harness.requests, ['request-1']);

  firstExchange.resolve({ ok: true });
  assert.deepEqual(await g1Exchange, { accepted: true, authenticated: false });
  assert.deepEqual(harness.requests, ['request-1', 'request-2']);
  assert.equal(harness.exchanges.length, 1);

  await harness.flow.handleResponse(response('request-2', G3, '2'));
  assert.equal(harness.exchanges.length, 2);
  assert.equal(harness.exchanges[1].generationId, G3);
});

test('matching logout cancels its generation and permits a later generation', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1 });
  const firstTimer = harness.timers.at(-1);
  assert.deepEqual(await harness.flow.handleLogout({ generationId: G1 }), {
    accepted: true,
    cleared: true,
  });
  assert.equal(firstTimer.cancelled, true);
  firstTimer.callback();
  assert.deepEqual(harness.requests, ['request-1']);
  assert.deepEqual(harness.clears, [G1]);

  await harness.flow.handleReady({ generationId: G2 });
  assert.deepEqual(harness.begins, [G1, G2]);
  assert.deepEqual(harness.requests, ['request-1', 'request-2']);
});

test('stale logout is fenced in the background without resetting the desired generation', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1 });
  await harness.flow.handleReady({ generationId: G2 });
  assert.deepEqual(await harness.flow.handleLogout({ generationId: G1 }), {
    accepted: false,
    reason: 'stale-generation',
  });
  assert.deepEqual(harness.clears, [G1]);

  await harness.flow.handleResponse(response('request-2', G2));
  assert.equal(harness.exchanges.length, 1);
  assert.equal(harness.exchanges[0].generationId, G2);
});

test('authoritative recheck rediscovers the current Web generation after authentication', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1 });
  await harness.flow.handleResponse(response('request-1', G1));
  assert.deepEqual(harness.flow.requestAuthoritatively(), { requested: true });
  assert.deepEqual(harness.requests, ['request-1', 'request-2']);
  await harness.flow.handleResponse(response('request-2', G2, '2'));

  assert.deepEqual(harness.begins, [G1, G2]);
  assert.deepEqual(harness.requests, ['request-1', 'request-2']);
  assert.equal(harness.exchanges[1].generationId, G2);

  const discoveryHarness = createHarness();
  assert.deepEqual(discoveryHarness.flow.requestAuthoritatively(), { requested: true });
  assert.deepEqual(discoveryHarness.requests, ['request-1']);
});

test('authoritative recheck never reactivates or exchanges a stale cached generation', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1 });
  assert.deepEqual(harness.flow.requestAuthoritatively(), { requested: true });
  await harness.flow.handleResponse(response('request-2', G2, '2'));

  assert.deepEqual(harness.begins, [G1, G2]);
  assert.deepEqual(harness.requests, ['request-1', 'request-2']);
  assert.deepEqual(harness.exchanges.map(({ generationId }) => generationId), [G2]);
});

test('accepted replaces the one-second retry with a thirty-second response watchdog', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1 });
  const retryTimer = harness.timers.at(-1);
  assert.equal(retryTimer.milliseconds, 1000);

  assert.deepEqual(harness.flow.handleAccepted({ requestId: 'request-1', generationId: G1 }), {
    accepted: true,
  });
  assert.equal(retryTimer.cancelled, true);
  assert.equal(harness.timers.at(-1).milliseconds, 30000);

  harness.advanceTime(29999);
  assert.deepEqual(harness.requests, ['request-1']);
  harness.advanceTime(1);
  assert.deepEqual(harness.requests, ['request-1', 'request-2']);
});

test('duplicate accepted acknowledgements do not extend the response watchdog', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1 });
  harness.flow.handleAccepted({ requestId: 'request-1', generationId: G1 });
  harness.advanceTime(10000);
  harness.flow.handleAccepted({ requestId: 'request-1', generationId: G1 });
  harness.advanceTime(19999);
  assert.deepEqual(harness.requests, ['request-1']);
  harness.advanceTime(1);
  assert.deepEqual(harness.requests, ['request-1', 'request-2']);
});

test('an unaccepted request retries only once at one second', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1 });
  harness.advanceTime(1000);
  harness.advanceTime(10000);

  assert.deepEqual(harness.requests, ['request-1', 'request-2']);
});

test('stale accepted and response messages cannot cancel or complete a newer request', async () => {
  const harness = createHarness();

  await harness.flow.handleReady({ generationId: G1 });
  const g1Request = harness.requests.at(-1);
  await harness.flow.handleReady({ generationId: G2 });
  const g2Request = harness.requests.at(-1);
  const g2RetryTimer = harness.timers.at(-1);

  assert.deepEqual(harness.flow.handleAccepted({ requestId: g1Request, generationId: G1 }), {
    accepted: false,
    reason: 'stale-request',
  });
  assert.equal(g2RetryTimer.cancelled, false);
  assert.deepEqual(await harness.flow.handleResponse(response(g1Request, G1)), {
    accepted: false,
    reason: 'stale-request',
  });
  assert.equal(harness.exchanges.length, 0);

  assert.deepEqual(harness.flow.handleAccepted({ requestId: g2Request, generationId: G2 }), {
    accepted: true,
  });
  assert.deepEqual(await harness.flow.handleResponse(response(g2Request, G2, '2')), {
    accepted: true,
    authenticated: true,
  });
  assert.equal(harness.exchanges.length, 1);
});

test('expired tickets are exchanged at most twice', async () => {
  const harness = createHarness({
    exchangeTicket: async () => ({ ok: false, code: 'COLLECTOR_TICKET_EXPIRED' }),
  });

  await harness.flow.handleReady({ generationId: G1 });
  await harness.flow.handleResponse(response('request-1', G1));
  await harness.flow.handleResponse(response('request-2', G1, '2'));

  assert.equal(harness.exchanges.length, 2);
  assert.deepEqual(harness.requests, ['request-1', 'request-2']);
  assert.equal(harness.timers.at(-1).cancelled, true);
});

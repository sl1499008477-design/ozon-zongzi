const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COLLECTOR_PERMISSIONS,
  COLLECTOR_SESSION_STORAGE_KEY,
  createCollectorSessionManager,
} = require('../lib/collector-session.js');
const { createCollectorAuthFlow } = require('../lib/collector-auth-flow.js');
const {
  COLLECTOR_AUTH_STATUS_STORAGE_KEY,
  createCollectorAuthCoordinator,
} = require('../lib/collector-auth-coordinator.js');

const START = Date.parse('2030-01-01T00:00:00.000Z');
const GENERATION = 'generation_acceptance_1234';
const STATUS_KEYS = [
  'account',
  'attemptNumber',
  'expiresAt',
  'generationId',
  'nextRetryAt',
  'phase',
  'publicCode',
  'startedAt',
  'updatedAt',
  'version',
];

function createFakeClock(start = START) {
  let now = start;
  let sequence = 0;
  const timers = [];
  const setTimer = (callback, delay) => {
    const timer = {
      callback,
      cancelled: false,
      dueAt: now + Number(delay),
      id: ++sequence,
    };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (timer) => {
    if (timer) timer.cancelled = true;
  };
  const advance = async (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const next = timers
        .filter((timer) => !timer.cancelled && timer.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (!next) break;
      next.cancelled = true;
      now = next.dueAt;
      await next.callback();
      await Promise.resolve();
    }
    now = target;
  };
  return { advance, clearTimer, now: () => now, setTimer, timers };
}

function createStorageArea(initial = {}, onSet = () => {}) {
  const state = structuredClone(initial);
  return {
    state,
    async get(keys) {
      if (keys == null) return { ...state };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, state[key]]));
      }
      return { [keys]: state[keys] };
    },
    async set(values) {
      for (const [key, value] of Object.entries(values || {})) {
        const oldValue = state[key];
        state[key] = structuredClone(value);
        onSet(key, structuredClone(value), structuredClone(oldValue));
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
  };
}

function createCoordinatorHarness({ clock = createFakeClock(), requestAuth } = {}) {
  const popupSnapshots = [];
  const session = createStorageArea({}, (key, value) => {
    if (key === COLLECTOR_AUTH_STATUS_STORAGE_KEY) popupSnapshots.push(value);
  });
  const alarms = {
    async clear() { return true; },
    create() {},
  };
  const requests = [];
  const coordinator = createCollectorAuthCoordinator({
    alarms,
    getSession: async () => null,
    now: clock.now,
    random: () => 0.5,
    requestAuth: async (input) => {
      requests.push(structuredClone(input));
      return requestAuth ? requestAuth(input) : { requested: true };
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    storageSession: session,
  });
  return { clock, coordinator, popupSnapshots, requests, session };
}

test('same-account valid session authenticates within fake 500 ms without requesting a ticket', async () => {
  const clock = createFakeClock();
  const session = createStorageArea({
    [COLLECTOR_SESSION_STORAGE_KEY]: {
      collectorToken: 'cst_acceptance_secret_123456789',
      expiresAt: '2030-01-01T01:00:00.000Z',
      account: { id: 'account-a', displayName: '账号 A' },
      permissions: [...COLLECTOR_PERMISSIONS],
    },
  });
  const manager = createCollectorSessionManager({
    chromeApi: {
      storage: {
        local: createStorageArea(),
        session,
      },
    },
    backendUrl: 'http://127.0.0.1:3000/api',
    fetchImpl: async () => { throw new Error('ticket exchange must not run'); },
    now: clock.now,
    newGenerationIncarnation: () => 'collector_activation_acceptance_1234',
  });
  const statusHarness = createCoordinatorHarness({ clock });
  let ticketRequests = 0;
  const flow = createCollectorAuthFlow({
    newRequestId: () => 'request-acceptance-reuse',
    postRequest: () => { ticketRequests += 1; },
    beginGeneration: async (generationId, accountIdHint) => {
      await statusHarness.coordinator.begin({ generationId });
      const activation = await manager.activateCollectorGeneration({
        generationId,
        accountIdHint,
      });
      if (activation.reused && activation.authenticated) {
        await statusHarness.coordinator.succeed({
          generationId,
          account: activation.account,
          expiresAt: activation.expiresAt,
        });
      }
      return { ok: true, data: activation };
    },
    clearGeneration: (generationId) => manager.clearCollectorGeneration(generationId),
    exchangeTicket: async () => { throw new Error('ticket exchange must not run'); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const startedAt = clock.now();
  const outcome = await flow.handleReady({
    generationId: GENERATION,
    accountIdHint: 'account-a',
  });

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.requested, false);
  assert.equal(ticketRequests, 0);
  assert.equal((await statusHarness.coordinator.getStatus()).phase, 'AUTHENTICATED');
  assert.ok(clock.now() - startedAt <= 500);
});

test('first authentication has one accepted request, one ticket request and one exchange', async () => {
  const clock = createFakeClock();
  const ticketRequests = [];
  const accepted = [];
  const exchanges = [];
  let requestSequence = 0;
  const flow = createCollectorAuthFlow({
    newRequestId: () => `request-acceptance-${++requestSequence}`,
    postRequest: (requestId) => ticketRequests.push(requestId),
    beginGeneration: async () => ({ ok: true, data: { authenticated: false } }),
    clearGeneration: async () => true,
    exchangeTicket: async (input) => {
      exchanges.push(structuredClone(input));
      return { ok: true };
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await flow.handleReady({ generationId: GENERATION, accountIdHint: 'account-a' });
  const requestId = ticketRequests[0];
  accepted.push(flow.handleAccepted({ requestId, generationId: GENERATION }));
  await clock.advance(29_999);
  assert.equal(ticketRequests.length, 1, 'accepted lease must suppress a second request');

  const response = await flow.handleResponse({
    requestId,
    generationId: GENERATION,
    ticket: 'ctt_acceptance_one_time_123456789',
    expiresAt: '2030-01-01T00:01:00.000Z',
  });

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].accepted, true);
  assert.equal(ticketRequests.length, 1);
  assert.equal(exchanges.length, 1);
  assert.equal(response.authenticated, true);
});

test('transient failure exposes retry wait and overlapping due resumes request once', async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.begin({ generationId: GENERATION });
  const retryStatus = await harness.coordinator.fail({
    generationId: GENERATION,
    error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
  });

  assert.equal(retryStatus.phase, 'RETRY_WAIT');
  assert.equal(retryStatus.publicCode, 'LOCAL_SERVICE_UNAVAILABLE');
  assert.equal(retryStatus.nextRetryAt, '2030-01-01T00:00:01.000Z');

  const dueTimer = harness.clock.timers.find((timer) => timer.dueAt === START + 1_000);
  assert.ok(dueTimer);
  await Promise.all([
    harness.clock.advance(1_000),
    harness.coordinator.resume(),
  ]);
  assert.equal(harness.requests.length, 1);
});

test('popup storage observer receives every credential-free status phase', async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.fail({ generationId: '', error: { code: 'WEB_AUTH_REQUIRED' } });
  const discovery = harness.coordinator.retryNow();
  await discovery;
  await harness.coordinator.begin({ generationId: GENERATION });
  await harness.coordinator.accept({ requestId: 'request-popup-observer', generationId: GENERATION });
  await harness.coordinator.exchange({ generationId: GENERATION });
  await harness.coordinator.fail({
    generationId: GENERATION,
    error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
  });
  await harness.coordinator.begin({ generationId: GENERATION });
  await harness.coordinator.fail({
    generationId: GENERATION,
    error: { code: 'COLLECTOR_PERMISSION_DENIED', status: 403 },
  });
  await harness.coordinator.begin({ generationId: GENERATION });
  await harness.coordinator.succeed({
    generationId: GENERATION,
    account: {
      id: 'account-a',
      displayName: '账号 A',
      collectorToken: 'cst_must_not_cross_popup_boundary_123456789',
    },
    expiresAt: '2030-01-01T01:00:00.000Z',
  });

  const observed = new Set(harness.popupSnapshots.map(({ phase }) => phase));
  assert.deepEqual(observed, new Set([
    'WAITING_FOR_WEB',
    'DISCOVERING_WEB',
    'REQUESTING_TICKET',
    'EXCHANGING',
    'RETRY_WAIT',
    'ACTION_REQUIRED',
    'AUTHENTICATED',
  ]));
  for (const snapshot of harness.popupSnapshots) {
    assert.deepEqual(Object.keys(snapshot).sort(), STATUS_KEYS);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /collectorToken|bearer|fingerprint|cst_/i);
    if (snapshot.account) assert.deepEqual(Object.keys(snapshot.account).sort(), ['displayName', 'id']);
  }
});

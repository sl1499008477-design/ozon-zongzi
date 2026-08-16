const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCollectorAuthCoordinator,
} = require('../lib/collector-auth-coordinator.js');

const STORAGE_KEY = 'sonliCollectorAuthStatus';
const ALARM_NAME = 'collectorAuthRetry';
const G1 = 'generation_G1_1234';
const G2 = 'generation_G2_5678';
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

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
};

function createHarness({
  getSession,
  initial = {},
  newRequestId,
  now: suppliedNow,
  randomValues = [0.5],
  requestAuth,
  session = null,
  start = Date.parse('2030-01-01T00:00:00.000Z'),
} = {}) {
  const state = { ...initial };
  const writes = [];
  const createdAlarms = [];
  const clearedAlarms = [];
  const authRequests = [];
  const generatedRequestIds = [];
  const timers = [];
  let currentTime = start;
  let randomIndex = 0;
  let requestSequence = 0;
  const storageSession = {
    async get(key) { return { [key]: state[key] }; },
    async set(values) {
      Object.assign(state, JSON.parse(JSON.stringify(values)));
      writes.push(JSON.parse(JSON.stringify(values)));
    },
  };
  const alarms = {
    async clear(name) { clearedAlarms.push(name); return true; },
    create(name, options) {
      createdAlarms.push({ name, options: { ...options } });
    },
  };
  const rawCoordinator = createCollectorAuthCoordinator({
    alarms,
    getSession: async () => (getSession ? getSession() : session),
    now: () => (suppliedNow ? suppliedNow() : currentTime),
    newRequestId: () => {
      const requestId = newRequestId
        ? newRequestId()
        : `collector-coordinator-${++requestSequence}`;
      generatedRequestIds.push(requestId);
      return requestId;
    },
    random: () => randomValues[Math.min(randomIndex++, randomValues.length - 1)],
    requestAuth: async (input) => {
      authRequests.push(input);
      return requestAuth ? requestAuth(input) : { requested: true };
    },
    setTimer(callback, milliseconds) {
      const timer = { callback, milliseconds, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.cancelled = true;
    },
    storageSession,
  });
  return {
    alarms,
    authRequests,
    clearedAlarms,
    coordinator: rawCoordinator,
    createdAlarms,
    generatedRequestIds,
    setTime(value) { currentTime = value; },
    state,
    storageSession,
    timers,
    writes,
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await predicate()) return;
    await Promise.resolve();
  }
  assert.fail('condition was not reached');
};

const startAttempt = async (harness) => {
  const before = harness.authRequests.length;
  const result = await harness.coordinator.retryNow();
  assert.equal(result.requested, true);
  assert.equal(harness.authRequests.length, before + 1);
  return harness.authRequests.at(-1);
};

test('projects every authentication phase through the closed status contract', async () => {
  const pendingRequest = deferred();
  const harness = createHarness({ requestAuth: () => pendingRequest.promise });
  const { coordinator } = harness;

  assert.deepEqual(await coordinator.getStatus(), {
    version: 1,
    phase: 'WAITING_FOR_WEB',
    generationId: '',
    startedAt: '',
    updatedAt: '',
    attemptNumber: 0,
    nextRetryAt: '',
    publicCode: '',
    account: null,
    expiresAt: '',
  });

  const discovery = coordinator.retryNow();
  await waitFor(async () => (await coordinator.getStatus()).phase === 'DISCOVERING_WEB');
  pendingRequest.resolve({ requested: true });
  await discovery;
  const requestId = harness.authRequests.at(-1);

  assert.equal((await coordinator.begin({ requestId, generationId: G1 })).status.phase, 'REQUESTING_TICKET');
  assert.equal((await coordinator.accept({
    requestId,
    generationId: G1,
  })).phase, 'REQUESTING_TICKET');
  assert.equal((await coordinator.exchange({ requestId, generationId: G1 })).phase, 'EXCHANGING');

  const authenticated = await coordinator.succeed({
    requestId,
    generationId: G1,
    account: {
      id: 'account-a',
      displayName: 'Account A',
      permissions: ['collector.upload'],
      token: 'cst_must_never_be_stored_123456789',
    },
    expiresAt: '2030-01-02T00:00:00.000Z',
  });
  assert.deepEqual(plain(authenticated), {
    version: 1,
    phase: 'AUTHENTICATED',
    generationId: G1,
    startedAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    attemptNumber: 0,
    nextRetryAt: '',
    publicCode: '',
    account: { id: 'account-a', displayName: 'Account A' },
    expiresAt: '2030-01-02T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(authenticated).sort(), STATUS_KEYS);
  assert.deepEqual(Object.keys(authenticated.account).sort(), ['displayName', 'id']);
});

test('coordinator owns no-ack discovery and response watchdogs', async () => {
  const harness = createHarness();
  const requestId = await startAttempt(harness);
  const watchdog = harness.timers.findLast(({ milliseconds, cancelled }) => (
    milliseconds === 2_500 && !cancelled
  ));
  assert.ok(watchdog, 'discovery must arm the coordinator no-ack watchdog');

  await harness.coordinator.begin({ requestId, generationId: G1 });
  assert.equal(watchdog.cancelled, true);
  await harness.coordinator.accept({ requestId, generationId: G1 });
  assert.equal(harness.timers.at(-1).milliseconds, 31_000);
});

test('coordinator no-ack watchdog fails the exact worker request after delivery', async () => {
  const harness = createHarness();
  await harness.coordinator.retryNow();
  const watchdog = harness.timers.findLast(({ milliseconds, cancelled }) => (
    milliseconds === 2_500 && !cancelled
  ));

  watchdog.callback();
  await waitFor(async () => (await harness.coordinator.getStatus()).phase === 'WAITING_FOR_WEB');

  const status = await harness.coordinator.getStatus();
  assert.equal(status.publicCode, 'WEB_LOGIN_REQUIRED');
});

test('begin reports whether the exact request lease was accepted', async () => {
  const harness = createHarness();
  await harness.coordinator.retryNow();
  const requestId = harness.authRequests[0];

  const before = {
    status: plain(await harness.coordinator.getStatus()),
    timers: plain(harness.timers),
    session: plain(harness.state),
  };
  for (const invalidRequestId of [undefined, 'not canonical!', 'collector-stale-attempt']) {
    const rejected = await harness.coordinator.begin({
      requestId: invalidRequestId,
      generationId: G1,
    });
    assert.equal(rejected.accepted, false);
    assert.deepEqual(plain(await harness.coordinator.getStatus()), before.status);
    assert.deepEqual(plain(harness.timers), before.timers);
    assert.deepEqual(plain(harness.state), before.session);
  }

  const accepted = await harness.coordinator.begin({ requestId, generationId: G1 });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.status.phase, 'REQUESTING_TICKET');

  const stale = await harness.coordinator.begin({
    requestId: 'collector-stale-attempt',
    generationId: G2,
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.status.generationId, G1);
});

test('coordinator watchdog releases a hanging Web discovery so a later request can recover', async () => {
  const hung = deferred();
  let requests = 0;
  const harness = createHarness({
    requestAuth: () => {
      requests += 1;
      return requests === 1
        ? hung.promise
        : { requested: false, publicCode: 'WEB_TAB_UNAVAILABLE' };
    },
  });

  const first = harness.coordinator.retryNow();
  await waitFor(async () => (await harness.coordinator.getStatus()).phase === 'DISCOVERING_WEB');
  await waitFor(() => harness.timers.some(({ milliseconds }) => milliseconds === 2_500));
  const watchdog = harness.timers.find(({ milliseconds }) => milliseconds === 2_500);
  assert.ok(watchdog, 'discovery must arm the watchdog before awaiting the Web transport');
  watchdog.callback();

  const timedOut = await first;
  assert.equal(timedOut.requested, false);
  assert.equal(timedOut.status.phase, 'WAITING_FOR_WEB');
  assert.equal(timedOut.status.publicCode, 'WEB_LOGIN_REQUIRED');
  const recovered = await harness.coordinator.retryNow();
  assert.equal(requests, 2, 'the hung transport must not retain the coordinator single-flight');
  assert.equal(recovered.requested, false);
  assert.equal(recovered.status.publicCode, 'WEB_TAB_UNAVAILABLE');
});

test('cold start projects a valid session only with its verified generation and timeline', async () => {
  const harness = createHarness({
    session: {
      generationId: G1,
      account: { id: 'account-a', displayName: 'Account A' },
      permissions: ['collector.upload'],
      expiresAt: '2030-01-02T00:00:00.000Z',
    },
  });
  const resumed = await harness.coordinator.resume();
  assert.equal(resumed.phase, 'AUTHENTICATED');
  assert.equal(resumed.generationId, G1);
  assert.equal(resumed.startedAt, '2030-01-01T00:00:00.000Z');
  assert.equal(resumed.updatedAt, '2030-01-01T00:00:00.000Z');

  const missingGeneration = createHarness({
    session: {
      account: { id: 'account-a', displayName: 'Account A' },
      expiresAt: '2030-01-02T00:00:00.000Z',
    },
  });
  assert.equal((await missingGeneration.coordinator.resume()).phase, 'WAITING_FOR_WEB');
});

test('maps every public condition exactly and retries only transient failures', async () => {
  const cases = [
    [{ code: 'WEB_AUTH_REQUIRED' }, 'WAITING_FOR_WEB', 'WEB_LOGIN_REQUIRED', false],
    [{ code: 'WEB_TAB_UNAVAILABLE' }, 'WAITING_FOR_WEB', 'WEB_TAB_UNAVAILABLE', false],
    [{ code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' }, 'RETRY_WAIT', 'LOCAL_SERVICE_UNAVAILABLE', true],
    [{ code: 'COLLECTOR_AUTH_PERSISTENCE_FAILED' }, 'RETRY_WAIT', 'LOCAL_SERVICE_UNAVAILABLE', true],
    [{ code: 'COLLECTOR_ACCOUNT_DISABLED', status: 403 }, 'ACTION_REQUIRED', 'ACCOUNT_DISABLED', false],
    [{ code: 'COLLECTOR_ACCOUNT_EXPIRED', status: 403 }, 'ACTION_REQUIRED', 'ACCOUNT_EXPIRED', false],
    [{ code: 'COLLECTOR_PARENT_SESSION_EXPIRED', status: 401 }, 'WAITING_FOR_WEB', 'WEB_LOGIN_REQUIRED', false],
    [{ code: 'COLLECTOR_PERMISSION_DENIED', status: 403 }, 'ACTION_REQUIRED', 'PERMISSION_DENIED', false],
    [{ code: 'PORTAL_BRIDGE_FORBIDDEN', status: 403 }, 'ACTION_REQUIRED', 'TRUST_BOUNDARY_REJECTED', false],
    [{ code: 'COLLECTOR_AUTH_CONTRACT_UNSUPPORTED', status: 426 }, 'ACTION_REQUIRED', 'SERVER_UPGRADE_REQUIRED', false],
    [{ code: 'COLLECTOR_TICKET_EXPIRED', status: 401 }, 'ACTION_REQUIRED', 'SERVER_UPGRADE_REQUIRED', false],
    [{ code: 'UNRECOGNIZED_SERVER_CODE', status: 418 }, 'ACTION_REQUIRED', 'SERVER_UPGRADE_REQUIRED', false],
    [{ code: 'UPSTREAM_UNSAFE', status: Symbol('503-secret') }, 'ACTION_REQUIRED', 'SERVER_UPGRADE_REQUIRED', false],
    [{ code: 'COLLECTOR_ACCOUNT_DISABLED', status: 503 }, 'ACTION_REQUIRED', 'ACCOUNT_DISABLED', false],
    [{ code: 'COLLECTOR_PERMISSION_DENIED', status: 503 }, 'ACTION_REQUIRED', 'PERMISSION_DENIED', false],
    [{ code: 'PORTAL_BRIDGE_FORBIDDEN', status: 503 }, 'ACTION_REQUIRED', 'TRUST_BOUNDARY_REJECTED', false],
    [{ code: 'COLLECTOR_AUTH_CONTRACT_UNSUPPORTED', status: 503 }, 'ACTION_REQUIRED', 'SERVER_UPGRADE_REQUIRED', false],
    [{ code: 'COLLECTOR_TICKET_EXPIRED', status: 503 }, 'ACTION_REQUIRED', 'SERVER_UPGRADE_REQUIRED', false],
    [{ code: 'COLLECTOR_TICKET_USED', status: 503 }, 'ACTION_REQUIRED', 'SERVER_UPGRADE_REQUIRED', false],
    [{ code: 'COLLECTOR_TICKET_INVALID', status: 503 }, 'ACTION_REQUIRED', 'SERVER_UPGRADE_REQUIRED', false],
  ];

  for (const [error, phase, publicCode, retries] of cases) {
    const harness = createHarness();
    const requestId = await startAttempt(harness);
    await harness.coordinator.begin({ requestId, generationId: G1 });
    await harness.coordinator.exchange({ requestId, generationId: G1 });
    const status = await harness.coordinator.fail({ requestId, generationId: G1, error });
    assert.equal(status.phase, phase, error.code);
    assert.equal(status.publicCode, publicCode, error.code);
    assert.equal(status.nextRetryAt !== '', retries, error.code);
    assert.equal(harness.createdAlarms.length, retries ? 1 : 0, error.code);
    if (!retries) assert.ok(harness.clearedAlarms.includes(ALARM_NAME), error.code);
  }
});

test('uses bounded jitter over 1/2/5/10/30 second backoff and never exceeds 30 seconds', async () => {
  const bases = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
  const lower = createHarness({ randomValues: [0] });
  const upper = createHarness({ randomValues: [1] });

  for (const harness of [lower, upper]) {
    for (let index = 0; index < bases.length; index += 1) {
      const requestId = await startAttempt(harness);
      await harness.coordinator.begin({ requestId, generationId: G1 });
      await harness.coordinator.exchange({ requestId, generationId: G1 });
      const before = Date.parse((await harness.coordinator.getStatus()).updatedAt);
      const status = await harness.coordinator.fail({
        requestId,
        generationId: G1,
        error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
      });
      const delay = Date.parse(status.nextRetryAt) - before;
      const min = Math.round(bases[index] * 0.9);
      const max = Math.min(30_000, Math.round(bases[index] * 1.1));
      assert.ok(delay >= min, `attempt ${index + 1}: ${delay} >= ${min}`);
      assert.ok(delay <= max, `attempt ${index + 1}: ${delay} <= ${max}`);
      assert.ok(delay <= 30_000, `attempt ${index + 1} stays under 30 seconds`);
    }
  }
});

test('sub-thirty-second retry uses an exact in-memory timer and a durable thirty-second alarm', async () => {
  const start = Date.parse('2030-01-01T00:00:00.000Z');
  const harness = createHarness({ start });
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  const status = await harness.coordinator.fail({
    requestId,
    generationId: G1,
    error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
  });

  assert.equal(Date.parse(status.nextRetryAt), start + 1_000);
  const activeTimers = harness.timers.filter(({ cancelled }) => !cancelled);
  assert.equal(activeTimers.length, 1);
  assert.equal(activeTimers[0].milliseconds, 1_000);
  assert.deepEqual(harness.createdAlarms.at(-1), {
    name: ALARM_NAME,
    options: { when: start + 30_000 },
  });
});

test('a thirty-second retry uses only the durable alarm', async () => {
  const start = Date.parse('2030-01-01T00:00:00.000Z');
  const harness = createHarness({
    initial: {
      [STORAGE_KEY]: {
        version: 1,
        phase: 'EXCHANGING',
        generationId: G1,
        startedAt: '2030-01-01T00:00:00.000Z',
        updatedAt: '2030-01-01T00:00:00.000Z',
        attemptNumber: 4,
        nextRetryAt: '',
        publicCode: '',
        account: null,
        expiresAt: '',
      },
    },
    start,
  });
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  const status = await harness.coordinator.fail({
    requestId,
    generationId: G1,
    error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
  });

  assert.equal(Date.parse(status.nextRetryAt), start + 30_000);
  assert.equal(harness.timers.filter(({ cancelled }) => !cancelled).length, 0);
  assert.deepEqual(harness.createdAlarms.at(-1), {
    name: ALARM_NAME,
    options: { when: start + 30_000 },
  });
});

test('a thirty-second retry uses one clock sample for its valid tuple and alarm', async () => {
  const start = Date.parse('2030-01-01T00:00:00.000Z');
  let currentSample = start;
  const harness = createHarness({
    initial: {
      [STORAGE_KEY]: {
        version: 1,
        phase: 'EXCHANGING',
        generationId: G1,
        startedAt: '2030-01-01T00:00:00.000Z',
        updatedAt: '2030-01-01T00:00:00.000Z',
        attemptNumber: 4,
        nextRetryAt: '',
        publicCode: '',
        account: null,
        expiresAt: '',
      },
    },
    now: () => {
      const sampled = currentSample;
      currentSample += 1;
      return sampled;
    },
  });
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  const status = await harness.coordinator.fail({
    requestId,
    generationId: G1,
    error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
  });

  assert.equal(status.phase, 'RETRY_WAIT');
  assert.equal(
    Date.parse(status.nextRetryAt) - Date.parse(status.updatedAt),
    30_000,
  );
  assert.equal(harness.timers.filter(({ cancelled }) => !cancelled).length, 0);
  assert.deepEqual(harness.createdAlarms.at(-1), {
    name: ALARM_NAME,
    options: { when: Date.parse(status.nextRetryAt) },
  });
});

test('short timer and alarm overlap converge on one due request and cancel their schedule', async () => {
  const start = Date.parse('2030-01-01T00:00:00.000Z');
  const pendingRequest = deferred();
  let requestCount = 0;
  const harness = createHarness({
    requestAuth: () => (++requestCount === 1 ? { requested: true } : pendingRequest.promise),
    start,
  });
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  await harness.coordinator.fail({
    requestId,
    generationId: G1,
    error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
  });
  const timer = harness.timers[0];
  harness.setTime(start + 30_000);

  const timerRetry = timer.callback();
  const alarmRetry = harness.coordinator.resume();
  await waitFor(() => harness.authRequests.length === 2);
  assert.equal(harness.authRequests.length, 2);
  assert.equal(timer.cancelled, true);
  assert.ok(harness.clearedAlarms.includes(ALARM_NAME));
  pendingRequest.resolve({ requested: true });
  await Promise.all([timerRetry, alarmRetry]);
  assert.equal(harness.authRequests.length, 2);
});

test('restart restores a short timer with a durable fallback and a suspended worker resumes at the alarm', async () => {
  const start = Date.parse('2030-01-01T00:00:00.000Z');
  const retryStatus = {
    version: 1,
    phase: 'RETRY_WAIT',
    generationId: G1,
    startedAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    attemptNumber: 1,
    nextRetryAt: '2030-01-01T00:00:01.000Z',
    publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
    account: null,
    expiresAt: '',
  };
  const live = createHarness({
    initial: { [STORAGE_KEY]: retryStatus },
    start,
  });
  await live.coordinator.resume();
  assert.equal(live.authRequests.length, 0);
  assert.equal(live.timers[0].milliseconds, 1_000);
  assert.equal(live.createdAlarms.at(-1).options.when, start + 30_000);

  const restarted = createHarness({
    initial: { [STORAGE_KEY]: retryStatus },
    start: start + 30_000,
  });
  await restarted.coordinator.resume();
  assert.equal(restarted.authRequests.length, 1);
});

test('manual and alarm retries join one in-memory request for the active generation', async () => {
  const pendingRequest = deferred();
  let requestCount = 0;
  const harness = createHarness({
    requestAuth: () => (++requestCount === 1 ? { requested: true } : pendingRequest.promise),
  });
  const initialRequestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId: initialRequestId, generationId: G1 });
  await harness.coordinator.fail({
    requestId: initialRequestId,
    generationId: G1,
    error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
  });

  const manual = harness.coordinator.retryNow();
  const alarm = harness.coordinator.resume();
  const duplicate = harness.coordinator.retryNow();
  await waitFor(() => harness.authRequests.length === 2);

  assert.equal(harness.authRequests.length, 2);
  assert.equal(harness.authRequests[1], 'collector-coordinator-2');
  pendingRequest.resolve({ requested: true });
  await Promise.all([manual, alarm, duplicate]);
  assert.equal(harness.authRequests.length, 2);
});

test('resume cannot regress a concurrent successful authentication after a delayed session read', async () => {
  const sessionReadStarted = deferred();
  const sessionRead = deferred();
  const harness = createHarness({
    getSession: async () => {
      sessionReadStarted.resolve();
      return sessionRead.promise;
    },
  });
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  await harness.coordinator.exchange({ requestId, generationId: G1 });

  const resumed = harness.coordinator.resume();
  await sessionReadStarted.promise;
  await harness.coordinator.succeed({
    requestId,
    generationId: G1,
    account: { id: 'account-a', displayName: 'Account A' },
    expiresAt: '2031-01-01T00:00:00.000Z',
  });
  sessionRead.resolve(null);
  await resumed;

  const status = await harness.coordinator.getStatus();
  assert.equal(status.phase, 'AUTHENTICATED');
  assert.equal(status.account.id, 'account-a');
  assert.equal(harness.authRequests.length, 1);
});

test('resume cannot request for an older generation after a delayed session read', async () => {
  const sessionReadStarted = deferred();
  const sessionRead = deferred();
  const harness = createHarness({
    getSession: async () => {
      sessionReadStarted.resolve();
      return sessionRead.promise;
    },
  });
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  await harness.coordinator.exchange({ requestId, generationId: G1 });

  const resumed = harness.coordinator.resume();
  await sessionReadStarted.promise;
  await harness.coordinator.begin({ requestId, generationId: G2 });
  sessionRead.resolve(null);
  await resumed;

  const status = await harness.coordinator.getStatus();
  assert.equal(status.generationId, G2);
  assert.equal(status.phase, 'REQUESTING_TICKET');
  assert.equal(harness.authRequests.length, 1);
});

test('resume cannot regress action-required or logout state after a delayed session read', async () => {
  for (const [error, expectedPhase, expectedCode] of [
    [{ code: 'COLLECTOR_ACCOUNT_DISABLED' }, 'ACTION_REQUIRED', 'ACCOUNT_DISABLED'],
    [{ code: 'WEB_AUTH_REQUIRED' }, 'WAITING_FOR_WEB', 'WEB_LOGIN_REQUIRED'],
  ]) {
    const sessionReadStarted = deferred();
    const sessionRead = deferred();
    const harness = createHarness({
      getSession: async () => {
        sessionReadStarted.resolve();
        return sessionRead.promise;
      },
    });
    const requestId = await startAttempt(harness);
    await harness.coordinator.begin({ requestId, generationId: G1 });
    await harness.coordinator.exchange({ requestId, generationId: G1 });

    const resumed = harness.coordinator.resume();
    await sessionReadStarted.promise;
    await harness.coordinator.fail({ requestId, generationId: G1, error });
    sessionRead.resolve(null);
    await resumed;

    const status = await harness.coordinator.getStatus();
    assert.equal(status.phase, expectedPhase);
    assert.equal(status.publicCode, expectedCode);
    assert.equal(harness.authRequests.length, 1);
  }
});

for (const [name, transition] of [
  [
    'successful account B authentication',
    (coordinator, requestId) => coordinator.succeed({
      requestId,
      generationId: G1,
      account: { id: 'account-b', displayName: 'Account B' },
      expiresAt: '2031-01-02T00:00:00.000Z',
    }),
  ],
  [
    'same-generation begin',
    (coordinator, requestId) => coordinator.begin({ requestId, generationId: G1 }),
  ],
  [
    'action-required failure',
    (coordinator, requestId) => coordinator.fail({
      requestId,
      generationId: G1,
      error: { code: 'COLLECTOR_ACCOUNT_DISABLED' },
    }),
  ],
  [
    'matching logout',
    (coordinator, requestId) => coordinator.fail({
      requestId,
      generationId: G1,
      error: { code: 'WEB_AUTH_REQUIRED' },
    }),
  ],
]) {
  test(`a delayed non-null session cannot overwrite a concurrent ${name}`, async () => {
    const sessionReadStarted = deferred();
    const sessionRead = deferred();
    const harness = createHarness({
      getSession: async () => {
        sessionReadStarted.resolve();
        return sessionRead.promise;
      },
    });
    const requestId = await startAttempt(harness);
    await harness.coordinator.begin({ requestId, generationId: G1 });
    await harness.coordinator.exchange({ requestId, generationId: G1 });

    const resumed = harness.coordinator.resume();
    await sessionReadStarted.promise;
    const expected = await transition(harness.coordinator, requestId);
    sessionRead.resolve({
      collectorToken: 'cst_stale_session_a_123456789',
      account: { id: 'account-a', displayName: 'Account A' },
      permissions: ['collector.upload'],
      expiresAt: '2031-01-01T00:00:00.000Z',
    });
    await resumed;

    assert.deepEqual(
      plain(await harness.coordinator.getStatus()),
      plain(expected.status || expected),
    );
    assert.equal(harness.authRequests.length, 1);
  });
}

test('transition identity fences an identical same-clock repeated begin from delayed resume', async () => {
  const sessionReadStarted = deferred();
  const sessionRead = deferred();
  const harness = createHarness({
    getSession: async () => {
      sessionReadStarted.resolve();
      return sessionRead.promise;
    },
  });
  const requestId = await startAttempt(harness);
  const initial = await harness.coordinator.begin({ requestId, generationId: G1 });

  const resumed = harness.coordinator.resume();
  await sessionReadStarted.promise;
  const repeated = await harness.coordinator.begin({ requestId, generationId: G1 });
  assert.deepEqual(plain(repeated), plain(initial));
  sessionRead.resolve({
    collectorToken: 'cst_stale_identical_projection_123456789',
    account: { id: 'account-a', displayName: 'Account A' },
    permissions: ['collector.upload'],
    expiresAt: '2031-01-01T00:00:00.000Z',
  });
  await resumed;

  assert.deepEqual(
    plain(await harness.coordinator.getStatus()),
    plain(repeated.status),
  );
  assert.equal(harness.authRequests.length, 1);
});

test('startup and alarm resumes cannot duplicate a request after its Web acknowledgement', async () => {
  const harness = createHarness();
  const initialRequestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId: initialRequestId, generationId: G1 });
  await harness.coordinator.fail({
    requestId: initialRequestId,
    generationId: G1,
    error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
  });

  const requested = await harness.coordinator.retryNow();
  assert.equal(requested.requested, true);
  assert.equal(harness.authRequests.length, 2);
  await Promise.all([
    harness.coordinator.resume(),
    harness.coordinator.resume(),
  ]);

  assert.equal((await harness.coordinator.getStatus()).phase, 'DISCOVERING_WEB');
  assert.equal(harness.authRequests.length, 2);
});

test('a failed negative-ack projection releases its lease for one later retry', async () => {
  let failNextStatusRead = false;
  let webRequestNumber = 0;
  const harness = createHarness({
    requestAuth: async () => {
      webRequestNumber += 1;
      if (webRequestNumber === 1) {
        failNextStatusRead = true;
        return { requested: false, publicCode: 'WEB_TAB_UNAVAILABLE' };
      }
      return { requested: true };
    },
  });
  const originalGet = harness.storageSession.get.bind(harness.storageSession);
  harness.storageSession.get = async (key) => {
    if (failNextStatusRead) {
      failNextStatusRead = false;
      throw new Error('status projection read failed');
    }
    return originalGet(key);
  };

  const first = await harness.coordinator.retryNow();
  assert.equal(first.requested, false);
  assert.equal(harness.authRequests.length, 1);

  const [manual, startup] = await Promise.all([
    harness.coordinator.retryNow(),
    harness.coordinator.resume(),
  ]);
  assert.equal(manual.requested, true);
  assert.equal(startup.phase, 'DISCOVERING_WEB');
  assert.equal(harness.authRequests.length, 2);

  const requestId = harness.authRequests.at(-1);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  await harness.coordinator.succeed({
    requestId,
    generationId: G1,
    account: { id: 'account-a', displayName: 'Account A' },
    expiresAt: '2031-01-01T00:00:00.000Z',
  });
  assert.equal((await harness.coordinator.getStatus()).phase, 'AUTHENTICATED');
});

test('an old negative acknowledgement cannot release a replacement same-generation lease', async () => {
  const oldWebRequest = deferred();
  let failNextStatusRead = false;
  let webRequestNumber = 0;
  const harness = createHarness({
    requestAuth: async () => {
      webRequestNumber += 1;
      return webRequestNumber === 1
        ? { requested: true }
        : oldWebRequest.promise;
    },
  });
  const originalGet = harness.storageSession.get.bind(harness.storageSession);
  harness.storageSession.get = async (key) => {
    if (failNextStatusRead) {
      failNextStatusRead = false;
      throw new Error('old status projection read failed');
    }
    return originalGet(key);
  };

  const initialRequestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId: initialRequestId, generationId: G1 });
  await harness.coordinator.fail({
    requestId: initialRequestId,
    generationId: G1,
    error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
  });
  const oldRetry = harness.coordinator.retryNow();
  await waitFor(() => harness.authRequests.length === 2);

  const replacementRequestId = harness.authRequests.at(-1);
  const replacement = await harness.coordinator.begin({
    requestId: replacementRequestId,
    generationId: G1,
  });
  failNextStatusRead = true;
  oldWebRequest.resolve({ requested: false, publicCode: 'WEB_TAB_UNAVAILABLE' });
  await oldRetry;
  assert.equal(failNextStatusRead, true, 'the fenced old request must not read replacement state');
  harness.storageSession.get = originalGet;

  const resumed = await harness.coordinator.resume();
  assert.deepEqual(plain(resumed), plain(replacement.status));
  assert.equal(harness.authRequests.length, 2);
});

test('late failure cannot cancel the next worker attempt', async () => {
  const requestIds = ['collector-attempt-1', 'collector-attempt-2'];
  const harness = createHarness({
    newRequestId: () => requestIds.shift(),
  });

  await harness.coordinator.retryNow();
  await harness.coordinator.begin({
    requestId: 'collector-attempt-1',
    generationId: G1,
  });
  await harness.coordinator.accept({
    requestId: 'collector-attempt-1',
    generationId: G1,
  });
  await harness.coordinator.fail({
    requestId: 'collector-attempt-1',
    generationId: G1,
    error: { code: 'LOCAL_SERVICE_UNAVAILABLE' },
  });

  await harness.coordinator.retryNow();
  await harness.coordinator.begin({
    requestId: 'collector-attempt-2',
    generationId: G1,
  });
  await harness.coordinator.fail({
    requestId: 'collector-attempt-1',
    generationId: G1,
    error: { code: 'WEB_LOGIN_REQUIRED' },
  });

  assert.equal((await harness.coordinator.getStatus()).phase, 'REQUESTING_TICKET');
});

test('accepted response timeout rotates to the next tab once', async () => {
  const requestIds = ['collector-attempt-1', 'collector-attempt-2'];
  const selectedTabIds = [];
  let concurrentPageRequests = 0;
  let maxConcurrentPageRequests = 0;
  const harness = createHarness({
    newRequestId: () => requestIds.shift(),
    requestAuth: async () => {
      concurrentPageRequests += 1;
      maxConcurrentPageRequests = Math.max(maxConcurrentPageRequests, concurrentPageRequests);
      selectedTabIds.push(selectedTabIds.length === 0 ? 10 : 11);
      concurrentPageRequests -= 1;
      return { requested: true };
    },
  });

  await harness.coordinator.retryNow();
  await harness.coordinator.begin({
    requestId: 'collector-attempt-1',
    generationId: G1,
  });
  await harness.coordinator.accept({
    requestId: 'collector-attempt-1',
    generationId: G1,
  });
  const responseWatchdog = harness.timers.find(
    ({ cancelled, milliseconds }) => !cancelled && milliseconds === 31_000,
  );
  assert.ok(responseWatchdog, 'accepted must arm the 31-second coordinator watchdog');
  harness.setTime(Date.parse('2030-01-01T00:00:31.000Z'));
  responseWatchdog.callback();
  await waitFor(async () => (await harness.coordinator.getStatus()).phase === 'RETRY_WAIT');
  const retry = harness.timers.find(
    ({ cancelled, milliseconds }) => !cancelled && milliseconds === 1_000,
  );
  assert.ok(retry, 'response timeout must schedule the existing bounded retry');
  harness.setTime(Date.parse('2030-01-01T00:00:32.000Z'));
  retry.callback();
  await waitFor(() => harness.authRequests.length === 2);

  assert.deepEqual(selectedTabIds, [10, 11]);
  assert.equal(maxConcurrentPageRequests, 1);
});

test('a terminal transition queued at the final status check wins before the Web request side effect', async () => {
  const harness = createHarness();
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  await harness.coordinator.fail({
    requestId,
    generationId: G1,
    error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
  });
  const finalReadCaptured = deferred();
  const releaseFinalRead = deferred();
  const originalGet = harness.storageSession.get.bind(harness.storageSession);
  let held = false;
  harness.storageSession.get = async (key) => {
    const snapshot = await originalGet(key);
    if (!held && snapshot?.[STORAGE_KEY]?.phase === 'DISCOVERING_WEB') {
      held = true;
      finalReadCaptured.resolve();
      await releaseFinalRead.promise;
    }
    return snapshot;
  };

  const retry = harness.coordinator.retryNow();
  await finalReadCaptured.promise;
  const succeeded = harness.coordinator.succeed({
    requestId: harness.generatedRequestIds.at(-1),
    generationId: G1,
    account: { id: 'account-a', displayName: 'Account A' },
    expiresAt: '2031-01-01T00:00:00.000Z',
  });
  releaseFinalRead.resolve();
  await Promise.all([retry, succeeded]);

  assert.equal((await harness.coordinator.getStatus()).phase, 'AUTHENTICATED');
  assert.equal(harness.authRequests.length, 1);
});

test('manual retry authoritatively rediscovers Web even when the stored status is authenticated', async () => {
  const harness = createHarness();
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  await harness.coordinator.succeed({
    requestId,
    generationId: G1,
    account: { id: 'account-a', displayName: 'Account A' },
    expiresAt: '2031-01-01T00:00:00.000Z',
  });

  const result = await harness.coordinator.retryNow();
  assert.equal(result.requested, true);
  assert.equal(result.status.phase, 'DISCOVERING_WEB');
  assert.deepEqual(harness.authRequests, [
    'collector-coordinator-1',
    'collector-coordinator-2',
  ]);
});

test('stale generation events cannot overwrite the active generation', async () => {
  const harness = createHarness();
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  await harness.coordinator.begin({ requestId, generationId: G2 });
  const before = await harness.coordinator.getStatus();

  for (const operation of [
    () => harness.coordinator.accept({ requestId: 'request-1', generationId: G1 }),
    () => harness.coordinator.exchange({ generationId: G1 }),
    () => harness.coordinator.succeed({
      generationId: G1,
      account: { id: 'stale', displayName: 'Stale' },
      expiresAt: '2031-01-01T00:00:00.000Z',
    }),
    () => harness.coordinator.fail({
      generationId: G1,
      error: { code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR' },
    }),
  ]) {
    assert.deepEqual(await operation(), before);
  }
  assert.deepEqual(await harness.coordinator.getStatus(), before);
  assert.equal(harness.createdAlarms.length, 0);
});

test('a late same-generation accepted event cannot regress exchanging or authenticated status', async () => {
  const harness = createHarness();
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  await harness.coordinator.exchange({ requestId, generationId: G1 });
  const exchanging = await harness.coordinator.getStatus();
  assert.deepEqual(await harness.coordinator.accept({
    requestId: 'request-late-1', generationId: G1,
  }), exchanging);

  await harness.coordinator.succeed({
    requestId,
    generationId: G1,
    account: { id: 'account-a', displayName: 'Account A' },
    expiresAt: '2031-01-01T00:00:00.000Z',
  });
  const authenticated = await harness.coordinator.getStatus();
  assert.deepEqual(await harness.coordinator.accept({
    requestId: 'request-late-2', generationId: G1,
  }), authenticated);
});

test('a generation change fences a stale transition that already captured old storage', async () => {
  const harness = createHarness();
  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  const captured = deferred();
  const release = deferred();
  const originalGet = harness.storageSession.get.bind(harness.storageSession);
  let interceptNextRead = true;
  harness.storageSession.get = async (key) => {
    const snapshot = await originalGet(key);
    if (interceptNextRead) {
      interceptNextRead = false;
      captured.resolve();
      await release.promise;
    }
    return snapshot;
  };

  const staleSuccess = harness.coordinator.succeed({
    requestId,
    generationId: G1,
    account: { id: 'account-stale', displayName: 'Stale' },
    expiresAt: '2031-01-01T00:00:00.000Z',
  });
  await captured.promise;
  const freshBegin = harness.coordinator.begin({ requestId, generationId: G2 });
  await Promise.resolve();
  await Promise.resolve();
  release.resolve();
  await Promise.all([staleSuccess, freshBegin]);

  const status = await harness.coordinator.getStatus();
  assert.equal(status.generationId, G2);
  assert.equal(status.phase, 'REQUESTING_TICKET');
  assert.equal(status.account, null);
});

test('a restarted coordinator resumes one due retry, restores a future alarm, or projects a valid session', async () => {
  const dueTime = Date.parse('2030-01-01T00:00:05.000Z');
  const retryStatus = {
    version: 1,
    phase: 'RETRY_WAIT',
    generationId: G1,
    startedAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    attemptNumber: 2,
    nextRetryAt: '2030-01-01T00:00:04.000Z',
    publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
    account: null,
    expiresAt: '',
  };
  const pendingRequest = deferred();
  const due = createHarness({
    initial: { [STORAGE_KEY]: retryStatus },
    requestAuth: () => pendingRequest.promise,
    start: dueTime,
  });
  const first = due.coordinator.resume();
  const second = due.coordinator.resume();
  await waitFor(() => due.authRequests.length === 1);
  assert.equal(due.authRequests.length, 1);
  pendingRequest.resolve({ requested: true });
  await Promise.all([first, second]);

  const future = createHarness({
    initial: {
      [STORAGE_KEY]: {
        ...retryStatus,
        nextRetryAt: '2030-01-01T00:00:06.000Z',
      },
    },
    start: dueTime,
  });
  await future.coordinator.resume();
  assert.equal(future.authRequests.length, 0);
  assert.deepEqual(future.createdAlarms, [{
    name: ALARM_NAME,
    options: { when: Date.parse('2030-01-01T00:00:35.000Z') },
  }]);
  assert.equal(future.timers[0].milliseconds, 1_000);

  const authenticated = createHarness({
    initial: { [STORAGE_KEY]: retryStatus },
    session: {
      generationId: G1,
      collectorToken: 'cst_credential_read_only_by_session_manager_123456789',
      account: { id: 'account-a', displayName: 'Account A', token: 'never' },
      permissions: ['collector.upload'],
      expiresAt: '2030-01-02T00:00:00.000Z',
    },
  });
  const resumed = await authenticated.coordinator.resume();
  assert.equal(resumed.phase, 'AUTHENTICATED');
  assert.deepEqual(resumed.account, { id: 'account-a', displayName: 'Account A' });
  assert.equal(authenticated.authRequests.length, 0);

  const missingCredential = createHarness({
    initial: {
      [STORAGE_KEY]: {
        ...retryStatus,
        phase: 'AUTHENTICATED',
        attemptNumber: 0,
        nextRetryAt: '',
        publicCode: '',
        account: { id: 'account-a', displayName: 'Account A' },
        expiresAt: '2030-01-02T00:00:00.000Z',
      },
    },
  });
  const reconciled = await missingCredential.coordinator.resume();
  assert.equal(reconciled.phase, 'WAITING_FOR_WEB');
  assert.equal(reconciled.publicCode, 'WEB_LOGIN_REQUIRED');
  assert.equal(missingCredential.authRequests.length, 0);

  const noPersistedWork = createHarness();
  const idle = await noPersistedWork.coordinator.resume();
  assert.equal(idle.phase, 'WAITING_FOR_WEB');
  assert.equal(noPersistedWork.authRequests.length, 0);

  const interrupted = createHarness({
    initial: {
      [STORAGE_KEY]: {
        ...retryStatus,
        phase: 'EXCHANGING',
        nextRetryAt: '',
        publicCode: '',
      },
    },
  });
  const resumedInterrupted = await interrupted.coordinator.resume();
  assert.equal(resumedInterrupted.phase, 'DISCOVERING_WEB');
  assert.equal(interrupted.authRequests.length, 1);
});

test('impossible persisted states rewrite to a safe terminal status without cold-start discovery', async () => {
  const base = {
    version: 1,
    phase: 'WAITING_FOR_WEB',
    generationId: G1,
    startedAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    attemptNumber: 1,
    nextRetryAt: '',
    publicCode: '',
    account: null,
    expiresAt: '',
  };
  const cases = [
    [
      { ...base, phase: 'REQUESTING_TICKET', generationId: '' },
      'ACTION_REQUIRED',
      'TRUST_BOUNDARY_REJECTED',
    ],
    [
      { ...base, phase: 'DISCOVERING_WEB', generationId: '' },
      'ACTION_REQUIRED',
      'TRUST_BOUNDARY_REJECTED',
    ],
    [
      {
        ...base,
        phase: 'RETRY_WAIT',
        publicCode: 'ACCOUNT_DISABLED',
        nextRetryAt: '2030-01-01T00:00:01.000Z',
      },
      'ACTION_REQUIRED',
      'SERVER_UPGRADE_REQUIRED',
    ],
    [
      {
        ...base,
        phase: 'RETRY_WAIT',
        publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
        nextRetryAt: 'not-a-date',
      },
      'ACTION_REQUIRED',
      'SERVER_UPGRADE_REQUIRED',
    ],
    [
      {
        ...base,
        phase: 'RETRY_WAIT',
        attemptNumber: 0,
        publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
        nextRetryAt: '2030-01-01T00:00:01.000Z',
      },
      'ACTION_REQUIRED',
      'SERVER_UPGRADE_REQUIRED',
    ],
    [
      { ...base, phase: 'EXCHANGING', startedAt: '' },
      'ACTION_REQUIRED',
      'SERVER_UPGRADE_REQUIRED',
    ],
    [
      {
        ...base,
        phase: 'AUTHENTICATED',
        account: null,
        expiresAt: '2031-01-01T00:00:00.000Z',
      },
      'WAITING_FOR_WEB',
      'WEB_LOGIN_REQUIRED',
    ],
    [
      {
        ...base,
        phase: 'AUTHENTICATED',
        account: { id: 'account-a', displayName: 'Account A' },
        expiresAt: '2029-12-31T23:59:59.000Z',
      },
      'WAITING_FOR_WEB',
      'WEB_LOGIN_REQUIRED',
    ],
  ];

  for (const [raw, phase, publicCode] of cases) {
    const harness = createHarness({ initial: { [STORAGE_KEY]: raw } });
    const status = await harness.coordinator.getStatus();
    assert.equal(status.phase, phase);
    assert.equal(status.publicCode, publicCode);
    assert.equal(status.nextRetryAt, '');
    assert.equal(status.account, null);
    assert.equal(status.expiresAt, '');
    assert.deepEqual(plain(harness.state[STORAGE_KEY]), plain(status));

    await harness.coordinator.resume();
    assert.equal(harness.authRequests.length, 0);
    assert.ok(harness.clearedAlarms.includes(ALARM_NAME));
  }
});

test('persisted retry timestamps enforce ordering and the thirty-second hard cap', async () => {
  const base = {
    version: 1,
    phase: 'RETRY_WAIT',
    generationId: G1,
    startedAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:05.000Z',
    attemptNumber: 1,
    nextRetryAt: '2030-01-01T00:00:06.000Z',
    publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
    account: null,
    expiresAt: '',
  };
  const corrupt = [
    { ...base, nextRetryAt: '2030-01-01T00:00:04.999Z' },
    { ...base, nextRetryAt: '2030-01-01T00:00:05.000Z' },
    { ...base, nextRetryAt: '2030-01-01T00:00:35.001Z' },
    { ...base, startedAt: '2030-01-01T00:00:05.001Z' },
    { ...base, attemptNumber: 0 },
    { ...base, publicCode: 'ACCOUNT_DISABLED' },
  ];

  for (const raw of corrupt) {
    const harness = createHarness({
      initial: { [STORAGE_KEY]: raw },
      start: Date.parse('2030-01-01T00:00:05.000Z'),
    });
    const status = await harness.coordinator.getStatus();
    assert.equal(status.phase, 'ACTION_REQUIRED');
    assert.equal(status.publicCode, 'SERVER_UPGRADE_REQUIRED');
    assert.equal(status.nextRetryAt, '');

    await harness.coordinator.resume();
    assert.equal(harness.authRequests.length, 0);
  }

  const boundary = createHarness({
    initial: {
      [STORAGE_KEY]: {
        ...base,
        nextRetryAt: '2030-01-01T00:00:35.000Z',
      },
    },
    start: Date.parse('2030-01-01T00:00:05.000Z'),
  });
  const status = await boundary.coordinator.getStatus();
  assert.equal(status.phase, 'RETRY_WAIT');
  assert.equal(status.nextRetryAt, '2030-01-01T00:00:35.000Z');

  await boundary.coordinator.resume();
  assert.equal(boundary.authRequests.length, 0);
  assert.deepEqual(boundary.createdAlarms.at(-1), {
    name: ALARM_NAME,
    options: { when: Date.parse('2030-01-01T00:00:35.000Z') },
  });
});

test('persisted status projection clears fields that are incoherent for its phase', async () => {
  const harness = createHarness({
    initial: {
      [STORAGE_KEY]: {
        version: 1,
        phase: 'WAITING_FOR_WEB',
        generationId: G1,
        startedAt: '2030-01-01T00:00:00.000Z',
        updatedAt: '2030-01-01T00:00:00.000Z',
        attemptNumber: 7,
        nextRetryAt: '2030-01-01T00:00:01.000Z',
        publicCode: 'ACCOUNT_DISABLED',
        account: { id: 'account-a', displayName: 'Account A' },
        expiresAt: '2031-01-01T00:00:00.000Z',
      },
    },
  });

  const status = await harness.coordinator.getStatus();
  assert.equal(status.phase, 'WAITING_FOR_WEB');
  assert.equal(status.publicCode, '');
  assert.equal(status.nextRetryAt, '');
  assert.equal(status.account, null);
  assert.equal(status.expiresAt, '');
});

test('stored and returned status never contains credential keys, credential values, request IDs, or raw errors', async () => {
  const forbiddenValues = [
    'Bearer stolen-parent-session',
    'cst_stolen_collector_session_123456789',
    'request-should-not-survive',
    'ctt_stolen_ticket_123456789',
    'machine-v3-never',
    'collector-request-value-must-not-be-stored-123456789',
    'Bearer parent-secret ctt_raw_ticket_123456789',
    'cst_raw_collector_token_123456789',
  ];
  const assertClosedAndCredentialFree = (status) => {
    assert.deepEqual(Object.keys(status).sort(), STATUS_KEYS);
    if (status.account) assert.deepEqual(Object.keys(status.account).sort(), ['displayName', 'id']);
    const serialized = JSON.stringify(status);
    for (const value of forbiddenValues) assert.equal(serialized.includes(value), false, value);
  };
  const harness = createHarness({
    newRequestId: () => 'collector-request-value-must-not-be-stored-123456789',
    initial: {
      [STORAGE_KEY]: {
        version: 1,
        phase: 'AUTHENTICATED',
        generationId: G1,
        startedAt: '2030-01-01T00:00:00.000Z',
        updatedAt: '2030-01-01T00:00:00.000Z',
        attemptNumber: 0,
        nextRetryAt: '',
        publicCode: '',
        account: {
          id: 'account-a',
          displayName: 'Bearer stolen-parent-session',
          token: 'cst_stolen_collector_session_123456789',
        },
        expiresAt: '2030-01-02T00:00:00.000Z',
        requestId: 'request-should-not-survive',
        rawError: 'ctt_stolen_ticket_123456789',
        deviceFingerprint: 'machine-v3-never',
      },
    },
  });

  const sanitized = await harness.coordinator.getStatus();
  assertClosedAndCredentialFree(sanitized);

  const requestId = await startAttempt(harness);
  await harness.coordinator.begin({ requestId, generationId: G1 });
  await harness.coordinator.accept({
    requestId,
    generationId: G1,
  });
  await harness.coordinator.fail({
    requestId,
    generationId: G1,
    error: {
      code: 'COLLECTOR_EXCHANGE_NETWORK_ERROR',
      message: 'Bearer parent-secret ctt_raw_ticket_123456789',
      stack: 'cst_raw_collector_token_123456789',
      authorization: 'Bearer never',
      deviceFingerprint: 'machine-v3-never',
    },
  });

  for (const write of harness.writes) {
    assertClosedAndCredentialFree(write[STORAGE_KEY]);
  }
});

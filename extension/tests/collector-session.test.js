const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
  COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
  PENDING_UPLOADS_STORAGE_KEY,
  COLLECTOR_PERMISSIONS,
  COLLECTOR_SESSION_STORAGE_KEY,
  createCollectorSessionManager,
  isRetryableCollectorUploadStatus,
  sanitizeCollectorDiagnostic,
  withoutCollectorScope,
} = require('../lib/collector-session.js');

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
  async text() { return JSON.stringify(body); },
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function storageArea(state, calls, name) {
  return {
    async get(key) {
      calls.push([name, 'get', key]);
      if (key == null) return { ...state };
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((item) => [item, state[item]]));
      }
      return { [key]: state[key] };
    },
    async set(values) {
      calls.push([name, 'set', values]);
      Object.assign(state, values);
    },
    async remove(key) {
      calls.push([name, 'remove', key]);
      for (const item of Array.isArray(key) ? key : [key]) delete state[item];
    },
  };
}

function createHarness({
  now = Date.parse('2030-01-01T00:00:00.000Z'),
  fetchImpl,
  createExchangeSignal,
  newGenerationIncarnation,
} = {}) {
  const calls = [];
  const sessionState = {};
  const localState = {};
  const syncState = {};
  const chromeApi = {
    storage: {
      session: storageArea(sessionState, calls, 'session'),
      local: storageArea(localState, calls, 'local'),
      sync: storageArea(syncState, calls, 'sync'),
    },
  };
  const logs = [];
  let incarnationSequence = 0;
  const manager = createCollectorSessionManager({
    chromeApi,
    backendUrl: async () => 'http://127.0.0.1:3000/api',
    fetchImpl: fetchImpl || (async () => jsonResponse(500, { code: 'UNEXPECTED_FETCH' })),
    createExchangeSignal,
    now: () => now,
    newGenerationIncarnation: newGenerationIncarnation
      || (() => `collector_activation_${++incarnationSequence}_1234`),
    logger: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  });
  return { calls, chromeApi, localState, logs, manager, sessionState, syncState };
}

const validSession = (overrides = {}) => ({
  collectorToken: 'cst_collector_secret_123456789',
  expiresAt: '2030-01-01T01:00:00.000Z',
  account: { id: 'account-a', displayName: 'A' },
  permissions: [...COLLECTOR_PERMISSIONS],
  ...overrides,
});

test('collector token is persisted only in chrome.storage.session and unsafe fields are discarded', async () => {
  const harness = createHarness();
  const saved = await harness.manager.setCollectorSession({
    ...validSession(),
    token: 'web-bearer',
    accessToken: 'web-access-token',
    storeId: 'store-1',
  });

  assert.deepEqual(saved, validSession());
  assert.equal(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY].collectorToken, validSession().collectorToken);
  assert.equal(JSON.stringify(harness.localState).includes(validSession().collectorToken), false);
  assert.deepEqual(harness.syncState, {});
  assert.equal(
    harness.calls
      .filter(([area, method]) => area === 'local' && method === 'set')
      .some(([, , value]) => JSON.stringify(value).includes(validSession().collectorToken)),
    false,
  );
  assert.equal(harness.calls.some(([area, method]) => area === 'sync' && method === 'set'), false);
  assert.equal(JSON.stringify(harness.sessionState).includes('web-bearer'), false);
  assert.equal(JSON.stringify(harness.sessionState).includes('store-1'), false);
});

test('safe session permission allowlist retains Ozon read and discards arbitrary permissions', async () => {
  const harness = createHarness();
  const saved = await harness.manager.setCollectorSession(validSession({
    permissions: [
      'collector.upload',
      'collector.ozon.read',
      'collector.admin',
      'ozon.sync',
    ],
  }));

  assert.deepEqual(saved.permissions, ['collector.upload', 'collector.ozon.read']);
  assert.equal(saved.permissions.includes('collector.admin'), false);
  assert.equal(saved.permissions.includes('ozon.sync'), false);
});

test('expired collector sessions are cleared from session storage', async () => {
  const harness = createHarness();
  harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY] = validSession({
    expiresAt: '2029-12-31T23:59:59.000Z',
  });
  assert.equal(await harness.manager.getCollectorSession(), null);
  assert.equal(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
});

test('activating a new Collector generation clears the previous session and is idempotent', async () => {
  const harness = createHarness();
  await harness.manager.setCollectorSession(validSession());

  assert.deepEqual(
    await harness.manager.activateCollectorGeneration('generation_A_1234'),
    { changed: true },
  );
  assert.equal(await harness.manager.getCollectorSession(), null);
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY],
    'generation_A_1234',
  );
  assert.equal(
    COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
    'sonliCollectorAuthIncarnation',
  );
  const firstIncarnation = harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY];
  assert.equal(firstIncarnation, 'collector_activation_1_1234');
  assert.deepEqual(
    await harness.manager.activateCollectorGeneration('generation_A_1234'),
    { changed: false },
  );
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY],
    firstIncarnation,
  );
});

test('activating a new generation reuses only an unexpired exact-account session', async () => {
  const harness = createHarness();
  const session = validSession({
    permissions: ['collector.upload', 'collector.admin'],
  });
  await harness.manager.setCollectorSession(session);
  const callsBeforeActivation = harness.calls.length;

  assert.deepEqual(
    await harness.manager.activateCollectorGeneration({
      generationId: 'generation_A_1234',
      accountIdHint: 'account-a',
    }),
    {
      changed: true,
      reused: true,
      authenticated: true,
      account: { id: 'account-a', displayName: 'A' },
      permissions: ['collector.upload'],
      expiresAt: '2030-01-01T01:00:00.000Z',
    },
  );
  assert.equal(
    harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY].collectorToken,
    session.collectorToken,
  );
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY],
    'generation_A_1234',
  );
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY],
    'collector_activation_1_1234',
  );
  assert.deepEqual(
    harness.calls.slice(callsBeforeActivation).filter(([, operation]) => operation === 'get'),
    [[
      'session',
      'get',
      [
        COLLECTOR_SESSION_STORAGE_KEY,
        COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
        COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
      ],
    ]],
  );
});

test('account mismatch, missing or malformed hints, and expired sessions clear credentials', async () => {
  const cases = [
    { name: 'different account', accountIdHint: 'account-b' },
    { name: 'missing hint' },
    { name: 'non-string hint', accountIdHint: 123 },
    { name: 'whitespace hint', accountIdHint: ' account-a ' },
    { name: 'oversized hint', accountIdHint: 'a'.repeat(129) },
    {
      name: 'expired session',
      accountIdHint: 'account-a',
      session: validSession({ expiresAt: '2029-12-31T23:59:59.000Z' }),
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    const harness = createHarness();
    await harness.manager.setCollectorSession(scenario.session || validSession());

    assert.deepEqual(
      await harness.manager.activateCollectorGeneration({
        generationId: `generation_case_${index}_1234`,
        ...(Object.hasOwn(scenario, 'accountIdHint')
          ? { accountIdHint: scenario.accountIdHint }
          : {}),
      }),
      {
        changed: true,
        reused: false,
        authenticated: false,
        account: null,
        permissions: [],
        expiresAt: '',
      },
      scenario.name,
    );
    assert.equal(
      harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY],
      undefined,
      scenario.name,
    );
  }
});

test('corrupted raw stored sessions cannot be reused as authenticated', async (t) => {
  const malformedAccountArray = [];
  malformedAccountArray.id = 'account-a';
  malformedAccountArray.displayName = 'Malformed';
  const malformedSessionArray = Object.assign([], validSession());
  const cases = [
    {
      name: 'object Collector token',
      session: validSession({ collectorToken: { bad: true } }),
    },
    {
      name: 'numeric Collector token',
      session: validSession({ collectorToken: 123 }),
    },
    {
      name: 'padded Collector token',
      session: validSession({ collectorToken: ' cst_collector_secret_123456789 ' }),
    },
    {
      name: 'object account ID',
      accountIdHint: '[object Object]',
      session: validSession({
        account: { id: { bad: true }, displayName: 'Malformed' },
      }),
    },
    {
      name: 'numeric account ID',
      accountIdHint: '123',
      session: validSession({ account: { id: 123, displayName: 'Malformed' } }),
    },
    {
      name: 'padded account ID',
      session: validSession({ account: { id: ' account-a ', displayName: 'Malformed' } }),
    },
    {
      name: 'non-record account',
      session: validSession({ account: malformedAccountArray }),
    },
    {
      name: 'non-record session',
      session: malformedSessionArray,
    },
    {
      name: 'non-string expiry',
      session: validSession({ expiresAt: new Date('2030-01-01T01:00:00.000Z') }),
    },
    {
      name: 'malformed expiry',
      session: validSession({ expiresAt: 'not-a-date' }),
    },
    {
      name: 'padded expiry',
      session: validSession({ expiresAt: ' 2030-01-01T01:00:00.000Z ' }),
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      const harness = createHarness();
      harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY] = scenario.session;

      assert.deepEqual(
        await harness.manager.activateCollectorGeneration({
          generationId: `generation_corrupt_${index}_1234`,
          accountIdHint: scenario.accountIdHint || 'account-a',
        }),
        {
          changed: true,
          reused: false,
          authenticated: false,
          account: null,
          permissions: [],
          expiresAt: '',
        },
      );
      assert.equal(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
    });
  }
});

test('malformed permission entries cannot expand a reused session permission set', async () => {
  const harness = createHarness();
  harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY] = validSession({
    permissions: [
      'collector.upload',
      { toString: () => 'collector.job.read' },
      123,
      'collector.admin',
    ],
  });

  const result = await harness.manager.activateCollectorGeneration({
    generationId: 'generation_permissions_1234',
    accountIdHint: 'account-a',
  });

  assert.equal(result.reused, true);
  assert.deepEqual(result.permissions, ['collector.upload']);
});

test('same-account rebinding still fences a stale generation exchange', async () => {
  const staleResponse = deferred();
  const originalSession = validSession({
    collectorToken: 'cst_original_session_secret_123456789',
  });
  const staleSession = validSession({
    collectorToken: 'cst_stale_exchange_secret_123456789',
  });
  let exchangeCalls = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      exchangeCalls += 1;
      return staleResponse.promise;
    },
  });
  await harness.manager.activateCollectorGeneration('generation_G1_1234');
  await harness.manager.setCollectorSession(originalSession);

  const staleExchange = harness.manager.exchangeCollectorTicket({
    ticket: 'ctt_stale_rebind_secret_123456789',
    generationId: 'generation_G1_1234',
  });
  while (exchangeCalls < 1) await new Promise((resolve) => setImmediate(resolve));

  const activation = await harness.manager.activateCollectorGeneration({
    generationId: 'generation_G2_5678',
    accountIdHint: 'account-a',
  });
  assert.equal(activation.reused, true);
  staleResponse.resolve(jsonResponse(200, { data: staleSession }));

  await assert.rejects(
    staleExchange,
    (error) => error?.code === 'COLLECTOR_AUTH_GENERATION_CHANGED',
  );
  assert.equal(
    harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY].collectorToken,
    originalSession.collectorToken,
  );
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY],
    'generation_G2_5678',
  );
});

async function assertFailedSuccessorIncarnationFencesOldExchange({
  createSuccessorIncarnation,
  expectedActivationError,
}) {
  const oldExchangeResponse = deferred();
  const oldSession = validSession({
    collectorToken: 'cst_old_activation_must_not_restore_123456789',
    account: { id: 'account-old-activation', displayName: 'Old Activation' },
  });
  let exchangeCalls = 0;
  let incarnationCalls = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      exchangeCalls += 1;
      return oldExchangeResponse.promise;
    },
    newGenerationIncarnation: () => {
      incarnationCalls += 1;
      if (incarnationCalls === 1) return 'collector_activation_initial_1234';
      return createSuccessorIncarnation();
    },
  });

  await harness.manager.activateCollectorGeneration('generation_G1_1234');
  const oldExchange = harness.manager.exchangeCollectorTicket({
    ticket: 'ctt_old_activation_secret_123456789',
    generationId: 'generation_G1_1234',
  });
  while (exchangeCalls < 1) await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    harness.manager.activateCollectorGeneration('generation_G2_5678'),
    expectedActivationError,
  );
  assert.equal(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY], undefined);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY], undefined);

  oldExchangeResponse.resolve(jsonResponse(200, { data: oldSession }));
  await assert.rejects(
    oldExchange,
    (error) => error?.code === 'COLLECTOR_AUTH_GENERATION_CHANGED',
  );
  assert.equal(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY], undefined);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY], undefined);
  assert.equal(
    harness.calls.some(([area, operation, values]) => (
      area === 'session'
      && operation === 'set'
      && values?.[COLLECTOR_SESSION_STORAGE_KEY]?.account?.id === 'account-old-activation'
    )),
    false,
  );
}

test('successor activation clears the old activation before its incarnation factory throws', async () => {
  await assertFailedSuccessorIncarnationFencesOldExchange({
    createSuccessorIncarnation() {
      throw new Error('INCARNATION_FACTORY_FAILED');
    },
    expectedActivationError: /INCARNATION_FACTORY_FAILED/,
  });
});

test('successor activation clears the old activation before rejecting an invalid incarnation', async () => {
  await assertFailedSuccessorIncarnationFencesOldExchange({
    createSuccessorIncarnation: () => 'invalid',
    expectedActivationError: (error) => error?.code === 'COLLECTOR_AUTH_INCARNATION_INVALID',
  });
});

test('duplicate active generation remains idempotent when the successor incarnation factory would fail', async () => {
  let incarnationCalls = 0;
  const harness = createHarness({
    newGenerationIncarnation: () => {
      incarnationCalls += 1;
      if (incarnationCalls === 1) return 'collector_activation_initial_1234';
      throw new Error('DUPLICATE_MUST_NOT_CREATE_INCARNATION');
    },
  });
  await harness.manager.activateCollectorGeneration('generation_G1_1234');
  await harness.manager.setCollectorSession(validSession());
  const incarnation = harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY];

  assert.deepEqual(
    await harness.manager.activateCollectorGeneration('generation_G1_1234'),
    { changed: false },
  );
  assert.equal(incarnationCalls, 1);
  assert.deepEqual(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], validSession());
  assert.equal(harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY], 'generation_G1_1234');
  assert.equal(harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY], incarnation);
});

test('clearing and reactivating the same generation rotates its activation incarnation', async () => {
  const harness = createHarness();

  await harness.manager.activateCollectorGeneration('generation_G1_1234');
  const firstIncarnation = harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY];
  assert.equal(await harness.manager.clearCollectorGeneration('generation_G1_1234'), true);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY], undefined);

  assert.deepEqual(
    await harness.manager.activateCollectorGeneration('generation_G1_1234'),
    { changed: true },
  );
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY],
    'collector_activation_2_1234',
  );
  assert.notEqual(
    harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY],
    firstIncarnation,
  );
});

test('internal logout invalidates session generation and activation incarnation together', async () => {
  const harness = createHarness();
  await harness.manager.activateCollectorGeneration('generation_G1_1234');
  await harness.manager.setCollectorSession(validSession());

  assert.equal(await harness.manager.logoutCollectorSession(), true);

  assert.equal(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY], undefined);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY], undefined);
});

test('missing or malformed legacy incarnation is inactive and is replaced on begin', async () => {
  for (const legacyIncarnation of [undefined, 'short', 'incarnation has spaces']) {
    let fetchCalls = 0;
    const harness = createHarness({
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse(200, { data: validSession() });
      },
    });
    harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY] = 'generation_G1_1234';
    harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY] = validSession();
    if (legacyIncarnation !== undefined) {
      harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY] = legacyIncarnation;
    }

    await assert.rejects(
      harness.manager.exchangeCollectorTicket({
        ticket: 'ctt_legacy_incarnation_secret_123456789',
        generationId: 'generation_G1_1234',
      }),
      (error) => error?.code === 'COLLECTOR_AUTH_GENERATION_CHANGED',
    );
    assert.equal(fetchCalls, 0);
    assert.deepEqual(
      await harness.manager.activateCollectorGeneration('generation_G1_1234'),
      { changed: true },
    );
    assert.equal(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
    assert.equal(
      harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY],
      'collector_activation_1_1234',
    );
  }
});

test('clearing a stale Collector generation cannot remove the active generation session', async () => {
  const harness = createHarness();
  await harness.manager.activateCollectorGeneration('generation_B_5678');
  await harness.manager.setCollectorSession(validSession({
    account: { id: 'account-b', displayName: 'B' },
  }));

  assert.equal(
    await harness.manager.clearCollectorGeneration('generation_A_1234'),
    false,
  );
  assert.equal((await harness.manager.getCollectorSession()).account.id, 'account-b');
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY],
    'generation_B_5678',
  );
  assert.equal(
    await harness.manager.clearCollectorGeneration('generation_B_5678'),
    true,
  );
  assert.equal(await harness.manager.getCollectorSession(), null);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY], undefined);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY], undefined);
  const generationWritesBeforeRetry = harness.calls.filter(
    ([area, method]) => area === 'session' && (method === 'set' || method === 'remove'),
  ).length;
  assert.equal(
    await harness.manager.clearCollectorGeneration('generation_B_5678'),
    false,
  );
  assert.equal(
    harness.calls.filter(
      ([area, method]) => area === 'session' && (method === 'set' || method === 'remove'),
    ).length,
    generationWritesBeforeRetry,
  );
});

test('failed G2 marker write leaves no active generation and held G1 exchange cannot restore its session', async () => {
  const g1Response = deferred();
  let exchangeCalls = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      exchangeCalls += 1;
      return g1Response.promise;
    },
  });
  await harness.manager.activateCollectorGeneration('generation_G1_1234');
  await harness.manager.setCollectorSession(validSession());

  const heldG1Exchange = harness.manager.exchangeCollectorTicket({
    ticket: 'ctt_failed_g2_transition_secret_123456789',
    generationId: 'generation_G1_1234',
  });
  while (exchangeCalls < 1) await new Promise((resolve) => setImmediate(resolve));

  const callsBeforeG2 = harness.calls.length;
  const originalSet = harness.chromeApi.storage.session.set.bind(
    harness.chromeApi.storage.session,
  );
  harness.chromeApi.storage.session.set = async (values) => {
    if (values?.[COLLECTOR_AUTH_GENERATION_STORAGE_KEY] === 'generation_G2_5678') {
      throw new Error('simulated generation activation failure');
    }
    return originalSet(values);
  };

  await assert.rejects(
    harness.manager.activateCollectorGeneration('generation_G2_5678'),
    /simulated generation activation failure/,
  );
  assert.deepEqual(
    harness.calls
      .slice(callsBeforeG2)
      .filter(([area, method]) => area === 'session' && method === 'remove'),
    [[
      'session',
      'remove',
      [
        COLLECTOR_SESSION_STORAGE_KEY,
        COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
        COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
      ],
    ]],
  );
  assert.equal(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY], undefined);
  assert.equal(harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY], undefined);

  g1Response.resolve(jsonResponse(200, { data: validSession() }));
  await assert.rejects(
    heldG1Exchange,
    (error) => error?.code === 'COLLECTOR_AUTH_GENERATION_CHANGED',
  );
  assert.equal(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
});

test('matching generation logout failure retains one coherent session and generation state', async () => {
  const harness = createHarness();
  await harness.manager.activateCollectorGeneration('generation_G2_5678');
  await harness.manager.setCollectorSession(validSession());
  const originalRemove = harness.chromeApi.storage.session.remove.bind(
    harness.chromeApi.storage.session,
  );
  let combinedInvalidations = 0;
  harness.chromeApi.storage.session.remove = async (keys) => {
    if (
      Array.isArray(keys)
      && keys.length === 3
      && keys[0] === COLLECTOR_SESSION_STORAGE_KEY
      && keys[1] === COLLECTOR_AUTH_GENERATION_STORAGE_KEY
      && keys[2] === COLLECTOR_AUTH_INCARNATION_STORAGE_KEY
    ) {
      combinedInvalidations += 1;
      throw new Error('simulated generation clear failure');
    }
    return originalRemove(keys);
  };

  await assert.rejects(
    harness.manager.clearCollectorGeneration('generation_G2_5678'),
    /simulated generation clear failure/,
  );
  assert.equal(combinedInvalidations, 1);
  assert.deepEqual(
    harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY],
    validSession(),
  );
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY],
    'generation_G2_5678',
  );
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY],
    'collector_activation_1_1234',
  );
});

test('Collector generation IDs reject malformed values before storage or network side effects', async () => {
  let fetchCalls = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(200, { data: validSession() });
    },
  });
  const invalidGenerationIds = [
    'too_short',
    'generation has spaces',
    'g'.repeat(129),
  ];

  for (const generationId of invalidGenerationIds) {
    await assert.rejects(
      () => harness.manager.activateCollectorGeneration(generationId),
      (error) => error?.code === 'COLLECTOR_AUTH_GENERATION_INVALID',
    );
    await assert.rejects(
      () => harness.manager.clearCollectorGeneration(generationId),
      (error) => error?.code === 'COLLECTOR_AUTH_GENERATION_INVALID',
    );
    await assert.rejects(
      () => harness.manager.exchangeCollectorTicket({
        ticket: 'ctt_invalid_generation_secret_123456789',
        generationId,
      }),
      (error) => error?.code === 'COLLECTOR_AUTH_GENERATION_INVALID',
    );
  }

  assert.equal(fetchCalls, 0);
  assert.deepEqual(harness.sessionState, {});
});

test('ticket exchange requires its generation to be active before the network request', async () => {
  let fetchCalls = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(200, { data: validSession() });
    },
  });

  await assert.rejects(
    harness.manager.exchangeCollectorTicket({
      ticket: 'ctt_inactive_generation_secret_123456789',
      generationId: 'generation_inactive_1234',
    }),
    (error) => error?.code === 'COLLECTOR_AUTH_GENERATION_CHANGED',
  );
  assert.equal(fetchCalls, 0);
  assert.equal(await harness.manager.getCollectorSession(), null);
});

test('ticket exchange requests a sixty-second default abort deadline', async () => {
  const requestedTimeouts = [];
  const originalTimeout = globalThis.AbortSignal.timeout;
  const controller = new AbortController();
  globalThis.AbortSignal.timeout = (milliseconds) => {
    requestedTimeouts.push(milliseconds);
    return controller.signal;
  };
  try {
    const harness = createHarness({
      fetchImpl: async () => jsonResponse(200, { data: validSession() }),
    });
    await harness.manager.activateCollectorGeneration('generation_timeout_1234');

    await harness.manager.exchangeCollectorTicket({
      ticket: 'ctt_default_timeout_secret_123456789',
      generationId: 'generation_timeout_1234',
    });

    assert.deepEqual(requestedTimeouts, [60_000]);
  } finally {
    globalThis.AbortSignal.timeout = originalTimeout;
  }
});

test('ticket exchange uses a bounded abort signal and redacts timeout diagnostics', async () => {
  const ticket = 'ctt_timeout_secret_123456789';
  const controller = new AbortController();
  const fetchStarted = deferred();
  let releaseFetch = () => {};
  const harness = createHarness({
    createExchangeSignal: () => controller.signal,
    fetchImpl: async (_url, options) => {
      fetchStarted.resolve(options);
      return new Promise((resolve, reject) => {
        releaseFetch = () => resolve(jsonResponse(500, { code: 'TEST_RELEASE' }));
        options.signal?.addEventListener('abort', () => reject(Object.assign(
          new Error(`timed out while exchanging ${ticket}`),
          { name: 'AbortError' },
        )), { once: true });
      });
    },
  });
  await harness.manager.activateCollectorGeneration('generation_timeout_1234');

  const exchange = harness.manager.exchangeCollectorTicket({
    ticket,
    generationId: 'generation_timeout_1234',
  });
  const requestOptions = await fetchStarted.promise;
  try {
    assert.equal(requestOptions.signal, controller.signal);
    controller.abort();
    await assert.rejects(exchange, (error) => {
      assert.equal(error.code, 'COLLECTOR_EXCHANGE_NETWORK_ERROR');
      assert.equal(error.message.includes(ticket), false);
      return true;
    });
    assert.equal(JSON.stringify(harness.logs).includes(ticket), false);
  } finally {
    releaseFetch();
    await exchange.catch(() => {});
  }
});

test('a stale G1 exchange cannot write after G2 activates or after G2 installs its session', async () => {
  const g1Response = deferred();
  const g2Session = validSession({
    collectorToken: 'cst_generation_g2_secret_123456789',
    account: { id: 'account-g2', displayName: 'G2' },
  });
  let exchangeCalls = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      exchangeCalls += 1;
      return exchangeCalls === 1
        ? g1Response.promise
        : jsonResponse(200, { data: g2Session });
    },
  });

  await harness.manager.activateCollectorGeneration('generation_G1_1234');
  const staleExchange = harness.manager.exchangeCollectorTicket({
    ticket: 'ctt_generation_g1_secret_123456789',
    generationId: 'generation_G1_1234',
  });
  while (exchangeCalls < 1) await new Promise((resolve) => setImmediate(resolve));

  await harness.manager.activateCollectorGeneration('generation_G2_5678');
  g1Response.resolve(jsonResponse(200, { data: validSession() }));

  await assert.rejects(
    staleExchange,
    (error) => error?.code === 'COLLECTOR_AUTH_GENERATION_CHANGED',
  );
  assert.equal(await harness.manager.getCollectorSession(), null);

  const installedG2 = await harness.manager.exchangeCollectorTicket({
    ticket: 'ctt_generation_g2_secret_123456789',
    generationId: 'generation_G2_5678',
  });
  assert.deepEqual(installedG2, g2Session);
  assert.equal(await harness.manager.clearCollectorGeneration('generation_G1_1234'), false);
  assert.deepEqual(await harness.manager.getCollectorSession(), g2Session);
});

test('same-generation reactivation fences an older exchange without locking the network request', async () => {
  const oldResponse = deferred();
  const newSession = validSession({
    collectorToken: 'cst_reactivated_g1_secret_123456789',
    account: { id: 'account-reactivated-g1', displayName: 'Reactivated G1' },
  });
  let exchangeCalls = 0;
  const harness = createHarness({
    fetchImpl: async () => {
      exchangeCalls += 1;
      return exchangeCalls === 1
        ? oldResponse.promise
        : jsonResponse(200, { data: newSession });
    },
  });

  await harness.manager.activateCollectorGeneration('generation_G1_1234');
  const oldIncarnation = harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY];
  const oldExchange = harness.manager.exchangeCollectorTicket({
    ticket: 'ctt_old_g1_incarnation_secret_123456789',
    generationId: 'generation_G1_1234',
  });
  while (exchangeCalls < 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await harness.manager.logoutCollectorSession(), true);
  assert.deepEqual(
    await harness.manager.activateCollectorGeneration('generation_G1_1234'),
    { changed: true },
  );
  const newIncarnation = harness.sessionState[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY];

  oldResponse.resolve(jsonResponse(200, { data: validSession() }));
  await assert.rejects(
    oldExchange,
    (error) => error?.code === 'COLLECTOR_AUTH_GENERATION_CHANGED',
  );
  assert.equal(await harness.manager.getCollectorSession(), null);
  assert.notEqual(newIncarnation, oldIncarnation);

  assert.deepEqual(
    await harness.manager.exchangeCollectorTicket({
      ticket: 'ctt_new_g1_incarnation_secret_123456789',
      generationId: 'generation_G1_1234',
    }),
    newSession,
  );
  assert.deepEqual(await harness.manager.getCollectorSession(), newSession);
});

test('generation activation shares the final exchange session-mutation queue', async () => {
  const harness = createHarness({
    fetchImpl: async () => jsonResponse(200, { data: validSession() }),
  });
  await harness.manager.activateCollectorGeneration('generation_G1_1234');
  const originalGet = harness.chromeApi.storage.session.get.bind(
    harness.chromeApi.storage.session,
  );
  const delayedFinalGenerationRead = deferred();
  let generationGets = 0;
  harness.chromeApi.storage.session.get = async (key) => {
    const captured = await originalGet(key);
    if (
      key === COLLECTOR_AUTH_GENERATION_STORAGE_KEY
      || (
        Array.isArray(key)
        && key.includes(COLLECTOR_AUTH_GENERATION_STORAGE_KEY)
        && key.includes(COLLECTOR_AUTH_INCARNATION_STORAGE_KEY)
      )
    ) {
      generationGets += 1;
      if (generationGets === 2) return delayedFinalGenerationRead.promise;
    }
    return captured;
  };

  const exchange = harness.manager.exchangeCollectorTicket({
    ticket: 'ctt_shared_queue_secret_123456789',
    generationId: 'generation_G1_1234',
  });
  while (generationGets < 2) await new Promise((resolve) => setImmediate(resolve));
  const capturedG1 = await originalGet([
    COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
    COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
  ]);
  const activateG2 = harness.manager.activateCollectorGeneration('generation_G2_5678');
  await new Promise((resolve) => setImmediate(resolve));
  delayedFinalGenerationRead.resolve(capturedG1);

  await Promise.all([exchange, activateG2]);
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY],
    'generation_G2_5678',
  );
  assert.equal(await harness.manager.getCollectorSession(), null);
});

test('activating G2 waits for an older direct session write and clears its result', async () => {
  const harness = createHarness();
  await harness.manager.activateCollectorGeneration('generation_G1_1234');
  const originalSet = harness.chromeApi.storage.session.set.bind(
    harness.chromeApi.storage.session,
  );
  const oldWriteEntered = deferred();
  const releaseOldWrite = deferred();
  let blockNextSessionWrite = true;
  harness.chromeApi.storage.session.set = async (values) => {
    if (blockNextSessionWrite && Object.hasOwn(values, COLLECTOR_SESSION_STORAGE_KEY)) {
      blockNextSessionWrite = false;
      oldWriteEntered.resolve();
      await releaseOldWrite.promise;
    }
    return originalSet(values);
  };

  const oldSessionWrite = harness.manager.setCollectorSession(validSession());
  await oldWriteEntered.promise;
  let activationSettled = false;
  const activateG2 = harness.manager.activateCollectorGeneration('generation_G2_5678');
  activateG2.then(
    () => { activationSettled = true; },
    () => { activationSettled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeOldWrite = activationSettled;

  releaseOldWrite.resolve();
  await Promise.all([oldSessionWrite, activateG2]);

  assert.equal(settledBeforeOldWrite, false);
  assert.equal(
    harness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY],
    'generation_G2_5678',
  );
  assert.equal(await harness.manager.getCollectorSession(), null);
});

test('collectorFetch owns the immutable Collector authorization header and clears on 401/403', async () => {
  const requests = [];
  const harness = createHarness({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(401, { code: 'COLLECTOR_SESSION_REVOKED' });
    },
  });
  await harness.manager.setCollectorSession(validSession());

  const response = await harness.manager.collectorFetch('/sources/ozon/collect', {
    permission: 'collector.upload',
    method: 'POST',
    headers: {
      Authorization: 'Bearer caller-controlled',
      authorization: 'Collector caller-controlled',
      'x-request-id': 'request-4',
    },
  });

  assert.equal(response.status, 401);
  assert.equal(requests[0].options.headers.authorization, `Collector ${validSession().collectorToken}`);
  assert.equal(Object.hasOwn(requests[0].options.headers, 'Authorization'), false);
  assert.equal(JSON.stringify(requests[0].options.headers).includes('caller-controlled'), false);
  assert.equal(await harness.manager.getCollectorSession(), null);
});

test('collectorFetch ignores a late 401 after its request signal is aborted', async () => {
  const response = deferred();
  let requestSignal;
  const harness = createHarness({
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return response.promise;
    },
  });
  await harness.manager.setCollectorSession(validSession());
  const collectorOperation = await harness.manager.beginCollectorOperation();
  const controller = new AbortController();
  const request = harness.manager.collectorFetch('/collector/ozon/enrichment-jobs/available', {
    collectorOperation,
    permission: 'collector.ozon.read',
    method: 'POST',
    signal: controller.signal,
  });
  while (!requestSignal) await new Promise((resolve) => setImmediate(resolve));

  controller.abort();
  assert.equal(requestSignal.aborted, true);
  response.resolve(jsonResponse(401, { code: 'COLLECTOR_SESSION_REVOKED' }));

  await assert.rejects(
    request,
    (error) => error?.name === 'AbortError' && error?.code === 'COLLECTOR_REQUEST_ABORTED',
  );
  assert.deepEqual(await harness.manager.getCollectorSession(), validSession());
  assert.equal(
    harness.calls.some(([area, method]) => area === 'session' && method === 'remove'),
    false,
  );
});

test('collectorFetch aborts when its post-response owner check is delayed before session clearing', async () => {
  const harness = createHarness({
    fetchImpl: async () => jsonResponse(401, { code: 'COLLECTOR_SESSION_REVOKED' }),
  });
  await harness.manager.setCollectorSession(validSession());
  const collectorOperation = await harness.manager.beginCollectorOperation();
  const originalGet = harness.chromeApi.storage.session.get.bind(
    harness.chromeApi.storage.session,
  );
  const delayedOwnerCheck = deferred();
  let sessionGets = 0;
  harness.chromeApi.storage.session.get = async (key) => {
    const stored = await originalGet(key);
    sessionGets += 1;
    if (sessionGets === 2) return delayedOwnerCheck.promise;
    return stored;
  };
  const controller = new AbortController();
  const request = harness.manager.collectorFetch('/collector/ozon/enrichment-jobs/available', {
    collectorOperation,
    permission: 'collector.ozon.read',
    method: 'POST',
    signal: controller.signal,
  });
  while (sessionGets < 2) await new Promise((resolve) => setImmediate(resolve));

  controller.abort();
  delayedOwnerCheck.resolve(await originalGet(COLLECTOR_SESSION_STORAGE_KEY));

  await assert.rejects(
    request,
    (error) => error?.name === 'AbortError' && error?.code === 'COLLECTOR_REQUEST_ABORTED',
  );
  assert.equal(
    harness.calls.some(([area, method]) => area === 'session' && method === 'remove'),
    false,
  );
  assert.deepEqual(await harness.manager.getCollectorSession(), validSession());
});

test('collectorFetch aborts when the conditional session-clear check is delayed', async () => {
  const harness = createHarness({
    fetchImpl: async () => jsonResponse(403, { code: 'COLLECTOR_SESSION_REVOKED' }),
  });
  await harness.manager.setCollectorSession(validSession());
  const collectorOperation = await harness.manager.beginCollectorOperation();
  const originalGet = harness.chromeApi.storage.session.get.bind(
    harness.chromeApi.storage.session,
  );
  const delayedClearCheck = deferred();
  let sessionGets = 0;
  harness.chromeApi.storage.session.get = async (key) => {
    const stored = await originalGet(key);
    sessionGets += 1;
    if (sessionGets === 3) return delayedClearCheck.promise;
    return stored;
  };
  const controller = new AbortController();
  const request = harness.manager.collectorFetch('/collector/ozon/enrichment-jobs/available', {
    collectorOperation,
    permission: 'collector.ozon.read',
    method: 'POST',
    signal: controller.signal,
  });
  for (let attempt = 0; attempt < 20 && sessionGets < 3; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(sessionGets, 3, 'conditional session-clear check must be in flight');

  controller.abort();
  delayedClearCheck.resolve(await originalGet(COLLECTOR_SESSION_STORAGE_KEY));

  await assert.rejects(
    request,
    (error) => error?.name === 'AbortError' && error?.code === 'COLLECTOR_REQUEST_ABORTED',
  );
  assert.equal(
    harness.calls.some(([area, method]) => area === 'session' && method === 'remove'),
    false,
  );
  assert.deepEqual(await harness.manager.getCollectorSession(), validSession());
});

test('ticket expiry is retried exactly once and secret values are redacted', async () => {
  let fetchCalls = 0;
  const tickets = ['ctt_first_secret_123456789', 'ctt_second_secret_123456789'];
  const harness = createHarness({
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(401, {
        code: 'COLLECTOR_TICKET_EXPIRED',
        message: `expired ${tickets[Math.min(fetchCalls - 1, 1)]}`,
      });
    },
  });
  await harness.manager.activateCollectorGeneration('generation_retry_1234');
  let ticketCalls = 0;
  await assert.rejects(
    harness.manager.exchangeCollectorTicketWithRetry({
      requestTicket: async () => ({
        ticket: tickets[ticketCalls++],
        expiresAt: '2030-01-01T00:00:30.000Z',
      }),
      deviceFingerprint: 'machine-v3-test',
      extensionVersion: '1.2.3',
      generationId: 'generation_retry_1234',
    }),
    (error) => {
      assert.equal(error.code, 'COLLECTOR_TICKET_EXPIRED');
      assert.equal(tickets.some((ticket) => error.message.includes(ticket)), false);
      return true;
    },
  );
  assert.equal(ticketCalls, 2);
  assert.equal(fetchCalls, 2);
  assert.equal(tickets.some((ticket) => JSON.stringify(harness.logs).includes(ticket)), false);
});

test('pending uploads stay queued for their account session and a mismatch cannot upload them', async () => {
  const harness = createHarness();
  await harness.manager.setCollectorSession(validSession());
  await harness.manager.enqueuePendingUpload({
    requestId: 'collect-request-1',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-1' },
  });

  await harness.manager.setCollectorSession(validSession({
    collectorToken: 'cst_other_account_secret_123456789',
    account: { id: 'account-b', displayName: 'B' },
  }));
  let uploads = 0;
  const mismatch = await harness.manager.flushPendingUploads(async () => {
    uploads += 1;
    return jsonResponse(200, { ok: true });
  });
  assert.equal(uploads, 0);
  assert.equal(mismatch.blockedAccountMismatch, 1);
  assert.equal((await harness.manager.listPendingUploads()).length, 1);

  await harness.manager.setCollectorSession(validSession({
    collectorToken: 'cst_new_same_account_secret_123456789',
  }));
  const flushed = await harness.manager.flushPendingUploads(async () => {
    uploads += 1;
    return jsonResponse(200, { ok: true });
  });
  assert.equal(uploads, 1);
  assert.equal(flushed.uploaded, 1);
  assert.deepEqual(await harness.manager.listPendingUploads(), []);
});

test('collector scope sanitizer removes every retired canonical key recursively', () => {
  const retiredKeys = [
    'account_id',
    'created-by',
    'Client_Id',
    'storeId',
    'LOCAL_STORE_ID',
    'operating-store-id',
    'data_collection_store_id',
    'Data-Collection-Stores',
    'dataCollectionStoreIds',
    'current_data_collection_store_id',
    'CURRENT-DATA-COLLECTION-STORE-IDS-BY-ACCOUNT',
    'seller_company_id',
    'Seller-Company',
    'legacy_scope',
  ];
  const input = {
    keep: 'root',
    nested: retiredKeys.map((key, index) => ({
      [key]: `retired-${index}`,
      keep: index,
      deeper: [{ [key]: `nested-${index}`, keep: true }],
    })),
  };

  const sanitized = withoutCollectorScope(input);

  assert.equal(sanitized.keep, 'root');
  assert.deepEqual(
    sanitized.nested,
    retiredKeys.map((_, index) => ({
      keep: index,
      deeper: [{ keep: true }],
    })),
  );
});

test('same request ID is isolated by account and conflicting owner reuse is rejected', async () => {
  const harness = createHarness();
  await harness.manager.setCollectorSession(validSession());
  await harness.manager.enqueuePendingUpload({
    requestId: 'shared-request',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-a' },
  });
  await assert.rejects(
    harness.manager.enqueuePendingUpload({
      requestId: 'shared-request',
      path: '/sources/ozon/collect',
      body: { sourceSku: 'different-content' },
    }),
    (error) => error?.code === 'COLLECT_REQUEST_CONFLICT',
  );

  await harness.manager.setCollectorSession(validSession({
    collectorToken: 'csess_account_b_secret_123456789',
    account: { id: 'account-b', displayName: 'B' },
  }));
  await harness.manager.enqueuePendingUpload({
    requestId: 'shared-request',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-b' },
  });

  const queued = await harness.manager.listPendingUploads();
  assert.equal(queued.length, 2);
  assert.deepEqual(
    queued.map((item) => [item.ownerAccountId, item.requestId]),
    [['account-a', 'shared-request'], ['account-b', 'shared-request']],
  );

  const flushedB = await harness.manager.flushPendingUploads(async (item) => {
    assert.equal(item.ownerAccountId, 'account-b');
    return jsonResponse(200, { ok: true });
  });
  assert.equal(flushedB.uploaded, 1);
  assert.deepEqual(
    (await harness.manager.listPendingUploads()).map((item) => item.ownerAccountId),
    ['account-a'],
  );
  await harness.manager.setCollectorSession(validSession({
    collectorToken: 'csess_account_a_refreshed_123456789',
  }));
  const flushedA = await harness.manager.flushPendingUploads(async (item) => {
    assert.equal(item.ownerAccountId, 'account-a');
    return jsonResponse(200, { ok: true });
  });
  assert.equal(flushedA.uploaded, 1);
  assert.deepEqual(await harness.manager.listPendingUploads(), []);
});

test('concurrent enqueues are serialized without losing either upload', async () => {
  const harness = createHarness();
  await harness.manager.setCollectorSession(validSession());
  const originalGet = harness.chromeApi.storage.local.get;
  let queueReads = 0;
  harness.chromeApi.storage.local.get = async (key) => {
    const snapshot = await originalGet(key);
    if (key === PENDING_UPLOADS_STORAGE_KEY) {
      queueReads += 1;
      if (queueReads === 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return snapshot;
  };

  await Promise.all([
    harness.manager.enqueuePendingUpload({
      requestId: 'concurrent-1',
      path: '/sources/ozon/collect',
      body: { sourceSku: 'sku-1' },
    }),
    harness.manager.enqueuePendingUpload({
      requestId: 'concurrent-2',
      path: '/sources/ozon/collect',
      body: { sourceSku: 'sku-2' },
    }),
  ]);

  assert.deepEqual(
    (await harness.manager.listPendingUploads()).map((item) => item.requestId).sort(),
    ['concurrent-1', 'concurrent-2'],
  );
});

test('enqueue during flush is retained and a failed queue write does not poison later mutations', async () => {
  const harness = createHarness();
  await harness.manager.setCollectorSession(validSession());
  await harness.manager.enqueuePendingUpload({
    requestId: 'flush-existing',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-existing' },
  });
  let releaseUpload;
  let uploadEntered;
  const uploadStarted = new Promise((resolve) => { uploadEntered = resolve; });
  const uploadReleased = new Promise((resolve) => { releaseUpload = resolve; });
  const flush = harness.manager.flushPendingUploads(async () => {
    uploadEntered();
    await uploadReleased;
    return jsonResponse(200, { ok: true });
  });
  await uploadStarted;
  const enqueue = harness.manager.enqueuePendingUpload({
    requestId: 'added-during-flush',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-new' },
  });
  releaseUpload();
  await Promise.all([flush, enqueue]);
  assert.deepEqual(
    (await harness.manager.listPendingUploads()).map((item) => item.requestId),
    ['added-during-flush'],
  );

  const originalSet = harness.chromeApi.storage.local.set;
  let failNextQueueWrite = true;
  harness.chromeApi.storage.local.set = async (values) => {
    if (failNextQueueWrite && Object.hasOwn(values, PENDING_UPLOADS_STORAGE_KEY)) {
      failNextQueueWrite = false;
      throw new Error('simulated storage failure');
    }
    return originalSet(values);
  };
  await assert.rejects(
    harness.manager.enqueuePendingUpload({
      requestId: 'write-fails',
      path: '/sources/ozon/collect',
      body: { sourceSku: 'sku-fail' },
    }),
    /simulated storage failure/,
  );
  await harness.manager.enqueuePendingUpload({
    requestId: 'after-write-failure',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-recovered' },
  });
  assert.deepEqual(
    (await harness.manager.listPendingUploads()).map((item) => item.requestId),
    ['added-during-flush', 'after-write-failure'],
  );
});

test('collector diagnostics redact ticket, session, bearer, code and nested fields', async () => {
  const ticket = 'ctt_ticket_secret_123456789';
  const sessionSecret = 'csess_session_secret_123456789';
  const bearer = 'Bearer bearer.secret.value';
  const harness = createHarness({
    fetchImpl: async () => jsonResponse(400, {
      code: ticket,
      message: `rejected ${sessionSecret}`,
      status: { authorization: bearer },
    }),
  });
  await harness.manager.activateCollectorGeneration('generation_error_1234');

  await assert.rejects(
    harness.manager.exchangeCollectorTicket({
      ticket,
      generationId: 'generation_error_1234',
    }),
    (error) => {
      assert.equal(error.code, 'COLLECTOR_REQUEST_FAILED');
      assert.equal(JSON.stringify(error).includes('ctt_'), false);
      assert.equal(JSON.stringify(error).includes('csess_'), false);
      assert.equal(JSON.stringify(error).toLowerCase().includes('bearer '), false);
      return true;
    },
  );
  const diagnostic = sanitizeCollectorDiagnostic({
    code: sessionSecret,
    status: { authorization: bearer },
    nested: [{ cause: ticket }],
  }, [ticket, sessionSecret]);
  const output = JSON.stringify([diagnostic, harness.logs]);
  assert.doesNotMatch(output, /ctt_|csess_|bearer\s/i);
});

test('retryability classifier retains network, auth, 408, 429 and 5xx but not business 4xx', async () => {
  for (const status of [0, 401, 403, 408, 429, 500, 503]) {
    assert.equal(isRetryableCollectorUploadStatus(status), true, String(status));
  }
  for (const status of [400, 404, 409, 422]) {
    assert.equal(isRetryableCollectorUploadStatus(status), false, String(status));
  }

  const harness = createHarness();
  await harness.manager.setCollectorSession(validSession());
  for (const status of [0, 408, 429, 500, 503]) {
    assert.equal(
      await harness.manager.enqueueRetryablePendingUpload({
        requestId: `immediate-${status}`,
        path: '/sources/ozon/collect',
        body: { sourceSku: `sku-${status}` },
      }, status),
      true,
    );
  }
  assert.equal(
    await harness.manager.enqueueRetryablePendingUpload({
      requestId: 'immediate-422',
      path: '/sources/ozon/collect',
      body: { sourceSku: 'sku-422' },
    }, 422),
    false,
  );
  assert.equal((await harness.manager.listPendingUploads()).length, 5);
  await harness.chromeApi.storage.local.set({ [PENDING_UPLOADS_STORAGE_KEY]: [] });
  await harness.manager.enqueuePendingUpload({
    requestId: 'retry-408',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-408' },
  });
  await harness.manager.flushPendingUploads(async () => jsonResponse(408, { code: 'TIMEOUT' }));
  assert.equal((await harness.manager.listPendingUploads()).length, 1);
  await harness.manager.flushPendingUploads(async () => jsonResponse(422, { code: 'INVALID' }));
  assert.equal((await harness.manager.listPendingUploads()).length, 0);
});

test('operation started by A cannot fetch with B and its failed payload remains owned by A', async () => {
  const requests = [];
  const harness = createHarness({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(200, { ok: true });
    },
  });
  await harness.manager.setCollectorSession(validSession());
  const operationA = await harness.manager.beginCollectorOperation();
  assert.equal(Object.isFrozen(operationA), true);
  assert.equal(operationA.accountId, 'account-a');
  assert.equal(operationA.collectorToken, undefined);

  await harness.manager.setCollectorSession(validSession({
    collectorToken: 'csess_account_b_race_123456789',
    account: { id: 'account-b', displayName: 'B' },
  }));
  await harness.manager.enqueuePendingUpload({
    requestId: 'race-shared-request',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-b' },
  });

  await assert.rejects(
    harness.manager.collectorFetch('/sources/ozon/collect', {
      collectorOperation: operationA,
      permission: 'collector.upload',
      method: 'POST',
      body: JSON.stringify({ sourceSku: 'sku-a' }),
    }),
    (error) => error?.code === 'COLLECTOR_SESSION_CHANGED',
  );
  assert.equal(requests.length, 0);
  assert.equal(
    await harness.manager.enqueueRetryablePendingUpload({
      requestId: 'race-shared-request',
      path: '/sources/ozon/collect',
      body: { sourceSku: 'sku-a' },
    }, 0, operationA),
    true,
  );
  assert.deepEqual(
    (await harness.manager.listPendingUploads()).map((item) => [
      item.ownerAccountId,
      item.requestId,
      item.body.sourceSku,
    ]),
    [
      ['account-b', 'race-shared-request', 'sku-b'],
      ['account-a', 'race-shared-request', 'sku-a'],
    ],
  );
});

test('operation started by A keeps A ownership when B becomes current before enqueue', async () => {
  const harness = createHarness();
  await harness.manager.setCollectorSession(validSession());
  const operationA = await harness.manager.beginCollectorOperation();
  await harness.manager.setCollectorSession(validSession({
    collectorToken: 'csess_account_b_enqueue_123456789',
    account: { id: 'account-b', displayName: 'B' },
  }));

  await harness.manager.enqueuePendingUpload({
    requestId: 'enqueue-after-switch',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-a' },
  }, operationA);

  const [queued] = await harness.manager.listPendingUploads();
  assert.equal(queued.ownerAccountId, 'account-a');
  assert.equal(queued.ownerSessionIdentity, 'account:account-a');
  assert.equal(harness.localState.sonliCollectorLastOwner.accountId, 'account-b');
});

test('flush retains A and leaves B untouched when the session switches during A fetch', async () => {
  let harness;
  const requests = [];
  harness = createHarness({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      await harness.manager.setCollectorSession(validSession({
        collectorToken: 'csess_account_b_during_fetch_123456789',
        account: { id: 'account-b', displayName: 'B' },
      }));
      return jsonResponse(200, { ok: true });
    },
  });
  await harness.manager.setCollectorSession(validSession());
  const operationA = await harness.manager.beginCollectorOperation();
  await harness.manager.enqueuePendingUpload({
    requestId: 'flush-race-a',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-a' },
  }, operationA);

  await harness.manager.setCollectorSession(validSession({
    collectorToken: 'csess_account_b_before_flush_123456789',
    account: { id: 'account-b', displayName: 'B' },
  }));
  const operationB = await harness.manager.beginCollectorOperation();
  await harness.manager.enqueuePendingUpload({
    requestId: 'flush-race-b',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-b' },
  }, operationB);
  await harness.manager.setCollectorSession(validSession());

  const result = await harness.manager.flushPendingUploads(
    (item, collectorOperation) => harness.manager.collectorFetch(item.path, {
      collectorOperation,
      permission: 'collector.upload',
      method: 'POST',
      body: JSON.stringify(item.body),
    }),
    operationA,
  );

  assert.equal(result.uploaded, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.authorization, `Collector ${validSession().collectorToken}`);
  assert.equal(requests[0].options.headers.authorization.includes('account_b'), false);
  assert.deepEqual(
    (await harness.manager.listPendingUploads()).map((item) => item.ownerAccountId),
    ['account-a', 'account-b'],
  );
});

test('clear race aborts the old snapshot and a new same-account snapshot can replay A', async () => {
  const requests = [];
  const harness = createHarness({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(200, { ok: true });
    },
  });
  await harness.manager.setCollectorSession(validSession());
  const revokedOperationA = await harness.manager.beginCollectorOperation();
  await harness.manager.enqueuePendingUpload({
    requestId: 'revoked-race-a',
    path: '/sources/ozon/collect',
    body: { sourceSku: 'sku-a' },
  }, revokedOperationA);
  await harness.manager.clearCollectorSession();

  await assert.rejects(
    harness.manager.collectorFetch('/sources/ozon/collect', {
      collectorOperation: revokedOperationA,
      permission: 'collector.upload',
      method: 'POST',
      body: JSON.stringify({ sourceSku: 'sku-a' }),
    }),
    (error) => error?.code === 'COLLECTOR_SESSION_CHANGED',
  );
  assert.equal(requests.length, 0);
  assert.equal((await harness.manager.listPendingUploads()).length, 1);

  const refreshed = validSession({
    collectorToken: 'csess_account_a_refreshed_race_123456789',
  });
  await harness.manager.setCollectorSession(refreshed);
  const refreshedOperationA = await harness.manager.beginCollectorOperation();
  const replay = await harness.manager.flushPendingUploads(
    (item, collectorOperation) => harness.manager.collectorFetch(item.path, {
      collectorOperation,
      permission: 'collector.upload',
      method: 'POST',
      body: JSON.stringify(item.body),
    }),
    refreshedOperationA,
  );
  assert.equal(replay.uploaded, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.authorization, `Collector ${refreshed.collectorToken}`);
  assert.deepEqual(await harness.manager.listPendingUploads(), []);
});

test('old A 401 cannot clear B installed between its conditional read and remove', async () => {
  const harness = createHarness({
    fetchImpl: async () => jsonResponse(401, { code: 'COLLECTOR_SESSION_REVOKED' }),
  });
  await harness.manager.setCollectorSession(validSession());
  const operationA = await harness.manager.beginCollectorOperation();
  const successorB = validSession({
    collectorToken: 'csess_account_b_401_race_123456789',
    account: { id: 'account-b', displayName: 'B' },
  });
  const originalGet = harness.chromeApi.storage.session.get.bind(
    harness.chromeApi.storage.session,
  );
  let sessionGets = 0;
  let successorInstall;
  harness.chromeApi.storage.session.get = async (key) => {
    const captured = await originalGet(key);
    sessionGets += 1;
    if (sessionGets === 3) {
      successorInstall = harness.manager.setCollectorSession(successorB);
    }
    return captured;
  };

  const response = await harness.manager.collectorFetch('/sources/ozon/collect', {
    collectorOperation: operationA,
    permission: 'collector.upload',
    method: 'POST',
  });
  await successorInstall;

  assert.equal(response.status, 401);
  assert.equal(sessionGets, 3);
  const current = await harness.manager.getCollectorSession();
  assert.equal(current.account.id, 'account-b');
  assert.equal(current.collectorToken, successorB.collectorToken);
});

test('old A 401 cannot clear a refreshed A installed after its conditional read', async () => {
  const harness = createHarness({
    fetchImpl: async () => jsonResponse(403, { code: 'COLLECTOR_SESSION_REVOKED' }),
  });
  await harness.manager.setCollectorSession(validSession());
  const operationA = await harness.manager.beginCollectorOperation();
  const refreshedA = validSession({
    collectorToken: 'csess_account_a_refreshed_401_race_123456789',
    expiresAt: '2030-01-01T02:00:00.000Z',
  });
  const originalGet = harness.chromeApi.storage.session.get.bind(
    harness.chromeApi.storage.session,
  );
  let sessionGets = 0;
  let refreshInstall;
  harness.chromeApi.storage.session.get = async (key) => {
    const captured = await originalGet(key);
    sessionGets += 1;
    if (sessionGets === 3) {
      refreshInstall = harness.manager.setCollectorSession(refreshedA);
    }
    return captured;
  };

  const response = await harness.manager.collectorFetch('/sources/ozon/collect', {
    collectorOperation: operationA,
    permission: 'collector.upload',
    method: 'POST',
  });
  await refreshInstall;

  assert.equal(response.status, 403);
  assert.equal(sessionGets, 3);
  const current = await harness.manager.getCollectorSession();
  assert.equal(current.account.id, 'account-a');
  assert.equal(current.collectorToken, refreshedA.collectorToken);
  assert.equal(current.expiresAt, refreshedA.expiresAt);
});

test('expired A cleanup cannot delete B installed after the expired read', async () => {
  const harness = createHarness();
  harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY] = validSession({
    expiresAt: '2029-12-31T23:59:59.000Z',
  });
  const successorB = validSession({
    collectorToken: 'csess_account_b_expiry_race_123456789',
    account: { id: 'account-b', displayName: 'B' },
  });
  const originalGet = harness.chromeApi.storage.session.get.bind(
    harness.chromeApi.storage.session,
  );
  let sessionGets = 0;
  let successorInstall;
  harness.chromeApi.storage.session.get = async (key) => {
    const captured = await originalGet(key);
    sessionGets += 1;
    if (sessionGets === 1) {
      successorInstall = harness.manager.setCollectorSession(successorB);
    }
    return captured;
  };

  assert.equal(await harness.manager.getCollectorSession(), null);
  await successorInstall;

  assert.equal(sessionGets, 1);
  const current = await harness.manager.getCollectorSession();
  assert.equal(current.account.id, 'account-b');
  assert.equal(current.collectorToken, successorB.collectorToken);
});

test('stale A logout cannot clear a completed successor B session', async () => {
  const harness = createHarness();
  await harness.manager.setCollectorSession(validSession());
  const operationA = await harness.manager.beginCollectorOperation();
  const successorB = validSession({
    collectorToken: 'csess_account_b_logout_race_123456789',
    account: { id: 'account-b', displayName: 'B' },
  });
  await harness.manager.setCollectorSession(successorB);

  await harness.manager.clearCollectorSession(operationA);

  const current = await harness.manager.getCollectorSession();
  assert.equal(current.account.id, 'account-b');
  assert.equal(current.collectorToken, successorB.collectorToken);
});

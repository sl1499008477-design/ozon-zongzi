const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
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

function createHarness({ now = Date.parse('2030-01-01T00:00:00.000Z'), fetchImpl } = {}) {
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
  const manager = createCollectorSessionManager({
    chromeApi,
    backendUrl: async () => 'http://127.0.0.1:3000/api',
    fetchImpl: fetchImpl || (async () => jsonResponse(500, { code: 'UNEXPECTED_FETCH' })),
    now: () => now,
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
  assert.deepEqual(
    await harness.manager.activateCollectorGeneration('generation_A_1234'),
    { changed: false },
  );
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

test('failed generation storage mutations clear the session before changing the generation marker', async () => {
  const activateHarness = createHarness();
  await activateHarness.manager.activateCollectorGeneration('generation_G1_1234');
  await activateHarness.manager.setCollectorSession(validSession());
  const originalSet = activateHarness.chromeApi.storage.session.set.bind(
    activateHarness.chromeApi.storage.session,
  );
  activateHarness.chromeApi.storage.session.set = async (values) => {
    if (values?.[COLLECTOR_AUTH_GENERATION_STORAGE_KEY] === 'generation_G2_5678') {
      throw new Error('simulated generation activation failure');
    }
    return originalSet(values);
  };

  await assert.rejects(
    activateHarness.manager.activateCollectorGeneration('generation_G2_5678'),
    /simulated generation activation failure/,
  );
  assert.equal(activateHarness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
  assert.equal(
    activateHarness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY],
    'generation_G1_1234',
  );

  const clearHarness = createHarness();
  await clearHarness.manager.activateCollectorGeneration('generation_G2_5678');
  await clearHarness.manager.setCollectorSession(validSession());
  const originalRemove = clearHarness.chromeApi.storage.session.remove.bind(
    clearHarness.chromeApi.storage.session,
  );
  clearHarness.chromeApi.storage.session.remove = async (key) => {
    if (key === COLLECTOR_AUTH_GENERATION_STORAGE_KEY) {
      throw new Error('simulated generation clear failure');
    }
    return originalRemove(key);
  };

  await assert.rejects(
    clearHarness.manager.clearCollectorGeneration('generation_G2_5678'),
    /simulated generation clear failure/,
  );
  assert.equal(clearHarness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
  assert.equal(
    clearHarness.sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY],
    'generation_G2_5678',
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
    if (key === COLLECTOR_AUTH_GENERATION_STORAGE_KEY) {
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
  const capturedG1 = await originalGet(COLLECTOR_AUTH_GENERATION_STORAGE_KEY);
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

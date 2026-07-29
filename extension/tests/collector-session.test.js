const assert = require('node:assert/strict');
const test = require('node:test');
const {
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

test('expired collector sessions are cleared from session storage', async () => {
  const harness = createHarness();
  harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY] = validSession({
    expiresAt: '2029-12-31T23:59:59.000Z',
  });
  assert.equal(await harness.manager.getCollectorSession(), null);
  assert.equal(harness.sessionState[COLLECTOR_SESSION_STORAGE_KEY], undefined);
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
  let ticketCalls = 0;
  await assert.rejects(
    harness.manager.exchangeCollectorTicketWithRetry({
      requestTicket: async () => ({
        ticket: tickets[ticketCalls++],
        expiresAt: '2030-01-01T00:00:30.000Z',
      }),
      deviceFingerprint: 'machine-v3-test',
      extensionVersion: '1.2.3',
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

  await assert.rejects(
    harness.manager.exchangeCollectorTicket({ ticket }),
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

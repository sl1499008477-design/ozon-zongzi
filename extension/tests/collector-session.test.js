const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COLLECTOR_PERMISSIONS,
  COLLECTOR_SESSION_STORAGE_KEY,
  createCollectorSessionManager,
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

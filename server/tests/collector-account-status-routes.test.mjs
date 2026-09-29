import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollectorHttpHandler } from '../collector-routes.mjs';
import { createCollectorAuthRuntime } from '../collector-auth-runtime.mjs';
import { hashCollectorSecret } from '../collector-auth-service.mjs';

const expiresAt = '2099-01-01T00:00:00.000Z';
function fixture() {
  const state = {
    accounts: ['a', 'b'].map(id => ({ id, status: 'active', role: 'user', expiresAt })),
    sessions: Object.fromEntries(['a', 'b'].map(id => [`web-${id}`, { accountId: id, expiresAt }])),
    collectorSessions: ['a', 'b'].map(id => ({ id: `session-${id}`, accountId: id,
      tokenHash: hashCollectorSecret(`collector-${id}`), parentSessionToken: `web-${id}`,
      permissions: ['collector.job.read', 'collector.config.read', 'collector.upload'], expiresAt })),
  };
  const sendJson = (res, status, body) => {
    if (typeof res.writeHead === 'function') {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } else Object.assign(res, { status, body });
  };
  const readJson = async req => {
    if (req.body !== undefined) return req.body;
    if (!req[Symbol.asyncIterator]) return {};
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  };
  const auth = createCollectorAuthRuntime({ loadState: async () => state, saveState: async () => {},
    persistenceMode: () => 'json', stateTransaction: { run: fn => fn() }, readJson, sendJson });
  const counts = { a: { collect: 2, products: 7 }, b: { collect: 9, products: 31 } };
  const reads = [], writes = [];
  const rate = { rate: 11.3, baseCurrency: 'CNY', quoteCurrency: 'RUB', computedAt: '2026-09-12T10:00:00.000Z',
    acceptedCount: 3, confidence: 'HIGH', stale: false, source: 'ozon_sku_frontend',
    evidence: [{ accountId: 'b', raw: 'private' }] };
  const handler = createCollectorHttpHandler({ authenticate: auth.authenticateRequest, readJson, sendJson,
    readAccountCounts: async accountId => { reads.push(accountId); return counts[accountId]; },
    fxService: {
      getLatestLiveExchangeRate: async () => rate,
      listFxProbes: async options => {
        assert.deepEqual(options, { includeDisabled: false });
        return [{ sku: '2774409776', label: 'private label', lastError: 'private error' }];
      },
      ingestFxObservations: async input => { writes.push(input); return { rate, accepted: 1, rejected: 0, errors: 0 }; },
    },
  });
  async function request(method, url, { token = 'Collector collector-a', body, headers = {} } = {}) {
    const res = {};
    const handled = await handler({ method, url, body, headers: { authorization: token, ...headers } }, res);
    return { handled, ...res };
  }
  return { request, state, reads, writes, handler };
}

test('summary uses the authenticated account and returns only counts and public FX fields', async () => {
  const f = fixture();
  const a = await f.request('GET', '/collector/account-summary');
  assert.equal(a.handled, true);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.counts, { collect: 2, products: 7 });
  assert.equal(a.body.rate.rate, 11.3);
  assert.equal(a.body.rate.evidence, undefined);
  const b = await f.request('GET', '/collector/account-summary', { token: 'Collector collector-b' });
  assert.deepEqual(b.body.counts, { collect: 9, products: 31 });
  assert.deepEqual(f.reads, ['a', 'b']);
  assert.ok(!JSON.stringify(a.body).includes('private'));
});

test('Web bearer, revoked Collector and insufficient permissions cannot read summary', async () => {
  const f = fixture();
  assert.equal((await f.request('GET', '/collector/account-summary', { token: 'Bearer web-a' })).status, 401);
  f.state.collectorSessions[0].permissions = ['collector.upload'];
  assert.equal((await f.request('GET', '/collector/account-summary')).status, 403);
  f.state.collectorSessions[0].revokedAt = '2026-01-01T00:00:00.000Z';
  assert.equal((await f.request('GET', '/collector/account-summary')).status, 401);
  assert.deepEqual(f.reads, []);
});

test('client-selected account/store is rejected before data access', async () => {
  const f = fixture();
  for (const query of ['accountId=b', 'storeId=store-b', 'operatingStoreId=store-b']) {
    assert.equal((await f.request('GET', `/collector/account-summary?${query}`)).status, 400);
  }
  assert.deepEqual(f.reads, []);
});

test('active FX probes disclose only SKUs and no history or management fields', async () => {
  const f = fixture();
  const result = await f.request('GET', '/collector/fx/probes/active');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.probes, [{ sku: '2774409776' }]);
  assert.equal(result.body.rate.evidence, undefined);
  assert.equal((await f.request('POST', '/collector/fx/probes/active')).status, 405);
  assert.equal((await f.request('DELETE', '/collector/fx/probes/2774409776')).handled, false);
});

const observation = { sku: '2774409776', rubPrice: 13358, cnyPrice: 1181.74,
  observedAt: '2026-09-12T10:00:00.000Z', source: 'ozon_buyer_bff_variant_frontend',
  raw: { basis: 'webAspects.variant.price + data.price', token: 'never persist' } };

test('FX writes use Collector upload, session account and existing idempotency contract', async () => {
  const f = fixture();
  const body = { observations: [observation], errors: [], deviceId: 'extension-a', idempotencyKey: 'fx-observation-a' };
  const result = await f.request('POST', '/collector/fx/observations', {
    body, headers: { 'idempotency-key': body.idempotencyKey, 'x-ozon-store-id': 'store-b' },
  });
  assert.equal(result.status, 201);
  assert.equal(f.writes[0].accountId, 'a');
  assert.equal(f.writes[0].storeId, undefined);
  assert.equal(f.writes[0].idempotencyKey, 'fx-observation-a');
  assert.match(f.writes[0].payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(f.writes[0].payloadHash, createHash('sha256').update(JSON.stringify({
    observations: body.observations, errors: body.errors, deviceId: body.deviceId,
  })).digest('hex'), 'pre-migration pending FX requests must retain their existing payload hash');
  assert.equal(f.writes[0].observations[0].rubPrice, 13358);
  assert.equal(f.writes[0].observations[0].raw, undefined);
  assert.equal(result.body.rate.evidence, undefined);
  assert.equal((await f.request('POST', '/collector/fx/observations', { body: { ...body, accountId: 'b' },
    headers: { 'idempotency-key': body.idempotencyKey } })).status, 400);
  assert.equal((await f.request('POST', '/collector/fx/observations', { body })).status, 422);
  f.state.collectorSessions[0].permissions = ['collector.config.read'];
  assert.equal((await f.request('POST', '/collector/fx/observations', { body,
    headers: { 'idempotency-key': body.idempotencyKey } })).status, 403);
  assert.equal(f.writes.length, 1);
});

test('account counts reuse listed-SKU filtering including partially listed groups', async () => {
  const api = await import('../collector-account-status-routes.mjs').catch(() => ({}));
  assert.equal(typeof api.readCollectorAccountCounts, 'function');
  const queries = [];
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes('FROM products')) return { rows: [{ count: 7 }] };
    if (sql.includes('FROM collect_items')) return { rows: [
      { sku: '2102714113', variant_skus: ['2102714113', '2102713588'] },
      { sku: '9999999999', variant_skus: [] },
      { sku: '8888888888', variant_skus: [] },
    ] };
    return { rows: [{ status: 'COMPLETED', skus: ['2102714113', '9999999999'], succeeded_skus: [] }] };
  } };
  assert.deepEqual(await api.readCollectorAccountCounts({ pool, accountId: 'a' }), { collect: 2, products: 7 });
  assert.equal(queries.length, 3);
  assert.ok(queries.every(({ params }) => params[0] === 'a'));
  assert.ok(queries.find(q => q.sql.includes('FROM products')).sql.includes('owner_account_id=$1'));
  assert.ok(queries.find(q => q.sql.includes('FROM collect_items')).sql.includes('deleted_at IS NULL'));
});

// Real HTTP, real Collector session manager and auth runtime; only domain data is a fixture.
test('extension client reaches Collector HTTP routes and revoked sessions fail closed', async (t) => {
  const { createServer } = await import('node:http');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { createCollectorSessionManager } = require('../../extension/lib/collector-session.js');
  require('../../extension/lib/fx-observation-replay.js');
  const { createCollectorAccountStatus } = require('../../extension/background/collector-account-status.js');
  const f = fixture();
  const server = createServer(async (req, res) => {
    if (!await f.handler(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const backendUrl = `http://127.0.0.1:${server.address().port}`;
  const area = () => {
    const data = {};
    return { async get(keys) { return keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]])); },
      async set(values) { Object.assign(data, values); }, async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; } };
  };
  const storage = area();
  const manager = createCollectorSessionManager({ chromeApi: { storage: { session: area(), local: storage, sync: area() } },
    backendUrl: async () => backendUrl, fetchImpl: fetch });
  await manager.setCollectorSession({ collectorToken: 'collector-a', account: { id: 'a' }, expiresAt,
    permissions: ['collector.job.read', 'collector.config.read', 'collector.upload'] });
  const client = createCollectorAccountStatus({ sessionManager: manager, getBackendUrl: async () => backendUrl,
    getDeviceFingerprint: async () => 'extension-a', storage, collectFxProbe: async () => observation });
  assert.deepEqual((await client.getAccountSummary()).counts, { collect: 2, products: 7 });
  assert.equal(await client.refreshFx(), 11.3);
  assert.equal(f.writes[0].accountId, 'a');
  assert.equal(f.writes[0].observations[0].raw, undefined);
  assert.ok(f.writes[0].idempotencyKey);
  const denied = await fetch(`${backendUrl}/collector/account-summary`, { headers: { Authorization: 'Bearer web-a' } });
  assert.equal(denied.status, 401);
  f.state.collectorSessions[0].revokedAt = new Date().toISOString();
  await assert.rejects(client.getAccountSummary(), { code: 'COLLECTOR_AUTH_REQUIRED' });
  assert.equal(await manager.beginCollectorOperation(), null);
});

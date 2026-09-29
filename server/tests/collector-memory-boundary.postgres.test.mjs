import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { getPostgresPool, closePostgresPool } from '../db/connection.mjs';
import { ensureFormalSchema } from '../formal-persistence.mjs';
import { createCollectorAuthRuntime } from '../collector-auth-runtime.mjs';
import { createCollectorOzonEnrichmentRuntime } from '../collector-ozon-enrichment-runtime.mjs';
import { listCollectorTasksPageForAccount } from '../collector-desktop-service.mjs';

// Run against a disposable copy of the existing data. Never a business database.
test('Collector authorization, task reads and idle polling stay bounded with existing catalog data', {
  skip: process.env.SONLI_POSTGRES_TESTS !== '1', timeout: 120000,
}, async () => {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/sonli_qa_collector_memory/);
  const pool = await getPostgresPool();
  const accountId = `memory-qa-${randomUUID()}`, otherId = `${accountId}-other`;
  const webToken = randomUUID(), taskId = `${accountId}-task`;
  let peakHeap = 0, peakRss = 0, globalReads = 0, queries = 0;
  const sample = () => {
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss);
  };
  const timer = setInterval(sample, 5);
  try {
    await ensureFormalSchema(pool);
    const volume = (await pool.query(`SELECT
      (SELECT count(*) FROM collect_items WHERE deleted_at IS NULL)::int AS groups,
      (SELECT COALESCE(sum(octet_length(payload::text)),0) FROM collect_raw_payloads)::bigint AS raw_bytes,
      (SELECT COALESCE(sum(octet_length(data::text)),0) FROM product_drafts)::bigint AS draft_bytes`)).rows[0];
    if (process.env.COLLECTOR_EXPECT_EXISTING_DATA === '1') {
      assert.ok(volume.groups >= 247); assert.ok(Number(volume.raw_bytes) >= 60_000_000);
      assert.ok(Number(volume.draft_bytes) >= 35_000_000);
      const existingId = 'coltask_af99fd59-5480-4f76-9769-d1a5493422df';
      const original = (await pool.query('SELECT account_id,name FROM collector_tasks WHERE id=$1 AND deleted_at IS NULL', [existingId])).rows[0];
      assert.ok(original, 'the original completed task must remain readable');
      const existing = await listCollectorTasksPageForAccount({ accountId: original.account_id, name: original.name, pageSize: 10 });
      assert.ok(existing.tasks.some(task => task.id === existingId));
    }
    await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user')", [accountId, otherId]);
    await pool.query("INSERT INTO sessions(token,account_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour')", [webToken, accountId]);
    await pool.query("INSERT INTO collector_tasks(id,account_id,name,task_type,status) VALUES($1,$2,'照明类目','MARKET','COMPLETED')", [taskId, accountId]);
    const observedQuery = connection => (sql, values) => {
      queries++;
      assert.doesNotMatch(sql, /\b(?:FROM|JOIN)\s+(?:local_state|products|collect_raw_payloads|product_drafts|collect_items)\b/i);
      return connection.query(sql, values);
    };
    const common = {
      loadState: async () => { globalReads++; throw new Error('unrelated full catalog hydration'); },
      saveState: async () => { throw new Error('unexpected whole-state write'); },
      persistenceMode: () => 'postgres', stateTransaction: { run: fn => fn() },
      postgresPool: { query: observedQuery(pool), async connect() {
        const client = await pool.connect();
        return { query: observedQuery(client), release: () => client.release() };
      } },
      readJson: async req => req.payload || {},
      sendJson: (res, status, body) => Object.assign(res, { status, body }),
    };
    const auth = createCollectorAuthRuntime(common);
    const enrichment = createCollectorOzonEnrichmentRuntime({ ...common,
      authenticate: (req, permission) => auth.authenticateSessionRequest(req, permission),
    });
    const request = async (method, path, authorization, payload) => {
      const req = Readable.from([]); Object.assign(req, { method, headers: { authorization }, payload });
      const res = {}; await auth.handleHttpRoute(req, res, new URL(path, 'http://fixture'));
      return res;
    };
    const started = Date.now();
    for (let round = 0; round < 8; round++) await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const ticket = await request('POST', '/extension/collector-auth/ticket', `Bearer ${webToken}`);
      assert.equal(ticket.status, 200);
      const exchanged = await request('POST', '/extension/collector-auth/exchange', '', {
        ticket: ticket.body.ticket, deviceFingerprint: `memory-${round}-${index}`, extensionVersion: '1.0.14',
      });
      assert.equal(exchanged.status, 200);
      assert.equal(exchanged.body.account.id, accountId);
      const header = `Collector ${exchanged.body.collectorToken}`;
      assert.equal((await request('GET', '/extension/collector-auth/status', header)).status, 200);
      const session = await auth.authenticateSessionRequest({ headers: { authorization: header } }, 'collector.job.read');
      const listed = await listCollectorTasksPageForAccount({ accountId: session.accountId, pageSize: 10 });
      assert.equal(listed.total, 1); assert.equal(listed.tasks[0].id, taskId);
      assert.equal(await enrichment.service.hasAvailableJob({ session }), false);
      sample();
    }));
    assert.equal((await listCollectorTasksPageForAccount({ accountId: otherId })).total, 0);
    for (const [sql, status, code] of [
      ["UPDATE accounts SET status='disabled' WHERE id=$1", 403, 'COLLECTOR_ACCOUNT_DISABLED'],
      ["UPDATE accounts SET status='active',expires_at=NOW()-INTERVAL '1 day' WHERE id=$1", 403, 'COLLECTOR_ACCOUNT_EXPIRED'],
    ]) {
      await pool.query(sql, [accountId]);
      const res = await request('POST', '/extension/collector-auth/ticket', `Bearer ${webToken}`);
      assert.equal(res.status, status); assert.equal(res.body.code, code);
    }
    await pool.query('UPDATE accounts SET expires_at=NULL WHERE id=$1', [accountId]);
    for (const sql of [
      'UPDATE sessions SET revoked_at=NOW() WHERE token=$1',
      "UPDATE sessions SET revoked_at=NULL,expires_at=NOW()-INTERVAL '1 day' WHERE token=$1",
    ]) {
      await pool.query(sql, [webToken]);
      const res = await request('POST', '/extension/collector-auth/ticket', `Bearer ${webToken}`);
      assert.equal(res.status, 401); assert.equal(res.body.code, 'WEB_AUTH_REQUIRED');
    }
    assert.equal(globalReads, 0);
    assert.ok(peakHeap < 256 * 1024 * 1024, `heap exceeded bounded request budget: ${peakHeap}`);
    console.log(JSON.stringify({ volume, sessions: 64, concurrency: 8, queries, globalReads,
      peakHeapMiB: Math.ceil(peakHeap / 1048576), peakRssMiB: Math.ceil(peakRss / 1048576), elapsedMs: Date.now() - started }));
  } finally {
    clearInterval(timer);
    await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])', [[accountId, otherId]]);
    await closePostgresPool();
  }
});

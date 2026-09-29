import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function within(promise, message, milliseconds = 5000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

test('full local-state reads serialize while lightweight routes remain available and failures release the next read', {
  skip: process.env.SONLI_POSTGRES_TESTS !== '1' || !process.env.DATABASE_URL,
  timeout: 60000,
}, async () => {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/(?:qa[_-]|sonli_qa[_-])/,
    'requires an explicitly configured disposable QA database');
  process.env.NODE_ENV = 'test';
  process.env.LISTING_PIPELINE_V3 = '1';
  process.env.POSTGRES_POOL_MAX = '6';
  const suffix = randomUUID().replaceAll('-', '');
  const accountId = `qa-full-${suffix}`, collectId = `qa-collect-${suffix}`, taskId = `qa-task-${suffix}`;
  const webToken = `qa-web-${suffix}`, collectorToken = `cst_${suffix}`;
  // The application's real state reader uses a small private snapshot table.
  // Existing local_state and copied business accounts are never modified.
  const stateTable = `qa_full_state_${suffix}`;
  process.env.POSTGRES_STATE_TABLE = stateTable;
  const { getPostgresPool, closePostgresPool } = await import('../db/connection.mjs');
  const { ensureFormalSchema } = await import('../formal-persistence.mjs');
  const pool = await getPostgresPool();
  const originalQuery = pool.query;
  let handle;

  const request = async (url, authorization = `Bearer ${webToken}`) => {
    const req = Object.assign(Readable.from([]), { method: 'GET', url, headers: { host: 'qa.invalid', authorization } });
    const res = { status: 0, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await handle(req, res);
    return res;
  };
  const assertFull = response => {
    assert.equal(response.status, 200);
    assert.equal(response.body.account.id, accountId);
    assert.deepEqual(response.body.caches.collectBox.map(item => item.id), [collectId]);
  };

  async function exercise({ failFirst }) {
    const entered = deferred(), release = deferred(), secondAuthorized = deferred(), secondHeavy = deferred();
    let heavyEntries = 0, webAuthReads = 0;
    const pending = [];
    pool.query = async function (...args) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
      const values = args[1] || args[0]?.values || [];
      if (/SELECT\s+c\.\*,\s*d\.data\s+AS\s+draft_data/i.test(sql) && values[0] === accountId) {
        heavyEntries++;
        if (heavyEntries === 1) {
          entered.resolve();
          await release.promise;
          if (failFirst) throw Object.assign(new Error('controlled QA full-read failure'), { code: 'QA_FULL_READ_FAILURE' });
        } else secondHeavy.resolve();
      }
      const result = await originalQuery.apply(this, args);
      if (/FROM\s+sessions\s+s\s+JOIN\s+accounts\s+a/i.test(sql) && values[0] === webToken && ++webAuthReads === 2) {
        secondAuthorized.resolve();
      }
      return result;
    };
    try {
      // Observe both outcomes immediately, including the deliberately rejected read.
      const observe = promise => promise.then(value => ({ value }), error => ({ error }));
      const first = observe(request('/local/state')); pending.push(first);
      await within(entered.promise, 'first full read did not reach the real collection query');
      const second = observe(request('/local/state')); pending.push(second);
      await within(secondAuthorized.promise, 'second full read did not finish real authentication');

      const lightweight = Promise.all([
        request('/local/state?view=bootstrap'),
        request('/local/state?view=products'),
        request('/collector/tasks?page=1&pageSize=10', `Collector ${collectorToken}`),
      ]);
      pending.push(lightweight.catch(() => {}));
      const [bootstrap, products, tasks] = await within(lightweight, 'lightweight routes were blocked behind the held full read');
      for (const response of [bootstrap, products]) {
        assert.equal(response.status, 200);
        assert.equal(response.body.account.id, accountId);
        assert.deepEqual(response.body.caches.collectBox, []);
      }
      assert.equal(tasks.status, 200);
      assert.deepEqual(tasks.body.tasks.map(task => task.id), [taskId]);
      // Both requests are authenticated and unrelated real SQL has completed.
      // A short negative-observation window catches the old concurrent heavy read.
      const overlapped = await Promise.race([secondHeavy.promise.then(() => true), delay(200).then(() => false)]);
      assert.equal(overlapped, false, 'second full read entered the heavy collection query before the first settled');
      assert.equal(heavyEntries, 1);

      release.resolve();
      const [one, two] = await within(Promise.all([first, second]), 'full-read queue did not release after completion or error');
      if (failFirst) assert.equal(one.error?.code, 'QA_FULL_READ_FAILURE');
      else { assert.ifError(one.error); assertFull(one.value); }
      assert.ifError(two.error); assertFull(two.value);
      assert.equal(heavyEntries, 2);
    } finally {
      release.resolve();
      pool.query = originalQuery;
      await within(Promise.allSettled(pending), 'pending QA reads did not drain', 5000).catch(() => {});
    }
  }

  try {
    await ensureFormalSchema(pool);
    assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /^(?:qa[_-]|sonli_qa[_-])/);
    await pool.query(`CREATE TABLE ${stateTable} (id TEXT PRIMARY KEY,state JSONB NOT NULL)`);
    await pool.query(`INSERT INTO ${stateTable} VALUES ('local-state',$1::jsonb)`, [JSON.stringify({ stores: [], caches: {}, jobs: {}, reports: [], currentStoreIdsByAccount: {} })]);
    await pool.query("INSERT INTO accounts(id,username,role,status,raw) VALUES($1,$1,'user','active',$2::jsonb)", [accountId, JSON.stringify({ id: accountId, username: accountId })]);
    await pool.query("INSERT INTO sessions(token,account_id,issued_at,expires_at) VALUES($1,$2,NOW(),NOW()+INTERVAL '1 hour')", [webToken, accountId]);
    await pool.query(`INSERT INTO collector_sessions(id,token_hash,account_id,parent_session_token,permissions,expires_at)
      VALUES($1,$2,$3,$4,'["collector.job.read"]',NOW()+INTERVAL '1 hour')`, [`qa-session-${suffix}`, createHash('sha256').update(collectorToken).digest('hex'), accountId, webToken]);
    await pool.query("INSERT INTO collector_tasks(id,account_id,name,task_type,status) VALUES($1,$2,'Full read concurrency fixture','CATEGORY','COMPLETED')", [taskId, accountId]);
    await pool.query("INSERT INTO collect_items(id,account_id,source,identity_key,source_sku,status) VALUES($1,$2,'ozon',$1,'900001','COLLECTED')", [collectId, accountId]);
    await pool.query(`INSERT INTO collect_raw_payloads(id,collect_item_id,account_id,payload_hash,payload)
      VALUES($1,$2,$3,$1,$4::jsonb)`, [`qa-raw-${suffix}`, collectId, accountId, JSON.stringify({ normalized: {
      source: 'ozon', sku: '900001', name: 'QA fixture', images: ['https://example.invalid/qa.jpg'],
      listingDraft: { variants: [{ sku: '900001', images: ['https://example.invalid/qa.jpg'] }] },
    } })]);
    ({ handle } = await import('../index.mjs'));
    // Initialize the real repositories/migration guards before observing concurrency.
    assertFull(await request('/local/state'));
    assert.equal((await request('/collector/tasks', `Collector ${collectorToken}`)).status, 200);
    await exercise({ failFirst: false });
    await exercise({ failFirst: true });
    assertFull(await within(request('/local/state'), 'a later full read remained locked'));
  } finally {
    pool.query = originalQuery;
    await pool.query('DELETE FROM collect_raw_payloads WHERE account_id=$1', [accountId]);
    await pool.query('DELETE FROM collect_items WHERE account_id=$1', [accountId]);
    await pool.query('DELETE FROM collector_tasks WHERE account_id=$1', [accountId]);
    await pool.query('DELETE FROM accounts WHERE id=$1', [accountId]);
    await pool.query(`DROP TABLE IF EXISTS ${stateTable}`);
    await closePostgresPool();
  }
});

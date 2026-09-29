import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before } from 'node:test';
import { closePostgresPool, getPostgresPool } from '../db/connection.mjs';
import {
  appendCollectorRunEvent, appendCollectorRunEvents, completeCollectorRun, failCollectorRun, getCollectorTaskForAccount,
  getCollectorRunForAccount, listCollectorTasksForAccount, listCollectorTasksPageForAccount,
} from '../collector-desktop-service.mjs';

const enabled = process.env.SONLI_POSTGRES_TESTS === '1';
const options = { skip: !enabled, timeout: 15000 };
let pool;

before(async () => {
  if (!enabled) return;
  assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL, 'explicit dedicated PostgreSQL URL required');
  assert.equal(process.env.DATABASE_URL, process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  assert.ok(!['/sonli_local', '/postgres', '/template0', '/template1'].includes(new URL(process.env.DATABASE_URL).pathname),
    'the business database and PostgreSQL maintenance databases are not test targets');
  pool = await getPostgresPool();
  // Warm the normal migration path before arranging concurrent service calls.
  assert.equal(await getCollectorTaskForAccount('collector-regression-missing', 'missing'), null);
});
after(async () => { if (enabled) await closePostgresPool(); });

async function withFixture(callback) {
  const suffix = randomUUID();
  const accountId = `collector-lock-a-${suffix}`, otherAccountId = `collector-lock-b-${suffix}`;
  const taskId = `collector-lock-task-${suffix}`, runId = `collector-lock-run-${suffix}`;
  const deviceId = `collector-lock-device-${suffix}`, pricingId = `collector-lock-pricing-${suffix}`;
  const leaseToken = randomUUID();
  const client = await pool.connect();
  try {
    // Multiple real connections must see these fixtures. Only this UUID's rows
    // are committed, and finally removes them, including after a deadlock.
    await client.query('BEGIN');
    await client.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user')", [accountId, otherAccountId]);
    await client.query("INSERT INTO pricing_config_versions(id,version_no,scope_type,scope_id) VALUES($1,1,'account',$2)", [pricingId, accountId]);
    await client.query('INSERT INTO collector_devices(id,account_id,device_key) VALUES($1,$2,$1)', [deviceId, accountId]);
    await client.query("INSERT INTO collector_tasks(id,account_id,task_type,status) VALUES($1,$2,'MARKET','RUNNING')", [taskId, accountId]);
    await client.query(`INSERT INTO collector_task_runs(id,task_id,account_id,pricing_config_version_id,run_no,status,
      claimed_by_device_id,lease_token_hash,lock_expires_at,started_at)
      VALUES($1,$2,$3,$4,1,'RUNNING',$5,$6,NOW()+INTERVAL '5 minutes',NOW())`,
    [runId, taskId, accountId, pricingId, deviceId, createHash('sha256').update(leaseToken).digest('hex')]);
    await client.query('UPDATE collector_tasks SET current_run_id=$2 WHERE id=$1', [taskId, runId]);
    await client.query('COMMIT');
    await callback({ client, accountId, otherAccountId, taskId, runId, deviceId, pricingId, leaseToken });
  } finally {
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await client.query('UPDATE collector_tasks SET current_run_id=NULL WHERE account_id=ANY($1::text[])', [[accountId, otherAccountId]]);
    await client.query('DELETE FROM collector_task_runs WHERE account_id=ANY($1::text[])', [[accountId, otherAccountId]]);
    await client.query('DELETE FROM collector_tasks WHERE account_id=ANY($1::text[])', [[accountId, otherAccountId]]);
    await client.query('DELETE FROM collector_devices WHERE account_id=ANY($1::text[])', [[accountId, otherAccountId]]);
    await client.query('DELETE FROM pricing_config_versions WHERE id=$1', [pricingId]);
    await client.query('DELETE FROM accounts WHERE id=ANY($1::text[])', [[accountId, otherAccountId]]);
    await client.query('COMMIT');
    client.release();
  }
}

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check, description) {
  const deadline = Date.now() + 4000;
  do {
    if (await check()) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`timed out: ${description}`);
}

// Scheduling only: every query, row lock, FK and result comes from PostgreSQL.
// Pause the finisher after its run lock, immediately before its task lock.
async function raceAtTaskLock(fixture, secondCall, firstCall = failCollectorRun) {
  const roles = new AsyncLocalStorage();
  const ready = gate(), resume = gate();
  const pids = {};
  const originalConnect = pool.connect;
  pool.connect = function (callback) {
    if (callback) return originalConnect.call(this, callback);
    const role = roles.getStore();
    return originalConnect.call(this).then(client => {
      if (!role) return client;
      pids[role] = client.processID;
      const query = client.query, release = client.release;
      client.query = async function (sql, ...args) {
        if (role === 'first' && /SELECT \* FROM collector_tasks .*FOR UPDATE/.test(sql)) {
          ready.resolve();
          await resume.promise;
        }
        if (role === 'second' && /INSERT INTO collector_task_events/.test(sql)) {
          // The live deadlock log shows the task FK checked before the run FK.
          // pg_restore can reverse trigger creation order. Acquire that actual
          // KEY SHARE lock explicitly so both schemas exercise the live order.
          await query.call(this, 'SELECT id FROM collector_tasks WHERE id=$1 FOR KEY SHARE', [args[0][0]]);
        }
        return query.call(this, sql, ...args);
      };
      client.release = function (...args) {
        client.query = query;
        client.release = release;
        return release.apply(this, args);
      };
      return client;
    });
  };
  let first, second;
  const settle = promise => promise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
  try {
    first = settle(roles.run('first', () => firstCall({ ...fixture, errorCode: 'DESKTOP_SCRIPT_FAILED' })));
    await Promise.race([ready.promise, first.then(() => assert.fail('finisher exited before reaching task lock'))]);
    let secondDone = false;
    second = settle(roles.run('second', () => secondCall(fixture))).then(result => { secondDone = true; return result; });
    let blocked = false;
    await until(async () => {
      if (secondDone) return true;
      if (!pids.second) return false;
      const row = (await fixture.client.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked', [pids.first, pids.second])).rows[0];
      blocked = row.blocked;
      return blocked;
    }, 'second request to complete or wait for the held run lock');
    resume.resolve();
    const results = await Promise.all([first, second]);
    return { results, blocked };
  } finally {
    resume.resolve();
    await Promise.all([first, second].filter(Boolean));
    pool.connect = originalConnect;
  }
}

test('a desktop log event and run failure both commit without the task/run FK deadlock', options, async () => {
  await withFixture(async fixture => {
    const { results } = await raceAtTaskLock(fixture, input => appendCollectorRunEvent({ ...input, eventType: 'DESKTOP_LOG' }));
    assert.deepEqual(results.map(result => result.status === 'fulfilled' ? 'fulfilled' : result.reason.code), ['fulfilled', 'fulfilled']);
    const row = (await fixture.client.query(`SELECT r.status,r.processed_count,t.status AS task_status
      FROM collector_task_runs r JOIN collector_tasks t ON t.id=r.task_id WHERE r.id=$1`, [fixture.runId])).rows[0];
    assert.deepEqual(row, { status: 'FAILED', processed_count: 0, task_status: 'FAILED' });
    const events = (await fixture.client.query('SELECT event_type FROM collector_task_events WHERE run_id=$1 ORDER BY event_type', [fixture.runId])).rows;
    assert.deepEqual(events.map(row => row.event_type), ['DESKTOP_LOG', 'RUN_FAILED']);
  });
});

test('a desktop event batch and run completion lock order remain compatible',options,async()=>{
  await withFixture(async fixture=>{
    const {results}=await raceAtTaskLock(fixture,input=>appendCollectorRunEvents({...input,events:[{eventType:'BATCH_ONE'},{eventType:'BATCH_TWO'}]}),completeCollectorRun);
    assert.deepEqual(results.map(result=>result.status==='fulfilled'?'fulfilled':result.reason.code),['fulfilled','fulfilled']);
    const events=(await fixture.client.query("SELECT event_type FROM collector_task_events WHERE run_id=$1 AND event_type LIKE 'BATCH_%' ORDER BY id",[fixture.runId])).rows;
    assert.deepEqual(events.map(row=>row.event_type),['BATCH_ONE','BATCH_TWO']);
    assert.equal((await getCollectorRunForAccount(fixture.accountId,fixture.runId)).status,'COMPLETED');
  });
});

test('concurrent run finishers still serialize and commit exactly one terminal transition', options, async () => {
  await withFixture(async fixture => {
    const { results, blocked } = await raceAtTaskLock(fixture, failCollectorRun);
    assert.equal(blocked, true, 'the second state writer must wait for the first run lock');
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].reason?.code, 'COLLECTOR_RUN_NOT_RUNNING');
    const row = (await fixture.client.query(`SELECT r.status_version,t.status_version AS task_version,
      (SELECT COUNT(*)::int FROM collector_task_events WHERE run_id=r.id AND event_type='RUN_FAILED') AS events
      FROM collector_task_runs r JOIN collector_tasks t ON t.id=r.task_id WHERE r.id=$1`, [fixture.runId])).rows[0];
    assert.deepEqual(row, { status_version: 2, task_version: 2, events: 1 });
  });
});

test('account scope and the device lease still reject unauthorized run writes', options, async () => {
  await withFixture(async fixture => {
    for (const action of [failCollectorRun, input => appendCollectorRunEvent({ ...input, eventType: 'FORBIDDEN' })]) {
      await assert.rejects(action({ ...fixture, accountId: fixture.otherAccountId }), { code: 'COLLECTOR_RUN_NOT_FOUND' });
    }
    await assert.rejects(failCollectorRun({ ...fixture, leaseToken: 'wrong-lease' }), { code: 'COLLECTOR_RUN_LEASE_MISMATCH' });
    const row = (await fixture.client.query(`SELECT status,status_version,
      (SELECT COUNT(*)::int FROM collector_task_events WHERE run_id=$1) AS events FROM collector_task_runs WHERE id=$1`, [fixture.runId])).rows[0];
    assert.deepEqual(row, { status: 'RUNNING', status_version: 1, events: 0 });
  });
});

test('persisted progress and export survive task get/list reads with the public run shape', options, async () => {
  await withFixture(async ({ client, accountId, taskId, runId }) => {
    await client.query(`UPDATE collector_task_runs SET status='COMPLETED',total_count=7,processed_count=7,
      qualified_count=5,filtered_count=1,failed_count=1,started_at='2026-09-08T03:00:00Z',
      result_summary='{"exportedFilePath":"/fixture/collected.xlsx"}'::jsonb WHERE id=$1`, [runId]);
    await client.query(`UPDATE collector_tasks SET status='COMPLETED',created_at='2026-08-01T00:00:00Z',
      updated_at='2026-09-10T00:00:00Z' WHERE id=$1`, [taskId]);
    const before = (await client.query('SELECT to_jsonb(t) AS row FROM collector_tasks t WHERE id=$1', [taskId])).rows[0];
    const task = await getCollectorTaskForAccount(accountId, taskId);
    assert.deepEqual(task.currentRun, await getCollectorRunForAccount(accountId, runId, { includeSkuCount: true }));
    assert.equal(task.currentRun.progress.processedCount, 7);
    assert.equal(task.currentRun.resultSummary.exportedFilePath, '/fixture/collected.xlsx');
    assert.equal('leaseTokenHash' in task.currentRun, false);
    assert.equal('lease_token_hash' in task.currentRun, false);
    assert.equal(task.createdAt.toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(task.lastStartedAt.toISOString(), '2026-09-08T03:00:00.000Z');
    assert.deepEqual(await listCollectorTasksForAccount({ accountId }), [task]);
    assert.deepEqual((await listCollectorTasksPageForAccount({ accountId })).tasks, [task]);
    assert.deepEqual((await client.query('SELECT to_jsonb(t) AS row FROM collector_tasks t WHERE id=$1', [taskId])).rows[0], before);
  });
});

test('lastStartedAt ignores newer queued/updated dates and page projection uses bounded batch reads', options, async () => {
  await withFixture(async ({ client, accountId, taskId, runId, pricingId }) => {
    await client.query("UPDATE collector_task_runs SET status='FAILED',started_at='2026-09-08T03:00:00Z' WHERE id=$1", [runId]);
    await client.query(`INSERT INTO collector_task_runs(id,task_id,account_id,pricing_config_version_id,run_no,status,started_at,updated_at)
      VALUES($1,$2,$3,$4,2,'FAILED','2026-09-07T00:00:00Z','2026-09-10T00:00:00Z'),
            ($5,$2,$3,$4,3,'QUEUED',NULL,'2026-09-10T00:00:00Z')`, [runId + '-older', taskId, accountId, pricingId, runId + '-queued']);
    await client.query('UPDATE collector_tasks SET current_run_id=$2 WHERE id=$1', [taskId, runId + '-queued']);
    const task = await getCollectorTaskForAccount(accountId, taskId);
    assert.equal(task.lastStartedAt?.toISOString(), '2026-09-08T03:00:00.000Z');
    assert.equal(task.currentRun.id, runId + '-queued');
    assert.equal(task.currentRun.startedAt, null);
    for (const suffix of ['-new-a', '-new-b', '-off-page']) {
      await client.query(`INSERT INTO collector_tasks(id,account_id,task_type,updated_at)
        VALUES($1,$2,'MARKET',$3)`, [taskId + suffix, accountId, suffix === '-off-page' ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z']);
    }
    const queries = [], originalQuery = pool.query;
    let page;
    try {
      pool.query = function (sql, values, ...rest) {
        queries.push({ sql, values });
        return originalQuery.call(this, sql, values, ...rest);
      };
      page = await listCollectorTasksPageForAccount({ accountId, pageSize: 2 });
    } finally { pool.query = originalQuery; }
    assert.equal(page.total, 4);
    assert.equal(page.tasks.length, 2);
    assert.ok(queries.length <= 3, 'one count, one page, and at most one run projection query; no per-task query');
    const runReads = queries.filter(query => /collector_task_runs/.test(query.sql));
    assert.equal(runReads.length, 1);
    assert.ok(runReads[0].values.includes(accountId));
    assert.ok(runReads[0].values.some(value => Array.isArray(value)
      && [...value].sort().join() === page.tasks.map(task => task.id).sort().join()), 'only page task IDs are sent to the run lookup');
    for (const row of page.tasks) {
      assert.equal(row.lastStartedAt, null);
      assert.equal(row.currentRun, null);
      assert.deepEqual(row, await getCollectorTaskForAccount(accountId, row.id));
    }
    assert.deepEqual(await listCollectorTasksForAccount({ accountId, offset: 100 }), []);
  });
});

test('task projection cannot expose another account or another task through legacy run references', options, async () => {
  await withFixture(async ({ client, accountId, otherAccountId, taskId, runId, pricingId }) => {
    await client.query(`INSERT INTO collector_tasks(id,account_id,task_type) VALUES($1,$2,'MARKET'),($3,$4,'MARKET')`,
      [taskId + '-foreign', otherAccountId, taskId + '-sibling', accountId]);
    await client.query(`INSERT INTO collector_task_runs(id,task_id,account_id,pricing_config_version_id,run_no,status,started_at,result_summary)
      VALUES($1,$2,$3,$4,1,'COMPLETED','2099-01-01T00:00:00Z','{"exportedFilePath":"/foreign/private.xlsx"}'),
            ($5,$6,$7,$4,1,'COMPLETED','2099-01-01T00:00:00Z','{}'),
            ($8,$9,$3,$4,2,'FAILED','2099-01-01T00:00:00Z','{}')`,
      [runId + '-foreign', taskId + '-foreign', otherAccountId, pricingId,
        runId + '-sibling', taskId + '-sibling', accountId, runId + '-legacy-account-mismatch', taskId]);
    const actualStart = (await client.query('SELECT started_at FROM collector_task_runs WHERE id=$1', [runId])).rows[0].started_at;
    for (const reference of [runId + '-foreign', runId + '-sibling']) {
      // Historical FKs are single-column, so account/task mismatches can exist.
      await client.query('UPDATE collector_tasks SET current_run_id=$2 WHERE id=$1', [taskId, reference]);
      const task = await getCollectorTaskForAccount(accountId, taskId);
      assert.equal(task.currentRun, null);
      assert.deepEqual(task.lastStartedAt, actualStart);
      assert.deepEqual((await listCollectorTasksForAccount({ accountId })).find(row => row.id === taskId), task);
    }
    assert.equal(await getCollectorTaskForAccount(otherAccountId, taskId), null);
    assert.equal((await listCollectorTasksForAccount({ accountId })).some(row => row.accountId !== accountId), false);
  });
});

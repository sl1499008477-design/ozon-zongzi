import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

async function fixture({ locked = true, startError, deferredDrain = false } = {}) {
  const { startAiListingWorker } = await import('../ai-listing-worker.mjs');
  const events = [];
  const processRef = Object.assign(new EventEmitter(), { env: {} });
  const client = Object.assign(new EventEmitter(), {
    async query(sql, params) {
      assert.deepEqual(params, ['ai-listing-image-worker']);
      if (sql.includes('pg_try_advisory_lock')) { events.push('lock'); return { rows: [{ locked }] }; }
      assert.match(sql, /pg_advisory_unlock/);
      events.push('unlock'); return { rows: [{ unlocked: true }] };
    },
    release(destroy) { events.push(destroy ? 'discard' : 'release'); },
  });
  let finishDrain;
  const drain = deferredDrain ? new Promise(resolve => { finishDrain = resolve; }) : Promise.resolve();
  const ports = {
    processRef, enabled: () => true, assertConfiguration() {},
    logger: { log() {}, error() {} },
    async resolvePool() { return { async connect() { events.push('connect'); return client; } }; },
    async closePool() { events.push('close'); client.emit('end'); },
    createRuntime() {
      events.push('create');
      return {
        async start(options) { assert.deepEqual(options, { mode: 'worker' }); events.push('start'); if (startError) throw startError; },
        async stop() { events.push('stop-admission'); await drain; events.push('drained'); },
      };
    },
  };
  return { start: () => startAiListingWorker(ports), ports, events, client, processRef, finishDrain };
}

test('duplicate worker never creates or starts a consumer and closes its pool', async () => {
  const f = await fixture({ locked: false });
  await assert.rejects(f.start(), { code: 'AI_LISTING_WORKER_ALREADY_RUNNING' });
  assert.deepEqual(f.events, ['connect', 'lock', 'release', 'close']);
});

test('worker starts only while holding lock and SIGTERM drains before releasing it', async () => {
  const f = await fixture({ deferredDrain: true });
  const worker = await f.start();
  assert.deepEqual(f.events, ['connect', 'lock', 'create', 'start']);
  assert.equal(f.processRef.env.POSTGRES_POOL_MAX, '4');
  f.processRef.emit('SIGTERM');
  assert.deepEqual(f.events.slice(-1), ['stop-admission']);
  f.finishDrain();
  assert.equal(await worker.done, 0);
  assert.deepEqual(f.events.slice(-5), ['stop-admission', 'drained', 'unlock', 'release', 'close']);
  await worker.stop();
  assert.equal(f.events.filter(event => event === 'close').length, 1);
});

for (const event of ['error', 'end']) {
  test(`lost lock connection (${event}) stops admission immediately and fails after drain`, async () => {
    const f = await fixture({ deferredDrain: true });
    const worker = await f.start();
    f.client.emit(event, new Error('synthetic disconnect'));
    assert.deepEqual(f.events.slice(-1), ['stop-admission']);
    f.finishDrain();
    assert.equal(await worker.done, 1);
    assert.equal(f.processRef.exitCode, 1);
    assert.deepEqual(f.events.slice(-4), ['stop-admission', 'drained', 'discard', 'close']);
    assert.equal(f.events.includes('unlock'), false);
  });
}

test('startup failure drains the runtime before unlocking and closes the pool', async () => {
  const failure = new Error('startup failed');
  const f = await fixture({ startError: failure });
  await assert.rejects(f.start(), failure);
  assert.deepEqual(f.events.slice(-5), ['stop-admission', 'drained', 'unlock', 'release', 'close']);
});

test('disabled pipeline opens neither pool nor consumer', async () => {
  const f = await fixture();
  f.ports.enabled = () => false;
  const worker = await f.start();
  assert.equal(await worker.done, 0);
  assert.deepEqual(f.events, []);
});

test('PostgreSQL session lock excludes a second process and connection loss releases resources', {
  skip: !process.env.AI_WORKER_TEST_DATABASE_URL,
}, async () => {
  const { Pool } = await import('pg');
  const { startAiListingWorker } = await import('../ai-listing-worker.mjs');
  const control = new Pool({ connectionString: process.env.AI_WORKER_TEST_DATABASE_URL, max: 1 });
  const pools = [];
  const processes = [];
  const runtimeEvents = [];
  let first;
  const options = () => {
    const pool = new Pool({ connectionString: process.env.AI_WORKER_TEST_DATABASE_URL, max: 4 });
    pools.push(pool);
    const processRef = Object.assign(new EventEmitter(), { env: {} });
    processes.push(processRef);
    return {
      enabled: () => true, assertConfiguration() {}, processRef,
      logger: { log() {}, error() {} }, resolvePool: async () => pool,
      closePool: () => pool.end(),
      createRuntime: () => ({
        start: async () => { runtimeEvents.push('start'); },
        stop: async () => { runtimeEvents.push('stop'); },
      }),
    };
  };
  try {
    first = await startAiListingWorker(options());
    await assert.rejects(startAiListingWorker(options()), { code: 'AI_LISTING_WORKER_ALREADY_RUNNING' });
    assert.deepEqual(runtimeEvents, ['start']);
    const result = await control.query(`SELECT pid FROM pg_locks WHERE locktype='advisory'
      AND objid=hashtext('ai-listing-image-worker')::oid AND granted`);
    assert.equal(result.rows.length, 1);
    await control.query('SELECT pg_terminate_backend($1)', [result.rows[0].pid]);
    assert.equal(await first.done, 1);
    assert.deepEqual(runtimeEvents, ['start', 'stop']);
    assert.equal(processes[0].exitCode, 1);
    const replacement = await startAiListingWorker(options());
    await replacement.stop();
    assert.equal(await replacement.done, 0);
  } finally {
    await first?.stop();
    await control.end();
    for (const pool of pools) if (!pool.ended) await pool.end();
  }
});

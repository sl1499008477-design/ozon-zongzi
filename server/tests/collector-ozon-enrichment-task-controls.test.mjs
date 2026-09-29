import assert from 'node:assert/strict';
import test from 'node:test';
import { createJsonCollectorOzonEnrichmentRepository } from '../collector-ozon-enrichment-repository.mjs';
import { createCollectorOzonEnrichmentRuntime } from '../collector-ozon-enrichment-runtime.mjs';
import { createJsonStateTransactionBoundary } from '../json-state-transaction.mjs';
import { purgeCollectedItems } from '../collection-purge.mjs';

const NOW = new Date('2026-09-16T12:00:00Z');
const SESSION = { accountId: 'account-a', collectorSessionId: 'session-a' };
const context = { sellerCompanyId: '2681910', revision: 1, observedAt: NOW.toISOString() };
const claim = (extra = {}) => ({ ...SESSION, now: NOW, claimExpiresAt: new Date(NOW.getTime() + 60000), claimFence: 'fence-a', captureContext: context, ...extra });
const control = (taskKey, action, extra = {}) => ({ ...SESSION, taskKey, action, now: NOW, ...extra });

function fixture() {
  const state = {
    collectorSessions: [
      { id: 'session-a', accountId: 'account-a', expiresAt: '2099-01-01T00:00:00Z' },
      { id: 'session-b', accountId: 'account-b', expiresAt: '2099-01-01T00:00:00Z' },
    ],
    collectorTasks: [{ id: 'task-a', accountId: 'account-a', name: '同名任务' }],
    collectorTaskRuns: [
      { id: 'run-a', taskId: 'task-a', accountId: 'account-a', createdAt: '2026-09-15T12:00:00Z' },
      { id: 'run-b', taskId: 'task-a', accountId: 'account-a', createdAt: '2026-09-16T11:00:00Z' },
    ],
    caches: { collectBox: [
      { id: 'collect-a', accountId: 'account-a', collectorRunId: 'run-a', collectorTaskId: 'task-a', name: '商品 A', evidence: 'keep-a' },
      { id: 'collect-b', accountId: 'account-a', collectorRunId: 'run-b', collectorTaskId: 'task-a', name: '商品 B', evidence: 'keep-b' },
      { id: 'collect-fallback', accountId: 'account-a', name: '其他来源商品' },
      { id: 'collect-foreign', accountId: 'account-b', collectorRunId: 'run-foreign' },
    ] },
  };
  return { state, repository: createJsonCollectorOzonEnrichmentRepository({ state }) };
}

async function enqueue(repository, collectItemId, sku, requestId = `request-${sku}`, accountId = 'account-a') {
  return repository.enqueueForCollect({ accountId, collectItemId, requestId, sku, refreshBundle: {}, now: NOW });
}

function finish(job, extra = {}) {
  return { ...claim(), jobId: job.id,
    key: { accountId: 'account-a', source: 'ozon', sku: job.sku, contractVersion: 'collector.ozon.enrichment.v1' },
    result: { status: 'COMPLETE', savedEvidence: 'keep-result' }, responseHash: 'hash', capturedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60000), ...extra };
}

test('task summaries retain separate runs and deduplicate retries without exposing product payloads', async () => {
  const { state, repository } = fixture();
  const first = await enqueue(repository, 'collect-a', '100');
  state.collectorOzonEnrichmentJobs[0] = { ...first, status: 'FAILED', error: { message: '原始失败' }, completedAt: NOW.toISOString() };
  await enqueue(repository, 'collect-a', '100', 'retry-100');
  state.collectorOzonEnrichmentJobs.push({ ...first, id: 'superseded-duplicate', status: 'FAILED',
    createdAt: new Date(NOW.getTime() + 1).toISOString(), error: { code: 'ZONGZI_ENRICHMENT_DUPLICATE_SUPERSEDED', message: '重复审计记录' } });
  await enqueue(repository, 'collect-a', '101');
  await enqueue(repository, 'collect-b', '200');
  await enqueue(repository, 'collect-fallback', '300');
  await enqueue(repository, 'collect-foreign', '999', 'foreign', 'account-b');
  await repository.createOrGetJob({ id: 'legacy-job', accountId: 'account-a', requestId: 'legacy-request', sku: '400', refreshBundle: false, createdAt: NOW, deadlineAt: new Date(NOW.getTime() + 1000) });
  const tasks = await repository.listTasks({ accountId: 'account-a' });
  assert.equal(tasks.length, 4);
  const group = tasks.find(task => task.key === 'run:run-a');
  assert.deepEqual(group, { key: 'run:run-a', name: '同名任务', taskId: 'task-a', runId: 'run-a', createdAt: '2026-09-15T12:00:00.000Z', controlState: 'ACTIVE', total: 2, pending: 2, processing: 0, completed: 0, failed: 0, currentSkus: [], errorMessage: '' });
  assert.equal(tasks.find(task => task.key === 'run:run-b').name, '同名任务');
  assert.ok(tasks.some(task => task.key === 'collect:collect-fallback'));
  assert.ok(tasks.some(task => task.key === 'request:legacy-request'));
  assert.ok(!JSON.stringify(tasks).includes('keep-a'));
});

test('pause invalidates old claims, frees other groups and resumes remaining work without changing successes', async () => {
  const { state, repository } = fixture();
  await enqueue(repository, 'collect-a', '100');
  const success = await repository.claimNextJob(claim());
  await repository.completeJobAndCache(finish(success));
  await enqueue(repository, 'collect-a', '101');
  const running = await repository.claimNextJob(claim({ claimFence: 'fence-running' }));
  await enqueue(repository, 'collect-b', '200');
  const productsBefore = structuredClone(state.caches.collectBox);
  const cacheBefore = structuredClone(state.collectorOzonEnrichmentCache);
  const paused = await repository.controlTask(control('run:run-a', 'pause'));
  assert.equal(paused.controlState, 'PAUSED');
  assert.deepEqual([paused.total, paused.pending, paused.processing, paused.completed, paused.failed], [2, 1, 0, 1, 0]);
  const stopped = await repository.readJob({ accountId: 'account-a', jobId: running.id });
  assert.equal(stopped.attemptCount, 0);
  assert.equal(stopped.lastError, null);
  await assert.rejects(repository.completeJobAndCache(finish(running, { claimFence: 'fence-running' })), { code: 'ZONGZI_ENRICHMENT_JOB_OWNERSHIP' });
  await assert.rejects(repository.deferClaim({ ...claim(), jobId: running.id, error: { code: 'ZONGZI_ENRICH_UPSTREAM_FAILED' } }), { code: 'ZONGZI_ENRICHMENT_JOB_OWNERSHIP' });
  await assert.rejects(repository.claimNextJob(claim({ jobId: running.id, claimFence: 'fence-running' })), { code: 'ZONGZI_ENRICHMENT_JOB_OWNERSHIP' });
  const other = await repository.claimNextJob(claim());
  assert.equal(other.sku, '200');
  assert.equal(other.taskGroupKey, 'run:run-b');
  await repository.controlTask(control('run:run-b', 'pause'));
  assert.equal(await repository.hasClaimableJob(claim()), false);
  assert.equal((await repository.controlTask(control('run:run-a', 'resume'))).controlState, 'ACTIVE');
  assert.equal((await repository.claimNextJob(claim({ claimFence: 'new-fence' }))).id, running.id);
  assert.deepEqual(state.caches.collectBox, productsBefore);
  assert.deepEqual(state.collectorOzonEnrichmentCache, cacheBefore);
});

test('cancel survives a fresh repository and retry enqueue, and foreign groups are inaccessible', async () => {
  const { state } = fixture();
  let saved;
  const repository = createJsonCollectorOzonEnrichmentRepository({ state, persist: async value => { saved = JSON.stringify(value); } });
  const original = await enqueue(repository, 'collect-a', '100');
  state.collectorOzonEnrichmentJobs[0] = { ...original, status: 'FAILED', error: { message: '原始失败' }, completedAt: NOW.toISOString() };
  assert.equal((await repository.listTasks({ accountId: 'account-a' }))[0].failed, 1);
  assert.equal((await repository.listTasks({ accountId: 'account-a' }))[0].errorMessage, '原始失败');
  await repository.controlTask(control('run:run-a', 'cancel'));
  const fresh = createJsonCollectorOzonEnrichmentRepository({ state: JSON.parse(saved) });
  await enqueue(fresh, 'collect-a', '100', 'retry-cancelled');
  assert.equal(await fresh.claimNextJob(claim()), null);
  assert.equal(await fresh.hasClaimableJob(claim()), false);
  assert.equal((await fresh.listTasks({ accountId: 'account-a' }))[0].controlState, 'CANCELLED');
  await assert.rejects(fresh.controlTask(control('run:run-a', 'resume')), { code: 'ZONGZI_ENRICHMENT_TASK_CANCELLED', status: 409 });
  await assert.rejects(fresh.controlTask(control('run:run-a', 'pause')), { code: 'ZONGZI_ENRICHMENT_TASK_CANCELLED', status: 409 });
  await assert.rejects(fresh.controlTask(control('run:run-a', 'cancel', { accountId: 'account-b' })), { code: 'ZONGZI_ENRICHMENT_TASK_NOT_FOUND', status: 404 });
});

test('Collector task routes authenticate, validate exact bodies and expose scoped controls', async () => {
  const { state, repository } = fixture();
  await enqueue(repository, 'collect-a', '100');
  const runtime = createCollectorOzonEnrichmentRuntime({ loadState: async () => state, saveState: async () => {}, persistenceMode: () => 'json', stateTransaction: createJsonStateTransactionBoundary({ enabled: () => true }),
    authenticate: async (_req, permission) => { assert.equal(permission, 'collector.ozon.read'); return SESSION; },
    readJson: async req => req.body, sendJson: (res, status, payload) => Object.assign(res, { status, payload }), now: () => NOW,
  });
  async function request(path, body) {
    const res = {};
    assert.equal(await runtime.handleHttpRoute({ method: 'POST', body, headers: {} }, res, new URL(path, 'http://localhost')), true);
    return res;
  }
  const listPath = '/collector/ozon/enrichment-jobs/tasks';
  const controlPath = `${listPath}/control`;
  const listed = await request(listPath, {});
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.tasks[0].key, 'run:run-a');
  const oldClaim = await runtime.service.claimNext({ session: SESSION, captureContext: context });
  const paused = await request(controlPath, { taskKey: 'run:run-a', action: 'pause' });
  assert.equal(paused.status, 200);
  assert.equal(paused.payload.task.controlState, 'PAUSED');
  assert.equal((await request(`/collector/ozon/enrichment-jobs/${oldClaim.id}/progress`, { captureContext: context, claimFence: oldClaim.claimFence })).status, 409);
  assert.equal((await request(`/collector/ozon/enrichment-jobs/${oldClaim.id}/result`, {
    captureContext: context, claimFence: oldClaim.claimFence,
    variantData: { description_category_id: 123, weight: 500, depth: 100, width: 100, height: 100, attributes: [] },
  })).status, 409);
  assert.equal((await request(`/collector/ozon/enrichment-jobs/${oldClaim.id}/fail`, { captureContext: context, claimFence: oldClaim.claimFence, code: 'ZONGZI_ENRICH_UPSTREAM_FAILED', message: 'late abort' })).status, 409);
  assert.equal(state.collectorOzonEnrichmentJobs[0].attemptCount, 0);
  assert.equal(state.collectorOzonEnrichmentJobs[0].lastError, null);
  for (const body of [{ taskKey: 'run:run-a', action: 'delete' }, { taskKey: '', action: 'pause' }, { taskKey: 'run:run-a', action: 'pause', accountId: 'account-b' }, null]) {
    assert.equal((await request(controlPath, body)).status, 400);
  }
  assert.equal((await request(listPath, { accountId: 'account-b' })).status, 400);
  assert.equal((await request(controlPath, { taskKey: 'run:foreign', action: 'pause' })).status, 404);
  await request(controlPath, { taskKey: 'run:run-a', action: 'resume' });
  const next = await runtime.service.claimNext({ session: SESSION, captureContext: context });
  assert.equal(next.taskKey, 'run:run-a');
  await repository.createOrGetJob({ id: 'request-with-spaces', accountId: 'account-a', requestId: 'request with spaces', sku: '900', refreshBundle: false, createdAt: NOW, deadlineAt: new Date(NOW.getTime() + 1000) });
  assert.equal((await request(controlPath, { taskKey: 'request:request with spaces', action: 'pause' })).status, 200);
});

test('PostgreSQL runtime task lists use a scoped summary query without loading JSON or product payloads', async () => {
  const { createPostgresCollectorOzonEnrichmentRepository } = await import('../collector-ozon-enrichment-repository.mjs');
  const pool = { async query(sql, params) {
    assert.deepEqual(params, ['account-a', null]);
    assert.match(sql, /account_id\s*=\s*\$1/);
    assert.ok(!/SELECT\s+\*/i.test(sql));
    assert.ok(!/raw_json/.test(sql));
    return { rows: [{ key: 'run:run-a', name: '任务', task_id: 'task-a', run_id: 'run-a', created_at: NOW,
      control_state: 'ACTIVE', total: '2', pending: '1', processing: '0', completed: '1', failed: '0', current_skus: [], error_message: '' }] };
  } };
  const runtime = createCollectorOzonEnrichmentRuntime({ loadState: async () => { throw new Error('full state forbidden'); }, saveState: async () => { throw new Error('JSON write forbidden'); }, persistenceMode: () => 'postgres', stateTransaction: createJsonStateTransactionBoundary({ enabled: () => false }),
    initializePostgresRepository: async () => createPostgresCollectorOzonEnrichmentRepository({ pool }), authenticate: async () => SESSION,
    readJson: async req => req.body, sendJson: (res, status, payload) => Object.assign(res, { status, payload }), now: () => NOW,
  });
  const tasks = await runtime.service.listTasks({ session: SESSION });
  assert.deepEqual(tasks, [{ key: 'run:run-a', name: '任务', taskId: 'task-a', runId: 'run-a', createdAt: NOW.toISOString(), controlState: 'ACTIVE', total: 2, pending: 1, processing: 0, completed: 1, failed: 0, currentSkus: [], errorMessage: '' }]);
});

test('explicit collection purge clears only orphaned collect controls so a fresh collection can run', async () => {
  const queries = [];
  const client = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT c.id,')) return { rows: [{ id: 'collect-deleted', source: 'ozon', source_sku: '100', data: {} }] };
    return { rows: [], rowCount: 0 };
  } };
  assert.equal(await purgeCollectedItems(client, 'account-a', ['collect-deleted']), 1);
  const cleanup = queries.find(query => query.sql.startsWith('DELETE FROM collector_ozon_enrichment_task_controls'));
  assert.ok(cleanup, 'purge must remove a stale item-level stop before a new collection reuses its ID');
  assert.deepEqual(cleanup.params, ['account-a', ['collect:collect-deleted']]);
  assert.match(cleanup.sql, /NOT EXISTS/);
  assert.match(queries[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(queries[0].params, ['account-a']);
});

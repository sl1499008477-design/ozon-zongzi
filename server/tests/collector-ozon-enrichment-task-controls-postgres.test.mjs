import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { createPostgresCollectorOzonEnrichmentRepository } from '../collector-ozon-enrichment-repository.mjs';
import { purgeCollectedItems } from '../collection-purge.mjs';

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const migrationDir = new URL('../db/migrations/', import.meta.url);
const NOW = new Date('2026-09-16T12:00:00Z');
const context = { sellerCompanyId: 'company', revision: 1, observedAt: NOW.toISOString() };

test('PostgreSQL task migration, scoped controls, retry persistence and racing claims preserve saved evidence', {
  skip: !databaseUrl && 'SONLI_MIGRATION_TEST_DATABASE_URL is not configured', timeout: 60000,
}, async () => {
  const { Pool } = await import('pg');
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `enrichment_controls_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    const migrations = (await readdir(migrationDir)).filter(file => /^\d{3}_.+\.sql$/.test(file)).sort();
    for (const file of migrations.filter(file => Number(file.slice(0, 3)) <= 142)) await pool.query(await readFile(new URL(file, migrationDir), 'utf8'));
    for (const account of ['a', 'b']) {
      await pool.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$1,$1,'user','active')", [account]);
      await pool.query("INSERT INTO sessions (token,account_id,issued_at,expires_at) VALUES ($1,$2,$3,'2099-01-01')", [`web-${account}`, account, NOW]);
      await pool.query("INSERT INTO collector_sessions (id,token_hash,account_id,parent_session_token,permissions,expires_at) VALUES ($1,$1,$2,$3,'[\"collector.ozon.read\"]','2099-01-01')", [`session-${account}`, account, `web-${account}`]);
    }
    await pool.query("INSERT INTO collector_tasks (id,account_id,name,task_type,source) VALUES ('task-a','a','同名采集任务','links','ozon')");
    for (const [runId, runNo] of [['run-a', 1], ['run-b', 2]]) {
      await pool.query("INSERT INTO collector_task_runs (id,task_id,account_id,run_no,status,created_at) VALUES ($1,'task-a','a',$2,'COMPLETED','2026-09-15T12:00:00Z')", [runId, runNo]);
    }
    for (const [id, accountId, runId] of [['collect-a', 'a', 'run-a'], ['collect-b', 'a', 'run-b'], ['collect-fallback', 'a', ''], ['collect-foreign', 'b', 'run-foreign']]) {
      await pool.query("INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary) VALUES ($1,$2,'ozon',$1,$1,'{}')", [id, accountId]);
      await pool.query("INSERT INTO collect_raw_payloads (id,collect_item_id,account_id,payload_hash,payload,created_at) VALUES ($1,$2,$3,$1,$4::jsonb,$5)", [`raw-${id}`, id, accountId,
        JSON.stringify({ source: { collectorRunId: runId, collectorTaskId: 'task-a', saved: 'preserve' } }), NOW]);
    }
    await pool.query("INSERT INTO collector_ozon_enrichment_jobs (id,account_id,collect_item_id,request_id,sku,status,refresh_bundle,deadline_at,created_at,updated_at,next_attempt_at) VALUES ('old-linked','a','collect-a','old-request','100','PENDING','{}','2099-01-01',$1,$1,$1),('old-fallback','a','collect-fallback','fallback','300','PENDING','{}','2099-01-01',$1,$1,$1),('old-request-job','a',NULL,'legacy','400','PENDING','{}','2099-01-01',$1,$1,$1)", [NOW]);
    // A later re-collection must not relabel an existing job's original run.
    await pool.query("INSERT INTO collect_raw_payloads (id,collect_item_id,account_id,payload_hash,payload,created_at) VALUES ('later-raw','collect-a','a','later-hash',$1::jsonb,$2)",
      [JSON.stringify({ source: { collectorRunId: 'run-b' } }), new Date(NOW.getTime() + 1)]);
    await pool.query(await readFile(new URL('143_collector_enrichment_task_controls.sql', migrationDir), 'utf8'));
    const keys = await pool.query('SELECT id,task_group_key FROM collector_ozon_enrichment_jobs ORDER BY id');
    assert.deepEqual(keys.rows, [{ id: 'old-fallback', task_group_key: 'collect:collect-fallback' }, { id: 'old-linked', task_group_key: 'run:run-a' }, { id: 'old-request-job', task_group_key: 'request:legacy' }]);
    await pool.query("DELETE FROM collect_raw_payloads WHERE id='later-raw'");
    const repository = createPostgresCollectorOzonEnrichmentRepository({ pool });
    // Old worker INSERT shape remains valid and derives the same persisted key.
    await pool.query("INSERT INTO collector_ozon_enrichment_jobs (id,account_id,collect_item_id,request_id,sku,status,refresh_bundle,deadline_at,created_at,updated_at) VALUES ('old-worker-job','a','collect-a','old-worker-request','102','PENDING','{}','2099-01-01',$1,$1)", [NOW]);
    assert.equal((await pool.query("SELECT task_group_key FROM collector_ozon_enrichment_jobs WHERE id='old-worker-job'")).rows[0].task_group_key, 'run:run-a');
    await pool.query("DELETE FROM collector_ozon_enrichment_jobs WHERE id='old-worker-job'");
    const restoreClient = await pool.connect();
    try {
      await restoreClient.query('BEGIN');
      await restoreClient.query("SET LOCAL search_path=''");
      await restoreClient.query(`INSERT INTO "${schema}".collector_ozon_enrichment_jobs (id,account_id,collect_item_id,request_id,sku,status,refresh_bundle,deadline_at,created_at,updated_at) VALUES ('restore-worker-job','a','collect-a','restore-worker-request','102','PENDING','{}','2099-01-01',$1,$1)`, [NOW]);
      assert.equal((await restoreClient.query(`SELECT task_group_key FROM "${schema}".collector_ozon_enrichment_jobs WHERE id='restore-worker-job'`)).rows[0].task_group_key, 'run:run-a');
    } finally { await restoreClient.query('ROLLBACK'); restoreClient.release(); }
    const enqueue = (collectItemId, sku, requestId = `request-${sku}`, accountId = 'a', now = NOW) => repository.enqueueForCollect({ accountId, collectItemId, requestId, sku, refreshBundle: {}, now });
    const claim = (extra = {}) => ({ accountId: 'a', collectorSessionId: 'session-a', now: NOW, claimExpiresAt: new Date(NOW.getTime() + 60000), captureContext: context, claimFence: crypto.randomUUID(), ...extra });
    const control = (taskKey, action, extra = {}) => repository.controlTask({ accountId: 'a', taskKey, action, now: NOW, ...extra });
    await control('collect:collect-fallback', 'pause');
    await control('request:legacy', 'pause');
    const due = (await pool.query("SELECT next_attempt_at <= $1 AS due FROM collector_ozon_enrichment_jobs WHERE id='old-linked'", [NOW])).rows[0];
    assert.equal(due.due, true, 'fixture next_attempt_at must use the same clock as the claim');
    const first = await repository.claimNextJob(claim());
    assert.equal(first.taskGroupKey, 'run:run-a');
    const finish = job => ({ ...claim({ claimFence: job.claimFence }), jobId: job.id, key: { accountId: 'a', source: 'ozon', sku: job.sku, contractVersion: 'collector.ozon.enrichment.v1' }, result: { saved: 'keep-result' }, responseHash: 'hash', capturedAt: NOW, expiresAt: new Date(NOW.getTime() + 60000) });
    await repository.completeJobAndCache(finish(first));
    await enqueue('collect-a', '101');
    const active = await repository.claimNextJob(claim());
    await enqueue('collect-b', '200');
    await enqueue('collect-foreign', '999', 'foreign', 'b');
    const before = (await pool.query('SELECT id,payload FROM collect_raw_payloads ORDER BY id')).rows;
    const cacheBefore = (await pool.query('SELECT * FROM collector_ozon_enrichment_cache')).rows;
    const paused = await control('run:run-a', 'pause');
    assert.deepEqual([paused.controlState, paused.total, paused.pending, paused.completed], ['PAUSED', 2, 1, 1]);
    await assert.rejects(repository.completeJobAndCache(finish(active)), { code: 'ZONGZI_ENRICHMENT_JOB_OWNERSHIP' });
    await assert.rejects(repository.claimNextJob(claim({ jobId: active.id, claimFence: active.claimFence })), { code: 'ZONGZI_ENRICHMENT_JOB_OWNERSHIP' });
    await assert.rejects(repository.deferClaim({ ...claim({ claimFence: active.claimFence }), jobId: active.id, error: { code: 'ZONGZI_ENRICH_UPSTREAM_FAILED' } }), { code: 'ZONGZI_ENRICHMENT_JOB_OWNERSHIP' });
    assert.equal((await repository.claimNextJob(claim())).sku, '200');
    await control('run:run-b', 'pause');
    assert.equal(await repository.hasClaimableJob(claim()), false);
    await control('run:run-a', 'resume');
    const resumed = await repository.claimNextJob(claim());
    assert.equal(resumed.id, active.id);
    assert.equal(resumed.attemptCount, 0);
    await assert.rejects(repository.completeJobAndCache(finish(active)), { code: 'SELLER_CONTEXT_CHANGED' });
    await repository.failJobAndCache({ ...finish(resumed), error: { code: 'ZONGZI_ENRICH_NOT_FOUND', message: '历史失败' } });
    let summary = (await repository.listTasks({ accountId: 'a' })).find(task => task.key === 'run:run-a');
    assert.equal(summary.failed, 1);
    assert.equal(summary.errorMessage, '历史失败');
    await control('run:run-a', 'cancel');
    const fresh = createPostgresCollectorOzonEnrichmentRepository({ pool });
    await enqueue('collect-a', '101', 'retry-cancelled', 'a', new Date(NOW.getTime() + 1));
    assert.equal(await fresh.claimNextJob(claim({ now: new Date(NOW.getTime() + 2) })), null);
    summary = (await fresh.listTasks({ accountId: 'a' })).find(task => task.key === 'run:run-a');
    assert.deepEqual([summary.total, summary.pending, summary.completed, summary.failed, summary.controlState], [2, 1, 1, 0, 'CANCELLED']);
    await assert.rejects(control('run:run-a', 'resume'), { code: 'ZONGZI_ENRICHMENT_TASK_CANCELLED', status: 409 });
    await assert.rejects(control('run:run-a', 'pause', { accountId: 'b' }), { code: 'ZONGZI_ENRICHMENT_TASK_NOT_FOUND', status: 404 });
    assert.deepEqual((await pool.query('SELECT id,payload FROM collect_raw_payloads ORDER BY id')).rows, before);
    // Failure may replace the other SKU cache; the previously completed SKU must survive.
    assert.deepEqual((await pool.query("SELECT * FROM collector_ozon_enrichment_cache WHERE sku='100'")).rows, cacheBefore);
    const groups = await fresh.listTasks({ accountId: 'a' });
    assert.equal(groups.find(task => task.key === 'run:run-b').name, '同名采集任务');
    assert.equal(groups.find(task => task.key === 'run:run-a').createdAt, '2026-09-15T12:00:00.000Z');

    // Queue the claim behind a control transaction using the same account fence.
    await control('run:run-b', 'resume');
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['a']);
      const controlling = createPostgresCollectorOzonEnrichmentRepository({ pool: blocker, transactionOwner: 'caller' });
      const racingClaim = fresh.claimNextJob(claim());
      await controlling.controlTask({ accountId: 'a', taskKey: 'run:run-b', action: 'pause', now: NOW });
      await blocker.query('COMMIT');
      assert.equal(await racingClaim, null);
    } finally { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); }
    await control('collect:collect-fallback', 'cancel');
    await pool.query("INSERT INTO collector_ozon_enrichment_task_controls (account_id,task_group_key,control_state) VALUES ('b','collect:collect-fallback','CANCELLED')");
    const purgeClient = await pool.connect();
    try {
      await purgeClient.query('BEGIN');
      assert.equal(await purgeCollectedItems(purgeClient, 'a', ['collect-fallback']), 1);
      await purgeClient.query('COMMIT');
    } finally { await purgeClient.query('ROLLBACK').catch(() => {}); purgeClient.release(); }
    assert.equal((await pool.query("SELECT 1 FROM collector_ozon_enrichment_task_controls WHERE account_id='a' AND task_group_key='collect:collect-fallback'")).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM collector_ozon_enrichment_task_controls WHERE account_id='b' AND task_group_key='collect:collect-fallback'")).rowCount, 1);
    assert.equal((await pool.query("SELECT control_state FROM collector_ozon_enrichment_task_controls WHERE account_id='a' AND task_group_key='request:legacy'")).rows[0].control_state, 'PAUSED');
    assert.equal((await pool.query("SELECT control_state FROM collector_ozon_enrichment_task_controls WHERE account_id='a' AND task_group_key='run:run-a'")).rows[0].control_state, 'CANCELLED');
    await pool.query("INSERT INTO collect_items (id,account_id,source,identity_key,source_sku,summary) VALUES ('collect-fallback','a','ozon','collect-fallback','300','{}')");
    await enqueue('collect-fallback', '300', 'fresh-after-purge');
    assert.equal((await fresh.claimNextJob(claim())).sku, '300', 'a fresh collection after explicit deletion must not inherit the removed item control');
    // Removing source rows cannot detach a persisted stop from surviving jobs.
    await pool.query("DELETE FROM collect_items WHERE id='collect-a'");
    assert.equal(await fresh.claimNextJob(claim()), null);
    assert.equal((await fresh.listTasks({ accountId: 'a' })).find(task => task.key === 'run:run-a').controlState, 'CANCELLED');
    // Test this table's account cascade without bypassing the application's
    // cleanup order for the other account's historical raw/product records.
    await pool.query("INSERT INTO accounts (id,username,display_name,role,status) VALUES ('control-only','control-only','control-only','user','active')");
    await pool.query("INSERT INTO collector_ozon_enrichment_task_controls (account_id,task_group_key,control_state) VALUES ('control-only','request:cascade','CANCELLED')");
    await pool.query("DELETE FROM accounts WHERE id='control-only'");
    assert.equal((await pool.query("SELECT COUNT(*) FROM collector_ozon_enrichment_task_controls WHERE account_id='control-only'")).rows[0].count, '0');
    assert.equal((await fresh.listTasks({ accountId: 'a' })).find(task => task.key === 'run:run-a').controlState, 'CANCELLED');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});

import './support/dedicated-postgres-test-environment.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPostgresPool, closePostgresPool } from '../db/connection.mjs';
import { createCollectorTask, queueCollectorTaskRun, claimCollectorRun, claimCollectorRunSkus,
  releaseCollectorRunSkus, upsertCollectorRunItem, failCollectorRun, cancelCollectorRun,
  heartbeatCollectorRun, getCollectorRunForAccount, listCollectorRunEvents,
  appendCollectorRunEvent } from '../collector-desktop-service.mjs';

const enabled = process.env.SONLI_POSTGRES_TESTS === '1';
const options = { skip: !enabled, timeout: 20000 };
let pool;
before(async () => {
  if (!enabled) return;
  assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  assert.equal(process.env.DATABASE_URL, process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  assert.ok(!['/sonli_local', '/postgres', '/template0', '/template1'].includes(new URL(process.env.DATABASE_URL).pathname));
  pool = await getPostgresPool();
  await getCollectorRunForAccount('missing-account', 'missing-run');
});
after(async () => { if (enabled) await closePostgresPool(); });

async function fixture(fn) {
  const accountId = 'dedup-' + randomUUID(), otherId = 'dedup-other-' + randomUUID();
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user')", [accountId, otherId]);
  async function run(account = accountId) {
    const task = await createCollectorTask({ accountId: account, name: '去重验收', taskType: 'CATEGORY' });
    const { run: queued } = await queueCollectorTaskRun({ accountId: account, taskId: task.id });
    const result = await claimCollectorRun({ accountId: account, runId: queued.id, device: { deviceKey: 'fixture-device' } });
    return { accountId: account, runId: queued.id, deviceId: result.device.id, leaseToken: result.leaseToken };
  }
  try { await fn({ accountId, otherId, run }); }
  finally {
    await pool.query('UPDATE collector_tasks SET current_run_id=NULL WHERE account_id=ANY($1::text[])', [[accountId, otherId]]);
    await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])', [[accountId, otherId]]);
  }
}

const claim = (run, skus) => claimCollectorRunSkus({ ...run, skus });
const save = (run, sku) => upsertCollectorRunItem({ ...run, item: { source: 'ozon', sourceKey: sku,
  sourceSku: sku, status: 'QUALIFIED', rawPayload: { sku, nameLabel: '已保存商品' } } });

test('concurrent desktop tasks get one SKU owner, retries reuse it, and saved successes survive a failed batch', options, async () => fixture(async ({ run }) => {
  const a = await run(), b = await run();
  const result = await Promise.all([claim(a, ['101', '102']), claim(b, ['101', '102'])]);
  const owner = result[0].items[0].state === 'CLAIMED' ? a : b;
  const other = owner === a ? b : a;
  assert.deepEqual(result.map(r => r.items.map(i => i.state)).sort(), [['CLAIMED', 'CLAIMED'], ['COLLECTING', 'COLLECTING']]);
  assert.equal((await claim(owner, ['101'])).items[0].state, 'CLAIMED', 'retry after a lost claim response');
  assert.equal((await save(other, '101')).existing.state, 'COLLECTING', 'late or older desktop writes cannot steal a live reservation');
  const saved = await save(owner, '101');
  assert.equal(saved.created, true);
  assert.equal((await save(owner, '101')).created, false, 'response-loss retry stays one saved row');
  await heartbeatCollectorRun({ ...owner, progress: { totalCount: 7, dedup: { collected: 2, listed: 1, collecting: 3 } } });
  await failCollectorRun({ ...owner, errorCode: 'FIXTURE_NETWORK_FAILURE' });
  const following = await claim(other, ['101', '102', '103']);
  assert.deepEqual(following.items.map(i => i.state), ['COLLECTED', 'CLAIMED', 'CLAIMED']);
  assert.equal(following.items[0].collectorItemId, saved.item.id);
  assert.equal((await save(other, '101')).duplicate, true);
  assert.equal((await save(other, '103')).created, true, 'a different SKU is a different variant');
  const persisted = await getCollectorRunForAccount(owner.accountId, owner.runId);
  assert.equal(persisted.progress.qualifiedCount, 1);
  assert.deepEqual(persisted.resultSummary.dedup, { collected: 2, listed: 1, collecting: 3 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM collector_task_items WHERE account_id=$1 AND source_sku=$2', [owner.accountId, '101'])).rows[0].n, 1);
}));

test('filtered items, cancellation and expired leases release reservations; stale writers cannot save', options, async () => fixture(async ({ run }) => {
  const a = await run(), b = await run();
  await claim(a, ['201', '202']);
  assert.equal((await releaseCollectorRunSkus({ ...a, skus: ['201'] })).releasedCount, 1);
  assert.equal((await claim(b, ['201'])).items[0].state, 'CLAIMED');
  await pool.query("UPDATE collector_task_runs SET lock_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [a.runId]);
  assert.equal((await claim(b, ['202'])).items[0].state, 'CLAIMED');
  await assert.rejects(save(a, '202'), { code: 'COLLECTOR_RUN_LEASE_EXPIRED' });
  await cancelCollectorRun(b);
  const c = await run();
  assert.deepEqual((await claim(c, ['201', '202'])).items.map(i => i.state), ['CLAIMED', 'CLAIMED']);
}));

test('account scope and leases apply to batch claims, release and duplicate detail history', options, async () => fixture(async ({ run, otherId }) => {
  const a = await run(), other = await run(otherId);
  await claim(a, ['301']);
  await save(a, '301');
  assert.equal((await claim(other, ['301'])).items[0].state, 'CLAIMED');
  await assert.rejects(claim({ ...a, accountId: otherId }, ['301']), { code: 'COLLECTOR_RUN_NOT_FOUND' });
  await assert.rejects(claim({ ...a, leaseToken: 'wrong' }, ['302']), { code: 'COLLECTOR_RUN_LEASE_MISMATCH' });
  await assert.rejects(releaseCollectorRunSkus({ ...a, accountId: otherId, skus: ['301'] }), { code: 'COLLECTOR_RUN_NOT_FOUND' });
  await assert.rejects(claim(a, ['not-a-sku']), { code: 'COLLECTOR_SKUS_INVALID' });
  await appendCollectorRunEvent({ ...a, eventType: 'SKU_DUPLICATES', payload: { items: [{ sku: '301', state: 'COLLECTED' }] } });
  await appendCollectorRunEvent({ ...a, eventType: 'DESKTOP_LOG', message: 'other log' });
  assert.equal((await listCollectorRunEvents({ ...a, eventType: 'SKU_DUPLICATES' })).length, 1);
  assert.deepEqual(await listCollectorRunEvents({ ...a, accountId: otherId, eventType: 'SKU_DUPLICATES' }), []);
}));

import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { findCollectorSkuHistory } from '../collector-sku-history.mjs';
import { purgeCollectedItems } from '../collection-purge.mjs';

const enabled = process.env.SONLI_POSTGRES_TESTS === '1';
const id = prefix => `${prefix}-${randomUUID()}`;

test('collector SKU history and explicit deletion use the dedicated PostgreSQL database', { skip: !enabled }, async t => {
  const url = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
  assert.ok(url, 'SONLI_MIGRATION_TEST_DATABASE_URL must explicitly select a dedicated test database');
  assert.equal(process.env.DATABASE_URL, url);
  assert.ok(!['sonli_local', 'postgres', 'template0', 'template1'].includes(decodeURIComponent(new URL(url).pathname.slice(1))),
    'never write fixtures to the normal application database');
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    // An unapplied 126 is exercised only inside this rolled-back dedicated transaction.
    const installed = (await client.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='collector_task_items' AND column_name='dedup_saved_at') AS installed`)).rows[0].installed;
    if (!installed) await client.query(await readFile(new URL('../db/migrations/126_collector_sku_dedup.sql', import.meta.url), 'utf8'));
    const sourceInstalled = (await client.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='submission_items' AND column_name='source') AS installed`)).rows[0].installed;
    if (!sourceInstalled) await client.query(await readFile(new URL('../db/migrations/128_listing_source_identity.sql', import.meta.url), 'utf8'));

    async function fixture(run) {
      await client.query('SAVEPOINT sku_fixture');
      const accountId = id('sku-history-account'), otherAccountId = id('sku-history-other');
      const taskId = id('sku-history-task'), runId = id('sku-history-run');
      const taskName = '已保存结果的失败采集任务';
      try {
        await client.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user')", [accountId, otherAccountId]);
        await client.query("INSERT INTO collector_tasks(id,account_id,name,task_type,status) VALUES($1,$2,$3,'MARKET','FAILED')", [taskId, accountId, taskName]);
        await client.query("INSERT INTO collector_task_runs(id,task_id,account_id,run_no,status) VALUES($1,$2,$3,1,'FAILED')", [runId, taskId, accountId]);

        async function collect(sku, { account = accountId, source = 'ozon', variants = [], deleted = false } = {}) {
          const collectItemId = id('sku-history-collect'), draftId = id('sku-history-draft');
          await client.query(`INSERT INTO collect_items(id,account_id,source,source_sku,status,deleted_at)
            VALUES($1,$2,$3,$4,'COLLECTED',CASE WHEN $5 THEN NOW() END)`, [collectItemId, account, source, sku, deleted]);
          await client.query(`INSERT INTO product_drafts(id,collect_item_id,data_hash,data) VALUES($1,$2,$1,$3::jsonb)`,
            [draftId, collectItemId, JSON.stringify({ variants })]);
          await client.query('UPDATE collect_items SET current_draft_id=$2 WHERE id=$1', [collectItemId, draftId]);
          return collectItemId;
        }
        async function desktop(sku, { account = accountId, source = 'ozon', status = 'QUALIFIED', saved = true,
          released = false, collectItemId = null } = {}) {
          const collectorItemId = id('sku-history-item');
          await client.query(`INSERT INTO collector_task_items(id,task_id,run_id,account_id,source,source_key,source_sku,status,
            collect_item_id,dedup_saved_at,dedup_released_at,raw_payload,export_data)
            VALUES($1,$2,$3,$4,$5,$1,$6,$7,$8,CASE WHEN $9 THEN NOW() END,CASE WHEN $10 THEN NOW() END,$11::jsonb,$11::jsonb)`,
          [collectorItemId, taskId, runId, account, source, sku, status, collectItemId, saved, released,
            JSON.stringify({ sku, id: sku, name: '真实保存资料', href: `https://www.ozon.ru/product/${sku}/`, price: 151.76, currencyCode: 'CNY' })]);
          return collectorItemId;
        }
        async function ai(skus, { account = accountId, source = 'ozon', status = 'SUBMISSION_FAILED', results,
          collectItemId = id('deleted-collect'), sourceType = 'COLLECT_BOX' } = {}) {
          const taskId = id('sku-history-ai');
          const body = { sourceType, sourceId: collectItemId, name: 'AI 上架历史',
            source: { collectItemId, items: skus.map(sku => ({ sku })), sourceSnapshot: { id: collectItemId, source } },
            ...(results === undefined ? {} : { submissionResults: results }) };
          await client.query(`INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at)
            VALUES($1,$2,$1,$3,$4::jsonb,0,0)`, [taskId, account, status, JSON.stringify(body)]);
          return taskId;
        }
        async function direct(items, { account = accountId, source = 'ozon', detached = false, frozenSource = '' } = {}) {
          const storeId = id('sku-history-store'), snapshotId = id('sku-history-snapshot'), jobId = id('sku-history-job');
          const collectItemId = detached ? null : await collect(items[0].sku || 'unknown', { account, source,
            variants: items.map(({ sku }) => ({ sku })) });
          await client.query(`INSERT INTO stores(id,label,company_name,client_id,status,owner_account_id)
            VALUES($1,$1,$1,$1,'active',$2)`, [storeId, account]);
          await client.query(`INSERT INTO submission_snapshots(id,collect_item_id,account_id,store_id,idempotency_key,snapshot_hash,item_count,items)
            VALUES($1,$2,$3,$4,$1,$1,$5,$6::jsonb)`,
          [snapshotId, collectItemId, account, storeId, items.length, JSON.stringify(items.map(item => ({ offer_id: item.offerId || `target-${item.sku}` })))]);
          await client.query(`INSERT INTO submission_jobs(id,snapshot_id,collect_item_id,account_id,store_id,type,status,item_count,correlation_id)
            VALUES($1,$2,$3,$4,$5,'COLLECT_BOX_DRAFT','PARTIAL_SUCCESS',$6,$1)`, [jobId, snapshotId, collectItemId, account, storeId, items.length]);
          for (const [index, item] of items.entries()) await client.query(`INSERT INTO submission_items(id,job_id,snapshot_id,variant_key,sort_order,sku,offer_id,status,source)
            VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8)`, [id('sku-history-submission-item'), jobId, snapshotId, index,
            item.sku, item.offerId || `target-${item.sku}`, item.status, frozenSource]);
          return { jobId, collectItemId };
        }
        await run({ accountId, otherAccountId, taskId, runId, taskName, collect, desktop, ai, direct });
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT sku_fixture');
        await client.query('RELEASE SAVEPOINT sku_fixture');
      }
    }

    await t.test('one batch finds exact Ozon root/variant SKUs within the account; empty input performs no query', async () => {
      await fixture(async ({ accountId, otherAccountId, collect }) => {
        const root = await collect('10001', { variants: [{ sku: '10002' }, { sku: 10003 }] });
        await collect('10004', { source: '1688' });
        await collect('10005', { account: otherAccountId });
        await collect('10006', { deleted: true });
        await collect('10007', { variants: { old: 'not an array' } });
        let queries = 0;
        const counted = { query: (...args) => { queries++; return client.query(...args); } };
        assert.deepEqual(await findCollectorSkuHistory(counted, accountId, []), new Map());
        assert.equal(queries, 0);
        const history = await findCollectorSkuHistory(counted, accountId, ['10001', '10002', 10003, '10004', '10005', '10006', '10007', '1000', '100010', '10001']);
        assert.equal(queries, 1, 'the requested page uses a single batch query');
        assert.deepEqual([...history.keys()].sort(), ['10001', '10002', '10003', '10007']);
        for (const sku of ['10001', '10002', '10003']) assert.deepEqual(history.get(sku), { sku, state: 'COLLECTED', collectItemId: root });
      });
    });

    await t.test('QUALIFIED persisted results survive a failed run, with original task name; other statuses never block', async () => {
      await fixture(async ({ accountId, otherAccountId, taskId, runId, taskName, desktop }) => {
        const item = await desktop('20001');
        for (const [sku, status] of [['20002', 'DISCOVERED'], ['20003', 'FILTERED_OUT'], ['20004', 'FAILED'], ['20005', 'ENRICHED']]) {
          await desktop(sku, { status });
        }
        await desktop('20006', { source: '1688' });
        await desktop('20007', { account: otherAccountId });
        const history = await findCollectorSkuHistory(client, accountId, ['20001', '20002', '20003', '20004', '20005', '20006', '20007']);
        assert.deepEqual([...history.values()], [{ sku: '20001', state: 'COLLECTED', collectorItemId: item, taskId, runId, taskName }]);
      });
    });

    await t.test('legacy NULL is not proof of retained collection; saved timestamps or live links are proof, explicit release wins', async () => {
      await fixture(async ({ accountId, collect, desktop, taskId, taskName }) => {
        await desktop('30001', { saved: false }); // A full raw payload still cannot distinguish an old deletion.
        const linked = await collect('30002');
        await desktop('30002', { saved: false, collectItemId: linked });
        await desktop('30003', { released: true });
        const deleted = await collect('30004', { deleted: true });
        await desktop('30004', { saved: false, collectItemId: deleted });
        await desktop('30005');
        const history = await findCollectorSkuHistory(client, accountId, ['30001', '30002', '30003', '30004', '30005']);
        assert.deepEqual([...history.keys()].sort(), ['30002', '30005']);
        assert.equal(history.get('30002').collectItemId, linked);
        assert.equal(history.get('30002').taskId, taskId);
        assert.equal(history.get('30002').taskName, taskName);
      });
    });

    await t.test('AI partial success is per SKU, takes priority, and survives deleted collection without crossing source/account', async () => {
      await fixture(async ({ accountId, otherAccountId, collect, desktop, ai }) => {
        const collectItemId = await collect('40001', { variants: [{ sku: '40001' }, { sku: '40002' }] });
        await desktop('40001', { released: true });
        const taskId = await ai(['40001', '40002'], { collectItemId, results: [
          { sku: '40001', importStatus: 'SUCCEEDED' }, { sku: '40002', importStatus: 'FAILED' },
        ] });
        await ai(['40003'], { source: '1688', status: 'COMPLETED' });
        await ai(['40004'], { account: otherAccountId, status: 'COMPLETED' });
        await ai(['40005'], { sourceType: 'EXCEL', status: 'COMPLETED' });
        await ai(['40006'], { status: 'GENERATION_FAILED' });
        const before = await findCollectorSkuHistory(client, accountId, ['40001', '40002']);
        assert.equal(before.get('40001').state, 'LISTED');
        assert.equal(before.get('40002').state, 'COLLECTED', 'failed downstream work reuses existing collection');
        await purgeCollectedItems(client, accountId, [collectItemId]);
        const history = await findCollectorSkuHistory(client, accountId, ['40001', '40002', '40003', '40004', '40005', '40006']);
        assert.deepEqual([...history.keys()].sort(), ['40001', '40005']);
        assert.equal(history.get('40001').state, 'LISTED');
        assert.equal(history.get('40001').listingTaskId, taskId);
        assert.equal(history.get('40001').taskId, undefined, 'an AI task ID must never open a desktop task');
      });
    });

    await t.test('the existing Ozon Excel source marker remains Ozon; explicit failed sibling results are not success', async () => {
      await fixture(async ({ accountId, collect, desktop, ai }) => {
        const collectItemId = await collect('41001', { source: 'AUTO_LISTING_EXCEL_SKU' });
        await desktop('41001', { collectItemId, saved: false });
        await ai(['41002'], { source: 'AUTO_LISTING_EXCEL_SKU', status: 'COMPLETED' });
        await ai(['41003', '41004'], { status: 'COMPLETED', results: [
          { sku: '41003', importStatus: 'SUCCEEDED' }, { sku: '41004', importStatus: 'FAILED' },
        ] });
        const history = await findCollectorSkuHistory(client, accountId, ['41001', '41002', '41003', '41004']);
        assert.deepEqual([...history.keys()].sort(), ['41001', '41002', '41003']);
        assert.equal(history.get('41001').state, 'COLLECTED');
        assert.equal(history.get('41002').state, 'LISTED');
        await purgeCollectedItems(client, accountId, [collectItemId]);
        assert.equal((await client.query('SELECT dedup_released_at IS NOT NULL AS released FROM collector_task_items WHERE collect_item_id IS NULL AND source_sku=$1 AND account_id=$2', ['41001', accountId])).rows[0].released, true);
      });
    });

    await t.test('direct listing uses successful source SKU independently of target offer and whole-job status', async () => {
      await fixture(async ({ accountId, otherAccountId, direct }) => {
        const { jobId } = await direct([{ sku: '42001', status: 'SUCCEEDED' }, { sku: '42002', status: 'FAILED' }]);
        await direct([{ sku: '42003', status: 'SUCCEEDED' }], { source: '1688' });
        await direct([{ sku: '42004', status: 'SUCCEEDED' }], { account: otherAccountId });
        await direct([{ sku: '42005', status: 'SUCCEEDED' }], { detached: true });
        await direct([{ sku: '', status: 'SUCCEEDED', offerId: '42006' }], { detached: true });
        const history = await findCollectorSkuHistory(client, accountId, ['42001', '42002', '42003', '42004', '42005', '42006', 'target-42001']);
        assert.deepEqual([...history.keys()].sort(), ['42001', '42002']);
        assert.equal(history.get('42001').state, 'LISTED');
        assert.equal(history.get('42001').submissionJobId, jobId);
        assert.equal(history.get('42001').taskId, undefined, 'a submission job ID must never open a desktop task');
        assert.equal(history.get('42002').state, 'COLLECTED');
      });
    });

    await t.test('LISTED keeps an available desktop origin without confusing listing IDs with desktop task IDs', async () => {
      await fixture(async ({ accountId, taskId, taskName, runId, collect, desktop, ai, direct }) => {
        const collectItemId = await collect('43001');
        const first = await desktop('43001', { collectItemId });
        const listingTaskId = await ai(['43001'], { collectItemId, status: 'COMPLETED' });
        const submission = await direct([{ sku: '43002', status: 'SUCCEEDED' }]);
        const second = await desktop('43002', { collectItemId: submission.collectItemId });
        const history = await findCollectorSkuHistory(client, accountId, ['43001', '43002']);
        for (const sku of ['43001', '43002']) {
          const entry = history.get(sku);
          assert.equal(entry.state, 'LISTED');
          assert.equal(entry.taskId, taskId);
          assert.equal(entry.taskName, taskName);
          assert.equal(entry.runId, runId);
        }
        assert.equal(history.get('43001').listingTaskId, listingTaskId);
        assert.equal(history.get('43001').collectorItemId, first);
        assert.equal(history.get('43002').submissionJobId, submission.jobId);
        assert.equal(history.get('43002').collectorItemId, second);
      });
    });

    await t.test('direct frozen Ozon identity survives physical deletion and release, while failed/foreign-source siblings do not block', async () => {
      await fixture(async ({ accountId, otherAccountId, direct, desktop }) => {
        const submission = await direct([{ sku: '44001', status: 'SUCCEEDED' }, { sku: '44002', status: 'FAILED' }], { frozenSource: 'ozon' });
        await desktop('44001', { collectItemId: submission.collectItemId });
        await desktop('44002');
        const otherSource = await direct([{ sku: '44003', status: 'SUCCEEDED' }], { source: '1688', frozenSource: '1688' });
        await direct([{ sku: '44004', status: 'SUCCEEDED' }], { account: otherAccountId, frozenSource: 'ozon' });
        await purgeCollectedItems(client, accountId, [submission.collectItemId, otherSource.collectItemId]);
        const history = await findCollectorSkuHistory(client, accountId, ['44001', '44002', '44003', '44004']);
        assert.deepEqual([...history.values()], [{ sku: '44001', state: 'LISTED', submissionJobId: submission.jobId }]);
        const row = (await client.query('SELECT j.collect_item_id,s.collect_item_id AS snapshot_collect_id FROM submission_jobs j JOIN submission_snapshots s ON s.id=j.snapshot_id WHERE j.id=$1', [submission.jobId])).rows[0];
        assert.deepEqual(row, { collect_item_id: null, snapshot_collect_id: null });
      });
    });

    await t.test('explicit deletion releases all same-SKU desktop success evidence before SET NULL while retaining raw/export data', async () => {
      await fixture(async ({ accountId, otherAccountId, collect, desktop }) => {
        const collectItemId = await collect('50001', { variants: [{ sku: '50002' }] });
        const linked = await desktop('50001', { collectItemId });
        const unlinked = await desktop('50002');
        const legacy = await desktop('50001', { saved: false });
        const other = await desktop('50001', { account: otherAccountId });
        const otherSource = await desktop('50001', { source: '1688' });
        const ids = [linked, unlinked, legacy, other, otherSource];
        const saved = (await client.query('SELECT id,raw_payload,export_data,status FROM collector_task_items WHERE id=ANY($1::text[]) ORDER BY id', [ids])).rows;
        assert.equal(await purgeCollectedItems(client, accountId, [collectItemId]), 1);
        const rows = (await client.query('SELECT id,collect_item_id,dedup_released_at FROM collector_task_items WHERE id=ANY($1::text[])', [ids])).rows;
        for (const row of rows) {
          assert.equal(row.dedup_released_at !== null, [linked, unlinked, legacy].includes(row.id));
          if (row.id === linked) assert.equal(row.collect_item_id, null);
        }
        assert.deepEqual((await client.query('SELECT id,raw_payload,export_data,status FROM collector_task_items WHERE id=ANY($1::text[]) ORDER BY id', [ids])).rows, saved);
        assert.deepEqual(await findCollectorSkuHistory(client, accountId, ['50001', '50002']), new Map());
        assert.equal(await purgeCollectedItems(client, accountId, [collectItemId]), 0);
        await desktop('50001');
        assert.equal((await findCollectorSkuHistory(client, accountId, ['50001'])).get('50001').state, 'COLLECTED', 'a new successful collection becomes history again');
      });
    });

    await t.test('retained Ozon variants keep evidence; deleting another platform does not release Ozon history', async () => {
      await fixture(async ({ accountId, collect, desktop }) => {
        const removed = await collect('60001', { variants: [{ sku: '60002' }] });
        const retained = await collect('60003', { variants: [{ sku: '60002' }] });
        const item = await desktop('60002', { collectItemId: removed });
        const otherPlatform = await collect('60004', { source: '1688' });
        const ozon = await desktop('60004');
        await purgeCollectedItems(client, accountId, [removed, otherPlatform]);
        const history = await findCollectorSkuHistory(client, accountId, ['60001', '60002', '60004']);
        assert.equal(history.has('60001'), false);
        assert.equal(history.get('60002').state, 'COLLECTED');
        assert.equal(history.get('60004').collectorItemId, ozon);
        assert.equal((await client.query('SELECT dedup_released_at FROM collector_task_items WHERE id=$1', [item])).rows[0].dedup_released_at, null);
        assert.ok((await client.query('SELECT 1 FROM collect_items WHERE id=$1', [retained])).rowCount);
      });
    });

    await t.test('delete release is atomic with its caller transaction and cannot act on another account', async () => {
      await fixture(async ({ accountId, otherAccountId, collect, desktop }) => {
        const collectItemId = await collect('70001');
        const item = await desktop('70001', { collectItemId });
        assert.equal(await purgeCollectedItems(client, otherAccountId, [collectItemId]), 0);
        await client.query('SAVEPOINT deletion');
        await purgeCollectedItems(client, accountId, [collectItemId]);
        assert.deepEqual(await findCollectorSkuHistory(client, accountId, ['70001']), new Map());
        await client.query('ROLLBACK TO SAVEPOINT deletion');
        const row = (await client.query('SELECT collect_item_id,dedup_released_at FROM collector_task_items WHERE id=$1', [item])).rows[0];
        assert.equal(row.collect_item_id, collectItemId);
        assert.equal(row.dedup_released_at, null);
        assert.equal((await findCollectorSkuHistory(client, accountId, ['70001'])).get('70001').state, 'COLLECTED');
      });
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});

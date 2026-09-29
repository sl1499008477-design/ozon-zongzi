import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as repair from '../../scripts/repair-collect-media.mjs';
import { publicPersistedCollectionItem } from '../collection-public-shape.mjs';
import { withoutListedSkus } from '../collection-sku-rules.mjs';

const media = sku => ({ sku, description: `Описание ${sku}`, videos: [
  { url: `https://example.test/${sku}.mp4`, coverUrl: `https://example.test/${sku}.jpg` },
], videoUrl: `https://example.test/${sku}.mp4` });
const source = { id: 'historical-collect', sku: '100', variantData: { variants: [media('100'), media('200')] } };
const product = sku => ({ sku, description: '', videos: [], videoUrl: '', price: '123.45',
  images: [`https://example.test/${sku}-gallery.jpg`], logistics: { weightG: 500 },
  sourceCategory: { attributes: [{ key: '85', values: [{ value: 'Лисон', dictionary_value_id: 72 }] }] },
  richContent: JSON.stringify({ content: [], text: "$media_repair_rollback$ ' \\ keep" }), enabled: false });
const input = () => ({ draft: { ...product('100'), variants: [product('100'), product('200')] },
  normalized: { ...product('100'), variantData: { variants: [product('100'), product('200')] } }, source });
const stripMedia = value => Array.isArray(value) ? value.map(stripMedia) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['description', 'videos', 'videoUrl'].includes(key))
    .map(([key, nested]) => [key, stripMedia(nested)])) : value;

test('missing-only fills each exact SKU and leaves prices, gallery, logistics, Russian attributes and roster intact', () => {
  const before = input(), saved = structuredClone(before);
  const plan = repair.planMediaRepair(before);
  assert.equal(plan.draft.description, 'Описание 100');
  assert.equal(plan.draft.variants[1].description, 'Описание 200');
  assert.deepEqual(plan.normalized.variantData.variants[1].videos, media('200').videos);
  assert.deepEqual(stripMedia(plan.draft), stripMedia(before.draft));
  assert.deepEqual(stripMedia(plan.normalized), stripMedia(before.normalized));
  assert.deepEqual(before, saved, 'input evidence is never mutated');
  assert.deepEqual(plan.summary.missingSourceSkus, []);
});

test('a missing sibling never borrows root or a neighboring SKU media', () => {
  const plan = repair.planMediaRepair({ ...input(), source: { ...media('100'), variantData: { variants: [media('100')] } } });
  assert.deepEqual(plan.draft.variants[1], product('200'));
  assert.deepEqual(plan.normalized.variantData.variants[1], product('200'));
  assert.deepEqual(plan.summary.missingSourceSkus, ['200']);
});

test('existing fields are retained independently in both draft and normalized views', () => {
  const before = input();
  before.draft.variants[0].description = 'Ручное описание';
  before.draft.variants[0].videos = [{ url: 'https://manual.test/keep.mp4' }];
  before.normalized.variantData.variants[0].videoUrl = 'https://original.test/keep.mp4';
  const plan = repair.planMediaRepair(before);
  assert.equal(plan.draft.variants[0].description, 'Ручное описание');
  assert.deepEqual(plan.draft.variants[0].videos, before.draft.variants[0].videos);
  assert.equal(plan.draft.variants[0].videoUrl, media('100').videoUrl);
  assert.equal(plan.normalized.variantData.variants[0].videoUrl, 'https://original.test/keep.mp4');
  assert.equal(repair.planMediaRepair({ ...plan, source }).changes.length, 0, 'repeat is a no-op');
});

test('ambiguous duplicate SKU and conflicting explicit identities are rejected', () => {
  assert.throws(() => repair.planMediaRepair({ ...input(), source: { variantData: { variants: [media('100'), media('100')] } } }), /SKU/);
  assert.throws(() => repair.planMediaRepair({ ...input(), source: { ...media('100'), sourceSku: '200' } }), /SKU/);
  const before = input();
  before.draft.variants.push(product('100'));
  assert.throws(() => repair.planMediaRepair(before), /SKU/);
});

test('raw-only public fields require the appended normalized view; listed SKU filtering still removes only the listed sibling', () => {
  const before = input(), plan = repair.planMediaRepair(before);
  const draftOnly = publicPersistedCollectionItem({ ...before.normalized, listingDraft: plan.draft });
  assert.equal(draftOnly.description, '');
  assert.deepEqual(draftOnly.variantData.variants[0].videos, []);
  const visible = publicPersistedCollectionItem({ ...plan.normalized, listingDraft: plan.draft });
  assert.equal(visible.description, 'Описание 100');
  assert.equal(visible.variantData.variants[1].videos.length, 1);
  const filtered = withoutListedSkus([visible], [{ status: 'COMPLETED', source: { items: [{ sku: '100' }] } }])[0];
  assert.deepEqual(filtered.listingDraft.variants.map(v => v.sku), ['200']);
  assert.deepEqual(filtered.variantData.variants.map(v => v.sku), ['200']);
});

test('offline CLI is dry-run by default, prints counts only, and refuses apply from a filtered public snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-repair-cli-'));
  try {
    const currentFile = join(dir, 'current.json'), sourceFile = join(dir, 'source.json');
    await writeFile(currentFile, JSON.stringify({ id: 'collect-test', ...input().normalized, listingDraft: input().draft }));
    await writeFile(sourceFile, JSON.stringify(source));
    const args = ['scripts/repair-collect-media.mjs', '--account-id', 'account-test', '--collect-id', 'collect-test',
      '--source', sourceFile, '--current', currentFile];
    const run = extra => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgresql://secret-key@never-connect.invalid/db' } });
    const preview = run([]);
    assert.equal(preview.status, 0, preview.stderr);
    const report = JSON.parse(preview.stdout);
    assert.equal(report.applied, false);
    assert.equal(report.mode, 'offline-dry-run');
    assert.equal(report.summary.targetSkus.length, 2);
    assert.doesNotMatch(preview.stdout + preview.stderr, /secret-key|Описание|\.mp4|DATABASE_URL/);
    assert.notEqual(run(['--apply']).status, 0);
    assert.notEqual(run(['--unknown']).status, 0);
    const cross = spawnSync(process.execPath, args.map(v => v === 'collect-test' ? 'wrong-collect' : v), { encoding: 'utf8' });
    assert.notEqual(cross.status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real PostgreSQL repair is scoped, atomic, guarded, backed up, visible and reversible',
  { skip: process.env.SONLI_POSTGRES_TESTS !== '1' }, async t => {
    const { getPostgresPool, closePostgresPool } = await import('../db/connection.mjs');
    const { runMigrations } = await import('../db/migrate.mjs');
    const { listCollectItemsV3 } = await import('../listing-pipeline.mjs');
    const pool = await getPostgresPool();
    const dir = await mkdtemp(join(tmpdir(), 'media-repair-pg-'));
    const id = `repair-${randomUUID()}`, accountId = `${id}-account`, collectId = `${id}-collect`, draftId = `${id}-draft`;
    const args = { pool, accountId, collectId, source, sourceName: 'source.json', sourceSha256: 'a'.repeat(64) };
    try {
      await runMigrations(pool);
      await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user')", [accountId]);
      await pool.query("INSERT INTO collect_items(id,account_id,source_sku,source,status,summary) VALUES($1,$2,'100','ozon','COMPLETE',$3)",
        [collectId, accountId, { enrichment: { status: 'COMPLETE' } }]);
      await pool.query(`INSERT INTO collect_raw_payloads(id,collect_item_id,account_id,source_sku,payload_hash,payload)
        VALUES($1,$2,$3,'100','old-hash',$4)`, [`${id}-raw`, collectId, accountId,
        { source: { originalEvidence: 'must survive byte-for-byte' }, normalized: input().normalized }]);
      await pool.query(`INSERT INTO product_drafts(id,collect_item_id,source_payload_id,version,data_hash,data)
        VALUES($1,$2,$3,7,'old-draft-hash',$4)`, [draftId, collectId, `${id}-raw`, input().draft]);
      await pool.query('UPDATE collect_items SET current_draft_id=$2 WHERE id=$1', [collectId, draftId]);
      for (const [index, data] of input().draft.variants.entries()) {
        await pool.query(`INSERT INTO product_draft_variants(id,draft_id,source_payload_id,variant_key,sort_order,sku,data_hash,data)
          VALUES($1,$2,$3,$4,$5,$4,'old-variant-hash',$6)`, [`${id}-v-${index}`, draftId, `${id}-raw`, data.sku, index, data]);
      }
      const frozen = { status: 'COMPLETED', source: { items: [{ sku: '100', frozenMedia: [] }] } };
      await pool.query(`INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at)
        VALUES($1,$2,$1,'COMPLETED',$3,0,0)`, [`${id}-ai`, accountId, frozen]);
      const snapshot = async () => { const client = await pool.connect(); try {
        return await repair.readRepairSnapshot(client, { accountId, collectId });
      } finally { client.release(); } };
      const before = await snapshot();
      const preview = await repair.runMediaRepair(args);
      await t.test('dry-run has no SQL writes or revisions', async () => {
        assert.equal(preview.applied, false);
        assert.equal(preview.guard.draftVersion, 7);
        assert.deepEqual(await snapshot(), before);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_draft_revisions WHERE draft_id=$1', [draftId])).rows[0].n, 0);
      });
      await t.test('another account cannot select the collect item', async () => {
        await assert.rejects(repair.runMediaRepair({ ...args, accountId: 'another-account' }), /SCOPE/);
      });
      await t.test('apply requires the reviewed version/time token and an exclusive backup path', async () => {
        await assert.rejects(repair.runMediaRepair({ ...args, apply: true }), /GUARD|BACKUP/);
        await assert.rejects(repair.runMediaRepair({ ...args, apply: true, expectedToken: preview.guard.token,
          backupPath: join(dir, 'missing-parent', 'backup.json') }), /ENOENT|BACKUP/);
        assert.deepEqual(await snapshot(), before);
      });
      await t.test('updated-at changes invalidate a preview even when draft version is unchanged', async () => {
        await pool.query("UPDATE collect_items SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1", [collectId]);
        await assert.rejects(repair.runMediaRepair({ ...args, apply: true, expectedToken: preview.guard.token,
          backupPath: join(dir, 'stale.json') }), /CONFLICT/);
        await pool.query('UPDATE collect_items SET updated_at=$2 WHERE id=$1', [collectId, before.item.updated_at]);
      });
      await t.test('failed revision insert rolls back raw, draft and variant changes', async () => {
        await pool.query(`INSERT INTO product_draft_revisions(id,draft_id,version,data_hash,data)
          VALUES($1,$2,8,'collision','{}')`, [`${id}-collision`, draftId]);
        await assert.rejects(repair.runMediaRepair({ ...args, apply: true, expectedToken: preview.guard.token,
          backupPath: join(dir, 'failed-backup.json') }));
        assert.deepEqual(await snapshot(), before);
        await pool.query('DELETE FROM product_draft_revisions WHERE id=$1', [`${id}-collision`]);
      });
      const backupPath = join(dir, 'backup.json');
      const applied = await repair.runMediaRepair({ ...args, apply: true, expectedToken: preview.guard.token, backupPath });
      await t.test('current public views and variant table see media while old raw and frozen task remain unchanged', async () => {
        assert.equal(applied.applied, true);
        const after = await snapshot();
        assert.equal(after.draft.version, 8);
        assert.equal(after.draft.data.variants[1].description, 'Описание 200');
        assert.equal(after.variants[1].data.videos.length, 1);
        assert.deepEqual(stripMedia(after.draft.data), stripMedia(before.draft.data));
        assert.deepEqual(stripMedia(after.raw.payload.normalized), stripMedia(before.raw.payload.normalized));
        assert.deepEqual(after.raw.payload.source, before.raw.payload.source);
        assert.equal(after.raw.payload.mediaRepair.sourceSha256, 'a'.repeat(64));
        const oldRaw = (await pool.query('SELECT to_jsonb(r) AS row FROM collect_raw_payloads r WHERE id=$1', [`${id}-raw`])).rows[0].row;
        assert.deepEqual(oldRaw, before.raw);
        const visible = (await listCollectItemsV3({ accountId, ids: [collectId] }))[0];
        assert.equal(visible.description, 'Описание 100');
        assert.equal(visible.listingDraft.variants[1].videoUrl, media('200').videoUrl);
        assert.equal(visible.variantData.variants[1].videos.length, 1);
        assert.deepEqual(withoutListedSkus([visible], [frozen])[0].listingDraft.variants.map(v => v.sku), ['200']);
        assert.deepEqual((await pool.query('SELECT body FROM ai_image_listing_tasks WHERE id=$1', [`${id}-ai`])).rows[0].body, frozen);
        assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
      });
      await t.test('replay is a no-op with no extra raw, revision or draft version', async () => {
        const beforeReplay = await snapshot(), nextPreview = await repair.runMediaRepair(args);
        const replay = await repair.runMediaRepair({ ...args, apply: true, expectedToken: nextPreview.guard.token,
          backupPath: join(dir, 'noop.json') });
        assert.equal(replay.applied, false);
        assert.deepEqual(await snapshot(), beforeReplay);
      });
      await t.test('backup rollback rejects later edits and restores exact pre-repair rows when guard still matches', async () => {
        const backup = JSON.parse(await readFile(backupPath, 'utf8'));
        await pool.query("UPDATE collect_items SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1", [collectId]);
        const client = await pool.connect();
        try { await assert.rejects(client.query(backup.rollbackSql), /CONFLICT/); await client.query('ROLLBACK'); }
        finally { client.release(); }
        await pool.query('UPDATE collect_items SET updated_at=$2 WHERE id=$1', [collectId, backup.after.updatedAt]);
        await pool.query(backup.rollbackSql);
        assert.deepEqual(await snapshot(), before);
      });
    } finally {
      await pool.query('DELETE FROM ai_image_listing_tasks WHERE account_id=$1', [accountId]);
      await pool.query('DELETE FROM collect_items WHERE account_id=$1', [accountId]);
      await pool.query('DELETE FROM collect_raw_payloads WHERE account_id=$1', [accountId]);
      await pool.query('DELETE FROM accounts WHERE id=$1', [accountId]);
      await closePostgresPool();
      await rm(dir, { recursive: true, force: true });
    }
  });

#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// One-off repair outside server production modules. Reuses listing-pipeline.mjs's
// item/draft locks + raw/revision/variant transaction pattern. Its general updater
// also normalizes category/logistics and rebuilds variants, so use the same SQL
// pattern here to preserve every non-media business field exactly as stored.
// listCollectItemsV3 reads latest raw.normalized AND product_drafts.data: append
// a derived raw for current views; never rewrite an original capture or AI task.
const FIELDS = ['description', 'videos', 'videoUrl'];
class RepairError extends Error {}
const fail = (code, message) => { throw new RepairError(`MEDIA_REPAIR_${code}: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const blank = value => value == null || (typeof value === 'string' && !value.trim())
  || (Array.isArray(value) && value.length === 0);
const sha256 = text => createHash('sha256').update(text).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => sha256(JSON.stringify(canonical(value)));
const draftHash = value => { const data = { ...value }; delete data.savedAt; return digest(data); };

function skuOf(row, fallback = '') {
  const explicit = [row?.sku, row?.sourceSku].filter(value => value != null && value !== '').map(String);
  if (explicit.some(sku => !/^\d+$/.test(sku)) || new Set(explicit).size > 1) fail('SKU', 'SKU identity is invalid or conflicting');
  const sku = explicit[0] || fallback;
  if (sku && !/^\d+$/.test(sku)) fail('SKU', 'SKU identity is invalid');
  return sku;
}
function uniqueRows(rows) {
  if (!Array.isArray(rows)) fail('SKU', 'variant list must be an array');
  const seen = new Set();
  for (const row of rows) {
    const sku = skuOf(row);
    if (!sku || seen.has(sku)) fail('SKU', 'variant SKU is missing or duplicated');
    seen.add(sku);
  }
  return rows;
}
function sourceIndex(source) {
  if (!object(source)) fail('SOURCE', 'source must be a captured item object');
  // Captured per-SKU rows are authoritative. A parent is never a sibling fallback.
  const rows = source.variantData?.variants ?? source.variants ?? source.listingDraft?.variants ?? [];
  const index = new Map(uniqueRows(rows).map(row => [skuOf(row), row]));
  const rootSku = skuOf(source);
  if (rootSku && !index.has(rootSku)) index.set(rootSku, source);
  if (!index.size) fail('SOURCE', 'source contains no explicit SKU evidence');
  return index;
}
function validateMedia(field, value) {
  const validUrl = text => {
    try { const url = new URL(text); return typeof text === 'string'
      && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  };
  const valid = field === 'description' ? typeof value === 'string'
    : field === 'videoUrl' ? validUrl(value)
    : Array.isArray(value) && value.every(video => typeof video === 'string' ? validUrl(video)
      : object(video) && validUrl(video.url) && (blank(video.coverUrl) || validUrl(video.coverUrl)));
  if (!valid) fail('SOURCE_MEDIA', `invalid source ${field}`);
}

export function planMediaRepair({ draft, normalized, source, variants = [], rootSku = '' }) {
  if (!object(draft) || !object(normalized)) fail('VIEW', 'persisted draft and raw.normalized are required');
  const index = sourceIndex(source), changes = [], targets = new Set();
  const nextDraft = structuredClone(draft), nextNormalized = structuredClone(normalized);
  const nextVariants = structuredClone(variants);
  const fill = (row, path, fallback = '') => {
    if (!object(row)) fail('SKU', 'product row must be an object');
    const sku = skuOf(row, fallback);
    if (!sku) return;
    targets.add(sku);
    const proof = index.get(sku);
    if (!proof) return;
    for (const field of FIELDS) {
      if (!blank(row[field]) || blank(proof[field])) continue;
      validateMedia(field, proof[field]);
      row[field] = structuredClone(proof[field]);
      changes.push({ sku, path: `${path}.${field}`, field });
    }
  };
  const visit = (root, path, fallback) => {
    fill(root, path, fallback);
    for (const key of ['variants', 'skuList', 'sku_list']) {
      if (root[key] !== undefined) uniqueRows(root[key]).forEach((row, i) => fill(row, `${path}.${key}[${i}]`));
    }
    for (const key of ['variantData', 'variant_data']) {
      if (root[key]?.variants !== undefined) uniqueRows(root[key].variants)
        .forEach((row, i) => fill(row, `${path}.${key}.variants[${i}]`));
    }
  };
  visit(nextDraft, 'draft', rootSku);
  visit(nextNormalized, 'normalized', rootSku);
  if (object(nextNormalized.listingDraft)) visit(nextNormalized.listingDraft, 'normalized.listingDraft', rootSku);
  for (const [i, variant] of nextVariants.entries()) {
    if (skuOf(variant) !== skuOf(variant.data)) fail('SKU', 'stored variant identity disagrees with its data');
    fill(variant.data, `variantRows[${i}].data`);
  }
  const targetSkus = [...targets].sort();
  return { draft: nextDraft, normalized: nextNormalized, variants: nextVariants, changes, summary: {
    targetSkus,
    matchedSkuCount: targetSkus.filter(sku => index.has(sku)).length,
    missingSourceSkus: targetSkus.filter(sku => !index.has(sku)),
    unusedSourceSkus: [...index.keys()].filter(sku => !targets.has(sku)).sort(),
    changedSkuCount: new Set(changes.map(change => change.sku)).size,
    filledFields: Object.fromEntries(FIELDS.map(field => [field, changes.filter(change => change.field === field).length])),
    sourceMediaBySku: targetSkus.filter(sku => index.has(sku)).map(sku => ({ sku,
      descriptionChars: typeof index.get(sku).description === 'string' ? index.get(sku).description.length : 0,
      videos: Array.isArray(index.get(sku).videos) ? index.get(sku).videos.length : 0,
      videoUrl: !blank(index.get(sku).videoUrl),
    })),
  } };
}
function scope({ accountId, collectId }) {
  if (![accountId, collectId].every(value => typeof value === 'string' && /^[\w-]{1,240}$/.test(value))) {
    fail('SCOPE', 'explicit account-id and collect-id are required');
  }
}
export async function readRepairSnapshot(client, { accountId, collectId, lock = false }) {
  scope({ accountId, collectId });
  const item = (await client.query(`SELECT to_jsonb(c) AS row FROM collect_items c
    WHERE c.account_id=$1 AND c.id=$2 AND c.deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
  [accountId, collectId])).rows[0]?.row;
  if (!item) fail('SCOPE', 'collect item not found in this account');
  if (item.source !== 'ozon') fail('SCOPE', 'this repair only handles Ozon collection evidence');
  const draft = (await client.query(`SELECT to_jsonb(d) AS row FROM product_drafts d
    JOIN collect_items c ON c.current_draft_id=d.id AND c.id=d.collect_item_id
    WHERE c.account_id=$1 AND c.id=$2 ${lock ? 'FOR UPDATE OF d' : ''}`,
  [accountId, collectId])).rows[0]?.row;
  const raws = (await client.query(`SELECT to_jsonb(r) AS row FROM collect_raw_payloads r
    WHERE r.account_id=$1 AND r.collect_item_id=$2 ORDER BY r.created_at DESC LIMIT 2 ${lock ? 'FOR UPDATE' : ''}`,
  [accountId, collectId])).rows.map(record => record.row);
  if (!draft || !object(raws[0]?.payload?.normalized)) fail('VIEW', 'current persisted draft/raw.normalized not found');
  if (raws[1]?.created_at === raws[0].created_at) fail('CONFLICT', 'latest raw timestamp is ambiguous');
  const variants = (await client.query(`SELECT to_jsonb(v) AS row FROM product_draft_variants v
    JOIN collect_items c ON c.current_draft_id=v.draft_id
    WHERE c.account_id=$1 AND c.id=$2 ORDER BY v.sort_order,v.id ${lock ? 'FOR UPDATE OF v' : ''}`,
  [accountId, collectId])).rows.map(record => record.row);
  return { item, draft, raw: raws[0], variants };
}

// Private evidence, never stdout. Escaped SQL literals are never shell interpolated.
// Rollback refuses to overwrite ANY captured row changed since this repair.
function rollbackSql(before, after, revisionId) {
  const tag = '$media_repair_' + randomUUID().replaceAll('-', '') + '$';
  const literal = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  return `BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL standard_conforming_strings = on;
DO ${tag}
DECLARE b jsonb := ${literal(before)};
        a jsonb := ${literal(after)};
        current_row jsonb;
BEGIN
  PERFORM 1 FROM collect_items WHERE account_id=b->'item'->>'account_id' AND id=b->'item'->>'id' FOR UPDATE;
  SELECT to_jsonb(c) INTO current_row FROM collect_items c
    WHERE account_id=b->'item'->>'account_id' AND id=b->'item'->>'id';
  IF current_row IS DISTINCT FROM a->'item' THEN RAISE EXCEPTION 'MEDIA_REPAIR_ROLLBACK_CONFLICT: item'; END IF;
  PERFORM 1 FROM product_drafts WHERE id=b->'draft'->>'id' FOR UPDATE;
  SELECT to_jsonb(d) INTO current_row FROM product_drafts d WHERE id=b->'draft'->>'id';
  IF current_row IS DISTINCT FROM a->'draft' THEN RAISE EXCEPTION 'MEDIA_REPAIR_ROLLBACK_CONFLICT: draft'; END IF;
  PERFORM 1 FROM product_draft_variants WHERE draft_id=b->'draft'->>'id' FOR UPDATE;
  SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.sort_order,v.id),'[]'::jsonb) INTO current_row
    FROM product_draft_variants v WHERE draft_id=b->'draft'->>'id';
  IF current_row IS DISTINCT FROM a->'variants' THEN RAISE EXCEPTION 'MEDIA_REPAIR_ROLLBACK_CONFLICT: variants'; END IF;
  SELECT to_jsonb(r) INTO current_row FROM collect_raw_payloads r
    WHERE account_id=b->'item'->>'account_id' AND collect_item_id=b->'item'->>'id'
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF current_row IS DISTINCT FROM a->'raw' THEN RAISE EXCEPTION 'MEDIA_REPAIR_ROLLBACK_CONFLICT: raw'; END IF;
  IF EXISTS (SELECT 1 FROM collect_ozon_category_source_evidence WHERE product_raw_response_ref=a->'raw'->>'id')
    OR EXISTS (SELECT 1 FROM product_drafts WHERE source_payload_id=a->'raw'->>'id' AND id<>b->'draft'->>'id')
    OR EXISTS (SELECT 1 FROM product_draft_variants WHERE source_payload_id=a->'raw'->>'id' AND draft_id<>b->'draft'->>'id')
    THEN RAISE EXCEPTION 'MEDIA_REPAIR_ROLLBACK_CONFLICT: new raw has later dependents'; END IF;
  UPDATE product_drafts d SET source_payload_id=old.source_payload_id,version=old.version,
    data_hash=old.data_hash,data=old.data,updated_by=old.updated_by,updated_at=old.updated_at
    FROM jsonb_populate_record(NULL::product_drafts,b->'draft') old WHERE d.id=old.id;
  UPDATE product_draft_variants v SET source_payload_id=old.source_payload_id,data_hash=old.data_hash,
    source_content_hash=old.source_content_hash,data=old.data,updated_at=old.updated_at
    FROM jsonb_populate_recordset(NULL::product_draft_variants,b->'variants') old WHERE v.id=old.id AND v.draft_id=old.draft_id;
  UPDATE collect_items SET updated_at=(b->'item'->>'updated_at')::timestamptz
    WHERE account_id=b->'item'->>'account_id' AND id=b->'item'->>'id';
  DELETE FROM product_draft_revisions WHERE draft_id=b->'draft'->>'id'
    AND id='${revisionId}' AND version=(a->'draft'->>'version')::integer;
  DELETE FROM collect_raw_payloads WHERE account_id=b->'item'->>'account_id'
    AND collect_item_id=b->'item'->>'id' AND id=a->'raw'->>'id';
END ${tag};
COMMIT;
`;
}
async function saveBackup(path, backup) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(backup, null, 2)); await file.sync(); }
  finally { await file.close(); }
}
export async function runMediaRepair({ pool, accountId, collectId, source, sourceName = '',
  sourceSha256 = digest(source), apply = false, expectedToken = '', backupPath = '' }) {
  scope({ accountId, collectId });
  if (source.accountId && source.accountId !== accountId) fail('SCOPE', 'source account does not match');
  if (apply && (!/^[a-f0-9]{64}$/.test(expectedToken) || !backupPath)) {
    fail('GUARD_BACKUP', 'apply requires the database preview token and a new backup file path');
  }
  const client = await pool.connect();
  try {
    await client.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const before = await readRepairSnapshot(client, { accountId, collectId, lock: apply });
    const token = digest({ before, sourceSha256 });
    const guard = { token, draftVersion: before.draft.version, updatedAt: before.item.updated_at,
      draftUpdatedAt: before.draft.updated_at, rawId: before.raw.id };
    if (apply && token !== expectedToken) fail('CONFLICT', 'version, updated-at, raw, variant rows or source changed; preview again');
    const plan = planMediaRepair({ draft: before.draft.data, normalized: before.raw.payload.normalized,
      variants: before.variants, rootSku: before.item.source_sku, source });
    const report = { mode: apply ? 'apply' : 'database-dry-run', applied: false, accountId, collectId,
      source: { file: basename(sourceName), sha256: sourceSha256, collectId: source.id || null }, guard, summary: plan.summary };
    if (!apply || !plan.changes.length) { await client.query('ROLLBACK'); return report; }
    const at = (await client.query(`SELECT to_jsonb(GREATEST(clock_timestamp(),
      $1::timestamptz+interval '1 microsecond', $2::timestamptz+interval '1 microsecond')) AS at`,
    [before.raw.created_at, before.item.updated_at])).rows[0].at;
    const rawId = `raw_media_${randomUUID()}`, revisionId = `draftrev_media_${randomUUID()}`;
    const payload = { ...before.raw.payload, normalized: plan.normalized, mediaRepair: {
      kind: 'SAME_SKU_MISSING_ONLY', sourceFile: basename(sourceName), sourceSha256,
      sourceCollectId: source.id || null, previousRawId: before.raw.id,
      previousDraftVersion: before.draft.version, repairedAt: at, changes: plan.changes,
    } };
    const rawHash = digest(payload);
    const after = {
      item: { ...before.item, updated_at: at },
      draft: { ...before.draft, source_payload_id: rawId, version: before.draft.version + 1,
        data_hash: draftHash(plan.draft), data: plan.draft, updated_by: accountId, updated_at: at },
      raw: { ...before.raw, id: rawId, payload_hash: rawHash, content_hash: rawHash,
        request_id: rawId, collector_version: 'repair-collect-media/v1', payload, created_at: at },
      variants: plan.variants.map((variant, i) => digest(variant.data) === digest(before.variants[i].data) ? variant
        : { ...variant, source_payload_id: rawId, data_hash: sha256(JSON.stringify(variant.data)),
          source_content_hash: rawHash, updated_at: at }),
    };
    await saveBackup(backupPath, { format: 'collect-media-repair/v1', accountId, collectId,
      source: report.source, before, after: { ...after, updatedAt: at }, revisionId,
      rollbackSql: rollbackSql(before, after, revisionId),
      note: 'Prepared before any DML. May remain after a failed/uncertain COMMIT; rollback SQL verifies committed rows first. Keep privately with the source file.' });
    const check = result => { if (result.rowCount !== 1) fail('CONFLICT', 'scoped write lost its expected row'); };
    check(await client.query(`INSERT INTO collect_raw_payloads
      (id,collect_item_id,account_id,store_id,data_collection_store_id,source_sku,source_url,payload_hash,
       content_hash,request_id,collector_version,payload,collected_at,created_at)
      SELECT $3,r.collect_item_id,r.account_id,r.store_id,r.data_collection_store_id,r.source_sku,r.source_url,
        $4,$4,$3,'repair-collect-media/v1',$5::jsonb,r.collected_at,$6::timestamptz
      FROM collect_raw_payloads r WHERE r.account_id=$1 AND r.collect_item_id=$2 AND r.id=$7`,
    [accountId, collectId, rawId, rawHash, JSON.stringify(payload), at, before.raw.id]));
    check(await client.query(`UPDATE product_drafts d SET source_payload_id=$3,version=version+1,
      data_hash=$4,data=$5::jsonb,updated_by=$1,updated_at=$6::timestamptz FROM collect_items c
      WHERE c.account_id=$1 AND c.id=$2 AND c.current_draft_id=d.id AND d.collect_item_id=c.id
        AND d.version=$7 AND d.updated_at=$8::timestamptz`,
    [accountId, collectId, rawId, after.draft.data_hash, JSON.stringify(plan.draft), at, before.draft.version, before.draft.updated_at]));
    check(await client.query(`INSERT INTO product_draft_revisions(id,draft_id,version,data_hash,data,changed_by,change_reason,created_at)
      SELECT $3,d.id,d.version,d.data_hash,d.data,$1,$4,$5::timestamptz FROM product_drafts d
      JOIN collect_items c ON c.current_draft_id=d.id AND c.id=d.collect_item_id WHERE c.account_id=$1 AND c.id=$2`,
    [accountId, collectId, revisionId, `MEDIA_REPAIR:${rawId}`, at]));
    for (const [i, variant] of after.variants.entries()) {
      if (digest(variant) === digest(before.variants[i])) continue;
      check(await client.query(`UPDATE product_draft_variants v SET source_payload_id=$3,data_hash=$4,
        source_content_hash=$5,data=$6::jsonb,updated_at=$7::timestamptz FROM collect_items c
        WHERE c.account_id=$1 AND c.id=$2 AND c.current_draft_id=v.draft_id AND v.id=$8`,
      [accountId, collectId, rawId, variant.data_hash, rawHash, JSON.stringify(variant.data), at, variant.id]));
    }
    check(await client.query(`UPDATE collect_items SET updated_at=$3::timestamptz
      WHERE account_id=$1 AND id=$2 AND current_draft_id=$4 AND updated_at=$5::timestamptz`,
    [accountId, collectId, at, before.draft.id, before.item.updated_at]));
    const persisted = await readRepairSnapshot(client, { accountId, collectId });
    if (digest(persisted) !== digest(after)) fail('VERIFY', 'stored repair differs from the reviewed media-only change');
    await client.query('COMMIT');
    return { ...report, applied: true, backup: resolve(backupPath), rawId, draftVersion: after.draft.version, updatedAt: at };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

const HELP = `Targeted same-SKU media repair (no automatic migrations or external API calls).
Default: dry-run. Only --apply performs SQL writes.

Offline preview (filtered public JSON; NEVER accepted for apply):
  node scripts/repair-collect-media.mjs --account-id ACCOUNT --collect-id COLLECT --source SOURCE.json --current CURRENT.json
Database preview (reads full stored group; reports version/time/source guard token):
  node scripts/repair-collect-media.mjs --account-id ACCOUNT --collect-id COLLECT --source SOURCE.json
Apply, by the production operator only, after their production backup:
  node scripts/repair-collect-media.mjs --account-id ACCOUNT --collect-id COLLECT --source SOURCE.json --apply --expect-token TOKEN --backup /private/backup/unique-media.json

Use the project's DATABASE_URL or POSTGRES_* configuration; none is printed.
--dry-run is optional and cannot be combined with --apply. --current never connects to a database.
The apply backup parent directory must already exist. The file is exclusive, mode 0600,
fsynced BEFORE writes, and contains original item/draft/raw/variant rows plus guarded rollbackSql.
The operator can extract backup.rollbackSql and run it against the SAME database with psql
ON_ERROR_STOP=1. It restores original rows and removes only this repair's new raw/revision;
it refuses to overwrite later edits. A failed/uncertain apply may leave a backup: verify state first.
Keep the original source file and its SHA-256 with the backup. No AI task, price, gallery,
logistics, Russian attribute, SKU roster, publish queue or original raw payload is updated.
`;
async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { console.log(HELP); return; }
  const options = {}, flags = new Set(['--apply', '--dry-run']);
  const values = new Set(['--account-id', '--collect-id', '--source', '--current', '--expect-token', '--backup']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if ((!flags.has(key) && !values.has(key)) || Object.hasOwn(options, key)) fail('ARGUMENT', 'unknown or duplicate option; use --help');
    if (flags.has(key)) options[key] = true;
    else { const value = argv[++i]; if (!value || value.startsWith('--')) fail('ARGUMENT', 'missing option value'); options[key] = value; }
  }
  const accountId = options['--account-id'], collectId = options['--collect-id'], apply = options['--apply'] === true;
  scope({ accountId, collectId });
  if (!options['--source']) fail('SOURCE', 'source JSON file is required');
  if (apply && (options['--current'] || options['--dry-run'])) fail('ARGUMENT', 'apply requires live database input and cannot be dry-run');
  if (!apply && (options['--expect-token'] || options['--backup'])) fail('ARGUMENT', 'guard/backup options require --apply');
  const bytes = await readFile(options['--source']);
  const source = JSON.parse(bytes.toString('utf8')), sourceSha256 = sha256(bytes);
  if (source.accountId && source.accountId !== accountId) fail('SCOPE', 'source account does not match');
  if (options['--current']) {
    const current = JSON.parse(await readFile(options['--current'], 'utf8'));
    if (current.id !== collectId || (current.accountId && current.accountId !== accountId)) fail('SCOPE', 'current file scope does not match');
    const { listingDraft, ...normalized } = current;
    const plan = planMediaRepair({ draft: listingDraft, normalized, source, rootSku: skuOf(current) });
    console.log(JSON.stringify({ mode: 'offline-dry-run', applied: false, accountId, collectId,
      source: { file: basename(options['--source']), sha256: sourceSha256, collectId: source.id || null },
      summary: plan.summary, note: 'Public JSON may filter listed SKUs and omit version/timestamps. Only a database dry-run can issue an apply guard.' }, null, 2));
    return;
  }
  // Lazy imports keep tests, --help and offline previews independent of .env / DB.
  await import('../server/env.mjs');
  const { getPostgresPool, closePostgresPool } = await import('../server/db/connection.mjs');
  try {
    console.log(JSON.stringify(await runMediaRepair({ pool: await getPostgresPool(), accountId, collectId,
      source, sourceName: options['--source'], sourceSha256, apply,
      expectedToken: options['--expect-token'], backupPath: options['--backup'] }), null, 2));
  } finally { await closePostgresPool(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    // pg errors can contain SQL, payloads or connection strings. No arbitrary
    // error.message, stack, process.env, source data or connection config in logs.
    console.error(error instanceof RepairError ? error.message : 'MEDIA_REPAIR_FAILED: check input, backup path and database access; no sensitive diagnostic details printed');
    process.exitCode = 1;
  });
}

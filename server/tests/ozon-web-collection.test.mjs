import './support/dedicated-postgres-test-environment.mjs';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { parseWebCollectionInput, createOzonWebCollectionService } from '../ozon-web-collection.mjs';
import { createOzonWebCollectionHttpHandler } from '../ozon-web-collection-routes.mjs';

test('Web input fixes the source URL to an Ozon SKU and rejects foreign scope fields', () => {
  assert.deepEqual(parseWebCollectionInput({ sku: ' 3252770347 ', scope: 'ALL', requestId: 'request-1' }),
    { sku: '3252770347', scope: 'ALL', requestId: 'request-1' });
  for (const body of [
    { sku: 'https://evil.test/', requestId: 'r' },
    { sku: '3252770347', scope: 'UNKNOWN', requestId: 'r' },
    { sku: '3252770347', requestId: 'r', accountId: 'another-account' },
    { sku: '3252770347', requestId: '' },
  ]) assert.throws(() => parseWebCollectionInput(body), { status: 400 });
});

test('HTTP routes separate Web and Collector identities and reject client-selected ownership', async () => {
  const calls = [];
  const service = {
    create: async input => { calls.push(input); return { id: 'job1' }; },
    claim: async input => { calls.push(input); return { id: 'job1', claimFence: 'fence1' }; },
    complete: async input => { calls.push(input); return { id: 'job1', status: 'COMPLETED' }; },
  };
  const handler = createOzonWebCollectionHttpHandler({ service,
    authenticateWeb: async req => {
      if (req.headers.authorization !== 'Bearer web') throw Object.assign(new Error('登录失效'), { status: 401 });
      return { id: 'account-web' };
    },
    authenticateCollector: async (req, permission) => {
      assert.equal(permission, 'collector.upload');
      if (req.headers.authorization !== 'Collector extension') throw Object.assign(new Error('采集授权失效'), { status: 401 });
      return { accountId: 'account-extension', collectorSessionId: 'session-extension' };
    },
    readJson: async req => req.body,
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
  });
  async function invoke(path, authorization, body = {}) {
    const res = {};
    assert.equal(await handler({ method: 'POST', headers: { authorization }, body }, res, new URL(path, 'http://test')), true);
    return res;
  }
  assert.equal((await invoke('/ozon/collect-box/web-jobs', 'Collector extension', { sku: '3252770347', requestId: 'r' })).status, 401);
  assert.equal((await invoke('/collector/ozon/web-jobs/next', 'Bearer web')).status, 401);
  assert.equal((await invoke('/ozon/collect-box/web-jobs', 'Bearer web', { sku: '3252770347', requestId: 'r', accountId: 'foreign' })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await invoke('/ozon/collect-box/web-jobs', 'Bearer web', { sku: '3252770347', scope: 'CURRENT', requestId: 'r' })).status, 202);
  assert.deepEqual(calls.pop(), { accountId: 'account-web', sku: '3252770347', scope: 'CURRENT', requestId: 'r' });
  assert.equal((await invoke('/collector/ozon/web-jobs/next', 'Collector extension')).body.data.claimFence, 'fence1');
  assert.deepEqual(calls.pop(), { accountId: 'account-extension', collectorSessionId: 'session-extension' });
  assert.equal((await invoke('/collector/ozon/web-jobs/job1/result', 'Collector extension', { claimFence: 'fence1', payload: { sku: '3252770347' }, capturedAt: '2026-09-14T12:00:00.000Z' })).status, 200);
  assert.equal(calls.pop().accountId, 'account-extension');
});

const enabled = Boolean(process.env.DATABASE_URL);
let pool;
let schema;
before(async () => {
  if (!enabled) return;
  schema = `web_collect_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 6 });
  await pool.query('CREATE TABLE accounts(id text PRIMARY KEY); CREATE TABLE collector_sessions(id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id));');
  await pool.query(await readFile(new URL('../db/migrations/138_ozon_web_collection_jobs.sql', import.meta.url), 'utf8'));
});
after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
});
const postgres = { skip: enabled ? false : 'requires a dedicated PostgreSQL test database' };

test('official admission holds no job write lock and cancellation wins before persistence',postgres,async()=>fixture(async({service,create,actor})=>{
  const job=await create('3252770347');const claim=await service.claim(actor);
  let release,started;const waiting=new Promise(resolve=>{release=resolve;});const began=new Promise(resolve=>{started=resolve;});
  let persisted=0;
  const completing=createOzonWebCollectionService({getPool:async()=>pool,
    prepareAdmission:async({input})=>{started('preparing');await waiting;return input.payload;},
    ingestCollection:async()=>{persisted++;return {collectItemId:'must-not-save',item:{}};}});
  const result=completing.complete({...actor,id:job.id,claimFence:claim.claimFence,payload:{sku:job.sku}});
  assert.equal(await Promise.race([began,result.then(()=> 'already completed')]),'preparing');
  try {await service.cancel({accountId:actor.accountId,id:job.id});}finally{release();}
  await assert.rejects(result,{code:'WEB_COLLECTION_CLAIM_LOST'});
  assert.equal(persisted,0);
}));

async function fixture(fn) {
  const accountId = randomUUID(), otherAccountId = randomUUID();
  const session = randomUUID(), secondSession = randomUUID(), otherSession = randomUUID();
  await pool.query('INSERT INTO accounts VALUES ($1),($2)', [accountId, otherAccountId]);
  await pool.query('INSERT INTO collector_sessions VALUES ($1,$2),($3,$2),($4,$5)', [session, accountId, secondSession, otherSession, otherAccountId]);
  const uploads = [];
  const service = createOzonWebCollectionService({ getPool: async () => pool,
    prepareAdmission:async ({input})=>input.payload,
    ingestCollection: async options => {
      uploads.push(options);
      return { collectItemId: 'collect-real-receipt', duplicate: false, item: { id: 'collect-real-receipt' } };
    },
  });
  const create = (sku, scope = 'ALL') => service.create({ accountId, sku, scope, requestId: randomUUID() });
  const actor = { accountId, collectorSessionId: session };
  try { await fn({ service, create, actor, accountId, otherAccountId, secondSession, otherSession, uploads }); }
  finally {
    await pool.query('DELETE FROM collector_sessions WHERE account_id=ANY($1::text[])', [[accountId, otherAccountId]]);
    await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])', [[accountId, otherAccountId]]);
  }
}

test('durable FIFO claims have one owner per account and retain queued jobs across service restart', postgres, async () => fixture(async ({ service, create, actor, accountId, otherAccountId, otherSession, secondSession }) => {
  const first = await create('3252770347');
  const duplicate = await create('3252770347');
  assert.equal(duplicate.id, first.id, 'duplicate Web clicks reuse the active SKU');
  const second = await create('3252771243');
  const claims = await Promise.all([service.claim(actor), service.claim({ ...actor, collectorSessionId: secondSession })]);
  const claimed = claims.find(Boolean);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.sourceUrl, 'https://www.ozon.ru/product/3252770347/');
  assert.equal(await service.claim({ accountId: otherAccountId, collectorSessionId: otherSession }), null);
  assert.equal((await service.list({ accountId })).total, 2);
  assert.equal((await service.list({ accountId: otherAccountId })).total, 0);
  await pool.query("UPDATE ozon_web_collection_jobs SET claim_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [first.id]);
  const restarted = createOzonWebCollectionService({ getPool: async () => pool, ingestCollection: async () => ({}) });
  const reclaimed = await restarted.claim(actor);
  assert.equal(reclaimed.id, first.id);
  assert.notEqual(reclaimed.claimFence, claimed.claimFence);
  await assert.rejects(service.progress({ ...actor, id: first.id, claimFence: claimed.claimFence }), { code: 'WEB_COLLECTION_CLAIM_LOST' });
  await service.fail({ ...actor, id: first.id, claimFence: reclaimed.claimFence, code: 'COLLECT_GALLERY_FAILED', message: 'SKU 图册读取失败', waiting: false });
  assert.equal((await service.claim(actor)).id, second.id, 'a bad product does not block the next');
}));

test('login waits pause only that account, retry keeps identity, and cancellation rejects late results', postgres, async () => fixture(async ({ service, create, actor, otherAccountId, otherSession }) => {
  const job = await create('3252770347');
  await create('3252771243');
  const claim = await service.claim(actor);
  await service.fail({ ...actor, id: job.id, claimFence: claim.claimFence, code: 'ZONGZI_LOGIN_REQUIRED', message: '请登录 Seller', waiting: true });
  assert.equal(await service.claim(actor), null);
  await service.create({ accountId: otherAccountId, sku: '3556540370', scope: 'ALL', requestId: randomUUID() });
  assert.ok(await service.claim({ accountId: otherAccountId, collectorSessionId: otherSession }));
  await assert.rejects(service.retry({ accountId: otherAccountId, id: job.id }), { status: 404 });
  assert.equal((await service.retry({ accountId: actor.accountId, id: job.id })).id, job.id);
  const resumed = await service.claim(actor);
  assert.equal(resumed.id, job.id);
  await service.cancel({ accountId: actor.accountId, id: job.id });
  await assert.rejects(service.complete({ ...actor, id: job.id, claimFence: resumed.claimFence, payload: { sku: job.sku } }), { code: 'WEB_COLLECTION_CLAIM_LOST' });
}));

test('complete passes full per-SKU evidence to V4 once and replays a lost success acknowledgement', postgres, async () => fixture(async ({ service, create, actor, otherAccountId, uploads }) => {
  const job = await create('2102713967');
  const claim = await service.claim(actor);
  const payload = { sku: job.sku, name: 'Светильник', images: ['https://cdn.test/one.jpg', 'https://cdn.test/two.jpg'],
    description: 'Описание', richContent: '{"content":[]}', priceCurrency: 'CNY',
    variantData: { variants: [{ sku: job.sku, images: ['https://cdn.test/one.jpg'] }, { sku: '2545514366', images: ['https://cdn.test/other.jpg'], blackPrice: '44.25', attributes: [{ key: '100', values: [{ dictionary_value_id: 42, value: 'Белый' }] }] }] } };
  const input = { ...actor, id: job.id, claimFence: claim.claimFence, payload, capturedAt: '2026-09-14T12:00:00.000Z' };
  await assert.rejects(service.complete({ ...input, accountId: otherAccountId }), { status: 404 });
  await assert.rejects(service.complete({ ...input, payload: { ...payload, sku: '9999999999' } }), { code: 'WEB_COLLECTION_SKU_MISMATCH' });
  assert.equal(uploads.length, 0);
  const completed = await service.complete(input);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.result.variantCount, 2);
  assert.equal(completed.result.collectItemId, 'collect-real-receipt');
  assert.deepEqual(uploads[0].input.payload, payload);
  assert.equal(uploads[0].input.requestId, `web-collect-${job.id}-${claim.claimFence}`);
  assert.equal((await service.complete(input)).result.collectItemId, 'collect-real-receipt');
  assert.equal(uploads.length, 1);
  await assert.rejects(service.fail({ ...actor, id: job.id, claimFence: claim.claimFence, code: 'TIMEOUT', message: 'late failure' }), { code: 'WEB_COLLECTION_CLAIM_LOST' });
  assert.equal((await service.list({ accountId: actor.accountId })).items[0].status, 'COMPLETED');
}));

import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { getPostgresPool, closePostgresPool } from '../db/connection.mjs';
import { runMigrations } from '../db/migrate.mjs';
import { createOzonWebCollectionService } from '../ozon-web-collection.mjs';
import { createOzonWebCollectionHttpHandler } from '../ozon-web-collection-routes.mjs';
import { authenticateCollectionRequest } from '../collection-pipeline.mjs';
import { createCollectorAuthService } from '../collector-auth-service.mjs';
import { createPostgresCollectorAuthRepository } from '../collector-auth-repository.mjs';
import { createAccountSharedOzonCategoryRuntime } from '../account-shared-ozon-category-runtime.mjs';

test('real HTTP and V4 preserve independent SKU galleries, prices and attributes and do not duplicate an existing draft',
  { skip: !process.env.DATABASE_URL, timeout: 45000 }, async () => {
  const pool = await getPostgresPool();
  await runMigrations(pool);
  const accountId = `web-e2e-${randomUUID()}`, otherId = `web-e2e-${randomUUID()}`;
  const token = randomUUID(), otherToken = randomUUID();
  const auth = createCollectorAuthService({ repository: createPostgresCollectorAuthRepository({ pool }) });
  await pool.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active'),($2,$2,$2,'user','active')", [accountId, otherId]);
  await pool.query("INSERT INTO sessions(token,account_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour'),($3,$4,NOW()+INTERVAL '1 hour')", [token, accountId, otherToken, otherId]);
  const ticket = await auth.issueTicket({ account: { id: accountId, status: 'active' }, parentSessionToken: token });
  const session = await auth.exchangeTicket({ ticket: ticket.ticket, extensionVersion: 'test', deviceFingerprint: 'isolated-test' });
  const categoryEvidencePort = createAccountSharedOzonCategoryRuntime({
    loadState: async () => ({ stores: [], currentStoreIdsByAccount: {} }), saveState: async () => {},
    stateTransaction: { run: fn => fn() }, persistenceMode: () => 'postgres',
  });
  const service = createOzonWebCollectionService({ categoryEvidencePort });
  const sendJson = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const handler = createOzonWebCollectionHttpHandler({ service, authenticateWeb: authenticateCollectionRequest,
    authenticateCollector: async (req, requiredPermission) => {
      const match = String(req.headers.authorization || '').match(/^Collector (.+)$/);
      return auth.authenticate({ collectorToken: match?.[1] || '', requiredPermission });
    }, readJson: async req => { let text = ''; for await (const part of req) text += part; return JSON.parse(text || '{}'); }, sendJson });
  const server = createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://test'))) sendJson(res, 404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, credential = `Bearer ${token}`) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: credential, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  }
  const collector = (path, body = {}) => request(`/collector/ozon/web-jobs/${path}`, body, `Collector ${session.collectorToken}`);
  const sku = '2102713967', otherSku = '2545514366';
  const gallery = (sku, count) => Array.from({ length: count }, (_, index) => `https://cdn1.ozone.ru/s3/multimedia-test/${sku}-${index}.jpg`);
  const variants = [sku, otherSku].map((sku, index) => ({ sku, title: `Светильник ${index + 1}`, name: `Светильник ${index + 1}`,
    images: gallery(sku, index + 2), blackPrice: index ? '44.25' : '35.05', greenPrice: index ? '42.00' : '33.00', currencyCode: 'CNY',
    attributes: [{ key: '100', values: [{ dictionary_value_id: index + 41, value: index ? 'Белый' : 'Чёрный' }] }],
    aspectValues: { 'Цвет': index ? 'Белый' : 'Чёрный' } }));
  const payload = { sku, name: 'Светильник настенный', title: 'Светильник настенный', description: 'Светильник для освещения комнаты.',
    images: gallery(sku, 2), blackPrice: '35.05', greenPrice: '33.00', currencyCode: 'CNY', priceCurrency: 'CNY',
    variantData: { variants }, attributes: variants[0].attributes };
  try {
    const current = (await request('/ozon/collect-box/web-jobs', { sku, scope: 'CURRENT', requestId: 'single-first' })).body.data;
    const currentClaim = (await collector('next')).body.data;
    const currentResult = await collector(`${current.id}/result`, { claimFence: currentClaim.claimFence,
      payload: { ...payload, variantData: { attributes: variants[0].attributes } }, capturedAt: new Date().toISOString() });
    assert.equal(currentResult.status, 200, JSON.stringify(currentResult));
    const manual = { title: 'Ручное название', images: [gallery(sku, 2)[1]], blackPrice: '41.10' };
    await pool.query('UPDATE product_drafts SET data=data || $2::jsonb WHERE collect_item_id=$1', [currentResult.body.data.result.collectItemId, JSON.stringify(manual)]);
    const created = await request('/ozon/collect-box/web-jobs', { sku, scope: 'ALL', requestId: 'whole-group' });
    assert.equal(created.status, 202, JSON.stringify(created));
    const job = created.body.data;
    assert.equal((await request('/ozon/collect-box/web-jobs', undefined, `Bearer ${otherToken}`)).body.data.total, 0);
    assert.equal((await request(`/ozon/collect-box/web-jobs/${job.id}/cancel`, {}, `Bearer ${otherToken}`)).status, 404);
    const claim = (await collector('next')).body.data;
    assert.equal(claim.id, job.id);
    const result = await collector(`${job.id}/result`, { claimFence: claim.claimFence, payload, capturedAt: new Date().toISOString() });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.data.status, 'COMPLETED');
    assert.equal(result.body.data.result.variantCount, 2);
    const id = result.body.data.result.collectItemId;
    assert.equal(id, currentResult.body.data.result.collectItemId, 'adding siblings upgrades the existing group');
    const saved = (await pool.query('SELECT data AS draft_data FROM product_drafts WHERE collect_item_id=$1', [id])).rows;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].draft_data.title, 'Ручное название');
    assert.deepEqual(saved[0].draft_data.variants.map(v => v.sku).sort(), [sku, otherSku].sort());
    for (const variant of variants) {
      const row = saved[0].draft_data.variants.find(v => v.sku === variant.sku);
      assert.deepEqual(row.images, variant.sku === sku ? manual.images : variant.images);
      assert.equal(String(row.blackPrice), variant.sku === sku ? manual.blackPrice : variant.blackPrice);
      if (variant.sku === sku) assert.equal(row.title, manual.title);
    }
    const raws = await pool.query('SELECT payload FROM collect_raw_payloads WHERE collect_item_id=$1 ORDER BY created_at DESC', [id]);
    assert.ok(raws.rows.some(row => JSON.stringify(row.payload).includes('dictionary_value_id')));
    assert.deepEqual(raws.rows[0].payload.normalized.variants.map(v => v.sku).sort(), [sku, otherSku].sort(), 'normalized source variants must not duplicate siblings');
    const before = JSON.stringify(saved[0].draft_data);
    assert.equal((await collector(`${job.id}/result`, { claimFence: claim.claimFence, payload })).status, 200);
    const duplicateJob = (await request('/ozon/collect-box/web-jobs', { sku, scope: 'ALL', requestId: 'whole-group-again' })).body.data;
    const duplicateClaim = (await collector('next')).body.data;
    assert.equal(duplicateClaim.id, duplicateJob.id);
    const duplicate = await collector(`${duplicateJob.id}/result`, { claimFence: duplicateClaim.claimFence, payload });
    assert.equal(duplicate.body.data.result.collectItemId, id);
    assert.equal(duplicate.body.data.result.duplicate, true);
    assert.equal(JSON.stringify((await pool.query('SELECT data AS draft_data FROM product_drafts WHERE collect_item_id=$1', [id])).rows[0].draft_data), before);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM collect_items WHERE account_id=$1', [accountId])).rows[0].n, 1);
    assert.deepEqual((await pool.query('SELECT sku FROM collector_ozon_enrichment_jobs WHERE account_id=$1 ORDER BY sku', [accountId])).rows.map(row => row.sku), [sku, otherSku].sort());
    const retained = saved[0].draft_data.variants.filter(v => v.sku === sku);
    await pool.query("UPDATE product_drafts SET data=jsonb_set(data,'{variants}',$2::jsonb) WHERE collect_item_id=$1", [id, JSON.stringify(retained)]);
    const thirdSku = '4100000003', thirdVariant = { ...variants[1], sku: thirdSku, images: gallery(thirdSku, 4) };
    const extended = (await request('/ozon/collect-box/web-jobs', { sku, scope: 'ALL', requestId: 'add-third-keep-removed-sibling' })).body.data;
    const extendedClaim = (await collector('next')).body.data;
    const extendedResult = await collector(`${extended.id}/result`, { claimFence: extendedClaim.claimFence,
      payload: { ...payload, variantData: { variants: [...variants, thirdVariant] } } });
    assert.equal(extendedResult.status, 200, JSON.stringify(extendedResult));
    assert.equal(extendedResult.body.data.result.collectItemId, id);
    assert.equal(extendedResult.body.data.result.variantCount, 2, 'receipt counts saved rows, not previously removed source siblings');
    const extendedDraft = (await pool.query('SELECT data FROM product_drafts WHERE collect_item_id=$1', [id])).rows[0].data;
    assert.deepEqual(extendedDraft.variants.map(v => v.sku).sort(), [sku, thirdSku].sort(), 'a removed known sibling must not reappear');
    assert.deepEqual(extendedDraft.variants.find(v => v.sku === sku).images, manual.images);
    // A real V4 rejection records a failed request. Explicitly retrying the Web
    // job must accept newly captured prices without conflicting with that body.
    const ruleId = randomUUID(), retrySku = '3556540370';
    await pool.query('INSERT INTO platform_product_restrictions(id,payload,updated_by) VALUES($1,$2,$3)', [ruleId,
      { enabled: true, action: 'BLOCK', name: 'fixture restriction', reason: 'isolated fixture', categories: [{ categoryId: 880011, typeId: 880022 }] }, accountId]);
    const retryPayload = { ...payload, sku: retrySku, variantData: { variants: [{ ...variants[0], sku: retrySku }] }, sourceCategory: { descriptionCategoryId: 880011, typeId: 880022 } };
    const rejectedJob = (await request('/ozon/collect-box/web-jobs', { sku: retrySku, scope: 'CURRENT', requestId: 'retry-changed-price' })).body.data;
    const oldClaim = (await collector('next')).body.data;
    const rejected = await collector(`${rejectedJob.id}/result`, { claimFence: oldClaim.claimFence, payload: retryPayload });
    assert.equal(rejected.status, 422, JSON.stringify(rejected));
    await collector(`${rejectedJob.id}/fail`, { claimFence: oldClaim.claimFence, code: rejected.body.code, message: rejected.body.message });
    await pool.query('DELETE FROM platform_product_restrictions WHERE id=$1', [ruleId]);
    assert.equal((await request(`/ozon/collect-box/web-jobs/${rejectedJob.id}/retry`, {})).status, 200);
    const newClaim = (await collector('next')).body.data;
    assert.notEqual(newClaim.claimFence, oldClaim.claimFence);
    retryPayload.blackPrice = '36.05'; retryPayload.variantData.variants[0].blackPrice = '36.05';
    const recovered = await collector(`${rejectedJob.id}/result`, { claimFence: newClaim.claimFence, payload: retryPayload });
    assert.equal(recovered.status, 200, JSON.stringify(recovered));
    assert.equal(recovered.body.data.status, 'COMPLETED');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await service.close(); await closePostgresPool();
  }
});

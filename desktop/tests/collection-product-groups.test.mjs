import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const loader = fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url));
const collectionUrl = new URL('../dist-electron/services/collection/collection.services.js', import.meta.url).href;
function probe(script) {
    const dir = mkdtempSync(join(tmpdir(), 'collector-groups-'));
    try {
        const result = spawnSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import { Collection } from ${JSON.stringify(collectionUrl)};
            const groups = new Map(), saved = [], checkpoints = [], exports = [], requests = [], detailReads = [], released = [];
            let unavailable = '', allRatingsPass = false, active = 0, maxActive = 0, groupSize = 3, hiddenDescriptor = '';
            const missingSkus = new Set();
            const skusFor = sku => Array.from({ length: groupSize }, (_, index) => String(Math.floor(Number(sku) / 1000) * 1000 + index + 1));
            globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
                const path = request.url, data = request.data || {};
                if (path.endsWith('/skus/claim')) return { data: { items: data.skus.map(sku => ({ sku, state: 'CLAIMED' })) } };
                if (path.endsWith('/product-groups/claim')) {
                    assert.ok(data.deviceId); assert.equal(data.leaseToken, 'lease');
                    const groupId = 'group-' + Math.floor(Number(data.anchorSku) / 1000);
                    let group = groups.get(groupId);
                    if (!group) groups.set(groupId, group = { skus: skusFor(data.anchorSku), variants: new Map(), owner: '', complete: false });
                    const owner = path.split('/')[3] + ':' + data.anchorSku;
                    const status = group.complete ? 'COLLECTED' : group.owner && group.owner !== owner ? 'COLLECTING' : 'CLAIMED';
                    if (status === 'CLAIMED') group.owner = owner;
                    return { data: { groupId, status, skus: group.skus, cachedVariants: [...group.variants.values()] } };
                }
                if (/\\/product-groups\\/[^/]+\\/variants$/.test(path)) {
                    const group = groups.get(path.split('/').at(-2));
                    assert.ok(group); assert.ok(data.deviceId); assert.equal(data.leaseToken, 'lease');
                    assert.ok(group.skus.includes(data.variant.sku));
                    checkpoints.push(structuredClone(data.variant)); group.variants.set(data.variant.sku, structuredClone(data.variant));
                    return { data: { ok: true } };
                }
                if (/\\/product-groups\\/[^/]+\\/release$/.test(path)) {
                    assert.equal(data.leaseToken, 'lease');
                    assert.ok(path.split('/')[3], 'release must retain the original run after local cancellation clears it');
                    released.push(path.split('/').at(-2)); groups.get(path.split('/').at(-2)).owner = '';
                    return { data: { ok: true } };
                }
                if (path.endsWith('/items')) {
                    if (request.method === 'get') return { data: { items: saved.filter(item => item.status === 'QUALIFIED') } };
                    for (const item of data.items) {
                        if (item.status === 'QUALIFIED' && item.rawPayload.captureScope === 'ALL') {
                            const group = groups.get(item.sourceKey);
                            assert.ok(group, 'final source key must be the server group ID');
                            assert.equal(group.variants.size, group.skus.length, 'all own details checkpoint before qualification');
                            group.complete = true; group.owner = '';
                        }
                        saved.push(structuredClone(item));
                    }
                    return { data: { ok: true } };
                }
                return { data: { ok: true } };
            };
            function collection(runId = 'run', options = {}) {
                const c = new Collection({ _id: 'task', taskName: 'Groups', captureScope: 'ALL', aiSelectType: 1,
                    targetCount: 10, concurrency: 2, soldCountMin: 50, ratingMin: 4, ...options }, null);
                c.runId = runId; c.leaseToken = 'lease'; c.uuid = runId;
                c.mainWindowService.browserWindow = { isDestroyed: () => false };
                c.mainWindowService.getDomain = async () => 'https://www.ozon.ru';
                const readDetail = c.mainWindowService.getDataByApi.bind(c.mainWindowService);
                c.mainWindowService.getDataByApi = (sku, ...args) => { detailReads.push(String(sku)); return readDetail(sku, ...args); };
                c.mainWindowService.getOzonPageJson = async url => {
                    const path = new URL(url).searchParams.get('url');
                    if (path.startsWith('/modal/otherOffers')) return { success: true, data: { widgetStates: {
                        webSellerList: { sellers: [{ link: 'https://www.ozon.ru/seller/7000/', rating: { totalScore: 5 } }], originalWidget: 'public offers' },
                    } } };
                    const sku = path.match(/product\\/(\\d+)/)?.[1];
                    assert.ok(sku, path); requests.push(sku); active++; maxActive = Math.max(maxActive, active);
                    await new Promise(setImmediate); active--;
                    const index = Number(sku) % 1000;
                    const states = {
                        webGallery: { sku, images: ['https://cdn.test/' + sku + '-main.jpg', 'https://cdn.test/' + sku + '-detail.jpg'],
                            videos: [{ url: 'https://cdn.test/' + sku + '.mp4', coverUrl: 'https://cdn.test/' + sku + '-poster.jpg' }],
                            color_image: 'https://cdn.test/' + sku + '-swatch.jpg', videoCover: { url: 'https://cdn.test/' + sku + '-cover.mov' } },
                        webProductHeading: { sku, title: 'Товар ' + sku },
                        webPrice: { price: index + '0.25 ¥', cardPrice: index + '0.00 ¥' },
                        webDescription: { richAnnotationType: 'HTML', richAnnotation: '<p>Описание ' + sku + '</p>',
                            richAnnotationJson: JSON.stringify({ content: [{ widgetName: 'raTextBlock', blocks: [{ text: 'Описание ' + sku }] }] }) },
                        webCharacteristics: { sku, characteristics: [{ name: 'Материал', value: 'Материал ' + sku }] },
                        webReviewProductScore: { totalScore: allRatingsPass || index === 1 ? 5 : 1 },
                        webAspects: { aspects: [{ aspectName: 'Размер', variants: skusFor(sku).filter(id => id !== hiddenDescriptor).map(id => ({ sku: id, link: '/product/' + id + '/', data: { searchableText: id } })) }] },
                    };
                    if (sku === unavailable || missingSkus.has(sku)) delete states.webGallery;
                    return { success: true, data: { widgetStates: states } };
                };
                c.excelService.saveExcel = async rows => { exports.push(...structuredClone(rows)); return true; };
                c.excelService.DeleteFilled = async () => {};
                c.excelService.getFilePath = async () => '';
                return c;
            }
            const entry = id => ({ id, sku: id, price: 100, soldCount: 60, nameLabel: 'Entry ' + id });
            ${script}
        `], { env: { ...process.env, DESKTOP_TEST_USER_DATA: dir }, encoding: 'utf8', timeout: 25000 });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('one qualifying entry collects all own-SKU variants as one target product and exports every SKU', () => probe(`
    const c = collection('run', { targetCount: 1 });
    await c.categoryProcess([entry('1001')]);
    const qualified = saved.filter(item => item.status === 'QUALIFIED');
    assert.equal(qualified.length, 1); assert.equal(c.targetData, 1);
    assert.equal(qualified[0].sourceKey, 'group-1'); assert.equal(qualified[0].sourceSku, '1001');
    const payload = qualified[0].rawPayload;
    assert.equal(payload.captureScope, 'ALL'); assert.equal(payload.collectorGroupId, 'group-1');
    assert.deepEqual(payload.variantData.expectedSkus, ['1001', '1002', '1003']);
    assert.equal(payload.variantData.variants.length, 3); assert.equal(checkpoints.length, 3);
    assert.deepEqual(exports.map(row => row.sku), ['1001', '1002', '1003']);
    for (const row of payload.variantData.variants) {
        assert.equal(row.images.length, 2); assert.ok(row.images.every(url => url.includes(row.sku)));
        assert.equal(row.sourceCharacteristics[0].value, 'Материал ' + row.sku);
        assert.equal(row.blackPrice, Number(row.sku) % 1000 + '0.25'); assert.equal(row.blackPriceCurrency, 'CNY');
        assert.equal(row.greenPrice, Number(row.sku) % 1000 + '0.00');
        assert.equal(row.description, '<p>Описание ' + row.sku + '</p>');
        assert.equal(row.sellerNumber, 1); assert.equal(Object.hasOwn(row, 'sellers'), false, 'do not repeat full offer widgets in every variant');
        assert.equal(Object.hasOwn(row, 'sourceAspects'), false, 'the consumed full group index must not be copied into every variant');
    }
    assert.equal(payload.sellers.sellers[0].link, 'https://www.ozon.ru/seller/7000/', 'retain the entry offers once for existing shop expansion');
    assert.equal(payload.variantData.variants[1].soldCount, undefined, 'no anchor Seller metrics copied into siblings');
    assert.deepEqual(detailReads, ['1001', '1002', '1003'], 'each detail is parsed once, including the entry seed');
    assert.deepEqual(requests, ['1001', '1002', '1003'], 'reuse discovery pages while preserving every SKU detail, checkpoint and export');
`));

for (const entrypoint of ['category', 'link']) {
    for (const captureScope of ['CURRENT', 'ALL']) {
        test(entrypoint + ' ' + captureScope + ' preserves own-SKU media through checkpoints, result upload and collect-box preparation', () => probe(`
            const { addSelectedCollectorItemsToCollectBox } = await import(${JSON.stringify(new URL('../../server/collector-selection-service.mjs', import.meta.url).href)});
            const { prepareCollectRequestV4 } = await import(${JSON.stringify(new URL('../../server/collection-pipeline.mjs', import.meta.url).href)});
            const { buildCollectItemDraftV4 } = await import(${JSON.stringify(new URL('../../server/listing-pipeline.mjs', import.meta.url).href)});
            const c = collection('run', { targetCount: 1, captureScope: ${JSON.stringify(captureScope)} });
            const seed = entry('1001');
            globalThis.__SELLER_ANALYTICS_ITEMS__ = [seed];
            await c.${entrypoint === 'category' ? 'categoryProcess' : 'processData'}([seed]);
            await c.waitForAllTasks();
            const qualified = saved.filter(row => row.status === 'QUALIFIED');
            assert.equal(qualified.length, 1);
            const source = qualified[0];
            const mediaRows = ${JSON.stringify(captureScope)} === 'ALL' ? source.rawPayload.variantData.variants : [source.rawPayload];
            assert.equal(mediaRows.length, ${captureScope === 'ALL' ? 3 : 1});
            for (const row of [...mediaRows, ...checkpoints, ...exports]) {
                const sku = String(row.sku || row.id);
                assert.equal(row.color_image, 'https://cdn.test/' + sku + '-swatch.jpg');
                assert.equal(row.videoCoverUrl, 'https://cdn.test/' + sku + '-cover.mov');
                assert.deepEqual(row.videos, [{ url: 'https://cdn.test/' + sku + '.mp4', coverUrl: 'https://cdn.test/' + sku + '-poster.jpg' }]);
                assert.equal(row.description, '<p>Описание ' + sku + '</p>');
                assert.equal(JSON.parse(row.richContent).content[0].blocks[0].text, 'Описание ' + sku);
                assert.equal(row.images.length, 2);
                for (const field of ['description', 'richContent', 'videos', 'color_image', 'videoCoverUrl']) assert.equal(row.contentDiagnostics?.[field]?.status, 'provided', field);
            }
            let prepared;
            const selected = await addSelectedCollectorItemsToCollectBox({ accountId: 'test-account', runId: 'run', itemIds: ['result-one'] }, {
                getCollectorRunForAccount: async () => ({ id: 'run' }),
                listCollectorRunItems: async () => [{ ...source, id: 'result-one' }],
                ingestCollectRequestV4: async request => { prepared = prepareCollectRequestV4(request); return { collectItemId: prepared.collectId, requestId: prepared.persistedRequestId }; },
                linkCollectorItem: async () => {},
            });
            assert.equal(selected.added, 1, JSON.stringify(selected.errors));
            const draft = buildCollectItemDraftV4(prepared.normalizedItem);
            assert.equal(draft.color_image, 'https://cdn.test/1001-swatch.jpg');
            assert.equal(draft.videoCoverUrl, 'https://cdn.test/1001-cover.mov');
            assert.deepEqual(draft.contentDiagnostics, source.rawPayload.contentDiagnostics);
            for (const row of prepared.normalizedItem.variantData?.variants || []) {
                assert.equal(row.color_image, 'https://cdn.test/' + row.sku + '-swatch.jpg');
                assert.equal(row.videoCoverUrl, 'https://cdn.test/' + row.sku + '-cover.mov');
                assert.equal(row.contentDiagnostics.videoCoverUrl.status, 'provided');
            }
        `));
    }
}

test('different candidate positions and entry order claim one group before sibling detail capture', () => probe(`
    allRatingsPass = true; const c = collection();
    await c.categoryProcess([entry('1003'), entry('1001'), entry('1002')]);
    assert.equal(saved.filter(item => item.status === 'QUALIFIED').length, 1);
    assert.equal(c.targetData, 1); assert.equal(exports.length, 3);
    assert.equal(new Set(checkpoints.map(row => row.sku)).size, 3);
    const before = checkpoints.length, next = collection('other-run');
    await next.categoryProcess([entry('1002')]);
    assert.equal(next.targetData, 0); assert.equal(checkpoints.length, before);
`));

test('a legacy CURRENT owner is skipped when the group claim has no durable group ID yet', () => probe(`
    const server = globalThis.__DESKTOP_AXIOS_HANDLER__;
    globalThis.__DESKTOP_AXIOS_HANDLER__ = request => request.url.endsWith('/product-groups/claim')
        ? { data: { groupId: '', status: 'COLLECTING', skus: request.data.skus, cachedVariants: [] } } : server(request);
    const c = collection(); await c.categoryProcess([entry('1001')]);
    assert.equal(c.targetData, 0); assert.equal(c.dedup.collecting, 1); assert.equal(checkpoints.length, 0);
`));

test('the server known member union is completed using own SKU links even when the current page omits a descriptor', () => probe(`
    hiddenDescriptor = '1003'; const c = collection(); await c.categoryProcess([entry('1001')]);
    const variants = saved.find(row => row.status === 'QUALIFIED').rawPayload.variantData;
    assert.deepEqual(variants.expectedSkus, ['1001', '1002', '1003']);
    const recovered = variants.variants.find(row => row.sku === '1003');
    assert.equal(recovered.link, 'https://www.ozon.ru/product/1003/');
    assert.ok(recovered.images.every(url => url.includes('1003')));
    assert.deepEqual(detailReads, ['1001', '1002', '1003']);
    assert.deepEqual(requests, ['1001', '1002', '1003']);
`));

test('partial failures checkpoint good siblings and a later run captures only missing details after rediscovery', () => probe(`
    unavailable = '1002'; const c = collection();
    await c.categoryProcess([entry('1001')]);
    assert.equal(c.targetData, 0); assert.equal(saved.filter(row => row.status === 'QUALIFIED').length, 0);
    assert.deepEqual([...groups.get('group-1').variants.keys()], ['1001', '1003']);
    assert.deepEqual(released, ['group-1']);
    assert.ok(saved.some(row => row.status === 'FAILED' && row.sourceSku === '1001' && /1002/.test(row.errorMessage)));
    unavailable = ''; requests.length = 0; detailReads.length = 0; const next = collection('retry');
    await next.categoryProcess([entry('1001')]);
    assert.deepEqual(detailReads, ['1001', '1002'], 'checkpointed sibling details are not captured again');
    assert.deepEqual(requests, ['1001', '1002', '1003'], 'rediscover the group, then reuse the missing sibling page');
    assert.equal(next.targetData, 1); assert.equal(exports.length, 3);
`));

test('a broken group does not block a later unrelated qualifying group', () => probe(`
    unavailable = '1002'; const c = collection();
    await c.categoryProcess([entry('1001'), entry('2001')]);
    assert.deepEqual(saved.filter(row => row.status === 'QUALIFIED').map(row => row.sourceKey), ['group-2']);
    assert.equal(c.targetData, 1); assert.equal(c.detailFailure, null);
`));

test('three siblings missing product data remain a group failure and do not pause other groups as a network outage', () => probe(`
    groupSize = 5; for (const sku of ['1002', '1003', '1004']) missingSkus.add(sku);
    const c = collection(); await c.categoryProcess([entry('1001')]);
    assert.equal(c.detailFailure, null); assert.equal(c.targetData, 0);
    assert.deepEqual([...groups.get('group-1').variants.keys()], ['1001', '1005']);
    await c.categoryProcess([entry('2001')]);
    assert.equal(c.targetData, 1); assert.equal(exports.length, 5);
`));

test('sequential siblings use the existing two-slot request concurrency', () => probe(`
    const c = collection();
    await c.categoryProcess([entry('1001'), entry('2001')]);
    assert.equal(c.targetData, 2); assert.equal(checkpoints.length, 6);
    assert.equal(maxActive, 2); assert.equal(exports.length, 6);
`));

test('legacy frozen runs stay CURRENT even if the editable task now defaults to ALL', () => probe(`
    const c = collection(); c.preparedRun = { configurationSnapshot: { configuration: {} } };
    await c.categoryProcess([entry('1001')]);
    assert.equal(groups.size, 0); assert.equal(c.targetData, 1); assert.equal(exports.length, 1);
    assert.equal(saved[0].sourceKey, '1001');
`));

test('resuming a saved whole product restores one result and all exported SKU rows', () => probe(`
    const c = collection(); await c.categoryProcess([entry('1001')]);
    exports.length = 0;
    const restored = collection(); await restored.restoreSavedResults({ progress: { qualifiedCount: 1 } });
    assert.equal(restored.targetData, 1); assert.ok(restored.goodsData.has('group-1'));
    assert.deepEqual(exports.map(row => row.sku), ['1001', '1002', '1003']);
`));

test('cancellation after a checkpoint releases the original group lease without qualifying a partial product', () => probe(`
    const c = collection(), server = globalThis.__DESKTOP_AXIOS_HANDLER__;
    globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
        const response = await server(request);
        if (request.url.endsWith('/variants')) {
            c.reason = 'cancel'; c.cancellationController.abort(); c.runId = ''; c.leaseToken = '';
        }
        return response;
    };
    await assert.rejects(c.categoryProcess([entry('1001')]), error => error.name === 'AbortError');
    assert.equal(saved.filter(item => item.status === 'QUALIFIED').length, 0);
    assert.equal(checkpoints.length, 1); assert.deepEqual(released, ['group-1']);
`));

test('reaching the product target still waits for in-flight group capture to settle', () => probe(`
    const c = collection('run', { targetCount: 1 }); c.targetData = 1;
    c.taskQueueService.activeTasks = 1; c.activeGroupIds.add('group-1');
    let settled = false; const waiting = c.waitForAllTasks().then(() => { settled = true; });
    await new Promise(setImmediate); assert.equal(settled, false, 'do not close the shared window during another group request');
    c.taskQueueService.activeTasks = 0; c.activeGroupIds.clear(); await waiting;
`));

 test('large groups bound page reuse and still collect all 40 own-SKU details', () => probe(`
    groupSize = 40; const c = collection(); await c.categoryProcess([entry('1001')]);
    assert.equal(exports.length, 40); assert.equal(checkpoints.length, 40);
    assert.equal(requests.length, 47, '40 first reads plus 7 outside the 32-page reuse window');
    for (const row of exports) assert.ok(row.images.every(url => url.includes(row.sku)));
`));

test('an incomplete reused page retries through a fresh request and keeps complete SKU media', () => probe(`
    const c = collection();
    const request = c.mainWindowService.getOzonPageJson.bind(c.mainWindowService);
    let damaged = false;
    c.mainWindowService.getOzonPageJson = async url => {
        const response = await request(url);
        if (!damaged && new URL(url).searchParams.get('url') === '/product/1002/') {
            damaged = true; delete response.data.widgetStates.webGallery;
        }
        return response;
    };
    await c.categoryProcess([entry('1001')]);
    assert.equal(c.targetData, 1); assert.equal(checkpoints.length, 3);
    assert.equal(requests.filter(sku => sku === '1002').length, 2);
    assert.equal(exports.find(row => row.sku === '1002').images.length, 2);
`));

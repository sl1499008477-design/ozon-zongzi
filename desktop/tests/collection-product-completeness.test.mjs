import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSellerAnalyticsResponse } from '../dist-electron/services/seller-analytics.core.js';

const captured = JSON.parse(await readFile(new URL('./fixtures/ozon-puller-details.json', import.meta.url), 'utf8'));
const parseSource = await readFile(new URL('../dist-electron/services/collection/parse.services.js', import.meta.url), 'utf8');
const windowSource = await readFile(new URL('../dist-electron/services/collection/main-window.services.js', import.meta.url), 'utf8');
const context = { URL, log: { error() {}, warn() {} } };
const ParseService = vm.runInNewContext(parseSource.replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '') + '\nParseService', context);
const MainWindowService = vm.runInNewContext(windowSource.replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '') + '\nMainWindowService', context);
const initial = () => structuredClone(captured.initial);
const continuation = () => structuredClone(captured.continuation);
const seller = () => normalizeSellerAnalyticsResponse({ items: [{ sku: '3491634425', name: 'Съемник', photo: 'https://ir-20.ozonstatic.cn/s3/multimedia-1-c/10085720088.jpg', price: 598.14 }] }).items[0];
const plain = value => JSON.parse(JSON.stringify(value));
async function parse(widgetStates, goods = seller()) {
    const parser = new ParseService({ getSellingData: async () => ({ success: true, data: { widgetStates: {} } }) });
    return plain(await parser.ozonDetailParse({ success: true, data: { widgetStates } }, 'https://www.ozon.ru', goods));
}

// Captured product 3491634425: 9 gallery photos, 8 full characteristics and one set-contents row.
test('Seller thumbnail is enriched with the actual complete Puller gallery, characteristics, video and rich description', async () => {
    const service = new MainWindowService();
    const requests = [];
    service.getOzonPageJson = async target => {
        const path = new URL(target).searchParams.get('url');
        requests.push(path);
        assert.ok(requests.length <= 2, 'reviews and recommendations are outside product enrichment');
        return { success: true, data: path.includes('layout_container') ? continuation() : initial() };
    };
    const response = await service.getDataByApi('3491634425');
    const result = await parse(response.data.widgetStates);
    assert.equal(requests.length, 2);
    assert.equal(requests[0], '/product/3491634425/');
    assert.equal(requests[1], '/product/3491634425/?layout_container=pdpPage2column&layout_page_index=2');
    assert.deepEqual(result.images, [
        'https://ir-20.ozonstatic.cn/s3/multimedia-1-c/10085720088.jpg',
        'https://ir-20.ozonstatic.cn/s3/multimedia-1-i/8999647614.jpg',
        'https://ir-20.ozonstatic.cn/s3/multimedia-1-a/8999646598.jpg',
        'https://ir-20.ozonstatic.cn/s3/multimedia-1-h/8999646641.jpg',
        'https://ir-20.ozonstatic.cn/s3/multimedia-1-1/8999645509.jpg',
        'https://ir-20.ozonstatic.cn/s3/multimedia-1-0/8999646588.jpg',
        'https://ir-20.ozonstatic.cn/s3/multimedia-1-4/8999645440.jpg',
        'https://ir-20.ozonstatic.cn/s3/multimedia-1-f/8999645667.jpg',
        'https://ir-20.ozonstatic.cn/s3/multimedia-1-m/8999645422.jpg',
    ]);
    assert.equal(result.primaryImage, result.images[0]);
    assert.equal(result.cover, seller().photo);
    assert.equal(result.sourceCharacteristics.length, 9);
    assert.ok(result.sourceCharacteristics.some(row => row.name === 'Цвет' && row.value === 'Светло-серый'));
    assert.ok(result.sourceCharacteristics.some(row => row.name === 'Комплектация' && row.value === 'Съемник + упаковка в тканевый мешок + картонная упаковка'));
    assert.equal(result.description, undefined, 'set contents remains a characteristic instead of replacing the ordinary description');
    assert.equal(JSON.parse(result.richContent).content[0].blocks.length, 13);
    assert.deepEqual(result.videos, [{ url: 'https://v-1.ozone.ru/vod/video-25/01H8184SZGV5BXWV3PBTQD8VDH/asset_2_h264.mp4?type=pdp', coverUrl: 'https://ir-20.ozonstatic.cn/s3/video-25/01H8184SZGV5BXWV3PBTQD8VDH/cover/cover.jpg' }]);
    assert.equal(result.rating, 4.9);
    assert.equal(result.reviewCountLabel, 336);
    assert.equal(result.price, 598.14, 'market filters keep Seller RUB statistics');
    assert.equal(result.storefrontPrice.amount, '46.45');
    assert.equal(result.length, undefined, 'product length is not packaging length');
    assert.equal(result.width, undefined, 'product width is not packaging width');
});

test('dynamic object or JSON widget IDs preserve gallery and properties when the optional score widget is malformed', async () => {
    const widgets = initial().widgetStates;
    widgets['webSingleProductScore-obsolete'] = '{invalid';
    const galleryKey = Object.keys(widgets).find(key => key.startsWith('webGallery-'));
    widgets[galleryKey] = JSON.stringify(widgets[galleryKey]);
    const result = await parse(widgets);
    assert.equal(result.images.length, 9);
    assert.equal(result.sourceCharacteristics.length, 5);
    assert.equal(result.storefrontPrice.currencyCode, 'CNY');
    assert.equal(result.rating, 4.9);
});

test('preserves existing media and attributes when no newer product content was supplied', async () => {
    const goods = { ...seller(), images: ['https://cdn.test/existing.jpg'], sourceCharacteristics: [{ name: 'Материал', value: 'Металл' }] };
    const result = await parse({}, goods);
    assert.deepEqual(result.images, ['https://cdn.test/existing.jpg']);
    assert.deepEqual(result.sourceCharacteristics, [{ name: 'Материал', value: 'Металл' }]);
    assert.equal(result.rating, undefined);
    assert.equal(result.reviewCountLabel, undefined);
    assert.equal(result.sellerNumber, undefined);
});

test('collects one supplied photo without inventing extra images or claiming missing fields are complete', async () => {
    const result = await parse({ webGallery: { sku: '3491634425', images: ['https://cdn.test/one.jpg'] }, skuGrid: { images: ['https://cdn.test/recommended.jpg'] } });
    assert.deepEqual(result.images, ['https://cdn.test/one.jpg']);
    assert.equal(result.sourceCharacteristics, undefined);
    assert.equal(result.enrichment?.status, undefined);
});

test('public weight and explicit packaging dimensions fill only missing normalized filter fields', async () => {
    const widgets = { webCharacteristics: { characteristics: [{ short: [
        { name: 'Вес товара с упаковкой, кг', values: [{ text: '0,25' }] },
        { name: 'Длина упаковки, см', values: [{ text: '30' }] },
        { name: 'Ширина упаковки, мм', values: [{ text: '200' }] },
        { name: 'Высота упаковки, см', values: [{ text: '10' }] },
    ] }] } };
    const result = await parse(widgets, { ...seller(), weight: 400 });
    assert.equal(result.weight, 400, 'existing Seller weight is preserved');
    assert.equal(result.length, 300);
    assert.equal(result.width, 200);
    assert.equal(result.height, 100);
    assert.equal((await parse(widgets)).weight, 250);
    const unknownUnit = await parse({ webCharacteristics: { characteristics: [{ name: 'Вес товара с упаковкой', values: [{ text: '0,25' }] }] } });
    assert.equal(unknownUnit.weight, undefined);
});

for (const [name, change] of [
    ['another SKU in a continuation path', data => { data.widgetStates['paginator-658722-default-1'].nextPage = '/product/999/?layout_container=pdpPage2column&layout_page_index=2'; }],
    ['an external continuation path', data => { data.widgetStates['paginator-658722-default-1'].nextPage = 'https://other.test/product/3491634425/?layout_container=pdpPage2column'; }],
    ['a gallery from another SKU', data => { data.widgetStates['webGallery-3311626-default-1'].sku = '999'; }],
    ['a missing gallery', data => { delete data.widgetStates['webGallery-3311626-default-1']; }],
]) {
    test(name + ' fails explicitly before partial data can be saved', async () => {
        const data = initial(); change(data);
        const service = new MainWindowService();
        service.getOzonPageJson = async () => ({ success: true, data });
        await assert.rejects(service.getDataByApi('3491634425'), error => /^ZONGZI_(DETAIL_INCOMPLETE|RESPONSE_SKU_MISMATCH)$/.test(error.code));
    });
}

test('a failed characteristics continuation rejects with the original retryable error', async () => {
    const service = new MainWindowService();
    const failure = Object.assign(Error('Ozon detail HTTP 503'), { code: 'ZONGZI_HTTP_ERROR', status: 503 });
    service.getOzonPageJson = async target => {
        if (new URL(target).searchParams.get('url').includes('layout_container')) throw failure;
        return { success: true, data: initial() };
    };
    await assert.rejects(service.getDataByApi('3491634425'), error => error === failure);
});

test('a cyclic or unbounded product-detail paginator fails instead of silently returning a partial product', async () => {
    const service = new MainWindowService();
    let requests = 0;
    service.getOzonPageJson = async () => { requests++; return { success: true, data: initial() }; };
    await assert.rejects(service.getDataByApi('3491634425'), error => error.code === 'ZONGZI_DETAIL_INCOMPLETE');
    assert.ok(requests <= 5);
});

test('a successful but empty continuation cannot masquerade as complete product details', async () => {
    const service = new MainWindowService();
    service.getOzonPageJson = async target => ({ success: true, data: new URL(target).searchParams.get('url').includes('layout_container') ? { widgetStates: {} } : initial() });
    await assert.rejects(service.getDataByApi('3491634425'), error => error.code === 'ZONGZI_DETAIL_INCOMPLETE');
});

for (const firstPageComplete of [true, false]) {
    test('the longer same-SKU gallery survives a duplicate widget ID; firstPageComplete=' + firstPageComplete, async () => {
        const main = initial(), next = continuation();
        const key = 'webGallery-3311626-default-1';
        const full = structuredClone(main.widgetStates[key]);
        const short = { ...structuredClone(full), images: full.images.slice(0, 1) };
        main.widgetStates[key] = firstPageComplete ? full : short;
        next.widgetStates[key] = firstPageComplete ? short : full;
        const service = new MainWindowService();
        service.getOzonPageJson = async target => ({ success: true, data: new URL(target).searchParams.get('url').includes('layout_container') ? next : main });
        const response = await service.getDataByApi('3491634425');
        assert.equal((await parse(response.data.widgetStates)).images.length, 9);
    });
}

test('net product weight cannot become the package weight used by export and listing', async () => {
    const result = await parse({ webCharacteristics: { characteristics: [{ name: 'Вес товара, г', values: [{ text: '250' }] }] } });
    assert.equal(result.weight, undefined);
    assert.deepEqual(result.sourceCharacteristics, [{ name: 'Вес товара, г', value: '250' }]);
});

test('rich-text property values and empty Seller packaging fields retain available public evidence', async () => {
    const result = await parse({ webCharacteristics: { characteristics: [
        { title: { textRs: [{ content: 'Материал' }] }, values: [{ title: { textRs: [{ content: 'Металл' }] } }] },
        { name: 'Вес с упаковкой, г', values: [{ text: '300' }] },
    ] } }, { ...seller(), weight: '' });
    assert.equal(result.weight, 300);
    assert.ok(result.sourceCharacteristics.some(row => row.name === 'Материал' && row.value === 'Металл'));
});

test('complete captured product content survives real desktop persistence and collect-box draft preparation', () => {
    const profile = mkdtempSync(join(tmpdir(), 'ozon-completeness-'));
    const loader = fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url));
    const probe = `
        import assert from 'node:assert/strict';
        import { readFile } from 'node:fs/promises';
        import { Collection } from ${JSON.stringify(new URL('../dist-electron/services/collection/collection.services.js', import.meta.url).href)};
        import { addSelectedCollectorItemsToCollectBox } from ${JSON.stringify(new URL('../../server/collector-selection-service.mjs', import.meta.url).href)};
        import { prepareCollectRequestV4 } from ${JSON.stringify(new URL('../../server/collection-pipeline.mjs', import.meta.url).href)};
        import { buildCollectItemDraftV4 } from ${JSON.stringify(new URL('../../server/listing-pipeline.mjs', import.meta.url).href)};
        import { readAutoListingSourcePrice } from ${JSON.stringify(new URL('../../server/auto-listing-source-snapshot.mjs', import.meta.url).href)};
        import { aiListingItemPrice } from ${JSON.stringify(new URL('../../server/ai-listing-source-facts.mjs', import.meta.url).href)};
        const captured = JSON.parse(await readFile(${JSON.stringify(fileURLToPath(new URL('./fixtures/ozon-puller-details.json', import.meta.url)))}, 'utf8'));
        const saved = [], exported = [];
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            if (request.url.endsWith('/items')) saved.push(...request.data.items);
            else assert.ok(request.url.endsWith('/events'), request.url);
            return { data: { ok: true } };
        };
        const collection = new Collection({ _id: 'fixture-task', taskName: 'Product completeness', targetCount: 1, aiSelectType: 1 }, null);
        collection.runId = 'fixture-run'; collection.leaseToken = 'fixture-lease';
        collection.excelService.saveExcel = async items => { exported.push(...items); return true; };
        collection.excelService.getFilePath = async () => '';
        collection.mainWindowService.getDomain = async () => 'https://www.ozon.ru';
        collection.mainWindowService.getOzonPageJson = async target => ({ success: true, data: structuredClone(new URL(target).searchParams.get('url').includes('layout_container') ? captured.continuation : captured.initial) });
        collection.mainWindowService.getSellingData = async () => ({ success: true, data: { widgetStates: {} } });
        await collection.taskHandle(${JSON.stringify(seller())});
        assert.equal(saved.length, 1);
        assert.equal(saved[0].rawPayload.images.length, 9);
        assert.equal(saved[0].exportData.sourceCharacteristics.length, 9);
        assert.equal(exported[0].videos.length, 1);
        let prepared;
        const selection = await addSelectedCollectorItemsToCollectBox({ accountId: 'fixture-account', runId: 'fixture-run', itemIds: ['fixture-item'] }, {
            getCollectorRunForAccount: async () => ({ id: 'fixture-run' }),
            listCollectorRunItems: async () => [{ ...saved[0], id: 'fixture-item' }],
            ingestCollectRequestV4: async request => { prepared = prepareCollectRequestV4(request); return { collectItemId: prepared.collectId, requestId: prepared.persistedRequestId }; },
            linkCollectorItem: async () => {},
        });
        assert.equal(selection.added, 1, JSON.stringify(selection.errors));
        const draft = buildCollectItemDraftV4(prepared.normalizedItem);
        assert.equal(draft.images.length, 9);
        assert.equal(draft.sourceCharacteristics.length, 9);
        assert.equal(draft.videos.length, 1);
        assert.equal(JSON.parse(draft.richContent).content[0].blocks.length, 13);
        assert.equal(draft.price, '46.45');
        assert.equal(draft.currencyCode, 'CNY');
        assert.equal(saved[0].rawPayload.blackPrice, '46.45');
        assert.equal(saved[0].rawPayload.greenPrice, '43.58');
        const evidence = readAutoListingSourcePrice({ record: prepared.normalizedItem, fallback: draft, currencyContext: { targetStoreId: 'fixture-store', sourceTargetStoreId: 'fixture-store', targetStoreCurrency: 'CNY' } });
        assert.equal(evidence.blackKopecks, '4645'); assert.equal(evidence.greenKopecks, '4358');
        assert.equal(evidence.currency, 'CNY');
        const group = { sku: captured.sourceSku, listingItem: { price: draft.price, currency_code: draft.currencyCode } };
        const frozen = { sku: captured.sourceSku, sourceSnapshot: prepared.normalizedItem, items: [group] };
        const priced = aiListingItemPrice(frozen, group, { targetStoreId: 'fixture-store', priceMultiplier: '1', priceAdjustmentKopecks: 0 }, { currencyCode: 'CNY' });
        assert.equal(priced.pricing.branch, 'BLACK_LT_80');
        assert.equal(priced.pricing.realPriceKopecks, '4335');
        assert.equal(priced.pricing.finalPriceKopecks, '4335');
        assert.equal(aiListingItemPrice(frozen, group, { targetStoreId: 'fixture-store', priceMultiplier: '5', priceAdjustmentKopecks: -1000 }, { currencyCode: 'CNY' }).pricing.finalPriceKopecks, '16675');
        assert.throws(() => aiListingItemPrice(frozen, group, { targetStoreId: 'fixture-store', priceMultiplier: '1', priceAdjustmentKopecks: 0 }, { currencyCode: 'RUB' }), { code: 'AI_LISTING_CURRENCY_CONVERSION_REQUIRED' });

    `;
    try {
        const result = spawnSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', probe], { env: { ...process.env, DESKTOP_TEST_USER_DATA: profile }, encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally { rmSync(profile, { recursive: true, force: true }); }
});

test('malformed optional offers cannot discard a gallery and characteristics already read successfully', async () => {
    const parser = new ParseService({ getSellingData: async () => ({ success: true, data: { widgetStates: { 'webSellerList-new': { sellers: {} } } } }) });
    const result = await parser.ozonDetailParse({ success: true, data: initial() }, 'https://www.ozon.ru', seller());
    assert.equal(result.images?.length, 9);
    assert.equal(result.sourceCharacteristics?.length, 5);
    assert.equal(result.sellerNumber, undefined);
});

 test('reused own-SKU initial page still fetches full characteristics and media continuation', async () => {
    const service = new MainWindowService();
    const requests = [];
    service.getOzonPageJson = async target => {
        requests.push(new URL(target).searchParams.get('url'));
        return { success: true, data: continuation() };
    };
    const response = await service.getDataByApi('3491634425', { success: true, data: initial() });
    const result = await parse(response.data.widgetStates);
    assert.deepEqual(requests, ['/product/3491634425/?layout_container=pdpPage2column&layout_page_index=2']);
    assert.equal(result.images.length, 9);
    assert.equal(result.sourceCharacteristics.length, 9);
    assert.equal(result.videos.length, 1);
});

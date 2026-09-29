import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeSellerAnalyticsItem } from '../dist-electron/services/seller-analytics.core.js';
import { normalizeCollectorTask, toCollectorTaskPayload } from '../dist-electron/services/collector-contract.core.js';
const source = readFileSync(new URL('../dist-electron/services/collection/data-filter.services.js', import.meta.url), 'utf8');
const DataProcessService = vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace('export class', 'class') + '\nDataProcessService');
const realMetrics = JSON.parse(readFileSync(new URL('./fixtures/selection-real-metrics.json', import.meta.url), 'utf8'));

test('new price bounds wait for the detail and compare only the CNY black price', async () => {
    const service = new DataProcessService();
    const task = normalizeCollectorTask({ id: 'new-task', ...toCollectorTaskPayload({
        aiSelectType: 1, salePriceBasis: 'storefrontCny', salePriceMin: 100, salePriceMax: 150,
    }) });
    const rows = [
        { id: 'black-in-range', sellerAnalyticsPriceRub: 1541.268, storefrontPrice: { ordinaryAmount: '128.91', amount: '128.91', bankAmount: '99', currencyCode: 'CNY' } },
        { id: 'seller-only-in-range', sellerAnalyticsPriceRub: 120, storefrontPrice: { ordinaryAmount: '200', amount: '200', bankAmount: '120', currencyCode: 'CNY' } },
        { id: 'lower-bound', sellerAnalyticsPriceRub: 999, storefrontPrice: { ordinaryAmount: '100', currencyCode: 'CNY' } },
        { id: 'upper-bound', sellerAnalyticsPriceRub: 999, storefrontPrice: { ordinaryAmount: '150', currencyCode: 'CNY' } },
    ];
    assert.deepEqual(Array.from(await service.filterData(rows, task, 'base'), row => row.id), rows.map(row => row.id));
    for (const phase of ['detail', 'merge']) {
        assert.deepEqual(Array.from(await service.filterData(rows, task, phase), row => row.id), ['black-in-range', 'lower-bound', 'upper-bound']);
    }
    for (const storefrontPrice of [null, { amount: '120', bankAmount: '120', currencyCode: 'CNY' },
        { ordinaryAmount: '120', currencyCode: 'RUB' }, { ordinaryAmount: '120' },
        { ordinaryAmount: '', currencyCode: 'CNY' }]) {
        assert.equal((await service.filterData([{ sellerAnalyticsPriceRub: 120, storefrontPrice }], task, 'detail')).length, 0);
        assert.ok(service.missingFields.has('前台黑标价（¥）'));
    }
    assert.equal((await service.filterData([{}], { salePriceBasis: 'storefrontCny' }, 'detail')).length, 1);
});

// Literal UI-to-metric contract. Every range is inclusive, and missing evidence is not zero.
const ranges = [
    ['soldCount', 'soldCount', 10], ['gmvSum', 'gmvSum', 1000],
    ['salePrice', 'sellerAnalyticsPriceRub', 1000], ['upGoodsTime', 'releaseDate', 10],
    ['monthDynamics', 'salesDynamics', 150], ['adFee', 'drr', 10],
    ['promotionDay', 'daysInPromo', 10], ['promotionDiscount', 'discount', 10],
    ['promotionDynamics', 'promoRevenueShare', 10], ['promoteDay', 'daysWithTrafarets', 10],
    ['views', 'sessionCount', 1000], ['cardRate', 'convToCartPdp', 10],
    ['showRate', 'convToCartSearch', 10], ['clickRate', 'clickRate', 10],
    ['nullableRedemptionRate', 'nullableRedemptionRate', 90], ['returnCancelRate', 'returnCancelRate', 10],
    ['weightRange', 'weight', 500], ['packageLength', 'length', 100],
    ['packageHeight', 'height', 100], ['packageWidth', 'width', 100],
    ['follow', 'sellerNumber', 10], ['numberOfComments', 'reviewCountLabel', 10], ['rating', 'rating', 4],
];
for (const [condition, field, boundary] of ranges) {
    test(condition + ' survives task round-trip and filters inclusive bounds without inventing missing values', async () => {
        const service = new DataProcessService();
        const payload = toCollectorTaskPayload({ taskName: 'selection fixture', aiSelectType: 1, [condition + 'Min']: boundary, [condition + 'Max']: boundary });
        const task = normalizeCollectorTask({ id: 'task', ...JSON.parse(JSON.stringify(payload)) });
        const exact = { id: 'exact', [field]: boundary };
        const result = await service.filterData([exact, { id: 'below', [field]: boundary - 0.1 }, { id: 'above', [field]: boundary + 0.1 }], task);
        assert.deepEqual(Array.from(result, item => item.id), ['exact']);
        for (const unknown of [undefined, null, '', ' ', NaN, Infinity, false]) {
            assert.equal((await service.filterData([{ [field]: unknown }], { [condition + 'Max']: boundary })).length, 0, condition + ' must reject unknown ' + String(unknown));
        }
        assert.equal((await service.filterData([{ [field]: 0 }], { [condition + 'Max']: 0 })).length, 1);
        assert.equal((await service.filterData([{ [field]: 0.01 }], { [condition + 'Max']: 0 })).length, 0);
        assert.equal((await service.filterData([{}], { [condition + 'Min']: null })).length, 1);
    });
}

test('branding and shipping require source evidence and match complete shipping modes', async () => {
    const service = new DataProcessService();
    const rows = [{ id: 'unknown' }, { id: 'none', brand: '', salesSchema: 'FBS' }, { id: 'brand', brand: 'Brand', salesSchema: 'FBO,FBS' }];
    assert.deepEqual(Array.from(await service.filterData(rows, { brandType: '1' }), item => item.id), ['none']);
    assert.deepEqual(Array.from(await service.filterData(rows, { brandType: '0' }), item => item.id), ['brand']);
    assert.deepEqual(Array.from(await service.filterData(rows, { brandType: '2' }), item => item.id), ['unknown', 'none', 'brand']);
    assert.deepEqual(Array.from(await service.filterData(rows, { salesSchema: 'FBO' }), item => item.id), ['brand']);
    assert.equal((await service.filterData([{ salesSchema: 'F' }], { salesSchema: 'FBO,FBS' })).length, 0);
});

test('Seller normalization derives the same precise metrics for category and URL collection', () => {
    const row = normalizeSellerAnalyticsItem({ Sku: 1, Price: 42, AvgGmv: 1200, QtyViewPdp: '90', Views: '1000', PdpToCartConversion: 6.5, NullableRedemptionRate: 90.4, Brand: 'Без бренда', Weight: 500, Length: 100, Width: 90, Height: 80 });
    assert.equal(row.sellerAnalyticsPriceRub, 1200);
    assert.equal(row.price, 1200);
    assert.equal(row.clickRate, 9);
    assert.equal(row.convToCartPdp, 6.5);
    assert.equal(row.returnCancelRate, 9.6);
    assert.equal(row.brand, '');
    assert.equal(row.weight, 500);
    assert.equal(row.length, 100);
    assert.equal(row.width, 90);
    assert.equal(row.height, 80);
    assert.equal(normalizeSellerAnalyticsItem({ sku: 2 }).releaseDate, undefined, 'a missing creation date cannot become today');
    assert.equal(normalizeSellerAnalyticsItem({ sku: 2, qtyViewPdp: 1, sessionCount: 2 }).clickRate, undefined, 'session count is not an invented denominator for impressions');
    assert.equal(normalizeSellerAnalyticsItem({ sku: 2, qtyViewPdp: 0, views: 0 }).clickRate, undefined, 'zero impressions has no defined click rate');
});

test('AI rules use RUB tiers and evaluate follower evidence only after detail', async () => {
    const service = new DataProcessService();
    const item = { sellerAnalyticsPriceRub: 1541.268, price: '128.91', currencyCode: 'CNY', releaseDate: 10, salesDynamics: 2, drr: 5, soldCount: 31 };
    assert.equal((await service.aiFilterData([item], 'base')).length, 1);
    assert.equal((await service.aiFilterData([item], 'detail')).length, 0);
    assert.equal((await service.aiFilterData([{ ...item, sellerNumber: 30 }])).length, 1);
    assert.equal((await service.aiFilterData([{ ...item, sellerNumber: 31 }])).length, 0);
    assert.equal((await service.aiFilterData([{ ...item, sellerNumber: 1, soldCount: 30 }])).length, 0);
    assert.equal((await service.aiFilterData([{ ...item, sellerAnalyticsPriceRub: undefined, sellerNumber: 1 }])).length, 0, 'CNY public prices must never select a RUB tier');
});

test('real persisted Seller metrics replay meaningful conditions independently from CNY display prices', async () => {
    const service = new DataProcessService();
    const rows = realMetrics.map(row => ({ ...normalizeSellerAnalyticsItem(row), price: row.price }));
    const cases = [
        [{ salePriceMin: 500, salePriceMax: 600 }, ['3491634425']],
        [{ monthDynamicsMin: 700 }, ['4872936496']],
        [{ returnCancelRateMax: 10 }, ['3491634425', '4872936496', '982038605']],
        [{ clickRateMin: 4, clickRateMax: 5 }, ['3491634425', '4872936496']],
        [{ soldCountMax: 100 }, ['4872936496', '982038605']],
        [{ gmvSumMin: 100000 }, ['3491634425', '5022769881']],
        [{ brandType: '1' }, ['3491634425', '4872936496', '5022769881']],
        [{ salesSchema: 'FBO' }, ['3491634425']],
        [{ weightRangeMax: 1000 }, []],
    ];
    for (const [task, expected] of cases) assert.deepEqual(Array.from(await service.filterData(rows, task), item => item.sku), expected, JSON.stringify(task));
});

const loader = fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url));
const collectionUrl = new URL('../dist-electron/services/collection/collection.services.js', import.meta.url).href;
const analyticsUrl = new URL('../dist-electron/services/seller-analytics.core.js', import.meta.url).href;
for (const mode of ['category', 'url']) {
    test(mode + ' new-task price filtering parses public prices before qualifying and saving the same SKU', () => {
        const profile = mkdtempSync(join(tmpdir(), 'selection-black-price-'));
        try {
            const result = spawnSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', `
                import assert from 'node:assert/strict';
                import { readFileSync } from 'node:fs';
                import { Collection } from ${JSON.stringify(collectionUrl)};
                import { normalizeSellerAnalyticsItem } from ${JSON.stringify(analyticsUrl)};
                const fixture=JSON.parse(readFileSync(${JSON.stringify(fileURLToPath(new URL('./fixtures/ozon-storefront-cny.json', import.meta.url)))},'utf8'));
                const saved=[],fetched=[],exported=[];
                globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
                    if(request.url.endsWith('/skus/claim'))return {data:{items:request.data.skus.map(sku=>({sku,state:'CLAIMED'}))}};
                    if(request.url.endsWith('/items'))saved.push(...request.data.items);
                    return {data:{ok:true}};
                };
                const collection=new Collection({_id:'fixture',taskName:'人民币黑标价',aiSelectType:1,captureScope:'CURRENT',targetCount:10,salePriceBasis:'storefrontCny',salePriceMin:128,salePriceMax:130},null);
                collection.runId='run';collection.leaseToken='lease';
                collection.excelService.saveExcel=async rows=>{exported.push(...rows);return true};
                collection.excelService.getFilePath=async()=>'';
                collection.mainWindowService.getDomain=async()=>'https://www.ozon.ru';
                collection.mainWindowService.getSellingData=async()=>({success:true,data:{widgetStates:{}}});
                const skus=['1508194124','1508194125','1508194126','1508194127','1508194128'];
                const widgets=[null,{price:'200 ¥',cardPrice:'128,91 ¥'},{cardPrice:'128,91 ¥'},{price:'128,91 ₽'},{}];
                collection.mainWindowService.getDataByApi=async sku=>{
                    fetched.push(String(sku));
                    const data=structuredClone(fixture),widget=widgets[skus.indexOf(String(sku))];
                    if(widget)data.widgetStates['webPrice-3121879-default-1']=JSON.stringify(widget);
                    return {success:true,data};
                };
                const source=skus.map((sku,index)=>normalizeSellerAnalyticsItem({sku,name:'Бумага',price:index?128.91:1541.268,soldCount:60}));
                globalThis.__SELLER_ANALYTICS_ITEMS__=source;
                if(${JSON.stringify(mode)}==='category')await collection.categoryProcess(source);
                else await collection.processData(source.map(({id})=>({id})));
                await collection.flushRunEvents();
                assert.deepEqual(fetched.sort(),skus);
                const qualified=saved.filter(row=>row.status==='QUALIFIED');
                assert.deepEqual(qualified.map(row=>row.sourceSku),['1508194124']);
                assert.equal(saved.filter(row=>row.status==='FILTERED_OUT').length,4);
                assert.equal(qualified[0].rawPayload.blackPrice,'128.91');
                assert.equal(qualified[0].rawPayload.currencyCode,'CNY');
                assert.equal(qualified[0].rawPayload.sellerAnalyticsPriceRub,1541.268);
                assert.equal(exported.length,1);
                assert.equal(exported[0].blackPrice,'128.91');
            `], { encoding: 'utf8', timeout: 15000, env: { ...process.env, DESKTOP_TEST_USER_DATA: profile } });
            assert.equal(result.status, 0, result.stderr || result.stdout);
        } finally { rmSync(profile, { recursive: true, force: true }); }
    });
}

for (const mode of ['category', 'url']) for (const aiSelectType of [0, 1]) {
    test(mode + ' mode ' + aiSelectType + ' qualifies passing items and records rejected detail outcomes', () => {
        const profile = mkdtempSync(join(tmpdir(), 'selection-pipeline-'));
        try {
            const result = spawnSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', `
                import assert from 'node:assert/strict';
                import { Collection } from ${JSON.stringify(collectionUrl)};
                import { normalizeSellerAnalyticsItem } from ${JSON.stringify(analyticsUrl)};
                const saved = [], released = [], fetched = [], logs = [];
                globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
                    if (request.url.endsWith('/skus/claim')) return { data: { items: request.data.skus.map(sku => ({ sku, state: 'CLAIMED' })) } };
                    if (request.url.endsWith('/skus/release')) released.push(...request.data.skus);
                    if (request.url.endsWith('/items')) saved.push(...request.data.items);
                    if (request.url.endsWith('/events')) logs.push(request.data.message);
                    return { data: { ok: true } };
                };
                const collection = new Collection({ _id: 'fixture', taskName: 'selection', aiSelectType: ${aiSelectType}, targetCount: 10, weightRangeMin: 400, weightRangeMax: 600, ratingMin: 4, salePriceMin: 1000, salePriceMax: 2000 }, null);
                collection.runId = 'run'; collection.leaseToken = 'lease';
                collection.excelService.saveExcel = async () => true;
                collection.excelService.getFilePath = async () => '';
                const source = ['pass', 'reject', 'missing'].map(id => normalizeSellerAnalyticsItem({ sku: id, price: 1541.268, soldCount: 60, salesDynamics: 2, drr: 5, releaseDate: 10 }));
                globalThis.__SELLER_ANALYTICS_ITEMS__ = source;
                collection.getHtmlDetailData = async item => {
                    fetched.push(item.id);
                    return { ...item, storefrontPrice: { amount: '128.91', currencyCode: 'CNY' }, ...(item.id === 'missing' ? {} : { weight: item.id === 'pass' ? 500 : 800, rating: item.id === 'pass' ? 4.5 : 3, sellerNumber: item.id === 'pass' ? 2 : 31 }) };
                };
                if (${JSON.stringify(mode)} === 'category') await collection.categoryProcess(source);
                else await collection.processData(source.map(({ id }) => ({ id, price: 128.91 })));
                await collection.flushRunEvents();
                assert.deepEqual(fetched.sort(), ['missing', 'pass', 'reject'], 'detail-dependent rules must wait for detail');
                const qualified = saved.filter(item => item.status === 'QUALIFIED');
                const filtered = saved.filter(item => item.status === 'FILTERED_OUT');
                assert.deepEqual(qualified.map(item => item.sourceSku), ['pass'], 'both entry points must enforce the selected rules');
                assert.deepEqual(filtered.map(item => item.sourceSku).sort(), ['missing', 'reject']);
                assert.ok(filtered.every(item => item.filterResult.accepted === false && item.filterResult.reason === 'DETAIL_FILTERED'));
                assert.deepEqual(collection.outcomes, { skipped: 2, failed: 0 });
                assert.deepEqual(released.sort(), ['missing', 'reject']);
                if (${JSON.stringify(mode)} === 'url') {
                    assert.ok(logs.some(message => message.includes('商品 missing 未通过详情筛选') && message.includes('缺少')));
                    assert.ok(logs.some(message => message === '商品 reject 未通过详情筛选'), 'concurrent missing fields cannot contaminate another SKU diagnostic');
                }
                assert.equal(qualified[0].rawPayload.currencyCode, 'CNY');
                assert.equal(qualified[0].rawPayload.price, '128.91');
                assert.equal(qualified[0].rawPayload.sellerAnalyticsPriceRub, 1541.268);
            `], { encoding: 'utf8', timeout: 15000, env: { ...process.env, DESKTOP_TEST_USER_DATA: profile } });
            assert.equal(result.status, 0, result.stderr || result.stdout);
        } finally { rmSync(profile, { recursive: true, force: true }); }
    });
}


test('default mode uses only its visible preset even when an old task retained hidden custom bounds', async () => {
    const service = new DataProcessService();
    const row = { soldCount: 50, salesDynamics: 10, sellerNumber: 30, rating: 4, salesSchema: 'FBS' };
    const task = { aiSelectType: 2, soldCountMin: 1, monthDynamicsMin: 0, followMax: 999, ratingMin: 0, weightRangeMin: 999, salePriceMax: 0, returnCancelRateMax: 0 };
    assert.equal((await service.filterData([row], task)).length, 1);
    for (const change of [{ soldCount: 49 }, { salesDynamics: 9.9 }, { sellerNumber: 31 }, { rating: 3.9 }, { salesSchema: 'RFBS' }])
        assert.equal((await service.filterData([{ ...row, ...change }], task)).length, 0);
});

test('an incomplete URL detail records its SKU and fails the run instead of completing with zero collected items', () => {
    const profile = mkdtempSync(join(tmpdir(), 'selection-detail-failure-'));
    try {
        const result = spawnSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import { Collection } from ${JSON.stringify(collectionUrl)};
            import { normalizeSellerAnalyticsItem } from ${JSON.stringify(analyticsUrl)};
            const saved = [], failures = [], completed = [], logs = [];
            globalThis.__SELLER_CONTEXT__ = { accountId: 'fixture', source: 'ozon_seller_analytics', sourceIdentity: 'fixture' };
            globalThis.__SELLER_ANALYTICS_ITEMS__ = [normalizeSellerAnalyticsItem({ sku: '123456', price: 100, soldCount: 1 })];
            globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
                if (request.url.endsWith('/runs')) return { data: { run: { id: 'run' } } };
                if (request.url.endsWith('/claim')) return { data: { run: { id: 'run' }, leaseToken: 'lease' } };
                if (request.url.endsWith('/items')) saved.push(...request.data.items);
                if (request.url.endsWith('/fail')) failures.push(request.data);
                if (request.url.endsWith('/complete')) completed.push(request.data);
                if (request.url.endsWith('/events')) logs.push(request.data.message);
                return { data: { ok: true } };
            };
            const collection = new Collection({ _id: 'task', taskName: 'detail failure', aiSelectType: 1, isUseCategorySelect: 1, targetCount: 1 }, null);
            collection.excelService.DeleteFilled = async () => {};
            collection.excelService.saveExcel = async () => true;
            collection.excelService.getFilePath = async () => '';
            collection.mainWindowService.createCollectionWindow = async () => {};
            collection.mainWindowService.getDataByApi = async () => ({ success: true, data: { widgetStates: { 'webGallery-broken-fixture': '{' } } });
            collection.mainWindowService.getDomain = async () => 'https://www.ozon.ru';
            collection.parseService.getDataCount = () => 1;
            collection.expendShop = async () => {};
            collection.getHtmlData = async () => { await collection.processData([{ id: '123456' }]); collection.reason = 'success'; };
            await collection.run();
            assert.equal(collection.task.taskStatus, 'failed');
            assert.equal(collection.taskQueueService.getFailedTasksCount(), 0);
            assert.equal(saved.length, 1);
            assert.equal(saved[0].status, 'FAILED');
            assert.equal(saved[0].sourceSku, '123456');
            assert.equal(saved[0].errorCode, 'ZONGZI_DETAIL_INCOMPLETE');
            assert.equal(completed.length, 0);
            assert.equal(failures.length, 1);
            assert.equal(failures[0].errorCode, 'COLLECTION_NO_VALID_PRODUCTS');
            assert.ok(logs.some(message => message.includes('123456') && message.includes('未采集')));
        `], { encoding: 'utf8', timeout: 15000, env: { ...process.env, DESKTOP_TEST_USER_DATA: profile } });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally { rmSync(profile, { recursive: true, force: true }); }
});


test('date-only Seller creation dates use the desktop calendar day around local midnight', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-14T00:30:00+08:00').getTime() });
    try {
        assert.equal(normalizeSellerAnalyticsItem({ sku: 1, nullableCreateDate: '2026-09-13' }).releaseDate, 1);
        assert.equal(normalizeSellerAnalyticsItem({ sku: 1, nullableCreateDate: '2026-09-14' }).releaseDate, 0);
        assert.equal(normalizeSellerAnalyticsItem({ sku: 1, nullableCreateDate: 'invalid' }).releaseDate, undefined);
    } finally {
        mock.timers.reset();
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const collectionUrl = new URL('../dist-electron/services/collection/collection.services.js', import.meta.url).href;
const logUrl = new URL('../dist-electron/log/index.js', import.meta.url).href;
const loader = fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url));

function runCollectionProbe(probe) {
    const profile = mkdtempSync(join(tmpdir(), 'sonli-collection-result-'));
    try {
        const result = spawnSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import { Collection } from ${JSON.stringify(collectionUrl)};
            ${probe}
        `], {
            env: { ...process.env, DESKTOP_TEST_USER_DATA: profile },
            encoding: 'utf8',
            timeout: 15000,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    finally {
        rmSync(profile, { recursive: true, force: true });
    }
}

test('legacy pricing settings do not prevent a direct Ozon collection from being persisted and completed', () => {
    runCollectionProbe(`
        const items = [], events = [], summaries = [], exported = [], starts = [], forbidden = [];
        globalThis.__SELLER_CONTEXT__ = { accountId: 'fixture', source: 'ozon_seller_analytics', sourceIdentity: 'seller-page:fixture' };
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            if (request.url.includes('pricing')) { forbidden.push(request.url); throw Error('pricing is removed'); }
            if (request.url.endsWith('/runs')) { starts.push(request.data); return { data: { run: { id: 'fixture-run', status: 'QUEUED' } } }; }
            if (request.url.endsWith('/claim')) return { data: { run: { id: 'fixture-run' }, leaseToken: 'fixture-lease' } };
            if (request.url.endsWith('/items')) items.push(...request.data.items);
            else if (request.url.endsWith('/events')) events.push(request.data);
            else if (request.url.endsWith('/complete')) summaries.push(request.data.resultSummary);
            else assert.ok(request.url.endsWith('/heartbeat') || request.url.endsWith('/fail'), request.url);
            return { data: { ok: true } };
        };
        const legacy = { pricingConfigVersionId: 'retired-version', upMode: 2, sourceType: '1', myProfitPercent: 999, rubExpressPrice: 999, internalExpress: 'retired-logistics' };
        const collection = new Collection({ _id: 'fixture-task', taskName: 'Ozon only fixture', isUseCategorySelect: 1, aiSelectType: 1, targetCount: 1, salePriceMin: 100, salePriceMax: 1000, ...legacy }, null);
        // Trap the former external step while exercising the actual Collection caller.
        collection.windowService = { createWindow: async () => { forbidden.push('1688'); throw Error('1688 is removed'); } };
        collection.parseService.getDataCount = () => 60;
        collection.excelService.DeleteFilled = async () => {};
        collection.excelService.saveExcel = async data => { exported.push(...data); return true; };
        collection.excelService.flushToDisk = async () => true;
        collection.excelService.getFilePath = async () => '';
        collection.mainWindowService.createCollectionWindow = async () => {};
        collection.expendShop = async () => {};
        const sample = { id: '1508194124', nameLabel: 'Ozon paper sample', price: 555.35, storefrontPrice: { amount: '128.91', currencyCode: 'CNY', source: 'ozon-web-price' }, soldCount: 60, weight: 500, length: 300, width: 210, height: 10, cover: 'https://ir-20.ozonstatic.cn/fixture.png', href: 'https://www.ozon.ru/product/1508194124' };
        collection.getHtmlData = async () => {
            const accepted = await collection.dataProcessService.filterData([sample, { ...sample, id: 'filtered-sku', price: 5 }], collection.task);
            assert.deepEqual(accepted, [sample], 'existing Ozon market filters still apply');
            collection.process = accepted.length;
            for (const item of accepted) await collection.taskHandle(item);
            collection.reason = 'success';
        };
        await collection.run();
        assert.deepEqual(forbidden, [], 'neither 1688 nor pricing is part of collection');
        assert.equal(collection.task.taskStatus, 'completed');
        assert.equal(starts.length, 1);
        assert.equal(starts[0].pricingConfigVersionId, undefined, 'old pricing references must not be sent to createRun');
        assert.equal(items.length, 1);
        assert.equal(items[0].status, 'QUALIFIED');
        assert.deepEqual(items[0].filterResult, { accepted: true });
        const output = { ...sample, price: '128.91', price1: '128.91', oPrice: '', oPrice1: '', currencyCode: 'CNY', sellerAnalyticsPriceRub: 555.35, analyticsCurrency: 'RUB' };
        assert.deepEqual(items[0].rawPayload, output);
        assert.deepEqual(items[0].exportData, output);
        assert.equal(Object.hasOwn(items[0], 'pricing'), false);
        assert.equal(Object.hasOwn(items[0], 'sourcing'), false);
        assert.equal(items[0].sortOrder, 1);
        assert.deepEqual(exported, [output]);
        assert.equal(summaries.length, 1);
        const { targetCount, targetReached, completionReason, completionMessage, ...existingSummary } = summaries[0];
        assert.deepEqual(existingSummary, { collectedCount: 1, exportedFilePath: '', dedup: { collected: 0, listed: 0, collecting: 0 } });
        assert.equal(targetCount, 1); assert.equal(targetReached, true);
        assert.equal(completionReason, 'TARGET_REACHED'); assert.match(completionMessage, /已达到目标/);
        assert.ok(events.some(event => event.message === '单个商品处理完成'));
        for (const [key, value] of Object.entries(legacy)) assert.equal(collection.task[key], value, 'historical configuration is ignored without being rewritten');
    `);
});

for (const mode of ['category', 'url']) {
    test(mode + ' collection filters with Seller RUB and exports/persists the separate actual storefront reference price', () => {
        runCollectionProbe(`
            import { aiListingItemPrice } from ${JSON.stringify(new URL('../../server/ai-listing-source-facts.mjs', import.meta.url).href)};
            const requests = [], exported = [], detailSkus = [];
            globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
                if (request.url.endsWith('/items')) requests.push(request.data.items[0]);
                else assert.ok(request.url.endsWith('/events'), request.url);
                return { data: { ok: true } };
            };
            const collection = new Collection({ _id: 'fixture-task', taskName: 'CNY reference fixture', aiSelectType: 0, targetCount: 1 }, null);
            collection.runId = 'fixture-run'; collection.leaseToken = 'fixture-lease';
            collection.excelService.saveExcel = async data => { exported.push(...data); return true; };
            collection.excelService.getFilePath = async () => '';
            collection.mainWindowService.getDomain = async () => 'https://www.ozon.ru';
            collection.mainWindowService.getDataByApi = async sku => {
                detailSkus.push(sku);
                return { success: true, data: { widgetStates: { 'webPrice-dynamic-99': JSON.stringify({ price: '128,91 ¥', cardPrice: '127,66 ¥', originalPrice: '190,00 ¥' }) } } };
            };
            collection.mainWindowService.getSellingData = async () => ({ success: true, data: { widgetStates: {} } });
            const seller = { id: '1508194124', _id: '1508194124', sku: '1508194124', goods_id: '1508194124', price: 1541.268, avgPrice: 1541.268, releaseDate: 10, sellerNumber: 1, salesDynamics: 2, drr: 5, soldCount: 60, photo: 'https://ir-20.ozonstatic.cn/paper.jpg' };
            if (${JSON.stringify(mode)} === 'category') {
                const detail = await collection.getHtmlDetailData(seller);
                const accepted = await collection.dataProcessService.aiFilterData([detail]);
                assert.equal(accepted.length, 1, '60 sold meets the RUB 1000–5000 tier; CNY 128 would incorrectly require over 500 sold');
                assert.equal((await collection.dataProcessService.filterData(accepted, { salePriceMin: 1000, salePriceMax: 2000 }, 'detail')).length, 1);
                await collection.taskHandle(accepted[0]);
            } else {
                globalThis.__SELLER_ANALYTICS_ITEMS__ = [seller];
                await collection.processData([{ id: seller.id, price: 127.66, nameLabel: 'Бумага', href: 'https://www.ozon.ru/product/' + seller.id }]);
            }
            assert.deepEqual(detailSkus, [seller.id], 'reuses category details; fetches only one detail for a qualified URL item');
            assert.equal(requests.length, 1);
            const result = requests[0];
            assert.equal(result.status, 'QUALIFIED');
            assert.equal(result.rawPayload.price, '128.91');
            assert.equal(result.rawPayload.price1, '128.91');
            assert.equal(result.rawPayload.oPrice, '190.00');
            assert.equal(result.rawPayload.currencyCode, 'CNY');
            assert.equal(result.rawPayload.sellerAnalyticsPriceRub, 1541.268);
            assert.equal(result.rawPayload.avgPrice, 1541.268);
            assert.equal(result.rawPayload.storefrontPrice.bankAmount, '127.66');
            assert.equal(result.rawPayload.blackPrice, '128.91');
            assert.equal(result.rawPayload.greenPrice, '127.66');
            const group = { sku: seller.id, listingItem: {} };
            const pricing = aiListingItemPrice({ sku: seller.id, sourceSnapshot: result.rawPayload, items: [group] }, group, { targetStoreId: 'fixture-store', priceMultiplier: '5', priceAdjustmentKopecks: -1000 }, { currencyCode: 'CNY' }).pricing;
            assert.equal(pricing.branch, 'BLACK_GTE_80');
            assert.equal(pricing.realPriceKopecks, '13172');
            assert.equal(pricing.finalPriceKopecks, '60860');
            assert.equal(result.analytics.sellerAnalyticsPriceRub, 1541.268);
            assert.equal(result.analytics.currencyCode, 'RUB');
            assert.equal(result.analytics.soldCount, 60);
            assert.deepEqual(result.exportData, result.rawPayload);
            assert.deepEqual(exported, [result.exportData]);
            assert.equal(seller.price, 1541.268, 'the source analytics object is not mutated');
        `);
    });
}

test('missing storefront price keeps the collected facts without publishing the Seller average as a CNY price', () => {
    runCollectionProbe(`
        const items = [];
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            if (request.url.endsWith('/items')) items.push(request.data.items[0]);
            else assert.ok(request.url.endsWith('/events'), request.url);
            return { data: { ok: true } };
        };
        const collection = new Collection({ _id: 'fixture-task', taskName: 'missing public price', targetCount: 1 }, null);
        collection.runId = 'fixture-run'; collection.leaseToken = 'fixture-lease';
        collection.excelService.saveExcel = async () => true;
        collection.excelService.getFilePath = async () => '';
        collection.mainWindowService.getDataByApi = async () => ({ success: false });
        await collection.taskHandle({ id: '1508194124', price: 1541.268, price1: 127.66, oPrice: 999, soldCount: 60 });
        assert.equal(items.length, 1);
        assert.equal(items[0].status, 'QUALIFIED');
        assert.equal(items[0].rawPayload.price, '');
        assert.equal(items[0].rawPayload.price1, '');
        assert.equal(items[0].rawPayload.oPrice, '');
        assert.equal(items[0].rawPayload.currencyCode, '');
        assert.equal(items[0].rawPayload.storefrontPrice, null);
        assert.equal(items[0].rawPayload.sellerAnalyticsPriceRub, 1541.268);
        assert.equal(items[0].analytics.soldCount, 60);
        const missingAnalytics = await collection.dataProcessService.getBaseData([{ id: 'no-seller-row', price: 128.91 }]);
        assert.equal(missingAnalytics[0].price, undefined, 'a public list price cannot silently feed the Seller RUB price tiers when analytics are absent');
    `);
});

test('an Ozon batch waits for direct persistence before the collection advances to another batch', () => {
    runCollectionProbe(`
        let release, markStarted, finished = false;
        const started = new Promise(resolve => { markStarted = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        const writes = [];
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            if (request.url.endsWith('/items')) { writes.push(request.data.items[0]); markStarted(); await held; }
            else assert.ok(request.url.endsWith('/events'), request.url);
            return { data: { ok: true } };
        };
        const collection = new Collection({ _id: 'fixture-task', taskName: 'bounded batch fixture', aiSelectType: 1, targetCount: 1 }, null);
        collection.runId = 'fixture-run'; collection.leaseToken = 'fixture-lease';
        collection.excelService.saveExcel = async () => true;
        collection.excelService.getFilePath = async () => '';
        collection.dataProcessService.getBaseData = async items => items;
        const pending = collection.processData([{ id: 'first-sku', price: 100, storefrontPrice: null }, { id: 'leftover-sku', price: 100, storefrontPrice: null }]).then(() => { finished = true; });
        try {
            await started;
            await new Promise(setImmediate);
            assert.equal(finished, false, 'the direct writer must provide batch backpressure after removing sourcing windows');
        }
        finally {
            release();
            await pending;
        }
        assert.equal(collection.targetData, 1);
        assert.deepEqual(writes.map(item => item.sourceSku), ['first-sku']);
    `);
});

test('periodic heartbeat maps discovered and qualified counts without inventing cumulative processed counts', () => {
    runCollectionProbe(`
        import { mock } from 'node:test';
        const progress = [];
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            assert.ok(request.url.endsWith('/heartbeat'));
            progress.push(request.data.progress);
            return { data: { cancelRequested: false } };
        };
        const collection = new Collection({ _id: 'fixture-task', taskName: 'progress fixture', progress: { current: 99, total: 1, totalCount: 1 } }, null);
        collection.runId = 'fixture-run'; collection.leaseToken = 'fixture-lease';
        collection.parseService.getDataCount = () => 210;
        collection.targetData = 2;
        collection.process = 99;
        mock.timers.enable({ apis: ['setInterval'] });
        try {
            collection.startHeartbeat();
            mock.timers.tick(45000);
            await new Promise(setImmediate);
            assert.deepEqual(progress, [{ totalCount: 210, qualifiedCount: 2, dedup: { collected: 0, listed: 0, collecting: 0 } }]);
        }
        finally {
            collection.stopHeartbeat();
            mock.timers.reset();
        }
    `);
});

test('reaching the target waits for the last item persistence and its export path before completing', () => {
    runCollectionProbe(`
        import { mock } from 'node:test';
        let releaseItem, markItemStarted, releasePath, markPathStarted;
        const itemStarted = new Promise(resolve => { markItemStarted = resolve; });
        const itemResponse = new Promise(resolve => { releaseItem = resolve; });
        const pathStarted = new Promise(resolve => { markPathStarted = resolve; });
        const pathResponse = new Promise(resolve => { releasePath = resolve; });
        const completed = [];
        globalThis.__SELLER_CONTEXT__ = { accountId: 'fixture', source: 'ozon_seller_analytics', sourceIdentity: 'seller-page:fixture' };
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            if (request.url.endsWith('/claim')) return { data: { run: { id: 'fixture-run' }, leaseToken: 'fixture-lease' } };
            if (request.url.endsWith('/items')) { markItemStarted(); await itemResponse; }
            else if (request.url.endsWith('/complete')) completed.push(request.data);
            else assert.ok(request.url.endsWith('/events') || request.url.endsWith('/heartbeat'), request.url);
            return { data: { ok: true } };
        };
        const collection = new Collection({ _id: 'fixture-task', taskName: 'last item fixture', isUseCategorySelect: 1, targetCount: 1 }, null);
        collection.restoreRun({ id: 'fixture-run', status: 'QUEUED' });
        collection.preparedClean = true;
        collection.process = 1;
        collection.parseService.getDataCount = () => 90;
        collection.excelService.saveExcel = async () => true;
        const exportedFilePath = collection.excelService.excel.filePath;
        collection.excelService.getFilePath = async () => { markPathStarted(); await pathResponse; return exportedFilePath; };
        collection.mainWindowService.createCollectionWindow = async () => {};
        collection.expendShop = async () => {};
        collection.getHtmlData = async () => {
            collection.taskHandle({ id: 'fixture-sku', storefrontPrice: null, cover: 'https://example.com/fixture.jpg' });
            await itemStarted;
            collection.reason = 'success';
        };
        mock.timers.enable({ apis: ['setTimeout'] });
        const running = collection.run();
        try {
            await itemStarted;
            await new Promise(setImmediate);
            assert.equal(completed.length, 0, 'the current run must keep its active lease until item persistence completes');
            assert.equal(collection.targetData, 0, 'pending persistence is not a completed item');
            releaseItem();
            await pathStarted;
            mock.timers.tick(1000);
            await new Promise(setImmediate);
            assert.equal(collection.targetData, 1);
            assert.equal(completed.length, 0, 'completion must wait for the persisted item export path');
        }
        finally {
            releaseItem();
            releasePath();
            await new Promise(setImmediate);
            mock.timers.tick(1000);
            await running;
            mock.timers.reset();
        }
        assert.equal(completed.length, 1);
        assert.equal(completed[0].resultSummary.collectedCount, 1);
        assert.equal(completed[0].resultSummary.exportedFilePath, exportedFilePath);
        assert.equal(collection.task.taskStatus, 'completed');
    `);
});

for (const terminal of ['cancel', 'fail']) {
    test('a temporary final heartbeat failure still sends the ' + terminal + ' transition with the active lease', () => {
        runCollectionProbe(`
            const terminal = ${JSON.stringify(terminal)}, terminalRequests = [];
            let heartbeats = 0;
            globalThis.__SELLER_CONTEXT__ = { accountId: 'fixture', source: 'ozon_seller_analytics', sourceIdentity: 'seller-page:fixture' };
            globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
                if (request.url.endsWith('/claim')) return { data: { run: { id: 'fixture-run' }, leaseToken: 'fixture-lease' } };
                if (request.url.endsWith('/heartbeat')) { heartbeats++; throw Error('temporary progress synchronization failure'); }
                if (request.url.endsWith('/' + terminal)) terminalRequests.push(request);
                else assert.ok(request.url.endsWith('/events'), request.url);
                return { data: { ok: true } };
            };
            const collection = new Collection({ _id: 'fixture-task', taskName: 'final heartbeat fixture' }, null);
            collection.restoreRun({ id: 'fixture-run', status: 'QUEUED' });
            collection.preparedClean = true;
            collection.mainWindowService.createCollectionWindow = async () => {
                if (terminal === 'cancel') {
                    await collection.cancel();
                    throw Object.assign(Error('cancelled'), { code: 'COLLECTION_CANCELLED' });
                }
                throw Error('fixture Seller failure');
            };
            await collection.run();
            assert.equal(heartbeats, 1);
            assert.equal(terminalRequests.length, 1, 'auxiliary progress must not prevent the terminal request');
            assert.equal(terminalRequests[0].data.leaseToken, 'fixture-lease');
            assert.ok(terminalRequests[0].data.deviceId);
            assert.equal(collection.task.taskStatus, terminal === 'cancel' ? 'cancelled' : 'failed');
        `);
    });
}

test('terminal or already fulfilled collections ignore queued products without changing their result', () => {
    runCollectionProbe(`
        import log from ${JSON.stringify(logUrl)};
        const errors = [];
        log.error = (...args) => errors.push(args);
        for (const reason of ['cancel', 'failed', 'success']) {
            const collection = new Collection({ _id: 'fixture-task', taskName: 'finished fixture', targetCount: 1, taskStatus: reason }, null);
            collection.reason = reason;
            collection.targetData = reason === 'success' ? 1 : 0;
            collection.process = 4;
            collection.runId = 'fixture-run';
            collection.windowService = { createWindow: async () => { throw Error('a stopped collection must not start external work'); } };
            const before = { reason, count: collection.targetData, status: collection.task.taskStatus };
            collection.taskQueueService.addTask([{ id: 'leftover-sku', cover: 'https://example.com/fixture.jpg' }]);
            await collection.taskQueueService.startProcessing();
            assert.equal(collection.taskQueueService.getFailedTasksCount(), 0);
            assert.equal(collection.taskQueueService.getActiveCount(), 0);
            assert.equal(collection.writeQueue.length, 0);
            assert.equal(collection.process, 4);
            assert.deepEqual({ reason: collection.reason, count: collection.targetData, status: collection.task.taskStatus }, before);
        }
        assert.deepEqual(errors, []);
    `);
});

test('persistence failures retain retries, item identity and the failed run state without counting an unpersisted item', () => {
    runCollectionProbe(`
        import log from ${JSON.stringify(logUrl)};
        const requests = [], errors = [];
        log.error = (...args) => errors.push(args);
        const failure = Object.assign(Error('fixture persistence failure'), { code: 'ECONNRESET' });
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            assert.ok(request.url.endsWith('/items'), request.url);
            requests.push(request.data);
            throw failure;
        };
        const collection = new Collection({ _id: 'fixture-task', taskName: 'persistence fixture', targetCount: 1 }, null);
        collection.runId = 'fixture-run'; collection.leaseToken = 'fixture-lease'; collection.process = 1;
        collection.excelService.saveExcel = async () => true;
        collection.taskQueueService.addTask([{ id: 'failed-sku', nameLabel: 'Persist me', price: 100, storefrontPrice: null }]);
        await collection.taskQueueService.startProcessing();
        assert.equal(requests.length, 3);
        for (const request of requests) {
            assert.equal(request.leaseToken, 'fixture-lease');
            assert.equal(request.items[0].sourceSku, 'failed-sku');
            assert.equal(request.items[0].sortOrder, 1);
        }
        assert.equal(collection.reason, 'failed');
        assert.equal(collection.targetData, 0);
        assert.equal(collection.goodsData.size, 0);
        assert.equal(collection.isWrite, false);
        assert.equal(collection.taskQueueService.getFailedTasksCount(), 1);
        assert.ok(errors.some(args => args.includes(failure)), 'genuine storage failures remain visible');
    `);
});


test('new collection price labels use only explicit same-SKU storefront evidence and preserve missing values', () => {
    runCollectionProbe(`
        import { aiListingItemPrice } from ${JSON.stringify(new URL('../../server/ai-listing-source-facts.mjs', import.meta.url).href)};
        const saved = [];
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            if (request.url.endsWith('/items')) saved.push(request.data.items[0]);
            else assert.ok(request.url.endsWith('/events'), request.url);
            return { data: { ok: true } };
        };
        const collection = new Collection({ _id: 'fixture-task', targetCount: 4 }, null);
        collection.runId = 'fixture-run'; collection.leaseToken = 'fixture-lease';
        collection.excelService.saveExcel = async () => true;
        collection.excelService.getFilePath = async () => '';
        const inputs = [
            { id: 'ordinary-and-bank', price: 999, storefrontPrice: { amount: '46.45', ordinaryAmount: '46.45', bankAmount: '43.58', originalAmount: '322.18', currencyCode: 'CNY', source: 'ozon-web-price' } },
            { id: 'ordinary-only', price: 888, storefrontPrice: { amount: '91.23', ordinaryAmount: '91.23', currencyCode: 'RUB', source: 'ozon-web-price' } },
            { id: 'card-only', price: 777, storefrontPrice: { amount: '127.66', ordinaryAmount: null, bankAmount: '127.66', currencyCode: 'CNY', source: 'ozon-web-price' } },
            { id: 'missing-price', price: 666, storefrontPrice: null },
        ].map(item => ({ ...item, blackPrice: '9999', greenPrice: '8888', aspectPrice: '7777', variants: [{ sku: 'unrelated-sibling', blackPrice: '6666', greenPrice: '5555' }] }));
        const before = structuredClone(inputs);
        for (const item of inputs) await collection.taskHandle(item);
        assert.equal(saved.length, 4);
        const [ordinary, rub, card, missing] = saved.map(row => row.rawPayload);
        assert.equal(ordinary.blackPrice, '46.45'); assert.equal(ordinary.greenPrice, '43.58');
        assert.equal(ordinary.price, '46.45'); assert.equal(ordinary.oPrice, '322.18'); assert.equal(ordinary.currencyCode, 'CNY');
        assert.equal(rub.blackPrice, '91.23'); assert.equal(Object.hasOwn(rub, 'greenPrice'), false); assert.equal(rub.currencyCode, 'RUB');
        assert.equal(Object.hasOwn(card, 'blackPrice'), false); assert.equal(card.greenPrice, '127.66'); assert.equal(card.price, '127.66');
        assert.equal(card.storefrontPrice.ordinaryAmount, null);
        const cardGroup = { sku: card.id, listingItem: { price: card.price, currency_code: card.currencyCode } };
        assert.throws(() => aiListingItemPrice({ sku: card.id, sourceSnapshot: card, items: [cardGroup] }, cardGroup, { targetStoreId: 'fixture-store', priceMultiplier: '1', priceAdjustmentKopecks: 0 }, { currencyCode: 'CNY' }), { code: 'PRICE_INPUT_MISSING' });
        assert.equal(Object.hasOwn(missing, 'blackPrice'), false); assert.equal(Object.hasOwn(missing, 'greenPrice'), false);
        assert.equal(missing.price, ''); assert.equal(missing.currencyCode, '');
        assert.deepEqual(saved.map(row => row.analytics.sellerAnalyticsPriceRub), [999, 888, 777, 666]);
        assert.deepEqual(inputs, before, 'collection does not rewrite source objects or historical evidence');
    `);
});

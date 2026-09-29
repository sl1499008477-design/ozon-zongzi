import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = relative => new URL(relative, import.meta.url).href;
function probe(body) {
    const profile = mkdtempSync(join(tmpdir(), 'collector-url-offers-'));
    try {
        const loader = join(profile, 'real-cheerio-loader.mjs');
        writeFileSync(loader, `
            import { resolve as desktopResolve } from ${JSON.stringify(moduleUrl('./fixtures/desktop-module-loader.mjs'))};
            export async function resolve(specifier, context, nextResolve) {
                if (specifier === 'cheerio') return nextResolve(specifier, context);
                return desktopResolve(specifier, context, nextResolve);
            }
        `);
        const script = `
            import assert from 'node:assert/strict';
            import { Collection } from ${JSON.stringify(moduleUrl('../dist-electron/services/collection/collection.services.js'))};
            import { ParseService } from ${JSON.stringify(moduleUrl('../dist-electron/services/collection/parse.services.js'))};
            const domain = 'https://www.ozon.ru';
            const skus = ['1508194124', '5236200315', '3491634425'];
            const cards = '<main data-widget="searchResultsV2">' + skus.map((sku, index) =>
                '<div data-index="' + index + '"><a href="/product/item-' + sku + '/">'
                + '<img src="https://cdn.test/' + sku + '.jpg">Product ' + sku + '</a>'
                + '<span class="tsHeadline500Medium">30 ¥</span></div>').join('') + '</main>';
            const requestedSku = target => new URL(new URL(target).searchParams.get('url'), domain).searchParams.get('product_id');
            const offersResponse = () => ({ success: true, data: { widgetStates: {
                'webSellerList-4723017-default-1': JSON.stringify({ sellers: [
                    { price: { cardPrice: { price: '29,50 ¥' } } },
                    { price: { cardPrice: { price: '1 ₽' } } },
                ] }),
            } } });
            ${body}
        `;
        const result = spawnSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', script], {
            env: { ...process.env, DESKTOP_TEST_USER_DATA: profile }, encoding: 'utf8', timeout: 15000,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    finally { rmSync(profile, { recursive: true, force: true }); }
}

test('deferred list parsing finishes async candidate selection and leaves all offers for detail processing', () => probe(String.raw`
    const requests = [], selectedPages = [];
    const parser = new ParseService({ getSellingData: async target => { requests.push(requestedSku(target)); return offersResponse(); } });
    const items = await parser.ozonListParser(cards, domain, async candidates => {
        await new Promise(setImmediate);
        selectedPages.push(candidates.map(item => item.id));
        return candidates.filter(item => item.id !== '5236200315');
    }, { deferOffers: true });
    assert.deepEqual(items.map(item => item.id), ['1508194124', '3491634425']);
    assert.deepEqual(selectedPages, [['1508194124', '5236200315', '3491634425']]);
    assert.deepEqual(requests, [], 'network offers enrichment belongs inside the per-item queue');
    assert.ok(items.every(item => item.sellerNumber === undefined && item.followMinPrice === undefined));
    assert.equal(parser.getDataCount(), 3, 'dedup scan counts still include unselected candidates');
    assert.deepEqual(await parser.ozonListParser(cards, domain, undefined, { deferOffers: true }), []);
`));

test('the default list-parser contract still enriches selected offers with their original decimal and currency', () => probe(String.raw`
    const requests = [];
    const parser = new ParseService({ getSellingData: async target => { requests.push(requestedSku(target)); return offersResponse(); } });
    const [item] = await parser.ozonListParser(cards, domain, candidates => candidates.slice(0, 1));
    assert.deepEqual(requests, ['1508194124']);
    assert.equal(item.price, 30);
    assert.equal(item.sellerNumber, 2);
    assert.equal(item.sellerNumber1, 2);
    assert.equal(item.followMinPrice, '29.50');
    assert.equal(item.followMinPrice1, '29.50');
    assert.equal(item.followPriceCurrency, 'CNY');
`));

for (const arrival of ['initial', 'scroll']) {
    test('real URL ' + arrival + ' parsing saves products around an offers failure and retries only that failed SKU', () => probe(String.raw`
        const arrival = ${JSON.stringify(arrival)};
        const rowsByRun = new Map(), saved = [], offers = [], details = [], claimed = [], outcomeReads = [];
        let allowBroken = false;
        globalThis.__SELLER_ANALYTICS_ITEMS__ = skus.map(sku => ({ id: sku, sku, name: 'Product ' + sku, price: 598.14 }));
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            if (request.url.endsWith('/skus/claim')) {
                claimed.push([...request.data.skus]);
                return { data: { items: request.data.skus.map(sku => ({ sku, state: 'CLAIMED' })) } };
            }
            const runId = request.url.match(/\/runs\/([^/]+)\/items$/)?.[1];
            if (runId && request.method === 'get') {
                outcomeReads.push({ runId, status: request.params.status });
                return { data: { items: (rowsByRun.get(runId) || []).filter(row => row.status === request.params.status) } };
            }
            if (runId) {
                const rows = rowsByRun.get(runId) || [];
                rows.push(...request.data.items); rowsByRun.set(runId, rows); saved.push(...request.data.items);
                return { data: { ok: true } };
            }
            assert.ok(request.url.endsWith('/events') || request.url.endsWith('/skus/release'), request.url);
            return { data: { ok: true } };
        };
        const makeCollection = (runId, retryFromRunId) => {
            const collection = new Collection({ _id: runId, taskName: 'offers recovery', isUseCategorySelect: 1,
                aiSelectType: 1, targetCount: 2, concurrency: 2, followMin: 1, followMax: 3, retryFromRunId }, null);
            collection.runId = runId; collection.leaseToken = 'lease-' + runId; collection.uuid = runId;
            collection.excelService.saveExcel = async () => true;
            collection.excelService.getFilePath = async () => '';
            collection.mainWindowService.getDomain = async () => domain;
            collection.mainWindowService.getDataByApi = async sku => {
                details.push(sku);
                return { success: true, data: { widgetStates: {
                    webGallery: { sku, images: ['https://cdn.test/' + sku + '-1.jpg', 'https://cdn.test/' + sku + '-2.jpg'] },
                    webPrice: { price: '30 ¥' },
                } } };
            };
            collection.mainWindowService.getSellingData = async target => {
                const sku = requestedSku(target); offers.push(sku);
                if (sku === '5236200315' && !allowBroken)
                    throw Object.assign(Error('offers network failure'), { code: 'ZONGZI_NETWORK_ERROR' });
                return offersResponse();
            };
            return collection;
        };
        const collection = makeCollection('url-' + arrival);
        let pages = 0;
        collection.mainWindowService.getHTML = async () => {
            pages++;
            assert.ok(pages <= (arrival === 'initial' ? 1 : 2), 'the representative page already contains enough good products');
            return { html: arrival === 'scroll' && pages === 1 ? '<main></main>' : cards, domain };
        };
        collection.mainWindowService.scrollPage = async () => true;
        const realTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (callback, _delay, ...args) => realTimeout(callback, 0, ...args);
        try {
            await collection.getHtmlData(2);
            await collection.waitForAllTasks();
            const outcomes = rowsByRun.get('url-' + arrival) || [];
            assert.deepEqual(outcomes.filter(row => row.status === 'QUALIFIED').map(row => row.sourceSku).sort(), ['1508194124', '3491634425']);
            const failed = outcomes.find(row => row.sourceSku === '5236200315');
            assert.equal(failed.status, 'FAILED');
            assert.equal(failed.errorCode, 'ZONGZI_NETWORK_ERROR');
            assert.equal(failed.attemptCount, 2);
            assert.equal(offers.filter(sku => sku === '1508194124').length, 1, 'a healthy product reads offers only at detail time');
            assert.equal(offers.filter(sku => sku === '3491634425').length, 1);
            assert.equal(offers.filter(sku => sku === '5236200315').length, 2, 'the one bounded retry remains within its own item');
            assert.equal(collection.targetData, 2);
            assert.equal(collection.detailFailure, null);
            assert.equal(collection.parseService.getDataCount(), 3);
            assert.ok(outcomes.filter(row => row.status === 'QUALIFIED').every(row => row.rawPayload.images.length === 2 && row.exportData.followMinPrice === '29.50'));
            assert.deepEqual(collection.task.progress.outcomes, { skipped: 0, failed: 1 });

            allowBroken = true; offers.length = 0; details.length = 0; claimed.length = 0;
            const retry = makeCollection('retry-' + arrival, 'url-' + arrival);
            retry.mainWindowService.getHTML = async () => { throw Error('failed-only retry must not rescan a listing page'); };
            await retry.retryFailedProducts();
            await retry.waitForAllTasks();
            assert.deepEqual(outcomeReads, [{ runId: 'url-' + arrival, status: 'FAILED' }]);
            assert.deepEqual(claimed, [['5236200315']]);
            assert.deepEqual(offers, ['5236200315']);
            assert.deepEqual(details, ['5236200315']);
            assert.deepEqual(rowsByRun.get('retry-' + arrival).map(row => [row.sourceSku, row.status]), [['5236200315', 'QUALIFIED']]);
            assert.equal(retry.targetData, 1);
        }
        finally { globalThis.setTimeout = realTimeout; }
    `));
}

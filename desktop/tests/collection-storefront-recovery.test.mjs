import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { withCollectorRequest } from '../dist-electron/services/collector-network.core.js';

const source = readFileSync(new URL('../dist-electron/services/collection/main-window.services.js', import.meta.url), 'utf8');
const productUrl = 'https://www.ozon.ru/product/5236200315/';
const turn = () => new Promise(setImmediate);

function clock() {
    let nextId = 0;
    const timers = new Map();
    return {
        timers,
        setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        expire() { for (const [id, timer] of [...timers]) { if (timers.delete(id)) timer.callback(); } },
    };
}

function fixture({ holdLoad = false, fetch, stalledRenderer = false } = {}) {
    const windows = [], mainClock = clock(), pageClock = clock();
    let partition = 'persist:account-one-ozon', currencyRequests = 0;
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super(); this.options = options; this.shows = 0; this.loads = [];
            this.webContents = Object.assign(new EventEmitter(), {
                setWindowOpenHandler() {}, setUserAgent() {}, getURL: () => this.loads.at(-1),
                executeJavaScript: script => {
                    if (stalledRenderer) return new Promise(() => {});
                    if (script.includes('fetch(')) return vm.runInNewContext(script, {
                        fetch, AbortController, setTimeout: pageClock.setTimeout, clearTimeout: pageClock.clearTimeout,
                    });
                    return Promise.resolve({ html: '<html>Каталог товаров</html>', diagnostics: { productLinkCount: 1, blocked: false } });
                },
            });
            windows.push(this);
        }
        isDestroyed() { return Boolean(this.destroyed); }
        destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
        show() { this.shows++; }
        loadURL(url) {
            this.loads.push(url);
            return holdLoad ? new Promise(resolve => { this.releaseLoad = resolve; }) : Promise.resolve();
        }
    }
    const api = vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '')
        + '\n({ MainWindowService, closeRetainedCollectionWindow: typeof closeRetainedCollectionWindow === "function" ? closeRetainedCollectionWindow : undefined })', {
        BrowserWindow, URL, process, console: { log() {} }, withCollectorRequest,
        chromeCompatibleUserAgent: () => 'fixture-user-agent',
        getAccountPartition: () => partition,
        ensureOzonCny: async () => { currencyRequests++; return 'CNY'; },
        log: { info() {}, warn() {}, error() {} },
        setTimeout: mainClock.setTimeout, clearTimeout: mainClock.clearTimeout,
    });
    return { ...api, windows, mainClock, pageClock, currencyRequests: () => currencyRequests,
        switchAccount() { partition = 'persist:account-two-ozon'; },
        requestService() { const service = new api.MainWindowService(); service.browserWindow = new BrowserWindow(); return service; },
    };
}

for (const asJson of [false, true]) {
    test('observed sold-out SKU without original gallery is an explicit per-product failure, JSON=' + asJson, async () => {
        const f = fixture(), service = new f.MainWindowService(), requested = [];
        // Real observation: HTTP 200, webOutOfStock-13545189-default-1, no webGallery,
        // and /search/?product_id=5236200315. Recommendation images are not this product.
        const stock = { title: 'Товар закончился' };
        service.getOzonPageJson = async target => {
            requested.push(new URL(target).searchParams.get('url'));
            return { success: true, data: { widgetStates: {
                'webOutOfStock-13545189-default-1': asJson ? JSON.stringify(stock) : stock,
                'searchResultsV2-1': { items: [{ sku: '999', images: ['https://cdn.test/recommendation.jpg'] }] },
                'paginator-1': { nextPage: '/search/?product_id=5236200315&page=2' },
            } } };
        };
        await assert.rejects(service.getDataByApi('5236200315'), error => {
            assert.equal(error.code, 'ZONGZI_PRODUCT_UNAVAILABLE');
            assert.equal(error.sku, '5236200315');
            assert.match(error.message, /5236200315/);
            return true;
        });
        assert.deepEqual(requested, ['/product/5236200315/']);
    });
}

test('a complete original gallery on a sold-out page still reaches the existing filters', async () => {
    const f = fixture(), service = new f.MainWindowService();
    service.getOzonPageJson = async () => ({ success: true, data: { widgetStates: {
        'webOutOfStock-13545189-default-1': { title: 'Товар закончился' },
        webGallery: { sku: '5236200315', images: ['https://cdn.test/original.jpg'] },
    } } });
    const response = await service.getDataByApi('5236200315');
    assert.deepEqual(Array.from(response.data.widgetStates.webGallery.images), ['https://cdn.test/original.jpg']);
    assert.equal(response.data.widgetStates['webOutOfStock-13545189-default-1'].title, 'Товар закончился');
});

test('same-SKU detail pagination can provide the original gallery before unavailable classification', async () => {
    const f = fixture(), service = new f.MainWindowService(), paths = [];
    service.getOzonPageJson = async target => {
        const path = new URL(target).searchParams.get('url'); paths.push(path);
        return { success: true, data: { widgetStates: path.includes('layout_container') ? {
            webGallery: { sku: '5236200315', images: ['https://cdn.test/original.jpg'] },
        } : {
            'webOutOfStock-13545189-default-1': { title: 'Товар закончился' },
            paginator: { nextPage: '/product/5236200315/?layout_container=pdpPage2column&layout_page_index=2' },
        } } };
    };
    const result = await service.getDataByApi('5236200315');
    assert.equal(paths.length, 2);
    assert.equal(result.data.widgetStates.webGallery.images[0], 'https://cdn.test/original.jpg');
});

test('a missing gallery without unavailable evidence stays a retryable detail failure', async () => {
    const f = fixture(), service = new f.MainWindowService();
    service.getOzonPageJson = async () => ({ success: true, data: { widgetStates: { skuGrid: { images: ['https://cdn.test/recommendation.jpg'] } } } });
    await assert.rejects(service.getDataByApi('5236200315'), error => error.code === 'ZONGZI_DETAIL_INCOMPLETE');
});

for (const status of [200, 403]) {
    test('explicit API captcha HTML is access-blocked without returning its raw content, HTTP ' + status, async () => {
        const html = '<html><title>Antibot Captcha</title><body>请确认您不是机器人 private-login-marker</body></html>';
        const f = fixture({ fetch: async () => new Response(html, { status, headers: { 'content-type': 'text/html' } }) });
        await assert.rejects(f.requestService().getDataByApi('5236200315'), error => {
            assert.equal(error.code, 'ZONGZI_ACCESS_BLOCKED');
            assert.equal(error.status, status);
            assert.doesNotMatch(error.message, /private-login-marker|<html>/);
            return true;
        });
        assert.equal(f.mainClock.timers.size, 0);
        assert.equal(f.pageClock.timers.size, 0);
    });
}

test('a generic HTML error that merely references captcha scripts stays an invalid response', async () => {
    const f = fixture({ fetch: async () => new Response('<html><head><script src="/captcha.js"></script></head><body>Temporary error</body></html>') });
    await assert.rejects(f.requestService().getDataByApi('5236200315'), error => error.code === 'ZONGZI_RESPONSE_INVALID');
});

test('an API authentication rejection is access-blocked', async () => {
    const f = fixture({ fetch: async () => new Response('{"error":"unauthorized"}', { status: 401 }) });
    await assert.rejects(f.requestService().getDataByApi('5236200315'), error => error.code === 'ZONGZI_ACCESS_BLOCKED' && error.status === 401);
});

for (const stalledAt of ['fetch', 'body', 'renderer']) {
    test('a stalled ' + stalledAt + ' rejects with a bounded storefront request timeout', async () => {
        let aborted = false, outcome;
        const f = fixture({ stalledRenderer: stalledAt === 'renderer', fetch: (_url, options) => {
            const held = new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => {
                aborted = true; reject(Object.assign(Error('aborted'), { name: 'AbortError' }));
            }, { once: true }));
            return stalledAt === 'body' ? Promise.resolve({ ok: true, status: 200, text: () => held, json: () => held }) : held;
        } });
        const running = f.requestService().getDataByApi('5236200315').then(value => { outcome = value; }, error => { outcome = error; });
        await turn();
        const timeoutDurations = [...f.mainClock.timers.values(), ...f.pageClock.timers.values()].map(timer => timer.delay);
        f.pageClock.expire(); await turn(); f.mainClock.expire(); await turn();
        assert.ok(timeoutDurations.length > 0, 'every request must have a deadline');
        assert.ok(timeoutDurations.every(delay => delay > 0 && delay <= 60000));
        assert.equal(outcome?.code, 'ZONGZI_REQUEST_TIMEOUT');
        if (stalledAt !== 'renderer') assert.equal(aborted, true, 'the page request is aborted at its deadline');
        await running;
        assert.equal(f.mainClock.timers.size, 0);
        assert.equal(f.pageClock.timers.size, 0);
    });
}

test('a valid product response clears both deadlines and keeps the exact product request and credentials', async () => {
    let request;
    const f = fixture({ fetch: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ widgetStates: { webGallery: { sku: '5236200315', images: ['https://cdn.test/original.jpg'] } } }));
    } });
    const response = await f.requestService().getDataByApi('5236200315');
    assert.equal(response.success, true);
    assert.equal(new URL(request.url).searchParams.get('url'), '/product/5236200315/');
    assert.equal(request.options.credentials, 'include');
    assert.equal(f.mainClock.timers.size, 0);
    assert.equal(f.pageClock.timers.size, 0);
});

test('normal destroy still closes the active window and invokes its close handler once', async () => {
    const f = fixture(); let closed = 0;
    const service = new f.MainWindowService(() => { closed++; });
    const win = await service.createCollectionWindow(productUrl);
    await service.destroy(); await service.destroy();
    assert.equal(win.isDestroyed(), true);
    assert.equal(closed, 1);
});

test('retaining a failed window detaches its task close callback and explicit cleanup closes it', async () => {
    const f = fixture(); let closed = 0;
    const service = new f.MainWindowService(() => { closed++; });
    const win = await service.createCollectionWindow(productUrl);
    await service.destroy({ keepOpen: true });
    assert.equal(win.isDestroyed(), false);
    assert.equal(service.browserWindow, null);
    assert.equal(closed, 0);
    assert.equal(win.listenerCount('closed'), 1, 'only diagnostic ownership remains');
    f.closeRetainedCollectionWindow();
    assert.equal(win.isDestroyed(), true);
    assert.equal(closed, 0);
    f.closeRetainedCollectionWindow();
});

test('retaining a later failure closes the previous diagnostic window without touching its task', async () => {
    const f = fixture(); let closed = 0;
    const first = new f.MainWindowService(() => { closed++; }), second = new f.MainWindowService(() => { closed++; });
    const firstWin = await first.createCollectionWindow(productUrl), secondWin = await second.createCollectionWindow(productUrl);
    await first.destroy({ keepOpen: true });
    await second.destroy({ keepOpen: true });
    assert.equal(firstWin.isDestroyed(), true);
    assert.equal(secondWin.isDestroyed(), false);
    assert.equal(closed, 0);
    f.closeRetainedCollectionWindow();
    assert.equal(secondWin.isDestroyed(), true);
});

test('initializing a new collection closes the prior diagnostic page', async () => {
    const f = fixture(), previous = new f.MainWindowService();
    const win = await previous.createCollectionWindow(productUrl);
    await previous.destroy({ keepOpen: true });
    assert.equal(win.isDestroyed(), false, 'the preceding failed page was retained');
    const next = new f.MainWindowService();
    await next.createCollectionWindow(productUrl);
    assert.equal(win.isDestroyed(), true);
    await next.destroy();
});

test('an account change cannot retain the previous account collection page', async () => {
    const f = fixture(), service = new f.MainWindowService();
    const win = await service.createCollectionWindow(productUrl);
    f.switchAccount();
    await service.destroy({ keepOpen: true });
    assert.equal(win.isDestroyed(), true);
    assert.equal(service.browserWindow, null);
});

test('initial navigation timeout leaves a diagnostic page and never resumes after its late load', async () => {
    const f = fixture({ holdLoad: true }); let closed = 0;
    const service = new f.MainWindowService(() => { closed++; });
    const opening = service.createCollectionWindow(productUrl);
    const rejected = assert.rejects(opening, error => error.code === 'ZONGZI_REQUEST_TIMEOUT');
    const win = f.windows[0];
    f.mainClock.expire(); await rejected;
    assert.equal(win.isDestroyed(), false);
    assert.equal(win.shows, 1);
    await service.destroy({ keepOpen: true });
    win.releaseLoad(); await turn();
    assert.equal(f.currencyRequests(), 0);
    assert.equal(win.loads.length, 1);
    assert.equal(closed, 0);
    assert.equal(f.mainClock.timers.size, 0);
    f.closeRetainedCollectionWindow();
});

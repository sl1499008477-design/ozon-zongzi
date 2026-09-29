import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { withCollectorRequest } from '../dist-electron/services/collector-network.core.js';

const source = readFileSync(new URL('../dist-electron/services/collection/main-window.services.js', import.meta.url), 'utf8');
const collectionSource = readFileSync(new URL('../dist-electron/services/collection/collection.services.js', import.meta.url), 'utf8');
const uaPath = new URL('../dist-electron/browser-user-agent.core.js', import.meta.url);
const uaSource = readFileSync(uaPath, 'utf8').replace(/export /g, '');
const pageUrl = 'https://www.ozon.ru/category/elektronika-15500/';
const turn = () => new Promise(setImmediate);

function fixture({ text = 'Каталог товаров', title = '', markers = false, status = 200, holdFirstLoad = false } = {}) {
    const windows = [], events = [], timers = new Map();
    let clicks = 0, timerId = 0, releaseFirst, partition = 'persist:fixture-ozon';
    const document = {
        title,
        body: { innerText: text },
        documentElement: { outerHTML: '<html><body>' + text + '</body></html>' },
        querySelectorAll: selector => selector.includes('/product/') && document.body.innerText === 'Каталог товаров' ? [{}] : [],
        querySelector: selector => markers ? selector === 'body > div.con p.h' ? {} : { click() { clicks++; } } : null,
    };
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super(); this.options = options; this.loads = []; this.shows = 0;
            this._webContents = Object.assign(new EventEmitter(), {
                setWindowOpenHandler() {}, setUserAgent() {},
                getURL: () => this.loads.at(-1),
                executeJavaScript: async script => vm.runInNewContext(script, { document }),
            });
            windows.push(this);
        }
        loadURL(url) {
            this.loads.push(url); events.push('navigation-start');
            queueMicrotask(() => this.webContents.emit('dom-ready'));
            const complete = () => { this.webContents.emit('did-navigate', {}, url, status); events.push('navigation-finish'); };
            if (this.loads.length === 1 && holdFirstLoad) return new Promise(resolve => { releaseFirst = () => { complete(); resolve(); }; });
            complete(); return Promise.resolve();
        }
        get webContents() { if (this.destroyed) throw new TypeError('Object has been destroyed'); return this._webContents; }
        show() { this.shows++; }
        isDestroyed() { return Boolean(this.destroyed); }
        destroy() { this.destroyed = true; this.emit('closed'); }
    }
    const MainWindowService = vm.runInNewContext(uaSource + source.replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '') + '\nMainWindowService', {
        BrowserWindow, URL, process, console: { log() {} }, withCollectorRequest,
        getAccountPartition: () => partition,
        ensureOzonCny: async () => { events.push('currency'); return 'CNY'; },
        log: { info() {}, warn() {}, error() {} },
        setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, fn); if (delay < 10000) queueMicrotask(() => { if (timers.delete(id)) fn(); }); return id; },
        clearTimeout: id => timers.delete(id),
    });
    return {
        service: new MainWindowService(), windows, events, document, timers, clicks: () => clicks, releaseFirst: () => releaseFirst(),
        switchAccount: () => { partition = 'persist:another-account'; },
        navigate: (nextText, nextStatus = 200, nextTitle = '') => {
            document.title = nextTitle; document.body.innerText = nextText; document.documentElement.outerHTML = '<html><body>' + nextText + '</body></html>';
            status = nextStatus;
            const wc = windows[0]._webContents; wc.emit('did-navigate', {}, pageUrl, status); wc.emit('did-finish-load');
        },
    };
}

test('currency setup waits for a complete normal document, even when dom-ready fires earlier', async () => {
    const f = fixture({ holdFirstLoad: true });
    const opening = f.service.createCollectionWindow(pageUrl);
    await turn();
    assert.equal(f.events.includes('currency'), false, 'dom-ready must not trigger a competing currency request and reload');
    f.releaseFirst(); await opening;
    assert.ok(f.events.indexOf('navigation-finish') < f.events.indexOf('currency'));
    assert.equal(f.events.filter(event => event === 'currency').length, 1);
});

for (const markers of [false, true]) {
    test('the Russian no-connection page stops initialization without currency requests or automatic clicks, markers=' + markers, async () => {
        const f = fixture({ text: 'Похоже, нет соединения. Выключите VPN, перезагрузите роутер или подключитесь к другой сети', markers });
        await assert.rejects(f.service.createCollectionWindow(pageUrl), error => error.code === 'ZONGZI_PAGE_UNAVAILABLE');
        assert.equal(f.events.includes('currency'), false);
        assert.equal(f.clicks(), 0);
        assert.equal(f.windows[0].shows, 1, 'the source page remains visible when initialization fails');
    });
}

test('reading an access challenge never clicks its retry control', async () => {
    const f = fixture({ text: 'Доступ ограничен', markers: true });
    f.service.browserWindow = new (class {
        isDestroyed() { return false; }
        webContents = { getURL: () => pageUrl, executeJavaScript: async script => vm.runInNewContext(script, { document: f.document }) };
    })();
    await assert.rejects(f.service.getHTML(), error => error.code === 'ZONGZI_ACCESS_BLOCKED');
    assert.equal(f.clicks(), 0);
});

test('the observed slider challenge waits in one window for manual normal navigation before currency setup', async () => {
    const text = '请拖动滑块，将拼图移入轮廓中。请确认您不是机器人。';
    const f = fixture({ text, status: 403 });
    let settled = false;
    const opening = f.service.createCollectionWindow(pageUrl).finally(() => { settled = true; });
    opening.catch(() => {});
    await turn();
    assert.equal(settled, false);
    assert.equal(f.windows[0].shows, 1);
    assert.equal(f.events.includes('currency'), false);
    assert.equal(f.windows[0].loads.length, 1);
    f.navigate(text, 403); await turn();
    assert.equal(settled, false); assert.equal(f.windows[0].loads.length, 1);
    f.navigate('Каталог товаров'); await opening;
    assert.equal(f.windows.length, 1);
    assert.equal(f.events.filter(event => event === 'currency').length, 1);
    assert.equal(f.windows[0].loads.length, 2, 'only the normal currency reload is programmatic');
    assert.equal(f.clicks(), 0);
    assert.equal(f.windows[0].webContents.listenerCount('did-finish-load'), 0);
    assert.equal(f.timers.size, 0);
});

test('a completed navigation cannot be missed while an earlier blocked page snapshot returns', async () => {
    const f = fixture({ title: 'Antibot Challenge Page', text: '', status: 403, holdFirstLoad: true });
    let outcome = 'pending';
    const opening = f.service.createCollectionWindow(pageUrl).then(() => { outcome = 'resolved'; }, error => { outcome = error.code || error.message; });
    const wc = f.windows[0].webContents, execute = wc.executeJavaScript;
    let first = true;
    wc.executeJavaScript = async script => {
        const snapshot = await execute(script);
        if (first) { first = false; f.navigate('Каталог товаров', 200, 'Ozon'); }
        return snapshot;
    };
    f.releaseFirst();
    try {
        for (let i = 0; i < 3; i++) await turn();
        assert.equal(outcome, 'resolved');
        assert.equal(f.events.filter(event => event === 'currency').length, 1);
        assert.equal(f.windows[0].loads.length, 2);
        assert.equal(wc.listenerCount('did-finish-load'), 0);
        assert.equal(f.clicks(), 0);
    }
    finally { for (const expire of [...f.timers.values()]) expire(); await opening; }
});

test('a stale page snapshot cannot terminate a newer verification navigation', async () => {
    const f = fixture({ holdFirstLoad: true });
    let outcome = 'pending';
    const opening = f.service.createCollectionWindow(pageUrl).then(() => { outcome = 'resolved'; }, error => { outcome = error.code || error.message; });
    const wc = f.windows[0].webContents, execute = wc.executeJavaScript;
    let first = true;
    wc.executeJavaScript = async script => {
        const snapshot = await execute(script);
        if (first) { first = false; f.navigate('请确认您不是机器人', 403, 'Antibot Captcha'); }
        return snapshot;
    };
    f.releaseFirst();
    try {
        for (let i = 0; i < 3; i++) await turn();
        assert.equal(outcome, 'pending');
        assert.equal(f.events.includes('currency'), false);
        assert.equal(f.windows[0].loads.length, 1);
        f.navigate('Каталог товаров', 200, 'Ozon'); await opening;
        assert.equal(outcome, 'resolved');
        assert.equal(f.events.filter(event => event === 'currency').length, 1);
        assert.equal(wc.listenerCount('did-finish-load'), 0);
    }
    finally { for (const expire of [...f.timers.values()]) expire(); await opening; }
});

test('the observed empty Antibot Challenge Page remains pending after the user completes the slider', async () => {
    const f = fixture({ title: 'Antibot Captcha', text: '请确认您不是机器人', status: 403 });
    let settled = false;
    const opening = f.service.createCollectionWindow(pageUrl).finally(() => { settled = true; });
    opening.catch(() => {});
    await turn();
    f.navigate('', 403, 'Antibot Challenge Page'); await turn();
    assert.equal(settled, false, 'Ozon must finish its own verification navigation');
    assert.equal(f.events.includes('currency'), false);
    assert.equal(f.windows[0].loads.length, 1);
    f.navigate('Каталог товаров', 200, 'Ozon'); await opening;
    assert.equal(f.events.filter(event => event === 'currency').length, 1);
    assert.equal(f.clicks(), 0);
});

for (const status of [200, 403]) {
    test('an ordinary blank HTTP ' + status + ' document is not treated as a manual verification page', async () => {
        const f = fixture({ title: '', text: '', status });
        await assert.rejects(f.service.createCollectionWindow(pageUrl), error => error.code === (status === 403 ? 'ZONGZI_HTTP_ERROR' : 'ZONGZI_PAGE_UNAVAILABLE'));
        assert.equal(f.events.includes('currency'), false);
        assert.equal(f.windows[0].webContents.listenerCount('did-finish-load'), 0);
        assert.equal(f.timers.size, 0);
    });
}

for (const ending of ['closed', 'timeout', 'account-changed', 'network-failed']) {
    test('manual verification ' + ending + ' rejects and removes its pending navigation listeners', async () => {
        const f = fixture({ text: '请确认您不是机器人', status: 403 });
        const opening = f.service.createCollectionWindow(pageUrl);
        const expected = { closed: undefined, timeout: 'ZONGZI_VERIFICATION_TIMEOUT', 'account-changed': 'ZONGZI_ACCOUNT_CHANGED', 'network-failed': 'ZONGZI_NETWORK_ERROR' };
        const rejected = assert.rejects(opening, error => ending === 'closed' ? /关闭/.test(error.message) : error.code === expected[ending]);
        await turn();
        const win = f.windows[0], wc = win.webContents;
        if (ending === 'closed') await f.service.destroy();
        else if (ending === 'timeout') { for (const expire of [...f.timers.values()]) expire(); }
        else if (ending === 'account-changed') { f.switchAccount(); f.navigate('Каталог товаров'); }
        else win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', pageUrl, true);
        await rejected;
        assert.equal(wc.listenerCount('did-finish-load'), 0);
        assert.equal(wc.listenerCount('did-fail-load'), 0);
        assert.equal(f.timers.size, 0);
        assert.equal(f.events.includes('currency'), false);
        if (ending === 'closed' || ending === 'timeout' || ending === 'account-changed') assert.equal(win.isDestroyed(), true);
        f.navigate('Каталог товаров'); await turn();
        assert.equal(f.events.includes('currency'), false, 'late navigation cannot resume a terminated window');
    });
}

test('HTTP failure documents cannot trigger currency setup or count as a ready collection page', async () => {
    const f = fixture({ text: 'Service unavailable', status: 503 });
    await assert.rejects(f.service.createCollectionWindow(pageUrl), error => error.code === 'ZONGZI_HTTP_ERROR' && error.status === 503);
    assert.equal(f.events.includes('currency'), false);
});

for (const [name, response, code, status] of [
    ['HTTP 403 JSON', () => new Response('{"error":"access denied"}', { status: 403, headers: { 'content-type': 'application/json' } }), 'ZONGZI_HTTP_ERROR', 403],
    ['HTTP 200 HTML', () => new Response('<html>Похоже, нет соединения</html>', { headers: { 'content-type': 'text/html' } }), 'ZONGZI_RESPONSE_INVALID', 200],
    ['HTTP 200 error JSON', () => new Response('{"error":"access denied"}', { headers: { 'content-type': 'application/json' } }), 'ZONGZI_RESPONSE_INVALID', 200],
]) {
    test(name + ' is preserved as an API error instead of successful or empty product data', async () => {
        const f = fixture();
        f.service.browserWindow = { webContents: { executeJavaScript: script => vm.runInNewContext(script, { AbortController, setTimeout, clearTimeout, fetch: async () => response() }) } };
        await assert.rejects(f.service.getDataByApi('1508194124'), error => error.code === code && error.status === status);
    });
}

test('a rejected product fetch preserves the network failure instead of returning empty success', async () => {
    const f = fixture();
    f.service.browserWindow = { webContents: { executeJavaScript: script => vm.runInNewContext(script, { AbortController, setTimeout, clearTimeout, fetch: async () => { throw new TypeError('Failed to fetch'); } }) } };
    await assert.rejects(f.service.getDataByApi('1508194124'), error => error.code === 'ZONGZI_NETWORK_ERROR');
});

// Category concurrency, cancellation and mixed outcomes run against the actual Collection and queue
// in collection-item-recovery.test.mjs; the old Promise.all extraction is no longer the implementation.

test('application bootstrap establishes the compatible UA before readiness and includes the actual platform and Chrome version', () => {
    const main = readFileSync(new URL('../dist-electron/main.js', import.meta.url), 'utf8');
    const bootstrap = main.slice(0, main.indexOf('// 重启相关常量')).replace(/^import .*;\n/gm, '');
    for (const [platform, osText, chrome, major] of [['win32', 'Windows NT 10.0; Win64; x64', '145.0.1.2', '145'], ['darwin', 'Macintosh; Intel Mac OS X 10_15_7', '142.0.7444.235', '142']]) {
        const app = { commandLine: { appendSwitch() {} } };
        vm.runInNewContext(uaSource + '\n' + bootstrap, { app, process: { platform, versions: { chrome } } });
        assert.equal(app.userAgentFallback, 'Mozilla/5.0 (' + osText + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36');
    }
});


test('category detail parsing preserves explicit Ozon request failures from the offers API', async () => {
    const parseSource = readFileSync(new URL('../dist-electron/services/collection/parse.services.js', import.meta.url), 'utf8');
    const ParseService = vm.runInNewContext(parseSource.replace(/^import .*;\n/gm, '').replace(/export /g, '') + '\nParseService', { log: { error() {} } });
    for (const code of ['ZONGZI_HTTP_ERROR', 'ZONGZI_NETWORK_ERROR', 'ZONGZI_RESPONSE_INVALID']) {
        const failure = Object.assign(Error('upstream failure'), { code, status: 403 });
        const parser = new ParseService({ getSellingData: async () => { throw failure; } });
        await assert.rejects(parser.ozonDetailParse({ success: true, data: { widgetStates: {} } }, 'https://www.ozon.ru', { id: '1508194124', price: 100 }), error => error === failure);
    }
});

test('noncritical historical widget parsing still preserves the original Seller item', async () => {
    const parseSource = readFileSync(new URL('../dist-electron/services/collection/parse.services.js', import.meta.url), 'utf8');
    const ParseService = vm.runInNewContext(parseSource.replace(/^import .*;\n/gm, '').replace(/export /g, '') + '\nParseService', { log: { error() {} } });
    const parser = new ParseService({ getSellingData: async () => ({ success: true, data: { widgetStates: {} } }) });
    const result = await parser.ozonDetailParse({ success: true, data: { widgetStates: { 'webSingleProductScore-3386432-default-1': '{invalid' } } }, 'https://www.ozon.ru', { id: '1508194124', price: 100 });
    assert.equal(result.id, '1508194124'); assert.equal(result.price, 100); assert.equal(result.storefrontPrice, null);
});


function preparationFixture(mode = 0, resolve = async () => ['970627949', '970627962']) {
    const calls = [], verification = { accountId: 'fixture', source: 'ozon_seller_analytics', sourceIdentity: 'seller-page:fixture' };
    const routeEvents = [];
    const Collection = vm.runInNewContext(collectionSource.slice(collectionSource.indexOf('export class Collection')).replace(/^export (?=class |function )/gm, '') + '\nCollection', {
        randomUUID: () => 'request-id',
        acquireSellerRoute: async () => { routeEvents.push('acquire'); return { origin: 'https://seller.ozonru.cn', release() { routeEvents.push('release'); } }; },
        rememberSellerRunRoute(id, origin) { routeEvents.push([id, origin]); },
        verifyCurrentSellerStore: async () => { calls.push('verify'); return verification; },
        resolveCollectorCategoryIds: async (paths, options) => { calls.push('resolve'); return resolve(paths, options); },
        createCollectorRun: async () => { calls.push('create'); return { id: 'run-id' }; },
    });
    const collection = Object.create(Collection.prototype);
    Object.assign(collection, { task: { _id: 'task-id', isUseCategorySelect: mode, categoryIds: [['17027487']] }, query: { categories: ['17027487'] }, cancellationController: new AbortController(), resetTask: async () => {}, applyVerifiedSellerScope() {} });
    return { collection, calls, verification, routeEvents };
}

test('category preparation resolves Seller leaf type IDs before a run is created', async () => {
    let received;
    const f = preparationFixture(0, async (paths, options) => { received = { paths, options }; return ['970627949', '970627962']; });
    await f.collection.prepareRun();
    assert.deepEqual(f.calls, ['verify', 'resolve', 'create']);
    assert.deepEqual(Array.from(f.collection.query.categories), ['970627949', '970627962']);
    assert.equal(received.options.expectedContext, f.verification);
    assert.equal(received.options.signal, f.collection.cancellationController.signal);
    assert.deepEqual(f.routeEvents, ['acquire', ['run-id', 'https://seller.ozonru.cn']]);
});

test('category resolution cancellation cannot create a run after returning late data', async () => {
    const failure = Object.assign(Error('cancelled during categories'), { code: 'COLLECTION_CANCELLED' });
    const f = preparationFixture(0, async () => { f.collection.cancellationController.abort(failure); return ['970627949']; });
    await assert.rejects(f.collection.prepareRun(), error => error === failure);
    assert.deepEqual(f.calls, ['verify', 'resolve']);
    assert.deepEqual(f.routeEvents, ['acquire', 'release']);
});

test('URL mode still bypasses Seller category resolution', async () => {
    const f = preparationFixture(1);
    await f.collection.prepareRun();
    assert.deepEqual(f.calls, ['verify', 'create']);
});

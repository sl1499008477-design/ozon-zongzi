import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { chromeCompatibleUserAgent } from '../dist-electron/browser-user-agent.core.js';
import { withCollectorRequest } from '../dist-electron/services/collector-network.core.js';

const source = await readFile(new URL('../dist-electron/services/collection/main-window.services.js', import.meta.url), 'utf8');
const url = 'https://www.ozon.ru/product/1508194124/';
const turn = () => new Promise(setImmediate);

function fixture({ configure = async () => 'CNY', holdInitial = false, reloadError } = {}) {
    const windows = [], preferences = [], warnings = [], errors = [], timers = new Map();
    let timerId = 0;
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options; this.loads = []; this.shows = 0; this.destroyed = false;
            this.webContents = new EventEmitter();
            this.webContents.setWindowOpenHandler = () => {};
            this.webContents.setUserAgent = () => {};
            this.webContents.getURL = () => this.loads.at(-1);
            this.webContents.executeJavaScript = async () => ({ html: '<html>Каталог товаров</html>', diagnostics: { productLinkCount: 1, blocked: false } });
            windows.push(this);
        }
        loadURL(target) {
            this.loads.push(target);
            if (this.loads.length === 1 && holdInitial)
                return new Promise(resolve => { this.completeInitial = resolve; });
            return reloadError ? Promise.reject(reloadError) : Promise.resolve();
        }
        show() { this.shows++; }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; this.emit('closed'); }
    }
    const MainWindowService = vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '') + '\nMainWindowService', {
        withCollectorRequest,
        BrowserWindow, URL, process, chromeCompatibleUserAgent,
        getAccountPartition: scope => 'persist:fixture-' + scope,
        ensureOzonCny: async contents => { preferences.push(contents); return configure(contents); },
        log: { info() {}, warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
        setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id),
    });
    return { service: new MainWindowService(), windows, preferences, warnings, errors, timers,
        fire: delay => {
            for (const [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
        },
    };
}

test('each collection window sets its own CNY preference once while hidden, refreshes once and shows the ready page', { timeout: 1000 }, async () => {
    let release;
    const configured = new Promise(resolve => { release = resolve; });
    const f = fixture({ configure: () => configured, holdInitial: true });
    let resolved = false;
    const opened = f.service.createCollectionWindow(url).then(win => { resolved = true; return win; });
    const win = f.windows[0];
    assert.equal(win.options.show, false);
    assert.equal(win.options.webPreferences.partition, 'persist:fixture-ozon');
    assert.equal(f.preferences.length, 0);
    win.webContents.emit('dom-ready');
    await turn();
    assert.equal(f.preferences.length, 0, 'a pending first navigation cannot start currency setup');
    win.completeInitial();
    await turn();
    assert.deepEqual(f.preferences, [win.webContents]);
    assert.equal(win.shows, 0);
    assert.equal(win.loads.length, 1);
    assert.equal(resolved, false);
    release('CNY');
    await turn();
    win.webContents.emit('dom-ready');
    await turn();
    assert.deepEqual(win.loads, [url, url]);
    assert.equal(f.preferences.length, 1);
    assert.equal(win.shows, 1);
    f.fire(3000);
    assert.equal(await opened, win);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.errors, [], 'the currency refresh starts after the original navigation completes');
});

test('a rejected currency preference warns and uses the actual page without a forced CNY label or reload', { timeout: 1000 }, async () => {
    const f = fixture({ configure: async () => { throw Error('HTTP 403'); } });
    const opened = f.service.createCollectionWindow(url);
    const win = f.windows[0];
    win.webContents.emit('dom-ready');
    await turn();
    assert.equal(win.shows, 1);
    assert.equal(win.loads.length, 1);
    assert.match(f.warnings.flat().join(' '), /人民币.*失败.*实际币种/);
    f.fire(3000);
    assert.equal(await opened, win);
    assert.equal(f.timers.size, 0);
});

test('timeout while changing preference settles and clears timers; late completion cannot reload or show a destroyed window', { timeout: 1000 }, async () => {
    let release;
    const f = fixture({ configure: () => new Promise(resolve => { release = resolve; }) });
    const opened = f.service.createCollectionWindow(url);
    const rejected = assert.rejects(opened, error => String(error).includes('页面加载超时'));
    const win = f.windows[0];
    win.webContents.emit('dom-ready');
    await turn();
    f.fire(100000);
    await rejected;
    release('CNY');
    await turn();
    assert.equal(win.destroyed, true);
    assert.equal(win.loads.length, 1);
    assert.equal(win.shows, 0);
    assert.equal(f.timers.size, 0);
});

test('failed refresh rejects the window promise with no unhandled async listener failure and no live timer', { timeout: 1000 }, async () => {
    const failure = Error('refresh network failure');
    const f = fixture();
    const opened = f.service.createCollectionWindow(url);
    const rejected = assert.rejects(opened, error => error === failure);
    const win = f.windows[0];
    win.loadURL = async target => { win.loads.push(target); throw failure; };
    win.webContents.emit('dom-ready');
    await rejected;
    assert.equal(win.shows, 1, 'the failed page stays visible for diagnosis');
    assert.equal(f.timers.size, 0);
});

test('public detail API requests use the exact SKU product path without a borrowed product slug', async () => {
    const f = fixture();
    let fetched;
    f.service.browserWindow = { webContents: { executeJavaScript: script => vm.runInNewContext(script, {
        AbortController, setTimeout, clearTimeout,
        fetch: async (target, options) => { fetched = { target, options }; return new Response(JSON.stringify({ widgetStates: { webGallery: { sku: '1508194124', images: ['https://ir-20.ozonstatic.cn/paper.jpg'] } } })); },
    }) } };
    const result = await f.service.getDataByApi('1508194124');
    const request = new URL(fetched.target);
    assert.equal(request.origin, 'https://www.ozon.ru');
    assert.equal(request.searchParams.get('url'), '/product/1508194124/');
    assert.equal(fetched.options.credentials, 'include');
    assert.equal(result.success, true);
});

test('shop navigation propagates a rejected loadURL without an unhandled promise or stale load listener', { timeout: 1000 }, async () => {
    const f = fixture(), contents = new EventEmitter();
    const failure = Object.assign(Error('navigation cancelled'), { code: 'ERR_ABORTED', errno: -3 });
    f.service.browserWindow = {
        isDestroyed: () => false,
        webContents: contents,
        loadURL: async () => {
            queueMicrotask(() => contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED'));
            throw failure;
        },
    };
    const result = await f.service.changeUrl('/seller/123/', true).catch(error => error);
    await turn();
    assert.equal(result, failure, 'the original navigation failure reaches the caller');
    assert.equal(f.timers.size, 0);
    assert.equal(contents.listenerCount('did-finish-load'), 0);
    assert.equal(contents.listenerCount('did-fail-load'), 0);
});

test('shop navigation success and timeout settle once while consuming a late loadURL rejection', { timeout: 1000 }, async () => {
    const f = fixture(), contents = new EventEmitter();
    let resolveLoad, rejectLoad;
    f.service.browserWindow = {
        isDestroyed: () => false,
        webContents: contents,
        loadURL: () => new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; }),
    };
    const first = f.service.changeUrl('/seller/123/', true);
    contents.emit('did-finish-load'); resolveLoad();
    assert.equal(await first, true);
    assert.equal(f.timers.size, 0);
    const next = f.service.changeUrl('/seller/456/', true);
    const timedOut = assert.rejects(next, error => String(error).includes('URL 切换超时'));
    f.fire(60000);
    await timedOut;
    rejectLoad(Error('late navigation failure'));
    await turn();
    assert.equal(f.timers.size, 0);
    assert.equal(contents.listenerCount('did-finish-load'), 0);
    assert.equal(contents.listenerCount('did-fail-load'), 0);
});

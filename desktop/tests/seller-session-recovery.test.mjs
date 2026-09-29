import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as runtime from '../dist-electron/config/runtime.js';
import * as core from '../dist-electron/services/seller-analytics.core.js';
import { withCollectorRequest } from '../dist-electron/services/collector-network.core.js';
import { captureSellerProduct } from '../dist-electron/services/seller-enrichment.core.js';

const source = (await readFile(new URL('../dist-electron/services/seller-ozon.services.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/^export \{[^\n]*\};?\n?/gm, '')
    .replace(/^export /gm, '');
const expected = { accountId: 'account-a', sourceIdentity: 'seller-page:123' };
const success = sku => ({ status: 200, data: { items: [{ Sku: sku, Name: 'Representative product', SoldCount: 42 }] } });
const turn = () => new Promise(resolve => setImmediate(resolve));
const sellerTree = JSON.parse(await readFile(new URL('./fixtures/seller-category-tree.json', import.meta.url), 'utf8'));

test('pausing an in-flight draft keeps its confirmed receipt so resume never creates the draft twice', async () => {
    const controller = new AbortController(), cached = new Map(); let finishWrite;
    const source = { variant_id: '900', skus: ['100'], categories: [{ id: 10, level: 1 }, { id: 170, level: 2 }],
        description_type_name: 'Лампа', description_type_dict_value: 231, attributes: [] };
    const harness = sellerHarness({ networkTimeoutMs: 1000, responses: [
        { status: 200, data: { variants: [source] } },
        { status: 200, data: { item: { origin_variant_id: '900', weight: 100, depth: 10, width: 20, height: 30, attributes: [] } } },
        { status: 200, data: { variants: [source] } },
    ], onRequest: request => request.path.includes('create-bundle') ? new Promise(resolve => { finishWrite = resolve; }) : undefined });
    const verification = { ...expected, sellerCompanyId: '123' };
    const capture = signal => captureSellerProduct({ sku: '100', verification, signal,
        request: (path, body) => harness.api.requestSellerProduct(path, body, verification, signal),
        cache: { get: key => cached.get(key), set: (key, value) => cached.set(key, value), delete: key => cached.delete(key) } });
    const pending = capture(controller.signal).catch(error => error);
    await until(() => Boolean(finishWrite));
    controller.abort(Object.assign(new Error('任务已暂停'), { code: 'ENRICHMENT_TASK_PAUSED' }));
    await turn(); finishWrite();
    const stopped = await pending;
    assert.equal(stopped.code, 'ENRICHMENT_TASK_PAUSED');
    assert.equal([...cached.values()][0].state, 'ready');
    assert.equal((await capture(new AbortController().signal)).weight, 100);
    assert.equal(harness.requests.filter(request => request.path.includes('create-bundle')).length, 1);
});

// Electron windows, cookies, and the network are the external boundaries. All
// Seller verification, retries, generated fetch code, and normalization are real.
function sellerHarness({ companyIds = ['123'], responses = [], sellerSwitcher, onShow, onRequest, timeoutMs = 100, networkTimeoutMs = 2, realIntervals = false, initialUrl, pendingInitialLoad = false, failedInitialLoad = false, origin = 'https://seller.ozon.ru', webBase = 'https://fixture.example', settings = new Map() } = {}) {
    let accountId = 'account-a';
    const windows = [], requests = [], logs = [], cookieSessions = new Map();
    const cookieReads = [];
    const selectedOrigin = () => api?.getSellerRoute().origin || origin;
    const partition = id => `persist:seller:${id}`;
    function getSession(key) {
        if (!cookieSessions.has(key)) {
            const cookies = Object.assign(new EventEmitter(), {
                values: key === partition('account-a') ? [...companyIds] : [],
                async get(filter) {
                    assert.equal(filter.name, 'sc_company_id');
                    cookieReads.push(filter.url);
                    assert.equal(filter.url, selectedOrigin() + '/');
                    return this.values.map(value => ({ value, name: 'sc_company_id', domain: new URL(selectedOrigin()).hostname }));
                },
            });
            cookieSessions.set(key, { cookies });
        }
        return cookieSessions.get(key);
    }
    class Window extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.visible = options.show;
            this.loads = 0;
            this.destroyed = false;
            this.url = '';
            this.webContents = Object.assign(new EventEmitter(), {
                session: getSession(options.webPreferences.partition),
                setWindowOpenHandler() {},
                getURL: () => this.url,
                isLoadingMainFrame: () => false,
                executeJavaScript: async script => new vm.Script(script).runInNewContext({
                    AbortController, setTimeout, clearTimeout, location: { origin: new URL(this.url).origin }, window: {},
                    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
                    document: { body: {}, querySelector: selector => {
                        if (!sellerSwitcher) return null;
                        if (selector === '[id^="tippy-"]') return sellerSwitcher.menuMounted || sellerSwitcher.requiresExpanded && sellerSwitcher.expanded
                            ? { innerText: sellerSwitcher.menuText || 'Добавить компанию' } : null;
                        const click = () => {
                            sellerSwitcher.expanded = !sellerSwitcher.expanded;
                            sellerSwitcher.clicks = (sellerSwitcher.clicks || 0) + 1;
                            sellerSwitcher.onToggle?.();
                        };
                        const button = { click: () => { if (!sellerSwitcher.hoverOnly) click(); } };
                        const toggle = { getAttribute: () => String(Boolean(sellerSwitcher.expanded)),
                            querySelector: () => sellerSwitcher.buttonOnly ? button : null,
                            click: () => { if (!sellerSwitcher.buttonOnly && !sellerSwitcher.hoverOnly) click(); },
                            dispatchEvent: event => {
                                sellerSwitcher.events ||= []; sellerSwitcher.events.push(event.type);
                                assert.equal(event.bubbles, false);
                                if (event.type === 'mouseenter' && !sellerSwitcher.expanded || event.type === 'mouseleave' && sellerSwitcher.expanded) click();
                            } };
                        return { innerText: sellerSwitcher.activeName, querySelector: () => toggle };
                    }, querySelectorAll: () => (sellerSwitcher?.requiresExpanded && !sellerSwitcher.expanded ? [] : sellerSwitcher?.entries || []).map(innerText => ({ innerText })) },
                    fetch: async (path, options) => {
                        const request = { path: new URL(path, selectedOrigin()).pathname, origin: new URL(path, selectedOrigin()).origin, companyId: options.headers['x-o3-company-id'], body: JSON.parse(options.body), partition: this.options.webPreferences.partition };
                        requests.push(request);
                        await onRequest?.(request, requests.length);
                        const response = responses.shift() || success(request.body.filter?.sku || '9988');
                        return {
                            ok: response.status >= 200 && response.status < 300,
                            status: response.status, redirected: false,
                            url: selectedOrigin() + '/api/data',
                            text: async () => response.text ?? JSON.stringify(response.data ?? { message: 'private upstream detail' }),
                            headers: { get: name => name === 'content-type' ? 'application/json' : '' },
                        };
                    },
                }),
            });
            windows.push(this);
            if (options.show) setImmediate(() => onShow?.(this));
        }
        loadURL(url) { this.loads += 1; this.url = this.loads === 1 && initialUrl ? initialUrl : url; return failedInitialLoad ? Promise.reject(new Error('initial navigation interrupted')) : pendingInitialLoad ? new Promise(() => {}) : Promise.resolve(); }
        show() { this.visible = true; setImmediate(() => onShow?.(this)); }
        focus() {}
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; this.emit('closed'); }
        navigate(url = selectedOrigin() + '/app/analytics') { this.url = url; this.webContents.emit('did-navigate-in-page', {}, url, true); this.webContents.emit('did-finish-load'); }
    }
    const context = vm.createContext({
        ...core, ...runtime, BrowserWindow: Window, withCollectorRequest,
        session: { fromPartition: getSession },
        runtimeConfig: { sellerCenterUrl: origin + '/app/analytics', sonliWebBase: webBase },
        getSonliApiBase: () => 'https://fixture.example/api',
        getSonliToken: () => 'test-token',
        operationStore: { get: key => key === 'user' ? { _id: accountId } : settings.get(key), set: (key, value) => settings.set(key, value) },
        getAccountPartition: (_type, id) => partition(id),
        log: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args), info: (...args) => logs.push(args) },
        URL, AbortController,
        setTimeout: (fn, ms) => setTimeout(fn, ms >= 45000 ? timeoutMs : ms === 35000 ? networkTimeoutMs : realIntervals ? ms : Math.min(ms, 2)), clearTimeout,
    });
    const api = vm.runInContext(source + '\n({ verifyCurrentSellerStore, fetchSellerSkuAnalytics, fetchSellerSkuAnalyticsBatch, fetchSellerLeaderboard, fetchSellerCategoryTree, requestSellerProduct, destroySellerWindow, getSellerRoute, selectSellerRoute, openSellerLoginWindow, getSellerSessionStatus })', context);
    function login(ids = ['123'], id = accountId) {
        const cookies = getSession(partition(id)).cookies;
        cookies.values = [...ids];
        cookies.emit('changed', {}, { name: 'sc_company_id', domain: 'seller.ozon.ru', value: ids[0] || '' }, 'explicit', false);
        windows.at(-1)?.navigate();
    }
    return {
        api, windows, requests, logs, login, cookieReads,
        switchAccount: id => { accountId = id; },
        removeCompanyCookie: () => { getSession(partition(accountId)).cookies.values = []; },
        setCompanyIds: ids => { getSession(partition(accountId)).cookies.values = [...ids]; },
        recoveryListeners: () => windows.reduce((count, win) => count + ['did-finish-load', 'did-navigate-in-page', 'did-fail-load'].reduce((sum, event) => sum + win.webContents.listenerCount(event), 0), 0)
            + [...cookieSessions.values()].reduce((sum, value) => sum + value.cookies.listenerCount('changed'), 0),
    };
}

async function until(check) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.fail('expected Seller recovery state was never reached');
}

test('first login resumes the same verification after sc_company_id is restored', async () => {
    const statuses = [];
    const harness = sellerHarness({ companyIds: [], onShow: () => harness.login() });
    const result = await harness.api.verifyCurrentSellerStore(expected, { onStatus: status => statuses.push(status) });
    assert.equal(result.accountId, 'account-a');
    assert.equal(result.sourceIdentity, 'seller-page:123');
    assert.equal(result.sellerCompanyId, '123');
    assert.ok(statuses.length > 0);
    assert.equal(harness.recoveryListeners(), 0);
});

test('silent category preload stays immediate and opens no window when logged out', async () => {
    const harness = sellerHarness({ companyIds: [] });
    await assert.rejects(harness.api.fetchSellerCategoryTree({ silent: true }), error => error.code === 'SELLER_LOGIN_REQUIRED');
    assert.equal(harness.windows.length, 0);
});

test('first-login wait cancels promptly and detaches window, cookie, and abort listeners', async () => {
    const controller = new AbortController();
    const harness = sellerHarness({ companyIds: [], onShow: () => controller.abort() });
    await assert.rejects(harness.api.verifyCurrentSellerStore(expected, { signal: controller.signal }), error => error.code === 'COLLECTION_CANCELLED');
    assert.equal(harness.recoveryListeners(), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('closing the Seller window ends login wait and removes recovery listeners', async () => {
    const harness = sellerHarness({ companyIds: [], onShow: win => win.destroy() });
    await assert.rejects(harness.api.verifyCurrentSellerStore(expected), error => error.code === 'SELLER_WINDOW_CLOSED');
    assert.equal(harness.recoveryListeners(), 0);
});

test('missing login times out with a bounded, actionable error and no listener leak', async () => {
    const harness = sellerHarness({ companyIds: [], timeoutMs: 20 });
    await assert.rejects(harness.api.verifyCurrentSellerStore(expected), error => error.code === 'SELLER_LOGIN_REQUIRED' && /超时/.test(error.message));
    assert.equal(harness.recoveryListeners(), 0);
});

test('switching account during first login cannot transfer the pending task', async () => {
    const harness = sellerHarness({ companyIds: [], onShow: () => { harness.switchAccount('account-b'); harness.login(['123']); } });
    await assert.rejects(harness.api.verifyCurrentSellerStore(), error => error.code === 'SELLER_SOURCE_CONTEXT_CHANGED');
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.recoveryListeners(), 0);
});

test('a real 401 followed by success retries the same SKU inside the original call', async () => {
    const statuses = [];
    const harness = sellerHarness({ responses: [{ status: 401 }, success('9988')] });
    const result = await harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected, onStatus: status => statuses.push(status) });
    assert.equal(result.item.id, '9988');
    assert.equal(result.item.soldCount, 42);
    assert.equal(result.verification.sourceIdentity, 'seller-page:123');
    assert.equal(harness.requests.length, 2);
    assert.deepEqual(harness.requests.map(item => item.body.filter.sku), ['9988', '9988']);
    assert.ok(statuses.some(item => item.status === 401));
    assert.equal(harness.windows[0].loads, 1);
});

test('persistent 403 waits for navigation before the final probe and preserves a safe HTTP error', async () => {
    const harness = sellerHarness({ responses: [{ status: 403 }, { status: 403 }, { status: 403, text: '<html>secret-login-token</html>' }] });
    const pending = harness.api.fetchSellerLeaderboard({ expectedContext: expected });
    pending.catch(() => {});
    await until(() => harness.requests.length === 2 && harness.recoveryListeners() > 0);
    await turn();
    assert.equal(harness.requests.length, 2, 'cookie presence alone must not trigger repeated API probes');
    assert.equal(harness.windows[0].visible, true);
    harness.windows[0].navigate();
    await assert.rejects(pending, error => error.code === 'SELLER_LOGIN_REQUIRED' && error.status === 403 && /HTTP 403/.test(error.message) && !/secret|<html>/.test(error.message));
    assert.equal(harness.requests.length, 3);
    assert.equal(harness.windows[0].loads, 1);
    assert.equal(harness.recoveryListeners(), 0);
    assert.doesNotMatch(JSON.stringify(harness.logs), /secret-login-token/);
});

test('manual login after repeated unauthorized responses returns real data in the same call', async () => {
    const harness = sellerHarness({ responses: [{ status: 403 }, { status: 403 }, success('9988')] });
    const pending = harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected });
    pending.catch(() => {});
    await until(() => harness.requests.length === 2 && harness.recoveryListeners() > 0);
    harness.login();
    const result = await pending;
    assert.equal(result.item.id, '9988');
    assert.equal(harness.requests.length, 3);
    assert.equal(harness.recoveryListeners(), 0);
});

test('manual recovery cancellation stops before a final request and removes listeners', async () => {
    const controller = new AbortController();
    const harness = sellerHarness({ responses: [{ status: 401 }, { status: 401 }] });
    const pending = harness.api.fetchSellerLeaderboard({ expectedContext: expected, signal: controller.signal });
    pending.catch(() => {});
    await until(() => harness.requests.length === 2 && harness.recoveryListeners() > 0);
    controller.abort();
    await assert.rejects(pending, error => error.code === 'COLLECTION_CANCELLED');
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.recoveryListeners(), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('changing Seller company during manual recovery blocks the final request', async () => {
    const harness = sellerHarness({ responses: [{ status: 403 }, { status: 403 }] });
    const pending = harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected });
    pending.catch(() => {});
    await until(() => harness.requests.length === 2 && harness.recoveryListeners() > 0);
    harness.login(['999']);
    await assert.rejects(pending, error => error.code === 'SELLER_SOURCE_CONTEXT_CHANGED');
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.recoveryListeners(), 0);
});

test('successful data cannot escape if the app account changes while the request is in flight', async () => {
    const harness = sellerHarness({ onRequest: () => harness.switchAccount('account-b') });
    await assert.rejects(harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected }), error => error.code === 'SELLER_SOURCE_CONTEXT_CHANGED');
    assert.equal(harness.requests.length, 1);
});

test('batch continues after recovery and keeps each SKU request in the original account and company', async () => {
    const harness = sellerHarness({ responses: [{ status: 401 }, success('9988'), success('9989')] });
    const items = await harness.api.fetchSellerSkuAnalyticsBatch(['9988', '9989'], { expectedContext: expected });
    assert.deepEqual(Array.from(items, item => item.id), ['9988', '9989']);
    assert.deepEqual(harness.requests.map(item => [item.body.filter.sku, item.companyId, item.partition]), [
        ['9988', '123', 'persist:seller:account-a'], ['9988', '123', 'persist:seller:account-a'], ['9989', '123', 'persist:seller:account-a'],
    ]);
});


test('authorization recovery timeout retains HTTP status even if company cookie expires', async () => {
    const harness = sellerHarness({ responses: [{ status: 401 }], timeoutMs: 20, onRequest: () => harness.removeCompanyCookie() });
    await assert.rejects(harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected }), error => error.status === 401 && /HTTP 401/.test(error.message) && /超时/.test(error.message));
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.recoveryListeners(), 0);
});

test('a subframe navigation cannot trigger the final permission probe', async () => {
    const harness = sellerHarness({ responses: [{ status: 403 }, { status: 403 }, success('9988')] });
    const pending = harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected });
    pending.catch(() => {});
    await until(() => harness.requests.length === 2 && harness.recoveryListeners() > 0);
    harness.windows[0].webContents.emit('did-navigate-in-page', {}, 'https://seller.ozon.ru/embedded', false);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(harness.requests.length, 2);
    harness.windows[0].navigate();
    assert.equal((await pending).item.id, '9988');
});

test('stale-cookie login redirects recover before the first analytics request', async () => {
    const harness = sellerHarness({ initialUrl: 'https://id.ozon.ru/login', onShow: win => win.navigate() });
    const result = await harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected });
    assert.equal(result.item.id, '9988');
    assert.equal(harness.requests.length, 1);
});

test('silent category reads stay hidden with stale-cookie redirects or HTTP 403', async () => {
    for (const options of [{ initialUrl: 'https://id.ozon.ru/login' }, { responses: [{ status: 403 }] }]) {
        const harness = sellerHarness(options);
        await assert.rejects(harness.api.fetchSellerCategoryTree({ silent: true }), error => ['SELLER_LOGIN_REQUIRED', 'SELLER_CATEGORY_TREE_FAILED'].includes(error.code));
        assert.ok(harness.windows.every(win => !win.visible));
        assert.equal(harness.recoveryListeners(), 0);
    }
});


test('cancelling or closing an initial navigation ends promptly without abort listener leaks', async () => {
    for (const reason of ['abort', 'close']) {
        const controller = new AbortController();
        const harness = sellerHarness({ pendingInitialLoad: true });
        const pending = harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected, signal: controller.signal });
        pending.catch(() => {});
        await until(() => harness.windows.length > 0);
        if (reason === 'abort') controller.abort();
        else harness.windows[0].destroy();
        await assert.rejects(pending, error => error.code === (reason === 'abort' ? 'COLLECTION_CANCELLED' : 'SELLER_WINDOW_CLOSED'));
        assert.equal(harness.requests.length, 0);
        assert.equal(harness.recoveryListeners(), 0);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
});

test('restored cookies with a different order cannot switch the selected Seller company', async () => {
    const harness = sellerHarness({ companyIds: ['123', '999'], responses: [{ status: 401 }, success('9988')], onRequest: () => harness.setCompanyIds(['999', '123']) });
    const result = await harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: { ...expected, sourceIdentity: 'seller-page:123,999', sellerCompanyId: '123' } });
    assert.equal(result.verification.sellerCompanyId, '123');
    assert.deepEqual(harness.requests.map(request => request.companyId), ['123', '123']);
});

test('HTTP 200 login HTML retains the observed status but cannot become an IPC success', async () => {
    const loginHtml = { status: 200, text: '<!DOCTYPE html><html>private-login-token</html>' };
    const harness = sellerHarness({ responses: [loginHtml, loginHtml, loginHtml] });
    const pending = harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected });
    pending.catch(() => {});
    await until(() => harness.requests.length === 2 && harness.recoveryListeners() > 0);
    harness.windows[0].navigate();
    await assert.rejects(pending, error => error.code === 'SELLER_LOGIN_REQUIRED' && error.status === 401 && error.httpStatus === 200 && /HTTP 200/.test(error.message) && !/private-login-token/.test(error.message));
});


test('an interrupted initial load cannot poison a later successful login in the same window', async () => {
    const harness = sellerHarness({ companyIds: [], failedInitialLoad: true, onShow: () => harness.login() });
    const result = await harness.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected });
    assert.equal(result.item.id, '9988');
    assert.equal(harness.windows.length, 1);
    assert.equal(harness.requests.length, 1);
});

test('concurrent collectors never overlap Seller draft creation requests', async () => {
    let release, active = 0, maximum = 0;
    const held = new Promise(resolve => { release = resolve; });
    const harness = sellerHarness({ networkTimeoutMs: 1000, onRequest: async () => { active++; maximum = Math.max(maximum, active); await held; active--; } });
    const requests = Array.from({ length: 4 }, () => harness.api.requestSellerProduct('/api/site/seller-prototype/create-bundle-by-variant-id', {}, { ...expected, sellerCompanyId: '123' }));
    await until(() => harness.requests.length > 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    const before = harness.requests.length;
    release(); await Promise.all(requests);
    assert.equal(before, 1, 'only one Seller draft can be in flight');
    assert.equal(maximum, 1);
    assert.equal(harness.requests.length, 4, 'every explicit request still completes');
});

test('analytics requests keep the shared Seller spacing even when several collectors queue at once', async () => {
    const times = [];
    const harness = sellerHarness({ realIntervals: true, networkTimeoutMs: 1000, onRequest: () => { times.push(Date.now()); } });
    await Promise.all(['9988','9989','9990'].map(sku => harness.api.fetchSellerSkuAnalytics(sku, { expectedContext: expected })));
    assert.equal(times.length, 3);
    assert.ok(times[1] - times[0] >= 180 && times[2] - times[1] >= 180, JSON.stringify(times));
});

test('cancelling a queued Seller draft rejects it as unsent and never creates it later', async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const harness = sellerHarness({ networkTimeoutMs: 1000, onRequest: () => held });
    const path = '/api/site/seller-prototype/create-bundle-by-variant-id';
    const verification = { ...expected, sellerCompanyId: '123' };
    const first = harness.api.requestSellerProduct(path, {}, verification);
    await until(() => harness.requests.length === 1);
    const controller = new AbortController();
    const second = harness.api.requestSellerProduct(path, {}, verification, controller.signal);
    const rejected = assert.rejects(second, error => error.requestSent === false && error.code === 'COLLECTION_CANCELLED');
    await turn(); controller.abort(); await rejected;
    release(); await first; await turn();
    assert.equal(harness.requests.length, 1);
});


test('China route uses its own origin for cookies, page and source identity', async () => {
    const h = sellerHarness({ origin: 'https://seller.ozonru.cn' });
    const result = await h.api.fetchSellerSkuAnalytics('9988', { expectedContext: { accountId: 'account-a' } });
    assert.equal(result.item.id, '9988');
    assert.equal(result.verification.sellerOrigin, 'https://seller.ozonru.cn');
    assert.equal(h.windows[0].url, 'https://seller.ozonru.cn/app/analytics');
    assert.ok(h.cookieReads.every(value => value === 'https://seller.ozonru.cn/'));
    assert.notEqual(result.verification.sourceIdentity, 'seller-page:123');
});

test('internal idle route application cannot silently reuse old route verification or change Web preference', async () => {
    const settings = new Map([['pending-draft', { state: 'pending' }], ['history', ['run-a']]]);
    const h = sellerHarness({ settings });
    const old = (await h.api.fetchSellerSkuAnalytics('9988', { expectedContext: expected })).verification;
    assert.equal(h.api.selectSellerRoute('https://seller.ozonru.cn').origin, 'https://seller.ozonru.cn');
    assert.equal(settings.has('seller-origin'), false);
    assert.equal(h.windows[0].destroyed, true);
    await assert.rejects(h.api.fetchSellerSkuAnalytics('9988', { expectedContext: old }), error => error.code === 'SELLER_SOURCE_CONTEXT_CHANGED');
    assert.deepEqual(settings.get('pending-draft'), { state: 'pending' });
    assert.deepEqual(settings.get('history'), ['run-a']);
    const restarted = sellerHarness({ settings });
    assert.equal(restarted.api.getSellerRoute().origin, 'https://seller.ozon.ru');
});

test('route switch refuses a running task or in-flight draft without destroying its window', async () => {
    let release;
    const h = sellerHarness({ networkTimeoutMs: 1000, onRequest: () => new Promise(resolve => { release = resolve; }) });
    assert.throws(() => h.api.selectSellerRoute('https://seller.ozonru.cn', { busy: true }), error => error.code === 'SELLER_ROUTE_BUSY' && error.status === 409);
    const pending = h.api.requestSellerProduct('/api/site/seller-prototype/create-bundle-by-variant-id', {}, { ...expected, sellerCompanyId: '123' });
    await until(() => Boolean(release));
    assert.throws(() => h.api.selectSellerRoute('https://seller.ozonru.cn'), error => error.code === 'SELLER_ROUTE_BUSY');
    assert.equal(h.windows[0].destroyed, false);
    release(); await pending;
    assert.equal(h.api.selectSellerRoute('https://seller.ozonru.cn').origin, 'https://seller.ozonru.cn');
});


test('explicit first login opens the selected official signin page without visiting analytics', async () => {
    for (const origin of ['https://seller.ozon.ru', 'https://seller.ozonru.cn']) {
        const h = sellerHarness({ origin, companyIds: [] });
        const status = await h.api.openSellerLoginWindow();
        assert.equal(h.windows[0].url, origin + '/app/registration/signin?registration=1&locale=zh-hans');
        assert.equal(h.windows[0].loads, 1);
        assert.equal(status.loggedIn, false);
        assert.equal(h.requests.length, 0);
    }
});

test('explicit login recovers a stale-cookie SSO landing in the same window', async () => {
    const h = sellerHarness({ origin: 'https://seller.ozonru.cn', initialUrl: 'https://sso.ozon.ru/session/initialize' });
    await h.api.openSellerLoginWindow();
    assert.equal(h.windows.length, 1);
    assert.equal(h.windows[0].url, 'https://seller.ozonru.cn/app/registration/signin?registration=1&locale=zh-hans');
    assert.equal(h.windows[0].loads, 2);
    assert.equal(h.requests.length, 0);
});

test('explicit login keeps a valid existing Seller analytics page on either route', async () => {
    for (const origin of ['https://seller.ozon.ru', 'https://seller.ozonru.cn']) {
        const h = sellerHarness({ origin });
        await h.api.fetchSellerSkuAnalytics('9988', { expectedContext: { accountId: 'account-a' } });
        await h.api.openSellerLoginWindow();
        assert.equal(h.windows[0].url, origin + '/app/analytics');
        assert.equal(h.windows[0].loads, 1);
    }
});

test('initial task verification also starts from official signin and resumes after manual login', async () => {
    let opened;
    const h = sellerHarness({ origin: 'https://seller.ozonru.cn', companyIds: [], onShow: win => { opened = win.url; h.login(); } });
    const result = await h.api.verifyCurrentSellerStore({ accountId: 'account-a' });
    assert.equal(opened, 'https://seller.ozonru.cn/app/registration/signin?registration=1&locale=zh-hans');
    assert.equal(result.sellerCompanyId, '123');
    assert.equal(h.requests.length, 0);
});


test('Seller status never treats a company cookie as authenticated without a successful same-origin read', async () => {
    const h = sellerHarness({ responses: [{ status: 401 }] });
    assert.equal((await h.api.getSellerSessionStatus()).loggedIn, false);
    const status = await h.api.getSellerSessionStatus({ verify: true });
    assert.equal(status.loggedIn, false);
    assert.equal(status.verification, null);
    assert.match(status.verificationError, /登录|权限/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].path, '/api/v1/seller-tree/get-by-company-id');
    assert.equal(h.windows[0].visible, false, 'status reads cannot open a login prompt');
});

test('Seller status confirms the effective route without presenting the store ID as a name', async () => {
    const h = sellerHarness({ origin: 'https://seller.ozonru.cn', responses: [{ status: 200, data: sellerTree }] });
    const status = await h.api.getSellerSessionStatus({ verify: true });
    assert.equal(status.loggedIn, true);
    assert.equal(status.origin, 'https://seller.ozonru.cn');
    assert.equal(status.verification.sellerCompanyId, '123');
    assert.equal(status.storeLabel, '店铺名称暂未获取');
    assert.equal(h.requests[0].origin, status.origin);
    assert.equal(h.requests[0].companyId, '123');
    await h.api.getSellerSessionStatus({ verify: true });
    assert.equal(h.requests.length, 1, 'frequent UI events reuse recent confirmed evidence');
    h.removeCompanyCookie();
    const cleared = await h.api.getSellerSessionStatus({ verify: true });
    assert.equal(cleared.loggedIn, false);
    assert.equal(cleared.storeLabel, '');
});

test('Seller status discards authentication returned after the account or current store changed', async () => {
    for (const change of ['account', 'store']) {
        let complete;
        const h = sellerHarness({ responses: [{ status: 200, data: sellerTree }], onRequest: () => new Promise(resolve => { complete = resolve; }) });
        const pending = h.api.getSellerSessionStatus({ verify: true });
        await until(() => Boolean(complete));
        if (change === 'account') h.switchAccount('account-b'); else h.setCompanyIds(['456']);
        complete();
        const status = await pending;
        assert.equal(status.loggedIn, false);
        assert.equal(status.verification, null);
        assert.equal(status.storeLabel, '');
        assert.match(status.verificationError, /变化/);
    }
});


test('Seller status cannot accept an HTTP 200 error envelope as authentication evidence', async () => {
    const h = sellerHarness({ responses: [{ status: 200, data: { code: 16, message: 'unauthenticated' } }] });
    const status = await h.api.getSellerSessionStatus({ verify: true });
    assert.equal(status.loggedIn, false);
    assert.equal(status.verification, null);
    assert.equal(status.storeLabel, '');
});


test('Seller status uses the actual Seller switcher name only when it maps uniquely to the authenticated store', async () => {
    for (const entry of ['实际店铺 Seller ID 1234', '实际店铺 Seller ID 5678', '']) {
        const h = sellerHarness({ companyIds: ['1234'], responses: [{ status: 200, data: sellerTree }],
            sellerSwitcher: { activeName: '实际店铺', entries: [entry] } });
        const status = await h.api.getSellerSessionStatus({ verify: true });
        assert.equal(status.loggedIn, true);
        assert.equal(status.storeLabel, entry.endsWith('1234') ? '实际店铺' : '店铺名称暂未获取');
    }
});

test('Seller status reads a normally unmounted switcher and restores its previous expanded state', async () => {
    for (const expanded of [false, true]) {
        const switcher = { activeName: '真实名称', entries: ['真实名称 Seller ID 1234'], expanded, requiresExpanded: true };
        const h = sellerHarness({ companyIds: ['1234'], responses: [{ status: 200, data: sellerTree }], sellerSwitcher: switcher });
        const status = await h.api.getSellerSessionStatus({ verify: true });
        assert.equal(status.storeLabel, '真实名称');
        assert.equal(switcher.expanded, expanded);
        assert.equal(switcher.clicks || 0, expanded ? 0 : 2);
    }
});

test('Seller name resolution rejects ambiguous stores and an identity changed while the menu opens', async () => {
    for (const scenario of ['ambiguous', 'changed']) {
        const switcher = { activeName: '重名店铺', entries: ['重名店铺 Seller ID 1234', '重名店铺 Seller ID 5678'], requiresExpanded: true };
        const h = sellerHarness({ companyIds: ['1234'], responses: [{ status: 200, data: sellerTree }], sellerSwitcher: switcher });
        if (scenario === 'changed') switcher.onToggle = () => h.switchAccount('account-b');
        const status = await h.api.getSellerSessionStatus({ verify: true });
        assert.notEqual(status.storeLabel, '重名店铺');
        assert.equal(status.loggedIn, scenario !== 'changed');
        assert.equal(Boolean(switcher.expanded), false);
    }
});

test('Seller route settings link follows the configured Web base and current account', async () => {
    const h = sellerHarness({ companyIds: [], webBase: 'https://fixture.example/tenant/base' });
    assert.equal((await h.api.getSellerSessionStatus()).routeSettingsUrl,
        'https://fixture.example/tenant/base/ozon/products/list/?ozonRoute=1&accountId=account-a');
    h.switchAccount('account-b');
    assert.equal((await h.api.getSellerSessionStatus()).routeSettingsUrl,
        'https://fixture.example/tenant/base/ozon/products/list/?ozonRoute=1&accountId=account-b');
});

test('the observed single-company Seller header provides its authenticated name without a Seller ID menu row', async () => {
    const switcher = { activeName: '现场公司名称', entries: [], requiresExpanded: true, menuText: 'Добавить компанию' };
    const h = sellerHarness({ companyIds: ['1234'], responses: [{ status: 200, data: sellerTree }], sellerSwitcher: switcher });
    const status = await h.api.getSellerSessionStatus({ verify: true });
    assert.equal(status.loggedIn, true);
    assert.equal(status.storeLabel, '现场公司名称');
    assert.equal(status.verification.sellerCompanyId, '1234');
    assert.equal(switcher.expanded, false, 'read-only lookup restores the user menu');
});

test('single-company header cannot survive a company change or override an unmatched multi-company list', async () => {
    for (const changed of [true, false]) {
        const switcher = { activeName: '原公司名称', entries: changed ? [] : ['其他公司 Seller ID 5678'], requiresExpanded: true };
        const h = sellerHarness({ companyIds: ['1234'], responses: [{ status: 200, data: sellerTree }], sellerSwitcher: switcher });
        if (changed) switcher.onToggle = () => h.setCompanyIds(['5678']);
        const status = await h.api.getSellerSessionStatus({ verify: true });
        assert.notEqual(status.storeLabel, '原公司名称');
        assert.equal(status.loggedIn, !changed);
    }
});

test('a missing or loading menu cannot prove a single-company header name', async () => {
    for (const menuText of ['', 'Загрузка...']) {
        const switcher = { activeName: '尚未确认名称', entries: [], requiresExpanded: Boolean(menuText), menuText };
        const h = sellerHarness({ companyIds: ['1234'], responses: [{ status: 200, data: sellerTree }], sellerSwitcher: switcher });
        const status = await h.api.getSellerSessionStatus({ verify: true });
        assert.equal(status.loggedIn, true, 'missing display metadata does not block authenticated collection');
        assert.equal(status.storeLabel, '店铺名称暂未获取');
    }
});

test('the real Seller hover menu opens and restores without ineffective synthetic clicks', async () => {
    const switcher = { activeName: '真实当前公司', entries: [], requiresExpanded: true, buttonOnly: true, hoverOnly: true };
    const h = sellerHarness({ companyIds: ['1234'], responses: [{ status: 200, data: sellerTree }], sellerSwitcher: switcher });
    const status = await h.api.getSellerSessionStatus({ verify: true });
    assert.equal(status.storeLabel, '真实当前公司');
    assert.equal(switcher.expanded, false);
    assert.equal(switcher.clicks, 2, 'the menu transitions once to open and once to restore');
    assert.deepEqual(switcher.events, ['mouseenter', 'mouseleave']);
});

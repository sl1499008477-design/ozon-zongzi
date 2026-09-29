import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeSellerUrl } from '../dist-electron/config/runtime.js';

const source = fs.readFileSync(new URL('../dist-electron/services/seller-ozon.services.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ settings = new Map(), account = 'a', base = 'https://app.example/api' } = {}) {
    let currentAccount = account, currentBase = base, requestedRoute = 'CN', failure = null, resolveRequest;
    let delay = false, closed = 0;
    const requests = [];
    const context = vm.createContext({ URL, normalizeSellerUrl, activeSellerOperations: 0,
        runtimeConfig: { sellerCenterUrl: 'https://seller.ozonru.cn/app/analytics' },
        accountIdentity: () => currentAccount,
        getSonliApiBase: () => currentBase,
        getSonliToken: () => `token-${currentAccount}`,
        operationStore: { get: key => settings.get(key), set: (key, value) => settings.set(key, value) },
        destroySellerWindow: () => { closed += 1; },
        sonliRequest: async request => {
            requests.push(request);
            if (delay) await new Promise(resolve => { resolveRequest = resolve; });
            if (failure) throw failure;
            return { route: requestedRoute, revision: 1, updatedAt: null,
                sellerOrigin: requestedRoute === 'CN' ? 'https://seller.ozonru.cn' : 'https://seller.ozon.ru',
                apiBase: requestedRoute === 'CN' ? 'https://api-seller.ozonru.cn' : 'https://api-seller.ozon.ru' };
        },
    });
    const start = source.indexOf('let appliedSellerScope');
    const api = vm.runInContext(source.slice(start < 0 ? source.indexOf('export function getSellerRoute(') : start,
        source.indexOf('\nfunction cancellationError(')).replace(/^export /gm, '')
        + '\n({ getSellerRoute, syncSellerRoute, acquireSellerRoute, rememberSellerRunRoute, getSellerRunRoute })', context);
    return { api, requests, settings, context, get closed() { return closed; },
        changeRoute: route => { requestedRoute = route; }, fail: status => { failure = Object.assign(new Error('offline'), { status }); },
        switchAccount: account => { currentAccount = account; }, switchBase: base => { currentBase = base; },
        delay: () => { delay = true; }, releaseRequest: () => resolveRequest() };
}

test('first sync uses account preference, ignores old global origin and pins collector identity', async () => {
    const f = fixture({ settings: new Map([['seller-origin', 'https://seller.ozon.ru']]) });
    const lease = await f.api.acquireSellerRoute();
    assert.equal(lease.origin, 'https://seller.ozonru.cn');
    assert.equal(f.api.getSellerRoute().synced, true);
    assert.equal(f.requests[0].url, '/collector/ozon-route');
    assert.equal(f.requests[0].expectedParentToken, 'token-a');
    lease.release();
});

test('active work keeps actual route while preference waits, and new work cannot silently take old route', async () => {
    const f = fixture(), first = await f.api.acquireSellerRoute();
    f.changeRoute('RU');
    const status = await f.api.syncSellerRoute();
    assert.equal(status.origin, 'https://seller.ozonru.cn');
    assert.equal(status.pendingOrigin, 'https://seller.ozon.ru');
    await assert.rejects(f.api.acquireSellerRoute(), error => error.code === 'SELLER_ROUTE_BUSY');
    assert.equal(f.closed, 0);
    first.release();
    const next = await f.api.acquireSellerRoute();
    assert.equal(next.origin, 'https://seller.ozon.ru');
    assert.equal(f.closed, 1);
    next.release(); next.release();
    assert.equal(f.api.getSellerRoute().busy, false);
});

test('saved run resumes original route after restart while new work takes account preference', async () => {
    const f = fixture(); f.changeRoute('RU');
    const old = await f.api.acquireSellerRoute();
    f.api.rememberSellerRunRoute('run-a', old.origin); old.release();
    f.changeRoute('CN'); await f.api.syncSellerRoute();
    const restarted = fixture({ settings: f.settings });
    const origin = restarted.api.getSellerRunRoute({ id: 'run-a' });
    assert.equal(origin, 'https://seller.ozon.ru');
    const resumed = await restarted.api.acquireSellerRoute({ origin });
    assert.equal(resumed.origin, 'https://seller.ozon.ru');
    resumed.release();
    const fresh = await restarted.api.acquireSellerRoute();
    assert.equal(fresh.origin, 'https://seller.ozonru.cn'); fresh.release();
});

test('offline cache stays within account and service, and a first unsynced account is blocked', async () => {
    const f = fixture(); f.changeRoute('RU'); await f.api.syncSellerRoute(); f.fail();
    const status = await f.api.syncSellerRoute();
    assert.equal(status.origin, 'https://seller.ozon.ru');
    assert.match(status.syncError, /上次|缓存/);
    f.switchAccount('b');
    await assert.rejects(f.api.acquireSellerRoute(), error => error.code === 'SELLER_ROUTE_UNSYNCED');
    f.switchAccount('a'); f.switchBase('https://another.example/api');
    await assert.rejects(f.api.acquireSellerRoute(), error => error.code === 'SELLER_ROUTE_UNSYNCED');
});

test('late response from prior login cannot populate the new account cache', async () => {
    const f = fixture(); f.delay();
    const pending = f.api.syncSellerRoute(); await turn(); f.switchAccount('b'); f.releaseRequest();
    await assert.rejects(pending, error => error.code === 'ACCOUNT_CHANGED');
    assert.equal(f.settings.size, 0);
});

test('a restored old run does not need network access or borrow another accounts saved run', async () => {
    const f = fixture(); f.changeRoute('RU');
    const lease = await f.api.acquireSellerRoute(); f.api.rememberSellerRunRoute('run-a', lease.origin); lease.release();
    const restarted = fixture({ settings: f.settings }); restarted.fail();
    const recovered = await restarted.api.acquireSellerRoute({ origin: restarted.api.getSellerRunRoute({ id: 'run-a' }) });
    assert.equal(recovered.origin, 'https://seller.ozon.ru'); recovered.release();
    restarted.switchAccount('b'); assert.equal(restarted.api.getSellerRunRoute({ id: 'run-a' }), '');
});

test('out-of-order sync replies cannot replace a newer account preference', async () => {
    const f = fixture(); let finishOld, reads = 0;
    f.context.sonliRequest = () => ++reads === 1 ? new Promise(resolve => { finishOld = resolve; })
        : Promise.resolve({ route: 'CN', sellerOrigin: 'https://seller.ozonru.cn', revision: 2 });
    const old = f.api.syncSellerRoute();
    await f.api.syncSellerRoute();
    finishOld({ route: 'RU', sellerOrigin: 'https://seller.ozon.ru', revision: 1 });
    await old;
    assert.equal(f.api.getSellerRoute().origin, 'https://seller.ozonru.cn');
});

test('authentication rejection cannot authorize fresh Seller work from cached account settings', async () => {
    for (const status of [401, 403]) {
        const f = fixture(); await f.api.syncSellerRoute(); f.fail(status);
        await assert.rejects(f.api.acquireSellerRoute(), error => error.status === status);
        assert.equal(f.api.getSellerRoute().busy, false);
    }
});

test('Seller IPC reads current login status while pending and refuses new analytics until idle', async () => {
    const f = fixture(), handlers = new Map(), reads = [];
    Object.assign(f.context, {
        ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
        TaskManager: { getInstance: () => ({ hasActiveWork: () => false }) },
        enrichmentWorker: { isBusy: () => false },
        getSellerSessionStatus: async () => { reads.push(f.api.getSellerRoute().origin); return { origin: reads.at(-1) }; },
        verifyCurrentSellerStore: async () => { reads.push(f.api.getSellerRoute().origin); return { origin: reads.at(-1) }; },
        fetchSellerSkuAnalytics: async () => { reads.push(f.api.getSellerRoute().origin); return { origin: reads.at(-1) }; },
        fetchSellerLeaderboard: async () => { reads.push(f.api.getSellerRoute().origin); return { origin: reads.at(-1) }; },
    });
    vm.runInContext(fs.readFileSync(new URL('../dist-electron/ipc/seller.ipc.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '') + '\nsellerIpc();', f.context);
    for (const channel of ['seller-session-status', 'seller-verify-store', 'seller-analytics-sku', 'seller-analytics-leaderboard']) {
        f.changeRoute('RU');
        assert.equal((await handlers.get(channel)({}, { sku: '123' })).data.origin, 'https://seller.ozon.ru');
        const running = await f.api.acquireSellerRoute();
        f.changeRoute('CN'); const count = reads.length;
        const pending = await handlers.get(channel)({}, { sku: '123' });
        if (channel === 'seller-session-status') {
            assert.equal(pending.data.origin, 'https://seller.ozon.ru');
            assert.equal(reads.length, count + 1);
        } else {
            assert.equal(pending.errorCode, 'SELLER_ROUTE_BUSY');
            assert.equal(reads.length, count);
        }
        running.release();
        assert.equal((await handlers.get(channel)({}, { sku: '123' })).data.origin, 'https://seller.ozonru.cn');
        assert.equal(f.api.getSellerRoute().busy, false);
    }
});

test('standalone category refresh synchronizes its route and cannot bypass a pending switch', async () => {
    const f = fixture(), reads = [];
    const context = vm.createContext({
        acquireSellerRoute: f.api.acquireSellerRoute,
        getAccountPartition: () => 'a', operationStore: { get() {}, set() {} },
        categoryTreeBaseline: { categories: [] },
        verifyCurrentSellerStore: async () => ({ sourceIdentity: f.api.getSellerRoute().origin }),
        fetchSellerCategoryTree: async () => { reads.push(f.api.getSellerRoute().origin); return { result: { node: { descriptionTypeId: 1, descriptionTypeName: 'test' } } }; },
    });
    const read = vm.runInContext(fs.readFileSync(new URL('../dist-electron/services/collection/interface.services.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\ngetCategoryList', context);
    f.changeRoute('RU');
    assert.equal((await read({ refresh: true })).source, 'live');
    assert.deepEqual(reads, ['https://seller.ozon.ru']);
    const running = await f.api.acquireSellerRoute(); f.changeRoute('CN');
    assert.match((await read({ refresh: true })).message, /等待当前采集/);
    assert.equal(reads.length, 1); running.release();
    assert.equal((await read({ refresh: true })).source, 'live');
    assert.equal(reads.at(-1), 'https://seller.ozonru.cn');
});

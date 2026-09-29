import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist-electron/services/collection/interface.services.js', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/seller-category-tree.json', import.meta.url), 'utf8'));
import { categoryTreeBaseline } from '../dist-electron/services/collection/category-tree-baseline.js';
const plain = value => JSON.parse(JSON.stringify(value));

function setup({ stored = new Map(), fetchTree = async () => structuredClone(fixture), mappings = [], seller = 'company-a' } = {}) {
    let account = 'account-a', company = seller, shown = 0, now = 1_800_000_000_000, reads = 0;
    const verification = () => ({ accountId: account, sellerCompanyId: company, sourceIdentity: `seller-page:${company}` });
    const context = vm.createContext({
        Date: class extends Date { static now() { return now; } },
        AbortController, Promise, Map, Set, categoryTreeBaseline,
        acquireSellerRoute: async () => ({ origin: 'https://seller.ozonru.cn', release() {} }),
        operationStore: { get: key => stored.get(key), set: (key, value) => stored.set(key, structuredClone(value)) },
        getAccountPartition: () => `persist:${account}:seller`,
        getCollectorCategoryMappings: async () => ({ mappings: typeof mappings === 'function' ? await mappings() : mappings }),
        getSonliState: async () => ({}),
        getSellerSessionStatus: async () => ({ loggedIn: !!company, verification: company ? verification() : null }),
        verifyCurrentSellerStore: async (expected, { silent = false } = {}) => {
            if (!company) {
                if (!silent) shown += 1;
                throw Object.assign(new Error('请先登录 Seller'), { code: 'SELLER_LOGIN_REQUIRED' });
            }
            if (expected?.accountId && (expected.accountId !== account || expected.sourceIdentity !== verification().sourceIdentity))
                throw Object.assign(new Error('Seller 来源已变化'), { code: 'SELLER_SOURCE_CONTEXT_CHANGED' });
            return verification();
        },
        fetchSellerCategoryTree: async options => { reads += 1; return fetchTree(options); },
    });
    const executable = source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '').replace(/^export /gm, '');
    const api = vm.runInContext(`${executable}\n({getCategoryList,resolveCollectorCategoryIds:typeof resolveCollectorCategoryIds==='function'?resolveCollectorCategoryIds:undefined})`, context);
    return { ...api, stored, reads: () => reads, shown: () => shown, switchAccount: (value, seller = company) => { account = value; company = seller; }, advance: ms => { now += ms; } };
}

test('first category read uses the live tree when the server has no learned mappings', async () => {
    const app = setup();
    const result = await app.getCategoryList();
    assert.equal(result.code, 400);
    assert.equal(result.source, 'live');
    const root = result.data.find(node => node.category_id === '15621031');
    assert.equal(root?.name, '服装');
    assert.deepEqual(plain(root.children[0].children.map(node => [node.category_id, node.name])), [
        ['93037', '蝴蝶'], ['93093', '鸭舌帽'], ['93099', '帽舌'],
    ], 'different type IDs must not collapse into one description category');
    assert.equal(app.reads(), 1);
});

test('cached categories survive restart, while manual refresh replaces the saved tree', async () => {
    const first = setup();
    const original = await first.getCategoryList();
    const changed = structuredClone(fixture);
    changed.result['15621031'].descriptionCategoryName = '服装（更新）';
    const restarted = setup({ stored: first.stored, fetchTree: async () => changed });
    const cached = await restarted.getCategoryList();
    assert.equal(cached.source, 'cache');
    assert.equal(restarted.reads(), 0);
    assert.equal(cached.fetchedAt, original.fetchedAt);
    restarted.advance(1000);
    const refreshed = await restarted.getCategoryList({ refresh: true });
    assert.equal(refreshed.source, 'live');
    assert.equal(refreshed.data[1].name, '服装（更新）');
    assert.ok(refreshed.fetchedAt > original.fetchedAt);
    assert.equal(restarted.reads(), 1);
});

test('cache is isolated by app account and Seller company', async () => {
    const app = setup();
    await app.getCategoryList();
    app.switchAccount('account-b');
    await app.getCategoryList();
    app.switchAccount('account-b', 'company-b');
    await app.getCategoryList();
    assert.equal(app.reads(), 3);
    app.switchAccount('account-a', 'company-a');
    assert.equal((await app.getCategoryList()).source, 'cache');
});

test('failed refresh keeps usable cached categories and exposes that they are stale', async () => {
    const first = setup();
    const original = await first.getCategoryList();
    const restarted = setup({ stored: first.stored, fetchTree: async () => { throw new Error('Seller 网络连接失败'); } });
    const result = await restarted.getCategoryList({ refresh: true });
    assert.equal(result.code, 400);
    assert.equal(result.stale, true);
    assert.equal(result.source, 'cache');
    assert.match(result.message, /网络连接失败/);
    assert.equal(result.fetchedAt, original.fetchedAt);
    assert.deepEqual(plain(result.data), plain(original.data));
});

test('cold-start failures preserve the baseline and an empty response is never cached as a complete tree', async () => {
    const empty = setup({ fetchTree: async () => ({ result: {} }) });
    const result = await empty.getCategoryList();
    assert.equal(result.code, 400);
    assert.equal(result.source, 'baseline');
    assert.equal(result.updateFailed, true);
    assert.ok(result.message);
    assert.equal(empty.stored.size, 0);
    const offline = setup({ fetchTree: async () => { throw new Error('请先登录 Seller'); } });
    assert.match((await offline.getCategoryList()).message, /登录/);
});

test('partial learned mappings never replace the full baseline during a tree outage', async () => {
    const app = setup({ fetchTree: async () => { throw new Error('类目接口不可用'); }, mappings: [
        { rootCategoryId: '15621031', rootCategoryName: '服装', leafCategoryId: '93037', leafCategoryName: '蝴蝶' },
    ] });
    const result = await app.getCategoryList();
    assert.equal(result.code, 400);
    assert.equal(result.source, 'baseline');
    assert.equal(result.stale, true);
    assert.match(result.message, /快照|基线/);
    assert.equal(result.data.length, 27);
});

test('selected parents expand to type IDs, while leaf paths do not submit their ancestors', async () => {
    const app = setup();
    assert.equal(typeof app.resolveCollectorCategoryIds, 'function');
    assert.deepEqual(plain(await app.resolveCollectorCategoryIds([['15621031']])), ['93037', '93093', '93099']);
    assert.deepEqual(plain(await app.resolveCollectorCategoryIds([['15621031', '41777465', '93099']])), ['93099']);
    assert.deepEqual(plain(await app.resolveCollectorCategoryIds([['15621031'], ['15621031', '41777465', '93099']])), ['93037', '93093', '93099']);
    assert.deepEqual(plain(await app.resolveCollectorCategoryIds([['__all__', '*']])), []);
    assert.deepEqual(plain(await app.resolveCollectorCategoryIds([])), []);
});

test('simultaneous readers share one in-flight tree request', async () => {
    let finish;
    const app = setup({ fetchTree: () => new Promise(resolve => { finish = resolve; }) });
    const a = app.getCategoryList(), b = app.getCategoryList();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.reads(), 1);
    finish(structuredClone(fixture));
    const results = await Promise.all([a, b]);
    assert.equal(results[0].source, 'live');
    assert.deepEqual(plain(results[0].data), plain(results[1].data));
});

test('a response from a previous account cannot become the active picker data', async () => {
    let finish;
    const app = setup({ fetchTree: () => new Promise(resolve => { finish = resolve; }) });
    const pending = app.getCategoryList();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof finish, 'function');
    app.switchAccount('account-b', 'company-b');
    finish(structuredClone(fixture));
    const result = await pending;
    assert.equal(result.code, 500);
    assert.match(result.message, /变化/);
    assert.equal(app.stored.size, 0);
});


test('expired category cache refreshes on the next normal read', async () => {
    const app = setup();
    await app.getCategoryList();
    app.advance(25 * 60 * 60 * 1000);
    const result = await app.getCategoryList();
    assert.equal(result.source, 'live');
    assert.equal(app.reads(), 2);
});

test('cancelling one waiting task does not cancel a shared picker refresh', async () => {
    let finish;
    const app = setup({ fetchTree: () => new Promise(resolve => { finish = resolve; }) });
    const picker = app.getCategoryList();
    const controller = new AbortController();
    const run = app.resolveCollectorCategoryIds([['15621031']], { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(run, error => error.code === 'COLLECTION_CANCELLED');
    finish(structuredClone(fixture));
    assert.equal((await picker).source, 'live');
    assert.equal(app.reads(), 1);
});


test('a failed response from an earlier Seller never returns baseline or saved categories after switching', async () => {
    let fail;
    const app = setup({ fetchTree: () => new Promise((_resolve, reject) => { fail = reject; }) });
    const pending = app.getCategoryList({ background: true });
    await new Promise(resolve => setImmediate(resolve));
    app.switchAccount('account-a', 'company-b');
    fail(new Error('类目接口 HTTP 403'));
    assert.equal((await pending).code, 500);
    assert.equal(app.stored.size, 0);
});

test('first installation reads the prepared category baseline without Seller login or network', async () => {
    const app = setup({ seller: null, fetchTree: async () => { throw new Error('network must not run'); } });
    const result = await app.getCategoryList({ localOnly: true });
    assert.equal(result.code, 400);
    assert.equal(result.source, 'baseline');
    assert.equal(result.snapshotDate, '2026-09-13');
    const roots = result.data.filter(node => node.category_id !== '__all__');
    assert.equal(roots.length, 26);
    const pet = roots.find(node => node.category_id === '17027487');
    assert.ok(pet.children.find(node => node.category_id === '17028668').children.some(node => node.category_id === '95224'));
    assert.equal(app.reads(), 0);
    assert.equal(app.shown(), 0);
    assert.equal(app.stored.size, 0, 'public baseline must not be saved as authenticated live data');
});

test('signed-out background updates keep the baseline usable without opening Seller', async () => {
    const app = setup({ seller: null });
    const initial = await app.getCategoryList({ localOnly: true });
    const result = await app.getCategoryList({ background: true });
    assert.equal(result.code, 400);
    assert.equal(result.source, 'baseline');
    assert.equal(result.updateFailed, true);
    assert.match(result.message, /登录/);
    assert.deepEqual(plain(result.data), plain(initial.data));
    assert.equal(app.shown(), 0);
    assert.equal(app.reads(), 0);
});

test('403 background refresh retains the baseline and retry replaces it with a live category tree', async () => {
    let offline = true;
    const app = setup({ fetchTree: async () => {
        if (offline) throw new Error('Ozon 类目读取失败（HTTP 403）');
        return structuredClone(fixture);
    } });
    const initial = await app.getCategoryList({ localOnly: true });
    const result = await app.getCategoryList({ background: true });
    assert.equal(result.code, 400);
    assert.equal(result.source, 'baseline');
    assert.equal(result.updateFailed, true);
    assert.deepEqual(plain(result.data), plain(initial.data));
    assert.match(result.message, /403/);
    assert.equal(app.stored.size, 0);
    offline = false;
    const retried = await app.getCategoryList({ background: true, refresh: true });
    assert.equal(retried.source, 'live');
    assert.equal(retried.data[1].children[0].children[0].category_id, '93037');
    assert.equal(app.shown(), 0);
});

test('local preload uses only the matching account and Seller cache, even when expired', async () => {
    const app = setup();
    await app.getCategoryList();
    app.advance(25 * 60 * 60 * 1000);
    const cached = await app.getCategoryList({ localOnly: true });
    assert.equal(cached.source, 'cache');
    assert.equal(cached.stale, true);
    assert.equal(app.reads(), 1);
    app.switchAccount('account-b');
    assert.equal((await app.getCategoryList({ localOnly: true })).source, 'baseline');
    app.switchAccount('account-a', 'company-b');
    assert.equal((await app.getCategoryList({ localOnly: true })).source, 'baseline');
    app.switchAccount('account-a', null);
    assert.equal((await app.getCategoryList({ localOnly: true })).source, 'baseline');
    assert.equal(app.shown(), 0);
    assert.equal(app.reads(), 1);
});

test('baseline parent selections expand to all snapshot leaf types during a category endpoint outage', async () => {
    const app = setup({ fetchTree: async () => { throw new Error('类目接口 HTTP 403'); } });
    const context = { accountId: 'account-a', sellerCompanyId: 'company-a', sourceIdentity: 'seller-page:company-a' };
    const ids = plain(await app.resolveCollectorCategoryIds([['17027487']], { expectedContext: context }));
    assert.equal(ids.length, 168);
    assert.ok(ids.includes('95224'));
    assert.equal(ids.includes('17027487'), false);
    assert.deepEqual(plain(await app.resolveCollectorCategoryIds([['17027487', '17028668', '95224'], ['990000000']], { expectedContext: context })), ['95224', '990000000']);
    app.switchAccount('account-a', null);
    await assert.rejects(app.resolveCollectorCategoryIds([['17027487']], { expectedContext: context }), error => error.code === 'SELLER_LOGIN_REQUIRED');
    assert.ok(app.shown() > 0, 'actual execution keeps the explicit Seller login behavior');
});


test('category IPC accepts only explicit boolean controls and discards renderer-supplied account context', async () => {
    const ipcSource = readFileSync(new URL('../dist-electron/ipc/collection.ipc.js', import.meta.url), 'utf8');
    const start = ipcSource.indexOf("ipcMain.handle('get-category-list',");
    const end = ipcSource.indexOf('\n    });', start) + '\n    });'.length;
    let handler;
    vm.runInNewContext(ipcSource.slice(start, end), {
        ipcMain: { handle: (_channel, callback) => { handler = callback; } },
        getCategoryList: async options => options,
    });
    const forged = { accountId: 'different-account', sourceIdentity: 'seller-page:999' };
    assert.deepEqual(plain(await handler(null, { refresh: 'true', localOnly: 1, background: 'true', expectedContext: forged })), {
        refresh: false, localOnly: false, background: false,
    });
    assert.deepEqual(plain(await handler(null, { refresh: true, localOnly: true, background: true, expectedContext: forged })), {
        refresh: true, localOnly: true, background: true,
    });
});

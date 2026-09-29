import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createEnrichmentWorker } from '../dist-electron/services/enrichment-worker.core.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('route IPC is read-only and checks active work before account sync or login', async () => {
    const handlers = new Map(), calls = [];
    let collecting = false, enriching = false;
    const context = vm.createContext({
        syncSellerRoute: async options => { calls.push(options); return { origin: 'https://seller.ozonru.cn', busy: options.busy }; },
        openSellerLoginWindow: async () => { calls.push('login'); return {}; },
        ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
        TaskManager: { getInstance: () => ({ hasActiveWork: () => collecting }) },
        enrichmentWorker: { isBusy: () => enriching },
    });
    vm.runInContext(read('../dist-electron/ipc/seller.ipc.js').replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '') + '\nsellerIpc();', context);
    assert.equal(handlers.has('seller-route-select'), false);
    for (const source of ['collection', 'enrichment']) {
        collecting = source === 'collection'; enriching = source === 'enrichment';
        assert.equal((await handlers.get('seller-route-status')({}, {})).data.busy, true);
        assert.equal(calls.at(-1).busy, true);
    }
    collecting = enriching = false;
    await handlers.get('seller-open-login')({}, {});
    assert.equal(calls.at(-2).busy, false);
    assert.equal(calls.at(-1), 'login');
    assert.doesNotMatch(read('../electron/preload.js'), /seller-route-select/);
});

test('enrichment reports busy while it checks and claims work before publishing working status', async () => {
    let release;
    const worker = createEnrichmentWorker({
        getIdentity: () => ({ accountId: 'a', parentToken: 'token' }),
        openSession: () => new Promise(resolve => { release = () => resolve(async () => ({ available: false })); }),
        verifySeller: async () => {}, capture: async () => {},
    });
    const pending = worker.runOnce();
    assert.equal(worker.isBusy(), true);
    release(); await pending;
    assert.equal(worker.isBusy(), false);
});

function panelUi() {
    const elements = [], listeners = new Map(), calls = [], windowListeners = new Map();
    let route = { origin: 'https://seller.ozon.ru', busy: false, loggedIn: false };
    const element = tag => {
        const node = { tag, dataset: {}, children: [], handlers: {}, hidden: false, isConnected: true,
            setAttribute() {}, append(...items) { this.children.push(...items); for (const child of items) child.parentNode = this; },
            insertAdjacentElement(_position, child) { this.parentNode.append(child); },
            remove() { this.parentNode = null; },
            addEventListener(name, callback) { this.handlers[name] = callback; } };
        elements.push(node); return node;
    };
    const sidebar = element('aside'), avatar = element('avatar'); sidebar.append(avatar);
    let currentAvatar = avatar;
    const api = { on: (name, callback) => { const handlers = listeners.get(name) || []; handlers.push(callback); listeners.set(name, handlers); }, async invoke(channel, data) {
        calls.push([channel, data]);
        if (channel === 'seller-route-status' || channel === 'seller-session-status') return { code: 200, data: await (typeof route === 'function' ? route() : route) };
        return { phase: 'idle', message: '已就绪' };
    } };
    let observer;
    const context = { window: { electronAPI: api, addEventListener: (name, cb) => windowListeners.set(name, cb) },
        document: { createElement: element, body: element('body'), querySelector: () => currentAvatar, hidden: false },
        MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
        setInterval() {}, Date };
    vm.runInNewContext(read('../dist/assets/enrichment-status.js'), context);
    const sellerScript = new URL('../dist/assets/seller-login-status.js', import.meta.url);
    if (fs.existsSync(sellerScript)) vm.runInNewContext(fs.readFileSync(sellerScript, 'utf8'), context);
    return { elements, calls, sidebar, avatar, setRoute: value => { route = value; },
        focus: () => windowListeners.get('focus')?.(),
        remount: () => { currentAvatar = element('avatar'); sidebar.append(currentAvatar); observer?.(); },
        event: async name => { for (const callback of listeners.get(name) || []) await callback({ status: 'running' }); } };
}
const uiTurn = () => new Promise(resolve => setImmediate(resolve));

test('Seller login lives below the avatar and displays only the actual confirmed store with pending route', async () => {
    const ui = panelUi(); await uiTurn();
    assert.equal(ui.elements.find(node => node.tag === 'select'), undefined);
    const login = ui.elements.find(node => node.textContent === '登录商家后台');
    assert.ok(login, 'the left sidebar exposes Seller login');
    assert.equal(login.parentNode.parentNode, ui.sidebar);
    assert.equal(ui.sidebar.children.indexOf(login.parentNode), ui.sidebar.children.indexOf(ui.avatar) + 1);
    assert.equal(login.hidden, false);
    assert.equal(ui.elements.some(node => node.textContent === '登录当前线路'), false);
    ui.setRoute({ origin: 'https://seller.ozon.ru', pendingOrigin: 'https://seller.ozonru.cn', busy: true,
        loggedIn: true, storeLabel: '店铺 ID 123', verification: { sellerCompanyId: '123' } });
    await ui.focus(); await uiTurn();
    assert.equal(login.hidden, true);
    assert.ok(ui.elements.some(node => /俄罗斯线路.*店铺 ID 123/.test(node.textContent || '')));
    assert.ok(ui.elements.some(node => /中国线路.*当前任务结束后生效/.test(node.textContent || '')));
    assert.ok(ui.calls.every(([channel]) => !/select|delete|cancel|resume|create/.test(channel)));
});

test('Seller sidebar clears previous identity when remounted and ignores the old response', async () => {
    const ui = panelUi(); await uiTurn();
    let finish;
    ui.setRoute(() => new Promise(resolve => { finish = resolve; }));
    const pending = ui.focus(); await uiTurn();
    assert.equal(typeof finish, 'function', 'focus rechecks the current Seller session');
    ui.remount();
    finish({ origin: 'https://seller.ozon.ru', loggedIn: true, storeLabel: '旧店铺 ID 123' });
    await pending; await uiTurn();
    assert.equal(ui.elements.some(node => /旧店铺 ID/.test(node.textContent || '')), false);
    assert.equal(ui.elements.find(node => node.textContent === '登录商家后台').hidden, false);
});

test('modify route opens the current account Web entry and clears a previous account link on remount', async () => {
    const ui = panelUi(); await uiTurn();
    const button = ui.elements.find(node => node.textContent === '修改线路');
    assert.ok(button, 'the sidebar exposes the shared Web route entry');
    assert.equal(button.disabled, true);
    const url = 'https://fixture.example/ozon/products/list/?ozonRoute=1&accountId=account-a';
    ui.setRoute({ origin: 'https://seller.ozonru.cn', loggedIn: true, storeLabel: '实际店铺', routeSettingsUrl: url });
    await ui.focus(); await uiTurn();
    await button.handlers.click();
    assert.deepEqual(ui.calls.at(-1), ['open-url', url]);
    ui.setRoute(() => new Promise(() => {}));
    ui.remount();
    assert.equal(button.disabled, true);
    const count = ui.calls.length;
    await button.handlers.click();
    assert.equal(ui.calls.length, count, 'an old account URL cannot be reopened after account remount');
});

test('enrichment releases its route after failure and success, including verification before a claim', async () => {
    for (const fail of [false, true]) {
        let released = 0;
        const worker = createEnrichmentWorker({ getIdentity: () => ({ accountId: 'a', parentToken: 'token' }),
            openSession: async () => async path => path.endsWith('/available') ? { available: true } : { job: null },
            verifySeller: async () => { if (fail) throw new Error('network'); return { sellerCompanyId: '123' }; },
            capture: async () => {}, releaseSeller: () => { released += 1; } });
        await worker.runOnce();
        assert.equal(released, 1);
        assert.equal(worker.isBusy(), false);
    }
});

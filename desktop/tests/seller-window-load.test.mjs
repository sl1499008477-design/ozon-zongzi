import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { withCollectorRequest } from '../dist-electron/services/collector-network.core.js';

const source = await readFile(new URL('../dist-electron/services/seller-ozon.services.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function windowAccess({ initialLoad = true, sellerPage = true, companyIds = ['123'], response = { ok: true, data: { result: {} } } } = {}) {
    let extraWaits = 0, shown = 0;
    const win = { show() { shown += 1; }, webContents: { getURL: () => sellerPage ? 'https://seller.ozon.ru/app/analytics' : 'https://id.ozon.ru/login' } };
    const context = vm.createContext({
        withCollectorRequest, activeSellerOperations: 0, sellerWindow: null,
        createSellerWindow: ({ show } = {}) => { if (show) shown += 1; return win; },
        throwIfAborted() {}, abortable: promise => promise, requestGate: async () => {},
        accountIdentity: () => 'account-a',
        getSellerCompanyIds: async () => companyIds, sellerSourceContext: () => ({ accountId: 'account-a', sourceIdentity: 'seller-page:123' }),
        assertSellerRunContext() {}, executeAnalyticsFetch: async () => response,
        // A resolved loadURL promise already represents did-finish-load.
        // isLoadingMainFrame may still be true in the same event turn, so a
        // second event wait can miss completion and time out on a usable page.
        sellerLoadPromise: initialLoad ? Promise.resolve() : null,
        waitForLoad: async () => { extraWaits += 1; if (initialLoad) throw new Error('duplicate load timeout'); },
        isSellerPage: value => new URL(value).hostname === 'seller.ozon.ru',
        getSellerSessionStatus: async () => ({ loggedIn: sellerPage }),
    });
    const ensure = vm.runInContext(section('async function ensureSellerWindow(', '\nasync function requestGate(') + '\nensureSellerWindow', context);
    const open = vm.runInContext(section('export async function openSellerLoginWindow(', '\nexport async function verifyCurrentSellerStore(').replace('export ', '') + '\nopenSellerLoginWindow', context);
    const verify = vm.runInContext(section('export async function verifyCurrentSellerStore(', '\nasync function executeAnalyticsFetch(').replace('export ', '') + '\nverifyCurrentSellerStore', context);
    const fetch = vm.runInContext(section('export async function fetchSellerCategoryTree(', '\nexport function destroySellerWindow(').replace('export ', '') + '\nfetchSellerCategoryTree', context);
    return { ensure, open, verify, fetch, win, waits: () => extraWaits, shown: () => shown };
}

test('first Seller load consumes loadURL completion once for fetch and visible login', async () => {
    const request = windowAccess();
    assert.equal(await request.ensure(), request.win);
    assert.equal(request.waits(), 0);
    const login = windowAccess();
    assert.equal((await login.open()).loggedIn, true);
    assert.equal(login.waits(), 0);
});

test('reused Seller window waits for its current navigation and login redirects remain explicit', async () => {
    const reused = windowAccess({ initialLoad: false });
    assert.equal(await reused.ensure(), reused.win);
    assert.equal(reused.waits(), 1);
    const loggedOut = windowAccess({ sellerPage: false });
    await assert.rejects(loggedOut.ensure(), error => error.code === 'SELLER_LOGIN_REQUIRED');
    assert.equal(loggedOut.shown(), 1);
});


test('silent category updates do not show Seller when signed out, redirected, or forbidden', async () => {
    for (const options of [
        { companyIds: [] },
        { sellerPage: false },
        { response: { ok: false, status: 403 } },
        { response: { ok: false, status: 401 } },
    ]) {
        const request = windowAccess(options);
        await assert.rejects(request.fetch({ silent: true }), error => ['SELLER_LOGIN_REQUIRED', 'SELLER_CATEGORY_TREE_FAILED'].includes(error.code));
        assert.equal(request.shown(), 0, JSON.stringify(options));
    }
});

test('normal category reads still show authentication failures', async () => {
    const forbidden = windowAccess({ response: { ok: false, status: 403 } });
    await assert.rejects(forbidden.fetch(), error => error.status === 403);
    assert.equal(forbidden.shown(), 1);
});

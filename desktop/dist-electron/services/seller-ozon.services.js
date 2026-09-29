import { BrowserWindow, session } from 'electron';
import { withCollectorRequest } from './collector-network.core.js';
import { runtimeConfig, normalizeSellerUrl } from '../config/runtime.js';
import { getAccountPartition } from './session.services.js';
import { operationStore } from '../store/index.js';
import { sonliRequest, getSonliApiBase, getSonliToken } from './sonli-api.services.js';
import {
    buildSellerLeaderboardPayload,
    buildSellerSkuPayload,
    assertSellerRunContext,
    isRetryableSellerFailure,
    normalizeSellerAnalyticsResponse,
    normalizeSellerCompanyId,
} from './seller-analytics.core.js';
import log from '../log/index.js';

const ANALYTICS_PATH = '/api/site/seller-analytics/what_to_sell/data/v3';
const MIN_REQUEST_INTERVAL_MS = 200;
const MAX_ATTEMPTS = 3;
const LOGIN_WAIT_MS = 120000;
let sellerWindow = null;
let sellerPartition = '';
let sellerLoadPromise = null;
let gateChain = Promise.resolve();
let lastRequestAt = 0;
let activeSellerOperations = 0;

let appliedSellerScope = '', appliedSellerOrigin = '', activeSellerRuns = 0;
let routeSyncError = '';

function sellerRouteScope() {
    return encodeURIComponent(JSON.stringify([getSonliApiBase(), accountIdentity()])).replace(/\./g, '%2E');
}

function routePreference() {
    return operationStore.get(`account-seller-route.${sellerRouteScope()}`) || null;
}

export function getSellerRoute({ busy = false } = {}) {
    const configured = new URL(runtimeConfig.sellerCenterUrl);
    const saved = routePreference();
    const origin = appliedSellerScope === sellerRouteScope() && appliedSellerOrigin
        ? appliedSellerOrigin : saved?.sellerOrigin || configured.origin;
    return { origin, centerUrl: origin + configured.pathname + configured.search,
        busy: Boolean(busy || activeSellerOperations || activeSellerRuns), synced: Boolean(saved),
        pendingOrigin: saved?.sellerOrigin && saved.sellerOrigin !== origin ? saved.sellerOrigin : '',
        syncError: routeSyncError };
}

export function selectSellerRoute(value, { busy = false } = {}) {
    const origin = new URL(normalizeSellerUrl(value)).origin;
    const current = getSellerRoute({ busy });
    if (origin !== current.origin && current.busy) throw Object.assign(new Error('Web 线路设置已更新，请等待当前采集和资料补全结束后再开始新任务'), {
        code: 'SELLER_ROUTE_BUSY', status: 409,
    });
    appliedSellerScope = sellerRouteScope();
    appliedSellerOrigin = origin;
    if (origin !== current.origin) destroySellerWindow();
    return getSellerRoute();
}

export async function syncSellerRoute({ busy = false, signal, apply = true } = {}) {
    const scope = sellerRouteScope(), token = getSonliToken();
    if (!accountIdentity() || !token)
        throw Object.assign(new Error('请先登录 ozon 粽子账号以同步线路'), { code: 'SELLER_ACCOUNT_REQUIRED' });
    // Save the actual window origin before replacing its account preference.
    if (appliedSellerScope !== scope && !activeSellerRuns) {
        appliedSellerOrigin = getSellerRoute().origin;
        appliedSellerScope = scope;
        routeSyncError = '';
    }
    try {
        const preference = await sonliRequest({ method: 'GET', url: '/collector/ozon-route',
            expectedParentToken: token, signal, quiet: true });
        if (scope !== sellerRouteScope() || token !== getSonliToken())
            throw Object.assign(new Error('登录账号已变化，请重新同步线路'), { code: 'ACCOUNT_CHANGED' });
        const origin = preference?.route === 'CN' ? 'https://seller.ozonru.cn'
            : preference?.route === 'RU' ? 'https://seller.ozon.ru' : '';
        if (!origin || preference.sellerOrigin !== origin)
            throw new Error('线路设置响应无效');
        if (Number(preference.revision) >= Number(routePreference()?.revision || 0))
            operationStore.set(`account-seller-route.${scope}`, preference);
        routeSyncError = '';
    } catch (error) {
        if (scope !== sellerRouteScope() || token !== getSonliToken() || error.code === 'ACCOUNT_CHANGED')
            throw Object.assign(new Error('登录账号已变化，请重新同步线路'), { code: 'ACCOUNT_CHANGED' });
        if (signal?.aborted) throw signal.reason || error;
        if ([401, 403].includes(Number(error.status))) throw error;
        if (!routePreference()) {
            routeSyncError = '尚未同步该账号的线路，请检查连接后重试';
            throw Object.assign(new Error(routeSyncError), { code: 'SELLER_ROUTE_UNSYNCED' });
        }
        routeSyncError = '线路同步失败，暂用该账号上次同步的设置';
    }
    if (apply && !getSellerRoute({ busy }).busy) selectSellerRoute(routePreference().sellerOrigin);
    return getSellerRoute({ busy });
}

// One Seller window is shared by collection and enrichment. Keep a route lease
// for the entire run, including gaps between its individual HTTP requests.
export async function acquireSellerRoute({ origin = '', signal } = {}) {
    if (!accountIdentity() || !getSonliToken())
        throw Object.assign(new Error('请先登录 ozon 粽子账号以同步线路'), { code: 'SELLER_ACCOUNT_REQUIRED' });
    if (!origin) await syncSellerRoute({ signal, apply: false });
    signal?.throwIfAborted();
    if (activeSellerRuns && appliedSellerScope !== sellerRouteScope())
        throw Object.assign(new Error('上一账号任务尚未结束，请稍后重试'), { code: 'ACCOUNT_CHANGED' });
    const actual = selectSellerRoute(origin || routePreference().sellerOrigin);
    activeSellerRuns += 1;
    let released = false;
    return { origin: actual.origin, release() { if (!released) { released = true; activeSellerRuns -= 1; } } };
}

export function rememberSellerRunRoute(runId, origin) {
    operationStore.set(`seller-run-route.${sellerRouteScope()}.${encodeURIComponent(runId).replace(/\./g, '%2E')}`,
        new URL(normalizeSellerUrl(origin)).origin);
}

export function getSellerRunRoute(run = {}) {
    return operationStore.get(`seller-run-route.${sellerRouteScope()}.${encodeURIComponent(run.id || run.runId || '').replace(/\./g, '%2E')}`)
        || run.configurationSnapshot?.ozonRoute?.sellerOrigin || run.configurationSnapshot?.sourceContext?.sellerOrigin || '';
}

function cancellationError() {
    const error = new Error('采集任务已取消');
    error.code = 'COLLECTION_CANCELLED';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted)
        throw cancellationError();
}

function sellerWindowClosedError() {
    const error = new Error('Seller 窗口已关闭，采集任务已停止');
    error.code = 'SELLER_WINDOW_CLOSED';
    return error;
}

function abortable(promise, signal, win = null, timeoutMs = 0) {
    throwIfAborted(signal);
    if (win?.isDestroyed())
        return Promise.reject(sellerWindowClosedError());
    if (!signal && !win && !timeoutMs)
        return promise;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            win?.off('closed', onClosed);
            error ? reject(error) : resolve(value);
        };
        const onAbort = () => finish(cancellationError());
        const onClosed = () => finish(sellerWindowClosedError());
        const timer = timeoutMs ? setTimeout(() => {
            const error = new Error('Seller Ozon 操作超时，请检查卖家中心页面后重试');
            error.code = 'TIMEOUT';
            finish(error);
        }, timeoutMs) : null;
        signal?.addEventListener('abort', onAbort, { once: true });
        win?.once('closed', onClosed);
        Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
    });
}

function accountIdentity() {
    const user = operationStore.get('user') || {};
    return String(user._id || user.id || user.phone || '');
}

function sellerSourceContext(companyIds) {
    const accountId = accountIdentity();
    if (!accountId) {
        const error = new Error('请先登录 ozon 粽子账号');
        error.code = 'SELLER_ACCOUNT_REQUIRED';
        throw error;
    }
    return {
        accountId,
        source: 'ozon_seller_analytics',
        sellerOrigin: getSellerRoute().origin,
        sourceIdentity: `seller-page:${getSellerRoute().origin === 'https://seller.ozon.ru' ? '' : getSellerRoute().origin + ':'}${[...companyIds].map(normalizeSellerCompanyId).filter(Boolean).sort().join(',')}`,
    };
}

function isOzonHttps(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' && !url.username && !url.password && !url.port
            && (url.origin === getSellerRoute().origin
                || (url.hostname !== 'seller.ozon.ru' && (url.hostname === 'ozon.ru' || url.hostname.endsWith('.ozon.ru'))));
    }
    catch {
        return false;
    }
}

function isSellerPage(value) {
    try {
        const url = new URL(String(value || ''));
        return url.origin === getSellerRoute().origin && !url.username && !url.password;
    }
    catch {
        return false;
    }
}

function waitForLoad(win, timeoutMs = 45000, signal) {
    throwIfAborted(signal);
    if (!win || win.isDestroyed())
        return Promise.reject(sellerWindowClosedError());
    if (!win.webContents.isLoadingMainFrame())
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            win.webContents.off('did-finish-load', onLoaded);
            win.webContents.off('did-fail-load', onFailed);
            win.off('closed', onClosed);
            signal?.removeEventListener('abort', onAbort);
            error ? reject(error) : resolve();
        };
        const onLoaded = () => finish();
        const onClosed = () => finish(sellerWindowClosedError());
        const onAbort = () => finish(cancellationError());
        const onFailed = (_event, code, _description, _url, isMainFrame) => {
            if (isMainFrame !== false)
                finish(new Error(`Seller Ozon 页面加载失败：${code}`));
        };
        const timer = setTimeout(() => finish(new Error('Seller Ozon 页面加载超时')), timeoutMs);
        win.webContents.once('did-finish-load', onLoaded);
        win.webContents.on('did-fail-load', onFailed);
        win.once('closed', onClosed);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function currentPartition() {
    return getAccountPartition('seller', accountIdentity());
}

function loadSellerWindow(win, url) {
    sellerLoadPromise = win.loadURL(url).catch(() => {
        if (sellerWindow === win)
            sellerLoadPromise = null;
        throw new Error('打开 Seller Ozon 失败，请检查网络连接');
    });
    // Login observes page events; keep an interrupted navigation handled.
    sellerLoadPromise.catch(() => {});
}

function createSellerWindow({ show = true, login = false } = {}) {
    const partition = currentPartition();
    const targetUrl = login ? getSellerRoute().origin + '/app/registration/signin?registration=1&locale=zh-hans' : getSellerRoute().centerUrl;
    if (sellerWindow && !sellerWindow.isDestroyed() && sellerPartition !== partition)
        sellerWindow.destroy();
    if (sellerWindow && !sellerWindow.isDestroyed()) {
        if (login && sellerWindow.webContents.getURL() !== targetUrl)
            loadSellerWindow(sellerWindow, targetUrl);
        if (show) {
            sellerWindow.show();
            sellerWindow.focus();
        }
        return sellerWindow;
    }
    sellerPartition = partition;
    sellerWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 960,
        minHeight: 640,
        show,
        autoHideMenuBar: true,
        title: 'Ozon 卖家中心 - ozon 粽子',
        webPreferences: {
            partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
        },
    });
    const win = sellerWindow;
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isOzonHttps(url)) {
            win.loadURL(url).catch(() => log.warn('Seller Ozon 跳转失败'));
        }
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (!isOzonHttps(url)) {
            event.preventDefault();
            log.warn('已拦截 Seller Ozon 非官方导航');
        }
    });
    win.once('closed', () => {
        if (sellerWindow !== win)
            return;
        sellerWindow = null;
        sellerPartition = '';
        sellerLoadPromise = null;
    });
    loadSellerWindow(win, targetUrl);
    return sellerWindow;
}

async function ensureSellerWindow({ show = false, silent = false, signal } = {}) {
    const win = createSellerWindow({ show });
    if (sellerLoadPromise) {
        // loadURL already resolves on did-finish-load. Waiting for that event
        // again can miss it before Electron clears isLoadingMainFrame().
        const pendingLoad = sellerLoadPromise;
        await abortable(pendingLoad, signal, win, 45000);
        if (sellerLoadPromise === pendingLoad)
            sellerLoadPromise = null;
    }
    else {
        await waitForLoad(win, 45000, signal);
    }
    if (!isSellerPage(win.webContents.getURL())) {
        const error = new Error('请先在 Ozon 卖家中心完成登录');
        error.code = 'SELLER_LOGIN_REQUIRED';
        if (!show && !silent)
            win.show();
        throw error;
    }
    return win;
}

async function requestGate() {
    const wait = gateChain.then(async () => {
        const elapsed = Date.now() - lastRequestAt;
        if (elapsed < MIN_REQUEST_INTERVAL_MS)
            await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
        lastRequestAt = Date.now();
    });
    gateChain = wait.catch(() => {});
    return wait;
}

export async function getSellerCompanyIds() {
    activeSellerOperations += 1;
    try {
        const partitionSession = session.fromPartition(currentPartition());
        const cookies = await partitionSession.cookies.get({
            url: getSellerRoute().origin + '/',
            name: 'sc_company_id',
        });
        return [...new Set(cookies
            .map((cookie) => normalizeSellerCompanyId(cookie.value))
            .filter(Boolean))];
    } finally { activeSellerOperations -= 1; }
}

// Recent evidence is scoped to the actual Seller session, never to the Web store selection.
let sellerSessionEvidence = null;
async function readSellerStoreName(win, origin, sellerCompanyId) {
    // Reuse the extension's read-only switcher lookup. Opening the menu mounts
    // its entries; never select a store. Match IDs when available, otherwise only
    // accept the observed single-company header under the session checks below.
    try {
        return await win.webContents.executeJavaScript(String.raw`(async () => {
            if (location.origin !== ${JSON.stringify(origin)}) return '';
            const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
            const header = document.querySelector('[data-onboarding-target="headerCompanyName"]');
            const name = normalize(header?.innerText || header?.textContent);
            if (!name) return '';
            const readEntries = () => [...document.querySelectorAll('[id^="tippy-"] *')]
                .map(node => normalize(node.innerText || node.textContent));
            const toggle = header.querySelector('[aria-expanded]') || header;
            const wasExpanded = toggle.getAttribute?.('aria-expanded') === 'true';
            let opened = false;
            try {
                let entries = readEntries();
                if (!entries.some(text => /Seller ID\s+\d/.test(text)) && !wasExpanded) {
                    toggle.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, view: window })); opened = true;
                    const deadline = Date.now() + 1000;
                    do {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        entries = readEntries();
                        const menu = document.querySelector('[id^="tippy-"]');
                        const ready = entries.some(text => /Seller ID\s+\d/.test(text))
                            || normalize(menu?.innerText || menu?.textContent) === 'Добавить компанию';
                        if (toggle.getAttribute?.('aria-expanded') === 'true' && ready) break;
                    } while (Date.now() < deadline);
                }
                const currentHeader = document.querySelector('[data-onboarding-target="headerCompanyName"]');
                if (location.origin !== ${JSON.stringify(origin)} || normalize(currentHeader?.innerText || currentHeader?.textContent) !== name) return '';
                const ids = new Set(entries.map(text => {
                    const match = /^(.+?)\s*Seller ID\s+(\d{4,15})$/.exec(text);
                    return match && normalize(match[1]) === name ? match[2] : '';
                }).filter(Boolean));
                if (entries.some(text => /Seller ID\s+\d/.test(text)))
                    return ids.size === 1 && ids.has(${JSON.stringify(sellerCompanyId)}) ? name : '';
                // The observed single-company Seller menu contains only this
                // action, with no ID row. A missing/loading menu is not evidence.
                const menu = document.querySelector('[id^="tippy-"]');
                return toggle.getAttribute?.('aria-expanded') === 'true'
                    && normalize(menu?.innerText || menu?.textContent) === 'Добавить компанию' ? name : '';
            } finally {
                if (opened) {
                    toggle.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, view: window, relatedTarget: document.body }));
                    const deadline = Date.now() + 1000;
                    while (toggle.getAttribute?.('aria-expanded') === 'true' && Date.now() < deadline)
                        await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        })()`, true);
    } catch { return ''; }
}
export async function getSellerSessionStatus({ verify = false } = {}) {
    activeSellerOperations += 1;
    const scope = sellerRouteScope(), token = getSonliToken(), origin = getSellerRoute().origin;
    try {
        const companyIds = await getSellerCompanyIds();
        const sellerCompanyId = companyIds[0] || '';
        const evidenceKey = JSON.stringify([scope, token, origin, companyIds]);
        if (sellerSessionEvidence?.key !== evidenceKey || Date.now() - sellerSessionEvidence.checkedAt > 30000)
            sellerSessionEvidence = null;
        let verification = sellerSessionEvidence?.verification || null;
        let storeName = sellerSessionEvidence?.storeName || '';
        let verificationError = '';
        if (verify && sellerCompanyId && !verification) {
            try {
                const expected = { ...sellerSourceContext(companyIds), companyIds, sellerCompanyId };
                const win = await ensureSellerWindow({ show: false, silent: true });
                const response = await withCollectorRequest(async () => {
                    await requestGate();
                    return executeAnalyticsFetch(win, sellerCompanyId,
                        { company_id: sellerCompanyId }, '/api/v1/seller-tree/get-by-company-id');
                });
                if (!response?.ok || !response.data?.result || typeof response.data.result !== 'object')
                    throw new Error([401, 403].includes(Number(response?.status))
                        ? '商家后台登录未完成或无访问权限，请打开当前线路商家后台确认'
                        : '暂时无法确认商家后台登录状态，请检查连接后重试');
                storeName = await readSellerStoreName(win, origin, sellerCompanyId);
                const currentIds = await getSellerCompanyIds();
                if (scope !== sellerRouteScope() || token !== getSonliToken() || origin !== getSellerRoute().origin
                    || JSON.stringify(companyIds) !== JSON.stringify(currentIds))
                    throw new Error('账号、线路或当前店铺已变化，请重新确认商家后台登录');
                verification = expected;
                sellerSessionEvidence = { key: evidenceKey, verification, storeName, checkedAt: Date.now() };
            }
            catch (error) {
                sellerSessionEvidence = null;
                verificationError = error?.code === 'SELLER_LOGIN_REQUIRED'
                    ? '商家后台登录未完成，请登录当前线路'
                    : error.message;
            }
        }
        if (scope !== sellerRouteScope() || token !== getSonliToken() || origin !== getSellerRoute().origin) {
            sellerSessionEvidence = null;
            verification = null;
            verificationError = '账号或线路已变化，请重新确认商家后台登录';
        }
        const routeSettingsUrl = new URL(`${runtimeConfig.sonliWebBase}/ozon/products/list/`);
        routeSettingsUrl.searchParams.set('ozonRoute', '1');
        routeSettingsUrl.searchParams.set('accountId', accountIdentity());
        return {
            ...getSellerRoute(),
            loggedIn: Boolean(verification),
            companyIds,
            verification,
            storeLabel: verification ? storeName || '店铺名称暂未获取' : '',
            routeSettingsUrl: routeSettingsUrl.toString(),
            verificationError,
            windowOpen: Boolean(sellerWindow && !sellerWindow.isDestroyed()),
        };
    } finally { activeSellerOperations -= 1; }
}

export async function openSellerLoginWindow() {
    sellerSessionEvidence = null;
    activeSellerOperations += 1;
    try {
        const companyIds = await getSellerCompanyIds();
        const needsLogin = !companyIds.length || Boolean(sellerWindow && !sellerWindow.isDestroyed()
            && !isSellerPage(sellerWindow.webContents.getURL()));
        const win = createSellerWindow({ show: true, login: needsLogin });
        if (sellerLoadPromise) {
            await sellerLoadPromise.catch(() => {});
            sellerLoadPromise = null;
        }
        else {
            await waitForLoad(win).catch(() => {});
        }
        // Existing company cookies can be stale: analytics may land on SSO
        // instead of the selected Seller. The explicit login action uses the
        // official signin page once, without submitting credentials or forms.
        if (!needsLogin && !isSellerPage(win.webContents.getURL())) {
            createSellerWindow({ show: true, login: true });
            if (sellerLoadPromise) {
                await sellerLoadPromise.catch(() => {});
                sellerLoadPromise = null;
            }
        }
        return await getSellerSessionStatus({ verify: false });
    } finally { activeSellerOperations -= 1; }
}

function sellerLoginError(failure = {}, phase = 'seller_authentication') {
    const status = Number(failure?.httpStatus ?? failure?.status ?? 0);
    const detail = phase.endsWith('_timeout')
        ? '等待 Seller 登录超时，请完成登录或确认选品分析权限后重试'
        : 'Ozon 卖家中心登录未完成或无权访问选品分析，请在卖家窗口确认后重试';
    const error = new Error(`${detail}${status ? `（HTTP ${status}）` : ''}`);
    error.code = 'SELLER_LOGIN_REQUIRED';
    error.status = status >= 400 ? status : Number(failure?.status || 0);
    error.httpStatus = status;
    error.phase = phase;
    return error;
}

async function readSellerVerification(expectedContext, signal) {
    throwIfAborted(signal);
    assertSellerRunContext({ accountId: accountIdentity() }, { accountId: expectedContext.accountId });
    const companyIds = await abortable(getSellerCompanyIds(), signal);
    const result = {
        ...sellerSourceContext(companyIds),
        companyIds,
        sellerCompanyId: String(companyIds.find(id => id === expectedContext.sellerCompanyId) || companyIds[0] || ''),
    };
    assertSellerRunContext(result, { accountId: expectedContext.accountId });
    if (!companyIds.length)
        return null;
    assertSellerRunContext(result, expectedContext);
    return result;
}

function waitForSellerSession(win, expectedContext, options = {}, {
    requireNavigation = false, failure = null, deadline = Date.now() + LOGIN_WAIT_MS,
} = {}) {
    const { signal, onStatus } = options;
    throwIfAborted(signal);
    if (win.isDestroyed())
        return Promise.reject(sellerWindowClosedError());
    return new Promise((resolve, reject) => {
        let settled = false;
        let navigated = !requireNavigation;
        const cookies = win.webContents.session.cookies;
        const finish = (error, verification) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            win.webContents.off('did-finish-load', onNavigation);
            win.webContents.off('did-navigate-in-page', onNavigation);
            cookies.off('changed', onCookieChanged);
            win.off('closed', onClosed);
            signal?.removeEventListener('abort', onAbort);
            error ? reject(error) : resolve(verification);
        };
        const check = async () => {
            if (settled)
                return;
            try {
                const verification = await readSellerVerification(expectedContext, signal);
                if (!settled && verification && navigated && isSellerPage(win.webContents.getURL()))
                    finish(null, verification);
            }
            catch (error) {
                finish(error);
            }
        };
        const onNavigation = (_event, _url, isMainFrame) => {
            if (isMainFrame === false)
                return;
            navigated = true;
            void check();
        };
        const onCookieChanged = (_event, cookie) => {
            if (cookie?.name === 'sc_company_id')
                void check();
        };
        const onClosed = () => finish(sellerWindowClosedError());
        const onAbort = () => finish(cancellationError());
        const timer = setTimeout(() => finish(sellerLoginError(failure,
            failure ? 'seller_recovery_timeout' : 'seller_login_timeout')), Math.max(0, deadline - Date.now()));
        win.webContents.on('did-finish-load', onNavigation);
        win.webContents.on('did-navigate-in-page', onNavigation);
        cookies.on('changed', onCookieChanged);
        win.once('closed', onClosed);
        signal?.addEventListener('abort', onAbort, { once: true });
        onStatus?.({
            phase: 'seller_waiting_login',
            status: Number(failure?.httpStatus ?? failure?.status ?? 0),
            message: '请在 Seller 窗口完成登录或打开选品分析页，原任务将自动继续（最多等待 2 分钟）',
        });
        win.show();
        win.focus();
        void check();
    });
}

export async function verifyCurrentSellerStore(expectedContext = {}, options = {}) {
    activeSellerOperations += 1;
    try {
        const { silent = false, signal } = options;
        const expected = { ...expectedContext, accountId: expectedContext?.accountId || accountIdentity() };
        const verification = await readSellerVerification(expected, signal);
        if (verification)
            return verification;
        if (silent) {
            const error = new Error('Seller 尚未登录，可继续使用本地类目');
            error.code = 'SELLER_LOGIN_REQUIRED';
            throw error;
        }
        const win = createSellerWindow({ show: false, login: true });
        return await waitForSellerSession(win, expected, options);
    } finally { activeSellerOperations -= 1; }
}

async function executeAnalyticsFetch(win, companyId, body, path = ANALYTICS_PATH, language = 'zh-Hans') {
    activeSellerOperations += 1;
    try {
        const origin = getSellerRoute().origin;
        const input = JSON.stringify({ companyId, body, origin });
        const script = String.raw`
            (async () => {
                const input = ${input};
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 30000);
                try {
                    if (location.origin !== input.origin) return {
                        ok: false, status: 0, code: 'SELLER_SOURCE_CONTEXT_CHANGED', requestSent: false,
                        message: 'Seller 页面已离开当前线路，请重新打开 Seller 登录',
                    };
                    const response = await fetch(${JSON.stringify(origin + path)}, {
                        method: 'POST',
                        credentials: 'include',
                        signal: controller.signal,
                        headers: {
                            accept: 'application/json',
                            'content-type': 'application/json',
                            'x-o3-app-name': 'seller-ui',
                            'x-o3-company-id': input.companyId,
                            'x-o3-language': ${JSON.stringify(language)},
                        },
                        body: JSON.stringify(input.body),
                    });
                    const text = await response.text();
                    let data = null;
                    try { data = text ? JSON.parse(text) : null; } catch {}
                    const contentType = response.headers.get('content-type') || '';
                    const authRedirect = response.redirected && /(signin|registration|auth|login)/i.test(response.url || '');
                    const unexpectedHtml = !data && (/text\/html/i.test(contentType) || /^\s*<!doctype/i.test(text));
                    return {
                        ok: response.ok && !authRedirect && !unexpectedHtml,
                        status: authRedirect || unexpectedHtml ? 401 : response.status,
                        httpStatus: response.status,
                        retryAfter: response.headers.get('retry-after') || '',
                        data,
                        message: authRedirect || unexpectedHtml ? 'Seller 返回登录页面' : 'HTTP ' + response.status,
                    };
                } catch (error) {
                    return {
                        ok: false,
                        status: 0,
                        code: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
                        message: error?.message || String(error),
                    };
                } finally {
                    clearTimeout(timer);
                }
            })()
        `;
        return await win.webContents.executeJavaScript(script, true);
    } finally { activeSellerOperations -= 1; }
}

async function fetchSellerAnalytics(body, options = {}) {
    activeSellerOperations += 1;
    try {
        const { signal, onStatus } = options;
        throwIfAborted(signal);
        const context = options.verifiedContext || {};
        let verification = await verifyCurrentSellerStore(context.verification || options.expectedContext, options);
        const expected = { ...verification };
        let win;
        try {
            win = await ensureSellerWindow({ show: false, signal });
        }
        catch (error) {
            if (error.code !== 'SELLER_LOGIN_REQUIRED')
                throw error;
            win = createSellerWindow({ show: false });
            verification = await waitForSellerSession(win, expected, options);
        }
        context.win = win;
        context.verification = verification;
        let lastFailure = null;
        let transientAttempts = 0;
        let authenticationAttempts = 0;
        let recoveryDeadline;
        while (true) {
            throwIfAborted(signal);
            verification = await readSellerVerification(expected, signal);
            if (!verification || !isSellerPage(win.webContents.getURL()))
                verification = await waitForSellerSession(win, expected, options, { failure: lastFailure, deadline: recoveryDeadline });
            throwIfAborted(signal);
            const response = await abortable(
                withCollectorRequest(async () => {
                    await requestGate();
                    await verifyCurrentSellerStore(expected, { silent: true, signal });
                    return abortable(executeAnalyticsFetch(win, verification.sellerCompanyId, body), null, win, 35000);
                }, { signal }), signal, win,
            );
            if (response?.ok) {
                // A login/account switch while the request was in flight must never
                // attach the old response to the new account or Seller company.
                verification = await verifyCurrentSellerStore(expected, { silent: true, signal });
                context.verification = verification;
                if (authenticationAttempts)
                    onStatus?.({ phase: 'seller_session_recovered', message: 'Seller 分析接口已恢复，继续原采集任务' });
                return { ...normalizeSellerAnalyticsResponse(response.data), verification };
            }
            lastFailure = response || {};
            if ([401, 403].includes(Number(lastFailure.status))) {
                authenticationAttempts += 1;
                if (authenticationAttempts > 2)
                    throw sellerLoginError(lastFailure, 'seller_recovery_probe');
                recoveryDeadline ??= Date.now() + LOGIN_WAIT_MS;
                if (authenticationAttempts === 1) {
                    onStatus?.({
                        phase: 'seller_session_recovering',
                        status: Number(lastFailure.httpStatus ?? lastFailure.status),
                        message: 'Seller 分析接口要求重新验证，正在等待当前页面并复核登录状态',
                    });
                    win.show();
                    win.focus();
                    await waitForLoad(win, Math.max(1, Math.min(45000, recoveryDeadline - Date.now())), signal);
                    verification = await readSellerVerification(expected, signal);
                    if (!verification || !isSellerPage(win.webContents.getURL()))
                        verification = await waitForSellerSession(win, expected, options, { failure: lastFailure, deadline: recoveryDeadline });
                }
                else {
                    // Cookies are only a scope hint. After a second refusal, wait
                    // for navigation/login before one final real permission probe.
                    verification = await waitForSellerSession(win, expected, options, {
                        requireNavigation: true, failure: lastFailure, deadline: recoveryDeadline,
                    });
                }
                context.verification = verification;
                continue;
            }
            transientAttempts += 1;
            if (authenticationAttempts >= 2 || !isRetryableSellerFailure(lastFailure.status, lastFailure.code) || transientAttempts >= MAX_ATTEMPTS)
                break;
            const retryAfterSeconds = Number(lastFailure.retryAfter || 0);
            const delay = retryAfterSeconds > 0
                ? Math.min(10000, retryAfterSeconds * 1000)
                : 500 * (2 ** (transientAttempts - 1));
            await abortable(new Promise((resolve) => setTimeout(resolve, delay)), signal, win);
        }
        const status = Number(lastFailure?.httpStatus ?? lastFailure?.status ?? 0);
        const error = new Error(status
            ? `Ozon 选品分析请求失败（HTTP ${status}），请确认 Seller 页面和访问权限后重试`
            : 'Ozon 选品分析请求失败，请检查网络连接后重试');
        error.code = lastFailure?.code || 'SELLER_ANALYTICS_FAILED';
        error.status = status;
        error.phase = 'seller_analytics';
        throw error;
    } finally { activeSellerOperations -= 1; }
}

export async function fetchSellerSkuAnalytics(sku, options = {}) {
    const result = await fetchSellerAnalytics(buildSellerSkuPayload(sku, options.period), {
        expectedContext: options.expectedContext,
        signal: options.signal,
        onStatus: options.onStatus,
    });
    return {
        item: result.items[0] || null,
        verification: result.verification,
        totals: result.totals,
        updateDate: result.updateDate,
    };
}

export async function fetchSellerSkuAnalyticsBatch(skus, options = {}) {
    activeSellerOperations += 1;
    try {
        const items = [];
        const context = {};
        for (const sku of [...new Set((skus || []).map(String).filter(Boolean))]) {
            throwIfAborted(options.signal);
            const result = await fetchSellerAnalytics(buildSellerSkuPayload(sku, options.period), {
                verifiedContext: context,
                expectedContext: options.expectedContext,
                signal: options.signal,
                onStatus: options.onStatus,
            });
            if (result.items[0])
                items.push(result.items[0]);
        }
        return items;
    } finally { activeSellerOperations -= 1; }
}

export function fetchSellerLeaderboard(options = {}) {
    return fetchSellerAnalytics(buildSellerLeaderboardPayload(options), {
        expectedContext: options.expectedContext,
        signal: options.signal,
        onStatus: options.onStatus,
    });
}

export async function fetchSellerCategoryTree(options = {}) {
    activeSellerOperations += 1;
    try {
        const signal = options.signal;
        const silent = options.silent === true;
        throwIfAborted(signal);
        const verification = await abortable(verifyCurrentSellerStore(options.expectedContext, { silent, signal, onStatus: options.onStatus }), signal);
        const win = await abortable(ensureSellerWindow({ show: false, silent, signal }), signal);
        const response = await abortable(withCollectorRequest(async () => {
            await requestGate();
            await verifyCurrentSellerStore(verification, { silent: true, signal });
            return executeAnalyticsFetch(win, verification.sellerCompanyId,
                { company_id: verification.sellerCompanyId }, '/api/v1/seller-tree/get-by-company-id');
        }, { signal }), signal);
        if (!response?.ok) {
            if (!silent && [401, 403].includes(Number(response?.status)))
                win.show();
            const error = new Error(response?.status
                ? `Ozon 类目读取失败（HTTP ${response.status}），请确认 Seller 登录和访问权限后重试`
                : 'Ozon 类目读取失败，请检查网络连接后重试');
            error.code = 'SELLER_CATEGORY_TREE_FAILED';
            error.status = Number(response?.status || 0);
            throw error;
        }
        await abortable(verifyCurrentSellerStore(verification, { silent, signal }), signal);
        return response.data;
    } finally { activeSellerOperations -= 1; }
}

export function destroySellerWindow() {
    if (sellerWindow && !sellerWindow.isDestroyed())
        sellerWindow.destroy();
    sellerWindow = null;
    sellerPartition = '';
    sellerLoadPromise = null;
}

export async function requestSellerProduct(path, body, verification, signal) {
    activeSellerOperations += 1;
    try {
        let requestSent = false;
        try {
            if (!['/api/v1/search', '/api/site/seller-prototype/create-bundle-by-variant-id'].includes(path))
                throw new Error('不支持的 Seller 商品资料路径');
            throwIfAborted(signal);
            await verifyCurrentSellerStore(verification, { silent: true, signal });
            const win = await ensureSellerWindow({ show: false, silent: true, signal });
            // A sent draft write must drain into the scoped evidence cache even when
            // paused. Queued work and every pre-send check still observe cancellation.
            const createsDraft = path.includes('create-bundle');
            const response = await abortable(withCollectorRequest(async () => {
                await requestGate();
                await verifyCurrentSellerStore(verification, { silent: true, signal });
                throwIfAborted(signal);
                requestSent = true;
                return abortable(executeAnalyticsFetch(win, verification.sellerCompanyId, body, path, 'ru'), null, win, 35000);
            }, { signal, kind: createsDraft ? 'seller-write' : 'read' }), createsDraft ? null : signal, win);
            if (!response?.ok) {
                if (response?.requestSent === false) requestSent = false;
                const status = Number(response?.status || 0);
                const code = response?.code === 'SELLER_SOURCE_CONTEXT_CHANGED' ? 'SELLER_SOURCE_CONTEXT_CHANGED'
                    : [401, 403].includes(status) ? 'SELLER_CONTEXT_REQUIRED'
                    : status === 429 ? 'ZONGZI_ENRICH_BUSY' : 'ZONGZI_ENRICH_UPSTREAM_FAILED';
                throw Object.assign(new Error(status ? `Seller 商品资料读取失败（HTTP ${status}）` : 'Seller 商品资料读取超时或网络中断'), {
                    code, status, confirmedRejected: [400, 401, 403, 404, 429].includes(Number(response?.httpStatus ?? status)),
                });
            }
            // A confirmed draft must reach the scoped cache even if the user changes
            // Seller afterward. The worker rechecks context before any server result.
            if (path === '/api/v1/search') await verifyCurrentSellerStore(verification, { silent: true, signal });
            return response.data;
        } catch (error) {
            if (!requestSent && signal?.aborted) error = cancellationError();
            error.requestSent = requestSent;
            throw error;
        }
    } finally { activeSellerOperations -= 1; }
}

export { ANALYTICS_PATH, MIN_REQUEST_INTERVAL_MS };

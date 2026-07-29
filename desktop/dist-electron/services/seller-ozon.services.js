import { BrowserWindow, session } from 'electron';
import { runtimeConfig } from '../config/runtime.js';
import { getAccountPartition } from './session.services.js';
import { operationStore } from '../store/index.js';
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
let sellerWindow = null;
let sellerPartition = '';
let sellerLoadPromise = null;
let gateChain = Promise.resolve();
let lastRequestAt = 0;

function cancellationError() {
    const error = new Error('采集任务已取消');
    error.code = 'COLLECTION_CANCELLED';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted)
        throw cancellationError();
}

function abortable(promise, signal) {
    if (!signal)
        return promise;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(cancellationError());
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

function accountIdentity() {
    const user = operationStore.get('user') || {};
    return String(user._id || user.id || user.phone || '');
}

function sellerSourceContext(companyIds) {
    const accountId = accountIdentity();
    if (!accountId) {
        const error = new Error('请先登录 sonli 账号');
        error.code = 'SELLER_ACCOUNT_REQUIRED';
        throw error;
    }
    return {
        accountId,
        source: 'ozon_seller_analytics',
        sourceIdentity: `seller-page:${[...companyIds].map(normalizeSellerCompanyId).filter(Boolean).sort().join(',')}`,
    };
}

function isOzonHttps(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' && (url.hostname === 'ozon.ru' || url.hostname.endsWith('.ozon.ru'));
    }
    catch {
        return false;
    }
}

function isSellerPage(value) {
    try {
        return new URL(String(value || '')).hostname === 'seller.ozon.ru';
    }
    catch {
        return false;
    }
}

function waitForLoad(win, timeoutMs = 45000) {
    if (!win || win.isDestroyed())
        return Promise.reject(new Error('Seller Ozon 窗口不可用'));
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
            error ? reject(error) : resolve();
        };
        const onLoaded = () => finish();
        const onFailed = (_event, code, description) => finish(new Error(`Seller Ozon 页面加载失败：${code} ${description}`));
        const timer = setTimeout(() => finish(new Error('Seller Ozon 页面加载超时')), timeoutMs);
        win.webContents.once('did-finish-load', onLoaded);
        win.webContents.once('did-fail-load', onFailed);
    });
}

function currentPartition() {
    return getAccountPartition('seller', accountIdentity());
}

function createSellerWindow({ show = true } = {}) {
    const partition = currentPartition();
    if (sellerWindow && !sellerWindow.isDestroyed() && sellerPartition !== partition)
        sellerWindow.destroy();
    if (sellerWindow && !sellerWindow.isDestroyed()) {
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
        title: 'Ozon 卖家中心 - sonli 采集助手',
        webPreferences: {
            partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
        },
    });
    sellerWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isOzonHttps(url)) {
            sellerWindow?.loadURL(url).catch((error) => log.warn('Seller Ozon 跳转失败', error));
        }
        return { action: 'deny' };
    });
    sellerWindow.webContents.on('will-navigate', (event, url) => {
        if (!isOzonHttps(url)) {
            event.preventDefault();
            log.warn(`已拦截 Seller Ozon 非官方导航：${url}`);
        }
    });
    sellerWindow.once('closed', () => {
        sellerWindow = null;
        sellerPartition = '';
        sellerLoadPromise = null;
    });
    sellerLoadPromise = sellerWindow.loadURL(runtimeConfig.sellerCenterUrl).catch((error) => {
        log.error('打开 Seller Ozon 失败', error);
        throw error;
    });
    return sellerWindow;
}

async function ensureSellerWindow({ show = false } = {}) {
    const win = createSellerWindow({ show });
    if (sellerLoadPromise) {
        await sellerLoadPromise;
        sellerLoadPromise = null;
    }
    await waitForLoad(win);
    if (!isSellerPage(win.webContents.getURL())) {
        const error = new Error('请先在 Ozon 卖家中心完成登录');
        error.code = 'SELLER_LOGIN_REQUIRED';
        if (!show)
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
    const partitionSession = session.fromPartition(currentPartition());
    const cookies = await partitionSession.cookies.get({
        url: 'https://seller.ozon.ru/',
        name: 'sc_company_id',
    });
    return [...new Set(cookies
        .map((cookie) => normalizeSellerCompanyId(cookie.value))
        .filter(Boolean))];
}

export async function getSellerSessionStatus({ verify = false } = {}) {
    const companyIds = await getSellerCompanyIds();
    let verification = null;
    let verificationError = '';
    if (verify && companyIds.length) {
        try {
            verification = sellerSourceContext(companyIds);
        }
        catch (error) {
            verificationError = error.message;
        }
    }
    return {
        loggedIn: companyIds.length > 0,
        companyIds,
        verification,
        verificationError,
        windowOpen: Boolean(sellerWindow && !sellerWindow.isDestroyed()),
    };
}

export async function openSellerLoginWindow() {
    const win = createSellerWindow({ show: true });
    if (sellerLoadPromise) {
        await sellerLoadPromise.catch(() => {});
        sellerLoadPromise = null;
    }
    await waitForLoad(win).catch(() => {});
    return getSellerSessionStatus({ verify: false });
}

export async function verifyCurrentSellerStore(expectedContext = {}) {
    const companyIds = await getSellerCompanyIds();
    if (!companyIds.length) {
        await openSellerLoginWindow();
        const error = new Error('未检测到 sc_company_id，请先登录 seller.ozon.ru');
        error.code = 'SELLER_LOGIN_REQUIRED';
        throw error;
    }
    const result = {
        ...sellerSourceContext(companyIds),
        companyIds,
        sellerCompanyId: String(companyIds[0]),
    };
    assertSellerRunContext(result, expectedContext);
    return result;
}

async function executeAnalyticsFetch(win, companyId, body) {
    const input = JSON.stringify({ companyId, body });
    const script = `
        (async () => {
            const input = ${input};
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            try {
                const response = await fetch(${JSON.stringify(ANALYTICS_PATH)}, {
                    method: 'POST',
                    credentials: 'include',
                    signal: controller.signal,
                    headers: {
                        accept: 'application/json',
                        'content-type': 'application/json',
                        'x-o3-app-name': 'seller-ui',
                        'x-o3-company-id': input.companyId,
                        'x-o3-language': 'zh-Hans',
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
                    retryAfter: response.headers.get('retry-after') || '',
                    data,
                    message: data?.message || data?.error || text.slice(0, 300),
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
    return win.webContents.executeJavaScript(script, true);
}

async function fetchSellerAnalytics(body, options = {}) {
    const signal = options.signal;
    throwIfAborted(signal);
    const context = options.verifiedContext || null;
    const verification = context?.verification
        || await abortable(verifyCurrentSellerStore(options.expectedContext), signal);
    const win = context?.win
        || await abortable(ensureSellerWindow({ show: false }), signal);
    let lastFailure = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal);
        await abortable(requestGate(), signal);
        const response = await abortable(
            executeAnalyticsFetch(win, verification.sellerCompanyId, body),
            signal,
        );
        if (response?.ok) {
            return {
                ...normalizeSellerAnalyticsResponse(response.data),
                verification,
            };
        }
        lastFailure = response || {};
        if ([401, 403].includes(Number(lastFailure.status))) {
            win.show();
            const error = new Error('Ozon 卖家中心登录已失效或无权访问选品分析');
            error.code = 'SELLER_LOGIN_REQUIRED';
            error.status = lastFailure.status;
            throw error;
        }
        if (!isRetryableSellerFailure(lastFailure.status, lastFailure.code) || attempt >= MAX_ATTEMPTS)
            break;
        const retryAfterSeconds = Number(lastFailure.retryAfter || 0);
        const delay = retryAfterSeconds > 0
            ? Math.min(10000, retryAfterSeconds * 1000)
            : 500 * (2 ** (attempt - 1));
        await abortable(new Promise((resolve) => setTimeout(resolve, delay)), signal);
    }
    const error = new Error(`Ozon 选品分析请求失败：${lastFailure?.message || lastFailure?.status || '网络错误'}`);
    error.code = lastFailure?.code || 'SELLER_ANALYTICS_FAILED';
    error.status = Number(lastFailure?.status || 0);
    throw error;
}

export async function fetchSellerSkuAnalytics(sku, options = {}) {
    const result = await fetchSellerAnalytics(buildSellerSkuPayload(sku, options.period), {
        expectedContext: options.expectedContext,
        signal: options.signal,
    });
    return {
        item: result.items[0] || null,
        verification: result.verification,
        totals: result.totals,
        updateDate: result.updateDate,
    };
}

export async function fetchSellerSkuAnalyticsBatch(skus, options = {}) {
    const items = [];
    const context = {
        verification: await abortable(verifyCurrentSellerStore(options.expectedContext), options.signal),
        win: await abortable(ensureSellerWindow({ show: false }), options.signal),
    };
    for (const sku of [...new Set((skus || []).map(String).filter(Boolean))]) {
        throwIfAborted(options.signal);
        const result = await fetchSellerAnalytics(buildSellerSkuPayload(sku, options.period), {
            verifiedContext: context,
            signal: options.signal,
        });
        if (result.items[0])
            items.push(result.items[0]);
    }
    return items;
}

export function fetchSellerLeaderboard(options = {}) {
    return fetchSellerAnalytics(buildSellerLeaderboardPayload(options), {
        expectedContext: options.expectedContext,
        signal: options.signal,
    });
}

export function destroySellerWindow() {
    if (sellerWindow && !sellerWindow.isDestroyed())
        sellerWindow.destroy();
    sellerWindow = null;
    sellerPartition = '';
    sellerLoadPromise = null;
}

export { ANALYTICS_PATH, MIN_REQUEST_INTERVAL_MS };

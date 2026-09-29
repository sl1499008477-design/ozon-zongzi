import { BrowserWindow } from 'electron';
import log from '../../log/index.js';
import { ensureOzonCny, getAccountPartition } from '../session.services.js';
import { chromeCompatibleUserAgent } from '../../browser-user-agent.core.js';
import { withCollectorRequest } from '../collector-network.core.js';

let retainedCollectionWindow = null;

export function closeRetainedCollectionWindow() {
    const win = retainedCollectionWindow;
    retainedCollectionWindow = null;
    if (win && !win.isDestroyed()) win.destroy();
}

function normalizeOzonUrl(value) {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || !(url.hostname === 'ozon.ru' || url.hostname.endsWith('.ozon.ru')))
        throw new Error('仅允许访问 Ozon 官方 HTTPS 页面');
    return url.toString();
}
export class MainWindowService {
    browserWindow = null;
    lastHttpStatus = 0;
    closeHandle = null;
    windowClosedListener = null;
    collectionPartition = null;
    constructor(closeHandle) {
        this.closeHandle = closeHandle;
    }
    /**
     * 创建采集窗口
     */
    createCollectionWindow(url) {
        closeRetainedCollectionWindow();
        return new Promise((resolve, reject) => {
            let settled = false, initialLoadPending = true;
            let timeoutId, cancelPageWait, verificationError;
            const safeResolve = (v) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutId);
                resolve(v);
            };
            const safeReject = (e) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutId);
                cancelPageWait?.(e);
                reject(e);
            };
            let targetUrl;
            try {
                targetUrl = normalizeOzonUrl(url);
            }
            catch (error) {
                safeReject(error);
                return;
            }
            const partition = getAccountPartition('ozon');
            this.collectionPartition = partition;
            const win = new BrowserWindow({
                width: 1200,
                height: 800,
                show: false,
                webPreferences: {
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                    backgroundThrottling: false,
                    partition,
                },
            });
            this.browserWindow = win;
            this.lastHttpStatus = 0;
            win.webContents.on('did-navigate', (_event, _url, status) => {
                this.lastHttpStatus = status;
            });
            win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            win.webContents.setUserAgent(chromeCompatibleUserAgent());
            win.webContents.on('will-navigate', (event, nextUrl) => {
                try {
                    normalizeOzonUrl(nextUrl);
                }
                catch {
                    event.preventDefault();
                }
            });
            timeoutId = setTimeout(() => {
                safeReject(verificationError ? Object.assign(new Error('等待 Ozon 人工验证超时，请重新启动任务后在采集窗口完成验证'), {
                    code: 'ZONGZI_VERIFICATION_TIMEOUT', status: verificationError.status || 0,
                }) : Object.assign(new Error('Ozon 页面加载超时，请查看采集窗口后重试'), { code: 'ZONGZI_REQUEST_TIMEOUT' }));
                if (this.browserWindow === win && !win.isDestroyed()) {
                    if (initialLoadPending && getAccountPartition('ozon') === partition) win.show();
                    else {
                        win.removeListener('closed', onClosed);
                        this.destroy();
                    }
                }
            }, 100000);
            // 监听窗口关闭事件
            const onClosed = () => {
                safeReject(new Error('采集窗口已关闭'));
                this.closeHandle && this.closeHandle();
            };
            this.windowClosedListener = onClosed;
            win.once('closed', onClosed);
            const inspectPage = async () => {
                if (getAccountPartition('ozon') !== partition)
                    throw Object.assign(new Error('采集账号已切换，请在当前账号重新启动任务'), { code: 'ZONGZI_ACCOUNT_CHANGED' });
                await this.getHTML();
            };
            const waitForReadyPage = () => new Promise((pageResolve, pageReject) => {
                const wc = win.webContents;
                let done = false, inspection = 0;
                const finish = (error) => {
                    if (done) return;
                    done = true;
                    wc.removeListener('did-finish-load', inspectNavigation);
                    wc.removeListener('did-fail-load', rejectNavigation);
                    cancelPageWait = null;
                    if (!error) verificationError = null;
                    error ? pageReject(error) : pageResolve();
                };
                const inspectNavigation = () => {
                    if (done || settled) return;
                    const currentInspection = ++inspection;
                    inspectPage().then(() => {
                        if (!done && currentInspection === inspection) finish();
                    }, (error) => {
                        if (done || currentInspection !== inspection) return;
                        if (error?.code !== 'ZONGZI_ACCESS_BLOCKED') { finish(error); return; }
                        const showPrompt = !verificationError;
                        verificationError = error;
                        if (showPrompt) {
                            win.show();
                            log.warn('Ozon 需要人工验证，请在采集窗口完成验证；等待期间不会自动点击或刷新页面');
                        }
                    });
                };
                const rejectNavigation = (_event, code, description, _url, isMainFrame) => {
                    if (isMainFrame && code !== -3) finish(Object.assign(new Error(`Ozon 页面请求失败：${description}`), {
                        code: 'ZONGZI_NETWORK_ERROR', status: 0, errno: code,
                    }));
                };
                cancelPageWait = finish;
                // Listen before reading: the site can finish a navigation while the previous snapshot returns.
                wc.on('did-finish-load', inspectNavigation);
                wc.on('did-fail-load', rejectNavigation);
                inspectNavigation();
            });
            // Complete and inspect the first document before sending preference requests.
            // dom-ready alone can still be an error/challenge page or a navigation in progress.
            (async () => {
                await win.loadURL(targetUrl);
                initialLoadPending = false;
                if (settled || win.isDestroyed()) return;
                await waitForReadyPage();
                if (settled || win.isDestroyed()) return;
                let configured = false;
                try {
                    await ensureOzonCny(win.webContents);
                    configured = true;
                }
                catch (error) {
                    if (settled || win.isDestroyed()) return;
                    log.warn('Ozon 人民币显示设置失败，本轮价格将按页面实际币种记录', error?.message || error);
                }
                if (settled || win.isDestroyed()) return;
                if (configured) {
                    await win.loadURL(targetUrl);
                    if (settled || win.isDestroyed()) return;
                    await waitForReadyPage();
                }
                if (settled || win.isDestroyed()) return;
                win.show();
                safeResolve(win);
            })().catch((error) => {
                if (settled) return;
                log.error('Ozon 页面初始化失败', error);
                safeReject(error);
                if (error?.code === 'ZONGZI_ACCOUNT_CHANGED' && this.browserWindow === win) {
                    win.removeListener('closed', onClosed);
                    this.destroy();
                }
                else if (!win.isDestroyed()) win.show();
            });
        });
    }
    /**
     * 获取domin
      */
    async getDomain() {
        if (!this.browserWindow || this.browserWindow.isDestroyed()) {
            return '';
        }
        const wc = this.browserWindow.webContents;
        const domain = new URL(wc.getURL()).origin;
        return domain;
    }
    /**
     * 获取页面
     */
    async getHTML() {
        if (!this.browserWindow || this.browserWindow.isDestroyed()) {
            return { html: undefined, domain: '' };
        }
        const wc = this.browserWindow.webContents;
        const page = await wc.executeJavaScript(`
      (() => {
        const html = document.documentElement.outerHTML;
        const productLinkCount = document.querySelectorAll('a[href*="/product/"]').length;
        const bodyText = (document.body?.innerText || '').slice(0, 4000);
        const challengeControl = Boolean(
          document.querySelector('body > div.con p.h')
          || document.querySelector('button.rb, .btn.rb')
        );
        const connectionText = /(нет соединения|нет подключения|не уда[её]тся подключиться|выключите\\s+VPN|no connection|无法连接)/i.test(bodyText);
        const challengeText = /(access denied|captcha|robot|провер|доступ ограничен|验证码|访问受限|请确认您不是机器人|请拖动滑块)/i.test(bodyText);
        const challengeTitle = /^Antibot (?:Challenge Page|Captcha)$/i.test((document.title || '').trim());
        return {
          html,
          diagnostics: {
            productLinkCount,
            unavailable: productLinkCount === 0 && connectionText,
            empty: productLinkCount === 0 && !bodyText.trim(),
            blocked: productLinkCount === 0 && (challengeControl || challengeText || challengeTitle)
          }
        };
      })()
    `);
        const diagnostics = { ...page.diagnostics, httpStatus: this.lastHttpStatus };
        let failure;
        if (diagnostics.unavailable) {
            failure = ['ZONGZI_PAGE_UNAVAILABLE', 'Ozon 页面显示“无法连接”，请确认采集助手窗口能够正常打开该页面后重试'];
        }
        else if (diagnostics.blocked) {
            failure = ['ZONGZI_ACCESS_BLOCKED', 'Ozon 返回访问受限或验证页面，请在采集助手窗口确认页面状态后重试'];
        }
        else if (this.lastHttpStatus >= 400) {
            failure = ['ZONGZI_HTTP_ERROR', `Ozon 页面请求失败（HTTP ${this.lastHttpStatus}）`];
        }
        else if (!page.html || diagnostics.empty) {
            failure = ['ZONGZI_PAGE_UNAVAILABLE', 'Ozon 页面尚未显示有效内容，请确认页面正常打开后重试'];
        }
        if (failure) {
            throw Object.assign(new Error(failure[1]), { code: failure[0], status: this.lastHttpStatus || 0 });
        }
        const domain = new URL(wc.getURL()).origin;
        return { ...page, diagnostics, domain };
    }
    /**
     * 滚动页面
     */
    async scrollPage() {
        if (!this.browserWindow || this.browserWindow.isDestroyed())
            return false;
        try {
            const result = await this.browserWindow.webContents.executeJavaScript(`(function () {
        return new Promise(resolve => {
          const startY = window.scrollY;
          const windowHeight = window.innerHeight;
          const documentHeight = document.documentElement.scrollHeight;

          const scrollAmount = Math.floor(windowHeight * 0.8);
          const targetY = Math.min(
            startY + scrollAmount,
            documentHeight - windowHeight
          );

          if (startY >= documentHeight - windowHeight - 10) {
            resolve(false);
            return;
          }

          const duration = 3000; // 滚动时长 ms
          const startTime = performance.now();

          function step(now) {
            const progress = Math.min((now - startTime) / duration, 1);
            const ease = progress < 0.5
              ? 2 * progress * progress
              : 1 - Math.pow(-2 * progress + 2, 2) / 2;

            window.scrollTo(0, startY + (targetY - startY) * ease);

            if (progress < 1) {
              requestAnimationFrame(step);
            } else {
              resolve(true);
            }
          }

          requestAnimationFrame(step);
        });
      })();`);
            return result === true;
        }
        catch (error) {
            throw new Error(error);
        }
    }
    /**
     * 获取跟卖数据
     */
    async getSellingData(requestUrl) {
        return this.getOzonPageJson(requestUrl);
    }
    async getOzonPageJson(requestUrl) {
        return this.requestOzonPage(requestUrl);
    }
    async getProductHtml(id) {
        const win = this.browserWindow, partition = this.collectionPartition;
        const assertAccount = () => {
            if (partition && partition !== getAccountPartition('ozon'))
                throw Object.assign(new Error('采集账号已变化，已停止读取旧账号商品简介'), { code: 'ZONGZI_ACCOUNT_CHANGED' });
        };
        assertAccount();
        const result = await this.requestOzonPage(`https://www.ozon.ru/product/${encodeURIComponent(String(id))}/`, String(id));
        assertAccount();
        if (win !== this.browserWindow || win?.isDestroyed?.())
            throw Object.assign(new Error('商品简介读取期间采集窗口已关闭'), { code: 'COLLECTION_WINDOW_CLOSED' });
        return result.html;
    }
    async requestOzonPage(requestUrl, expectedHtmlSku = '') {
        const win = this.browserWindow, partition = this.collectionPartition;
        return withCollectorRequest(async () => {
        if (win !== this.browserWindow || partition && partition !== getAccountPartition('ozon'))
            throw Object.assign(new Error('采集窗口或账号已变化'), { code: 'ZONGZI_ACCOUNT_CHANGED' });
        if (!this.browserWindow || this.browserWindow.isDestroyed?.())
            throw new Error('采集窗口不可用');
        const target = normalizeOzonUrl(requestUrl);
        const timeoutMs = 30000;
        let timeoutId, result;
        try {
            const request = this.browserWindow.webContents.executeJavaScript(`
                (async () => {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
                    let status = 0;
                    try {
                        const response = await fetch(${JSON.stringify(target)}, { credentials: 'include', signal: controller.signal,
                            ...(${JSON.stringify(expectedHtmlSku)} ? { headers: { accept: 'text/html' } } : {}) });
                        status = response.status;
                        if (status === 401)
                            return { success: false, code: 'ZONGZI_ACCESS_BLOCKED', status, message: '请在采集窗口确认 Ozon 登录状态' };
                        const raw = await response.text();
                        const pageText = raw.replace(/<script[^>]*>[\\s\\S]*?<\\/script>/gi, '').replace(/<[^>]*>/g, ' ');
                        const blocked = /^\\s*</.test(raw) && /(?:Antibot (?:Challenge Page|Captcha)|captcha|access denied|доступ ограничен|请确认您不是机器人|请拖动滑块)/i.test(pageText);
                        if (blocked)
                            return { success: false, code: 'ZONGZI_ACCESS_BLOCKED', status, message: 'Ozon 返回验证或访问受限页面，请查看采集窗口' };
                        if (!response.ok)
                            return { success: false, code: 'ZONGZI_HTTP_ERROR', status, message: 'HTTP ' + status };
                        if (${JSON.stringify(expectedHtmlSku)}) {
                            const returned = new URL(response.url || ${JSON.stringify(target)});
                            const sku = returned.pathname.match(/^\\/product\\/(?:[^/]*-)?(\\d+)\\/?$/)?.[1];
                            if (returned.origin !== 'https://www.ozon.ru' || sku !== ${JSON.stringify(expectedHtmlSku)})
                                return { success: false, code: 'ZONGZI_RESPONSE_SKU_MISMATCH', status, message: '简介页面不属于请求商品' };
                            return { success: true, html: raw };
                        }
                        let data;
                        try { data = JSON.parse(raw); }
                        catch {
                            return { success: false, code: 'ZONGZI_RESPONSE_INVALID', status, message: '返回内容不是有效的商品 JSON' };
                        }
                        if (!data?.widgetStates || typeof data.widgetStates !== 'object' || Array.isArray(data.widgetStates))
                            return { success: false, code: 'ZONGZI_RESPONSE_INVALID', status, message: '响应中没有商品页面数据' };
                        return { success: true, data };
                    }
                    catch (error) {
                        const timedOut = controller.signal.aborted || error?.name === 'AbortError';
                        return { success: false, code: timedOut ? 'ZONGZI_REQUEST_TIMEOUT' : 'ZONGZI_NETWORK_ERROR', status,
                            message: timedOut ? '请求超时，请稍后重试' : '网络请求失败，请确认连接后重试' };
                    }
                    finally { clearTimeout(timeout); }
                })()
            `);
            // A renderer navigation can leave executeJavaScript pending even after fetch should abort.
            result = await Promise.race([request, new Promise(resolve => {
                timeoutId = setTimeout(() => resolve({ success: false, code: 'ZONGZI_REQUEST_TIMEOUT', status: 0, message: '请求超时，请稍后重试' }), timeoutMs);
            })]);
        }
        catch {
            result = { success: false, code: 'ZONGZI_NETWORK_ERROR', status: 0, message: '采集页面请求中断，请查看采集窗口后重试' };
        }
        finally { clearTimeout(timeoutId); }
        if (!result?.success) {
            throw Object.assign(new Error(`Ozon 商品页面请求失败：${result?.message || '未返回数据'}`), {
                code: result?.code || 'ZONGZI_RESPONSE_INVALID', status: result?.status || 0,
            });
        }
        return result;
        }, { signal: this.cancellationSignal });
    }
    /**
     * 改变当前窗口 URL
     */
    async changeUrl(url, waitForLoad = true) {
        console.log(url, '新窗口地址-未拼接');
        const newUrl = normalizeOzonUrl(url.startsWith('https://') ? url : `https://www.ozon.ru${url}`);
        console.log(newUrl, '新窗口地址');
        if (!this.browserWindow || this.browserWindow.isDestroyed()) {
            throw new Error('窗口不存在或已销毁');
        }
        console.log('改变当前窗口URL');
        const win = this.browserWindow;
        if (!waitForLoad) {
            await win.loadURL(newUrl);
            return true;
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const safeResolve = (v) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                resolve(v);
            };
            const safeReject = (e) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                reject(e);
            };
            const timeout = setTimeout(() => {
                safeReject('URL 切换超时');
            }, 60000);
            win.loadURL(newUrl).then(() => safeResolve(true), safeReject);
        });
    }
    /**
     * 通过接口获取页面数据
      */
    async getDataByApi(id, initialPage = null) {
        const win = this.browserWindow, partition = this.collectionPartition;
        const assertContext = () => {
            if (partition && partition !== getAccountPartition('ozon'))
                throw Object.assign(new Error('采集账号已变化，已停止读取旧账号商品'), { code: 'ZONGZI_ACCOUNT_CHANGED' });
            if (win && (win !== this.browserWindow || win.isDestroyed?.()))
                throw Object.assign(new Error('详情读取期间采集窗口已关闭'), { code: 'COLLECTION_WINDOW_CLOSED' });
        };
        assertContext();
        const productPath = `/product/${encodeURIComponent(String(id))}/`;
        const target = `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(productPath)}`;
        const initial = initialPage || await this.getOzonPageJson(target);
        assertContext();
        const states = { ...initial.data.widgetStates };
        const seen = new Set([productPath]);
        const queue = [initial.data.widgetStates];
        let galleryFound = false;
        const incomplete = message => Object.assign(new Error(`Ozon 商品资料不完整：${message}，请重试采集`), { code: 'ZONGZI_DETAIL_INCOMPLETE' });
        for (let index = 0; index < queue.length; index++) {
            for (const [key, raw] of Object.entries(queue[index])) {
                if (!/^(?:webGallery|webProductMainWidget|webCharacteristics|webShortCharacteristics|webDescription|paginator)(?:-|$)/.test(key)) continue;
                let widget;
                try { widget = typeof raw === 'string' ? JSON.parse(raw) : raw; }
                catch { throw incomplete(`${key} 解析失败`); }
                if (!widget || typeof widget !== 'object') throw incomplete(`${key} 内容无效`);
                if (index === 0 || !/^webGallery(?:-|$)/.test(key)
                    || (widget.images?.length || 0) > (states[key]?.images?.length || 0)) states[key] = widget;
                if (widget.sku && String(widget.sku) !== String(id))
                    throw Object.assign(new Error('Ozon 返回了其他 SKU 的商品资料，请重试采集'), { code: 'ZONGZI_RESPONSE_SKU_MISMATCH' });
                if (/^webGallery(?:-|$)/.test(key)) {
                    galleryFound ||= Array.isArray(widget.images) && widget.images.some(image => {
                        const url = typeof image === 'string' ? image : image?.src || image?.url || image?.image || image?.imageUrl;
                        return typeof url === 'string' && /^https?:\/\//i.test(url);
                    });
                }
                if (!/^paginator(?:-|$)/.test(key) || !widget.nextPage) continue;
                let next;
                try { next = new URL(widget.nextPage, 'https://www.ozon.ru'); }
                catch { throw incomplete('后续详情地址无效'); }
                // Product details live here; reviews and recommendation shelves are not product evidence.
                if (next.searchParams.get('layout_container') !== 'pdpPage2column') continue;
                const nextSku = next.pathname.match(/^\/product\/(?:[^/]*-)?(\d+)\/?$/)?.[1];
                if (next.origin !== 'https://www.ozon.ru' || nextSku !== String(id))
                    throw incomplete('后续详情地址不属于请求商品');
                const path = next.pathname + next.search;
                if (seen.has(path) || seen.size >= 5) throw incomplete('后续详情分页未能结束');
                seen.add(path);
                const page = await this.getOzonPageJson(`https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`);
                assertContext();
                if (!Object.keys(page.data.widgetStates).some(name => /^(?:webGallery|webCharacteristics|webDescription|paginator)(?:-|$)/.test(name)))
                    throw incomplete('后续页面未返回商品详情');
                const pageStates = {};
                for (const [name, value] of Object.entries(page.data.widgetStates)) {
                    // Repeated product widgets can supply different media, HTML or characteristics.
                    // Keep each page for the shared parser instead of selecting by gallery size.
                    const retainedName = Object.hasOwn(states, name) && /^(?:webGallery|webCharacteristics|webShortCharacteristics|webDescription)(?:-|$)/.test(name)
                        ? `${name}-page-${seen.size}` : name;
                    pageStates[retainedName] = value;
                    if (!Object.hasOwn(states, retainedName)) states[retainedName] = value;
                }
                queue.push(pageStates);
            }
        }
        if (!galleryFound) {
            if (Object.keys(states).some(key => /^webOutOfStock(?:-|$)/.test(key)))
                throw Object.assign(new Error(`Ozon 商品 ${id} 已售罄或不可用，未提供原商品图册`), { code: 'ZONGZI_PRODUCT_UNAVAILABLE', sku: String(id) });
            throw incomplete('未读取到商品图册');
        }
        return { ...initial, data: { ...initial.data, widgetStates: states } };
    }
    async getProductGroup(id, { initialAspects, signal, initialPages } = {}) {
        const anchorSku = String(id), win = this.browserWindow, partition = this.collectionPartition;
        const incomplete = (sku, message) => Object.assign(new Error(`SKU ${sku} 的整组变体未读取完整：${message}`), { code: 'ZONGZI_GROUP_INCOMPLETE' });
        const assertActive = () => {
            signal?.throwIfAborted();
            if (partition && partition !== getAccountPartition('ozon'))
                throw Object.assign(new Error('采集账号已变化，已停止读取旧账号变体'), { code: 'ZONGZI_ACCOUNT_CHANGED' });
            if (!win || win !== this.browserWindow || win.isDestroyed?.())
                throw Object.assign(new Error('变体读取期间采集窗口已关闭'), { code: 'COLLECTION_WINDOW_CLOSED' });
        };
        const pageAspects = data => {
            let fallback = [];
            for (const [key, raw] of Object.entries(data?.widgetStates || {})) {
                let value;
                try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
                catch { continue; }
                if (!Array.isArray(value?.aspects)) continue;
                if (/^webAspects(?:-|$)/.test(key)) return value.aspects;
                if (!fallback.length) fallback = value.aspects;
            }
            return fallback;
        };
        const readAspects = async path => {
            const target = new URL(path, 'https://www.ozon.ru');
            if (target.origin !== 'https://www.ozon.ru' || !/^\/(?:product|modal)\//.test(target.pathname))
                throw incomplete(anchorSku, '变体地址无效');
            for (const api of ['entrypoint-api', 'composer-api']) {
                assertActive();
                const response = await this.getOzonPageJson(`https://www.ozon.ru/api/${api}.bx/page/json/v2?url=${encodeURIComponent(target.pathname + target.search)}`);
                assertActive();
                const aspects = pageAspects(response.data);
                if (aspects.length) {
                    // Reuse only this group's own entrypoint product pages. Keep memory
                    // bounded for large groups; uncached pages use the normal detail read.
                    const sku = target.pathname.match(/^\/product\/(\d+)\/$/)?.[1];
                    if (api === 'entrypoint-api' && sku && !target.search && initialPages && initialPages.size < 32)
                        initialPages.set(sku, response);
                    return aspects;
                }
            }
            return [];
        };
        const variants = new Map([[anchorSku, { sku: anchorSku, link: `/product/${anchorSku}/`, aspectValues: {} }]]);
        const expandedSkus = new Set();
        const text = row => row?.data?.searchableText || row?.data?.textRs?.map(value => value.content || '').join('') || '';
        const expand = async (aspects, sku) => {
            const expanded = [];
            for (const axis of aspects) {
                assertActive();
                const rows = new Map((axis.variants || []).filter(row => /^\d+$/.test(String(row.sku))).map(row => [String(row.sku), row]));
                const total = Number(axis.aspectModalInfo?.realNumberOfVariants) || 0;
                if (rows.size < total) {
                    if (!axis.aspectModalInfo?.link) throw incomplete(sku, `${axis.aspectName || '规格'}缺少展开地址`);
                    const modal = await readAspects(axis.aspectModalInfo.link);
                    for (const other of modal.filter(value => value.aspectName === axis.aspectName)) {
                        for (const row of other.variants || []) if (/^\d+$/.test(String(row.sku))) rows.set(String(row.sku), row);
                    }
                    if (rows.size < total) throw incomplete(sku, `${axis.aspectName || '规格'}标明 ${total} 个，仅展开 ${rows.size} 个`);
                }
                expanded.push({ name: axis.aspectName, rows });
            }
            if (expanded.length && !expanded.some(axis => axis.rows.has(sku)))
                throw incomplete(sku, '规格中未找到当前 SKU');
            const activeValues = Object.fromEntries(expanded.map(axis => [axis.name, text(axis.rows.get(sku))])
                .filter(([name, value]) => name && value));
            for (const { name, rows } of expanded) {
                for (const [key, row] of rows) {
                    const previous = variants.get(key);
                    const values = { ...activeValues, ...(name && text(row) ? { [name]: text(row) } : {}) };
                    variants.set(key, {
                        sku: key, link: `/product/${key}/`,
                        // A later representative card may fill missing values, but cannot replace
                        // values already resolved while reading this SKU's own page.
                        aspectValues: expandedSkus.has(key) ? { ...values, ...previous?.aspectValues } : { ...previous?.aspectValues, ...values },
                    });
                }
            }
            expandedSkus.add(sku);
        };
        assertActive();
        const aspects = initialAspects ?? await readAspects(`/product/${anchorSku}/`);
        await expand(aspects, anchorSku);
        // Map iteration includes newly discovered SKUs. Sparse groups and representative
        // cards can expose new branches on any member, regardless of the initial axis count.
        for (const sku of variants.keys()) {
            if (expandedSkus.has(sku)) continue;
            const next = await readAspects(`/product/${sku}/`);
            if (!next.length) throw incomplete(sku, '页面没有返回关联规格');
            await expand(next, sku);
        }
        assertActive();
        return { anchorSku, skus: [...variants.keys()], variants: [...variants.values()], complete: true };
    }
    /**
     * 关闭采集窗口
     */
    async destroy({ keepOpen = false } = {}) {
        const win = this.browserWindow;
        if (win && !win.isDestroyed()) {
            if (keepOpen && this.collectionPartition === getAccountPartition('ozon')) {
                if (this.windowClosedListener) win.removeListener('closed', this.windowClosedListener);
                closeRetainedCollectionWindow();
                retainedCollectionWindow = win;
                win.once('closed', () => {
                    if (retainedCollectionWindow === win) retainedCollectionWindow = null;
                });
                win.show();
            }
            else win.destroy();
        }
        this.browserWindow = null;
        this.closeHandle = null;
        this.windowClosedListener = null;
        this.collectionPartition = null;
    }
}

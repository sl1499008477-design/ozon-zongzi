import { BrowserWindow } from 'electron';
import log from '../../log/index.js';
import { getAccountPartition } from '../session.services.js';

function chromeCompatibleUserAgent() {
    const chromeMajor = String(process.versions.chrome || '142').split('.')[0];
    const platform = process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'Macintosh; Intel Mac OS X 10_15_7';
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}

function normalizeOzonUrl(value) {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || !(url.hostname === 'ozon.ru' || url.hostname.endsWith('.ozon.ru')))
        throw new Error('仅允许访问 Ozon 官方 HTTPS 页面');
    return url.toString();
}
export class MainWindowService {
    browserWindow = null;
    isCheck = false;
    closeHandle = null;
    constructor(closeHandle) {
        this.closeHandle = closeHandle;
    }
    /**
     * 创建采集窗口
     */
    createCollectionWindow(url) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const safeResolve = (v) => {
                if (settled)
                    return;
                settled = true;
                resolve(v);
            };
            const safeReject = (e) => {
                if (settled)
                    return;
                settled = true;
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
            this.browserWindow = new BrowserWindow({
                width: 1200,
                height: 800,
                show: true,
                webPreferences: {
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                    backgroundThrottling: false,
                    partition: getAccountPartition('ozon'),
                },
            });
            this.browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            this.browserWindow.webContents.setUserAgent(chromeCompatibleUserAgent());
            this.browserWindow.webContents.on('will-navigate', (event, nextUrl) => {
                try {
                    normalizeOzonUrl(nextUrl);
                }
                catch {
                    event.preventDefault();
                }
            });
            const timeoutId = setTimeout(() => {
                if (this.browserWindow) {
                    this.destroy();
                }
                safeReject('页面加载超时');
            }, 100000);
            // 监听页面加载完成事件
            this.browserWindow.webContents.once('dom-ready', async () => {
                log.info('页面 DOM 已准备就绪');
                clearTimeout(timeoutId);
                await new Promise((resolve) => setTimeout(resolve, 3000));
                safeResolve(this.browserWindow);
            });
            // 监听窗口关闭事件
            this.browserWindow.once('closed', () => {
                this.closeHandle && this.closeHandle();
            });
            this.browserWindow.loadURL(targetUrl).catch((error) => {
                log.error('Ozon 页面加载失败', error);
                clearTimeout(timeoutId);
                safeReject(error);
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
        if (!this.isCheck) {
            this.isCheck = true;
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                let result;
                try {
                    result = await wc.executeJavaScript(`
          (() => {
            const heading = document.querySelector('body > div.con p.h');
            const button = document.querySelector('button.rb, .btn.rb');
            if (!heading || !button)
              return { ok: false };
            button.click();
            return { ok: true };
          })()
        `);
                }
                catch (error) {
                    log.warn(`Ozon 页面检测 ${attempt}/3 执行失败`, error?.message || error);
                    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
                    continue;
                }
                log.info(`Ozon 页面检测 ${attempt}/3:`, result);
                if (!result?.ok)
                    break;
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }
        const page = await wc.executeJavaScript(`
      (() => {
        const html = document.documentElement.outerHTML;
        const productLinkCount = document.querySelectorAll('a[href*="/product/"]').length;
        const bodyText = (document.body?.innerText || '').slice(0, 4000);
        const challengeControl = Boolean(
          document.querySelector('body > div.con p.h')
          || document.querySelector('button.rb, .btn.rb')
        );
        const challengeText = /(access denied|captcha|robot|провер|доступ ограничен|验证码|访问受限)/i.test(bodyText);
        return {
          html,
          diagnostics: {
            productLinkCount,
            blocked: productLinkCount === 0 && (challengeControl || challengeText)
          }
        };
      })()
    `);
        const domain = new URL(wc.getURL()).origin;
        return { ...page, domain };
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
        if (!this.browserWindow || this.browserWindow.isDestroyed())
            return;
        try {
            const safeRequestUrl = normalizeOzonUrl(requestUrl);
            const response = await this.browserWindow.webContents.executeJavaScript(`
            fetch(${JSON.stringify(safeRequestUrl)}, { credentials: 'include' })
            .then(response => response.json())
            .then(data => ({ success: true, data: data }))
          `);
            return response;
        }
        catch (error) {
            return false;
        }
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
                resolve(v);
            };
            const safeReject = (e) => {
                if (settled)
                    return;
                settled = true;
                reject(e);
            };
            const timeout = setTimeout(() => {
                safeReject('URL 切换超时');
            }, 60000);
            win.webContents.once('did-finish-load', () => {
                clearTimeout(timeout);
                safeResolve(true);
            });
            win.webContents.once('did-fail-load', (_, errorCode, errorDesc) => {
                clearTimeout(timeout);
                safeReject(`加载失败: ${errorDesc} (${errorCode})`);
            });
            win.loadURL(newUrl);
        });
    }
    /**
     * 通过接口获取页面数据
      */
    async getDataByApi(id) {
        try {
            const target = `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fproduct%2Flastik-dlya-obuvi-sredstvo-dlya-suhoy-chistki-obuvi-${id}`;
            const response = await this.browserWindow?.webContents.executeJavaScript(`
            fetch(${JSON.stringify(target)}, { credentials: 'include' })
            .then(response => response.json())
            .then(data => ({ success: true, data: data }))
          `);
            return response;
        }
        catch (error) {
            console.log('获取页面数据报错~~');
            return { success: false, data: {} };
        }
    }
    /**
     * 关闭采集窗口
     */
    async destroy() {
        this.browserWindow?.destroy();
        this.browserWindow = null;
        this.closeHandle = null;
    }
}

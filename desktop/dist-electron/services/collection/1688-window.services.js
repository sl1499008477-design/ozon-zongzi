import path from 'path';
import { BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto'; // 使用 UUID 确保唯一性
import log from '../../log/index.js';
import { memoryMonitor } from '../memory-monitor.services.js';
import { getAccountPartition } from '../session.services.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export class WindowService {
    windows = [];
    parseService;
    constructor(parseService) {
        this.parseService = parseService;
    }
    /**
     * 创建一个浏览器窗口并执行图片搜索任务
     * @param sourceType 排序类型 ('1' 表示价格, 其他表示销量)
     * @param cover 图片 URL
     * @returns 返回解析后的 HTML 数据 (CheerioAPI)
     */
    createWindow(sourceType, cover) {
        memoryMonitor.trackBusinessMetrics({
            windowCount: this.windows.length,
            action: 'create-window',
        });
        const winId = randomUUID(); // 使用 UUID 确保唯一性
        let win = null;
        let settled = false;
        let timer = undefined;
        // 清理资源
        const cleanup = () => {
            if (win && !win.isDestroyed()) {
                win.removeAllListeners();
                win.destroy();
            }
            // 移除当前窗口的 IPC 监听器
            ipcMain.removeAllListeners(`result-page-${winId}`);
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            this.windows = this.windows.filter((w) => w.id !== winId);
            win = null;
            settled = true;
        };
        // 安全 resolve
        const safeResolve = (value, resolve) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(value);
        };
        // 安全 reject
        const safeReject = (error, reject) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject({ error: error || '未知错误', winId });
        };
        return new Promise(async (resolve, reject) => {
            try {
                // 创建浏览器窗口
                win = new BrowserWindow({
                    width: 1200,
                    height: 800,
                    show: false,
                    webPreferences: {
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                        preload: path.join(__dirname, '../../preloads/1688preload.cjs'),
                        additionalArguments: [`--winId=${winId}`],
                        backgroundThrottling: false,
                        partition: getAccountPartition('1688'),
                    },
                });
                win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
                timer = setTimeout(() => {
                    safeReject(new Error('1688采集超时'), reject);
                }, 1000 * 60 * 2);
                this.windows.push({ cleanup, id: winId });
                // 绑定 IPC 监听器（使用唯一事件名称）
                ipcMain.once(`result-page-${winId}`, async (event, _) => {
                    try {
                        let sortText;
                        if (sourceType) {
                            sortText = sourceType === '1' ? '价格' : '销量';
                        }
                        await new Promise((res) => setTimeout(res, 5000));
                        // 执行排序逻辑
                        if (sourceType !== '0')
                            await win?.webContents.executeJavaScript(`
              new Promise((resolve, reject) => {
                const sortText = ${JSON.stringify(sortText)};
                const list = document.querySelectorAll('.sortItem--X1Plgn6V');
                try {
                  if (!sortText) resolve(true);
                  for (const el of list) {
                    if (sortText && el.textContent === sortText) {
                      el.click();
                      break;
                    }
                  }
                  resolve(true);
                } catch (error) {
                  reject(error);
                }
              });
            `);
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                        // 获取页面 HTML 并解析
                        const html = await win?.webContents.executeJavaScript('document.documentElement.outerHTML');
                        const obj = this.parseService['1688Parse'](html);
                        win?.destroy();
                        // 增加延迟以确保页面稳定
                        await new Promise((res) => setTimeout(res, 5000));
                        safeResolve(obj, resolve);
                    }
                    catch (error) {
                        safeReject(error, reject);
                    }
                });
                // 加载目标页面
                win.loadURL('https://pages-fast.1688.com/wow/cbu/srch_rec/image_search/youyuan/index.html?');
                // 等待页面加载完成并增加延迟
                await new Promise((res) => setTimeout(res, 2000));
                // 执行图片上传和搜索逻辑
                await win?.webContents?.executeJavaScript(`
          new Promise(async (resolve, reject) => {
            try {
              // 获取图片 Blob
              const response = await fetch(${JSON.stringify(cover)});
              const imageBlob = await response.blob();

              // 查找上传输入框
              const uploadInput = document.querySelector('input[type="file"]') ||
                                 document.querySelector('[accept*="image"]') ||
                                 Array.from(document.querySelectorAll('input')).find(el =>
                                   el.type === 'file' || el.accept?.includes('image')
                                 );

              if (!uploadInput) {
                console.error('未找到文件上传输入框');
                reject(new Error('未找到上传输入框'));
                return;
              }

              // 创建 File 对象并模拟上传
              const file = new File([imageBlob], 'search-image.jpg', { type: 'image/jpeg' });
              const dataTransfer = new DataTransfer();
              dataTransfer.items.add(file);
              uploadInput.files = dataTransfer.files;

              // 触发 change 和 input 事件
              const changeEvent = new Event('change', { bubbles: true });
              uploadInput.dispatchEvent(changeEvent);
              const inputEvent = new Event('input', { bubbles: true });
              uploadInput.dispatchEvent(inputEvent);

              // 等待图片预览加载
              await new Promise(r => setTimeout(r, 2000));

              // 查找并点击搜索按钮
              const searchButton = document.querySelector('[data-tracker="pasteImagePreview"]') ||
                                  document.querySelector('.search-btn') ||
                                  document.querySelector('[class*="search-btn"]') ||
                                  Array.from(document.querySelectorAll('div, button')).find(el =>
                                    el.textContent?.includes('搜索图片') ||
                                    el.textContent?.includes('搜索') ||
                                    el.getAttribute('data-tracker') === 'pasteImagePreview'
                                  );

              if (!searchButton) {
                console.error('未找到搜索按钮');
                reject(new Error('未找到搜索按钮'));
                return;
              }

              searchButton.click();

              // 等待页面跳转和结果加载
              await new Promise(r => setTimeout(r, 3000));
              resolve({ success: true, message: '图片上传并搜索成功' });
            } catch (error) {
              reject(error);
            }
          });
        `);
            }
            catch (error) {
                log.error('1688图片搜索失败', error);
                safeReject(error, reject);
            }
        });
    }
    /**
     * 销毁实例
     */
    destroy() {
        this.windows.forEach((win) => win.cleanup());
        this.windows = [];
    }
}

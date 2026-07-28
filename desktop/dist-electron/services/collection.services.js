import dayjs from 'dayjs';
import path, { join } from 'path';
import { BrowserWindow } from 'electron';
import log from '../log/index.js';
import { ExcelWriter } from '../utils/excel.js';
import { SysTemUtils } from '../utils/system.js';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { getAccountPartition } from './session.services.js';
import { fetchSellerSkuAnalyticsBatch } from './seller-ozon.services.js';
import { calculateCollectorPricing } from './collector-backend.services.js';
const excelDir = join(SysTemUtils.getAppInfo().userDataPath, 'excel');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeOzonUrl(value) {
    const url = new URL(String(value || 'https://www.ozon.ru'));
    if (url.protocol !== 'https:' || !(url.hostname === 'ozon.ru' || url.hostname.endsWith('.ozon.ru')))
        throw new Error('仅允许访问 Ozon 官方 HTTPS 页面');
    return url.toString();
}
export class Collection {
    collectionTask;
    browserWindow = null;
    mainWindow;
    excel = null;
    collectedLinks = []; // 累计爬取
    processed = 0;
    totalCount = 0;
    timers = [];
    tableFilePath = '';
    pendingTasks = [];
    processedIds = new Set();
    // 新增：任务队列和并发控制
    taskQueue = [];
    isProcessingQueue = false;
    maxConcurrentTasks = 3; // 控制并发处理数量
    activeProcessors = 0;
    // 新增：任务状态标志
    isCancelled = false;
    taskWindowS = [];
    constructor(task, mainWindow) {
        this.collectionTask = { ...task };
        this.mainWindow = mainWindow;
        this.excel = new ExcelWriter(join(excelDir, `${this.collectionTask.taskName}.xlsx`));
        this.tableFilePath = join(excelDir, `${this.collectionTask.taskName}.xlsx`);
    }
    // 添加挂起任务
    addPendingTask(task) {
        const wrappedTask = task.finally(() => {
            // 从挂起任务列表中移除已完成的任务
            const index = this.pendingTasks.indexOf(wrappedTask);
            if (index > -1) {
                this.pendingTasks.splice(index, 1);
            }
        });
        this.pendingTasks.push(wrappedTask);
        return wrappedTask;
    }
    // 等待所有挂起的任务完成
    async waitForAllPendingTasks() {
        if (this.pendingTasks.length > 0) {
            log.info(this.pendingTasks.length, '等待完成的任务数量');
            await Promise.allSettled(this.pendingTasks); // 使用 allSettled 防止一个失败影响全部
        }
    }
    // 补全任务信息
    complementTaskInfo() {
        const status = 'noExecuted';
        const createTime = dayjs(this.collectionTask.createTime || Date.now()).format('YYYY-MM-DD HH:mm:ss');
        this.collectionTask.taskStatus = status;
        this.collectionTask.createTime = createTime;
    }
    // 更新任务数据
    updateTaskData(task) {
        // 只更新允许更新的字段，保留原始的 id、createTime 等
        Object.assign(this.collectionTask, {
            ...task,
            _id: this.collectionTask._id, // 确保 id 不被覆盖
            createTime: this.collectionTask.createTime, // 确保创建时间不被覆盖
            taskStatus: this.collectionTask.taskStatus, // 保持当前状态
        });
    }
    // 输出日志
    outputLog(taskLog) {
        this.collectionTask.progress = {
            current: this.processed,
            total: this.collectedLinks.length,
            totalCount: Math.min(this.totalCount, +this.collectionTask.targetCount),
        };
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('task-progress', {
                collectionTask: this.collectionTask,
                log: { date: `[${dayjs(Date.now()).format('YYYY/MM/DD HH:mm:ss')}]`, taskLog },
            });
        }
    }
    // 更新任务状态
    async updateStatus(status) {
        try {
            this.collectionTask.taskStatus = status;
            await this.syncStatusToServer(status);
        }
        catch (error) {
            log.error('更新任务状态失败', error);
        }
    }
    // 同步状态到服务器
    async syncStatusToServer(status) {
        // 该兼容采集器未持有 run lease；状态由模块化 Collection 的 run API 同步。
        log.info(`兼容采集器本地状态：${status}`);
    }
    // 重置任务状态（用于重新执行）
    async resetTask() {
        this.collectionTask.progress = {};
        this.processed = 0;
        this.totalCount = 0;
        this.collectedLinks = [];
        this.isCancelled = false;
    }
    // 获取任务状态
    getStatus() {
        return this.collectionTask.taskStatus;
    }
    // 获取任务信息
    getTaskInfo() {
        return this.collectionTask;
    }
    // 创建采集窗口
    async createCollectionWindow() {
        return new Promise((resolve, reject) => {
            let targetUrl;
            try {
                targetUrl = normalizeOzonUrl(this.collectionTask.targetUrl);
            }
            catch (error) {
                reject(error);
                return;
            }
            this.browserWindow = new BrowserWindow({
                width: 1200,
                height: 800,
                show: true,
                frame: false,
                webPreferences: {
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                    partition: getAccountPartition('ozon'),
                    backgroundThrottling: false,
                },
            });
            const timeoutId = setTimeout(() => {
                reject(new Error('页面加载超时'));
                if (this.browserWindow) {
                    this.browserWindow.close();
                    this.browserWindow = null;
                }
            }, 100000);
            // 监听页面加载完成事件
            this.browserWindow.webContents.once('dom-ready', async () => {
                log.info('页面 DOM 已准备就绪');
                clearTimeout(timeoutId);
                try {
                    await this.parsePageData();
                    resolve();
                }
                catch (error) {
                    log.error('解析页面数据失败', error);
                    reject(error);
                }
            });
            // 监听窗口关闭事件
            this.browserWindow.on('closed', () => {
                if (this.collectionTask.taskStatus !== 'completed' && !this.isCancelled) {
                    this.updateStatus('failed');
                    this.outputLog('窗口异常关闭');
                    this.isCancelled = true;
                    reject(new Error('窗口异常关闭'));
                }
                this.browserWindow = null;
                resolve();
            });
            this.browserWindow.loadURL(targetUrl);
        });
    }
    // 模拟滚动并收集
    async simulateScrollAndCollect() {
        if (!this.browserWindow) {
            log.error('浏览器窗口不存在');
            return;
        }
        const targetCount = this.collectionTask.targetCount || 0;
        if (targetCount <= 0) {
            log.info('目标数量无效，跳过滚动采集');
            return;
        }
        await this.collectLinksByTargetCount(targetCount);
    }
    // 解析页面数据
    async parsePageData() {
        this.outputLog('正在解析页面数据');
        // 等待页面完全加载
        await this.delay(2000);
        // 开始滚动采集过程
        await this.simulateScrollAndCollect();
    }
    // 滚动延迟辅助函数
    async delay(ms) {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            this.timers.push(timer);
        });
    }
    // 生成随机延迟时间
    getRandomDelay(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    // 收集链接
    async collectLinksByTargetCount(targetCount) {
        if (!this.browserWindow)
            return [];
        // 清除之前的挂起任务
        this.pendingTasks = [];
        let scrollAttempts = 0;
        const maxScrollAttempts = 10; // 最大尝试次数
        this.outputLog(`开始采集链接，目标数量: ${targetCount}`);
        // 等待页面加载
        await this.delay(2000);
        // 获取初始链接
        const initialLinks = (await this.extractLinks()) || [];
        this.collectedLinks = [...initialLinks];
        this.processed = this.collectedLinks.length;
        if (initialLinks.length) {
            // 将初始链接加入队列而不是直接处理
            this.addToTaskQueue(initialLinks);
        }
        await this.outputLog(`初始加载 ${this.collectedLinks.length} 个链接`);
        // 如果还没达到目标数量，继续滚动加载
        while (this.totalCount < targetCount &&
            scrollAttempts < maxScrollAttempts &&
            !this.isCancelled) {
            const previousLength = this.collectedLinks.length;
            if (this.collectionTask.taskStatus === 'cancelled') {
                this.outputLog('任务被取消');
                return;
            }
            if (this.taskWindowS.length >= +this.collectionTask.targetCount) {
                return;
            }
            if (this.taskQueue.length > 20) {
                await this.delay(2000);
                log.info('任务队列数据源充足，等待处理中');
                continue;
            }
            // 随机延迟
            const randomDelay = this.getRandomDelay(1000, 2000);
            this.outputLog(`滚动加载中... (${scrollAttempts + 1}/${maxScrollAttempts})，已收集: ${this.collectedLinks.length}`);
            await this.delay(randomDelay);
            // 执行滚动操作 - 滚动整个页面
            const scrollSuccess = await this.performScroll();
            if (!scrollSuccess) {
                log.info('滚动操作未成功执行，可能已到达底部');
                break;
            }
            await this.delay(2000);
            // 提取新链接 - 从指定容器提取
            const newLinks = await this.extractLinks();
            const uniqueNewLinks = newLinks.filter((item) => !this.collectedLinks.map((obj) => obj.id).includes(item.id));
            if (uniqueNewLinks.length > 0) {
                this.collectedLinks = [...this.collectedLinks, ...uniqueNewLinks];
                this.processed += uniqueNewLinks.length;
                this.outputLog(`处理过的商品数量：${this.processedIds.size}`);
                // 将新链接加入队列而不是直接处理
                this.addToTaskQueue(uniqueNewLinks);
            }
            this.outputLog(`已收集 ${this.collectedLinks.length}个链接`);
            // 判断是否需要继续滚动
            if (this.collectedLinks.length === previousLength) {
                log.info('本次滚动未发现新链接');
                this.outputLog('本次滚动未发现新链接');
                scrollAttempts++;
            }
            else {
                scrollAttempts = 0; // 有新链接，重置尝试次数
            }
            // 如果已达到目标数量，停止滚动
            if (this.totalCount >= targetCount) {
                break;
            }
        }
        // 启动队列处理器
        this.startQueueProcessor();
        this.outputLog(`收集完成，共收集到 ${+this.collectionTask.targetCount} 个链接`);
        this.collectedLinks = this.collectedLinks.slice(0, targetCount);
        return this.collectedLinks;
    }
    // 添加到任务队列
    addToTaskQueue(links) {
        this.taskQueue.push(...links);
        // 如果队列处理器未运行，则启动它
        if (!this.isProcessingQueue) {
            this.startQueueProcessor();
        }
    }
    // 启动队列处理器
    async startQueueProcessor() {
        if (this.isProcessingQueue ||
            this.isCancelled ||
            this.totalCount === this.collectionTask.targetCount) {
            return; // 已经在处理中或已取消
        }
        this.isProcessingQueue = true;
        // 启动并发任务处理器
        const processors = [];
        const concurrentCount = Math.min(this.maxConcurrentTasks, 5);
        for (let i = 0; i < concurrentCount; i++) {
            processors.push(this.processQueue());
        }
        // 等待所有处理器完成
        await Promise.allSettled(processors);
        this.isProcessingQueue = false;
    }
    // 处理队列中的任务
    async processQueue() {
        while ((this.taskQueue.length > 0 || this.activeProcessors > 0) &&
            !this.isCancelled &&
            this.totalCount < this.collectionTask.targetCount) {
            if (this.collectionTask.taskStatus === 'cancelled') {
                this.isCancelled = true;
                break;
            }
            if (this.taskWindowS.length === this.collectionTask.targetCount) {
                log.info('已达到目标数量，停止处理队列');
                break; // 已达到目标数量
            }
            // 检查当前活跃处理器数量，控制并发
            if (this.taskQueue.length > 0 && this.activeProcessors < this.maxConcurrentTasks) {
                // 从队列中取出一批任务处理
                const batch = this.taskQueue.splice(0, this.maxConcurrentTasks); // 每次处理5个，可以根据需要调整
                if (batch.length > 0) {
                    this.activeProcessors++;
                    // 使用 addPendingTask 包装任务，确保能追踪完成状态
                    const task = this.handleSingleLink(batch);
                    this.addPendingTask(task)
                        .finally(() => {
                        this.activeProcessors--;
                    })
                        .catch((error) => {
                        log.error('处理单个链接时发生错误', error);
                    });
                }
            }
            // 短暂延迟，避免过度占用CPU
            await this.delay(1000);
        }
    }
    // 处理单个链接
    async handleSingleLink(links) {
        if (this.taskWindowS.length > +this.collectionTask.targetCount)
            return;
        if (!links.length)
            return;
        // 检查窗口是否存在且未被销毁
        if (this.checkBrowserAlice())
            return;
        const ids = links.map((link) => link.id).join(',');
        // 检查是否已经处理过此ID
        for (const link of links) {
            if (link.id && this.processedIds.has(link.id)) {
                this.outputLog(`跳过已处理的商品 ${link.id}`);
                continue;
            }
            this.outputLog(`获取商品数据中... ID: ${link.id}`);
            // 标记这个ID为已处理
            this.processedIds.add(link.id);
            // 获取跟卖人数
            if (this.browserWindow && !this.browserWindow.isDestroyed()) {
                try {
                    const response = await this.browserWindow.webContents.executeJavaScript(`
            fetch(${JSON.stringify(link.requestUrl)}, { credentials: 'include' })
            .then(response => response.json())
            .then(data => ({ success: true, data: data }))
          `);
                    if (response.success) {
                        link.sellerNumber =
                            JSON.parse(response.data.widgetStates?.['webSellerList-4723017-default-1'] || '{}')
                                ?.sellers?.length || 0;
                    }
                    else {
                        log.error('获取跟卖人数失败');
                    }
                }
                catch (error) {
                    log.error(`获取商品 ${link.id} 的跟卖人数失败:`, error);
                }
            }
        }
        try {
            // 获取商品详细数据
            const analytics = await fetchSellerSkuAnalyticsBatch(links.map((item) => item.id), {
                period: this.collectionTask.period === 'weekly' ? 'weekly' : 'monthly',
            });
            const integratedData = await this.integrateAndFilterData(links, analytics);
            if (integratedData.length > 0) {
                if (this.isCancelled)
                    return;
                this.outputLog('表格写入中...');
                // 写入Excel
                const saveResult = await this.excel?.appendAndSave(integratedData);
                this.totalCount += integratedData.length;
                this.collectionTask.tableFilePath = this.tableFilePath;
                if (!saveResult) {
                    this.outputLog(`输出表格文件处于编辑状态中，写入失败... ID: ${integratedData.map((item) => item.id).join(',')}`);
                }
                else {
                    this.outputLog(`表格写入完成，新增 ${integratedData.length} 条记录，ID: ${integratedData.length}`);
                }
            }
            else {
                this.outputLog(`商品 ${ids} 经过过滤后不符合条件`);
            }
        }
        catch (error) {
            log.error(`${this.collectionTask.taskName} 处理商品 ${ids} 时出错:`, error);
            this.outputLog(`商品 ${ids} 处理失败: ${error || '未知错误'}`);
        }
        finally {
            this.processed--;
        }
    }
    // 执行滚动操作 - 滚动整个页面窗口
    async performScroll() {
        if (!this.browserWindow || this.browserWindow.isDestroyed())
            return false;
        try {
            const result = await this.browserWindow.webContents.executeJavaScript(`
  (function () {
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

      const duration = 600; // 滚动时长 ms
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
  })();
`);
            return result === true;
        }
        catch (error) {
            log.error(`${this.collectionTask.taskName}执行滚动时出错:`, error);
            return false;
        }
    }
    // 提取链接
    async extractLinks() {
        if (!this.browserWindow || this.browserWindow.isDestroyed())
            return [];
        try {
            const html = await this.browserWindow.webContents.executeJavaScript('document.documentElement.outerHTML');
            const $ = cheerio.load(html);
            const links = $('#contentScrollPaginator a');
            const linksParent = [];
            const domain = new URL(this.browserWindow.webContents.getURL()).origin;
            // 解析DOM，获取商品数据
            links.each((index, element) => {
                const href = $(element).attr('href');
                const cover = $(element).find('img')?.attr('src');
                const id = href?.match(/-(\d+)(?=\/|\?)/)?.[1];
                const queryUrl = encodeURIComponent(`/modal/otherOffersFromSellers?product_id=${id}&page_changed=true`);
                const requestUrl = `${domain}/api/entrypoint-api.bx/page/json/v2?url=${queryUrl}`;
                const link = `https://www.ozon.ru/product/${id}`;
                const price = $(element)
                    .parent()
                    .find('.tsHeadline500Medium')
                    .text()
                    .trim()
                    .replace(/[\s\u2009₽]/g, '');
                const oPrice = $(element)
                    .parent()
                    .find('.tsBodyControl400Small')
                    .text()
                    .match(/[\d\s\u2009]+(?=₽)/)?.[0]
                    ?.replace(/[\s\u2009]/g, '');
                const discount = $(element)
                    .parent()
                    .find('.tsBodyControl400Small')
                    .text()
                    .trim()
                    .match(/-\d+%|\d+%/)?.[0];
                const name = $(element).parent().find('a').children('div').children('span').text();
                const rating = Number($(element)
                    .parent()
                    .find('.p6b3_0_6-a4')
                    .find('svg')
                    .next()
                    .text()
                    .match(/\d+\.\d+/)?.[0]).toFixed(1);
                const reviewCount = Number($(element)
                    .parent()
                    .find('.p6b3_0_6-a4')
                    .find('svg')
                    .next()
                    .text()
                    .match(/(\d+)\s*отзывов/)?.[1]) || 0;
                if (!linksParent.map((item) => item.id).includes(id)) {
                    linksParent.push({
                        href,
                        price: Number(price),
                        oPrice,
                        discount,
                        link,
                        cover,
                        name,
                        id,
                        rating,
                        sku: id,
                        requestUrl,
                        reviewCount,
                    });
                }
            });
            return linksParent;
        }
        catch (error) {
            log.error(`${this.collectionTask.taskName}提取链接时出错:`, error);
            return [];
        }
    }
    // 获取1688数据
    async get1688Data(link) {
        let timer = undefined;
        this.taskWindowS.push(link.id);
        return new Promise(async (resolve, reject) => {
            try {
                let win = await new BrowserWindow({
                    width: 1200,
                    height: 800,
                    show: false,
                    webPreferences: {
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                        preload: path.join(__dirname, '../preloads/1688preload.js'),
                        partition: getAccountPartition('1688'),
                    },
                });
                timer = setInterval(() => {
                    if (this.isCancelled) {
                        win && win.destroy();
                        win = null;
                        reject('取消任务');
                        clearInterval(timer);
                    }
                }, 1000);
                await new Promise((resolve) => setTimeout(resolve, 2000));
                let processed = false;
                win?.webContents?.on('console-message', async (event, level, message) => {
                    if (processed)
                        return;
                    if (message.includes('tab=imageSearch') || message.includes('imageId')) {
                        processed = true;
                        if (this.collectionTask.sourceType === '1') {
                            await win?.webContents?.executeJavaScript(`
                new Promise((resolve,reject)=>{
                  try {
                     const list = document.querySelectorAll('.sortItem--X1Plgn6V')
                  for (const el of list) {
                    if (el.textContent === '价格') {
                      el.click()
                      break
                    }
                  }
                    resolve(true)
                  } catch (error) {
                    reject(false)
                  }
                })
            `);
                        }
                        else if (this.collectionTask.sourceType === '2') {
                            await win?.webContents?.executeJavaScript(`
                new Promise((resolve,reject)=>{
                try {
                  const list = document.querySelectorAll('.sortItem--X1Plgn6V')
                  for (const el of list) {
                    if (el.textContent === '销量') {
                      el.click()
                      break
                    }
                  }
                    resolve(true)
                } catch (error) {
                  reject(error)
                }
                })
            `);
                        }
                        await new Promise((resolve) => setTimeout(resolve, 10000));
                        const html = await win?.webContents?.executeJavaScript(`new Promise((resolve,reject)=>{
            try {
              resolve(document.documentElement.outerHTML)
            } catch (error) {
              reject(error)
            }
            })`);
                        const $ = cheerio.load(html);
                        const str = $('.offerListLayoutWrapper--o0LXuuFm')
                            .children('div')
                            .first()
                            .attr('data-renderkey')
                            ?.split('_');
                        const price1 = $('.offerListLayoutWrapper--o0LXuuFm')
                            .children('div')
                            .first()
                            .children('.offer-price-row')
                            .find('.textMain--s_l2eHVJ')
                            .text();
                        const price2 = $('.offerListLayoutWrapper--o0LXuuFm')
                            .children('div')
                            .first()
                            .children('.offer-price-row')
                            .find('.textMain--s_l2eHVJ')
                            .next()
                            .text();
                        link['1688link'] = `https://detail.1688.com/offer/${str?.[str?.length - 1]}.html`;
                        const sourcePrice = `${price1}${price2}`;
                        link.sourcePrice = isNaN(Number(sourcePrice)) ? 0 : sourcePrice;
                        link.cover2 = $('.offerListLayoutWrapper--o0LXuuFm')
                            .children('div')
                            .find('.mainImg--GT1EYFGa')
                            .attr('src');
                        win?.destroy();
                        clearInterval(timer);
                        resolve(link);
                    }
                });
                win.loadURL('https://pages-fast.1688.com/wow/cbu/srch_rec/image_search/youyuan/index.html?');
                await win?.webContents?.executeJavaScript(`
        new Promise(async (resolve, reject) => {
          try {
            const response = await fetch(${JSON.stringify(link.cover)});
            imageBlob = await response.blob();
            // 查找上传输入框
            const uploadInput = document.querySelector('input[type="file"]') ||
                               document.querySelector('[accept*="image"]') ||
                               Array.from(document.querySelectorAll('input')).find(el =>
                                 el.type === 'file' || el.accept?.includes('image')
                               );

            if (!uploadInput) {
              console.error('未找到文件上传输入框');
              console.log('页面内容片段:', document.body.innerHTML.substring(0, 500));
              reject(new Error('未找到上传输入框'));
              return;
            }

            console.log('✅ 找到上传输入框:', uploadInput);

            // 创建File对象
            const file = new File([imageBlob], 'search-image.jpg', { type: 'image/jpeg' });

            // 使用DataTransfer设置文件
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            uploadInput.files = dataTransfer.files;

            // 触发change事件
            const changeEvent = new Event('change', { bubbles: true });
            uploadInput.dispatchEvent(changeEvent);

            // 触发input事件
            const inputEvent = new Event('input', { bubbles: true });
            uploadInput.dispatchEvent(inputEvent);


            // 等待图片预览加载
            await new Promise(r => setTimeout(r, 2000));

            // 查找并点击"搜索图片"按钮
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
              console.log('搜索按钮相关元素:', document.querySelector('[class*="search"]'));
              reject(new Error('未找到搜索按钮'));
              return;
            }

            console.log('✅ 找到搜索按钮:', searchButton.textContent, searchButton.className);

            // 点击搜索按钮
            searchButton.click();

            console.log('✅ 已点击搜索按钮，等待跳转到结果页...');

            // 等待页面跳转和结果加载
            await new Promise(r => setTimeout(r, 3000));

            resolve({ success: true, message: '图片上传并搜索成功' });

          } catch (error) {
            console.error('上传过程出错:', error);
            reject(error);
          }
        })
      `);
            }
            catch (error) {
                this.taskWindowS.splice(this.taskWindowS.indexOf(link.id), 1);
                reject(error);
            }
        });
    }
    // 整合和过滤数据的方法
    async integrateAndFilterData(links, apiData) {
        if (this.taskWindowS.length >= +this.collectionTask.targetCount)
            return [];
        try {
            const apiDataMap = new Map();
            (apiData.map((item) => ({ ...item, ...item.data })) || []).forEach((item) => {
                if (item.goods_id) {
                    apiDataMap.set(item.goods_id, item);
                }
            });
            const integratedData = links.map((link) => {
                const apiItem = apiDataMap.get(link.id);
                if (apiItem) {
                    return { ...link, ...apiItem, productId: link.id };
                }
                return { ...link, productId: link.id };
            });
            const filteredData = await this.filterData(integratedData);
            for (const link of filteredData) {
                if (this.isCancelled)
                    return [];
                if (this.taskWindowS.length >= +this.collectionTask.targetCount) {
                    filteredData.splice(this.taskWindowS.indexOf(link.id), 1);
                    continue;
                }
                await this.get1688Data(link);
                await this.delay(1000);
            }
            const finalIntegratedData = await this.integrateAdditionalData(filteredData);
            return finalIntegratedData;
        }
        catch (error) {
            log.error('整合数据时出错:', error);
            return [];
        }
    }
    async integrateAdditionalData(filteredData) {
        try {
            const res2 = await calculateCollectorPricing({
                operation: this.collectionTask.upMode == 2 ? 'goodsFilter2' : 'goodsFilter',
                mode: this.collectionTask.upMode == 2 ? 'profit' : 'pricing',
                taskId: this.collectionTask._id,
                operatingStoreId: this.collectionTask.operatingStoreId || this.collectionTask.storeId || '',
                dataCollectionStoreId: this.collectionTask.dataCollectionStoreId || '',
                task: this.collectionTask,
                items: filteredData,
            });
            const entries = Array.isArray(res2?.data) ? res2.data : (res2?.items || []);
            const pricedItems = entries.map((entry) => ({
                ...(entry?.compatibility || entry?.result || entry),
                pricingResult: entry?.result || undefined,
                pricingAdjustment: entry?.adjustment || undefined,
            }));
            if (pricedItems.length) {
                const additionalDataMap = new Map();
                pricedItems.forEach((item) => {
                    additionalDataMap.set(item.id, item);
                });
                // 合并数据
                return filteredData.map((item) => {
                    const additionalData = additionalDataMap.get(item.id);
                    if (additionalData) {
                        return { ...item, ...additionalData };
                    }
                    return item;
                });
            }
            return filteredData;
        }
        catch (error) {
            log.error('获取额外数据时出错:', error);
            return filteredData;
        }
    }
    // 过滤数据
    async filterData(data) {
        if (!data || !Array.isArray(data) || data.length === 0) {
            return [];
        }
        const task = this.collectionTask;
        // 定义过滤条件映射
        const filters = [
            // 品牌类型过滤
            (item) => {
                if (task?.brandType === undefined || task?.brandType === null || +task?.brandType === 2)
                    return true;
                if (+task?.brandType === 0)
                    return item.brand && item.brand.trim();
                if (+task?.brandType === 1)
                    return !(item.brand && item.brand.trim());
                return true;
            },
            // 销量范围校验
            (item) => {
                const result = this.checkRange(item.soldCount, task.soldCountMin, task.soldCountMax);
                return result;
            },
            // 月销售额范围校验
            (item) => {
                const result = this.checkRange(item.gmvSum, task.gmvSumMin, task.gmvSumMax);
                return result;
            },
            // 销售价格范围校验
            (item) => {
                const result = this.checkRange(item.price, task.salePriceMin, task.salePriceMax);
                return result;
            },
            // 重量范围校验
            (item) => {
                const result = this.checkRange(item.weight, task.weightMin, task.weightMax);
                return result;
            },
            // 上架时间范围校验
            (item) => {
                const result = this.checkRange(item.upTimeDays, task.upGoodsTimeMin, task.upGoodsTimeMax);
                return result;
            },
            // 月销售动态范围校验
            (item) => {
                const result = this.checkRange(item.salesDynamics, task.monthDynamicsMin, task.monthDynamicsMax);
                return result;
            },
            // 广告份额范围校验
            (item) => {
                const result = this.checkRange(item.drr, task.adFeeMin, task.adFeeMax);
                return result;
            },
            // 参与促销天数范围校验
            (item) => {
                const result = this.checkRange(item.daysInPromo, task.promotionDayMin, task.promotionDayMax);
                return result;
            },
            // 参与促销折扣范围校验
            (item) => {
                const result = this.checkRange(item.discount, task.promotionDiscountMin, task.promotionDiscountMax);
                return result;
            },
            // 促销活动转化率范围校验
            (item) => {
                const result = this.checkRange(item.promoRevenueShare, task.promotionDynamicsMin, task.promotionDynamicsMax);
                return result;
            },
            // 付费推广天数范围校验
            (item) => {
                const result = this.checkRange(item.daysWithTrafarets, task.promoteDayMin, task.promoteDayMax);
                return result;
            },
            // 浏览量范围校验
            (item) => {
                const result = this.checkRange(item.sessionCount, task.viewsMin, task.viewsMax);
                return result;
            },
            // 商品卡片加购率范围校验
            (item) => {
                const result = this.checkRange(item.convToCartPdp, task.cardRateMin, task.cardRateMax);
                return result;
            },
            // 搜索和目录加购率范围校验
            (item) => {
                const result = this.checkRange(item.convToCartSearch, task.showRateMin, task.showRateMax);
                return result;
            },
            // 跟卖人数范围校验
            (item) => {
                const result = this.checkRange(item.sellerNumber, task.followMin, task.followMax);
                return result;
            },
            // 最小利润率校验
            /*       (item: any) => {
                    const result = this.checkRange(item.myProfitMargin, task.targetProfitPercent, undefined);
                    return result;
                  }, */
        ];
        const filteredData = data.filter((item) => {
            const results = filters.map((filterFn) => filterFn(item));
            const overallResult = results.every((r) => r);
            return overallResult;
        });
        log.info(filteredData.length, '筛选后的数据');
        return filteredData;
    }
    /**
     * 检查数值是否在范围内
     * @param value 待检查的值
     * @param min 最小值
     * @param max 最大值
     * @returns 是否符合范围
     */
    checkRange(value, min, max) {
        let numValue = null;
        if (min === 0 && max === 0)
            return true;
        if (typeof value === 'string') {
            numValue = Number(value);
        }
        else if (typeof value === 'number') {
            numValue = value;
        }
        else if (typeof value === 'undefined') {
            numValue = 0;
        }
        else {
            numValue = Number(value);
        }
        if (isNaN(numValue)) {
            return false;
        }
        if (min !== undefined && min !== null && min > 0 && numValue < min) {
            return false;
        }
        if (max !== undefined && max !== null && max > 0 && numValue > max) {
            return false;
        }
        return true;
    }
    setFilePath() {
        this.collectionTask.tableFilePath = this.tableFilePath;
    }
    // 初始化表格
    async initTable() {
        if (!this.excel) {
            log.error('表格实例初始化失败');
            return;
        }
        try {
            // 定义所有列
            const columns = [
                // 基础信息
                { header: '商品ID', key: 'id', width: 15 },
                { header: '商品链接', key: 'link', width: 30 },
                { header: '商品主图', key: 'cover', width: 20 },
                { header: '商品名称', key: 'name', width: 30 },
                { header: '商品名称（中文）', key: 'cnName', width: 30 },
                { header: '商品类目', key: 'category3', width: 20 },
                { header: '类目佣金（RFBS）', key: 'commissionRfbs', width: 15 },
                { header: '类目佣金（FBP）', key: 'commissionFbp', width: 15 },
                { header: '品牌', key: 'brand', width: 20 },
                { header: '销售价格（卢布）', key: 'price', width: 15 },
                { header: '原价（卢布）', key: 'oPrice', width: 15 },
                { header: '商品评分', key: 'rating', width: 10 },
                { header: '评价次数', key: 'reviewCount', width: 10 },
                { header: '跟卖人数', key: 'sellerNumber', width: 10 },
                { header: '商品创建日期', key: 'createDate', width: 15 },
                { header: '上架时间（天）', key: 'upTimeDays', width: 15 },
                { header: '发货模式', key: 'shippingMode', width: 15 },
                // 销售数据
                { header: '月销售额(卢布)', key: 'gmvSum', width: 15 },
                { header: '月销售动态(%)', key: 'salesDynamics', width: 15 },
                { header: '月销量(件)', key: 'soldCount', width: 10 },
                { header: '平均日销售额(卢布)', key: 'avgPrice', width: 15 },
                { header: '平均日销量(件)', key: 'avgDailySalesUnits', width: 10 },
                { header: '搜索和目录浏览量', key: 'sessionCountSearch', width: 15 },
                { header: '商品卡片浏览量', key: 'sessionCount', width: 15 },
                { header: '搜索和目录加购率(%)', key: 'convToCartSearch', width: 15 },
                { header: '商品卡片加购率(%)', key: 'convToCartPdp', width: 15 },
                { header: '广告份额（%）', key: 'drr', width: 10 },
                { header: '参与促销天数', key: 'daysInPromo', width: 12 },
                { header: '参与促销折扣(%)', key: 'discount', width: 15 },
                { header: '促销活动的转化率(%)', key: 'promoRevenueShare', width: 15 },
                { header: '付费推广天数', key: 'daysWithTrafarets', width: 12 },
                { header: '平均价格(卢布)', key: 'avgPrice', width: 15 },
                { header: '已错过销售(卢布)', key: 'sumMissedGmv', width: 15 },
                { header: '商品可用性(%)', key: 'accessibility', width: 15 },
                // 物流信息
                { header: '配送时间（天）', key: 'avgDeliveryDays', width: 12 },
                { header: '商品体积（升）', key: 'volume', width: 12 },
                { header: '包装长(mm)', key: 'length', width: 12 },
                { header: '包装宽(mm)', key: 'width', width: 12 },
                { header: '包装高(mm)', key: 'height', width: 12 },
                { header: '包装重量(g)', key: 'weight', width: 12 },
                // 成本和利润
                { header: 'RFBS佣金(元)', key: 'fbsPrice', width: 15 },
                { header: '国际物流', key: 'internalExpress', width: 15 },
                { header: '国际物流费用（元）', key: 'logisticsMoney', width: 15 },
                { header: '国内运费（元）', key: 'endDeliveryFee', width: 15 },
                { header: '其他费用（提醒、货损）（元）', key: 'elsePrice', width: 20 },
                { header: '1688货源地址', key: '1688link', width: 30 },
                { header: '货源图片', key: 'cover2', width: 20 },
                { header: '货源价格（元）', key: 'sourcePrice', width: 15 },
                { header: '对方利润率（%）', key: 'otherProfitPercent', width: 15 },
                { header: '对方利润（元）', key: 'otherProfit', width: 15 },
                { header: '我的售价（元）', key: 'resMoney', width: 15 },
                { header: '我的利润率（%）', key: 'myProfitMargin', width: 15 },
                { header: '我的利润（元）', key: 'myProfit', width: 15 },
            ];
            // 首先设置列定义
            await this.excel.init();
            await this.excel.clearContent();
            // 检查是否已有列定义（即是否已有表头）
            const worksheet = this.excel.getWorksheet();
            const hasHeaders = worksheet.getRow(1).values && worksheet.getRow(1).values.length;
            if (!hasHeaders) {
                // 没有表头，设置列定义和表头
                this.excel.setColumns(columns);
                // 在第一行插入主类别标题
                const mainCategoryRowValues = Array(columns.length).fill('');
                worksheet.spliceRows(1, 0, mainCategoryRowValues);
                // 设置主类别标题
                worksheet.getCell('A1').value = '基础信息';
                worksheet.getCell('R1').value = '销售数据';
                worksheet.getCell('AJ1').value = '尺寸重量';
                worksheet.getCell('AO1').value = '我的定价';
                // 合并单元格
                this.excel.mergeCells('A1:Q1'); // 基础信息 (A1-Q1, 17列)
                this.excel.mergeCells('R1:AI1'); // 销售数据 (R1-BG1, 从第18列到第55列，共38列)
                this.excel.mergeCells('AJ1:AN1'); // 尺寸重量 (BJ1-BN1, 从第52列到第56列，共5列)
                this.excel.mergeCells('AO1:BA1'); // 我的定价 (BO1-BZ1, 从第57列到第78列，共22列)
                // 设置表头样式 - 只设置第1行（主类别标题）
                this.excel.setRowStyle(1, {
                    font: { bold: true, size: 12 },
                    alignment: { vertical: 'middle', horizontal: 'center' },
                    fill: {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'fff3ca' },
                    },
                });
                // 设置第2行作为具体列标题行
                const headerRow = worksheet.getRow(2);
                columns.forEach((col, index) => {
                    headerRow.getCell(index + 1).value = col.header;
                });
                this.excel.setRowStyle(2, {
                    font: { bold: true, size: 10 },
                    alignment: { vertical: 'middle', horizontal: 'center' },
                    fill: {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'd9d9d9' },
                    },
                });
                log.info('Excel 表头初始化完成');
            }
            else {
                log.info('Excel 表头已存在，跳过初始化');
            }
        }
        catch (error) {
            log.error('初始化 Excel 表头失败:', error);
        }
    }
    // 终止任务
    async cancel() {
        if (this.isCancelled)
            throw new Error('任务正在取消中，请勿频繁请求...');
        this.outputLog('任务取消中...');
        this.isCancelled = true;
        this.timers.forEach((timer) => {
            if (timer) {
                clearTimeout(timer);
            }
        });
        this.timers = [];
        if (this.browserWindow) {
            this.browserWindow.close();
            this.browserWindow = null;
        }
        if (this.excel) {
            await this.excel.flushToDisk();
        }
        await this.waitForAllPendingTasks();
        this.processed = 0;
        this.taskWindowS = [];
        this.updateStatus('cancelled');
        this.outputLog('任务已取消');
    }
    // 检查浏览器是否存活
    checkBrowserAlice() {
        if (this.isCancelled) {
            return true;
        }
        if (!this.browserWindow || this.browserWindow.isDestroyed()) {
            this.updateStatus('failed');
            this.outputLog('浏览器窗口已被销毁，跳过链接处理');
            log.warn('浏览器窗口已被销毁，跳过链接处理');
            this.isCancelled = true;
            return true;
        }
        return false;
    }
    async run() {
        try {
            await this.initTable();
            this.updateStatus('running');
            this.outputLog('开始执行任务...');
            await this.createCollectionWindow();
            await this.waitForAllPendingTasks();
            while (this.isProcessingQueue || this.activeProcessors > 0) {
                await this.delay(500); // 等待500ms后再次检查
            }
            if (this.browserWindow) {
                this.browserWindow.close();
                this.browserWindow = null;
            }
            this.updateStatus('completed');
            this.outputLog('任务执行完成');
            return this.collectionTask;
        }
        catch (error) {
            log.error(`${this.collectionTask.taskName}任务执行失败`, error);
            this.updateStatus('failed');
            this.outputLog(`任务执行失败: ${error}`);
            return this.collectionTask;
        }
        finally {
            // 确保清理资源
            this.processed = 0;
            this.isProcessingQueue = false;
            this.activeProcessors = 0;
            this.isCancelled = true;
            this.taskWindowS = [];
            this.outputLog('重置进度详情');
        }
    }
}

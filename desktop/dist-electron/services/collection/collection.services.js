import { MainWindowService } from './main-window.services.js';
import { WindowService } from './1688-window.services.js';
import { ExcelService } from './excel.services.js';
import { TaskQueueService } from './task-queue.services.js';
import { DataProcessService } from './data-filter.services.js';
import { ParseService } from './parse.services.js';
import log from '../../log/index.js';
import dayjs from 'dayjs';
import { randomUUID } from 'crypto';
import { memoryMonitor } from '../memory-monitor.services.js';
import {
    appendCollectorRunEvent,
    appendCollectorRunItem,
    cancelCollectorRun,
    claimCollectorRun,
    completeCollectorRun,
    createCollectorRun,
    failCollectorRun,
    heartbeatCollectorRun,
    requestCollectorRunCancellation,
    saveCollectorCategoryMapping,
    saveCollectorMarketSnapshot,
} from '../collector-backend.services.js';
import { fetchSellerLeaderboard, verifyCurrentSellerStore } from '../seller-ozon.services.js';
import { assertSellerRunContext } from '../seller-analytics.core.js';
export class Collection {
    uuid = undefined;
    task; // 任务信息
    mainWindow = null; // 主窗口
    mainWindowService; // ozon窗口
    windowService; // 1688窗口
    taskQueueService; // 1688任务队列
    excelService;
    dataProcessService;
    parseService;
    targetData = 0; // 完成的任务
    reason = undefined;
    isCleared = false;
    goodsData = new Map();
    process = 0; // 正在处理的任务
    goodsNum = 0; // 获取商品的数量
    writeError = false; // 写入错误
    isWrite = false; // 是否写入
    writeQueue = [];
    expendShopCount = 0;
    total = 0;
    runId = '';
    leaseToken = '';
    preparedRun = null;
    preparedClean = false;
    heartbeatFailures = 0;
    heartbeatTimer = null;
    sellerContext = null;
    cancellationController = new AbortController();
    cancellationPromise = null;
    query = {
        pageNo: 1,
        pageSize: 30,
        total: 0,
        maxPage: 99,
        categories: [],
        lastSortValues: [],
    };
    constructor(task, mainWindow) {
        this.task = task;
        this.mainWindow = mainWindow;
        this.mainWindowService = new MainWindowService(this.closeHandle);
        const itemConcurrency = Math.min(20, Math.max(2, Number(task.concurrency || task.maxConcurrent || 4)));
        this.taskQueueService = new TaskQueueService(this.taskHandle, itemConcurrency);
        this.excelService = new ExcelService(this.task._id, task.taskName);
        this.dataProcessService = new DataProcessService(task);
        this.dataProcessService.setCancellationSignal(this.cancellationController.signal);
        this.parseService = new ParseService(this.mainWindowService);
        this.windowService = new WindowService(this.parseService);
        const selectedCategories = [...new Set(task.categoryIds?.flat(2) || [])];
        this.query.categories = selectedCategories.includes('*') || selectedCategories.includes('__all__')
            ? []
            : selectedCategories;
        this.initQueryParams(task);
    }

    restoreRun(run = {}) {
        const runId = String(run.id || run._id || run.runId || '');
        if (!runId)
            throw new Error('恢复任务缺少运行 ID');
        this.runId = runId;
        this.preparedRun = { ...run, id: runId };
        this.preparedClean = false;
        this.uuid = String(run.idempotencyKey || randomUUID());
        this.task.currentRunId = runId;
        this.task.taskStatus = String(run.status || '').toUpperCase() === 'QUEUED' ? 'pending' : 'running';
        return runId;
    }

    applyVerifiedSellerScope(verification, run = this.preparedRun || {}) {
        const current = {
            accountId: String(verification.accountId || ''),
            source: String(verification.source || 'ozon_seller_analytics'),
            sourceIdentity: String(verification.sourceIdentity || ''),
        };
        const expected = this.sellerContext || run.configurationSnapshot?.sourceContext || {};
        assertSellerRunContext(current, expected);
        this.sellerContext = current;
    }

    async prepareRun() {
        if (this.runId)
            return this.preparedRun;
        await this.resetTask();
        this.uuid = randomUUID();
        const verification = await verifyCurrentSellerStore();
        this.applyVerifiedSellerScope(verification);
        const run = await createCollectorRun(this.task._id, {
            idempotencyKey: this.uuid,
            pricingConfigVersionId: this.task.pricingConfigVersionId,
        });
        this.restoreRun(run);
        this.preparedClean = true;
        this.task.taskStatus = 'pending';
        return this.preparedRun;
    }

    run() {
        let settled = false;
        const safeResolve = (v, resolve) => {
            if (settled)
                return;
            settled = true;
            resolve({
                filePath: this.task.tableFilePath || '',
                progress: { ...this.task.progress, current: 0 },
            });
        };
        const safeReject = (e, reject) => {
            if (settled)
                return;
            settled = true;
            reject({
                filePath: this.task.tableFilePath || '',
                progress: { ...this.task.progress, current: 0 },
            });
        };
        return new Promise(async (resolve, reject) => {
            try {
                memoryMonitor.trackBusinessMetrics({
                    taskId: this.task._id,
                    taskName: this.task.taskName,
                    phase: 'start',
                });
                if (!this.runId) {
                    await this.prepareRun();
                }
                else if (!this.preparedClean) {
                    await this.resetTask({ preserveRun: true });
                    this.preparedClean = true;
                }
                const verification = await verifyCurrentSellerStore();
                this.applyVerifiedSellerScope(verification);
                if (!this.runId)
                    throw new Error('sonli 未返回采集运行 ID');
                const claim = await claimCollectorRun(this.runId);
                this.leaseToken = claim.leaseToken;
                if (!this.leaseToken)
                    throw new Error('sonli 未返回采集运行租约');
                this.dataProcessService.setSellerContext({
                    ...this.sellerContext,
                    taskId: this.task._id,
                    runId: this.runId,
                });
                this.startHeartbeat();
                this.updateStatus('running');
                this.outputLog('窗口创建成功，任务开始执行');
                await this.mainWindowService.createCollectionWindow(this.task.targetUrl || 'https://www.ozon.ru');
                if (this.task.isUseCategorySelect === 0) {
                    this.outputLog(`分类选品模式`);
                    await this.categoryMode(this.task.targetCount || Infinity);
                }
                else {
                    this.outputLog('页面解析成功，开始获取商品列表');
                    await this.getHtmlData(this.task.targetCount || Infinity);
                }
                await this.waitForAllTasks();
                await this.expendShop();
                memoryMonitor.trackBusinessMetrics({
                    taskId: this.task._id,
                    phase: 'collected',
                    goodsDataSize: this.goodsData.size,
                    parseServiceDataSize: this.parseService.getDataCount(),
                });
                if (this.reason !== 'success') {
                    if (this.runId && this.leaseToken) {
                        if (this.reason === 'cancel') {
                            await cancelCollectorRun(this.runId, this.leaseToken, {
                                reason: 'USER_CANCELLED',
                            });
                        }
                        else {
                            await failCollectorRun(this.runId, this.leaseToken, {
                                code: 'COLLECTION_ABORTED',
                                message: this.reason || '采集任务异常终止',
                            });
                        }
                        this.runId = '';
                        this.leaseToken = '';
                    }
                    safeReject('任务已被终止', reject);
                    return;
                }
                await this.reWriteTable();
                await completeCollectorRun(this.runId, this.leaseToken, {
                    collectedCount: this.goodsData.size,
                    exportedFilePath: this.task.tableFilePath || '',
                });
                this.runId = '';
                this.leaseToken = '';
                this.task.taskStatus = 'completed';
                this.outputLog('任务完成');
            }
            catch (error) {
                if (this.reason === 'cancel' || error?.code === 'COLLECTION_CANCELLED') {
                    this.reason = 'cancel';
                    await this.cancellationPromise?.catch((cancelError) => {
                        log.error('等待采集任务取消收尾失败', cancelError);
                    });
                    return;
                }
                log.error('采集任务执行失败', error);
                if (this.runId && this.leaseToken) {
                    await failCollectorRun(this.runId, this.leaseToken, error).catch((runError) => {
                        log.error('同步采集失败状态失败', runError);
                    });
                    this.runId = '';
                    this.leaseToken = '';
                }
                this.updateStatus('failed');
                this.outputLog(`采集失败：${error}`);
            }
            finally {
                if (this.task.taskStatus === 'running') {
                    switch (this.reason) {
                        case 'cancel':
                            this.updateStatus('cancelled');
                            this.outputLog('任务已取消');
                            break;
                        case 'failed':
                            this.updateStatus('failed');
                            this.outputLog('任务失败');
                            break;
                        default:
                            this.updateStatus('completed');
                            this.outputLog('任务成功');
                            break;
                    }
                }
                log.info(`ID：${this.task._id} 名称：${this.task.taskName}任务结束，最终状态：${this.task.taskStatus}，开始清理工作`);
                this.stopHeartbeat();
                this.mainWindowService.destroy();
                // this.clearStatus(true)
                // 清理后手动触发 GC
                memoryMonitor.forceGC();
                safeResolve(this.task, resolve);
                log.info(`ID：${this.task._id} 名称：${this.task.taskName}任务结束，最终状态：${this.task.taskStatus}，完成清理工作`);
                memoryMonitor.trackBusinessMetrics({
                    taskId: this.task._id,
                    phase: 'cleanup',
                    goodsDataSize: this.goodsData.size,
                });
            }
        });
    }
    /**
     * 分类选品模式
    */
    async categoryMode(targetCount) {
        const dataList = await this.getCategoryGoodsList();
        const targetList = await this.parseService.ozonDetailListParser(dataList);
        this.outputLog('获取商品成功');
        await this.categoryProcess(targetList);
        try {
            while (this.targetData < targetCount) {
                if (this.reason && this.reason !== 'success')
                    throw new Error('任务终止');
                if (this.reason === 'success')
                    break;
                if (this.taskQueueService.getTaskCount() > 20) {
                    this.outputLog(`任务队列数据源充足，等待处理中。分类总数量${this.total}`);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }
                const dataList = await this.getCategoryGoodsList();
                const targetList = await this.parseService.ozonDetailListParser(dataList);
                this.outputLog(`获取商品成功。分类总数量${this.total}`);
                await this.categoryProcess(targetList);
            }
            if (!this.reason)
                this.reason = 'success';
        }
        catch (error) {
            return error;
        }
    }
    /**
     * 分类模式处理
      */
    async categoryProcess(list) {
        const filterData = await this.dataProcessService.filterData(list, this.task, 'base');
        if (!filterData.length)
            return;
        const baseData = [];
        const apiList = [];
        for (const goods of filterData) {
            if (this.targetData >= (this.task.targetCount || Infinity))
                return;
            apiList.push(this.getHtmlDetailData(goods));
        }
        const res = await Promise.all(apiList);
        res.forEach(item => {
            if (item.price) {
                const url = `https://www.ozon.ru/product/${item.id}`;
                baseData.push({ href: url, ...item });
            }
        });
        const targetData = await this.dataProcessService.filterData(baseData, this.task, 'detail');
        this.process += targetData.length;
        if (targetData.length &&
            this.reason !== 'cancel' &&
            this.reason !== 'failed' &&
            this.targetData < (this.task.targetCount || Infinity)) {
            this.taskQueueService.addTask(targetData);
            this.taskQueueService.startProcessing();
            this.outputLog('处理符合筛选条件的商品中');
        }
    }
    /**
     * 获取商品列表
      */
    async getCategoryGoodsList() {
        this.outputLog(`获取分类商品`);
        const data = await fetchSellerLeaderboard({
            period: this.task.period === 'weekly' ? 'weekly' : 'monthly',
            categories: this.query.categories,
            sortKey: this.task.sortKey || 'sum_gmv_desc',
            limit: this.query.pageSize,
            offset: (this.query.pageNo - 1) * this.query.pageSize,
            expectedContext: this.sellerContext,
        });
        const list = data.items || [];
        if (!data.total || list.length < this.query.pageSize)
            this.reason = 'success';
        this.query.pageNo += 1;
        this.query.maxPage = Math.max(1, Math.ceil(data.total / this.query.pageSize));
        this.total = data.total;
        list.forEach((item) => {
                if (item.brand === 'без бренда')
                    item.brand = '';
                if (item.nullableCreateDate) {
                    item.nullableCreateDate = dayjs(item.nullableCreateDate).format('YYYY-MM-DD');
                    item.releaseDate = dayjs().diff(dayjs(item.nullableCreateDate), 'day');
                }
        });
        await Promise.allSettled(list.map((item) => saveCollectorMarketSnapshot({
            taskId: this.task._id,
            runId: this.runId,
            sourceIdentity: this.sellerContext?.sourceIdentity,
            sourceSku: String(item.sku || item.id || ''),
            period: this.task.period === 'weekly' ? 'weekly' : 'monthly',
            categoryId: String(item.category4Id || item.category3Id || item.category2Id || item.category1Id || ''),
            payload: item,
            metrics: {
                soldCount: item.soldCount,
                gmvSum: item.gmvSum,
                drr: item.drr,
                salesDynamics: item.salesDynamics,
            },
        })));
        await Promise.allSettled(list.map((item) => {
            const rootCategoryId = String(item.category1Id || item.category2Id || item.category3Id || item.category4Id || '');
            const leafCategoryId = String(item.category4Id || item.category3Id || item.category2Id || item.category1Id || '');
            if (!rootCategoryId || !leafCategoryId)
                return null;
            return saveCollectorCategoryMapping({
                sourceIdentity: this.sellerContext?.sourceIdentity,
                rootCategoryId,
                rootCategoryName: item.category1 || item.category2 || item.category3 || item.category4 || rootCategoryId,
                leafCategoryId,
                leafCategoryName: item.category4 || item.category3 || item.category2 || item.category1 || leafCategoryId,
                payload: {
                    category1Id: item.category1Id,
                    category2Id: item.category2Id,
                    category3Id: item.category3Id,
                    category4Id: item.category4Id,
                },
            });
        }));
        return list;
    }
    /**
     * 获取详情页数据
     */
    async getHtmlDetailData(obj) {
        const res = await this.mainWindowService.getDataByApi(obj._id);
        const domain = await this.mainWindowService.getDomain();
        this.outputLog(`获取商品详情页数据`);
        return this.parseService.ozonDetailParse(res, domain, obj);
    }
    /**
     * 拓店模式
      */
    async expendShop() {
        if (!this.task.expendType || this.targetData >= (this.task.targetCount || Infinity))
            return;
        const expendShopHandle = async (goodsList) => {
            for (const item of goodsList) {
                let targetShopCount = Math.ceil(this.task.expendShopCount / 20);
                if (this.targetData >= (this.task.targetCount || Infinity) || this.expendShopCount >= this.task.expendShopCount || (this.reason === 'cancel' || this.reason === 'failed'))
                    return true;
                const data = item?.sellers?.sellers?.filter((item) => {
                    item.ratingCount = item?.rating?.totalScore;
                    item.priceNumber = item?.price?.cardPrice?.price?.replace(/[^\d.]/g, '');
                    return item.ratingCount > 4;
                }).toSorted((a, b) => b.ratingCount - a.ratingCount).toSorted((a, b) => b.priceNumber - a.priceNumber).slice(0, targetShopCount) || [];
                for (const sellers of data) {
                    this.reason = undefined;
                    if (this.targetData >= (this.task.targetCount || Infinity) || this.expendShopCount >= this.task.expendShopCount || (this.reason === 'cancel' || this.reason === 'failed'))
                        return true;
                    this.expendShopCount++;
                    this.outputLog('拓店模式开启中，请稍等！');
                    await this.mainWindowService.changeUrl(sellers.link, true);
                    await this.getHtmlData(this.task.targetCount || Infinity);
                }
            }
        };
        // 先用当前店铺中出售商品的跟卖店家
        const goodsList = Array.from(this.goodsData.values());
        const res = await expendShopHandle(goodsList);
        if (res)
            return;
        // 如果当前店铺跟卖店家还不满足终止条件那就用猜你喜欢的跟卖店铺
        const guessLikeList = Array.from(this.parseService.guessLikeList.values());
        const sellersList = [];
        for (const url of guessLikeList) {
            const response = await this.mainWindowService.getSellingData(url);
            const sellers = {
                sellers: []
            };
            if (response?.success) {
                sellers.sellers = JSON.parse(response.data.widgetStates?.['webSellerList-4723017-default-1'] || '{}');
                sellersList.push(sellers);
            }
            else {
                log.error('获取跟卖数据失败');
            }
        }
        await expendShopHandle(sellersList);
    }
    /**
     * 获取页面数据
     */
    assertProductsCollected() {
        if (this.parseService.getDataCount())
            return;
        const error = new Error('Ozon 商品列表为空，未把本次任务误记为成功');
        error.code = 'OZON_PRODUCT_LIST_EMPTY';
        throw error;
    }

    async getHtmlData(targetCount) {
        try {
            let scrollAttempts = 0;
            const maxScrollAttempts = 10;
            let bottomOutCount = 0;
            const firstPage = await this.mainWindowService.getHTML();
            if (firstPage.diagnostics?.blocked) {
                const error = new Error('Ozon 返回访问拦截页，请关闭 VPN、切换网络或稍后重试');
                error.code = 'OZON_ACCESS_BLOCKED';
                throw error;
            }
            const { html, domain } = firstPage;
            const goodsList = await this.parseService.ozonListParser(html, domain);
            if (goodsList.length)
                await this.processData(goodsList);
            while (this.targetData < targetCount) {
                if (this.reason && this.reason !== 'success')
                    throw new Error('任务终止');
                if (this.taskQueueService.getTaskCount() > 20) {
                    this.outputLog('任务队列数据源充足，等待处理中');
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }
                if (scrollAttempts >= maxScrollAttempts) {
                    this.assertProductsCollected();
                    if (!this.reason)
                        this.reason = 'success';
                    this.outputLog('尝试获取商品达到最大次数');
                    log.info(`${this.task.taskName}-10次无法获取到商品数据，结束任务`);
                    return;
                }
                if (bottomOutCount >= 3) {
                    this.assertProductsCollected();
                    if (!this.reason)
                        this.reason = 'success';
                    this.outputLog('已滚动至页面底部');
                    log.info(`${this.task.taskName}-滚动至底部3次，结束任务`);
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 2000));
                this.outputLog(`滚动页面加载数据中，(${scrollAttempts}/${maxScrollAttempts})，已收集${this.parseService.getDataCount()}`);
                const result = await this.mainWindowService.scrollPage();
                scrollAttempts++;
                if (!result) {
                    bottomOutCount++;
                    await new Promise((resolve) => setTimeout(resolve, 5000));
                    continue;
                }
                const page = await this.mainWindowService.getHTML();
                if (page.diagnostics?.blocked) {
                    const error = new Error('Ozon 在采集过程中返回访问拦截页，请关闭 VPN、切换网络或稍后重试');
                    error.code = 'OZON_ACCESS_BLOCKED';
                    throw error;
                }
                const { html, domain } = page;
                if (!html)
                    continue;
                const goodsList = await this.parseService.ozonListParser(html, domain);
                if (goodsList.length) {
                    scrollAttempts = 0;
                    bottomOutCount = 0;
                    await this.processData(goodsList);
                }
            }
            this.assertProductsCollected();
            if (!this.reason)
                this.reason = 'success';
            this.outputLog(`收集完成，共收集到 ${this.parseService.getDataCount()} 个链接`);
        }
        catch (error) {
            log.error('采集窗口发生错误', error);
            if (this.reason !== 'cancel')
                this.reason = 'failed';
            throw error;
        }
    }
    /**
     * 处理获取到的数据
     */
    async processData(goodsList) {
        try {
            let baseDataList = await this.dataProcessService.getBaseData(goodsList);
            this.outputLog(`获取商品数据中`);
            if (this.reason === undefined)
                this.process += baseDataList.length;
            const filterDataList = !this.task.aiSelectType
                ? await this.dataProcessService.aiFilterData(baseDataList)
                : await this.dataProcessService.filterData(baseDataList, this.task);
            this.outputLog(`筛选商品条件中`);
            const data = baseDataList.filter((item) => !filterDataList.map((item) => item.id).includes(item.id));
            for (const item of data) {
                if (this.reason === undefined && this.targetData < (this.task.targetCount || Infinity)) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    this.process--;
                    this.outputLog(`完成商品${item.nameLabel}的处理`);
                }
                else {
                    this.process = 0;
                    break;
                }
            }
            if (filterDataList.length &&
                this.reason !== 'cancel' &&
                this.reason !== 'failed' &&
                this.targetData < (this.task.targetCount || Infinity)) {
                this.taskQueueService.addTask(filterDataList);
                this.taskQueueService.startProcessing();
                this.outputLog('处理符合筛选条件的商品中');
            }
        }
        catch (error) {
            log.error('商品基础数据处理失败', error);
            throw error;
        }
    }
    /**
     * 更改任务状态
     */
    async updateStatus(status) {
        let uuid = this.uuid;
        if (this.task.taskStatus === status || uuid !== this.uuid)
            return;
        try {
            this.task.taskStatus = status;
            log.info(`${this.task.taskName}任务状态已更新：${status}`);
            await this.syncStatusToServer(status);
        }
        catch (error) {
            log.error('更新任务状态失败', error);
        }
    }
    // 同步状态到服务器
    async syncStatusToServer(status) {
        if (!this.runId)
            return;
        await appendCollectorRunEvent(this.runId, {
            eventType: 'STATUS_CHANGED',
            message: `任务状态：${status}`,
            payload: { status },
            actorType: 'DESKTOP',
        }).catch((error) => log.error('同步任务状态到 sonli 失败', error));
    }
    /**
     * 日志输出
     */
    outputLog(taskLog) {
        let uuid = this.uuid;
        if (this.uuid !== uuid)
            return;
        this.task.progress = {
            current: this.process < 0 ? 0 : this.process,
            total: this.isCleared ? this.goodsNum : this.parseService.getDataCount(),
            totalCount: this.targetData,
        };
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('task-progress', {
                collectionTask: this.task,
                log: { date: `[${dayjs(Date.now()).format('YYYY/MM/DD HH:mm:ss')}]`, taskLog },
            });
        }
        if (this.runId) {
            appendCollectorRunEvent(this.runId, {
                eventType: 'DESKTOP_LOG',
                level: 'INFO',
                message: String(taskLog || '').slice(0, 2000),
                payload: { progress: this.task.progress },
            }).catch((error) => log.warn('同步任务日志到 sonli 失败', error?.message || error));
        }
    }
    /**
     * 处理单个任务
     */
    taskHandle = async (task) => {
        log.info(`${this.task.taskName}-开始处理商品:${task.id}`);
        let timer;
        let maxTimer = 120;
        let countDown = 0;
        let settled = false;
        let uuid = this.uuid;
        const safeReject = (v, reject) => {
            if (settled)
                return;
            settled = true;
            clearInterval(timer);
            reject(v);
        };
        return new Promise(async (resolve, reject) => {
            try {
                timer = setInterval(() => {
                    countDown++;
                    if (this.reason === 'cancel' || this.reason === 'failed' || countDown >= maxTimer) {
                        if (this.uuid === uuid)
                            this.process--;
                        safeReject(new Error('任务超时'), reject);
                    }
                }, 1000);
                const safeResolve = (v) => {
                    if (settled)
                        return;
                    settled = true;
                    resolve(v);
                    if (this.reason != 'cancel' && this.reason !== 'failed' && this.uuid === uuid) {
                        clearInterval(timer);
                    }
                };
                if (this.targetData >= (this.task.targetCount || Infinity) && this.uuid === uuid) {
                    safeResolve('任务已完成');
                    return;
                }
                const { link1688, sourcePrice, cover2 } = await this.windowService.createWindow(this.task.sourceType, task.cover);
                if (this.reason === 'cancel' || this.reason === 'failed' || this.uuid !== uuid) {
                    safeResolve(new Error('任务已被终止'));
                    return;
                }
                task = {
                    ...task,
                    '1688link': link1688,
                    sourcePrice,
                    cover2,
                    myProfitPercent: this.task.myProfitPercent,
                    rubExpressPrice: this.task.rubExpressPrice,
                    internalExpress: this.task.internalExpress,
                };
                let detailData = await this.dataProcessService.getDetailData({
                    taskId: this.task._id,
                    reqDatas: [task],
                    upMode: this.task.upMode
                });
                this.writeQueue.push(detailData);
                this.writeTable();
                safeResolve('单个商品处理完成');
            }
            catch (error) {
                log.error(error, '单个商品任务失败');
                safeReject(new Error('单个商品任务失败'), reject);
            }
        });
    };
    /**
     * 写入表格
     */
    async writeTable() {
        const uuid = this.uuid;
        if (this.isWrite)
            return;
        this.isWrite = true;
        while (this.writeQueue.length) {
            if (this.targetData < (this.task.targetCount || Infinity) &&
                (this.reason === 'success' || this.reason === undefined) &&
                this.uuid === uuid) {
                const data = this.writeQueue.shift();
                const result = await this.excelService.saveExcel(data);
                if (data.length) {
                    this.targetData++;
                    this.goodsData.set(data[0]?.id, data?.[0]);
                    await this.persistRunItem(data[0]);
                }
                this.process--;
                if (!result)
                    this.writeError = true;
                if (!this.task.tableFilePath)
                    this.task.tableFilePath = await this.excelService.getFilePath();
                this.outputLog('单个商品处理完成');
            }
            else {
                break;
            }
        }
        this.isWrite = false;
    }
    /**
     * 窗口被关闭回调
     */
    closeHandle = async () => {
        let uuid = this.uuid;
        if (!this.reason && this.uuid === uuid) {
            await this.reWriteTable();
            this.reason = 'failed';
            // await this.clearStatus()
            this.process = 0;
            this.updateStatus('failed');
            this.outputLog('窗口异常关闭');
            log.error('窗口异常关闭');
        }
    };
    /**
     * 等待任务结束
     */
    async waitForAllTasks() {
        while (this.taskQueueService.getTaskCount() > 0 || this.taskQueueService.getActiveCount() || this.isWrite) {
            if (this.reason === 'cancel' ||
                this.reason === 'failed' ||
                this.targetData >= (this.task.targetCount || Infinity))
                return;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
    /**
     * 重置任务
     */
    async resetTask({ preserveRun = false } = {}) {
        const preservedRunId = this.runId;
        const preservedRun = this.preparedRun;
        const preservedUuid = this.uuid;
        this.stopHeartbeat();
        if (!preserveRun) {
            this.runId = '';
            this.preparedRun = null;
            this.preparedClean = false;
        }
        this.leaseToken = '';
        this.heartbeatFailures = 0;
        this.process = 0;
        await this.excelService.DeleteFilled();
        this.task.tableFilePath = undefined;
        this.isCleared = false;
        this.reason = undefined;
        await this.dataProcessService.destroy();
        await this.taskQueueService.destroy();
        this.cancellationController = new AbortController();
        this.cancellationPromise = null;
        this.dataProcessService.setCancellationSignal(this.cancellationController.signal);
        this.uuid = preserveRun ? (preservedUuid || randomUUID()) : undefined;
        if (preserveRun) {
            this.runId = preservedRunId;
            this.preparedRun = preservedRun;
        }
        this.outputLog('任务初始化完成');
    }
    /**
     * 获取任务信息
     */
    getTaskInfo() {
        return this.task;
    }
    getRunId() {
        return this.runId;
    }
    /**
     * 获取表格路径
     */
    async getTableFilePath() {
        return this.excelService.getFilePath();
    }
    /**
     * 更新任务
     */
    async updateTaskData(task) {
        // 只更新允许更新的字段，保留原始的 id、createTime 等
        Object.assign(this.task, {
            ...task,
            _id: this.task._id, // 确保 id 不被覆盖
            taskStatus: this.task.taskStatus, // 保持当前状态
            progress: this.task.progress,
        });
    }
    /**
     * 取消任务
     */
    async cancel() {
        if (this.cancellationPromise)
            return this.cancellationPromise;
        this.reason = 'cancel';
        this.cancellationPromise = (async () => {
            await this.reWriteTable();
            this.process = 0;
            this.mainWindowService.destroy();
            await this.updateStatus('cancelled');
            if (this.runId && this.leaseToken) {
                await cancelCollectorRun(this.runId, this.leaseToken, {
                    reason: 'USER_CANCELLED',
                    message: '用户取消采集任务',
                }).catch((error) => log.error('同步取消状态失败', error));
                this.runId = '';
                this.leaseToken = '';
            }
            else if (this.runId) {
                await requestCollectorRunCancellation(this.runId);
                this.runId = '';
            }
            this.preparedRun = null;
            this.preparedClean = false;
            this.outputLog('任务已取消');
        })();
        this.cancellationController.abort();
        return this.cancellationPromise;
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.runId || !this.leaseToken)
                return;
            heartbeatCollectorRun(this.runId, this.leaseToken, this.task.progress || {})
                .then((payload) => {
                    this.heartbeatFailures = 0;
                    if (payload?.cancelRequested)
                        this.cancel().catch((error) => log.error('响应服务端取消失败', error));
                })
                .catch((error) => {
                    this.heartbeatFailures += 1;
                    log.warn('采集运行心跳失败', error?.message || error);
                    if (this.heartbeatFailures >= 3 && !this.reason) {
                        this.reason = 'failed';
                        this.outputLog('连续三次无法同步任务心跳，已停止采集以避免产生未归属结果');
                        this.mainWindowService.destroy();
                    }
                });
        }, 45000);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    async persistRunItem(item) {
        if (!this.runId || !item)
            return;
        const payload = {
            source: 'OZON',
            sourceKey: String(item.id || item.sku || ''),
            sourceSku: String(item.sku || item.id || ''),
            status: item.pricingError ? 'FAILED' : 'QUALIFIED',
            rawPayload: item,
            analytics: {
                soldCount: item.soldCount,
                gmvSum: item.gmvSum,
                drr: item.drr,
                salesDynamics: item.salesDynamics,
            },
            sourcing: {
                url: item['1688link'] || '',
                price: item.sourcePrice,
                image: item.cover2 || '',
            },
            pricing: item.pricing || item.pricingResult || {},
            filterResult: { accepted: true },
            exportData: item,
            sortOrder: this.targetData,
        };
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                await appendCollectorRunItem(this.runId, this.leaseToken, payload);
                return;
            }
            catch (error) {
                lastError = error;
                log.warn(`保存采集结果失败（${attempt}/3）`, error?.message || error);
                if (attempt < 3)
                    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
            }
        }
        this.reason = 'failed';
        throw lastError || new Error(`保存采集结果 ${item.id || item.sku} 失败`);
    }
    /**
     * 重新写入表格
     */
    async reWriteTable() {
        if (this.writeError)
            await this.excelService.flushToDisk();
        this.writeError = false;
    }
    /**
     * 清理工作
     */
    clearStatus(isRetainCompletedTasks = false, isDestroy = true) {
        let uuid = this.uuid;
        if (this.isCleared || this.uuid !== uuid)
            return;
        this.isCleared = true;
        this.process = 0;
        this.goodsNum = this.parseService.getDataCount();
        this.windowService.destroy();
        this.excelService.destroy();
        this.dataProcessService.destroy();
        this.parseService.destroy();
        this.goodsData.clear();
        this.taskQueueService.destroy(isRetainCompletedTasks, isDestroy);
        this.outputLog('清理完成');
    }
    /**
     * 初始化查询参数
      */
    async initQueryParams(task) {
        this.query.weightRangeMin = task.weightRangeMin;
        this.query.weightRangeMax = task.weightRangeMax;
        this.query.packageLengthMin = task.packageLengthMin;
        this.query.packageLengthMax = task.packageLengthMax;
        this.query.packageWidthMin = task.packageWidthMin;
        this.query.packageWidthMax = task.packageWidthMax;
        this.query.packageHeightMin = task.packageHeightMin;
        this.query.packageHeightMax = task.packageHeightMax;
        this.query.nullableRedemptionRateMin = task.nullableRedemptionRateMin;
        this.query.nullableRedemptionRateMax = task.nullableRedemptionRateMax;
        this.query.returnCancelRateMin = task.returnCancelRateMin;
        this.query.returnCancelRateMax = task.returnCancelRateMax;
        this.query.brandType = task.brandType;
        this.query.gmvSumMin = task.gmvSumMin;
        this.query.gmvSumMax = task.gmvSumMax;
        this.query.searchAndCartConversionMin = task.showRateMin;
        this.query.searchAndCartConversionMax = task.showRateMax;
        this.query.soldCountMin = task.soldCountMin;
        this.query.soldCountMax = task.soldCountMax;
        this.query.shelfDateMin = task.upGoodsTimeMin;
        this.query.shelfDateMax = task.upGoodsTimeMax;
        this.query.salesDynamicsMin = task.monthDynamicsMin;
        this.query.salesDynamicsMax = task.monthDynamicsMax;
        this.query.drrMin = task.adFeeMin;
        this.query.drrMax = task.adFeeMax;
        this.query.daysInPromoMin = task.promotionDayMin;
        this.query.daysInPromoMax = task.promotionDayMax;
        this.query.discountMin = task.promotionDiscountMin;
        this.query.discountMax = task.promotionDiscountMax;
        this.query.promoRevenueShareMin = task.promotionDynamicsMin;
        this.query.promoRevenueShareMax = task.promotionDynamicsMax;
        this.query.daysWithTrafaretsMin = task.promoteDayMin;
        this.query.daysWithTrafaretsMax = task.promoteDayMax;
        this.query.qtyViewPdpMin = task.viewsMin;
        this.query.qtyViewPdpMax = task.viewsMax;
        this.query.pdpToCartConversionMin = task.cardRateMin;
        this.query.pdpToCartConversionMax = task.cardRateMax;
        this.query.salesSchema = task.salesSchema;
    }
}

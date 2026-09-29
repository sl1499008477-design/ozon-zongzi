import { MainWindowService } from './main-window.services.js';
import { resolveCollectorCategoryIds } from './interface.services.js';
import { ExcelService } from './excel.services.js';
import { TaskQueueService } from './task-queue.services.js';
import { DataProcessService } from './data-filter.services.js';
import { ParseService, parseOzonMoney } from './parse.services.js';
import log from '../../log/index.js';
import dayjs from 'dayjs';
import { randomUUID } from 'crypto';
import {listCollectorMedia,prepareCollectorMedia,prepareCollectorMediaFile} from './media-preparer.services.js';
import {getSonliApiBase} from '../sonli-api.services.js';
import { memoryMonitor } from '../memory-monitor.services.js';
import {
    appendCollectorRunEvent,
    appendCollectorRunEvents,
    getCollectorCapabilities,
    issueCollectorMediaUpload,
    confirmCollectorMediaUpload,
    appendCollectorRunItem,
    cancelCollectorRun,
    claimCollectorRun,
    claimCollectorRunSkus,
    completeCollectorRun,
    createCollectorRun,
    failCollectorRun,
    heartbeatCollectorRun,
    listCollectorRunItems,
    listCollectorOutcomeItems,
    listCollectorRunDuplicateEvents,
    requestCollectorRunCancellation,
    releaseCollectorRunSkus,
    saveCollectorCategoryMapping,
    saveCollectorMarketSnapshot,
} from '../collector-backend.services.js';
import { fetchSellerLeaderboard, verifyCurrentSellerStore, acquireSellerRoute, rememberSellerRunRoute, getSellerRunRoute } from '../seller-ozon.services.js';
import { assertSellerRunContext } from '../seller-analytics.core.js';
import { claimCollectorProductGroup, saveCollectorGroupVariant, releaseCollectorProductGroup } from '../collector-product-groups.services.js';
export class Collection {
    uuid = undefined;
    task; // 任务信息
    mainWindow = null; // 主窗口
    mainWindowService; // ozon窗口
    taskQueueService; // 商品处理队列
    excelService;
    dataProcessService;
    parseService;
    targetData = 0; // 完成的任务
    collectedSkuCount = 0; // 已成功保存的商品变体数
    reason = undefined;
    detailFailure = null;
    detailFailureStreak = 0;
    outcomes = { skipped: 0, failed: 0 };
    outcomeSkus = new Set();
    keepDiagnosticWindow = false;
    isCleared = false;
    goodsData = new Map();
    mediaRetryItems = new Map();
    preparedMediaItems = new WeakMap();
    pendingProductSaves = 0;
    productSavePromises = new Set();
    activeGroupIds = new Set();
    duplicateSkus = new Map();
    dedup = { collected: 0, listed: 0, collecting: 0 };
    process = 0; // 正在处理的任务
    goodsNum = 0; // 获取商品的数量
    previousScanCount = 0;
    writeError = false; // 写入错误
    isWrite = false; // 是否写入
    writePromise = null;
    writeQueue = [];
    capabilities = {};
    completedHandoff = null;
    runEvents = [];
    eventFlushPromise = null;
    eventFlushTimer = null;
    expendShopCount = 0;
    total = 0;
    runId = '';
    leaseToken = '';
    preparedRun = null;
    preparedClean = false;
    heartbeatFailures = 0;
    heartbeatTimer = null;
    sellerContext = null;
    sellerRouteLease = null;
    resumeRun = false;
    retryingRunSkus = new Set();
    categoriesResolved = false;
    categoryExhausted = false;
    cancellationController = new AbortController();
    cancellationPromise = null;
    runVideoWork = work => work();
    runMediaWork = work => work();
    prepareMediaFile = prepareCollectorMediaFile;
    query = {
        pageNo: 1,
        pageSize: 30,
        total: 0,
        maxPage: 99,
        categories: [],
        lastSortValues: [],
    };
    constructor(task, mainWindow, { runVideoWork = work => work(), runMediaWork = work => work(), prepareMediaFile = prepareCollectorMediaFile } = {}) {
        this.task = task;
        this.mainWindow = mainWindow;
        this.runVideoWork = runVideoWork;
        this.runMediaWork = runMediaWork;
        this.prepareMediaFile = prepareMediaFile;
        this.mainWindowService = new MainWindowService(this.closeHandle);
        this.mainWindowService.cancellationSignal = this.cancellationController.signal;
        const itemConcurrency = Math.min(20, Math.max(2, Number(task.concurrency || task.maxConcurrent || 4)));
        this.taskQueueService = new TaskQueueService(this.taskHandle, itemConcurrency);
        this.excelService = new ExcelService(this.task._id, task.taskName);
        this.dataProcessService = new DataProcessService(task);
        this.dataProcessService.setCancellationSignal(this.cancellationController.signal);
        this.dataProcessService.onSellerStatus = this.sellerStatus;
        this.parseService = new ParseService(this.mainWindowService);
        const selectedCategories = [...new Set(task.categoryIds?.flat(2) || [])];
        this.query.categories = selectedCategories.includes('*') || selectedCategories.includes('__all__')
            ? []
            : selectedCategories;
        this.initQueryParams(task);
    }

    restoreRun(run = {}, { resume = false, freeze = true } = {}) {
        const runId = String(run.id || run._id || run.runId || '');
        if (!runId)
            throw new Error('恢复任务缺少运行 ID');
        this.runId = runId;
        const frozen = run.configurationSnapshot?.configuration;
        if (freeze && frozen && typeof frozen === 'object') {
            const { _id, taskName, createTime, version, progress, tableFilePath } = this.task;
            this.task = { ...frozen, _id, taskName, createTime, version, progress, tableFilePath,
                configuration: frozen, concurrency: run.configurationSnapshot.concurrency ?? frozen.concurrency };
            this.dataProcessService.task = this.task;
            this.taskQueueService.maxConcurrency = Math.min(20, Math.max(2, Number(this.task.concurrency || 4)));
            const categories = [...new Set(this.task.categoryIds?.flat(2) || [])];
            this.query.categories = categories.includes('*') || categories.includes('__all__') ? [] : categories;
            this.initQueryParams(this.task);
        }
        this.resumeRun = resume;
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

    async prepareCategories(verification) {
        if (this.task.retryFromRunId || this.task.isUseCategorySelect !== 0 || this.categoriesResolved)
            return;
        const signal = this.cancellationController.signal;
        signal.throwIfAborted();
        const categories = await resolveCollectorCategoryIds(this.task.categoryIds || [], {
            expectedContext: verification,
            signal,
        });
        signal.throwIfAborted();
        this.query.categories = categories;
        this.categoriesResolved = true;
    }

    async prepareRun() {
        if (this.runId)
            return this.preparedRun;
        await this.resetTask();
        this.uuid = randomUUID();
        this.sellerRouteLease = await acquireSellerRoute({ signal: this.cancellationController.signal });
        try {
            const verification = await verifyCurrentSellerStore(this.sellerContext || {}, {
                signal: this.cancellationController.signal, onStatus: this.sellerStatus,
            });
            this.applyVerifiedSellerScope(verification);
            await this.prepareCategories(verification);
            const run = await createCollectorRun(this.task._id, {
                idempotencyKey: this.uuid,
            });
            this.restoreRun(run, { freeze: false });
            rememberSellerRunRoute(this.runId, this.sellerRouteLease.origin);
            this.preparedClean = true;
            this.task.taskStatus = 'pending';
            return this.preparedRun;
        } catch (error) {
            this.sellerRouteLease.release(); this.sellerRouteLease = null;
            throw error;
        }
    }

    run() {
        let settled = false;
        const safeResolve = (v, resolve) => {
            if (settled)
                return;
            settled = true;
            resolve({
                runId: this.task.currentRunId,
                ...(this.task.startError ? { startError: { ...this.task.startError } } : {}),
                ...(this.task.resumeError ? { resumeError: { ...this.task.resumeError } } : {}),
                autoSendToAiListing: this.preparedRun?.configurationSnapshot?.configuration?.autoSendToAiListing === true,
                serverManagedHandoff: this.capabilities.durableHandoff === true
                    && this.preparedRun?.configurationSnapshot?.configuration?.autoStartAiGeneration === true,
                handoff: this.completedHandoff,
                filePath: this.task.tableFilePath || '',
                ...(this.task.exportError ? { exportError: this.task.exportError } : {}),
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
                if (!this.runId)
                    throw new Error('sonli 未返回采集运行 ID');
                if (!this.sellerRouteLease) {
                    this.sellerRouteLease = await acquireSellerRoute({ origin: getSellerRunRoute(this.preparedRun),
                        signal: this.cancellationController.signal });
                    rememberSellerRunRoute(this.runId, this.sellerRouteLease.origin);
                }
                const claim = await claimCollectorRun(this.runId);
                this.capabilities = await getCollectorCapabilities();
                if (claim.run?.startedAt) {
                    this.task.lastStartedAt = claim.run.startedAt;
                    this.task.lastRunningTime = claim.run.startedAt;
                }
                this.leaseToken = claim.leaseToken;
                if (!this.leaseToken)
                    throw new Error('sonli 未返回采集运行租约');
                this.startHeartbeat();
                const verification = await verifyCurrentSellerStore(this.sellerContext || {}, {
                    signal: this.cancellationController.signal, onStatus: this.sellerStatus,
                });
                this.applyVerifiedSellerScope(verification);
                await this.prepareCategories(verification);
                await this.restoreSavedResults(claim.run || {});
                this.dataProcessService.setSellerContext({
                    ...this.sellerContext,
                    taskId: this.task._id,
                    runId: this.runId,
                });
                this.updateStatus('running');
                this.outputLog('任务开始，正在检查数据来源');
                const signal = this.cancellationController.signal;
                signal.throwIfAborted();
                let onAbort;
                const interrupted = new Promise((resolve, reject) => {
                    onAbort = () => reject(signal.reason);
                    signal.addEventListener('abort', onAbort, { once: true });
                });
                try {
                    await Promise.race([(async () => {
                        if (this.targetData >= (this.task.targetCount || Infinity)) {
                            this.reason = 'success';
                            return;
                        }
                        // Confirm Seller analysis works before creating the storefront window. Reuse this first page.
                        const firstCategoryPage = this.task.isUseCategorySelect === 0 && !this.task.retryFromRunId
                            ? await this.getCategoryGoodsList() : null;
                        signal.throwIfAborted();
                        await this.mainWindowService.createCollectionWindow(this.task.targetUrl || 'https://www.ozon.ru');
                        this.outputLog('商城窗口已就绪，开始读取商品');
                        signal.throwIfAborted();
                        if (this.resumeRun) await this.retryFailedProducts(this.runId);
                        if (this.task.retryFromRunId) {
                            await this.retryFailedProducts();
                        }
                        else if (this.task.isUseCategorySelect === 0) {
                            this.outputLog(`分类选品模式`);
                            await this.categoryMode(this.task.targetCount || Infinity, firstCategoryPage);
                        }
                        else {
                            this.outputLog('页面解析成功，开始获取商品列表');
                            await this.getHtmlData(this.task.targetCount || Infinity);
                        }
                        signal.throwIfAborted();
                        await this.waitForAllTasks();
                        signal.throwIfAborted();
                        if (!this.task.retryFromRunId) await this.expendShop();
                    })(), interrupted]);
                }
                finally {
                    signal.removeEventListener('abort', onAbort);
                }
                memoryMonitor.trackBusinessMetrics({
                    taskId: this.task._id,
                    phase: 'collected',
                    goodsDataSize: this.goodsData.size,
                    parseServiceDataSize: this.parseService.getDataCount(),
                });
                if (this.reason !== 'success') {
                    if (this.runId && this.leaseToken) {
                        await this.flushRunProgress();
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
                if (!this.targetData && this.outcomes.failed)
                    throw Object.assign(new Error(`本次没有成功采集商品，${this.outcomes.failed} 件失败；请查看采集结果后重试`), { code: 'COLLECTION_NO_VALID_PRODUCTS' });
                await this.reWriteTable();
                const targetCount = Number(this.task.targetCount) > 0 ? Number(this.task.targetCount) : null;
                const targetReached = targetCount !== null && this.targetData >= targetCount;
                const completionReason = targetReached ? 'TARGET_REACHED'
                    : this.task.retryFromRunId ? 'RETRY_FINISHED'
                    : this.task.isUseCategorySelect === 0 && this.categoryExhausted ? 'CANDIDATES_EXHAUSTED'
                    : 'SOURCE_SCAN_FINISHED';
                const completionMessage = `${targetReached ? '已达到目标'
                    : completionReason === 'CANDIDATES_EXHAUSTED' ? '候选结果已用尽'
                    : completionReason === 'RETRY_FINISHED' ? '失败商品重试已结束' : '来源扫描已结束'}${targetCount !== null && !targetReached ? '，未达到目标' : ''}；目标 ${targetCount ?? '不限'} 件，实际采集 ${this.targetData} 件`;
                this.outputLog(`${completionMessage}${this.task.exportError ? `；${this.task.exportError}` : ''}`);
                await this.flushRunProgress();
                const completed = await completeCollectorRun(this.runId, this.leaseToken, {
                    collectedCount: this.goodsData.size,
                    targetCount, targetReached, completionReason, completionMessage,
                    ...(this.outcomes.failed || this.outcomes.skipped ? { outcomes: { ...this.outcomes } } : {}),
                    exportedFilePath: this.task.tableFilePath || '',
                    ...(this.task.exportError ? { exportError: this.task.exportError } : {}),
                    dedup: { ...this.dedup },
                });
                this.completedHandoff = completed?.run?.handoff || completed?.handoff || null;
                this.runId = '';
                this.leaseToken = '';
                this.task.taskStatus = 'completed';
                this.outputLog(`${completionMessage}；已采集跳过 ${this.dedup.collected} 件，已上架跳过 ${this.dedup.listed} 件，正在采集跳过 ${this.dedup.collecting} 件；筛选/售罄/下架跳过 ${this.outcomes.skipped} 件，采集失败 ${this.outcomes.failed} 件`);
            }
            catch (error) {
                if (this.reason === 'cancel' || (this.reason !== 'failed' && error?.code === 'COLLECTION_CANCELLED')) {
                    this.reason = 'cancel';
                    this.cancellationController.abort(error);
                    await this.settleProductSaves();
                    await this.cancellationPromise?.catch((cancelError) => {
                        log.error('等待采集任务取消收尾失败', cancelError);
                    });
                    return;
                }
                this.reason = 'failed';
                this.cancellationController.abort(error);
                await this.settleProductSaves();
                this.task.lastErrorCode = String(error?.code || 'COLLECTION_FAILED');
                this.task.lastErrorMessage = String(error?.message || error).slice(0, 500);
                if (this.runId && !this.leaseToken) this.task.resumeError = { runId: this.runId, code: this.task.lastErrorCode, message: this.task.lastErrorMessage };
                if (!this.preparedRun) this.task.startError = { code: this.task.lastErrorCode, message: this.task.lastErrorMessage, previousRunId: this.task.currentRunId || '' };
                this.keepDiagnosticWindow = /^(?:ZONGZI_(?:ACCESS_BLOCKED|HTTP_ERROR|NETWORK_ERROR|REQUEST_TIMEOUT|PAGE_UNAVAILABLE|RESPONSE_INVALID)|COLLECTION_NO_VALID_PRODUCTS)$/.test(this.task.lastErrorCode);
                log.error('采集任务执行失败', error);
                await this.reWriteTable();
                this.outputLog(`采集失败：${error?.message || error}`);
                if (this.runId && this.leaseToken) {
                    await this.flushRunProgress()
                        .then(() => failCollectorRun(this.runId, this.leaseToken, error))
                        .catch((runError) => {
                            log.error('同步采集失败状态失败', runError);
                        });
                    this.runId = '';
                    this.leaseToken = '';
                }
                this.updateStatus('failed');
                this.outputLog(`采集失败：${error}`);
            }
            finally {
                await this.settleProductSaves();
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
                clearTimeout(this.eventFlushTimer);
                this.eventFlushTimer = null;
                this.mainWindowService.destroy({ keepOpen: this.keepDiagnosticWindow && this.reason !== 'cancel' });
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
    async categoryMode(targetCount, firstPage = null) {
        let dataList = firstPage || await this.getCategoryGoodsList();
        try {
            while (this.targetData < targetCount) {
                if (this.reason && this.reason !== 'success')
                    throw new Error('任务终止');
                if (!await this.waitForProductSaveCapacity()) break;
                // Fetch at most one page ahead. No new SKU claims or detail filtering until this page drains.
                const nextPage = !this.categoryExhausted && this.reason !== 'success'
                    ? this.getCategoryGoodsList().then(items => ({ items }), error => ({ error })) : null;
                const targetList = await this.parseService.ozonDetailListParser(dataList);
                this.outputLog(`获取商品成功。分类总数量${this.total ?? '未知'}`);
                await this.categoryProcess(targetList);
                if (this.targetData >= targetCount || !nextPage) break;
                this.cancellationController.signal.throwIfAborted();
                const next = await nextPage;
                if (next.error) throw next.error;
                dataList = next.items;
            }
            await this.waitForAllTasks();
            if (!this.reason)
                this.reason = 'success';
        }
        catch (error) {
            if (this.reason !== 'cancel') this.reason = 'failed';
            throw error;
        }
    }
    /**
     * 分类模式处理
      */
    async categoryProcess(list) {
        const filterData = Number(this.task.aiSelectType) === 0
            ? await this.dataProcessService.aiFilterData(list, 'base')
            : await this.dataProcessService.filterData(list, this.task, 'base');
        if (this.dataProcessService.missingFields?.size)
            this.outputLog(`筛选跳过缺少指标的商品：${[...this.dataProcessService.missingFields].join('、')}`);
        if (!filterData.length)
            return;
        const candidates = await this.selectNewCandidates(filterData);
        if (!candidates.length) return;
        // Both collection modes use the same per-SKU queue, filters and persistence.
        this.process += candidates.length;
        this.taskQueueService.addTask(candidates.map(({ storefrontPrice, ...item }) => item));
        this.outputLog('处理符合筛选条件的商品中');
        await this.taskQueueService.startProcessing();
        if (this.detailFailure) {
            await this.settleProductSaves();
            throw this.detailFailure;
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
            onStatus: this.sellerStatus,
            expectedContext: this.sellerContext,
            signal: this.cancellationController.signal,
        });
        const list = data.items || [];
        const hasTotal = data.total !== null && data.total !== undefined;
        this.categoryExhausted = list.length === 0 || (hasTotal
            && (this.query.pageNo - 1) * this.query.pageSize + list.length >= data.total);
        this.query.pageNo += 1;
        this.query.maxPage = hasTotal ? Math.max(1, Math.ceil(data.total / this.query.pageSize)) : null;
        this.total = data.total;
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
    async retryFailedProducts(runId = this.task.retryFromRunId) {
        const rows = await listCollectorOutcomeItems(runId, 'FAILED');
        const items = rows.map(row => {
            const id = String(row.sourceSku || row.sourceKey);
            if (runId === this.runId) this.retryingRunSkus.add(id);
            if (row.id) {
                this.mediaRetryItems.set(id, { runId, itemId: row.id, sourceKey: String(row.sourceKey || id),
                    mediaObjects: row.rawPayload?.mediaObjects || [], mediaIntents: row.rawPayload?.mediaIntents || [] });
            }
            this.parseService.ozonGoodsData.add(id);
            return { id, href: `https://www.ozon.ru/product/${id}/` };
        }).filter(item => !this.goodsData.has(item.id) && !this.outcomeSkus.has(item.id));
        this.outputLog(`仅重试原运行失败的 ${items.length} 件商品`);
        // Refresh Seller metrics for these exact SKUs; do not reuse stale failure snapshots or scan new categories.
        for (let offset = 0; offset < items.length; offset += 30) {
            this.cancellationController.signal.throwIfAborted();
            if (!await this.waitForProductSaveCapacity()) break;
            await this.processData(await this.selectNewCandidates(items.slice(offset, offset + 30)));
        }
        await this.waitForAllTasks();
        if (!this.reason && runId !== this.runId) this.reason = 'success';
    }

    sellerStatus = ({ message }) => {
        if (message && !this.cancellationController.signal.aborted) this.outputLog(message);
    };

    async recordDetailOutcome(item, error, attempts = 1) {
        const sku = item.collectorGroupAnchorSku || this.skuOf(item);
        if (this.outcomeSkus.has(sku)) return;
        const filtered = error?.code === 'COLLECTION_DETAIL_FILTERED';
        const skipped = (filtered || error?.code === 'ZONGZI_PRODUCT_UNAVAILABLE') && !item.collectorGroupAnchorSku;
        const message = `${item.collectorGroupAnchorSku ? `整组中的 SKU ${this.skuOf(item)} 未完成：` : ''}${String(error?.message || '商品详情读取失败')}`.slice(0, 500);
        try {
            await appendCollectorRunItem(this.runId, this.leaseToken, {
                source: 'OZON', sourceKey: sku, sourceSku: sku,
                status: skipped ? 'FILTERED_OUT' : 'FAILED',
                ...(this.retryingRunSkus.has(sku) ? { retry: true } : {}),
                errorCode: error?.code || 'ZONGZI_DETAIL_FAILED', errorMessage: message,
                attemptCount: Math.max(1, attempts),
                rawPayload: { id: sku, nameLabel: String(item.nameLabel || item.name || ''), href: `https://www.ozon.ru/product/${sku}/`,
                    ...(item.collectorGroupId ? { collectorGroupId: item.collectorGroupId, failedSku: this.skuOf(item) } : {}) },
                filterResult: { accepted: false, reason: filtered ? 'DETAIL_FILTERED' : skipped ? 'PRODUCT_UNAVAILABLE' : 'DETAIL_FAILED' },
            });
        }
        catch (saveError) {
            this.detailFailure ||= saveError;
            throw saveError;
        }
        this.outcomeSkus.add(sku);
        if (skipped && this.retryingRunSkus.delete(sku)) this.outcomes.failed = Math.max(0, this.outcomes.failed - 1);
        if (skipped || !this.retryingRunSkus.has(sku)) this.outcomes[skipped ? 'skipped' : 'failed']++;
        this.outputLog(`商品 ${sku} ${skipped ? '跳过' : '未采集'}：${message}`);
    }

    async readProductDetail(item, initialPage = null) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            this.cancellationController.signal.throwIfAborted();
            try {
                const detail = await this.getHtmlDetailData(item, attempt === 1 ? initialPage : null);
                this.detailFailureStreak = 0;
                return detail;
            }
            catch (error) {
                if (this.cancellationController.signal.aborted || /(?:ACCOUNT|CONTEXT|CANCELLED|WINDOW_CLOSED)/.test(error?.code || '')) throw error;
                const unavailable = error?.code === 'ZONGZI_PRODUCT_UNAVAILABLE';
                const accessFailure = error?.code === 'ZONGZI_ACCESS_BLOCKED' || [401, 403, 429].includes(Number(error?.status));
                const retryable = !accessFailure && /^(?:ZONGZI_(?:NETWORK_ERROR|REQUEST_TIMEOUT|DETAIL_INCOMPLETE|RESPONSE_INVALID)|TIMEOUT)$/.test(error?.code || '')
                    || !accessFailure && error?.code === 'ZONGZI_HTTP_ERROR' && Number(error.status) >= 500;
                if (retryable && attempt < 2 && !this.detailFailure) {
                    this.outputLog(`商品 ${this.skuOf(item)} 暂未读取完整，重试一次`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    this.cancellationController.signal.throwIfAborted();
                    if (!this.detailFailure) continue;
                }
                if (unavailable || item.collectorGroupAnchorSku && error?.code === 'ZONGZI_DETAIL_INCOMPLETE') this.detailFailureStreak = 0;
                else if (accessFailure || ++this.detailFailureStreak >= 3) this.detailFailure ||= error;
                await this.recordDetailOutcome(item, error, attempt);
                return null;
            }
        }
    }

    /**
     * 获取详情页数据
     */
    async getHtmlDetailData(obj, initialPage = null) {
        const res = await this.mainWindowService.getDataByApi(obj._id || obj.id || obj.sku, initialPage);
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
                    const price = parseOzonMoney(item?.price?.cardPrice?.price);
                    item.priceNumber = price ? Number(price.amount) : undefined;
                    item.priceCurrency = price?.currencyCode;
                    return item.ratingCount > 4;
                }).toSorted((a, b) => b.ratingCount - a.ratingCount).toSorted((a, b) =>
                    a.priceCurrency && a.priceCurrency === b.priceCurrency ? b.priceNumber - a.priceNumber : 0
                ).slice(0, targetShopCount) || [];
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
        error.code = 'ZONGZI_PRODUCT_LIST_EMPTY';
        throw error;
    }

    async getHtmlData(targetCount) {
        try {
            let scrollAttempts = 0;
            const maxScrollAttempts = 10;
            let bottomOutCount = 0;
            const firstPage = await this.mainWindowService.getHTML();
            if (firstPage.diagnostics?.blocked) {
                const error = new Error('Ozon 返回访问受限或验证页面，请在采集助手窗口确认页面状态后重试');
                error.code = 'ZONGZI_ACCESS_BLOCKED';
                throw error;
            }
            const { html, domain } = firstPage;
            const goodsList = await this.parseService.ozonListParser(html, domain, items => this.selectNewCandidates(items), { deferOffers: true });
            if (goodsList.length)
                await this.processData(goodsList);
            while (this.targetData < targetCount) {
                if (this.reason && this.reason !== 'success')
                    throw new Error('任务终止');
                if (!await this.waitForProductSaveCapacity()) break;
                if (this.taskQueueService.getTaskCount() > 20) {
                    this.outputLog('任务队列数据源充足，等待处理中');
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }
                if (scrollAttempts >= maxScrollAttempts) {
                    this.assertProductsCollected();
                    this.outputLog('尝试获取商品达到最大次数');
                    log.info(`${this.task.taskName}-10次无法获取到商品数据，结束任务`);
                    break;
                }
                if (bottomOutCount >= 3) {
                    this.assertProductsCollected();
                    this.outputLog('已滚动至页面底部');
                    log.info(`${this.task.taskName}-滚动至底部3次，结束任务`);
                    break;
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
                    const error = new Error('Ozon 在采集过程中返回访问受限或验证页面，请确认页面状态后重试');
                    error.code = 'ZONGZI_ACCESS_BLOCKED';
                    throw error;
                }
                const { html, domain } = page;
                if (!html)
                    continue;
                const seenBefore = this.parseService.getDataCount();
                const goodsList = await this.parseService.ozonListParser(html, domain, items => this.selectNewCandidates(items), { deferOffers: true });
                if (this.parseService.getDataCount() > seenBefore) {
                    scrollAttempts = 0;
                    bottomOutCount = 0;
                }
                if (goodsList.length) {
                    await this.processData(goodsList);
                }
            }
            await this.waitForAllTasks();
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
            const filterDataList = Number(this.task.aiSelectType) === 0
                ? await this.dataProcessService.aiFilterData(baseDataList, 'base')
                : await this.dataProcessService.filterData(baseDataList, this.task, 'base');
            if (this.dataProcessService.missingFields?.size)
                this.outputLog(`筛选跳过缺少指标的商品：${[...this.dataProcessService.missingFields].join('、')}`);
            const accepted = new Set(filterDataList.map(item => this.skuOf(item)));
            await this.releaseCandidates(goodsList.filter(item => !accepted.has(this.skuOf(item))));
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
                this.outputLog('处理符合筛选条件的商品中');
                await this.taskQueueService.startProcessing();
                if (this.detailFailure) {
                    await this.settleProductSaves();
                    throw this.detailFailure;
                }
            }
        }
        catch (error) {
            if (this.reason !== 'cancel' && error?.code !== 'COLLECTION_CANCELLED') {
                this.reason = 'failed';
                if (this.detailFailure)
                    this.outputLog(`商品处理未全部完成：${this.taskQueueService.getFailedTasksCount()} 件处理失败，已成功保存 ${this.targetData} 件`);
            }
            log.error('商品基础数据处理失败', error);
            throw error;
        }
    }
    /**
     * 更改任务状态
     */
    skuOf(item) {
        return String(item.sku || item._id || item.id || '').trim();
    }

    savedSkuCount(item) {
        const variants = item.variantData?.variants ?? item.variants;
        return Array.isArray(variants) && variants.length ? variants.length : 1;
    }
    async restoreSavedResults(run) {
        this.previousScanCount = Number(run.progress?.totalCount || 0);
        this.outcomes = { skipped: Number(run.progress?.filteredCount || 0), failed: Number(run.progress?.failedCount || 0) };
        for (const [status, count] of [['FAILED', this.outcomes.failed], ['FILTERED_OUT', this.outcomes.skipped]]) {
            if (status === 'FAILED' && this.resumeRun) continue;
            if (!count) continue;
            const rows = await listCollectorOutcomeItems(this.runId, status);
            for (const row of rows) {
                const sku = String(row.sourceSku || row.sourceKey);
                this.outcomeSkus.add(sku);
                this.parseService.ozonGoodsData.add(sku);
            }
        }
        if (Number(run.progress?.qualifiedCount || 0) > 0) {
            const saved = [];
            for (let offset = 0; ; offset += 500) {
                const page = await listCollectorRunItems(this.runId, { status: 'QUALIFIED', limit: 500, offset });
                saved.push(...page);
                if (page.length < 500) break;
            }
            for (const row of saved) {
                const item = { ...row.rawPayload, ...row.exportData };
                const sku = String(row.sourceSku || row.sourceKey);
                this.goodsData.set(item.collectorGroupId || sku, item);
                this.parseService.ozonGoodsData.add(sku);
                if (row.sourceKey && row.rawPayload?.mediaPreparation?.status === 'ready') {
                    // A save response may have been lost before the app closed.
                    // This account-scoped QUALIFIED read is its durable receipt.
                    try { await this.prepareMediaFile.acknowledge?.({ ...this.mediaCacheOwnership(item),
                        cacheOwner: { runId: this.runId, sourceKey: String(row.sourceKey) } }); }
                    catch (error) { log.warn('已保存采集结果的本机暂存清理未完成', error?.code || error?.message); }
                }
            }
            this.targetData = this.goodsData.size;
            this.collectedSkuCount = [...this.goodsData.values()].reduce((sum, item) => sum + this.savedSkuCount(item), 0);
            await this.excelService.DeleteFilled();
            if (this.targetData) {
                this.writeError = !(await this.excelService.saveExcel([...this.goodsData.values()].flatMap(item => this.exportRows(item))));
                this.task.tableFilePath = await this.excelService.getFilePath();
            }
        }
        if (Object.values(run.resultSummary?.dedup || {}).some(Number)) {
            for (let afterId = 0; ;) {
                const events = await listCollectorRunDuplicateEvents(this.runId, afterId);
                for (const event of events) for (const item of event.payload?.items || []) this.duplicateSkus.set(item.sku, item);
                if (events.length < 500) break;
                afterId = events.at(-1).id;
            }
            const keys = { COLLECTED: 'collected', LISTED: 'listed', COLLECTING: 'collecting' };
            for (const item of this.duplicateSkus.values()) this.dedup[keys[item.state]]++;
        }
        if (this.targetData) this.outputLog(`已恢复本轮成功保存的 ${this.targetData} 件商品，继续采集剩余数量`);
    }

    getScannedCount() {
        return Math.max(this.previousScanCount, this.isCleared ? this.goodsNum : this.parseService.getDataCount());
    }

    async selectNewCandidates(items) {
        if (!items.length) return [];
        const unique = new Map(items.map(item => [this.skuOf(item), item]));
        const skus = [...unique.keys()], selected = [];
        for (let offset = 0; offset < skus.length; offset += 500) {
            const batch = skus.slice(offset, offset + 500);
            const response = await claimCollectorRunSkus(this.runId, this.leaseToken, batch);
            if (!Array.isArray(response?.items) || response.items.length !== batch.length) {
                throw new Error('服务端未返回完整查重结果，请更新后端后重试');
            }
            await this.recordDuplicateSkus(response.items.filter(item => item.state !== 'CLAIMED'));
            selected.push(...response.items.filter(item => item.state === 'CLAIMED').map(item => unique.get(item.sku)));
        }
        return selected;
    }

    async recordDuplicateSkus(items) {
        if (!items.length) return;
        const keys = { COLLECTED: 'collected', LISTED: 'listed', COLLECTING: 'collecting' };
        const changed = [];
        for (const item of items) {
            const previous = this.duplicateSkus.get(item.sku);
            if (previous?.state === item.state) continue;
            if (previous) this.dedup[keys[previous.state]]--;
            this.duplicateSkus.set(item.sku, item);
            this.dedup[keys[item.state]]++;
            changed.push(item);
        }
        if (!changed.length) return;
        this.outputLog(`去重：已采集跳过 ${this.dedup.collected} 件，已上架跳过 ${this.dedup.listed} 件，正在采集跳过 ${this.dedup.collecting} 件；可在“查看跳过商品”复用原记录`);
        await this.queueRunEvent({ eventType: 'SKU_DUPLICATES', level: 'INFO',
            message: `本批跳过 ${changed.length} 个重复商品`, payload: { items: changed } }, true);
    }

    async releaseCandidates(items) {
        const skus = [...new Set(items.map(item => this.skuOf(item)))];
        for (let offset = 0; offset < skus.length; offset += 500) {
            await releaseCollectorRunSkus(this.runId, this.leaseToken, skus.slice(offset, offset + 500));
        }
    }

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
        await this.queueRunEvent({
            eventType: 'STATUS_CHANGED',
            message: `任务状态：${status}`,
            payload: { status },
            actorType: 'DESKTOP',
        }, true).catch((error) => log.error('同步任务状态到 sonli 失败', error));
    }
    /**
     * 日志输出
     */
    outputLog(taskLog, { preserveProgress = false } = {}) {
        let uuid = this.uuid;
        if (this.uuid !== uuid)
            return;
        this.task.lastLog = taskLog;
        if (!preserveProgress) this.task.progress = {
            current: this.process < 0 ? 0 : this.process,
            total: this.getScannedCount(),
            totalCount: this.targetData,
            skuCount: this.collectedSkuCount,
            mediaPreparingCount: this.pendingProductSaves,
            dedup: { ...this.dedup },
            ...(this.outcomes.failed || this.outcomes.skipped ? { outcomes: { ...this.outcomes } } : {}),
        };
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('task-progress', {
                collectionTask: this.task,
                log: { date: `[${dayjs(Date.now()).format('YYYY/MM/DD HH:mm:ss')}]`, taskLog },
            });
        }
        if (this.runId) {
            this.queueRunEvent({
                eventType: 'DESKTOP_LOG',
                level: 'INFO',
                message: String(taskLog || '').slice(0, 2000),
                payload: { progress: this.task.progress },
            }).catch((error) => log.warn('同步任务日志到 sonli 失败', error?.message || error));
        }
    }
    queueRunEvent(event, critical = false) {
        if (!this.runId) return Promise.resolve();
        this.runEvents.push({ ...event, payload: event.payload ? structuredClone(event.payload) : undefined });
        if (critical || this.runEvents.length >= 50) return this.flushRunEvents();
        if (!this.eventFlushTimer) {
            this.eventFlushTimer = setTimeout(() => {
                this.eventFlushTimer = null;
                this.flushRunEvents().catch(error => log.warn('批量采集日志同步失败', error?.message || error));
            }, 1000);
            this.eventFlushTimer.unref?.();
        }
        return Promise.resolve();
    }

    flushRunEvents() {
        clearTimeout(this.eventFlushTimer);
        this.eventFlushTimer = null;
        if (this.eventFlushPromise) return this.eventFlushPromise;
        const runId = this.runId;
        this.eventFlushPromise = (async () => {
            while (runId && this.runEvents.length) {
                const batch = this.runEvents.slice(0, this.capabilities.eventBatch === true ? 50 : 1);
                if (this.capabilities.eventBatch === true) await appendCollectorRunEvents(runId, batch);
                else await appendCollectorRunEvent(runId, batch[0]);
                this.runEvents.splice(0, batch.length);
            }
            delete this.task.logSyncError;
        })().catch(error => {
            this.task.logSyncError = String(error?.message || error);
            throw error;
        }).finally(() => { this.eventFlushPromise = null; });
        return this.eventFlushPromise;
    }
    /**
     * 处理单个任务
     */
    taskHandle = async (task) => {
        if (this.reason === 'cancel' || this.reason === 'failed' || this.isCleared
            || this.targetData >= (this.task.targetCount || Infinity))
            return;
        if (!await this.waitForProductSaveCapacity()) return;
        if (this.detailFailure) {
            await this.recordDetailOutcome(task, Object.assign(new Error('本轮访问异常已暂停，尚未读取此商品；可修复连接后重试'), { code: 'COLLECTION_DETAIL_DEFERRED' }), 0);
            this.process = Math.max(0, this.process - 1);
            return;
        }
        log.info(`${this.task.taskName}-开始处理商品:${task.id}`);
        const hasDetail = Object.hasOwn(task, 'storefrontPrice');
        let detail;
        try {
            detail = hasDetail ? task : await this.readProductDetail(task);
            if (!detail) {
                this.process = Math.max(0, this.process - 1);
                return;
            }
        }
        catch (error) {
            this.detailFailure ||= error;
            this.process = Math.max(0, this.process - 1);
            this.outputLog(`商品 ${task.id} 详情未完成，未采集：${error?.message || error}`);
            throw error;
        }
        if (this.reason === 'cancel' || this.reason === 'failed' || this.isCleared
            || this.targetData >= (this.task.targetCount || Infinity))
            return;
        if (!hasDetail) {
            const filtering = Number(this.task.aiSelectType) === 0
                ? this.dataProcessService.aiFilterData([detail], 'detail')
                : this.dataProcessService.filterData([detail], this.task, 'detail');
            // Metric evaluation is synchronous; preserve this SKU's diagnostics before another task runs.
            const missing = [...this.dataProcessService.missingFields];
            const qualified = await filtering;
            if (!qualified.length) {
                await this.recordDetailOutcome(task, Object.assign(new Error(`未通过详情筛选${missing.length ? `：缺少${missing.join('、')}` : ''}`), { code: 'COLLECTION_DETAIL_FILTERED' }));
                await this.releaseCandidates([task]);
                this.process = Math.max(0, this.process - 1);
                this.outputLog(`商品 ${task.id} 未通过详情筛选${missing.length ? `：缺少${missing.join('、')}` : ''}`);
                return;
            }
        }
        if (this.capturesProductGroups()) {
            await this.captureProductGroup(detail);
            return;
        }
        const item = this.collectedItem(detail);
        if (!await this.queueProductSave(item)) this.process = Math.max(0, this.process - 1);
    };

    capturesProductGroups() {
        const configuration = this.preparedRun ? this.preparedRun.configurationSnapshot?.configuration : this.task;
        return configuration?.captureScope === 'ALL';
    }

    collectedItem(detail) {
        // Filtering is complete. Keep public prices separate from Seller RUB statistics.
        const price = detail.storefrontPrice?.amount ?? '';
        const originalPrice = detail.storefrontPrice?.originalAmount ?? '';
        const item = {
            ...detail,
            sellerAnalyticsPriceRub: detail.sellerAnalyticsPriceRub ?? detail.price,
            analyticsCurrency: 'RUB',
            price,
            price1: price,
            currencyCode: detail.storefrontPrice?.currencyCode || '',
            oPrice: originalPrice,
            oPrice1: originalPrice,
        };
        // amount may be card-only; only explicit own-SKU labels are black/green pricing evidence.
        for (const [field, priceField] of [['blackPrice', 'ordinaryAmount'], ['greenPrice', 'bankAmount']]) {
            const value = detail.storefrontPrice?.[priceField];
            if (value === undefined || value === null || value === '') delete item[field];
            else item[field] = value;
        }
        delete item.sourceAspects;
        delete item.collectorGroupAnchorSku;
        return item;
    }

    exportRows(item) {
        return item.captureScope === 'ALL' ? item.variantData.variants : [item];
    }

    async captureProductGroup(detail) {
        const anchorSku = this.skuOf(detail), signal = this.cancellationController.signal;
        const runId = this.runId, leaseToken = this.leaseToken;
        let group, ownsGroup = false, queued = false;
        const initialPages = new Map();
        try {
            const discovered = await this.mainWindowService.getProductGroup(anchorSku, { initialAspects: detail.sourceAspects, signal, initialPages });
            signal.throwIfAborted();
            group = await claimCollectorProductGroup(runId, leaseToken, anchorSku, discovered.skus);
            if (group?.status === 'COLLECTED' || group?.status === 'COLLECTING') {
                await this.recordDuplicateSkus([{ sku: anchorSku, state: group.status, collectorGroupId: group.groupId }]);
                return;
            }
            if (!group?.groupId || !Array.isArray(group.skus) || !group.skus.includes(anchorSku))
                throw new Error('服务端未返回完整商品组，请更新后端后重试');
            if (group.status !== 'CLAIMED') throw new Error('服务端未确认商品组归属，已停止本组采集');
            if (this.activeGroupIds.has(group.groupId)) return;
            this.activeGroupIds.add(group.groupId);
            ownsGroup = true;
            const variants = new Map((group.cachedVariants || []).map(({ sourceAspects, sellers, ...row }) => [String(row.sku), row]));
            const discoveredRows = new Map(discovered.variants.map(row => [row.sku, row]));
            this.outputLog(`SKU ${anchorSku} 命中条件，采集整组 ${group.skus.length} 个 SKU（已保存 ${variants.size} 个）`);
            for (const sku of group.skus) {
                signal.throwIfAborted();
                if (variants.has(sku)) { initialPages.delete(sku); continue; }
                const source = { id: sku, sku, href: `https://www.ozon.ru/product/${sku}/`,
                    collectorGroupAnchorSku: anchorSku, collectorGroupId: group.groupId };
                if (this.detailFailure) {
                    await this.recordDetailOutcome(source, Object.assign(new Error('本轮访问异常已暂停，可稍后继续补全整组'), { code: 'COLLECTION_DETAIL_DEFERRED' }), 0);
                    continue;
                }
                const initialPage = initialPages.get(sku);
                initialPages.delete(sku);
                const ownDetail = sku === anchorSku ? detail : await this.readProductDetail(source, initialPage);
                if (!ownDetail) continue;
                signal.throwIfAborted();
                if (!ownDetail.storefrontPrice?.amount || !ownDetail.storefrontPrice.currencyCode) {
                    await this.recordDetailOutcome(source, Object.assign(new Error('未读取到本 SKU 的价格和币种'), { code: 'ZONGZI_DETAIL_INCOMPLETE' }));
                    continue;
                }
                const item = this.collectedItem(ownDetail);
                const variant = { ...item, id: sku, sku, name: item.name || item.nameLabel,
                    image: item.primaryImage || item.images?.[0], link: source.href,
                    priceCurrency: item.currencyCode,
                    ...(item.blackPrice != null ? { blackPriceCurrency: item.currencyCode } : {}),
                    ...(item.greenPrice != null ? { greenPriceCurrency: item.currencyCode } : {}),
                    aspectValues: discoveredRows.get(sku)?.aspectValues || {},
                };
                delete variant.sellers;
                await saveCollectorGroupVariant(runId, leaseToken, group.groupId, anchorSku, variant);
                variants.set(sku, variant);
            }
            if (group.skus.some(sku => !variants.has(sku))) return;
            if (this.reason === 'cancel' || this.reason === 'failed' || this.isCleared
                || this.targetData >= (this.task.targetCount || Infinity)) return;
            const item = { ...variants.get(anchorSku), sellers: detail.sellers, collectorGroupId: group.groupId, captureScope: 'ALL',
                variantData: { expectedSkus: group.skus, variants: group.skus.map(sku => variants.get(sku)) } };
            queued = await this.queueProductSave(item, async completed => {
                // Inline legacy saves can reject after this callback has finalized ownership.
                queued = true;
                this.activeGroupIds.delete(group.groupId);
                if (!completed) await releaseCollectorProductGroup(runId, leaseToken, group.groupId, anchorSku).catch(error => {
                    if (!signal.aborted) throw error;
                });
            });
        }
        catch (error) {
            if (signal.aborted || /(?:ACCOUNT|CONTEXT|CANCELLED|WINDOW_CLOSED)/.test(error?.code || '') || !String(error?.code || '').startsWith('ZONGZI_')) {
                this.detailFailure ||= error;
                throw error;
            }
            if (error.code === 'ZONGZI_ACCESS_BLOCKED' || [401, 403, 429].includes(Number(error.status)) || ++this.detailFailureStreak >= 3)
                this.detailFailure ||= error;
            await this.recordDetailOutcome({ ...detail, collectorGroupAnchorSku: anchorSku, collectorGroupId: group?.groupId }, error);
        }
        finally {
            if (!queued) this.process = Math.max(0, this.process - 1);
            if (ownsGroup && !queued) {
                this.activeGroupIds.delete(group.groupId);
                await releaseCollectorProductGroup(runId, leaseToken, group.groupId, anchorSku).catch(error => {
                    if (!signal.aborted) throw error;
                });
            }
        }
    }
    /**
     * 写入表格
     */
    async waitForProductSaveCapacity() {
        const signal = this.cancellationController.signal, target = this.task.targetCount || Infinity;
        while (this.targetData < target && (this.pendingProductSaves >= this.taskQueueService.maxConcurrency
            || this.targetData + this.pendingProductSaves >= target)) {
            signal.throwIfAborted();
            if (this.reason === 'failed' || this.isCleared) return false;
            await Promise.race(this.productSavePromises);
        }
        signal.throwIfAborted();
        return this.targetData < target && this.reason !== 'failed' && !this.isCleared;
    }

    async queueProductSave(item, onSettled) {
        // Recheck after the await: several finished details may wake for one slot.
        do {
            if (!await this.waitForProductSaveCapacity()) return false;
        } while (this.pendingProductSaves >= this.taskQueueService.maxConcurrency
            || this.targetData + this.pendingProductSaves >= (this.task.targetCount || Infinity));
        const signal = this.cancellationController.signal;
        signal.throwIfAborted();
        this.pendingProductSaves++;
        let saveError;
        const failed = error => {
            saveError ||= error;
            if (signal.aborted) return;
            this.detailFailure ||= error;
            this.reason = 'failed';
            this.cancellationController.abort(error);
        };
        const saving = Promise.resolve().then(async () => {
            let completed = false;
            try { completed = await this.saveCollectedItem(item); }
            catch (error) { failed(error); }
            finally {
                try { await onSettled?.(completed); }
                catch (error) { failed(error); }
                this.pendingProductSaves--;
                this.productSavePromises.delete(saving);
                this.process = Math.max(0, this.process - 1);
                if (!signal.aborted) this.outputLog(`商品 ${this.skuOf(item)} ${completed ? '素材与资料已保存' : '素材待重试'}，还有 ${this.pendingProductSaves} 组素材处理中`);
            }
        });
        this.productSavePromises.add(saving);
        this.outputLog(`商品 ${this.skuOf(item)} 详情已采集，开始准备素材（${this.pendingProductSaves} 组处理中）`);
        // URL-only backends retain their existing inline save behavior.
        if (this.capabilities.mediaDirectUploadV1 !== true) {
            await saving;
            if (saveError) throw saveError;
        }
        return true;
    }

    async settleProductSaves() {
        while (this.productSavePromises.size) await Promise.all([...this.productSavePromises]);
    }

    async saveCollectedItem(item) {
        const signal = this.cancellationController.signal;
        const uuid = this.uuid;
        signal.throwIfAborted();
        await this.prepareRunItemMedia(item);
        signal.throwIfAborted();
        if (this.uuid !== uuid || this.reason === 'cancel' || this.reason === 'failed' || this.isCleared) return false;
        this.writeQueue.push([item]);
        await this.writeTable();
        return this.goodsData.has(item.collectorGroupId || item.id);
    }

    async writeTable() {
        const uuid = this.uuid;
        if (this.writePromise)
            return this.writePromise;
        this.isWrite = true;
        this.writePromise = Promise.resolve().then(async () => {
        try {
            while (this.writeQueue.length) {
                if (this.targetData < (this.task.targetCount || Infinity) &&
                    (this.reason === 'success' || this.reason === undefined) &&
                    this.uuid === uuid) {
                    const data = this.writeQueue.shift();
                    let result = true;
                    if (data.length && await this.persistRunItem(data[0])) {
                        const key = data[0].collectorGroupId || data[0].id;
                        const previous = this.goodsData.get(key);
                        if (!previous) this.targetData++;
                        this.collectedSkuCount += this.savedSkuCount(data[0]) - (previous ? this.savedSkuCount(previous) : 0);
                        this.goodsData.set(key, data[0]);
                        result = await this.excelService.saveExcel(this.exportRows(data[0]));
                    }
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
        }
        finally {
            this.isWrite = false;
            this.writePromise = null;
        }
        });
        return this.writePromise;
    }
    /**
     * 窗口被关闭回调
     */
    closeHandle = () => {
        if (!this.leaseToken || this.reason === 'cancel' || this.cancellationController.signal.aborted)
            return;
        this.reason = 'failed';
        this.stopHeartbeat();
        this.process = 0;
        this.cancellationController.abort(Object.assign(new Error('Ozon 采集窗口异常关闭'), { code: 'COLLECTION_WINDOW_CLOSED' }));
        this.updateStatus('failed');
        this.outputLog('窗口异常关闭');
        log.error('窗口异常关闭');
    };
    /**
     * 等待任务结束
     */
    async waitForAllTasks() {
        while (this.taskQueueService.getTaskCount() > 0 || this.taskQueueService.getActiveCount() || this.isWrite) {
            if (this.reason === 'cancel' || this.reason === 'failed')
                break;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        await this.settleProductSaves();
        if (this.detailFailure) throw this.detailFailure;
    }
    /**
     * 重置任务
     */
    async resetTask({ preserveRun = false } = {}) {
        if (this.productSavePromises.size) this.cancellationController.abort();
        await this.settleProductSaves();
        await this.writePromise?.catch(() => {});
        await this.flushRunEvents().catch(error => log.warn('上一运行日志未全部同步', error?.message || error));
        const preservedRunId = this.runId;
        const preservedRun = this.preparedRun;
        const preservedUuid = this.uuid;
        this.stopHeartbeat();
        if (!preserveRun) {
            this.resumeRun = false;
            this.runId = '';
            this.preparedRun = null;
            this.preparedClean = false;
        }
        this.leaseToken = '';
        this.runEvents = [];
        this.writeQueue = [];
        this.preparedMediaItems = new WeakMap();
        this.capabilities = {};
        this.completedHandoff = null;
        delete this.task.exportError;
        this.categoriesResolved = false;
        this.categoryExhausted = false;
        this.query.pageNo = 1;
        this.heartbeatFailures = 0;
        this.process = 0;
        this.duplicateSkus.clear();
        this.activeGroupIds.clear();
        this.dedup = { collected: 0, listed: 0, collecting: 0 };
        this.previousScanCount = 0;
        if (!preserveRun) {
            await this.excelService.DeleteFilled();
            this.task.tableFilePath = undefined;
        }
        this.isCleared = false;
        this.reason = undefined;
        this.detailFailure = null;
        this.detailFailureStreak = 0;
        this.outcomes = { skipped: 0, failed: 0 };
        this.outcomeSkus.clear();
        this.retryingRunSkus.clear();
        this.keepDiagnosticWindow = false;
        this.task.lastErrorCode = '';
        this.task.lastErrorMessage = '';
        delete this.task.startError;
        delete this.task.resumeError;
        await this.dataProcessService.destroy();
        await this.taskQueueService.destroy();
        this.cancellationController = new AbortController();
        this.mainWindowService.cancellationSignal = this.cancellationController.signal;
        this.cancellationPromise = null;
        this.dataProcessService.setCancellationSignal(this.cancellationController.signal);
        this.dataProcessService.onSellerStatus = this.sellerStatus;
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
            await this.settleProductSaves();
            await this.reWriteTable();
            this.process = 0;
            this.mainWindowService.destroy();
            await this.updateStatus('cancelled');
            this.outputLog('任务已取消，已保存的采集结果保留');
            if (this.runId && this.leaseToken) {
                await this.flushRunProgress()
                    .then(() => cancelCollectorRun(this.runId, this.leaseToken, {
                        reason: 'USER_CANCELLED',
                        message: '用户取消采集任务',
                    }))
                    .catch((error) => log.error('同步取消状态失败', error));
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

    getRunProgress() {
        // UI current is in-flight concurrency; persisted item results own processed/failed counts.
        return {
            totalCount: this.getScannedCount(),
            qualifiedCount: this.targetData,
            dedup: { ...this.dedup },
        };
    }

    async flushRunProgress() {
        this.stopHeartbeat();
        await this.flushRunEvents().catch(error => log.warn('采集日志未全部同步，最终状态仍将保存', error?.message || error));
        return heartbeatCollectorRun(this.runId, this.leaseToken, this.getRunProgress())
            .catch((error) => log.warn('同步采集最终进度失败', error?.message || error));
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.runId || !this.leaseToken)
                return;
            heartbeatCollectorRun(this.runId, this.leaseToken, this.getRunProgress())
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

    async prepareRunItemMedia(item) {
        if (!this.runId || !item)
            return false;
        if (this.preparedMediaItems.has(item))
            return this.preparedMediaItems.get(item);
        let savedMediaIntent = false;
        if (this.capabilities?.mediaDirectUploadV1 === true) {
            const persistIntent = async pending => {
                await appendCollectorRunItem(this.runId, this.leaseToken, {
                    source: 'OZON', sourceKey: String(item.collectorGroupId || item.id || item.sku || ''),
                    sourceSku: String(item.sku || item.id || ''), status: 'FAILED',
                    errorCode: 'COLLECTOR_MEDIA_WAITING', errorMessage: '详情已采集，素材准备中；中断后重试将先核实已有上传。',
                    rawPayload: pending, exportDataFromRaw: true,
                });
                savedMediaIntent = true;
            };
            if (item.mediaPreparation?.status !== 'ready' && item.mediaPreparation?.mode !== 'server' && listCollectorMedia(item).length)
                await persistIntent(structuredClone({ ...item, mediaPreparation: { mode: 'desktop', status: 'preparing' } }));
            await this.prepareMediaFile.retainItem?.(this.mediaCacheOwnership(item));
            const prepared = await prepareCollectorMedia(item, {
                capabilities: this.capabilities, runId: this.runId, leaseToken: this.leaseToken,
                runMediaWork: this.runMediaWork, concurrency: 3,
                recovery: this.mediaRetryItems.get(this.skuOf(item)),
                signal: this.cancellationController.signal, issue: issueCollectorMediaUpload, confirm: confirmCollectorMediaUpload,
                prepareFile: (source, options) => this.prepareMediaFile(source, { ...options, runVideoWork: this.runVideoWork,
                    ...this.mediaCacheOwnership(item),
                    onProgress: progress => {
                        const total = progress.totalBytes ? ` / ${(progress.totalBytes / 1024).toFixed(0)} KB` : '';
                        const phase = {downloading: '下载中', resuming: '断点续传', retrying: progress.reason === 'COLLECTOR_MEDIA_DOWNLOAD_SLOW' ? '低速重连' : '自动重试', downloaded: '下载完成',
                            cached: '复用缓存', sharing: '共用下载'}[progress.phase];
                        this.outputLog(`素材${phase}：${source.sourceSku}，${(progress.bytes / 1024).toFixed(0)} KB${total}，第 ${progress.attempt} 次尝试`);
                    },
                }),
                persistIntent,
                onStatus: message => this.outputLog(message),
            });
            Object.assign(item, prepared);
        }
        this.preparedMediaItems.set(item, savedMediaIntent);
        return savedMediaIntent;
    }

    mediaCacheOwnership(item) {
        const accountId = this.preparedRun?.accountId || this.sellerContext?.accountId;
        const recovery = this.mediaRetryItems.get(this.skuOf(item));
        return {
            cacheScope: accountId ? JSON.stringify([getSonliApiBase(),accountId]) : '',
            cacheOwner: { runId: this.runId, sourceKey: String(item.collectorGroupId || item.id || item.sku || '') },
            ...(recovery?.itemId && recovery.sourceKey ? { previousOwner: { runId: recovery.runId, sourceKey: recovery.sourceKey } } : {}),
        };
    }

    async persistRunItem(item) {
        if (!this.runId || !item)
            return false;
        const signal = this.cancellationController.signal;
        signal.throwIfAborted();
        const savedMediaIntent = await this.prepareRunItemMedia(item);
        signal.throwIfAborted();
        const mediaWaiting = ['waiting', 'preparing'].includes(item.mediaPreparation?.status);
        const payload = {
            source: 'OZON',
            sourceKey: String(item.collectorGroupId || item.id || item.sku || ''),
            sourceSku: String(item.sku || item.id || ''),
            status: mediaWaiting ? 'FAILED' : 'QUALIFIED',
            ...((savedMediaIntent || this.retryingRunSkus.has(this.skuOf(item))) && !mediaWaiting ? { retry: true, errorCode: '', errorMessage: '' } : {}),
            ...(mediaWaiting ? { errorCode: 'COLLECTOR_MEDIA_WAITING', errorMessage: '素材未准备完成；原始资料和已成功上传的素材已保留，本轮继续处理其他商品。' } : {}),
            rawPayload: item,
            analytics: {
                sellerAnalyticsPriceRub: item.sellerAnalyticsPriceRub,
                currencyCode: item.analyticsCurrency,
                soldCount: item.soldCount,
                gmvSum: item.gmvSum,
                drr: item.drr,
                salesDynamics: item.salesDynamics,
            },
            filterResult: { accepted: true },
            ...(this.capabilities.exportDataFromRaw === true ? { exportDataFromRaw: true } : { exportData: item }),
            sortOrder: this.targetData + 1,
        };
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            signal.throwIfAborted();
            try {
                const response = await appendCollectorRunItem(this.runId, this.leaseToken, payload);
                const result = response?.results?.[0] || response;
                if (result?.duplicate) {
                    await this.recordDuplicateSkus([result.existing]);
                    return false;
                }
                if (mediaWaiting) {
                    if (!this.retryingRunSkus.has(this.skuOf(item))) this.outcomes.failed++;
                    this.outcomeSkus.add(String(item.sku || item.id));
                    return false;
                }
                const previous = this.mediaRetryItems.get(this.skuOf(item));
                if (this.retryingRunSkus.has(this.skuOf(item)) && previous?.runId === this.runId
                    && previous.sourceKey !== payload.sourceKey) {
                    await appendCollectorRunItem(this.runId, this.leaseToken, {
                        source: 'OZON', sourceKey: previous.sourceKey, sourceSku: this.skuOf(item),
                        status: 'FILTERED_OUT', retry: true, errorCode: 'COLLECTOR_GROUP_RECOVERED',
                        errorMessage: '整组已恢复，合格结果见该商品组', filterResult: { accepted: false, reason: 'GROUP_RECOVERED' },
                    });
                    this.outcomes.skipped++;
                }
                if (this.retryingRunSkus.delete(this.skuOf(item))) this.outcomes.failed = Math.max(0, this.outcomes.failed - 1);
                if (item.mediaPreparation?.status === 'ready') {
                    try { await this.prepareMediaFile.acknowledge?.(this.mediaCacheOwnership(item)); }
                    catch (error) { log.warn('采集结果已保存，本机素材暂存清理未完成', error?.code || error?.message); }
                }
                return true;
            }
            catch (error) {
                signal.throwIfAborted();
                if ([401, 403].includes(error?.status || error?.response?.status)
                    || /^COLLECTOR_RUN_/.test(error?.code || '')
                    || /(?:ACCOUNT|CONTEXT|CANCELLED|WINDOW_CLOSED)/.test(error?.code || '')) throw error;
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
        await this.writePromise?.catch(error => log.error('等待商品保存收尾失败', error));
        if (!this.goodsData.size) return;
        let saved = false;
        try { saved = await this.excelService.flushToDisk(); }
        catch (error) { log.error('Excel 最终保存失败', error); }
        this.writeError = !saved;
        if (saved) delete this.task.exportError;
        else {
            this.task.exportError = 'Excel 保存失败；采集结果已保存到服务器，可恢复导出';
            this.outputLog(this.task.exportError);
        }
    }
    /**
     * 清理工作
     */
    clearStatus(isRetainCompletedTasks = false, isDestroy = true) {
        if (this.productSavePromises.size) {
            this.cancellationController.abort();
            return this.settleProductSaves().then(() => this.clearStatus(isRetainCompletedTasks, isDestroy));
        }
        let uuid = this.uuid;
        if (this.isCleared || this.uuid !== uuid)
            return;
        this.isCleared = true;
        this.sellerRouteLease?.release();
        this.sellerRouteLease = null;
        this.process = 0;
        this.goodsNum = this.parseService.getDataCount();
        this.excelService.destroy();
        this.dataProcessService.destroy();
        this.parseService.destroy();
        this.goodsData.clear();
        this.taskQueueService.destroy(isRetainCompletedTasks, isDestroy);
        this.outputLog(this.task.lastLog || '任务已结束');
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

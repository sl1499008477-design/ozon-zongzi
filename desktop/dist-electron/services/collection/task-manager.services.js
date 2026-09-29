import { Collection } from './collection.services.js';
import { ExcelService } from './excel.services.js';
import { getSonliToken } from '../sonli-api.services.js';
import { closeRetainedCollectionWindow } from './main-window.services.js';
import log from '../../log/index.js';
import { SysTemUtils } from '../../utils/system.js';
import { memoryMonitor } from '../memory-monitor.services.js';
import { sendCollectorResultsToAiListing, describeCollectorHandoff } from '../collector-ai-listing.services.js';
import {
    copyCollectorTask,
    createCollectorTask,
    createCollectorFailedRetry,
    deleteCollectorTask,
    listCollectorTasks,
    listCollectorRunsForTask,
    getCollectorRun,
    getCollectorTask,
    resumeCollectorRun,
    listCollectorRunItems,
    updateCollectorTask,
} from '../collector-backend.services.js';
import os from 'os';
import {join} from 'node:path';
import {
    assertExistingManagedExcelFile,
    assertManagedExcelPath,
    assertTaskOwnsManagedExcelFile,
    buildTaskExcelPath,
    normalizeExcelDownloadRequest,
} from './excel-path.core.js';
import { createVideoWorkQueue } from './video-work-queue.services.js';
import { createCollectorMediaFilePreparer } from './media-download-cache.services.js';
import { createCollectorMediaWorkQueue } from './media-preparer.services.js';
export class TaskManager {
    static instance;
    tasks = new Map();
    activeTasks = new Set();
    maxConcurrentTasks;
    taskQueue = [];
    restoredRunIds = new Set();
    resumeRequests = new Set();
    mainWindow = null;
    filePathList = new Map();
    exportRecoverySources = new Map();
    exportRecoveries = new Map();
    videoWorkQueue;
    runVideoWork;
    prepareMediaFile;
    runMediaWork;
    constructor() {
        this.maxConcurrentTasks = (os.totalmem() / 1024 / 1024 / 1024) > 15 ? 8 : 4;
        this.videoWorkQueue = createVideoWorkQueue();
        this.runVideoWork = (work, options) => this.videoWorkQueue.run(work, options);
        this.prepareMediaFile = createCollectorMediaFilePreparer({root:join(this.getUserDataPath(),'collector-media-cache-v1')});
        const mediaWorkQueue = createCollectorMediaWorkQueue();
        this.runMediaWork = (work, options) => mediaWorkQueue.run(work, options);
    }
    createCollection(task) {
        return new Collection(task, this.mainWindow, { runVideoWork: this.runVideoWork, prepareMediaFile: this.prepareMediaFile, runMediaWork: this.runMediaWork });
    }
    getUserDataPath() {
        return SysTemUtils.getAppInfo().userDataPath;
    }
    existingExcelPath(candidate) {
        if (!candidate)
            return '';
        try {
            return assertExistingManagedExcelFile(this.getUserDataPath(), candidate);
        }
        catch {
            return '';
        }
    }
    static getInstance() {
        if (!TaskManager.instance) {
            TaskManager.instance = new TaskManager();
        }
        return TaskManager.instance;
    }
    setMainWindow(window) {
        this.mainWindow = window;
    }
    /**
     * 获取当前并发任务数
      */
    hasActiveWork() {
        return this.activeTasks.size > 0 || this.taskQueue.length > 0;
    }
    getConcurrentTaskCount() {
        return this.maxConcurrentTasks;
    }
    /**
     * 设置最大并发任务数
      */
    setMaxConcurrentTasks(max) {
        const parsed = Number(max);
        this.maxConcurrentTasks = Math.min(20, Math.max(2, Number.isFinite(parsed) ? parsed : 4));
        while (this.activeTasks.size < this.maxConcurrentTasks && this.taskQueue.length)
            this.processNextTask();
    }
    /**
     * 添加任务（仅创建任务，不立即执行）
     */
    addTask(taskData) {
        return new Promise(async (resolve, reject) => {
            let collection = null;
            if (taskData._id) {
                try {
                    const saved = await updateCollectorTask(taskData._id, taskData, taskData.version);
                    const previous = this.tasks.get(taskData._id)?.getTaskInfo() || taskData;
                    saved.createTime ??= previous.createTime;
                    // Mutation responses omit the read-only run projection.
                    if (!Object.hasOwn(saved, 'lastStartedAt'))
                        saved.lastRunningTime ??= previous.lastRunningTime;
                    collection = this.createCollection(saved);
                    this.tasks.set(collection.getTaskInfo()._id, collection);
                }
                catch (error) {
                    log.error('更新任务数据失败', error);
                    reject(error);
                    return;
                }
            }
            else {
                // 新任务，需要生成ID并补充信息
                try {
                    const saved = await createCollectorTask(taskData);
                    collection = this.createCollection(saved);
                    this.tasks.set(collection.getTaskInfo()._id, collection);
                }
                catch (error) {
                    reject(error);
                    return;
                }
            }
            if (!collection) {
                reject('创建任务时，Collection 未正确初始化');
                return;
            }
            const taskInfo = collection.getTaskInfo();
            resolve(taskInfo._id);
        });
    }
    /**
     * 复制任务
     */
    copyTask(taskData) {
        return new Promise(async (resolve, reject) => {
            try {
                const newTaskData = await copyCollectorTask(taskData._id, taskData);
                const collection = this.createCollection(newTaskData);
                const taskInfo = collection.getTaskInfo();
                this.tasks.set(taskInfo._id, collection);
                resolve(taskInfo._id);
            }
            catch (error) {
                reject(error);
                return;
            }
        });
    }
    /**
     * 开始执行任务
     */
    startTaskById(taskId) {
        if (this.exportRecoveries.has(taskId)) return Promise.reject(new Error('正在重新生成导出，请等待完成后开始采集'));
        this.refreshTaskQueue();
        return new Promise(async (resolve, reject) => {
            const task = this.tasks.get(taskId);
            if (!task) {
                reject('任务不存在');
                return;
            }
            // 检查任务是否允许重新执行
            const taskInfo = task.getTaskInfo();
            if (this.activeTasks.has(taskId)
                || this.taskQueue.includes(taskId)
                || taskInfo.taskStatus === 'running'
                || taskInfo.taskStatus === 'pending') {
                reject('任务已在运行中');
                return;
            }
            if (this.activeTasks.size < this.maxConcurrentTasks) {
                this.executeTask(taskId);
            }
            else {
                try {
                    await task.prepareRun();
                }
                catch (error) {
                    this.recordStartupFailure(task, error);
                    reject(error);
                    return;
                }
                await task.updateStatus('pending');
                task.outputLog('pending');
                if (!this.taskQueue.includes(taskId))
                    this.taskQueue.push(taskId);
            }
            resolve(true);
        });
    }
    recordStartupFailure(task, error) {
        const info = task.getTaskInfo();
        const startError = {
            code: String(error?.code || 'COLLECTION_FAILED'),
            message: String(error?.message || error).slice(0, 500),
            previousRunId: String(info.currentRunId || ''),
        };
        Object.assign(info, { taskStatus: 'failed', startError,
            lastErrorCode: startError.code, lastErrorMessage: startError.message });
        this.filePathList.set(info._id, { ...this.filePathList.get(info._id), taskId: info._id, startError });
        task.outputLog?.(`任务启动失败：${startError.message}`, { preserveProgress: true });
        this.notifyTaskUpdate(info._id, 'failed');
    }

    async retryFailedItems(payload) {
        const saved = await createCollectorFailedRetry(payload);
        const collection = this.createCollection(saved);
        this.tasks.set(saved._id, collection);
        await this.startTaskById(saved._id);
        this.mainWindow?.webContents.send('refresh-task-list');
        return collection.getTaskInfo();
    }

    resumeBlockedReason(task, run = task.currentRun) {
        if (this.activeTasks.has(task._id) || this.taskQueue.includes(task._id)) return '本机正在执行或排队，请等待当前工作结束';
        if (this.exportRecoveries.has(task._id)) return '正在重新生成导出，请等待完成';
        if (!run?.id) return '该任务没有可继续的运行记录';
        if (run.cancelRequested || run.cancelRequestedAt || run.status === 'CANCELLED') return '该运行已取消，请重新执行新一轮';
        if (run.status === 'COMPLETED') return '该运行已完成，请重新执行新一轮';
        if (!['FAILED', 'QUEUED', 'RUNNING'].includes(run.status)) return '当前运行状态不能继续采集';
        if (!run.configurationSnapshot?.configuration || typeof run.configurationSnapshot.configuration !== 'object') return '原运行缺少配置快照，无法继续采集';
        if (run.lockExpiresAt && new Date(run.lockExpiresAt).getTime() > Date.now()) return '原运行租约仍有效，请等待租约到期后重试';
        return '';
    }

    async resumeTask({ taskId, runId } = {}) {
        if (!taskId || !runId) throw new Error('继续采集需要任务和原运行 ID');
        if (this.resumeRequests.has(taskId)) throw new Error('正在恢复原运行，请稍候');
        const token = getSonliToken();
        const checkAccount = () => {
            if (getSonliToken() !== token) throw Object.assign(new Error('登录账号已变化，请刷新任务后重试'), { code: 'ACCOUNT_CHANGED' });
        };
        this.resumeRequests.add(taskId);
        try {
            const task = await getCollectorTask(taskId); checkAccount();
            if (String(task.currentRunId || task.currentRun?.id || '') !== String(runId)) throw new Error('任务当前运行已变化，请刷新后重试');
            const original = await getCollectorRun(runId); checkAccount();
            if (original.taskId !== taskId) throw new Error('原运行不属于该任务');
            const blocked = this.resumeBlockedReason(task, original);
            if (blocked) throw Object.assign(new Error(blocked), { status: 409, code: 'COLLECTOR_RUN_RESUME_BLOCKED' });
            const run = await resumeCollectorRun(runId); checkAccount();
            const afterResume = this.resumeBlockedReason(task, run);
            if (afterResume) throw Object.assign(new Error(afterResume), { status: 409, code: 'COLLECTOR_RUN_RESUME_BLOCKED' });
            const collection = this.createCollection(task);
            collection.restoreRun(run, { resume: true });
            this.tasks.set(taskId, collection);
            this.restoredRunIds.add(runId); // Automatic polling stays bounded; this explicit action can retry again.
            this.filePathList.delete(taskId);
            this.taskQueue.push(taskId);
            collection.outputLog('已继续原采集运行，将复用已保存结果并重试未完成商品', { preserveProgress: true });
            this.processNextTask();
            return { taskId, runId, taskStatus: collection.getTaskInfo().taskStatus };
        } finally { this.resumeRequests.delete(taskId); }
    }

    /**
     * 实际执行任务
     */
    async executeTask(taskId) {
        const task = this.tasks.get(taskId);
        if (!task || this.activeTasks.has(taskId))
            return;
        // 记录任务开始前的内存
        memoryMonitor.trackBusinessMetrics({
            taskCount: this.tasks.size,
            activeTaskCount: this.activeTasks.size,
            queueSize: this.taskQueue.length,
        });
        // 添加到活动任务并立即通知
        this.activeTasks.add(taskId);
        this.notifyTaskUpdate(taskId, 'running');
        try {
            const result = await task.run();
            if (task.getTaskInfo().taskStatus === 'completed') {
                let aiListingResult;
                if (result.autoSendToAiListing === true && result.runId && Number(result.progress?.totalCount) > 0) {
                    aiListingResult = result.serverManagedHandoff
                        ? describeCollectorHandoff(result.handoff)
                        : await sendCollectorResultsToAiListing({ runId: result.runId, allQualified: true });
                    task.outputLog?.(`自动发送至 AI 上架：${aiListingResult.message}`);
                }
                this.mainWindow?.webContents.send('task-completed', {
                    taskId,
                    taskName: task.getTaskInfo().taskName,
                    aiListingResult,
                    level: result.exportError || result.progress?.outcomes?.failed || aiListingResult && aiListingResult.code !== 200 ? 'warning' : 'success',
                    message: `任务：${task.getTaskInfo().taskName}已完成，成功 ${result.progress?.totalCount || 0} 件，跳过 ${result.progress?.outcomes?.skipped || 0} 件，失败 ${result.progress?.outcomes?.failed || 0} 件`
                        + (aiListingResult ? `；${aiListingResult.message}` : '')
                        + (result.exportError ? `；${result.exportError}` : '')
                        + (aiListingResult && aiListingResult.code !== 200 ? '。可使用“发送至 AI 上架”手动补发。' : '')
                        + (result.autoSendToAiListing === true && !Number(result.progress?.totalCount) ? '；没有合格商品，未自动发送。' : ''),
                });
            }
            const safeResult = JSON.parse(JSON.stringify(result));
            safeResult.filePath = this.existingExcelPath(safeResult.filePath);
            safeResult.taskId = taskId;
            this.filePathList.set(taskId, safeResult);
        }
        catch (error) {
            this.filePathList.set(taskId, JSON.parse(JSON.stringify(error)));
        }
        finally {
            // 任务完成后清理并通知
            const finalStatus = task.getTaskInfo().taskStatus;
            task.clearStatus(false, true);
            this.activeTasks.delete(taskId);
            this.notifyTaskUpdate(taskId, finalStatus);
            this.tasks.delete(taskId);
            memoryMonitor.trackBusinessMetrics({
                taskCount: this.tasks.size,
                activeTaskCount: this.activeTasks.size,
                queueSize: this.taskQueue.length,
                filePathListSize: this.filePathList.size,
            });
            // 内存压力大时，触发GC
            const usage = process.memoryUsage();
            if (usage.heapUsed > 800 * 1024 * 1024) {
                log.warn('[TaskManager] 内存压力大，触发 GC');
                memoryMonitor.forceGC();
            }
            // 处理队列中的下一个任务
            this.processNextTask();
        }
    }
    /**
     * 处理下一个待执行任务
     */
    async processNextTask() {
        if (this.taskQueue.length > 0 && this.activeTasks.size < this.maxConcurrentTasks) {
            const nextTaskId = this.taskQueue.shift();
            if (nextTaskId) {
                this.executeTask(nextTaskId);
            }
        }
    }
    /**
     * 获取任务信息
     */
    getTask(taskId) {
        const task = this.tasks.get(taskId);
        return task ? task.getTaskInfo() : null;
    }
    /**
     * 获取任务列表（包括状态）
     */
    getAllTasksList() {
        const taskList = [];
        for (const [_, collection] of this.tasks) {
            taskList.push(collection.getTaskInfo());
        }
        return taskList;
    }

    async restorePersistedRun(task, collection) {
        if (!['pending', 'running'].includes(task.taskStatus)
            || this.resumeRequests.has(task._id)
            || this.activeTasks.has(task._id)
            || this.taskQueue.includes(task._id)) {
            return;
        }
        const run = Object.hasOwn(task, 'currentRun')
            ? task.currentRun
            : (await listCollectorRunsForTask(task._id, { limit: 1 }))[0];
        if (this.resumeRequests.has(task._id) || this.activeTasks.has(task._id) || this.taskQueue.includes(task._id)) return;
        const runId = String(run?.id || run?._id || run?.runId || '');
        if (!runId || this.restoredRunIds.has(runId))
            return;
        const status = String(run.status || '').toUpperCase();
        const lockExpiresAt = run.lockExpiresAt ? new Date(run.lockExpiresAt).getTime() : 0;
        const stale = status === 'RUNNING' && (!lockExpiresAt || lockExpiresAt <= Date.now());
        if (status !== 'QUEUED' && !stale)
            return;
        collection.restoreRun(run, { resume: run.resultSummary?.resumeRequested === true });
        this.restoredRunIds.add(runId);
        if (run.cancelRequested) {
            await collection.cancel();
            task.taskStatus = 'cancelled';
            return;
        }
        if (!this.taskQueue.includes(task._id))
            this.taskQueue.push(task._id);
        collection.outputLog(status === 'QUEUED'
            ? '已恢复上次排队任务'
            : '检测到上次运行租约已过期，将从头安全重试并复用已保存结果', { preserveProgress: true });
    }

    /**
     * 分页获取所有任务
     */
    async getAllTasks(params) {
        try {
            const data = await listCollectorTasks(params);
            for (const task of data.list) {
                if (this.resumeRequests.has(task._id)) continue;
                let collection = this.tasks.get(task._id);
                const local = collection?.getTaskInfo();
                const localActive = this.activeTasks.has(task._id) && local;
                const cached = this.filePathList.get(task._id);
                const projected = Object.hasOwn(task, 'currentRun');
                const startError = localActive ? local.startError : cached?.startError;
                if (startError && startError.previousRunId === String(task.currentRunId || '')
                    && !['running', 'pending'].includes(task.taskStatus)) {
                    task.startError = { ...startError };
                    task.lastErrorCode = startError.code;
                    task.lastErrorMessage = startError.message;
                    task.taskStatus = 'failed';
                }
                else delete task.startError;
                task.progress = localActive
                    ? local.progress || task.progress
                    : projected ? task.progress : cached?.progress || task.progress || { current: 0, total: 0, totalCount: 0 };
                const candidates = [
                    localActive ? local.tableFilePath : '',
                    task.tableFilePath,
                    projected ? '' : cached?.filePath,
                    buildTaskExcelPath(this.getUserDataPath(), task._id, task.taskName),
                ];
                task.tableFilePath = '';
                for (const candidate of candidates) {
                    if (!candidate) continue;
                    try {
                        task.tableFilePath = assertTaskOwnsManagedExcelFile(this.getUserDataPath(), task._id, candidate);
                        break;
                    } catch { /* Missing/foreign local files cannot enable export. */ }
                }
                const runId = String(task.currentRun?.id || task.currentRunId || '');
                const recovered = cached?.runId === runId && cached.exportRecovered;
                const exportError = !recovered && (task.currentRun?.resultSummary?.exportError || cached?.runId === runId && cached.exportError);
                if (runId && !localActive && ['completed', 'failed', 'cancelled'].includes(task.taskStatus)
                    && Number(task.progress?.totalCount) > 0 && (!task.tableFilePath || exportError)) {
                    const filePath = buildTaskExcelPath(this.getUserDataPath(), task._id, task.taskName);
                    const previous = this.exportRecoverySources.get(task._id);
                    if (previous?.runId !== runId || previous.filePath !== filePath)
                        this.exportRecoverySources.set(task._id, { runId, filePath, displayName: task.taskName });
                    task.tableFilePath = filePath;
                    task.lastLog = '本机导出需要重新生成；点击“导出”将读取已保存结果';
                }
                else if (!this.exportRecoveries.has(task._id)) this.exportRecoverySources.delete(task._id);
                if (!collection) {
                    collection = this.createCollection(task);
                    this.tasks.set(task._id, collection);
                } else if (!localActive && !this.taskQueue.includes(task._id)) {
                    if (!task.startError) delete collection.getTaskInfo().startError;
                    Object.assign(collection.getTaskInfo(), task);
                } else {
                    local.createTime = task.createTime;
                    local.lastRunningTime = task.lastRunningTime;
                }
                await this.restorePersistedRun(task, collection);
            }
            while (this.taskQueue.length > 0 && this.activeTasks.size < this.maxConcurrentTasks)
                this.processNextTask();
            for (const task of data.list) {
                task.resumeBlockedReason = this.resumeRequests.has(task._id) ? '正在恢复原运行，请稍候' : this.resumeBlockedReason(task);
                task.canResume = !task.resumeBlockedReason;
                const failure = this.filePathList.get(task._id)?.resumeError;
                if (failure?.runId === String(task.currentRunId || task.currentRun?.id || '')) {
                    task.lastErrorCode = failure.code;
                    task.lastErrorMessage = failure.message;
                }
            }
            return data;
        }
        catch (error) {
            log.error('获取任务列表失败', error);
            throw error;
        }
    }
    /**
     * 取消任务
     */
    cancelTask(taskId) {
        return new Promise(async (resolve, reject) => {
            const task = this.tasks.get(taskId);
            if (!task) {
                reject('任务不存在');
                return;
            }
            try {
                const wasActive = this.activeTasks.has(taskId);
                // 从任务队列中移除
                const queueIndex = this.taskQueue.indexOf(taskId);
                if (queueIndex > -1) {
                    this.taskQueue.splice(queueIndex, 1);
                }
                if (!task.getRunId() && ['running', 'pending'].includes(task.getTaskInfo().taskStatus)) {
                    const runs = await listCollectorRunsForTask(taskId, { limit: 1 });
                    if (runs[0])
                        task.restoreRun(runs[0]);
                }
                await task.cancel();
                // 通知状态更新
                this.notifyTaskUpdate(taskId, 'cancelled');
                if (!wasActive) {
                    task.clearStatus(false, true);
                    this.tasks.delete(taskId);
                    this.processNextTask();
                }
                resolve(true);
            }
            catch (error) {
                log.error('取消任务失败', error);
                reject(error);
            }
        });
    }
    /**
     * 重新执行已完成或失败的任务
     */
    reExecuteTask(taskId) {
        if (this.exportRecoveries.has(taskId)) return Promise.reject(new Error('正在重新生成导出，请等待完成后开始采集'));
        this.refreshTaskQueue();
        return new Promise(async (resolve, reject) => {
            const task = this.tasks.get(taskId);
            if (!task)
                return reject('任务不存在');
            const taskInfo = task.getTaskInfo();
            // 只有已完成、失败或已取消的任务才能重新执行
            if (['completed', 'failed', 'cancelled'].includes(taskInfo.taskStatus)) {
                // 立即更新状态并通知
                if (this.activeTasks.size < this.maxConcurrentTasks) {
                    this.executeTask(taskId);
                }
                else {
                    if (this.taskQueue.includes(taskId))
                        return resolve(true);
                    try {
                        await task.prepareRun();
                    }
                    catch (error) {
                        this.recordStartupFailure(task, error);
                        reject(error);
                        return;
                    }
                    await task.updateStatus('pending');
                    task.outputLog('pending');
                    this.filePathList.delete(taskId);
                    this.taskQueue.push(taskId);
                }
                resolve(true);
            }
            else {
                reject('任务状态不允许重新执行');
            }
            resolve(true);
        });
    }
    /**
     * 删除任务
     */
    async deleteTask(taskId) {
        const taskIds = Array.isArray(taskId) ? taskId : [taskId];
        let successCount = 0;
        for (const id of taskIds) {
            const task = this.tasks.get(id);
            const task2 = this.filePathList.get(id);
            try {
                // 从服务器删除
                await deleteCollectorTask(id, task?.getTaskInfo()?.version);
                successCount++;
                try {
                    const filePath = this.existingExcelPath(
                        (await task?.getTableFilePath()) || task2?.filePath,
                    );
                    if (filePath)
                        await SysTemUtils.fileOperations.deleteFile(filePath);
                }
                catch (error) {
                    log.error('删除任务文件失败', error);
                }
            }
            catch (error) {
                log.error(`删除任务 ${id} 失败`, error);
            }
        }
        // 如果是批量删除，检查是否有部分成功
        if (Array.isArray(taskId)) {
            return successCount > 0;
        }
        else {
            return successCount === 1;
        }
    }
    /**
     * 通知任务状态更新
     */
    notifyTaskUpdate(taskId, status) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            const task = this.getTask(taskId);
            if (task) {
                this.mainWindow.webContents.send('task-status-update', { task, status });
            }
        }
    }
    /**
     * 批量删除任务
     */
    async deleteMultipleTasks(taskIds) {
        try {
            await Promise.all(taskIds.map((id) => deleteCollectorTask(
                id,
                this.tasks.get(id)?.getTaskInfo()?.version,
            )));
            for (const id of taskIds) {
                const task = this.tasks.get(id);
                const task2 = this.filePathList.get(id);
                if (!task && !task2)
                    continue;
                try {
                    const filePath = this.existingExcelPath(
                        (await task?.getTableFilePath()) || task2?.filePath,
                    );
                    if (filePath)
                        await SysTemUtils.fileOperations.deleteFile(filePath);
                }
                catch (error) {
                    log.error('删除任务文件失败', error);
                }
            }
            return true;
        }
        catch (error) {
            log.error('批量删除任务失败', error);
            throw error;
        }
    }
    // 下载表格
    async downloadExcel(payload) {
        const request = normalizeExcelDownloadRequest(payload);
        const recoveryTaskId = request.taskId || [...this.exportRecoverySources].find(([, source]) =>
            source.filePath === assertManagedExcelPath(this.getUserDataPath(), request.filePath))?.[0];
        if (recoveryTaskId && this.exportRecoverySources.has(recoveryTaskId)) {
            let recovery = this.exportRecoveries.get(recoveryTaskId);
            if (!recovery) {
                recovery = this.rebuildExcelFromRun(recoveryTaskId).finally(() => this.exportRecoveries.delete(recoveryTaskId));
                this.exportRecoveries.set(recoveryTaskId, recovery);
            }
            await recovery;
        }
        let requestedPath = '';
        if (request.taskId) {
            const task = this.tasks.get(request.taskId);
            const taskInfo = task?.getTaskInfo();
            const cached = this.filePathList.get(request.taskId);
            const loadedTaskMatches = task
                && String(taskInfo?._id || taskInfo?.id || '') === request.taskId;
            const cachedTaskMatches = cached
                && String(cached.taskId || '') === request.taskId;
            requestedPath = (typeof task?.getTableFilePath === 'function'
                && loadedTaskMatches
                ? await task.getTableFilePath()
                : '')
                || (loadedTaskMatches ? taskInfo?.tableFilePath : '')
                || (cachedTaskMatches ? cached?.filePath : '')
                || '';
            if (!requestedPath)
                throw new Error('任务没有可导出的 Excel 文件');
        }
        else {
            requestedPath = request.filePath;
        }
        const filePath = request.taskId
            ? assertTaskOwnsManagedExcelFile(this.getUserDataPath(), request.taskId, requestedPath)
            : assertExistingManagedExcelFile(this.getUserDataPath(), requestedPath);
        const registeredPaths = [];
        for (const [taskId, task] of this.tasks) {
            const taskInfo = task?.getTaskInfo();
            const cached = this.filePathList.get(taskId);
            const loadedTaskMatches = String(taskInfo?._id || taskInfo?.id || '') === String(taskId);
            const cachedTaskMatches = String(cached?.taskId || '') === String(taskId);
            const taskFilePath = typeof task?.getTableFilePath === 'function'
                && loadedTaskMatches
                ? await task.getTableFilePath()
                : '';
            registeredPaths.push(
                taskFilePath,
                loadedTaskMatches ? taskInfo?.tableFilePath : '',
                cachedTaskMatches ? cached?.filePath : '',
            );
        }
        for (const [taskId, cached] of this.filePathList) {
            if (String(cached?.taskId || '') === String(taskId))
                registeredPaths.push(cached.filePath);
        }
        const isRegistered = registeredPaths.some((candidate) =>
            this.existingExcelPath(candidate) === filePath);
        if (!isRegistered)
            throw new Error('该 Excel 文件不属于已登记任务');
        const outcome = await SysTemUtils.fileOperations.copyFile(filePath);
        if (outcome?.status === 'cancelled')
            return { status: 'cancelled' };
        if (outcome?.status === 'saved' && typeof outcome.filePath === 'string' && outcome.filePath)
            return { status: 'saved', filePath: outcome.filePath };
        throw new Error('Excel 文件复制返回了无效结果');
    }
    async rebuildExcelFromRun(taskId) {
        const source = this.exportRecoverySources.get(taskId), token = getSonliToken();
        const task = this.tasks.get(taskId);
        const checkOwner = () => {
            if (getSonliToken() !== token || this.exportRecoverySources.get(taskId) !== source
                || this.tasks.get(taskId) !== task || this.activeTasks.has(taskId))
                throw new Error('账号或任务已变化，请刷新后重新导出');
        };
        let exporter;
        task?.outputLog('正在从已保存结果重新生成导出，请等待图片和表格保存', { preserveProgress: true });
        try {
            const run = await getCollectorRun(source.runId);
            checkOwner();
            if (run.taskId !== taskId || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status))
                throw new Error('导出运行的任务归属不匹配或运行尚未结束');
            exporter = new ExcelService(taskId, source.displayName);
            await exporter.startFreshTable();
            let rows = 0;
            const batchSize = 20;
            for (let offset = 0; ; offset += batchSize) {
                const items = await listCollectorRunItems(run.id, { status: 'QUALIFIED', offset, limit: batchSize });
                checkOwner();
                for (const saved of items) {
                    checkOwner();
                    const item = { ...saved.rawPayload, ...saved.exportData };
                    const batch = item.captureScope === 'ALL' ? item.variantData.variants : [item];
                    if (!await exporter.saveExcel(batch)) throw new Error('Excel 数据无法写入，请检查本机目录后重试');
                    checkOwner();
                    rows += batch.length;
                }
                if (items.length < batchSize) break;
            }
            if (!rows) throw new Error('本次运行没有可导出的合格商品');
            if (!await exporter.flushToDisk()) throw new Error('Excel 保存失败，请关闭已打开的表格并检查磁盘空间后重试');
            checkOwner();
            const filePath = assertTaskOwnsManagedExcelFile(this.getUserDataPath(), taskId, await exporter.getFilePath());
            this.filePathList.set(taskId, { ...this.filePathList.get(taskId), taskId, runId: run.id, filePath, exportError: '', exportRecovered: true });
            if (task) task.getTaskInfo().tableFilePath = filePath;
            this.exportRecoverySources.delete(taskId);
            task?.outputLog(`重新生成导出完成，共 ${rows} 个 SKU`, { preserveProgress: true });
        }
        catch (error) {
            await exporter?.flushToDisk().catch(() => {});
            task?.outputLog(`重新生成导出失败：${error?.message || error}`, { preserveProgress: true });
            throw error;
        }
        finally { exporter?.destroy(); }
    }
    // 刷新队列
    refreshTaskQueue() {
        while (this.activeTasks.size < this.maxConcurrentTasks && this.taskQueue.length)
            this.processNextTask();
    }
    /**
     * 终止所有任务（切换登录时调用）
     */
    async stopAllTasks() {
        closeRetainedCollectionWindow();
        const interrupted = [...new Set([...this.activeTasks, ...this.taskQueue])];
        // 首先清空任务队列
        this.taskQueue = [];
        // 取消所有活跃任务
        for (const taskId of interrupted) {
            const task = this.tasks.get(taskId);
            // 使用副本避免迭代时修改
            try {
                await this.cancelTask(taskId);
            }
            catch (error) {
                log.error(`取消活跃任务 ${taskId} 失败:`, error);
            }
            finally {
                if (!this.activeTasks.has(taskId)) await task?.clearStatus(false, true);
            }
        }
        this.tasks.clear();
        this.filePathList.clear();
        this.exportRecoverySources.clear();
    }
}

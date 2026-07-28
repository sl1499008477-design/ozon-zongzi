import { Collection } from './collection.services.js';
import log from '../../log/index.js';
import { SysTemUtils } from '../../utils/system.js';
import { memoryMonitor } from '../memory-monitor.services.js';
import {
    copyCollectorTask,
    createCollectorTask,
    deleteCollectorTask,
    listCollectorTasks,
    listCollectorRunsForTask,
    updateCollectorTask,
} from '../collector-backend.services.js';
import os from 'os';
import {
    assertExistingManagedExcelFile,
    buildTaskExcelPath,
    normalizeExcelDownloadRequest,
} from './excel-path.core.js';
export class TaskManager {
    static instance;
    tasks = new Map();
    activeTasks = new Set();
    maxConcurrentTasks;
    taskQueue = [];
    restoredRunIds = new Set();
    mainWindow = null;
    filePathList = new Map();
    constructor() {
        this.maxConcurrentTasks = (os.totalmem() / 1024 / 1024 / 1024) > 15 ? 8 : 4;
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
                    collection = new Collection(saved, this.mainWindow);
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
                    collection = new Collection(saved, this.mainWindow);
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
                const collection = new Collection(newTaskData, this.mainWindow);
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
    /**
     * 实际执行任务
     */
    async executeTask(taskId) {
        const task = this.tasks.get(taskId);
        if (!task)
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
            if (task.getTaskInfo().taskStatus === 'completed')
                this.mainWindow?.webContents.send('task-completed', {
                    message: `任务：${task.getTaskInfo().taskName}已完成`,
                });
            const safeResult = JSON.parse(JSON.stringify(result));
            safeResult.filePath = this.existingExcelPath(safeResult.filePath);
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
            || this.activeTasks.has(task._id)
            || this.taskQueue.includes(task._id)) {
            return;
        }
        const runs = await listCollectorRunsForTask(task._id, { limit: 1 });
        const run = runs[0];
        const runId = String(run?.id || run?._id || run?.runId || '');
        if (!runId || this.restoredRunIds.has(runId))
            return;
        const status = String(run.status || '').toUpperCase();
        const lockExpiresAt = run.lockExpiresAt ? new Date(run.lockExpiresAt).getTime() : 0;
        const stale = status === 'RUNNING' && (!lockExpiresAt || lockExpiresAt <= Date.now());
        if (status !== 'QUEUED' && !stale)
            return;
        collection.restoreRun(run);
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
            : '检测到上次运行租约已过期，将从头安全重试并复用已保存结果');
    }

    /**
     * 分页获取所有任务
     */
    async getAllTasks(params) {
        try {
            const data = await listCollectorTasks(params);
            for (let task of data.list) {
                const copyTask = this.filePathList.get(task._id);
                if (!this.tasks.has(task._id)) {
                    task.progress =
                        task.taskStatus !== 'pending'
                            ? copyTask?.progress || { current: 0, total: 0, totalCount: 0 }
                            : { current: 0, total: 0, totalCount: 0 };
                    task.tableFilePath = this.existingExcelPath(copyTask?.filePath);
                    const collection = new Collection(task, this.mainWindow);
                    this.tasks.set(task._id, collection);
                }
                else {
                    const progress2 = JSON.parse(JSON.stringify(this.tasks.get(task._id)?.getTaskInfo().progress) || '{}');
                    const filePath = this.tasks.get(task._id)?.getTaskInfo()?.tableFilePath;
                    if (task.taskStatus === 'running' || task.taskStatus === 'pending') {
                        const existingFilePath = this.existingExcelPath(filePath);
                        if (existingFilePath)
                            task.tableFilePath = existingFilePath;
                        task.progress = progress2;
                    }
                    else {
                        task.progress = copyTask?.progress || { current: 0, total: 0, totalCount: 0 };
                        const existingFilePath = this.existingExcelPath(copyTask?.filePath);
                        if (existingFilePath)
                            task.tableFilePath = existingFilePath;
                    }
                }
                if (!task.tableFilePath) {
                    const filePath = buildTaskExcelPath(
                        this.getUserDataPath(),
                        task._id,
                        task.taskName,
                    );
                    const existingFilePath = this.existingExcelPath(filePath);
                    if (existingFilePath)
                        task.tableFilePath = existingFilePath;
                }
                const collection = this.tasks.get(task._id);
                if (collection)
                    await this.restorePersistedRun(task, collection);
            }
            while (this.taskQueue.length > 0 && this.activeTasks.size < this.maxConcurrentTasks)
                this.processNextTask();
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
                        return;
                    task.updateStatus('pending');
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
        let requestedPath = '';
        if (request.taskId) {
            const task = this.tasks.get(request.taskId);
            const taskInfo = task?.getTaskInfo();
            const cached = this.filePathList.get(request.taskId);
            requestedPath = (typeof task?.getTableFilePath === 'function'
                ? await task.getTableFilePath()
                : '')
                || taskInfo?.tableFilePath
                || cached?.filePath
                || '';
            if (!requestedPath)
                throw new Error('任务没有可导出的 Excel 文件');
        }
        else {
            requestedPath = request.filePath;
        }
        const filePath = assertExistingManagedExcelFile(this.getUserDataPath(), requestedPath);
        const registeredPaths = [];
        for (const [taskId, task] of this.tasks) {
            const taskInfo = task?.getTaskInfo();
            const cached = this.filePathList.get(taskId);
            const taskFilePath = typeof task?.getTableFilePath === 'function'
                ? await task.getTableFilePath()
                : '';
            registeredPaths.push(
                taskFilePath,
                taskInfo?.tableFilePath,
                cached?.filePath,
            );
        }
        const isRegistered = registeredPaths.some((candidate) =>
            this.existingExcelPath(candidate) === filePath);
        if (!isRegistered)
            throw new Error('该 Excel 文件不属于已登记任务');
        await SysTemUtils.fileOperations.copyFile(filePath);
        return true;
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
        // 首先清空任务队列
        this.taskQueue = [];
        // 取消所有活跃任务
        for (const taskId of [...this.activeTasks]) {
            // 使用副本避免迭代时修改
            try {
                await this.cancelTask(taskId);
            }
            catch (error) {
                log.error(`取消活跃任务 ${taskId} 失败:`, error);
            }
        }
        this.tasks.clear();
        this.filePathList.clear();
    }
}

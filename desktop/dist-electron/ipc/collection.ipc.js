import { ipcMain, app } from 'electron';
import { TaskManager } from '../services/collection/task-manager.services.js';
import { SysTemUtils } from '../utils/system.js';
import log from '../log/index.js';
import { getShopList, getCategoryList } from '../services/collection/interface.services.js';
import { join } from 'node:path';
import { addCollectorResultsToCollectBox, getCollectorTask, listCollectorAiConfigs, readCollectorRunOutcomes, listCollectorRunsForTask, listCollectorRunResults } from '../services/collector-backend.services.js';
import { normalizeExcelDownloadRequest } from '../services/collection/excel-path.core.js';
import { sendCollectorResultsToAiListing } from '../services/collector-ai-listing.services.js';
import { readCollectorDuplicates } from '../services/collector-duplicates.services.js';
import { listCollectorFilterPresets, saveCollectorFilterPreset, updateCollectorFilterPreset, deleteCollectorFilterPreset } from '../services/collector-filter-presets.services.js';
export const collectionIpc = (win) => {
    const taskManager = TaskManager.getInstance();
    taskManager.setMainWindow(win);
    // 创建任务
    ipcMain.handle('collection-create', async (event, data) => {
        try {
            const taskId = await taskManager.addTask(data.data);
            const task = taskManager.getTask(taskId);
            return {
                code: 200,
                message: '任务创建成功',
                data: task,
            };
        }
        catch (error) {
            log.error('创建任务失败', error);
            return {
                code: 500,
                message: error instanceof Error ? error.message : String(error),
                data: null,
            };
        }
    });
    // 复制任务
    ipcMain.handle('collection-copy', async (event, data) => {
        const taskId = await taskManager.copyTask(data.data);
        const task = taskManager.getTask(taskId);
        try {
            return {
                code: 200,
                message: '任务复制成功',
                data: task,
            };
        }
        catch (error) {
            log.error('复制任务失败', error);
            return {
                code: 500,
                message: error instanceof Error ? error.message : String(error),
                data: null,
            };
        }
    });
    // 开始任务
    ipcMain.handle('collection-start-task', async (event, taskId) => {
        try {
            const success = await taskManager.startTaskById(taskId);
            if (success) {
                return {
                    code: 200,
                    message: '任务启动成功',
                    data: taskManager.getTask(taskId),
                };
            }
            else {
                return {
                    code: 400,
                    message: '无法启动任务',
                    data: null,
                };
            }
        }
        catch (error) {
            log.error('启动任务失败', error);
            return {
                code: 500,
                message: error instanceof Error ? error.message : String(error),
                data: null,
            };
        }
    });
    // 创建并启动任务
    ipcMain.handle('collection-create-and-start', async (event, { data }) => {
        try {
            // 创建任务
            const taskId = await taskManager.addTask(data);
            // 立即启动任务
            if (!taskId)
                throw new Error('任务创建失败');
            const task = taskManager.getTask(taskId);
            const started = ['completed', 'failed', 'cancelled'].includes(task.taskStatus)
                ? await taskManager.reExecuteTask(taskId)
                : await taskManager.startTaskById(taskId);
            if (started) {
                return { code: 200, message: '任务创建并启动成功', data: { id: taskId } };
            }
            else {
                return { code: 500, message: '任务启动失败', data: { id: taskId } };
            }
        }
        catch (error) {
            log.error('创建并启动任务失败', error);
            return {
                code: 500,
                message: error,
                data: null,
            };
        }
    });
    // 重新执行任务
    ipcMain.handle('collection-re-execute-task', async (event, taskId) => {
        try {
            const success = await taskManager.reExecuteTask(taskId);
            if (success) {
                return {
                    code: 200,
                    message: '任务重新执行成功',
                    data: taskManager.getTask(taskId),
                };
            }
            else {
                return {
                    code: 400,
                    message: '无法重新执行任务',
                    data: null,
                };
            }
        }
        catch (error) {
            log.error('重新执行任务失败', error);
            return {
                code: 500,
                message: error instanceof Error ? error.message : String(error),
                data: null,
            };
        }
    });
    ipcMain.handle('collection-resume-task', async (_event, payload) => {
        try { return { code: 200, data: await taskManager.resumeTask(payload), message: '已继续原采集运行' }; }
        catch (error) { return { code: Number(error?.status || 500), errorCode: error?.code || 'COLLECTOR_RESUME_FAILED', message: error?.message || String(error), data: null }; }
    });
    // 获取任务状态
    ipcMain.handle('collection-get-task', async (event, taskId) => {
        try {
            // Source tasks may be outside the current page; the API checks the current account.
            const task = await getCollectorTask(taskId);
            if (!task) {
                return {
                    code: 404,
                    message: '任务不存在',
                    data: null,
                };
            }
            return {
                code: 200,
                message: '获取任务成功',
                data: task,
            };
        }
        catch (error) {
            return {
                code: Number(error?.status || 500),
                message: error?.status === 404 ? '原任务已不存在' : '无法读取原任务，请确认登录账号后重试',
                data: null,
            };
        }
    });
    ipcMain.handle('collection-get-duplicates', async (event, payload) => {
        try {
            return { code: 200, message: '获取跳过商品成功', data: await readCollectorDuplicates(payload) };
        }
        catch (error) {
            const code = Number(error?.status || 500);
            return { code, message: [401, 403].includes(code) ? '无法读取跳过商品，请确认登录账号后重试'
                : code === 422 ? '该任务还没有可查看的运行记录' : '读取跳过商品失败，请重试', data: null };
        }
    });
    ipcMain.handle('collection-get-outcomes', async (_event, payload) => {
        try { return { code: 200, data: await readCollectorRunOutcomes(payload) }; }
        catch (error) { return { code: Number(error?.status || 500), message: error?.message || '读取采集结果失败，请重试' }; }
    });
    ipcMain.handle('collection-get-runs', async (_event, { taskId, limit = 50, offset = 0 } = {}) => {
        try {
            return { code: 200, data: { runs: await listCollectorRunsForTask(taskId, { limit, offset }) } };
        }
        catch (error) {
            return { code: Number(error?.status || 500), message: error?.message || '读取历史轮次失败，请重试' };
        }
    });
    ipcMain.handle('collection-get-results', async (_event, { runId, limit = 50, offset = 0 } = {}) => {
        try {
            return { code: 200, data: await listCollectorRunResults(runId, { limit, offset }) };
        }
        catch (error) {
            return { code: Number(error?.status || 500), message: error?.message || '读取已保存商品失败，请重试' };
        }
    });
    ipcMain.handle('collection-retry-failed', async (_event, payload) => {
        try { return { code: 200, data: await taskManager.retryFailedItems(payload), message: '已按原配置建立失败商品重试任务' }; }
        catch (error) { return { code: Number(error?.status || 500), message: error?.message || '建立重试任务失败' }; }
    });
    // 获取所有任务
    ipcMain.handle('collection-get-all-tasks', async (event, params) => {
        try {
            const data = params?.pageNo
                ? await taskManager.getAllTasks(params)
                : await taskManager.getAllTasksList();
            return data;
        }
        catch (error) {
            log.error('获取任务列表失败', error);
            return {
                code: 500,
                message: error instanceof Error ? error.message : '获取任务失败',
                data: null,
            };
        }
    });
    // 取消任务
    ipcMain.handle('collection-cancel-task', async (event, taskId) => {
        try {
            const success = await taskManager.cancelTask(taskId);
            const task = taskManager.getTask(taskId);
            if (success) {
                return {
                    code: 200,
                    message: '任务取消成功',
                    data: task,
                };
            }
            else {
                return {
                    code: 400,
                    message: '无法取消任务',
                    data: null,
                };
            }
        }
        catch (error) {
            log.error('取消任务失败', error);
            return {
                code: 500,
                message: error instanceof Error ? error.message : String(error),
                data: null,
            };
        }
    });
    // 取消所有任务
    ipcMain.handle('collection-cancel-all-task', async (event, refresh = false) => {
        try {
            await taskManager.stopAllTasks();
            if (refresh)
                win.webContents.send('refresh-task-list');
            return true;
        }
        catch (error) {
            log.error(error);
            return true;
        }
    });
    // 删除任务
    ipcMain.handle('collection-delete-task', async (event, taskId) => {
        try {
            let success;
            if (Array.isArray(taskId)) {
                success = await taskManager.deleteMultipleTasks(taskId);
            }
            else {
                success = await taskManager.deleteTask(taskId);
            }
            if (success) {
                return {
                    code: 200,
                    message: '任务删除成功',
                    data: null,
                };
            }
            else {
                return {
                    code: 400,
                    message: '无法删除任务',
                    data: null,
                };
            }
        }
        catch (error) {
            log.error('删除任务失败', error);
            return {
                code: 500,
                message: error instanceof Error ? error.message : '删除任务失败',
                data: null,
            };
        }
    });
    // 下载表格
    ipcMain.handle('collection-download-excel', async (_event, payload) => {
        return await taskManager.downloadExcel(normalizeExcelDownloadRequest(payload));
    });
    // 将明确选择的结果，或本任务全部 QUALIFIED 结果加入 ozon 粽子采集箱。
    ipcMain.handle('collection-add-to-collect-box', async (_event, payload = {}) => {
        try {
            const result = await addCollectorResultsToCollectBox(payload);
            return {
                code: result.ok ? 200 : 207,
                message: result.ok
                    ? `已加入采集箱 ${result.added} 个商品`
                    : `成功 ${result.added} 个，失败 ${result.errors.length + result.missing.length} 个`,
                data: result,
            };
        }
        catch (error) {
            return { code: Number(error?.status || 500), message: error?.message || String(error), data: null };
        }
    });
    ipcMain.handle('collection-filter-presets-list', () => {
        try { return { code: 200, data: listCollectorFilterPresets() }; }
        catch (error) { return { code: 400, message: error.message }; }
    });
    ipcMain.handle('collection-filter-presets-save', (_event, input) => {
        try { return { code: 200, data: saveCollectorFilterPreset(input) }; }
        catch (error) { return { code: 400, message: error.message }; }
    });
    ipcMain.handle('collection-filter-presets-update', (_event, input) => {
        try { return { code: 200, data: updateCollectorFilterPreset(input) }; }
        catch (error) { return { code: 400, message: error.message }; }
    });
    ipcMain.handle('collection-filter-presets-delete', (_event, input) => {
        try { return { code: 200, data: deleteCollectorFilterPreset(input) }; }
        catch (error) { return { code: 400, message: error.message }; }
    });
    ipcMain.handle('collection-ai-configs', async () => {
        try { return { code: 200, data: await listCollectorAiConfigs() }; }
        catch (error) { return { code: Number(error?.status || 500), message: error?.message || String(error) }; }
    });
    ipcMain.handle('collection-send-to-ai-listing', (_event, payload = {}) => sendCollectorResultsToAiListing(payload));
    // 获取店铺
    ipcMain.handle('get-shop-list', async (event, params) => {
        return await getShopList();
    });
    // 获取分类
    ipcMain.handle('get-category-list', async (event, params) => {
        return await getCategoryList({
            refresh: params?.refresh === true,
            localOnly: params?.localOnly === true,
            background: params?.background === true,
        });
    });
    // 获取当前任务数
    ipcMain.handle('get-current-task-count', async (event) => {
        return taskManager.getConcurrentTaskCount();
    });
    // 设置最大并发任务数
    ipcMain.handle('set-max-concurrent-task-count', async (event, count) => {
        taskManager.setMaxConcurrentTasks(count);
        return true;
    });
    // 下载所有表格
    ipcMain.handle('download-all-tables', async (event) => {
        try {
            const desktopPath = app.getPath('desktop');
            const excelDir = join(SysTemUtils.getAppInfo().userDataPath, 'excel');
            const timestamp = new Date().getTime();
            const folderName = `sonli_collector_${timestamp}`;
            const dest = join(desktopPath, folderName);
            return SysTemUtils.fileOperations.copyFolder(excelDir, dest) === true;
        }
        catch (error) {
            log.error('导出所有表格失败~', error);
            return false;
        }
    });
};

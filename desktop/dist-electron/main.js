import { app, BrowserWindow } from 'electron';
import { createWindow } from './windows/main.window.js';
import log, { initLogger } from './log/index.js';
import { CloseProcessService } from './services/closeProcess.services.js';
import { globalBroadcast } from './ipc/broadcast.js';
import { operationStore } from './store/index.js';
import { memoryMonitor } from './services/memory-monitor.services.js';
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('log-level', '3');
// 重启相关常量
const RESTART_COUNT_KEY = 'restart-count';
const MAX_RESTART_COUNT = 3;
let IS_EXITING = false;
let IS_RESTARTING = false;
class ElectronApp {
    isAppCrashed = false;
    constructor() {
        // 初始化日志系统
        initLogger();
        this.setupEventHandlers();
    }
    /**
     * 获取重启次数
     */
    getRestartCount() {
        const args = process.argv;
        const restartArg = args.find((arg) => arg.startsWith(`${RESTART_COUNT_KEY}=`));
        if (restartArg) {
            const countStr = restartArg.split('=')[1];
            const count = parseInt(countStr, 10);
            return isNaN(count) ? 0 : count;
        }
        return 0;
    }
    /**
     * 安全重启应用
     */
    safeRelaunch() {
        IS_RESTARTING = true;
        const currentCount = this.getRestartCount();
        if (currentCount >= MAX_RESTART_COUNT) {
            log.error(`重启次数已达上限(${MAX_RESTART_COUNT}次)，应用将退出`);
            app.exit(1);
            return;
        }
        const newCount = currentCount + 1;
        log.info(`第 ${newCount} 次尝试重启应用（最大允许${MAX_RESTART_COUNT}次）`);
        try {
            // 构造新的命令行参数，包含重启次数
            const args = [...process.argv.slice(1), `${RESTART_COUNT_KEY}=${newCount}`];
            app.relaunch({ args });
            app.exit(0);
        }
        catch (error) {
            log.error('应用重启失败:', error);
            app.exit(1);
        }
    }
    /**
     * 检查是否应该允许重启
     */
    shouldAllowRestart() {
        const restartCount = this.getRestartCount();
        if (restartCount === 0) {
            return true; // 首次启动总是允许
        }
        if (restartCount >= MAX_RESTART_COUNT) {
            log.warn(`重启次数已达上限(${MAX_RESTART_COUNT}次)，不再重启`);
            return false;
        }
        return true;
    }
    /**
     * 判断错误是否属于致命崩溃
     */
    isFatalError(error) {
        // 检查错误类型是否为致命错误
        if (!error)
            return false;
        const errorMessage = error.message || String(error);
        const errorStack = error.stack || '';
        // 检查特定的致命错误类型
        const fatalPatterns = [
            /object has been destroyed/i, // Electron对象被销毁
            /context is isolated/i, // 上下文隔离相关错误
            /cannot read property/i, // 属性读取错误
            /destroyed|disposed/i, // 对象已销毁
            /renderer process gone/i, // 渲染进程崩溃
            /segmentation fault/i, // 段错误
            /access violation/i, // 访问违规
            /stack overflow/i, // 栈溢出
            /out of memory/i, // 内存不足
            /fatal error in v8/i, // V8致命错误
        ];
        return fatalPatterns.some((pattern) => pattern.test(errorMessage) || pattern.test(errorStack));
    }
    /**
     * 设置应用事件处理器
     */
    setupEventHandlers() {
        // 进程锁
        const gotTheLock = app.requestSingleInstanceLock();
        if (!gotTheLock) {
            log.info('应用已在运行，退出当前实例');
            app.quit();
            return;
        }
        // 监听第二个实例尝试启动的事件
        app.on('second-instance', (event, commandLine, workingDirectory) => {
            log.info('检测到第二个实例尝试启动');
            // 如果有第二个实例启动，则激活现有的窗口
            const windows = BrowserWindow.getAllWindows();
            if (windows.length > 0) {
                const mainWindow = windows[0];
                if (mainWindow.isMinimized())
                    mainWindow.restore();
                mainWindow.focus();
            }
        });
        /**
         * 应用准备就绪
         */
        app.whenReady().then(() => {
            log.info('应用准备就绪，开始创建窗口');
            // 记录重启次数
            const restartCount = this.getRestartCount();
            memoryMonitor.start(600000);
            if (restartCount > 0) {
                log.info(`当前为第 ${restartCount} 次重启`);
            }
            try {
                const isExecuteClose = operationStore.get('is-execute-close');
                if (!isExecuteClose)
                    new CloseProcessService().run();
                operationStore.set('is-execute-close', false);
                createWindow();
                log.info('主窗口创建成功');
            }
            catch (error) {
                log.error('创建主窗口失败:', error);
            }
            // macOS 激活时创建窗口
            app.on('activate', () => {
                log.info('应用被激活');
                if (BrowserWindow.getAllWindows().length === 0) {
                    log.info('没有打开的窗口，重新创建窗口');
                    createWindow();
                }
            });
        });
        /**
         * 所有窗口关闭时退出应用（macOS 除外）
         */
        app.on('window-all-closed', () => {
            log.info('所有窗口已关闭');
            if (process.platform !== 'darwin') {
                log.info('非 macOS 平台，退出应用');
                app.quit();
            }
        });
        /**
         * 应用退出前的清理工作
         */
        app.on('before-quit', async (event) => {
            memoryMonitor.stop();
            if (IS_EXITING || IS_RESTARTING)
                return;
            IS_EXITING = true;
            event.preventDefault();
            try {
                globalBroadcast.broadcast('app-ready-quit', '退出清理等待');
                const closeProcessService = new CloseProcessService();
                await closeProcessService.deleteFolder();
                await closeProcessService.run();
                await new Promise((resolve) => setTimeout(resolve, 2000));
                app.exit(0);
            }
            catch (error) {
                log.error('退出清理失败！', error);
                app.exit(1);
            }
            log.info('应用即将退出');
        });
        /**
         * 渲染进程崩溃事件
         */
        app.on('render-process-gone', (event, webContents, details) => {
            log.error('渲染进程崩溃详情:', details);
            if (details.reason === 'crashed') {
                this.isAppCrashed = true; // 标记应用崩溃
                log.info('检测到渲染进程崩溃，执行重启策略...');
                if (this.shouldAllowRestart()) {
                    log.info('符合重启条件，正在重启应用...');
                    this.safeRelaunch();
                }
                else {
                    log.info('超出重启限制，应用将退出');
                    app.quit();
                }
            }
        });
        /**
         * 未捕获异常处理 - 只有在致命错误时才重启
         */
        process.on('uncaughtException', (error) => {
            log.error('未捕获的异常:', error);
            // 只有在致命错误时才重启
            if (this.isFatalError(error) && app.isReady()) {
                this.isAppCrashed = true; // 标记应用崩溃
                log.info('检测到致命异常，执行重启策略...', error);
                if (this.shouldAllowRestart()) {
                    log.info('符合重启条件，正在重启应用...');
                    this.safeRelaunch();
                }
                else {
                    log.info('超出重启限制，应用将退出');
                    app.exit(1);
                }
            }
            else {
                // 非致命错误，记录但不重启
                log.warn('检测到非致命异常，无需重启应用:', error.message || error);
            }
        });
        /**
         * 未处理的Promise拒绝处理 - 只有在致命错误时才重启
         */
        process.on('unhandledRejection', (reason, promise) => {
            log.error('未处理的Promise拒绝:', reason);
            // 检查拒绝的原因是否为致命错误
            if (reason instanceof Error && this.isFatalError(reason) && app.isReady()) {
                this.isAppCrashed = true; // 标记应用崩溃
                log.info('检测到致命Promise拒绝，执行重启策略...');
                if (this.shouldAllowRestart()) {
                    log.info('符合重启条件，正在重启应用...');
                    this.safeRelaunch();
                }
                else {
                    log.info('超出重启限制，应用将退出');
                    app.exit(1);
                }
            }
            else {
                // 非致命的Promise拒绝，记录但不重启
                const errorMessage = reason instanceof Error ? reason.message : String(reason);
                log.warn('检测到非致命Promise拒绝，无需重启应用:', errorMessage);
            }
        });
    }
    /**
     * 启动应用
     */
    start() {
        // 启动逻辑已经在构造函数中设置好了
        log.info('Electron 应用已启动');
    }
}
// 创建并启动应用实例
const electronApp = new ElectronApp();
electronApp.start();
export default electronApp;

import { BrowserWindow, app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resisterAllIpc } from '../ipc/main.ipc.js';
import log from '../log/index.js';
import { UpdaterManager } from '../services/update.services.js';
import { SysTemUtils } from '../utils/system.js';
// __dirname 表示当前文件所在目录的绝对路径
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export let mainWindow;
/**
 * 重新创建窗口的函数
 */
export const recreateMainWindow = () => {
    log.info('正在尝试重新创建主窗口...');
    if (mainWindow) {
        mainWindow.destroy(); // 销毁旧窗口
        mainWindow = null;
    }
    createWindow();
};
/**
 * 创建主窗口
 */
export const createWindow = () => {
    log.info('开始创建主窗口...');
    const preloadPath = path.join(__dirname, '../../electron/preload.js');
    log.info(`Preload 脚本路径: ${preloadPath}`);
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 800,
        minWidth: 1100,
        minHeight: 680,
        show: false,
        autoHideMenuBar: true,
        title: 'sonli 采集助手',
        frame: false,
        backgroundColor: '#f5f7fb',
        icon: path.join(__dirname, '../../build/icon.png'),
        webPreferences: {
            nodeIntegration: false, // 禁止网页使用nodejs的API
            contextIsolation: true, // 启用上下文隔离
            preload: preloadPath,
            sandbox: true,
        },
    });
    log.info('BrowserWindow 实例创建成功');
    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
        const current = mainWindow?.webContents.getURL() || '';
        if (current && url !== current)
            event.preventDefault();
    });
    // 注册 IPC 处理器
    try {
        resisterAllIpc(mainWindow);
        const updaterManagerInstance = UpdaterManager.getInstance();
        updaterManagerInstance.init();
        updaterManagerInstance.setMainWindow(mainWindow);
        log.info('IPC处理器注册成功');
    }
    catch (error) {
        log.error('IPC 处理器注册失败:', error);
    }
    // 监听页面加载事件
    mainWindow.webContents.on('did-start-loading', () => {
        log.info('页面开始加载');
    });
    mainWindow.webContents.on('did-finish-load', () => {
        log.info('页面加载完成');
    });
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        log.error(`页面加载失败: [${errorCode}] ${errorDescription}`);
    });
    mainWindow.on('unresponsive', () => {
        log.warn('主窗口无响应');
    });
    mainWindow.on('responsive', () => {
        log.info('主窗口恢复响应');
    });
    mainWindow.on('maximize', () => {
        mainWindow?.webContents.send('maximize');
    });
    mainWindow.on('unmaximize', () => {
        mainWindow?.webContents.send('unmaximize');
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        log.error('渲染进程消失:', details);
        // 如果是崩溃或被杀死的情况，尝试重启
        if (details.reason === 'crashed' || details.reason === 'killed') {
            log.info('检测到渲染进程崩溃，尝试重启窗口...');
            // 延迟一段时间后重新创建窗口
            setTimeout(() => {
                if (!mainWindow || mainWindow.isDestroyed()) {
                    recreateMainWindow();
                }
            }, 1000);
        }
    });
    // 捕获控制台消息
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        const levels = ['verbose', 'info', 'warn', 'error'];
        log.info(`[渲染进程控制台 - ${levels[level]}] ${message} (${sourceId}:${line})`);
    });
    // 开发环境开启调试台
    if (SysTemUtils.getEnv() === 'development' && !app.isPackaged) {
        log.info('开发环境: 打开开发者工具');
        mainWindow.webContents.openDevTools();
    }
    // 加载页面
    if (SysTemUtils.getEnv() === 'development') {
        const devUrl = app.isPackaged
            ? path.join(__dirname, '../../dist/index.html')
            : 'http://localhost:3000/login';
        log.info(`开发环境: 加载 URL - ${devUrl}`);
        mainWindow.loadURL(devUrl).catch((err) => {
            log.error('加载开发服务器失败:', err);
        });
    }
    else {
        const indexPath = path.join(__dirname, '../../dist/index.html');
        log.info(`生产环境: 加载文件 - ${indexPath}`);
        mainWindow.loadFile(indexPath).catch((err) => {
            log.error('加载 index.html 失败:', err);
        });
    }
    mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
        // 用户最终选择的保存路径
        const savePath = item.getSavePath();
        item.on('updated', () => {
            const savePath = item.getSavePath();
            if (savePath) {
                log.info('用户保存路径：', savePath);
            }
        });
        item.once('done', (event, state) => {
            log.info(`下载完成：${state}`, savePath);
        });
    });
    mainWindow.on('close', (event) => {
        event.preventDefault();
        mainWindow?.webContents.send('window-close');
    });
    mainWindow.on('closed', () => {
        log.info('主窗口已关闭');
        mainWindow = null;
    });
};

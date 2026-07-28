import { app, dialog, shell, clipboard, screen, powerMonitor, Notification, Tray, Menu, } from 'electron';
import { join, dirname, basename, extname } from 'path';
import { rmSync, unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, copyFileSync, } from 'fs';
import log from '../log/index.js';
import dayjs from 'dayjs';
/**
 * Electron 系统级能力封装
 */
export class SysTemUtils {
    /**
     * 获取环境变量
     */
    static getEnv() {
        if (!app.isPackaged)
            return 'development';
        try {
            const packagePath = join(app.getAppPath(), 'package.json');
            const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
            return pkg.APP_ENV || 'production';
        }
        catch (err) {
            log.info(err, '错误信息');
            return 'production';
        }
    }
    /**
     * 获取应用相关信息
     */
    static getAppInfo() {
        return {
            name: app.getName(),
            version: app.getVersion(),
            path: app.getAppPath(),
            userDataPath: app.getPath('userData'),
            homePath: app.getPath('home'),
            tempDirectory: app.getPath('temp'),
        };
    }
    /**
     * 获取系统信息
     */
    static getSystemInfo() {
        return {
            platform: process.platform,
            arch: process.arch,
            versions: process.versions,
        };
    }
    /**
     * 获取日志目录路径
     */
    static getLogDirectory() {
        try {
            const installDir = app.getPath('userData');
            return join(installDir, 'logs');
        }
        catch (error) {
            console.error('获取日志目录失败:', error);
            return '';
        }
    }
    /**
     * 导出日志功能
     */
    static logOperations = {
        /**
         * 获取所有日志文件列表
         */
        getLogFiles: () => {
            try {
                const logDir = SysTemUtils.getLogDirectory();
                if (!logDir || !existsSync(logDir)) {
                    return [];
                }
                const files = readdirSync(logDir);
                // 过滤出日志文件（匹配 YYYY-MM-DD.log 格式）
                return files
                    .filter((file) => /^\d{4}-\d{2}-\d{2}\.log$/.test(file))
                    .map((file) => join(logDir, file))
                    .sort((a, b) => basename(b).localeCompare(basename(a))); // 按日期降序排列
            }
            catch (error) {
                console.error('获取日志文件列表失败:', error);
                return [];
            }
        },
        /**
         * 获取日志文件大小
         */
        getLogFileSizes: () => {
            const logFiles = SysTemUtils.logOperations.getLogFiles();
            return logFiles.map((filePath) => {
                try {
                    const stats = statSync(filePath);
                    const size = stats.size;
                    const sizeFormatted = SysTemUtils.logOperations.formatFileSize(size);
                    return { filePath, size, sizeFormatted };
                }
                catch (error) {
                    return { filePath, size: 0, sizeFormatted: '0 B' };
                }
            });
        },
        /**
         * 格式化文件大小
         */
        formatFileSize: (bytes) => {
            if (bytes === 0)
                return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        },
        /**
         * 导出单个日志文件
         */
        exportSingleLog: async (sourcePath, targetPath) => {
            try {
                if (!existsSync(sourcePath)) {
                    console.error('源日志文件不存在:', sourcePath);
                    return false;
                }
                // 如果没有指定目标路径，则让用户选择
                if (!targetPath) {
                    const fileName = basename(sourcePath);
                    targetPath = await SysTemUtils.dialogOperations.selectSavePath({
                        title: '导出日志文件',
                        defaultPath: fileName,
                        filters: [
                            { name: '日志文件', extensions: ['log'] },
                            { name: '所有文件', extensions: ['*'] },
                        ],
                    });
                    if (!targetPath) {
                        console.log('用户取消了日志导出');
                        return false;
                    }
                }
                // 复制文件
                copyFileSync(sourcePath, targetPath);
                console.log(`日志文件已导出至: ${targetPath}`);
                return true;
            }
            catch (error) {
                console.error('导出单个日志文件失败:', error);
                return false;
            }
        },
        /**
         * 导出所有日志文件
         */
        exportAllLogs: async (targetDir) => {
            try {
                const logFiles = SysTemUtils.logOperations.getLogFiles();
                if (logFiles.length === 0) {
                    console.log('没有找到日志文件');
                    return false;
                }
                // 如果没有指定目标目录，则让用户选择
                if (!targetDir) {
                    const selectedDir = await dialog.showOpenDialog({
                        properties: ['openDirectory'],
                        title: '选择导出目录',
                    });
                    if (selectedDir.canceled || !selectedDir.filePaths[0]) {
                        console.log('用户取消了日志导出');
                        return false;
                    }
                    targetDir = selectedDir.filePaths[0];
                }
                // 创建日志导出子目录
                const exportDir = join(targetDir, `logs_export_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Date.now()}`);
                if (!existsSync(exportDir)) {
                    mkdirSync(exportDir, { recursive: true });
                }
                // 复制所有日志文件
                let successCount = 0;
                for (const logFile of logFiles) {
                    try {
                        const fileName = basename(logFile);
                        const targetPath = join(exportDir, fileName);
                        copyFileSync(logFile, targetPath);
                        successCount++;
                    }
                    catch (error) {
                        console.error(`复制日志文件失败 ${logFile}:`, error);
                    }
                }
                console.log(`成功导出 ${successCount}/${logFiles.length} 个日志文件到: ${exportDir}`);
                return successCount > 0;
            }
            catch (error) {
                console.error('导出所有日志文件失败:', error);
                return false;
            }
        },
        /**
         * 导出最近N天的日志
         */
        exportRecentLogs: async (days, targetDir) => {
            try {
                const allLogFiles = SysTemUtils.logOperations.getLogFiles();
                const cutoffDate = new Date();
                cutoffDate.setDate(cutoffDate.getDate() - days);
                const recentLogFiles = allLogFiles.filter((filePath) => {
                    const fileName = basename(filePath);
                    const dateStr = fileName.split('.')[0]; // 移除 .log 后缀
                    const fileDate = new Date(dateStr);
                    return fileDate >= cutoffDate;
                });
                if (recentLogFiles.length === 0) {
                    console.log(`最近 ${days} 天内没有找到日志文件`);
                    return false;
                }
                // 如果没有指定目标目录，则让用户选择
                if (!targetDir) {
                    const selectedDir = await dialog.showOpenDialog({
                        properties: ['openDirectory'],
                        title: `导出最近 ${days} 天的日志`,
                    });
                    if (selectedDir.canceled || !selectedDir.filePaths[0]) {
                        console.log('用户取消了日志导出');
                        return false;
                    }
                    targetDir = selectedDir.filePaths[0];
                }
                // 创建日志导出子目录
                const exportDir = join(targetDir, `recent_logs_export_${days}_days_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Date.now()}`);
                if (!existsSync(exportDir)) {
                    mkdirSync(exportDir, { recursive: true });
                }
                // 复制最近的日志文件
                let successCount = 0;
                for (const logFile of recentLogFiles) {
                    try {
                        const fileName = basename(logFile);
                        const targetPath = join(exportDir, fileName);
                        copyFileSync(logFile, targetPath);
                        successCount++;
                    }
                    catch (error) {
                        console.error(`复制日志文件失败 ${logFile}:`, error);
                    }
                }
                console.log(`成功导出最近 ${days} 天的 ${successCount}/${recentLogFiles.length} 个日志文件到: ${exportDir}`);
                return successCount > 0;
            }
            catch (error) {
                console.error(`导出最近 ${days} 天的日志失败:`, error);
                return false;
            }
        },
        /**
         * 读取日志文件内容
         */
        readLogContent: (filePath) => {
            try {
                if (!existsSync(filePath)) {
                    return null;
                }
                return readFileSync(filePath, 'utf-8');
            }
            catch (error) {
                console.error('读取日志文件失败:', error);
                return null;
            }
        },
    };
    /**
     * 文件操作
     */
    static fileOperations = {
        /**
         * 读取文件
         * @param filePath 文件路径
         */
        readFile: (filePath) => {
            try {
                if (existsSync(filePath)) {
                    return readFileSync(filePath);
                }
                return null;
            }
            catch (error) {
                return null;
            }
        },
        /**
         * 写入文件
         * @param filePath 文件路径
         * @param data 文件内容
         */
        writeFile: (filePath, data) => {
            try {
                const dir = dirname(filePath);
                if (!existsSync(dir)) {
                    mkdirSync(dir, { recursive: true });
                }
                writeFileSync(filePath, data);
                return true;
            }
            catch (error) {
                console.error('写入文件失败！', error);
                return false;
            }
        },
        /**
         * 检查文件是否存在
         */
        exists: (filePath) => {
            return existsSync(filePath);
        },
        /**
         * 获取文件信息
         * @param filePath 文件路径
         */
        getFileInfo: (filePath) => {
            try {
                if (existsSync(filePath)) {
                    return statSync(filePath);
                }
                return null;
            }
            catch (error) {
                console.error('获取文件信息失败：', error);
                return null;
            }
        },
        /**
         * 拷贝文件
         * @param filePath 文件路径
          */
        copyFile: async (filePath) => {
            const ext = extname(filePath);
            const originName = basename(filePath, ext)?.split('_')?.[0];
            const newName = `${originName}_${dayjs().format('YYYYMMDDHHmmss')}${ext}`;
            const { canceled, filePath: savePath } = await dialog.showSaveDialog({
                title: '保存文件',
                defaultPath: join(app.getPath('desktop'), newName),
                filters: [
                    { name: 'Excel 文件', extensions: ['xlsx'] }
                ]
            });
            if (canceled || !savePath)
                return { status: 'cancelled' };
            if (!existsSync(filePath))
                throw new Error('Excel 源文件不存在');
            copyFileSync(filePath, savePath);
            log.info(savePath, '文件保存成功');
            return { status: 'saved', filePath: savePath };
        },
        /**
         * 删除文件
         * @param filePath 文件路径
         */
        deleteFile: (filePath) => {
            try {
                if (existsSync(filePath)) {
                    unlinkSync(filePath);
                }
            }
            catch (error) {
                console.error('删除文件失败：', error);
            }
        },
        /**
         * 删除文件夹
         * @param filePath 文件路径
         */
        deleteFolder: (filePath) => {
            try {
                if (existsSync(filePath)) {
                    rmSync(filePath, { recursive: true, force: true });
                }
            }
            catch (error) {
                console.error('删除文件夹失败：', error);
            }
        },
        /**
         * 拷贝文件夹
          */
        copyFolder: (source, destination) => {
            try {
                if (existsSync(source)) {
                    const entries = readdirSync(source, { withFileTypes: true });
                    if (!existsSync(destination)) {
                        mkdirSync(destination, { recursive: true });
                    }
                    for (const entry of entries) {
                        const srcPath = join(source, entry.name);
                        const destPath = join(destination, entry.name);
                        if (entry.isDirectory()) {
                            // 递归复制子目录
                            this.fileOperations.copyFolder(srcPath, destPath);
                        }
                        else {
                            // 复制文件
                            copyFileSync(srcPath, destPath);
                        }
                    }
                }
                else {
                    return false;
                }
            }
            catch (error) {
                console.error('复制文件夹失败：', error);
            }
        },
    };
    /**
     * 对话框操作
     */
    static dialogOperations = {
        /**
         * 显示消息框
         * @param message 消息内容
         * @param title 标题
         */
        showInfoDialog: async (title, message) => {
            return await dialog.showMessageBox({
                type: 'info',
                title,
                message,
                buttons: ['确定'],
            });
        },
        /**
         * 显示确认对话框
         */
        showConfirmDialog: async (title, message) => {
            const result = await dialog.showMessageBox({
                type: 'question',
                title,
                message,
                buttons: ['确定', '取消'],
                defaultId: 0, // 默认选中第一个按钮
                cancelId: 1, // 点击 ESC 或关闭按钮时，相当于点击第二个按钮
            });
            // 返回 true 表示点击了"确定"，false 表示点击了"取消"或关闭按钮
            return result.response === 0;
        },
        /**
         * 选择文件
         */
        selectFile: async (options) => {
            const defaultOptions = {
                properties: ['openFile'],
                filters: [
                    {
                        name: 'All Files',
                        extensions: ['*'],
                    },
                ],
            };
            const result = await dialog.showOpenDialog({ ...defaultOptions, ...options });
            return result.filePaths;
        },
        /**
         * 选择保存路径
         */
        selectSavePath: async (options) => {
            const result = await dialog.showSaveDialog(options || {});
            return result.filePath;
        },
    };
    /**
     * 剪贴板操作
     */
    static clipboardOperations = {
        /**
         * 写入文本到剪贴板
         */
        writeText: (text) => {
            clipboard.writeText(text);
        },
        /**
         * 从剪贴板读取文本
         */
        readText: () => {
            return clipboard.readText();
        },
        /**
         * 写入HTML到剪贴板
         */
        writeHTML: (html) => {
            clipboard.writeHTML(html);
        },
        /**
         * 从剪贴板读取HTML
         */
        readHTML: () => {
            return clipboard.readHTML();
        },
        /**
         * 写入图像到剪贴板
         */
        writeImage: (img) => {
            clipboard.writeImage(img);
        },
        /**
         * 从剪贴板读取图像
         */
        readImage: () => {
            return clipboard.readImage();
        },
    };
    /**
     * 屏幕操作
     */
    static screenOperations = {
        /**
         * 获取屏幕尺寸
         */
        getScreenSize: () => {
            const primaryDisplay = screen.getPrimaryDisplay();
            return primaryDisplay.size;
        },
        /**
         * 获取所有显示器信息
         */
        getAllDisplays: () => {
            return screen.getAllDisplays();
        },
        /**
         * 获取主显示器
         */
        getPrimaryDisplay: () => {
            return screen.getPrimaryDisplay();
        },
        /**
         * 监听显示设置变化
         */
        onDisplayChanged: (callback) => {
            screen.on('display-metrics-changed', callback);
            return () => screen.removeListener('display-metrics-changed', callback);
        },
    };
    /**
     * 电源监控
     */
    static powerOperations = {
        /**
         * 监听系统挂起
         */
        onSuspend: (callback) => {
            powerMonitor.on('suspend', callback);
            return () => powerMonitor.removeListener('suspend', callback);
        },
        /**
         * 监听系统恢复
         */
        onResume: (callback) => {
            powerMonitor.on('resume', callback);
            return () => powerMonitor.removeListener('resume', callback);
        },
        /**
         * 监听关机
         */
        onShutdown: (callback) => {
            powerMonitor.on('shutdown', callback);
            return () => powerMonitor.removeListener('shutdown', callback);
        },
        /**
         * 检查是否正在充电
         */
        isCharging: () => {
            return !powerMonitor.isOnBatteryPower();
        },
    };
    /**
     * 系统通知
     */
    static notificationOperations = {
        /**
         * 显示通知
         */
        showNotification: (options) => {
            if (Notification.isSupported()) {
                const notification = new Notification(options);
                notification.show();
                return notification;
            }
            else {
                console.warn('系统不支持通知');
                return null;
            }
        },
    };
    /**
     * 系统托盘
     */
    static trayOperations = {
        /**
         * 创建系统托盘
         */
        createTray: (iconPath, tooltip, menuItems) => {
            const tray = new Tray(iconPath);
            tray.setToolTip(tooltip);
            if (menuItems && menuItems.length > 0) {
                const contextMenu = Menu.buildFromTemplate(menuItems.map((item) => ({
                    label: item.label,
                    click: item.click,
                })));
                tray.setContextMenu(contextMenu);
            }
            return tray;
        },
    };
    /**
     * 外部链接操作
     */
    static externalOperations = {
        /**
         * 打开外部链接
         */
        openExternal: async (url) => {
            try {
                await shell.openExternal(url);
                return true;
            }
            catch (error) {
                console.error('打开外部链接失败:', error);
                return false;
            }
        },
        /**
         * 打开路径
         */
        openPath: async (path) => {
            try {
                await shell.openPath(path);
                return true;
            }
            catch (error) {
                console.error('打开路径失败:', error);
                return false;
            }
        },
        /**
         * 在文件管理器中显示文件
         */
        showItemInFolder: (fullPath) => {
            shell.showItemInFolder(fullPath);
        },
    };
    /**
     * 应用控制
     */
    static appOperations = {
        /**
         * 退出应用
         */
        quit: (win) => {
            win.close();
        },
        appQuit: () => {
            app.quit();
        },
        /**
         * 重启应用
         */
        relaunch: () => {
            app.relaunch();
            app.exit(0);
        },
        /**
         * 最小化到托盘（模拟）
         */
        minimizeToTray: (win) => {
            // 这里可以结合托盘功能实现最小化到托盘
            win.minimize();
        },
        /**
         * 最大化
         */
        maximize: (win) => {
            win.maximize();
        },
        /**
         * 还原
         */
        unmaximize: (win) => {
            win.unmaximize();
        },
    };
}

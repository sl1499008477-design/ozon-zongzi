import { ipcMain, shell } from 'electron';
import { SysTemUtils } from '../utils/system.js';
import { UpdaterManager } from '../services/update.services.js';
import { checkNetworkStatus } from '../utils/index.js';
import { getConfig } from '../config/index.js';
import { isTrustedExternalUrl, runtimeConfig } from '../config/runtime.js';
export const windowIpc = (win) => {
    ipcMain.on('window', async (event, data) => {
        switch (data) {
            case 'hide':
                SysTemUtils.appOperations.minimizeToTray(win);
                break;
            case 'close':
                SysTemUtils.appOperations.quit(win);
                break;
            case 'maximize':
                SysTemUtils.appOperations.maximize(win);
                break;
            default:
                SysTemUtils.appOperations.unmaximize(win);
                break;
        }
    });
    ipcMain.on('app-quit', (event, data) => {
        SysTemUtils.appOperations.appQuit();
    });
    ipcMain.handle('app', (event, data) => {
        return SysTemUtils.getAppInfo();
    });
    ipcMain.handle('export-all-logs', async () => {
        return await SysTemUtils.logOperations.exportAllLogs();
    });
    ipcMain.on('check-update-app', async () => {
        UpdaterManager.getInstance().checkUpdate();
    });
    ipcMain.on('start-update-app', async () => {
        UpdaterManager.getInstance().startDownload();
    });
    ipcMain.on('start-downloaded-app', async () => {
        UpdaterManager.getInstance().checkForUpdatesAndNotify();
    });
    ipcMain.on('quit-and-install-app', async () => {
        UpdaterManager.getInstance().quitAndInstall();
    });
    const openUrl = async (_event, data) => {
        if (!isTrustedExternalUrl(data, runtimeConfig)) {
            return { code: 403, message: '已拦截不受信任的外部链接' };
        }
        try {
            await shell.openExternal(String(data));
            return { code: 200 };
        }
        catch {
            return { code: 500, message: '浏览器打开失败，请稍后重试' };
        }
    };
    ipcMain.handle('open-url', openUrl);
    ipcMain.on('open-url', async (event, data) => {
        const result = await openUrl(event, data);
        if (result.code !== 200)
            win.webContents.send('window-notify', { type: 'account', message: result.message });
    });
    ipcMain.handle('get-config', async () => {
        return await getConfig();
    });
    ipcMain.handle('check-network', async () => {
        return checkNetworkStatus();
    });
};

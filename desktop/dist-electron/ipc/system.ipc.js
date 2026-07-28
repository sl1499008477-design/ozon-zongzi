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
    ipcMain.on('open-url', async (event, data) => {
        if (!isTrustedExternalUrl(data, runtimeConfig)) {
            win.webContents.send('window-notify', { type: 'account', message: '已拦截不受信任的外部链接' });
            return;
        }
        await shell.openExternal(String(data));
    });
    ipcMain.handle('get-config', async () => {
        return await getConfig();
    });
    ipcMain.handle('check-network', async () => {
        return checkNetworkStatus();
    });
};

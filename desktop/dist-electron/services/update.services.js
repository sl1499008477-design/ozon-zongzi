import pkg from 'electron-updater';
import log from '../log/index.js';
import { operationStore } from '../store/index.js';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { runtimeConfig } from '../config/runtime.js';
const { autoUpdater } = pkg;
export class UpdaterManager {
    static instance = null;
    win = null;
    isInit = false;
    constructor() { }
    static getInstance() {
        if (!UpdaterManager.instance) {
            UpdaterManager.instance = new UpdaterManager();
        }
        return UpdaterManager.instance;
    }
    setMainWindow(win) {
        this.win = win;
    }
    // 通知渲染层
    send(channel, payload) {
        if (this.win && !this.win.isDestroyed())
            this.win.webContents.send(channel, payload);
    }
    // 注册IPC通道
    registerEvents() {
        autoUpdater.on('checking-for-update', () => {
            log.info('检测版本是否为最新');
            this.send('update-checking');
        });
        autoUpdater.on('update-available', (info) => {
            log.info(info, '检测到新版本');
            const updateInfo = operationStore.get('update-info');
            const updateStatus = operationStore.get('update-status');
            if (updateInfo?.version !== info.version) {
                operationStore.set('update-info', {
                    version: info.version,
                    date: info.releaseDate,
                    size: info.files[0].size,
                });
                operationStore.set('clear-update', false);
                operationStore.set('update-status', 'hasUpdate');
            }
            if (updateStatus !== 'downloaded')
                operationStore.set('update-status', 'hasUpdate');
            this.send('update-available', {
                version: info.version,
                date: info.releaseDate,
                size: info.files[0].size,
            });
        });
        autoUpdater.on('update-not-available', () => {
            log.info('当前为最新版本');
            operationStore.set('update-status', 'hasNew');
            this.send('update-not-available');
            const isClearUpdate = operationStore.get('clear-update');
            if (!isClearUpdate)
                try {
                    operationStore.set('clear-update', true);
                    const updaterDir = path.join(app.getPath('cache'), `${app.getName()}-updater`);
                    log.info('下载目录:', updaterDir);
                    if (fs.existsSync(updaterDir)) {
                        fs.rmSync(updaterDir, { recursive: true, force: true });
                        log.info('updater 缓存已清理', updaterDir);
                    }
                }
                catch (e) {
                    operationStore.set('clear-update', false);
                    log.warn('清理 updater 缓存失败', e);
                }
        });
        autoUpdater.on('download-progress', (progress) => {
            operationStore.set('update-status', 'download');
            this.send('update-download-progress', {
                percent: Math.floor(progress.percent),
                speed: (progress.bytesPerSecond / 1024 / 1024).toFixed(1), // MB/s
                downloaded: (progress.transferred / 1024 / 1024).toFixed(1),
                total: (progress.total / 1024 / 1024).toFixed(1),
            });
        });
        autoUpdater.on('update-downloaded', () => {
            operationStore.set('update-status', 'downloaded');
            log.info('更新下载完成');
            this.send('update-downloaded');
        });
        autoUpdater.on('error', (error) => {
            log.error('更新错误', error);
            operationStore.set('update-status', 'hasUpdate');
            this.send('update-error', error);
        });
    }
    /**
     * 检测是否已经下载完成
     */
    checkForUpdatesAndNotify() {
        if (!runtimeConfig.updateUrl) {
            this.send('update-not-available');
            return Promise.resolve(null);
        }
        return autoUpdater.checkForUpdatesAndNotify();
    }
    /**
     * 手动触发检测更新
     */
    checkUpdate() {
        log.info('开始检测更新');
        if (!runtimeConfig.updateUrl) {
            operationStore.set('update-status', 'hasNew');
            this.send('update-not-available');
            return Promise.resolve(null);
        }
        return autoUpdater.checkForUpdates();
    }
    /**
     * 开始更新
     */
    startDownload() {
        if (!runtimeConfig.updateUrl)
            return Promise.resolve(null);
        autoUpdater.downloadUpdate();
    }
    /**
     * 安装并重启
     */
    async quitAndInstall() {
        log.info('安装并重启');
        try {
            await autoUpdater.downloadUpdate();
            autoUpdater.quitAndInstall();
        }
        catch (error) {
            operationStore.set('update-status', 'hasUpdate');
            log.error(error);
        }
    }
    /**
     * 初始化
     */
    async init() {
        if (this.isInit)
            return;
        this.isInit = true;
        autoUpdater.autoDownload = false;
        autoUpdater.allowDowngrade = false;
        autoUpdater.autoInstallOnAppQuit = false;
        if (runtimeConfig.updateUrl) {
            autoUpdater.setFeedURL({ provider: 'generic', url: runtimeConfig.updateUrl });
        }
        this.registerEvents();
    }
}

// electron/utils/broadcast-ipc.ts
import { ipcMain } from 'electron';
import { EventEmitter } from 'events';
export class GlobalBroadcastIPC {
    static instance;
    windows = new Set();
    emitter = new EventEmitter();
    constructor() { }
    static getInstance() {
        if (!GlobalBroadcastIPC.instance) {
            GlobalBroadcastIPC.instance = new GlobalBroadcastIPC();
        }
        return GlobalBroadcastIPC.instance;
    }
    // 注册窗口
    registerWindow(window) {
        this.windows.add(window);
        // 窗口关闭时自动移除
        window.on('closed', () => {
            this.windows.delete(window);
        });
    }
    // 移除窗口
    unregisterWindow(window) {
        this.windows.delete(window);
    }
    // 广播消息给所有窗口
    broadcast(channel, ...args) {
        for (const window of this.windows) {
            if (!window.isDestroyed()) {
                window.webContents.send(channel, ...args);
            }
        }
    }
    // 发送给指定窗口类型（如 'main', 'settings' 等）
    broadcastToType(windowType, channel, ...args) {
        for (const window of this.windows) {
            if (!window.isDestroyed() && window.windowType === windowType) {
                window.webContents.send(channel, ...args);
            }
        }
    }
    // 发送给除了指定窗口外的所有窗口
    broadcastExcept(exceptWindow, channel, ...args) {
        for (const window of this.windows) {
            if (window !== exceptWindow && !window.isDestroyed()) {
                window.webContents.send(channel, ...args);
            }
        }
    }
    // 监听来自渲染进程的消息并转发给所有窗口
    listen(channel, callback) {
        ipcMain.removeAllListeners(channel);
        ipcMain.on(channel, (event, ...args) => {
            // 转发给所有其他窗口
            for (const window of this.windows) {
                if (window.webContents !== event.sender && !window.isDestroyed()) {
                    window.webContents.send(channel, ...args);
                }
            }
            // 执行自定义回调
            if (callback) {
                callback(event, ...args);
            }
        });
    }
    // 移除监听器
    removeListener(channel) {
        ipcMain.removeAllListeners(channel);
    }
    // 获取窗口数量
    getWindowCount() {
        return this.windows.size;
    }
    // 获取所有窗口
    getWindows() {
        return Array.from(this.windows);
    }
}
export const globalBroadcast = GlobalBroadcastIPC.getInstance();

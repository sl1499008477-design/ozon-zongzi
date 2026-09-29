import { ipcMain } from 'electron';
import { operationStore } from '../store/index.js';

const RENDERER_STORE_KEYS = new Set([
    'loginInfo',
    'token',
    'user',
    'update-status',
    'update-info',
]);

function assertAllowedKey(key, write = false) {
    key = String(key);
    if (write && ['user', 'token'].includes(key))
        throw new Error('登录身份只能通过登录流程更新');
    if (!RENDERER_STORE_KEYS.has(String(key)))
        throw new Error('不允许访问该本地配置项');
    return String(key);
}

export const storeIpc = () => {
    ipcMain.handle('store-get', (_, key) => operationStore.get(assertAllowedKey(key)));
    ipcMain.handle('store-set', (_, key, value) => operationStore.set(assertAllowedKey(key, true), value));
    ipcMain.handle('store-delete', (_, key) => operationStore.delete(assertAllowedKey(key, true)));
};

import axios from 'axios';
import { clearCollectorAuthorization } from './sonli-api.services.js';
import { shell, clipboard } from 'electron';
import { operationStore } from '../store/index.js';
import { TaskManager } from './collection/task-manager.services.js';
import { runtimeConfig } from '../config/runtime.js';
import { clearAccountSessions } from './session.services.js';
import { destroySellerWindow } from './seller-ozon.services.js';
import { enrichmentWorker } from './enrichment.services.js';

const sonliClient = axios.create({
    baseURL: runtimeConfig.sonliApiBase,
    timeout: 15000,
});

function errorMessage(error, fallback = '登录失败') {
    return String(
        error?.response?.data?.message
        || error?.response?.data?.error
        || error?.message
        || error
        || fallback,
    );
}

function mapSonliAccount(account = {}) {
    return {
        ...account,
        _id: String(account.id || account._id || ''),
        name: account.displayName || account.name || account.username || 'sonli 用户',
        phone: account.username || account.phone || '',
    };
}

async function revokeSonliToken(token) {
    if (!token)
        return;
    await sonliClient.post('/local/accounts/logout', {}, {
        headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
}

export const accountHandle = async (_type, mainWindow) => {
    const target = `${runtimeConfig.sonliWebBase}/ozon/dashboard/`;
    try {
        await shell.openExternal(target);
    }
    catch {
        clipboard.writeText(target);
        mainWindow.webContents.send('window-notify', {
            type: 'account',
            message: '账号由 sonli 管理员统一分配；管理后台地址已复制到剪贴板。',
        });
    }
};

export const login = async (data) => {
    await enrichmentWorker.stop();
    clearCollectorAuthorization();
    try {
        const username = String(data.phone || data.username || '').trim();
        const password = String(data.pwd || data.password || '');
        const response = await sonliClient.post('/local/accounts/login?view=bootstrap', { username, password });
        const sonliToken = String(response.data?.token || '');
        if (!sonliToken || !response.data?.account)
            throw new Error('sonli 登录响应缺少账号或令牌');
        const user = mapSonliAccount(response.data.account);
        operationStore.set('token', sonliToken);
        operationStore.set('user', user);
        enrichmentWorker.start();
        return {
            code: 0,
            message: '登录成功',
            data: {
                token: sonliToken,
                user,
                collectionReady: true,
            },
        };
    }
    catch (error) {
        clearCollectorAuthorization();
        operationStore.delete('token');
        operationStore.delete('user');
        return {
            code: Number(error?.response?.status || 400),
            message: errorMessage(error),
            data: null,
        };
    }
};

export const getUserInfo = async () => {
    const token = String(operationStore.get('token') || '');
    const sessionChanged = () => token !== String(operationStore.get('token') || '');
    try {
        if (!token)
            throw new Error('登录已过期');
        const response = await sonliClient.get('/local/state?view=bootstrap', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.data?.account)
            throw new Error('登录已过期');
        if (sessionChanged()) return { code: 401, message: '登录账号已切换，请重试', data: null };
        const user = mapSonliAccount(response.data.account);
        operationStore.set('user', user);
        return { code: 0, message: '获取成功', data: user };
    }
    catch (error) {
        if (sessionChanged()) return { code: 401, message: '登录账号已切换，请重试', data: null };
        clearCollectorAuthorization();
        operationStore.delete('token');
        operationStore.delete('user');
        return { code: 401, message: errorMessage(error, '登录已过期'), data: null };
    }
};

export const logout = async () => {
    await enrichmentWorker.stop();
    clearCollectorAuthorization();
    const sonliToken = String(operationStore.get('token') || '');
    const user = operationStore.get('user') || {};
    const accountKey = String(user._id || user.id || user.phone || 'anonymous');
    try {
        const taskInExecution = TaskManager.getInstance()
            .getAllTasksList()
            .some((item) => item.taskStatus !== 'noExecuted');
        if (taskInExecution)
            await TaskManager.getInstance().stopAllTasks();

        destroySellerWindow();
        await revokeSonliToken(sonliToken);
        await clearAccountSessions(accountKey);
        return { code: 0, message: '退出成功', data: null };
    }
    finally {
        operationStore.delete('user');
        clearCollectorAuthorization();
        operationStore.delete('token');
    }
};

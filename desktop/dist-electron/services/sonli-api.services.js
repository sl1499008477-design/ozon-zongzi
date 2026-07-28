import axios from 'axios';
import { operationStore } from '../store/index.js';
import { runtimeConfig } from '../config/runtime.js';
import { globalBroadcast } from '../ipc/broadcast.js';
import log from '../log/index.js';

const api = axios.create({
    baseURL: runtimeConfig.sonliApiBase,
    timeout: 30000,
    maxRedirects: 0,
});

function authToken() {
    return String(operationStore.get('token') || '');
}

function assertNativePath(value) {
    const path = String(value || '');
    if (!path.startsWith('/'))
        throw new Error('Sonli API 路径必须以 / 开头');
    if (path.startsWith('/api/'))
        throw new Error('已禁止调用旧采集服务 API');
    return path;
}

function toApiError(error) {
    const payload = error?.response?.data || {};
    const wrapped = new Error(String(
        payload.message
        || payload.error
        || error?.message
        || 'Sonli 服务请求失败',
    ));
    wrapped.status = Number(error?.response?.status || 0);
    wrapped.code = payload.code || error?.code || 'SONLI_REQUEST_FAILED';
    wrapped.payload = payload;
    wrapped.retryable = !wrapped.status
        || wrapped.status === 408
        || wrapped.status === 429
        || wrapped.status >= 500;
    return wrapped;
}

api.interceptors.request.use((config) => {
    config.url = assertNativePath(config.url);
    const token = authToken();
    config.headers = config.headers || {};
    config.headers.Accept = 'application/json';
    config.headers['X-Sonli-Client'] = 'collector-desktop';
    if (token)
        config.headers.Authorization = `Bearer ${token}`;
    return config;
});

api.interceptors.response.use(
    (response) => response,
    (error) => {
        const wrapped = toApiError(error);
        log.error(`Sonli API ${error?.config?.method || 'request'} ${error?.config?.url || ''}: ${wrapped.message}`);
        if (wrapped.status === 401 || wrapped.status === 403) {
            globalBroadcast.broadcast('request', {
                code: wrapped.status,
                message: wrapped.status === 401 ? 'sonli 登录已失效' : wrapped.message,
            });
        }
        if (!wrapped.status && ['ENOTFOUND', 'ERR_NETWORK', 'ECONNREFUSED'].includes(String(error?.code))) {
            globalBroadcast.broadcast('network-error', {
                code: error.code,
                message: '无法连接 sonli 服务',
            });
        }
        return Promise.reject(wrapped);
    },
);

export async function sonliRequest(config) {
    const response = await api.request({
        ...config,
        url: assertNativePath(config.url),
    });
    return response.data;
}

export function getSonliToken() {
    return authToken();
}

export function getSonliApiBase() {
    return runtimeConfig.sonliApiBase;
}

export { toApiError };

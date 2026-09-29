import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { createCollectorAuthorization } from './collector-authorization.core.js';
import { operationStore } from '../store/index.js';
import { runtimeConfig } from '../config/runtime.js';
import { globalBroadcast } from '../ipc/broadcast.js';
import log from '../log/index.js';
import { withCollectorRequest } from './collector-network.core.js';

const api = axios.create({
    baseURL: runtimeConfig.sonliApiBase,
    timeout: 30000,
    maxRedirects: 0,
});

function authToken() {
    return String(operationStore.get('token') || '');
}

const authorizationApi = axios.create({ baseURL: runtimeConfig.sonliApiBase, timeout: 15000, maxRedirects: 0 });
const collectorAuthorization = createCollectorAuthorization({
    getParentToken: authToken,
    getDeviceId: () => {
        let id = operationStore.get('desktop-device-id');
        if (!id) operationStore.set('desktop-device-id', id = `desktop_${randomUUID()}`);
        return id;
    },
    request: async (config) => {
        try { return (await authorizationApi.request(config)).data; }
        catch (error) { throw toApiError(error); }
    },
});
export const clearCollectorAuthorization = () => collectorAuthorization.clear();
export const getCollectorAuthorization = () => collectorAuthorization.get();

function assertNativePath(value) {
    const path = String(value || '');
    if (!path.startsWith('/') || path.startsWith('//'))
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
    wrapped.status = Number(error?.response?.status || error?.status || 0);
    wrapped.code = payload.code || error?.code || 'SONLI_REQUEST_FAILED';
    wrapped.payload = payload;
    wrapped.retryable = !wrapped.status
        || wrapped.status === 408
        || wrapped.status === 429
        || wrapped.status >= 500;
    return wrapped;
}

api.interceptors.request.use(async (config) => {
    config.url = assertNativePath(config.url);
    const token = authToken();
    config.headers = config.headers || {};
    config.headers.Accept = 'application/json';
    config.headers['X-Sonli-Client'] = 'collector-desktop';
    if (config.expectedParentToken && config.expectedParentToken !== token)
        throw Object.assign(new Error('登录账号已变化'), { code: 'ACCOUNT_CHANGED' });
    if (config.url.startsWith('/collector/')) {
        const collectorToken = config.collectorToken || await collectorAuthorization.get();
        if (config.expectedParentToken && config.expectedParentToken !== authToken())
            throw Object.assign(new Error('登录账号已变化'), { code: 'ACCOUNT_CHANGED' });
        config.headers.Authorization = `Collector ${collectorToken}`;
    }
    else if (config.url.startsWith('/local/') || config.url.startsWith('/ai-listing/')) {
        if (token) config.headers.Authorization = `Bearer ${token}`;
    }
    else throw new Error('未声明认证类型的 Sonli API 路径');
    return config;
});

api.interceptors.response.use(
    (response) => response,
    (error) => {
        const wrapped = toApiError(error);
        if (error?.config?.expectedParentToken && error.config.expectedParentToken !== authToken())
            return Promise.reject(Object.assign(wrapped, { code: 'ACCOUNT_CHANGED' }));
        if (error?.config?.quiet) {
            if (wrapped.status === 401) collectorAuthorization.clear();
            return Promise.reject(wrapped);
        }
        log.error(`Sonli API ${error?.config?.method || 'request'} ${error?.config?.url || ''}: ${wrapped.message}`);
        if (wrapped.status === 401 && String(error?.config?.url || '').startsWith('/collector/'))
            collectorAuthorization.clear(); // Invalidate only; never replay a possibly mutating request.
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
    const response = await withCollectorRequest(() => api.request({
        ...config,
        url: assertNativePath(config.url),
    }), { signal: config.signal, kind: /^\/collector\/runs\/[^/]+\/(?:heartbeat|cancel(?:-request)?|complete|fail)$/.test(config.url) ? 'control' : 'read' });
    return response.data;
}

export function getSonliToken() {
    return authToken();
}

export function getSonliApiBase() {
    return runtimeConfig.sonliApiBase;
}

export { toApiError };

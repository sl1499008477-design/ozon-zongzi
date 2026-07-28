import { createHash } from 'node:crypto';
import { session } from 'electron';
import { operationStore } from '../store/index.js';

function accountKey() {
    const user = operationStore.get('user') || {};
    return String(user._id || user.id || user.phone || 'anonymous');
}

const SESSION_SCOPES = new Set(['ozon', 'seller', '1688']);

function normalizeScope(scope) {
    const value = String(scope || 'ozon').toLowerCase();
    if (!SESSION_SCOPES.has(value))
        throw new Error(`不支持的会话分区：${value}`);
    return value;
}

export function getAccountPartition(scope = 'ozon', explicitAccountKey = '') {
    const key = String(explicitAccountKey || accountKey());
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 20);
    return `persist:sonli-${digest}-${normalizeScope(scope)}`;
}

export async function clearAccountSessions(explicitAccountKey = '') {
    await Promise.all([...SESSION_SCOPES].map(async (scope) => {
        const accountSession = session.fromPartition(getAccountPartition(scope, explicitAccountKey));
        await accountSession.clearStorageData({
            storages: [
                'cookies',
                'localstorage',
                'indexdb',
                'serviceworkers',
                'cachestorage',
            ],
        });
        await accountSession.clearCache();
    }));
}

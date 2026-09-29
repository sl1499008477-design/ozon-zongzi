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

// The same preference used by Ozon's language/currency dialog. The displayed CNY
// amount is Ozon's reference conversion; Seller Analytics keeps its RUB figures.
export async function ensureOzonCny(webContents) {
    const result = await webContents.executeJavaScript(`
        (async () => {
            const response = await fetch('/api/composer-api.bx/_action/changeCurrency', {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ currency_code: 'CNY' }),
                signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) return { ok: false, status: response.status };
            const payload = await response.json();
            return { ok: payload?.result === 'OK', status: response.status };
        })()
    `);
    if (!result?.ok) {
        throw Object.assign(new Error('Ozon 人民币显示设置失败；本次价格将按页面实际币种记录，请在网页货币设置中选择人民币'), {
            code: 'ZONGZI_CURRENCY_SETUP_FAILED', status: result?.status || 0,
        });
    }
    await webContents.session.cookies.flushStore();
    return 'CNY';
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

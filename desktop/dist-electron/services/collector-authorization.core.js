// Collector credentials are scoped to the currently authenticated Web session.
// Keep them in memory; each process restart uses the official one-time exchange.
export function createCollectorAuthorization({ request, getParentToken, getDeviceId, clock = Date.now }) {
    let cached = null;
    let pending = null;
    let generation = 0;
    function clear() {
        generation += 1;
        cached = null;
        pending = null;
    }
    async function get() {
        const parent = String(getParentToken() || '');
        if (!parent) {
            clear();
            throw new Error('sonli 登录已失效');
        }
        if (cached?.parent === parent && cached.expiresAt > clock() + 30000)
            return cached.token;
        if (pending?.parent === parent)
            return pending.promise;
        const currentGeneration = ++generation;
        cached = null;
        const promise = (async () => {
            const issued = await request({ method: 'post', url: '/extension/collector-auth/ticket', headers: { Authorization: `Bearer ${parent}` }, data: {} });
            const exchanged = await request({ method: 'post', url: '/extension/collector-auth/exchange', data: { ticket: issued.ticket, deviceFingerprint: getDeviceId() } });
            if (String(getParentToken() || '') !== parent || currentGeneration !== generation)
                throw new Error('账号登录已切换，请重试当前操作');
            const token = String(exchanged.collectorToken || '');
            const expiresAt = Date.parse(exchanged.expiresAt);
            if (!token || !Number.isFinite(expiresAt) || expiresAt <= clock())
                throw new Error('Collector 授权响应无效');
            cached = { parent, token, expiresAt };
            return token;
        })();
        pending = { parent, promise };
        try { return await promise; }
        finally { if (pending?.promise === promise) pending = null; }
    }
    return { get, clear };
}

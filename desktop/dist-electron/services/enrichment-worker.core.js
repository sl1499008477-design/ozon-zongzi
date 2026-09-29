const BASE = '/collector/ozon/enrichment-jobs';
const LOGIN_CODES = new Set(['SELLER_LOGIN_REQUIRED', 'SELLER_ACCOUNT_REQUIRED', 'SELLER_CONTEXT_REQUIRED']);
const FAIL_CODES = new Set(['SELLER_CONTEXT_REQUIRED', 'SELLER_CONTEXT_CHANGED', 'ZONGZI_ENRICH_NOT_FOUND', 'ZONGZI_ENRICH_INCOMPLETE', 'ZONGZI_ENRICH_BUSY', 'ZONGZI_ENRICH_UPSTREAM_FAILED', 'ZONGZI_ENRICH_BUNDLE_UNCERTAIN']);

// Publish the cause, never the request/config object which can contain credentials.
const errorDetail = error => [error?.message, error?.code ? `错误代码：${error.code}` : '',
    error?.status ? `HTTP ${error.status}` : ''].filter(Boolean).join('；');

// One desktop executor uses the server's existing queue/lease/fence. It does not
// own a second queue or alter the selected AI listing configuration.
export function createEnrichmentWorker({ getIdentity, openSession, verifySeller, capture, releaseSeller = () => {}, notify = () => {}, clock = Date.now, heartbeatMs = 8000, idleMs = 10000, retryMs = 30000 }) {
    let active = null, controller = null, timer = null, enabled = false, nextAt = 0, revision = 0;
    let owner = '', loginBlocked = false, activeTask = null;
    let controlSequence = 0;
    const taskControls = new Map();
    let status = { phase: 'idle', message: '商品资料自动补全已就绪', sku: '', completed: 0, errorKind: '', errorDetail: '' };
    const publish = patch => {
        status = { ...status, ...patch };
        if (!['error', 'needs_login'].includes(status.phase)) status.errorDetail = '';
        notify({ ...status });
    };
    const identityKey = identity => `${identity?.accountId || ''}:${identity?.parentToken || ''}`;
    async function run() {
        const identity = getIdentity();
        const key = identityKey(identity);
        if (key !== owner) { owner = key; taskControls.clear(); loginBlocked = false; status = { phase: 'idle', message: '商品资料自动补全已就绪', sku: '', completed: 0, errorKind: '', errorDetail: '' }; notify({ ...status }); }
        if (!identity?.accountId || !identity?.parentToken) { publish({ phase: 'signed_out', sku: '', completed: 0, errorKind: '' }); return; }
        if (loginBlocked) return;
        controller = new AbortController();
        const { signal } = controller;
        const assertCurrent = () => {
            signal.throwIfAborted();
            if (identityKey(getIdentity()) !== key) throw Object.assign(new Error('登录账号已变化'), { code: 'ACCOUNT_CHANGED' });
        };
        let post, job, captureContext, heartbeat, beat = null, resultSent = false;
        try {
            post = await openSession(identity, signal);
            assertCurrent();
            const available = await post(`${BASE}/available`, {});
            assertCurrent();
            if (!available.available) {
                if (status.phase === 'working' || (!status.sku && ['error', 'needs_login'].includes(status.phase)))
                    publish({ phase: 'idle', message: '当前没有待补全资料，服务连接正常', sku: '', errorKind: '' });
                return;
            }
            const verification = await verifySeller(identity, signal);
            assertCurrent();
            captureContext = { sellerCompanyId: String(verification.sellerCompanyId), revision: revision = Math.max(revision + 1, clock()), observedAt: new Date(clock()).toISOString() };
            const claimSequence = controlSequence;
            ({ job } = await post(`${BASE}/next`, { captureContext }));
            assertCurrent();
            if (!job) {
                if (!status.sku && ['error', 'needs_login'].includes(status.phase))
                    publish({ phase: 'idle', message: '当前没有待补全资料，服务连接正常', sku: '', errorKind: '' });
                return;
            }
            const control = taskControls.get(`${key}:${job.taskKey}`);
            if (control && control.sequence > claimSequence) {
                // A claim reply may arrive after pause/cancel (or pause + resume).
                // Its fence predates the control; it must not start a Seller write.
                // Fresh claims are authorized by the server, including resumes on
                // another device or a resume whose successful reply was lost.
                publish({ phase: 'idle', sku: '', taskKey: '', errorKind: '', message: control.state === 'PAUSED'
                    ? '该批次已暂停，其他任务继续处理' : control.state === 'CANCELLED'
                        ? '该批次已取消补全，已采集资料保留' : '任务状态已更新，等待重新领取补全任务' });
                nextAt = 0;
                return;
            }
            activeTask = { key: job.taskKey || '', identity: key };
            publish({ phase: 'working', sku: job.sku, taskKey: job.taskKey || '', message: `正在补全 SKU ${job.sku} 的类目、包装和属性`, errorKind: '' });
            const envelope = { captureContext, claimFence: job.claimFence };
            const renew = () => {
                if (beat) return;
                beat = (async () => {
                    assertCurrent();
                    await verifySeller(identity, signal, verification);
                    assertCurrent();
                    await post(`${BASE}/${encodeURIComponent(job.id)}/progress`, envelope);
                })().catch(error => controller?.abort(error)).finally(() => { beat = null; });
            };
            heartbeat = setInterval(renew, heartbeatMs);
            const variantData = await capture(job, verification, signal);
            clearInterval(heartbeat); heartbeat = null;
            await beat;
            assertCurrent();
            await verifySeller(identity, signal, verification);
            assertCurrent();
            resultSent = true;
            await post(`${BASE}/${encodeURIComponent(job.id)}/result`, { ...envelope, variantData });
            assertCurrent();
            publish({ phase: 'idle', sku: '', taskKey: '', completed: status.completed + 1, message: `已补全 ${status.completed + 1} 个 SKU，AI 任务将按原配置继续`, errorKind: '' });
            nextAt = clock() + 500;
        } catch (error) {
            clearInterval(heartbeat); heartbeat = null;
            await beat;
            if (identityKey(getIdentity()) !== key) return;
            if (signal.aborted) {
                if (['ENRICHMENT_TASK_PAUSED', 'ENRICHMENT_TASK_CANCELLED'].includes(signal.reason?.code)) {
                    publish({ phase: 'idle', sku: '', taskKey: '', errorKind: '', message: signal.reason.message });
                    nextAt = 0;
                    return;
                }
                publish({ phase: 'error', message: '本次补全已中断，资料会保留并在后续恢复', sku: '', errorKind: '', errorDetail: errorDetail(signal.reason || error) });
                nextAt = clock() + retryMs;
                return;
            }
            const needsLogin = LOGIN_CODES.has(error?.code);
            if (needsLogin) loginBlocked = true;
            const code = String(error?.code || '');
            const httpStatus = Number(error?.status || 0);
            const productError = Boolean(job?.sku) && (code.startsWith('ZONGZI_ENRICH_') || code === 'ZONGZI_PRODUCT_RUSSIAN_REQUIRED');
            const sellerError = needsLogin || code.startsWith('SELLER_');
            const authError = !sellerError && !productError && [401, 403].includes(httpStatus);
            const serviceError = !sellerError && !productError && !authError
                && (httpStatus >= 500 || [408, 429].includes(httpStatus) || ['ENOTFOUND', 'ERR_NETWORK', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(code));
            publish({ phase: needsLogin ? 'needs_login' : 'error', sku: job?.sku || '',
                errorKind: sellerError ? 'seller' : productError ? 'product' : authError ? 'auth' : serviceError ? 'service' : '',
                errorDetail: errorDetail(error),
                message: needsLogin ? '需要在采集助手内登录 Seller，完成后点击继续补全'
                    : sellerError || productError ? error.message
                    : authError ? (httpStatus === 401 ? '采集助手登录已失效，请退出后重新登录助手' : '当前助手账号无资料补全权限，请确认账号权限后点击重新检查')
                    : serviceError ? `资料补全服务暂不可用${httpStatus ? `（HTTP ${httpStatus}）` : ''}，请检查网络连接，稍后会自动检查`
                    : '资料补全暂未完成，稍后自动重试；可在采集箱查看详情' });
            // A result reply can be lost after server commit. Never overwrite it
            // with a failure; the next round/cache handles safe redelivery.
            if (job && !resultSent) {
                const code = needsLogin ? 'SELLER_CONTEXT_REQUIRED' : FAIL_CODES.has(error?.code) ? error.code : 'ZONGZI_ENRICH_UPSTREAM_FAILED';
                await post(`${BASE}/${encodeURIComponent(job.id)}/fail`, { captureContext, claimFence: job.claimFence, code,
                    message: needsLogin ? '请在采集助手内登录 Seller 后继续补全' : status.message }).catch(() => {});
            }
            nextAt = clock() + retryMs;
        } finally { clearInterval(heartbeat); releaseSeller(); controller = null; activeTask = null; }
    }
    async function taskRequest(path, body) {
        const identity = getIdentity(), key = identityKey(identity);
        if (!identity?.accountId || !identity?.parentToken)
            throw Object.assign(new Error('请先登录采集助手'), { code: 'COLLECTOR_AUTH_REQUIRED', status: 401 });
        // Management requests must survive aborting the separate capture request.
        const signal = new AbortController().signal;
        const post = await openSession(identity, signal);
        if (identityKey(getIdentity()) !== key) throw Object.assign(new Error('登录账号已变化'), { code: 'ACCOUNT_CHANGED', status: 409 });
        const result = await post(`${BASE}/${path}`, body);
        if (identityKey(getIdentity()) !== key) throw Object.assign(new Error('登录账号已变化'), { code: 'ACCOUNT_CHANGED', status: 409 });
        return { result, key };
    }
    async function listTasks() {
        const { result } = await taskRequest('tasks', {});
        if (!Array.isArray(result?.tasks)) throw new Error('资料补全任务列表返回格式异常，请刷新重试');
        return result.tasks;
    }
    async function controlTask({ taskKey, action } = {}) {
        if (!taskKey || !['pause', 'resume', 'cancel'].includes(action))
            throw Object.assign(new Error('请选择补全任务和有效操作'), { status: 400 });
        const { result, key } = await taskRequest('tasks/control', { taskKey, action });
        if (!result?.task || result.task.key !== taskKey) throw new Error('未收到补全操作确认，请刷新后核对');
        taskControls.set(`${key}:${taskKey}`, { state: result.task.controlState, sequence: ++controlSequence });
        if (action !== 'resume' && activeTask?.key === taskKey && activeTask.identity === key) {
            const cancelled = action === 'cancel';
            controller?.abort(Object.assign(new Error(cancelled
                ? '该任务的资料补全已取消，已采集资料保留，其他任务继续处理'
                : '该任务的资料补全已暂停，其他任务继续处理'),
            { code: cancelled ? 'ENRICHMENT_TASK_CANCELLED' : 'ENRICHMENT_TASK_PAUSED' }));
        }
        nextAt = 0;
        start();
        return result.task;
    }
    function runOnce() {
        if (active) return active;
        active = run().finally(() => { active = null; });
        return active;
    }
    function start() {
        if (enabled) return;
        enabled = true;
        timer = setInterval(() => {
            if (clock() < nextAt || active) return;
            nextAt = clock() + idleMs;
            void runOnce();
        }, 1000);
        timer.unref?.();
        nextAt = 0;
    }
    async function stop() {
        enabled = false; clearInterval(timer); timer = null;
        controller?.abort(); await active;
        publish({ phase: 'signed_out', sku: '', taskKey: '', completed: 0, errorKind: '' });
    }
    return { start, stop, runOnce, listTasks, controlTask, isBusy: () => Boolean(active), getStatus: () => ({ ...status }),
        resume() { loginBlocked = false; nextAt = 0; start(); return runOnce(); } };
}

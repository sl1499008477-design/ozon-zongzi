import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnrichmentWorker } from '../dist-electron/services/enrichment-worker.core.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const group = (key, extra = {}) => ({ key, name: key === 'run:a' ? '照明类目' : '家居类目',
    taskId: `task-${key}`, runId: key.slice(4), createdAt: '2026-09-16T10:00:00Z', controlState: 'ACTIVE',
    total: 2, pending: 1, processing: 1, completed: 0, failed: 0, currentSkus: ['100'], errorMessage: '', ...extra });

function fixture({ rejectControl = false } = {}) {
    let identity = { accountId: 'account-a', parentToken: 'parent-a' }, jobCount = 0, finish;
    const tasks = [group('run:a'), group('run:b')], calls = [], signals = [];
    const worker = createEnrichmentWorker({
        getIdentity: () => identity,
        openSession: async () => async (path, body) => {
            calls.push({ path, body });
            if (path.endsWith('/tasks')) return { ok: true, tasks: structuredClone(tasks) };
            if (path.endsWith('/tasks/control')) {
                if (rejectControl) throw Object.assign(new Error('服务暂不可用'), { status: 503 });
                const task = tasks.find(task => task.key === body.taskKey);
                task.controlState = { pause: 'PAUSED', resume: 'ACTIVE', cancel: 'CANCELLED' }[body.action];
                return { ok: true, task: structuredClone(task) };
            }
            if (path.endsWith('/available')) return { available: jobCount < 2 };
            if (path.endsWith('/next')) {
                jobCount++;
                return { job: { id: `job-${jobCount}`, sku: `${jobCount}00`, taskKey: jobCount === 1 ? 'run:a' : 'run:b', claimFence: `f-${jobCount}` } };
            }
            return { ok: true };
        },
        verifySeller: async () => ({ sellerCompanyId: 'seller-a' }),
        capture: async (_job, _verification, signal) => {
            signals.push(signal);
            return new Promise((resolve, reject) => {
                finish = resolve;
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        },
    });
    return { worker, tasks, calls, signals, finish: () => finish({ weight: 100 }), setIdentity: next => { identity = next; } };
}

test('task list keeps distinct collection runs and does not claim or open Seller', async () => {
    const f = fixture();
    assert.deepEqual(await f.worker.listTasks(), f.tasks);
    assert.equal(f.calls.some(call => /\/(next|available)$/.test(call.path)), false);
});

test('pausing current group aborts only that capture after acknowledgement and lets another group continue', async t => {
    const f = fixture(); t.after(() => f.worker.stop());
    const running = f.worker.runOnce(); await settle();
    assert.equal(f.worker.getStatus().taskKey, 'run:a');
    const saved = await f.worker.controlTask({ taskKey: 'run:a', action: 'pause' });
    await running;
    assert.equal(saved.controlState, 'PAUSED');
    assert.equal(f.signals[0].aborted, true);
    assert.equal(f.calls.some(call => /job-1\/(result|fail)$/.test(call.path)), false);
    const other = f.worker.runOnce(); await settle(); f.finish(); await other;
    assert.ok(f.calls.some(call => /job-2\/result$/.test(call.path)));
    assert.equal(f.worker.getStatus().completed, 1);
});

test('cancelling another group does not interrupt the active group or delete product data', async t => {
    const f = fixture(); t.after(() => f.worker.stop());
    const running = f.worker.runOnce(); await settle();
    await f.worker.controlTask({ taskKey: 'run:b', action: 'cancel' });
    assert.equal(f.signals[0].aborted, false);
    f.finish(); await running;
    assert.ok(f.calls.some(call => /job-1\/result$/.test(call.path)));
    assert.equal(f.calls.some(call => /delete|collect-box/.test(call.path)), false);
});

test('failed control leaves the active request running and returns the failure to the caller', async t => {
    const f = fixture({ rejectControl: true }); t.after(() => f.worker.stop());
    const running = f.worker.runOnce(); await settle();
    await assert.rejects(f.worker.controlTask({ taskKey: 'run:a', action: 'pause' }), { status: 503 });
    assert.equal(f.signals[0].aborted, false);
    f.finish(); await running;
    assert.ok(f.calls.some(call => /job-1\/result$/.test(call.path)));
});

test('a late task-list response is rejected when the signed-in account changes', async () => {
    let finish, identity = { accountId: 'a', parentToken: 'a' };
    const worker = createEnrichmentWorker({ getIdentity: () => identity,
        openSession: async () => () => new Promise(resolve => { finish = resolve; }) });
    const reading = worker.listTasks(); await settle();
    identity = { accountId: 'b', parentToken: 'b' };
    finish({ ok: true, tasks: [group('run:a')] });
    await assert.rejects(reading, { code: 'ACCOUNT_CHANGED' });
});

test('signed-out list/control requests cannot call the backend', async () => {
    const worker = createEnrichmentWorker({ getIdentity: () => ({}), openSession: () => { throw new Error('must not call'); } });
    await assert.rejects(worker.listTasks(), { code: 'COLLECTOR_AUTH_REQUIRED' });
    await assert.rejects(worker.controlTask({ taskKey: 'run:a', action: 'pause' }), { code: 'COLLECTOR_AUTH_REQUIRED' });
});

for (const actions of [['pause'], ['cancel'], ['pause', 'resume']]) {
    test(`a delayed claim cannot begin capture after acknowledged ${actions.join(' then ')}`, async t => {
        let finishClaim, captured = 0; const calls = [];
        const worker = createEnrichmentWorker({
            getIdentity: () => ({ accountId: 'a', parentToken: 'a' }),
            openSession: async () => async (path, body) => {
                calls.push(path);
                if (path.endsWith('/available')) return { available: true };
                if (path.endsWith('/next')) return new Promise(resolve => { finishClaim = resolve; });
                if (path.endsWith('/tasks/control')) return { ok: true, task: group(body.taskKey, { controlState: { pause: 'PAUSED', cancel: 'CANCELLED', resume: 'ACTIVE' }[body.action] }) };
                return { ok: true };
            }, verifySeller: async () => ({ sellerCompanyId: '123' }), capture: async () => { captured++; return {}; },
        });
        t.after(() => worker.stop());
        const running = worker.runOnce(); await settle();
        for (const action of actions) await worker.controlTask({ taskKey: 'run:a', action });
        finishClaim({ job: { id: 'late', sku: '100', taskKey: 'run:a', claimFence: 'old-fence' } });
        await running;
        assert.equal(captured, 0);
        assert.equal(calls.some(path => /\/(result|fail)$/.test(path)), false);
    });
}

for (const resumedBy of ['lost response', 'another device']) {
    test(`server-authorized fresh claims continue after resume with ${resumedBy}`, async t => {
        let state = 'ACTIVE', available = false, captured = 0;
        const worker = createEnrichmentWorker({
            getIdentity: () => ({ accountId: 'a', parentToken: 'a' }),
            openSession: async () => async (path, body) => {
                if (path.endsWith('/available')) return { available: available && state === 'ACTIVE' };
                if (path.endsWith('/next')) return { job: { id: 'fresh', sku: '100', taskKey: 'run:a', claimFence: 'fresh-fence' } };
                if (path.endsWith('/tasks')) return { tasks: [group('run:a', { controlState: state })] };
                if (path.endsWith('/tasks/control')) {
                    state = body.action === 'pause' ? 'PAUSED' : 'ACTIVE';
                    if (body.action === 'resume') throw Object.assign(new Error('response lost after commit'), { code: 'ECONNRESET' });
                    return { ok: true, task: group(body.taskKey, { controlState: state }) };
                }
                return { ok: true };
            }, verifySeller: async () => ({ sellerCompanyId: '123' }),
            capture: async () => { captured++; return {}; },
        });
        t.after(() => worker.stop());
        await worker.runOnce();
        await worker.controlTask({ taskKey: 'run:a', action: 'pause' });
        if (resumedBy === 'lost response')
            await assert.rejects(worker.controlTask({ taskKey: 'run:a', action: 'resume' }), { code: 'ECONNRESET' });
        else state = 'ACTIVE';
        assert.equal((await worker.listTasks())[0].controlState, 'ACTIVE');
        available = true;
        await worker.runOnce();
        assert.equal(captured, 1);
        assert.equal(worker.getStatus().completed, 1);
    });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const terminal of ['closed', 'cancelled', 'completed', 'heartbeat-failed', 'verification-closed', 'verification-cancelled', 'verification-timeout']) {
    test(terminal + ' Ozon window releases the Collection run and heartbeat even with a pending provider promise', () => {
        const profile = mkdtempSync(join(tmpdir(), 'sonli-window-close-'));
        try {
            const probe = `
                import assert from 'node:assert/strict';
                import { mock } from 'node:test';
                import { Collection } from ${JSON.stringify(new URL('../dist-electron/services/collection/collection.services.js', import.meta.url).href)};
                const scenario = ${JSON.stringify(terminal)}, terminal = scenario.replace('verification-', ''), verification = scenario.startsWith('verification-'), calls = [];
                const turn = () => new Promise(setImmediate);
                let release, rejectSource, started, finished = false;
                const held = new Promise((resolve, reject) => { release = resolve; rejectSource = reject; });
                const collecting = new Promise(resolve => { started = resolve; });
                globalThis.__SELLER_CONTEXT__ = { accountId: 'fixture', source: 'ozon_seller_analytics', sourceIdentity: 'seller-page:fixture' };
                globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
                    const action = request.url.split('/').at(-1); calls.push({ action, data: request.data });
                    if (action === 'claim') return { data: { run: { id: 'fixture-run' }, leaseToken: 'fixture-lease' } };
                    if (terminal === 'heartbeat-failed' && action === 'heartbeat') throw Error('temporary heartbeat network failure');
                    return { data: { ok: true } };
                };
                const c = new Collection({ _id: 'fixture-task', taskName: 'closed window fixture', isUseCategorySelect: 1, targetCount: 1 }, null);
                c.restoreRun({ id: 'fixture-run', status: 'QUEUED' }); c.preparedClean = true;
                c.parseService.getDataCount = () => 30;
                c.mainWindowService.getHTML = async () => {
                    if (verification) throw Object.assign(Error('manual verification required'), { code: 'ZONGZI_ACCESS_BLOCKED', status: 403 });
                    return { html: '<html>Каталог товаров</html>', domain: 'https://www.ozon.ru', diagnostics: { productLinkCount: 1, blocked: false } };
                };
                c.getHtmlData = async () => { started(); await held; if (!c.reason) c.reason = 'success'; };
                c.expendShop = async () => {};
                mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
                const running = c.run().finally(() => { finished = true; });
                try {
                    for (let i = 0; i < 30 && !c.mainWindowService.browserWindow; i++) await turn();
                    const win = c.mainWindowService.browserWindow;
                    assert.ok(win);
                    win.webContents.executeJavaScript = async () => ({ ok: true, status: 200 });
                    win.webContents.session = { cookies: { flushStore: async () => {} } };
                    win.webContents.emit('dom-ready');
                    await turn();
                    if (verification) {
                        assert.equal(finished, false); assert.equal(c.task.taskStatus, 'running');
                        assert.equal(win.webContents.listenerCount('did-finish-load'), 1);
                    }
                    else { mock.timers.tick(3000); await collecting; }
                    if (terminal === 'closed') win.destroy();
                    else if (terminal === 'cancelled') await c.cancel();
                    else if (terminal === 'timeout') { mock.timers.tick(100000); await turn(); }
                    else if (terminal === 'heartbeat-failed') {
                        for (let attempt = 0; attempt < 3; attempt++) { mock.timers.tick(45000); await turn(); }
                    }
                    else release();
                    for (let i = 0; i < 30 && !finished; i++) await turn();
                    assert.equal(finished, true, 'window termination cannot wait forever on an abandoned provider promise');
                    await running;
                    const failed = terminal === 'closed' || terminal === 'heartbeat-failed' || terminal === 'timeout';
                    const expected = failed ? 'failed' : terminal;
                    assert.equal(c.task.taskStatus, expected);
                    const endings = calls.filter(call => ['fail', 'cancel', 'complete'].includes(call.action));
                    assert.deepEqual(endings.map(call => call.action), [failed ? 'fail' : terminal === 'cancelled' ? 'cancel' : 'complete']);
                    assert.equal(endings[0].data.leaseToken, 'fixture-lease');
                    if (terminal === 'closed') assert.equal(endings[0].data.errorCode, 'COLLECTION_WINDOW_CLOSED');
                    if (terminal === 'timeout') assert.equal(endings[0].data.errorCode, 'ZONGZI_VERIFICATION_TIMEOUT');
                    if (verification) {
                        assert.equal(win.isDestroyed(), true);
                        assert.equal(win.webContents.listenerCount('did-finish-load'), 0);
                        assert.equal(win.webContents.listenerCount('did-fail-load'), 0);
                    }
                    assert.equal(c.heartbeatTimer, null); assert.equal(c.runId, ''); assert.equal(c.leaseToken, '');
                    const heartbeats = calls.filter(call => call.action === 'heartbeat').length;
                    mock.timers.tick(135000); await turn();
                    assert.equal(calls.filter(call => call.action === 'heartbeat').length, heartbeats, 'no continued lease renewal after terminal state');
                    if (terminal === 'closed' && !verification) rejectSource(Error('late provider failure after window closed'));
                    else release();
                    await turn();
                    assert.equal(c.task.taskStatus, expected, 'a late provider response and cleanup destruction cannot overwrite the terminal status');
                }
                finally {
                    release(); await running.catch(() => {}); c.stopHeartbeat(); mock.timers.reset();
                }
            `;
            const result = spawnSync(process.execPath, ['--loader', fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url)), '--input-type=module', '-e', probe], {
                env: { ...process.env, DESKTOP_TEST_USER_DATA: profile }, encoding: 'utf8', timeout: 10000,
            });
            assert.equal(result.status, 0, result.stderr || result.stdout);
        }
        finally {
            rmSync(profile, { recursive: true, force: true });
        }
    });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the Ozon preference uses its own session, persists CNY and reports failed changes without inventing a rate', () => {
    const probe = `
        import assert from 'node:assert/strict';
        import vm from 'node:vm';
        import { ensureOzonCny, getAccountPartition } from ${JSON.stringify(new URL('../dist-electron/services/session.services.js', import.meta.url).href)};
        const calls = []; let flushed = 0;
        let response = { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
        const wc = {
            executeJavaScript: async (script) => vm.runInNewContext(script, {
                fetch: async (url, options) => { calls.push({ url, options }); return response; },
                AbortSignal, JSON,
            }),
            session: { cookies: { flushStore: async () => { flushed += 1; } } },
        };
        assert.equal(await ensureOzonCny(wc), 'CNY');
        assert.equal(flushed, 1);
        assert.equal(calls[0].url, '/api/composer-api.bx/_action/changeCurrency');
        assert.equal(calls[0].options.method, 'POST');
        assert.equal(calls[0].options.credentials, 'include');
        assert.deepEqual(JSON.parse(calls[0].options.body), { currency_code: 'CNY' });
        assert.equal(calls[0].options.headers['content-type'], 'application/json');
        assert.notEqual(getAccountPartition('ozon', 'a'), getAccountPartition('ozon', 'b'));
        assert.notEqual(getAccountPartition('ozon', 'a'), getAccountPartition('seller', 'a'));
        response = { ok: false, status: 403 };
        await assert.rejects(ensureOzonCny(wc), e => e.code === 'ZONGZI_CURRENCY_SETUP_FAILED' && e.status === 403);
        response = { ok: true, status: 200, json: async () => ({ result: 'ERROR' }) };
        await assert.rejects(ensureOzonCny(wc), e => e.code === 'ZONGZI_CURRENCY_SETUP_FAILED');
        assert.equal(flushed, 1, 'only a successful preference change is recorded as persisted');
    `;
    const child = spawnSync(process.execPath, ['--loader', fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url)), '--input-type=module', '-e', probe], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr || child.stdout);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('real desktop HTTP authorization reads the matching account route and keeps the active run frozen', () => {
    const temp = mkdtempSync(join(tmpdir(), 'ozon-route-http-'));
    try {
        const loader = join(temp, 'loader.mjs');
        writeFileSync(loader, `import { resolve as fixtureResolve } from ${JSON.stringify(new URL('./fixtures/desktop-http-loader.mjs', import.meta.url).href)};
            export function resolve(specifier, context, nextResolve) {
                if (specifier.endsWith('/seller-ozon.services.js')) return nextResolve(specifier, context);
                return fixtureResolve(specifier, context, nextResolve);
            }`);
        const code = `
            import assert from 'node:assert/strict';
            import http from 'node:http';
            const requests = [], preferences = { a: 'CN', b: 'CN' };
            let unavailable = false, revision = 0;
            const server = http.createServer(async (req, res) => {
                let body = ''; for await (const chunk of req) body += chunk;
                const payload = body ? JSON.parse(body) : {};
                requests.push({ path: req.url, auth: req.headers.authorization });
                res.setHeader('Content-Type', 'application/json');
                if (unavailable) { res.statusCode = 503; res.end(JSON.stringify({ message: 'fixture offline' })); return; }
                if (req.url === '/extension/collector-auth/ticket') {
                    assert.match(req.headers.authorization, /^Bearer parent-[abc]$/);
                    res.end(JSON.stringify({ ticket: req.headers.authorization.replace('Bearer parent-', '') }));
                } else if (req.url === '/extension/collector-auth/exchange') {
                    res.end(JSON.stringify({ collectorToken: 'collector-' + payload.ticket, expiresAt: new Date(Date.now() + 3600000).toISOString() }));
                } else if (req.url === '/collector/ozon-route') {
                    assert.match(req.headers.authorization, /^Collector collector-[ab]$/);
                    const account = req.headers.authorization.split('-').at(-1), route = preferences[account];
                    res.end(JSON.stringify({ route, revision, updatedAt: null, sellerOrigin: route === 'CN' ? 'https://seller.ozonru.cn' : 'https://seller.ozon.ru' }));
                } else { res.statusCode = 404; res.end('{}'); }
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            process.env.SONLI_API_BASE = 'http://127.0.0.1:' + server.address().port;
            process.env.SONLI_WEB_BASE = process.env.SONLI_API_BASE;
            try {
                const { operationStore } = await import(${JSON.stringify(new URL('../dist-electron/store/index.js', import.meta.url).href)});
                const seller = await import(${JSON.stringify(new URL('../dist-electron/services/seller-ozon.services.js', import.meta.url).href)});
                operationStore.set('user', { id: 'a' }); operationStore.set('token', 'parent-a');
                operationStore.set('seller-origin', 'https://seller.ozon.ru');
                const running = await seller.acquireSellerRoute();
                assert.equal(running.origin, 'https://seller.ozonru.cn');
                preferences.a = 'RU'; revision++;
                assert.equal((await seller.syncSellerRoute()).pendingOrigin, 'https://seller.ozon.ru');
                await assert.rejects(seller.acquireSellerRoute(), { code: 'SELLER_ROUTE_BUSY' });
                assert.equal(seller.getSellerRoute().origin, 'https://seller.ozonru.cn');
                running.release();
                const fresh = await seller.acquireSellerRoute();
                assert.equal(fresh.origin, 'https://seller.ozon.ru');
                seller.rememberSellerRunRoute('fixture-run', fresh.origin); fresh.release();
                operationStore.set('user', { id: 'b' }); operationStore.set('token', 'parent-b');
                assert.equal((await seller.syncSellerRoute()).origin, 'https://seller.ozonru.cn');
                assert.equal(seller.getSellerRunRoute({ id: 'fixture-run' }), '');
                unavailable = true;
                assert.match((await seller.syncSellerRoute()).syncError, /上次/);
                operationStore.set('user', { id: 'c' }); operationStore.set('token', 'parent-c');
                await assert.rejects(seller.acquireSellerRoute(), { code: 'SELLER_ROUTE_UNSYNCED' });
                assert.ok(requests.some(row => row.path === '/collector/ozon-route' && row.auth === 'Collector collector-a'));
                assert.ok(requests.some(row => row.path === '/collector/ozon-route' && row.auth === 'Collector collector-b'));
                console.log(JSON.stringify({ requests: requests.length, accountIsolation: true, activeRunPinned: true, cacheFallback: true }));
            } finally { await new Promise(resolve => server.close(resolve)); }
        `;
        const result = spawnSync(process.execPath, ['--experimental-loader', loader, '--input-type=module', '-e', code], {
            env: { ...process.env, DESKTOP_TEST_USER_DATA: temp }, encoding: 'utf8', timeout: 25000,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /"accountIsolation":true/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
});

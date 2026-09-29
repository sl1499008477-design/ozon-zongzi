import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const loader = fileURLToPath(new URL('./fixtures/desktop-http-loader.mjs', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));

async function readShops(handler) {
    const requests = [];
    const server = createServer((request, response) => {
        requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
        handler(request, response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--loader', loader, '--input-type=module', '-e', `
                import { operationStore } from './desktop/dist-electron/store/index.js';
                import { getShopList } from './desktop/dist-electron/services/collection/interface.services.js';
                operationStore.set('token', 'fixture-shop-token');
                console.log(JSON.stringify(await getShopList()));
            `], { cwd: root, env: { ...process.env, SONLI_API_BASE: `http://127.0.0.1:${server.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            child.stdout.on('data', value => { stdout += value; });
            child.stderr.on('data', value => { stderr += value; });
            child.on('error', reject);
            child.on('exit', code => code ? reject(new Error(stderr || stdout)) : resolve(JSON.parse(stdout.trim().split('\n').at(-1))));
        });
        return { result, requests };
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('desktop store selection reads bootstrap with authenticated HTTP and preserves store and warehouse fields', async () => {
    for (const wrapped of [false, true]) {
        const stores = [
            { id: 'store-a', label: '店铺 A', currencyCode: 'CNY', warehouses: [{ id: 'warehouse-a', name: '仓库 A' }] },
            { id: 'store-b', companyName: '店铺 B', currency: 'USD', warehouse: [{ id: 'warehouse-b' }] },
            { id: 'store-c' },
        ];
        const { result, requests } = await readShops((_request, response) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(wrapped ? { state: { stores } } : { stores }));
        });
        assert.deepEqual(requests, [{ method: 'GET', path: '/local/state?view=bootstrap', authorization: 'Bearer fixture-shop-token' }]);
        assert.deepEqual(result, { code: 400, message: '获取成功', data: [
            { ...stores[0], client_id: 'store-a', shop_name: '店铺 A', currency_code: 'CNY', warehouse: [{ id: 'warehouse-a', name: '仓库 A' }] },
            { ...stores[1], client_id: 'store-b', shop_name: '店铺 B', currency_code: 'USD', warehouse: [{ id: 'warehouse-b' }] },
            { id: 'store-c', client_id: 'store-c', shop_name: 'store-c', currency_code: 'RUB', warehouse: [] },
        ] });
    }
});

test('desktop store read reports HTTP 502 without retrying a full state read', async () => {
    const { result, requests } = await readShops((_request, response) => {
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'temporary gateway failure' }));
    });
    assert.deepEqual(result, { code: 500, data: null, message: 'temporary gateway failure' });
    assert.deepEqual(requests.map(request => request.path), ['/local/state?view=bootstrap']);
});

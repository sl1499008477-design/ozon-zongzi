import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRuntimeConfig, isTrustedExternalUrl } from '../dist-electron/config/runtime.js';

test('runtime config contains only Sonli and official Seller endpoints', () => {
    const config = getRuntimeConfig({
        SONLI_API_BASE: 'https://sonli.example.com',
        SONLI_WEB_BASE: 'https://console.example.com',
        SONLI_SELLER_CENTER_URL: 'https://seller.ozon.ru/app/analytics/what-to-sell',
    });
    assert.equal(config.sonliApiBase, 'https://sonli.example.com');
    assert.equal(config.sellerCenterUrl, 'https://seller.ozon.ru/app/analytics/what-to-sell');
    assert.deepEqual(Object.keys(config).sort(), [
        'configUrl',
        'sellerCenterUrl',
        'sonliApiBase',
        'sonliWebBase',
        'updateUrl',
    ]);
});

test('runtime config rejects remote plain HTTP', () => {
    assert.throws(() => getRuntimeConfig({ SONLI_API_BASE: 'http://example.com' }), /仅允许 HTTPS/);
});

test('runtime config pins the Seller window to seller.ozon.ru', () => {
    assert.throws(
        () => getRuntimeConfig({ SONLI_SELLER_CENTER_URL: 'https://example.com/login' }),
        /seller\.ozon\.ru/,
    );
});

test('external URL policy trusts Sonli and Ozon without the retired sourcing site', () => {
    const config = getRuntimeConfig({
        SONLI_API_BASE: 'https://sonli.example.com',
        SONLI_WEB_BASE: 'https://console.example.com',
    });
    assert.equal(isTrustedExternalUrl('https://seller.ozon.ru/app/', config), true);
    assert.equal(isTrustedExternalUrl('https://detail.1688.com/offer/1.html', config), false);
    assert.equal(isTrustedExternalUrl('https://untrusted.invalid/', config), false);
});


test('source runtime keeps the local API and Web defaults', () => {
    const config = getRuntimeConfig({});
    assert.equal(config.sonliApiBase, 'http://127.0.0.1:3001');
    assert.equal(config.sonliWebBase, 'http://127.0.0.1:3000');
    assert.equal(config.sellerCenterUrl, 'https://seller.ozonru.cn/app/analytics/what-to-sell');
});

test('packaged metadata connects to production without environment variables and keeps explicit overrides', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-desktop-runtime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'dist-electron/config'), { recursive: true });
    await cp(new URL('../dist-electron/config/runtime.js', import.meta.url), path.join(root, 'dist-electron/config/runtime.js'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
        type: 'module',
        sonliRuntime: { apiBase: 'https://www.ozonzongzi.com/api', webBase: 'https://www.ozonzongzi.com' },
    }));
    const { getRuntimeConfig: packagedConfig } = await import(pathToFileURL(path.join(root, 'dist-electron/config/runtime.js')).href);
    const config = packagedConfig({});
    assert.equal(config.sonliApiBase, 'https://www.ozonzongzi.com/api');
    assert.equal(config.sonliWebBase, 'https://www.ozonzongzi.com');
    const overridden = packagedConfig({ SONLI_API_BASE: 'http://127.0.0.1:3001', SONLI_WEB_BASE: 'http://127.0.0.1:3000' });
    assert.equal(overridden.sonliApiBase, 'http://127.0.0.1:3001');
    assert.equal(overridden.sonliWebBase, 'http://127.0.0.1:3000');
});


test('Seller config accepts China HTTPS and rejects lookalikes, credentials, and custom ports', () => {
    assert.equal(getRuntimeConfig({ SONLI_SELLER_CENTER_URL: 'https://seller.ozonru.cn/app/analytics/what-to-sell' }).sellerCenterUrl,
        'https://seller.ozonru.cn/app/analytics/what-to-sell');
    for (const value of ['http://seller.ozonru.cn/', 'https://seller.ozonru.cn:444/', 'https://seller.ozon.ru:444/',
        'https://seller.ozonru.cn.evil.test/', 'https://other.ozonru.cn/', 'https://user:pass@seller.ozonru.cn/']) {
        assert.throws(() => getRuntimeConfig({ SONLI_SELLER_CENTER_URL: value }), undefined, value);
    }
    assert.equal(isTrustedExternalUrl('https://seller.ozonru.cn/app/'), true);
    assert.equal(isTrustedExternalUrl('https://other.ozonru.cn/'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
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

test('external URL policy trusts Sonli, Ozon and 1688 only', () => {
    const config = getRuntimeConfig({
        SONLI_API_BASE: 'https://sonli.example.com',
        SONLI_WEB_BASE: 'https://console.example.com',
    });
    assert.equal(isTrustedExternalUrl('https://seller.ozon.ru/app/', config), true);
    assert.equal(isTrustedExternalUrl('https://detail.1688.com/offer/1.html', config), true);
    assert.equal(isTrustedExternalUrl('https://untrusted.invalid/', config), false);
});

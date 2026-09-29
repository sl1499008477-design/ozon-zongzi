import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
    buildSellerLeaderboardPayload,
    buildSellerSkuPayload,
    assertSellerRunContext,
    isRetryableSellerFailure,
    normalizeSellerAnalyticsResponse,
    normalizeSellerCompanyId,
} from '../dist-electron/services/seller-analytics.core.js';

test('normalizes seller company cookie values', () => {
    assert.equal(normalizeSellerCompanyId('%2212345%22'), '12345');
    assert.equal(normalizeSellerCompanyId('  abc-01  '), 'abc-01');
});

test('keys Seller Analytics context by account and stable source identity', () => {
    assert.doesNotThrow(() => assertSellerRunContext({
        accountId: 'account-1',
        sourceIdentity: 'seller-page:company-1',
        sellerCompanyId: 'company-new-cookie',
    }, {
        accountId: 'account-1',
        sourceIdentity: 'seller-page:company-1',
        sellerCompanyId: 'company-old-cookie',
    }));
    assert.throws(() => assertSellerRunContext({
        accountId: 'account-2',
        sourceIdentity: 'seller-page:company-1',
    }, {
        accountId: 'account-1',
        sourceIdentity: 'seller-page:company-1',
    }), (error) => error.code === 'SELLER_SOURCE_CONTEXT_CHANGED');
    assert.throws(() => assertSellerRunContext({
        accountId: 'account-1',
        sourceIdentity: 'seller-page:company-2',
    }, {
        accountId: 'account-1',
        sourceIdentity: 'seller-page:company-1',
    }), (error) => error.code === 'SELLER_SOURCE_CONTEXT_CHANGED');
});

test('builds monthly SKU payload with string paging fields', () => {
    assert.deepEqual(buildSellerSkuPayload(123456), {
        filter: { stock: 'any_stock', period: 'monthly', sku: '123456' },
        sort: { key: 'sum_gmv_desc' },
        limit: '1',
        offset: '0',
    });
});

test('builds bounded leaderboard payload and deduplicates categories', () => {
    const payload = buildSellerLeaderboardPayload({
        period: 'weekly',
        categories: [1, '1', 2],
        limit: 500,
        offset: -3,
    });
    assert.equal(payload.filter.period, 'weekly');
    assert.deepEqual(payload.filter.categories, [1, 2]);
    assert.equal(payload.limit, '100');
    assert.equal(payload.offset, '0');
});

test('normalizes PascalCase Seller Analytics fields', () => {
    const result = normalizeSellerAnalyticsResponse({
        items: [{
            Sku: 9988,
            Name: '测试商品',
            SoldCount: 42,
            GmvSum: 1234.5,
            QtyViewPdp: 90,
            ConvToCartPdp: 6.5,
        }],
        totals: { total: 1 },
    });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, '9988');
    assert.equal(result.items[0].nameLabel, '测试商品');
    assert.equal(result.items[0].soldCount, 42);
    assert.equal(result.items[0].gmvSum, 1234.5);
    assert.equal(result.items[0].qtyViewPdp, 90);
    assert.equal(result.items[0].convToCartPdp, 6.5);
});

test('reads scalar totals from recorded Seller responses instead of treating the first page as the total', async () => {
    const evidence = JSON.parse(await readFile(new URL('./fixtures/seller-pagination-evidence.json', import.meta.url), 'utf8'));
    for (const page of evidence.pages) {
        const result = normalizeSellerAnalyticsResponse(page.response);
        assert.equal(result.total, 1000, `offset ${page.offset}`);
        assert.equal(result.items.length, page.response.items.length);
    }
});

test('preserves valid legacy total formats and distinguishes unknown totals from zero', () => {
    const cases = [
        [{ totals: 1000 }, 1000], [{ totals: '1000' }, 1000],
        [{ total: '60' }, 60], [{ totals: { total: '60' } }, 60],
        [{ data: { total: '60' } }, 60], [{ data: { totals: { total: '60' } } }, 60],
        [{ data: { totals: '60' } }, 60],
        [{ total: 0 }, 0], [{ totals: 0 }, 0], [{ totals: '0' }, 0],
        [{}, null], [{ total: null }, null], [{ totals: {} }, null],
        [{ total: '' }, null], [{ total: ' ' }, null], [{ total: 'bad' }, null],
        [{ total: -1 }, null], [{ totals: true }, null], [{ totals: [] }, null],
        [{ total: Infinity }, null], [{ total: 1.5 }, null],
    ];
    for (const [payload, expected] of cases) {
        assert.equal(normalizeSellerAnalyticsResponse({ items: [{ sku: 'fixture' }], ...payload }).total, expected, JSON.stringify(payload));
    }
});

test('only retries transient Seller Analytics failures', () => {
    assert.equal(isRetryableSellerFailure(429), true);
    assert.equal(isRetryableSellerFailure(503), true);
    assert.equal(isRetryableSellerFailure(0, 'TIMEOUT'), true);
    assert.equal(isRetryableSellerFailure(401), false);
    assert.equal(isRetryableSellerFailure(422), false);
});

test('real Seller photo remains available to collection and export after public detail enrichment', async () => {
    const photo = 'https://ir-20.ozonstatic.cn/s3/multimedia-1-d/10110544429.jpg';
    const { items: [goods] } = normalizeSellerAnalyticsResponse({
        items: [{ sku: '2581899751', name: 'Philips Automatic Coffee Machine', photo }],
    });
    assert.equal(goods.cover, photo);
    const source = await readFile(new URL('../dist-electron/services/collection/parse.services.js', import.meta.url), 'utf8');
    const ParseService = vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '') + '\nParseService', {
        log: { error: assert.fail },
    });
    const parser = new ParseService({ getSellingData: async () => ({ success: true, data: { widgetStates: {} } }) });
    const detail = await parser.ozonDetailParse({ success: true, data: { widgetStates: {} } }, 'https://www.ozon.ru', goods);
    assert.equal(detail.cover, photo);
    assert.equal(detail.photo, photo);
    assert.equal(detail.id, '2581899751');
    const explicit = normalizeSellerAnalyticsResponse({ items: [{ cover: 'https://example.com/cover.jpg', photo }] });
    assert.equal(explicit.items[0].cover, 'https://example.com/cover.jpg');
});

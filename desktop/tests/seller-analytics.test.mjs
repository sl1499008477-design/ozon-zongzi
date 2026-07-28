import test from 'node:test';
import assert from 'node:assert/strict';
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

test('rejects a Seller store switch after a run has frozen its scope', () => {
    assert.doesNotThrow(() => assertSellerRunContext({
        sellerCompanyId: 'company-1',
        dataCollectionStoreId: 'data-1',
    }, {
        sellerCompanyId: 'company-1',
        dataCollectionStoreId: 'data-1',
    }));
    assert.throws(() => assertSellerRunContext({
        sellerCompanyId: 'company-2',
        dataCollectionStoreId: 'data-2',
    }, {
        sellerCompanyId: 'company-1',
        dataCollectionStoreId: 'data-1',
    }), (error) => error.code === 'SELLER_STORE_CHANGED');
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

test('only retries transient Seller Analytics failures', () => {
    assert.equal(isRetryableSellerFailure(429), true);
    assert.equal(isRetryableSellerFailure(503), true);
    assert.equal(isRetryableSellerFailure(0, 'TIMEOUT'), true);
    assert.equal(isRetryableSellerFailure(401), false);
    assert.equal(isRetryableSellerFailure(422), false);
});

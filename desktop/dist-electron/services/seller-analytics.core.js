const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function normalizeSellerCompanyId(value) {
    let id = String(value || '').trim().replace(/^['"]|['"]$/g, '');
    try {
        id = decodeURIComponent(id);
    }
    catch {
        // Cookie values are not guaranteed to be URI encoded.
    }
    return id.trim().replace(/^['"]|['"]$/g, '');
}

function firstValue(item, ...keys) {
    for (const key of keys) {
        if (item[key] !== undefined && item[key] !== null)
            return item[key];
    }
    return undefined;
}

export function normalizeSellerAnalyticsItem(value) {
    if (!value || typeof value !== 'object')
        return value;
    const nested = value.data && typeof value.data === 'object' ? value.data : {};
    const item = { ...value, ...nested };
    const sku = firstValue(item, 'sku', 'Sku', 'goods_id', 'goodsId', 'productId', 'id', '_id');
    const id = sku == null ? '' : String(sku);
    return {
        ...item,
        id,
        _id: id,
        sku: id,
        goods_id: id,
        productId: id,
        nameLabel: firstValue(item, 'nameLabel', 'Name', 'name', 'title', 'Title'),
        cover: firstValue(item, 'cover', 'Cover', 'image', 'Image', 'imageUrl', 'ImageUrl'),
        brand: firstValue(item, 'brand', 'Brand'),
        category1: firstValue(item, 'category1', 'Category1'),
        category1Id: firstValue(item, 'category1Id', 'Category1Id', 'category_1_id'),
        category2: firstValue(item, 'category2', 'Category2'),
        category2Id: firstValue(item, 'category2Id', 'Category2Id', 'category_2_id'),
        category3: firstValue(item, 'category3', 'Category3'),
        category3Id: firstValue(item, 'category3Id', 'Category3Id', 'category_3_id'),
        category4: firstValue(item, 'category4', 'Category4'),
        category4Id: firstValue(item, 'category4Id', 'Category4Id', 'category_4_id'),
        soldCount: firstValue(item, 'soldCount', 'SoldCount', 'sold_count', 'sales', 'Sales'),
        gmvSum: firstValue(item, 'gmvSum', 'GmvSum', 'gmv_sum', 'revenue', 'Revenue'),
        avgPrice: firstValue(item, 'avgPrice', 'AvgPrice', 'AvgGmv', 'avgGmv', 'avg_price', 'price', 'Price'),
        price: firstValue(item, 'price', 'Price', 'avgPrice', 'AvgPrice', 'AvgGmv', 'avgGmv'),
        salesDynamics: firstValue(item, 'salesDynamics', 'SalesDynamics', 'sales_dynamics'),
        drr: firstValue(item, 'drr', 'Drr', 'DRR'),
        avgOrdersOnAccDays: firstValue(item, 'avgOrdersOnAccDays', 'AvgOrdersOnAccDays', 'avg_orders_on_acc_days'),
        avgGmvOnAccDays: firstValue(item, 'avgGmvOnAccDays', 'AvgGmvOnAccDays', 'avg_gmv_on_acc_days'),
        daysInPromo: firstValue(item, 'daysInPromo', 'DaysInPromo', 'days_in_promo'),
        discount: firstValue(item, 'discount', 'Discount'),
        promoRevenueShare: firstValue(item, 'promoRevenueShare', 'PromoRevenueShare', 'promo_revenue_share'),
        daysWithTrafarets: firstValue(item, 'daysWithTrafarets', 'DaysWithTrafarets', 'days_with_trafarets'),
        qtyViewPdp: firstValue(item, 'qtyViewPdp', 'QtyViewPdp', 'qty_view_pdp'),
        sessionCount: firstValue(item, 'sessionCount', 'SessionCount', 'session_count', 'views', 'Views'),
        sessionCountSearch: firstValue(item, 'sessionCountSearch', 'SessionCountSearch', 'session_count_search'),
        pdpToCartConversion: firstValue(item, 'pdpToCartConversion', 'PdpToCartConversion', 'pdp_to_cart_conversion'),
        convToCartPdp: firstValue(item, 'convToCartPdp', 'ConvToCartPdp', 'conv_to_cart_pdp'),
        convToCartSearch: firstValue(item, 'convToCartSearch', 'ConvToCartSearch', 'conv_to_cart_search'),
        convViewToOrder: firstValue(item, 'convViewToOrder', 'ConvViewToOrder', 'conv_view_to_order'),
        views: firstValue(item, 'views', 'Views', 'sessionCount', 'SessionCount'),
        stock: firstValue(item, 'stock', 'Stock', 'balance', 'Balance'),
        salesSchema: firstValue(item, 'salesSchema', 'SalesSchema', 'sales_schema'),
        nullableRedemptionRate: firstValue(item, 'nullableRedemptionRate', 'NullableRedemptionRate', 'redemptionRate'),
        nullableCreateDate: firstValue(item, 'nullableCreateDate', 'NullableCreateDate', 'createDate', 'CreateDate'),
        returnCancelRate: firstValue(item, 'returnCancelRate', 'ReturnCancelRate', 'return_cancel_rate'),
    };
}

export function normalizeSellerAnalyticsResponse(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const items = source.items || source.data?.items || source.data || source.list || [];
    const normalizedItems = Array.isArray(items)
        ? items.map(normalizeSellerAnalyticsItem).filter(Boolean)
        : [];
    const totals = source.totals || source.data?.totals || {};
    return {
        items: normalizedItems,
        total: Number(source.total ?? totals.total ?? source.data?.total ?? normalizedItems.length),
        totals,
        updateDate: source.updateDate || source.data?.updateDate || null,
        benchmark: source.benchmark || source.data?.benchmark || null,
    };
}

export function buildSellerSkuPayload(sku, period = 'monthly') {
    const normalizedSku = String(sku || '').trim();
    if (!normalizedSku)
        throw new Error('SKU 不能为空');
    return {
        filter: {
            stock: 'any_stock',
            period: period === 'weekly' ? 'weekly' : 'monthly',
            sku: normalizedSku,
        },
        sort: { key: 'sum_gmv_desc' },
        limit: '1',
        offset: '0',
    };
}

export function buildSellerLeaderboardPayload(options = {}) {
    const categories = [];
    const seenCategories = new Set();
    for (const value of Array.isArray(options.categories) ? options.categories : []) {
        if (value === '' || value === null || value === undefined)
            continue;
        const key = String(value);
        if (!seenCategories.has(key)) {
            seenCategories.add(key);
            categories.push(value);
        }
    }
    return {
        filter: {
            stock: 'any_stock',
            period: options.period === 'weekly' ? 'weekly' : 'monthly',
            categories,
        },
        sort: { key: String(options.sortKey || 'sum_gmv_desc') },
        limit: String(Math.min(100, Math.max(1, Number(options.limit || 30)))),
        offset: String(Math.max(0, Number(options.offset || 0))),
    };
}

export function isRetryableSellerFailure(status, code = '') {
    return RETRYABLE_STATUS.has(Number(status || 0))
        || (!status && ['NETWORK_ERROR', 'TIMEOUT', 'ABORTED'].includes(String(code)));
}

export function assertSellerRunContext(actual = {}, expected = {}) {
    const actualCompanyId = normalizeSellerCompanyId(actual.sellerCompanyId);
    const expectedCompanyId = normalizeSellerCompanyId(expected.sellerCompanyId);
    const actualStoreId = String(actual.dataCollectionStoreId || '');
    const expectedStoreId = String(expected.dataCollectionStoreId || '');
    if ((expectedCompanyId && actualCompanyId !== expectedCompanyId)
        || (expectedStoreId && actualStoreId !== expectedStoreId)) {
        const error = new Error('运行中的 Ozon 数据店铺已发生变化，任务已停止以防数据混入');
        error.code = 'SELLER_STORE_CHANGED';
        error.expected = { sellerCompanyId: expectedCompanyId, dataCollectionStoreId: expectedStoreId };
        error.actual = { sellerCompanyId: actualCompanyId, dataCollectionStoreId: actualStoreId };
        throw error;
    }
    return actual;
}

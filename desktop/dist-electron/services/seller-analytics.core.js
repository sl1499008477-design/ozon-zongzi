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
    const averagePrice = firstValue(item, 'sellerAnalyticsPriceRub', 'avgPrice', 'AvgPrice', 'AvgGmv', 'avgGmv', 'avg_price')
        ?? (!item.currencyCode || item.currencyCode === 'RUB' ? firstValue(item, 'price', 'Price') : undefined);
    const brand = firstValue(item, 'brand', 'Brand');
    const views = firstValue(item, 'views', 'Views');
    const cardViews = firstValue(item, 'qtyViewPdp', 'QtyViewPdp', 'qty_view_pdp', 'sessionCount', 'SessionCount', 'session_count');
    const redemptionRate = firstValue(item, 'nullableRedemptionRate', 'NullableRedemptionRate', 'nullable_redemption_rate', 'redemptionRate', 'redemption_rate');
    const createDate = firstValue(item, 'nullableCreateDate', 'NullableCreateDate', 'createDate', 'CreateDate');
    const created = createDate ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(createDate)) ? `${createDate}T00:00:00` : createDate) : null;
    const today = new Date();
    const dayNumber = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
    const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value));
    return {
        ...item,
        id,
        _id: id,
        sku: id,
        goods_id: id,
        productId: id,
        nameLabel: firstValue(item, 'nameLabel', 'Name', 'name', 'title', 'Title'),
        cover: firstValue(item, 'cover', 'Cover', 'image', 'Image', 'imageUrl', 'ImageUrl', 'photo'),
        brand: typeof brand === 'string' ? (/^без бренда$/i.test(brand.trim()) ? '' : brand.trim()) : brand,
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
        avgPrice: averagePrice,
        price: averagePrice,
        sellerAnalyticsPriceRub: averagePrice,
        analyticsCurrency: 'RUB',
        salesDynamics: firstValue(item, 'salesDynamics', 'SalesDynamics', 'sales_dynamics'),
        drr: firstValue(item, 'drr', 'Drr', 'DRR'),
        avgOrdersOnAccDays: firstValue(item, 'avgOrdersOnAccDays', 'AvgOrdersOnAccDays', 'avg_orders_on_acc_days'),
        avgGmvOnAccDays: firstValue(item, 'avgGmvOnAccDays', 'AvgGmvOnAccDays', 'avg_gmv_on_acc_days'),
        daysInPromo: firstValue(item, 'daysInPromo', 'DaysInPromo', 'days_in_promo'),
        discount: firstValue(item, 'discount', 'Discount'),
        promoRevenueShare: firstValue(item, 'promoRevenueShare', 'PromoRevenueShare', 'promo_revenue_share'),
        daysWithTrafarets: firstValue(item, 'daysWithTrafarets', 'DaysWithTrafarets', 'days_with_trafarets'),
        qtyViewPdp: cardViews,
        sessionCount: firstValue(item, 'sessionCount', 'SessionCount', 'session_count') ?? cardViews,
        sessionCountSearch: firstValue(item, 'sessionCountSearch', 'SessionCountSearch', 'session_count_search'),
        pdpToCartConversion: firstValue(item, 'pdpToCartConversion', 'PdpToCartConversion', 'pdp_to_cart_conversion'),
        convToCartPdp: firstValue(item, 'convToCartPdp', 'ConvToCartPdp', 'conv_to_cart_pdp', 'pdpToCartConversion', 'PdpToCartConversion', 'pdp_to_cart_conversion'),
        convToCartSearch: firstValue(item, 'convToCartSearch', 'ConvToCartSearch', 'conv_to_cart_search'),
        convViewToOrder: firstValue(item, 'convViewToOrder', 'ConvViewToOrder', 'conv_view_to_order'),
        views,
        clickRate: firstValue(item, 'clickRate', 'ClickRate', 'click_rate')
            ?? (numeric(cardViews) && numeric(views) && Number(views) > 0 ? Number(cardViews) / Number(views) * 100 : undefined),
        stock: firstValue(item, 'stock', 'Stock', 'balance', 'Balance'),
        salesSchema: firstValue(item, 'salesSchema', 'SalesSchema', 'sales_schema'),
        nullableRedemptionRate: redemptionRate,
        nullableCreateDate: createDate,
        releaseDate: created && Number.isFinite(created.getTime()) ? dayNumber(today) - dayNumber(created) : item.releaseDate,
        // Ozon defines redemption share as ordered units that were neither cancelled nor returned.
        returnCancelRate: firstValue(item, 'returnCancelRate', 'ReturnCancelRate', 'return_cancel_rate')
            ?? (numeric(redemptionRate) ? Number((100 - Number(redemptionRate)).toFixed(10)) : undefined),
        weight: firstValue(item, 'weight', 'Weight'),
        length: firstValue(item, 'length', 'Length'),
        width: firstValue(item, 'width', 'Width'),
        height: firstValue(item, 'height', 'Height'),
    };
}

export function normalizeSellerAnalyticsResponse(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const items = source.items || source.data?.items || source.data || source.list || [];
    const normalizedItems = Array.isArray(items)
        ? items.map(normalizeSellerAnalyticsItem).filter(Boolean)
        : [];
    const totals = source.totals ?? source.data?.totals ?? {};
    const rawTotal = source.total ?? totals.total ?? source.data?.total
        ?? (typeof totals === 'number' || typeof totals === 'string' ? totals : undefined);
    const parsedTotal = (typeof rawTotal === 'number' || (typeof rawTotal === 'string' && rawTotal.trim()))
        ? Number(rawTotal) : NaN;
    return {
        items: normalizedItems,
        total: Number.isSafeInteger(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null,
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
    const actualContext = {
        accountId: String(actual.accountId || ''),
        sourceIdentity: String(actual.sourceIdentity || ''),
        sellerOrigin: String(actual.sellerOrigin || ''),
    };
    const expectedContext = {
        accountId: String(expected.accountId || ''),
        sourceIdentity: String(expected.sourceIdentity || ''),
        sellerOrigin: String(expected.sellerOrigin || ''),
    };
    if ((expectedContext.accountId && actualContext.accountId !== expectedContext.accountId)
        || (expectedContext.sourceIdentity && actualContext.sourceIdentity !== expectedContext.sourceIdentity)
        || (expectedContext.sellerOrigin && actualContext.sellerOrigin !== expectedContext.sellerOrigin)) {
        const error = new Error('运行中的账号或 Seller 来源页面已发生变化，任务已停止以防数据混入');
        error.code = 'SELLER_SOURCE_CONTEXT_CHANGED';
        error.expected = expectedContext;
        error.actual = actualContext;
        throw error;
    }
    return actual;
}

import { saveCollectorCategoryMapping, saveCollectorMarketSnapshot } from '../collector-backend.services.js';
import { fetchSellerSkuAnalyticsBatch } from '../seller-ozon.services.js';
function sellerPriceRub(item) {
    return item.sellerAnalyticsPriceRub ?? item.avgPrice
        ?? (!item.currencyCode || item.currencyCode === 'RUB' ? item.price : undefined);
}

export class DataProcessService {
    data = new Map();
    task;
    sellerContext = null;
    cancellationSignal = null;
    missingFields = new Set();
    constructor(task = {}) {
        this.task = task;
    }
    setSellerContext(context) {
        this.sellerContext = context ? { ...context } : null;
    }
    setCancellationSignal(signal) {
        this.cancellationSignal = signal || null;
    }
    /**
     * 获取基础数据
     */
    async getBaseData(data) {
        for (const item of data) {
            const cached = this.data.get(item.id);
            if (cached) {
                const merge = { ...cached, ...item };
                this.data.set(item.id, merge);
                continue;
            }
        }
        try {
            const analytics = await fetchSellerSkuAnalyticsBatch(data.map((item) => item.id), {
                period: this.task.period === 'weekly' ? 'weekly' : 'monthly',
                expectedContext: this.sellerContext,
                signal: this.cancellationSignal,
                onStatus: this.onSellerStatus,
            });
            if (this.sellerContext?.runId) {
                await Promise.allSettled(analytics.map((item) => saveCollectorMarketSnapshot({
                    taskId: this.sellerContext.taskId,
                    runId: this.sellerContext.runId,
                    sourceIdentity: this.sellerContext.sourceIdentity,
                    sourceSku: String(item.sku || item.id || ''),
                    categoryId: String(item.category4Id || item.category3Id || item.category2Id || item.category1Id || ''),
                    period: this.task.period === 'weekly' ? 'weekly' : 'monthly',
                    metrics: {
                        soldCount: item.soldCount,
                        gmvSum: item.gmvSum,
                        drr: item.drr,
                        salesDynamics: item.salesDynamics,
                    },
                    payload: item,
                })));
                await Promise.allSettled(analytics.map((item) => {
                    const rootCategoryId = String(item.category1Id || item.category2Id || item.category3Id || item.category4Id || '');
                    const leafCategoryId = String(item.category4Id || item.category3Id || item.category2Id || item.category1Id || '');
                    if (!rootCategoryId || !leafCategoryId)
                        return null;
                    return saveCollectorCategoryMapping({
                        sourceIdentity: this.sellerContext.sourceIdentity,
                        rootCategoryId,
                        rootCategoryName: item.category1 || item.category2 || item.category3 || item.category4 || rootCategoryId,
                        leafCategoryId,
                        leafCategoryName: item.category4 || item.category3 || item.category2 || item.category1 || leafCategoryId,
                        payload: {
                            category1Id: item.category1Id,
                            category2Id: item.category2Id,
                            category3Id: item.category3Id,
                            category4Id: item.category4Id,
                        },
                    });
                }));
            }
            if (analytics.length) {
                // Seller responses are normalized at the API boundary for both collection modes.
                analytics.forEach((item) => {
                    const sku = String(item.goods_id || item.sku || item.id || '');
                    if (sku)
                        this.data.set(sku, { ...item, ...(item.accessibility ? { accessibility: item.accessibility * 100 } : {}), sellerAnalyticsPriceRub: sellerPriceRub(item), analyticsCurrency: 'RUB' });
                });
            }
            const mergeData = data.map((item) => {
                const obj = this.data.get(String(item.id));
                if (obj) {
                    return { ...item, ...obj, productId: item.id };
                }
                return { ...item, price: undefined, productId: item.id };
            });
            return mergeData;
        }
        catch (error) {
            const wrapped = new Error(`获取基础数据失败：${error?.message || '未知错误'}`);
            wrapped.code = error?.code || 'SELLER_ANALYTICS_ENRICH_FAILED';
            wrapped.status = error?.status;
            wrapped.phase = error?.phase;
            throw wrapped;
        }
    }
    /**
     * 获取中文名
     */
    async getChineseName(text) {
        // 翻译不再依赖旧业务服务；后续由 sonli 内容处理管线统一补全。
        return text;
    }
    /**
     * AI过滤
     */
    async aiFilterData(data, type = 'merge') {
        this.missingFields.clear();
        if (!data || !Array.isArray(data) || data.length === 0) {
            return [];
        }
        const filters = [
            // 上架时间范围校验
            (item) => {
                const result = this.checkRange(item.releaseDate, undefined, 365, '上架天数');
                return result;
            },
            // 月销售动态范围校验
            (item) => {
                const result = this.checkRange(item.salesDynamics, 0, undefined, '月销售动态') && Number(item.salesDynamics) > 0;
                return result;
            },
            // 广告份额范围校验
            (item) => {
                const result = this.checkRange(item.drr, undefined, 15, '广告份额');
                return result;
            },
            // 销量范围校验
            (item) => {
                const rules = [
                    { max: 500, minSold: 500 },
                    { max: 1000, minSold: 150 },
                    { max: 5000, minSold: 30 },
                    { max: 10000, minSold: 15 },
                ];
                const price = sellerPriceRub(item);
                if (!this.checkRange(price, 0, undefined, 'Seller 平均售价（₽）')) return false;
                const rule = rules.find((r) => Number(price) <= r.max);
                return this.checkRange(item.soldCount, (rule?.minSold || 5) + 1, undefined, '销量');
            },
        ];
        const detailFilters = [(item) => this.checkRange(item.sellerNumber, undefined, 30, '跟卖人数')];
        const activeFilters = type === 'base' ? filters : type === 'detail' ? detailFilters : [...filters, ...detailFilters];
        const filteredData = data.filter((item) => {
            const results = activeFilters.map((filterFn) => filterFn(item));
            const overallResult = results.every((r) => r);
            return overallResult;
        });
        return filteredData;
    }
    /**
     * 数据过滤
     */
    async filterData(data, task = this.task, type = 'merge') {
        this.missingFields.clear();
        if (Number(task.aiSelectType) === 2) {
            // The default mode is the fixed preset shown in the dialog, including for saved tasks.
            task = { soldCountMin: 50, monthDynamicsMin: 10, followMax: 30, ratingMin: 4, salesSchema: 'FBO,FBS', brandType: '2' };
        }
        if (!data || !Array.isArray(data) || data.length === 0) {
            return [];
        }
        // 定义过滤条件映射
        const filters = [
            // Historical tasks keep Seller RUB bounds; new CNY bounds need the product detail.
            (item) => {
                if (task.salePriceBasis === 'storefrontCny') return true;
                const result = this.checkRange(sellerPriceRub(item), task.salePriceMin, task.salePriceMax, 'Seller 平均售价（₽）');
                return result;
            },
            // 品牌类型过滤
            (item) => {
                if (task?.brandType === undefined || task?.brandType === null || +task?.brandType === 2)
                    return true;
                if (typeof item.brand !== 'string') {
                    this.missingFields.add('品牌类型');
                    return false;
                }
                if (+task?.brandType === 0)
                    return Boolean(item.brand.trim());
                if (+task?.brandType === 1)
                    return !item.brand.trim();
                return true;
            },
            // 销量范围校验
            (item) => {
                const result = this.checkRange(item.soldCount, task.soldCountMin, task.soldCountMax, '销量');
                return result;
            },
            // 月销售额范围校验
            (item) => {
                const result = this.checkRange(item.gmvSum, task.gmvSumMin, task.gmvSumMax, '销售额（₽）');
                return result;
            },
            // 上架时间范围校验
            (item) => {
                const result = this.checkRange(item.releaseDate, task.upGoodsTimeMin, task.upGoodsTimeMax, '上架天数');
                return result;
            },
            // 月销售动态范围校验
            (item) => {
                const result = this.checkRange(item.salesDynamics, task.monthDynamicsMin, task.monthDynamicsMax, '月销售动态');
                return result;
            },
            // 广告份额范围校验
            (item) => {
                const result = this.checkRange(item.drr, task.adFeeMin, task.adFeeMax, '广告份额');
                return result;
            },
            // 参与促销天数范围校验
            (item) => {
                const result = this.checkRange(item.daysInPromo, task.promotionDayMin, task.promotionDayMax, '参与促销天数');
                return result;
            },
            // 参与促销折扣范围校验
            (item) => {
                const result = this.checkRange(item.discount, task.promotionDiscountMin, task.promotionDiscountMax, '促销折扣');
                return result;
            },
            // 促销活动转化率范围校验
            (item) => {
                const result = this.checkRange(item.promoRevenueShare, task.promotionDynamicsMin, task.promotionDynamicsMax, '促销销售额占比');
                return result;
            },
            // 付费推广天数范围校验
            (item) => {
                const result = this.checkRange(item.daysWithTrafarets, task.promoteDayMin, task.promoteDayMax, '付费推广天数');
                return result;
            },
            // 浏览量范围校验
            (item) => {
                const result = this.checkRange(item.sessionCount, task.viewsMin, task.viewsMax, '商品卡片浏览量');
                return result;
            },
            // 商品卡片加购率范围校验
            (item) => {
                const result = this.checkRange(item.convToCartPdp, task.cardRateMin, task.cardRateMax, '商品卡片加购率');
                return result;
            },
            // 搜索和目录加购率范围校验
            (item) => {
                const result = this.checkRange(item.convToCartSearch, task.showRateMin, task.showRateMax, '搜索和目录加购率');
                return result;
            },
            // 发货模式校验
            (item) => {
                if (!task.salesSchema)
                    return true;
                if (!item.salesSchema) {
                    this.missingFields.add('发货模式');
                    return false;
                }
                const selected = String(task.salesSchema).split(',').map(value => value.trim().toUpperCase());
                return String(item.salesSchema).split(',').some(value => selected.includes(value.trim().toUpperCase()));
            },
            // 点击率校验
            (item) => {
                const result = this.checkRange(item.clickRate, task.clickRateMin, task.clickRateMax, '点击率');
                return result;
            },
            // 成交率校验
            (item) => {
                const result = this.checkRange(item.nullableRedemptionRate, task.nullableRedemptionRateMin, task.nullableRedemptionRateMax, '未取消及未退货订单占比');
                return result;
            },
            // 退货取消率校验
            (item) => {
                const result = this.checkRange(item.returnCancelRate, task.returnCancelRateMin, task.returnCancelRateMax, '取消及退货率');
                return result;
            },
        ];
        const filters2 = [
            (item) => {
                if (task.salePriceBasis !== 'storefrontCny') return true;
                const blackPrice = item.storefrontPrice?.currencyCode === 'CNY'
                    ? item.storefrontPrice.ordinaryAmount : undefined;
                return this.checkRange(blackPrice, task.salePriceMin, task.salePriceMax, '前台黑标价（¥）');
            },
            // 重量范围校验
            (item) => {
                const result = this.checkRange(item.weight, task.weightRangeMin, task.weightRangeMax, '重量');
                return result;
            },
            // 包装长度范围校验
            (item) => {
                const result = this.checkRange(item.length, task.packageLengthMin, task.packageLengthMax, '包装长度');
                return result;
            },
            // 包装高度范围校验
            (item) => {
                const result = this.checkRange(item.height, task.packageHeightMin, task.packageHeightMax, '包装高度');
                return result;
            },
            // 包装宽度范围校验
            (item) => {
                const result = this.checkRange(item.width, task.packageWidthMin, task.packageWidthMax, '包装宽度');
                return result;
            },
            // 跟卖人数范围校验
            (item) => {
                const result = this.checkRange(item.sellerNumber, task.followMin, task.followMax, '跟卖人数');
                return result;
            },
            // 评论数校验
            (item) => {
                const result = this.checkRange(item.reviewCountLabel, task.numberOfCommentsMin, task.numberOfCommentsMax, '评论数');
                return result;
            },
            // 评分范围校验
            (item) => {
                const result = this.checkRange(item.rating, task.ratingMin, task.ratingMax, '评分');
                return result;
            },
        ];
        let filteredData;
        switch (type) {
            case 'base':
                filteredData = data.filter((item) => {
                    const results = filters.map((filterFn) => filterFn(item));
                    const overallResult = results.every((r) => r);
                    return overallResult;
                });
                break;
            case 'detail':
                filteredData = data.filter((item) => {
                    const results = filters2.map((filterFn) => filterFn(item));
                    const overallResult = results.every((r) => r);
                    return overallResult;
                });
                break;
            default:
                filteredData = data.filter((item) => {
                    const results = filters.map((filterFn) => filterFn(item));
                    const overallResult = results.every((r) => r);
                    return overallResult;
                }).filter((item) => {
                    const results = filters2.map((filterFn) => filterFn(item));
                    const overallResult = results.every((r) => r);
                    return overallResult;
                });
                break;
        }
        return filteredData;
    }
    /**
     * 检查数值是否在范围内
     * @param value 待检查的值
     * @param min 最小值
     * @param max 最大值
     * @returns 是否符合范围
     */
    checkRange(value, min, max, label) {
        const present = value => value !== undefined && value !== null && value !== '';
        if (!present(min) && !present(max))
            return true;
        const num = (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN;
        if (!Number.isFinite(num)) {
            if (label) this.missingFields.add(label);
            return false;
        }
        if (present(min) && (!Number.isFinite(Number(min)) || num < Number(min)))
            return false;
        if (present(max) && (!Number.isFinite(Number(max)) || num > Number(max)))
            return false;
        return true;
    }

    /**
     * 销毁实例
     */
    destroy() {
        this.data.clear();
        this.cancellationSignal = null;
    }
}

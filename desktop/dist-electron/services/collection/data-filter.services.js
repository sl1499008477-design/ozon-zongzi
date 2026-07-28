import dayjs from 'dayjs';
import { calculateCollectorPricing, saveCollectorCategoryMapping, saveCollectorMarketSnapshot } from '../collector-backend.services.js';
import { fetchSellerSkuAnalyticsBatch } from '../seller-ozon.services.js';
export class DataProcessService {
    data = new Map();
    task;
    sellerContext = null;
    cancellationSignal = null;
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
            });
            if (this.sellerContext?.runId) {
                await Promise.allSettled(analytics.map((item) => saveCollectorMarketSnapshot({
                    operatingStoreId: this.sellerContext.operatingStoreId,
                    dataCollectionStoreId: this.sellerContext.dataCollectionStoreId,
                    sellerCompanyId: this.sellerContext.sellerCompanyId,
                    taskId: this.sellerContext.taskId,
                    runId: this.sellerContext.runId,
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
                        operatingStoreId: this.sellerContext.operatingStoreId,
                        dataCollectionStoreId: this.sellerContext.dataCollectionStoreId,
                        sellerCompanyId: this.sellerContext.sellerCompanyId,
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
                analytics
                    .map((item) => ({ ...item, ...item.data }))
                    .forEach((item) => {
                    item.nullableCreateDate = dayjs(item.nullableCreateDate).format('YYYY-MM-DD');
                    item.releaseDate = dayjs().diff(dayjs(item.nullableCreateDate), 'day');
                    item.commissionRfbs = `<=1500卢布：${item.rfbs_small || 0}% 1501~5000卢布: ${item.rfbs || 0}% >5000卢布：${item.rfbs_large || 0}%`;
                    item.commissionFbp = `<=1500卢布：${item.fbp_small || 0}% 1501~5000卢布: ${item.fbp || 0}% >5000卢布：${item.fbp_large || 0}%`;
                    item.discount = item?.discount?.toFixed(2);
                    if (item.accessibility)
                        item.accessibility = item.accessibility * 100;
                    if (item.brand)
                        item.brand = item.brand?.includes('без бренда') ? '' : item.brand;
                    item.clickRate = ((item.qtyViewPdp || 0) / (item.views || 0) * 100)?.toFixed(2);
                    if (item.goods_id)
                        this.data.set(item.goods_id, item);
                });
            }
            const mergeData = data.map((item) => {
                const obj = this.data.get(item.id);
                if (obj) {
                    return { ...item, ...obj, productId: item.id };
                }
                return { ...item, productId: item.id };
            });
            return mergeData;
        }
        catch (error) {
            const wrapped = new Error(`获取基础数据失败：${error?.message || '未知错误'}`);
            wrapped.code = error?.code || 'SELLER_ANALYTICS_ENRICH_FAILED';
            wrapped.status = error?.status;
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
     * 获取详细数据
     */
    async getDetailData(params) {
        try {
            const { taskId, reqDatas, upMode } = params;
            const res = await calculateCollectorPricing({
                operation: upMode == 2 ? 'goodsFilter2' : 'goodsFilter',
                mode: upMode == 2 ? 'profit' : 'pricing',
                taskId,
                operatingStoreId: this.task.operatingStoreId || this.task.storeId || '',
                dataCollectionStoreId: this.task.dataCollectionStoreId || '',
                task: this.task,
                items: reqDatas,
            });
            const entries = Array.isArray(res?.data)
                ? res.data
                : (Array.isArray(res?.result) ? res.result : (res?.items || []));
            const output = reqDatas.map((raw, index) => {
                const entry = entries.find?.((candidate) => {
                    const item = candidate?.compatibility || candidate?.result || candidate;
                    return String(item?.id || item?.sku) === String(raw.id || raw.sku);
                }) || entries[index] || {};
                const priced = entry?.compatibility || entry?.result || entry
                    || {};
                const cached = this.data.get(raw.id) || {};
                const item = {
                    ...cached,
                    ...raw,
                    ...priced,
                    pricingResult: entry?.result || undefined,
                    pricingAdjustment: entry?.adjustment || undefined,
                };
                if (!item.commissionRfbs)
                    item.commissionRfbs = `<=1500卢布：${item.rfbs_small || 0}% 1501~5000卢布: ${item.rfbs || 0}% >5000卢布：${item.rfbs_large || 0}%`;
                if (!item.commissionFbp)
                    item.commissionFbp = `<=1500卢布：${item.fbp_small || 0}% 1501~5000卢布: ${item.fbp || 0}% >5000卢布：${item.fbp_large || 0}%`;
                item.chineseName = item.chineseName || item.nameLabel;
                return item;
            });
            return output;
        }
        catch (error) {
            return reqDatas.map((item) => ({
                ...(this.data.get(item.id) || {}),
                ...item,
                pricingError: error?.message || String(error),
                chineseName: item.chineseName || item.nameLabel,
            }));
        }
    }
    /**
     * AI过滤
     */
    async aiFilterData(data) {
        if (!data || !Array.isArray(data) || data.length === 0) {
            return [];
        }
        const filters = [
            // 上架时间范围校验
            (item) => {
                const result = this.checkRange(item.releaseDate, undefined, 365);
                return result;
            },
            // 跟卖人数范围校验
            (item) => {
                const result = this.checkRange(item.sellerNumber, undefined, 30);
                return result;
            },
            // 月销售动态范围校验
            (item) => {
                const result = item.salesDynamics > 0;
                return result;
            },
            // 广告份额范围校验
            (item) => {
                const result = this.checkRange(item.drr, undefined, 15);
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
                const rule = rules.find((r) => Number(item.price) <= r.max);
                return this.checkRange(item.soldCount, (rule?.minSold || 5) + 1);
            },
        ];
        const filteredData = data.filter((item) => {
            const results = filters.map((filterFn) => filterFn(item));
            const overallResult = results.every((r) => r);
            return overallResult;
        });
        return filteredData;
    }
    /**
     * 数据过滤
     */
    async filterData(data, task, type = 'merge') {
        if (!data || !Array.isArray(data) || data.length === 0) {
            return [];
        }
        // 定义过滤条件映射
        const filters = [
            // 品牌类型过滤
            (item) => {
                if (task?.brandType === undefined || task?.brandType === null || +task?.brandType === 2)
                    return true;
                if (+task?.brandType === 0)
                    return item.brand && item.brand.trim();
                if (+task?.brandType === 1)
                    return !(item.brand && item.brand.trim());
                return true;
            },
            // 销量范围校验
            (item) => {
                const result = this.checkRange(item.soldCount, task.soldCountMin, task.soldCountMax);
                return result;
            },
            // 月销售额范围校验
            (item) => {
                const result = this.checkRange(item.gmvSum, task.gmvSumMin, task.gmvSumMax);
                return result;
            },
            // 上架时间范围校验
            (item) => {
                const result = this.checkRange(item.releaseDate, task.upGoodsTimeMin, task.upGoodsTimeMax);
                return result;
            },
            // 月销售动态范围校验
            (item) => {
                const result = this.checkRange(item.salesDynamics, task.monthDynamicsMin, task.monthDynamicsMax);
                return result;
            },
            // 广告份额范围校验
            (item) => {
                const result = this.checkRange(item.drr, task.adFeeMin, task.adFeeMax);
                return result;
            },
            // 参与促销天数范围校验
            (item) => {
                const result = this.checkRange(item.daysInPromo, task.promotionDayMin, task.promotionDayMax);
                return result;
            },
            // 参与促销折扣范围校验
            (item) => {
                const result = this.checkRange(item.discount, task.promotionDiscountMin, task.promotionDiscountMax);
                return result;
            },
            // 促销活动转化率范围校验
            (item) => {
                const result = this.checkRange(item.promoRevenueShare, task.promotionDynamicsMin, task.promotionDynamicsMax);
                return result;
            },
            // 付费推广天数范围校验
            (item) => {
                const result = this.checkRange(item.daysWithTrafarets, task.promoteDayMin, task.promoteDayMax);
                return result;
            },
            // 浏览量范围校验
            (item) => {
                const result = this.checkRange(item.sessionCount, task.viewsMin, task.viewsMax);
                return result;
            },
            // 商品卡片加购率范围校验
            (item) => {
                const result = this.checkRange(item.convToCartPdp, task.cardRateMin, task.cardRateMax);
                return result;
            },
            // 搜索和目录加购率范围校验
            (item) => {
                const result = this.checkRange(item.convToCartSearch, task.showRateMin, task.showRateMax);
                return result;
            },
            // 发货模式校验
            (item) => {
                if (!task.salesSchema)
                    return true;
                const result = task.salesSchema?.includes(item.salesSchema);
                return result;
            },
            // 点击率校验
            (item) => {
                const result = this.checkRange(item.clickRate, task.clickRateMin, task.clickRateMax);
                return result;
            },
            // 成交率校验
            (item) => {
                const result = this.checkRange(item.nullableRedemptionRate, task.nullableRedemptionRateMin, task.nullableRedemptionRateMax);
                return result;
            },
            // 重量范围校验
            (item) => {
                const result = this.checkRange(item.weight, task.weightRangeMin, task.weightRangeMax);
                return result;
            },
            // 包装长度范围校验
            (item) => {
                const result = this.checkRange(item.length, task.packageLengthMin, task.packageLengthMax);
                return result;
            },
            // 包装高度范围校验
            (item) => {
                const result = this.checkRange(item.height, task.packageHeightMin, task.packageHeightMax);
                return result;
            },
            // 包装宽度范围校验
            (item) => {
                const result = this.checkRange(item.width, task.packageWidthMin, task.packageWidthMax);
                return result;
            },
            // 退货取消率校验
            (item) => {
                const result = this.checkRange(item.returnCancelRate, task.returnCancelRateMin, task.returnCancelRateMax);
                return result;
            },
        ];
        const filters2 = [
            // 销售价格范围校验
            (item) => {
                const result = this.checkRange(item.price, task.salePriceMin, task.salePriceMax);
                return result;
            },
            // 跟卖人数范围校验
            (item) => {
                const result = this.checkRange(item.sellerNumber, task.followMin, task.followMax);
                return result;
            },
            // 评论数校验
            (item) => {
                const result = this.checkRange(item.reviewCountLabel, task.numberOfCommentsMin, task.numberOfCommentsMax);
                return result;
            },
            // 评分范围校验
            (item) => {
                const result = this.checkRange(item.rating, task.ratingMin, task.ratingMax);
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
    checkRange(value, min, max) {
        if ((min === undefined && max === undefined) || (min === null && max === null))
            return true;
        let num = 0;
        if (value !== undefined && value !== null)
            num = Number(value);
        if (isNaN(num))
            return false;
        if (min !== undefined && min !== null && num < min)
            return false;
        if (max !== undefined && max !== null && num > max)
            return false;
        return true;
    }
    /**
     * 利润率判断
     * @param value 待检查的值
     * @param target 目标
     * @returns 是否符合范围
     */
    checkTargetProfitPercent(value, target) {
        if (value === undefined || value === null)
            return false;
        if (isNaN(Number(value)))
            return false;
        if (!target && Number(target) !== 0)
            return true;
        return Number(value) >= target;
    }
    /**
     * 销毁实例
     */
    destroy() {
        this.data.clear();
        this.cancellationSignal = null;
    }
}

import {
    getCollectorCategoryMappings,
    getSonliState,
} from '../collector-backend.services.js';
import { sonliRequest } from '../sonli-api.services.js';

function success(data, message = '获取成功') {
    // 保留恢复版 renderer 约定的 code=400 成功结构。
    return { code: 400, data, message };
}

function failure(error) {
    return {
        code: 500,
        data: null,
        message: error?.message || String(error || '获取失败'),
    };
}

export const getLogisticsList = async () => {
    try {
        const payload = await sonliRequest({ method: 'get', url: '/pricing/config/active' });
        const config = payload?.config || payload?.data?.config || payload || {};
        return success(config.logistics || config.logisticsRules || []);
    }
    catch (error) {
        return failure(error);
    }
};

export const getShopList = async () => {
    try {
        const state = await getSonliState();
        const stores = state?.stores || state?.state?.stores || [];
        return success(stores.map((store) => ({
            ...store,
            client_id: store.id,
            shop_name: store.label || store.companyName || store.name || store.id,
            currency_code: store.currencyCode || store.currency || 'RUB',
            warehouse: store.warehouse || store.warehouses || [],
        })));
    }
    catch (error) {
        return failure(error);
    }
};

export const getConfigList = async () => {
    try {
        const payload = await sonliRequest({ method: 'get', url: '/pricing/config/active' });
        const config = payload?.config || payload?.data?.config || payload || {};
        return success({ data: config ? [config] : [] });
    }
    catch (error) {
        return failure(error);
    }
};

export const getCategoryList = async () => {
    try {
        const payload = await getCollectorCategoryMappings();
        const mappings = payload?.mappings || payload?.data?.mappings || payload?.items || [];
        const roots = new Map();
        for (const mapping of mappings) {
            const rootId = String(mapping.rootCategoryId || mapping.category1Id || mapping.rootId || '');
            const leafId = String(mapping.leafCategoryId || mapping.categoryId || mapping.leafId || '');
            if (!rootId || !leafId)
                continue;
            if (!roots.has(rootId)) {
                roots.set(rootId, {
                    category_id: rootId,
                    name: mapping.rootCategoryName || mapping.category1Name || rootId,
                    children: [],
                });
            }
            const root = roots.get(rootId);
            if (!root.children.some((item) => String(item.category_id) === leafId)) {
                root.children.push({
                    category_id: leafId,
                    name: mapping.leafCategoryName || mapping.categoryName || leafId,
                });
            }
        }
        return success([
            {
                category_id: "__all__",
                name: "全部类目",
                children: [{ category_id: "*", name: "全部类目（自动学习最新类目）" }],
            },
            ...roots.values(),
        ]);
    }
    catch (error) {
        return failure(error);
    }
};

import { getSonliState } from '../collector-backend.services.js';
import { fetchSellerCategoryTree, getSellerSessionStatus, verifyCurrentSellerStore, acquireSellerRoute } from '../seller-ozon.services.js';
import { getAccountPartition } from '../session.services.js';
import { operationStore } from '../../store/index.js';

import { categoryTreeBaseline } from './category-tree-baseline.js';

const CATEGORY_CACHE_MS = 24 * 60 * 60 * 1000;
const categoryReads = new Map();

function success(data, message = '获取成功') {
    // 保留恢复版 renderer 约定的 code=400 成功结构。
    return { code: 400, data, message };
}

function failure(error) {
    return { code: 500, data: null, message: error?.message || String(error || '获取失败') };
}

function withAllCategories(categories) {
    return [{
        category_id: "__all__",
        name: "全部类目",
        children: [{ category_id: '*', name: '全部类目（不按类目筛选）' }],
    }, ...categories];
}

function normalizeCategoryTree(payload) {
    function convert(node) {
        if (!node || node.disabled)
            return null;
        const children = Object.values(node.nodes || {}).map(convert).filter(Boolean);
        const typeId = String(node.descriptionTypeId || '0');
        const id = children.length ? String(node.descriptionCategoryId || '') : typeId;
        if (!/^\d+$/.test(id) || id === '0')
            return null;
        return {
            category_id: id,
            name: (children.length ? node.descriptionCategoryName : node.descriptionTypeName || node.descriptionCategoryName) || id,
            ...(children.length ? { children } : {}),
        };
    }
    const categories = Object.values(payload?.result || {}).map(convert).filter(Boolean);
    if (!categories.length)
        throw new Error('Ozon 未返回可用类目，请确认 Seller 登录后重试');
    return categories;
}

function baselineCategories(error) {
    return {
        ...categoryTreeBaseline,
        source: 'baseline', stale: true, fetchedAt: 0, updateFailed: Boolean(error),
        message: `内置类目基线可直接选择${error ? `；本次未能更新：${error.message}` : ''}`,
    };
}

async function loadLocalCategories() {
    const partition = getAccountPartition('seller');
    const status = await getSellerSessionStatus({ verify: true });
    if (partition !== getAccountPartition('seller'))
        throw Object.assign(new Error('采集助手账号已变化，请重新加载类目'), { code: 'SELLER_SOURCE_CONTEXT_CHANGED' });
    const cached = status.verification && operationStore.get(`collector-category-tree:${partition}:${status.verification.sourceIdentity}`);
    if (cached) {
        const stale = Date.now() - cached.fetchedAt >= CATEGORY_CACHE_MS;
        return { ...cached, source: 'cache', stale, message: stale ? '缓存已过期，等待后台检查更新' : '已加载本地缓存类目' };
    }
    return baselineCategories();
}

async function loadCategoryTree(options = {}) {
    const sellerOptions = { silent: options.background === true };
    const verification = await verifyCurrentSellerStore(options.expectedContext, sellerOptions);
    const key = `collector-category-tree:${getAccountPartition('seller')}:${verification.sourceIdentity}`;
    const cached = operationStore.get(key);
    if (!options.refresh && cached && Date.now() - cached.fetchedAt < CATEGORY_CACHE_MS)
        return { ...cached, source: 'cache', stale: false, message: '已加载缓存类目' };
    if (!categoryReads.has(key)) {
        const pending = (async () => {
            try {
                const payload = await fetchSellerCategoryTree({ expectedContext: verification, ...sellerOptions });
                const categories = normalizeCategoryTree(payload);
                await verifyCurrentSellerStore(verification, sellerOptions);
                const saved = { categories, fetchedAt: Date.now() };
                operationStore.set(key, saved);
                return { ...saved, source: 'live', stale: false, message: '已加载最新类目' };
            }
            catch (error) {
                // A late response must never cross an account or Seller change.
                await verifyCurrentSellerStore(verification, sellerOptions);
                if (cached)
                    return { ...cached, source: 'cache', stale: true, updateFailed: true, message: `刷新失败，暂用缓存类目：${error.message}` };
                throw error;
            }
            finally {
                categoryReads.delete(key);
            }
        })();
        categoryReads.set(key, pending);
    }
    return categoryReads.get(key);
}

function categoryReadWithCancellation(pending, signal) {
    if (!signal)
        return pending;
    return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('采集任务已取消'), { code: 'COLLECTION_CANCELLED' }));
        if (signal.aborted) {
            pending.catch(() => {});
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

export async function resolveCollectorCategoryIds(paths = [], options = {}) {
    const flattened = paths.flat(2).map(String);
    if (!flattened.length || flattened.includes('*') || flattened.includes('__all__'))
        return [];
    const { categories } = await categoryReadWithCancellation(loadAvailableCategories(options), options.signal);
    const nodes = new Map();
    function index(items) {
        for (const node of items) {
            nodes.set(node.category_id, node);
            if (node.children)
                index(node.children);
        }
    }
    index(categories);
    const ids = new Set();
    function add(node) {
        if (node.children)
            node.children.forEach(add);
        else
            ids.add(node.category_id);
    }
    for (const path of paths) {
        const id = String(Array.isArray(path) ? path.at(-1) || '' : path || '');
        if (nodes.has(id))
            add(nodes.get(id));
        else if (id)
            ids.add(id); // Preserve historical leaf IDs absent from today's tree.
    }
    return [...ids];
}

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

async function loadAvailableCategories(options = {}) {
    if (options.localOnly)
        return loadLocalCategories();
    // A running collection already owns its route. Independent picker refreshes
    // synchronize once and keep that route until their complete read finishes.
    const lease = options.expectedContext ? null : await acquireSellerRoute({ signal: options.signal });
    const partition = getAccountPartition('seller');
    try {
        return await loadCategoryTree(options);
    }
    catch (error) {
        if (error?.code === 'SELLER_SOURCE_CONTEXT_CHANGED')
            throw error;
        if (partition !== getAccountPartition('seller'))
            throw Object.assign(new Error('采集助手账号已变化，请重新加载类目'), { code: 'SELLER_SOURCE_CONTEXT_CHANGED' });
        // Task execution still verifies its saved Seller context before using
        // the same snapshot that was available in the picker.
        if (options.expectedContext)
            await verifyCurrentSellerStore(options.expectedContext, { silent: options.background === true });
        return baselineCategories(error);
    }
    finally { lease?.release(); }
}

export const getCategoryList = async (options = {}) => {
    try {
        const { categories, ...metadata } = await loadAvailableCategories(options);
        return { ...success(withAllCategories(categories)), ...metadata };
    }
    catch (error) {
        return failure(error);
    }
};

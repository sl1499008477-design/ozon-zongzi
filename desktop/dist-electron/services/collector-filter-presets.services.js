import { createHash, randomUUID } from 'node:crypto';
import { operationStore } from '../store/index.js';
import { runtimeConfig } from '../config/runtime.js';

const rangeNames = ['soldCount', 'gmvSum', 'salePrice', 'upGoodsTime', 'monthDynamics',
    'adFee', 'promotionDay', 'promotionDiscount', 'promotionDynamics', 'promoteDay',
    'views', 'cardRate', 'showRate', 'clickRate', 'nullableRedemptionRate',
    'returnCancelRate', 'weightRange', 'packageLength', 'packageHeight', 'packageWidth',
    'follow', 'numberOfComments', 'rating'];

function accountStorageKey() {
    const user = operationStore.get('user');
    const id = user?.id || user?._id;
    if (!operationStore.get('token') || !id) throw new Error('请先登录采集助手');
    // Server and account identity come from main-process state, never IPC input.
    const scope = createHash('sha256').update(`${runtimeConfig.sonliApiBase}\0${id}`).digest('hex');
    return `collector-filter-presets.${scope}`;
}

export function listCollectorFilterPresets() {
    return { items: operationStore.get(accountStorageKey()) || [] };
}

export function saveCollectorFilterPreset(input = {}) {
    return writeCollectorFilterPreset(input, false);
}

export function updateCollectorFilterPreset(input = {}) {
    return writeCollectorFilterPreset(input, true);
}

function writeCollectorFilterPreset(input, updating) {
    const key = accountStorageKey();
    const items = operationStore.get(key) || [];
    const existing = updating ? items.find(item => item.id === input.id) : null;
    if (updating && !existing) throw new Error('方案不存在，请刷新常用方案');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 60) throw new Error('方案名称需要填写 1–60 个字符');
    const source = input.filters;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('请先设置自定义选品条件');
    const filters = {};
    if (source.salePriceBasis !== undefined) {
        if (!['storefrontCny', 'sellerRub'].includes(source.salePriceBasis)) throw new Error('请选择有效的价格筛选口径');
        filters.salePriceBasis = source.salePriceBasis;
    }
    for (const range of rangeNames) {
        for (const suffix of ['Min', 'Max']) {
            const field = range + suffix, value = source[field];
            if (value === undefined || value === null || value === '') continue;
            if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value))) throw new Error('选品条件必须填写有效数值');
            filters[field] = Number(value);
        }
        if (filters[range + 'Min'] !== undefined && filters[range + 'Max'] !== undefined
            && filters[range + 'Min'] > filters[range + 'Max']) throw new Error('最小值不能超过最大值');
    }
    filters.brandType = source.brandType ?? '2';
    if (!['0', '1', '2'].includes(filters.brandType)) throw new Error('请选择有效的品牌类型');
    if (source.salesSchema !== undefined && source.salesSchema !== null && source.salesSchema !== '') {
        if (!['FBO', 'FBS', 'FBO,FBS'].includes(source.salesSchema)) throw new Error('请选择有效的发货模式');
        filters.salesSchema = source.salesSchema;
    }
    if (items.some(item => item.id !== existing?.id && item.name === name)) throw new Error('已有同名方案，请换一个名称');
    const now = new Date().toISOString();
    const item = { id: existing?.id || randomUUID(), name, filters, createdAt: existing?.createdAt || now,
        ...(updating ? { updatedAt: now } : {}) };
    const saved = updating ? items.map(row => row.id === item.id ? item : row) : [item, ...items];
    operationStore.set(key, saved);
    return { items: saved, item };
}

export function deleteCollectorFilterPreset(input = {}) {
    const key = accountStorageKey();
    const items = operationStore.get(key) || [];
    if (!items.some(item => item.id === input.id)) throw new Error('方案不存在，请刷新常用方案');
    const saved = items.filter(item => item.id !== input.id);
    operationStore.set(key, saved);
    return { items: saved };
}

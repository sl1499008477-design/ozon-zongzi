const FRONTEND_STATUS = Object.freeze({
    NOT_STARTED: 'noExecuted',
    QUEUED: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});
const BACKEND_STATUS = Object.freeze(Object.fromEntries(
    Object.entries(FRONTEND_STATUS).map(([backend, frontend]) => [frontend, backend]),
));

export function objectValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const RETIRED_SCOPE_KEY = /^(?:accountId|createdBy|client_id|storeId|store_id|operatingStoreId|operating_store_id|dataCollectionStoreId|data_collection_store_id|sellerCompanyId|seller_company_id|legacyScope)$/i;

function withoutRetiredScope(value) {
    if (Array.isArray(value))
        return value.map(withoutRetiredScope);
    if (!value || typeof value !== 'object')
        return value;
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
        if (!RETIRED_SCOPE_KEY.test(key))
            result[key] = withoutRetiredScope(nested);
    }
    return result;
}

export function normalizeCollectorTask(raw = {}) {
    const source = objectValue(raw.task || raw);
    const configuration = objectValue(source.configuration || source.config || source.taskConfig);
    const id = String(source.id || source._id || source.taskId || '');
    const rawStatus = String(source.status || source.taskStatus || 'NOT_STARTED');
    const sourceLegacyScope = objectValue(source.legacyScope);
    const legacyOperatingStoreId = sourceLegacyScope.operatingStoreId
        || source.operatingStoreId
        || source.storeId
        || configuration.operatingStoreId
        || configuration.storeId;
    const legacyDataCollectionStoreId = sourceLegacyScope.dataCollectionStoreId
        || source.dataCollectionStoreId
        || configuration.dataCollectionStoreId;
    const legacyScope = {
        ...(legacyOperatingStoreId
            ? { operatingStoreId: String(legacyOperatingStoreId) }
            : {}),
        ...(legacyDataCollectionStoreId
            ? { dataCollectionStoreId: String(legacyDataCollectionStoreId) }
            : {}),
    };
    const publicConfiguration = objectValue(withoutRetiredScope(configuration));
    const publicSource = objectValue(withoutRetiredScope(source));
    const normalized = {
        ...publicConfiguration,
        ...publicSource,
        _id: id,
        taskId: id,
        taskName: source.name || source.taskName || configuration.taskName || '未命名任务',
        taskStatus: FRONTEND_STATUS[rawStatus.toUpperCase()] || rawStatus,
        operatingStoreId: null,
        configuration: publicConfiguration,
        ...(Object.keys(legacyScope).length ? { legacyScope } : {}),
    };
    delete normalized.dataCollectionStoreId;
    delete normalized.sellerCompanyId;
    return normalized;
}

export function toCollectorTaskPayload(input = {}) {
    const source = objectValue(input);
    const configuration = {
        ...source,
        _id: undefined,
        id: undefined,
        taskId: undefined,
        taskStatus: undefined,
        status: undefined,
        progress: undefined,
        tableFilePath: undefined,
        autoResult: undefined,
        configuration: undefined,
        config: undefined,
        taskConfig: undefined,
        currentRunId: undefined,
        statusVersion: undefined,
        lastErrorCode: undefined,
    };
    for (const key of Object.keys(configuration)) {
        if (configuration[key] === undefined
            || /auto.*(?:up|publish).*goods/i.test(key)
            || /^(?:token|password|pwd|cookie|authorization)$/i.test(key))
            delete configuration[key];
    }
    const requestedConcurrency = Number(source.concurrency || source.maxConcurrent || 4);
    const concurrency = Math.min(20, Math.max(2, Number.isFinite(requestedConcurrency) ? requestedConcurrency : 4));
    return {
        name: String(source.taskName || source.name || '未命名任务').trim(),
        taskType: String(source.taskType || (+source.isUseCategorySelect === 0 ? 'CATEGORY' : 'URL')).toUpperCase(),
        operatingStoreId: null,
        configuration: withoutRetiredScope(configuration),
        concurrency,
    };
}

export function toCollectorTaskQuery(input = {}) {
    const status = BACKEND_STATUS[String(input.taskStatus || input.status || '')] || undefined;
    const taskName = String(input.taskName || '').trim() || undefined;
    return {
        page: Number(input.pageNo || input.page || 1),
        pageSize: Number(input.pageSize || 20),
        taskName,
        status,
    };
}

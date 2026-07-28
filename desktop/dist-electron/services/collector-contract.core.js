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

export function normalizeCollectorTask(raw = {}) {
    const source = objectValue(raw.task || raw);
    const configuration = objectValue(source.configuration || source.config || source.taskConfig);
    const id = String(source.id || source._id || source.taskId || '');
    const rawStatus = String(source.status || source.taskStatus || 'NOT_STARTED');
    return {
        ...configuration,
        ...source,
        _id: id,
        taskId: id,
        taskName: source.name || source.taskName || configuration.taskName || '未命名任务',
        taskStatus: FRONTEND_STATUS[rawStatus.toUpperCase()] || rawStatus,
        operatingStoreId: source.operatingStoreId || configuration.operatingStoreId || '',
        dataCollectionStoreId: source.dataCollectionStoreId || configuration.dataCollectionStoreId || '',
    };
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
        operatingStoreId: String(source.operatingStoreId || source.storeId || source.client_id || ''),
        dataCollectionStoreId: String(source.dataCollectionStoreId || ''),
        configuration,
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

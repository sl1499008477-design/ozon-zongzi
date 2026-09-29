import { withoutCollectorScope } from './collector-scope.core.js';

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
    const publicConfiguration = objectValue(withoutCollectorScope(configuration));
    const publicSource = objectValue(withoutCollectorScope(source));
    const run = objectValue(source.currentRun);
    const runProgress = objectValue(run.progress);
    const progress = run.id ? {
        current: 0, // In-flight concurrency is known only by the local active task.
        total: runProgress.totalCount ?? run.totalCount ?? 0,
        totalCount: run.resultSummary?.collectedCount ?? runProgress.qualifiedCount ?? run.qualifiedCount ?? 0,
        ...((runProgress.qualifiedSkuCount ?? run.qualifiedSkuCount) != null
            ? { skuCount: runProgress.qualifiedSkuCount ?? run.qualifiedSkuCount } : {}),
    } : { ...objectValue(source.progress) };
    const dedup = objectValue(run.id ? run.resultSummary?.dedup : progress.dedup);
    progress.dedup = {
        collected: dedup.collected ?? 0,
        listed: dedup.listed ?? 0,
        collecting: dedup.collecting ?? 0,
    };
    if (run.id) {
        const skipped = run.progress?.filteredCount ?? run.filteredCount ?? 0;
        const failed = run.progress?.failedCount ?? run.failedCount ?? 0;
        if (skipped || failed) progress.outcomes = { skipped, failed };
    }
    const normalized = {
        ...publicConfiguration,
        ...publicSource,
        _id: id,
        taskId: id,
        taskName: source.name || source.taskName || configuration.taskName || '未命名任务',
        taskStatus: FRONTEND_STATUS[rawStatus.toUpperCase()] || rawStatus,
        createTime: source.createdAt ?? source.createTime ?? null,
        lastRunningTime: Object.hasOwn(source, 'lastStartedAt')
            ? source.lastStartedAt : run.startedAt ?? source.lastRunningTime ?? null,
        progress,
        tableFilePath: run.resultSummary?.exportedFilePath || source.tableFilePath || '',
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
        captureScope: source.captureScope === 'ALL' ? 'ALL'
            : source.captureScope === 'CURRENT' || source._id || source.id || source.taskId ? 'CURRENT' : 'ALL',
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
        currentRun: undefined,
        lastStartedAt: undefined,
        createTime: undefined,
        lastRunningTime: undefined,
        createdAt: undefined,
        updatedAt: undefined,
        deletedAt: undefined,
        statusVersion: undefined,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        lastLog: undefined,
        startError: undefined,
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
        configuration: withoutCollectorScope(configuration),
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

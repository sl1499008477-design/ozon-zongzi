import { randomUUID } from 'node:crypto';
import { operationStore } from '../store/index.js';
import { sonliRequest } from './sonli-api.services.js';
import {
    normalizeCollectorTask,
    objectValue,
    toCollectorTaskQuery,
    toCollectorTaskPayload,
} from './collector-contract.core.js';
import { withoutCollectorScope } from './collector-scope.core.js';
import { runtimeConfig } from '../config/runtime.js';
export { normalizeCollectorTask, toCollectorTaskPayload, toCollectorTaskQuery } from './collector-contract.core.js';

function unwrapTask(payload) {
    return normalizeCollectorTask(payload?.task || payload?.data?.task || payload?.data || payload);
}

function unwrapRun(payload) {
    return payload?.run || payload?.data?.run || payload?.data || payload;
}

export function getDesktopDeviceId() {
    let id = String(operationStore.get('desktop-device-id') || '');
    if (!id) {
        id = `desktop_${randomUUID()}`;
        operationStore.set('desktop-device-id', id);
    }
    return id;
}

export async function listCollectorAiConfigs() {
    const payload = await sonliRequest({ method: 'get', url: '/ai-listing/presets/configs' });
    return { items: payload.items || [], url: `${runtimeConfig.sonliWebBase}/ozon/tools/ai-listing` };
}

async function freezeCollectorAiConfig(input = {}) {
    const data = { ...input };
    delete data.aiListingConfigSnapshot;
    data.autoStartAiGeneration = data.autoSendToAiListing === true && data.autoStartAiGeneration === true;
    if (!data.autoStartAiGeneration) {
        delete data.aiListingConfigId;
        delete data.aiListingConfigUpdatedAt;
        delete data.aiAutoSubmitConfirmed;
        return data;
    }
    if (!data.aiListingConfigId) throw new Error('请选择已保存的 AI 上架配置');
    const { item } = await sonliRequest({ method: 'get', url: `/ai-listing/presets/configs/${encodeURIComponent(data.aiListingConfigId)}` });
    if (!item?.config || !data.aiListingConfigUpdatedAt || item.updatedAt !== data.aiListingConfigUpdatedAt)
        throw new Error('上架配置已更新，请刷新版本并重新确认');
    if (item.config.manualReview !== true && data.aiAutoSubmitConfirmed !== true)
        throw new Error('此配置会在生图后自动提交至 Ozon，请先确认自动上架');
    const { item: prompt } = await sonliRequest({ method: 'get', url: `/ai-listing/presets/prompts/${encodeURIComponent(item.config.promptId || '')}` });
    if (!prompt?.content) throw new Error('此配置的提示词已删除或不存在，请到 AI 上架页面重新配置');
    const { promptId, ...config } = item.config;
    data.aiListingConfigSnapshot = { id: item.id, name: item.name, updatedAt: item.updatedAt,
        promptId, promptUpdatedAt: prompt.updatedAt, config: { ...config, prompt: prompt.content } };
    return data;
}

export async function createCollectorTask(input) {
    const data = withoutCollectorScope(toCollectorTaskPayload(await freezeCollectorAiConfig(input)));
    const payload = await sonliRequest({
        method: 'post',
        url: '/collector/tasks',
        data,
    });
    return unwrapTask(payload);
}

export async function getCollectorTask(id) {
    const payload = await sonliRequest({ method: 'get', url: `/collector/tasks/${encodeURIComponent(id)}` });
    return unwrapTask(payload);
}

export async function updateCollectorTask(id, input, expectedVersion) {
    const data = withoutCollectorScope(toCollectorTaskPayload(await freezeCollectorAiConfig(input)));
    if (expectedVersion != null)
        data.expectedVersion = expectedVersion;
    const payload = await sonliRequest({
        method: 'patch',
        url: `/collector/tasks/${encodeURIComponent(id)}`,
        data,
    });
    return unwrapTask(payload);
}

export async function copyCollectorTask(id, fallbackTask = {}) {
    const original = id ? await getCollectorTask(id) : normalizeCollectorTask(fallbackTask);
    return createCollectorTask({
        ...original,
        ...objectValue(original.configuration),
        _id: undefined,
        id: undefined,
        taskId: undefined,
        taskName: `${original.taskName || '任务'} - 副本`,
        taskStatus: 'noExecuted',
    });
}

export async function listCollectorTasks(params = {}) {
    const payload = await sonliRequest({
        method: 'get',
        url: '/collector/tasks',
        params: toCollectorTaskQuery(params),
    });
    const source = payload?.tasks || payload?.data?.tasks || payload?.data?.list || payload?.list || [];
    const list = Array.isArray(source) ? source.map(normalizeCollectorTask) : [];
    return {
        list,
        total: Number(payload?.total ?? payload?.data?.total ?? list.length),
        pageNo: Number(payload?.page ?? payload?.data?.page ?? params.pageNo ?? 1),
        pageSize: Number(payload?.pageSize ?? payload?.data?.pageSize ?? params.pageSize ?? 20),
    };
}

export async function deleteCollectorTask(id, expectedVersion) {
    const data = expectedVersion == null ? undefined : { expectedVersion };
    return sonliRequest({ method: 'delete', url: `/collector/tasks/${encodeURIComponent(id)}`, data });
}

export async function createCollectorRun(id, options = {}) {
    const payload = await sonliRequest({
        method: 'post',
        url: `/collector/tasks/${encodeURIComponent(id)}/runs`,
        data: {
            idempotencyKey: options.idempotencyKey || randomUUID(),
        },
    });
    return unwrapRun(payload);
}

export async function claimCollectorRun(runId, options = {}) {
    const payload = await sonliRequest({
        method: 'post',
        url: `/collector/runs/${encodeURIComponent(runId)}/claim`,
        data: {
            deviceId: options.deviceId || getDesktopDeviceId(),
            leaseSeconds: options.leaseSeconds || 120,
        },
    });
    return {
        run: unwrapRun(payload),
        leaseToken: String(payload?.leaseToken || payload?.data?.leaseToken || ''),
        reclaimed: Boolean(payload?.reclaimed || payload?.data?.reclaimed),
    };
}

export function heartbeatCollectorRun(runId, leaseToken, progress = {}) {
    return sonliRequest({
        method: 'post',
        url: `/collector/runs/${encodeURIComponent(runId)}/heartbeat`,
        data: {
            deviceId: getDesktopDeviceId(),
            leaseToken,
            leaseSeconds: 120,
            progress: withoutCollectorScope(progress),
        },
    });
}

export function requestCollectorRunCancellation(runId) {
    return sonliRequest({
        method: 'post',
        url: `/collector/runs/${encodeURIComponent(runId)}/cancel-request`,
        data: {},
    });
}

export function appendCollectorRunItem(runId, leaseToken, item, deviceId = getDesktopDeviceId()) {
    return sonliRequest({
        method: 'post',
        url: `/collector/runs/${encodeURIComponent(runId)}/items`,
        data: {
            deviceId,
            leaseToken,
            items: [withoutCollectorScope(item)],
        },
    });
}

export function claimCollectorRunSkus(runId, leaseToken, skus) {
    return sonliRequest({ method: 'post', url: `/collector/runs/${encodeURIComponent(runId)}/skus/claim`,
        data: { deviceId: getDesktopDeviceId(), leaseToken, skus } });
}

export function releaseCollectorRunSkus(runId, leaseToken, skus) {
    return sonliRequest({ method: 'post', url: `/collector/runs/${encodeURIComponent(runId)}/skus/release`,
        data: { deviceId: getDesktopDeviceId(), leaseToken, skus } });
}

export function appendCollectorRunEvent(runId, event) {
    return sonliRequest({
        method: 'post',
        url: `/collector/runs/${encodeURIComponent(runId)}/events`,
        data: withoutCollectorScope(event),
    });
}

export async function getCollectorCapabilities() {
    try {
        const payload = await sonliRequest({ method: 'get', url: '/collector/capabilities', quiet: true });
        return payload?.capabilities || {};
    }
    catch { return {}; } // Older/offline servers keep the complete legacy payload and event contract.
}

export function issueCollectorMediaUpload(runId, leaseToken, media, {signal} = {}) {
    return sonliRequest({ method: 'post', url: `/collector/runs/${encodeURIComponent(runId)}/media-uploads`, signal,
        data: { ...media, deviceId: getDesktopDeviceId(), leaseToken } });
}

export function confirmCollectorMediaUpload(runId, leaseToken, uploadId, {signal} = {}) {
    return sonliRequest({ method: 'post', url: `/collector/runs/${encodeURIComponent(runId)}/media-uploads/${encodeURIComponent(uploadId)}/confirm`, signal, timeout: 60_000, quiet: true,
        data: { deviceId: getDesktopDeviceId(), leaseToken } });
}

export function appendCollectorRunEvents(runId, events) {
    return sonliRequest({ method: 'post', url: `/collector/runs/${encodeURIComponent(runId)}/events`,
        data: { events: events.map(withoutCollectorScope) } });
}

export function completeCollectorRun(runId, leaseToken, resultSummary = {}) {
    return sonliRequest({
        method: 'post',
        url: `/collector/runs/${encodeURIComponent(runId)}/complete`,
        data: { deviceId: getDesktopDeviceId(), leaseToken, resultSummary: withoutCollectorScope(resultSummary) },
    });
}

export function failCollectorRun(runId, leaseToken, error) {
    return sonliRequest({
        method: 'post',
        url: `/collector/runs/${encodeURIComponent(runId)}/fail`,
        data: {
            deviceId: getDesktopDeviceId(),
            leaseToken,
            errorCode: error?.code || 'COLLECTION_FAILED',
            errorMessage: String(error?.message || error || '采集失败').slice(0, 500),
        },
    });
}

export function cancelCollectorRun(runId, leaseToken, resultSummary = {}) {
    return sonliRequest({
        method: 'post',
        url: `/collector/runs/${encodeURIComponent(runId)}/cancel`,
        data: {
            deviceId: getDesktopDeviceId(),
            leaseToken,
            resultSummary: withoutCollectorScope(resultSummary),
        },
    });
}

export function saveCollectorMarketSnapshot(snapshot) {
    return sonliRequest({
        method: 'post',
        url: '/collector/market-snapshots',
        data: withoutCollectorScope(snapshot),
    });
}

export function getCollectorCategoryMappings(params = {}) {
    return sonliRequest({
        method: 'get',
        url: '/collector/category-mappings',
        params: withoutCollectorScope(params),
    });
}

export function saveCollectorCategoryMapping(mapping = {}) {
    return sonliRequest({
        method: 'post',
        url: '/collector/category-mappings',
        data: withoutCollectorScope(mapping),
    });
}

export function getSonliState() {
    return sonliRequest({ method: 'get', url: '/local/state?view=bootstrap' });
}

export async function listCollectorRunsForTask(taskId, params = {}) {
    const payload = await sonliRequest({
        method: 'get',
        url: `/collector/tasks/${encodeURIComponent(taskId)}/runs`,
        params: {
            limit: Number(params.limit || 20),
            offset: Number(params.offset || 0),
        },
    });
    const runs = payload?.runs || payload?.data?.runs || [];
    return Array.isArray(runs) ? runs : [];
}

export async function listCollectorRunItems(runId, params = {}) {
    const payload = await sonliRequest({
        method: 'get',
        url: `/collector/runs/${encodeURIComponent(runId)}/items`,
        params: {
            status: params.status || '',
            ...(params.view === 'identity' ? { view: 'identity' } : {}),
            limit: Number(params.limit || 500),
            offset: Number(params.offset || 0),
        },
    });
    const items = payload?.items || payload?.data?.items || [];
    return Array.isArray(items) ? items : [];
}

export async function getCollectorRun(runId) {
    if (!runId) throw new Error('该任务还没有可查看的运行记录');
    return unwrapRun(await sonliRequest({ method: 'get', url: `/collector/runs/${encodeURIComponent(runId)}` }));
}

export async function resumeCollectorRun(runId) {
    if (!runId) throw new Error('该任务还没有可继续的运行记录');
    return unwrapRun(await sonliRequest({ method: 'post', url: `/collector/runs/${encodeURIComponent(runId)}/resume`, data: {} }));
}

export async function listCollectorRunResults(runId, { limit = 50, offset = 0 } = {}) {
    const payload = await sonliRequest({ method: 'get', url: `/collector/runs/${encodeURIComponent(runId)}/results`,
        params: { limit, offset } });
    return { ...payload, collectBoxUrl: `${runtimeConfig.sonliWebBase}/ozon/products/collect`,
        aiTaskUrl: `${runtimeConfig.sonliWebBase}/ozon/tools/ai-listing?tab=tasks` };
}

export async function listCollectorOutcomeItems(runId, status) {
    const items = [];
    for (let offset = 0; ; offset += 500) {
        const page = await listCollectorRunItems(runId, { status, limit: 500, offset });
        items.push(...page);
        if (page.length < 500) return items;
    }
}

export async function readCollectorRunOutcomes({ runId } = {}) {
    const run = await getCollectorRun(runId);
    const [failed, skipped] = await Promise.all([
        listCollectorOutcomeItems(runId, 'FAILED'), listCollectorOutcomeItems(runId, 'FILTERED_OUT'),
    ]);
    const isPreparing = item => run.status === 'RUNNING' && item.rawPayload?.mediaPreparation?.status === 'preparing';
    const preparingCount = failed.filter(isPreparing).length;
    return {
        runId: run.id, taskId: run.taskId, status: run.status,
        errorCode: run.errorCode || '', errorMessage: run.errorMessage || '',
        ...(run.handoff ? { handoff: run.handoff } : {}),
        qualifiedCount: run.progress?.qualifiedCount ?? run.qualifiedCount ?? 0,
        failedCount: failed.length - preparingCount, preparingCount, skippedCount: skipped.length,
        items: [...failed, ...skipped].map(item => ({
            sku: String(item.sourceSku || item.sourceKey), status: isPreparing(item) ? 'PREPARING' : item.status,
            name: String(item.rawPayload?.nameLabel || ''),
            errorCode: item.errorCode || '', message: item.errorMessage || '未通过选品条件',
        })),
    };
}

export async function createCollectorFailedRetry({ taskId, runId } = {}) {
    // Fetch the selected immutable run through the account-scoped API; renderer cannot supply frozen settings.
    const run = await getCollectorRun(runId);
    if (run.taskId !== taskId || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status))
        throw new Error('所选运行不属于此任务或尚未结束，请刷新后重试');
    const failed = await listCollectorRunItems(runId, { status: 'FAILED', limit: 1 });
    if (!failed.length) throw new Error('本次没有可单独重试的失败商品；启动阶段失败可使用原任务的“开始”');
    const snapshot = run.configurationSnapshot || {};
    const input = { ...snapshot.configuration,
        taskName: `${snapshot.configuration?.taskName || '采集任务'} · 失败重试`,
        taskType: snapshot.taskType, concurrency: snapshot.concurrency,
        retryFromRunId: run.id,
    };
    const payload = await sonliRequest({ method: 'post', url: '/collector/tasks',
        data: withoutCollectorScope(toCollectorTaskPayload(input)) });
    return unwrapTask(payload);
}

export async function listCollectorRunDuplicateEvents(runId, afterId = 0) {
    const payload = await sonliRequest({ method: 'get', url: `/collector/runs/${encodeURIComponent(runId)}/events`,
        params: { eventType: 'SKU_DUPLICATES', afterId, limit: 500 } });
    return payload.events || [];
}

export async function latestCollectorRunId(taskId) {
    const runs = await listCollectorRunsForTask(taskId, { limit: 20 });
    const run = runs[0];
    return String(run?.id || run?._id || run?.runId || '');
}

export function retryCollectorRunHandoff(runId) {
    return sonliRequest({ method: 'post', url: `/collector/runs/${encodeURIComponent(runId)}/handoff/retry`, data: {} });
}

export async function addCollectorResultsToCollectBox(options = {}) {
    const runId = String(options.runId || await latestCollectorRunId(options.taskId) || '');
    if (!runId)
        throw Object.assign(new Error('该任务还没有可导入的采集运行'), { status: 422 });

    let itemIds = (Array.isArray(options.itemIds) ? options.itemIds : [])
        .map(String)
        .filter(Boolean);
    let sourceKeys = (Array.isArray(options.sourceKeys) ? options.sourceKeys : [])
        .map(String)
        .filter(Boolean);
    if (options.allQualified && !itemIds.length && !sourceKeys.length) {
        let offset = 0;
        while (true) {
            const page = await listCollectorRunItems(runId, {
                status: 'QUALIFIED',
                view: 'identity',
                limit: 500,
                offset,
            });
            itemIds.push(...page.map((item) => String(item.id || '')).filter(Boolean));
            sourceKeys.push(...page.filter((item) => !item.id).map((item) => String(item.sourceKey || '')).filter(Boolean));
            if (page.length < 500)
                break;
            offset += page.length;
        }
    }
    itemIds = [...new Set(itemIds)];
    sourceKeys = [...new Set(sourceKeys)];
    if (!itemIds.length && !sourceKeys.length)
        throw Object.assign(new Error('该任务没有符合条件且尚可导入的商品'), { status: 422 });

    const selections = [
        ...itemIds.map((value) => ({ type: 'id', value })),
        ...sourceKeys.map((value) => ({ type: 'key', value })),
    ];
    const aggregate = { runId, selected: 0, added: 0, results: [], errors: [], missing: [] };
    while (selections.length) {
        const batch = selections.splice(0, 10);
        let payload;
        try {
            payload = await sonliRequest({
                method: 'post',
                url: `/collector/runs/${encodeURIComponent(runId)}/collect-box`,
                data: {
                    itemIds: batch.filter((item) => item.type === 'id').map((item) => item.value),
                    sourceKeys: batch.filter((item) => item.type === 'key').map((item) => item.value),
                },
            });
        }
        catch (error) {
            // The server may have committed this batch before the connection
            // failed. Preserve confirmed earlier results without retrying writes.
            aggregate.selected += batch.length + selections.length;
            for (const [items, message] of [
                [batch, `本批次导入结果未确认：${error?.message || error}；可稍后重试`],
                [selections, '尚未导入：前一批次未完成，可稍后重试'],
            ]) {
                aggregate.errors.push(...items.map(item => ({
                    [item.type === 'id' ? 'collectorItemId' : 'sourceKey']: item.value,
                    message,
                })));
            }
            break;
        }
        aggregate.selected += Number(payload?.selected || 0);
        aggregate.added += Number(payload?.added || 0);
        aggregate.results.push(...(payload?.results || []));
        aggregate.errors.push(...(payload?.errors || []));
        aggregate.missing.push(...(payload?.missing || []));
    }
    aggregate.ok = aggregate.errors.length === 0 && aggregate.missing.length === 0;
    return aggregate;
}

export async function prepareCollectorAiListing(options = {}) {
    const result = await addCollectorResultsToCollectBox(options);
    const ids = [...new Set(result.results.map(item => item.collectItemId).filter(Boolean))];
    const aiListingBatches = [];
    // The existing Web selection accepts 100 collect records. Keep every batch
    // visible instead of letting its URL parser silently truncate a larger run.
    for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const url = new URL(`${runtimeConfig.sonliWebBase}/ozon/tools/ai-listing`);
        url.searchParams.set('source', 'collect');
        url.searchParams.set('ids', batch.join(','));
        aiListingBatches.push({ index: aiListingBatches.length + 1, count: batch.length, url: url.toString() });
    }
    return { ...result, aiListingBatches };
}

// The server owns frozen settings and automatic SKU ownership, including a later resend.
export async function startCollectorRunAiListing(result, { manual = false } = {}) {
    const payload = await sonliRequest({ method: 'get', url: `/collector/runs/${encodeURIComponent(result.runId)}` });
    const run = unwrapRun(payload);
    const options = run?.configurationSnapshot?.configuration || {};
    if (options.autoSendToAiListing !== true || options.autoStartAiGeneration !== true) return {};
    const ids = [...new Set(result.results.map(item => item.collectItemId).filter(Boolean))];
    const output = { aiGenerationRequested: true, aiTasks: [], aiStartResults: [], aiStartErrors: [], aiCreatedTaskIds: [], aiReusedTaskIds: [],
        aiTaskUrl: `${runtimeConfig.sonliWebBase}/ozon/tools/ai-listing?tab=tasks` };
    if (run.status !== 'COMPLETED' && !manual) {
        output.aiStartErrors = ids.map(collectItemId => ({ collectItemId, message: '本次采集尚未成功完成，未自动开始生图' }));
        return output;
    }
    const knownTasks = new Map(), createdTasks = new Set(), reusedTasks = new Set();
    const uniqueStrings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item)
        && new Set(value).size === value.length;
    for (let offset = 0; offset < ids.length; offset += 10) {
        const batch = ids.slice(offset, offset + 10);
        try {
            const response = await sonliRequest({ method: 'post', url: '/ai-listing/tasks/from-collector-run',
                data: { runId: run.id, collectItemIds: batch, ...(manual ? { manual: true } : {}) } });
            const tasks = response?.tasks;
            const receipts = response?.results;
            const errors = response?.errors === undefined ? [] : response.errors;
            if (!Array.isArray(tasks) || !Array.isArray(receipts) || !Array.isArray(errors)
                || tasks.some(task => typeof task?.id !== 'string' || !task.id)
                || new Set(tasks.map(task => task.id)).size !== tasks.length
                || receipts.length !== batch.length || new Set(receipts.map(row => row?.collectItemId)).size !== batch.length
                || receipts.some(row => !batch.includes(row?.collectItemId))
                || new Set(errors.map(error => error?.collectItemId)).size !== errors.length
                || errors.some(error => error?.definitelyNotCreated !== true || !batch.includes(error.collectItemId) || !uniqueStrings(error.skus) || !error.skus.length))
                throw new Error('AI 任务创建回执不完整');
            const taskIds = new Set(tasks.map(task => task.id)), referenced = new Set();
            for (const row of receipts) {
                const failure = errors.find(error => error.collectItemId === row.collectItemId);
                if (![row.taskIds, row.createdTaskIds, row.reusedTaskIds, row.unprocessedSkus].every(uniqueStrings)
                    || row.taskIds.some(id => !taskIds.has(id))
                    || !uniqueStrings([...row.createdTaskIds, ...row.reusedTaskIds])
                    || row.createdTaskIds.length + row.reusedTaskIds.length !== row.taskIds.length
                    || [...row.createdTaskIds, ...row.reusedTaskIds].some(id => !row.taskIds.includes(id))
                    || (!row.taskIds.length && !row.unprocessedSkus.length)
                    || Boolean(failure) !== Boolean(row.unprocessedSkus.length)
                    || (failure && (failure.skus.length !== row.unprocessedSkus.length || failure.skus.some(sku => !row.unprocessedSkus.includes(sku)))))
                    throw new Error('AI 任务创建回执不完整');
                row.taskIds.forEach(id => referenced.add(id));
            }
            if (referenced.size !== taskIds.size) throw new Error('AI 任务创建回执不完整');
            // One product can reference several old/new tasks, and two sources may share a task.
            for (const task of tasks) knownTasks.set(task.id, task);
            output.aiStartResults.push(...receipts);
            for (const row of receipts) {
                row.createdTaskIds.forEach(id => createdTasks.add(id));
                row.reusedTaskIds.forEach(id => reusedTasks.add(id));
            }
            output.aiStartErrors.push(...errors.map(({ collectItemId, skus, code, message }) => ({
                collectItemId, skus, code, message, definitelyNotCreated: true,
            })));
        }
        catch (error) {
            for (const [items, message] of [
                [batch, `本批次生图任务创建结果未确认：${error?.message || error}；再次发送将按原配置核对或继续`],
                [ids.slice(offset + 10), '尚未创建生图任务：前一批次未完成'],
            ]) output.aiStartErrors.push(...items.map(collectItemId => ({ collectItemId, message })));
            break;
        }
    }
    output.aiTasks = [...knownTasks.values()];
    output.aiCreatedTaskIds = [...createdTasks];
    output.aiReusedTaskIds = [...reusedTasks].filter(id => !createdTasks.has(id));
    return output;
}

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

export async function createCollectorTask(input) {
    const data = withoutCollectorScope(toCollectorTaskPayload(input));
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
    const data = withoutCollectorScope(toCollectorTaskPayload(input));
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
            pricingConfigVersionId: options.pricingConfigVersionId || undefined,
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

export function appendCollectorRunEvent(runId, event) {
    return sonliRequest({
        method: 'post',
        url: `/collector/runs/${encodeURIComponent(runId)}/events`,
        data: withoutCollectorScope(event),
    });
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

export function calculateCollectorPricing(input) {
    return sonliRequest({ method: 'post', url: '/pricing/collector/calculate', data: withoutCollectorScope(input) });
}

export function getSonliState() {
    return sonliRequest({ method: 'get', url: '/local/state' });
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
            limit: Number(params.limit || 500),
            offset: Number(params.offset || 0),
        },
    });
    const items = payload?.items || payload?.data?.items || [];
    return Array.isArray(items) ? items : [];
}

async function latestCollectorRunId(taskId) {
    const runs = await listCollectorRunsForTask(taskId, { limit: 20 });
    const run = runs[0];
    return String(run?.id || run?._id || run?.runId || '');
}

export async function addCollectorResultsToCollectBox(options = {}) {
    const runId = String(options.runId || await latestCollectorRunId(options.taskId) || '');
    if (!runId)
        throw new Error('该任务还没有可导入的采集运行');

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
        throw new Error('该任务没有符合条件且尚可导入的商品');

    const selections = [
        ...itemIds.map((value) => ({ type: 'id', value })),
        ...sourceKeys.map((value) => ({ type: 'key', value })),
    ];
    const aggregate = { runId, selected: 0, added: 0, results: [], errors: [], missing: [] };
    while (selections.length) {
        const batch = selections.splice(0, 1000);
        const payload = await sonliRequest({
            method: 'post',
            url: `/collector/runs/${encodeURIComponent(runId)}/collect-box`,
            data: {
                itemIds: batch.filter((item) => item.type === 'id').map((item) => item.value),
                sourceKeys: batch.filter((item) => item.type === 'key').map((item) => item.value),
            },
        });
        aggregate.selected += Number(payload?.selected || 0);
        aggregate.added += Number(payload?.added || 0);
        aggregate.results.push(...(payload?.results || []));
        aggregate.errors.push(...(payload?.errors || []));
        aggregate.missing.push(...(payload?.missing || []));
    }
    aggregate.ok = aggregate.errors.length === 0 && aggregate.missing.length === 0;
    return aggregate;
}

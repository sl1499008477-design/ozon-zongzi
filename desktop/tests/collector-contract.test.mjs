import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeCollectorTask,
    toCollectorTaskQuery,
    toCollectorTaskPayload,
} from '../dist-electron/services/collector-contract.core.js';

test('maps Sonli task status and preserves recovered configuration', () => {
    const task = normalizeCollectorTask({
        id: 'task-1',
        name: '类目采集',
        status: 'QUEUED',
        storeId: 'legacy-store-alias',
        clientId: 'legacy-camel-client-id',
        client_id: 'legacy-client-id',
        operatingStoreId: 'store-1',
        dataCollectionStoreId: 'legacy-data-store',
        sellerCompanyId: 'legacy-seller-company',
        legacyScope: {
            operatingStoreId: 'store-1',
            dataCollectionStoreId: 'legacy-data-store',
            sellerCompanyId: 'must-not-be-public',
        },
        configuration: {
            targetCount: 20,
            sourceType: '0',
            nested: {
                operatingStoreId: 'nested-operating',
                DATA_COLLECTION_STORE_ID: 'nested-data',
                currentDataCollectionStoreId: 'nested-current-data',
                CURRENT_DATA_COLLECTION_STORE_IDS_BY_ACCOUNT: { forged: 'nested-current-map' },
                seller_company: 'nested-seller',
                keep: true,
            },
            array: [{
                dataCollectionStore: { id: 'forged-data-store' },
                data_collection_store_ids: ['forged-data-store'],
                legacy_scope: { arbitrary: 'forged' },
                keep: 'array-value',
            }],
        },
    });
    assert.equal(task._id, 'task-1');
    assert.equal(task.taskName, '类目采集');
    assert.equal(task.taskStatus, 'pending');
    assert.equal(task.targetCount, 20);
    assert.equal(task.operatingStoreId, null);
    assert.equal(Object.hasOwn(task, 'storeId'), false);
    assert.equal(Object.hasOwn(task, 'clientId'), false);
    assert.equal(Object.hasOwn(task, 'client_id'), false);
    assert.equal(Object.hasOwn(task, 'dataCollectionStoreId'), false);
    assert.equal(Object.hasOwn(task, 'sellerCompanyId'), false);
    assert.deepEqual(task.configuration.nested, { keep: true });
    assert.deepEqual(task.configuration.array, [{ keep: 'array-value' }]);
    assert.deepEqual(task.legacyScope, {
        operatingStoreId: 'store-1',
        dataCollectionStoreId: 'legacy-data-store',
    });
});

test('maps recovered UI task filters to the Sonli list contract', () => {
    assert.deepEqual(toCollectorTaskQuery({
        pageNo: 3,
        pageSize: 10,
        taskName: '  夏季商品  ',
        taskStatus: 'pending',
    }), {
        page: 3,
        pageSize: 10,
        taskName: '夏季商品',
        status: 'QUEUED',
    });
    assert.equal(toCollectorTaskQuery({ taskStatus: 'noExecuted' }).status, 'NOT_STARTED');
    assert.equal(toCollectorTaskQuery({ taskStatus: 'completed' }).status, 'COMPLETED');
});

test('clamps task concurrency to 2-20 and defaults to 4', () => {
    assert.equal(toCollectorTaskPayload({ taskName: 'a' }).concurrency, 4);
    assert.equal(toCollectorTaskPayload({ taskName: 'a', concurrency: 1 }).concurrency, 2);
    assert.equal(toCollectorTaskPayload({ taskName: 'a', concurrency: 99 }).concurrency, 20);
});

test('new task payloads capture ALL while legacy task edits and explicit CURRENT preserve their scope', () => {
    assert.equal(toCollectorTaskPayload({ taskName: 'New group task' }).configuration.captureScope, 'ALL');
    assert.equal(toCollectorTaskPayload({ _id: 'legacy', taskName: 'Legacy edit' }).configuration.captureScope, 'CURRENT');
    assert.equal(toCollectorTaskPayload({ taskName: 'Explicit current', captureScope: 'CURRENT' }).configuration.captureScope, 'CURRENT');
    assert.equal(toCollectorTaskPayload({ _id: 'all', captureScope: 'ALL' }).configuration.captureScope, 'ALL');
});

test('builds a store-neutral task payload and omits retired authorization scope', () => {
    const legacyKey = ['isUse', 'Auto', 'Up', 'Goods'].join('');
    const payload = toCollectorTaskPayload({
        taskName: '安全任务',
        [legacyKey]: true,
        token: 'must-not-persist',
        clientId: 'operating-store-camel',
        client_id: 'operating-store',
        dataCollectionStoreId: 'data-store',
        sellerCompanyId: 'seller-company',
        filters: {
            operatingStoreId: 'nested-operating',
            Data_Collection_Store_Id: 'nested-data',
            Current_Data_Collection_Store_Id: 'nested-current-data',
            current_data_collection_store_ids_by_account: { forged: 'nested-current-map' },
            SellerCompany: 'nested-seller',
            keep: true,
        },
        nestedArray: [{
            data_collection_store: { id: 'nested-store' },
            DATA_COLLECTION_STORE_IDS: ['nested-store'],
            LegacyScope: { arbitrary: 'forged' },
            keep: 1,
        }],
    });
    assert.equal(payload.operatingStoreId, null);
    assert.equal(Object.hasOwn(payload, 'dataCollectionStoreId'), false);
    assert.equal(Object.hasOwn(payload, 'sellerCompanyId'), false);
    assert.equal(Object.hasOwn(payload.configuration, legacyKey), false);
    assert.equal(Object.hasOwn(payload.configuration, 'token'), false);
    assert.equal(Object.hasOwn(payload.configuration, 'clientId'), false);
    assert.equal(Object.hasOwn(payload.configuration, 'client_id'), false);
    assert.equal(Object.hasOwn(payload.configuration, 'dataCollectionStoreId'), false);
    assert.equal(Object.hasOwn(payload.configuration, 'sellerCompanyId'), false);
    assert.deepEqual(payload.configuration.filters, { keep: true });
    assert.deepEqual(payload.configuration.nestedArray, [{ keep: 1 }]);
});

test('does not recursively persist the previous server configuration', () => {
    const payload = toCollectorTaskPayload({
        taskName: '稳定配置',
        targetCount: 10,
        configuration: {
            targetCount: 5,
            configuration: { targetCount: 1 },
        },
        currentRunId: 'server-run',
        statusVersion: 7,
    });
    assert.equal(payload.configuration.targetCount, 10);
    assert.equal(Object.hasOwn(payload.configuration, 'configuration'), false);
    assert.equal(Object.hasOwn(payload.configuration, 'currentRunId'), false);
    assert.equal(Object.hasOwn(payload.configuration, 'statusVersion'), false);
});

test('maps real task/run dates and persisted counts without treating an edit as an execution', () => {
    const task = normalizeCollectorTask({id:'task-history',status:'FAILED',createdAt:'2026-09-10T00:00:00Z',updatedAt:'2026-09-10T05:00:00Z',lastStartedAt:'2026-09-10T02:00:00Z',currentRun:{id:'run-history',startedAt:'2026-09-10T02:00:00Z',progress:{totalCount:7,processedCount:7,qualifiedCount:2,failedCount:5}}});
    assert.equal(task.createTime, '2026-09-10T00:00:00Z');
    assert.equal(task.lastRunningTime, '2026-09-10T02:00:00Z');
    assert.deepEqual(task.progress,{current:0,total:7,totalCount:2,dedup:{collected:0,listed:0,collecting:0},outcomes:{skipped:0,failed:5}});
    assert.equal(normalizeCollectorTask({id:'never',createdAt:'2026-09-10T00:00:00Z',updatedAt:'2026-09-10T05:00:00Z',lastStartedAt:null,currentRun:null}).lastRunningTime,null);
    const config=toCollectorTaskPayload(task).configuration;
    for(const key of ['currentRun','lastStartedAt','createTime','lastRunningTime','createdAt','updatedAt'])assert.equal(Object.hasOwn(config,key),false,key+' is read metadata');
});


test('server projection keeps saved product groups and SKU totals distinct across reloads',()=>{
 const task=normalizeCollectorTask({id:'groups',configuration:{captureScope:'ALL'},currentRun:{id:'run',progress:{qualifiedCount:10,qualifiedSkuCount:22,totalCount:28}}});
 assert.equal(task.progress.totalCount,10);
 assert.equal(task.progress.skuCount,22);
 const empty=normalizeCollectorTask({id:'empty',currentRun:{id:'run',progress:{qualifiedCount:0,qualifiedSkuCount:0}}});
 assert.equal(empty.progress.skuCount,0);
});

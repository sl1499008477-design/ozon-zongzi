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

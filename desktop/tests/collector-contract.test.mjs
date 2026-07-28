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
        operatingStoreId: 'store-1',
        configuration: { targetCount: 20, sourceType: '0' },
    });
    assert.equal(task._id, 'task-1');
    assert.equal(task.taskName, '类目采集');
    assert.equal(task.taskStatus, 'pending');
    assert.equal(task.targetCount, 20);
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

test('removes direct publish controls from persisted task configuration', () => {
    const legacyKey = ['isUse', 'Auto', 'Up', 'Goods'].join('');
    const payload = toCollectorTaskPayload({
        taskName: '安全任务',
        [legacyKey]: true,
        token: 'must-not-persist',
        client_id: 'operating-store',
        dataCollectionStoreId: 'data-store',
    });
    assert.equal(payload.operatingStoreId, 'operating-store');
    assert.equal(payload.dataCollectionStoreId, 'data-store');
    assert.equal(Object.hasOwn(payload.configuration, legacyKey), false);
    assert.equal(Object.hasOwn(payload.configuration, 'token'), false);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const backendSource = await readFile(
    new URL('../dist-electron/services/collector-backend.services.js', import.meta.url),
    'utf8',
);
const collectionSource = await readFile(
    new URL('../dist-electron/services/collection/collection.services.js', import.meta.url),
    'utf8',
);
const dataFilterSource = await readFile(
    new URL('../dist-electron/services/collection/data-filter.services.js', import.meta.url),
    'utf8',
);
const taskManagerSource = await readFile(
    new URL('../dist-electron/services/collection/task-manager.services.js', import.meta.url),
    'utf8',
);
const interfaceSource = await readFile(
    new URL('../dist-electron/services/collection/interface.services.js', import.meta.url),
    'utf8',
);
const excelSource = await readFile(
    new URL('../dist-electron/utils/excel.js', import.meta.url),
    'utf8',
);
const sellerSource = await readFile(
    new URL('../dist-electron/services/seller-ozon.services.js', import.meta.url),
    'utf8',
);
const mainWindowSource = await readFile(
    new URL('../dist-electron/services/collection/main-window.services.js', import.meta.url),
    'utf8',
);
const parseSource = await readFile(
    new URL('../dist-electron/services/collection/ozon-list-parser.core.js', import.meta.url),
    'utf8',
);
const rendererSource = await readFile(
    new URL('../dist/assets/index-zr_rvO4W.js', import.meta.url),
    'utf8',
);
const preloadSource = await readFile(
    new URL('../electron/preload.js', import.meta.url),
    'utf8',
);

test('run item writes use the batch route and carry the active lease envelope', () => {
    assert.match(backendSource, /method:\s*'post'[\s\S]{0,160}\/items/);
    assert.match(backendSource, /data:\s*\{\s*deviceId,\s*leaseToken,\s*items:\s*\[item\],/);
});

test('verified data store is frozen into run creation', () => {
    assert.match(collectionSource, /createCollectorRun[\s\S]{0,280}dataCollectionStoreId:\s*this\.task\.dataCollectionStoreId/);
    assert.match(backendSource, /dataCollectionStoreId:\s*options\.dataCollectionStoreId/);
});

test('persisted item statuses match collector service contract', () => {
    assert.match(collectionSource, /item\.pricingError\s*\?\s*'FAILED'\s*:\s*'QUALIFIED'/);
});

test('Seller Analytics has a single 200ms global request gate', () => {
    assert.match(sellerSource, /MIN_REQUEST_INTERVAL_MS\s*=\s*200/);
    assert.match(sellerSource, /await abortable\(requestGate\(\), signal\)/);
    assert.match(dataFilterSource, /SELLER_ANALYTICS_ENRICH_FAILED/);
});

test('URL collection finishes each analytics and filter batch before scrolling again', () => {
    const awaitedBatches = collectionSource.match(/await this\.processData\(goodsList\)/g) || [];
    assert.equal(awaitedBatches.length, 2);
    assert.doesNotMatch(collectionSource, /(?<!await )this\.processData\(goodsList\)/);
    assert.match(collectionSource, /log\.error\('商品基础数据处理失败', error\)[\s\S]{0,80}throw error/);
});

test('Ozon access pages cannot be reported as a successful empty collection', () => {
    assert.match(mainWindowSource, /setUserAgent\(chromeCompatibleUserAgent\(\)\)/);
    assert.match(mainWindowSource, /button\.rb, \.btn\.rb/);
    assert.match(mainWindowSource, /productLinkCount/);
    assert.match(collectionSource, /error\.code = 'OZON_ACCESS_BLOCKED'/);
    assert.match(collectionSource, /error\.code = 'OZON_PRODUCT_LIST_EMPTY'/);
    assert.match(collectionSource, /if \(scrollAttempts >= maxScrollAttempts\) \{[\s\S]{0,180}this\.assertProductsCollected\(\)/);
    assert.match(collectionSource, /if \(bottomOutCount >= 3\) \{[\s\S]{0,180}this\.assertProductsCollected\(\)/);
    assert.match(parseSource, /a\[href\*="\/product\/"\]/);
});

test('cancellation waits for the active collection lifecycle and aborts Seller batches', () => {
    assert.doesNotMatch(collectionSource, /setInterval\(async \(\) => \{[\s\S]{0,180}safeReject\('任务已终止'/);
    assert.match(collectionSource, /error\?\.code === 'COLLECTION_CANCELLED'[\s\S]{0,180}await this\.cancellationPromise/);
    assert.match(collectionSource, /if \(this\.reason !== 'cancel'\)\s*this\.reason = 'failed'/);
    assert.match(collectionSource, /this\.cancellationController\.abort\(\)/);
    assert.match(dataFilterSource, /signal:\s*this\.cancellationSignal/);
    assert.match(sellerSource, /throwIfAborted\(options\.signal\)[\s\S]{0,300}signal:\s*options\.signal/);
    assert.match(taskManagerSource, /if \(!wasActive\) \{[\s\S]{0,180}this\.processNextTask\(\)/);
    assert.doesNotMatch(taskManagerSource, /await task\.cancel\(\);\s*this\.activeTasks\.delete\(taskId\)/);
});

test('task preparation remains protected from duplicate starts', () => {
    assert.match(taskManagerSource, /this\.activeTasks\.add\(taskId\)/);
    assert.match(taskManagerSource, /this\.activeTasks\.has\(taskId\)[\s\S]{0,180}reject\('任务已在运行中'\)/);
    assert.doesNotMatch(taskManagerSource, /taskStatus !== 'running'[\s\S]{0,120}activeTasks\.delete/);
});

test('category mappings are hydrated with the active store scope', () => {
    assert.match(backendSource, /getCollectorCategoryMappings[\s\S]{0,180}hydrateTaskScope/);
    assert.match(backendSource, /currentStoreId/);
    assert.match(backendSource, /currentDataCollectionStoreId/);
});

test('run requests keep checking the frozen Seller store context', () => {
    assert.match(collectionSource, /expectedContext:\s*this\.sellerContext/);
    assert.match(collectionSource, /taskId:\s*this\.task\._id,[\s\S]{0,80}runId:\s*this\.runId/);
    assert.match(backendSource, /\/collector\/runs\/\$\{encodeURIComponent\(runId\)\}\/cancel/);
});

test('renderer exposes collect-box import, not direct publishing', () => {
    assert.match(rendererSource, /collection-add-to-collect-box/);
    assert.match(rendererSource, /加入采集箱/);
    assert.match(preloadSource, /collection-add-to-collect-box/);
    assert.doesNotMatch(rendererSource, new RegExp(['是否确认', '上架表格中的商品'].join('')));
});

test('goodsFilter uses reverse pricing instead of requiring a missing CNY sale price', () => {
    assert.match(dataFilterSource, /operation:\s*upMode == 2 \? 'goodsFilter2' : 'goodsFilter'/);
    assert.match(dataFilterSource, /mode:\s*upMode == 2 \? 'profit' : 'pricing'/);
});

test('category cold start offers all categories and learns mappings from Seller data', () => {
    assert.match(interfaceSource, /category_id:\s*"__all__"/);
    assert.match(collectionSource, /saveCollectorCategoryMapping/);
    assert.match(dataFilterSource, /saveCollectorCategoryMapping/);
});

test('persisted queued and expired runs are restored safely', () => {
    assert.match(taskManagerSource, /restorePersistedRun/);
    assert.match(taskManagerSource, /status === 'QUEUED'/);
    assert.match(taskManagerSource, /lockExpiresAt <= Date\.now\(\)/);
    assert.match(collectionSource, /prepareRun\(\)/);
    assert.match(collectionSource, /heartbeatFailures >= 3/);
});

test('local Excel images are restricted and bounded', () => {
    assert.match(excelSource, /IMAGE_HOST_SUFFIXES/);
    assert.match(excelSource, /redirect:\s*'manual'/);
    assert.match(excelSource, /MAX_IMAGE_BYTES/);
    assert.match(excelSource, /limitInputPixels:\s*40_000_000/);
});

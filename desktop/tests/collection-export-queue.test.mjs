import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { withCollectorRequest } from '../dist-electron/services/collector-network.core.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const ExcelJS = require('exceljs'), sharp = require('sharp');
const source = await readFile(new URL('../dist-electron/utils/excel.js', import.meta.url), 'utf8');
const serviceSource = await readFile(new URL('../dist-electron/services/collection/excel.services.js', import.meta.url), 'utf8');
const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
const turn = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, fetch = async () => new Response(png, { headers: { 'content-type': 'image/png' } })) {
    const directory = await mkdtemp(join(tmpdir(), 'collector-export-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const context = { ExcelJS, sharp, fsPromises, dirname, URL, AbortController, setTimeout, clearTimeout, Buffer, fetch, withCollectorRequest,
        log: { info() {}, warn() {}, error() {} } };
    const ExcelWriter = vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace('export class', 'class') + '\nExcelWriter', context);
    const ExcelService = vm.runInNewContext(serviceSource.replace(/^import .*;\n/gm, '').replace('export class', 'class') + '\nExcelService', {
        ...context, ExcelWriter, buildTaskExcelPath: () => join(directory, 'output.xlsx'), assertManagedExcelPath: (_root, path) => path,
        SysTemUtils: { getAppInfo: () => ({ userDataPath: directory }), fileOperations: { deleteFile: path => rm(path, { force: true }) } },
    });
    const service = new ExcelService('task', 'Representative export');
    await service.initTable();
    return { service, path: await service.getFilePath() };
}

test('a persisted product can enqueue export before its slow thumbnail finishes, and final flush waits for a usable workbook', async t => {
    const image = deferred();
    t.after(() => image.resolve());
    const { service, path } = await fixture(t, async () => { await image.promise; return new Response(png, { headers: { 'content-type': 'image/png' } }); });
    let queued = false, flushed = false;
    const saving = service.saveExcel([{ id: '中文货号-1', nameLabel: 'Товар', cover: 'https://cdn.ozon.ru/one.png' }]).then(() => { queued = true; });
    await turn();
    assert.equal(queued, true, 'thumbnail download must not hold collection persistence');
    const finishing = service.flushToDisk().then(value => { flushed = true; return value; });
    await turn();
    assert.equal(flushed, false, 'completion must await pending thumbnail and disk write');
    image.resolve();
    await saving;
    assert.equal(await finishing, true);
    const reopened = new ExcelJS.Workbook(); await reopened.xlsx.readFile(path);
    assert.equal(reopened.worksheets[0].getCell('A3').value, '中文货号-1');
    assert.equal(reopened.worksheets[0].getImages().length, 1);
});

test('200 product groups and 1852 variants produce every original row while batching workbook rewrites', async t => {
    const { service, path } = await fixture(t);
    let writes = 0;
    const actualWrite = service.excel.workbook.xlsx.writeFile.bind(service.excel.workbook.xlsx);
    service.excel.workbook.xlsx.writeFile = async (...args) => { writes++; return actualWrite(...args); };
    const expected = [];
    for (let group = 0; group < 200; group++) {
        const rows = Array.from({ length: group < 52 ? 10 : 9 }, (_, index) => ({ id: `商品-${group}-${index}`, nameLabel: `Группа ${group}` }));
        expected.push(...rows.map(row => row.id));
        assert.equal(await service.saveExcel(rows), true);
    }
    assert.equal(await service.flushToDisk(), true);
    const reopened = new ExcelJS.Workbook(); await reopened.xlsx.readFile(path);
    const sheet = reopened.worksheets[0];
    assert.equal(sheet.rowCount, 1854);
    assert.deepEqual(sheet.getColumn(1).values.slice(3), expected);
    assert.ok(writes <= 25, `expected batched writes, observed ${writes}`);
    console.log(JSON.stringify({ groups: 200, variants: 1852, workbookWrites: writes }));
});

test('the background export queue applies backpressure when thumbnails cannot progress', async t => {
    const image = deferred();
    t.after(() => image.resolve());
    const { service } = await fixture(t, async () => { await image.promise; throw Error('thumbnail unavailable'); });
    let accepted = 0;
    const saving = (async () => {
        for (let index = 0; index < 1000; index++) {
            await service.saveExcel([{ id: `sku-${index}`, cover: 'https://cdn.ozon.ru/missing.png' }]);
            accepted++;
        }
    })();
    await turn();
    assert.ok(accepted > 0 && accepted < 1000, `unbounded or blocking queue: ${accepted}`);
    image.resolve(); await saving;
    assert.equal(await service.flushToDisk(), true, 'thumbnail failures preserve all text rows');
    assert.equal(service.excel.worksheet.rowCount, 1002);
});

test('a disk failure leaves the previous workbook intact and final retry writes each queued row once', async t => {
    const { service, path } = await fixture(t);
    await service.saveExcel([{ id: 'first' }]);
    assert.equal(await service.flushToDisk(), true);
    // Only the filesystem replacement boundary fails; the real Excel serializer and queue run.
    const writerFs = service.excel;
    const actualWrite = writerFs.workbook.xlsx.writeFile.bind(writerFs.workbook.xlsx);
    writerFs.workbook.xlsx.writeFile = async () => { throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); };
    await service.saveExcel([{ id: 'second' }]);
    assert.equal(await service.flushToDisk(), false);
    const previous = new ExcelJS.Workbook(); await previous.xlsx.readFile(path);
    assert.equal(previous.worksheets[0].rowCount, 3);
    writerFs.workbook.xlsx.writeFile = actualWrite;
    assert.equal(await service.flushToDisk(), true);
    const reopened = new ExcelJS.Workbook(); await reopened.xlsx.readFile(path);
    assert.deepEqual(reopened.worksheets[0].getColumn(1).values.slice(3), ['first', 'second']);
});

test('rebuilding a saved run resets the old in-memory workbook without duplicated rows or headers', async t => {
    const { service, path } = await fixture(t);
    await service.saveExcel([{ id: 'old' }]); await service.flushToDisk();
    await service.DeleteFilled();
    await service.saveExcel([{ id: 'restored' }]); await service.flushToDisk();
    const reopened = new ExcelJS.Workbook(); await reopened.xlsx.readFile(path);
    assert.equal(reopened.worksheets[0].rowCount, 3);
    assert.equal(reopened.worksheets[0].getCell('A3').value, 'restored');
});

test('the existing appendRows followed by flush still creates a complete workbook', async t => {
    const { service, path } = await fixture(t);
    await service.excel.appendRows([{ id: 'existing-contract' }]);
    assert.equal(await service.flushToDisk(), true);
    const reopened = new ExcelJS.Workbook(); await reopened.xlsx.readFile(path);
    assert.equal(reopened.worksheets[0].getCell('A3').value, 'existing-contract');
});

test('a failed row append remains a visible export failure after later rows save successfully', async t => {
    const { service } = await fixture(t);
    const sheet = service.excel.worksheet;
    const actualAddRow = sheet.addRow.bind(sheet);
    sheet.addRow = row => {
        if (row.id === 'failed-row') throw new Error('cannot append row');
        return actualAddRow(row);
    };
    await service.saveExcel([{ id: 'failed-row' }]);
    await service.saveExcel([{ id: 'later-row' }]);
    assert.equal(await service.flushToDisk(), false, 'a later disk save cannot hide an incomplete export');
    assert.equal(await service.flushToDisk(), false, 'the export must be regenerated from persisted results');
    await service.startFreshTable();
    await service.saveExcel([{ id: 'failed-row' }, { id: 'later-row' }]);
    assert.equal(await service.flushToDisk(), true);
});

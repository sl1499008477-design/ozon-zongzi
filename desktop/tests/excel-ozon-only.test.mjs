import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { withCollectorRequest } from '../dist-electron/services/collector-network.core.js';
import { buildTaskExcelPath, assertManagedExcelPath } from '../dist-electron/services/collection/excel-path.core.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const ExcelJS = require('exceljs'), sharp = require('sharp');
const writerSource = await readFile(new URL('../dist-electron/utils/excel.js', import.meta.url), 'utf8');
const serviceSource = await readFile(new URL('../dist-electron/services/collection/excel.services.js', import.meta.url), 'utf8');
const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();

test('Ozon export keeps market, packaging and seller facts with one main image and no pricing columns or candidate downloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sonli-ozon-excel-'));
    const requests = [];
    const log = { info() {}, warn() {}, error() {} };
    const ExcelWriter = vm.runInNewContext(writerSource.replace(/^import .*;\n/gm, '').replace('export class', 'class') + '\nExcelWriter', {
        ExcelJS, sharp, fsPromises, dirname, URL, AbortController, setTimeout, clearTimeout, Buffer, log, withCollectorRequest,
        fetch: async url => { requests.push(String(url)); return new Response(png, { headers: { 'content-type': 'image/png' } }); },
    });
    const ExcelService = vm.runInNewContext(serviceSource.slice(serviceSource.indexOf('export class')).replace('export class', 'class') + '\nExcelService', {
        ExcelWriter, buildTaskExcelPath, assertManagedExcelPath, log,
        SysTemUtils: { getAppInfo: () => ({ userDataPath: directory }) },
    });
    try {
        const service = new ExcelService('paper-task', 'Ozon export');
        const photo = 'https://ir-20.ozonstatic.cn/fixture.png';
        const row = { id: '1508194124', nameLabel: 'Ozon paper', href: 'https://www.ozon.ru/product/1508194124', cover: photo, price: '128.91', currencyCode: 'CNY', storefrontPrice: { amount: '128.91', bankAmount: '127.66', currencyCode: 'CNY', source: 'ozon-web-price' }, sellerAnalyticsPriceRub: 1541.268, avgPrice: 1541.268, soldCount: 60, sellerNumber: 3, followMinPrice: '127.66', followPriceCurrency: 'CNY', weight: 500, length: 300, width: 210, height: 10,
            cover2: 'https://img.alicdn.com/retired-candidate.png', sourcePrice: 1, commissionRfbs: 'old fee', myProfit: 999, pricingError: 'old pricing failure' };
        assert.equal(await service.saveExcel([row]), true);
        assert.equal(await service.flushToDisk(), true);
        const expectedKeys = ['id', 'link', 'cover', 'nameLabel', 'chineseName', 'category3', 'brand', 'price', 'currencyCode', 'oPrice', 'storefrontBankPrice', 'rating', 'reviewCountLabel', 'sellerNumber', 'followMinPrice', 'followPriceCurrency', 'nullableCreateDate', 'releaseDate', 'salesSchema', 'gmvSum', 'salesDynamics', 'soldCount', 'avgGmvOnAccDays', 'avgOrdersOnAccDays', 'sessionCountSearch', 'sessionCount', 'convToCartSearch', 'convToCartPdp', 'drr', 'daysInPromo', 'discount', 'promoRevenueShare', 'daysWithTrafarets', 'sellerAnalyticsPriceRub', 'sumMissedGmv', 'accessibility', 'avgDeliveryDays', 'volume', 'length', 'width', 'height', 'weight'];
        assert.deepEqual(Array.from(service.excel.getWorksheet().columns, column => column.key), expectedKeys);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(await service.getFilePath());
        const sheet = workbook.worksheets[0];
        assert.equal(sheet.columnCount, expectedKeys.length, 'removed pricing image slots must not recreate distant columns');
        assert.equal(sheet.getImages().length, 1);
        assert.equal(sheet.getImages()[0].range.tl.col, 2);
        assert.deepEqual(requests, [photo]);
        const headers = sheet.getRow(2).values.slice(1).join('|');
        assert.doesNotMatch(headers, /候选|货源|佣金|运费|利润|定价|预期售价|算价|尾程/);
        assert.match(headers, /前台参考价\|前台币种/);
        assert.match(headers, /Seller统计均价（₽）/);
        for (const key of ['id', 'nameLabel', 'price', 'currencyCode', 'sellerAnalyticsPriceRub', 'soldCount', 'sellerNumber', 'followMinPrice', 'followPriceCurrency', 'weight', 'length', 'width', 'height']) {
            assert.equal(sheet.getRow(3).getCell(expectedKeys.indexOf(key) + 1).value, row[key], key);
        }
        assert.equal(sheet.getRow(3).getCell(expectedKeys.indexOf('storefrontBankPrice') + 1).value, '127.66');
        assert.equal(sheet.getRow(3).getCell(2).value, row.href, 'the Ozon link remains available without pricing enrichment');
        assert.deepEqual(sheet.model.merges, ['A1:S1', 'T1:AJ1', 'AK1:AP1']);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});

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
const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
function imageRuntime(fetch) {
    return vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace('export class', 'class') + '\n({ ExcelWriter, downloadTrustedImage })', {
        ExcelJS, sharp, fsPromises, dirname, URL, AbortController, setTimeout, clearTimeout, Buffer, fetch, withCollectorRequest,
        log: { warn() {}, error() {} },
    });
}

test('a real Seller ozonstatic.cn image is downloaded and embedded in the saved Excel', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sonli-seller-image-'));
    const requests = [];
    const { ExcelWriter } = imageRuntime(async url => {
        requests.push(String(url));
        return new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    try {
        const path = join(directory, 'seller-image.xlsx');
        const writer = new ExcelWriter(path);
        const photo = 'https://ir-20.ozonstatic.cn/s3/multimedia-1/fixture.png';
        assert.equal(await writer.appendAndSave([{ id: 'paper-fixture', cover: photo }]), true);
        const reopened = new ExcelJS.Workbook();
        await reopened.xlsx.readFile(path);
        assert.equal(reopened.worksheets[0].getImages().length, 1, 'the actual Excel contains the product photo once');
        assert.deepEqual(requests, [photo]);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('Seller CDN support keeps exact host suffix, HTTPS and every redirect boundary', async () => {
    let calls = [];
    let destination = 'https://ir-20.ozonstatic.cn/fixture.png';
    const { downloadTrustedImage } = imageRuntime(async url => {
        calls.push(String(url));
        if (calls.length === 1) return new Response(null, { status: 302, headers: { location: destination } });
        return new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    assert.ok((await downloadTrustedImage('https://cdn.ozon.ru/fixture.png')).equals(png));
    assert.deepEqual(calls, ['https://cdn.ozon.ru/fixture.png', destination]);
    for (const bad of ['http://ir-20.ozonstatic.cn/fixture.png', 'https://evilozonstatic.cn/fixture.png', 'https://ozonstatic.cn.evil.example/fixture.png']) {
        calls = [];
        await assert.rejects(downloadTrustedImage(bad), /受信任/);
        assert.equal(calls.length, 0);
        destination = bad;
        await assert.rejects(downloadTrustedImage('https://cdn.ozon.ru/fixture.png'), /受信任/);
        assert.equal(calls.length, 1, 'the redirect target is rejected before fetching it');
    }
});

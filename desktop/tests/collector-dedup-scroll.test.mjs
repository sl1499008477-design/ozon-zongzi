import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('URL collection continues through eleven duplicate pages to the next new SKU without fetching duplicate details', () => {
    const profile = mkdtempSync(join(tmpdir(), 'collector-dedup-scroll-'));
    const moduleUrl = relative => new URL(relative, import.meta.url).href;
    const script = String.raw`
        import assert from 'node:assert/strict';
        import { readFileSync } from 'node:fs';
        import { createRequire } from 'node:module';
        import vm from 'node:vm';
        import { Collection } from ${JSON.stringify(moduleUrl('../dist-electron/services/collection/collection.services.js'))};

        // The normal desktop loader isolates Electron, HTTP and persistence.
        // Read the actual parser with real Cheerio so DOM discovery/seen counts
        // and the newly added candidate callback are exercised together.
        const require = createRequire(${JSON.stringify(moduleUrl('../package.json'))});
        const cheerio = require('cheerio');
        const parserSource = url => readFileSync(new URL(url), 'utf8')
            .replace(/^import .*;\n/gm, '')
            .replace(/\bexport (?=function|class|const)/g, '');
        const cardsSource = parserSource(${JSON.stringify(moduleUrl('../dist-electron/services/collection/ozon-list-parser.core.js'))});
        const parseOzonProductCards = vm.runInNewContext(
            '(() => {' + cardsSource + '; return parseOzonProductCards; })()', { cheerio, URL });
        const source = parserSource(${JSON.stringify(moduleUrl('../dist-electron/services/collection/parse.services.js'))});
        const ParseService = vm.runInNewContext(
            '(() => {' + source + '; return ParseService; })()',
            { cheerio, parseOzonProductCards, URL, log: { info() {}, error() {}, warn() {} } });

        const collection = new Collection({
            _id: 'fixture-url', taskName: '重复页后继续', targetCount: 1,
        }, null);
        collection.runId = 'fixture-run';
        collection.leaseToken = 'fixture-lease';
        let pages = 0;
        const details = [], processed = [], claimedPages = [];
        collection.mainWindowService.getHTML = async () => {
            assert.ok(++pages <= 12, 'stop as soon as the one new SKU satisfies the target');
            const sku = String(1000 + pages);
            return {
                html: '<main data-widget="searchResultsV2"><div data-index="0">'
                    + '<a href="/product/item-' + sku + '/"><img src="https://ir.ozone.ru/image.jpg"></a>'
                    + '<span class="tsHeadline500Medium">27,87 ¥</span>'
                    + '<a href="/product/item-' + sku + '/">商品' + sku + '</a></div></main>',
                domain: 'https://www.ozon.ru',
            };
        };
        collection.mainWindowService.scrollPage = async () => true;
        collection.mainWindowService.getSellingData = async url => {
            details.push(url);
            return { success: false };
        };
        collection.parseService = new ParseService(collection.mainWindowService);
        collection.processData = async items => {
            processed.push(...items.map(item => item.id));
            collection.targetData += items.length;
        };
        globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
            if (request.url.endsWith('/skus/claim')) {
                claimedPages.push(request.data.skus);
                return { data: { items: request.data.skus.map(sku => ({
                    sku, state: Number(sku) < 1012 ? 'COLLECTED' : 'CLAIMED',
                })) } };
            }
            assert.ok(request.url.endsWith('/events'), 'no unexpected HTTP operation');
            return { data: { ok: true } };
        };

        // Only shorten the fixture's scrolling pauses; preserve async turns.
        const realTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (callback, _delay, ...args) => realTimeout(callback, 0, ...args);
        try {
            await collection.getHtmlData(1);
        } finally {
            globalThis.setTimeout = realTimeout;
        }
        assert.equal(pages, 12, 'new duplicate cards are loaded pages, not ten consecutive empty attempts');
        assert.equal(claimedPages.length, 12);
        assert.equal(collection.parseService.getDataCount(), 12);
        assert.deepEqual(processed, ['1012'], 'only the claimed new SKU reaches downstream processing');
        assert.equal(details.length, 0, 'list parsing defers offers to the item queue; the mocked processData does not fetch details');
        assert.equal(collection.targetData, 1, 'skipped duplicates do not satisfy targetCount');
        assert.deepEqual(collection.dedup, { collected: 11, listed: 0, collecting: 0 });
        assert.equal(collection.reason, 'success');
    `;
    try {
        const result = spawnSync(process.execPath, [
            '--loader', fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url)),
            '--input-type=module', '-e', script,
        ], {
            env: { ...process.env, DESKTOP_TEST_USER_DATA: profile },
            encoding: 'utf8', timeout: 15000,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
        rmSync(profile, { recursive: true, force: true });
    }
});

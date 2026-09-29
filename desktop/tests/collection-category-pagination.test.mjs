import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleUrl = relative => new URL(relative, import.meta.url).href;
function probe(body) {
    const profile = mkdtempSync(join(tmpdir(), 'collector-category-paging-'));
    try {
        const result = spawnSync(process.execPath, [
            '--loader', fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url)),
            '--input-type=module', '-e', `
                import assert from 'node:assert/strict';
                import { readFileSync } from 'node:fs';
                import { Collection } from ${JSON.stringify(moduleUrl('../dist-electron/services/collection/collection.services.js'))};
                import { normalizeSellerAnalyticsResponse } from ${JSON.stringify(moduleUrl('../dist-electron/services/seller-analytics.core.js'))};
                const evidence = JSON.parse(readFileSync(new URL(${JSON.stringify(moduleUrl('./fixtures/seller-pagination-evidence.json'))}), 'utf8'));
                const pages = new Map(evidence.pages.map(page => [page.offset, page.response]));
                const requests = [], details = [], saved = [], summaries = [], terminal = [], events = [], released = [];
                const duplicateSkus = new Set();
                const c = new Collection({ _id: 'fixture', taskName: 'category paging', isUseCategorySelect: 0,
                    aiSelectType: 1, targetCount: 100, concurrency: 4 }, null);
                c.restoreRun({ id: 'fixture-run', status: 'QUEUED' });
                c.preparedClean = true; c.categoriesResolved = true;
                c.mainWindowService.createCollectionWindow = async () => {};
                c.excelService.saveExcel = async () => true;
                c.excelService.flushToDisk = async () => true;
                c.excelService.getFilePath = async () => '';
                c.getHtmlDetailData = async item => {
                    details.push(item.id);
                    return { ...item, nameLabel: 'Fixture ' + item.id,
                        storefrontPrice: { amount: '10', currencyCode: 'CNY' }, rating: 5 };
                };
                globalThis.fetch = () => assert.fail('external requests are forbidden');
                globalThis.__SELLER_LEADERBOARD_HANDLER__ = async options => {
                    requests.push(options.offset);
                    assert.ok(requests.length <= 5, 'pagination must be bounded by the fixture');
                    const response = pages.get(options.offset);
                    assert.ok(response, 'unexpected offset ' + options.offset);
                    return normalizeSellerAnalyticsResponse(response);
                };
                globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
                    if (request.url.endsWith('/skus/claim')) return { data: { items: request.data.skus.map(sku => ({ sku,
                        state: duplicateSkus.has(sku) ? 'COLLECTED' : 'CLAIMED' })) } };
                    if (request.url.endsWith('/claim')) return { data: { run: { id: 'fixture-run' }, leaseToken: 'fixture-lease' } };
                    if (request.url.endsWith('/capabilities')) return { data: {} };
                    if (request.url.endsWith('/items')) saved.push(...request.data.items);
                    else if (request.url.endsWith('/skus/release')) released.push(...request.data.skus);
                    else if (request.url.endsWith('/events')) events.push(request.data);
                    else if (request.url.endsWith('/complete')) { summaries.push(request.data.resultSummary); terminal.push('complete'); }
                    else if (request.url.endsWith('/fail')) terminal.push('fail');
                    else if (request.url.endsWith('/cancel')) terminal.push('cancel');
                    else assert.ok(['heartbeat', 'market-snapshots', 'category-mappings'].some(part => request.url.endsWith('/' + part)), request.url);
                    return { data: { ok: true } };
                };
                // Shorten only queue back-pressure/event pauses. All actual Collection, filtering,
                // SKU claiming, persistence, progress, and terminal methods run unchanged.
                const originalTimeout = globalThis.setTimeout;
                globalThis.setTimeout = (fn, delay, ...args) => originalTimeout(fn, Math.min(delay, 1), ...args);
                try { ${body} }
                finally { globalThis.setTimeout = originalTimeout; c.stopHeartbeat(); clearTimeout(c.eventFlushTimer); }
            `,
        ], { env: { ...process.env, DESKTOP_TEST_USER_DATA: profile }, encoding: 'utf8', timeout: 20000 });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally { rmSync(profile, { recursive: true, force: true }); }
}

test('recorded totals=1000 continues after first-page filtering and duplicates until the target is saved', () => probe(`
    c.task.targetCount = 1; c.task.salePriceMin = 500;
    pages.get(0).items.forEach(item => duplicateSkus.add(item.sku));
    pages.set(60, { totals: '1000', items: [] }); // permitted one-page lookahead
    await c.run();
    assert.deepEqual(requests, [0, 30, 60]);
    assert.equal(c.targetData, 1);
    assert.ok(c.dedup.collected > 0 && c.dedup.collected < 30, 'real base filtering runs before duplicate claims');
    assert.ok(details.length > 0 && details.every(sku => !duplicateSkus.has(sku)));
    assert.equal(saved.filter(item => item.status === 'QUALIFIED').length, 1);
    assert.deepEqual(terminal, ['complete']);
    assert.equal(summaries[0].targetCount, 1);
    assert.equal(summaries[0].collectedCount, 1);
    assert.equal(summaries[0].targetReached, true);
    assert.equal(summaries[0].completionReason, 'TARGET_REACHED');
    assert.match(c.task.lastLog, /已达到目标.*1.*实际.*1/);
    assert.ok(events.some(event => /已达到目标.*1.*实际.*1/.test(event.message)), 'completion explanation is also persisted as a visible log');
`));

test('unknown totals continue through full and short nonempty pages and finish only at the empty page', () => probe(`
    pages.clear();
    pages.set(0, { items: Array.from({ length: 30 }, (_, i) => ({ sku: 'unknown-' + i })) });
    pages.set(30, { items: [{ sku: 'unknown-last' }] });
    pages.set(60, { items: [] });
    await c.run();
    assert.deepEqual(requests, [0, 30, 60]);
    assert.equal(c.targetData, 31);
    assert.equal(c.total, null);
    assert.equal(c.query.maxPage, null);
    assert.equal(summaries[0].targetReached, false);
    assert.equal(summaries[0].completionReason, 'CANDIDATES_EXHAUSTED');
    assert.equal(summaries[0].targetCount, 100);
    assert.equal(summaries[0].collectedCount, 31);
    assert.match(c.task.lastLog, /候选结果已用尽.*未达到目标.*100.*实际.*31/);
`));

test('a short nonterminal page with a known total still loads the next offset', () => probe(`
    pages.clear();
    pages.set(0, { totals: '1000', items: Array.from({ length: 20 }, (_, i) => ({ sku: 'short-' + i })) });
    pages.set(30, { totals: '1000', items: [{ sku: 'after-short-page' }] });
    pages.set(60, { totals: '1000', items: [] });
    await c.run();
    assert.deepEqual(requests, [0, 30, 60]);
    assert.equal(c.targetData, 21);
    assert.ok(saved.some(item => item.sourceSku === 'after-short-page' && item.status === 'QUALIFIED'));
    assert.equal(summaries[0].completionReason, 'CANDIDATES_EXHAUSTED');
`));

test('recorded final ten items stop at offset 990 and explain an unmet target', () => probe(`
    c.query.pageNo = 34;
    await c.run();
    assert.deepEqual(requests, [990]);
    assert.equal(c.targetData, 10);
    assert.equal(summaries[0].completionReason, 'CANDIDATES_EXHAUSTED');
    assert.equal(summaries[0].targetReached, false);
    assert.match(c.task.lastLog, /目标.*100.*实际.*10/);
`));

test('recorded empty response and explicit zero total complete without requesting another page', () => probe(`
    c.query.pageSize = 10; c.query.pageNo = 101;
    await c.run();
    assert.deepEqual(requests, [1000]);
    assert.equal(c.targetData, 0);
    assert.equal(summaries[0].completionReason, 'CANDIDATES_EXHAUSTED');
    assert.deepEqual(terminal, ['complete']);
    const zero = new Collection({ _id: 'zero', targetCount: 100 }, null);
    pages.set(0, { totals: 0, items: [] });
    assert.deepEqual(await zero.getCategoryGoodsList(), []);
    assert.equal(zero.total, 0);
    assert.equal(zero.categoryExhausted, true);
`));

test('ordinary detail filtering persists FILTERED_OUT and contributes to the final skipped count', () => probe(`
    pages.clear(); pages.set(0, { totals: '1', items: [{ sku: 'low-rating' }] });
    c.task.ratingMin = 6;
    await c.run();
    assert.equal(c.targetData, 0);
    assert.deepEqual(saved.map(item => item.status), ['FILTERED_OUT']);
    assert.equal(saved[0].sourceSku, 'low-rating');
    assert.equal(saved[0].filterResult.accepted, false);
    assert.equal(saved[0].filterResult.reason, 'DETAIL_FILTERED');
    assert.deepEqual(c.outcomes, { skipped: 1, failed: 0 });
    assert.deepEqual(summaries[0].outcomes, { skipped: 1, failed: 0 });
    assert.deepEqual(released, ['low-rating']);
    assert.match(c.task.lastLog, /筛选.*跳过 1 件/);
`));

test('a next-page request failure remains FAILED instead of completing as exhausted', () => probe(`
    pages.get(0).items.forEach(item => duplicateSkus.add(item.sku));
    const first = globalThis.__SELLER_LEADERBOARD_HANDLER__;
    globalThis.__SELLER_LEADERBOARD_HANDLER__ = async options => {
        if (options.offset === 30) throw Object.assign(Error('fixture page failure'), { code: 'SELLER_NETWORK_ERROR' });
        return first(options);
    };
    await c.run();
    assert.deepEqual(terminal, ['fail']);
    assert.equal(c.task.taskStatus, 'failed');
    assert.equal(c.task.lastErrorCode, 'SELLER_NETWORK_ERROR');
    assert.deepEqual(summaries, []);
`));

test('cancelling during a page request retains CANCELLED and never writes a completion summary', () => probe(`
    globalThis.__SELLER_LEADERBOARD_HANDLER__ = async () => {
        await c.cancel();
        c.cancellationController.signal.throwIfAborted();
    };
    await c.run();
    assert.deepEqual(terminal, ['cancel']);
    assert.equal(c.task.taskStatus, 'cancelled');
    assert.deepEqual(summaries, []);
    assert.deepEqual(saved, []);
`));

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { withCollectorRequest } from '../dist-electron/services/collector-network.core.js';

const source = readFileSync(new URL('../dist-electron/services/collection/main-window.services.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function harness(axesFor, modalRows, { failSku = '', accountChange = false } = {}) {
    let account = 'fixture';
    const Service = vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '') + '\nMainWindowService', {
        URL, AbortController, setTimeout, clearTimeout, getAccountPartition: () => account, withCollectorRequest,
        log: { warn() {}, info() {}, error() {} },
    });
    const service = new Service();
    service.browserWindow = { isDestroyed: () => false };
    service.collectionPartition = account;
    const requests = [];
    service.getOzonPageJson = async url => {
        const path = new URL(url).searchParams.get('url');
        requests.push(path);
        const parsed = new URL(path, 'https://www.ozon.ru');
        const sku = parsed.searchParams.get('from_sku') || parsed.pathname.match(/(\d+)/)?.[1];
        if (sku === failSku) throw Object.assign(Error('page unavailable'), { code: 'ZONGZI_HTTP_ERROR', status: 503 });
        if (accountChange) account = 'other';
        return { success: true, data: { widgetStates: { 'webAspects-dynamic-id': JSON.stringify({
            aspects: parsed.pathname.startsWith('/modal/') ? modalRows(sku, parsed.searchParams.get('axis')) : axesFor(sku),
        }) } } };
    };
    return { service, requests };
}
const row = (sku, value = sku) => ({ sku: String(sku), link: `/product/${sku}/`, data: { searchableText: value, title: 'Product', price: '12.00 ¥' } });
const axis = (name, rows, total = rows.length, sku = rows[0]?.sku) => ({
    aspectName: name, variants: rows, aspectModalInfo: { realNumberOfVariants: total, link: `/modal/aspectsNew?from_sku=${sku}&axis=${encodeURIComponent(name)}` },
});

test('discovers all 76 variants by completing each color page size modal', async () => {
    const colors = [Array.from({ length: 38 }, (_, i) => String(1000 + i)), Array.from({ length: 38 }, (_, i) => String(2000 + i))];
    const axes = sku => {
        const color = colors.find(values => values.includes(sku));
        return [axis('Цвет', [row(1000, 'Синий'), row(2000, 'Красный')]), axis('Размер', color.slice(0, 6).map((id, i) => row(id, String(i + 1))), 38, sku)];
    };
    const h = harness(axes, sku => [axis('Размер', colors.find(values => values.includes(sku)).map((id, i) => row(id, String(i + 1))))]);
    assert.equal(typeof h.service.getProductGroup, 'function', 'desktop must discover the complete group');
    const group = await h.service.getProductGroup('1000', { initialAspects: axes('1000') });
    assert.equal(group.complete, true);
    assert.equal(group.skus.length, 76);
    assert.deepEqual(plain(group.skus).sort(), colors.flat().sort());
    for (const [color, skus] of colors.entries()) for (const [size, sku] of skus.entries()) {
        assert.deepEqual(plain(group.variants.find(v => v.sku === sku).aspectValues), { Цвет: color ? 'Красный' : 'Синий', Размер: String(size + 1) });
    }
    assert.ok(h.requests.some(path => path.includes('from_sku=2000')));
    assert.equal(h.requests.filter(path => path.startsWith('/product/')).length, 75);
    assert.equal(h.requests.filter(path => path.startsWith('/modal/')).length, 76);
    assert.equal(new Set(h.requests).size, 151);
});

function grid(width, axisCount, collapsed = false) {
    const names = ['Цвет', 'Размер', 'Фасон'];
    const ids = Array.from({ length: width ** axisCount }, (_, i) => String(3000 + i));
    const rowsFor = (sku, which) => {
        const index = Number(sku) - 3000, step = width ** (axisCount - which - 1);
        return Array.from({ length: width }, (_, value) => row(3000 + index - Math.floor(index / step) % width * step + value * step, String(value)));
    };
    const axes = sku => names.slice(0, axisCount).map((name, which) => {
        const rows = rowsFor(sku, which);
        return axis(name, collapsed ? [rows[0], rows.find(v => v.sku === sku && v.sku !== rows[0].sku) || rows[1]] : rows, width, sku);
    });
    return { ids, axes, modal: (sku, name) => [axis(name, rowsFor(sku, names.indexOf(name)))] };
}

test('finds all 16 SKUs through graph closure when both inline axes are collapsed', async () => {
    const fixture = grid(4, 2, true), h = harness(fixture.axes, fixture.modal);
    assert.equal(typeof h.service.getProductGroup, 'function');
    const group = await h.service.getProductGroup('3000', { initialAspects: fixture.axes('3000') });
    assert.deepEqual(plain(group.skus).sort(), fixture.ids);
    assert.deepEqual(h.requests.filter(path => path.startsWith('/product/')).sort(), fixture.ids.slice(1).map(sku => `/product/${sku}/`));
    assert.equal(h.requests.filter(path => path.startsWith('/modal/')).length, 32);
    assert.equal(new Set(h.requests).size, 47);
});

test('follows the three-axis graph to all 8 SKUs and reads every discovered page once', async () => {
    const fixture = grid(2, 3), h = harness(fixture.axes, fixture.modal);
    assert.equal(typeof h.service.getProductGroup, 'function');
    const group = await h.service.getProductGroup('3000', { initialAspects: fixture.axes('3000') });
    assert.deepEqual(plain(group.skus).sort(), fixture.ids);
    assert.equal(h.requests.length, 7);
    assert.equal(new Set(h.requests).size, 7);
});

const sparsePoints = [
    ['1001', 'A1', 'B1'], ['1002', 'A1', 'B2'], ['1003', 'A1', 'B3'],
    ['2001', 'A2', 'B1'], ['2002', 'A2', 'B2'], ['2003', 'A2', 'B3'], ['3002', 'A3', 'B2'],
];
function sparseAxes(sku, reversed = false) {
    const current = sparsePoints.find(point => point[0] === sku);
    return ['Color', 'Size'].map((name, index) => {
        const which = index + 1;
        const rows = sparsePoints.filter(point => point[3 - which] === current[3 - which])
            .map(point => row(point[0], point[which]));
        return axis(name, reversed ? rows.reverse() : rows, rows.length, sku);
    });
}

for (const [anchor, reversed] of [['1001', false], ['2003', true], ['3002', false]]) {
    test(`sparse two-axis graph includes the branch unique to B2 from entry ${anchor}`, async () => {
        const axes = sku => sparseAxes(sku, reversed), h = harness(axes, () => []);
        const group = await h.service.getProductGroup(anchor, { initialAspects: axes(anchor) });
        assert.deepEqual(plain(group.skus).sort(), ['1001', '1002', '1003', '2001', '2002', '2003', '3002']);
        assert.equal(group.complete, true);
        for (const [sku, color, size] of sparsePoints) {
            assert.deepEqual(plain(group.variants.find(value => value.sku === sku).aspectValues), { Color: color, Size: size });
        }
        assert.equal(h.requests.length, 6);
        assert.equal(new Set(h.requests).size, 6, 'each discovered SKU is read once');
        assert.ok(!h.requests.includes(`/product/${anchor}/`), 'the entry detail is already available');
    });
}

test('two-axis representative color cards cannot hide the other sizes or overwrite own-SKU values', async () => {
    const colors = [['1000', '1001'], ['2000', '2001'], ['3000', '3001']];
    const axes = sku => [
        axis('Color', colors.map((ids, index) => row(ids[0], `A${index + 1}`))),
        axis('Size', colors.find(ids => ids.includes(sku)).map((id, index) => row(id, `B${index + 1}`))),
    ];
    for (const anchor of ['1000', '3001']) {
        const h = harness(axes, () => []);
        const group = await h.service.getProductGroup(anchor, { initialAspects: axes(anchor) });
        assert.deepEqual(plain(group.skus).sort(), ['1000', '1001', '2000', '2001', '3000', '3001']);
        assert.equal(group.complete, true);
        for (const [index, skus] of colors.entries()) for (const [size, sku] of skus.entries()) {
            assert.deepEqual(plain(group.variants.find(value => value.sku === sku).aspectValues), { Color: `A${index + 1}`, Size: `B${size + 1}` });
        }
        assert.equal(h.requests.length, 5);
        assert.equal(new Set(h.requests).size, 5);
    }
});

test('an unavailable sparse branch cannot return a silently complete group', async () => {
    const h = harness(sparseAxes, () => [], { failSku: '3002' });
    await assert.rejects(h.service.getProductGroup('1001', { initialAspects: sparseAxes('1001') }), error => error.code === 'ZONGZI_HTTP_ERROR');
});

test('a one-axis entry follows a sibling that exposes another axis and a new SKU', async () => {
    const pages = {
        '4001': [axis('Color', [row('4001', 'A1'), row('4002', 'A2')])],
        '4002': [axis('Color', [row('4001', 'A1'), row('4002', 'A2')]), axis('Size', [row('4002', 'B1'), row('4003', 'B2')])],
        '4003': [axis('Color', [row('4003', 'A2')]), axis('Size', [row('4002', 'B1'), row('4003', 'B2')])],
    };
    const h = harness(sku => pages[sku], () => []);
    const group = await h.service.getProductGroup('4001', { initialAspects: pages['4001'] });
    assert.deepEqual(plain(group.skus).sort(), ['4001', '4002', '4003']);
    assert.deepEqual(h.requests, ['/product/4002/', '/product/4003/']);
    assert.equal(group.complete, true);
});

test('a short modal cannot qualify a partial group', async () => {
    const fixture = grid(4, 2, true), h = harness(fixture.axes, sku => fixture.axes(sku));
    assert.equal(typeof h.service.getProductGroup, 'function');
    await assert.rejects(h.service.getProductGroup('3000', { initialAspects: fixture.axes('3000') }), error => error.code === 'ZONGZI_GROUP_INCOMPLETE' && /3000/.test(error.message));
});

test('a failed newly discovered three-axis page preserves its network error', async () => {
    const fixture = grid(2, 3), h = harness(fixture.axes, fixture.modal, { failSku: '3007' });
    assert.equal(typeof h.service.getProductGroup, 'function');
    await assert.rejects(h.service.getProductGroup('3000', { initialAspects: fixture.axes('3000') }), error => error.code === 'ZONGZI_HTTP_ERROR');
});

test('group traversal stops on account change and when cancelled', async () => {
    const fixture = grid(2, 3), h = harness(fixture.axes, fixture.modal, { accountChange: true });
    assert.equal(typeof h.service.getProductGroup, 'function');
    await assert.rejects(h.service.getProductGroup('3000', { initialAspects: fixture.axes('3000') }), error => error.code === 'ZONGZI_ACCOUNT_CHANGED');
    const aborted = new AbortController(); aborted.abort();
    const next = harness(fixture.axes, fixture.modal);
    await assert.rejects(next.service.getProductGroup('3000', { initialAspects: fixture.axes('3000'), signal: aborted.signal }));
    assert.equal(next.requests.length, 0);
});

test('single SKU returns a complete one-member group while mismatched aspects fail', async () => {
    const h = harness(() => [], () => []);
    assert.equal(typeof h.service.getProductGroup, 'function');
    assert.deepEqual(plain((await h.service.getProductGroup('3000', { initialAspects: [] })).skus), ['3000']);
    await assert.rejects(h.service.getProductGroup('3000', { initialAspects: [axis('Цвет', [row(9999)])] }), error => error.code === 'ZONGZI_GROUP_INCOMPLETE');
});

test('own-SKU detail fetching stops if the collection account changed while JSON was in flight', async () => {
    const fixture = grid(2, 3), h = harness(fixture.axes, fixture.modal, { accountChange: true });
    await assert.rejects(h.service.getDataByApi('3000'), error => error.code === 'ZONGZI_ACCOUNT_CHANGED');
});

test('recommendation widget aspects cannot become members of the requested product group', async () => {
    const h = harness(() => [], () => []);
    h.service.getOzonPageJson = async () => ({ success: true, data: { widgetStates: {
        webAspects: { aspects: [axis('Цвет', [row(1001), row(1002)])] },
        recommendationWidget: { aspects: [axis('Цвет', [row(9999)])] },
    } } });
    const group = await h.service.getProductGroup('1001');
    assert.deepEqual(plain(group.skus), ['1001', '1002']);
});

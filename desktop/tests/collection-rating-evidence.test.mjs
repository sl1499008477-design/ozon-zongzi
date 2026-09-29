import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseOzonProductCards } from '../dist-electron/services/collection/ozon-list-parser.core.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/ozon-puller-details.json', import.meta.url), 'utf8'));
const compile = async (file, name) => vm.runInNewContext((await readFile(new URL(file, import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '') + '\n' + name, { log: { error() {} } });
const ParseService = await compile('../dist-electron/services/collection/parse.services.js', 'ParseService');
const DataProcessService = await compile('../dist-electron/services/collection/data-filter.services.js', 'DataProcessService');
const card = () => parseOzonProductCards('<main data-widget="searchResultsV2"><div data-index="0"><a href="/product/3491634425/"><img alt="Съемник" src="https://image.test/one.jpg"></a></div></main>', 'https://www.ozon.ru')[0];
const parse = async (goods, widgets = fixture.initial.widgetStates) => new ParseService({
    getSellingData: async () => ({ success: true, data: { widgetStates: {} } }),
}).ozonDetailParse({ success: true, data: { widgetStates: widgets } }, 'https://www.ozon.ru', goods);
const filter = (item, rules) => new DataProcessService({}).filterData([item], { aiSelectType: 1, ...rules }, 'detail');

test('missing card scores remain unknown and the real 4.9/336 detail passes the configured minimums', async () => {
    const goods = card();
    assert.equal(goods.rating, undefined);
    assert.equal(goods.reviewCountLabel, undefined);
    const detail = await parse(goods);
    assert.equal(detail.rating, 4.9);
    assert.equal(detail.reviewCountLabel, 336);
    assert.equal((await filter(detail, { ratingMin: 4, numberOfCommentsMin: 100 })).length, 1);
});

test('precise detail scores replace earlier card values before maximum filters run', async () => {
    const detail = await parse({ ...card(), rating: '1', reviewCountLabel: '5' });
    assert.equal(detail.rating, 4.9);
    assert.equal(detail.reviewCountLabel, 336);
    assert.equal((await filter(detail, { numberOfCommentsMax: 300 })).length, 0);
});

test('missing scores at both sources cannot pass a maximum of zero by becoming invented zeroes', async () => {
    const detail = await parse(card(), { webGallery: { sku: '3491634425', images: ['https://image.test/one.jpg'] } });
    assert.equal(detail.rating, undefined);
    assert.equal(detail.reviewCountLabel, undefined);
    assert.equal((await filter(detail, { ratingMax: 0 })).length, 0);
    assert.equal((await filter(detail, { numberOfCommentsMax: 0 })).length, 0);
});

test('explicit zero detail scores remain zero and are not replaced by a stale nonzero card', async () => {
    const detail = await parse({ ...card(), rating: '4.9', reviewCountLabel: '336' }, {
        webGallery: { sku: '3491634425', images: ['https://image.test/one.jpg'] },
        webReviewProductScore: { totalScore: 0, reviewsCount: 0 },
    });
    assert.equal(detail.rating, 0);
    assert.equal(detail.reviewCountLabel, 0);
    assert.equal((await filter(detail, { ratingMax: 0, numberOfCommentsMax: 0 })).length, 1);
    assert.equal((await filter(detail, { ratingMin: 1 })).length, 0);
});

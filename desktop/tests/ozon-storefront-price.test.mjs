import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import { parseOzonProductCards } from '../dist-electron/services/collection/ozon-list-parser.core.js';

const source = await readFile(new URL('../dist-electron/services/collection/parse.services.js', import.meta.url), 'utf8');
const ParseService = vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '') + '\nParseService', {
    log: { error() {} }, cheerio, parseOzonProductCards,
});
const goods = { _id: '1508194124', id: '1508194124', price: 1541.268, avgPrice: 1541.268, name: 'Бумага', soldCount: 60, photo: 'https://ir-20.ozonstatic.cn/paper.jpg' };

async function parse(priceWidget, options = {}) {
    const parser = new ParseService({ getSellingData: async () => ({ success: true, data: { widgetStates: {
        'webSellerList-4723017-default-1': JSON.stringify({ sellers: options.sellers || [] }),
    } } }) });
    const widgetStates = {
        'webPricePerStars-123-default-1': JSON.stringify({ price: '1,00 ¥' }),
        ...(priceWidget === undefined ? {} : { 'webPrice-actual-provider-layout-99': options.objectWidget ? priceWidget : JSON.stringify(priceWidget) }),
    };
    return JSON.parse(JSON.stringify(await parser.ozonDetailParse({ success: options.success !== false, data: { widgetStates } }, 'https://www.ozon.ru', { ...goods, ...options.goods })));
}

test('actual detail parser separates dynamic webPrice ordinary, bank and marketing prices from Seller RUB statistics', async () => {
    const result = await parse({ price: '128,91\u00a0¥', cardPrice: '127,66\u00a0¥', originalPrice: '190,00 ¥', marketingPrice: '120,00 ¥' }, {
        goods: { storefrontPrice: { amount: '999', currencyCode: 'RUB' } },
    });
    assert.deepEqual(result.storefrontPrice, {
        amount: '128.91', ordinaryAmount: '128.91', currencyCode: 'CNY', originalAmount: '190.00', bankAmount: '127.66', marketingAmount: '120.00', source: 'ozon-web-price',
    });
    assert.equal(result.price, 1541.268, 'the input for existing price-tier market rules remains Seller RUB');
    assert.equal(result.avgPrice, 1541.268);
    assert.equal(result.cover, goods.photo);
    assert.equal(result.id, goods.id);
});

test('actual price strings preserve decimal values across CNY NBSP and RUB narrow spaces', async () => {
    for (const [price, amount, currencyCode] of [
        ['1\u00a0288,91\u00a0¥', '1288.91', 'CNY'],
        ['1\u202f541,27\u00a0₽', '1541.27', 'RUB'],
        ['RUB 1541.27', '1541.27', 'RUB'],
    ]) {
        assert.deepEqual((await parse({ price })).storefrontPrice, { amount, ordinaryAmount: amount, currencyCode, source: 'ozon-web-price' });
    }
});

test('a plain provider widget object is parsed with the same price contract as a JSON string', async () => {
    const widget = { price: '128,91 ¥', cardPrice: '127,66 ¥' };
    assert.deepEqual((await parse(widget, { objectWidget: true })).storefrontPrice, {
        amount: '128.91', ordinaryAmount: '128.91', currencyCode: 'CNY', bankAmount: '127.66', source: 'ozon-web-price',
    });
});

test('a card-only widget uses its actual currency and never mixes an original price in another currency', async () => {
    assert.deepEqual((await parse({ cardPrice: '127,66 ¥', originalPrice: '2 000 ₽' })).storefrontPrice, {
        amount: '127.66', ordinaryAmount: null, currencyCode: 'CNY', bankAmount: '127.66', source: 'ozon-web-price',
    });
    assert.deepEqual((await parse({ price: '1 500 ₽', cardPrice: '127,66 ¥', originalPrice: '2 000 ₽' })).storefrontPrice, {
        amount: '1500', ordinaryAmount: '1500', currencyCode: 'RUB', originalAmount: '2000', source: 'ozon-web-price',
    });
});

test('unknown currency and absent ordinary/card prices do not manufacture a CNY price from Seller statistics', async () => {
    for (const widget of [undefined, {}, { price: '128,91' }, { price: '128,91 $' }, { price: '128,91 USD', cardPrice: '127,66 ¥' }, { marketingPrice: '120,00 ¥' }]) {
        const result = await parse(widget);
        assert.equal(result.storefrontPrice, null);
        assert.equal(result.price, goods.price);
        assert.equal(result.soldCount, goods.soldCount);
    }
    const unavailable = await parse({ price: '128,91 ¥' }, { success: false });
    assert.equal(unavailable.storefrontPrice, null);
    assert.equal(unavailable.id, goods.id);
    assert.equal(unavailable.price, goods.price);
});

test('seller minimum prices only compare parsed amounts in the storefront currency', async () => {
    const result = await parse({ price: '128,91 ¥' }, { sellers: [
        { price: { cardPrice: { price: '127,66 ¥' } } },
        { price: { cardPrice: { price: '10 ₽' } } },
        { price: { cardPrice: { price: '1,00 $' } } },
    ] });
    assert.equal(result.followMinPrice, '127.66');
    assert.equal(result.followPriceCurrency, 'CNY');
    assert.equal(result.sellerNumber, 3);
});

test('the recorded live Ozon CNY widget yields its ordinary reference price rather than the bank or per-unit amount', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/ozon-storefront-cny.json', import.meta.url), 'utf8'));
    const parser = new ParseService({ getSellingData: async () => ({ success: true, data: { widgetStates: {} } }) });
    const detail = await parser.ozonDetailParse({ success: true, data: fixture }, 'https://www.ozon.ru', goods);
    assert.equal(detail.id, fixture.sourceSku);
    assert.deepEqual(JSON.parse(JSON.stringify(detail.storefrontPrice)), {
        amount: '128.91', ordinaryAmount: '128.91', currencyCode: 'CNY', bankAmount: '127.66', source: 'ozon-web-price',
    });
    assert.equal(detail.rating, '4.8');
    assert.equal(detail.reviewCountLabel, '3671');
    assert.equal(detail.price, 1541.268);
});

const listHtml = price => `<main data-widget="searchResultsV2"><div data-index="0">
    <a href="/product/1508194124/"><img src="https://ir-20.ozonstatic.cn/paper.jpg">Бумага</a>
    <span class="tsHeadline500Medium">${price}</span></div></main>`;

test('list seller prices retain their CNY decimal and currency through Seller enrichment and unavailable detail', async () => {
    const parser = new ParseService({ getSellingData: async () => ({ success: true, data: { widgetStates: {
        'webSellerList-4723017-default-1': JSON.stringify({ sellers: [
            { price: { cardPrice: { price: '29,50\u2009¥' } } },
            { price: { cardPrice: { price: '1 ₽' } } },
        ] }),
    } } }) });
    const listed = await parser.ozonListParser(listHtml('30 ¥'), 'https://www.ozon.ru');
    const filterSource = await readFile(new URL('../dist-electron/services/collection/data-filter.services.js', import.meta.url), 'utf8');
    const DataProcessService = vm.runInNewContext(filterSource.replace(/^import .*;\n/gm, '').replace('export class', 'class') + '\nDataProcessService', {
        dayjs,
        fetchSellerSkuAnalyticsBatch: async () => [{ goods_id: '1508194124', price: 1774.871, discount: 0, nullableCreateDate: '2026-08-01' }],
    });
    const [enriched] = await new DataProcessService().getBaseData(listed);
    const detail = await parser.ozonDetailParse({ success: false }, 'https://www.ozon.ru', enriched);
    assert.equal(detail.price, 1774.871, 'Seller price continues to drive the RUB market filters');
    assert.equal(detail.analyticsCurrency, 'RUB');
    assert.equal(detail.storefrontPrice, null, 'a missing detail response cannot invent its public price');
    assert.equal(detail.followMinPrice, '29.50');
    assert.equal(detail.followPriceCurrency, 'CNY');
});

test('list seller lookup failures retain a known page currency and never invent one for an unknown price', async () => {
    for (const [pagePrice, amount, currency] of [['30 ¥', '30', 'CNY'], ['30', undefined, ''], ['30 USD', undefined, '']]) {
        const parser = new ParseService({ getSellingData: async () => ({ success: false }) });
        const [item] = await parser.ozonListParser(listHtml(pagePrice), 'https://www.ozon.ru');
        assert.equal(item.followMinPrice, amount);
        assert.equal(item.followPriceCurrency, currency);
    }
});


test('list dedup runs before seller requests and keeps scanned counts even when the whole page is skipped', async () => {
    const requested = [];
    const parser = new ParseService({ getSellingData: async url => { requested.push(url); return { success: false }; } });
    let checked = [];
    const items = await parser.ozonListParser(listHtml('30 ¥'), 'https://www.ozon.ru', async candidates => {
        checked = candidates.map(item => item.id); return [];
    });
    assert.deepEqual(Array.from(checked), ['1508194124']);
    assert.equal(items.length, 0);
    assert.equal(requested.length, 0);
    assert.equal(parser.getDataCount(), 1);
});

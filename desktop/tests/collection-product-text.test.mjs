import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { withCollectorRequest } from '../dist-electron/services/collector-network.core.js';
import * as cheerio from 'cheerio';
import { normalizeSellerAnalyticsResponse } from '../dist-electron/services/seller-analytics.core.js';
import { prepareCollectRequestV4 } from '../../server/collection-pipeline.mjs';
import { buildCollectItemDraftV4 } from '../../server/listing-pipeline.mjs';

const sku = '3491634425';
const fixture = JSON.parse(await readFile(new URL('./fixtures/ozon-puller-details.json', import.meta.url), 'utf8'));
const parseSource = await readFile(new URL('../dist-electron/services/collection/parse.services.js', import.meta.url), 'utf8');
const windowSource = await readFile(new URL('../dist-electron/services/collection/main-window.services.js', import.meta.url), 'utf8');
const compile = (source, name, context = {}) => vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '') + '\n' + name,
    { URL, cheerio, log: { error() {}, warn() {} }, setTimeout, clearTimeout, withCollectorRequest, ...context });
const ParseService = compile(parseSource, 'ParseService');
const jsonLd = value => `<html><script type="application/ld+json">${JSON.stringify(value)}</script></html>`;
const states = () => ({ webGallery: { sku, images: ['https://image.test/one.jpg'], videos: [{ url: 'https://video.test/one.mp4' }] },
    webDescription: { richAnnotationType: 'JSON', richAnnotationJson: JSON.stringify({ content: [{ widgetName: 'raShowcase', blocks: [{ img: { src: 'https://image.test/one.jpg' } }] }] }) },
    webPrice: { price: '46,45 ¥', cardPrice: '44,13 ¥' } });
async function parse(widgets, { html = '', goods = { id: sku, name: 'Съемник' }, readHtml } = {}) {
    const parser = new ParseService({ getProductHtml: readHtml || (async id => { assert.equal(id, sku); return html; }),
        getSellingData: async () => ({ success: true, data: { widgetStates: {} } }) });
    return JSON.parse(JSON.stringify(await parser.ozonDetailParse({ success: true, data: { widgetStates: widgets } }, 'https://www.ozon.ru', goods)));
}

test('real same-SKU heading replaces Chinese analytics aliases before collect-box validation', async () => {
    const goods = normalizeSellerAnalyticsResponse({ items: [{ sku, name: '拉拔器', title: '中文标题', price: 598.14 }] }).items[0];
    const result = await parse({ ...fixture.initial.widgetStates, ...fixture.continuation.widgetStates }, { goods });
    const title = 'Съемники автомобильных клипс, усиленные. Лопатки для снятия обшивки и пластика в салоне авто, 6 шт';
    assert.equal(result.name, title);
    assert.equal(result.nameLabel, title);
    assert.equal(result.title, title);
    assert.equal(result.images.length, 9);
    assert.doesNotThrow(() => prepareCollectRequestV4({ authenticatedAccount: { id: 'text-test' }, input: {
        source: 'ozon', sourceSku: sku, requestId: 'text-test-request', payload: { ...result, currencyCode: 'CNY', price: '46.45' },
    } }));
});

test('same-SKU JSON-LD supplies ordinary description without using set contents or recommendation text', async () => {
    const widgets = states();
    widgets.webCharacteristics = { characteristics: [{ name: 'Комплектация', values: [{ text: 'Съемник и коробка' }] }] };
    const result = await parse(widgets, { html: jsonLd({ '@graph': [
        { '@type': 'Organization', sku, description: 'Описание магазина' },
        { '@type': 'Product', sku: '999', description: 'Описание соседнего товара' },
        { '@type': 'Product', sku, name: 'Съемник автомобильных клипс', description: 'Описание товара. Усиленный автомобильный съемник.' },
    ] }) });
    assert.equal(result.description, 'Описание товара. Усиленный автомобильный съемник.');
    assert.equal(result.contentDiagnostics?.description?.source, 'json_ld');
    assert.equal(result.contentDiagnostics?.description?.status, 'provided');
    assert.equal(result.sourceCharacteristics[0].value, 'Съемник и коробка');
    assert.equal(result.images.length, 1);
    assert.equal(result.videos.length, 1);
    assert.equal(result.storefrontPrice.amount, '46.45');
    assert.equal(JSON.parse(result.richContent).content[0].widgetName, 'raShowcase');
    const saved = prepareCollectRequestV4({ authenticatedAccount: { id: 'text-test' }, input: {
        source: 'ozon', sourceSku: sku, requestId: 'description-test', payload: { ...result, currencyCode: 'CNY', price: '46.45' },
    } }).normalizedItem;
    const draft = buildCollectItemDraftV4(saved);
    assert.equal(draft.description, 'Описание товара. Усиленный автомобильный съемник.');
    assert.equal(draft.richContent, result.richContent);
    assert.deepEqual(draft.videos, result.videos);
});

test('set contents stays a characteristic when no ordinary description was supplied', async () => {
    const widgets = states();
    widgets.webCharacteristics = { characteristics: [{ name: 'Комплектация', values: [{ text: 'Съемник и коробка' }] }] };
    const result = await parse(widgets);
    assert.equal(result.description, undefined);
    assert.equal(result.contentDiagnostics?.description?.status, 'not_provided');
    assert.equal(result.sourceCharacteristics[0].name, 'Комплектация');
});

test('an actual HTML description avoids an extra public-page request', async () => {
    const widgets = states();
    widgets.webDescription.richAnnotationType = 'HTML';
    widgets.webDescription.richAnnotation = '<p>Русское описание товара</p>';
    let requests = 0;
    const result = await parse(widgets, { readHtml: async () => { requests++; return jsonLd({ '@type': 'Product', sku, description: 'Другое описание' }); } });
    assert.equal(result.description, '<p>Русское описание товара</p>');
    assert.equal(requests, 0);
});

test('JSON-LD name recovers a translated title using only the requested Product', async () => {
    const result = await parse(states(), { goods: { id: sku, name: '中文名称', nameLabel: '中文名称', title: '中文名称' },
        html: jsonLd([{ '@type': 'Product', sku: '999', name: 'Другой товар' },
            { '@type': 'Product', sku, name: 'Съемник автомобильных клипс', description: 'Русское описание товара' }]) });
    assert.equal(result.name, 'Съемник автомобильных клипс');
    assert.equal(result.nameLabel, result.name);
    assert.equal(result.title, result.name);
});

for (const [label, html, status] of [
    ['foreign Product', jsonLd({ '@type': 'Product', sku: '999', description: 'Чужое описание' }), 'unverified'],
    ['nested recommendation', jsonLd({ '@type': 'WebPage', recommendation: { '@type': 'Product', sku, description: 'Рекомендация' } }), 'not_provided'],
    ['Chinese description', jsonLd({ '@type': 'Product', sku, description: '中文商品描述' }), 'read_failed'],
    ['malformed JSON-LD', '<script type="application/ld+json">{bad</script>', 'read_failed'],
]) {
    test(label + ' does not become ordinary description or discard a valid gallery', async () => {
        const result = await parse(states(), { html });
        assert.equal(result.description, undefined);
        assert.equal(result.images.length, 1);
        assert.equal(result.contentDiagnostics?.description?.status, status);
    });
}

test('an optional description network failure preserves product content and records its cause', async () => {
    const result = await parse(states(), { readHtml: async () => { throw Object.assign(new Error('简介读取超时'), { code: 'ZONGZI_REQUEST_TIMEOUT' }); } });
    assert.equal(result.images.length, 1);
    assert.equal(result.description, undefined);
    assert.equal(result.contentDiagnostics?.description?.status, 'read_failed');
});

test('description fallback keeps access, account and cancellation failures terminal', async () => {
    for (const code of ['ZONGZI_ACCESS_BLOCKED', 'ZONGZI_ACCOUNT_CHANGED', 'COLLECTION_CANCELLED', 'COLLECTION_WINDOW_CLOSED']) {
        await assert.rejects(parse(states(), { readHtml: async () => { throw Object.assign(new Error(code), { code }); } }), error => error.code === code);
    }
});

test('an explicit foreign-SKU heading cannot rename the requested product', async () => {
    await assert.rejects(parse({ ...states(), webProductHeading: { sku: '999', title: 'Другой товар' } }), error => error.code === 'ZONGZI_RESPONSE_SKU_MISMATCH');
});

function htmlService(response, { currentPartition = () => 'account-one' } = {}) {
    const MainWindowService = compile(windowSource, 'MainWindowService', { getAccountPartition: currentPartition });
    const service = new MainWindowService();
    service.collectionPartition = 'account-one';
    service.browserWindow = { isDestroyed: () => false, webContents: { executeJavaScript: script => vm.runInNewContext(script,
        { URL, AbortController, setTimeout, clearTimeout, fetch: async (url, options) => { assert.equal(url, `https://www.ozon.ru/product/${sku}/`); assert.equal(options.credentials, 'include'); return response(); } }) } };
    return service;
}

test('same-SKU public HTML uses the existing session without navigating the collection window', async () => {
    const html = jsonLd({ '@type': 'Product', sku, description: 'Русское описание товара' });
    const service = htmlService(() => ({ ok: true, status: 200, url: `https://www.ozon.ru/product/semnik-${sku}/`, text: async () => html }));
    assert.equal(typeof service.getProductHtml, 'function');
    assert.equal(await service.getProductHtml(sku), html);
});

test('HTML fallback refuses a different product redirect and platform access challenge', async () => {
    const redirect = htmlService(() => ({ ok: true, status: 200, url: 'https://www.ozon.ru/product/999/', text: async () => '<html>Другой товар</html>' }));
    assert.equal(typeof redirect.getProductHtml, 'function');
    await assert.rejects(redirect.getProductHtml(sku), error => error.code === 'ZONGZI_RESPONSE_SKU_MISMATCH');
    const blocked = htmlService(() => ({ ok: false, status: 403, text: async () => '<html>Antibot Captcha</html>' }));
    await assert.rejects(blocked.getProductHtml(sku), error => error.code === 'ZONGZI_ACCESS_BLOCKED' && error.status === 403);
});

test('a changed application account cannot receive the previous session HTML', async () => {
    let partition = 'account-one';
    const service = htmlService(() => { partition = 'account-two'; return { ok: true, status: 200, text: async () => '<html>Product</html>' }; }, { currentPartition: () => partition });
    assert.equal(typeof service.getProductHtml, 'function');
    await assert.rejects(service.getProductHtml(sku), error => error.code === 'ZONGZI_ACCOUNT_CHANGED');
});

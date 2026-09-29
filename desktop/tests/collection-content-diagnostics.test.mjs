import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as cheerio from 'cheerio';

const sku = '1602438352';
const compile = async (file, name) => vm.runInNewContext(
    (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/^export (?=class |function )/gm, '') + '\n' + name,
    { URL, cheerio, log: { error() {}, warn() {} } });
const ParseService = await compile('../dist-electron/services/collection/parse.services.js', 'ParseService');
const MainWindowService = await compile('../dist-electron/services/collection/main-window.services.js', 'MainWindowService');
const photo = 'https://cdn.test/1602438352/photo.jpg';
const color = 'https://cdn.test/1602438352/swatch.jpg?Signature=a%2Fb%2Bc%3D';
const cover = 'https://cdn.test/1602438352/cover.MOV?Signature=a%2Fb';
const video = { url: 'https://cdn.test/1602438352/product.mp4', coverUrl: 'https://cdn.test/1602438352/poster.jpg' };
const richContent = JSON.stringify({ content: [{ widgetName: 'raTextBlock', blocks: [{ text: 'Описание товара' }] }] });
const description = '<p>Русское описание товара</p>';
const fields = ['description', 'richContent', 'videos', 'color_image', 'videoCoverUrl'];
const gallery = () => ({ sku, coverImage: photo, images: [photo] });
const complete = () => ({ webGallery: { ...gallery(), videos: [video], color_image: color, videoCover: { url: cover } },
    webDescription: { sku, richAnnotationType: 'HTML', richAnnotation: description, richAnnotationJson: richContent } });
async function parse(widgetStates, goods = { id: sku }, html) {
    const service = new ParseService({ getSellingData: async () => ({ success: true, data: { widgetStates: {} } }),
        ...(html === undefined ? {} : { getProductHtml: async () => html }) });
    const result = await service.ozonDetailParse({ success: true, data: { widgetStates } }, 'https://www.ozon.ru', goods);
    return JSON.parse(JSON.stringify(result));
}

test('explicit same-SKU media reaches the result with five provided diagnostics and unchanged Seller attributes', async () => {
    const attributes = [{ id: 85, values: [{ dictionary_value_id: 17, value: 'Металл' }] }];
    const complex_attributes = [{ attributes: [{ complex_id: 100001, id: 21837, values: [{ value: 'Исходное видео' }] }] }];
    const result = await parse(complete(), { id: sku, attributes, complex_attributes });
    assert.equal(result.color_image, color);
    assert.equal(result.videoCoverUrl, cover);
    assert.deepEqual(result.images, [photo]);
    assert.deepEqual(result.videos, [video]);
    assert.equal(result.description, description);
    assert.equal(result.richContent, richContent);
    assert.deepEqual(result.attributes, attributes);
    assert.deepEqual(result.complex_attributes, complex_attributes);
    for (const field of fields) assert.equal(result.contentDiagnostics?.[field]?.status, 'provided', field);
});

test('observed empty gallery and description record absence without inventing media', async () => {
    const result = await parse({ webGallery: gallery(), webDescription: { characteristics: [] } });
    for (const field of fields) assert.equal(result.contentDiagnostics?.[field]?.status, 'not_provided', field);
    assert.equal(result.color_image, undefined);
    assert.equal(result.videoCoverUrl, undefined);
    assert.equal(result.videos, undefined);
});

test('public HTML description cannot turn unobserved gallery or rich content into confirmed absence', async () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', sku, description: 'Описание из HTML' })}</script>`;
    const result = await parse({}, { id: sku }, html);
    assert.equal(result.description, 'Описание из HTML');
    assert.equal(result.contentDiagnostics?.description?.status, 'provided');
    for (const field of fields.slice(1)) assert.equal(result.contentDiagnostics?.[field]?.status, 'unverified', field);
});

for (const videoCover of [{ trackingInfo: { click: 'tracking-only' } }, {}, { url: photo }, { url: 'https://cdn.test/stream.m3u8' }]) {
    test('a non-video gallery cover remains unverified: ' + JSON.stringify(videoCover), async () => {
        const result = await parse({ webGallery: { ...gallery(), videos: [video], videoCover } });
        assert.equal(result.videoCoverUrl, undefined);
        assert.equal(result.contentDiagnostics?.videoCoverUrl?.status, 'unverified');
        assert.deepEqual(result.videos, [video]);
        assert.deepEqual(result.images, [photo]);
    });
}

for (const color_image of ['https://', 'https://bad host/swatch.jpg', 'ftp://cdn.test/swatch.jpg']) {
    test('invalid explicit color link is visible as unverified: ' + color_image, async () => {
        const result = await parse({ webGallery: { ...gallery(), color_image } });
        assert.equal(result.color_image, undefined);
        assert.equal(result.contentDiagnostics?.color_image?.status, 'unverified');
    });
}

test('static photos listed as video URLs never become ordinary product videos', async () => {
    const result = await parse({ webGallery: { ...gallery(), videos: [{ url: photo }, video] } });
    assert.deepEqual(result.videos, [video]);
    assert.equal(result.contentDiagnostics?.videos?.status, 'provided');
    const empty = await parse({ webGallery: { ...gallery(), videos: [{ url: photo }] } });
    assert.equal(empty.videos, undefined);
    assert.equal(empty.contentDiagnostics?.videos?.status, 'unverified');
});

test('recommendation and aspect payloads cannot supply the requested SKU media', async () => {
    const result = await parse({ webGallery: gallery(), webAspects: { variants: [{ sku: '999', color_image: color, videoCover: { url: cover } }] },
        skuGrid: { webGallery: complete().webGallery, webDescription: complete().webDescription }, recommendationWebGallery: complete().webGallery });
    assert.equal(result.color_image, undefined);
    assert.equal(result.videoCoverUrl, undefined);
    assert.equal(result.description, undefined);
    assert.equal(result.richContent, undefined);
    assert.equal(result.videos, undefined);
    assert.equal(result.contentDiagnostics?.color_image?.status, 'not_provided');
});

test('explicitly foreign gallery and description fail before their contents can be saved', async () => {
    for (const field of ['webGallery', 'webDescription']) {
        const states = complete(); states[field].sku = '999';
        await assert.rejects(parse(states), error => error.code === 'ZONGZI_RESPONSE_SKU_MISMATCH');
    }
});

test('retained same-SKU content keeps its existing provenance when no replacement widget was read', async () => {
    const contentDiagnostics = Object.fromEntries(fields.map(field => [field, { status: 'provided', source: 'existing_same_sku' }]));
    const goods = { id: sku, description, richContent, videos: [video], color_image: color, videoCoverUrl: cover, contentDiagnostics };
    const result = await parse({}, goods);
    assert.deepEqual(result.contentDiagnostics, contentDiagnostics);
    assert.equal(result.color_image, color);
    assert.equal(result.videoCoverUrl, cover);
    assert.equal(result.richContent, richContent);
    assert.deepEqual(result.videos, [video]);
});

test('unreadable rich-content structure records a failed read while retaining the valid gallery', async () => {
    const result = await parse({ webGallery: gallery(), webDescription: { richAnnotationJson: '{"unexpected":[]}' } });
    assert.equal(result.richContent, undefined);
    assert.equal(result.contentDiagnostics?.richContent?.status, 'read_failed');
    assert.deepEqual(result.images, [photo]);
});

test('later duplicate video and empty rich widgets cannot erase their earlier supplied content', async () => {
    const result = await parse({ ...complete(), webGallery: { ...gallery(), videos: [video] },
        'webGallery-page-2': { ...gallery(), videos: [{ url: video.url }] },
        'webDescription-page-2': { richAnnotationJson: '{"content":[]}' } });
    assert.deepEqual(result.videos, [video]);
    assert.equal(result.richContent, richContent);
    const empty = await parse({ webGallery: gallery(), webDescription: { richAnnotationJson: '{"content":[]}' } });
    assert.equal(empty.richContent, undefined);
    assert.equal(empty.contentDiagnostics?.richContent?.status, 'not_provided');
});

for (const mediaOnFirstPage of [true, false]) {
    test('duplicate widget IDs retain photos and media from both same-SKU pages: mediaOnFirstPage=' + mediaOnFirstPage, async () => {
        const withMedia = { ...gallery(), videos: [video], color_image: color, videoCover: { url: cover } };
        const withPhotos = { ...gallery(), images: [photo, 'https://cdn.test/1602438352/detail.jpg'] };
        const initial = { widgetStates: {
            webGallery: mediaOnFirstPage ? withMedia : withPhotos,
            webDescription: { richAnnotationType: 'HTML', richAnnotation: description },
            paginator: { nextPage: `/product/${sku}/?layout_container=pdpPage2column&layout_page_index=2` },
        } };
        const next = { widgetStates: { webGallery: mediaOnFirstPage ? withPhotos : withMedia, webDescription: { richAnnotationJson: richContent } } };
        const service = new MainWindowService();
        service.getOzonPageJson = async target => ({ success: true, data: new URL(target).searchParams.get('url').includes('layout_page_index=2') ? next : initial });
        const response = await service.getDataByApi(sku);
        const result = await parse(response.data.widgetStates);
        assert.deepEqual(result.images, [photo, 'https://cdn.test/1602438352/detail.jpg']);
        assert.deepEqual(result.videos, [video]);
        assert.equal(result.description, description);
        assert.equal(result.richContent, richContent);
        assert.equal(result.color_image, color);
        assert.equal(result.videoCoverUrl, cover);
        for (const field of fields) assert.equal(result.contentDiagnostics?.[field]?.status, 'provided', field);
    });
}

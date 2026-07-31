const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-core');

const rootDir = path.resolve(__dirname, '..', '..');
const SKU = '7312345678';
const OTHER_SKU = '7399999999';

function browserPath() {
  const candidates = [
    process.env.JZ_BROWSER_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  assert.ok(executablePath, 'Chrome/Chromium is required for the Ozon product collection fixture');
  return executablePath;
}

function fixtureHtml(mode) {
  const multivariant = mode.startsWith('multivariant');
  const pageMissing = mode === 'page-missing';
  const productJsonLd = {
    '@type': 'Product',
    sku: SKU,
    offers: { price: '1200', priceCurrency: 'RUB' },
    brand: { name: 'Fixture brand' },
    ...(pageMissing ? {} : {
      name: 'Fixture page title',
      image: ['https://cdn.test/page-1.jpg', 'https://cdn.test/page-2.jpg'],
    }),
  };
  const aspects = multivariant ? [{
    aspectName: 'Цвет',
    variants: [
      {
        sku: SKU,
        active: true,
        availability: 'available',
        link: `/product/fixture-${SKU}`,
        data: { title: 'Blue fixture', price: '1200 ₽', coverImage: 'https://cdn.test/blue.jpg', searchableText: 'Blue' },
      },
      {
        sku: OTHER_SKU,
        active: false,
        availability: 'available',
        link: `/product/fixture-${OTHER_SKU}`,
        data: { title: 'Red fixture', price: '1300 ₽', coverImage: 'https://cdn.test/red.jpg', searchableText: 'Red' },
      },
    ],
  }] : [];
  const states = aspects.length
    ? `<div data-widget="webAspects" data-state='${JSON.stringify({ aspects })}'></div>`
    : '';
  return `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify(productJsonLd)}</script>
  </head><body>
    ${states}
    <div data-widget="webHashtags"><a title="#fixture"></a><a title="#complete"></a></div>
    <div data-widget="webPrice">1200 ₽</div>
    <script>
      window.__JZ_BRAND__ = { displayName: 'ozon 粽子', logoUrl: '' };
      window.chrome = {
        storage: {
          local: {
            get(keys, callback) { const value = {}; if (callback) callback(value); return Promise.resolve(value); },
            set() { return Promise.resolve(); },
          },
          onChanged: { addListener() {} },
        },
        runtime: { onMessage: { addListener() {} } },
      };
      window.checkAuth = async () => ({ loggedIn: true });
      window.createLoginPrompt = () => {};
      window.jzDataCardAllowed = async () => ({ allowed: false, reason: 'MEMBERSHIP_REQUIRED' });
      window.jzRenderDataCardLocked = () => {};
      window.jzBindPanelBrandFallback = () => {};
      window.normalizePrice = (value) => Number(String(value || '').replace(/[^\\d.]/g, '')) || 0;
      window.jzDetectOzonMoneyCurrency = (value) => String(value || '').includes('¥') ? 'CNY' : 'RUB';
      window.jzExtractOzonCalcPriceTags = () => ({
        blackPrice: 1200,
        blackPriceCurrency: 'RUB',
        greenPrice: 1100,
        greenPriceCurrency: 'RUB',
      });
      window.jzStripPromo = (value) => value;
      window.jzIsTranslated = () => false;
      window.lucideIcon = () => '<svg></svg>';
      window.jzPanelBrandHeaderHtml = () => '<div></div>';
      window.extractStateData = (key) => ({
        'state-webGallery': {
          images: ${JSON.stringify(pageMissing ? [] : ['https://cdn.test/page-1.jpg', 'https://cdn.test/page-2.jpg'])},
          videos: [{ videoUrl: 'https://cdn.test/source.mp4', previewUrl: 'https://cdn.test/source-cover.jpg' }],
        },
        'state-webCurrentSeller': {
          sellerCell: {
            centerBlock: { title: { text: 'Fixture seller' } },
            common: { action: { link: 'https://www.ozon.ru/seller/fixture/' } },
          },
        },
        'state-paginator': {
          detail_info: { sold_count: 44, sold_sum: 52800, views: 900, conv_view_to_order: 4.9, discount: 12, gmv_sum: 52800 },
        },
      }[key] || null);
      window.findStateDataByKeys = () => null;
      const richContent = JSON.stringify({
        content: [{ widgetName: 'raTextBlock', text: { content: ['Fixture rich content text'] } }],
        version: 0.3,
      });
      window.ensurePdpState = async () => ({ description: { richAnnotationJson: richContent } });
      window.JZOzonVideoExtract = {
        extractOzonVideoFromSources: () => ({ mp4: 'https://cdn.test/source.mp4', cover: 'https://cdn.test/source-cover.jpg' }),
      };
      window.jzExtractCatalogFromSv = (variant) => variant ? ({
        name: variant.name,
        mainImage: variant.images?.[0],
        images: variant.images || [],
      }) : null;
      window.jzPreferSourceName = (source, page) => source || page;
      window.JZFollowSellContentCopy = {
        pickFollowSellDescription: () => 'Fixture description',
        mergeSourceDescriptionIntoVariant(variant, description) { variant.description = description; return variant; },
        mergeSourceHashtagsIntoVariant(variant, hashtags) { variant.hashtags = [...hashtags]; return variant; },
        shouldForceCollectRefresh: () => true,
      };

      const completeVariant = (sku) => ({
        variant_id: 'variant-' + sku,
        _searchMeta: { skus: [{ sku: String(sku) }] },
        name: 'Seller title ' + sku,
        images: ['https://cdn.test/seller-' + sku + '.jpg'],
        description_category_id: 321,
        type_id: 654,
        attributes: [
          { key: '4497', value: '500' },
          { key: '9454', value: '300' },
          { key: '9455', value: '200' },
          { key: '9456', value: '100' },
        ],
      });
      const runtimeMessages = [];
      window.sendMessage = async (action, payload) => {
        runtimeMessages.push({ action, payload: structuredClone(payload || {}) });
        if (action === 'searchVariants') {
          return { items: [completeVariant('${OTHER_SKU}'), completeVariant('${SKU}')] };
        }
        if (action === 'uploadFollowSellVideo') {
          return { url: 'https://seller-cdn.test/transferred.mp4' };
        }
        if (action === 'pushSourceCollect') {
          return { dedupeHit: false, result: { id: 'direct-upload-must-not-run' } };
        }
        return {};
      };

      window.JZSkuCollect = {
        collectBySkus: async (skus) => ({
          sourceMap: new Map(skus.map((sku) => [String(sku), {
            _sourceVariant: completeVariant(String(sku)),
            name: 'Seller title ' + sku,
            images: ['https://cdn.test/seller-' + sku + '.jpg'],
            description: 'Description ' + sku,
          }])),
        }),
      };

      const prefetchCalls = [];
      const prefetchBatchCalls = [];
      const collectCalls = [];
      let coordinatorStatus = 'IDLE';
      const normalizeResult = (sku) => ({
        status: 'COMPLETE',
        contractVersion: 'collector.ozon.enrichment.v1',
        sku: String(sku),
        descriptionCategoryId: 321,
        typeId: 654,
        logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
        variantData: completeVariant(String(sku)),
        source: 'BACKEND_FLEET',
        capturedAt: '2026-08-01T00:00:00.000Z',
      });
      const fixtureCoordinator = {
        prefetch({ sku }) {
          prefetchCalls.push(String(sku));
          coordinatorStatus = '${mode === 'cold-success' ? 'PREFETCHING' : 'READY'}';
          return Promise.resolve(normalizeResult(sku));
        },
        prefetchBatch({ skus }) {
          prefetchBatchCalls.push(skus.map(String));
          if ('${mode}' === 'multivariant-gate-failure') {
            return Promise.resolve(skus.map((sku, index) => index === 1
              ? {
                  sku: String(sku),
                  status: 'ERROR',
                  error: Object.assign(new Error('缺少：重量'), { code: 'OZON_ENRICH_INCOMPLETE' }),
                }
              : normalizeResult(sku)));
          }
          return Promise.resolve(skus.map(normalizeResult));
        },
        async collect(input) {
          const call = { sku: String(input.sku), raw: structuredClone(input.raw), local: null, localError: null };
          if (typeof input.localFallback === 'function') {
            try { call.local = structuredClone(await input.localFallback({ sku: input.sku })); }
            catch (error) { call.localError = { code: error?.code || '', message: error?.message || '' }; }
          }
          collectCalls.push(call);
          if ('${mode}' === 'cold-success') await new Promise((resolve) => setTimeout(resolve, 250));
          coordinatorStatus = '${['upload-failure', 'auth-failure', 'missing-failure'].includes(mode) ? 'ERROR' : 'SUCCESS'}';
          if ('${mode}' === 'upload-failure') {
            throw Object.assign(new Error('网络错误，请稍后重试'), { code: 'NETWORK_ERROR' });
          }
          if ('${mode}' === 'auth-failure') {
            throw Object.assign(new Error('请先登录 Web'), { code: 'COLLECTOR_AUTH_REQUIRED' });
          }
          if ('${mode}' === 'missing-failure') {
            throw Object.assign(new Error('缺少：类目、重量'), { code: 'OZON_ENRICH_INCOMPLETE' });
          }
          return { dedupeHit: false, result: { id: 'coordinated-collect-id' } };
        },
        getState: () => ({ status: coordinatorStatus, requestId: 'fixture-request' }),
      };
      window.JzOzonCollectCoordinator = {
        matchesSku(value, sku) {
          const candidates = [value?.sku, value?.sku_id, value?.product_id, value?.offer_id];
          for (const entries of [value?.skus, value?._searchMeta?.skus]) {
            if (Array.isArray(entries)) entries.forEach((entry) => candidates.push(entry?.sku, entry?.sku_id, entry?.product_id, entry?.offer_id, entry?.value));
          }
          return candidates.some((candidate) => String(candidate || '').trim() === String(sku));
        },
        getPageCoordinator() { return fixtureCoordinator; },
      };
      window.__getProductFixtureState = () => ({
        prefetchCalls: structuredClone(prefetchCalls),
        prefetchBatchCalls: structuredClone(prefetchBatchCalls),
        collectCalls: structuredClone(collectCalls),
        runtimeMessages: structuredClone(runtimeMessages),
        label: document.querySelector('[aria-label="一键采集"] .ozon-helper-action-label')?.textContent
          || document.querySelector('[aria-label="一键采集"]')?.textContent?.trim()
          || '',
      });
    </script>
    <script src="/extension/lib/ozon-enrichment-contract.js"></script>
    <script src="/extension/content/ozon-product.js"></script>
  </body></html>`;
}

function startServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/product/fixture-')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixtureHtml(url.searchParams.get('mode') || 'success'));
      return;
    }
    const filePath = path.resolve(rootDir, `.${decodeURIComponent(url.pathname)}`);
    if (!filePath.startsWith(`${rootDir}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    let contents;
    try {
      contents = readFileSync(filePath);
    } catch {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    response.end(contents);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('product page delegates complete single and multivariant collection to the page coordinator', async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
  const address = server.address();
  const context = await browser.newContext();
  try {
    const openFixture = async (mode) => {
      const page = await context.newPage();
      page.setDefaultTimeout(3_000);
      await page.goto(`http://127.0.0.1:${address.port}/product/fixture-${SKU}?mode=${mode}`);
      await page.waitForSelector('[aria-label="一键采集"]');
      return page;
    };

    const successPage = await openFixture('success');
    await successPage.waitForFunction(() => window.__getProductFixtureState().prefetchCalls.length > 0);
    let state = await successPage.evaluate(() => window.__getProductFixtureState());
    assert.deepEqual(state.prefetchCalls, [SKU]);
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);

    await successPage.click('[aria-label="一键采集"]');
    await successPage.waitForFunction(() => window.__getProductFixtureState().collectCalls.length === 1);
    state = await successPage.evaluate(() => window.__getProductFixtureState());
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);
    assert.equal(state.collectCalls[0].sku, SKU);
    assert.equal(state.collectCalls[0].raw.name, `Seller title ${SKU}`);
    assert.deepEqual(state.collectCalls[0].raw.images, [`https://cdn.test/seller-${SKU}.jpg`]);
    assert.equal(state.collectCalls[0].raw.price, '1200');
    assert.equal(state.collectCalls[0].raw.marketingPrice, '1200');
    assert.equal(state.collectCalls[0].raw.greenPrice, '1100');
    assert.equal(state.collectCalls[0].raw.videoUrl, 'https://seller-cdn.test/transferred.mp4');
    assert.equal(state.collectCalls[0].raw.videoCover, 'https://cdn.test/source-cover.jpg');
    assert.equal(state.collectCalls[0].raw.sellerName, 'Fixture seller');
    assert.equal(state.collectCalls[0].raw.sellerLink, 'https://www.ozon.ru/seller/fixture/');
    assert.deepEqual(state.collectCalls[0].raw.variantData.hashtags, ['#fixture', '#complete']);
    assert.equal(state.collectCalls[0].raw.variantData.description, 'Fixture description');
    assert.ok(state.collectCalls[0].raw.variantData.attributes.some(({ key }) => String(key) === '11254'));
    assert.equal(state.collectCalls[0].local.sku, SKU);
    assert.equal(state.collectCalls[0].local.variantData._searchMeta.skus[0].sku, SKU);
    await successPage.waitForFunction(() => window.__getProductFixtureState().label === '已采集');

    const coldPage = await openFixture('cold-success');
    await coldPage.click('[aria-label="一键采集"]');
    await coldPage.waitForFunction(() => window.__getProductFixtureState().label === '正在补全商品资料');

    const failedPage = await openFixture('upload-failure');
    await failedPage.click('[aria-label="一键采集"]');
    await failedPage.waitForFunction(() => window.__getProductFixtureState().collectCalls.length === 1);
    await failedPage.waitForFunction(() => window.__getProductFixtureState().label === '网络错误');
    state = await failedPage.evaluate(() => window.__getProductFixtureState());
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);
    assert.equal(state.label, '网络错误');

    for (const [mode, expected] of [
      ['auth-failure', '请先登录 Web'],
      ['missing-failure', '缺少：类目、重量'],
    ]) {
      const failurePage = await openFixture(mode);
      await failurePage.click('[aria-label="一键采集"]');
      await failurePage.waitForFunction((label) => window.__getProductFixtureState().label === label, expected);
      state = await failurePage.evaluate(() => window.__getProductFixtureState());
      assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);
    }

    const pageMissingPage = await openFixture('page-missing');
    await pageMissingPage.click('[aria-label="一键采集"]');
    await pageMissingPage.waitForFunction(() => window.__getProductFixtureState().label === '缺少：标题、图片');
    state = await pageMissingPage.evaluate(() => window.__getProductFixtureState());
    assert.equal(state.collectCalls.length, 0);
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);

    const multiPage = await openFixture('multivariant');
    await multiPage.click('[aria-label="一键采集"]');
    await multiPage.waitForFunction(() => window.__getProductFixtureState().collectCalls.length === 1);
    state = await multiPage.evaluate(() => window.__getProductFixtureState());
    assert.deepEqual(state.prefetchBatchCalls, [[SKU, OTHER_SKU]]);
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);
    assert.equal(state.collectCalls[0].sku, SKU);
    assert.deepEqual(state.collectCalls[0].raw.variantData.variants.map(({ sku }) => sku), [SKU, OTHER_SKU]);
    assert.deepEqual(
      state.collectCalls[0].raw.variantData.variants.map((row) => ({
        categoryId: row.sourceVariant.description_category_id,
        weight: row.weight,
        depth: row.depth,
        width: row.width,
        height: row.height,
      })),
      [
        { categoryId: 321, weight: 500, depth: 300, width: 200, height: 100 },
        { categoryId: 321, weight: 500, depth: 300, width: 200, height: 100 },
      ],
    );

    const multiFailurePage = await openFixture('multivariant-gate-failure');
    await multiFailurePage.click('[aria-label="一键采集"]');
    await multiFailurePage.waitForFunction(() => window.__getProductFixtureState().label === '缺少：重量');
    state = await multiFailurePage.evaluate(() => window.__getProductFixtureState());
    assert.deepEqual(state.prefetchBatchCalls, [[SKU, OTHER_SKU]]);
    assert.equal(state.collectCalls.length, 0);
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);
  } finally {
    await context.close();
    await browser.close();
    await closeServer(server);
  }
});

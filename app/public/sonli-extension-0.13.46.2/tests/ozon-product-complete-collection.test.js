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
    <div data-widget="webStickyColumn"></div>
    <div data-widget="webStickyColumn"></div>
    <div data-widget="webStickyColumn"><div><div data-widget="webSale"></div></div></div>
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
      window.jzDataCardAllowed = async () => ({
        allowed: '${mode}' === 'sidebar-upload-hang',
        reason: 'MEMBERSHIP_REQUIRED',
      });
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
      window.jzPanelBrandHeaderHtml = () => '<button data-action="close-sidebar-card"></button>';
      window.jzPanelOverviewHtml = () => '<div></div>';
      window.formatNumber = (value) => String(value ?? '');
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
      let calcMountCalls = 0;
      window.__jzcMountPanel = () => { calcMountCalls += 1; };
      window.__jzcIsMounted = () => false;
      window.__jzcUnmountPanel = () => {};
      window.sendMessage = async (action, payload) => {
        runtimeMessages.push({ action, payload: structuredClone(payload || {}) });
        if (action === 'searchVariants') {
          return { items: [completeVariant('${OTHER_SKU}'), completeVariant('${SKU}')] };
        }
        if (action === 'uploadFollowSellVideo') {
          if ('${mode}'.includes('video-hang')) return new Promise(() => {});
          return { url: 'https://seller-cdn.test/transferred.mp4' };
        }
        if (action === 'pushSourceCollect') {
          return { dedupeHit: false, result: { id: 'direct-upload-must-not-run' } };
        }
        return {};
      };

      const skuCollectCalls = [];
      window.JZSkuCollect = {
        collectBySkus: async (skus) => {
          skuCollectCalls.push(skus.map(String));
          if ('${mode}' === 'multivariant-seller-hang') return new Promise(() => {});
          return ({
          sourceMap: new Map(skus.map((sku) => [String(sku), {
            _sourceVariant: completeVariant(String(sku)),
            name: 'Seller title ' + sku,
            images: ['https://cdn.test/seller-' + sku + '.jpg'],
            description: 'Description ' + sku,
          }])),
          });
        },
      };

      const prefetchCalls = [];
      const prefetchBatchCalls = [];
      const prefetchBatchRetryFlags = [];
      const prefetchBatchNetworkCalls = [];
      const collectCalls = [];
      const batchStates = new Map();
      let batchAttempt = 0;
      let loggedBackIn = false;
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
          const normalizedSku = String(sku);
          prefetchCalls.push(normalizedSku);
          if ('${mode}' === 'multivariant-init-retry') {
            const error = Object.assign(new Error('网络错误，请稍后重试'), { code: 'OZON_ENRICH_UPSTREAM_FAILED' });
            batchStates.set(normalizedSku, { status: 'ERROR', error });
            coordinatorStatus = 'ERROR';
            return Promise.reject(error);
          }
          if ('${mode}' === 'multivariant-auth-retry') {
            const error = Object.assign(new Error('请先登录 Web'), { code: 'COLLECTOR_AUTH_REQUIRED' });
            batchStates.set(normalizedSku, { status: 'BLOCKED_AUTH', error });
            coordinatorStatus = 'BLOCKED_AUTH';
            return Promise.reject(error);
          }
          coordinatorStatus = '${mode === 'cold-success' ? 'PREFETCHING' : 'READY'}';
          const result = normalizeResult(normalizedSku);
          batchStates.set(normalizedSku, { status: 'READY', result });
          return Promise.resolve(result);
        },
        prefetchBatch({ skus, retryFailed = false }) {
          const normalizedSkus = skus.map(String);
          prefetchBatchCalls.push(normalizedSkus);
          prefetchBatchRetryFlags.push(retryFailed === true);
          const networkSkus = normalizedSkus.filter((sku) => {
            const state = batchStates.get(sku);
            return !state || ((state.status === 'ERROR' || state.status === 'BLOCKED_AUTH') && retryFailed === true);
          });
          prefetchBatchNetworkCalls.push(networkSkus);
          if (networkSkus.length > 0) {
            batchAttempt += 1;
            networkSkus.forEach((sku) => {
              if ('${mode}' === 'multivariant-gate-failure' && batchAttempt === 1 && sku === '${OTHER_SKU}') {
                const error = Object.assign(new Error('缺少：重量'), { code: 'OZON_ENRICH_INCOMPLETE' });
                batchStates.set(sku, { status: 'ERROR', error });
                return;
              }
              if ('${mode}' === 'multivariant-auth-retry' && sku === '${SKU}' && !loggedBackIn) {
                const error = Object.assign(new Error('请先登录 Web'), { code: 'COLLECTOR_AUTH_REQUIRED' });
                batchStates.set(sku, { status: 'BLOCKED_AUTH', error });
                return;
              }
              const result = normalizeResult(sku);
              batchStates.set(sku, { status: 'READY', result });
            });
          }
          return Promise.resolve(normalizedSkus.map((sku) => {
            const state = batchStates.get(sku);
            return state?.result || { sku, status: 'ERROR', error: state?.error };
          }));
        },
        async collect(input) {
          const call = { sku: String(input.sku), raw: structuredClone(input.raw), local: null, localError: null };
          if (typeof input.localFallback === 'function') {
            try { call.local = structuredClone(await input.localFallback({ sku: input.sku })); }
            catch (error) { call.localError = { code: error?.code || '', message: error?.message || '' }; }
          }
          collectCalls.push(call);
          if ('${mode}' === 'sidebar-upload-hang') return new Promise(() => {});
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
      window.__fixtureRelogin = () => { loggedBackIn = true; };
      window.__getProductFixtureState = () => ({
        prefetchCalls: structuredClone(prefetchCalls),
        prefetchBatchCalls: structuredClone(prefetchBatchCalls),
        prefetchBatchRetryFlags: structuredClone(prefetchBatchRetryFlags),
        prefetchBatchNetworkCalls: structuredClone(prefetchBatchNetworkCalls),
        collectCalls: structuredClone(collectCalls),
        runtimeMessages: structuredClone(runtimeMessages),
        skuCollectCalls: structuredClone(skuCollectCalls),
        calcMountCalls,
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

test('product page delegates public-first single and multivariant collection without synchronous enrichment', async () => {
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
    let state = await successPage.evaluate(() => window.__getProductFixtureState());
    assert.deepEqual(state.prefetchCalls, []);
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);

    await successPage.click('[aria-label$="算价"]');
    state = await successPage.evaluate(() => window.__getProductFixtureState());
    assert.equal(state.calcMountCalls, 1, 'the product action must delegate to jzc-calc.js');
    assert.equal(await successPage.locator('.ozon-helper-profit-panel').count(), 0);

    await successPage.click('[aria-label="一键采集"]');
    await successPage.waitForFunction(() => window.__getProductFixtureState().collectCalls.length === 1);
    state = await successPage.evaluate(() => window.__getProductFixtureState());
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);
    assert.equal(state.collectCalls[0].sku, SKU);
    assert.equal(state.collectCalls[0].raw.name, 'Fixture page title');
    assert.deepEqual(state.collectCalls[0].raw.images, [
      'https://cdn.test/page-1.jpg',
      'https://cdn.test/page-2.jpg',
    ]);
    assert.equal(state.collectCalls[0].raw.price, '1200');
    assert.equal(state.collectCalls[0].raw.marketingPrice, '1200');
    assert.equal(state.collectCalls[0].raw.greenPrice, '1100');
    assert.equal(state.collectCalls[0].raw.videoUrl, undefined);
    assert.equal(state.collectCalls[0].raw.videoCover, undefined);
    assert.equal(
      state.runtimeMessages.some(({ action }) => action === 'uploadFollowSellVideo'),
      false,
      'public collection must not perform an unattested Seller media write',
    );
    assert.equal(state.collectCalls[0].raw.sellerName, 'Fixture seller');
    assert.equal(state.collectCalls[0].raw.sellerLink, 'https://www.ozon.ru/seller/fixture/');
    assert.deepEqual(state.collectCalls[0].raw.variantData.hashtags, ['#fixture', '#complete']);
    assert.equal(state.collectCalls[0].raw.variantData.description, 'Fixture description');
    assert.ok(state.collectCalls[0].raw.variantData.attributes.some(({ key }) => String(key) === '11254'));
    assert.equal(state.collectCalls[0].local, null);
    await successPage.waitForFunction(() => window.__getProductFixtureState().label === '已采集');

    const sidebarHangPage = await openFixture('sidebar-upload-hang');
    const sidebarCollect = sidebarHangPage.locator('[data-action="collect-one"]');
    await sidebarCollect.waitFor();
    await sidebarCollect.click();
    assert.equal(
      await sidebarCollect.innerText(),
      '采集中…',
      'the product sidebar must show immediate progress while collection is pending',
    );
    assert.equal(
      await sidebarCollect.isDisabled(),
      true,
      'the product sidebar must block duplicate clicks while collection is pending',
    );

    const videoHangPage = await openFixture('video-hang');
    await videoHangPage.click('[aria-label="一键采集"]');
    await videoHangPage.waitForFunction(() => window.__getProductFixtureState().collectCalls.length === 1);
    state = await videoHangPage.evaluate(() => window.__getProductFixtureState());
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'uploadFollowSellVideo'), false);

    const coldPage = await openFixture('cold-success');
    await coldPage.click('[aria-label="一键采集"]');
    await coldPage.waitForFunction(() => window.__getProductFixtureState().collectCalls.length === 1);

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

    const multiPage = await openFixture('multivariant-seller-hang');
    await multiPage.click('[aria-label="一键采集"]');
    await multiPage.waitForFunction(() => window.__getProductFixtureState().collectCalls.length === 1);
    state = await multiPage.evaluate(() => window.__getProductFixtureState());
    assert.deepEqual(state.prefetchBatchCalls, []);
    assert.deepEqual(state.prefetchBatchRetryFlags, []);
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);
    assert.equal(state.collectCalls[0].sku, SKU);
    assert.deepEqual(state.collectCalls[0].raw.variantData.variants.map(({ sku }) => sku), [SKU, OTHER_SKU]);
    assert.deepEqual(state.skuCollectCalls, []);
    assert.deepEqual(
      state.collectCalls[0].raw.variantData.variants.map((row) => ({
        name: row.name,
        image: row.image,
        weight: row.weight,
        depth: row.depth,
        width: row.width,
        height: row.height,
        sourceVariant: row.sourceVariant,
      })),
      [
        {
          name: 'Blue fixture', image: 'https://cdn.test/blue.jpg',
          weight: undefined, depth: undefined, width: undefined, height: undefined,
          sourceVariant: undefined,
        },
        {
          name: 'Red fixture', image: 'https://cdn.test/red.jpg',
          weight: undefined, depth: undefined, width: undefined, height: undefined,
          sourceVariant: undefined,
        },
      ],
    );
    assert.equal(JSON.stringify(state.collectCalls[0].raw).includes('_bundleItem'), false);

    const multiVideoHangPage = await openFixture('multivariant-video-hang');
    await multiVideoHangPage.click('[aria-label="一键采集"]');
    await multiVideoHangPage.waitForFunction(() =>
      window.__getProductFixtureState().collectCalls.length === 1);
    state = await multiVideoHangPage.evaluate(() => window.__getProductFixtureState());
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'uploadFollowSellVideo'), false);

    const multiFailurePage = await openFixture('multivariant-gate-failure');
    await multiFailurePage.click('[aria-label="一键采集"]');
    await multiFailurePage.waitForFunction(() => window.__getProductFixtureState().collectCalls.length === 1);
    state = await multiFailurePage.evaluate(() => window.__getProductFixtureState());
    assert.deepEqual(state.prefetchBatchCalls, []);
    assert.deepEqual(state.prefetchBatchRetryFlags, []);
    assert.deepEqual(state.prefetchBatchNetworkCalls, []);
    assert.equal(state.collectCalls.length, 1);
    assert.equal(state.runtimeMessages.some(({ action }) => action === 'pushSourceCollect'), false);

    const initRetryPage = await openFixture('multivariant-init-retry');
    await initRetryPage.click('[aria-label="一键采集"]');
    await initRetryPage.waitForFunction(() => window.__getProductFixtureState().collectCalls.length === 1);
    state = await initRetryPage.evaluate(() => window.__getProductFixtureState());
    assert.deepEqual(state.prefetchCalls, []);
    assert.deepEqual(state.prefetchBatchRetryFlags, []);
    assert.deepEqual(state.prefetchBatchNetworkCalls, []);
    assert.equal(state.collectCalls.length, 1);

    const authRetryPage = await openFixture('multivariant-auth-retry');
    await authRetryPage.evaluate(() => window.__fixtureRelogin());
    await authRetryPage.click('[aria-label="一键采集"]');
    await authRetryPage.waitForFunction(() => window.__getProductFixtureState().collectCalls.length === 1);
    state = await authRetryPage.evaluate(() => window.__getProductFixtureState());
    assert.deepEqual(state.prefetchCalls, []);
    assert.deepEqual(state.prefetchBatchRetryFlags, []);
    assert.deepEqual(state.prefetchBatchNetworkCalls, []);
    assert.equal(state.collectCalls.length, 1);
  } finally {
    await context.close();
    await browser.close();
    await closeServer(server);
  }
});

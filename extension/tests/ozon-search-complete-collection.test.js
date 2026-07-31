const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-core');

const rootDir = path.resolve(__dirname, '..', '..');

function browserPath() {
  const candidates = [
    process.env.JZ_BROWSER_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  assert.ok(executablePath, 'Chrome/Chromium is required for the Ozon search collection fixture');
  return executablePath;
}

function fixtureHtml() {
  const cards = Array.from({ length: 21 }, (_, index) => {
    const sku = String(8000000000 + index);
    return `<article class="tile-root">
      <a href="/product/fixture-${sku}" aria-label="card title ${sku}">card title ${sku}</a>
      <img src="https://cdn.test/card-${sku}.jpg" alt="card title ${sku}">
      <span data-widget="searchResultsPrice">999 ₽</span>
      <div class="ozon-helper-card-badge"></div>
    </article>`;
  }).join('');
  return `<!doctype html><html><body>${cards}
    <script>
      window.chrome = {
        storage: {
          local: { get: async () => ({ ozon_data_panel_enabled: true }) },
          onChanged: { addListener() {} },
        },
      };
      window.JZTaskQueue = class { add(_key, task) { return Promise.resolve().then(task); } };
      window.jzMakeStaggeredQueue = () => ({
        add: (task) => Promise.resolve().then(task),
        setParams() {},
      });
      window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; }
        observe(target) { this.callback([{ isIntersecting: true, target }]); }
        disconnect() {}
      };
      const mutationObservers = [];
      window.MutationObserver = class {
        constructor(callback) { this.callback = callback; mutationObservers.push(this); }
        observe() {}
      };
      window.__triggerSearchMutation = () => mutationObservers.forEach((observer) => observer.callback([]));
      window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
      window.checkAuth = async () => ({ loggedIn: true });
      window.createLoginPrompt = () => {};
      window.formatNumber = (value) => String(value);
      window.normalizePrice = (value) => Number(String(value || '').replace(/[^\d.]/g, '')) || 0;
      window.jzDetectOzonMoneyCurrency = () => 'RUB';
      window.jzExtractOzonCalcPriceTags = () => ({ blackPrice: 1299, blackPriceCurrency: 'RUB' });
      window.jzCleanOzonCardTitle = (value) => value;
      window.jzStripPromo = (value) => value;
      window.jzIsTranslated = () => false;
      window.jzGetSalesPeriod = () => 'monthly';
      window.jzDataCardAllowed = async () => ({ allowed: true });
      window.jzFetchPublicFollowSell = async () => ({ count: 1, sellers: [] });
      window.jzFetchOzonPagePriceTags = async () => ({
        blackPrice: 1399,
        blackPriceCurrency: 'RUB',
        hashtags: ['#fixture'],
      });
      window.jzReadCachedWeightDims = async () => null;
      window.jzMountPanelStructure = (panel) => {
        panel.innerHTML = '<button data-action="collect-one">采集</button><button data-action="edit-list">编辑上架</button>';
      };
      window.jzRenderProductCardPanel = () => {};
      window.jzMergeCardPanelData = (_market, _product, _variant, _follow, sku) => ({
        sku,
        soldCount: 72,
        gmvSum: 7000,
        views: 900,
        convViewToOrder: 8,
        discount: 10,
      });
      window.jzExtractCatalogFromSv = (variant) => variant ? ({
        name: 'variant title ' + variant.variant_id,
        mainImage: 'https://cdn.test/variant-' + variant.variant_id + '.jpg',
        images: ['https://cdn.test/variant-' + variant.variant_id + '.jpg'],
      }) : null;
      window.jzPreferSourceName = (source, page) => source || page;
      window.JZFollowSellContentCopy = {
        mergeSourceHashtagsIntoVariant(variant, hashtags) { variant.hashtags = [...hashtags]; },
      };

      const runtimeMessages = [];
      window.__getSearchRuntimeMessages = () => structuredClone(runtimeMessages);
      let releaseFirstVariant;
      const firstVariantGate = new Promise((resolve) => { releaseFirstVariant = resolve; });
      window.__releaseFirstVariant = () => releaseFirstVariant();
      window.sendMessage = async (action, payload) => {
        runtimeMessages.push({ action, payload });
        if (action === 'getFleetServersideFlag') return { on: false };
        if (action === 'getProductStats') return { soldCount: 72, gmvSum: 7000, views: 900 };
        if (action === 'getMarketStats') return {};
        if (action === 'searchVariants') {
          if (String(payload.sku) === '8000000000') await firstVariantGate;
          return { items: [{
            variant_id: 'variant-' + String(payload.sku),
            _searchMeta: { skus: [{ sku: String(payload.sku) }] },
            description_category_id: 123,
            attributes: [
              { key: '4497', value: '500' },
              { key: '9454', value: '300' },
              { key: '9455', value: '200' },
              { key: '9456', value: '100' },
            ],
          }] };
        }
        return {};
      };

      const prefetchCalls = [];
      const collectCalls = [];
      const opened = [];
      window.__collectReject = false;
      const coordinatorResult = (sku) => ({
        status: 'COMPLETE',
        contractVersion: 'collector.ozon.enrichment.v1',
        sku: String(sku),
        descriptionCategoryId: 123,
        logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
        variantData: {
          variant_id: 'variant-' + String(sku),
          _searchMeta: { skus: [{ sku: String(sku) }] },
          description_category_id: 123,
        },
        source: 'BACKEND_FLEET',
        capturedAt: '2026-07-31T00:00:00.000Z',
      });
      window.__getSearchCoordinatorState = () => ({
        prefetchCalls: structuredClone(prefetchCalls),
        collectCalls: structuredClone(collectCalls),
        opened: structuredClone(opened),
      });
      window.open = (url, target) => { opened.push({ url: String(url), target: String(target) }); };
      const matchesFixtureSku = (value, sku) => {
        const candidates = [value?.sku, value?.sku_id, value?.product_id, value?.offer_id];
        for (const entries of [value?.skus, value?._searchMeta?.skus]) {
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            candidates.push(entry?.sku, entry?.sku_id, entry?.product_id, entry?.offer_id, entry?.value);
          }
        }
        return candidates.some((candidate) => String(candidate || '').trim() === String(sku));
      };
      const fixtureCoordinator = {
        prefetch: async ({ sku }) => coordinatorResult(sku),
        prefetchBatch: async ({ skus }) => {
          prefetchCalls.push([...skus]);
          return skus.map((sku) => coordinatorResult(sku));
        },
        collect(input) {
          collectCalls.push(structuredClone({ sku: input.sku, raw: input.raw }));
          return window.__collectReject
            ? Promise.reject(Object.assign(new Error('采集失败，请稍后重试'), { code: 'COLLECTOR_UPLOAD_FAILED' }))
            : Promise.resolve({ dedupeHit: false, result: { id: 'search-collect-id' } });
        },
        getState: () => ({ status: 'READY', requestId: 'fixture-request' }),
      };
      window.JzOzonCollectCoordinator = {
        matchesSku: matchesFixtureSku,
        create() { throw new Error('page must use the shared coordinator singleton'); },
        getPageCoordinator() { return fixtureCoordinator; },
      };
    </script>
    <script src="/extension/content/ozon-search.js"></script>
  </body></html>`;
}

function productionFixtureHtml() {
  return `<!doctype html><html><body><main id="fixture-host"></main>
    <script>
      const runtimeMessages = [];
      window.__getProductionRuntimeMessages = () => structuredClone(runtimeMessages);
      const completeVariant = (sku) => ({
        variant_id: 'variant-' + sku,
        _searchMeta: { skus: [{ sku: String(sku) }] },
        description_category_id: 123,
        type_id: 456,
        attributes: [
          { key: '4497', value: '500' },
          { key: '9454', value: '300' },
          { key: '9455', value: '200' },
          { key: '9456', value: '100' },
        ],
      });
      const completeResult = (sku) => ({
        status: 'COMPLETE',
        contractVersion: 'collector.ozon.enrichment.v1',
        sku: String(sku),
        descriptionCategoryId: 123,
        typeId: 456,
        logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
        variantData: completeVariant(sku),
        source: 'BACKEND_FLEET',
        capturedAt: '2026-07-31T00:00:00.000Z',
        cache: { hit: false, expiresAt: '2026-07-31T06:00:00.000Z' },
      });
      const envelopeFor = (message) => {
        if (message.action === 'getFleetServersideFlag') return { ok: true, data: { on: false } };
        if (message.action === 'enrichOzonCollectBatch') {
          return {
            ok: false,
            status: 401,
            code: 'COLLECTOR_AUTH_REQUIRED',
            error: 'COLLECTOR_AUTH_REQUIRED',
            message: 'expired fixture session',
            missingFields: [],
            retryable: false,
          };
        }
        if (message.action === 'enrichOzonCollect') {
          return { ok: true, data: completeResult(message.sku) };
        }
        if (message.action === 'pushSourceCollect') {
          return { ok: true, data: { dedupeHit: false, result: { id: 'production-collect-id' } } };
        }
        if (message.action === 'searchVariants') {
          return { ok: true, data: { items: [completeVariant(message.sku)] } };
        }
        if (message.action === 'getMarketStats') {
          return { ok: true, data: { soldCount: 72, gmvSum: 7000, views: 900 } };
        }
        if (message.action === 'getProductStats') return { ok: true, data: {} };
        if (message.action === 'reportSkuDims') return { ok: true, data: {} };
        return { ok: true, data: {} };
      };
      window.chrome = {
        storage: {
          local: {
            get(_keys, callback) {
              const value = { ozon_data_panel_enabled: true };
              callback?.(value);
              return Promise.resolve(value);
            },
            set(_value, callback) { callback?.(); return Promise.resolve(); },
          },
          onChanged: { addListener() {} },
        },
        runtime: {
          id: 'production-search-fixture',
          lastError: null,
          getURL: (value) => value,
          onMessage: { addListener() {} },
          sendMessage(message, callback) {
            runtimeMessages.push(structuredClone(message));
            queueMicrotask(() => callback(envelopeFor(message)));
          },
        },
      };
    </script>
    <script src="/extension/content/shared-utils.js"></script>
    <script>
      window.JZTaskQueue = class { add(_key, task) { return Promise.resolve().then(task); } };
      window.jzMakeStaggeredQueue = () => ({ add: (task) => Promise.resolve().then(task), setParams() {} });
      window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; }
        observe(target) { this.callback([{ isIntersecting: true, target }]); }
        disconnect() {}
      };
      window.checkAuth = async () => ({ loggedIn: true });
      window.createLoginPrompt = () => {};
      window.jzDataCardAllowed = async () => ({ allowed: true });
      window.jzFetchPublicFollowSell = async () => ({ count: 0, sellers: [] });
      window.jzFetchOzonPagePriceTags = async () => null;
      window.jzReadCachedWeightDims = async () => null;
      window.jzGetSalesPeriod = () => 'monthly';
      window.jzMountPanelStructure = (panel) => {
        panel.innerHTML = '<button data-action="collect-one">采集</button><button data-action="edit-list">编辑上架</button>';
      };
      window.jzRenderProductPanelV2 = undefined;
      window.jzRenderProductCardPanel = () => {};
      window.jzExtractCatalogFromSv = (variant) => variant ? ({
        name: 'source ' + variant.variant_id,
        mainImage: 'https://cdn.test/' + variant.variant_id + '.jpg',
        images: ['https://cdn.test/' + variant.variant_id + '.jpg'],
        weightG: 500,
        depthMm: 300,
        widthMm: 200,
        heightMm: 100,
      }) : null;
      window.jzPreferSourceName = (source, page) => source || page;
      window.JZFollowSellContentCopy = { mergeSourceHashtagsIntoVariant() {} };
      window.__addProductionCard = () => {
        document.getElementById('fixture-host').insertAdjacentHTML('beforeend',
          '<article class="tile-root"><a href="/product/fixture-8123456789" aria-label="card title">card title</a><img src="https://cdn.test/card.jpg" alt="card title"><span data-widget="searchResultsPrice">999 ₽</span></article>');
      };
      window.__addProductionNoise = () => {
        const node = document.createElement('i');
        node.textContent = 'noise';
        document.getElementById('fixture-host').appendChild(node);
        node.remove();
      };
    </script>
    <script src="/extension/lib/ozon-enrichment-contract.js"></script>
    <script src="/extension/lib/ozon-collect-coordinator.js"></script>
    <script src="/extension/content/ozon-search.js"></script>
    <script>
      window.addEventListener('load', () => setTimeout(() => window.__addProductionCard(), 0));
    </script>
  </body></html>`;
}

async function startServer() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/fixture') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixtureHtml());
      return;
    }
    if (pathname === '/production-fixture') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(productionFixtureHtml());
      return;
    }
    const filePath = path.resolve(rootDir, `.${decodeURIComponent(pathname)}`);
    if (!filePath.startsWith(`${rootDir}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const contents = readFileSync(filePath);
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end(contents);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('search page batches visible prefetch and delegates both collection paths to the coordinator', async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack || error.message));
    const address = server.address();
    await page.goto(`http://127.0.0.1:${address.port}/fixture`);
    await page.waitForFunction(() =>
      window.__getSearchCoordinatorState().prefetchCalls.flat().length === 21
      && document.querySelectorAll('.ozon-helper-data-panel').length === 21,
    );

    const initial = await page.evaluate(() => window.__getSearchCoordinatorState());
    assert.deepEqual(initial.prefetchCalls.map((batch) => batch.length), [20, 1]);
    assert.deepEqual(
      initial.prefetchCalls.flat(),
      Array.from({ length: 21 }, (_, index) => String(8000000000 + index)),
    );
    await page.evaluate(() => {
      window.__triggerSearchMutation();
      window.__triggerSearchMutation();
      window.__triggerSearchMutation();
    });
    await page.waitForTimeout(50);
    assert.deepEqual(
      (await page.evaluate(() => window.__getSearchCoordinatorState())).prefetchCalls
        .map((batch) => batch.length),
      [20, 1],
      'repeated DOM mutations must not schedule already-seen SKU batches again',
    );
    assert.equal(
      (await page.evaluate(() => window.__getSearchRuntimeMessages()))
        .some(({ action }) => action === 'pushSourceCollect'),
      false,
      'visible-card prefetch must not write the collection box',
    );

    const firstPanel = page.locator('.ozon-helper-data-panel').first();
    await page.waitForFunction(() =>
      window.__getSearchRuntimeMessages()
        .some(({ action, payload }) => action === 'searchVariants' && payload.sku === '8000000000'),
    );
    await firstPanel.locator('[data-action="collect-one"]').click();
    await page.waitForFunction(() => window.__getSearchCoordinatorState().collectCalls.length === 1);
    const firstRaw = (await page.evaluate(() => window.__getSearchCoordinatorState())).collectCalls[0].raw;
    assert.deepEqual(
      {
        name: firstRaw.name,
        image: firstRaw.image,
        images: firstRaw.images,
        hashtags: firstRaw.hashtags,
        marketingPrice: firstRaw.marketingPrice,
        marketingPriceCurrency: firstRaw.marketingPriceCurrency,
        soldCount: firstRaw.soldCount,
        soldSum: firstRaw.soldSum,
        views: firstRaw.views,
        convViewToOrder: firstRaw.convViewToOrder,
        discount: firstRaw.discount,
        gmvSum: firstRaw.gmvSum,
      },
      {
        name: 'variant title variant-8000000000',
        image: 'https://cdn.test/variant-variant-8000000000.jpg',
        images: ['https://cdn.test/variant-variant-8000000000.jpg'],
        hashtags: ['#fixture'],
        marketingPrice: '1399',
        marketingPriceCurrency: 'RUB',
        soldCount: 72,
        soldSum: '7000',
        views: 900,
        convViewToOrder: '8',
        discount: '10',
        gmvSum: '7000',
      },
      'coordinator input must preserve search statistics, source title/images, hashtags, and marketing price',
    );
    await page.evaluate(() => window.__releaseFirstVariant());

    await page.evaluate(() => { window.__collectReject = true; });
    const secondPanel = page.locator('.ozon-helper-data-panel').nth(1);
    await secondPanel.locator('[data-action="edit-list"]').click();
    await page.waitForFunction(() =>
      document.querySelectorAll('.ozon-helper-data-panel')[1]
        .querySelector('[data-action="edit-list"]')?.textContent.includes('失败'),
    );
    assert.deepEqual(
      (await page.evaluate(() => window.__getSearchCoordinatorState())).opened,
      [],
      'failed coordinator upload must not open Web edit',
    );

    await page.evaluate(() => { window.__collectReject = false; });
    const thirdPanel = page.locator('.ozon-helper-data-panel').nth(2);
    await thirdPanel.locator('[data-action="edit-list"]').click();
    await page.waitForFunction(() => window.__getSearchCoordinatorState().opened.length === 1);
    const finalState = await page.evaluate(() => window.__getSearchCoordinatorState());
    assert.equal(finalState.collectCalls.length, 3);
    assert.match(finalState.opened[0].url, /\/ozon\/products\/collect\/edit\?id=search-collect-id$/);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('production coordinator and message wrapper resist native MutationObserver prefetch floods', async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack || error.message));
    const address = server.address();
    await page.goto(`http://127.0.0.1:${address.port}/production-fixture`);
    await page.waitForFunction(() =>
      window.__getProductionRuntimeMessages()
        .filter(({ action }) => action === 'enrichOzonCollectBatch').length === 1
      && document.querySelectorAll('.ozon-helper-data-panel').length === 1,
    );
    assert.equal(
      await page.evaluate(() => /\[native code\]/.test(MutationObserver.toString())),
      true,
      'fixture must exercise the browser native MutationObserver',
    );

    await page.evaluate(() => {
      window.__addProductionNoise();
      window.__addProductionNoise();
      window.__addProductionNoise();
    });
    await page.waitForTimeout(100);
    let messages = await page.evaluate(() => window.__getProductionRuntimeMessages());
    assert.equal(messages.filter(({ action }) => action === 'enrichOzonCollectBatch').length, 1);
    assert.equal(messages.filter(({ action }) => action === 'enrichOzonCollect').length, 0);

    await page.locator('[data-action="collect-one"]').click();
    await page.waitForFunction(() =>
      window.__getProductionRuntimeMessages().some(({ action }) => action === 'pushSourceCollect'),
    );
    messages = await page.evaluate(() => window.__getProductionRuntimeMessages());
    assert.equal(messages.filter(({ action }) => action === 'enrichOzonCollectBatch').length, 1);
    assert.equal(messages.filter(({ action }) => action === 'enrichOzonCollect').length, 1);
    assert.equal(messages.filter(({ action }) => action === 'pushSourceCollect').length, 1);
    const batch = messages.find(({ action }) => action === 'enrichOzonCollectBatch');
    const retry = messages.find(({ action }) => action === 'enrichOzonCollect');
    const upload = messages.find(({ action }) => action === 'pushSourceCollect');
    assert.notEqual(retry.requestId, batch.requestId);
    assert.equal(upload.requestId, batch.requestId);
    assert.match(batch.requestId, /^ozon-collect-\d+-[A-Za-z0-9_-]{16,}-1-8123456789$/);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

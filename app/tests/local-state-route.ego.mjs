import assert from 'node:assert/strict';

// Runs the real App against in-page HTTP fixtures on an isolated Vite origin.
function installStateFixture() {
  const nativeFetch = window.fetch.bind(window);
  window.stateReadReview = { requests: [] };
  localStorage.setItem('token', 'state-read-fixture-token');
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
    if (!url.pathname.startsWith('/api/')) return nativeFetch(input, options);
    const path = url.pathname.slice(4);
    window.stateReadReview.requests.push({ path: path + url.search, method: options.method || 'GET' });
    const respond = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    const store = { id: 'store-a', clientId: 'fixture-client', label: '读取测试店铺', companyName: '读取测试店铺', apiKeyMasked: '已保存' };
    if (path === '/local/state') return respond({
      account: { id: 'account-a', username: 'read-fixture', role: 'admin', status: 'active' },
      token: 'state-read-fixture-token', binding: store, currentStoreId: 'store-a', stores: [store], summary: {}, jobs: {},
      caches: { products: [], warehouses: [], collectBox: [], favorites: [], productTemplates: [
        { id: 'template-a', templateName: 'bootstrap 已有模板', content: 'fixture template content', storeId: 'store-a' },
      ] },
    });
    if (path === '/ozon/products/cache') return respond({ items: [], total: 7, page: Number(url.searchParams.get('page')), pageSize: 5 });
    if (path === '/ozon/collect-box/summary') {
      const status = Number(new URLSearchParams(location.search).get('summaryStatus')) || 200;
      return status === 200 ? respond({ items: [], total: 7 }) : respond({ message: `summary fixture HTTP ${status}` }, status);
    }
    return respond({ message: 'unavailable in isolated state fixture' }, 404);
  };
}

export async function runStateRouteReview(page, baseUrl) {
  const checks = [], failures = [];
  const { identifier } = await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${installStateFixture.toString()})();` });
  async function check(name, action) {
    try { await action(); checks.push(name); }
    catch (error) { failures.push({ name, message: error.message }); }
  }
  async function visit(path) {
    await page.goto(new URL(path, baseUrl).href);
    await page.waitForFunction(() => window.stateReadReview?.requests.some(row => row.path.startsWith('/local/state')));
  }
  // Development StrictMode may run the initial effect twice; verify every requested view.
  const stateRequests = () => page.evaluate(() => [...new Set(window.stateReadReview.requests.filter(row => row.path.startsWith('/local/state')).map(row => row.path))]);
  try {
    for (const path of ['/', '/login', '/ozon/dashboard/', '/ozon/products/', '/ozon/products/stocks/', '/ozon/tools/stores/', '/ozon/products/list/']) {
      await check(`product route ${path} uses bootstrap and its own catalog page`, async () => {
        await visit(path);
        await page.waitForFunction(() => window.stateReadReview.requests.some(row => row.path.startsWith('/ozon/products/cache?')));
        assert.deepEqual(await stateRequests(), ['/local/state?view=bootstrap']);
        const query = new URL(await page.evaluate(() => window.stateReadReview.requests.find(row => row.path.startsWith('/ozon/products/cache?')).path), baseUrl).searchParams;
        assert.equal(query.get('view'), 'page');
        assert.equal(query.get('storeId'), 'store-a');
        assert.equal(query.get('page'), '1');
        assert.equal(query.get('pageSize'), '5');
      });
    }
    await check('product pagination reads page two without full state', async () => {
      await page.waitForSelector('loc=css:.ant-pagination li[title="2"]');
      await page.click('loc=css:.ant-pagination li[title="2"]');
      await page.waitForFunction(() => window.stateReadReview.requests.some(row => row.path.includes('/ozon/products/cache?') && new URL(row.path, location.origin).searchParams.get('page') === '2'));
      assert.deepEqual(await stateRequests(), ['/local/state?view=bootstrap']);
    });
    await check('template route displays existing bootstrap templates', async () => {
      await visit('/ozon/templates/');
      await page.waitForFunction(() => document.body.innerText.includes('bootstrap 已有模板'));
      assert.deepEqual(await stateRequests(), ['/local/state?view=bootstrap']);
    });
    await check('legacy upload history alias uses bootstrap', async () => {
      await visit('/ozon/products/batch-upload/');
      assert.deepEqual(await stateRequests(), ['/local/state?view=bootstrap']);
    });
    for (const [path, expected] of [
      ['/ozon/products/collect/edit/?id=collect-a', '/local/state?view=bootstrap&collectIds=collect-a'],
      ['/ozon/tools/ai-listing/?ids=collect-a,collect-b,collect-a', '/local/state?view=bootstrap&collectIds=collect-a&collectIds=collect-b'],
    ]) await check(`selected collection detail ${path}`, async () => {
      await visit(path);
      assert.deepEqual(await stateRequests(), [expected]);
    });
    await check('collection list paginates summary without full state', async () => {
      await visit('/ozon/products/collect/');
      await page.waitForSelector('loc=css:.ant-pagination li[title="2"]');
      await page.click('loc=css:.ant-pagination li[title="2"]');
      await page.waitForFunction(() => window.stateReadReview.requests.some(row => row.path.includes('/ozon/collect-box/summary?') && new URL(row.path, location.origin).searchParams.get('offset') === '5'));
      assert.deepEqual(await stateRequests(), ['/local/state?view=bootstrap']);
    });
    await check('summary 404 alone preserves legacy full fallback', async () => {
      await visit('/ozon/products/collect/?summaryStatus=404');
      await page.waitForFunction(() => window.stateReadReview.requests.some(row => row.path === '/local/state'));
      assert.deepEqual(await stateRequests(), ['/local/state?view=bootstrap', '/local/state']);
    });
    await check('summary 502 stays an error without full fallback', async () => {
      await visit('/ozon/products/collect/?summaryStatus=502');
      await page.waitForFunction(() => document.body.innerText.includes('summary fixture HTTP 502'));
      assert.deepEqual(await stateRequests(), ['/local/state?view=bootstrap']);
    });
  } finally {
    await page.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
  return { passed: checks.length, failed: failures.length, checks, failures };
}

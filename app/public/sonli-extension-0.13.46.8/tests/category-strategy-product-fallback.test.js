const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-core');

const extensionRoot = path.resolve(__dirname, '..');
const productUrl = 'https://www.ozon.ru/product/'
  + 'mqouo-shkaf-skladnoy-turisticheskiy-1941181573/'
  + '?zongziCategoryStrategySession=session-a&sh=o9UeHp3O4w';
const categoryUrl = 'https://www.ozon.ru/category/nabory-skladnoy-mebeli-11504/'
  + '?zongziCategoryStrategySession=session-a';

function browserPath() {
  const candidates = [
    process.env.JZ_BROWSER_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  assert.ok(executablePath, 'Chrome/Chromium is required');
  return executablePath;
}

test('historical strategy sampling resolves the anchored product breadcrumb before showing selection', async () => {
  const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(5_000);
  const diagnostics = [];
  page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`));
  page.on('console', (message) => diagnostics.push(`console:${message.type()}:${message.text()}`));
  try {
    await page.route('https://www.ozon.ru/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/lib/ozon-buyer-category.js') {
        await route.fulfill({ contentType: 'application/javascript; charset=utf-8',
          body: readFileSync(path.join(extensionRoot, 'lib/ozon-buyer-category.js')) });
        return;
      }
      if (url.pathname === '/content/ozon-product.js') {
        await route.fulfill({ contentType: 'application/javascript; charset=utf-8',
          body: readFileSync(path.join(extensionRoot, 'content/ozon-product.js')) });
        return;
      }
      if (url.pathname.startsWith('/product/')) {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><body>
          <div data-widget="breadCrumbs">
            <a href="/category/turizm-i-otdyh-na-prirode-11424/">Туризм</a>
            <a href="/category/nabory-skladnoy-mebeli-11504/">Столы и наборы мебели</a>
          </div>
          <script src="/lib/ozon-buyer-category.js"></script>
          <script src="/content/ozon-product.js"></script>
        </body>` });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>category list</body>' });
    });
    await page.goto(productUrl);
    await page.waitForURL(categoryUrl).catch((error) => {
      assert.fail(`${error.message}\ncurrent=${page.url()}\n${diagnostics.join('\n')}`);
    });
    assert.equal(page.url(), categoryUrl);
  } finally {
    await context.close();
    await browser.close();
  }
});

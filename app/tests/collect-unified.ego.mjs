// Run against the existing local QA page, never a production page:
// EGO_TASKSPACE=3 EGO_PAGE=p2 ego-browser nodejs < app/tests/collect-unified.ego.mjs
// The parent task owns the space; this script does not close it or touch other pages.
const assert = (await import('node:assert/strict')).default;
const fs = await import('node:fs/promises');
const path = await import('node:path');
const task = await taskSpace(Number(process.env.EGO_TASKSPACE || 3));
const page = task.page(process.env.EGO_PAGE || 'p2');
const output = process.env.QA_OUTPUT || '/private/tmp/ozon-repair-20260923';
await fs.mkdir(output, { recursive: true });
const current = new URL(await page.url());
assert.equal(current.hostname, '127.0.0.1', 'QA requires a localhost fixture');
assert.equal(current.pathname, '/tests/collect-unified.fixture.html');
const results = {};
const snapshot = async name => fs.writeFile(path.join(output, `${name}.snapshot.txt`), await page.snapshot());
const viewport = async (width, height = 844) => {
  const zoom = (await page.cdp('Page.getLayoutMetrics')).cssVisualViewport.zoom || 1;
  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width: Math.round(width * zoom), height: Math.round(height * zoom), deviceScaleFactor: 1, mobile: false,
  });
  await page.waitForFunction(expected => Math.abs(innerWidth - expected) <= 1, width);
};
const capture = async name => {
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity), undefined, { timeout: 5000 });
  const zoom = (await page.cdp('Page.getLayoutMetrics')).cssVisualViewport.zoom || 1;
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // CDP clip uses the browser zoomed viewport, while DOMRects use CSS pixels.
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png', clip: {
    x: 0, y: 0, width: dimensions.width * zoom, height: dimensions.height * zoom, scale: 1 / zoom,
  } });
  await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
};
const noPageOverflow = async () => {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(geometry.document <= geometry.viewport + 1, JSON.stringify(geometry));
  return geometry;
};

try {
  current.searchParams.set('qa', String(Date.now()));
  await page.goto(current.href);
  await page.waitForFunction(() => Boolean(window.unifiedQA?.promotionOverview));
  await viewport(1440, 1100);
  await snapshot('collect-unified-start');
  await page.click('loc=role:button[name*="已上架"]');
  await page.waitForFunction(() => document.querySelector('tr[data-row-key="collect_listed"]'));
  results.listed = await page.evaluate(() => {
    const row = document.querySelector('tr[data-row-key="collect_listed"]');
    return { buttons: [...row.querySelectorAll('button')].map(button => button.textContent.trim()),
      disabled: row.querySelector('input[type="checkbox"]').disabled };
  });
  assert.deepEqual(results.listed, { buttons: ['查看上架记录'], disabled: true });
  await page.click('text="查看上架记录"');
  assert.equal(await page.evaluate(() => window.unifiedQA.navigations.at(-1)), '/ozon/products/import-history/');
  await capture('collect-listed-readonly');
  await page.click('loc=role:button[name*="全部"]');
  await page.waitForFunction(() => document.querySelector('tr[data-row-key="wc_running"]'));
  await viewport(390);
  results.collectMobile = await noPageOverflow();
  await capture('collect-unified-390');
  results.collectActions = await page.evaluate(() => [...document.querySelectorAll('.collect-filter-actions button')].map(button => {
    const box = button.getBoundingClientRect();
    return { label: button.textContent.trim(), left: box.left, right: box.right,
      visible: box.left >= 0 && box.right <= document.documentElement.clientWidth + 1 };
  }));
  assert.ok(results.collectActions.every(action => action.visible), JSON.stringify(results.collectActions));
  await page.evaluate(() => {
    const table = document.querySelector('.collect-page .ant-table-content');
    table.scrollLeft = table.scrollWidth - table.clientWidth;
  });
  await page.hover('text="取消"');
  results.collectTable = await page.evaluate(() => {
    const table = document.querySelector('.collect-page .ant-table-content');
    const button = document.querySelector('tr[data-row-key="wc_running"] button');
    const box = button.getBoundingClientRect(), container = table.getBoundingClientRect();
    return { clientWidth: table.clientWidth, scrollWidth: table.scrollWidth, scrollLeft: table.scrollLeft,
      actionVisible: box.left >= container.left && box.right <= container.right + 1 };
  });
  assert.ok(results.collectTable.scrollWidth > results.collectTable.clientWidth);
  assert.equal(results.collectTable.actionVisible, true);
  await capture('collect-unified-actions-390');

  // Current catalog price must never be used to infer a historic receipt's decrease.
  await page.evaluate(() => {
    const overview = window.unifiedQA.promotionOverview;
    overview.products[0].basePrice = '999.00';
    overview.records[0].items.push({ operation: 'JOIN', productId: 'p', name: '历史活动商品',
      actionId: 'a', price: '70.00', currency: 'CNY', status: 'SUCCEEDED' });
    overview.records[0].summary = { total: 2, succeeded: 2 };
  });
  await viewport(1440, 1100);
  await page.click('text="活动验收"');
  await page.click('loc=role:tab[name="定时报名规则"]');
  await snapshot('promotion-rules');
  await page.click('text="编辑"');
  await page.waitForSelector('loc=css:input[placeholder="不限"]');
  results.rule = await page.evaluate(() => {
    const field = document.querySelector('input[placeholder="不限"]');
    return { value: field.value, text: field.closest('.ant-form-item').textContent };
  });
  assert.equal(results.rule.value, '50.00');
  assert.match(results.rule.text, /不代表统一五折/);
  assert.match(results.rule.text, /最高允许活动价/);
  await capture('promotion-rule-desktop');
  await viewport(390);
  await page.click('loc=css:input[placeholder="不限"]');
  results.ruleMobile = await noPageOverflow();
  await capture('promotion-rule-390');
  await page.click('loc=css:button[aria-label="Close"]');

  await viewport(1440, 1100);
  await page.click('loc=role:tab[name="执行记录"]');
  await snapshot('promotion-records');
  await page.click('text="查看逐商品详情"');
  await page.waitForFunction(() => document.querySelector('.ant-modal')?.textContent.includes('未记录基准价'));
  results.receipts = await page.evaluate(() => [...document.querySelectorAll('.ant-modal tr[data-row-key]')].map(row => row.textContent));
  assert.equal(results.receipts.length, 2);
  for (const expected of ['基准价：100.00 CNY', '活动价：80.00 CNY', '实际降幅：20.00%', '规则降幅上限：50%']) {
    assert.ok(results.receipts[0].includes(expected), expected);
  }
  assert.match(results.receipts[1], /基准价：—/);
  assert.match(results.receipts[1], /活动价：70.00 CNY/);
  assert.match(results.receipts[1], /实际降幅：未记录基准价/);
  assert.doesNotMatch(results.receipts[1], /999\.00|实际降幅：[\d.]+%/);
  await snapshot('promotion-receipts');
  await capture('promotion-receipt-desktop');
  await viewport(390);
  results.receiptMobile = await noPageOverflow();
  results.receiptTable = await page.evaluate(() => {
    const modal = document.querySelector('.ant-modal');
    const scroller = modal.querySelector('.ant-table-content');
    const price = [...modal.querySelectorAll('th')].find(cell => cell.textContent.includes('价格与实际降幅'));
    scroller.scrollLeft = price.offsetLeft;
    return { clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth,
      scrollLeft: scroller.scrollLeft, overflowX: getComputedStyle(scroller).overflowX };
  });
  assert.ok(results.receiptTable.scrollLeft > 0);
  assert.equal(results.receiptTable.overflowX, 'auto');
  await capture('promotion-receipt-390');
  await page.click('loc=css:button[aria-label="Close"]');
  results.requests = await page.evaluate(() => window.unifiedQA.requests);
  assert.ok(results.requests.every(request => !request.method || request.method === 'GET'));
  await fs.writeFile(path.join(output, 'collect-unified-browser-results.json'), JSON.stringify(results, null, 2));
  console.log({ passed: true, checks: ['listedReadOnly', 'listedHistoryNavigation', 'collect390', 'ruleCeiling', 'rule390', 'receiptPrices', 'historicUnknown', 'receipt390'], output });
} finally {
  await page.cdp('Emulation.clearDeviceMetricsOverride');
}

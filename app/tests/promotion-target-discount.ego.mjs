// Local fixture only. The caller owns and finishes the existing TaskSpace.
// EGO_TASKSPACE=4 EGO_PAGE=p1 ego-browser nodejs < app/tests/promotion-target-discount.ego.mjs
const assert = (await import('node:assert/strict')).default;
const fs = await import('node:fs/promises');
const path = await import('node:path');
const task = await taskSpace(Number(process.env.EGO_TASKSPACE || 4));
const page = task.page(process.env.EGO_PAGE || 'p1');
const output = process.env.QA_OUTPUT || '/private/tmp/ozon-promotion-ratio-20260923/browser';
await fs.mkdir(output, { recursive: true });
const current = new URL(await page.url());
assert.equal(current.hostname, '127.0.0.1');
assert.equal(current.pathname, '/tests/collect-unified.fixture.html');
const target = 'input[placeholder="留空按平台最高允许价"]';
const results = {};
const viewport = async (width, height = 1000) => {
  const zoom = (await page.cdp('Page.getLayoutMetrics')).cssVisualViewport.zoom || 1;
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: Math.round(width * zoom), height: Math.round(height * zoom), deviceScaleFactor: 1, mobile: false });
  await page.waitForFunction(expected => Math.abs(innerWidth - expected) <= 1, width);
};
const capture = async name => {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
  const zoom = (await page.cdp('Page.getLayoutMetrics')).cssVisualViewport.zoom || 1;
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: dimensions.width * zoom, height: dimensions.height * zoom, scale: 1 / zoom } });
  await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
};
const edit = async (id = 'r') => {
  await page.click(`tr[data-row-key="${id}"] button:has-text("编辑")`);
  await page.waitForFunction(() => Boolean(document.querySelector('#targetDiscountPercent')));
};
const save = async () => {
  await page.click('text="保存规则"');
  await page.waitForFunction(() => !document.querySelector('.ant-modal'));
};
const ruleWrites = () => page.evaluate(() => window.unifiedQA.requests.filter(request => request.path.startsWith('/ozon/promotions/rules') && ['POST', 'PUT'].includes(request.method)));

try {
  current.searchParams.set('qa', String(Date.now()));
  await page.goto(current.href);
  await page.waitForFunction(() => Boolean(window.unifiedQA?.promotionOverview));
  await viewport(1440, 1100);
  await page.snapshot();
  await page.click('text="活动验收"');
  await page.click('loc=role:tab[name="定时报名规则"]');
  await page.snapshot();
  await edit();
  results.legacyValue = await page.evaluate(() => document.querySelector('#targetDiscountPercent').value);
  assert.equal(results.legacyValue, '');
  await save();
  assert.equal((await ruleWrites()).at(-1).body.targetDiscountPercent, null);
  await edit();
  await page.fill(target, '30');
  await page.hover(target);
  results.desktop = await page.evaluate(() => ['minStock', 'targetDiscountPercent', 'maxDiscountPercent'].map(id => {
    const element = document.getElementById(id), box = element.closest('.ant-form-item').getBoundingClientRect();
    return { id, value: element.value, left: box.left, top: box.top, right: box.right };
  }));
  assert.ok(results.desktop[0].left < results.desktop[1].left && results.desktop[1].left < results.desktop[2].left);
  assert.ok(results.desktop.every(field => Math.abs(field.top - results.desktop[0].top) < 1));
  await capture('target-discount-desktop');
  await save();
  assert.equal((await ruleWrites()).at(-1).body.targetDiscountPercent, 30);
  assert.match(await page.evaluate(() => document.querySelector('tr[data-row-key="r"]').textContent), /报名降价比例：30%/);
  await edit();
  assert.equal(await page.evaluate(() => document.querySelector('#targetDiscountPercent').value), '30.00');
  await page.click('button[aria-label="Close"]');

  await page.click('tr[data-row-key="r"] button:has-text("只读预览")');
  await page.waitForFunction(() => document.querySelector('.ant-modal')?.textContent.includes('不足平台要求的40%'));
  results.preview = await page.evaluate(() => [...document.querySelectorAll('.ant-modal tr[data-row-key]')].map(row => row.textContent));
  assert.equal(results.preview.length, 2);
  for (const row of results.preview) assert.match(row, /报名降价比例：30%/);
  assert.match(results.preview[0], /活动价：70.00 CNY/);
  assert.match(results.preview[1], /已跳过，不自动加大降幅/);
  await fs.writeFile(path.join(output, 'target-discount-preview.snapshot.txt'), await page.snapshot({ scope: 'full_page' }));
  await capture('target-discount-preview');
  await page.click('button[aria-label="Close"]');

  await edit();
  await page.fill(target, '');
  await save();
  assert.equal((await ruleWrites()).at(-1).body.targetDiscountPercent, null);
  await edit();
  assert.equal(await page.evaluate(() => document.querySelector('#targetDiscountPercent').value), '');
  await page.fill(target, '80');
  await page.evaluate(() => { window.unifiedQA.promotionSaveError = '报名降价比例不能超过最大降价幅度'; });
  await page.click('text="保存规则"');
  await page.waitForFunction(() => document.querySelector('.ant-modal .ant-alert')?.textContent.includes('报名降价比例不能超过'));
  results.error = await page.evaluate(() => ({ value: document.querySelector('#targetDiscountPercent').value, text: document.querySelector('.ant-modal .ant-alert').textContent }));
  assert.equal(results.error.value, '80.00');
  assert.equal((await ruleWrites()).at(-1).body.targetDiscountPercent, 80);
  await page.hover('text="报名降价比例不能超过最大降价幅度"');
  await capture('target-discount-error-preserved');

  await viewport(390, 844);
  await page.hover(target);
  results.mobile = await page.evaluate(() => {
    const item = document.querySelector('#targetDiscountPercent').closest('.ant-form-item'), box = item.getBoundingClientRect();
    const max = document.querySelector('#maxDiscountPercent').closest('.ant-form-item').getBoundingClientRect();
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, left: box.left, right: box.right, top: box.top, maxTop: max.top, text: item.textContent };
  });
  assert.ok(results.mobile.documentWidth <= results.mobile.viewport + 1);
  assert.ok(results.mobile.left >= 0 && results.mobile.right <= results.mobile.viewport + 1);
  assert.ok(results.mobile.top < results.mobile.maxTop);
  await capture('target-discount-390');
  await page.click('button[aria-label="Close"]');
  await page.evaluate(() => { window.unifiedQA.promotionSaveError = ''; });

  await viewport(1440, 1100);
  await page.click('text="新建报名规则"');
  await page.waitForFunction(() => Boolean(document.querySelector('#targetDiscountPercent')));
  await page.snapshot();
  assert.equal(await page.evaluate(() => document.querySelector('#targetDiscountPercent').value), '');
  await page.fill('input[placeholder="例如：主推商品每日活动报名"]', '指定比例25.50%');
  await page.fill(target, '25.50');
  await page.click('#scheduleMode');
  await page.click('text="DAILY · 每日执行"');
  await save();
  const created = (await ruleWrites()).at(-1);
  assert.equal(created.method, 'POST');
  assert.equal(created.body.targetDiscountPercent, 25.5);
  await edit('r2');
  assert.equal(await page.evaluate(() => document.querySelector('#targetDiscountPercent').value), '25.50');
  await page.click('button[aria-label="Close"]');

  await page.click('loc=role:tab[name="执行记录"]');
  await page.snapshot();
  await page.click('tr[data-row-key="receipt"] button');
  await page.waitForFunction(() => document.querySelector('.ant-modal')?.textContent.includes('实际降幅：20.00%'));
  results.historicReceipt = await page.evaluate(() => document.querySelector('.ant-modal tr[data-row-key]').textContent);
  assert.doesNotMatch(results.historicReceipt, /报名降价比例/);
  assert.match(results.historicReceipt, /实际降幅：20.00%/);
  await page.click('button[aria-label="Close"]');

  // The added third field must leave STOCK_DISCOUNT quantity usable on the next row.
  await page.evaluate(() => {
    window.unifiedQA.promotionOverview.actions[0].type = 'STOCK_DISCOUNT';
    window.unifiedQA.promotionOverview.rules.find(rule => rule.id === 'r').quantity = 3;
  });
  await page.click('loc=role:tab[name="定时报名规则"]');
  await page.click('text="刷新"');
  await page.waitForFunction(() => document.querySelector('tr[data-row-key="r"]')?.textContent.includes('库存折扣参活件数：3'));
  await edit();
  await page.hover(target);
  results.quantity = await page.evaluate(() => {
    const max = document.querySelector('#maxDiscountPercent').closest('.ant-form-item').getBoundingClientRect();
    const quantity = document.querySelector('#quantity'), box = quantity.closest('.ant-form-item').getBoundingClientRect();
    return { value: quantity.value, top: box.top, maxTop: max.top };
  });
  assert.equal(results.quantity.value, '3');
  assert.ok(results.quantity.top > results.quantity.maxTop);
  await page.fill(target, '0');
  await save();
  assert.equal((await ruleWrites()).at(-1).body.targetDiscountPercent, 0);
  assert.equal((await ruleWrites()).at(-1).body.quantity, 3);
  await edit();
  assert.equal(await page.evaluate(() => document.querySelector('#targetDiscountPercent').value), '0.00');
  await page.click('button[aria-label="Close"]');
  results.writes = await ruleWrites();
  assert.ok(await page.evaluate(() => window.unifiedQA.requests.every(request => !request.path.includes('/execute'))));
  await fs.writeFile(path.join(output, 'target-discount-results.json'), JSON.stringify(results, null, 2));
  console.log({ passed: true, checks: ['legacyNull', 'fieldOrder', 'saveReopen', 'previewRatioAndSkip', 'clearToNull', 'serverErrorPreserved', 'mobile390', 'createDecimal', 'historicReceipt', 'stockQuantity', 'zeroRatio'], output });
} finally {
  await page.cdp('Emulation.clearDeviceMetricsOverride');
}

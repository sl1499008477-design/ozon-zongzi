// Local fixture only. The root caller retains ownership of the shared TaskSpace.
// Prepend globalThis.routeQaOptions={taskSpaceId:45,page:'p3',output:'/absolute/qa/path'} before passing to ego-browser nodejs.
const assert = (await import('node:assert/strict')).default;
const fs = await import('node:fs/promises');
const options = globalThis.routeQaOptions;
assert.ok(options?.taskSpaceId && options?.page, 'An existing dedicated Page is required');
const task = await taskSpace(Number(options.taskSpaceId));
const page = task.page(options.page);
const output = options.output;
assert.ok(output, 'QA_OUTPUT is required');
await fs.mkdir(output, { recursive: true });
const url = 'http://127.0.0.1:19145/tests/account-ozon-route.fixture.html';
const results = [];
const load = async search => {
  await page.goto(`${url}${search}`);
  await page.waitForFunction(() => document.querySelector('.ozon-route-control button')?.textContent.includes('中国线路'));
  console.log(await page.snapshot());
};
const state = () => page.evaluate(() => ({
  expanded: document.querySelector('.ozon-route-control button').getAttribute('aria-expanded'),
  warning: document.querySelector('.ozon-route-popover .ant-alert')?.textContent || '',
  disabled: [...document.querySelectorAll('.ozon-route-popover input[type="radio"]')].map(input => input.disabled),
  writes: window.routeQA.requests.filter(request => request.method === 'PUT'),
}));
const check = async (name, action) => {
  try { await action(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message, state: await state() }); }
};

await check('matching account opens automatically without saving, then explicit choice saves once', async () => {
  await load('?ozonRoute=1&accountId=a');
  await page.waitForFunction(() => document.querySelector('.ozon-route-control button')?.getAttribute('aria-expanded') === 'true');
  assert.equal((await state()).expanded, 'true');
  assert.equal((await state()).writes.length, 0);
  await page.click('label.ant-radio-wrapper:has-text("俄罗斯线路")');
  await page.waitForFunction(() => window.routeQA.saved.a.route === 'RU');
  const writes = (await state()).writes;
  assert.deepEqual(writes.map(({ account, body }) => ({ account, body })), [{ account: 'a', body: { route: 'RU', revision: 0 } }]);
});

await check('mismatched account is read only until the matching account is selected', async () => {
  await load('?ozonRoute=1&accountId=b');
  // Also inspect the safety rule on the old implementation where auto-open is absent.
  if ((await state()).expanded !== 'true') await page.click('.ozon-route-control button');
  await page.waitForSelector('.ozon-route-popover');
  console.log(await page.snapshot());
  const mismatch = await state();
  assert.match(mismatch.warning, /账号.*不一致/);
  assert.deepEqual(mismatch.disabled, [true, true]);
  await page.click('label.ant-radio-wrapper:has-text("俄罗斯线路")');
  assert.equal((await state()).writes.length, 0);
  await page.screenshot({ path: `${output}/route-deeplink-account-mismatch.png` });
  await page.click('.ozon-route-control button');
  await page.waitForFunction(() => document.querySelector('.ozon-route-control button')?.getAttribute('aria-expanded') === 'false');
  await page.click('button:has-text("切换测试账号")');
  await page.waitForFunction(() => document.querySelector('.ozon-route-control button')?.textContent.includes('俄罗斯线路'));
  await page.waitForFunction(() => document.querySelector('.ozon-route-popover input[type="radio"]')?.disabled === false);
  assert.equal((await state()).warning, '');
  assert.equal((await state()).expanded, 'true');
  await page.click('label.ant-radio-wrapper:has-text("中国线路")');
  await page.waitForFunction(() => window.routeQA.saved.b.route === 'CN');
  assert.deepEqual((await state()).writes.map(({ account, body }) => ({ account, body })), [{ account: 'b', body: { route: 'CN', revision: 2 } }]);
});

await check('the existing manual entry remains closed initially and saves normally', async () => {
  await load('');
  assert.equal((await state()).expanded, 'false');
  await page.click('.ozon-route-control button');
  await page.waitForSelector('.ozon-route-popover');
  console.log(await page.snapshot());
  assert.equal((await state()).warning, '');
  assert.deepEqual((await state()).disabled, [false, false]);
  await page.click('label.ant-radio-wrapper:has-text("俄罗斯线路")');
  await page.waitForFunction(() => window.routeQA.saved.a.route === 'RU');
  assert.equal((await state()).writes.length, 1);
});

await fs.writeFile(`${output}/route-deeplink-results.json`, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
assert.ok(results.every(result => result.passed), 'Deep-link browser checks failed');

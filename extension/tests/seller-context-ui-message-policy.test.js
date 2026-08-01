const assert = require('node:assert/strict');
const test = require('node:test');

const policy = require('../lib/seller-context-ui-message-policy.js');

const extensionId = 'runtime-test';
const popupSender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/popup/popup.html`,
};
const panelSender = {
  id: extensionId,
  frameId: 0,
  url: 'https://www.ozon.ru/search/?text=test',
  tab: { id: 7, url: 'https://www.ozon.ru/search/?text=test' },
};

test('Seller status UI messages have an exact shape and sender allowlist', () => {
  const panelHosts = ['ozon.ru', 'www.ozon.ru', 'ozon.kz', 'www.ozon.kz'];
  for (const action of ['getSellerContextStatus', 'openSellerLogin']) {
    assert.equal(policy.isAllowedSellerContextUiMessage({ action }, popupSender, extensionId), true);
    for (const host of panelHosts) {
      const sender = {
        ...panelSender,
        url: `https://${host}/search/?text=test`,
        tab: { id: 7, url: `https://${host}/search/?text=test` },
      };
      assert.equal(policy.isAllowedSellerContextUiMessage({ action }, sender, extensionId), true);
    }
    assert.equal(policy.isAllowedSellerContextUiMessage({ action, debug: true }, popupSender, extensionId), false);
  }
  for (const sender of [
    { ...popupSender, url: `chrome-extension://${extensionId}/options.html` },
    { ...panelSender, frameId: 1 },
    { ...panelSender, url: 'https://seller.ozon.ru/app' },
    { ...panelSender, tab: { id: 7, url: 'https://seller.ozon.ru/app' } },
    { ...panelSender, url: 'https://foo.ozon.ru/search/', tab: { id: 7, url: 'https://foo.ozon.ru/search/' } },
    { ...panelSender, url: 'https://www.ozon.kz.evil.example/search/', tab: { id: 7, url: 'https://www.ozon.kz.evil.example/search/' } },
    { ...panelSender, id: 'other-extension' },
    { url: 'https://www.ozon.ru/search/' },
  ]) {
    assert.equal(policy.isAllowedSellerContextUiMessage({ action: 'getSellerContextStatus' }, sender, extensionId), false);
  }
});

test('Seller status projection only exposes normalized Company IDs and safe states', () => {
  assert.deepEqual(policy.projectSellerContextStatus({
    status: 'READY', companyId: '2681910', observedAt: 1_785_528_000_000, token: 'never',
  }), { status: 'READY', companyId: '2681910', observedAt: 1_785_528_000_000 });
  assert.deepEqual(policy.projectSellerContextStatus({ status: 'RECOVERING', companyId: '2681910' }), { status: 'RECOVERING' });
  assert.deepEqual(policy.projectSellerContextStatus({ status: 'LOGIN_REQUIRED', code: 'INTERNAL' }), { status: 'LOGIN_REQUIRED' });
  for (const companyId of ['123', '1234567890123456', 'abc1234', '26 81910', '']) {
    assert.deepEqual(policy.projectSellerContextStatus({ status: 'READY', companyId, observedAt: 1 }), { status: 'LOGIN_REQUIRED' });
  }
  assert.deepEqual(policy.projectSellerContextStatus({ status: 'UNKNOWN', companyId: '2681910' }), { status: 'LOGIN_REQUIRED' });
});

test('Seller login opener is single-flight and allows a later retry', async () => {
  let calls = 0;
  let release;
  const open = policy.createSingleFlight(() => {
    calls += 1;
    if (calls > 1) return Promise.resolve({ ok: true });
    return new Promise((resolve) => { release = resolve; });
  });
  const first = open();
  const second = open();
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  release({ ok: true });
  await first;
  await open();
  assert.equal(calls, 2);
});

test('Seller login opener falls back to one exact Seller login tab and retries after failure', async () => {
  const created = [];
  let failCreate = true;
  const open = policy.createSellerLoginOpener({
    focusOwnedHelper: async () => false,
    createTab: async (options) => {
      created.push(options);
      if (failCreate) {
        failCreate = false;
        throw new Error('create failed');
      }
    },
  });
  assert.deepEqual(await Promise.all([open(), open()]), [{ ok: false }, { ok: false }]);
  assert.deepEqual(created, [{ url: 'https://seller.ozon.ru/app', active: true }]);
  assert.deepEqual(await open(), { ok: true, data: { opened: true } });
  assert.deepEqual(created, [
    { url: 'https://seller.ozon.ru/app', active: true },
    { url: 'https://seller.ozon.ru/app', active: true },
  ]);
});

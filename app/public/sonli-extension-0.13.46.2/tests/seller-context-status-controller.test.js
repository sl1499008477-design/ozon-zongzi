const assert = require('node:assert/strict');
const test = require('node:test');
const { createSellerContextStatusController } = require('../lib/seller-context-status-controller.js');

test('status controller ignores an older response and clears its polling timer', async () => {
  const pending = [];
  const timers = [];
  const cleared = [];
  const seen = [];
  const controller = createSellerContextStatusController({
    requestStatus: () => new Promise((resolve) => pending.push(resolve)),
    onStatus: (status) => seen.push(status),
    pollMs: 1_000,
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: (id) => cleared.push(id),
  });

  controller.start();
  timers[0]();
  pending[1]({ status: 'READY', companyId: '2681910' });
  await Promise.resolve();
  pending[0]({ status: 'LOGIN_REQUIRED' });
  await Promise.resolve();

  assert.deepEqual(seen, [{ status: 'READY', companyId: '2681910' }]);
  controller.stop();
  assert.deepEqual(cleared, [1]);
});

test('status controller safely reports request failure only for the latest generation', async () => {
  const pending = [];
  const seen = [];
  const controller = createSellerContextStatusController({
    requestStatus: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    onStatus: (status) => seen.push(status),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const first = controller.refresh();
  const second = controller.refresh();
  pending[0].reject(new Error('old error'));
  pending[1].reject(new Error('new error'));
  await Promise.all([first, second]);
  assert.deepEqual(seen, [{ status: 'LOGIN_REQUIRED' }]);
});

test('status controller does not create a duplicate timer across page restore', () => {
  const timers = [];
  const cleared = [];
  const controller = createSellerContextStatusController({
    requestStatus: async () => ({ status: 'READY' }),
    onStatus: () => {},
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: (id) => cleared.push(id),
  });
  controller.start();
  controller.start();
  assert.equal(timers.length, 1);
  controller.stop();
  controller.start();
  assert.deepEqual(cleared, [1]);
  assert.equal(timers.length, 2);
});

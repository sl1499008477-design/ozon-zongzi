const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createChromeStoragePromises } = require('../lib/chrome-storage-promises.js');

const worker = fs.readFileSync('extension/background/service-worker.js', 'utf8');
assert.match(worker, /'\.\.\/lib\/chrome-storage-promises\.js'/);
assert.match(worker, /JzChromeStoragePromises\.createChromeStoragePromises\(chrome\)/);

function chromeWithFailure(method, message) {
  const runtime = {};
  const storage = {
    local: {
      get(_keys, callback) {
        if (method === 'get') runtime.lastError = { message };
        callback({ ignored: true });
        delete runtime.lastError;
      },
      set(_values, callback) {
        if (method === 'set') runtime.lastError = { message };
        callback();
        delete runtime.lastError;
      },
      remove(_keys, callback) {
        if (method === 'remove') runtime.lastError = { message };
        callback();
        delete runtime.lastError;
      },
    },
  };
  return { runtime, storage };
}

;(async () => {
  for (const method of ['get', 'set', 'remove']) {
    const adapter = createChromeStoragePromises(chromeWithFailure(method, `${method} failed`));
    const operation = method === 'get'
      ? adapter.get(null)
      : method === 'set'
        ? adapter.set({ pending: true })
        : adapter.remove(['pending']);
    await assert.rejects(operation, new RegExp(`${method} failed`));
  }

  const chromeApi = chromeWithFailure('', '');
  const adapter = createChromeStoragePromises(chromeApi);
  assert.deepEqual(await adapter.get(null), { ignored: true });
  await adapter.set({ pending: true });
  await adapter.remove(['pending']);

  console.log('chrome storage promise safety tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

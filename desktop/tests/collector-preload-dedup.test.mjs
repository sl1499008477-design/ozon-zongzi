import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('the real preload bridge permits duplicate detail reads and still rejects unknown IPC channels', async () => {
  const exposed = {}, calls = [];
  vm.runInNewContext(readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
        ipcRenderer: { invoke: async (...args) => { calls.push(args); return { code: 200 }; } } };
    },
  });
  assert.equal((await exposed.electronAPI.invoke('collection-get-duplicates', { runId: 'owned-run' })).code, 200);
  assert.deepEqual(calls, [['collection-get-duplicates', { runId: 'owned-run' }]]);
  for (const channel of ['collection-get-runs', 'collection-get-results', 'collection-resume-task']) {
    assert.equal((await exposed.electronAPI.invoke(channel, { taskId: 'task', runId: 'owned-run' })).code, 200);
  }
  assert.throws(() => exposed.electronAPI.invoke('arbitrary-command', {}), /not allowed/);
});

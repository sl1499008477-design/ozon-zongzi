import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { register } from 'node:module';
register('./fixtures/desktop-module-loader.mjs', import.meta.url);
const { app } = await import('electron');
const { collectionIpc } = await import('../dist-electron/ipc/collection.ipc.js');

collectionIpc({ isDestroyed: () => false, webContents: { send() {} } });
const downloadAllTables = globalThis.__DESKTOP_IPC_HANDLERS__.get('download-all-tables');

async function withExportFixture(run, { brokenAfterFirst = false, blockedDesktop = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ozon-desktop-export-'));
  const profile = path.join(root, 'profile');
  const desktop = path.join(root, 'desktop');
  const excel = path.join(profile, 'excel');
  fs.mkdirSync(excel, { recursive: true });
  fs.writeFileSync(path.join(excel, 'a-first.xlsx'), 'first workbook');
  if (brokenAfterFirst)
    fs.symlinkSync(path.join(root, 'missing.xlsx'), path.join(excel, 'z-broken.xlsx'));
  if (blockedDesktop)
    fs.writeFileSync(desktop, 'regular file blocks the destination directory');
  else
    fs.mkdirSync(desktop);
  const originalGetPath = app.getPath;
  app.getPath = name => name === 'desktop' ? desktop : profile;
  try {
    await run({ root, profile, desktop, excel });
  } finally {
    app.getPath = originalGetPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function exportedDirectories(desktop) {
  return fs.readdirSync(desktop).filter(name => name.startsWith('sonli_collector_'));
}

test('download-all-tables reports true only after every workbook is copied', async () => {
  await withExportFixture(async ({ desktop }) => {
    assert.equal(await downloadAllTables(), true);
    const exports = exportedDirectories(desktop);
    assert.equal(exports.length, 1);
    assert.equal(fs.readFileSync(path.join(desktop, exports[0], 'a-first.xlsx'), 'utf8'), 'first workbook');
  });
});

test('download-all-tables reports false and preserves source and partial destination on copy failure', async () => {
  await withExportFixture(async ({ desktop, excel }) => {
    assert.equal(await downloadAllTables(), false);
    const exports = exportedDirectories(desktop);
    assert.equal(exports.length, 1);
    assert.equal(fs.readFileSync(path.join(desktop, exports[0], 'a-first.xlsx'), 'utf8'), 'first workbook');
    assert.equal(fs.readFileSync(path.join(excel, 'a-first.xlsx'), 'utf8'), 'first workbook');
    assert.equal(fs.lstatSync(path.join(excel, 'z-broken.xlsx')).isSymbolicLink(), true);
  }, { brokenAfterFirst: true });
});

test('download-all-tables reports false when the destination cannot be created', async () => {
  await withExportFixture(async ({ excel }) => {
    assert.equal(await downloadAllTables(), false);
    assert.equal(fs.readFileSync(path.join(excel, 'a-first.xlsx'), 'utf8'), 'first workbook');
  }, { blockedDesktop: true });
});

const renderer = fs.readFileSync(new URL('../dist/assets/index-A-3CMN9t.js', import.meta.url), 'utf8');
const callbackStart = renderer.indexOf('a=async()=>{');
assert.ok(callbackStart >= 0);
const callbackEnd = renderer.indexOf(';return window.electronAPI.on', callbackStart);
assert.ok(callbackEnd > callbackStart);
const exportAndExit = renderer.slice(callbackStart + 2, callbackEnd);

async function runRendererExport(invoke) {
  const modal = { value: true };
  const sends = [];
  const errors = [];
  const run = vm.runInNewContext(`(${exportAndExit})`, {
    t: modal,
    Z8: { error: message => errors.push(message) },
    window: { electronAPI: {
      invoke,
      sendMessage: (channel, value) => sends.push({ channel, value }),
    } },
  });
  await run();
  return { modal, sends, errors };
}

test('network modal exits only after export succeeds', async () => {
  const result = await runRendererExport(async channel => {
    assert.equal(channel, 'download-all-tables');
    return true;
  });
  assert.equal(result.modal.value, false);
  assert.deepEqual(result.sends, [{ channel: 'app-quit', value: '' }]);
  assert.deepEqual(result.errors, []);
});

for (const [name, invoke] of [
  ['cancelled or failed export', async () => false],
  ['IPC error', async () => { throw new Error('IPC unavailable'); }],
]) {
  test(`network modal stays open and allows retry after ${name}`, async () => {
    const result = await runRendererExport(invoke);
    assert.equal(result.modal.value, true);
    assert.deepEqual(result.sends, []);
    assert.deepEqual(result.errors, ['导出失败，请重试']);
  });
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const guard = require('./build-space-guard.cjs');

const GiB = 1024 ** 3;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ozon-build-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(root, name) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'fixture');
  return target;
}
const free = (gib) => ({ bavail: gib * GiB / 4096, bfree: 100 * GiB / 4096, bsize: 4096 });

for (const evidence of [
  'etc/ozon/production-host',
  'opt/ozon 粽子/shared/production.env',
  'opt/ozon 粽子/releases/1.0.0-20260917.tencent1/compose.yml',
]) {
  test(`refuses desktop packaging on a business host identified by ${evidence}`, (t) => {
    const root = fixture(t);
    const marker = file(root, evidence);
    assert.throws(() => guard.assertDesktopBuildAllowed({
      hostRoot: root, platform: 'win32', paths: [root],
    }, () => free(100)), (error) => {
      assert.equal(error.code, 'DESKTOP_BUILD_ON_PRODUCTION');
      assert.ok(error.message.includes(marker));
      return true;
    });
  });
}

test('a normal source checkout containing deployment templates may package with enough space', (t) => {
  const root = fixture(t);
  file(root, 'project/deploy/production/compose.yml');
  const report = guard.assertDesktopBuildAllowed({
    hostRoot: root, platform: 'win32', paths: [path.join(root, 'release')],
  }, () => free(7));
  assert.equal(report.ok, true);
  assert.equal(report.requiredBytes, 7 * GiB);
  assert.equal(fs.existsSync(path.join(root, 'release')), false);
});

test('uses user-available blocks and preserves the system reserve in addition to working space', (t) => {
  const root = fixture(t);
  assert.throws(() => guard.checkSpace({ paths: [root], reserveGiB: 4, workGiB: 2 }, () => free(5.5)), (error) => {
    assert.equal(error.code, 'INSUFFICIENT_DISK_SPACE');
    assert.equal(error.report.requiredBytes, 6 * GiB);
    assert.equal(error.report.paths[0].availableBytes, 5.5 * GiB);
    return true;
  });
});

test('checks temporary storage even when the output volume has enough space', (t) => {
  const root = fixture(t);
  const temporary = path.join(root, 'temporary');
  fs.mkdirSync(temporary);
  assert.throws(() => guard.checkSpace({ paths: [root, temporary], workGiB: 3 }, (directory) => free(directory === temporary ? 6 : 20)), (error) => {
    assert.equal(error.code, 'INSUFFICIENT_DISK_SPACE');
    assert.ok(error.message.includes(temporary));
    return true;
  });
});

test('rechecks each sequential architecture using its own working budget without summing duplicate paths', (t) => {
  const root = fixture(t);
  const report = guard.assertDesktopBuildAllowed({ hostRoot: root, platform: 'darwin', paths: [root, root] }, () => free(6));
  assert.equal(report.ok, true);
  assert.equal(report.requiredBytes, 6 * GiB);
});

test('fails closed if disk availability cannot be read', (t) => {
  const root = fixture(t);
  assert.throws(() => guard.checkSpace({ paths: [root] }, () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  }), (error) => {
    assert.equal(error.code, 'DISK_SPACE_UNAVAILABLE');
    assert.ok(error.message.includes(root));
    return true;
  });
});

test('CLI emits a machine-readable failure without changing the checked directory', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'build-space-guard.cjs'),
    'space', '--path', root, '--work-gib', '999999'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.code, 'INSUFFICIENT_DISK_SPACE');
  assert.equal(report.reserveBytes, 4 * GiB);
  assert.equal(typeof report.paths[0].availableBytes, 'number');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('production hook stops before checking media on unsafe storage and keeps media checks on safe storage', async (t) => {
  const root = fixture(t);
  const mediaTools = require('./media-tools.cjs');
  const config = require('../electron-builder.production.cjs');
  const oldGuard = guard.beforePack, oldMedia = mediaTools.beforePack;
  t.after(() => { guard.beforePack = oldGuard; mediaTools.beforePack = oldMedia; });
  let available = 5, mediaChecked = false;
  guard.beforePack = (context) => guard.assertDesktopBuildAllowed({
    hostRoot: root, platform: context.electronPlatformName, paths: [context.outDir],
  }, () => free(available));
  mediaTools.beforePack = async () => { mediaChecked = true; };
  await assert.rejects(config.beforePack({ outDir: root, electronPlatformName: 'win32' }), { code: 'INSUFFICIENT_DISK_SPACE' });
  assert.equal(mediaChecked, false);
  available = 7;
  await config.beforePack({ outDir: root, electronPlatformName: 'win32' });
  assert.equal(mediaChecked, true);
});

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const loaderPath = fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url));
const systemUrl = new URL('../dist-electron/utils/system.js', import.meta.url).href;

test('Excel copy returns saved/cancelled outcomes and throws real copy failures', () => {
  const userData = mkdtempSync(join(tmpdir(), 'sonli-desktop-copy-'));
  const probe = `
    import assert from 'node:assert/strict';
    import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { SysTemUtils } from ${JSON.stringify(systemUrl)};

    const source = join(process.env.DESKTOP_TEST_USER_DATA, 'source.xlsx');
    const saved = join(process.env.DESKTOP_TEST_USER_DATA, 'saved.xlsx');
    writeFileSync(source, 'xlsx');
    process.env.DESKTOP_TEST_DIALOG_MODE = 'save';
    process.env.DESKTOP_TEST_SAVE_PATH = saved;
    assert.deepEqual(
      await SysTemUtils.fileOperations.copyFile(source),
      { status: 'saved', filePath: saved },
    );

    process.env.DESKTOP_TEST_DIALOG_MODE = 'cancel';
    assert.deepEqual(
      await SysTemUtils.fileOperations.copyFile(source),
      { status: 'cancelled' },
    );

    process.env.DESKTOP_TEST_DIALOG_MODE = 'save';
    process.env.DESKTOP_TEST_SAVE_PATH = join(process.env.DESKTOP_TEST_USER_DATA, 'missing-copy.xlsx');
    unlinkSync(source);
    await assert.rejects(
      () => SysTemUtils.fileOperations.copyFile(source),
      /不存在|源文件|ENOENT/,
    );

    writeFileSync(source, 'xlsx');
    const directoryTarget = join(process.env.DESKTOP_TEST_USER_DATA, 'target-directory');
    mkdirSync(directoryTarget);
    process.env.DESKTOP_TEST_SAVE_PATH = directoryTarget;
    await assert.rejects(
      () => SysTemUtils.fileOperations.copyFile(source),
      /EISDIR|directory|复制/,
    );
  `;
  const result = spawnSync(process.execPath, [
    '--experimental-loader',
    loaderPath,
    '--input-type=module',
    '--eval',
    probe,
  ], {
    cwd: desktopRoot,
    env: { ...process.env, DESKTOP_TEST_USER_DATA: userData },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

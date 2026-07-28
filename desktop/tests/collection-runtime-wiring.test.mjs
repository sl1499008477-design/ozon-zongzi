import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const loaderPath = fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url));
const taskManagerUrl = new URL('../dist-electron/services/collection/task-manager.services.js', import.meta.url).href;

test('TaskManager wires the lease-aware Collection contract and cleans lifecycle state', () => {
  const userData = mkdtempSync(join(tmpdir(), 'sonli-desktop-contract-'));
  const probe = `
    import assert from 'node:assert/strict';
    import { mkdirSync, unlinkSync, writeFileSync, symlinkSync } from 'node:fs';
    import { join } from 'node:path';
    import { TaskManager } from ${JSON.stringify(taskManagerUrl)};
    import { SysTemUtils } from ${JSON.stringify(new URL('../dist-electron/utils/system.js', import.meta.url).href)};
    import { buildTaskExcelPath } from ${JSON.stringify(new URL('../dist-electron/services/collection/excel-path.core.js', import.meta.url).href)};

    const manager = new TaskManager();
    const taskId = await manager.addTask({ taskName: '../../unsafe display', categoryIds: [] });
    const collection = manager.tasks.get(taskId);
    const required = [
      'getTaskInfo', 'prepareRun', 'run', 'clearStatus', 'restoreRun',
      'getRunId', 'cancel', 'getTableFilePath',
    ];
    for (const method of required)
      assert.equal(typeof collection?.[method], 'function', method + ' must be wired');

    collection.restoreRun({
      id: 'run-1',
      status: 'QUEUED',
      dataCollectionStoreId: 'store-1',
      configurationSnapshot: { sellerCompanyId: 'seller-1' },
    });
    assert.equal(collection.getRunId(), 'run-1');
    collection.applyVerifiedSellerScope({
      dataCollectionStoreId: 'store-1',
      sellerCompanyId: 'seller-1',
    });
    assert.deepEqual(collection.sellerContext, {
      dataCollectionStoreId: 'store-1',
      sellerCompanyId: 'seller-1',
    });

    const excelRoot = join(process.env.DESKTOP_TEST_USER_DATA, 'excel');
    mkdirSync(excelRoot, { recursive: true });
    const cachedPath = buildTaskExcelPath(
      process.env.DESKTOP_TEST_USER_DATA,
      'lifecycle',
      'done',
    );
    writeFileSync(cachedPath, 'xlsx');
    let cleared = 0;
    const lifecycleTask = {
      getTaskInfo: () => ({ taskStatus: 'completed', taskName: 'done' }),
      getTableFilePath: async () => cachedPath,
      run: async () => ({ filePath: cachedPath, progress: {} }),
      clearStatus: () => { cleared += 1; },
    };
    manager.tasks.set('lifecycle', lifecycleTask);
    await manager.executeTask('lifecycle');
    assert.equal(cleared, 1);
    assert.equal(manager.activeTasks.has('lifecycle'), false);
    assert.equal(manager.tasks.has('lifecycle'), false);
    assert.equal(manager.filePathList.get('lifecycle')?.filePath, cachedPath);

    const originalCopyFile = SysTemUtils.fileOperations.copyFile;
    SysTemUtils.fileOperations.copyFile = async (filePath) => ({
      status: 'saved',
      filePath: filePath + '.exported',
    });
    assert.equal(
      (await manager.downloadExcel({ taskId: 'lifecycle' })).status,
      'saved',
    );
    assert.equal(
      (await manager.downloadExcel(cachedPath)).status,
      'saved',
    );
    SysTemUtils.fileOperations.copyFile = async () => ({ status: 'cancelled' });
    assert.deepEqual(
      await manager.downloadExcel({ taskId: 'lifecycle' }),
      { status: 'cancelled' },
    );
    SysTemUtils.fileOperations.copyFile = async (filePath) => ({
      status: 'saved',
      filePath: filePath + '.exported',
    });

    const prefixCollisionPath = buildTaskExcelPath(
      process.env.DESKTOP_TEST_USER_DATA,
      'task_1',
      'other',
    );
    writeFileSync(prefixCollisionPath, 'xlsx');
    manager.filePathList.set('task', {
      taskId: 'task',
      filePath: prefixCollisionPath,
    });
    await assert.rejects(
      () => manager.downloadExcel({ taskId: 'task' }),
      /任务|受控|Excel/,
    );
    manager.filePathList.delete('task');

    const sanitizeCollisionPath = buildTaskExcelPath(
      process.env.DESKTOP_TEST_USER_DATA,
      'shop_a',
      'other',
    );
    writeFileSync(sanitizeCollisionPath, 'xlsx');
    manager.filePathList.set('shop/a', {
      taskId: 'shop/a',
      filePath: sanitizeCollisionPath,
    });
    await assert.rejects(
      () => manager.downloadExcel({ taskId: 'shop/a' }),
      /任务|受控|Excel/,
    );
    manager.filePathList.delete('shop/a');

    const exactPath = buildTaskExcelPath(
      process.env.DESKTOP_TEST_USER_DATA,
      'exact-task',
      'exact',
    );
    writeFileSync(exactPath, 'xlsx');
    manager.filePathList.set('exact-task', {
      taskId: 'exact-task',
      filePath: exactPath,
    });
    assert.equal(
      (await manager.downloadExcel({ taskId: 'exact-task' })).status,
      'saved',
    );
    manager.filePathList.delete('exact-task');

    let prepared = 0;
    const queuedTask = {
      getTaskInfo: () => ({ taskStatus: 'noExecuted' }),
      prepareRun: async () => { prepared += 1; },
      updateStatus: async () => {},
      outputLog: () => {},
    };
    manager.tasks.set('queued', queuedTask);
    manager.maxConcurrentTasks = 0;
    await manager.startTaskById('queued');
    assert.equal(prepared, 1);

    const trustedPath = await collection.getTableFilePath();
    writeFileSync(trustedPath, 'xlsx');
    await manager.downloadExcel(trustedPath);
    await manager.downloadExcel({ taskId: 'task-1' });

    const unrelated = join(excelRoot, 'unrelated.xlsx');
    writeFileSync(unrelated, 'xlsx');
    await assert.rejects(() => manager.downloadExcel(unrelated), /任务|受控|Excel/);

    const outside = join(process.env.DESKTOP_TEST_USER_DATA, 'outside.xlsx');
    writeFileSync(outside, 'xlsx');
    await assert.rejects(() => manager.downloadExcel(outside), /目录|受控|Excel/);

    const symlink = join(excelRoot, 'link.xlsx');
    symlinkSync(outside, symlink);
    await assert.rejects(() => manager.downloadExcel(symlink), /符号链接|受控|Excel/);

    SysTemUtils.fileOperations.copyFile = async (filePath) => {
      unlinkSync(filePath);
      return originalCopyFile(filePath);
    };
    process.env.DESKTOP_TEST_DIALOG_MODE = 'save';
    process.env.DESKTOP_TEST_SAVE_PATH = join(
      process.env.DESKTOP_TEST_USER_DATA,
      'late-copy.xlsx',
    );
    await assert.rejects(
      () => manager.downloadExcel(cachedPath),
      /不存在|源文件|ENOENT/,
    );

    writeFileSync(cachedPath, 'xlsx');
    await manager.stopAllTasks();
    await assert.rejects(
      () => manager.downloadExcel({ taskId: 'lifecycle' }),
      /任务|受控|Excel/,
    );
    await assert.rejects(
      () => manager.downloadExcel(cachedPath),
      /任务|受控|Excel/,
    );
    SysTemUtils.fileOperations.copyFile = originalCopyFile;
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

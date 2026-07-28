import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

const pathModule = await import(
  '../dist-electron/services/collection/excel-path.core.js'
).catch(() => null);

test('task Excel names use a trusted ID and sanitized display slug', () => {
  assert.ok(pathModule, 'central Excel path contract must exist');
  const userData = mkdtempSync(join(tmpdir(), 'sonli-excel-name-'));
  const filePath = pathModule.buildTaskExcelPath(
    userData,
    'task-123',
    '../../季度/报表',
  );

  assert.equal(basename(filePath), 'task-123_季度_报表.xlsx');
  assert.equal(filePath.startsWith(pathModule.getExcelRoot(userData)), true);
});

test('managed Excel validation rejects traversal, absolute escape, encoded traversal and non-xlsx', () => {
  assert.ok(pathModule, 'central Excel path contract must exist');
  const userData = mkdtempSync(join(tmpdir(), 'sonli-excel-boundary-'));
  const root = pathModule.getExcelRoot(userData);
  mkdirSync(root, { recursive: true });

  assert.throws(
    () => pathModule.assertManagedExcelPath(userData, '../outside.xlsx'),
    /目录|Excel/,
  );
  assert.throws(
    () => pathModule.assertManagedExcelPath(userData, join(userData, 'outside.xlsx')),
    /目录|Excel/,
  );
  assert.throws(
    () => pathModule.assertManagedExcelPath(userData, '%2e%2e%2foutside.xlsx'),
    /编码|Excel/,
  );
  assert.throws(
    () => pathModule.assertManagedExcelPath(userData, join(root, 'notes.txt')),
    /xlsx|Excel/,
  );
});

test('existing Excel validation accepts only a regular non-symlink file inside the root', () => {
  assert.ok(pathModule, 'central Excel path contract must exist');
  const userData = mkdtempSync(join(tmpdir(), 'sonli-excel-file-'));
  const root = pathModule.getExcelRoot(userData);
  mkdirSync(root, { recursive: true });
  const valid = join(root, 'task-1_safe.xlsx');
  const outside = join(userData, 'outside.xlsx');
  const symlink = join(root, 'task-2_link.xlsx');
  writeFileSync(valid, 'xlsx');
  writeFileSync(outside, 'xlsx');
  symlinkSync(outside, symlink);

  assert.equal(pathModule.assertExistingManagedExcelFile(userData, valid), valid);
  assert.throws(
    () => pathModule.assertExistingManagedExcelFile(userData, symlink),
    /符号链接|Excel/,
  );
});

test('task Excel creation rejects a symlinked managed root', () => {
  assert.ok(pathModule, 'central Excel path contract must exist');
  const userData = mkdtempSync(join(tmpdir(), 'sonli-excel-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'sonli-excel-outside-'));
  symlinkSync(outside, pathModule.getExcelRoot(userData));

  assert.throws(
    () => pathModule.buildTaskExcelPath(userData, 'task-1', 'safe'),
    /符号链接|Excel/,
  );
});

test('download request schema preserves validated legacy paths and prefers task IDs', () => {
  assert.ok(pathModule, 'central Excel path contract must exist');
  assert.deepEqual(
    pathModule.normalizeExcelDownloadRequest('/managed/task.xlsx'),
    { filePath: '/managed/task.xlsx' },
  );
  assert.deepEqual(
    pathModule.normalizeExcelDownloadRequest({ filePath: '/managed/task.xlsx' }),
    { filePath: '/managed/task.xlsx' },
  );
  assert.deepEqual(
    pathModule.normalizeExcelDownloadRequest({ taskId: 'task-1' }),
    { taskId: 'task-1' },
  );
  assert.throws(
    () => pathModule.normalizeExcelDownloadRequest({ taskId: '' }),
    /任务 ID|格式/,
  );
});

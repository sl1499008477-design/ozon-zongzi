import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('desktop export displays the rejected IPC error message', () => {
  const asset = readFileSync(fileURLToPath(new URL('../dist/assets/index-zr_rvO4W.js', import.meta.url)), 'utf8');
  assert.match(asset, /collection-download-excel",Z\)\}catch\(z\)\{Le\.error\(z\?\.message\|\|"导出失败"\)\}/);
});

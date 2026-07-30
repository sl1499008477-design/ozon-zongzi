'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { appendFile, cp, mkdtemp, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..', '..');
const extensionDir = path.join(rootDir, 'extension');
const parityGate = path.join(rootDir, 'scripts', 'check-extension-ui-parity.mjs');
const upstreamDir = String(process.env.QH_SOURCE_EXTENSION_DIR || '').trim();
const exceptionFiles = [
  'batch-upload/index.html',
  'batch-upload/index.js',
  'content/ozon-product.css',
  'content/ozon-search.css',
];

test('UI parity rejects unrelated mutations in every reviewed exception file', async () => {
  assert.ok(upstreamDir, 'QH_SOURCE_EXTENSION_DIR is required for UI parity mutation coverage');
  assert.equal((await stat(upstreamDir)).isDirectory(), true, 'extension upstream must be a directory');

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'extension-ui-parity-'));
  try {
    for (const [index, relativePath] of exceptionFiles.entries()) {
      const candidateDir = path.join(tmpDir, `candidate-${index}`);
      await cp(extensionDir, candidateDir, { recursive: true });
      const comment = relativePath.endsWith('.html')
        ? '\n<!-- unrelated mutation -->\n'
        : relativePath.endsWith('.js')
          ? '\n// unrelated mutation\n'
          : '\n/* unrelated mutation */\n';
      await appendFile(path.join(candidateDir, relativePath), comment);

      const result = spawnSync(process.execPath, [parityGate], {
        cwd: rootDir,
        env: {
          ...process.env,
          QH_SOURCE_EXTENSION_DIR: upstreamDir,
          QH_LOCAL_EXTENSION_DIR: candidateDir,
        },
        encoding: 'utf8',
        shell: false,
      });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      assert.notEqual(
        result.status,
        0,
        `UI parity accepted an unrelated mutation in ${relativePath}`,
      );
      assert.match(
        output,
        new RegExp(`reviewed UI fingerprint mismatch: ${relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        `UI parity rejected ${relativePath} for an unrelated reason:\n${output}`,
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// Task-specific integration. Default/--check writes only the worktree manifest.
// --apply backs up and copies individual source files; --include-docs also copies the plan.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile, lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const args = new Set(process.argv.slice(2));
for (const arg of args) assert.ok(['--check', '--apply', '--include-docs'].includes(arg), `Unknown argument: ${arg}`);
assert.ok(!(args.has('--check') && args.has('--apply')), 'Choose check or apply');
const apply = args.has('--apply');
const work = resolve(fileURLToPath(new URL('..', import.meta.url)));
const daily = resolve(work, '../..');
const reportPath = 'outputs/qa/2026-09-25-ai-recovery-fix';
const baselineBytes = await readFile(join(daily, reportPath, 'baseline.json'));
const baseline = JSON.parse(baselineBytes);
assert.equal(resolve(baseline.root), daily, 'Unexpected daily directory');
assert.equal(resolve(baseline.work), work, 'Run from the reviewed worktree');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const prefixes = ['server', 'shared', 'app/src', 'app/tests', 'scripts'];
const ignored = new Set(['node_modules', 'build', 'dist', 'outputs', 'output', '.git', '.cache', 'tmp', 'temp']);
const selected = path => prefixes.some(prefix => path.startsWith(`${prefix}/`)) && !path.split('/').some(part => ignored.has(part));
async function fileHash(path) {
  try {
    const stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Expected regular file: ${path}`);
    return sha(await readFile(path));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function scan(relative) {
  const result = [];
  for (const entry of await readdir(join(work, relative), {withFileTypes: true})) {
    if (ignored.has(entry.name)) continue;
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await scan(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
function category(path) {
  if (path.startsWith('app/src/')) return 'app';
  if (path.startsWith('server/tests/') || path.startsWith('app/tests/')) return 'tests';
  if (path.startsWith('scripts/')) return 'scripts';
  if (path.startsWith('docs/')) return 'docs';
  return 'production';
}
async function changed(path) {
  const before = baseline.files[path]?.sha256 ?? null;
  const after = await fileHash(join(work, path));
  if (before === after) return null;
  const current = await fileHash(join(daily, path));
  return {path, before, after, production: category(path) === 'production', category: category(path),
    daily: current, baselineMatches: current === before, change: after === null ? 'deleted' : before === null ? 'added' : 'modified'};
}
const paths = new Set(Object.keys(baseline.files).filter(selected));
for (const prefix of prefixes) for (const path of await scan(prefix)) paths.add(path);
const files = (await Promise.all([...paths].sort().map(changed))).filter(Boolean);
const doc = await changed('docs/superpowers/plans/2026-09-25-ai-sku-recovery.md');
const docs = doc ? [doc] : [];
const conflicts = [...files, ...docs].filter(file => !file.baselineMatches).map(file => ({path: file.path, expected: file.before, actual: file.daily, candidate: file.after}));
const deletions = [...files, ...docs].filter(file => file.after === null).map(file => file.path);
const counts = Object.fromEntries(['production', 'app', 'tests', 'scripts'].map(kind => [kind, files.filter(file => file.category === kind).length]));
const manifest = {at: new Date().toISOString(), root: daily, work, baselineSha256: sha(baselineBytes),
  mode: apply ? 'apply' : 'check', counts: {...counts, docs: docs.length, sourceFiles: files.length},
  files, docs, conflicts, deletions, docsIncludedInApply: args.has('--include-docs')};
await mkdir(join(work, reportPath), {recursive: true});
await writeFile(join(work, reportPath, 'changed-files.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({mode: manifest.mode, counts: manifest.counts, conflicts, deletions, manifest: join(work, reportPath, 'changed-files.json')}, null, 2));
if (!apply) {
  process.exitCode = conflicts.length || deletions.length ? 1 : 0;
} else {
  const entries = [...files, ...(args.has('--include-docs') ? docs : [])];
  assert.ok(entries.every(file => file.baselineMatches), 'Daily files changed since baseline; resolve conflicts before copying');
  assert.ok(entries.every(file => file.after !== null), 'This integration does not remove files');
  // Check all candidates and destinations again before making any daily changes.
  for (const file of entries) {
    assert.equal(await fileHash(join(work, file.path)), file.after, `Candidate changed: ${file.path}`);
    assert.equal(await fileHash(join(daily, file.path)), file.before, `Daily changed: ${file.path}`);
  }
  const backup = join(daily, reportPath, 'integration-backups', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(backup, {recursive: true});
  const journal = {createdAt: new Date().toISOString(), work, daily, backup, entries, copied: [], status: 'BACKING_UP'};
  const saveJournal = () => writeFile(join(backup, 'integration.json'), JSON.stringify(journal, null, 2) + '\n');
  await saveJournal();
  try {
    // Back up every existing destination before copying any business source.
    for (const file of entries) {
      if (file.before === null) continue;
      assert.equal(await fileHash(join(daily, file.path)), file.before, `Daily changed before backup: ${file.path}`);
      const destination = join(backup, 'files', file.path);
      await mkdir(dirname(destination), {recursive: true});
      await copyFile(join(daily, file.path), destination);
      assert.equal(await fileHash(destination), file.before, `Backup verification failed: ${file.path}`);
    }
    journal.status = 'COPYING';
    await saveJournal();
    for (const file of entries) {
      assert.equal(await fileHash(join(daily, file.path)), file.before, `Daily changed before copy: ${file.path}`);
      assert.equal(await fileHash(join(work, file.path)), file.after, `Candidate changed before copy: ${file.path}`);
      const destination = join(daily, file.path);
      await mkdir(dirname(destination), {recursive: true});
      // Record the attempted copy first, so even an interrupted copy is recoverable.
      journal.copying = file.path;
      await saveJournal();
      await copyFile(join(work, file.path), destination);
      assert.equal(await fileHash(destination), file.after, `Copy verification failed: ${file.path}`);
      journal.copied.push(file.path);
      delete journal.copying;
      await saveJournal();
    }
    for (const file of entries) assert.equal(await fileHash(join(daily, file.path)), file.after, `Final verification failed: ${file.path}`);
    journal.status = 'VERIFIED';
    await saveJournal();
    console.log(JSON.stringify({status: journal.status, copied: journal.copied.length, backup}, null, 2));
  } catch (error) {
    journal.status = 'FAILED';
    journal.error = error.message;
    await saveJournal();
    console.error(`Integration stopped; backups and exact progress: ${join(backup, 'integration.json')}`);
    throw error;
  }
}

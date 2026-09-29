import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { migrateProfileDirectory } from '../dist-electron/profile-directory.core.js';

test('renaming the existing profile preserves encrypted login data and historical files', t => {
    const base = mkdtempSync(join(tmpdir(), 'ozon-profile-test-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const previous = join(base, 'sonli-collector-desktop');
    mkdirSync(join(previous, 'excel'), { recursive: true });
    writeFileSync(join(previous, 'store.json'), '{"__secure__":{"token":"encrypted-fixture"}}');
    writeFileSync(join(previous, 'excel/history.xlsx'), 'historical-file-fixture');
    const current = migrateProfileDirectory(base);
    assert.equal(current, join(base, 'ozon 粽子'));
    assert.equal(readFileSync(join(current, 'store.json'), 'utf8'), '{"__secure__":{"token":"encrypted-fixture"}}');
    assert.equal(readFileSync(join(previous, 'excel/history.xlsx'), 'utf8'), 'historical-file-fixture');
    assert.equal(realpathSync(previous), realpathSync(current));
    assert.equal(migrateProfileDirectory(base), current);
});

test('an existing independent new profile is not overwritten by an older profile', t => {
    const base = mkdtempSync(join(tmpdir(), 'ozon-profile-test-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    for (const name of ['sonli-collector-desktop', 'ozon 粽子']) {
        mkdirSync(join(base, name));
        writeFileSync(join(base, name, 'store.json'), name);
    }
    assert.throws(() => migrateProfileDirectory(base), /两份独立/);
    for (const name of ['sonli-collector-desktop', 'ozon 粽子']) assert.equal(readFileSync(join(base, name, 'store.json'), 'utf8'), name);
});

test('a clean installation uses the new profile folder directly', t => {
    const base = mkdtempSync(join(tmpdir(), 'ozon-profile-test-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    assert.equal(migrateProfileDirectory(base), join(base, 'ozon 粽子'));
    assert.equal(existsSync(join(base, 'sonli-collector-desktop')), false);
});

for (const operation of ['renameSync', 'symlinkSync']) test(`a denied ${operation} keeps the existing profile usable`, t => {
    const base = mkdtempSync(join(tmpdir(), 'ozon-profile-busy-'));
    const previous = join(base, 'sonli-collector-desktop');
    mkdirSync(previous);
    writeFileSync(join(previous, 'store.json'), '{"token":"encrypted-fixture"}');
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(base, { recursive: true, force: true }); });
    t.mock.method(fs, operation, () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    syncBuiltinESMExports();
    assert.equal(migrateProfileDirectory(base), previous);
    assert.equal(readFileSync(join(previous, 'store.json'), 'utf8'), '{"token":"encrypted-fixture"}');
    assert.equal(existsSync(join(base, 'ozon 粽子')), false);
});

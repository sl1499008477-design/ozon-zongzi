import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const platform of ['darwin', 'win32']) test(`${platform}: visible rename preserves the store, session and single-instance identity`, () => {
    // Execute the real entry/store modules with isolated Electron APIs; never launch Electron or read a real profile.
    const probe = String.raw`
        import assert from 'node:assert/strict';
        import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
        import { tmpdir } from 'node:os';
        import path from 'node:path';
        import { pathToFileURL } from 'node:url';
        import { createRequire } from 'node:module';
        import { EventEmitter } from 'node:events';
        import vm from 'node:vm';
        import * as fs from 'node:fs';
        const desktop = process.argv[1], platform = process.argv[2], pkg = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'));
        const require = createRequire(path.join(desktop, 'package.json'));
        const electronStorePath = require.resolve('electron-store');
        const Conf = (await import(pathToFileURL(createRequire(electronStorePath).resolve('conf')).href)).default;
        const root = await mkdtemp(path.join(tmpdir(), 'sonli-name-compatibility-'));
        const visibleName = 'ozon 粽子', legacyName = 'sonli-collector-desktop', locks = new Set();
        async function boot(profile, useExplicitPath) {
            const calls = [], overrides = useExplicitPath ? { userData: profile } : {};
            let name = pkg.productName || pkg.name, quits = 0, ready, heldIdentity;
            const exited = new Error('EXITED');
            const app = {
                commandLine: { appendSwitch() {} }, getName: () => name, getVersion: () => pkg.version,
                getPath(key) {
                    const value = overrides[key] || (key === 'appData' ? root : key === 'sessionData' ? app.getPath('userData') : path.join(root, name));
                    calls.push({ kind: 'path', key, value, name }); return value;
                },
                setPath(key, value) { overrides[key] = value; }, setName(value) { name = value; },
                requestSingleInstanceLock() {
                    const directory = app.getPath('userData'), identity = fs.realpathSync(directory), acquired = !locks.has(identity);
                    calls.push({ kind: 'lock', directory, acquired, name });
                    if (acquired) { locks.add(identity); heldIdentity = identity; }
                    return acquired;
                },
                releaseSingleInstanceLock() { if (heldIdentity) locks.delete(heldIdentity); heldIdentity = undefined; },
                quit() { quits++; }, exit() { quits++; throw exited; }, on() {}, whenReady: () => ({ then(callback) { ready = callback; } }),
            };
            const fakeProcess = Object.assign(new EventEmitter(), { argv: [], platform, versions: { chrome: '142.0.7444.235' } });
            const context = vm.createContext({ process: fakeProcess, console, setTimeout });
            const synthetic = exports => new vm.SyntheticModule(Object.keys(exports), function () {
                for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
            }, { context });
            const electron = { app, ipcMain: { on() {} }, safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: {} };
            const log = { info() {}, warn() {}, error() {} };
            const stubs = new Map([
                ['electron', synthetic({ ...electron, default: electron })],
                ['conf', synthetic({ default: Conf })], ['node:path', synthetic({ ...path, default: path })], ['node:fs', synthetic({ ...fs, renameSync(from, to) {
                    // Chromium holds an open lockfile on Windows. Renaming its directory is denied.
                    if (platform === 'win32' && locks.has(fs.realpathSync(from))) {
                        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
                    }
                    return fs.renameSync(from, to);
                } })],
                ['node:process', synthetic({ default: fakeProcess })],
                ['./windows/main.window.js', synthetic({ createWindow() {} })],
                ['./log/index.js', synthetic({ default: log, initLogger() { calls.push({ kind: 'logger', directory: app.getPath('userData') }); } })],
                ['./services/closeProcess.services.js', synthetic({ CloseProcessService: class { run() {} } })],
                ['./ipc/broadcast.js', synthetic({ globalBroadcast: {} })],
                ['./services/memory-monitor.services.js', synthetic({ memoryMonitor: { start() {} } })],
                ['./services/enrichment.services.js', synthetic({ enrichmentWorker: { start() {}, async stop() {} } })],
            ]);
            const mainPath = path.join(desktop, 'dist-electron/main.js'), storePath = path.join(desktop, 'dist-electron/store/index.js');
            const sources = new Map();
            for (const filename of [mainPath, storePath, electronStorePath, path.join(desktop, 'dist-electron/bootstrap-profile.js'), path.join(desktop, 'dist-electron/profile-directory.core.js'), path.join(desktop, 'dist-electron/browser-user-agent.core.js')]) {
                const identifier = pathToFileURL(filename).href;
                sources.set(identifier, new vm.SourceTextModule(await readFile(filename, 'utf8'), { context, identifier }));
            }
            const entry = sources.get(pathToFileURL(mainPath).href);
            await entry.link((specifier, referencing) => {
                if (stubs.has(specifier)) return stubs.get(specifier);
                const identifier = specifier === 'electron-store' ? pathToFileURL(electronStorePath).href : new URL(specifier, referencing.identifier).href;
                assert.ok(sources.has(identifier), 'Unexpected dependency in isolated startup: ' + specifier);
                return sources.get(identifier);
            });
            try { await entry.evaluate(); } catch (error) { if (error !== exited) throw error; }
            // Electron 39 initializes the macOS Keychain/Linux crypto namespace before ready.
            // Capturing the app name here catches a rename that preserves paths but loses encrypted logins.
            const encryptionAccount = app.getName();
            if (ready) await ready();
            return { app, calls, quits, encryptionAccount, store: quits ? null : sources.get(pathToFileURL(storePath).href).namespace.store };
        }
        try {
            for (const useExplicitPath of [false, true]) {
                const profile = path.join(root, useExplicitPath ? 'explicit-existing-profile' : legacyName);
                const partition = path.join(profile, 'Partitions', 'seller-fixture');
                await mkdir(partition, { recursive: true });
                await writeFile(path.join(profile, 'store.json'), JSON.stringify({ compatibilityMarker: 'existing-preferences' }), { mode: 0o600 });
                await writeFile(path.join(partition, 'marker'), 'existing-session', { mode: 0o600 });
                for (const expectedAcquired of [true, false]) {
                    const result = await boot(profile, useExplicitPath);
                    const current = useExplicitPath ? profile : path.join(root, visibleName);
                    if (!expectedAcquired) { assert.equal(result.quits, 1); assert.equal(result.store, null); continue; }
                    assert.equal(result.encryptionAccount, legacyName, 'keep the encryption namespace during Electron initialization');
                    assert.equal(result.app.getName(), expectedAcquired ? visibleName : legacyName);
                    assert.equal(result.store.path, path.join(current, 'store.json'));
                    assert.equal(result.store.get('compatibilityMarker'), 'existing-preferences');
                    assert.equal(result.calls.find(call => call.kind === 'path').name, legacyName, 'static electron-store initialization still uses the package identity');
                    assert.equal(result.app.getPath('userData'), current);
                    assert.equal(result.app.getPath('sessionData'), current);
                    assert.deepEqual(result.calls.find(call => call.kind === 'lock'), { kind: 'lock', directory: profile, acquired: expectedAcquired, name: legacyName });
                    assert.equal(result.quits, expectedAcquired ? 0 : 1);
                    assert.equal(await readFile(path.join(partition, 'marker'), 'utf8'), 'existing-session');
                    locks.delete(fs.realpathSync(profile)); locks.add(fs.realpathSync(current));
                }
            }
            assert.equal(fs.realpathSync(path.join(root, legacyName)), fs.realpathSync(path.join(root, visibleName)));
            assert.equal(pkg.name, 'ozon-zongzi-desktop'); assert.equal(pkg.build.appId, 'cn.sonli.ozon.collector');
            assert.equal(Object.hasOwn(pkg, 'productName'), false);
            assert.equal(pkg.build.productName, visibleName);
            assert.ok((await readFile(path.join(desktop, 'dist/index.html'), 'utf8')).includes('<title>' + visibleName + '</title>'));
            assert.ok((await readFile(path.join(desktop, 'dist-electron/windows/main.window.js'), 'utf8')).includes("title: '" + visibleName + "'"));
        } finally { await rm(root, { recursive: true, force: true }); }
    `;
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', probe,
        fileURLToPath(new URL('..', import.meta.url)), platform], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
});

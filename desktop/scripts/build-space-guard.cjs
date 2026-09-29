// Read-only preflight. This file can also be copied alone to a deployment host.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const GiB = 1024 ** 3;

function failure(code, message, report = {}) {
  return Object.assign(new Error(message), { code, report: { ...report, ok: false, code, message } });
}

function productionEvidence(hostRoot = path.parse(process.cwd()).root) {
  const candidates = [
    'etc/ozon/production-host',
    'opt/ozon 粽子/.production-host',
    'opt/ozon 粽子/shared/production.env',
    'opt/ozon/current/compose.yml',
  ].map((name) => path.join(hostRoot, name));
  const releases = path.join(hostRoot, 'opt/ozon 粽子/releases');
  try {
    for (const name of fs.readdirSync(releases)) candidates.push(path.join(releases, name, 'compose.yml'));
  } catch (error) {
    if (error.code !== 'ENOENT') return releases; // An unreadable production directory is not a build host.
  }
  for (const candidate of candidates) {
    try { fs.lstatSync(candidate); return candidate; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return candidate; }
  }
  return null;
}

function checkSpace({ paths, reserveGiB = 4, workGiB = 0 }, statfs = fs.statfsSync) {
  if (!paths?.length || !Number.isFinite(reserveGiB) || reserveGiB < 4 || !Number.isFinite(workGiB) || workGiB < 0) {
    throw failure('INVALID_SPACE_BUDGET', 'Specify paths, a reserve of at least 4 GiB, and a non-negative working budget.');
  }
  const report = { ok: true, reserveBytes: reserveGiB * GiB, workBytes: workGiB * GiB,
    requiredBytes: (reserveGiB + workGiB) * GiB, paths: [] };
  for (const requested of [...new Set(paths.map((value) => path.resolve(value)))]) {
    let checked = requested;
    let info;
    for (;;) {
      try { info = statfs(checked); break; }
      catch (error) {
        if (error.code === 'ENOENT' && path.dirname(checked) !== checked) { checked = path.dirname(checked); continue; }
        throw failure('DISK_SPACE_UNAVAILABLE', `Cannot read available disk space for ${requested}: ${error.code || error.message}`, report);
      }
    }
    const availableBytes = Number(info.bavail) * Number(info.bsize);
    if (!Number.isFinite(availableBytes) || availableBytes < 0) {
      throw failure('DISK_SPACE_UNAVAILABLE', `Invalid available disk space for ${requested}.`, report);
    }
    report.paths.push({ path: requested, checkedPath: checked, availableBytes });
  }
  const shortage = report.paths.find((entry) => entry.availableBytes < report.requiredBytes);
  if (shortage) {
    throw failure('INSUFFICIENT_DISK_SPACE',
      `Insufficient disk space at ${shortage.path}: ${(shortage.availableBytes / GiB).toFixed(2)} GiB available; ` +
      `${reserveGiB + workGiB} GiB required (${reserveGiB} GiB reserve + ${workGiB} GiB working space). Free verified disposable build files or use a non-production build volume.`, report);
  }
  return report;
}

function assertDesktopBuildAllowed({ hostRoot, platform, paths }, statfs) {
  const evidence = productionEvidence(hostRoot);
  if (evidence) throw failure('DESKTOP_BUILD_ON_PRODUCTION',
    `Desktop packaging is forbidden on this production business host (${evidence}). Use a separate non-production builder; business and paid AI result storage must remain available.`, { evidence });
  // Per architecture: unpacked Electron/app, archives/installers, downloads and temporary copies.
  return checkSpace({ paths, reserveGiB: 4, workGiB: platform === 'win32' ? 3 : 2 }, statfs);
}

function beforePack(context) {
  const cacheRoot = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches')
    : process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'))
      : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'));
  const cachePath = (name) => path.join(cacheRoot, name, ...(process.platform === 'win32' ? ['Cache'] : []));
  const report = assertDesktopBuildAllowed({
    platform: context.electronPlatformName,
    paths: [context.outDir, os.tmpdir(), context.packager?.projectDir || path.resolve(__dirname, '..'),
      process.env.ELECTRON_BUILDER_CACHE || cachePath('electron-builder'),
      context.packager?.config?.electronDownload?.cache || process.env.electron_config_cache || process.env.ELECTRON_CACHE || cachePath('electron')],
  });
  console.log(`[desktop-build-space] ${JSON.stringify(report)}`);
  return report;
}

module.exports = { checkSpace, assertDesktopBuildAllowed, beforePack };

if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const options = { paths: [] };
    if (command !== 'space') throw new Error('Usage: node build-space-guard.cjs space --path DIR [--path DIR] [--reserve-gib 4] [--work-gib N]');
    for (let i = 0; i < args.length; i += 2) {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${args[i]}`);
      if (args[i] === '--path') options.paths.push(value);
      else if (args[i] === '--reserve-gib') options.reserveGiB = Number(value);
      else if (args[i] === '--work-gib') options.workGiB = Number(value);
      else throw new Error(`Unknown option: ${args[i]}`);
    }
    console.log(JSON.stringify(checkSpace(options)));
  } catch (error) {
    console.log(JSON.stringify(error.report || { ok: false, code: error.code || 'INVALID_ARGUMENT', message: error.message }));
    process.exitCode = 1;
  }
}

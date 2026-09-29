// Build-time only. No network access, dependency installation or runtime downloads.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');
const lock = require('../media-tools.lock.json');

async function digest(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
function targetSpec(target, definition = lock) {
  if (!['mac-arm64', 'mac-x64', 'win-x64'].includes(target) || !definition.targets[target]) {
    throw new Error(`unsupported media-tools target: ${target}`);
  }
  if (definition.targets[target].pendingBuild) throw new Error(`media-tools source build is still pending: ${target}`);
  return definition.targets[target];
}
async function checkFile(file, sha256, bytes) {
  const info = await fs.lstat(file);
  if (!info.isFile() || (bytes !== undefined && info.size !== bytes)) throw new Error(`file size/type mismatch: ${file}`);
  if (!/^[a-f0-9]{64}$/.test(sha256) || await digest(file) !== sha256) throw new Error(`file hash mismatch: ${file}`);
}
function leaf(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`invalid material filename: ${name}`);
  return name;
}
async function sourceMaterials(target, sources, definition = lock) {
  if (!sources) throw new Error('corresponding sources directory is required');
  const spec = targetSpec(target, definition);
  const meta = JSON.parse(await fs.readFile(path.join(sources, 'SOURCE-RELEASE.json'), 'utf8'));
  const expected = spec.archives.map(a => a.sha256).sort();
  if (meta.schema !== 1 || meta.target !== target || meta.ffmpegVersion !== definition.version ||
      JSON.stringify([...(meta.binaryArchiveSha256 || [])].sort()) !== JSON.stringify(expected)) {
    throw new Error('corresponding source manifest does not match the pinned binary archives');
  }
  const names = [leaf(meta.sourceArchive), 'COPYING.GPLv3', 'THIRD-PARTY-NOTICES.txt', 'BUILDING.md'];
  if (!/\.(tar\.xz|tar\.gz|zip)$/.test(meta.sourceArchive)) throw new Error('corresponding source archive format must be tar.xz, tar.gz or zip');
  for (const name of names) await checkFile(path.join(sources, name), meta.files?.[name]);
  return { meta, names: [...names, 'SOURCE-RELEASE.json'] };
}
async function checkArchitecture(file, target) {
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(64);
    await handle.read(head, 0, head.length, 0);
    let valid;
    if (target.startsWith('mac-')) {
      valid = head.readUInt32LE(0) === 0xfeedfacf &&
        head.readUInt32LE(4) === (target === 'mac-arm64' ? 0x0100000c : 0x01000007);
    } else {
      const pe = Buffer.alloc(6);
      await handle.read(pe, 0, pe.length, head.readUInt32LE(60));
      valid = head.toString('ascii', 0, 2) === 'MZ' && pe.toString('ascii', 0, 4) === 'PE\0\0' && pe.readUInt16LE(4) === 0x8664;
    }
    if (!valid) throw new Error(`wrong executable architecture for ${target}: ${file}`);
  } finally { await handle.close(); }
}
async function verify({ target, dir, sources, lock: definition = lock }) {
  const spec = targetSpec(target, definition);
  const { meta } = await sourceMaterials(target, sources, definition);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.target !== target || manifest.version !== definition.version ||
      JSON.stringify(manifest.archiveSha256) !== JSON.stringify(spec.archives.map(a => a.sha256))) {
    throw new Error('prepared tools do not match pinned release');
  }
  for (const entry of spec.archives.flatMap(a => a.files)) {
    const file = path.join(dir, entry.name);
    await checkFile(file, manifest.files[entry.name]?.sha256, entry.bytes);
    await checkArchitecture(file, target);
  }
  for (const name of ['COPYING.GPLv3', 'THIRD-PARTY-NOTICES.txt', 'BUILDING.md']) {
    await checkFile(path.join(dir, name), meta.files[name]);
  }
  await checkFile(path.join(dir, 'SOURCE-RELEASE.json'), await digest(path.join(sources, 'SOURCE-RELEASE.json')));
  await checkFile(path.join(dir, 'NOTICE.txt'), manifest.files['NOTICE.txt']?.sha256);
  return manifest;
}
async function prepare({ target, archives, sources, output, lock: definition = lock }) {
  const spec = targetSpec(target, definition);
  if (!archives || !output) throw new Error('archives and output directories are required');
  if (await fs.lstat(output).then(() => true, () => false)) throw new Error(`preparation already exists: ${output}`);
  const materials = await sourceMaterials(target, sources, definition);
  for (const archive of spec.archives) await checkFile(path.join(archives, archive.file), archive.sha256, archive.bytes);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = await fs.mkdtemp(`${output}.preparing-`);
  try {
    for (const archive of spec.archives) {
      execFileSync(process.env.PYTHON || 'python3', ['-c',
        'import json,pathlib,shutil,sys,zipfile\n' +
        'with zipfile.ZipFile(sys.argv[1]) as z:\n' +
        ' for item in json.loads(sys.argv[3]):\n' +
        '  info=z.getinfo(item["member"])\n' +
        '  if info.file_size != item["bytes"]: raise ValueError("ZIP member size mismatch")\n' +
        '  with z.open(info) as src, open(pathlib.Path(sys.argv[2])/item["name"], "xb") as dst: shutil.copyfileobj(src,dst,1048576)\n',
        path.join(archives, archive.file), temporary, JSON.stringify(archive.files)], { stdio: 'pipe' });
    }
    const manifest = { schema: 1, version: definition.version, target, archiveSha256: spec.archives.map(a => a.sha256), files: {} };
    for (const entry of spec.archives.flatMap(a => a.files)) {
      await fs.chmod(path.join(temporary, entry.name), 0o755);
      manifest.files[entry.name] = { sha256: await digest(path.join(temporary, entry.name)), bytes: entry.bytes };
    }
    for (const name of materials.names.filter(name => name !== materials.meta.sourceArchive)) {
      await fs.copyFile(path.join(sources, name), path.join(temporary, name));
    }
    const template = await fs.readFile(path.join(desktop, 'third-party/ffmpeg/NOTICE.txt'), 'utf8');
    await fs.writeFile(path.join(temporary, 'NOTICE.txt'), template.replaceAll('@TARGET@', target).replaceAll('@SOURCE_ARCHIVE@', materials.meta.sourceArchive));
    manifest.files['NOTICE.txt'] = { sha256: await digest(path.join(temporary, 'NOTICE.txt')) };
    await fs.writeFile(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await verify({ target, dir: temporary, sources, lock: definition });
    await fs.rename(temporary, output);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
async function stageSources({ target, sources, output, lock: definition = lock }) {
  const { names } = await sourceMaterials(target, sources, definition);
  const destination = path.join(output, 'ffmpeg-source', target);
  await fs.mkdir(destination, { recursive: true });
  for (const name of names) {
    const from = path.join(sources, name), to = path.join(destination, name);
    const expected = await digest(from);
    if (await fs.lstat(to).then(() => true, () => false)) {
      if (await digest(to) !== expected) throw new Error(`different existing source publication: ${to}`);
      continue;
    }
    // Same-volume hard links avoid a second large source archive. Treat both as immutable.
    try { await fs.link(from, to); }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
      await fs.copyFile(from, to, require('node:fs').constants.COPYFILE_EXCL);
    }
    await checkFile(to, expected);
  }
  return destination;
}
function buildTarget(context) {
  const { Arch } = require('electron-builder');
  const platform = { darwin: 'mac', win32: 'win' }[context.electronPlatformName];
  const target = `${platform}-${Arch[context.arch]}`;
  targetSpec(target);
  return target;
}
async function beforePack(context) {
  const target = buildTarget(context);
  if (!process.env.OZON_MEDIA_SOURCE_DIR) throw new Error('set OZON_MEDIA_SOURCE_DIR to the offline corresponding-source directory');
  const prepared = process.env.OZON_MEDIA_TOOLS_DIR || path.join(desktop, 'build/media-tools');
  await verify({ target, dir: path.join(prepared, target), sources: path.join(process.env.OZON_MEDIA_SOURCE_DIR, target) });
}
async function afterPack(context) {
  const target = buildTarget(context);
  const resources = target.startsWith('mac-')
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources')
    : path.join(context.appOutDir, 'resources');
  const sources = path.join(process.env.OZON_MEDIA_SOURCE_DIR, target);
  await verify({ target, dir: path.join(resources, 'media-tools'), sources });
  await stageSources({ target, sources, output: context.outDir });
  // afterPack precedes signing. Re-signing may change executable hashes; verify final signatures separately.
}
module.exports = { prepare, verify, stageSources, beforePack, afterPack };

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--target', '--archives', '--sources', '--output', '--dir'].includes(args[i]) || !args[i + 1]) {
      console.error('invalid option'); process.exit(1);
    }
    options[args[i].slice(2)] = args[i + 1];
  }
  const fn = { prepare, verify, 'stage-sources': stageSources }[command];
  if (!fn) { console.error('Usage: node media-tools.cjs prepare|verify|stage-sources --target mac-arm64|mac-x64|win-x64 --sources DIR [--archives DIR --output DIR | --dir DIR]'); process.exit(1); }
  fn(options).then(() => console.log(`${command}: ${options.target} OK`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const tools = require('./media-tools.cjs');

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function fixture(t, target = 'mac-arm64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ozon-media-tools-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archives = path.join(root, 'archives');
  const sources = path.join(root, 'sources');
  fs.mkdirSync(archives); fs.mkdirSync(sources);
  const binary = Buffer.alloc(128);
  if (target.startsWith('mac-')) {
    binary.writeUInt32LE(0xfeedfacf, 0);
    binary.writeUInt32LE(target.endsWith('arm64') ? 0x0100000c : 0x01000007, 4);
  } else {
    binary.write('MZ'); binary.writeUInt32LE(64, 60);
    binary.write('PE\0\0', 64); binary.writeUInt16LE(0x8664, 68);
  }
  const suffix = target.startsWith('win-') ? '.exe' : '';
  const files = ['ffmpeg', 'ffprobe'].map(name => ({ member: `bin/${name}${suffix}`, name: `${name}${suffix}`, bytes: binary.length }));
  execFileSync(process.env.PYTHON || 'python3', ['-c',
    'import base64,json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name in json.loads(sys.argv[2]): z.writestr(name,base64.b64decode(sys.argv[3]))\n z.writestr("../../outside", "must not extract")\n z.writestr("bin/ffplay", "must not extract")',
    path.join(archives, 'tools.zip'), JSON.stringify(files.map(f => f.member)), binary.toString('base64')]);
  const zip = fs.readFileSync(path.join(archives, 'tools.zip'));
  const lock = { schema: 1, version: '9.0.1', targets: { [target]: { archives: [{ file: 'tools.zip', bytes: zip.length, sha256: sha(zip), files }] } } };
  const sourceFiles = {
    'ffmpeg-source.tar.xz': Buffer.from('fd377a585a000000', 'hex'),
    'COPYING.GPLv3': Buffer.from('test license fixture'),
    'THIRD-PARTY-NOTICES.txt': Buffer.from('test notices fixture'),
    'BUILDING.md': Buffer.from('test corresponding source build instructions fixture'),
  };
  const source = { schema: 1, target, ffmpegVersion: '9.0.1', binaryArchiveSha256: [sha(zip)], sourceArchive: 'ffmpeg-source.tar.xz', files: {} };
  for (const [name, data] of Object.entries(sourceFiles)) {
    fs.writeFileSync(path.join(sources, name), data); source.files[name] = sha(data);
  }
  fs.writeFileSync(path.join(sources, 'SOURCE-RELEASE.json'), JSON.stringify(source));
  return { root, archives, sources, output: path.join(root, 'prepared'), target, lock };
}

test('offline preparation selects only two CLIs; resource verification accepts all three native targets', async t => {
  for (const target of ['mac-arm64', 'mac-x64', 'win-x64']) {
    const f = fixture(t, target);
    await tools.prepare(f);
    await tools.verify({ ...f, dir: f.output });
    const names = fs.readdirSync(f.output);
    assert.ok(names.includes(target === 'win-x64' ? 'ffmpeg.exe' : 'ffmpeg'));
    assert.ok(!names.includes('ffplay'));
    assert.ok(!fs.existsSync(path.join(f.root, 'outside')));
    assert.ok(names.includes('NOTICE.txt') && names.includes('SOURCE-RELEASE.json'));
  }
});

test('missing, altered and wrong-architecture tools are rejected', async t => {
  const f = fixture(t);
  await tools.prepare(f);
  const executable = path.join(f.output, 'ffprobe');
  const original = fs.readFileSync(executable);
  fs.unlinkSync(executable);
  await assert.rejects(tools.verify({ ...f, dir: f.output }), /ffprobe/);
  fs.writeFileSync(executable, Buffer.concat([original, Buffer.from('changed')]));
  await assert.rejects(tools.verify({ ...f, dir: f.output }), /hash|size/);
  const wrong = Buffer.from(original); wrong.writeUInt32LE(0x01000007, 4);
  fs.writeFileSync(executable, wrong);
  const receiptPath = path.join(f.output, 'manifest.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  receipt.files.ffprobe.sha256 = sha(wrong);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  await assert.rejects(tools.verify({ ...f, dir: f.output }), /architecture/);
});

test('bad ZIP or absent corresponding source fails without replacing an existing preparation', async t => {
  const f = fixture(t);
  await tools.prepare(f);
  const before = fs.readFileSync(path.join(f.output, 'manifest.json'));
  await assert.rejects(tools.prepare(f), /exists/);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'manifest.json')), before);
  fs.appendFileSync(path.join(f.archives, 'tools.zip'), 'tampered');
  await assert.rejects(tools.prepare({ ...f, output: path.join(f.root, 'other') }), /hash|size/);
  assert.ok(!fs.existsSync(path.join(f.root, 'other')));
  fs.unlinkSync(path.join(f.sources, 'ffmpeg-source.tar.xz'));
  await assert.rejects(tools.verify({ ...f, dir: f.output }), /source/);
});

test('source sidecar stages real files idempotently and refuses a mismatched existing publication', async t => {
  const f = fixture(t);
  const output = path.join(f.root, 'release');
  await tools.stageSources({ ...f, output });
  await tools.stageSources({ ...f, output });
  const staged = path.join(output, 'ffmpeg-source', f.target, 'SOURCE-RELEASE.json');
  assert.deepEqual(fs.readFileSync(staged), fs.readFileSync(path.join(f.sources, 'SOURCE-RELEASE.json')));
  // Replace instead of mutate: the stage may deliberately use same-volume hard links.
  fs.unlinkSync(staged); fs.writeFileSync(staged, 'different old release');
  await assert.rejects(tools.stageSources({ ...f, output }), /existing/);
});

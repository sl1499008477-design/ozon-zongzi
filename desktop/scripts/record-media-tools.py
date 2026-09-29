#!/usr/bin/env python3
"""Record one offline source build; emits archives and a target lock for review."""
import hashlib
import io
import json
import pathlib
import sys
import tarfile
import zipfile

target, cache_arg = sys.argv[1:]
if target not in ('mac-arm64', 'mac-x64', 'win-x64'):
    raise SystemExit('unsupported target')
desktop = pathlib.Path(__file__).resolve().parent.parent
cache = pathlib.Path(cache_arg).resolve()
artifacts = cache / 'artifacts' / target
sources = cache / 'sources' / target
sources.mkdir(parents=True, exist_ok=False)
source_lock = json.loads((desktop / 'media-tools.sources.json').read_text())
def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
suffix = '.exe' if target == 'win-x64' else ''
names = ['ffmpeg' + suffix, 'ffprobe' + suffix]
binary_zip = artifacts / f'ffmpeg-9.0.1-{target}.zip'
with zipfile.ZipFile(binary_zip, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for name in names:
        archive.write(artifacts / name, name)
binary_sha = sha(binary_zip)
definition = {'publisher': 'ozon local source build', 'archives': [{
    'file': binary_zip.name, 'sha256': binary_sha, 'bytes': binary_zip.stat().st_size,
    'sourceLock': 'media-tools.sources.json',
    'files': [{'member': n, 'name': n, 'bytes': (artifacts / n).stat().st_size} for n in names],
}]}
(artifacts / 'target-lock.json').write_text(json.dumps(definition, indent=2) + '\n')
(sources / 'COPYING.GPLv3').write_bytes((artifacts / 'COPYING.GPLv3').read_bytes())
(sources / 'THIRD-PARTY-NOTICES.txt').write_text(
    'FFmpeg 9.0.1, copyright the FFmpeg developers. This build enables GPLv3.\n'
    'x264 b35605ace3ddf7c1a5d67a2eb553f034aef41d55, copyright the x264 authors.\n'
    'Its GPLv2-or-later terms permit use in this GPLv3 build.\n'
    'Full copyright headers and notices are retained in the corresponding sources.\n'
    'NASM 2.16.03 and pkgconf 2.5.1 are build tools only, not linked into these CLIs.\n\n'
    + (artifacts / 'COPYING.x264').read_text())
commands = (artifacts / 'build-commands.txt').read_text().replace(str(cache), '$CACHE')
(sources / 'BUILDING.md').write_text(
    f'# FFmpeg 9.0.1 / {target}\n\n'
    'The source archive includes the exact upstream archives, their SHA-256 lock, '
    'the build script, compiler/configuration records and licenses.\n'
    'Run bash desktop/scripts/build-media-tools.sh with this target and an empty cache, '
    'after putting the four original archives in CACHE/downloads.\n'
    'Use pkgconf 2.5.1 and NASM 2.16.03 in PATH. Build each from its included source '
    'with ./configure --prefix="$CACHE/build-tools", make, make install; '
    'add a pkg-config symlink to pkgconf in that private bin directory.\n'
    'macOS uses the installed Command Line Tools, deployment target 12.0. '
    'Windows needs the Linux MinGW-w64 x86_64 compiler and static runtime libraries.\n'
    'No runtime downloader or additional multimedia libraries are enabled. '
    'Ordinary built-in demuxers, decoders and filters remain available.\n\n'
    'Source and configuration reproducibility are recorded; byte-for-byte '
    'reproducibility across different compilers or signing identities is not claimed.\n\n'
    '```text\n' + commands + '```\n')
source_archive = sources / f'ffmpeg-9.0.1-{target}-source.tar.xz'
with tarfile.open(source_archive, 'x:xz') as archive:
    for item in source_lock['archives']:
        source = cache / 'downloads' / item['file']
        if source.stat().st_size != item['bytes'] or sha(source) != item['sha256']:
            raise SystemExit('changed source input: ' + item['file'])
        archive.add(source, 'upstream/' + item['file'])
    for name in ['build-media-tools.sh', 'record-media-tools.py']:
        archive.add(desktop / 'scripts' / name, 'desktop/scripts/' + name)
    archive.add(desktop / 'media-tools.sources.json', 'desktop/media-tools.sources.json')
    for name in ['ffmpeg-9.0.1.tar.xz.asc', 'ffmpeg-devel.asc', 'ffmpeg-pgp-verification.json']:
        source = cache / 'downloads' / name
        if source.exists():
            archive.add(source, 'verification/' + name)
    for name in ['build-commands.txt', 'ffmpeg-config.log', 'ffmpeg-config.mak', 'x264-config.mak']:
        source = artifacts / name
        data = source.read_text().replace(str(cache), '$CACHE').encode()
        info = tarfile.TarInfo('build/' + name)
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    for name in ['COPYING.GPLv3', 'THIRD-PARTY-NOTICES.txt', 'BUILDING.md']:
        archive.add(sources / name, name)
files = [source_archive.name, 'COPYING.GPLv3', 'THIRD-PARTY-NOTICES.txt', 'BUILDING.md']
manifest = {'schema': 1, 'target': target, 'ffmpegVersion': '9.0.1',
            'binaryArchiveSha256': [binary_sha], 'sourceArchive': source_archive.name,
            'files': {name: sha(sources / name) for name in files}}
(sources / 'SOURCE-RELEASE.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'target': target, 'binaryArchiveBytes': binary_zip.stat().st_size,
                  'sourceArchiveBytes': source_archive.stat().st_size, 'lock': str(artifacts / 'target-lock.json')}))

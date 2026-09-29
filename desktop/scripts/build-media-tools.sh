#!/usr/bin/env bash
# Offline build. Supply the four pinned source archives in CACHE/downloads first.
set -euo pipefail
TARGET=${1:?usage: build-media-tools.sh mac-arm64|mac-x64|win-x64 CACHE}
CACHE=${2:?cache directory required}
SUFFIX=''; [[ "$TARGET" != win-* ]] || SUFFIX='.exe'
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DESKTOP_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
PYTHON=${PYTHON:-python3}
case "$TARGET" in mac-arm64|mac-x64|win-x64) ;; *) echo "Unsupported target: $TARGET" >&2; exit 1;; esac
mkdir -p "$CACHE"
CACHE=$(cd "$CACHE" && pwd)
WORK="$CACHE/work/$TARGET"
PREFIX="$WORK/prefix"
OUTPUT="$CACHE/artifacts/$TARGET"
test ! -e "$WORK" && test ! -e "$OUTPUT" || { echo 'Refusing to replace an existing build or artifact directory' >&2; exit 1; }
"$PYTHON" - "$DESKTOP_DIR/media-tools.sources.json" "$CACHE/downloads" <<'PY'
import hashlib,json,pathlib,sys
lock=json.loads(pathlib.Path(sys.argv[1]).read_text())
for item in lock['archives']:
 p=pathlib.Path(sys.argv[2])/item['file']
 if p.stat().st_size != item['bytes'] or hashlib.sha256(p.read_bytes()).hexdigest() != item['sha256']:
  raise SystemExit('Source hash/size mismatch: '+item['file'])
PY
export PATH="$CACHE/build-tools/bin:$PATH"
command -v pkg-config >/dev/null || { echo 'pkg-config is required in PATH or CACHE/build-tools/bin' >&2; exit 1; }
command -v nasm >/dev/null || { echo 'NASM is required in PATH or CACHE/build-tools/bin' >&2; exit 1; }
mkdir -p "$WORK/ffmpeg" "$WORK/x264" "$OUTPUT"
tar -xf "$CACHE/downloads/ffmpeg-9.0.1.tar.xz" -C "$WORK/ffmpeg" --strip-components=1
tar -xf "$CACHE/downloads/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz" -C "$WORK/x264" --strip-components=1
export SOURCE_DATE_EPOCH=1786492800
FFMPEG_FLAGS=(--enable-gpl --enable-version3 --enable-libx264 --disable-autodetect --disable-network --disable-debug --disable-doc --disable-ffplay --disable-shared --enable-static --enable-pic --pkg-config-flags=--static)
X264_FLAGS=(--enable-static --disable-cli --disable-opencl --enable-pic)
if [[ "$TARGET" == mac-* ]]; then
  export DEVELOPER_DIR=${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}
  export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
  export MACOSX_DEPLOYMENT_TARGET=12.0
  CPU=arm64; HOST_CPU=aarch64
  if [[ "$TARGET" == mac-x64 ]]; then CPU=x86_64; HOST_CPU=x86_64; fi
  export CC="$(xcrun -f clang) -arch $CPU -isysroot $SDKROOT -mmacosx-version-min=12.0"
  export CXX="$(xcrun -f clang++) -arch $CPU -isysroot $SDKROOT -mmacosx-version-min=12.0"
  X264_FLAGS+=("--host=$HOST_CPU-apple-darwin")
  FFMPEG_FLAGS+=("--cc=$CC" "--arch=$HOST_CPU" --target-os=darwin --enable-cross-compile)
else
  command -v x86_64-w64-mingw32-gcc >/dev/null || { echo 'MinGW-w64 x86_64 compiler is required' >&2; exit 1; }
  export CC=x86_64-w64-mingw32-gcc
  X264_FLAGS+=(--host=x86_64-w64-mingw32 --cross-prefix=x86_64-w64-mingw32-)
  FFMPEG_FLAGS+=(--arch=x86_64 --target-os=mingw32 --enable-cross-compile --cross-prefix=x86_64-w64-mingw32- --pkg-config=pkg-config --extra-ldflags=-static)
fi
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
{
  echo "FFmpeg 9.0.1 + x264 b35605ace3ddf7c1a5d67a2eb553f034aef41d55; target $TARGET"
  printf 'x264 configure: '; printf '%q ' "${X264_FLAGS[@]}"; echo
  printf 'ffmpeg configure: '; printf '%q ' "${FFMPEG_FLAGS[@]}"; echo
  "${CC%% *}" --version
  nasm -v
  pkg-config --version
} > "$OUTPUT/build-commands.txt"
(
  cd "$WORK/x264"
  ./configure --prefix="$PREFIX" "${X264_FLAGS[@]}"
  make -j"${MEDIA_BUILD_JOBS:-4}"
  make install
) > "$OUTPUT/x264-build.log" 2>&1
(
  cd "$WORK/ffmpeg"
  ./configure --prefix="$PREFIX" "${FFMPEG_FLAGS[@]}"
  make -j"${MEDIA_BUILD_JOBS:-4}" "ffmpeg$SUFFIX" "ffprobe$SUFFIX"
) > "$OUTPUT/ffmpeg-build.log" 2>&1
cp "$WORK/ffmpeg/ffmpeg$SUFFIX" "$WORK/ffmpeg/ffprobe$SUFFIX" "$OUTPUT/"
cp "$WORK/ffmpeg/COPYING.GPLv3" "$OUTPUT/COPYING.GPLv3"
cp "$WORK/x264/COPYING" "$OUTPUT/COPYING.x264"
cp "$WORK/ffmpeg/ffbuild/config.log" "$OUTPUT/ffmpeg-config.log"
cp "$WORK/ffmpeg/ffbuild/config.mak" "$OUTPUT/ffmpeg-config.mak"
cp "$WORK/x264/config.mak" "$OUTPUT/x264-config.mak"
echo "Built $TARGET in $OUTPUT. Preserve source archives and build logs; smoke-test before packaging."

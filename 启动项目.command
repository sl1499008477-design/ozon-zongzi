#!/bin/zsh
set -e
# 始终从这个启动入口所在的项目主目录运行，不依赖终端当前目录。
SONLI_START_ROOT="${0:A:h}"
cd "$SONLI_START_ROOT"
SONLI_BUNDLED_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if [[ -x "$SONLI_BUNDLED_RUNTIME/node/bin/node" ]]; then
  export PATH="$SONLI_BUNDLED_RUNTIME/node/bin:$SONLI_BUNDLED_RUNTIME/bin/fallback:$PATH"
fi
exec node scripts/dev.mjs

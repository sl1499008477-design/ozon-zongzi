# Task 1 基线报告：Ozon 同步服务拆分

## Status

`DONE_WITH_CONCERNS`

基线采集已完成；未修改业务代码，未执行真实 Ozon 调用，未安装依赖，未执行 commit、stage、push、stash、分支切换或破坏性 Git 操作。

## 执行命令

```bash
git status --short
wc -l server/index.mjs server/ozon-client.mjs server/tests/module-boundaries.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify.mjs
git diff --name-only
```

辅助只读汇总：

```bash
git status --short | awk 'BEGIN{m=0;d=0;u=0;o=0} /^\?\?/{u++;next} {x=substr($0,1,2); if (x ~ /D/) d++; else if (x ~ /M/) m++; else o++} END{printf "modified=%d deleted=%d untracked=%d other=%d total=%d\n",m,d,u,o,m+d+u+o}'
git diff --name-only | wc -l
```

## 目标文件现状

```text
6186 server/index.mjs
  78 server/ozon-client.mjs
  46 server/tests/module-boundaries.test.mjs
6310 total
```

- `server/index.mjs` 与 brief 的“约 6186 行”一致。
- `server/tests/module-boundaries.test.mjs` 的入口上限为 6200 行；当前只剩 14 行余量。
- `server/ozon-client.mjs` 已存在且为 78 行。

## 完整门禁实际结果

命令退出码：`1`

门禁阶段结果：

- App build：通过；Vite 构建完成。
- Extension source parity：通过。
- Extension UI parity：通过。
- Extension diff contract：通过。
- Extension zip parity：通过，92 个文件一致。
- Extension zip bridge smoke：通过。
- Server syntax：通过。
- Test inventory：通过，`68 active, 9 historical/manual`。
- Complete active test suite：失败。
- Docker compose interpolation：通过。
- Import history type filter：通过。
- Plugin readiness gate：通过。
- Collect edit listing contract：通过。
- Collect box delete persistence：通过。
- Operating store data isolation：通过。
- Bridge syntax：通过。
- Manifest JSON：通过。
- Diff whitespace：通过。
- Credential literal scan：通过。

最终汇总：

```text
tests 94
pass 88
fail 6
cancelled 0
skipped 0
todo 0
1 verification check(s) failed
```

## 基线失败

以下 6 个测试文件均因本机 PostgreSQL `127.0.0.1:5432` 不可连接而失败，错误为 `ECONNREFUSED`：

1. `server/tests/account-deletion-postgres.integration.mjs`
2. `server/tests/collection-pipeline-v4.integration.mjs`
3. `server/tests/collector-desktop.integration.mjs`
4. `server/tests/listing-pipeline-v3.integration.mjs`
5. `server/tests/pricing-config.integration.mjs`
6. `server/tests/pricing-fx.integration.mjs`

这些失败记录为改造前基线失败；本 Task 未尝试启动、修改或迁移 PostgreSQL，也未把它们混入 Ozon 同步服务拆分修复范围。

## 现有 Dirty 状态摘要

`git status --short` 汇总：

```text
modified=52
deleted=8
untracked=114
other=0
total=174
```

完整 dirty 快照保存在：

`/Users/songliang/Documents/sonli ozon3.0/.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/task-1-dirty-baseline.txt`

该文件是本轮实际 `git status --short` 的逐行原始输出，包含全部 174 个条目：52 个 modified、8 个 deleted、114 个 untracked。后续拆分和复审应以该快照保护当前 dirty worktree，而不能只依赖下方不包含 untracked 文件的 `git diff --name-only`。

`git diff --name-only` 输出 60 个已有 tracked 差异：

```text
.env.example
README.md
app/package.json
app/public/plugin/popup.js
app/public/sonli-extension-0.13.46.1.zip
app/src/App.jsx
app/src/styles.css
app/vite.config.mjs
design-qa.md
docker-compose.yml
extension/background/__tests__/dedupe.smoke.test.js
extension/background/service-worker.js
extension/background/sync/backend-client.js
extension/background/sync/sync-engine.js
extension/content/alibaba-1688.js
extension/content/collector/anti-ban.js
extension/content/collector/auto-scroller.js
extension/content/collector/db.js
extension/content/collector/keyword-pilot.js
extension/content/collector/panel.css
extension/content/collector/panel.js
extension/content/jizhangerp-bridge.js
extension/content/jzc-calc.js
extension/content/ozon-data-panel.js
extension/content/ozon-premium-hook.js
extension/content/ozon-product.js
extension/content/ozon-search.js
extension/content/shared-utils.js
extension/content/sync-auth.js
extension/lib/cn-source-panel.js
extension/manifest.json
extension/popup/__tests__/popup-routing.smoke.test.js
extension/popup/popup.css
extension/popup/popup.html
extension/popup/popup.js
extension/tests/collector-manual-start.test.js
extension/tests/jizhangerp-bridge-follow-sell.test.js
package.json
pnpm-lock.yaml
scripts/check-collect-edit-listing-contract.mjs
scripts/check-extension-diff-contract.mjs
scripts/check-extension-source-parity.mjs
scripts/check-extension-ui-parity.mjs
scripts/check-extension-zip-smoke.mjs
scripts/check-import-history-types.mjs
scripts/check-plugin-readiness-gate.mjs
scripts/dev.mjs
scripts/frontend-compat-proxy.mjs
scripts/package-extension.mjs
scripts/verify.mjs
server/db/connection.mjs
server/db/migrate.mjs
server/formal-persistence.mjs
server/index.mjs
server/object-storage.mjs
server/ozon-import-normalizer.mjs
server/persistence.mjs
server/scrape-script.js
server/tests/import-currency-contract.test.mjs
server/tests/ozon-import-normalizer.test.mjs
```

以上差异均视为用户已有工作区状态，本 Task 未清理、回退、暂存或吸收。

## Concerns

1. PostgreSQL 未运行导致 6 个数据库集成测试无法建立可通过的完整基线；后续比较必须将这 6 项与本次 `ECONNREFUSED` 基线区分开。
2. `server/index.mjs` 距 6200 行模块边界门禁仅余 14 行；后续拆分阶段不应继续向入口增加实现。
3. 工作区已有 174 个 dirty 条目，且 `server/index.mjs`、`scripts/verify.mjs` 等目标/门禁文件本身已有修改；后续必须基于当前状态做窄范围 diff，不能把既有改动误判为本轮产物。
4. Vite 构建通过，但产生约 1,574.81 kB 的主 JS chunk，并有超过 500 kB 的警告；这是非阻塞基线警告，不属于本 Task 修复范围。

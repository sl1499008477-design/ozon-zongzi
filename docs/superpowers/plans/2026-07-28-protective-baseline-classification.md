# Protective Baseline Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前 63 个已跟踪改动和 313 个未跟踪文件按职责保存为可审查、可验证、可独立回退的保护性基线，不删除来源不明文件，也不改变业务行为。

**Architecture:** 本阶段只做版本控制层面的分类与取证，不重构代码。提交按基础设施、服务端与迁移、Web、扩展、桌面端、测试门禁、文档、生成产物与运行资产的依赖顺序排列；每次提交前检查暂存范围并运行当前环境可执行的最小验证，最终用一份基线报告记录通过、失败、未运行项和恢复方法。

**Tech Stack:** Git、Node.js ESM、pnpm workspace、Vite/React、Chrome Extension Manifest V3、Electron、PostgreSQL SQL migrations、Docker Compose。

## Global Constraints

- 保留当前所有来源未确认的文件，不以清理为名直接删除。
- 基线阶段只整理文件归属、依赖和验证环境，不改变业务行为。
- 不使用 `git reset --hard`、强制检出、递归删除或清空工作区。
- 每次提交只包含一个类别，提交前必须检查 `git diff --cached --name-status`。
- 当前工作分支必须是 `codex/baseline-stabilization`，保护设计提交 `84861df` 必须保持为 `HEAD` 的祖先。
- 真实 Ozon 写操作、真实店铺同步、生产迁移、对象存储写入和密钥变更一律不执行。
- 验证失败必须记录真实退出码和原因，不能把环境阻塞标记为通过。
- 本阶段不修改产品规则、接口 contract、数据库结构或运行逻辑。
- 本机 shell 的 `PATH` 中没有 `node`；Node 命令使用 `/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。
- pnpm 命令使用 `/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm`。
- 所有新建或修改的文档使用 `apply_patch`，不使用 shell 重定向覆盖文件。
- 回退已提交分类时使用 `git revert` 并按提交逆序执行，不重放任何外部请求。
- 根据用户在 2026-07-28 的执行前裁决，保留并提交本计划启动前已有的 `.superpowers` 历史资料，但不得暂存 `.superpowers/sdd/2026-07-28-protective-baseline-classification/`；该目录是本次子代理流程的临时台账与评审空间，最终评审后删除。

---

## File Responsibility Map

| 分类 | 路径 | 责任 |
| --- | --- | --- |
| 基础设施 | `.dockerignore`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `docker/`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `scripts/dev.mjs`, `scripts/frontend-compat-proxy.mjs`, `README.md` | 本地运行、容器、workspace 与依赖入口 |
| 服务端与迁移 | `server/*.mjs`, `server/*.js`, `server/db/` | 服务端业务模块、持久化、外部 Port、18 个 SQL migration |
| Web | `app/package.json`, `app/vite.config.mjs`, `app/src/` | React 页面、共享计算和客户端 transport |
| 扩展源码 | `extension/manifest.json`, `extension/background/`, `extension/content/`, `extension/lib/`, `extension/popup/`（排除测试目录） | 浏览器扩展运行源码 |
| 桌面端运行资产 | `desktop/package.json`, `desktop/pnpm-lock.yaml`, `desktop/pnpm-workspace.yaml`, `desktop/electron/`, `desktop/dist/`, `desktop/dist-electron/`, `desktop/build/` | 当前 Electron 可运行包及其直接入口 |
| 测试与门禁 | `app/tests/`, `server/tests/`, `extension/**/__tests__/`, `extension/tests/`, `desktop/tests/`, `desktop/scripts/`, `scripts/check-*.mjs`, `scripts/package-extension.mjs`, `scripts/test-manifest.mjs`, `scripts/verify.mjs` | 自动测试、测试清单和验证脚本 |
| 文档 | `design-qa.md`, `docs/architecture/`, 既有 `docs/superpowers/plans/` 与 `docs/superpowers/specs/` | 架构依据、设计决策和交付记录 |
| 生成产物与历史工作资产 | `app/public/plugin/popup.js`, `app/public/sonli-extension-0.13.46.1.zip`, `app/public/sonli-extension-0.13.46.1/`, 本计划启动前已有的 `.superpowers/` 内容 | 扩展分发副本、ZIP、历史评审与执行快照；排除本计划的临时 SDD workspace |
| 基线报告 | `docs/baseline/2026-07-28-protective-baseline.md` | 文件统计、验证证据、依赖、风险和恢复说明 |

`desktop/dist` 和 `desktop/dist-electron` 当前没有已确认的源码重建命令，并且 `desktop/package.json` 直接以 `dist-electron/main.js` 为入口，因此本阶段把它们当作受控运行资产保存，不按普通可删除构建目录处理。

## Scope Boundary

本计划只实现已确认设计中的“第 4 节：保护性基线”。统一依赖安装与根验证全绿、RequestContext 与 `tenant.operate`、上架规则去硬编码、稳定 API contract、审计恢复以及巨型文件拆分分别属于后续独立计划；这样可以避免把保存现状与修改业务行为混入同一组提交。

### Task 1: 冻结起始状态并确认零副作用边界

**Files:**
- Read: `docs/superpowers/specs/2026-07-28-baseline-stabilization-design.md`
- Read: `docs/superpowers/plans/2026-07-28-protective-baseline-classification.md`
- Create: none
- Modify: none

**Interfaces:**
- Consumes: Git 分支、HEAD、index 和工作区状态。
- Produces: 后续每个分类任务共同使用的起点证明；不产生代码或数据变更。

- [ ] **Step 1: 验证分支和保护提交**

Run:

```bash
git branch --show-current
git merge-base --is-ancestor 84861df HEAD
git log --oneline --decorate -5
```

Expected:

```text
codex/baseline-stabilization
```

`git merge-base --is-ancestor` 的退出码必须为 `0`；最近日志必须包含 `84861df docs: design baseline stabilization` 和本计划的提交。

- [ ] **Step 2: 验证 index 为空**

Run:

```bash
git diff --cached --name-only
```

Expected: 无输出。若有输出，停止执行并先识别是谁暂存了这些文件；不得擅自取消他人的暂存。

- [ ] **Step 3: 记录工作区数量**

Run:

```bash
git status --porcelain=v1 | awk 'substr($0,1,2)=="??"{u++} substr($0,1,2)!="??"{t++} END{print "tracked_changes=" t; print "untracked_entries=" u}'
git ls-files --others --exclude-standard | rg -v '^\.superpowers/sdd/2026-07-28-protective-baseline-classification/' | wc -l
git ls-files --others --ignored --exclude-standard .superpowers/sdd/2026-07-28-protective-baseline-classification | wc -l
```

Expected after the SDD workspace is created:

```text
tracked_changes=63
untracked_entries=134
313
1
```

The `313` is the original number of actual untracked files; the final `1` is this plan's known temporary ledger. The status entry count groups whole directories.

- [ ] **Step 4: 确认不会调用真实外部副作用**

Run:

```bash
git diff --name-only
git ls-files --others --exclude-standard
```

Expected: 本计划只会运行 Git、语法检查、单元测试、构建检查和 Docker Compose 配置插值；不运行 `pnpm server`、`pnpm worker`、`pnpm db:migrate`、Electron 应用、浏览器扩展或任何同步/上架命令。

### Task 2: 提交基础设施与 workspace 配置

**Files:**
- Add/Modify: `.dockerignore`
- Add/Modify: `.env.example`
- Add/Modify: `Dockerfile`
- Add/Modify: `docker-compose.yml`
- Add/Modify: `docker/nginx.conf`
- Add/Modify: `package.json`
- Add/Modify: `pnpm-lock.yaml`
- Add/Modify: `pnpm-workspace.yaml`
- Modify/Delete as currently present: `scripts/dev.mjs`
- Modify/Delete as currently present: `scripts/frontend-compat-proxy.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: 当前工作区中的容器、依赖和启动配置。
- Produces: 后续源码提交可引用的 workspace 与运行基线。

- [ ] **Step 1: 只暂存基础设施路径**

Run:

```bash
git add -- .dockerignore .env.example Dockerfile docker-compose.yml docker package.json pnpm-lock.yaml pnpm-workspace.yaml README.md scripts/dev.mjs scripts/frontend-compat-proxy.mjs
git diff --cached --name-status
```

Expected: 暂存列表只包含上述路径；不得包含 `app/`、`server/`、`extension/`、`desktop/`、`docs/` 或 `.superpowers/`。

- [ ] **Step 2: 检查格式与 Docker Compose 配置**

Run:

```bash
git diff --cached --check
docker compose config --quiet
```

Expected: 两条命令退出码均为 `0`；Compose 只解析配置，不启动容器。

- [ ] **Step 3: 检查暂存内容中没有疑似真实凭据**

Run:

```bash
git diff --cached | rg -n -i '(api[-_ ]?key|apikey|client[-_ ]?id).{0,80}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{6,})'
```

Expected: 退出码 `1` 且无匹配输出。示例变量名允许存在，真实长数字或 UUID 凭据不得进入提交。

- [ ] **Step 4: 提交基础设施基线**

Run:

```bash
git commit -m "chore: preserve infrastructure baseline"
```

Expected: 提交成功，提交内容只属于基础设施与 workspace。

### Task 3: 提交服务端业务模块与数据库迁移

**Files:**
- Add/Modify: `server/*.mjs`
- Add/Modify: `server/*.js`
- Add/Modify: `server/db/connection.mjs`
- Add/Modify: `server/db/migrate.mjs`
- Add: `server/db/migrations/002_api_key_dates.sql` through `server/db/migrations/017_pricing_rule_confirmation.sql`
- Preserve: existing `server/db/migrations/001_formal_schema.sql`
- Preserve: existing `server/db/migrations/002_product_asset_video_metadata.sql`
- Exclude: `server/tests/`

**Interfaces:**
- Consumes: Task 2 的根依赖和环境变量 contract。
- Produces: 可由测试提交验证的服务端模块与连续 migration 集合。

- [ ] **Step 1: 只暂存服务端生产代码和迁移**

Run:

```bash
git add -- server/*.mjs server/*.js server/db
git diff --cached --name-status
```

Expected: 所有暂存路径位于 `server/`，且没有任何 `server/tests/` 路径。

- [ ] **Step 2: 验证全部服务端 JavaScript 语法**

Run:

```bash
find server -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.js' \) -print0 | xargs -0 -n1 /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check
```

Expected: 退出码 `0`，无语法错误。

- [ ] **Step 3: 验证 migration 清单完整**

Run:

```bash
find server/db/migrations -maxdepth 1 -type f -name '*.sql' | sort
find server/db/migrations -maxdepth 1 -type f -name '*.sql' | wc -l
```

Expected: 共 `18` 个 SQL 文件；同时保留两个 `002_*.sql` 历史 migration，不能因编号重复而改名或删除。

- [ ] **Step 4: 运行无外部写入的服务端核心单元测试**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 server/tests/permissions.test.mjs server/tests/pricing-engine.test.mjs server/tests/order-money-summary.test.mjs server/tests/store-cache-scope.test.mjs server/tests/external-write-safety.test.mjs
```

Expected: 全部通过；测试不得连接生产数据库或发起真实 Ozon 请求。

- [ ] **Step 5: 检查并提交**

Run:

```bash
git diff --cached --check
git commit -m "feat: preserve server safety baseline"
```

Expected: 提交成功，测试文件仍未暂存。

### Task 4: 提交 Web 应用源码

**Files:**
- Modify: `app/package.json`
- Modify: `app/vite.config.mjs`
- Add/Modify: `app/src/`
- Exclude: `app/tests/`
- Exclude: `app/public/`

**Interfaces:**
- Consumes: Task 2 的 workspace 和 Task 3 的现有 HTTP contract。
- Produces: React 页面、共享金额/日期模块和客户端 transport 的当前行为基线。

- [ ] **Step 1: 只暂存 Web 源码**

Run:

```bash
git add -- app/package.json app/vite.config.mjs app/src
git diff --cached --name-status
```

Expected: 暂存路径只在 `app/package.json`、`app/vite.config.mjs` 和 `app/src/`；不得包含 `app/tests/` 或 `app/public/`。

- [ ] **Step 2: 运行不依赖 React 渲染环境的纯逻辑测试**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/order-money.test.mjs app/tests/order-analytics.test.mjs app/tests/category-readiness.test.mjs app/tests/category-dictionary-readiness.test.mjs
```

Expected: 全部通过。

- [ ] **Step 3: 运行 Web 构建并如实记录环境结果**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm --dir app build
```

Expected at current baseline: 因 `app` 依赖未完整安装而非零退出；把原始错误归入最终基线报告的“环境阻塞”，不能写成通过，也不能在本任务顺手修改依赖策略。

- [ ] **Step 4: 检查并提交**

Run:

```bash
git diff --cached --check
git commit -m "feat: preserve web application baseline"
```

Expected: 提交成功；构建环境问题保留给稳定基线门禁阶段。

### Task 5: 提交浏览器扩展源码

**Files:**
- Modify: `extension/manifest.json`
- Add/Modify: `extension/background/service-worker.js`
- Add/Modify: `extension/background/sync/`
- Add/Modify/Delete as currently present: `extension/content/`
- Add/Modify: `extension/lib/`
- Modify: `extension/popup/popup.css`
- Modify: `extension/popup/popup.html`
- Modify: `extension/popup/popup.js`
- Exclude: `extension/background/__tests__/`
- Exclude: `extension/popup/__tests__/`
- Exclude: `extension/tests/`

**Interfaces:**
- Consumes: Task 3 的后端路由和同步 contract。
- Produces: Manifest V3 扩展运行源码；Task 8 的扩展测试和 Task 10 的分发副本以此为上游。

- [ ] **Step 1: 只暂存扩展运行源码**

Run:

```bash
git add -- extension/manifest.json extension/background/service-worker.js extension/background/sync extension/content extension/lib extension/popup/popup.css extension/popup/popup.html extension/popup/popup.js
git diff --cached --name-status
```

Expected: 不包含任何 `__tests__` 或 `extension/tests/` 路径；`extension/content/collector/` 的现有删除记录会被保留。

- [ ] **Step 2: 验证主要入口语法和 manifest**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check extension/background/service-worker.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check extension/content/ozon-product.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check extension/popup/popup.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')"
```

Expected: 全部退出码 `0`，最后输出 `manifest ok`。

- [ ] **Step 3: 运行扩展关键纯 Node 测试**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/category-readiness.test.js extension/tests/collector-removed.test.js extension/tests/jizhangerp-bridge-follow-sell.test.js extension/background/__tests__/dedupe.smoke.test.js extension/background/__tests__/fx-probe.smoke.test.js extension/popup/__tests__/popup-routing.smoke.test.js
```

Expected: 全部通过；不运行依赖 Playwright 的历史浏览器测试。

- [ ] **Step 4: 检查并提交**

Run:

```bash
git diff --cached --check
git commit -m "feat: preserve browser extension baseline"
```

Expected: 提交成功，扩展测试和分发副本仍未暂存。

### Task 6: 提交桌面端运行代码和受控资源

**Files:**
- Add: `desktop/package.json`
- Add: `desktop/pnpm-lock.yaml`
- Add: `desktop/pnpm-workspace.yaml`
- Add: `desktop/electron/`
- Add: `desktop/dist/`
- Add: `desktop/dist-electron/`
- Add: `desktop/build/`
- Exclude: `desktop/tests/`
- Exclude: `desktop/scripts/`
- Exclude: `desktop/README.md`
- Exclude: `desktop/IMPLEMENTATION_STATUS.md`

**Interfaces:**
- Consumes: Task 3 的采集服务 contract。
- Produces: 当前可启动 Electron 包的入口、renderer、preload 和图标资源。

- [ ] **Step 1: 只暂存桌面端运行文件**

Run:

```bash
git add -- desktop/package.json desktop/pnpm-lock.yaml desktop/pnpm-workspace.yaml desktop/electron desktop/dist desktop/dist-electron desktop/build
git diff --cached --name-status
```

Expected: 不包含 `desktop/tests/`、`desktop/scripts/` 或桌面端 Markdown 文档。

- [ ] **Step 2: 验证桌面端 JavaScript 语法**

Run:

```bash
find desktop/electron desktop/dist-electron -type f \( -name '*.mjs' -o -name '*.js' -o -name '*.cjs' \) -print0 | xargs -0 -n1 /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check
```

Expected: 退出码 `0`。

- [ ] **Step 3: 运行桌面端验证并记录已知依赖阻塞**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node desktop/scripts/verify.mjs
```

Expected at plan creation time: `31` 项中 `30` 项通过、`1` 项失败；`desktop/tests/parse-modern-ozon.test.mjs` 因找不到声明但未安装的 `cheerio` 而失败。把该结果记录为依赖环境阻塞，不在分类任务中改代码。

- [ ] **Step 4: 检查并提交**

Run:

```bash
git diff --cached --check
git commit -m "feat: preserve desktop runtime baseline"
```

Expected: 提交成功，桌面端受控运行资产获得独立回退点。

### Task 7: 提交自动测试、验证脚本和安全门禁

**Files:**
- Add/Modify: `app/tests/`
- Add/Modify: `server/tests/`
- Add/Modify/Delete as currently present: `extension/tests/`
- Add/Modify: `extension/background/__tests__/`
- Add/Modify: `extension/popup/__tests__/`
- Add: `desktop/tests/`
- Add: `desktop/scripts/verify.mjs`
- Add/Modify: `scripts/check-*.mjs`
- Modify: `scripts/package-extension.mjs`
- Add: `scripts/test-manifest.mjs`
- Modify: `scripts/verify.mjs`

**Interfaces:**
- Consumes: Tasks 3–6 的源码和运行 contract。
- Produces: 当前测试清单、回归门禁和已知环境失败的可重复证据。

- [ ] **Step 1: 暂存测试和门禁文件**

Run:

```bash
git add -- app/tests server/tests extension/tests extension/background/__tests__ extension/popup/__tests__ desktop/tests desktop/scripts/verify.mjs scripts/check-collect-edit-listing-contract.mjs scripts/check-collect-delete-persistence.mjs scripts/check-extension-diff-contract.mjs scripts/check-extension-source-parity.mjs scripts/check-extension-ui-parity.mjs scripts/check-extension-zip-smoke.mjs scripts/check-extension-zip.mjs scripts/check-import-history-types.mjs scripts/check-plugin-readiness-gate.mjs scripts/check-store-data-isolation.mjs scripts/check-test-inventory.mjs scripts/package-extension.mjs scripts/test-manifest.mjs scripts/verify.mjs
git diff --cached --name-status
```

Expected: 暂存列表只包含测试、验证、打包与门禁脚本。

- [ ] **Step 2: 检查测试清单覆盖**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-test-inventory.mjs
```

Expected: 当前已声明测试与 `scripts/test-manifest.mjs` 一致；若失败，记录缺失文件名称，不在本阶段修改测试策略。

- [ ] **Step 3: 运行完整当前测试套件**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 $(/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node -e "import('./scripts/test-manifest.mjs').then(({activeTestFiles}) => process.stdout.write(activeTestFiles.join(' ')))")
```

Expected at plan creation time: `112` 项中 `104` 项通过、`8` 项因缺少 React 依赖或 PostgreSQL 未启动而失败。记录具体失败测试、错误信息和退出码。

- [ ] **Step 4: 检查并提交**

Run:

```bash
git diff --cached --check
git commit -m "test: preserve regression safety baseline"
```

Expected: 提交成功；失败测试仍作为真实基线证据存在。

### Task 8: 提交架构、设计和交付文档

**Files:**
- Modify: `design-qa.md`
- Add: `docs/architecture/`
- Add: existing untracked files under `docs/superpowers/plans/`
- Add: existing untracked files under `docs/superpowers/specs/`
- Preserve: tracked `docs/superpowers/specs/2026-07-28-baseline-stabilization-design.md`
- Preserve: tracked `docs/superpowers/plans/2026-07-28-protective-baseline-classification.md`
- Add: `desktop/README.md`
- Add: `desktop/IMPLEMENTATION_STATUS.md`

**Interfaces:**
- Consumes: 已确认设计和已有实施历史。
- Produces: 后续安全改造可追溯的架构与决策依据。

- [ ] **Step 1: 暂存交付文档**

Run:

```bash
git add -- design-qa.md docs/architecture docs/superpowers/plans docs/superpowers/specs desktop/README.md desktop/IMPLEMENTATION_STATUS.md
git diff --cached --name-status
```

Expected: 只包含 Markdown 文档；本计划若已在执行前单独提交，不应重复出现在差异中。

- [ ] **Step 2: 验证文档引用的关键路径存在**

Run:

```bash
test -f docs/architecture/module-boundaries.md
test -f docs/architecture/permissions-and-platform-rules.md
test -f docs/superpowers/specs/2026-07-28-baseline-stabilization-design.md
test -f docs/superpowers/plans/2026-07-28-protective-baseline-classification.md
test -f desktop/README.md
```

Expected: 所有命令退出码为 `0`。

- [ ] **Step 3: 检查并提交**

Run:

```bash
git diff --cached --check
git commit -m "docs: preserve architecture and delivery baseline"
```

Expected: 提交成功，文档与源码分类分离。

### Task 9: 提交生成产物、分发副本和历史工作资产

**Files:**
- Modify: `app/public/plugin/popup.js`
- Modify: `app/public/sonli-extension-0.13.46.1.zip`
- Add: `app/public/sonli-extension-0.13.46.1/`
- Add: `.superpowers/ozon-sync-extraction/`
- Add: `.superpowers/sdd/.gitignore`
- Add: `.superpowers/sdd/2026-07-27-prototype-style-refresh/`
- Add: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/`
- Add: `.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/`
- Exclude: `.superpowers/sdd/2026-07-28-protective-baseline-classification/`

**Interfaces:**
- Consumes: Task 5 的扩展源码和既有执行历史。
- Produces: 当前 Web 下载入口使用的扩展分发资产，以及不确定是否还能重建的历史评审证据。

- [ ] **Step 1: 记录分发资产摘要**

Run:

```bash
shasum -a 256 app/public/sonli-extension-0.13.46.1.zip
find app/public/sonli-extension-0.13.46.1 -type f | wc -l
find .superpowers -type f ! -path '.superpowers/sdd/2026-07-28-protective-baseline-classification/*' | wc -l
find .superpowers/sdd/2026-07-28-protective-baseline-classification -type f | wc -l
```

Expected: ZIP 输出一个 SHA-256；扩展解压副本当前包含 `92` 个文件；既有 `.superpowers` 和本计划临时 workspace 的数量分别记录，只有前者进入提交。

- [ ] **Step 2: 暂存生成产物和历史工作资产**

Run:

```bash
git add -- app/public/plugin/popup.js app/public/sonli-extension-0.13.46.1.zip app/public/sonli-extension-0.13.46.1 .superpowers/ozon-sync-extraction .superpowers/sdd/.gitignore
git add -f -- .superpowers/sdd/2026-07-27-prototype-style-refresh .superpowers/sdd/2026-07-28-ozon-category-query-extraction .superpowers/sdd/2026-07-28-ozon-sync-service-extraction
git diff --cached --name-status
```

Expected: 只包含 `app/public/` 和上述执行前已有的 `.superpowers/` 路径；`-f` 仅用于用户明确要求保留的三个历史 SDD 目录，不得包含 `.superpowers/sdd/2026-07-28-protective-baseline-classification/`。

- [ ] **Step 3: 验证扩展源码和分发副本**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-source-parity.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-ui-parity.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-diff-contract.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-zip-smoke.mjs
```

Expected: 将每条命令的真实结果写入最终报告。若 `app/dist` 缺失导致 ZIP 检查失败，标记为 Web 构建环境阻塞；不得为让检查变绿而手工修改 ZIP。

- [ ] **Step 4: 检查并提交**

Run:

```bash
git diff --cached --check
git commit -m "chore: preserve generated runtime assets"
```

Expected: 提交成功，生成/运行资产可以与源码提交分开审查和回退。

### Task 10: 建立最终基线报告并证明工作区完整

**Files:**
- Create: `docs/baseline/2026-07-28-protective-baseline.md`

**Interfaces:**
- Consumes: Tasks 1–9 的 Git 提交、验证输出和资产摘要。
- Produces: 下一阶段“稳定基线门禁”使用的唯一基线证据文档。

- [ ] **Step 1: 收集分类提交**

Run:

```bash
git log --reverse --oneline 84861df..HEAD
```

Expected: 按顺序列出计划准备提交，以及基础设施、服务端、Web、扩展、桌面端、测试、文档、运行资产提交。

- [ ] **Step 2: 运行根验证**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify.mjs
```

Expected: 当前环境可能非零退出。逐项记录 Web 构建、扩展一致性、服务端语法、测试清单、完整测试、Compose、数据隔离、凭据扫描的实际状态；未运行项写清依赖和原因。

- [ ] **Step 3: 创建基线报告**

Use `apply_patch` to create the file with this exact section structure:

```markdown
# 2026-07-28 保护性基线报告

## 起点

- 分支：`codex/baseline-stabilization`
- 保护设计提交：`84861df`
- 整理前状态：63 个已跟踪改动，313 个未跟踪文件。
- 外部副作用：未执行真实 Ozon 写入、真实店铺同步、生产迁移、对象存储写入或密钥变更。

## 分类提交

记录 `git log --reverse --oneline 84861df..HEAD` 的实际输出，并为每个提交说明文件类别。

## 文件分类

记录基础设施、服务端与迁移、Web、扩展、桌面端、测试门禁、文档、生成产物和历史工作资产的实际文件数量与路径边界。

## 生成产物与运行资产

记录扩展 ZIP 的 SHA-256、解压副本文件数、源码一致性结果；说明 `desktop/dist` 与 `desktop/dist-electron` 因当前缺少已确认源码重建命令而继续作为受控运行资产。

## 验证结果

用“检查 / 状态 / 证据或原因”三列表格记录每条实际执行命令。失败项保留退出码和首个根因，不用“通过”描述环境阻塞。

## 外部依赖与未验证范围

记录 PostgreSQL、React/Vite 依赖、desktop `cheerio`、Docker、对象存储、Ozon API 和浏览器运行时的实际可用性；明确本阶段未执行生产数据或外部写操作。

## 回归风险

说明当前提交保存的是既有大规模改动，分类提交提升了可审查性，但尚未证明所有功能无回归；根验证全绿属于下一阶段门禁。

## 恢复方法

保留整个基线时以本报告提交为锚点。取消某一分类时，从最新提交开始按逆序执行 `git revert <commit-sha>`；不使用 `git reset --hard`，不通过重复外部请求恢复数据。
```

- [ ] **Step 4: 检查没有遗漏文件**

Run:

```bash
git status --short
git diff --check
git diff --cached --check
```

Expected before staging the report: 只显示 `?? docs/baseline/`；本计划临时 SDD workspace 受 `.superpowers/sdd/.gitignore` 排除，不出现在普通 status 中。不得再有原先 63 个已跟踪改动或 313 个未跟踪文件。

- [ ] **Step 5: 提交基线报告**

Run:

```bash
git add -- docs/baseline/2026-07-28-protective-baseline.md
git diff --cached --name-status
git commit -m "docs: record protective baseline verification"
```

Expected: 暂存和提交只包含基线报告。

- [ ] **Step 6: 最终验证 Git 完整性**

Run:

```bash
git status --short
git log --reverse --oneline 84861df..HEAD
```

Expected: `git status --short` 无输出；本计划被明确排除的临时 SDD workspace 仍然存在但受忽略。日志包含计划准备提交、八个分类提交和一个基线报告提交。若根验证仍有环境失败，报告必须明确这些失败，不能宣称“稳定基线全绿”。

## SDD Final Review Gate

全部任务完成后，按 `superpowers:subagent-driven-development` 生成从分支起点到 `HEAD` 的最终 review package，并由独立 reviewer 审查整条分支。最终评审及其唯一一次修复波次完成后，删除已知临时目录：

```bash
rm -rf "/Users/songliang/Documents/sonli ozon3.0/.superpowers/sdd/2026-07-28-protective-baseline-classification"
git status --short
```

Expected: 只删除本计划在执行开始时创建的已知临时目录，其他 `.superpowers` 历史资料保持已提交；随后 `git status --short` 无输出。

## Rollback Order

若需要完整撤销本计划的提交，先用 `git log --reverse --oneline 84861df..HEAD` 取得实际 SHA，然后从最新到最旧逐个执行 `git revert <commit-sha>`。推荐逆序：

1. 基线报告
2. 生成产物与历史工作资产
3. 架构、设计和交付文档
4. 测试、验证和安全门禁
5. 桌面端运行代码和资源
6. 浏览器扩展源码
7. Web 应用源码
8. 服务端业务模块与数据库迁移
9. 基础设施与 workspace 配置

这些 Git 回退不会恢复或重放外部系统状态；本计划本身也不产生外部写入。

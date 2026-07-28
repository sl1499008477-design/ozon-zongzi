# 2026-07-28 保护性基线报告

## 起点

- 分支：`codex/baseline-stabilization`。
- 保护设计提交：`319726e`；`git merge-base --is-ancestor 319726e HEAD` 在报告编写前退出码为 `0`。
- 整理前状态：63 个已跟踪改动，313 个非忽略未跟踪实际文件。普通 `git status` 会折叠目录，因此状态条目数不等同于实际文件数。
- 本次分类保存的是计划启动前已经存在的大规模改动；分类过程没有以清理为名删除来源不明文件。
- 2026-07-29 用户明确授权重写 Git 历史；`main` 与 `codex/baseline-stabilization` 已在私有 mirror 验证后原子切换到脱敏提交链。本报告中的提交编号均为重写后的编号。
- 外部副作用：未执行真实 Ozon 写入、真实店铺同步、生产迁移、对象存储写入、生产部署或密钥变更；未启动应用服务、worker、Electron、Chrome 扩展或数据库。

## 分类提交

以下是报告提交前实际运行 `git log --reverse --oneline 319726e..HEAD` 的完整输出：

```text
e9eaf39 docs: plan protective baseline classification
75fbde8 docs: exclude active sdd workspace from baseline
815d178 docs: account for ignored sdd history
6bfd612 chore: preserve infrastructure baseline
fbe67e5 fix: restore local development entrypoint
66fde78 fix: proxy local development websocket upgrades
9cad7ac test: validate browser websocket proxy contract
56e8852 feat: preserve server safety baseline
d97f029 fix: enforce tenant and external write safety
d0ea8d7 fix: make tenant snapshot writes atomic
322524e feat: preserve web application baseline
db2b67e fix: restore web runtime contracts
182b4ec fix: separate store deletion cleanup failures
ad9b738 fix: preserve successor store binding
16a7e3a feat: preserve browser extension baseline
9e28f4e fix: enforce extension security and pricing safety
a4bc3f3 fix: close web bridge privilege bypass
dc8d3c6 fix: verify seller identity from trusted context
3d03bd7 fix: replay pending fx observations safely
fa49b9e fix: persist local pricing idempotency
92fe682 fix: enforce portal bridge message contracts
dc7c53f fix: scope pending fx observations
f81abca fix: serialize local pricing idempotency
ac98298 fix: close task 5 concurrency and routing gaps
29a214f fix: fail closed on fx replay storage errors
7f02c07 feat: preserve desktop runtime baseline
3825554 fix: contain desktop Excel file access
3677867 fix: preserve desktop Excel export outcomes
f4b9087 fix: encode desktop Excel task ownership
6483828 test: preserve regression safety baseline
cded255 fix: close regression gate review gaps
efad0de fix: keep environment blockers fail closed
4978796 docs: preserve architecture and delivery baseline
b6342d3 chore: redact personal information from extension source
d53f724 chore: preserve generated runtime assets
9603c7d docs: record protective baseline verification
e5d64df docs: record green baseline verification
f60e92a fix: redact historical source evidence
e0e0cb5 docs: update final sensitive-data verification
```

文件类别对应关系如下；每个提交都归入其所在分组：

- 计划与边界：`e9eaf39`、`75fbde8`、`815d178`，记录分类计划、当前 SDD workspace 排除规则和既有 SDD 历史保留规则。
- 基础设施与本地入口：`6bfd612`、`fbe67e5`、`66fde78`、`9cad7ac`，保存容器/workspace 配置、本地开发入口、WebSocket 转发及其回归 contract。
- 服务端与迁移：`56e8852`、`d97f029`、`d0ea8d7`，保存服务端基线，并修复租户归属、外部提交不确定性和原子 pricing snapshot 写入边界。
- Web：`322524e`、`db2b67e`、`182b4ec`、`ad9b738`，保存 Web 源码，并保护运行端口、门店删除结果、清理失败分离和继任门店绑定。
- 扩展及相关 pricing 安全 contract：`16a7e3a`、`9e28f4e`、`a4bc3f3`、`dc8d3c6`、`3d03bd7`、`fa49b9e`、`92fe682`、`dc7c53f`、`f81abca`、`ac98298`、`29a214f`，保存扩展源码，并保护 portal bridge、seller identity、FX replay、pricing 幂等与本地持久化边界；其中必要的服务端 migration、adapter 与回归测试随安全 contract 同步提交。
- 桌面端：`7f02c07`、`3825554`、`3677867`、`f4b9087`，保存受控 Electron 运行资产，并保护 Excel 路径、导出结果和任务文件归属边界。
- 测试与门禁：`6483828`、`cded255`、`efad0de`，保存测试清单、根验证、安全门禁和 fail-closed 结果策略。
- 架构与交付文档：`4978796`，保存当前架构边界、历史计划/spec 和桌面交付说明。
- 生成产物、历史工作资产与脱敏：`b6342d3`、`d53f724`，先修复当前源码/contract 中的个人信息与空白问题，再保存从源码生成的公开分发资产和计划启动前的历史工作记录。
- 首次基线报告：`9603c7d`，保存离线安装桌面依赖前的根验证证据，包括当时由缺少 `cheerio` 导致的唯一红项。
- 最终验证与补充脱敏：`e5d64df`、`f60e92a`，记录离线恢复依赖后的全绿结果，并脱敏四个历史 `source-evidence` JSON、把跟踪文本和 ZIP 的个人信息扫描纳入根门禁。
- 历史重写前报告：`e0e0cb5`，保留用户授权历史重写前的完整基线证据；本提交之后的报告提交记录实际重写和对象清理结果。

## 文件分类

下表的“唯一路径数”来自每个 Task 最终提交范围的 `git diff --name-only <起点>..<终点>`。这些范围内可能同时包含基线提交和后续审查修复；它们不是互斥的全仓库分区，不应相加后冒充全仓库文件总数。

| 分类 | 最终范围 | 唯一路径数 | 路径边界 |
| --- | --- | ---: | --- |
| 基础设施 | `815d178..9cad7ac` | 12 | 根 workspace、Docker、README、本地开发入口及其 contract 检查 |
| 服务端与迁移 | `9cad7ac..d0ea8d7` | 64 | `server/` 生产模块、19 个 SQL migration 和聚焦安全回归 |
| Web | `d0ea8d7..ad9b738` | 24 | `app/package.json`、Vite 配置、`app/src/` 及门店删除/运行 contract 测试 |
| 扩展及关联安全 contract | `ad9b738..29a214f` | 48 | `extension/` 运行源码、安全测试，以及紧密关联的服务端 pricing contract |
| 桌面端 | `29a214f..f4b9087` | 75 | `desktop/electron`、`desktop/dist`、`desktop/dist-electron`、构建资源及聚焦回归 |
| 测试与门禁 | `f4b9087..efad0de` | 87 | app/server/extension/desktop 测试、test inventory、打包与根验证脚本 |
| 文档 | `efad0de..4978796` | 15 | 架构、设计、历史 plans/specs 与桌面交付 Markdown |
| 生成产物、历史资产与脱敏 | `4978796..d53f724` | 412 | 108 个 `app/public/` 路径、301 个历史 `.superpowers/` 路径、3 个源码/contract 脱敏修复路径 |
| 最终个人信息修复与门禁 | `e5d64df..f60e92a` | 7 | 4 个 `source-evidence` JSON、个人信息/凭据扫描器、根验证接入和回归测试 |

Task 9 的运行/历史资产提交本身包含 409 个路径（108 个 `app/public/`、301 个历史 `.superpowers/`），另一个脱敏提交包含 3 个路径。当前计划的 `.superpowers/sdd/2026-07-28-protective-baseline-classification/` 和忽略的 `app/dist/` 都是 `0` 个 tracked、`0` 个 staged 路径。

## 生成产物与运行资产

- 当前扩展源码树、`app/public/sonli-extension-0.13.46.1/` 解压副本、公开 ZIP 和忽略的 `app/dist` ZIP 均为 106 个文件。
- `app/public/sonli-extension-0.13.46.1.zip` SHA-256：`e79e186605d111e5694afefaf130c9ea6d6dee5a460c4ba00cb9a04c494a33f2`；忽略的 `app/dist/sonli-extension-0.13.46.1.zip` 摘要相同。
- 根验证使用显式 `QH_SOURCE_EXTENSION_DIR` 后，上游源码 contract、UI、diff contract、源码与公开解压副本、两份 ZIP parity 以及两份 ZIP bridge smoke 均通过。显式上游目录是 contract 参照，不要求其文件总数等于本地完整分发树。
- `app/public/plugin/popup.js` 是 `/plugin/popup.html` 使用的独立静态入口，不由扩展打包脚本覆盖。
- `desktop/dist` 与 `desktop/dist-electron` 当前缺少已确认的源码重建命令，且 Electron 入口直接依赖 `desktop/dist-electron/main.js`，因此继续作为受控运行资产；它们不能被当作普通、可随时删除重建的构建缓存。
- 最终复审发现四个 tracked `source-evidence` JSON 仍有同一条个人信息，共 31 处；`f60e92a` 已机械替换为脱敏占位符，JSON 解析和逐字节预期替换检查均通过。新增门禁会扫描全部 Git 跟踪文本和跟踪 ZIP，只报告文件与数量、不输出敏感值，并排除长十六进制摘要中的手机号形状假阳性。
- 授权后的历史重写覆盖两个分支合计 48 个可达提交：扫描 1,151 个原历史 blob，映射 18 个污染 blob、替换 45 处，其中 15 个文本 blob、3 个 ZIP blob。三个 ZIP 的条目清单保持不变，且各只有一个目标条目变化。
- 重写后 mirror 与原仓库切换后的可达历史分别扫描 1,147 个 blob，个人信息命中均为 0，提交说明命中为 0。当前 HEAD、扩展源码、公开副本、跟踪 ZIP 和历史文本均通过统一个人信息/凭据门禁。
- 三个仍指向旧对象的 Codex 内部检查点引用和两个导入用临时引用已删除。仓库未配置远程地址，因此没有执行 force-push；若其他副本曾复制旧历史，它们必须丢弃旧对象并以本仓库的重写后提交链重新同步。

## 验证结果

首次根验证在桌面依赖尚未安装时实际执行：

```text
QH_SOURCE_EXTENSION_DIR='/Users/songliang/Desktop/0.13.46.1' /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify.mjs
```

首次结果为 **FAIL（退出码 1）**：19 个内部检查中 18 个通过、1 个失败；active suite 为 186 tests、185 passed、1 failed。唯一失败是 `desktop/tests/parse-modern-ozon.test.mjs`，首因是桌面依赖尚未安装，`desktop/dist-electron/services/collection/ozon-list-parser.core.js` 导入不到 `cheerio`（`ERR_MODULE_NOT_FOUND`）。这是保留的历史环境证据，不是当前最终状态。

随后仅从本机 pnpm store 离线恢复桌面依赖：

```text
PATH='<bundled node + pnpm>' pnpm --dir desktop install --offline --frozen-lockfile
```

该命令退出码为 `0`：lockfile 已是最新状态，387 个包全部 reused、downloaded 0，安装得到 ignored 的 `desktop/node_modules`，其中 `cheerio` 版本为 1.2.0。安装未改源码、package manifest、lockfile 或任何 Git tracked/staged 路径；本机依赖目录没有进入提交。

离线安装后再次执行同一条带显式 `QH_SOURCE_EXTENSION_DIR` 的根验证命令，当时 19 个内部检查和 186 个 tests 全部通过。最终复审补充个人信息门禁后又运行同一根验证：当前最终状态为 **PASS（退出码 0）**，仍为 19 个内部检查全部通过；test inventory 为 101 active、13 historical/manual，active suite 为 189 tests、189 passed、0 failed，modern Ozon parser 和新增敏感扫描 3 个用例均通过，最终输出 `All verification checks passed.`。新增统一门禁替换原 credential-only 门禁，因此内部检查总数仍为 19。

| 检查 | 状态 | 证据或原因 |
| --- | --- | --- |
| App build：`vite build` | PASS，退出码 0 | Vite 6.4.2 转换 4820 modules 并完成构建；仅有单 chunk 大于 500 kB 的性能警告 |
| `scripts/check-extension-source-parity.mjs` | PASS，退出码 0 | 显式 upstream parity 通过；`extension/` 与公开解压副本 distribution parity 通过 |
| `scripts/check-extension-ui-parity.mjs` | PASS，退出码 0 | 与显式 upstream 的 UI parity 通过 |
| `scripts/check-extension-diff-contract.mjs` | PASS，退出码 0 | 与显式 upstream 的 diff contract 通过 |
| `scripts/check-extension-zip.mjs` | PASS，退出码 0 | public 与 ignored dist ZIP 均匹配扩展树，各 106 文件 |
| `scripts/check-extension-zip-smoke.mjs` | PASS，退出码 0 | public 与 dist 两份 ZIP 的 bridge follow-sell 和 dry-run route guard 均通过 |
| `node --check server/index.mjs` | PASS，退出码 0 | 服务端入口语法通过 |
| `scripts/check-test-inventory.mjs` | PASS，退出码 0 | `101 active, 13 historical/manual` |
| 完整 active suite：`node --test --test-concurrency=1 <activeTestFiles>` | PASS，退出码 0 | 189 tests：189 passed、0 failed；modern Ozon parser 和个人信息扫描回归均通过 |
| `docker compose config --quiet` | PASS，退出码 0 | 仅完成 Compose 配置插值；未启动容器 |
| `scripts/check-import-history-types.mjs` | PASS，退出码 0 | import history type filter 通过 |
| `scripts/check-plugin-readiness-gate.mjs` | PASS，退出码 0 | plugin readiness gate 通过 |
| `scripts/check-collect-edit-listing-contract.mjs` | PASS，退出码 0 | collect edit listing contract 通过 |
| `scripts/check-collect-delete-persistence.mjs` | PASS，退出码 0 | collect box delete persistence contract 通过 |
| `scripts/check-store-data-isolation.mjs` | PASS，退出码 0 | operating store data isolation contract 通过 |
| `node --check extension/content/jizhangerp-bridge.js` | PASS，退出码 0 | bridge 语法通过 |
| manifest JSON 解析 | PASS，退出码 0 | 输出 `manifest ok` |
| `git diff --check -- app/src app/tests server extension app/public` | PASS，退出码 0 | 目标运行/测试/公开资产范围无空白错误 |
| `scripts/check-personal-data.mjs` | PASS，退出码 0 | 全部 Git 跟踪文本和跟踪 ZIP 无可操作手机号命中；原 credential literal 检查范围继续受保护，扫描结果不回显敏感值 |

根验证之外的分类范围与资产只读复核也通过：原八类范围计数分别为 12、64、24、48、75、87、15、412，最终个人信息修复范围为 7；migration 为 19；public/dist ZIP SHA-256 相同。

历史重写专项验证也通过：`main` 保持 8 个提交，保护分支保持 48 个提交，两个分支的提交主题和顺序未变；保护分支重写前后最终文件树完全一致；18 个 blob 映射完整，3 个 ZIP 均能解压且非目标条目逐字节不变；原仓库切换后可达历史再次扫描为 0。

## 外部依赖与未验证范围

- React/Vite 依赖在本次根验证环境可用，App build 已通过；大 chunk 警告尚未作为失败门禁。
- 桌面端声明的 `cheerio` 1.2.0 当前可从 ignored 的 `desktop/node_modules` 解析，modern Ozon parser test 已通过。依赖由本机 pnpm store 以 `--offline --frozen-lockfile` 恢复，387 个包全部 reused、downloaded 0；依赖目录没有提交，换机或清理 ignored 文件后必须按 lockfile 重新恢复。
- Docker CLI 与 Compose 插值可用；未启动 Docker engine 中的服务、PostgreSQL、MinIO 或任何容器。
- PostgreSQL：19 个 migration 已清点，但未在真实/一次性 PostgreSQL 上执行 migration、事务、advisory-lock 并发或回滚验证；六个 PostgreSQL integration 属于 historical/manual 清单，未运行。
- 本地 JSON pricing 幂等已覆盖同一 Node 进程内的文件级互斥，但多 Node 进程/多副本共享同一文件的操作系统级文件锁边界未实现、未验证。
- 浏览器：未运行七个 Playwright historical/manual 测试，未加载真实 Chrome 扩展，也未验证 reload、alarm、cookie、content-script 隔离世界或真实站点生命周期。
- 桌面端：未启动 Electron GUI，未验证真实 dialog、renderer IPC sender/origin、Windows 文件系统、打包或安装器；parser 的纯 Node 回归通过不等同于 GUI/打包集成验证。
- 外部系统：未调用 Ozon/Seller/1688 API，未进行真实店铺同步、上架、对象存储写入、生产数据读写、生产部署或凭据变更；其可用性和恢复流程未被本阶段证明。
- 权限：管理权限已有集中 matrix，路由也有认证、账号过滤和门店归属保护；但 `tenant.operate` 尚未在所有现有业务路由中普遍强制，不能把当前覆盖范围描述成统一后端授权完成。

## 回归风险

- 当前分支保存的是计划启动前已经存在的大规模改动，并在审查中补充了租户隔离、权限、幂等、外部写安全、浏览器 bridge、FX replay、门店删除、桌面采集生命周期、Excel 路径归属和根门禁等核心回归保护。
- 分类提交提升了可审查性、可追溯性和独立回退能力；当前根验证已全绿，19 个内部检查和 189 个 active tests 均通过。但真实数据库、浏览器、Electron GUI、Windows/打包和外部系统仍未集成验证。
- 当前门禁全绿也不可能保证以后任意改动绝不影响其他功能。自动测试只能证明已覆盖的输入、contract 和环境，不能证明未知路径不存在回归；大于 500 kB 的构建 chunk 仍是非阻断性能风险。
- 下一阶段每次改动仍必须先确认业务目标与影响面（页面、接口、数据、权限、配置、外部服务），再执行对应单元/集成/构建/回归验证，并预先说明可执行的回滚或数据恢复方法。
- 当前分支和可达 Git 历史已经脱敏并由自动门禁保护。历史重写改变了两个分支的所有相关提交编号；任何持有旧副本的使用者都不能把旧分支合并回来，否则会重新引入已清理对象。

## 恢复方法

- 保留整个保护性基线时，以提交标题 `docs: record authorized history rewrite` 对应的报告提交为锚点；该提交之后的任何功能改动都应建立在其上。首次缺少桌面依赖导致的红色结果和最终复审发现的个人信息缺口都作为历史证据保留，但不是当前 HEAD 的已知红项。
- 取消单个类别或修复时，先用 `git log --reverse --oneline 319726e..HEAD` 确认实际提交和依赖，再从最新相关提交开始按逆序执行 `git revert <commit-sha>`。不要使用 `git reset --hard`，不要通过重放外部请求恢复数据。
- 完整撤销的推荐类别逆序为：基线报告；生成产物/历史资产与脱敏；文档；测试门禁；桌面端；扩展及关联安全 contract；Web；服务端与迁移；基础设施。每一类内部也按日志逆序 revert。
- `b6342d3` 与 `f60e92a` 在重写后保留为审计节点；其父提交也已脱敏，不能再使用重写前的旧 SHA 执行恢复。历史重写本身不能通过普通 `git revert` 撤销，也不应从临时恢复包恢复污染对象。
- 本阶段没有执行外部写入，因此 Git revert 不需要、也不会自动恢复或重放 PostgreSQL、Ozon、对象存储、店铺或生产部署状态；未来若这些系统产生副作用，必须使用各自的审计记录和专门恢复流程。

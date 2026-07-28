# 2026-07-28 保护性基线报告

## 起点

- 分支：`codex/baseline-stabilization`。
- 保护设计提交：`84861df`；`git merge-base --is-ancestor 84861df HEAD` 在报告编写前退出码为 `0`。
- 整理前状态：63 个已跟踪改动，313 个非忽略未跟踪实际文件。普通 `git status` 会折叠目录，因此状态条目数不等同于实际文件数。
- 本次分类保存的是计划启动前已经存在的大规模改动；分类过程没有以清理为名删除来源不明文件。
- 外部副作用：未执行真实 Ozon 写入、真实店铺同步、生产迁移、对象存储写入、生产部署或密钥变更；未启动应用服务、worker、Electron、Chrome 扩展或数据库。

## 分类提交

以下是报告提交前实际运行 `git log --reverse --oneline 84861df..HEAD` 的完整输出：

```text
483fb61 docs: plan protective baseline classification
87c5407 docs: exclude active sdd workspace from baseline
9f60438 docs: account for ignored sdd history
5fdf6d0 chore: preserve infrastructure baseline
7172ed1 fix: restore local development entrypoint
822040f fix: proxy local development websocket upgrades
c2504fc test: validate browser websocket proxy contract
46c19aa feat: preserve server safety baseline
9e0eda8 fix: enforce tenant and external write safety
21b697f fix: make tenant snapshot writes atomic
4fdfd49 feat: preserve web application baseline
eeb95d5 fix: restore web runtime contracts
333f953 fix: separate store deletion cleanup failures
84bf4be fix: preserve successor store binding
9cb8e04 feat: preserve browser extension baseline
a59ab53 fix: enforce extension security and pricing safety
5557c6d fix: close web bridge privilege bypass
e750c79 fix: verify seller identity from trusted context
bd50ec1 fix: replay pending fx observations safely
c9b3d5c fix: persist local pricing idempotency
3f44136 fix: enforce portal bridge message contracts
584b6ad fix: scope pending fx observations
a9c50e1 fix: serialize local pricing idempotency
85b2965 fix: close task 5 concurrency and routing gaps
5efbaca fix: fail closed on fx replay storage errors
ee87e7f feat: preserve desktop runtime baseline
f3dcea4 fix: contain desktop Excel file access
b9114bb fix: preserve desktop Excel export outcomes
54fa50c fix: encode desktop Excel task ownership
5b14700 test: preserve regression safety baseline
3d690d4 fix: close regression gate review gaps
f683e1f fix: keep environment blockers fail closed
8a3f2fa docs: preserve architecture and delivery baseline
e6bcdeb chore: redact personal information from extension source
7f5f907 chore: preserve generated runtime assets
```

文件类别对应关系如下；每个提交都归入其所在分组：

- 计划与边界：`483fb61`、`87c5407`、`9f60438`，记录分类计划、当前 SDD workspace 排除规则和既有 SDD 历史保留规则。
- 基础设施与本地入口：`5fdf6d0`、`7172ed1`、`822040f`、`c2504fc`，保存容器/workspace 配置、本地开发入口、WebSocket 转发及其回归 contract。
- 服务端与迁移：`46c19aa`、`9e0eda8`、`21b697f`，保存服务端基线，并修复租户归属、外部提交不确定性和原子 pricing snapshot 写入边界。
- Web：`4fdfd49`、`eeb95d5`、`333f953`、`84bf4be`，保存 Web 源码，并保护运行端口、门店删除结果、清理失败分离和继任门店绑定。
- 扩展及相关 pricing 安全 contract：`9cb8e04`、`a59ab53`、`5557c6d`、`e750c79`、`bd50ec1`、`c9b3d5c`、`3f44136`、`584b6ad`、`a9c50e1`、`85b2965`、`5efbaca`，保存扩展源码，并保护 portal bridge、seller identity、FX replay、pricing 幂等与本地持久化边界；其中必要的服务端 migration、adapter 与回归测试随安全 contract 同步提交。
- 桌面端：`ee87e7f`、`f3dcea4`、`b9114bb`、`54fa50c`，保存受控 Electron 运行资产，并保护 Excel 路径、导出结果和任务文件归属边界。
- 测试与门禁：`5b14700`、`3d690d4`、`f683e1f`，保存测试清单、根验证、安全门禁和 fail-closed 结果策略。
- 架构与交付文档：`8a3f2fa`，保存当前架构边界、历史计划/spec 和桌面交付说明。
- 生成产物、历史工作资产与脱敏：`e6bcdeb`、`7f5f907`，先修复当前源码/contract 中的个人信息与空白问题，再保存从源码生成的公开分发资产和计划启动前的历史工作记录。

## 文件分类

下表的“唯一路径数”来自每个 Task 最终提交范围的 `git diff --name-only <起点>..<终点>`。这些范围内可能同时包含基线提交和后续审查修复；它们不是互斥的全仓库分区，不应相加后冒充全仓库文件总数。

| 分类 | 最终范围 | 唯一路径数 | 路径边界 |
| --- | --- | ---: | --- |
| 基础设施 | `9f60438..c2504fc` | 12 | 根 workspace、Docker、README、本地开发入口及其 contract 检查 |
| 服务端与迁移 | `c2504fc..21b697f` | 64 | `server/` 生产模块、19 个 SQL migration 和聚焦安全回归 |
| Web | `21b697f..84bf4be` | 24 | `app/package.json`、Vite 配置、`app/src/` 及门店删除/运行 contract 测试 |
| 扩展及关联安全 contract | `84bf4be..5efbaca` | 48 | `extension/` 运行源码、安全测试，以及紧密关联的服务端 pricing contract |
| 桌面端 | `5efbaca..54fa50c` | 75 | `desktop/electron`、`desktop/dist`、`desktop/dist-electron`、构建资源及聚焦回归 |
| 测试与门禁 | `54fa50c..f683e1f` | 87 | app/server/extension/desktop 测试、test inventory、打包与根验证脚本 |
| 文档 | `f683e1f..8a3f2fa` | 15 | 架构、设计、历史 plans/specs 与桌面交付 Markdown |
| 生成产物、历史资产与脱敏 | `8a3f2fa..7f5f907` | 412 | 108 个 `app/public/` 路径、301 个历史 `.superpowers/` 路径、3 个源码/contract 脱敏修复路径 |

Task 9 的运行/历史资产提交本身包含 409 个路径（108 个 `app/public/`、301 个历史 `.superpowers/`），另一个脱敏提交包含 3 个路径。当前计划的 `.superpowers/sdd/2026-07-28-protective-baseline-classification/` 和忽略的 `app/dist/` 都是 `0` 个 tracked、`0` 个 staged 路径。

## 生成产物与运行资产

- 当前扩展源码树、`app/public/sonli-extension-0.13.46.1/` 解压副本、公开 ZIP 和忽略的 `app/dist` ZIP 均为 106 个文件。
- `app/public/sonli-extension-0.13.46.1.zip` SHA-256：`e79e186605d111e5694afefaf130c9ea6d6dee5a460c4ba00cb9a04c494a33f2`；忽略的 `app/dist/sonli-extension-0.13.46.1.zip` 摘要相同。
- 根验证使用显式 `QH_SOURCE_EXTENSION_DIR` 后，上游源码 contract、UI、diff contract、源码与公开解压副本、两份 ZIP parity 以及两份 ZIP bridge smoke 均通过。显式上游目录是 contract 参照，不要求其文件总数等于本地完整分发树。
- `app/public/plugin/popup.js` 是 `/plugin/popup.html` 使用的独立静态入口，不由扩展打包脚本覆盖。
- `desktop/dist` 与 `desktop/dist-electron` 当前缺少已确认的源码重建命令，且 Electron 入口直接依赖 `desktop/dist-electron/main.js`，因此继续作为受控运行资产；它们不能被当作普通、可随时删除重建的构建缓存。
- 当前 HEAD、扩展源码、公开副本、四份 ZIP 和纳入范围的历史文本扫描结果为 0 个已知敏感模式命中。旧提交 `5addb7602a0d0d8f5af00c4d103dddbe3872c891` 仍包含历史个人信息；本阶段没有重写 Git 历史。彻底清除需要单独授权破坏性历史重写，因此不能宣称敏感信息已从整个 Git 历史完全清除。

## 验证结果

根验证实际执行：

```text
QH_SOURCE_EXTENSION_DIR='/Users/songliang/Desktop/0.13.46.1' /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify.mjs
```

总体状态为 **FAIL（退出码 1）**：19 个检查中 18 个通过、1 个失败。唯一失败是完整 active suite；不得把缺少 `cheerio` 的环境阻塞描述为通过。

| 检查 | 状态 | 证据或原因 |
| --- | --- | --- |
| 根 `scripts/verify.mjs` | FAIL，退出码 1 | 汇总输出为 `1 verification check(s) failed.`；失败来自完整 active suite |
| App build：`vite build` | PASS，退出码 0 | Vite 6.4.2 转换 4820 modules 并完成构建；仅有单 chunk 大于 500 kB 的性能警告 |
| `scripts/check-extension-source-parity.mjs` | PASS，退出码 0 | 显式 upstream parity 通过；`extension/` 与公开解压副本 distribution parity 通过 |
| `scripts/check-extension-ui-parity.mjs` | PASS，退出码 0 | 与显式 upstream 的 UI parity 通过 |
| `scripts/check-extension-diff-contract.mjs` | PASS，退出码 0 | 与显式 upstream 的 diff contract 通过 |
| `scripts/check-extension-zip.mjs` | PASS，退出码 0 | public 与 ignored dist ZIP 均匹配扩展树，各 106 文件 |
| `scripts/check-extension-zip-smoke.mjs` | PASS，退出码 0 | public 与 dist 两份 ZIP 的 bridge follow-sell 和 dry-run route guard 均通过 |
| `node --check server/index.mjs` | PASS，退出码 0 | 服务端入口语法通过 |
| `scripts/check-test-inventory.mjs` | PASS，退出码 0 | `100 active, 13 historical/manual` |
| 完整 active suite：`node --test --test-concurrency=1 <activeTestFiles>` | FAIL，退出码 1 | 186 tests：185 passed、1 failed；唯一失败为 `desktop/tests/parse-modern-ozon.test.mjs`，首因是 `desktop/dist-electron/services/collection/ozon-list-parser.core.js` 导入不到 `cheerio`（`ERR_MODULE_NOT_FOUND`） |
| `docker compose config --quiet` | PASS，退出码 0 | 仅完成 Compose 配置插值；未启动容器 |
| `scripts/check-import-history-types.mjs` | PASS，退出码 0 | import history type filter 通过 |
| `scripts/check-plugin-readiness-gate.mjs` | PASS，退出码 0 | plugin readiness gate 通过 |
| `scripts/check-collect-edit-listing-contract.mjs` | PASS，退出码 0 | collect edit listing contract 通过 |
| `scripts/check-collect-delete-persistence.mjs` | PASS，退出码 0 | collect box delete persistence contract 通过 |
| `scripts/check-store-data-isolation.mjs` | PASS，退出码 0 | operating store data isolation contract 通过 |
| `node --check extension/content/jizhangerp-bridge.js` | PASS，退出码 0 | bridge 语法通过 |
| manifest JSON 解析 | PASS，退出码 0 | 输出 `manifest ok` |
| `git diff --check -- app/src app/tests server extension app/public` | PASS，退出码 0 | 目标运行/测试/公开资产范围无空白错误 |
| credential literal scan | PASS，实际 `rg` 退出码 1 | 退出码 1 表示无匹配，正是该门禁的预期状态；匹配时的退出码 0 会被 fail-closed 策略判为失败 |
| 分类范围与资产只读复核 | PASS，退出码 0 | 八类范围计数分别为 12、64、24、48、75、87、15、412；migration 为 19；public/dist ZIP SHA-256 相同 |

## 外部依赖与未验证范围

- React/Vite 依赖在本次根验证环境可用，App build 已通过；大 chunk 警告尚未作为失败门禁。
- 桌面端声明的 `cheerio` 当前无法从受控运行资产解析，导致唯一 active test 失败。未联网安装依赖，也未修改源码或清单来掩盖该结果。
- Docker CLI 与 Compose 插值可用；未启动 Docker engine 中的服务、PostgreSQL、MinIO 或任何容器。
- PostgreSQL：19 个 migration 已清点，但未在真实/一次性 PostgreSQL 上执行 migration、事务、advisory-lock 并发或回滚验证；六个 PostgreSQL integration 属于 historical/manual 清单，未运行。
- 本地 JSON pricing 幂等已覆盖同一 Node 进程内的文件级互斥，但多 Node 进程/多副本共享同一文件的操作系统级文件锁边界未实现、未验证。
- 浏览器：未运行七个 Playwright historical/manual 测试，未加载真实 Chrome 扩展，也未验证 reload、alarm、cookie、content-script 隔离世界或真实站点生命周期。
- 桌面端：未启动 Electron GUI，未验证真实 dialog、renderer IPC sender/origin、Windows 文件系统、打包/安装器或已安装依赖下的 parser。
- 外部系统：未调用 Ozon/Seller/1688 API，未进行真实店铺同步、上架、对象存储写入、生产数据读写、生产部署或凭据变更；其可用性和恢复流程未被本阶段证明。
- 权限：管理权限已有集中 matrix，路由也有认证、账号过滤和门店归属保护；但 `tenant.operate` 尚未在所有现有业务路由中普遍强制，不能把当前覆盖范围描述成统一后端授权完成。

## 回归风险

- 当前分支保存的是计划启动前已经存在的大规模改动，并在审查中补充了租户隔离、权限、幂等、外部写安全、浏览器 bridge、FX replay、门店删除、桌面采集生命周期、Excel 路径归属和根门禁等核心回归保护。
- 分类提交提升了可审查性、可追溯性和独立回退能力，但根验证仍为红色；缺少 `cheerio` 的桌面解析路径未通过 active suite，真实数据库、浏览器、Electron 和外部系统也未集成验证。
- 即使当前所有门禁将来全绿，也不可能保证以后任意改动绝不影响其他功能。自动测试只能证明已覆盖的输入、contract 和环境，不能证明未知路径不存在回归。
- 下一阶段每次改动仍必须先确认业务目标与影响面（页面、接口、数据、权限、配置、外部服务），再执行对应单元/集成/构建/回归验证，并预先说明可执行的回滚或数据恢复方法。
- 当前 HEAD 和资产已经脱敏，但 Git 历史仍保留旧个人信息；共享仓库、镜像或归档前应单独评估并授权历史重写，且需要协调所有使用者重新同步。

## 恢复方法

- 保留整个保护性基线时，以提交标题 `docs: record protective baseline verification` 对应的报告提交为锚点；该提交之后的任何功能改动都应建立在其上，并保留本报告记录的已知红项。
- 取消单个类别或修复时，先用 `git log --reverse --oneline 84861df..HEAD` 确认实际提交和依赖，再从最新相关提交开始按逆序执行 `git revert <commit-sha>`。不要使用 `git reset --hard`，不要通过重放外部请求恢复数据。
- 完整撤销的推荐类别逆序为：基线报告；生成产物/历史资产与脱敏；文档；测试门禁；桌面端；扩展及关联安全 contract；Web；服务端与迁移；基础设施。每一类内部也按日志逆序 revert。
- 回退 `e6bcdeb` 会把已脱敏内容重新带回当前 HEAD，不建议执行；如确需回退，必须先评估敏感数据影响。旧 Git 历史的彻底清理不是普通 `git revert` 能完成的，需要另行授权和协同历史重写。
- 本阶段没有执行外部写入，因此 Git revert 不需要、也不会自动恢复或重放 PostgreSQL、Ozon、对象存储、店铺或生产部署状态；未来若这些系统产生副作用，必须使用各自的审计记录和专门恢复流程。

# 选品与水印能力移除验证记录

日期：2026-07-30

分支：`codex/remove-selection-watermark`

功能分支起点：`37b01ce`

完整 hermetic `scripts/verify.mjs` 验证提交：`32611daa717c54761a973fe962e1c4365eaf4a13`

当前运行时、contract 与交付包聚焦验证提交：`e7d55e4e639874524500302146bcef896cfa74de`

提交边界说明：`32611da` 是下文“完整验证”的精确被测提交；其后的 `3d2aa98`、`1ec91ae` 与 `e7d55e4` 通过本记录列出的聚焦门禁验证。`a882627`、`5b89d60` 以及写入本记录/`design-qa.md`/整改报告的后续提交仅修改文档，不改变运行时、contract、public 解压树或 ZIP。本文不写入自身提交 SHA，避免形成无法成立的自指验证声明。

## 交付范围与提交

本次移除 Web、后端、浏览器扩展及扩展分发包中的选品和水印能力，同时保留商品、采集箱、店铺选择、AI 改图与 AI 商品套图。

| 提交 | 交付内容 |
| --- | --- |
| `43d2f8e` | 移除 Web 选品和水印页面、路由、菜单与状态 |
| `19afce7` | 恢复被误删的保留页面组件 |
| `ea9b72d` | 加强保留 Web 路由的可执行组件 contract |
| `bd53c9e` | 退役后端选品和水印接口，清理公开状态字段 |
| `4c9da24` | 移除扩展选品能力 |
| `c32b04a` | 删除最后一个选品 hook 引用 |
| `7592b19` | 移除扩展水印能力 |
| `3ac28ec` | 删除仍发送水印字段的扩展消息入口 |
| `c6f337e` | 在旧扩展消息边界剥离遗留水印字段 |
| `fa3748d` | 把 follow-sell 水印边界升级为真实处理器行为测试 |
| `4742764` | 将退役能力负向 contract 纳入扩展门禁 |
| `e77bc46` | 从已验证扩展源码重建分发目录与两个 ZIP |
| `18b4482` | 让 follow-sell 的 dry-run 在 portal 标志同时存在时仍只走预检 |
| `d2d68f2` | 用完整文件指纹锁定四个经审查的 UI 差异，并加入 mutation gate |
| `32611da` | 从整改后的扩展源码重建 public 解压树与两个 ZIP |
| `a882627` | 记录终审整改验证证据（仅文档） |
| `3d2aa98` | 证明四个本地 UI 文件的无关 mutation 会被精确拒绝 |
| `1ec91ae` | 从加强后的 UI parity contract 重建 public 解压树与两个 ZIP |
| `5b89d60` | 澄清本地 UI mutation 失败证据（仅文档） |
| `e7d55e4` | 修正数据面板职责注释、加入陈旧短语负向 contract，并重建 public 解压树与两个 ZIP |

变更后的稳定 contract：

- Web：四个退役 URL 进入通用 404 页面；菜单不再发布选品、水印或“推荐”标签；所有保留业务路由必须映射到已定义组件。
- 后端：退役接口使用通用 `404 LOCAL_NOT_FOUND`，不再有专用 handler；公开和活动状态不发布 `watermarkTemplateId`。
- 扩展：Manifest、弹窗、内容脚本、service worker、批量上架和店铺选择器不再提供选品/水印能力；旧消息中的水印字段在 follow-sell DTO 边界被丢弃；`dryRun` 优先于 `viaPortal`，组合标志也不会进入 portal 写管线。
- 分发：`app/public/sonli-extension-0.13.46.1/`、public ZIP 和 dist ZIP 与 104 个扩展源文件一致，打包后继续执行退役能力负向 contract。

## 聚焦测试

运行环境使用 Codex 内置 Node `v24.14.0`。

| 命令 | 精确结果 |
| --- | --- |
| `node --test app/tests/removed-selection-watermark-ui.test.mjs server/tests/removed-selection-watermark-routes.test.mjs extension/tests/ui-parity-exception-gate.test.js` | 6 tests；6 pass，0 fail，0 skip |
| `node extension/tests/removed-selection-watermark-contract.test.js` | 1 contract runner；退出 0，0 fail；该 runner 不输出 TAP 内部计数 |
| `node extension/background/__tests__/follow-sell-watermark-boundary.test.js` | 1 handler behavior runner；退出 0，输出 `followSell watermark boundary passed` |
| `node extension/background/__tests__/follow-sell-dry-run-route.test.js` | 1 route guard runner；退出 0，输出 `followSell dryRun route guard passed` |
| `node extension/tests/jizhangerp-bridge-follow-sell.test.js` | 1 bridge runner；退出 0，输出 `jizhangerp bridge follow-sell smoke passed` |
| `node extension/tests/follow-sell-content-copy.test.js` | 1 content-copy runner；退出 0，输出 `follow-sell content copy test passed` |
| `node extension/tests/portal-bridge-policy.test.js` | 1 portal-policy runner；退出 0，输出 `portal bridge policy tests passed` |

以上行为测试是 `32611da` 完整验证时的聚焦证据。`e7d55e4` 上又刷新执行以下门禁：

| 命令 | 精确结果 |
| --- | --- |
| `QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 node --test app/tests/removed-selection-watermark-ui.test.mjs server/tests/removed-selection-watermark-routes.test.mjs extension/tests/ui-parity-exception-gate.test.js` | 6 tests；6 pass，0 fail，0 skip |
| `node extension/tests/removed-selection-watermark-contract.test.js` | 退出 0；同时锁定 `ozon-data-panel.js` 不得再出现“选品模式”，并保留搜索页/其他页面的 `collect-one` 与 `jzRenderProductCardPanel` 入口 |
| `node extension/tests/collector-session.test.js` | 19 tests；19 pass，0 fail，0 skip |
| `node extension/tests/collector-removed.test.js` | 退出 0，输出 `collector removal and one-click collection guard passed` |
| `node extension/popup/__tests__/popup-collector-session.runtime.test.js` | 退出 0，输出 `popup Collector-session runtime passed` |
| `node scripts/check-extension-source-parity.mjs` | 退出 0；源码与 public 解压树 parity 通过 |
| `node scripts/check-extension-ui-parity.mjs` | 退出 0；UI parity 通过 |
| `node scripts/check-extension-diff-contract.mjs` | 退出 0；capture-only diff contract 通过 |
| `node scripts/check-extension-zip.mjs` | 退出 0；public/dist 两个 ZIP 各 104 文件，均与扩展源码一致 |
| `node scripts/check-extension-zip-smoke.mjs` | 退出 0；两份 ZIP 的 19/19 Collector session、7/7 capture-only 及 popup/bridge/dry-run/退役能力 runner 全部通过 |
| `node scripts/check-plugin-readiness-gate.mjs` | 退出 0；7/7 capture-only 与 3/3 Web plugin-surface tests 通过 |

本轮 negative contract 遵循 RED/GREEN：先加入 `ozon-data-panel.js` 的“选品模式”精确负向断言，runner 按预期失败于该断言；随后只修正职责注释，runner 转为退出 0。采集器与数据面板正向断言和上述相关测试均保留并通过。

机械重建后，public ZIP 与 dist ZIP 的 SHA-256 均为 `a933152eb008f0fa4e2af38f46dbfa71184fcfaf32f7f0ef316e146f6deffe27`；两个归档自身逐字节相同，ZIP parity 进一步逐文件确认两份归档、`extension/` 与 public 解压树中的 104 个文件内容一致。`app/dist/` 按仓库规则被忽略，public 解压树与 public ZIP 是本次提交的 tracked 派生物。

## 最终审查整改证据

- Finding 1 RED：在真实 `runFollowSellRequest` handler 上加入 `dryRun: true, viaPortal: true` 后，测试稳定失败于 `dryRun must not call the portal import pipeline`，实际 portal 调用 1 次、期望 0 次。
- Finding 1 GREEN：只把 `dryRun` 分支移动到 `viaPortal` 之前；组合消息不调用 portal，preview 精确调用 1 次，使用 120,000ms 超时，返回 preview 原响应；DTO 保留 store、items、stocks、AI 开关、`strictTypeMatch` 和两个路由标志，同时剥离 `_aiwDebug`、`applyWatermark`、`watermarkTemplateId`。
- Finding 2 RED：对 `batch-upload/index.html` 追加无关 HTML 注释后，旧 UI parity gate 仍退出 0，mutation 测试报出 `UI parity accepted an unrelated mutation`。
- Finding 2 GREEN：`batch-upload/index.html`、`batch-upload/index.js`、`content/ozon-product.css`、`content/ozon-search.css` 分别锁定完整上游文件与完整本地文件的 SHA-256 对；mutation 测试先要求未修改扩展树通过，再对四个文件逐一复制真实扩展树并追加无关注释，每次都必须精确因对应文件的 local full-file fingerprint 不匹配而失败，不能用 upstream 漂移或其他错误假阳性通过。`batch-upload/index.css`、`content/jzc-calc.css`、`lib/store-picker.css` 等未豁免 UI 文件继续做 exact equality。
- 指纹更新规则：未来的有意变更必须先审查该文件完整的 upstream/local diff，只更新该文件对应的一对完整文件哈希；单边漂移、顺手改动或新例外都默认失败，不能通过增加关键词或目录通配放行。

## `32611da` 的完整验证

使用计划指定的 hermetic 环境运行 `node scripts/verify.mjs`；`QH_LOCAL_NO_DOTENV=1`，外部源扩展目录固定为 `/Users/songliang/Desktop/0.13.46.1`，PostgreSQL、MinIO、加密密钥、管理员密码和 Web 端口均通过进程环境提供，秘密值未写入本文档。

结果：在 `32611daa717c54761a973fe962e1c4365eaf4a13` 上退出码 0，最终输出 `All verification checks passed.`。后续提交没有冒充为这次完整 suite 的被测提交；当前交付头 `e7d55e4` 的增量范围由上一节聚焦门禁覆盖。

- App production build：4,827 modules transformed，构建成功；仅保留已有的 chunk size warning。
- Test inventory：121 active test files，14 historical/manual。
- 完整 active test suite：327 tests；326 pass，0 fail，1 skip。
- 唯一 skip：`account-scoped collection PostgreSQL behavior`，因为未提供其要求的专用 PostgreSQL 测试 URL；这是计划允许的 generic integration skip。
- 扩展源、分发目录与 ZIP parity：通过；两个 ZIP 各包含 104 个文件。
- 两个 ZIP 的 packaged smoke：均通过；每个包的 Collector session TAP 为 19/19，capture-only TAP 为 7/7，popup、bridge、dry-run 与退役能力 runners 均退出 0。
- Plugin readiness：7/7 capture-only tests 与 3/3 Web plugin-surface tests 通过。
- Docker compose interpolation、导入历史、采集编辑、采集箱删除、门店数据隔离、语法、Manifest、whitespace、个人数据与凭据扫描：全部通过。

## 本地服务与 HTTP 回归

完成分支启动的本地进程保持运行：

| 服务 | 地址 / 进程 |
| --- | --- |
| 前端兼容代理 | `http://127.0.0.1:3000`，PID `80923` |
| API | `http://127.0.0.1:3001`，PID `80915` |
| Vite | `http://127.0.0.1:5173`，PID `80943` |
| listing worker | PID `80919`，启动标识 `local_80919_6881305f-e254-4e96-ba52-a97abf537364` |

应用复用主工作区已经运行且健康的本地 PostgreSQL（`127.0.0.1:5432`）和 MinIO（`127.0.0.1:9000/9001`），没有替换或删除其持久数据。首次无数据库配置的启动按设计被 worker 门禁拒绝，随后从主工作区的本地 `.env` 注入既有基础设施配置后成功启动。

| 请求 | 传输层结果 | 应用 contract |
| --- | --- | --- |
| `GET http://127.0.0.1:3000/` | 200 HTML | 仪表盘打开 |
| `GET http://127.0.0.1:3000/ozon/selection/category` | 200 Vite SPA shell | 浏览器标题为 `404: This page could not be found.`，快照显示 `404` |
| `GET http://127.0.0.1:3000/ozon/selection/top-list` | 200 Vite SPA shell | 同上，Web 404 页面 |
| `GET http://127.0.0.1:3000/ozon/selection/china` | 200 Vite SPA shell | 同上，Web 404 页面 |
| `GET http://127.0.0.1:3000/ozon/tools/watermark` | 200 Vite SPA shell | 同上，Web 404 页面 |
| `POST http://127.0.0.1:3001/ozon/selection/category-mapping` | 404 JSON | `code: LOCAL_NOT_FOUND` |
| `GET http://127.0.0.1:3001/ozon/watermark-settings` | 404 JSON | `code: LOCAL_NOT_FOUND` |
| `GET http://127.0.0.1:3001/health` | 200 JSON | `ok: true`，`persistence: postgres` |

前端开发服务器使用 history fallback，所以退役 URL 的 HTTP 传输层仍返回 SPA shell 200；真实浏览器渲染后的 404 标题和页面快照才是 Web 路由 contract。后端退役 API 则直接返回 HTTP 404。

## ego-browser 真实浏览器回归

在隔离任务空间 `14`、已登录的本地仪表盘中执行快照和导航验证：

- 菜单快照中精确不存在 `选品`、`类目分析`、`榜单选品`、`中国专区`、`水印管理`、`选品推荐`。
- 菜单文本精确存在 `AI 工具`，没有“推荐”标签。
- `/ozon/tools/ai-poster-records` 打开并显示 `AI 改图神器`，无 404。
- `/ozon/ai-image` 打开并显示 `AI 商品套图`，无 404。
- `/ozon/products/collect` 打开并显示采集箱、添加采集商品和商品信息，未发生 404。
- `/ozon/products/list` 打开并显示商品列表、库存管理和商品信息，未发生 404。
- 仪表盘的当前门店入口可以打开；浮层快照显示 `sl-主店`、`当前` 和 `管理店铺`。
- 四个退役 Web URL 逐一导航后，`pageInfo` 标题均为 `404: This page could not be found.`，页面快照均包含 `404`。

## 旧扩展兼容与残留审查

旧版本扩展可能继续发送 `applyWatermark` 或 `watermarkTemplateId`。当前扩展的 `follow-sell-request.js` 在 API、preview 和 portal 共用 DTO 边界显式删除这两个字段；行为测试实际执行普通 API、portal 和 `dryRun + viaPortal` 三种分支，并验证其他合法字段不受影响。后端状态归一化同样会删除历史 store 中的 `watermarkTemplateId`，避免旧数据重新进入活动和公开状态。

最终 residual scan 没有发现选品/水印页面、菜单、路由 handler、hook 或能力实现。精确扫描命中已逐条复核：

- `extension/background/follow-sell-request.js` 及其 public 分发副本：旧扩展消息的防御性字段剥离，不是水印能力。
- `server/index.mjs`：历史状态兼容迁移时的字段剥离，不是公开或写入 contract。
- `follow-sell-watermark-boundary.test.js`、`removed-selection-watermark-routes.test.mjs` 及 public 测试副本：负向/兼容行为测试。
- `docs/`、`.superpowers/` 与根 `design-qa.md`：设计历史、实现计划、验证记录和整改报告，不是活动能力；其中 `design-qa.md` 已在首行前置醒目历史标记。

`node scripts/check-personal-data.mjs`、`git diff --check` 和提交后的 `git status --short` 均通过；写入记录后再次执行相同扫描和 Git 卫生检查。

## 未验证范围

- 未把新 ZIP 手工安装到用户 Chrome，也未在真实 Ozon、1688 或其他外部平台触发采集、导入、上架和 AI 付费调用；原因是这些操作依赖用户浏览器扩展状态、外部登录和可能产生真实副作用。ZIP 内容、启动行为、路由和权限由打包 smoke 与 parity gate 覆盖。
- 未运行要求专用 disposable PostgreSQL URL 的 account-scoped collection integration case；完整验证明确记录 1 项 skip。其余使用 JSON 或 hermetic 基础设施的数据库 contract 均已执行。
- Test inventory 另有 14 个 historical/manual 文件：专用 PostgreSQL 破坏性集成用例和需要项目尚未纳入的 Playwright 运行时的浏览器用例；本轮没有改变这些既有排除范围。
- 浏览器回归覆盖本地桌面视口和当前登录数据，不替代所有浏览器版本、移动设备和无数据租户的视觉矩阵。

## 回滚与恢复

优先通过 Git revert 保留可追溯历史。以下过程把运行时/交付包验证头固定为 `e7d55e4e639874524500302146bcef896cfa74de`，完整覆盖 `37b01ce..e7d55e4` 的 21 个提交；`git rev-list --topo-order` 生成的顺序为真正的新到旧，单次 sequencer 失败时可完整 `--abort`。本记录自身以及同时更新 `design-qa.md`/整改报告的后续提交仅含文档，不在运行时恢复范围内，也不会被误称为已验证产品 SHA。

```bash
git status --short
git switch -c restore-selection-watermark e7d55e4e639874524500302146bcef896cfa74de
test "$(git rev-list --count e7d55e4e639874524500302146bcef896cfa74de ^37b01ce)" -eq 21
git revert --no-commit $(git rev-list --topo-order e7d55e4e639874524500302146bcef896cfa74de ^37b01ce)
git commit -m "revert: restore selection and watermark capabilities"
```

开始前 `git status --short` 必须无输出；出现冲突时先检查 `git status`，选择 `git revert --abort` 完整返回开始前状态，或在逐项确认业务 contract 后解决冲突并执行 `git revert --continue`。不要跳过提交，也不要用 `reset --hard`。

恢复扩展源码后必须重新打包，不能手改分发目录或 ZIP：

```bash
export QH_SOURCE_EXTENSION_DIR="/absolute/path/to/upstream-extension"
node scripts/package-extension.mjs
node scripts/check-extension-source-parity.mjs
node scripts/check-extension-zip.mjs
node scripts/check-extension-zip-smoke.mjs
node scripts/verify.mjs
```

若只需要恢复服务而不恢复能力，停止当前 `pnpm dev` 编排器后在同一完成分支、同一受控 `.env` 下重新启动；PostgreSQL/MinIO 数据不需要回滚。若 revert 后出现 contract 或数据兼容问题，保留当前数据库备份，停止外部写操作，并重新执行完整验证后再恢复对用户开放。

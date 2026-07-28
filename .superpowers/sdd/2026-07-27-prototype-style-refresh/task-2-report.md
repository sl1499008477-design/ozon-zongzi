# Task 2 — 应用外壳与页面层级改造报告

## 状态

完成（R1，本地可逆样式改造）。在 `main` 的既有脏工作区完成，未暂存、未提交、未推送，也未执行真实 Ozon 操作。

## 实现

- 已认证应用根布局改为 `className="qh-shell prototype-shell"`，登录页和数据大屏路径不受该 class 影响。
- 仪表盘标题保留既有标题、日期/同步行和“全部同步”动作；在标题前加入 `OZON SELLER WORKSPACE`，标题后加入规定的中文说明。
- 在样式表末尾新增 `Prototype shell overrides`，以 Task 1 令牌为基础实现浮动圆角侧栏、顶部操作区、内容偏移、菜单选中态、品牌、标题层级、日期行和操作控件的作用域覆盖。
- 没有修改路由、导航处理器、数据、接口、权限、配置、依赖或锁文件。

## 契约与测试

- 扩展 `app/tests/prototype-style-contract.test.mjs`：验证已认证 shell 标记、eyebrow 文案和五个必要的 CSS 选择器。
- RED：`PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node --test app/tests/prototype-style-contract.test.mjs`
  - 结果：既有 token 契约 2/2 通过；新增 shell 契约 2/2 按预期失败（缺少 `prototype-shell`、eyebrow 和样式选择器）。
- GREEN：相同命令
  - 结果：4/4 通过，0 失败。
- 构建：`PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" pnpm --dir app build`
  - 结果：通过。Vite 仅报告既有的产物体积警告（主 JS gzip 后约 497 kB），不是本次改动引入的构建错误。
- 格式检查：`git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs`
  - 结果：通过（无输出）。

## 文件与契约

- `app/src/App.jsx`：认证壳 class 和仪表盘页面层级标记。
- `app/src/styles.css`：最终的 scoped `Prototype shell overrides`。
- `app/tests/prototype-style-contract.test.mjs`：静态 shell 契约。
- `.superpowers/sdd/2026-07-27-prototype-style-refresh/task-2-report.md`：本交接报告。

## 自审与回归

- 所有新选择器均由 `.prototype-shell`（或其新增的专用元素 class）约束；没有更改现有点击目标、DOM 交互语义或事件处理器。
- 只修改了任务简报允许的应用、样式和契约测试文件，另按要求写入本报告；保留了工作区内的既有用户改动。
- 回归覆盖为：样式令牌/主题映射静态契约、shell 静态契约和生产构建。

## 未验证范围、风险与恢复

- 未进行浏览器人工视觉回归或逐断点响应式检查；本次任务的指定验证只有契约与构建。尤其窄屏下最终 scoped shell 覆盖会优先于旧的通用响应式规则，建议后续任务在目标视口中做视觉验收并按批准范围补充响应式覆盖。
- 回滚方式：移除 `App.jsx` 中新增的 shell/heading class 与文案，并删除 `styles.css` 的 `Prototype shell overrides` 区段及对应两项静态契约；不涉及数据恢复或外部副作用。

## Fix round 1 — 窄屏 shell 断点修复

### 审查结论与实现

- 复核确认 P1 成立：末尾 `.prototype-shell` 覆盖层的选择器特异性高于原有通用 1180/800/600px 断点，导致内容和顶栏仍保留桌面 `292px` 左偏移。
- 在 `Prototype shell overrides` 末尾添加相同作用域的 1180/800/600px media 规则：
  - `<=1180px`：将侧栏压缩为 64px，隐藏品牌，顶栏和内容从 `112px` 起始（24px 左边距 + 64px 侧栏 + 24px 间隙），并移除侧栏为品牌保留的顶部空间。
  - `<=800px`：缩紧顶栏、内容内边距，并将标题字号恢复至 24px。
  - `<=600px`：侧栏隐藏后，将顶栏恢复为左右 12px inset、内容左距归零，使用完整可用宽度。
- 未改动已记录为 Minor 的桌面几何；未变更 `App.jsx`、交互、路由、数据、接口、权限、配置、依赖或锁文件。

### 覆盖测试、RED/GREEN 与验证

- 覆盖测试文件：`app/tests/prototype-style-contract.test.mjs`。
- 新增契约 `keeps the scoped prototype shell usable at narrow breakpoints`，从最终 `Prototype shell overrides` 区段中提取各 media block，验证 1180px 顶栏/内容、800px 内容/标题和 600px 顶栏/内容的 scoped 规则与关键声明。提取 block 而非依赖同一 media 内的规则排序，避免把无关 CSS 排序作为行为契约。
- RED 命令：`PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node --test app/tests/prototype-style-contract.test.mjs`
  - 输出：`pass 4`、`fail 1`；新断点契约按预期因缺少 `@media (max-width: 1180px)` 的 scoped 顶栏规则失败。
- GREEN 命令：`PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node --test app/tests/prototype-style-contract.test.mjs`
  - 输出：`pass 5`、`fail 0`。
- 构建命令：`PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" pnpm --dir app build`
  - 输出：通过；仅有既有的 Vite 大 chunk 提示，未出现构建错误。
- 空白错误检查：`git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs`
  - 输出：通过（无输出）。

### 自审、未验证范围与恢复

- 所有新增响应式规则都在 `.prototype-shell` 作用域内，且在最终覆盖区之后定义，因此能确定地覆盖先前通用断点，同时不影响登录页或数据大屏。
- 未做浏览器人工断点截图/交互回归；静态契约和构建证明规则存在与可编译，视觉间距仍应在后续批准的视觉验收中复查。
- 回滚方式：删除本节对应的三组 scoped `@media` 规则和该窄屏静态契约；不涉及数据或外部副作用恢复。

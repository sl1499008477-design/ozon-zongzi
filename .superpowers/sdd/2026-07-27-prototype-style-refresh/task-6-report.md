# Task 6 Mobile Navigation and Responsive Safeguards Report

## 范围与边界

- 工作包：`docs/superpowers/plans/2026-07-27-prototype-style-refresh.md` 的 Task 6。
- 风险：R1（本地、可逆的应用壳层 JSX、CSS 与静态契约改动）；实施前快照位于 `task-6-before/`。
- 修改文件：`app/src/App.jsx`、`app/src/styles.css`、`app/tests/prototype-style-contract.test.mjs`。
- 未修改：`menuItems`、`navigate` 的既有逻辑、路由语义、数据/API、权限、配置、依赖、锁文件以及任何 Ozon 外部操作。

## TDD 契约

- RED：新增 `provides an accessible mobile navigation drawer with contained overflow`；使用项目 Node runtime 运行后，13/14 通过、1/14 失败，失败原因为缺失移动导航触发器。
- GREEN：最小实现状态、触发器、Drawer 与末尾 scoped 响应式覆盖后，完整静态契约为 14/14 通过。
- 该契约保护：`aria-label="打开导航"`、触发器打开状态、`MenuOutlined`、Drawer 的 `prototype-mobile-nav`/`prototype-overlay`、关闭回调、共享的 selected/open 菜单状态、菜单点击先关闭再调用原有 `navigate(key)`，以及 1180/800/600px 的关键 CSS 行为。
- 旧的 Task 2 移动 content 内边距断言同步更新为本任务已批准的 `92px 12px 32px`。

## 实现结果

- `AppShell` 增加 `mobileNavOpen`，并在顶栏增加仅小屏显示的无障碍菜单按钮。
- 新增左侧 288px Drawer，继续消费同一份 `menuItems`、`route`、`openKeys`、`setOpenKeys` 和 `navigate`；关闭抽屉不改变路由，菜单点击关闭后保留原有导航行为。
- 最终 prototype 覆盖层中：
  - 1180px：侧栏收窄为 76px、隐藏标签和子菜单箭头，同时维持 Task 2 的 112px 内容/顶栏偏移，避免增加空白带。
  - 800px：查询、筛选、库存、AI、利润和算价的多列 grid 降为一列。
  - 600px：隐藏桌面侧栏；顶栏和内容采用紧凑 inset/padding；菜单按钮以绝对定位显示，避免挤压原顶栏操作；表格容器自身横向滚动；shell 使用 `overflow-x: clip` 阻止页面级横向溢出。

## 验证与回归

- `PATH=/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH node --test app/tests/prototype-style-contract.test.mjs`：14/14 通过。
- `PATH=/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm --dir app build`：成功，4803 个模块完成转换。仅有 Vite 对大于 500 kB chunk 的既有非阻断提示。
- `git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs`：无输出、成功。

## 未验证、风险与回滚

- 未验证：未启动浏览器执行 1440/1280/390px 的人工视觉和真实点击冒烟；Task 7 应覆盖 Drawer 手势/遮罩关闭、菜单点击、顶栏密度和表格滚动。
- 风险：页面级 `overflow-x: clip` 会限制任何意外的壳层横向布局；复杂业务表格已明确在 `.source-table-wrap` 内滚动。需要在后续视觉 QA 确认非表格超宽内容没有被截断。
- 回滚：删除本任务新增的 `mobileNavOpen`、顶栏按钮、移动 Drawer、最终 prototype 响应式覆盖及该静态契约；无需迁移、数据恢复或外部补偿。

## Fix Round 1 / 5

### Addressed

- 视口切换：增加 `window.matchMedia("(max-width: 600px)")` effect；离开移动宽度时仅执行 `setMobileNavOpen(false)`，不改变 route、openKeys 或 `navigate`。`change` listener 在 cleanup 中移除。
- 算价响应式：在已有 ≤800px scoped 单列块中增加 `.pricing-default-grid`、`.pricing-domestic-list > div` 和 `.pricing-simulation-result`。
- Drawer 表面：保留 `prototype-mobile-nav` class，并新增 `.prototype-overlay .prototype-mobile-nav` 下的 drawer body、menu、menu item/submenu 和 selected-item token 化样式。
- 契约：扩展移动导航测试，精确保护 `matchMedia`、离开移动宽度的关闭逻辑、listener 注册/清理、三个算价 grid 与 scoped Drawer body selector。

### Verification and open work

- RED：扩展契约后 13/14 通过、1/14 失败；首个失败为缺失 `window.matchMedia("(max-width: 600px)")`。
- GREEN：`node --test app/tests/prototype-style-contract.test.mjs` 为 14/14 通过；`pnpm --dir app build` 成功（仅 Vite 大 chunk 非阻断提示）；限定 `git diff --check` 无输出且成功。
- 未验证：本轮未进行浏览器 QA。Task 7 应在 390px 打开 Drawer，然后 resize 至桌面宽度确认自动关闭；并验证遮罩/关闭按钮、菜单点击导航以及三个算价区域的单列布局。

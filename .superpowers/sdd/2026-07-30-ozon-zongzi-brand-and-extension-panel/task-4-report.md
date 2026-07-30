# Task 4 — 数据面板主界面还原报告

## 结果

已按插件原型重构数据面板主界面；字段设置弹窗不在本任务范围内，未改动。

## RED / GREEN

- RED：新增 `extension/tests/data-panel-visual-contract.test.js` 后，在恢复旧标题渲染的状态下执行测试，失败为 `panel should render the brand mark`（期望 1，实际 0）。
- GREEN：实现共享品牌标题和图片加载失败回退后，测试通过。测试在隔离 VM 中执行真实 `jzRenderProductPanelV2`，断言实际渲染的品牌标题、状态、Logo、既有 `data-field`、既有 `data-action` 与错误事件回退，不使用源码文本 grep。

## Files

- `extension/content/shared-utils.js`
- `extension/content/ozon-product.css`
- `extension/tests/data-panel-visual-contract.test.js`
- `scripts/check-extension-source-parity.mjs`
- `scripts/check-extension-ui-parity.mjs`
- `app/public/sonli-extension-0.13.46.1/` 与 `app/public/sonli-extension-0.13.46.1.zip`（同步发布树和 ZIP）

## 保持的真实字段与逻辑

- `jzRenderProductPanelV2`、`jzPopulatePanelV2`、字段显隐 localStorage、月/周周期、采集、复制、跟卖、编辑上架及原有 DOM `data-field` / `data-action` contract 未改。
- 仅让骨架、通用商品卡和 V2 面板复用同一展示标题；不引入原型中的模拟字段，不改同步、采集、权限或数据来源。
- 使用既有 `__JZ_BRAND__.logoUrl` 指向的正式 symbol 资产；加载失败时隐藏图片并显示可读首字回退。

## Parity 与发布

- 已完整审阅 `/Users/songliang/Desktop/0.13.46.1/content/ozon-product.css` 与本地 CSS 的差异；本任务仅新增面板视觉层差异，并更新 `content/ozon-product.css` 的审阅 fingerprint。
- 新增视觉行为测试已加入 source parity local-only allowlist；发布目录与两个 ZIP 均与 `extension/` 一致。
- `QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1` 下 source parity、UI parity 与 UI fingerprint mutation gate 均通过。

## 验证

- `data-panel-visual-contract.test.js`
- `data-panel-logistics.test.js`
- `data-card-copy-button.test.js`
- `sidebar-section-toggle.test.js`
- `brand-contract.test.js`
- `brand-fallback-runtime.test.js`
- `manifest-security-contract.test.js`
- `check-extension-source-parity.mjs`
- `check-extension-ui-parity.mjs`
- `check-extension-zip.mjs`
- `check-extension-zip-smoke.mjs`
- `git diff --check`

全部通过。

## 未验证范围、风险与回滚

- 未在已登录的真实 Ozon 商品页手动截图验收；自动化验证覆盖渲染、字段、交互 contract、品牌和发布包。真实宿主 CSS 叠加或极端窄侧栏的视觉微调仍需浏览器验收。
- 回滚方式：回滚本任务 commit；数据、字段显隐存储、账号和采集状态不需要迁移或清理。

## Commit

`3bf35b7865dfe830f5dc112b21da3903b8fbc7a9` — `feat: match extension data panel prototype`。

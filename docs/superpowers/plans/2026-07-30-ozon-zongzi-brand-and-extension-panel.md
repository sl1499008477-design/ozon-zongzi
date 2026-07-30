# 「ozon 粽子」品牌与插件数据面板还原 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Web 与浏览器扩展的用户可见品牌统一为「ozon 粽子」，并在不改变现有数据 contract 的前提下，把 Ozon 页面数据面板和字段设置弹窗还原为指定原型样式。

**Architecture:** 用一个只承载用户可见信息的品牌 contract 统一 Web 展示，并把用户提供的 SVG 资产复制为仓库内的唯一品牌源；扩展继续沿用现有 `__JZ_BRAND__`、`jzRenderProductPanelV2`、`jzPopulatePanelV2` 和字段显隐存储 contract，只调整默认品牌值、DOM 结构和命名空间 CSS。面板设置仍写入 `dataCardFieldVisibility` 和 `dataCardSalesPeriod`，不新增第二份状态。

**Tech Stack:** React 19、Ant Design 6、Chrome Manifest V3、原生 JavaScript/CSS、Node.js 测试、Sharp SVG/PNG 处理、Vite。

## Global Constraints

- 用户可见产品名称必须为 `ozon 粽子`。
- 品牌蓝必须使用 `#1268FF`，深海军蓝必须使用 `#10234A`。
- 只能使用 `/Users/songliang/Documents/粽子开发前分析/brand-assets/ozon-zongzi-logo/` 提供的真实 SVG 品牌资产，不重新绘制 Logo。
- 原型只作为视觉基准；不得把原型中的模拟 35 项字段复制进生产逻辑。
- 必须保留现有真实字段、数据请求、采集、算价、登录、账号隔离和数据边界。
- 必须保留现有存储键、协议、环境变量、数据库标识和历史兼容下载路径。
- 不得新增数据库迁移、后端 API 或真实外部副作用。
- 设置弹窗字段总数必须从当前真实字段动态计算。
- 数据不存在时必须显示「暂无数据」，不得伪造数据。
- 视觉交付必须生成根目录 `design-qa.md`，并在相同视口、相同状态下通过原型与实现截图对比。

## Approved Test Resolution

用户在执行前确认：本计划示例中仅通过搜索源码文字来判断成功的断言，必须替换为运行真实模块、渲染真实 DOM、读取真实 manifest/资产结果或执行真实交互的行为级测试。测试仍需遵守每个任务的 RED→GREEN 顺序，并覆盖相同的品牌、面板、设置、兼容与回归验收目标；不得用新的源码文字检查替代行为验证。

---

## File Structure

### New files

- `brand-assets/ozon-zongzi/README.md` — 记录仓库内品牌资产来源、用途和不可修改约束。
- `brand-assets/ozon-zongzi/ozon-zongzi-logo-primary.svg` — 浅色界面的标准横版 Logo 原件。
- `brand-assets/ozon-zongzi/ozon-zongzi-logo-dark.svg` — 深色界面的横版 Logo 原件。
- `brand-assets/ozon-zongzi/ozon-zongzi-logo-white.svg` — 反白 Logo 原件。
- `brand-assets/ozon-zongzi/ozon-zongzi-logo-mono.svg` — 单色 Logo 原件。
- `brand-assets/ozon-zongzi/ozon-zongzi-symbol.svg` — 方形图标的品牌图形原件。
- `scripts/generate-brand-assets.mjs` — 从仓库内 SVG 原件复制 Web 资产并生成 Chrome PNG 图标。
- `app/src/brand.js` — Web 用户可见品牌 contract。
- `app/tests/brand-contract.test.mjs` — 品牌配置、资产和兼容边界测试。
- `app/tests/brand-ui-contract.test.mjs` — Web 主要用户可见品牌位置测试。
- `extension/tests/brand-contract.test.js` — manifest、弹窗和扩展默认品牌测试。
- `extension/tests/data-panel-visual-contract.test.js` — 数据面板和设置弹窗 DOM/CSS contract 测试。
- `design-qa.md` — 原型与实现的视觉对比报告。
- `docs/superpowers/verification/assets/ozon-zongzi-reference-panel.png` — 原型数据面板截图。
- `docs/superpowers/verification/assets/ozon-zongzi-reference-settings.png` — 原型设置弹窗截图。
- `docs/superpowers/verification/assets/ozon-zongzi-implementation-panel.png` — 实现数据面板截图。
- `docs/superpowers/verification/assets/ozon-zongzi-implementation-settings.png` — 实现设置弹窗截图。

### Modified files

- `app/AGENTS.md` — 记录“只还原视觉、不复制模拟字段”的已确认产品决定。
- `app/index.html` — 页面标题改用「ozon 粽子」。
- `app/src/App.jsx` — Web 顶部品牌、登录品牌和插件下载页使用品牌 contract。
- `app/src/DataScreenPage.jsx` — 数据大屏品牌名称与 Logo。
- `app/src/styles.css` — 横版 Logo 尺寸、安全留白和响应式适配。
- `extension/manifest.json` — 扩展名称、描述、默认标题和新图标路径。
- `extension/popup/popup.html` — 弹窗标题、Logo、可见品牌文案。
- `extension/popup/popup.js` — 默认品牌 fallback 改为「ozon 粽子」。
- `extension/popup/popup.css` — 新横版 Logo 的尺寸与布局适配。
- `extension/background/service-worker.js` — 默认 `__JZ_BRAND__` 展示值和图标 URL。
- `extension/content/shared-utils.js` — 默认品牌、原型风格面板结构、动态设置概览和设置动作。
- `extension/content/ozon-premium-hook.js` — 用户可见默认品牌 fallback。
- `extension/content/jzc-calc.js` — 用户可见默认品牌与产品名 fallback。
- `extension/content/ozon-product.css` — 数据面板和设置弹窗的原型视觉样式。
- `extension/popup/__tests__/popup-routing.smoke.test.js` — 新产品名称断言。
- `extension/tests/manifest-security-contract.test.js` — 新 manifest 品牌断言并保留权限 contract。
- `scripts/check-extension-source-parity.mjs` — 新品牌断言和新增品牌资产 allowlist。
- `scripts/check-extension-diff-contract.mjs` — 新品牌断言和新增品牌资产 reviewed surface。
- `scripts/check-extension-ui-parity.mjs` — 新图标、Logo 和面板 CSS 的 reviewed fingerprint。
- `scripts/package-extension.mjs` — 继续保留 `sonli-extension-*` 兼容文件名，只更新用户可见日志或测试需要的品牌展示。
- `app/public/sonli-extension-0.13.46.1/**` 与对应 ZIP — 由打包脚本机械生成，必须和 `extension/` 逐文件一致。

## Stable Interfaces

### Web brand contract

```js
export const PRODUCT_BRAND = Object.freeze({
  displayName: "ozon 粽子",
  productName: "ozon 粽子",
  primaryColor: "#1268FF",
  navyColor: "#10234A",
  logoPrimaryUrl: "/brand/ozon-zongzi-logo-primary.svg",
  symbolUrl: "/brand/ozon-zongzi-symbol.svg",
});
```

### Extension brand contract

现有 `globalThis.__JZ_BRAND__` 形状保持不变：

```js
{
  code: "sonli",
  displayName: "ozon 粽子",
  productName: "ozon 粽子",
  primaryColor: "#1268FF",
  apiHost: "127.0.0.1:3000/api",
  webHost: "127.0.0.1:3000",
  logoUrl: chrome.runtime.getURL("icons/ozon-zongzi-symbol.svg"),
}
```

`code` 必须继续为 `sonli`，因为它参与更新路由和历史兼容；只修改用户可见字段。

### Field settings helpers

```js
window.jzGroupDataCardFields(fields)
// -> Array<{ name: string, fields: Array<{ field, label, group }> }>

window.jzCountVisibleDataCardFields(fields, visibilityMap)
// -> { visible: number, total: number }
```

这两个函数是纯计算 helper，不读取 DOM、不写 storage，供设置弹窗和测试共同使用。

---

### Task 1: 建立可复现品牌资产与 Web 品牌 contract

**Files:**
- Create: `brand-assets/ozon-zongzi/README.md`
- Create: `brand-assets/ozon-zongzi/*.svg`
- Create: `scripts/generate-brand-assets.mjs`
- Create: `app/src/brand.js`
- Create: `app/tests/brand-contract.test.mjs`
- Modify: `app/AGENTS.md`
- Generate: `app/public/brand/*.svg`
- Generate: `extension/icons/ozon-zongzi-*.svg`
- Generate: `app/public/icons/icon16.png`
- Generate: `app/public/icons/icon48.png`
- Generate: `app/public/icons/icon128.png`
- Generate: `extension/icons/icon16.png`
- Generate: `extension/icons/icon48.png`
- Generate: `extension/icons/icon128.png`

**Interfaces:**
- Consumes: 用户提供的五个 SVG 原件。
- Produces: `PRODUCT_BRAND`、仓库内 SVG 原件、Web SVG 资产和 Chrome PNG 图标。

- [ ] **Step 1: 把品牌决定写入项目规则**

在 `app/AGENTS.md` 追加：

```md
## ozon 粽子品牌与插件原型决定

- 用户可见品牌统一为「ozon 粽子」。
- 插件数据面板和设置弹窗以指定 `#/plugin` 原型为视觉基准。
- 只还原视觉和布局，继续使用当前真实字段、数据来源与持久化 contract。
- 不得把原型中的模拟 35 项字段复制到生产逻辑。
```

- [ ] **Step 2: 写失败的品牌 contract 测试**

创建 `app/tests/brand-contract.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { PRODUCT_BRAND } from "../src/brand.js";

test("product brand exposes the approved display contract", () => {
  assert.deepEqual(PRODUCT_BRAND, {
    displayName: "ozon 粽子",
    productName: "ozon 粽子",
    primaryColor: "#1268FF",
    navyColor: "#10234A",
    logoPrimaryUrl: "/brand/ozon-zongzi-logo-primary.svg",
    symbolUrl: "/brand/ozon-zongzi-symbol.svg",
  });
});

test("generated Web and extension assets exist", async () => {
  for (const relative of [
    "app/public/brand/ozon-zongzi-logo-primary.svg",
    "app/public/brand/ozon-zongzi-symbol.svg",
    "app/public/icons/icon16.png",
    "app/public/icons/icon48.png",
    "app/public/icons/icon128.png",
    "extension/icons/ozon-zongzi-logo-primary.svg",
    "extension/icons/ozon-zongzi-symbol.svg",
    "extension/icons/icon16.png",
    "extension/icons/icon48.png",
    "extension/icons/icon128.png",
  ]) await access(path.resolve(relative));
});

test("brand source records the supplied asset origin", async () => {
  const readme = await readFile("brand-assets/ozon-zongzi/README.md", "utf8");
  assert.match(readme, /粽子开发前分析\/brand-assets\/ozon-zongzi-logo/);
  assert.match(readme, /不得重新绘制/);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
node --test app/tests/brand-contract.test.mjs
```

Expected: FAIL，提示 `app/src/brand.js` 或品牌资产不存在。

- [ ] **Step 4: 复制原始 SVG 并实现生成脚本**

将用户提供的五个 SVG 原样复制到 `brand-assets/ozon-zongzi/`，创建 `scripts/generate-brand-assets.mjs`：

```js
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const source = path.resolve("brand-assets/ozon-zongzi");
const webBrand = path.resolve("app/public/brand");
const webIcons = path.resolve("app/public/icons");
const extensionIcons = path.resolve("extension/icons");

await Promise.all([webBrand, webIcons, extensionIcons].map((dir) => mkdir(dir, { recursive: true })));

for (const file of [
  "ozon-zongzi-logo-primary.svg",
  "ozon-zongzi-logo-dark.svg",
  "ozon-zongzi-logo-white.svg",
  "ozon-zongzi-logo-mono.svg",
  "ozon-zongzi-symbol.svg",
]) {
  await cp(path.join(source, file), path.join(webBrand, file));
  await cp(path.join(source, file), path.join(extensionIcons, file));
}

for (const size of [16, 48, 128]) {
  const input = path.join(source, "ozon-zongzi-symbol.svg");
  await sharp(input)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(extensionIcons, `icon${size}.png`));
  await cp(path.join(extensionIcons, `icon${size}.png`), path.join(webIcons, `icon${size}.png`));
}
```

创建 `app/src/brand.js`，内容必须与 Stable Interfaces 中的 `PRODUCT_BRAND` 完全一致。

- [ ] **Step 5: 生成并验证资产**

Run:

```bash
node scripts/generate-brand-assets.mjs
node --test app/tests/brand-contract.test.mjs
```

Expected: 两个命令退出 0，品牌 contract 和资产测试 PASS。

- [ ] **Step 6: 提交**

```bash
git add app/AGENTS.md brand-assets/ozon-zongzi scripts/generate-brand-assets.mjs app/src/brand.js app/tests/brand-contract.test.mjs app/public/brand app/public/icons extension/icons
git commit -m "feat: add ozon zongzi brand assets"
```

---

### Task 2: 替换 Web 用户可见品牌

**Files:**
- Create: `app/tests/brand-ui-contract.test.mjs`
- Modify: `app/index.html`
- Modify: `app/src/App.jsx`
- Modify: `app/src/DataScreenPage.jsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: Task 1 的 `PRODUCT_BRAND` 和 Web 品牌 SVG。
- Produces: Web 页面标题、登录页、顶栏、数据大屏和插件页统一品牌展示。

- [ ] **Step 1: 写失败的 Web 品牌测试**

创建 `app/tests/brand-ui-contract.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, app, screen] = await Promise.all([
  readFile("app/index.html", "utf8"),
  readFile("app/src/App.jsx", "utf8"),
  readFile("app/src/DataScreenPage.jsx", "utf8"),
]);

test("document titles use ozon 粽子", () => {
  assert.match(html, /ozon 粽子/);
  assert.doesNotMatch(html, /<title>sonli<\/title>/);
});

test("primary Web brand surfaces consume PRODUCT_BRAND", () => {
  assert.match(app, /import \{ PRODUCT_BRAND \} from "\.\/brand\.js"/);
  assert.match(app, /PRODUCT_BRAND\.logoPrimaryUrl/);
  assert.match(app, /PRODUCT_BRAND\.displayName/);
  assert.match(screen, /PRODUCT_BRAND\.displayName/);
  assert.match(screen, /PRODUCT_BRAND\.logoPrimaryUrl/);
});

test("technical compatibility paths remain unchanged", () => {
  assert.match(app, /sonli-extension-\{EXTENSION_VERSION\}\.zip/);
  assert.match(app, /\/Users\/songliang\/Documents\/sonli ozon3\.0\/extension/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node --test app/tests/brand-ui-contract.test.mjs
```

Expected: FAIL，主界面仍使用旧品牌或未导入 `PRODUCT_BRAND`。

- [ ] **Step 3: 最小替换 Web 品牌**

在 `App.jsx` 和 `DataScreenPage.jsx` 导入：

```js
import { PRODUCT_BRAND } from "./brand.js";
```

品牌组件使用横版 Logo：

```jsx
<img src={PRODUCT_BRAND.logoPrimaryUrl} alt={PRODUCT_BRAND.displayName} />
```

产品名称使用：

```jsx
{PRODUCT_BRAND.displayName}
```

`app/index.html` 标题改为：

```html
<title>ozon 粽子</title>
<script>
  document.title = location.pathname.replace(/\/+$/, "") === "/datascreen"
    ? "ozon 粽子 · 订单数据大屏"
    : "ozon 粽子";
</script>
```

保留现有 `.sonli-login-*` CSS 类名，只调整图片槽：

```css
.qh-brand img,
.sonli-login-brand img,
.datascreen-brandline img {
  width: auto;
  max-width: 156px;
  height: 32px;
  object-fit: contain;
}
```

- [ ] **Step 4: 运行定向测试和构建**

Run:

```bash
node --test app/tests/brand-contract.test.mjs app/tests/brand-ui-contract.test.mjs
pnpm --dir app build
```

Expected: 品牌测试 PASS，Vite 构建退出 0。

- [ ] **Step 5: 提交**

```bash
git add app/index.html app/src/App.jsx app/src/DataScreenPage.jsx app/src/styles.css app/tests/brand-ui-contract.test.mjs
git commit -m "feat: rebrand Web UI as ozon zongzi"
```

---

### Task 3: 替换扩展 manifest、弹窗与默认品牌

**Files:**
- Create: `extension/tests/brand-contract.test.js`
- Modify: `extension/manifest.json`
- Modify: `extension/popup/popup.html`
- Modify: `extension/popup/popup.js`
- Modify: `extension/popup/popup.css`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/content/shared-utils.js`
- Modify: `extension/content/ozon-premium-hook.js`
- Modify: `extension/content/jzc-calc.js`
- Modify: `extension/popup/__tests__/popup-routing.smoke.test.js`
- Modify: `extension/tests/manifest-security-contract.test.js`
- Modify: `scripts/check-extension-source-parity.mjs`
- Modify: `scripts/check-extension-diff-contract.mjs`
- Modify: `scripts/check-extension-ui-parity.mjs`

**Interfaces:**
- Consumes: Task 1 的扩展 SVG/PNG 资产和现有 `__JZ_BRAND__` shape。
- Produces: Chrome 管理页、弹窗和注入组件的默认用户可见品牌。

- [ ] **Step 1: 写失败的扩展品牌测试**

创建 `extension/tests/brand-contract.test.js`：

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");

const manifest = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
const popupHtml = fs.readFileSync("extension/popup/popup.html", "utf8");
const popupJs = fs.readFileSync("extension/popup/popup.js", "utf8");
const shared = fs.readFileSync("extension/content/shared-utils.js", "utf8");
const worker = fs.readFileSync("extension/background/service-worker.js", "utf8");

assert.equal(manifest.name, "ozon 粽子");
assert.equal(manifest.description, "ozon 粽子 · Ozon 选品采集与运营助手");
assert.equal(manifest.action.default_title, "ozon 粽子");
assert.match(popupHtml, /ozon-zongzi-logo-primary\.svg/);
assert.match(popupHtml, /ozon 粽子/);
assert.match(popupJs, /"ozon 粽子"/);
for (const source of [shared, worker]) {
  assert.match(source, /"displayName":"ozon 粽子"/);
  assert.match(source, /"productName":"ozon 粽子"/);
  assert.match(source, /"primaryColor":"#1268FF"/);
  assert.match(source, /icons\/ozon-zongzi-symbol\.svg/);
  assert.match(source, /"code":"sonli"/);
}
console.log("ozon zongzi extension brand contract passed");
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node extension/tests/brand-contract.test.js
```

Expected: FAIL，manifest 或默认品牌仍为 `sonli`。

- [ ] **Step 3: 更新扩展用户可见品牌**

`extension/manifest.json` 使用：

```json
{
  "name": "ozon 粽子",
  "description": "ozon 粽子 · Ozon 选品采集与运营助手",
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "ozon 粽子"
  }
}
```

`popup.html` 的两个品牌区使用：

```html
<img src="../icons/ozon-zongzi-logo-primary.svg" class="brand-lockup" alt="ozon 粽子" />
```

删除同一品牌区内重复的独立 `sonli` 文本，功能按钮文案中的 `sonli 算价` 改为 `ozon 粽子算价`，CTA 改为“打开 ozon 粽子 Web 管理系统”。

默认品牌对象保持 `code: "sonli"`，只替换：

```js
displayName: "ozon 粽子",
productName: "ozon 粽子",
primaryColor: "#1268FF",
logoUrl: chrome.runtime.getURL("icons/ozon-zongzi-symbol.svg"),
```

- [ ] **Step 4: 更新保护性测试和 parity 门禁**

将旧断言：

```js
assert.equal(localManifest.name, "sonli");
assert.equal(localManifest.description, "sonli");
assert.equal(localManifest.action?.default_title, "sonli");
```

改为：

```js
assert.equal(localManifest.name, "ozon 粽子");
assert.equal(localManifest.description, "ozon 粽子 · Ozon 选品采集与运营助手");
assert.equal(localManifest.action?.default_title, "ozon 粽子");
```

把以下 SVG 加入 `allowedLocalOnly` 和 `reviewedChangedFiles` 对应资产边界：

```js
"icons/ozon-zongzi-logo-primary.svg",
"icons/ozon-zongzi-logo-dark.svg",
"icons/ozon-zongzi-logo-white.svg",
"icons/ozon-zongzi-logo-mono.svg",
"icons/ozon-zongzi-symbol.svg",
```

`check-extension-ui-parity.mjs` 保留 PNG 尺寸检查，并新增：

```js
for (const rel of [
  "icons/ozon-zongzi-logo-primary.svg",
  "icons/ozon-zongzi-symbol.svg",
]) assert.ok(existsSync(path.join(localDir, rel)), `brand SVG missing: ${rel}`);
```

- [ ] **Step 5: 运行扩展品牌和安全回归**

Run:

```bash
node extension/tests/brand-contract.test.js
node extension/popup/__tests__/popup-routing.smoke.test.js
node extension/tests/manifest-security-contract.test.js
node scripts/check-extension-diff-contract.mjs
```

Expected: 四个命令退出 0；manifest 权限和捕获边界保持不变。

- [ ] **Step 6: 提交**

```bash
git add extension/manifest.json extension/popup extension/background/service-worker.js extension/content/shared-utils.js extension/content/ozon-premium-hook.js extension/content/jzc-calc.js extension/tests/brand-contract.test.js extension/tests/manifest-security-contract.test.js scripts/check-extension-source-parity.mjs scripts/check-extension-diff-contract.mjs scripts/check-extension-ui-parity.mjs
git commit -m "feat: rebrand browser extension as ozon zongzi"
```

---

### Task 4: 按原型还原数据面板

**Files:**
- Create: `extension/tests/data-panel-visual-contract.test.js`
- Modify: `extension/content/shared-utils.js`
- Modify: `extension/content/ozon-product.css`
- Modify: `scripts/check-extension-ui-parity.mjs`

**Interfaces:**
- Consumes: `__JZ_BRAND__`、`jzRenderProductPanelV2(panel, opts)`、`jzPopulatePanelV2(panel, sku, info)`。
- Produces: 原型风格数据面板 DOM；所有已有 `data-field` 和 `data-action` 保持不变。

- [ ] **Step 1: 写失败的面板视觉 contract 测试**

创建 `extension/tests/data-panel-visual-contract.test.js`：

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("extension/content/shared-utils.js", "utf8");
const css = fs.readFileSync("extension/content/ozon-product.css", "utf8");

for (const token of [
  "ozon-helper-sidebar-brand-mark",
  "ozon-helper-sidebar-brand-copy",
  "ozon-helper-sidebar-brand-title",
  "ozon-helper-sidebar-brand-status",
  "ozon-helper-sidebar-card-gear",
  "ozon 粽子 · 选品助手",
  "商品数据已更新",
]) assert.ok(source.includes(token), `missing panel token: ${token}`);

for (const action of [
  'data-action="open-field-settings"',
  'data-action="follow-sell"',
  'data-action="edit-list"',
  'data-action="collect-one"',
]) assert.match(source, new RegExp(action));

for (const field of [
  "sales30d", "createDate", "heroFollow", "heroSize",
  "category", "sku", "returnRate", "rating", "dimensions", "volume", "weight",
]) assert.match(source, new RegExp(`field: '${field}'`));

assert.match(css, /--ozz-blue:\\s*#1268FF/i);
assert.match(css, /--ozz-navy:\\s*#10234A/i);
assert.match(css, /grid-template-columns:\\s*repeat\\(4,/);
assert.match(css, /@container|@media/);
assert.doesNotMatch(css, /\\.ozon-helper-sidebar-card-header[^{]*\\{[^}]*linear-gradient/s);

console.log("data panel visual contract passed");
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node extension/tests/data-panel-visual-contract.test.js
```

Expected: FAIL，标题区仍是旧渐变结构且缺少原型品牌 DOM。

- [ ] **Step 3: 重构面板标题区，不改字段与动作 contract**

在 `jzRenderProductPanelV2` 和 `jzRenderPanelSkeleton` 使用同一标题结构：

```html
<div class="ozon-helper-sidebar-card-header">
  <div class="ozon-helper-sidebar-brand">
    <span class="ozon-helper-sidebar-brand-mark">
      <img src="${logoUrl}" alt="" />
    </span>
    <span class="ozon-helper-sidebar-brand-copy">
      <strong class="ozon-helper-sidebar-brand-title">ozon 粽子 · 选品助手</strong>
      <small class="ozon-helper-sidebar-brand-status">商品数据已更新</small>
    </span>
  </div>
  ${window.jzFieldSettingsGearHtml()}
</div>
```

Logo 缺失时使用可读名称而不是破损图片：

```js
const brand = globalThis.__JZ_BRAND__ || {};
const logo = brand.logoUrl
  ? `<img src="${_v2Escape(brand.logoUrl)}" alt="" />`
  : `<span>${_v2Escape((brand.displayName || "ozon 粽子").slice(0, 1))}</span>`;
```

渲染后给品牌图片绑定失败回退：

```js
panel.querySelectorAll(".ozon-helper-sidebar-brand-mark img").forEach((img) => {
  img.addEventListener("error", () => {
    img.hidden = true;
    img.parentElement?.classList.add("is-logo-fallback");
  }, { once: true });
});
```

- [ ] **Step 4: 用命名空间 CSS 还原原型**

在 `ozon-product.css` 的数据卡区域定义：

```css
.ozon-helper-sidebar-card {
  --ozz-blue: #1268FF;
  --ozz-navy: #10234A;
  --ozz-border: #E7EEF9;
  --ozz-soft: #F2F7FF;
  --ozz-success: #16A34A;
  container-type: inline-size;
  background: #fff;
  border: 1px solid var(--ozz-border);
  border-radius: 16px;
  box-shadow: 0 8px 24px rgba(16, 35, 74, 0.08);
}

.ozon-helper-sidebar-card-header {
  padding: 14px 16px;
  color: var(--ozz-navy);
  background: #fff;
  border-bottom: 1px solid var(--ozz-border);
}

.oh-hero-section {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  padding: 12px;
}

@container (max-width: 420px) {
  .oh-hero-section {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
```

保留现有 `.is-nodata`、`.is-collected`、`.is-skeleton`、锁定卡和错误态语义。

- [ ] **Step 5: 运行面板数据与视觉 contract 测试**

Run:

```bash
node extension/tests/data-panel-visual-contract.test.js
node extension/tests/data-panel-logistics.test.js
node extension/tests/data-card-copy-button.test.js
node extension/tests/sidebar-section-toggle.test.js
```

Expected: 四个命令退出 0；视觉结构存在，物流字段、复制和折叠行为不回归。

- [ ] **Step 6: 更新完整 UI fingerprint 并提交**

先运行完整 diff：

```bash
diff -u /Users/songliang/Desktop/0.13.46.1/content/ozon-product.css extension/content/ozon-product.css
```

完整审阅后，用当前文件 SHA-256 更新 `check-extension-ui-parity.mjs` 的 `content/ozon-product.css` 本地 fingerprint，再提交：

```bash
git add extension/content/shared-utils.js extension/content/ozon-product.css extension/tests/data-panel-visual-contract.test.js scripts/check-extension-ui-parity.mjs
git commit -m "feat: match extension data panel prototype"
```

---

### Task 5: 按原型还原字段设置弹窗并保留旧设置

**Files:**
- Modify: `extension/content/shared-utils.js`
- Modify: `extension/content/ozon-product.css`
- Modify: `extension/tests/data-panel-visual-contract.test.js`

**Interfaces:**
- Consumes: `window.JZ_DATACARD_FIELDS`、`jzLoadFieldVisibility()`、`jzSaveFieldVisibility(map)`、`jzGetSalesPeriod()`、`jzSaveSalesPeriod(period)`。
- Produces: `jzGroupDataCardFields`、`jzCountVisibleDataCardFields`、原型风格设置弹窗和单一字段设置状态。

- [ ] **Step 1: 为纯 helper 和设置动作补失败测试**

在 `data-panel-visual-contract.test.js` 增加 VM 加载断言：

```js
const windowObj = loadSharedUtils();
const groups = windowObj.jzGroupDataCardFields([
  { field: "sku", label: "SKU", group: "商品信息" },
  { field: "rating", label: "评分", group: "物流商品" },
]);
assert.deepEqual(JSON.parse(JSON.stringify(groups)), [
  { name: "商品信息", fields: [{ field: "sku", label: "SKU", group: "商品信息" }] },
  { name: "物流商品", fields: [{ field: "rating", label: "评分", group: "物流商品" }] },
]);
assert.deepEqual(
  JSON.parse(JSON.stringify(windowObj.jzCountVisibleDataCardFields(
    [{ field: "sku" }, { field: "rating" }],
    { rating: false },
  ))),
  { visible: 1, total: 2 },
);

for (const action of [
  "enable-all", "disable-all", "toggle-group", "restore-default", "save",
]) assert.match(source, new RegExp(`data-jz-act="${action}"`));
assert.match(source, /data-jz-save-error/);
assert.match(source, /chrome\.runtime\.lastError/);
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node extension/tests/data-panel-visual-contract.test.js
```

Expected: FAIL，纯 helper 和原型动作尚不存在。

- [ ] **Step 3: 实现纯 helper**

在 `shared-utils.js` 定义：

```js
window.jzGroupDataCardFields = function (fields) {
  const groups = [];
  const byName = new Map();
  for (const field of fields || []) {
    if (!byName.has(field.group)) {
      const group = { name: field.group, fields: [] };
      byName.set(field.group, group);
      groups.push(group);
    }
    byName.get(field.group).fields.push(field);
  }
  return groups;
};

window.jzCountVisibleDataCardFields = function (fields, visibilityMap) {
  const all = fields || [];
  const map = visibilityMap || {};
  return {
    visible: all.filter((item) => map[item.field] !== false).length,
    total: all.length,
  };
};
```

- [ ] **Step 4: 重构设置弹窗 DOM**

设置弹窗必须包含：

```html
<div class="jz-fieldset-summary">
  <div>
    <small>当前已展示</small>
    <strong data-jz-visible-count>${visible}</strong>
    <span>/ ${total} 项信息</span>
  </div>
  <div class="jz-fieldset-summary-actions">
    <button data-jz-act="enable-all">全部开启</button>
    <button data-jz-act="disable-all">全部隐藏</button>
  </div>
</div>
```

每个真实字段组使用：

```html
<section class="jz-fieldset-group" data-jz-group="${groupName}">
  <header>
    <strong>${groupName}</strong>
    <span>${group.fields.length} 项</span>
    <button data-jz-act="toggle-group" data-jz-group-name="${groupName}">全不选</button>
  </header>
  <div class="jz-fieldset-grid">...</div>
</section>
```

底部使用：

```html
<button data-jz-act="restore-default">恢复默认</button>
<button class="is-primary" data-jz-act="save">完成设置</button>
```

数据周期继续放在独立分组中，使用现有两个 radio，不计入字段总数。

- [ ] **Step 5: 实现单一状态上的批量动作**

在弹窗内部使用同一批 checkbox：

```js
const fieldBoxes = () => Array.from(modal.querySelectorAll("input[data-jz-field]"));
const refreshSummary = () => {
  const visible = fieldBoxes().filter((box) => box.checked).length;
  modal.querySelector("[data-jz-visible-count]").textContent = String(visible);
};

if (act === "enable-all" || act === "disable-all") {
  const checked = act === "enable-all";
  fieldBoxes().forEach((box) => { box.checked = checked; });
  refreshSummary();
  return;
}

if (act === "restore-default") {
  fieldBoxes().forEach((box) => { box.checked = true; });
  const monthly = modal.querySelector('input[name="jz-sales-period"][value="monthly"]');
  if (monthly) monthly.checked = true;
  refreshSummary();
  return;
}
```

`toggle-group` 只操作 `data-jz-group` 对应 section 内的 checkbox。任何批量动作都不直接写 storage；只有“完成设置”保存，取消或关闭不改变旧设置。

- [ ] **Step 6: 让保存失败保持弹窗并显示错误**

`jzSaveFieldVisibility` 和 `jzSaveSalesPeriod` 在 Chrome 报错时 reject：

```js
chrome.storage.local.set(payload, () => {
  const error = chrome.runtime?.lastError;
  if (error) {
    reject(new Error(error.message || "设置保存失败"));
    return;
  }
  resolve(savedValue);
});
```

弹窗底部增加：

```html
<p class="jz-fieldset-save-error" data-jz-save-error hidden></p>
```

保存逻辑必须在成功后才关闭：

```js
Promise.all([
  window.jzSaveFieldVisibility(next),
  window.jzSaveSalesPeriod(selPeriod),
]).then(() => {
  window.jzApplyFieldVisibilityToAll(next);
  close();
  if (periodChanged) location.reload();
}).catch((error) => {
  const message = modal.querySelector("[data-jz-save-error]");
  message.hidden = false;
  message.textContent = error?.message || "设置保存失败，请重试";
});
```

- [ ] **Step 7: 按原型实现响应式弹窗 CSS**

必须包含：

```css
.jz-fieldset-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(16, 35, 74, 0.38);
  backdrop-filter: blur(4px);
}

.jz-fieldset-modal {
  width: min(960px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  border: 1px solid #E7EEF9;
  border-radius: 20px;
  background: #fff;
  box-shadow: 0 24px 64px rgba(16, 35, 74, 0.2);
}

.jz-fieldset-body {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 900px) {
  .jz-fieldset-body { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 620px) {
  .jz-fieldset-body { grid-template-columns: 1fr; }
}
```

- [ ] **Step 8: 运行设置、数据与完整扩展定向测试**

Run:

```bash
node extension/tests/data-panel-visual-contract.test.js
node extension/tests/data-panel-logistics.test.js
node extension/popup/__tests__/popup-routing.smoke.test.js
node extension/tests/brand-contract.test.js
```

Expected: 四个命令退出 0；动态计数和设置动作 contract PASS。

- [ ] **Step 9: 提交**

```bash
git add extension/content/shared-utils.js extension/content/ozon-product.css extension/tests/data-panel-visual-contract.test.js
git commit -m "feat: match data panel settings prototype"
```

---

### Task 6: 打包、完整回归和视觉 QA

**Files:**
- Create: `design-qa.md`
- Create: `docs/superpowers/verification/assets/ozon-zongzi-reference-panel.png`
- Create: `docs/superpowers/verification/assets/ozon-zongzi-reference-settings.png`
- Create: `docs/superpowers/verification/assets/ozon-zongzi-implementation-panel.png`
- Create: `docs/superpowers/verification/assets/ozon-zongzi-implementation-settings.png`
- Modify: `scripts/check-extension-ui-parity.mjs`（仅当最终完整文件 hash 与 Task 4 后不同）
- Generate: `app/public/sonli-extension-0.13.46.1/`
- Generate: `app/public/sonli-extension-0.13.46.1.zip`
- Generate: `app/dist/sonli-extension-0.13.46.1.zip`

**Interfaces:**
- Consumes: Tasks 1–5 的品牌资产、Web 品牌、扩展面板和设置弹窗。
- Produces: 可安装扩展包、完整测试证据和通过的视觉 QA 报告。

- [ ] **Step 1: 重新生成品牌资产并打包扩展**

Run:

```bash
node scripts/generate-brand-assets.mjs
node scripts/package-extension.mjs
```

Expected: 生成 unpacked 目录和两份 `sonli-extension-0.13.46.1.zip`；兼容文件名保持不变。

- [ ] **Step 2: 运行完整验证**

Run:

```bash
npm run verify
```

Expected:

- App build PASS。
- Extension source parity PASS。
- Extension UI parity PASS。
- Extension diff contract PASS。
- unpacked 与 ZIP parity PASS。
- ZIP smoke PASS。
- 全部 active tests PASS。
- `git diff --check` PASS。

- [ ] **Step 3: 启动本地环境**

Run:

```bash
npm run dev
```

Expected: Web 可通过 `http://127.0.0.1:3000/` 打开，API 与 worker 正常启动。

- [ ] **Step 4: 验证 Web 品牌**

在浏览器中检查：

```text
http://127.0.0.1:3000/login
http://127.0.0.1:3000/ozon/dashboard
http://127.0.0.1:3000/datascreen
http://127.0.0.1:3000/extension/
```

逐页确认：

- Logo 清晰且没有拉伸。
- 名称显示「ozon 粽子」。
- 页面标题正确。
- 导航、登录状态、当前店铺和插件下载按钮仍可用。

- [ ] **Step 5: 在 Chrome 加载打包后的扩展并验证真实 Ozon 页面**

加载目录：

```text
/Users/songliang/Documents/sonli ozon3.0/app/public/sonli-extension-0.13.46.1
```

打开一个真实 Ozon 商品详情页，记录：

- 数据面板默认状态截图。
- 点击齿轮后的设置弹窗截图。
- 全部隐藏后的计数变化。
- 取消后旧设置不变。
- 恢复默认并完成设置后，刷新页面仍保持默认显示。
- 采集、算价和跟卖动作仍使用原有路由。

若无法访问真实已登录 Chrome 扩展环境，`design-qa.md` 必须写 `final result: blocked`，不得声称视觉验收通过。

- [ ] **Step 6: 生成同视口对比并写 `design-qa.md`**

报告必须使用：

```md
# Design QA

Reference:
- https://ozon-operations-prototype.sl1499008477.chatgpt.site/#/plugin
- data panel screenshot: docs/superpowers/verification/assets/ozon-zongzi-reference-panel.png
- settings screenshot: docs/superpowers/verification/assets/ozon-zongzi-reference-settings.png

Implementation:
- local Ozon data panel screenshot: docs/superpowers/verification/assets/ozon-zongzi-implementation-panel.png
- local settings screenshot: docs/superpowers/verification/assets/ozon-zongzi-implementation-settings.png

Checks:
- P0: none
- P1: none
- P2: none
- P3: <only minor polish differences, or none>

Functional checks:
- field visibility persisted: passed
- monthly/weekly period persisted: passed
- collect action preserved: passed
- calculation action preserved: passed
- account/session state preserved: passed

final result: passed
```

四张截图必须真实存在并来自相同视口、相同交互状态；报告不得引用临时目录或不存在的文件。

- [ ] **Step 7: 修复所有 P0/P1/P2 并复跑验证**

每轮修复后运行：

```bash
node extension/tests/data-panel-visual-contract.test.js
node extension/tests/data-panel-logistics.test.js
node scripts/package-extension.mjs
npm run verify
```

Expected: 所有命令退出 0，最终 `design-qa.md` 为 `final result: passed`。

- [ ] **Step 8: 提交打包与 QA 结果**

```bash
git add design-qa.md docs/superpowers/verification/assets scripts/check-extension-ui-parity.mjs app/public extension app/src app/tests
git commit -m "build: package ozon zongzi extension refresh"
```

---

## Final Delivery Checklist

- [ ] 说明改了什么。
- [ ] 列出品牌 contract、面板 DOM contract 和字段设置 contract。
- [ ] 说明完整测试数量与结果。
- [ ] 说明 Web、数据面板和设置弹窗的实际浏览器验证结果。
- [ ] 说明未验证范围及原因。
- [ ] 说明无数据库迁移、无后端 API 变更。
- [ ] 提供本地 Web 地址、unpacked 扩展目录和 ZIP 路径。
- [ ] 说明回滚方式：回滚本计划对应提交并重新发布上一版扩展包。

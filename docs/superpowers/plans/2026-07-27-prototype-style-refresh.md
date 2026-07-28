# Sonli Ozon Prototype Style Refresh Implementation Plan

> **历史文档：** 本文件保留当时的目标、路径和执行步骤，不据此推断当前完成状态；当前实现与验证结果以已提交代码、可复现测试和最终保护性基线报告为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every existing page in `<repo>/app` to match the blue-and-white rounded operations-console language of the approved prototype while preserving all current business behavior and data contracts.

**Architecture:** Keep the existing React and Ant Design application intact. Add one scoped `prototype-shell` theme layer, map the approved prototype tokens into Ant Design, and make only the JSX changes required for shared page hierarchy and mobile navigation. Use common selectors for the application shell, controls, cards, tables, forms, overlays, and operational pages; reserve page-specific overrides for dashboard, data-screen, and complex settings layouts.

**Tech Stack:** React 19.2, Ant Design 6.5, Vite 6.4, CSS, Node.js built-in test runner.

## Global Constraints

- Visual reference source: `<approved-prototype>`.
- Visual reference URL: `http://localhost:5173/`.
- Primary page background: `#F6FAFE`; primary color: `#005AF8`; primary text: `#071737`; border: `#DCE8F7`.
- Preserve every existing route, API path, request/response contract, permission check, store boundary, state transition, and business interaction.
- Do not copy prototype mock data into the target application.
- Do not add dependencies or modify `app/package.json`, root `package.json`, or `pnpm-lock.yaml`.
- Do not modify server, database, migration, extension, desktop collector, deployment, or external-service files.
- Do not trigger real Ozon writes, syncs, publishing, migrations, or production effects during visual verification.
- Preserve unrelated dirty-worktree changes; never run destructive Git commands.
- Git commits are not authorized. End each task with a scoped diff checkpoint; commit only if the user later gives explicit authorization.
- A new file outside the declared list, or a required change outside `app/src/App.jsx`, `app/src/styles.css`, `app/tests/prototype-style-contract.test.mjs`, and `design-qa.md`, requires a new impact analysis before editing.

## File Map

- Create `app/tests/prototype-style-contract.test.mjs`: static contracts for the approved tokens, scoped shell, shared component selectors, mobile navigation, and responsive safeguards.
- Modify `app/src/App.jsx`: Ant Design tokens, `prototype-shell` scope, dashboard heading hierarchy, and a mobile navigation drawer that reuses the existing menu and routes.
- Modify `app/src/styles.css`: all visual tokens and scoped prototype-theme overrides.
- Modify `design-qa.md`: same-viewport source/target comparison, route and interaction results, remaining P3 notes, and final pass/block status.

---

### Task 1: Establish the pre-change baseline and global design tokens

**Files:**
- Create: `app/tests/prototype-style-contract.test.mjs`
- Modify: `app/src/App.jsx:1180-1230`
- Modify: `app/src/styles.css:1-20`

**Interfaces:**
- Consumes: the existing `themeConfig` object and root stylesheet.
- Produces: CSS custom properties `--prototype-page-bg`, `--prototype-surface`, `--prototype-surface-muted`, `--prototype-primary`, `--prototype-primary-hover`, `--prototype-primary-soft`, `--prototype-ink`, `--prototype-ink-secondary`, `--prototype-ink-light`, `--prototype-border`, `--prototype-border-strong`, `--prototype-success`, `--prototype-warning`, `--prototype-danger`, `--prototype-purple`, and `--prototype-shadow`.

- [ ] **Step 1: Record the narrow baseline**

Run:

```bash
git status --short --branch
git diff -- app/src/App.jsx app/src/styles.css
pnpm --dir app build
```

Expected: the existing user changes are recorded; the build result is saved as the pre-change baseline. Do not repair unrelated baseline failures.

- [ ] **Step 2: Write the failing token contract**

Create `app/tests/prototype-style-contract.test.mjs` with:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const requiredTokens = new Map([
  ["--prototype-page-bg", "#f6fafe"],
  ["--prototype-surface", "#ffffff"],
  ["--prototype-surface-muted", "#f7fafe"],
  ["--prototype-primary", "#005af8"],
  ["--prototype-primary-hover", "#004fe0"],
  ["--prototype-primary-soft", "#eef5ff"],
  ["--prototype-ink", "#071737"],
  ["--prototype-ink-secondary", "#65718a"],
  ["--prototype-ink-light", "#8c98ac"],
  ["--prototype-border", "#dce8f7"],
  ["--prototype-border-strong", "#cbdcf2"],
  ["--prototype-success", "#14994a"],
  ["--prototype-warning", "#b76708"],
  ["--prototype-danger", "#d93632"],
  ["--prototype-purple", "#6c4de6"],
]);

test("declares the approved prototype token values", () => {
  const normalized = cssSource.toLowerCase();
  for (const [name, value] of requiredTokens) {
    assert.match(normalized, new RegExp(`${name}:\\\\s*${value.replace("#", "\\\\#")}`), name);
  }
});

test("maps Ant Design to the approved prototype palette", () => {
  assert.match(appSource, /colorPrimary:\s*"#005af8"/);
  assert.match(appSource, /colorText:\s*"#071737"/);
  assert.match(appSource, /colorBorder:\s*"#dce8f7"/);
  assert.match(appSource, /borderRadiusLG:\s*18/);
});
```

- [ ] **Step 3: Run the contract and verify the intended failure**

Run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
```

Expected: FAIL because the prototype token names and approved Ant Design values do not yet exist.

- [ ] **Step 4: Add the exact global token block**

At the start of `app/src/styles.css`, extend `:root` with:

```css
  --prototype-page-bg: #f6fafe;
  --prototype-surface: #ffffff;
  --prototype-surface-muted: #f7fafe;
  --prototype-primary: #005af8;
  --prototype-primary-hover: #004fe0;
  --prototype-primary-soft: #eef5ff;
  --prototype-ink: #071737;
  --prototype-ink-secondary: #65718a;
  --prototype-ink-light: #8c98ac;
  --prototype-border: #dce8f7;
  --prototype-border-strong: #cbdcf2;
  --prototype-success: #14994a;
  --prototype-warning: #b76708;
  --prototype-danger: #d93632;
  --prototype-purple: #6c4de6;
  --prototype-shadow: 0 12px 38px rgba(24, 79, 151, 0.06),
    0 1px 2px rgba(24, 79, 151, 0.04);
```

Use the approved font stack in the same `:root` rule:

```css
font-family:
  Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC",
  system-ui, -apple-system, sans-serif;
```

- [ ] **Step 5: Map the existing Ant Design theme**

In `themeConfig.token`, set:

```js
colorPrimary: "#005af8",
colorPrimaryHover: "#004fe0",
colorText: "#071737",
colorTextSecondary: "#65718a",
colorBorder: "#dce8f7",
colorBgLayout: "#f6fafe",
colorBgContainer: "#ffffff",
borderRadius: 12,
borderRadiusLG: 18,
boxShadowSecondary: "0 12px 38px rgba(24, 79, 151, 0.08)",
```

Update existing component tokens to use 18px card rounding and 12px control rounding without changing component behavior.

- [ ] **Step 6: Verify and checkpoint**

Run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
pnpm --dir app build
git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs
git diff --stat -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs
```

Expected: token contract PASS, build matches or improves on the baseline, and diff check reports no whitespace errors.

---

### Task 2: Restyle the application shell and page hierarchy

**Files:**
- Modify: `app/tests/prototype-style-contract.test.mjs`
- Modify: `app/src/App.jsx:1303-1405`
- Modify: `app/src/styles.css:119-450`
- Modify: `app/src/styles.css` by adding a final `Prototype shell overrides` section

**Interfaces:**
- Consumes: the Task 1 CSS tokens, existing `menuItems`, `route`, `pageTitle`, `settings`, and navigation handlers.
- Produces: `.prototype-shell`, `.prototype-eyebrow`, `.prototype-page-subtitle`, and scoped shell selectors used by later tasks.

- [ ] **Step 1: Add the failing shell contract**

Append to the contract test:

```js
test("scopes the visual refresh to the authenticated application shell", () => {
  assert.match(appSource, /className="qh-shell prototype-shell"/);
  assert.match(appSource, /className="prototype-eyebrow"/);
  assert.match(appSource, /OZON SELLER WORKSPACE/);
});

test("defines the prototype application shell selectors", () => {
  for (const selector of [
    ".prototype-shell",
    ".prototype-shell .qh-sider",
    ".prototype-shell .qh-topbar",
    ".prototype-shell .qh-content",
    ".prototype-shell .qh-sider .ant-menu-item-selected",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }
});
```

- [ ] **Step 2: Run the contract and verify the intended failure**

Run `node --test app/tests/prototype-style-contract.test.mjs`.

Expected: the token tests PASS and the new shell tests FAIL.

- [ ] **Step 3: Add the scoped shell markup**

Change the authenticated root to:

```jsx
<Layout className="qh-shell prototype-shell">
```

Inside the dashboard page heading, before the `h1`, add:

```jsx
<span className="prototype-eyebrow">OZON SELLER WORKSPACE</span>
```

After the `h1`, add:

```jsx
<p className="prototype-page-subtitle">
  先看经营结果，再处理今天最重要的异常
</p>
```

Keep the existing date/sync row and every action unchanged.

- [ ] **Step 4: Add the scoped shell CSS**

Add a final stylesheet section that uses these exact structural values:

```css
.prototype-shell {
  min-height: 100vh;
  background: var(--prototype-page-bg);
  color: var(--prototype-ink);
}

.prototype-shell .qh-sider {
  top: 24px;
  bottom: 24px;
  left: 24px;
  height: calc(100vh - 48px);
  padding: 20px 12px;
  overflow: auto;
  border: 1px solid var(--prototype-border);
  border-radius: 26px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: var(--prototype-shadow);
}

.prototype-shell .qh-topbar {
  inset: 24px 24px auto 292px;
  height: 64px;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.prototype-shell .qh-content {
  margin-left: 292px;
  padding: 112px 24px 48px 0;
  overflow-x: clip;
  background: var(--prototype-page-bg);
}

.prototype-shell .qh-sider .ant-menu-item,
.prototype-shell .qh-sider .ant-menu-submenu-title {
  height: 48px !important;
  margin: 4px 0 !important;
  border-radius: 17px !important;
  color: var(--prototype-ink-secondary);
}

.prototype-shell .qh-sider .ant-menu-item-selected {
  color: var(--prototype-primary) !important;
  background: linear-gradient(90deg, #e9f2ff, #f2f7ff) !important;
}
```

Style `.qh-brand`, `.qh-header-action`, `.qh-user`, `.qh-page-head`, `.prototype-eyebrow`, `.prototype-page-subtitle`, and `.qh-date-row` from the approved tokens. Keep all existing click targets and DOM semantics.

- [ ] **Step 5: Verify and checkpoint**

Run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
pnpm --dir app build
git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs
```

Expected: all current contracts PASS and the application builds.

---

### Task 3: Unify login, controls, cards, tables, forms, and overlays

**Files:**
- Modify: `app/tests/prototype-style-contract.test.mjs`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: Task 1 tokens and the `.prototype-shell` scope.
- Produces: one consistent style contract for Ant Design controls, application cards, tables, form states, Modal, Drawer, Dropdown, Popover, Tooltip, Alert, and Empty.

- [ ] **Step 1: Add the failing shared-component contract**

Append:

```js
test("styles shared controls and data surfaces inside the prototype scope", () => {
  for (const selector of [
    ".prototype-shell .ant-btn",
    ".prototype-shell .ant-input",
    ".prototype-shell .ant-select-selector",
    ".prototype-shell .ant-card",
    ".prototype-shell .source-table .ant-table",
    ".prototype-shell .ant-table-thead > tr > th",
    ".prototype-overlay .ant-modal-content",
    ".prototype-overlay .ant-drawer-content",
    ".sonli-login-card",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }
});
```

- [ ] **Step 2: Verify the new contract fails**

Run `node --test app/tests/prototype-style-contract.test.mjs`.

Expected: shared-component selector test FAILS.

- [ ] **Step 3: Scope overlays without changing behavior**

Add `rootClassName="prototype-overlay"` to the binding `Modal` and plugin `Drawer`. Add the same root class to existing application-owned Modal and Drawer instances when their current props are edited during this task; do not change `open`, `onClose`, `onCancel`, `footer`, form, or submit props.

- [ ] **Step 4: Add shared component overrides**

Add scoped rules with these invariants:

```css
.prototype-shell .ant-btn,
.prototype-shell .ant-input,
.prototype-shell .ant-input-affix-wrapper,
.prototype-shell .ant-input-number,
.prototype-shell .ant-picker,
.prototype-shell .ant-select-selector {
  min-height: 40px;
  border-color: var(--prototype-border) !important;
  border-radius: 12px !important;
}

.prototype-shell .ant-card {
  border-color: var(--prototype-border);
  border-radius: 18px;
  background: var(--prototype-surface);
  box-shadow: var(--prototype-shadow);
}

.prototype-shell .source-table .ant-table {
  overflow: hidden;
  border: 1px solid var(--prototype-border);
  border-radius: 16px;
}

.prototype-shell .ant-table-thead > tr > th {
  color: var(--prototype-ink-secondary);
  background: var(--prototype-surface-muted);
  border-bottom-color: var(--prototype-border);
}

.prototype-overlay .ant-modal-content,
.prototype-overlay .ant-drawer-content {
  border: 1px solid var(--prototype-border);
  border-radius: 18px;
  box-shadow: 0 22px 60px rgba(10, 36, 78, 0.18);
}
```

Add matching focus-visible rings using `0 0 0 3px rgba(0, 90, 248, 0.12)`. Restyle login background, card, brand, inputs, submit button, validation text, and checking state with the same tokens. Preserve readable error, warning, disabled, loading, empty, and success states.

- [ ] **Step 5: Verify shared contracts and build**

Run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
pnpm --dir app build
git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs
```

Expected: PASS.

---

### Task 4: Refine dashboard and data-screen layouts

**Files:**
- Modify: `app/tests/prototype-style-contract.test.mjs`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: shared card/control styles.
- Produces: prototype-aligned dashboard metrics, work queues, charts, quick actions, and data-screen surfaces without changing values or actions.

- [ ] **Step 1: Add the failing dashboard contract**

Append:

```js
test("defines dashboard and data-screen visual contracts", () => {
  for (const selector of [
    ".prototype-shell .metric-grid",
    ".prototype-shell .metric-card",
    ".prototype-shell .dashboard-main-grid",
    ".prototype-shell .panel-card",
    ".prototype-shell .quick-actions",
    ".prototype-datascreen",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }
});
```

- [ ] **Step 2: Verify the dashboard contract fails**

Run `node --test app/tests/prototype-style-contract.test.mjs`.

Expected: the new dashboard selector assertions FAIL before CSS implementation.

- [ ] **Step 3: Implement dashboard surface rules**

Add `prototype-datascreen` to the existing root class of `DataScreenPage`, then implement the following rules.

Use separated cards instead of the current joined metric strip:

```css
.prototype-shell .metric-grid {
  gap: 14px;
  overflow: visible;
  border: 0;
  background: transparent;
}

.prototype-shell .metric-card {
  min-height: 112px;
  padding: 18px;
  border: 1px solid var(--prototype-border);
  border-radius: 18px;
  background: var(--prototype-surface);
  box-shadow: var(--prototype-shadow);
}

.prototype-shell .metric-card strong {
  color: var(--prototype-ink);
  font-size: 28px;
}

.prototype-shell .panel-card {
  border: 1px solid var(--prototype-border);
  border-radius: 18px;
  box-shadow: var(--prototype-shadow);
}
```

Apply the same visual hierarchy to todo rows, chart panels, weekly indicators, quick actions, onboarding/empty states, and data-screen panels. Do not insert prototype mock metrics or alter current values.

- [ ] **Step 4: Verify and checkpoint**

Run the contract test, app build, and diff check.

Expected: PASS with no data or interaction changes.

---

### Task 5: Apply the design system to all operational routes

**Files:**
- Modify: `app/tests/prototype-style-contract.test.mjs`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: shared token, control, card, and table contracts.
- Produces: consistent layouts for every existing `source-page`, product, collection, listing, stock, selection, AI, promotion, order, return, profit, messaging, watermark, template, account, pricing, store, plugin, and 404 route.

- [ ] **Step 1: Add the failing operational-page contract**

Append:

```js
test("covers every shared operational page family", () => {
  for (const selector of [
    ".prototype-shell .source-page",
    ".prototype-shell .source-section-title",
    ".prototype-shell .source-card",
    ".prototype-shell .source-query-grid",
    ".prototype-shell .source-status-tabs",
    ".prototype-shell .product-status-filters",
    ".prototype-shell .profit-main-grid",
    ".prototype-shell .pricing-settings-layout",
    ".prototype-shell .stores-settings-page",
    ".prototype-shell .collect-edit-body",
    ".prototype-shell .source-404-page",
  ]) {
    assert.ok(cssSource.includes(selector), selector);
  }
});
```

- [ ] **Step 2: Verify the new contract fails**

Run `node --test app/tests/prototype-style-contract.test.mjs`.

Expected: new operational-page selectors FAIL.

- [ ] **Step 3: Add the common operational-page layer**

Implement:

```css
.prototype-shell .source-page,
.prototype-shell .stores-settings-page {
  gap: 18px;
  padding-top: 12px;
}

.prototype-shell .source-section-title h2 {
  color: var(--prototype-ink);
  font-size: 24px;
  font-weight: 750;
}

.prototype-shell .source-section-title p {
  color: var(--prototype-ink-secondary);
}

.prototype-shell .source-card,
.prototype-shell .source-query-grid,
.prototype-shell .product-status-filters,
.prototype-shell .source-status-tabs {
  border-color: var(--prototype-border);
  border-radius: 16px;
  background: var(--prototype-surface);
}
```

Then apply the same tokens to existing page-family selectors for status tabs, filter drawers, query forms, product rows, collection editor sections, pricing panels, profit panels, store/account summaries, messaging cards, AI cards, plugin panels, and 404 content. Keep selectors scoped under `.prototype-shell` and preserve current layout semantics unless a documented responsive rule changes them.

- [ ] **Step 4: Check representative route groups after each CSS batch**

After each of these batches, run `pnpm --dir app build`:

1. Product, collection, listing, stock.
2. Orders, returns, profit, promotions.
3. Store, account, pricing, messaging.
4. AI, selection, watermark, templates, plugin, 404.

Expected: every batch builds before the next group is edited.

- [ ] **Step 5: Verify and checkpoint**

Run the full static contract and diff check.

Expected: PASS and no files outside the declared boundary.

---

### Task 6: Add accessible mobile navigation and responsive safeguards

**Files:**
- Modify: `app/tests/prototype-style-contract.test.mjs`
- Modify: `app/src/App.jsx:29-65`
- Modify: `app/src/App.jsx:785-870`
- Modify: `app/src/App.jsx:1303-1395`
- Modify: `app/src/styles.css:4490-4691`
- Modify: `app/src/styles.css` final override section

**Interfaces:**
- Consumes: existing `menuItems`, `route`, `openKeys`, `setOpenKeys`, and `navigate`.
- Produces: `mobileNavOpen`, `.prototype-mobile-menu-trigger`, `.prototype-mobile-nav`, and page-contained overflow behavior.

- [ ] **Step 1: Add the failing mobile contract**

Append:

```js
test("provides mobile navigation and contained overflow", () => {
  assert.match(appSource, /mobileNavOpen/);
  assert.match(appSource, /prototype-mobile-menu-trigger/);
  assert.match(appSource, /prototype-mobile-nav/);
  assert.match(cssSource, /@media \(max-width: 600px\)/);
  assert.match(cssSource, /\.prototype-shell \.source-table-wrap[\s\S]*overflow-x:\s*auto/);
  assert.match(cssSource, /\.prototype-shell[\s\S]*overflow-x:\s*clip/);
});
```

- [ ] **Step 2: Verify the mobile contract fails**

Run `node --test app/tests/prototype-style-contract.test.mjs`.

Expected: new mobile assertions FAIL.

- [ ] **Step 3: Add mobile navigation using existing Ant Design components**

Import `MenuOutlined` from `@ant-design/icons`.

Add state:

```js
const [mobileNavOpen, setMobileNavOpen] = useState(false);
```

Add a header button:

```jsx
<Button
  aria-label="打开导航"
  className="prototype-mobile-menu-trigger"
  icon={<MenuOutlined />}
  onClick={() => setMobileNavOpen(true)}
  type="text"
/>
```

Add a Drawer beside the existing plugin Drawer:

```jsx
<Drawer
  className="prototype-mobile-nav"
  open={mobileNavOpen}
  onClose={() => setMobileNavOpen(false)}
  placement="left"
  rootClassName="prototype-overlay"
  title="sonli · Ozon 运营台"
  width={288}
>
  <Menu
    mode="inline"
    selectedKeys={[route]}
    openKeys={openKeys}
    onOpenChange={setOpenKeys}
    items={menuItems}
    onClick={({ key }) => {
      setMobileNavOpen(false);
      navigate(key);
    }}
  />
</Drawer>
```

- [ ] **Step 4: Add breakpoint rules**

At 1180px, reduce the desktop sidebar to 76px and hide menu labels without changing route selection. At 800px, convert multi-column cards and forms to one column. At 600px:

```css
.prototype-shell .qh-sider {
  display: none;
}

.prototype-shell .qh-topbar {
  inset: 12px 12px auto;
}

.prototype-shell .qh-content {
  margin-left: 0;
  padding: 92px 12px 32px;
}

.prototype-mobile-menu-trigger {
  display: inline-flex;
}

.prototype-shell .source-table-wrap {
  max-width: 100%;
  overflow-x: auto;
}
```

Above 600px, `.prototype-mobile-menu-trigger` must be `display: none`.

- [ ] **Step 5: Verify and checkpoint**

Run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
pnpm --dir app build
git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs
```

Expected: PASS.

---

### Task 7: Run route regression and blocking visual QA

**Files:**
- Modify: `design-qa.md`

**Interfaces:**
- Consumes: the completed app build and the approved source prototype.
- Produces: evidence that desktop, intermediate, and mobile views preserve interactions and pass same-viewport visual comparison.

- [ ] **Step 1: Run automated verification**

Run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
pnpm --dir app build
pnpm verify
```

Expected: the focused contract and app build PASS. If `pnpm verify` has a pre-existing unrelated failure, record the exact baseline comparison and do not edit unrelated files.

- [ ] **Step 2: Start the local target without external side effects**

Run from the repository root:

```bash
pnpm dev
```

Do not click sync, publish, delete, import, store-binding, or other operations that can call an external service or mutate business data.

- [ ] **Step 3: Capture the visual reference**

In the approved browser, open `http://localhost:5173/` and capture the same page state at:

- 1440px desktop
- 1280px intermediate desktop
- 390px mobile

Record the source title, visible navigation, main heading, shell geometry, colors, card radius, and responsive changes.

- [ ] **Step 4: Capture and inspect the target**

Open the target local application and inspect:

- dashboard
- product list
- collection/listing
- orders
- profit trend
- stores
- pricing
- messaging
- plugin
- login or logged-out state
- 404

Capture dashboard, product list, orders, profit, stores, and pricing at 1440px. Capture dashboard and product list at 390px. Capture at least dashboard at 1280px to prove the source prototype’s horizontal-cropping defect was not copied.

- [ ] **Step 5: Run interaction smoke checks**

Verify without external writes:

- Desktop and mobile navigation reach the expected route heading.
- Menu selection and submenu expansion remain correct.
- Product status tabs, a query input, and a table pagination control respond.
- One non-destructive modal or drawer opens and closes.
- Topbar store and account menus open without changing data.
- The mobile navigation drawer opens, navigates once, and closes.
- Browser console has no new uncaught errors.

- [ ] **Step 6: Perform same-viewport visual comparison**

Compare source and target screenshots together at 1440px and 390px. Inspect:

- layout hierarchy
- sidebar/topbar geometry
- background and surfaces
- typography and weights
- card/input/table radii
- border and shadow strength
- spacing and density
- overflow, clipping, and overlays

Fix every P0, P1, and P2 visual or interaction finding, recapture, and repeat until none remain.

- [ ] **Step 7: Write the QA result**

Update `design-qa.md` with:

```md
# Prototype Style Refresh Design QA

- reference: http://localhost:5173/
- target: local Sonli Ozon app
- desktop viewports: 1440px, 1280px
- mobile viewport: 390px
- automated contract: passed
- app build: passed
- route smoke: passed
- interaction smoke: passed
- P0/P1/P2 remaining: 0
- P3 follow-ups: none, or list only optional polish
- final result: passed
```

If valid source or target capture is unavailable, write `final result: blocked` and stop before completion claims.

- [ ] **Step 8: Final diff and secret review**

Run:

```bash
git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs design-qa.md
git diff --stat -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs design-qa.md
git diff -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs design-qa.md
rg -n -i "(api[-_ ]?key|apikey|client[-_ ]?id).{0,80}([0-9a-f]{8}-[0-9a-f]{4}|[0-9]{6,})" app/src app/tests design-qa.md
```

Expected: only declared files changed, no whitespace errors, no lockfile drift, no secrets, and no unrelated formatting churn.

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

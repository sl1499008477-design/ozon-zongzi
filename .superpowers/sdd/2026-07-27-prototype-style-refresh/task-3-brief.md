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

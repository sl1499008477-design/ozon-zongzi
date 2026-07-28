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

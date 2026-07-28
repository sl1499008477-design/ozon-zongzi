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

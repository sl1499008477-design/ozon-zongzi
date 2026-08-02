# Collect Edit Variant Draft Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make persisted multi-variant source drafts render complete, stable edit rows without overwriting existing user edits.

**Architecture:** Extract commercial-field normalization into a pure frontend module, then make the existing `collectEditVariantRows` adapter use it for both source and persisted draft rows. Keep media, source-category, logistics, submission, backend, database, and extension contracts unchanged.

**Tech Stack:** React 19, JavaScript ESM, Node.js test runner, Vite.

## Global Constraints

- Prefer existing `offerId`, `sellPrice`, edited name, old price, and stock over derived values.
- Derive missing offer IDs from `offerPrefix + source SKU`; append a stable 1-based suffix only when there is more than one variant.
- Derive missing sell price from `price.price`, `priceText`, `price`, `marketingPrice`, then the product fallback price.
- Do not write historical database rows or change backend/API/extension contracts.
- Browser verification is read-only: do not save a draft, preview a listing, or submit to Ozon.

---

### Task 1: Normalize persisted variant commercial fields

**Files:**
- Create: `app/src/collect-edit-variant-row.js`
- Create: `app/tests/collect-edit-variant-row.test.mjs`
- Modify: `app/src/App.jsx:4980-5027`
- Modify: `app/src/App.jsx:5226-5280`

**Interfaces:**
- Consumes: `normalizeCollectEditVariantRow({ variant, index, rowCount, fallbackSku, fallbackTitle, fallbackPrice, offerPrefix, aspectName })`.
- Produces: `{ sku, offerId, name, sellPrice, oldPrice, stock }`, with existing edited fields taking precedence over derived source fields.

- [ ] **Step 1: Write the failing source-draft test**

Create a fixture with the two real source shapes:

```js
const variants = [
  { sku: "2757409016", name: "Подсачек, длина: 170 см", price: "30.84" },
  { sku: "2757419612", name: "Подсачек, длина: 210 см", price: "29.06", marketingPrice: "30.59" },
];
```

Assert literal results:

```js
assert.deepEqual(first, {
  sku: "2757409016",
  offerId: "jz-2757409016-01",
  name: "Подсачек, длина: 170 см",
  sellPrice: "30.84",
  oldPrice: "38.55",
  stock: "0",
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collect-edit-variant-row.test.mjs
```

Expected: FAIL because `app/src/collect-edit-variant-row.js` or its export does not exist.

- [ ] **Step 3: Implement the minimal pure normalizer**

Implement:

```js
export function normalizeCollectEditVariantRow({
  variant = {},
  index = 0,
  rowCount = 1,
  fallbackSku = "",
  fallbackTitle = "",
  fallbackPrice = "",
  offerPrefix = "jz-",
  aspectName = "",
} = {})
```

Rules:

```js
sku       = first(variant.sku, variant.variant_id, variant.product_id, variant.productId, fallbackSku)
offerId   = first(variant.offerId, variant.offer_id, generatedOfferId)
name      = first(variant.name, variant.title, variant.productName, variant.product_name, fallbackTitle), plus a non-duplicate aspect suffix
sellPrice = first(variant.sellPrice, variant.price?.price, variant.priceText, variant.price, variant.marketingPrice, variant.marketing_price, fallbackPrice)
oldPrice  = first(variant.oldPrice, variant.old_price, variant.price?.old_price, positive sell price * 1.25)
stock     = first(variant.stock, variant.quantity, variant.stocks?.present, "0")
```

- [ ] **Step 4: Verify GREEN and add preservation coverage**

Add a test where an edited draft supplies `offerId`, `sellPrice`, `name`, `oldPrice`, and `stock`; assert every edited literal is preserved. Re-run the focused test and require zero failures.

- [ ] **Step 5: Integrate the normalizer into the existing row adapter**

In `collectEditVariantRows`, replace the duplicated SKU/name/price/offer/old-price/stock derivation with `normalizeCollectEditVariantRow`. Keep the remaining images, source snapshot, category, attributes, logistics, and media fields unchanged.

During page initialization, when `draft.variants` exists, call `collectEditVariantRows` with an item whose `variants` are the persisted draft rows. Do not directly place raw draft rows into `variantRows`.

- [ ] **Step 6: Run focused and frontend regression tests**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collect-edit-variant-row.test.mjs app/tests/collect-edit-dictionary-match.test.mjs app/tests/collect-enrichment-view.test.mjs app/tests/category-readiness.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 7: Build and verify the real page read-only**

Run the Vite production build. Reload:

```text
http://127.0.0.1:3000/ozon/products/collect/edit/?id=collect_01f58aaf31bf8bdc28434a29
```

Verify both offer IDs and sell prices are non-empty, names remain present, and the footer no longer reports the combined variant requirement. Do not click save, preview, or submit.

- [ ] **Step 8: Commit only task files**

Stage the new helper, new test, and `App.jsx`, confirm staged diff scope, then commit:

```bash
git commit -m "fix: normalize persisted variant drafts"
```

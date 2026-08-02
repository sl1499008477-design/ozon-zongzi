# Collect Edit Dictionary ID Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ozon dictionary-backed category attributes automatically select the current target-store option when the captured source and target option share the same dictionary ID, even when their display languages differ.

**Architecture:** Add a small pure helper module that extracts bounded dictionary IDs from captured attributes and resolves them only against the current attribute's target-store option list. `App.jsx` keeps its existing category form and text fallback, but preserves source dictionary evidence long enough to normalize the initial control value to the target option value.

**Tech Stack:** React, Ant Design `Select`, JavaScript ES modules, Node.js built-in test runner, Vite.

## Global Constraints

- Dictionary ID matching has priority over display text matching.
- Text and existing multilingual alias matching remain the fallback when an ID is absent or has no target option.
- IDs may match only within the same Ozon attribute row and the current target store/category option list.
- Non-dictionary attributes, `Нет бренда`, permissions, APIs, database schema, and external Ozon calls must not change.
- The page must not overwrite a user-selected value when target dictionary options arrive later.

---

### Task 1: Pure Dictionary Evidence Resolver

**Files:**
- Create: `app/src/collect-edit-dictionary-match.js`
- Create: `app/tests/collect-edit-dictionary-match.test.mjs`

**Interfaces:**
- Produces: `collectEditDictionaryIdsOf(attribute): string[]`
- Produces: `resolveCollectEditDictionaryValue({ dictionaryIds, options, multiple }): { matchedById: boolean, value: string | string[] | undefined }`
- Consumes options shaped as `{ value, dictionaryValueId }`, which is the existing `collectEditFormatDictionaryOption` output.

- [ ] **Step 1: Write the failing tests**

Cover these exact behaviors:

```js
test("matches a target dictionary option by ID across display languages", () => {
  const ids = collectEditDictionaryIdsOf({
    key: "8229",
    value: "热水瓶",
    dictionary_value_id: 92576,
  });
  assert.deepEqual(resolveCollectEditDictionaryValue({
    dictionaryIds: ids,
    options: [{ value: "Термос", dictionaryValueId: 92576 }],
    multiple: false,
  }), { matchedById: true, value: "Термос" });
});

test("returns no ID match when only text fallback can decide", () => {
  assert.deepEqual(resolveCollectEditDictionaryValue({
    dictionaryIds: [],
    options: [{ value: "Термос", dictionaryValueId: 92576 }],
    multiple: false,
  }), { matchedById: false, value: undefined });
});

test("does not match a different dictionary ID", () => {
  assert.deepEqual(resolveCollectEditDictionaryValue({
    dictionaryIds: ["92577"],
    options: [{ value: "Термос", dictionaryValueId: 92576 }],
    multiple: false,
  }), { matchedById: false, value: undefined });
});

test("deduplicates matched values for a multi-select", () => {
  assert.deepEqual(resolveCollectEditDictionaryValue({
    dictionaryIds: ["1", "2", "1"],
    options: [
      { value: "Первый", dictionaryValueId: 1 },
      { value: "Второй", dictionaryValueId: 2 },
    ],
    multiple: true,
  }), { matchedById: true, value: ["Первый", "Второй"] });
});

```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test app/tests/collect-edit-dictionary-match.test.mjs
```

Expected: FAIL because `app/src/collect-edit-dictionary-match.js` does not exist.

- [ ] **Step 3: Implement the pure resolver**

Implementation requirements:

```js
const normalizedId = (value) => {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? text : "";
};

export function collectEditDictionaryIdsOf(attribute = {}) {
  // Read dictionary_value_id/dictionaryValueId from the root and from
  // values/collection entries, keep first-seen order, reject invalid IDs.
}

export function resolveCollectEditDictionaryValue({
  dictionaryIds = [],
  options = [],
  multiple = false,
} = {}) {
  // Match only option.dictionaryValueId/option.id against normalized IDs.
  // Return the target option.value, never the captured display text.
}

```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test app/tests/collect-edit-dictionary-match.test.mjs
```

Expected: 4 tests pass, 0 fail.

### Task 2: Integrate ID Resolution Into Category Attribute Defaults

**Files:**
- Modify: `app/src/App.jsx` near `collectEditAttributeRows`, `collectEditAttributeValueMap`, `categoryAttributeInputRows`, and the category-schema initialization effect.
- Modify: `app/tests/collect-edit-dictionary-match.test.mjs`

**Interfaces:**
- Consumes: `collectEditDictionaryIdsOf` and `resolveCollectEditDictionaryValue` from Task 1.
- Produces: `shouldApplyCollectEditDictionaryDefault({ currentValue, sourceValue, matchedById }): boolean` from the helper module.
- Produces: target dictionary values in `categoryAttributeValues[key]`, while preserving the existing `collectEditResolveSelectControlValue` text fallback.

- [ ] **Step 1: Add failing state-reconciliation behavior tests**

Extend the pure test with literal state transitions that model the page lifecycle:

```js
assert.equal(shouldApplyCollectEditDictionaryDefault({
  currentValue: "",
  sourceValue: "热水瓶",
  matchedById: true,
}), true);
assert.equal(shouldApplyCollectEditDictionaryDefault({
  currentValue: "热水瓶",
  sourceValue: "热水瓶",
  matchedById: false,
}), false);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test app/tests/collect-edit-dictionary-match.test.mjs
```

Expected: FAIL until the late-option reconciliation contract is implemented.

- [ ] **Step 3: Implement the reconciliation guard**

Add this pure export to `app/src/collect-edit-dictionary-match.js`:

```js
export function shouldApplyCollectEditDictionaryDefault({
  currentValue,
  sourceValue,
  matchedById,
} = {}) {
  // Return true only when an ID match exists and currentValue is blank or
  // still equals the untouched captured source value.
}
```

- [ ] **Step 4: Preserve dictionary evidence in source rows**

In `collectEditAttributeRows`, add `dictionaryIds: collectEditDictionaryIdsOf(attr)` to each row. Replace the value-only map with `sourceAttributeEvidenceMap`, keyed by the current attribute ID and carrying `{ value, dictionaryIds }`.

- [ ] **Step 5: Resolve the target option before text fallback**

For each category schema row:

```js
const sourceEvidence = sourceAttributeEvidenceMap.get(key) || { value: "", dictionaryIds: [] };
const idResolution = controlType === "select"
  ? resolveCollectEditDictionaryValue({
      dictionaryIds: sourceEvidence.dictionaryIds,
      options,
      multiple,
    })
  : { matchedById: false, value: undefined };
const sourceValue = categoryAttributeValues[key]
  ?? (isBrandSchema ? defaultValue : sourceEvidence.value || defaultValue);
const value = controlType === "select"
  ? (idResolution.matchedById
      ? idResolution.value
      : collectEditResolveSelectControlValue(sourceValue, { multiple, options }))
  : sourceValue;
```

Apply the same resolution when initializing `categoryAttributeValues`. If options load after the raw source text was installed, replace it only when the current value is blank or still equals the untouched captured source value. Preserve any different user-selected value.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --test app/tests/collect-edit-dictionary-match.test.mjs app/tests/category-dictionary-readiness.test.mjs app/tests/category-readiness.test.mjs app/tests/collect-enrichment-view.test.mjs
```

Expected: all tests pass.

### Task 3: Build and Live Regression

**Files:**
- Verify only; no new production files expected.

**Interfaces:**
- Consumes the current local item `collect_e1796a7049aa538f732e50d4` as a read-only browser fixture.
- Produces evidence that the displayed target value is `Термос` and the missing-field message no longer includes `类目属性「商品类型」`.

- [ ] **Step 1: Run the Web build**

Run:

```bash
node node_modules/vite/bin/vite.js build
```

from `app/`. Expected: exit 0.

- [ ] **Step 2: Reload the local edit page and inspect the exact item**

Open or reload:

```text
http://127.0.0.1:3000/ozon/products/collect/edit/?id=collect_e1796a7049aa538f732e50d4
```

Expected:

- 产品类目 remains `17027928 / 92576`.
- 商品类型 displays the target option `Термос`.
- The footer no longer contains `类目属性「商品类型」`.
- No form submission or Ozon external write is performed.

- [ ] **Step 3: Run final regression checks**

Run:

```bash
node --test app/tests/*.test.mjs
git diff --check
```

Expected: active App tests pass and no whitespace errors.

- [ ] **Step 4: Report delivery boundaries**

Report changed files, contracts, test results, live verification, unverified external Ozon submission, and rollback by restoring the helper/App/test changes. Do not claim an Ozon listing was submitted.

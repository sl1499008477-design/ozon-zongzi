# Target Store Category Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve source Ozon category evidence across the Collector boundary and resolve a safe, traceable `type_id` against the operating store selected in Web.

**Architecture:** Extend the existing additive enrichment payload with allowlisted category evidence, then reuse the existing Ozon import normalizer as the target-store resolver. A strict collection-edit policy accepts only a target-tree-validated numeric ID or a unique exact/normalized name match. Web stores and renders separate source and target resolution states.

**Tech Stack:** Chrome MV3 extension, Node.js ESM server, React 19, Ant Design, Node test runner, Vite.

## Global Constraints

- Collection stays account-scoped and must not accept account, store, Seller company, cookie, token, or portal-control fields.
- Target category resolution begins only after Web selects an operating store.
- Automatic text matching accepts unique exact or normalized equality only; partial, stem-only, AI, and fixed-code guesses remain pending.
- A numeric type candidate must exist in the selected store's real Ozon category tree before use.
- No database migration is allowed; additive data is stored in existing collection and listing-draft JSON.
- Existing `collector.ozon.enrichment.v1` consumers remain compatible.

---

### Task 1: Preserve Safe Source Category Evidence

**Files:**
- Modify: `extension/background/collector-ozon-enrichment-agent.js`
- Modify: `extension/tests/sync-capability-removed.test.js`
- Modify: `server/collector-ozon-enrichment-contract.mjs`
- Modify: `server/tests/collector-ozon-enrichment-contract.test.mjs`

**Interfaces:**
- Consumes: Seller-normalized `variantData.attributes[]`, `variantData.categories[]`, and `variantData.description_category_id`.
- Produces: additive `variantData` evidence with canonical `dictionary_value_id` and safe category path rows; normalized `sourceCategory` in the enrichment result.

- [ ] **Step 1: Write the failing agent projection test**

Extend the existing held-enrichment test input with:

```js
attributes: [
  { key: "8229", value: "Заварочный чайник", dictionary_value_id: 123456 },
  { key: "4497", value: "500" },
  { key: "9454", value: "300" },
  { key: "9455", value: "200" },
  { key: "9456", value: "100" },
],
categories: [
  { id: 17000000, level: 2, name: "家用电器", title: "家用电器", company_id: "must-not-cross" },
  { id: 17039736, level: 3, name: "Заварочный чайник", title: "Заварочный чайник" },
],
```

Assert that the posted payload retains `dictionary_value_id`, retains only `id`, `level`, `name`, and `title` for category rows, and omits `company_id` and arbitrary nested values.

- [ ] **Step 2: Run the projection test and verify RED**

Run:

```bash
node --test extension/tests/sync-capability-removed.test.js
```

Expected: the held-enrichment assertion fails because `dictionary_value_id` and `categories` are absent.

- [ ] **Step 3: Implement the minimal allowlisted projection**

Update `projectAttribute()` to copy a positive scalar dictionary ID under the canonical key:

```js
const dictionaryValueId = Number(attribute.dictionary_value_id ?? attribute.dictionaryValueId);
if (Number.isFinite(dictionaryValueId) && dictionaryValueId > 0) {
  projected.dictionary_value_id = dictionaryValueId;
}
```

Add `projectCategory()` that returns only positive `id`, finite `level`, and scalar `name`/`title`. Add projected categories only when at least one safe row remains.

- [ ] **Step 4: Run the projection test and verify GREEN**

Run the Step 2 command. Expected: all tests pass.

- [ ] **Step 5: Write the failing enrichment source-category contract test**

In `collector-ozon-enrichment-contract.test.mjs`, normalize a complete result containing category ID, type name, dictionary ID, and category path. Assert:

```js
assert.deepEqual(result.sourceCategory, {
  descriptionCategoryId: 17039736,
  typeName: "Заварочный чайник",
  typeIdCandidate: 123456,
  path: ["家用电器", "Заварочный чайник"],
});
```

- [ ] **Step 6: Run the contract test and verify RED**

Run:

```bash
node --test server/tests/collector-ozon-enrichment-contract.test.mjs
```

Expected: `sourceCategory` is undefined.

- [ ] **Step 7: Add the normalized optional source-category projection**

Add a focused helper in `collector-ozon-enrichment-contract.mjs` that reads attribute `8229`, canonical dictionary ID, and ordered category titles. Attach `sourceCategory` only when at least one source-category field exists. Do not add it to required enrichment fields.

- [ ] **Step 8: Run both Task 1 suites and commit**

Run both commands from Steps 2 and 6. Expected: all pass.

```bash
git add extension/background/collector-ozon-enrichment-agent.js extension/tests/sync-capability-removed.test.js server/collector-ozon-enrichment-contract.mjs server/tests/collector-ozon-enrichment-contract.test.mjs
git commit -m "fix: preserve Ozon source category evidence"
```

### Task 2: Resolve Category Against the Selected Store

**Files:**
- Modify: `server/ozon-import-normalizer.mjs`
- Modify: `server/tests/ozon-import-normalizer.test.mjs`

**Interfaces:**
- Consumes: `ctx.categoryMatchPolicy`, `ctx.targetStoreId`, `ctx.now()`, source category evidence, and `ctx.getCategoryTree()`.
- Produces: `{ items, warnings, categoryResolutions }`, where each resolution is keyed by `offerId` and has safe source, target, status, method, reason, and timestamp fields.

- [ ] **Step 1: Write failing numeric-candidate validation tests**

Add one test where `8229.dictionary_value_id` exists in the target tree and one where it does not. For the match, assert normalized target category IDs and:

```js
assert.deepEqual(result.categoryResolutions[0], {
  offerId: "candidate-valid",
  status: "MATCHED",
  method: "DICTIONARY_VALUE_ID",
  source: {
    descriptionCategoryId: 17039736,
    typeName: "Заварочный чайник",
    typeIdCandidate: 123456,
    path: [],
  },
  target: {
    storeId: "store-a",
    descriptionCategoryId: 17039736,
    typeId: 123456,
  },
  resolvedAt: "2026-08-01T00:00:00.000Z",
});
```

For an unknown ID, assert a pending record with `reason: "TARGET_TYPE_NOT_FOUND"` and no normalized item under non-strict preview mode.

- [ ] **Step 2: Run the normalizer test and verify RED**

Run:

```bash
node --test server/tests/ozon-import-normalizer.test.mjs
```

Expected: `categoryResolutions` is missing and the current fallback may produce a different outcome.

- [ ] **Step 3: Implement resolution records and validated numeric priority**

Refactor category resolution into a focused internal function that returns:

```js
{
  descriptionCategoryId,
  typeId,
  resolution: { offerId, status, method, source, target, resolvedAt },
}
```

Validate all numeric candidates with `findTypeCandidateById(tree, candidateId)` and take the parent category from the matched target-tree leaf. Use injected `ctx.now` in tests and `new Date()` otherwise.

- [ ] **Step 4: Run the numeric tests and verify GREEN**

Run the Step 2 command. Expected: all current and new numeric tests pass.

- [ ] **Step 5: Write failing exact-policy text tests**

Add cases for:

- one byte-for-byte exact name: `TYPE_NAME_EXACT`;
- one normalized case/punctuation match: `TYPE_NAME_NORMALIZED`;
- partial-only name: pending `TARGET_TYPE_NOT_FOUND`;
- two normalized-equal leaves: pending `TARGET_TYPE_AMBIGUOUS`.

Use `categoryMatchPolicy: "TARGET_STORE_EXACT"` and `strictTypeMatch: false`.

- [ ] **Step 6: Run the text-policy tests and verify RED**

Run the Step 2 command. Expected: partial matching is still accepted or ambiguity is not reported safely.

- [ ] **Step 7: Implement the target-store exact policy**

Add a strict matcher that returns a candidate only when exactly one unique target type has an exact or normalized-equal name. Preserve the existing broader matcher for other import entries so this feature does not change unrelated listing behavior.

When normalization cannot produce an item, retain the safe pending resolution alongside the warning. Do not include raw errors, credentials, or full tree data.

- [ ] **Step 8: Run the normalizer suite and commit**

Run the Step 2 command. Expected: all tests pass.

```bash
git add server/ozon-import-normalizer.mjs server/tests/ozon-import-normalizer.test.mjs
git commit -m "feat: resolve collected category by target store"
```

### Task 3: Expose and Persist Source/Target Category States in Web

**Files:**
- Modify: `server/index.mjs`
- Modify: `server/tests/import-preview-route.test.mjs`
- Modify: `app/src/category-readiness.js`
- Modify: `app/tests/category-readiness.test.mjs`
- Modify: `app/src/App.jsx`

**Interfaces:**
- Consumes: import-preview `categoryResolutions`, selected target store ID, existing request-scope guard, and collected `variantData` source evidence.
- Produces: preview `categoryResolution`; Web draft `categoryResolution`; separate source and target UI state; `MANUAL` resolution on cascader choice.

- [ ] **Step 1: Write the failing preview-route resolution test**

Change the preview fixture to omit top-level `type_id`, provide source attribute `8229.dictionary_value_id`, and mock `/v1/description-category/tree` plus attributes. Send `entry: "COLLECT_EDIT_AUTO_CATEGORY"`. Assert the response item has a safe `categoryResolution` with `target.storeId === storeId`, and assert no `/v3/product/import` call occurs.

- [ ] **Step 2: Run the preview-route test and verify RED**

Run:

```bash
node server/tests/import-preview-route.test.mjs
```

Expected: the preview has no resolution metadata and does not request the target tree for this fixture.

- [ ] **Step 3: Wire the strict preview policy and safe public response**

Pass these fields into the normalizer from `previewOzonProductImport()`:

```js
categoryMatchPolicy: body.entry === "COLLECT_EDIT_AUTO_CATEGORY"
  ? "TARGET_STORE_EXACT"
  : "DEFAULT",
targetStoreId: store.id,
```

Map `normalized.categoryResolutions[index]` into `publicImportPreviewItem()` as `categoryResolution`. Submission continues to send only `normalized.items` to Ozon.

- [ ] **Step 4: Run the route test and verify GREEN**

Run the Step 2 command. Expected: pass with zero product-import side effects.

- [ ] **Step 5: Write failing pure Web state tests**

Add tests for new helpers in `category-readiness.js`:

```js
sourceCategoryEvidenceOf(item)
categoryResolutionForStore(resolution, targetStoreId)
manualCategoryResolution({ source, targetStoreId, descriptionCategoryId, typeId, resolvedAt })
```

Assert that source evidence is derived from `variantData`, a resolution for store A is discarded for store B, and manual selection produces `method: "MANUAL"` without changing source evidence.

- [ ] **Step 6: Run the Web helper test and verify RED**

Run:

```bash
node --test app/tests/category-readiness.test.mjs
```

Expected: imports fail because the three helpers do not exist.

- [ ] **Step 7: Implement the pure Web state helpers**

Keep the helpers independent of React and Ant Design. Return cloned, plain JSON data and reject invalid or mismatched store-scoped target state.

- [ ] **Step 8: Run the Web helper test and verify GREEN**

Run the Step 6 command. Expected: all tests pass.

- [ ] **Step 9: Integrate the helpers into Collect Edit**

In `App.jsx`:

- derive source evidence from the collection item;
- accept only preview resolution matching `categoryStoreId`;
- clear stale target resolution when the selected store changes;
- include `categoryResolution` in `listingDraft`;
- create `MANUAL` metadata in `handleCategoryChange()`;
- render one source-category row and one target-store-category row in the existing product-category section;
- keep the cascader and current retry/error behavior.

- [ ] **Step 10: Add a source contract assertion and build**

Extend `app/tests/category-readiness.test.mjs` or the existing App source contract test to assert both labels and draft persistence wiring. Run:

```bash
node --test app/tests/category-readiness.test.mjs
pnpm --dir app build
```

Expected: tests and build pass.

- [ ] **Step 11: Commit Task 3**

```bash
git add server/index.mjs server/tests/import-preview-route.test.mjs app/src/category-readiness.js app/tests/category-readiness.test.mjs app/src/App.jsx
git commit -m "feat: show target store category resolution"
```

### Task 4: Package and Verify the Complete Flow

**Files:**
- Regenerate: `app/public/sonli-extension-0.13.46.1/`
- Regenerate: `app/public/sonli-extension-0.13.46.1.zip`
- Regenerate: `app/dist/sonli-extension-0.13.46.1.zip`
- Verify: all modified source and test files

**Interfaces:**
- Consumes: completed extension, server, and Web implementation.
- Produces: installable artifacts and evidence-backed verification results.

- [ ] **Step 1: Run focused regression suites**

```bash
node --test extension/tests/sync-capability-removed.test.js
node --test server/tests/collector-ozon-enrichment-contract.test.mjs
node --test server/tests/ozon-import-normalizer.test.mjs
node server/tests/import-preview-route.test.mjs
node --test app/tests/category-readiness.test.mjs
```

Expected: all pass with zero failures.

- [ ] **Step 2: Rebuild extension artifacts**

```bash
node scripts/package-extension.mjs
```

Expected: unpacked public directory and both ZIP files are regenerated.

- [ ] **Step 3: Verify packaged parity and archive integrity**

```bash
node scripts/check-extension-source-parity.mjs
unzip -t app/public/sonli-extension-0.13.46.1.zip
shasum -a 256 app/public/sonli-extension-0.13.46.1.zip app/dist/sonli-extension-0.13.46.1.zip
git diff --check
```

Expected: parity passes, ZIP integrity passes, both hashes match, and no whitespace errors exist.

- [ ] **Step 4: Run the complete verification gate**

Run the repository's established `scripts/verify.mjs` command with isolated test PostgreSQL, MinIO, encryption, admin-password, and Web-port environment values.

Expected: zero failures; PostgreSQL-only tests may be reported as configured skips when their explicit integration flag is disabled.

- [ ] **Step 5: Perform a real local flow check**

Reload the unpacked extension, collect a real Ozon product, open the resulting Web collection edit page, select an operating store, and verify:

- source category remains visible before target resolution;
- the target category resolves to numeric `description_category_id` and `type_id` when the target tree contains the dictionary candidate;
- switching stores cannot reuse the previous target result;
- a missing target candidate remains pending and the manual cascader works;
- no bundle or product-import write is triggered by category preview.

- [ ] **Step 6: Record delivery status**

Report modified contracts, test counts, real-flow evidence, unverified platform cases, rollback steps, and the requirement to reload the extension. Do not commit unrelated worktree files.

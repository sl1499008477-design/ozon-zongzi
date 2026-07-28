### Task 1: Record The Pre-Change Baseline And Recovery Boundary

**Files:**
- Create: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/baseline.md`
- Create: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/dirty-files-before.txt`
- Create: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/snapshots/before/`
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes: current dirty `main`, commit `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`, last verified 97/97 baseline.
- Produces: exact recovery record and pre-change copies for every file this plan may modify.

- [x] **Step 1: Confirm branch, commit and dirty scope without changing Git**

Run:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff --check
```

Expected:

- branch is `main`;
- commit is recorded, not assumed;
- existing unrelated changes are preserved;
- whitespace check exits 0.

- [x] **Step 2: Record the current category implementation locations**

Run:

```bash
rg -n "DESCRIPTION_CATEGORY_CACHE|getOzonDescriptionCategory|findDescriptionCategoryIdByTypeId|/ozon/categories/tree|categoryAttributesMatch|categoryAttributeValuesMatch" server/index.mjs
rg -n "getCategoryTree|getCategoryAttributes|getCategoryAttributeValues" server/ozon-import-normalizer.mjs app/src/App.jsx extension
wc -l server/index.mjs
```

Expected:

- all inline category functions and routes are inventoried;
- direct consumers are listed;
- current entry line count is recorded before lowering the guard.

- [x] **Step 3: Create ignored safety snapshots**

Create copies under:

```text
.superpowers/sdd/2026-07-28-ozon-category-query-extraction/snapshots/before/
```

Copy exactly:

```text
server/index.mjs
server/tests/module-boundaries.test.mjs
server/tests/cache-route-isolation.test.mjs
app/src/App.jsx
extension/content/1688-ai-wizard.js
extension/manifest.json
scripts/check-extension-source-parity.mjs
scripts/check-extension-diff-contract.mjs
docs/architecture/module-boundaries.md
```

Also save `git status --short` as `dirty-files-before.txt`.

Expected: snapshots exist outside tracked deliverables and contain the exact pre-change bytes.

- [x] **Step 4: Run the narrow pre-change baseline**

Run:

```bash
node server/tests/ozon-client.test.mjs
node server/tests/cache-route-isolation.test.mjs
node server/tests/import-preview-route.test.mjs
node server/tests/collect-listing-submit-failure.test.mjs
node server/tests/external-write-safety.test.mjs
node server/tests/module-boundaries.test.mjs
node app/tests/prototype-style-contract.test.mjs
```

Expected: all pass. Record exact outputs and any pre-existing failure in `baseline.md`.

- [x] **Step 5: Record the full-gate baseline**

If the local `sonli-postgres` test container is stopped, start only that local container:

```bash
docker start sonli-postgres
node scripts/verify.mjs
docker stop sonli-postgres
```

Expected:

- 97 tests pass, 0 fail, and all 19 verification checks pass;
- PostgreSQL is restored to its original stopped state;
- no Ozon request is made.

If the exact counts differ before implementation, record the new baseline rather than claiming a regression.

- [x] **Step 6: Review checkpoint**

Compare the planned file boundary with `git status --short`.

Expected: no product code has changed during Task 1.

---

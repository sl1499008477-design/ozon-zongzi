# Active FBS Listing Warehouses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep all synchronized warehouse history in storage while allowing the collect-box listing flow to display and submit only the target store's active FBS warehouses.

**Architecture:** Add one pure eligibility policy that owns the stable reason codes and evaluates warehouse records against store-scoped active-product stock evidence. The authenticated local-state response annotates every visible warehouse with this policy result, the collect-box view consumes only that additive contract, and both JSON-state listing routes and the PostgreSQL submission boundary revalidate the selected Ozon warehouse ID before any external write or task creation.

**Tech Stack:** Node.js ESM, React, Ant Design, PostgreSQL, `node:test`, existing project verification scripts.

## Global Constraints

- Follow `AGENTS.md`: preserve account/store boundaries, validate on the backend, keep the API additive and stable, make external-write prevention testable, and report verification plus rollback.
- Do not delete, archive, or migrate warehouse, product, or `product_stocks` data.
- Do not use warehouse names, name prefixes, current stock quantity, or internal `wh_*` IDs as eligibility evidence.
- Treat only normalized warehouse type `fbs` as eligible; FBO, FBP, rFBS, aggregate placeholders, disabled records, and archived-only associations must remain unavailable.
- A zero-stock FBS row still proves association when its product is not archived.
- Keep the user's unrelated modified planning files and the existing unrelated worktree untouched.

---

## Task 1: Define the Pure Active-FBS Eligibility Policy

**Files:**
- Create: `server/listing-warehouse-eligibility.mjs`
- Create: `server/tests/listing-warehouse-eligibility.test.mjs`

- [ ] **Step 1: Write failing policy tests for every accepted and rejected state**

Cover these exact cases in a table-driven `node:test` suite:

```js
{
  warehouse: {
    storeId: "store-a",
    warehouse_id: "1020003087687000",
    warehouse_type: "FBS",
    status: "active",
    is_active: true,
    is_archived: false,
  },
  products: [{
    storeId: "store-a",
    is_archived: false,
    warehouse_stocks: [{
      warehouse_id: "1020003087687000",
      source: "fbs",
      present: 0,
    }],
  }],
  expected: { eligible: true, code: "ELIGIBLE_ACTIVE_FBS" },
}
```

Also assert stable results for `STORE_SCOPE_MISMATCH`, `TYPE_NOT_FBS`, `WAREHOUSE_ID_MISSING`, `WAREHOUSE_DISABLED`, and `NO_ACTIVE_PRODUCT_ASSOCIATION`; include cross-store products, archived-only products, mixed archived/current products, zero stock, FBO, FBP, rFBS, internal-only `wh_*` IDs, and explicit inactive/archived flags.

- [ ] **Step 2: Run the new test and confirm RED**

Run:

```bash
node --test server/tests/listing-warehouse-eligibility.test.mjs
```

Expected: failure because the policy module does not exist.

- [ ] **Step 3: Implement the smallest pure policy contract**

Export immutable reason codes plus these focused functions:

```js
export const LISTING_WAREHOUSE_ELIGIBILITY_CODES = Object.freeze({
  eligible: "ELIGIBLE_ACTIVE_FBS",
  storeMismatch: "STORE_SCOPE_MISMATCH",
  typeMismatch: "TYPE_NOT_FBS",
  missingWarehouseId: "WAREHOUSE_ID_MISSING",
  disabled: "WAREHOUSE_DISABLED",
  noActiveProductAssociation: "NO_ACTIVE_PRODUCT_ASSOCIATION",
});

export function listingWarehouseEligibility({
  warehouse,
  products,
  targetStoreId,
  accountId,
  hasActiveProductAssociation,
} = {}) { /* return only { eligible, code } */ }

export function assertListingWarehouseEligible(input = {}) { /* throw stable 422 */ }
```

Implementation details:

- Normalize snake/camel-case store, account, type, ID, status, and boolean fields without inspecting warehouse names.
- Accept a platform ID only from `warehouse_id` / `warehouseId`, reject empty values and values beginning with `wh_`.
- Examine product stock arrays already supported by the project (`warehouse_stocks`, `warehouseStocks`, and nested stock containers), require a matching platform ID and FBS source, and ignore the numeric stock amount.
- Treat product `is_archived`, `archived`, archived status, or archived visibility as archived evidence.
- Let PostgreSQL callers pass the already-computed boolean `hasActiveProductAssociation`; keep the ordering of reason checks stable so the same bad record returns the same code everywhere.
- `assertListingWarehouseEligible` must throw status `422`, code `LISTING_WAREHOUSE_NOT_ELIGIBLE`, message `请选择当前店铺的活跃 FBS 仓库`, and `body.reason` equal to the policy code.

- [ ] **Step 4: Run the policy test and confirm GREEN**

Run:

```bash
node --test server/tests/listing-warehouse-eligibility.test.mjs
```

Expected: all policy cases pass.

- [ ] **Step 5: Commit the pure policy**

```bash
git add server/listing-warehouse-eligibility.mjs server/tests/listing-warehouse-eligibility.test.mjs
git commit -m "feat: define active FBS warehouse eligibility"
```

---

## Task 2: Add Eligibility to the Authenticated Warehouse Contract

**Files:**
- Modify: `server/index.mjs:788-835`
- Modify: `server/tests/account-store-isolation.test.mjs:28-105`

- [ ] **Step 1: Extend the local-state isolation fixture with representative warehouses and products**

Add, for one account/store, an active FBS with a zero-stock current-product association, an FBO warehouse, an archived-only FBS, and a second account's eligible-looking FBS. Assert:

```js
assert.deepEqual(activeFbs.listingEligibility, {
  eligible: true,
  code: "ELIGIBLE_ACTIVE_FBS",
});
assert.equal(fbo.listingEligibility.code, "TYPE_NOT_FBS");
assert.equal(archivedOnly.listingEligibility.code, "NO_ACTIVE_PRODUCT_ASSOCIATION");
assert.equal(payloadA.caches.warehouses.some((row) => row.warehouse_id === foreignId), false);
```

- [ ] **Step 2: Run the scoped-state test and confirm RED**

Run:

```bash
node --test server/tests/account-store-isolation.test.mjs
```

Expected: warehouse entries do not yet contain `listingEligibility`.

- [ ] **Step 3: Annotate only already-account-scoped warehouse records**

In `localStatePayload`:

1. Build account-scoped product and warehouse arrays first.
2. Map every visible warehouse to a new object with additive `listingEligibility`.
3. Pass the authenticated account ID, that warehouse's store ID, and only the already-scoped products into the pure policy.
4. Preserve every existing warehouse field and do not mutate `state.caches`.

The public shape must remain:

```json
{
  "warehouse_id": "1020003087687000",
  "listingEligibility": {
    "eligible": true,
    "code": "ELIGIBLE_ACTIVE_FBS"
  }
}
```

- [ ] **Step 4: Run isolation and policy tests**

Run:

```bash
node --test server/tests/listing-warehouse-eligibility.test.mjs server/tests/account-store-isolation.test.mjs
```

Expected: both pass, including no cross-account evidence leakage.

- [ ] **Step 5: Commit the additive API contract**

```bash
git add server/index.mjs server/tests/account-store-isolation.test.mjs
git commit -m "feat: expose listing warehouse eligibility"
```

---

## Task 3: Make the Collect-Box UI Consume Only the Backend Contract

**Files:**
- Modify: `app/src/collect-box-target-store.js:47-78`
- Modify: `app/tests/collect-box-target-store.test.mjs:120-190`
- Modify: `app/src/App.jsx:5589-5619`
- Modify: `app/src/App.jsx:6790-6801`
- Modify: `scripts/check-collect-edit-listing-contract.mjs`

- [ ] **Step 1: Write failing frontend model tests**

Update the target-store fixture so its warehouses include:

- target-store active FBS with `listingEligibility.eligible=true`;
- same-store FBO and archived FBS with `eligible=false`;
- another store's eligible FBS;
- a legacy record with no `listingEligibility`.

Assert `listingPreparationModel(...).warehouses` contains only the target-store record explicitly marked eligible. Also assert a target store with no eligible records returns an empty array.

- [ ] **Step 2: Run the model tests and confirm RED**

Run:

```bash
node --test app/tests/collect-box-target-store.test.mjs
```

Expected: the model still returns ineligible or legacy warehouses.

- [ ] **Step 3: Filter in the target-store model and simplify the page**

- In `listingPreparationModel`, retain the existing target-store boundary and additionally require `warehouse.listingEligibility?.eligible === true`.
- In `CollectEditPage`, remove the local `warehouseIsActive` / `warehouseIsWritableFbs` chain from `listingWarehouseOptions`.
- Use the Ozon platform ID first:

```js
const id = warehouse.warehouse_id || warehouse.warehouseId;
```

- Keep deduplication by platform ID.
- Do not delete the generic warehouse helpers if other inventory views still use them.
- Change the empty-state copy exactly to `当前店铺暂无活跃 FBS 仓库，请先完成商品同步`.

- [ ] **Step 4: Add a static contract guard against heuristic regression**

Extend `scripts/check-collect-edit-listing-contract.mjs` to require the eligibility check in `listingPreparationModel`, require the platform-ID-first option mapping and empty-state copy, and reject `CollectEditPage` filtering based on `warehouse_type !== "fbp"` or warehouse names.

- [ ] **Step 5: Run focused UI checks**

Run:

```bash
node --test app/tests/collect-box-target-store.test.mjs
node scripts/check-collect-edit-listing-contract.mjs
pnpm --dir app build
```

Expected: tests, contract guard, and production build pass.

- [ ] **Step 6: Commit the UI contract consumer**

```bash
git add app/src/collect-box-target-store.js app/tests/collect-box-target-store.test.mjs app/src/App.jsx scripts/check-collect-edit-listing-contract.mjs
git commit -m "fix: show only eligible FBS listing warehouses"
```

---

## Task 4: Revalidate JSON-State Preview and Submit Before Any Side Effect

**Files:**
- Modify: `server/index.mjs:2180-2460`
- Modify: `server/tests/collect-listing-submit-failure.test.mjs`

- [ ] **Step 1: Add route fixtures for eligible and ineligible selections**

Populate the existing route test state with warehouse and product records for:

- eligible FBS associated with a current product;
- FBO;
- FBS associated only with an archived product;
- FBS belonging to another account/store;
- a placeholder with no platform ID.

For both `preview` and `submit`, directly send each ineligible ID and assert:

```js
assert.equal(response.status, 422);
assert.equal(response.body.code, "LISTING_WAREHOUSE_NOT_ELIGIBLE");
assert.equal(response.body.message, "请选择当前店铺的活跃 FBS 仓库");
assert.equal(response.body.reason, expectedReason);
assert.equal(externalWriteCalls, 0);
```

Also assert no listing task/job is created and the eligible FBS proceeds to the next existing validation or preview boundary.

- [ ] **Step 2: Run the route test and confirm RED**

Run:

```bash
node --test server/tests/collect-listing-submit-failure.test.mjs
```

Expected: current route accepts the structurally valid but ineligible warehouse selection.

- [ ] **Step 3: Add the route-level guard**

After `listingStockRowsFromDraft` builds the request stocks and before preview, queue creation, or Ozon calls:

1. Resolve every requested ID strictly against the target store's account-scoped warehouses by Ozon `warehouse_id` only.
2. Pass the matched warehouse plus the target store's account-scoped products into `assertListingWarehouseEligible`.
3. For a missing or foreign ID, supply a non-disclosing scope-mismatch result; do not reveal another store's name or ID.
4. Preserve `reason` in the existing route error body and retain the same behavior for preview and submit.

- [ ] **Step 4: Run route, policy, and isolation tests**

Run:

```bash
node --test server/tests/listing-warehouse-eligibility.test.mjs server/tests/account-store-isolation.test.mjs server/tests/collect-listing-submit-failure.test.mjs
```

Expected: all pass; invalid selections produce 422 before any external write.

- [ ] **Step 5: Commit the route guard**

```bash
git add server/index.mjs server/tests/collect-listing-submit-failure.test.mjs
git commit -m "fix: guard collect listing warehouse selection"
```

---

## Task 5: Enforce the Same Rule at the PostgreSQL Submission Boundary

**Files:**
- Modify: `server/listing-pipeline.mjs:523-558`
- Modify: `server/tests/listing-pipeline-v3.integration.mjs:120-160`
- Modify: `server/tests/listing-pipeline-v3.integration.mjs:540-590`

- [ ] **Step 1: Extend dedicated PostgreSQL fixtures with stock associations**

Insert `products` and `product_stocks` rows for an eligible active FBS, archived-only FBS, FBO, zero-stock current-product FBS, and the second store. Update existing happy-path fixtures so platform warehouse ID `1` has a non-archived FBS association.

- [ ] **Step 2: Add failing integration assertions**

Using the existing listing preparation helper, assert that:

- eligible active FBS succeeds;
- zero-stock associated FBS succeeds;
- FBO, archived-only FBS, internal `wh_*` ID, and other-store FBS each throw status `422`, code `LISTING_WAREHOUSE_NOT_ELIGIBLE`, and the expected non-sensitive `reason`;
- rejected cases create no submission snapshot, job, outbox event, or Ozon call.

- [ ] **Step 3: Run the PostgreSQL test when a dedicated test database is configured and confirm RED**

Run:

```bash
node server/tests/listing-pipeline-v3.integration.mjs
```

Expected with dedicated PostgreSQL test configuration: new rejection assertions fail before implementation. If the repository's explicit test-database guard skips the file, record the skip exactly and do not point it at production.

- [ ] **Step 4: Replace the broad active-warehouse query with strict evidence lookup**

In `assertListingStocksBelongToTarget`:

- match requested values to `warehouses.warehouse_id` only;
- scope through `stores.owner_account_id` and exact `store_id`;
- return each warehouse's type/status/flags/platform ID plus an `EXISTS` boolean over same-store `product_stocks` joined to non-archived `products` with FBS source;
- pass each result into the shared pure policy with `hasActiveProductAssociation`;
- return the same stable 422 error contract as the JSON route;
- do not query warehouse names or stock amounts.

- [ ] **Step 5: Run PostgreSQL and non-PostgreSQL boundary tests**

Run:

```bash
node --test server/tests/listing-warehouse-eligibility.test.mjs server/tests/listing-submission-policy.test.mjs
node server/tests/listing-pipeline-v3.integration.mjs
```

Expected: unit tests pass; integration passes when the dedicated test DB is present or reports only its existing configuration skip.

- [ ] **Step 6: Commit the PostgreSQL boundary**

```bash
git add server/listing-pipeline.mjs server/tests/listing-pipeline-v3.integration.mjs
git commit -m "fix: enforce active FBS at listing boundary"
```

---

## Task 6: Verify Live Local Data and Full Regression Gates

**Files:**
- Modify only if a test exposes a scoped defect in files already named above.

- [ ] **Step 1: Verify the current local snapshot without modifying it**

Use a read-only query or authenticated local-state request to confirm:

- all existing warehouse rows are still present;
- only `CEL-陆运` and `CEL-陆空联运` have `listingEligibility.eligible=true` for the current store;
- UNI archived-only warehouses, FBO, rFBS, FBP, and aggregate placeholder records remain stored but are ineligible;
- neither warehouse name nor positive stock was needed for the result.

- [ ] **Step 2: Run the focused regression suite**

Run:

```bash
node --test \
  server/tests/listing-warehouse-eligibility.test.mjs \
  server/tests/account-store-isolation.test.mjs \
  server/tests/collect-listing-submit-failure.test.mjs \
  server/tests/listing-submission-policy.test.mjs \
  app/tests/collect-box-target-store.test.mjs
node scripts/check-collect-edit-listing-contract.mjs
pnpm --dir app build
```

Expected: all focused checks pass.

- [ ] **Step 3: Run the full repository verification gate**

Run:

```bash
pnpm verify
```

Expected: active suite, app build, extension parity, static contracts, isolation checks, compose interpolation, personal-data scan, and diff checks pass. Record every configured PostgreSQL-only skip separately from failures.

- [ ] **Step 4: Check repository scope before finalizing**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -8
```

Expected: only this feature's committed files plus the user's pre-existing unrelated modified planning files are present; no database dump, credentials, generated secrets, or unrelated worktree changes are staged.

- [ ] **Step 5: Perform a browser smoke test if the local app is running**

On the collect-box edit page:

1. Select the current operating store.
2. Open “上架仓库” and verify only `CEL-陆运` and `CEL-陆空联运` appear for the current local snapshot.
3. Switch to a store with no active FBS evidence and verify the exact empty-state message.
4. Confirm a stale ineligible saved warehouse no longer makes the listing form ready.
5. Confirm product/inventory pages can still read complete historical warehouse data.

- [ ] **Step 6: Final delivery report**

Report:

- code and contract changes;
- exact tests and verification results;
- old functions/pages regression-checked;
- PostgreSQL integration coverage or its explicit configuration skip;
- remaining risks, if any;
- rollback: revert the feature commits; no database restoration is required because no rows or schema were changed.


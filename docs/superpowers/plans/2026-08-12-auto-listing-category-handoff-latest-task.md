# Auto-Listing Category Handoff and Latest Task Rows Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Reuse the current target store's verified Ozon category when creating a Collect Box auto-listing job, show only the newest task row for each product/store pair, and display the job creation time.

**Architecture:** Keep category resolution as a store-scoped read projection: the service validates the target store first, then the repository overlays one exact `MATCHED` resolution onto a copy of the listing draft without updating `product_drafts`. Keep every historical job and audit row, but make `listJobs()` rank item rows by `(source_record_id, target_store_id)` in PostgreSQL before applying `limit`; the single-job read path remains unchanged. Derive the visible row's creation time from `auto_listing_jobs.created_at`, and keep all failure copy on the frontend's fixed safe-code map.

**Tech Stack:** Node.js ESM, PostgreSQL 16+, React 19, Ant Design, Node's built-in test runner, pnpm/Vite, disposable Docker PostgreSQL, loopback fake Ozon transport.

**Business acceptance:**

- The current item `collect_ccab18d873aa2c8074555143` can use its exact `MATCHED` `OZON:DEFAULT` resolution for store `local_a936f178c376`; a newly created job is not blocked by `AUTO_LISTING_SOURCE_CATEGORY_REQUIRED`.
- Cross-account, cross-item, cross-store, non-`MATCHED`, incomplete, or non-default-taxonomy resolutions are never reused.
- The original `product_drafts.data` remains unchanged; only the immutable auto-listing source snapshot receives the resolved target category.
- The ordinary list returns one newest row per `(sourceRecordId, targetStoreId)`, after which `limit` is applied. Different stores remain separate, and historical jobs remain readable by job ID.
- The table displays the real job creation time and the exact safe category message `缺少当前店铺可用的 Ozon 类目资料`.
- No real Ozon write, paid AI execution, production database, or schema migration is permitted.

---

## Task 1: Define the store-scoped category handoff contract

**Files:**

- Modify: `server/tests/auto-listing-repository.test.mjs`
- Modify: `server/tests/auto-listing-service.test.mjs`
- Modify: `server/auto-listing-repository.mjs`
- Modify: `server/auto-listing-service.mjs`
- Reference: `server/collect-category-resolution-policy.mjs`
- Reference: `server/auto-listing-source-snapshot.mjs`

### Step 1: Write the failing repository contract tests

Extend the Collect Box source test so `loadCollectSources()` is called with the closed input:

```js
await repository.loadCollectSources({
  accountId: "account-a",
  collectItemIds: ["collect-draft"],
  targetStoreId: "store-a",
});
```

Have the fake row contain an exact resolution projection and assert that the returned `collectItem.listingDraft` copy contains:

```js
{
  descriptionCategoryId: "17029003",
  typeId: "970861825",
  categoryResolution: {
    status: "MATCHED",
    method: "TYPE_ID_EXACT",
    taxonomyScope: "OZON:DEFAULT",
    target: {
      storeId: "store-a",
      descriptionCategoryId: "17029003",
      typeId: "970861825",
      ancestorCategoryIds: [],
    },
    displayPath: { zh: ["运动与休闲", "船只和舷外发动机", "船舶配件"] },
    validatedAt: "2026-08-11T20:06:00.062Z",
  },
}
```

Also assert all of the following fail closed by returning the unmodified draft: another store, another item/account, status other than `MATCHED`, scope other than `OZON:DEFAULT`, missing credential store, and either target ID missing/non-positive. Assert the query binds account, item IDs, target store, and the exact taxonomy constant as parameters rather than interpolated SQL.

### Step 2: Write the failing service-order tests

Update the fake repository to record calls, then assert a Collect Box request executes in this order:

```text
getJobByIdempotencyKey
loadTargetStore
loadCollectSources(accountId, collectItemIds, targetStoreId)
loadTargetWarehouse
...
```

Add negative cases proving an absent, foreign-account, inactive, or unsupported-currency store stops before `loadCollectSources`, RFBS verification, listing-base preparation, or graph writes. Keep the idempotent replay test first: a replay still returns before loading the store or source.

Add an Excel regression showing its already-frozen source path still loads and validates the target store exactly once before creating the graph.

### Step 3: Run the focused tests and observe RED

Run:

```bash
node --test \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-service.test.mjs
```

Expected: new tests fail because `loadCollectSources` has no `targetStoreId` contract, does not read category resolutions, and the service still loads sources before validating the store.

### Step 4: Implement the repository overlay

In `server/auto-listing-repository.mjs`:

1. Import `TAXONOMY_SCOPE_OZON_DEFAULT` from `collect-category-resolution-policy.mjs`.
2. Require and normalize `targetStoreId` in `loadCollectSources({ accountId, collectItemIds, targetStoreId })`.
3. Add one tenant/item/store-scoped lateral join to `collect_category_resolutions` that requires:
   - same `account_id` and `collect_item_id`;
   - `taxonomy_scope = TAXONOMY_SCOPE_OZON_DEFAULT`;
   - `status = 'MATCHED'`;
   - `credential_store_id = targetStoreId`;
   - both target IDs positive and non-null.
4. Return only the safe fields needed for the immutable snapshot: target IDs, method, scope, display path, and validated timestamp.
5. Build a new `listingDraft` object. Overlay the resolved IDs and `categoryResolution` only when the full tuple is valid; otherwise preserve the old draft unchanged.
6. Use `ancestorCategoryIds: []` because the current resolution table stores display labels, not verified ancestor IDs. Do not derive IDs from labels and do not write anything back to `product_drafts`.

The SQL must remain a read-only query and must not expose the resolution's failure details or raw category response.

### Step 5: Implement validate-store-before-source ordering

In `server/auto-listing-service.mjs`:

1. Extract one focused helper that loads `storage.loadTargetStore()` and applies the existing account, active-state, and currency validation.
2. Change the internal `createFromSources()` contract to receive the already validated `targetStore` instead of loading it itself.
3. In `createAutoListingJob()`, retain permission/request/config/idempotency ordering, then validate the store, then call:

```js
storage.loadCollectSources({ accountId, collectItemIds, targetStoreId: targetStore.id })
```

4. In `createExcelAutoListingJob()`, validate the target store from the frozen config after import/replay validation and pass the validated store into the same internal flow.
5. Do not reorder the existing warehouse eligibility, published strategy, upload policy, RFBS read-only verification, or atomic graph creation after this boundary.

### Step 6: Run focused tests and confirm GREEN

Run the same two-file command. Expected: all tests pass with zero skip.

### Step 7: Commit the contract and implementation

```bash
git add \
  server/auto-listing-repository.mjs \
  server/auto-listing-service.mjs \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-service.test.mjs
git commit -m "fix(auto-listing): hand off resolved target category"
```

---

## Task 2: Return only the newest item row per product and store

**Files:**

- Modify: `server/tests/auto-listing-repository.test.mjs`
- Modify: `server/tests/auto-listing-postgres.integration.mjs`
- Modify: `server/auto-listing-repository.mjs`
- Test: `server/tests/auto-listing-service.test.mjs`
- Test: `server/tests/auto-listing-routes.test.mjs`

### Step 1: Write the failing repository ranking tests

Add a unit test for `listJobs({ accountId, limit })` whose fake SQL result represents:

- two historical jobs for source `collect-a` and store `store-a`;
- one job for `collect-a` and `store-b`;
- one job containing more than one item;
- enough older duplicates to exceed a small list limit.

Assert the SQL uses a window rank equivalent to:

```sql
ROW_NUMBER() OVER (
  PARTITION BY snapshot.source_record_id, item.target_store_id
  ORDER BY job.created_at DESC, job.id DESC, item.id ASC
)
```

and applies `LIMIT` only after `rank = 1`.

Assert the repository returns jobs in newest-job order, but each returned job contains only the item IDs selected by the ranked query. Filter item-scoped events with the same selected-item set so a list projection cannot carry a stale sibling's audit details. Keep job-level events if present.

### Step 2: Add the real PostgreSQL behavior test

In `server/tests/auto-listing-postgres.integration.mjs`, create historical graphs that prove:

1. same source + same store returns only the newest item;
2. same source + different store returns one item for each store;
3. two distinct products survive even when many old duplicates would otherwise consume the limit;
4. `getJob({ jobId: oldJobId })` still returns the old job;
5. direct row counts for jobs/items/events remain unchanged after listing.

Use fixed `created_at` values or the existing injected clock so the expected newest row is deterministic. Do not delete or update historical rows to make the assertion pass.

### Step 3: Run unit tests and observe RED

Run:

```bash
node --test server/tests/auto-listing-repository.test.mjs
```

Expected: the new list test fails because the current query limits jobs before any item-level grouping.

The PostgreSQL test remains explicitly gated until Task 4 starts the disposable database.

### Step 4: Implement the ranked list projection

Replace the current `SELECT id FROM auto_listing_jobs ... LIMIT` list query with a CTE that joins:

- `auto_listing_jobs`;
- `auto_listing_job_items`;
- `auto_listing_source_snapshots`.

Rank within `(source_record_id, target_store_id)`, select `rank = 1`, order by job creation time/job ID/item ID, and then apply `limit`. Return `job_id` and `item_id` from the query. `auto_listing_job_items` has no persisted source-order column; use the existing item-ID ordering as the deterministic same-job tie rule instead of inventing schema state.

Group those ordered rows by job ID, call the unchanged `readJobWithClient()` for each selected job, and filter its `items` and item-scoped `events` to the selected item IDs. Do not change `getJob()` or idempotency replay reads; those endpoints must continue to return full historical jobs.

Treat `limit` as the maximum number of visible item rows, which matches the ordinary table contract. Preserve the existing 1–100 bound and tenant predicate on every joined table.

### Step 5: Run non-PG regression tests

Run:

```bash
node --test \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  server/tests/auto-listing-routes.test.mjs
```

Expected: all pass; list DTOs remain closed and historical detail/replay contracts are unchanged.

### Step 6: Commit the list projection

```bash
git add \
  server/auto-listing-repository.mjs \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-postgres.integration.mjs
git commit -m "fix(auto-listing): list latest task per product store"
```

---

## Task 3: Add safe category copy and the real job creation time

**Files:**

- Modify: `app/tests/auto-listing-view.test.mjs`
- Modify: `app/tests/auto-listing-page-contract.test.mjs`
- Modify: `app/src/auto-listing-view.js`
- Modify: `app/src/AutoListingPage.jsx`
- Test: `server/tests/auto-listing-routes.test.mjs`

### Step 1: Write the failing presentation tests

In `app/tests/auto-listing-view.test.mjs`:

1. Assert `AUTO_LISTING_SOURCE_CATEGORY_REQUIRED` maps exactly to `缺少当前店铺可用的 Ozon 类目资料`.
2. Add a pure row-projection test for a job with `jobId`, `createdAt`, and one item. The projected row must carry `jobId` and `jobCreatedAt` from the owning job while retaining the item command fields.
3. Assert malformed jobs/items or an invalid timestamp fail closed to an empty ID/time rather than displaying arbitrary backend text.

In `app/tests/auto-listing-page-contract.test.mjs`, require the visible `创建时间` column and assert it renders `jobCreatedAt`, not item `updatedAt` or an invented current time.

Extend the list route test so the job's `createdAt` survives the route's safe DTO while unknown fields and event details remain absent.

### Step 2: Run the focused tests and observe RED

Run:

```bash
node --test \
  app/tests/auto-listing-view.test.mjs \
  app/tests/auto-listing-page-contract.test.mjs \
  server/tests/auto-listing-routes.test.mjs
```

Expected: failures for the missing safe copy, row projection, and table column.

### Step 3: Implement the pure row projection and safe copy

In `app/src/auto-listing-view.js`:

1. Add the exact category failure mapping to the closed `FAILURE` table.
2. Export a small `autoListingTaskRows(jobs)` presenter that flattens safe job DTOs into visible item rows and adds only:

```js
{ jobId: job.jobId, jobCreatedAt: job.createdAt }
```

3. Validate IDs/timestamps using the module's existing plain-data approach. Do not copy arbitrary top-level job fields into rows.

In `app/src/AutoListingPage.jsx`:

1. Replace the local `safeRows()` helper with `autoListingTaskRows()`.
2. Add a focused local time formatter that returns `—` for absent/invalid values and otherwise uses the browser's local timezone.
3. Add a `创建时间` column bound to `jobCreatedAt`.
4. Keep `jobId` available for commands, but do not add a visible internal-ID column.

### Step 4: Run frontend and route tests

Run the same three-file command. Expected: all pass with zero skip.

### Step 5: Build the app

Run:

```bash
pnpm --dir app build
```

Expected: production build succeeds. Existing chunk-size warnings may be recorded but are not failures.

### Step 6: Commit the presentation change

```bash
git add \
  app/src/auto-listing-view.js \
  app/src/AutoListingPage.jsx \
  app/tests/auto-listing-view.test.mjs \
  app/tests/auto-listing-page-contract.test.mjs \
  server/tests/auto-listing-routes.test.mjs
git commit -m "fix(auto-listing): clarify latest task rows"
```

---

## Task 4: Prove the complete behavior with real PostgreSQL and fake Ozon

**Files:**

- Modify: `server/tests/auto-listing-postgres.integration.mjs`
- Modify: `server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs`
- Modify: `docs/verification/2026-08-12-auto-listing-category-handoff-latest-task.md`
- Test: all files changed in Tasks 1–3

### Step 1: Add the end-to-end category fixture

In the existing RFBS first-listing E2E, add a Collect Box source whose `product_drafts.data` deliberately has blank direct target category IDs but whose `collect_category_resolutions` row is:

```text
account/item/store: exact current tuple
taxonomy: OZON:DEFAULT
status: MATCHED
description category: positive
type: positive
```

Run the actual creation service and repository, plus the existing loopback fake Ozon read verifier. Assert:

- the created item is not `BLOCKED` for category;
- the immutable source snapshot has the exact resolved target IDs and target store;
- the original `product_drafts.data` remains byte-for-byte/JSON-equal to its blank-category value;
- a foreign store's resolution is not reused;
- no fake Ozon product import or stock write occurs during job creation.

Do not start the paid AI worker and do not approve/upload the generated item.

### Step 2: Start a disposable PostgreSQL instance

Use a random loopback port, no named volume, and a task-specific container name. Apply all repository migrations. Export only task-specific test variables:

```bash
AUTO_LISTING_POSTGRES_TESTS=1
SONLI_MIGRATION_TEST_DATABASE_URL=postgresql://.../...
```

Never point the test at the local development or production database.

### Step 3: Run the real PostgreSQL RED/GREEN matrix serially

Run the PostgreSQL suites serially to avoid migration/schema concurrency:

```bash
node --test --test-concurrency=1 \
  server/tests/auto-listing-postgres.integration.mjs \
  server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs
```

Expected: category overlay, draft immutability, latest-per-product/store projection, history preservation, and fake-Ozon E2E all pass with zero skip.

Then run the adjacent non-PG matrix:

```bash
node --test \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  server/tests/auto-listing-routes.test.mjs \
  server/tests/auto-listing-source-snapshot.test.mjs \
  server/tests/collect-category-resolution-contract.test.mjs \
  server/tests/collect-category-resolution-repository.test.mjs \
  server/tests/listing-warehouse-eligibility.test.mjs \
  app/tests/auto-listing-view.test.mjs \
  app/tests/auto-listing-page-contract.test.mjs
```

### Step 4: Run syntax, diff, and production build gates

Run:

```bash
node --check server/auto-listing-repository.mjs
node --check server/auto-listing-service.mjs
node --check app/src/auto-listing-view.js
git diff --check
pnpm --dir app build
```

Record exact pass/fail/skip counts. Do not describe an environment-gated or interrupted suite as passed.

### Step 5: Perform local browser acceptance without external writes

After the implementation is integrated into the current workspace:

1. Restart the local backend/frontend/worker processes so port 3000 serves the tested code.
2. Open `http://127.0.0.1:3000/ozon/tools/auto-listing/?source=collect&ids=collect_ccab18d873aa2c8074555143` in the in-app browser.
3. Confirm the table shows one latest `粽子测试` row for this product/store and a visible creation time.
4. Create one job only if needed to prove the category handoff. Keep the paid AI worker disabled and do not approve/upload; the only permitted live Ozon operation is the existing RFBS warehouse read validation.
5. Read the local development database afterward and confirm:
   - historical job/item/event counts were not reduced;
   - the newest item no longer has `AUTO_LISTING_SOURCE_CATEGORY_REQUIRED`;
   - the new source snapshot contains the matched target category;
   - `product_drafts.data` still contains the original blank target fields.

If the safe read-only RFBS validation is unavailable, record local acceptance as blocked and rely on the disposable-PG/fake-Ozon E2E; never substitute a real Ozon write.

### Step 6: Stop and remove disposable resources

Stop the task-specific PostgreSQL container and verify that no task container remains. Do not delete unrelated local volumes or databases.

### Step 7: Write the verification record

Create `docs/verification/2026-08-12-auto-listing-category-handoff-latest-task.md` with:

- tested implementation SHA;
- exact commands and counts;
- disposable PostgreSQL and fake-Ozon boundaries;
- browser acceptance evidence;
- explicit statement that no real Ozon write, paid AI, or production database was used;
- unverified scope and reason;
- rollback instructions.

### Step 8: Request independent code review

Use `superpowers:requesting-code-review` against the complete implementation diff. Resolve every Critical or Important finding through a fresh RED→GREEN cycle, rerun the affected real-PG and adjacent gates, and request a final read-only verdict.

### Step 9: Commit the integration evidence

First commit any E2E fixture/assertion changes with the implementation commit they validate. After the final tested implementation SHA is stable, commit only the verification document separately:

```bash
git add docs/verification/2026-08-12-auto-listing-category-handoff-latest-task.md
git commit -m "docs(auto-listing): record category handoff verification"
```

---

## Regression risks and recovery

- **Store scoping:** The highest risk is reusing another store's category. Mitigation: account/item/store/taxonomy predicates in PostgreSQL plus service-order and attack tests.
- **List semantics:** The list `limit` changes from job count to visible item-row count. This is intentional for the table; single-job detail and idempotency replay are explicitly unchanged and regression-tested.
- **Multi-item jobs:** Filtering must retain only ranked item rows from a selected job and must not leak sibling item events into the list projection.
- **Draft immutability:** The category overlay is an in-memory/read-result copy only. Real-PG tests compare the stored draft before and after creation.
- **Rollback:** Revert the implementation commits. No migration or data cleanup is required. Reverting restores the old draft-only category behavior and all-history list display; historical data remains intact.

## Definition of done

- All new tests were observed failing before production implementation and pass afterward.
- Focused, adjacent, real-PG, fake-Ozon E2E, syntax, diff, and build gates have fresh evidence.
- Independent review reports Critical 0 / Important 0.
- The local page serves the tested code and visibly shows one newest row per product/store plus creation time.
- No historical rows were deleted or changed to simulate success.
- No real Ozon write, paid AI execution, production database, or sensitive value entered logs, commits, or user-visible errors.

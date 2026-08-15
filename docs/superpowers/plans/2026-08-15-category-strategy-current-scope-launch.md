# Current Category Strategy Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an automatic-listing strategy draft to use the product's current verified category after a legitimate category remap, and start/open the Ozon sampling flow when an administrator enters from automatic listing.

**Architecture:** Keep the database as the authority for source version and current category scope. Add one small frontend workflow helper that composes the existing idempotent draft and sampling-session commands; the React page only loads state and opens the already-validated Ozon URL.

**Tech Stack:** Node.js ESM, PostgreSQL repository, React, Ant Design, Node test runner.

## Global Constraints

- The exact strategy scope remains `accountId + taxonomyScope + current descriptionCategoryId + current typeId`.
- Source collection item, current product-draft version, evidence pointer, active shared-category record, tenant, and administrator permission remain mandatory.
- No paid AI call, strategy publication, automatic-listing job, Ozon write, or database migration is added.
- Draft and sampling writes continue to use the existing idempotency and correlation identities.
- Only validated `https://www.ozon.ru` sampling URLs may be opened.

---

### Task 1: Accept a verified current category after source-category remapping

**Files:**
- Modify: `server/auto-listing-category-strategy-postgres.mjs`
- Modify: `server/tests/auto-listing-category-strategy-postgres.integration.test.mjs`
- Create: `server/tests/auto-listing-category-strategy-current-source-postgres.test.mjs`

**Interfaces:**
- Consumes: existing `createDraft({ accountId, actorId, scope, sourceCollectItemId, expectedSourceVersion, idempotencyKey, correlationId })`.
- Produces: the same response contract; only the source eligibility predicate changes.

- [ ] **Step 1: Write failing repository tests**

Add a fast PostgreSQL-boundary fixture whose current shared scope differs from the immutable source evidence and assert `createDraft` succeeds only when the requested scope equals `shared.current_description_category_id/current_type_id`. Extend the disposable-database integration seed with the same remap case.

- [ ] **Step 2: Run the fast test and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/auto-listing-category-strategy-current-source-postgres.test.mjs
```

Expected: `AUTO_LISTING_CATEGORY_STRATEGY_SOURCE_NOT_FOUND` because the current query compares the requested scope to immutable source IDs.

- [ ] **Step 3: Change the atomic source predicate**

Keep the shared row joined to the current evidence's source identity, but compare `$5/$6` to the shared row's current IDs:

```sql
AND shared.source_description_category_id=evidence.source_description_category_id
AND shared.source_type_id=evidence.source_type_id
AND shared.current_description_category_id=$5
AND shared.current_type_id=$6
```

Do not compare `$5/$6` to `evidence.source_description_category_id/source_type_id`.

- [ ] **Step 4: Run GREEN and the repository regression set**

Run the new fast test, the existing category-strategy repository tests, and syntax checking. The real PostgreSQL integration remains opt-in and is reported separately when no disposable database is configured.

### Task 2: Start and expose the sampling page from the automatic-listing handoff

**Files:**
- Create: `app/src/category-strategy-bootstrap.js`
- Modify: `app/src/CategoryStrategyPage.jsx`
- Modify: `app/src/AutoListingPage.jsx`
- Create: `app/tests/category-strategy-bootstrap.test.mjs`
- Modify: `app/tests/category-strategy-page.test.mjs`
- Modify: `app/tests/category-strategy-model.test.mjs`
- Modify: `app/src/category-strategy-client.js`

**Interfaces:**
- Consumes: existing category-strategy client, intent store, resume draft, and optional route draft ID.
- Produces: `loadCategoryStrategyBootstrap(...) -> { bundle, session, browserUrl, draftId } | null`.

- [ ] **Step 1: Write failing frontend workflow tests**

Cover these literal outcomes:

```js
const result = await loadCategoryStrategyBootstrap({
  client,
  intents,
  resume,
  routeDraftId: "",
  autoStartSampling: true,
});
assert.equal(result.draftId, "draft-new");
assert.equal(result.browserUrl, "https://www.ozon.ru/product/source?zongziCategoryStrategySession=session-new");
```

Also assert that a normal navigation does not start a session, an existing active session is reused, and the source-not-current 404 has a source-refresh message instead of a missing-record message.

- [ ] **Step 2: Run the named tests and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/category-strategy-bootstrap.test.mjs app/tests/category-strategy-page.test.mjs app/tests/category-strategy-model.test.mjs
```

Expected: missing workflow module/behavior and missing source-specific message.

- [ ] **Step 3: Implement the workflow helper and page integration**

The helper creates or loads the draft, reuses the existing durable command identities, and starts a sampling session only for `from=auto-listing`. The page applies the returned bundle/session, attempts to open `browserUrl`, removes the auto-start query by navigating to the draft route, and always renders an explicit `打开 Ozon 选样页` recovery button while a session is active.

- [ ] **Step 4: Run GREEN, focused UI regression, and production build**

Run the named frontend tests, relevant automatic-listing/category-strategy contracts, and the Vite production build.

### Task 3: Verify and deliver

**Files:**
- Verify all files above.

**Interfaces:**
- Consumes: unchanged public HTTP contracts.
- Produces: no migration and no new external API shape.

- [ ] **Step 1: Run syntax, focused tests, build, and diff checks**

- [ ] **Step 2: Reload the local page without creating paid AI work**

Verify the strategy page no longer reports the false missing-record error. Do not generate or publish a strategy during acceptance.

- [ ] **Step 3: Commit the focused fix**

```bash
git add docs/superpowers/plans/2026-08-15-category-strategy-current-scope-launch.md server/auto-listing-category-strategy-postgres.mjs server/tests/auto-listing-category-strategy-current-source-postgres.test.mjs server/tests/auto-listing-category-strategy-postgres.integration.test.mjs app/src/category-strategy-bootstrap.js app/src/CategoryStrategyPage.jsx app/src/AutoListingPage.jsx app/src/category-strategy-client.js app/tests/category-strategy-bootstrap.test.mjs app/tests/category-strategy-page.test.mjs app/tests/category-strategy-model.test.mjs
git commit -m "fix: launch current category strategy sampling"
```

- [ ] **Step 4: Report verification boundaries and rollback**

Report changed contracts, tests, unchanged paid/external behavior, any skipped real-PostgreSQL or browser-extension check, regression risk, and `git revert <commit>` rollback.

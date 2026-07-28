# Task 2 report — real Ozon category service and scoped TTL cache

## Scope and safety

- Work item: Task 2, `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`.
- Target path: `/Users/songliang/Documents/sonli ozon3.0`.
- Risk: R2 shared compatible category-query contract; the execution ledger records exact approval. No database, dependency, configuration, route, page, or external-side-effect changes were made.
- External effects: none. Tests inject a local fake `callOzonSellerApi`; no real Ozon request, credential, product state, or business state was read.
- Baseline: dirty `main` at `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`; the pre-existing dirty worktree was preserved. No staging, commit, stash, rebase, push, worktree, or destructive Git operation occurred.

## RED

Command:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
```

Key output: `ERR_MODULE_NOT_FOUND` for `server/ozon-category-service.mjs`, as expected before the service existed.

## GREEN and validation

Commands:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/ozon-category-service.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-client.test.mjs
```

Key output:

```text
ozon category service tests passed
ozon client tests passed
```

Review commands:

```bash
rg -n "apiKey|Api-Key|Client-Id|state\\.caches\\.products|cacheItemsForStore" server/ozon-category-service.mjs server/tests/ozon-category-service.test.mjs
git diff --check -- server/ozon-category-service.mjs server/tests/ozon-category-service.test.mjs
```

Results: the service has no credential or local-product-state dependency. The only match is the test-only guarded `apiKey` getter, which fails if cache code tries to read the secret. `git diff --check` exited successfully with no whitespace output.

## Implementation

- Added `createOzonCategoryService` with account/store ownership validation and account + store + language scoped, six-hour in-memory TTL cache.
- Added tree and attribute calls through injected/default `callOzonSellerApi`, strict tree/attribute response validation, cloned cached results, and provenance metadata (`OZON_API`/`OZON_CACHE`, fetched/expires timestamps).
- Added type-to-description-category resolution that inherits the parent's `description_category_id` for child types.
- Added stable fixed-message error mapping. It exposes only `status`, `code`, `{ operation }`, and `cause: null`; upstream bodies, credentials, and causes are not copied.
- Added tests for API/cache provenance, attributes, language/account/store isolation, expiry, cache-secret nonaccess, parent-category resolution, scope denial, response validation, and safe upstream failure mapping.

## Changed files

- `server/ozon-category-service.mjs` (new)
- `server/tests/ozon-category-service.test.mjs` (new)
- `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` (Task 2 checkbox state only)
- `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/task-2-report.md` (this handoff)

## Self-check and recovery

- No local product/business state read; cache scope does not use `apiKey`, `Client-Id`, or `Api-Key`.
- No real API request or write occurred. No tests outside the changed service and direct Ozon-client regression were run because routes, UI, normalizer integration, and dictionary pagination are later work packages.
- Recovery is deletion of the two new service/test files and restoration of the Task 2 plan-checkbox state; no data recovery is needed.

## Concerns

- The required Task 2 skeleton exposes `getCategoryAttributeValues`, while complete dictionary pagination, validation, and atomic cache writes are explicitly deferred to Task 3. It currently returns the same stable safe `OZON_CATEGORY_VALUES_UNAVAILABLE` error rather than returning incomplete or local data; Task 3 must replace that temporary fail-closed implementation and add its pagination tests.

## Fix round 1 — TTL, scope-key and cache-isolation hardening

### Scope and safety

- Files changed: only `server/ozon-category-service.mjs`, `server/tests/ozon-category-service.test.mjs`, and this report.
- No real Ozon call, local product-state read, dependency/config change, staging, commit, or other Git mutation occurred. Test dependencies remain injected fakes.

### RED

1. Overlong TTL test:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
```

Key output: `actual: 43200000`, `expected: 21600000` for a requested 12-hour TTL.

2. Non-positive TTL test:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
```

Key output: `0 !== 21600000` for a requested zero TTL.

3. Delimiter-collision test:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
```

Key output: `actual: 'OZON_CACHE'`, `expected: 'OZON_API'` for (`accountId: "a:b", storeId: "c"`) followed by (`accountId: "a", storeId: "b:c"`).

The added expired-cache-refresh-failure and nested-clone tests were characterization tests: both were GREEN immediately because the existing `readCache` expiry deletion and `structuredClone` boundaries already satisfied the requested behavior. No implementation was altered merely to manufacture a failure.

### Implementation and GREEN

- `cacheTtlMs` now normalizes once per service instance: finite positive values are capped at six hours; zero, negative, non-finite, and absent values safely use the six-hour default.
- Scope is now a `[accountId, storeId]` tuple. Each cache key is `JSON.stringify` of explicit dimensions, avoiding delimiter collisions while retaining account/store/language/type/category separation.
- Added behavioral coverage for TTL upper/default bounds, collision isolation, expiry followed by safe upstream failure (no stale items), and nested result clone isolation.

Commands:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/ozon-category-service.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-client.test.mjs
git diff --check -- server/ozon-category-service.mjs server/tests/ozon-category-service.test.mjs .superpowers/sdd/2026-07-28-ozon-category-query-extraction/task-2-report.md
```

Key output:

```text
ozon category service tests passed
ozon client tests passed
```

`node --check` and `git diff --check` both exited 0 with no output. The direct Ozon-client regression remains green.

### Concerns and recovery

- The Task 3 dictionary-values concern remains unchanged: its complete pagination behavior is intentionally still fail-closed until its dedicated work package.
- Recovery is limited to reverting the two service/test edits in this fix round; no external or data recovery is required.

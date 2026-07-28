# Task 4 report — authenticated category HTTP routes

## Scope and safety

- Work item: Task 4, `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`.
- Target path: `/Users/songliang/Documents/sonli ozon3.0`.
- Risk: R2 compatible shared category-query HTTP contract; the plan/design approval is recorded in the SDD ledger.
- Boundary: only the new route module, its focused tests, the seven Task 4 plan checkboxes, this handoff report, the required before snapshot, and the scoped review package changed. `server/index.mjs` was intentionally not wired or modified.
- External effects: none. Tests use injected local stubs only; no real Ozon request, credential, database, container, configuration, dependency, deployment, or business-data operation occurred.
- Git: the pre-existing dirty `main` at `d4ed427992e9e159d657197fd7bad07b4c2f6f8c` was preserved. No staging, commit, stash, rebase, worktree, push, reset, checkout, or destructive Git action occurred.

## Snapshot and RED evidence

Before changing the plan, I saved the byte-for-byte snapshot at:

```text
.superpowers/sdd/2026-07-28-ozon-category-query-extraction/snapshots/task-4-before/2026-07-28-ozon-category-query-extraction.md
SHA-256: 287d5991fa34ccec5f1b0e4063c663b8419b4731a3254afa39fe75f27cbdc067
```

I then wrote the route-contract tests before creating the route module and ran:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-routes.test.mjs
```

The command exited 1 with the expected `ERR_MODULE_NOT_FOUND` for `server/ozon-category-routes.mjs`. This is a genuine RED caused by the missing Task 4 module, not a fixture or assertion error.

## Review fixes — RED to GREEN

The scoped reviewer found two P1 safety gaps. Each was corrected with a focused RED→GREEN cycle:

- The initial prefix-only error mapper could expose `raw upstream credential text` and preserve a faulty `status: 200` for an otherwise stable code. The new test failed exactly with that observed `{ status: 200, message: "raw upstream credential text" }` output. The route now allowlists only the five design-approved stable codes, uses the fixed safe message, and accepts only 422/502/503/504; a malformed status falls back to 502. An unknown `OZON_CATEGORY_*` code is tested to propagate rather than be sent.
- When the route had to resolve a category ID, its second service call previously occurred after an `await` without a new ownership check. New attributes and values tests make `activeStore` return a store for resolution and `null` afterward. Both failed with `Missing expected rejection`, proving the second call was not guarded. The route now calls `requestContext` again immediately before that second service call; both tests then pass and prove no attributes/values call is made after the store becomes unavailable.

## Delivered contract

- Added `createOzonCategoryRouteHandler(dependencies)`, which returns an async `{ req, res, url, state }` handler and returns `false` without any side effect for an unsupported method/path.
- Implements only the exact GET routes for the category tree, attributes, and attribute values. Successful responses retain `data`, `items`, and `total`, retain the existing route fields, and add service provenance as `meta`.
- Obtains the account solely from injected `requireAuth`; query values cannot replace `account.id`. Selects the store from query `storeId`, then `x-ozon-store-id`, then the injected existing selection behavior, and verifies ownership through injected `activeStore(state, storeId, account.id)` before any category-service call.
- An unavailable or foreign store throws the existing stable route error (`404`, `STORE_NOT_FOUND`, `店铺不存在或不属于当前账号`) before the category service is called.
- Only the five design-approved stable category errors are mapped through injected `sendError`; their output uses the fixed safe message and a safe non-2xx status. Unknown category-prefixed errors and unrelated/auth/programmer errors propagate to the existing top-level handler.
- The route reads no local product cache, imports no `server/index.mjs`, and does not implement Ozon calls, cache behavior, pagination, or local fallbacks.

## GREEN, regression, and review evidence

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/ozon-category-routes.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-routes.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
git diff --check -- server/ozon-category-routes.mjs server/tests/ozon-category-routes.test.mjs docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md
git diff --no-index --check /dev/null server/ozon-category-routes.mjs
git diff --no-index --check /dev/null server/tests/ozon-category-routes.test.mjs
git diff --no-index --check <task-4-plan-snapshot> docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md
```

Results: syntax check and standard scoped whitespace check exited 0; route tests printed `ozon category routes tests passed`; service regression printed `ozon category service tests passed`. Each `--no-index --check` emitted no whitespace diagnostic; its exit 1 is the expected non-identical/new-file diff status.

Focused review confirmed that the new route and test contain no `server/index` import, `state.caches.products`, `cacheItemsForStore`, API-key, Client-Id, or credential dependency. The plan diff contains only the seven Task 4 checkbox changes. The scoped review artifact is `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/task-4-review-package.diff`.

## Files and handoff

- Added: `server/ozon-category-routes.mjs`.
- Added: `server/tests/ozon-category-routes.test.mjs`.
- Modified: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` (Task 4 checkboxes only).
- Added operational artifacts: this report, the Task 4 before snapshot, and `task-4-review-package.diff`.
- Database/config/dependencies/external-service changes: none.

The focused tests cover unsupported exact paths, success response compatibility, explicit category resolution, account-ID forgery resistance, auth propagation, store ownership failure before service invocation (including after category resolution), fixed safe category-error mapping, malformed status/message sanitization, unknown category-error propagation, and unrelated error propagation. Integration with `server/index.mjs`, live HTTP transport, UI/extension consumers, and real Ozon are intentionally unverified because Task 4 explicitly forbids handler wiring and real external effects.

Recovery is restoring the new route/test removal, restoring the plan from the Task 4 before snapshot, and removing the Task 4 handoff artifacts; no persistent data, cache, or external state needs recovery. The next safe action is the separately scoped wiring task, which should inject this handler into `server/index.mjs` and retain its ownership/error contract.

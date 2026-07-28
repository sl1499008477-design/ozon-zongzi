# Task 10 final-review fix round 1 report

Date: 2026-07-28 (Asia/Shanghai)

Target: `/Users/songliang/Documents/sonli ozon3.0`

Branch/commit baseline: dirty `main` at
`d4ed427992e9e159d657197fd7bad07b4c2f6f8c`

Result: **Ready: Yes** for focused re-review. Critical: 0. Important: 0.

## Scope and contract changes

### Production

- `server/ozon-category-service.mjs`
  - Required `descriptionCategoryId`, `typeId` and `attributeId` now normalize
    to positive integers before cache lookup or Ozon calls.
  - Caller-supplied invalid IDs fail with safe
    `400 / OZON_CATEGORY_DATA_INVALID`, fixed message,
    `{ operation: "INPUT" }` and `cause: null`.
  - `resolveDescriptionCategoryId` validates `typeId` before the tree
    lookup. A valid type absent from a valid real tree now fails with safe
    `422 / OZON_CATEGORY_TYPE_NOT_FOUND`, fixed message,
    `{ operation: "TYPE" }` and `cause: null`.
  - Malformed upstream category/attribute/value responses retain
    `502 / OZON_CATEGORY_DATA_INVALID`; the caller-input 400 mapping did not
    weaken this existing upstream-data contract.
- `server/ozon-category-routes.mjs`
  - Required path/query IDs are normalized to positive integers before any
    category-service call.
  - Successful attribute/value responses and service inputs retain numeric
    `typeId`, `categoryId` and `attributeId`, including category IDs returned
    by real-tree resolution.
  - The stable category error allowlist now permits status 400. Unknown or
    unsafe statuses still map to 502 with the fixed safe message.
- `app/src/category-readiness.js`
  - Preview/formal-listing readiness now explicitly includes dictionary
    loading and dictionary error.
- `app/src/use-category-dictionary-readiness.js` (new)
  - Owns executable dictionary request generation, complete store/item/
    category/type/attribute scope, stale-completion rejection, atomic
    loading/error/options state and retry.
  - A current failure clears remote options, retains only the fixed visible
    category error and fails readiness closed.
  - A successful authentic empty response records the target key with `[]`
    and is ready; an exception can no longer be represented as that state.
  - Retry retains the visible error until the current retry succeeds.
- `app/src/App.jsx`
  - Replaces the permissive `catch -> { options: [] }` effect with the focused
    dictionary hook.
  - Uses one visible retry surface for tree or dictionary failure.
  - Automatic category continuation, preview and formal listing include the
    dictionary readiness gate before their API calls.
  - Existing store/item gates and tree/attribute readiness behavior remain in
    place.

### Tests and compatibility fixture

- `server/tests/ozon-category-service.test.mjs`
  - Adds zero-Ozon-call invalid-ID cases, safe 400 assertions, 422 missing
    type and retained malformed-upstream 502 coverage.
- `server/tests/ozon-category-routes.test.mjs`
  - Adds numeric success compatibility, invalid route ID zero-service-call
    coverage, safe 400 mapping and safe missing-type 422 mapping.
- `app/tests/category-readiness.test.mjs`
  - Adds executable preview/publish denial for dictionary loading/error.
- `app/tests/category-dictionary-readiness.test.mjs` (new)
  - Executes the real request controller for complete scope/generation,
    stale success/failure rejection, failure atomicity, visible retry and
    authentic empty success.
- `server/tests/cache-route-isolation.test.mjs`
  - With integration-owner approval, only the old nonnumeric
    `type_a/attribute_a` route fixtures were changed to `20/30`. The original
    fallback-isolation assertions remain: non-2xx,
    `OZON_CATEGORY_TREE_UNAVAILABLE`, no local category/type leakage and at
    least three mocked Ozon attempts. This compatibility change is required
    because invalid caller IDs must now stop before any Ozon call.

No database, migration, dependency, lockfile, configuration, deployment,
permission or backend listing contract changed.

## Before snapshot

Exact pre-edit copies of every existing changed file are under:

`.superpowers/sdd/2026-07-28-ozon-category-query-extraction/snapshots/task-10-fix-r1-before/`

`SHA256SUMS.txt` verifies all eight existing-file snapshots:

- `App.jsx`
- `category-readiness.js`
- `category-readiness.test.mjs`
- `ozon-category-service.mjs`
- `ozon-category-routes.mjs`
- `ozon-category-service.test.mjs`
- `ozon-category-routes.test.mjs`
- `cache-route-isolation.test.mjs`

Fresh `shasum -a 256 -c SHA256SUMS.txt`: all eight `OK`.

## TDD RED evidence

Fixed runtime for every Node command:

`/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`

1. `node server/tests/ozon-category-service.test.mjs`
   - Exit 1.
   - Observed `Missing expected rejection` on the first invalid-ID case,
     proving the current service converted the invalid ID to zero and
     continued instead of rejecting.
2. `node server/tests/ozon-category-routes.test.mjs`
   - Exit 1.
   - Observed actual `descriptionCategoryId: "10"` and `typeId: "20"`
     against expected numeric `10` and `20`.
3. `node app/tests/category-dictionary-readiness.test.mjs`
   - Exit 1.
   - Observed `ERR_MODULE_NOT_FOUND` for the required focused executable
     dictionary readiness module; the existing App behavior lived only in
     the permissive monolithic effect.
4. `node app/tests/category-readiness.test.mjs`
   - Exit 1 with 8 pass / 1 fail.
   - Observed `Missing expected exception` for dictionary loading/error,
     proving the existing action readiness ignored dictionary state.
5. Focused retry test rerun before its minimal adjustment:
   `node app/tests/category-dictionary-readiness.test.mjs`
   - Exit 1 with 2 pass / 1 fail.
   - Observed retry-start error `""` instead of the fixed visible error,
     proving the error was cleared before successful retry completion.

## GREEN and regression evidence

Fresh final run after the last production change:

- `node server/tests/ozon-category-service.test.mjs` — pass.
- `node server/tests/ozon-category-routes.test.mjs` — pass.
- `node app/tests/category-readiness.test.mjs` — 9/9 pass.
- `node app/tests/category-tree-readiness-hook.test.mjs` — 1/1 pass.
- `node app/tests/category-dictionary-readiness.test.mjs` — 3/3 pass.
- `node server/tests/category-listing-readiness.test.mjs` — pass.
- `node server/tests/cache-route-isolation.test.mjs` — pass.
- `node server/tests/import-preview-route.test.mjs` — pass.
- `node server/tests/collect-listing-submit-failure.test.mjs` — pass.
- `node server/tests/external-write-safety.test.mjs` — pass.
- `node server/tests/account-store-isolation.test.mjs` — pass.
- `node server/tests/module-boundaries.test.mjs` — pass.
- `node scripts/check-collect-edit-listing-contract.mjs` — pass.
- `node app/tests/prototype-style-contract.test.mjs` — 15/15 pass.
- Syntax checks for service, routes and the new dictionary module — pass.
- Installed-dependency-only production build:
  `pnpm --dir app build` — Vite transformed 4818 modules and built
  successfully.

The build retained the existing non-blocking advisory that the main
JavaScript chunk exceeds 500 kB. No install or network-backed build step was
run.

## App and module boundary

- `app/src/App.jsx`: 9839 physical lines.
- `app/src/App.jsx` JavaScript `split("\n").length`: 9840.
- Guards: physical lines <= 9849 and JavaScript split count <= 9850.
- `server/tests/module-boundaries.test.mjs`: pass without raising either
  guard.
- New focused dictionary module: 217 physical lines.

## Scope, whitespace and external effects

- Scoped `git diff --check`: pass.
- Trailing-whitespace scan of all scoped files: no matches.
- Branch remains `main`; commit remains
  `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`.
- Git index remains empty.
- No stage, commit, branch, stash, reset, checkout, rebase or push occurred.
- No service was started.
- No real Ozon call, real account operation, task creation, snapshot creation,
  listing submission, inventory/price write or other external write occurred.
- No database or PostgreSQL command ran.
- No dependency, lockfile, configuration, environment, Docker or deployment
  mutation occurred.

## Unverified by instruction

- The complete PostgreSQL engineering gate was intentionally not run; the
  controller will run it after scoped independent re-review.
- Real Ozon endpoint version, current production permissions, live payload
  variation, rate limiting and network behavior remain unverified because no
  live credentials/calls were authorized.
- Manual browser interaction was not run. Executable state tests, existing UI
  contracts and the production build cover the automated behavior.

## Exact scoped rollback

Do not use broad Git restoration in this dirty worktree.

1. Restore the eight existing changed files by copying their exact matching
   snapshot from
   `snapshots/task-10-fix-r1-before/` back to:
   - `app/src/App.jsx`
   - `app/src/category-readiness.js`
   - `app/tests/category-readiness.test.mjs`
   - `server/ozon-category-service.mjs`
   - `server/ozon-category-routes.mjs`
   - `server/tests/ozon-category-service.test.mjs`
   - `server/tests/ozon-category-routes.test.mjs`
   - `server/tests/cache-route-isolation.test.mjs`
2. Remove only the two files created by this fix:
   - `app/src/use-category-dictionary-readiness.js`
   - `app/tests/category-dictionary-readiness.test.mjs`
3. Rerun the focused category tests and app build.

No database or external-system rollback is required.

## Concerns

No concern prevents `Ready: Yes` for final scoped re-review. The existing
bundle-size advisory and deliberately unverified live/PostgreSQL areas are
recorded above and are not changes introduced by this fix.

---

## Round 2 — malformed successful dictionary response

Date: 2026-07-28 (Asia/Shanghai)

Result: **Ready: Yes** for round-2 scoped re-review. Critical: 0.
Important: 0.

### Root cause and exact changes

The App dictionary request adapter converted any successful response without
an `items` array or `data` array to `[]`. The controller independently
converted any non-array reader result to `[]`, so a malformed 2xx response
could publish `{ "attributeKey": [] }` with `complete: true`.

Round-2 changes are limited to:

- `app/src/use-category-dictionary-readiness.js`
  - Adds executable `dictionaryRowsOfResponse(response)`.
  - Explicit `items: []` and `data: []` are accepted as authentic successful
    empty results.
  - A response with neither array throws a fixed
    `OZON_CATEGORY_UI_UNAVAILABLE` error.
  - The controller rejects a non-array `readValues` result instead of
    coercing it to `[]`; its existing catch path clears options, publishes the
    fixed visible error and remains not ready.
- `app/src/App.jsx`
  - Imports and calls `dictionaryRowsOfResponse` in
    `readCategoryDictionaryValues`.
  - Removes the page-local permissive dictionary response parser; no second
    dictionary empty fallback remains in the page.
- `app/tests/category-dictionary-readiness.test.mjs`
  - Adds a load-bearing malformed-result controller test.
  - Directly executes the focused adapter for `items: []`, `data: []` and a
    malformed 2xx shape.

All round-1 scope, generation, stale completion, visible retry and readiness
contracts remain unchanged.

### Round-2 before snapshot

Exact pre-round-2 copies are under:

`.superpowers/sdd/2026-07-28-ozon-category-query-extraction/snapshots/task-10-fix-r2-before/`

The snapshot contains `App.jsx`, `use-category-dictionary-readiness.js`,
`category-dictionary-readiness.test.mjs`, the pre-append
`task-10-fix-r1-report.md` and `SHA256SUMS.txt`.

Fresh `shasum -a 256 -c SHA256SUMS.txt`: all four files `OK`.

### Round-2 RED evidence

Command:

`node app/tests/category-dictionary-readiness.test.mjs`

Result: exit 1; 3 passed and 2 failed.

- The malformed controller result published actual `{ "30": [] }` instead
  of expected `{}`, proving malformed success was treated as authentic empty.
- The focused adapter assertion observed `undefined` instead of `function`,
  proving the page parser had not yet been extracted into an executable
  contract.

The fixed Node runtime was:

`/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`

### Round-2 GREEN and regression evidence

Fresh required validation:

- `node app/tests/category-dictionary-readiness.test.mjs` — 5/5 pass.
- `node app/tests/category-readiness.test.mjs` — 9/9 pass.
- `node app/tests/category-tree-readiness-hook.test.mjs` — 1/1 pass.
- `node app/tests/prototype-style-contract.test.mjs` — 15/15 pass.
- `node scripts/check-collect-edit-listing-contract.mjs` — pass.
- `node server/tests/module-boundaries.test.mjs` — pass.
- `node --check app/src/use-category-dictionary-readiness.js` — pass.
- Installed-dependency-only `pnpm --dir app build` — Vite transformed 4818
  modules and built successfully.
- Scoped `git diff --check` — pass.
- Scoped trailing-whitespace scan — no matches.

The production build retains the pre-existing non-blocking >500 kB main chunk
advisory.

### Round-2 line and boundary result

- `app/src/App.jsx`: 9838 physical lines.
- App JavaScript `split("\n").length`: 9839.
- Existing guards remain <=9849 physical and <=9850 split count.
- `app/src/use-category-dictionary-readiness.js`: 224 physical lines.
- Module-boundary validation passed without changing the guard.

### Round-2 external effects and unverified scope

- No real Ozon call, service start, task creation, listing submission,
  external write, database command or business-data mutation occurred.
- No dependency, lockfile, configuration, environment, Docker or deployment
  file changed.
- No Git stage, commit, branch, stash, reset, checkout, rebase, push or other
  Git write occurred. Branch/commit remain dirty `main` at
  `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`.
- Per the brief, the PostgreSQL full engineering gate, live Ozon behavior and
  manual browser interaction remain unverified.

### Round-2 exact rollback

Do not use broad Git restoration. Restore only these exact snapshot copies:

- `snapshots/task-10-fix-r2-before/App.jsx` to `app/src/App.jsx`
- `snapshots/task-10-fix-r2-before/use-category-dictionary-readiness.js` to
  `app/src/use-category-dictionary-readiness.js`
- `snapshots/task-10-fix-r2-before/category-dictionary-readiness.test.mjs` to
  `app/tests/category-dictionary-readiness.test.mjs`
- `snapshots/task-10-fix-r2-before/task-10-fix-r1-report.md` to this report

No data or external-system rollback is required.

### Round-2 concern

No concern prevents `Ready: Yes` for the next scoped independent re-review.

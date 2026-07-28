# Task 4 brief — authenticated category HTTP routes

## Source of truth

- Plan: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`, Task 4 only.
- Design: `docs/superpowers/specs/2026-07-28-ozon-category-query-extraction-design.md`.
- Rules: `/Users/songliang/.codex/AGENTS.md`.
- Ledger: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/progress.md`.

## Approved scope

Create only:

- `server/ozon-category-routes.mjs`
- `server/tests/ozon-category-routes.test.mjs`

The only other allowed product-plan change is Task 4 checkbox state in the implementation plan. Append the required handoff report at `task-4-report.md`.

Do not wire the handler into `server/index.mjs`; that belongs to a later task. Do not modify the category service, database, configuration, dependencies, deployment files, old business data, or unrelated dirty files.

## Required behavior

- Export `createOzonCategoryRouteHandler(dependencies)`.
- Return an async handler accepting `{ req, res, url, state }` and returning a boolean.
- Exact supported GET paths:
  - `/ozon/categories/tree`
  - `/ozon/description-category/:typeId/attributes`
  - `/ozon/description-category/:typeId/attributes/:attributeId/values`
- Unrelated method/path returns `false` and sends nothing.
- Authenticate with the injected `requireAuth`.
- Select the store with injected `storeIdForAccountRequest`, using query `storeId`, then `x-ozon-store-id`, then existing selection behavior.
- Verify store ownership with injected `activeStore(state, storeId, account.id)` before every service call.
- Request/query/body data must never override `account.id`.
- Missing/foreign store must fail before the category service is invoked and use the existing stable store error semantics described by the plan.
- Preserve existing additive success response fields and add `meta`; never convert category failures into `200` or `items: []`.
- Only map stable `OZON_CATEGORY_*` service errors through injected `sendError`. Let unrelated programmer/top-level errors propagate.
- Preserve fixed safe error messages and do not expose upstream raw bodies, credentials, or causes.

## TDD and verification

1. Save before-state snapshots under `snapshots/task-4-before/` for any existing file that will be changed.
2. Write the route tests first and run them to record genuine RED because the module does not exist.
3. Implement the minimum route module described in Task 4.
4. Run with the fixed Node runtime:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/ozon-category-routes.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-routes.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
git diff --check -- server/ozon-category-routes.mjs server/tests/ozon-category-routes.test.mjs docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md
```

For untracked files, also use `git diff --no-index --check /dev/null <file>` and treat exit 1 as the expected new-file diff status when no whitespace diagnostic is printed.

## Safety boundary

- No real Ozon request.
- No external write or side effect.
- No database/container use.
- No migration, configuration, dependency, deployment, packaging, or UI change.
- No commit, staging, branch, worktree, stash, push, reset, checkout, or destructive Git.
- Preserve the pre-existing dirty `main`.

## Handoff

Write `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/task-4-report.md` with RED/GREEN evidence, exact files, contracts, tests, regression scope, unverified range, rollback, and concerns. Create `task-4-review-package.diff` scoped to Task 4 changes and report completion without committing.

# Task 6 brief — replace inline routes and delete local category fallback

## Source of truth

- Plan Task 6: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`.
- Design: `docs/superpowers/specs/2026-07-28-ozon-category-query-extraction-design.md`.
- Rules: `/Users/songliang/.codex/AGENTS.md`.
- Ledger: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/progress.md`.

## Business goal and acceptance

The three category HTTP endpoints must delegate to the authenticated Task 4 route handler and Task 5 shared service. Local synced products must never be a category data source. When Ozon is unavailable, every route returns a stable non-2xx category error and never exposes a local category/type/name.

Acceptance:

- one entry-level route handler instance uses the shared `ozonCategoryService`;
- exact delegation occurs where the old three inline GET blocks were located;
- the entire old inline category boundary, caches, helpers, and local-product fallbacks are deleted;
- tree, attributes, and values without explicit category ID fail closed when real Ozon tree lookup fails;
- response JSON contains neither current-store nor foreign-store local category identifiers;
- other cache/account/store isolation behavior remains unchanged.

## Approved files

- Modify `server/index.mjs`
- Modify `server/tests/cache-route-isolation.test.mjs`
- Modify `server/tests/ozon-category-routes.test.mjs`
- Modify Task 6 checkboxes only in the implementation plan
- Operational snapshots/report/scoped diff under this SDD directory

Do not touch service semantics, normalizer/listing logic, database, UI, extension, dependencies, config, deployment, or unrelated dirty code.

## TDD and implementation

1. Save byte-identical before snapshots and SHA-256 under `snapshots/task-6-before/`.
2. Add a real-entry failing test with local category data and mocked Ozon failure. Cover tree, attributes, and values; assert non-2xx stable codes and absence of all local IDs/names. Record genuine RED against the current inline fallback.
3. Import `createOzonCategoryRouteHandler`, instantiate one shared handler using the Task 5 service and existing auth/store/send functions, and delegate once at the removed category-route location.
4. Delete only the complete legacy category caches/helpers/routes/fallbacks listed in Task 6.
5. Update the old cache isolation expectation from store-filtered fallback success to no-local-fallback failure.

## Required checks

Use the fixed Node runtime:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/index.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-routes.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/cache-route-isolation.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/account-store-isolation.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-store-data-isolation.mjs
```

Then run the two Task 6 `rg` boundary checks and scoped whitespace checks. Treat the expected no-match `rg` exit 1 as success only when output is empty.

Mandatory review:

- compare `server/index.mjs` to Task 6 before snapshot, not HEAD;
- prove no unrelated collection, AI, preview, listing, DB, audit, job or permission code changed;
- prove no inline route remains and only one delegated handler exists;
- prove the new route handler/service have no `state.caches.products` dependency;
- prove tests use mocked fetch/local temporary state only and make no real request.

## Safety

- No real Ozon or external write.
- No database/container, migration, config, dependency, deployment, packaging, UI, or data deletion.
- No commit, stage, branch, worktree, stash, push, reset, checkout, or destructive Git.
- Preserve dirty `main`.

## Handoff

Write `task-6-report.md` with RED/GREEN evidence, exact deletions/contracts/tests/regression/unverified/rollback/concerns. Create `task-6-review-package.diff` scoped to Task 6 and report without committing.

# Task 5 brief — preview/listing fail-closed integration

## Source of truth

- Plan: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`, Task 5 only.
- Design: `docs/superpowers/specs/2026-07-28-ozon-category-query-extraction-design.md`.
- Rules: `/Users/songliang/.codex/AGENTS.md`.
- Safety ledger: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/progress.md`.

## Business goal and acceptance

Preview and final listing preparation must use only the shared real-Ozon category service. If tree, attributes, dictionary values, or required dictionary resolution fails, the request must fail closed before any listing snapshot, job, success audit, or external write. `COLLECT_EDIT_AUTO_CATEGORY` must no longer turn an unresolved required dictionary value into a successful preview warning.

Acceptance:

- category failure returns non-200 with `body.ok === false` and stable `OZON_CATEGORY_*` code;
- unresolved required dictionary value in auto-category preview fails;
- failed final submission leaves snapshot/job counts unchanged and external writes at zero;
- existing valid preview/listing results remain unchanged;
- category callbacks depend on service methods, never local product cache/state;
- exactly one shared `createOzonCategoryService()` instance is created at module scope near existing shared services, not per request.

## Approved files

- Modify `server/index.mjs`
- Modify `server/tests/import-preview-route.test.mjs`
- Modify `server/tests/collect-listing-submit-failure.test.mjs`
- Modify `server/tests/external-write-safety.test.mjs`
- Create `server/tests/category-listing-readiness.test.mjs`
- Review-fix scope: modify `server/ozon-import-normalizer.mjs` and `server/tests/ozon-import-normalizer.test.mjs` only to preserve stable category errors and create a fixed unresolved-required-dictionary error contract.
- Modify Task 5 checkboxes only in `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`
- Operational artifacts under this SDD directory: snapshots, report, scoped diff packages

Do not wire or replace the inline HTTP category routes yet; that is Task 6. Do not change the normalizer contract, listing state machine, DB schema/path, task ownership, permissions, UI, extension, configuration, dependencies, or deployment.

Review-fix clarification: preserving a stable category error is a compatible normalizer error-contract correction. It must not alter successful normalized output or turn unrelated normalization failures into hard failures.

## Required implementation

- Import `createOzonCategoryService` from `server/ozon-category-service.mjs`.
- Instantiate one shared category service, not per request.
- Replace the preview normalizer category callbacks with service calls scoped by `store.ownerAccountId`, the selected `store`, IDs, and `language: "DEFAULT"`, returning only `.items` to the existing normalizer.
- Remove the special permissive flag:

```js
allowUnresolvedRequiredDictionaryValues:
  body.entry === "COLLECT_EDIT_AUTO_CATEGORY"
```

- Replace the final `queueCollectSubmissionV3` callbacks with the same service-backed callbacks.
- Category resolution must finish before snapshot creation, enqueue, success audit, and any external write.
- Keep fixed safe errors; never expose raw Ozon responses or credentials.

## TDD and evidence

1. Snapshot every existing approved file before modification under `snapshots/task-5-before/` with SHA-256 evidence.
2. Write/extend tests first. Run the new readiness test and record genuine RED caused by inline/permissive behavior.
3. Make the smallest implementation change.
4. Run with fixed Node:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/category-listing-readiness.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/import-preview-route.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/import-currency-contract.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/collect-listing-submit-failure.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/external-write-safety.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-import-normalizer.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/index.mjs
```

Also run scoped whitespace checks. Do not start Docker or call real Ozon.

## Mandatory review checks

- Diff `server/index.mjs` against the Task 1 snapshot and prove this task changed only imports/shared service creation/preview and listing category callbacks/strict flag.
- Prove no product-cache fallback is newly introduced.
- Prove failure occurs before snapshot/job/audit success/external write.
- Prove tests use local stubs/mocked fetch only and do not contain credentials.
- Report exact RED/GREEN evidence and any changed legacy test expectation.

## Safety

- No real Ozon request or external side effect.
- No DB/container, migration, configuration, dependency, deployment, packaging, or UI work.
- No data deletion or mutation outside isolated test fixtures.
- No commit, stage, branch, worktree, stash, push, reset, checkout, or destructive Git.
- Preserve the dirty `main`.

## Handoff

Write `task-5-report.md` with files/contracts/tests/regressions/unverified/rollback/concerns and create `task-5-review-package.diff` scoped to Task 5. Report completion without committing.

# Task 10 final-review fix round 1

## Context and authority

Target: `/Users/songliang/Documents/sonli ozon3.0`

This is the single focused fix dispatch required by the final whole-work-item
review. The user approved the category-query implementation and sequential
subagent-driven fixes in the existing dirty `main`.

Read first:

1. `/Users/songliang/.codex/AGENTS.md`
2. `docs/superpowers/specs/2026-07-28-ozon-category-query-extraction-design.md`
3. `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`
4. `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/final-report.md`
5. The actual current files named below.

Do not commit, stage, stash, branch, push, reset, checkout or rewrite unrelated
dirty work. Do not call real Ozon, start services, write business data, change
the database, migrations, dependencies, lockfiles, config or deployment.
Use the fixed Node runtime:

`/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`

Write your complete report to:

`.superpowers/sdd/2026-07-28-ozon-category-query-extraction/task-10-fix-r1-report.md`

Return only status, changed files, one-line test summary and concerns.

## Reviewer findings — all three are required

### Important 1 — preserve numeric category ID contract

Current `server/ozon-category-routes.mjs` retains query/path IDs as strings
and sends `typeId`, `categoryId` and `attributeId` back as strings. The
pre-Task-6 route normalized them with `Number(...)`.

Required:

- Normalize the required path/query identifiers as positive integers before
  service calls.
- Successful attributes and values responses must keep numeric `typeId`,
  `categoryId` and `attributeId`.
- When no description category is supplied, the numeric ID returned by
  resolution must remain numeric.
- Add route compatibility tests that would fail on the current string
  behavior.

### Important 2 — fail closed on invalid IDs and missing type

Current `server/ozon-category-service.mjs` turns invalid IDs into zero and
still calls Ozon; type resolution returns zero when a type is absent.

Required:

- Before any relevant Ozon call or cache lookup, reject each required ID that
  is not a positive integer.
- Use safe `400 / OZON_CATEGORY_DATA_INVALID` for invalid input.
- If a valid type is absent from a successfully validated real tree, use safe
  `422 / OZON_CATEGORY_TYPE_NOT_FOUND`.
- Keep fixed redacted messages, `cause: null`, and no upstream body/credential.
- Update route safe mapping to allow status 400 for the stable invalid-data
  code.
- Add service and route negative tests proving zero API calls for invalid
  IDs, correct 400 mapping and correct 422 missing-type behavior.

Do not weaken the existing 502 use of `OZON_CATEGORY_DATA_INVALID` for a
malformed upstream response; the same stable code may have 400 for caller
input and 502 for invalid upstream data.

### Important 3 — App dictionary values must fail visibly and block actions

Current `app/src/App.jsx` catches dictionary-value request failures and turns
them into `{ options: [] }`. The UI does not retain a dictionary error and
readiness ignores it.

Required behavior:

- Every dictionary-values request is bound to the current store, category,
  type, attribute and request generation. A stale completion after any scope
  change must not write options, error or loading state.
- A current dictionary failure must clear affected option state, set the same
  fixed visible category error, and must not be represented as a successful
  empty list.
- The user must have a visible retry action. A current successful retry clears
  the dictionary error and restores readiness.
- While dictionary loading or error exists, automatic category continuation,
  preview and formal listing must fail closed before their API calls. Backend
  protection remains unchanged.
- A successful authentic empty values array may be accepted as ready only when
  the request itself succeeded; empty-on-error is forbidden.
- Put executable state/scope behavior in a focused module and test real
  functions, not only source-text regexes.
- Preserve current store/item scope gates and the existing tree/attribute
  readiness behavior.
- Keep `app/src/App.jsx` within the unchanged module-boundary guard:
  physical lines must not exceed 9849 and JavaScript split count must not
  exceed 9850. Extract focused behavior instead of growing the monolith.

Acceptable files:

- `server/ozon-category-service.mjs`
- `server/ozon-category-routes.mjs`
- `server/tests/ozon-category-service.test.mjs`
- `server/tests/ozon-category-routes.test.mjs`
- `server/tests/cache-route-isolation.test.mjs` only to replace the legacy
  non-numeric fallback-isolation fixture IDs with valid positive integers,
  preserving its Ozon-failure/no-local-fallback assertions
- `app/src/category-readiness.js`
- `app/src/use-category-tree-readiness.js`
- one new focused app hook/helper module if necessary
- `app/src/App.jsx`
- `app/tests/category-readiness.test.mjs`
- one new focused executable app test if necessary
- `scripts/check-collect-edit-listing-contract.mjs` only if its source contract
  must follow an intentional extraction
- `server/tests/module-boundaries.test.mjs` only if needed to register a
  focused new module without raising either line guard
- task-local SDD snapshots/report/review artifacts

Stop and report if another production file is genuinely required.

## TDD and validation

Before production edits:

1. Snapshot every existing file you will change into
   `snapshots/task-10-fix-r1-before/` with SHA-256 evidence.
2. Add focused tests for the three findings.
3. Run them and record the expected RED failures caused by current behavior.

After the minimal fixes:

- Run service, route and app focused tests.
- Run category listing readiness, cache-route isolation, import preview,
  collect-listing failure, external-write safety, account/store isolation,
  module boundaries and the collect-edit listing contract.
- Run an offline app production build.
- Run `git diff --check` for the scoped files.
- Confirm no real Ozon call, task creation, external write, database/config/
  dependency/deployment mutation or Git write occurred.
- Do not run the complete PostgreSQL engineering gate; the controller will do
  that after independent scoped re-review.

## Report contract

The report must include:

- exact files and contract changes;
- RED commands and observed failure reason for each finding;
- GREEN/regression commands and results;
- App line counts and module-boundary result;
- external effects and prohibited-scope confirmation;
- unverified areas;
- exact scoped rollback from the fix snapshot;
- any concern that prevents `Ready: Yes`.

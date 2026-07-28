# Task 9 brief — permanent module boundaries and architecture records

## Source of truth

- Plan Task 9, approved design, `/Users/songliang/.codex/AGENTS.md`, SDD ledger.

## Goal and acceptance

Convert the completed extraction into permanent executable guards and concise architecture records so future changes cannot reintroduce category functions or local-product category inference into `server/index.mjs`.

Acceptance:

- module-boundary test rejects every legacy category helper and `inferred: true`;
- server entry line guard lowers from 5400 to 5200 (current count is 5183; 17-line headroom);
- architecture record assigns Ozon query/cache/pagination/type resolution to the service, authentication/HTTP mapping to routes, and forbids local product caches as category sources;
- preview/listing consumer contract is documented;
- design status becomes “已实施，待完整验证”; Task 10 alone may mark full verification;
- no production code changes.

## Approved files

- Modify `server/tests/module-boundaries.test.mjs`
- Modify `docs/architecture/module-boundaries.md`
- Modify design status line only
- Modify Task 9 checkboxes only in the plan
- Operational snapshots/report/scoped diff under this SDD directory

## Test-first note

Task 9's planned assertions were originally described as being added before Task 6 deletion. Execution is sequential and Task 6 has already deleted the legacy code, so the new guards should pass immediately as regression coverage. Do not fabricate a RED result. Record that they are coverage locks over already-green behavior.

## Implementation and verification

1. Snapshot every existing approved file with SHA-256 under `snapshots/task-9-before/`.
2. Add the exact legacy-function and `inferred: true` assertions.
3. Lower only the server line guard to 5200; do not raise the App guard.
4. Update architecture/status/Task 9 checkboxes precisely.
5. Run with fixed Node:

```bash
node server/tests/module-boundaries.test.mjs
node --check server/index.mjs
node --check server/ozon-category-service.mjs
node --check server/ozon-category-routes.mjs
```

Run the planned no-match `rg`, scoped whitespace checks, and confirm `wc -l server/index.mjs <= 5200`.

Mandatory review:

- assertions target declarations, not harmless mentions in docs/comments;
- line guard has no more than 20 lines headroom and is strictly lower;
- docs match real current modules and do not claim Task 10 verification;
- no unrelated architecture or production changes.

## Safety

- Documentation/tests only; no Ozon/network/browser/DB/package/build/data changes.
- No Git write operations.
- Preserve dirty `main`.

## Handoff

Write `task-9-report.md` and `task-9-review-package.diff`, with coverage-lock evidence, exact guard/count, docs/status, rollback and concerns. Report without committing.

# Final review package

## Requirements

- Design: `docs/superpowers/specs/2026-07-28-ozon-sync-service-extraction-design.md`
- Plan: `docs/superpowers/plans/2026-07-28-ozon-sync-service-extraction.md`
- Global rules: `/Users/songliang/.codex/AGENTS.md`

## Current implementation

- `server/ozon-client.mjs`
- `server/store-cache-scope.mjs`
- `server/ozon-sync-service.mjs`
- `server/index.mjs`
- `server/tests/ozon-client.test.mjs`
- `server/tests/store-cache-scope.test.mjs`
- `server/tests/ozon-sync-service.test.mjs`
- `server/tests/module-boundaries.test.mjs`
- `scripts/check-store-data-isolation.mjs`

## Execution evidence

- SDD ledger: `.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/progress.md`
- Task reports/reviews: same directory, `task-1` through `task-9`
- Final verification: `task-9-report.md`
- Baseline: `task-1-report.md` and `task-1-dirty-baseline.txt`

## Review method

- This work was intentionally performed without commits in an existing dirty `main` checkout.
- Use the task `*-before-*` snapshots for scoped comparisons.
- Read all current implementation and new tests in full.
- Do not mutate the working tree or rerun full verification already recorded.

## Required focus

- One Seller API HTTP implementation, stable GET/POST error contract, timeout correctness, and credential redaction.
- Multi-account/store cache isolation and final ownership revalidation.
- Complete product, FBS/FBO order, warehouse, and promotion pagination/terminal behavior.
- Atomic cache submission and RUNNING/SUCCESS/FAILED closure under conflicts and failures.
- Same-identity concurrent POSTINGS merge.
- Entry route contract and seven-field whitelist.
- No database/config/dependency/external-write change.
- Tests assert real behavior and do not silently permit partial data.
- Triage, rather than silently discard, ledger deferred findings:
  - upsert boolean/client/name fallback coverage;
  - repeated non-empty FBO `last_id`.
- Assess the Task 9 concern that a non-2xx Ozon response body can enter `report.error`.
- Distinguish the six known PostgreSQL-offline baseline failures from implementation regressions.

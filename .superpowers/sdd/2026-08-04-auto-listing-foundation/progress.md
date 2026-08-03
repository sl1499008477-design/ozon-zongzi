# SDD ledger — plan: docs/superpowers/plans/2026-08-04-auto-listing-foundation.md

Workspace: /Users/songliang/Documents/sonli ozon3.0/.worktrees/auto-listing-ai
Branch: codex/auto-listing-ai
Merge base: 880c3a3

Baseline: app build passed; dependency installation passed. Full verify reached 372 passing tests, then 3 pre-existing browser-launch failures (Chrome SIGABRT in app store-form browser test and two extension browser fixtures); remaining tests were cancelled after the hung browser test was interrupted. Extension upstream parity checks are configuration-blocked because QH_SOURCE_EXTENSION_DIR is unset. Focused non-browser suites remain the task gate.

Task 1: fix round 1/5 (4 addressed, 1 new open — draft strategy updates were swallowed; commits 2e612f6..3b2d1d3)
Task 1: fix round 2/5 (1 addressed, 0 open — draft updates return NEW; commit 199444b)
Task 1: complete (commits 880c3a3..199444b, review clean)
Task 1: unverified range — live PostgreSQL migration/trigger behavior not run because no dedicated SONLI_MIGRATION_TEST_DATABASE_URL is configured.
Task 2: fix round 1/5 (2 Important and 1 Minor addressed — reject inverted price evidence, scan forbidden keys inside arrays, stabilize invalid-container errors; commit 2644f50)
Task 2: complete (commits 0758e42..2644f50, independent re-review PASS)
Task 2: verification — focused pricing/config plus existing pricing-engine regression: 17/17 passed with bundled Node; git diff --check passed.
Task 2: deferred integration — store/warehouse ownership and trustworthy product-dimension evidence are intentionally enforced by the later service layer, not this pure contract task.
Task 3: fix round 1/5 (4 Important addressed — duplicate rule IDs, cyclic JSON, dangerous JSON keys, and state/event type coercion; commit 0d7adb3)
Task 3: complete (commits 7105b7f..0d7adb3, independent re-review PASS)
Task 3: verification — Task 3 plus Task 2 regression: 32/32 passed with bundled Node; git diff --check passed.
Task 3: deferred integration — persisted strategy publication, recorded recovery-point selection, authorization, and external execution remain for later tasks.
Task 4: fix round 1/5 (original Critical/Important/Minor set addressed in 7c7d4ac; re-review found persistence-defense gaps)
Task 4: fix round 2/5 (warehouse policy, semantic snapshot, event audit, DTO and rollback hardening in 31591d5; re-review found four remaining boundaries)
Task 4: fix round 3/5 (strategy/price re-verification and real PG concurrency/trigger fixtures in 5a9905c; re-review found evidence-role boundaries)
Task 4: fix round 4/5 (low-price facts, canonical raw/source bounds, closed price object and bounded barrier in 8699d9c; re-review found numeric-price isolation and barrier rejection edge)
Task 4: fix round 5/5 (numeric price facts isolate to BLOCKED siblings and resolve-only barrier cleanup in a05daf7)
Task 4: complete (commits 73d76fc..a05daf7, independent final re-review PASS)
Task 4: verification — 30 Task 4 always-on tests passed, 42 Task 2/3/warehouse regressions passed, syntax and diff checks passed; one gated PostgreSQL test skipped.
Task 4: unverified range — real PostgreSQL migrations, two-connection snapshot race, post-write rollback, draft/raw linkage, trigger rollback, FK behavior and client release were not dynamically executed because AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL are not configured. No production database fallback was used.
Task 5: fix round 1/5 (6 Important + 2 Minor addressed — exact route methods, disabled short-circuit, public error/status/item DTOs, target/query bounds, route import/SQL/AI/Ozon guard, and retryable shared PostgreSQL initialization; commit fb61f4e)
Task 5: round 1 verification correction — focused routes/boundaries/connection 21/21; Task 1–5 foundation 87/87; historical named persistence/listing/store command 38/38; independent expanded regression 35 pass/1 PostgreSQL-config skip.
Task 5: fix round 2/5 (1 Important + 3 Minor addressed — auth-stage error isolation, Acorn import/query boundary, single-flight pool close, and evidence counts; pending commit)
Task 5: round 2 verification — focused 24/24; Task 1–5 foundation 90/90; permissions/persistence/listing/store regression 42/42; gated PostgreSQL 1 pass/1 dedicated-DB skip.

# Task 10 Report — End-to-end account-shared category recovery acceptance

Date: 2026-08-13

## Outcome and tested implementation

Task 10's final implementation commit is `bb3224741bf4ace4533316ee290af288a018a39d` (`test(categories): close Task10 recovery proof gaps`). Three production contract blockers found only by composing the real path were fixed in separate commits: `c240040` preserves the validated store's internal `ownerAccountId`; `48e4fca` accepts the normalizer's canonical missing recovery SKU as `""` while rejecting unsafe carriers; and `bb21c02` reuses the existing Shanghai local-day contract so the real import-history route renders instead of referencing an undefined formatter.

Whole-branch final review then added manual-confirmation provenance in migration 070, the crash-safe stock-write ledger in migration 071, pre-authorization ledger settlement, and migration 072's exact confirmation-audit binding. The latest fully verified implementation and current-schema repository gate is `758b4399fe637e1c0056cbc9934639f4a97631cf`; the focused final-review reports record these changes. Production automatic category recovery remains disabled.

The earlier `9ba5870` Task 10 commit was independently reviewed and rejected as insufficient because its E2E self-simulated important transitions and its browser proof was a static page. Those gaps are not reported as passing evidence. The final E2E calls production `ingestCollectRequestV4`, the real collection/shared-category repository, auto-listing service and listing-base preparer, persistent submission outbox lifecycle, cache-busted replacement workers and reconciler, category-recovery service/repository, migration-069 child-result persistence, and stock continuation. The loopback fake is only the target of production HTTP transports.

Production automatic category recovery remains **disabled**. The V1 structured category-error policy is intentionally empty. The E2E's only direct recovery seed is one explicitly labelled historical V2 terminal error-evidence carrier in a disposable database; all recovery state and effects after that seed flow through production code. No production evidence-injection route or policy rule was added.

## TDD and file boundary

Review REDs proved that the old E2E did not call production composition, directly seeded its successful collection source, did not rebuild workers across restart, and did not capture exact transport identity. The RFBS fixture stopped at migration 062 and lacked the current shared-category prerequisites; the real preparer produced a valid missing SKU that the recovery repository rejected; and the real import-history route referenced an undefined formatter. Each production fix was committed separately from the E2E implementation.

Task 10 changed the planned E2E, runbook and package script. The parent-approved adjacent test-only expansion is `server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs`; it now applies 001–072 and creates exact current PRODUCT_DRAFT evidence, current-source pointer and ACTIVE account-shared category before exercising its existing RFBS production path. It does not bypass triggers, timestamps, replication, tenant checks or the empty production policy.

## Passing verification

- Task 10 production-composition E2E: **4 passed, 0 failed, 0 skipped**.
- Adjacent real RFBS worker E2E: **1 passed, 0 failed, 0 skipped**.
- The earlier stable Task 1–9 focused gate: **180 passed, 0 failed, 0 skipped**.
- The earlier fresh main PostgreSQL category/recovery/upload gate: **37 passed, 0 failed, 0 skipped**, including the separately named reconciliation database.
- Vite production build: **4,843 modules transformed**, exit zero; the existing large-chunk warning remains.
- Syntax checks and `git diff --check`: passed.

The final Task 10 E2E was rerun on two disposable PostgreSQL 16 containers and now applies migrations 001–072. It proves production collection persistence, one account-shared row across two stores, immutable and exactly bound manual-confirmation audit provenance, cross-account zero-write paths, immutable original FAILED item/evidence, one exact recovery attempt, one 069 child, exact original/retry import bodies and credential scope, exactly one corrected retry import, one exact generation-bound 071 stock intent/event chain, delivered outbox history, and restart/replay without a third import or repeated stock.

Its worker failure matrix uses independent production jobs: auth and throttling are real `/v3/product/import` 401/429 responses; brand and currency are real `/v1/product/import/info` item failures; stock is a real `/v2/products/stocks` 503 after a successful import and remains PARTIAL_SUCCESS without replayed import/stock. Every non-category case creates zero category recovery attempts and zero category evidence. The adjacent RFBS E2E provides the real PRE_IMPORT warehouse-missing/status/type/response-loss cases and PRE_STOCK/type/stock cases. Error labels not recognized by the deliberately empty production policy are only proven not to recover; they are not claimed as authoritative Ozon classifications.

The destructive migration test uses two stores with conflicting retired targets, current job/event and audit sentinels, a malformed raw-fact transaction rollback, a second restored database, and an actual pre-upgrade repository read contract imported from commit `411d33b7...`. It does not claim reverse SQL can restore deleted rows.

## Browser acceptance

Browser acceptance used the bundled browser client through Node REPL against the real Vite app and real local API on isolated loopback ports (frontend 61422, API 61421), with safe disposable local records. It did not use external Playwright or the old port-3000 process. No write control was clicked.

The visible UI proved:

- one latest row for the same product/store;
- persisted creation time `2026-08-12 10:00:00` with no current-time fallback;
- safe store name `粽子测试店铺` instead of an internal ID;
- account-shared/fixed category copy without retired per-store matching wording or raw platform error text;
- real `/ozon/products/import-history` rendered the persisted latest and older task timestamps in newest-first order;
- the older row's read-only **查看** action opened **上架任务详情** with the exact local/Ozon task IDs, historical update time, failed item and fixed safe error copy.

Evidence:

- `evidence/task10-real-auto-listing-48e4fca.png`
- `evidence/task10-real-import-history-detail-round2.png`

The browser tab was finalized; the API and Vite processes were stopped; the exact disposable PostgreSQL containers `task10-round2-source` and `task10-round2-restore`, browser state directory and worktree-only `app/node_modules` symlink were removed. The previously shared Node 24.14.0 runtime was neither created nor deleted by this task. The tracked worktree is clean at verification commit `aa3956b` over implementation commit `bb32247` and browser-blocker fix `bb21c02`.

## Not verified and rollback

No real Ozon, paid AI, object storage, production credential, production database, deployment, production migration or production restore was contacted. The repository-wide bounded verifier is not green: its earlier bounded run was blocked by missing extension parity configuration and unrelated existing dependency/browser/product-delegation failures. Those results are not counted as passes; affected Task 10 gates were run independently.

Migration 063 has no safe reverse SQL. Rollback requires stopping all writers, restoring the verified pre-upgrade backup, deploying the matching old application SHA, reconciling every possibly external Ozon product/import/stock outcome, and resuming only known-safe work. Never synthesize retired target IDs.

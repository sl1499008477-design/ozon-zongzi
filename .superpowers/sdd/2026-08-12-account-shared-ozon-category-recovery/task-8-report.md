# Task 8 Report — One-shot category recovery in the listing worker

Date: 2026-08-13

## Outcome

Task 8 is complete within the original scope plus the review-approved fix-round-1 migration/test expansion. The listing worker now has one identity-closed recovery orchestration for a first complete explicit category failure, submits the immutable Task 7 `corrected_items`, preserves the original task and its failed item evidence, binds the retry task once, resumes the existing PRE_STOCK/RFBS/stock continuation after retry success, and sends a second category failure to review without a third import.

Production policy V1 remains deliberately empty. No production input can currently create `EXPLICIT_CATEGORY_FAILURE`; Task 8 adds no rule injection, message matching, or alternative authority. The worker composition is therefore dormant and was verified through injected closed ports. Enabling it later requires an authoritative Ozon fixture, a separately reviewed policy version, and separately reviewed production recovery composition.

## Approved plan amendment

The literal Task 8 Step 2 transition `CHECKING -> RETRY_PENDING` conflicts with the reviewed Task 7 migration 068 contract: evidence and the sole recovery attempt are eligible only after the exact job and all submission items are durably `FAILED`. The approved implementation uses two dedicated phases:

1. `CHECKING -> FAILED` persists the terminal item/evidence fact.
2. After Task 7 proves offer absence and commits the match, only the category transaction admits `FAILED -> RETRY_PENDING` for the same job.

Generic transitions do not gain either category-retry edge. Migration 068 and the Task 7 repository were not modified or loosened.

## Product contracts changed

- `listing-worker.mjs` adds the injected one-shot controller, exact eligibility exclusions, retry acceptance/completion identity binding, retry response-loss reconciliation, and a tested completion-before-existing-stock continuation. Task 7 recovery owns the sole retry schedule; the worker does not schedule a second time after the service returns.
- `listing-pipeline.mjs` projects `effectiveItems` from immutable corrected items only for an exact same-account/job/snapshot `MATCHED/RETRY_PENDING` attempt. It adds the dedicated same-job retry transaction and exact acceptance/completion/review ports. The original snapshot items are never changed.
- `listing-submission-policy.mjs` admits only the approved dedicated two-phase category transitions and rejects the direct or generic variants.
- Reconciliation loads the recovery attempt only through the same account/job/snapshot, retains the original auto-listing link and submission job, and records only safe attempt/task/category-version metadata.
- Upload terminal/replay projection follows the same original submission link/job and exposes only safe recovery identity. It does not reserve another upload, rerun AI, or republish assets.

Fix round 1 adds one compatible migration for append-only retry child results. No dependency, lockfile, UI, credential, deployment configuration, paid AI path, publication path, or external API contract changed.

## Review fix round 1 — immutable original failure and exact retry child results

- Migration 069 stores retry item results under the complete account/job/snapshot/attempt/retry-task/item/offer identity. Only the exact `RETRY_ACCEPTED` attempt and its original failed item may first write; rows are append-only, terminal, monotonic and replay-idempotent. Attempt completion/review is rejected with SQLSTATE `23514` until one complete consistent child result set exists.
- The worker no longer overwrites Task 6 `submission_items` during a category retry. It persists the retry terminal result through a dedicated port before completion or review. Conflicting, partial, cross-tenant, stale-task or wrong-offer commands make zero child writes and cannot create a third import.
- Reconciliation reads exact child results for the terminal retry audit while retaining the original FAILED row and `errorEvidence` unchanged in storage. Its recovery metadata is an exact descriptor-only six-field projection; getters and transparent/revoked proxies are rejected without execution using one fixed safe error.
- The controller now accepts the standard import-status representation of an absent failed `productId` (`""`) as well as the closed evidence representation (`null`). Production policy V1 remains empty; this only keeps the dormant future composition consistent with the existing normalizer.
- Adding 069 required advancing the existing Task 7 PostgreSQL migration runner and seeding its already-accepted retry terminal transitions with exact child results. No Task 7 eligibility, matching, provenance or one-attempt rule was loosened.

## TDD evidence

- Initial focused RED: 12 tests, 9 passed and 3 failed because the worker controller, dedicated transition gate, and safe recovery audit projection did not exist.
- Additional RED checks failed before the success-continuation export, response-loss disposition export, and Task 7-owned sole-schedule contract were implemented.
- Final focused GREEN: **25 passed, 0 failed, 0 skipped**.

The focused tests cover the first recovery, immutable corrected retry items, original/retry task identity, PRE_STOCK/RFBS/stock continuation, second failure with zero third import, response loss after either import, partial/product/processing/non-category/unknown exclusions, and the dedicated transition lattice.

## Verification

- Fix round 1 focused RED: **18 tests, 14 passed and 4 failed**, plus the real PostgreSQL test failed before the child-result port existed. Additional RED assertions proved that reconciliation previously audited the immutable original FAILED item instead of the retry result, that non-ASCII valid offers were rejected at the service boundary, and that the worker did not accept the real empty-string failed-product representation.
- Fix round 1 final focused GREEN: **21/21 passed, 0 failed, 0 skipped**.
- Fresh disposable PostgreSQL 16 on tmpfs: Task 8 reconciliation **1/1**, Task 7/account-shared/persistence/repository **32/32**, and upload/RFBS **4/4** — **37/37 passed, 0 failed, 0 skipped**. The database assertions prove the original FAILED row/evidence remain unchanged, retry success and second failure are child rows, replay is idempotent, invalid scope writes zero rows, direct mutation/incomplete terminal transitions return `23514`, success audit uses the child result, and the second failure creates no third import.
- Adjacent Task 4–8, Task 5/6, empty-policy, upload, RFBS, category rebuild and reconciliation regressions: **243/243 passed, 0 failed, 0 skipped**. Listing Pipeline V3 also passed on a separate fresh database in the same disposable PostgreSQL container.
- Syntax checks and `git diff --check` passed. No real Ozon, AI, object storage, production database, production credential or deployed service was contacted.

- Fresh disposable PostgreSQL 16, isolated database per suite: reconciliation 1/1, Task 7 recovery 3/3, account-shared migration 3/3, persistence 2/2, and upload/RFBS 2/2 — **11 passed, 0 failed, 0 skipped**.
- The reconciliation PostgreSQL test directly executes the new production `FAILED -> RETRY_PENDING`, retry acceptance, and recovery completion ports, then verifies the original link/job and safe recovery audit metadata.
- Account-shared repository rerun with its PostgreSQL gate enabled: **24 passed, 0 failed, 0 skipped**.
- Task 4–8 migration/trusted-time/warehouse boundary subset: **22 passed, 0 failed, 0 skipped**.
- Adjacent Task 4–8, Task 5/6, empty production policy, upload, RFBS and stock regression: **222 passed, 0 failed** plus one conditional PostgreSQL placeholder; that exact repository suite was then rerun enabled on a fresh database as 24/24 with zero skips.
- Listing Pipeline V3 passed on a fresh disposable database.
- Syntax checks for all ten changed production/test files and `git diff --check` passed.

No real Ozon seller/product/stock call, AI request, object-storage write, production credential, production database, or deployed service was used.

## Residual gate and rollback

## Automatic fix round 2 — closed recovery audit and crash replay

- Reconciliation now accepts exactly six descriptor-only recovery fields and validates the nullable shape and job/task relationship independently for `CLAIMED`, `MATCHED`, `RETRY_PENDING`, `RETRY_ACCEPTED`, `SUCCEEDED`, and `NEEDS_REVIEW`. Transparent/revoked proxies and accessors are rejected with the fixed safe error before execution.
- Retry-import response loss no longer reads the original Ozon task or submits a third import. Only an actually ambiguous delivery error closes the exact `RETRY_PENDING` attempt for safe review; definitely-not-sent and local RFBS validation errors remain on their existing paths.
- Submission work loads the exact migration-069 retry child rows. A crash after child persistence, attempt success, or attempt review resumes idempotently from those rows, closes the original job, and never mutates the original FAILED item/evidence or repeats import. In the exercised barriers the stock continuation ran once across two replays.
- TDD RED exposed the missing status-specific nullable contract, proxy execution/null coercion, missing child replay, incomplete child acceptance, and overbroad retry-uncertainty classification. Final focused/adjacent unit gate: **203 passed, 0 failed**; its two PostgreSQL placeholders were then exercised separately rather than counted as passes. Fresh PostgreSQL reconciliation: **1/1 passed, 0 failed, 0 skipped**. The earlier complete fresh database matrix remains **37/37, 0 skipped**.
- Sharp was verified with Node 24.14.0 and Sharp 0.34.5. The extra Sharp-related diagnostic was **89/90**: the sole failure is the unmodified `auto-listing-source-materializer` fixture lacking the category now required by the pre-existing Task 5 contract, so it is explicitly not reported as a passing gate.
- No real Ozon, AI, object storage, stock endpoint, production database, credential, or deployed service was contacted. Round 2 adds no migration and changes no production external contract.

## Automatic fix round 3 — terminal retry-submit failures

- Every failure while the sole category retry is still `RETRY_PENDING` now uses one exact tenant/job/snapshot/attempt transaction. Ambiguous response loss records `AUTO_LISTING_CATEGORY_RETRY_TASK_UNKNOWN`; definitely-not-sent, RFBS/local validation and retry-task persistence failures record `AUTO_LISTING_CATEGORY_RETRY_SUBMIT_FAILED`. Both atomically advance the attempt to `NEEDS_REVIEW` and the original job to `FAILED`; none enters generic `RECONCILING`, schedules a third import, or queries the original Ozon task.
- If the exact retry task was already persisted before status-check scheduling failed, replay observes only the same fully scoped `RETRY_ACCEPTED` identity. It does not review or resubmit; the existing watchdog moves `OZON_ACCEPTED -> CHECKING` and creates one deduplicated check for that retry task. Wrong-account or wrong-tuple commands write nothing.
- TDD controller RED was **9 passed / 2 failed** before the new handler and exact persisted-task replay existed. The PostgreSQL RED then failed at the old unknown-only review port for definite/local failures. Final focused worker: **11/11**; adjacent unit gate: **204 passed, 0 failed** with two PostgreSQL placeholders separately exercised; fresh disposable PostgreSQL 16: **1/1 passed, 0 failed, 0 skipped**. The database test covers all four failure classes, two replays each, monotonic attempt/job state, one import, and the exact retry-task check recovery.
- Syntax and diff checks passed. No real Ozon, AI, object storage, stock endpoint, production database, credential, or deployed service was contacted. Round 3 adds no migration or file-scope expansion.

- Not verified by design: a real current Ozon category-invalid payload and production automatic triggering. Empty V1 fails closed until official evidence is reviewed.
- Enabling recovery is not a data-only toggle: it requires a reviewed policy-version change and production composition review; tests must then repeat the same first/retry/uncertain-path matrix against the authoritative fixture.
- Roll back application behavior by reverting the Task 8 fix commit. Migration 069 is additive and may remain dormant; preserve both 068 and 069 append-only evidence. A physical schema rollback requires stopping recovery work and proving no 069 child rows exist before dropping its triggers/table/constraint in reverse order. Never delete recovery or audit rows to imitate rollback.

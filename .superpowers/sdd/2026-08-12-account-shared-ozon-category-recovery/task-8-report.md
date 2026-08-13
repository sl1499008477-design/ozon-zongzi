# Task 8 Report — One-shot category recovery in the listing worker

Date: 2026-08-13

## Outcome

Task 8 is complete within the planned ten product/test files. The listing worker now has one identity-closed recovery orchestration for a first complete explicit category failure, submits the immutable Task 7 `corrected_items`, preserves the original task as evidence, binds the retry task once, resumes the existing PRE_STOCK/RFBS/stock continuation after retry success, and sends a second category failure to review without a third import.

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

No database migration, dependency, lockfile, UI, credential, deployment configuration, paid AI path, publication path, or external API contract changed.

## TDD evidence

- Initial focused RED: 12 tests, 9 passed and 3 failed because the worker controller, dedicated transition gate, and safe recovery audit projection did not exist.
- Additional RED checks failed before the success-continuation export, response-loss disposition export, and Task 7-owned sole-schedule contract were implemented.
- Final focused GREEN: **25 passed, 0 failed, 0 skipped**.

The focused tests cover the first recovery, immutable corrected retry items, original/retry task identity, PRE_STOCK/RFBS/stock continuation, second failure with zero third import, response loss after either import, partial/product/processing/non-category/unknown exclusions, and the dedicated transition lattice.

## Verification

- Fresh disposable PostgreSQL 16, isolated database per suite: reconciliation 1/1, Task 7 recovery 3/3, account-shared migration 3/3, persistence 2/2, and upload/RFBS 2/2 — **11 passed, 0 failed, 0 skipped**.
- The reconciliation PostgreSQL test directly executes the new production `FAILED -> RETRY_PENDING`, retry acceptance, and recovery completion ports, then verifies the original link/job and safe recovery audit metadata.
- Account-shared repository rerun with its PostgreSQL gate enabled: **24 passed, 0 failed, 0 skipped**.
- Task 4–8 migration/trusted-time/warehouse boundary subset: **22 passed, 0 failed, 0 skipped**.
- Adjacent Task 4–8, Task 5/6, empty production policy, upload, RFBS and stock regression: **222 passed, 0 failed** plus one conditional PostgreSQL placeholder; that exact repository suite was then rerun enabled on a fresh database as 24/24 with zero skips.
- Listing Pipeline V3 passed on a fresh disposable database.
- Syntax checks for all ten changed production/test files and `git diff --check` passed.

No real Ozon seller/product/stock call, AI request, object-storage write, production credential, production database, or deployed service was used.

## Residual gate and rollback

- Not verified by design: a real current Ozon category-invalid payload and production automatic triggering. Empty V1 fails closed until official evidence is reviewed.
- Enabling recovery is not a data-only toggle: it requires a reviewed policy-version change and production composition review; tests must then repeat the same first/retry/uncertain-path matrix against the authoritative fixture.
- Rollback is application-only: revert the Task 8 commit. Keep migration 068 and its append-only recovery/evidence history; do not delete audit rows to imitate rollback.

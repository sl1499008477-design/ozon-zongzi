# Task 8 Brief — Integrate one category recovery into the listing worker

Date: 2026-08-13

## Goal and acceptance gate

Connect the existing Task 6 structured import-result contract and Task 7 one-shot recovery contract to the production listing worker without creating a second submission job, upload, paid-AI run, asset publication, or stock side effect. The first eligible terminal category-only failure may create the sole recovery attempt only after exact offer absence is proved. Its retry reads immutable `corrected_items`, records one retry task identity, and on success resumes the existing RFBS/PRE_STOCK and stock flow.

Task 6 production policy V1 remains empty. Task 8 does not add an allowlist rule, test-only production policy injection, message matching, or another path to manufacture `EXPLICIT_CATEGORY_FAILURE`. Worker tests use injected closed ports to prove the future enabled-policy behavior; production remains unreachable until a separately reviewed authoritative policy version is added.

## Exact file scope

Only the ten Task 8 implementation/test paths are in product scope:

- `server/listing-worker.mjs`
- `server/listing-pipeline.mjs`
- `server/listing-submission-policy.mjs`
- `server/auto-listing-submission-reconciliation-postgres.mjs`
- `server/auto-listing-submission-reconciler.mjs`
- `server/auto-listing-upload-postgres.mjs`
- `server/tests/listing-worker-category-recovery.test.mjs`
- `server/tests/listing-submission-policy.test.mjs`
- `server/tests/auto-listing-submission-reconciliation-postgres.integration.test.mjs`
- `server/tests/auto-listing-submission-reconciler.test.mjs`

This brief, the Task 8 report, and the SDD ledger are implementation evidence, not expanded production scope. If the production composition requires another port or file, implementation stops and reports the boundary before any expansion.

### Review-approved fix-round-1 scope expansion

The initial Task 8 implementation reused `submission_items` for retry results. That violates Task 6/7 provenance because those rows contain the original failed import result and exact category error evidence required by migration 068. The review therefore explicitly expands the boundary only to:

- create `server/db/migrations/069_submission_category_recovery_item_results.sql`;
- extend the existing migration contract test and the existing Task 8 listing-pipeline/PostgreSQL test needed to exercise the new production port;
- advance the existing Task 7 PostgreSQL migration runner's terminal migration assertion from 068 to 069; its Task 7 behavior assertions remain unchanged.

Migration 069 stores child retry item results under the complete account/job/snapshot/attempt/retry-task/item/offer identity. It does not alter migration 068, the original `submission_items`, the original error evidence, or the one-attempt rule. Retry child results are append-only, terminal-monotonic and idempotent; only the exact `RETRY_ACCEPTED` attempt may first write them. Recovery completion/review must derive their decision from this exact child result set.

### Automatic fix-round-2 review contract

The approved second review round stays within the existing Task 8 files and migration 069. It closes the six-field recovery summary per attempt status, handles retry-response uncertainty through the exact retry identity only, and resumes terminal work from exact child rows after the specified crash barriers. It introduces no new migration, external side effect, production policy rule, or file-scope expansion.

### Automatic fix-round-3 review contract

Any failure during the single retry submission must either atomically terminate the exact pending attempt/job for review or, when the retry task identity was already durably accepted, resume checking only that exact retry task. Generic reconciliation, original-task lookup, and another import are forbidden. The change remains inside the existing worker/pipeline/test scope and migration 069.

### Automatic fix-round-4 review contract

The stale-job watchdog must resolve an exact account/job/snapshot recovery relation before generic recovery. Pending retry submissions without a persisted retry task terminate atomically for review, accepted retry tasks resume only their own check, and missing/ambiguous/cross-tenant recovery relations fail closed. Ordinary non-recovery watchdog behavior remains unchanged.

## Closed worker behavior

- Only the first terminal, all-item allowlisted category failure with every `productId` absent may enter Task 7 recovery. Partial success, any product identity, still-processing, unknown, ordinary/non-category failure, response loss, or offer `PRESENT/UNKNOWN` causes zero category refresh.
- Recovery is tied to the same account, submission job, immutable snapshot, original Ozon task, evidence, source category, and shared category version. There is at most one recovery attempt for the job.
- Retry work uses only the recovery attempt's immutable `corrected_items`; it never rereads mutable drafts or current category state as listing authority. The original snapshot remains unchanged.
- The original task remains permanent evidence. The retry task is first-set once on the child recovery attempt and becomes the only task checked for the retry outcome.
- Retry success follows the existing PRE_STOCK/RFBS authorization and stock synchronization. A second category failure becomes review/failed with zero third import.
- Submit or status response loss follows the existing `RECONCILING` path and never creates another recovery attempt or speculative import.

## State and reconciliation boundaries

- Plan amendment: Task 8 Step 2's literal `CHECKING -> RETRY_PENDING` conflicts with the already-reviewed Task 7 database contract, which admits error evidence and a sole `CLAIMED` attempt only while the exact job and all items are `FAILED`. The approved safe implementation is therefore two dedicated phases: `CHECKING -> FAILED` persists the terminal item/evidence fact, then after Task 7 absence/match succeeds only a focused category transaction may perform `FAILED -> RETRY_PENDING` and schedule the same job. Generic transitions must not gain either category-retry transition. Migration 068 and the Task 7 repository remain unchanged and are not loosened.
- `loadSubmissionWorkV3()` exposes corrected effective items only for an exact same-account/job/snapshot recovery row in `MATCHED` or `RETRY_PENDING`; all other states use the original snapshot items. The worker submits `effectiveItems`, while history retains `snapshot.items`.
- The same `auto_listing_submission_links` row and `submission_job_id` remain authoritative. No replacement link/job, new upload reservation, AI call, asset publication, or media republish is allowed.
- Final reconciliation advances the original auto-listing item/link once. Safe audit metadata may include recovery attempt ID and old/replacement category versions, but never raw provider text or credentials. Terminal/replay upload projections must tolerate corrected immutable items without reopening upload work.

## TDD and verification plan

1. Preserve the existing focused baseline.
2. Add worker RED tests for one recovery, immutable corrected retry input, original/retry task identity, RFBS/stock continuation, second failure, response loss, and every zero-refresh exclusion.
3. Add policy/repository/reconciler RED tests proving the transaction-only transition, effective-item selection, same-job/link replay, safe recovery audit projection, and zero upload/asset replay.
4. Report RED counts and any contract conflict before production edits.
5. Implement the minimum changes in the six planned production files, then run focused GREEN.
6. Run reconciliation against a fresh disposable PostgreSQL 16 database with zero skipped tests, followed by Task 4–7, Task 5/6 worker/pipeline, RFBS/stock/upload and empty-policy adjacent regressions.
7. Run syntax and diff checks, write the report/ledger, commit, and remove disposable resources.

No real Ozon seller API, product import, stock write, paid AI, object storage, production credentials, production database, or production service is contacted.

## Risks and rollback

- The dominant risk is duplicate external writes after response loss. The worker must reconcile the existing task/offer and never interpret uncertainty as retry eligibility.
- The retry task must not erase the original task evidence or replace immutable upload linkage. Exact replay must be idempotent.
- Rollback is application-only for Task 8: revert the Task 8 commit. Task 7 migration 068 and its append-only history remain intact; do not delete attempts/evidence to imitate rollback.

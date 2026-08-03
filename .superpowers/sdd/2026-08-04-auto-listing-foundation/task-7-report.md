# Supplemental Task 7 Report — Failure-Stage-Bound Retry Recovery

## Scope

- `server/auto-listing-state-machine.mjs`
- `server/auto-listing-repository.mjs`
- `server/db/migrations/026_auto_listing_recovery_point.sql`
- state-machine, migration, repository, and dedicated PostgreSQL tests

No configuration, pricing, snapshots, warehouses, routes, UI, extension, AI, or Ozon behavior changed.

## TDD evidence

- Initial RED: the new state-machine, migration, and repository contract command reported **5 passed, 6 failed**. The expected failures were missing recovery-point exports, absent additive migration, and the repository accepting mismatched/missing recovery-point retries without persisting the derived value.
- GREEN: the focused state/migration/repository/PostgreSQL-gate command reported **21 passed, 0 failed, 1 dedicated-DB skip**.
- Cancellation RED: a deliberately failing recovery-column assertion reported `UPLOAD !== null` when cancellation retained a retryable item's recovery point. The minimal CAS assignment was restored so cancellation clears it; the focused repository test then passed.

## Contract and transaction design

- The state machine owns the only mapping: `PLANNING -> PLANNING`, `GENERATING -> GENERATION`, and `UPLOAD_QUEUED`/`UPLOADING -> UPLOAD`. Each mapped recovery point permits exactly one retry event.
- The repository locks `status`, `status_version`, and `recovery_point` with `FOR UPDATE`. `RETRYABLE_FAILURE` derives the point from that locked status, verifies a supplied conflicting point, and writes status, failure fields, recovery point, and safe event details in the same transaction.
- Retry events reject `failureCode` and recovery overrides. Wrong retry events fail before the item update or event insert. A correct retry and `CANCEL` both clear failure and recovery fields in the same CAS update.
- A legacy retryable row with no column value is accepted only when its latest persisted `RETRYABLE_FAILURE` event has a failure source that can be mapped. Missing or invalid evidence fails closed with `AUTO_LISTING_RECOVERY_POINT_INVALID`.
- Migration `026_auto_listing_recovery_point.sql` sorts after `026_auto_listing_foundation.sql` under the existing migration discovery rule. It uses `ADD COLUMN IF NOT EXISTS` plus a guarded closed-value check; it does not backfill or guess legacy records.

## Verification

- Focused state/migration/repository/PostgreSQL gate: **21 passed, 0 failed, 1 skipped**.
- Full always-on foundation gate (including the new repository suite): **101 passed, 0 failed**.
- Historical nine-file permissions/persistence/listing/store regression: **42 passed, 0 failed, 0 skipped**.
- Dedicated PostgreSQL command with `AUTO_LISTING_POSTGRES_TESTS=1`: **1 passed, 1 skipped** because `SONLI_MIGRATION_TEST_DATABASE_URL` is unset. The suite does not use `DATABASE_URL` or a production fallback.
- Syntax checks for both production modules and `git diff --check` passed.

## Unverified range and rollback

- The dedicated PostgreSQL fixture now covers the recovery write, wrong-retry no-event behavior, and correct retry clear path, but it could not execute without an explicit disposable `SONLI_MIGRATION_TEST_DATABASE_URL`.
- Keep `AUTO_LISTING_ENABLED=0`. To roll back code, revert this Task 7 commit; do not remove migration 026 records, recovery audit events, or task history.

## Fix round 1 — primary transition gate and legacy proof

- RED: the focused state-machine/repository tests reported **15 passed, 2 failed**. A direct `nextAutoListingStatus("RETRYABLE_ERROR", retry)` call still bypassed recovery evidence, and a legacy row accepted a later/non-failure event because the query filtered history before proving the latest event.
- GREEN: retry events are no longer ordinary `TRANSITIONS` entries. The primary `nextAutoListingStatus` and `assertAutoListingTransition` APIs require a matching recovery point for `RETRYABLE_ERROR`; omitted or mismatched evidence returns `AUTO_LISTING_TRANSITION_FORBIDDEN`. The repository invokes those APIs as its transition authority.
- Legacy lookup now reads the latest event only for the locked account, item, and job, without prefiltering by event type. It must prove `RETRYABLE_FAILURE`, `from_status -> RETRYABLE_ERROR`, matching item failure code, and a recovery point derived from that `from_status`; stale/later, foreign, malformed, or contradictory evidence returns `AUTO_LISTING_RECOVERY_POINT_INVALID` before any write.
- The always-on fixture covers valid legacy proof, a later non-failure event, foreign account/job/item rows, bad terminal status/details, and an event-insert exception after the item update, which records `ROLLBACK` and never `COMMIT`. The gated fixture now forces the same exception on `RETRYABLE_FAILURE` and asserts status, version, failure, recovery point, and event count remain unchanged.
- Verification: focused **24 passed, 0 failed, 1 dedicated-DB skip**; foundation **104 passed, 0 failed**; historical regression **42 passed, 0 failed**; gated dedicated-DB command **1 passed, 1 skipped** without `SONLI_MIGRATION_TEST_DATABASE_URL`; syntax and diff checks passed.

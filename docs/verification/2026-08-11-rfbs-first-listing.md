# RFBS first-listing verification — 2026-08-11

## Scope and tested revision

- Implementation commit: `c535cf7ff260cfcab77b9d1eeaf72b0fba2164d0`
- Base commit: `58a25b55ca5dc86996ed74ee993416563478274e`
- UI scope: closed FBS/verified-RFBS/pending-RFBS warehouse choices, creation-time read-only safety copy, and stable RFBS error actions.
- Backend scope: account-scoped warehouse eligibility regression and the minimal upload PostgreSQL context alias `item.id AS item_id` required by the actual upload service.
- E2E scope: actual create service, actual upload service and standard listing worker with disposable PostgreSQL and a loopback fake Ozon transport.

## Verification evidence

- Focused UI/create/verifier/repository/upload/account-isolation/E2E run: 131/131 passed, 0 failed, 0 skipped.
- Standalone RFBS first-listing E2E: 1/1 passed, 0 failed, 0 skipped.
- Task 5 upload service/repository/task worker/partial/replay adjacent run, forced serial: 43/43 passed, 0 failed, 0 skipped.
- Earlier non-PostgreSQL Tasks 1–5/UI adjacent run: 250/250 passed, 0 failed, 0 skipped.
- Earlier PostgreSQL adjacent run, serial: 11/11 passed, 0 failed, 0 skipped; dedicated reconciliation database: 1/1 passed, 0 failed, 0 skipped.
- Production app build: passed, 4,843 modules transformed; only the existing chunk-size warning remained.
- Changed server JavaScript syntax checks and `git diff --check`: passed.
- Independent read-only review after fixes: Critical 0, Important 0, Minor 0; Ready.

The first combined parallel PostgreSQL run is not counted as passing: it produced 259 passes, 2 failures and 1 skip because concurrent fixtures exhausted PostgreSQL lock resources (`53200 out of shared memory`, with a `max_locks_per_transaction` hint) and contended on a shared public schema. The unchanged suites passed in fresh serial/dedicated-database runs; no global PostgreSQL setting was raised.

Repository-level `pnpm verify` is also not reported as passing. Its app build, local development entrypoint, extension zip parity/bridge, server syntax and active-test inventory stages passed. The remaining run was environmentally blocked by missing `QH_SOURCE_EXTENSION_DIR`, missing desktop `cheerio`, two unrelated browser fixtures, and a browser-fixture hang; it was boundedly stopped. No unrelated dependency or browser fixture was changed.

## Closed E2E contract

- Disposable database: `postgres:16-alpine`, loopback-only random port, tmpfs data directory, no Docker volume.
- Every sorted migration was applied through `060_auto_listing_rfbs_upload_attempt_authorization.sql`; the latest `060_` prefix and durable `RESERVED` authorization were asserted.
- The fake Ozon call log is append-only. The exact complete success sequence is:
  1. `/v2/warehouse/list` during creation
  2. `/v2/warehouse/list` during upload
  3. `/v3/product/import`
  4. `/v1/product/import/info`
  5. `/v2/products/stocks`
- The creation one-read slice, upload four-step slice and complete five-call sequence are asserted separately.
- Missing, disabled, type-changed, expired and cross-account creation paths stop before graph/product/stock writes. A database CAS type change stops before submission-link creation. Ambiguous product and stock-failure replays do not repeat product import.
- Creation and upload RFBS evidence are distinct and immutably bound to their job/link; the upload evidence is also bound to the `RESERVED` attempt.

## Safety and unverified scope

No real Ozon, paid AI, production credential service, existing/production PostgreSQL, object store, product creation or stock mutation was called. AI/generated outputs, generated assets and publication URLs were deterministic test fixtures; all apparent Ozon writes targeted the loopback fake server.

Real Ozon response compatibility, paid AI output, production deployment and disaster-recovery exercises remain unverified and require separate authorization. A future Ozon warehouse response-shape change remains the primary compatibility risk; the verifier fails closed before downstream writes.

## Rollback and recovery

- Revert implementation: `git revert c535cf7ff260cfcab77b9d1eeaf72b0fba2164d0`.
- Task 6 adds no migration and needs no data repair.
- Migration 060 must remain because it belongs to Task 5's RFBS upload authorization contract.
- On rollback, the UI returns to FBS-only choices and the E2E/alias assertions are removed; existing persisted RFBS evidence remains append-only and harmless.

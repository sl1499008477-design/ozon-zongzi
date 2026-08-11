# RFBS first-listing verification — 2026-08-11

## Scope and tested revision

- Original Task 6 implementation: `c535cf7ff260cfcab77b9d1eeaf72b0fba2164d0`
- Original Task 6 verification record: `1d22ac00d126989114ea5e583fbdaa4996f48350`
- Independently reviewed fix-wave implementation: `25a09466f9b18e494ca3afd77b5e19858519c4b0`.
- UI scope: closed FBS/verified-RFBS/pending-RFBS warehouse choices, creation-time read-only safety copy, and stable RFBS error actions.
- Backend scope: an immutable RFBS upload-to-submission handoff plus a fresh, append-only authorization immediately before each standard-worker Ozon write phase.
- E2E scope: actual create service, actual upload service and standard listing worker with disposable PostgreSQL and a loopback fake Ozon transport.

## Fix-wave safety contract

- Forward-only migration `061_auto_listing_rfbs_submission_handoff.sql` adds one immutable RFBS handoff and append-only `PRE_IMPORT` / `PRE_STOCK` authorization evidence. Migrations 001–060 were not edited; Task 5's actual filename is `060_auto_listing_rfbs_upload_attempt_reservations.sql`.
- The handoff binds account, standard job and snapshot, store, local and platform warehouse identities, RFBS type, immutable link-identity evidence, the current attempt-authorization evidence, exact `RESERVED` attempt, submission link and business idempotency key. Composite foreign keys and database insert guards reject forged or cross-tenant chains.
- Each write phase performs a new read-only `/v2/warehouse/list` check. One database statement then verifies current active/not-archived RFBS state, the exact tenant/target/handoff/link/attempt/idempotency chain, and database-time evidence freshness before recording authorization.
- A pre-import failure writes no product and is safely retried with a new verification. A post-import failure writes no stock and preserves stock-only recovery/`PARTIAL_SUCCESS`; the accepted product is never re-imported.
- FBS and legacy jobs have no handoff row, load an all-null handoff projection, and retain the existing worker behavior.
- Migration 061 backfills exact bound pre-existing RFBS jobs and aborts deployment when an old job has unresolved RFBS lineage or cannot be proven exact FBS. A deferred commit guard rejects rolling old-writer RFBS jobs without a handoff, including a concurrent RFBS-to-FBS drift window; unrelated FBS stocks on another platform remain unaffected.
- Exact terminal upload replay is checked before mutable item state/version gates. A changed immutable terminal binding still returns conflict.

## Verification evidence

- Fix-wave focused non-PostgreSQL run: 70/70 passed, 0 failed, 0 skipped.
- Fix-wave serial disposable-PostgreSQL run: RFBS E2E 1/1; listing pipeline 1/1; upload repository 2/2; upload task/partial replay 2/2. All passed with 0 skips.
- Runtime-specific RED/GREEN: missing runtime failed 1/1 first; the completed runtime passed 4/4 for FBS/legacy bypass, exact RFBS phase binding, rolling historical recovery and non-sensitive failure mapping.
- Asynchronous E2E RED/GREEN: the first assertion observed only the creation/upload warehouse reads; the completed worker path records both additional phase reads and passes the full chain.
- Queued status/type drift and PRE_IMPORT response loss stop before product writes and recover only through fresh verification. Post-import type drift stops stock; expired upload evidence is replaced by fresh PRE_STOCK authorization and stock succeeds without repeating product import.
- Direct handoff mutation and deletion are rejected; a forged second-tenant handoff is rejected with zero attacker handoff and zero victim external writes.
- Real-PostgreSQL migration/rolling tests cover pre-061 bound backfill, unresolved and response-loss lineage aborts, a concurrent RFBS-to-FBS old-writer commit rejection with zero job/outbox, fresh SAFE_RETRY attempt authorization, forged attempt/evidence rejection, and a side-by-side different-platform FBS success.
- Production app build passed with 4,843 modules transformed; only the existing chunk-size warning remained. Changed server syntax checks and `git diff --check` passed.
- Independent final read-only review: Critical 0 / Important 0 / Minor 0; Ready. A final adjacent-fixture review reached the same result after replacing a time-based legacy bypass with an explicit active FBS warehouse.

The original Task 6 verification also passed the earlier 131/131 focused run, 250/250 non-PostgreSQL adjacent run, 11/11 serial PostgreSQL adjacent run, dedicated reconciliation 1/1 run, and Task 5 43/43 serial regression. The earlier combined parallel PostgreSQL run remains excluded: it exhausted fixture lock resources and contended on a shared schema, while the unchanged suites passed serially without raising PostgreSQL settings.

Repository-level `pnpm verify` is not reported as passing. The original bounded run passed build, local entrypoint, extension parity/bridge, syntax and inventory stages, then met unrelated environment/browser blockers (`QH_SOURCE_EXTENSION_DIR`, desktop `cheerio`, browser fixtures). No unrelated dependency or browser fixture was changed.

## Closed E2E contract

- Disposable database: `postgres:16-alpine`, loopback-only random port, tmpfs data directory, no Docker volume. Every sorted migration is applied through `061_auto_listing_rfbs_submission_handoff.sql`.
- The fake Ozon call log is append-only. The exact complete success sequence is:
  1. `/v2/warehouse/list` during creation
  2. `/v2/warehouse/list` during upload
  3. `/v2/warehouse/list` at `PRE_IMPORT`
  4. `/v3/product/import`
  5. `/v1/product/import/info`
  6. `/v2/warehouse/list` at `PRE_STOCK`
  7. `/v2/products/stocks`
- The creation, upload and worker-phase slices, as well as the complete seven-call sequence, are asserted without resetting or splicing the log.
- Success proves distinct creation/upload/phase evidence, one matching `RESERVED` attempt, one immutable handoff, exact phase authorizations, one product import and one stock update.

## Safety and unverified scope

No real Ozon, paid AI, production credential service, existing/production PostgreSQL, object store, product creation or stock mutation was called. AI/generated outputs, generated assets and publication URLs were deterministic fixtures; all apparent Ozon writes targeted the loopback fake server.

Real Ozon response compatibility, paid AI output, production deployment and disaster-recovery exercises remain unverified and require separate authorization. A future Ozon warehouse response-shape change remains the primary compatibility risk; the verifier fails closed before downstream writes.

## Rollback and recovery

- Migration 061 is forward-only and must not be removed or edited after deployment. Existing handoffs and phase authorizations remain append-only audit evidence.
- Source rollback must first disable RFBS upload and the standard listing worker, then revert the fix-wave commit, or preferably deploy a corrective roll-forward. Reverting only worker gates would reopen the asynchronous authorization gap.
- FBS and legacy rows remain compatible because migration 061 adds no required column to their existing tables and creates no handoff for them.

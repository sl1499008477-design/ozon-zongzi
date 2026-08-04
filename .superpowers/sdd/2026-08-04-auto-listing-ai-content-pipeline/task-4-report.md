# Task 4 report — generated-image attempt integrity, review repair round 3

## Review-repair result

Implemented the second independent-review repair and handed the result back for independent review. This report records implementation and verification evidence; it does not declare the parent Task 4 complete.

Generated-image acceptance now has one pure, closed checker evaluator shared by live checking and accepted/reuse replay. Every detected-text segment is independently classified, numeric claims bind every numeric occurrence to the same fact and unit, nonnumeric copy must be auditable to its fact, and only Russian text plus fact-proven brand/model tokens or the closed technical-token allowlist is accepted. Empty text is controlled by the explicit slot `textRequired` contract. The complete raw checker decision and every field required to reproduce it are persisted and re-evaluated before acceptance.

Generation uses a real two-stage identity. A preliminary `attemptIdentityHash` covers the full account/job/item/plan/group/slot boundary, immutable selected-source evidence, plan/profile/model/template settings, exact validated size, canonical quality, and regeneration request. It is reserved before source download. Only the lease owner loads bytes, then binds a final `inputHash` that includes actual content hashes. Same-preliminary accepted work and occupied work make zero loader calls; final bind conflict terminalizes the current lease before any gateway or storage side effect. Accepted reuse binds persisted source IDs in slot order, additionally binds `CONTENT_HASH` references to the selected expected hash, rebuilds the final input, replays checker evidence, and reads back the exact stored object.

All identifiers are exact, trimmed, control-free strings of at most 240 characters before any side effect. Image size is an exact `WIDTHxHEIGHT` value with both dimensions inside the normalization resolution bounds and a ratio tolerance of 0.02. Quality is canonicalized once to lowercase and the same value reaches attempt identity, final input, gateway, and reuse. Maximum-attempt failure/rejection is persisted non-retryable before item finalization.

Storage ports are mandatory. Stored-row and cleanup-obligation writes must return exact, account-scoped durable records; null, partial, cross-scope, wrong-object/hash/reason, or non-pending cleanup replies fail closed. If object removal fails, cleanup persistence is awaited. Successful cleanup persistence preserves the original stable business error; failed or unverifiable cleanup persistence throws retryable `AUTO_LISTING_ASSET_CLEANUP_PERSIST_FAILED`. Logger failure remains isolated.

Migration 029 remains additive and keeps `input_hash NOT NULL`. It adds `attempt_identity_hash`, `generation_size`, and `final_input_bound_at`; a pre-bind row stores the preliminary identity in `input_hash`, and the bind CAS replaces it with the final input. Explicit non-null checks prevent PostgreSQL three-valued logic from admitting incomplete accepted/rejected/failed rows. Full-scope uniqueness covers attempt number, active preliminary identity, and bound final input; the final-input index includes historical accepted rows that predate `final_input_bound_at`. A whitespace-only lease token is invalid.

The same migration adds an independent durable cleanup-obligation table with account/job/item/plan/group/slot, attempt identity/input/number, object/content hashes, reason/original error, status, retry timing/count, and timestamps. `(account_id, object_key)` is the idempotency key; an adapter exact-compares all other immutable fields after conflict. All reads include account scope. The table depends on job/item/plan scope, never on an `ai_generation_assets` row whose insert may have failed.

## Changed contracts and files

- Closed checker and replay evaluator: `server/auto-listing-result-checker.mjs`.
- Two-stage orchestration, exact input contracts, accepted/reuse verification: `server/auto-listing-image-generator.mjs`.
- In-memory attempt identity/bind CAS reference adapter: `server/auto-listing-generation-attempt-repository.mjs`.
- Mandatory storage and durable-cleanup return contract: `server/auto-listing-asset-store.mjs`.
- New high-cohesion memory/PostgreSQL cleanup repository: `server/auto-listing-asset-cleanup-repository.mjs`.
- Additive attempt-binding and cleanup persistence schema: `server/db/migrations/029_auto_listing_ai_generation_evidence.sql`.
- Focused and PostgreSQL-gated behavior coverage: the corresponding `server/tests/auto-listing-*.test.mjs` files.

## TDD evidence for round 2

- Checker contract progressed from 8/11 to 10/11 to 11/12 and then full GREEN; the final checker/generator focused set was closed through the shared pure evaluator and corruption matrices.
- Preliminary reserve/final bind repository began RED 0/3 and reached GREEN 3/3. Generator two-stage behavior began 13/23 with 10 expected failures and reached 23/23; zero-loader accepted reuse separately went RED 0/1 to GREEN 1/1.
- Four narrow orchestration findings went RED 0/5 and GREEN 5/5: selected-reference binding, preflight bind port, canonical quality, and persisted maximum-attempt retryability. Generator plus attempt repository then passed 30/30.
- Different preliminary source identities resolving to the same final bytes reproduced a false version conflict at RED 0/1 and reached GREEN 1/1; bind-time reuse validates the accepted row's hashed preliminary identity while direct same-preliminary reuse still requires the current identity.
- Migration static contract began RED 0/1, reached GREEN, returned RED for explicit non-null and historical-accepted final-conflict coverage, then returned GREEN 1/1.
- Cleanup behavior began 5/6 with the swallowed persistence failure, then passed 7/7. The cleanup repository began with the missing module RED and reached 2/2. Exact persistence-return verification went RED 0/1 to GREEN 1/1.
- Final focused checker/generator/attempt/storage/cleanup/migration/PG-gate run: 54 passed, 0 failed, 1 dedicated-PostgreSQL skip.

## Verification

- Focused command set: 54 passed, 0 failed, 1 dedicated-PostgreSQL skip.
- Auto-listing, AI adapter, and object-storage set: 238 passed, 0 failed, 1 dedicated-PostgreSQL skip.
- Historical permissions, persistence, formal-store, listing, and account-store set: 44 passed, 0 failed.
- All `*migration*.test.mjs` contracts: 21 passed, 0 failed, 2 dedicated-database skips.
- Whole server command `node --test server/tests/*.test.mjs`: 913 passed, 0 failed, 5 configured PostgreSQL skips. This filename pattern intentionally excludes older `.integration.mjs` executables; no old test was changed to manufacture this result.
- Raw command `node --test server/tests/*.mjs`: 925 passed, 1 failed, 6 skipped. The sole failure is the pre-existing `account-scoped-collection-migration.integration.mjs`, which intentionally throws when `SONLI_MIGRATION_TEST_DATABASE_URL` is absent.
- Production app build passed for 4,833 transformed modules; the existing >500 kB chunk warning remains.
- Changed-module syntax, `git diff --check`, and final diff/status inspection passed.

## Unverified scope, risk, and rollback

No real AI gateway, object storage, source download, Ozon operation, production database, or production data was used. Live PostgreSQL compilation and malicious-insert behavior remain unverified because `SONLI_MIGRATION_TEST_DATABASE_URL` is absent. The fixture requires both that dedicated URL and `AUTO_LISTING_POSTGRES_TESTS=1`, never falls back to ordinary database configuration, and now covers: migration-from-028 historical accepted conflict, whitespace lease, explicit null binding evidence, cleanup idempotency/conflict, wrong-account reads, and cross-job/item/plan rejection.

Primary regression risk is integration with the future transactional generation-attempt adapter: it must implement the complete mandatory port set and exact return contracts. The feature remains disabled/unwired. Application rollback is reverting this repair commit. If migration 029 has been applied, use a reviewed compensating migration rather than source reversion alone; do not destructively edit production schema by hand.

## Review repair round 3 — immutable sources, upgrade compatibility, and cleanup execution

This round closes I1-I5 and M1 and records evidence for independent review; it does not self-declare Task 4 complete.

Task 4 now accepts only already-materialized `CONTENT_HASH` source references. A pure `SOURCE_URL` returns stable non-retryable `AUTO_LISTING_SOURCE_ASSET_NOT_MATERIALIZED` before reservation, loader, gateway, or storage, and URL text is never hashed as if it were content. URL evidence remains valid in Task 3 grouping/planning. A future idempotent materialization worker must safely download, decode, persist, and hash the bytes, then create a new visual-group and ContentPlan version before Task 4; it must never mutate an existing immutable plan.

The exact validated `generationSize` is now passed into reservation, persisted when the attempt row is created, echoed by the reservation reply, and carried through bind/store/complete/reject/fail ownership checks. Missing, changed, or non-echoed size fails closed before source loading. Attempt identity already hashes the size, while the explicit row field remains independently auditable.

The checker distinguishes an optional empty OCR result from detected text. `textRequired=false` plus no detected text accepts explicit `russianText=false`/`language=other`; any detected text still enters the language gate. Empty lexical segments, punctuation-only text, and emoji-only text reject. A required-text slot must include at least one `[А-Яа-яЁё0-9]+` token containing a Cyrillic letter; pure brand/model/technical exceptions cannot impersonate Russian body copy, while Russian text plus fact-proven exceptions remains valid.

Migration 029 now upgrades a real <=028 shape with multiple formerly legal duplicate `GENERATING` rows. Before new active indexes, every incompatible legacy row is preserved but terminalized as retryable `FAILED` with `MIGRATION_029_LEGACY_GENERATING_TERMINATED` and cleared lease fields. Its new attempt identity remains null, so it occupies no active key and consumes no attempt for a new identity; the fixture then inserts a new attempt-1 row. No legacy row is deleted.

Cleanup obligations now have a complete durable lifecycle. Memory and PostgreSQL adapters support account-scoped ordered/limited claim, opaque nonce-plus-attempt lease fence, expiry reclaim, exact owner/token/expiry CAS completion/failure, closed stable failure codes, and deterministic five-minute exponential backoff capped at 24 hours. PostgreSQL uses `NOW()` as clock authority and one `FOR UPDATE SKIP LOCKED` statement. The new single-purpose cleanup worker accepts only `{accountId, workerId, limit, leaseMs}`, rebuilds and exact-matches the account-scoped object key before deletion, calls only `storage.removeObject(objectKey, {accountId})`, isolates each remove/complete/fail/log error, and reports `{claimed, completed, failed}` with `claimed = completed + failed`.

### Round 3 changed contracts and files

- Immutable source, reservation echo, and size ownership: `server/auto-listing-image-generator.mjs` and `server/auto-listing-generation-attempt-repository.mjs`.
- Optional-empty and required-Cyrillic checker policy: `server/auto-listing-result-checker.mjs`.
- Cleanup claim/CAS/backoff ports and worker: `server/auto-listing-asset-cleanup-repository.mjs` and `server/auto-listing-asset-cleanup-worker.mjs`.
- Upgrade-safe attempt indexes and cleanup lease schema: `server/db/migrations/029_auto_listing_ai_generation_evidence.sql`.
- Task 3/4 contract clarification: the canonical pipeline plan plus Task 3 brief/report.
- RED/GREEN and gated PostgreSQL behavior: the corresponding `server/tests/auto-listing-*.test.mjs` files.

### Round 3 TDD evidence

- Before production edits, grouped RED was 43 passed, 10 failed, and 1 PostgreSQL skip: URL materialization, reservation/row size, optional empty text, punctuation/exception-only text, legacy duplicate upgrade, and cleanup lifecycle were the expected failures.
- A reached 35/35, then a reservation-reply echo supplement reproduced 30 passed/1 failed and reached 36/36 after strict size echo validation.
- B reached 13/13, including Cyrillic alphanumeric acceptance and punctuation/emoji/exception-only rejection.
- C static migration behavior reached 1 passed/0 failed with 1 dedicated-PostgreSQL skip.
- D reached 10/10 after claim/CAS/backoff, worker batch isolation, forged object-key zero-delete, rejected-promise logger isolation, closed error codes, and bounded nonce coverage.

### Round 3 verification

- Combined round-3 focused set: 60 passed, 0 failed, 1 dedicated-PostgreSQL skip.
- Auto-listing, AI profile/adapter, and object-storage regression: 261 passed, 0 failed, 1 dedicated-PostgreSQL skip.
- All `*migration*.test.mjs` contracts: 21 passed, 0 failed, 2 dedicated-database skips.
- Historical permissions, persistence, formal-store, account-store, category/listing, and warehouse set: 44 passed, 0 failed.
- Whole `node --test server/tests/*.test.mjs`: 927 passed, 0 failed, 5 configured PostgreSQL skips.
- Raw `node --test server/tests/*.mjs`: 939 passed, 1 failed, 6 skipped. The sole failure remains the old `account-scoped-collection-migration.integration.mjs`, which intentionally requires `SONLI_MIGRATION_TEST_DATABASE_URL`; it is an environment gate, not reported as product success.
- Production Vite build passed for 4,833 transformed modules; the existing >500 kB chunk warning remains.
- Changed-module syntax, `git diff --check`, and final diff/status inspection passed.

### Round 3 unverified scope, risk, and rollback

No real gateway, source materialization/download, object storage, Ozon call, production database, or production data was used. The new PostgreSQL fixture contains the full <=028 duplicate upgrade and cleanup claim/fail/reclaim/stale/current CAS sequence, but it did not execute because both `AUTO_LISTING_POSTGRES_TESTS=1` and a dedicated `SONLI_MIGRATION_TEST_DATABASE_URL` were not configured. PostgreSQL SQL compilation, trigger interaction, and concurrent claim behavior therefore remain explicitly unverified.

The feature remains disabled and unwired. Primary regression risks are the future materialization worker producing a new immutable visual-group/plan version, and the future durable generation-attempt adapter honoring every exact size/lease return contract. Application rollback is reverting this scoped commit while keeping the feature off. If migration 029 was applied, preserve the newly audited legacy `FAILED` rows and cleanup obligations and use a reviewed compensating migration; never hand-delete rows or destructively edit production schema.

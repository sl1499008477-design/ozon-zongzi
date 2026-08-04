# Task 4 report — generated-image acceptance boundaries

## Review-repair result

Implemented the requested review repairs and handed the change to the independent reviewer; this report does not declare the parent Task 4 complete.

The image generation flow now closes scope and evidence before any loader, reservation, gateway, checker, storage, or terminal side effect. It loads only the slot's ordered unique 1–7 references, bounds source/generated/normalized bytes, scopes idempotency by the reserved attempt, and finalizes failures through the exact lease. MAIN failure and the six-image floor block only at bounded exhaustion. Accepted completion and reuse require the full immutable evidence matrix plus bounded object readback.

The checker uses a closed response/evidence schema. Identity evidence, Russian-language evidence, quality flags, prohibited-claim flags, and fact-bound claims override contradictory top-level success. Unknown fields, flags, references, or claim shapes fail closed as checker unavailability.

Storage now verifies both new puts and reuse by reading the stored object with a 16 MiB bound and comparing bytes, hash, size, type, and dimensions. Repository recording failure awaits object cleanup; failed cleanup records a durable cleanup obligation. Synchronous or asynchronous logger failure cannot change the business outcome.

Migration 029 additively records the five frozen hashes, prompt template, source evidence, request/model evidence, regeneration, size, and exact lease pair. New accepted rows require complete evidence. Source evidence is an exact 1–7 element array with unique nonempty asset IDs, closed keys, valid hashes/types/dimensions/sizes, and an explicit string content type; JSON null cannot pass through PostgreSQL three-valued logic. Active generation uniqueness covers the full account/job/item/plan/group/slot/input scope.

## Changed contracts and files

- Generation orchestration and accepted/reuse contract: `server/auto-listing-image-generator.mjs`.
- Closed checker contract: `server/auto-listing-result-checker.mjs`.
- Storage/readback/cleanup contract: `server/auto-listing-asset-store.mjs` and `server/object-storage.mjs`.
- Additive persistence contract: `server/db/migrations/029_auto_listing_ai_generation_evidence.sql`.
- Focused coverage: `server/tests/auto-listing-image-generator.test.mjs`, `server/tests/auto-listing-result-checker.test.mjs`, `server/tests/auto-listing-asset-store.test.mjs`, `server/tests/object-storage.test.mjs`, and both migration tests.

## TDD evidence

- Checker boundary: RED 1 pass/6 fail, then GREEN 7/7; later prohibited/language preflight additions RED 23/26, then GREEN 26/26.
- Generator boundary: RED 5 pass/13 fail, then staged GREEN through 13/18, 15/18, 16/18, and 18/18. Plan/profile binding and retry policy separately went RED 15/18 to GREEN 18/18.
- Storage boundary: RED 1 pass/5 fail, then GREEN 6/6. Bounded object read initially failed because the export did not exist, then passed 2/2.
- Migration boundary: initial static RED 0/1, then GREEN; explicit accepted-column null checks also went RED then GREEN. The final source-evidence repair went RED 0/1, then GREEN 1/1 for JSON-null, 1–7 length, and unique asset IDs; the PostgreSQL malicious cases are present but gated.
- Malformed reservation attempt number: RED 0/1, then GREEN 1/1 and fail-closed before gateway, storage, or terminal mutation.

## Verification

- Final focused generation/checker/storage/gateway/migration set: 73 passed, 0 failed, 1 dedicated-PostgreSQL skip.
- Auto-listing/AI regression set: 238 passed, 0 failed, 1 dedicated-PostgreSQL skip.
- Migration safe set: 21 passed, 0 failed, 2 dedicated-database skips.
- Top-level server test entry set excluding the one environment-only migration integration: exit 0.
- Raw `server/tests/*.mjs` scan: 906 passed, 1 failed, 6 skipped. The sole failure is the existing `account-scoped-collection-migration.integration.mjs`, which intentionally throws without `SONLI_MIGRATION_TEST_DATABASE_URL`.
- Historical permissions/persistence/formal/listing/account-store regression: 31 passed.
- App production build passed; the existing large-chunk warning remains.
- Changed-module syntax and whitespace/diff checks passed.

## Unverified scope, risk, and rollback

No real AI gateway, object storage, source download, Ozon operation, production database, or production data was used. Live PostgreSQL compilation and malicious-insert enforcement remain unverified because `SONLI_MIGRATION_TEST_DATABASE_URL` is absent; the fixture never falls back to `DATABASE_URL` and requires `AUTO_LISTING_POSTGRES_TESTS=1` as a second gate.

Primary regression risk is compatibility between the stricter accepted-row contract and the future transactional repository implementation. The feature remains disabled/unwired. Application rollback is reverting the review-repair commit. If migration 029 has already been applied, schema rollback requires a reviewed compensating migration to remove its constraints/index/function/columns; do not rely on source reversion alone. Because the migration is additive and its new accepted checks are `NOT VALID`, existing historical rows are preserved while new rows are enforced.

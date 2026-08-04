# Task 4 report — generate, store, and verify listing images

## Result

Implemented an injectable, byte-only image-slot pipeline. Source URLs are resolved only by the server-side `sourceAssetLoader`; image generation and image inspection receive only verified image bytes and a closed fact projection.

## Contracts and safeguards

- `normalizeListingImage` decodes with Sharp, reads metadata and stats, rejects unsupported/multi-page input, enforces byte/pixel/dimension/ratio bounds, applies orientation, and emits deterministic PNG without source metadata.
- `storeGeneratedAsset` uses account/job/item/plan/group/slot/hash-scoped keys, verifies every storage reply field, removes an unverified object, reuses an exact scoped object, and does not create a storage record after a put failure.
- `generateImageSlot` hashes frozen plan/source/strategy/config/visual evidence, source bytes, slot, template, profile/model, output settings, and regeneration. It verifies source asset ID/evidence/hash/type/dimensions before reserving a lease and checks every stored accepted-field before reuse.
- `createMemoryGenerationAttemptRepository` fixes the durable repository port semantics for Task 6: composite scope fencing, one active lease, expiry-to-new-attempt behavior, immutable accepted reuse, and lease-token CAS terminal transitions.
- `checkGeneratedAsset` applies the deterministic image gate before closed-schema image inspection and returns only stable policy codes.
- `summarizeGeneratedImageSlots` blocks missing MAIN output and fewer than six accepted assets without changing sibling outcomes.
- Migration 029 adds additive provenance, source-evidence, and lease columns/constraints/indexes. It is not exercised against PostgreSQL because the dedicated migration DB gate is not configured.

## Verification

- Final focused Task 4 plus gateway/migration suite: 56 passed, 0 failed, 0 skipped.
- The focused result includes the adapter and migration regression coverage; full PostgreSQL behavior remains explicitly gated.
- `server/tests/auto-listing-ai-migration-postgres.test.mjs`: 0 passed, 1 skipped because both `AUTO_LISTING_POSTGRES_TESTS=1` and `SONLI_MIGRATION_TEST_DATABASE_URL` are required.
- App production build passed.
- Whole `server/tests/*.mjs` scan: 887 passed, 1 failed, 6 skipped. The failure is pre-existing environment gating in `account-scoped-collection-migration.integration.mjs`, which throws when `SONLI_MIGRATION_TEST_DATABASE_URL` is absent; it is unrelated to Task 4.

## Remaining integration boundary and rollback

Task 6 must provide the transactional PostgreSQL implementation of the attempt repository and the source downloader, using the established ports; no network, storage, Ozon, or UI wiring was added here. Rollback is the single Task 4 commit; migration 029 is additive and its new nullable columns are unused by older records.

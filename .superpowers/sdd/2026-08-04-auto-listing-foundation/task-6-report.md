# Supplemental Task 6 Report — Trusted Product Dimensions and Frozen Config

## Scope

- `server/auto-listing-contract.mjs`
- `server/auto-listing-item-image-config.mjs`
- `server/auto-listing-service.mjs`
- `server/auto-listing-repository.mjs`
- `server/auto-listing-routes.mjs`
- focused contract, service/repository, and route tests
- `docs/superpowers/plans/2026-08-04-auto-listing-foundation.md`

No migration, state-machine, warehouse SQL, UI, extension, AI, or Ozon implementation changed.

## TDD evidence

- RED 1: the new contract test imported the desired per-item effective-image helper and failed because that export did not exist.
- GREEN 1: contract coverage passed after adding the pure helper. It proves a frozen requested specification count is source-independent; only verified product measurements (`reliable: true`, non-empty unit/source, and a positive finite numeric measurement) retain the slot. Package/logistics dimensions never qualify.
- RED 2: the focused contract/service/route command had 49 tests with 3 expected failures: the route forwarded a forged reliability claim, the service omitted per-item effective image configuration, and repository validation called `connect()` before rejecting malformed frozen config.
- GREEN 2: the same focused command passed 49/49 after the minimal route, service, and repository changes.
- RED 3: the review hardening test required a verified source capture, and failed while the new aggregate helper module was absent.
- GREEN 3: the helper first verifies both the frozen config and the full source capture, then reads the canonical snapshot; focused coverage again passed 49/49.

## Contract and safety evidence

- Browser configuration cannot submit `hasReliableProductDimensions`; both contract and route reject it.
- Job configuration freezes the requested roles only. `deriveEffectiveAutoListingImageConfig` first verifies a complete source capture, then derives the per-item result only from its canonical `snapshot.productMeasurements`, carries `PRODUCT_DIMENSIONS_UNAVAILABLE` on downgrade, and never reads logistics.
- Service and repository share `verifyAutoListingFrozenConfig`. It canonicalizes the exact frozen configuration and computes/verifies its SHA-256 hash.
- Repository verifies the complete canonical configuration, total, roles, stock, signed money adjustment, unknown/sensitive fields, hash, snapshots, and per-item effective config before acquiring a PostgreSQL client.
- Existing same-account idempotent replay remains before current store, warehouse, source, and strategy checks.

## Verification

- Focused contract/service/repository/route: **49 passed, 0 failed**.
- Foundation suite: **91 passed, 0 failed**.
- Historical permissions/persistence/listing/store regression: **41 passed, 0 failed**.
- Gated PostgreSQL suite: **1 passed, 1 skipped**. The dedicated database fixture correctly skipped because `SONLI_MIGRATION_TEST_DATABASE_URL` is not configured; no production database fallback was used.
- Syntax checks passed for the four changed server modules; `git diff --check` passed.

## Unverified range and rollback

- Live PostgreSQL transaction behavior is not dynamically verified without a dedicated migration-test URL. The always-on repository test proves malformed frozen input is rejected before `connect()`.
- Keep `AUTO_LISTING_ENABLED=0` to prevent new work while retaining immutable audit history. If code rollback is needed, revert this Task 6 commit only; do not remove migration 026 or persisted job/snapshot/event records.

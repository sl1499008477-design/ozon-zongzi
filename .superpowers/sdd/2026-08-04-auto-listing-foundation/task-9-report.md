# Supplemental Task 9 Report — Isolated Invalid Source Items

## Scope

- `server/auto-listing-source-snapshot.mjs`
- `server/auto-listing-service.mjs`
- `server/auto-listing-repository.mjs`
- focused source, service, repository, route, and gated PostgreSQL tests
- foundation plan wording and this delivery ledger

No migration, state-machine, frozen configuration, warehouse locking, UI, extension, AI, or Ozon integration changed.

## TDD evidence

- RED: the first focused command reported **19 passed, 4 failed**. The absent blocked-evidence exports failed module linkage, a mixed valid/category-missing batch still threw `AUTO_LISTING_SOURCE_CATEGORY_REQUIRED`, and a source containing both a category omission and a cycle was incorrectly classified as a per-item category failure.
- GREEN: a separate canonical blocked-source evidence builder/verifier, per-item closed-code catch, and repository graph boundary produced **76 passed, 0 failed, 1 dedicated-DB skip** before the last source-evidence negative cases. The final focused suite is recorded below.
- Integrity RED/GREEN: a dangerous `productDraft` combined with a missing category was initially downgraded to `BLOCKED`; the service regression failed. The snapshot preflight now validates both collect and draft evidence before category/SKU/currency classification, and the focused source/service regression passed.

## Contract and safety evidence

- Only `AUTO_LISTING_SOURCE_CATEGORY_REQUIRED`, `AUTO_LISTING_SOURCE_SKU_REQUIRED`, and `AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB` are isolated. The service does not classify by prefix.
- `AUTO_LISTING_BLOCKED_SOURCE_EVIDENCE` version 1 is a canonical hash-verified record containing only account/source identity, safely available draft and collection metadata, raw reference/hash, and one closed source failure code. It contains no SKU, category, inferred currency, raw payload body, credentials, strategy, price, or image configuration.
- Successful snapshots and blocked evidence have distinct builders and verifiers. `verifyAutoListingSourceSnapshot` continues to reject blocked evidence, preventing later content work from treating a blocked item as source-ready.
- Full source integrity is checked before source-business classification. Scope/provenance failures, invalid IDs/versions/raw scalars, cycles, dangerous keys, non-finite JSON, and unsupported containers therefore reject the whole request and create no graph.
- Repository validation occurs before `pool.connect()`. `SOURCE_READY` always needs a complete verified snapshot, canonical effective image config, strategy, and price. Existing full-snapshot blocked price/category-store items remain accepted with their effective image configuration. A source-business `BLOCKED` item must carry exactly matching blocked evidence and no complete snapshot, strategy, price, or effective image configuration.
- The existing source-snapshot JSONB column stores the typed blocked evidence and its immutable hash for blocked-source items; no migration is needed. Events and read DTOs retain only source tuple/hash and safe failure code, never raw evidence bodies.

## Verification

- Focused source/service/repository/route plus gated test: **76 passed, 0 failed, 1 skipped**. The skip is the dedicated database fixture and is expected because `SONLI_MIGRATION_TEST_DATABASE_URL` is unset.
- Full always-on foundation command: **138 passed, 0 failed**.
- Historical permissions/persistence/listing/store regression: **41 passed, 0 failed**.
- `AUTO_LISTING_POSTGRES_TESTS=1` gate: **3 passed, 0 failed, 1 skipped**. The PostgreSQL graph fixture is gated by both the explicit flag and `SONLI_MIGRATION_TEST_DATABASE_URL`; it did not connect to another database or fall back to production.
- Changed production modules passed syntax checks; `git diff --check` passed.

## Unverified range and rollback

The real PostgreSQL mixed sibling transaction fixture is ready but was not executed because no dedicated disposable migration database URL is configured. Keep `AUTO_LISTING_ENABLED=0`; rollback is a code revert of this task commit. Do not delete immutable job, snapshot, or event history.

## Fix round 1 — Verify reused source evidence

- RED: repository coverage reported **17 passed, 1 failed**. The conflict reuse query selected only `id,snapshot_hash`; a stored blocked-kind/body/raw-reference corruption carrying the incoming hash progressed beyond the reuse boundary instead of returning `AUTO_LISTING_SOURCE_VERSION_CONFLICT`.
- GREEN: `INSERT ... RETURNING` and the conflict `SELECT ... FOR SHARE` both return `id,snapshot,snapshot_hash,raw_response_ref` and use one verifier. Complete incoming graph items use the complete snapshot verifier; source-business blocked items use the blocked-evidence verifier. The verified stored canonical body, hash, and raw reference must exactly equal the incoming canonical evidence; this also binds the stored account/source tuple and blocked failure code. Any malformed, wrong-kind, copied-hash body, or raw-reference mismatch now rolls back with `AUTO_LISTING_SOURCE_VERSION_CONFLICT` before an item/event link.
- A dedicated PostgreSQL fixture pre-seeds a row with a copied valid hash and corrupted JSON body, requires rollback/no job/no job items, and remains gated exclusively to a disposable migration URL.
- Verification: focused **77 passed, 0 failed, 1 dedicated-DB skip**; foundation **139 passed, 0 failed**; historical **41 passed, 0 failed**; gated PostgreSQL command **3 passed, 0 failed, 1 dedicated-DB skip**; syntax and `git diff --check` passed.

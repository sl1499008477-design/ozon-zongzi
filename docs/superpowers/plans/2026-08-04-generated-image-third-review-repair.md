# Generated Image Third Review Repair Implementation Plan

> **For Codex:** Execute A through D with `superpowers:test-driven-development`; verify E with `superpowers:verification-before-completion`. The approved design is `docs/superpowers/specs/2026-08-04-generated-image-third-review-repair-design.md`.

**Goal:** Close generated-image review findings I1-I5 and M1 without production wiring or live external calls.

**Architecture:** Task 4 consumes immutable content-hash references, one attempt row owns exact generation size, one pure checker policy serves live/replay paths, migration 029 preserves and terminalizes incompatible legacy activity, and a single-purpose cleanup worker drives a durable leased obligation repository.

**Constraints:** Use `apply_patch`; preserve account/job/item/plan/group/slot fences; never delete legacy audit rows; use repository/database time as lease authority; keep the feature disabled and unwired.

## Interfaces

```js
generateImageSlot(input)
reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts })
claimAssetCleanupObligations({ accountId, workerId, limit, leaseMs })
completeAssetCleanup({ accountId, id, workerId, claimToken })
failAssetCleanup({ accountId, id, workerId, claimToken, errorCode })
createAutoListingAssetCleanupWorker({ repository, storage, logger }).run({ accountId, workerId, limit, leaseMs })
```

## Task A: Immutable inputs and generation-size fence

**Files:** `server/auto-listing-image-generator.mjs`, `server/auto-listing-generation-attempt-repository.mjs`, and their focused tests.

- [x] Write RED tests: pure `SOURCE_URL` returns `AUTO_LISTING_SOURCE_ASSET_NOT_MATERIALIZED` before all side effects; reserve input and reply echo exact `generationSize`; bind/store/complete/reject/fail reject missing or changed size.
- [x] Run RED:

```bash
node --test server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-generation-attempt-repository.test.mjs
```

Expected: only the new URL/size assertions fail.

- [x] Implement immutable-only preflight and row/owner size fences. Success fixtures use truthful evidence:

```js
{ assetId, evidenceKind: "CONTENT_HASH", contentHash: sha256(bytes), sourceRef: null }
```

- [x] Rerun the same command GREEN.

## Task B: Checker empty-text and lexical policy

**Files:** `server/auto-listing-result-checker.mjs`, `server/tests/auto-listing-result-checker.test.mjs`.

- [x] Write RED tests: optional empty OCR accepts explicit no-text flags; required punctuation/emoji and pure exception tokens reject; Cyrillic alphanumeric and Russian body plus proven exceptions accept.
- [x] Run RED/GREEN:

```bash
node --test server/tests/auto-listing-result-checker.test.mjs
```

- [x] Implement separate `hasDetectedText`, lexical validity, and required Cyrillic-body checks. A satisfying Russian token matches `[А-Яа-яЁё0-9]+` and contains at least one Cyrillic letter.

## Task C: Upgrade-safe migration 029

**Files:** `server/db/migrations/029_auto_listing_ai_generation_evidence.sql`, migration static and PostgreSQL-gated tests.

- [x] Write a <=028 fixture with three legal duplicate legacy `GENERATING` rows, then apply 029 and require all rows preserved as audited `FAILED` plus a new attempt-1 row.
- [x] Write static assertions for deterministic termination, null-identity exclusion from active indexes, lease columns, and no deletion.
- [x] Run:

```bash
node --test server/tests/auto-listing-ai-generation-evidence-migration.test.mjs server/tests/auto-listing-ai-migration-postgres.test.mjs
```

Expected without a dedicated database: static GREEN and one explicit PostgreSQL skip.

- [x] Before unique indexes, terminalize incompatible rows with `MIGRATION_029_LEGACY_GENERATING_TERMINATED`; retain null attempt identity so history does not consume new attempt counts.

## Task D: Durable cleanup lifecycle

**Files:** cleanup repository, new cleanup worker, migration 029, and their focused tests.

- [x] Write RED memory tests for exclusive claim, account isolation, expired reclaim, exact CAS, closed error code, attempt count, and 5-minute exponential backoff capped at 24 hours.
- [x] Write RED worker tests for rebuilt object-key/account verification, exact `removeObject(objectKey, { accountId })`, async logger isolation, per-item error isolation, and `{ claimed, completed, failed }` accounting.
- [x] Add the gated PostgreSQL claim/fail/reclaim/stale-token/current-token contract fixture.
- [x] Run RED/GREEN:

```bash
node --test server/tests/auto-listing-asset-cleanup-repository.test.mjs server/tests/auto-listing-asset-cleanup-worker.test.mjs
```

- [x] Implement `PENDING -> PROCESSING -> COMPLETED` and `PROCESSING -> PENDING`, opaque nonce-plus-attempt fences, database-owned PostgreSQL time, `FOR UPDATE SKIP LOCKED`, exact CAS, and the single-purpose removal worker.

## Task E: Regression, documentation, and handoff

- [x] Run the combined A-D focused suite.
- [x] Run auto-listing/AI/adapter/object-storage and all migration contracts.
- [x] Run the historical permissions/persistence/listing/store set.
- [x] Run `node --test server/tests/*.test.mjs` and raw `node --test server/tests/*.mjs`; record environment-gated skips/failure exactly.
- [x] Run changed-module syntax, production build, `git diff --check`, and final status/diff inspection.
- [x] Update Task 3/4 contracts, Task 4 report, and pipeline progress ledger with verification, unverified ranges, risks, and rollback.
- [ ] Commit only the scoped repair using the coordinator-provided message; independent review follows, so do not self-declare PASS.

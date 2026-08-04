# Generated Image Third Review Repair Design

## Scope and acceptance

This repair closes I1-I5 and M1 without wiring the feature to production or calling a real gateway, object store, or database. It preserves account/job/item/plan/visual-group/slot boundaries, immutable accepted evidence, idempotent side effects, and stable error contracts.

## Immutable source boundary (I1)

Task4 accepts only source references whose evidence kind is `CONTENT_HASH` and whose expected SHA-256 is present. A pure `SOURCE_URL` is rejected with `AUTO_LISTING_SOURCE_ASSET_NOT_MATERIALIZED` before reservation, source loading, gateway, or storage. A URL hash is never treated as a content hash.

This is deliberately the KISS option instead of adding a second validation lease protocol to Task4. A later materialization worker must download and inspect the mutable URL under its own idempotent workflow, persist immutable bytes and content hash, and create a new visual-group/plan version before Task4 runs. Mutating an existing plan would break audit replay and is forbidden.

## Generation-size fence (I2)

The exact validated generation size enters `reserveGenerationAttempt` and the row at creation. Every owner operation—bind, stored-asset recording, complete, reject, fail, and lease release—must carry and match the same `generationSize`. Missing or changed size fails closed. Attempt identity already contains size; the row-level field is an explicit audit and CAS fence.

## Checker policy (I3-I4)

When `textRequired=false` and OCR detects no text, `russianText=false` and `language=other` are valid. If any text is detected, normal language/token validation still applies.

Punctuation-only and emoji-only segments are not lexical text. For `textRequired=true`, at least one detected alphanumeric token must contain a real Cyrillic letter. Pure fact-backed brand/model text or technical abbreviations cannot satisfy that Russian-body requirement. Russian body text plus fact-proven exceptions remains valid.

## Migration compatibility (I5)

Migration 029 must upgrade a real <=028 schema containing multiple legal legacy `GENERATING` rows for one scope/input. Legacy active rows cannot own the new lease and size contract, so the migration deterministically terminates every such row as `FAILED`, clears lease fields, and records `MIGRATION_029_LEGACY_GENERATING_TERMINATED` with retryable audit evidence. Rows are not deleted and their `attempt_identity_hash` remains null, so they neither occupy new active unique indexes nor consume attempts for a new identity. A new attempt can start at attempt 1.

## Cleanup obligation state machine (M1)

States are `PENDING -> PROCESSING -> COMPLETED` or `PROCESSING -> PENDING`. Claiming is account-scoped, ordered, limited, exclusive, and uses an opaque claim token, owner, and expiry. Expired processing claims are reclaimable. Completion and failure require exact account/id/owner/token CAS and reject duplicates or stale leases.

Claim increments `attemptCount`. Failure stores only a stable sanitized error code and schedules deterministic exponential backoff from five minutes, capped at 24 hours. It clears the lease and stays recoverable. The single-purpose worker claims a batch, calls only `storage.removeObject`, completes successes, records failures, isolates per-object errors, and reports `{ claimed, completed, failed }`.

## Verification and rollback

RED tests cover each finding before production changes. GREEN verification runs focused tests, the auto-listing/AI matrix, the full server unit matrix, syntax checks, build, and diff inspection. The PostgreSQL behavioral fixture remains explicitly gated by a dedicated disposable database URL. Rollback is the single repair commit; cleanup rows and legacy audit rows are preserved, so rollback does not require data reconstruction.

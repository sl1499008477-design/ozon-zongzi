# Generated Asset Attempt Isolation Design

## Scope and acceptance

This fourth review repair closes the orphan-cleanup race without runtime wiring or live services. New generated objects are physically isolated per attempt, accepted reuse remains compatible with trusted legacy keys, and cleanup performs an account-scoped reference/adoption fence before deletion. The feature remains disabled and no production data is touched.

## Root cause

The current object key contains scope, final input hash, and content hash, but omits `attemptIdentityHash` and `attemptNo`. Two attempts producing the same normalized bytes therefore share one physical key. An attempt-1 cleanup obligation can later delete the same key adopted by accepted attempt 2. The cleanup worker currently validates only key shape and then deletes unconditionally; it has no generation-reference/adoption port.

The defect reproduces deterministically: attempt 1 and attempt 2 build the same key, the simulated accepted object exists before the worker, and it is absent after the worker completes the stale obligation.

## ATTEMPT_V2 object key

`buildGeneratedAssetObjectKey` creates only `ATTEMPT_V2` keys:

```text
auto-listing/v2/{account}/{job}/{item}/{plan}/{group}/{slot}/{attemptIdentityHash}/attempt-{attemptNo}/{inputHash}/{contentHash}.png
```

The six scope segments use the existing strict base64url encoding. Both hashes must be lowercase SHA-256 values and `attemptNo` must be an integer from 1 through 3. Store, bounded readback, durable stored-row return checks, accepted completion, and accepted reuse all require the exact V2 key and `objectKeyVersion: "ATTEMPT_V2"`.

The previous key formula is retained only by a legacy verifier. Pre-V2 terminal generation rows keep `object_key_version IS NULL` because migration 027 makes terminal rows immutable. Only the internal persisted-accepted replay branch may interpret a null version as legacy, and only after `status='ACCEPTED'`, the full scope/plan/input/evidence matrix, exact old key formula, stored-object readback, and checker replay all pass. No external input selects this compatibility path. Application store/complete/reject/cleanup writes never write a legacy or null version. A PostgreSQL `NOT VALID` new-write constraint preserves existing null legacy rows without scanning or mutating them while rejecting every future accepted row that is not exact `ATTEMPT_V2`. The in-memory attempt repository applies the same rule to new completion.

## Cleanup identity and legacy handling

New cleanup obligations carry `objectKeyVersion: "ATTEMPT_V2"`. Their immutable identity includes account, attempt identity, attempt number, and object key. Re-recording that exact identity is idempotent; a different attempt has a different physical V2 key and cannot conflict.

Existing cleanup rows are marked `LEGACY_V1` at the migration boundary and remain claimable. Before processing, the worker exact-verifies V2 rows with the V2 formula and legacy rows with the old formula. A malformed or unknown version never reaches storage. An unreferenced valid legacy row may be deleted; a referenced legacy row is adopted.

## Account-scoped reference adoption

The cleanup repository adds:

```js
adoptAssetCleanupIfReferenced({ accountId, id, workerId, claimToken })
// => { status: "UNREFERENCED" }
// => { status: "ADOPTED", record }
```

The PostgreSQL adapter performs the ownership fence, reference lookup, and conditional transition in one statement. The lookup requires the same `account_id` and exact `object_key` in `ai_generation_assets`; it never trusts a caller-supplied reference. A referenced obligation transitions from `PROCESSING` to terminal `ADOPTED`, clears its claim, and records `adopted_at`, `adopted_generation_asset_id`, and `adopted_generation_asset_status`. Exact account/id/owner/token/non-expired CAS rejects stale, duplicate, and cross-account calls. `ADOPTED` rows are excluded from future claims.

The memory adapter receives a testable generation-reference lookup port and applies the same validation and CAS contract. A lookup error or malformed reference fails closed: the worker records a failed batch item and never deletes the object.

For every valid claimed obligation the worker first calls the adoption port. `ADOPTED` means no storage call. `UNREFERENCED` permits exact `storage.removeObject(objectKey, { accountId })`, followed by the existing completion CAS. The worker summary becomes `{ claimed, completed, adopted, failed }` with `claimed = completed + adopted + failed`.

Physical V2 isolation is the primary race fix. The adoption fence is defense in depth for already-persisted legacy references and unexpected referenced rows; it is not used to justify reuse of a key across new attempts.

## Migration and database contract

Migration 030 additively introduces `object_key_version` on generation assets and cleanup obligations over the already-applied migration 029. It never updates `ai_generation_assets`: doing so would invoke migration 027's terminal immutability trigger and abort an upgrade containing any accepted/rejected/failed object row. Existing generation rows therefore retain a null version and remain immutable. New accepted evidence uses a `NOT VALID` constraint whose accepted branch explicitly requires `object_key_version IS NOT NULL`, equality to `ATTEMPT_V2`, and the strict complete-path verifier result `IS TRUE`; PostgreSQL NULL can no longer bypass the check.

Cleanup rows have no terminal immutability trigger, so migration 030 safely labels their existing null versions `LEGACY_V1` before setting the cleanup version column non-null. Cleanup status expands to terminal `ADOPTED` with closed audit-field and claim-field checks. New cleanup inserts must be V2, while migrated legacy `PENDING` rows remain valid and processable.

The double-gated PostgreSQL fixture proves:

- legacy terminal accepted rows survive migration unchanged with a null version, while pending cleanup rows are labeled `LEGACY_V1`;
- migration 030 can execute twice without touching terminal generation rows;
- future accepted rows with a null version and future cleanup inserts without V2 fail;
- a V2 accepted row persists the exact attempt-level key;
- reference adoption is account-scoped, atomic, audited, terminal, and stale-token safe;
- an unreferenced obligation remains `PROCESSING` for deletion; and
- different attempts with identical bytes have distinct keys and cleanup identities.

## TDD and verification

RED groups are:

1. Key/store/reuse: attempts 1 and 2 must have distinct V2 keys; every store/readback/audit return fence carries the version; trusted legacy accepted reuse remains read-only.
2. End-to-end race: attempt 1 leaves an orphan, attempt 2 accepts identical bytes, and the worker deletes only the attempt-1 key while preserving attempt 2.
3. Cleanup lifecycle: same-attempt recording is idempotent, different attempts do not conflict, referenced V2/legacy rows become audited `ADOPTED`, unknown/cross-account/stale evidence never deletes, and adopted rows cannot be reclaimed.
4. Migration/PostgreSQL: static contract proves migration 030 contains no generation-row update and uses explicit non-null/`IS TRUE` accepted gating; the dedicated two-gate fixture covers immutable legacy terminal rows, repeat execution, null-version rejection, legacy cleanup processing, account scope, and exact adoption CAS.

After GREEN, run the focused set, all auto-listing/AI/adapter/object-storage tests, all migration tests, historical regressions, whole `*.test.mjs`, raw `*.mjs`, production build, changed-module syntax, and diff inspection. The raw dedicated-database integration failure remains reported separately if its URL is absent.

## Risk and rollback

No old object is renamed or copied. Legacy accepted rows remain readable at their stored keys; new attempts never write those keys. The main integration risk is any future PostgreSQL attempt adapter omitting `objectKeyVersion` or the reference/adoption port. Rollback is a source revert while the feature remains disabled; if the migration was applied, preserve accepted/cleanup audit rows and use a reviewed compensating migration rather than destructive schema or object deletion.

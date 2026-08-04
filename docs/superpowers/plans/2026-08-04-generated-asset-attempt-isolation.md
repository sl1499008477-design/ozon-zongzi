# Generated Asset Attempt Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an orphan cleanup from deleting an object accepted by a later generation attempt while preserving read-only legacy accepted and cleanup evidence.

**Architecture:** New writes use an exact attempt-scoped `ATTEMPT_V2` object key and version audit. Cleanup performs an atomic account-scoped generation-reference adoption CAS before deletion, while migrated `LEGACY_V1` rows remain read-only and processable.

**Tech Stack:** Node.js ESM, `node:test`, additive PostgreSQL SQL migration 030 over deployed 029, in-memory reference adapters, Sharp-backed image fixtures.

## Global Constraints

- Do not wire runtime workers or call real AI, object storage, Ozon, production data, or an ordinary database URL.
- Preserve exact account/job/item/plan/group/slot, attempt identity/number, input hash, content hash, lease owner/token/expiry, and object-key-version boundaries.
- New accepted assets and cleanup obligations must be `ATTEMPT_V2`; `LEGACY_V1` is migration-created read-only evidence only.
- PostgreSQL validates the complete V2 path structure and embedded attempt/input/content evidence, not only a suffix.
- A cleanup lookup, adoption, or audit failure fails closed before storage deletion.
- Preserve legacy rows; rollback uses source revert and a reviewed compensating migration, never destructive row or object deletion.

---

### Task 1: ATTEMPT_V2 key and accepted compatibility

**Files:**
- Modify: `server/auto-listing-asset-store.mjs`
- Modify: `server/auto-listing-image-generator.mjs`
- Modify: `server/auto-listing-generation-attempt-repository.mjs`
- Test: `server/tests/auto-listing-asset-store.test.mjs`
- Test: `server/tests/auto-listing-image-generator.test.mjs`
- Test: `server/tests/auto-listing-generation-attempt-repository.test.mjs`

**Interfaces:**
- Produces: `buildGeneratedAssetObjectKey(input)` for V2 only; `verifyGeneratedAssetObjectKey(input)` for explicit V2 or migrated legacy verification.
- Consumes: `objectKeyVersion: "ATTEMPT_V2" | "LEGACY_V1"`, exact `attemptIdentityHash`, `attemptNo`, `inputHash`, and `contentHash`.

- [ ] **Step 1: Write failing attempt-isolation and legacy-read tests**

```js
const first = buildGeneratedAssetObjectKey({ ...scope, attemptNo: 1, contentHash });
const second = buildGeneratedAssetObjectKey({ ...scope, attemptNo: 2, contentHash });
assert.notEqual(first, second);
assert.match(first, new RegExp(`${scope.attemptIdentityHash}/attempt-1/${scope.inputHash}/${contentHash}\\.png$`));
assert.equal(verifyGeneratedAssetObjectKey({ ...legacy, objectKeyVersion: "LEGACY_V1" }), true);
```

Add store/readback/recorded-return assertions for `objectKeyVersion: "ATTEMPT_V2"`; add accepted completion/reuse corruption cases for missing version, wrong version, wrong attempt segment, and wrong embedded hashes. A migrated legacy accepted fixture uses the old exact key and `LEGACY_V1` only.

- [ ] **Step 2: Run Task 1 RED**

Run:

```bash
node --test server/tests/auto-listing-asset-store.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-generation-attempt-repository.test.mjs
```

Expected: failures show equal attempt keys, missing version propagation, no V2/legacy verifier, and acceptance of corrupt/missing V2 audit.

- [ ] **Step 3: Implement the minimal key/version fences**

```js
const ATTEMPT_V2 = "ATTEMPT_V2";
const LEGACY_V1 = "LEGACY_V1";
return `auto-listing/v2/${scopeSegments}/${attemptIdentityHash}/attempt-${attemptNo}/${inputHash}/${contentHash}.png`;
```

Keep the old formula private to explicit `LEGACY_V1` verification. New storage always emits V2. New in-memory attempt completion rejects non-V2; accepted replay selects the verifier from the persisted version and never infers legacy from key text.

- [ ] **Step 4: Rerun Task 1 GREEN**

- [ ] **Step 5: Keep changes uncommitted until A–D integrated verification**

### Task 2: Cleanup adoption port and race reproduction

**Files:**
- Modify: `server/auto-listing-asset-cleanup-repository.mjs`
- Modify: `server/auto-listing-asset-cleanup-worker.mjs`
- Test: `server/tests/auto-listing-asset-cleanup-repository.test.mjs`
- Test: `server/tests/auto-listing-asset-cleanup-worker.test.mjs`
- Test: `server/tests/auto-listing-asset-store.test.mjs`

**Interfaces:**
- Produces: `adoptAssetCleanupIfReferenced({ accountId, id, workerId, claimToken })` returning exact `UNREFERENCED` or terminal `ADOPTED` evidence.
- Produces worker summary: `{ claimed, completed, adopted, failed }`.

- [ ] **Step 1: Write failing lifecycle and end-to-end race tests**

```js
assert.deepEqual(await repository.adoptAssetCleanupIfReferenced(ownership), {
  status: "ADOPTED",
  record: { ...expected, status: "ADOPTED", adoptedAt: now,
    adoptedGenerationAssetId: "accepted-2", adoptedGenerationAssetStatus: "ACCEPTED" },
});
```

Use real key builder, memory cleanup repository, worker, and an in-memory object set to reproduce: attempt 1 creates an orphan, attempt 2 stores identical bytes under another V2 key and is represented as accepted, worker runs, attempt-1 key is removed, and attempt-2 key remains. Add referenced V2 and legacy obligations that transition to ADOPTED with zero storage deletes; cross-account, stale token, malformed reference, reference lookup failure, and duplicate adoption fail closed. Assert ADOPTED is never reclaimed.

- [ ] **Step 2: Run Task 2 RED**

Run:

```bash
node --test server/tests/auto-listing-asset-cleanup-repository.test.mjs server/tests/auto-listing-asset-cleanup-worker.test.mjs server/tests/auto-listing-asset-store.test.mjs
```

Expected: missing adoption port/status/audit/summary and unconditional delete failures.

- [ ] **Step 3: Implement minimal memory adoption and worker ordering**

The memory repository accepts a generation-reference lookup dependency returning the complete `{ accountId, id, status, objectKey }` reference. It validates same account/key, applies exact live-lease CAS, clears claims, and freezes ADOPTED audit. Worker calls adoption before deletion; any lookup/return error increments `failed`, logs only a stable code, and never calls storage.

- [ ] **Step 4: Rerun Task 2 GREEN**

- [ ] **Step 5: Keep changes uncommitted until A–D integrated verification**

### Task 3: Cleanup dedupe and immutable version contract

**Files:**
- Modify: `server/auto-listing-asset-cleanup-repository.mjs`
- Test: `server/tests/auto-listing-asset-cleanup-repository.test.mjs`

**Interfaces:**
- Consumes V2 exact keys for new obligations and migration-labeled legacy keys for existing rows.
- Preserves exact same-attempt replay; distinct attempts have distinct dedupe identities and keys.

- [ ] **Step 1: Write failing idempotency/version tests**

Assert exact same V2 obligation replays one row, a second attempt with the same bytes records a second row/key, and a new `LEGACY_V1` record request is rejected. Exercise migrated legacy PENDING processing through the worker boundary and the PostgreSQL fixture; do not add a test-only preload API to the memory repository.

- [ ] **Step 2: Run Task 3 RED**

Run:

```bash
node --test server/tests/auto-listing-asset-cleanup-repository.test.mjs
```

- [ ] **Step 3: Implement the immutable identity/version rule**

Use account + attempt identity + attempt number + object key for cleanup dedupe hashing. `recordAssetCleanupRequired` accepts only exact V2. PostgreSQL row mapping preserves migrated legacy rows; ordinary callers cannot create them.

- [ ] **Step 4: Rerun Task 3 GREEN**

- [ ] **Step 5: Keep changes uncommitted until A–D integrated verification**

### Task 4: PostgreSQL migration and atomic adoption

**Files:**
- Create: `server/db/migrations/030_auto_listing_generated_asset_attempt_isolation.sql`
- Modify: `server/auto-listing-asset-cleanup-repository.mjs`
- Test: `server/tests/auto-listing-ai-generation-evidence-migration.test.mjs`
- Test: `server/tests/auto-listing-ai-migration-postgres.test.mjs`

**Interfaces:**
- PostgreSQL adapter implements the same exact adoption result and CAS contract as memory.
- Migration labels preexisting keys `LEGACY_V1` and gates all future accepted/cleanup writes to structurally exact V2.

- [ ] **Step 1: Write failing static and double-gated behavior tests**

The static test requires both object-key-version columns, legacy labeling updates, V2-only new-write constraints, complete path verification bound to every scope/attempt/hash component, ADOPTED audit columns, closed status/audit/claim checks, and an account-scoped generation-reference query.

The PostgreSQL fixture builds the <=028 shape with legacy accepted evidence, applies migration 029, inserts a legacy cleanup row, applies migration 030 twice, verifies `LEGACY_V1`, rejects future legacy/malformed V2 accepted and cleanup rows, accepts an exact V2 row, then proves referenced adoption, wrong-account/stale rejection, terminal no-reclaim, and unreferenced delete eligibility.

- [ ] **Step 2: Run Task 4 RED**

Run:

```bash
node --test server/tests/auto-listing-ai-generation-evidence-migration.test.mjs server/tests/auto-listing-ai-migration-postgres.test.mjs
```

Expected without dedicated database: static failures plus one explicit two-gate skip.

- [ ] **Step 3: Implement additive migration and one-statement PostgreSQL adoption**

The adoption statement locks and validates the exact obligation lease, selects a deterministic same-account exact-key generation asset, conditionally updates ADOPTED audit, and returns either exact ADOPTED evidence or UNREFERENCED. Missing/stale ownership rejects.

- [ ] **Step 4: Rerun Task 4 GREEN/static plus gated behavior when configured**

- [ ] **Step 5: Keep changes uncommitted until integrated verification**

### Task 5: Full verification, reporting, and handoff

**Files:**
- Modify: `.superpowers/sdd/2026-08-04-auto-listing-ai-content-pipeline/task-4-report.md`
- Modify: `.superpowers/sdd/2026-08-04-auto-listing-ai-content-pipeline/progress.md`
- Modify: `docs/superpowers/plans/2026-08-04-auto-listing-ai-content-pipeline.md`

**Interfaces:**
- Reports exact changed contracts, RED/GREEN evidence, unverified PostgreSQL/live ranges, regression risk, and rollback.

- [ ] **Step 1: Run combined A–D focused tests**
- [ ] **Step 2: Run auto-listing/AI/adapter/object-storage and migration matrices**
- [ ] **Step 3: Run historical, whole `*.test.mjs`, and raw `*.mjs` matrices**
- [ ] **Step 4: Run production build, changed-module syntax, `git diff --check`, and final diff/status inspection**
- [ ] **Step 5: Update report/ledger with exact evidence and explicit unverified ranges**
- [ ] **Step 6: Commit the scoped repair with the coordinator-provided message**
- [ ] **Step 7: Hand the commit to an independent reviewer without self-declaring PASS**

### Task 6: Preserve immutable legacy assets and close PostgreSQL NULL acceptance

**Files:**
- Modify: `server/db/migrations/030_auto_listing_generated_asset_attempt_isolation.sql`
- Modify: `server/auto-listing-asset-store.mjs`
- Modify: `server/auto-listing-image-generator.mjs`
- Test: `server/tests/auto-listing-ai-generation-evidence-migration.test.mjs`
- Test: `server/tests/auto-listing-ai-migration-postgres.test.mjs`
- Test: `server/tests/auto-listing-asset-store.test.mjs`
- Test: `server/tests/auto-listing-image-generator.test.mjs`

**Interfaces:**
- Produces: `verifyPersistedAcceptedGeneratedAssetObjectKey(record)` as an internal-server compatibility verifier; callers do not pass a legacy-mode flag.
- Preserves: ordinary `verifyGeneratedAssetObjectKey(input)` accepts only explicit `ATTEMPT_V2` or `LEGACY_V1` and every new store/complete/cleanup write remains V2-only.

- [x] **Step 1: Add RED compatibility tests**

Add an application test where a persisted `status: "ACCEPTED"`, null-version record with the exact former key formula is accepted only by the persisted-accepted verifier. Assert ordinary verification still rejects it, and null-version non-accepted or malformed legacy keys fail. Add generator replay coverage so the complete existing scope/plan/input/checker/object-readback matrix remains mandatory.

Add migration assertions that 030 contains no `UPDATE ai_generation_assets`, and its accepted constraint contains all three closed predicates:

```sql
object_key_version IS NOT NULL
AND object_key_version = 'ATTEMPT_V2'
AND auto_listing_generation_object_key_v2_complete(...) IS TRUE
```

Update the double-gated fixture so the 027 terminal trigger remains installed, legacy accepted version stays SQL NULL after 030, a future otherwise-valid accepted insert with version NULL is rejected with `23514`, cleanup legacy rows are still backfilled, and applying 030 twice converges.

- [x] **Step 2: Run RED**

Run:

```bash
node --test server/tests/auto-listing-ai-generation-evidence-migration.test.mjs server/tests/auto-listing-ai-migration-postgres.test.mjs server/tests/auto-listing-asset-store.test.mjs server/tests/auto-listing-image-generator.test.mjs
```

Expected: static migration assertions fail because 030 updates terminal assets and lacks explicit non-null/`IS TRUE`; application compatibility fails because unversioned legacy accepted replay is not exposed internally.

- [x] **Step 3: Implement the minimal repair**

Delete only the generation-asset legacy backfill from 030. Keep the cleanup backfill. Strengthen the accepted branch of `ai_generation_assets_new_object_key_v2_check` with explicit non-null and strict verifier `IS TRUE`.

Add a dedicated persisted-accepted verifier that requires `status === "ACCEPTED"`. It first uses the ordinary explicit-version verifier; only when `objectKeyVersion == null` does it exact-match the former key formula. `auto-listing-image-generator.mjs` invokes this function only after its existing accepted status/scope/input/attempt/evidence checks; object readback and checker replay remain unchanged.

- [x] **Step 4: Run focused GREEN, complete matrices, update evidence, and commit**

Run the Task 6 focused command, all auto-listing tests, migration tests, whole `*.test.mjs`, raw `*.mjs`, production build, changed-module syntax, and `git diff --check`. Record the dedicated PostgreSQL skip and the known raw missing-database failure separately. Commit the scoped repair and hand it to independent review without self-declaring PASS.

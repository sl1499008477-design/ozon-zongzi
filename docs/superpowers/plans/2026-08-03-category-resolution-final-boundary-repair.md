# Category Resolution Final Boundary Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three residual production-boundary defects so the account-level Ozon category resolution branch is safe to integrate.

**Architecture:** Keep public contracts unchanged and repair each defect at its source boundary: private transaction context for PostgreSQL manual saves, reason-aware stale classification in the resolution service, and per-account/store epoch fencing in the Ozon category cache. Each task follows a separate RED/GREEN cycle and is followed by full regression and independent read-only review.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL transaction adapters, React/Vite.

## Global Constraints

- Obey repository `AGENTS.md`: backend authority, account/store isolation, auditability, idempotency, recoverability, stable contracts, and explicit verification reporting.
- Do not access real Ozon, perform listing writes, use production credentials/data, or connect to an unapproved database.
- Do not expose `accountId`, cache epoch, repository rows, credentials, or raw upstream failures through public responses.
- Preserve the user's dirty main worktree; work only on `codex/account-level-ozon-category-auto-resolution`.

---

### Task 1: Preserve PostgreSQL manual-save account context

**Files:**
- Modify: `server/listing-pipeline.mjs`
- Modify: `server/index.mjs`
- Test: `server/tests/collect-category-auto-resolution-seams.test.mjs`
- Test: `server/tests/support/collect-category-auto-resolution-seams.worker.mjs`

**Interfaces:**
- Consumes: `updateCollectItemDraftV4({ accountId, beforeCommit })` and `saveManualFromDraft({ accountId, collectItemId, postgresExecutor, collectItem })`.
- Produces: private `beforeCommit({ client, item, accountId })` context; public returned item remains redacted.

- [ ] **Step 1: Write the failing production-path test**

Add a PostgreSQL-facing PATCH seam whose returned public item has no `accountId`, while the private callback must receive the authenticated row account and successfully save canonical `MANUAL` state through the same transaction client.

- [ ] **Step 2: Run the test and verify RED**

Run the focused seam test. Expected failure: canonical save cannot identify the account because the callback receives only the redacted public item.

- [ ] **Step 3: Pass private account context inside the transaction**

Pass `row.account_id` separately to `beforeCommit`; make the route use that backend-derived value and reject a mismatch with the authenticated account. Keep the public item unchanged.

- [ ] **Step 4: Run focused transaction tests and verify GREEN**

Verify success, rollback on canonical-save failure, shared transaction-client identity, account mismatch rejection, and public response redaction.

### Task 2: Classify deterministic stale snapshots correctly

**Files:**
- Modify: `server/collect-category-resolution-service.mjs`
- Test: `server/tests/collect-category-resolution-service.test.mjs`

**Interfaces:**
- Consumes: snapshot `{ stale, staleReasonCode, taxonomyFingerprint }`.
- Produces: existing stable failure codes and states; no new public response fields.

- [ ] **Step 1: Write the failing classification tests**

Add literal cases proving `OZON_CATEGORY_DATA_INVALID` stale data ends in `NEEDS_REVIEW`, while timeout/429/5xx stale reasons enter `RETRYABLE_ERROR` and can later reach `MATCHED`.

- [ ] **Step 2: Run the tests and verify RED**

Expected failure: deterministic stale data is converted to generic retryable taxonomy stale.

- [ ] **Step 3: Preserve stale reason semantics**

Map stale reasons through the existing failure classifier without matching against stale items. Keep the last-known-good fingerprint as evidence.

- [ ] **Step 4: Run service and runtime recovery tests and verify GREEN**

Verify deterministic review, bounded transient retry, recovery, attempt counts, evidence preservation, and audit actions.

### Task 3: Fence cache invalidation against in-flight old credentials

**Files:**
- Modify: `server/ozon-category-service.mjs`
- Test: `server/tests/ozon-category-service.test.mjs`
- Test: `server/tests/collect-category-auto-resolution-seams.test.mjs`

**Interfaces:**
- Consumes: `invalidateStore({ accountId, storeId })` called before store wake.
- Produces: same public cache service API with internal account/store epoch fencing.

- [ ] **Step 1: Write the failing race test**

Use deferred old/new Ozon responses: start an old-credential fetch, invalidate the store, resolve the old fetch, then fetch with new credentials. Assert the old response never becomes a cache or snapshot hit.

- [ ] **Step 2: Run the test and verify RED**

Expected failure: the late old response repopulates cache after invalidation.

- [ ] **Step 3: Add per-scope epoch fencing**

Increment the account/store epoch before deletion; capture it at request start; only write tree/attribute/value/snapshot caches if unchanged. Never alter other scopes.

- [ ] **Step 4: Run cache and credential-update tests and verify GREEN**

Verify the race, ordinary cache hits, TTL refresh, same-scope invalidation, and cross-account/cross-store isolation.

### Task 4: Full verification and independent review

**Files:**
- Modify only tests or implementation required by a confirmed regression.

**Interfaces:**
- Consumes: Tasks 1–3 commits.
- Produces: evidence-backed integration verdict.

- [ ] **Step 1: Run focused regression suites**

Run repository/runtime/service/category-cache/HTTP seam and App contract tests; record totals, failures, and skips.

- [ ] **Step 2: Run full non-production gates**

Run the complete active App + Server suite, App production build, syntax, module-boundary, inventory, listing/delete/store-isolation, whitespace, personal-data, and credential checks.

- [ ] **Step 3: Request independent read-only review**

Review the correction range against this plan and `AGENTS.md`. Critical or Important findings block integration.

- [ ] **Step 4: Commit and report**

Commit tests and implementation, then report changed contracts, verification evidence, unverified live PostgreSQL/Ozon/browser scope, regression risks, and rollback instructions.

# Auto Listing Preparation Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the authoritative store currency into category preparation and refresh a uniquely relocated Ozon type before creating an automatic-listing job.

**Architecture:** Keep store currency verification in the existing store-access port. Add one narrowly scoped category-freshness port that reads the live Ozon taxonomy, uses the existing account-shared repository CAS transitions, and tells the service to reload sources before it acquires a preparation lease. Preserve all existing job idempotency, category lease, tenant, and external-write gates.

**Tech Stack:** Node.js ESM, PostgreSQL 16, node:test, existing Ozon category service and account-shared repository.

## Global Constraints

- Store currency remains authoritative only when sourced from `OZON_SELLER_INFO` with a persisted synchronization timestamp.
- Category refresh accepts only one enabled leaf with the exact existing `sourceTypeId`; no text or fuzzy matching.
- A refresh must append transitions and preserve old source evidence.
- Refreshed sources must be reloaded before category lease acquisition.
- No AI, Ozon product import, stock write, or automatic browser click during verification.

---

### Task 1: Close the Store Access Currency Contract

**Files:**
- Modify: `server/auto-listing-category-access-postgres.mjs`
- Modify: `server/tests/auto-listing-category-access-postgres.test.mjs`

**Interfaces:**
- Consumes: `{ accountId, targetStoreId }`.
- Produces: frozen `{ id, ownerAccountId, clientId, currencyCode, apiKey }` only for an active, credentialed, Ozon-currency-verified store.

- [ ] Write the failing test using a literal CNY row and require `currencyCode: "CNY"` plus the authoritative SQL predicate.
- [ ] Run the focused test and confirm it fails because `currencyCode` is absent.
- [ ] Select `currency_code`, require `currency_source='OZON_SELLER_INFO'` and non-null sync time, and return the currency.
- [ ] Run category-access, listing-base-preparer, and listing-policy tests green.
- [ ] Commit the isolated fix.

### Task 2: Refresh a Uniquely Relocated Ozon Type

**Files:**
- Create: `server/auto-listing-category-freshness.mjs`
- Modify: `server/account-shared-ozon-category-composition.mjs`
- Modify: focused composition/freshness tests.

**Interfaces:**
- Consumes: exact account, store access, and shared category identity.
- Produces: `{ status: "CURRENT" | "REFRESHED", sharedCategoryVersion }` or a stable fail-closed error.

- [ ] Add a failing test with stored `17033252/94453` and a live tree containing exactly `17029005/94453`.
- [ ] Confirm RED: no freshness port exists and no shared transition occurs.
- [ ] Resolve exact type with `resolveExactType`, compute taxonomy fingerprint, validate attributes for the replacement pair, then perform existing invalidate/activate CAS transitions.
- [ ] Add version-conflict, missing type, duplicate type, stale tree, and malformed carrier tests proving zero activation on failure.
- [ ] Run focused tests green and commit.

### Task 3: Reload Sources Before Lease and Job Creation

**Files:**
- Modify: `server/auto-listing-runtime.mjs`
- Modify: `server/auto-listing-service.mjs`
- Modify: `server/tests/auto-listing-service.test.mjs`
- Modify: `server/tests/auto-listing-runtime.test.mjs`

**Interfaces:**
- Consumes: `ensureCategoryFresh({ accountId, targetStoreId, sources })`.
- Produces: task creation using newly reloaded source/shared versions when any category is refreshed.

- [ ] Add a failing service test proving the order `load sources -> refresh -> reload sources -> acquire lease -> prepare -> graph` and exact one graph.
- [ ] Confirm RED because service currently acquires the old lease immediately.
- [ ] Inject and close the freshness dependency in runtime/service; reload the full source set on `REFRESHED` and revalidate it before lease acquisition.
- [ ] Add `CURRENT`, fail-closed, replay-first, and refreshed-version conflict tests.
- [ ] Run service/runtime/category lease regressions green and commit.

### Task 4: Safe User Error and Real Verification

**Files:**
- Modify: `server/auto-listing-routes.mjs`
- Modify: `app/src/auto-listing-config.js`
- Modify: focused route/UI tests.
- Create or update: delivery verification report.

**Interfaces:**
- Produces fixed Chinese messages for category review/unavailability without raw Ozon data.

- [ ] Add RED route/UI tests for the stable category errors.
- [ ] Add public allowlist/status/message mappings; keep unknown failures generic.
- [ ] Run the current item through the production read-only preparer and require CNY plus the live `17029005/94453` pair.
- [ ] Run real PostgreSQL account-shared/freshness tests, service/runtime/route/UI regressions, syntax, diff check, and Vite build.
- [ ] Verify job/import/stock counts did not grow during diagnostics and report unverified live creation as requiring the user's next click.
- [ ] Commit implementation and verification separately with rollback instructions.

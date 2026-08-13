# Ozon Store Currency Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ozon `/v1/seller/info` the only authority for a store's RUB/CNY currency and prevent automatic listing when that authority has not been synchronized.

**Architecture:** The profile synchronizer projects and persists a closed currency observation. An additive PostgreSQL migration records currency provenance and time; public DTOs and automatic listing consume only verified values. Existing legacy defaults remain readable but cannot authorize a new listing until profile synchronization succeeds.

**Tech Stack:** Node.js ESM, PostgreSQL migrations, node:test, React/Vite.

## Global Constraints

- Only `RUB` and `CNY` are supported.
- Never infer a store currency from products, accounts, another store, or a hard-coded default.
- Never convert amounts between currencies.
- Do not expose Ozon raw responses or credentials.
- No product creation, stock write, AI call, or automatic retry during repair.

---

### Task 1: Project authoritative Ozon currency

**Files:**
- Modify: `server/ozon-sync-service.mjs`
- Modify: `server/tests/ozon-sync-service.test.mjs`

**Interfaces:**
- Consumes: `/v1/seller/info` response `result.company.currency`.
- Produces: store fields `currencyCode`, `currencySource="OZON_SELLER_INFO"`, `currencySyncedAt`.

- [ ] Add a failing test proving `company.currency=CNY` is currently discarded.
- [ ] Run the focused test and verify the expected failure.
- [ ] Implement strict RUB/CNY normalization and store projection.
- [ ] Cover missing/unsupported currency without overwriting prior verified evidence.
- [ ] Run the focused tests green.

### Task 2: Persist provenance and reject legacy defaults

**Files:**
- Create: `server/db/migrations/073_store_currency_authority.sql`
- Modify: `server/formal-persistence.mjs`
- Modify: `server/auto-listing-repository.mjs`
- Modify: focused migration/repository tests.

**Interfaces:**
- Consumes: synchronized store currency fields.
- Produces: `stores.currency_source`, `stores.currency_synced_at`; automatic listing accepts only `OZON_SELLER_INFO`.

- [ ] Add failing migration and repository tests for legacy default rejection and verified CNY acceptance.
- [ ] Run them red.
- [ ] Add the forward-only columns/constraints and mirror the exact evidence.
- [ ] Load and lock provenance with the target store; fail before AI/Ozon writes when unverified.
- [ ] Run focused PostgreSQL and repository tests green.

### Task 3: Remove cross-store inference from public UI

**Files:**
- Modify: `server/index.mjs`
- Modify: focused server/UI tests.

**Interfaces:**
- Consumes: exact persisted store currency authority.
- Produces: `currencyCode` only for verified stores; otherwise an empty value and safe synchronization guidance.

- [ ] Add a failing test showing a store with no currency incorrectly inherits another store's product currency.
- [ ] Run it red.
- [ ] Remove product-cache/default inference from store DTO creation.
- [ ] Verify verified CNY/RUB render correctly and unverified stores cannot submit.

### Task 4: Repair this store and remove the exact failed history

**Files:**
- No code files; controlled local PostgreSQL operations only.

**Interfaces:**
- Consumes: verified live Ozon seller-info currency for `local_a936f178c376`.
- Produces: persisted CNY authority and removal of job `auto_listing_job_6148ab5b01834583a1be4b0e0707e8f0` only.

- [ ] Stop local services and create a database backup with checksum.
- [ ] Apply migrations through 073.
- [ ] Run the normal read-only profile synchronization path and verify CNY/source/time.
- [ ] Delete only the exact failed job and dependent rows after resolving their identities read-only.
- [ ] Restart services and verify the old failure row is absent without creating a new task.

### Task 5: Verification and handoff

**Files:**
- Modify: delivery report only if needed.

- [ ] Run focused sync, persistence, repository, route, UI, migration, syntax, and diff checks.
- [ ] Verify no Ozon product/import/stock request occurred.
- [ ] Verify the extension requires no reinstall.
- [ ] Commit implementation and report rollback/backup details.


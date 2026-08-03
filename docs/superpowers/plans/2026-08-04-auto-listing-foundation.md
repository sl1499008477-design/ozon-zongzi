# Auto Listing Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build the account-scoped, immutable, auditable task foundation for “自动上架”, including source snapshots, frozen configuration, exact RUB price calculation, category-strategy versioning, and a closed state machine.

**Architecture:** A focused service creates one immutable source snapshot per item and stores only frozen references in the job. Pure modules own pricing, configuration validation, strategy selection, and state transitions. A PostgreSQL repository owns transactions and idempotency; route handlers never accept account scope from the browser and never call AI or Ozon directly.

**Tech Stack:** Node.js ESM, PostgreSQL, current account/store contracts, node:test, current migration and verification scripts.

## Global Constraints

- Follow AGENTS.md: backend permission checks, explicit account/store boundaries, immutable traceable data, idempotent task creation, stable contracts, additive migrations, observable failures, and testable core logic.
- Use TEXT IDs to match accounts, stores, collect_items, and the current listing pipeline.
- Recollection creates a new snapshot; no update path may mutate snapshot or snapshot_hash.
- All prices are RUB kopecks, decimal strings at API/database boundaries and BigInt inside calculations.
- Ordinary users use TENANT_OPERATE. Strategy publication and gateway configuration require a new admin-only permission.
- AUTO_LISTING_ENABLED remains off until all four plans pass.
- Preserve the unrelated modified planning files in the current worktree.

## Dependencies and Stable Outputs

This is plan 1 of 4 and must be completed first. It provides:

~~~js
createAutoListingJob({ actor, sourceType, sourceRecords, config, idempotencyKey })
getAutoListingJob({ actor, jobId })
transitionAutoListingItem({ currentStatus, event })
calculateAutoListingPrice(input)
resolveAiContentStrategy(input)
~~~

Dependent plans:

1. docs/superpowers/plans/2026-08-04-auto-listing-ai-content-pipeline.md
2. docs/superpowers/plans/2026-08-04-auto-listing-user-workflow.md
3. docs/superpowers/plans/2026-08-04-auto-listing-ozon-upload-rollout.md

---

## Task 1: Add the PostgreSQL Foundation

**Files:**
- Create: server/db/migrations/026_auto_listing_foundation.sql
- Create: server/tests/auto-listing-foundation-migration.test.mjs

**Interfaces:** auto_listing_jobs, auto_listing_source_snapshots, auto_listing_job_items, auto_listing_events, ai_content_strategy_versions, ai_content_strategy_rules.

- [ ] **Step 1: Write a failing migration-contract test**

Assert all six tables, account/store foreign keys, immutable snapshot hash, allowed source types, exact item-state constraint, account-scoped idempotency uniqueness, JSONB defaults, and lookup indexes exist. Reject DROP TABLE, DROP COLUMN, and mutation triggers targeting source snapshots.

~~~js
assert.match(sql, /UNIQUE\s*\(account_id,\s*idempotency_key\)/i);
assert.match(sql, /source_type\s+TEXT[^;]+COLLECT_BOX[^;]+EXCEL_SKU/is);
assert.match(sql, /snapshot_hash\s+TEXT\s+NOT NULL/i);
assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN)/i);
~~~

- [ ] **Step 2: Run it and confirm RED**

~~~bash
node --test server/tests/auto-listing-foundation-migration.test.mjs
~~~

Expected: migration 026 does not exist.

- [ ] **Step 3: Create the additive migration**

Use service-generated TEXT IDs. auto_listing_jobs contains account_id, source_type, status, idempotency_key, config_snapshot, config_hash, strategy_version_id, created_by, correlation_id, and timestamps, with UNIQUE(account_id, idempotency_key).

auto_listing_source_snapshots contains account_id, source_type, source_record_id, source_version, snapshot JSONB, snapshot_hash, raw_response_ref, and created_at. Do not add UPDATE behavior.

auto_listing_job_items contains job/account/snapshot IDs, target store and warehouse IDs, status, status_version, visual_group_count, stable error fields, and timestamps. The state check contains exactly:

~~~text
CREATED, SOURCE_READY, PLANNING, GENERATING, READY_FOR_REVIEW,
UPLOAD_QUEUED, UPLOADING, SUCCEEDED, RETRYABLE_ERROR, BLOCKED, CANCELLED
~~~

auto_listing_events is append-only and stores account, job, item, actor, from/to status, event type, correlation ID, details JSONB, and created_at.

Strategy tables store immutable published versions and ordered exact-category, ancestor, and product-style rules. Publishing creates a new version instead of editing a published version.

- [ ] **Step 4: Run the test and configured migration**

~~~bash
node --test server/tests/auto-listing-foundation-migration.test.mjs
AUTO_LISTING_POSTGRES_TESTS=1 node server/db/migrate.mjs
~~~

Expected: contract passes. If no dedicated PostgreSQL test database is configured, record that integration skip; do not point the test at production.

- [ ] **Step 5: Commit**

~~~bash
git add server/db/migrations/026_auto_listing_foundation.sql server/tests/auto-listing-foundation-migration.test.mjs
git commit -m "feat: add auto listing task foundation"
~~~

---

## Task 2: Implement Exact Pricing and Frozen Configuration

**Files:**
- Create: server/auto-listing-pricing.mjs
- Create: server/auto-listing-contract.mjs
- Create: server/tests/auto-listing-pricing.test.mjs
- Create: server/tests/auto-listing-contract.test.mjs

**Interfaces:** calculateAutoListingPrice, normalizeAutoListingConfig, AUTO_LISTING_IMAGE_ROLES, AUTO_LISTING_ITEM_STATUSES.

- [ ] **Step 1: Write failing pricing tests**

Cover 79.99 and 80.00 boundaries, high-branch discounts, signed adjustments, half-kopeck rounding, non-RUB currency, missing green price for the high branch, invalid/nonpositive prices, and nonpositive final price.

~~~js
assert.deepEqual(calculateAutoListingPrice({
  blackKopecks: "10000",
  greenKopecks: "8000",
  adjustmentKopecks: "-500",
  currency: "RUB",
}), {
  currency: "RUB",
  branch: "BLACK_GTE_80",
  blackKopecks: "10000",
  greenKopecks: "8000",
  realPriceKopecks: "14500",
  adjustmentKopecks: "-500",
  finalPriceKopecks: "14000",
});
~~~

- [ ] **Step 2: Write failing configuration tests**

Assert ratio/resolution/quality/language allowlists; role ranges; derived total 6–13; exact default 1/3/1/1/1/1; specification count reduced to 0 when reliable product dimensions are absent; integer stock; signed adjustment; required target store/warehouse; and rejection of client accountId, strategy version, model credentials, or upload mode.

- [ ] **Step 3: Confirm RED**

~~~bash
node --test server/tests/auto-listing-pricing.test.mjs server/tests/auto-listing-contract.test.mjs
~~~

- [ ] **Step 4: Implement integer-only pricing**

Use exact rational arithmetic with named half-up rounding:

~~~js
const roundHalfUp = (numerator, denominator) =>
  (numerator + denominator / 2n) / denominator;

// black >= 8000: (black - green) * 225 / 100 + black
// black < 8000: black * 10000 / 10715
~~~

Return only decimal strings plus branch and evidence. Throw PRICE_CURRENCY_NOT_RUB, PRICE_INPUT_MISSING, PRICE_INPUT_INVALID, or PRICE_FINAL_NOT_POSITIVE. Never use floating-point money.

- [ ] **Step 5: Implement frozen configuration normalization**

Return a hashable JSON contract:

~~~js
{
  targetStoreId,
  targetWarehouseId,
  stock,
  priceAdjustmentKopecks,
  image: {
    ratio: "3:4",
    resolution: "1K",
    quality: "Medium",
    language: "ru",
    roles: {
      main: 1,
      sellingPoint: 3,
      detail: 1,
      scene: 1,
      specification: 1,
      infographic: 1,
    },
    total: 8,
  },
}
~~~

When hasReliableProductDimensions is false, force specification to 0, recompute total, and record PRODUCT_DIMENSIONS_UNAVAILABLE. Never substitute package dimensions.

- [ ] **Step 6: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-pricing.test.mjs server/tests/auto-listing-contract.test.mjs
git add server/auto-listing-pricing.mjs server/auto-listing-contract.mjs server/tests/auto-listing-pricing.test.mjs server/tests/auto-listing-contract.test.mjs
git commit -m "feat: define auto listing pricing and config"
~~~

---

## Task 3: Add Strategy Resolution and Closed State Transitions

**Files:**
- Create: server/ai-content-strategy.mjs
- Create: server/auto-listing-state-machine.mjs
- Create: server/tests/ai-content-strategy.test.mjs
- Create: server/tests/auto-listing-state-machine.test.mjs

**Interfaces:** resolveAiContentStrategy, nextAutoListingStatus, assertAutoListingTransition.

- [ ] **Step 1: Write failing strategy tests**

Verify exact category > closest ancestor > product style > BALANCED_DEFAULT. Return strategyId, strategyVersionId, ruleId, matchedBy, style, textDensityByRole, and evidence. Unknown categories continue with BALANCED_DEFAULT.

- [ ] **Step 2: Write failing transition tests**

Cover all intended transitions, retry recovery, cancellation, and forbidden jumps including CREATED to SUCCEEDED, SOURCE_READY to UPLOADING, and transitions out of SUCCEEDED/CANCELLED.

~~~js
assert.equal(nextAutoListingStatus("SOURCE_READY", "START_PLANNING"), "PLANNING");
assert.throws(
  () => nextAutoListingStatus("SOURCE_READY", "UPLOAD_ACCEPTED"),
  (error) => error.code === "AUTO_LISTING_TRANSITION_FORBIDDEN",
);
~~~

- [ ] **Step 3: Confirm RED**

~~~bash
node --test server/tests/ai-content-strategy.test.mjs server/tests/auto-listing-state-machine.test.mjs
~~~

- [ ] **Step 4: Implement pure resolution and explicit transition tables**

The strategy resolver receives published rules already loaded from storage; it does not query PostgreSQL, call AI, or browse Ozon. Preserve ancestor distance so the nearest matching ancestor wins. Support VISUAL_FIRST, PARAMETER_FIRST, DEMONSTRATION_FIRST, SPECIFICATION_FIRST, and BALANCED_DEFAULT.

Use events, not arbitrary target status. Required flow:

~~~text
CREATED --SOURCE_CAPTURED--> SOURCE_READY
SOURCE_READY --START_PLANNING--> PLANNING
PLANNING --PLAN_READY--> GENERATING
GENERATING --CONTENT_READY_FOR_REVIEW--> READY_FOR_REVIEW
GENERATING --CONTENT_READY_FOR_DIRECT_UPLOAD--> UPLOAD_QUEUED
READY_FOR_REVIEW --APPROVE_UPLOAD--> UPLOAD_QUEUED
UPLOAD_QUEUED --START_UPLOAD--> UPLOADING
UPLOADING --UPLOAD_SUCCEEDED--> SUCCEEDED
~~~

Allow explicit RETRYABLE_FAILURE, BLOCK, REGENERATE, RETRY_PLANNING, RETRY_GENERATION, RETRY_UPLOAD, and CANCEL events only from documented nonterminal states.

- [ ] **Step 5: Confirm GREEN and commit**

~~~bash
node --test server/tests/ai-content-strategy.test.mjs server/tests/auto-listing-state-machine.test.mjs
git add server/ai-content-strategy.mjs server/auto-listing-state-machine.mjs server/tests/ai-content-strategy.test.mjs server/tests/auto-listing-state-machine.test.mjs
git commit -m "feat: add auto listing strategy and states"
~~~

---

## Task 4: Create Immutable Snapshots and Scoped Job Transactions

**Files:**
- Create: server/auto-listing-source-snapshot.mjs
- Create: server/auto-listing-repository.mjs
- Create: server/auto-listing-service.mjs
- Create: server/tests/auto-listing-source-snapshot.test.mjs
- Create: server/tests/auto-listing-service.test.mjs
- Create: server/tests/auto-listing-postgres.integration.mjs

**Interfaces:** buildAutoListingSourceSnapshot, createAutoListingJob, getAutoListingJob, listAutoListingJobs.

- [ ] **Step 1: Write failing snapshot tests**

Use single- and multi-variant drafts. Assert preservation of SKU/offer ID, target category and dictionary IDs, attributes, weight/package dimensions, product-dimension evidence, black/green prices, media, rich content, raw-response reference, and variant relations. Assert deterministic SHA-256 hashing and stable failures for missing category/SKU, non-RUB price, and cross-account records.

- [ ] **Step 2: Write failing service tests with a fake repository**

Prove scoped idempotency, target-store ownership, active-FBS validation through assertListingStockSelectionEligible, frozen config/strategy references, CREATED and SOURCE_READY events, and item isolation: one invalid item becomes BLOCKED without discarding valid siblings.

- [ ] **Step 3: Confirm RED**

~~~bash
node --test server/tests/auto-listing-source-snapshot.test.mjs server/tests/auto-listing-service.test.mjs
~~~

- [ ] **Step 4: Implement the canonical snapshot**

Reuse current collect-item/product-draft normalization. Do not re-scrape or reinterpret facts. Store:

~~~js
{
  identity,
  source,
  targetCategory,
  attributes,
  logistics,
  productMeasurements,
  priceEvidence,
  variants,
  media,
  richContent,
  rawEvidence,
}
~~~

- [ ] **Step 5: Implement repository transactions and optimistic versions**

Every repository method requires accountId. Job, snapshots, items, initial events, and idempotency reservation commit in one transaction. Same-account unique conflicts return the existing job. State updates require id, account_id, and expected status_version; zero rows produce AUTO_LISTING_VERSION_CONFLICT or scoped NOT_FOUND.

- [ ] **Step 6: Implement the orchestration service**

It must: assert TENANT_OPERATE; load sources under actor.id; validate target store and active FBS warehouse; normalize/hash config; freeze current published strategy version; calculate price/build snapshots; create valid SOURCE_READY and invalid BLOCKED siblings; return a safe DTO without raw payloads or credentials.

- [ ] **Step 7: Add PostgreSQL integration coverage**

Prove rollback, idempotency by account, snapshot immutability, stale-version rejection, and event ordering. Gate only this suite with AUTO_LISTING_POSTGRES_TESTS=1; unit coverage stays always-on.

- [ ] **Step 8: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-source-snapshot.test.mjs server/tests/auto-listing-service.test.mjs
AUTO_LISTING_POSTGRES_TESTS=1 node --test server/tests/auto-listing-postgres.integration.mjs
git add server/auto-listing-source-snapshot.mjs server/auto-listing-repository.mjs server/auto-listing-service.mjs server/tests/auto-listing-source-snapshot.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-postgres.integration.mjs
git commit -m "feat: create immutable auto listing jobs"
~~~

---

## Task 5: Add Permissions, Runtime Composition, and Read Contracts

**Files:**
- Modify: server/permissions.mjs
- Create: server/auto-listing-runtime.mjs
- Create: server/auto-listing-routes.mjs
- Modify: server/index.mjs
- Modify: server/runtime-config.mjs
- Create: server/tests/auto-listing-routes.test.mjs
- Modify: server/tests/module-boundaries.test.mjs

**Interfaces:** task create/read routes, admin-only strategy configuration, AUTO_LISTING_ENABLED.

- [ ] **Step 1: Write failing route/permission tests**

Assert 401 unauthenticated, ordinary users can access only their own tasks, foreign store/account input is rejected, admins alone have AI_CONTENT_MANAGE, disabled feature creates nothing, and DTOs never expose raw responses, sub2api keys, secrets, or cross-account data.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-routes.test.mjs
~~~

- [ ] **Step 3: Add AI_CONTENT_MANAGE and focused runtime wiring**

Add ai-content.manage for admin only. auto-listing-runtime.mjs composes dependencies once. auto-listing-routes.mjs parses HTTP and delegates; it contains no SQL, AI, or Ozon implementation. server/index.mjs receives only a narrow import and dispatch call.

- [ ] **Step 4: Implement the foundation routes**

~~~text
POST /auto-listing/jobs/from-collect-box
GET  /auto-listing/jobs
GET  /auto-listing/jobs/:jobId
~~~

Use safe envelopes with code, user-safe message, correlationId, and item details on errors. Excel creation is added in plan 3 after parsing exists.

- [ ] **Step 5: Add feature configuration**

AUTO_LISTING_ENABLED defaults off. Production foundation reads do not require sub2api yet. Do not add an arbitrary gateway-key length rule; later generation startup checks presence and never logs the value.

- [ ] **Step 6: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-routes.test.mjs server/tests/module-boundaries.test.mjs
git add server/permissions.mjs server/auto-listing-runtime.mjs server/auto-listing-routes.mjs server/index.mjs server/runtime-config.mjs server/tests/auto-listing-routes.test.mjs server/tests/module-boundaries.test.mjs
git commit -m "feat: expose auto listing foundation"
~~~

---

## Plan 1 Verification Gate

- [ ] Run always-on foundation tests:

~~~bash
node --test server/tests/auto-listing-foundation-migration.test.mjs server/tests/auto-listing-pricing.test.mjs server/tests/auto-listing-contract.test.mjs server/tests/ai-content-strategy.test.mjs server/tests/auto-listing-state-machine.test.mjs server/tests/auto-listing-source-snapshot.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-routes.test.mjs server/tests/module-boundaries.test.mjs
~~~

- [ ] Run configured PostgreSQL coverage without using production data:

~~~bash
AUTO_LISTING_POSTGRES_TESTS=1 node --test server/tests/auto-listing-postgres.integration.mjs
~~~

- [ ] Regress current listing/store boundaries:

~~~bash
node --test server/tests/listing-warehouse-eligibility.test.mjs server/tests/listing-pipeline-v3.integration.mjs server/tests/account-store-isolation.test.mjs
~~~

- [ ] Rollback is runtime-only: set AUTO_LISTING_ENABLED=0. Migration 026 remains dormant and retains task history; do not delete tables during rollback.

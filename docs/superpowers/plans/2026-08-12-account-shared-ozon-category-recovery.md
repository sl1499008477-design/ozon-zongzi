# Account-Shared Ozon Category Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve reliable source Ozon category evidence during collection, reuse one account-scoped category result across that account's stores, and perform at most one safe automatic category repair only after a confirmed category-only import failure with zero created product.

**Architecture:** Replace the store-scoped category resolver with two explicit ports: immutable per-collection source evidence and versioned account-shared category state. Freeze the selected evidence/version into every new auto-listing source snapshot, keep Ozon import results as closed structured evidence, and let a focused recovery orchestrator create one append-only corrected-item attempt inside the existing submission job. The worker reconciles the original task/offer before any retry, reuses frozen content and media, and never treats natural-language third-party text as authority. Ordinary task lists rank the newest item per `(sourceRecordId, targetStoreId)` without deleting history and project the real job creation time.

**Tech Stack:** Node.js ESM, PostgreSQL 16+, React 19, Ant Design, Node's built-in test runner, pnpm/Vite, loopback fake Ozon transport, disposable Docker PostgreSQL.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-12-account-shared-ozon-category-recovery-design.md` as the category source of truth. The store-scoped category sections of the older design and plan are obsolete.
- Stop the old category worker, collection category mutations, auto-listing creation, upload worker, and listing worker before applying migration 063. This is a maintenance-window release, not a rolling mixed-version deployment.
- Verify a restorable pre-upgrade database backup before migration 063. Because migration 063 drops old store-scoped records, code-only rollback is forbidden after that point.
- New shared rows may be constructed only from current collection source evidence or new manual confirmations. Never copy `collect_category_resolutions.target_*`, `credential_store_id`, old matching method, or old failure state into the new tables.
- Keep historical `audit_events`, auto-listing jobs/items/events, submission jobs/events, and raw collection evidence. They are traceability data, not inputs to current category decisions.
- Every category read/write carries `accountId`. Store credentials may transport Ozon taxonomy/read/write calls, but `storeId` is not part of the category identity or shared-result unique key.
- No automatic category candidate becomes authoritative without both positive `description_category_id` and `type_id`. Missing source IDs require read-only product lookup; unresolved candidates require an administrator confirmation.
- Automatic repair requires a terminal failed import, a versioned closed structured category-error rule, zero returned `product_id`, an exact offer lookup proving absence, and no existing recovery attempt for that business operation.
- Unknown, ambiguous, in-progress, response-loss, authentication, throttling, brand, certificate, currency, warehouse, stock, or ordinary attribute errors never trigger a category retry.
- The recovery attempt may rebuild category IDs and category-required attributes only. It reuses the immutable original content, offer IDs, images, prices, currency, store, warehouse, and stocks.
- No real Ozon write, paid AI call, production database, or production disaster-recovery action is permitted during automated implementation or verification.
- Use `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` for Node commands when `node` is not on `PATH`; use the repository lockfile through Corepack for pnpm commands.

---

## Task 1: Replace the store-scoped database contract in one forward-only upgrade

**Files:**

- Create: `server/db/migrations/063_account_shared_ozon_categories.sql`
- Create: `server/tests/account-shared-ozon-category-migration.test.mjs`
- Create: `server/tests/account-shared-ozon-category-postgres.integration.test.mjs`
- Modify: `server/formal-persistence.mjs`
- Modify: `server/tests/account-deletion-relational.test.mjs`
- Reference: `server/db/migrations/003_listing_pipeline_v3.sql`
- Reference: `server/db/migrations/020_collector_ozon_enrichment.sql`
- Reference: `server/db/migrations/024_collect_category_resolution.sql`
- Reference: `server/db/migrations/025_collect_category_resolution_runtime_cursor.sql`

- [ ] **Step 1: Write the static migration RED tests.**

  Require migration 063 to create these closed contracts:

  ```text
  collect_ozon_category_source_evidence
  account_ozon_shared_categories
  account_ozon_shared_category_events
  ```

  Assert the source-evidence table has tenant-scoped foreign keys, immutable provenance, positive category IDs, a canonical ISO capture time, a SHA-256 raw-response hash/reference, and a unique source-version identity. Assert the shared table has the exact unique key:

  ```text
  account_id + source_description_category_id + source_type_id + taxonomy_scope
  ```

  Require shared statuses `ACTIVE | INVALIDATED | NEEDS_REVIEW`, sources `SOURCE_DIRECT | OZON_REFRESH | MANUAL`, a positive optimistic `version`, current category IDs, taxonomy fingerprint, safe failure code, timestamps, and tenant-scoped evidence linkage. Require append-only shared events and guarded current-row transitions.

  Assert the same migration drops `collect_category_resolutions` and `collect_category_resolution_runtime_cursors`, and does not delete or update `audit_events`, auto-listing history, submission history, raw payloads, product drafts, or enrichment cache.

- [ ] **Step 2: Write the real PostgreSQL migration RED tests.**

  Seed two accounts with source category evidence in canonical `product_drafts.data`/`collector_ozon_enrichment_cache.result_json`, plus conflicting old store-scoped rows. Assert after applying 063:

  - new evidence/shared rows come from source evidence only;
  - the conflicting old target category never appears in a new shared row;
  - two stores in one account produce one shared signature;
  - the second account produces a separate row and cannot reference the first account's evidence;
  - missing source IDs produce no fabricated shared signature;
  - old tables no longer exist;
  - immutable audit and job/event counts are unchanged.

  Seed old JSON/local state as a separate unit fixture and assert the first new runtime load/write removes `collectCategoryResolutions` and `collectCategoryResolutionRuntimeCursors` atomically. It may reconstruct new state only from canonical collection source facts; old target matches are discarded.

  Add a preflight-failure fixture with malformed positive IDs, conflicting account ownership, or duplicate incompatible source facts. The whole migration must roll back, leaving old tables and rows intact and creating none of the new tables.

- [ ] **Step 3: Run RED.**

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test \
    server/tests/account-shared-ozon-category-migration.test.mjs \
    server/tests/account-deletion-relational.test.mjs
  ```

  Expected: failures because migration 063 and the new deletion order do not exist.

- [ ] **Step 4: Implement migration 063.**

  In one PostgreSQL transaction:

  1. Fail closed on malformed/ambiguous authoritative source facts.
  2. Create the three new tables, composite account-scoped unique keys/FKs, guarded transition functions, append-only triggers, and due/read indexes.
  3. Extract evidence only from explicit canonical source-category paths in current drafts/enrichment results. Use numeric checks before casting; do not guess IDs from path labels.
  4. Insert one `SOURCE_DIRECT/ACTIVE` shared row per distinct valid source signature with current IDs equal to the source IDs.
  5. Insert append-only `MIGRATED_SOURCE_DIRECT` events containing only IDs, versions, hashes, provenance, and timestamps.
  6. Validate row counts, tenant ownership, signature uniqueness, and evidence linkage.
  7. Drop both old category tables. Do not rename them or retain compatibility views.

  Add privacy/account-cleanup exceptions only for exact parent deletion, matching the repository's existing controlled cleanup style. Ordinary direct UPDATE/DELETE of evidence/events remains `23514`.

- [ ] **Step 5: Update formal account cleanup.**

  Replace the old `collect_category_resolutions` delete with the precise new current/evidence deletion order needed by the parent-account cleanup. Preserve append-only restrictions outside the controlled parent-removal path and return explicit new deletion counts.

- [ ] **Step 6: Run GREEN with a disposable PostgreSQL 16 instance.**

  Apply migrations 001 through 063 serially in a random loopback, no-volume database, then run:

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test --test-concurrency=1 \
    server/tests/account-shared-ozon-category-migration.test.mjs \
    server/tests/account-shared-ozon-category-postgres.integration.test.mjs \
    server/tests/account-deletion-relational.test.mjs
  ```

  Expected: zero failures and zero PostgreSQL skips.

- [ ] **Step 7: Commit the migration boundary.**

  ```bash
  git add server/db/migrations/063_account_shared_ozon_categories.sql \
    server/tests/account-shared-ozon-category-migration.test.mjs \
    server/tests/account-shared-ozon-category-postgres.integration.test.mjs \
    server/formal-persistence.mjs server/tests/account-deletion-relational.test.mjs
  git commit -m "feat(categories): replace store category records"
  ```

---

## Task 2: Implement immutable source evidence and account-shared category repositories

**Files:**

- Create: `server/account-shared-ozon-category-contract.mjs`
- Create: `server/account-shared-ozon-category-repository.mjs`
- Create: `server/ozon-taxonomy-category-policy.mjs`
- Create: `server/tests/account-shared-ozon-category-contract.test.mjs`
- Create: `server/tests/account-shared-ozon-category-repository.test.mjs`
- Create: `server/tests/ozon-taxonomy-category-policy.test.mjs`
- Modify: `server/module-import-boundary.mjs`
- Modify: `server/tests/module-boundaries.test.mjs`
- Modify: `server/tests/module-import-boundary.test.mjs`

- [ ] **Step 1: Define closed input/output contracts in tests.**

  The contract module must export exact constructors/verifiers for:

  ```js
  sourceCategoryEvidence({
    accountId, collectItemId, sourceVersion, productDraftId, productDraftVersion,
    ozonProductId, sourceSku, taxonomyScope,
    sourceDescriptionCategoryId, sourceTypeId, normalizedPath,
    attributeSummary, provenance, capturedAt, rawResponseRef, rawResponseHash,
  })

  sharedCategorySelection({
    accountId, sourceDescriptionCategoryId, sourceTypeId, taxonomyScope,
    currentDescriptionCategoryId, currentTypeId, status, source,
    taxonomyFingerprint, version, evidenceId, validatedAt,
  })
  ```

  Reject unknown keys, accessors, proxies, cycles, dangerous object keys, non-canonical timestamps, oversized arrays/text, invalid hashes, missing positive IDs, and cross-account nested identities. Return deep-frozen plain data.

  Move the still-valid pure taxonomy operations (`OZON:DEFAULT`, deterministic fingerprinting, enabled-leaf traversal, and unique exact-type result) into `ozon-taxonomy-category-policy.mjs`. Rename old `MATCHED` output to the new `UNIQUE_MATCH` contract and reject duplicate/disabled/ambiguous candidates. This module has no account, store, credential, database, or network access.

- [ ] **Step 2: Write repository RED tests.**

  Require this minimal port:

  ```js
  {
    recordSourceEvidence(input),
    readCurrentEvidence({ accountId, collectItemIds }),
    readSharedForEvidence({ accountId, evidenceIds }),
    confirmManualCategory(input),
    invalidateSharedCategory(input),
    activateRefreshedCategory(input),
    markSharedNeedsReview(input),
  }
  ```

  Test exact account predicates, idempotent evidence replay, conflicting source-version rejection, optimistic-version conflicts, account isolation, atomic event insertion, and zero store fields in SQL/DTOs. Confirm that `MANUAL` confirmation writes a new provenance-correct evidence version before activating the shared record; it must not rewrite a captured source fact.

- [ ] **Step 3: Run RED.**

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test \
    server/tests/account-shared-ozon-category-contract.test.mjs \
    server/tests/account-shared-ozon-category-repository.test.mjs \
    server/tests/ozon-taxonomy-category-policy.test.mjs
  ```

- [ ] **Step 4: Implement the contract and PostgreSQL/JSON repositories.**

  Use focused PostgreSQL statements and a JSON repository with the same port semantics. The JSON repository must delete `state.collectCategoryResolutions` on its first committed write/load migration and use new names such as `collectOzonCategorySourceEvidence`, `accountOzonSharedCategories`, and `accountOzonSharedCategoryEvents`. Do not preserve an old compatibility array.

  Keep mutable shared state and immutable evidence/events separate. All shared-state transitions must compare `expectedVersion` and append the corresponding event in the same transaction/state commit.

- [ ] **Step 5: Update repository import boundaries.**

  Permit only the category runtime/composition and approved services to import the repository. Retire the old named-repository exception rather than opening a generic repository import path.

- [ ] **Step 6: Run focused and real-PG GREEN.**

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test \
    server/tests/account-shared-ozon-category-contract.test.mjs \
    server/tests/account-shared-ozon-category-repository.test.mjs \
    server/tests/ozon-taxonomy-category-policy.test.mjs \
    server/tests/module-boundaries.test.mjs \
    server/tests/module-import-boundary.test.mjs
  ```

  Re-run the Task 1 PostgreSQL integration against the repository port and require zero skip.

- [ ] **Step 7: Commit.**

  ```bash
  git add server/account-shared-ozon-category-contract.mjs \
    server/account-shared-ozon-category-repository.mjs \
    server/ozon-taxonomy-category-policy.mjs \
    server/tests/account-shared-ozon-category-contract.test.mjs \
    server/tests/account-shared-ozon-category-repository.test.mjs \
    server/tests/ozon-taxonomy-category-policy.test.mjs \
    server/module-import-boundary.mjs server/tests/module-boundaries.test.mjs \
    server/tests/module-import-boundary.test.mjs
  git commit -m "feat(categories): add account shared category repository"
  ```

---

## Task 3: Record categories during collection, perform read-only source lookup, and require manual confirmation

**Files:**

- Create: `server/account-shared-ozon-category-service.mjs`
- Create: `server/account-shared-ozon-category-runtime.mjs`
- Create: `server/account-shared-ozon-category-composition.mjs`
- Create: `server/ozon-source-category-lookup.mjs`
- Create: `server/tests/account-shared-ozon-category-service.test.mjs`
- Create: `server/tests/account-shared-ozon-category-runtime.test.mjs`
- Create: `server/tests/ozon-source-category-lookup.test.mjs`
- Modify: `server/collector-ozon-enrichment-runtime.mjs`
- Modify: `server/collector-ozon-enrichment-service.mjs`
- Modify: `server/account-scoped-collection-routes.mjs`
- Modify: `server/collection-public-shape.mjs`
- Modify: `server/ozon-category-service.mjs`
- Modify: `server/index.mjs`
- Modify: `server/tests/collector-ozon-enrichment-runtime.test.mjs`
- Modify: `server/tests/collector-ozon-enrichment-service.test.mjs`
- Modify: `server/tests/collector-routes.test.mjs`
- Modify: `server/tests/collect-category-auto-resolution-seams.test.mjs`
- Modify: `server/tests/collect-category-auto-resolution.integration.mjs`
- Modify: `server/tests/support/collect-category-auto-resolution-seams.worker.mjs`
- Modify: `server/tests/support/collect-category-auto-resolution.worker.mjs`
- Delete after replacement: `server/collect-category-resolution-policy.mjs`
- Delete after replacement: `server/collect-category-resolution-repository.mjs`
- Delete after replacement: `server/collect-category-resolution-service.mjs`
- Delete after replacement: `server/collect-category-resolution-runtime.mjs`
- Delete after replacement: `server/collect-category-auto-resolution-composition.mjs`
- Delete after replacement: `server/tests/collect-category-resolution-policy.test.mjs`
- Delete after replacement: `server/tests/collect-category-resolution-contract.test.mjs`
- Delete after replacement: `server/tests/collect-category-resolution-repository.test.mjs`
- Delete after replacement: `server/tests/collect-category-resolution-service.test.mjs`
- Delete after replacement: `server/tests/collect-category-resolution-runtime.test.mjs`
- Delete after replacement: `server/tests/collect-category-resolution-migration.test.mjs`

- [ ] **Step 1: Write collection evidence RED tests.**

  Prove `normalizeOzonAgentResult()` source evidence is written atomically with the collection result, including source version, product/SKU lookup identity, both category IDs, path, bounded safe attributes, capture time, and raw hash/ref. Replaying the same source version must not append duplicates; a changed source version appends a new evidence row.

  Prove two stores in one account read the same shared category and a second account cannot read it. The public collection DTO must expose only:

  ```js
  {
    status, taxonomyScope,
    sourceDescriptionCategoryId, sourceTypeId,
    currentDescriptionCategoryId, currentTypeId,
    source, version, validatedAt,
    action, message,
  }
  ```

  It must not expose store ID, raw response, arbitrary error text, attributes, hashes, or credentials.

- [ ] **Step 2: Write missing-source lookup RED tests.**

  Implement a read-only lookup port that tries stable identities in order:

  1. exact Ozon product ID;
  2. exact source SKU/offer ID;
  3. no broader fuzzy product search.

  Use the existing seller transport with `/v2/product/info` for exact lookup and `/v4/product/info/attributes` only when needed to obtain the returned product's category facts. Validate that the returned product/offer identity equals the request and both category IDs are positive before recording `OZON_READ_LOOKUP` evidence. Authentication, absent product, mismatch, oversized response, unknown shape, and network ambiguity produce a safe unresolved result and zero category write.

- [ ] **Step 3: Write manual confirmation and authorization RED tests.**

  Add a dedicated administrator mutation contract rather than trusting a patched draft:

  ```http
  POST /ozon/category-confirmations
  {
    "collectItemId": "collect-id",
    "expectedSourceVersion": "source-version",
    "descriptionCategoryId": 17000000,
    "typeId": 970000000,
    "taxonomyScope": "OZON:DEFAULT",
    "idempotencyKey": "category-confirmation-id",
    "correlationId": "correlation-id"
  }
  ```

  Require backend administrator permission, exact account/item/version scope, replay equality, conflict rejection, and append-only actor/time evidence. Ordinary users, stale source versions, cross-account items, extra fields, and mismatched replays must write nothing.

  Candidate reads may return a closed ranked list generated from title/source attributes/path/images, but candidates never call this confirmation mutation automatically.

- [ ] **Step 4: Run RED, then implement the service/runtime/composition.**

  The service order for a new collection result is:

  ```text
  validate account/item/source version
  -> record immutable source evidence
  -> create/reuse SOURCE_DIRECT shared state
  -> publish safe collection projection
  ```

  For missing IDs, call the exact read-only lookup before returning `NEEDS_REVIEW`. Do not start paid AI or an Ozon product write.

- [ ] **Step 5: Rewire all entry points and remove old modules.**

  Replace the old `categoryResolutionPort`/operating-store wake behavior in `server/index.mjs`, collection routes, enrichment composition, and subprocess/seam fixtures. Repoint `ozon-category-service.mjs` to the new pure taxonomy policy. Remove `saveManualFromDraft`; PATCHing a collection draft must not create category authority. Remove old per-store policy/repository/service/runtime/composition modules, old tests that only assert the deleted contract, runtime timers, cursor use, store notifier, and obsolete module-boundary exceptions. Port shared behavior coverage into the new account-shared tests before deleting the old test files.

- [ ] **Step 6: Run GREEN.**

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test \
    server/tests/account-shared-ozon-category-service.test.mjs \
    server/tests/account-shared-ozon-category-runtime.test.mjs \
    server/tests/ozon-source-category-lookup.test.mjs \
    server/tests/collector-ozon-enrichment-runtime.test.mjs \
    server/tests/collector-ozon-enrichment-service.test.mjs \
    server/tests/collector-routes.test.mjs \
    server/tests/collection-public-shape.test.mjs
  ```

- [ ] **Step 7: Commit.**

  ```bash
  git add \
    server/account-shared-ozon-category-service.mjs \
    server/account-shared-ozon-category-runtime.mjs \
    server/account-shared-ozon-category-composition.mjs \
    server/ozon-source-category-lookup.mjs \
    server/collector-ozon-enrichment-runtime.mjs \
    server/collector-ozon-enrichment-service.mjs \
    server/account-scoped-collection-routes.mjs \
    server/collection-public-shape.mjs \
    server/ozon-category-service.mjs \
    server/index.mjs \
    server/collect-category-resolution-policy.mjs \
    server/collect-category-resolution-repository.mjs \
    server/collect-category-resolution-service.mjs \
    server/collect-category-resolution-runtime.mjs \
    server/collect-category-auto-resolution-composition.mjs \
    server/tests/account-shared-ozon-category-service.test.mjs \
    server/tests/account-shared-ozon-category-runtime.test.mjs \
    server/tests/ozon-source-category-lookup.test.mjs \
    server/tests/collector-ozon-enrichment-runtime.test.mjs \
    server/tests/collector-ozon-enrichment-service.test.mjs \
    server/tests/collector-routes.test.mjs \
    server/tests/collect-category-auto-resolution-seams.test.mjs \
    server/tests/collect-category-auto-resolution.integration.mjs \
    server/tests/support/collect-category-auto-resolution-seams.worker.mjs \
    server/tests/support/collect-category-auto-resolution.worker.mjs \
    server/tests/collect-category-resolution-policy.test.mjs \
    server/tests/collect-category-resolution-contract.test.mjs \
    server/tests/collect-category-resolution-repository.test.mjs \
    server/tests/collect-category-resolution-service.test.mjs \
    server/tests/collect-category-resolution-runtime.test.mjs \
    server/tests/collect-category-resolution-migration.test.mjs
  git commit -m "feat(categories): capture and resolve shared source evidence"
  ```

  Inspect `git diff --cached --name-status` before committing. The explicit path list stages the intended deletions without sweeping unrelated server work into this commit.

---

## Task 4: Freeze account-shared category evidence into auto-listing source snapshots

**Files:**

- Modify: `server/auto-listing-source-snapshot.mjs`
- Modify: `server/auto-listing-repository.mjs`
- Modify: `server/auto-listing-service.mjs`
- Modify: `server/tests/auto-listing-source-snapshot.test.mjs`
- Modify: `server/tests/auto-listing-repository.test.mjs`
- Modify: `server/tests/auto-listing-service.test.mjs`
- Modify: `server/tests/auto-listing-postgres.integration.mjs`

- [ ] **Step 1: Write the V2 snapshot RED contract.**

  Keep the top-level `targetCategory` key for historical reader compatibility, but require all newly created snapshots to use:

  ```js
  targetCategory: {
    schemaVersion: "AUTO_LISTING_ACCOUNT_CATEGORY_V2",
    evidenceId: "category-evidence-id",
    sharedCategoryId: "shared-category-id",
    sharedCategoryVersion: 1,
    sourceDescriptionCategoryId: "17000000",
    sourceTypeId: "970000000",
    descriptionCategoryId: "17000000",
    typeId: "970000000",
    taxonomyScope: "OZON:DEFAULT",
    taxonomyFingerprint: "fingerprint-or-empty",
    provenance: "SOURCE_DIRECT"
  }
  ```

  V1 snapshots containing `targetStoreId` remain verifiable/readable for history, but new job creation must reject V1 category authority. V2 contains no store ID.

- [ ] **Step 2: Write source-loading and service-order RED tests.**

  `loadCollectSources({ accountId, collectItemIds })` must load current evidence plus the exact account-shared state. It must fail closed for absent, foreign, incomplete, `INVALIDATED`, `NEEDS_REVIEW`, stale-version, or taxonomy-mismatched selections. No target store participates in this query.

  Preserve service order:

  ```text
  replay check -> target store/currency -> shared category source -> warehouse/RFBS -> paid AI graph
  ```

  Missing/unconfirmed category must stop before paid AI, object storage, graph writes, or any Ozon product write.

- [ ] **Step 3: Run RED, implement V1/V2 verification and V2 creation.**

  Remove `captured.snapshot.targetCategory.targetStoreId === config.targetStoreId` checks from service/repository and replace them with exact account/evidence/shared-version checks. Keep target store validation elsewhere for credentials, currency, warehouse, inventory, and Ozon write scope.

- [ ] **Step 4: Add real-PG concurrency tests.**

  Prove a shared category version change between source read and graph commit causes a version conflict/blocked item and zero paid/Ozon side effect. Prove the same account's second store reuses the same evidence/version, while another account cannot.

- [ ] **Step 5: Run GREEN and commit.**

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test \
    server/tests/auto-listing-source-snapshot.test.mjs \
    server/tests/auto-listing-repository.test.mjs \
    server/tests/auto-listing-service.test.mjs
  git add server/auto-listing-source-snapshot.mjs server/auto-listing-repository.mjs \
    server/auto-listing-service.mjs server/tests/auto-listing-source-snapshot.test.mjs \
    server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-service.test.mjs \
    server/tests/auto-listing-postgres.integration.mjs
  git commit -m "feat(auto-listing): freeze shared category evidence"
  ```

---

## Task 5: Build listing items from the frozen source/shared category without per-store matching

**Files:**

- Create: `server/ozon-category-item-rebuilder.mjs`
- Create: `server/tests/ozon-category-item-rebuilder.test.mjs`
- Modify: `server/auto-listing-listing-base-preparer.mjs`
- Modify: `server/ozon-import-normalizer.mjs`
- Modify: `server/tests/auto-listing-listing-base-preparer.test.mjs`
- Modify: `server/tests/ozon-import-normalizer.test.mjs`
- Modify: `server/ozon-category-service.mjs`

- [ ] **Step 1: Write direct-category preparation RED tests.**

  For a complete V2 frozen category, assert the preparer sends those exact IDs into normalization and never performs a store-specific category match. The selected operating store credential may still call Ozon taxonomy/attribute/dictionary read endpoints, but its store ID must not enter the category match key, evidence, or result.

  Test the same source/shared category through two stores with different currencies and credentials: category IDs remain equal, while price/currency/credential scopes remain store-specific.

- [ ] **Step 2: Define the pure category rebuild contract.**

  `rebuildOzonItemsForCategory()` receives immutable original items, source evidence attributes, the replacement category, and current category metadata. It may change only:

  ```text
  description_category_id
  type_id
  attributes whose definition belongs to the replacement category
  ```

  It must preserve offer/SKU, name/content, images, rich content, price/currency, VAT, dimensions, weight, barcodes, and variant count. It succeeds only when the category is a unique match and every required attribute is complete with valid dictionary values.

- [ ] **Step 3: Run RED, implement `SOURCE_CATEGORY_STRICT`.**

  Replace `categoryMatchPolicy: "TARGET_STORE_EXACT"` with a closed direct-source policy. Do not add a fallback fuzzy match during normal preparation. Return stable safe failures:

  ```text
  AUTO_LISTING_SOURCE_CATEGORY_REQUIRED
  AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE
  AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED
  ```

- [ ] **Step 4: Run GREEN and commit.**

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test \
    server/tests/ozon-category-item-rebuilder.test.mjs \
    server/tests/auto-listing-listing-base-preparer.test.mjs \
    server/tests/ozon-import-normalizer.test.mjs \
    server/tests/ozon-category-service.test.mjs
  git add server/ozon-category-item-rebuilder.mjs server/auto-listing-listing-base-preparer.mjs \
    server/ozon-import-normalizer.mjs server/ozon-category-service.mjs \
    server/tests/ozon-category-item-rebuilder.test.mjs \
    server/tests/auto-listing-listing-base-preparer.test.mjs \
    server/tests/ozon-import-normalizer.test.mjs
  git commit -m "feat(auto-listing): prepare from shared source category"
  ```

---

## Task 6: Normalize Ozon import failures into closed structured category evidence

**Files:**

- Create: `server/ozon-category-import-error-policy.mjs`
- Create: `server/tests/ozon-category-import-error-policy.test.mjs`
- Modify: `server/ozon-import-status.mjs`
- Modify: `server/tests/ozon-import-status-v3.test.mjs`
- Modify: `server/listing-pipeline.mjs`
- Modify: `server/tests/listing-pipeline-v3.integration.mjs`

- [ ] **Step 1: Capture and pin authoritative structured fixtures before production rules.**

  Inspect the current official Ozon OpenAPI schema and sanitized repository-owned fixtures for `/v1/product/import/info`. Record only documented structural fields. Add a versioned closed policy with exact combinations of stable `code`, `field`, optional `attribute_id`, terminal `state`, and `product_id` absence. Do not add a wildcard, regex over message text, or guessed code.

  If no authoritative category-invalid code/field fixture is available, production policy version 1 remains empty and automatic recovery stays disabled; manual recovery still ships. The feature cannot be reported as production-auto-recovery verified until at least one authoritative structured fixture is added and tested.

- [ ] **Step 2: Write classifier RED tests.**

  Require these classifications:

  ```text
  SUCCEEDED
  CHECKING
  EXPLICIT_CATEGORY_FAILURE
  OTHER_TERMINAL_FAILURE
  UNKNOWN_RESULT
  ```

  Only an allowlisted category code/field combination, terminal failure, empty product ID, and exact offer identity may yield `EXPLICIT_CATEGORY_FAILURE`. Unknown codes, category words in messages, ordinary attribute failures, partial success, product IDs, processing states, malformed response, accessors/proxies, and oversized data must never do so.

- [ ] **Step 3: Replace raw response authority with a safe projection.**

  Extend normalized item results with a closed `errorEvidence` value:

  ```js
  {
    schemaVersion: "OZON_IMPORT_ERROR_EVIDENCE_V1",
    policyVersion: 1,
    code: "allowlisted-code",
    field: "description_category_id",
    attributeId: null,
    state: "FAILED",
    offerId: "frozen-offer",
    productId: null,
    classification: "EXPLICIT_CATEGORY_FAILURE"
  }
  ```

  Store this safe evidence separately from the existing backend-restricted raw response. UI/routes never receive the raw response or arbitrary third-party message.

- [ ] **Step 4: Run RED/GREEN and commit.**

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test \
    server/tests/ozon-category-import-error-policy.test.mjs \
    server/tests/ozon-import-status-v3.test.mjs \
    server/tests/listing-pipeline-v3.integration.mjs
  git add server/ozon-category-import-error-policy.mjs server/ozon-import-status.mjs \
    server/listing-pipeline.mjs server/tests/ozon-category-import-error-policy.test.mjs \
    server/tests/ozon-import-status-v3.test.mjs server/tests/listing-pipeline-v3.integration.mjs
  git commit -m "feat(listing): classify structured category failures"
  ```

---

## Task 7: Persist one category-recovery attempt and coordinate product absence

**Files:**

- Create: `server/db/migrations/064_auto_listing_category_recovery.sql`
- Create: `server/auto-listing-category-recovery-postgres.mjs`
- Create: `server/auto-listing-category-recovery-service.mjs`
- Create: `server/ozon-offer-reconciliation.mjs`
- Create: `server/tests/auto-listing-category-recovery-migration.test.mjs`
- Create: `server/tests/auto-listing-category-recovery-postgres.integration.test.mjs`
- Create: `server/tests/auto-listing-category-recovery-service.test.mjs`
- Create: `server/tests/ozon-offer-reconciliation.test.mjs`

- [ ] **Step 1: Write migration RED tests for append-only recovery state.**

  Migration 064 creates:

  ```text
  submission_category_error_evidence
  submission_category_recovery_attempts
  ```

  Error evidence is append-only and binds account/job/snapshot/item/offer/original Ozon task plus the safe classifier projection. Recovery attempts bind the original immutable snapshot, source evidence, old shared category/version, triggering error evidence, corrected items hash, replacement shared category/version, original task ID, optional retry task ID, and status:

  ```text
  CLAIMED | MATCHED | RETRY_PENDING | RETRY_ACCEPTED | SUCCEEDED | NEEDS_REVIEW
  ```

  Enforce at most one recovery row per `(account_id, submission_job_id)`. Corrected items are immutable after `MATCHED`; task IDs cannot be replaced after first assignment. Direct UPDATE/DELETE outside allowed transitions is `23514`.

- [ ] **Step 2: Write offer-absence reconciliation RED tests.**

  `confirmOfferAbsent()` uses exact frozen offers with the operating store credential and `/v3/product/list` exact `filter.offer_id`. It returns only `ABSENT | PRESENT | UNKNOWN`. Any returned matching product/SKU, pagination ambiguity, response loss, authentication/throttle/5xx, malformed response, or identity mismatch returns `PRESENT` or `UNKNOWN`, never `ABSENT`.

- [ ] **Step 3: Write orchestrator RED tests.**

  Require this strict order:

  ```text
  lock/claim original terminal failure
  -> verify policy/evidence/zero product ID
  -> reconcile exact offers as ABSENT
  -> claim the only recovery attempt
  -> CAS invalidate old shared version
  -> read current taxonomy and produce one unique match
  -> rebuild all category-required attributes
  -> activate replacement shared version
  -> persist corrected immutable items/hash
  -> schedule the same submission job for one retry
  ```

  Every failure before the corrected-items commit produces zero product import. Match ambiguity, missing required attributes, stale shared version, cross-account evidence, second recovery request, or an existing/potential product moves the attempt/shared result to safe `NEEDS_REVIEW`/reconciliation without another write.

- [ ] **Step 4: Implement migration, repository, coordinator, and service.**

  The repository method exposed to the service should be one focused transaction port per state change, for example:

  ```js
  claimCategoryRecovery(input)
  saveCategoryRecoveryMatch(input)
  markCategoryRecoveryRetryAccepted(input)
  completeCategoryRecovery(input)
  requireCategoryRecoveryReview(input)
  ```

  Avoid a generic `updateRecovery()` method. Each port validates account/job/snapshot/offer/shared-version identity.

- [ ] **Step 5: Run focused and real-PG GREEN.**

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test --test-concurrency=1 \
    server/tests/auto-listing-category-recovery-migration.test.mjs \
    server/tests/auto-listing-category-recovery-postgres.integration.test.mjs \
    server/tests/auto-listing-category-recovery-service.test.mjs \
    server/tests/ozon-offer-reconciliation.test.mjs
  ```

- [ ] **Step 6: Commit.**

  ```bash
  git add server/db/migrations/064_auto_listing_category_recovery.sql \
    server/auto-listing-category-recovery-postgres.mjs \
    server/auto-listing-category-recovery-service.mjs server/ozon-offer-reconciliation.mjs \
    server/tests/auto-listing-category-recovery-migration.test.mjs \
    server/tests/auto-listing-category-recovery-postgres.integration.test.mjs \
    server/tests/auto-listing-category-recovery-service.test.mjs \
    server/tests/ozon-offer-reconciliation.test.mjs
  git commit -m "feat(listing): persist one category recovery attempt"
  ```

---

## Task 8: Integrate category recovery into the listing worker and auto-listing reconciliation

**Files:**

- Modify: `server/listing-worker.mjs`
- Modify: `server/listing-pipeline.mjs`
- Modify: `server/listing-submission-policy.mjs`
- Modify: `server/auto-listing-submission-reconciliation-postgres.mjs`
- Modify: `server/auto-listing-submission-reconciler.mjs`
- Modify: `server/auto-listing-upload-postgres.mjs`
- Create: `server/tests/listing-worker-category-recovery.test.mjs`
- Modify: `server/tests/listing-submission-policy.test.mjs`
- Modify: `server/tests/auto-listing-submission-reconciliation-postgres.integration.test.mjs`
- Modify: `server/tests/auto-listing-submission-reconciler.test.mjs`

- [ ] **Step 1: Write worker RED tests.**

  Cover these exact paths with injected closed ports:

  - first terminal allowlisted category failure + absent offers schedules one `RETRY_PENDING` category attempt;
  - retry submission reads `corrected_items` from the immutable recovery attempt, not mutable drafts/current category state;
  - original Ozon task ID remains in recovery evidence, retry task ID is recorded once, and the job checks only the current accepted retry task;
  - retry success continues existing PRE_STOCK/RFBS/stock flow;
  - second category failure becomes `NEEDS_REVIEW/FAILED` with zero third import;
  - response loss after either import goes to existing reconciliation and never creates another recovery attempt;
  - present/unknown offer lookup, product ID, partial success, non-category failure, and still-processing status produce zero category refresh.

- [ ] **Step 2: Add the minimal state transitions.**

  Permit `CHECKING -> RETRY_PENDING` only through the category-recovery transaction/event. Generic failures cannot use this transition. `loadSubmissionWorkV3()` returns `effectiveItems` equal to corrected immutable items only when an exact `MATCHED/RETRY_PENDING` recovery row belongs to the same account/job/snapshot; otherwise it returns the original snapshot items.

- [ ] **Step 3: Integrate reconciliation without replacing immutable upload links.**

  Keep the same submission job and auto-listing submission link. The recovery attempt is the child attempt identity; do not mutate `submission_snapshot.items`, replace `auto_listing_submission_links.submission_job_id`, or create a second paid AI/upload operation. On final retry outcome, the existing reconciler advances the original auto-listing item/link once and records recovery ID/category versions in safe audit metadata.

  The upload repository's terminal/replay projection must follow the same original submission job and expose only the safe recovery state. It must not reserve a new upload claim, republish assets, rerun paid AI, or reject an exact terminal replay merely because the category recovery used corrected immutable items.

- [ ] **Step 4: Run RED/GREEN.**

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test \
    server/tests/listing-worker-category-recovery.test.mjs \
    server/tests/listing-submission-policy.test.mjs \
    server/tests/auto-listing-submission-reconciler.test.mjs
  ```

  Then run the real PostgreSQL reconciliation test serially with zero skip.

- [ ] **Step 5: Commit.**

  ```bash
  git add server/listing-worker.mjs server/listing-pipeline.mjs \
    server/listing-submission-policy.mjs \
    server/auto-listing-upload-postgres.mjs \
    server/auto-listing-submission-reconciliation-postgres.mjs \
    server/auto-listing-submission-reconciler.mjs \
    server/tests/listing-worker-category-recovery.test.mjs \
    server/tests/listing-submission-policy.test.mjs \
    server/tests/auto-listing-submission-reconciliation-postgres.integration.test.mjs \
    server/tests/auto-listing-submission-reconciler.test.mjs
  git commit -m "feat(listing): recover explicit category failures once"
  ```

---

## Task 9: Replace store-category UI, show recovery safely, and collapse ordinary task rows

**Files:**

- Modify: `app/src/category-readiness.js`
- Modify: `app/src/collect-category-resolution-view.js`
- Modify: `app/src/auto-listing-view.js`
- Modify: `app/src/App.jsx`
- Modify: `app/src/AutoListingPage.jsx`
- Modify: `app/tests/category-readiness.test.mjs`
- Modify: `app/tests/collect-category-resolution-view.test.mjs`
- Modify: `app/tests/collection-category-resolution-app-contract.test.mjs`
- Modify: `app/tests/auto-listing-view.test.mjs`
- Modify: `app/tests/auto-listing-page-contract.test.mjs`
- Modify: `server/auto-listing-repository.mjs`
- Modify: `server/tests/auto-listing-repository.test.mjs`
- Modify: `server/tests/auto-listing-postgres.integration.mjs`

- [ ] **Step 1: Write account-shared category presentation RED tests.**

  Remove store-matching helpers and require a pure account-shared projection. Use fixed safe states/copy:

  ```text
  使用采集类目准备上架
  Ozon 类目已失效，正在自动修复
  类目已重新匹配，正在继续上架
  无法确认商品类目，请人工选择
  Ozon 返回结果不明确，正在核对原任务
  ```

  Remove “目标店铺类目”“按当前店铺匹配”“等待经营店铺类目” language. Category candidate selection is clearly marked as requiring administrator confirmation. Unknown backend/third-party text maps to the generic safe message.

- [ ] **Step 2: Write latest-row and creation-time RED tests.**

  `listJobs({ accountId, limit })` must rank item rows before the limit:

  ```sql
  ROW_NUMBER() OVER (
    PARTITION BY snapshot.source_record_id, item.target_store_id
    ORDER BY job.created_at DESC, job.id DESC, item.id ASC
  )
  ```

  Return only rank 1 to the ordinary list, keep one row per other store, and preserve all historical rows for `getJob(jobId)`, audit, and recovery. If one selected job has other sibling items, filter list-only items and item-scoped events to the ranked item IDs.

  Export `autoListingTaskRows(jobs)` to add only the owning `jobId` and canonical `jobCreatedAt`. The table adds `创建时间` using the real job timestamp and displays the safe store label already available from current store data.

- [ ] **Step 3: Run RED, implement backend ranking and pure UI models.**

  Do not delete old jobs or update them as “covered.” Apply `limit` after ranking. Invalid timestamps display `—`; no current-time fallback.

- [ ] **Step 4: Update collection and auto-listing pages.**

  Collection edit/preview reads the account-shared state. Manual selection calls the dedicated confirmation route with idempotency, correlation, and expected source version. Auto-listing rows render recovery states and creation time but do not infer authority or retry eligibility from status; actions remain server-owned.

- [ ] **Step 5: Run frontend/backend GREEN and build.**

  ```bash
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test \
    app/tests/category-readiness.test.mjs \
    app/tests/collect-category-resolution-view.test.mjs \
    app/tests/collection-category-resolution-app-contract.test.mjs \
    app/tests/auto-listing-view.test.mjs \
    app/tests/auto-listing-page-contract.test.mjs \
    server/tests/auto-listing-repository.test.mjs
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/corepack" pnpm --dir app build
  ```

- [ ] **Step 6: Commit.**

  ```bash
  git add app/src/category-readiness.js app/src/collect-category-resolution-view.js \
    app/src/auto-listing-view.js app/src/App.jsx app/src/AutoListingPage.jsx \
    app/tests/category-readiness.test.mjs app/tests/collect-category-resolution-view.test.mjs \
    app/tests/collection-category-resolution-app-contract.test.mjs \
    app/tests/auto-listing-view.test.mjs app/tests/auto-listing-page-contract.test.mjs \
    server/auto-listing-repository.mjs server/tests/auto-listing-repository.test.mjs \
    server/tests/auto-listing-postgres.integration.mjs
  git commit -m "feat(ui): show shared category recovery and latest tasks"
  ```

---

## Task 10: Prove migration, normal listing, one repair, ambiguity, and rollback boundaries end to end

**Files:**

- Create: `server/tests/account-shared-category-recovery-e2e.test.mjs`
- Create: `docs/operations/account-shared-ozon-category-migration.md`
- Create: `docs/verification/2026-08-12-account-shared-ozon-category-recovery.md`
- Modify: `package.json`
- Modify only if needed for local commands: `README.md`

- [ ] **Step 1: Build a real-PG, loopback-fake-Ozon E2E.**

  Apply migrations 001 through 064 to a disposable PostgreSQL 16 database with a random loopback port and no volume. Exercise production collection, shared category repository, auto-listing creation, listing-base preparation, submission pipeline, worker, recovery service, and reconciliation ports.

  The fake Ozon test must prove:

  1. complete source category creates one job without store category matching;
  2. two stores in one account reuse one shared row;
  3. cross-account reads/writes fail before transport;
  4. missing source uses exact read-only product lookup; unresolved lookup stops before paid AI/product import;
  5. manual confirmation requires admin and then becomes reusable account-shared state;
  6. first import returns an authoritative structured category-invalid terminal result with no product ID;
  7. exact offer lookup proves absence;
  8. taxonomy refresh uniquely rematches and rebuilds all required attributes;
  9. exactly one corrected `/v3/product/import` occurs, using the same frozen offers/content/images/prices/store/warehouse/stocks and a new recovery attempt ID;
  10. retry success continues `/v2/products/stocks` once;
  11. second category failure, ambiguous match, missing required attribute, present/unknown offer, response loss, authentication, throttling, brand, currency, warehouse, and stock failures cause zero extra product import;
  12. repeated queue delivery, worker restart, and replay do not add evidence, recovery attempts, imports, or stocks.

- [ ] **Step 2: Prove destructive migration behavior separately.**

  In an upgrade-shaped database containing old 024/025 tables, valid source facts, old conflicting store matches, audit history, and current jobs:

  - migration 063 creates only source-derived shared rows;
  - old tables are gone;
  - audit/job history remains;
  - a forced preflight error rolls the transaction back completely;
  - restoring a database dump into a second disposable database makes the old schema/data readable by the pre-upgrade commit.

  Do not perform this restore test against the developer or production database.

- [ ] **Step 3: Run the focused regression matrix.**

  Include all Tasks 1–9 tests plus adjacent suites for collection, category services, source snapshots, currency, warehouse/RFBS, upload, listing pipeline/worker/reconciliation, tenant isolation, formal persistence, routes, and module boundaries. Run PostgreSQL suites serially and require zero skip for every new PG test.

- [ ] **Step 4: Run syntax, diff, build, and bounded project verification.**

  ```bash
  git diff --check
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --check server/account-shared-ozon-category-service.mjs
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --check server/auto-listing-category-recovery-service.mjs
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --check server/listing-worker.mjs
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/corepack" pnpm --dir app build
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/corepack" pnpm verify
  ```

  Bound a hanging full verify, preserve its exact output, and never convert an environment block or interrupted suite into a pass. Independently rerun every affected suite if unrelated project fixtures block the aggregate command.

- [ ] **Step 5: Perform local browser acceptance without real writes.**

  Restart local services on the tested commit and open the collection and auto-listing pages. Confirm:

  - no per-store category wording or old store-scoped record appears;
  - the collection row shows source/shared/manual state safely;
  - the auto-listing table shows one latest row per product/store and a real creation time;
  - historical task detail remains accessible;
  - recovery states use fixed Chinese copy.

  Do not click a control that triggers real paid AI or Ozon product/stock writes. Use the loopback E2E for write-path acceptance.

- [ ] **Step 6: Write the operations runbook.**

  `docs/operations/account-shared-ozon-category-migration.md` must include:

  - maintenance-window stop list;
  - database backup command template and restore-verification checklist without embedded credentials;
  - tested implementation SHA and migration 063/064 expectations;
  - preflight queries for malformed source facts and account/signature conflicts;
  - old-table absence and shared-row/evidence/event integrity checks;
  - safe smoke tests;
  - resume order;
  - rollback: stop services, restore the pre-upgrade database backup, deploy the old code, reconcile any external Ozon writes before replay;
  - explicit warning that reverse SQL cannot reconstruct deleted store-scoped records.

- [ ] **Step 7: Request independent code review.**

  Use `superpowers:requesting-code-review` for the complete diff. Resolve every Critical or Important finding with a fresh RED-to-GREEN cycle and rerun affected real-PG/E2E/build gates. Do not merge or deploy with an unresolved Critical/Important.

- [ ] **Step 8: Commit implementation evidence separately.**

  Commit E2E/runbook changes with the implementation they validate. After the final implementation SHA is stable, create the verification document containing exact commands/counts, authoritative error-policy version and evidence source, browser evidence, unverified scope, external-call boundary, rollback instructions, and disposable-resource cleanup. Commit that document separately:

  ```bash
  git add docs/verification/2026-08-12-account-shared-ozon-category-recovery.md
  git commit -m "docs(categories): record shared category recovery verification"
  ```

- [ ] **Step 9: Remove disposable resources and confirm a clean worktree.**

  Stop/remove only task-specific containers, confirm none remain, verify no test secret appears in tracked files/logs, and require `git status --short` to be empty.

---

## Regression Risks and Recovery

- **Destructive migration:** Migration 063 intentionally deletes old store-scoped category records. Mitigation: maintenance window, verified backup, fail-closed source-only preflight, disposable restore rehearsal. Recovery after successful deletion is database backup plus old code, never reverse guessing.
- **Category/store separation:** Removing store from category identity must not remove store scope from credentials, currency, warehouse, inventory, permissions, submission links, or RFBS authorization. Cross-store/category reuse and cross-store operational isolation require separate tests.
- **Immutable history:** Old source snapshots, jobs, submissions, and audits stay readable. New writes use V2 category evidence; V1 is history-only and cannot authorize a new job.
- **External-write ambiguity:** Any uncertain submit/check/offer lookup remains on the existing reconciliation path. Only proven absence plus a terminal allowlisted category failure may create the single category recovery attempt.
- **Error classification drift:** Ozon may change error schemas. Unknown combinations fail closed to manual review. Updating the allowlist requires a new policy version, authoritative fixture, tests, and verification record.
- **Required attributes:** A replacement category may require different dictionaries/attributes. Missing or ambiguous mappings stop before the second import; content/media are never regenerated automatically.
- **List semantics:** The ordinary list limit becomes a visible item-row limit after newest-per-product/store ranking. `getJob()` and database history remain unchanged.
- **JSON/local mode:** Old `collectCategoryResolutions` state is deleted, not migrated. Source evidence/shared rows must come from canonical collection facts; missing source data follows lookup/manual behavior.

## Definition of Done

- Migration 063 was observed RED before implementation and passes static plus disposable-PG source-only/destructive/rollback tests with zero skip.
- Store-scoped tables, runtime cursors, JSON arrays, timers, service/repository/runtime modules, and UI wording are absent from the new runtime.
- New collection writes immutable source category evidence and account-shared state; two stores share it and another account cannot.
- Missing source category uses only exact read lookup, then administrator confirmation if unresolved; zero paid AI/Ozon product write happens beforehand.
- New auto-listing source snapshots freeze V2 account-shared evidence/version and contain no category store identity.
- Normal listing uses the frozen source/shared category without per-store matching while preserving all other store boundaries.
- Ozon failures are classified from a versioned structured closed policy; arbitrary text is never authority or user-visible output.
- Exactly one automatic category recovery can occur after terminal category failure, zero product ID, and proven offer absence; retries/replays cannot duplicate product or stock writes.
- Same product/store ordinary rows collapse to the newest row, historical detail remains, and the table shows the real job creation time.
- Focused, adjacent, disposable-PG, loopback fake-Ozon E2E, syntax, diff, build, and independent-review gates have fresh evidence.
- Verification states exactly what was not tested: real Ozon writes, paid AI, production DB migration, and production disaster-recovery execution remain prohibited until separately authorized.

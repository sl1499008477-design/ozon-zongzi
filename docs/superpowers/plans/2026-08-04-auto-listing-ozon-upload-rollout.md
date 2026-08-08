# Auto Listing Ozon Upload and Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Convert accepted AI content into a typed listing overlay, submit it through the existing Ozon listing pipeline, support review and direct modes with one path, reconcile final platform results, and roll out direct upload safely after acceptance.

**Architecture:** Before AI work starts, the backend freezes a complete target-store-normalized Ozon-ready listing base, its source draft version, and its canonical hash. The overlay builder copies that immutable listing base and applies only typed media, rich-content, calculated-price, destination, and stock fields. Accepted image assets are published to a dedicated externally reachable listing-media boundary. A submission service delegates to the existing listing pipeline without mutating the collect-box draft and records a one-to-one link to the current durable listing job. A reconciler maps existing listing outcomes back to auto-listing items. Review versus direct changes only when the same submission service is invoked.

**Tech Stack:** Node.js ESM, PostgreSQL, current listing-pipeline/listing-worker/ozon-client boundaries, MinIO-compatible object storage, pg-boss, node:test.

## Global Constraints

- Complete plans 1–3 first.
- Follow AGENTS.md: backend authorization, immutable and traceable submission snapshots, idempotent external writes, recovery after uncertain results, account/store boundaries, stable contracts, audit logs, and rollback reporting.
- Honor the confirmed design: do not perform a post-generation comparison across every source field. Prevent changes structurally by copying the immutable snapshot and accepting only a closed typed overlay.
- The compact AI source snapshot is not an upload payload. Freeze and hash a complete Ozon-ready listing base before generation, including every variant's attributes/dictionary IDs, complex attributes, logistics, barcode, VAT/old/min price, video, model, and variant relations.
- Upload rechecks only the original collect draft identity/version/hash against the frozen source evidence. It does not compare every field after generation. A changed or deleted source blocks upload and requires a new task.
- The AI output can supply only new images and rich content. Price, target store, active FBS warehouse, and stock come from frozen user configuration. No caller can override SKU, category, attributes, weight, package dimensions, product dimensions, variant relations, or offer identity.
- Never call callOzonSellerApi from an auto-listing module. All Ozon writes go through createSubmissionV3 and the current listing worker.
- Review and direct modes use the same overlay, publication, submission, idempotency, and reconciliation services.
- Direct mode is backend-controlled and cannot be enabled from an ordinary-user request.
- Temporary browser URLs are not valid Ozon listing media. Publish approved images through a production-configured externally reachable HTTPS media base and retain content hashes.
- Do not use production store credentials or real Ozon writes in automated tests.
- Preserve unrelated worktree changes.

## Dependency and Stable Output

This is plan 4 of 4. After its verification gate passes, AUTO_LISTING_ENABLED may be enabled in review mode. Direct mode requires the separate rollout gate in Task 7.

---

## Task 1: Add Upload Policy Versions and Submission Links

**Files:**
- Create: server/db/migrations/038_auto_listing_upload_rollout.sql
- Create: server/tests/auto-listing-upload-migration.test.mjs

**Interfaces:** auto_listing_listing_bases, auto_listing_upload_policy_versions, auto_listing_submission_links, auto_listing_upload_attempts.

- [ ] **Step 1: Write a failing migration-contract test**

Assert additive tables, immutable complete listing-base JSON/hash plus source collect/draft identity, admin publisher, REVIEW/DIRECT mode constraint, immutable policy versions, unique item/result submission link, current listing snapshot/job foreign keys, idempotency key, request/result hashes, attempt outcome/error/audit fields, and indexes. Reject destructive SQL.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-upload-migration.test.mjs
~~~

- [ ] **Step 3: Create migration 038**

auto_listing_listing_bases stores account/job/item/source snapshot/collect item, product draft ID/version/data hash, the complete Ozon-ready normalized variant array, its canonical hash, normalizer/category/dictionary versions, and timestamps. It is append-only and account/job/item scoped. AI modules read it but never update it.

auto_listing_upload_policy_versions stores immutable REVIEW or DIRECT mode, enabled flag, version, publication reason, created/published by, and timestamps. Seed no active DIRECT policy.

auto_listing_submission_links stores account/job/item, source/result/config hashes, upload-policy version, existing submission_snapshot_id and submission_job_id, idempotency_key, status, and timestamps. Unique(account_id, auto_listing_item_id, result_hash, target_store_id).

auto_listing_upload_attempts stores account/item/link, actor/action, expected item version, target store/warehouse, draft hash, listing pipeline response summary, stable error fields, correlation ID, and timestamps.

Add upload_policy_version_id to auto_listing_jobs additively. The job-creation service freezes the currently published policy version; ordinary users cannot supply it.

- [ ] **Step 4: Run contract/configured migration and commit**

~~~bash
node --test server/tests/auto-listing-upload-migration.test.mjs
AUTO_LISTING_POSTGRES_TESTS=1 node server/db/migrate.mjs
git add server/db/migrations/038_auto_listing_upload_rollout.sql server/tests/auto-listing-upload-migration.test.mjs
git commit -m "feat: add auto listing upload rollout data"
~~~

---

## Task 2: Build the Typed Overlay Without Mutating Source Facts

**Files:**
- Create: server/auto-listing-overlay.mjs
- Create: server/auto-listing-ozon-rich-content.mjs
- Create: server/tests/auto-listing-overlay.test.mjs
- Create: server/tests/auto-listing-ozon-rich-content.test.mjs

**Interfaces:** freezeAutoListingListingBase, buildAutoListingSubmissionDraft, convertAutoListingRichContentToOzon.

- [ ] **Step 1: Write failing overlay tests**

Deep-freeze the complete Ozon-ready listing-base fixture and assert it remains byte/hash-identical after building single- and multi-variant drafts. Assert these preserved fields exactly: SKU/offer ID, target category IDs, attributes/dictionary IDs, complex attributes, weight, package dimensions, product measurements, barcode, VAT/old/min price, video, model, variant relations, source identity, and every nonmedia product fact.

Assert only these results change:

~~~js
{
  images: acceptedPublishedImageUrls,
  richContent: convertedGeneratedRichContent,
  price: calculatedFinalRubles,
  targetStoreId: frozenConfig.targetStoreId,
  stocks: [{
    offer_id: sourceOfferId,
    warehouse_id: frozenConfig.targetWarehouseId,
    stock: frozenConfig.stock,
  }],
}
~~~

Reject unknown overlay keys and any attempt to pass sku, offer_id, category_id, description_category_id, attributes, weight, depth, width, height, variants, store credentials, or model output as a generic patch.

- [ ] **Step 2: Write failing rich-content conversion tests**

Map the internal AUTO_LISTING_RICH_CONTENT_V1 blocks to the exact rich-content field already consumed by the current Ozon import normalizer. Cover allowed block ordering, generated asset URL references, Russian text, unsupported block rejection, output-size boundaries already enforced by the current listing contract, and stable hashing.

- [ ] **Step 3: Confirm RED**

~~~bash
node --test server/tests/auto-listing-overlay.test.mjs server/tests/auto-listing-ozon-rich-content.test.mjs
~~~

- [ ] **Step 4: Implement copy-plus-typed-overlay construction**

Do not merge arbitrary caller objects and do not rebuild variants from the compact AI source snapshot. Clone each complete frozen Ozon-ready variant, then assign only accepted media/rich content and final price. Derive stock rows separately from immutable variant offer IDs and frozen warehouse/stock configuration.

Multi-variant rules:

- all source variants remain;
- each variant receives the accepted image set for its visual group;
- size-only shared groups reuse the same generated asset IDs;
- visual-difference groups receive their own assets;
- final price follows the confirmed task price calculation unless a later approved business rule explicitly defines per-variant pricing.

- [ ] **Step 5: Implement rich-content conversion and confirm GREEN**

~~~bash
node --test server/tests/auto-listing-overlay.test.mjs server/tests/auto-listing-ozon-rich-content.test.mjs
git add server/auto-listing-overlay.mjs server/auto-listing-ozon-rich-content.mjs server/tests/auto-listing-overlay.test.mjs server/tests/auto-listing-ozon-rich-content.test.mjs
git commit -m "feat: build typed auto listing overlays"
~~~

---

## Task 3: Publish Approved Images for Ozon Retrieval

**Files:**
- Modify: server/object-storage.mjs
- Create: server/listing-asset-publication.mjs
- Create: server/tests/listing-asset-publication.test.mjs
- Modify: server/runtime-config.mjs

**Interfaces:** publishListingAsset, listing media public URL contract.

- [ ] **Step 1: Write failing publication tests**

Assert:

- only ACCEPTED assets for the same account/item can publish;
- publication key is content-addressed and contains no title/SKU/account name;
- repeated publication of the same content reuses the same object/URL;
- URL is HTTPS in production and under LISTING_ASSET_PUBLIC_BASE_URL;
- returned bytes/hash/content type match the private accepted asset;
- a browser-authenticated/private API URL is rejected;
- failed copy/publish does not mark the asset published;
- unreferenced generated drafts are not accidentally public.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/listing-asset-publication.test.mjs
~~~

- [ ] **Step 3: Add a narrow object-storage publication primitive**

Keep generated/checker originals private. Copy only approved image bytes to a dedicated listing-media prefix or bucket configured for public/CDN reads. Return object key, public URL, SHA-256, type, size, published_at, and publication version.

Do not use short-lived presigned URLs because Ozon import and later processing may fetch asynchronously. Validate external reachability during deployment verification, not in every task.

- [ ] **Step 4: Add production configuration checks**

When AUTO_LISTING_UPLOAD_ENABLED=1 require LISTING_ASSET_PUBLIC_BASE_URL, HTTPS, object-storage configuration, and current LISTING_PIPELINE_V3. Keep direct mode disabled if the public media health check fails.

- [ ] **Step 5: Confirm GREEN and commit**

~~~bash
node --test server/tests/listing-asset-publication.test.mjs
git add server/object-storage.mjs server/listing-asset-publication.mjs server/runtime-config.mjs server/tests/listing-asset-publication.test.mjs
git commit -m "feat: publish approved listing media"
~~~

---

## Task 4: Reuse the Existing Durable Ozon Submission Pipeline

**Files:**
- Create: server/auto-listing-upload-service.mjs
- Modify: server/auto-listing-runtime.mjs
- Create: server/tests/auto-listing-upload-service.test.mjs
- Modify: server/tests/external-write-safety.test.mjs
- Modify: server/tests/listing-pipeline-warehouse-boundary.test.mjs

**Interfaces:** submitAutoListingItem({ actor, itemId, trigger, expectedStatusVersion }).

- [ ] **Step 1: Write failing upload-service tests with injected listing functions**

Prove:

- TENANT_OPERATE and account scope are required;
- item must be READY_FOR_REVIEW for approval or UPLOAD_QUEUED for direct mode;
- source/config/plan/assets/rich content are all frozen and accepted;
- at least six images and an accepted main image exist;
- target store still belongs to account and credentials are usable;
- target warehouse is rechecked through assertListingStockSelectionEligible;
- typed overlay result creates one existing submission snapshot/job with type AUTO_LISTING;
- same item/result hash returns the same submission link/job;
- an uncertain/current listing job is reconciled, never resubmitted;
- auto-listing modules do not import or invoke callOzonSellerApi.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-upload-service.test.mjs server/tests/external-write-safety.test.mjs
~~~

- [ ] **Step 3: Implement a single submission boundary**

The service transactionally reserves auto_listing_submission_links by account/item/result hash, verifies the original collect draft identity/version/hash is unchanged, publishes accepted assets, builds the typed draft/stocks, and delegates to the existing listing pipeline with:

~~~js
{
  accountId,
  collectItemId: sourceSnapshot.source.collectItemId,
  targetStoreId: config.targetStoreId,
  idempotencyKey: "auto-listing:" + itemId + ":" + resultHash,
  collectItem: unchangedAccountScopedCollectItem,
  normalizedItems: overlay.items,
  stocks: overlay.stocks,
  type: "AUTO_LISTING",
  versions: {
    categoryRuleVersion: sourceSnapshot.targetCategory.ruleVersion,
    dictionaryVersion: sourceSnapshot.targetCategory.dictionaryVersion,
    richContentRuleVersion: richContent.version,
  },
}
~~~

Pass AI results only through normalizedItems/stocks; never place them in collectItem.listingDraft, so the listing pipeline cannot mirror AI changes back into the collect box. Capture returned existing submission snapshot/job IDs and link them. If the external listing-pipeline transaction succeeds but link persistence is interrupted, recovery searches by the same idempotency key and repairs the link.

- [ ] **Step 4: Extend external-write safety guards**

Static and runtime tests must fail if any auto-listing module imports callOzonSellerApi or writes Ozon endpoints directly. With LISTING_PIPELINE_V3=0 or AUTO_LISTING_UPLOAD_ENABLED=0, submission returns a stable disabled error before publishing/calling the listing function.

- [ ] **Step 5: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-upload-service.test.mjs server/tests/external-write-safety.test.mjs server/tests/listing-pipeline-warehouse-boundary.test.mjs
git add server/auto-listing-upload-service.mjs server/auto-listing-runtime.mjs server/tests/auto-listing-upload-service.test.mjs server/tests/external-write-safety.test.mjs server/tests/listing-pipeline-warehouse-boundary.test.mjs
git commit -m "feat: submit AI listings through durable pipeline"
~~~

---

## Task 5: Add Review Approval and Direct-Mode Invocation

**Files:**
- Modify: server/auto-listing-routes.mjs
- Modify: server/auto-listing-ai-orchestrator.mjs
- Create: server/auto-listing-upload-policy.mjs
- Create: server/tests/auto-listing-upload-policy.test.mjs
- Create: server/tests/auto-listing-approval-routes.test.mjs
- Modify: app/src/AutoListingPage.jsx
- Modify: app/src/auto-listing-view.js
- Modify: app/tests/auto-listing-page-contract.test.mjs

**Interfaces:** approve endpoint; immutable REVIEW/DIRECT policy versions; same service invocation.

- [ ] **Step 1: Write failing policy and approval tests**

Assert:

- ordinary users may approve only their own READY_FOR_REVIEW item;
- approval requires expected status version and cannot double-submit;
- user request cannot switch mode;
- REVIEW generation stops at READY_FOR_REVIEW;
- DIRECT generation calls the same submitAutoListingItem after entering UPLOAD_QUEUED;
- newly published policy affects new jobs only;
- existing jobs retain their frozen mode;
- DIRECT also requires AUTO_LISTING_DIRECT_UPLOAD_ALLOWED=1;
- missing checks/media/store/warehouse blocks both modes identically.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-upload-policy.test.mjs server/tests/auto-listing-approval-routes.test.mjs app/tests/auto-listing-page-contract.test.mjs
~~~

- [ ] **Step 3: Add the approval route**

~~~text
POST /auto-listing/items/:itemId/approve
body: { expectedStatusVersion }
~~~

The route delegates to the policy/state service, transitions to UPLOAD_QUEUED, and calls the same upload service. It returns the auto-listing item and linked listing job summary.

- [ ] **Step 4: Connect direct mode in the orchestrator**

At content completion, read the job-frozen policy:

- REVIEW: CONTENT_READY_FOR_REVIEW;
- DIRECT: CONTENT_READY_FOR_DIRECT_UPLOAD then submitAutoListingItem with trigger SYSTEM_DIRECT.

Do not fork separate overlay or listing logic.

- [ ] **Step 5: Add the review-page upload action**

Show “确认上传到 Ozon” only for READY_FOR_REVIEW with valid action availability. The confirmation summarizes store, active FBS warehouse, stock, final price, variant count, image count, and that media/rich content will be replaced. After submission, show the linked durable listing progress.

- [ ] **Step 6: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-upload-policy.test.mjs server/tests/auto-listing-approval-routes.test.mjs app/tests/auto-listing-page-contract.test.mjs
git add server/auto-listing-routes.mjs server/auto-listing-ai-orchestrator.mjs server/auto-listing-upload-policy.mjs server/tests/auto-listing-upload-policy.test.mjs server/tests/auto-listing-approval-routes.test.mjs app/src/AutoListingPage.jsx app/src/auto-listing-view.js app/tests/auto-listing-page-contract.test.mjs
git commit -m "feat: approve or directly submit AI listings"
~~~

---

## Task 6: Reconcile Ozon Results Back to Auto-Listing Items

**Files:**
- Create: server/auto-listing-submission-reconciler.mjs
- Modify: server/auto-listing-ai-queue.mjs
- Modify: server/auto-listing-ai-worker.mjs
- Create: server/tests/auto-listing-submission-reconciler.test.mjs
- Modify: server/tests/auto-listing-ai-worker.test.mjs

**Interfaces:** reconcileAutoListingSubmission; existing submission job is the source of truth for Ozon progress.

- [ ] **Step 1: Write failing reconciliation tests**

Map existing statuses:

~~~text
QUEUE_PENDING/QUEUED/VALIDATING/SUBMITTING/OZON_ACCEPTED/CHECKING -> UPLOADING
SUCCEEDED -> SUCCEEDED
PARTIAL_SUCCESS -> BLOCKED with OZON_PARTIAL_SUCCESS_REQUIRES_REVIEW
FAILED -> RETRYABLE_ERROR or BLOCKED using existing failure disposition/evidence
RECONCILING -> BLOCKED with OZON_RECONCILIATION_REQUIRED
CANCELLED before Ozon acceptance -> CANCELLED
~~~

Prove monotonic item versions, terminal idempotency, event/audit creation, variant-level result summary, stock-sync partial failure visibility, and no resubmission when task_id/result is uncertain.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-submission-reconciler.test.mjs server/tests/auto-listing-ai-worker.test.mjs
~~~

- [ ] **Step 3: Add durable reconciliation messages**

After submission link creation, enqueue RECONCILE_SUBMISSION with deterministic item/link key. Poll the existing submission repository, not Ozon directly. Continue while nonterminal using bounded delays. Worker crashes resume from outbox/queue state.

- [ ] **Step 4: Implement stable user results and retry policy**

A retryable upload error reuses the same link/listing idempotency key when safe. Reconciliation-required and partial-success cases require review; they never auto-create another Ozon product. Store platform task ID, per-variant success/failure summaries, stock outcome, timestamps, and correlation IDs in safe events.

- [ ] **Step 5: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-submission-reconciler.test.mjs server/tests/auto-listing-ai-worker.test.mjs
git add server/auto-listing-submission-reconciler.mjs server/auto-listing-ai-queue.mjs server/auto-listing-ai-worker.mjs server/tests/auto-listing-submission-reconciler.test.mjs server/tests/auto-listing-ai-worker.test.mjs
git commit -m "feat: reconcile automatic Ozon listings"
~~~

---

## Task 7: Add Admin Rollout Controls and Direct-Mode Safety Gate

**Files:**
- Modify: server/auto-listing-routes.mjs
- Modify: server/runtime-config.mjs
- Create: server/tests/auto-listing-rollout-routes.test.mjs
- Create: scripts/check-auto-listing-direct-readiness.mjs
- Modify: scripts/verify.mjs

**Interfaces:** admin upload-policy publish; review first, direct after acceptance.

- [ ] **Step 1: Write failing rollout tests**

Assert only AI_CONTENT_MANAGE admins can create/publish policy versions. DIRECT publication fails unless:

- AUTO_LISTING_DIRECT_UPLOAD_ALLOWED=1;
- listing pipeline and upload feature are enabled;
- current sub2api profile capability test passed;
- listing-media public health passed;
- target runtime has PostgreSQL, queue workers, object storage, and production credential checks;
- full static safety script passes.

No ordinary-user request can bypass this gate.

- [ ] **Step 2: Add admin routes**

~~~text
GET  /admin/auto-listing/upload-policies
POST /admin/auto-listing/upload-policies
POST /admin/auto-listing/upload-policies/:id/publish
~~~

Every publish emits an audit event with actor, prior/new version, mode, reason, time, and readiness summary. Never retroactively change existing jobs.

- [ ] **Step 3: Add direct-readiness static/runtime checks**

Require one Ozon write path, typed overlay whitelist, review/direct shared service, linked listing idempotency, reconciliation, feature flags, public-media HTTPS, credential redaction, and test inventory. Reject callOzonSellerApi imports outside the existing approved Ozon client/listing worker boundaries.

- [ ] **Step 4: Run rollout tests and commit**

~~~bash
node --test server/tests/auto-listing-rollout-routes.test.mjs
node scripts/check-auto-listing-direct-readiness.mjs
git add server/auto-listing-routes.mjs server/runtime-config.mjs server/tests/auto-listing-rollout-routes.test.mjs scripts/check-auto-listing-direct-readiness.mjs scripts/verify.mjs
git commit -m "feat: gate automatic listing rollout"
~~~

---

## Task 8: End-to-End Verification and Rollback Documentation

**Files:**
- Create: server/tests/auto-listing-review-to-submission.integration.mjs
- Create: server/tests/auto-listing-direct-to-submission.integration.mjs
- Create: docs/superpowers/verification/2026-08-04-auto-listing-complete.md

- [ ] **Step 1: Add PostgreSQL integration scenarios with fake AI/Ozon ports**

Review scenario: collect source -> immutable snapshot -> plan -> accepted assets/rich content -> READY_FOR_REVIEW -> approve -> existing submission job -> reconciled success.

Direct scenario: same pipeline -> frozen DIRECT policy -> UPLOAD_QUEUED -> same upload service -> same listing pipeline -> reconciled success.

Also cover duplicate approve, duplicate worker delivery, service restart, source deletion after snapshot, store/warehouse invalidation before upload, one bad Excel row, one failed image, main failure, six-image minimum, Ozon timeout before task ID, Ozon accepted then local crash, partial variants, and stock-sync failure.

- [ ] **Step 2: Run the full automated gate**

~~~bash
AUTO_LISTING_POSTGRES_TESTS=1 node --test server/tests/auto-listing-review-to-submission.integration.mjs server/tests/auto-listing-direct-to-submission.integration.mjs
pnpm verify
~~~

Expected: all always-on tests/build/static checks pass. PostgreSQL integrations pass only against the dedicated test database. Real sub2api/Ozon calls remain outside automated tests.

- [ ] **Step 3: Perform staged nonproduction acceptance**

1. Enable AUTO_LISTING_ENABLED and AI in REVIEW mode.
2. Test collect-box and Excel sources using a nonproduction account/store.
3. Run the explicit sub2api text/image capability test and record model/profile versions and generated cost.
4. Confirm public media is reachable from outside the local network.
5. Approve one controlled Ozon listing and verify product fields, images, rich content, price, variants, active FBS warehouse stock, import status, and audit trail.
6. Test recovery from worker restart and one forced transient failure.
7. Keep DIRECT disabled until user acceptance is recorded.
8. Set AUTO_LISTING_DIRECT_UPLOAD_ALLOWED=1, publish a new DIRECT policy version, and test a small allowlisted batch before normal use.

- [ ] **Step 4: Document exact results and rollback**

The verification document must list changed contracts/migrations, commands/results, real calls performed, data/store used, unverified ranges, regression results, monitoring, and rollback:

- publish a new REVIEW policy immediately;
- set AUTO_LISTING_DIRECT_UPLOAD_ALLOWED=0;
- set AUTO_LISTING_UPLOAD_ENABLED=0 to stop new submissions while keeping review/history;
- set AUTO_LISTING_AI_ENABLED=0 to stop generation;
- set AUTO_LISTING_ENABLED=0 to hide/disable the whole feature;
- stop import/AI workers;
- allow already accepted existing listing jobs to reconcile instead of deleting them;
- retain snapshots, prompts hashes, assets, submission links, events, and audit records.

- [ ] **Step 5: Commit verification artifacts**

~~~bash
git add server/tests/auto-listing-review-to-submission.integration.mjs server/tests/auto-listing-direct-to-submission.integration.mjs docs/superpowers/verification/2026-08-04-auto-listing-complete.md
git commit -m "test: verify automatic listing end to end"
~~~

---

## Final Four-Plan Completion Gate

- [ ] All four plan test inventories pass.
- [ ] pnpm verify passes without excluding current active tests.
- [ ] Dedicated PostgreSQL migration/integration suites pass.
- [ ] App build and route/menu/page contracts pass.
- [ ] Existing collect-box, category matching, store isolation, active-FBS filtering, listing submission, status reconciliation, stock sync, and external-write safety regressions pass.
- [ ] Explicit sub2api capability test passes for the selected deployment/profile/models.
- [ ] Review-mode controlled Ozon acceptance passes before direct mode is available.
- [ ] Direct mode remains disabled until its policy is published after acceptance.

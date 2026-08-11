# RFBS First Listing Warehouse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a zero-product active RFBS warehouse to be used for its first auto-listing only after tenant-bound read-only Ozon verification, with immutable creation/upload evidence and recoverable stock-update failure.

**Architecture:** Keep the current FBS association rule unchanged and add an RFBS-only verifier behind the warehouse eligibility domain contract. Migration 059 stores append-only normalized evidence; creation evidence binds to the job, while a fresh upload evidence row binds to the submission link and attempt. The UI may offer an RFBS warehouse marked “创建任务时验证”, but only the backend can authorize execution.

**Tech Stack:** Node.js 24 ESM, PostgreSQL 16/17 migrations, React with Ant Design, Node test runner, controlled fake Ozon transport, Vite.

## Global Constraints

- FBS still requires an active non-archived product association.
- RFBS may have zero products, but requires successful read-only verification no older than 10 minutes.
- FBO, FBP, unknown types, disabled warehouses, placeholder IDs, cross-account and cross-store data remain fail-closed.
- Browser input never supplies trusted type, platform ID, evidence outcome, hash or expiry.
- Evidence is append-only and contains no API Key or public raw Ozon response.
- Product import and stock update remain ordered, separate side effects; stock failure must not re-import products.
- Tests use fake transport. No real Ozon product or stock write is authorized.
- Do not modify or stage the user-owned dirty files under `docs/plans/2026-08-01-*` and `docs/superpowers/plans/2026-08-01-*`.
- Every task follows RED → GREEN, focused regression, review and a scoped commit.

## File Map

**Create:**

- `server/auto-listing-rfbs-warehouse-verifier.mjs` — one read-only RFBS verification use case.
- `server/db/migrations/059_auto_listing_rfbs_warehouse_evidence.sql` — append-only evidence and bindings.
- `server/tests/auto-listing-rfbs-warehouse-verifier.test.mjs` — verifier contract.
- `server/tests/auto-listing-rfbs-warehouse-migration.test.mjs` — static migration contract.
- `server/tests/auto-listing-rfbs-warehouse-postgres.integration.test.mjs` — SQL boundaries.
- `server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs` — controlled full chain.
- `app/src/auto-listing-rfbs-warehouse.test.mjs` — option/copy contract.

**Modify:**

- `server/listing-warehouse-eligibility.mjs` and its tests — FBS/RFBS matrix.
- `server/auto-listing-repository.mjs`, `server/auto-listing-service.mjs`, `server/auto-listing-runtime.mjs` — creation verification and binding.
- `server/auto-listing-preferences-postgres.mjs` — save RFBS as pending verification without network.
- `server/auto-listing-upload-postgres.mjs`, `server/auto-listing-upload-service.mjs`, `server/listing-pipeline.mjs` — fresh upload evidence and stock boundary.
- `server/index.mjs`, `app/src/auto-listing-config.js`, `app/src/AutoListingPage.jsx` — safe projection and UI.
- Direct tests adjacent to every modified module plus `docs/verification/2026-08-11-rfbs-first-listing.md`.

---

### Task 1: Expand the Pure Eligibility Contract

**Files:**
- Modify: `server/listing-warehouse-eligibility.mjs`
- Modify: `server/tests/listing-warehouse-eligibility.test.mjs`
- Modify: `server/tests/listing-pipeline-warehouse-boundary.test.mjs`

**Interfaces:**
- Consumes: `listingWarehouseEligibility({ warehouse, products, targetStoreId, accountId, hasActiveProductAssociation, validationEvidence?, now? })`.
- Produces: `{ eligible, code, fulfillmentType, evidenceRequired }`.

- [ ] **Step 1: Add exact failing RFBS matrix tests**

```js
assert.deepEqual(evaluate({ warehouse: activeFbs({ warehouse_type: "rFBS" }), products: [] }), {
  eligible: false,
  code: "RFBS_VALIDATION_REQUIRED",
  fulfillmentType: "RFBS",
  evidenceRequired: true,
});
assert.deepEqual(evaluate({
  warehouse: activeFbs({ warehouse_type: "rFBS" }),
  products: [],
  now: "2026-08-11T12:00:00.000Z",
  validationEvidence: {
    outcome: "PASSED", accountId: "account-a", storeId: "store-a",
    warehouseRecordId: "warehouse-a", platformWarehouseId: "1001",
    fulfillmentType: "RFBS", expiresAt: "2026-08-11T12:10:00.000Z",
  },
}), {
  eligible: true,
  code: "ELIGIBLE_ACTIVE_RFBS",
  fulfillmentType: "RFBS",
  evidenceRequired: true,
});
```

Add wrong-account/store/local-ID/platform-ID, expired, disabled, FBO and FBP cases. Update FBS expectations with `fulfillmentType:"FBS"` and `evidenceRequired:false` without changing association behavior.

- [ ] **Step 2: Run RED**

```bash
node --test server/tests/listing-warehouse-eligibility.test.mjs server/tests/listing-pipeline-warehouse-boundary.test.mjs
```

Expected: RFBS cases fail with the old `TYPE_NOT_FBS`; existing FBS cases pass.

- [ ] **Step 3: Implement explicit FBS/RFBS branches**

```js
if (type !== "FBS" && type !== "RFBS") {
  return output(false, "UNSUPPORTED_FULFILLMENT_TYPE", type || "UNKNOWN", false);
}
if (type === "RFBS") {
  return validRfbsEvidence({ evidence: validationEvidence, warehouse: record,
    accountId: scopedAccountId, targetStoreId: scopedTargetStoreId, now })
    ? output(true, "ELIGIBLE_ACTIVE_RFBS", "RFBS", true)
    : output(false, "RFBS_VALIDATION_REQUIRED", "RFBS", true);
}
```

Run scope, platform-ID and disabled checks before this branch. Leave the FBS product-association algorithm intact.

- [ ] **Step 4: Keep the generic pipeline closed**

Add a test proving `assertListingStocksBelongToTarget` rejects RFBS when the caller supplies only `warehouse_id` and no evidence ID.

- [ ] **Step 5: Run GREEN regressions**

```bash
node --test server/tests/listing-warehouse-eligibility.test.mjs server/tests/listing-pipeline-warehouse-boundary.test.mjs server/tests/account-store-isolation.test.mjs server/tests/collect-listing-submit-failure.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add server/listing-warehouse-eligibility.mjs server/tests/listing-warehouse-eligibility.test.mjs server/tests/listing-pipeline-warehouse-boundary.test.mjs
git commit -m "feat(auto-listing): define safe RFBS warehouse eligibility"
```

---

### Task 2: Implement the Read-Only RFBS Verifier

**Files:**
- Create: `server/auto-listing-rfbs-warehouse-verifier.mjs`
- Create: `server/tests/auto-listing-rfbs-warehouse-verifier.test.mjs`
- Modify: `server/auto-listing-runtime.mjs`
- Modify: `server/tests/auto-listing-runtime-worker.test.mjs`

**Interfaces:**
- Consumes ports `loadTarget`, `readCredential`, and `callOzonSellerApi`.
- Produces `verifyRfbsWarehouse(input)` returning normalized safe evidence only.

- [ ] **Step 1: Add verifier RED tests**

```js
const evidence = await verifier.verifyRfbsWarehouse({
  accountId: "account-a", actorAccountId: "account-a",
  targetStoreId: "store-a", targetWarehouseId: "warehouse-a", correlationId: "corr-a",
});
assert.equal(calls[0].path, "/v2/warehouse/list");
assert.deepEqual(calls[0].body, {});
assert.equal(evidence.platformWarehouseId, "1001");
assert.equal(evidence.fulfillmentType, "RFBS");
assert.equal(evidence.expiresAt, "2026-08-11T12:10:00.000Z");
assert.equal(JSON.stringify(evidence).includes("api-key-secret"), false);
```

Also cover missing credential, wrong tenant, duplicate matches, malformed/oversized responses, FBS/FBO response, disabled status, timeout/5xx, accessors/proxies and errors containing secret-like text.

Assert only these stable business codes escape the verifier boundary: `RFBS_WAREHOUSE_NOT_FOUND`, `RFBS_WAREHOUSE_DISABLED`, `RFBS_WAREHOUSE_SCOPE_MISMATCH`, `RFBS_WAREHOUSE_CHANGED`, `RFBS_WAREHOUSE_EVIDENCE_EXPIRED`, and retryable `RFBS_VALIDATION_REQUIRED`. Unexpected internal errors map to `AUTO_LISTING_RFBS_VALIDATION_FAILED` without third-party messages.

- [ ] **Step 2: Run RED**

```bash
node --test server/tests/auto-listing-rfbs-warehouse-verifier.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the closed verifier factory**

```js
export function createAutoListingRfbsWarehouseVerifier({
  loadTarget, readCredential, callOzonSellerApi,
  now = () => new Date(), ttlMs = 600_000,
} = {}) {
  return Object.freeze({
    async verifyRfbsWarehouse(input = {}) {
      // closed IDs -> trusted local target -> credential -> one warehouse-list read
      // exact unique platform-ID match -> normalized evidence -> SHA-256 hash
    },
  });
}
```

The returned object must contain only `schemaVersion`, account/store/local/platform IDs, normalized type/status, outcome, observed/expiry timestamps, evidence hash, correlation ID and actor ID. Never log or return credentials/raw bodies.

- [ ] **Step 4: Compose it in `createAutoListingRuntime`**

Inject the verifier into `createAutoListingService`; production uses the current tenant-scoped warehouse/credential ports and `callOzonSellerApi`. Disabled auto-listing must make zero credential/decrypt/network calls.

- [ ] **Step 5: Run GREEN**

```bash
node --test server/tests/auto-listing-rfbs-warehouse-verifier.test.mjs server/tests/auto-listing-runtime-worker.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add server/auto-listing-rfbs-warehouse-verifier.mjs server/auto-listing-runtime.mjs server/tests/auto-listing-rfbs-warehouse-verifier.test.mjs server/tests/auto-listing-runtime-worker.test.mjs
git commit -m "feat(auto-listing): verify RFBS warehouses read only"
```

---

### Task 3: Persist Append-Only Evidence and Bind Jobs

**Files:**
- Create: `server/db/migrations/059_auto_listing_rfbs_warehouse_evidence.sql`
- Create: `server/tests/auto-listing-rfbs-warehouse-migration.test.mjs`
- Create: `server/tests/auto-listing-rfbs-warehouse-postgres.integration.test.mjs`
- Modify: `server/auto-listing-repository.mjs`
- Modify: `server/tests/auto-listing-repository.test.mjs`
- Modify: `server/tests/auto-listing-postgres.integration.mjs`

**Interfaces:**
- Consumes Task 2 normalized evidence as `graph.warehouseValidation`.
- Produces evidence rows plus nullable job/submission-link/upload-attempt evidence references.

- [ ] **Step 1: Add migration RED assertions**

Require migration 059 to create `auto_listing_rfbs_warehouse_evidence` and add nullable `warehouse_validation_evidence_id` columns to `auto_listing_jobs`, `auto_listing_submission_links`, and `auto_listing_upload_attempts`. Require tenant FKs, `fulfillment_type='RFBS'`, `outcome='PASSED'`, `expires_at>observed_at`, optional restricted `raw_response_ref`, and UPDATE/DELETE guards.

- [ ] **Step 2: Run RED**

```bash
node --test server/tests/auto-listing-rfbs-warehouse-migration.test.mjs server/tests/auto-listing-rfbs-warehouse-postgres.integration.test.mjs
```

Expected: missing migration contract; PG integration runs when explicit test DB variables are present.

- [ ] **Step 3: Implement additive migration 059**

Use composite account/store/warehouse boundaries and nullable consumer FKs so historical FBS rows need no backfill. Direct evidence mutation must fail; parent-account privacy deletion follows the repository’s established controlled cleanup behavior.

- [ ] **Step 4: Atomically insert and bind creation evidence**

Extend the job graph:

```js
warehouseValidation: null // FBS
// or exact normalized PASSED RFBS evidence
```

Inside the existing job `BEGIN`, insert the evidence then insert `auto_listing_jobs.warehouse_validation_evidence_id`. Same-idempotency replay loads and compares the original binding and returns the original job.

- [ ] **Step 5: Prove real PostgreSQL boundaries**

Run migrations 001–059 in a no-volume disposable database and test historical FBS compatibility, atomic RFBS job/evidence commit, concurrent idempotency, cross-tenant FK rejection, append-only triggers, database-time expiry and account cleanup. The evidence insert and its `AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED` audit event must commit in the same transaction.

- [ ] **Step 6: Run GREEN**

```bash
node --test server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-postgres.integration.mjs server/tests/auto-listing-rfbs-warehouse-migration.test.mjs server/tests/auto-listing-rfbs-warehouse-postgres.integration.test.mjs
```

Expected: zero failures and zero PG skips in the disposable environment.

- [ ] **Step 7: Commit**

```bash
git add server/db/migrations/059_auto_listing_rfbs_warehouse_evidence.sql server/auto-listing-repository.mjs server/tests/auto-listing-rfbs-warehouse-migration.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-postgres.integration.mjs server/tests/auto-listing-rfbs-warehouse-postgres.integration.test.mjs
git commit -m "feat(auto-listing): persist RFBS warehouse evidence"
```

---

### Task 4: Verify on Job Creation Without Networking on Preference Save

**Files:**
- Modify: `server/auto-listing-preferences-postgres.mjs`
- Modify: `server/tests/auto-listing-preferences-postgres.test.mjs`
- Modify: `server/auto-listing-service.mjs`
- Modify: `server/tests/auto-listing-service.test.mjs`
- Modify: `server/auto-listing-runtime.mjs`
- Modify: `server/tests/auto-listing-runtime-worker.test.mjs`

**Interfaces:**
- Consumes `verifyRfbsWarehouse` from Task 2.
- Produces `warehouseValidation` for `createJobGraph` from Task 3.

- [ ] **Step 1: Add RED tests**

```js
await preferences.savePreferences(rfbsPreferenceInput);
assert.equal(networkCalls, 0);
await service.createAutoListingJob(rfbsJobInput);
assert.equal(verifyCalls, 1);
assert.equal(capturedGraph.warehouseValidation.fulfillmentType, "RFBS");
await service.createAutoListingJob(fbsJobInput);
assert.equal(verifyCalls, 1); // FBS adds no verifier call
```

Also test zero-product RFBS success, FBS zero-product rejection, FBO/FBP rejection, verifier failure with zero graph writes, idempotent replay and conflicting replay.

- [ ] **Step 2: Run RED**

```bash
node --test server/tests/auto-listing-preferences-postgres.test.mjs server/tests/auto-listing-service.test.mjs
```

- [ ] **Step 3: Allow only the RFBS pending state in preferences**

```js
const selectable = eligibility.eligible === true
  || (eligibility.fulfillmentType === "RFBS"
    && eligibility.code === "RFBS_VALIDATION_REQUIRED"
    && eligibility.evidenceRequired === true);
if (!selectable) throw preferenceError("LISTING_WAREHOUSE_NOT_ELIGIBLE", 422);
```

Preference save must not call Ozon or persist a fabricated success.

- [ ] **Step 4: Verify immediately before graph persistence**

After local source/store/warehouse/policy validation and before `createJobGraph`:

```js
const warehouseValidation = type === "RFBS"
  ? await rfbsWarehouseVerifier.verifyRfbsWarehouse({
      accountId, actorAccountId: accountId,
      targetStoreId: config.targetStoreId,
      targetWarehouseId: config.targetWarehouseId,
      correlationId,
    })
  : null;
return storage.createJobGraph({ ...graph, warehouseValidation });
```

- [ ] **Step 5: Run GREEN regressions**

```bash
node --test server/tests/auto-listing-preferences-postgres.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-runtime-worker.test.mjs server/tests/auto-listing-routes.test.mjs server/tests/auto-listing-user-workflow-routes.test.mjs
```

Assert every verification failure produces zero job/item/event and zero Ozon write calls.

- [ ] **Step 6: Commit**

```bash
git add server/auto-listing-preferences-postgres.mjs server/auto-listing-service.mjs server/auto-listing-runtime.mjs server/tests/auto-listing-preferences-postgres.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-runtime-worker.test.mjs
git commit -m "feat(auto-listing): verify RFBS before creating jobs"
```

---

### Task 5: Revalidate and Bind RFBS at Upload

**Files:**
- Modify: `server/auto-listing-upload-postgres.mjs`
- Modify: `server/auto-listing-upload-service.mjs`
- Modify: `server/listing-pipeline.mjs`
- Modify: `server/tests/auto-listing-upload-service.test.mjs`
- Modify: `server/tests/auto-listing-upload-postgres.integration.test.mjs`
- Modify: `server/tests/auto-listing-upload-task-postgres.integration.test.mjs`
- Modify: `server/tests/listing-pipeline-warehouse-boundary.test.mjs`

**Interfaces:**
- Consumes fresh Task 2 evidence.
- Produces `warehouseValidationEvidenceId` on the RFBS submission command and immutable link/attempt bindings.

- [ ] **Step 1: Add upload ordering RED tests**

```js
assert.deepEqual(calls.map(([name]) => name), [
  "loadUploadEvidence", "verifyRfbsWarehouse", "publishListingAsset",
  "reserveSubmission", "createSubmission", "bindSubmissionResult",
]);
assert.equal(reserveInput.warehouseValidation.fulfillmentType, "RFBS");
assert.equal(createInput.warehouseValidationEvidenceId, reserveResult.warehouseValidationEvidenceId);
```

Add verifier failure/expiry/type-change with zero publication/product/stock writes, FBS zero verifier calls, cross-store evidence rejection and response-loss replay.

- [ ] **Step 2: Run RED**

```bash
node --test server/tests/auto-listing-upload-service.test.mjs server/tests/auto-listing-upload-postgres.integration.test.mjs server/tests/listing-pipeline-warehouse-boundary.test.mjs
```

- [ ] **Step 3: Carry trusted type and creation evidence in upload context**

Extend upload context SQL/DTOs to include job creation evidence and exact warehouse type. Do not synthesize fake FBS product associations for RFBS.

- [ ] **Step 4: Revalidate before upload side effects**

After frozen evidence checks and before asset publication, call the verifier for RFBS. Keep network reads outside DB transactions and map failures to stable warehouse codes.

- [ ] **Step 5: Atomically bind upload evidence**

In the existing `reserveSubmission` transaction: lock account/store/warehouse, compare local/platform ID and type, insert evidence, bind it to submission link and upload attempt, then return `{ submissionLinkId, warehouseValidationEvidenceId }`. FBS keeps its current association SQL and `NULL` evidence.

- [ ] **Step 6: Gate the generic stock snapshot**

```js
await assertListingStocksBelongToTarget({
  accountId, storeId, stocks, warehouseValidationEvidenceId, client,
});
```

RFBS passes only with a PASSED, unexpired, exact evidence row bound to the submission. Callers omitting the ID remain rejected.

- [ ] **Step 7: Prove partial-success recovery**

Use fake Ozon transport: product import and status succeed, `/v2/products/stocks` fails. Assert stored Ozon task/product success is retained, state uses the existing conservative `PARTIAL_SUCCESS`/reconciliation path, and replay makes zero extra `/v3/product/import` calls.

- [ ] **Step 8: Run GREEN regressions**

```bash
node --test server/tests/auto-listing-upload-service.test.mjs server/tests/auto-listing-upload-postgres.integration.test.mjs server/tests/auto-listing-upload-task-postgres.integration.test.mjs server/tests/listing-pipeline-warehouse-boundary.test.mjs server/tests/listing-pipeline-v3.integration.mjs
```

- [ ] **Step 9: Commit**

```bash
git add server/auto-listing-upload-postgres.mjs server/auto-listing-upload-service.mjs server/listing-pipeline.mjs server/tests/auto-listing-upload-service.test.mjs server/tests/auto-listing-upload-postgres.integration.test.mjs server/tests/auto-listing-upload-task-postgres.integration.test.mjs server/tests/listing-pipeline-warehouse-boundary.test.mjs
git commit -m "feat(auto-listing): bind RFBS evidence to uploads"
```

---

### Task 6: Expose the Pending RFBS Choice and Verify the Full Chain

**Files:**
- Modify: `server/index.mjs`
- Modify: `server/tests/account-store-isolation.test.mjs`
- Modify: `app/src/auto-listing-config.js`
- Modify: `app/src/auto-listing-config.test.mjs`
- Modify: `app/src/AutoListingPage.jsx`
- Create: `app/src/auto-listing-rfbs-warehouse.test.mjs`
- Create: `server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs`
- Create: `docs/verification/2026-08-11-rfbs-first-listing.md`

**Interfaces:**
- Consumes public `{ eligible, code, fulfillmentType, evidenceRequired }` only.
- Produces option `{ value, label, fulfillmentType, evidenceRequired, statusLabel }`.

- [ ] **Step 1: Add frontend RED tests**

```js
const result = autoListingWarehouseOptions({
  warehouses: [rfbsWarehouse({ listingEligibility: {
    eligible: false, code: "RFBS_VALIDATION_REQUIRED",
    fulfillmentType: "RFBS", evidenceRequired: true,
  } })],
  targetStoreId: "store-a",
});
assert.deepEqual(result.options[0], {
  value: "1001",
  label: "CEL-测试（RFBS · 创建任务时验证）",
  fulfillmentType: "RFBS",
  evidenceRequired: true,
  statusLabel: "创建任务时验证",
});
```

Test FBO/FBP/other-store exclusion, FBS compatibility, preference hydration, store-change clearing and late-response fencing.

- [ ] **Step 2: Run RED**

```bash
node --test app/src/auto-listing-config.test.mjs app/src/auto-listing-rfbs-warehouse.test.mjs server/tests/account-store-isolation.test.mjs
```

- [ ] **Step 3: Implement the safe option rule**

Offer a warehouse only when `eligible===true`, or when all three exact RFBS pending fields match. Do not use warehouse name heuristics. Change the label to “活跃 FBS / RFBS 仓库” and show:

> RFBS 新店仓库将在创建任务时由后端只读验证，不会在验证阶段创建商品或修改库存。

Map stable verifier errors to concise Chinese actions and keep the existing loading/intent/generation fences.

- [ ] **Step 4: Write a controlled E2E test**

Use disposable PostgreSQL and fake Ozon transport with this exact successful order:

```js
[
  "/v2/warehouse/list",
  "/v3/product/import",
  "/v1/product/import/info",
  "/v2/products/stocks",
]
```

Assert a zero-product RFBS warehouse creates one job, one creation evidence, one submission link, one upload evidence and one stock update. Add missing/disabled/type-changed, expiry, DB-CAS change, ambiguous product response, stock failure and cross-account cases with exact zero-write counts.

- [ ] **Step 5: Run focused PostgreSQL and UI GREEN tests**

Start a loopback-only, no-volume disposable PostgreSQL container, apply migrations 001–059, then run:

```bash
node --test server/tests/listing-warehouse-eligibility.test.mjs server/tests/auto-listing-rfbs-warehouse-verifier.test.mjs server/tests/auto-listing-rfbs-warehouse-postgres.integration.test.mjs server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-upload-service.test.mjs server/tests/auto-listing-upload-postgres.integration.test.mjs server/tests/listing-pipeline-warehouse-boundary.test.mjs app/src/auto-listing-config.test.mjs app/src/auto-listing-rfbs-warehouse.test.mjs
```

Expected: zero failures and zero PostgreSQL skips. Stop/remove only this disposable container.

- [ ] **Step 6: Build and run full verification**

```bash
pnpm --dir app build
pnpm verify
git diff --check
node --check server/auto-listing-rfbs-warehouse-verifier.mjs
```

Expected: exit 0. Environmental blocks must be reported as unverified, never converted into passes.

- [ ] **Step 7: Complete independent review and ledger**

Review tenant scope, secret handling, read/write ordering, idempotency, expiry, TOCTOU, FBS regression, account deletion and product-success/stock-failure recovery. Fix every Critical/Important with a fresh RED → GREEN cycle. Record tested SHA, totals/skips, PostgreSQL version/migrations, fake endpoint sequence, no-real-write statement, any real read-only result, risks and rollback.

- [ ] **Step 8: Commit E2E/UI evidence**

```bash
git add server/index.mjs server/tests/account-store-isolation.test.mjs server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs app/src/auto-listing-config.js app/src/auto-listing-config.test.mjs app/src/AutoListingPage.jsx app/src/auto-listing-rfbs-warehouse.test.mjs docs/verification
git commit -m "test(auto-listing): verify RFBS first listing boundary"
```

## Final Self-Review Checklist

- [ ] Every design requirement maps to a task and test.
- [ ] No placeholder, deferred implementation or guessed platform rule remains.
- [ ] `verifyRfbsWarehouse`, `warehouseValidation`, and `warehouseValidationEvidenceId` names are consistent.
- [ ] Creation evidence is immutable on the job; upload evidence is immutable on link/attempt.
- [ ] FBS never calls the RFBS verifier and retains product association.
- [ ] RFBS without exact evidence never reaches product or stock writes.
- [ ] Generic listing callers cannot enable RFBS with only a warehouse ID.
- [ ] Product success plus stock failure never duplicates product import.
- [ ] Public DTOs/logs contain no API Key, evidence hash or raw Ozon body.
- [ ] Real Ozon writes remain explicitly unverified until separately authorized.

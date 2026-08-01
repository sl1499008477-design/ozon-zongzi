# Seller-Assisted Async Ozon Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ozon collection succeed immediately with public product data, then safely enrich category and package measurements through the browser's current Seller session without refreshing user-owned Seller pages.

**Architecture:** The server owns an account-scoped, idempotent enrichment state machine linked to the collected item. The extension is a read-only execution agent: it observes the latest trusted Seller Company ID, claims server-created work, captures data with a frozen context revision, and returns a white-listed result; the server merges only blank fields and enforces completeness again at listing time.

**Tech Stack:** Node.js ESM server, PostgreSQL and JSON fallback persistence, Chrome Manifest V3 extension, React 19 + Ant Design, Node built-in test runner.

## Global Constraints

- Follow the repository `AGENTS.md` rules supplied by the user; do not use the retired `sonli-project-analysis` skill.
- Do not add third-party dependencies.
- Public Ozon data must enter the account-level collection box before enrichment completes.
- Missing Seller login, an offline extension, or a retryable Ozon failure must never delete or reject the collected product.
- Category, package weight, package length, package width, and package height must be complete before backend listing submission is allowed.
- Seller cookies, passwords, verification codes, and auth tokens must remain in the browser and must never enter API bodies, logs, audit records, or product JSON.
- Never reload or close a Seller tab created by the user. The extension may create, reuse, and close only its own inactive recovery tab.
- The latest trusted Seller switch event defines the current Company ID; an in-flight result from an older context revision must be discarded.
- Enrichment fills blank fields only and must not overwrite values manually saved by the user.
- Source Ozon category evidence remains separate from the selected operating store's target listing category.
- Every query, mutation, cache lookup, task claim, and result merge remains scoped by the server-authenticated account.
- Database changes are additive and backward-compatible; rollback leaves new columns unused instead of dropping them.
- Extension release version for this change is `0.13.46.2`.

---

## File Structure and Responsibilities

- `server/collect-enrichment-policy.mjs`: pure completeness, state, merge, retry-delay, and listing-gate rules.
- `server/db/migrations/021_async_collect_enrichment.sql`: additive job/cache linkage, retry, and capture-evidence columns.
- `server/collector-ozon-enrichment-repository.mjs`: JSON/PostgreSQL task persistence, leases, deferral, completion evidence, and account isolation.
- `server/collection-pipeline.mjs`: public-first collection ingestion and enrichment-state response.
- `server/collector-ozon-enrichment-service.mjs`: task orchestration, retry classification, merge-before-complete, and audit events.
- `server/collector-ozon-enrichment-routes.mjs`: stable request/response contracts, manual retry, and sensitive-field rejection.
- `server/collector-ozon-enrichment-runtime.mjs`: persistence adapters and collect-item merge dependency wiring.
- `server/index.mjs`: HTTP route composition and final listing gate.
- `extension/lib/seller-identity-policy.js`: trusted observation ordering and conflict policy.
- `extension/lib/seller-company-context-runtime.js`: revisioned current-context snapshots.
- `extension/lib/seller-recovery-tab.js`: extension-owned inactive Seller recovery-tab lifecycle.
- `extension/background/collector-ozon-enrichment-agent.js`: asynchronous claim, frozen-context capture, result, and deferral.
- `extension/lib/ozon-collect-coordinator.js`: upload public data first; no synchronous enrichment prerequisite.
- `extension/background/service-worker.js`: alarm scheduling, task kicks, Seller status API, and removal of automatic user-tab reloads.
- `extension/popup/*` and `extension/content/ozon-data-panel.js`: Seller recognition and collection-state presentation.
- `app/src/collect-enrichment-view.js`: pure Chinese status/view mapping.
- `app/src/App.jsx`: collection-box and edit-page status, missing fields, retry action, and listing disabled state.

---

### Task 1: Pure Enrichment Domain Policy

**Files:**
- Create: `server/collect-enrichment-policy.mjs`
- Modify: `server/collector-ozon-enrichment-contract.mjs`
- Test: `server/tests/ozon-collection-completeness-gate.test.mjs`
- Test: `server/tests/collector-ozon-enrichment-contract.test.mjs`

**Interfaces:**
- Produces: `OZON_ENRICHMENT_FIELDS`, `missingOzonEnrichmentFields(payload)`, `buildOzonEnrichmentSummary(payload, overrides)`, `mergeOzonEnrichmentResult(current, result)`, `retryDelayMs(attemptCount)`, and `assertOzonListingReady(payload)`.
- Consumes: existing `normalizeOzonAgentResult` and v1 result shape from `collector-ozon-enrichment-contract.mjs`.

- [ ] **Step 1: Write failing pure-policy tests**

Add tests with these exact expectations:

```js
test("incomplete Ozon payload is collectible but pending enrichment", () => {
  assert.deepEqual(buildOzonEnrichmentSummary({
    sku: "4862904234",
    name: "Public title",
  }), {
    status: "PENDING_ENRICHMENT",
    missingFields: ["descriptionCategoryId", "weightG", "lengthMm", "widthMm", "heightMm"],
    attemptCount: 0,
    nextAttemptAt: "",
    lastErrorCode: "",
  });
});

test("enrichment fills blanks without overwriting user values", () => {
  const merged = mergeOzonEnrichmentResult({
    descriptionCategoryId: 700,
    logistics: { weightG: 888, lengthMm: 0, widthMm: 0, heightMm: 0 },
  }, completeResult({ descriptionCategoryId: 900 }));
  assert.equal(merged.descriptionCategoryId, 700);
  assert.equal(merged.logistics.weightG, 888);
  assert.deepEqual(merged.logistics, {
    weightG: 888,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 100,
  });
});
```

- [ ] **Step 2: Run the policy tests and verify failure**

Run:

```bash
node --test server/tests/ozon-collection-completeness-gate.test.mjs server/tests/collector-ozon-enrichment-contract.test.mjs
```

Expected: FAIL because `collect-enrichment-policy.mjs` and its exports do not exist.

- [ ] **Step 3: Implement the pure policy**

Implement the exported API with this stable field order and state shape:

```js
export const OZON_ENRICHMENT_FIELDS = Object.freeze([
  "descriptionCategoryId",
  "weightG",
  "lengthMm",
  "widthMm",
  "heightMm",
]);

export function buildOzonEnrichmentSummary(payload, overrides = {}) {
  const missingFields = missingOzonEnrichmentFields(payload);
  return {
    status: missingFields.length ? "PENDING_ENRICHMENT" : "COMPLETE",
    missingFields,
    attemptCount: 0,
    nextAttemptAt: "",
    lastErrorCode: "",
    ...sanitizeSummaryOverrides(overrides),
  };
}
```

`mergeOzonEnrichmentResult` must copy only positive normalized numbers into blank source fields and must preserve unrelated draft keys. `retryDelayMs` must return `30_000`, `120_000`, `600_000`, `1_800_000`, then cap at `3_600_000`. `assertOzonListingReady` must throw code `COLLECT_ENRICHMENT_INCOMPLETE` with the stable missing-field array.

- [ ] **Step 4: Run the policy tests and verify pass**

Run the command from Step 2.

Expected: PASS, including the former complete-payload assertions and the new public-first policy assertions.

- [ ] **Step 5: Commit Task 1**

```bash
git add server/collect-enrichment-policy.mjs server/collector-ozon-enrichment-contract.mjs server/tests/ozon-collection-completeness-gate.test.mjs server/tests/collector-ozon-enrichment-contract.test.mjs
git commit -m "feat(server): define asynchronous collection enrichment policy"
```

---

### Task 2: Durable Linked Jobs, Retry Scheduling, and Capture Evidence

**Files:**
- Create: `server/db/migrations/021_async_collect_enrichment.sql`
- Modify: `server/collector-ozon-enrichment-repository.mjs`
- Test: `server/tests/collector-ozon-enrichment-migration.test.mjs`
- Test: `server/tests/collector-ozon-enrichment-repository.test.mjs`
- Test: `server/tests/account-deletion-relational.test.mjs`

**Interfaces:**
- Consumes: `retryDelayMs(attemptCount)` from Task 1.
- Produces: repository methods `enqueueForCollect(input)`, `deferClaim(input)`, and extended `completeJobAndCache(input)` with `captureContext`.

- [ ] **Step 1: Write failing migration and repository tests**

Add assertions that the migration creates these additive fields and that both JSON and PostgreSQL adapters enforce the same behavior:

```js
assert.match(sql, /ADD COLUMN IF NOT EXISTS collect_item_id TEXT/);
assert.match(sql, /ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0/);
assert.match(sql, /ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
assert.match(sql, /ADD COLUMN IF NOT EXISTS capture_context_json JSONB/);

const first = await repository.enqueueForCollect({
  accountId: "account-a",
  collectItemId: "collect-a",
  requestId: "collect-request-a",
  sku: "4862904234",
  refreshBundle: {},
  now,
});
const duplicate = await repository.enqueueForCollect({
  accountId: "account-a",
  collectItemId: "collect-a",
  requestId: "collect-request-a",
  sku: "4862904234",
  refreshBundle: {},
  now,
});
assert.equal(duplicate.id, first.id);
```

Also prove that account B cannot read, claim, defer, complete, or delete account A's linked job.

- [ ] **Step 2: Run repository tests and verify failure**

```bash
node --test server/tests/collector-ozon-enrichment-migration.test.mjs server/tests/collector-ozon-enrichment-repository.test.mjs server/tests/account-deletion-relational.test.mjs
```

Expected: FAIL because migration 021 and the new repository methods are absent.

- [ ] **Step 3: Add the compatible migration**

Use additive SQL with these concrete columns:

```sql
ALTER TABLE collector_ozon_enrichment_jobs
  ADD COLUMN IF NOT EXISTS collect_item_id TEXT REFERENCES collect_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_error_json JSONB,
  ADD COLUMN IF NOT EXISTS capture_context_json JSONB;

ALTER TABLE collector_ozon_enrichment_cache
  ADD COLUMN IF NOT EXISTS capture_context_json JSONB;
```

Replace the pending index with an account-scoped index ordered by `next_attempt_at, created_at, id`. Do not delete or rewrite existing rows.

- [ ] **Step 4: Implement JSON and PostgreSQL repository parity**

`enqueueForCollect` must be unique by `(accountId, requestId, sku)`, verify that a reused job points to the same account and collect item, and return the existing job on identical replay. `claimNextJob` must skip future `nextAttemptAt` values. `deferClaim` must verify the claim owner, increment `attemptCount`, set the next attempt, clear the lease, keep status `PENDING`, and store only stable error fields. Completion must store:

```js
captureContext: {
  sellerCompanyId: "2681910",
  revision: 4,
  observedAt: "2026-08-01T08:00:00.000Z",
}
```

Reject any capture-context key outside that exact allowlist.

- [ ] **Step 5: Run repository tests and verify pass**

Run the command from Step 2.

Expected: PASS in JSON mode; PostgreSQL-specific checks remain explicitly skipped only when PostgreSQL is not configured.

- [ ] **Step 6: Commit Task 2**

```bash
git add server/db/migrations/021_async_collect_enrichment.sql server/collector-ozon-enrichment-repository.mjs server/tests/collector-ozon-enrichment-migration.test.mjs server/tests/collector-ozon-enrichment-repository.test.mjs server/tests/account-deletion-relational.test.mjs
git commit -m "feat(server): persist linked enrichment retries"
```

---

### Task 3: Public-First Collection Ingestion

**Files:**
- Modify: `server/collection-pipeline.mjs`
- Modify: `server/account-scoped-collection-routes.mjs`
- Modify: `server/collector-ozon-enrichment-runtime.mjs`
- Modify: `server/index.mjs`
- Test: `server/tests/ozon-collection-completeness-gate.test.mjs`
- Test: `server/tests/account-scoped-collection.test.mjs`
- Test: `server/tests/collection-pipeline-v4.integration.mjs`
- Test: `server/tests/collector-ozon-enrichment-runtime.test.mjs`

**Interfaces:**
- Consumes: `buildOzonEnrichmentSummary` and `repository.enqueueForCollect`.
- Produces: collection response field `enrichment` and a linked pending job for incomplete Ozon data.

- [ ] **Step 1: Replace rejection expectations with public-first expectations**

Add a single-item test with this response contract:

```js
const result = await ingestCollectRequestV4({
  authenticatedAccount: { id: "account-a" },
  input: collectInput({
    sourceSku: "4862904234",
    requestId: "public-first-a",
    payload: { sku: "4862904234", name: "Public title" },
  }),
});
assert.equal(result.item.name, "Public title");
assert.equal(result.enrichment.status, "PENDING_ENRICHMENT");
assert.deepEqual(result.enrichment.missingFields, [
  "descriptionCategoryId", "weightG", "lengthMm", "widthMm", "heightMm",
]);
assert.equal(queued.collectItemId, result.collectItemId);
```

Keep tests proving invalid account scope, missing SKU, missing request ID, and duplicate request conflicts still fail closed.

- [ ] **Step 2: Run collection tests and verify failure**

```bash
node --test server/tests/ozon-collection-completeness-gate.test.mjs server/tests/account-scoped-collection.test.mjs server/tests/collection-pipeline-v4.integration.mjs server/tests/collector-ozon-enrichment-runtime.test.mjs
```

Expected: FAIL because incomplete Ozon payloads are still rejected before persistence.

- [ ] **Step 3: Make ingestion compute state instead of demanding completeness**

Keep `prepareCompleteCollectRequestV4` for callers that explicitly need the old strict assertion, but make `ingestCollectRequestV4` use `prepareCollectRequestV4` plus `buildOzonEnrichmentSummary`. Store the summary inside the product data under the exact `enrichment` key and return it at the response top level.

For PostgreSQL, enqueue the linked job inside the same database transaction used to mirror the collect item by constructing `createPostgresCollectorOzonEnrichmentRepository({ pool: client })` with that transaction client and calling `enqueueForCollect` before commit. For JSON fallback, add the item and linked job inside the same `stateTransaction` save. If either write fails, neither the successful response nor a half-linked task may be returned.

- [ ] **Step 4: Make batch preflight validate shape, not completeness**

`/sources/ozon/collect/batch` must preflight authentication, scope, request ID, source SKU, and payload shape for every row before writing. It must not reject rows only because the five enrichment fields are absent. Each result must include:

```js
{
  index,
  sku,
  action: "created",
  collectItemId,
  collectRequestId,
  enrichment: {
    status: "PENDING_ENRICHMENT",
    missingFields: ["descriptionCategoryId", "weightG", "lengthMm", "widthMm", "heightMm"],
  },
}
```

- [ ] **Step 5: Run collection tests and verify pass**

Run the command from Step 2.

Expected: PASS for JSON and configured PostgreSQL modes; no duplicate item or job on replay.

- [ ] **Step 6: Commit Task 3**

```bash
git add server/collection-pipeline.mjs server/account-scoped-collection-routes.mjs server/collector-ozon-enrichment-runtime.mjs server/index.mjs server/tests/ozon-collection-completeness-gate.test.mjs server/tests/account-scoped-collection.test.mjs server/tests/collection-pipeline-v4.integration.mjs server/tests/collector-ozon-enrichment-runtime.test.mjs
git commit -m "feat(server): collect public Ozon data before enrichment"
```

---

### Task 4: Retryable Completion, Safe Merge, and Manual Retry

**Files:**
- Modify: `server/collector-ozon-enrichment-service.mjs`
- Modify: `server/collector-ozon-enrichment-routes.mjs`
- Modify: `server/collector-ozon-enrichment-runtime.mjs`
- Modify: `server/listing-pipeline.mjs`
- Modify: `server/index.mjs`
- Test: `server/tests/collector-ozon-enrichment-service.test.mjs`
- Test: `server/tests/collector-ozon-enrichment-routes.test.mjs`
- Test: `server/tests/collector-ozon-enrichment-runtime.test.mjs`
- Create: `server/tests/collect-item-update-concurrency.test.mjs`

**Interfaces:**
- Consumes: Task 1 merge/retry policy and Task 2 repository methods.
- Produces: `completeClaim({ session, jobId, variantData, captureContext })`, `deferClaim`, and `POST /ozon/collect-box/:id/enrichment/retry`.

- [ ] **Step 1: Write failing service, route, and concurrency tests**

Cover these exact cases:

```js
await service.completeClaim({
  session: collectorSession,
  jobId: job.id,
  variantData: completeVariantData(),
  captureContext: {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-08-01T08:00:00.000Z",
  },
});
assert.equal(savedDraft.logistics.weightG, 777); // manually saved before completion
assert.equal(savedDraft.logistics.lengthMm, 300); // blank field filled
assert.equal(audit.metadata.sellerCompanyId, "2681910");
assert.equal(JSON.stringify(audit).includes("cookie"), false);
```

Also test that `SELLER_CONTEXT_REQUIRED`, 429, timeout, and 5xx defer the task; `OZON_ENRICH_NOT_FOUND` becomes `NEEDS_ATTENTION`; a second manual retry reuses the same account/SKU identity; and another account receives 404 rather than learning the item exists.

- [ ] **Step 2: Run service tests and verify failure**

```bash
node --test server/tests/collector-ozon-enrichment-service.test.mjs server/tests/collector-ozon-enrichment-routes.test.mjs server/tests/collector-ozon-enrichment-runtime.test.mjs server/tests/collect-item-update-concurrency.test.mjs
```

Expected: FAIL because result capture context, deferred retry, and collect-item merging are not implemented.

- [ ] **Step 3: Validate and persist the result envelope**

Change the result route to accept only:

```js
{
  variantData: {
    description_category_id: 17000001,
    type_id: 97000001,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    attributes: [],
  },
  captureContext: {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-08-01T08:00:00.000Z",
  },
}
```

Reject unknown keys, invalid IDs, non-positive revisions, future timestamps beyond the existing clock-skew allowance, retired store/account scope fields, and any sensitive key or secret-looking value.

- [ ] **Step 4: Merge before marking the task complete**

Normalize the Seller result with source `EXTENSION_SELLER_CAPTURE`. Load the latest draft, call `mergeOzonEnrichmentResult`, and save with the existing expected-version contract. On a version conflict, reload and repeat the fill-blank merge up to four times. Only after an idempotent merge succeeds may the repository mark the task/cache `SUCCESS`.

Update the collection summary to:

```js
{
  status: "COMPLETE",
  missingFields: [],
  attemptCount,
  nextAttemptAt: "",
  lastErrorCode: "",
  capturedAt,
}
```

- [ ] **Step 5: Implement retry classification and manual retry**

Retryable failures keep the task pending and update the linked item to `WAITING_FOR_SELLER` for Seller-auth/context codes or `RETRYING` for network/Ozon transient codes. Add `SELLER_CONTEXT_REQUIRED` and `SELLER_CONTEXT_CHANGED` to the route and extension public error-code allowlists. Use `retryDelayMs`. Permanent missing/invalid data sets `NEEDS_ATTENTION` without deleting the item. The manual retry route authenticates the account, clears only the stable error state, and schedules `nextAttemptAt` to now.

- [ ] **Step 6: Run service tests and verify pass**

Run the command from Step 2.

Expected: PASS with no user-value overwrite, no cross-account access, and no sensitive data in results or audits.

- [ ] **Step 7: Commit Task 4**

```bash
git add server/collector-ozon-enrichment-service.mjs server/collector-ozon-enrichment-routes.mjs server/collector-ozon-enrichment-runtime.mjs server/listing-pipeline.mjs server/index.mjs server/tests/collector-ozon-enrichment-service.test.mjs server/tests/collector-ozon-enrichment-routes.test.mjs server/tests/collector-ozon-enrichment-runtime.test.mjs server/tests/collect-item-update-concurrency.test.mjs
git commit -m "feat(server): merge and retry collected product enrichment"
```

---

### Task 5: Backend Listing Completeness Gate

**Files:**
- Modify: `server/index.mjs`
- Modify: `server/listing-pipeline.mjs`
- Test: `server/tests/collect-listing-submit-failure.test.mjs`
- Test: `server/tests/listing-pipeline-v3.integration.mjs`

**Interfaces:**
- Consumes: `assertOzonListingReady(payload)` from Task 1.
- Produces: stable HTTP error `COLLECT_ENRICHMENT_INCOMPLETE` with `missingFields`.

- [ ] **Step 1: Write failing preview and submit gate tests**

```js
const response = await invoke(
  "POST",
  `/ozon/collect-box/${collectId}/listing/submit`,
  { targetStoreId: "store-a", idempotencyKey: "list-incomplete-a" },
);
assert.equal(response.status, 422);
assert.equal(response.body.code, "COLLECT_ENRICHMENT_INCOMPLETE");
assert.deepEqual(response.body.missingFields, ["weightG", "lengthMm", "widthMm", "heightMm"]);
assert.equal(enqueuedJobs.length, 0);
```

Add the same assertion at the lower listing-pipeline entry point so an alternate route cannot bypass the gate.

- [ ] **Step 2: Run listing tests and verify failure**

```bash
node --test server/tests/collect-listing-submit-failure.test.mjs server/tests/listing-pipeline-v3.integration.mjs
```

Expected: FAIL because incomplete collected items can reach later draft validation without the stable enrichment error.

- [ ] **Step 3: Enforce the gate in both route and pipeline**

Call `assertOzonListingReady` before creating a preview, queue record, outbox event, or external Ozon request. Preserve the thrown `status`, `code`, and `missingFields` in `sendJson`. Do not treat front-end disabled buttons as authorization or validation.

- [ ] **Step 4: Run listing tests and verify pass**

Run the command from Step 2.

Expected: PASS; incomplete items have zero listing side effects, complete existing items still preview and enqueue.

- [ ] **Step 5: Commit Task 5**

```bash
git add server/index.mjs server/listing-pipeline.mjs server/tests/collect-listing-submit-failure.test.mjs server/tests/listing-pipeline-v3.integration.mjs
git commit -m "fix(server): block listing until enrichment is complete"
```

---

### Task 6: Revisioned Seller Context and Non-Disruptive Recovery

**Files:**
- Create: `extension/lib/seller-recovery-tab.js`
- Modify: `extension/lib/seller-identity-policy.js`
- Modify: `extension/lib/seller-company-context-runtime.js`
- Modify: `extension/content/seller-company-context-hook.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/manifest.json`
- Test: `extension/tests/seller-identity-policy.test.js`
- Test: `extension/tests/seller-company-context-contract.test.js`
- Test: `extension/tests/seller-company-context.test.js`
- Test: `extension/tests/sync-capability-removed.test.js`

**Interfaces:**
- Produces: `snapshotCurrent() -> { companyId, revision, observedAt, sellerTabId }`, `resolveCurrentWithRecovery()`, `isSnapshotCurrent(snapshot)`, and recovery status `READY | RECOVERING | LOGIN_REQUIRED`.
- Consumes: trusted Company ID observations from the existing Seller main-world hook.

- [ ] **Step 1: Rewrite recovery tests before implementation**

Delete expectations that `chrome.tabs.reload` is called. Add tests proving:

```js
assert.deepEqual(userTabReloadCalls, []);
assert.deepEqual(userTabRemoveCalls, []);
assert.deepEqual(createdTabs, [{ url: "https://seller.ozon.ru/app", active: false }]);
assert.deepEqual(removedTabs, [createdTabs[0].id]);
```

Add two-tab observations where the most recently observed trusted Company ID wins, increments revision, and an older snapshot fails `isSnapshotCurrent`. Add a flapping-context test that reports `RECOVERING` and does not return an arbitrary ID.

- [ ] **Step 2: Run Seller context tests and verify failure**

```bash
node --test extension/tests/seller-identity-policy.test.js extension/tests/seller-company-context-contract.test.js extension/tests/seller-company-context.test.js extension/tests/sync-capability-removed.test.js
```

Expected: FAIL because the current runtime reloads an active Seller tab and has no revision API.

- [ ] **Step 3: Implement ordered trusted observations**

Store one global current observation plus per-tab evidence in `chrome.storage.session`:

```js
{
  companyId: "2681910",
  observedAt: 1785552000000,
  revision: 4,
  tabId: 17,
}
```

Only a top-frame message from exact HTTPS host `seller.ozon.ru` may advance it. Duplicate observations of the same Company ID refresh `observedAt` without changing revision. A different ID increments revision. Multiple recent different IDs inside the stabilization window report `RECOVERING` until the latest value remains stable.

- [ ] **Step 4: Implement extension-owned recovery tabs**

`seller-recovery-tab.js` must first query existing Seller bridges without navigation. If no current context is returned, create one inactive `https://seller.ozon.ru/app` tab and tag its ID in session storage. Close only that tagged tab after successful context capture. If it reaches a login URL or times out without context, keep a stable `LOGIN_REQUIRED` result and expose an action that focuses the same helper tab for the user.

- [ ] **Step 5: Remove all automatic user-tab reloads**

Remove `reloadSellerTabs()` and its calls from `runtime.onInstalled` and `runtime.onStartup`. Add `seller-recovery-tab.js` to `importScripts`, manifest/package checks, and runtime construction. Keep the existing exact `setUserCookies` and `x-o3-company-id` observation protections.

- [ ] **Step 6: Run Seller context tests and verify pass**

Run the command from Step 2.

Expected: PASS with zero reload/remove operations against user tabs.

- [ ] **Step 7: Commit Task 6**

```bash
git add extension/lib/seller-recovery-tab.js extension/lib/seller-identity-policy.js extension/lib/seller-company-context-runtime.js extension/content/seller-company-context-hook.js extension/background/service-worker.js extension/manifest.json extension/tests/seller-identity-policy.test.js extension/tests/seller-company-context-contract.test.js extension/tests/seller-company-context.test.js extension/tests/sync-capability-removed.test.js
git commit -m "fix(extension): recover Seller context without refreshing user tabs"
```

---

### Task 7: Asynchronous Extension Worker and Public-First Coordinator

**Files:**
- Modify: `extension/background/collector-ozon-enrichment-agent.js`
- Modify: `extension/lib/ozon-collect-coordinator.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/content/ozon-product.js`
- Modify: `extension/content/ozon-search.js`
- Modify: `extension/content/ozon-data-panel.js`
- Test: `extension/tests/collector-ozon-enrichment-client.test.js`
- Test: `extension/tests/ozon-collect-coordinator.test.js`
- Test: `extension/tests/ozon-product-complete-collection.test.js`
- Test: `extension/tests/ozon-search-complete-collection.test.js`
- Test: `extension/tests/sync-capability-removed.test.js`

**Interfaces:**
- Consumes: Task 3 collection response and Task 6 revisioned Seller context.
- Produces: background `drainAvailable()`, one-minute alarm `collectorOzonEnrichmentTick`, and result envelope `{ variantData, captureContext }`.

- [ ] **Step 1: Write failing public-first coordinator tests**

Replace the synchronous enrichment prerequisite with these assertions:

```js
const outcome = await coordinator.collect({
  sku: SKU,
  raw: { sku: SKU, name: "Public title" },
});
assert.deepEqual(calls.map(({ action }) => action), ["pushSourceCollect"]);
assert.equal(outcome.result.enrichment.status, "PENDING_ENRICHMENT");
assert.equal(coordinator.getState(SKU).status, "SUCCESS");
```

For batch search collection, assert one public upload batch and no `enrichOzonCollectBatch` call before the collection succeeds.

- [ ] **Step 2: Write failing frozen-context agent tests**

Test that the agent claims work, captures with revision 4, detects a switch to revision 5 before reporting, discards the result, and reports a retryable `SELLER_CONTEXT_CHANGED` failure. Test that missing Seller login reports `SELLER_CONTEXT_REQUIRED` so the server can defer the task instead of terminally failing it.

- [ ] **Step 3: Run extension worker tests and verify failure**

```bash
node --test extension/tests/collector-ozon-enrichment-client.test.js extension/tests/ozon-collect-coordinator.test.js extension/tests/ozon-product-complete-collection.test.js extension/tests/ozon-search-complete-collection.test.js extension/tests/sync-capability-removed.test.js
```

Expected: FAIL because collection currently waits for a complete enrichment result and the agent runs only during a held request.

- [ ] **Step 4: Upload public data first**

Change coordinator `collect` so it immediately finalizes and sends `pushSourceCollect` using public raw data. Preserve stable request-ID and in-flight dedupe behavior. Treat `PENDING_ENRICHMENT`, `WAITING_FOR_SELLER`, and `RETRYING` as successful collection outcomes. Remove content-script messages that say missing enrichment data prevented the item from entering the box.

- [ ] **Step 5: Add autonomous task draining**

Expose `drainAvailable({ deadlineAt })` on the agent. The service worker must create `collectorOzonEnrichmentTick` with `periodInMinutes: 1`, kick once after a pending collection upload, and kick on startup/session exchange. Each drain uses existing claim leases and stops when no job is returned or the deadline is reached.

- [ ] **Step 6: Freeze and attest Seller context**

For each claimed job:

```js
const snapshot = await sellerContextRuntime.resolveCurrentWithRecovery();
const capture = await captureVariant({ sku: job.sku, sellerContext: snapshot });
if (!(await sellerContextRuntime.isSnapshotCurrent(snapshot))) {
  throw fixedFailure("SELLER_CONTEXT_CHANGED");
}
await postResult(job.id, {
  variantData: projectVariantData(matchedVariantData(capture, job.sku)),
  captureContext: {
    sellerCompanyId: snapshot.companyId,
    revision: snapshot.revision,
    observedAt: new Date(snapshot.observedAt).toISOString(),
  },
});
```

Ensure `searchVariantsLocal` consumes the frozen Company ID instead of resolving a second potentially different context.

- [ ] **Step 7: Run extension worker tests and verify pass**

Run the command from Step 3.

Expected: PASS; collection success no longer depends on immediate Seller enrichment, and stale-context results never cross the Collector boundary.

- [ ] **Step 8: Commit Task 7**

```bash
git add extension/background/collector-ozon-enrichment-agent.js extension/lib/ozon-collect-coordinator.js extension/background/service-worker.js extension/content/ozon-product.js extension/content/ozon-search.js extension/content/ozon-data-panel.js extension/tests/collector-ozon-enrichment-client.test.js extension/tests/ozon-collect-coordinator.test.js extension/tests/ozon-product-complete-collection.test.js extension/tests/ozon-search-complete-collection.test.js extension/tests/sync-capability-removed.test.js
git commit -m "feat(extension): enrich collected Ozon products asynchronously"
```

---

### Task 8: Seller Status in the Extension UI

**Files:**
- Modify: `extension/popup/popup.html`
- Modify: `extension/popup/popup.css`
- Modify: `extension/popup/popup.js`
- Modify: `extension/content/ozon-data-panel.js`
- Modify: `extension/content/ozon-product.css`
- Modify: `extension/background/service-worker.js`
- Test: `extension/popup/__tests__/popup-collector-session.runtime.test.js`
- Test: `extension/tests/data-panel-visual-browser.test.js`

**Interfaces:**
- Consumes: `getSellerContextStatus` runtime message returning `{ status, companyId, observedAt }` and `openSellerLogin`.
- Produces: visible Chinese status without exposing cookies or internal errors.

- [ ] **Step 1: Write failing popup and data-panel UI tests**

Assert these exact user-visible states:

```js
assert.match(popup.textContent, /Seller 已识别/);
assert.match(popup.textContent, /2681910/);
assert.match(panel.textContent, /需要登录 Seller/);
assert.equal(panel.querySelector("[data-action='open-seller-login']").textContent, "打开 Seller 登录");
assert.doesNotMatch(popup.textContent, /Cookie|token|SELLER_CONTEXT_REQUIRED/);
```

- [ ] **Step 2: Run extension UI tests and verify failure**

```bash
node --test extension/popup/__tests__/popup-collector-session.runtime.test.js extension/tests/data-panel-visual-browser.test.js
```

Expected: FAIL because Seller state is intentionally hidden in the current popup.

- [ ] **Step 3: Add the safe status API and renderers**

`getSellerContextStatus` returns only `READY`, `RECOVERING`, or `LOGIN_REQUIRED`, plus normalized Company ID and observation time. Render:

- `Seller 已识别 · Company ID 2681910`
- `正在识别 Seller 店铺`
- `需要登录 Seller`
- transient `Seller 店铺已切换`

When login is required, `openSellerLogin` focuses the extension-owned helper tab or opens a new Seller login tab. Do not display a guessed store name.

- [ ] **Step 4: Run extension UI tests and verify pass**

Run the command from Step 2.

Expected: PASS at popup viewport and the existing data-panel visual fixture sizes.

- [ ] **Step 5: Commit Task 8**

```bash
git add extension/popup/popup.html extension/popup/popup.css extension/popup/popup.js extension/content/ozon-data-panel.js extension/content/ozon-product.css extension/background/service-worker.js extension/popup/__tests__/popup-collector-session.runtime.test.js extension/tests/data-panel-visual-browser.test.js
git commit -m "feat(extension): show current Seller capture status"
```

---

### Task 9: Web Collection Status, Retry UI, Release Package, and Full Verification

**Files:**
- Create: `app/src/collect-enrichment-view.js`
- Create: `app/tests/collect-enrichment-view.test.mjs`
- Modify: `app/src/App.jsx`
- Modify: `app/src/styles.css`
- Modify: `app/src/collect-box-target-store.js`
- Modify: `app/tests/collect-box-target-store.test.mjs`
- Modify: `extension/manifest.json`
- Modify: `app/src/extension-page-contract.mjs`
- Modify: `server/index.mjs`
- Modify: `package.json`
- Modify: `scripts/package-extension.mjs`
- Generate: `app/public/sonli-extension-0.13.46.2/`
- Generate: `app/public/sonli-extension-0.13.46.2.zip`
- Generate: `app/dist/sonli-extension-0.13.46.2.zip`

**Interfaces:**
- Consumes: server `item.enrichment`, manual retry endpoint, and stable listing error from Tasks 3–5.
- Produces: Web status labels, disabled listing intent, release version `0.13.46.2`, and verified extension artifacts.

- [ ] **Step 1: Write failing pure UI-state tests**

Create `collect-enrichment-view.test.mjs` with exact mappings:

```js
assert.deepEqual(collectEnrichmentView({ status: "PENDING_ENRICHMENT", missingFields: ["weightG"] }), {
  tone: "processing",
  label: "资料补全中",
  detail: "缺少：包装重量",
  retryable: false,
  listingBlocked: true,
});
assert.equal(collectEnrichmentView({ status: "WAITING_FOR_SELLER" }).label, "等待 Seller 登录");
assert.equal(collectEnrichmentView({ status: "RETRYING" }).label, "正在自动重试");
assert.equal(collectEnrichmentView({ status: "NEEDS_ATTENTION" }).retryable, true);
assert.equal(collectEnrichmentView({ status: "COMPLETE" }).listingBlocked, false);
```

Add a target-store test proving that a selected store cannot make an incomplete item listing-ready.

- [ ] **Step 2: Run Web tests and verify failure**

```bash
node --test app/tests/collect-enrichment-view.test.mjs app/tests/collect-box-target-store.test.mjs
```

Expected: FAIL because the view mapper and listing-blocked model do not exist.

- [ ] **Step 3: Implement collection-box and edit-page state**

Render status tags and missing fields on collection list rows and the edit page. Change successful partial collection copy to `已加入采集箱，资料正在后台补全`. Show a `重新补全` button only for `NEEDS_ATTENTION`; call `POST /ozon/collect-box/:id/enrichment/retry`, then reload the item. While any visible item is pending/waiting/retrying, refresh collection data every five seconds and stop polling when no such item remains.

Disable listing controls in the UI when `listingBlocked` is true, while preserving the backend gate. If the backend returns `COLLECT_ENRICHMENT_INCOMPLETE`, show the stable missing-field names in Chinese and do not mark the item itself as a failed listing submission.

- [ ] **Step 4: Run Web tests and build**

```bash
node --test app/tests/collect-enrichment-view.test.mjs app/tests/collect-box-target-store.test.mjs
pnpm --dir app build
```

Expected: PASS and a successful Vite production build.

- [ ] **Step 5: Bump and package extension version 0.13.46.2**

Set the same exact version in `extension/manifest.json`, `app/src/extension-page-contract.mjs`, root package version `0.13.46.2-local`, and `/extension/latest`. The local update endpoint must return `/sonli-extension-0.13.46.2.zip`. Add `lib/seller-recovery-tab.js` to `collectorRuntimeFiles`, then run:

```bash
npm run package-extension
```

Expected: unpacked and zip artifacts are generated for `0.13.46.2` in both public and dist targets.

- [ ] **Step 6: Run targeted cross-layer regression**

```bash
node --test server/tests/ozon-collection-completeness-gate.test.mjs server/tests/collector-ozon-enrichment-service.test.mjs server/tests/collect-listing-submit-failure.test.mjs extension/tests/seller-company-context-contract.test.js extension/tests/collector-ozon-enrichment-client.test.js extension/tests/ozon-collect-coordinator.test.js extension/popup/__tests__/popup-collector-session.runtime.test.js app/tests/collect-enrichment-view.test.mjs app/tests/collect-box-target-store.test.mjs
```

Expected: all targeted tests pass.

- [ ] **Step 7: Run complete repository verification**

```bash
npm run verify
```

Expected: App build, extension parity/zip checks, active test inventory, complete test suite, security scan, database/config checks, and diff whitespace all pass. Any PostgreSQL test skipped because no configured database must be explicitly reported as unverified, not described as passing.

- [ ] **Step 8: Perform browser regression against the local app**

Use the unpacked `app/public/sonli-extension-0.13.46.2` extension and verify:

1. Seller logged in: public data enters the box before category/dimensions finish, then the same item completes.
2. Seller logged out: item remains with `等待 Seller 登录`; login resumes it.
3. Seller store switch: Company ID changes without manual refresh; an older in-flight result is not applied.
4. Open Seller edit form: context recovery does not reload the tab or lose form input.
5. Manually edit weight during enrichment: the manual value survives completion.
6. Extension offline then online: one item and one recoverable task remain; no duplicate is created.
7. Incomplete item listing: both UI and backend block submission.

- [ ] **Step 9: Commit Task 9**

```bash
git add app/src/collect-enrichment-view.js app/tests/collect-enrichment-view.test.mjs app/src/App.jsx app/src/styles.css app/src/collect-box-target-store.js app/tests/collect-box-target-store.test.mjs extension/manifest.json app/src/extension-page-contract.mjs server/index.mjs package.json scripts/package-extension.mjs app/public/sonli-extension-0.13.46.2 app/public/sonli-extension-0.13.46.2.zip app/dist/sonli-extension-0.13.46.2.zip
git commit -m "feat: deliver Seller-assisted asynchronous enrichment"
```

---

## Final Delivery Checklist

- [ ] Summarize changed behavior, files, and API contracts.
- [ ] Report targeted tests and full verification with exact pass/fail/skip counts.
- [ ] Report browser scenarios actually verified and any Ozon behavior that could not be verified.
- [ ] Confirm old collection, account isolation, listing, extension login, and packaging regressions checked.
- [ ] Rollback: restore the previous Web/server/extension commits; leave migration 021 columns unused; reinstall the previous `0.13.46.1` unpacked extension if necessary.
- [ ] Preserve unrelated user changes in `docs/plans/2026-08-01-seller-context-auto-recovery-design.md` and `docs/superpowers/plans/2026-08-01-seller-context-auto-recovery.md`.

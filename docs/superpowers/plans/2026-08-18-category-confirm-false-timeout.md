# Category Confirmation False Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a successful category sample confirmation from being reported as failed because serial image preparation exceeds the extension worker timeout.

**Architecture:** Keep the existing synchronous, idempotent confirmation contract. Reduce repeated waiting by preparing samples in ordered batches of at most eight, then align the category confirmation worker timeout with the existing 600-second content timeout.

**Tech Stack:** Node.js ESM, Chrome MV3 extension, built-in `node:test`, PostgreSQL repository contract, existing extension packaging scripts.

**Spec:** `docs/superpowers/specs/2026-08-18-category-confirm-false-timeout-design.md`

## Global Constraints

- Preserve the public API, database schema, account/permission boundaries, session secret handling, exact category checks, sample-count gate, atomic commit, and idempotency keys.
- Prepare at most 8 samples concurrently and preserve input order.
- Keep the existing per-image limit of 6 images and 10000 milliseconds.
- Use 600000 milliseconds for category confirmation in both the content script and service worker; do not change unrelated action timeouts.
- Do not add dependencies, queues, background job tables, retry frameworks, or unrelated refactors.
- Publish the extension as version `0.13.46.15` and keep source, public directory, and ZIP byte-consistent.

---

### Task 1: Bounded sample preparation

**Files:**
- Modify: `server/auto-listing-category-strategy-service.mjs`
- Test: `server/tests/auto-listing-category-strategy-service.test.mjs`

**Interfaces:**
- Consumes: `verified` facts in selected sample order and `sampleStore.persistSampleImages(input)`.
- Produces: the same ordered `samples` array passed once to `repository.commitSampleSetCanonical`.

- [x] **Step 1: Write the failing concurrency and ordering test**

Extend the service harness with an optional `persistSampleImages` implementation. Confirm 20 selected samples with a fake that counts active calls, waits briefly, and returns the existing complete evidence fixture. Assert `maxActive === 8`, `calls.persist === 20`, and committed SKU order equals the literal selected order `sku-1` through `sku-20`.

- [x] **Step 2: Run the test to verify RED**

Run:

```bash
node --test --test-name-pattern="prepares at most eight samples" server/tests/auto-listing-category-strategy-service.test.mjs
```

Expected: fail because the current sequential loop reports `maxActive === 1`.

- [x] **Step 3: Implement ordered batches**

In `confirmSampleSet`, replace only the sequential image-preparation loop with batches of eight:

```js
const samples = [];
for (let offset = 0; offset < verified.length; offset += 8) {
  const batch = await Promise.all(verified.slice(offset, offset + 8).map(async (fact, batchIndex) => {
    const ordinal = offset + batchIndex;
    const sampleId = operationId("sample", accountId, draftId, idempotencyKey,
      String(ordinal), fact.sku, String(fact.sourceProductId));
    const images = await sampleStore.persistSampleImages({ accountId, draftId, sampleSetId, sampleId,
      correlationId, sourceReferences: fact.sourceReferences });
    return { sampleSetId, sampleId, sku: fact.sku, sourceProductId: fact.sourceProductId,
      sourceProductRef: fact.sourceProductRef,
      sourceProductResponseHash: fact.sourceProductResponseHash,
      taxonomyScope: draft.scope.taxonomyScope,
      descriptionCategoryId: draft.scope.descriptionCategoryId,
      typeId: draft.scope.typeId, images };
  }));
  samples.push(...batch);
}
```

Retain the existing dependency error mapping around each persistence call.

- [x] **Step 4: Run focused and related tests**

Run:

```bash
node --test server/tests/auto-listing-category-strategy-service.test.mjs server/tests/auto-listing-category-strategy-sample-store.test.mjs
```

Expected: all pass; the new test proves bounded parallelism and order.

- [x] **Step 5: Commit Task 1**

```bash
git add server/auto-listing-category-strategy-service.mjs server/tests/auto-listing-category-strategy-service.test.mjs
git commit -m "perf: bound category sample preparation"
```

### Task 2: Align extension confirmation timeout and package the release

**Files:**
- Modify: `extension/lib/category-strategy-sampling.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/tests/category-strategy-sampling.test.js`
- Modify: `extension/tests/category-strategy-service-worker-routing.test.js`
- Modify: `extension/manifest.json`
- Modify: `package.json`
- Modify: `app/src/extension-page-contract.mjs`
- Modify: `server/index.mjs`
- Generate: `app/public/sonli-extension-0.13.46.15/`
- Generate: `app/public/sonli-extension-0.13.46.15.zip`

**Interfaces:**
- Consumes: `CATEGORY_STRATEGY_SAMPLES_CONFIRM` and the existing 600000-millisecond content-side timeout.
- Produces: `JzCategoryStrategySampling.CONFIRM_HANDLER_TIMEOUT_MS === 600000`, consumed by service worker only for category confirmation.

- [x] **Step 1: Write the failing timeout contract test**

Add a runtime assertion in `category-strategy-sampling.test.js` that the exported category confirmation handler timeout is `600000`. Update the service-worker routing test to require that the category branch consumes `JzCategoryStrategySampling.CONFIRM_HANDLER_TIMEOUT_MS`, and reject the old hard-coded `150_000` category branch.

- [x] **Step 2: Run the tests to verify RED**

Run:

```bash
node extension/tests/category-strategy-sampling.test.js
node extension/tests/category-strategy-service-worker-routing.test.js
```

Expected: fail because the runtime does not export the timeout and the worker still uses 150000 milliseconds.

- [x] **Step 3: Implement the timeout alignment**

Export `CONFIRM_HANDLER_TIMEOUT_MS: 600_000` from the existing category sampling module. In the worker timeout selection, keep video and AI action behavior unchanged and use the exported value only when `CATEGORY_STRATEGY_LONG_ACTIONS` contains the action.

- [x] **Step 4: Bump and package extension `0.13.46.15`**

Update the four authoritative version carriers, run:

```bash
node scripts/package-extension.mjs
```

Do not edit generated release files manually.

- [x] **Step 5: Verify extension and release parity**

Run:

```bash
node extension/tests/category-strategy-sampling.test.js
node extension/tests/category-strategy-service-worker-routing.test.js
node scripts/check-extension-source-parity.mjs
node scripts/check-extension-zip.mjs
node --test server/tests/extension-release-contract.test.mjs
```

Expected: all pass; public source and ZIP match extension source and version 0.13.46.15.

- [x] **Step 6: Commit Task 2**

```bash
git add extension app/public app/src/extension-page-contract.mjs package.json server/index.mjs
git commit -m "fix: prevent category confirmation false timeout"
```

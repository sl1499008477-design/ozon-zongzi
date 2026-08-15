# Auto-Listing Missing Product Dimensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow auto-listing jobs to continue per item without a specification image when trusted product measurements are unavailable, reducing that item's final image total instead of reallocating or failing.

**Architecture:** Keep the submitted frozen image configuration immutable, then derive a closed `effectiveImageConfig` from the verified source snapshot for each item. Use the same downgrade rule in content planning so fixed skeletons and AI calls consume zero specification slots and a reduced total while retaining `PRODUCT_DIMENSIONS_UNAVAILABLE` as audit evidence.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL-backed immutable job graph contracts, existing auto-listing content planner and fixed skeleton pipeline.

## Global Constraints

- Only trusted `snapshot.productMeasurements` may support a specification image.
- `logistics`, package weight, and package dimensions must never qualify as product measurements.
- Missing trusted product measurements set only `specification` to `0`; all other role counts remain unchanged.
- Removed specification slots are not reallocated, so the effective total decreases by the removed count.
- The decision is per item; mixed batches preserve specification images only for siblings with trusted measurements.
- The downgrade must occur before paid AI or image generation calls and retain `PRODUCT_DIMENSIONS_UNAVAILABLE` for audit.
- Preserve the frozen user configuration, tenant boundaries, permission checks, idempotency, hashes, source verification, and persistence recomputation.
- No database migration or external API contract expansion is required.
- Preserve unrelated working-tree changes; stage and commit only the files named by each task.

---

## File Map

- `server/auto-listing-item-image-config.mjs`: authoritative per-item effective image configuration derived from a verified source capture.
- `server/tests/auto-listing-item-image-config.test.mjs`: focused trusted/untrusted measurement contract.
- `server/tests/auto-listing-contract.test.mjs`: aggregate frozen-config and source-evidence regression coverage.
- `server/auto-listing-content-planner.mjs`: planner role counts, diagnostics, and fixed-skeleton preflight behavior.
- `server/tests/auto-listing-content-planner.test.mjs`: planner and AI-boundary regressions.
- `server/tests/auto-listing-service.test.mjs`: mixed-batch job graph acceptance and per-item effective config.
- `app/src/auto-listing-config.js`, `server/auto-listing-routes.mjs`, and their current tests: retain the defensive public error mapping already present in the working tree; normal creation must no longer emit that error.

### Task 1: Derive a reduced per-item image configuration

**Files:**
- Modify: `server/tests/auto-listing-item-image-config.test.mjs:70-100`
- Modify: `server/tests/auto-listing-contract.test.mjs:140-180`
- Modify: `server/auto-listing-item-image-config.mjs:4-55`

**Interfaces:**
- Consumes: `deriveEffectiveAutoListingImageConfig({ configSnapshot, configHash, sourceCapture })` with verified frozen configuration and source capture.
- Produces: `{ ratio, resolution, quality, language, roles, total, reasonCodes }`, recursively frozen; `roles.specification` is `0` and `reasonCodes` contains `PRODUCT_DIMENSIONS_UNAVAILABLE` only when trusted product measurements are absent.

- [ ] **Step 1: Replace the hard-failure unit expectation with a failing downgrade expectation**

```js
test("requested specification image without trusted dimensions reduces only that role", () => {
  const frozen = frozenConfig();
  const result = deriveEffectiveAutoListingImageConfig({
    configSnapshot: frozen.config,
    configHash: frozen.configHash,
    sourceCapture: sourceCapture(),
  });
  assert.deepEqual(result.roles, {
    main: 1,
    sellingPoint: 3,
    detail: 1,
    scene: 1,
    specification: 0,
    infographic: 1,
  });
  assert.equal(result.total, 7);
  assert.deepEqual(result.reasonCodes, ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test server/tests/auto-listing-item-image-config.test.mjs`

Expected: FAIL because `deriveEffectiveAutoListingImageConfig` throws `AUTO_LISTING_PRODUCT_DIMENSIONS_REQUIRED`.

- [ ] **Step 3: Extend the aggregate contract test for all untrusted shapes and logistics-only evidence**

Change each former `assert.throws(() => effective(measurements))` to assert the exact reduced result:

```js
const reduced = effective(measurements);
assert.equal(reduced.roles.specification, 0);
assert.equal(reduced.total, 7);
assert.deepEqual(reduced.reasonCodes, ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
```

Keep the forged source-capture and invalid config-hash assertions as throws. Explicitly assert that `effective({}, { length: 999, unit: "cm", source: "warehouse" })` is reduced to 7 rather than trusted.

- [ ] **Step 4: Implement the minimal authoritative downgrade**

In `deriveEffectiveAutoListingImageConfig`, retain both verification calls, then derive roles and total without throwing:

```js
const reliable = hasReliableProductDimensions(snapshot.productMeasurements);
const roles = Object.freeze({
  ...config.image.roles,
  specification: reliable ? config.image.roles.specification : 0,
});
const reasonCodes = Object.freeze(reliable || config.image.roles.specification === 0
  ? []
  : ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
return Object.freeze({
  ratio: config.image.ratio,
  resolution: config.image.resolution,
  quality: config.image.quality,
  language: config.image.language,
  roles,
  total: Object.values(roles).reduce((sum, count) => sum + count, 0),
  reasonCodes,
});
```

Delete the now-unused `productDimensionsError()` helper. Do not read `snapshot.logistics`.

- [ ] **Step 5: Run both contract suites and verify GREEN**

Run: `node --test server/tests/auto-listing-item-image-config.test.mjs server/tests/auto-listing-contract.test.mjs`

Expected: all tests pass; trusted measurements preserve 8 images, every untrusted or logistics-only case returns 7 images.

- [ ] **Step 6: Commit only Task 1 files**

```bash
git add server/auto-listing-item-image-config.mjs server/tests/auto-listing-item-image-config.test.mjs server/tests/auto-listing-contract.test.mjs
git commit -m "fix: reduce images when product dimensions are unavailable"
```

### Task 2: Keep the reduced total through content planning

**Files:**
- Modify: `server/tests/auto-listing-content-planner.test.mjs:320-345`
- Modify: `server/tests/auto-listing-content-planner.test.mjs:655-680`
- Modify: `server/auto-listing-content-planner.mjs:87-93`
- Modify: `server/auto-listing-content-planner.mjs:313-337`
- Modify: `server/auto-listing-content-planner.mjs:860-872`

**Interfaces:**
- Consumes: verified frozen config plus trusted dimensions from `sourceCapture` in `buildPlannerInput`.
- Produces: `plannerInput.requestedRoleCounts.SPECIFICATION === 0`, `imagesPerVisualGroup === requestedTotal - specificationCount`, and `reasonCodes` containing `PRODUCT_DIMENSIONS_UNAVAILABLE`; fixed-skeleton planning proceeds with those effective counts.

- [ ] **Step 1: Change the planner regression to require no reallocation**

```js
test("missing trusted product dimensions removes specification without reallocating and never uses logistics", () => {
  const built = planner({ sourceCapture: sourceCapture({ reliableDimensions: false }) });
  assert.equal(built.plannerInput.requestedRoleCounts.SPECIFICATION, 0);
  assert.equal(built.plannerInput.requestedRoleCounts.SELLING_POINT, 3);
  assert.equal(built.plannerInput.imagesPerVisualGroup, 7);
  assert.ok(built.reasonCodes.includes("PRODUCT_DIMENSIONS_UNAVAILABLE"));
  assert.doesNotMatch(JSON.stringify(built.plannerInput), /999|888|777/);
  assert.doesNotThrow(() => validateContentPlan({ plan: validPlan(built), plannerContext: built }));
});
```

For the 13-image saturated case, assert `imagesPerVisualGroup === 12` and that `SPECIFICATION_REALLOCATION_CAPACITY_EXHAUSTED` is absent.

- [ ] **Step 2: Run the planner test and verify RED**

Run: `node --test --test-name-pattern="missing trusted product dimensions" server/tests/auto-listing-content-planner.test.mjs`

Expected: FAIL because the planner currently reallocates the slot to `SELLING_POINT` and preserves total 8.

- [ ] **Step 3: Remove role reallocation from the planner**

Delete `REALLOCATION_ORDER`. Simplify `effectiveRoleCounts` so missing trusted dimensions only performs:

```js
if (!hasDimensions && counts.SPECIFICATION > 0) {
  counts.SPECIFICATION = 0;
  reasonCodes.push("PRODUCT_DIMENSIONS_UNAVAILABLE");
}
```

Retain closed role-limit checks and `total <= requestedTotal`. Pass only the values still required by the helper; remove the unused `style` parameter if no longer referenced.

- [ ] **Step 4: Replace the fixed-skeleton hard-failure test with a pre-AI reduced-skeleton test**

Configure the repository reservation to build the current skeleton, make the gateway throw a sentinel retryable error after inspecting its schema, and assert:

```js
assert.equal(context.plannerInput.requestedRoleCounts.SPECIFICATION, 0);
assert.equal(context.plannerInput.imagesPerVisualGroup, 7);
assert.equal(input.jsonSchema.properties.fills.required.length, 7);
```

Expected behavior: repository reservation is called once, gateway is called once, and the observed fixed skeleton has no `SPECIFICATION` slot.

- [ ] **Step 5: Run the fixed-contract test and verify RED**

Run: `node --test --test-name-pattern="fixed contract" server/tests/auto-listing-content-planner.test.mjs`

Expected: FAIL with `AUTO_LISTING_FIXED_SKELETON_DIMENSION_REQUIRED` before repository or gateway.

- [ ] **Step 6: Remove only the obsolete fixed-skeleton preflight rejection**

Delete this guard from `createContentPlan`:

```js
if (planningContract === "FIXED_SKELETON_V1"
  && plannerContext.reasonCodes.includes("PRODUCT_DIMENSIONS_UNAVAILABLE")) {
  throw plannerError("AUTO_LISTING_FIXED_SKELETON_DIMENSION_REQUIRED", "尺寸图缺少可靠的商品尺寸依据");
}
```

Keep `buildFixedSkeleton`'s own dimension-evidence rejection for contexts that actually request a `SPECIFICATION` slot without dimension facts. A downgraded context requests zero such slots and must pass.

- [ ] **Step 7: Run planner and skeleton suites and verify GREEN**

Run: `node --test server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-fixed-skeleton.test.mjs`

Expected: all tests pass; reduced contexts produce seven slots, and a forged context that still requests specification without dimension evidence remains rejected.

- [ ] **Step 8: Commit only Task 2 files**

```bash
git add server/auto-listing-content-planner.mjs server/tests/auto-listing-content-planner.test.mjs
git commit -m "fix: skip unavailable specification slots in planning"
```

### Task 3: Prove mixed batches continue and remain auditable

**Files:**
- Modify: `server/tests/auto-listing-service.test.mjs:805-825`
- Verify: `server/auto-listing-service.mjs:320-360`
- Verify: `server/auto-listing-repository.mjs:680-720`

**Interfaces:**
- Consumes: a batch with one trusted-dimension source and one logistics-only source.
- Produces: a persisted job graph with both items `SOURCE_READY`; the trusted sibling has total 8/specification 1, the untrusted sibling has total 7/specification 0 plus the audit reason code.

- [ ] **Step 1: Replace the service hard-failure test with a mixed-batch graph assertion**

```js
test("mixed product dimensions derive independent effective image counts and persist the graph", async () => {
  const unavailable = source("collect-no-product-size");
  unavailable.collectItem.listingDraft.productMeasurements = {};
  unavailable.collectItem.listingDraft.logistics = {
    length: 999, width: 999, height: 999, unit: "cm", source: "package",
  };
  const repository = fakeRepository({ sources: [source("collect-product-size"), unavailable] });
  const result = await createAutoListingService({ repository }).createAutoListingJob({
    actor,
    collectItemIds: ["collect-product-size", "collect-no-product-size"],
    idempotencyKey: "mixed-sizes",
    correlationId: "corr",
    config,
  });
  assert.deepEqual(result.items.map((item) => item.status), ["SOURCE_READY", "SOURCE_READY"]);
  const graph = repository.calls.find(([name]) => name === "createJobGraph")[1];
  assert.deepEqual(graph.items.map((item) => ({
    total: item.effectiveImageConfig.total,
    specification: item.effectiveImageConfig.roles.specification,
    reasonCodes: item.effectiveImageConfig.reasonCodes,
  })), [
    { total: 8, specification: 1, reasonCodes: [] },
    { total: 7, specification: 0, reasonCodes: ["PRODUCT_DIMENSIONS_UNAVAILABLE"] },
  ]);
});
```

- [ ] **Step 2: Run the service integration regression against the Task 1 implementation**

Run: `node --test --test-name-pattern="mixed product dimensions" server/tests/auto-listing-service.test.mjs`

Expected: PASS because the service already derives and persists each sibling's authoritative `effectiveImageConfig`. A failure means Task 1 did not preserve its return contract through the existing service graph and must be corrected there before continuing; do not weaken source verification or persist client-provided counts.

- [ ] **Step 3: Run service, repository, and route regressions**

Run: `node --test server/tests/auto-listing-service.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-routes.test.mjs`

Expected: all pass. The defensive 422 mapping may remain tested, but normal service creation no longer emits the code for missing product measurements.

- [ ] **Step 4: Commit the mixed-batch regression**

```bash
git add server/tests/auto-listing-service.test.mjs
git commit -m "test: cover mixed product dimension image counts"
```

### Task 4: Final verification and local acceptance

**Files:**
- Verify all files changed in Tasks 1-3.
- Preserve existing uncommitted frontend/route error-message changes unless separately committed by the user-approved prior fix.

**Interfaces:**
- Consumes: current local PostgreSQL record `collect_bce1e3bb59023e8d0ca6755e`, whose draft has logistics dimensions but no `productMeasurements`.
- Produces: evidence that task creation passes the dimensions gate with an effective total of 7 and does not request a specification image.

- [ ] **Step 1: Run all focused auto-listing tests fresh**

Run:

```bash
node --test \
  server/tests/auto-listing-item-image-config.test.mjs \
  server/tests/auto-listing-contract.test.mjs \
  server/tests/auto-listing-content-planner.test.mjs \
  server/tests/auto-listing-fixed-skeleton.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-routes.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run syntax, whitespace, and production build checks**

Run:

```bash
node --check server/auto-listing-item-image-config.mjs
node --check server/auto-listing-content-planner.mjs
git diff --check
pnpm build
```

Expected: all commands exit 0. Report any unrelated full-suite or environment failures separately; do not claim they were fixed.

- [ ] **Step 3: Restart the current local development service with the modified server code**

Confirm `http://127.0.0.1:3000/ozon/tools/auto-listing/` loads and the current user session remains authenticated. Do not alter production data or invoke external paid AI during this check.

- [ ] **Step 4: Perform browser acceptance on the selected collect item**

Submit the same collect item with specification count 1. Capture the create-job request and verify it no longer returns `AUTO_LISTING_PRODUCT_DIMENSIONS_REQUIRED`. If a later real preflight such as category attributes blocks creation, record that as the next independent blocker and verify the dimensions error is absent.

- [ ] **Step 5: Inspect the persisted graph only if a job is created before any paid phase**

Read the new job item's effective image config and assert total 7, specification 0, other roles unchanged, and reason code present. Stop before paid AI/image generation unless the user separately authorizes a real model call.

- [ ] **Step 6: Final review and handoff**

Report changed contracts, exact tests run, browser outcome, unverified ranges, regression risk, and rollback. Rollback is code-only because there is no migration; reverting Tasks 1-3 restores the previous hard failure and planner reallocation.

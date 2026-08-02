# Seller Bundle Cache Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make asynchronous Ozon enrichment reuse a complete, current-store Seller bundle cache before falling back to public PDP physical capture.

**Architecture:** Keep the existing public-first collection and asynchronous enrichment contracts unchanged. Extend the existing bundle reader with a cache-only option, then let the read-only enrichment branch merge that cached bundle without calling the side-effecting Seller bundle endpoint.

**Tech Stack:** Chrome MV3 service worker JavaScript, `node:test`, existing Seller company-scoped `chrome.storage.local` cache.

## Global Constraints

- No API or database schema changes.
- No Seller credentials, cookies, or company identifiers in public collection payloads.
- Read-only enrichment must never call the Seller bundle creation endpoint.
- Cache keys remain scoped by `companyId + variantId`.
- Incomplete, expired, or malformed cache entries must fall back to the existing public PDP route.

---

### Task 1: Reuse complete Seller bundle cache in read-only enrichment

**Files:**
- Modify: `extension/background/service-worker.js:1022-1065`
- Modify: `extension/background/service-worker.js:3387-3428`
- Test: `extension/tests/seller-company-context-contract.test.js:1120-1225`

**Interfaces:**
- Consumes: `fetchBundleByVariantId(sku, variantId, companyId, opts)` and `mergeBundleItemIntoSourceVariant(sourceVariant, bundleItem)`.
- Produces: `opts.cacheOnly === true`, which permits cache reads and returns `null` instead of invoking the Seller endpoint on a miss.

- [ ] **Step 1: Write the failing cache-hit behavior test**

Add a test named `Collector read-only capture reuses a complete same-company bundle cache before public PDP` that extracts `enrichSellerSearchItems`, supplies an item with `variant_id` and `description_category_id`, returns a complete bundle from `fetchBundle`, and asserts:

```js
assert.deepEqual(bundleOptions, {
  forceRefresh: false,
  preferTabId: 70,
  deadlineAt: NOW + 10_000,
  cacheOnly: true,
});
assert.equal(publicCalls, 0);
assert.deepEqual(
  result[0].attributes.filter(({ key }) => ['4497', '9454', '9455', '9456'].includes(key)),
  [
    { key: '4497', value: '500' },
    { key: '9454', value: '300' },
    { key: '9455', value: '200' },
    { key: '9456', value: '100' },
  ],
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='reuses a complete same-company bundle cache' extension/tests/seller-company-context-contract.test.js
```

Expected: FAIL because the current read-only branch never calls `fetchBundle` and instead calls the public PDP fallback.

- [ ] **Step 3: Add cache-only behavior to the existing bundle reader**

In `fetchBundleByVariantId`, preserve the current fresh-cache lookup, but do not return empty-attribute cache entries for `cacheOnly`. Immediately after the lookup block add:

```js
if (opts.cacheOnly === true) return null;
```

This guarantees a cache miss cannot reach `/seller-prototype/create-bundle-by-variant-id`.

- [ ] **Step 4: Merge cache before public fallback in the read-only branch**

Before checking physical completeness, call:

```js
const variantId = items[0]?.variant_id;
if (variantId) {
  const cachedBundle = await fetchBundle(sku, variantId, companyId, {
    forceRefresh: false,
    preferTabId,
    deadlineAt,
    cacheOnly: true,
  });
  if (cachedBundle) items[0] = mergeBundle(items[0], cachedBundle);
}
```

Catch cache read failures locally and retain the existing public physical fallback.

- [ ] **Step 5: Update the existing public-fallback test contract**

Change its injected `fetchBundle` to return `null`, assert it received `cacheOnly: true`, keep the expected public call count at one, and continue asserting that no side-effecting bundle response is used.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='Collector read-only capture' extension/tests/seller-company-context-contract.test.js
```

Expected: both cache-hit and public-fallback tests PASS.

### Task 2: Regression and live verification

**Files:**
- Verify: `extension/background/service-worker.js`
- Verify: `extension/background/collector-ozon-enrichment-agent.js`
- Verify: `extension/lib/ozon-collect-coordinator.js`

**Interfaces:**
- Consumes: unchanged Collector enrichment job/result contracts.
- Produces: no new public interface.

- [ ] **Step 1: Run relevant extension tests**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/seller-company-context-contract.test.js extension/tests/collector-ozon-enrichment-client.test.js extension/tests/collector-ozon-enrichment-agent.test.js extension/tests/ozon-collect-coordinator.test.js
```

Expected: zero failures.

- [ ] **Step 2: Package the extension**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/package-extension.mjs
```

Expected: exit code 0 and an updated unpacked extension artifact.

- [ ] **Step 3: Verify the user flow**

Reload the unpacked extension, open a product whose data panel already shows category and dimensions, click `采集`, and verify the Web collection item reaches `COMPLETE` with all five fields and no `RETRYING` message.

- [ ] **Step 4: Verify repository state**

Run `git diff --check` and inspect `git status --short`. Report modified files, unchanged contracts, test results, unverified scope, risk, and rollback.

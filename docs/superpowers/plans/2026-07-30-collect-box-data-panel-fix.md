# Collect Box and Data Panel Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make successfully collected Ozon products visible in the correct Web account, reliably surface available logistics metrics in the extension data panel, and remove the rating star span.

**Architecture:** Keep public collection DTOs scope-free while reattaching the already-authorized account ID only inside the server hydration boundary. Centralize Ozon bundle enrichment so fleet and local collection paths produce the same physical attributes, then centralize return-rate and rating formatting in testable helpers.

**Tech Stack:** Node.js ESM server, PostgreSQL, Chrome Manifest V3 service worker, browser content scripts, Node built-in test/assert/vm, Vite packaging.

## Global Constraints

- Preserve the account-level unified collection box; listing-time store selection remains unchanged.
- Do not add or migrate database tables.
- Do not expose `accountId`, `createdBy`, tokens, cookies, or secrets in public collection payloads.
- Do not invent weight, dimensions, volume, or return-rate values when Ozon did not supply valid data.
- Bundle enrichment must be idempotent and must not overwrite an existing valid source attribute.
- Tests must not call real Ozon endpoints or trigger real listing, order, inventory, or financial operations.
- Every task must finish with a focused passing test and a reversible Git commit.

---

## File Structure

- Create `server/collect-hydration-scope.mjs`: pure internal helper that reattaches a trusted account scope after an account-filtered database read.
- Modify `server/listing-pipeline.mjs`: use the internal scope helper during legacy-state hydration.
- Create `server/tests/collect-hydration-scope.test.mjs`: prove internal visibility and public scope stripping.
- Modify `extension/background/service-worker.js`: add one bundle-enrichment function used by both fleet and local paths; extend market-field aliases.
- Modify `extension/tests/fleet-collect-attrs-merge.test.js`: behavior-test physical/business attribute enrichment, duplicate prevention, and both call sites.
- Create `extension/tests/market-item-normalization.test.js`: behavior-test return-rate field aliases.
- Modify `extension/content/shared-utils.js`: add safe rating and return-rate formatters and remove the rating star markup.
- Create `extension/tests/data-panel-logistics.test.js`: behavior-test valid/invalid logistics formatting and rating output.
- Regenerate `app/public/sonli-extension-0.13.46.1/`, `app/public/sonli-extension-0.13.46.1.zip`, and `app/dist/sonli-extension-0.13.46.1.zip` with the existing packaging command.

---

### Task 1: Restore Trusted Account Scope During Collection Hydration

**Files:**

- Create: `server/collect-hydration-scope.mjs`
- Create: `server/tests/collect-hydration-scope.test.mjs`
- Modify: `server/listing-pipeline.mjs:1-12`
- Modify: `server/listing-pipeline.mjs:871-890`

**Interfaces:**

- Consumes: an account ID already used as the `listCollectItemsV3({ accountId })` database filter and that query's public item rows.
- Produces: `attachTrustedCollectAccountScope(accountId, items) -> Array<object>` for server-internal state only.

- [ ] **Step 1: Write the failing scope test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { attachTrustedCollectAccountScope } from "../collect-hydration-scope.mjs";
import { publicPersistedCollectionItem } from "../collection-public-shape.mjs";

test("trusted account scope is restored internally and stripped publicly", () => {
  const [internal] = attachTrustedCollectAccountScope(" account-a ", [{
    id: "collect-1",
    sku: "3224975094",
    accountId: "forged-account",
  }]);

  assert.equal(internal.accountId, "account-a");
  assert.equal(publicPersistedCollectionItem(internal).accountId, undefined);
});

test("trusted account scope is required", () => {
  assert.throws(
    () => attachTrustedCollectAccountScope("", [{ id: "collect-1" }]),
    (error) => error?.code === "COLLECT_ACCOUNT_REQUIRED",
  );
});
```

- [ ] **Step 2: Run the test and verify the missing module/function failure**

Run: `node --test server/tests/collect-hydration-scope.test.mjs`

Expected: FAIL because `server/collect-hydration-scope.mjs` does not exist.

- [ ] **Step 3: Implement the minimal internal helper**

```js
export function attachTrustedCollectAccountScope(accountId, items = []) {
  const trustedAccountId = String(accountId || "").trim().slice(0, 240);
  if (!trustedAccountId) {
    throw Object.assign(new Error("采集列表必须指定账号范围"), {
      status: 401,
      code: "COLLECT_ACCOUNT_REQUIRED",
    });
  }
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...(item || {}),
    accountId: trustedAccountId,
  }));
}
```

Import the helper in `server/listing-pipeline.mjs`, then replace the hydration query with:

```js
const relationalCollectItems = (
  await Promise.all(accountIds.map(async (accountId) =>
    attachTrustedCollectAccountScope(
      accountId,
      await listCollectItemsV3({ accountId, limit: 10000 }),
    )))
).flat();
```

- [ ] **Step 4: Run focused server tests**

Run:

```bash
node --test server/tests/collect-hydration-scope.test.mjs server/tests/collection-public-shape.test.mjs
```

Expected: PASS; internal rows carry the trusted account, while public rows still strip it.

- [ ] **Step 5: Commit the server fix**

```bash
git add server/collect-hydration-scope.mjs server/listing-pipeline.mjs server/tests/collect-hydration-scope.test.mjs
git commit -m "fix: preserve collection account scope during hydration"
```

---

### Task 2: Unify Fleet and Local Bundle Enrichment

**Files:**

- Modify: `extension/tests/fleet-collect-attrs-merge.test.js`
- Modify: `extension/background/service-worker.js:475-527`
- Modify: `extension/background/service-worker.js:3998-4040`
- Modify: `extension/background/service-worker.js:4130-4215`

**Interfaces:**

- Consumes: `sourceVariant.attributes` in `{ key, value|collection }` shape and an Ozon `bundleItem` containing physical fields plus `attributes`.
- Produces: `mergeBundleItemIntoSourceVariant(sourceVariant, bundleItem) -> enriched sourceVariant`.

- [ ] **Step 1: Extend the existing fleet merge test so it fails on missing physical fields**

Use this bundle fixture:

```js
const fleetResponse = {
  sourceVariant: {
    attributes: [
      { key: "10", value: "existing" },
      { key: "4497", value: "777" },
    ],
  },
  bundleItem: {
    weight: 888,
    depth: 11,
    width: 22,
    height: 33,
    attributes: [
      { attribute_id: 20, complex_id: 0, values: [{ value: "simple" }] },
      { attribute_id: 9454, complex_id: 0, values: [{ value: "must-not-duplicate" }] },
      { attribute_id: 40, complex_id: 1, values: [{ value: "video" }] },
    ],
  },
};
```

Assert that the enriched attributes contain existing `4497=777`, new `9454=11`, `9455=22`, `9456=33`, and business attribute `20=simple` exactly once. Assert that a second enrichment produces the same attribute list and that the source contains `_bundleItem` plus `_bundleComplexAttrs`.

Also assert that `service-worker.js` invokes `mergeBundleItemIntoSourceVariant` in both the fleet branch and the local `/search → bundle` branch.

- [ ] **Step 2: Run the focused extension test and verify failure**

Run: `node extension/tests/fleet-collect-attrs-merge.test.js`

Expected: FAIL because the fleet route does not currently merge `weight/depth/width/height` and no shared helper exists.

- [ ] **Step 3: Add the shared idempotent merge function**

Add a single helper inside the service-worker closure:

```js
const mergeBundleItemIntoSourceVariant = (sourceVariant, bundleItem) => {
  const source = sourceVariant && typeof sourceVariant === "object" ? sourceVariant : {};
  if (!bundleItem || typeof bundleItem !== "object") return source;
  const attributes = Array.isArray(source.attributes) ? source.attributes.map((attr) => ({ ...attr })) : [];
  const keys = new Set(attributes.map((attr) => String(attr?.key || "")).filter(Boolean));
  const append = (key, value) => {
    const normalizedKey = String(key || "");
    if (!normalizedKey || keys.has(normalizedKey)) return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    attributes.push({ key: normalizedKey, value: String(value) });
    keys.add(normalizedKey);
  };

  append("4497", bundleItem.weight);
  append("9454", bundleItem.depth);
  append("9455", bundleItem.width);
  append("9456", bundleItem.height);

  const complex = [];
  for (const raw of Array.isArray(bundleItem.attributes) ? bundleItem.attributes : []) {
    if (raw?.complex_id && String(raw.complex_id) !== "0") {
      complex.push(raw);
      continue;
    }
    const key = String(raw?.attribute_id || "");
    if (!key || keys.has(key)) continue;
    const values = Array.isArray(raw?.values)
      ? raw.values.filter((value) => value && value.value != null && value.value !== "")
      : [];
    if (!values.length) continue;
    attributes.push(values.length > 1
      ? { key, collection: values.map((value) => String(value.value)) }
      : { key, value: String(values[0].value) });
    keys.add(key);
  }

  return {
    ...source,
    attributes,
    _bundleItem: bundleItem,
    ...(complex.length ? { _bundleComplexAttrs: complex } : {}),
  };
};
```

Replace both route-specific merge implementations with this helper. Cache the enriched fleet response, not the pre-enrichment object.

- [ ] **Step 4: Run the focused merge and syntax tests**

Run:

```bash
node extension/tests/fleet-collect-attrs-merge.test.js
node extension/tests/bundle-attrs-cache-guard.test.js
node --check extension/background/service-worker.js
```

Expected: PASS; both paths share the helper, physical values are present, and duplicate keys are impossible.

- [ ] **Step 5: Commit the bundle enrichment fix**

```bash
git add extension/background/service-worker.js extension/tests/fleet-collect-attrs-merge.test.js
git commit -m "fix: unify Ozon bundle logistics enrichment"
```

---

### Task 3: Normalize Return-Rate Source Fields

**Files:**

- Create: `extension/tests/market-item-normalization.test.js`
- Modify: `extension/background/service-worker.js:750-793`

**Interfaces:**

- Consumes: one Ozon market item with camelCase, PascalCase, or snake_case field names.
- Produces: a market item with `nullableRedemptionRate` populated when a known source field exists.

- [ ] **Step 1: Write the failing market normalization test**

Extract and evaluate the existing `normalizeMarketItem` function from the service-worker source, then assert:

```js
assert.equal(normalizeMarketItem({ nullableRedemptionRate: 92 }).nullableRedemptionRate, 92);
assert.equal(normalizeMarketItem({ NullableRedemptionRate: 91 }).nullableRedemptionRate, 91);
assert.equal(normalizeMarketItem({ nullable_redemption_rate: 90 }).nullableRedemptionRate, 90);
assert.equal(normalizeMarketItem({ redemptionRate: 89 }).nullableRedemptionRate, 89);
assert.equal(normalizeMarketItem({ redemption_rate: 88 }).nullableRedemptionRate, 88);
assert.equal(normalizeMarketItem({ soldCount: 10 }).nullableRedemptionRate, undefined);
```

- [ ] **Step 2: Run the test and verify the snake_case failure**

Run: `node extension/tests/market-item-normalization.test.js`

Expected: FAIL for `nullable_redemption_rate` and `redemption_rate`.

- [ ] **Step 3: Add the missing aliases without changing existing precedence**

Change the standardized field to:

```js
nullableRedemptionRate: pick(
  "nullableRedemptionRate",
  "NullableRedemptionRate",
  "nullable_redemption_rate",
  "redemptionRate",
  "redemption_rate",
),
```

- [ ] **Step 4: Run the normalization and worker syntax tests**

Run:

```bash
node extension/tests/market-item-normalization.test.js
node --check extension/background/service-worker.js
```

Expected: PASS.

- [ ] **Step 5: Commit the market-field fix**

```bash
git add extension/background/service-worker.js extension/tests/market-item-normalization.test.js
git commit -m "fix: normalize Ozon return rate fields"
```

---

### Task 4: Format Logistics Values Safely and Remove the Rating Span

**Files:**

- Create: `extension/tests/data-panel-logistics.test.js`
- Modify: `extension/content/shared-utils.js:699-710`
- Modify: `extension/content/shared-utils.js:3663-3671`
- Modify: `extension/content/shared-utils.js:3759-3764`
- Modify: `extension/content/shared-utils.js:3894-3901`

**Interfaces:**

- Produces: `window.jzReturnRateFromRedemption(value) -> number|null`.
- Produces: `window.jzFormatRating(rating, reviewCount) -> string|null`.
- Consumes: those helpers in the V2 data-panel population path.

- [ ] **Step 1: Write the failing formatter and markup test**

Load `content/shared-utils.js` in the same VM sandbox pattern as `extension/tests/mv-title-promo-guard.test.js`, then assert:

```js
assert.equal(windowObj.jzReturnRateFromRedemption(92), 8);
assert.equal(windowObj.jzReturnRateFromRedemption("100"), 0);
assert.equal(windowObj.jzReturnRateFromRedemption(-1), null);
assert.equal(windowObj.jzReturnRateFromRedemption(101), null);
assert.equal(windowObj.jzReturnRateFromRedemption("bad"), null);
assert.equal(windowObj.jzFormatRating(4.8, 123), "4.8 (123)");
assert.equal(windowObj.jzFormatRating(4.8, 0), "4.8");
assert.equal(windowObj.jzFormatRating("bad", 3), null);
assert.equal(sharedUtilsSource.includes("ozon-helper-rating-star"), false);
```

- [ ] **Step 2: Run the test and verify missing helper/span failures**

Run: `node extension/tests/data-panel-logistics.test.js`

Expected: FAIL because the helpers do not exist and the star span is still emitted.

- [ ] **Step 3: Implement formatters and route both return-rate paths through them**

Add:

```js
window.jzReturnRateFromRedemption = function (value) {
  const redemption = Number(value);
  if (!Number.isFinite(redemption) || redemption < 0 || redemption > 100) return null;
  return 100 - redemption;
};

window.jzFormatRating = function (rating, reviewCount) {
  const value = Number(rating);
  if (!Number.isFinite(value)) return null;
  const reviews = Number(reviewCount);
  return `${value.toFixed(1)}${Number.isFinite(reviews) && reviews > 0
    ? ` (${window.formatNumber(reviews)})`
    : ""}`;
};
```

Replace the raw rating HTML update with:

```js
const ratingText = window.jzFormatRating(data.rating, data.reviewCount);
if (ratingText) updateField("rating", ratingText, "gold");
```

For both backend and live-market redemption fields, compute:

```js
const returnRate = window.jzReturnRateFromRedemption(value);
if (returnRate != null) {
  updateField("returnRate", `${returnRate.toFixed(0)}%`, returnRate > 0 ? "red" : "green", true);
}
```

- [ ] **Step 4: Run data-panel and neighboring regression tests**

Run:

```bash
node extension/tests/data-panel-logistics.test.js
node extension/tests/data-card-copy-button.test.js
node extension/tests/sidebar-section-toggle.test.js
node --check extension/content/shared-utils.js
```

Expected: PASS; rating remains plain text and invalid return-rate input stays unavailable.

- [ ] **Step 5: Commit the display fix**

```bash
git add extension/content/shared-utils.js extension/tests/data-panel-logistics.test.js
git commit -m "fix: render logistics metrics and plain rating"
```

---

### Task 5: Package and Verify the Complete Delivery

**Files:**

- Regenerate: `app/public/sonli-extension-0.13.46.1/`
- Regenerate: `app/public/sonli-extension-0.13.46.1.zip`
- Regenerate: `app/dist/sonli-extension-0.13.46.1.zip`

**Interfaces:**

- Consumes: the tested server and extension source changes.
- Produces: an installable unpacked extension and matching ZIP artifacts.

- [ ] **Step 1: Run the focused regression suite**

Run:

```bash
node --test server/tests/collect-hydration-scope.test.mjs server/tests/collection-public-shape.test.mjs
node extension/tests/fleet-collect-attrs-merge.test.js
node extension/tests/market-item-normalization.test.js
node extension/tests/data-panel-logistics.test.js
```

Expected: all tests PASS.

- [ ] **Step 2: Regenerate the extension artifacts**

Run: `pnpm package-extension`

Expected: the unpacked public directory and both versioned ZIP files are rebuilt from `extension/`.

- [ ] **Step 3: Run the full repository verification gate**

Run: `pnpm verify`

Expected: app build, active tests, extension source/distribution/ZIP parity, syntax, security, and isolation checks PASS. Any configuration-based PostgreSQL specialty test remains reported as skipped only when its dedicated test database is not configured.

- [ ] **Step 4: Restart local services and verify the existing collected item**

Restart `scripts/dev.mjs`, sign in through the existing local Web session, open `/ozon/products/collect/`, and verify:

```text
SKU: 3224975094
Expected collection box result: visible for account acct_8b9c69df-cd06-47a1-9d03-27fb92433e3d
Expected other-account result: not visible
```

Reload the unpacked extension from `app/public/sonli-extension-0.13.46.1/`, open an Ozon product page, and verify that available weight, dimensions, calculated volume, and return rate render while the rating contains no star span.

- [ ] **Step 5: Commit packaged artifacts and verification evidence**

```bash
git add app/public/sonli-extension-0.13.46.1 app/public/sonli-extension-0.13.46.1.zip app/dist/sonli-extension-0.13.46.1.zip
git commit -m "build: package collection and data panel fixes"
```

Record the tests run, skipped scope, browser checks, residual risks, and rollback commit IDs in the final delivery response.


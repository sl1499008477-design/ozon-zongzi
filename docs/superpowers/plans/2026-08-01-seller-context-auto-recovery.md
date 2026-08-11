# Seller Context Auto Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status (2026-08-11):** Tasks 1–2 are implemented and covered by focused extension tests. The current branch has since evolved the recovery into a revisioned helper/lease flow, so this file is retained as historical delivery context rather than a plan to rerun verbatim. Task 3 remains unchecked because this documentation-only update did not certify a complete configured verification or a fresh real-browser recovery exercise.

**Goal:** Automatically restore the trusted Seller company context once after an extension reinstall or reload so Ozon category and logistics fields can be collected without a manual Seller-page refresh.

**Architecture:** Extend the focused Seller company-context runtime with a side-effectful `resolveCurrentWithRecovery()` method while preserving the existing read-only `resolveCurrent()` contract. The recovery selects one trusted Seller tab, reloads it once, polls the existing fail-closed resolver, and coalesces concurrent callers through one in-flight promise. The service worker uses the recovery method only on user-driven capture paths.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript UMD modules, `chrome.tabs`, `chrome.storage.session`, Node `assert`, repository extension packager.

## Global Constraints

- Preserve the account-level collection-box contract; do not add store identity to collection uploads.
- Never trust a company ID outside the existing Seller identity policy.
- Reload at most one trusted Seller top-level tab once per recovery attempt.
- Coalesce concurrent recovery callers, clear the in-flight state after success or failure, and suppress another reload for 30 seconds after failure.
- Do not change database schemas, backend API contracts, Seller sync behavior, or existing user data.
- Preserve all existing uncommitted user changes.

---

### Task 1: Seller context recovery runtime

**Files:**
- Modify: `extension/lib/seller-company-context-runtime.js`
- Modify: `extension/tests/seller-company-context-contract.test.js`

**Interfaces:**
- Consumes: existing `resolveCurrent() -> Promise<{ companyId, sellerTabId, source }>`.
- Produces: `resolveCurrentWithRecovery({ timeoutMs?: number, pollIntervalMs?: number } = {}) -> Promise<{ companyId, sellerTabId, source }>`.
- Produces stable timeout error code `SELLER_CONTEXT_RECOVERY_FAILED`.

- [x] **Step 1: Write failing recovery contract tests**

Add test doubles for `chrome.tabs.reload`, a controllable `sleep`, and session observations. Assert that two concurrent calls made with one trusted active Seller tab and no initial context trigger one reload, then both resolve after the observation appears.

```js
const [first, second] = await Promise.all([
  recoveryRuntime.resolveCurrentWithRecovery({ timeoutMs: 2_000, pollIntervalMs: 10 }),
  recoveryRuntime.resolveCurrentWithRecovery({ timeoutMs: 2_000, pollIntervalMs: 10 }),
]);
assert.equal(reloadCalls.length, 1);
assert.equal(first.companyId, '2681910');
assert.deepEqual(second, first);
```

Also assert that no Seller tab preserves `SELLER_CONTEXT_REQUIRED`, a policy conflict is not reloaded, and timeout performs exactly one reload before throwing `SELLER_CONTEXT_RECOVERY_FAILED`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node extension/tests/seller-company-context-contract.test.js`

Expected: FAIL because `resolveCurrentWithRecovery` does not exist.

- [x] **Step 3: Implement the minimal recovery method**

Add injected `sleep`, an internal `recoveryPromise`, active-tab selection, one awaited `chrome.tabs.reload(tabId)`, bounded polling, and a 30-second failure cooldown. Retry only exact `SELLER_CONTEXT_REQUIRED` or `SELLER_COMPANY_CONTEXT_REQUIRED` errors; propagate conflict and dependency errors unchanged.

```js
const resolveCurrentWithRecovery = async (options = {}) => {
  try { return await resolveCurrent(); } catch (error) {
    if (error?.message !== 'SELLER_CONTEXT_REQUIRED') throw error;
  }
  if (!recoveryPromise) {
    recoveryPromise = recoverCurrent(options).finally(() => { recoveryPromise = null; });
  }
  return recoveryPromise;
};
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node extension/tests/seller-company-context-contract.test.js`

Expected: PASS, including the original read-only runtime assertions.

### Task 2: User-driven collection integration and error contract

**Files:**
- Modify: `extension/background/service-worker.js`
- Modify: `extension/tests/seller-company-context-contract.test.js`
- Modify: `extension/tests/sync-capability-removed.test.js`

**Interfaces:**
- Consumes: `sellerCompanyContextRuntime.resolveCurrentWithRecovery()`.
- Preserves: `searchVariantsLocal(...) -> { ok, errorCode?, message?, data? }`.
- Maps: `SELLER_CONTEXT_RECOVERY_FAILED` to a safe, actionable Chinese message.

- [x] **Step 1: Add failing source-contract assertions**

Read `service-worker.js` as source and assert that both the Ozon agent `canCapture` gate and `getSellerCompanyIdCandidates` use `resolveCurrentWithRecovery()`. Assert that `SELLER_CONTEXT_RECOVERY_FAILED` is retained separately from company conflicts.

- [x] **Step 2: Run the contract test and verify RED**

Run: `node extension/tests/seller-company-context-contract.test.js`

Expected: FAIL because both call sites still invoke `resolveCurrent()`.

- [x] **Step 3: Switch only the capture paths to recovery**

Change the two user-driven capture call sites. Extend the existing `searchVariantsLocal` context error mapping:

```js
const contextCode = /CONFLICT/.test(message)
  ? 'SELLER_COMPANY_CONTEXT_CONFLICT'
  : /RECOVERY_FAILED/.test(message)
    ? 'SELLER_CONTEXT_RECOVERY_FAILED'
    : 'SELLER_CONTEXT_REQUIRED';
```

Keep cookie-sync/check routes on the read-only resolver so status checks never refresh pages.

Add both `enrichOzonCollect` and `enrichOzonCollectBatch` to the existing `KEEP_ALIVE_ACTIONS` set. The Service Worker behavior harness records `setInterval` calls and requires one 15-second keepalive for each enrichment action, preventing Chrome MV3 idle suspension while preserving the existing request deadlines.

- [x] **Step 4: Run focused runtime and panel tests**

Run:

```sh
node extension/tests/seller-company-context-contract.test.js
node extension/tests/seller-identity-policy.test.js
node extension/tests/data-panel-visual-browser.test.js
node extension/tests/collector-ozon-enrichment-client.test.js
```

Expected: PASS with no changed backend contract.

### Task 3: Package and real-browser regression

**Files:**
- Generated: `app/public/sonli-extension-0.13.46.1/`
- Generated: `app/public/sonli-extension-0.13.46.1.zip`
- Generated: `app/dist/sonli-extension-0.13.46.1.zip`

**Interfaces:**
- Consumes: the verified `extension/` source tree.
- Produces: an unpacked Web download directory and two matching extension archives.

- [ ] **Step 1: Regenerate distributable extension artifacts**

Run: `npm run package-extension`

Expected: the unpacked directory and both ZIP artifacts are recreated from `extension/` without missing required runtime files.

- [ ] **Step 2: Run the complete configured verification**

Run: `npm run verify`

Expected: all configured tests pass; any configuration-based skips are reported separately and not presented as passes.

- [ ] **Step 3: Re-run focused tests against the packaged copy**

Run:

```sh
node app/public/sonli-extension-0.13.46.1/tests/seller-company-context-contract.test.js
node app/public/sonli-extension-0.13.46.1/tests/data-panel-visual-browser.test.js
```

Expected: PASS.

- [ ] **Step 4: Verify the real recovery flow**

With an authenticated Web tab, an already-open authenticated Seller tab, and an Ozon product tab: clear the per-tab session observation to simulate a newly reloaded extension, trigger the data panel or collection once, and verify exactly one Seller reload followed by populated category, weight, depth, width, and height. Click collection and verify the Web collection box receives the product.

- [ ] **Step 5: Record delivery evidence**

Report changed files and contracts, focused and full verification results, regression coverage, unverified external behavior, and the file-level rollback path described in the design.

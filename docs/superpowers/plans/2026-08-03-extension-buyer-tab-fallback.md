# Extension Buyer-Tab Seller Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an ordinary Ozon buyer product page to fall back to a trusted logged-in Seller tab when its cross-origin fast path fails, while preserving fail-closed behavior for a frozen Seller identity snapshot.

**Architecture:** Separate the preferred-tab performance hint from the frozen-Seller security constraint with an explicit `strictPreferredSellerTab` boolean. Ordinary content-script requests use non-strict fallback; Collector jobs carrying a trusted `sellerContext` use strict resolution throughout both `/search` and bundle enrichment.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript, Node built-in test runner, repository extension packager.

## Global Constraints

- Preserve the account-level collection-box contract and existing Collector session permissions.
- Never trust a company ID or Seller tab identity supplied by an untrusted page.
- Ordinary buyer-page fallback may select only through the existing trusted `ensureSellerTab()` path.
- A frozen Seller snapshot must fail with `SELLER_CONTEXT_CHANGED` instead of switching to another Seller tab.
- Do not modify database schemas, backend API contracts, store synchronization, or existing user data.
- Preserve all existing uncommitted user files and the separate `seller-assisted-async-enrichment` worktree.

---

### Task 1: Distinguish buyer-page preference from a frozen Seller tab

**Files:**
- Modify: `extension/tests/seller-company-context-contract.test.js`
- Modify: `extension/background/service-worker.js`

**Interfaces:**
- Produces: `resolveSellerPortalPreference({ sellerContext, sender }) -> { preferTabId, strictPreferredSellerTab }`.
- Consumes: `resolveSellerPortalTargetTab({ preferTabId, strictPreferredSellerTab, tabsApi, identityPolicy, ensureTab })`.
- Produces: non-strict buyer-tab fallback through `ensureTab()` and strict frozen-Seller failure with code `SELLER_CONTEXT_CHANGED`.
- Preserves: `searchVariantsLocal(input) -> Promise<{ ok, data? , error?, message? }>`.

- [ ] **Step 1: Add the failing resolver regression test**

Extend the existing `a frozen Seller tab is reused without opening or selecting another tab` test with two explicit cases:

```js
const fallback = { id: 99, url: 'https://seller.ozon.ru/app/products' };
const buyerResolved = await resolveSellerPortalTargetTab({
  preferTabId: 71,
  strictPreferredSellerTab: false,
  tabsApi: {
    async get() { return { id: 71, url: 'https://www.ozon.ru/product/4862904234' }; },
  },
  identityPolicy: policy,
  async ensureTab() { ensures += 1; return fallback; },
});
assert.strictEqual(buyerResolved, fallback);

await assert.rejects(resolveSellerPortalTargetTab({
  preferTabId: 70,
  strictPreferredSellerTab: true,
  tabsApi: { async get() { return { id: 70, url: 'https://example.com/' }; } },
  identityPolicy: policy,
  async ensureTab() { ensures += 1; return fallback; },
}), (error) => error?.code === 'SELLER_CONTEXT_CHANGED');
```

Add a behavior test for the focused preference resolver. It must treat the content-script sender as a non-strict performance hint and a trusted runtime snapshot as strict:

```js
assert.deepEqual(resolveSellerPortalPreference({
  sellerContext: null,
  sender: { tab: { id: 71 } },
}), {
  preferTabId: 71,
  strictPreferredSellerTab: false,
});
assert.deepEqual(resolveSellerPortalPreference({
  sellerContext: { companyId: '2681910', sellerTabId: 70 },
  sender: { tab: { id: 71 } },
}), {
  preferTabId: 70,
  strictPreferredSellerTab: true,
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
node extension/tests/seller-company-context-contract.test.js
```

Expected: FAIL because the resolver still throws for a buyer tab whenever `preferTabId` is present and `resolveSellerPortalPreference()` does not exist.

- [ ] **Step 3: Implement the minimal resolver behavior**

Change the resolver so a preferred non-Seller tab is strict only when explicitly requested:

```js
const resolveSellerPortalTargetTab = async ({
  preferTabId,
  strictPreferredSellerTab = false,
  tabsApi = chrome.tabs,
  identityPolicy = globalThis.JzSellerIdentityPolicy,
  ensureTab = ensureSellerTab,
} = {}) => {
  const preferredId = Number(preferTabId);
  if (!Number.isSafeInteger(preferredId) || preferredId <= 0) return ensureTab();
  try {
    const preferred = await tabsApi.get(preferredId);
    const effectiveUrl = String(preferred?.pendingUrl || preferred?.url || '');
    if (identityPolicy.isTrustedSellerTab({ ...preferred, url: effectiveUrl })) return preferred;
  } catch {}
  if (!strictPreferredSellerTab) return ensureTab();
  throw Object.assign(new Error('SELLER_CONTEXT_CHANGED'), {
    code: 'SELLER_CONTEXT_CHANGED',
  });
};
```

Add the focused preference resolver next to the Seller portal resolver:

```js
const resolveSellerPortalPreference = ({ sellerContext, sender } = {}) => ({
  preferTabId: sellerContext?.sellerTabId || sender?.tab?.id || null,
  strictPreferredSellerTab: Boolean(sellerContext),
});
```

Pass `opts.strictPreferredSellerTab` from `fetchSellerPortal()` to the resolver. In `searchVariantsLocal()`, use `resolveSellerPortalPreference({ sellerContext: input.sellerContext, sender })`, then pass the returned strict flag through `readSellerSearchVariants(...requestOptions)`, `enrichSellerSearchItems()`, `fetchBundleByVariantId()` and finally `fetchSellerPortal()`. Do not accept this value from the content-script message object.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```sh
node extension/tests/seller-company-context-contract.test.js
node extension/tests/seller-identity-policy.test.js
node extension/tests/sync-capability-removed.test.js
node extension/tests/data-panel-visual-browser.test.js
node extension/tests/collector-ozon-enrichment-client.test.js
```

Expected: all tests pass, including the new buyer fallback and the existing frozen-Seller boundary.

- [ ] **Step 5: Commit the source fix**

```sh
git add extension/background/service-worker.js extension/tests/seller-company-context-contract.test.js
git commit -m "fix(extension): fall back safely from buyer tabs"
```

---

### Task 2: Package and verify the extension

**Files:**
- Generated: `app/public/sonli-extension-0.13.46.2/`
- Generated: `app/public/sonli-extension-0.13.46.2.zip`
- Generated: `app/dist/sonli-extension-0.13.46.2.zip`

**Interfaces:**
- Consumes: the verified `extension/` source tree.
- Produces: matching unpacked and ZIP artifacts for the local extension download page.
- Preserves: extension release version `0.13.46.2` and existing download contract.

- [ ] **Step 1: Regenerate packaged artifacts**

Run:

```sh
node scripts/package-extension.mjs
```

Expected: the unpacked public directory and both ZIP archives are regenerated from `extension/`.

- [ ] **Step 2: Verify package parity and release contracts**

Run:

```sh
node scripts/check-extension-zip.mjs
node scripts/check-extension-zip-smoke.mjs
node scripts/check-plugin-readiness-gate.mjs
QH_LOCAL_NO_DOTENV=1 node --test --test-concurrency=1 server/tests/extension-release-contract.test.mjs
git diff --check
```

Expected: both ZIP files match the extension source, smoke tests pass, readiness passes, release metadata remains aligned, and the diff has no whitespace errors.

- [ ] **Step 3: Run the complete active extension regression**

Run all active extension tests from `scripts/test-manifest.mjs`, excluding only the repository's pre-existing `extension/tests/ui-parity-exception-gate.test.js` exception gate.

Expected: zero failures and zero unexpected skips.

- [ ] **Step 4: Commit generated artifacts**

```sh
git add app/public/sonli-extension-0.13.46.2 app/public/sonli-extension-0.13.46.2.zip
git add -u app/dist/sonli-extension-0.13.46.2.zip
git commit -m "chore(extension): package buyer-tab fallback fix"
```

- [ ] **Step 5: Merge locally and re-run the merged regression**

Fast-forward the verified branch into local `main`, then run the complete active extension regression again from `main`. Remove only this plan's temporary worktree and branch after the merged tree is green.

- [ ] **Step 6: Verify in the real browser**

After the user reloads or reinstalls the updated extension, open the existing Ozon product page and verify:

1. `searchVariants` no longer reports `SELLER_CONTEXT_CHANGED` for the ordinary buyer page.
2. The data-panel header no longer shows “部分商品数据加载失败” for this cause.
3. Category, weight, length, width and height populate when Ozon supplies them.
4. Existing Seller pages are not repeatedly opened, refreshed or closed.

Record any external Ozon data still unavailable separately; do not present unavailable source data as a code failure.

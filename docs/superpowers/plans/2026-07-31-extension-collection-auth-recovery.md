# Extension Collection Auth Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ozon collection recover the current Seller company context without relying on one Cookie, require the Web Collector session before protected data work, and show the real collection failure.

**Architecture:** A narrowly scoped MAIN-world observer extracts only the numeric `x-o3-company-id` already used by Seller page requests and hands it to the background through a validated content bridge. The background resolves one trusted company context from Cookie plus per-tab observations and fails closed on conflicts. Data-card and collection entry points check the account-scoped Collector session first, while source errors retain stable codes through the existing message contract.

**Tech Stack:** Chrome Extension Manifest V3, browser content scripts, `chrome.storage.session`, Node `assert`, Playwright browser fixtures, React/Vite Web application, repository verification scripts.

## Global Constraints

- Do not read or persist Web `localStorage`, Web Bearer tokens, Seller cookies, complete Seller headers, request bodies, or responses in the new observer.
- Accept observed company IDs only from `https://seller.ozon.ru` top-level tabs and validate them with `^\d{4,15}$`.
- Cookie and observed contexts must agree; multiple company IDs fail closed.
- Keep the account-level collection-box contract and do not add a store ID to collection uploads.
- Do not change database schemas or backend API response shapes.
- Preserve all existing uncommitted user changes.

---

### Task 1: Trusted Seller company-context observer

**Files:**
- Create: `extension/lib/seller-company-context.js`
- Create: `extension/content/seller-company-context-hook.js`
- Modify: `extension/content/ozon-seller-bridge.js`
- Modify: `extension/manifest.json`
- Modify: `extension/tests/seller-identity-policy.test.js`
- Create: `extension/tests/seller-company-context.test.js`

**Interfaces:**
- Produces: `JzSellerCompanyContext.normalizeCompanyId(value)`.
- Produces: `JzSellerCompanyContext.installObserver({ root, onCompanyId })`, returning an uninstall function.
- Produces runtime message `{ action: "sellerCompanyContextObserved", companyId }`.

- [ ] **Step 1: Write failing pure observer tests**

Test that fetch and XHR requests carrying `x-o3-company-id: 2681910` emit only
`2681910`, while unrelated headers, invalid values, and duplicate values do not emit.

- [ ] **Step 2: Verify the observer test fails**

Run: `node extension/tests/seller-company-context.test.js`

Expected: FAIL because `extension/lib/seller-company-context.js` does not exist.

- [ ] **Step 3: Implement the minimal observer and bridge**

Create the UMD helper, install it from the MAIN-world hook at `document_start`, validate
same-window/same-origin messages in `ozon-seller-bridge.js`, and forward only the
numeric ID to the service worker.

- [ ] **Step 4: Verify the observer test passes**

Run: `node extension/tests/seller-company-context.test.js`

Expected: PASS with no console warnings.

### Task 2: Fail-closed Seller identity resolver

**Files:**
- Modify: `extension/lib/seller-identity-policy.js`
- Modify: `extension/tests/seller-identity-policy.test.js`
- Modify: `extension/background/service-worker.js`
- Create: `extension/tests/seller-company-context-contract.test.js`

**Interfaces:**
- Produces: `resolveTrustedSellerCompanyContext({ cookies, observations, sellerTabs, now, ttlMs }) -> { companyId, source, sellerTabId }`.
- Consumes: session keys `sonliSellerCompanyContext:<tabId>` containing `{ companyId, observedAt }`.
- Produces: `resolveCurrentSellerCompanyContext()` for `searchVariants` and `fetchSellerPortal`.

- [ ] **Step 1: Write failing identity tests**

Cover Cookie-only success, observation-only success, matching Cookie plus observation,
conflict rejection, stale observation rejection, and non-Seller-tab rejection.

- [ ] **Step 2: Verify the identity test fails for observation fallback**

Run: `node extension/tests/seller-identity-policy.test.js`

Expected: FAIL because the current policy requires `sc_company_id`.

- [ ] **Step 3: Implement the resolver and background storage**

Store observations by sender tab ID after validating the sender URL. Resolve Cookie and
observations through one policy helper, pass the resolved ID into `fetchSellerPortal`,
and replace the early `searchVariants` Cookie failure with the unified resolver.

- [ ] **Step 4: Verify identity and service-worker contract tests**

Run:

```sh
node extension/tests/seller-identity-policy.test.js
node extension/tests/seller-company-context-contract.test.js
```

Expected: PASS, including a source assertion that `searchVariants` uses the unified
resolver instead of directly failing on a missing Cookie.

### Task 3: Web Collector-session gate

**Files:**
- Modify: `extension/content/shared-utils.js`
- Modify: `extension/content/ozon-data-panel.js`
- Modify: `extension/content/ozon-search.js`
- Modify: `extension/content/ozon-product.js`
- Modify: `extension/tests/data-panel-visual-browser.test.js`
- Modify: `extension/tests/fixtures/data-panel-visual-browser.fixture.html`

**Interfaces:**
- `jzDataCardAllowed() -> { allowed: boolean, reason?: "WEB_AUTH_REQUIRED" }`.
- `jzRenderDataCardLoginRequired(container)` renders a direct Web-login button.
- `checkAuth()` remains the only content-visible auth status and exposes no credential.

- [ ] **Step 1: Write failing browser tests**

Add a fixture mode where `getAuth` returns unauthenticated. Assert that the panel renders
the Web-login action, does not request `searchVariants`, and never invokes
`pushSourceCollect`.

- [ ] **Step 2: Verify the browser test fails**

Run: `node extension/tests/data-panel-visual-browser.test.js`

Expected: FAIL because the current membership gate fails open on Web 401.

- [ ] **Step 3: Implement the Collector-session-first gate**

Call `checkAuth()` before membership lookup. Render the login-required state for
`WEB_AUTH_REQUIRED`; retain the existing membership lock only for authenticated users
whose `DATA_CARD` entitlement is explicitly false.

- [ ] **Step 4: Verify the browser test passes**

Run: `node extension/tests/data-panel-visual-browser.test.js`

Expected: PASS for anonymous, member-locked, and authenticated data-card modes.

### Task 4: Preserve and display collection source errors

**Files:**
- Modify: `extension/content/shared-utils.js`
- Modify: `extension/content/ozon-data-panel.js`
- Modify: `extension/tests/data-panel-visual-browser.test.js`
- Modify: `extension/tests/fixtures/data-panel-visual-browser.fixture.html`

**Interfaces:**
- `sendMessage()` rejects with `error.code`, `error.status`, and a safe message.
- `collectSourceFields()` returns or throws the original `searchVariants` error.
- Collection buttons distinguish Web auth, Seller context, missing source fields, and network failures.

- [ ] **Step 1: Write failing browser tests**

Simulate `AUTH_REQUIRED` from `searchVariants` and assert the button says Seller context
is not ready. Simulate a successful empty response and assert the button lists
`类目、重量、长度、宽度、高度`. In both cases assert zero uploads.

- [ ] **Step 2: Verify the new assertions fail**

Run: `node extension/tests/data-panel-visual-browser.test.js`

Expected: FAIL because the current catch path reduces both cases to `数据不完整`.

- [ ] **Step 3: Implement stable error propagation and copy**

Attach response codes in `sendMessage`, stop discarding the second source lookup error,
and map stable codes to specific button copy plus a full diagnostic title.

- [ ] **Step 4: Verify all focused extension tests**

Run:

```sh
node extension/tests/seller-company-context.test.js
node extension/tests/seller-identity-policy.test.js
node extension/tests/data-panel-visual-browser.test.js
```

Expected: PASS.

### Task 5: Mirror, package, and full verification

**Files:**
- Mirror modified extension files under: `app/public/sonli-extension-0.13.46.1/`
- Rebuild: `app/public/sonli-extension-0.13.46.1.zip`

**Interfaces:**
- Source tree, public extension directory, and ZIP contents must be byte-consistent.

- [ ] **Step 1: Run formatting and diff checks**

Run:

```sh
git diff --check
node scripts/check-extension-diff-contract.mjs
```

Expected: PASS.

- [ ] **Step 2: Package the extension**

Run: `node scripts/package-extension.mjs`

Expected: public directory and ZIP rebuilt from `extension/`.

- [ ] **Step 3: Run the full verification gate**

Run:

```sh
QH_SOURCE_EXTENSION_DIR="/Users/songliang/Desktop/0.13.46.1" node scripts/verify.mjs
```

Expected: all extension tests, application build, package smoke, security checks, and
source/public/ZIP parity pass. Database and PostgreSQL-only tests may be reported as
configuration-based skips and must be listed explicitly.

- [ ] **Step 4: Record rollback and remaining external validation**

Document changed files, tests, browser-only external validation still required, and the
rollback commit. Do not claim Ozon production success unless the updated extension is
reloaded and one real product is collected successfully.

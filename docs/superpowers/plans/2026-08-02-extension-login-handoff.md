# Extension Login Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Web-to-extension login recognition immediate after any-length Web login while reusing an existing trusted Web tab.

**Architecture:** Keep the current one-time Collector ticket exchange unchanged. Add a credential-free `collector.auth.ready` page event so the Web bridge can wake the content script after React confirms login, and place trusted Web-tab reuse behind one dependency-injected extension library consumed by the service worker.

**Tech Stack:** React 19, Chrome Manifest V3 service worker/content scripts, Node.js built-in test runner, CommonJS-compatible extension libraries, Vite.

## Global Constraints

- The Web bearer must remain inside Web requests; page messages may never contain it.
- Collector tickets and tokens must not be logged or persisted in `chrome.storage.local`.
- Ready messages must have the exact shape `{ protocol: "SONLI_COLLECTOR_AUTH", action: "collector.auth.ready" }`.
- Existing request ID, same-window, same-origin, trusted-sender and portal-route checks remain mandatory.
- Existing Web tabs must be focused without rewriting their URL; only a missing trusted tab may create `http://127.0.0.1:3000/login`.
- No database, account permission, store boundary, collection API or Seller-login changes.
- Every production behavior change follows RED → GREEN before packaging.

---

### Task 1: Publish a credential-free Web bridge ready event

**Files:**
- Modify: `app/src/collector-auth-bridge.js`
- Modify: `app/tests/collector-auth-bridge.test.mjs`

**Interfaces:**
- Produces: `COLLECTOR_AUTH_ACTIONS.ready === "collector.auth.ready"`.
- Produces: installing the bridge while `isLoggedIn()` is true posts the exact ready envelope once.
- Preserves: `installCollectorAuthBridge({ isLoggedIn, requestTicket, postResponse, windowObject }) => uninstall`.

- [ ] **Step 1: Write the failing ready-envelope test**

Update `createWindowHarness()` so its `windowObject.postMessage(payload, targetOrigin)` records posts. Add a test that installs the real bridge with `isLoggedIn: () => true` and asserts the first post is the hand-written literal below and contains no additional key:

```js
assert.deepEqual(posts, [{
  payload: {
    protocol: "SONLI_COLLECTOR_AUTH",
    action: "collector.auth.ready",
  },
  targetOrigin: "http://127.0.0.1:3000",
}]);
assert.deepEqual(Object.keys(posts[0].payload).sort(), ["action", "protocol"]);
```

Also install with `isLoggedIn: () => false` and assert no ready post is emitted.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test app/tests/collector-auth-bridge.test.mjs
```

Expected: FAIL because `collector.auth.ready` is never posted.

- [ ] **Step 3: Implement the minimal ready publication**

Add the action and publish after the message listener is installed:

```js
export const COLLECTOR_AUTH_ACTIONS = Object.freeze({
  request: "collector.auth.request",
  response: "collector.auth.response",
  ready: "collector.auth.ready",
});

// after addEventListener
if (isLoggedIn()) {
  send({
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.ready,
  });
}
```

Use the existing `send` adapter so production posts only to `window.location.origin` and tests can inspect the same observable boundary.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `node --test app/tests/collector-auth-bridge.test.mjs`.

Expected: all bridge tests PASS; ticket responses still omit Web bearer and store data.

- [ ] **Step 5: Commit Task 1**

```bash
git add app/src/collector-auth-bridge.js app/tests/collector-auth-bridge.test.mjs
git commit -m "feat(auth): announce ready collector bridge"
```

---

### Task 2: Restart bounded authentication when the Web bridge becomes ready

**Files:**
- Modify: `extension/lib/web-bridge-policy.js`
- Modify: `extension/content/sync-auth.js`
- Modify: `extension/tests/web-bridge-policy.test.js`
- Modify: `extension/tests/sync-auth-runtime.test.js`

**Interfaces:**
- Produces: `normalizeCollectorAuthReady(value) => { protocol, action } | null`.
- Consumes: the exact Task 1 ready envelope.
- Preserves: no more than two ticket exchange attempts per authentication cycle and no concurrent exchange.

- [ ] **Step 1: Write failing policy tests for the exact ready envelope**

Add literal assertions:

```js
assert.deepEqual(normalizeCollectorAuthReady({
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.ready",
}), {
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.ready",
});

for (const unsafe of [
  { protocol: "SONLI_COLLECTOR_AUTH", action: "collector.auth.ready", token: "never" },
  { protocol: "OTHER", action: "collector.auth.ready" },
  { protocol: "SONLI_COLLECTOR_AUTH", action: "collector.auth.response" },
]) assert.equal(normalizeCollectorAuthReady(unsafe), null);
```

- [ ] **Step 2: Extend the runtime test and verify RED**

Drive the existing real timer harness until ten initial request callbacks have run. Dispatch an exact same-window, same-origin ready event and assert:

```js
assert.equal(posts.length, 11, "ready must start a fresh bounded request cycle");
assert.equal(posts.at(-1).message.action, "collector.auth.request");
```

Dispatch ready with a foreign `source`, a foreign `origin`, or an extra `token` key and assert the post count does not change. Run:

```bash
node extension/tests/web-bridge-policy.test.js
node extension/tests/sync-auth-runtime.test.js
```

Expected: both fail because ready normalization and restart behavior do not exist.

- [ ] **Step 3: Implement exact ready normalization**

In `web-bridge-policy.js`, require a non-array object whose only keys are `protocol` and `action`, and export:

```js
const normalizeCollectorAuthReady = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "action,protocol") return null;
  if (value.protocol !== COLLECTOR_AUTH_PROTOCOL || value.action !== READY_ACTION) return null;
  return { protocol: COLLECTOR_AUTH_PROTOCOL, action: READY_ACTION };
};
```

- [ ] **Step 4: Implement a single bounded-cycle restart in `sync-auth.js`**

Extract the existing counter reset into one local function:

```js
const restartRequestCycle = () => {
  if (exchangeInFlight || authenticated) return false;
  clearTimeout(retryTimer);
  retryTimer = null;
  attempts = 0;
  requestCount = 0;
  requestTicket();
  return true;
};
```

In the existing window message listener, after the source/origin checks and before response normalization, accept only `policy.normalizeCollectorAuthReady(event.data)` and call `restartRequestCycle()`. Make the runtime `collector.auth.request` listener use the same function. Do not introduce an interval or unbounded timer.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the two commands from Step 2.

Expected: ready restarts after the old ten-request window; malformed events do nothing; ticket exchange behavior remains one exchange for one valid response.

- [ ] **Step 6: Commit Task 2**

```bash
git add extension/lib/web-bridge-policy.js extension/content/sync-auth.js extension/tests/web-bridge-policy.test.js extension/tests/sync-auth-runtime.test.js
git commit -m "fix(auth): wake extension after Web login"
```

---

### Task 3: Reuse the trusted Web tab from the popup

**Files:**
- Create: `extension/lib/frontend-tab-opener.js`
- Create: `extension/tests/frontend-tab-opener.test.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/popup/popup.js`
- Modify: `extension/popup/__tests__/popup-routing.smoke.test.js`
- Modify: `scripts/extension-capture-only-policy.test.mjs`

**Interfaces:**
- Produces: `JzFrontendTabOpener.createFrontendTabOpener(dependencies)`.
- Consumes dependencies: `queryTabs()`, `updateTab(id, update)`, `updateWindow(id, update)`, `createTab(options)`, `requestCollectorAuth(tabId)`.
- Produces operation: `open({ url }) => { opened: true, reused: boolean, tabId?: number } | { opened: false }`.
- Preserves: `openFrontend` accepts only a leading-slash path and selects local versus hosted base URL using the existing backend rule.

- [ ] **Step 1: Write the failing opener behavior test**

Use real opener code with Chrome operations replaced only at the external API boundary. Cover these literal outcomes:

```js
assert.deepEqual(await open({ url: "http://127.0.0.1:3000/login" }), {
  opened: true,
  reused: true,
  tabId: 17,
});
assert.deepEqual(updatedTabs, [{ id: 17, update: { active: true } }]);
assert.deepEqual(createdTabs, []);
assert.deepEqual(requestedAuthTabs, [17]);
```

Add separate tests that no existing tab creates exactly `{ url, active: true }`, and that a failed focus falls back to exactly one created tab. Authentication-message rejection must not change `{ opened: true }`.

- [ ] **Step 2: Run the opener test and verify RED**

Run:

```bash
node --test extension/tests/frontend-tab-opener.test.js
```

Expected: FAIL because the library does not exist.

- [ ] **Step 3: Implement the dependency-injected opener**

Follow the repository's UMD-compatible extension library pattern. Select the first tab with an integer `id`; focus it and its window without changing URL. If focus fails, create a new active tab. After either path, call `requestCollectorAuth(tabId)` inside a nested `try/catch` so a not-yet-injected content script cannot make opening fail. Return only `opened`, `reused`, and numeric `tabId`.

- [ ] **Step 4: Run the opener test and verify GREEN**

Run `node --test extension/tests/frontend-tab-opener.test.js`.

Expected: all reuse, create, fallback and best-effort authentication cases PASS.

- [ ] **Step 5: Write failing integration contracts**

Update popup smoke expectations so `web-login-btn` must call:

```js
await sendMessage({ action: "openFrontend", path: "/login" });
```

and must not call `chrome.tabs.create` directly. Update the capture-only policy fixture to accept routed Web login guidance instead of direct tab creation. Run:

```bash
node extension/popup/__tests__/popup-routing.smoke.test.js
node --test scripts/extension-capture-only-policy.test.mjs
```

Expected: FAIL until popup and service-worker integration are updated.

- [ ] **Step 6: Wire the opener into the service worker**

Add `../lib/frontend-tab-opener.js` to top-level `importScripts`. Construct one opener with Chrome adapters and the existing trusted patterns:

```js
const openFrontendTab = globalThis.JzFrontendTabOpener.createFrontendTabOpener({
  queryTabs: () => chrome.tabs.query({
    url: [`*://${BRAND_WEB_HOST}/*`, ...LOCAL_FRONTEND_TAB_URLS],
  }),
  updateTab: (id, update) => chrome.tabs.update(id, update),
  updateWindow: (id, update) => chrome.windows.update(id, update),
  createTab: (options) => chrome.tabs.create(options),
  requestCollectorAuth: (tabId) => chrome.tabs.sendMessage(tabId, {
    action: "collector.auth.request",
  }),
});
```

Replace only the body of the `openFrontend` case after URL construction with `return { ok: true, data: await openFrontendTab({ url }) };`.

- [ ] **Step 7: Route the popup login button and show failures**

Replace direct `chrome.tabs.create` with an async listener that calls `openFrontend`. Before awaiting, use `showTip("正在打开 Web 登录页…", false)`. If the returned data does not have `opened === true`, or messaging throws, show `无法打开 Web 登录页，请确认本地服务已启动`. Do not set authenticated state in the popup.

- [ ] **Step 8: Run Task 3 tests and verify GREEN**

Run:

```bash
node --test extension/tests/frontend-tab-opener.test.js
node extension/popup/__tests__/popup-routing.smoke.test.js
node --test scripts/extension-capture-only-policy.test.mjs
node extension/tests/sync-auth-runtime.test.js
node app/tests/collector-auth-bridge.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add extension/lib/frontend-tab-opener.js extension/tests/frontend-tab-opener.test.js extension/background/service-worker.js extension/popup/popup.js extension/popup/__tests__/popup-routing.smoke.test.js scripts/extension-capture-only-policy.test.mjs
git commit -m "fix(auth): reuse Web login tab"
```

---

### Task 4: Package and verify the complete login handoff

**Files:**
- Modify generated mirror: `app/public/sonli-extension-0.13.46.2/**`
- Modify generated ZIP: `app/public/sonli-extension-0.13.46.2.zip`
- Modify generated ZIP: `app/dist/sonli-extension-0.13.46.2.zip`

**Interfaces:**
- Consumes the exact `extension/` source tree from Tasks 1–3.
- Produces byte-equivalent unpacked and ZIP install artifacts.

- [ ] **Step 1: Run the focused cross-layer regression suite**

```bash
node --test app/tests/collector-auth-bridge.test.mjs extension/tests/frontend-tab-opener.test.js
node extension/tests/web-bridge-policy.test.js
node extension/tests/sync-auth-runtime.test.js
node extension/popup/__tests__/popup-routing.smoke.test.js
node --test extension/tests/collector-session.test.js extension/tests/portal-bridge-policy.test.js extension/tests/sync-capability-removed.test.js scripts/extension-capture-only-policy.test.mjs
```

Expected: all configured tests PASS with no unexpected skip.

- [ ] **Step 2: Build the Web app**

Run `node node_modules/vite/bin/vite.js build` from `app/`.

Expected: Vite exits 0; the existing bundle-size warning may remain but no build error is allowed.

- [ ] **Step 3: Package the extension**

Run `node scripts/package-extension.mjs` from the worktree root.

Expected: unpacked public extension and both ZIP paths are regenerated.

- [ ] **Step 4: Verify release artifacts and safety gates**

```bash
node scripts/check-extension-zip.mjs
node scripts/check-extension-zip-smoke.mjs
node scripts/check-personal-data.mjs
node scripts/check-plugin-readiness-gate.mjs
diff -qr extension app/public/sonli-extension-0.13.46.2
git diff --check
```

Expected: ZIPs match 100%, startup/readiness/security checks pass, unpacked mirror has no diff, and Git whitespace check exits 0.

- [ ] **Step 5: Perform a read-only code review**

Review the range beginning at `31d796d` through the final working tree against `docs/superpowers/specs/2026-08-02-extension-login-handoff-design.md`. Fix every Critical or Important finding using a fresh RED → GREEN cycle.

- [ ] **Step 6: Commit packaged artifacts**

```bash
git add -u app/public/sonli-extension-0.13.46.2 app/public/sonli-extension-0.13.46.2.zip app/dist/sonli-extension-0.13.46.2.zip
git commit -m "chore(extension): package immediate login handoff"
```

- [ ] **Step 7: Record delivery evidence**

Report changed contracts, exact test results, Web-tab/login regression coverage, unconfigured integrations, rollback commit range and the one required user action: reload the unpacked extension once.

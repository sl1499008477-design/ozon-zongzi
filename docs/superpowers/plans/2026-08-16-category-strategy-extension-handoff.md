# Category Strategy Extension Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the first-session extension readiness deadlock and reliably open the exact Ozon category sampling page through the authenticated browser extension.

**Architecture:** Add a closed same-origin Web-to-extension handoff adapter. The adapter first establishes extension readiness, then the existing administrator API creates or reuses the sampling session, and finally the extension background worker opens the server-issued Ozon URL after strict validation. The existing backend readiness, permission, account, secret, and idempotency contracts remain unchanged.

**Tech Stack:** React, browser `postMessage`, Chrome MV3 content scripts/service worker, Node test runner, Vite.

## Global Constraints

- Keep the backend five-minute readiness gate and minimum extension version `0.13.46.3` unchanged.
- Never send Web bearer credentials, collector tickets, account identifiers, or sampling session secrets through the page bridge.
- Accept only `https://www.ozon.ru/category/<positive numeric id>/` URLs with exactly one safe `zongziCategoryStrategySession` parameter.
- A readiness failure must occur before any sampling-session database write.
- An open failure after session creation must leave the durable command intent unsettled so retry reuses the same session.
- Verification must not call paid AI, publish a strategy, confirm samples, or perform an Ozon write.

---

### Task 1: Closed Web application extension adapter

**Files:**
- Create: `app/src/category-strategy-extension-bridge.js`
- Create: `app/tests/category-strategy-extension-bridge.test.mjs`
- Modify: `app/src/category-strategy-client.js`
- Test: `app/tests/category-strategy-model.test.mjs`

**Interfaces:**
- Consumes: same-window/same-origin `postMessage` and the existing `__jz: "v1"` portal protocol.
- Produces: `createCategoryStrategyExtensionBridge({ windowObject, timeoutMs })` returning `ready()` and `open(browserUrl)`.

- [ ] **Step 1: Write failing adapter tests**

Test the public contract with a fake window:

```js
const bridge = createCategoryStrategyExtensionBridge({ windowObject, timeoutMs: 20 });
const ready = bridge.ready();
assert.deepEqual(posted[0], {
  __jz: "v1", kind: "category-strategy.readiness.request", reqId: posted[0].reqId,
});
dispatch({
  __jz: "v1", kind: "category-strategy.readiness.response", reqId: posted[0].reqId,
  ok: true, ready: true, version: "0.13.46.3",
});
assert.deepEqual(await ready, { ready: true, version: "0.13.46.3" });
```

Add equivalent coverage for `open(browserUrl)`, timeout, wrong origin/source, extra response keys, negative response, unsafe input URL, and stable error codes.

- [ ] **Step 2: Run RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/category-strategy-extension-bridge.test.mjs
```

Expected: FAIL because `category-strategy-extension-bridge.js` does not exist.

- [ ] **Step 3: Implement the minimum closed adapter**

Implement a request helper that creates one bounded request identifier, installs one listener, posts only the exact request shape, times out, removes its listener in every terminal path, and projects exact response shapes. Throw objects with these stable codes:

```js
AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY
AUTO_LISTING_CATEGORY_STRATEGY_BROWSER_OPEN_FAILED
```

Add the second code to `categoryStrategyErrorMessage` with the copy:

```text
无法打开 Ozon 选样页，请刷新扩展后重试。
```

- [ ] **Step 4: Run GREEN**

Run the new adapter test and `app/tests/category-strategy-model.test.mjs`. Expected: all pass.

- [ ] **Step 5: Check the focused diff**

Run syntax checks on the new source/test and `git diff --check`. Do not commit until Tasks 2 and 3 complete because the cross-layer contract is not useful independently.

---

### Task 2: Extension readiness and safe tab-opening bridge

**Files:**
- Create: `extension/lib/category-strategy-handoff.js`
- Create: `extension/tests/category-strategy-handoff.test.js`
- Modify: `extension/manifest.json`
- Modify: `extension/content/jizhangerp-bridge.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/lib/category-strategy-sampling.js`
- Modify: `extension/tests/category-strategy-sampling.test.js`
- Modify: `extension/tests/jizhangerp-bridge-follow-sell.test.js`
- Modify: `extension/tests/removed-selection-watermark-contract.test.js`

**Interfaces:**
- Consumes: authenticated collector session manager and existing extension readiness HTTP endpoint.
- Produces: `JzCategoryStrategyHandoff.projectBrowserUrl(raw)`, sampling client `ready()`, runtime actions `CATEGORY_STRATEGY_READINESS` and `CATEGORY_STRATEGY_BROWSER_OPEN`.

- [ ] **Step 1: Write failing URL and standalone readiness tests**

The URL projector must accept only:

```js
https://www.ozon.ru/category/17028922/?zongziCategoryStrategySession=session-a
```

It must reject wrong origins, non-category paths, zero/non-numeric category identifiers, credentials, fragments, duplicate/missing session parameters, extra query parameters, unsafe identifiers, accessors, proxies, and overlong input.

Add a sampling-client test asserting:

```js
await client.ready();
assert.deepEqual(requests, [{
  method: "POST",
  path: "/extension/auto-listing/category-strategy/readiness",
  headers: { "x-zongzi-extension-version": "0.13.46.3" },
  body: {},
}]);
```

- [ ] **Step 2: Run RED**

Run the two exact extension test files. Expected: FAIL because the projector and `ready()` do not exist.

- [ ] **Step 3: Implement the pure URL projector and readiness method**

Use a UMD-style closed module consistent with `category-strategy-sampling.js`. `ready()` must authenticate through `currentAccount()` before posting readiness and must return only `{ ready: true }` plus the safe minimum-version field returned by the backend.

- [ ] **Step 4: Write failing bridge and service-worker contract tests**

Extend the VM bridge harness to verify:

```js
{ action: "CATEGORY_STRATEGY_READINESS" }
{ action: "CATEGORY_STRATEGY_BROWSER_OPEN", browserUrl }
```

and exact `category-strategy.*.response` messages. Assert foreign origin/source, extra request keys, unsafe URLs, or failed worker responses never report success. Extend the static runtime contract test to require both new actions and the shared projector.

- [ ] **Step 5: Run the second RED**

Run `jizhangerp-bridge-follow-sell.test.js` and `removed-selection-watermark-contract.test.js`. Expected: FAIL on the missing messages/actions.

- [ ] **Step 6: Implement the bridge and background cases**

Load `lib/category-strategy-handoff.js` before `content/jizhangerp-bridge.js` and in the worker. Add strict request-key checks in the content bridge. In the worker:

```js
case "CATEGORY_STRATEGY_READINESS":
  return { ok: true, data: await categoryStrategySamplingClient.ready() };
case "CATEGORY_STRATEGY_BROWSER_OPEN": {
  const browserUrl = globalThis.JzCategoryStrategyHandoff.projectBrowserUrl(message.browserUrl);
  await chrome.tabs.create({ url: browserUrl, active: true });
  return { ok: true, data: { opened: true } };
}
```

Return no Chrome tab metadata to the Web page.

- [ ] **Step 7: Run GREEN and extension regressions**

Run all four changed extension tests plus `manifest-security-contract.test.js`, `portal-bridge-policy.test.js`, and `web-bridge-policy.test.js`. Expected: all pass.

---

### Task 3: Order the sampling handoff and preserve retry identity

**Files:**
- Modify: `app/src/category-strategy-bootstrap.js`
- Modify: `app/src/CategoryStrategyPage.jsx`
- Modify: `app/tests/category-strategy-bootstrap.test.mjs`
- Modify: `app/tests/category-strategy-page.test.mjs`

**Interfaces:**
- Consumes: `extensionBridge.ready()`, `extensionBridge.open(browserUrl)`, existing `client.startSession`, and durable intent store.
- Produces: `handoffCategoryStrategySampling({ client, extensionBridge, draft, identity })` and updated `startCategoryStrategySampling`.

- [ ] **Step 1: Write failing workflow-order tests**

Record calls and require this exact order:

```js
["extension-ready", "start-session", "extension-open", "intent-settle"]
```

Add tests that readiness failure makes zero `startSession` calls, open failure makes zero settle calls, active-session bootstrap invokes only `extension.open`, and retry reuses the stored identity.

- [ ] **Step 2: Run RED**

Run `app/tests/category-strategy-bootstrap.test.mjs`. Expected: FAIL because the current helper starts the server session before any extension call.

- [ ] **Step 3: Implement the minimal workflow change**

Create one handoff primitive and use it from initial sampling, manual “继续选样”, sample replacement, and active-session reopening. Instantiate the extension adapter once per page. Remove automatic asynchronous `window.open`; retain only the extension-backed explicit reopen button.

- [ ] **Step 4: Run GREEN**

Run the bootstrap, page-contract, page, model, and extension-adapter tests. Expected: all pass.

- [ ] **Step 5: Verify no authority expansion**

Search the diff to confirm no Web token, collector ticket, account identifier, or session secret entered the new bridge messages, and no backend permission/readiness code changed.

---

### Task 4: Runtime and delivery verification

**Files:**
- Modify only if a failing verification exposes a defect within this design.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: tested implementation commit and a local runtime acceptance report.

- [ ] **Step 1: Run focused test suites**

Run all changed app and extension tests, the complete category-strategy server suites, client transport tests, and automatic-listing page contracts with test concurrency 1.

- [ ] **Step 2: Run static and build verification**

Run syntax checks for every changed JavaScript module, `git diff --check`, and the Vite production build.

- [ ] **Step 3: Restart only affected local runtimes**

Restart the local API and Vite frontend if their source changed. Do not restart the global AI worker or invoke paid/external operations.

- [ ] **Step 4: Perform browser acceptance**

Verify the current draft remains account-scoped and recoverable. When a compatible extension is connected, click “继续选样” once and confirm one Ozon category tab opens with the exact category/session URL and the sampling bar appears. If no compatible extension is connected, verify the explicit readiness error, zero new session rows, and report the external-browser step as unverified rather than weakening the gate.

- [ ] **Step 5: Review and commit**

Review the final diff for contract closure, permissions, idempotency, and rollback. Commit all implementation and test files with:

```bash
git commit -m "fix: bootstrap category strategy extension handoff"
```

- [ ] **Step 6: Report delivery**

Report changed contracts, test/build/browser evidence, unverified scope, regression risk, and rollback by reverting the implementation commit. Do not merge or push unless explicitly requested.

# Extension Login Handoff Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the trusted Web login surface immediately while Collector authentication completes independently with a bounded exchange deadline.

**Architecture:** Keep tab creation/focus in `frontend-tab-opener` as the acknowledged foreground operation and launch the existing authentication recovery as contained best-effort work. Add an injected exchange-signal factory to the Collector session manager so the HTTP exchange cannot wait indefinitely. Preserve all trusted-origin, one-time-ticket, generation, account, permission, and session-storage boundaries.

**Tech Stack:** Chrome MV3 service worker and popup, CommonJS Node tests, existing extension packaging scripts.

## Global Constraints

- Do not change Web login credentials, Collector ticket contents, permissions, or account ownership.
- Do not persist Web bearer credentials or Collector tokens outside `chrome.storage.session`.
- Do not add a database migration or external login during verification.
- Rebuild and verify `app/public/sonli-extension-0.13.46.3` and its ZIP from `extension`.

---

### Task 1: Decouple login-page acknowledgement from authentication recovery

**Files:**
- Modify: `extension/lib/frontend-tab-opener.js`
- Modify: `extension/tests/frontend-tab-opener.test.js`
- Modify: `extension/popup/popup.js`
- Modify: `extension/popup/__tests__/popup-routing.smoke.test.js`

**Interfaces:**
- Consumes: existing `createFrontendTabOpener` dependencies and popup `openFrontend` runtime action.
- Produces: `open({ url })` that resolves after tab create/focus while `requestCollectorAuth` remains best-effort; honest popup copy after `{ opened: true }`.

- [ ] **Step 1: Write the failing opener test**

Add a test that holds the `requestCollectorAuth` promise, waits until that function has started, and proves `open()` still resolves with the exact opened result before the held promise is released. Retain the existing ordered injection assertions for a rejected missing receiver.

- [ ] **Step 2: Run RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/frontend-tab-opener.test.js
```

Expected: the new held-auth test reports that `open()` remains pending.

- [ ] **Step 3: Implement the minimum decoupling**

Start `requestAuthBestEffort(tabId, reused)` without awaiting it in `openedResult`. The helper already catches both the initial request and injection/retry failures, so it must not create an unhandled rejection. Do not change trusted tab selection or URLs in this task.

- [ ] **Step 4: Add and verify popup copy**

First extend the popup smoke contract to require `Web 登录页已打开，请完成登录后重新打开扩展` after a successful open response. Run it RED, add the copy after the exact `{ opened: true }` check, then run both tests GREEN.

---

### Task 2: Bound Collector ticket exchange

**Files:**
- Modify: `extension/lib/collector-session.js`
- Modify: `extension/tests/collector-session.test.js`

**Interfaces:**
- Consumes: `createCollectorSessionManager` and its existing injected transport dependencies.
- Produces: optional `createExchangeSignal()` dependency returning an `AbortSignal`; production default uses a 5-second `AbortSignal.timeout`.

- [ ] **Step 1: Write the failing timeout test**

Create an activated generation, inject a controlled abort signal and a fetch implementation that rejects only when that signal aborts, then call `exchangeCollectorTicket`. Assert the request receives the exact signal, the result rejects with `COLLECTOR_EXCHANGE_NETWORK_ERROR`, and logs contain neither the one-time ticket nor a bearer/token value.

- [ ] **Step 2: Run RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/collector-session.test.js
```

Expected: the fetch request has no exchange signal.

- [ ] **Step 3: Implement the bounded signal**

Validate `createExchangeSignal` as a function when supplied. Default it to `() => AbortSignal.timeout(5_000)`. Create a fresh signal per exchange and pass only that signal to the existing fetch options. Preserve the current sanitized catch boundary and ticket redaction.

- [ ] **Step 4: Run GREEN and authentication regressions**

Run Collector session, auth-flow, sync-auth runtime, frontend opener, popup routing, Web bridge policy, and service-worker runtime contract tests with test concurrency one.

---

### Task 3: Package and deliver the verified extension

**Files:**
- Regenerate: `app/public/sonli-extension-0.13.46.3/`
- Regenerate: `app/public/sonli-extension-0.13.46.3.zip`

**Interfaces:**
- Consumes: updated `extension` source tree.
- Produces: version-aligned local downloadable directory and ZIP.

- [ ] **Step 1: Regenerate the package**

Run `scripts/package-extension.mjs` with the bundled Node runtime.

- [ ] **Step 2: Verify distribution parity and startup**

Run source parity, distribution parity, ZIP equality, and ZIP smoke scripts. All must exit zero.

- [ ] **Step 3: Run final verification**

Run changed test suites, all Collector authentication/security regressions, JavaScript syntax checks, `git diff --check`, and the Vite production build. Do not perform a real login or inspect credentials.

- [ ] **Step 4: Review and commit**

Review permissions, origin boundaries, timeout error redaction, packaged parity, unverified scope, and rollback. Commit with:

```bash
git commit -m "fix: accelerate extension login handoff"
```


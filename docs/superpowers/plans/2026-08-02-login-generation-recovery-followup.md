# Login Generation Recovery Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two load-bearing recovery gaps found by final review so a transient Web generation failure retries in the live app and an internally cleared extension session can be restored by “重新检查” without reviving a stale tab generation.

**Architecture:** Keep the existing random, account-scoped generation contract. Add a small Web lifecycle runner that owns one bounded retry inside the existing React effect, and change authoritative extension recovery to discard its cached generation and rediscover the generation from the currently logged-in Web bridge before beginning and exchanging a ticket.

**Tech Stack:** React 19, Chrome Manifest V3 service worker/content scripts, Node.js built-in tests, CommonJS-compatible extension libraries, Vite.

## Global Constraints

- Preserve all constraints in `docs/superpowers/plans/2026-08-02-login-generation-boundary.md`, including the exact bridge contracts, generation validation, account boundary, request limits, and no permanent authentication interval.
- A Web generation factory failure may schedule exactly one delayed retry for the same stable account effect; cleanup must cancel the retry and any installed bridge.
- “重新检查” must not trust the content script's cached generation. It must start discovery, adopt the generation returned by the current same-origin Web bridge, call `beginGeneration()`, then exchange the matching ticket.
- A stale tab must not reactivate its cached generation after internal logout or after a newer Web generation exists.
- Internal logout continues to clear both Collector session and generation storage before recovery.
- No database, password rule, account permission, store configuration, Seller login, Ozon collection API, product schema, or collection data change is allowed.
- Every production change follows RED → GREEN; source tests pass before generated extension artifacts are changed.

## File Responsibility Map

- `app/src/collector-auth-bridge.js`: own the bounded Web generation lifecycle runner.
- `app/src/App.jsx`: invoke the lifecycle runner from the existing stable account-ID effect.
- `app/tests/collector-auth-bridge.test.mjs`: prove the live orchestration retries and cleans up.
- `extension/lib/collector-auth-flow.js`: make authoritative recovery rediscover the Web generation.
- `extension/tests/collector-auth-flow.test.js`: prove cached generations are discarded during recovery.
- `extension/tests/sync-capability-removed.test.js`: exercise internal logout and recovery through the real flow/session manager boundary.
- `app/public/sonli-extension-0.13.46.2`, `app/public/sonli-extension-0.13.46.2.zip`, and `app/dist/sonli-extension-0.13.46.2.zip`: generated package mirrors, updated only after source verification.
- `docs/superpowers/verification/2026-08-02-login-generation-boundary.md`: truthful final evidence, including environmental gaps.

---

### Task 1: Retry a failed Web generation in the production lifecycle

**Files:**
- Modify: `app/src/collector-auth-bridge.js`
- Modify: `app/src/App.jsx:700-725`
- Modify: `app/tests/collector-auth-bridge.test.mjs`

**Interfaces:**
- Produces: `startCollectorAuthBridgeLifecycle({ accountId, controller, installBridge, postLogout, setTimer, clearTimer, retryDelayMs }) => cleanup`.
- Preserves: `createCollectorAuthGenerationController().update(accountId)` and all existing exact message contracts.

- [ ] **Step 1: Write the failing live-lifecycle test**

Create a deterministic controller whose A generation succeeds, whose first B factory call throws, and whose second B call returns `generation_B_5678`. Call the lifecycle runner for A, clean it up, then call it for B with fake timer adapters. Assert synchronously that G1 logout is posted, no B bridge is installed, and exactly one retry is scheduled. Run that timer and assert B is installed with `announceReady: true`. Also assert cleanup before a scheduled retry cancels it and cannot install a bridge later.

The production change that makes this test pass must be the exported lifecycle runner used by `App.jsx`; do not test a test-only wrapper.

- [ ] **Step 2: Run the Web test and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collector-auth-bridge.test.mjs
```

Expected: FAIL because `startCollectorAuthBridgeLifecycle` does not exist and `App.jsx` has no production retry path.

- [ ] **Step 3: Implement the minimal bounded lifecycle runner**

The runner must:

1. Normalize `accountId` once for the lifetime of the React effect.
2. Call `controller.update(accountId)` immediately.
3. Post a returned `logoutGenerationId` before any retry or bridge install.
4. Install the bridge and retain its cleanup when a valid `generationId` is returned.
5. If the account is non-empty and the initial call returns no generation, schedule exactly one retry using the injected timer and `retryDelayMs` (default `250`).
6. Never schedule a second retry; this is bounded recovery, not polling.
7. Return an idempotent cleanup that cancels the pending timer and removes the installed bridge.

Reject missing controller/install/post adapters with `TypeError`. A timer callback that runs after cleanup must be inert.

- [ ] **Step 4: Wire the real React effect to the runner**

Replace the effect's inline `update`/logout/install block with:

```js
return startCollectorAuthBridgeLifecycle({
  accountId: authChecked ? collectorAuthAccountId : "",
  controller: collectorAuthGenerationRef.current,
  postLogout: (generationId) => postCollectorAuthLogout({ generationId }),
  installBridge: (transition) => installCollectorAuthBridge({
    generationId: transition.generationId,
    isLoggedIn: () => true,
    requestTicket: () => apiRequest("/extension/collector-auth/ticket", { method: "POST" }),
    announceReady: transition.announceReady,
  }),
});
```

Keep effect dependencies exactly `[authChecked, collectorAuthAccountId]` and import the new helper from `collector-auth-bridge.js`.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collector-auth-bridge.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check app/src/collector-auth-bridge.js
```

Expected: all tests PASS and the source check exits 0.

Commit:

```bash
git add app/src/collector-auth-bridge.js app/src/App.jsx app/tests/collector-auth-bridge.test.mjs
git commit -m "fix(auth): retry Web generation recovery"
```

---

### Task 2: Rediscover the current Web generation during authoritative recovery

**Files:**
- Modify: `extension/lib/collector-auth-flow.js`
- Modify: `extension/tests/collector-auth-flow.test.js`
- Modify: `extension/tests/sync-capability-removed.test.js`
- Modify only if the integration test proves necessary: `extension/content/sync-auth.js`

**Interfaces:**
- Preserves: `requestAuthoritatively() => { requested: boolean }`.
- Changes behavior: when no begin/exchange transition is in flight, authoritative recovery clears cached content-flow generation state and sends a discovery request with an empty bound generation.
- Preserves: discovery response calls `beginGeneration(message.generationId)` before `exchangeTicket(...)`.

- [ ] **Step 1: Write failing unit recovery tests**

Replace the existing expectation that authoritative recheck restarts cached G1. After a completed G1 exchange, call `requestAuthoritatively()` and assert a discovery request is sent. Respond to it with G2 and assert the exact sequence:

```js
assert.deepEqual(harness.begins, [G1, G2]);
assert.deepEqual(harness.requests, ["request-1", "request-2"]);
assert.equal(harness.exchanges[1].generationId, G2);
```

Also cover a stale cached G1 that receives current Web G2: the recovery path must never call `beginGeneration(G1)` a second time and must not exchange G1.

- [ ] **Step 2: Write the failing real-manager integration regression**

Using the existing VM/service-worker and in-memory Chrome session harness in `extension/tests/sync-capability-removed.test.js`, exercise:

1. Ready/begin/exchange G1 to an authenticated Collector session.
2. Internal `logout`, proving both session and generation storage are empty.
3. Content flow `requestAuthoritatively()`, proving the next request is discovery rather than cached-G1 exchange.
4. A Web G1 response, proving `collector.auth.begin` is called again before exchange and the session becomes authenticated.

Add a second assertion or test where the Web response is G2 after cached G1; only G2 may be activated and exchanged. Use the real `createCollectorAuthFlow` plus the real Collector session manager/routing path rather than duplicating either implementation in the test.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/collector-auth-flow.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/sync-capability-removed.test.js
```

Expected: the new recovery assertions FAIL because the current flow retains and requests its cached generation without a new begin.

- [ ] **Step 4: Implement authoritative rediscovery**

In `requestAuthoritatively()`, retain the existing guards for `exchangeInFlight` and a pending begin. Otherwise cancel the retry timer and clear `desiredGenerationId`, `lastHandledGenerationId`, `pendingGenerationId`, `activeRequest`, attempts, request count, and authenticated state, then call `startDiscovery()`.

Do not call `beginGeneration()` with the old cached generation. Do not change the 10-request, 2-exchange, or 1-second retry limits. Do not restore a generation during internal logout; recovery must come from the Web bridge response.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/collector-auth-flow.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/sync-capability-removed.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/sync-auth-runtime.test.js
```

Expected: all focused tests PASS; authoritative runtime expectations describe discovery/current-Web adoption, not cached-generation restart.

Commit:

```bash
git add extension/lib/collector-auth-flow.js extension/content/sync-auth.js extension/tests/collector-auth-flow.test.js extension/tests/sync-capability-removed.test.js extension/tests/sync-auth-runtime.test.js
git commit -m "fix(auth): rediscover generation on recheck"
```

---

### Task 3: Repackage and record truthful verification

**Files:**
- Modify generated mirror: `app/public/sonli-extension-0.13.46.2/**`
- Modify generated artifact: `app/public/sonli-extension-0.13.46.2.zip`
- Modify generated artifact: `app/dist/sonli-extension-0.13.46.2.zip`
- Modify: `docs/superpowers/verification/2026-08-02-login-generation-boundary.md`

**Interfaces:**
- Preserves byte parity between `extension/**` and the unpacked public mirror.
- Preserves byte identity between public and dist ZIP packages.

- [ ] **Step 1: Run all source-focused authentication tests before packaging**

Run the Web bridge, content flow, session manager, runtime adapter, portal/web policy, service worker capability, popup routing, and capture-only policy suites named in the existing verification document. Expected: 0 failures.

- [ ] **Step 2: Build and package from source**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/package-extension.mjs
pnpm --dir app build
```

Do not hand-edit generated files.

- [ ] **Step 3: Verify generated artifact parity and gates**

Run:

```bash
diff -qr extension app/public/sonli-extension-0.13.46.2
shasum -a 256 app/public/sonli-extension-0.13.46.2.zip app/dist/sonli-extension-0.13.46.2.zip
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-zip.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-zip-smoke.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-plugin-readiness-gate.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-personal-data.mjs
git diff --check
```

Expected: parity and gates PASS, ZIP hashes are identical, and diff check exits 0.

- [ ] **Step 4: Update verification evidence without overstating coverage**

Record both recovery regressions and their test evidence. Retain the current complete `scripts/verify.mjs` environmental failures and retain real Chrome login/reload verification as `NOT RUN` until it is actually performed.

- [ ] **Step 5: Commit packaging and evidence**

```bash
git add app/public/sonli-extension-0.13.46.2 app/public/sonli-extension-0.13.46.2.zip app/dist/sonli-extension-0.13.46.2.zip docs/superpowers/verification/2026-08-02-login-generation-boundary.md
git commit -m "chore(extension): package login recovery fix"
```


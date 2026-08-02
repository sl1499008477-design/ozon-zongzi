# Login Generation Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated Web login, logout, account switching, and late ticket exchanges safe and immediately recognizable without adding permanent polling.

**Architecture:** The Web page owns a random in-memory login generation and publishes only strict credential-free lifecycle envelopes. The extension content layer deduplicates and sequences those generations, while the Collector session manager stores a session-scoped generation fence and rejects every stale exchange or logout before it can cross an account boundary.

**Tech Stack:** React 19, Chrome Manifest V3 service worker/content scripts, `chrome.storage.session`, Node.js built-in tests, CommonJS-compatible extension libraries, Vite.

## Global Constraints

- `generationId` is an opaque Web Crypto value of 16–128 ASCII letters, digits, underscores, or hyphens; it must not be derived from account, store, username, password, token, ticket, or timestamp data.
- Ready and logout page messages contain exactly `protocol`, `action`, and `generationId`; response contains only the existing one-time ticket fields plus `generationId` and never exposes Web or Collector tokens.
- Same-window, same-origin, trusted-sender, exact-field, request-ID, portal-route, backend permission, and account-boundary checks remain mandatory.
- A new generation clears the old Collector session before a new exchange; a late old exchange returns `COLLECTOR_AUTH_GENERATION_CHANGED` and cannot write storage.
- The existing 15-second Web local-state refresh, maximum 10 page requests, maximum 2 ticket exchange attempts, 1-second short retry, and explicit “重新检查” recovery remain; no permanent authentication interval is added.
- No database, password rule, account permission, store configuration, Seller login, Ozon collection API, product schema, or collection data change is allowed.
- Every production change follows RED → GREEN, every task receives specification and code-quality review, and generated extension artifacts change only in the packaging task.

## File Responsibility Map

- `app/src/collector-auth-bridge.js`: create and validate Web login generations; publish/normalize strict Web bridge lifecycle contracts.
- `app/src/App.jsx`: translate stable account transitions into ready/logout lifecycle calls without coupling them to the 15-second state object refresh.
- `extension/lib/collector-session.js`: serialize generation activation, session clearing, and guarded ticket exchange.
- `extension/lib/portal-bridge-policy.js`: admit only exact trusted begin/exchange/logout runtime messages.
- `extension/background/service-worker.js`: route admitted generation operations to the session manager.
- `extension/lib/web-bridge-policy.js`: validate exact ready/logout/response page envelopes.
- `extension/lib/collector-auth-flow.js`: own the bounded content-side generation/request/exchange state machine.
- `extension/content/sync-auth.js`: remain a thin window/Chrome adapter around the policy and flow.
- Tests beside each boundary execute the real module; generated files under `app/public` and `app/dist` are updated only after source tests pass.

---

### Task 1: Give the Web bridge a stable random login generation

**Files:**
- Modify: `app/src/collector-auth-bridge.js`
- Modify: `app/src/App.jsx:620-725`
- Modify: `app/tests/collector-auth-bridge.test.mjs`

**Interfaces:**
- Produces: `isCollectorAuthGenerationId(value) => boolean`.
- Produces: `createCollectorAuthGenerationController({ createGenerationId })` with `update(accountId) => { generationId, logoutGenerationId, announceReady }`.
- Produces: `postCollectorAuthLogout({ generationId, postResponse, windowObject }) => boolean`.
- Changes: `installCollectorAuthBridge({ generationId, announceReady, ... })`; every accepted request response includes the captured `generationId`.

- [ ] **Step 1: Write failing controller and lifecycle contract tests**

Import the three new exports and replace ready expectations with the exact literal contract. Use deterministic generations so tests do not depend on randomness:

```js
const generations = ["generation_A_1234", "generation_B_5678", "generation_C_9012"];
const controller = createCollectorAuthGenerationController({
  createGenerationId: () => generations.shift(),
});

assert.deepEqual(controller.update("account-a"), {
  generationId: "generation_A_1234",
  logoutGenerationId: "",
  announceReady: true,
});
assert.deepEqual(controller.update("account-a"), {
  generationId: "generation_A_1234",
  logoutGenerationId: "",
  announceReady: false,
});
assert.deepEqual(controller.update("account-b"), {
  generationId: "generation_B_5678",
  logoutGenerationId: "generation_A_1234",
  announceReady: true,
});
assert.deepEqual(controller.update(""), {
  generationId: "",
  logoutGenerationId: "generation_B_5678",
  announceReady: false,
});
assert.equal(controller.update("account-a").generationId, "generation_C_9012");
```

Assert ready/logout exact shapes and that a response contains the generation captured by its installed bridge, even if a later bridge has already been installed:

```js
assert.deepEqual(readyPost.payload, {
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.ready",
  generationId: "generation_A_1234",
});
assert.deepEqual(logoutPost.payload, {
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.logout",
  generationId: "generation_A_1234",
});
assert.equal(ticketResponse.generationId, "generation_A_1234");
assert.equal(JSON.stringify(posts).includes("account-a"), false);
```

Add invalid generator cases for empty, 15-character, 129-character, whitespace, and slash-containing values. The controller must return no active generation and retry creation on its next logged-in update rather than publish an unsafe ID. Separately assert that the production factory calls Web Crypto and never receives an account ID argument.

- [ ] **Step 2: Run the Web bridge test and verify RED**

Run:

```bash
node --test app/tests/collector-auth-bridge.test.mjs
```

Expected: FAIL because ready has no generation, logout publication and the generation controller do not exist, and responses do not carry a generation.

- [ ] **Step 3: Implement the generation controller and strict lifecycle emitters**

Use the following validation and return contract; inject the factory for tests and use Web Crypto in production:

```js
const GENERATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const isCollectorAuthGenerationId = (value) =>
  GENERATION_ID_PATTERN.test(String(value || ""));

const defaultGenerationId = () => globalThis.crypto.randomUUID();

export function createCollectorAuthGenerationController({
  createGenerationId = defaultGenerationId,
} = {}) {
  let accountId = "";
  let generationId = "";
  let announced = false;
  return Object.freeze({
    update(value) {
      const nextAccountId = String(value || "").trim();
      if (!nextAccountId) {
        const logoutGenerationId = generationId;
        accountId = "";
        generationId = "";
        announced = false;
        return { generationId: "", logoutGenerationId, announceReady: false };
      }
      let logoutGenerationId = "";
      if (nextAccountId !== accountId) {
        logoutGenerationId = generationId;
        const candidate = String(createGenerationId() || "");
        accountId = "";
        generationId = "";
        announced = false;
        if (!isCollectorAuthGenerationId(candidate)) {
          return { generationId: "", logoutGenerationId, announceReady: false };
        }
        accountId = nextAccountId;
        generationId = candidate;
      }
      const announceReady = !announced;
      announced = true;
      return { generationId, logoutGenerationId, announceReady };
    },
  });
}
```

Add `logout` to `COLLECTOR_AUTH_ACTIONS`. Require a valid generation in bridge installation; post ready with exactly three fields, response with exactly six fields, and logout through the same origin-scoped send adapter. Make `normalizeCollectorAuthRequest` require the exact keys `action,protocol,requestId` instead of stripping unexpected keys. Do not add account ID to any outbound object.

- [ ] **Step 4: Wire account transitions in `App.jsx`**

Replace `createCollectorAuthReadyGate` with one controller held in `useRef`. In the existing effect, call `update(authChecked ? collectorAuthAccountId : "")` exactly once per stable account-ID transition. Publish `logoutGenerationId` first when present, then install the bridge only when `generationId` is valid:

```js
const transition = collectorAuthGenerationRef.current.update(
  authChecked ? collectorAuthAccountId : "",
);
if (transition.logoutGenerationId) {
  postCollectorAuthLogout({ generationId: transition.logoutGenerationId });
}
if (!transition.generationId) return undefined;
return installCollectorAuthBridge({
  generationId: transition.generationId,
  isLoggedIn: () => true,
  requestTicket: () => apiRequest("/extension/collector-auth/ticket", { method: "POST" }),
  announceReady: transition.announceReady,
});
```

Keep effect dependencies exactly `[authChecked, collectorAuthAccountId]`; do not depend on the whole account object or local-state refresh result.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test app/tests/collector-auth-bridge.test.mjs
node --check app/src/collector-auth-bridge.js
```

Expected: all Web bridge tests PASS; messages contain no account/store/Web token/Collector token; `App.jsx` still keys the effect by stable account ID.

- [ ] **Step 6: Commit Task 1**

```bash
git add app/src/collector-auth-bridge.js app/src/App.jsx app/tests/collector-auth-bridge.test.mjs
git commit -m "fix(auth): identify Web login generations"
```

---

### Task 2: Fence Collector sessions by active login generation

**Files:**
- Modify: `extension/lib/collector-session.js`
- Modify: `extension/tests/collector-session.test.js`

**Interfaces:**
- Produces constant: `COLLECTOR_AUTH_GENERATION_STORAGE_KEY === "sonliCollectorAuthGeneration"`.
- Produces: `activateCollectorGeneration(generationId) => Promise<{ changed: boolean }>`.
- Produces: `clearCollectorGeneration(generationId) => Promise<boolean>`.
- Changes: `exchangeCollectorTicket({ ticket, deviceFingerprint, extensionVersion, generationId })` requires an already-active matching generation.
- Preserves: direct `setCollectorSession()` remains available to existing isolated session tests; production ticket exchange always uses the guarded path.

- [ ] **Step 1: Write failing generation-fence tests**

Add tests using the real in-memory Chrome harness:

```js
await manager.setCollectorSession(validSession());
assert.deepEqual(await manager.activateCollectorGeneration("generation_A_1234"), {
  changed: true,
});
assert.equal(await manager.getCollectorSession(), null);
assert.equal(sessionState[COLLECTOR_AUTH_GENERATION_STORAGE_KEY], "generation_A_1234");
assert.deepEqual(await manager.activateCollectorGeneration("generation_A_1234"), {
  changed: false,
});
```

Cover matching and stale logout:

```js
await manager.activateCollectorGeneration("generation_B_5678");
await manager.setCollectorSession(validSession({ account: { id: "account-b" } }));
assert.equal(await manager.clearCollectorGeneration("generation_A_1234"), false);
assert.equal((await manager.getCollectorSession()).account.id, "account-b");
assert.equal(await manager.clearCollectorGeneration("generation_B_5678"), true);
assert.equal(await manager.getCollectorSession(), null);
```

For the load-bearing race, hold the G1 exchange response, activate G2, then resolve G1. Assert rejection code and no stored G1 session:

```js
await manager.activateCollectorGeneration("generation_G1_1234");
const staleExchange = manager.exchangeCollectorTicket({
  ticket: "ctt_generation_g1_secret_123456789",
  generationId: "generation_G1_1234",
});
await manager.activateCollectorGeneration("generation_G2_5678");
exchangeResponse.resolve(jsonResponse(200, { data: validSession() }));
await assert.rejects(staleExchange, (error) =>
  error?.code === "COLLECTOR_AUTH_GENERATION_CHANGED");
assert.equal(await manager.getCollectorSession(), null);
```

Also prove a G2 exchange succeeds and a late `clearCollectorGeneration(G1)` cannot remove it. Update existing direct exchange/retry tests to activate and pass one deterministic generation.

- [ ] **Step 2: Run Collector session tests and verify RED**

Run:

```bash
node --test extension/tests/collector-session.test.js
```

Expected: FAIL because generation storage and APIs do not exist and exchange is not fenced.

- [ ] **Step 3: Implement serialized activate and clear operations**

Validate with the same `/^[A-Za-z0-9_-]{16,128}$/` contract. Use the existing `sessionMutationTail`; never start a second independent mutation queue. New generation activation must remove the old session before storing the new generation so an interrupted write fails closed:

```js
async function activateCollectorGeneration(value) {
  const generationId = requireCollectorGenerationId(value);
  return serializeSessionMutation(async () => {
    const stored = await chromeApi.storage.session.get(COLLECTOR_AUTH_GENERATION_STORAGE_KEY);
    if (stored?.[COLLECTOR_AUTH_GENERATION_STORAGE_KEY] === generationId) {
      return { changed: false };
    }
    await chromeApi.storage.session.remove(COLLECTOR_SESSION_STORAGE_KEY);
    await chromeApi.storage.session.set({
      [COLLECTOR_AUTH_GENERATION_STORAGE_KEY]: generationId,
    });
    return { changed: true };
  });
}
```

`clearCollectorGeneration` must read, compare, then remove the Collector session followed by the generation key inside the same serialized mutation. A mismatch returns `false` without writes.

- [ ] **Step 4: Guard ticket exchange at the final write boundary**

Split the current `setCollectorSession` body into one non-serializing private storage write and its public serialized wrapper. After the exchange network response succeeds, enter `serializeSessionMutation`, reread `COLLECTOR_AUTH_GENERATION_STORAGE_KEY`, and only write when it equals the request generation:

```js
if (storedGeneration !== generationId) {
  throw collectorError(
    "COLLECTOR_AUTH_GENERATION_CHANGED",
    409,
    "COLLECTOR_AUTH_GENERATION_CHANGED",
    [secret],
  );
}
return writeCollectorSession(body?.data || body);
```

Pass `generationId` through `exchangeCollectorTicketWithRetry` for type consistency even though production currently calls direct exchange. Export the new constant and manager methods.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test extension/tests/collector-session.test.js
node --check extension/lib/collector-session.js
```

Expected: all current session, pending-upload, operation-snapshot, 401/403 race, new-generation, stale-exchange, and stale-logout tests PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add extension/lib/collector-session.js extension/tests/collector-session.test.js
git commit -m "fix(auth): fence collector sessions by generation"
```

---

### Task 3: Route only exact generation lifecycle messages in the service worker

**Files:**
- Modify: `extension/lib/portal-bridge-policy.js`
- Modify: `extension/background/service-worker.js:4090-4135`
- Modify: `extension/tests/portal-bridge-policy.test.js`
- Modify: `extension/tests/sync-capability-removed.test.js`

**Interfaces:**
- Consumes manager methods from Task 2.
- Produces exact normalized portal messages for `collector.auth.begin`, `collector.auth.exchange`, and `collector.auth.logout`.
- Produces stable runtime responses: begin `{ ok: true, data: { changed } }`, logout `{ ok: true, data: { cleared } }`, guarded exchange existing success payload or sanitized stable error.

- [ ] **Step 1: Write failing exact portal-policy tests**

Assert these accepted values:

```js
assert.deepEqual(normalizePortalBridgeMessage({
  protocol: "SONLI_COLLECTOR_AUTH",
  senderUrl,
  message: { action: "collector.auth.begin", generationId: "generation_A_1234" },
}), {
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.begin",
  generationId: "generation_A_1234",
});
```

Repeat for exact logout and exchange, with exchange including `requestId`, `generationId`, `ticket`, and `expiresAt`. Add rejection cases for an extra `token`, `storeId`, account ID, missing generation, 15/129-character generation, illegal slash, wrong origin, and unknown Collector action. Change `routePortalRuntimeMessage` to test that the routing-only `portalProtocol` discriminator is removed before exact payload validation.

- [ ] **Step 2: Write failing service-worker behavior tests**

In the real service-worker harness, send exact trusted begin then exchange:

```js
const begun = await sendRuntimeMessage(harness, {
  portalProtocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.begin",
  generationId: "generation_A_1234",
}, trustedWebSender);
assert.equal(begun.ok, true);

const exchanged = await sendRuntimeMessage(harness, {
  portalProtocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.exchange",
  requestId: "exchange-generation-a",
  generationId: "generation_A_1234",
  ticket: "ctt_exchange_generation_secret_123456789",
  expiresAt: "2099-01-01T00:00:00.000Z",
}, trustedWebSender);
assert.equal(exchanged.ok, true);
```

Add G2 begin followed by stale G1 exchange and assert `{ ok: false, code: "COLLECTOR_AUTH_GENERATION_CHANGED" }`. Add stale G1 logout after successful G2 and assert G2 remains authenticated through `getAuth`.

- [ ] **Step 3: Run policy and worker tests and verify RED**

Run:

```bash
node extension/tests/portal-bridge-policy.test.js
node --test extension/tests/sync-capability-removed.test.js
```

Expected: FAIL because only exchange is admitted and service-worker begin/logout cases do not exist.

- [ ] **Step 4: Implement strict portal normalization**

Before normalization, destructure `portalProtocol` away from the payload. For Collector protocol, compare sorted keys against one exact list per action and return only listed fields:

```js
const collectorKeys = Object.freeze({
  "collector.auth.begin": ["action", "generationId"],
  "collector.auth.logout": ["action", "generationId"],
  "collector.auth.exchange": ["action", "expiresAt", "generationId", "requestId", "ticket"],
});
```

Reject rather than strip unexpected fields. Keep `JZ_ERP` follow-sell behavior and all trusted-host rules unchanged.

- [ ] **Step 5: Add service-worker lifecycle routes**

Within the existing `SONLI_COLLECTOR_AUTH` portal route:

```js
case "collector.auth.begin": {
  const result = await collectorSessionManager.activateCollectorGeneration(message.generationId);
  return { ok: true, data: result };
}
case "collector.auth.logout": {
  const cleared = await collectorSessionManager.clearCollectorGeneration(message.generationId);
  return { ok: true, data: { cleared } };
}
```

Pass `message.generationId` to exchange. Preserve ticket redaction and only call `kickCollectorOzonEnrichment()` after a guarded exchange succeeds.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node extension/tests/portal-bridge-policy.test.js
node --test extension/tests/sync-capability-removed.test.js extension/tests/collector-session.test.js
node --check extension/background/service-worker.js
```

Expected: strict trusted routing, G1→G2 fencing, old logout protection, capture-only policy, and existing Collector behavior all PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add extension/lib/portal-bridge-policy.js extension/background/service-worker.js extension/tests/portal-bridge-policy.test.js extension/tests/sync-capability-removed.test.js
git commit -m "fix(auth): route generation lifecycle safely"
```

---

### Task 4: Replace the page-lifetime boolean with a bounded generation flow

**Files:**
- Create: `extension/lib/collector-auth-flow.js`
- Create: `extension/tests/collector-auth-flow.test.js`
- Modify: `extension/lib/web-bridge-policy.js`
- Modify: `extension/content/sync-auth.js`
- Modify: `extension/manifest.json:240-250`
- Modify: `extension/tests/web-bridge-policy.test.js`
- Modify: `extension/tests/sync-auth-runtime.test.js`
- Modify: `scripts/package-extension.mjs`

**Interfaces:**
- Produces: `JzCollectorAuthFlow.createCollectorAuthFlow(dependencies)`.
- Flow methods: `startDiscovery()`, `handleReady(message)`, `handleLogout(message)`, `handleResponse(message)`, `requestAuthoritatively()`.
- Flow dependencies: `newRequestId`, `postRequest`, `beginGeneration`, `clearGeneration`, `exchangeTicket`, `setTimer`, `clearTimer`.
- Policy produces: `normalizeCollectorAuthReady`, `normalizeCollectorAuthLogout`, and generation-bound `normalizeCollectorAuthResponse`.

- [ ] **Step 1: Write failing exact Web-policy tests**

Replace the two-field ready fixture and permissive response fixture with exact contracts:

```js
assert.deepEqual(normalizeCollectorAuthReady({
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.ready",
  generationId: "generation_A_1234",
}), {
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.ready",
  generationId: "generation_A_1234",
});

assert.deepEqual(normalizeCollectorAuthLogout({
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.logout",
  generationId: "generation_A_1234",
}), {
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.logout",
  generationId: "generation_A_1234",
});
```

Response must have exactly `action,expiresAt,generationId,protocol,requestId,ticket`. Extra token/store/account fields now return `null` instead of being stripped. Keep exact request-ID matching.

- [ ] **Step 2: Write failing pure flow tests**

Use deferred promises for begin/exchange and arrays for requests, begins, clears, and exchanges. Cover each observable rule:

```js
await flow.handleReady({ generationId: "generation_A_1234" });
await flow.handleReady({ generationId: "generation_A_1234" });
assert.deepEqual(begins, ["generation_A_1234"]);
assert.equal(requests.length, 1);
```

Then cover:

- initial discovery response establishes G1 only when no ready arrived since that request;
- a discovery G1 response is rejected after ready G2;
- request IDs started under G1 reject a response labeled G2 and vice versa;
- G2 ready while G1 exchange is pending calls begin(G2), does not start a second exchange, and processes only the latest pending generation after G1 settles;
- G1 success after G2 became desired does not mark the flow authenticated;
- matching logout cancels retries, clears G1, and allows a later same-account G2;
- stale logout G1 after G2 does not reset G2 locally;
- authoritative recheck restarts the current generation after successful authentication or starts discovery when no generation is known;
- 10 request / 2 exchange / 1,000 ms bounds remain exact.

- [ ] **Step 3: Run policy and flow tests and verify RED**

Run:

```bash
node extension/tests/web-bridge-policy.test.js
node --test extension/tests/collector-auth-flow.test.js
```

Expected: policy FAILS on missing generation behavior and the flow module does not exist.

- [ ] **Step 4: Implement the focused flow coordinator**

Follow the repository UMD pattern and keep all mutable authentication-cycle state private. The coordinator must maintain these exact state fields:

```js
let desiredGenerationId = "";
let activeRequest = null; // { requestId, generationId, discovery }
let lastHandledGenerationId = "";
let pendingGenerationId = "";
let attempts = 0;
let requestCount = 0;
let exchangeInFlight = false;
let authenticated = false;
let retryTimer = null;
let transitionTail = Promise.resolve();
```

Serialize generation begin/logout effects through `transitionTail`. Set `desiredGenerationId` and cancel old retries immediately on a new ready, then call `beginGeneration`. After begin resolves, request a ticket only if that generation is still desired. Bind every request ID to its generation; discovery uses an empty generation and may adopt the response generation only when `desiredGenerationId` is still empty. Never start a second exchange while `exchangeInFlight`; store only the newest `pendingGenerationId` and process it after settlement.

Return small result objects such as `{ accepted: true }`, `{ accepted: false, reason: "stale-generation" }`, and `{ requested: boolean }` so the runtime adapter and tests do not inspect internal variables.

- [ ] **Step 5: Make `sync-auth.js` a thin adapter**

Remove `passiveReadyConsumed` and local counter/state-machine logic. Instantiate the flow with adapters:

```js
const flow = globalThis.JzCollectorAuthFlow.createCollectorAuthFlow({
  newRequestId,
  postRequest: (requestId) => window.postMessage(
    policy.createCollectorAuthRequest(requestId),
    window.location.origin,
  ),
  beginGeneration: (generationId) => sendRuntime("collector.auth.begin", { generationId }),
  clearGeneration: (generationId) => sendRuntime("collector.auth.logout", { generationId }),
  exchangeTicket: ({ requestId, generationId, ticket, expiresAt }) =>
    sendRuntime("collector.auth.exchange", {
      requestId,
      generationId,
      ticket,
      expiresAt,
    }),
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer: (timer) => clearTimeout(timer),
});
```

`sendRuntime` always adds `portalProtocol: policy.COLLECTOR_AUTH_PROTOCOL`. The window listener performs same-window/origin checks, normalizes ready then logout then response, and passes only normalized objects to the flow. The runtime `collector.auth.request` listener returns `{ ok: true, requested }` from `requestAuthoritatively()`. Call `startDiscovery()` once after installing both listeners.

- [ ] **Step 6: Wire loading and packaging inventories**

Add `lib/collector-auth-flow.js` immediately before `content/sync-auth.js` in the trusted Web content-script list. Add the new library and test to `collectorRuntimeFiles` in `scripts/package-extension.mjs`; do not edit generated public files yet.

- [ ] **Step 7: Extend the real VM runtime test and verify GREEN**

Update the VM harness to load `collector-auth-flow.js` before `sync-auth.js` and to resolve begin/logout/exchange messages independently. Exercise literal G1 duplicate, G1 exchange in flight, G2 ready, stale G1 result, G2 success, stale G1 logout, matching G2 logout, G3 relogin, reinjection guard, malformed page messages, and authoritative recovery.

Run:

```bash
node extension/tests/web-bridge-policy.test.js
node --test extension/tests/collector-auth-flow.test.js
node extension/tests/sync-auth-runtime.test.js
node --test extension/tests/portal-bridge-policy.test.js extension/tests/collector-session.test.js extension/tests/sync-capability-removed.test.js
```

Expected: all flow, policy, runtime, session, and worker tests PASS; no concurrent exchange is observed; the new login generation is accepted without page refresh.

- [ ] **Step 8: Commit Task 4**

```bash
git add extension/lib/collector-auth-flow.js extension/tests/collector-auth-flow.test.js extension/lib/web-bridge-policy.js extension/content/sync-auth.js extension/manifest.json extension/tests/web-bridge-policy.test.js extension/tests/sync-auth-runtime.test.js scripts/package-extension.mjs
git commit -m "fix(auth): hand off repeated login generations"
```

---

### Task 5: Full regression, packaging, real-browser evidence, and independent review

**Files:**
- Regenerate: `app/public/sonli-extension-0.13.46.2/**`
- Regenerate: `app/public/sonli-extension-0.13.46.2.zip`
- Regenerate: `app/dist/sonli-extension-0.13.46.2.zip`
- Create: `docs/superpowers/verification/2026-08-02-login-generation-boundary.md`

**Interfaces:**
- Consumes all source contracts from Tasks 1–4.
- Produces source/public parity and byte-equivalent public/dist ZIPs for extension version `0.13.46.2`.
- Produces an evidence report separating automated PASS, configured SKIP, and real-Chrome results.

- [ ] **Step 1: Run the focused cross-layer regression suite**

```bash
node --test app/tests/collector-auth-bridge.test.mjs
node --test extension/tests/collector-auth-flow.test.js extension/tests/collector-session.test.js extension/tests/sync-capability-removed.test.js
node extension/tests/web-bridge-policy.test.js
node extension/tests/portal-bridge-policy.test.js
node extension/tests/sync-auth-runtime.test.js
node extension/popup/__tests__/popup-routing.smoke.test.js
node --test scripts/extension-capture-only-policy.test.mjs
```

Expected: all commands exit 0 with no unexpected skip. A configured database integration skip is not part of this focused suite.

- [ ] **Step 2: Build Web and package the extension**

Run the Web build from `app/`:

```bash
node node_modules/vite/bin/vite.js build
```

Then run the package command from the worktree root:

```bash
node scripts/package-extension.mjs
```

Expected: Vite exits 0; only the pre-existing bundle-size warning is allowed. Packaging regenerates the unpacked public tree and both `0.13.46.2` ZIPs.

- [ ] **Step 3: Run the complete repository verification**

```bash
node scripts/verify.mjs
diff -qr extension app/public/sonli-extension-0.13.46.2
shasum -a 256 app/public/sonli-extension-0.13.46.2.zip app/dist/sonli-extension-0.13.46.2.zip
git diff --check
```

Expected: all configured verification checks PASS; source/public has no diff; the two ZIP SHA-256 values are identical; PostgreSQL or external integrations skipped by configuration are reported as unverified, never as passed.

- [ ] **Step 4: Perform real Chrome acceptance after one extension reload**

Reload the unpacked extension from `app/public/sonli-extension-0.13.46.2`, then verify without changing Seller state:

1. Web logged out → click “前往登录” → take longer than the old 10-second window → login succeeds and the extension recognizes it without Web/Seller refresh.
2. Same Web page logout → log back into the same account → extension recognizes the new generation.
3. Account A → account B → old A Collector state is unavailable before B exchange, and B becomes active after exchange.
4. Click “重新检查” repeatedly while one exchange is pending → only one exchange runs and the UI eventually reflects the actual outcome.
5. Keep the Web page open past at least one 15-second local-state refresh → no repeated authentication or repeated tab opening occurs.

Record each item as PASS/FAIL/NOT RUN with the observed account display only in local notes; do not write account identifiers, tokens, tickets, passwords, or generation IDs into the report.

- [ ] **Step 5: Request independent specification and code-quality review**

Review commits after design/plan base `c07f230` against `docs/superpowers/specs/2026-08-02-login-generation-boundary-design.md`. The reviewer must explicitly inspect generation creation, exact contracts, G1/G2 races, stale logout, discovery response ordering, content-script reinjection, source/public parity, secrets, and AGENTS.md delivery requirements. Fix every Critical or Important finding with a new RED → GREEN cycle and rerun all affected focused tests.

- [ ] **Step 6: Write verification evidence and commit packaged artifacts**

The report must list: changed files/contracts, exact commands and counts, real-Chrome outcomes, skipped/unverified environments, unchanged old functions, regression risks, and rollback range. Then commit:

```bash
git add app/public/sonli-extension-0.13.46.2 app/public/sonli-extension-0.13.46.2.zip app/dist/sonli-extension-0.13.46.2.zip docs/superpowers/verification/2026-08-02-login-generation-boundary.md
git commit -m "chore(extension): package login generation boundary"
```

- [ ] **Step 7: Final clean-tree verification and rollback record**

Run `git status --short`, `git log --oneline c07f230..HEAD`, and the focused auth suite once more. Expected: clean working tree and all tests PASS. Rollback is the exact Task 1–5 commit range after `c07f230`; reverting that range restores the previous build without database migration, while also restoring the known same-page relogin defect.

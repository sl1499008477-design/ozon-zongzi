# Fast Observable Extension Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an already-valid same-account Collector session reconnect in under 0.5 seconds, make a healthy first authentication complete in roughly 1–3 seconds, and show truthful live progress instead of a static “未登录” screen.

**Architecture:** Keep the existing one-time ticket trust boundary, but make the Web bridge acknowledge one accepted request immediately and deduplicate ticket issuance. The extension owns one authentication operation per Web generation, preserves a still-valid same-account session, and projects a credential-free status snapshot through `chrome.storage.session`. PostgreSQL authentication writes focused relational audit rows and atomically supersedes older sessions for the same account/device; JSON mode keeps its existing serialized fallback.

**Tech Stack:** React/Vite Web app, Chrome Manifest V3 extension, plain JavaScript modules, Node test runner, PostgreSQL/JSON repositories.

## Global Constraints

- Work on the current branch and current working tree; the user explicitly declined a separate worktree.
- Use test-driven development for every task: add the named failing assertion, capture RED, implement the smallest change, then capture GREEN.
- Do not expose the Web bearer credential, Collector ticket, Collector token, device fingerprint, or raw server error through page messages, popup state, audit metadata, or logs.
- `accountId` in `collector.auth.ready.v2` is a same-account reuse hint only. It may preserve an already-valid session with the same account ID, but it cannot mint credentials or change permissions; ticket exchange remains the authority for a new session.
- Preserve the exact legacy `collector.auth.ready` envelope for old extensions. A new extension consumes `collector.auth.ready.v2` and ignores the same-generation legacy duplicate.
- Keep all privileged checks in the service worker/server. Popup visibility and page-message validation are not authorization controls.
- No database migration, production data write, real login, or paid external request is authorized by this plan.
- Version target is extension `0.13.46.4`; regenerate both the unpacked directory and ZIP only after tests are green.
- Each task gets its own commit. Do not push or merge unless the user separately requests it.

---

### Task 1: Add the versioned ready and immediate acceptance contracts

**Files:**

- Modify: `app/src/collector-auth-bridge.js`
- Modify: `app/src/App.jsx`
- Test: `app/tests/collector-auth-bridge.test.mjs`

**Contract:**

```js
collector.auth.ready.v2 = {
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.ready.v2",
  generationId,
  accountId,
};

collector.auth.accepted = {
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.accepted",
  requestId,
  generationId,
};
```

`installCollectorAuthBridge` gains `accountId`. For each normalized request ID it posts `accepted` synchronously before awaiting the ticket request. It stores one promise per active request ID, so a repeated request cannot create a second ticket. Accepted entries expire after 30 seconds and are removed after their response settles. A late result from a superseded entry is ignored.

- [ ] **Step 1: Add failing bridge tests**

Add assertions that:

1. A logged-in bridge announces V2 first and then the byte-for-byte legacy ready envelope.
2. V2 contains only `accountId`, `action`, `generationId`, and `protocol`.
3. A valid request emits `collector.auth.accepted` before `requestTicket` resolves.
4. Two equal `requestId` messages share one `requestTicket()` call and one response.
5. A request received after the 30-second lease can supersede the old request, and the old late result is not posted.

- [ ] **Step 2: Run the focused test and capture RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collector-auth-bridge.test.mjs
```

Expected: failures for the missing V2 ready/accepted actions and missing ticket single-flight behavior.

- [ ] **Step 3: Implement the smallest bridge change**

Extend `COLLECTOR_AUTH_ACTIONS`, validate the account ID as a bounded non-empty string, post the V2 ready before the legacy ready, and add a bridge-local request lease map. Pass the authenticated `collectorAuthAccountId` from `App.jsx`:

```jsx
installCollectorAuthBridge({
  accountId: collectorAuthAccountId,
  generationId: transition.generationId,
  isLoggedIn: () => true,
  requestTicket: () => apiRequest("/extension/collector-auth/ticket", { method: "POST" }),
  announceReady: transition.announceReady,
})
```

- [ ] **Step 4: Run the focused test and capture GREEN**

Run the command from Step 2. Expected: all bridge tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/collector-auth-bridge.js app/src/App.jsx app/tests/collector-auth-bridge.test.mjs
git commit -m "feat: acknowledge collector auth requests"
```

---

### Task 2: Normalize V2/accepted messages and stop the one-second ticket storm

**Files:**

- Modify: `extension/lib/web-bridge-policy.js`
- Modify: `extension/lib/collector-auth-flow.js`
- Modify: `extension/content/sync-auth.js`
- Test: `extension/tests/web-bridge-policy.test.js`
- Test: `extension/tests/collector-auth-flow.test.js`
- Test: `extension/tests/sync-auth-runtime.test.js`

**Interfaces:**

```js
normalizeCollectorAuthReadyV2(value)
normalizeCollectorAuthAccepted(value, expectedRequestId)

flow.handleReady({ generationId, accountIdHint })
flow.handleAccepted({ requestId, generationId })
```

The flow sends one request, retries at one second only until `accepted`, then replaces that timer with a 30-second response watchdog. The same-generation legacy ready immediately following V2 is ignored. A response must still match both the active request ID and generation.

- [ ] **Step 1: Add failing closed-envelope policy tests**

Cover exact keys, null-prototype records, invalid/extra fields, bounded IDs, and rejection of tickets/tokens in V2 and accepted envelopes.

- [ ] **Step 2: Add failing flow/runtime tests**

Prove that:

- V2 begins with the supplied account hint and its legacy duplicate does not restart the cycle.
- `accepted` cancels the one-second retry.
- advancing fake time to 29,999 ms creates no additional request.
- the 30-second watchdog creates exactly one fresh request for the same generation.
- a stale accepted/response cannot cancel or complete the newer request.

- [ ] **Step 3: Run RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/web-bridge-policy.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/collector-auth-flow.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/sync-auth-runtime.test.js
```

Expected: missing-normalizer failures and request-count assertions showing the old one-second retry behavior.

- [ ] **Step 4: Implement protocol and flow handling**

Keep `MAX_TICKET_EXCHANGE_ATTEMPTS = 2`. Replace the ten one-second request loop as the normal timing mechanism with one unaccepted retry plus the accepted 30-second watchdog; Task 6 will own longer transient backoff. Model the active request explicitly:

```js
activeRequest = {
  requestId,
  generationId,
  accountIdHint,
  accepted: false,
  leaseExpiresAt,
};
```

Have `sync-auth.js` forward `accountIdHint` only to `collector.auth.begin`, and call `flow.handleAccepted()` for a normalized accepted message. Never forward the hint as an authenticated account result.

- [ ] **Step 5: Run GREEN and the manifest-order regression**

Run all commands from Step 3 plus:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/manifest-security-contract.test.js
```

Expected: all pass; trusted content scripts remain ordered as policy → flow → adapter.

- [ ] **Step 6: Commit**

```bash
git add extension/lib/web-bridge-policy.js extension/lib/collector-auth-flow.js extension/content/sync-auth.js extension/tests/web-bridge-policy.test.js extension/tests/collector-auth-flow.test.js extension/tests/sync-auth-runtime.test.js
git commit -m "fix: deduplicate collector auth ticket requests"
```

---

### Task 3: Preserve a valid same-account session and lengthen only the exchange timeout

**Files:**

- Modify: `extension/lib/collector-session.js`
- Modify: `extension/background/service-worker.js`
- Test: `extension/tests/collector-session.test.js`
- Create: `extension/tests/service-worker-collector-auth.test.js`

**Contract change:**

```js
activateCollectorGeneration({ generationId, accountIdHint })
// => { changed, reused, authenticated, account, permissions, expiresAt }
```

When the stored Collector session is valid and its account ID equals the hint, bind the new generation/incarnation without removing the session. Missing/mismatched hints retain the secure legacy behavior and clear the old session. Default ticket exchange timeout becomes 60 seconds; other API timeouts do not change.

- [ ] **Step 1: Add failing session-manager tests**

Cover:

- same account + unexpired session → token preserved, `reused: true`;
- different account, missing hint, malformed hint, or expired session → token removed, `reused: false`;
- a stale generation exchange still cannot overwrite a newer activation;
- default `AbortSignal.timeout` is requested with `60_000` exactly.

- [ ] **Step 2: Add failing service-worker projection tests**

Assert that `collector.auth.begin` passes both fields and returns an authenticated public projection only when reuse succeeds. The response must not contain the Collector token.

- [ ] **Step 3: Run RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/collector-session.test.js extension/tests/service-worker-collector-auth.test.js
```

Expected: old positional activation clears the same-account session and the timeout assertion reports 5,000 ms.

- [ ] **Step 4: Implement reuse inside the existing serialized mutation fence**

Read generation, incarnation, and session in one storage call. Validate expiry and account equality before preserving. Return only `safeSession()` fields:

```js
if (validStoredSession && accountIdOf(session) === accountIdHint) {
  await chromeApi.storage.session.set({
    [COLLECTOR_AUTH_GENERATION_STORAGE_KEY]: generationId,
    [COLLECTOR_AUTH_INCARNATION_STORAGE_KEY]: createGenerationIncarnation(),
  });
  return { changed: true, reused: true, authenticated: true, ...publicFields };
}
```

- [ ] **Step 5: Run GREEN and collector-operation regressions**

Run Step 3, then all tests that import `collector-session.js`:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/*collector-session*.test.js extension/tests/*collector-operation*.test.js
```

Expected: all pass; account/store isolation and queued-upload ownership remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add extension/lib/collector-session.js extension/background/service-worker.js extension/tests/collector-session.test.js extension/tests/service-worker-collector-auth.test.js
git commit -m "fix: reuse valid collector sessions"
```

---

### Task 4: Make PostgreSQL authentication audit non-blocking on legacy state hydration

**Files:**

- Modify: `server/collector-auth-runtime.mjs`
- Modify: `server/collector-auth-repository.mjs`
- Modify: `server/collector-auth-service.mjs`
- Test: `server/tests/collector-auth-runtime.test.mjs`
- Test: `server/tests/collector-auth-service.test.mjs`

**Runtime dependency:**

```js
createCollectorAuthRuntime({
  // existing dependencies
  insertAuditEvent, // injectable focused PostgreSQL writer for tests
})
```

In PostgreSQL mode, map the service audit event to `createAuditEvent` fields and call `insertPostgresAuditEvent` directly. Do not call `loadState`, `appendAuditEvent`, `saveState`, state protection, or legacy mirroring on the ticket/exchange critical path. JSON mode keeps the current serialized `appendAuditEvent + saveState` behavior. Audit failure remains fail-open and secret-redacted.

Also project `account.displayName` from the relational ticket join so successful PostgreSQL exchange does not call legacy `loadState` only to build the response. JSON mode may use the account already attached by `jsonContext`.

- [ ] **Step 1: Add failing runtime tests with blocking sentinels**

Inject a PostgreSQL repository and `insertAuditEvent` spy while making `loadState`/`saveState` throw if called after repository initialization. Assert issue and exchange succeed, one focused audit row is requested for each success, and metadata contains no ticket/token/parent-session value.

- [ ] **Step 2: Add failing account-projection tests**

Assert the service exchange result contains:

```js
account: { id: "account-a", displayName: "账号 A" }
```

from repository context, without a second legacy state read.

- [ ] **Step 3: Run RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/collector-auth-runtime.test.mjs server/tests/collector-auth-service.test.mjs
```

Expected: sentinel failure caused by the current `runStateTransaction` audit and/or `withAccount(loadState)` path.

- [ ] **Step 4: Implement the focused writer and relational account projection**

Import `insertPostgresAuditEvent`, allow an injected writer, extend ticket context with `account_display_name`, and return the account projection from `exchangeTicket`. Keep the existing action/status vocabulary and entity IDs so audit queries remain compatible.

- [ ] **Step 5: Run GREEN and route regression**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/collector-auth-runtime.test.mjs server/tests/collector-auth-service.test.mjs server/tests/collector-auth-routes.test.mjs
```

Expected: all pass; response shape still exposes only Collector public fields.

- [ ] **Step 6: Commit**

```bash
git add server/collector-auth-runtime.mjs server/collector-auth-repository.mjs server/collector-auth-service.mjs server/tests/collector-auth-runtime.test.mjs server/tests/collector-auth-service.test.mjs
git commit -m "fix: shorten collector auth audit path"
```

---

### Task 5: Atomically supersede older same-device Collector sessions

**Files:**

- Modify: `server/collector-auth-service.mjs`
- Modify: `server/collector-auth-repository.mjs`
- Test: `server/tests/collector-auth-service.test.mjs`

**Internal repository result:**

```js
createSession(record)
// => null | { session: CollectorSessionRecord, supersededCount: number }
```

The service remains backward-compatible with existing repository doubles that return a record directly. Add `SESSION_SUPERSEDED` to the closed revoke-reason vocabulary. A newly created session revokes only older active sessions with the same `accountId` and exact non-empty `deviceFingerprint`; it never touches another account or device.

- [ ] **Step 1: Add failing JSON repository tests**

Create old same-device, other-device, other-account, and already-revoked sessions. Assert that session creation persists the new record and revokes only the old same-account/device record in the same JSON commit, returning `supersededCount: 1`.

- [ ] **Step 2: Add failing PostgreSQL query-fixture tests**

Assert one data-modifying CTE (or one explicit transaction) performs insert + targeted update atomically and binds account/device/new-session ID as parameters. The SQL must include `revoked_at IS NULL`, exclude the newly inserted ID, and avoid wildcard device matching.

- [ ] **Step 3: Run RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/collector-auth-service.test.mjs
```

Expected: old sessions remain active and the result lacks `supersededCount`.

- [ ] **Step 4: Implement atomic replacement and audit count**

Have the service unwrap either the new result or a legacy record double. Add `superseded` to the successful exchange audit metadata, without device fingerprint or secrets.

- [ ] **Step 5: Run GREEN**

Run Step 3. Expected: all service/repository modes pass.

- [ ] **Step 6: Commit**

```bash
git add server/collector-auth-service.mjs server/collector-auth-repository.mjs server/tests/collector-auth-service.test.mjs
git commit -m "fix: supersede duplicate collector sessions"
```

---

### Task 6: Add a credential-free authentication status and retry coordinator

**Files:**

- Create: `extension/lib/collector-auth-coordinator.js`
- Create: `extension/tests/collector-auth-coordinator.test.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/content/sync-auth.js`
- Modify: `extension/manifest.json`
- Test: `extension/tests/service-worker-collector-auth.test.js`
- Test: `extension/tests/sync-auth-runtime.test.js`
- Test: `extension/tests/manifest-security-contract.test.js`

**Stored status contract (`chrome.storage.session`):**

```js
{
  version: 1,
  phase: "WAITING_FOR_WEB" | "DISCOVERING_WEB" | "REQUESTING_TICKET"
    | "EXCHANGING" | "RETRY_WAIT" | "AUTHENTICATED" | "ACTION_REQUIRED",
  generationId: "",
  startedAt: "",
  updatedAt: "",
  attemptNumber: 0,
  nextRetryAt: "",
  publicCode: "",
  account: null,
  expiresAt: "",
}
```

The coordinator owns `sonliCollectorAuthStatus`, alarm `collectorAuthRetry`, one in-memory operation promise, and retry delays 1/2/5/10/30 seconds plus bounded jitter. Public codes are closed to:

`WEB_LOGIN_REQUIRED`, `WEB_TAB_UNAVAILABLE`, `LOCAL_SERVICE_UNAVAILABLE`, `ACCOUNT_DISABLED`, `ACCOUNT_EXPIRED`, `PERMISSION_DENIED`, `TRUST_BOUNDARY_REJECTED`, `SERVER_UPGRADE_REQUIRED`.

It exposes:

```js
createCollectorAuthCoordinator(deps)
coordinator.getStatus()
coordinator.begin({ generationId })
coordinator.accept({ requestId, generationId })
coordinator.exchange({ generationId })
coordinator.succeed({ generationId, account, expiresAt })
coordinator.fail({ generationId, error })
coordinator.retryNow()
coordinator.resume()
```

- [ ] **Step 1: Add failing pure coordinator tests**

Use fake storage, alarm, clock, and randomness. Cover every phase transition, exact public-code mapping, closed status shape, single-flight retry, jitter bounds, max 30-second delay, stale-generation rejection, service-worker restart resume, and absence of credential-like keys/values.

- [ ] **Step 2: Run RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/collector-auth-coordinator.test.js
```

Expected: module-not-found.

- [ ] **Step 3: Implement the pure coordinator**

Keep it as an IIFE/CommonJS-compatible module matching the extension’s existing style. Store only the public projection. `fail()` schedules retry only for transient transport/service errors; permission/account/trust/version failures enter `ACTION_REQUIRED` and do not loop.

- [ ] **Step 4: Integrate service-worker messages and alarms**

Import the module before `collector-session.js`. Add privileged message cases:

```js
getCollectorAuthStatus
retryCollectorAuth
collector.auth.accepted
```

Have `sync-auth.js` forward a normalized accepted event to `collector.auth.accepted`. Route existing begin/exchange success/failure through coordinator phase updates. `requestCollectorAuth` sets `DISCOVERING_WEB` or `WEB_TAB_UNAVAILABLE`. On startup and `collectorAuthRetry` alarm, resume exactly one request. Do not expose credential storage keys through these messages.

- [ ] **Step 5: Run GREEN and security regressions**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/collector-auth-coordinator.test.js extension/tests/service-worker-collector-auth.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/manifest-security-contract.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/sync-auth-runtime.test.js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add extension/lib/collector-auth-coordinator.js extension/tests/collector-auth-coordinator.test.js extension/background/service-worker.js extension/content/sync-auth.js extension/manifest.json extension/tests/service-worker-collector-auth.test.js extension/tests/sync-auth-runtime.test.js extension/tests/manifest-security-contract.test.js
git commit -m "feat: track collector authentication progress"
```

---

### Task 7: Render live login progress in the popup

**Files:**

- Modify: `extension/popup/popup.html`
- Modify: `extension/popup/popup.css`
- Modify: `extension/popup/popup.js`
- Test: `extension/popup/__tests__/popup-collector-session.runtime.test.js`

**UI behavior:**

- The login card uses `aria-live="polite"` for status copy.
- The primary button becomes disabled with “正在打开 Web 登录页…” while opening.
- After opening, it shows `WAITING_FOR_WEB`/`REQUESTING_TICKET`/`EXCHANGING` progress without telling the user to reopen the extension.
- `RETRY_WAIT` shows the next retry countdown and a working “立即重试”.
- `ACTION_REQUIRED` shows only mapped Chinese copy; it never renders raw server errors.
- `AUTHENTICATED` switches to the main view immediately.
- Popup initializes from `getCollectorAuthStatus` and listens to `chrome.storage.onChanged` for session-area status changes; it does not poll every 400 ms.

- [ ] **Step 1: Add failing popup runtime tests**

Extend the fake Chrome API with `storage.session` and `storage.onChanged`. Assert each phase’s exact visible text/button state, live transition to authenticated, no raw code leakage, retry message dispatch, and exactly one listener registration.

- [ ] **Step 2: Run RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/popup/__tests__/popup-collector-session.runtime.test.js
```

Expected: missing status elements/listener and old “重新打开扩展” copy assertions fail.

- [ ] **Step 3: Implement status-driven rendering**

Add one `renderCollectorAuthStatus(status)` mapping with an exhaustive default to a safe local-service message. Keep credentials out of DOM data attributes and error copy. Replace the fixed 400 ms recheck with `retryCollectorAuth` and live storage updates.

- [ ] **Step 4: Run GREEN and UI parity**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/popup/__tests__/popup-collector-session.runtime.test.js
QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-ui-parity.mjs
```

Expected: popup tests pass. If UI parity reports an intentional authentication-surface delta, update the repository’s existing parity exception contract in the same commit with the narrowest paths/reason; do not disable the gate.

- [ ] **Step 5: Commit**

```bash
git add extension/popup/popup.html extension/popup/popup.css extension/popup/popup.js extension/popup/__tests__/popup-collector-session.runtime.test.js
git commit -m "feat: show live extension login progress"
```

---

### Task 8: Run cross-layer acceptance, bump version, and package 0.13.46.4

**Files:**

- Modify: `extension/manifest.json`
- Modify: `package.json`
- Modify/generated: `app/public/sonli-extension-0.13.46.4/`
- Modify/generated: `app/public/sonli-extension-0.13.46.4.zip`
- Modify if required by version contract: extension/version tests and download metadata tests identified by `rg "0\.13\.46\.3"`

- [ ] **Step 1: Run all focused authentication tests before packaging**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collector-auth-bridge.test.mjs extension/tests/collector-auth-flow.test.js extension/tests/collector-auth-coordinator.test.js extension/tests/collector-session.test.js extension/tests/service-worker-collector-auth.test.js extension/popup/__tests__/popup-collector-session.runtime.test.js server/tests/collector-auth-runtime.test.mjs server/tests/collector-auth-service.test.mjs server/tests/collector-auth-routes.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/web-bridge-policy.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/sync-auth-runtime.test.js
```

Expected: all pass.

- [ ] **Step 2: Add/execute a deterministic latency acceptance test**

Use fake timers/deferred promises, not wall-clock sleeps or a real login. Prove:

- same-account valid session reaches `AUTHENTICATED` without ticket issuance and within the synchronous/fake-clock 500 ms budget;
- first auth emits one accepted request, one ticket request, and one exchange;
- accepted prevents a second request for 30 seconds;
- transient failure exposes `RETRY_WAIT` and resumes once;
- popup observes every status through the credential-free snapshot.

Place this in `extension/tests/collector-auth-acceptance.test.js`, then run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/collector-auth-acceptance.test.js
```

Expected: pass.

- [ ] **Step 3: Bump versions**

Set `extension/manifest.json` to `0.13.46.4` and root `package.json` to `0.13.46.4-local`. Update only exact version contracts found by:

```bash
rg -n "0\.13\.46\.3" package.json extension app scripts server
```

- [ ] **Step 4: Build the Web app and package the extension**

```bash
PATH=/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/usr/bin:/bin pnpm --dir app build
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/package-extension.mjs
```

Expected: Vite build succeeds and both `app/public/sonli-extension-0.13.46.4/` and `.zip` are regenerated from `extension/`.

- [ ] **Step 5: Run package/security/parity gates**

```bash
QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-source-parity.mjs
QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-ui-parity.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-zip.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-zip-smoke.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-personal-data.mjs
git diff --check
```

Expected: all pass and no secret/personal-data finding appears.

- [ ] **Step 6: Run the repository verification gate and classify unrelated failures**

```bash
QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify.mjs
```

Expected: pass. If an existing environment/fixture failure remains, preserve the full command/output, prove it reproduces on the pre-change commit, and report it as unverified rather than weakening a check.

- [ ] **Step 7: Review the final diff against the confirmed design**

Check:

- no database migration;
- no Web/Collector credential copied into popup status or page messages;
- no ticket request storm after accepted;
- same-account reuse cannot cross accounts;
- PostgreSQL auth audit avoids legacy state save;
- same-device supersession is account-scoped and atomic;
- rollback requires only code/package rollback.

- [ ] **Step 8: Commit the versioned package**

```bash
git add package.json extension/manifest.json extension/tests/collector-auth-acceptance.test.js app/public/sonli-extension-0.13.46.4 app/public/sonli-extension-0.13.46.4.zip
git commit -m "build: package extension 0.13.46.4"
```

## Delivery Notes

- **Changed contracts:** V2 ready, accepted acknowledgement, internal generation activation result, credential-free authentication status, internal session-creation result, and direct PostgreSQL audit dependency.
- **Regression scope:** Web login bridge; content-script trust boundary; service-worker auth routes; Collector operation ownership; popup login/main views; JSON and PostgreSQL repository behavior; extension parity and ZIP contents.
- **Not verified by automated work:** a human real-browser login against a live account and real PostgreSQL latency under production load. Perform that only with explicit approval and a non-production test account.
- **Rollback:** revert the task commits in reverse order and reinstall `0.13.46.3`. No schema/data rollback is required; sessions marked `SESSION_SUPERSEDED` remain safely revoked and users can authenticate again.

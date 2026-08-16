# Minimal Collector Authentication Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the page-owned authentication cycle with one extension-background-owned attempt so one user action produces at most one Web ticket request and one exchange, while keeping account invalidation and PostgreSQL session replacement correct.

**Architecture:** The extension service worker creates the request identity, selects exactly one trusted Web tab, and owns retry, timeout, failover, and status. The Web content/page bridge becomes a single-request adapter with no autonomous discovery or cross-page lease. The server remains authoritative for account status and session replacement, using a fixed PostgreSQL transaction and NUL-free advisory lock keys.

**Tech Stack:** Chrome Manifest V3 service worker/content scripts, plain JavaScript modules, Node test runner, React/Vite Web app, PostgreSQL-style repository adapters.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-16-minimal-collector-auth-coordinator-design.md` verbatim.
- Do not add a database table, index, migration, event bus, framework, or additional persisted authentication state machine.
- Keep extension version `0.13.46.4` and root version `0.13.46.4-local`.
- Keep V2 ready/accepted, ticket exchange, and the credential-free ten-field popup status contract backward compatible.
- The service worker is the only owner of an authentication attempt and chooses one trusted Web tab at a time.
- Web pages never start Collector authentication on load and never coordinate across tabs.
- Every accepted, failure, ticket, and exchange message is bound to the service-worker-generated request ID; stale messages cannot cancel or overwrite a new attempt.
- Do not expose parent Web sessions, Bearer tokens, Collector tokens, ticket contents, fingerprints, or raw server errors in popup status, page messages, logs, or audits.
- Do not run real login, production/external APIs, production data, or database migrations.
- Verification is limited to the five design acceptance scenarios, directly related authentication regression tests, build, source/UI/distribution parity, ZIP smoke, personal-data scan, and `git diff --check`.
- Do not run the known-hanging repository-wide verification; retain the existing current/base Chrome `SIGABRT` evidence.

---

### Task 1: Make the service worker the only Web-tab selector

**Files:**

- Modify: `extension/background/service-worker.js`
- Modify: `extension/content/sync-auth.js`
- Modify: `extension/lib/collector-auth-flow.js`
- Modify: `extension/tests/collector-auth-flow.test.js`
- Modify: `extension/tests/service-worker-collector-auth.test.js`
- Modify: `extension/tests/collector-auth-acceptance.test.js`
- Modify/generated later: `app/public/sonli-extension-0.13.46.4/background/service-worker.js`
- Modify/generated later: `app/public/sonli-extension-0.13.46.4/content/sync-auth.js`

**Interfaces:**

- Produces: `requestCollectorAuthFromWeb(requestId = newCollectorAuthRequestId())` sends one `{ action: "collector.auth.request", requestId }` message to one trusted tab.
- Produces: content runtime handler returns `{ ok: true, requested: boolean, requestId }` and never starts discovery at script evaluation.
- Changes: `flow.requestAuthoritatively(requestId)` accepts a caller-owned canonical ID while retaining the existing flow internals until Task 2 removes their retry ownership.
- Preserves: trusted frontend URL filtering and deterministic active/last-accessed/tab-ID order.
- Later Task 2 consumes the worker-generated `requestId` as the end-to-end attempt identity.

- [ ] **Step 1: Write the failing single-owner tests**

Add behavior tests that load two trusted Web tabs and assert that one retry invokes only the first candidate. Add a second case where the first tab throws `Could not establish connection` and the worker tries the second candidate exactly once. Add a content-script load test asserting zero page requests until the worker sends `collector.auth.request`.

```js
test('one retry selects only one trusted Web tab', async () => {
  const harness = await createHarness({
    tabs: [
      { id: 10, active: true, lastAccessed: 200 },
      { id: 11, active: false, lastAccessed: 100 },
    ],
  });
  await sendRuntime(harness, { action: 'retryCollectorAuth' });
  assert.deepEqual(harness.tabMessages.map(({ tabId }) => tabId), [10]);
  assert.equal(harness.tabMessages[0].message.action, 'collector.auth.request');
  assert.match(harness.tabMessages[0].message.requestId, /^collector-/);
});

test('content script does not discover Web auth until selected by the worker', async () => {
  const runtime = createSyncAuthHarness();
  await runtime.load();
  assert.equal(runtime.pageRequests.length, 0);
  await runtime.receive({ action: 'collector.auth.request', requestId: 'collector-attempt-1' });
  assert.deepEqual(runtime.pageRequests, ['collector-attempt-1']);
});
```

- [ ] **Step 2: Run RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/service-worker-collector-auth.test.js extension/tests/collector-auth-acceptance.test.js
```

Expected: the two-tab request is not bound to a worker request ID, and content-script evaluation emits an autonomous page request.

- [ ] **Step 3: Implement deterministic single-tab ownership**

In the service worker, generate one canonical request ID before tab discovery, remember the last selected tab ID, and rotate the sorted candidates only between attempts. Send to candidates sequentially and stop after the first `{ ok: true, requested: true, requestId }` response.

```js
let lastCollectorAuthTabId = null;

const orderedCollectorAuthTabs = (tabs) => {
  const ordered = [...tabs].filter(({ id }) => Number.isInteger(id)).sort(compareCollectorAuthTabs);
  const previous = ordered.findIndex(({ id }) => id === lastCollectorAuthTabId);
  return previous < 0 ? ordered : [...ordered.slice(previous + 1), ...ordered.slice(0, previous + 1)];
};

const requestCollectorAuthFromWeb = async (requestId = newCollectorAuthRequestId()) => {
  for (const tab of orderedCollectorAuthTabs(
    await chrome.tabs.query({ url: TRUSTED_FRONTEND_TAB_URLS }),
  )) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'collector.auth.request',
        requestId,
      });
      if (response?.ok === true && response?.requested === true
        && response?.requestId === requestId) {
        lastCollectorAuthTabId = tab.id;
        return { requested: true, requestId, tabId: tab.id };
      }
    } catch {}
  }
  return { requested: false, requestId, tabId: null, publicCode: 'WEB_TAB_UNAVAILABLE' };
};
```

Remove the unconditional `flow.startDiscovery()` call at the end of `extension/content/sync-auth.js`. Its runtime handler must reject missing/noncanonical request IDs and call `flow.requestAuthoritatively(message.requestId)` only after worker selection. Make the smallest Task 1 flow change: `requestAuthoritatively(requestId)` validates and uses the supplied ID instead of calling `newRequestId()` for that worker-selected cycle; do not remove the remaining flow timers until Task 2's covering RED exists.

- [ ] **Step 4: Run GREEN and direct regressions**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/collector-auth-flow.test.js extension/tests/service-worker-collector-auth.test.js extension/tests/collector-auth-acceptance.test.js extension/tests/sync-capability-removed.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/sync-auth-runtime.test.js
```

Expected: all pass; script load emits no page request; one worker attempt addresses only one Web tab.

- [ ] **Step 5: Commit**

```bash
git add extension/background/service-worker.js extension/content/sync-auth.js extension/lib/collector-auth-flow.js extension/tests/collector-auth-flow.test.js extension/tests/service-worker-collector-auth.test.js extension/tests/collector-auth-acceptance.test.js
git commit -m "fix: centralize collector auth tab selection"
```

---

### Task 2: Use one worker request identity and remove page-owned leases

**Files:**

- Modify: `app/src/collector-auth-bridge.js`
- Modify: `app/src/App.jsx`
- Modify: `app/tests/collector-auth-bridge.test.mjs`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/content/sync-auth.js`
- Modify: `extension/lib/collector-auth-flow.js`
- Modify: `extension/lib/collector-auth-coordinator.js`
- Modify: `extension/lib/portal-bridge-policy.js`
- Modify: `extension/lib/web-bridge-policy.js`
- Modify: `extension/tests/collector-auth-flow.test.js`
- Modify: `extension/tests/collector-auth-coordinator.test.js`
- Modify: `extension/tests/portal-bridge-policy.test.js`
- Modify: `extension/tests/service-worker-collector-auth.test.js`
- Modify: `extension/tests/web-bridge-policy.test.js`
- Modify: `extension/tests/collector-auth-acceptance.test.js`

**Interfaces:**

- Changes: `createCollectorAuthCoordinator({ ..., newRequestId, requestAuth })`, where `requestAuth(requestId)` receives the coordinator-owned ID.
- Changes: `flow.requestAuthoritatively(requestId)` consumes the worker ID; the flow no longer generates IDs or owns retry timers.
- Changes: internal `collector.auth.begin`, `collector.auth.accepted`, `collector.auth.failure`, and `collector.auth.exchange` messages include exact `requestId`.
- Produces: the service worker keeps one in-memory `{ requestId, tabId }` selected attempt and rejects mismatched sender tab or request ID.
- Removes: Web bridge 30-second `activeTicketLease`, `collector.auth.release`, and content-flow retry/release ownership.
- Preserves: page-origin checks, V2 ready/accepted, 28-second HTTP abort, ticket confidentiality, and the public failure-code allowlist.

- [ ] **Step 1: Write RED tests for request identity and recovery**

Add tests for these exact behaviors:

```js
test('late failure cannot cancel the next worker attempt', async () => {
  const first = await harness.retry();
  await harness.expireResponseWatchdog(first.requestId);
  const second = await harness.retry();
  await harness.sendFailure({
    requestId: first.requestId,
    generationId: first.generationId,
    publicCode: 'LOCAL_SERVICE_UNAVAILABLE',
  });
  assert.equal((await harness.status()).phase, 'REQUESTING_TICKET');
  assert.equal(harness.activeRequestId(), second.requestId);
});

test('accepted response timeout rotates to the next tab once', async () => {
  const first = await harness.retry();
  await harness.accept(first);
  await harness.advance(31_000);
  assert.deepEqual(harness.selectedTabIds, [10, 11]);
  assert.equal(harness.maxConcurrentPageRequests, 1);
});

test('two tabs cannot issue tickets for one worker attempt', async () => {
  await acceptance.retry();
  assert.equal(acceptance.ticketRequests, 1);
  assert.equal(acceptance.exchangeRequests, 1);
});
```

Update the bridge test to prove it processes the one selected request without retaining a page-level lease after success. Update policy tests to reject messages missing `requestId`, with extra credential fields, or with a noncanonical request ID.

- [ ] **Step 2: Run RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collector-auth-bridge.test.mjs extension/tests/collector-auth-flow.test.js extension/tests/collector-auth-coordinator.test.js extension/tests/portal-bridge-policy.test.js extension/tests/service-worker-collector-auth.test.js extension/tests/web-bridge-policy.test.js extension/tests/collector-auth-acceptance.test.js
```

Expected: flow still creates its own ID, bridge retains its lease, accepted has no response watchdog, and stale failure can clear an unrelated watchdog.

- [ ] **Step 3: Make the coordinator create and fence the request ID**

Add `newRequestId` as a coordinator dependency. `runRequest()` creates the ID before installing the request lease and calls `requestAuth(requestId)`. Store both request and generation identity in the in-memory lease.

```js
const requestId = safeRequestId(newRequestId());
const requestLease = Object.freeze({
  requestId,
  generationId: status.generationId,
});
activeRequestLease = requestLease;
const outcome = await requestAuth(requestId);
```

`begin`, `accept`, `exchange`, `succeed`, and `fail` must verify `requestId` before mutating status or clearing either watchdog. `begin({ requestId, generationId })` adopts the Web generation on the same lease rather than replacing the request identity.

Use two timers owned only by the coordinator:

- no-ack watchdog: 2,500 ms while `DISCOVERING_WEB`;
- response watchdog: 31,000 ms after accepted, longer than the Web HTTP timeout.

The response watchdog applies `LOCAL_SERVICE_UNAVAILABLE`, releases the exact lease, and schedules the existing bounded retry. A stale callback is a no-op.

- [ ] **Step 4: Simplify content flow and page bridge**

Change the flow to accept the exact worker request ID and remove `newRequestId`, `releaseRequest`, its 1-second bridge retry, and its 30-second response watchdog. It keeps only the selected request, Web generation adoption, one exchange-in-flight flag, and stale-request rejection.

```js
const requestAuthoritatively = (requestId) => {
  const normalized = safeRequestId(requestId);
  if (!normalized || exchangeInFlight) return { requested: false, requestId: normalized };
  activeRequest = { requestId: normalized, generationId: '', accountIdHint: '' };
  postRequest(normalized);
  return { requested: true, requestId: normalized };
};
```

Forward `requestId` through begin, accepted, failure, and exchange. The service worker must require both `sender.tab.id === activeAttempt.tabId` and `message.requestId === activeAttempt.requestId` before calling the coordinator or session manager.

In the App bridge, remove `activeTicketLease`, lease timers, release handling, and page-level dedupe. Keep one local `AbortController` for the current handler invocation, pass its signal to `requestTicket`, emit accepted before awaiting the request, and emit one closed failure envelope on reject/timeout. Uninstall aborts only currently pending handler invocations.

- [ ] **Step 5: Run GREEN and the five cross-layer scenarios owned by this task**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collector-auth-bridge.test.mjs extension/tests/collector-auth-flow.test.js extension/tests/collector-auth-coordinator.test.js extension/tests/portal-bridge-policy.test.js extension/tests/service-worker-collector-auth.test.js extension/tests/web-bridge-policy.test.js extension/tests/collector-auth-acceptance.test.js extension/tests/sync-capability-removed.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/web-bridge-policy.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/sync-auth-runtime.test.js
```

Expected: all pass; single tab, two tabs, selected-tab failure, accepted-without-response, and stale-message replacement are deterministic with fake clocks and no wall-clock sleep.

- [ ] **Step 6: Commit**

```bash
git add app/src/collector-auth-bridge.js app/src/App.jsx app/tests/collector-auth-bridge.test.mjs extension/background/service-worker.js extension/content/sync-auth.js extension/lib/collector-auth-flow.js extension/lib/collector-auth-coordinator.js extension/lib/portal-bridge-policy.js extension/lib/web-bridge-policy.js extension/tests/collector-auth-flow.test.js extension/tests/collector-auth-coordinator.test.js extension/tests/portal-bridge-policy.test.js extension/tests/service-worker-collector-auth.test.js extension/tests/web-bridge-policy.test.js extension/tests/collector-auth-acceptance.test.js
git commit -m "fix: bind collector auth to one worker attempt"
```

---

### Task 3: Correct PostgreSQL locking and account invalidation

**Files:**

- Modify: `server/account-context.mjs`
- Modify: `server/collector-auth-repository.mjs`
- Modify: `server/collector-auth-runtime.mjs`
- Modify: `server/tests/collector-auth-runtime.test.mjs`
- Modify: `server/tests/collector-auth-service.test.mjs`

**Interfaces:**

- Changes: PostgreSQL lock query becomes `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))` with separate account and device parameters.
- Produces stable internal codes: `WEB_AUTH_REQUIRED`, `COLLECTOR_ACCOUNT_DISABLED`, and `COLLECTOR_ACCOUNT_EXPIRED`.
- Changes audit-driven revocation hook to match `collector_account_disabled` and `collector_account_expired` and persist the corresponding revoke reason.
- Preserves: fixed connection, `BEGIN`/`COMMIT`/`ROLLBACK`, account/device scope, zero-insert behavior, no migration, and numeric `superseded` audit.

- [ ] **Step 1: Write the failing PostgreSQL and account-lifecycle tests**

```js
test('PostgreSQL advisory lock uses two NUL-free text parameters', async () => {
  const repository = createPostgresRepository({ pool: recordingPool });
  await repository.createSession(validSessionInput());
  const lock = recordingPool.calls.find(({ sql }) => /pg_advisory_xact_lock/.test(sql));
  assert.match(lock.sql, /hashtext\(\$1\),\s*hashtext\(\$2\)/);
  assert.deepEqual(lock.params, ['account-a', 'device-a']);
  assert.equal(lock.params.some((value) => value.includes('\u0000')), false);
});

test('disabled Collector account stays revoked after account recovery', async () => {
  const token = await createCollectorTokenFor('account-a');
  await setAccountStatus('account-a', 'disabled');
  await assert.rejects(authenticate(token), { code: 'COLLECTOR_ACCOUNT_DISABLED' });
  await setAccountStatus('account-a', 'active');
  await assert.rejects(authenticate(token), { code: 'COLLECTOR_SESSION_REVOKED' });
});
```

Add the equivalent expired-account case. Add a route test proving disabled and expired Web accounts retain their exact stable codes instead of `COLLECTOR_AUTH_FAILED`. Keep the concurrent same-account/device fixture and make it reject any lock query containing NUL.

- [ ] **Step 2: Run RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/collector-auth-service.test.mjs server/tests/collector-auth-runtime.test.mjs server/tests/collector-auth-routes.test.mjs
```

Expected: the existing advisory lock contains NUL; real route errors lose account status codes; the revocation hook ignores the new disabled/expired outcomes.

- [ ] **Step 3: Implement NUL-free locking and stable account errors**

Replace the lock with PostgreSQL's two-int advisory-lock overload:

```js
await client.query(
  'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
  [record.accountId, record.deviceFingerprint],
);
```

Set stable codes at the source in `requireAuth`:

```js
if (!session || !account) throw codedAuthError('WEB_AUTH_REQUIRED', 401, loginCopy);
if (account.status === 'disabled') {
  throw codedAuthError('COLLECTOR_ACCOUNT_DISABLED', 403, disabledCopy);
}
if (isAccountExpired(account)) {
  throw codedAuthError('COLLECTOR_ACCOUNT_EXPIRED', 403, expiredCopy);
}
```

Do not expose account IDs in public errors. In the runtime audit hook, match both new service outcomes and revoke all sessions for the event's already-authorized internal `accountId` with exact reasons `ACCOUNT_DISABLED` or `ACCOUNT_EXPIRED`.

- [ ] **Step 4: Run GREEN and server regression**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/collector-auth-service.test.mjs server/tests/collector-auth-runtime.test.mjs server/tests/collector-auth-routes.test.mjs
```

Expected: all pass; transaction order is `BEGIN → advisory lock → INSERT → UPDATE → COMMIT`; failure is `ROLLBACK → release`; two same-key fixture transactions leave one active session; disabled/expired recovery cannot revive an old Collector token.

- [ ] **Step 5: Commit**

```bash
git add server/account-context.mjs server/collector-auth-repository.mjs server/collector-auth-runtime.mjs server/tests/collector-auth-runtime.test.mjs server/tests/collector-auth-service.test.mjs server/tests/collector-auth-routes.test.mjs
git commit -m "fix: enforce collector account session authority"
```

---

### Task 4: Keep the popup neutral until authority is confirmed and repackage

**Files:**

- Modify: `extension/popup/popup.js`
- Modify: `extension/popup/__tests__/popup-collector-session.runtime.test.js`
- Regenerate: `app/public/sonli-extension-0.13.46.4/`
- Regenerate: `app/public/sonli-extension-0.13.46.4.zip`

**Interfaces:**

- Changes: `ensureMainView(status)` does not call `setLoginState(true)` until `fetchAuth()` returns the same account ID and expiry for the still-current activation.
- Produces visible neutral copy: `正在确认登录状态` while privileged authority is pending.
- Preserves: stale activation fences, denial teardown, one storage listener, no 400 ms polling, and credential-free DOM.

- [ ] **Step 1: Write the failing popup tests**

```js
test('authenticated projection stays neutral until privileged getAuth confirms it', async () => {
  const pending = deferred();
  const popup = await createPopupHarness({ getAuth: () => pending.promise });
  popup.emitStatus(authenticatedStatus('account-a'));
  assert.equal(popup.mainView.classList.contains('active'), false);
  assert.equal(popup.loginTip.textContent, '正在确认登录状态');
  pending.resolve(validAuth('account-a'));
  await popup.flush();
  assert.equal(popup.mainView.classList.contains('active'), true);
});
```

Keep separate denial tests for unauthenticated, account mismatch, and expiry mismatch. Assert their pending phase never exposes the previous account's badges or main shell.

- [ ] **Step 2: Run RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/popup/__tests__/popup-collector-session.runtime.test.js extension/popup/__tests__/popup-routing.smoke.test.js
```

Expected: current popup activates the main shell before `getAuth` resolves.

- [ ] **Step 3: Implement the neutral authority gate**

When a new authenticated projection arrives, stop Seller polling, hide the main shell, hide old navigation badges, and render `正在确认登录状态`. Only after `fetchAuth()` matches the current activation should the popup call `setLoginState(true)` and `initMainView`. A stale or denied result must not start polling, restore badges, or mutate a newer activation.

- [ ] **Step 4: Run the minimal final authentication regression**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collector-auth-bridge.test.mjs extension/tests/collector-auth-flow.test.js extension/tests/collector-auth-coordinator.test.js extension/tests/collector-auth-acceptance.test.js extension/tests/collector-session.test.js extension/tests/portal-bridge-policy.test.js extension/tests/service-worker-collector-auth.test.js extension/tests/web-bridge-policy.test.js extension/popup/__tests__/popup-collector-session.runtime.test.js extension/popup/__tests__/popup-routing.smoke.test.js server/tests/collector-auth-runtime.test.mjs server/tests/collector-auth-service.test.mjs server/tests/collector-auth-routes.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/web-bridge-policy.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/portal-bridge-policy.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/sync-auth-runtime.test.js
```

Expected: all pass. Report the exact total; do not add unrelated suites to increase the number.

- [ ] **Step 5: Build and regenerate the unchanged 0.13.46.4 package**

```bash
PATH=/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/usr/bin:/bin pnpm --dir app build
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/package-extension.mjs
```

Expected: Vite build succeeds and both `app/public/sonli-extension-0.13.46.4/` and its ZIP are regenerated from the final `extension/` source.

- [ ] **Step 6: Run only the agreed distribution gates**

```bash
QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-source-parity.mjs
QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-ui-parity.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-zip.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-extension-zip-smoke.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-personal-data.mjs
git diff --check
```

Expected: all pass; ZIP contains exactly the production files from `extension/`; no credentials or personal data are reported.

- [ ] **Step 7: Commit**

```bash
git add extension/popup/popup.js extension/popup/__tests__/popup-collector-session.runtime.test.js app/public/sonli-extension-0.13.46.4 app/public/sonli-extension-0.13.46.4.zip
git commit -m "build: package simplified collector authentication"
```

## Delivery Notes

- **Changed contracts:** worker-to-content `collector.auth.request` gains worker-owned `requestId`; internal begin/accepted/failure/exchange messages require that exact ID. Public popup status remains unchanged.
- **Removed ownership:** Web page load no longer starts authentication; Web bridge and content flow no longer own cross-page lease/retry state.
- **Security:** sender tab and request ID are checked before any session or status mutation; no new credential projection is introduced.
- **Database:** no migration; PostgreSQL advisory lock uses two NUL-free keys on one explicit transaction connection.
- **Not verified:** real login, production/external APIs, production data, and live PostgreSQL scheduling. The PostgreSQL transaction is covered by the existing executable concurrency fixture.
- **Rollback:** revert the four task commits in reverse order and reinstall the prior `0.13.46.4` package. No schema rollback is required.

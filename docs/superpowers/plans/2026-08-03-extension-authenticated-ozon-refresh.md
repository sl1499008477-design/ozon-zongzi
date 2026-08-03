# Extension Authenticated Ozon Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establishing a new Collector session automatically refreshes open Ozon buyer pages once so stale “请登录 Web” panels reread the authenticated extension state.

**Architecture:** Reuse the service worker's existing debounced `reloadOzonTabs()` boundary. Call it only after `collector.auth.exchange` succeeds; failed exchanges keep the current fail-closed response and produce no tab refresh. Repackage the existing `0.13.46.2` development artifact so the downloadable extension matches the tested source.

**Tech Stack:** Chrome Manifest V3 service worker, CommonJS Node test harness with `node:test`, existing extension packaging and parity scripts.

## Global Constraints

- Refresh only Ozon buyer pages matching `ozon.ru`, `www.ozon.ru`, `ozon.kz`, or `www.ozon.kz`.
- Never refresh `seller.ozon.ru`.
- Refresh only after a successful Collector ticket exchange; failed exchange, status check, and unauthenticated state must not refresh.
- Reuse the existing 300 ms debounce so one authentication wave cannot create a reload loop.
- Do not change Web authentication, Collector permissions, API contracts, store configuration, or database data.
- Preserve the user's unrelated modifications under `docs/plans` and `docs/superpowers/plans`.

---

### Task 1: Refresh Ozon buyer pages after Collector exchange

**Files:**
- Modify: `extension/tests/sync-capability-removed.test.js`
- Modify: `extension/background/service-worker.js:4100-4140`

**Interfaces:**
- Consumes: existing `reloadOzonTabs(): void`, which queries only Ozon buyer URL patterns and debounces for 300 ms.
- Produces: `collector.auth.exchange` success schedules one buyer-page refresh wave; its public response contract remains unchanged.

- [ ] **Step 1: Write the failing success-path test**

Add a behavioral test to `extension/tests/sync-capability-removed.test.js` that begins a valid generation, exchanges a valid ticket, lets queued work settle, and asserts both returned buyer tab IDs were reloaded. Assert the captured reload query literally equals the four existing buyer URL patterns and contains no Seller URL.

```js
test('successful Collector exchange refreshes only open Ozon buyer pages', async () => {
  const buyerPatterns = [
    'https://ozon.ru/*',
    'https://www.ozon.ru/*',
    'https://ozon.kz/*',
    'https://www.ozon.kz/*',
  ];
  const harness = loadServiceWorker({
    tabQueryImpl: async (query) => (
      JSON.stringify(query.url) === JSON.stringify(buyerPatterns)
        ? [{ id: 31 }, { id: 32 }]
        : []
    ),
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/extension/collector-auth/exchange') {
        return new Response(JSON.stringify({
          data: {
            collectorToken: 'csess_refresh_success_123456789',
            expiresAt: '2099-01-01T00:00:00.000Z',
            account: { id: 'account-refresh', displayName: 'Refresh' },
            permissions: ['collector.upload', 'collector.ozon.read'],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (pathname === AVAILABILITY_PATH) return availabilityResponse(url, options, false);
      throw new Error(`unexpected refresh path: ${pathname}`);
    },
  });

  await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    generationId: G1,
  }, trustedWebSender);
  const exchanged = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: 'exchange-refresh-success',
    generationId: G1,
    ticket: 'ctt_refresh_success_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedWebSender);
  await settle();

  assert.equal(exchanged.ok, true);
  assert.deepEqual(harness.reloadedTabs, [31, 32]);
  assert.ok(harness.tabQueryCalls.some(({ url }) => (
    JSON.stringify(url) === JSON.stringify(buyerPatterns)
  )));
  assert.equal(harness.tabQueryCalls.some(({ url }) => (
    JSON.stringify(url).includes('seller.ozon.ru')
  )), false);
});
```

- [ ] **Step 2: Write the failed-exchange boundary test**

Add a second behavioral test whose exchange adapter rejects. It must assert the stable failed response and `harness.reloadedTabs` remains empty after queued work settles.

```js
test('failed Collector exchange never refreshes an Ozon page', async () => {
  const harness = loadServiceWorker({
    collectorExchangeImpl: async () => {
      throw Object.assign(new Error('expired'), {
        status: 401,
        code: 'COLLECTOR_TICKET_EXPIRED',
      });
    },
    tabQueryImpl: async () => [{ id: 31 }],
  });

  await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.begin',
    generationId: G1,
  }, trustedWebSender);
  const exchanged = await sendRuntimeMessage(harness, {
    portalProtocol: 'SONLI_COLLECTOR_AUTH',
    action: 'collector.auth.exchange',
    requestId: 'exchange-refresh-failure',
    generationId: G1,
    ticket: 'ctt_refresh_failure_123456789',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, trustedWebSender);
  await settle();

  assert.equal(exchanged.ok, false);
  assert.equal(exchanged.code, 'COLLECTOR_TICKET_EXPIRED');
  assert.deepEqual(harness.reloadedTabs, []);
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 extension/tests/sync-capability-removed.test.js
```

Expected: the success-path test fails because `harness.reloadedTabs` is `[]`; the failed-exchange test passes.

- [ ] **Step 4: Implement the minimal production change**

In the successful `collector.auth.exchange` branch, immediately after the Collector session is established and the enrichment worker is kicked, schedule the existing buyer-page refresh:

```js
const session = await collectorSessionManager.exchangeCollectorTicket({
  ticket: message.ticket,
  deviceFingerprint: await getExtensionFingerprint(),
  extensionVersion: String(manifest.version || ''),
  generationId: message.generationId,
});
kickCollectorOzonEnrichment();
reloadOzonTabs();
return {
  ok: true,
  data: {
    authenticated: true,
    account: session.account,
    permissions: session.permissions,
    expiresAt: session.expiresAt,
  },
};
```

- [ ] **Step 5: Run focused authentication tests and verify GREEN**

Run:

```bash
node --test --test-concurrency=1 \
  extension/tests/sync-capability-removed.test.js \
  extension/tests/sync-auth-runtime.test.js \
  extension/tests/collector-auth-flow.test.js \
  extension/tests/collector-session.test.js
```

Expected: all tests pass, including successful refresh, failed-exchange no-refresh, generation fencing, and logout recovery.

- [ ] **Step 6: Commit the source fix**

```bash
git add extension/background/service-worker.js extension/tests/sync-capability-removed.test.js
git commit -m "fix(extension): refresh Ozon pages after Web auth"
```

### Task 2: Repackage and verify the downloadable extension

**Files:**
- Modify mechanically: `app/public/sonli-extension-0.13.46.2/background/service-worker.js`
- Modify mechanically: `app/public/sonli-extension-0.13.46.2/tests/sync-capability-removed.test.js`
- Modify generated artifact: `app/public/sonli-extension-0.13.46.2.zip`
- Modify generated artifact when present: `app/dist/sonli-extension-0.13.46.2.zip`

**Interfaces:**
- Consumes: source extension version `0.13.46.2` and `scripts/package-extension.mjs`.
- Produces: unpacked and ZIP artifacts byte-aligned with the tested `extension/` source.

- [ ] **Step 1: Repackage through the repository script**

Run:

```bash
node scripts/package-extension.mjs
```

Expected: the script reports packaged unpacked, public ZIP, and built ZIP targets for `0.13.46.2`.

- [ ] **Step 2: Verify source, ZIP, bridge, and release contracts**

Run:

```bash
node scripts/check-extension-zip.mjs
node scripts/check-extension-zip-smoke.mjs
node scripts/check-plugin-readiness-gate.mjs
node --test --test-concurrency=1 server/tests/extension-release-contract.test.mjs
git diff --check
```

Expected: every command exits `0`; the release route and frontend download path remain aligned to `0.13.46.2`.

- [ ] **Step 3: Run the current extension regression set**

Run all active extension tests except the already documented upstream UI parity exception gate. Expected: no failures; any skip must state its configuration reason.

- [ ] **Step 4: Commit generated artifacts**

```bash
git add app/public/sonli-extension-0.13.46.2 app/public/sonli-extension-0.13.46.2.zip
git commit -m "chore(extension): package authenticated refresh fix"
```

### Task 3: Manual browser acceptance

**Files:**
- No source changes.

**Interfaces:**
- Consumes: freshly reloaded or reinstalled packaged extension, running Web app on `http://127.0.0.1:3000`, and an open Ozon buyer page.
- Produces: observed proof that the stale login panel recovers without manual Ozon refresh.

- [ ] **Step 1: Ensure local frontend and backend are healthy**

Verify `http://127.0.0.1:3000/` and `http://127.0.0.1:3001/health` both return HTTP `200`.

- [ ] **Step 2: Reload the unpacked extension once**

The installed extension must load the newly packaged source. This is a user-visible browser permission action, so request confirmation immediately before performing it or instruct the user to reload the unpacked extension manually.

- [ ] **Step 3: Verify the end-to-end behavior**

Start from a logged-out Collector state with an Ozon buyer page showing “请登录 Web”, complete Web login in the same browser profile, and verify:

- the Collector background reports `authenticated: true`;
- the open Ozon buyer page refreshes once without user action;
- the stale “请登录 Web” panel disappears and product data loading begins;
- no `seller.ozon.ru` tab reloads or closes.

- [ ] **Step 4: Record handoff details**

Report changed contracts, focused and regression test counts, browser evidence, unverified scope, reinstall requirement, rollback by reverting the two implementation commits, and confirmation that no database data changed.

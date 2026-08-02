# Login generation boundary final-fix report

Date: 2026-08-02 (Asia/Shanghai)

Final-fix base: `8af97ad7f7fffb7e8c94f0a75a5c0f2cfebc475e`

Sole finding source: `.superpowers/sdd/2026-08-02-login-generation-boundary/final-review-findings.md`

## Outcome

All four load-bearing findings were implemented in one final-fix wave with targeted RED → GREEN evidence, cross-layer regression, Web rebuild, extension repackaging, release parity/SHA/security gates, and a fresh complete repository verify.

Runtime source/test commit: `d91b154`.

Generated `0.13.46.2` artifact commit: `b8b4346`.

The complete repository verify remains **FAIL** because five environment-dependent checks did not pass. These are reported without conversion to PASS. Real Chrome acceptance remains **NOT RUN** because no fresh evidence proves the exact regenerated unpacked release was reloaded.

No database, migration, permission, Seller login, Ozon collection payload, product schema, credential storage, or 15-second Web refresh interval changed.

## Finding 1 — failed generation transition can revive the old account

### Root cause

`activateCollectorGeneration()` removed only the Collector session before writing the successor generation. If the successor write failed, the old generation marker remained active. A held old-generation exchange could then pass its final check and restore the retired session.

Matching Web logout had the same split-operation window: it removed the session and generation in separate calls. If the second call failed, the old generation remained active after its session was cleared.

### RED

Tests were changed before production code:

- held old-generation exchange plus failed successor marker write;
- matching-generation logout storage failure with a coherent pre-operation state.

Command:

```text
node --test --test-name-pattern="failed G2|matching generation logout" extension/tests/collector-session.test.js
```

RED result:

```text
tests 2; pass 0; fail 2; exit 1
```

Expected failures observed:

- activation issued `remove(session)` rather than one `remove([session, generation])` invalidation;
- matching logout completed instead of reaching the simulated combined-removal failure, proving it still used two operations.

### Change

`extension/lib/collector-session.js` now:

- keeps the existing serialized session-mutation queue;
- invalidates `sonliCollectorSession` and `sonliCollectorAuthGeneration` in one storage removal for changed-generation activation;
- writes the successor only after invalidation succeeds;
- uses the same one-call invalidation for matching Web logout;
- preserves stale logout as a zero-write `false` result.

The held exchange still captures its original generation. Its final check sees no active generation after a failed successor write and returns the stable `COLLECTOR_AUTH_GENERATION_CHANGED` error without writing a session.

### GREEN

Same command:

```text
tests 2; pass 2; fail 0; exit 0
```

Full Collector session regression after the change:

```text
node --test extension/tests/collector-session.test.js
tests 32; pass 32; fail 0; skipped 0; exit 0
```

## Finding 2 — no-receiver recovery omits collector-auth-flow

### Root cause

The trusted-Web recovery path dynamically injected `web-bridge-policy.js` followed by `sync-auth.js`. The adapter requires both `JzWebBridgePolicy` and `JzCollectorAuthFlow`; without the flow dependency it returned before registering `chrome.runtime.onMessage`. The retry still had no receiver.

The prior test only asserted a filename list and returned a fabricated successful second message. It did not execute the content scripts or prove the listener existed.

### RED

The real service-worker test was changed before service-worker source. It now:

- creates an isolated trusted-Web content-script VM;
- makes the first `collector.auth.request` fail with the standard no-receiver error;
- executes every file requested through `chrome.scripting.executeScript`;
- routes the retry through the VM's actual `chrome.runtime.onMessage` listeners;
- asserts the retry result and observable ticket-request posts.

Command:

```text
node --test --test-name-pattern="no-receiver" extension/tests/sync-capability-removed.test.js
```

RED result:

```text
tests 1; pass 0; fail 1; exit 1
```

Expected failure observed: zero runtime listeners were installed where one was required.

### Change

`extension/background/service-worker.js` now injects in the required dependency order:

1. `lib/web-bridge-policy.js`
2. `lib/collector-auth-flow.js`
3. `content/sync-auth.js`

The test executes these actual source files. No fabricated successful retry remains.

### GREEN

Same command:

```text
tests 1; pass 1; fail 0; exit 0
```

The installed listener returned the exact observable recovery response `{ ok: true, requested: true }`; installation discovery and authoritative retry each posted one bounded ticket request. One intermediate rerun reached the correct runtime behavior but exposed a cross-realm test-object equality issue; the test normalized only VM transport values and retained every listener/order/result assertion.

`extension/tests/sync-auth-runtime.test.js` and the complete service-worker suite also passed.

## Finding 3 — internal logout does not invalidate an in-flight exchange

### Root cause

The legacy internal `{ action: "logout" }` branch captured an old Collector operation snapshot and called conditional session clearing. It did not remove the persisted login-generation marker. If no session existed while an exchange was in flight, logout still returned success and the later same-generation response could pass its final fence and install a fresh session.

### RED

The service-worker integration test was added before the manager operation or route change. It:

- activates one generation through the trusted portal route;
- holds the real exchange HTTP response;
- sends internal logout and observes success;
- resolves the exchange;
- requires stable generation-changed failure, unauthenticated state, and no Seller tab reload/removal.

Command:

```text
node --test --test-name-pattern="internal logout" extension/tests/sync-capability-removed.test.js
```

RED result:

```text
tests 1; pass 0; fail 1; exit 1
```

Expected failure observed: the held exchange returned `ok: true` where the test required `ok: false`, proving logout had left the generation active.

### Change

`extension/lib/collector-session.js` adds one explicit `logoutCollectorSession()` contract. It:

- runs inside the existing serialized session-mutation queue;
- invalidates the Collector session and active generation in one storage operation;
- returns success only after storage invalidation succeeds.

`extension/background/service-worker.js` routes only the internal logout action through this operation. The existing Seller-tab ownership rule remains: Seller tabs are neither reloaded nor removed.

### GREEN

Same command:

```text
tests 1; pass 1; fail 0; exit 0
```

The resolved exchange returned `COLLECTOR_AUTH_GENERATION_CHANGED`, no sensitive value appeared in the response, and `getAuth` remained unauthenticated. One intermediate rerun exposed that the test's expected `getAuth` fixture omitted existing safe metadata; assertions were aligned to the real stable contract without weakening the authentication, account, permission, or redaction checks.

## Finding 4 — Web Crypto/factory failure keeps the old account generation

### Root cause

`createCollectorAuthGenerationController.update()` invoked the generation factory before clearing old controller state. During an account transition, a thrown `crypto.randomUUID()` left the prior account generation in memory, prevented the caller from receiving its logout generation, and prevented a clean retry for the successor.

### RED

The Web bridge test was added before controller source changed. It creates an initial generation, makes the successor factory throw during an account transition, then requires the recoverable empty transition and a later successful retry. The touched validation suite was also pinned at 15/16/128/129 characters.

Command:

```text
node --test --test-name-pattern="factory|generation IDs" app/tests/collector-auth-bridge.test.mjs
```

RED result:

```text
tests 3; pass 2; fail 1; exit 1
```

Expected failure observed: the simulated Web Crypto exception escaped from `update()`.

### Change

`app/src/collector-auth-bridge.js` now:

- captures the old logout generation;
- clears account, generation, and announcement state first;
- attempts successor creation inside the required `try/catch`;
- treats a thrown or invalid factory result as the same recoverable empty transition;
- allows the next update for the successor account to create and announce a fresh generation;
- retains same-account no-repeat behavior.

The catch does not restore the old session or generation and does not substitute account-derived or weak randomness.

### GREEN

Same command:

```text
tests 3; pass 3; fail 0; exit 0
```

Full Web bridge regression:

```text
node --test app/tests/collector-auth-bridge.test.mjs
tests 12; pass 12; fail 0; skipped 0; exit 0
```

## Files and stable contracts changed

Runtime and test commit `d91b154` changes:

```text
app/src/collector-auth-bridge.js
app/tests/collector-auth-bridge.test.mjs
docs/superpowers/plans/2026-08-02-login-generation-boundary.md
extension/background/service-worker.js
extension/lib/collector-session.js
extension/tests/collector-session.test.js
extension/tests/sync-capability-removed.test.js
extension/tests/web-bridge-policy.test.js
```

Generated artifact commit `b8b4346` changes:

```text
app/public/sonli-extension-0.13.46.2/background/service-worker.js
app/public/sonli-extension-0.13.46.2/lib/collector-session.js
app/public/sonli-extension-0.13.46.2/tests/collector-session.test.js
app/public/sonli-extension-0.13.46.2/tests/sync-capability-removed.test.js
app/public/sonli-extension-0.13.46.2/tests/web-bridge-policy.test.js
app/public/sonli-extension-0.13.46.2.zip
app/dist/sonli-extension-0.13.46.2.zip
```

No server API, database contract, account/store scope, permission, Seller login, Ozon payload, product schema, or deployment configuration changed.

## Focused automated verification

Fresh final focused commands:

```text
node --test app/tests/collector-auth-bridge.test.mjs
PASS: 12 passed, 0 failed, 0 skipped

node --test extension/tests/collector-auth-flow.test.js extension/tests/collector-session.test.js extension/tests/sync-capability-removed.test.js
PASS: 69 passed, 0 failed, 0 skipped

node extension/tests/web-bridge-policy.test.js
PASS: exit 0

node extension/tests/portal-bridge-policy.test.js
PASS: exit 0

node extension/tests/sync-auth-runtime.test.js
PASS: exit 0

node extension/popup/__tests__/popup-routing.smoke.test.js
PASS: exit 0

node --test scripts/extension-capture-only-policy.test.mjs
PASS: 4 passed, 0 failed, 0 skipped
```

Focused TAP total: **85 passed, 0 failed, 0 skipped**. Four standalone gates also exited 0.

The first full focused run after implementation exposed one obsolete static assertion that still required internal logout to call the retired snapshot-clear method. The real internal-logout race test was already GREEN. The static security gate was updated to require `logoutCollectorSession()` and the entire seven-command focused set was rerun successfully.

## Build, package, parity, SHA, and security gates

Web build:

```text
node node_modules/vite/bin/vite.js build
PASS: 4,830 modules transformed; exit 0
```

Only the pre-existing minified-chunk warning was emitted.

Packaging:

```text
node scripts/package-extension.mjs
PASS: unpacked tree and both 0.13.46.2 ZIP files regenerated; exit 0
```

Release evidence:

```text
diff -qr extension app/public/sonli-extension-0.13.46.2
PASS: no differences

node scripts/check-extension-zip.mjs
PASS: each ZIP matched all 142 source files

node scripts/check-extension-zip-smoke.mjs
PASS: both ZIP startup/runtime/security smoke paths passed

node scripts/check-plugin-readiness-gate.mjs
PASS: readiness behavior passed

node scripts/check-personal-data.mjs
PASS: personal-data and credential scan passed

node --test scripts/extension-capture-only-gates.test.mjs
PASS: 3 passed, 0 failed, 0 skipped

git diff --check
PASS: exit 0
```

Both ZIP SHA-256 values are identical:

```text
24629be6955661f9ae85e268f308ad283da18475811e9ae06f80f5eb86c91e78
```

## Complete verify

Definitive command, executed outside the filesystem sandbox so controlled headless Chrome fixtures could launch:

```text
node scripts/verify.mjs
FAIL: exit 1; 5 verification checks failed; 14 passed
```

Active test result:

```text
837 total; 832 passed; 1 failed; 4 skipped; 0 cancelled
```

The one failed active test required the missing `QH_SOURCE_EXTENSION_DIR` upstream tree for UI parity mutation coverage. The other environment failures were source parity, UI parity, and diff-contract checks blocked by that same missing directory, plus Docker Compose interpolation failing because `APP_ENCRYPTION_KEY` was not present.

Four PostgreSQL tests were explicitly skipped because PostgreSQL or the migration test database URL was not configured. No database code changed.

The complete verify is therefore recorded as **FAIL**, not PASS.

## Unverified scope

- **NOT RUN:** real Chrome reload of the exact regenerated unpacked `0.13.46.2` package.
- **NOT RUN:** live slow login, same-account relogin, account switch, repeated `重新检查`, and 15-second-idle acceptance against real accounts.
- **NOT RUN:** upstream source/UI/diff parity because `QH_SOURCE_EXTENSION_DIR` is missing.
- **FAIL:** Docker Compose interpolation because required encryption-key configuration is missing.
- **SKIP:** four PostgreSQL/migration behaviors because disposable database configuration is missing.
- Live Chrome storage-failure injection was not performed; automated storage contract tests cover the intended fail-closed state transitions.

No unverified item is described as passed.

## Regression risks and concerns

- Dynamic no-receiver recovery now performs one additional dependency injection. Automated VM execution proves ordering and listener installation, but real Chrome reload provenance remains unverified.
- Internal logout now deliberately invalidates all active Collector authentication for the extension. This is the required global logout fence; any caller that expected a held exchange to survive logout will now receive the stable generation-changed failure.
- Changed-generation activation intentionally leaves no active generation when successor storage fails. Recovery requires a later begin/recheck instead of restoring the previous account, preventing cross-account revival.
- Matching logout storage failure leaves the prior coherent state because the combined operation failed. The caller receives failure through the existing global error envelope; no exception is swallowed and no partial state is claimed.
- The existing Web large-chunk warning remains unrelated.

## Rollback and recovery

Final-fix runtime rollback order:

1. Revert the final evidence/report commit (documentation only).
2. Revert `b8b4346` to restore the previous `0.13.46.2` package bytes.
3. Revert `d91b154` to restore the previous runtime and tests.
4. Rebuild Web and repackage the extension from the restored source.

No database rollback, migration rollback, backfill, permission change, or production-data repair is required. Collector authentication can be cleared and re-established through the normal login flow.

Rollback restores all four known defects and is suitable only as an emergency operational recovery.

## Final-fix commit hashes

Material final-fix commits created before this report:

- `d91b154` — source, tests, and final-fix execution plan.
- `b8b4346` — regenerated unpacked extension and both ZIP artifacts.

The commit that records this report and the updated verification document is necessarily identified in the final handoff rather than inside its own content; embedding a commit's final SHA in that same commit would change the SHA.

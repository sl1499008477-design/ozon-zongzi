# Task 2 Report — one worker attempt identity

## Commit and baseline

- Baseline: `22d034978c282779e59b16d5663a187cdf7fe6f6`.
- Commit subject: `fix: bind collector auth to one worker attempt`.
- The final commit object hash is reported in the task handoff. A commit cannot embed its own Git object hash without changing that hash.

## Changes and resulting contract

- `extension/lib/collector-auth-coordinator.js`
  - Requires `newRequestId` and calls `requestAuth(requestId)` with one canonical coordinator-generated `collector-*` ID.
  - Keeps one in-memory `{ requestId, generationId }` lease and verifies it before `begin`, `accept`, `exchange`, `succeed`, or `fail` can mutate status or clear a watchdog.
  - Owns both timers: 2,500 ms no-ack and 31,000 ms accepted-response watchdog. The response watchdog applies the existing bounded transient retry.
  - Stale request/generation callbacks are no-ops and request IDs remain absent from persisted/public status.
- `extension/background/service-worker.js`
  - Keeps the one selected `{ requestId, tabId }` attempt, validates canonical ID plus exact sender tab for begin/accepted/failure/exchange, and clears only a terminal transition for the matching generation.
  - Rejects caller-supplied runtime request IDs before discovery; no-ID retry, login opener, startup/alarm recovery, and coordinator callbacks are the only production attempt entry points, so the coordinator always creates the ID.
  - Preserves deterministic tab selection, exact no-receiver recovery, selected-tab navigation checks, and trusted-origin enforcement.
  - Fences stale exchange before the external ticket exchange. Logout invalidates the active attempt before allowing recovery, including a deferred exchange incarnation.
- `extension/lib/collector-auth-flow.js` and `extension/content/sync-auth.js`
  - Consume one exact worker request ID and retain only a selected request, generation adoption, serialized begin/logout, and one exchange-in-flight flag.
  - Remove page-generated IDs, 1-second retry, 30-second watchdog, release messages, and ticket retry ownership.
  - Carry the same request ID through begin, accepted, failure, and exchange. Failure is terminal for the selected page invocation and does not create a retry.
- `app/src/collector-auth-bridge.js`
  - Removes `activeTicketLease`, the 30-second lease timer, release normalization, and page-level dedupe.
  - Each selected handler invocation emits accepted before requesting its ticket, uses a local abort controller, emits one closed response/failure envelope, and is fenced/aborted on uninstall.
  - The 28-second HTTP abort remains supplied by `App.jsx`; `App.jsx` required no source edit because it passed no removed timer/release API.
- `extension/lib/portal-bridge-policy.js` and `extension/lib/web-bridge-policy.js`
  - Require canonical request IDs on the exact attempt-scoped shapes. Logout remains generation-only.
  - Preserve legacy/V2 ready and accepted shapes, the public failure-code allowlist, exact-key rejection, and credential-field rejection.
- Tests cover stale failure replacement, accepted timeout rotation, two-tab single ticket issuance, exact sender/ID rejection, no page timers/releases, same-request stale-generation failure, coordinator-owned login opener, no coordinator bypass through caller IDs, and confidentiality.

No dependency, database, server, manifest, state machine, generated public extension package, or ledger was changed.

## TDD evidence

Baseline before Task 2:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collector-auth-bridge.test.mjs extension/tests/collector-auth-flow.test.js extension/tests/collector-auth-coordinator.test.js extension/tests/portal-bridge-policy.test.js extension/tests/service-worker-collector-auth.test.js extension/tests/web-bridge-policy.test.js extension/tests/collector-auth-acceptance.test.js
```

Result: 119 passed, 0 failed.

### Group 1 — stale failure and accepted timeout

RED commands:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='late failure cannot cancel the next worker attempt' extension/tests/collector-auth-coordinator.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='accepted response timeout rotates to the next tab once' extension/tests/collector-auth-coordinator.test.js
```

Results: each 0 passed, 1 failed. The late G1 failure left `WAITING_FOR_WEB` instead of the G2 `REQUESTING_TICKET` attempt; accepted had no 31-second coordinator watchdog.

GREEN command:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='late failure cannot cancel the next worker attempt|accepted response timeout rotates to the next tab once' extension/tests/collector-auth-coordinator.test.js
```

Result: 2 passed, 0 failed.

### Group 2 — one selected tab and exact worker boundary

RED commands:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='two tabs cannot issue tickets for one worker attempt' extension/tests/collector-auth-acceptance.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='worker attempt rejects a mismatched sender tab or request ID' extension/tests/service-worker-collector-auth.test.js
```

Results: each 0 passed, 1 failed. Both tabs exchanged a ticket for one attempt, and the wrong tab could begin the selected attempt.

GREEN results: the same focused tests passed 1/1 each. The acceptance assertion records one ticket request and one exchange.

### Group 3 — remove page lease/retry/release

RED focused tests:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='one worker request owns no content retry timer or page release' extension/tests/collector-auth-flow.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='processes the selected request without retaining a page lease after success' app/tests/collector-auth-bridge.test.mjs
```

Results: flow returned/created a different page-owned identity, and the bridge retained the completed lease instead of accepting the next handler invocation. Each focused behavior failed before implementation and passed after the single-request flow/bridge rewrite.

Policy RED showed missing/noncanonical IDs and obsolete release handling were still accepted. GREEN direct runs:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/portal-bridge-policy.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/web-bridge-policy.test.js
```

Result: both exited 0 with their success messages.

### Group 4 — authorized stale regression fixtures

The first direct `sync-auth-runtime` run failed at its begin envelope because the stale assertion omitted the now-required worker request ID. The first adapted `sync-capability-removed` full run exposed the unselected direct begin/exchange fixtures. After adapting only the direct contract conflicts:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test extension/tests/sync-capability-removed.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/sync-auth-runtime.test.js
```

Result: 39 passed, 0 failed; runtime script exited 0 with `sync auth runtime tests passed`.

### Group 5 — self-review recovery boundaries

Additional focused RED→GREEN checks:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='stale generation failure keeps the current generation' extension/tests/service-worker-collector-auth.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='openFrontend reuses a trusted Web tab only for the exact login path' extension/tests/sync-capability-removed.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='caller-supplied collector auth request IDs' extension/tests/service-worker-collector-auth.test.js
```

RED results respectively proved: stale G1 failure cleared the same-request G2 attempt (`exchange.ok === false`); login opener stayed `WAITING_FOR_WEB` outside coordinator ownership; a canonical caller ID still selected a tab (`requested: 1`). GREEN results: 1/1, 1/1, and 6/6 passed.

## Stale assertion update reasons

Only the directly conflicting fixtures/assertions changed in the two additionally authorized files:

- `extension/tests/sync-capability-removed.test.js`
  - Direct success, failure, enrichment, generation-fence, error-sanitization, and held-exchange fixtures now establish a legal coordinator-selected attempt before begin/exchange and reuse its exact request ID.
  - Content recovery obtains every new ID from a new coordinator attempt. Old page-created recovery IDs and missing-ID positive paths were removed; no no-ID compatibility path was added.
  - The cached-G1/current-G2 recovery first performs the existing internal logout because an authenticated coordinator cannot be bypassed by a page-created attempt.
  - Wrong request ID and wrong sender tab are explicitly asserted as `{ ok: false, error: 'PORTAL_BRIDGE_FORBIDDEN' }` before any external exchange.
  - The login opener now asserts `DISCOVERING_WEB`, proving it entered the coordinator rather than starting an unleased page request.
  - All removed-capability, origin, selected-tab navigation, page refresh, upload, storage, and secret-sanitization assertions are otherwise unchanged and pass.
- `extension/tests/sync-auth-runtime.test.js`
  - Exact begin now includes the selected request ID; accepted/failure/exchange retain that same ID.
  - Assertions for page-owned 1-second retry and 30-second watchdog were replaced by zero-page-timer and explicit later-worker-attempt boundaries.
  - Failure completes the page invocation without retry; a new request appears only after a new worker selection.
  - Origin/source/exact-key rejection, single exchange-in-flight, logout fencing, and credential-free protocol assertions remain.

## Final regression

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/collector-auth-bridge.test.mjs extension/tests/collector-auth-flow.test.js extension/tests/collector-auth-coordinator.test.js extension/tests/portal-bridge-policy.test.js extension/tests/service-worker-collector-auth.test.js extension/tests/web-bridge-policy.test.js extension/tests/collector-auth-acceptance.test.js extension/tests/sync-capability-removed.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/web-bridge-policy.test.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node extension/tests/sync-auth-runtime.test.js
```

Result before final commit: 150 passed, 0 failed; both direct scripts exited 0. `git diff --check` also passed.

## Unverified scope and risks

- No live Chrome extension, real login, real ticket endpoint, or packaged extension was exercised; tests are deterministic VM/fake-clock coverage.
- Generated packages under `app/public/sonli-extension-*` intentionally still contain the old code until Task 4 generation/parity work.
- The full unrelated repository test suite was not run; verification is the Task 2 narrow regression plus the two explicitly authorized direct regressions.
- The low-level tab selector still accepts a caller-owned ID internally, but every production entry calls it only through the coordinator. Runtime callers cannot supply/bypass the coordinator ID.
- A requested reviewer subagent could not start because all collaboration slots were occupied; the additional stale-generation, opener-ownership, caller-ID, no-ack, and diff/confidentiality checks above were completed locally.

## Rollback / recovery

This task changes source/tests only and has no schema, production data, dependency, or external side effect. Revert the final task commit reported in the handoff with:

```bash
git revert <task-2-commit-hash>
```

Generated packages need no Task 2 rollback because they were not changed.

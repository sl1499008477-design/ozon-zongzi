# Fast Observable Extension Authentication Design

## Goal

When the trusted Web application is already logged in, make the extension show an existing valid Collector session in under 0.5 seconds and complete a first authentication in approximately 1–3 seconds under the normal local baseline. The extension must visibly distinguish detection, ticket request, exchange, retry, authenticated, and action-required states.

The design fixes the observed latency without adding an authentication-attempt table, deterministic credentials, WebSocket transport, or a new secret-management contract.

## Evidence and root causes

Read-only production-shaped local evidence collected on 2026-08-16 showed:

- Collector ticket issue-to-exchange intervals between 5.937 and 18.909 seconds.
- The blocking audit persistence after ticket creation alone varied from 0.179 to 10.456 seconds.
- The Web bridge retried once per second while the ticket request was still running, creating multiple unused tickets.
- A Web page reload generated a new authentication generation. `activateCollectorGeneration` cleared the existing Collector session whenever that generation changed, even when the Web account was unchanged and the Collector session remained valid.
- The popup read authentication only on initialization and after manual recheck, so it could not display intermediate progress.

The five-second exchange timeout exposed these delays but was not their primary cause. Reducing the timeout further would make authentication less reliable.

## Confirmed user experience

- An existing valid session for the same Web account is reused without another ticket exchange.
- Opening the popup immediately shows the current authentication phase.
- Web login automatically starts authentication; the user does not need to click “重新检查”.
- Closing the popup does not cancel an in-flight exchange.
- Reopening the popup restores the latest phase.
- Temporary network or service failures display “自动重试中” instead of the generic “未登录”.
- Only deterministic conditions such as Web logout, account disablement, permission rejection, invalid trusted origin, or unsupported server contract require action.
- The manual recheck action remains available as an immediate retry but joins the existing single-flight operation.

## Selected architecture

Authentication remains split across three existing owners:

1. **Trusted Web bridge** confirms the logged-in account, acknowledges extension requests immediately, and requests a one-time ticket exactly once per active request.
2. **Extension authentication coordinator** owns the progress state, single-flight operation, retry schedule, generation binding, and Collector session.
3. **Collector authentication service** issues and exchanges tickets, writes a focused audit event, and keeps only the newest active session for the same account and extension device.

The popup is only a live projection. It does not own authentication truth, network requests, or retry timers.

## Fast path: reuse a valid session

The existing `collector.auth.ready` message keeps its exact legacy shape. During the compatibility window, the Web bridge first posts a new versioned ready message and then the existing legacy message:

```js
{
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.ready.v2",
  generationId: "<generation>",
  accountId: "<logged-in account>"
}
```

The new extension accepts the closed V2 shape and ignores the following legacy duplicate for the same generation. Extension `0.13.46.3` ignores the unknown V2 action and continues to consume the unchanged legacy ready message. The service worker continues to enforce the trusted sender URL and exact message shape. `accountId` is a reuse hint, not an authorization credential.

When a new Web generation arrives, the session manager atomically compares it with the stored Collector session:

- If the stored session is valid and its account ID matches, preserve the session and bind the new generation to it.
- If the account differs, the session is invalid, or the session is expired, clear it and start authentication.
- Web logout, account change, parent-session rejection, or a later Collector 401 clears the matching generation and session.
- A late message from an older generation cannot replace or clear a newer binding.

This removes unnecessary ticket issuance after a same-account page refresh or popup reopen. It does not weaken backend authorization: every Collector API call still validates the Collector token, account, parent Web session, expiry, and required permission.

## Single ticket request with immediate acknowledgement

The Web bridge adds an acknowledgement message:

```js
{
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.accepted",
  requestId: "<active request>",
  generationId: "<current generation>"
}
```

After validating the request, logged-in state, generation, and trusted origin, the Web bridge posts `accepted` before awaiting `/extension/collector-auth/ticket`. The extension cancels its one-second discovery retry for that request and starts a 30-second ticket-response watchdog.

Only one Web ticket promise may exist for the active request. Duplicate request messages with the same request ID join that promise. A different request ID is ignored while the accepted request remains inside its 30-second lease. When that lease expires, a newer request supersedes it; the late result from the older request is discarded by request and generation identity. This permits recovery from a truly hung Web request without recreating the current one-second ticket storm. On deterministic Web-auth failure the bridge does not acknowledge; the coordinator returns to `WAITING_FOR_WEB` with a public reason.

The ticket response retains its current one-time-ticket contract. No Web bearer credential enters the extension.

## Authentication status contract

Create a focused extension authentication coordinator that stores a sanitized status projection in `chrome.storage.session` under a separate key from credentials:

```js
{
  version: 1,
  phase,
  generationId,
  startedAt,
  updatedAt,
  attemptNumber,
  nextRetryAt,
  publicCode,
  account,
  expiresAt
}
```

Allowed phases and popup copy are:

| Phase | Popup copy |
| --- | --- |
| `WAITING_FOR_WEB` | 等待 Web 端登录 |
| `DISCOVERING_WEB` | 正在检测 Web 登录状态 |
| `REQUESTING_TICKET` | 正在获取登录授权 |
| `EXCHANGING` | 正在连接采集服务 · 已等待 N 秒 |
| `RETRY_WAIT` | 连接暂时不稳定，将在 N 秒后自动重试 |
| `AUTHENTICATED` | 已登录 · account.displayName |
| `ACTION_REQUIRED` | 固定、可执行的恢复说明 |

`publicCode` is empty or one of `WEB_LOGIN_REQUIRED`, `WEB_TAB_UNAVAILABLE`, `LOCAL_SERVICE_UNAVAILABLE`, `ACCOUNT_DISABLED`, `ACCOUNT_EXPIRED`, `PERMISSION_DENIED`, `TRUST_BOUNDARY_REJECTED`, or `SERVER_UPGRADE_REQUIRED`.

Tickets, Collector tokens, authorization headers, hashes, raw server messages, and stack traces are excluded from the status contract. The popup requests one snapshot on open and subscribes through `chrome.storage.onChanged` for the `session` area. It never reads the credential key.

## Exchange and retry behavior

- The exchange transport deadline becomes 60 seconds. This is a safety boundary, not expected user-visible latency.
- Ticket acknowledgement has a 30-second response watchdog aligned with the Web bridge's accepted-request lease.
- The coordinator keeps one authentication operation per active generation.
- A transient timeout or network error changes the phase to `RETRY_WAIT`; it does not render “未登录”.
- Retry delays are approximately 1, 2, 5, 10, and then at most 30 seconds with jitter.
- A retry requests a fresh one-time ticket for the same current generation.
- Repeated popup actions, ready messages, and timers join the same single-flight operation.
- Closing the popup has no effect on the coordinator. Service-worker work is kept alive by the active message promise, and scheduled retries use the existing `alarms` permission.
- On service-worker startup the coordinator reads the sanitized state and credential state. It resumes a due retry or projects the valid stored session immediately.

If an exchange response is lost after the server creates a session, the next fresh-ticket exchange creates the reachable session. On that successful exchange, the server revokes older active Collector sessions for the same account and device fingerprint with a stable superseded reason. Other devices and browser profiles are not affected.

This provides practical recovery and bounded cleanup without promising exactly-once delivery under arbitrary permanent response loss.

## Fast audit persistence

Collector ticket and session rows already use focused PostgreSQL tables, but their audit callback currently loads, protects, mirrors, and saves the entire legacy state before returning the HTTP response.

In PostgreSQL mode, Collector authentication audits must use the existing `insertPostgresAuditEvent` focused insert. The request awaits that single durable insert, preserving traceability without rewriting the full state document. A compatibility mirror into legacy in-memory/JSON state may run after the response as best-effort projection, but the relational audit row is authoritative.

In JSON-only mode, the existing serialized state audit remains the compatible fallback. No audit is dropped silently: focused audit failure remains observable through a sanitized server error metric, while authentication business behavior retains the current policy that an unavailable audit sink does not expose secrets or corrupt the session transaction.

Audit events continue to record account boundary, public entity ID, action, outcome, timestamp, extension version, and duration. They never contain ticket, Collector token, parent-session token, authorization header, or device fingerprint plaintext.

## Server session cleanup

No new table or migration is required. The existing `collector_sessions.device_fingerprint`, `account_id`, `revoked_at`, and `revoked_reason` columns are sufficient.

When a new Collector session is created, the PostgreSQL repository transaction revokes older active sessions with the same account ID and device fingerprint before returning the new session. The new session itself is excluded by ID. The update is account-scoped and cannot affect another device.

JSON fallback applies the same rule to its in-memory session collection before persistence. Repeated cleanup is idempotent.

## Security and account boundaries

- The service worker continues to validate the trusted frontend origin and portal route.
- Public account ID is used only to decide whether an existing local session may be reused; it never grants access.
- Collector API authorization remains backend-enforced on every request.
- Web logout, account switch, account disablement, expiry, permission failure, and parent-session revocation invalidate reuse.
- Credentials stay in `chrome.storage.session`; ordinary local storage contains no Web or Collector credential.
- Retry is single-flight and account-scoped.
- All UI and audit diagnostics use closed sanitized codes.

## Affected files and contracts

Expected implementation scope:

- `app/src/collector-auth-bridge.js` and tests: versioned account-aware ready contract, unchanged legacy ready emission, accepted-request lease, and immediate acknowledgement.
- `app/src/App.jsx`: supply the authenticated account ID to the bridge lifecycle.
- `extension/lib/web-bridge-policy.js` and tests: separate closed normalization for legacy ready, V2 account-aware ready, and accepted messages.
- `extension/content/sync-auth.js`: forward accepted messages and preserve the existing trusted-window boundary.
- `extension/lib/collector-auth-flow.js` and tests: acknowledgement-aware single-flight transitions and retry watchdogs.
- A new focused extension authentication coordinator module and tests.
- `extension/lib/collector-session.js` and tests: same-account generation rebinding and 60-second exchange deadline.
- `extension/background/service-worker.js` and runtime tests: coordinator composition, popup-safe status messages, startup/alarm resume.
- `extension/popup/popup.js`, markup, styles, and runtime tests: live phase rendering.
- `server/collector-auth-runtime.mjs` and tests: focused PostgreSQL audit adapter.
- `server/collector-auth-repository.mjs`, service tests, and PostgreSQL-style repository tests: same-account/device supersession.
- `extension/manifest.json`: increment the release to `0.13.46.4`.
- Regenerate `app/public/sonli-extension-0.13.46.4` and its ZIP from `extension`.

No store, order, inventory, listing, pricing, Ozon Seller permission, database schema, or credential format changes are in scope.

## Test design

### Session reuse

- A valid stored session plus a new generation for the same account preserves the token and returns authenticated immediately.
- A different account, expired session, logout, parent-session rejection, or Collector 401 clears the session.
- Stale generation messages cannot clear or overwrite the current session.

### Bridge and single-flight behavior

- Web bridge posts `accepted` before the ticket promise resolves.
- Acknowledgement cancels one-second discovery retries.
- Duplicate requests create one ticket request.
- A missing acknowledgement remains recoverable through discovery retry.
- A 20-second ticket request remains `REQUESTING_TICKET` with visible elapsed state and produces no ticket storm.

### Popup and coordinator

- Every phase maps to exact approved Chinese copy.
- Closing and reopening the popup restores the same phase.
- Storage change events update the open popup without manual recheck.
- Popup snapshots and logs contain no credentials or secret-derived values.
- Service-worker startup and alarms resume retry safely.

### Server and audit

- PostgreSQL mode writes one focused audit row and never calls the full-state save path for Collector authentication.
- JSON mode retains the legacy audit fallback.
- New same-account/device session creation revokes older active sessions exactly once.
- Other accounts and devices remain active.
- Audit failure does not leak secrets or partially mutate the session contract.

### Packaging and regression

- Collector authentication, popup runtime, Web bridge, portal policy, manifest security, removed-sync, and packaged service-worker suites pass.
- Source-to-public directory and ZIP parity pass.
- Packaged service-worker startup and popup smoke pass.
- Vite production build and JavaScript syntax checks pass.

## Acceptance targets

Measure from the extension authentication action to popup state using the same Chrome profile and local server:

- Existing valid same-account session: `AUTHENTICATED` projected within 500 ms.
- First authentication under an idle healthy local server: target 1–3 seconds and no artificial one-second ticket duplication.
- A simulated 20-second ticket response: truthful progress throughout and exactly one ticket request.
- Temporary network failure: visible retry state within one second and eventual automatic recovery.
- Popup closure and service-worker restart: no false logged-out state and no duplicate concurrent flow.

The 1–3 second first-authentication value is a measured rollout target, not a security timeout. If it is missed, stage timing must identify Web ticket, focused audit, exchange, or local storage as the slow boundary before release.

## Rollout and rollback

Deploy the server fast-audit and session-supersession behavior before distributing extension `0.13.46.4`. Verify focused audit durability and account/device isolation against local PostgreSQL before packaging.

The old extension remains compatible because ticket and exchange response shapes and the legacy ready message are unchanged. It ignores the new V2 ready and accepted actions. The new extension consumes V2, suppresses the same-generation legacy duplicate, and keeps legacy parsing for rollback compatibility.

Rollback the extension independently to `0.13.46.3` if necessary. Server rollback restores the previous audit path and session cleanup behavior without a schema rollback. No database migration is created or removed.

## Success criteria

- Reopening the extension with a valid same-account session is effectively immediate.
- First authentication no longer waits for full-state audit persistence or creates a ticket storm.
- The popup always shows an accurate authentication phase.
- Transient failures retry without presenting a false logged-out state.
- Same-account/device orphan sessions are removed on successful recovery.
- Security, account isolation, audit traceability, and credential storage boundaries remain intact.

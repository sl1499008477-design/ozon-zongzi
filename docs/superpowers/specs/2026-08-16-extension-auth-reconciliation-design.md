# Extension Authentication Reconciliation Design

## Goal

Make Web-to-extension authentication automatic, observable, and recoverable. Once the user is logged into the trusted Web application in the same browser profile, the extension must establish its Collector session without another click. Closing the popup, restarting the Manifest V3 service worker, losing an HTTP response, or receiving a slow response must not leave the Web server and extension disagreeing about whether authentication succeeded.

The popup must show the current authentication phase instead of presenting every non-authenticated condition as “未登录”.

## Confirmed user experience

- Web login automatically starts or resumes extension authentication.
- The popup immediately changes from “未登录” to a truthful progress state.
- Closing the popup does not cancel authentication.
- Reopening the popup restores the latest phase and progress.
- A transient timeout never becomes a false logged-out result.
- Temporary failures retry automatically.
- Only deterministic conditions such as Web logout, disabled account, invalid permission, or an unavailable trusted Web page require user action.
- A normally slow local exchange should finish within 30 seconds. If it takes longer, the popup remains in a visible recovery state and continues bounded background retries rather than reverting to “未登录”.

## Current failure

The extension currently treats a five-second transport timeout as an authentication failure. Real local exchanges observed on 2026-08-16 took between 5.937 and 18.909 seconds. The server can consume the ticket and create a Collector session after the extension has already aborted its fetch. Because the extension writes its local session only after receiving the response, the server then has a valid session while the extension has none.

The popup also reads authentication once during initialization and after the manual “重新检查” action. It has no authoritative progress projection for ticket discovery, exchange, reconciliation, or retry.

## Considered approaches

### 1. Longer timeout plus popup polling

Increase the timeout to 30 seconds and periodically call `getAuth` from the popup.

This reduces failures but does not close the lost-response window. The server can still commit immediately before the client times out, producing an orphan server session and a logged-out extension. Popup polling also stops when the popup closes.

### 2. Durable background state machine plus idempotent exchange

Keep the authentication workflow in the service worker, persist a sanitized progress record in `chrome.storage.session`, and make exchange retries return the same logical Collector session. This is the selected approach because it handles slow responses, response loss, popup closure, service-worker restart, and duplicate requests without adding a persistent connection.

### 3. WebSocket push

Push authentication progress from the Web server to the extension. This adds connection lifecycle, reconnection, and local-development complexity while still requiring idempotent server reconciliation. It is not needed.

## Architecture

Authentication has three owners with explicit responsibilities:

1. **Trusted Web bridge** proves that the Web account is logged in and issues a one-time Collector ticket. It never sends the Web bearer credential to the extension.
2. **Extension authentication coordinator** owns the state machine, retry schedule, local Collector credential, and the popup-safe status projection.
3. **Collector authentication service** consumes tickets, binds an idempotency attempt, creates exactly one logical Collector session, and replays the same logical result for a valid retry.

The popup is only a projection and action surface. It must not own timers, retries, or authentication truth.

## Authentication state machine

The coordinator exposes a closed versioned status contract:

```js
{
  version: 1,
  phase,
  startedAt,
  updatedAt,
  attemptNumber,
  nextRetryAt,
  publicCode,
  account,
  expiresAt
}
```

`publicCode` is either empty or one of the closed values `WEB_LOGIN_REQUIRED`, `WEB_TAB_UNAVAILABLE`, `LOCAL_SERVICE_UNAVAILABLE`, `SERVER_UPGRADE_REQUIRED`, `ACCOUNT_DISABLED`, `ACCOUNT_EXPIRED`, `PERMISSION_DENIED`, `TRUST_BOUNDARY_REJECTED`, or `ATTEMPT_CONFLICT`. The first three are recoverable and remain in discovery or retry phases. The remaining codes enter `ACTION_REQUIRED` with fixed user-facing copy.

Allowed phases are:

| Phase | Popup copy | Meaning |
| --- | --- | --- |
| `WAITING_FOR_WEB` | 等待 Web 端登录 | No trusted logged-in Web bridge is available. |
| `DISCOVERING_WEB` | 正在检测 Web 登录状态 | The extension is locating and querying the authoritative trusted tab. |
| `REQUESTING_TICKET` | 正在获取登录授权 | A Web-authenticated ticket request is in progress. |
| `EXCHANGING` | 正在连接采集服务 · 已等待 N 秒 | The first idempotent exchange request is running. |
| `RECONCILING` | 服务器处理较慢，正在确认登录结果 | The transport result was lost or timed out; the same attempt is being reconciled. |
| `RETRY_WAIT` | 连接暂时不稳定，将在 N 秒后自动重试 | A transient error is waiting for its bounded retry time. |
| `AUTHENTICATED` | 已登录 · account.displayName | A valid local Collector session exists. |
| `ACTION_REQUIRED` | A public, specific recovery instruction | A deterministic error requires user action. |

`publicCode` uses a closed, non-sensitive vocabulary. Raw server messages, tickets, tokens, attempt secrets, hashes, stack traces, and request bodies are never exposed to the popup.

The coordinator persists the sanitized status separately from secrets. The Collector token and idempotency secret remain only in `chrome.storage.session`. The status projection may include the public account identity and expiry already returned by `getAuth`, but no credential.

## Idempotent exchange contract

The new extension creates an authentication attempt before exchanging a ticket:

- `attemptId`: a cryptographically random UUID public correlation identifier.
- `attemptSecret`: at least 256 random bits encoded as a bounded URL-safe value and held only in `chrome.storage.session` and request memory.
- `generationId`: the existing Web account generation boundary.

The exchange request extends the existing request body with a versioned optional object:

```json
{
  "ticket": "<one-time secret>",
  "deviceFingerprint": "<existing value>",
  "extensionVersion": "<manifest version>",
  "attempt": {
    "version": 1,
    "id": "<random id>",
    "secret": "<random secret>"
  }
}
```

Existing clients without `attempt` continue through the legacy exchange path during the compatibility window. The response remains backward compatible and may add only a public attempt identifier and replay marker.

The server persists only a cryptographic hash of `attemptSecret`. The Collector token is derived deterministically with HKDF/HMAC-SHA-256 material derived from the existing `APP_ENCRYPTION_KEY` under the fixed domain `collector-auth-attempt-v1`, plus the attempt ID and validated attempt secret. The database continues to store only the Collector token hash. A valid retry can therefore reproduce the same token without storing token plaintext. If the application key changes during the 10-minute reconciliation lifetime, the server returns a stable key-version conflict; the coordinator starts a fresh attempt and the new attempt supersedes any unreachable session from the old key version.

The first request and every retry use the same `attemptId`, `attemptSecret`, ticket, device fingerprint, and extension version. In one database transaction the server:

1. Locks and validates the ticket and parent Web session.
2. Creates or verifies the attempt binding.
3. Creates exactly one Collector session for the attempt.
4. Marks the attempt completed.
5. Returns the same logical session for every valid replay.

The backward-compatible response keeps the existing session fields and may add:

```json
{
  "attempt": {
    "id": "<public correlation id>",
    "replayed": false
  }
}
```

Conflicting reuse of an attempt ID, attempt secret, ticket, device fingerprint, account, or extension version fails closed with a stable public code. A ticket can bind to at most one attempt, and an attempt can bind to at most one Collector session.

This contract closes the commit/response gap: if the first response is lost after the server commits, retrying the same request returns the same credential and lets the extension finish its local write.

## Persistence and migration

Add an append-only-compatible `collector_auth_attempts` table with these logical fields:

- attempt ID and attempt-secret hash;
- ticket ID and account boundary;
- parent Web session reference;
- generation ID;
- device fingerprint and extension version binding;
- Collector session ID;
- status, creation, completion, expiry, and last-replayed timestamps.

The migration only adds the new table, indexes, and foreign keys. It does not rewrite existing tickets or sessions. Old rows and legacy clients remain valid.

Attempt rows have a 10-minute reconciliation lifetime. A bounded collector-auth cleanup operation removes expired attempts during scheduled maintenance or later issue/exchange traffic. Collector sessions keep their existing expiry and revocation behavior. Web logout, account disablement, password/security reset, or generation change revokes the Collector session and terminates the attempt according to the existing account boundary. When a fresh attempt completes for the same account and device fingerprint, any older active session owned by a superseded or unrecoverable attempt for that account and device is revoked. Sessions belonging to other browser profiles or devices are not affected.

## Retry and recovery behavior

- The initial transport deadline is 30 seconds, which covers the observed local latency without defining login truth.
- A timeout changes the phase to `RECONCILING`; it does not clear the attempt and does not report “未登录”.
- Retries use the same attempt with bounded exponential delays and jitter: approximately 1, 2, 5, 10, then at most 30 seconds.
- After two minutes of continuous transient failure, the coordinator remains automatic but moves to a degraded retry cadence. The popup continues to show the next retry instead of a terminal failure.
- If the 10-minute attempt lifetime expires, the coordinator requests a new ticket and starts a fresh attempt. Completion of that attempt revokes any unreachable older session for the same account and device.
- `ACTION_REQUIRED` is reserved for closed deterministic codes such as Web logout, account disabled/expired, permission denied, invalid trusted origin, attempt binding conflict, or a server that does not support the required idempotent contract. Local service and network outages remain recoverable retry states.
- The coordinator stores `nextRetryAt` and resumes after service-worker startup. A Chrome alarm wakes a suspended worker when necessary.
- Repeated clicks and duplicate ready messages join the current single-flight attempt. They do not start parallel exchanges.
- A newer Web generation supersedes the older attempt atomically. Late responses from the older generation cannot overwrite the current session.

## Popup behavior

On open, the popup requests one status snapshot and subscribes to the sanitized status key through `chrome.storage.onChanged` for the `session` area. It renders elapsed time from trusted timestamps and never controls retry scheduling. Secret keys are separate and are never read by the popup.

The “前往登录” action starts discovery and opens or focuses the trusted Web page immediately. While the popup remains open, every coordinator transition updates the copy and actions. If it closes, the coordinator continues. Reopening the popup displays the persisted phase without restarting the attempt.

The manual “重新检查” button is retained only as a user-triggered immediate retry. It joins the current attempt and cannot create a second attempt.

## Security and data boundaries

- Trusted frontend origin checks and portal routing remain enforced in the service worker.
- Web bearer credentials never enter extension storage or runtime messages.
- Collector tokens and attempt secrets stay in `chrome.storage.session`; neither is written to `chrome.storage.local`.
- The backend validates account, parent session, generation, ticket, device, extension version, and attempt binding.
- Retry and duplicate handling are idempotent and account-scoped.
- Logs and audit events contain only public attempt IDs, phases, durations, extension version, account boundary, and stable outcome codes.
- Tickets, attempt secrets, Collector tokens, their plaintext derivatives, authorization headers, and request bodies are redacted.
- No popup-only check is treated as an authorization boundary.

## Observability

Add sanitized audit events for attempt started, completed, replayed, superseded, action-required, and revoked. Record duration and retry count without secrets. A single correlation identifier connects ticket issue, attempt, session creation, and popup-safe error reporting.

The popup may show a copyable diagnostic ID, but not raw error details. This makes support investigation possible without exposing authentication material.

## Affected components and contracts

Expected implementation scope:

- `extension/lib/collector-auth-flow.js`: attempt-aware state transitions and single-flight behavior.
- A focused extension authentication coordinator module rather than adding more responsibilities to the service worker.
- `extension/lib/collector-session.js`: idempotent attempt persistence, exchange retry, and local session commit.
- `extension/background/service-worker.js`: message contracts, startup resume, alarm wakeup, and popup-safe projection.
- `extension/content/sync-auth.js`: forward attempt/generation requests without owning state.
- `extension/popup/popup.js` and popup markup/styles: live progress rendering and immediate retry action.
- `extension/manifest.json`: increment the extension release version; the expected next version is `0.13.46.4` so users and audits can distinguish this contract from `0.13.46.3`.
- `server/collector-auth-routes.mjs`, service, and PostgreSQL repository: backward-compatible attempt contract and atomic replay.
- A new additive PostgreSQL migration for authentication attempts.
- Packaged `app/public/sonli-extension-0.13.46.4` directory and ZIP regenerated from `extension`.

No store, order, inventory, listing, pricing, or Ozon Seller authorization contract changes are in scope.

## Test and verification design

### Extension unit and runtime tests

- A 20-second exchange remains `EXCHANGING` and eventually becomes `AUTHENTICATED`.
- A response lost after server commit enters `RECONCILING`, replays the attempt, and saves the session.
- Closing and reopening the popup restores the exact progress phase.
- Service-worker restart resumes the stored attempt and next retry.
- Duplicate clicks, ready messages, and popup retries remain single-flight.
- A stale generation response cannot overwrite a newer session.
- Transient failures never render the generic logged-out state.
- Deterministic failures render only approved public messages.
- Status projections contain no ticket, attempt secret, token, hash, or authorization value.

### Server and repository tests

- Concurrent identical exchanges create exactly one attempt and one Collector session.
- A valid replay returns the same logical session and does not duplicate side effects.
- Conflicting attempt reuse fails closed.
- Parent session revocation, account disablement, and expiry revoke or reject attempts.
- PostgreSQL transactions preserve account boundaries under concurrency.
- Legacy exchange requests remain compatible.
- Audit rows are traceable and secret-free.

### Integrated acceptance

1. Log into the Web application in the same Chrome profile.
2. Open the extension and observe progress without clicking “重新检查”.
3. Simulate an exchange slower than five seconds and confirm success.
4. Simulate a committed response being lost and confirm reconciliation succeeds.
5. Close the popup during exchange, reopen it, and confirm the phase and eventual session are preserved.
6. Restart the service worker during retry and confirm it resumes.
7. Repeat the flow and confirm only one logical attempt and one session are active.
8. Log out or switch Web accounts and confirm the old extension session cannot survive the generation boundary.

## Rollout and rollback

Deploy the additive migration and backward-compatible server support before distributing extension `0.13.46.4`. Keep the legacy request path while the previous extension version may still be installed. The new extension must detect unsupported attempt responses and show an explicit server-upgrade-required state rather than silently falling back to the non-idempotent path.

Rollback the extension independently to the previous package if necessary. The added table and optional server fields can remain unused without affecting legacy traffic. Server rollback must retain migration compatibility; removing the table is not required for functional rollback.

## Success criteria

- Web login in the same profile automatically leads to extension authentication.
- Every non-authenticated interval has an accurate visible phase.
- Slow transport, response loss, popup closure, and service-worker restart recover without another login or manual recheck.
- A logical authentication attempt creates at most one active Collector session.
- Temporary failures never appear as a false logged-out state.
- Credentials remain session-scoped and all diagnostics remain secret-free.

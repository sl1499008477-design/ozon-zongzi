# Extension Login Handoff Latency Design

## Goal

Clicking “前往登录” must open or focus the trusted Web login surface immediately. Collector-session synchronization must continue in the background with a bounded deadline and must not delay the tab-opening acknowledgement.

## Confirmed root cause

The popup waits for the `openFrontend` runtime response. The current frontend-tab opener does not return that response until it has also requested Collector authentication, optionally injected three bridge scripts, and retried the tab message. The later ticket exchange has no network deadline, while bridge discovery retries once per second up to ten times. The popup therefore presents authentication recovery time as page-opening time and cannot distinguish “page opened” from “Collector session connected”.

The local page itself is not the bottleneck: the current login page responds in about 0.02 seconds and `/api/health` in about 0.26 seconds.

## Chosen design

### Immediate open acknowledgement

`createFrontendTabOpener.open()` will finish after it has created or focused the trusted Web tab. It will schedule `requestCollectorAuth` as best-effort background work and will never await that work before returning `{ opened: true }`.

The trusted-tab rule remains unchanged: only the existing HTTPS brand host and explicit local port-3000 origins are eligible. The opener continues to avoid replacing a trusted tab URL.

### Bounded background authentication

Collector ticket exchange will use an injected timeout signal with a fixed short deadline. Timeout maps to the existing sanitized network-error boundary and must not expose the ticket. The one-time ticket, generation fencing, account ownership, permissions, and two-attempt expired-ticket rule remain unchanged.

### Honest popup status

After the open acknowledgement, the popup will show that the login page has opened instead of implying that authentication has already completed. Authentication remains observable through the existing “重新检查登录状态” action and through reopening the popup. No Web password or bearer credential enters extension storage or messages.

## Alternatives rejected

- Removing Collector authentication recovery from the login action entirely would make already-authenticated Web tabs require an unnecessary manual recheck.
- Waiting for authentication before acknowledging the opened tab preserves the current latency coupling.
- Increasing retry counts or adding arbitrary sleeps would make the symptom slower without correcting ownership of the operation.

## Acceptance criteria

1. Opening or focusing the Web login tab resolves before a held `requestCollectorAuth` promise settles.
2. A missing receiver on a reused tab may trigger ordered best-effort script injection, but it cannot block the open result.
3. Ticket exchange aborts at its configured deadline and returns a redacted stable error.
4. The popup reports “Web 登录页已打开” after the open acknowledgement and does not claim that the Collector session is connected.
5. Existing generation fencing, ticket expiry retry, account scoping, trusted origins, and session-only token storage remain green.
6. No database migration, login attempt, external write, or credential inspection is required for verification.

## Rollback

Revert the implementation commit. No database or persisted-contract rollback is required.

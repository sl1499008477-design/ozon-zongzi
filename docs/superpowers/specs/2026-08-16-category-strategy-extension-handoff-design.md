# Category Strategy Extension Handoff Design

## Goal

Clicking “开始配置” or “继续选样” must establish one authenticated category-strategy sampling session and open the exact Ozon category page in the browser that owns the extension. A first-time handoff must not deadlock while the backend waits for extension readiness.

## Confirmed root cause

The administrator page currently requests a sampling session before the extension announces readiness. The backend intentionally rejects that request until it has observed a same-account extension heartbeat within five minutes. The extension currently sends that heartbeat only after an Ozon page containing the new session identifier has opened, while the frontend opens that page only after session creation succeeds. This creates a closed dependency cycle.

The current failure is therefore not caused by category `88265327`, type `95402`, popup blocking, AI, or product evidence. The draft remains recoverable, no sampling session is written, and no Ozon write occurs.

## Chosen approach

Extend the existing same-origin frontend-to-extension bridge with two closed commands:

1. `category-strategy.readiness.request` asks the authenticated extension background worker to call the existing readiness endpoint.
2. `category-strategy.open.request` asks that worker to open the already validated Ozon sampling URL.

The frontend workflow becomes:

1. Ask the extension to establish same-account readiness.
2. Request the sampling session from the administrator API.
3. Ask the extension to open the returned Ozon category URL.
4. Settle the durable frontend intent only after the Ozon tab has been accepted for opening.

The backend readiness gate, five-minute TTL, permission checks, session-secret hashing, account scope, and idempotency rules remain unchanged.

## Alternatives rejected

### Persist a session before extension readiness

This would break the current fail-closed guarantee and introduce orphan session cleanup and secret-delivery recovery. It is more complex and less safe than proving the extension is reachable first.

### Remove the readiness gate

This would allow the Web application to create sessions that no authenticated extension can consume. It weakens the explicit account-bound handoff contract and is not acceptable.

### Continue using `window.open`

The automatic flow performs asynchronous requests after route navigation, so browsers can treat the eventual `window.open` as an unsolicited popup. Asking the installed extension to create the tab is deterministic and opens it in the browser that can actually run the sampling content script.

## Components and contracts

### Web application bridge

Create a focused `category-strategy-extension-bridge.js` module. It sends versioned, same-origin messages with a bounded request identifier and timeout. It exposes:

- `ready(): Promise<{ ready: true, version: string }>`
- `open(browserUrl: string): Promise<{ opened: true }>`

Responses must have exact closed shapes. Timeout, negative responses, invalid shapes, or an absent extension map to stable category-strategy client errors. No Web bearer token, collector ticket, session secret, or account identifier crosses this bridge.

### Extension portal bridge

The existing `jizhangerp-bridge.js` accepts only same-window, same-origin messages. It forwards the two new commands to the service worker and returns only the closed readiness/open result. Its ping capability advertises category-strategy handoff support.

### Extension background worker

The category-strategy sampling client gains a standalone `ready()` method that authenticates through the existing collector session and posts to `/extension/auto-listing/category-strategy/readiness` without requiring a session identifier.

The service worker accepts only exact runtime message shapes. It validates the Ozon URL through a shared projection before calling `chrome.tabs.create`. The URL must:

- use `https://www.ozon.ru`;
- have `/category/<positive numeric id>/` as its path;
- contain exactly one `zongziCategoryStrategySession` query parameter with a safe identifier;
- contain no username, password, hash, extra query parameter, or session secret.

### Sampling workflow

`startCategoryStrategySampling` owns the readiness → session → open → intent-settle order. Replacement sampling uses the same handoff primitive with its server-issued identity. Manual reopening uses only the extension bridge open command.

If readiness fails, the server is never asked to create a session. If opening fails after session creation, the durable intent remains unsettled so a retry reuses the same backend session instead of creating a duplicate.

## Error handling

- Missing, outdated, unauthenticated, or unresponsive extension: show “浏览器扩展尚未连接，请先安装或刷新扩展后重试。”
- Valid session but failed tab opening: keep the session visible and show a retryable “无法打开 Ozon 选样页，请刷新扩展后重试。” message.
- Invalid URL from any layer: fail closed without opening a tab.
- Existing active session: reuse it and issue only the open command.

## Acceptance criteria

1. A first-time automatic-listing handoff calls extension readiness before the administrator sampling-session API.
2. The backend readiness gate remains enabled and unchanged.
3. Exactly one sampling session is created or reused per durable intent.
4. The Ozon category page is opened by the extension, not by an asynchronous page popup.
5. Missing extension produces a clear local error and zero new sampling sessions.
6. The browser URL never contains a session secret and rejects hostile or non-Ozon URLs.
7. Existing selection, confirmation, cancellation, replacement, account scoping, and draft recovery behavior remains green.
8. No paid AI call, strategy publication, or Ozon write is performed during verification.

## Verification

- Unit tests for Web bridge success, timeout, hostile response, and URL/open failure.
- Extension tests for standalone readiness, strict bridge messages, URL projection, and tab opening.
- Bootstrap tests proving readiness precedes session creation, open follows it, and open failure preserves the durable intent.
- Existing category-strategy app, service, route, extension, security-contract, and browser-contract suites.
- Frontend production build and syntax checks.
- Browser acceptance against the local page, with real Ozon selection only when the extension is connected; otherwise verify the explicit fail-closed state and report that live external step as unverified.

## Rollback

Revert the implementation commit. The backend schema and persisted contract are unchanged, so no database rollback or data migration is required.

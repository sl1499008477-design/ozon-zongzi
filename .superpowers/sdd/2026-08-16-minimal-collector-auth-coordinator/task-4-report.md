# Task 4 Report — Neutral popup authority gate and package

## Outcome

- The popup now stays neutral after an authenticated status projection until privileged `getAuth` confirms the same account ID and expiry for the current activation.
- Pending confirmation stops Seller polling, hides the main shell and count badges, and displays `正在确认登录状态`.
- Unauthenticated, account-mismatched, expiry-mismatched, and stale responses cannot expose the prior account UI or mutate a newer activation.
- The extension version remains `0.13.46.4`; no API, schema, service, dependency, or public status-contract changes were made.

## TDD evidence

- RED: popup runtime plus routing smoke ran 22 tests; 17 passed and 5 failed for the expected premature-main-view behavior. The failures covered pending confirmation, prior-account UI, unauthenticated authority, account mismatch, and expiry mismatch.
- A second narrow RED proved the post-confirmation copy still remained `正在确认登录状态` instead of `采集会话已连接`.
- GREEN: popup runtime plus routing smoke passed 22/22.

## Changed files and contracts

- `extension/popup/popup.js`: moved `setLoginState(true)` behind the exact account/expiry/current-activation authority check; added neutral teardown before `fetchAuth`; restored connected copy only after confirmation.
- `extension/popup/__tests__/popup-collector-session.runtime.test.js`: added executable pending, prior-UI, denial, mismatch, expiry, and stale-response coverage.
- `app/public/sonli-extension-0.13.46.4/` and `app/public/sonli-extension-0.13.46.4.zip`: regenerated from the final `extension/` tree, including the previously completed authentication tasks.

## Focused verification

- Exact authentication regression: 270/270 passed.
- Direct Web bridge policy script: passed.
- Direct portal bridge policy script: passed.
- Direct sync-auth runtime script: passed.
- Web app production build: passed. Vite retained its existing large-chunk warning; build output completed successfully.
- Extension package generation: passed for directory and ZIP.
- Source parity against `/Users/songliang/Desktop/0.13.46.1`: passed.
- UI parity against `/Users/songliang/Desktop/0.13.46.1`: passed.
- ZIP parity: passed; 81 files matched the production extension tree.
- ZIP smoke: passed, including 63 Collector-session tests, 39 service-worker/package tests, 21 popup runtime tests, and the packaged smoke scripts.
- Personal-data and credential scan: passed.
- Source and packaged popup syntax checks: passed.
- `git diff --check`: passed.

## Not verified

- Live Chrome extension installation and interaction.
- Real Web login, live network behavior, production/external APIs, production data, and live PostgreSQL scheduling.
- Full-repository verification was intentionally not run, per the approved minimal-verification scope.

## Rollback

- Revert this task's local commit and reinstall the prior `0.13.46.4` package. No database or configuration rollback is required.

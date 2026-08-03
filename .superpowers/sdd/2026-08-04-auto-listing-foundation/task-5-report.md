# Task 5 Report — Safe Auto-listing Foundation Routes

## Scope

Changed only the Task 5-owned files:

- `server/permissions.mjs`
- `server/runtime-config.mjs`
- `server/auto-listing-runtime.mjs`
- `server/auto-listing-routes.mjs`
- `server/index.mjs`
- `server/tests/auto-listing-routes.test.mjs`
- `server/tests/module-boundaries.test.mjs`

No Task 1–4 domain, snapshot, repository, service, migration, external gateway, or UI code changed.

## TDD evidence

- Initial RED: after adding the Task 5 route tests, the focused command failed with `ERR_MODULE_NOT_FOUND` for `server/auto-listing-runtime.mjs`, proving the new route/runtime behavior was absent. A prior test-file syntax typo was corrected before recording that meaningful RED failure.
- Additional REDs were recorded before their respective minimal fixes: disabled unsupported methods returned `503` rather than `405`; invalid POST input or encoded job IDs initialized the runtime; malformed JSON became a generic `500`; and `AUTO_LISTING_CONFIG_INVALID` was incorrectly mapped to a generic `500`.
- GREEN: `server/tests/auto-listing-routes.test.mjs` and `server/tests/module-boundaries.test.mjs` passed with **13 tests passed, 0 failed**.
- Foundation regression: the complete always-on Task 1–5 foundation command passed with **79 tests passed, 0 failed**.
- Task 2–4/store regression passed with **12 tests passed, 0 failed**; `listing-pipeline-v3.integration.mjs` completed its intentional PostgreSQL-not-configured skip path.
- `AUTO_LISTING_POSTGRES_TESTS=1` integration command passed its always-on barrier test and correctly skipped the dedicated database fixture because `SONLI_MIGRATION_TEST_DATABASE_URL` is absent. No production database fallback was used.
- `git diff --check` passed.

## Contracts and safety evidence

- `AUTO_LISTING_ENABLED` is opt-in: only normalized `1` or `true` enable it; all other values, including absence, are disabled.
- Matching routes authenticate before revealing feature state. Disabled, authenticated requests return `503 AUTO_LISTING_DISABLED` and never initialize the runtime or PostgreSQL. Unsupported matching methods return `405` after authentication.
- Create input allows exactly `collectItemIds`, `idempotencyKey`, `config`, and `correlationId`; client account/actor/owner scope and recursively supplied sensitive fields are rejected. The route injects the server-authenticated actor only.
- List and detail pass actor scope directly to the Task 4 service. Route DTOs are allowlisted scalars only and discard account records, event history, raw payloads, credentials, keys, and other unknown persistence fields.
- Unknown failures become `500 AUTO_LISTING_INTERNAL_ERROR` with a fixed safe message. Known foundation/config failures retain only approved public codes and fixed safe messages.
- The runtime owns lazy PostgreSQL repository/service composition, shares one successful initialization among concurrent callers, and clears failed initialization for retry.
- `AI_CONTENT_MANAGE` is `ai-content.manage` and available to admins only. Ordinary job access remains governed by the service's `TENANT_OPERATE` check.
- `server/index.mjs` adds only imports, one composition, and one dispatch before the broad JSON state transaction. The runtime route module contains no SQL, repository, AI, or Ozon implementation imports.

## Unverified range, risk, rollback

- Live HTTP server authentication and route dispatch were not exercised against a running server or a dedicated PostgreSQL database. The dedicated PostgreSQL fixture remains skipped until `SONLI_MIGRATION_TEST_DATABASE_URL` is provided.
- This foundation has no AI/Ozon invocation and is disabled by default. The remaining operational risk is limited to enabling the feature before a disposable PostgreSQL integration run and production-auth smoke check.
- Rollback is configuration-first: set `AUTO_LISTING_ENABLED=0`; this prevents runtime initialization and preserves immutable migration/audit history. If code rollback is required, revert this Task 5 commit only; do not delete foundation tables or task history.

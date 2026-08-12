# Automatic Listing Source Capture Versioning — Verification Record

Date: 2026-08-12
Tested implementation SHA: `e30e29b2eba3a4286f4b68fc4d74be51d80555a6`

## Scope and acceptance status

This record covers the source-snapshot V2 identity contract, the closed source-version-conflict message, adjacent automatic-listing regressions, real PostgreSQL migrations 001–062, the application build, and static gates. The main-workspace browser acceptance is intentionally deferred to the controller after merge; no local service was restarted or changed during this verification stage.

## RED evidence

- Task 1 repository RED: 39 tests; 37 passed, 2 failed, 0 skipped. The two new assertions showed that Excel raw and Collect Box draft/raw source versions lacked `:AUTO_LISTING_SOURCE_SNAPSHOT_V2`.
- Task 1 real-PostgreSQL RFBS E2E RED: 1 test; 0 passed, 1 failed, 0 skipped. It failed at the V2 suffix assertion before job creation, so that failing CNY scenario made 0 fake-Ozon product-import calls and 0 fake-Ozon stock-write calls.
- Task 2 server/client RED: 45 tests; 42 passed, 3 failed, 0 skipped. The server matrices returned the generic failure message and the client exposed untrusted backend text for `AUTO_LISTING_SOURCE_VERSION_CONFLICT`.

## GREEN evidence

### Non-PostgreSQL regressions

Command:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  server/tests/auto-listing-source-snapshot.test.mjs \
  server/tests/auto-listing-routes.test.mjs \
  app/tests/auto-listing-config.test.mjs \
  app/tests/auto-listing-page-contract.test.mjs
```

Result: 158 tests; 158 passed, 0 failed, 0 skipped, 0 cancelled, 0 todo.

### Real PostgreSQL regressions

The disposable database was `postgres:16-alpine`, reporting PostgreSQL `16.14`. It was bound only to `127.0.0.1:62506`, used a tmpfs data directory, and Docker inspection reported `Mounts=[]`.

Command:

```bash
AUTO_LISTING_POSTGRES_TESTS=1 \
SONLI_MIGRATION_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:62506/postgres" \
DATABASE_URL="postgresql://postgres@127.0.0.1:62506/postgres" \
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-postgres.integration.mjs \
  server/tests/auto-listing-upload-postgres.integration.test.mjs \
  server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs \
  server/tests/auto-listing-store-currency-migration.integration.test.mjs
```

Result: 9 tests; 9 passed, 0 failed, **0 skipped**, 0 cancelled, 0 todo. The suites applied the real migrations through 062 and exercised the actual create repository/service, upload path, standard submission worker, and loopback fake Ozon.

Official combined GREEN count: 167 tests; 167 passed, 0 failed, 0 skipped.

### Snapshot coexistence and fake-Ozon evidence

A fresh instrumented rerun of the real-PostgreSQL RFBS E2E passed 1/1 with 0 skips and emitted the two rows for the same CNY source record:

- Historical version `draft:1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` retained snapshot hash `b33976835181a335c00e296328abe4ca06ece956b176af167d637ff1c5c3813a`.
- Suffixed version `draft:1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:AUTO_LISTING_SOURCE_SNAPSHOT_V2` had snapshot hash `7c7f8a1af909093142e32cbf70ff9d43209ec3295fc33ead7227face6738361c`.

The same CNY scenario made exactly 1 loopback fake-Ozon `/v3/product/import` call and exactly 1 loopback fake-Ozon `/v2/products/stocks` call. Temporary evidence logging was removed after capture; the implementation and test files were unchanged.

### Build and static gates

Commands:

```bash
export PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm --dir app build
node --check server/auto-listing-repository.mjs
node --check server/auto-listing-routes.mjs
node --check app/src/auto-listing-config.js
git diff --check
```

Result: the Vite production build completed after transforming 4,843 modules; all three syntax checks and `git diff --check` exited successfully. The only build warning was the existing warning that a minified chunk exceeds 500 kB.

## External side effects and data boundaries

- No real Ozon write or other real Ozon API call was made; only the loopback fake server was used.
- No paid AI worker, paid AI endpoint, or upload worker was started.
- No production database, production data, production credential, or production service was used.
- The disposable PostgreSQL container is intentionally retained for controller/final-review reuse and has no Docker volume mount.

## Recovery and forward-data rule

If rollback is required, revert the application commits `e30e29b2eba3a4286f4b68fc4d74be51d80555a6` and `269b2f74919cabaee4ab6ca8d285f8277ba4ff24` as appropriate. **Preserve all newly created immutable source snapshots, including V2-suffixed snapshots; do not delete, rewrite, or down-migrate this forward data.** Restoring the application commits later must make those snapshots reusable without data loss.

There is no schema migration in this change. The remaining acceptance item is the controller-owned browser check after merge; it must not start paid AI, upload, or real Ozon product/stock workers.

# Complete Ozon collection enrichment verification

Verification date: 2026-08-01 (Asia/Shanghai)

## Status

- Local automated release gate: **PASS**.
- Focused gate: **PASS**, with the PostgreSQL subtest explicitly skipped because PostgreSQL was not configured.
- Full repository gate: **PASS**, with two PostgreSQL subtests explicitly skipped because PostgreSQL was not configured.
- Dedicated PostgreSQL runtime validation: **NOT RUN**; no explicit disposable database URL was configured.
- Real Ozon five-observation acceptance: **BLOCKED BY PREREQUISITES**; no authenticated Web session, newly issued `collector.ozon.read` session, authenticated `seller.ozon.ru` session, or auditable confirmation that the newly packaged unpacked extension was loaded was available. No real-product success is claimed.

The complete repository verification used the managed Node v24.14.0 runtime, the configured upstream source directory `/Users/songliang/Desktop/0.13.46.1`, and command-local test-only values for required Docker Compose interpolation. No `.env` or secret file was created, and no test value is recorded here.

## Exact commit ledger

Baseline: `bbd4ea4` (`docs: plan complete Ozon collection enrichment`).

Verified feature range, in order:

1. `947d3a3f9881bb5475d22927374cc68a77daa1e7` — `feat(server): define Ozon enrichment contract`
2. `1d99208cd225f828ce1cdbe5230ff2c273e02ee0` — `fix(server): tighten Ozon enrichment gate`
3. `b43209dcee6d3f932de732cc5223102169d0738b` — `feat(server): persist account Ozon enrichment`
4. `c31447b1b1530bbe1187ed3a0a89269d944fa3d0` — `fix(server): harden Ozon enrichment persistence`
5. `3556f3c5416a0a996a0351b2086c70892a81351e` — `feat(auth): scope Ozon enrichment reads`
6. `c187685705378458187d4fcd3f97d8f9ff2807e5` — `feat(server): orchestrate Ozon collection enrichment`
7. `22772462ff9e0d94e7095bc635e12153338bd0bd` — `fix(server): harden Ozon enrichment orchestration`
8. `dab4afdb715cc1e9998606c7c79265dca076141c` — `fix(server): reject incomplete Ozon collection`
9. `3060e23aa5262c900dd9e72807ab663176bcc8da` — `fix(server): preflight Ozon collection batches`
10. `7e039e5714700c2e90430d83d6ccb05ee5b9d63a` — `feat(extension): read complete Ozon enrichment`
11. `d16c3d5e95eed962bc69e6ab504f1013add0d9e4` — `fix(extension): harden Ozon enrichment executor`
12. `1ec9576f6cafce8135820c67a25ebc24ecf83833` — `fix(extension): isolate Ozon drain leases`
13. `d6ca6ffc706bd8e7ffdf679af756d58ac14f01ca` — `feat(extension): coordinate complete data-panel collection`
14. `14ab45d468f2af484e7fa1ea83c3d9597015c69d` — `fix(extension): harden coordinated collection retries`
15. `951cf92341f9d2a6782ff08ebb2183d971a26446` — `fix(collection): trust server time and recover variant retries`
16. `ff624246ab44ba61fdbf7d7c760d766c9acd3634` — `fix(extension): retry unusable Ozon variants`
17. `f8480898ea82893843d91501f5c139c70d157253` — `fix(extension): unify product collection completeness`
18. `0e0acb33cb8e18e96c4a4862088ac55ff9246e3b` — `fix(extension): retry product variant enrichment`
19. `a7d4a7f1cecb4fb632702a134f5d1fec2153cfa6` — `fix(extension): register product collection parity`
20. `806a5db` — `fix(extension): renew failed enrichment requests`

The Task 9 delivery commit is `5bf7e03c4230c113a7ef99515932274f94f7b74d` (`test: verify complete Ozon collection enrichment`). The final retry fix was independently reviewed after that delivery commit and the packages and full repository gate were regenerated from `806a5db`.

## Exact files and artifacts

The feature range changes these source, contract, migration, test, and packaging-policy files:

```text
app/public/sonli-extension-0.13.46.1.zip
app/public/sonli-extension-0.13.46.1/background/collector-ozon-enrichment-agent.js
app/public/sonli-extension-0.13.46.1/background/collector-ozon-enrichment-client.js
app/public/sonli-extension-0.13.46.1/background/service-worker.js
app/public/sonli-extension-0.13.46.1/lib/collector-session.js
app/public/sonli-extension-0.13.46.1/lib/ozon-enrichment-contract.js
app/public/sonli-extension-0.13.46.1/manifest.json
app/public/sonli-extension-0.13.46.1/tests/collector-ozon-enrichment-client.test.js
app/public/sonli-extension-0.13.46.1/tests/collector-session.test.js
app/public/sonli-extension-0.13.46.1/tests/fleet-collect-attrs-merge.test.js
app/public/sonli-extension-0.13.46.1/tests/manifest-security-contract.test.js
app/public/sonli-extension-0.13.46.1/tests/ozon-enrichment-contract.test.js
app/public/sonli-extension-0.13.46.1/tests/sync-capability-removed.test.js
extension/background/collector-client.js
extension/background/collector-ozon-enrichment-agent.js
extension/background/collector-ozon-enrichment-client.js
extension/background/service-worker.js
extension/content/ozon-data-panel.js
extension/content/ozon-product.js
extension/content/ozon-search.js
extension/content/shared-utils.js
extension/lib/collector-session.js
extension/lib/ozon-collect-coordinator.js
extension/lib/ozon-enrichment-contract.js
extension/manifest.json
extension/tests/collector-ozon-enrichment-client.test.js
extension/tests/collector-removed.test.js
extension/tests/collector-session.test.js
extension/tests/data-panel-visual-browser.test.js
extension/tests/fixtures/data-panel-visual-browser.fixture.html
extension/tests/fleet-collect-attrs-merge.test.js
extension/tests/manifest-security-contract.test.js
extension/tests/ozon-collect-coordinator.test.js
extension/tests/ozon-enrichment-contract.test.js
extension/tests/ozon-product-complete-collection.test.js
extension/tests/ozon-search-complete-collection.test.js
extension/tests/sync-capability-removed.test.js
scripts/check-extension-source-parity.mjs
scripts/check-extension-source-parity.test.mjs
scripts/check-packaged-collector-runtime.mjs
scripts/extension-capture-only-policy.mjs
scripts/extension-capture-only-policy.test.mjs
scripts/package-extension.mjs
server/account-deletion.mjs
server/account-scoped-collection-routes.mjs
server/collection-pipeline.mjs
server/collector-auth-runtime.mjs
server/collector-auth-service.mjs
server/collector-ozon-enrichment-contract.mjs
server/collector-ozon-enrichment-repository.mjs
server/collector-ozon-enrichment-routes.mjs
server/collector-ozon-enrichment-runtime.mjs
server/collector-ozon-enrichment-service.mjs
server/db/migrations/020_collector_ozon_enrichment.sql
server/formal-persistence.mjs
server/index.mjs
server/listing-pipeline.mjs
server/postgres-state-transaction.mjs
server/tests/account-deletion-legacy-archive.test.mjs
server/tests/account-deletion-relational.test.mjs
server/tests/account-deletion.test.mjs
server/tests/account-scoped-collection.test.mjs
server/tests/collect-multivariant-ingest.test.mjs
server/tests/collection-pipeline-v4.integration.mjs
server/tests/collector-auth-runtime.test.mjs
server/tests/collector-auth-service.test.mjs
server/tests/collector-ozon-enrichment-contract.test.mjs
server/tests/collector-ozon-enrichment-migration.test.mjs
server/tests/collector-ozon-enrichment-repository.test.mjs
server/tests/collector-ozon-enrichment-routes.test.mjs
server/tests/collector-ozon-enrichment-runtime.test.mjs
server/tests/collector-ozon-enrichment-service.test.mjs
server/tests/listing-pipeline-trusted-time.test.mjs
server/tests/module-boundaries.test.mjs
server/tests/ozon-collection-completeness-gate.test.mjs
server/tests/permissions.test.mjs
server/tests/persistence-atomicity.test.mjs
```

Task 9 regenerated and commits only the following distribution/evidence scope:

```text
app/public/sonli-extension-0.13.46.1/
app/public/sonli-extension-0.13.46.1.zip
app/dist/sonli-extension-0.13.46.1.zip
docs/superpowers/verification/2026-07-31-complete-ozon-collection-enrichment.md
```

The unpacked directory contains the complete extension tree; Git records only files whose bytes changed or were added. The `app/dist` tree is normally ignored, but Task 9 explicitly retains only the named distribution ZIP, not other build output.

## Contract changes verified

### API and permission

- Collector sessions now carry exactly four least-privilege permissions, including `collector.ozon.read`; legacy three-permission sessions are denied and must be reissued.
- Five fixed authenticated enrichment routes are exposed for single, batch, next-job, result, and failure handling. Client-supplied account/store/company scope, arbitrary URLs/actions/scripts, secrets, and unknown fields fail closed.
- Single and batch requests use caller-stable request IDs; batches preserve first-seen order and allow at most 20 unique SKUs. Public waits have a 20-second deadline, complete cache entries live six hours, and negative cache entries live at most 60 seconds.
- Result data is the exact versioned Ozon v1 envelope. Category ID, package weight, length, width, and height must all be finite positive values before an Ozon collection can persist.

### Database, tenancy, and time

- Additive migration 020 creates account-scoped enrichment cache and job tables. Keys include account identity; cache/lease/job operations and account deletion retain tenant boundaries.
- Job acquisition is idempotent, account-scoped, session-owned, capped at four live owners, and terminal writes publish the job and cache atomically.
- JSON and PostgreSQL collection paths preflight all batch items before any write. Incomplete Ozon data returns ordered `missingFields`; incomplete non-Ozon data retains its existing behavior.
- PostgreSQL collection business timestamps use database `NOW()`; client capture time remains only in the raw trace payload.

### Extension runtime and packaging

- The extension uses fixed Collector routes, visible Seller capture only, strict SKU binding, deadline-aware drain leases, recursive sensitive-data rejection, and no arbitrary credentialed transport.
- Data panel, search/category, and product-page collection share the page coordinator. Prefetch never uploads; concurrent actions share work; upload success is required before success UI/edit navigation. Failed enrichment retries rotate only the enrichment task ID, while collection uploads retain the original stable request ID for idempotency.
- No Chrome permission or host permission was added. Retired sync/manual capabilities remain absent.
- Source, public unpacked, public ZIP, and dist ZIP contain the same 129 extension files with byte-equal content. The final public and dist ZIP byte hashes are checked again in the post-package gate.
- Final public/dist ZIP SHA-256: `b4ed2671518ece6aa27a29e25dffdc5b16837df4aac3628e923003af48d8613d` for each archive.

## Fresh focused verification

All focused commands used managed Node v24.14.0.

- Combined server suite: **118 total; 117 passed; 0 failed; 1 skipped**. The skipped case was `PostgreSQL collection rejects incomplete Ozon payloads before writes` and reported `PostgreSQL is not configured`.
- Extension exact-v1 contract: **6/6 passed**.
- Collector enrichment client/agent: **29/29 passed**.
- Coordinator: **23/23 passed**.
- Data-panel headless Chrome fixture: **2/2 passed**.
- Product-page headless Chrome fixture: **1/1 passed**.
- Extension focused total: **61/61 passed**, including **3/3** controlled headless Chrome cases.
- Final retry regression: coordinator tests **25/25 passed**; related server/extension cross-layer tests **207/207 passed**; product/search browser regressions **3/3 passed**. The regression verifies a failed terminal enrichment request receives a new enrichment task ID while the collection upload keeps its original idempotency ID.

## Full repository verification

`QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 node scripts/verify.mjs` completed with exit code 0 using command-local, redacted test-only Compose values.

- App production build: passed. Vite emitted a non-blocking large-chunk warning for the existing application bundle.
- Upstream source parity and public unpacked parity: passed.
- Extension UI parity and capture-only diff contract: passed.
- Public and dist ZIP parity: both matched all 129 source files.
- Public and dist packaged runtime smoke: passed, including service-worker startup, Collector session/runtime/security, popup, bridge, and dry-run guards.
- Server syntax, bridge syntax, manifest parsing, test inventory, Docker Compose interpolation, import-history filter, readiness gate, collection edit/delete contracts, store isolation, whitespace, and personal-data/credential scan: passed.
- Complete active suite: **542 total; 540 passed; 0 failed; 2 skipped**.
- Test inventory: **144 active entry files; 14 historical/manual exclusions**.
- Full verification result: `All verification checks passed.`

The two active-suite skips were PostgreSQL-backed account-scoped collection behavior and PostgreSQL incomplete-Ozon no-write behavior. They are recorded as not run, not as integration passes.

## Old-feature regression coverage

- Sync: Ozon sync idempotency/account isolation passed; retired extension sync/manual routes remained unavailable; packaged service-worker smoke passed.
- Listing: listing target scope/idempotency, trusted database time, multivariant ingest/payload isolation, collect-edit contract, and collect-delete persistence passed.
- Account isolation: account/store, cache route, Collector session, audit, privacy deletion, and same-request cross-account boundaries passed.
- Non-Ozon sources: 1688 image-search routing, batch-upload price alignment, source-neutral collection behavior, and existing import flows passed.
- Existing Ozon/UI behavior: rich content, video extraction, search MutationObserver batching, panel logistics, manifest security, popup routing, and product/page visual fixtures passed.

## PostgreSQL runtime validation

Status: **NOT RUN**.

At verification time, `SONLI_MIGRATION_TEST_DATABASE_URL`, `DATABASE_URL`, and `POSTGRES_HOST` were all absent. Therefore no migration-through-020, live lease-concurrency, two-account isolation, or account-deletion test was run against PostgreSQL. Static migration, emitted SQL, transaction-order, rollback, account-lock, and query-contract tests passed, but they are not represented as a live PostgreSQL pass.

## Real Ozon acceptance evidence

Status: **BLOCKED BY PREREQUISITES; NOT RUN**.

Required evidence was unavailable for all prerequisites:

- Web authenticated session: not confirmed.
- Newly issued Collector session containing `collector.ozon.read`: not confirmed.
- Authenticated `seller.ozon.ru` session: not confirmed.
- Newly generated unpacked extension loaded/reloaded in the test browser: not confirmed.

Accordingly, none of the five live observations was executed or claimed. There is no real SKU, Collector request ID, live timestamp series, or redacted live diagnostic to record. The unverified observations remain: prefetch without row creation; each visible button saving exactly one row; edit-page category/weight/dimensions; repeat-click dedupe; and logout changing the action to the Web-login prompt.

## Risks

- Live PostgreSQL advisory-lock, concurrency, migration, and deletion behavior remains unverified without a dedicated disposable database.
- Real Seller DOM/API response drift, Web/Collector re-authentication timing, actual collection-box upload, and real edit-page rendering remain unverified without the four live prerequisites.
- The app build retains its existing large-bundle warning; this is not introduced by the enrichment change but remains an operational performance risk.
- Migration 020 is additive. Rolling application code back while leaving its two tables in place is safe; deleting the tables during rollback would add avoidable recovery risk.

## Rollback order and recovery

Rollback in dependency order, newest fix first within each group:

1. Extension product/coordinator/client/runtime changes: `806a5db`, `a7d4a7f`, `0e0acb3`, `f848089`, `ff62424`, `951cf92`, `14ab45d`, `d6ca6ff`, `1ec9576`, `d16c3d5`, `7e039e5`.
2. Server collection gate and orchestration routes/service: `3060e23`, `dab4afd`, `2277246`, `c187685`.
3. Collector permission/authentication: `3556f3c`.
4. Persistence/runtime/contract code: `c31447b`, `b43209d`, `1d99208`, `947d3a3`.
5. Revert the Task 9 distribution/evidence commit to restore the preceding packaged bytes.

Keep the migration 020 tables in place because they are additive and harmless. After restoring the service, reissue the Collector session so it has the correct permission set, then retry the same stable request ID. A failed atomic terminal write leaves no partial cache publication; allow an expired claim to be recovered by another valid same-account Collector session. A failed queued upload remains account-owned and can be replayed after authentication is restored.

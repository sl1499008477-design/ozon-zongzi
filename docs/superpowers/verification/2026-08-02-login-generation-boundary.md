# Login generation boundary verification

Verification date: 2026-08-02 (Asia/Shanghai)

## Status

- Focused cross-layer regression: **PASS**. Seven commands exited 0; the TAP commands reported 82 passed, 0 failed, and 0 skipped, and four standalone policy/smoke gates also exited 0.
- Web production build: **PASS**. Vite transformed 4,830 modules and exited 0. The existing large-chunk warning remains.
- Extension packaging: **PASS**. The unpacked `0.13.46.2` tree and both ZIP files were regenerated.
- Source/public parity: **PASS**. `diff -qr` exited 0 with no differences.
- Public/dist ZIP equivalence: **PASS**. Both archives have SHA-256 `e3f35b078e9781cceb02551d10db5884ea01ce59ffebb652da8f489855c14e8d`; repository ZIP checks also matched all 142 source files in each archive.
- Complete repository verification: **FAIL (environment gates)**. `node scripts/verify.mjs` exited 1 with 5 failed checks. Fourteen other checks passed. The active suite reported 834 tests: 829 passed, 1 failed because the required upstream extension directory was absent, and 4 PostgreSQL tests were explicitly skipped by configuration.
- Real Chrome acceptance: **NOT RUN**. Chrome control could not access the extension-management page, so the newly generated unpacked directory could not be confirmed or reloaded. No live account result is claimed.
- Independent specification/code-quality review: **NOT RUN in Task 5**. The controlling task will perform the independent whole-branch review after this Task 5 commit.

All commands used the managed Node v24.14.0 runtime from `/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`. No secret, account identifier, ticket, token, password, or login generation value is recorded in this report.

## Baseline and change ledger

Design baseline: `c07f230` (`docs(auth): define login generation boundary`).

Task 1-4 implementation range before packaging, oldest first:

1. `f81b844` — `docs(auth): plan login generation boundary`
2. `1cf6b7e` — `fix(auth): identify Web login generations`
3. `94e5a9b` — `fix(auth): reject array bridge requests`
4. `9f62519` — `fix(auth): require plain bridge requests`
5. `c869336` — `fix(auth): fence collector sessions by generation`
6. `83cf309` — `test(auth): prove shared collector session queue`
7. `6ee7137` — `fix(auth): route generation lifecycle safely`
8. `d26ad90` — `fix(auth): harden portal generation boundary`
9. `f2f73ed` — `fix(auth): hand off repeated login generations`
10. `ef9295e` — `fix(auth): require exact collector request IDs`

Task 5 regenerates and commits only this release/evidence scope:

```text
app/public/sonli-extension-0.13.46.2/
app/public/sonli-extension-0.13.46.2.zip
app/dist/sonli-extension-0.13.46.2.zip
docs/superpowers/verification/2026-08-02-login-generation-boundary.md
```

The unpacked directory is a complete 142-file copy of `extension/`; Git records only files whose bytes changed or were added.

## Source files and contracts consumed

The implementation range changes the following source, plan, and test files before Task 5 packaging:

```text
app/src/App.jsx
app/src/collector-auth-bridge.js
app/tests/collector-auth-bridge.test.mjs
docs/superpowers/plans/2026-08-02-login-generation-boundary.md
extension/background/service-worker.js
extension/content/sync-auth.js
extension/lib/collector-auth-flow.js
extension/lib/collector-session.js
extension/lib/portal-bridge-policy.js
extension/lib/web-bridge-policy.js
extension/manifest.json
extension/tests/collector-auth-flow.test.js
extension/tests/collector-session.test.js
extension/tests/portal-bridge-policy.test.js
extension/tests/sync-auth-runtime.test.js
extension/tests/sync-capability-removed.test.js
extension/tests/web-bridge-policy.test.js
scripts/package-extension.mjs
```

Verified contract changes:

- The Web bridge owns one opaque random login generation per stable logged-in account. Login, same-page relogin, account switch, and page reload create the required new boundary; the existing 15-second same-account refresh keeps the current generation and does not republish authentication.
- `SONLI_COLLECTOR_AUTH` page messages use exact field allowlists. `ready` and `logout` carry only a valid generation; `request` carries only a bounded exact `requestId`; `response` binds the request to the captured generation and the existing one-time ticket contract. Extra fields, arrays, invalid identifiers, wrong window, and wrong origin fail closed.
- `extension/lib/collector-auth-flow.js` serializes begin/request/exchange work. Duplicate ready events are idempotent, discovery responses cannot replace a newer ready generation, only the newest pending generation proceeds after an exchange, and authoritative recheck remains bounded.
- The portal bridge exposes only exact generation-bound `collector.auth.begin`, `collector.auth.exchange`, and `collector.auth.logout` actions from trusted Web pages.
- The Collector session manager stores the current generation only in `chrome.storage.session`. Activating a new generation serially clears the old session; stale logout is a no-op; a late old-generation exchange cannot persist after a newer generation activates.
- The service worker injects the authentication-flow dependency before the content script when recovering a trusted Web tab and retries the no-receiver path once.
- No server endpoint, database table, migration, account-password rule, permission definition, Seller-login contract, Ozon collection payload, or 15-second refresh interval changed.

## Fresh focused verification

The commands and results were:

```text
node --test app/tests/collector-auth-bridge.test.mjs
PASS: 11 passed, 0 failed, 0 skipped

node --test extension/tests/collector-auth-flow.test.js extension/tests/collector-session.test.js extension/tests/sync-capability-removed.test.js
PASS: 67 passed, 0 failed, 0 skipped

node extension/tests/web-bridge-policy.test.js
PASS: exit 0; web bridge policy gate passed

node extension/tests/portal-bridge-policy.test.js
PASS: exit 0; portal bridge policy gate passed

node extension/tests/sync-auth-runtime.test.js
PASS: exit 0; sync auth runtime gate passed

node extension/popup/__tests__/popup-routing.smoke.test.js
PASS: exit 0; popup routing smoke passed

node --test scripts/extension-capture-only-policy.test.mjs
PASS: 4 passed, 0 failed, 0 skipped
```

Focused TAP total: **82 passed, 0 failed, 0 skipped**. The four standalone gates also exited 0.

## Build and packaging evidence

Run from `app/`:

```text
node node_modules/vite/bin/vite.js build
PASS: exit 0; 4,830 modules transformed; built in 6.25 seconds
```

Vite emitted its existing warning that a minified chunk exceeds 500 kB. There was no build error.

Run from the worktree root:

```text
node scripts/package-extension.mjs
PASS: exit 0; unpacked public tree and both 0.13.46.2 ZIPs regenerated
```

## Complete repository verification

Definitive run, performed outside the filesystem sandbox so the controlled headless Chrome fixtures could launch:

```text
node scripts/verify.mjs
FAIL: exit 1; 5 verification checks failed
```

Passing checks included the Web build, ZIP parity, both packaged ZIP runtime smokes, server/bridge syntax, test inventory, import-history filter, plugin readiness, collect edit/delete contracts, operating-store isolation, manifest parsing, whitespace, and personal-data/credential scan. Both ZIP smoke paths passed Collector session/runtime/security tests, popup routing, bridge, and dry-run guards.

The active test command completed and reported:

```text
834 total; 829 passed; 1 failed; 4 skipped; 0 cancelled
```

The one failure was `UI parity rejects unrelated mutations in every reviewed exception file`. It requires `QH_SOURCE_EXTENSION_DIR`; the variable was absent, so mutation coverage could not compare against an upstream extension tree. This is an environment prerequisite failure, not a login-generation assertion failure, but the complete suite is still recorded as **FAIL**, not PASS.

The four configured **SKIP** results were:

- account-scoped collection PostgreSQL behavior — PostgreSQL not configured;
- PostgreSQL collection stores public Ozon data and a linked job — PostgreSQL not configured;
- PostgreSQL v21 duplicate linked jobs upgrade deterministically through v22 — migration test database URL not configured;
- PostgreSQL Seller watermark ordering — migration test database URL not configured.

The remaining failed verification checks were environment prerequisites:

- Extension source parity: **NOT RUN**; `QH_SOURCE_EXTENSION_DIR` missing (environment blocker exit 2).
- Extension UI parity: **NOT RUN**; `QH_SOURCE_EXTENSION_DIR` missing (environment blocker exit 2).
- Extension diff contract: **NOT RUN**; `QH_SOURCE_EXTENSION_DIR` missing (environment blocker exit 2).
- Docker Compose interpolation: **NOT RUN**; the `docker` command was unavailable.

An earlier sandboxed diagnostic run was interrupted after Chrome launch was closed by the sandbox. Its cancelled tests are not used as acceptance evidence. The definitive outside-sandbox run above allowed the automated Chrome fixtures to pass and completed normally.

## Independent release consistency checks

```text
diff -qr extension app/public/sonli-extension-0.13.46.2
PASS: exit 0; no output

shasum -a 256 app/public/sonli-extension-0.13.46.2.zip app/dist/sonli-extension-0.13.46.2.zip
PASS: exit 0; both hashes e3f35b078e9781cceb02551d10db5884ea01ce59ffebb652da8f489855c14e8d

git diff --check
PASS: exit 0; no output
```

Repository ZIP verification independently reported that each archive matches all 142 files in the source extension tree.

## Old-feature regression coverage

The following unchanged behavior was exercised by the focused or active suites:

- existing Collector session expiry, permission allowlist, conditional 401/403 clearing, account-owned upload queue, request idempotency, secret redaction, and stale-session races;
- removed sync/manual Seller API capabilities, manifest security, popup routing, service-worker startup, Web tab reuse only for the exact login path, and the single no-receiver reinjection retry;
- existing autonomous Ozon enrichment, visible Seller capture, Seller context watermarking, account/store isolation, account deletion, audit redaction, listing idempotency, collection persistence, pricing, import, and Ozon category behavior;
- Web local-state refresh race protection and the existing 15-second refresh behavior;
- automated production Chrome fixtures for the data panel, product page, and search collection paths.

These automated results do not replace the live account acceptance listed below.

## Real Chrome acceptance

Status: **NOT RUN** for all five scenarios.

Chrome control was available, but its safety policy rejected access to `chrome://extensions/` and explicitly disallowed alternate or indirect workarounds. Therefore the test could not prove that Chrome had reloaded `app/public/sonli-extension-0.13.46.2`. Without that release-provenance prerequisite, executing live login or account-switch operations would not produce valid Task 5 evidence.

Not run:

1. Slow Web login beyond the old ten-second window, followed by extension recognition without Web/Seller refresh.
2. Same-page logout and same-account relogin with a new generation.
3. Account A to account B switch with A unavailable before B exchange.
4. Repeated `重新检查` while one exchange is pending, proving one exchange and eventual UI truth.
5. Remaining on the Web page beyond one 15-second local-state refresh without repeated authentication or tab opening.

No account display, account ID, password, token, ticket, or generation value was captured in this report.

## Unverified environments and risks

- Upstream extension source/UI/diff parity remains unverified until `QH_SOURCE_EXTENSION_DIR` points to the reviewed upstream extension directory. Source-to-public parity inside this repository did pass.
- Docker Compose interpolation remains unverified because Docker was unavailable.
- The four live PostgreSQL behaviors remain unverified without the corresponding disposable database configuration. No database code or migration changed in this feature.
- Live Chrome login timing, same-account relogin, account switching, repeated manual recheck, and 15-second idle behavior remain unverified until a tester can reload the exact unpacked release and use appropriate test accounts.
- The existing Vite large-chunk warning remains an application performance concern; this change did not introduce a new build failure.
- Independent whole-branch review remains pending in the controlling task.

## Rollback and recovery

The feature boundary is every commit after `c07f230` through the Task 5 packaging commit. Revert the Task 5 packaging commit first, then revert these implementation/plan commits newest to oldest:

```text
ef9295e f2f73ed d26ad90 6ee7137 83cf309 c869336 9f62519 94e5a9b 1cf6b7e f81b844
```

Regenerate the Web build and extension package from the restored source. No database migration, backfill, or production-data repair is required. Existing Collector sessions can be cleared and re-established through the prior login flow if recovery is needed.

Rollback restores the previous package bytes and the known defect in which a same-page second login may not hand off to the extension. That makes rollback an operational recovery only, not a functional resolution.

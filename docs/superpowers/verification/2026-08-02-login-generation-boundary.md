# Login generation boundary verification

Verification date: 2026-08-02 (Asia/Shanghai)

## Status

- Final-fix base: `8af97ad7f7fffb7e8c94f0a75a5c0f2cfebc475e`.
- Four load-bearing final-review findings: **ADDRESSED** by source/test commit `d91b154` and release artifact commit `b8b4346`.
- Focused cross-layer regression: **PASS**. Seven commands exited 0. The TAP commands reported **94 passed, 0 failed, 0 skipped**; four standalone policy/runtime/smoke commands also exited 0.
- Web production build: **PASS**. Vite transformed 4,830 modules and exited 0. The existing large-chunk warning remains.
- Extension packaging: **PASS**. The unpacked `0.13.46.2` tree and both ZIP files were regenerated.
- Source/public parity: **PASS**. `diff -qr` exited 0 with no differences.
- Public/dist ZIP equivalence: **PASS**. Both archives have SHA-256 `3d0f2a1774a4406f34c88deb0a60407c8fad5ded92abeb8a0f4b7d4ba29b5ab7`; the ZIP parity gate also matched all 142 source files in each archive.
- Packaged runtime/security gates: **PASS**. Both ZIP smoke paths, plugin readiness, capture-only gate mutation tests, personal-data/credential scan, and `git diff --check` exited 0.
- Complete repository verification: **FAIL (environment gates)**. `node scripts/verify.mjs` exited 1 with **5 failed checks and 14 passed checks**. The active suite reported **837 tests: 832 passed, 1 failed, 4 skipped**.
- Real Chrome acceptance: **NOT RUN**. No fresh evidence proves that Chrome reloaded the exact regenerated unpacked release, so no live login, relogin, account-switch, recheck, or 15-second-idle result is claimed.

All commands used Node v24.14.0 from `/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`. No account identifier, ticket, token, password, secret, or concrete login generation value is recorded here.

## Commit and change ledger

Design baseline: `c07f230` (`docs(auth): define login generation boundary`).

Initial implementation and packaging range, oldest first:

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
11. `8af97ad` — `chore(extension): package login generation boundary`

Final-fix wave:

1. `d91b154` — `fix(auth): fail closed across login generation transitions`
2. `b8b4346` — `chore(extension): repackage fail-closed login generations`
3. The final evidence/report commit contains this updated verification record; its SHA is supplied in the final handoff because a commit cannot embed its own final SHA.

## Final-fix contracts

The final-fix wave changes these source and test boundaries:

```text
app/src/collector-auth-bridge.js
app/tests/collector-auth-bridge.test.mjs
docs/superpowers/plans/2026-08-02-login-generation-boundary.md
extension/background/service-worker.js
extension/lib/collector-session.js
extension/tests/collector-session.test.js
extension/tests/sync-capability-removed.test.js
extension/tests/web-bridge-policy.test.js
```

Verified contracts:

- Changed-generation activation invalidates the Collector session and old generation marker in one `chrome.storage.session.remove([...])` operation before storing the successor. If the successor write fails, no generation remains active; a held old exchange fails its final check with `COLLECTOR_AUTH_GENERATION_CHANGED` and cannot restore a session.
- Matching Web logout removes the Collector session and matching generation in one storage operation. A storage failure leaves one coherent pre-logout state; a stale logout remains an idempotent zero-write no-op.
- Internal extension logout routes through one serialized session-manager operation that invalidates all three related `chrome.storage.session` keys: the Collector session, generation, and activation incarnation. An exchange that started before logout retains its captured generation, fails its final fence, and cannot re-authenticate the extension. Seller tabs remain neither reloaded nor removed.
- Trusted-Web no-receiver recovery dynamically executes dependencies in this order: `lib/web-bridge-policy.js`, `lib/collector-auth-flow.js`, `content/sync-auth.js`. The real service-worker test executes those files in an isolated content-script VM, proves one runtime listener is installed, and proves the retried `collector.auth.request` returns `{ ok: true, requested: true }`.
- A Web generation factory throw or invalid result occurs only after the old account generation has been retired in controller memory. The controller returns the recoverable empty transition with the old logout generation and performs one bounded production retry for a transient missing successor; it retries successor creation on the next account update if that bounded retry does not recover. Same-account refresh remains unannounced.
- Generation validation is pinned at 15 characters rejected, 16 accepted, 128 accepted, and 129 rejected.
- No database, migration, permission, Seller-login contract, Ozon payload, product schema, credential flow, or 15-second Web refresh interval changed.

### Current recovery-contract regression evidence

The following named tests ran in the focused commands recorded below; this is automated source/package evidence only, not real-Chrome acceptance evidence.

1. **One bounded Web retry after a transient successor-generation failure.** `retires the old account generation when its successor factory throws and retries later` proves retirement before recovery, and `retries a missing Web generation once after retiring the old bridge and cancels pending recovery on cleanup` proves the production retry is single and cleanup-bounded. Both are in `app/tests/collector-auth-bridge.test.mjs`, which passed **13/13**.
2. **Authoritative recheck discards cached content generation, discovers current Web generation, then begins/exchanges it.** `authoritative recheck rediscovers the current Web generation after authentication` and `authoritative recheck never reactivates or exchanges a stale cached generation` are in `extension/tests/collector-auth-flow.test.js`; `authoritative content recovery adopts only current Web G2 over cached G1` is in `extension/tests/sync-capability-removed.test.js`. Their combined focused command passed **77/77**.
3. **Logout clears session, generation, and incarnation; same-name G1 recovery rotates incarnation and fences an old deferred exchange.** `internal logout invalidates session generation and activation incarnation together` and `clearing and reactivating the same generation rotates its activation incarnation` are in `extension/tests/collector-session.test.js`; `same-generation reactivation fences an older exchange without locking the network request` and `authoritative same-G1 recovery fences a logout-before deferred exchange incarnation` prove the stale deferred exchange is rejected. Their combined focused command passed **77/77**.

## TDD evidence summary

Detailed per-finding RED and GREEN output is recorded in `.superpowers/sdd/2026-08-02-login-generation-boundary/final-fix-report.md`.

The four targeted RED commands failed for the intended missing behavior:

- changed-generation/matching-logout storage test: 0 passed, 2 failed;
- no-receiver real-injection test: 0 passed, 1 failed;
- internal-logout held-exchange test: 0 passed, 1 failed;
- Web generation factory/boundary tests: 2 passed, 1 failed because the factory exception escaped.

After minimal implementation, the same focused targets reported 2/2, 1/1, 1/1, and 3/3 passing respectively.

## Fresh focused regression

Commands and results:

```text
node --test app/tests/collector-auth-bridge.test.mjs
PASS: 13 passed, 0 failed, 0 skipped

node --test extension/tests/collector-auth-flow.test.js extension/tests/collector-session.test.js extension/tests/sync-capability-removed.test.js
PASS: 77 passed, 0 failed, 0 skipped

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

Focused TAP total: **94 passed, 0 failed, 0 skipped**. The four standalone commands also exited 0. This rerun specifically includes the recovery regressions for retiring an old Web generation when successor creation fails, and for keeping a held old-generation Collector exchange fail-closed after a successor storage write failure.

## Build, package, and release gates

Web build from `app/`:

```text
pnpm --dir app build
PASS: exit 0 with the prescribed Node runtime on PATH; 4,830 modules transformed; build completed in 5.60 seconds
```

Vite emitted only its existing warning that a minified chunk exceeds 500 kB.

Packaging from the worktree root:

```text
node scripts/package-extension.mjs
PASS: exit 0; unpacked public tree and both 0.13.46.2 ZIPs regenerated
```

Independent release checks:

```text
diff -qr extension app/public/sonli-extension-0.13.46.2
PASS: exit 0; no output

shasum -a 256 app/public/sonli-extension-0.13.46.2.zip app/dist/sonli-extension-0.13.46.2.zip
PASS: both hashes 3d0f2a1774a4406f34c88deb0a60407c8fad5ded92abeb8a0f4b7d4ba29b5ab7

node scripts/check-extension-zip.mjs
PASS: both ZIPs match all 142 source files

node scripts/check-extension-zip-smoke.mjs
PASS: both packaged runtime/safety smoke paths exited 0

node scripts/check-plugin-readiness-gate.mjs
PASS: service-worker behavior 27/27 and extension-page behavior 3/3

node scripts/check-personal-data.mjs
PASS: tracked personal-data and credential scan passed

node --test scripts/extension-capture-only-gates.test.mjs
PASS: 3 passed, 0 failed, 0 skipped

git diff --check
PASS: exit 0; no output
```

## Complete repository verification

The definitive run was executed outside the filesystem sandbox so controlled headless Chrome fixtures could start:

```text
node scripts/verify.mjs
FAIL: exit 1; 5 verification checks failed and 14 passed
```

The active test command completed normally:

```text
837 total; 832 passed; 1 failed; 4 skipped; 0 cancelled
```

The one failure was `UI parity rejects unrelated mutations in every reviewed exception file`. It requires `QH_SOURCE_EXTENSION_DIR`; the variable was absent, so mutation coverage could not compare against an upstream extension tree. This remains an environment prerequisite failure, not a login-generation assertion failure, but the complete suite is still **FAIL**.

The four configured **SKIP** results remain:

- account-scoped collection PostgreSQL behavior — PostgreSQL not configured;
- PostgreSQL collection stores public Ozon data and a linked job — PostgreSQL not configured;
- PostgreSQL v21 duplicate linked jobs upgrade deterministically through v22 — migration test database URL not configured;
- PostgreSQL Seller watermark ordering — migration test database URL not configured.

The remaining failed verification checks were environment prerequisites:

- Extension source parity: **NOT RUN**; `QH_SOURCE_EXTENSION_DIR` missing (environment blocker exit 2).
- Extension UI parity: **NOT RUN**; `QH_SOURCE_EXTENSION_DIR` missing (environment blocker exit 2).
- Extension diff contract: **NOT RUN**; `QH_SOURCE_EXTENSION_DIR` missing (environment blocker exit 2).
- Docker Compose interpolation: **FAIL**; Docker ran, but required `APP_ENCRYPTION_KEY` was absent from the environment.

All other verify checks passed, including Web build, ZIP parity, both packaged ZIP smoke paths, server/bridge syntax, test inventory, import-history filter, plugin readiness, collect edit/delete contracts, operating-store isolation, manifest parsing, whitespace, and personal-data/credential scan.

## Old-feature regression coverage

The focused and active suites exercised these unchanged behaviors:

- Collector expiry, permission allowlist, 401/403 conditional clearing, account-owned queues, request idempotency, secret redaction, stale-session races, and Seller-context fencing;
- exact portal/Web policies, bounded content authentication flow, authoritative recheck, popup routing, service-worker startup, trusted login-tab reuse, and one no-receiver retry;
- removed sync/manual Seller API capabilities, capture-only manifest security, autonomous Ozon enrichment, visible Seller capture, multi-account/store isolation, account deletion, audit redaction, listing idempotency, collection persistence, pricing, import, and Ozon category behavior;
- Web local-state refresh race protection and the existing 15-second refresh behavior;
- automated production headless-Chrome fixtures for data panel, product page, and search collection paths.

Automated headless-Chrome fixtures do not prove that a user Chrome profile reloaded this exact extension package.

## Real Chrome acceptance

Status: **NOT RUN** for all five scenarios.

No fresh evidence proves the exact unpacked `app/public/sonli-extension-0.13.46.2` directory was reloaded in a real Chrome extension profile. Therefore these remain unverified:

1. Slow Web login beyond the old ten-second window without Web/Seller refresh.
2. Same-page logout and same-account relogin with a new generation.
3. Account A to account B switch with A unavailable before B exchange.
4. Repeated `重新检查` while one exchange is pending.
5. Remaining on the Web page beyond a 15-second local-state refresh without repeated authentication or tab opening.

## Unverified environments and risks

- Upstream extension source/UI/diff parity remains unverified until `QH_SOURCE_EXTENSION_DIR` points to the reviewed upstream extension directory. In-repository source-to-public parity passed.
- Docker Compose interpolation remains unverified until the required encryption-key environment value is supplied. No deployment configuration changed in this wave.
- Four PostgreSQL behaviors remain unverified without disposable database configuration. No database code or migration changed.
- Real Chrome reload and live-account login timing remain unverified.
- The existing Vite large-chunk warning remains a performance concern; this wave did not introduce a build error.
- Storage failure tests prove fail-closed behavior at the extension storage contract boundary; live Chrome storage failure injection was not performed.

## Rollback and recovery

For the final-fix wave, revert the evidence/report commit first, then `b8b4346`, then `d91b154`. Regenerate Web and extension packages from the restored source. There is no database migration, backfill, permission rollback, or production-data repair.

Reverting `b8b4346` restores the previous package bytes. Reverting `d91b154` restores the four reviewed race/recovery defects, so rollback is an emergency operational recovery only. Existing Collector authentication can be cleared and re-established through the normal login flow.

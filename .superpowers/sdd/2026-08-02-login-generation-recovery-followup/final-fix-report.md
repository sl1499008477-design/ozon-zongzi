# Login generation recovery follow-up — residual final-fix report

Date: 2026-08-02 (Asia/Shanghai)

Residual-fix base: `3a24ed25253bd8441275c107ac03d62ee7af8749`

Sole fix scope: `.superpowers/sdd/2026-08-02-login-generation-recovery-followup/final-review-findings.md`

## Outcome

Both residual load-bearing findings were fixed in one RED → GREEN wave. The source, focused authentication tests, generated public mirror, public/dist ZIPs, Web build, release/security gates, and definitive complete verify were rerun.

Material commits created before this report:

- `dcae9129815790577a0129223dec15b74ef5cbd8` — source and tests.
- `d9552f37fbd0461459552c265f50c67944c2121e` — regenerated public mirror and both ZIPs.

The complete repository verify remains **FAIL**, exactly as required, because five environment-dependent checks did not pass. Real Chrome extension acceptance remains **NOT RUN**. No database, migration, account/store permission, Seller login, Ozon collection payload, product schema, collection data, credential storage, deployment configuration, or 15-second Web refresh behavior changed.

## Finding 1 — failed successor incarnation creation leaves the old activation live

### Root cause

`activateCollectorGeneration()` checked the duplicate-active fast path correctly, but for a required successor it called `createGenerationIncarnation()` before removing the old Collector session, generation, and incarnation. If the injected factory threw or returned an invalid value, the old G1 activation pair remained stored. A held G1 exchange could therefore pass its final `{ generationId, incarnation }` fence and restore an old-account session.

### Test break named before implementation

Moving or retaining incarnation creation before three-key invalidation must make the new tests fail by leaving at least the old generation/incarnation present and by allowing the held exchange to install the old account.

Tests were written before production code for:

- successor factory throw while a real G1 manager exchange is held;
- successor factory invalid return while a real G1 manager exchange is held;
- duplicate active G1 while a second factory call would throw.

Both failure cases independently require:

- activation failure with the expected error;
- session, generation, and incarnation all absent immediately after failure;
- the resolved old exchange rejected with `COLLECTOR_AUTH_GENERATION_CHANGED`;
- all three keys still absent;
- no old-account session write.

The duplicate test requires `{ changed: false }`, one total factory call, and unchanged session/generation/incarnation.

### RED — original result summary

Command:

```text
node --test --test-name-pattern='successor activation clears|duplicate active generation remains' extension/tests/collector-session.test.js
```

Original RED result:

```text
tests 3; pass 1; fail 2; skipped 0; exit 1
```

Both intended failures showed the same observable defect:

```text
actual generation: generation_G1_1234
expected: undefined
```

The duplicate-active case already passed, proving the existing same-G1 fast path was idempotent and must be preserved.

### Minimal change

`extension/lib/collector-session.js` retains the serialized session-mutation queue and duplicate-active fast path. For a required new activation it now:

1. removes `sonliCollectorSession`, `sonliCollectorAuthGeneration`, and `sonliCollectorAuthIncarnation` in one storage call;
2. invokes and validates the successor incarnation factory only after invalidation;
3. writes the successor generation/incarnation pair only after a valid incarnation exists.

Factory throw, invalid return, or a later successor write failure therefore leaves no activation live. The held exchange's existing final fence rejects it without an old-account write.

### GREEN — original result summary

Same command:

```text
tests 3; pass 3; fail 0; skipped 0; exit 0
```

## Finding 2 — authoritative recheck broadcasts to every trusted Web tab

### Root cause

The actual service-worker `requestCollectorAuth` route iterated every trusted tab returned by `chrome.tabs.query()` and sent `collector.auth.request` to each one. Every real content flow discards its cached state and discovers from its own page bridge, so two open Web tabs could begin and exchange competing generations against the same session manager.

### Test break named before implementation

Iterating more than one eligible tab, ignoring active/recency/ID ordering, or falling through after the selected tab cannot receive must make the production-route tests fail through extra tab messages, extra recovery posts, extra begin/exchange messages, or a nonzero requested count.

Tests were written before production code for:

- active tab priority over a more recently accessed inactive tab;
- greatest finite `lastAccessed` when active state ties;
- a finite `lastAccessed` outranking a non-finite value;
- lower integer tab ID as the stable final tie-break;
- selected no-receiver returning requested `0` with no fallback;
- two real content-script VMs under one real service worker/session manager, invoked through the actual runtime action.

The two-VM test snapshots both flows after their normal install discovery, invokes `requestCollectorAuth`, and requires only the selected VM to emit a new discovery. It then supplies that VM's Web response and requires only its G2 begin/exchange and one external exchange request; the unselected VM emits neither recovery nor runtime begin/exchange.

### RED — original result summary

Command:

```text
node --test --test-name-pattern='requestCollectorAuth chooses|requestCollectorAuth does not fall through|production requestCollectorAuth routes' extension/tests/sync-capability-removed.test.js
```

Original RED result:

```text
tests 7; pass 0; fail 7; skipped 0; exit 1
```

Expected failures observed:

- all four ordering cases and the two-real-VM route returned `requested: 2` instead of `1`;
- the selected no-receiver case fell through and returned `requested: 1` instead of `0`.

### Minimal change

`extension/background/service-worker.js` keeps the existing `TRUSTED_FRONTEND_TAB_URLS` query and selects one integer-ID result in this exact order:

1. `active === true` first;
2. greatest finite `lastAccessed`;
3. lower integer tab ID as the stable final tie-break.

The route sends one message to that tab only. It returns requested `1` only when the real content flow responds with both `ok: true` and `requested: true`; no eligible tab, a missing receiver, another send failure, or a non-started flow returns requested `0`. It never falls through within the same recheck.

The separate `openFrontend('/login')` helper was not changed. Its reused-tab no-receiver behavior still injects `lib/web-bridge-policy.js`, `lib/collector-auth-flow.js`, and `content/sync-auth.js` in order, then retries exactly once.

### GREEN — original result summary

Same command:

```text
tests 7; pass 7; fail 0; skipped 0; exit 0
```

## Files and contracts

Source/test commit `dcae9129815790577a0129223dec15b74ef5cbd8` changes:

```text
extension/background/service-worker.js
extension/lib/collector-session.js
extension/tests/collector-session.test.js
extension/tests/sync-capability-removed.test.js
```

Generated artifact commit `d9552f37fbd0461459552c265f50c67944c2121e` changes only generated equivalents and archives:

```text
app/public/sonli-extension-0.13.46.2/background/service-worker.js
app/public/sonli-extension-0.13.46.2/lib/collector-session.js
app/public/sonli-extension-0.13.46.2/tests/collector-session.test.js
app/public/sonli-extension-0.13.46.2/tests/sync-capability-removed.test.js
app/public/sonli-extension-0.13.46.2.zip
app/dist/sonli-extension-0.13.46.2.zip
```

Stable contracts preserved:

- Collector authentication remains account-scoped and serialized.
- Session/generation/incarnation remain `chrome.storage.session` state; no secret moves to local storage or logs.
- Duplicate active same-generation begin remains an idempotent no-op.
- Generation/incarnation validation and stable error codes are unchanged.
- `requestCollectorAuth` keeps the response envelope `{ ok: true, data: { requested: 0 | 1 } }`.
- Trusted production/local Web URL allowlists are unchanged.
- `openFrontend('/login')` remains the only path with no-receiver script injection and one retry.
- No database, API, Seller, Ozon data, permissions, tenant-boundary, or deployment contract changed.

Documentation/evidence changed after the material commits:

```text
docs/superpowers/verification/2026-08-02-login-generation-boundary.md
.superpowers/sdd/2026-08-02-login-generation-recovery-followup/final-fix-report.md
```

## Focused authentication verification

Fresh source-focused commands:

```text
node --test app/tests/collector-auth-bridge.test.mjs
PASS: 13 passed, 0 failed, 0 skipped

node --test extension/tests/collector-auth-flow.test.js extension/tests/collector-session.test.js extension/tests/frontend-tab-opener.test.js extension/tests/sync-capability-removed.test.js
PASS: 93 passed, 0 failed, 0 skipped

node extension/tests/web-bridge-policy.test.js
PASS: exit 0

node extension/tests/portal-bridge-policy.test.js
PASS: exit 0

node extension/tests/sync-auth-runtime.test.js
PASS: exit 0

node extension/popup/__tests__/popup-routing.smoke.test.js
PASS: exit 0

node --test scripts/extension-capture-only-policy.test.mjs
PASS: 4 passed, 0 failed, 0 skipped

node --check extension/lib/collector-session.js
node --check extension/background/service-worker.js
PASS: both exit 0
```

Focused TAP total: **110 passed, 0 failed, 0 skipped**. Four standalone policy/runtime/smoke commands and both source syntax checks also exited 0.

This set includes the real two-content-VM production route, trusted URL query, `openFrontend('/login')` injection/retry, cached-generation rediscovery, held-exchange fencing, internal logout, Web lifecycle retry, popup login routing, and capture-only security policy.

## Build, packaging, parity, ZIP, smoke, readiness, and security gates

Packaging from source:

```text
node scripts/package-extension.mjs
PASS: unpacked public mirror and both 0.13.46.2 ZIPs regenerated; exit 0
```

Web build:

```text
node node_modules/vite/bin/vite.js build
PASS: project-locked Vite 6.4.2 transformed 4,830 modules; exit 0; 4.59 seconds
```

The initial `pnpm --dir app build` wrapper attempt failed before Vite execution because its child command PATH could not locate `node`. The successful direct command used the prescribed Node 24.14.0 binary, and the definitive complete verify independently rebuilt the app successfully. The existing large-chunk warning remains.

Release gates:

```text
diff -qr extension app/public/sonli-extension-0.13.46.2
PASS: no differences

shasum -a 256 app/public/sonli-extension-0.13.46.2.zip app/dist/sonli-extension-0.13.46.2.zip
PASS: identical hashes

node scripts/check-extension-zip.mjs
PASS: both ZIPs match all 142 source files

node scripts/check-extension-zip-smoke.mjs
PASS: both packaged runtime/safety smoke paths

node scripts/check-plugin-readiness-gate.mjs
PASS: service-worker behavior 34/34; extension-page behavior 3/3

node scripts/check-personal-data.mjs
PASS: tracked personal-data and credential scan

node --test scripts/extension-capture-only-gates.test.mjs
PASS: 3 passed, 0 failed, 0 skipped

git diff --check
PASS: exit 0
```

Both ZIP SHA-256 values:

```text
308405e846b1a1fef8b409e1137347193c18be03646cf9880bdd22b221a8b9c6
```

## Complete verify

The initial sandboxed attempt could not launch controlled headless Chrome, left later test promises pending, and was interrupted with exit 130. It is not used as completion evidence.

The definitive command was rerun outside the filesystem sandbox so the repository's controlled headless Chrome fixtures could launch:

```text
node scripts/verify.mjs
FAIL: exit 1; 5 verification checks failed; 14 passed
```

Active suite result:

```text
856 total; 851 passed; 1 failed; 4 skipped; 0 cancelled
```

The one failed active test, `UI parity rejects unrelated mutations in every reviewed exception file`, requires `QH_SOURCE_EXTENSION_DIR`. The same missing directory blocked source parity, UI parity, and diff-contract checks with environment exit 2. Docker Compose interpolation also failed because `MINIO_PORT` was absent.

Four PostgreSQL/migration tests were explicitly skipped because PostgreSQL or the migration database URL was not configured. No database code changed.

All other verify checks passed, including the Web build, ZIP parity, both ZIP smoke paths, server/bridge syntax, test inventory, import-history filter, plugin readiness, collect edit/delete contracts, operating-store isolation, manifest parsing, whitespace, and personal-data/credential scan.

The complete verify is therefore recorded as **FAIL**, not PASS.

## Unverified scope

- **NOT RUN:** real Chrome reload of the exact regenerated unpacked `0.13.46.2` extension.
- **NOT RUN:** real-account slow login, same-account relogin, account switch, repeated `重新检查`, multi-tab recheck, and 15-second-idle acceptance.
- **NOT RUN:** upstream source/UI/diff parity because `QH_SOURCE_EXTENSION_DIR` is missing.
- **FAIL:** Docker Compose interpolation because `MINIO_PORT` is missing.
- **SKIP:** four PostgreSQL/migration behaviors because disposable database configuration is missing.
- **NOT RUN:** live Chrome storage failure and incarnation-factory failure injection; the real manager/VM automated tests cover the specified fail-closed behavior.

No unverified item is described as passed.

## Regression risks and concerns

- Multiple windows can each expose an active tab. The deterministic contract resolves that case by finite `lastAccessed`, then lower tab ID; this is covered in the service-worker route tests but not a real profile.
- A selected authoritative tab with no receiver intentionally returns requested `0` without same-round fallback. A later user recheck or `openFrontend('/login')` recovery is required; this avoids concurrent activation races.
- A successor incarnation factory failure now intentionally leaves Collector authentication empty. Recovery requires a later begin/recheck instead of reviving the previous activation.
- Automated VM and headless browser fixtures do not prove that a real Chrome profile loaded the exact regenerated package.
- Upstream parity, Docker interpolation, PostgreSQL, and the existing Vite large-chunk warning remain environmental or pre-existing concerns.

## Rollback and recovery

Reverse-order rollback for the complete current recovery-follow-up range:

1. Revert the final evidence/report commit identified in the handoff.
2. Revert `d9552f3` to restore the prior generated mirror and ZIP bytes.
3. Revert `dcae912` to restore the pre-residual-review source and tests.
4. Revert `3a24ed2` (follow-up evidence).
5. Revert `b0683d6` (follow-up generated artifacts).
6. Revert `f0f9ab1` (same-generation incarnation fencing).
7. Revert `dfa8d00` (authoritative generation rediscovery).
8. Revert `67ffb5c` (bounded Web generation recovery).
9. Revert `2b458e3` (follow-up plan).
10. Rebuild Web and repackage the extension from the restored source.

No database rollback, migration rollback, backfill, permission rollback, tenant-data repair, Seller-data repair, or Ozon collection-data repair is required. Collector authentication can be cleared and re-established through the normal login flow.

Reverting `dcae912` restores both residual defects. Reverting the earlier follow-up implementation commits restores their corresponding recovery gaps, so rollback is suitable only as emergency operational recovery.

## Commit hashes

Material residual-fix commits created before this report:

- `dcae9129815790577a0129223dec15b74ef5cbd8` — source and tests.
- `d9552f37fbd0461459552c265f50c67944c2121e` — generated mirror and both ZIP artifacts.

The commit that records this report and the verification ledger is necessarily identified in the final handoff rather than embedded in its own content; embedding a commit's final SHA in that same commit would change the SHA.

# Task 3 Report — PostgreSQL locking and account invalidation

## Commit and baseline

- Baseline: `70dd849dac49b99f24de0b1d7d8d5cca3b6e090c`.
- Commit subject: `fix: enforce collector account session authority`.
- The final commit object hash is reported in the task handoff. A commit cannot embed its own Git object hash without changing that hash.

## Changes and resulting contracts

- `server/collector-auth-repository.mjs`
  - Uses PostgreSQL's two-key transaction advisory lock: `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`.
  - Passes the account ID and device fingerprint as two separate NUL-free text parameters.
  - Preserves one fixed client connection and `BEGIN → lock → INSERT → UPDATE → COMMIT`; failures still `ROLLBACK` before release, zero-row inserts do not supersede, and superseded counts remain numeric.
- `server/account-context.mjs`
  - Produces `WEB_AUTH_REQUIRED` for absent Web sessions/accounts.
  - Produces exact `COLLECTOR_ACCOUNT_DISABLED` and `COLLECTOR_ACCOUNT_EXPIRED` codes at the Web-auth source.
  - Keeps public messages free of account IDs, credentials, and raw internal errors.
- `server/collector-auth-runtime.mjs`
  - Matches the service's real `collector_account_disabled` and `collector_account_expired` authentication outcomes.
  - Revokes all Collector sessions for the event's already-authorized internal account ID with exact persisted reasons `ACCOUNT_DISABLED` or `ACCOUNT_EXPIRED`.
- `server/tests/collector-auth-service.test.mjs`
  - Enforces the two-parameter lock contract, rejects NUL-containing PostgreSQL text fixtures, retains transaction-order/rollback/zero-insert assertions, and proves same-key concurrency leaves one active session.
- `server/tests/collector-auth-runtime.test.mjs`
  - Exercises the real runtime ticket route for missing Web auth, missing account, disabled account, and expired account stable codes.
  - Proves disabled/expired authentication persists the exact revoke reason and account recovery cannot revive the old Collector token.
- `server/tests/collector-auth-routes.test.mjs`
  - Unchanged; included in the required narrow regression.

No extension source, generated package, schema, migration, dependency, ledger, or production configuration changed.

## TDD evidence

### Group 1 — NUL-free PostgreSQL lock

RED:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/collector-auth-service.test.mjs
```

Result before the repository fix: 45 passed, 2 failed. The direct contract test observed `hashtextextended($1, 0)` and the concurrent fixture rejected the account/device value containing NUL.

GREEN: the same command passed 47/47 after changing only the lock SQL and its parameters. The fixture still proves serialized same-account/device transactions leave exactly one active session with the other marked `SESSION_SUPERSEDED`.

### Group 2 — stable real-runtime Web/account codes

Focused RED:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='real runtime ticket route preserves stable Web auth and account codes' server/tests/collector-auth-runtime.test.mjs
```

Result before the source-code fix: 0 passed, 5 failed (the parent test plus four subtests). Missing Web session, missing account, disabled, and expired all returned `COLLECTOR_AUTH_FAILED` instead of their stable codes.

GREEN: the same focused command passed 5/5 after adding coded errors at `requireAuth`. The response assertions also prove account ID, Web bearer token, and generic fallback code are absent.

### Group 3 — persistent invalidation across account recovery

RED:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/collector-auth-runtime.test.mjs
```

Result before the runtime-hook fix: 11 passed, 3 failed (the parent test plus disabled and expired subtests). Both failures found `revokedAt` still empty, proving the old `collector_account_inactive` match ignored the service's actual outcomes.

GREEN: the same runtime suite passed after mapping the two actual outcomes to exact persisted reasons. Both recovery attempts reject the old token with `COLLECTOR_SESSION_REVOKED`; exposed errors contain no account ID, Web token, or Collector token.

## Final regression and review

Required command:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/collector-auth-service.test.mjs server/tests/collector-auth-runtime.test.mjs server/tests/collector-auth-routes.test.mjs
```

Fresh pre-commit result: 68 passed, 0 failed. `git diff --check` passed; `git diff --cached --check` is also run after staging and before commit.

Local review confirmed the fixed-connection transaction ordering, rollback/release path, zero-insert behavior, numeric superseded audit coverage, exact account/device boundary, exact revoke reasons, and credential-free error surfaces remain intact.

## Unverified scope and risks

- No real PostgreSQL instance was contacted, so the two-`hashtext` overload is verified at the emitted SQL/parameter contract and deterministic transaction fixture boundary, not against a live server.
- No real account, browser extension, login, external API, production data, or secret was used.
- The full unrelated repository suite was not run; verification is the brief's service/runtime/routes narrow regression.
- PostgreSQL `hashtext` can theoretically collide. The requested two-key overload materially separates account and device inputs but does not make hash collisions impossible; the transaction remains safe for the overwhelmingly common non-collision case and preserves the established contract.

## Rollback / recovery

This is a source/test/report-only change with no migration or external side effect. Revert the final commit hash from the handoff:

```bash
git revert <task-3-commit-hash>
```

That restores the prior lock and invalidation behavior. No generated package, database, or production-data restoration is required.

---

# Task 3 Fix Round 1 — make account revocation a required authentication side effect

## Parent commit and fix scope

- Parent Task 3 commit: `6b2b340b0cbddc077acf37b9628b012b6e2b8947`.
- Fix commit subject: `fix: make collector account revocation mandatory`.
- The final fix commit hash is reported in the handoff because a commit cannot embed its own stable Git object hash.

The review identified that disabled/expired account revocation ran inside runtime `audit()`, while service `writeAudit()` intentionally swallows logging failures. An audit save or revoke save error therefore returned the ordinary account-status code without proving the old token had been durably revoked.

## Contract and file changes

- `server/collector-auth-service.mjs`
  - Disabled/expired authentication now calls `repository.revokeSessions({ accountId, reason, now })` before best-effort audit logging.
  - Exact reasons are `ACCOUNT_DISABLED` and `ACCOUNT_EXPIRED`.
  - A successful required revoke preserves the exact public disabled/expired code even if audit logging fails.
  - A required revoke failure becomes the authentication failure; logging is still attempted best-effort and cannot replace that security failure.
- `server/collector-auth-repository.mjs`
  - Existing `revokeSessions` treats an absent/empty parent-session token as account-wide while preserving the existing explicit-parent scope.
  - JSON revocation remains atomic through the existing persist/rollback boundary.
  - PostgreSQL account-wide revocation updates active rows by `account_id` only; explicit-parent SQL remains unchanged.
- `server/collector-auth-runtime.mjs`
  - Removes the duplicate security revocation from the audit sink. Runtime audit returns to logging only.
- `server/tests/collector-auth-service.test.mjs`
  - Adds service-level audit-failure recovery coverage and the PostgreSQL account-wide SQL/parameter contract.
- `server/tests/collector-auth-runtime.test.mjs`
  - Injects JSON audit-save and revoke-save failures at the real runtime/repository boundary.

No outbox, schema, migration, framework, extension, generated package, dependency, ledger, production configuration, or external integration changed.

## RED / GREEN evidence

Focused command:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='required expired-account revocation|revokes every active Collector session|audit save failure after required account revocation|required account revocation save failure' server/tests/collector-auth-service.test.mjs server/tests/collector-auth-runtime.test.mjs
```

RED result: 0 passed, 4 failed.

- Audit-save failure left `revokedAt` empty.
- Revoke-save failure was swallowed and surfaced as `COLLECTOR_ACCOUNT_DISABLED` instead of a persistence failure.
- The pure service path did not revoke when its audit sink failed.
- PostgreSQL still emitted the parent-token predicate for an account-wide call.

GREEN result: 4 passed, 0 failed after moving required revocation into service authentication, adding account-wide repository behavior, and removing the runtime audit duplicate.

Recovery evidence:

- Audit save failure occurs only after the required revoke is durably saved; authentication returns `COLLECTOR_ACCOUNT_DISABLED`, and recovery still returns `COLLECTOR_SESSION_REVOKED` for the old token.
- A first revoke save failure returns sanitized `COLLECTOR_AUTH_PERSISTENCE_FAILED` with no raw error, account ID, or Collector token. With the account still disabled, a second authentication retries and persists `ACCOUNT_DISABLED`; recovery then rejects the old token as revoked.
- The service-level expired case proves an unavailable best-effort audit sink cannot undo `ACCOUNT_EXPIRED` or revive the old token.

## Regression, unverified scope, and rollback

Fresh Task 3 service/runtime/routes regression: 72 passed, 0 failed. Modified source/tests pass `node --check`; `git diff --check` and the post-stage `git diff --cached --check` are the final diff gates.

- No real PostgreSQL instance or real account was used. PostgreSQL behavior is verified at emitted SQL/parameters and existing deterministic fixtures only.
- The full unrelated repository suite is outside this fix round; the requested Task 3 narrow regression is the verification boundary.
- Account-wide revoke is intentionally bounded by the already-authorized internal `accountId`; explicit parent-token revocation remains available for logout and other parent-scoped flows.

This fix has no migration or external side effect. Revert the final fix hash from the handoff to return to parent commit `6b2b340b0cbddc077acf37b9628b012b6e2b8947`:

```bash
git revert <task-3-fix-round-1-hash>
```

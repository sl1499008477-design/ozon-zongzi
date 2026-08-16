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

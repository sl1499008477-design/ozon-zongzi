# Task 1: AI Content Persistence Report

## Implementation

- Added additive migration `027_auto_listing_ai_content.sql` for `ai_gateway_profiles`, `ai_content_plans`, `ai_generation_assets`, `ai_rich_content_results`, and `auto_listing_ai_outbox`.
- Gateway profiles store only non-secret configuration, including `api_key_env_name`; there is no API key, token, credential, cookie, bearer value, response body, or image-byte column.
- Added the minimum account-qualified unique indexes to existing foundation entities and used composite foreign keys to bind every plan, asset, result, and outbox item to the same account and exact job. An item from job B cannot be attached to job A merely because both belong to the same account.
- Plans reject all updates and deletes. Accepted generation assets and rich-content results reject later updates and deletes; non-accepted attempts remain available for retry/error evidence.
- Enforced item/slot/input/attempt uniqueness, one accepted image per item/slot/input, reusable rich-content input identity, global outbox dedupe, and partial pending/lease indexes for worker claiming.

## Files

- `server/db/migrations/027_auto_listing_ai_content.sql`
- `server/tests/auto-listing-ai-migration.test.mjs`
- `.superpowers/sdd/2026-08-04-auto-listing-ai-content-pipeline/progress.md`
- `server/tests/auto-listing-ai-migration-postgres.test.mjs`

## TDD evidence

Initial RED:

```bash
task_node=/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
"$task_node" --test server/tests/auto-listing-ai-migration.test.mjs
```

The five new contract tests failed as expected with `ENOENT` for the not-yet-created migration 027. After adding the migration, a second RED required the exact `(account_id, job_id, item_id)` item foreign key; 3 tests failed because the original schema had only independent account/job and account/item references. The final GREEN result was 12/12 focused AI and foundation migration-contract tests passing.

## Verification

- Migration contract regression: 25 tests, 23 passed, 2 safely skipped because a dedicated migration database was not configured.
- Auto-listing foundation regression: 116 tests, 115 passed, 1 safely skipped for the same dedicated-DB gate.
- Safe configured-migration check ran with dotenv and ordinary PostgreSQL variables disabled and returned `skipped: true`; it made no database connection.
- Live PostgreSQL migration and trigger/FK behavior were not run because `SONLI_MIGRATION_TEST_DATABASE_URL` is absent. No production database fallback was used.

## Rollback and risk

The migration is additive: it creates tables, indexes, idempotently replaceable trigger functions, and guarded trigger creation only. It has no table/column drop, rename, truncate, or data rewrite. If deployment needs rollback, disable the feature before writes; preserve the evidence tables rather than deleting operational data. The remaining risk is live PostgreSQL syntax and trigger/FK execution, which needs a dedicated disposable database URL.

## Fix round 1

The independent review found seven persistence boundaries that the initial contract did not close. This round adds:

- exact gateway-profile version foreign keys and conditional freezing of referenced operational configuration;
- plan provenance foreign keys that bind the job's strategy and item's source snapshot, even within one account;
- `SELLING_POINT` as the stable image-role value;
- terminal immutability for accepted, rejected, and failed assets/results, with append-only rich-result attempts;
- accepted-result completeness checks for stored media/rich content, hashes, dimensions, checker evidence, and acceptance time;
- a closed outbox lease invariant requiring both lease fields only in `LEASED` state;
- comment-stripped static contracts, VARCHAR/CHARACTER VARYING secret detection, and a double-gated real PostgreSQL behavior fixture.

Fix RED was 6 expected static failures with the new PostgreSQL behavior test safely skipped because its dedicated URL was absent. Focused GREEN was 6 passed and 1 dedicated-DB skip. Migration regressions were 24 passed and 3 dedicated-DB skips; the full auto-listing regression was 116 passed and 2 dedicated-DB skips. The PostgreSQL fixture is designed to apply all migrations in its own random schema and verify cross-job/snapshot/strategy/profile-version rejection, terminal triggers, accepted checks, leases, retry uniqueness, accepted uniqueness, and outbox dedupe. It did not execute because `SONLI_MIGRATION_TEST_DATABASE_URL` is not configured, and it has no ordinary database fallback.

## Fix round 2

- The accepted asset constraint now uses `width IS NOT NULL AND width > 0` and the equivalent height condition. This prevents PostgreSQL from accepting an otherwise complete row when a nullable dimension makes the CHECK expression evaluate to null.
- The dedicated PostgreSQL fixture covers width-null and height-null independently with every other accepted-image field valid.
- Static secret-column detection covers direct `token`, `credential`, `secret`, `cookie`, and `bearer` names against TEXT, sized/unsized VARCHAR, CHARACTER VARYING, JSONB, and BYTEA. A positive allow-case proves `api_key_env_name TEXT` remains permitted.

TDD RED was 2 targeted static failures plus 1 dedicated-DB skip. Focused GREEN was 6 passed and 1 skip. Full auto-listing regression was 116 passed and 2 dedicated-DB skips. Node syntax, `git diff --check`, and the safe migration gate passed; the migration runner reported `skipped: true` and applied nothing. The live dimension checks remain unexecuted because the dedicated migration database URL is absent; no ordinary or production database fallback is available in the fixture.

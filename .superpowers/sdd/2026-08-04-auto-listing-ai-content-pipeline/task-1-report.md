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

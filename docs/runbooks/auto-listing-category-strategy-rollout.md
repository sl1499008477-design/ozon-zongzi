# Auto-listing category strategy rollout and recovery

## Release identity and safety boundary

- Apply migrations **001–076** to a backup-tested database. Migration 076 is the latest migration for this release.
- Reinstall browser extension **0.13.46.3** on every sampling workstation. Older versions cannot use the dedicated sampling channel.
- The production feature default is **LEGACY_FALLBACK**. Enable `REQUIRE_EXACT_STRATEGY` one account at a time only after the checks below pass.
- Sampling handoff state is process-local in this release. Deploy the Web/API category-strategy routes as a **single process**, or configure **sticky** routing so readiness, session start, fact confirmation, and completion always reach the same process. Do not enable a multi-process non-sticky deployment.
- Never point acceptance checks at real Ozon, paid AI, production PostgreSQL, or production object storage. Use the disposable composition suite.

## Before enabling an account

1. Confirm migration 076 is recorded and all migrations 001–076 completed without error.
2. Confirm extension 0.13.46.3 reports ready on the same sticky process that serves the administrator page.
3. Confirm the account has exactly one enabled AI profile and an approved model configuration. The administrator must explicitly confirm cost before an analysis request.
4. Confirm object storage supports conditional create, expected-ETag replacement, expected-hash reads, and scoped deletion.
5. Provision a rotated `AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_HASH_SECRET` of at least 16 characters, and verify the fixed counters plus safe structured events reach the approved metrics/log sinks. Never print or record the secret; a missing secret intentionally disables this observability boundary.
6. Run `pnpm test:auto-listing-category-strategy-e2e` against a fresh disposable PostgreSQL 16 database with `AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS=1` and `TEST_DATABASE_URL` set. The suite must report zero unexpected skips.
7. Record the account, operator, policy version, change ticket, correlation ID, deployment version, and extension version. Do not record credentials, cookies, source URLs, raw prompts, image bytes, or AI responses in operational logs.

## Progressive rollout

1. Keep all accounts on LEGACY_FALLBACK immediately after deployment.
2. Enable one internal account, then one low-volume account. Verify the entire funnel before increasing scope.
3. Monitor only these fixed counters and their bounded outcome labels:
   - `category_strategy_required_total`
   - `category_strategy_sampling_started_total`
   - `category_strategy_sample_set_committed_total`
   - `category_strategy_analysis_attempt_total`
   - `category_strategy_publish_total`
   - `category_strategy_continue_create_total`
4. Structured events may contain only account hash, draft/session/attempt/strategy-version IDs, exact category scope, correlation ID, bounded outcome, and duration. They must never contain account ID, secrets, cookies, Ozon URLs, image keys, raw evidence, prompts, AI response, credentials, SKU, title, or store credentials.
   Operational outcome mapping stays inside the six fixed names: sampling cancellation/replay and sample-revision requests use `category_strategy_sampling_started_total` events; expired sessions, scope/fact mismatch, and rejected image evidence use `category_strategy_sample_set_committed_total` events; audited rollback success/replay/conflict/failure uses `category_strategy_publish_total` outcomes. No additional metric family is created.
5. Verify a missing exact strategy returns 409 before job, item, outbox, paid AI, or generation-object side effects. After immutable publication, the user must continue with a new idempotency key; the created task freezes the selected strategy version and rule while preserving the exact requested image counts.

## Expected failures and recovery

- Four samples, twenty-one samples, duplicate SKU, mixed category/type, stale source version, expired session, wrong account, wrong extension version, or mismatched facts are rejected without a sealed sample set. Correct the input and retry with a new command key where required.
- Five through twenty exact, unique, same-scope samples are valid. A lost response may be retried only with the identical idempotency key and identical request; the durable result is replayed.
- Replacing or supplementing samples is a two-stage immutable revision. The remove action validates the selected sample and opens a new exact sampling session; the administrator then confirms the complete replacement set of 5–20 samples. Confirmation appends a new SEALED sample-set/hash and advances the draft version. The prior SEALED set, images, hashes, and audit events remain unchanged. Until confirmation succeeds, the prior set remains authoritative.
- Paid AI is called only after explicit cost confirmation. A known timeout/failure, malformed output, or missing evidence moves the draft to **NEEDS_REVIEW**. If the response outcome is unknown, the reserved attempt stays pending in **ANALYZING**; recover that same attempt with the same idempotency/request identity. In either case, do not auto-publish and never create a second paid request for an already reserved identity.
- Object writes use PREPARING manifests. **DONE** is authoritative committed evidence and is never garbage-collected. **ABORTED** is an authoritative cleanup tombstone: remove only its owned non-published objects under expected ETag/hash fencing, retain the ABORTED manifest, and make cleanup idempotent. A missing or ambiguous manifest is not permission to delete.
- Session cancellation first records the durable session as CANCELLED, then clears process-local selection facts. Exact start replay after a process restart remains cancelled and cannot be handed off again. Cancellation does not delete committed evidence, published versions, ordinary collection records, or generation assets.
- Old V1 tasks and idempotent replays continue to reference their frozen version. Turning the feature off restores LEGACY_FALLBACK for new requests; it does not rewrite old jobs.

## Disable, rollback, and data preservation

1. Stop account expansion. Switch the affected account back to LEGACY_FALLBACK with the normal audited policy transition.
2. If the extension channel is unstable, disable category-strategy sampling or route it to one healthy sticky process. Ordinary collect remains independent and must continue unchanged.
3. If a published strategy is wrong, publish a **new immutable version** (or use the audited rollback operation, which itself creates a new version). Never update or delete a published/retired version in place.
4. **never delete evidence** as part of rollout rollback. Preserve drafts, sealed samples, AI attempts/results, publication history, audit events, command ledgers, DONE manifests, and ABORTED tombstones for diagnosis and replay safety.
5. Do not reuse a failed continue-create idempotency key for changed input. Return to the original page, reload the current publication, and continue with a new key.

## Incident handoff record

Record deployment SHA, account hash, policy version, draft/session/attempt/strategy-version IDs, exact category scope, correlation ID, fixed outcome, duration, first/last occurrence, current LEGACY_FALLBACK state, extension 0.13.46.3 readiness, and whether objects are PREPARING/DONE/ABORTED. Explicitly state what was not verified and who owns the next recovery action. Attach no raw evidence or secret material.

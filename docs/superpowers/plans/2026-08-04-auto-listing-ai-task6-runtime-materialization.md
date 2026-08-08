# Auto-listing Task 6: Source Materialization and Durable Runtime

> Implement with `superpowers:subagent-driven-development` and strict TDD. The feature remains disabled by default. Never use a production database, live AI gateway, live Ozon API, or production object store in tests.

## Goal

Connect the already-built planning, image-generation/checking, and rich-content services through an account-scoped durable queue. Before image generation, deterministically materialize every immutable `SOURCE_URL` into verified `CONTENT_HASH` evidence and create a new immutable ContentPlan version. Do not mutate the parent plan or change the existing Ozon listing worker.

## Non-negotiable contracts

- Queue: dedicated `auto-listing-ai-v1`; do not publish AI work to the existing listing queue.
- Feature flags: `AUTO_LISTING_ENABLED` and `AUTO_LISTING_AI_ENABLED` remain false by default. Disabled workers do not connect to PgBoss or start timers.
- Closed message V1: `contractVersion`, `accountId`, `itemId`, `phase`, optional phase-specific identifier, `expectedStatusVersion`, `correlationId`. No URL, prompt, secret, API key, image bytes, model output, or mutable listing field.
- Worker reloads all frozen facts, profiles, plans, and attempts using the account boundary.
- Every external effect is reserved before use and fenced by account/scope/input/attempt/lease token and database-owned lease time.
- Cancellation or stale `statusVersion` is acknowledged without any new network, gateway, or storage call.
- Plan 2 ends at `READY_FOR_REVIEW`. Direct upload stays disconnected until the Ozon adapter phase.
- PostgreSQL behavior tests require both `AUTO_LISTING_POSTGRES_TESTS=1` and a dedicated `SONLI_MIGRATION_TEST_DATABASE_URL`; never fall back to an ordinary or production URL.

## Workflow

```text
SOURCE_READY
  -> PLAN_CONTENT
PLANNING
  -> MATERIALIZE_SOURCE_ASSET (zero or more)
  -> FINALIZE_MATERIALIZED_PLAN
GENERATING
  -> GENERATE_IMAGE_SLOT (one per immutable slot; checker is internal)
  -> GENERATE_RICH_CONTENT
  -> READY_FOR_REVIEW
```

The initial plan may contain `SOURCE_URL`. Task 4 continues rejecting it before reservation or I/O. The materialization finalizer creates a derived plan containing only `CONTENT_HASH`; the parent plan remains byte-for-byte immutable.

## 6A — Migration, message contract, and AI outbox

### Files

- Create `server/db/migrations/032_auto_listing_ai_runtime.sql`
- Create `server/auto-listing-ai-message.mjs`
- Create `server/auto-listing-ai-outbox-repository.mjs`
- Create focused static, memory, and double-gated PostgreSQL tests

### Migration

- Extend `auto_listing_ai_outbox` additively with contract version, expected status version, correlation ID, lease token, publication ID, retry fields, and closed phase/error constraints.
- Add planner attempt persistence with active/accepted uniqueness and lease fencing.
- Add `active_content_plan_id` to `auto_listing_job_items` with an account/job/item-scoped relationship.
- Add source-materialization attempt, derived-plan relationship, and source-object-cleanup tables.
- Extend `ai_content_plans` with all-or-none `parent_plan_id`, `derivation_kind`, and `materialization_set_hash` fields.
- New constraints are compatible with historical rows and use additive/`NOT VALID` transitions where required. Terminal audit rows are never rewritten.

### RED tests

- Extra/missing payload keys, invalid phase-specific fields, URL/secret-like payloads, and cross-account IDs fail closed.
- Deterministic dedupe creates one outbox row.
- Two claimers cannot hold one lease; stale tokens cannot complete a reclaimed lease; expired work is recoverable.
- A PgBoss singleton-already-exists result is successful idempotent publication.
- Database errors expose fixed safe codes, not raw messages.

## 6B — Safe source-image materialization

### Files

- Create `server/auto-listing-source-materializer.mjs`
- Create `server/auto-listing-source-materialization-repository.mjs`
- Create `server/auto-listing-source-asset-store.mjs`
- Create `server/auto-listing-materialized-plan.mjs`
- Create focused and double-gated PostgreSQL tests

### Ports

```js
downloadSourceImage({ sourceUrl, timeoutMs, maxBytes, maxRedirects, forbidHttpsDowngrade })
reserveSourceMaterialization({ accountId, jobId, itemId, parentPlanId, sourceAssetId, sourceRefHash, inputHash })
recordStoredSourceMaterialization(...)
completeSourceMaterialization(...)
failSourceMaterialization(...)
createDerivedMaterializedPlan(...)
```

### Security and idempotency

- HTTP(S) only; no URL credentials. Validate every redirect.
- Reject localhost, private, link-local, reserved, metadata, mixed public/private DNS answers, DNS rebinding, and HTTPS downgrade.
- Enforce bounded total time, redirects, `Content-Length`, streaming bytes, decoded pixels, supported MIME/magic, and single-frame PNG/JPEG/WebP.
- Default policy is versioned configuration: 8 MiB, 40 million pixels, 10 seconds, 3 redirects, 3 attempts. These are engineering limits, not Ozon rules.
- Store under a scoped, encoded, versioned key containing only IDs and hashes. Read back and verify key, bytes, SHA-256, MIME, dimensions, and size.
- Object write followed by database failure triggers immediate removal; removal failure creates an account-scoped cleanup obligation.
- Accepted replay makes zero downloader/storage calls, even when the remote URL later returns different bytes.
- Never persist or log the URL, query string, response body, socket error, or redirect location; persist only the frozen `sourceRefHash` and stable error evidence.

### Derived plan

- Require exactly one accepted materialization for every parent `SOURCE_URL`, and no extra/cross-plan records.
- Preserve asset IDs, visual-group keys, plan JSON, slot roles, fact IDs, and `planHash`.
- Replace only the source evidence with immutable `CONTENT_HASH`, then recompute `visualGroupsHash`, `materializationSetHash`, input hash, and derived plan ID.
- Insert the derived plan and relation rows; never update the parent plan.
- Repeated finalization returns the same derived plan.

## 6C — Production repositories for existing AI services

### Files

- Create PostgreSQL ContentPlan attempt/repository adapter
- Add PostgreSQL generation-attempt adapter over migration 029
- Reuse the Task 5 PostgreSQL rich-content adapter
- Add exact memory/PG parity tests

### Contracts

- All public methods require account/job/item/plan/input/attempt/lease scope as applicable.
- Reserve before AI calls; accepted replay performs zero AI calls only after full immutable evidence revalidation.
- Stored-row/bind/complete transitions are exact CAS and return exact persisted records.
- Planner, image, and rich repositories normalize database failures to closed safe errors.
- No adapter may infer “latest plan”; image workers load `active_content_plan_id`.

## 6D — PgBoss adapter, publisher, worker, and orchestrator

### Files

- Create `server/auto-listing-ai-queue.mjs`
- Create `server/auto-listing-ai-worker.mjs`
- Create `server/auto-listing-ai-orchestrator.mjs`
- Modify `server/auto-listing-runtime.mjs`, `package.json`, and guarded development startup
- Create queue, worker, and orchestrator tests

### Behavior

- API job/item creation and first outbox event are one database transaction.
- Relay claims with `FOR UPDATE SKIP LOCKED`, publishes with deterministic singleton key, and safely replays after crashes.
- Orchestrator is phase-only: it calls materializer, planner, image generator, or rich-content service and delegates persistence to their ports.
- Image checking remains inside `generateImageSlot`; do not invent a separate CHECK worker phase.
- Each slot progresses independently. Accepted siblings are never regenerated. Final MAIN failure blocks the item; non-main failures may continue only when at least six accepted assets remain.
- Rich content consumes only the final materialized plan and complete accepted asset evidence.
- Planning, materialization, image, and rich phases have separate bounded timeouts/concurrency/retry policy.
- Add `"auto-listing-worker": "node server/auto-listing-ai-worker.mjs"`; do not alter existing listing worker behavior.

### State and cancellation

- State transitions use the existing state machine and `status_version` CAS.
- Stale message or `CANCELLED`: ACK without network/gateway/storage work.
- Cancellation after an in-flight call forbids acceptance and subsequent phases; unreferenced stored objects enter cleanup.
- Append-only events include correlation/phase/stable outcome only, never prompts, URLs, secrets, response bodies, or raw errors.

## 6E — Verification and recovery gates

- Focused RED/GREEN: message, outbox, materializer, derived plan, PG repositories, queue, worker, orchestrator.
- Double-gated PostgreSQL: migration replay, SQL NULL, cross-account FK, concurrent claims, lease ABA, atomic plan switch/event/outbox, terminal immutability.
- Recovery: relay crash after publish, worker crash after reservation/storage, expired lease reclaim, duplicate delivery, cancellation before/after external call.
- Regression: existing listing queue/worker/pipeline, auto-listing state/service/routes/repository, object storage/cleanup, account deletion, store/warehouse account isolation, all migrations, module boundaries, app build.
- Whole tests must distinguish configured PostgreSQL skips from failures.

## Acceptance criteria

- A SOURCE_URL item reaches a derived CONTENT_HASH-only plan without mutating its parent.
- Duplicate delivery, crash recovery, and concurrent workers cause no duplicate AI, download, storage, plan, or event side effects.
- Every query and object operation is account scoped; every error is safe and traceable.
- Existing Ozon listing queue/worker, browser extension, collection box, store/warehouse sync, and Ozon API calls are unchanged.
- Direct upload remains disabled; successful items stop at `READY_FOR_REVIEW`.

## Rollback

- Keep both feature flags off and stop only the dedicated AI worker.
- Revert source/runtime changes while preserving audit, materialization, cleanup, attempt, event, and outbox rows.
- If migration 032 was applied, use a reviewed additive compensating migration; do not delete audit rows or destructively rewrite historical data.

# Stable Russian Rich Content Design

## Goal and boundary

Generate one deterministic, internally versioned Russian rich-content document from an immutable content plan, its frozen fact registry, accepted generated assets, and an account-scoped text profile. The module never receives raw source URLs, secrets, source rich content, mutable listing fields, or Ozon transport structures. Ozon conversion remains Plan 4 scope.

## Closed V1 contract

The output is exactly `{ version: "AUTO_LISTING_RICH_CONTENT_V1", language: "ru", blocks }` with 3–20 blocks. The first and only `HERO_IMAGE` references an immutable accepted `ai_generation_assets.id` whose role is `MAIN`. The other types are `HEADING`, `TEXT`, and `IMAGE_TEXT`. Every text block has a nonempty, bounded, duplicate-free `sourceFactIds` array; every referenced asset ID is unique. Plain objects only, closed keys, JSON-safe values, UTF-8 byte ceilings, and bounded arrays prevent prototype, extra-field, and oversized-input escape paths.

All numeric occurrences must match exactly one numeric value and canonical unit of a cited fact from the same field; every cited numeric fact must be represented, and extra numbers fail closed. Every cited nonnumeric fact value must appear in the text. Text must contain Russian Cyrillic copy; only fact-proven brand/model values and a closed technical-token set may contain Latin tokens. Deterministic policy rejects contact details, external links, review requests, certification, medical/effect, warranty, after-sales, and accessory claims. This phase has no reliable frozen accessory-list semantics, so phrases such as `В комплекте` are always treated as unlisted accessory claims and rejected fail-closed.

## Accepted asset evidence

`assetId` is the immutable generation-asset row ID, never an object key or source-asset ID. Every input asset must be `ACCEPTED`, belong to the exact account/job/item/plan, match the immutable plan slot and role, have a valid exact persisted object key and content hash, and carry complete plan/source/profile/model/template/checker evidence. The rich-content checker records the exact asset IDs and hashes it evaluated. Accepted replay re-runs the same asset and rich-content validators; corrupt or cross-scope evidence is a version conflict with zero gateway calls.

## Deterministic input and prompt

Canonical hashing covers the full scope, plan/source/fact-registry/asset evidence, profile ID/version, selected text model, prompt template, language, and prompt. The prompt projects only safe fact fields/values/units and accepted asset IDs/roles/content hashes inside an explicitly untrusted JSON boundary. It contains no URL, secret, raw source evidence, mutable listing data, or executable instruction from source content.

## Attempt state machine and persistence

The focused repository reserves before the gateway. Identity is `(accountId, jobId, itemId, planId, inputHash, attemptNo)`; active and accepted uniqueness use the same full scope without attempt number. Reservation persists and echoes input and prompt hashes plus an opaque lease. Exact account/scope/input/attempt/lease CAS is mandatory for complete, reject, and fail. `ACCEPTED`, `REJECTED`, and `FAILED` are terminal and clear all lease fields. Policy rejection is non-retryable; gateway and expired-lease failure are recoverable within the closed maximum-attempt policy.

Migration 031 additively extends `ai_rich_content_results` with plan/fact/prompt hashes, request/model/source-fact/asset evidence, gateway request ID, and lease audit. It never updates historical terminal rows. New generating and accepted constraints use explicit `IS NOT NULL`, JSON type/nonempty checks, hash formats, and closed lease predicates so SQL NULL cannot pass through three-valued CHECK semantics.

## Failure and recovery

Invalid input fails before reservation. `IN_PROGRESS` and exhausted attempts make zero gateway calls. Gateway schema/transport errors terminalize the owned attempt with stable retryability. Deterministic output-policy failure terminalizes it as `REJECTED`. A repository transition failure never returns success; best-effort fenced failure is attempted where ownership still exists. No external or production database action is part of this task.

## Verification

Four focused groups cover: A, closed pure schema/policy/hash behavior; B, reserve-before-gateway, failure recovery, idempotency, and corrupt replay; C, memory/PostgreSQL repository scope, lease, retry, and terminal CAS; D, additive migration, SQL NULL protection, full-scope uniqueness, repeat application, and the double-gated disposable-PostgreSQL fixture. Final gates include all auto-listing/AI tests, selected historical boundaries, all migration tests, whole server tests, raw server tests with environment-only failures separated, syntax checks, diff checks, and the production app build.

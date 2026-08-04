# Task 3: deterministic visual groups and category-aware ContentPlan report

## Outcome

Implemented two isolated pure-domain boundaries without wiring them into the current runtime, UI, workers, object storage, or Ozon listing path:

- `buildVisualGroups` verifies the immutable foundation source capture and deterministically separates visually different variants while allowing complete size-only variants to share one group.
- `buildPlannerInput`, `validateContentPlan`, and `createContentPlan` build a frozen read-only planner request, locally validate the gateway's structured result a second time, reserve the account/job/item/input identity before any AI cost, and persist only a complete immutable plan.

The implementation does not call Ozon or browse competitors. The only gateway call is through the existing `AiGatewayPort`, and every test uses a fake gateway.

## Source and grouping contract

- Added a strict V1 `variant.evidence` contract for source variant ID, complete/ambiguous appearance status, visible facts (`COLOR`, `PATTERN`, `SHAPE`, `MATERIAL`, `ACCESSORY_COUNT`), and size facts.
- Unknown V1 keys, conflicting fact IDs, duplicate variant IDs, unsafe media objects, and image-ID collisions fail with stable codes. Missing or ambiguous appearance evidence becomes a singleton instead of being guessed from names, URLs, or package data.
- Current canonical URL-string media remains usable. It becomes a deterministic `SOURCE_URL` asset reference with `contentHash: null`; URL hashes are never represented as content hashes. Closed `{assetId, contentHash}` evidence remains supported as `CONTENT_HASH`.
- Every group records stable source SKUs, source variant IDs, source references, fact evidence, reason codes, key, and hash. Before planning, the caller-supplied group capture is rebuilt from the same verified source and compared exactly, so recomputing a forged group hash cannot authorize altered facts/assets/reasons.

## Read-only planner contract

- Planner facts include source name/brand, trusted product measurements, strict known canonical attributes with dictionary trace paths, and group-scoped variant visual/size facts. Unsupported attribute shapes are ignored with `UNSUPPORTED_ATTRIBUTE_EVIDENCE_IGNORED`; old rich marketing copy is not promoted to fact evidence.
- Price, black/green price evidence, target store, warehouse, stock, category mutation fields, logistics/package dimensions, secrets, key references, and source URL text do not enter the prompt. SKU exists only under immutable group trace identity.
- The category strategy is a verified frozen snapshot. Five styles automatically select role text density without browsing Ozon during a task.
- Missing trusted product dimensions removes `SPECIFICATION` and reallocates the slot under the selected style while respecting confirmed role maxima. At the saturated 13-image structure, no-specification capacity is 12, so it safely records `SPECIFICATION_REALLOCATION_CAPACITY_EXHAUSTED` instead of silently exceeding a role maximum.
- Ambiguous groups remain plannable with system-owned identity preservation. For complete groups, preservation values are derived from frozen appearance facts. The model cannot invent or modify the preserve list.

## Closed ContentPlan and local validation

- Gateway JSON Schema is closed and allows only plan version, `ru`, and typed slots.
- Local validation independently enforces group × role × occurrence order, exact slot keys, per-group totals 6–13, every configured role count, reference ownership, fact scope, baseline prohibited claims, system preservation values, strategy density, Russian copy, and claim limits.
- Every claim must cite a matching fact kind and contain its evidence value; numerical tokens match exact evidence numbers rather than substrings. Dimension labels/units must agree with the cited product measurement. Unsupported certification, warranty, medical, material, accessory, performance, or numeric claims cannot be smuggled through a different claim type.
- Source facts are explicitly delimited as untrusted JSON inside the prompt. Instructions found inside product text remain data and local validation still rejects unknown/writable output fields.

## Idempotency, traceability, and recovery

- `inputHash` covers source, strategy, frozen config, visual groups, prompt template, profile/version, planner model, typed regeneration request, and the complete effective planner-input hash.
- Regeneration requires one closed reason plus a caller-stable request ID. Repeating one action reuses its input identity; another request ID creates a new immutable version while preserving old rows.
- The repository must atomically return `EXISTING` or one `RESERVED` owner. Concurrent same-key tests prove one gateway call. Gateway or validation failure never calls `saveContentPlan`; the reservation is released with a stable error code.
- Reused and newly saved rows are revalidated for account/job/item/input scope, canonical plan body, and plan hash. Cross-account, wrong-hash, and damaged rows fail closed.

## TDD and verification

Initial RED was both focused files failing with `ERR_MODULE_NOT_FOUND`. Additional RED rounds covered the real URL-media boundary, forged visual hashes, missing attributes, model-owned preservation, unstable order, numeric substring support, source prompt injection, same-key concurrency, ambiguous groups, and no-specification capacity.

Final verification:

- focused Task 3: 22 passed, 0 failed;
- auto-listing/AI regression: 190 tests, 189 passed, 1 dedicated-PostgreSQL test skipped by configuration, 0 failed;
- whole server `*.test.mjs`: 850 tests, 845 passed, 5 configured PostgreSQL skips, 0 failed;
- exact old permissions/persistence/listing/account-store regression: 41 passed, 0 failed;
- app production build: passed; only the pre-existing large-chunk warning remained;
- both new production modules passed Node syntax checks and `git diff --check` passed.

## Unverified scope, regression risk, and rollback

No real sub2api request, source-image download, object-storage write, PostgreSQL plan reservation, or Ozon write was run. The actual repository implementation and safe URL download/content hashing belong to later tasks. No dedicated `SONLI_MIGRATION_TEST_DATABASE_URL` is configured, so PostgreSQL-gated tests remained safely skipped without any production fallback.

The new modules have no runtime call site and `AUTO_LISTING_AI_ENABLED` remains off by default, so current collection, extension, store, listing, order, and UI behavior is unchanged. Rollback is to keep that flag off and revert this Task 3 commit; there is no database or external side effect to undo.

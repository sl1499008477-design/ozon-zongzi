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

## Review repair — evidence boundaries

This repair closes the final review findings within Task 3 only. `buildPlannerInput` now carries the verified source account ID, and `createContentPlan` rejects any mismatch among caller account, source account, and gateway-profile account before reservation, repository, or gateway work. Preflight additionally closes group media, preserve/fact scope, role/count, and the global 1000-slot boundary before an external boundary is reached.

Visual evidence now treats `null`, missing-contract, and non-V1 historical evidence as conservative singleton groups. Explicit V1 remains closed: malformed V1 is rejected, while a V1 `COMPLETE` record with conflicting values for the same visible kind becomes a singleton with no unsafe appearance fact projection. UTF-8 byte comparison replaces locale-dependent ordering.

Attribute projection accepts only the three documented closed source shapes (A, B, C), retains the attribute source path and dictionary-value evidence, and records ignored unsupported/sensitive/extra evidence. It never adds rich content, category, price, logistics, store, warehouse, or other writable source fields to the prompt. Strategy evidence is now a closed `EXACT_CATEGORY`/`ANCESTOR_CATEGORY`/`PRODUCT_STYLE`/`DEFAULT` contract bound to the verified target category, ancestors, or product style. The AI prompt receives only style, match class, and normalized role densities; the version/rule identifiers and opaque match evidence remain hash-only traceability data.

Numeric claims now require same-kind source evidence. Dimensions require each number and recognized unit to match the same cited product measurement fact, so an identity value such as a brand `500` cannot support a height. Existing rows are rechecked field-by-field for source/strategy/config/visual/profile/template/model/regeneration evidence as well as canonical plan body and hash; every mismatch fails closed.

TDD: the focused RED run had 23 passes and 5 expected grouped failures (legacy/V1 visual conflicts, attribute projection, strategy projection/closure, cross-account zero-call plus stored-row evidence, and numeric/unit binding). The final focused Task 3 suite passed 29/29. Strategy ancestor/product-style binding was added as a final regression case.

Final verification:

- focused Task 3: 29 passed, 0 failed;
- auto-listing and AI regression: 196 passed, 1 dedicated PostgreSQL test skipped by configuration, 0 failed;
- whole server `server/tests/*.test.mjs`: 852 passed, 5 configured PostgreSQL skips, 0 failed;
- historical permissions/persistence/listing/account-store regression: 33 passed, 0 failed;
- production app build passed; the existing large-chunk warning remains;
- both changed production modules passed syntax checks and `git diff --check` passed.

No real gateway request, repository/database call, image download, object-storage write, or Ozon operation was performed. The new checks are pure in-memory boundary tests. Rollback remains a revert of this repair commit (or retaining the disabled feature flag); no data migration or external state needs recovery.

## Review repair round 2 — persisted plan evidence and field-bound facts

Added additive migration `028_auto_listing_ai_plan_evidence.sql`. It leaves 027 and existing plan rows intact while adding nullable compatibility columns for `visual_groups_hash`, complete `visual_groups` capture, `regeneration`, and `gateway_request_id`. New planner writes always pass all four fields: no regeneration is represented as SQL `NULL`; a regeneration is the closed JSON object. The migration limits visual hashes to SHA-256 text, requires object JSON where present, and bounds gateway request IDs to trimmed 1–240-character text. The existing immutable-plan trigger protects the new columns too.

Plan save and reuse validation now require the complete rebuilt visual-group capture as well as its hash; gateway request IDs must be a safe string or null. Product facts are field-bound (`DIMENSION_HEIGHT`, `DIMENSION_WIDTH`, etc.; independent identity kinds; stable hashed attribute kinds), so a number and unit must be supplied by the same exact fact kind. A width `30` can no longer support a height `30`, and a brand number cannot support the identity name or a dimension.

The planner also accepts the real edit-page seven-key category attribute shape, including text/numeric values without a dictionary ID. It preserves source paths and dictionary evidence when present, rejects extra keys, and excludes source-description/rich-content attribute IDs `4191` and `11254` with a traceable reason. All legal JSON evidence that is not an explicit V1 plain object is singleton-only. A source-wide asset registry rejects the same asset ID when content-hash or URL evidence differs across visual groups. Strategy resolver and planner evidence both require a positive `ruleOrder`, consistent with the existing foundation migration database constraint.

TDD: initial RED had 38 passes and 5 expected failures (missing 028, zero rule order, real edit-page attribute projection, non-object legacy evidence, and complete visual capture persistence). Final focused migration/planner/visual/strategy suite had 49 passes and 1 correctly configured dedicated-PostgreSQL skip.

Final verification:

- auto-listing and AI regression: 200 passed, 1 dedicated PostgreSQL test skipped by configuration, 0 failed;
- whole server `server/tests/*.test.mjs`: 856 passed, 5 configured PostgreSQL skips, 0 failed;
- historical permissions/persistence/listing/account-store regression: 33 passed, 0 failed;
- production app build passed; the existing large-chunk warning remains;
- changed production modules passed syntax checks and `git diff --check` passed.

No dedicated `SONLI_MIGRATION_TEST_DATABASE_URL` is configured, so the new dual-gated PostgreSQL fixture safely skipped and did not fall back to normal configuration. No database migration, gateway, image download, storage, or Ozon operation was run. Rollback is to revert this round-2 commit; deployed 028 is additive and old nullable plan rows remain readable at the database layer.

## Review repair round 3 — real edit-page value objects

The real seven-key edit-page category attribute shape now accepts only the closed one-key value-object form `{ value }` in its `values` array. `value` may be a non-empty string or finite number; it becomes a normal field-bound attribute fact with `dictionaryValueId: null` and the exact array source path. A dictionary ID is deliberately not inferred from the enclosing category attribute for this plain-text form.

Every other value-object shape remains fail-closed: extra keys, empty values, arrays, nested objects, and non-finite numbers do not project any fact and cause the entire attribute to receive the existing unsupported-evidence reason. The regression fixture covers the production-shaped `{ id, name, value, values: [{ value: "100" }], required, dictionaryId, multiple }` input and confirms a sibling object with an extra key is omitted.

TDD: RED was 23 passes and 1 expected failure for the ordinary one-key value object. Final planner focus passed 24/24. Related focused modules passed 44/44; auto-listing/AI regression passed 201 with 1 configured PostgreSQL skip; whole server passed 857 with 5 configured PostgreSQL skips. Syntax and diff checks passed. No database or external operation was run. Rollback is reverting this narrow compatibility commit.

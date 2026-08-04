# Auto Listing AI Content Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Generate a frozen Russian ContentPlan, 6–13 compliant product images, and new rich content through sub2api while preserving source facts, isolating credentials, retrying individual failures, and producing traceable reusable assets.

**Architecture:** The business pipeline depends on a small AiGatewayPort, not sub2api response shapes. A sub2api adapter supports explicitly configured protocol profiles and an admin-triggered capability test before production use. A planner creates typed image slots from the frozen strategy, workers generate and validate one slot at a time, object storage keeps immutable assets, and an outbox plus pg-boss makes every generation step resumable and idempotent.

**Tech Stack:** Node.js ESM, PostgreSQL, pg-boss, current object-storage module, SHA-256, sub2api HTTP gateway, node:test.

## Global Constraints

- Complete plan 1 first. Consume its immutable source snapshot, state machine, strategy snapshot, task config, and scoped repository contracts.
- Follow AGENTS.md: secrets backend-only, account/store boundaries on every read/write, traceable prompts/models/inputs/results, idempotent external calls, recoverable failure, and stable error codes.
- Do not browse Ozon or competitors during a generation task.
- Do not give AI permission to alter SKU, category IDs, attributes, weight, package dimensions, variant relations, target store/warehouse, stock, or price.
- Do not infer dimensions, certifications, materials, included accessories, performance claims, or guarantees that have no source evidence.
- Main-image failure blocks the item. Non-main failures retry independently; at least six accepted images are required.
- A size/specification slot is omitted when reliable product dimensions or size-chart evidence is absent.
- sub2api API keys come from environment/secret management and never enter PostgreSQL, browser DTOs, logs, events, or prompt text.
- The adapter must not assume every sub2api deployment supports the same image path. Production generation requires a saved successful capability test for the selected profile and models.
- Preserve unrelated worktree changes.

## Dependency and Stable Output

This is plan 2 of 4. It depends on docs/superpowers/plans/2026-08-04-auto-listing-foundation.md and provides:

~~~js
createContentPlan({ sourceSnapshot, strategySnapshot, imageConfig })
enqueueAiGeneration({ accountId, itemId, contentPlanId })
generateImageSlot({ accountId, itemId, slotId, expectedInputHash })
buildRichContent({ sourceSnapshot, acceptedAssets, language: "ru" })
~~~

---

## Task 1: Add AI Profiles, Plans, Assets, Results, and Outbox Tables

**Files:**
- Create: server/db/migrations/027_auto_listing_ai_content.sql
- Create: server/tests/auto-listing-ai-migration.test.mjs

**Interfaces:** ai_gateway_profiles, ai_content_plans, ai_generation_assets, ai_rich_content_results, auto_listing_ai_outbox.

- [ ] **Step 1: Write a failing migration-contract test**

Assert additive table creation, account-scoped foreign keys, plan/input/result hashes, unique slot identity, immutable accepted assets, profile version fields, outbox availability/lease fields, and indexes for pending work. Reject secret-value columns named api_key, token, credential, or secret.

~~~js
assert.match(sql, /UNIQUE\s*\(item_id,\s*slot_key,\s*input_hash\)/i);
assert.match(sql, /api_key_env_name\s+TEXT\s+NOT NULL/i);
assert.doesNotMatch(sql, /\b(api_key|access_token|secret_value)\s+TEXT/i);
assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN)/i);
~~~

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-ai-migration.test.mjs
~~~

- [ ] **Step 3: Create migration 027**

ai_gateway_profiles stores only nonsecret configuration: display name, base URL, api_key_env_name, text protocol, image protocol, model names, config_version, capability result JSONB, capability_checked_at, enabled, created_by, and timestamps.

Allow these explicit protocol values:

~~~text
text_protocol: SUB2API_RESPONSES
image_protocol: SUB2API_RESPONSES_IMAGE_TOOL | SUB2API_OPENAI_IMAGES
~~~

ai_content_plans stores account/job/item IDs, strategy/config/source hashes, planner model/profile version, prompt template version, typed plan JSONB, plan_hash, and created_at. A changed input hash creates a new version; prior plans remain.

ai_generation_assets stores account/job/item/plan IDs, visual_group_key, slot_key, role, input_hash, attempt number, status, gateway request ID, model/profile versions, prompt hash, object-storage key, content hash/type/dimensions, checker result, stable error fields, and timestamps. Enforce unique(item_id, slot_key, input_hash, attempt_no) and a partial unique accepted result per item/slot/input.

ai_rich_content_results stores immutable internal rich-content JSON, source/asset hashes, model/profile/prompt versions, output hash, checker result, and status.

auto_listing_ai_outbox stores aggregate/item/slot identity, event type, dedupe_key, payload, state, attempts, availability, lease, last error, and timestamps, with unique dedupe_key.

- [ ] **Step 4: Run contract and configured migration**

~~~bash
node --test server/tests/auto-listing-ai-migration.test.mjs
AUTO_LISTING_POSTGRES_TESTS=1 node server/db/migrate.mjs
~~~

- [ ] **Step 5: Commit**

~~~bash
git add server/db/migrations/027_auto_listing_ai_content.sql server/tests/auto-listing-ai-migration.test.mjs
git commit -m "feat: add AI content persistence"
~~~

---

## Task 2: Build and Verify the sub2api Adapter

**Files:**
- Create: server/ai-gateway-port.mjs
- Create: server/sub2api-ai-adapter.mjs
- Create: server/ai-gateway-profile-service.mjs
- Create: server/tests/sub2api-ai-adapter.test.mjs
- Create: server/tests/ai-gateway-profile-service.test.mjs
- Modify: server/runtime-config.mjs

**Interfaces:** createTextResponse, generateImage, inspectImage, testGatewayCapabilities.

- [ ] **Step 1: Write failing adapter tests with a fake fetch**

Cover:

- Authorization is added by the adapter but omitted from captured logs and returned diagnostics.
- SUB2API_RESPONSES parses structured text from a nonstreaming Responses result.
- SUB2API_RESPONSES_IMAGE_TOOL parses the final image-generation result or the documented streamed image event selected by the profile.
- SUB2API_OPENAI_IMAGES parses b64_json or a returned URL and normalizes it to bytes plus metadata.
- HTTP 401/403 is NON_RETRYABLE_AUTH; 408/429/500/502/503/504 is RETRYABLE_GATEWAY; malformed success is INVALID_GATEWAY_RESPONSE.
- request timeout and caller cancellation abort fetch.
- the same idempotency/correlation headers are forwarded on retry.

- [ ] **Step 2: Write failing capability-service tests**

An admin-only explicit test must verify: base URL reachability, selected text model can return a required JSON schema, selected image protocol/model can return one test image, and the returned bytes decode to a supported image. Persist only outcome, supported features, latency, model IDs, checked time, and error code. A failed test disables production generation for that profile.

- [ ] **Step 3: Confirm RED**

~~~bash
node --test server/tests/sub2api-ai-adapter.test.mjs server/tests/ai-gateway-profile-service.test.mjs
~~~

- [ ] **Step 4: Define the stable gateway port**

~~~js
export function createAiGatewayPort({ fetchImpl, readSecret, logger }) {
  return {
    createTextResponse(input),
    generateImage(input),
    inspectImage(input),
    testCapabilities(input),
  };
}
~~~

Inputs include profile ID/version, model, correlation ID, deterministic request key, timeout, JSON schema, prompt, and source-image references. Outputs use internal types only and retain upstream request IDs and usage without exposing credentials.

- [ ] **Step 5: Implement profile-driven sub2api requests**

Use URL construction that prevents escaping the configured origin. Resolve the key from api_key_env_name at call time. Redact Authorization, cookies, data URLs, source-image bytes, and response image bytes from logs.

Current sub2api deployments may differ by version/account pool, so protocol selection is explicit rather than guessed. The adapter must not silently fall from one image protocol to another during a business task; switching protocol requires a new profile version and capability test.

- [ ] **Step 6: Add production configuration checks**

When AUTO_LISTING_AI_ENABLED=1, require a configured enabled gateway profile and the referenced environment key. Do not impose a new arbitrary key-length rule. Startup does not spend image quota; the admin capability-test endpoint performs the real image check before enabling the profile.

- [ ] **Step 7: Confirm GREEN and commit**

~~~bash
node --test server/tests/sub2api-ai-adapter.test.mjs server/tests/ai-gateway-profile-service.test.mjs
git add server/ai-gateway-port.mjs server/sub2api-ai-adapter.mjs server/ai-gateway-profile-service.mjs server/runtime-config.mjs server/tests/sub2api-ai-adapter.test.mjs server/tests/ai-gateway-profile-service.test.mjs
git commit -m "feat: adapt verified sub2api AI profiles"
~~~

---

## Task 3: Plan Images and Visual Variant Groups from Frozen Facts

**Files:**
- Create: server/auto-listing-visual-groups.mjs
- Create: server/auto-listing-content-planner.mjs
- Create: server/tests/auto-listing-visual-groups.test.mjs
- Create: server/tests/auto-listing-content-planner.test.mjs

**Interfaces:** buildVisualGroups, buildPlannerInput, validateContentPlan, createContentPlan.

- [ ] **Step 1: Write failing visual-group tests**

Assert size-only variants with identical appearance share one group. Different color, pattern, shape, or included accessory count creates separate groups. Every group stores source SKUs, reference image IDs, fact evidence, and reason codes. Ambiguous appearance differences conservatively create separate groups.

- [ ] **Step 2: Write failing ContentPlan tests**

Cover all five category styles, every image role, totals 6/8/13, no-dimension downgrade, Russian language, source fact references, allowed text density, stable slot order, and plan rejection when a claim lacks a source fact ID.

Expected slot example:

~~~js
{
  slotKey: "group-red:selling-point:02",
  visualGroupKey: "group-red",
  role: "SELLING_POINT",
  textDensity: "MEDIUM",
  sourceFactIds: ["fact.material", "fact.capacity"],
  referenceAssetIds: ["source-image-1", "source-image-2"],
  preserve: ["shape", "red color", "included lid"],
  prohibitedClaims: ["certification", "medical benefit", "unlisted accessories"],
}
~~~

- [ ] **Step 3: Confirm RED**

~~~bash
node --test server/tests/auto-listing-visual-groups.test.mjs server/tests/auto-listing-content-planner.test.mjs
~~~

- [ ] **Step 4: Implement deterministic visual grouping**

Use normalized variant attributes and image evidence. Do not ask AI to decide store scope, category, price, SKU, or variant relations. Persist group membership and reasons in the plan.

- [ ] **Step 5: Implement planner input and schema validation**

Planner input contains a read-only fact registry, strategy snapshot, requested role counts, visual groups, Russian language, ratio/resolution/quality, and prohibited claims. It omits credentials and all writable listing fields.

The model returns JSON matching a closed schema. Reject unknown keys, duplicate/missing slots, role-count mismatch, unsupported sourceFactIds, non-Russian marketing copy, guessed dimensions, and more/fewer slots than configuration.

- [ ] **Step 6: Persist immutable plan versions**

Hash source snapshot, strategy snapshot, image config, visual groups, template version, profile/model version, and normalized planner result. Same input hash returns the existing plan. A regenerate action creates a new plan version with a new explicit regeneration reason.

- [ ] **Step 7: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-visual-groups.test.mjs server/tests/auto-listing-content-planner.test.mjs
git add server/auto-listing-visual-groups.mjs server/auto-listing-content-planner.mjs server/tests/auto-listing-visual-groups.test.mjs server/tests/auto-listing-content-planner.test.mjs
git commit -m "feat: plan category-aware product images"
~~~

---

## Task 4: Generate, Store, and Check One Image Slot Idempotently

**Files:**
- Create: server/auto-listing-asset-store.mjs
- Create: server/auto-listing-image-generator.mjs
- Create: server/auto-listing-result-checker.mjs
- Create: server/tests/auto-listing-asset-store.test.mjs
- Create: server/tests/auto-listing-image-generator.test.mjs
- Create: server/tests/auto-listing-result-checker.test.mjs

**Interfaces:** storeGeneratedAsset, generateImageSlot, checkGeneratedAsset.

**Immutable source precondition:** `generateImageSlot` accepts only already-materialized
`CONTENT_HASH` references. A `SOURCE_URL` remains valid planning evidence but must be
downloaded, decoded, content-hashed, and persisted by a separate idempotent
materialization worker before Task 4. Materialization creates a new visual-group and
ContentPlan version; it never mutates an existing plan. Task 4 rejects an unmaterialized
URL with `AUTO_LISTING_SOURCE_ASSET_NOT_MATERIALIZED` before reservation or any I/O.

- [ ] **Step 1: Write failing asset-store tests**

Assert object keys are account/job/item/plan/slot scoped, content hashes are verified, supported formats are normalized, duplicate content is reused, and object-storage failures leave no accepted database row. Reuse putObjectFromBuffer from server/object-storage.mjs.

- [ ] **Step 2: Write failing generator/checker tests**

Cover:

- same slot and input hash returns existing accepted asset without gateway call;
- failed slot retries without regenerating accepted siblings;
- main-image final failure blocks item;
- missing non-main slot continues only if at least six assets pass;
- wrong product/color/accessory count, unverifiable numeric claim, non-Russian text, blur/crop/obstruction, contact details, review requests, and external-platform promotion fail with stable reasons;
- accepted checker evidence references source facts and source images;
- model/checker transport failures remain distinguishable from policy rejection.

- [ ] **Step 3: Confirm RED**

~~~bash
node --test server/tests/auto-listing-asset-store.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-result-checker.test.mjs
~~~

- [ ] **Step 4: Implement per-slot generation**

Create one deterministic input_hash from plan hash, slot, source asset hashes, prompt-template version, profile/model version, ratio, resolution, and quality. Reserve attempt rows transactionally before the external call. A lease prevents two workers generating the same attempt.

The prompt allows only background, composition, scene, Russian copy, layout, and visual style changes. It explicitly freezes product shape, color, structure, material evidence, functions, and included quantity.

- [ ] **Step 5: Store immutable output before acceptance**

Decode and inspect bytes, enforce configured dimensions/aspect tolerance and supported content type, calculate SHA-256, store under the scoped object key, then save the object reference. Never store base64 image data in events or logs.

- [ ] **Step 6: Implement layered checking**

First run deterministic format/dimensions/file checks. Then call the multimodal inspection port with source references, generated image, fact registry, and closed JSON schema. Normalize failures to PRODUCT_IDENTITY_MISMATCH, UNVERIFIED_CLAIM, LANGUAGE_MISMATCH, IMAGE_QUALITY_FAILED, PROHIBITED_CONTENT, or CHECKER_UNAVAILABLE.

Only accepted assets enter the listing content result. Retry policy is configuration-bounded and recorded per slot.

- [ ] **Step 7: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-asset-store.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-result-checker.test.mjs
git add server/auto-listing-asset-store.mjs server/auto-listing-image-generator.mjs server/auto-listing-result-checker.mjs server/tests/auto-listing-asset-store.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-result-checker.test.mjs
git commit -m "feat: generate and verify listing images"
~~~

---

## Task 5: Generate a Stable Russian Rich-Content Contract

**Files:**
- Create: server/auto-listing-rich-content.mjs
- Create: server/tests/auto-listing-rich-content.test.mjs

**Interfaces:** buildRichContentPrompt, validateRichContent, generateRichContent.

- [ ] **Step 1: Write failing tests**

Assert Russian output; source-fact references for all numbers/claims; accepted generated asset references only; no source image URLs; no contact details, external links, review requests, unsupported certification/effect claims, or unknown component types; deterministic hashing; and idempotent reuse.

Use an internal contract independent of Ozon transport:

~~~js
{
  version: "AUTO_LISTING_RICH_CONTENT_V1",
  language: "ru",
  blocks: [
    { type: "HERO_IMAGE", assetId: "asset-main" },
    { type: "HEADING", text: "..." },
    { type: "TEXT", text: "...", sourceFactIds: ["fact.material"] },
    { type: "IMAGE_TEXT", assetId: "asset-selling-01", text: "...", sourceFactIds: ["fact.capacity"] },
  ],
}
~~~

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-rich-content.test.mjs
~~~

- [ ] **Step 3: Implement generation and validation**

Pass only the fact registry and accepted assets. Validate the closed schema and every sourceFactId. Store model/profile/template versions, prompt hash, source/asset hash, checker outcome, and output hash. Same input hash returns the accepted result.

- [ ] **Step 4: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-rich-content.test.mjs
git add server/auto-listing-rich-content.mjs server/tests/auto-listing-rich-content.test.mjs
git commit -m "feat: generate traceable Russian rich content"
~~~

---

## Task 6: Add the Durable AI Queue and Worker

**Files:**
- Create: server/auto-listing-ai-queue.mjs
- Create: server/auto-listing-ai-worker.mjs
- Create: server/auto-listing-ai-orchestrator.mjs
- Create: server/tests/auto-listing-ai-queue.test.mjs
- Create: server/tests/auto-listing-ai-worker.test.mjs
- Modify: package.json
- Modify: server/auto-listing-runtime.mjs

**Interfaces:** queue name auto-listing-ai-v1; plan/generate/check/rich-content phases.

- [ ] **Step 1: Write failing queue/worker tests**

Prove outbox claim leases, duplicate publication safety, crash recovery, stale worker version conflicts, one-slot retry, sibling isolation, minimum-six handling, main-image blocking, state events, and no gateway call after cancellation.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-ai-queue.test.mjs server/tests/auto-listing-ai-worker.test.mjs
~~~

- [ ] **Step 3: Implement outbox publication and pg-boss work**

The API transaction writes an outbox event; the publisher sends auto-listing-ai-v1 with a deterministic singleton key. Worker payload contains only accountId, itemId, phase, slotKey when relevant, expected status_version, and correlationId. The worker reloads all facts/config under account scope.

- [ ] **Step 4: Implement orchestration phases**

~~~text
SOURCE_READY -> PLANNING -> GENERATING
GENERATING -> READY_FOR_REVIEW when upload mode is review
GENERATING -> UPLOAD_QUEUED when upload mode is direct
~~~

Plan 2 can produce READY_FOR_REVIEW. Direct upload remains disabled until plan 4 connects the existing Ozon pipeline. Batch siblings progress independently and job summary is derived from item states.

- [ ] **Step 5: Add the worker script**

Add package script:

~~~json
"auto-listing-worker": "node server/auto-listing-ai-worker.mjs"
~~~

Use separate concurrency and timeouts for planning, image generation, checking, and rich content. No timeout may be unbounded.

- [ ] **Step 6: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-ai-queue.test.mjs server/tests/auto-listing-ai-worker.test.mjs
git add server/auto-listing-ai-queue.mjs server/auto-listing-ai-worker.mjs server/auto-listing-ai-orchestrator.mjs server/auto-listing-runtime.mjs server/tests/auto-listing-ai-queue.test.mjs server/tests/auto-listing-ai-worker.test.mjs package.json
git commit -m "feat: run durable AI content jobs"
~~~

---

## Task 7: Expose Admin Gateway and Strategy Controls Safely

**Files:**
- Modify: server/auto-listing-routes.mjs
- Modify: server/auto-listing-runtime.mjs
- Create: server/tests/ai-content-admin-routes.test.mjs

**Interfaces:** admin profile test/publish and strategy version publish routes.

- [ ] **Step 1: Write failing admin-route tests**

Assert ordinary users receive 403; profile reads redact api_key_env_name if environment naming is considered sensitive; no route accepts a raw API key; capability test has audit events; published strategies are immutable; in-flight items keep old profile/strategy versions; new items use newly published versions.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/ai-content-admin-routes.test.mjs
~~~

- [ ] **Step 3: Add admin-only routes**

~~~text
GET  /admin/auto-listing/ai-profiles
POST /admin/auto-listing/ai-profiles
POST /admin/auto-listing/ai-profiles/:id/test
POST /admin/auto-listing/ai-profiles/:id/publish
GET  /admin/auto-listing/strategies/versions
POST /admin/auto-listing/strategies/versions
POST /admin/auto-listing/strategies/versions/:id/publish
~~~

A profile body contains an environment-variable reference, never a secret value. Publish succeeds only after the selected text and image capability tests pass.

- [ ] **Step 4: Confirm GREEN and commit**

~~~bash
node --test server/tests/ai-content-admin-routes.test.mjs
git add server/auto-listing-routes.mjs server/auto-listing-runtime.mjs server/tests/ai-content-admin-routes.test.mjs
git commit -m "feat: manage AI generation profiles"
~~~

---

## Plan 2 Verification Gate

- [ ] Run all always-on AI pipeline tests:

~~~bash
node --test server/tests/auto-listing-ai-migration.test.mjs server/tests/sub2api-ai-adapter.test.mjs server/tests/ai-gateway-profile-service.test.mjs server/tests/auto-listing-visual-groups.test.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-asset-store.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-result-checker.test.mjs server/tests/auto-listing-rich-content.test.mjs server/tests/auto-listing-ai-queue.test.mjs server/tests/auto-listing-ai-worker.test.mjs server/tests/ai-content-admin-routes.test.mjs
~~~

- [ ] Run configured PostgreSQL tests and one explicit nonproduction sub2api capability test. Record gateway version, profile version, selected models, supported protocols, result, and cost-bearing nature of the image probe.

- [ ] Regress object storage and module boundaries:

~~~bash
node --test server/tests/object-cleanup-queue.test.mjs server/tests/object-cleanup-worker.test.mjs server/tests/module-boundaries.test.mjs
~~~

- [ ] Rollback: set AUTO_LISTING_AI_ENABLED=0 and stop auto-listing-worker. Keep immutable plans/assets/events for audit; do not remove shared object-storage assets until the existing cleanup policy marks them unreferenced.

## Task 4 review repair round 4 handoff

Generated-image object keys are now exact attempt-scoped `ATTEMPT_V2` paths. Migration-labeled `LEGACY_V1` remains read-only, and new accepted/cleanup writes cannot select it. Cleanup adopts any exact same-account generation reference under a live lease CAS before deletion, with terminal ADOPTED audit. Additive migration 030 upgrades already-recorded 029 databases and keeps legacy cleanup lifecycle updates recoverable.

Verification evidence: focused 65 pass/1 dedicated-PostgreSQL skip; auto-listing 225 pass/1 skip; migration contracts 22 pass/2 skips; selected historical boundaries 42 pass; whole `*.test.mjs` 937 pass/5 skips; raw `*.mjs` 949 pass/1 expected dedicated-URL environment failure/6 skips; Vite build 4,833 modules; changed-module syntax and diff check clean. The feature remains disabled/unwired, the dedicated PostgreSQL behavior fixture did not run, and this handoff enters independent review without self-declaring Task 4 complete.

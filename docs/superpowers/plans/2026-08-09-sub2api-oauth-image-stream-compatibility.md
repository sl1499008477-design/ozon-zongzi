# sub2API OAuth Image Stream Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept sub2API OAuth's completed streamed image snapshots and recommend `gpt-5.4` as an unverified image-orchestration-compatible text model when an OpenAI image model is present.

**Architecture:** Keep the existing `/v1/responses` image-tool request, authorization, paid reservation, model evidence, and immutable profile contracts. Extend only the bounded SSE final-image reducer, then introduce a versioned pure recommendation rule that is recomputed by the frontend validator; historical V1 catalogs remain readable and V2 results remain unverified until the administrator runs the paid capability test.

**Tech Stack:** Node.js 24, ECMAScript modules, `node:test`, React/Vite, existing sub2API adapter and AI settings contracts.

## Global Constraints

- No real sub2API generation, paid AI call, Ozon call, prompt logging, image-body logging, or credential output during implementation and automated verification.
- Historical profiles, attempts, capability results, provider idempotency keys, and audit rows are immutable and must not be rewritten.
- A partial image is usable only after a successful `response.completed`; formal final output wins over partial output.
- `gpt-5.4` is a recommendation hint, never an implicit model substitution and never verified without the paid capability test.
- V1 recommendation catalogs remain accepted; unknown recommendation versions fail closed.
- Preserve the user's unrelated dirty documentation files and stage only files named by each task.

---

### Task 1: Strict completed partial-image stream parsing

**Files:**
- Modify: `server/tests/sub2api-ai-adapter.test.mjs`
- Modify: `server/sub2api-ai-adapter.mjs:909-942`

**Interfaces:**
- Consumes: parsed SSE event objects from the existing `parseSse(raw)` boundary.
- Produces: the existing `finalImageFromEvents(events, maxImageBytes)` result `{bytes, usage, responseId, orchestratorModel, gatewayReportedImageModels}`; no public adapter signature changes.

- [ ] **Step 1: Replace the old partial-image rejection fixture with a completed-stream RED**

Use fake SSE only. Add a successful `response.completed` after the documented partial event and assert that `generateImage()` returns the decoded PNG:

```js
test("Responses image-tool accepts the last documented partial image after successful completion", async () => {
  const sse = [
    "event: response.image_generation_call.partial_image",
    `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_1X1}","partial_image_index":0,"output_format":"png"}`,
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-image\",\"status\":\"completed\",\"model\":\"gpt-5.4\"}}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const gateway = adapter(async () => new Response(sse, {
    headers: { "content-type": "text/event-stream" },
  }));

  const result = await gateway.generateImage(imageInput());
  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG_1X1, "base64"));
  assert.equal(result.orchestratorModel, "gpt-5.4");
});
```

- [ ] **Step 2: Run the focused test and verify the expected RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test --test-name-pattern='last documented partial image' \
  server/tests/sub2api-ai-adapter.test.mjs
```

Expected: FAIL with `INVALID_GATEWAY_RESPONSE`, proving the existing reducer ignores `partial_image_b64`.

- [ ] **Step 3: Add malformed, ordering, final-precedence, and terminal-state RED cases**

Add table-driven fake SSE tests for:

```js
const invalidPartials = [
  { partial_image_b64: "", partial_image_index: 0 },
  { partial_image_b64: PNG_1X1, partial_image_index: -1 },
  { partial_image_b64: PNG_1X1, partial_image_index: 1.5 },
];
```

Also assert:

- indices `0, 1` select index `1`;
- duplicate `0, 0` and descending `1, 0` fail with `INVALID_GATEWAY_RESPONSE`;
- a formal `response.output_item.done.item.result` takes precedence over a partial snapshot;
- partial + `[DONE]` without `response.completed` remains rejected;
- partial followed by `response.failed` remains rejected;
- decoded bytes beyond `maxImageBytes` remain rejected by the existing boundary.

- [ ] **Step 4: Run the new cases and verify each fails for the missing reducer behavior**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test --test-name-pattern='partial image|partial-image|formal final' \
  server/tests/sub2api-ai-adapter.test.mjs
```

Expected: the successful completed-partial and ordering/precedence expectations fail; existing terminal and size protections remain green.

- [ ] **Step 5: Implement the minimal bounded reducer change**

In `finalImageFromEvents`, keep formal and partial results separate:

```js
let finalEncoded = "";
let partialEncoded = "";
let lastPartialIndex = -1;

if (event?.type === "response.image_generation_call.partial_image") {
  const index = event.partial_image_index;
  const value = typeof event.partial_image_b64 === "string" ? event.partial_image_b64.trim() : "";
  if (!Number.isSafeInteger(index) || index < 0 || index <= lastPartialIndex || !value) {
    throw gatewayError("INVALID_GATEWAY_RESPONSE");
  }
  lastPartialIndex = index;
  partialEncoded = value;
}
```

Write formal output into `finalEncoded`, then after the event loop choose `finalEncoded || partialEncoded`. Continue requiring `completed === true` before calling `strictBase64`.

- [ ] **Step 6: Run the complete adapter suite**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test server/tests/sub2api-ai-adapter.test.mjs
```

Expected: PASS, no network access and no secret/image output in test logs.

- [ ] **Step 7: Commit Task 1**

```bash
git add server/sub2api-ai-adapter.mjs server/tests/sub2api-ai-adapter.test.mjs
git commit -m "fix(ai-settings): accept completed OAuth image snapshots"
```

---

### Task 2: Versioned OAuth image-orchestrator recommendation

**Files:**
- Modify: `server/tests/auto-listing-ai-model-recommendation.test.mjs`
- Modify: `server/auto-listing-ai-model-recommendation.mjs`

**Interfaces:**
- Consumes: the existing normalized catalog `{models}`.
- Produces: `recommendAutoListingModels(catalog)` with rule version `AUTO_LISTING_MODEL_RECOMMENDATION_V2`; candidate DTO shape is unchanged, and the new reason is `SUB2API_OAUTH_IMAGE_ORCHESTRATOR_HINT`.

- [ ] **Step 1: Write the V2 ranking RED**

```js
test("gpt-5.4 gains an unverified OAuth image-orchestrator hint only beside an OpenAI image model", () => {
  const result = recommendAutoListingModels({ models: [
    { id: "gpt-5.5", ownedBy: "openai", metadata: {} },
    { id: "gpt-5.4", ownedBy: "openai", metadata: {} },
    { id: "gpt-image-2", ownedBy: "openai", metadata: {} },
  ] });

  assert.equal(result.ruleVersion, "AUTO_LISTING_MODEL_RECOMMENDATION_V2");
  assert.equal(result.textCandidates[0].modelId, "gpt-5.4");
  assert.deepEqual(result.textCandidates[0].reasonCodes,
    ["MODEL_ID_TEXT_HINT", "SUB2API_OAUTH_IMAGE_ORCHESTRATOR_HINT"]);
  assert.equal(result.textCandidates[0].verified, false);
});
```

Add a second test proving a catalog without a `gpt-image-*` candidate gives `gpt-5.4` no compatibility reason.

- [ ] **Step 2: Run recommendation tests and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test server/tests/auto-listing-ai-model-recommendation.test.mjs
```

Expected: FAIL because the current result is V1 and contains no compatibility reason.

- [ ] **Step 3: Implement V2 with a fixed explainable weight**

Add the fixed weight and exact compatibility predicates:

```js
export const RECOMMENDATION_RULE_VERSION = "AUTO_LISTING_MODEL_RECOMMENDATION_V2";

export const WEIGHTS = Object.freeze({
  DECLARED_STRUCTURED_TEXT: 100,
  DECLARED_RESPONSES_PROTOCOL: 60,
  DECLARED_IMAGE_GENERATION: 100,
  DECLARED_REFERENCE_IMAGE: 40,
  DECLARED_TARGET_RESOLUTION: 20,
  MODEL_ID_TEXT_HINT: 10,
  MODEL_ID_IMAGE_HINT: 10,
  SUB2API_OAUTH_IMAGE_ORCHESTRATOR_HINT: 30,
});

const OAUTH_IMAGE_ORCHESTRATOR_MODEL = "gpt-5.4";
const OPENAI_IMAGE_MODEL = /^gpt-image(?:-|$)/u;
```

Compute `hasOpenAiImageCandidate` once from the normalized catalog. Append the compatibility reason only to the exact `gpt-5.4` text candidate when that flag is true. Preserve deterministic reason order, score sorting, the 50-candidate bound, immutability, and `verified: false`.

- [ ] **Step 4: Run model recommendation and sync-service suites**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-ai-model-recommendation.test.mjs \
  server/tests/auto-listing-ai-model-sync-service.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add server/auto-listing-ai-model-recommendation.mjs \
  server/tests/auto-listing-ai-model-recommendation.test.mjs
git commit -m "feat(ai-settings): recommend OAuth image orchestrator"
```

---

### Task 3: Strict V1/V2 client validation and visible recommendation reason

**Files:**
- Modify: `app/tests/auto-listing-ai-settings-client.test.mjs`
- Modify: `app/tests/auto-listing-ai-settings-view.test.mjs`
- Modify: `app/src/auto-listing-ai-settings-client.js`
- Modify: `app/src/auto-listing-ai-settings-view.js`

**Interfaces:**
- Consumes: immutable V1 historical recommendation DTOs and V2 recommendation DTOs produced by Task 2.
- Produces: the existing `loadAiSettings`/catalog-detail contract and `aiSettingsPresentation` DTO; no route or component signature changes.

- [ ] **Step 1: Write client V1/V2 compatibility RED tests**

Use `recommendAutoListingModels()` to create a real V2 fixture and prove the client accepts it. Keep a frozen V1 fixture and prove it remains accepted. Add negative cases for unknown V3, a forged compatibility reason, a forged score, wrong reason order, and V2 compatibility reason without a `gpt-image-*` catalog model.

```js
const recommendation = recommendAutoListingModels({ models });
assert.equal(recommendation.ruleVersion, "AUTO_LISTING_MODEL_RECOMMENDATION_V2");
```

- [ ] **Step 2: Run the client test and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test app/tests/auto-listing-ai-settings-client.test.mjs
```

Expected: FAIL because the client currently accepts only `AUTO_LISTING_MODEL_RECOMMENDATION_V1` and cannot recompute the new reason.

- [ ] **Step 3: Implement rule-version-specific canonical recomputation**

Add the V2 reason weight to the text reason map, but select allowed logic by `ruleVersion`:

```js
const RECOMMENDATION_VERSIONS = new Set([
  "AUTO_LISTING_MODEL_RECOMMENDATION_V1",
  "AUTO_LISTING_MODEL_RECOMMENDATION_V2",
]);
```

For V1, recompute exactly the old candidates. For V2, append the compatibility reason only under the exact Task 2 predicate. Adjust confidence validation so a low-confidence candidate may contain `MODEL_ID_TEXT_HINT` followed by `SUB2API_OAUTH_IMAGE_ORCHESTRATOR_HINT`; declared candidates may contain declared reasons followed by the compatibility reason. Unknown versions and any noncanonical combination remain false.

- [ ] **Step 4: Write and verify the presentation RED**

Add the new reason to a V2 candidate fixture and assert the presentation text is exactly:

```js
"OAuth 图片编排兼容提示（待验证）"
```

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test app/tests/auto-listing-ai-settings-view.test.mjs
```

Expected: FAIL because the reason is currently filtered out.

- [ ] **Step 5: Add the safe localized reason label**

Extend only the closed `REASONS` map in `auto-listing-ai-settings-view.js`:

```js
SUB2API_OAUTH_IMAGE_ORCHESTRATOR_HINT: "OAuth 图片编排兼容提示（待验证）",
```

Do not turn the recommendation into capability evidence or modify server-owned action gates.

- [ ] **Step 6: Run client, view, page, and settings E2E regressions**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  app/tests/auto-listing-ai-settings-client.test.mjs \
  app/tests/auto-listing-ai-settings-view.test.mjs \
  app/tests/auto-listing-ai-settings-page-contract.test.mjs \
  server/tests/auto-listing-ai-settings-e2e.test.mjs
```

Expected: PASS, with PostgreSQL-only cases skipped only when their explicit opt-in variable is absent.

- [ ] **Step 7: Commit Task 3**

```bash
git add app/src/auto-listing-ai-settings-client.js \
  app/src/auto-listing-ai-settings-view.js \
  app/tests/auto-listing-ai-settings-client.test.mjs \
  app/tests/auto-listing-ai-settings-view.test.mjs
git commit -m "feat(ai-settings): validate OAuth model recommendations"
```

---

### Task 4: Integrated verification and local service restart

**Files:**
- No source files; this task runs verification, branch integration, and local lifecycle checks.
- Do not modify: local credential files, historical database rows, or the user's unrelated dirty documents.

**Interfaces:**
- Consumes: Tasks 1-3 on the isolated branch.
- Produces: verified local code and restarted API/Web/worker; the administrator retains control of the only real paid test.

- [ ] **Step 1: Run syntax, focused, and adjacent regressions**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check \
  server/sub2api-ai-adapter.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check \
  server/auto-listing-ai-model-recommendation.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/sub2api-ai-adapter.test.mjs \
  server/tests/auto-listing-ai-model-recommendation.test.mjs \
  server/tests/auto-listing-ai-model-sync-service.test.mjs \
  app/tests/auto-listing-ai-settings-client.test.mjs \
  app/tests/auto-listing-ai-settings-view.test.mjs \
  app/tests/auto-listing-ai-settings-page-contract.test.mjs \
  server/tests/auto-listing-ai-settings-e2e.test.mjs
```

Expected: 0 failures.

- [ ] **Step 2: Run the production frontend build**

```bash
PATH='/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/usr/local/bin:/usr/bin:/bin' \
  pnpm --dir app build
```

Expected: successful Vite build; the existing chunk-size warning is non-blocking.

- [ ] **Step 3: Run full repository verification without loading local secrets**

Use the established verification-only environment and source extension baseline:

```bash
QH_LOCAL_NO_DOTENV=1 \
QH_SOURCE_EXTENSION_DIR='/Users/songliang/Desktop/0.13.46.1' \
POSTGRES_PASSWORD='verify-only-postgres' POSTGRES_PORT=55432 \
MINIO_ACCESS_KEY='verify-only-minio' MINIO_SECRET_KEY='verify-only-minio-secret' \
MINIO_PORT=59000 MINIO_CONSOLE_PORT=59001 \
APP_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
SONLI_ADMIN_PASSWORD='verify-only-admin-password' WEB_PORT=58080 \
PATH='/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/usr/local/bin:/usr/bin:/bin' \
pnpm verify
```

Expected: 0 failures. Record exact pass/skip totals rather than copying an older run.

- [ ] **Step 4: Inspect the final diff and secret boundary**

```bash
git diff --check
git status --short
git diff main...HEAD -- \
  server/sub2api-ai-adapter.mjs \
  server/auto-listing-ai-model-recommendation.mjs \
  app/src/auto-listing-ai-settings-client.js \
  app/src/auto-listing-ai-settings-view.js
```

Confirm no Key, Authorization value, prompt, Base64 fixture beyond existing test fixtures, raw SSE capture, local password, or database secret was added.

- [ ] **Step 5: Integrate the verified branch using the user's selected finishing option**

Use `superpowers:finishing-a-development-branch`. Do not push because no remote is configured unless the user explicitly adds one and requests a push.

- [ ] **Step 6: Restart local application services and perform only free health checks**

Restart the existing dev process so API, Web, and worker load the new code. Verify only:

```text
http://127.0.0.1:3000/
http://127.0.0.1:3001/health
http://127.0.0.1:8080/health
```

Do not click the paid capability-test action.

- [ ] **Step 7: Hand off the single manual paid acceptance test**

Tell the administrator to refresh the settings page, sync models, create a fresh profile using text `gpt-5.4` and image `gpt-image-1` or `gpt-image-2`, save it, review the cost warning, then click the capability test once. Report the exact profile version and result without altering failed history.

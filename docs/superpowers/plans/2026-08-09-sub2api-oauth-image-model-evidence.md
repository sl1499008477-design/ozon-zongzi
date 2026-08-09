# sub2API OAuth Image Model Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Stop treating the OAuth Responses orchestrator model as the selected image model while preserving fail-closed rejection of explicit conflicting image-model evidence.

**Architecture:** Keep the public adapter and \`modelEvidence\` contract unchanged. Inside the Responses image parser, preserve provenance by collecting explicit image-tool models separately from ambiguous \`image_generation_call.model\` values, then discard an ambiguous output-item value only when it exactly equals the completed response's orchestrator model. Explicit image fields and every other output-item model continue through the existing exact-match validator.

**Tech Stack:** Node.js 24, ECMAScript modules, Node test runner, existing \`server/sub2api-ai-adapter.mjs\` adapter and \`server/tests/sub2api-ai-adapter.test.mjs\` tests.

## Global Constraints

- Do not modify sub2API, OAuth accounts, model mappings, database schema, frontend DTOs, paid-test authorization, or audit contracts.
- Do not treat \`gpt-5.4\` as an alias of \`gpt-image-2\`.
- Do not invent \`gatewayReportedImageModel\` when the gateway supplies no explicit image-model evidence.
- Explicit conflicting image-tool evidence must remain \`AI_GATEWAY_MODEL_MISMATCH\` and non-retryable.
- Do not log prompts, images, Authorization values, OAuth tokens, API keys, or raw provider responses.
- Do not execute a real AI, image-generation, paid capability, or Ozon request.
- Preserve the user's unrelated modified files under \`docs/plans/2026-08-01-seller-context-auto-recovery-design.md\` and \`docs/superpowers/plans/2026-08-01-seller-context-auto-recovery.md\`.

---

### Task 1: Classify OAuth Responses image models by provenance

**Files:**
- Modify: \`server/tests/sub2api-ai-adapter.test.mjs:1228-1295\`
- Modify: \`server/sub2api-ai-adapter.mjs:909-954\`
- Modify: \`server/sub2api-ai-adapter.mjs:1604-1646\`

**Interfaces:**
- Consumes: existing SSE events accepted by \`parseSse(raw)\` and the selected image model passed to \`verifiedReportedModel(expectedModel, candidates)\`.
- Produces: the unchanged image result contract \`{ model, orchestratorModel, modelEvidence: { requestedImageModel, gatewayReportedImageModel, gatewayReportedImageModelPresent, orchestratorModel } }\`.
- Internal rule: explicit image models are \`response.image_model\` and \`response.tools[]\` entries with \`type === "image_generation"\`; output-item models are \`image_generation_call.model\` values from streamed or completed output items.

- [ ] **Step 1: Add the failing OAuth orchestrator regression test**

Add this test beside the existing image model evidence test in \`server/tests/sub2api-ai-adapter.test.mjs\`:

\`\`\`js
test("Responses image-tool does not classify the completed orchestrator model as image-model evidence", async () => {
  const gateway = adapter(async () => new Response([
    \`event: response.output_item.done\\ndata: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","model":"gpt-5.4","result":"\${PNG_1X1}"}}\`,
    "event: response.completed\\ndata: {\\"type\\":\\"response.completed\\",\\"response\\":{\\"status\\":\\"completed\\",\\"model\\":\\"gpt-5.4\\"}}",
    "data: [DONE]", "",
  ].join("\\n\\n"), { headers: { "content-type": "text/event-stream" } }));

  const result = await gateway.generateImage(imageInput({
    profile: { ...profile, textModel: "gpt-5.4", imageModel: "gpt-image-2" },
    model: "gpt-image-2",
  }));

  assert.equal(result.orchestratorModel, "gpt-5.4");
  assert.deepEqual(result.modelEvidence, {
    requestedImageModel: "gpt-image-2",
    gatewayReportedImageModel: "",
    gatewayReportedImageModelPresent: false,
    orchestratorModel: "gpt-5.4",
  });
});
\`\`\`

- [ ] **Step 2: Run the focused test and verify RED**

Run:

\`\`\`bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='completed orchestrator model' server/tests/sub2api-ai-adapter.test.mjs
\`\`\`

Expected: FAIL because \`verifiedReportedModel\` receives \`gpt-5.4\` as an image candidate and throws \`AI_GATEWAY_MODEL_MISMATCH\`.

- [ ] **Step 3: Add failing explicit-conflict and mixed-conflict coverage**

Extend the image model evidence test with these streamed responses:

\`\`\`js
for (const completedResponse of [
  { status: "completed", model: "gpt-5.4", image_model: "gpt-image-1" },
  {
    status: "completed",
    model: "gpt-5.4",
    image_model: "gpt-image-2",
    tools: [{ type: "image_generation", model: "gpt-image-1" }],
  },
]) {
  const gateway = adapter(async () => new Response([
    \`event: response.output_item.done\\ndata: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","result":"\${PNG_1X1}"}}\`,
    \`event: response.completed\\ndata: \${JSON.stringify({ type: "response.completed", response: completedResponse })}\`,
    "data: [DONE]", "",
  ].join("\\n\\n"), { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(
    gateway.generateImage(imageInput({
      profile: { ...profile, textModel: "gpt-5.4", imageModel: "gpt-image-2" },
      model: "gpt-image-2",
    })),
    (error) => error?.code === "AI_GATEWAY_MODEL_MISMATCH" && error?.retryable === false,
  );
}
\`\`\`

Run the complete adapter test once before implementation. Expected: the new orchestrator test fails while explicit-conflict cases already fail closed.

- [ ] **Step 4: Implement provenance-preserving model collection**

Add a focused internal helper above \`finalImageFromEvents\`:

\`\`\`js
function imageModelsByProvenance(orchestratorModel, explicitModels, outputItemModels) {
  const orchestrator = clean(orchestratorModel);
  return [
    ...explicitModels.map((value) => clean(value)).filter(Boolean),
    ...outputItemModels.map((value) => clean(value))
      .filter((value) => value && value !== orchestrator),
  ];
}
\`\`\`

Change \`finalImageFromEvents\` to collect two arrays:

\`\`\`js
const explicitImageModels = [];
const outputItemModels = [];
\`\`\`

For both streamed \`response.output_item.done\` items and completed \`response.output[]\` items, append \`item.model\` only to \`outputItemModels\`. Append \`response.image_model\` and \`image_generation\` tool models only to \`explicitImageModels\`. After all events have been processed, derive the existing return field:

\`\`\`js
const gatewayReportedImageModels = imageModelsByProvenance(
  orchestratorModel,
  explicitImageModels,
  outputItemModels,
);
\`\`\`

Apply the same classification to the non-SSE Responses JSON branch in \`generateResponsesImage\`: use \`payload.model\` as the orchestrator, keep \`payload.image_model\` and tool models explicit, keep output-item models separate, and call \`verifiedReportedModel\` with \`imageModelsByProvenance(...)\`.

- [ ] **Step 5: Run the adapter test and verify GREEN**

Run:

\`\`\`bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/sub2api-ai-adapter.test.mjs
\`\`\`

Expected: all adapter tests pass with zero failures; the new OAuth orchestrator case records no fabricated image model, and explicit conflicts still fail closed.

- [ ] **Step 6: Run adjacent paid-capability and settings regressions**

Run:

\`\`\`bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/sub2api-ai-adapter.test.mjs server/tests/auto-listing-ai-admin-service.test.mjs server/tests/auto-listing-ai-settings-runtime.test.mjs server/tests/auto-listing-ai-settings-e2e.test.mjs
\`\`\`

Expected: zero failures. Configured PostgreSQL opt-in skips, if any, must be reported rather than treated as passes.

- [ ] **Step 7: Verify syntax and patch cleanliness**

Run:

\`\`\`bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/sub2api-ai-adapter.mjs
git diff --check
git status --short
\`\`\`

Expected: syntax and diff checks pass. Only the adapter and its test may be modified; the two user-owned recovery documents remain modified but unstaged.

- [ ] **Step 8: Commit the implementation**

\`\`\`bash
git add -- server/sub2api-ai-adapter.mjs server/tests/sub2api-ai-adapter.test.mjs
git commit -m "fix(ai-settings): distinguish OAuth image orchestrator evidence"
\`\`\`

- [ ] **Step 9: Perform post-commit verification**

Run the Step 6 regression command again, then:

\`\`\`bash
git show --check --stat HEAD
git status --short
\`\`\`

Expected: regression command exits zero; the implementation commit contains exactly two files; the two unrelated recovery documents remain outside the commit.

## Rollback

Revert only the implementation commit created in Task 1. No database, account, key, or external-service recovery is needed. After rollback, OAuth Responses streams that repeat the orchestrator in \`image_generation_call.model\` will again fail with \`AI_GATEWAY_MODEL_MISMATCH\`.

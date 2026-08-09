# sub2API OAuth Image Tool Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Responses image tool request use sub2API OAuth-compatible automatic tool selection without changing models, persistence, paid-test authorization, or response validation.

**Architecture:** Keep the existing `SUB2API_RESPONSES_IMAGE_TOOL` adapter boundary and SSE parser. Change only the outbound `tool_choice` field from an explicit hosted-tool object to the string `"auto"`; the existing image tool declaration, model evidence, fail-closed parsing, authorization, and three-stage reservation flow remain unchanged.

**Tech Stack:** Node.js 24, ECMAScript modules, Node test runner, React/Vite.

## Global Constraints

- Do not call real sub2API, OpenAI, paid AI, or Ozon endpoints during implementation or verification.
- Do not log or persist API keys, prompts, image bytes, or raw upstream response bodies.
- Preserve `/v1/responses`, `SUB2API_RESPONSES`, `SUB2API_RESPONSES_IMAGE_TOOL`, frozen text/image models, tenant fences, leases, and idempotency keys.
- Do not modify existing capability attempts or profiles; historical evidence remains immutable.

---

### Task 1: Use OAuth-compatible automatic image tool selection

**Files:**
- Modify: `server/tests/sub2api-ai-adapter.test.mjs:893-929`
- Modify: `server/sub2api-ai-adapter.mjs:1566-1580`

**Interfaces:**
- Consumes: `createSub2ApiAiAdapter(...).generateImage(input)` with an enabled `SUB2API_RESPONSES_IMAGE_TOOL` profile.
- Produces: one authorized POST to `/v1/responses` whose JSON body retains the `image_generation` tool and uses `tool_choice: "auto"`; the existing `generateImage` result and stable gateway errors remain unchanged.

- [ ] **Step 1: Write the failing request-contract assertion**

In `server/tests/sub2api-ai-adapter.test.mjs`, update the existing successful streamed image-tool test to assert the OAuth-compatible selector and reject the old object shape:

```js
assert.deepEqual(calls[0].body.tools, [{
  type: "image_generation",
  model: "gpt-image",
  action: "generate",
  size: "1024x1024",
  quality: "medium",
  output_format: "png",
}]);
assert.equal(calls[0].body.tool_choice, "auto");
assert.notDeepEqual(calls[0].body.tool_choice, { type: "image_generation" });
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test-name-pattern='Responses image-tool protocol accepts' \
  --test server/tests/sub2api-ai-adapter.test.mjs
```

Expected: FAIL because actual `tool_choice` is `{ type: "image_generation" }`, while the test requires `"auto"`.

- [ ] **Step 3: Implement the minimal adapter change**

In `server/sub2api-ai-adapter.mjs`, change only the selector value:

```js
tool_choice: "auto",
```

Keep `model`, `input`, `tools`, `stream: true`, and `store: false` unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused command from Step 2.

Expected: PASS; the test's fake SSE response still produces the same decoded one-pixel PNG, model evidence, request ID, and usage.

- [ ] **Step 5: Run adjacent adapter and settings regression**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/sub2api-ai-adapter.test.mjs \
  server/tests/auto-listing-ai-settings-service.test.mjs \
  server/tests/auto-listing-ai-settings-routes.test.mjs \
  server/tests/auto-listing-ai-settings-e2e.test.mjs \
  app/tests/auto-listing-ai-settings-client.test.mjs \
  app/tests/auto-listing-ai-settings-view.test.mjs \
  app/tests/auto-listing-ai-settings-page-contract.test.mjs
```

Expected: all tests PASS with zero unexpected skips or external network calls.

- [ ] **Step 6: Build and verify running services**

Run:

```bash
env PATH='/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/usr/local/bin:/usr/bin:/bin' \
  /Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm --dir app build
```

Then check `http://127.0.0.1:3000/ozon/tools/auto-listing/ai-settings`, `http://127.0.0.1:3001/health`, and `http://127.0.0.1:8080/health` return HTTP 200. Do not click the paid capability-test button.

- [ ] **Step 7: Review and commit only the implementation files**

Run `git diff --check`, inspect the two implementation diffs, and preserve unrelated user changes. Commit only:

```bash
git add server/sub2api-ai-adapter.mjs server/tests/sub2api-ai-adapter.test.mjs
git commit -m "fix(ai-settings): use OAuth-compatible image tool choice"
```

After commit, the administrator manually creates a fresh profile and runs the paid capability test from the UI. No automated verification may claim real upstream success before that manual result exists.

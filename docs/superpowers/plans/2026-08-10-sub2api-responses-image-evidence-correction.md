# sub2API Responses 图片证据纠正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 sub2API OAuth 的 Responses 图片工具在成功出图后不再因未定义的模型字段误报 `AI_GATEWAY_MODEL_MISMATCH`，同时保持直接 Images API 的严格模型校验。

**Architecture:** 只修改 sub2API 适配器内部的 Responses 图片响应归一化。Responses 协议保留请求模型、外层编排模型、图片终态和真实解码证据，但不再从 `response.tools`、`image_generation_call` 或未定义的 `response.image_model` 推断实际图片后端；直接 Images 协议继续使用现有 `verifiedReportedModel` 精确校验。

**Tech Stack:** Node.js 24、ES modules、Node test runner、sharp、现有 sub2API adapter contract。

## Global Constraints

- 不修改数据库、迁移、前端 DTO、sub2API、OAuth 账号或套餐。
- 不新增模型别名、前缀匹配或 `gpt-5.4 -> gpt-image-2` 映射。
- `SUB2API_RESPONSES` 成功结果必须保留 `requestedImageModel` 和 `orchestratorModel`，并固定 `gatewayReportedImageModel=""`、`gatewayReportedImageModelPresent=false`。
- `SUB2API_OPENAI_IMAGES` 的明确模型不一致仍必须返回不可重试的 `AI_GATEWAY_MODEL_MISMATCH`。
- 不读取或记录提示词、图片、Authorization、OAuth 令牌、API Key 或原始响应。
- 实施验证不得触发真实 AI、真实付费图片生成或真实 Ozon 调用。
- 只暂存本计划列出的代码和测试文件；保留用户已有的未提交文档改动。

---

### Task 1: 按协议纠正 Responses 图片模型证据

**Files:**
- Modify: `server/tests/sub2api-ai-adapter.test.mjs`
- Modify: `server/sub2api-ai-adapter.mjs`

**Interfaces:**
- Consumes: `generateResponsesImage(input, normalizedProfile, options)` 现有内部函数和 `normalizedImage(bytes, extra)` 现有结果 shape。
- Produces: Responses 图片结果继续返回 `{model, orchestratorModel, modelEvidence, bytes, ...}`；其中 `modelEvidence` 精确为 `{requestedImageModel, gatewayReportedImageModel: "", gatewayReportedImageModelPresent: false, orchestratorModel}`。
- Preserves: `generateOpenAiImage(...)` 对直接 Images API 的 `verifiedReportedModel(...)` 调用及其错误 contract。

- [ ] **Step 1: 写 SSE 和 JSON 的失败回归测试**

在 `server/tests/sub2api-ai-adapter.test.mjs` 中用现有 `adapter(...)`、`imageInput(...)`、`PNG_1X1` fixture 新增/改写两条测试。SSE 测试同时放入三个没有稳定协议语义的字段，证明它们不会成为图片后端证据：

```js
test("Responses image-tool treats undocumented SSE model fields as non-authoritative", async () => {
  const gateway = adapter(async () => new Response([
    `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","model":"internal-image-route","result":"${PNG_1X1}"}}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        model: "gpt-5.4",
        image_model: "internal-image-route",
        tools: [{ type: "image_generation", model: "gpt-5.4" }],
      },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));

  const result = await gateway.generateImage(imageInput({
    profile: { ...profile, textModel: "gpt-5.4", imageModel: "gpt-image-2" },
    model: "gpt-image-2",
  }));

  assert.deepEqual(result.modelEvidence, {
    requestedImageModel: "gpt-image-2",
    gatewayReportedImageModel: "",
    gatewayReportedImageModelPresent: false,
    orchestratorModel: "gpt-5.4",
  });
});
```

非流式 JSON 测试使用相同字段组合，并断言相同 `modelEvidence`：

```js
test("Responses image-tool treats undocumented JSON model fields as non-authoritative", async () => {
  const gateway = adapter(async () => jsonResponse({
    id: "resp-image-json",
    model: "gpt-5.4",
    image_model: "internal-image-route",
    tools: [{ type: "image_generation", model: "gpt-5.4" }],
    output: [{
      type: "image_generation_call",
      status: "completed",
      model: "internal-image-route",
      result: PNG_1X1,
    }],
  }));

  const result = await gateway.generateImage(imageInput({
    profile: { ...profile, textModel: "gpt-5.4", imageModel: "gpt-image-2" },
    model: "gpt-image-2",
  }));

  assert.equal(result.modelEvidence.gatewayReportedImageModel, "");
  assert.equal(result.modelEvidence.gatewayReportedImageModelPresent, false);
  assert.equal(result.orchestratorModel, "gpt-5.4");
});
```

把现有 `image model evidence rejects every explicit mismatch...` 测试中的 Responses 非标准字段 mismatch 分支删除或改成上述“无权威证据”断言；保留直接 Images API 的错误模型拒绝和匹配/缺失证据断言。

- [ ] **Step 2: 运行目标测试并确认 RED**

Run:

```bash
node --test --test-name-pattern='Responses image-tool treats undocumented' server/tests/sub2api-ai-adapter.test.mjs
```

Expected: 两条新测试至少一条因 `AI_GATEWAY_MODEL_MISMATCH` 失败；不得因为 fixture、语法或图片解码失败而 RED。

- [ ] **Step 3: 实现最小协议修复**

在 `server/sub2api-ai-adapter.mjs` 删除只为 Responses 非标准字段分类而存在的 `imageModelsByProvenance(...)`，并从 `finalImageFromEvents(...)` 删除：

```js
const explicitImageModels = [];
const outputItemModels = [];
```

以及所有从 `event.item.model`、`response.image_model`、`response.tools[].model`、`response.output[].model` 收集图片模型的语句。`finalImageFromEvents(...)` 只返回真实使用的字段：

```js
return {
  bytes: strictBase64(encoded, maxImageBytes),
  usage,
  responseId,
  orchestratorModel,
};
```

SSE Responses 分支不再调用 `verifiedReportedModel(...)`，而是向 `normalizedImage(...)` 显式传入无权威回报证据：

```js
return normalizedImage(final.bytes, {
  protocol: normalizedProfile.imageProtocol,
  requestedImageModel: normalizedProfile.imageModel,
  gatewayReportedImageModel: "",
  gatewayReportedImageModelPresent: false,
  orchestratorModel: final.orchestratorModel,
  requestId: safeRequestId(execution.response) || final.responseId,
  usage: final.usage,
});
```

非流式 JSON Responses 分支只提取 `image_generation_call.result`，不读取其 `model`，并使用相同的空回报证据：

```js
return normalizedImage(strictBase64(encoded, maxImageBytes), {
  protocol: normalizedProfile.imageProtocol,
  requestedImageModel: normalizedProfile.imageModel,
  gatewayReportedImageModel: "",
  gatewayReportedImageModelPresent: false,
  orchestratorModel: clean(payload.model),
  requestId: safeRequestId(execution.response) || clean(payload.id),
  usage: payload.usage,
});
```

不要修改 `generateOpenAiImage(...)` 及其 `verifiedReportedModel(normalizedProfile.imageModel, [payload?.model, item?.model])`。

- [ ] **Step 4: 运行目标测试并确认 GREEN**

Run:

```bash
node --test --test-name-pattern='Responses image-tool treats undocumented|OpenAI Images protocol|image model evidence' server/tests/sub2api-ai-adapter.test.mjs
```

Expected: 所有选中测试通过；Responses 的 `gatewayReportedImageModelPresent` 为 `false`，直接 Images API 的 mismatch 仍失败关闭。

- [ ] **Step 5: 运行适配器和相邻设置回归**

Run:

```bash
node --test \
  server/tests/sub2api-ai-adapter.test.mjs \
  server/tests/ai-gateway-profile-service.test.mjs \
  server/tests/auto-listing-ai-settings-runtime.test.mjs \
  server/tests/auto-listing-ai-settings-e2e.test.mjs
```

Expected: 零失败；不配置 PostgreSQL 的测试只能按既有显式开关跳过。

- [ ] **Step 6: 运行语法、diff 和完整仓库门禁**

Run:

```bash
node --check server/sub2api-ai-adapter.mjs
git diff --check
QH_LOCAL_NO_DOTENV=1 \
QH_SOURCE_EXTENSION_DIR='/Users/songliang/Desktop/0.13.46.1' \
POSTGRES_PASSWORD='verify_only_postgres_2026' \
POSTGRES_PORT='55432' \
MINIO_ACCESS_KEY='verify_only_minio' \
MINIO_SECRET_KEY='verify_only_minio_secret_2026' \
MINIO_PORT='59000' \
MINIO_CONSOLE_PORT='59001' \
APP_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
SONLI_ADMIN_PASSWORD='verify_only_admin_2026' \
WEB_PORT='53000' \
pnpm verify
```

Expected: `All verification checks passed.`；浏览器夹具若受沙箱限制，必须在获准的本地浏览器环境复跑并记录实际结果，不能把取消后的级联错误当成代码失败。

- [ ] **Step 7: 提交最小修复**

```bash
git add server/sub2api-ai-adapter.mjs server/tests/sub2api-ai-adapter.test.mjs
git commit -m "fix(ai-settings): ignore undocumented Responses image models"
```

Expected: 提交只含上述两个文件，用户已有未提交文档不进入提交。

- [ ] **Step 8: 重启本地应用并做无费用验收**

停止当前 `scripts/dev.mjs` 管理的本地 Web/后端进程，然后运行：

```bash
pnpm dev
```

无费用验收：

```bash
curl -fsS -I 'http://127.0.0.1:3000/ozon/tools/auto-listing/ai-settings'
```

Expected: 页面返回 `HTTP/1.1 200 OK`。不得由实施者自动点击能力测试；由管理员确认费用后手动执行一次最终真实验收。

## Rollback

- 代码回滚：`git revert <implementation-commit>`。
- 该变更不修改数据库、配置、OAuth 账号或 sub2API 卷，无需数据恢复。
- 回滚后 Responses 图片工具可能重新出现成功出图后误报 `AI_GATEWAY_MODEL_MISMATCH`，直接 Images API 行为不变。

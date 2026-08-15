import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../src/CategoryStrategyPage.jsx", import.meta.url), "utf8").catch(() => "");
const css = await readFile(new URL("../src/category-strategy.css", import.meta.url), "utf8").catch(() => "");
const client = await readFile(new URL("../src/category-strategy-client.js", import.meta.url), "utf8").catch(() => "");
const bootstrap = await readFile(new URL("../src/category-strategy-bootstrap.js", import.meta.url), "utf8").catch(() => "");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8").catch(() => "");

test("strategy page exposes the complete safe administrator workflow", () => {
  for (const text of [
    "类目图片策略", "精确类目", "当前状态", "样本库", "继续选样", "创建新草稿", "会话剩余时间",
    "生成类目策略草稿", "预计费用", "确认生成", "图片角色规则", "证据与置信度",
    "样本差异", "注意事项", "人工编辑", "影响预览", "发布策略", "版本历史",
    "创建回滚版本", "返回并继续创建",
  ]) assert.match(page, new RegExp(text, "u"));
  for (const role of ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]) {
    assert.match(page, new RegExp(role));
  }
  assert.match(page, /ProtectedThumbnail/u);
  assert.match(page, /URL\.createObjectURL/u);
  assert.match(page, /URL\.revokeObjectURL/u);
  assert.doesNotMatch(page, /<img src=\{sample\.thumbnailUrl\}/u);
  assert.doesNotMatch(page, /analysisObjectKey|thumbnailObjectKey|rawVendor|credential|actorId/u);
  assert.doesNotMatch(page, />\s*\{accountId\}\s*</u);
});

test("paid analysis and publication remain explicit, cancelable and non-automatic", () => {
  assert.match(page, /Modal\.confirm/u);
  assert.match(page, /costConfirmed:\s*true/u);
  assert.match(page, /okText:\s*"确认生成"/u);
  assert.match(page, /cancelText:\s*"取消"/u);
  assert.match(page, /okText:\s*"确认发布"/u);
  assert.match(page, /navigate\("\/ozon\/tools\/auto-listing/u);
  assert.doesNotMatch(page, /\/auto-listing\/jobs\/from-collect-box/u);
});

test("published strategies create a successor draft instead of reopening the immutable draft", () => {
  assert.match(page, /view\?\.canCreateDraft/u);
  assert.match(page, /sourceCollectItemId:\s*detail\.sourceCollectItemId/u);
  assert.match(page, /expectedSourceVersion:\s*detail\.expectedSourceVersion/u);
  assert.match(page, /创建新草稿/u);
  assert.match(page, /disabled=\{!view\?\.canStartSampling/u);
  assert.match(page, /替换此样本/u);
  assert.match(page, /client\.removeSample/u);
});

test("samples, errors and controls are accessible without relying only on color", () => {
  assert.match(page, /aria-label=/u);
  assert.match(page, /alt=/u);
  assert.match(page, /showIcon/u);
  assert.match(page, /role="status"/u);
  assert.match(page, /label=/u);
  assert.match(css, /@media\s*\(max-width:\s*768px\)/u);
  assert.match(css, /overflow-wrap:\s*anywhere/u);
  assert.match(css, /grid-template-columns/u);
});

test("App wires a dedicated AI-tools route while retaining the existing model settings route", () => {
  assert.match(app, /import CategoryStrategyPage from "\.\/CategoryStrategyPage\.jsx"/u);
  assert.match(app, /"\/ozon\/tools\/category-strategies": "类目图片策略"/u);
  assert.match(app, /key: "\/ozon\/tools\/category-strategies", label: "类目图片策略"/u);
  assert.match(app, /route === "\/ozon\/tools\/category-strategies"/u);
  assert.match(app, /locationSearch/u);
  assert.match(app, /"\/ozon\/tools\/auto-listing\/ai-settings": "AI 模型配置"/u);
});

test("same-route strategy navigation reloads the selected draft from the query", () => {
  assert.match(page, /locationSearch/u);
  assert.match(page, /load\(routeDraftId\)/u);
  assert.match(page, /new URLSearchParams\(locationSearch\)/u);
});

test("automatic-listing handoff delegates readiness and Ozon opening to the extension bridge", () => {
  assert.match(page, /loadCategoryStrategyBootstrap/u);
  assert.match(page, /createCategoryStrategyExtensionBridge/u);
  assert.match(page, /handoffCategoryStrategySampling/u);
  assert.match(page, /from-auto-listing|from=auto-listing|autoStartSampling/u);
  assert.match(page, /extensionBridge/u);
  assert.match(page, /extensionBridge\.open\(session\.browserUrl\)/u);
  assert.doesNotMatch(page, /window\.open\(/u);
  assert.match(page, /打开 Ozon 选样页/u);
  assert.match(page, /window\.history\.replaceState/u);
  assert.match(page, /findResumableCategoryStrategyDraftId/u);
});

test("removing the draft query clears the prior detail and returns to the strategy list", () => {
  assert.match(page, /const clearBundle = useCallback/u);
  assert.match(page, /setDetail\(null\)/u);
  assert.match(page, /loadRequestRef/u);
  assert.match(page, /requestId !== loadRequestRef\.current/u);
  assert.match(page, /if \(!draftId\) clearBundle\(\);[\s\S]*await client\.list\(\)/u);
  assert.match(page, /createNextDraft[\s\S]*runAction\("new-draft", async \(context\)[\s\S]*isCurrentAction\(context\)/u);
  assert.match(page, /stateAccountId !== accountId/u);
  assert.match(page, /loadRequestRef\.current \+= 1;[\s\S]*setStrategies\(\[\]\);[\s\S]*clearBundle\(\)/u);
});

test("all write commands reuse a durable logical intent until the response is confirmed", () => {
  assert.match(page, /createCategoryStrategyIntentStore/u);
  const writeFlow = `${page}\n${bootstrap}`;
  for (const command of ["category-draft", "category-sampling", "category-sample-revision",
    "category-analysis", "category-edit", "category-publish", "category-rollback"]) {
    assert.match(writeFlow, new RegExp(`(?:intentIdentity|intents\\.identity)\\(\"${command}\"`, "u"));
  }
  assert.match(page, /replaceSample[\s\S]*intentIdentity\("category-sample-revision"[\s\S]*client\.removeSample[\s\S]*handoffCategoryStrategySampling[\s\S]*settleIntent\("category-sample-revision"/u);
  assert.match(page, /settleIntent/u);
});

test("write follow-ups cannot restore an old draft after route or account navigation", () => {
  assert.match(page, /currentAccountRef\.current/u);
  assert.match(page, /actionRequestRef/u);
  assert.match(page, /isCurrentAction\(context\)/u);
  for (const action of ["sampling", "new-draft", "analysis", "edit", "publish"]) {
    assert.match(page, new RegExp(`runAction\\("${action}", async \\(context\\)`, "u"));
  }
  assert.match(page, /runAction\(`rollback:\$\{target\.id\}`, async \(context\)/u);
});

test("the API client uses only the administrator namespace and stable write identities", () => {
  assert.match(client, /\/admin\/auto-listing\/category-strategies/u);
  assert.match(client, /expectedDraftVersion/u);
  assert.match(client, /expectedPublishedStrategyVersionId/u);
  assert.match(client, /idempotencyKey/u);
  assert.match(client, /correlationId/u);
  assert.doesNotMatch(client, /\.message\s*\|\||body\?\.message|rawResponse|apiKey|credential/u);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../src/AiModelSettingsPage.jsx", import.meta.url), "utf8").catch(() => "");
const css = await readFile(new URL("../src/auto-listing-ai-settings.css", import.meta.url), "utf8").catch(() => "");

test("administrator settings page composes the closed Task 8 client and presentation contracts", () => {
  assert.match(page, /from "\.\/auto-listing-ai-settings-client\.js"/);
  assert.match(page, /from "\.\/auto-listing-ai-settings-view\.js"/);
  for (const operation of [
    "loadAiSettings",
    "createGatewayConnection",
    "requestModelSync",
    "createModelProfile",
    "testModelProfile",
    "publishModelProfile",
    "rollbackModelProfile",
    "aiSettingsPresentation",
  ]) assert.match(page, new RegExp(`\\b${operation}\\b`));
  assert.doesNotMatch(page, /fetch\s*\(|apiRequest|\/v1\/models|\/v1\/responses|\/v1\/images/);
});

test("gateway key is one-way input state that is never hydrated or stored", () => {
  assert.match(page, /type="password"/);
  assert.match(page, /autoComplete="new-password"/);
  assert.match(page, /value=\{gatewayKey\}/);
  assert.match(page, /setGatewayKey\(""\)/);
  assert.doesNotMatch(page, /setGatewayKey\([^)]*(overview|connection|activeConnection)/);
  assert.doesNotMatch(page, /(localStorage|sessionStorage)\s*\.\s*(setItem|getItem)/);
});

test("page exposes the complete connection, synchronization, selection, paid test, publication, and history workflow", () => {
  for (const label of [
    "sub2API 连接",
    "模型同步与选择",
    "能力测试与发布",
    "当前配置与历史版本",
    "测试连接",
    "打开 sub2API 后台",
    "立即同步",
    "文字模型",
    "图片模型",
    "能力测试可能产生费用",
    "发布启用",
    "安全回退",
  ]) assert.match(page, new RegExp(label));
  assert.match(page, /latestSuccessfulSync/);
  assert.match(page, /task\.syncPurpose === "CATALOG_SYNC"/);
  assert.match(page, /successfulTaskIds\.has\(row\.syncTaskId\)/);
  assert.match(page, /result\.outcome === "FAILED" \? "失败"/);
});

test("server actions own command availability and one active request disables competing commands", () => {
  assert.match(page, /const busy = Boolean\(activeRequest\)/);
  assert.match(page, /presentation\.canCreateConnection/);
  assert.match(page, /connectionView\?\.actions\?\.canSync/);
  assert.match(page, /profileView\?\.actions\?\.canTest/);
  assert.match(page, /profileView\?\.actions\?\.canPublish/);
  assert.match(page, /view\?\.actions\?\.canRollback/);
  assert.match(page, /disabled=\{busy[^}]*\}/);
  assert.match(page, /if \(actionInFlightRef\.current\) return/);
});

test("a successful paid action consumes its explicit fee confirmation", () => {
  assert.match(page, /await testModelProfile\([\s\S]*?setCostConfirmedProfileIds\(\(current\) => current\.filter\(\(id\) => id !== selectedProfile\.id\)\)/);
  assert.match(page, /await rollbackModelProfile\([\s\S]*?setRollbackConfirmedProfileIds\(\(current\) => current\.filter\(\(id\) => id !== profile\.id\)\)/);
});

test("background account refresh cannot overwrite a dirty draft", () => {
  assert.match(page, /const \[draftDirty, setDraftDirty\] = useState\(false\)/);
  assert.match(page, /const settingsVersion = useMemo/);
  assert.match(page, /hydratedSettingsVersionRef/);
  assert.match(page, /if \(draftDirty/);
  assert.match(page, /hydratedSettingsVersionRef\.current === settingsVersion/);
  assert.match(page, /const preferredConnection = overview\.connections\?\.find\(\(row\) => row\.id === selectedConnectionId\)/);
});

test("dashboard navigation accepts only explicit HTTP origins", () => {
  assert.match(page, /\["http:", "https:"\]\.includes\(url\.protocol\)/);
  assert.match(page, /window\.open\(target, "_blank", "noopener,noreferrer"\)/);
});

test("page styling is scoped and remains usable on narrow screens", () => {
  assert.match(css, /\.ai-model-settings-page/);
  assert.match(css, /@media\s*\(max-width:\s*768px\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

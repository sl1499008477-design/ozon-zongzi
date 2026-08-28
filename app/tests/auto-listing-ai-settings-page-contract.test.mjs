import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const page = await readFile(new URL("../src/AiModelSettingsPage.jsx", import.meta.url), "utf8").catch(() => "");
const css = await readFile(new URL("../src/auto-listing-ai-settings.css", import.meta.url), "utf8").catch(() => "");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8").catch(() => "");
const appRoot = fileURLToPath(new URL("..", import.meta.url));

function browserExecutable() {
  const executable = [
    process.env.JZ_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean).find((candidate) => existsSync(candidate));
  assert.ok(executable, "Chrome/Chromium is required for the AI channel browser regression");
  return executable;
}

function browserProfile(id) {
  return { id, accountId: "account-a", displayName: `正式模型-${id}`, configVersion: 1,
    baseUrl: "https://gateway.example/v1", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
    textModel: "text-a", imageModel: "image-a", enabled: true,
    capabilityResult: { outcome: "PASSED", features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      latencyMs: 1, models: { text: "text-a", image: "image-a" }, checkedAt: "2026-08-08T00:00:00.000Z", errorCode: null },
    capabilityCheckedAt: "2026-08-08T00:00:00.000Z", connectionId: "connection-a", connectionVersion: 1,
    activation: null, createdAt: "2026-08-08T00:00:00.000Z", duplicate: false };
}

function browserChannel(overrides = {}) {
  return { channelId: "channel-a", displayName: "忙碌通道", channelOrder: 1, enabled: true, status: "BUSY",
    connectionDisplayName: "主 Gateway", connectionId: "connection-a", connectionVersion: 1, assignedItemId: "item-a",
    cooldownUntil: null, requiresRevalidation: false, lastErrorCode: null, ...overrides };
}

function browserOverview(profileId, channels = [browserChannel()]) {
  const activeProfile = browserProfile(profileId);
  return { accountId: "account-a", activeConnection: null, activeProfile, connections: [], catalogs: [], syncTasks: [],
    profiles: [activeProfile], channels, channelCandidates: [{ connectionId: "connection-b", connectionVersion: 2,
      connectionDisplayName: "备用 Gateway" }], pagination: { connections: { pageSize: 10, hasMore: false, nextCursor: null },
      profiles: { pageSize: 10, hasMore: false, nextCursor: null } }, actions: { canCreateConnection: true,
      syncableConnectionIds: [], profileCreatableCatalogIds: [], testableProfileIds: [], publishableProfileIds: [], rollbackProfileIds: [] } };
}

function browserLocalState() {
  return { account: { id: "account-a", username: "admin", displayName: "管理员", role: "admin", status: "active" },
    token: "browser-test-token", binding: null, currentStoreId: "", stores: [], summary: {}, caches: {}, jobs: {} };
}

async function settleReact(page) {
  await page.evaluate(() => new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  }));
}

async function waitForChannelSelector(page) {
  await page.waitForFunction(() => {
    const input = document.querySelector(".ai-model-settings-channel-add input");
    return input && input.disabled === false;
  });
}

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
    "addAutoListingAiChannel",
    "setAutoListingAiChannelEnabled",
    "aiSettingsPresentation",
  ]) assert.match(page, new RegExp(`\\b${operation}\\b`));
  assert.doesNotMatch(page, /fetch\s*\(|apiRequest|\/v1\/models|\/v1\/responses|\/v1\/images/);
});

test("independent channel controls stay below the one shared model and protocol selection", () => {
  assert.match(page, /function AutoListingChannelSection/);
  assert.match(page, /自动上架独立通道/);
  assert.match(page, /当前商品完成后停用生效/);
  const selection = page.indexOf("function ModelSelectionSection");
  const channels = page.indexOf("function AutoListingChannelSection");
  assert.ok(selection >= 0 && channels > selection);
  const channelSection = page.slice(channels, page.indexOf("function CapabilityPublishSection", channels));
  assert.doesNotMatch(channelSection, /文字模型|图片模型|textProtocol|imageProtocol|gatewayKey|baseUrl/);
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

test("saving a successor profile is enabled only by the server-owned catalog action", () => {
  assert.match(page, /presentation\.profileCreatableCatalogIds\.includes\(currentCatalog\?\.id\)/);
  assert.match(page, /const canSaveSelection = Boolean\(/);
  assert.match(page, /disabled=\{busy \|\| !canSaveSelection\}/);
});

test("new sub2API profiles use the Responses image tool instead of the incompatible Images bridge", () => {
  assert.match(page, /imageProtocol:\s*"SUB2API_RESPONSES_IMAGE_TOOL"/);
  assert.doesNotMatch(page, /imageProtocol:\s*"SUB2API_OPENAI_IMAGES"/);
});

test("an unloaded catalog renders safely and a loaded catalog preserves its closed envelope", () => {
  assert.match(page, /aiSettingsCatalogForSummary\(catalogDetail, currentCatalogSummary\)/);
  assert.match(page, /currentCatalog\.catalog\.models\.length/);
  assert.doesNotMatch(page, /catalogDetail\?\.catalog\?\.id === currentCatalogSummary\?\.id/);
});

test("a successful paid action consumes its explicit fee confirmation", () => {
  assert.match(page, /await testModelProfile\([\s\S]*?setCostConfirmedProfileIds\(\(current\) => current\.filter\(\(id\) => id !== selectedProfile\.id\)\)/);
  assert.match(page, /await rollbackModelProfile\([\s\S]*?setRollbackConfirmedProfileIds\(\(current\) => current\.filter\(\(id\) => id !== profile\.id\)\)/);
});

test("account and connection boundaries cannot carry a gateway key into another scope", () => {
  assert.match(app, /<AiModelSettingsPage\s+key=\{`ai-settings:\$\{account\?\.id \|\| ""\}:\$\{account\?\.role \|\| ""\}`\}/);
  assert.match(page, /createAiSettingsIntentStore\(\s*accountScopedSessionStorage\(accountId\)/);
  assert.match(page, /activeActionControllerRef\.current\?\.abort\(\)/);
  assert.match(page, /onConnectionChange[\s\S]*?setGatewayKey\(""\)/);
  assert.match(page, /requestModelSync\([\s\S]*?withSignal\(syncIntent, signal\)/);
});

test("background account refresh cannot overwrite a dirty draft", () => {
  assert.match(page, /const \[draftDirty, setDraftDirty\] = useState\(false\)/);
  assert.match(page, /const settingsVersion = useMemo/);
  assert.match(page, /hydratedSettingsVersionRef/);
  assert.match(page, /if \(draftDirty/);
  assert.match(page, /hydratedSettingsVersionRef\.current === settingsVersion/);
  assert.match(page, /const preferredConnection = overview\.connections\?\.find\(\(row\) => row\.id === selectedConnectionId\)/);
  assert.match(page, /setSelectedProfileId\(\(current\) => overview\.profiles\?\.some\(\(row\) => row\.id === current\)[\s\S]*?current/);
});

test("dashboard navigation accepts only explicit HTTP origins", () => {
  assert.match(page, /\["http:", "https:"\]\.includes\(url\.protocol\)/);
  assert.match(page, /window\.open\(target, "_blank", "noopener,noreferrer"\)/);
});

test("page styling is scoped and remains usable on narrow screens", () => {
  assert.match(css, /\.ai-model-settings-page/);
  assert.match(css, /@media\s*\(max-width:\s*768px\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  const topLevelSelectors = [...css.matchAll(/(?:^|\n)(\.[^{\n]+)\s*\{/gu)].map((match) => match[1].trim());
  assert.ok(topLevelSelectors.length > 0);
  for (const selector of topLevelSelectors) assert.match(selector, /^\.ai-model-settings-page(?:\s|$)/u);
});

test("history renders real activation audit time and actor without falling back to configuration creation time", () => {
  assert.match(page, /启用时间/);
  assert.match(page, /操作管理员/);
  assert.match(page, /activation\?\.occurredAt/);
  assert.match(page, /activation\?\.actorId/);
  assert.doesNotMatch(page, /当前接口未提供；请查审计日志/);
  assert.doesNotMatch(page, /启用时间[^\n]*createdAt|操作管理员[^\n]*createdAt/);
});

test("rendered channel controls use only safe candidates and retain profile-scoped action state", { timeout: 12_000 }, async () => {
  let vite;
  let browser;
  let overviewReads = 0;
  let profileId = "profile-a";
  let channels = [browserChannel(), browserChannel({ channelId: "channel-c", displayName: "空闲通道", channelOrder: 2,
    status: "AVAILABLE", connectionId: "connection-c", connectionVersion: 3, connectionDisplayName: "第三 Gateway", assignedItemId: null })];
  const addBodies = [];
  const addPaths = [];
  const statusBodies = [];
  const statusPaths = [];
  let addFailure = false;
  let staleCompletion = false;
  let holdStatus = false;
  let resolveStatus = null;
  let taskMutationRequests = 0;
  try {
    vite = await createServer({ root: appRoot, logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: false } });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address === "object");
    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Shanghai" });
    const page = await context.newPage();
    page.setDefaultTimeout(1_500);
    await page.addInitScript(() => localStorage.setItem("token", "browser-test-token"));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/local/state") return route.fulfill({ status: 200, json: browserLocalState() });
      if (pathname === "/api/admin/auto-listing/ai-settings" && request.method() === "GET") {
        overviewReads += 1;
        return route.fulfill({ status: 200, json: { ok: true, data: browserOverview(profileId, channels) } });
      }
      if (pathname.endsWith("/channels") && request.method() === "POST") {
        const body = request.postDataJSON(); addBodies.push(body); addPaths.push(pathname);
        if (staleCompletion) {
          profileId = "profile-b";
          return route.fulfill({ status: 200, json: { ok: true, data: browserChannel({ channelId: "channel-stale",
            displayName: "过期响应", status: "AVAILABLE", assignedItemId: null }) } });
        }
        if (addFailure) return route.fulfill({ status: 409, json: { code: "AUTO_LISTING_AI_PROFILE_CHANNEL_CONNECTION_INELIGIBLE", message: "secret" } });
        return route.fulfill({ status: 200, json: { ok: true, data: browserChannel({ channelId: "channel-b", displayName: "备用 Gateway", status: "AVAILABLE", assignedItemId: null }) } });
      }
      if (pathname.endsWith("/status") && request.method() === "POST") {
        statusBodies.push(request.postDataJSON()); statusPaths.push(pathname);
        if (holdStatus) return new Promise((resolve) => { resolveStatus = () => resolve(route.fulfill({ status: 200,
          json: { ok: true, data: browserChannel({ enabled: false, status: "DISABLED" }) } })); });
        return route.fulfill({ status: 200, json: { ok: true, data: browserChannel({ enabled: false, status: "DISABLED" }) } });
      }
      if (request.method() !== "GET") taskMutationRequests += 1;
      return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
    });

    await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/auto-listing/ai-settings`);
    await page.getByText("自动上架独立通道", { exact: true }).waitFor();
    await waitForChannelSelector(page);
    const candidateSelect = page.getByLabel("选择已验证兼容连接");
    await candidateSelect.click();
    assert.equal(await page.getByRole("option").count(), 1);
    await page.keyboard.press("Escape");
    const addButton = page.locator(".ai-model-settings-channel-add button");
    assert.equal(await addButton.isDisabled(), true);
    await candidateSelect.fill("forged-connection");
    await page.keyboard.press("Enter");
    assert.equal(await addButton.isDisabled(), true);
    assert.equal(addBodies.length, 0);
    await page.keyboard.press("Escape");

    await candidateSelect.click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.equal(await addButton.isDisabled(), false);
    await addButton.click();
    await page.getByText("独立通道已添加", { exact: true }).waitFor();
    assert.deepEqual(addBodies[0], { connectionId: "connection-b", connectionVersion: 2, displayName: "备用 Gateway" });
    assert.equal(addPaths[0], "/api/admin/auto-listing/ai-settings/profiles/profile-a/versions/1/channels");
    assert.ok(overviewReads >= 2, "successful channel action refreshes the overview");
    assert.equal(await page.getByText("当前商品完成后停用生效", { exact: true }).count(), 1);
    assert.match(await page.locator("body").innerText(), /忙碌通道/u);

    const busyRow = page.getByText("忙碌通道", { exact: true }).locator("xpath=ancestor::tr[1]");
    const idleRow = page.getByText("空闲通道", { exact: true }).locator("xpath=ancestor::tr[1]");
    const busyDisable = busyRow.locator("button");
    const idleDisable = idleRow.locator("button");
    holdStatus = true;
    await busyDisable.click();
    await page.waitForTimeout(10);
    assert.equal(statusBodies.length, 1);
    assert.equal(await busyDisable.isDisabled(), true);
    assert.match(await busyDisable.getAttribute("class"), /ant-btn-loading/u);
    assert.doesNotMatch(await idleDisable.getAttribute("class"), /ant-btn-loading/u);
    assert.deepEqual(statusBodies[0], { enabled: false });
    assert.equal(statusPaths[0], "/api/admin/auto-listing/ai-settings/profiles/profile-a/versions/1/channels/channel-a/status");
    const releaseStatus = resolveStatus; holdStatus = false; resolveStatus = null; releaseStatus();
    await page.getByText("独立通道已停用", { exact: true }).waitFor();

    channels = [browserChannel({ enabled: false, status: "DISABLED" })];
    const refreshButton = page.locator(".ai-model-settings-page__header button").last();
    await refreshButton.click({ trial: true });
    await refreshButton.click();
    await page.getByText("当前没有可用的独立通道，请检查通道配置", { exact: true }).waitFor();
    await waitForChannelSelector(page);
    assert.equal(taskMutationRequests, 0);

    channels = [browserChannel(), browserChannel({ channelId: "channel-c", displayName: "空闲通道", channelOrder: 2,
      status: "AVAILABLE", connectionId: "connection-c", connectionVersion: 3, connectionDisplayName: "第三 Gateway", assignedItemId: null })];
    await refreshButton.click({ trial: true });
    await refreshButton.click();
    await waitForChannelSelector(page);
    await candidateSelect.click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    addFailure = true;
    await addButton.click();
    await page.getByText("AI 模型设置请求未完成", { exact: true }).waitFor();
    assert.equal(await page.getByText("独立通道已添加", { exact: true }).count(), 0);
    await waitForChannelSelector(page);

    addFailure = false;
    staleCompletion = true;
    await addButton.click();
    await page.getByText("正式模型-profile-b · v1 · 当前正式版本", { exact: true }).waitFor();
    assert.equal(await page.getByText("独立通道已添加", { exact: true }).count(), 0);
  } finally {
    await Promise.allSettled([browser?.close(), vite?.close()]);
  }
});

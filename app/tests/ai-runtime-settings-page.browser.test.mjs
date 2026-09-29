import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

function browserExecutable() {
  const executable = [
    process.env.JZ_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean).find(existsSync);
  assert.ok(executable, "Chrome/Chromium is required for the AI runtime settings regression");
  return executable;
}

function localState(role = "admin") {
  return {
    account: {
      id: `runtime-${role}`,
      username: `runtime-${role}`,
      displayName: `Runtime ${role}`,
      role,
      status: "active",
    },
    accounts: [],
    token: "runtime-settings-token",
    binding: null,
    currentStoreId: "",
    stores: [],
    summary: {},
    caches: {},
    jobs: {},
  };
}

function runtimeSnapshot({
  settings = {
    productConcurrency: 3,
    requestConcurrency: 3,
    localConcurrency: 1,
    billingConcurrency: 1,
    adaptiveEnabled: false,
  },
  revision = 3,
  appliedRevision = 2,
  online = true,
  effectiveProductConcurrency = 2,
} = {}) {
  return {
    settings,
    revision,
    updatedAt: "2026-09-13T02:00:00.000Z",
    source: "saved",
    worker: {
      online,
      status: online ? "running" : "unknown",
      seenAt: online ? new Date().toISOString() : null,
      appliedRevision,
      effectiveProductConcurrency,
      activeProducts: 1,
      activeRequests: 1,
      local: { active: 1, pending: 2, concurrency: 1 },
      resources: {
        memoryLimitBytes: 2_147_483_648,
        memoryUsedBytes: 536_870_912,
        memoryScope: "container",
        cpuCores: 4,
        cpuRatio: 0.25,
        eventLoopDelayMs: 8,
      },
      adaptiveEnabled: false,
    },
  };
}

async function makeFixture(t, { role = "admin", runtimeHandler }) {
  const vite = await createServer({
    root: appRoot,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address === "object");

  const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  let runtimeRequests = 0;
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  await page.addInitScript(() => {
    localStorage.setItem("token", "runtime-settings-token");
    const intervals = new Map();
    let nextIntervalId = 1;
    window.setInterval = (callback, delay, ...args) => {
      const id = nextIntervalId;
      nextIntervalId += 1;
      intervals.set(id, { delay, callback: () => callback(...args) });
      return id;
    };
    window.clearInterval = (id) => intervals.delete(id);
    window.__runIntervalsForTest = (delay) => {
      for (const entry of [...intervals.values()]) {
        if (entry.delay === delay) entry.callback();
      }
    };
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/local/state") {
      await route.fulfill({ status: 200, json: localState(role) });
      return;
    }
    if (pathname === "/api/admin/ai-runtime-settings") {
      runtimeRequests += 1;
      if (runtimeHandler) {
        await runtimeHandler({ route, request, pathname, requestNumber: runtimeRequests });
        return;
      }
    }
    if (pathname === "/api/quality-inspection/summary") {
      await route.fulfill({ status: 200, json: { unreadCount: 0, stores: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { message: `fixture missing ${pathname}` } });
  });
  t.after(async () => {
    await Promise.allSettled([context.close(), browser.close(), vite.close()]);
  });
  return {
    page,
    pageErrors,
    runtimeRequests: () => runtimeRequests,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test("administrator saves all limits and sees the worker acknowledge the saved revision", async (t) => {
  let saved = runtimeSnapshot();
  let savedBody = null;
  let stalePollRoute = null;
  let holdStalePoll = false;
  let markStalePollSeen;
  const stalePollSeen = new Promise((resolve) => { markStalePollSeen = resolve; });
  const fixture = await makeFixture(t, {
    runtimeHandler: async ({ route, request }) => {
      if (request.method() === "GET" && holdStalePoll) {
        holdStalePoll = false;
        stalePollRoute = route;
        markStalePollSeen();
        return;
      }
      if (request.method() === "PUT") {
        savedBody = request.postDataJSON();
        assert.equal(await fixture.page.getByRole("button", { name: "刷新运行状态" }).isDisabled(), true);
        assert.equal(await fixture.page.getByRole("button", { name: "放弃修改并重新载入" }).isDisabled(), true);
        assert.equal(await fixture.page.getByRole("spinbutton", { name: "商品任务并发" }).isDisabled(), true);
        assert.equal(await fixture.page.getByRole("spinbutton", { name: "付费请求并发" }).isDisabled(), true);
        assert.equal(await fixture.page.getByRole("spinbutton", { name: "本地处理并发" }).isDisabled(), true);
        assert.equal(await fixture.page.getByRole("spinbutton", { name: "同计费账号并发" }).isDisabled(), true);
        assert.equal(await fixture.page.getByRole("switch", { name: "自动调节" }).isDisabled(), true);
        saved = runtimeSnapshot({
          settings: savedBody.settings,
          revision: 4,
          appliedRevision: 2,
          effectiveProductConcurrency: 2,
        });
      }
      await route.fulfill({ status: 200, json: saved });
    },
  });

  await fixture.page.goto(`${fixture.baseUrl}/ozon/settings/ai-runtime-settings/`);
  await fixture.page.getByRole("heading", { name: "AI 并发设置" }).waitFor();
  await fixture.page.getByRole("button", { name: "管理员配置" }).click();
  const adminLabels = await fixture.page.locator(".qh-admin-popup .ant-dropdown-menu-item").allTextContents();
  assert.equal(adminLabels.indexOf("AI 并发设置"), adminLabels.indexOf("AI 通道配置") + 1);

  assert.equal(await fixture.page.getByRole("spinbutton", { name: "商品任务并发" }).inputValue(), "3");
  assert.equal(await fixture.page.getByRole("spinbutton", { name: "付费请求并发" }).inputValue(), "3");
  assert.equal(await fixture.page.getByRole("spinbutton", { name: "本地处理并发" }).inputValue(), "1");
  assert.equal(await fixture.page.getByRole("spinbutton", { name: "同计费账号并发" }).inputValue(), "1");
  assert.equal(await fixture.page.getByRole("switch", { name: "自动调节" }).getAttribute("aria-checked"), "false");
  await fixture.page.getByRole("spinbutton", { name: "商品任务并发" }).fill("5");
  await fixture.page.getByRole("spinbutton", { name: "付费请求并发" }).fill("4");
  await fixture.page.getByRole("spinbutton", { name: "本地处理并发" }).fill("2");
  await fixture.page.getByRole("spinbutton", { name: "同计费账号并发" }).fill("2");
  await fixture.page.getByRole("switch", { name: "自动调节" }).click();
  holdStalePoll = true;
  await fixture.page.evaluate(() => window.__runIntervalsForTest(5_000));
  await stalePollSeen;
  await fixture.page.getByRole("button", { name: "保存设置" }).click();
  await fixture.page.getByText("等待后台应用", { exact: true }).waitFor();
  assert.deepEqual(savedBody, {
    revision: 3,
    settings: {
      productConcurrency: 5,
      requestConcurrency: 4,
      localConcurrency: 2,
      billingConcurrency: 2,
      adaptiveEnabled: true,
    },
  });
  await fixture.page.getByText("保存版本 4", { exact: true }).waitFor();
  await fixture.page.getByText("后台应用版本 2", { exact: true }).waitFor();
  await stalePollRoute.fulfill({ status: 200, json: runtimeSnapshot() });
  await fixture.page.waitForTimeout(100);
  assert.equal(await fixture.page.getByText("保存版本 4", { exact: true }).count(), 1);
  assert.equal(await fixture.page.getByText("保存版本 3", { exact: true }).count(), 0);

  saved = runtimeSnapshot({
    settings: savedBody.settings,
    revision: 4,
    appliedRevision: 4,
    effectiveProductConcurrency: 5,
  });
  saved.worker.local.concurrency = 2;
  saved.worker.adaptiveEnabled = true;
  await fixture.page.evaluate(() => window.__runIntervalsForTest(5_000));
  await fixture.page.getByText("后台已应用", { exact: true }).waitFor();
  await fixture.page.getByText("有效商品并发 5", { exact: true }).waitFor();

  saved = runtimeSnapshot({
    settings: savedBody.settings,
    revision: 4,
    appliedRevision: 4,
    effectiveProductConcurrency: 0,
  });
  saved.worker.local.concurrency = 2;
  saved.worker.adaptiveEnabled = true;
  await fixture.page.evaluate(() => window.__runIntervalsForTest(5_000));
  await fixture.page.getByText("有效商品并发 0", { exact: true }).waitFor();

  await fixture.page.reload();
  await fixture.page.getByRole("heading", { name: "AI 并发设置" }).waitFor();
  assert.equal(await fixture.page.getByRole("spinbutton", { name: "商品任务并发" }).inputValue(), "5");
  assert.equal(await fixture.page.getByRole("switch", { name: "自动调节" }).getAttribute("aria-checked"), "true");
  await fixture.page.setViewportSize({ width: 390, height: 844 });
  await fixture.page.getByRole("button", { name: "打开导航" }).click();
  await fixture.page.getByRole("button", { name: "管理员配置" }).click();
  await fixture.page.getByText("AI 并发设置", { exact: true }).last().waitFor();
  assert.deepEqual(fixture.pageErrors, []);
});

test("a manual refresh invalidated by a newer save always releases its loading state", async (t) => {
  let heldRefreshRoute = null;
  let holdRefresh = false;
  let markRefreshSeen;
  const refreshSeen = new Promise((resolve) => { markRefreshSeen = resolve; });
  const fixture = await makeFixture(t, {
    runtimeHandler: async ({ route, request }) => {
      if (request.method() === "GET" && holdRefresh) {
        holdRefresh = false;
        heldRefreshRoute = route;
        markRefreshSeen();
        return;
      }
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        await route.fulfill({
          status: 200,
          json: runtimeSnapshot({ settings: body.settings, revision: 4, appliedRevision: 4 }),
        });
        return;
      }
      await route.fulfill({ status: 200, json: runtimeSnapshot() });
    },
  });

  await fixture.page.goto(`${fixture.baseUrl}/ozon/settings/ai-runtime-settings/`);
  await fixture.page.getByRole("spinbutton", { name: "商品任务并发" }).fill("5");
  holdRefresh = true;
  const refreshButton = fixture.page.getByRole("button", { name: "刷新运行状态" });
  await refreshButton.click();
  await refreshSeen;
  await fixture.page.getByRole("button", { name: "保存设置" }).click();
  await fixture.page.getByText("保存版本 4", { exact: true }).waitFor();
  await heldRefreshRoute.fulfill({ status: 200, json: runtimeSnapshot() });
  await fixture.page.waitForTimeout(100);

  assert.equal((await refreshButton.getAttribute("class")).includes("ant-btn-loading"), false);
  const requestsBeforePoll = fixture.runtimeRequests();
  await fixture.page.evaluate(() => window.__runIntervalsForTest(5_000));
  await fixture.page.waitForTimeout(100);
  assert.equal(fixture.runtimeRequests(), requestsBeforePoll + 1);
  assert.deepEqual(fixture.pageErrors, []);
});

test("poll failures, conflicts, and slow polling keep the administrator draft without overlapping reads", async (t) => {
  let phase = "initial";
  let conflictBody = null;
  let slowPollRoute = null;
  let markSlowPollSeen;
  const slowPollSeen = new Promise((resolve) => { markSlowPollSeen = resolve; });
  const initial = runtimeSnapshot();
  const fixture = await makeFixture(t, {
    runtimeHandler: async ({ route, request }) => {
      if (request.method() === "PUT") {
        conflictBody = request.postDataJSON();
        if (phase === "save-error") {
          await route.fulfill({ status: 503, json: { message: "保存服务暂不可用" } });
          return;
        }
        await route.fulfill({
          status: 409,
          json: { code: "AI_RUNTIME_SETTINGS_REVISION_CONFLICT", message: "设置已被其他管理员更新" },
        });
        return;
      }
      if (phase === "poll-error") {
        await route.fulfill({ status: 503, json: { message: "worker status temporarily unavailable" } });
        return;
      }
      if (phase === "external-update") {
        await route.fulfill({
          status: 200,
          json: runtimeSnapshot({
            settings: { ...initial.settings, productConcurrency: 6 },
            revision: 5,
            appliedRevision: 5,
            effectiveProductConcurrency: 6,
          }),
        });
        return;
      }
      if (phase === "slow-poll" && !slowPollRoute) {
        slowPollRoute = route;
        markSlowPollSeen();
        return;
      }
      if (phase === "slow-poll") {
        await route.fulfill({ status: 500, json: { message: "overlapping poll must not be sent" } });
        return;
      }
      await route.fulfill({ status: 200, json: initial });
    },
  });

  await fixture.page.goto(`${fixture.baseUrl}/ozon/settings/ai-runtime-settings/`);
  const productInput = fixture.page.getByRole("spinbutton", { name: "商品任务并发" });
  await productInput.waitFor();
  await productInput.fill("8");

  phase = "poll-error";
  await fixture.page.evaluate(() => window.__runIntervalsForTest(5_000));
  await fixture.page.getByText("运行状态刷新失败，未保存草稿仍保留。", { exact: true }).waitFor();
  await fixture.page.getByText("后台离线或状态已过期", { exact: true }).waitFor();
  assert.equal(await fixture.page.locator(".runtime-metric-grid").count(), 0);
  assert.equal(await productInput.inputValue(), "8");

  phase = "external-update";
  await fixture.page.evaluate(() => window.__runIntervalsForTest(5_000));
  await fixture.page.getByText("保存版本 5", { exact: true }).waitFor();
  assert.equal(await productInput.inputValue(), "8");

  phase = "save-error";
  await fixture.page.getByRole("button", { name: "保存设置" }).click();
  await fixture.page.getByText("保存服务暂不可用", { exact: true }).waitFor();
  assert.equal(await productInput.inputValue(), "8");

  phase = "conflict";
  await fixture.page.getByRole("button", { name: "保存设置" }).click();
  await fixture.page.getByText("配置已被其他管理员更新，请重新载入后再保存。", { exact: true }).waitFor();
  await fixture.page.getByRole("button", { name: "重新载入已保存配置" }).waitFor();
  assert.equal(conflictBody.revision, 3);
  assert.equal(conflictBody.settings.productConcurrency, 8);
  assert.equal(await productInput.inputValue(), "8");

  phase = "slow-poll";
  await fixture.page.evaluate(() => window.__runIntervalsForTest(5_000));
  await slowPollSeen;
  const requestCountWithSlowPoll = fixture.runtimeRequests();
  await fixture.page.evaluate(() => window.__runIntervalsForTest(5_000));
  await fixture.page.waitForTimeout(100);
  assert.equal(fixture.runtimeRequests(), requestCountWithSlowPoll);
  await slowPollRoute.fulfill({
    status: 200,
    json: runtimeSnapshot({
      settings: { ...initial.settings, productConcurrency: 9 },
      revision: 9,
      appliedRevision: 9,
      effectiveProductConcurrency: 9,
    }),
  });
  await fixture.page.getByText("保存版本 9", { exact: true }).waitFor();
  assert.equal(await fixture.page.getByText("保存版本 9", { exact: true }).count(), 1);
  assert.equal(await productInput.inputValue(), "8");
  assert.deepEqual(fixture.pageErrors, []);
});

test("an expired worker heartbeat is never presented as current even when the response says online", async (t) => {
  const stale = runtimeSnapshot({ appliedRevision: 3, effectiveProductConcurrency: 0 });
  stale.worker.seenAt = new Date(Date.now() - 60_000).toISOString();
  const fixture = await makeFixture(t, {
    runtimeHandler: async ({ route }) => {
      await route.fulfill({ status: 200, json: stale });
    },
  });

  await fixture.page.goto(`${fixture.baseUrl}/ozon/settings/ai-runtime-settings/`);
  await fixture.page.getByText("后台离线或状态已过期", { exact: true }).waitFor();
  await fixture.page.getByText("后台应用版本 未取得", { exact: true }).waitFor();
  assert.equal(await fixture.page.locator(".runtime-metric-grid").count(), 0);
  assert.equal(await fixture.page.getByText("有效商品并发 0", { exact: true }).count(), 0);
  assert.deepEqual(fixture.pageErrors, []);
});

test("ordinary users have no administrator entry and cannot load runtime settings", async (t) => {
  const fixture = await makeFixture(t, {
    role: "user",
    runtimeHandler: async ({ route }) => {
      await route.fulfill({ status: 500, json: { message: "ordinary user must not call this endpoint" } });
    },
  });

  await fixture.page.goto(`${fixture.baseUrl}/ozon/settings/ai-runtime-settings/`);
  await fixture.page.getByText("仅管理员可查看和修改 AI 并发设置", { exact: true }).waitFor();
  assert.equal(await fixture.page.getByRole("button", { name: "管理员配置" }).count(), 0);
  assert.equal(fixture.runtimeRequests(), 0);
  assert.deepEqual(fixture.pageErrors, []);
});

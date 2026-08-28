import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

function browserExecutable() {
  const candidates = [
    process.env.JZ_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  assert.ok(executable, "Chrome/Chromium is required for the automatic listing polling regression");
  return executable;
}

function localState() {
  return {
    account: { id: "account-poll", username: "poll", displayName: "Poll", role: "admin", status: "active" },
    token: "poll-token",
    binding: null,
    currentStoreId: "store-poll",
    stores: [{ id: "store-poll", label: "轮询店铺", companyName: "Poll", currencyCode: "CNY" }],
    summary: {},
    caches: {
      collectBox: [{ id: "collect-poll", draftVersion: 1 }],
      warehouses: [{
        id: "warehouse-poll", warehouse_id: "1001", storeId: "store-poll", name: "轮询仓库",
        listingEligibility: {
          eligible: true, code: "ELIGIBLE_ACTIVE_FBS", fulfillmentType: "FBS", evidenceRequired: false,
        },
      }],
    },
    jobs: {},
  };
}

function job(status) {
  return [{
    jobId: "job-poll",
    createdAt: "2026-08-18T08:08:39.088Z",
    items: [{
      itemId: "item-poll",
      sourceRecordId: "collect-poll",
      sourceOrder: 1,
      sourceThumbnailUrl: "",
      sourceTitle: "轮询商品",
      sourceSku: "SKU-POLL",
      targetStoreId: "store-poll",
      targetWarehouseId: "warehouse-poll",
      status,
      statusVersion: status === "PLANNING" ? 2 : 3,
      failureCode: status === "BLOCKED" ? "AUTO_LISTING_CONTENT_PLAN_FAILED" : "",
      ...(status === "PLANNING" ? {
        aiQueueState: "WAITING_FOR_AI_CHANNEL",
        aiChannelDisplayName: null,
        aiChannelSwitching: false,
        aiChannelWaitStartedAt: "2026-08-18T08:08:40.000Z",
        workflowProgress: {
          phase: "PLAN_CONTENT", state: "QUEUED", attemptCount: 0,
          updatedAt: "2026-08-18T08:08:40.000Z", nextRetryAt: null,
        },
      } : {
        aiQueueState: null,
        aiChannelDisplayName: null,
        aiChannelSwitching: false,
        aiChannelWaitStartedAt: null,
      }),
      actions: {
        review: false, approve: false, retry: false, regenerate: false, cancel: status === "PLANNING",
      },
    }],
  }];
}

test("a task waiting for an AI channel preserves progress and refreshes without manual reload", async () => {
  let vite;
  let browser;
  let jobReads = 0;
  let terminalStatus = false;
  try {
    vite = await createServer({
      root: appRoot,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address === "object");
    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    await page.addInitScript(() => {
      const intervals = new Map();
      let nextId = 1;
      window.setInterval = (callback, delay, ...args) => {
        const id = nextId++;
        intervals.set(id, { delay, callback: () => callback(...args) });
        return id;
      };
      window.clearInterval = (id) => intervals.delete(id);
      window.__runIntervalsForTest = async (delay) => {
        await Promise.all([...intervals.values()]
          .filter((entry) => entry.delay === delay)
          .map((entry) => entry.callback()));
      };
      localStorage.setItem("token", "poll-token");
    });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/local/state") {
        await route.fulfill({ status: 200, json: localState() });
        return;
      }
      if (url.pathname === "/api/auto-listing/preferences") {
        await route.fulfill({
          status: 200,
          json: { ok: true, data: { configVersion: 0 }, imports: [], limits: { maxBytes: 2_097_152, maxRows: 1_000 } },
        });
        return;
      }
      if (url.pathname === "/api/auto-listing/jobs") {
        jobReads += 1;
        await route.fulfill({ status: 200, json: { ok: true, data: job(terminalStatus ? "BLOCKED" : "PLANNING") } });
        return;
      }
      await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
    });

    await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/auto-listing/?source=collect&ids=collect-poll`);
    const brandSwitch = page.getByRole("switch", { name: "使用采集品牌" });
    await brandSwitch.waitFor();
    assert.equal(await brandSwitch.getAttribute("aria-checked"), "false");
    await page.getByRole("tab", { name: "任务中心" }).click();
    await page.getByText("等待可用 AI 通道", { exact: true }).waitFor({ timeout: 2_000 });
    const waitingRow = page.getByRole("row").filter({ hasText: "轮询商品" });
    assert.equal(await waitingRow.getByRole("progressbar").getAttribute("aria-valuenow"), "15");
    assert.equal(await page.getByText("正在规划图片内容", { exact: true }).count(), 0);
    const initialJobReads = jobReads;
    terminalStatus = true;
    await page.evaluate(() => window.__runIntervalsForTest(3_000));
    await page.getByText("需要处理问题", { exact: true }).waitFor();

    assert.equal(jobReads, initialJobReads + 1);
    assert.equal(await page.getByText("等待可用 AI 通道", { exact: true }).count(), 0);
    assert.deepEqual(pageErrors, []);
    await context.close();
  } finally {
    await Promise.allSettled([browser?.close(), vite?.close()]);
  }
});

test("missing category strategy opens its configuration dialog while preserving the default brand mode", async () => {
  let vite;
  let browser;
  let context;
  let creationRequests = 0;
  const submittedConfigs = [];
  try {
    vite = await createServer({
      root: appRoot,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address === "object");
    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    await page.addInitScript(() => localStorage.setItem("token", "poll-token"));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/local/state") {
        await route.fulfill({ status: 200, json: localState() });
        return;
      }
      if (url.pathname === "/api/auto-listing/preferences" && request.method() === "GET") {
        await route.fulfill({ status: 200, json: {
          ok: true,
          data: {
            configVersion: 0,
            targetStoreId: "store-poll",
            targetWarehouseId: "warehouse-poll",
            stock: 5,
            priceAdjustmentKopecks: "0",
            priceMultiplierMicros: "1000000",
          },
          imports: [],
          limits: { maxBytes: 2_097_152, maxRows: 1_000 },
        } });
        return;
      }
      if (url.pathname === "/api/auto-listing/preferences" && request.method() === "PUT") {
        await route.fulfill({ status: 200, json: { ok: true, data: { configVersion: 1 } } });
        return;
      }
      if (url.pathname === "/api/auto-listing/jobs" && request.method() === "GET") {
        await route.fulfill({ status: 200, json: { ok: true, data: [] } });
        return;
      }
      if (url.pathname === "/api/auto-listing/jobs/from-collect-box" && request.method() === "POST") {
        creationRequests += 1;
        submittedConfigs.push(request.postDataJSON().config);
        if (creationRequests > 1) {
          await route.fulfill({ status: 200, json: { ok: true, data: { jobId: "job-created" } } });
          return;
        }
        await route.fulfill({ status: 409, json: {
          ok: false,
          code: "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED",
          message: "missing category strategy",
          correlationId: "correlation-required",
          details: {
            scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 88265327, typeId: 95402 },
            sourceCollectItemId: "collect-poll",
            status: "NOT_CONFIGURED",
            canManage: true,
            draftId: "draft-required",
          },
        } });
        return;
      }
      await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
    });

    await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/auto-listing/?source=collect&ids=collect-poll`);
    const brandSwitch = page.getByRole("switch", { name: "使用采集品牌" });
    await brandSwitch.waitFor();
    assert.equal(await brandSwitch.getAttribute("aria-checked"), "false");
    const uploadSwitch = page.getByRole("switch", { name: "自动上传到 Ozon" });
    const strategySwitch = page.getByRole("switch", { name: "使用类目策略" });
    assert.equal(await strategySwitch.count(), 1);
    assert.equal(await strategySwitch.getAttribute("aria-checked"), "true");
    const [uploadBox, strategyBox] = await Promise.all([uploadSwitch.boundingBox(), strategySwitch.boundingBox()]);
    assert.ok(uploadBox && strategyBox && strategyBox.x > uploadBox.x);
    await page.getByRole("button", { name: "创建生成任务" }).click();
    await page.getByText("需要先配置类目图片策略", { exact: true }).waitFor();

    const resume = await page.evaluate(() => JSON.parse(sessionStorage.getItem(
      "zongzi:auto-listing:category-strategy-resume:v1:account-poll",
    )));
    assert.equal(resume.form.useCollectedBrand, false);
    assert.equal(resume.form.useCategoryStrategy, true);
    assert.equal(resume.form.priceMultiplier, "1");
    assert.equal(await page.getByText("类目策略配置资料无效，请刷新后重试", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "暂不处理" }).click();
    await strategySwitch.click();
    assert.equal(await strategySwitch.getAttribute("aria-checked"), "false");
    await page.getByRole("button", { name: "创建生成任务" }).click();
    await page.getByText("任务已创建", { exact: true }).waitFor();
    assert.equal(creationRequests, 2);
    assert.equal(submittedConfigs[0].useCategoryStrategy, true);
    assert.equal(submittedConfigs[1].useCategoryStrategy, false);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close();
    await browser?.close();
    await vite?.close();
  }
});

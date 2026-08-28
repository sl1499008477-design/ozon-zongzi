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
  assert.ok(executable, "Chrome/Chromium is required for the automatic-listing task-center regression");
  return executable;
}

function localState() {
  return {
    account: { id: "account-center", username: "center", displayName: "Center", role: "member", status: "active" },
    token: "center-token",
    binding: null,
    currentStoreId: "store-center",
    stores: [{ id: "store-center", label: "任务中心店铺", companyName: "Center", currencyCode: "CNY" }],
    summary: {},
    caches: {
      collectBox: [
        { id: "collect-a", draftVersion: 1, name: "商品 A", sku: "SKU-A" },
        { id: "collect-b", draftVersion: 2, title: "商品 B", sku: "SKU-B" },
      ],
      warehouses: [{
        id: "warehouse-center", warehouse_id: "1001", storeId: "store-center", name: "任务中心仓库",
        listingEligibility: {
          eligible: true, code: "ELIGIBLE_ACTIVE_FBS", fulfillmentType: "FBS", evidenceRequired: false,
        },
      }],
    },
    jobs: {},
  };
}

const actions = Object.freeze({ review: false, approve: false, retry: false, regenerate: false, cancel: false });

function item({ id, title, status, order, failureStage = null, aiQueue = null, workflowProgress = null }) {
  return {
    itemId: `item-${id}`,
    sourceRecordId: `collect-${id}`,
    sourceOrder: order,
    sourceThumbnailUrl: id === "upload" ? "https://images.example.test/missing.jpg" : "",
    sourceTitle: title,
    sourceSku: `SKU-${id.toUpperCase()}`,
    targetStoreId: "store-center",
    targetWarehouseId: "warehouse-center",
    status,
    statusVersion: 1,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:02:03.000Z",
    failureStage,
    ...(aiQueue ? {
      aiQueueState: aiQueue.state,
      aiChannelDisplayName: aiQueue.displayName,
      aiChannelSwitching: aiQueue.switching,
      aiChannelWaitStartedAt: aiQueue.waitStartedAt,
    } : {}),
    ...(workflowProgress ? { workflowProgress } : {}),
    price: {
      currency: "CNY",
      branch: "BLACK_GTE_80",
      blackKopecks: "10000",
      greenKopecks: "8000",
      realPriceKopecks: "14500",
      adjustmentKopecks: "100",
      preMultiplierPriceKopecks: "14600",
      priceMultiplierMicros: "1250000",
      finalPriceKopecks: "18250",
    },
    actions,
  };
}

function jobs(processingStatus = "GENERATING") {
  return [{
    jobId: "job-center",
    createdAt: "2026-08-25T00:00:00.000Z",
    items: [
      item({ id: "processing", title: "处理中商品", status: processingStatus, order: 1 }),
      item({ id: "review", title: "待审核商品", status: "READY_FOR_REVIEW", order: 2 }),
      item({ id: "preparation", title: "准备失败商品", status: "BLOCKED", order: 3, failureStage: "PREPARATION" }),
      item({ id: "generation", title: "生成失败商品", status: "BLOCKED", order: 4, failureStage: "GENERATION" }),
      item({ id: "upload", title: "上传失败商品", status: "BLOCKED", order: 5, failureStage: "UPLOAD" }),
      item({ id: "succeeded", title: "上架成功商品", status: "SUCCEEDED", order: 6 }),
      item({ id: "cancelled", title: "已取消商品", status: "CANCELLED", order: 7 }),
      item({
        id: "calling", title: "调用中商品", status: "GENERATING", order: 8,
        aiQueue: { state: "CALLING_AI", displayName: "主通道", switching: false, waitStartedAt: null },
        workflowProgress: { phase: "GENERATE_IMAGE_SLOT", state: "RUNNING", attemptCount: 1,
          updatedAt: "2026-08-25T00:02:03.000Z", nextRetryAt: null },
      }),
      item({
        id: "waiting", title: "等待通道商品", status: "PLANNING", order: 9,
        aiQueue: { state: "WAITING_FOR_AI_CHANNEL", displayName: null, switching: false,
          waitStartedAt: "2026-08-25T00:01:00.000Z" },
        workflowProgress: { phase: "PLAN_CONTENT", state: "QUEUED", attemptCount: 0,
          updatedAt: "2026-08-25T00:01:00.000Z", nextRetryAt: null },
      }),
      item({
        id: "switching", title: "切换通道商品", status: "GENERATING", order: 10,
        aiQueue: { state: "SWITCHING_AI_CHANNEL", displayName: "故障通道", switching: true,
          waitStartedAt: "2026-08-25T00:01:30.000Z" },
        workflowProgress: { phase: "GENERATE_IMAGE_SLOT", state: "QUEUED", attemptCount: 1,
          updatedAt: "2026-08-25T00:01:30.000Z", nextRetryAt: null },
      }),
    ],
  }];
}

function pollingJobs(status) {
  return [{
    jobId: "job-polling",
    createdAt: "2026-08-25T00:00:00.000Z",
    items: [item({ id: "polling", title: "待审核轮询商品", status, order: 1 })],
  }];
}

test("ordered collection creation switches to the task center with exact multiplier and filters", async () => {
  let vite;
  let browser;
  let context;
  let createBody = null;
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
    const uncontrolledRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1" && url.hostname !== "images.example.test") {
        uncontrolledRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      }
    });
    await page.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      const nativeClearInterval = window.clearInterval.bind(window);
      const intervals = new Map();
      window.setInterval = (callback, delay, ...args) => {
        const id = nativeSetInterval(callback, delay, ...args);
        intervals.set(id, delay);
        return id;
      };
      window.clearInterval = (id) => {
        intervals.delete(id);
        return nativeClearInterval(id);
      };
      window.__intervalCountForTest = (delay) => [...intervals.values()].filter((value) => value === delay).length;
      localStorage.setItem("token", "center-token");
    });
    await page.route("https://images.example.test/**", (route) => route.fulfill({ status: 404, body: "missing" }));
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
            configVersion: 3,
            targetStoreId: "store-center",
            targetWarehouseId: "warehouse-center",
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
        await route.fulfill({ status: 200, json: { ok: true, data: { configVersion: 4 } } });
        return;
      }
      if (url.pathname === "/api/auto-listing/jobs" && request.method() === "GET") {
        await route.fulfill({ status: 200, json: { ok: true, data: jobs() } });
        return;
      }
      if (url.pathname === "/api/auto-listing/jobs/from-collect-box" && request.method() === "POST") {
        createBody = request.postDataJSON();
        await route.fulfill({ status: 201, json: { ok: true, data: { jobId: "job-created" } } });
        return;
      }
      await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
    });

    const originalUrl = `http://127.0.0.1:${address.port}/ozon/tools/auto-listing/?source=collect&ids=collect-b,collect-a`;
    await page.goto(originalUrl);
    await page.getByText("1. 商品 B", { exact: true }).waitFor();
    await page.getByText("2. 商品 A", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__intervalCountForTest(1_000)), 0);
    const multiplier = page.getByRole("spinbutton", { name: "上架倍率" });
    assert.equal(await multiplier.inputValue(), "1");
    await page.getByRole("button", { name: "创建生成任务" }).click();
    await page.getByRole("tab", { name: "任务中心", selected: true }).waitFor();

    assert.deepEqual(createBody?.collectItemIds, ["collect-b", "collect-a"]);
    assert.equal(createBody?.config?.priceMultiplierMicros, "1000000");
    assert.equal(new URL(page.url()).search, "?source=collect&ids=collect-b,collect-a");
    await page.getByRole("columnheader", { name: "任务用时" }).waitFor();
    assert.ok(await page.getByRole("progressbar").count() >= 1);
    await page.getByText("正在使用「主通道」生成", { exact: true }).waitFor({ timeout: 2_000 });
    await page.getByText("等待可用 AI 通道", { exact: true }).waitFor({ timeout: 2_000 });
    await page.getByText("原通道暂不可用，正在等待其他通道", { exact: true }).waitFor({ timeout: 2_000 });
    const waitingRow = page.getByRole("row").filter({ hasText: "等待通道商品" });
    const switchingRow = page.getByRole("row").filter({ hasText: "切换通道商品" });
    assert.equal(await waitingRow.getByRole("progressbar").getAttribute("aria-valuenow"), "15");
    assert.equal(await switchingRow.getByRole("progressbar").getAttribute("aria-valuenow"), "30");
    await page.getByText("总用时 2分3秒", { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => window.__intervalCountForTest(1_000)) >= 1);
    await page.getByRole("tab", { name: "创建任务" }).click();
    assert.equal(await page.evaluate(() => window.__intervalCountForTest(1_000)), 0);
    await page.getByRole("tab", { name: "任务中心" }).click();
    await page.getByRole("tab", { name: "生成失败" }).click();
    await page.getByText("准备失败商品", { exact: true }).waitFor({ timeout: 2_000 });
    await page.getByText("生成失败商品", { exact: true }).waitFor();
    assert.equal(await page.getByText("上传失败商品", { exact: true }).count(), 0);
    await page.getByRole("tab", { name: "上架失败" }).click();
    await page.getByText("上传失败商品", { exact: true }).waitFor();
    assert.equal(await page.getByText("生成失败商品", { exact: true }).count(), 0);
    assert.ok(await page.getByText("图片不可用", { exact: true }).count() >= 1);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(uncontrolledRequests, [], "rendered acceptance must not contact a real AI or Ozon endpoint");
  } finally {
    await context?.close();
    await browser?.close();
    await vite?.close();
  }
});

test("review-ready tasks keep polling and clean up after the refreshed row becomes terminal", async () => {
  let vite;
  let browser;
  let context;
  let jobsReadCount = 0;
  let polledStatus = "READY_FOR_REVIEW";
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
    const uncontrolledRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1") uncontrolledRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    });
    await page.addInitScript(() => {
      let nextIntervalId = 1;
      const intervals = new Map();
      window.setInterval = (callback, delay, ...args) => {
        const id = nextIntervalId;
        nextIntervalId += 1;
        intervals.set(id, { delay, callback: () => callback(...args) });
        return id;
      };
      window.clearInterval = (id) => intervals.delete(id);
      window.__intervalCountForTest = (delay) => [...intervals.values()]
        .filter((entry) => entry.delay === delay).length;
      window.__runIntervalsForTest = async (delay) => {
        const callbacks = [...intervals.values()]
          .filter((entry) => entry.delay === delay)
          .map((entry) => entry.callback);
        await Promise.all(callbacks.map((callback) => callback()));
      };
      localStorage.setItem("token", "center-token");
    });
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
            configVersion: 3,
            targetStoreId: "store-center",
            targetWarehouseId: "warehouse-center",
            stock: 5,
            priceAdjustmentKopecks: "0",
            priceMultiplierMicros: "1000000",
          },
          imports: [],
          limits: { maxBytes: 2_097_152, maxRows: 1_000 },
        } });
        return;
      }
      if (url.pathname === "/api/auto-listing/jobs" && request.method() === "GET") {
        jobsReadCount += 1;
        await route.fulfill({ status: 200, json: { ok: true, data: pollingJobs(polledStatus) } });
        return;
      }
      await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
    });

    await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/auto-listing/`);
    await page.getByRole("tab", { name: "任务中心" }).click();
    await page.getByText("等待审核", { exact: true }).waitFor();
    const initialJobsReadCount = jobsReadCount;
    assert.ok(initialJobsReadCount >= 1);
    assert.equal(await page.evaluate(() => window.__intervalCountForTest(3_000)), 1);

    polledStatus = "SUCCEEDED";
    await page.evaluate(() => window.__runIntervalsForTest(3_000));
    await page.getByRole("row").filter({ hasText: "待审核轮询商品" })
      .getByText("已完成上架", { exact: true }).waitFor();
    assert.equal(jobsReadCount, initialJobsReadCount + 1);
    await page.waitForFunction(() => window.__intervalCountForTest(3_000) === 0);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(uncontrolledRequests, [], "polling acceptance must remain entirely local and mocked");
  } finally {
    await context?.close();
    await browser?.close();
    await vite?.close();
  }
});

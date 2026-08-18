import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const ACCOUNT_ID = "account-category-navigation";
const DRAFT_ID = "draft-category-navigation";
const RESUME_KEY = `zongzi:auto-listing:category-strategy-resume:v1:${ACCOUNT_ID}`;
const OTHER_RESUME_KEY = "zongzi:auto-listing:category-strategy-resume:v1:account-other";
const SCOPE = {
  taxonomyScope: "OZON:DEFAULT",
  descriptionCategoryId: 17028922,
  typeId: 91542,
};

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
  assert.ok(executable, "Chrome/Chromium is required for the category strategy navigation regression");
  return executable;
}

function localState() {
  return {
    account: {
      id: ACCOUNT_ID,
      username: "category-navigation-test",
      displayName: "Category Navigation Test",
      role: "admin",
      status: "active",
    },
    accounts: [],
    token: "category-navigation-token",
    binding: null,
    currentStoreId: "",
    stores: [],
    summary: {},
    caches: {
      collectBox: [{ id: "collect-category-navigation", draftVersion: 3 }],
    },
    jobs: {},
  };
}

function resumeDraft() {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 60 * 60 * 1_000);
  return {
    schemaVersion: 1,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    accountId: ACCOUNT_ID,
    source: "collect",
    collectIds: ["collect-category-navigation"],
    sourceVersions: [{
      collectItemId: "collect-category-navigation",
      expectedSourceVersion: "draft:3",
    }],
    form: {
      targetStoreId: "store-category-navigation",
      targetWarehouseId: "warehouse-category-navigation",
      stock: 5,
      priceAdjustmentAmount: "0",
      ratio: "3:4",
      resolution: "1K",
      quality: "Medium",
      language: "ru",
      roles: { main: 1, sellingPoint: 3, detail: 1, scene: 1, specification: 1, infographic: 1 },
    },
    currency: "CNY",
    required: { scope: SCOPE, status: "COLLECTING", canManage: true, draftId: DRAFT_ID },
    state: "CONFIGURING",
  };
}

function strategySummary() {
  return {
    draftId: DRAFT_ID,
    scope: SCOPE,
    draftVersion: 3,
    status: "COLLECTING",
    sampleCount: 0,
  };
}

function strategyBundle() {
  return {
    draft: {
      ...strategySummary(),
      sourceCollectItemId: "collect-category-navigation",
      expectedSourceVersion: "draft:3",
    },
    session: null,
    samples: [],
    analysis: null,
    published: null,
    categoryPublications: [],
    versions: [],
  };
}

async function openDetailPage(browser, baseUrl, { delayRefresh = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  let detailRequests = 0;
  let completedDetailRequests = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  await page.addInitScript(({ key, otherKey, resume }) => {
    localStorage.setItem("token", "category-navigation-token");
    sessionStorage.setItem(key, JSON.stringify(resume));
    sessionStorage.setItem(otherKey, "other-account-resume");
  }, { key: RESUME_KEY, otherKey: OTHER_RESUME_KEY, resume: resumeDraft() });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/local/state") {
      await route.fulfill({ status: 200, json: localState() });
      return;
    }
    if (pathname === "/api/admin/auto-listing/category-strategies") {
      await route.fulfill({ status: 200, json: { ok: true, data: [strategySummary()] } });
      return;
    }
    if (pathname === `/api/admin/auto-listing/category-strategies/${DRAFT_ID}`) {
      detailRequests += 1;
      if (delayRefresh && detailRequests > 1) await refreshGate;
      await route.fulfill({ status: 200, json: { ok: true, data: strategyBundle() } });
      completedDetailRequests += 1;
      return;
    }
    await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
  });
  await page.goto(`${baseUrl}/ozon/tools/category-strategies/?draftId=${DRAFT_ID}&from=return-test&extra=value`);
  await page.getByRole("button", { name: "返回策略列表" }).waitFor();
  return {
    context,
    page,
    pageErrors,
    releaseRefresh,
    detailRequests: () => detailRequests,
    completedDetailRequests: () => completedDetailRequests,
  };
}

test("category strategy details return to a clean list and do not restore stale work", async () => {
  let vite;
  let browser;
  try {
    vite = await createServer({
      root: appRoot,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });

    const normal = await openDetailPage(browser, baseUrl, { delayRefresh: true });
    await normal.page.waitForFunction(() => !document.querySelector(".category-strategy-header .ant-btn-loading"));
    await normal.page.getByRole("button", { name: "刷新" }).click();
    for (let attempt = 0; attempt < 100 && normal.detailRequests() < 2; attempt += 1) {
      await normal.page.waitForTimeout(10);
    }
    assert.equal(normal.detailRequests(), 2);
    await normal.page.getByRole("button", { name: "返回策略列表" }).click();
    normal.releaseRefresh();
    await normal.page.getByText("类目策略列表", { exact: true }).waitFor();
    for (let attempt = 0; attempt < 100 && normal.completedDetailRequests() < 2; attempt += 1) {
      await normal.page.waitForTimeout(10);
    }
    assert.equal(normal.completedDetailRequests(), 2);
    await normal.page.evaluate(() => new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    }));
    assert.equal(new URL(normal.page.url()).pathname.replace(/\/$/u, ""), "/ozon/tools/category-strategies");
    assert.equal(new URL(normal.page.url()).search, "");
    assert.equal(await normal.page.evaluate((key) => sessionStorage.getItem(key), RESUME_KEY), null);
    assert.equal(await normal.page.evaluate((key) => sessionStorage.getItem(key), OTHER_RESUME_KEY), "other-account-resume");
    assert.equal(await normal.page.getByRole("button", { name: "返回策略列表" }).count(), 0);
    assert.equal(await normal.page.locator(".category-strategy-header .ant-btn-loading").count(), 0);
    assert.deepEqual(normal.pageErrors, []);
    await normal.context.close();

    const failedStorage = await openDetailPage(browser, baseUrl);
    await failedStorage.page.evaluate((key) => {
      const original = sessionStorage.removeItem.bind(sessionStorage);
      Object.defineProperty(sessionStorage, "removeItem", {
        configurable: true,
        value(candidate) {
          if (candidate === key) throw new DOMException("storage blocked", "SecurityError");
          original(candidate);
        },
      });
    }, RESUME_KEY);
    await failedStorage.page.getByRole("button", { name: "返回策略列表" }).click();
    await failedStorage.page.getByText("无法清除自动恢复状态，请刷新页面后重试。", { exact: true }).waitFor();
    assert.equal(new URL(failedStorage.page.url()).searchParams.get("draftId"), DRAFT_ID);
    assert.equal(await failedStorage.page.getByRole("button", { name: "返回策略列表" }).count(), 1);
    assert.notEqual(await failedStorage.page.evaluate((key) => sessionStorage.getItem(key), RESUME_KEY), null);
    assert.deepEqual(failedStorage.pageErrors, []);
    await failedStorage.context.close();
  } finally {
    await browser?.close();
    await vite?.close();
  }
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const IMAGE_BYTES = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==", "base64");

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
  assert.ok(executable, "Chrome/Chromium is required for the automatic-listing review regression");
  return executable;
}

function localState() {
  return {
    account: { id: "account-review", username: "review", displayName: "Review", role: "admin", status: "active" },
    token: "review-token",
    binding: null,
    currentStoreId: "store-review",
    stores: [{ id: "store-review", label: "审核店铺", companyName: "Review", currencyCode: "CNY" }],
    summary: {},
    caches: {
      collectBox: [{ id: "collect-review", draftVersion: 1 }],
      warehouses: [{
        id: "warehouse-review", warehouse_id: "1001", storeId: "store-review", name: "审核仓库",
        listingEligibility: {
          eligible: true, code: "ELIGIBLE_ACTIVE_FBS", fulfillmentType: "FBS", evidenceRequired: false,
        },
      }],
    },
    jobs: {},
  };
}

const reviewJob = [{
  jobId: "job-review",
  createdAt: "2026-08-20T01:00:00.000Z",
  items: [{
    itemId: "item-review",
    sourceRecordId: "collect-review",
    targetStoreId: "store-review",
    targetWarehouseId: "warehouse-review",
    status: "READY_FOR_REVIEW",
    statusVersion: 4,
    failureCode: "",
    actions: { review: true, approve: true, retry: false, regenerate: true, cancel: true },
  }],
}];

const reviewDetail = {
  itemId: "item-review",
  status: "READY_FOR_REVIEW",
  statusVersion: 4,
  source: { title: "审核商品", sku: "SKU-REVIEW", thumbnailUrl: "" },
  target: { storeId: "store-review", warehouseId: "warehouse-review", warehouseLabel: "审核仓库", stock: 5 },
  price: { currency: "CNY", finalPriceKopecks: "1000" },
  visualGroups: [{ key: "visual-group-review", sourceAssetIds: ["source-a"] }],
  images: [{
    id: "asset-review",
    visualGroupKey: "visual-group-review",
    role: "DETAIL",
    roleLabel: "细节图",
    requestedRole: "SPECIFICATION",
    requestedRoleLabel: "尺寸图",
    substitutionReasonCode: "PRODUCT_DIMENSIONS_UNAVAILABLE",
    substitutionReasonLabel: "缺少可信尺寸，已改用细节图",
    manualReviewWarnings: ["SUBJECT_NOT_DOMINANT"],
    manualReviewWarningLabels: ["商品主体不够突出"],
    slotKey: "main-1",
    accepted: true,
    url: "/auto-listing/items/item-review/assets/asset-review/preview",
  }],
  richContent: { previewText: "审核富文本" },
  timeline: [],
};

test("review drawer retries a failed protected preview and reports completed loading progress", async () => {
  let vite;
  let browser;
  let context;
  let assetRequests = 0;
  const assetAuthorizations = [];
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
    await page.addInitScript(() => localStorage.setItem("token", "review-token"));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/local/state") {
        await route.fulfill({ status: 200, json: localState() });
        return;
      }
      if (url.pathname === "/api/auto-listing/preferences") {
        await route.fulfill({ status: 200, json: {
          ok: true, data: { configVersion: 0 }, imports: [], limits: { maxBytes: 2_097_152, maxRows: 1_000 },
        } });
        return;
      }
      if (url.pathname === "/api/auto-listing/jobs") {
        await route.fulfill({ status: 200, json: { ok: true, data: reviewJob } });
        return;
      }
      if (url.pathname === "/api/auto-listing/items/item-review/review") {
        await route.fulfill({ status: 200, json: { ok: true, data: reviewDetail } });
        return;
      }
      if (url.pathname === "/api/auto-listing/items/item-review/assets/asset-review/preview") {
        assetRequests += 1;
        assetAuthorizations.push(request.headers().authorization || "");
        if (assetRequests === 1) {
          await route.fulfill({ status: 503, json: { message: "preview temporarily unavailable" } });
          return;
        }
        await route.fulfill({ status: 200, contentType: "image/webp", body: IMAGE_BYTES });
        return;
      }
      await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
    });

    await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/auto-listing/`);
    await page.getByRole("tab", { name: "任务中心" }).click();
    await page.getByText("等待审核", { exact: true }).waitFor();
    await page.getByRole("button", { name: "查看" }).click();
    await page.getByRole("button", { name: "重新加载" }).waitFor({ timeout: 2_000 });
    await page.getByRole("button", { name: "重新加载" }).click();
    const image = page.locator('img[alt="细节图"]');
    await image.waitFor({ timeout: 2_000 });
    await page.waitForTimeout(300);

    assert.equal(assetRequests, 2);
    assert.deepEqual(new Set(assetAuthorizations), new Set(["Bearer review-token"]));
    assert.ok(await image.evaluate((element) => element.naturalWidth > 0));
    await page.getByText("尺寸图 → 细节图", { exact: true }).waitFor();
    await page.getByText("缺少可信尺寸，已改用细节图", { exact: true }).waitFor();
    await page.getByText("需人工关注：商品主体不够突出", { exact: true }).waitFor();
    await page.getByText("已加载 1/1", { exact: true }).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close();
    await browser?.close();
    await vite?.close();
  }
});

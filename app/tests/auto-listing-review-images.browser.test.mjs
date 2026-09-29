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
  source: { title: "审核商品", sku: "SKU-REVIEW", thumbnailUrl: "https://cdn.example/review-source.webp" },
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

function sourceAnalysis(count = 13) {
  const assets = Array.from({ length: count }, (_, index) => ({
    sourceAssetId: `source-${index + 1}`,
    terminalStatus: "ANALYZED",
    contentKinds: [index % 3 === 0 ? "PRODUCT_VIEW" : index % 3 === 1 ? "PRODUCT_DETAIL" : "PACKAGE"],
    viewpoints: [{ kind: index === 0 ? "BACK" : "FRONT", confidence: "CONFIRMED", reasonCodes: [] }],
    qualityReasons: [],
    eligibleUses: [index === 0 ? "TARGET_VIEW" : "DETAIL"],
    markingKind: index === 0 ? "EXTERNAL_OVERLAY" : index === 1 ? "PRODUCT_MARKING" : "NONE",
    ocrFactSummaries: index === 0 ? [{ kind: "MODEL", value: "X-20", status: "CONFIRMED" }] : [],
    referencedBySlotKeys: index < 6 ? [`group-a:slot:${index + 1}`] : [],
    selectionReasonCodes: [index < 6 ? "SELECTED_FOR_SLOT" : "REDUNDANT_VIEW"],
    thumbnailPath: `/auto-listing/items/item-source-review/source-assets/source-${index + 1}/preview`,
    sourceOrdinal: index,
    originalImageUrl: `/auto-listing/items/item-source-review/source-assets/source-${index + 1}/preview`,
    effectiveImageUrl: index === 0
      ? "/auto-listing/items/item-source-review/source-assets/source-1/derivatives/cleanup-attempt-3/preview"
      : `/auto-listing/items/item-source-review/source-assets/source-${index + 1}/preview`,
    appearanceMode: index === 0 ? "EXCLUDED" : "ORIGINAL",
    semanticTextRegions: index === 0 ? [
      { sourceText: "20 A", language: "ru", semanticKind: "SELLING_POINT",
        normalizedMeaning: "Ток 20 A", sequence: null, confidence: "CONFIRMED",
        adoptionStatus: "ADOPTED", reasonCodes: ["SOURCE_FACT_EXPLICIT_LOW_RISK_TEXT"] },
      { sourceText: "Скидка 50%", language: "ru", semanticKind: "PROMOTION",
        normalizedMeaning: "Скидка 50%", sequence: null, confidence: "CONFIRMED",
        adoptionStatus: "REJECTED", reasonCodes: ["SOURCE_FACT_FORBIDDEN_TEXT_REJECTED"] },
    ] : [],
    cleanup: index === 0 ? { status: "REJECTED", attemptNo: 3, maximumAttempts: 3,
      reasonCodes: ["SOURCE_IMAGE_CLEANUP_OVERLAY_REMAINS"] } : null,
  }));
  return {
    analysisRunId: "analysis-run-a",
    status: "CONFIRMATION_REQUIRED",
    summaryHash: "a".repeat(64),
    counts: { expected: count, terminal: count, eligible: 6, excluded: count - 6, confirmations: 1 },
    assets,
    requiredConfirmations: [{
      sourceAssetId: "source-1", kind: "EXTERNAL_OVERLAY",
      reasonCodes: ["AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CONFIRMATION_REQUIRED"],
    }],
  };
}

function sourceReviewFixture() {
  return {
    ...reviewDetail,
    itemId: "item-source-review",
    status: "BLOCKED",
    statusVersion: 7,
    source: {
      ...reviewDetail.source,
      thumbnailUrl: "/auto-listing/items/item-source-review/source-assets/source-1/preview",
    },
    sourceImageAnalysis: sourceAnalysis(),
    images: Array.from({ length: 6 }, (_, index) => ({
      ...reviewDetail.images[0], id: `generated-${index + 1}`, roleLabel: `生成图 ${index + 1}`,
      slotKey: `slot-${index + 1}`, url: `/auto-listing/items/item-source-review/assets/generated-${index + 1}/preview`,
    })),
  };
}

test("review drawer retries a failed protected preview and reports completed loading progress", async () => {
  let vite;
  let browser;
  let context;
  let assetRequests = 0;
  let legacySourceRequests = 0;
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
    await page.route("https://cdn.example/**", async (route) => {
      legacySourceRequests += 1;
      await route.fulfill({ status: 200, contentType: "image/webp", body: IMAGE_BYTES });
    });
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
    assert.equal(legacySourceRequests, 1);
    assert.deepEqual(new Set(assetAuthorizations), new Set(["Bearer review-token"]));
    assert.ok(await image.evaluate((element) => element.naturalWidth > 0));
    const legacySource = page.locator('img[alt="采集来源商品"]');
    await legacySource.waitFor({ timeout: 2_000 });
    assert.equal(await legacySource.getAttribute("src"), "https://cdn.example/review-source.webp");
    assert.ok(await legacySource.evaluate((element) => element.naturalWidth > 0));
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

for (const outcome of ["success", "stale"]) {
  test(`source confirmation sends one exact idempotent POST and handles ${outcome}`, async () => {
    let vite;
    let browser;
    let context;
    let decisionRoute = null;
    const bodies = [];
    let jobsReads = 0;
    let sourcePreviewRequests = 0;
    const sourcePreviewAuthorizations = [];
    try {
      vite = await createServer({
        root: appRoot, logLevel: "silent",
        server: { host: "127.0.0.1", port: 0, strictPort: false },
      });
      await vite.listen();
      const address = vite.httpServer.address();
      assert.ok(address && typeof address === "object");
      browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem("token", "review-token"));
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/local/state") return route.fulfill({ status: 200, json: localState() });
        if (url.pathname === "/api/auto-listing/preferences") return route.fulfill({ status: 200, json: {
          ok: true, data: { configVersion: 0 }, imports: [], limits: { maxBytes: 2_097_152, maxRows: 1_000 },
        } });
        if (url.pathname === "/api/auto-listing/jobs") {
          jobsReads += 1;
          return route.fulfill({ status: 200, json: { ok: true, data: [{
            jobId: "job-source-review", createdAt: "2026-08-20T01:00:00.000Z", items: [{
              itemId: "item-source-review", sourceRecordId: "collect-review", targetStoreId: "store-review",
              targetWarehouseId: "warehouse-review", status: "BLOCKED", statusVersion: 7,
              failureCode: "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED",
              actions: { review: true, approve: false, retry: false, regenerate: false, cancel: false },
            }],
          }] } });
        }
        if (url.pathname === "/api/auto-listing/items/item-source-review/review") {
          return route.fulfill({ status: 200, json: { ok: true, data: sourceReviewFixture() } });
        }
        if (/\/api\/auto-listing\/items\/item-source-review\/(?:source-assets\/source-\d+(?:\/derivatives\/cleanup-attempt-3)?|assets\/generated-\d+)\/preview/u.test(url.pathname)) {
          if (url.pathname.includes("/source-assets/")) {
            sourcePreviewRequests += 1;
            sourcePreviewAuthorizations.push(request.headers().authorization || "");
          }
          return route.fulfill({ status: 200, contentType: "image/webp", body: IMAGE_BYTES });
        }
        if (url.pathname === "/api/auto-listing/items/item-source-review/source-image-decisions"
          && request.method() === "POST") {
          bodies.push(request.postDataJSON());
          decisionRoute = route;
          return;
        }
        return route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
      });

      await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/auto-listing/`);
      await page.getByRole("tab", { name: "任务中心" }).click();
      await page.getByRole("button", { name: "查看" }).evaluate((element) => element.click());
      await page.getByText("来源图片分析", { exact: true }).waitFor();
      assert.equal(await page.locator(".auto-listing-source-image-card").count(), 13);
      assert.equal(await page.getByRole("button", { name: "确认为产品固有标识" }).count(), 1);
      await page.getByText("第 3/3 次清理未通过，需要人工审核", { exact: true }).waitFor();
      await page.getByText("外部水印或覆盖标识仍然存在", { exact: true }).waitFor();
      await page.getByText("已采用", { exact: true }).waitFor();
      await page.getByText("未采用：促销信息不能作为商品事实", { exact: true }).waitFor();
      await page.getByText("清理已达 3 次上限，请人工选择如何处理该来源图", { exact: true }).waitFor();
      await page.getByText("已加载 6/6", { exact: true }).waitFor({ timeout: 5_000 });
      await page.getByText("来源预览已加载 14/14", { exact: true }).waitFor({ timeout: 5_000 });
      const sourceProductPreview = page.locator('img[alt="采集来源商品"]');
      await sourceProductPreview.waitFor({ timeout: 5_000 });
      assert.match(await sourceProductPreview.getAttribute("src"), /^blob:/u);
      assert.equal(sourcePreviewRequests, 15);
      assert.deepEqual(new Set(sourcePreviewAuthorizations), new Set(["Bearer review-token"]));
      assert.equal(await page.locator('.auto-listing-source-image-card img').count(), 14);
      assert.equal(await page.locator('img[alt^="生成图 "]').count(), 6);
      const button = page.getByRole("button", { name: "确认为产品固有标识" });
      await button.click();
      for (let turn = 0; turn < 20 && bodies.length === 0; turn += 1) await page.waitForTimeout(10);
      assert.equal(await button.isDisabled(), true);
      await button.click({ force: true }).catch(() => {});
      assert.equal(bodies.length, 1);
      assert.deepEqual(bodies[0], {
        jobId: "job-source-review", analysisRunId: "analysis-run-a", sourceAssetId: "source-1",
        decision: "PRODUCT_MARKING", expectedStatusVersion: 7,
        idempotencyKey: bodies[0].idempotencyKey, correlationId: bodies[0].correlationId,
      });
      assert.match(bodies[0].idempotencyKey, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u);
      assert.match(bodies[0].correlationId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u);
      assert.ok(decisionRoute);
      if (outcome === "success") {
        await decisionRoute.fulfill({ status: 200, json: { ok: true, data: { statusVersion: 8 } } });
        await page.getByText("已提交确认，正在重新归并商品图片证据", { exact: true }).waitFor();
      } else {
        await decisionRoute.fulfill({ status: 409, json: { message: "stale evidence" } });
        await page.getByText("商品状态已变化，已刷新最新证据", { exact: true }).waitFor();
      }
      await page.getByText("来源图片分析", { exact: true }).waitFor({ state: "detached" });
      assert.ok(jobsReads >= 2);
    } finally {
      await decisionRoute?.abort?.().catch?.(() => {});
      await context?.close();
      await browser?.close();
      await vite?.close();
    }
  });
}

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const ACCOUNT_ID = "account-category-analysis-failure";
const DRAFT_ID = "draft-category-analysis-failure";
const ROLES = ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"];
const SCOPE = { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17033973, typeId: 115946631 };

function browserExecutable() {
  const candidates = [
    process.env.JZ_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  assert.ok(executable, "Chrome/Chromium is required for the category strategy failure regression");
  return executable;
}

function guidance() {
  return {
    overallStyle: "Безопасная резервная стратегия",
    prohibitedPatterns: ["Не публиковать результат"],
    roles: Object.fromEntries(ROLES.map((role) => [role, {
      composition: `${role} композиция`, background: `${role} фон`,
      textDensity: role === "MAIN" ? "NONE" : "LIGHT", layout: `${role} макет`,
    }])),
  };
}

function summary() {
  return { draftId: DRAFT_ID, scope: SCOPE, draftVersion: 6, status: "NEEDS_REVIEW", sampleCount: 8 };
}

function bundle() {
  return {
    draft: { ...summary(), sourceCollectItemId: "collect-analysis-failure", expectedSourceVersion: "draft:1" },
    session: null,
    samples: Array.from({ length: 8 }, (_, index) => ({
      sampleId: `sample-${index}`, sku: `sku-${index}`, title: null,
      thumbnailUrl: `/api/admin/auto-listing/category-strategies/${DRAFT_ID}/samples/sample-${index}/images/image-${index}/thumbnail`,
      previewRole: "DETAIL", previewWidth: 1200, previewHeight: 1600,
      mainImageWidth: 50, mainImageHeight: 50, imageCount: 6, status: "READY", excludedReasons: [],
    })),
    analysis: {
      attemptId: "attempt-analysis-failure", resultId: "result-analysis-failure",
      status: "NEEDS_REVIEW", draftVersion: 6, duplicate: false,
      safeCode: "AUTO_LISTING_CATEGORY_STRATEGY_AI_CALL_FAILED", guidance: guidance(), evidenceSummary: null,
      provenance: "AI", editedAt: null, baseAnalysisAttemptId: null,
    },
    published: null, categoryPublications: [], versions: [],
  };
}

test("a persisted rejected analysis remains visibly actionable after the detail page reloads", async () => {
  let vite;
  let browser;
  let context;
  try {
    vite = await createServer({ root: appRoot, logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false } });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address === "object");
    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    await page.addInitScript(() => localStorage.setItem("token", "category-analysis-failure-token"));
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/local/state") {
        await route.fulfill({ status: 200, json: { account: {
          id: ACCOUNT_ID, username: "analysis-failure", displayName: "Analysis Failure", role: "admin", status: "active",
        }, accounts: [], token: "category-analysis-failure-token", binding: null, currentStoreId: "",
        stores: [], summary: {}, caches: { collectBox: [] }, jobs: {} } });
        return;
      }
      if (pathname === "/api/admin/auto-listing/category-strategies") {
        await route.fulfill({ status: 200, json: { ok: true, data: [summary()] } });
        return;
      }
      if (pathname === `/api/admin/auto-listing/category-strategies/${DRAFT_ID}`) {
        await route.fulfill({ status: 200, json: { ok: true, data: bundle() } });
        return;
      }
      await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
    });

    const baseUrl = `http://127.0.0.1:${address.port}`;
    await page.goto(`${baseUrl}/ozon/tools/category-strategies/?draftId=${DRAFT_ID}`);
    await page.getByText("类目策略草稿生成失败", { exact: true }).waitFor();
    assert.equal(await page.getByText(
      "当前 AI 模型通道调用失败，未生成类目策略草稿。请检查模型通道可用性后重试。",
      { exact: true },
    ).count(), 1);
    assert.equal(await page.getByText("样本已变化，请重新生成策略草稿", { exact: true }).count(), 0);
    assert.equal(await page.getByText("本次未生成可用策略草稿，请按上方提示处理后重试", { exact: true }).count(), 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close();
    await browser?.close();
    await vite?.close();
  }
});

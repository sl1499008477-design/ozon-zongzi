import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const ACCOUNT_ID = "account-category-language";
const NEW_DRAFT_ID = "draft-category-language-new";
const OLD_DRAFT_ID = "draft-category-language-old";
const ROLES = ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"];
const SCOPE = { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 };

function browserExecutable() {
  const candidates = [
    process.env.JZ_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  assert.ok(executable, "Chrome/Chromium is required for the category strategy language regression");
  return executable;
}

function guidance(language) {
  const chinese = language === "zh";
  return {
    overallStyle: chinese ? "中文整体风格" : "Русский общий стиль",
    prohibitedPatterns: [chinese ? "不要复制品牌标识" : "Не копировать товарные знаки"],
    roles: Object.fromEntries(ROLES.map((role) => [role, {
      composition: chinese ? `${role} 中文构图` : `${role} русская композиция`,
      background: chinese ? `${role} 中文背景` : `${role} русский фон`,
      textDensity: role === "MAIN" ? "NONE" : "LIGHT",
      layout: chinese ? `${role} 中文布局` : `${role} русская схема`,
    }])),
  };
}

function analysis({ bilingual }) {
  return {
    attemptId: bilingual ? "attempt-new" : "attempt-old",
    resultId: bilingual ? "result-new" : "result-old",
    status: "DRAFT_READY", draftVersion: 4, duplicate: false, safeCode: null,
    guidance: guidance("ru"),
    evidenceSummary: {
      roleEvidence: Object.fromEntries(ROLES.map((role) => [role,
        { evidenceIds: ["image-1", "image-2"], confidence: 0.82 }])),
      commonPatterns: [{ pattern: "Товар расположен по центру", evidenceIds: ["image-1", "image-2"], confidence: 0.82 }],
      differences: [{ pattern: "Один образец использует реквизит", evidenceIds: ["image-3"] }],
      cautions: ["Не копировать товарные знаки"],
      ...(bilingual ? { managementZh: {
        guidance: guidance("zh"),
        commonPatterns: ["商品居中"], differences: ["单个样本使用道具"], cautions: ["不要复制品牌标识"],
      } } : {}),
    },
    provenance: "AI", editedAt: null, baseAnalysisAttemptId: null,
  };
}

function summary(draftId) {
  return { draftId, scope: SCOPE, draftVersion: 4, status: "DRAFT_READY", sampleCount: 0 };
}

function bundle(draftId) {
  return {
    draft: { ...summary(draftId), sourceCollectItemId: "collect-language", expectedSourceVersion: "draft:1" },
    session: null, samples: [], analysis: analysis({ bilingual: draftId === NEW_DRAFT_ID }),
    published: null, categoryPublications: [], versions: [],
  };
}

test("bilingual drafts default to Chinese management text while Russian remains the editable execution rule", async () => {
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
    await page.addInitScript(() => localStorage.setItem("token", "category-language-token"));
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/local/state") {
        await route.fulfill({ status: 200, json: { account: {
          id: ACCOUNT_ID, username: "language", displayName: "Language", role: "admin", status: "active",
        }, accounts: [], token: "category-language-token", binding: null, currentStoreId: "",
        stores: [], summary: {}, caches: { collectBox: [] }, jobs: {} } });
        return;
      }
      if (pathname === "/api/admin/auto-listing/category-strategies") {
        await route.fulfill({ status: 200, json: { ok: true,
          data: [summary(NEW_DRAFT_ID), summary(OLD_DRAFT_ID)] } });
        return;
      }
      for (const draftId of [NEW_DRAFT_ID, OLD_DRAFT_ID]) {
        if (pathname === `/api/admin/auto-listing/category-strategies/${draftId}`) {
          await route.fulfill({ status: 200, json: { ok: true, data: bundle(draftId) } });
          return;
        }
      }
      await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
    });

    const baseUrl = `http://127.0.0.1:${address.port}`;
    await page.goto(`${baseUrl}/ozon/tools/category-strategies/?draftId=${NEW_DRAFT_ID}`);
    await page.getByText("中文管理说明（只读）", { exact: true }).waitFor();
    assert.equal(await page.getByText("中文整体风格", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Русский общий стиль", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "保存人工编辑" }).count(), 0);
    await page.getByText("俄文执行规则", { exact: true }).click();
    await page.locator("textarea").first().waitFor();
    assert.equal(await page.locator("textarea").first().inputValue(), "Русский общий стиль");
    assert.equal(await page.getByRole("button", { name: "保存人工编辑" }).count(), 1);

    await page.goto(`${baseUrl}/ozon/tools/category-strategies/?draftId=${OLD_DRAFT_ID}`);
    await page.getByText("旧草稿仅有俄文", { exact: true }).waitFor();
    await page.locator("textarea").first().waitFor();
    assert.equal(await page.locator("textarea").first().inputValue(), "Русский общий стиль");
    assert.equal(await page.getByText("中文管理说明", { exact: true }).count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close();
    await browser?.close();
    await vite?.close();
  }
});

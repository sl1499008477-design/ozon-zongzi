import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const ACCOUNT_ID = "account-category-history";
const DRAFT_ID = "draft-category-history";
const SCOPE = { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 88945948, typeId: 970861825 };

function browserExecutable() {
  const candidates = [
    process.env.JZ_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  assert.ok(executable, "Chrome/Chromium is required for the category strategy history regression");
  return executable;
}

function summary() {
  return { draftId: DRAFT_ID, scope: SCOPE, draftVersion: 5, status: "PUBLISHED", sampleCount: 0 };
}

function bundle() {
  const versions = [4, 3, 2, 1].map((version) => ({
    id: `strategy-v${version}`,
    strategyKey: "default",
    version,
    status: version === 4 ? "PUBLISHED" : "RETIRED",
  }));
  return {
    draft: { ...summary(), sourceCollectItemId: "collect-history", expectedSourceVersion: "draft:1" },
    session: null,
    samples: [],
    analysis: null,
    published: versions[0],
    categoryPublications: [{
      eventId: "publication-v4",
      strategyVersionId: "strategy-v4",
      strategyVersion: 4,
      publishedAt: "2026-08-18T06:03:32.827Z",
    }],
    versions,
  };
}

test("category detail separates its publication record from account-wide rollback history", async () => {
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
    await page.addInitScript(() => localStorage.setItem("token", "category-history-token"));
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/local/state") {
        await route.fulfill({ status: 200, json: { account: {
          id: ACCOUNT_ID, username: "history", displayName: "History", role: "admin", status: "active",
        }, accounts: [], token: "category-history-token", binding: null, currentStoreId: "",
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

    await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/category-strategies/?draftId=${DRAFT_ID}`);
    const categoryCard = page.locator(".ant-card").filter({
      has: page.getByText("当前类目发布记录", { exact: true }),
    });
    await categoryCard.waitFor();
    assert.equal(await categoryCard.locator("tbody tr").count(), 1);
    assert.equal(await categoryCard.getByText("v4", { exact: true }).count(), 1);

    const accountCard = page.locator(".ant-card").filter({
      has: page.getByText("账号策略包版本历史（高级操作）", { exact: true }),
    });
    assert.equal(await accountCard.locator("tbody tr").count(), 4);
    await accountCard.getByText("回滚会替换整个账号策略包，并影响其中所有类目。", { exact: true }).waitFor();
    await accountCard.getByRole("button", { name: "创建账号级回滚版本" }).first().click();
    await page.getByText(
      "账号级回滚会复制所选历史版本的全部规则，并替换整个账号策略包；其中所有类目都会受到影响。原历史记录不会被修改。",
      { exact: true },
    ).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close();
    await browser?.close();
    await vite?.close();
  }
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const DRAFT_ID = "draft-category-preview";
const SCOPE = { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 };
const SAMPLE = {
  sampleId: "sample-category-preview",
  sku: "664880603",
  title: null,
  thumbnailUrl: `/api/admin/auto-listing/category-strategies/${DRAFT_ID}/samples/sample-category-preview/images/detail-image/thumbnail`,
  imageCount: 6,
  previewRole: "DETAIL",
  previewWidth: 1240,
  previewHeight: 1240,
  mainImageWidth: 38,
  mainImageHeight: 50,
  status: "READY",
  excludedReasons: [],
};
const SAMPLES = [SAMPLE, ...Array.from({ length: 4 }, (_, index) => ({
  ...SAMPLE,
  sampleId: `sample-category-preview-${index + 2}`,
  sku: `66488060${index + 4}`,
  thumbnailUrl: `/api/admin/auto-listing/category-strategies/${DRAFT_ID}`
    + `/samples/sample-category-preview-${index + 2}/images/main-image-${index + 2}/thumbnail`,
  imageCount: 1,
  previewRole: "MAIN",
  previewWidth: 1200,
  previewHeight: 1600,
  mainImageWidth: 1200,
  mainImageHeight: 1600,
}))];

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
  assert.ok(executable, "Chrome/Chromium is required for the category sample preview regression");
  return executable;
}

test("sample cards show a clear existing preview and the original main-image quality", async () => {
  let vite;
  let browser;
  let context;
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
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    let requestedThumbnail = "";
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    await page.addInitScript(() => localStorage.setItem("token", "category-preview-token"));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/local/state") {
        await route.fulfill({ status: 200, json: {
          account: { id: "account-category-preview", username: "preview", displayName: "Preview", role: "admin", status: "active" },
          accounts: [], token: "category-preview-token", binding: null, currentStoreId: "", stores: [],
          summary: {}, caches: { collectBox: [] }, jobs: {},
        } });
        return;
      }
      if (url.pathname === "/api/admin/auto-listing/category-strategies") {
        await route.fulfill({ status: 200, json: { ok: true, data: [{
          draftId: DRAFT_ID, scope: SCOPE, draftVersion: 2, status: "SAMPLES_READY", sampleCount: 5,
        }] } });
        return;
      }
      if (url.pathname === `/api/admin/auto-listing/category-strategies/${DRAFT_ID}`) {
        await route.fulfill({ status: 200, json: { ok: true, data: {
          draft: { draftId: DRAFT_ID, scope: SCOPE, draftVersion: 2, status: "SAMPLES_READY", sampleCount: 5,
            sourceCollectItemId: "collect-category-preview", expectedSourceVersion: "draft:1" },
          session: null, samples: SAMPLES, analysis: null, published: null, versions: [],
        } } });
        return;
      }
      if (SAMPLES.some((sample) => sample.thumbnailUrl === url.pathname)) {
        if (url.pathname === SAMPLE.thumbnailUrl) requestedThumbnail = url.pathname;
        await route.fulfill({ status: 200, contentType: "image/webp",
          body: Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==", "base64") });
        return;
      }
      await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
    });

    await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/category-strategies/?draftId=${DRAFT_ID}`);
    await page.getByText("预览：详情图 1240×1240", { exact: true }).waitFor();
    assert.equal(await page.getByText("共 6 张", { exact: true }).count(), 1);
    assert.equal(await page.getByText("采集主图：38×50（低清源图）", { exact: true }).count(), 1);
    await page.locator(`img[alt="${SAMPLE.sku} 样本清晰预览"]`).waitFor();
    assert.equal(requestedThumbnail, SAMPLE.thumbnailUrl);
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await browser?.close();
    await vite?.close();
  }
});

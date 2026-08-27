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
  assert.ok(executable, "Chrome/Chromium is required for the upload-policy regression");
  return executable;
}

function localState() {
  return {
    account: { id: "account-policy", username: "policy", displayName: "Policy", role: "admin", status: "active" },
    token: "policy-token",
    binding: null,
    currentStoreId: "store-policy",
    stores: [{ id: "store-policy", label: "策略店铺", companyName: "Policy", currencyCode: "CNY" }],
    summary: {},
    caches: {
      collectBox: [{ id: "collect-policy", draftVersion: 1 }],
      warehouses: [{
        id: "warehouse-policy", warehouse_id: "1001", storeId: "store-policy", name: "策略仓库",
        listingEligibility: {
          eligible: true, code: "ELIGIBLE_ACTIVE_FBS", fulfillmentType: "FBS", evidenceRequired: false,
        },
      }],
    },
    jobs: {},
  };
}

function policy(mode, version) {
  return {
    id: `policy-${mode.toLowerCase()}-${version}`,
    accountId: "account-policy",
    version,
    mode,
    enabled: true,
    publicationReason: "browser test",
    publishedBy: "account-policy",
    publishedAt: "2026-08-25T00:00:00.000Z",
    publicationOrigin: "https://media.example.test",
    publicationBaseUrl: "https://media.example.test/",
    publicationPrefix: "listing-media/v1",
    publicationVersion: "LISTING_MEDIA_V1",
    publicationPolicyHash: "a".repeat(64),
  };
}

test("administrator enables DIRECT beside brand handling only after publication health passes", async () => {
  let vite;
  let browser;
  let context;
  let currentPolicy = policy("REVIEW", 3);
  let healthCalls = 0;
  let healthOutcome = "PASSED";
  const publications = [];
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
    await page.addInitScript(() => localStorage.setItem("token", "policy-token"));
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
        await route.fulfill({ status: 200, json: { ok: true, data: [] } });
        return;
      }
      if (url.pathname === "/api/admin/auto-listing/upload-policies" && request.method() === "GET") {
        await route.fulfill({ status: 200, json: { ok: true, data: [currentPolicy] } });
        return;
      }
      if (url.pathname === "/api/admin/auto-listing/upload-policies/publication-health") {
        healthCalls += 1;
        assert.deepEqual(request.postDataJSON(), {});
        await route.fulfill({ status: 201, json: { ok: true, data: {
          accountId: "account-policy", evidenceId: "health-policy", outcome: healthOutcome,
          checkedAt: "2026-08-25T00:00:00.000Z", expiresAt: "2026-08-25T00:05:00.000Z",
        } } });
        return;
      }
      if (url.pathname === "/api/admin/auto-listing/upload-policies" && request.method() === "POST") {
        const body = request.postDataJSON();
        publications.push(body);
        currentPolicy = policy(body.mode, currentPolicy.version + 1);
        await route.fulfill({ status: 201, json: { ok: true, data: currentPolicy } });
        return;
      }
      await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
    });

    await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/auto-listing/?source=collect&ids=collect-policy`);
    const brandSwitch = page.getByRole("switch", { name: "使用采集品牌" });
    const directSwitch = page.getByRole("switch", { name: "自动上传到 Ozon" });
    await directSwitch.waitFor({ timeout: 3_000 });
    const [brandBox, directBox] = await Promise.all([brandSwitch.boundingBox(), directSwitch.boundingBox()]);
    assert.ok(brandBox && directBox);
    assert.ok(directBox.x > brandBox.x, "DIRECT switch should be placed to the right of brand handling");
    assert.ok(Math.abs(directBox.y - brandBox.y) < 80, "DIRECT switch should share the brand handling row");
    assert.equal(await directSwitch.getAttribute("aria-checked"), "false");

    await directSwitch.click();
    await page.getByRole("button", { name: "确认开启" }).click();
    await page.getByText("已开启自动上传到 Ozon", { exact: true }).waitFor();
    assert.equal(healthCalls, 1);
    assert.equal(publications.length, 1);
    assert.equal(publications[0].mode, "DIRECT");
    assert.equal(typeof publications[0].publicationReason, "string");
    assert.equal(typeof publications[0].idempotencyKey, "string");
    assert.equal(typeof publications[0].correlationId, "string");
    assert.equal(await directSwitch.getAttribute("aria-checked"), "true");

    await directSwitch.click();
    await page.getByText("已恢复人工审核后上传", { exact: true }).waitFor();
    assert.equal(healthCalls, 1);
    assert.equal(publications.length, 2);
    assert.equal(publications[1].mode, "REVIEW");
    assert.equal(await directSwitch.getAttribute("aria-checked"), "false");

    healthOutcome = "FAILED";
    await directSwitch.click();
    await page.getByRole("button", { name: "确认开启" }).click();
    await page.getByText("公网图片健康检查未通过，仍保持人工审核后上传", { exact: true }).waitFor();
    assert.equal(healthCalls, 2);
    assert.equal(publications.length, 2);
    assert.equal(await directSwitch.getAttribute("aria-checked"), "false");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close();
    await browser?.close();
    await vite?.close();
  }
});

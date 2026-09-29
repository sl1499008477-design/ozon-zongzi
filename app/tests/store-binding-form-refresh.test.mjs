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
  assert.ok(executable, "Chrome/Chromium is required for the store form browser regression");
  return executable;
}

function localState(store) {
  return {
    account: {
      id: "account-form-test",
      username: "form-test",
      displayName: "Form Test",
      role: "admin",
      status: "active",
    },
    token: "browser-test-token",
    binding: store,
    currentStoreId: store.id,
    stores: [store],
    summary: {},
    caches: {},
    jobs: {},
  };
}

async function settleReact(page) {
  await page.evaluate(() => new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  }));
}

test("local state loads once and does not poll over an open store form", async () => {
  const initialStore = {
    id: "store-current",
    clientId: "2141679",
    label: "当前店铺",
    companyName: "Current Store",
    apiKeyMasked: "已保存",
    apiKeyCreatedAt: "2026-07-29",
  };
  let stateRequests = 0;
  let bindingSubmissions = 0;
  let vite;
  let browser;

  try {
    vite = await createServer({
      root: appRoot,
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address === "object");

    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      timezoneId: "Asia/Shanghai",
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));

    await page.addInitScript(() => {
      const intervals = new Map();
      let nextIntervalId = 1;
      window.__testIntervals = intervals;
      window.setInterval = (callback, delay, ...args) => {
        const id = nextIntervalId;
        nextIntervalId += 1;
        intervals.set(id, {
          delay,
          callback: () => callback(...args),
        });
        return id;
      };
      window.clearInterval = (id) => intervals.delete(id);
      window.__runIntervalsForTest = async (delay) => {
        const callbacks = [...intervals.values()]
          .filter((entry) => entry.delay === delay)
          .map((entry) => entry.callback());
        await Promise.all(callbacks);
      };
      localStorage.setItem("token", "browser-test-token");
    });

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/local/state" && request.method() === "GET") {
        stateRequests += 1;
        await route.fulfill({ status: 200, json: localState(initialStore) });
        return;
      }
      if (pathname === "/api/local/binding") bindingSubmissions += 1;
      await route.fulfill({ status: 404, json: { message: "not available in this fixture" } });
    });

    await page.goto(`http://127.0.0.1:${address.port}/ozon/settings/stores/`);
    await page.getByRole("button", { name: "新增", exact: true }).waitFor();
    await page.getByRole("button", { name: "新增", exact: true }).click();

    const clientId = page.locator('input[placeholder="Ozon Client-Id"]');
    const apiKey = page.locator('input[placeholder="Ozon Api-Key"]');
    const label = page.locator('input[placeholder="可选，例如：主店"]');
    const createdAt = page.locator('input[type="date"]');
    const storeForm = page.locator(".ant-modal form");

    await settleReact(page);

    assert.equal(await storeForm.getAttribute("autocomplete"), "off");
    assert.equal(await clientId.getAttribute("autocomplete"), "off");
    assert.equal(await apiKey.getAttribute("autocomplete"), "new-password");
    assert.equal(await clientId.inputValue(), "");
    assert.equal(await apiKey.inputValue(), "");
    assert.equal(await label.inputValue(), "");
    assert.equal(await createdAt.inputValue(), "");

    await clientId.fill("999999999");
    await apiKey.fill("temporary-not-submitted-key");
    await label.fill("临时复现-不提交");
    await createdAt.fill("2026-08-01");
    const requestsBeforeIdleTimers = stateRequests;
    await page.evaluate(() => window.__runIntervalsForTest(15_000));

    assert.ok(requestsBeforeIdleTimers >= 1, "the application must load its initial local state");
    assert.equal(stateRequests, requestsBeforeIdleTimers, "idle pages must not reload the complete local state every 15 seconds");
    assert.equal(await clientId.inputValue(), "999999999");
    assert.equal(await apiKey.inputValue(), "temporary-not-submitted-key");
    assert.equal(await label.inputValue(), "临时复现-不提交");
    assert.equal(await createdAt.inputValue(), "2026-08-01");

    await page.getByRole("button", { name: /取\s*消/ }).click();
    await page.getByRole("button", { name: "新增", exact: true }).click();
    await settleReact(page);
    assert.equal(await clientId.inputValue(), "");
    assert.equal(await apiKey.inputValue(), "");
    assert.equal(await label.inputValue(), "");
    assert.equal(await createdAt.inputValue(), "");
    await page.getByRole("button", { name: /取\s*消/ }).click();

    await page.getByRole("button", { name: "修改", exact: true }).click();
    await settleReact(page);
    assert.equal(await clientId.inputValue(), initialStore.clientId);
    assert.equal(await apiKey.inputValue(), "");
    assert.equal(await label.inputValue(), initialStore.label);
    assert.equal(await createdAt.inputValue(), initialStore.apiKeyCreatedAt);

    await label.fill("编辑未提交");
    const requestsBeforeSecondIdleTimer = stateRequests;
    await page.evaluate(() => window.__runIntervalsForTest(15_000));
    assert.equal(stateRequests, requestsBeforeSecondIdleTimer);
    assert.equal(await label.inputValue(), "编辑未提交");
    assert.equal(bindingSubmissions, 0, "the regression must never submit store credentials");
    assert.deepEqual(pageErrors, []);
  } finally {
    await Promise.allSettled([
      browser?.close(),
      vite?.close(),
    ]);
  }
});

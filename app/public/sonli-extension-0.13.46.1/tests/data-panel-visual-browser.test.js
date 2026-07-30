const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright-core");

const rootDir = path.resolve(__dirname, "..", "..");
const fixturePath = "/extension/tests/fixtures/data-panel-visual-browser.fixture.html";
const cleanupChildMode = process.env.JZ_BROWSER_TEST_CHILD_MODE === "forced-launch-failure";

function runCleanupChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], {
      env: {
        ...process.env,
        JZ_BROWSER_TEST_CHILD_MODE: "forced-launch-failure",
        JZ_BROWSER_TEST_FORCE_LAUNCH_FAILURE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("cleanup child did not exit within 5 seconds"));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, output, signal });
    });
  });
}

function resolveBrowserPath() {
  const candidates = [
    process.env.JZ_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  assert.ok(
    executablePath,
    `No Chrome/Chromium executable found. Set JZ_BROWSER_PATH to run ${path.basename(__filename)}.`,
  );
  return executablePath;
}

function startFixtureServer() {
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  const server = createServer((request, response) => {
    const requestPath = new URL(request.url, "http://127.0.0.1").pathname;
    const filePath = path.resolve(rootDir, `.${decodeURIComponent(requestPath)}`);
    if (!filePath.startsWith(`${rootDir}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const contents = readFileSync(filePath);
      response.writeHead(200, { "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
      response.end(contents);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function gridColumnCount(columns) {
  return columns.trim().split(/\s+/).filter(Boolean).length;
}

async function closeQuietly(label, close, cleanupErrors) {
  try {
    await close();
    return true;
  } catch (error) {
    cleanupErrors.push(new Error(`Could not close ${label}`, { cause: error }));
    return false;
  }
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function runBrowserFixture({
  forceLaunchFailure = process.env.JZ_BROWSER_TEST_FORCE_LAUNCH_FAILURE === "1",
  onServerClosed,
} = {}) {
  let server;
  let browser;
  let context;
  let page;
  let primaryError;
  try {
    server = await startFixtureServer();
    const address = server.address();
    if (forceLaunchFailure) {
      throw new Error("forced browser launch failure");
    }
    browser = await chromium.launch({ executablePath: resolveBrowserPath(), headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();

    await page.goto(`http://127.0.0.1:${address.port}${fixturePath}`);
    await page.waitForSelector('.ozon-helper-data-panel [data-field="sales30d"]');
    await page.evaluate(() => window.__setPanelFixtureWidth(640));

    const settingsHelpers = await page.evaluate(() => ({
      groups: window.jzGroupDataCardFields([
        { field: "sku", label: "SKU", group: "商品信息" },
        { field: "rating", label: "评分", group: "物流商品" },
      ]),
      count: window.jzCountVisibleDataCardFields(
        [{ field: "sku" }, { field: "rating" }],
        { rating: false },
      ),
    }));
    assert.deepEqual(settingsHelpers, {
      groups: [
        { name: "商品信息", fields: [{ field: "sku", label: "SKU", group: "商品信息" }] },
        { name: "物流商品", fields: [{ field: "rating", label: "评分", group: "物流商品" }] },
      ],
      count: { visible: 1, total: 2 },
    });

    const wide = await page.evaluate(() => {
      const panel = document.querySelector(".ozon-helper-data-panel");
      const hero = panel.querySelector(".oh-hero-section");
      return {
        background: getComputedStyle(panel).backgroundColor,
        columns: getComputedStyle(hero).gridTemplateColumns,
        backgrounds: [...panel.querySelectorAll(".oh-hero-stat")].map((stat) => getComputedStyle(stat).backgroundColor),
        fields: [...panel.querySelectorAll("[data-field]")].map((field) => field.getAttribute("data-field")),
        actions: [...panel.querySelectorAll("[data-action]")].map((action) => action.getAttribute("data-action")),
      };
    });
    assert.equal(wide.background, "rgb(255, 255, 255)");
    assert.equal(gridColumnCount(wide.columns), 4);
    assert.deepEqual(wide.backgrounds, Array(4).fill("rgb(242, 247, 255)"));
    for (const field of ["sales30d", "createDate", "heroFollow", "heroSize", "category", "sku", "returnRate", "rating", "dimensions", "volume", "weight"]) {
      assert.ok(wide.fields.includes(field), `missing rendered field ${field}`);
    }
    for (const action of ["open-field-settings", "follow-sell", "edit-list", "collect-one"]) {
      assert.ok(wide.actions.includes(action), `missing rendered action ${action}`);
    }

    await page.locator('.ozon-helper-data-panel [data-action="open-field-settings"]').click();
    const settingsMask = page.locator(".jz-fieldset-mask");
    const settingsModal = settingsMask.locator(".jz-fieldset-modal");
    await settingsMask.waitFor();
    assert.equal(await settingsModal.locator(".jz-fieldset-title").innerText(), "插件展示设置");
    assert.match(await settingsModal.locator(".jz-fieldset-note").innerText(), /选择商品详情页面板中需要展示的全部信息/);

    const fieldCount = await settingsModal.locator('input[data-jz-field]').count();
    assert.ok(fieldCount > 0, "settings must use the real field catalogue");
    assert.equal(await settingsModal.locator("[data-jz-visible-count]").innerText(), String(fieldCount));
    assert.equal(await settingsModal.locator(".jz-fieldset-summary span").innerText(), `/ ${fieldCount} 项信息`);
    for (const action of ["enable-all", "disable-all", "toggle-group", "restore-default", "save"]) {
      assert.ok(await settingsModal.locator(`[data-jz-act="${action}"]`).count() > 0, `missing ${action} settings action`);
    }

    const desktopSettings = await settingsModal.evaluate((modal) => ({
      modalWidth: getComputedStyle(modal).width,
      columns: getComputedStyle(modal.querySelector(".jz-fieldset-body")).gridTemplateColumns,
      maskBackground: getComputedStyle(modal.parentElement).backgroundColor,
    }));
    assert.equal(desktopSettings.modalWidth, "960px");
    assert.equal(gridColumnCount(desktopSettings.columns), 3);
    assert.equal(desktopSettings.maskBackground, "rgba(16, 35, 74, 0.38)");

    await settingsModal.locator('[data-jz-act="disable-all"]').click();
    assert.equal(await settingsModal.locator('input[data-jz-field]:checked').count(), 0);
    assert.equal(await settingsModal.locator("[data-jz-visible-count]").innerText(), "0");
    assert.equal((await page.evaluate(() => window.__getPanelStorageFixtureState())).setCalls, 0, "batch controls must not persist before save");

    const firstFieldGroup = settingsModal.locator('section.jz-fieldset-group[data-jz-group]').first();
    const firstGroupFieldCount = await firstFieldGroup.locator('input[data-jz-field]').count();
    await firstFieldGroup.locator('[data-jz-act="toggle-group"]').click();
    assert.equal(await firstFieldGroup.locator('input[data-jz-field]:checked').count(), firstGroupFieldCount);
    assert.equal(await settingsModal.locator("[data-jz-visible-count]").innerText(), String(firstGroupFieldCount));

    await settingsModal.locator('input[name="jz-sales-period"][value="weekly"]').check();
    await settingsModal.locator('[data-jz-act="restore-default"]').click();
    assert.equal(await settingsModal.locator('input[data-jz-field]:checked').count(), fieldCount);
    assert.equal(await settingsModal.locator('input[name="jz-sales-period"][value="monthly"]').isChecked(), true);

    await settingsModal.locator('input[data-jz-field="rating"]').uncheck();
    await settingsModal.getByRole("button", { name: "取消" }).click();
    await settingsMask.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.__getPanelStorageFixtureState()), {
      values: {},
      setCalls: 0,
      payloads: [],
      pendingSets: 0,
    }, "cancel must discard unsaved field changes");

    await page.locator('.ozon-helper-data-panel [data-action="open-field-settings"]').click();
    await settingsMask.waitFor();
    await settingsModal.locator('input[data-jz-field="rating"]').uncheck();
    await settingsModal.locator('[data-jz-act="save"]').click();
    await settingsMask.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.__getPanelStorageFixtureState()), {
      values: { dataCardFieldVisibility: { rating: false }, dataCardSalesPeriod: "monthly" },
      setCalls: 1,
      payloads: [{ dataCardFieldVisibility: { rating: false }, dataCardSalesPeriod: "monthly" }],
      pendingSets: 0,
    }, "save must atomically persist visibility and the selected sales period through the existing keys");
    assert.equal(
      await page.locator('.ozon-helper-data-panel [data-field="rating"]').evaluate((field) => getComputedStyle(field.closest('.ozon-helper-sidebar-card-row') || field).display),
      "none",
      "successful save should apply visibility to the rendered production panel",
    );

    await page.evaluate(() => {
      window.__setPanelStorageFixtureState({ dataCardFieldVisibility: { sku: false }, dataCardSalesPeriod: "weekly" });
      window.__setPanelStorageFixtureMode("failure");
    });
    await page.locator('.ozon-helper-data-panel [data-action="open-field-settings"]').click();
    await settingsMask.waitFor();
    assert.equal(
      await settingsModal.locator('section[data-jz-group="商品信息"] [data-jz-act="toggle-group"]').innerText(),
      "全选",
      "a partially selected group should offer 全选 when the modal opens",
    );
    await settingsModal.locator('input[data-jz-field="rating"]').uncheck();
    await settingsModal.locator('[data-jz-act="save"]').click();
    await settingsModal.locator("[data-jz-save-error]").waitFor();
    assert.equal(await settingsModal.locator("[data-jz-save-error]").innerText(), "fixture storage failed");
    assert.equal(await settingsModal.locator('[data-jz-act="save"]').isDisabled(), false, "a failed save should be retryable");
    assert.equal(await settingsMask.count(), 1, "a failed save must leave the modal available for recovery");
    assert.deepEqual(await page.evaluate(() => window.__getPanelStorageFixtureState()), {
      values: { dataCardFieldVisibility: { sku: false }, dataCardSalesPeriod: "weekly" },
      setCalls: 1,
      payloads: [{ dataCardFieldVisibility: { sku: false, rating: false }, dataCardSalesPeriod: "monthly" }],
      pendingSets: 0,
    }, "an atomic storage failure must not leave one setting persisted");
    await page.evaluate(() => window.__setPanelStorageFixtureMode("success"));
    await settingsModal.locator('[data-jz-act="save"]').click();
    await settingsMask.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.__getPanelStorageFixtureState()), {
      values: { dataCardFieldVisibility: { sku: false, rating: false }, dataCardSalesPeriod: "monthly" },
      setCalls: 2,
      payloads: [
        { dataCardFieldVisibility: { sku: false, rating: false }, dataCardSalesPeriod: "monthly" },
        { dataCardFieldVisibility: { sku: false, rating: false }, dataCardSalesPeriod: "monthly" },
      ],
      pendingSets: 0,
    }, "retry after an atomic failure must send one fresh atomic write");

    await page.evaluate(() => {
      window.__setPanelStorageFixtureState({ dataCardFieldVisibility: {}, dataCardSalesPeriod: "monthly" });
      window.__setPanelStorageFixtureMode("deferred");
    });
    await page.locator('.ozon-helper-data-panel [data-action="open-field-settings"]').click();
    await settingsMask.waitFor();
    await settingsModal.locator('input[data-jz-field="rating"]').uncheck();
    const saveButton = settingsModal.locator('[data-jz-act="save"]');
    await saveButton.click();
    assert.equal(await saveButton.isDisabled(), true, "save is disabled while the atomic write is in flight");
    await page.evaluate(() => document.querySelector('[data-jz-act="save"]').click());
    assert.deepEqual(await page.evaluate(() => window.__getPanelStorageFixtureState()), {
      values: { dataCardFieldVisibility: {}, dataCardSalesPeriod: "monthly" },
      setCalls: 1,
      payloads: [{ dataCardFieldVisibility: { rating: false }, dataCardSalesPeriod: "monthly" }],
      pendingSets: 1,
    }, "a repeated save click must not start a second write");
    await settingsModal.locator('input[data-jz-field="rating"]').check();
    await page.evaluate(() => window.__resolveNextPanelStorageSet());
    await settingsMask.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.__getPanelStorageFixtureState()), {
      values: { dataCardFieldVisibility: { rating: false }, dataCardSalesPeriod: "monthly" },
      setCalls: 1,
      payloads: [{ dataCardFieldVisibility: { rating: false }, dataCardSalesPeriod: "monthly" }],
      pendingSets: 0,
    }, "the completed request must apply its captured intent without a stale second request overwriting it");

    for (const [width, expectedColumns] of [[880, 2], [600, 1]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('.ozon-helper-data-panel [data-action="open-field-settings"]').click();
      await settingsMask.waitFor();
      const columns = await settingsModal.locator(".jz-fieldset-body").evaluate((body) => getComputedStyle(body).gridTemplateColumns);
      assert.equal(gridColumnCount(columns), expectedColumns, `${width}px viewport should use ${expectedColumns} settings columns`);
      await settingsModal.getByRole("button", { name: "取消" }).click();
    }

    await page.locator('.ozon-helper-data-panel [data-action="toggle-section"]').first().click();
    assert.equal(
      await page.locator(".ozon-helper-sidebar-section").first().evaluate((section) => section.classList.contains("is-collapsed")),
      true,
      "section action should use the existing delegated toggle",
    );

    const logoFallback = await page.evaluate(() => {
      const panel = document.querySelector(".ozon-helper-data-panel");
      window.jzRenderProductPanelV2(panel, { sku: "123456789" });
      panel.querySelector(".ozon-helper-sidebar-brand-mark img").dispatchEvent(new Event("error"));
      const mark = panel.querySelector(".ozon-helper-sidebar-brand-mark");
      return {
        display: getComputedStyle(mark).display,
        title: panel.querySelector(".ozon-helper-sidebar-brand-title").textContent.trim(),
      };
    });
    assert.equal(logoFallback.display, "none");
    assert.equal(logoFallback.title, "ozon 粽子 · 选品助手");

    const legacyHeader = await page.evaluate(() => {
      const card = document.createElement("article");
      card.className = "ozon-helper-sidebar-card";
      card.innerHTML = `
        <div class="ozon-helper-sidebar-card-header">
          <span class="ozon-helper-sidebar-card-logo"><span class="oh-logo-icon"><svg viewBox="0 0 24 24"><path d="M13 2 3 14h9l-1 8 10-12h-9z" /></svg></span>ozon 粽子ERP</span>
          <div class="ozon-helper-sidebar-card-header-actions">
            <button class="ozon-helper-sidebar-card-close" data-action="close-sidebar-card">&times;</button>
          </div>
        </div>`;
      document.body.appendChild(card);
      const header = card.querySelector(".ozon-helper-sidebar-card-header");
      const logo = card.querySelector(".ozon-helper-sidebar-card-logo");
      const icon = card.querySelector(".oh-logo-icon");
      const close = card.querySelector(".ozon-helper-sidebar-card-close");
      return {
        headerBackground: getComputedStyle(header).backgroundColor,
        logoColor: getComputedStyle(logo).color,
        iconColor: getComputedStyle(icon).color,
        close: {
          action: close.dataset.action,
          background: getComputedStyle(close).backgroundColor,
          borderColor: getComputedStyle(close).borderTopColor,
          borderWidth: getComputedStyle(close).borderTopWidth,
          color: getComputedStyle(close).color,
        },
      };
    });
    assert.equal(legacyHeader.headerBackground, "rgb(255, 255, 255)");
    assert.equal(legacyHeader.logoColor, "rgb(16, 35, 74)");
    assert.equal(legacyHeader.iconColor, "rgb(18, 104, 255)");
    assert.deepEqual(legacyHeader.close, {
      action: "close-sidebar-card",
      background: "rgb(242, 247, 255)",
      borderColor: "rgb(212, 226, 250)",
      borderWidth: "1px",
      color: "rgb(18, 104, 255)",
    });
    await page.locator('.ozon-helper-sidebar-card-close[data-action="close-sidebar-card"]').hover();
    await page.waitForTimeout(200);
    assert.equal(
      await page.locator('.ozon-helper-sidebar-card-close[data-action="close-sidebar-card"]').evaluate((close) => getComputedStyle(close).backgroundColor),
      "rgb(229, 240, 255)",
      "legacy close affordance should remain visible on hover",
    );

    const skeletonStatus = await page.evaluate(() => {
      const panel = document.querySelector(".ozon-helper-data-panel");
      window.jzRenderPanelSkeleton(panel);
      return panel.querySelector(".ozon-helper-sidebar-brand-status").textContent.trim();
    });
    assert.equal(skeletonStatus, "正在加载商品数据");

    const narrowColumns = await page.evaluate(() => {
      const panel = document.querySelector(".ozon-helper-data-panel");
      window.__setPanelFixtureWidth(400);
      window.jzRenderProductPanelV2(panel, { sku: "123456789" });
      return getComputedStyle(panel.querySelector(".oh-hero-section")).gridTemplateColumns;
    });
    assert.equal(gridColumnCount(narrowColumns), 2);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    await closeQuietly("page", () => page?.close(), cleanupErrors);
    await closeQuietly("browser context", () => context?.close(), cleanupErrors);
    await closeQuietly("browser", () => browser?.close(), cleanupErrors);
    const serverClosed = await closeQuietly("fixture server", () => server ? closeServer(server) : undefined, cleanupErrors);
    if (serverClosed && server && onServerClosed) {
      onServerClosed();
    }
    if (cleanupErrors.length && !primaryError) {
      throw new AggregateError(cleanupErrors, "Browser fixture cleanup failed");
    }
  }
}

async function verifyForcedLaunchFailureCleanup() {
  let serverClosed = false;
  await assert.rejects(
    runBrowserFixture({
      onServerClosed: () => {
        serverClosed = true;
      },
    }),
    /forced browser launch failure/,
  );
  assert.equal(serverClosed, true, "fixture server should close after launch setup fails");
  process.stdout.write("forced launch cleanup complete\n");
}

if (cleanupChildMode) {
  void verifyForcedLaunchFailureCleanup().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
} else {
test("data panel browser fixture preserves production contracts and responsive visual hierarchy", async () => {
  await runBrowserFixture();
});

test("data panel browser fixture releases its server after browser launch fails", async () => {
  const result = await runCleanupChild();
  assert.equal(result.signal, null, result.output);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /forced launch cleanup complete/);
});
}

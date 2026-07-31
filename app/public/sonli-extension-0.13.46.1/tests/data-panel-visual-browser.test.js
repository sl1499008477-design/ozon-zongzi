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
  const extraPages = [];
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
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));

    await page.goto(`http://127.0.0.1:${address.port}${fixturePath}`);
    try {
      await page.waitForSelector('.ozon-helper-data-panel [data-field="sales30d"]');
    } catch (error) {
      throw new Error(`data panel fixture did not render\n${pageErrors.join("\n")}`, { cause: error });
    }
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
      const skuStatus = panel.querySelector(".oh-sku-status-card");
      const sizeSummary = panel.querySelector(".oh-size-summary");
      return {
        background: getComputedStyle(panel).backgroundColor,
        columns: getComputedStyle(hero).gridTemplateColumns,
        backgrounds: [...panel.querySelectorAll(".oh-hero-stat")].map((stat) => getComputedStyle(stat).backgroundColor),
        heroFields: [...hero.querySelectorAll("[data-field]")].map((field) => field.getAttribute("data-field")),
        skuStatus: skuStatus ? {
          field: skuStatus.querySelector("[data-field]")?.getAttribute("data-field") || "",
          text: skuStatus.textContent.trim(),
        } : null,
        sizeField: sizeSummary?.querySelector("[data-field]")?.getAttribute("data-field") || "",
        fields: [...panel.querySelectorAll("[data-field]")].map((field) => field.getAttribute("data-field")),
        missingCatalogFields: window.JZ_DATACARD_FIELDS
          .map(({ field }) => field)
          .filter((field) => !panel.querySelector(`[data-field="${field}"]`)),
        actions: [...panel.querySelectorAll("[data-action]")].map((action) => action.getAttribute("data-action")),
      };
    });
    assert.equal(wide.background, "rgb(255, 255, 255)");
    assert.equal(gridColumnCount(wide.columns), 3);
    assert.deepEqual(wide.backgrounds, Array(3).fill("rgb(242, 247, 255)"));
    assert.deepEqual(wide.heroFields, ["sales30d", "createDate", "heroFollow"]);
    assert.deepEqual(wide.skuStatus, { field: "skuStatus", text: "SKU 采集状态123456789" });
    assert.equal(wide.sizeField, "heroSize");
    assert.deepEqual(
      wide.missingCatalogFields,
      [],
      "V2 renderer must expose a data-field node for every real settings-catalog field",
    );
    for (const field of ["sales30d", "createDate", "heroFollow", "heroSize", "category", "sku", "returnRate", "rating", "dimensions", "volume", "weight"]) {
      assert.ok(wide.fields.includes(field), `missing rendered field ${field}`);
    }
    for (const action of ["open-field-settings", "follow-sell", "edit-list", "collect-one"]) {
      assert.ok(wide.actions.includes(action), `missing rendered action ${action}`);
    }

    const collectPage = await context.newPage();
    extraPages.push(collectPage);
    await collectPage.goto(
      `http://127.0.0.1:${address.port}${fixturePath}?collect=1`,
    );
    const collectPanel = collectPage.locator(".ozon-helper-data-panel");
    await collectPanel.waitFor();
    await collectPage.waitForFunction(() =>
      document.querySelector(".ozon-helper-data-panel")?.dataset.jzLoadStatus === "ready",
    );
    await collectPanel.locator('[data-action="collect-one"]').click();
    await collectPage.waitForFunction(() =>
      window.__getCollectFixtureMessages()
        .some((message) => message.action === "pushSourceCollect"),
    );
    const uploadedCapture = await collectPage.evaluate(() =>
      window.__getCollectFixtureMessages()
        .find((message) => message.action === "pushSourceCollect")?.payload?.raw,
    );
    assert.equal(
      uploadedCapture.variantData.description_category_id,
      17012345,
      "collect must reuse the category payload already loaded by the data panel when a second lookup misses",
    );
    assert.deepEqual(
      {
        descriptionCategoryId: uploadedCapture.description_category_id,
        typeId: uploadedCapture.type_id,
        weight: uploadedCapture.weight,
        depth: uploadedCapture.depth,
        width: uploadedCapture.width,
        height: uploadedCapture.height,
      },
      {
        descriptionCategoryId: 17012345,
        typeId: 910001,
        weight: 350,
        depth: 120,
        width: 80,
        height: 30,
      },
      "collect must persist category and package dimensions as explicit fields for Web draft hydration",
    );

    const incompleteCollectPage = await context.newPage();
    extraPages.push(incompleteCollectPage);
    await incompleteCollectPage.goto(
      `http://127.0.0.1:${address.port}${fixturePath}?collect=missing`,
    );
    const incompleteCollectPanel = incompleteCollectPage.locator(".ozon-helper-data-panel");
    await incompleteCollectPanel.waitFor();
    await incompleteCollectPage.waitForFunction(() =>
      document.querySelector(".ozon-helper-data-panel")?.dataset.jzLoadStatus === "ready",
    );
    const incompleteCollectButton = incompleteCollectPanel.locator('[data-action="collect-one"]');
    await incompleteCollectButton.click();
    await incompleteCollectPage.waitForFunction(() =>
      document.querySelector('[data-action="collect-one"]')?.textContent.includes("缺少：类目、重量、长、宽、高"),
    );
    assert.equal(
      await incompleteCollectPage.evaluate(() =>
        window.__getCollectFixtureMessages()
          .filter((message) => message.action === "pushSourceCollect").length,
      ),
      0,
      "collect must not report success or persist a partial record when category and logistics capture failed",
    );

    const sellerContextPage = await context.newPage();
    extraPages.push(sellerContextPage);
    await sellerContextPage.goto(
      `http://127.0.0.1:${address.port}${fixturePath}?collect=seller-auth`,
    );
    const sellerContextPanel = sellerContextPage.locator(".ozon-helper-data-panel");
    await sellerContextPanel.waitFor();
    await sellerContextPage.waitForFunction(() =>
      document.querySelector(".ozon-helper-data-panel")?.dataset.jzLoadStatus === "ready",
    );
    const sellerContextButton = sellerContextPanel.locator('[data-action="collect-one"]');
    await sellerContextButton.click();
    await sellerContextPage.waitForFunction(() =>
      document.querySelector('[data-action="collect-one"]')?.textContent.includes("Seller 未就绪"),
    );
    assert.match(
      await sellerContextButton.getAttribute("title"),
      /公司上下文尚未就绪/,
      "Seller context failure should preserve the safe diagnostic message",
    );
    assert.equal(
      await sellerContextPage.evaluate(() =>
        window.__getCollectFixtureMessages()
          .filter((message) => message.action === "pushSourceCollect").length,
      ),
      0,
      "Seller context failure must not upload a partial record",
    );

    const anonymousCollectPage = await context.newPage();
    extraPages.push(anonymousCollectPage);
    await anonymousCollectPage.goto(
      `http://127.0.0.1:${address.port}${fixturePath}?collect=auth-missing`,
    );
    const anonymousCollectPanel = anonymousCollectPage.locator(".ozon-helper-data-panel");
    await anonymousCollectPanel.waitFor();
    await anonymousCollectPage.waitForFunction(() =>
      document.querySelector(".ozon-helper-data-panel")?.dataset.jzLoadStatus === "ready",
    );
    assert.match(
      await anonymousCollectPanel.innerText(),
      /请先登录.*Web/,
      "an anonymous browser profile should see the Web login requirement before data collection starts",
    );
    assert.equal(
      await anonymousCollectPanel.locator('[data-action="datacard-login"]').count(),
      1,
      "the unauthenticated panel should expose one direct Web login action",
    );
    assert.deepEqual(
      await anonymousCollectPage.evaluate(() =>
        window.__getCollectFixtureMessages()
          .filter((message) => ["searchVariants", "pushSourceCollect"].includes(message.action))
          .map((message) => message.action),
      ),
      [],
      "Web auth must gate Seller reads and collection uploads",
    );

    await page.locator('.ozon-helper-data-panel [data-action="open-field-settings"]').click();
    const settingsMask = page.locator(".jz-fieldset-mask");
    const settingsModal = settingsMask.locator(".jz-fieldset-modal");
    await settingsMask.waitFor();
    assert.equal(await settingsModal.locator(".jz-fieldset-title").innerText(), "插件展示设置");
    assert.match(await settingsModal.locator(".jz-fieldset-note").innerText(), /选择商品详情页面板中需要展示的全部信息/);
    assert.deepEqual(
      await settingsModal.evaluate((modal) => {
        const labelledBy = modal.getAttribute("aria-labelledby");
        return {
          role: modal.getAttribute("role"),
          ariaModal: modal.getAttribute("aria-modal"),
          titleId: labelledBy,
          labelledText: labelledBy ? document.getElementById(labelledBy)?.textContent.trim() : "",
          focusInside: modal.contains(document.activeElement),
          activeClass: document.activeElement?.className || "",
        };
      }),
      {
        role: "dialog",
        ariaModal: "true",
        titleId: "jz-fieldset-title",
        labelledText: "插件展示设置",
        focusInside: true,
        activeClass: "jz-fieldset-close",
      },
      "opening settings should expose a labelled modal dialog and move focus inside it",
    );
    await settingsModal.locator('[data-jz-act="save"]').focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains("jz-fieldset-close")),
      true,
      "Tab from the last dialog control should wrap to the first control",
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-jz-act")),
      "save",
      "Shift+Tab from the first dialog control should wrap to the last control",
    );
    await page.keyboard.press("Escape");
    await settingsMask.waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-action")),
      "open-field-settings",
      "Escape should close settings and restore focus to the triggering gear",
    );
    await page.locator('.ozon-helper-data-panel [data-action="open-field-settings"]').click();
    await settingsMask.waitFor();

    const fieldCount = await settingsModal.locator('input[data-jz-field]').count();
    assert.equal(fieldCount, 32, "settings must preserve the real 32-field catalogue");
    assert.equal(await settingsModal.locator("[data-jz-visible-count]").innerText(), String(fieldCount));
    assert.equal(await settingsModal.locator(".jz-fieldset-summary > div:first-child > span").innerText(), `/ ${fieldCount} 项信息`);
    assert.equal(
      await settingsModal.locator(".jz-fieldset-summary-period").count(),
      1,
      "monthly/weekly period control should be compact and inline with the summary",
    );
    assert.equal(
      await settingsModal.locator(".jz-fieldset-body .jz-fieldset-period-group").count(),
      0,
      "period must not consume a standalone field-grid section",
    );
    for (const action of ["enable-all", "disable-all", "toggle-group", "restore-default", "save"]) {
      assert.ok(await settingsModal.locator(`[data-jz-act="${action}"]`).count() > 0, `missing ${action} settings action`);
    }

    const desktopSettings = await settingsModal.evaluate((modal) => ({
      modalWidth: getComputedStyle(modal).width,
      modalHeight: modal.getBoundingClientRect().height,
      columns: getComputedStyle(modal.querySelector(".jz-fieldset-body")).gridTemplateColumns,
      maskBackground: getComputedStyle(modal.parentElement).backgroundColor,
    }));
    assert.equal(desktopSettings.modalWidth, "960px");
    assert.ok(desktopSettings.modalHeight <= 740, `desktop modal must stay <=740px, got ${desktopSettings.modalHeight}`);
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
    await page.evaluate(() => {
      document.querySelector(".jz-fieldset-close")?.click();
      document.querySelector(".jz-fieldset-mask")?.click();
    });
    await page.keyboard.press("Escape");
    assert.equal(await settingsMask.count(), 1, "mask, close, and Escape must not dismiss settings while saving");
    await page.evaluate(() => window.__resolveNextPanelStorageSet("failure"));
    await settingsModal.locator("[data-jz-save-error]").waitFor();
    assert.equal(await settingsModal.locator("[data-jz-save-error]").innerText(), "fixture storage failed");
    assert.equal(await saveButton.isDisabled(), false, "a deferred failure should re-enable retry");
    assert.equal(
      await settingsModal.locator(".jz-fieldset-close").isDisabled(),
      false,
      "a deferred failure should restore dismissal controls",
    );
    assert.deepEqual(await page.evaluate(() => window.__getPanelStorageFixtureState()), {
      values: { dataCardFieldVisibility: {}, dataCardSalesPeriod: "monthly" },
      setCalls: 1,
      payloads: [{ dataCardFieldVisibility: { rating: false }, dataCardSalesPeriod: "monthly" }],
      pendingSets: 0,
    }, "a deferred storage failure must remain visible without applying partial state");
    await saveButton.click();
    assert.equal(await saveButton.isDisabled(), true, "retry should start one fresh deferred write");
    await page.evaluate(() => window.__resolveNextPanelStorageSet("success"));
    await settingsMask.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.__getPanelStorageFixtureState()), {
      values: { dataCardFieldVisibility: { rating: false }, dataCardSalesPeriod: "monthly" },
      setCalls: 2,
      payloads: [
        { dataCardFieldVisibility: { rating: false }, dataCardSalesPeriod: "monthly" },
        { dataCardFieldVisibility: { rating: false }, dataCardSalesPeriod: "monthly" },
      ],
      pendingSets: 0,
    }, "retry after a deferred failure must persist the original settings intent");

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

    const loadRealPdpHeader = async (allowed) => {
      const pdpPage = await context.newPage();
      extraPages.push(pdpPage);
      await pdpPage.goto(`http://127.0.0.1:${address.port}${fixturePath}`);
      await pdpPage.evaluate((gateAllowed) => {
        history.replaceState(null, "", "/product/browser-fixture-123456789");
        document.body.innerHTML = `
          <div data-state="state-paginator">{"detail_info":{"views":3456,"discount":17.25}}</div>
          <div data-state='{"isInCart":false,"toCart":{},"freeRest":23}'></div>
          <div data-widget="webStickyColumn"></div>
          <div data-widget="webStickyColumn"></div>
          <div data-widget="webStickyColumn"><div><div data-widget="webSale"></div></div></div>`;
        window.checkAuth = async () => ({ loggedIn: true });
        window.jzDataCardAllowed = async () => ({ allowed: gateAllowed });
        // Keep the production PDP card in its observable loading state. Data-source
        // terminal transitions are exercised separately through jzPopulatePanelV2.
        window.jzPopulatePanelV2 = () => new Promise(() => {});
      }, allowed);
      await pdpPage.addScriptTag({
        url: `http://127.0.0.1:${address.port}/extension/content/ozon-product.js`,
      });
      const card = pdpPage.locator(".ozon-helper-sidebar-card");
      await card.waitFor();
      return card.evaluate((renderedCard) => {
        const image = renderedCard.querySelector(".ozon-helper-sidebar-brand-mark img");
        const valueOf = (field) => renderedCard.querySelector(`[data-field="${field}"]`)?.textContent.trim() || "";
        return {
          html: renderedCard.innerHTML,
          image: image?.getAttribute("src") || "",
          title: renderedCard.querySelector(".ozon-helper-sidebar-brand-title")?.textContent.trim() || "",
          status: renderedCard.querySelector(".ozon-helper-sidebar-brand-status")?.textContent.trim() || "",
          gearAction: renderedCard.querySelector(".ozon-helper-sidebar-card-gear")?.dataset.action || "",
          closeAction: renderedCard.querySelector(".ozon-helper-sidebar-card-close")?.dataset.action || "",
          missingCatalogFields: window.JZ_DATACARD_FIELDS
            .map(({ field }) => field)
            .filter((field) => !renderedCard.querySelector(`[data-field="${field}"]`)),
          contractValues: {
            discount: valueOf("discount"),
            views: valueOf("views").replace(/\s/g, ""),
            stock: valueOf("stock"),
          },
        };
      });
    };

    const normalPdpHeader = await loadRealPdpHeader(true);
    assert.match(normalPdpHeader.image, /icons\/ozon-zongzi-symbol\.svg$/);
    assert.equal(normalPdpHeader.title, "ozon 粽子 · 选品助手");
    assert.equal(normalPdpHeader.status, "正在加载商品数据");
    assert.equal(normalPdpHeader.gearAction, "open-field-settings");
    assert.equal(normalPdpHeader.closeAction, "close-sidebar-card");
    assert.match(normalPdpHeader.html, /class="oh-sku-status-card"/);
    assert.match(normalPdpHeader.html, /class="oh-size-summary"/);
    assert.deepEqual(
      normalPdpHeader.missingCatalogFields,
      [],
      "PDP renderer must expose a data-field node for every real settings-catalog field",
    );
    assert.deepEqual(normalPdpHeader.contractValues, {
      discount: "17.25%",
      views: "3456",
      stock: "23",
    });
    assert.doesNotMatch(normalPdpHeader.html, /ozon 粽子ERP|data-lucide="zap"/);

    const lockedPdpHeader = await loadRealPdpHeader(false);
    assert.match(lockedPdpHeader.image, /icons\/ozon-zongzi-symbol\.svg$/);
    assert.equal(lockedPdpHeader.title, "ozon 粽子 · 选品助手");
    assert.equal(lockedPdpHeader.status, "会员功能");
    assert.equal(lockedPdpHeader.gearAction, "");
    assert.equal(lockedPdpHeader.closeAction, "close-sidebar-card");
    assert.doesNotMatch(lockedPdpHeader.html, /ozon 粽子ERP|data-lucide="zap"/);

    const startDeferredPopulation = async () => page.evaluate(() => {
      const panel = document.querySelector(".ozon-helper-data-panel");
      const deferred = {};
      const defer = (key) => new Promise((resolve, reject) => {
        deferred[key] = { resolve, reject };
      });
      window.sendMessage = (action) => defer(action);
      window.jzFetchPublicFollowSellCount = () => defer("followCount");
      window.jzRenderProductPanelV2(panel, { sku: "123456789" });
      window.__panelDataDeferred = deferred;
      window.__panelDataPopulation = window.jzPopulatePanelV2(panel, "123456789");
      const status = panel.querySelector(".ozon-helper-sidebar-brand-status");
      return { text: status.textContent.trim(), state: status.dataset.state || "" };
    });
    const finishDeferredPopulation = async (outcomes) => page.evaluate(async (nextOutcomes) => {
      for (const [key, outcome] of Object.entries(nextOutcomes)) {
        const pending = window.__panelDataDeferred[key];
        if (!pending) throw new Error(`missing deferred data source ${key}`);
        if (outcome.status === "rejected") pending.reject(new Error(outcome.message || `${key} failed`));
        else pending.resolve(outcome.value);
      }
      await window.__panelDataPopulation;
      const status = document.querySelector(
        ".ozon-helper-data-panel .ozon-helper-sidebar-brand-status",
      );
      return { text: status.textContent.trim(), state: status.dataset.state || "" };
    }, outcomes);
    const readV2ContractValues = async () => page.evaluate(() => {
      const panel = document.querySelector(".ozon-helper-data-panel");
      const valueOf = (field) => panel.querySelector(`[data-field="${field}"]`)?.textContent.trim() || "";
      return {
        discount: valueOf("discount"),
        views: valueOf("views").replace(/\s/g, ""),
        stock: valueOf("stock"),
        followMinPrice: valueOf("followMinPrice"),
        canFollow: valueOf("canFollow"),
      };
    });
    const fulfilledSources = {
      getProductStats: {
        status: "fulfilled",
        value: {
          sales30d: 12,
          marketDiscount: 17.25,
          marketViews: 3456,
          stock: 9,
          lowestPriceUsd: 8.5,
          canFollow: false,
        },
      },
      getMarketStats: { status: "fulfilled", value: { soldCount: 12 } },
      searchVariants: { status: "fulfilled", value: { items: [] } },
      followCount: { status: "fulfilled", value: { count: 0, sellers: [] } },
    };

    assert.deepEqual(
      await startDeferredPopulation(),
      { text: "正在加载商品数据", state: "loading" },
      "V2 must not announce success before any real data source settles",
    );
    assert.deepEqual(
      await finishDeferredPopulation(fulfilledSources),
      { text: "商品数据已更新", state: "ready" },
      "V2 should announce success only after all real data sources fulfill",
    );
    assert.deepEqual(await readV2ContractValues(), {
      discount: "17.25%",
      views: "3456",
      stock: "9",
      followMinPrice: "$8.50",
      canFollow: "不能",
    });

    assert.deepEqual(
      await startDeferredPopulation(),
      { text: "正在加载商品数据", state: "loading" },
    );
    assert.deepEqual(
      await finishDeferredPopulation({
        ...fulfilledSources,
        getProductStats: { status: "rejected", message: "stats unavailable" },
      }),
      { text: "部分商品数据加载失败", state: "partial" },
      "one rejected data source must produce an explicit partial terminal state",
    );

    assert.deepEqual(
      await startDeferredPopulation(),
      { text: "正在加载商品数据", state: "loading" },
    );
    assert.deepEqual(
      await finishDeferredPopulation(Object.fromEntries(
        Object.keys(fulfilledSources).map((key) => [
          key,
          { status: "rejected", message: `${key} unavailable` },
        ]),
      )),
      { text: "商品数据加载失败", state: "error" },
      "unknown all-source failure must never be presented as success",
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
    assert.equal(gridColumnCount(narrowColumns), 3);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const extraPage of extraPages) {
      await closeQuietly("extra browser page", () => extraPage?.close(), cleanupErrors);
    }
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

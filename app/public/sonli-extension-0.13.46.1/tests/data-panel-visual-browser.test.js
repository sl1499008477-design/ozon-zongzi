const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright-core");

const rootDir = path.resolve(__dirname, "..", "..");
const fixturePath = "/extension/tests/fixtures/data-panel-visual-browser.fixture.html";

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

test("data panel browser fixture preserves production contracts and responsive visual hierarchy", async () => {
  const server = await startFixtureServer();
  const address = server.address();
  const browser = await chromium.launch({
    executablePath: resolveBrowserPath(),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 720, height: 900 } });

  try {
    await page.goto(`http://127.0.0.1:${address.port}${fixturePath}`);
    await page.waitForSelector('.ozon-helper-data-panel [data-field="sales30d"]');
    await page.evaluate(() => window.__setPanelFixtureWidth(640));

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
    await page.waitForSelector(".jz-fieldset-mask");
    await page.locator(".jz-fieldset-mask").evaluate((mask) => mask.remove());

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
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { App as AntApp } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const appRoot = new URL("..", import.meta.url);
const vite = await createServer({
  root: fileURLToPath(appRoot),
  server: { middlewareMode: true },
});
test.after(async () => {
  await vite.close();
});
const appModule = await vite.ssrLoadModule("/src/App.jsx");
const { App } = appModule;
const collector = JSON.parse(await readFile(new URL("../src/collector-release.json", import.meta.url), "utf8"));
const { EXTENSION_DOWNLOAD_PATH, EXTENSION_VERSION } = await import("../src/extension-page-contract.mjs");

const storage = () => ({
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

const renderLogin = () => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.window = { location: { pathname: "/ozon/dashboard" } };
  globalThis.localStorage = storage();
  try {
    return renderToStaticMarkup(React.createElement(App));
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousLocalStorage;
  }
};

const renderAuthenticatedApp = (pathname = "/", localData) => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.window = { location: { pathname } };
  globalThis.localStorage = storage();
  if (localData) {
    globalThis.localStorage.getItem = (key) => key === "qh-local-binding-v1"
      ? JSON.stringify({ id: "store-qa", storeName: "QA 店铺" }) : null;
  }
  try {
    assert.equal(typeof appModule.AppShell, "function", "signed-in Web shell must be renderable for UI contract tests");
    return renderToStaticMarkup(React.createElement(
      AntApp,
      null,
      React.createElement(appModule.AppShell, {
        initialState: {
          account: { displayName: "Brand QA", role: "admin", username: "brand-qa" },
          authChecked: true,
          localData,
        },
      }),
    ));
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousLocalStorage;
  }
};

test("root, login and legacy home addresses resolve to product management", () => {
  for (const pathname of ["/", "/login", "/ozon/dashboard/"]) {
    const markup = renderAuthenticatedApp(pathname, { caches: { products: [] } });
    assert.match(markup, /data-menu-id="[^"]*\/ozon\/products\/list"[\s\S]*?<span class="ant-menu-title-content">商品管理<\/span>/, pathname);
    assert.doesNotMatch(markup, />商品列表</, pathname);
  }
});

test("retired operations and their old aliases resolve to the unavailable page", () => {
  for (const pathname of [
    "/ozon/postings/list", "/ozon/postings/returns", "/ozon/postings/profit-trend", "/datascreen",
    "/ozon/postings/review-request", "/ozon/postings/pickup-reminder",
    "/ozon/messaging/templates", "/ozon/messaging/history", "/extension",
    "/ozon/tools/pricing", "/ozon/tools/auto-listing", "/ozon/tools/category-strategy",
  ]) {
    assert.ok(renderAuthenticatedApp(pathname).includes('class="source-404-page"'), pathname);
  }
});

test("signed-in top bar opens software downloads", () => {
  const markup = renderAuthenticatedApp("/");
  const header = markup.match(/<header[\s\S]*?<\/header>/)?.[0] || "";
  assert.match(header, /<a[^>]+href="\/ozon\/downloads"[^>]*aria-label="软件下载"/);
  assert.doesNotMatch(header, /\sdownload(?:=|[\s>])/);
});

test("software downloads resolve with and without trailing slash without a bound store", () => {
  for (const pathname of ["/ozon/downloads", "/ozon/downloads/"]) {
    const markup = renderAuthenticatedApp(pathname);
    assert.match(markup, /<h2>软件下载<\/h2>/);
    assert.match(markup, /下载扩展 ZIP/);
    assert.match(markup, /ozon 粽子/);
    assert.match(markup, new RegExp(`浏览器扩展[\\s\\S]*v${EXTENSION_VERSION.replaceAll(".", "\\.")}`));
    assert.ok(markup.includes(`href="${EXTENSION_DOWNLOAD_PATH}"`));
    for (const artifact of collector.artifacts) {
      assert.ok(markup.includes(`href="${artifact.path}" download`), `${artifact.target} binary`);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    }
    for (const source of collector.sources) for (const file of source.files) {
      assert.ok(markup.includes(`href="${file.path}" download`), `${source.target} ${file.kind}`);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
    }
    assert.doesNotMatch(markup, /source-404-page/);
  }
});

test("shell account and home controls are reachable without a pointer", () => {
  const markup = renderAuthenticatedApp("/");
  const header = markup.match(/<header[\s\S]*?<\/header>/)?.[0] || "";
  assert.match(header, /<button[^>]*class="qh-user"[^>]*aria-label="账户菜单"/);
  assert.match(header, /<a[^>]*class="qh-brand"[^>]*href="\/ozon\/products\/list"/);
});

test("retained product templates render existing rows and their dates", () => {
  const createdAt = "2026-09-06T04:00:00.000Z";
  const markup = renderAuthenticatedApp("/ozon/templates", {
    caches: { productTemplates: [{ id: "template-qa", templateName: "商品模板回归", createdAt }] },
  });
  assert.match(markup, /商品模板回归/);
  assert.ok(markup.includes(new Date(createdAt).toLocaleString()));
});

test("HTML document starts with the approved product title", async () => {
  const html = await readFile(new URL("index.html", appRoot), "utf8");
  assert.match(html, /<title>ozon 粽子<\/title>/);
});

test("login page renders the approved wordmark asset and product name", () => {
  const markup = renderLogin();
  assert.match(markup, /<img[^>]+src="\/brand\/ozon-zongzi-logo-primary\.svg"[^>]+alt="ozon 粽子"/);
  assert.doesNotMatch(markup, /<strong>ozon 粽子<\/strong>/, "login wordmark must not repeat its own product name");
  assert.match(markup, /ozon 粽子 · v1\.0\.0/);
});


test("signed-in top bar renders one wordmark without a duplicate text label", () => {
  const markup = renderAuthenticatedApp();
  const topBarBrand = markup.match(/<a class="qh-brand"[^>]*>([\s\S]*?)<\/a>/)?.[1];
  assert.ok(topBarBrand, "signed-in top bar must render its brand link");
  assert.match(topBarBrand, /<img[^>]+src="\/brand\/ozon-zongzi-logo-primary\.svg"[^>]+alt="ozon 粽子"/);
  assert.doesNotMatch(topBarBrand, />ozon 粽子</, "top bar must not repeat the wordmark as adjacent text");
});

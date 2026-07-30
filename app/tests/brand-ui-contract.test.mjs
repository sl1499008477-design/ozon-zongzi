import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
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
const appModule = await vite.ssrLoadModule("/src/App.jsx");
const { App } = appModule;
const { default: DataScreenPage } = await vite.ssrLoadModule("/src/DataScreenPage.jsx");

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

const renderAuthenticatedApp = () => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.window = { location: { pathname: "/extension" } };
  globalThis.localStorage = storage();
  try {
    assert.equal(typeof appModule.AppShell, "function", "signed-in Web shell must be renderable for UI contract tests");
    return renderToStaticMarkup(React.createElement(
      AntApp,
      null,
      React.createElement(appModule.AppShell, {
        initialState: {
          account: { displayName: "Brand QA", role: "admin", username: "brand-qa" },
          authChecked: true,
          route: "/extension",
        },
      }),
    ));
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousLocalStorage;
  }
};

test("HTML title script assigns the approved brand title for application routes", async () => {
  const html = await readFile(new URL("index.html", appRoot), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "index document must include its route title script");

  for (const [pathname, expected] of [
    ["/ozon/dashboard", "ozon 粽子"],
    ["/datascreen", "ozon 粽子 · 订单数据大屏"],
  ]) {
    const document = { title: "" };
    vm.runInNewContext(script, { document, location: { pathname } });
    assert.equal(document.title, expected);
  }
});

test("login page renders the approved wordmark asset and product name", () => {
  const markup = renderLogin();
  assert.match(markup, /<img[^>]+src="\/brand\/ozon-zongzi-logo-primary\.svg"[^>]+alt="ozon 粽子"/);
  assert.doesNotMatch(markup, /<strong>ozon 粽子<\/strong>/, "login wordmark must not repeat its own product name");
  assert.match(markup, /Ozon 本地管理后台/);
});

test("data screen renders the approved wordmark asset and product name", () => {
  const markup = renderToStaticMarkup(React.createElement(DataScreenPage, {
    hasStore: false,
    localData: { summary: {}, caches: { postings: [] } },
    navigate: () => {},
  }));
  assert.match(markup, /<img[^>]+src="\/brand\/ozon-zongzi-logo-primary\.svg"[^>]+alt="ozon 粽子"/);
  assert.match(markup, /ozon 粽子 · 订单数据中心/);
});

test("signed-in top bar renders one wordmark without a duplicate text label", () => {
  const markup = renderAuthenticatedApp();
  const topBarBrand = markup.match(/<a class="qh-brand"[^>]*>([\s\S]*?)<\/a>/)?.[1];
  assert.ok(topBarBrand, "signed-in top bar must render its brand link");
  assert.match(topBarBrand, /<img[^>]+src="\/brand\/ozon-zongzi-logo-primary\.svg"[^>]+alt="ozon 粽子"/);
  assert.doesNotMatch(topBarBrand, />ozon 粽子</, "top bar must not repeat the wordmark as adjacent text");
});

test("signed-in plugin page renders the approved wordmark and product title", () => {
  const markup = renderAuthenticatedApp();
  const pluginHero = markup.match(/<div class="plugin-hero">([\s\S]*?)<\/div><div class="ant-alert/)?.[1];
  assert.ok(pluginHero, "signed-in plugin page must render its plugin hero");
  assert.match(pluginHero, /<img[^>]+src="\/brand\/ozon-zongzi-logo-primary\.svg"[^>]+alt="ozon 粽子"/);
  assert.match(pluginHero, /<h2>ozon 粽子 浏览器插件<\/h2>/);
});

test.after(async () => {
  await vite.close();
});

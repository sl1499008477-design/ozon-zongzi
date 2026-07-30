import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const appRoot = new URL("..", import.meta.url);
const vite = await createServer({
  root: fileURLToPath(appRoot),
  server: { middlewareMode: true },
});
const { App } = await vite.ssrLoadModule("/src/App.jsx");
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
  assert.match(markup, /<strong>ozon 粽子<\/strong>/);
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

test.after(async () => {
  await vite.close();
});

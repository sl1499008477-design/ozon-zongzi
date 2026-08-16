import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import React from "react";
import { App as AntApp, ConfigProvider } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const appRoot = new URL("..", import.meta.url);
const vite = await createServer({
  root: fileURLToPath(appRoot),
  server: {
    middlewareMode: true,
    hmr: { port: 30_000 + (process.pid % 10_000) },
  },
});
after(async () => {
  await vite.close();
});
const appModule = await vite.ssrLoadModule("/src/App.jsx");

test("collection list renders account-shared category states with fixed safe copy", () => {
  assert.equal(typeof appModule.CollectPage, "function");
  const resolutions = [
    {
      status: "ACTIVE", taxonomyScope: "OZON:DEFAULT",
      sourceDescriptionCategoryId: 10, sourceTypeId: 20,
      currentDescriptionCategoryId: 30, currentTypeId: 40,
      source: "SOURCE_DIRECT", version: 1, validatedAt: null,
      action: "NONE", message: "使用采集类目准备上架",
    },
    {
      status: "INVALIDATED", taxonomyScope: "OZON:DEFAULT",
      sourceDescriptionCategoryId: 10, sourceTypeId: 20,
      currentDescriptionCategoryId: 30, currentTypeId: 40,
      source: "OZON_REFRESH", version: 2, validatedAt: "2026-08-12T01:02:03.000Z",
      action: "WAIT", message: "Ozon 类目已失效，正在自动修复",
    },
    {
      status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT",
      sourceDescriptionCategoryId: null, sourceTypeId: null,
      currentDescriptionCategoryId: null, currentTypeId: null,
      source: null, version: null, validatedAt: null,
      action: "REVIEW", message: "无法确认商品类目，请人工选择",
    },
    { status: "UNKNOWN_VENDOR_STATE", raw: "untrusted backend copy must not render" },
  ];
  const markup = renderToStaticMarkup(
    React.createElement(
      ConfigProvider,
      null,
      React.createElement(
        AntApp,
        null,
        React.createElement(appModule.CollectPage, {
          hasStore: true,
          localData: {
            currentStoreId: "store-a",
            caches: {
              collectBox: resolutions.map((categoryResolution, index) => ({
                id: `collect-${index}`,
                name: `商品 ${index}`,
                categoryResolution,
              })),
            },
          },
          onBind: () => {},
          onRefresh: () => {},
          navigate: () => {},
        }),
      ),
    ),
  );

  for (const label of [
    "使用采集类目准备上架",
    "Ozon 类目已失效，正在自动修复",
    "无法确认商品类目，请人工选择",
    "商品类目状态暂时无法确认，请联系管理员",
  ]) {
    assert.match(markup, new RegExp(label));
  }
  assert.doesNotMatch(markup, /untrusted backend copy must not render|目标店铺类目/);
});

test("saved ACTIVE account-shared IDs flow into preview without store rematching", () => {
  const item = {
    id: "collect-matched",
    sku: "sku-matched",
    categoryResolution: {
      status: "ACTIVE",
      taxonomyScope: "OZON:DEFAULT",
      sourceDescriptionCategoryId: 17_028_702,
      sourceTypeId: 94_405,
      currentDescriptionCategoryId: 17_028_702,
      currentTypeId: 94_405,
      source: "SOURCE_DIRECT",
      version: 1,
      validatedAt: null,
      action: "NONE",
      message: "使用采集类目准备上架",
    },
  };
  const preview = appModule.collectEditPreviewPayload({
    item,
    sku: "sku-matched",
    title: "已匹配商品",
    price: "100",
    targetStoreId: "store-a",
  });

  assert.deepEqual(
    { descriptionCategoryId: preview.description_category_id, typeId: preview.type_id },
    { descriptionCategoryId: 17_028_702, typeId: 94_405 },
  );
});

test("a confirmed shared manual category replaces an unresolved summary independent of store", () => {
  const manual = {
    status: "ACTIVE",
    taxonomyScope: "OZON:DEFAULT",
    currentDescriptionCategoryId: 333,
    currentTypeId: 444,
    source: "MANUAL",
    sourceDescriptionCategoryId: 111,
    sourceTypeId: 222,
    version: 2,
    validatedAt: "2026-08-12T01:02:03.000Z",
    action: "NONE",
    message: "使用采集类目准备上架",
  };
  const selected = appModule.collectEditDraftVariantCategory({
    item: {
      id: "collect-review",
      categoryResolution: { status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT" },
    },
    itemId: "collect-review",
    row: { sku: "sku-matched" },
    targetStoreId: "store-b",
    fallbackResolution: manual,
    manualOverride: {
      itemId: "collect-review",
      targetStoreId: "store-a",
      taxonomyScope: "OZON:DEFAULT",
      resolution: manual,
    },
  });

  assert.equal(selected.categoryResolution.source, "MANUAL");
  assert.deepEqual(
    { descriptionCategoryId: selected.descriptionCategoryId, typeId: selected.typeId },
    { descriptionCategoryId: 333, typeId: 444 },
  );
});

test("editor exposes administrator confirmation only for review state", () => {
  assert.equal(typeof appModule.CollectEditPage, "function");
  const priorWindow = globalThis.window;
  const priorStorage = globalThis.localStorage;
  globalThis.window = { location: { search: "?id=collect-needs-review" } };
  globalThis.localStorage = { getItem: () => "" };
  try {
    const markup = renderToStaticMarkup(
        React.createElement(
          ConfigProvider,
          null,
          React.createElement(
            AntApp,
            null,
            React.createElement(appModule.CollectEditPage, {
              account: { id: "account-a", role: "admin" },
              binding: { id: "store-a" },
              hasStore: true,
              localData: {
                currentStoreId: "store-a",
                caches: {
                  collectBox: [{
                    id: "collect-needs-review",
                    sku: "sku-needs-review",
                    draftVersion: 7,
                    categoryResolution: { status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT" },
                  }],
                },
              },
              onBind: () => {},
              onRefresh: () => {},
              navigate: () => {},
            }),
          ),
        ),
      );
    assert.match(markup, /aria-label="管理员确认类目"/);
    assert.doesNotMatch(markup, /手动匹配类目|目标店铺类目/);
  } finally {
    globalThis.window = priorWindow;
    globalThis.localStorage = priorStorage;
  }
});

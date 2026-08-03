import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import React from "react";
import { App as AntApp, ConfigProvider } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { manualCategoryResolution } from "../src/category-readiness.js";

const appRoot = new URL("..", import.meta.url);
const vite = await createServer({
  root: fileURLToPath(appRoot),
  server: {
    middlewareMode: true,
    hmr: { port: 30_000 + (process.pid % 10_000) },
  },
});
const appModule = await vite.ssrLoadModule("/src/App.jsx");

after(async () => {
  await vite.close();
});

test("collection list renders the six saved category business states", () => {
  assert.equal(typeof appModule.CollectPage, "function");
  const statuses = [
    "MATCHING",
    "MATCHED",
    "WAITING_STORE",
    "WAITING_ENRICHMENT",
    "NEEDS_REVIEW",
    "RETRYABLE_ERROR",
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
              collectBox: statuses.map((status, index) => ({
                id: `collect-${index}`,
                name: `商品 ${index}`,
                categoryResolution: { status, taxonomyScope: "OZON:DEFAULT" },
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
    "类目匹配中",
    "类目已匹配",
    "等待选择经营店铺",
    "等待商品资料补全",
    "需要人工选择类目",
    "类目匹配暂时失败，系统将自动重试",
  ]) {
    assert.match(markup, new RegExp(label));
  }
  assert.doesNotMatch(markup, /采集失败/);
});

test("saved matched target IDs flow into the editor preview without opening-page rematching", () => {
  const item = {
    id: "collect-matched",
    sku: "sku-matched",
    categoryResolution: {
      status: "MATCHED",
      taxonomyScope: "OZON:DEFAULT",
      targetDescriptionCategoryId: 17_028_702,
      targetTypeId: 94_405,
      method: "AUTO",
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

test("review and invalidation retain the MANUAL resolution needed by the draft saver", () => {
  for (const status of ["NEEDS_REVIEW", "INVALIDATED"]) {
    const manual = manualCategoryResolution({
      source: { descriptionCategoryId: 17_033_604, typeIdCandidate: 94_405 },
      targetStoreId: "store-a",
      descriptionCategoryId: 17_028_702,
      typeId: 94_405,
      resolvedAt: "2026-08-03T12:00:00.000Z",
    });
    assert.equal(manual.status, "MATCHED", status);
    assert.equal(manual.method, "MANUAL", status);
    assert.deepEqual(manual.target, {
      storeId: "store-a",
      descriptionCategoryId: 17_028_702,
      typeId: 94_405,
    }, status);
  }
});

test("manual selection overrides an unresolved shared category summary while the draft is being saved", () => {
  const manual = manualCategoryResolution({
    source: { descriptionCategoryId: 17_033_604, typeIdCandidate: 94_405 },
    targetStoreId: "store-a",
    descriptionCategoryId: 17_028_702,
    typeId: 94_405,
    resolvedAt: "2026-08-03T12:00:00.000Z",
  });
  for (const status of ["NEEDS_REVIEW", "INVALIDATED"]) {
    const selected = appModule.collectEditDraftVariantCategory({
      item: {
        id: `collect-${status}`,
        categoryResolution: { status, taxonomyScope: "OZON:DEFAULT" },
      },
      itemId: `collect-${status}`,
      row: { sku: "sku-manual" },
      targetStoreId: "store-a",
      manualOverride: {
        itemId: `collect-${status}`,
        targetStoreId: "store-a",
        taxonomyScope: "OZON:DEFAULT",
        resolution: manual,
      },
    });

    assert.equal(selected.categoryResolution.method, "MANUAL", status);
    assert.deepEqual(
      { descriptionCategoryId: selected.descriptionCategoryId, typeId: selected.typeId },
      { descriptionCategoryId: 17_028_702, typeId: 94_405 },
      status,
    );
  }
});

test("a scoped session MANUAL choice replaces an older shared automatic match", () => {
  const manual = manualCategoryResolution({
    source: { descriptionCategoryId: 17_033_604, typeIdCandidate: 94_405 },
    targetStoreId: "store-a",
    descriptionCategoryId: 333,
    typeId: 444,
    resolvedAt: "2026-08-03T12:00:00.000Z",
  });
  const selected = appModule.collectEditDraftVariantCategory({
    item: {
      id: "collect-matched",
      categoryResolution: {
        status: "MATCHED",
        taxonomyScope: "OZON:DEFAULT",
        targetDescriptionCategoryId: 111,
        targetTypeId: 222,
        method: "AUTO",
      },
    },
    itemId: "collect-matched",
    row: { sku: "sku-matched" },
    targetStoreId: "store-a",
    fallbackResolution: manual,
    manualOverride: {
      itemId: "collect-matched",
      targetStoreId: "store-a",
      taxonomyScope: "OZON:DEFAULT",
      resolution: manual,
    },
  });

  assert.equal(selected.categoryResolution.method, "MANUAL");
  assert.deepEqual(
    { descriptionCategoryId: selected.descriptionCategoryId, typeId: selected.typeId },
    { descriptionCategoryId: 333, typeId: 444 },
  );
});

test("session MANUAL overrides are isolated by item, target store, and taxonomy scope", () => {
  assert.equal(typeof appModule.collectEditManualResolutionOverride, "function");
  const manual = manualCategoryResolution({
    targetStoreId: "store-a",
    descriptionCategoryId: 333,
    typeId: 444,
    resolvedAt: "2026-08-03T12:00:00.000Z",
  });
  const item = {
    id: "collect-a",
    categoryResolution: { status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT" },
  };
  const validOverride = {
    itemId: "collect-a",
    targetStoreId: "store-a",
    taxonomyScope: "OZON:DEFAULT",
    resolution: manual,
  };

  assert.equal(
    appModule.collectEditManualResolutionOverride({
      item,
      itemId: "collect-a",
      targetStoreId: "store-a",
      taxonomyScope: "OZON:DEFAULT",
      manualOverride: validOverride,
    }).method,
    "MANUAL",
  );
  for (const mismatch of [
    { itemId: "collect-b" },
    { targetStoreId: "store-b" },
    { taxonomyScope: "OZON:RU" },
  ]) {
    assert.equal(
      appModule.collectEditManualResolutionOverride({
        item,
        itemId: "collect-a",
        targetStoreId: "store-a",
        taxonomyScope: "OZON:DEFAULT",
        manualOverride: { ...validOverride, ...mismatch },
      }),
      null,
      JSON.stringify(mismatch),
    );
  }
});

test("the visible category action calls the existing interactive preview handler", () => {
  assert.equal(typeof appModule.collectEditCategoryPreviewAction, "function");
  const calls = [];
  appModule.collectEditCategoryPreviewAction((options) => calls.push(options))();
  assert.deepEqual(calls, [{ silent: false }]);
});

test("editor keeps the manual category preview button clickable for review, invalidation, and missing categories", () => {
  assert.equal(typeof appModule.CollectEditPage, "function");
  const priorWindow = globalThis.window;
  const priorStorage = globalThis.localStorage;
  globalThis.window = { location: { search: "?id=collect-needs-review" } };
  globalThis.localStorage = { getItem: () => "" };
  try {
    for (const categoryResolution of [
      { status: "NEEDS_REVIEW", taxonomyScope: "OZON:DEFAULT" },
      { status: "INVALIDATED", taxonomyScope: "OZON:DEFAULT" },
      null,
    ]) {
      const markup = renderToStaticMarkup(
        React.createElement(
          ConfigProvider,
          null,
          React.createElement(
            AntApp,
            null,
            React.createElement(appModule.CollectEditPage, {
              binding: { id: "store-a" },
              hasStore: true,
              localData: {
                currentStoreId: "store-a",
                caches: {
                  collectBox: [{
                    id: "collect-needs-review",
                    sku: "sku-needs-review",
                    ...(categoryResolution ? { categoryResolution } : {}),
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
      assert.match(markup, /aria-label="手动匹配类目"/);
      assert.doesNotMatch(
        markup,
        /<button[^>]*(?:disabled[^>]*aria-label="手动匹配类目"|aria-label="手动匹配类目"[^>]*disabled)[^>]*>/,
      );
    }
  } finally {
    globalThis.window = priorWindow;
    globalThis.localStorage = priorStorage;
  }
});

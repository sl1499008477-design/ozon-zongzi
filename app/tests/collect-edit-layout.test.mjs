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
  const selected = appModule.collectEditDraftVariantCategory({
    item: {
      categoryResolution: {
        status: "NEEDS_REVIEW",
        taxonomyScope: "OZON:DEFAULT",
      },
    },
    row: { sku: "sku-manual", categoryResolution: manual },
    targetStoreId: "store-a",
    fallbackResolution: manual,
  });

  assert.equal(selected.categoryResolution.method, "MANUAL");
  assert.deepEqual(
    { descriptionCategoryId: selected.descriptionCategoryId, typeId: selected.typeId },
    { descriptionCategoryId: 17_028_702, typeId: 94_405 },
  );
});

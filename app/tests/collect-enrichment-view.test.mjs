import assert from "node:assert/strict";
import test from "node:test";

import {
  collectEnrichmentEffectiveSummary,
  collectEnrichmentErrorSummary,
  collectEnrichmentListNeedsPolling,
  collectEditEnrichmentBackfill,
  collectEnrichmentNeedsPolling,
  collectEnrichmentRetryNotice,
  collectEnrichmentRetryOverride,
  collectEnrichmentRetryPath,
  collectEnrichmentSuccessMessage,
  collectEnrichmentView,
  collectEditSourceCategorySnapshot,
  collectEditSourceCategoryVariant,
  collectWorkflowStatus,
  runCollectEnrichmentRetry,
  startCollectEnrichmentPolling,
} from "../src/collect-enrichment-view.js";

test("Seller source category projection feeds preview without reusing target category roots", () => {
  const item = {
    listingDraft: {
      descriptionCategoryId: 880001,
      typeId: 990001,
      categoryResolution: { source: {} },
      sourceCategory: {
        descriptionCategoryId: 17039736,
        typeName: "Seller source",
        typeIdCandidate: 123456,
        path: ["Seller root", "Seller source"],
        attributes: [{ key: "8229", value: "Seller source", dictionary_value_id: 123456 }],
      },
    },
  };
  assert.deepEqual(collectEditSourceCategorySnapshot(item), item.listingDraft.sourceCategory);
  assert.deepEqual(collectEditSourceCategoryVariant(item), {
    description_category_id: 17039736,
    type_id: 123456,
    attributes: [{ key: "8229", value: "Seller source", dictionary_value_id: 123456 }],
  });
});

test("same-item COMPLETE polling fills only blank logistics fields and rejects stale scope generations", () => {
  const current = {
    packageWeight: "901",
    packageLength: "",
    packageWidth: "",
    packageHeight: "",
  };
  const completeItem = {
    id: "collect-edit-a",
    enrichment: { status: "COMPLETE" },
    listingDraft: {
      logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    },
  };
  assert.deepEqual(collectEditEnrichmentBackfill({
    current,
    item: completeItem,
    activeItemId: "collect-edit-a",
    generation: 4,
    latestGeneration: 4,
    dirtyFields: ["packageWeight"],
  }), {
    packageWeight: "901",
    packageLength: "300",
    packageWidth: "200",
    packageHeight: "100",
  });
  assert.equal(collectEditEnrichmentBackfill({
    current,
    item: completeItem,
    activeItemId: "collect-edit-b",
    generation: 4,
    latestGeneration: 4,
  }), current);
  assert.equal(collectEditEnrichmentBackfill({
    current,
    item: completeItem,
    activeItemId: "collect-edit-a",
    generation: 3,
    latestGeneration: 4,
  }), current);
});

test("pending enrichment maps to a blocked Chinese collection status", () => {
  assert.deepEqual(collectEnrichmentView({
    status: "PENDING_ENRICHMENT",
    missingFields: ["weightG"],
  }), {
    tone: "processing",
    label: "资料补全中",
    detail: "缺少：包装重量",
    retryable: false,
    listingBlocked: true,
  });
});

test("Seller wait, automatic retry, attention, and completion keep distinct actions", () => {
  assert.equal(collectEnrichmentView({ status: "WAITING_FOR_SELLER" }).label, "等待 Seller 登录");
  assert.equal(collectEnrichmentView({ status: "RETRYING" }).label, "正在自动重试");
  assert.equal(collectEnrichmentView({ status: "NEEDS_ATTENTION" }).retryable, true);
  assert.equal(collectEnrichmentView({ status: "COMPLETE" }).listingBlocked, false);
});

test("missing enrichment fields use stable Chinese names without exposing unknown keys", () => {
  assert.equal(collectEnrichmentView({
    status: "NEEDS_ATTENTION",
    missingFields: [
      "descriptionCategoryId",
      "weightG",
      "lengthMm",
      "widthMm",
      "heightMm",
      "internalSecretField",
    ],
  }).detail, "缺少：产品类目、包装重量、包装长度、包装宽度、包装高度、其他必填资料");
});

test("only active asynchronous enrichment states require five-second polling", () => {
  for (const status of ["PENDING_ENRICHMENT", "WAITING_FOR_SELLER", "RETRYING"]) {
    assert.equal(collectEnrichmentNeedsPolling({ status }), true, status);
  }
  for (const status of ["NEEDS_ATTENTION", "COMPLETE", "", "FAILED"]) {
    assert.equal(collectEnrichmentNeedsPolling({ status }), false, status || "empty");
  }
});

test("legacy items without enrichment summaries remain usable under the backend gate", () => {
  assert.deepEqual(collectEnrichmentView(), {
    tone: "default",
    label: "",
    detail: "",
    retryable: false,
    listingBlocked: false,
  });
});

test("polling is driven only by the summaries supplied from the visible collection", () => {
  assert.equal(collectEnrichmentListNeedsPolling([
    { enrichment: { status: "COMPLETE" } },
    { enrichment: { status: "WAITING_FOR_SELLER" } },
  ]), true);
  assert.equal(collectEnrichmentListNeedsPolling([
    { enrichment: { status: "COMPLETE" } },
    { enrichment: { status: "NEEDS_ATTENTION" } },
  ]), false);
});

test("partial collection success explains that enrichment continues in the background", () => {
  assert.equal(
    collectEnrichmentSuccessMessage({ status: "PENDING_ENRICHMENT" }),
    "已加入采集箱，资料正在后台补全",
  );
  assert.equal(collectEnrichmentSuccessMessage({ status: "COMPLETE" }), "已加入采集箱");
});

test("only the stable incomplete listing error is projected into an enrichment summary", () => {
  assert.deepEqual(collectEnrichmentErrorSummary({
    code: "COLLECT_ENRICHMENT_INCOMPLETE",
    body: { missingFields: ["weightG", "heightMm"] },
  }), {
    status: "PENDING_ENRICHMENT",
    missingFields: ["weightG", "heightMm"],
  });
  assert.equal(collectEnrichmentErrorSummary({
    code: "TARGET_STORE_REQUIRED",
    body: { missingFields: ["internalSecretField"] },
  }), null);
});

test("retry URL encodes only the collection item ID and carries no account scope", () => {
  assert.equal(
    collectEnrichmentRetryPath(" collect/a "),
    "/ozon/collect-box/collect%2Fa/enrichment/retry",
  );
  assert.throws(() => collectEnrichmentRetryPath(" "), /COLLECT_ITEM_REQUIRED/);
});

test("enrichment lifecycle states stay inside the legacy pending workflow filter", () => {
  for (const status of [
    "PENDING_ENRICHMENT",
    "WAITING_FOR_SELLER",
    "RETRYING",
    "NEEDS_ATTENTION",
    "COMPLETE",
  ]) {
    assert.equal(collectWorkflowStatus({ status }), "待处理", status);
  }
  assert.equal(collectWorkflowStatus({ status: "失败" }), "失败");
  assert.equal(collectWorkflowStatus({ status: "已上架" }), "已上架");
  assert.equal(collectWorkflowStatus({}), "待处理");
});

test("retry success stays optimistically polling until a refreshed server item replaces it", () => {
  const staleItem = {
    id: "collect-retry",
    enrichment: {
      status: "NEEDS_ATTENTION",
      missingFields: ["weightG"],
    },
  };
  const override = collectEnrichmentRetryOverride({
    item: staleItem,
    response: {
      data: {
        enrichment: {
          status: "RETRYING",
          missingFields: ["weightG", "heightMm"],
          internalSecretField: "must-not-project",
        },
      },
    },
  });

  assert.deepEqual(override.summary, {
    status: "RETRYING",
    missingFields: ["weightG", "heightMm"],
  });
  assert.equal(collectEnrichmentEffectiveSummary(staleItem, override), override.summary);
  assert.equal(collectEnrichmentNeedsPolling(override.summary), true);
  assert.deepEqual(collectEnrichmentRetryNotice(null), {
    type: "warning",
    content: "已重新提交，状态刷新暂时失败，页面将自动重试",
  });

  const refreshedItem = {
    ...staleItem,
    enrichment: { status: "COMPLETE", missingFields: [] },
  };
  assert.equal(
    collectEnrichmentEffectiveSummary(refreshedItem, override),
    refreshedItem.enrichment,
    "a new server item object must replace the optimistic retry projection",
  );
  assert.deepEqual(collectEnrichmentRetryNotice({ ok: true }), {
    type: "success",
    content: "已重新提交资料补全",
  });
});

test("list and edit retry handlers share one optimistic retry application flow", async () => {
  for (const surface of ["list", "edit"]) {
    const item = {
      id: `collect-${surface}`,
      enrichment: { status: "NEEDS_ATTENTION", missingFields: ["weightG"] },
    };
    const events = [];
    const result = await runCollectEnrichmentRetry({
      item,
      request: async (path, options) => {
        events.push(["request", path, options]);
        return { enrichment: { status: "RETRYING", missingFields: ["heightMm"] } };
      },
      applyOverride: (override) => { events.push(["override", override]); },
      refresh: async (options) => {
        events.push(["refresh", options]);
        return surface === "edit" ? { currentStoreId: "store-1" } : null;
      },
      refreshSource: `collect-${surface}-retry`,
    });

    assert.deepEqual(events[0], [
      "request",
      `/ozon/collect-box/collect-${surface}/enrichment/retry`,
      { method: "POST" },
    ]);
    assert.equal(events[1][0], "override", "optimistic RETRYING must apply before refresh");
    assert.deepEqual(events[1][1].summary, {
      status: "RETRYING",
      missingFields: ["heightMm"],
    });
    assert.deepEqual(events[2], ["refresh", { silent: true, source: `collect-${surface}-retry` }]);
    assert.deepEqual(result.notice, surface === "edit"
      ? { type: "success", content: "已重新提交资料补全" }
      : { type: "warning", content: "已重新提交，状态刷新暂时失败，页面将自动重试" });
  }
});

test("five-second polling prevents overlap, recovers after refresh failure, and stops cleanly", async () => {
  let tick = null;
  let intervalMs = 0;
  let clearedTimer = null;
  let refreshCalls = 0;
  let releaseFirstRefresh;
  const firstRefresh = new Promise((resolve) => { releaseFirstRefresh = resolve; });
  const stop = startCollectEnrichmentPolling({
    refresh: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) return firstRefresh;
      return null;
    },
    setIntervalFn(callback, delay) {
      tick = callback;
      intervalMs = delay;
      return "poll-timer";
    },
    clearIntervalFn(timer) {
      clearedTimer = timer;
    },
  });

  assert.equal(intervalMs, 5000);
  const activeTick = tick();
  await tick();
  assert.equal(refreshCalls, 1, "an in-flight refresh must suppress overlapping ticks");
  releaseFirstRefresh(null);
  await activeTick;
  await tick();
  assert.equal(refreshCalls, 2, "a swallowed/null refresh failure must remain recoverable");

  stop();
  await tick();
  assert.equal(refreshCalls, 2, "cleanup must prevent a stale scheduled callback from refreshing");
  assert.equal(clearedTimer, "poll-timer");
});

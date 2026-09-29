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
    label: "商品资料采集中",
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

test('enrichment failure details show a safe cause and retry schedule', () => {
  const view = collectEnrichmentView({status:'RETRYING',attemptCount:3,lastErrorCode:'ZONGZI_ENRICH_UPSTREAM_FAILED',nextAttemptAt:'2026-09-09T15:34:17.059Z'});
  assert.match(view.detail, /已尝试 3 次/);
  assert.match(view.detail, /下次重试/);
  assert.match(view.detail, /读取失败/);
  assert.match(collectEnrichmentView({status:'NEEDS_ATTENTION',lastErrorCode:'ZONGZI_ENRICH_INCOMPLETE'}).detail, /来源资料缺失/);
});

test('captured conflicting SKU shows both candidates without a misleading retry or missing-category prompt',()=>{
 const view=collectEnrichmentView({status:'NEEDS_ATTENTION',completedSkus:2,totalSkus:2,missingFields:['weightG','lengthMm','widthMm','heightMm'],missingSkus:['3025087772'],packagingConflicts:[{sku:'3025087772',candidates:[{weightG:105,lengthMm:140,widthMm:60,heightMm:50},{weightG:125,lengthMm:143,widthMm:63,heightMm:54}]}]});
 assert.equal(view.label,'已采集，包装参数待核实');assert.equal(view.retryable,false);
 assert.match(view.detail,/2\/2/);assert.match(view.detail,/105g/);assert.match(view.detail,/125g/);
 assert.doesNotMatch(view.detail,/缺少|待补全/);assert.equal(view.listingBlocked,true);
});

test('mixed SKU failures show every original cause even under a legacy pending summary',()=>{
 const summary={status:'PENDING_ENRICHMENT',executionState:'PENDING',hasActiveJobs:true,completedSkus:40,totalSkus:43,failures:[
  {sku:'2102713588',status:'FAILED',code:'ZONGZI_ENRICH_UPSTREAM_FAILED',message:'Seller /api/v1/search: net::ERR_CONNECTION_RESET',diagnostic:{stage:'seller_search',upstreamCode:'NETWORK_ERROR',requestSent:true,extensionVersion:'1.0.5'}},
  {sku:'2102713769',status:'FAILED',code:'ZONGZI_ENRICH_UPSTREAM_FAILED',message:'Seller response: Too Many Requests',diagnostic:{stage:'bundle_create',upstreamCode:'HTTP_429',upstreamStatus:429,requestSent:true}},
  {sku:'2102714396',status:'PENDING',code:'SELLER_CONTEXT_REQUIRED',message:'Seller tab is unavailable',diagnostic:{stage:'seller_context',requestSent:false}},
 ]};
 const before=structuredClone(summary);
 const view=collectEnrichmentView(summary);
 assert.equal(view.tone,'danger');
 assert.equal(view.label,'资料补全需处理');
 assert.equal(view.retryable,true);
 assert.match(view.detail,/40\/43/);
 assert.match(view.detail,/2102713588.*seller_search.*NETWORK_ERROR.*ERR_CONNECTION_RESET/);
 assert.match(view.detail,/2102713769.*bundle_create.*HTTP_429.*429.*Too Many Requests/);
 assert.match(view.detail,/2102714396.*seller_context.*未发送请求.*Seller tab is unavailable/);
 assert.doesNotMatch(view.detail,/HTTP 502/);
 assert.deepEqual(summary,before);
});

test('terminal failures with active siblings keep polling until the remaining jobs finish',()=>{
 assert.equal(collectEnrichmentNeedsPolling({status:'NEEDS_ATTENTION',executionState:'FAILED',hasActiveJobs:true}),true);
 assert.equal(collectEnrichmentListNeedsPolling([{enrichment:{status:'NEEDS_ATTENTION',hasActiveJobs:true}}]),true);
 assert.equal(collectEnrichmentNeedsPolling({status:'NEEDS_ATTENTION',hasActiveJobs:false}),false);
});

test('new recovery and legacy timed-out execution states say waiting without asserting failure',()=>{
 for(const executionState of ['WAITING_FOR_EXTENSION','TIMED_OUT']){
  const summary={status:'PENDING_ENRICHMENT',executionState,lastErrorCode:'ZONGZI_ENRICH_UPSTREAM_FAILED',attemptCount:5};
  const view=collectEnrichmentView(summary);
  assert.equal(view.label,'等待扩展恢复');
  assert.equal(view.tone,'warning');
  assert.equal(view.retryable,false);
  assert.equal(view.listingBlocked,true);
  assert.doesNotMatch(view.detail,/失败|超时|已尝试/);
  assert.equal(collectEnrichmentNeedsPolling(summary),true);
 }
});

test('a recovery wait cannot cover a different SKU with a known failure',()=>{
 const view=collectEnrichmentView({status:'PENDING_ENRICHMENT',executionState:'WAITING_FOR_EXTENSION',failures:[{sku:'2102713588',status:'FAILED',code:'NETWORK_ERROR',message:'net::ERR_CONNECTION_RESET',diagnostic:{stage:'seller_search',requestSent:true}}]});
 assert.equal(view.tone,'danger');
 assert.match(view.detail,/2102713588.*ERR_CONNECTION_RESET/);
});

test('older summaries retain raw messages and honestly identify missing diagnostics',()=>{
 const view=collectEnrichmentView({status:'NEEDS_ATTENTION',lastErrorCode:'NETWORK_ERROR',lastErrorMessage:'net::ERR_CONNECTION_RESET',lastErrorDiagnostic:{stage:'seller_search',requestSent:true}});
 assert.match(view.detail,/seller_search.*NETWORK_ERROR.*ERR_CONNECTION_RESET/);
 const legacy=collectEnrichmentView({status:'NEEDS_ATTENTION',failures:[{sku:'2102713769',status:'FAILED',code:'ZONGZI_ENRICH_NOT_FOUND',message:''}]});
 assert.match(legacy.detail,/2102713769.*阶段未记录.*来源未找到该 SKU/);
});

test('a complete category/package summary does not imply all media are present',()=>{
 const view=collectEnrichmentView({status:'COMPLETE',completedSkus:43,totalSkus:43,failures:[{sku:'old',status:'FAILED',message:'old failure'}]});
 assert.equal(view.label,'类目与包装已补全');
 assert.equal(view.tone,'success');
 assert.equal(view.listingBlocked,false);
 assert.match(view.detail,/43\/43/);
 assert.doesNotMatch(view.detail,/old failure|媒体齐全|全部资料|抓取成功/);
});

// Shape verified from the affected production SKU, without reclassifying normal legacy data.
test("failed link placeholder is a collection failure, not an unknown category", () => {
  const item = {id:"2965603212",sku:"2965603212",name:"SKU 2965603212",status:"待处理",
    raw:{sku:"2965603212",error:"scrape_failed"},listingDraft:{images:[],price:""}};
  const summary = collectEnrichmentEffectiveSummary(item);
  const view = collectEnrichmentView(summary);
  assert.equal(collectWorkflowStatus(item), "失败");
  assert.equal(view.label, "商品抓取失败");
  assert.equal(view.listingBlocked, true);
  assert.equal(view.retryable, false);
  assert.equal(collectEnrichmentNeedsPolling(summary), false);
  assert.match(view.detail, /采集助手/);
  const normal = {id:"old", listingDraft:{images:[]}};
  assert.equal(collectEnrichmentEffectiveSummary(normal), undefined);
  const repaired = {...item, listingDraft:{images:["https://cdn.example/product.jpg"]},enrichment:{status:"COMPLETE"}};
  assert.equal(collectEnrichmentView(collectEnrichmentEffectiveSummary(repaired)).listingBlocked, false);
});

test('historical local error prefixes keep recovery guidance without rewriting upstream evidence', () => {
  for (const [suffix, detail] of [
    ['SKU_SCRAPE_EMPTY', '上次链接抓取失败'],
    ['ENRICH_INCOMPLETE', '来源资料缺失'],
    ['ENRICH_RETRY_EXHAUSTED', '自动重试已用尽'],
  ]) for (const prefix of ['OZON', 'ZONGZI']) {
    const code = `${prefix}_${suffix}`;
    const summary = {status: 'NEEDS_ATTENTION', lastErrorCode: code, lastErrorDiagnostic: {upstreamCode: 'OZON_PLATFORM_ORIGINAL'}};
    const view = collectEnrichmentView(summary);
    assert.ok(view.detail.includes(detail));
    assert.ok(view.detail.includes(code));
    assert.ok(view.detail.includes('OZON_PLATFORM_ORIGINAL'));
    assert.equal(summary.lastErrorCode, code);
  }
});

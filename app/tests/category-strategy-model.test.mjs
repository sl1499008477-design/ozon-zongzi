import assert from "node:assert/strict";
import test from "node:test";

import {
  CATEGORY_STRATEGY_ROLES,
  categoryStrategyCountdown,
  categoryStrategyPageModel,
  clearStrategyResumeDraft,
  projectCategoryStrategyAnalysis,
  projectCategoryStrategyDetail,
  projectCategoryStrategyDetailBundle,
  projectCategoryStrategyList,
  projectCategoryStrategyPublishedVersion,
  projectCategoryStrategyVersionHistory,
  projectCategoryStrategySample,
  projectCategoryStrategySession,
  projectStrategyRequired,
  projectStrategyResumeDraft,
  readStrategyResumeDraft,
  writeStrategyResumeDraft,
} from "../src/category-strategy-model.js";
import {
  categoryStrategyErrorMessage,
  categoryStrategyRequestBody,
  createCategoryStrategyIntentStore,
  createCategoryStrategyClient,
  loadCategoryStrategyThumbnail,
} from "../src/category-strategy-client.js";

const SCOPE = Object.freeze({
  taxonomyScope: "OZON:DEFAULT",
  descriptionCategoryId: 17028922,
  typeId: 91542,
});

const GUIDANCE = Object.freeze({
  overallStyle: "干净的目录风格",
  prohibitedPatterns: Object.freeze(["不要复制竞品品牌标识"]),
  roles: Object.freeze(Object.fromEntries(CATEGORY_STRATEGY_ROLES.map((role) => [role, Object.freeze({
    composition: `${role} 构图`,
    background: `${role} 背景`,
    textDensity: role === "MAIN" ? "NONE" : "LIGHT",
    layout: `${role} 布局`,
  })]))),
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("closed UI projections cover list, detail, session, sample, analysis and published versions", () => {
  const summary = {
    draftId: "draft-a", scope: SCOPE, draftVersion: 2,
    status: "SAMPLES_READY", sampleCount: 6,
  };
  const detail = { ...summary, sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:7" };
  assert.deepEqual(projectCategoryStrategyList([summary]), [summary]);
  assert.deepEqual(projectCategoryStrategyDetail(detail), detail);

  const session = projectCategoryStrategySession({
    sessionId: "session-a", expiresAt: "2026-08-15T03:00:00.000Z",
    browserUrl: "https://www.ozon.ru/category/17028922/?zongziCategoryStrategySession=session-a",
    extensionMode: "CATEGORY_STRATEGY_SAMPLING", scope: SCOPE, duplicate: false,
  });
  assert.equal(session.sessionId, "session-a");
  assert.equal(Object.isFrozen(session), true);

  assert.deepEqual(projectCategoryStrategySample({
    sampleId: "sample-a", sku: "sku-a", title: "示例商品",
    thumbnailUrl: "/api/admin/auto-listing/category-strategies/draft-a/samples/sample-a/thumbnail",
    previewRole: "DETAIL", previewWidth: 1240, previewHeight: 1240,
    mainImageWidth: 50, mainImageHeight: 50,
    imageCount: 6, status: "READY", excludedReasons: [],
  }), {
    sampleId: "sample-a", sku: "sku-a", title: "示例商品",
    thumbnailUrl: "/api/admin/auto-listing/category-strategies/draft-a/samples/sample-a/thumbnail",
    previewRole: "DETAIL", previewWidth: 1240, previewHeight: 1240,
    mainImageWidth: 50, mainImageHeight: 50,
    imageCount: 6, status: "READY", excludedReasons: [],
  });

  const analysis = projectCategoryStrategyAnalysis({
    attemptId: "attempt-a", resultId: "result-a", status: "DRAFT_READY", draftVersion: 4,
    duplicate: false, safeCode: null, guidance: GUIDANCE,
    evidenceSummary: {
      roleEvidence: Object.fromEntries(CATEGORY_STRATEGY_ROLES.map((role) => [role,
        { evidenceIds: ["image-1", "image-2"], confidence: 0.82 }])),
      commonPatterns: [{ pattern: "主体居中", evidenceIds: ["image-1", "image-2"], confidence: 0.82 }],
      differences: [{ pattern: "单个样本使用道具", evidenceIds: ["image-3"] }],
      cautions: ["避免复制品牌标识"],
    },
    provenance: "AI", editedAt: null, baseAnalysisAttemptId: null,
  });
  assert.equal(analysis.guidance.roles.MAIN.textDensity, "NONE");
  assert.equal(analysis.evidenceSummary.commonPatterns[0].confidence, 0.82);
  const bundle = projectCategoryStrategyDetailBundle({ draft: detail, session,
    samples: Array.from({ length: 6 }, (_, index) => ({
      sampleId: `sample-${index}`, sku: `sku-${index}`, title: null,
      thumbnailUrl: `/api/admin/auto-listing/category-strategies/draft-a/samples/sample-${index}/images/image-${index}/thumbnail`,
      previewRole: "MAIN", previewWidth: 1200, previewHeight: 1600,
      mainImageWidth: 1200, mainImageHeight: 1600,
      imageCount: 1, status: "READY", excludedReasons: [],
    })), analysis, published: null, versions: [] });
  assert.equal(bundle.samples[0].title, null);
  assert.equal(bundle.analysis.provenance, "AI");

  assert.deepEqual(projectCategoryStrategyPublishedVersion({
    id: "strategy-v2", strategyKey: "default", version: 2,
    status: "PUBLISHED", duplicate: false,
  }), {
    id: "strategy-v2", strategyKey: "default", version: 2,
    status: "PUBLISHED", duplicate: false,
  });
  assert.deepEqual(projectCategoryStrategyVersionHistory([{ id: "strategy-v2", strategyKey: "default",
    version: 2, status: "PUBLISHED", content: { schemaVersion: "V2" }, rules: [] }]), [{
    id: "strategy-v2", strategyKey: "default", version: 2, status: "PUBLISHED",
  }]);
});

test("published drafts require a new draft while stale analysis never enables publish", () => {
  const detail = {
    draftId: "draft-a", scope: SCOPE, draftVersion: 8, status: "PUBLISHED", sampleCount: 6,
    sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:7",
  };
  const publishedView = categoryStrategyPageModel({ detail, analysis: null, published: {
    id: "strategy-v2", strategyKey: "default", version: 2, status: "PUBLISHED",
  } });
  assert.equal(publishedView.canCreateDraft, true);
  assert.equal(publishedView.canStartSampling, false);

  const staleView = categoryStrategyPageModel({ detail: { ...detail, status: "SAMPLES_READY" }, analysis: {
    attemptId: "attempt-old", resultId: "result-old", status: "DRAFT_READY", draftVersion: 7,
    duplicate: false, safeCode: null, guidance: GUIDANCE, evidenceSummary: null,
    provenance: "AI", editedAt: null, baseAnalysisAttemptId: null,
  }, published: null });
  assert.equal(staleView.canPublish, false);
  assert.equal(staleView.analysisIsCurrent, false);
});

test("strategy-required and resume projections preserve only the exact safe creation draft", () => {
  const required = projectStrategyRequired({
    ok: false,
    code: "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED",
    message: "raw server wording must be ignored",
    correlationId: "server-correlation-a",
    details: { scope: SCOPE, status: "NOT_CONFIGURED", canManage: true, draftId: "draft-a" },
  });
  assert.deepEqual(required, {
    scope: SCOPE, status: "NOT_CONFIGURED", canManage: true, draftId: "draft-a",
  });
  assert.equal(JSON.stringify(required).includes("raw server"), false);

  const resume = projectStrategyResumeDraft({
    schemaVersion: 1,
    createdAt: "2026-08-15T01:00:00.000Z",
    expiresAt: "2026-08-16T01:00:00.000Z",
    accountId: "account-a",
    source: "collect",
    collectIds: ["collect-a"],
    sourceVersions: [{ collectItemId: "collect-a", expectedSourceVersion: "draft:3" }],
    form: {
      targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 5,
      priceAdjustmentAmount: "0", ratio: "3:4", resolution: "1K", quality: "Medium",
      language: "ru",
      roles: { main: 1, sellingPoint: 3, detail: 1, scene: 1, specification: 1, infographic: 1 },
    },
    currency: "CNY",
    required,
    state: "CONFIGURING",
  });
  assert.equal(resume.form.roles.sellingPoint, 3);
  assert.equal(resume.currency, "CNY");
  assert.equal(Object.isFrozen(resume.form.roles), true);
});

test("resume drafts expire and fail closed when a current collect source version differs", () => {
  const storage = memoryStorage();
  const raw = {
    schemaVersion: 1,
    createdAt: "2026-08-15T01:00:00.000Z",
    expiresAt: "2026-08-16T01:00:00.000Z",
    accountId: "account-a", source: "collect", collectIds: ["collect-a"],
    sourceVersions: [{ collectItemId: "collect-a", expectedSourceVersion: "draft:3" }],
    form: {
      targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 5,
      priceAdjustmentAmount: "0", ratio: "3:4", resolution: "1K", quality: "Medium",
      language: "ru",
      roles: { main: 1, sellingPoint: 3, detail: 1, scene: 1, specification: 1, infographic: 1 },
    },
    currency: "CNY",
    required: { scope: SCOPE, status: "NOT_CONFIGURED", canManage: true, draftId: "draft-a" },
    state: "CONFIGURING",
  };
  writeStrategyResumeDraft(storage, raw);
  assert.equal(readStrategyResumeDraft(storage, "account-a", {
    now: "2026-08-15T02:00:00.000Z",
    sourceVersionOf: () => "draft:3",
  })?.collectIds[0], "collect-a");
  assert.equal(readStrategyResumeDraft(storage, "account-a", {
    now: "2026-08-15T02:00:00.000Z",
    sourceVersionOf: () => "draft:4",
  }), null);
  assert.equal(storage.getItem("zongzi:auto-listing:category-strategy-resume:v1:account-a"), null);

  writeStrategyResumeDraft(storage, raw);
  assert.equal(readStrategyResumeDraft(storage, "account-a", {
    now: "2026-08-16T01:00:00.000Z",
    sourceVersionOf: () => "draft:3",
  }), null);
});

test("clearing a resume draft reports whether browser storage was actually cleared", () => {
  const storage = memoryStorage();
  storage.setItem("zongzi:auto-listing:category-strategy-resume:v1:account-a", "stored-resume");
  assert.equal(clearStrategyResumeDraft(storage, "account-a"), true);
  assert.equal(storage.getItem("zongzi:auto-listing:category-strategy-resume:v1:account-a"), null);
  assert.equal(clearStrategyResumeDraft({
    getItem: () => "stored-resume",
    removeItem: () => { throw new DOMException("storage blocked", "SecurityError"); },
  }, "account-a"), false);
  assert.equal(clearStrategyResumeDraft({ removeItem: () => {} }, "account-a"), false);
});

test("logical write intents survive response loss and settle only after a confirmed response", async () => {
  const storage = memoryStorage();
  const storeA = createCategoryStrategyIntentStore({ storage, accountId: "account-a",
    now: () => Date.parse("2026-08-15T01:00:00.000Z") });
  const first = await storeA.identity("analysis", { draftId: "draft-a", sampleCount: 6 });
  const retry = await storeA.identity("analysis", { draftId: "draft-a", sampleCount: 6 });
  assert.deepEqual(retry, first);

  const afterReload = createCategoryStrategyIntentStore({ storage, accountId: "account-a",
    now: () => Date.parse("2026-08-15T01:01:00.000Z") });
  assert.deepEqual(await afterReload.identity("analysis", { draftId: "draft-a", sampleCount: 6 }), first);
  await afterReload.settle("analysis", { draftId: "draft-a", sampleCount: 6 });
  assert.notDeepEqual(await afterReload.identity("analysis", { draftId: "draft-a", sampleCount: 6 }), first);
});

test("protected thumbnails attach bearer auth and reject oversized or non-WebP bytes", async () => {
  const calls = [];
  const blob = await loadCategoryStrategyThumbnail(
    "/api/admin/auto-listing/category-strategies/draft-a/samples/sample-a/images/image-a/thumbnail",
    {
      token: "local-token",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }), {
          status: 200, headers: { "Content-Type": "image/webp", "Content-Length": "3" },
        });
      },
    },
  );
  assert.equal(blob.type, "image/webp");
  assert.equal(calls[0].options.headers.Authorization, "Bearer local-token");
  await assert.rejects(() => loadCategoryStrategyThumbnail(
    "/api/admin/auto-listing/category-strategies/draft-a/samples/sample-a/images/image-a/thumbnail",
    { token: "local-token", fetchImpl: async () => new Response("not an image", {
      status: 200, headers: { "Content-Type": "text/plain" },
    }) },
  ), { code: "CATEGORY_STRATEGY_THUMBNAIL_INVALID" });
});

test("hostile, open and sensitive carriers never enter the UI models", () => {
  let getterReads = 0;
  const accessor = {
    draftId: "draft-a", scope: SCOPE, draftVersion: 1, status: "COLLECTING", sampleCount: 0,
  };
  Object.defineProperty(accessor, "draftId", {
    enumerable: true,
    get() { getterReads += 1; return "draft-a"; },
  });
  assert.throws(() => projectCategoryStrategyDetail(accessor), {
    code: "CATEGORY_STRATEGY_UI_DATA_INVALID",
  });
  assert.equal(getterReads, 0);

  assert.throws(() => projectCategoryStrategyDetail({
    draftId: "draft-a", scope: SCOPE, draftVersion: 1, status: "COLLECTING", sampleCount: 0,
    accountId: "account-secret",
  }), { code: "CATEGORY_STRATEGY_UI_DATA_INVALID" });
  assert.throws(() => projectCategoryStrategySample({
    sampleId: "sample-a", sku: "sku-a", title: "商品", imageCount: 1, status: "READY",
    thumbnailUrl: "https://cdn.ozon.ru/raw.jpg?token=secret", excludedReasons: [],
  }), { code: "CATEGORY_STRATEGY_UI_DATA_INVALID" });
  assert.throws(() => projectCategoryStrategyAnalysis({
    attemptId: "attempt-a", resultId: "result-a", status: "DRAFT_READY", draftVersion: 4,
    duplicate: false, safeCode: null, guidance: GUIDANCE, evidenceSummary: null,
    provenance: "AI", editedAt: null, baseAnalysisAttemptId: null, rawVendorResponse: "secret",
  }), { code: "CATEGORY_STRATEGY_UI_DATA_INVALID" });

  const proxy = new Proxy({}, { ownKeys() { throw new Error("trap"); } });
  assert.throws(() => projectCategoryStrategyDetail(proxy), {
    code: "CATEGORY_STRATEGY_UI_DATA_INVALID",
  });
});

test("page state applies the 5-20 gate, session countdown and same-account impact wording", () => {
  const model = categoryStrategyPageModel({
    detail: { draftId: "draft-a", scope: SCOPE, draftVersion: 2, status: "SAMPLES_READY", sampleCount: 6,
      sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:7" },
    session: null,
    analysis: null,
    published: null,
    now: "2026-08-15T01:00:00.000Z",
  });
  assert.equal(model.canAnalyze, true);
  assert.equal(model.canStartSampling, true);
  assert.equal(model.impactText, "发布后供当前账号内命中此精确类目的商品共用，不影响其他账号。");
  assert.deepEqual(categoryStrategyCountdown({
    expiresAt: "2026-08-15T01:01:05.000Z", now: "2026-08-15T01:00:00.000Z",
  }), { expired: false, seconds: 65, label: "01:05" });
  assert.equal(categoryStrategyPageModel({
    detail: { ...model.detail, sampleCount: 4 }, session: null, analysis: null, published: null,
    now: "2026-08-15T01:00:00.000Z",
  }).canAnalyze, false);
});

test("client messages and write bodies are fixed, closed and versioned", () => {
  for (const [error, expected] of [
    [{ status: 403, code: "PERMISSION_FORBIDDEN", message: "raw" }, "没有类目策略管理权限，请联系账号管理员。"],
    [{ status: 404, code: "AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", message: "raw" }, "类目策略记录不存在或你无权查看。"],
    [{ status: 404, code: "AUTO_LISTING_CATEGORY_STRATEGY_SOURCE_NOT_FOUND", message: "raw" }, "商品类目信息已变化，请返回自动上架页刷新后重试。"],
    [{ status: 409, code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY", message: "raw" }, "浏览器扩展尚未连接，请先安装或刷新扩展后重试。"],
    [{ status: 409, code: "AUTO_LISTING_SOURCE_VERSION_CONFLICT", message: "raw" }, "来源资料已变化，请返回自动上架页刷新后重试。"],
    [{ status: 409, code: "AUTO_LISTING_CATEGORY_STRATEGY_VERSION_CONFLICT", message: "raw" }, "类目策略已被其他管理员更新，请刷新后再操作。"],
    [{ status: 409, code: "AUTO_LISTING_CATEGORY_STRATEGY_PUBLISHED_VERSION_CONFLICT", message: "raw" }, "类目策略已被其他管理员更新，请刷新后再操作。"],
    [{ status: 429, code: "TOO_MANY_REQUESTS", message: "raw" }, "操作过于频繁，请稍后再试。"],
    [{ status: 503, code: "AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_NOT_READY", message: "vendor raw" }, "AI 分析服务暂时不可用，未产生新的付费调用。"],
    [{ status: 503, code: "AUTO_LISTING_CATEGORY_STRATEGY_AI_RESPONSE_UNKNOWN", message: "vendor raw" }, "AI 返回状态暂时无法确认，系统会保留本次分析并使用同一次请求恢复，请勿重新发起以免重复付费。"],
  ]) assert.equal(categoryStrategyErrorMessage(error), expected);

  assert.deepEqual(categoryStrategyRequestBody("analysis", {
    costConfirmed: true, idempotencyKey: "analysis-a", correlationId: "correlation-a",
  }), {
    costConfirmed: true, idempotencyKey: "analysis-a", correlationId: "correlation-a",
  });
  assert.throws(() => categoryStrategyRequestBody("analysis", {
    costConfirmed: true, idempotencyKey: "analysis-a", correlationId: "correlation-a", accountId: "account-b",
  }), { code: "CATEGORY_STRATEGY_CLIENT_REQUEST_INVALID" });
});

test("create client accepts the closed five-field created-draft response before detail reload", async () => {
  const calls = [];
  const client = createCategoryStrategyClient({ request: async (path, options) => {
    calls.push({ path, options });
    return { ok: true, data: { draftId: "draft-new", scope: SCOPE, draftVersion: 1,
      status: "COLLECTING", duplicate: false } };
  } });
  assert.deepEqual(await client.createDraft({ scope: SCOPE, sourceCollectItemId: "collect-a",
    expectedSourceVersion: "draft:7", idempotencyKey: "create-a", correlationId: "correlation-a" }), {
    draftId: "draft-new", scope: SCOPE, draftVersion: 1, status: "COLLECTING", duplicate: false,
  });
  assert.equal(calls[0].path, "/admin/auto-listing/category-strategies/drafts");
});

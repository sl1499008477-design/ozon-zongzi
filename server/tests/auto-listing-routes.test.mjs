import assert from "node:assert/strict";
import test from "node:test";
import { PERMISSIONS, hasPermission } from "../permissions.mjs";
import { autoListingEnabled } from "../runtime-config.mjs";
import { createAutoListingRuntime } from "../auto-listing-runtime.mjs";
import { createAutoListingHttpHandler } from "../auto-listing-routes.mjs";

function request({ method = "GET", path = "/auto-listing/jobs", body } = {}) {
  return { method, body, headers: {} , url: path };
}

function harness({ enabled = true, authenticate, runtime, readJson } = {}) {
  const replies = [];
  const handler = createAutoListingHttpHandler({
    isEnabled: () => enabled,
    authenticate: authenticate || (async () => ({ id: "account_a", role: "user" })),
    runtime: runtime || { getService: async () => ({}) },
    readJson: readJson || (async (req) => req.body),
    sendJson: (_res, status, payload) => replies.push({ status, payload }),
  });
  return { handler, replies };
}

const createBody = Object.freeze({
  collectItemIds: ["collect_1"],
  idempotencyKey: "idem_1",
  correlationId: "corr_1",
  config: { targetStoreId: "store_1", targetWarehouseId: "warehouse_1" },
});

test("auto-listing feature flag is opt-in only", () => {
  assert.equal(autoListingEnabled({}), false);
  assert.equal(autoListingEnabled({ AUTO_LISTING_ENABLED: "0" }), false);
  assert.equal(autoListingEnabled({ AUTO_LISTING_ENABLED: " true " }), true);
  assert.equal(autoListingEnabled({ AUTO_LISTING_ENABLED: "1" }), true);
  assert.equal(autoListingEnabled({ AUTO_LISTING_ENABLED: "yes" }), false);
});

test("AI content management permission is admin-only", () => {
  assert.equal(PERMISSIONS.AI_CONTENT_MANAGE, "ai-content.manage");
  assert.equal(hasPermission({ id: "admin", role: "admin" }, PERMISSIONS.AI_CONTENT_MANAGE), true);
  assert.equal(hasPermission({ id: "user", role: "user" }, PERMISSIONS.AI_CONTENT_MANAGE), false);
});

test("matching unauthenticated requests return 401 before feature state", async () => {
  let initialized = 0;
  const { handler, replies } = harness({
    enabled: false,
    authenticate: async () => { throw Object.assign(new Error("unauthenticated"), { status: 401, code: "AUTH_REQUIRED" }); },
    runtime: { getService: async () => { initialized += 1; } },
  });
  assert.equal(await handler(request(), {}, new URL("http://local/auto-listing/jobs")), true);
  assert.equal(replies[0].status, 401);
  assert.equal(replies[0].payload.code, "AUTO_LISTING_UNAUTHENTICATED");
  assert.equal(initialized, 0);
});

test("disabled feature rejects authenticated calls without initializing runtime", async () => {
  let initialized = 0;
  const { handler, replies } = harness({
    enabled: false,
    runtime: { getService: async () => { initialized += 1; throw new Error("must not run"); } },
  });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.deepEqual(replies[0], {
    status: 503,
    payload: { ok: false, code: "AUTO_LISTING_DISABLED", message: "自动上架功能暂未启用", correlationId: "" },
  });
  assert.equal(initialized, 0);
});

test("matching unsupported methods remain 405 after authentication even while disabled", async () => {
  const { handler, replies } = harness({ enabled: false });
  await handler(request({ method: "DELETE" }), {}, new URL("http://local/auto-listing/jobs"));
  assert.deepEqual(replies[0], {
    status: 405,
    payload: { ok: false, code: "AUTO_LISTING_METHOD_NOT_ALLOWED", message: "不支持的自动上架请求方法", correlationId: "" },
  });
});

test("exact route methods reject GET creation and POST detail paths", async () => {
  const service = {
    getAutoListingJob: async () => { throw new Error("must not call"); },
    createAutoListingJob: async () => { throw new Error("must not call"); },
  };
  const { handler, replies } = harness({ runtime: { getService: async () => service } });
  await handler(request({ path: "/auto-listing/jobs/from-collect-box" }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  await handler(request({ method: "POST", path: "/auto-listing/jobs/job_1", body: createBody }), {}, new URL("http://local/auto-listing/jobs/job_1"));
  assert.deepEqual(replies.map(({ status, payload }) => [status, payload.code]), [
    [405, "AUTO_LISTING_METHOD_NOT_ALLOWED"],
    [405, "AUTO_LISTING_METHOD_NOT_ALLOWED"],
  ]);
});

test("disabled POST short-circuits before any body read or parse", async () => {
  let reads = 0;
  let initialized = 0;
  const { handler, replies } = harness({
    enabled: false,
    readJson: async () => { reads += 1; throw new Error("malformed or oversized body"); },
    runtime: { getService: async () => { initialized += 1; return {}; } },
  });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box" }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.deepEqual(replies[0], {
    status: 503,
    payload: { ok: false, code: "AUTO_LISTING_DISABLED", message: "自动上架功能暂未启用", correlationId: "" },
  });
  assert.equal(reads, 0);
  assert.equal(initialized, 0);
});

test("routes inject only authenticated actor and reject client scope or sensitive fields", async () => {
  const received = [];
  const service = { createAutoListingJob: async (input) => { received.push(input); return { id: "job_1", accountId: "leak", rawResponse: { secret: "x" }, items: [] }; } };
  const { handler, replies } = harness({ runtime: { getService: async () => service } });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.equal(received[0].actor.id, "account_a");
  assert.equal(Object.hasOwn(received[0], "accountId"), false);
  assert.deepEqual(replies[0].payload.data, { jobId: "job_1", sourceType: "COLLECT_BOX", status: "CREATED", items: [] });

  for (const badBody of [
    { ...createBody, accountId: "account_b" },
    { ...createBody, actor: { id: "account_b" } },
    { ...createBody, config: { ...createBody.config, credentials: "x" } },
  ]) {
    const local = harness({ runtime: { getService: async () => service } });
    await local.handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: badBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
    assert.equal(local.replies[0].status, 400);
    assert.equal(local.replies[0].payload.code, "AUTO_LISTING_REQUEST_INVALID");
  }
});

test("create route returns a safe 201 DTO for blocked source siblings", async () => {
  const service = {
    createAutoListingJob: async () => ({
      id: "job_1",
      sourceType: "COLLECT_BOX",
      status: "CREATED",
      items: [{
        id: "item_1",
        status: "BLOCKED",
        sourceRecordId: "collect_1",
        sourceVersion: "7",
        sourceHash: "a".repeat(64),
        failureCode: "AUTO_LISTING_SOURCE_SKU_REQUIRED",
        blockedEvidence: { rawPayload: { credential: "never" } },
        rawResponseRef: "raw-secret",
      }],
    }),
  };
  const { handler, replies } = harness({ runtime: { getService: async () => service } });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.deepEqual(replies[0], {
    status: 201,
    payload: {
      ok: true,
      correlationId: "corr_1",
      data: {
        jobId: "job_1", sourceType: "COLLECT_BOX", status: "CREATED",
        items: [{
          itemId: "item_1", status: "BLOCKED", sourceRecordId: "collect_1", sourceVersion: "7",
          sourceHash: "a".repeat(64), failureCode: "AUTO_LISTING_SOURCE_SKU_REQUIRED",
        }],
      },
    },
  });
});

test("create route preserves a native CNY price without exposing internal evidence", async () => {
  const service = { createAutoListingJob: async () => ({
    id: "job_cny", status: "CREATED", items: [{
      id: "item_cny", status: "SOURCE_READY",
      price: {
        currency: "CNY", branch: "BLACK_GTE_80", blackKopecks: "10000",
        greenKopecks: "8000", realPriceKopecks: "14500",
        adjustmentKopecks: "0", preMultiplierPriceKopecks: "14500",
        priceMultiplierMicros: "1250000", finalPriceKopecks: "18125",
        sourceEvidence: { secret: "never" },
      },
    }],
  }) };
  const { handler, replies } = harness({ runtime: { getService: async () => service } });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.deepEqual(replies[0].payload.data.items[0].price, {
    currency: "CNY", branch: "BLACK_GTE_80", blackKopecks: "10000",
    greenKopecks: "8000", realPriceKopecks: "14500",
    adjustmentKopecks: "0", preMultiplierPriceKopecks: "14500",
    priceMultiplierMicros: "1250000", finalPriceKopecks: "18125",
  });
  assert.doesNotMatch(JSON.stringify(replies[0]), /sourceEvidence|secret/);
});

test("invalid create payloads never initialize the runtime", async () => {
  let initialized = 0;
  const { handler, replies } = harness({
    runtime: { getService: async () => { initialized += 1; return {}; } },
  });
  await handler(request({
    method: "POST",
    path: "/auto-listing/jobs/from-collect-box",
    body: { ...createBody, accountId: "account_b" },
  }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.equal(replies[0].status, 400);
  assert.equal(initialized, 0);

  await handler(request({ path: "/auto-listing/jobs/%" }), {}, new URL("http://local/auto-listing/jobs/%"));
  assert.equal(replies[1].status, 400);
  assert.equal(initialized, 0);
});

test("route rejects a forged product-dimension reliability claim before service initialization", async () => {
  let initialized = 0;
  const { handler, replies } = harness({
    runtime: { getService: async () => { initialized += 1; return {}; } },
  });
  await handler(request({
    method: "POST",
    path: "/auto-listing/jobs/from-collect-box",
    body: { ...createBody, config: { ...createBody.config, hasReliableProductDimensions: true } },
  }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.equal(replies[0].status, 400);
  assert.equal(replies[0].payload.code, "AUTO_LISTING_REQUEST_INVALID");
  assert.equal(initialized, 0);
});

test("malformed JSON maps to a safe invalid-request response without initialization", async () => {
  let initialized = 0;
  const { handler, replies } = harness({
    runtime: { getService: async () => { initialized += 1; return {}; } },
    readJson: async () => { throw Object.assign(new Error("unexpected body fragment"), { status: 400 }); },
  });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box" }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.deepEqual(replies[0], {
    status: 400,
    payload: { ok: false, code: "AUTO_LISTING_REQUEST_INVALID", message: "自动上架请求无效", correlationId: "" },
  });
  assert.equal(initialized, 0);
});

test("route bounds target identifiers while preserving repeated collect IDs for the service", async () => {
  const received = [];
  const service = { createAutoListingJob: async (input) => { received.push(input); return { id: "job_1", items: [] }; } };
  const { handler, replies } = harness({ runtime: { getService: async () => service } });
  const bounded = {
    ...createBody,
    collectItemIds: ["collect_1", "collect_1"],
    config: { targetStoreId: "s".repeat(240), targetWarehouseId: "w".repeat(240) },
  };
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: bounded }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.equal(replies[0].status, 201);
  assert.deepEqual(received[0].collectItemIds, ["collect_1", "collect_1"]);

  for (const config of [
    { targetStoreId: "s".repeat(241), targetWarehouseId: "warehouse_1" },
    { targetStoreId: "store_1", targetWarehouseId: "w".repeat(241) },
    { targetStoreId: "", targetWarehouseId: "warehouse_1" },
  ]) {
    const local = harness({ runtime: { getService: async () => { throw new Error("must not initialize"); } } });
    await local.handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: { ...createBody, config } }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
    assert.equal(local.replies[0].status, 400);
  }
});

test("list and detail are actor-scoped, validate input, and never leak events or secrets", async () => {
  const calls = [];
  const service = {
    listAutoListingJobs: async (input) => { calls.push(["list", input]); return [{ id: "job_1", accountId: "account_b", events: [{ details: { rawResponse: "no" } }], items: [] }]; },
    getAutoListingJob: async (input) => { calls.push(["get", input]); return { id: "job_1", accountId: "account_b", sub2apiKey: "no", items: [{ id: "item_1", status: "READY_FOR_REVIEW", statusVersion: 3, rawResponseRef: "no", actions: { review: true, approve: true, retry: false, regenerate: true, cancel: true } }] }; },
  };
  const { handler, replies } = harness({ runtime: { getService: async () => service } });
  await handler(request({ path: "/auto-listing/jobs?limit=20" }), {}, new URL("http://local/auto-listing/jobs?limit=20"));
  await handler(request({ path: "/auto-listing/jobs/job_1" }), {}, new URL("http://local/auto-listing/jobs/job_1"));
  assert.deepEqual(calls, [
    ["list", { actor: { id: "account_a", role: "user" }, limit: 20 }],
    ["get", { actor: { id: "account_a", role: "user" }, jobId: "job_1" }],
  ]);
  assert.deepEqual(replies.map((reply) => reply.payload.data), [
    [{ jobId: "job_1", sourceType: "COLLECT_BOX", status: "CREATED", items: [] }],
    { jobId: "job_1", sourceType: "COLLECT_BOX", status: "CREATED", items: [{ itemId: "item_1", status: "READY_FOR_REVIEW", statusVersion: 3, actions: { review: true, approve: true, retry: false, regenerate: true, cancel: true } }] },
  ]);

  const invalid = harness({ runtime: { getService: async () => service } });
  await invalid.handler(request({ path: "/auto-listing/jobs?limit=101" }), {}, new URL("http://local/auto-listing/jobs?limit=101"));
  await invalid.handler(request({ method: "DELETE", path: "/auto-listing/jobs" }), {}, new URL("http://local/auto-listing/jobs"));
  assert.deepEqual(invalid.replies.map((reply) => [reply.status, reply.payload.code]), [[400, "AUTO_LISTING_REQUEST_INVALID"], [405, "AUTO_LISTING_METHOD_NOT_ALLOWED"]]);
});

test("HTTP task projection strips internal strategy metadata even if a service returns it", async () => {
  const service = {
    getAutoListingJob: async () => ({
      id: "job_1", items: [{
        id: "item_1", status: "SOURCE_READY", strategyId: "strategy-a",
        strategyVersionId: "version-a", style: "PARAMETER_FIRST", matchedBy: "CATEGORY",
      }],
    }),
  };
  const { handler, replies } = harness({ runtime: { getService: async () => service } });
  await handler(request({ path: "/auto-listing/jobs/job_1" }), {}, new URL("http://local/auto-listing/jobs/job_1"));
  const serialized = JSON.stringify(replies[0].payload.data);
  assert.doesNotMatch(serialized, /strategyId|strategyVersionId|PARAMETER_FIRST|matchedBy/);
});

test("GET query contract rejects client scope and unknown fields before runtime initialization", async () => {
  let initialized = 0;
  const runtime = { getService: async () => { initialized += 1; return {}; } };
  for (const path of [
    "/auto-listing/jobs?accountId=account_b",
    "/auto-listing/jobs?actor=account_b",
    "/auto-listing/jobs?owner=account_b",
    "/auto-listing/jobs?unexpected=value",
    "/auto-listing/jobs/job_1?limit=20",
    "/auto-listing/jobs/from-collect-box?limit=20",
  ]) {
    const local = harness({ runtime });
    await local.handler(request({ method: path.includes("from-collect-box") ? "POST" : "GET", path, body: createBody }), {}, new URL(`http://local${path}`));
    assert.equal(local.replies[0].status, 400);
    assert.equal(local.replies[0].payload.code, "AUTO_LISTING_REQUEST_INVALID");
  }
  assert.equal(initialized, 0);
});

test("unknown failures use a safe 500 envelope and unrelated paths are not handled", async () => {
  const { handler, replies } = harness({ runtime: { getService: async () => ({ listAutoListingJobs: async () => { throw new Error("postgres password=secret"); } }) } });
  assert.equal(await handler(request(), {}, new URL("http://local/auto-listing/jobs")), true);
  assert.deepEqual(replies[0], { status: 500, payload: { ok: false, code: "AUTO_LISTING_INTERNAL_ERROR", message: "自动上架请求处理失败", correlationId: "" } });
  assert.equal(await handler(request({ path: "/unrelated" }), {}, new URL("http://local/unrelated")), false);
});

test("known service failures preserve only safe codes and messages", async () => {
  const { handler, replies } = harness({
    runtime: {
      getService: async () => ({
        createAutoListingJob: async () => {
          throw Object.assign(new Error("target warehouse account_b secret"), {
            status: 422,
            code: "AUTO_LISTING_CONFIG_INVALID",
          });
        },
      }),
    },
  });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.deepEqual(replies[0], {
    status: 422,
    payload: { ok: false, code: "AUTO_LISTING_CONFIG_INVALID", message: "自动上架请求处理失败", correlationId: "corr_1" },
  });
});

test("missing exact category strategy returns only the closed configuration details", async () => {
  const { handler, replies } = harness({ runtime: { getService: async () => ({
    createAutoListingJob: async () => {
      throw Object.assign(new Error("account-a raw https://secret.invalid object-key"), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED",
        status: 500,
        details: {
          scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 123, typeId: 456 },
          status: "SAMPLES_READY",
          canManage: true,
          draftId: "same-account-draft",
        },
        accountId: "account-a",
        sampleUrl: "https://secret.invalid/sample.jpg",
        objectKey: "category-strategy/account-a/raw.webp",
        actor: { id: "admin-a" },
      });
    },
  }) } });

  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {},
    new URL("http://local/auto-listing/jobs/from-collect-box"));

  assert.deepEqual(replies[0], {
    status: 409,
    payload: {
      ok: false,
      code: "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED",
      message: "当前商品类目需要先配置并发布图片策略",
      correlationId: "corr_1",
      details: {
        scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 123, typeId: 456 },
        status: "SAMPLES_READY",
        canManage: true,
        draftId: "same-account-draft",
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(replies[0]), /account-a|secret\.invalid|object-key|admin-a|sampleUrl|objectKey/iu);
});

test("an atomic category-strategy race returns a fixed safe retry response", async () => {
  const { handler, replies } = harness({ runtime: { getService: async () => ({
    createAutoListingJob: async () => {
      throw Object.assign(new Error("account-a rule raw changed"), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_CHANGED", status: 500,
        details: { ruleId: "secret-rule", accountId: "account-a" },
      });
    },
  }) } });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {},
    new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.deepEqual(replies[0], { status: 409, payload: { ok: false,
    code: "AUTO_LISTING_CATEGORY_STRATEGY_CHANGED", message: "类目策略已变化，请重新提交创建任务",
    correlationId: "corr_1" } });
});

test("strategy-required route projection never executes hostile details accessors or proxy traps", async () => {
  for (const [label, details, counter] of [
    ["accessor", (() => {
      const value = { scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 123, typeId: 456 }, status: "COLLECTING", canManage: false };
      const counter = { reads: 0 };
      Object.defineProperty(value, "draftId", { enumerable: true, get() { counter.reads += 1; return "secret-draft"; } });
      return [value, counter];
    })(), null],
    ["proxy", new Proxy({}, { get() { throw new Error("must not trap"); } }), { reads: 0 }],
  ].map(([label, carrier, counter]) => Array.isArray(carrier) ? [label, carrier[0], carrier[1]] : [label, carrier, counter])) {
    const local = harness({ runtime: { getService: async () => ({
      createAutoListingJob: async () => {
        throw Object.assign(new Error("unsafe"), {
          code: "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED", details,
        });
      },
    }) } });
    await local.handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {},
      new URL("http://local/auto-listing/jobs/from-collect-box"));
    assert.equal(local.replies[0].status, 409, label);
    assert.equal("details" in local.replies[0].payload, false, label);
    assert.equal(counter.reads, 0, label);
  }
});

test("unsupported target-store currency has a stable safe 422 response", async () => {
  const { handler, replies } = harness({ runtime: { getService: async () => ({
    createAutoListingJob: async () => {
      throw Object.assign(new Error("store currency USD credential=secret"), {
        code: "AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED",
        status: 500,
      });
    },
  }) } });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.deepEqual(replies[0], {
    status: 422,
    payload: {
      ok: false,
      code: "AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED",
      message: "目标店铺币种暂不支持自动上架",
      correlationId: "corr_1",
    },
  });
  assert.doesNotMatch(JSON.stringify(replies[0]), /USD|credential|secret/iu);
});

test("unverified target-store currency has a stable safe 409 response", async () => {
  const { handler, replies } = harness({ runtime: { getService: async () => ({
    createAutoListingJob: async () => {
      throw Object.assign(new Error("legacy RUB inference credential=secret"), {
        code: "AUTO_LISTING_TARGET_STORE_CURRENCY_UNVERIFIED",
        status: 500,
      });
    },
  }) } });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.deepEqual(replies[0], {
    status: 409,
    payload: {
      ok: false,
      code: "AUTO_LISTING_TARGET_STORE_CURRENCY_UNVERIFIED",
      message: "店铺币种尚未同步，请先同步店铺资料",
      correlationId: "corr_1",
    },
  });
  assert.doesNotMatch(JSON.stringify(replies[0]), /legacy|RUB|credential|secret/iu);
});

for (const [code, status, message] of [
  ["AUTO_LISTING_CATEGORY_REFRESH_REQUIRED", 409, "Ozon 类目已更新，请刷新后重试"],
  ["AUTO_LISTING_CATEGORY_NEEDS_REVIEW", 409, "Ozon 当前类目无法唯一确定，请联系管理员处理"],
  ["AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", 422, "Ozon 类目属性暂时不可用，请稍后重试"],
  ["AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED", 422, "商品品牌或类目选项未在 Ozon 当前字典中登记，请先补全资料"],
  ["AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED", 422,
    "商品缺少品牌，且 Ozon 当前类目未提供唯一的“无品牌”选项，请补全品牌后重试"],
]) {
  test(`category preparation failure ${code} has a fixed safe response`, async () => {
    const { handler, replies } = harness({ runtime: { getService: async () => ({
      createAutoListingJob: async () => { throw Object.assign(new Error("raw must not leak"), { code, status }); },
    }) } });
    await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {},
      new URL("http://local/auto-listing/jobs/from-collect-box"));
    assert.deepEqual(replies[0], { status, payload: { ok: false, code, message, correlationId: "corr_1" } });
  });
}

for (const [code, status, message] of [
  ["RFBS_WAREHOUSE_NOT_FOUND", 404, "未找到目标 RFBS 仓库"],
  ["RFBS_WAREHOUSE_DISABLED", 409, "目标 RFBS 仓库不可用"],
  ["RFBS_WAREHOUSE_SCOPE_MISMATCH", 422, "RFBS 仓库不属于当前账号或店铺"],
  ["RFBS_WAREHOUSE_CHANGED", 409, "RFBS 仓库信息已变化"],
  ["RFBS_WAREHOUSE_EVIDENCE_EXPIRED", 409, "RFBS 仓库验证证据已过期"],
  ["RFBS_VALIDATION_REQUIRED", 503, "RFBS 仓库需要重新验证"],
  ["AUTO_LISTING_RFBS_VALIDATION_FAILED", 500, "RFBS 仓库验证失败"],
]) {
  test(`RFBS service failure ${code} has a fixed safe HTTP contract`, async () => {
    const local = harness({ runtime: { getService: async () => ({
      createAutoListingJob: async () => {
        throw Object.assign(new Error("apiKey=prod-secret rawResponse account_b"), {
          code,
          status: 418,
          credential: { apiKey: "prod-secret" },
          rawResponse: { accountId: "account_b", token: "secret-token" },
        });
      },
    }) } });

    await local.handler(
      request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }),
      {},
      new URL("http://local/auto-listing/jobs/from-collect-box"),
    );

    assert.deepEqual(local.replies[0], {
      status,
      payload: { ok: false, code, message, correlationId: "corr_1" },
    });
    assert.doesNotMatch(JSON.stringify(local.replies[0]), /prod-secret|rawResponse|account_b|secret-token|credential/iu);
  });
}

test("known service and authentication failures keep safe status, code, and bounded item details", async () => {
  const cases = [
    [404, "TARGET_STORE_NOT_FOUND", "自动上架请求处理失败"],
    [409, "TARGET_STORE_DISABLED", "自动上架请求处理失败"],
    [409, "TARGET_STORE_CREDENTIALS_REQUIRED", "自动上架请求处理失败"],
    [422, "LISTING_WAREHOUSE_NOT_ELIGIBLE", "自动上架请求处理失败"],
    [409, "AUTO_LISTING_SOURCE_VERSION_CONFLICT", "来源资料版本已变化，请刷新后重试"],
  ];
  for (const [status, code, message] of cases) {
    const local = harness({ runtime: { getService: async () => ({
      createAutoListingJob: async () => {
        throw Object.assign(new Error("account_b secret raw response"), {
          status,
          code,
          items: [{ itemId: "item_1", status: "BLOCKED", failureCode: "SOURCE_INVALID", rawResponse: "no", secret: "no", stack: "no" }],
        });
      },
    }) } });
    await local.handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
    assert.deepEqual(local.replies[0], {
      status,
      payload: {
        ok: false,
        code,
        message,
        correlationId: "corr_1",
        items: [{ itemId: "item_1", status: "BLOCKED", failureCode: "SOURCE_INVALID" }],
      },
    });
  }
  const forbidden = harness({
    authenticate: async () => { throw Object.assign(new Error("disabled user account_b"), { status: 403 }); },
  });
  await forbidden.handler(request(), {}, new URL("http://local/auto-listing/jobs"));
  assert.deepEqual(forbidden.replies[0], {
    status: 403,
    payload: { ok: false, code: "AUTO_LISTING_FORBIDDEN", message: "没有该操作权限", correlationId: "" },
  });
});

test("service status never overrides the closed public error map or impersonates authentication", async () => {
  const cases = [
    ["TARGET_STORE_NOT_FOUND", 401, 404, "TARGET_STORE_NOT_FOUND", "自动上架请求处理失败"],
    ["AUTO_LISTING_SOURCE_VERSION_CONFLICT", 403, 409, "AUTO_LISTING_SOURCE_VERSION_CONFLICT", "来源资料版本已变化，请刷新后重试"],
    ["UNKNOWN_SERVICE_FAILURE", 401, 500, "AUTO_LISTING_INTERNAL_ERROR", "自动上架请求处理失败"],
    ["UNKNOWN_SERVICE_FAILURE", 403, 500, "AUTO_LISTING_INTERNAL_ERROR", "自动上架请求处理失败"],
  ];
  for (const [code, thrownStatus, status, expectedCode, message] of cases) {
    const local = harness({ runtime: { getService: async () => ({
      createAutoListingJob: async () => {
        throw Object.assign(new Error("untrusted status"), { code, status: thrownStatus });
      },
    }) } });
    await local.handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
    assert.deepEqual(local.replies[0], {
      status,
      payload: { ok: false, code: expectedCode, message, correlationId: "corr_1" },
    });
  }
});

test("only authentication-stage 401 and 403 receive fixed authentication envelopes", async () => {
  for (const [status, code, message] of [
    [401, "AUTO_LISTING_UNAUTHENTICATED", "请先登录"],
    [403, "AUTO_LISTING_FORBIDDEN", "没有该操作权限"],
  ]) {
    const local = harness({
      authenticate: async () => { throw Object.assign(new Error("untrusted auth message"), { status }); },
    });
    await local.handler(request(), {}, new URL("http://local/auto-listing/jobs"));
    assert.deepEqual(local.replies[0], {
      status,
      payload: { ok: false, code, message, correlationId: "" },
    });
  }
});

test("error item details use a closed scalar allowlist and a hard limit", async () => {
  const items = Array.from({ length: 99 }, (_, index) => ({
    itemId: `item_${index}`,
    status: "BLOCKED",
    failureCode: "SOURCE_INVALID",
    rawResponse: "never public",
  }));
  items.push({ itemId: "item_invalid", status: "<script>", failureCode: "bad\ncode" });
  items.push(...Array.from({ length: 10 }, (_, index) => ({ itemId: `overflow_${index}`, status: "BLOCKED", failureCode: "SOURCE_INVALID" })));
  const { handler, replies } = harness({ runtime: { getService: async () => ({
    createAutoListingJob: async () => {
      throw Object.assign(new Error("safe failure"), {
        status: 422,
        code: "AUTO_LISTING_CONFIG_INVALID",
        items,
      });
    },
  }) } });
  await handler(request({ method: "POST", path: "/auto-listing/jobs/from-collect-box", body: createBody }), {}, new URL("http://local/auto-listing/jobs/from-collect-box"));
  assert.equal(replies[0].payload.items.length, 100);
  assert.deepEqual(replies[0].payload.items[0], { itemId: "item_0", status: "BLOCKED", failureCode: "SOURCE_INVALID" });
  assert.deepEqual(replies[0].payload.items.at(-1), { itemId: "item_invalid" });
  assert.equal(JSON.stringify(replies[0].payload.items).includes("rawResponse"), false);
});

test("runtime initializes once concurrently and retries after failure", async () => {
  let pools = 0;
  let repositories = 0;
  let services = 0;
  const runtime = createAutoListingRuntime({
    env: { AUTO_LISTING_ENABLED: "true", AUTO_LISTING_AI_ENABLED: "0" },
    getPostgresPool: async () => { pools += 1; if (pools === 1) throw new Error("temporary"); return { id: "pool" }; },
    createRepository: ({ pool }) => { repositories += 1; return { pool }; },
    createService: ({ repository }) => { services += 1; return { repository }; },
    createListingBasePreparer: async () => async () => ({}),
    createCategoryFreshness: async () => async () => ({ status: "CURRENT" }),
  });
  await assert.rejects(runtime.getService(), /temporary/);
  const [left, right] = await Promise.all([runtime.getService(), runtime.getService()]);
  assert.equal(left, right);
  assert.equal(pools, 2);
  assert.equal(repositories, 1);
  assert.equal(services, 1);
});

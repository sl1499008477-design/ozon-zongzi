import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingCategoryStrategyHttpHandler } from "../auto-listing-category-strategy-routes.mjs";

const actor = Object.freeze({ id: "account-a", role: "admin" });

function harness({ authenticated = actor, body = {}, serviceError = null } = {}) {
  const responses = [];
  const calls = [];
  let serviceReads = 0;
  const service = Object.freeze(Object.fromEntries([
    "listStrategies", "getSettings", "updateSettings", "getDraft", "createDraft",
    "startSamplingSession", "confirmSampleSet", "removeSample", "createAnalysisAttempt",
    "updateDraft", "publishDraft", "rollbackDraft", "readSampleThumbnail",
  ].map((method) => [method, async (input) => {
    calls.push({ method, input });
    const failure = typeof serviceError === "function" ? serviceError(method) : serviceError;
    if (failure) throw failure;
    return { method, safe: true };
  }])));
  const handler = createAutoListingCategoryStrategyHttpHandler({
    async authenticate() { return authenticated; },
    async getService() { serviceReads += 1; return service; },
    async readJson() { return body; },
    sendJson(_res, status, payload) { responses.push({ status, payload }); },
  });
  return { handler, responses, calls, get serviceReads() { return serviceReads; } };
}

async function request(h, method, pathname) {
  const handled = await h.handler({ method }, {}, new URL(`https://example.test${pathname}`));
  return { handled, response: h.responses.at(-1), call: h.calls.at(-1) };
}

const valid = {
  settings: {
    expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
    idempotencyKey: "policy-a", correlationId: "correlation-a",
  },
  draft: {
    scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 },
    sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:1",
    idempotencyKey: "draft-a", correlationId: "correlation-a",
  },
  session: { expectedDraftVersion: 1, idempotencyKey: "session-a", correlationId: "correlation-a" },
  samples: {
    expectedDraftVersion: 1, sessionId: "session-a",
    sessionSecret: "secret-value-at-least-32-characters",
    samples: Array.from({ length: 5 }, (_, index) => ({
      sku: `sku-${index}`, sourceProductId: 1000 + index, sourceProductRef: `product-${index}`,
    })),
    idempotencyKey: "samples-a", correlationId: "correlation-a",
  },
  remove: { expectedDraftVersion: 2, idempotencyKey: "remove-a", correlationId: "correlation-a" },
  analysis: { costConfirmed: true, idempotencyKey: "analysis-a", correlationId: "correlation-a" },
  edit: { expectedDraftVersion: 3, patch: {}, idempotencyKey: "edit-a", correlationId: "correlation-a" },
  publish: {
    expectedDraftVersion: 4, expectedPublishedStrategyVersionId: "strategy-v1",
    idempotencyKey: "publish-a", correlationId: "correlation-a",
  },
  rollback: {
    targetStrategyVersionId: "strategy-v1", expectedPublishedStrategyVersionId: "strategy-v2",
    idempotencyKey: "rollback-a", correlationId: "correlation-a",
  },
};

test("the fixed administrator route table maps only closed methods and path IDs", async () => {
  const cases = [
    ["GET", "/admin/auto-listing/category-strategies", {}, "listStrategies", 200],
    ["GET", "/admin/auto-listing/category-strategies/settings", {}, "getSettings", 200],
    ["PATCH", "/admin/auto-listing/category-strategies/settings", valid.settings, "updateSettings", 200],
    ["GET", "/admin/auto-listing/category-strategies/draft-a", {}, "getDraft", 200],
    ["POST", "/admin/auto-listing/category-strategies/drafts", valid.draft, "createDraft", 201],
    ["POST", "/admin/auto-listing/category-strategies/draft-a/sampling-sessions", valid.session, "startSamplingSession", 201],
    ["POST", "/admin/auto-listing/category-strategies/draft-a/sample-sets", valid.samples, "confirmSampleSet", 201],
    ["DELETE", "/admin/auto-listing/category-strategies/draft-a/samples/sample-a", valid.remove, "removeSample", 200],
    ["POST", "/admin/auto-listing/category-strategies/draft-a/analysis-attempts", valid.analysis, "createAnalysisAttempt", 201],
    ["PATCH", "/admin/auto-listing/category-strategies/draft-a", valid.edit, "updateDraft", 200],
    ["POST", "/admin/auto-listing/category-strategies/draft-a/publish", valid.publish, "publishDraft", 201],
    ["POST", "/admin/auto-listing/category-strategies/draft-a/rollback", valid.rollback, "rollbackDraft", 201],
  ];
  for (const [method, path, body, expectedMethod, status] of cases) {
    const h = harness({ body });
    const result = await request(h, method, path);
    assert.equal(result.handled, true, `${method} ${path}`);
    assert.equal(result.response.status, status, `${method} ${path}`);
    assert.equal(result.call.method, expectedMethod, `${method} ${path}`);
    assert.equal(result.call.input.actor, actor);
    assert.equal(Object.hasOwn(result.call.input, "accountId"), false);
    if (path.includes("draft-a") && !path.endsWith("/drafts")) assert.equal(result.call.input.draftId, "draft-a");
    if (path.includes("sample-a")) assert.equal(result.call.input.sampleId, "sample-a");
  }
});

test("authenticated sample thumbnail route streams only bounded WebP and maps integrity failures safely", async () => {
  const bytes = Buffer.from("verified-thumbnail");
  const writes = []; const responses = [];
  const handler = createAutoListingCategoryStrategyHttpHandler({
    authenticate: async () => actor,
    getService: async () => ({ async readSampleThumbnail(input) {
      assert.deepEqual(input, { actor, draftId: "draft-a", sampleId: "sample-a", imageId: "image-a" });
      return bytes;
    } }),
    readJson: async () => { throw new Error("GET must not read a body"); },
    sendJson: (_res, status, payload) => responses.push({ status, payload }),
  });
  const response = { writeHead: (status, headers) => writes.push({ status, headers }),
    end: (body) => writes.push({ body }) };
  assert.equal(await handler({ method: "GET" }, response, new URL(
    "https://example.test/admin/auto-listing/category-strategies/draft-a/samples/sample-a/images/image-a/thumbnail",
  )), true);
  assert.equal(writes[0].status, 200);
  assert.equal(writes[0].headers["Content-Type"], "image/webp");
  assert.deepEqual(writes[1].body, bytes);
  assert.deepEqual(responses, []);

  const failed = harness({ serviceError: Object.assign(new Error("private key"), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_HASH_MISMATCH", status: 409,
  }) });
  const result = await request(failed, "GET",
    "/admin/auto-listing/category-strategies/draft-a/samples/sample-a/images/image-a/thumbnail");
  assert.deepEqual(result.response, { status: 409, payload: { ok: false,
    code: "AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_HASH_MISMATCH",
    message: "样本缩略图校验失败，请重新采样" } });
  assert.doesNotMatch(JSON.stringify(result.response), /private|objectKey|hash mismatch/iu);
});

test("unknown paths are ignored while wrong methods, queries, IDs, and extra body fields are rejected", async () => {
  const unknown = harness();
  assert.equal((await request(unknown, "GET", "/admin/auto-listing/category-strategy")).handled, false);
  assert.equal(unknown.serviceReads, 0);

  for (const [method, path, body, status, code] of [
    ["PUT", "/admin/auto-listing/category-strategies/settings", {}, 405,
      "AUTO_LISTING_CATEGORY_STRATEGY_METHOD_NOT_ALLOWED"],
    ["GET", "/admin/auto-listing/category-strategies?accountId=account-b", {}, 400,
      "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID"],
    ["GET", "/admin/auto-listing/category-strategies/%2Fetc", {}, 400,
      "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID"],
    ["PATCH", "/admin/auto-listing/category-strategies/settings", { ...valid.settings, storeId: "store-a" }, 400,
      "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID"],
  ]) {
    const h = harness({ body });
    const result = await request(h, method, path);
    assert.equal(result.handled, true);
    assert.equal(result.response.status, status);
    assert.equal(result.response.payload.code, code);
    assert.equal(h.calls.length, 0);
  }
});

test("ordinary users are rejected before service construction or body reading", async () => {
  let bodyReads = 0;
  let serviceReads = 0;
  const responses = [];
  const handler = createAutoListingCategoryStrategyHttpHandler({
    authenticate: async () => ({ id: "account-a", role: "user" }),
    getService: async () => { serviceReads += 1; return {}; },
    readJson: async () => { bodyReads += 1; return valid.draft; },
    sendJson: (_res, status, payload) => responses.push({ status, payload }),
  });
  assert.equal(await handler({ method: "POST" }, {}, new URL(
    "https://example.test/admin/auto-listing/category-strategies/drafts",
  )), true);
  assert.deepEqual(responses[0], {
    status: 403,
    payload: { ok: false, code: "PERMISSION_FORBIDDEN", message: "没有类目策略管理权限" },
  });
  assert.equal(bodyReads, 0);
  assert.equal(serviceReads, 0);
});

test("hostile bodies do not execute getters or proxy traps and service errors expose only stable codes", async () => {
  let getterReads = 0;
  const accessor = { ...valid.settings };
  Object.defineProperty(accessor, "mode", { enumerable: true, get() { getterReads += 1; return "LEGACY_FALLBACK"; } });
  let proxyTraps = 0;
  const proxy = new Proxy(valid.settings, { ownKeys() { proxyTraps += 1; return []; } });
  for (const body of [accessor, proxy]) {
    const h = harness({ body });
    const result = await request(h, "PATCH", "/admin/auto-listing/category-strategies/settings");
    assert.equal(result.response.status, 400);
    assert.equal(result.response.payload.code, "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID");
    assert.equal(h.calls.length, 0);
  }
  assert.equal(getterReads, 0);
  assert.equal(proxyTraps, 0);

  const safe = harness({ serviceError: Object.assign(new Error("raw vendor secret"), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_EXPIRED", status: 409,
  }) });
  const expired = await request(safe, "GET", "/admin/auto-listing/category-strategies/draft-a");
  assert.deepEqual(expired.response, { status: 409, payload: {
    ok: false, code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_EXPIRED", message: "类目策略请求无法完成",
  } });
  assert.equal(JSON.stringify(expired.response).includes("vendor"), false);

  const internal = harness({ serviceError: new Error("database password") });
  const failed = await request(internal, "GET", "/admin/auto-listing/category-strategies/draft-a");
  assert.equal(failed.response.status, 500);
  assert.equal(failed.response.payload.code, "AUTO_LISTING_CATEGORY_STRATEGY_INTERNAL_ERROR");
  assert.equal(JSON.stringify(failed.response).includes("password"), false);
});

test("read-only rollout errors stay stable while reads and the enabling settings route remain available", async () => {
  const readOnly = Object.assign(new Error("internal policy detail"), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY", status: 409,
  });
  const h = harness({ body: valid.draft,
    serviceError: (method) => method === "createDraft" ? readOnly : null });
  assert.equal((await request(h, "GET", "/admin/auto-listing/category-strategies")).response.status, 200);
  assert.deepEqual((await request(h, "POST", "/admin/auto-listing/category-strategies/drafts")).response, {
    status: 409, payload: { ok: false, code: "AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY",
      message: "类目策略请求无法完成" },
  });
  const enabled = harness({ body: valid.settings });
  assert.equal((await request(enabled, "PATCH",
    "/admin/auto-listing/category-strategies/settings")).response.status, 200);
  assert.equal(enabled.calls[0].method, "updateSettings");
});

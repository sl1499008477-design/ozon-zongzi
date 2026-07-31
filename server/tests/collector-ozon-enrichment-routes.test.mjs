import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createCollectorOzonEnrichmentHttpHandler } from "../collector-ozon-enrichment-routes.mjs";

const SESSION = Object.freeze({
  collectorSessionId: "csess_route",
  accountId: "account-route",
  permissions: ["collector.ozon.read"],
});

function result(sku = "4862904234") {
  return {
    status: "COMPLETE",
    contractVersion: "collector.ozon.enrichment.v1",
    sku,
    descriptionCategoryId: 123,
    typeId: 456,
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    variantData: { description_category_id: 123 },
    source: "BACKEND_FLEET",
    capturedAt: "2026-07-31T00:00:00.000Z",
    cache: { hit: false, expiresAt: "2026-07-31T06:00:00.000Z" },
  };
}

function createRequest(method, pathname, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = {
    host: "127.0.0.1",
    authorization: "Collector cst_route-session",
    "content-type": "application/json",
  };
  return req;
}

function createResponse() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(payload = "") { this.body = payload ? JSON.parse(String(payload)) : null; },
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function harness(overrides = {}) {
  const calls = { authenticate: [], enrichOne: [], enrichBatch: [], claimNext: [], completeClaim: [], failClaim: [] };
  const service = {
    async enrichOne(input) { calls.enrichOne.push(input); return result(input.sku); },
    async enrichBatch(input) {
      calls.enrichBatch.push(input);
      return input.skus.map((sku) => sku === "bad"
        ? {
            sku,
            status: "ERROR",
            error: {
              code: "OZON_ENRICH_INCOMPLETE",
              message: "商品资料不完整",
              missingFields: ["weightG"],
              retryable: true,
            },
          }
        : { sku, status: "COMPLETE", result: result(sku) });
    },
    async claimNext(input) {
      calls.claimNext.push(input);
      return { id: "job-route", requestId: "request-route", sku: "4862904234", refreshBundle: true };
    },
    async completeClaim(input) { calls.completeClaim.push(input); return result("4862904234"); },
    async failClaim(input) { calls.failClaim.push(input); return { id: input.jobId, status: "FAILED" }; },
    ...overrides.service,
  };
  const handler = createCollectorOzonEnrichmentHttpHandler({
    async authenticate(req, permission) {
      calls.authenticate.push({ req, permission });
      if (overrides.authError) throw overrides.authError;
      return SESSION;
    },
    service,
    readJson,
    sendJson,
  });
  return { calls, handler };
}

async function request(h, method, pathname, body) {
  const req = createRequest(method, pathname, body);
  const res = createResponse();
  const handled = await h.handler(req, res, new URL(pathname, "http://127.0.0.1"));
  return { handled, status: res.status, body: res.body };
}

const ROUTES = [
  ["POST", "/collector/ozon/enrich", { requestId: "request-one", sku: "4862904234" }],
  ["POST", "/collector/ozon/enrich/batch", { requestId: "request-batch", skus: ["4862904234"] }],
  ["GET", "/collector/ozon/enrichment-jobs/next", undefined],
  ["POST", "/collector/ozon/enrichment-jobs/job-route/result", { variantData: { description_category_id: 123 } }],
  ["POST", "/collector/ozon/enrichment-jobs/job-route/fail", { code: "OZON_ENRICH_NOT_FOUND", message: "not found" }],
];

test("all five fixed routes authenticate collector.ozon.read before invoking the service", async () => {
  for (const [method, pathname, body] of ROUTES) {
    const h = harness({
      authError: Object.assign(new Error("permission denied"), {
        status: 403,
        code: "COLLECTOR_PERMISSION_DENIED",
      }),
    });
    const response = await request(h, method, pathname, body);
    assert.equal(response.handled, true, pathname);
    assert.equal(response.status, 403, pathname);
    assert.equal(response.body.code, "COLLECTOR_PERMISSION_DENIED", pathname);
    assert.equal(h.calls.authenticate.length, 1, pathname);
    assert.equal(h.calls.authenticate[0].permission, "collector.ozon.read", pathname);
    assert.equal(
      h.calls.enrichOne.length + h.calls.enrichBatch.length + h.calls.claimNext.length
        + h.calls.completeClaim.length + h.calls.failClaim.length,
      0,
      pathname,
    );
  }
});

test("single route returns the exact v1 success envelope from authenticated session scope", async () => {
  const h = harness();
  const response = await request(h, "POST", "/collector/ozon/enrich", {
    requestId: " request-one ",
    sku: " 4862904234 ",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, data: result() });
  assert.deepEqual(h.calls.enrichOne[0], {
    session: SESSION,
    requestId: "request-one",
    sku: "4862904234",
  });
});

test("public routes reject account, store, company, and unknown client control fields", async () => {
  for (const [pathname, valid] of [
    ["/collector/ozon/enrich", { requestId: "request-one", sku: "4862904234" }],
    ["/collector/ozon/enrich/batch", { requestId: "request-batch", skus: ["4862904234"] }],
  ]) {
    for (const injected of [
      { accountId: "account-attacker" },
      { storeId: "store-attacker" },
      { companyId: "company-attacker" },
      { forceRefresh: true },
      { action: "sync" },
      { url: "https://attacker.invalid" },
      { script: "steal()" },
      { headers: { Authorization: "Bearer secret" } },
      { cookie: "secret=1" },
    ]) {
      const h = harness();
      const response = await request(h, "POST", pathname, { ...valid, ...injected });
      assert.equal(response.status, 400, `${pathname} ${Object.keys(injected)[0]}`);
      assert.equal(h.calls.enrichOne.length + h.calls.enrichBatch.length, 0);
    }
  }
});

test("batch route preserves service order and stable per-item error shape", async () => {
  const h = harness();
  const response = await request(h, "POST", "/collector/ozon/enrich/batch", {
    requestId: "request-batch",
    skus: ["first", "bad", "third"],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.map((item) => [item.sku, item.status]), [
    ["first", "COMPLETE"],
    ["bad", "ERROR"],
    ["third", "COMPLETE"],
  ]);
  assert.deepEqual(response.body.data[1].error, {
    code: "OZON_ENRICH_INCOMPLETE",
    message: "商品资料不完整",
    missingFields: ["weightG"],
    retryable: true,
  });
});

test("batch route preserves the stable unique-SKU limit error contract", async () => {
  const h = harness();
  const response = await request(h, "POST", "/collector/ozon/enrich/batch", {
    requestId: "request-batch-limit",
    skus: Array.from({ length: 21 }, (_, index) => `sku-${index + 1}`),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "OZON_ENRICH_BATCH_LIMIT");
  assert.equal(response.body.retryable, false);
  assert.equal(h.calls.enrichBatch.length, 0);
});

test("result route accepts only variantData and exposes only the fixed minimal claim", async () => {
  const h = harness();
  const next = await request(h, "GET", "/collector/ozon/enrichment-jobs/next");
  assert.equal(next.status, 200);
  assert.deepEqual(next.body, {
    ok: true,
    job: { id: "job-route", requestId: "request-route", sku: "4862904234", refreshBundle: true },
  });
  assert.deepEqual(Object.keys(next.body.job).sort(), ["id", "refreshBundle", "requestId", "sku"]);

  const completed = await request(h, "POST", "/collector/ozon/enrichment-jobs/job-route/result", {
    variantData: { description_category_id: 123 },
  });
  assert.equal(completed.status, 200);
  assert.deepEqual(h.calls.completeClaim[0], {
    session: SESSION,
    jobId: "job-route",
    variantData: { description_category_id: 123 },
  });

  for (const injected of [
    { sku: "attacker" },
    { refreshBundle: false },
    { action: "arbitrary" },
    { url: "https://attacker.invalid" },
    { script: "steal()" },
    { headers: { Authorization: "Bearer secret" } },
    { cookie: "secret=1" },
  ]) {
    const rejected = harness();
    const response = await request(rejected, "POST", "/collector/ozon/enrichment-jobs/job-route/result", {
      variantData: { description_category_id: 123 },
      ...injected,
    });
    assert.equal(response.status, 400, Object.keys(injected)[0]);
    assert.equal(rejected.calls.completeClaim.length, 0);
  }
});

test("nested secret, request-control, and retired-scope keys are rejected before result caching", async () => {
  const forbiddenKeys = [
    "token",
    "Cookie",
    "Authorization",
    "api_key",
    "store_id",
    "seller-company-id",
    "action",
    "url",
    "script",
    "requestHeaders",
    "client_secret",
    "session_token",
    "set-cookie",
    "authorizationHeader",
    "proxyHeaders",
  ];
  for (const forbiddenKey of forbiddenKeys) {
    const h = harness();
    const response = await request(h, "POST", "/collector/ozon/enrichment-jobs/job-route/result", {
      variantData: {
        description_category_id: 123,
        nested: [{ [forbiddenKey]: "attacker-controlled" }],
      },
    });
    assert.equal(response.status, 400, forbiddenKey);
    assert.equal(h.calls.completeClaim.length, 0, forbiddenKey);
  }

  for (const secretValue of [
    "Bearer cst_secret-secret-secret-secret",
    "Collector cst_secret-secret-secret-secret",
    "ctt_secret-secret-secret-secret",
  ]) {
    const h = harness();
    const response = await request(h, "POST", "/collector/ozon/enrichment-jobs/job-route/result", {
      variantData: { description_category_id: 123, note: secretValue },
    });
    assert.equal(response.status, 400, secretValue);
    assert.equal(h.calls.completeClaim.length, 0, secretValue);
  }
});

test("credential detection permits ordinary Collector and Bearer prose", async () => {
  for (const note of ["Collector Edition", "Collector unavailable", "Bearer unavailable"]) {
    const h = harness();
    const response = await request(h, "POST", "/collector/ozon/enrichment-jobs/job-route/result", {
      variantData: { description_category_id: 123, note },
    });
    assert.equal(response.status, 200, note);
    assert.equal(h.calls.completeClaim.length, 1, note);
  }
});

test("fail route is strict and does not accept nested or arbitrary executor commands", async () => {
  const accepted = harness();
  const response = await request(accepted, "POST", "/collector/ozon/enrichment-jobs/job-route/fail", {
    code: "OZON_ENRICH_NOT_FOUND",
    message: "not found",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(accepted.calls.failClaim[0], {
    session: SESSION,
    jobId: "job-route",
    code: "OZON_ENRICH_NOT_FOUND",
    message: "not found",
  });

  for (const injected of [
    { accountId: "account-attacker" },
    { storeId: "store-attacker" },
    { companyId: "company-attacker" },
    { action: "retry-with-script" },
    { url: "https://attacker.invalid" },
    { script: "steal()" },
    { headers: { Cookie: "secret=1" } },
    { cookie: "secret=1" },
  ]) {
    const h = harness();
    const rejected = await request(h, "POST", "/collector/ozon/enrichment-jobs/job-route/fail", {
      code: "OZON_ENRICH_UPSTREAM_FAILED",
      message: "failed",
      ...injected,
    });
    assert.equal(rejected.status, 400, Object.keys(injected)[0]);
    assert.equal(h.calls.failClaim.length, 0);
  }
});

test("all fixed routes reject query-controlled actions and URLs", async () => {
  for (const [method, pathname, body] of ROUTES) {
    for (const query of ["?action=sync", "?url=https%3A%2F%2Fattacker.invalid", "?script=steal"]) {
      const h = harness();
      const response = await request(h, method, `${pathname}${query}`, body);
      assert.equal(response.status, 400, `${pathname}${query}`);
      assert.equal(
        h.calls.enrichOne.length + h.calls.enrichBatch.length + h.calls.claimNext.length
          + h.calls.completeClaim.length + h.calls.failClaim.length,
        0,
        pathname,
      );
    }
  }
});

test("next route reads its body and accepts only an empty plain object", async () => {
  for (const body of [undefined, {}]) {
    const h = harness();
    const response = await request(h, "GET", "/collector/ozon/enrichment-jobs/next", body);
    assert.equal(response.status, 200);
    assert.equal(h.calls.claimNext.length, 1);
  }

  for (const body of [
    { action: "sync" },
    { nested: { url: "https://attacker.invalid" } },
    { Authorization: "Collector cst_secret-secret-secret-secret" },
    { headers: { Cookie: "secret=1" } },
    { cookie: "secret=1" },
    { store_id: "retired-store" },
    { unknown: true },
    [],
  ]) {
    const h = harness();
    const response = await request(h, "GET", "/collector/ozon/enrichment-jobs/next", body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(h.calls.claimNext.length, 0, JSON.stringify(body));
  }
});

test("repository-prefixed failures are not exposed through the public route", async () => {
  const h = harness({
    service: {
      async enrichOne() {
        throw Object.assign(new Error("relation collector_ozon_enrichment_cache missing"), {
          status: 500,
          code: "OZON_ENRICHMENT_PERSISTENCE_FAILED",
        });
      },
    },
  });
  const response = await request(h, "POST", "/collector/ozon/enrich", {
    requestId: "request-private-repository-error",
    sku: "sku-private-repository-error",
  });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    ok: false,
    code: "OZON_ENRICH_UPSTREAM_FAILED",
    message: "Ozon 商品资料补全失败",
    missingFields: [],
    retryable: true,
  });
});

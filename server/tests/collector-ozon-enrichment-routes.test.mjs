import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { normalizeOzonAgentResult } from "../collector-ozon-enrichment-contract.mjs";
import { createCollectorOzonEnrichmentHttpHandler } from "../collector-ozon-enrichment-routes.mjs";

const SESSION = Object.freeze({
  collectorSessionId: "csess_route",
  accountId: "account-route",
  permissions: ["collector.ozon.read"],
});
const ACCOUNT = Object.freeze({ id: "account-route", username: "route-user" });
const NOW = new Date("2026-08-01T08:00:01.000Z");

function resultBody(overrides = {}) {
  return {
    variantData: {
      description_category_id: 17_000_001,
      type_id: 97_000_001,
      weight: 500,
      depth: 300,
      width: 200,
      height: 100,
      attributes: [],
    },
    captureContext: {
      sellerCompanyId: "2681910",
      revision: 4,
      observedAt: "2026-08-01T08:00:00.000Z",
    },
    claimFence: "claim-fence-route",
    ...overrides,
  };
}

function claimBody(overrides = {}) {
  return {
    captureContext: resultBody().captureContext,
    ...overrides,
  };
}

function observeBody(overrides = {}) {
  return {
    captureContext: resultBody().captureContext,
    ...overrides,
  };
}

function failBody(overrides = {}) {
  return {
    code: "ZONGZI_ENRICH_NOT_FOUND",
    message: "not found",
    captureContext: resultBody().captureContext,
    claimFence: "claim-fence-route",
    ...overrides,
  };
}

function result(sku = "4862904234") {
  return {
    status: "COMPLETE",
    contractVersion: "collector.ozon.enrichment.v1",
    sku,
    descriptionCategoryId: 123,
    typeId: 456,
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    variantData: { description_category_id: 123 },
    source: "EXTENSION_SELLER_CAPTURE",
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

async function readJson(req, { requireBody = false } = {}) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length && requireBody) {
    throw Object.assign(new Error("请求体不能为空"), { status: 400 });
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function harness(overrides = {}) {
  const calls = {
    authenticate: [],
    authenticateAccount: [],
    enrichOne: [],
    enrichBatch: [],
    observeSellerContext: [],
    claimNext: [],
    hasAvailableJob: [],
    completeClaim: [],
    failClaim: [],
    retryCollectItem: [],
  };
  const service = {
    async enrichOne(input) { calls.enrichOne.push(input); return result(input.sku); },
    async enrichBatch(input) {
      calls.enrichBatch.push(input);
      return input.skus.map((sku) => sku === "bad"
        ? {
            sku,
            status: "ERROR",
            error: {
              code: "ZONGZI_ENRICH_INCOMPLETE",
              message: "商品资料不完整",
              missingFields: ["weightG"],
              retryable: true,
            },
          }
        : { sku, status: "COMPLETE", result: result(sku) });
    },
    async claimNext(input) {
      calls.claimNext.push(input);
      return {
        id: "job-route",
        requestId: "request-route",
        sku: "4862904234",
        refreshBundle: true,
        claimFence: "claim-fence-route",
      };
    },
    async hasAvailableJob(input) {
      calls.hasAvailableJob.push(input);
      return overrides.available ?? true;
    },
    async observeSellerContext(input) { calls.observeSellerContext.push(input); },
    async completeClaim(input) { calls.completeClaim.push(input); return result("4862904234"); },
    async failClaim(input) { calls.failClaim.push(input); return { id: input.jobId, status: "FAILED" }; },
    async retryCollectItem(input) {
      calls.retryCollectItem.push(input);
      return {
        item: { id: input.collectItemId, enrichment: { status: "RETRYING" } },
        job: { id: "job-route-stable", requestId: "request-route", sku: "4862904234" },
      };
    },
    ...overrides.service,
  };
  const handler = createCollectorOzonEnrichmentHttpHandler({
    async authenticate(req, permission) {
      calls.authenticate.push({ req, permission });
      if (overrides.authError) throw overrides.authError;
      return overrides.session || SESSION;
    },
    async authenticateAccount(req) {
      calls.authenticateAccount.push({ req });
      if (overrides.accountAuthError) throw overrides.accountAuthError;
      return overrides.account || ACCOUNT;
    },
    service,
    readJson,
    sendJson,
    now: () => new Date(NOW),
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
  ["POST", "/collector/ozon/seller-context/observe", observeBody()],
  ["POST", "/collector/ozon/enrichment-jobs/next", claimBody()],
  ["POST", "/collector/ozon/enrichment-jobs/available", {}],
  ["POST", "/collector/ozon/enrichment-jobs/job-route/result", resultBody()],
  ["POST", "/collector/ozon/enrichment-jobs/job-route/fail", failBody()],
];

test("all seven fixed routes authenticate collector.ozon.read before invoking the service", async () => {
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
      h.calls.enrichOne.length + h.calls.enrichBatch.length + h.calls.observeSellerContext.length
        + h.calls.claimNext.length + h.calls.hasAvailableJob.length
        + h.calls.completeClaim.length + h.calls.failClaim.length,
      0,
      pathname,
    );
  }
});

test("availability route accepts only an exact empty body and returns the authenticated account result", async () => {
  const own = harness({ available: true });
  const available = await request(
    own,
    "POST",
    "/collector/ozon/enrichment-jobs/available",
    {},
  );
  assert.equal(available.status, 200);
  assert.deepEqual(available.body, { ok: true, available: true });
  assert.deepEqual(Object.keys(available.body).sort(), ["available", "ok"]);
  assert.deepEqual(own.calls.hasAvailableJob, [{ session: SESSION }]);

  const OTHER_SESSION = Object.freeze({
    collectorSessionId: "csess_route_other",
    accountId: "account-route-other",
    permissions: ["collector.ozon.read"],
  });
  const other = harness({ session: OTHER_SESSION, available: false });
  const unavailable = await request(
    other,
    "POST",
    "/collector/ozon/enrichment-jobs/available",
    {},
  );
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.body, { ok: true, available: false });
  assert.deepEqual(Object.keys(unavailable.body).sort(), ["available", "ok"]);
  assert.deepEqual(other.calls.hasAvailableJob, [{ session: OTHER_SESSION }]);

  const absent = harness();
  const absentBody = await request(
    absent,
    "POST",
    "/collector/ozon/enrichment-jobs/available",
  );
  assert.equal(absentBody.status, 400);
  assert.equal(absent.calls.hasAvailableJob.length, 0);

  for (const body of [
    null,
    [],
    { accountId: "account-attacker" },
    { storeId: "store-attacker" },
    { companyId: "company-attacker" },
    { unknown: true },
  ]) {
    const rejected = harness();
    const response = await request(
      rejected,
      "POST",
      "/collector/ozon/enrichment-jobs/available",
      body,
    );
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(rejected.calls.hasAvailableJob.length, 0, JSON.stringify(body));
  }

  const cookie = harness();
  const req = createRequest("POST", "/collector/ozon/enrichment-jobs/available", {});
  req.headers.cookie = "session=attacker-controlled";
  const res = createResponse();
  const handled = await cookie.handler(req, res, new URL(req.url, "http://127.0.0.1"));
  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.equal(cookie.calls.hasAvailableJob.length, 0);

  for (const method of ["GET", "PUT"]) {
    const wrongMethod = harness();
    const response = await request(
      wrongMethod,
      method,
      "/collector/ozon/enrichment-jobs/available",
      {},
    );
    assert.equal(response.status, 405, method);
    assert.equal(wrongMethod.calls.hasAvailableJob.length, 0, method);
  }
});

test("Seller context observe route accepts only one fresh snapshot from the authenticated Collector scope", async () => {
  const h = harness();
  const response = await request(
    h,
    "POST",
    "/collector/ozon/seller-context/observe",
    observeBody(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.deepEqual(h.calls.observeSellerContext, [{
    session: SESSION,
    captureContext: resultBody().captureContext,
  }]);

  for (const body of [
    {},
    { captureContext: resultBody().captureContext, unknown: true },
    { captureContext: resultBody().captureContext, cookie: "sid=attacker" },
    { captureContext: { ...resultBody().captureContext, storeId: "store-attacker" } },
    {
      captureContext: {
        ...resultBody().captureContext,
        observedAt: new Date(NOW.getTime() - 10 * 60 * 1000 - 1).toISOString(),
      },
    },
  ]) {
    const rejected = harness();
    const invalid = await request(
      rejected,
      "POST",
      "/collector/ozon/seller-context/observe",
      body,
    );
    assert.equal(invalid.status, 400, JSON.stringify(body));
    assert.equal(rejected.calls.observeSellerContext.length, 0, JSON.stringify(body));
  }
});

test("Seller context observe route rejects Cookie headers instead of accepting cookie control", async () => {
  const h = harness();
  const req = createRequest(
    "POST",
    "/collector/ozon/seller-context/observe",
    observeBody(),
  );
  req.headers.cookie = "session=attacker-controlled";
  const res = createResponse();

  const handled = await h.handler(
    req,
    res,
    new URL(req.url, "http://127.0.0.1"),
  );

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.equal(h.calls.observeSellerContext.length, 0);
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
    code: "ZONGZI_ENRICH_INCOMPLETE",
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
  assert.equal(response.body.code, "ZONGZI_ENRICH_BATCH_LIMIT");
  assert.equal(response.body.retryable, false);
  assert.equal(h.calls.enrichBatch.length, 0);
});

test("result route accepts only the fixed Seller result envelope and exposes the minimal claim", async () => {
  const h = harness();
  const next = await request(h, "POST", "/collector/ozon/enrichment-jobs/next", claimBody());
  assert.equal(next.status, 200);
  assert.deepEqual(next.body, {
    ok: true,
    job: {
      id: "job-route",
      requestId: "request-route",
      sku: "4862904234",
      refreshBundle: true,
      claimFence: "claim-fence-route",
    },
  });
  assert.deepEqual(Object.keys(next.body.job).sort(), ["claimFence", "id", "refreshBundle", "requestId", "sku"]);
  assert.deepEqual(h.calls.claimNext[0], {
    session: SESSION,
    captureContext: resultBody().captureContext,
  });

  const completed = await request(
    h,
    "POST",
    "/collector/ozon/enrichment-jobs/job-route/result",
    resultBody(),
  );
  assert.equal(completed.status, 200);
  assert.deepEqual(h.calls.completeClaim[0], {
    session: SESSION,
    jobId: "job-route",
    variantData: resultBody().variantData,
    captureContext: resultBody().captureContext,
    claimFence: "claim-fence-route",
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
      ...resultBody(),
      ...injected,
    });
    assert.equal(response.status, 400, Object.keys(injected)[0]);
    assert.equal(rejected.calls.completeClaim.length, 0);
  }
});

test("result route accepts real Seller source evidence without a guessed type_id", async () => {
  let completionInput;
  let normalized;
  const h = harness({
    service: {
      async completeClaim(input) {
        completionInput = input;
        normalized = normalizeOzonAgentResult({
          sku: "4862904234",
          variantData: input.variantData,
          source: "EXTENSION_SELLER_CAPTURE",
          capturedAt: input.captureContext.observedAt,
        });
        return normalized;
      },
    },
  });
  const variantData = {
    description_category_id: 17_000_001,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    attributes: [{
      key: "8229",
      value: "Заварочный чайник",
      dictionary_value_id: 123456,
    }],
  };

  const response = await request(
    h,
    "POST",
    "/collector/ozon/enrichment-jobs/job-route/result",
    {
      variantData,
      captureContext: resultBody().captureContext,
      claimFence: "claim-fence-route",
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(completionInput, {
    session: SESSION,
    jobId: "job-route",
    variantData,
    captureContext: resultBody().captureContext,
    claimFence: "claim-fence-route",
  });
  assert.equal(normalized.status, "COMPLETE");
  assert.equal(Object.hasOwn(normalized, "typeId"), false);
  assert.equal(normalized.descriptionCategoryId, 17_000_001);
  assert.deepEqual(normalized.logistics, {
    weightG: 500,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 100,
  });
  assert.deepEqual(normalized.sourceCategory, {
    descriptionCategoryId: 17_000_001,
    typeName: "Заварочный чайник",
    typeIdCandidate: 123456,
    path: [],
    attributes: [{
      key: "8229",
      value: "Заварочный чайник",
      dictionary_value_id: 123456,
    }],
  });
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
        ...resultBody().variantData,
        attributes: [{ key: "8229", value: "type", [forbiddenKey]: "attacker-controlled" }],
      },
      captureContext: resultBody().captureContext,
      claimFence: "claim-fence-route",
    });
    assert.equal(response.status, 400, forbiddenKey);
    assert.equal(h.calls.completeClaim.length, 0, forbiddenKey);
  }

  for (const forbiddenKey of ["auth", "jwt", "session", "cookieJar"]) {
    const h = harness();
    const response = await request(h, "POST", "/collector/ozon/enrichment-jobs/job-route/result", {
      variantData: {
        ...resultBody().variantData,
        attributes: [{
          key: "8229",
          value: { safeLookingWrapper: { [forbiddenKey]: "attacker-controlled" } },
        }],
      },
      captureContext: resultBody().captureContext,
      claimFence: "claim-fence-route",
    });
    assert.equal(response.status, 400, forbiddenKey);
    assert.equal(response.body.code, "ZONGZI_ENRICH_REQUEST_INVALID", forbiddenKey);
    assert.equal(response.body.message.includes(forbiddenKey), true, forbiddenKey);
    assert.equal(h.calls.completeClaim.length, 0, forbiddenKey);
  }

  for (const secretValue of [
    "Bearer cst_secret-secret-secret-secret",
    "Collector cst_secret-secret-secret-secret",
    "ctt_secret-secret-secret-secret",
  ]) {
    const h = harness();
    const response = await request(h, "POST", "/collector/ozon/enrichment-jobs/job-route/result", {
      variantData: {
        ...resultBody().variantData,
        attributes: [{ key: "8229", value: secretValue }],
      },
      captureContext: resultBody().captureContext,
      claimFence: "claim-fence-route",
    });
    assert.equal(response.status, 400, secretValue);
    assert.equal(h.calls.completeClaim.length, 0, secretValue);
  }
});

test("credential detection permits ordinary Collector and Bearer attribute prose", async () => {
  for (const note of ["Collector Edition", "Collector unavailable", "Bearer unavailable"]) {
    const h = harness();
    const response = await request(h, "POST", "/collector/ozon/enrichment-jobs/job-route/result", {
      variantData: {
        ...resultBody().variantData,
        attributes: [{ key: "8229", value: note }],
      },
      captureContext: resultBody().captureContext,
      claimFence: "claim-fence-route",
    });
    assert.equal(response.status, 200, note);
    assert.equal(h.calls.completeClaim.length, 1, note);
  }
});

test("result validation rejects malformed Seller evidence and unknown data before completion", async () => {
  const invalidBodies = [
    { ...resultBody(), unknown: true },
    resultBody({ variantData: { ...resultBody().variantData, categories: [] } }),
    resultBody({ variantData: { ...resultBody().variantData, description_category_id: 0 } }),
    resultBody({ variantData: { ...resultBody().variantData, description_category_id: 1.5 } }),
    resultBody({ variantData: { ...resultBody().variantData, type_id: "97000001" } }),
    resultBody({ variantData: { ...resultBody().variantData, type_id: 0 } }),
    resultBody({ variantData: { ...resultBody().variantData, type_id: -1 } }),
    resultBody({ variantData: { ...resultBody().variantData, type_id: 1.5 } }),
    resultBody({ variantData: { ...resultBody().variantData, weight: -1 } }),
    resultBody({ captureContext: { ...resultBody().captureContext, revision: 0 } }),
    resultBody({ captureContext: { ...resultBody().captureContext, revision: 1.5 } }),
    resultBody({ captureContext: { ...resultBody().captureContext, revision: "4" } }),
    resultBody({ captureContext: { ...resultBody().captureContext, sellerCompanyId: "seller-a" } }),
    resultBody({ captureContext: { ...resultBody().captureContext, observedAt: "invalid" } }),
    resultBody({
      captureContext: {
        ...resultBody().captureContext,
        observedAt: new Date(NOW.getTime() + 5_001).toISOString(),
      },
    }),
    resultBody({ captureContext: { ...resultBody().captureContext, accountId: "forged" } }),
    resultBody({ captureContext: { ...resultBody().captureContext, cookie: "sid=secret" } }),
    resultBody({
      captureContext: {
        ...resultBody().captureContext,
        sellerCompanyId: "Collector cst_secret-secret-secret-secret",
      },
    }),
    resultBody({
      variantData: {
        ...resultBody().variantData,
        attributes: [{ key: "8229", value: "csess_secret-secret-secret-secret" }],
      },
    }),
  ];
  for (const body of invalidBodies) {
    const h = harness();
    const response = await request(
      h,
      "POST",
      "/collector/ozon/enrichment-jobs/job-route/result",
      body,
    );
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(h.calls.completeClaim.length, 0, JSON.stringify(body));
  }

  const withinSkew = harness();
  const accepted = await request(
    withinSkew,
    "POST",
    "/collector/ozon/enrichment-jobs/job-route/result",
    resultBody({
      captureContext: {
        ...resultBody().captureContext,
        observedAt: new Date(NOW.getTime() + 5_000).toISOString(),
      },
    }),
  );
  assert.equal(accepted.status, 200);
  assert.equal(withinSkew.calls.completeClaim.length, 1);
});

test("Seller context failures remain stable public error codes", async () => {
  for (const code of ["SELLER_CONTEXT_REQUIRED", "SELLER_CONTEXT_CHANGED"]) {
    const h = harness({
      service: {
        async failClaim() {
          throw Object.assign(new Error("Seller context unavailable"), {
            status: 409,
            code,
            retryable: true,
          });
        },
      },
    });
    const response = await request(
      h,
      "POST",
      "/collector/ozon/enrichment-jobs/job-route/fail",
      failBody({ code, message: "Seller context unavailable" }),
    );
    assert.equal(response.status, 409, code);
    assert.equal(response.body.code, code, code);
    assert.equal(response.body.retryable, true, code);
  }
});

test("manual retry uses web account authentication and keeps cross-account items opaque", async () => {
  const h = harness();
  const first = await request(
    h,
    "POST",
    "/ozon/collect-box/collect-route/enrichment/retry",
    {},
  );
  const second = await request(
    h,
    "POST",
    "/ozon/collect-box/collect-route/enrichment/retry",
    {},
  );
  assert.equal(first.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(h.calls.authenticate.length, 0);
  assert.equal(h.calls.authenticateAccount.length, 2);
  assert.deepEqual(h.calls.retryCollectItem, [
    { accountId: "account-route", collectItemId: "collect-route" },
    { accountId: "account-route", collectItemId: "collect-route" },
  ]);

  const hidden = harness({
    account: { id: "account-other" },
    service: {
      async retryCollectItem() {
        throw Object.assign(new Error("采集箱条目不存在"), {
          status: 404,
          code: "COLLECT_ITEM_NOT_FOUND",
          retryable: false,
        });
      },
    },
  });
  const response = await request(
    hidden,
    "POST",
    "/ozon/collect-box/collect-route/enrichment/retry",
    {},
  );
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "COLLECT_ITEM_NOT_FOUND");
  assert.equal(response.body.message.includes("account-route"), false);
});

test("fail route is strict and does not accept nested or arbitrary executor commands", async () => {
  const accepted = harness();
  const response = await request(
    accepted,
    "POST",
    "/collector/ozon/enrichment-jobs/job-route/fail",
    failBody(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(accepted.calls.failClaim[0], {
    session: SESSION,
    jobId: "job-route",
    code: "ZONGZI_ENRICH_NOT_FOUND",
    message: "not found",
    captureContext: resultBody().captureContext,
    claimFence: "claim-fence-route",
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
    const rejected = await request(
      h,
      "POST",
      "/collector/ozon/enrichment-jobs/job-route/fail",
      failBody({
        code: "ZONGZI_ENRICH_UPSTREAM_FAILED",
        message: "failed",
        ...injected,
      }),
    );
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
        h.calls.enrichOne.length + h.calls.enrichBatch.length + h.calls.observeSellerContext.length
          + h.calls.claimNext.length + h.calls.hasAvailableJob.length
          + h.calls.completeClaim.length + h.calls.failClaim.length,
        0,
        pathname,
      );
    }
  }
});

test("next route requires one exact Seller context snapshot before claiming", async () => {
  {
    const h = harness();
    const response = await request(h, "POST", "/collector/ozon/enrichment-jobs/next", claimBody());
    assert.equal(response.status, 200);
    assert.equal(h.calls.claimNext.length, 1);
  }
  {
    const h = harness();
    const response = await request(h, "POST", "/collector/ozon/enrichment-jobs/next", claimBody({
      captureContext: {
        ...resultBody().captureContext,
        observedAt: new Date(NOW.getTime() - 10 * 60 * 1000 - 1).toISOString(),
      },
    }));
    assert.equal(response.status, 400);
    assert.equal(h.calls.claimNext.length, 0);
  }
  {
    const h = harness();
    const response = await request(h, "POST", "/collector/ozon/enrichment-jobs/next", claimBody({
      captureContext: {
        ...resultBody().captureContext,
        observedAt: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(),
      },
    }));
    assert.equal(response.status, 200);
    assert.equal(h.calls.claimNext.length, 1);
  }
  for (const body of [
    undefined,
    {},
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
    const response = await request(h, "POST", "/collector/ozon/enrichment-jobs/next", body);
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
          code: "ZONGZI_ENRICHMENT_PERSISTENCE_FAILED",
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
    code: "ZONGZI_ENRICH_UPSTREAM_FAILED",
    message: "Ozon 商品资料补全失败",
    missingFields: [],
    retryable: true,
  });
});

test('result accepts two bounded packaging candidates while rejecting extra candidate fields',async()=>{
 const candidates=[{weightG:105,lengthMm:140,widthMm:60,heightMm:50},{weightG:125,lengthMm:143,widthMm:63,heightMm:54}];
 const h=harness(),body=resultBody();body.variantData.packagingCandidates=candidates;
 const accepted=await request(h,'POST','/collector/ozon/enrichment-jobs/job-route/result',body);
 assert.equal(accepted.status,200);assert.deepEqual(h.calls.completeClaim[0].variantData.packagingCandidates,candidates);
 body.variantData.packagingCandidates[0].companyId='injected';
 assert.equal((await request(h,'POST','/collector/ozon/enrichment-jobs/job-route/result',body)).status,400);
});


test('result route accepts explicitly missing logistics while retaining native numeric checks', async () => {
  const h=harness();
  const body=resultBody();body.variantData.height=null;
  const response=await request(h,'POST','/collector/ozon/enrichment-jobs/job-route/result',body);
  assert.equal(response.status,200);
  assert.equal(h.calls.completeClaim[0].variantData.height,null);
  for(const height of [-1,'100',false]) {
    const rejected=await request(h,'POST','/collector/ozon/enrichment-jobs/job-route/result',{...body,variantData:{...body.variantData,height}});
    assert.equal(rejected.status,400);
  }
});

test("current extension attribute values reach completion with per-value dictionary IDs intact", async () => {
  await import("../../extension/lib/ozon-enrichment-contract.js");
  const attributes = globalThis.JzOzonEnrichmentContract.projectCollectedVariant({ attributes: [
    { key: "8229", values: [{ value: "Настенный светильник", dictionary_value_id: 91647 }] },
    { key: "10096", values: [{ value: "Теплый белый", dictionary_value_id: 123 }, { value: "Белый", dictionary_value_id: 456 }] },
    { key: "85", values: [{ dictionary_value_id: 789 }] },
    { key: "9048", values: [] },
  ] }).attributes;
  let normalized;
  const h = harness({ service: { async completeClaim(input) {
    normalized = normalizeOzonAgentResult({sku:"2102713933",variantData:input.variantData,capturedAt:NOW});
    return normalized;
  } } });
  const response = await request(h,"POST","/collector/ozon/enrichment-jobs/job-route/result",{
    ...resultBody(), variantData: { ...resultBody().variantData, attributes },
  });
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(normalized.status,"COMPLETE");
  assert.deepEqual(normalized.variantData.attributes,attributes);
  assert.equal(normalized.sourceCategory.typeIdCandidate,91647);
  assert.deepEqual(normalized.sourceCategory.attributes.map(a=>a.values),[
    [{value:"Настенный светильник",dictionary_value_id:91647}],
    [{value:"Теплый белый",dictionary_value_id:123},{value:"Белый",dictionary_value_id:456}],
    [{dictionary_value_id:789}], [],
  ]);
});

test("structured attribute values preserve legacy clients and reject malformed or sensitive entries", async () => {
  const path="/collector/ozon/enrichment-jobs/job-route/result";
  for (const attribute of [
    {key:"85",collection:[{value:"A",dictionary_value_id:100},{dictionary_value_id:200}]},
    {key:"85",dictionary_value_id:100},
    {key:"85",values:[],value:"old text"},
    {key:"85",value:"legacy"},
    {key:"85",collection:["legacy A","legacy B"]},
  ]) {
    const h=harness();const response=await request(h,"POST",path,{...resultBody(),variantData:{...resultBody().variantData,attributes:[attribute]}});
    assert.equal(response.status,200,JSON.stringify(response.body));
  }
  for (const attribute of [
    {key:"85",values:{}}, {key:"85",values:[{}]}, {key:"85",values:["bad"]},
    {key:"85",values:[{value:{nested:"bad"}}]}, {key:"85",values:[{dictionary_value_id:0}]},
    {key:"85",values:[{dictionary_value_id:1.2}]}, {key:"85",values:[{dictionary_value_id:"100"}]},
    {key:"85",values:[{value:"A",unknown:"bad"}]},
    {key:"85",values:[{value:"A",accountId:"forged"}]},
    {key:"85",values:[{value:"A",cookie:"sid=private"}]},
    {key:"85",values:[{value:"Bearer secret-secret-secret-secret"}]},
  ]) {
    const h=harness();const response=await request(h,"POST",path,{...resultBody(),variantData:{...resultBody().variantData,attributes:[attribute]}});
    assert.equal(response.status,400,JSON.stringify(attribute));
    assert.equal(h.calls.completeClaim.length,0);
  }
});

// These regressions cross the HTTP boundary, service and real JSON repository.
async function repairHarness({ linked = false, attemptCount = 0 } = {}) {
  const { createCollectorOzonEnrichmentService } = await import('../collector-ozon-enrichment-service.mjs');
  const { createJsonCollectorOzonEnrichmentRepository } = await import('../collector-ozon-enrichment-repository.mjs');
  const clock = { value: NOW.getTime() };
  const context = resultBody().captureContext;
  const state = {
    collectorSessions: ['csess_route', 'csess_other'].map(id => ({
      id, accountId: SESSION.accountId, expiresAt: '2027-01-01T00:00:00.000Z', sellerContext: context,
    })),
    caches: { collectBox: [{ id: 'repair-item', accountId: SESSION.accountId }] },
    collectorOzonEnrichmentJobs: [{
      id: 'job-route', accountId: SESSION.accountId, requestId: 'repair-request', sku: '2102713588',
      collectItemId: linked ? 'repair-item' : null,
      status: 'PROCESSING', claimedSessionId: SESSION.collectorSessionId, claimFence: 'claim-fence-route',
      captureContext: context, claimExpiresAt: new Date(clock.value + 30_000).toISOString(),
      deadlineAt: new Date(clock.value + 20_000).toISOString(), createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(), nextAttemptAt: NOW.toISOString(), attemptCount,
      refreshBundle: true, error: null, result: null, lastError: null,
    }],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const audits = [];
  let sequence = 0;
  const service = createCollectorOzonEnrichmentService({
    repository, now: () => new Date(clock.value), randomUUID: () => `repair-${++sequence}`,
    sleep: async ms => { clock.value += ms; }, audit: async event => audits.push(event),
    collectItems: {
      async defer(input) { return { item: state.caches.collectBox[0], job: await repository.deferClaim(input.deferClaim) }; },
      async fail(input) { return { item: state.caches.collectBox[0], job: await repository.failJobAndCache(input.failure) }; },
    },
  });
  const handler = createCollectorOzonEnrichmentHttpHandler({
    authenticate: async (_req, permission) => { assert.equal(permission, 'collector.ozon.read'); return SESSION; },
    authenticateAccount: async () => ACCOUNT, service, readJson, sendJson, now: () => new Date(clock.value),
  });
  return { handler, service, state, repository, audits, clock };
}

const repairDiagnostic = Object.freeze({
  stage: 'seller.search', upstreamCode: 'NETWORK_ERROR', upstreamStatus: 503,
  requestSent: true, extensionVersion: '1.0.6',
});

test('repair: fail preserves the specific cause and diagnostic through persistence, audit and public errors', async () => {
  const h = await repairHarness();
  const response = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/fail', failBody({
    code: 'NETWORK_ERROR', message: 'Seller /api/v1/search: net::ERR_CONNECTION_RESET', diagnostic: repairDiagnostic,
  }));
  assert.equal(response.status, 200);
  const saved = h.state.collectorOzonEnrichmentJobs[0].error;
  assert.equal(saved.message, 'Seller /api/v1/search: net::ERR_CONNECTION_RESET');
  assert.deepEqual(saved.diagnostic, repairDiagnostic);
  assert.deepEqual(h.audits.at(-1).diagnostic, repairDiagnostic);
  assert.equal(h.audits.at(-1).message, saved.message);
  const failed = await request(h, 'POST', '/collector/ozon/enrich', { requestId: 'repair-request', sku: '2102713588' });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.message, saved.message);
  assert.deepEqual(failed.body.diagnostic, repairDiagnostic);
});

test('repair: legacy fail body keeps a sanitized cause instead of rejecting credentials or replacing the whole message', async () => {
  const h = await repairHarness();
  const message = 'Seller /api/v1/search: net::ERR_CONNECTION_RESET\n'
    + 'Authorization: Bearer bearer-secret\nCookie: sid=cookie-secret; auth=another-secret\n'
    + 'https://user:password-secret@seller.ozon.ru/api?token=query-secret\n'
    + '{"password":"json secret", "api_key":"api-secret"} cst_collector-secret';
  const response = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/fail', failBody({ code: 'NETWORK_ERROR', message }));
  assert.equal(response.status, 200);
  const saved = h.state.collectorOzonEnrichmentJobs[0].error;
  assert.match(saved.message, /net::ERR_CONNECTION_RESET/);
  const persisted = JSON.stringify([h.state, h.audits]);
  for (const secret of ['bearer-secret','cookie-secret','another-secret','password-secret','query-secret','json secret','api-secret','cst_collector-secret']) {
    assert.equal(persisted.includes(secret), false, secret);
  }
});

test('repair: linked retry and retry exhaustion retain the actual upstream explanation', async () => {
  for (const attemptCount of [0, 4]) {
    const h = await repairHarness({ linked: true, attemptCount });
    const response = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/fail', failBody({
      code: 'NETWORK_ERROR', message: 'Seller /api/v1/search: net::ERR_CONNECTION_RESET', diagnostic: repairDiagnostic,
    }));
    assert.equal(response.status, 200);
    const job = h.state.collectorOzonEnrichmentJobs[0];
    assert.equal(job.attemptCount, attemptCount + 1);
    assert.equal(job.status, attemptCount === 4 ? 'FAILED' : 'PENDING');
    const saved = attemptCount === 4 ? job.error : job.lastError;
    assert.equal(saved.message, 'Seller /api/v1/search: net::ERR_CONNECTION_RESET');
    assert.deepEqual(saved.diagnostic, repairDiagnostic);
  }
});

test('repair: diagnostic validates its actual allowlist and scalar types before any write', async () => {
  for (const diagnostic of [[], null, {requestSent: 'false'}, {upstreamStatus: '503'}, {upstreamStatus: 700},
    {stage: {}}, {extensionVersion: {token: 'secret'}}, {authorization: 'secret'}]) {
    const h = await repairHarness();
    const before = structuredClone(h.state);
    const response = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/fail', failBody({ diagnostic }));
    assert.equal(response.status, 400, JSON.stringify(diagnostic));
    assert.deepEqual(h.state, before);
  }
});

test('repair: progress renews the same lease without a business transition, even after a long capture', async () => {
  const h = await repairHarness();
  h.clock.value += 11 * 60_000;
  const before = structuredClone(h.state.collectorOzonEnrichmentJobs[0]);
  const body = { claimFence: before.claimFence, captureContext: before.captureContext };
  for (let i = 0; i < 2; i++) {
    const response = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/progress', body);
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
  }
  const renewed = h.state.collectorOzonEnrichmentJobs[0];
  assert.deepEqual({ ...renewed, claimExpiresAt: before.claimExpiresAt, updatedAt: before.updatedAt }, before);
  assert.equal(new Date(renewed.claimExpiresAt).getTime(), h.clock.value + 30_000);
  assert.equal(h.audits.some(event => event.status === 'FAILED'), false);
  const result = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/result', resultBody());
  assert.equal(result.status, 200);
  assert.equal(renewed.status, 'SUCCESS');
});

test('repair: a late result is accepted until takeover and a repeated terminal result cannot write again', async () => {
  const h = await repairHarness();
  h.clock.value += 45_000;
  const response = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/result', resultBody());
  assert.equal(response.status, 200);
  assert.equal(h.state.collectorOzonEnrichmentJobs[0].attemptCount, 0);
  const before = structuredClone(h.state);
  const duplicate = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/result', resultBody());
  assert.equal(duplicate.status, 409);
  assert.deepEqual(h.state, before);
});

test('repair: expiration permits fenced takeover without inventing failures or resetting retry history', async () => {
  const h = await repairHarness({ linked: true, attemptCount: 2 });
  let previousFence = 'claim-fence-route';
  for (let i = 0; i < 6; i++) {
    assert.equal(await h.service.claimNext({session: SESSION, captureContext: resultBody().captureContext}), null);
    h.clock.value += 31_000;
    const claim = await h.service.claimNext({session: SESSION, captureContext: resultBody().captureContext});
    assert.ok(claim);
    assert.notEqual(claim.claimFence, previousFence);
    const stale = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/progress', {
      claimFence: previousFence, captureContext: resultBody().captureContext,
    });
    assert.equal(stale.status, 409);
    previousFence = claim.claimFence;
    const job = h.state.collectorOzonEnrichmentJobs[0];
    assert.equal(job.status, 'PROCESSING');
    assert.equal(job.attemptCount, 2);
    assert.equal(job.lastError, null);
    assert.equal(job.error, null);
  }
  const stale = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/result', resultBody());
  assert.equal(stale.status, 409);
});

test('repair: progress enforces session, account, Seller watermark, fence and active claim capacity', async () => {
  for (const mutation of [
    h => { h.state.collectorOzonEnrichmentJobs[0].accountId = 'other-account'; },
    h => { h.state.collectorOzonEnrichmentJobs[0].claimedSessionId = 'csess_other'; },
    h => { h.state.collectorOzonEnrichmentJobs[0].claimFence = 'new-fence'; },
    h => { h.state.collectorSessions[0].sellerContext = {...resultBody().captureContext, revision: 5}; },
    h => { h.state.collectorSessions[0].revokedAt = NOW.toISOString(); },
    h => {
      h.clock.value += 31_000;
      for (let i=0; i<4; i++) h.state.collectorOzonEnrichmentJobs.push({
        ...h.state.collectorOzonEnrichmentJobs[0], id: `busy-${i}`,
        claimExpiresAt: new Date(h.clock.value + 30_000).toISOString(),
      });
    },
  ]) {
    const h = await repairHarness(); mutation(h);
    const before = structuredClone(h.state);
    const response = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/progress', {
      claimFence: 'claim-fence-route', captureContext: resultBody().captureContext,
    });
    assert.ok([404, 409, 429].includes(response.status), String(response.status));
    assert.deepEqual(h.state, before);
  }
});

test('repair: public wait returns PENDING and same-request polling preserves the claim until its real result', async () => {
  const h = await repairHarness();
  const input = {requestId: 'repair-request', sku: '2102713588'};
  for (let i=0; i<2; i++) {
    const response = await request(h, 'POST', '/collector/ozon/enrich', input);
    assert.equal(response.status, 202);
    assert.equal(response.body.status, 'PENDING');
    assert.equal(response.body.ok, true);
    assert.equal(h.state.collectorOzonEnrichmentJobs.length, 1);
    assert.equal(h.state.collectorOzonEnrichmentJobs[0].claimFence, 'claim-fence-route');
    assert.equal(h.state.collectorOzonEnrichmentJobs[0].attemptCount, 0);
  }
  assert.deepEqual(h.audits, []);
  assert.equal((await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/result', resultBody())).status, 200);
  const result = await request(h, 'POST', '/collector/ozon/enrich', input);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, 'COMPLETE');
});

test('repair: batch wait returns 202 with pending SKUs alongside already completed results', async () => {
  const h = await repairHarness();
  await h.repository.writeCompleteCache({
    key: {accountId: SESSION.accountId, source: 'ozon', sku: '2102713769', contractVersion: 'collector.ozon.enrichment.v1'},
    result: result('2102713769'), responseHash: 'fixture', executorSessionId: SESSION.collectorSessionId,
    capturedAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000),
  });
  const response = await request(h, 'POST', '/collector/ozon/enrich/batch', {
    requestId: 'repair-request', skus: ['2102713588', '2102713769'],
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'PENDING');
  assert.deepEqual(response.body.data.map(row => row.status), ['PENDING', 'COMPLETE']);
  assert.equal(h.audits.some(event => event.status === 'FAILED'), false);
});

test('repair: message and diagnostic limits preserve useful text and redact escaped JSON credentials', async () => {
  const h = await repairHarness();
  const message = 'net::ERR_CONNECTION_RESET ' + JSON.stringify({password:'escaped"credential-tail'}) + ' ' + 'x'.repeat(1100);
  const response = await request(h, 'POST', '/collector/ozon/enrichment-jobs/job-route/fail', failBody({
    code:'NETWORK_ERROR', message, diagnostic:{...repairDiagnostic,stage:'s'.repeat(100),upstreamCode:'u'.repeat(100)},
  }));
  assert.equal(response.status, 200);
  const saved = h.state.collectorOzonEnrichmentJobs[0].error;
  assert.equal(saved.message.length, 1000);
  assert.match(saved.message, /^net::ERR_CONNECTION_RESET/);
  assert.equal(saved.diagnostic.stage.length, 80);
  assert.equal(saved.diagnostic.upstreamCode.length, 80);
  assert.equal(JSON.stringify([h.state,h.audits]).includes('credential-tail'), false);
});

test('repair: a batch uses one HTTP wait window even when it has more than four pending SKUs', async () => {
  const h = await repairHarness();
  h.state.collectorOzonEnrichmentJobs = [];
  const start = h.clock.value;
  const response = await request(h, 'POST', '/collector/ozon/enrich/batch', {
    requestId:'batch-wait',skus:['2102713588','2102713769','2102714396','2102714113','batch-fifth'],
  });
  assert.equal(response.status, 202);
  assert.deepEqual(response.body.data.map(item => item.status), ['PENDING','PENDING','PENDING','PENDING','PENDING']);
  assert.equal(h.clock.value - start, 20_000);
  assert.equal(h.audits.some(event => event.status === 'FAILED'), false);
});

test('repair: a concrete language failure also survives the public error-code allowlist', async () => {
  const h = await repairHarness();
  const message='SKU 2102713588 attribute 8229 contains Chinese product text';
  assert.equal((await request(h,'POST','/collector/ozon/enrichment-jobs/job-route/fail',failBody({
    code:'ZONGZI_PRODUCT_RUSSIAN_REQUIRED',message,
  }))).status,200);
  const response=await request(h,'POST','/collector/ozon/enrich',{requestId:'repair-request',sku:'2102713588'});
  assert.equal(response.status,422);
  assert.equal(response.body.code,'ZONGZI_PRODUCT_RUSSIAN_REQUIRED');
  assert.equal(response.body.message,message);
});

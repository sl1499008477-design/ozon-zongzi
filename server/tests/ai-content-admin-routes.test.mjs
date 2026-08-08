import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createAutoListingAiAdminHttpHandler } from "../auto-listing-ai-admin-routes.mjs";

const ADMIN = Object.freeze({ id: "account-admin", role: "admin", permissions: ["ai-content.manage"] });

function request(method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = {};
  return { req, url: new URL(pathname, "http://127.0.0.1") };
}

function response() {
  return {
    status: 0,
    payload: null,
    writeHead(status) { this.status = status; },
    end(value) { this.payload = value ? JSON.parse(String(value)) : null; },
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function harness({ actor = ADMIN, authError } = {}) {
  const calls = [];
  const service = new Proxy({}, {
    get(_target, method) {
      if (method === "then") return undefined;
      return async (input) => {
        calls.push({ method, input });
        if (method === "listGatewayProfiles") return [{ id: "profile-a", apiKeyEnvNameMasked: "SUB2…_KEY" }];
        if (method === "listStrategyVersions") return [{ id: "strategy-v1", rules: [{ ruleId: "rule-a" }] }];
        return { id: method === "createStrategyVersion" ? "strategy-v1" : "profile-a", ok: true };
      };
    },
  });
  const handler = createAutoListingAiAdminHttpHandler({
    authenticate: async () => {
      if (authError) throw authError;
      return actor;
    },
    getService: async () => service,
    readJson,
    sendJson(res, status, payload) {
      res.writeHead(status);
      res.end(JSON.stringify(payload));
    },
  });
  return { handler, calls };
}

async function call(harnessValue, method, pathname, body) {
  const { req, url } = request(method, pathname, body);
  const res = response();
  const handled = await harnessValue.handler(req, res, url);
  return { handled, status: res.status, body: res.payload };
}

test("ordinary users are rejected by the backend before admin service access", async () => {
  const h = harness({ actor: { id: "account-user", role: "user", permissions: ["tenant.operate"] } });
  const result = await call(h, "GET", "/admin/auto-listing/ai-profiles");
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "PERMISSION_FORBIDDEN");
  assert.equal(h.calls.length, 0);
});

test("profile routes pass only closed versioned references and return masked DTOs", async () => {
  const h = harness();
  const list = await call(h, "GET", "/admin/auto-listing/ai-profiles");
  assert.equal(list.status, 200);
  assert.equal(list.body.data[0].apiKeyEnvNameMasked, "SUB2…_KEY");

  const profile = {
    displayName: "主网关",
    baseUrl: "https://gateway.example/v1",
    apiKeyEnvName: "SUB2API_PRIMARY_KEY",
    textProtocol: "SUB2API_RESPONSES",
    imageProtocol: "SUB2API_OPENAI_IMAGES",
    textModel: "text-model",
    imageModel: "image-model",
  };
  const created = await call(h, "POST", "/admin/auto-listing/ai-profiles", {
    idempotencyKey: "create-profile-1", correlationId: "trace-1", profile,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(h.calls.at(-1), {
    method: "createGatewayProfile",
    input: { actor: ADMIN, idempotencyKey: "create-profile-1", correlationId: "trace-1", profile },
  });

  await call(h, "POST", "/admin/auto-listing/ai-profiles/profile-a/test", {
    configVersion: 1, correlationId: "test-attempt-1",
  });
  assert.deepEqual(h.calls.at(-1), {
    method: "testGatewayCapabilities",
    input: { actor: ADMIN, profileId: "profile-a", configVersion: 1, correlationId: "test-attempt-1" },
  });

  await call(h, "POST", "/admin/auto-listing/ai-profiles/profile-a/publish", {
    configVersion: 1, idempotencyKey: "publish-profile-1", correlationId: "trace-publish-1",
  });
  assert.equal(h.calls.at(-1).method, "publishGatewayProfile");
});

test("strategy routes preserve complete rules and immutable version references", async () => {
  const h = harness();
  const listed = await call(h, "GET", "/admin/auto-listing/strategies/versions?strategyKey=default");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data[0].rules, [{ ruleId: "rule-a" }]);
  assert.deepEqual(h.calls.at(-1), {
    method: "listStrategyVersions",
    input: { actor: ADMIN, strategyKey: "default" },
  });

  const rule = {
    ruleId: "rule-a", ruleOrder: 1, matchType: "PRODUCT_STYLE", productStyle: "fashion",
    style: "VISUAL_FIRST", textDensityByRole: { MAIN: "LOW" },
  };
  await call(h, "POST", "/admin/auto-listing/strategies/versions", {
    strategyKey: "default", version: 1, idempotencyKey: "strategy-create-1",
    correlationId: "trace-strategy-1", content: { schemaVersion: "V1" }, rules: [rule],
  });
  assert.equal(h.calls.at(-1).method, "createStrategyVersion");

  await call(h, "POST", "/admin/auto-listing/strategies/versions/strategy-v1/publish", {
    strategyKey: "default", version: 1, idempotencyKey: "strategy-publish-1", correlationId: "trace-strategy-2",
  });
  assert.deepEqual(h.calls.at(-1), {
    method: "publishStrategyVersion",
    input: {
      actor: ADMIN, strategyKey: "default", strategyVersionId: "strategy-v1", version: 1,
      idempotencyKey: "strategy-publish-1", correlationId: "trace-strategy-2",
    },
  });
});

test("raw secrets, extra keys, malformed IDs, and unsupported methods fail before service access", async () => {
  const h = harness();
  for (const [method, pathname, body, expectedStatus] of [
    ["POST", "/admin/auto-listing/ai-profiles", {
      idempotencyKey: "x", correlationId: "y", profile: {}, apiKey: "raw-secret",
    }, 400],
    ["POST", "/admin/auto-listing/ai-profiles/%2F/test", { configVersion: 1, correlationId: "x" }, 400],
    ["DELETE", "/admin/auto-listing/ai-profiles", undefined, 405],
    ["GET", "/admin/auto-listing/strategies/versions?strategyKey=a&extra=b", undefined, 400],
  ]) {
    const result = await call(h, method, pathname, body);
    assert.equal(result.status, expectedStatus);
  }
  assert.equal(h.calls.length, 0);
});

test("unknown failures and authentication errors expose only stable safe envelopes", async () => {
  const unauthenticated = harness({ authError: Object.assign(new Error("token raw"), { status: 401 }) });
  const login = await call(unauthenticated, "GET", "/admin/auto-listing/ai-profiles");
  assert.deepEqual(login.body, { ok: false, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录" });

  const h = harness();
  h.handler = createAutoListingAiAdminHttpHandler({
    authenticate: async () => ADMIN,
    getService: async () => ({ listGatewayProfiles: async () => { throw new Error("password=private"); } }),
    readJson,
    sendJson(res, status, payload) { res.writeHead(status); res.end(JSON.stringify(payload)); },
  });
  const failed = await call(h, "GET", "/admin/auto-listing/ai-profiles");
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, {
    ok: false, code: "AUTO_LISTING_AI_ADMIN_INTERNAL_ERROR", message: "AI 配置请求处理失败",
  });
  assert.doesNotMatch(JSON.stringify(failed.body), /password|private/i);
});

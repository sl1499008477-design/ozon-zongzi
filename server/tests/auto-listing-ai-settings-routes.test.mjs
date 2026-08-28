import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingAiSettingsHttpHandler } from "../auto-listing-ai-settings-routes.mjs";

const admin = Object.freeze({ id: "account-a", role: "admin" });

function harness({ actor = admin, service = null, readResult = {} } = {}) {
  const calls = [];
  const activeService = service ?? Object.freeze({
    async getOverview(input) { calls.push(["overview", input]); return { accountId: "account-a", actions: {} }; },
    async getCatalog(input) { calls.push(["catalog", input]); return { accountId: "account-a",
      catalog: { id: input.catalogId }, actions: { canCreateProfile: true } }; },
    async createConnection(input) { calls.push(["connection", input]); return { id: "connection-a", status: "PENDING" }; },
    async requestModelSync(input) { calls.push(["sync", input]); return { id: "sync-a", status: "PENDING" }; },
    async createProfileSelection(input) { calls.push(["selection", input]); return { id: "profile-a", enabled: false }; },
    async testProfile(input) { calls.push(["test", input]); return { profileId: input.profileId, outcome: "PASSED" }; },
    async publishProfile(input) { calls.push(["publish", input]); return { id: input.profileId, enabled: true }; },
    async rollbackProfile(input) { calls.push(["rollback", input]); return { id: input.profileId, enabled: true }; },
    async addProfileChannel(input) { calls.push(["add-channel", input]); return { channelId: "channel-b" }; },
    async setProfileChannelEnabled(input) { calls.push(["channel-status", input]); return { channelId: input.channelId, enabled: input.enabled }; },
  });
  const responses = [];
  const handler = createAutoListingAiSettingsHttpHandler({
    async authenticate(req) { calls.push(["authenticate", req]); if (actor instanceof Error) throw actor; return actor; },
    async getService() { calls.push(["service"]); return activeService; },
    async readJson(req, options) { calls.push(["read", req, options]); return readResult; },
    sendJson(_res, status, payload) { responses.push({ status, payload }); },
  });
  async function request(method, path) {
    const req = { method };
    const handled = await handler(req, {}, new URL(path, "http://localhost"));
    return { handled, response: responses.at(-1), req };
  }
  return { handler, request, calls, responses, service: activeService };
}

test("settings routes expose only the stable path and method allowlist", async () => {
  const cases = [
    ["GET", "/admin/auto-listing/ai-settings", "overview"],
    ["GET", "/admin/auto-listing/ai-settings/catalogs/catalog-a", "catalog"],
    ["POST", "/admin/auto-listing/ai-settings/connections", "connection"],
    ["POST", "/admin/auto-listing/ai-settings/connections/connection-a/sync", "sync"],
    ["POST", "/admin/auto-listing/ai-settings/profiles", "selection"],
    ["POST", "/admin/auto-listing/ai-settings/profiles/profile-a/test", "test"],
    ["POST", "/admin/auto-listing/ai-settings/profiles/profile-a/publish", "publish"],
    ["POST", "/admin/auto-listing/ai-settings/profiles/profile-a/rollback", "rollback"],
    ["POST", "/admin/auto-listing/ai-settings/profiles/profile-a/versions/1/channels", "add-channel"],
    ["POST", "/admin/auto-listing/ai-settings/profiles/profile-a/versions/1/channels/channel-b/status", "channel-status"],
  ];
  for (const [method, path, operation] of cases) {
    const readResult = operation === "connection" ? { idempotencyKey: "intent-a", correlationId: "corr-a",
      displayName: "Gateway", baseUrl: "http://127.0.0.1:8080/v1", gatewayKey: "raw-key" }
      : operation === "sync" ? { connectionVersion: 1, idempotencyKey: "sync-a", correlationId: "corr-a" }
        : operation === "selection" ? { connectionId: "connection-a", connectionVersion: 1, catalogId: "catalog-a",
          displayName: "Profile", textModel: "text-a", imageModel: "image-a", textProtocol: "SUB2API_RESPONSES",
          imageProtocol: "SUB2API_OPENAI_IMAGES", idempotencyKey: "profile-a", correlationId: "corr-a" }
          : operation === "test" ? { configVersion: 1, correlationId: "corr-a", costConfirmed: true }
            : operation === "publish" ? { configVersion: 1, idempotencyKey: "publish-a", correlationId: "corr-a" }
              : operation === "rollback" ? { configVersion: 1, idempotencyKey: "rollback-a",
                correlationId: "corr-a", costConfirmed: true }
                : operation === "add-channel" ? { connectionId: "connection-b", connectionVersion: 2, displayName: "Gateway B" }
                  : operation === "channel-status" ? { enabled: false } : {};
    const h = harness({ readResult });
    const { handled, response } = await h.request(method, path);
    assert.equal(handled, true);
    assert.equal(response.status, operation === "connection" || operation === "selection" ? 201 : 200);
    assert.equal(h.calls.some(([name]) => name === operation), true);
    const read = h.calls.find(([name]) => name === "read");
    if (method === "POST") assert.deepEqual(read[2], { maxBytes: 64 * 1024, requireBody: true });
    else assert.equal(read, undefined);
  }

  const h = harness();
  const unknown = await h.request("GET", "/admin/auto-listing/ai-settings/unknown");
  assert.equal(unknown.handled, true);
  assert.equal(unknown.response.status, 400);
  const rejected = await h.request("DELETE", "/admin/auto-listing/ai-settings");
  assert.equal(rejected.response.status, 405);
  assert.equal(rejected.response.payload.code, "AUTO_LISTING_AI_SETTINGS_METHOD_NOT_ALLOWED");
  assert.equal(h.calls.some(([name]) => name === "authenticate"), false);
});

test("overview forwards the server-owned ACTIVE successor actions without route-side guessing", async () => {
  const actions = {
    canCreateConnection: true,
    syncableConnectionIds: ["connection-active"],
    profileCreatableCatalogIds: ["catalog-latest"],
    testableProfileIds: ["profile-successor"],
    publishableProfileIds: [],
    rollbackProfileIds: [],
  };
  const h = harness({ service: {
    ...harness().service,
    async getOverview(input) {
      h.calls.push(["overview", input]);
      return { accountId: "account-a", actions };
    },
  } });
  const { response } = await h.request("GET", "/admin/auto-listing/ai-settings");
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload.data.actions, actions);
});

test("ACTIVE manual catalog sync preserves the exact client fence when delegated", async () => {
  const h = harness({ readResult: {
    connectionVersion: 1,
    idempotencyKey: "sync-active",
    correlationId: "corr-active",
  } });
  const { response } = await h.request(
    "POST",
    "/admin/auto-listing/ai-settings/connections/connection-active/sync",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls.find(([name]) => name === "sync")?.[1], {
    actor: admin,
    connectionId: "connection-active",
    connectionVersion: 1,
    idempotencyKey: "sync-active",
    correlationId: "corr-active",
  });
});

test("profile test route preserves the backend refusal for an already-enabled target", async () => {
  const error = Object.assign(new Error("already enabled"), {
    code: "AI_GATEWAY_PROFILE_VERSION_CONFLICT",
    status: 409,
  });
  const h = harness({
    readResult: { configVersion: 1, correlationId: "corr-enabled", costConfirmed: true },
    service: {
      ...harness().service,
      async testProfile(input) {
        h.calls.push(["test", input]);
        throw error;
      },
    },
  });

  const { response } = await h.request(
    "POST",
    "/admin/auto-listing/ai-settings/profiles/profile-enabled/test",
  );

  assert.equal(response.status, 409);
  assert.equal(response.payload.code, "AI_GATEWAY_PROFILE_VERSION_CONFLICT");
  assert.equal(h.calls.filter(([name]) => name === "test").length, 1);
});

test("authentication and backend permission are checked before service or body access", async () => {
  for (const actor of [
    Object.assign(new Error("not logged in"), { status: 401 }),
    Object.freeze({ id: "account-a", role: "user" }),
  ]) {
    const h = harness({ actor, readResult: { gatewayKey: "must-not-be-read" } });
    const { response } = await h.request("POST", "/admin/auto-listing/ai-settings/connections");
    assert.equal(response.status, actor instanceof Error ? 401 : 403);
    assert.equal(h.calls.some(([name]) => name === "service" || name === "read"), false);
  }
});

test("closed bodies reject unknown fields, accessors, proxies, and oversized JSON failures", async () => {
  const valid = { connectionVersion: 1, idempotencyKey: "sync-a", correlationId: "corr-a" };
  const accessor = {};
  Object.defineProperties(accessor, {
    connectionVersion: { enumerable: true, value: 1 },
    idempotencyKey: { enumerable: true, get: () => "sync-a" },
    correlationId: { enumerable: true, value: "corr-a" },
  });
  const hostile = new Proxy(valid, { ownKeys() { throw new Error("proxy trap"); } });
  for (const readResult of [{ ...valid, extra: true }, accessor, hostile]) {
    const h = harness({ readResult });
    const { response } = await h.request("POST", "/admin/auto-listing/ai-settings/connections/connection-a/sync");
    assert.equal(response.status, 400);
    assert.equal(response.payload.code, "AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
    assert.equal(h.calls.some(([name]) => name === "sync"), false);
  }
  const h = harness();
  h.handler;
  const oversized = createAutoListingAiSettingsHttpHandler({
    authenticate: async () => admin,
    getService: async () => h.service,
    readJson: async (_req, options) => {
      assert.deepEqual(options, { maxBytes: 64 * 1024, requireBody: true });
      throw Object.assign(new Error("body too large contains raw-key"), { code: "BODY_TOO_LARGE" });
    },
    sendJson(_res, status, payload) { h.responses.push({ status, payload }); },
  });
  await oversized({ method: "POST" }, {}, new URL("http://localhost/admin/auto-listing/ai-settings/connections"));
  assert.equal(h.responses.at(-1).status, 400);
  assert.equal(JSON.stringify(h.responses.at(-1)).includes("raw-key"), false);
});

test("query strings and encoded path separators fail closed", async () => {
  for (const path of [
    "/admin/auto-listing/ai-settings?debug=1",
    "/admin/auto-listing/ai-settings/profiles/profile%2Fa/test",
    "/admin/auto-listing/ai-settings/connections/%2e%2e/sync",
  ]) {
    const h = harness();
    const { handled, response } = await h.request("GET", path);
    assert.equal(handled, true);
    assert.equal(response.status, 400);
  }
});

test("responses reject secret-bearing or accessor output and expose only fixed safe error codes", async () => {
  for (const leaked of [
    { id: "connection-a", gatewayKey: "raw-key" },
    { id: "connection-a", ciphertext: "encrypted-but-secret" },
    Object.defineProperty({}, "id", { enumerable: true, get: () => "connection-a" }),
  ]) {
    const h = harness({ service: { ...harness().service, async getOverview() { return leaked; } } });
    const { response } = await h.request("GET", "/admin/auto-listing/ai-settings");
    assert.equal(response.status, 500);
    assert.equal(response.payload.code, "AUTO_LISTING_AI_SETTINGS_INTERNAL_ERROR");
    assert.equal(JSON.stringify(response).includes("raw-key"), false);
    assert.equal(JSON.stringify(response).includes("encrypted-but-secret"), false);
  }

  for (const error of [
    Object.assign(new Error("unsafe URL"), { code: "AUTO_LISTING_AI_SETTINGS_BASE_URL_INVALID", status: 422 }),
    Object.assign(new Error("safe"), { code: "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_FOUND", status: 404 }),
    Object.assign(new Error("expected state"), { code: "AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED", status: 409 }),
    Object.assign(new Error("paid subcall active"), { code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", status: 409 }),
    Object.assign(new Error("settings transition blocked by paid subcall"), { code: "AUTO_LISTING_AI_SETTINGS_CAPABILITY_SUBCALL_CONFLICT", status: 409 }),
    Object.assign(new Error("legacy paid state unknown"), { code: "AUTO_LISTING_AI_ADMIN_LEGACY_CAPABILITY_QUARANTINED", status: 409 }),
    Object.assign(new Error("confirmed cost required"), { code: "AI_GATEWAY_COST_CONFIRMATION_REQUIRED", status: 409 }),
    Object.assign(new Error("provider acceptance unknown"), { code: "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", status: 409 }),
    Object.assign(new Error("database unavailable"), { code: "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED", status: 503 }),
    Object.assign(new Error("password=prod-secret"), { code: "ECONNRESET", status: 418 }),
  ]) {
    const h = harness({ service: { ...harness().service, async getOverview() { throw error; } } });
    const { response } = await h.request("GET", "/admin/auto-listing/ai-settings");
    assert.equal(response.payload.code, error.code.startsWith("AUTO_LISTING_AI_SETTINGS_")
      || ["AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED", "AI_GATEWAY_COST_CONFIRMATION_REQUIRED",
        "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN",
        "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED", "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT",
        "AUTO_LISTING_AI_SETTINGS_CAPABILITY_SUBCALL_CONFLICT",
        "AUTO_LISTING_AI_ADMIN_LEGACY_CAPABILITY_QUARANTINED"].includes(error.code)
      ? error.code : "AUTO_LISTING_AI_SETTINGS_INTERNAL_ERROR");
    assert.equal(JSON.stringify(response).includes("prod-secret"), false);
  }
});

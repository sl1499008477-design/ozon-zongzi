import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_SETTINGS_SAFE_ERROR_CODES,
  createAiSettingsIntentStore,
  createGatewayConnection,
  createModelProfile,
  loadAiSettings,
  pollAiSettingsUntil,
  publishModelProfile,
  requestModelSync,
  rollbackModelProfile,
  testModelProfile,
} from "../src/auto-listing-ai-settings-client.js";
import { AUTO_LISTING_AI_SETTINGS_SAFE_CODES } from "../../server/auto-listing-ai-settings-routes.mjs";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key), dump: () => Object.fromEntries(values) };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify({ ok: true, data }) };
}

function connection(overrides = {}) {
  return { id: "connection-a", accountId: "account-a", version: 1, displayName: "本地 sub2API",
    baseUrl: "http://127.0.0.1:8080/v1", fingerprint: "fingerprint-a", keyVersion: "local-v1",
    status: "PENDING", statusVersion: 1, validationResult: null, validatedAt: null, activatedAt: null,
    retiredAt: null, createdAt: "2026-08-08T00:00:00.000Z", duplicate: false, ...overrides };
}

function syncTask(overrides = {}) {
  return { id: "sync-a", accountId: "account-a", connectionId: "connection-a", connectionVersion: 1,
    syncPurpose: "CATALOG_SYNC", targetConnectionStatusVersion: 1, status: "PENDING", statusVersion: 1,
    attemptCount: 0, maxAttempts: 5, leaseVersion: 0, availableAt: null, completedAt: null, lastErrorCode: null,
    lastErrorSafe: null, createdAt: "2026-08-08T00:00:00.000Z", duplicate: false, ...overrides };
}

function profile(overrides = {}) {
  return { id: "profile-a", accountId: "account-a", displayName: "商品图模型", configVersion: 1,
    baseUrl: "http://127.0.0.1:8080/v1", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
    textModel: "text-a", imageModel: "image-a", enabled: false, capabilityResult: {}, capabilityCheckedAt: null,
    connectionId: "connection-a", connectionVersion: 1, createdAt: "2026-08-08T00:00:00.000Z", duplicate: false, ...overrides };
}

function capability(overrides = {}) {
  return { profileId: "profile-a", configVersion: 1, outcome: "PASSED",
    features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 123,
    models: { text: "text-a", image: "image-a" }, checkedAt: "2026-08-08T00:00:00.000Z",
    errorCode: null, enabled: false, ...overrides };
}

function installTransport(t, handler) {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalLocalStorage; globalThis.sessionStorage = originalSessionStorage; });
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  globalThis.fetch = handler;
}

test("connection intent is reused across timeout retry and cleared only after confirmed success", async (t) => {
  const storage = memoryStorage();
  const intents = createAiSettingsIntentStore(storage);
  const first = intents.connectionIntent({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1" });
  const second = intents.connectionIntent({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1" });
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.doesNotMatch(JSON.stringify(storage.dump()), /gateway-secret/);
  let attempt = 0;
  installTransport(t, async () => {
    attempt += 1;
    if (attempt === 1) throw Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" });
    return response(connection());
  });
  const keyInput = { value: "gateway-secret" };
  await assert.rejects(createGatewayConnection({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1", gatewayKey: keyInput.value, gatewayKeyInput: keyInput }, first), { code: "REQUEST_TIMEOUT" });
  assert.equal(keyInput.value, "gateway-secret");
  assert.equal(intents.connectionIntent({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1" }).idempotencyKey, first.idempotencyKey);
  await createGatewayConnection({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1", gatewayKey: keyInput.value, gatewayKeyInput: keyInput }, second);
  assert.equal(keyInput.value, "");
  assert.equal(JSON.stringify(storage.dump()).includes("gateway-secret"), false);
  assert.notEqual(intents.connectionIntent({ displayName: "本地 sub2API", baseUrl: "http://127.0.0.1:8080/v1" }).idempotencyKey, first.idempotencyKey);
});

test("client sends only the exact Task 7 paths and closed DTO bodies", async (t) => {
  const calls = [];
  installTransport(t, async (url, options) => {
    calls.push({ url, options }); const path = new URL(url, "http://localhost").pathname;
    if (path.endsWith("/connections")) return response(connection());
    if (path.endsWith("/sync")) return response(syncTask());
    if (path.endsWith("/profiles/profile-a/test")) return response(capability());
    return response(profile({ enabled: path.endsWith("/publish") || path.endsWith("/rollback") }));
  });
  const intent = Object.freeze({ idempotencyKey: "intent-a", correlationId: "corr-a" });
  await createGatewayConnection({ displayName: "Gateway", baseUrl: "https://gateway.example/v1", gatewayKey: "gateway-secret" }, intent);
  await requestModelSync({ connectionId: "connection-a", connectionVersion: 1 }, intent);
  await createModelProfile({ connectionId: "connection-a", connectionVersion: 1, catalogId: "catalog-a", displayName: "Profile", textModel: "text-a", imageModel: "image-a", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES" }, intent);
  await testModelProfile({ profileId: "profile-a", configVersion: 1, correlationId: "corr-test", costConfirmed: true });
  await publishModelProfile({ profileId: "profile-a", configVersion: 1 }, intent);
  await rollbackModelProfile({ profileId: "profile-a", configVersion: 1, costConfirmed: true }, intent);
  assert.deepEqual(calls.map(({ url, options }) => [new URL(url, "http://localhost").pathname, options.method, JSON.parse(options.body)]), [
    ["/api/admin/auto-listing/ai-settings/connections", "POST", { idempotencyKey: "intent-a", correlationId: "corr-a", displayName: "Gateway", baseUrl: "https://gateway.example/v1", gatewayKey: "gateway-secret" }],
    ["/api/admin/auto-listing/ai-settings/connections/connection-a/sync", "POST", { connectionVersion: 1, idempotencyKey: "intent-a", correlationId: "corr-a" }],
    ["/api/admin/auto-listing/ai-settings/profiles", "POST", { connectionId: "connection-a", connectionVersion: 1, catalogId: "catalog-a", displayName: "Profile", textModel: "text-a", imageModel: "image-a", textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES", idempotencyKey: "intent-a", correlationId: "corr-a" }],
    ["/api/admin/auto-listing/ai-settings/profiles/profile-a/test", "POST", { configVersion: 1, correlationId: "corr-test", costConfirmed: true }],
    ["/api/admin/auto-listing/ai-settings/profiles/profile-a/publish", "POST", { configVersion: 1, idempotencyKey: "intent-a", correlationId: "corr-a" }],
    ["/api/admin/auto-listing/ai-settings/profiles/profile-a/rollback", "POST", { configVersion: 1, idempotencyKey: "intent-a", correlationId: "corr-a", costConfirmed: true }],
  ]);
  assert.ok(calls.every(({ options }) => options.headers["X-Client-Ai-Settings"] === "1"));
});

test("abort, 64 KiB body limits, accessors, proxies, secret or oversized responses fail closed", async (t) => {
  let calls = 0;
  installTransport(t, async () => { calls += 1; return response(connection()); });
  const controller = new AbortController(); controller.abort("cancelled");
  await assert.rejects(requestModelSync({ connectionId: "connection-a", connectionVersion: 1 }, { idempotencyKey: "sync-a", correlationId: "corr-a", signal: controller.signal }), { code: "REQUEST_ABORTED" });
  await assert.rejects(createGatewayConnection({ displayName: "a".repeat(70_000), baseUrl: "https://gateway.example/v1", gatewayKey: "gateway-secret" }, { idempotencyKey: "intent-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
  const accessor = { connectionId: "connection-a" };
  Object.defineProperty(accessor, "connectionVersion", { enumerable: true, get: () => 1 });
  await assert.rejects(requestModelSync(accessor, { idempotencyKey: "sync-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
  const hostile = new Proxy({ connectionId: "connection-a", connectionVersion: 1 }, { ownKeys() { throw new Error("trap"); } });
  await assert.rejects(requestModelSync(hostile, { idempotencyKey: "sync-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
  assert.equal(calls, 0);
  globalThis.fetch = async () => response({ ...connection(), ciphertext: "encrypted-secret" });
  await assert.rejects(createGatewayConnection({ displayName: "Gateway", baseUrl: "https://gateway.example/v1", gatewayKey: "gateway-secret" }, { idempotencyKey: "intent-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
  globalThis.fetch = async () => response({ ...connection(), validationResult: { payload: "x".repeat(70_000) } });
  await assert.rejects(createGatewayConnection({ displayName: "Gateway", baseUrl: "https://gateway.example/v1", gatewayKey: "gateway-secret" }, { idempotencyKey: "intent-a", correlationId: "corr-a" }), { code: "RESPONSE_TOO_LARGE" });
});

test("overview and polling only accept known terminal states and never promote unknown work", async (t) => {
  const base = { accountId: "account-a", activeConnection: null, connections: [], catalogs: [], profiles: [], actions: { canCreateConnection: true, syncableConnectionIds: [], testableProfileIds: [], publishableProfileIds: [], rollbackProfileIds: [] } };
  let reads = 0;
  installTransport(t, async () => { reads += 1; return response({ ...base, syncTasks: [syncTask({ status: reads === 1 ? "LEASED" : "SUCCEEDED" })] }); });
  assert.equal((await loadAiSettings()).syncTasks[0].status, "LEASED");
  assert.equal((await pollAiSettingsUntil((value) => value.syncTasks[0]?.status === "SUCCEEDED", { timeoutMs: 1_000 })).syncTasks[0].status, "SUCCEEDED");
  globalThis.fetch = async () => response({ ...base, syncTasks: [syncTask({ status: "MAGIC_DONE" })] });
  await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
});

test("Task 7 sync status is closed to PENDING LEASED SUCCEEDED FAILED DEAD", async (t) => {
  const base = { accountId: "account-a", activeConnection: null, connections: [], catalogs: [], profiles: [], actions: { canCreateConnection: true, syncableConnectionIds: [], testableProfileIds: [], publishableProfileIds: [], rollbackProfileIds: [] } };
  installTransport(t, async () => response({ ...base, syncTasks: [syncTask({ status: "LEASED" })] }));
  assert.equal((await loadAiSettings()).syncTasks[0].status, "LEASED");
  globalThis.fetch = async () => response({ ...base, syncTasks: [syncTask({ status: "RUNNING" })] });
  await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
});

test("public paid test is a one-argument closed command and client exposes no remote error text", async (t) => {
  installTransport(t, async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ code: "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED", message: "db password=secret" }) }));
  await assert.rejects(testModelProfile({ profileId: "profile-a", configVersion: 1, correlationId: "corr-a", costConfirmed: true }),
    (error) => error.code === "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED" && error.message === "AI 模型设置暂时不可用");
  await assert.rejects(testModelProfile({ profileId: "profile-a", configVersion: 1, correlationId: "corr-a", costConfirmed: true, extra: true }),
    { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
});

test("paid test has a default bounded timeout and poll cannot succeed after its deadline", async (t) => {
  let observedSignal = null;
  installTransport(t, async (_url, options) => { observedSignal = options.signal; return response(capability()); });
  await testModelProfile({ profileId: "profile-a", configVersion: 1, correlationId: "corr-timeout", costConfirmed: true });
  assert.ok(observedSignal instanceof AbortSignal);
  await assert.rejects(pollAiSettingsUntil(() => true, { timeoutMs: 1 }), (error) => ["AI_SETTINGS_CLIENT_POLL_TIMEOUT", "REQUEST_TIMEOUT", "AI_SETTINGS_CLIENT_RESPONSE_INVALID"].includes(error.code));
});

test("frontend safe error contract stays in parity with Task 7 routes", () => {
  for (const code of AUTO_LISTING_AI_SETTINGS_SAFE_CODES) assert.ok(AI_SETTINGS_SAFE_ERROR_CODES.includes(code), code);
});

test("paid-test command intent persists and reuses its correlation identity", async (t) => {
  const storage = memoryStorage(); const intents = createAiSettingsIntentStore(storage);
  const intent = intents.commandIntent({ operation: "test", targetId: "profile-a" });
  installTransport(t, async () => response(capability()));
  await testModelProfile({ profileId: "profile-a", configVersion: 1, costConfirmed: true }, intent);
  assert.equal(storage.getItem("ozon-ai-settings:connection:test:profile-a"), null);
});

test("paid-test response loss preserves the stored intent and retries the same correlation", async (t) => {
  const storage = memoryStorage(); const intents = createAiSettingsIntentStore(storage);
  const intent = intents.commandIntent({ operation: "test", targetId: "profile-a" });
  const sent = []; let call = 0;
  installTransport(t, async (_url, options) => { sent.push(JSON.parse(options.body)); call += 1; if (call === 1) throw Object.assign(new Error("lost"), { code: "REQUEST_TIMEOUT" }); return response(capability()); });
  await assert.rejects(testModelProfile({ profileId: "profile-a", configVersion: 1, costConfirmed: true }, intent), { code: "REQUEST_TIMEOUT" });
  assert.notEqual(storage.getItem("ozon-ai-settings:connection:test:profile-a"), null);
  await testModelProfile({ profileId: "profile-a", configVersion: 1, costConfirmed: true }, intent);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(storage.getItem("ozon-ai-settings:connection:test:profile-a"), null);
});

test("Task 7 entity IDs reject whitespace and traversal while model IDs stay independent", async () => {
  await assert.rejects(requestModelSync({ connectionId: " connection-a", connectionVersion: 1 }, { idempotencyKey: "sync-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
  await assert.rejects(requestModelSync({ connectionId: "connection..a", connectionVersion: 1 }, { idempotencyKey: "sync-a", correlationId: "corr-a" }), { code: "AI_SETTINGS_CLIENT_REQUEST_INVALID" });
});

test("overview rejects duplicate entity IDs and malformed nested validation evidence", async (t) => {
  const base = { accountId: "account-a", activeConnection: null, catalogs: [], syncTasks: [], profiles: [], actions: { canCreateConnection: true, syncableConnectionIds: [], testableProfileIds: [], publishableProfileIds: [], rollbackProfileIds: [] } };
  installTransport(t, async () => response({ ...base, connections: [connection(), connection()] }));
  await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
});

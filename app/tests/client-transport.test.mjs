import assert from "node:assert/strict";
import test from "node:test";
import { apiRequest, apiResponseError } from "../src/client-transport.js";

test("HTTP request errors retain status, code, and response body for definitive handling", () => {
  const body = {
    message: "目标经营店铺已停用",
    code: "TARGET_STORE_DISABLED",
  };
  const error = apiResponseError({ status: 409 }, body);

  assert.equal(error.message, "目标经营店铺已停用");
  assert.equal(error.status, 409);
  assert.equal(error.code, "TARGET_STORE_DISABLED");
  assert.equal(error.body, body);
});

test("pre-serialized Excel JSON is sent once with auth and without rewriting its base64 body", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  });
  globalThis.localStorage = { getItem: (key) => key === "token" ? "session-token" : null };
  const serializedBody = JSON.stringify({ name: "skus.xlsx", dataBase64: "AAECAw==" });
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 201, text: async () => '{"ok":true}' };
  };

  const result = await apiRequest("/auto-listing/imports/excel", {
    method: "POST",
    serializedBody,
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(captured.options.body, serializedBody);
  assert.equal(captured.options.headers.Authorization, "Bearer session-token");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.ok(captured.options.signal instanceof AbortSignal);
});

test("request rejects conflicting body modes before fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  });
  let calls = 0;
  globalThis.localStorage = { getItem: () => "" };
  globalThis.fetch = async () => { calls += 1; };

  await assert.rejects(apiRequest("/x", { body: {}, serializedBody: "{}" }), {
    code: "CLIENT_REQUEST_INVALID",
  });
  assert.equal(calls, 0);
});

test("configured Excel transport limit permits a service-approved body larger than the legacy 8 MB cap", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; });
  globalThis.localStorage = { getItem: () => "" };
  const serializedBody = "x".repeat(8_388_609);
  let sent = 0;
  globalThis.fetch = async (_url, options) => {
    sent = options.body.length;
    return { ok: true, status: 200, text: async () => "{}" };
  };
  await apiRequest("/auto-listing/imports/excel", {
    method: "POST", serializedBody, maxSerializedBodyBytes: 9_000_000,
  });
  assert.equal(sent, serializedBody.length);
});

test("existing callers keep their prior unbounded transport unless they explicitly request a timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  });
  globalThis.localStorage = { getItem: () => "" };
  let signal;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 200, text: async () => "{}" };
  };

  await apiRequest("/existing-long-running-sync");
  assert.equal(signal, undefined);
});

test("invalid JSON and timeout failures use stable client codes", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  });
  globalThis.localStorage = { getItem: () => "" };
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "not-json" });
  await assert.rejects(apiRequest("/invalid-json"), { code: "INVALID_JSON_RESPONSE" });

  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
  await assert.rejects(apiRequest("/timeout", { timeoutMs: 10 }), { code: "REQUEST_TIMEOUT" });
});

test("response streams are cancelled once the explicit byte limit is exceeded", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let cancelled = false;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => ({ ok: true, status: 200, body: new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode("x".repeat(32))); },
    cancel() { cancelled = true; },
  }) });
  await assert.rejects(apiRequest("/bounded", { maxResponseBytes: 16 }), { code: "RESPONSE_TOO_LARGE" });
  assert.equal(cancelled, true);
});

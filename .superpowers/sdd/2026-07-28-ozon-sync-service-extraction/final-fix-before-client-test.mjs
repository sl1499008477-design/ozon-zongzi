import assert from "node:assert/strict";
import { callOzonSellerApi, getOzonSellerApi } from "../ozon-client.mjs";

const originalFetch = globalThis.fetch;
const store = { clientId: "client-1", apiKey: "secret-1" };

try {
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, text: async () => '{"result":{"ok":true}}' };
  };
  assert.deepEqual(await callOzonSellerApi(store, "/v1/post", { value: 1 }), { result: { ok: true } });
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Client-Id"], "client-1");
  assert.equal(captured.options.headers["Api-Key"], "secret-1");
  assert.equal(captured.options.body, '{"value":1}');

  await getOzonSellerApi(store, "/v1/get");
  assert.equal(captured.options.method, "GET");
  assert.equal("body" in captured.options, false);
  assert.equal("Content-Type" in captured.options.headers, false);

  await assert.rejects(
    () => callOzonSellerApi({}, "/v1/post", {}),
    (error) => error.status === 400 && error.code === "OZON_CREDENTIALS_MISSING",
  );

  globalThis.fetch = async () => {
    throw Object.assign(new Error("offline"), { code: "ENETDOWN" });
  };
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/get"),
    (error) => error.status === 502 && error.code === "ENETDOWN" && error.body.network === true,
  );

  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => "rate limited",
  });
  await assert.rejects(
    () => callOzonSellerApi(store, "/v1/post", {}),
    (error) => error.status === 429 && error.code === "OZON_HTTP_429" && error.body.raw === "rate limited",
  );

  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/get", 5),
    (error) => error.status === 504 && error.code === "OZON_TIMEOUT",
  );

  globalThis.fetch = async () => {
    throw new DOMException("aborted", "AbortError");
  };
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/get"),
    (error) => error.status === 504 && error.code === "OZON_TIMEOUT",
  );

  globalThis.fetch = async () => {
    const cause = Object.assign(new Error("network failed for client-1 secret-1"), { code: "ENETDOWN" });
    throw Object.assign(new Error("request failed for client-1 secret-1"), { code: "ENETDOWN", cause });
  };
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/get"),
    (error) => {
      const serializedBody = JSON.stringify(error.body);
      return !error.message.includes("client-1") &&
        !error.message.includes("secret-1") &&
        !serializedBody.includes("client-1") &&
        !serializedBody.includes("secret-1") &&
        !error.cause?.message.includes("client-1") &&
        !error.cause?.message.includes("secret-1");
    },
  );

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw new Error("body unavailable");
    },
  });
  await assert.rejects(
    () => callOzonSellerApi(store, "/v1/post", {}),
    (error) => error.status === 502 && error.body.phase === "读取响应",
  );

  console.log("ozon client tests passed");
} finally {
  globalThis.fetch = originalFetch;
}

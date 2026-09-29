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
  assert.equal(captured.url, `${process.env.OZON_API_BASE || "https://api-seller.ozon.ru"}/v1/post`);
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Client-Id"], "client-1");
  assert.equal(captured.options.headers["Api-Key"], "secret-1");
  assert.equal(captured.options.body, '{"value":1}');

  const externalAbort = new AbortController();
  let transportSignal;
  globalThis.fetch = async (_url, options) => {
    transportSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  const externallyAborted = callOzonSellerApi(
    store, "/v1/external-abort", {}, 50, { signal: externalAbort.signal },
  );
  externallyAborted.catch(() => {});
  externalAbort.abort();
  assert.equal(transportSignal.aborted, true);
  await assert.rejects(externallyAborted, (error) => error.code === "ZONGZI_TIMEOUT");

  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, text: async () => '{"result":{"ok":true}}' };
  };

  await getOzonSellerApi(store, "/v1/get");
  assert.equal(captured.url, `${process.env.OZON_API_BASE || "https://api-seller.ozon.ru"}/v1/get`);
  assert.equal(captured.options.method, "GET");
  assert.equal("body" in captured.options, false);
  assert.equal("Content-Type" in captured.options.headers, false);

  await assert.rejects(
    () => callOzonSellerApi({}, "/v1/post", {}),
    (error) => error.status === 400 && error.code === "ZONGZI_CREDENTIALS_MISSING",
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
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, "ZONGZI_HTTP_429");
      assert.equal(
        error.message,
        "Ozon 429: /v1/post (ZONGZI_HTTP_429)",
      );
      assert.deepEqual(error.body, {
        apiPath: "/v1/post",
        status: 429,
        code: "ZONGZI_HTTP_429",
        responseFormat: "text",
      });
      assert.equal(error.cause, null);
      return true;
    },
  );

  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({
      code: "NOT_FOUND",
      message: `missing ${store.clientId} ${store.apiKey}`,
    }),
  });
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/product/import/info"),
    (error) => {
      assert.equal(error.message, "Ozon 404: /v1/product/import/info (ZONGZI_HTTP_404)");
      assert.equal(error.code, "ZONGZI_HTTP_404");
      assert.equal(error.message.includes(store.clientId), false);
      assert.equal(error.message.includes(store.apiKey), false);
      assert.equal(JSON.stringify(error.body).includes(store.clientId), false);
      assert.equal(JSON.stringify(error.body).includes(store.apiKey), false);
      return true;
    },
  );

  const sensitiveHttpValues = [
    store.clientId,
    store.apiKey,
    "operator@example.com",
    "nested-sensitive-value",
  ];
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({
      code: "ACCESS.DENIED-1",
      message: `denied ${store.clientId} ${store.apiKey} operator@example.com`,
      details: {
        email: "operator@example.com",
        nested: "nested-sensitive-value",
      },
    }),
  });
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/sensitive"),
    (error) => {
      assert.equal(
        error.message,
        "Ozon 403: /v1/sensitive (ZONGZI_HTTP_403)",
      );
      assert.deepEqual(error.body, {
        apiPath: "/v1/sensitive",
        status: 403,
        code: "ZONGZI_HTTP_403",
        responseFormat: "json",
        ozonCode: "ACCESS.DENIED-1",
      });
      assert.deepEqual(
        Object.keys(error.body).sort(),
        ["apiPath", "code", "ozonCode", "responseFormat", "status"],
      );
      assert.equal(error.cause, null);
      const exposed = JSON.stringify({
        message: error.message,
        body: error.body,
        cause: error.cause,
      });
      for (const value of sensitiveHttpValues) {
        assert.equal(exposed.includes(value), false);
      }
      return true;
    },
  );

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ code: store.apiKey }),
  });
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/credential-code"),
    (error) => {
      assert.deepEqual(error.body, {
        apiPath: "/v1/credential-code",
        status: 401,
        code: "ZONGZI_HTTP_401",
        responseFormat: "json",
      });
      assert.equal(JSON.stringify(error.body).includes(store.apiKey), false);
      return true;
    },
  );

  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/get", 5),
    (error) => error.status === 504 && error.code === "ZONGZI_TIMEOUT",
  );

  globalThis.fetch = async () => {
    throw new DOMException("aborted", "AbortError");
  };
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/get"),
    (error) => error.status === 504 && error.code === "ZONGZI_TIMEOUT",
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

  {
    let cancelled = 0;
    let signal;
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "9" }),
        body: { async cancel() { cancelled += 1; } },
        text: async () => { throw new Error("bounded reader must reject before text"); },
      };
    };
    await assert.rejects(
      () => callOzonSellerApi(store, "/v2/bounded-content-length", {}, 1_000, { maxResponseBytes: 8 }),
      (error) => error.status === 502 && error.code === "ZONGZI_RESPONSE_TOO_LARGE"
        && error.body.phase === "读取响应",
    );
    assert.equal(cancelled, 1);
    assert.equal(signal.aborted, true);
  }

  {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"a":'), encoder.encode('"123456789"}'), encoder.encode("never-read")];
    let pulls = 0;
    let cancelled = 0;
    let signal;
    const body = new ReadableStream({
      pull(controller) {
        const chunk = chunks[pulls];
        pulls += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 });
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body,
        text: async () => { throw new Error("bounded reader must stream"); },
      };
    };
    await assert.rejects(
      () => callOzonSellerApi(store, "/v2/bounded-stream", {}, 1_000, { maxResponseBytes: 8 }),
      (error) => error.status === 502 && error.code === "ZONGZI_RESPONSE_TOO_LARGE"
        && error.body.phase === "读取响应",
    );
    assert.equal(pulls, 2);
    assert.equal(cancelled, 1);
    assert.equal(signal.aborted, true);
  }

  {
    let reads = 0;
    let released = 0;
    globalThis.fetch = async (_url, { signal }) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader() {
          return {
            read() {
              reads += 1;
              return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
              });
            },
            releaseLock() { released += 1; },
          };
        },
      },
    });
    await assert.rejects(
      () => callOzonSellerApi(store, "/v2/bounded-body-timeout", {}, 5, { maxResponseBytes: 8 }),
      (error) => error.status === 504 && error.code === "ZONGZI_TIMEOUT",
    );
    assert.deepEqual({ reads, released }, { reads: 1, released: 1 });
  }

  console.log("ozon client tests passed");
} finally {
  globalThis.fetch = originalFetch;
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  createSub2ApiAdapter,
  SUB2API_IMAGE_PROTOCOLS,
  SUB2API_TEXT_PROTOCOLS,
} from "../sub2api-ai-adapter.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const secret = "gateway-secret-value";
const profile = Object.freeze({
  id: "profile-1",
  accountId: "account-a",
  configVersion: 7,
  baseUrl: "https://gateway.example.test/tenant/v1",
  apiKeyEnvName: "SUB2API_ACCOUNT_A_KEY",
  textProtocol: "SUB2API_RESPONSES",
  imageProtocol: "SUB2API_RESPONSES_IMAGE_TOOL",
  textModel: "gpt-text",
  imageModel: "gpt-image",
  enabled: true,
});

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  headers: { "content-type": "application/json", ...(init.headers || {}) },
});

function adapter(fetchImpl, { logs = [], readSecret = () => secret } = {}) {
  return createSub2ApiAdapter({
    fetchImpl,
    readSecret,
    logger: {
      info(event, fields) { logs.push(["info", event, fields]); },
      warn(event, fields) { logs.push(["warn", event, fields]); },
    },
  });
}

const textInput = (overrides = {}) => ({
  profile,
  model: "gpt-text",
  correlationId: "corr-123",
  requestKey: "request-fixed-123",
  timeoutMs: 500,
  prompt: "private product prompt",
  jsonSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
  ...overrides,
});

const imageInput = (overrides = {}) => ({
  profile,
  model: "gpt-image",
  correlationId: "corr-image",
  requestKey: "request-image-fixed",
  timeoutMs: 500,
  prompt: "private image prompt",
  size: "1024x1024",
  quality: "medium",
  outputFormat: "png",
  ...overrides,
});

test("exports only the three closed profile protocols", () => {
  assert.deepEqual([...SUB2API_TEXT_PROTOCOLS], ["SUB2API_RESPONSES"]);
  assert.deepEqual([...SUB2API_IMAGE_PROTOCOLS], [
    "SUB2API_RESPONSES_IMAGE_TOOL",
    "SUB2API_OPENAI_IMAGES",
  ]);
});

test("Responses structured text stays behind the stable port and logs never expose sensitive payloads", async () => {
  const requests = [];
  const logs = [];
  const gateway = adapter(async (url, init) => {
    requests.push({ url: String(url), init });
    return jsonResponse({
      id: "resp-upstream-1",
      model: "gpt-text",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "{\"ok\":true}" }],
      }],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    }, { headers: { "x-request-id": "upstream-request-1" } });
  }, { logs });

  const first = await gateway.createTextResponse(textInput());
  const second = await gateway.createTextResponse(textInput());

  assert.deepEqual(first.value, { ok: true });
  assert.equal(first.requestId, "upstream-request-1");
  assert.deepEqual(first.usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  assert.deepEqual(first.diagnostics, {
    protocol: "SUB2API_RESPONSES",
    httpStatus: 200,
    responseKind: "STRUCTURED_TEXT",
  });
  assert.equal(Object.hasOwn(first, "rawResponse"), false);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "https://gateway.example.test/tenant/v1/responses");
    assert.equal(request.init.headers.Authorization, `Bearer ${secret}`);
    assert.equal(request.init.headers["Idempotency-Key"], "request-fixed-123");
    assert.equal(request.init.headers["X-Correlation-Id"], "corr-123");
    assert.equal(request.init.headers["X-Request-Id"], "corr-123");
    const body = JSON.parse(request.init.body);
    assert.equal(body.model, "gpt-text");
    assert.equal(body.stream, false);
    assert.equal(body.store, false);
    assert.deepEqual(body.text.format.schema, textInput().jsonSchema);
  }
  const recorded = JSON.stringify(logs);
  for (const forbidden of [secret, "Authorization", "Cookie", "private product prompt", "gateway-secret", "output_text"]) {
    assert.doesNotMatch(recorded, new RegExp(forbidden, "i"));
  }
  assert.deepEqual(second.value, { ok: true });
});

test("Responses image-tool protocol accepts a documented final streamed output-item event", async () => {
  const sse = [
    "event: response.output_item.done",
    `data: {"type":"response.output_item.done","item":{"id":"ig-1","type":"image_generation_call","status":"completed","result":"${PNG_1X1}","output_format":"png"}}`,
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-image\",\"model\":\"gpt-text\",\"usage\":{\"input_tokens\":5,\"output_tokens\":9,\"total_tokens\":14}}}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const calls = [];
  const gateway = adapter(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-request-id": "upstream-image-stream" },
    });
  });

  const result = await gateway.generateImage(imageInput());

  assert.equal(calls.length, 1, "the adapter must not probe or silently switch protocols");
  assert.equal(calls[0].url, "https://gateway.example.test/tenant/v1/responses");
  assert.equal(calls[0].body.model, "gpt-text");
  assert.deepEqual(calls[0].body.tools, [{ type: "image_generation", model: "gpt-image", size: "1024x1024", quality: "medium", output_format: "png" }]);
  assert.equal(calls[0].body.stream, true);
  assert.equal(result.contentType, "image/png");
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.requestId, "upstream-image-stream");
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 9, totalTokens: 14 });
  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG_1X1, "base64"));
});

test("Responses image-tool protocol never treats a partial-image event as an accepted final image", async () => {
  const sse = `event: response.image_generation_call.partial_image\ndata: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_1X1}","partial_image_index":0,"output_format":"png"}\n\ndata: [DONE]\n\n`;
  const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(
    gateway.generateImage(imageInput()),
    (error) => error?.code === "INVALID_GATEWAY_RESPONSE" && error?.retryable === false,
  );
});

test("OpenAI Images protocol normalizes b64_json without trying another protocol", async () => {
  const urls = [];
  const gateway = adapter(async (url, init) => {
    urls.push(String(url));
    assert.equal(JSON.parse(init.body).response_format, "b64_json");
    return jsonResponse({ created: 1, data: [{ b64_json: PNG_1X1, revised_prompt: "safe summary" }] }, {
      headers: { "x-request-id": "image-json-id" },
    });
  });
  const result = await gateway.generateImage(imageInput({
    profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
  }));
  assert.deepEqual(urls, ["https://gateway.example.test/tenant/v1/images/generations"]);
  assert.equal(result.contentType, "image/png");
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.requestId, "image-json-id");
});

test("OpenAI Images URL output downloads bytes without authorization inside the configured boundary", async () => {
  const requests = [];
  const gateway = adapter(async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) {
      return jsonResponse({ data: [{ url: "https://gateway.example.test/tenant/v1/media/generated.png" }] });
    }
    return new Response(Buffer.from(PNG_1X1, "base64"), {
      headers: { "content-type": "image/png", "content-length": "68" },
    });
  });
  const result = await gateway.generateImage(imageInput({
    profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
  }));
  assert.equal(result.width, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "https://gateway.example.test/tenant/v1/media/generated.png");
  assert.equal(requests[1].init.headers?.Authorization, undefined);
  assert.equal(requests[1].init.redirect, "manual");
});

test("gateway and returned-image redirects cannot escape the configured origin and base path", async () => {
  for (const mode of ["gateway", "image"]) {
    const calls = [];
    const gateway = adapter(async (url) => {
      calls.push(String(url));
      if (mode === "gateway") {
        return new Response(null, { status: 307, headers: { location: "https://evil.example/steal" } });
      }
      if (calls.length === 1) return jsonResponse({ data: [{ url: "https://gateway.example.test/tenant/v1/media.png" }] });
      return new Response(null, { status: 302, headers: { location: "https://evil.example/image" } });
    });
    await assert.rejects(
      gateway.generateImage(imageInput({ profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" } })),
      (error) => error?.code === "GATEWAY_REDIRECT_BLOCKED" && error?.retryable === false,
    );
    assert.equal(calls.some((url) => url.startsWith("https://evil.example")), false);
  }
});

test("profile URLs with credentials, query, fragment, or an endpoint-like escape are rejected before secret resolution", async () => {
  for (const baseUrl of [
    "https://user:pass@gateway.example.test/v1",
    "https://gateway.example.test/v1?next=evil",
    "https://gateway.example.test/v1#fragment",
    "http://gateway.example.test/v1",
  ]) {
    let reads = 0;
    const gateway = adapter(async () => { throw new Error("fetch must not run"); }, { readSecret: () => { reads += 1; return secret; } });
    await assert.rejects(
      gateway.createTextResponse(textInput({ profile: { ...profile, baseUrl } })),
      (error) => error?.code === "AI_GATEWAY_PROFILE_INVALID",
    );
    assert.equal(reads, 0);
  }
});

test("profile secret references must be environment-variable names and secret-reader failures stay safe", async () => {
  let reads = 0;
  const invalid = adapter(async () => { throw new Error("fetch must not run"); }, {
    readSecret: () => { reads += 1; return secret; },
  });
  await assert.rejects(
    invalid.createTextResponse(textInput({ profile: { ...profile, apiKeyEnvName: "bad-secret-name" } })),
    (error) => error?.code === "AI_GATEWAY_PROFILE_INVALID",
  );
  assert.equal(reads, 0);

  const failedRead = adapter(async () => { throw new Error("fetch must not run"); }, {
    readSecret: () => { throw new Error(`vault failure ${secret}`); },
  });
  await assert.rejects(failedRead.createTextResponse(textInput()), (error) => {
    assert.equal(error?.code, "AI_GATEWAY_SECRET_MISSING");
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test("HTTP authentication and transient statuses map to stable safe errors", async () => {
  const cases = [
    [401, "NON_RETRYABLE_AUTH", false],
    [403, "NON_RETRYABLE_AUTH", false],
    [408, "RETRYABLE_GATEWAY", true],
    [429, "RETRYABLE_GATEWAY", true],
    [500, "RETRYABLE_GATEWAY", true],
    [502, "RETRYABLE_GATEWAY", true],
    [503, "RETRYABLE_GATEWAY", true],
    [504, "RETRYABLE_GATEWAY", true],
  ];
  for (const [status, code, retryable] of cases) {
    const gateway = adapter(async () => jsonResponse({ error: { message: `sensitive-${secret}` } }, { status }));
    await assert.rejects(gateway.createTextResponse(textInput()), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(error.status, status);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      assert.doesNotMatch(error.message, /sensitive/i);
      return true;
    });
  }
});

test("malformed successful text and image responses are INVALID_GATEWAY_RESPONSE", async () => {
  const textGateway = adapter(async () => jsonResponse({ output: [] }));
  await assert.rejects(textGateway.createTextResponse(textInput()), (error) => error?.code === "INVALID_GATEWAY_RESPONSE" && error?.retryable === false);
  const imageGateway = adapter(async () => jsonResponse({ data: [{ b64_json: "not-an-image" }] }));
  await assert.rejects(
    imageGateway.generateImage(imageInput({ profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" } })),
    (error) => error?.code === "INVALID_GATEWAY_RESPONSE" && error?.retryable === false,
  );
});

test("decoded base64 image limits are enforced before an oversized payload can be accepted", async () => {
  const gateway = createSub2ApiAdapter({
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: PNG_1X1 }] }),
    readSecret: () => secret,
    maxImageBytes: 16,
  });
  await assert.rejects(
    gateway.generateImage(imageInput({ profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" } })),
    (error) => error?.code === "INVALID_GATEWAY_RESPONSE",
  );
});

test("request timeout and caller cancellation abort fetch with distinct stable codes", async () => {
  const waitingFetch = async (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason || new DOMException("aborted", "AbortError")), { once: true });
  });
  const gateway = adapter(waitingFetch);
  await assert.rejects(
    gateway.createTextResponse(textInput({ timeoutMs: 5 })),
    (error) => error?.code === "GATEWAY_TIMEOUT" && error?.retryable === true,
  );
  const controller = new AbortController();
  const pending = gateway.createTextResponse(textInput({ timeoutMs: 5_000, signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, (error) => error?.code === "GATEWAY_CANCELLED" && error?.retryable === false);
});

test("secret is read at call time, requires only presence, and never leaks when missing", async () => {
  let value = "a";
  const seen = [];
  const gateway = adapter(async (_url, init) => {
    seen.push(init.headers.Authorization);
    return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }] });
  }, { readSecret: () => value });
  await gateway.createTextResponse(textInput());
  value = "different-secret";
  await gateway.createTextResponse(textInput());
  value = "";
  await assert.rejects(gateway.createTextResponse(textInput()), (error) => error?.code === "AI_GATEWAY_SECRET_MISSING");
  assert.deepEqual(seen, ["Bearer a", "Bearer different-secret"]);
});

test("inspectImage uses structured Responses internally without exposing source bytes or data URLs", async () => {
  const logs = [];
  let body;
  const gateway = adapter(async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "{\"matches\":true}" }] }],
    });
  }, { logs });
  const result = await gateway.inspectImage({
    ...textInput(),
    prompt: "inspect private image",
    image: { bytes: Buffer.from(PNG_1X1, "base64"), contentType: "image/png" },
    jsonSchema: {
      type: "object",
      properties: { matches: { type: "boolean" } },
      required: ["matches"],
      additionalProperties: false,
    },
  });
  assert.deepEqual(result.value, { matches: true });
  assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  const recorded = JSON.stringify(logs);
  assert.doesNotMatch(recorded, /data:image|iVBOR|inspect private image/);
});

test("explicit capability test performs reachability, structured text, and one decoded image probe", async () => {
  const calls = [];
  const gateway = adapter(async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (calls.length === 1) return jsonResponse({ object: "list", data: [{ id: "gpt-text" }, { id: "gpt-image" }] }, { headers: { "x-request-id": "models-id" } });
    if (calls.length === 2) {
      return jsonResponse({
        id: "text-id",
        output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
      });
    }
    return jsonResponse({ id: "image-id", data: [{ b64_json: PNG_1X1 }] });
  });

  const result = await gateway.testCapabilities({
    profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    correlationId: "corr-capability",
    requestKey: "capability-fixed",
    timeoutMs: 500,
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://gateway.example.test/tenant/v1/models",
    "https://gateway.example.test/tenant/v1/responses",
    "https://gateway.example.test/tenant/v1/images/generations",
  ]);
  assert.deepEqual(calls.map((call) => call.headers["Idempotency-Key"]), [
    "capability-fixed:reachability",
    "capability-fixed:text-schema",
    "capability-fixed:image",
  ]);
  assert.deepEqual(result.features, ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"]);
  assert.deepEqual(result.models, { text: "gpt-text", image: "gpt-image" });
  assert.deepEqual(result.requestIds, { reachability: "models-id", text: "text-id", image: "image-id" });
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
});

test("capability test rejects image bytes that only mimic a supported header but cannot actually decode", async () => {
  const fakePngHeader = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fakePngHeader, 0);
  fakePngHeader.writeUInt32BE(1, 16);
  fakePngHeader.writeUInt32BE(1, 20);
  let call = 0;
  const gateway = adapter(async () => {
    call += 1;
    if (call === 1) return jsonResponse({ data: [] });
    if (call === 2) return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }] });
    return jsonResponse({ data: [{ b64_json: fakePngHeader.toString("base64") }] });
  });
  await assert.rejects(
    gateway.testCapabilities({
      profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
      correlationId: "corr-decode",
      requestKey: "capability-decode",
      timeoutMs: 500,
    }),
    (error) => error?.code === "INVALID_GATEWAY_RESPONSE",
  );
});

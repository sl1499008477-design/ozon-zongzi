import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  createSub2ApiAdapter,
  SUB2API_IMAGE_PROTOCOLS,
  SUB2API_TEXT_PROTOCOLS,
} from "../sub2api-ai-adapter.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const WEBP_VP8_3X2 = "UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoDAAIAAUAmJQBOl0AAjNAA/vhff9REQUksP0KNlEvmAAAA";
const WEBP_VP8L_3X2 = "UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQnnpUq/+BiOh/AAA=";
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

const encryptedProfile = Object.freeze({
  ...profile,
  apiKeyEnvName: "SUB2API_ENCRYPTED_KEY",
  connectionId: "connection-a",
  connectionVersion: 3,
});

const connection = Object.freeze({
  id: "connection-a",
  accountId: "account-a",
  version: 3,
  baseUrl: profile.baseUrl,
  status: "ACTIVE",
});

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  headers: { "content-type": "application/json", ...(init.headers || {}) },
});

const publicDns = async () => [{ address: "203.0.113.10", family: 4 }];

async function listenCatalogServer(address, port, modelId, observations = []) {
  const server = http.createServer((request, response) => {
    observations.push({ host: request.headers.host, path: request.url });
    response.writeHead(200, {
      "content-type": "application/json",
      connection: "keep-alive",
    });
    response.end(JSON.stringify({
      object: "list",
      data: [{ object: "model", id: modelId, owned_by: "local-test" }],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, resolve);
  });
  return server;
}

async function closeCatalogServers(...servers) {
  http.globalAgent.destroy();
  await Promise.all(servers.filter(Boolean).map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
}

function adapter(fetchImpl, {
  logs = [], readSecret = () => secret, allowLocalGateway = false, resolveHostname = publicDns,
  ...options
} = {}) {
  return createSub2ApiAdapter({
    fetchImpl,
    readSecret,
    allowLocalGateway,
    resolveHostname,
    ...options,
    logger: {
      info(event, fields) { logs.push(["info", event, fields]); },
      warn(event, fields) { logs.push(["warn", event, fields]); },
    },
  });
}

function encryptedAdapter(fetchImpl, options = {}) {
  return adapter(fetchImpl, {
    allowedSecretEnvNames: [profile.apiKeyEnvName],
    allowedGatewayBaseUrls: [profile.baseUrl],
    ...options,
  });
}

function manualTimers() {
  let now = 0;
  let nextId = 1;
  let setCalls = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      setCalls += 1;
      const handle = { id: nextId += 1, unref() {} };
      pending.set(handle, { callback, at: now + delay });
      return handle;
    },
    clearTimeout(handle) { pending.delete(handle); },
    advanceBy(duration) {
      const target = now + duration;
      while (true) {
        const due = [...pending.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [handle, task] = due;
        pending.delete(handle);
        now = task.at;
        task.callback();
      }
      now = target;
    },
    activeCount: () => pending.size,
    setCalls: () => setCalls,
    delays: () => [...pending.values()].map(({ at }) => at - now).sort((a, b) => a - b),
  };
}

async function waitFor(assertion, attempts = 40) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try { return assertion(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw lastError;
}

function controlledResponse(contentType) {
  let controller;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": contentType } });
  return {
    response,
    enqueue(text) { controller.enqueue(new TextEncoder().encode(text)); },
    close() { controller.close(); },
    wasCancelled: () => cancelled,
  };
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

const capabilityExecution = Object.freeze({
  accountId: "account-a", profileId: "profile-1", configVersion: 7,
  attemptId: "attempt-capability-a", correlationId: "corr-persisted-capability", fence: 11,
  leaseVersion: 1, leaseToken: "caplease_capability-a",
  purpose: "PROFILE_CAPABILITY", authorizationHash: "a".repeat(64), requestKey: "b".repeat(64),
  connectionId: "connection-a", connectionVersion: 3,
  expectedConnectionStatus: "VALIDATED", expectedConnectionStatusVersion: 2,
});

const legacyCapabilityExecution = Object.freeze({
  ...capabilityExecution,
  connectionId: null,
  connectionVersion: null,
  expectedConnectionStatus: "LEGACY",
  expectedConnectionStatusVersion: 0,
});

const capabilityProviderIdentities = Object.freeze({
  REACHABILITY: Object.freeze({ providerRequestKey: "4d82d0f8260ce4d269de0cd885c46b23fa6e2cbfb7c6a98be1297976d976caad",
    providerCorrelationId: "cap_4d82d0f8260ce4d269de0cd885c46b23fa6e2cbf" }),
  TEXT: Object.freeze({ providerRequestKey: "f290e389fa2ce2ca67e41089fa5928e73162e8f109878a113d459f9f79dcf1da",
    providerCorrelationId: "cap_f290e389fa2ce2ca67e41089fa5928e73162e8f1" }),
  IMAGE: Object.freeze({ providerRequestKey: "429d5110a49d896c50aefb94cd698bf39e34a8f78a77c9b49c0260a44f77ffec",
    providerCorrelationId: "cap_429d5110a49d896c50aefb94cd698bf39e34a8f7" }),
});

test("exports only the three closed profile protocols", () => {
  assert.deepEqual([...SUB2API_TEXT_PROTOCOLS], ["SUB2API_RESPONSES"]);
  assert.deepEqual([...SUB2API_IMAGE_PROTOCOLS], [
    "SUB2API_RESPONSES_IMAGE_TOOL",
    "SUB2API_OPENAI_IMAGES",
  ]);
});

test("encrypted profiles resolve the exact tenant connection version asynchronously while legacy profiles stay on env secrets", async () => {
  const scopes = [];
  let reads = 0;
  const requests = [];
  const logs = [];
  const gateway = encryptedAdapter(async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.Authorization });
    return jsonResponse({
      model: "gpt-text",
      output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
    });
  }, {
    logs,
    readSecret: () => { reads += 1; return "legacy-secret"; },
    resolveSecret: async (value) => {
      await Promise.resolve();
      scopes.push(structuredClone(value));
      return "encrypted-secret";
    },
  });

  await gateway.createTextResponse(textInput({ profile: encryptedProfile }));
  await gateway.createTextResponse(textInput());

  assert.deepEqual(scopes, [{
    accountId: "account-a",
    connectionId: "connection-a",
    connectionVersion: 3,
  }]);
  assert.equal(reads, 1);
  assert.deepEqual(requests.map(({ authorization }) => authorization), [
    "Bearer encrypted-secret",
    "Bearer legacy-secret",
  ]);
  const recorded = JSON.stringify(logs);
  for (const forbidden of ["encrypted-secret", "legacy-secret", "Authorization", "SUB2API_ENCRYPTED_KEY"]) {
    assert.doesNotMatch(recorded, new RegExp(forbidden, "iu"));
  }
});

test("encrypted credential sentinel and connection reference must be present together before DNS or secret resolution", async () => {
  let dnsReads = 0;
  let envReads = 0;
  let resolutions = 0;
  let fetches = 0;
  const gateway = encryptedAdapter(async () => { fetches += 1; throw new Error("must not fetch"); }, {
    readSecret: () => { envReads += 1; return secret; },
    resolveSecret: async () => { resolutions += 1; return secret; },
    resolveHostname: async () => { dnsReads += 1; return publicDns(); },
  });
  for (const invalidProfile of [
    { ...profile, apiKeyEnvName: "SUB2API_ENCRYPTED_KEY" },
    { ...profile, connectionId: "connection-a", connectionVersion: 3 },
    { ...encryptedProfile, connectionVersion: 0 },
    { ...encryptedProfile, connectionId: "" },
    { ...encryptedProfile, connectionId: "connection-a " },
    { ...encryptedProfile, accountId: " account-a" },
    { ...encryptedProfile, apiKeyEnvName: " SUB2API_ENCRYPTED_KEY" },
  ]) {
    await assert.rejects(gateway.createTextResponse(textInput({ profile: invalidProfile })), {
      code: "AI_GATEWAY_PROFILE_INVALID",
    });
  }
  assert.deepEqual({ dnsReads, envReads, resolutions, fetches }, {
    dnsReads: 0, envReads: 0, resolutions: 0, fetches: 0,
  });
});

test("legacy snake-case rows with null connection references remain environment-backed", async () => {
  let reads = 0;
  const legacyRow = {
    id: profile.id,
    account_id: profile.accountId,
    config_version: profile.configVersion,
    base_url: profile.baseUrl,
    api_key_env_name: profile.apiKeyEnvName,
    text_protocol: profile.textProtocol,
    image_protocol: profile.imageProtocol,
    text_model: profile.textModel,
    image_model: profile.imageModel,
    enabled: true,
    connection_id: null,
    connection_version: null,
  };
  const gateway = adapter(async () => jsonResponse({
    model: "gpt-text",
    output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
  }), { readSecret: () => { reads += 1; return secret; } });

  assert.equal((await gateway.createTextResponse(textInput({ profile: legacyRow }))).value.ok, true);
  assert.equal(reads, 1);
});

test("encrypted profile replaces only the env-name allowlist and still requires an approved gateway base or origin", async () => {
  let defaultResolutions = 0;
  let defaultFetches = 0;
  const defaultClosed = createSub2ApiAdapter({
    fetchImpl: async () => { defaultFetches += 1; throw new Error("must not fetch"); },
    readSecret: () => { throw new Error("must not read env"); },
    resolveSecret: async () => { defaultResolutions += 1; return secret; },
    resolveHostname: publicDns,
  });
  await assert.rejects(defaultClosed.createTextResponse(textInput({ profile: encryptedProfile })), {
    code: "AI_GATEWAY_PROFILE_INVALID",
  });
  assert.deepEqual({ defaultResolutions, defaultFetches }, { defaultResolutions: 0, defaultFetches: 0 });

  for (const policy of [
    { allowedGatewayBaseUrls: [], allowedGatewayOrigins: [] },
    { allowedGatewayBaseUrls: ["https://other.example/v1"], allowedGatewayOrigins: [] },
  ]) {
    let resolutions = 0;
    let fetches = 0;
    const gateway = adapter(async () => { fetches += 1; throw new Error("must not fetch"); }, {
      resolveSecret: async () => { resolutions += 1; return secret; },
      allowedSecretEnvNames: [],
      ...policy,
    });
    await assert.rejects(gateway.createTextResponse(textInput({ profile: encryptedProfile })), {
      code: "AI_GATEWAY_PROFILE_INVALID",
    });
    assert.deepEqual({ resolutions, fetches }, { resolutions: 0, fetches: 0 });
  }

  const accepted = adapter(async () => jsonResponse({
    model: "gpt-text",
    output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
  }), {
    resolveSecret: async () => secret,
    allowedSecretEnvNames: [],
    allowedGatewayOrigins: ["https://gateway.example.test"],
  });
  assert.equal((await accepted.createTextResponse(textInput({ profile: encryptedProfile }))).value.ok, true);
});

test("model discovery performs only an authorized GET on the exact normalized models path and returns a closed DTO", async () => {
  const requests = [];
  const scopes = [];
  const gateway = encryptedAdapter(async (url, init) => {
    requests.push({ url: String(url), init });
    return jsonResponse({
      object: "list",
      data: [{
        id: "provider/text-model:1",
        object: "model",
        created: 1_700_000_000,
        owned_by: "provider-a",
        permission: [{ id: "must-not-escape" }],
        upstream_nested: { token: "must-not-escape" },
      }],
    }, { headers: { "x-request-id": "models-request-1" } });
  }, {
    readSecret: () => { throw new Error("env secret path must not run"); },
    resolveSecret: async (value) => { scopes.push(structuredClone(value)); return secret; },
  });

  const result = await gateway.listModels({
    connection,
    correlationId: "corr-models",
    requestKey: "request-models-fixed",
    timeoutMs: 500,
  });

  assert.deepEqual(result, {
    requestId: "models-request-1",
    models: [{ id: "provider/text-model:1", ownedBy: "provider-a", metadata: {} }],
  });
  assert.deepEqual(scopes, [{ accountId: "account-a", connectionId: "connection-a", connectionVersion: 3 }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://gateway.example.test/tenant/v1/models");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(Object.hasOwn(requests[0].init, "body"), false);
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${secret}`);
  assert.equal(requests[0].init.headers["Idempotency-Key"], "request-models-fixed");
  assert.doesNotMatch(JSON.stringify(result), /must-not-escape|permission|upstream_nested|created/iu);
});

test("model discovery accepts the current sub2API catalog item contract", async () => {
  const gateway = encryptedAdapter(async () => jsonResponse({
    object: "list",
    data: [{
      id: "provider/text-model:1",
      type: "model",
      display_name: "Provider Text Model",
      created_at: "2026-08-09T07:00:00Z",
    }],
  }), { resolveSecret: async () => secret });

  assert.deepEqual(await gateway.listModels({
    connection,
    correlationId: "corr-sub2api-models",
    requestKey: "request-sub2api-models",
    timeoutMs: 500,
  }), {
    requestId: "",
    models: [{ id: "provider/text-model:1", ownedBy: "", metadata: {} }],
  });
});

test("catalog sync model discovery consumes one lease-bound in-memory credential and never calls the generic resolver", async () => {
  const credentialReads = [];
  const credentialStatuses = ["PENDING", "VALIDATED", "ACTIVE"];
  let genericReads = 0;
  const requests = [];
  const gateway = encryptedAdapter(async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.Authorization });
    return jsonResponse({ object: "list", data: [] });
  }, {
    resolveSecret: async () => { genericReads += 1; throw new Error("generic resolver forbidden"); },
    resolveCatalogSyncCredential: async (input) => {
      credentialReads.push(structuredClone(input));
      return { connection: { ...connection, status: credentialStatuses[credentialReads.length - 1] },
        secret: "lease-bound-secret" };
    },
  });
  const catalogSyncLease = {
    accountId: "account-a",
    taskId: "catalog-task-a",
    workerId: "catalog-worker-a",
    leaseVersion: 2,
    leaseToken: "aiglease_catalog-secret",
  };

  for (const status of credentialStatuses) {
    assert.deepEqual(await gateway.listModels({
      catalogSyncLease,
      correlationId: `corr-models-lease-${status}`,
      requestKey: `request-models-lease-${status}`,
      timeoutMs: 500,
    }), { requestId: "", models: [] });
  }
  assert.deepEqual(credentialReads, credentialStatuses.map(() => ({
    ...catalogSyncLease, minimumLeaseRemainingMs: 15_500,
  })));
  assert.equal(genericReads, 0);
  assert.deepEqual(requests, credentialStatuses.map(() => ({
    url: "https://gateway.example.test/tenant/v1/models",
    authorization: "Bearer lease-bound-secret",
  })));
});

test("catalog sync lease or connection fence failures happen before DNS and network", async () => {
  for (const code of [
    "AUTO_LISTING_AI_MODEL_SYNC_LEASE_CONFLICT",
    "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE",
  ]) {
    let dnsReads = 0;
    let fetches = 0;
    let genericReads = 0;
    const gateway = encryptedAdapter(async () => { fetches += 1; throw new Error("must not fetch"); }, {
      resolveSecret: async () => { genericReads += 1; return secret; },
      resolveCatalogSyncCredential: async () => {
        const error = new Error("leaseToken=must-not-leak");
        error.code = code;
        throw error;
      },
      resolveHostname: async () => { dnsReads += 1; return publicDns(); },
    });
    await assert.rejects(gateway.listModels({
      catalogSyncLease: {
        accountId: "account-a",
        taskId: "catalog-task-a",
        workerId: "catalog-worker-a",
        leaseVersion: 2,
        leaseToken: "aiglease_catalog-secret",
      },
      correlationId: "corr-models-lease",
      requestKey: "request-models-lease",
      timeoutMs: 500,
    }), (error) => error?.code === code && !/must-not-leak/iu.test(error.message));
    assert.deepEqual({ dnsReads, fetches, genericReads }, { dnsReads: 0, fetches: 0, genericReads: 0 });
  }
});

test("catalog sync discovery rejects timeouts above sixty seconds before credentials or network", async () => {
  let credentialReads = 0;
  let fetches = 0;
  const gateway = encryptedAdapter(async () => { fetches += 1; throw new Error("must not fetch"); }, {
    resolveCatalogSyncCredential: async () => { credentialReads += 1; return { connection, secret }; },
  });
  await assert.rejects(gateway.listModels({
    catalogSyncLease: {
      accountId: "account-a",
      taskId: "catalog-task-a",
      workerId: "catalog-worker-a",
      leaseVersion: 2,
      leaseToken: "aiglease_catalog-secret",
    },
    correlationId: "corr-models-lease",
    requestKey: "request-models-lease",
    timeoutMs: 60_001,
  }), { code: "AI_GATEWAY_REQUEST_INVALID" });
  assert.deepEqual({ credentialReads, fetches }, { credentialReads: 0, fetches: 0 });
});

test("model discovery rejects every redirect without authorizing a second path", async () => {
  let fetches = 0;
  const gateway = encryptedAdapter(async () => {
    fetches += 1;
    return new Response(null, {
      status: 307,
      headers: { location: "/tenant/v1/models-shadow" },
    });
  }, { resolveSecret: async () => secret });

  await assert.rejects(gateway.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
  }), { code: "GATEWAY_REDIRECT_BLOCKED" });
  assert.equal(fetches, 1);
});

test("model discovery revalidates DNS immediately before transport and never authorizes a public-to-private change", async () => {
  let dnsReads = 0;
  let resolutions = 0;
  let fetches = 0;
  const gateway = encryptedAdapter(async () => { fetches += 1; throw new Error("must not fetch"); }, {
    resolveSecret: async () => { resolutions += 1; return secret; },
    resolveHostname: async () => (++dnsReads === 1
      ? [{ address: "203.0.113.10", family: 4 }]
      : [{ address: "10.0.0.9", family: 4 }]),
  });

  await assert.rejects(gateway.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
  }), { code: "AI_GATEWAY_PROFILE_INVALID" });
  assert.deepEqual({ dnsReads, resolutions, fetches }, { dnsReads: 2, resolutions: 1, fetches: 0 });
});

test("transport lookup is pinned to the verified public set and never performs a third DNS resolution", async () => {
  let dnsReads = 0;
  let transportAddresses;
  const gateway = encryptedAdapter(async (url, init) => {
    transportAddresses = await new Promise((resolve, reject) => {
      init.lookup(new URL(url).hostname, { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });
    return jsonResponse({ object: "list", data: [] });
  }, {
    resolveSecret: async () => secret,
    resolveHostname: async () => {
      dnsReads += 1;
      return dnsReads <= 2
        ? [{ address: "203.0.113.10", family: 4 }, { address: "2001:db8::10", family: 6 }]
        : [{ address: "10.0.0.9", family: 4 }];
    },
  });

  const result = await gateway.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
  });
  assert.deepEqual(result.models, []);
  assert.equal(dnsReads, 2);
  assert.deepEqual(transportAddresses, [
    { address: "203.0.113.10", family: 4 },
    { address: "2001:db8::10", family: 6 },
  ]);
});

test("default transport opens a fresh socket when the verified address rotates", async () => {
  const firstObservations = [];
  const secondObservations = [];
  const firstServer = await listenCatalogServer("127.0.0.1", 0, "model-from-first-address", firstObservations);
  const port = firstServer.address().port;
  let secondServer;
  try {
    secondServer = await listenCatalogServer("::1", port, "model-from-second-address", secondObservations);
    const baseUrl = `http://catalog.localhost:${port}/tenant/v1`;
    let dnsReads = 0;
    const gateway = encryptedAdapter(undefined, {
      allowLocalGateway: true,
      allowedGatewayBaseUrls: [baseUrl],
      resolveSecret: async () => secret,
      resolveHostname: async () => [{
        address: ++dnsReads <= 2 ? "127.0.0.1" : "::1",
        family: dnsReads <= 2 ? 4 : 6,
      }],
    });
    const localConnection = { ...connection, baseUrl };

    assert.deepEqual((await gateway.listModels({
      connection: localConnection,
      correlationId: "corr-first-address",
      requestKey: "request-first-address",
      timeoutMs: 500,
    })).models.map((model) => model.id), ["model-from-first-address"]);
    assert.deepEqual((await gateway.listModels({
      connection: localConnection,
      correlationId: "corr-second-address",
      requestKey: "request-second-address",
      timeoutMs: 500,
    })).models.map((model) => model.id), ["model-from-second-address"]);
    assert.equal(dnsReads, 4);
    assert.deepEqual(firstObservations, [{ host: `catalog.localhost:${port}`, path: "/tenant/v1/models" }]);
    assert.deepEqual(secondObservations, [{ host: `catalog.localhost:${port}`, path: "/tenant/v1/models" }]);
  } finally {
    await closeCatalogServers(firstServer, secondServer);
  }
});

test("default transport ignores a keep-alive socket prewarmed in the global agent", async () => {
  const firstServer = await listenCatalogServer("127.0.0.1", 0, "model-from-global-pool");
  const port = firstServer.address().port;
  let secondServer;
  try {
    secondServer = await listenCatalogServer("::1", port, "model-from-pinned-address");
    await new Promise((resolve, reject) => {
      const request = http.get({
        hostname: "catalog.localhost",
        port,
        path: "/tenant/v1/models",
        headers: { connection: "keep-alive" },
        lookup(_hostname, options, callback) {
          if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        },
      }, (response) => {
        response.resume();
        response.once("end", resolve);
      });
      request.once("error", reject);
    });

    const baseUrl = `http://catalog.localhost:${port}/tenant/v1`;
    const gateway = encryptedAdapter(undefined, {
      allowLocalGateway: true,
      allowedGatewayBaseUrls: [baseUrl],
      resolveSecret: async () => secret,
      resolveHostname: async () => [{ address: "::1", family: 6 }],
    });
    const result = await gateway.listModels({
      connection: { ...connection, baseUrl },
      correlationId: "corr-prewarmed-agent",
      requestKey: "request-prewarmed-agent",
      timeoutMs: 500,
    });
    assert.deepEqual(result.models.map((model) => model.id), ["model-from-pinned-address"]);
  } finally {
    await closeCatalogServers(firstServer, secondServer);
  }
});

test("model catalog response limit cannot be configured above the 2 MiB hard ceiling", () => {
  assert.throws(() => createSub2ApiAdapter({
    fetchImpl: async () => jsonResponse({ object: "list", data: [] }),
    readSecret: () => secret,
    resolveHostname: publicDns,
    maxJsonBytes: 2 * 1024 * 1024 + 1,
  }), TypeError);
});

test("model discovery enforces the 2 MiB response and 2,000 unique-model limits", async () => {
  const overTwoMiB = JSON.stringify({ object: "list", data: [], padding: "x".repeat(2 * 1024 * 1024) });
  const oversized = encryptedAdapter(async () => new Response(overTwoMiB, {
    status: 200,
    headers: { "content-type": "application/json" },
  }), { resolveSecret: async () => secret });
  await assert.rejects(oversized.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
  }), { code: "INVALID_GATEWAY_RESPONSE" });

  const models = Array.from({ length: 2_001 }, (_, index) => ({
    id: `model-${index}`,
    object: "model",
    owned_by: "provider",
  }));
  const tooMany = encryptedAdapter(async () => jsonResponse({ object: "list", data: models }), {
    resolveSecret: async () => secret,
  });
  await assert.rejects(tooMany.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
  }), { code: "INVALID_GATEWAY_RESPONSE" });

  const exactLimit = encryptedAdapter(async () => jsonResponse({ object: "list", data: models.slice(0, 2_000) }), {
    resolveSecret: async () => secret,
  });
  assert.equal((await exactLimit.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
  })).models.length, 2_000);
});

test("model discovery rejects duplicate or conflicting IDs invalid identifiers and unknown response shapes", async () => {
  const invalidBodies = [
    { object: "list", data: [
      { id: "model-a", object: "model", owned_by: "provider" },
      { id: "model-a", object: "model", owned_by: "provider" },
    ] },
    { object: "list", data: [
      { id: "model-a", object: "model", owned_by: "provider-a" },
      { id: "model-a", object: "model", owned_by: "provider-b" },
    ] },
    { object: "list", data: [{ id: "../admin", object: "model", owned_by: "provider" }] },
    { object: "list", data: [{ id: "a/../b", object: "model", owned_by: "provider" }] },
    { object: "list", data: [{ id: "a//b", object: "model", owned_by: "provider" }] },
    { object: "list", data: [{ id: "bad model", object: "model", owned_by: "provider" }] },
    { object: "list", data: [{ id: "x".repeat(301), object: "model", owned_by: "provider" }] },
    [],
    { models: [] },
    { object: "model", data: [] },
    { object: "list", data: {} },
    { object: "list", data: ["model-a"] },
  ];

  for (const body of invalidBodies) {
    const gateway = encryptedAdapter(async () => jsonResponse(body), { resolveSecret: async () => secret });
    await assert.rejects(gateway.listModels({
      connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
    }), { code: "INVALID_GATEWAY_RESPONSE" });
  }
});

test("model discovery rejects prototype and proxied body payloads with one safe response error", async () => {
  const prototypePayload = "{\"object\":\"list\",\"data\":[{\"id\":\"model-a\",\"object\":\"model\",\"owned_by\":\"provider\",\"__proto__\":{\"admin\":true}}]}";
  const prototypeGateway = encryptedAdapter(async () => new Response(prototypePayload, {
    status: 200, headers: { "content-type": "application/json" },
  }), { resolveSecret: async () => secret });
  await assert.rejects(prototypeGateway.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
  }), { code: "INVALID_GATEWAY_RESPONSE" });

  const leaked = "proxied-secret-must-not-leak";
  const bytes = new TextEncoder().encode("{\"object\":\"list\",\"data\":[]}");
  const proxied = new Proxy(bytes, {
    get() { throw new Error(leaked); },
  });
  let delivered = false;
  const proxiedGateway = encryptedAdapter(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader() {
        return {
          async read() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return { done: false, value: proxied };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  }), { resolveSecret: async () => secret });
  await assert.rejects(proxiedGateway.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
  }), (error) => error?.code === "INVALID_GATEWAY_RESPONSE" && !String(error.message).includes(leaked));
});

test("model discovery keeps timeout and encrypted resolver failures stable and secret-free", async () => {
  const timeout = encryptedAdapter(async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { resolveSecret: async () => secret });
  await assert.rejects(timeout.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 10,
  }), (error) => error?.code === "GATEWAY_TIMEOUT" && error?.retryable === true);

  const stalledResolver = encryptedAdapter(async () => { throw new Error("must not fetch"); }, {
    resolveSecret: async () => new Promise(() => {}),
  });
  const resolverOutcome = await Promise.race([
    stalledResolver.listModels({
      connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 10,
    }).catch((error) => error?.code),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  assert.equal(resolverOutcome, "GATEWAY_TIMEOUT");

  const ciphertext = "opaque-ciphertext-must-not-leak";
  const logs = [];
  const failed = encryptedAdapter(async () => { throw new Error("must not fetch"); }, {
    logs,
    resolveSecret: async () => { throw new Error(ciphertext); },
  });
  await assert.rejects(failed.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
  }), (error) => error?.code === "AI_GATEWAY_SECRET_MISSING"
    && !String(error.message).includes(ciphertext));
  assert.doesNotMatch(JSON.stringify(logs), /opaque-ciphertext|Authorization|Bearer/iu);
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

test("disabled profiles reject every business operation before secret resolution or fetch while capability test remains explicit", async () => {
  let secretReads = 0;
  let fetches = 0;
  const gateway = createSub2ApiAdapter({
    readSecret: () => { secretReads += 1; return secret; },
    fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
  });
  const disabled = { ...profile, enabled: false };
  for (const operation of [
    () => gateway.createTextResponse(textInput({ profile: disabled, allowDisabled: true })),
    () => gateway.generateImage(imageInput({ profile: disabled, allowDisabled: true })),
    () => gateway.inspectImage({
      ...textInput({ profile: disabled, allowDisabled: true }),
      image: { bytes: Buffer.from(PNG_1X1, "base64"), contentType: "image/png" },
    }),
  ]) {
    await assert.rejects(operation(), (error) => error?.code === "AI_GATEWAY_PROFILE_DISABLED" && error?.retryable === false);
  }
  assert.equal(secretReads, 0);
  assert.equal(fetches, 0);
});

test("prompts preserve long original text exactly and reject explicit limits without truncating", async () => {
  const longPrompt = `  ${"商品说明🙂".repeat(300)}  `;
  let sentPrompt = "";
  const gateway = adapter(async (_url, init) => {
    sentPrompt = JSON.parse(init.body).input[0].content[0].text;
    return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }] });
  });
  await gateway.createTextResponse(textInput({ prompt: longPrompt }));
  assert.equal(sentPrompt, longPrompt);
  assert.ok(sentPrompt.length > 1_000);

  const oversized = "x".repeat(100_001);
  let reads = 0;
  const rejecting = adapter(async () => { throw new Error("fetch must not run"); }, { readSecret: () => { reads += 1; return secret; } });
  await assert.rejects(rejecting.createTextResponse(textInput({ prompt: oversized })), (error) => error?.code === "AI_GATEWAY_REQUEST_INVALID");
  assert.equal(reads, 0);
});

test("structured output is validated strictly against the caller JSON Schema", async () => {
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  for (const value of [{}, { ok: "true" }, { ok: true, extra: 1 }]) {
    const gateway = adapter(async () => jsonResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
    }));
    await assert.rejects(
      gateway.createTextResponse(textInput({ jsonSchema: schema })),
      (error) => error?.code === "INVALID_GATEWAY_RESPONSE",
    );
  }
});

test("text model evidence rejects mismatches and records matching or absent upstream evidence", async () => {
  const mismatched = adapter(async () => jsonResponse({
    model: "different-text-model",
    output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
  }));
  await assert.rejects(
    mismatched.createTextResponse(textInput()),
    (error) => error?.code === "AI_GATEWAY_MODEL_MISMATCH" && error?.retryable === false,
  );

  for (const reportedModel of ["gpt-text", "gpt-text-2026-03-05", undefined]) {
    const gateway = adapter(async () => jsonResponse({
      ...(reportedModel ? { model: reportedModel } : {}),
      output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
    }));
    const result = await gateway.createTextResponse(textInput());
    assert.equal(result.model, "gpt-text");
    assert.deepEqual(result.modelEvidence, {
      requestedTextModel: "gpt-text",
      gatewayReportedTextModel: reportedModel || "",
      gatewayReportedTextModelPresent: Boolean(reportedModel),
    });
  }
});

test("invalid or unsupported JSON Schemas are rejected before secret resolution and fetch", async () => {
  let reads = 0;
  let fetches = 0;
  const gateway = createSub2ApiAdapter({
    readSecret: () => { reads += 1; return secret; },
    fetchImpl: async () => { fetches += 1; throw new Error("fetch must not run"); },
  });
  for (const jsonSchema of [
    { type: "not-a-json-schema-type" },
    { type: "object", unknownKeyword: true },
    { $ref: "https://untrusted.example/schema.json" },
    {
      type: "object",
      properties: { values: { type: "array", uniqueItems: true, items: { type: "string" } } },
      required: ["values"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } },
      required: ["value"],
      additionalProperties: false,
    },
  ]) {
    await assert.rejects(gateway.createTextResponse(textInput({ jsonSchema })), (error) => error?.code === "AI_GATEWAY_REQUEST_INVALID");
  }
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
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
  assert.deepEqual(calls[0].body.tools, [{ type: "image_generation", model: "gpt-image", action: "generate", size: "1024x1024", quality: "medium", output_format: "png" }]);
  assert.equal(calls[0].body.tool_choice, "auto");
  assert.notDeepEqual(calls[0].body.tool_choice, { type: "image_generation" });
  assert.equal(calls[0].body.stream, true);
  assert.equal(result.contentType, "image/png");
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.requestId, "upstream-image-stream");
  assert.equal(result.model, "gpt-image");
  assert.equal(result.orchestratorModel, "gpt-text");
  assert.deepEqual(result.modelEvidence, {
    requestedImageModel: "gpt-image",
    gatewayReportedImageModel: "",
    gatewayReportedImageModelPresent: false,
    orchestratorModel: "gpt-text",
  });
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 9, totalTokens: 14 });
  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG_1X1, "base64"));
});

test("Responses image-tool accepts the last documented partial image after successful completion", async () => {
  const sse = [
    "event: response.image_generation_call.partial_image",
    `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_1X1}","partial_image_index":0,"output_format":"png"}`,
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-image\",\"status\":\"completed\",\"model\":\"gpt-5.4\"}}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));

  const result = await gateway.generateImage(imageInput());

  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG_1X1, "base64"));
  assert.equal(result.orchestratorModel, "gpt-5.4");
});

test("Responses image-tool selects the highest strictly increasing partial image index", async () => {
  const sse = [
    "event: response.image_generation_call.partial_image",
    "data: {\"type\":\"response.image_generation_call.partial_image\",\"partial_image_b64\":\"not-base64\",\"partial_image_index\":0}",
    "",
    "event: response.image_generation_call.partial_image",
    `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_1X1}","partial_image_index":1}`,
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\"}}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));

  const result = await gateway.generateImage(imageInput());

  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG_1X1, "base64"));
});

test("Responses image-tool rejects malformed duplicate or descending partial image indices", async (t) => {
  const cases = [
    ["empty image", [{ partial_image_b64: "", partial_image_index: 0 }]],
    ["negative index", [{ partial_image_b64: PNG_1X1, partial_image_index: -1 }]],
    ["fractional index", [{ partial_image_b64: PNG_1X1, partial_image_index: 1.5 }]],
    ["duplicate index", [
      { partial_image_b64: PNG_1X1, partial_image_index: 0 },
      { partial_image_b64: PNG_1X1, partial_image_index: 0 },
    ]],
    ["descending index", [
      { partial_image_b64: PNG_1X1, partial_image_index: 1 },
      { partial_image_b64: PNG_1X1, partial_image_index: 0 },
    ]],
  ];
  for (const [name, partials] of cases) {
    await t.test(name, async () => {
      const blocks = partials.flatMap((partial) => [
        "event: response.image_generation_call.partial_image",
        `data: ${JSON.stringify({ type: "response.image_generation_call.partial_image", ...partial })}`,
        "",
      ]);
      const sse = [...blocks,
        "event: response.completed",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}",
        "",
        "data: [DONE]",
        "",
      ].join("\n");
      const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
      await assert.rejects(gateway.generateImage(imageInput()), {
        code: "INVALID_GATEWAY_RESPONSE",
      });
    });
  }
});

test("Responses image-tool prefers a formal final result over an earlier partial snapshot", async () => {
  const sse = [
    "event: response.image_generation_call.partial_image",
    "data: {\"type\":\"response.image_generation_call.partial_image\",\"partial_image_b64\":\"not-base64\",\"partial_image_index\":0}",
    "",
    "event: response.output_item.done",
    `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","result":"${PNG_1X1}"}}`,
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));

  const result = await gateway.generateImage(imageInput());

  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG_1X1, "base64"));
});

test("Responses image-tool never accepts a partial image without successful completion", async (t) => {
  const partial = `event: response.image_generation_call.partial_image\ndata: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_1X1}","partial_image_index":0}`;
  for (const [name, terminal] of [
    ["DONE only", "data: [DONE]"],
    ["failed", "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}"],
  ]) {
    await t.test(name, async () => {
      const gateway = adapter(async () => new Response(`${partial}\n\n${terminal}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }));
      await assert.rejects(gateway.generateImage(imageInput()), (error) =>
        ["INVALID_GATEWAY_RESPONSE", "NON_RETRYABLE_GATEWAY"].includes(error?.code));
    });
  }
});

test("Responses image-tool applies the decoded image byte limit to a completed partial image", async () => {
  const sse = [
    "event: response.image_generation_call.partial_image",
    `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_1X1}","partial_image_index":0}`,
    "",
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }), {
    maxImageBytes: 16,
  });

  await assert.rejects(gateway.generateImage(imageInput()), {
    code: "INVALID_GATEWAY_RESPONSE",
  });
});

test("Responses image-tool rejects failed termination even after a complete output item appeared", async () => {
  const sse = [
    `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","result":"${PNG_1X1}"}}`,
    "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}",
    "data: [DONE]",
    "",
  ].join("\n\n");
  const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(gateway.generateImage(imageInput()), (error) => ["NON_RETRYABLE_GATEWAY", "INVALID_GATEWAY_RESPONSE"].includes(error?.code));
});

test("Responses terminal failures map only safe type code and status without leaking messages", async () => {
  const sensitive = "private-upstream-message-should-never-escape";
  const cases = [
    {
      event: { type: "response.failed", response: { status: "failed", error: { type: "rate_limit_error", code: "rate_limit_exceeded", status: 429, message: sensitive } } },
      code: "AI_GATEWAY_RATE_LIMITED", retryable: true, status: 429,
    },
    {
      event: { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "timeout" }, error: { message: sensitive } } },
      code: "RETRYABLE_GATEWAY", retryable: true, status: null,
    },
    {
      event: { type: "error", error: { type: "server_error", code: "upstream_error", status: 503, message: sensitive } },
      code: "RETRYABLE_GATEWAY", retryable: true, status: 503,
    },
    {
      event: { type: "error", error: { type: "authentication_error", code: "invalid_api_key", status: 401, message: sensitive } },
      code: "NON_RETRYABLE_AUTH", retryable: false, status: 401,
    },
    {
      event: { type: "response.failed", response: { status: "failed", error: { type: "invalid_request_error", code: "invalid_request", status: 400, message: sensitive } } },
      code: "NON_RETRYABLE_GATEWAY", retryable: false, status: 400,
    },
    {
      event: { type: "response.failed", response: { status: "failed", error: { type: "unknown_future_error", message: sensitive } } },
      code: "NON_RETRYABLE_GATEWAY", retryable: false, status: null,
    },
    {
      event: { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "unknown_future_reason" }, error: { message: sensitive } } },
      code: "RETRYABLE_GATEWAY", retryable: true, status: null,
    },
  ];
  for (const entry of cases) {
    const logs = [];
    const sse = `event: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\ndata: [DONE]\n\n`;
    const gateway = adapter(
      async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      { logs },
    );
    await assert.rejects(gateway.generateImage(imageInput()), (error) => {
      assert.equal(error?.code, entry.code);
      assert.equal(error?.retryable, entry.retryable);
      assert.equal(error?.status, entry.status);
      assert.doesNotMatch(error?.message || "", new RegExp(sensitive));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(sensitive));
      return true;
    });
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(sensitive));
  }
});

test("SSE event names and data types must agree while either field may be omitted", async () => {
  const sensitive = "private-mismatched-event-message";
  for (const conflictingTerminal of [
    `event: response.failed\ndata: {"type":"response.completed","response":{"status":"completed","error":{"message":"${sensitive}"}}}`,
    `event: response.completed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"${sensitive}"}}}`,
  ]) {
    const sse = [
      `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","result":"${PNG_1X1}"}}`,
      conflictingTerminal,
      "data: [DONE]", "",
    ].join("\n\n");
    const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    await assert.rejects(gateway.generateImage(imageInput()), (error) => {
      assert.equal(error?.code, "INVALID_GATEWAY_RESPONSE");
      assert.doesNotMatch(error?.message || "", new RegExp(sensitive));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(sensitive));
      return true;
    });
  }

  for (const mode of ["consistent", "event-only", "data-only"]) {
    const outputData = `{"item":{"type":"image_generation_call","status":"completed","result":"${PNG_1X1}"}${mode === "event-only" ? "" : ",\"type\":\"response.output_item.done\""}}`;
    const completedData = `{"response":{"status":"completed"}${mode === "event-only" ? "" : ",\"type\":\"response.completed\""}}`;
    const outputPrefix = mode === "data-only" ? "" : "event: response.output_item.done\n";
    const completedPrefix = mode === "data-only" ? "" : "event: response.completed\n";
    const sse = [
      `${outputPrefix}data: ${outputData}`,
      `${completedPrefix}data: ${completedData}`,
      "data: [DONE]", "",
    ].join("\n\n");
    const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const result = await gateway.generateImage(imageInput());
    assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG_1X1, "base64"), mode);
  }
});

test("DONE markers never override complete JSON terminal evidence or synthesize missing terminal evidence", async () => {
  const completedPrefix = [
    `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","result":"${PNG_1X1}"}}`,
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}",
  ];
  for (const eventName of ["response.failed", "error", "response.cancelled"]) {
    const sse = [...completedPrefix, `event: ${eventName}\ndata: [DONE]`, ""].join("\n\n");
    const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const result = await gateway.generateImage(imageInput());
    assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG_1X1, "base64"));
  }

  const incomplete = adapter(async () => new Response(
    `event: response.incomplete\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  ));
  await assert.rejects(
    incomplete.generateImage(imageInput()),
    (error) => error?.code === "INVALID_GATEWAY_RESPONSE",
  );

  for (const doneBlock of ["data: [DONE]", "event: message\ndata: [DONE]"]) {
    const sse = [...completedPrefix, doneBlock, ""].join("\n\n");
    const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const result = await gateway.generateImage(imageInput());
    assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG_1X1, "base64"));
  }

  const invalidNamedDone = adapter(async () => new Response(
    `event: response.completed\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  ));
  await assert.rejects(
    invalidNamedDone.generateImage(imageInput()),
    (error) => error?.code === "INVALID_GATEWAY_RESPONSE",
  );
});

test("Responses image-tool requires response.completed evidence after a final output item", async () => {
  const sse = `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","result":"${PNG_1X1}"}}\n\ndata: [DONE]\n\n`;
  const gateway = adapter(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(gateway.generateImage(imageInput()), (error) => error?.code === "INVALID_GATEWAY_RESPONSE");
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

test("OpenAI Images uses the official edits endpoint and images[].image_url when source bytes are present", async () => {
  let request;
  const gateway = adapter(async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return jsonResponse({ data: [{ b64_json: PNG_1X1 }] });
  });
  const result = await gateway.generateImage(imageInput({
    profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    sourceImages: [{ bytes: Buffer.from(PNG_1X1, "base64"), contentType: "image/png" }],
  }));
  assert.equal(request.url, "https://gateway.example.test/tenant/v1/images/edits");
  assert.equal(Object.hasOwn(request.body, "reference_images"), false);
  assert.match(request.body.images[0].image_url, /^data:image\/png;base64,/);
  assert.equal(result.model, "gpt-image");
});

test("Responses image-tool treats undocumented SSE model fields as non-authoritative", async () => {
  const gateway = adapter(async () => new Response([
    `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","model":"internal-image-route","result":"${PNG_1X1}"}}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        model: "gpt-5.4",
        image_model: "internal-image-route",
        tools: [{ type: "image_generation", model: "gpt-5.4" }],
      },
    })}`,
    "data: [DONE]", "",
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));

  const result = await gateway.generateImage(imageInput({
    profile: { ...profile, textModel: "gpt-5.4", imageModel: "gpt-image-2" },
    model: "gpt-image-2",
  }));

  assert.equal(result.orchestratorModel, "gpt-5.4");
  assert.deepEqual(result.modelEvidence, {
    requestedImageModel: "gpt-image-2",
    gatewayReportedImageModel: "",
    gatewayReportedImageModelPresent: false,
    orchestratorModel: "gpt-5.4",
  });
});

test("Responses image-tool treats undocumented JSON model fields as non-authoritative", async () => {
  const gateway = adapter(async () => jsonResponse({
    id: "resp-image-json",
    model: "gpt-5.4",
    image_model: "internal-image-route",
    tools: [{ type: "image_generation", model: "gpt-5.4" }],
    output: [{
      type: "image_generation_call",
      status: "completed",
      model: "internal-image-route",
      result: PNG_1X1,
    }],
  }));

  const result = await gateway.generateImage(imageInput({
    profile: { ...profile, textModel: "gpt-5.4", imageModel: "gpt-image-2" },
    model: "gpt-image-2",
  }));

  assert.equal(result.orchestratorModel, "gpt-5.4");
  assert.equal(result.modelEvidence.gatewayReportedImageModel, "");
  assert.equal(result.modelEvidence.gatewayReportedImageModelPresent, false);
});

test("image model evidence rejects direct Images API mismatches and accepts matching or absent evidence", async () => {
  for (const payload of [
    { model: "wrong-image", data: [{ b64_json: PNG_1X1 }] },
    { data: [{ model: "wrong-image", b64_json: PNG_1X1 }] },
  ]) {
    const gateway = adapter(async () => jsonResponse(payload));
    await assert.rejects(gateway.generateImage(imageInput({
      profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    })), (error) => error?.code === "AI_GATEWAY_MODEL_MISMATCH");
  }

  for (const reportedModel of ["gpt-image", "gpt-image-2026-03-05", undefined]) {
    const gateway = adapter(async () => jsonResponse({
      ...(reportedModel ? { model: reportedModel } : {}),
      data: [{ b64_json: PNG_1X1 }],
    }));
    const result = await gateway.generateImage(imageInput({
      profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    }));
    assert.equal(result.model, "gpt-image");
    assert.equal(result.modelEvidence.gatewayReportedImageModel, reportedModel || "");
    assert.equal(result.modelEvidence.gatewayReportedImageModelPresent, Boolean(reportedModel));
  }
});

test("source-image URLs are rejected before secrets or fetch for every image protocol", async () => {
  for (const imageProtocol of SUB2API_IMAGE_PROTOCOLS) {
    let reads = 0;
    let fetches = 0;
    const gateway = createSub2ApiAdapter({
      readSecret: () => { reads += 1; return secret; },
      fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
    });
    await assert.rejects(gateway.generateImage(imageInput({
      profile: { ...profile, imageProtocol },
      sourceImages: [{ url: "https://example.com/source.png" }],
    })), (error) => error?.code === "AI_GATEWAY_INPUT_UNSUPPORTED");
    assert.equal(reads, 0);
    assert.equal(fetches, 0);
  }
});

test("malformed or oversized source-image bytes are request errors before secrets or fetch", async () => {
  for (const bytes of [Buffer.from("not-an-image"), Buffer.alloc(69)]) {
    let reads = 0;
    let fetches = 0;
    const gateway = createSub2ApiAdapter({
      maxImageBytes: 68,
      readSecret: () => { reads += 1; return secret; },
      fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
    });
    await assert.rejects(gateway.generateImage(imageInput({
      sourceImages: [{ bytes, contentType: "image/png" }],
    })), (error) => error?.code === "AI_GATEWAY_REQUEST_INVALID");
    assert.equal(reads, 0);
    assert.equal(fetches, 0);
  }
});

test("Responses structured text accepts ordinary VP8 and VP8L WebP source evidence", async () => {
  let body;
  const gateway = adapter(async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({
      model: "gpt-text",
      output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
    });
  });

  const result = await gateway.createTextResponse(textInput({
    sourceImages: [WEBP_VP8_3X2, WEBP_VP8L_3X2].map((value) => ({
      bytes: Buffer.from(value, "base64"),
      contentType: "image/webp",
    })),
  }));

  assert.deepEqual(result.value, { ok: true });
  assert.deepEqual(body.input[0].content.slice(1), [
    { type: "input_image", image_url: `data:image/webp;base64,${WEBP_VP8_3X2}` },
    { type: "input_image", image_url: `data:image/webp;base64,${WEBP_VP8L_3X2}` },
  ]);
});

test("malformed WebP source evidence is rejected before secret or network access", async (t) => {
  const headerOnlyVp8 = Buffer.from(WEBP_VP8_3X2, "base64").subarray(0, 30);
  headerOnlyVp8.writeUInt32LE(22, 4);
  headerOnlyVp8.writeUInt32LE(10, 16);
  headerOnlyVp8.writeUIntLE(headerOnlyVp8.readUIntLE(20, 3) & 0x1f, 20, 3);
  const headerOnlyVp8l = Buffer.from(WEBP_VP8L_3X2, "base64").subarray(0, 30);
  headerOnlyVp8l.writeUInt32LE(22, 4);
  headerOnlyVp8l.writeUInt32LE(10, 16);
  const headerOnlyVp8x = Buffer.alloc(30);
  headerOnlyVp8x.write("RIFF", 0, "ascii");
  headerOnlyVp8x.writeUInt32LE(22, 4);
  headerOnlyVp8x.write("WEBPVP8X", 8, "ascii");
  headerOnlyVp8x.writeUInt32LE(10, 16);
  const malformedCases = [
    ["VP8 has a valid key-frame header but no decodable pixels", headerOnlyVp8.toString("base64"), () => {}],
    ["VP8L has a valid image header but no decodable pixels", headerOnlyVp8l.toString("base64"), () => {}],
    ["VP8X has a valid canvas header but no image frame", headerOnlyVp8x.toString("base64"), () => {}],
    ["VP8 RIFF boundary excludes the image chunk", WEBP_VP8_3X2, (bytes) => bytes.writeUInt32LE(20, 4)],
    ["VP8 chunk is shorter than its frame header", WEBP_VP8_3X2, (bytes) => bytes.writeUInt32LE(0, 16)],
    ["VP8 frame is not a key frame", WEBP_VP8_3X2, (bytes) => { bytes[20] |= 0x01; }],
    ["VP8 frame profile is unsupported", WEBP_VP8_3X2, (bytes) => { bytes[20] = (bytes[20] & ~0x0e) | 0x08; }],
    ["VP8 frame is marked invisible", WEBP_VP8_3X2, (bytes) => { bytes[20] &= ~0x10; }],
    ["VP8 first partition reaches the chunk boundary", WEBP_VP8_3X2, (bytes) => {
      const frameFlags = bytes.readUIntLE(20, 3) & 0x1f;
      bytes.writeUIntLE((bytes.readUInt32LE(16) << 5) | frameFlags, 20, 3);
    }],
    ["VP8L chunk is shorter than its image header", WEBP_VP8L_3X2, (bytes) => bytes.writeUInt32LE(0, 16)],
    ["VP8L uses a reserved format version", WEBP_VP8L_3X2, (bytes) => { bytes[24] |= 0xe0; }],
  ];

  for (const [name, encoded, mutate] of malformedCases) {
    await t.test(name, async () => {
      const bytes = Buffer.from(encoded, "base64");
      mutate(bytes);
      let dnsReads = 0;
      let reads = 0;
      let fetches = 0;
      const gateway = adapter(async () => {
        fetches += 1;
        return jsonResponse({
          model: "gpt-text",
          output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
        });
      }, {
        readSecret: () => { reads += 1; return secret; },
        resolveHostname: async () => { dnsReads += 1; return publicDns(); },
      });

      await assert.rejects(gateway.createTextResponse(textInput({
        sourceImages: [{ bytes, contentType: "image/webp" }],
      })), (error) => error?.code === "AI_GATEWAY_REQUEST_INVALID" && error?.retryable === false);
      assert.deepEqual({ dnsReads, reads, fetches }, { dnsReads: 0, reads: 0, fetches: 0 });
    });
  }
});

test("source-image aggregate raw bytes and exact encoded request body are bounded before secret or fetch", async () => {
  for (const adapterOptions of [
    { maxImageBytes: 68, maxSourceImageBytesTotal: 100 },
    { maxImageBytes: 68, maxSourceImageBytesTotal: 136, maxRequestBodyBytes: 512 },
  ]) {
    let reads = 0;
    let fetches = 0;
    const gateway = createSub2ApiAdapter({
      ...adapterOptions,
      readSecret: () => { reads += 1; return secret; },
      fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
    });
    await assert.rejects(gateway.generateImage(imageInput({
      prompt: `${"large-prompt".repeat(90)}`,
      sourceImages: [
        { bytes: Buffer.from(PNG_1X1, "base64"), contentType: "image/png" },
        { bytes: Buffer.from(PNG_1X1, "base64"), contentType: "image/png" },
      ],
    })), (error) => error?.code === "AI_GATEWAY_REQUEST_INVALID" && error?.retryable === false);
    assert.equal(reads, 0);
    assert.equal(fetches, 0);
  }
});

test("source-image count rejects one beyond the category evidence maximum before secret or fetch", async () => {
  const bytes = Buffer.from(PNG_1X1, "base64");
  const sourceImage = { bytes, contentType: "image/png" };
  let reads = 0;
  let fetches = 0;
  const gateway = createSub2ApiAdapter({
    readSecret: () => { reads += 1; return secret; },
    fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
  });
  await assert.rejects(gateway.createTextResponse(textInput({
    sourceImages: Array.from({ length: 121 }, () => sourceImage),
  })), (error) => error?.code === "AI_GATEWAY_REQUEST_INVALID" && error?.retryable === false);
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
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

test("production adapter rejects IPv4, IPv6 and localhost gateway boundaries before DNS, secret, or fetch", async () => {
  for (const baseUrl of [
    "http://localhost:8080/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.1/v1",
    "https://[::1]/v1",
    "https://[fc00::1]/v1",
    "https://[fe80::1]/v1",
    "https://[::ffff:8.8.8.8]/v1",
    "https://[::ffff:808:808]/v1",
    "https://[::808:808]/v1",
  ]) {
    let dnsReads = 0;
    let secretReads = 0;
    let fetches = 0;
    const gateway = adapter(async () => { fetches += 1; throw new Error("must not fetch"); }, {
      readSecret: () => { secretReads += 1; return secret; },
      resolveHostname: async () => { dnsReads += 1; return [{ address: "203.0.113.10", family: 4 }]; },
    });
    await assert.rejects(gateway.createTextResponse(textInput({ profile: { ...profile, baseUrl } })), {
      code: "AI_GATEWAY_PROFILE_INVALID",
    });
    assert.deepEqual({ dnsReads, secretReads, fetches }, { dnsReads: 0, secretReads: 0, fetches: 0 });
  }
});

test("adapter rejects a public hostname resolving to any private address before reading its secret", async () => {
  let secretReads = 0;
  let fetches = 0;
  const gateway = adapter(async () => { fetches += 1; throw new Error("must not fetch"); }, {
    readSecret: () => { secretReads += 1; return secret; },
    resolveHostname: async () => [
      { address: "203.0.113.10", family: 4 },
      { address: "fd00::4", family: 6 },
    ],
  });
  await assert.rejects(gateway.createTextResponse(textInput()), (error) =>
    error?.code === "AI_GATEWAY_PROFILE_INVALID" && error?.retryable === false);
  assert.equal(secretReads, 0);
  assert.equal(fetches, 0);
});

test("adapter rejects every IPv4-mapped or IPv4-compatible DNS answer before secret or fetch", async () => {
  for (const address of ["::ffff:8.8.8.8", "::ffff:808:808", "::808:808"]) {
    let dnsReads = 0;
    let secretReads = 0;
    let fetches = 0;
    const gateway = adapter(async () => { fetches += 1; throw new Error("must not fetch"); }, {
      readSecret: () => { secretReads += 1; return secret; },
      resolveHostname: async () => { dnsReads += 1; return [{ address, family: 6 }]; },
    });
    await assert.rejects(gateway.createTextResponse(textInput()), (error) =>
      error?.code === "AI_GATEWAY_PROFILE_INVALID" && error?.retryable === false);
    assert.deepEqual({ dnsReads, secretReads, fetches }, { dnsReads: 1, secretReads: 0, fetches: 0 }, address);
  }
});

test("production policy enforcement rejects an unapproved secret or exact gateway before transport", async () => {
  for (const options of [
    { allowedSecretEnvNames: [], allowedGatewayBaseUrls: [profile.baseUrl] },
    { allowedSecretEnvNames: [profile.apiKeyEnvName], allowedGatewayBaseUrls: [] },
    { allowedSecretEnvNames: ["SUB2API_OTHER_KEY"], allowedGatewayBaseUrls: [profile.baseUrl] },
    { allowedSecretEnvNames: [profile.apiKeyEnvName], allowedGatewayBaseUrls: ["https://other.example/v1"] },
  ]) {
    let reads = 0;
    let fetches = 0;
    const gateway = createSub2ApiAdapter({
      ...options,
      resolveHostname: publicDns,
      readSecret: () => { reads += 1; return secret; },
      fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
    });
    await assert.rejects(gateway.createTextResponse(textInput()), {
      code: "AI_GATEWAY_PROFILE_INVALID",
    });
    assert.deepEqual({ reads, fetches }, { reads: 0, fetches: 0 });
  }
});

test("gateway DNS is revalidated immediately before transport so a rebinding answer never receives authorization", async () => {
  let dnsReads = 0;
  let fetches = 0;
  const gateway = adapter(async () => {
    fetches += 1;
    throw new Error("transport must not run after rebinding");
  }, {
    resolveHostname: async () => (++dnsReads === 1
      ? [{ address: "203.0.113.10", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }]),
  });
  await assert.rejects(gateway.createTextResponse(textInput()), {
    code: "AI_GATEWAY_PROFILE_INVALID",
  });
  assert.equal(dnsReads, 2);
  assert.equal(fetches, 0);
});

test("returned image downloads run a fresh DNS boundary check", async () => {
  let dnsReads = 0;
  let fetches = 0;
  const gateway = adapter(async () => {
    fetches += 1;
    return jsonResponse({ data: [{ url: "https://gateway.example.test/tenant/v1/media/generated.png" }] });
  }, {
    resolveHostname: async () => (++dnsReads < 3
      ? [{ address: "203.0.113.10", family: 4 }]
      : [{ address: "10.0.0.9", family: 4 }]),
  });
  await assert.rejects(gateway.generateImage(imageInput({
    profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
  })), { code: "AI_GATEWAY_PROFILE_INVALID" });
  assert.equal(fetches, 1);
});

test("gateway timeout aborts a DNS resolution that never settles", async () => {
  const gateway = adapter(async () => { throw new Error("transport must not run"); }, {
    resolveHostname: () => new Promise(() => {}),
  });
  await assert.rejects(gateway.createTextResponse(textInput({ timeoutMs: 10 })), (error) =>
    error?.code === "GATEWAY_TIMEOUT" && error?.retryable === true);
});

test("adapter permits loopback HTTP only behind the explicit local gateway switch", async () => {
  let requested = "";
  const gateway = adapter(async (url) => {
    requested = String(url);
    return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }] });
  }, {
    allowLocalGateway: true,
    resolveHostname: async () => [{ address: "::1", family: 6 }],
  });
  const result = await gateway.createTextResponse(textInput({
    profile: { ...profile, baseUrl: "http://[::1]:8080/v1" },
  }));
  assert.equal(result.value.ok, true);
  assert.equal(requested, "http://[::1]:8080/v1/responses");
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
    [429, "AI_GATEWAY_RATE_LIMITED", true],
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

test("successful malformed structured text preserves the upstream request id and safe failing field", async () => {
  const gateway = adapter(async () => jsonResponse({
    output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":"not-a-boolean"}' }] }],
  }, { headers: { "x-request-id": "checker-http-1" } }));

  await assert.rejects(gateway.createTextResponse(textInput()), (error) => {
    assert.equal(error?.code, "INVALID_GATEWAY_RESPONSE");
    assert.equal(error?.requestId, "checker-http-1");
    assert.equal(error?.failureField, "/ok");
    return true;
  });
});

test("decoded base64 image limits are enforced before an oversized payload can be accepted", async () => {
  const gateway = createSub2ApiAdapter({
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: PNG_1X1 }] }),
    readSecret: () => secret,
    resolveHostname: publicDns,
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

test("idle watchdog lets a streamed image run beyond five minutes when complete JSON data frames keep arriving", async () => {
  const timers = manualTimers();
  const controller = new AbortController();
  const stream = controlledResponse("text/event-stream");
  const gateway = adapter(async () => stream.response, { timers });
  const pending = gateway.generateImage(imageInput({
    timeoutMs: undefined, idleTimeoutMs: 300_000, signal: controller.signal,
  }));
  try {
    await waitFor(() => assert.deepEqual(timers.delays(), [300_000]));
    timers.advanceBy(299_999);
    stream.enqueue([
      "event: response.image_generation_call.partial_image",
      `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_1X1}","partial_image_index":0}`,
      "",
      "",
    ].join("\n"));
    await waitFor(() => assert.equal(timers.setCalls(), 2));

    timers.advanceBy(299_999);
    stream.enqueue([
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}",
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n"));
    stream.close();

    const result = await pending;
    assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG_1X1, "base64"));
    assert.equal(timers.activeCount(), 0);
  } finally {
    controller.abort();
    if (timers.activeCount()) timers.advanceBy(300_000);
    await pending.catch(() => {});
  }
});

test("idle watchdog ignores byte noise partial frames and keep-alive comments, then aborts with safe delivery metadata", async () => {
  const timers = manualTimers();
  const controller = new AbortController();
  const stream = controlledResponse("text/event-stream");
  const gateway = adapter(async () => stream.response, { timers });
  const pending = gateway.generateImage(imageInput({
    timeoutMs: undefined, idleTimeoutMs: 300_000, signal: controller.signal,
  }));
  try {
    await waitFor(() => assert.deepEqual(timers.delays(), [300_000]));
    stream.enqueue("garbage bytes\n\n: keep-alive\n\ndata: {\"type\":\"response.completed\"");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.setCalls(), 1);

    timers.advanceBy(300_000);
    let settled = false;
    pending.catch(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    if (!settled) controller.abort();
    await assert.rejects(pending, (error) => {
      assert.equal(error?.code, "AI_GATEWAY_IDLE_TIMEOUT");
      assert.equal(error?.message, "AI 网关长时间没有有效响应");
      assert.equal(error?.deliveryState, "POSSIBLY_SENT");
      assert.equal(error?.retryAfterMs, null);
      assert.equal(Object.getOwnPropertyDescriptor(error, "deliveryState")?.writable, false);
      assert.equal(Object.getOwnPropertyDescriptor(error, "retryAfterMs")?.writable, false);
      return true;
    });
    assert.equal(stream.wasCancelled(), true);
    assert.equal(timers.activeCount(), 0);
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test("a complete valid JSON body ends the idle watchdog and malformed success remains possibly sent", async () => {
  const timers = manualTimers();
  const success = adapter(async () => jsonResponse({
    model: "gpt-text",
    output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
  }), { timers });
  assert.equal((await success.createTextResponse(textInput({
    timeoutMs: undefined, idleTimeoutMs: 300_000,
  }))).value.ok, true);
  assert.equal(timers.activeCount(), 0);

  const malformed = adapter(async () => jsonResponse({ output: [] }), { timers });
  await assert.rejects(malformed.createTextResponse(textInput({
    timeoutMs: undefined, idleTimeoutMs: 300_000,
  })), (error) => error?.code === "INVALID_GATEWAY_RESPONSE"
    && error?.deliveryState === "POSSIBLY_SENT" && error?.retryAfterMs === null);
  assert.equal(timers.activeCount(), 0);
});

test("caller cancellation wins an idle-timeout race and every exit path clears the injected timer", async () => {
  const timers = manualTimers();
  const controller = new AbortController();
  let fetchStarted = false;
  const gateway = adapter(async () => {
    fetchStarted = true;
    return new Promise(() => {});
  }, { timers });
  const pending = gateway.createTextResponse(textInput({
    timeoutMs: undefined,
    idleTimeoutMs: 300_000,
    signal: controller.signal,
  }));
  try {
    await waitFor(() => assert.equal(fetchStarted, true));
    timers.advanceBy(300_000);
    controller.abort();
    await assert.rejects(pending, (error) => error?.code === "GATEWAY_CANCELLED"
      && error?.deliveryState === "POSSIBLY_SENT" && error?.retryAfterMs === null);
    assert.equal(timers.activeCount(), 0);
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test("timeoutMs and idleTimeoutMs are mutually exclusive while total timeout keeps the admin code", async () => {
  let fetches = 0;
  const gateway = adapter(async () => { fetches += 1; return new Promise(() => {}); });
  await assert.rejects(gateway.createTextResponse(textInput({ idleTimeoutMs: 300_000 })), (error) =>
    error?.code === "AI_GATEWAY_REQUEST_INVALID" && error?.deliveryState === "NOT_SENT");
  assert.equal(fetches, 0);

  await assert.rejects(gateway.createTextResponse(textInput({ timeoutMs: 5, idleTimeoutMs: undefined })), (error) =>
    error?.code === "GATEWAY_TIMEOUT" && error?.deliveryState === "POSSIBLY_SENT");
});

test("HTTP rejection delivery state and Retry-After stay bounded safe and immutable", async () => {
  const sensitive = "private-retry-header-and-body";
  for (const [status, retryAfter, expectedCode, expectedDelivery, expectedRetryAfter] of [
    [401, undefined, "NON_RETRYABLE_AUTH", "NOT_SENT", null],
    [403, undefined, "NON_RETRYABLE_AUTH", "NOT_SENT", null],
    [404, undefined, "NON_RETRYABLE_GATEWAY", "NOT_SENT", null],
    [429, "120", "AI_GATEWAY_RATE_LIMITED", "NOT_SENT", 120_000],
    [429, "999999999", "AI_GATEWAY_RATE_LIMITED", "NOT_SENT", 86_400_000],
    [429, sensitive, "AI_GATEWAY_RATE_LIMITED", "NOT_SENT", 60_000],
    [500, undefined, "RETRYABLE_GATEWAY", "POSSIBLY_SENT", null],
  ]) {
    const gateway = adapter(async () => jsonResponse({ error: { message: sensitive } }, {
      status,
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter, "x-private": sensitive },
    }));
    await assert.rejects(gateway.createTextResponse(textInput()), (error) => {
      assert.equal(error?.code, expectedCode, status);
      assert.equal(error?.deliveryState, expectedDelivery, status);
      assert.equal(error?.retryAfterMs, expectedRetryAfter, status);
      assert.equal(Object.getOwnPropertyDescriptor(error, "deliveryState")?.writable, false);
      assert.equal(Object.getOwnPropertyDescriptor(error, "retryAfterMs")?.writable, false);
      assert.doesNotMatch(error?.message || "", new RegExp(sensitive));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(sensitive));
      return true;
    });
  }
});

test("pre-send validation is NOT_SENT while network and unexpected streamed EOF are POSSIBLY_SENT", async () => {
  let fetches = 0;
  const invalid = adapter(async () => { fetches += 1; return jsonResponse({}); });
  await assert.rejects(invalid.createTextResponse(textInput({ model: "wrong-model" })), (error) =>
    error?.code === "AI_GATEWAY_MODEL_MISMATCH" && error?.deliveryState === "NOT_SENT");
  assert.equal(fetches, 0);

  const network = adapter(async () => { throw new TypeError("private socket failure"); });
  await assert.rejects(network.createTextResponse(textInput()), (error) =>
    error?.code === "AI_GATEWAY_NETWORK_FAILED" && error?.deliveryState === "POSSIBLY_SENT");

  const eof = adapter(async () => new Response(
    "event: response.completed\ndata: {\"type\":\"response.completed\"",
    { headers: { "content-type": "text/event-stream" } },
  ));
  await assert.rejects(eof.generateImage(imageInput()), (error) =>
    error?.code === "AI_GATEWAY_UNEXPECTED_EOF" && error?.deliveryState === "POSSIBLY_SENT");
});

test("an explicit streamed model rejection is a NOT_SENT 404 revalidation signal", async () => {
  const gateway = adapter(async () => new Response([
    "event: response.failed",
    "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"model_not_found\"}}}",
    "",
  ].join("\n"), { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(gateway.generateImage(imageInput()), (error) =>
    error?.code === "NON_RETRYABLE_GATEWAY" && error?.status === 404
    && error?.deliveryState === "NOT_SENT" && error?.retryAfterMs === null);
});

test("complete SSE terminal frames settle and cancel a connection that never reaches physical EOF", async (t) => {
  await t.test("successful image completion returns immediately", async () => {
    const timers = manualTimers();
    const controller = new AbortController();
    const stream = controlledResponse("text/event-stream");
    const gateway = adapter(async () => stream.response, { timers });
    const pending = gateway.generateImage(imageInput({
      timeoutMs: undefined, idleTimeoutMs: 300_000, signal: controller.signal,
    }));
    let settled;
    pending.then((value) => { settled = { value }; }, (error) => { settled = { error }; });
    try {
      stream.enqueue([
        "event: response.output_item.done",
        `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","result":"${PNG_1X1}"}}`,
        "",
        "event: response.completed",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
      await waitFor(() => assert.ok(settled, "terminal success must not wait for TCP EOF"));
      assert.equal(settled.error, undefined);
      assert.deepEqual(Buffer.from(settled.value.bytes), Buffer.from(PNG_1X1, "base64"));
      assert.equal(stream.wasCancelled(), true);
      assert.equal(timers.activeCount(), 0);
    } finally {
      controller.abort();
      await pending.catch(() => {});
    }
  });

  for (const [name, event, expectedCode, expectedStatus] of [
    ["model_not_found", { type: "response.failed", response: { status: "failed", error: { code: "model_not_found" } } }, "NON_RETRYABLE_GATEWAY", 404],
    ["401", { type: "response.failed", response: { status: "failed", error: { status: 401 } } }, "NON_RETRYABLE_AUTH", 401],
    ["403", { type: "response.failed", response: { status: "failed", error: { status: 403 } } }, "NON_RETRYABLE_AUTH", 403],
    ["404", { type: "response.failed", response: { status: "failed", error: { status: 404 } } }, "NON_RETRYABLE_GATEWAY", 404],
    ["429", { type: "response.failed", response: { status: "failed", error: { status: 429 } } }, "AI_GATEWAY_RATE_LIMITED", 429],
  ]) {
    await t.test(`${name} rejection returns immediately as NOT_SENT`, async () => {
      const timers = manualTimers();
      const controller = new AbortController();
      const stream = controlledResponse("text/event-stream");
      const gateway = adapter(async () => stream.response, { timers });
      const pending = gateway.generateImage(imageInput({
        timeoutMs: undefined, idleTimeoutMs: 300_000, signal: controller.signal,
      }));
      let settled;
      pending.then((value) => { settled = { value }; }, (error) => { settled = { error }; });
      try {
        stream.enqueue(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`);
        await waitFor(() => assert.ok(settled, "terminal rejection must not wait for TCP EOF"));
        assert.equal(settled.value, undefined);
        assert.equal(settled.error?.code, expectedCode);
        assert.equal(settled.error?.status, expectedStatus);
        assert.equal(settled.error?.deliveryState, "NOT_SENT");
        assert.equal(stream.wasCancelled(), true);
        assert.equal(timers.activeCount(), 0);
      } finally {
        controller.abort();
        await pending.catch(() => {});
      }
    });
  }
});

test("repeated named DONE markers never count as JSON progress", async () => {
  const timers = manualTimers();
  const controller = new AbortController();
  const stream = controlledResponse("text/event-stream");
  const gateway = adapter(async () => stream.response, { timers });
  const pending = gateway.generateImage(imageInput({
    timeoutMs: undefined, idleTimeoutMs: 300_000, signal: controller.signal,
  }));
  try {
    await waitFor(() => assert.deepEqual(timers.delays(), [300_000]));
    for (let index = 0; index < 2; index += 1) {
      timers.advanceBy(100_000);
      stream.enqueue("event: response.failed\ndata: [DONE]\n\n");
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(timers.setCalls(), 1, "named DONE must not renew the idle timer");
    timers.advanceBy(100_000);
    await assert.rejects(pending, (error) => error?.code === "AI_GATEWAY_IDLE_TIMEOUT");
    assert.equal(timers.activeCount(), 0);
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test("429 Retry-After accepts only strict seconds or IMF-fixdate and otherwise exposes the 60 second default", async () => {
  const future = new Date(Date.now() + 48 * 60 * 60 * 1_000).toUTCString();
  for (const [header, expected] of [
    [undefined, 60_000],
    ["-1", 60_000],
    ["1.5", 60_000],
    ["+1", 60_000],
    ["private garbage", 60_000],
    ["999999999999999999999", 60_000],
    ["2026-08-28", 60_000],
    ["Sunday, 06-Nov-94 08:49:37 GMT", 60_000],
    ["Mon, 06 Nov 1994 08:49:37 GMT", 60_000],
    ["Sun, 32 Nov 1994 08:49:37 GMT", 60_000],
    ["120", 120_000],
    [future, 86_400_000],
    ["Sun, 06 Nov 1994 08:49:37 GMT", 0],
  ]) {
    const gateway = adapter(async () => jsonResponse({}, {
      status: 429,
      headers: header === undefined ? {} : { "retry-after": header },
    }));
    await assert.rejects(gateway.createTextResponse(textInput()), (error) => {
      assert.equal(error?.code, "AI_GATEWAY_RATE_LIMITED", header);
      assert.equal(error?.deliveryState, "NOT_SENT", header);
      assert.equal(error?.retryAfterMs, expected, header);
      return true;
    });
  }
});

test("cost-bearing requests may wait without an application deadline while caller cancellation remains active", async () => {
  let requestSignal;
  const completed = adapter(async (_url, init) => {
    requestSignal = init.signal;
    return jsonResponse({
      model: "gpt-text",
      output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
    });
  });
  assert.equal((await completed.createTextResponse(textInput({ timeoutMs: undefined }))).value.ok, true);
  assert.equal(requestSignal instanceof AbortSignal, true);
  assert.equal(requestSignal.aborted, false);

  const waiting = adapter(async (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const pending = waiting.createTextResponse(textInput({ timeoutMs: undefined, signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, (error) => error?.code === "GATEWAY_CANCELLED" && error?.retryable === false);
});

test("total timeout completes even when transport and body cleanup promises never settle", async () => {
  const ignoringTransport = adapter(async () => new Promise(() => {}));
  const transportResult = await Promise.race([
    ignoringTransport.createTextResponse(textInput({ timeoutMs: 10 })).catch((error) => error?.code),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  assert.equal(transportResult, "GATEWAY_TIMEOUT");

  let readerCancelled = false;
  const stalledReaderResponse = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader() {
        return {
          read: () => new Promise(() => {}),
          cancel() { readerCancelled = true; return new Promise(() => {}); },
          releaseLock() {},
        };
      },
    },
  };
  const stalledBody = adapter(async () => stalledReaderResponse);
  const bodyResult = await Promise.race([
    stalledBody.createTextResponse(textInput({ timeoutMs: 10 })).catch((error) => error?.code),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  assert.equal(bodyResult, "GATEWAY_TIMEOUT");
  assert.equal(readerCancelled, true);
});

test("redirect non-2xx header and oversized responses are abandoned without awaiting cleanup", async () => {
  const outcome = async (promise) => Promise.race([
    promise.then(() => "resolved", (error) => error?.code),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  const hangingBody = () => {
    let cancelled = false;
    return {
      body: {
        cancel() { cancelled = true; return new Promise(() => {}); },
        getReader() { throw new Error("must not read"); },
      },
      wasCancelled: () => cancelled,
    };
  };

  const redirectBody = hangingBody();
  const redirect = encryptedAdapter(async () => ({
    ok: false,
    status: 307,
    headers: new Headers({ location: "/tenant/v1/other" }),
    body: redirectBody.body,
  }), { resolveSecret: async () => secret });
  assert.equal(await outcome(redirect.listModels({
    connection, correlationId: "corr-models", requestKey: "request-models", timeoutMs: 500,
  })), "GATEWAY_REDIRECT_BLOCKED");
  assert.equal(redirectBody.wasCancelled(), true);

  const statusBody = hangingBody();
  const non2xx = adapter(async () => ({
    ok: false,
    status: 503,
    headers: new Headers(),
    body: statusBody.body,
  }));
  assert.equal(await outcome(non2xx.createTextResponse(textInput())), "RETRYABLE_GATEWAY");
  assert.equal(statusBody.wasCancelled(), true);

  const headerBody = hangingBody();
  const hostileHeader = adapter(async () => ({
    ok: true,
    status: 200,
    headers: { get() { throw new Error("unsafe header detail"); } },
    body: headerBody.body,
  }));
  assert.equal(await outcome(hostileHeader.createTextResponse(textInput())), "INVALID_GATEWAY_RESPONSE");
  assert.equal(headerBody.wasCancelled(), true);

  const oversizedBody = hangingBody();
  const oversized = adapter(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(2 * 1024 * 1024 + 1) }),
    body: oversizedBody.body,
  }));
  assert.equal(await outcome(oversized.createTextResponse(textInput())), "INVALID_GATEWAY_RESPONSE");
  assert.equal(oversizedBody.wasCancelled(), true);
});

test("async-iterator bodies are destroyed and returned on timeout without blocking the caller", async () => {
  let destroyed = false;
  let returned = false;
  const body = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
        return() { returned = true; return new Promise(() => {}); },
      };
    },
    destroy() { destroyed = true; },
  };
  const gateway = adapter(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body,
  }));
  const result = await Promise.race([
    gateway.createTextResponse(textInput({ timeoutMs: 10 })).catch((error) => error?.code),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  assert.equal(result, "GATEWAY_TIMEOUT");
  assert.equal(destroyed, true);
  assert.equal(returned, true);
});

function stalledBodyResponse({ contentType = "application/json", firstChunk = "" } = {}) {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      if (firstChunk) controller.enqueue(new TextEncoder().encode(firstChunk));
    },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(stream, { headers: { "content-type": contentType } }),
    wasCancelled: () => cancelled,
  };
}

test("timeouts and caller cancellation remain active after response headers while bodies stall", async () => {
  const textBody = stalledBodyResponse();
  const textGateway = adapter(async () => textBody.response);
  await assert.rejects(textGateway.createTextResponse(textInput({ timeoutMs: 5 })), (error) => error?.code === "GATEWAY_TIMEOUT");
  assert.equal(textBody.wasCancelled(), true);

  const sseBody = stalledBodyResponse({ contentType: "text/event-stream" });
  let markSseFetchStarted;
  const sseFetchStarted = new Promise((resolve) => { markSseFetchStarted = resolve; });
  const sseGateway = adapter(async () => {
    markSseFetchStarted();
    return sseBody.response;
  });
  const controller = new AbortController();
  const pending = sseGateway.generateImage(imageInput({ timeoutMs: 5_000, signal: controller.signal }));
  await sseFetchStarted;
  controller.abort();
  await assert.rejects(pending, (error) => error?.code === "GATEWAY_CANCELLED");
  assert.equal(sseBody.wasCancelled(), true);

  const imageBody = stalledBodyResponse({ contentType: "image/png", firstChunk: Buffer.from(PNG_1X1, "base64").subarray(0, 8) });
  let imageCall = 0;
  const imageGateway = adapter(async () => {
    imageCall += 1;
    return imageCall === 1
      ? jsonResponse({ data: [{ url: "https://gateway.example.test/tenant/v1/image.png" }] })
      : imageBody.response;
  });
  await assert.rejects(imageGateway.generateImage(imageInput({
    profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    timeoutMs: 5,
  })), (error) => error?.code === "GATEWAY_TIMEOUT");
  assert.equal(imageBody.wasCancelled(), true);
});

test("chunked JSON, SSE, and image bodies enforce byte limits and cancel their readers", async () => {
  const cases = [
    {
      kind: "json",
      create: (response) => createSub2ApiAdapter({ fetchImpl: async () => response, readSecret: () => secret, resolveHostname: publicDns, maxJsonBytes: 32 })
        .createTextResponse(textInput()),
      contentType: "application/json",
    },
    {
      kind: "sse",
      create: (response) => createSub2ApiAdapter({ fetchImpl: async () => response, readSecret: () => secret, resolveHostname: publicDns, maxSseBytes: 32 })
        .generateImage(imageInput()),
      contentType: "text/event-stream",
    },
  ];
  for (const entry of cases) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(64).fill(65)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": entry.contentType } });
    await assert.rejects(entry.create(response), (error) => error?.code === "INVALID_GATEWAY_RESPONSE", entry.kind);
    assert.equal(cancelled, true, entry.kind);
  }

  let call = 0;
  let cancelled = false;
  const imageGateway = createSub2ApiAdapter({
    readSecret: () => secret,
    resolveHostname: publicDns,
    maxImageBytes: 16,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return jsonResponse({ data: [{ url: "https://gateway.example.test/tenant/v1/oversize.png" }] });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(32).fill(65)); },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "image/png" } });
    },
  });
  await assert.rejects(imageGateway.generateImage(imageInput({
    profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
  })), (error) => error?.code === "INVALID_GATEWAY_RESPONSE");
  assert.equal(cancelled, true);
});

test("non-success returned-image responses are abandoned without waiting for body cleanup", async () => {
  let calls = 0;
  let cancelled = false;
  const gateway = adapter(async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({ data: [{ url: "https://gateway.example.test/tenant/v1/image.png" }] });
    }
    return {
      ok: false,
      status: 503,
      headers: new Headers(),
      body: { cancel() { cancelled = true; return new Promise(() => {}); } },
    };
  });
  const result = await Promise.race([
    gateway.generateImage(imageInput({
      profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    })).catch((error) => error?.code),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  assert.equal(result, "RETRYABLE_GATEWAY");
  assert.equal(cancelled, true);
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

test("logger failures never change successful results or stable gateway failures", async () => {
  for (const logger of [
    { info() { throw new Error("logger sync failure"); }, warn() {} },
    { info() { return Promise.reject(new Error("logger async failure")); }, warn() {} },
  ]) {
    let fetches = 0;
    const gateway = createSub2ApiAdapter({
      logger,
      readSecret: () => secret,
      resolveHostname: publicDns,
      fetchImpl: async () => {
        fetches += 1;
        return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }] });
      },
    });
    const result = await gateway.createTextResponse(textInput());
    assert.deepEqual(result.value, { ok: true });
    assert.equal(fetches, 1);
    await new Promise((resolve) => setImmediate(resolve));
  }

  let fetches = 0;
  const failingGateway = createSub2ApiAdapter({
    logger: { info() {}, warn() { throw new Error("logger masked stable error"); } },
    readSecret: () => secret,
    resolveHostname: publicDns,
    fetchImpl: async () => {
      fetches += 1;
      return jsonResponse({ error: { message: "private" } }, { status: 401 });
    },
  });
  await assert.rejects(
    failingGateway.createTextResponse(textInput()),
    (error) => error?.code === "NON_RETRYABLE_AUTH" && error?.status === 401,
  );
  assert.equal(fetches, 1);
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
    sourceImages: [{ bytes: Buffer.from(PNG_1X1, "base64"), contentType: "image/png" }],
    jsonSchema: {
      type: "object",
      properties: { matches: { type: "boolean" } },
      required: ["matches"],
      additionalProperties: false,
    },
  });
  assert.deepEqual(result.value, { matches: true });
  assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.match(body.input[0].content[2].image_url, /^data:image\/png;base64,/);
  const recorded = JSON.stringify(logs);
  assert.doesNotMatch(recorded, /data:image|iVBOR|inspect private image/);
});

test("explicit capability test performs reachability, structured text, and one decoded image probe", async () => {
  const providerIdentities = capabilityProviderIdentities;
  const calls = [];
  const prepared = [];
  const credentialResolutions = [];
  const sending = [];
  const completed = [];
  let reachabilityCancelled = false;
  const gateway = encryptedAdapter(async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (calls.length === 1) return new Response(new ReadableStream({
      cancel() { reachabilityCancelled = true; },
    }), { headers: { "x-request-id": "models-id" } });
    if (calls.length === 2) {
      return jsonResponse({
        id: "text-id",
        output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
      });
    }
    return jsonResponse({ id: "image-id", data: [{ b64_json: PNG_1X1 }] });
  }, {
    resolveSecret() { throw new Error("generic resolver must not authorize paid work"); },
    async prepareCapabilitySubcall(execution) {
      prepared.push(structuredClone(execution));
      return providerIdentities[execution.probe];
    },
    async resolveCapabilityCredential(execution) {
      credentialResolutions.push(structuredClone(execution));
      return { accountId: "account-a", profileId: "profile-1", configVersion: 7,
        connectionId: "connection-a", connectionVersion: 3,
        ...providerIdentities[execution.probe], secret };
    },
    async markCapabilitySubcallSending(execution) {
      sending.push(structuredClone(execution));
      return providerIdentities[execution.probe];
    },
    async completeCapabilitySubcall(execution, outcome, reason) {
      completed.push([structuredClone(execution), outcome, reason]);
      return { terminal: true };
    },
  });

  const result = await gateway.testCapabilities({
    profile: { ...encryptedProfile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    timeoutMs: 500,
    capabilityExecution,
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://gateway.example.test/tenant/v1/models",
    "https://gateway.example.test/tenant/v1/responses",
    "https://gateway.example.test/tenant/v1/images/edits",
  ]);
  assert.deepEqual(calls.map((call) => call.headers["Idempotency-Key"]), [
    providerIdentities.REACHABILITY.providerRequestKey,
    providerIdentities.TEXT.providerRequestKey,
    providerIdentities.IMAGE.providerRequestKey,
  ]);
  assert.deepEqual(calls.map((call) => call.headers["X-Correlation-Id"]), [
    providerIdentities.REACHABILITY.providerCorrelationId,
    providerIdentities.TEXT.providerCorrelationId,
    providerIdentities.IMAGE.providerCorrelationId,
  ]);
  assert.deepEqual(result.features, ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"]);
  assert.deepEqual(result.models, { text: "gpt-text", image: "gpt-image" });
  assert.deepEqual(result.requestIds, { reachability: "models-id", text: "text-id", image: "image-id" });
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
  assert.match(calls[2].body.images[0].image_url, /^data:image\/png;base64,/);
  assert.deepEqual(result.modelEvidence, {
    requestedImageModel: "gpt-image",
    gatewayReportedImageModel: "",
    gatewayReportedImageModelPresent: false,
    orchestratorModel: "",
  });
  assert.equal(reachabilityCancelled, true);
  assert.deepEqual(prepared.map(({ probe }) => probe), ["REACHABILITY", "TEXT", "IMAGE"]);
  assert.deepEqual(credentialResolutions.map(({ probe }) => probe), ["REACHABILITY", "TEXT", "IMAGE"]);
  assert.equal(credentialResolutions.every(({ probe, ...execution }) =>
    JSON.stringify(execution) === JSON.stringify(capabilityExecution)), true);
  assert.deepEqual(sending.map(({ probe }) => probe), ["REACHABILITY", "TEXT", "IMAGE"]);
  assert.deepEqual(completed.map(([{ probe }, outcome, reason]) => [probe, outcome, reason]), [
    ["REACHABILITY", "SUCCEEDED", "PROVIDER_ACCEPTED"],
    ["TEXT", "SUCCEEDED", "PROVIDER_ACCEPTED"],
    ["IMAGE", "SUCCEEDED", "PROVIDER_ACCEPTED"],
  ]);
});

test("capability test rejects independent request identity before DNS or network", async () => {
  let preparations = 0;
  let resolutions = 0;
  let fetches = 0;
  const gateway = encryptedAdapter(async () => { fetches += 1; throw new Error("must not fetch"); }, {
    async prepareCapabilitySubcall() { preparations += 1; throw new Error("must not prepare"); },
    async resolveCapabilityCredential() { resolutions += 1; throw new Error("must not resolve"); },
    async markCapabilitySubcallSending() { throw new Error("must not mark"); },
    async completeCapabilitySubcall() { throw new Error("must not complete"); },
  });
  await assert.rejects(gateway.testCapabilities({
    profile: { ...encryptedProfile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    correlationId: "caller-controlled-correlation", requestKey: "caller-controlled-key",
    timeoutMs: 500, capabilityExecution,
  }), { code: "AI_GATEWAY_REQUEST_INVALID" });
  assert.deepEqual({ preparations, resolutions, fetches }, { preparations: 0, resolutions: 0, fetches: 0 });
});

test("capability reservation becomes terminal when DNS rejects after PREPARED", async () => {
  let fetches = 0;
  let sending = 0;
  const completed = [];
  const gateway = encryptedAdapter(async () => {
    fetches += 1;
    throw new Error("must not fetch");
  }, {
    resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
    async prepareCapabilitySubcall(execution) {
      return capabilityProviderIdentities[execution.probe];
    },
    async resolveCapabilityCredential(execution) {
      return { accountId: "account-a", profileId: "profile-1", configVersion: 7,
        connectionId: "connection-a", connectionVersion: 3,
        ...capabilityProviderIdentities[execution.probe], secret };
    },
    async markCapabilitySubcallSending() {
      sending += 1;
      throw new Error("must not mark SENDING after DNS rejection");
    },
    async completeCapabilitySubcall(execution, outcome, reason) {
      completed.push([execution.probe, outcome, reason]);
      return { terminal: true };
    },
  });

  await assert.rejects(gateway.testCapabilities({
    profile: { ...encryptedProfile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    timeoutMs: 500,
    capabilityExecution,
  }), { code: "AI_GATEWAY_PROFILE_INVALID" });
  assert.deepEqual({ fetches, sending }, { fetches: 0, sending: 0 });
  assert.deepEqual(completed, [["REACHABILITY", "FAILED", "PRE_SEND_FAILED"]]);
});

test("prepared capability ownership settles secret failure before any DNS or transport", async () => {
  const prepared = [];
  const completed = [];
  let dnsReads = 0;
  let fetches = 0;
  const gateway = encryptedAdapter(async () => {
    fetches += 1;
    throw new Error("must not fetch");
  }, {
    resolveHostname: async () => { dnsReads += 1; return publicDns(); },
    async prepareCapabilitySubcall(execution) {
      prepared.push(execution.probe);
      return capabilityProviderIdentities[execution.probe];
    },
    async resolveCapabilityCredential() {
      throw Object.assign(new Error("decrypt failed"), { code: "AI_GATEWAY_SECRET_MISSING" });
    },
    async markCapabilitySubcallSending() { throw new Error("must not mark"); },
    async completeCapabilitySubcall(execution, outcome, reason) {
      completed.push([execution.probe, outcome, reason]);
      return { terminal: true };
    },
  });

  await assert.rejects(gateway.testCapabilities({
    profile: { ...encryptedProfile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    timeoutMs: 500, capabilityExecution,
  }), { code: "AI_GATEWAY_SECRET_MISSING" });
  assert.deepEqual({ prepared, completed, dnsReads, fetches }, {
    prepared: ["REACHABILITY"],
    completed: [["REACHABILITY", "FAILED", "PRE_SEND_FAILED"]],
    dnsReads: 0,
    fetches: 0,
  });
});

test("an uncertain PREPARED commit response never terminals the attempt as a credential failure", async () => {
  let completions = 0;
  let fetches = 0;
  const gateway = encryptedAdapter(async () => {
    fetches += 1;
    throw new Error("must not fetch");
  }, {
    async prepareCapabilitySubcall() {
      throw Object.assign(new Error("prepared commit response unknown"), {
        code: "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", retryable: true,
      });
    },
    async resolveCapabilityCredential() { throw new Error("must not resolve"); },
    async markCapabilitySubcallSending() { throw new Error("must not mark"); },
    async completeCapabilitySubcall() { completions += 1; },
  });

  await assert.rejects(gateway.testCapabilities({
    profile: { ...encryptedProfile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    timeoutMs: 500, capabilityExecution,
  }), { code: "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", retryable: true });
  assert.deepEqual({ completions, fetches }, { completions: 0, fetches: 0 });
});

test("abort before SENDING terminals PREPARED while abort after SENDING stays reclaimable", async () => {
  for (const abortPoint of ["before-sending", "after-sending"]) {
    const controller = new AbortController();
    const completed = [];
    let marks = 0;
    let fetches = 0;
    const gateway = encryptedAdapter(async () => {
      fetches += 1;
      throw new Error("transport must not start after abort");
    }, {
      resolveHostname: async () => {
        if (abortPoint === "before-sending") controller.abort();
        return publicDns();
      },
      async prepareCapabilitySubcall(execution) {
        return capabilityProviderIdentities[execution.probe];
      },
      async resolveCapabilityCredential(execution) {
        return { accountId: "account-a", profileId: "profile-1", configVersion: 7,
          connectionId: "connection-a", connectionVersion: 3,
          ...capabilityProviderIdentities[execution.probe], secret };
      },
      async markCapabilitySubcallSending(execution) {
        marks += 1;
        if (abortPoint === "after-sending") controller.abort();
        return capabilityProviderIdentities[execution.probe];
      },
      async completeCapabilitySubcall(execution, outcome, reason) {
        completed.push([execution.probe, outcome, reason]);
        return { terminal: true };
      },
    });
    const expectedCode = abortPoint === "before-sending"
      ? "GATEWAY_CANCELLED" : "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN";
    await assert.rejects(gateway.testCapabilities({
      profile: { ...encryptedProfile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
      timeoutMs: 500, signal: controller.signal, capabilityExecution,
    }), { code: expectedCode });
    assert.equal(fetches, 0);
    if (abortPoint === "before-sending") {
      assert.deepEqual({ marks, completed }, {
        marks: 0, completed: [["REACHABILITY", "FAILED", "PRE_SEND_ABORTED"]],
      });
    } else {
      assert.deepEqual({ marks, completed }, { marks: 1, completed: [] });
    }
  }
});

test("a PREPARED terminal-write failure stays unknown and reclaimable instead of failing the paid attempt", async () => {
  let terminalWrites = 0;
  let fetches = 0;
  const gateway = encryptedAdapter(async () => {
    fetches += 1;
    throw new Error("must not fetch");
  }, {
    async prepareCapabilitySubcall(execution) {
      return capabilityProviderIdentities[execution.probe];
    },
    async resolveCapabilityCredential() {
      throw Object.assign(new Error("decrypt failed"), { code: "AI_GATEWAY_SECRET_MISSING" });
    },
    async markCapabilitySubcallSending() { throw new Error("must not mark"); },
    async completeCapabilitySubcall(_execution, outcome, reason) {
      terminalWrites += 1;
      assert.deepEqual([outcome, reason], ["FAILED", "PRE_SEND_FAILED"]);
      throw Object.assign(new Error("terminal write result unknown"), {
        code: "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED",
      });
    },
  });

  await assert.rejects(gateway.testCapabilities({
    profile: { ...encryptedProfile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    timeoutMs: 500, capabilityExecution,
  }), { code: "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", retryable: true });
  assert.deepEqual({ terminalWrites, fetches }, { terminalWrites: 1, fetches: 0 });
});

test("recovered SENDING stays unknown when secret DNS or abort fails before same-key resend", async () => {
  for (const failurePoint of ["secret", "dns", "abort"]) {
    const controller = new AbortController();
    let fetches = 0;
    let marks = 0;
    const settlements = [];
    const gateway = encryptedAdapter(async () => {
      fetches += 1;
      throw new Error("recovered send must not reach transport after a pre-send failure");
    }, {
      resolveHostname: async () => {
        if (failurePoint === "abort") controller.abort();
        return failurePoint === "dns" ? [{ address: "127.0.0.1", family: 4 }] : publicDns();
      },
      async prepareCapabilitySubcall(execution) {
        return capabilityProviderIdentities[execution.probe];
      },
      async resolveCapabilityCredential(execution) {
        if (failurePoint === "secret") {
          throw Object.assign(new Error("recovered decrypt failed"), { code: "AI_GATEWAY_SECRET_MISSING" });
        }
        return { accountId: "account-a", profileId: "profile-1", configVersion: 7,
          connectionId: "connection-a", connectionVersion: 3,
          ...capabilityProviderIdentities[execution.probe], secret };
      },
      async markCapabilitySubcallSending() {
        marks += 1;
        throw new Error("must not mark before recovered pre-send failure");
      },
      async completeCapabilitySubcall(execution, outcome, reason) {
        settlements.push([execution.probe, outcome, reason]);
        throw Object.assign(new Error("historical provider send remains unresolved"), {
          code: "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", retryable: true,
        });
      },
    });
    await assert.rejects(gateway.testCapabilities({
      profile: { ...encryptedProfile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
      timeoutMs: 500, signal: controller.signal, capabilityExecution,
    }), { code: "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", retryable: true });
    assert.equal(fetches, 0);
    assert.equal(marks, 0);
    assert.deepEqual(settlements, [["REACHABILITY", "FAILED",
      failurePoint === "abort" ? "PRE_SEND_ABORTED" : "PRE_SEND_FAILED"]]);
  }
});

test("provider 2xx plus completion persistence ambiguity never rewrites the stage FAILED", async () => {
  const settlements = [];
  let fetches = 0;
  const gateway = encryptedAdapter(async () => {
    fetches += 1;
    return jsonResponse({ object: "list", data: [] });
  }, {
    async prepareCapabilitySubcall(execution) {
      return capabilityProviderIdentities[execution.probe];
    },
    async resolveCapabilityCredential(execution) {
      return { accountId: "account-a", profileId: "profile-1", configVersion: 7,
        connectionId: "connection-a", connectionVersion: 3,
        ...capabilityProviderIdentities[execution.probe], secret };
    },
    async markCapabilitySubcallSending(execution) {
      return capabilityProviderIdentities[execution.probe];
    },
    async completeCapabilitySubcall(execution, outcome, reason) {
      settlements.push([execution.probe, outcome, reason]);
      throw Object.assign(new Error("completion result unknown"), {
        code: "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED",
      });
    },
  });

  await assert.rejects(gateway.testCapabilities({
    profile: { ...encryptedProfile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    timeoutMs: 500, capabilityExecution,
  }), { code: "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", retryable: true });
  assert.equal(fetches, 1);
  assert.deepEqual(settlements, [["REACHABILITY", "SUCCEEDED", "PROVIDER_ACCEPTED"]]);
});

test("capability test has no generic secret or network fallback without persisted execution authority", async () => {
  let reads = 0;
  let fetches = 0;
  const gateway = adapter(async () => { fetches += 1; throw new Error("must not fetch"); }, {
    readSecret() { reads += 1; return secret; },
  });
  await assert.rejects(gateway.testCapabilities({
    profile: { ...profile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    correlationId: "corr-capability-no-authority", requestKey: "capability-no-authority", timeoutMs: 500,
  }), { code: "AI_GATEWAY_REQUEST_INVALID" });
  assert.deepEqual({ reads, fetches }, { reads: 0, fetches: 0 });
});

test("capability execution fence changes stop every later paid probe before network", async () => {
  let fetches = 0;
  let resolutions = 0;
  const gateway = encryptedAdapter(async () => {
    fetches += 1;
    return jsonResponse({ object: "list", data: [] });
  }, {
    resolveSecret() { throw new Error("generic resolver must not authorize paid work"); },
    async prepareCapabilitySubcall(execution) {
      return capabilityProviderIdentities[execution.probe];
    },
    async resolveCapabilityCredential(execution) {
      resolutions += 1;
      if (resolutions > 1) {
        const error = new Error("connection status fence changed");
        error.code = "AI_GATEWAY_PROFILE_VERSION_CONFLICT";
        throw error;
      }
      return { accountId: "account-a", profileId: "profile-1", configVersion: 7,
        connectionId: "connection-a", connectionVersion: 3,
        ...capabilityProviderIdentities[execution.probe], secret };
    },
    async markCapabilitySubcallSending(execution) {
      return capabilityProviderIdentities[execution.probe];
    },
    async completeCapabilitySubcall() { return { terminal: true }; },
  });
  await assert.rejects(gateway.testCapabilities({
    profile: { ...encryptedProfile, enabled: false, imageProtocol: "SUB2API_OPENAI_IMAGES" },
    timeoutMs: 500, capabilityExecution,
  }), { code: "AI_GATEWAY_PROFILE_VERSION_CONFLICT" });
  assert.deepEqual({ resolutions, fetches }, { resolutions: 2, fetches: 1 });
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
  }, { async prepareCapabilitySubcall(execution) {
    return capabilityProviderIdentities[execution.probe];
  }, async resolveCapabilityCredential(execution) {
    return { accountId: "account-a", profileId: "profile-1", configVersion: 7,
      connectionId: null, connectionVersion: null,
      ...capabilityProviderIdentities[execution.probe], secret };
  }, async markCapabilitySubcallSending(execution) {
    return capabilityProviderIdentities[execution.probe];
  }, async completeCapabilitySubcall() { return { terminal: true }; } });
  await assert.rejects(
    gateway.testCapabilities({
      profile: { ...profile, imageProtocol: "SUB2API_OPENAI_IMAGES" },
      timeoutMs: 500,
      capabilityExecution: legacyCapabilityExecution,
    }),
    (error) => error?.code === "INVALID_GATEWAY_RESPONSE",
  );
});

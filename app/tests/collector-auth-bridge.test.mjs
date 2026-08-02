import assert from "node:assert/strict";
import test from "node:test";
import * as collectorAuthBridge from "../src/collector-auth-bridge.js";

const {
  COLLECTOR_AUTH_ACTIONS,
  COLLECTOR_AUTH_PROTOCOL,
  createCollectorAuthGenerationController,
  installCollectorAuthBridge,
  isCollectorAuthGenerationId,
  normalizeCollectorAuthRequest,
  postCollectorAuthLogout,
} = collectorAuthBridge;

const createWindowHarness = () => {
  const listeners = new Map();
  const posts = [];
  const windowObject = {
    location: { origin: "http://127.0.0.1:3000" },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    postMessage(payload, targetOrigin) {
      posts.push({ payload, targetOrigin });
    },
  };
  return {
    windowObject,
    posts,
    dispatch(data, overrides = {}) {
      return listeners.get("message")?.({
        source: windowObject,
        origin: windowObject.location.origin,
        data,
        ...overrides,
      });
    },
    hasListener: () => listeners.has("message"),
  };
};

test("publishes the exact credential-free ready envelope only when the Web account is logged in", () => {
  const loggedInHarness = createWindowHarness();
  installCollectorAuthBridge({
    windowObject: loggedInHarness.windowObject,
    generationId: "generation_A_1234",
    isLoggedIn: () => true,
    requestTicket: async () => ({}),
  });
  const { posts } = loggedInHarness;
  assert.deepEqual(posts, [{
    payload: {
      protocol: "SONLI_COLLECTOR_AUTH",
      action: "collector.auth.ready",
      generationId: "generation_A_1234",
    },
    targetOrigin: "http://127.0.0.1:3000",
  }]);
  assert.deepEqual(Object.keys(posts[0].payload).sort(), ["action", "generationId", "protocol"]);

  const loggedOutHarness = createWindowHarness();
  installCollectorAuthBridge({
    windowObject: loggedOutHarness.windowObject,
    generationId: "generation_A_1234",
    isLoggedIn: () => false,
    requestTicket: async () => ({}),
  });
  assert.deepEqual(loggedOutHarness.posts, []);
});

test("does not republish ready when the login generation was already announced", () => {
  const harness = createWindowHarness();
  const installForSameLogin = (announceReady) => installCollectorAuthBridge({
    windowObject: harness.windowObject,
    generationId: "generation_A_1234",
    isLoggedIn: () => true,
    requestTicket: async () => ({}),
    announceReady,
  });

  const uninstallFirst = installForSameLogin(true);
  uninstallFirst();
  installForSameLogin(false);

  assert.deepEqual(harness.posts, [{
    payload: {
      protocol: "SONLI_COLLECTOR_AUTH",
      action: "collector.auth.ready",
      generationId: "generation_A_1234",
    },
    targetOrigin: "http://127.0.0.1:3000",
  }]);
});

test("creates one random generation per stable Web login and emits logout on account transitions", () => {
  const generations = ["generation_A_1234", "generation_B_5678", "generation_C_9012"];
  const controller = createCollectorAuthGenerationController({
    createGenerationId: () => generations.shift(),
  });

  assert.deepEqual(controller.update("account-a"), {
    generationId: "generation_A_1234",
    logoutGenerationId: "",
    announceReady: true,
  });
  assert.deepEqual(controller.update("account-a"), {
    generationId: "generation_A_1234",
    logoutGenerationId: "",
    announceReady: false,
  });
  assert.deepEqual(controller.update("account-b"), {
    generationId: "generation_B_5678",
    logoutGenerationId: "generation_A_1234",
    announceReady: true,
  });
  assert.deepEqual(controller.update(""), {
    generationId: "",
    logoutGenerationId: "generation_B_5678",
    announceReady: false,
  });
  assert.equal(controller.update("account-a").generationId, "generation_C_9012");
});

test("rejects unsafe generation IDs and retries creation on the next logged-in update", () => {
  const invalidGenerationIds = [
    "",
    "x".repeat(15),
    "x".repeat(129),
    "generation with space",
    "generation/with-slash",
  ];
  for (const invalidGenerationId of invalidGenerationIds) {
    assert.equal(isCollectorAuthGenerationId(invalidGenerationId), false);
    const controller = createCollectorAuthGenerationController({
      createGenerationId: (() => {
        const values = [invalidGenerationId, "generation_A_1234"];
        return () => values.shift();
      })(),
    });
    assert.deepEqual(controller.update("account-a"), {
      generationId: "",
      logoutGenerationId: "",
      announceReady: false,
    });
    assert.deepEqual(controller.update("account-a"), {
      generationId: "generation_A_1234",
      logoutGenerationId: "",
      announceReady: true,
    });
  }
  assert.equal(isCollectorAuthGenerationId("generation_A_1234"), true);
});

test("uses Web Crypto without passing the account ID to the production generation factory", () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const calls = [];
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID(...args) {
        calls.push(args);
        return "generation_A_1234";
      },
    },
  });
  try {
    const controller = createCollectorAuthGenerationController();
    assert.equal(controller.update("account-a").generationId, "generation_A_1234");
    assert.deepEqual(calls, [[]]);
  } finally {
    Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  }
});

test("posts the exact logout envelope through the origin-scoped send adapter", () => {
  const harness = createWindowHarness();
  const posted = postCollectorAuthLogout({
    generationId: "generation_A_1234",
    windowObject: harness.windowObject,
  });
  assert.equal(posted, true);
  assert.deepEqual(harness.posts, [{
    payload: {
      protocol: "SONLI_COLLECTOR_AUTH",
      action: "collector.auth.logout",
      generationId: "generation_A_1234",
    },
    targetOrigin: "http://127.0.0.1:3000",
  }]);
  assert.equal(postCollectorAuthLogout({ generationId: "unsafe id", windowObject: harness.windowObject }), false);
});

test("normalizes only an exact collector request envelope and bounded requestId", () => {
  const arrayEnvelope = [];
  arrayEnvelope.protocol = COLLECTOR_AUTH_PROTOCOL;
  arrayEnvelope.action = COLLECTOR_AUTH_ACTIONS.request;
  arrayEnvelope.requestId = "request-array";
  assert.equal(normalizeCollectorAuthRequest(arrayEnvelope), null);

  assert.deepEqual(
    normalizeCollectorAuthRequest({
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.request,
      requestId: "request-1",
      token: "must-not-pass",
    }),
    null,
  );
  for (const message of [
    null,
    {},
    { protocol: "SONLI_WEB_CONTROL", action: COLLECTOR_AUTH_ACTIONS.request, requestId: "request-1" },
    { protocol: COLLECTOR_AUTH_PROTOCOL, action: "syncAuthFromWeb", requestId: "request-1" },
    { protocol: COLLECTOR_AUTH_PROTOCOL, action: COLLECTOR_AUTH_ACTIONS.request, requestId: "" },
    { protocol: COLLECTOR_AUTH_PROTOCOL, action: COLLECTOR_AUTH_ACTIONS.request, requestId: "x".repeat(129) },
    { protocol: COLLECTOR_AUTH_PROTOCOL, action: COLLECTOR_AUTH_ACTIONS.request, requestId: "request-1", storeId: "must-not-pass" },
  ]) {
    assert.equal(normalizeCollectorAuthRequest(message), null);
  }
});

test("responds only to an exact same-window, same-origin request while logged in", async () => {
  const harness = createWindowHarness();
  const responses = [];
  let ticketRequests = 0;
  const uninstall = installCollectorAuthBridge({
    windowObject: harness.windowObject,
    generationId: "generation_A_1234",
    isLoggedIn: () => true,
    requestTicket: async () => {
      ticketRequests += 1;
      return {
        ticket: "ctt_one_time_secret_123456789",
        expiresAt: "2099-01-01T00:00:00.000Z",
        token: "web-bearer-must-not-leak",
        storeId: "store-must-not-leak",
      };
    },
    postResponse: (payload) => responses.push(payload),
  });

  const request = {
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.request,
    requestId: "request-2",
  };
  await harness.dispatch(request, { source: {} });
  await harness.dispatch(request, { origin: "https://evil.example" });
  assert.equal(ticketRequests, 0);

  await harness.dispatch(request);
  assert.equal(ticketRequests, 1);
  assert.deepEqual(responses, [
    {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.ready,
      generationId: "generation_A_1234",
    },
    {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.response,
      requestId: "request-2",
      ticket: "ctt_one_time_secret_123456789",
      expiresAt: "2099-01-01T00:00:00.000Z",
      generationId: "generation_A_1234",
    },
  ]);
  assert.equal(JSON.stringify(responses).includes("web-bearer"), false);
  assert.equal(JSON.stringify(responses).includes("store-must"), false);

  uninstall();
  assert.equal(harness.hasListener(), false);
});

test("responds with the generation captured by the bridge that received the request", async () => {
  const harness = createWindowHarness();
  const responses = [];
  let resolveTicket;
  const firstBridge = installCollectorAuthBridge({
    windowObject: harness.windowObject,
    generationId: "generation_A_1234",
    isLoggedIn: () => true,
    requestTicket: () => new Promise((resolve) => { resolveTicket = resolve; }),
    postResponse: (payload) => responses.push(payload),
  });
  const pendingResponse = harness.dispatch({
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.request,
    requestId: "request-stale",
  });
  firstBridge();
  installCollectorAuthBridge({
    windowObject: harness.windowObject,
    generationId: "generation_B_5678",
    isLoggedIn: () => true,
    requestTicket: async () => ({}),
    announceReady: false,
    postResponse: (payload) => responses.push(payload),
  });
  resolveTicket({ ticket: "ctt_one_time_secret_123456789", expiresAt: "2099-01-01T00:00:00.000Z" });
  await pendingResponse;

  const ticketResponse = responses.find((payload) => payload.action === COLLECTOR_AUTH_ACTIONS.response);
  assert.equal(ticketResponse.generationId, "generation_A_1234");
  assert.equal(JSON.stringify(responses).includes("account-a"), false);
});

test("does not request or post a ticket when the Web account is logged out", async () => {
  const harness = createWindowHarness();
  let ticketRequests = 0;
  const responses = [];
  installCollectorAuthBridge({
    windowObject: harness.windowObject,
    generationId: "generation_A_1234",
    isLoggedIn: () => false,
    requestTicket: async () => {
      ticketRequests += 1;
      return {};
    },
    postResponse: (payload) => responses.push(payload),
  });

  await harness.dispatch({
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.request,
    requestId: "request-3",
  });
  assert.equal(ticketRequests, 0);
  assert.deepEqual(responses, []);
});

test("requires a valid generation when installing the bridge", () => {
  const harness = createWindowHarness();
  assert.throws(() => installCollectorAuthBridge({
    windowObject: harness.windowObject,
    generationId: "too-short",
    isLoggedIn: () => true,
    requestTicket: async () => ({}),
  }), /generation/i);
});

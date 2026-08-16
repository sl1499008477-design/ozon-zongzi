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
  startCollectorAuthBridgeLifecycle,
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

const createDeferred = () => {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
};

test("publishes V2 ready before the byte-for-byte legacy ready envelope only when the Web account is logged in", () => {
  const loggedInHarness = createWindowHarness();
  installCollectorAuthBridge({
    windowObject: loggedInHarness.windowObject,
    accountId: "account-a",
    generationId: "generation_A_1234",
    isLoggedIn: () => true,
    requestTicket: async () => ({}),
  });
  const { posts } = loggedInHarness;
  assert.deepEqual(posts, [
    {
      payload: {
        protocol: "SONLI_COLLECTOR_AUTH",
        action: "collector.auth.ready.v2",
        generationId: "generation_A_1234",
        accountId: "account-a",
      },
      targetOrigin: "http://127.0.0.1:3000",
    },
    {
      payload: {
        protocol: "SONLI_COLLECTOR_AUTH",
        action: "collector.auth.ready",
        generationId: "generation_A_1234",
      },
      targetOrigin: "http://127.0.0.1:3000",
    },
  ]);
  assert.deepEqual(Object.keys(posts[0].payload).sort(), ["accountId", "action", "generationId", "protocol"]);
  assert.deepEqual(Object.keys(posts[1].payload).sort(), ["action", "generationId", "protocol"]);

  const loggedOutHarness = createWindowHarness();
  installCollectorAuthBridge({
    windowObject: loggedOutHarness.windowObject,
    accountId: "account-a",
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
    accountId: "account-a",
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
      action: "collector.auth.ready.v2",
      generationId: "generation_A_1234",
      accountId: "account-a",
    },
    targetOrigin: "http://127.0.0.1:3000",
  }, {
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
  assert.equal(isCollectorAuthGenerationId("x".repeat(15)), false);
  assert.equal(isCollectorAuthGenerationId("x".repeat(16)), true);
  assert.equal(isCollectorAuthGenerationId("x".repeat(128)), true);
  assert.equal(isCollectorAuthGenerationId("x".repeat(129)), false);
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

test("retires the old account generation when its successor factory throws and retries later", () => {
  let factoryCalls = 0;
  const controller = createCollectorAuthGenerationController({
    createGenerationId() {
      factoryCalls += 1;
      if (factoryCalls === 1) return "generation_A_1234";
      if (factoryCalls === 2) throw new Error("simulated Web Crypto failure");
      return "generation_B_5678";
    },
  });

  assert.deepEqual(controller.update("account-a"), {
    generationId: "generation_A_1234",
    logoutGenerationId: "",
    announceReady: true,
  });
  assert.deepEqual(controller.update("account-b"), {
    generationId: "",
    logoutGenerationId: "generation_A_1234",
    announceReady: false,
  });
  assert.deepEqual(controller.update("account-b"), {
    generationId: "generation_B_5678",
    logoutGenerationId: "",
    announceReady: true,
  });
  assert.deepEqual(controller.update("account-b"), {
    generationId: "generation_B_5678",
    logoutGenerationId: "",
    announceReady: false,
  });
});

test("retries a missing Web generation once after retiring the old bridge and cancels pending recovery on cleanup", () => {
  const createRecoveringController = () => {
    let factoryCalls = 0;
    return createCollectorAuthGenerationController({
      createGenerationId() {
        factoryCalls += 1;
        if (factoryCalls === 1) return "generation_A_1234";
        if (factoryCalls === 2) throw new Error("simulated Web Crypto failure");
        return "generation_B_5678";
      },
    });
  };
  const timers = [];
  const installs = [];
  const logouts = [];
  const setTimer = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (timer) => {
    timer.cleared = true;
  };
  const installBridge = (transition) => {
    installs.push(transition);
    return () => {};
  };

  const controller = createRecoveringController();
  startCollectorAuthBridgeLifecycle({
    accountId: "account-a",
    controller,
    installBridge,
    postLogout: (generationId) => logouts.push(generationId),
    setTimer,
    clearTimer,
  })();

  const cleanupB = startCollectorAuthBridgeLifecycle({
    accountId: "account-b",
    controller,
    installBridge,
    postLogout: (generationId) => logouts.push(generationId),
    setTimer,
    clearTimer,
  });

  assert.deepEqual(logouts, ["generation_A_1234"]);
  assert.deepEqual(installs.map(({ generationId }) => generationId), ["generation_A_1234"]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 250);

  timers[0].callback();
  assert.deepEqual(installs.at(-1), {
    generationId: "generation_B_5678",
    logoutGenerationId: "",
    announceReady: true,
  });
  cleanupB();

  const cancellationController = createRecoveringController();
  startCollectorAuthBridgeLifecycle({
    accountId: "account-a",
    controller: cancellationController,
    installBridge,
    postLogout: (generationId) => logouts.push(generationId),
    setTimer,
    clearTimer,
  })();
  const cancelledCleanup = startCollectorAuthBridgeLifecycle({
    accountId: "account-b",
    controller: cancellationController,
    installBridge,
    postLogout: (generationId) => logouts.push(generationId),
    setTimer,
    clearTimer,
  });
  const cancelledRetry = timers.at(-1);
  const installCountBeforeCancelledRetry = installs.length;

  cancelledCleanup();
  assert.equal(cancelledRetry.cleared, true);
  cancelledRetry.callback();
  assert.equal(installs.length, installCountBeforeCancelledRetry);
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
  const expectedRequest = {
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.request,
    requestId: "request-plain",
  };
  assert.deepEqual(normalizeCollectorAuthRequest(expectedRequest), expectedRequest);
  assert.deepEqual(
    normalizeCollectorAuthRequest(Object.assign(Object.create(null), expectedRequest)),
    expectedRequest,
  );

  const arrayEnvelope = [];
  arrayEnvelope.protocol = COLLECTOR_AUTH_PROTOCOL;
  arrayEnvelope.action = COLLECTOR_AUTH_ACTIONS.request;
  arrayEnvelope.requestId = "request-array";
  assert.equal(normalizeCollectorAuthRequest(arrayEnvelope), null);

  const dateEnvelope = new Date();
  Object.assign(dateEnvelope, expectedRequest);
  assert.equal(normalizeCollectorAuthRequest(dateEnvelope), null);

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
    accountId: "account-a",
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
      action: "collector.auth.ready.v2",
      generationId: "generation_A_1234",
      accountId: "account-a",
    },
    {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.ready,
      generationId: "generation_A_1234",
    },
    {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: "collector.auth.accepted",
      requestId: "request-2",
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
    accountId: "account-a",
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
    accountId: "account-b",
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
});

test("does not request or post a ticket when the Web account is logged out", async () => {
  const harness = createWindowHarness();
  let ticketRequests = 0;
  const responses = [];
  installCollectorAuthBridge({
    windowObject: harness.windowObject,
    accountId: "account-a",
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

test("requires valid generation and bounded account IDs when installing the bridge", () => {
  const harness = createWindowHarness();
  assert.throws(() => installCollectorAuthBridge({
    windowObject: harness.windowObject,
    accountId: "account-a",
    generationId: "too-short",
    isLoggedIn: () => true,
    requestTicket: async () => ({}),
  }), /generation/i);
  assert.throws(() => installCollectorAuthBridge({
    windowObject: harness.windowObject,
    accountId: " ",
    generationId: "generation_A_1234",
    isLoggedIn: () => true,
    requestTicket: async () => ({}),
  }), /account/i);
  assert.throws(() => installCollectorAuthBridge({
    windowObject: harness.windowObject,
    accountId: "a".repeat(129),
    generationId: "generation_A_1234",
    isLoggedIn: () => true,
    requestTicket: async () => ({}),
  }), /account/i);
});

test("acknowledges a valid request before its ticket request settles", async () => {
  const harness = createWindowHarness();
  const responses = [];
  const ticket = createDeferred();
  const pendingResponse = installCollectorAuthBridge({
    windowObject: harness.windowObject,
    accountId: "account-a",
    generationId: "generation_A_1234",
    isLoggedIn: () => true,
    requestTicket: () => ticket.promise,
    announceReady: false,
    postResponse: (payload) => responses.push(payload),
  });

  const request = harness.dispatch({
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.request,
    requestId: "request-accepted-first",
  });

  assert.deepEqual(responses, [{
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: "collector.auth.accepted",
    requestId: "request-accepted-first",
    generationId: "generation_A_1234",
  }]);

  ticket.resolve({ ticket: "ticket-one", expiresAt: "2099-01-01T00:00:00.000Z" });
  await request;
  assert.equal(responses.at(-1).action, COLLECTOR_AUTH_ACTIONS.response);
  pendingResponse();
});

test("shares one ticket request and one ticket response for equal active request IDs", async () => {
  const harness = createWindowHarness();
  const responses = [];
  const ticket = createDeferred();
  let ticketRequests = 0;
  installCollectorAuthBridge({
    windowObject: harness.windowObject,
    accountId: "account-a",
    generationId: "generation_A_1234",
    isLoggedIn: () => true,
    requestTicket: () => {
      ticketRequests += 1;
      return ticket.promise;
    },
    announceReady: false,
    postResponse: (payload) => responses.push(payload),
  });
  const request = {
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.request,
    requestId: "request-single-flight",
  };

  const firstResponse = harness.dispatch(request);
  const secondResponse = harness.dispatch(request);
  assert.equal(ticketRequests, 1);
  assert.equal(responses.filter(({ action }) => action === "collector.auth.accepted").length, 1);

  ticket.resolve({ ticket: "ticket-one", expiresAt: "2099-01-01T00:00:00.000Z" });
  await Promise.all([firstResponse, secondResponse]);
  assert.equal(responses.filter(({ action }) => action === COLLECTOR_AUTH_ACTIONS.response).length, 1);
});

test("supersedes an expired request lease and ignores its late ticket result", async () => {
  const harness = createWindowHarness();
  const responses = [];
  const timers = [];
  const firstTicket = createDeferred();
  const secondTicket = createDeferred();
  let ticketRequests = 0;
  installCollectorAuthBridge({
    windowObject: harness.windowObject,
    accountId: "account-a",
    generationId: "generation_A_1234",
    isLoggedIn: () => true,
    requestTicket: () => {
      ticketRequests += 1;
      return ticketRequests === 1 ? firstTicket.promise : secondTicket.promise;
    },
    announceReady: false,
    postResponse: (payload) => responses.push(payload),
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
  });
  const request = {
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.request,
    requestId: "request-expired-lease",
  };

  const oldResponse = harness.dispatch(request);
  assert.equal(timers[0].delay, 30_000);
  timers[0].callback();
  const currentResponse = harness.dispatch(request);
  assert.equal(ticketRequests, 2);

  firstTicket.resolve({ ticket: "ticket-old", expiresAt: "2099-01-01T00:00:00.000Z" });
  await oldResponse;
  assert.equal(responses.filter(({ action }) => action === COLLECTOR_AUTH_ACTIONS.response).length, 0);

  secondTicket.resolve({ ticket: "ticket-current", expiresAt: "2099-01-01T00:00:00.000Z" });
  await currentResponse;
  const ticketResponses = responses.filter(({ action }) => action === COLLECTOR_AUTH_ACTIONS.response);
  assert.equal(ticketResponses.length, 1);
  assert.equal(ticketResponses[0].ticket, "ticket-current");
});

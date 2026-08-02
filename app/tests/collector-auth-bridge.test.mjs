import assert from "node:assert/strict";
import test from "node:test";
import * as collectorAuthBridge from "../src/collector-auth-bridge.js";

const {
  COLLECTOR_AUTH_ACTIONS,
  COLLECTOR_AUTH_PROTOCOL,
  installCollectorAuthBridge,
  normalizeCollectorAuthRequest,
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

test("publishes a credential-free ready envelope only when the Web account is logged in", () => {
  const loggedInHarness = createWindowHarness();
  installCollectorAuthBridge({
    windowObject: loggedInHarness.windowObject,
    isLoggedIn: () => true,
    requestTicket: async () => ({}),
  });
  const { posts } = loggedInHarness;
  assert.deepEqual(posts, [{
    payload: {
      protocol: "SONLI_COLLECTOR_AUTH",
      action: "collector.auth.ready",
    },
    targetOrigin: "http://127.0.0.1:3000",
  }]);
  assert.deepEqual(Object.keys(posts[0].payload).sort(), ["action", "protocol"]);

  const loggedOutHarness = createWindowHarness();
  installCollectorAuthBridge({
    windowObject: loggedOutHarness.windowObject,
    isLoggedIn: () => false,
    requestTicket: async () => ({}),
  });
  assert.deepEqual(loggedOutHarness.posts, []);
});

test("does not republish ready when the login generation was already announced", () => {
  const harness = createWindowHarness();
  const installForSameLogin = (announceReady) => installCollectorAuthBridge({
    windowObject: harness.windowObject,
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
    },
    targetOrigin: "http://127.0.0.1:3000",
  }]);
});

test("tracks ready announcements by stable account id across state refreshes", () => {
  assert.equal(typeof collectorAuthBridge.createCollectorAuthReadyGate, "function");
  const gate = collectorAuthBridge.createCollectorAuthReadyGate();
  const firstState = { account: { id: "account-a", displayName: "First" } };
  const refreshedState = { account: { id: "account-a", displayName: "Refreshed" } };

  assert.equal(gate.shouldAnnounce(firstState.account.id), true);
  assert.equal(gate.shouldAnnounce(refreshedState.account.id), false);
  assert.equal(gate.shouldAnnounce("account-b"), true);
  assert.equal(gate.shouldAnnounce(""), false);
  assert.equal(gate.shouldAnnounce(firstState.account.id), true);
});

test("normalizes only the exact collector request protocol and a bounded requestId", () => {
  assert.deepEqual(
    normalizeCollectorAuthRequest({
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.request,
      requestId: "request-1",
      token: "must-not-pass",
      storeId: "must-not-pass",
    }),
    {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.request,
      requestId: "request-1",
    },
  );
  for (const message of [
    null,
    {},
    { protocol: "SONLI_WEB_CONTROL", action: COLLECTOR_AUTH_ACTIONS.request, requestId: "request-1" },
    { protocol: COLLECTOR_AUTH_PROTOCOL, action: "syncAuthFromWeb", requestId: "request-1" },
    { protocol: COLLECTOR_AUTH_PROTOCOL, action: COLLECTOR_AUTH_ACTIONS.request, requestId: "" },
    { protocol: COLLECTOR_AUTH_PROTOCOL, action: COLLECTOR_AUTH_ACTIONS.request, requestId: "x".repeat(129) },
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
    },
    {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.response,
      requestId: "request-2",
      ticket: "ctt_one_time_secret_123456789",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  ]);
  assert.equal(JSON.stringify(responses).includes("web-bearer"), false);
  assert.equal(JSON.stringify(responses).includes("store-must"), false);

  uninstall();
  assert.equal(harness.hasListener(), false);
});

test("does not request or post a ticket when the Web account is logged out", async () => {
  const harness = createWindowHarness();
  let ticketRequests = 0;
  const responses = [];
  installCollectorAuthBridge({
    windowObject: harness.windowObject,
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

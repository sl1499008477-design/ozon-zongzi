import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLECTOR_AUTH_ACTIONS,
  COLLECTOR_AUTH_PROTOCOL,
  installCollectorAuthBridge,
  normalizeCollectorAuthRequest,
} from "../src/collector-auth-bridge.js";

const createWindowHarness = () => {
  const listeners = new Map();
  const windowObject = {
    location: { origin: "http://127.0.0.1:3000" },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  return {
    windowObject,
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
  assert.deepEqual(responses, [{
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.response,
    requestId: "request-2",
    ticket: "ctt_one_time_secret_123456789",
    expiresAt: "2099-01-01T00:00:00.000Z",
  }]);
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

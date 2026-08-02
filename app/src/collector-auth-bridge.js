export const COLLECTOR_AUTH_PROTOCOL = "SONLI_COLLECTOR_AUTH";
export const COLLECTOR_AUTH_ACTIONS = Object.freeze({
  request: "collector.auth.request",
  response: "collector.auth.response",
  ready: "collector.auth.ready",
});

const validRequestId = (value) => {
  const requestId = String(value || "").trim();
  return requestId && requestId.length <= 128 ? requestId : "";
};

export function normalizeCollectorAuthRequest(value) {
  if (!value || typeof value !== "object") return null;
  if (
    value.protocol !== COLLECTOR_AUTH_PROTOCOL
    || value.action !== COLLECTOR_AUTH_ACTIONS.request
  ) {
    return null;
  }
  const requestId = validRequestId(value.requestId);
  if (!requestId) return null;
  return {
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.request,
    requestId,
  };
}

export function installCollectorAuthBridge({
  isLoggedIn,
  requestTicket,
  postResponse,
  windowObject = window,
} = {}) {
  if (typeof isLoggedIn !== "function" || typeof requestTicket !== "function") {
    throw new TypeError("collector auth bridge requires login and ticket adapters");
  }
  const send = postResponse || ((payload) => {
    windowObject.postMessage(payload, windowObject.location.origin);
  });
  const onMessage = async (event) => {
    if (
      event.source !== windowObject
      || event.origin !== windowObject.location.origin
    ) {
      return;
    }
    const message = normalizeCollectorAuthRequest(event.data);
    if (!message || !isLoggedIn()) return;
    try {
      const result = await requestTicket();
      const ticket = String(result?.ticket || "");
      const expiresAt = String(result?.expiresAt || "");
      if (!ticket || !expiresAt) return;
      send({
        protocol: COLLECTOR_AUTH_PROTOCOL,
        action: COLLECTOR_AUTH_ACTIONS.response,
        requestId: message.requestId,
        ticket,
        expiresAt,
      });
    } catch {
      // Authentication errors stay inside the Web app. Never echo server details
      // because they can contain a ticket or the parent Web credential.
    }
  };
  windowObject.addEventListener("message", onMessage);
  if (isLoggedIn()) {
    send({
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.ready,
    });
  }
  return () => windowObject.removeEventListener("message", onMessage);
}

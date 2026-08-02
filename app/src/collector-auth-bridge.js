export const COLLECTOR_AUTH_PROTOCOL = "SONLI_COLLECTOR_AUTH";
export const COLLECTOR_AUTH_ACTIONS = Object.freeze({
  request: "collector.auth.request",
  response: "collector.auth.response",
  ready: "collector.auth.ready",
  logout: "collector.auth.logout",
});

const GENERATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const isCollectorAuthGenerationId = (value) =>
  GENERATION_ID_PATTERN.test(String(value || ""));

const defaultGenerationId = () => globalThis.crypto.randomUUID();

export function createCollectorAuthGenerationController({
  createGenerationId = defaultGenerationId,
} = {}) {
  let accountId = "";
  let generationId = "";
  let announced = false;
  return Object.freeze({
    update(value) {
      const nextAccountId = String(value || "").trim();
      if (!nextAccountId) {
        const logoutGenerationId = generationId;
        accountId = "";
        generationId = "";
        announced = false;
        return { generationId: "", logoutGenerationId, announceReady: false };
      }
      let logoutGenerationId = "";
      if (nextAccountId !== accountId) {
        logoutGenerationId = generationId;
        const candidate = String(createGenerationId() || "");
        accountId = "";
        generationId = "";
        announced = false;
        if (!isCollectorAuthGenerationId(candidate)) {
          return { generationId: "", logoutGenerationId, announceReady: false };
        }
        accountId = nextAccountId;
        generationId = candidate;
      }
      const announceReady = !announced;
      announced = true;
      return { generationId, logoutGenerationId, announceReady };
    },
  });
}

const validRequestId = (value) => {
  const requestId = String(value || "").trim();
  return requestId && requestId.length <= 128 ? requestId : "";
};

const sendCollectorAuthPayload = ({ payload, postResponse, windowObject }) => {
  if (typeof postResponse === "function") {
    postResponse(payload);
    return;
  }
  windowObject.postMessage(payload, windowObject.location.origin);
};

export function postCollectorAuthLogout({
  generationId,
  postResponse,
  windowObject = window,
} = {}) {
  if (!isCollectorAuthGenerationId(generationId)) return false;
  sendCollectorAuthPayload({
    postResponse,
    windowObject,
    payload: {
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.logout,
      generationId,
    },
  });
  return true;
}

export function normalizeCollectorAuthRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3
    || keys[0] !== "action"
    || keys[1] !== "protocol"
    || keys[2] !== "requestId"
    || value.protocol !== COLLECTOR_AUTH_PROTOCOL
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
  generationId,
  isLoggedIn,
  requestTicket,
  postResponse,
  windowObject = window,
  announceReady = true,
} = {}) {
  if (!isCollectorAuthGenerationId(generationId)) {
    throw new TypeError("collector auth bridge requires a valid generation ID");
  }
  if (typeof isLoggedIn !== "function" || typeof requestTicket !== "function") {
    throw new TypeError("collector auth bridge requires login and ticket adapters");
  }
  const send = (payload) => sendCollectorAuthPayload({ payload, postResponse, windowObject });
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
        generationId,
      });
    } catch {
      // Authentication errors stay inside the Web app. Never echo server details
      // because they can contain a ticket or the parent Web credential.
    }
  };
  windowObject.addEventListener("message", onMessage);
  if (announceReady && isLoggedIn()) {
    send({
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.ready,
      generationId,
    });
  }
  return () => windowObject.removeEventListener("message", onMessage);
}

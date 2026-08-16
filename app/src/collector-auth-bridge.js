export const COLLECTOR_AUTH_PROTOCOL = "SONLI_COLLECTOR_AUTH";
export const COLLECTOR_AUTH_ACTIONS = Object.freeze({
  request: "collector.auth.request",
  response: "collector.auth.response",
  ready: "collector.auth.ready",
  readyV2: "collector.auth.ready.v2",
  accepted: "collector.auth.accepted",
  failure: "collector.auth.failure",
  release: "collector.auth.release",
  logout: "collector.auth.logout",
});

const GENERATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const COLLECTOR_AUTH_REQUEST_LEASE_MS = 30_000;
const COLLECTOR_AUTH_PUBLIC_FAILURE_CODES = new Set([
  "WEB_LOGIN_REQUIRED",
  "LOCAL_SERVICE_UNAVAILABLE",
  "ACCOUNT_DISABLED",
  "ACCOUNT_EXPIRED",
  "PERMISSION_DENIED",
  "SERVER_UPGRADE_REQUIRED",
]);

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
        accountId = "";
        generationId = "";
        announced = false;
        let candidate = "";
        try {
          candidate = String(createGenerationId() || "");
        } catch {
          return { generationId: "", logoutGenerationId, announceReady: false };
        }
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

export function startCollectorAuthBridgeLifecycle({
  accountId,
  controller,
  installBridge,
  postLogout,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryDelayMs = 250,
} = {}) {
  if (!controller || typeof controller.update !== "function") {
    throw new TypeError("collector auth lifecycle requires a generation controller");
  }
  if (typeof installBridge !== "function") {
    throw new TypeError("collector auth lifecycle requires a bridge installer");
  }
  if (typeof postLogout !== "function") {
    throw new TypeError("collector auth lifecycle requires a logout adapter");
  }

  const normalizedAccountId = String(accountId || "").trim();
  let cleanedUp = false;
  let retryScheduled = false;
  let retryTimer = null;
  let removeBridge = null;

  const run = () => {
    if (cleanedUp) return;
    const transition = controller.update(normalizedAccountId);
    if (transition.logoutGenerationId) {
      postLogout(transition.logoutGenerationId);
    }
    if (transition.generationId) {
      removeBridge = installBridge(transition);
      return;
    }
    if (!normalizedAccountId || retryScheduled) return;
    retryScheduled = true;
    retryTimer = setTimer(() => {
      retryTimer = null;
      run();
    }, retryDelayMs);
  };

  run();
  return () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (retryTimer !== null) clearTimer(retryTimer);
    if (typeof removeBridge === "function") removeBridge();
  };
}

const validRequestId = (value) => {
  const requestId = String(value || "").trim();
  return requestId && requestId.length <= 128 ? requestId : "";
};

const validAccountId = (value) => {
  if (typeof value !== "string") return "";
  const accountId = value.trim();
  return accountId && accountId.length <= 128 ? accountId : "";
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

export function normalizeCollectorAuthRelease(value) {
  const message = normalizeCollectorAuthRequest({
    ...value,
    action: COLLECTOR_AUTH_ACTIONS.request,
  });
  if (!message || value?.action !== COLLECTOR_AUTH_ACTIONS.release) return null;
  return {
    protocol: COLLECTOR_AUTH_PROTOCOL,
    action: COLLECTOR_AUTH_ACTIONS.release,
    requestId: message.requestId,
  };
}

export function installCollectorAuthBridge({
  accountId,
  generationId,
  isLoggedIn,
  requestTicket,
  postResponse,
  windowObject = window,
  announceReady = true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!isCollectorAuthGenerationId(generationId)) {
    throw new TypeError("collector auth bridge requires a valid generation ID");
  }
  const normalizedAccountId = validAccountId(accountId);
  if (!normalizedAccountId) {
    throw new TypeError("collector auth bridge requires a valid account ID");
  }
  if (typeof isLoggedIn !== "function" || typeof requestTicket !== "function") {
    throw new TypeError("collector auth bridge requires login and ticket adapters");
  }
  const send = (payload) => sendCollectorAuthPayload({ payload, postResponse, windowObject });
  let activeTicketLease = null;
  const publicFailureCode = (error) => {
    const code = String(error?.code || "").trim().toUpperCase();
    const status = Number(error?.status) || 0;
    if ([
      "WEB_AUTH_REQUIRED",
      "WEB_LOGIN_REQUIRED",
      "COLLECTOR_PARENT_SESSION_EXPIRED",
      "COLLECTOR_PARENT_SESSION_REVOKED",
    ].includes(code)
      || status === 401) return "WEB_LOGIN_REQUIRED";
    if (["ACCOUNT_DISABLED", "COLLECTOR_ACCOUNT_DISABLED"].includes(code)) {
      return "ACCOUNT_DISABLED";
    }
    if (["ACCOUNT_EXPIRED", "COLLECTOR_ACCOUNT_EXPIRED"].includes(code)) {
      return "ACCOUNT_EXPIRED";
    }
    if (["PERMISSION_DENIED", "COLLECTOR_PERMISSION_DENIED"].includes(code)) {
      return "PERMISSION_DENIED";
    }
    if (["REQUEST_TIMEOUT", "REQUEST_ABORTED", "INVALID_JSON_RESPONSE"].includes(code)
      || status === 408 || status === 425 || status === 429 || status >= 500 || status === 0) {
      return "LOCAL_SERVICE_UNAVAILABLE";
    }
    return COLLECTOR_AUTH_PUBLIC_FAILURE_CODES.has(code)
      ? code
      : "SERVER_UPGRADE_REQUIRED";
  };
  const onMessage = async (event) => {
    if (
      event.source !== windowObject
      || event.origin !== windowObject.location.origin
    ) {
      return;
    }
    const release = normalizeCollectorAuthRelease(event.data);
    if (release) {
      if (activeTicketLease?.requestId === release.requestId) {
        const releasedLease = activeTicketLease;
        activeTicketLease = null;
        clearTimer(releasedLease.leaseTimer);
        releasedLease.abortController.abort();
      }
      return;
    }
    const message = normalizeCollectorAuthRequest(event.data);
    if (!message || !isLoggedIn()) return;
    if (activeTicketLease) {
      return activeTicketLease.requestId === message.requestId
        ? activeTicketLease.promise
        : undefined;
    }

    let resolveEntry;
    const entry = {
      requestId: message.requestId,
      leaseTimer: null,
      abortController: new AbortController(),
      promise: new Promise((resolve) => { resolveEntry = resolve; }),
    };
    activeTicketLease = entry;
    entry.leaseTimer = setTimer(() => {
      if (activeTicketLease === entry) {
        activeTicketLease = null;
        entry.abortController.abort();
      }
    }, COLLECTOR_AUTH_REQUEST_LEASE_MS);
    entry.leaseTimer?.unref?.();
    send({
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.accepted,
      requestId: message.requestId,
      generationId,
    });
    void (async () => {
      try {
        const result = await requestTicket({ signal: entry.abortController.signal });
        if (activeTicketLease !== entry) return;
        const ticket = String(result?.ticket || "");
        const expiresAt = String(result?.expiresAt || "");
        if (!ticket || !expiresAt) {
          throw Object.assign(new Error("COLLECTOR_AUTH_RESPONSE_INVALID"), {
            code: "COLLECTOR_AUTH_RESPONSE_INVALID",
          });
        }
        send({
          protocol: COLLECTOR_AUTH_PROTOCOL,
          action: COLLECTOR_AUTH_ACTIONS.response,
          requestId: message.requestId,
          ticket,
          expiresAt,
          generationId,
        });
      } catch (error) {
        if (activeTicketLease !== entry) return;
        send({
          protocol: COLLECTOR_AUTH_PROTOCOL,
          action: COLLECTOR_AUTH_ACTIONS.failure,
          requestId: message.requestId,
          generationId,
          publicCode: publicFailureCode(error),
        });
        if (activeTicketLease === entry) {
          entry.abortController.abort();
          clearTimer(entry.leaseTimer);
          activeTicketLease = null;
        }
      } finally {
        resolveEntry();
      }
    })();
    return entry.promise;
  };
  windowObject.addEventListener("message", onMessage);
  if (announceReady && isLoggedIn()) {
    send({
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.readyV2,
      generationId,
      accountId: normalizedAccountId,
    });
    send({
      protocol: COLLECTOR_AUTH_PROTOCOL,
      action: COLLECTOR_AUTH_ACTIONS.ready,
      generationId,
    });
  }
  return () => {
    windowObject.removeEventListener("message", onMessage);
    if (activeTicketLease) {
      clearTimer(activeTicketLease.leaseTimer);
      activeTicketLease.abortController.abort();
      activeTicketLease = null;
    }
  };
}

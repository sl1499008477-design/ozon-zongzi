const PROTOCOL = "v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const CATEGORY_PATH = /^\/category\/[a-z0-9][a-z0-9-]*-[1-9][0-9]*\/$/iu;
const PRODUCT_PATH = /^\/product\/[a-z0-9][a-z0-9-]*-[1-9][0-9]*\/$/iu;

function failure(code) {
  return Object.assign(new Error(code), { code, status: 409 });
}

function ownClosed(raw, keys) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) return null;
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch {
    return null;
  }
}

function requestId() {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `category-strategy-${value}`;
}

function samplingBrowserUrl(raw) {
  if (typeof raw !== "string" || raw !== raw.trim() || raw.length > 2048) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_BROWSER_OPEN_FAILED");
  }
  let url;
  try { url = new URL(raw); } catch {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_BROWSER_OPEN_FAILED");
  }
  const parameters = [...url.searchParams.keys()];
  const sessions = url.searchParams.getAll("zongziCategoryStrategySession");
  if (url.origin !== "https://www.ozon.ru" || url.username || url.password || url.hash
    || !(CATEGORY_PATH.test(url.pathname) || PRODUCT_PATH.test(url.pathname))
    || parameters.length !== 1 || parameters[0] !== "zongziCategoryStrategySession"
    || sessions.length !== 1 || !SAFE_ID.test(sessions[0])) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_BROWSER_OPEN_FAILED");
  }
  return url.href;
}

export function createCategoryStrategyExtensionBridge({
  windowObject = window,
  timeoutMs = 1_500,
} = {}) {
  if (!windowObject || typeof windowObject.addEventListener !== "function"
    || typeof windowObject.removeEventListener !== "function"
    || typeof windowObject.postMessage !== "function"
    || typeof windowObject.location?.origin !== "string"
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError("category strategy extension bridge dependencies are required");
  }

  const send = ({ requestKind, responseKind, payload, responseKeys, project, errorCode }) =>
    new Promise((resolve, reject) => {
      const reqId = requestId();
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        windowObject.removeEventListener("message", onMessage);
      };
      const finish = (operation) => {
        if (settled) return;
        settled = true;
        cleanup();
        operation();
      };
      const onMessage = (event) => {
        if (event.source !== windowObject || event.origin !== windowObject.location.origin) return;
        const message = ownClosed(event.data, responseKeys);
        if (!message || message.__jz !== PROTOCOL || message.kind !== responseKind
          || message.reqId !== reqId || typeof message.ok !== "boolean") return;
        if (!message.ok) {
          finish(() => reject(failure(errorCode)));
          return;
        }
        let result;
        try { result = project(message); } catch {
          return;
        }
        finish(() => resolve(result));
      };
      const timer = setTimeout(() => finish(() => reject(failure(errorCode))), timeoutMs);
      windowObject.addEventListener("message", onMessage);
      try {
        windowObject.postMessage({ __jz: PROTOCOL, kind: requestKind, reqId, ...payload },
          windowObject.location.origin);
      } catch {
        finish(() => reject(failure(errorCode)));
      }
    });

  return Object.freeze({
    ready() {
      const errorCode = "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY";
      return send({
        requestKind: "category-strategy.readiness.request",
        responseKind: "category-strategy.readiness.response",
        payload: {},
        responseKeys: new Set(["__jz", "kind", "reqId", "ok", "ready", "version"]),
        errorCode,
        project(message) {
          if (message.ready !== true || typeof message.version !== "string"
            || message.version.length < 5 || message.version.length > 40) throw failure(errorCode);
          return Object.freeze({ ready: true, version: message.version });
        },
      });
    },
    open(rawBrowserUrl) {
      const errorCode = "AUTO_LISTING_CATEGORY_STRATEGY_BROWSER_OPEN_FAILED";
      let browserUrl;
      try { browserUrl = samplingBrowserUrl(rawBrowserUrl); } catch {
        return Promise.reject(failure(errorCode));
      }
      return send({
        requestKind: "category-strategy.open.request",
        responseKind: "category-strategy.open.response",
        payload: { browserUrl },
        responseKeys: new Set(["__jz", "kind", "reqId", "ok", "opened"]),
        errorCode,
        project(message) {
          if (message.opened !== true) throw failure(errorCode);
          return Object.freeze({ opened: true });
        },
      });
    },
  });
}

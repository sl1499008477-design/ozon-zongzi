import { isSafeAutoListingAiIdentifier } from "./auto-listing-ai-message.mjs";
import { autoListingEnabled } from "./runtime-config.mjs";

const ITEM_ACTION = /^\/auto-listing\/items\/([^/]+)\/(retry|regenerate|approve|cancel)$/u;
const ITEM_REVIEW = /^\/auto-listing\/items\/([^/]+)\/review$/u;
const BODY_KEYS = new Set(["jobId", "expectedStatusVersion", "idempotencyKey", "correlationId"]);
const ERROR_STATUS = Object.freeze({
  AUTO_LISTING_USER_ACTION_INVALID: 400,
  AUTO_LISTING_USER_ACTION_NOT_FOUND: 404,
  AUTO_LISTING_AI_RETRY_NOT_FOUND: 404,
  AUTO_LISTING_USER_ACTION_CONFLICT: 409,
  AUTO_LISTING_USER_ACTION_NOT_ALLOWED: 409,
  AUTO_LISTING_AI_RETRY_VERSION_CONFLICT: 409,
  AUTO_LISTING_AI_RETRY_NOT_RECOVERABLE: 409,
  AUTO_LISTING_REVIEW_NOT_FOUND: 404,
  AUTO_LISTING_REVIEW_NOT_READY: 409,
  AUTO_LISTING_REVIEW_INVALID: 409,
  AUTO_LISTING_REVIEW_FAILED: 503,
  AUTO_LISTING_USER_ACTION_FAILED: 503,
  AUTO_LISTING_AI_RETRY_FAILED: 503,
});

function invalid() {
  const error = new Error("自动上架商品操作请求无效");
  error.code = "AUTO_LISTING_USER_ACTION_INVALID";
  error.status = 400;
  return error;
}

function decodeId(value) {
  try {
    const result = decodeURIComponent(value);
    if (!isSafeAutoListingAiIdentifier(result)) throw invalid();
    return result;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_USER_ACTION_INVALID") throw error;
    throw invalid();
  }
}

function body(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype
    || Reflect.ownKeys(raw).length !== BODY_KEYS.size
    || Reflect.ownKeys(raw).some((key) => typeof key !== "string" || !BODY_KEYS.has(key))) throw invalid();
  for (const key of ["jobId", "idempotencyKey", "correlationId"]) {
    if (!isSafeAutoListingAiIdentifier(raw[key])) throw invalid();
  }
  if (!Number.isInteger(raw.expectedStatusVersion) || raw.expectedStatusVersion < 1
    || raw.expectedStatusVersion >= 2_147_483_647) throw invalid();
  return {
    jobId: raw.jobId, expectedStatusVersion: raw.expectedStatusVersion,
    idempotencyKey: raw.idempotencyKey, correlationId: raw.correlationId,
  };
}

function safeError(error) {
  if (Number(error?.status) === 401) {
    return { status: 401, payload: { ok: false, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录" } };
  }
  if (Number(error?.status) === 403 || error?.code === "PERMISSION_FORBIDDEN") {
    return { status: 403, payload: { ok: false, code: "PERMISSION_FORBIDDEN", message: "没有自动上架操作权限" } };
  }
  const code = typeof error?.code === "string" && Object.hasOwn(ERROR_STATUS, error.code)
    ? error.code : "AUTO_LISTING_USER_ACTION_INTERNAL_ERROR";
  const status = ERROR_STATUS[code] || 500;
  return {
    status,
    payload: {
      ok: false, code,
      message: status === 409 ? "商品状态已变化，请刷新后重试"
        : status === 404 ? "自动上架商品不存在"
          : status >= 500 ? "自动上架商品操作暂时失败" : "自动上架商品操作请求无效",
    },
  };
}

export function createAutoListingItemHttpHandler({
  isEnabled = autoListingEnabled,
  authenticate,
  getService,
  readJson,
  sendJson,
} = {}) {
  if (typeof isEnabled !== "function" || typeof authenticate !== "function"
    || typeof getService !== "function" || typeof readJson !== "function"
    || typeof sendJson !== "function") {
    throw new TypeError("Auto-listing item route dependencies are required");
  }
  return async function handleAutoListingItem(req, res, url) {
    const actionMatch = url.pathname.match(ITEM_ACTION);
    const reviewMatch = url.pathname.match(ITEM_REVIEW);
    if (!actionMatch && !reviewMatch) return false;
    try {
      const actor = await authenticate(req);
      const expectedMethod = reviewMatch ? "GET" : "POST";
      if (req.method !== expectedMethod) {
        sendJson(res, 405, { ok: false, code: "AUTO_LISTING_ITEM_METHOD_NOT_ALLOWED", message: "不支持的自动上架商品操作" });
        return true;
      }
      if (!isEnabled()) {
        sendJson(res, 503, { ok: false, code: "AUTO_LISTING_DISABLED", message: "自动上架功能暂未启用" });
        return true;
      }
      if ([...url.searchParams.keys()].length) throw invalid();
      const itemId = decodeId((reviewMatch || actionMatch)[1]);
      if (reviewMatch) {
        const service = await getService();
        if (typeof service?.getReview !== "function") throw new Error("invalid item review service");
        const data = await service.getReview({ actor, itemId });
        sendJson(res, 200, { ok: true, data });
        return true;
      }
      let parsed;
      try { parsed = body(await readJson(req)); } catch (error) {
        if (error?.code === "AUTO_LISTING_USER_ACTION_INVALID") throw error;
        throw invalid();
      }
      const service = await getService();
      const method = `${actionMatch[2]}Item`;
      if (typeof service?.[method] !== "function") throw new Error("invalid item service");
      const data = await service[method]({ actor, itemId, ...parsed });
      sendJson(res, 200, { ok: true, data, correlationId: parsed.correlationId });
    } catch (error) {
      const response = safeError(error);
      sendJson(res, response.status, response.payload);
    }
    return true;
  };
}

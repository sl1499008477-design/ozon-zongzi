import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const PATH = "/admin/auto-listing/reconciliation-tasks/recover";
const BODY_KEYS = new Set(["taskId", "reason", "idempotencyKey", "correlationId"]);
const SAFE_CODES = new Set([
  "AUTO_LISTING_RECONCILE_ADMIN_INVALID", "AUTO_LISTING_RECONCILE_ADMIN_CONFLICT",
  "AUTO_LISTING_RECONCILE_ADMIN_NOT_RECOVERABLE", "AUTO_LISTING_RECONCILE_ADMIN_NOT_FOUND",
  "AUTO_LISTING_RECONCILE_ADMIN_DATA_BOUNDARY", "AUTO_LISTING_RECONCILE_ADMIN_FAILED",
  "AUTO_LISTING_RECONCILE_ADMIN_DISABLED", "AUTO_LISTING_RECONCILE_ADMIN_INITIALIZATION_FAILED",
]);

function routeError(code, status = 400) {
  const error = new Error("自动上架对账恢复请求无效");
  error.code = code;
  error.status = status;
  return error;
}

function exactBody(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
      throw routeError("AUTO_LISTING_RECONCILE_ADMIN_INVALID");
    }
    const keys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (keys.length !== BODY_KEYS.size || keys.some((key) => typeof key !== "string" || !BODY_KEYS.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
      throw routeError("AUTO_LISTING_RECONCILE_ADMIN_INVALID");
    }
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === "AUTO_LISTING_RECONCILE_ADMIN_INVALID") throw error;
    throw routeError("AUTO_LISTING_RECONCILE_ADMIN_INVALID");
  }
}

function safeResponse(error) {
  if (Number(error?.status) === 401) return {
    status: 401, payload: { ok: false, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录" },
  };
  if (Number(error?.status) === 403 || error?.code === "PERMISSION_FORBIDDEN") return {
    status: 403, payload: { ok: false, code: "PERMISSION_FORBIDDEN", message: "没有自动上架对账恢复权限" },
  };
  const code = SAFE_CODES.has(error?.code) ? error.code : "AUTO_LISTING_RECONCILE_ADMIN_INTERNAL_ERROR";
  const supplied = Number(error?.status);
  const status = code === "AUTO_LISTING_RECONCILE_ADMIN_INTERNAL_ERROR" ? 500
    : Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied : 422;
  return { status, payload: { ok: false, code, message: status >= 500
    ? "自动上架对账恢复服务暂时不可用" : "自动上架对账恢复请求无效" } };
}

export function createAutoListingSubmissionReconciliationAdminHttpHandler({
  authenticate, getService, readJson, sendJson,
} = {}) {
  if (![authenticate, getService, readJson, sendJson].every((value) => typeof value === "function")) {
    throw new TypeError("Auto-listing reconciliation admin route dependencies are required");
  }
  return async function handleAutoListingSubmissionReconciliationAdmin(req, res, url) {
    if (url.pathname !== PATH) return false;
    try {
      if (!url.searchParams || [...url.searchParams.keys()].length !== 0) {
        throw routeError("AUTO_LISTING_RECONCILE_ADMIN_INVALID");
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, code: "AUTO_LISTING_RECONCILE_ADMIN_METHOD_NOT_ALLOWED",
          message: "不支持的自动上架对账恢复请求" });
        return true;
      }
      const actor = await authenticate(req);
      assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
      let parsed;
      try { parsed = exactBody(await readJson(req)); } catch (error) {
        if (error?.code) throw error;
        throw routeError("AUTO_LISTING_RECONCILE_ADMIN_INVALID");
      }
      const service = await getService();
      const data = await service.reopenDeadTask({ actor, ...parsed });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      const response = safeResponse(error);
      sendJson(res, response.status, response.payload);
    }
    return true;
  };
}

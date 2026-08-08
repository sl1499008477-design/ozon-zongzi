import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const PATH = "/admin/auto-listing/upload-policies";
const HEALTH_PATH = `${PATH}/publication-health`;
const BODY_KEYS = new Set(["mode", "publicationReason", "idempotencyKey", "correlationId"]);
const SAFE_CODES = new Set([
  "AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID", "AUTO_LISTING_UPLOAD_POLICY_ADMIN_CONFLICT",
  "AUTO_LISTING_UPLOAD_POLICY_ADMIN_FAILED", "AUTO_LISTING_UPLOAD_POLICY_ADMIN_DATA_BOUNDARY",
  "AUTO_LISTING_UPLOAD_POLICY_ADMIN_SCOPE_NOT_FOUND",
  "AUTO_LISTING_DIRECT_POLICY_NOT_READY",
  "AUTO_LISTING_UPLOAD_POLICY_ADMIN_DISABLED", "AUTO_LISTING_UPLOAD_POLICY_ADMIN_INITIALIZATION_FAILED",
  "AUTO_LISTING_PUBLICATION_HEALTH_CHECK_FAILED",
]);

function routeError(code, status = 400) {
  const error = new Error("自动上架上传策略请求无效");
  error.code = code;
  error.status = status;
  return error;
}

function body(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype
    || Reflect.ownKeys(raw).length !== BODY_KEYS.size
    || Reflect.ownKeys(raw).some((key) => typeof key !== "string" || !BODY_KEYS.has(key))) {
    throw routeError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID");
  }
  return raw;
}

function emptyBody(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype
    || Reflect.ownKeys(raw).length !== 0) {
    throw routeError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID");
  }
  return raw;
}

function response(error) {
  if (Number(error?.status) === 401) {
    return { status: 401, payload: { ok: false, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录" } };
  }
  if (Number(error?.status) === 403 || error?.code === "PERMISSION_FORBIDDEN") {
    return { status: 403, payload: { ok: false, code: "PERMISSION_FORBIDDEN", message: "没有自动上架策略管理权限" } };
  }
  const code = SAFE_CODES.has(error?.code) ? error.code : "AUTO_LISTING_UPLOAD_POLICY_ADMIN_INTERNAL_ERROR";
  const supplied = Number(error?.status);
  const status = code === "AUTO_LISTING_UPLOAD_POLICY_ADMIN_INTERNAL_ERROR" ? 500
    : (Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied : 422);
  return { status, payload: { ok: false, code, message: status >= 500
    ? "自动上架策略服务暂时不可用" : "自动上架策略请求无效" } };
}

export function createAutoListingUploadPolicyAdminHttpHandler({
  authenticate, getService, readJson, sendJson,
} = {}) {
  if (typeof authenticate !== "function" || typeof getService !== "function"
    || typeof readJson !== "function" || typeof sendJson !== "function") {
    throw new TypeError("Auto-listing upload policy admin route dependencies are required");
  }
  return async function handleAutoListingUploadPolicyAdmin(req, res, url) {
    const healthRoute = url.pathname === HEALTH_PATH;
    if (url.pathname !== PATH && !healthRoute) return false;
    try {
      if (!url.searchParams || [...url.searchParams.keys()].length !== 0) {
        throw routeError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID");
      }
      if (!(healthRoute ? req.method === "POST" : ["GET", "POST"].includes(req.method))) {
        sendJson(res, 405, { ok: false, code: "AUTO_LISTING_UPLOAD_POLICY_ADMIN_METHOD_NOT_ALLOWED",
          message: "不支持的自动上架策略请求" });
        return true;
      }
      const actor = await authenticate(req);
      assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
      const service = await getService();
      if (healthRoute) {
        try { emptyBody(await readJson(req)); } catch (error) {
          if (error?.code) throw error;
          throw routeError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID");
        }
        const data = await service.checkPublicationHealth({ actor });
        sendJson(res, 201, { ok: true, data });
      } else if (req.method === "GET") {
        const data = await service.listPolicies({ actor });
        sendJson(res, 200, { ok: true, data });
      } else {
        let parsed;
        try { parsed = body(await readJson(req)); } catch (error) {
          if (error?.code) throw error;
          throw routeError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID");
        }
        const data = await service.publishPolicy({ actor, ...parsed });
        sendJson(res, 201, { ok: true, data });
      }
    } catch (error) {
      const safe = response(error);
      sendJson(res, safe.status, safe.payload);
    }
    return true;
  };
}

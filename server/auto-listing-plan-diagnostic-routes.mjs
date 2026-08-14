import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const BASE = "/admin/auto-listing/plan-diagnostics/items/";
const PATH = /^\/admin\/auto-listing\/plan-diagnostics\/items\/([^/]+)\/latest$/u;
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,239}$/u;
const SAFE_CODES = new Set([
  "AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID",
  "AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND",
  "AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED",
]);

function routeError(code, status = 400) {
  const error = new Error("规划诊断请求无效");
  error.code = code;
  error.status = status;
  return error;
}

function safeId(value) {
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value) ? value : null;
}

function decodeId(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!safeId(decoded) || decoded.includes("..")) throw routeError("AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID");
    return decoded;
  } catch (error) {
    if (error?.code) throw error;
    throw routeError("AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID");
  }
}

function response(error) {
  if (Number(error?.status) === 401) {
    return { status: 401, payload: { ok: false, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录" } };
  }
  if (Number(error?.status) === 403 || error?.code === "PERMISSION_FORBIDDEN") {
    return { status: 403, payload: { ok: false, code: "PERMISSION_FORBIDDEN", message: "没有 AI 内容诊断权限" } };
  }
  const code = SAFE_CODES.has(error?.code) ? error.code : "AUTO_LISTING_PLAN_DIAGNOSTIC_INTERNAL_ERROR";
  const supplied = Number(error?.status);
  const status = code === "AUTO_LISTING_PLAN_DIAGNOSTIC_INTERNAL_ERROR" ? 500
    : Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied : 422;
  return { status, payload: { ok: false, code, message: status >= 500
    ? "图片规划诊断暂时无法读取" : code === "AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND"
      ? "未找到该商品的图片规划诊断" : "图片规划诊断请求无效" } };
}

export function createAutoListingPlanDiagnosticHttpHandler({ authenticate, getService, sendJson } = {}) {
  if (typeof authenticate !== "function" || typeof getService !== "function" || typeof sendJson !== "function") {
    throw new TypeError("Auto-listing plan diagnostic route dependencies are required");
  }
  return async function handleAutoListingPlanDiagnostic(req, res, url) {
    if (!url.pathname.startsWith(BASE)) return false;
    try {
      const match = PATH.exec(url.pathname);
      if (!match) throw routeError("AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID");
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, code: "AUTO_LISTING_PLAN_DIAGNOSTIC_METHOD_NOT_ALLOWED",
          message: "不支持的图片规划诊断请求" });
        return true;
      }
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 1 || keys[0] !== "jobId" || url.searchParams.getAll("jobId").length !== 1) {
        throw routeError("AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID");
      }
      const itemId = decodeId(match[1]);
      const jobId = safeId(url.searchParams.get("jobId"));
      if (!jobId) throw routeError("AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID");
      const actor = await authenticate(req);
      assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
      const service = await getService();
      const data = await service.getLatest({
        actor: { id: actor.id, role: actor.role },
        jobId,
        itemId,
      });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      const safe = response(error);
      sendJson(res, safe.status, safe.payload);
    }
    return true;
  };
}

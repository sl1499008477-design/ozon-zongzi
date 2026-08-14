import { types } from "node:util";

import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const BASE = "/admin/auto-listing/plan-diagnostics/";
const PATH = /^\/admin\/auto-listing\/plan-diagnostics\/items\/([^/]+)\/latest$/u;
const REPLAY_PATH = "/admin/auto-listing/plan-diagnostics/replays";
const REPLAY_BODY_KEYS = new Set([
  "jobId", "itemId", "sourceSnapshotId", "expectedStatusVersion",
  "costConfirmed", "idempotencyKey", "correlationId",
]);
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,239}$/u;
const SAFE_CODES = new Set([
  "AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID",
  "AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND",
  "AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED",
  "AUTO_LISTING_PLAN_DIAGNOSTIC_IN_PROGRESS",
  "AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_ELIGIBLE",
  "AUTO_LISTING_PLAN_DIAGNOSTIC_IDEMPOTENCY_CONFLICT",
  "AUTO_LISTING_PLAN_DIAGNOSTIC_RESPONSE_UNKNOWN",
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

function exactReplayBody(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    return keys.length === REPLAY_BODY_KEYS.size && keys.every((key) => typeof key === "string"
      && REPLAY_BODY_KEYS.has(key) && descriptors[key]?.enumerable === true
      && Object.hasOwn(descriptors[key], "value"))
      && [value.jobId, value.itemId, value.sourceSnapshotId, value.idempotencyKey, value.correlationId].every(safeId)
      && Number.isSafeInteger(value.expectedStatusVersion) && value.expectedStatusVersion >= 1
      && value.expectedStatusVersion <= 2_147_483_647 && value.costConfirmed === true;
  } catch {
    return false;
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

export function createAutoListingPlanDiagnosticHttpHandler({ authenticate, getService, readJson, sendJson } = {}) {
  if (typeof authenticate !== "function" || typeof getService !== "function"
    || typeof readJson !== "function" || typeof sendJson !== "function") {
    throw new TypeError("Auto-listing plan diagnostic route dependencies are required");
  }
  return async function handleAutoListingPlanDiagnostic(req, res, url) {
    if (!url.pathname.startsWith(BASE)) return false;
    try {
      if (url.pathname === REPLAY_PATH) {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, code: "AUTO_LISTING_PLAN_DIAGNOSTIC_METHOD_NOT_ALLOWED",
            message: "不支持的图片规划诊断请求" });
          return true;
        }
        if ([...url.searchParams.keys()].length !== 0) throw routeError("AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID");
        const actor = await authenticate(req);
        assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
        const body = await readJson(req, { maxBytes: 256 * 1024, requireBody: true });
        if (!exactReplayBody(body)) throw routeError("AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID");
        const service = await getService();
        const result = await service.replay({ ...body, actor: { id: actor.id, role: actor.role } });
        sendJson(res, result.created ? 201 : 200, { ok: true, data: result.detail });
        return true;
      }
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

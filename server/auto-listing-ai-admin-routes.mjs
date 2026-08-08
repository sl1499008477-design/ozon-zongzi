import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const PROFILE_BASE = "/admin/auto-listing/ai-profiles";
const STRATEGY_BASE = "/admin/auto-listing/strategies/versions";
const PROFILE_ACTION = /^\/admin\/auto-listing\/ai-profiles\/([^/]+)\/(test|publish)$/;
const STRATEGY_PUBLISH = /^\/admin\/auto-listing\/strategies\/versions\/([^/]+)\/publish$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

function routeError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function decodeId(value) {
  try {
    const result = decodeURIComponent(value).trim();
    if (!SAFE_ID.test(result)) throw routeError("AUTO_LISTING_AI_ADMIN_REQUEST_INVALID");
    return result;
  } catch (error) {
    if (error?.code) throw error;
    throw routeError("AUTO_LISTING_AI_ADMIN_REQUEST_INVALID");
  }
}

function closedBody(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw routeError("AUTO_LISTING_AI_ADMIN_REQUEST_INVALID");
  }
  return value;
}

function classify(url) {
  if (url.pathname === PROFILE_BASE) return { kind: "profiles" };
  if (url.pathname === STRATEGY_BASE) return { kind: "strategies" };
  const profile = PROFILE_ACTION.exec(url.pathname);
  if (profile) return { kind: profile[2] === "test" ? "profile-test" : "profile-publish", id: decodeId(profile[1]) };
  const strategy = STRATEGY_PUBLISH.exec(url.pathname);
  if (strategy) return { kind: "strategy-publish", id: decodeId(strategy[1]) };
  return null;
}

function assertQuery(route, url, method) {
  const keys = [...url.searchParams.keys()];
  if (route.kind === "strategies" && method === "GET" && url.searchParams.getAll("strategyKey").length === 1
    && keys.length === 1 && keys[0] === "strategyKey" && SAFE_ID.test(url.searchParams.get("strategyKey") || "")) {
    return url.searchParams.get("strategyKey");
  }
  if (keys.length === 0 && !(route.kind === "strategies" && method === "GET")) return "";
  throw routeError("AUTO_LISTING_AI_ADMIN_REQUEST_INVALID");
}

function safeError(error) {
  if (Number(error?.status) === 401) {
    return { status: 401, payload: { ok: false, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录" } };
  }
  if (Number(error?.status) === 403 || error?.code === "PERMISSION_FORBIDDEN") {
    return { status: 403, payload: { ok: false, code: "PERMISSION_FORBIDDEN", message: "没有 AI 配置管理权限" } };
  }
  const code = typeof error?.code === "string" && /^(?:AUTO_LISTING_AI_ADMIN|AUTO_LISTING_AI_CAPABILITY|AI_GATEWAY_)[A-Z0-9_:-]*$/.test(error.code)
    ? error.code : "AUTO_LISTING_AI_ADMIN_INTERNAL_ERROR";
  const suppliedStatus = Number(error?.status);
  const status = code === "AUTO_LISTING_AI_ADMIN_INTERNAL_ERROR"
    ? 500 : (Number.isInteger(suppliedStatus) && suppliedStatus >= 400 && suppliedStatus <= 599 ? suppliedStatus : 422);
  return {
    status,
    payload: {
      ok: false,
      code,
      message: status >= 500 ? "AI 配置请求处理失败" : "AI 配置请求无效",
    },
  };
}

function methodAllowed(route, method) {
  if (route.kind === "profiles" || route.kind === "strategies") return method === "GET" || method === "POST";
  return method === "POST";
}

export function createAutoListingAiAdminHttpHandler({
  authenticate,
  getService,
  readJson,
  sendJson,
} = {}) {
  if (typeof authenticate !== "function" || typeof getService !== "function"
    || typeof readJson !== "function" || typeof sendJson !== "function") {
    throw new TypeError("Auto-listing AI admin route dependencies are required");
  }
  return async function handleAutoListingAiAdmin(req, res, url) {
    let route;
    try {
      route = classify(url);
    } catch (error) {
      const response = safeError(error);
      sendJson(res, response.status, response.payload);
      return true;
    }
    if (!route) return false;
    try {
      if (!methodAllowed(route, req.method)) {
        sendJson(res, 405, { ok: false, code: "AUTO_LISTING_AI_ADMIN_METHOD_NOT_ALLOWED", message: "不支持的 AI 配置请求方法" });
        return true;
      }
      const strategyKey = assertQuery(route, url, req.method);
      const actor = await authenticate(req);
      assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
      if (route.kind === "profile-test") {
        throw routeError("AUTO_LISTING_AI_ADMIN_LEGACY_CAPABILITY_ROUTE_RETIRED", 410);
      }
      const service = await getService();
      let data;
      let status = 200;
      if (req.method === "GET" && route.kind === "profiles") {
        data = await service.listGatewayProfiles({ actor });
      } else if (req.method === "GET" && route.kind === "strategies") {
        data = await service.listStrategyVersions({ actor, strategyKey });
      } else {
        let body;
        try { body = await readJson(req); } catch { throw routeError("AUTO_LISTING_AI_ADMIN_REQUEST_INVALID"); }
        if (route.kind === "profiles") {
          const input = closedBody(body, ["idempotencyKey", "correlationId", "profile"]);
          data = await service.createGatewayProfile({ actor, ...input });
          status = 201;
        } else if (route.kind === "profile-publish") {
          const input = closedBody(body, ["configVersion", "idempotencyKey", "correlationId"]);
          data = await service.publishGatewayProfile({ actor, profileId: route.id, ...input });
        } else if (route.kind === "strategies") {
          const input = closedBody(body, [
            "strategyKey", "version", "idempotencyKey", "correlationId", "content", "rules",
          ]);
          data = await service.createStrategyVersion({ actor, ...input });
          status = 201;
        } else {
          const input = closedBody(body, ["strategyKey", "version", "idempotencyKey", "correlationId"]);
          data = await service.publishStrategyVersion({ actor, strategyVersionId: route.id, ...input });
        }
      }
      sendJson(res, status, { ok: true, data });
    } catch (error) {
      const response = safeError(error);
      sendJson(res, response.status, response.payload);
    }
    return true;
  };
}

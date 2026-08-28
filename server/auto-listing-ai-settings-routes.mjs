import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const BASE = "/admin/auto-listing/ai-settings";
const CONNECTIONS = `${BASE}/connections`;
const PROFILES = `${BASE}/profiles`;
const CONNECTION_SYNC = /^\/admin\/auto-listing\/ai-settings\/connections\/([^/]+)\/sync$/u;
const PROFILE_ACTION = /^\/admin\/auto-listing\/ai-settings\/profiles\/([^/]+)\/(test|publish|rollback)$/u;
const PROFILE_CHANNEL_ADD = /^\/admin\/auto-listing\/ai-settings\/profiles\/([^/]+)\/versions\/([1-9][0-9]*)\/channels$/u;
const PROFILE_CHANNEL_STATUS = /^\/admin\/auto-listing\/ai-settings\/profiles\/([^/]+)\/versions\/([1-9][0-9]*)\/channels\/([^/]+)\/status$/u;
const CATALOG = /^\/admin\/auto-listing\/ai-settings\/catalogs\/([^/]+)$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const OVERVIEW_RESPONSE_BYTES = 64 * 1024;
const CATALOG_RESPONSE_BYTES = 1536 * 1024;
export const AUTO_LISTING_AI_SETTINGS_SAFE_CODES = Object.freeze([
  "AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID", "AUTO_LISTING_AI_SETTINGS_BASE_URL_INVALID",
  "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_FOUND",
  "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_SYNCABLE", "AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT",
  "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_ACTIVE", "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_VALIDATED",
  "AUTO_LISTING_AI_SETTINGS_CATALOG_NOT_FOUND", "AUTO_LISTING_AI_SETTINGS_MODEL_SELECTION_INVALID",
  "AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", "AUTO_LISTING_AI_SETTINGS_SYNC_ALREADY_RUNNABLE",
  "AUTO_LISTING_AI_SETTINGS_COST_CONFIRMATION_REQUIRED", "AUTO_LISTING_AI_SETTINGS_ROLLBACK_CAPABILITY_REQUIRED",
  "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED", "AUTO_LISTING_AI_PROFILE_NOT_FOUND",
  "AUTO_LISTING_AI_PROFILE_CAPABILITY_REQUIRED", "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT",
  "AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED", "AUTO_LISTING_AI_PROFILE_ROLLBACK_NOT_READY",
  "AUTO_LISTING_AI_PROFILE_AMBIGUOUS", "AUTO_LISTING_AI_PROFILE_VERSION_CONFLICT",
  "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED", "AI_GATEWAY_COST_CONFIRMATION_REQUIRED",
  "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN",
  "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT",
  "AUTO_LISTING_AI_ADMIN_LEGACY_CAPABILITY_QUARANTINED",
  "AUTO_LISTING_AI_SETTINGS_CAPABILITY_SUBCALL_CONFLICT",
  "AI_GATEWAY_PROFILE_NOT_FOUND", "AI_GATEWAY_PROFILE_VERSION_CONFLICT", "AI_GATEWAY_CAPABILITY_IN_PROGRESS",
  "AI_GATEWAY_CAPABILITY_REQUEST_INVALID", "PERMISSION_FORBIDDEN",
  "AUTO_LISTING_AI_SETTINGS_RESPONSE_TOO_LARGE",
  "AUTO_LISTING_AI_PROFILE_CHANNEL_NOT_FOUND", "AUTO_LISTING_AI_PROFILE_CHANNEL_NOT_CURRENT",
  "AUTO_LISTING_AI_PROFILE_CHANNEL_CONNECTION_INCOMPATIBLE", "AUTO_LISTING_AI_PROFILE_CHANNEL_REVALIDATION_REQUIRED",
  "AUTO_LISTING_AI_PROFILE_CHANNEL_CONNECTION_INELIGIBLE",
]);
const SAFE_CODES = new Set(AUTO_LISTING_AI_SETTINGS_SAFE_CODES);
const SECRET_KEYS = new Set([
  "gatewayKey", "encryptedSecret", "ciphertext", "iv", "authTag", "auth_tag", "authorization",
  "leaseToken", "lease_token",
]);

function routeError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function decodeId(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== decoded.trim() || !SAFE_ID.test(decoded) || decoded.includes("..")) throw routeError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
    return decoded;
  } catch (error) {
    if (error?.code) throw error;
    throw routeError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
  }
}

function classify(url) {
  if (url.pathname === BASE) return { kind: "overview" };
  if (url.pathname === CONNECTIONS) return { kind: "connection" };
  if (url.pathname === PROFILES) return { kind: "selection" };
  const channelStatus = PROFILE_CHANNEL_STATUS.exec(url.pathname);
  if (channelStatus) return { kind: "channel-status", id: decodeId(channelStatus[1]),
    version: Number(channelStatus[2]), channelId: decodeId(channelStatus[3]) };
  const channelAdd = PROFILE_CHANNEL_ADD.exec(url.pathname);
  if (channelAdd) return { kind: "channel-add", id: decodeId(channelAdd[1]), version: Number(channelAdd[2]) };
  const sync = CONNECTION_SYNC.exec(url.pathname);
  if (sync) return { kind: "sync", id: decodeId(sync[1]) };
  const action = PROFILE_ACTION.exec(url.pathname);
  if (action) return { kind: action[2], id: decodeId(action[1]) };
  const catalog = CATALOG.exec(url.pathname);
  if (catalog) return { kind: "catalog", id: decodeId(catalog[1]) };
  if (url.pathname.startsWith(`${BASE}/`) || url.pathname === BASE) return { kind: "invalid" };
  return null;
}

function overviewQuery(url) {
  const allowed = new Set(["connectionCursor", "profileCursor"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw routeError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
    }
  }
  const read = (key) => {
    const value = url.searchParams.get(key);
    if (value === null) return null;
    if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      throw routeError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
    }
    return value;
  };
  return { connectionCursor: read("connectionCursor"), profileCursor: read("profileCursor") };
}

function body(value, keys) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw routeError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
      throw routeError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
    }
    return Object.fromEntries(ownKeys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID") throw error;
    throw routeError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
  }
}

function safeOutput(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw routeError("AUTO_LISTING_AI_SETTINGS_INTERNAL_ERROR", 500);
    return value;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw routeError("AUTO_LISTING_AI_SETTINGS_INTERNAL_ERROR", 500);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => safeOutput(entry, seen));
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw routeError("AUTO_LISTING_AI_SETTINGS_INTERNAL_ERROR", 500);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || SECRET_KEYS.has(key) || ["__proto__", "constructor", "prototype"].includes(key)
        || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value")) {
        throw routeError("AUTO_LISTING_AI_SETTINGS_INTERNAL_ERROR", 500);
      }
      output[key] = safeOutput(descriptors[key].value, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function errorResponse(error) {
  if (Number(error?.status) === 401) {
    return { status: 401, payload: { ok: false, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录" } };
  }
  if (Number(error?.status) === 403 || error?.code === "PERMISSION_FORBIDDEN") {
    return { status: 403, payload: { ok: false, code: "PERMISSION_FORBIDDEN", message: "没有 AI 配置管理权限" } };
  }
  const code = SAFE_CODES.has(error?.code) ? error.code : "AUTO_LISTING_AI_SETTINGS_INTERNAL_ERROR";
  const supplied = Number(error?.status);
  const status = code === "AUTO_LISTING_AI_SETTINGS_INTERNAL_ERROR" ? 500
    : Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied : 422;
  return { status, payload: { ok: false, code,
    message: status >= 500 ? "AI 模型设置请求处理失败" : "AI 模型设置请求无效" } };
}

function boundedSuccess(data, maximumBytes) {
  const payload = { ok: true, data: safeOutput(data) };
  let serialized;
  try { serialized = JSON.stringify(payload); } catch { throw routeError("AUTO_LISTING_AI_SETTINGS_INTERNAL_ERROR", 500); }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw routeError("AUTO_LISTING_AI_SETTINGS_RESPONSE_TOO_LARGE", 500);
  }
  return payload;
}

function allowed(route, method) {
  return ["overview", "catalog"].includes(route.kind) ? method === "GET"
    : ["connection", "selection", "sync", "test", "publish", "rollback", "channel-add", "channel-status"].includes(route.kind)
      ? method === "POST" : false;
}

export function createAutoListingAiSettingsHttpHandler({ authenticate, getService, readJson, sendJson } = {}) {
  if (typeof authenticate !== "function" || typeof getService !== "function"
    || typeof readJson !== "function" || typeof sendJson !== "function") {
    throw new TypeError("Auto-listing AI settings route dependencies are required");
  }
  return async function handleAutoListingAiSettings(req, res, url) {
    let route;
    try {
      route = classify(url);
      if (!route) return false;
      if (route.kind === "invalid" || (route.kind !== "overview" && url.search !== "")) {
        throw routeError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
      }
      if (!allowed(route, req.method)) {
        sendJson(res, 405, { ok: false, code: "AUTO_LISTING_AI_SETTINGS_METHOD_NOT_ALLOWED",
          message: "不支持的 AI 模型设置请求方法" });
        return true;
      }
      const actor = await authenticate(req);
      assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
      const service = await getService();
      let data;
      let status = 200;
      if (route.kind === "overview") data = await service.getOverview({ actor, ...overviewQuery(url) });
      else if (route.kind === "catalog") data = await service.getCatalog({ actor, catalogId: route.id });
      else {
        let raw;
        try { raw = await readJson(req, { maxBytes: 64 * 1024, requireBody: true }); }
        catch { throw routeError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID"); }
        if (route.kind === "connection") {
          data = await service.createConnection({ actor, ...body(raw,
            ["idempotencyKey", "correlationId", "displayName", "baseUrl", "gatewayKey"]) });
          status = 201;
        } else if (route.kind === "sync") {
          data = await service.requestModelSync({ actor, connectionId: route.id,
            ...body(raw, ["connectionVersion", "idempotencyKey", "correlationId"]) });
        } else if (route.kind === "selection") {
          data = await service.createProfileSelection({ actor, ...body(raw, [
            "connectionId", "connectionVersion", "catalogId", "displayName", "textModel", "imageModel",
            "textProtocol", "imageProtocol", "idempotencyKey", "correlationId",
          ]) });
          status = 201;
        } else if (route.kind === "test") {
          data = await service.testProfile({ actor, profileId: route.id,
            ...body(raw, ["configVersion", "correlationId", "costConfirmed"]) });
        } else if (route.kind === "publish") {
          data = await service.publishProfile({ actor, profileId: route.id,
            ...body(raw, ["configVersion", "idempotencyKey", "correlationId"]) });
        } else if (route.kind === "channel-add") {
          data = await service.addProfileChannel({ actor, profileId: route.id, profileVersion: route.version,
            ...body(raw, ["connectionId", "connectionVersion", "displayName"]) });
        } else if (route.kind === "channel-status") {
          data = await service.setProfileChannelEnabled({ actor, profileId: route.id, profileVersion: route.version,
            channelId: route.channelId, ...body(raw, ["enabled"]) });
        } else {
          data = await service.rollbackProfile({ actor, profileId: route.id,
            ...body(raw, ["configVersion", "idempotencyKey", "correlationId", "costConfirmed"]) });
        }
      }
      sendJson(res, status, boundedSuccess(data,
        route.kind === "catalog" ? CATALOG_RESPONSE_BYTES : OVERVIEW_RESPONSE_BYTES));
    } catch (error) {
      const response = errorResponse(error);
      sendJson(res, response.status, response.payload);
    }
    return true;
  };
}

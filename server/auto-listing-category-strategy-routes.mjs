import { types } from "node:util";

import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const BASE = "/admin/auto-listing/category-strategies";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const DETAIL = /^\/admin\/auto-listing\/category-strategies\/([^/]+)$/u;
const ACTION = /^\/admin\/auto-listing\/category-strategies\/([^/]+)\/(sampling-sessions|sample-sets|analysis-attempts|publish|rollback)$/u;
const SAMPLE = /^\/admin\/auto-listing\/category-strategies\/([^/]+)\/samples\/([^/]+)$/u;

const BODY_KEYS = Object.freeze({
  settings: new Set(["expectedVersion", "mode", "idempotencyKey", "correlationId"]),
  drafts: new Set(["scope", "sourceCollectItemId", "expectedSourceVersion", "idempotencyKey", "correlationId"]),
  session: new Set(["expectedDraftVersion", "idempotencyKey", "correlationId"]),
  samples: new Set(["expectedDraftVersion", "sessionId", "sessionSecret", "samples", "idempotencyKey", "correlationId"]),
  remove: new Set(["expectedDraftVersion", "idempotencyKey", "correlationId"]),
  analysis: new Set(["costConfirmed", "idempotencyKey", "correlationId"]),
  detail: new Set(["expectedDraftVersion", "patch", "idempotencyKey", "correlationId"]),
  publish: new Set(["expectedDraftVersion", "expectedPublishedStrategyVersionId", "idempotencyKey", "correlationId"]),
  rollback: new Set(["targetStrategyVersionId", "expectedPublishedStrategyVersionId", "idempotencyKey", "correlationId"]),
});

function routeError(code = "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID", status = 400) {
  return Object.assign(new Error(code), { code, status });
}
function decodeId(raw) {
  try {
    const value = decodeURIComponent(raw);
    if (!SAFE_ID.test(value)) throw routeError();
    return value;
  } catch (error) {
    if (error?.code) throw error;
    throw routeError();
  }
}

function classify(pathname) {
  if (pathname === BASE) return { kind: "list" };
  if (pathname === `${BASE}/settings`) return { kind: "settings" };
  if (pathname === `${BASE}/drafts`) return { kind: "drafts" };
  const sample = SAMPLE.exec(pathname);
  if (sample) return { kind: "remove", draftId: decodeId(sample[1]), sampleId: decodeId(sample[2]) };
  const action = ACTION.exec(pathname);
  if (action) {
    const kinds = { "sampling-sessions": "session", "sample-sets": "samples",
      "analysis-attempts": "analysis", publish: "publish", rollback: "rollback" };
    return { kind: kinds[action[2]], draftId: decodeId(action[1]) };
  }
  const detail = DETAIL.exec(pathname);
  return detail ? { kind: "detail", draftId: decodeId(detail[1]) } : null;
}

function methodAllowed(route, method) {
  const methods = {
    list: ["GET"], settings: ["GET", "PATCH"], drafts: ["POST"], detail: ["GET", "PATCH"],
    session: ["POST"], samples: ["POST"], remove: ["DELETE"], analysis: ["POST"],
    publish: ["POST"], rollback: ["POST"],
  };
  return methods[route.kind].includes(method);
}

function closedBody(raw, keys) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw routeError();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw routeError();
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code) throw error;
    throw routeError();
  }
}

function safeResponse(error) {
  if (Number(error?.status) === 401) {
    return { status: 401, payload: { ok: false, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录" } };
  }
  if (Number(error?.status) === 403 || error?.code === "PERMISSION_FORBIDDEN") {
    return { status: 403, payload: { ok: false, code: "PERMISSION_FORBIDDEN", message: "没有类目策略管理权限" } };
  }
  const safe = typeof error?.code === "string"
    && /^AUTO_LISTING_CATEGORY_STRATEGY_[A-Z0-9_:-]{1,140}$/u.test(error.code);
  const code = safe ? error.code : "AUTO_LISTING_CATEGORY_STRATEGY_INTERNAL_ERROR";
  const supplied = Number(error?.status);
  const status = code === "AUTO_LISTING_CATEGORY_STRATEGY_INTERNAL_ERROR" ? 500
    : (Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied : 422);
  return { status, payload: { ok: false, code, message: status >= 500
    ? "类目策略服务暂时不可用" : "类目策略请求无法完成" } };
}

function statusFor(route) {
  return ["drafts", "session", "samples", "analysis", "publish", "rollback"].includes(route.kind) ? 201 : 200;
}

export function createAutoListingCategoryStrategyHttpHandler({
  authenticate, getService, readJson, sendJson,
} = {}) {
  if (typeof authenticate !== "function" || typeof getService !== "function"
    || typeof readJson !== "function" || typeof sendJson !== "function") {
    throw new TypeError("Auto-listing category strategy route dependencies are required");
  }
  return async function handleAutoListingCategoryStrategy(req, res, url) {
    let route;
    try { route = classify(url.pathname); } catch (error) {
      const response = safeResponse(error);
      sendJson(res, response.status, response.payload);
      return true;
    }
    if (!route) return false;
    try {
      if (!methodAllowed(route, req.method)) {
        sendJson(res, 405, { ok: false, code: "AUTO_LISTING_CATEGORY_STRATEGY_METHOD_NOT_ALLOWED",
          message: "不支持的类目策略请求方法" });
        return true;
      }
      if ([...url.searchParams.keys()].length !== 0) throw routeError();
      const actor = await authenticate(req);
      assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
      const service = await getService();
      let data;
      if (route.kind === "list") data = await service.listStrategies({ actor });
      else if (route.kind === "settings" && req.method === "GET") data = await service.getSettings({ actor });
      else if (route.kind === "detail" && req.method === "GET") {
        data = await service.getDraft({ actor, draftId: route.draftId });
      } else {
        let body;
        try { body = closedBody(await readJson(req), BODY_KEYS[route.kind]); } catch (error) {
          if (error?.code) throw error;
          throw routeError();
        }
        if (route.kind === "settings") data = await service.updateSettings({ actor, ...body });
        else if (route.kind === "drafts") data = await service.createDraft({ actor, ...body });
        else if (route.kind === "session") data = await service.startSamplingSession({ actor, draftId: route.draftId, ...body });
        else if (route.kind === "samples") data = await service.confirmSampleSet({ actor, draftId: route.draftId, ...body });
        else if (route.kind === "remove") data = await service.removeSample({ actor, draftId: route.draftId, sampleId: route.sampleId, ...body });
        else if (route.kind === "analysis") data = await service.createAnalysisAttempt({ actor, draftId: route.draftId, ...body });
        else if (route.kind === "detail") data = await service.updateDraft({ actor, draftId: route.draftId, ...body });
        else if (route.kind === "publish") data = await service.publishDraft({ actor, draftId: route.draftId, ...body });
        else data = await service.rollbackDraft({ actor, draftId: route.draftId, ...body });
      }
      sendJson(res, statusFor(route), { ok: true, data });
    } catch (error) {
      const response = safeResponse(error);
      sendJson(res, response.status, response.payload);
    }
    return true;
  };
}

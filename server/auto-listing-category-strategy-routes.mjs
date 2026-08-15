import { types } from "node:util";

import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const BASE = "/admin/auto-listing/category-strategies";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const DETAIL = /^\/admin\/auto-listing\/category-strategies\/([^/]+)$/u;
const ACTION = /^\/admin\/auto-listing\/category-strategies\/([^/]+)\/(sampling-sessions|sample-sets|analysis-attempts|publish|rollback)$/u;
const SAMPLE = /^\/admin\/auto-listing\/category-strategies\/([^/]+)\/samples\/([^/]+)$/u;
const THUMBNAIL = /^\/admin\/auto-listing\/category-strategies\/([^/]+)\/samples\/([^/]+)\/images\/([^/]+)\/thumbnail$/u;
const EXTENSION_BASE = "/extension/auto-listing/category-strategy";
const EXTENSION_ACTION = /^\/extension\/auto-listing\/category-strategy\/sampling-sessions\/([^/]+)\/(confirm|cancel)$/u;
const EXTENSION_SESSION = /^\/extension\/auto-listing\/category-strategy\/sampling-sessions\/([^/]+)$/u;

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
  const thumbnail = THUMBNAIL.exec(pathname);
  if (thumbnail) return { kind: "thumbnail", draftId: decodeId(thumbnail[1]),
    sampleId: decodeId(thumbnail[2]), imageId: decodeId(thumbnail[3]) };
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
    publish: ["POST"], rollback: ["POST"], thumbnail: ["GET"],
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
  if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_NOT_FOUND") {
    return { status: 404, payload: { ok: false, code: error.code, message: "样本缩略图不存在" } };
  }
  if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_HASH_MISMATCH") {
    return { status: 409, payload: { ok: false, code: error.code, message: "样本缩略图校验失败，请重新采样" } };
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
      } else if (route.kind === "thumbnail") {
        const bytes = await service.readSampleThumbnail({ actor, draftId: route.draftId,
          sampleId: route.sampleId, imageId: route.imageId });
        if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16 * 1024 * 1024
          || typeof res?.writeHead !== "function" || typeof res?.end !== "function") {
          throw routeError("AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_HASH_MISMATCH", 409);
        }
        res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": String(bytes.length),
          "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" });
        res.end(bytes);
        return true;
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

function extensionRoute(pathname) {
  if (pathname === `${EXTENSION_BASE}/readiness`) return { kind: "readiness" };
  const session = EXTENSION_SESSION.exec(pathname);
  if (session) return { kind: "get-session", sessionId: decodeId(session[1]) };
  const action = EXTENSION_ACTION.exec(pathname);
  return action ? { kind: action[2], sessionId: decodeId(action[1]) } : null;
}

function extensionResponse(error) {
  if (Number(error?.status) === 401) {
    return { status: 401, payload: { ok: false, code: "COLLECTOR_AUTH_REQUIRED",
      message: "请重新连接 Web 采集授权" } };
  }
  if (Number(error?.status) === 403) {
    return { status: 403, payload: { ok: false, code: "COLLECTOR_PERMISSION_DENIED",
      message: "当前扩展没有类目策略选样权限" } };
  }
  const safe = typeof error?.code === "string"
    && /^(?:AUTO_LISTING_CATEGORY_STRATEGY|COLLECTOR)_[A-Z0-9_:-]{1,140}$/u.test(error.code);
  const code = safe ? error.code : "AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_FAILED";
  const supplied = Number(error?.status);
  const status = Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied : 500;
  return { status, payload: { ok: false, code,
    message: status >= 500 ? "类目策略扩展服务暂时不可用" : "类目策略选样请求无法完成" } };
}

function extensionVersion(req) {
  const value = req?.headers?.["x-zongzi-extension-version"];
  if (typeof value !== "string" || value.length < 5 || value.length > 40) throw routeError();
  return value;
}

export function createAutoListingCategoryStrategyExtensionHttpHandler({
  authenticateExtension, getService, extensionChannel, readJson, sendJson,
} = {}) {
  if (typeof authenticateExtension !== "function" || typeof getService !== "function"
    || typeof extensionChannel?.markReady !== "function"
    || typeof extensionChannel?.getSession !== "function"
    || typeof extensionChannel?.putFacts !== "function"
    || typeof extensionChannel?.cancelSession !== "function"
    || typeof extensionChannel?.completeSession !== "function"
    || typeof readJson !== "function" || typeof sendJson !== "function") {
    throw new TypeError("Auto-listing category strategy extension route dependencies are required");
  }
  return async function handleCategoryStrategyExtension(req, res, url) {
    let route;
    try { route = extensionRoute(url.pathname); } catch (error) {
      const response = extensionResponse(error);
      sendJson(res, response.status, response.payload);
      return true;
    }
    if (!route) return false;
    try {
      const method = route.kind === "get-session" ? "GET" : "POST";
      if (req.method !== method) throw routeError(
        "AUTO_LISTING_CATEGORY_STRATEGY_METHOD_NOT_ALLOWED", 405);
      if ([...url.searchParams.keys()].length !== 0) throw routeError();
      const version = extensionVersion(req);
      const permission = ["readiness", "get-session"].includes(route.kind)
        ? "collector.job.read" : "collector.upload";
      const account = await authenticateExtension(req, permission);
      assertPermission(account, PERMISSIONS.AI_CONTENT_MANAGE);
      const accountId = decodeId(account?.id);
      if (route.kind === "readiness") {
        const body = closedBody(await readJson(req), new Set());
        void body;
        const data = await extensionChannel.markReady({ accountId, extensionVersion: version });
        sendJson(res, 200, { ok: true, data });
        return true;
      }
      if (route.kind === "get-session") {
        const data = await extensionChannel.getSession({ accountId, sessionId: route.sessionId,
          extensionVersion: version });
        sendJson(res, 200, { ok: true, data });
        return true;
      }
      if (route.kind === "cancel") {
        const body = closedBody(await readJson(req), new Set(["sessionId"]));
        if (decodeId(body.sessionId) !== route.sessionId) throw routeError();
        const service = await getService();
        let durable;
        let durableError;
        try {
          durable = await service.cancelSamplingSession({ actor: account, sessionId: route.sessionId });
        } catch (error) { durableError = error; }
        const cancelled = await extensionChannel.cancelSession({ accountId, sessionId: route.sessionId,
          extensionVersion: version });
        if (durableError) throw durableError;
        sendJson(res, 200, { ok: true, data: { cancelled: durable.cancelled === true,
          localSessionRemoved: cancelled } });
        return true;
      }
      const body = closedBody(await readJson(req), new Set([
        "sessionId", "pageFact", "samples", "idempotencyKey", "correlationId",
      ]));
      if (decodeId(body.sessionId) !== route.sessionId) throw routeError();
      const handoff = await extensionChannel.putFacts({ accountId, sessionId: route.sessionId,
        extensionVersion: version, pageFact: body.pageFact, samples: body.samples });
      const service = await getService();
      const data = await service.confirmSampleSet({
        actor: { id: handoff.actorId, role: "admin" }, draftId: handoff.draftId,
        expectedDraftVersion: handoff.expectedDraftVersion, sessionId: handoff.sessionId,
        sessionSecret: handoff.sessionSecret, samples: handoff.selections,
        idempotencyKey: decodeId(body.idempotencyKey), correlationId: decodeId(body.correlationId),
      });
      await extensionChannel.completeSession({ accountId, sessionId: route.sessionId });
      sendJson(res, 201, { ok: true, data });
    } catch (error) {
      const response = extensionResponse(error);
      sendJson(res, response.status, response.payload);
    }
    return true;
  };
}

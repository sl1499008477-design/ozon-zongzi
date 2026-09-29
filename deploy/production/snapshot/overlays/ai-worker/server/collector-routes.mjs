import { createCollectorAccountStatusRoutes } from "./collector-account-status-routes.mjs";
import * as defaultCollectorService from "./collector-desktop-service.mjs";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const permissionByAction = Object.freeze({
  upload: "collector.upload",
  readJob: "collector.job.read",
  readConfig: "collector.config.read",
});
const RETIRED_SCOPE_FIELDS = Object.freeze([
  "accountId",
  "storeId",
  "operatingStoreId",
  "dataCollectionStoreId",
  "sellerCompanyId",
]);

function routeError(message, status = 400, code = "COLLECTOR_ROUTE_INVALID_REQUEST") {
  return Object.assign(new Error(message), { status, code });
}

function defaultSendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  const headers = {
    "content-type": JSON_CONTENT_TYPE,
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  };
  if (typeof res.writeHead === "function") res.writeHead(status, headers);
  else {
    res.statusCode = status;
    for (const [key, value] of Object.entries(headers)) res.setHeader?.(key, value);
  }
  res.end(body);
}

async function defaultReadJson(req, { maxBytes = 10 * 1024 * 1024 } = {}) {
  if (req.body !== undefined) return req.body && typeof req.body === "object" ? req.body : {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw routeError("请求体过大", 413, "COLLECTOR_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be an object");
    }
    return parsed;
  } catch {
    throw routeError("请求体必须是有效的 JSON 对象", 400, "COLLECTOR_INVALID_JSON");
  }
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : value;
}

function toBoolean(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function withoutKeys(value, keys) {
  const result = { ...(value || {}) };
  for (const key of keys) delete result[key];
  return result;
}

function authenticatedAccount(value) {
  const account = value?.account || value;
  if (!account?.id) throw routeError("请先登录 ozon 粽子", 401, "COLLECTOR_AUTH_REQUIRED");
  return account;
}

function errorResponse(error) {
  const status = Number(error?.status);
  return {
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    payload: {
      ok: false,
      error: String(error?.message || "采集服务请求失败"),
      code: String(error?.code || "COLLECTOR_ROUTE_FAILED"),
      ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
    },
  };
}

function compile(path, methods) {
  return { path, methods };
}

function requiredPermission(method, pathname) {
  if (
    method === "GET"
    && (
      /^\/collector\/health\/?$/.test(pathname)
      || /^\/collector\/capabilities\/?$/.test(pathname)
      || /^\/collector\/sale-pricing\/?$/.test(pathname)
      || /^\/collector\/market-snapshots\/?$/.test(pathname)
      || /^\/collector\/category-mappings\/?$/.test(pathname)
      || /^\/collector\/fx\/probes\/active\/?$/.test(pathname)
    )
  ) {
    return permissionByAction.readConfig;
  }
  if (method === "GET") return permissionByAction.readJob;
  return permissionByAction.upload;
}

export function createCollectorHttpHandler({
  authenticate,
  service = defaultCollectorService,
  readAccountCounts,
  fxService,
  readJson = defaultReadJson,
  sendJson = defaultSendJson,
} = {}) {
  if (typeof authenticate !== "function") {
    throw new TypeError("createCollectorHttpHandler requires authenticate(req)");
  }

  const routes = [
    ...createCollectorAccountStatusRoutes({ readAccountCounts, fxService }),
    compile(/^\/collector\/sale-pricing\/?$/, {
      GET:async({account})=>({accountId:account.id,items:await service.listCollectorSalePricing(account.id)}),
    }),
    compile(/^\/collector\/capabilities\/?$/, {
      GET: async () => ({ capabilities: { exportDataFromRaw: true, eventBatch: true, durableHandoff: true,
        ...await service.collectorMediaCapabilities?.() } }),
    }),
    compile(/^\/collector\/health\/?$/, {
      GET: async ({ account }) => ({
        status: 200,
        payload: { health: await service.collectorDesktopHealth(account.id) },
      }),
    }),
    compile(/^\/collector\/devices\/?$/, {
      GET: async ({ account }) => ({ devices: await service.listCollectorDevices(account.id) }),
      POST: async ({ account, body }) => ({
        status: 201,
        payload: { device: await service.registerCollectorDevice(account.id, withoutKeys(body, ["accountId"])) },
      }),
    }),
    compile(/^\/collector\/devices\/([^/]+)\/?$/, {
      DELETE: async ({ account, match }) => ({
        deleted: await service.revokeCollectorDevice(account.id, decodeURIComponent(match[1])),
      }),
    }),
    compile(/^\/collector\/tasks\/?$/, {
      GET: async ({ account, url }) => service.listCollectorTasksPageForAccount({
        accountId: account.id,
        status: url.searchParams.get("status") || "",
        query: url.searchParams.get("query") || "",
        taskName: url.searchParams.get("taskName") || url.searchParams.get("name") || "",
        includeDeleted: toBoolean(url.searchParams.get("includeDeleted")),
        page: toNumber(url.searchParams.get("page")) ?? 1,
        pageSize: toNumber(url.searchParams.get("pageSize")) ?? 50,
      }),
      POST: async ({ account, body }) => ({
        status: 201,
        payload: {
          task: await service.createCollectorTask({
            ...withoutKeys(body, [...RETIRED_SCOPE_FIELDS, "createdBy"]),
            accountId: account.id,
            createdBy: account.id,
          }),
        },
      }),
    }),
    compile(/^\/collector\/tasks\/([^/]+)\/?$/, {
      GET: async ({ account, match }) => {
        const task = await service.getCollectorTaskForAccount(account.id, decodeURIComponent(match[1]));
        if (!task) throw routeError("采集任务不存在", 404, "COLLECTOR_TASK_NOT_FOUND");
        return { task };
      },
      PATCH: updateTask,
      PUT: updateTask,
      DELETE: async ({ account, match }) => ({
        deleted: await service.softDeleteCollectorTask(account.id, decodeURIComponent(match[1])),
      }),
    }),
    compile(/^\/collector\/tasks\/([^/]+)\/runs\/?$/, {
      GET: async ({ account, match, url }) => ({
        runs: await service.listCollectorRunsForTask({
          accountId: account.id,
          taskId: decodeURIComponent(match[1]),
          limit: toNumber(url.searchParams.get("limit")) ?? 100,
          offset: toNumber(url.searchParams.get("offset")) ?? 0,
        }),
      }),
      POST: async ({ account, match, body }) => {
        const result = await service.queueCollectorTaskRun({
          accountId: account.id,
          taskId: decodeURIComponent(match[1]),
          idempotencyKey: body.idempotencyKey || "",
          pricingConfigVersionId: body.pricingConfigVersionId || "",
          requestedBy: account.id,
        });
        return { status: result.duplicate ? 200 : 201, payload: result };
      },
    }),
    compile(/^\/collector\/runs\/([^/]+)\/?$/, {
      GET: async ({ account, match }) => {
        const run = await service.getCollectorRunForAccount(account.id, decodeURIComponent(match[1]));
        if (!run) throw routeError("任务运行不存在", 404, "COLLECTOR_RUN_NOT_FOUND");
        return { run };
      },
    }),
    compile(/^\/collector\/runs\/([^/]+)\/claim\/?$/, {
      POST: async ({ account, match, body }) => ({
        ...(await service.claimCollectorRun({
          accountId: account.id,
          runId: decodeURIComponent(match[1]),
          deviceId: body.deviceId,
          device: body.device || {},
          leaseSeconds: body.leaseSeconds,
        })),
      }),
    }),
    compile(/^\/collector\/runs\/([^/]+)\/heartbeat\/?$/, {
      POST: async ({ account, match, body }) => service.heartbeatCollectorRun({
        accountId: account.id,
        runId: decodeURIComponent(match[1]),
        deviceId: body.deviceId,
        leaseToken: body.leaseToken,
        leaseSeconds: body.leaseSeconds,
        progress: body.progress || {},
      }),
    }),
    compile(/^\/collector\/runs\/([^/]+)\/skus\/(claim|release)\/?$/, {
      POST: async ({ account, match, body }) => {
        const action = match[2] === "claim" ? service.claimCollectorRunSkus : service.releaseCollectorRunSkus;
        return action({ accountId: account.id, runId: decodeURIComponent(match[1]),
          deviceId: body.deviceId, leaseToken: body.leaseToken, skus: body.skus });
      },
    }),
    compile(/^\/collector\/runs\/([^/]+)\/product-groups\/claim\/?$/, {
      POST: async ({ account, match, body }) => service.claimCollectorRunProductGroup({
        accountId: account.id, runId: decodeURIComponent(match[1]), deviceId: body.deviceId,
        leaseToken: body.leaseToken, anchorSku: body.anchorSku, skus: body.skus,
      }),
    }),
    compile(/^\/collector\/runs\/([^/]+)\/product-groups\/([^/]+)\/(variants|release)\/?$/, {
      POST: async ({ account, match, body }) => {
        const action = match[3] === 'variants' ? service.saveCollectorRunGroupVariant : service.releaseCollectorRunProductGroup;
        return action({ accountId: account.id, runId: decodeURIComponent(match[1]), groupId: decodeURIComponent(match[2]),
          deviceId: body.deviceId, leaseToken: body.leaseToken, anchorSku: body.anchorSku, variant: body.variant });
      },
    }),
    compile(/^\/collector\/runs\/([^/]+)\/cancel-request\/?$/, {
      POST: async ({ account, match }) => ({
        run: await service.requestCollectorRunCancellation({
          accountId: account.id,
          runId: decodeURIComponent(match[1]),
          actorId: account.id,
        }),
      }),
    }),
    compile(/^\/collector\/runs\/([^/]+)\/(complete|fail|cancel)\/?$/, {
      POST: finishRun,
    }),
    compile(/^\/collector\/runs\/([^/]+)\/handoff\/retry\/?$/, {
      POST: async ({ account, match }) => ({ handoff: await service.retryCollectorRunHandoff({
        accountId: account.id, runId: decodeURIComponent(match[1]),
      }) }),
    }),
    compile(/^\/collector\/runs\/([^/]+)\/media-uploads\/?$/, {
      POST: async ({account,match,body}) => service.issueCollectorRunMediaUpload({
        ...withoutKeys(body,RETIRED_SCOPE_FIELDS),accountId:account.id,runId:decodeURIComponent(match[1]),
      }),
    }),
    compile(/^\/collector\/runs\/([^/]+)\/media-uploads\/([^/]+)\/confirm\/?$/, {
      POST: async ({account,match,body,res}) => {
        const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort();};
        res.once?.('close',abort);
        try{return await service.confirmCollectorRunMediaUpload({
          accountId:account.id,runId:decodeURIComponent(match[1]),uploadId:decodeURIComponent(match[2]),
          deviceId:body.deviceId,leaseToken:body.leaseToken,signal:controller.signal,
        });}finally{res.removeListener?.('close',abort);}
      },
    }),
    compile(/^\/collector\/runs\/([^/]+)\/items\/?$/, {
      GET: async ({ account, match, url }) => ({
        items: await service.listCollectorRunItems({
          view: url.searchParams.get("view") === "identity" ? "identity" : "full",
          accountId: account.id,
          runId: decodeURIComponent(match[1]),
          status: url.searchParams.get("status") || "",
          limit: toNumber(url.searchParams.get("limit")) ?? 500,
          offset: toNumber(url.searchParams.get("offset")) ?? 0,
        }),
      }),
      POST: upsertItems,
      PUT: upsertItems,
    }),
    compile(/^\/collector\/runs\/([^/]+)\/events\/?$/, {
      GET: async ({ account, match, url }) => ({
        events: await service.listCollectorRunEvents({
          accountId: account.id,
          runId: decodeURIComponent(match[1]),
          afterId: toNumber(url.searchParams.get("afterId")) ?? 0,
          limit: toNumber(url.searchParams.get("limit")) ?? 500,
          eventType: url.searchParams.get("eventType") || "",
        }),
      }),
      POST: async ({ account, match, body }) => {
        if (body.events !== undefined) {
          if (!Array.isArray(body.events) || !body.events.length || body.events.length > 50
            || body.events.some(event => !event || typeof event !== 'object' || Array.isArray(event))) {
            throw routeError('每批日志必须包含 1–50 个事件', 422, 'COLLECTOR_EVENT_BATCH_INVALID');
          }
          return { events: await service.appendCollectorRunEvents({ accountId: account.id,
            runId: decodeURIComponent(match[1]), actorType: 'account', actorId: account.id,
            events: body.events.map(event => ({ eventType: event.eventType, level: event.level || 'INFO',
              message: event.message || '', payload: event.payload || {} })),
          }) };
        }
        return { event: await service.appendCollectorRunEvent({
          accountId: account.id,
          runId: decodeURIComponent(match[1]),
          eventType: body.eventType,
          level: body.level || "INFO",
          message: body.message || "",
          actorType: "account",
          actorId: account.id,
          payload: body.payload || {},
        }) };
      },
    }),
    compile(/^\/collector\/runs\/([^/]+)\/(exports|export)\/?$/, {
      GET: async ({ account, match }) => ({
        exports: await service.listCollectorExportsForRun({
          accountId: account.id,
          runId: decodeURIComponent(match[1]),
        }),
      }),
    }),
    compile(/^\/collector\/exports\/([^/]+)\/?$/, {
      GET: async ({ account, match }) => {
        const exportRecord = await service.getCollectorExportForAccount(account.id, decodeURIComponent(match[1]));
        if (!exportRecord) throw routeError("导出记录不存在", 404, "COLLECTOR_EXPORT_NOT_FOUND");
        return { export: exportRecord };
      },
    }),
    compile(/^\/collector\/market-snapshots\/?$/, {
      GET: async ({ account, url }) => ({
        snapshots: await service.listCollectorMarketSnapshots({
          accountId: account.id,
          source: url.searchParams.get("source") || "ozon_seller_analytics",
          sourceIdentity: url.searchParams.get("sourceIdentity") || "",
          sourceSku: url.searchParams.get("sourceSku") || "",
          categoryId: url.searchParams.get("categoryId") || "",
          period: url.searchParams.get("period") || "",
          limit: toNumber(url.searchParams.get("limit")) ?? 500,
          offset: toNumber(url.searchParams.get("offset")) ?? 0,
        }),
      }),
      POST: async ({ account, body }) => ({
        snapshot: await service.upsertCollectorMarketSnapshot({
          ...withoutKeys(body, RETIRED_SCOPE_FIELDS),
          accountId: account.id,
        }),
      }),
    }),
    compile(/^\/collector\/category-mappings\/?$/, {
      GET: async ({ account, url }) => ({
        mappings: await service.listCollectorCategoryMappings({
          accountId: account.id,
          source: url.searchParams.get("source") || "ozon_seller_analytics",
          sourceIdentity: url.searchParams.get("sourceIdentity") || "",
          rootCategoryId: url.searchParams.get("rootCategoryId") || "",
          status: url.searchParams.get("status") || "ACTIVE",
          limit: toNumber(url.searchParams.get("limit")) ?? 5000,
        }),
      }),
      POST: async ({ account, body }) => ({
        mapping: await service.upsertCollectorCategoryMapping({
          ...withoutKeys(body, RETIRED_SCOPE_FIELDS),
          accountId: account.id,
        }),
      }),
    }),
  ];

  async function updateTask({ account, match, body }) {
    return {
      task: await service.updateCollectorTask({
        accountId: account.id,
        taskId: decodeURIComponent(match[1]),
        patch: body.patch && typeof body.patch === "object"
          ? withoutKeys(body.patch, [...RETIRED_SCOPE_FIELDS, "createdBy"])
          : withoutKeys(body, [...RETIRED_SCOPE_FIELDS, "createdBy", "expectedVersion"]),
        expectedVersion: body.expectedVersion ?? null,
      }),
    };
  }

  async function finishRun({ account, match, body }) {
    const action = match[2];
    const method = action === "complete"
      ? service.completeCollectorRun
      : action === "fail"
        ? service.failCollectorRun
        : service.cancelCollectorRun;
    return {
      run: await method({
        accountId: account.id,
        runId: decodeURIComponent(match[1]),
        deviceId: body.deviceId,
        leaseToken: body.leaseToken,
        resultSummary: body.resultSummary || {},
        errorCode: body.errorCode || "",
        errorMessage: body.errorMessage || "",
      }),
    };
  }

  async function upsertItems({ account, match, body }) {
    const runId = decodeURIComponent(match[1]);
    const items = Array.isArray(body.items)
      ? body.items
      : [body.item && typeof body.item === "object"
        ? body.item
        : withoutKeys(body, ["accountId", "deviceId", "leaseToken", "items", "item"])];
    if (!items.length) throw routeError("商品列表不能为空", 422, "COLLECTOR_ITEMS_REQUIRED");
    const results = [];
    for (const item of items) {
      results.push(await service.upsertCollectorRunItem({
        accountId: account.id,
        runId,
        deviceId: body.deviceId,
        leaseToken: body.leaseToken,
        item: withoutKeys(item, ["accountId", "runId", "deviceId", "leaseToken"]),
      }));
    }
    if (!Array.isArray(body.items)) return results[0];
    return {
      items: results.map((result) => result.item),
      results,
      createdCount: results.filter((result) => result.created).length,
    };
  }

  return async function handleCollectorHttpRequest(req, res) {
    const url = new URL(req.url || "/", "http://collector.local");
    const route = routes.map((candidate) => ({ candidate, match: url.pathname.match(candidate.path) }))
      .find(({ match }) => match);
    if (!route) return false;
    const method = String(req.method || "GET").toUpperCase();
    const action = route.candidate.methods[method];
    if (!action) {
      sendJson(res, 405, {
        ok: false,
        error: "请求方法不被允许",
        code: "COLLECTOR_METHOD_NOT_ALLOWED",
      }, { allow: Object.keys(route.candidate.methods).join(", ") });
      return true;
    }
    try {
      const account = authenticatedAccount(
        await authenticate(req, requiredPermission(method, url.pathname)),
      );
      const body = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(req) : {};
      const result = await action({ account, body, match: route.match, req, res, url });
      // Only an explicit response envelope carries an HTTP status; domain results
      // also use status for states such as CLAIMED, COLLECTING and COLLECTED.
      const hasPayload = result?.payload && typeof result.payload === "object";
      const status = hasPayload ? Number(result.status || 200) : 200;
      const payload = hasPayload
        ? result.payload
        : (result && typeof result === "object" ? result : {});
      sendJson(res, status, { ok: true, ...payload });
    } catch (error) {
      const formatted = errorResponse(error);
      sendJson(res, formatted.status, formatted.payload);
    }
    return true;
  };
}

export const createCollectorRoutes = createCollectorHttpHandler;

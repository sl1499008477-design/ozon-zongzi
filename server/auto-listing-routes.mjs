import { autoListingEnabled } from "./runtime-config.mjs";

const CREATE_PATH = "/auto-listing/jobs/from-collect-box";
const LIST_PATH = "/auto-listing/jobs";
const JOB_PATTERN = /^\/auto-listing\/jobs\/([^/]+)$/;
const CREATE_KEYS = new Set(["collectItemIds", "idempotencyKey", "config", "correlationId"]);
const SAFE_CODES = new Set([
  "AUTO_LISTING_DISABLED", "AUTO_LISTING_REQUEST_INVALID", "AUTO_LISTING_JOB_NOT_FOUND",
  "AUTO_LISTING_SOURCE_NOT_FOUND", "AUTO_LISTING_WAREHOUSE_NOT_FOUND", "AUTO_LISTING_STRATEGY_NOT_PUBLISHED",
  "AUTO_LISTING_CATEGORY_TARGET_STORE_MISMATCH", "AUTO_LISTING_VERSION_CONFLICT", "PERMISSION_FORBIDDEN",
  "AUTO_LISTING_CONFIG_INVALID", "AUTO_LISTING_CONFIG_FORBIDDEN_FIELD",
]);
const SENSITIVE_KEY = /(?:account|actor|owner|raw(?:response|body|evidence)?|credential|secret|api.?key|authorization|token|password)/i;

function text(value, maximum = 240) {
  const result = typeof value === "string" ? value.trim() : "";
  return result && result.length <= maximum ? result : "";
}

function routeError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function safeCorrelation(value) {
  return text(value, 240);
}

function forbiddenPath(value, path = "body", seen = new WeakSet()) {
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return path;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = forbiddenPath(value[index], `${path}[${index}]`, seen);
      if (found) return found;
    }
    return "";
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return path;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) return `${path}.${key}`;
    const found = forbiddenPath(nested, `${path}.${key}`, seen);
    if (found) return found;
  }
  return "";
}

function parseCreateBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== CREATE_KEYS.size
    || Object.keys(value).some((key) => !CREATE_KEYS.has(key))) throw routeError("AUTO_LISTING_REQUEST_INVALID");
  if (forbiddenPath(value.collectItemIds, "collectItemIds")
    || forbiddenPath(value.config, "config")) throw routeError("AUTO_LISTING_REQUEST_INVALID");
  const collectItemIds = value.collectItemIds;
  if (!Array.isArray(collectItemIds) || collectItemIds.length < 1 || collectItemIds.length > 100
    || collectItemIds.some((item) => !text(item))) throw routeError("AUTO_LISTING_REQUEST_INVALID");
  if (!text(value.idempotencyKey) || !text(value.correlationId)
    || !value.config || typeof value.config !== "object" || Array.isArray(value.config)) {
    throw routeError("AUTO_LISTING_REQUEST_INVALID");
  }
  return {
    collectItemIds: collectItemIds.map((item) => text(item)),
    idempotencyKey: text(value.idempotencyKey),
    config: value.config,
    correlationId: text(value.correlationId),
  };
}

function parseLimit(url) {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 20;
  if (!/^\d{1,3}$/.test(raw)) throw routeError("AUTO_LISTING_REQUEST_INVALID");
  const limit = Number(raw);
  if (limit < 1 || limit > 100) throw routeError("AUTO_LISTING_REQUEST_INVALID");
  return limit;
}

function parseJobId(match) {
  try {
    const jobId = text(decodeURIComponent(match[1]));
    if (!jobId || !/^[A-Za-z0-9._:-]+$/.test(jobId)) throw routeError("AUTO_LISTING_REQUEST_INVALID");
    return jobId;
  } catch (caught) {
    if (caught?.code) throw caught;
    throw routeError("AUTO_LISTING_REQUEST_INVALID");
  }
}

function safePrice(price) {
  if (!price || typeof price !== "object" || Array.isArray(price) || price.currency !== "RUB") return undefined;
  const output = {};
  for (const key of ["currency", "branch", "blackKopecks", "greenKopecks", "realPriceKopecks", "adjustmentKopecks", "finalPriceKopecks"]) {
    if (typeof price[key] === "string" && price[key].length <= 80) output[key] = price[key];
  }
  return output.currency === "RUB" ? output : undefined;
}

function safeItem(item = {}) {
  const source = item && typeof item === "object" && !Array.isArray(item) ? item : {};
  const output = {};
  const fields = [["itemId", "itemId", "id"], ["status", "status"], ["createdAt", "createdAt", "created_at"], ["updatedAt", "updatedAt", "updated_at"], ["targetStoreId", "targetStoreId", "target_store_id"], ["targetWarehouseId", "targetWarehouseId", "target_warehouse_id"], ["sourceRecordId", "sourceRecordId", "source_record_id"], ["sourceVersion", "sourceVersion", "source_version"], ["sourceHash", "sourceHash", "source_hash", "snapshotHash"], ["strategyId", "strategyId", "strategy_id"], ["strategyVersionId", "strategyVersionId", "strategy_version_id"], ["style", "style"], ["matchedBy", "matchedBy", "matched_by"], ["failureCode", "failureCode", "failure_code"]];
  for (const [name, ...candidates] of fields) {
    const value = candidates.map((key) => source[key]).find((candidate) => typeof candidate === "string" && candidate.length <= 512);
    if (value) output[name] = value;
  }
  const price = safePrice(source.price);
  if (price) output.price = price;
  return output;
}

function safeJob(job = {}) {
  const source = job && typeof job === "object" && !Array.isArray(job) ? job : {};
  const output = {
    jobId: text(source.jobId || source.id) || "",
    sourceType: text(source.sourceType || source.source_type) || "COLLECT_BOX",
    status: text(source.status) || "CREATED",
    items: Array.isArray(source.items) ? source.items.map(safeItem) : [],
  };
  for (const key of ["correlationId", "createdAt", "updatedAt"]) {
    const sourceKey = key === "correlationId" ? source.correlationId || source.correlation_id : source[key] || source[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
    if (typeof sourceKey === "string" && sourceKey.length <= 512) output[key] = sourceKey;
  }
  return output;
}

function messageFor(code) {
  if (code === "AUTO_LISTING_DISABLED") return "自动上架功能暂未启用";
  if (code === "AUTO_LISTING_JOB_NOT_FOUND") return "自动上架任务不存在";
  if (code === "PERMISSION_FORBIDDEN") return "没有该操作权限";
  if (code === "AUTO_LISTING_REQUEST_INVALID") return "自动上架请求无效";
  return "自动上架请求处理失败";
}

function errorEnvelope(error, correlationId) {
  const status = Number(error?.status);
  if (status === 401) return { status: 401, payload: { ok: false, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录", correlationId } };
  const code = typeof error?.code === "string" && SAFE_CODES.has(error.code) ? error.code : "AUTO_LISTING_INTERNAL_ERROR";
  const safeStatus = code === "AUTO_LISTING_INTERNAL_ERROR" ? 500 : (Number.isInteger(status) && status >= 400 && status <= 599 ? status : 422);
  return { status: safeStatus, payload: { ok: false, code, message: messageFor(code), correlationId } };
}

function namespace(pathname) {
  return pathname === CREATE_PATH || pathname === LIST_PATH || JOB_PATTERN.test(pathname);
}

export function createAutoListingHttpHandler({
  isEnabled = autoListingEnabled,
  authenticate,
  runtime,
  readJson,
  sendJson,
} = {}) {
  if (typeof isEnabled !== "function" || typeof authenticate !== "function" || typeof runtime?.getService !== "function"
    || typeof readJson !== "function" || typeof sendJson !== "function") {
    throw new TypeError("Auto listing route dependencies are required");
  }
  return async function handleAutoListingRoute(req, res, url) {
    if (!namespace(url.pathname)) return false;
    let correlationId = "";
    try {
      const actor = await authenticate(req);
      const jobMatch = url.pathname.match(JOB_PATTERN);
      if (!((req.method === "POST" && url.pathname === CREATE_PATH)
        || (req.method === "GET" && url.pathname === LIST_PATH)
        || (req.method === "GET" && jobMatch))) {
        sendJson(res, 405, { ok: false, code: "AUTO_LISTING_METHOD_NOT_ALLOWED", message: "不支持的自动上架请求方法", correlationId });
        return true;
      }
      let body;
      if (req.method === "POST" && url.pathname === CREATE_PATH) {
        try {
          body = await readJson(req);
        } catch {
          throw routeError("AUTO_LISTING_REQUEST_INVALID");
        }
        correlationId = safeCorrelation(body?.correlationId);
      }
      if (!isEnabled()) {
        sendJson(res, 503, { ok: false, code: "AUTO_LISTING_DISABLED", message: messageFor("AUTO_LISTING_DISABLED"), correlationId });
        return true;
      }
      if (req.method === "POST") {
        const input = parseCreateBody(body);
        const service = await runtime.getService();
        const data = await service.createAutoListingJob({ actor, ...input });
        sendJson(res, 201, { ok: true, data: safeJob(data), correlationId: input.correlationId });
      } else if (jobMatch) {
        const jobId = parseJobId(jobMatch);
        const service = await runtime.getService();
        const data = await service.getAutoListingJob({ actor, jobId });
        sendJson(res, 200, { ok: true, data: safeJob(data), correlationId });
      } else {
        const limit = parseLimit(url);
        const service = await runtime.getService();
        const data = await service.listAutoListingJobs({ actor, limit });
        sendJson(res, 200, { ok: true, data: (Array.isArray(data) ? data : []).map(safeJob), correlationId });
      }
    } catch (caught) {
      const response = errorEnvelope(caught, correlationId);
      sendJson(res, response.status, response.payload);
    }
    return true;
  };
}

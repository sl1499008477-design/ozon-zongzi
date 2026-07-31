import { sanitizeCollectorText } from "./collector-auth-service.mjs";
import {
  parseOzonBatchEnrichmentRequest,
  parseOzonEnrichmentRequest,
} from "./collector-ozon-enrichment-contract.mjs";
import { findRetiredCollectorScopePath } from "./collector-scope-sanitizer.mjs";

const PERMISSION = "collector.ozon.read";
const SINGLE_PATH = "/collector/ozon/enrich";
const BATCH_PATH = "/collector/ozon/enrich/batch";
const NEXT_PATH = "/collector/ozon/enrichment-jobs/next";
const RESULT_PATTERN = /^\/collector\/ozon\/enrichment-jobs\/([^/]+)\/result\/?$/;
const FAIL_PATTERN = /^\/collector\/ozon\/enrichment-jobs\/([^/]+)\/fail\/?$/;
const JOB_NAMESPACE = "/collector/ozon/enrichment-jobs/";

const SENSITIVE_KEY_FRAGMENT = /(?:authorization|cookie|credential|password|passphrase|secret|token|apikey|privatekey)/;
const SECRET_VALUE = /(?:\bCollector\s+(?:cst|ctt)_[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}|\b(?:cst|ctt)_[A-Za-z0-9_-]{16,})/i;
const PUBLIC_ERROR_CODES = new Set([
  "METHOD_NOT_ALLOWED",
  "COLLECTOR_AUTH_REQUIRED",
  "COLLECTOR_ACCOUNT_INACTIVE",
  "COLLECTOR_PARENT_SESSION_REVOKED",
  "COLLECTOR_PARENT_SESSION_EXPIRED",
  "COLLECTOR_SESSION_INVALID",
  "COLLECTOR_SESSION_REVOKED",
  "COLLECTOR_SESSION_EXPIRED",
  "COLLECTOR_PERMISSION_DENIED",
  "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
  "OZON_ENRICH_REQUEST_INVALID",
  "OZON_ENRICH_REQUEST_ID_REQUIRED",
  "OZON_ENRICH_SKU_REQUIRED",
  "OZON_ENRICH_BATCH_SKUS_REQUIRED",
  "OZON_ENRICH_BATCH_LIMIT",
  "OZON_ENRICH_NOT_FOUND",
  "OZON_ENRICH_INCOMPLETE",
  "OZON_ENRICH_BUSY",
  "OZON_ENRICH_REQUEST_EXPIRED",
  "OZON_ENRICHMENT_JOB_NOT_FOUND",
  "OZON_ENRICHMENT_JOB_OWNERSHIP",
  "OZON_ENRICH_UPSTREAM_FAILED",
]);

function routeError(message, status = 400, code = "OZON_ENRICH_REQUEST_INVALID") {
  return Object.assign(new Error(message), {
    status,
    code,
    missingFields: [],
    retryable: false,
  });
}

function canonicalKey(value) {
  return String(value || "").replace(/[_-]/g, "").toLowerCase();
}

function forbiddenNestedKey(value) {
  const key = canonicalKey(value);
  return SENSITIVE_KEY_FRAGMENT.test(key)
    || key.includes("header")
    || key === "action"
    || key.endsWith("action")
    || key === "script"
    || key.startsWith("script")
    || key.endsWith("script")
    || key === "url"
    || key.endsWith("url")
    || key === "uri"
    || key.endsWith("uri");
}

function assertPlainObject(value, message = "补全请求格式无效") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw routeError(message);
  }
}

function assertExactKeys(value, allowed) {
  assertPlainObject(value);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw routeError("补全请求包含不允许的字段");
  }
}

function findForbiddenNestedPath(value, path = "$", seen = new WeakSet()) {
  if (typeof value === "string" && SECRET_VALUE.test(value)) return path;
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenNestedPath(value[index], `${path}[${index}]`, seen);
      if (found) return found;
    }
    return "";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return path;
  for (const [key, nested] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (forbiddenNestedKey(key)) return childPath;
    const found = findForbiddenNestedPath(nested, childPath, seen);
    if (found) return found;
  }
  return "";
}

function assertNoClientControl(value) {
  const scopePath = findRetiredCollectorScopePath(value);
  if (scopePath) {
    throw routeError(
      `补全请求不能指定账号或店铺范围：${scopePath}`,
      400,
      "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
    );
  }
  const forbiddenPath = findForbiddenNestedPath(value);
  if (forbiddenPath) {
    throw routeError(
      `补全请求包含不允许的控制或敏感字段：${forbiddenPath}`,
      400,
      "OZON_ENRICH_REQUEST_INVALID",
    );
  }
}

function requiredString(value, message) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw routeError(message);
  return normalized;
}

function jobIdFromMatch(match) {
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    throw routeError("Ozon 商品补全任务标识无效");
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
    throw routeError("Ozon 商品补全任务标识无效");
  }
  return id;
}

function errorStatus(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function errorResponse(error) {
  const status = errorStatus(error);
  const known = typeof error?.code === "string" && PUBLIC_ERROR_CODES.has(error.code);
  return {
    ok: false,
    code: known ? error.code.slice(0, 120) : "OZON_ENRICH_UPSTREAM_FAILED",
    message: sanitizeCollectorText(
      known ? error.message : "Ozon 商品资料补全失败",
      { max: 240 },
    ),
    missingFields: known && Array.isArray(error?.missingFields)
      ? error.missingFields.map((field) => String(field)).slice(0, 5)
      : [],
    retryable: known
      ? error?.retryable ?? (status === 429 || status >= 500)
      : status === 429 || status >= 500,
  };
}

function isNamespacePath(pathname) {
  return pathname === SINGLE_PATH
    || pathname === BATCH_PATH
    || pathname === NEXT_PATH
    || pathname.startsWith(JOB_NAMESPACE);
}

export function createCollectorOzonEnrichmentHttpHandler({
  authenticate,
  service,
  readJson,
  sendJson,
} = {}) {
  if (
    typeof authenticate !== "function"
    || !service
    || ["enrichOne", "enrichBatch", "claimNext", "completeClaim", "failClaim"]
      .some((method) => typeof service[method] !== "function")
    || typeof readJson !== "function"
    || typeof sendJson !== "function"
  ) {
    throw new TypeError("Ozon enrichment routes dependencies are required");
  }

  return async function handleCollectorOzonEnrichmentRoute(req, res, url) {
    const pathname = url?.pathname || "";
    const resultMatch = pathname.match(RESULT_PATTERN);
    const failMatch = pathname.match(FAIL_PATTERN);
    const single = req.method === "POST" && pathname === SINGLE_PATH;
    const batch = req.method === "POST" && pathname === BATCH_PATH;
    const next = req.method === "GET" && pathname === NEXT_PATH;
    const result = req.method === "POST" && resultMatch;
    const fail = req.method === "POST" && failMatch;
    if (!single && !batch && !next && !result && !fail) {
      if (!isNamespacePath(pathname)) return false;
      sendJson(res, 405, errorResponse(routeError(
        "该 Ozon 商品补全接口不支持当前方法",
        405,
        "METHOD_NOT_ALLOWED",
      )));
      return true;
    }

    try {
      const session = await authenticate(req, PERMISSION);
      if ([...url.searchParams.keys()].length) {
        throw routeError("Ozon 商品补全接口不接受查询控制参数");
      }
      if (single) {
        const body = await readJson(req);
        assertNoClientControl(body);
        const input = parseOzonEnrichmentRequest(body);
        sendJson(res, 200, { ok: true, data: await service.enrichOne({ session, ...input }) });
        return true;
      }
      if (batch) {
        const body = await readJson(req);
        assertNoClientControl(body);
        const input = parseOzonBatchEnrichmentRequest(body);
        sendJson(res, 200, { ok: true, data: await service.enrichBatch({ session, ...input }) });
        return true;
      }
      if (next) {
        const body = await readJson(req);
        assertNoClientControl(body);
        assertExactKeys(body, []);
        sendJson(res, 200, { ok: true, job: await service.claimNext({ session }) });
        return true;
      }

      const body = await readJson(req);
      assertNoClientControl(body);
      if (result) {
        assertExactKeys(body, ["variantData"]);
        assertPlainObject(body.variantData, "Ozon 商品补全结果缺少 variantData");
        await service.completeClaim({
          session,
          jobId: jobIdFromMatch(resultMatch),
          variantData: body.variantData,
        });
        sendJson(res, 200, { ok: true });
        return true;
      }

      assertExactKeys(body, ["code", "message"]);
      await service.failClaim({
        session,
        jobId: jobIdFromMatch(failMatch),
        code: requiredString(body.code, "Ozon 商品补全失败缺少错误码"),
        message: requiredString(body.message, "Ozon 商品补全失败缺少错误说明"),
      });
      sendJson(res, 200, { ok: true });
      return true;
    } catch (error) {
      sendJson(res, errorStatus(error), errorResponse(error));
      return true;
    }
  };
}

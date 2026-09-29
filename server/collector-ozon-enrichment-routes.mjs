import { sanitizeCollectorText } from "./collector-auth-service.mjs";
import {
  parseOzonBatchEnrichmentRequest,
  parseOzonEnrichmentRequest,
} from "./collector-ozon-enrichment-contract.mjs";
import { findRetiredCollectorScopePath } from "./collector-scope-sanitizer.mjs";

const PERMISSION = "collector.ozon.read";
const SINGLE_PATH = "/collector/ozon/enrich";
const BATCH_PATH = "/collector/ozon/enrich/batch";
const OBSERVE_PATH = "/collector/ozon/seller-context/observe";
const NEXT_PATH = "/collector/ozon/enrichment-jobs/next";
const AVAILABLE_PATH = "/collector/ozon/enrichment-jobs/available";
const TASKS_PATH = "/collector/ozon/enrichment-jobs/tasks";
const TASK_CONTROL_PATH = "/collector/ozon/enrichment-jobs/tasks/control";
const RESULT_PATTERN = /^\/collector\/ozon\/enrichment-jobs\/([^/]+)\/result\/?$/;
const PROGRESS_PATTERN = /^\/collector\/ozon\/enrichment-jobs\/([^/]+)\/progress\/?$/;
const FAIL_PATTERN = /^\/collector\/ozon\/enrichment-jobs\/([^/]+)\/fail\/?$/;
const RETRY_PATTERN = /^\/ozon\/collect-box\/([^/]+)\/enrichment\/retry\/?$/;
const JOB_NAMESPACE = "/collector/ozon/enrichment-jobs/";
const CAPTURE_CLOCK_SKEW_MS = 5_000;
const CAPTURE_CONTEXT_TTL_MS = 10 * 60 * 1000;
const VARIANT_RESULT_KEYS = Object.freeze([
  "packagingCandidates",
  "description_category_id",
  "type_id",
  "weight",
  "depth",
  "width",
  "height",
  "attributes",
  "complex_attributes",
]);
const REQUIRED_VARIANT_RESULT_KEYS = Object.freeze(
  VARIANT_RESULT_KEYS.filter((key) => !["type_id", "packagingCandidates", "complex_attributes"].includes(key)),
);
const CAPTURE_CONTEXT_KEYS = Object.freeze(["sellerCompanyId", "revision", "observedAt"]);
const ATTRIBUTE_KEYS = Object.freeze(["key", "value", "collection", "dictionary_value_id", "values"]);

const SENSITIVE_KEY_FRAGMENT = /(?:authorization|cookie|credential|password|passphrase|secret|token|apikey|privatekey)/;
const EXACT_SENSITIVE_KEYS = new Set(["auth", "jwt", "session", "cookiejar"]);
const SECRET_VALUE = /(?:\bCollector\s+(?:csess|cst|ctt)_[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}|\b(?:csess|cst|ctt)_[A-Za-z0-9_-]{16,})/i;
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
  "ZONGZI_ENRICH_REQUEST_INVALID",
  "REQUEST_BODY_TOO_LARGE",
  "ZONGZI_ENRICH_REQUEST_ID_REQUIRED",
  "ZONGZI_ENRICH_SKU_REQUIRED",
  "ZONGZI_ENRICH_BATCH_SKUS_REQUIRED",
  "ZONGZI_ENRICH_BATCH_LIMIT",
  "ZONGZI_ENRICH_NOT_FOUND",
  "ZONGZI_PRODUCT_RUSSIAN_REQUIRED",
  "ZONGZI_ENRICH_INCOMPLETE",
  "ZONGZI_ENRICH_RETRY_EXHAUSTED",
    "ZONGZI_ENRICH_DATA_CONFLICT",
    "ZONGZI_ENRICH_BUNDLE_UNCERTAIN",
  "ZONGZI_ENRICH_BUSY",
  "ZONGZI_ENRICH_REQUEST_EXPIRED",
  "ZONGZI_ENRICHMENT_JOB_NOT_FOUND",
  "ZONGZI_ENRICHMENT_TASK_NOT_FOUND",
  "ZONGZI_ENRICHMENT_TASK_CANCELLED",
  "ZONGZI_ENRICHMENT_JOB_OWNERSHIP",
  "ZONGZI_ENRICH_UPSTREAM_FAILED",
  "SELLER_CONTEXT_REQUIRED",
  "SELLER_CONTEXT_CHANGED",
  "COLLECT_ITEM_NOT_FOUND",
]);

function routeError(message, status = 400, code = "ZONGZI_ENRICH_REQUEST_INVALID") {
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
  return EXACT_SENSITIVE_KEYS.has(key)
    || SENSITIVE_KEY_FRAGMENT.test(key)
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

function assertRequiredExactKeys(value, required, message) {
  assertPlainObject(value, message);
  if (
    Object.keys(value).length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw routeError(message);
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
      "ZONGZI_ENRICH_REQUEST_INVALID",
    );
  }
}

function positiveFiniteNumber(value, message, { integer = false } = {}) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value <= 0
    || (integer && (!Number.isSafeInteger(value)))
  ) {
    throw routeError(message);
  }
  return value;
}

function productScalar(value) {
  return typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function parseResultAttributeValue(value) {
  assertPlainObject(value, "Ozon 商品属性值无效");
  if (!Object.keys(value).length || Object.keys(value).some(key => !["value", "dictionary_value_id"].includes(key))) {
    throw routeError("Ozon 商品属性值包含不允许的字段");
  }
  const entry = {};
  if (Object.hasOwn(value, "value")) {
    if (!productScalar(value.value)) throw routeError("Ozon 商品属性值无效");
    entry.value = value.value;
  }
  if (Object.hasOwn(value, "dictionary_value_id")) {
    entry.dictionary_value_id = positiveFiniteNumber(value.dictionary_value_id, "Ozon 商品属性字典标识无效", { integer: true });
  }
  return entry;
}

function parseResultAttribute(value) {
  assertPlainObject(value, "Ozon 商品属性格式无效");
  if (Object.keys(value).some((key) => !ATTRIBUTE_KEYS.includes(key))) {
    throw routeError("Ozon 商品属性包含不允许的字段");
  }
  const key = String(value.key ?? "").trim();
  if (!/^\d{1,20}$/.test(key)) throw routeError("Ozon 商品属性标识无效");
  const hasValue = Object.hasOwn(value, "value");
  const hasCollection = Object.hasOwn(value, "collection");
  const hasValues = Object.hasOwn(value, "values");
  const hasDictionaryId = Object.hasOwn(value, "dictionary_value_id");
  if ((hasValue && hasCollection) || (!hasValue && !hasCollection && !hasValues && !hasDictionaryId)) {
    throw routeError("Ozon 商品属性值无效");
  }
  const attribute = { key };
  if (hasValues) {
    if (!Array.isArray(value.values)) throw routeError("Ozon 商品属性值无效");
    attribute.values = value.values.map(parseResultAttributeValue);
  }
  if (hasValue) {
    if (!productScalar(value.value)) throw routeError("Ozon 商品属性值无效");
    attribute.value = value.value;
  }
  if (hasCollection) {
    if (!Array.isArray(value.collection)) throw routeError("Ozon 商品属性值无效");
    attribute.collection = value.collection.map(entry => productScalar(entry) ? entry : parseResultAttributeValue(entry));
  }
  if (hasDictionaryId) {
    attribute.dictionary_value_id = positiveFiniteNumber(value.dictionary_value_id, "Ozon 商品属性字典标识无效", { integer: true });
  }
  return attribute;
}

function parseResultComplexGroup(value) {
  assertRequiredExactKeys(value, ["attributes"], "Ozon 商品复杂属性分组无效");
  if (!Array.isArray(value.attributes)) throw routeError("Ozon 商品复杂属性分组无效");
  return { attributes: value.attributes.map(attribute => {
    assertRequiredExactKeys(attribute, ["id", "complex_id", "values"], "Ozon 商品复杂属性格式无效");
    if (!Array.isArray(attribute.values)) throw routeError("Ozon 商品复杂属性值无效");
    return {
      id: positiveFiniteNumber(attribute.id, "Ozon 商品复杂属性标识无效", { integer: true }),
      complex_id: positiveFiniteNumber(attribute.complex_id, "Ozon 商品复杂属性分组标识无效", { integer: true }),
      values: attribute.values.map(parseResultAttributeValue),
    };
  }) };
}

function parseCaptureContext(value, at, { requireRecent = true } = {}) {
  assertRequiredExactKeys(
    value,
    CAPTURE_CONTEXT_KEYS,
    "Ozon Seller 采集证据格式无效",
  );
  const forbiddenPath = findForbiddenNestedPath(value);
  if (forbiddenPath) {
    throw routeError(
      `补全请求包含不允许的控制或敏感字段：${forbiddenPath}`,
      400,
      "ZONGZI_ENRICH_REQUEST_INVALID",
    );
  }
  const sellerCompanyId = String(value.sellerCompanyId ?? "").trim();
  if (!/^\d{4,15}$/.test(sellerCompanyId)) {
    throw routeError("Ozon Seller 公司标识无效");
  }
  const revision = value.revision;
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw routeError("Ozon Seller 采集证据版本无效");
  }
  if (
    typeof value.observedAt !== "string"
    || !value.observedAt.trim()
  ) {
    throw routeError("Ozon Seller 采集证据时间无效");
  }
  const observedAt = new Date(value.observedAt);
  if (
    Number.isNaN(observedAt.getTime())
    || (requireRecent && observedAt.getTime() < at.getTime() - CAPTURE_CONTEXT_TTL_MS)
    || observedAt.getTime() > at.getTime() + CAPTURE_CLOCK_SKEW_MS
  ) {
    throw routeError("Ozon Seller 采集证据时间无效");
  }
  return {
    sellerCompanyId,
    revision,
    observedAt: observedAt.toISOString(),
  };
}

function parseClaimFence(value) {
  const claimFence = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(claimFence)) {
    throw routeError("Ozon 商品补全任务围栏无效");
  }
  return claimFence;
}

function parseClaimEnvelope(body, at) {
  assertRequiredExactKeys(body, ["captureContext"], "Ozon Seller 领取快照格式无效");
  const scopeChecked = structuredClone(body);
  delete scopeChecked.captureContext?.sellerCompanyId;
  assertNoClientControl(scopeChecked);
  return { captureContext: parseCaptureContext(body.captureContext, at) };
}

function parseObserveEnvelope(body, at) {
  assertRequiredExactKeys(body, ["captureContext"], "Ozon Seller 观察快照格式无效");
  const scopeChecked = structuredClone(body);
  delete scopeChecked.captureContext?.sellerCompanyId;
  assertNoClientControl(scopeChecked);
  return { captureContext: parseCaptureContext(body.captureContext, at) };
}

function parseResultEnvelope(body, at) {
  assertRequiredExactKeys(
    body,
    ["variantData", "captureContext", "claimFence"],
    "Ozon 商品补全结果格式无效",
  );
  assertPlainObject(body.variantData, "Ozon 商品补全结果 variantData 格式无效");
  if (
    Object.keys(body.variantData).some((key) => !VARIANT_RESULT_KEYS.includes(key))
    || REQUIRED_VARIANT_RESULT_KEYS.some((key) => !Object.hasOwn(body.variantData, key))
  ) {
    throw routeError("Ozon 商品补全结果 variantData 格式无效");
  }

  const rawComplex = body.variantData.complex_attributes;
  if (!Array.isArray(body.variantData.attributes) || (rawComplex !== undefined && !Array.isArray(rawComplex))) {
    throw routeError("Ozon 商品属性格式无效");
  }
  // A product can exceed 100 attributes. Reject excessive input explicitly;
  // the HTTP reader independently keeps the existing 10 MiB request limit.
  const attributeCount = body.variantData.attributes.length
    + (rawComplex || []).reduce((count, group) => count + (Array.isArray(group?.attributes) ? group.attributes.length : 0), 0);
  if (attributeCount > 1000) throw routeError("Ozon 商品属性总数不能超过 1000 项");

  let packagingCandidates;
  if (body.variantData.packagingCandidates !== undefined) {
    if (!Array.isArray(body.variantData.packagingCandidates) || body.variantData.packagingCandidates.length !== 2) throw routeError('包装候选数据无效');
    packagingCandidates = body.variantData.packagingCandidates.map(value => {
      assertRequiredExactKeys(value, ['weightG','lengthMm','widthMm','heightMm'], '包装候选字段无效');
      return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, number === null ? null : positiveFiniteNumber(number, '包装候选数值无效')]));
    });
  }
  const scopeChecked = structuredClone(body);
  delete scopeChecked.captureContext.sellerCompanyId;
  assertNoClientControl(scopeChecked);
  const forbiddenPath = findForbiddenNestedPath(body);
  if (forbiddenPath) {
    throw routeError(
      `补全请求包含不允许的控制或敏感字段：${forbiddenPath}`,
      400,
      "ZONGZI_ENRICH_REQUEST_INVALID",
    );
  }

  const variantData = {
    ...(packagingCandidates ? {packagingCandidates} : {}),
    ...(rawComplex !== undefined ? { complex_attributes: rawComplex.map(parseResultComplexGroup) } : {}),
    description_category_id: positiveFiniteNumber(
      body.variantData.description_category_id,
      "Ozon 商品类目标识无效",
      { integer: true },
    ),
    ...(Object.hasOwn(body.variantData, "type_id") ? {
      type_id: positiveFiniteNumber(
        body.variantData.type_id,
        "Ozon 商品类型标识无效",
        { integer: true },
      ),
    } : {}),
    weight: body.variantData.weight === null ? null : positiveFiniteNumber(body.variantData.weight, "Ozon 商品重量无效"),
    depth: body.variantData.depth === null ? null : positiveFiniteNumber(body.variantData.depth, "Ozon 商品长度无效"),
    width: body.variantData.width === null ? null : positiveFiniteNumber(body.variantData.width, "Ozon 商品宽度无效"),
    height: body.variantData.height === null ? null : positiveFiniteNumber(body.variantData.height, "Ozon 商品高度无效"),
    attributes: Array.isArray(body.variantData.attributes)
      ? body.variantData.attributes.map(parseResultAttribute)
      : (() => { throw routeError("Ozon 商品属性格式无效"); })(),
  };
  return {
    variantData,
    captureContext: parseCaptureContext(body.captureContext, at, { requireRecent: false }),
    claimFence: parseClaimFence(body.claimFence),
  };
}

function parseProgressEnvelope(body, at) {
  assertRequiredExactKeys(body, ["captureContext", "claimFence"], "Ozon 商品补全进度格式无效");
  const scopeChecked = structuredClone(body);
  delete scopeChecked.captureContext?.sellerCompanyId;
  assertNoClientControl(scopeChecked);
  return {
    captureContext: parseCaptureContext(body.captureContext, at, { requireRecent: false }),
    claimFence: parseClaimFence(body.claimFence),
  };
}

function parseFailEnvelope(body, at) {
  assertPlainObject(body, "Ozon 商品补全失败格式无效");
  const required = ["code", "message", "captureContext", "claimFence"];
  if (required.some(key => !Object.hasOwn(body, key))
    || Object.keys(body).some(key => ![...required, "diagnostic"].includes(key))) {
    throw routeError("Ozon 商品补全失败格式无效");
  }
  // Error text and diagnostic fields are validated/redacted at failClaim, not
  // recursively rejected as product/control data before that boundary can run.
  return {
    ...parseProgressEnvelope({ captureContext: body.captureContext, claimFence: body.claimFence }, at),
    code: body.code,
    message: body.message,
    ...(Object.hasOwn(body, "diagnostic") ? { diagnostic: body.diagnostic } : {}),
  };
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
    code: known ? error.code.slice(0, 120) : "ZONGZI_ENRICH_UPSTREAM_FAILED",
    message: sanitizeCollectorText(
      known ? error.message : "Ozon 商品资料补全失败",
      { max: 1000 },
    ),
    ...(known && error?.diagnostic ? { diagnostic: error.diagnostic } : {}),
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
    || pathname === OBSERVE_PATH
    || pathname === NEXT_PATH
    || pathname === AVAILABLE_PATH
    || pathname.startsWith(JOB_NAMESPACE)
    || RETRY_PATTERN.test(pathname);
}

export function createCollectorOzonEnrichmentHttpHandler({
  authenticate,
  authenticateAccount,
  service,
  readJson,
  sendJson,
  now = () => new Date(),
} = {}) {
  if (
    typeof authenticate !== "function"
    || typeof authenticateAccount !== "function"
    || !service
    || [
      "enrichOne",
      "enrichBatch",
      "observeSellerContext",
      "claimNext",
      "hasAvailableJob",
      "completeClaim",
      "failClaim",
      "retryCollectItem",
    ]
      .some((method) => typeof service[method] !== "function")
    || typeof readJson !== "function"
    || typeof sendJson !== "function"
    || typeof now !== "function"
  ) {
    throw new TypeError("Ozon enrichment routes dependencies are required");
  }

  return async function handleCollectorOzonEnrichmentRoute(req, res, url) {
    const pathname = url?.pathname || "";
    const resultMatch = pathname.match(RESULT_PATTERN);
    const failMatch = pathname.match(FAIL_PATTERN);
    const progressMatch = pathname.match(PROGRESS_PATTERN);
    const retryMatch = pathname.match(RETRY_PATTERN);
    const single = req.method === "POST" && pathname === SINGLE_PATH;
    const batch = req.method === "POST" && pathname === BATCH_PATH;
    const observe = req.method === "POST" && pathname === OBSERVE_PATH;
    const next = req.method === "POST" && pathname === NEXT_PATH;
    const available = req.method === "POST" && pathname === AVAILABLE_PATH;
    const tasks = req.method === "POST" && pathname === TASKS_PATH;
    const taskControl = req.method === "POST" && pathname === TASK_CONTROL_PATH;
    const result = req.method === "POST" && resultMatch;
    const fail = req.method === "POST" && failMatch;
    const progress = req.method === "POST" && progressMatch;
    const retry = req.method === "POST" && retryMatch;
    if (!single && !batch && !observe && !next && !available && !tasks && !taskControl && !result && !fail && !progress && !retry) {
      if (!isNamespacePath(pathname)) return false;
      sendJson(res, 405, errorResponse(routeError(
        "该 Ozon 商品补全接口不支持当前方法",
        405,
        "METHOD_NOT_ALLOWED",
      )));
      return true;
    }

    try {
      const session = retry
        ? await authenticateAccount(req)
        : await authenticate(req, PERMISSION);
      if ([...url.searchParams.keys()].length) {
        throw routeError("Ozon 商品补全接口不接受查询控制参数");
      }
      if ((observe || available) && String(req?.headers?.cookie || "").trim()) {
        throw routeError("Ozon Seller 观察接口不接受 Cookie 控制");
      }
      if (single) {
        const body = await readJson(req);
        assertNoClientControl(body);
        const input = parseOzonEnrichmentRequest(body);
        const data = await service.enrichOne({ session, ...input });
        sendJson(res, data?.status === "PENDING" ? 202 : 200,
          data?.status === "PENDING" ? { ok: true, status: "PENDING" } : { ok: true, data });
        return true;
      }
      if (batch) {
        const body = await readJson(req);
        assertNoClientControl(body);
        const input = parseOzonBatchEnrichmentRequest(body);
        const data = await service.enrichBatch({ session, ...input });
        const pending = data.some(item => item.status === "PENDING");
        sendJson(res, pending ? 202 : 200, { ok: true, ...(pending ? { status: "PENDING" } : {}), data });
        return true;
      }
      if (observe) {
        const body = await readJson(req);
        const input = parseObserveEnvelope(body, new Date(now()));
        await service.observeSellerContext({ session, ...input });
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (next) {
        const body = await readJson(req);
        const input = parseClaimEnvelope(body, new Date(now()));
        sendJson(res, 200, { ok: true, job: await service.claimNext({ session, ...input }) });
        return true;
      }
      if (available) {
        const body = await readJson(req, { requireBody: true });
        assertRequiredExactKeys(body, [], "Ozon Seller 可用任务请求格式无效");
        sendJson(res, 200, { ok: true, available: await service.hasAvailableJob({ session }) });
        return true;
      }
      if (tasks || taskControl) {
        const body = await readJson(req, { requireBody: true });
        assertRequiredExactKeys(body, taskControl ? ['taskKey', 'action'] : [], '补全任务控制请求格式无效');
        if (tasks) {
          sendJson(res, 200, { ok: true, tasks: await service.listTasks({ session }) });
        } else {
          if (typeof body.taskKey !== 'string' || !/^(run|collect|request):[\s\S]+$/.test(body.taskKey)
            || !['pause', 'resume', 'cancel'].includes(body.action)) throw routeError('补全任务控制请求格式无效');
          sendJson(res, 200, { ok: true, task: await service.controlTask({ session, taskKey: body.taskKey, action: body.action }) });
        }
        return true;
      }

      if (retry) {
        const body = await readJson(req);
        assertNoClientControl(body);
        assertRequiredExactKeys(body, [], "手动重试请求格式无效");
        const accountId = requiredString(session?.id ?? session?.accountId, "需要账号认证");
        const data = await service.retryCollectItem({
          accountId,
          collectItemId: jobIdFromMatch(retryMatch),
        });
        sendJson(res, 200, { ok: true, data });
        return true;
      }

      const body = await readJson(req);
      if (progress) {
        const parsed = parseProgressEnvelope(body, new Date(now()));
        const data = await service.progressClaim({ session, jobId: jobIdFromMatch(progressMatch), ...parsed });
        sendJson(res, 200, { ok: true, ...data });
        return true;
      }
      if (result) {
        const parsed = parseResultEnvelope(body, new Date(now()));
        await service.completeClaim({
          session,
          jobId: jobIdFromMatch(resultMatch),
          ...parsed,
        });
        sendJson(res, 200, { ok: true });
        return true;
      }

      const parsed = parseFailEnvelope(body, new Date(now()));
      await service.failClaim({
        session,
        jobId: jobIdFromMatch(failMatch),
        ...parsed,
      });
      sendJson(res, 200, { ok: true });
      return true;
    } catch (error) {
      sendJson(res, errorStatus(error), errorResponse(error));
      return true;
    }
  };
}

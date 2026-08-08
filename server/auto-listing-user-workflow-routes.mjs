import { autoListingEnabled, autoListingExcelImportLimits } from "./runtime-config.mjs";

const PREFERENCES = "/auto-listing/preferences";
const EXCEL_IMPORT = "/auto-listing/imports/excel";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SAFE_ERROR_CODES = new Set([
  "AUTO_LISTING_USER_REQUEST_INVALID",
  "AUTO_LISTING_IMPORT_REQUEST_INVALID",
  "AUTO_LISTING_IMPORT_ACCOUNT_NOT_FOUND",
  "AUTO_LISTING_IMPORT_IDEMPOTENCY_CONFLICT",
  "AUTO_LISTING_IMPORT_OBJECT_CLEANUP_IN_PROGRESS",
  "AUTO_LISTING_IMPORT_PERSIST_FAILED",
  "AUTO_LISTING_IMPORT_STORAGE_FAILED",
  "AUTO_LISTING_IMPORT_STORAGE_VERIFY_FAILED",
  "AUTO_LISTING_IMPORT_CLEANUP_PERSIST_FAILED",
  "AUTO_LISTING_IMPORT_NOT_FOUND",
  "AUTO_LISTING_IMPORT_RECOVERY_INVALID",
  "AUTO_LISTING_IMPORT_RECOVERY_IDEMPOTENCY_CONFLICT",
  "AUTO_LISTING_IMPORT_RECOVERY_CONFLICT",
  "AUTO_LISTING_IMPORT_RECOVERY_PERSIST_FAILED",
  "AUTO_LISTING_IMPORT_ALREADY_RETRIED",
  "AUTO_LISTING_IMPORT_NOT_RETRYABLE",
  "AUTO_LISTING_EXCEL_ARCHIVE_LIMIT_EXCEEDED",
  "AUTO_LISTING_EXCEL_ARCHIVE_UNSAFE",
  "AUTO_LISTING_EXCEL_EXTENSION_UNSUPPORTED",
  "AUTO_LISTING_EXCEL_FILE_EMPTY",
  "AUTO_LISTING_EXCEL_FILE_TOO_LARGE",
  "AUTO_LISTING_EXCEL_LIMIT_INVALID",
  "AUTO_LISTING_EXCEL_PARSE_TIMEOUT",
  "AUTO_LISTING_EXCEL_ROW_LIMIT_EXCEEDED",
  "AUTO_LISTING_EXCEL_SKU_HEADER_MISSING",
  "AUTO_LISTING_EXCEL_VISIBLE_SHEET_MISSING",
  "AUTO_LISTING_EXCEL_WORKBOOK_EMPTY",
  "AUTO_LISTING_EXCEL_WORKBOOK_INVALID",
  "AUTO_LISTING_PREFERENCES_INVALID",
  "AUTO_LISTING_PREFERENCES_ACCOUNT_NOT_FOUND",
  "AUTO_LISTING_PREFERENCES_IDEMPOTENCY_CONFLICT",
  "AUTO_LISTING_PREFERENCES_VERSION_CONFLICT",
  "AUTO_LISTING_PREFERENCES_PERSIST_FAILED",
  "TARGET_STORE_REQUIRED",
  "TARGET_STORE_NOT_FOUND",
  "TARGET_STORE_DISABLED",
  "TARGET_STORE_CREDENTIALS_REQUIRED",
  "LISTING_WAREHOUSE_NOT_ELIGIBLE",
]);

function routeError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw routeError("AUTO_LISTING_USER_REQUEST_INVALID");
  return result;
}

function parsePreferences(value) {
  if (!exact(value, ["config", "expectedVersion", "idempotencyKey", "correlationId"])
    || !value.config || typeof value.config !== "object" || Array.isArray(value.config)
    || !Number.isInteger(value.expectedVersion) || value.expectedVersion < 0) {
    throw routeError("AUTO_LISTING_USER_REQUEST_INVALID");
  }
  return {
    config: value.config,
    expectedVersion: value.expectedVersion,
    idempotencyKey: id(value.idempotencyKey),
    correlationId: id(value.correlationId),
  };
}

function parseExcel(value, maxBytes) {
  const maxBase64Length = Math.ceil(maxBytes / 3) * 4;
  if (!exact(value, [
    "name", "contentType", "dataBase64", "sizeBytes", "config", "idempotencyKey", "correlationId",
  ]) || typeof value.name !== "string" || !value.name.toLowerCase().endsWith(".xlsx")
    || value.name.length > 512 || /[/\\\u0000-\u001f\u007f]/u.test(value.name)
    || value.contentType !== CONTENT_TYPE || typeof value.dataBase64 !== "string"
    || value.dataBase64.length < 4 || value.dataBase64.length > maxBase64Length
    || !BASE64.test(value.dataBase64) || !Number.isInteger(value.sizeBytes)
    || value.sizeBytes < 1 || value.sizeBytes > maxBytes
    || !value.config || typeof value.config !== "object" || Array.isArray(value.config)) {
    throw routeError("AUTO_LISTING_USER_REQUEST_INVALID");
  }
  const buffer = Buffer.from(value.dataBase64, "base64");
  if (buffer.length !== value.sizeBytes || buffer.toString("base64") !== value.dataBase64) {
    throw routeError("AUTO_LISTING_USER_REQUEST_INVALID");
  }
  return {
    name: value.name.trim(),
    contentType: value.contentType,
    buffer,
    config: value.config,
    idempotencyKey: id(value.idempotencyKey),
    correlationId: id(value.correlationId),
  };
}

function parseRetry(value) {
  if (!exact(value, ["expectedStatusVersion", "idempotencyKey", "correlationId"])
    || !Number.isInteger(value.expectedStatusVersion) || value.expectedStatusVersion < 0
    || value.expectedStatusVersion > 2_147_483_646) {
    throw routeError("AUTO_LISTING_USER_REQUEST_INVALID");
  }
  return {
    expectedStatusVersion: value.expectedStatusVersion,
    idempotencyKey: id(value.idempotencyKey), correlationId: id(value.correlationId),
  };
}

function routeKind(pathname) {
  if (pathname === PREFERENCES) return { kind: "preferences", importId: null };
  if (pathname === EXCEL_IMPORT) return { kind: "excel", importId: null };
  const match = /^\/auto-listing\/imports\/([^/]+?)(\/retry)?$/u.exec(pathname);
  if (!match) return null;
  let decoded;
  try { decoded = decodeURIComponent(match[1]); } catch { throw routeError("AUTO_LISTING_USER_REQUEST_INVALID"); }
  return { kind: match[2] ? "import-retry" : "import-detail", importId: id(decoded) };
}

function assertBodyless(req) {
  const headers = req?.headers || {};
  const contentLength = typeof headers.get === "function" ? headers.get("content-length") : headers["content-length"];
  const transferEncoding = typeof headers.get === "function" ? headers.get("transfer-encoding") : headers["transfer-encoding"];
  if ((contentLength !== undefined && contentLength !== null && String(contentLength).trim() !== "0")
    || (transferEncoding !== undefined && transferEncoding !== null && String(transferEncoding).trim())) {
    throw routeError("AUTO_LISTING_USER_REQUEST_INVALID");
  }
}

function safeError(error) {
  if (Number(error?.status) === 401) {
    return { status: 401, payload: { ok: false, code: "AUTO_LISTING_UNAUTHENTICATED", message: "请先登录" } };
  }
  if (Number(error?.status) === 403 || error?.code === "PERMISSION_FORBIDDEN") {
    return { status: 403, payload: { ok: false, code: "PERMISSION_FORBIDDEN", message: "没有自动上架操作权限" } };
  }
  const code = typeof error?.code === "string" && SAFE_ERROR_CODES.has(error.code)
    ? error.code : "AUTO_LISTING_USER_INTERNAL_ERROR";
  const supplied = Number(error?.status);
  const status = code === "AUTO_LISTING_USER_INTERNAL_ERROR" ? 500
    : (Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied : 422);
  return { status, payload: {
    ok: false,
    code,
    message: status >= 500 ? "自动上架请求处理失败" : "自动上架请求无效",
  } };
}

export function createAutoListingUserWorkflowHttpHandler({
  isEnabled = autoListingEnabled,
  getExcelLimits = autoListingExcelImportLimits,
  authenticate,
  getService,
  readJson,
  sendJson,
} = {}) {
  if (typeof isEnabled !== "function" || typeof getExcelLimits !== "function"
    || typeof authenticate !== "function" || typeof getService !== "function"
    || typeof readJson !== "function" || typeof sendJson !== "function") {
    throw new TypeError("Auto-listing user workflow route dependencies are required");
  }
  return async function handleAutoListingUserWorkflow(req, res, url) {
    let matched;
    try { matched = routeKind(url.pathname); } catch (error) {
      const response = safeError(error);
      sendJson(res, response.status, response.payload);
      return true;
    }
    if (!matched) return false;
    const { kind, importId } = matched;
    try {
      const actor = await authenticate(req);
      const allowed = kind === "preferences" ? ["GET", "PUT"]
        : kind === "import-detail" ? ["GET"] : ["POST"];
      if (!allowed.includes(req.method)) {
        sendJson(res, 405, { ok: false, code: "AUTO_LISTING_USER_METHOD_NOT_ALLOWED", message: "不支持的自动上架请求方法" });
        return true;
      }
      if (!isEnabled()) {
        sendJson(res, 503, { ok: false, code: "AUTO_LISTING_DISABLED", message: "自动上架功能暂未启用" });
        return true;
      }
      const limits = getExcelLimits();
      if (!Number.isSafeInteger(limits?.maxBytes) || limits.maxBytes < 1
        || !Number.isSafeInteger(limits?.maxRows) || limits.maxRows < 1) {
        throw routeError("AUTO_LISTING_EXCEL_LIMIT_INVALID", 500);
      }
      if ([...url.searchParams.keys()].length) throw routeError("AUTO_LISTING_USER_REQUEST_INVALID");
      if (req.method === "GET") assertBodyless(req);
      if (kind === "preferences" && req.method === "GET") {
        const service = await getService();
        const data = await service.getOverview({ actor, importLimit: 50 });
        sendJson(res, 200, { ok: true, data: data.preference, imports: data.imports, limits: data.limits });
        return true;
      }
      if (kind === "import-detail") {
        const service = await getService();
        const data = await service.getImportDetail({ actor, importId });
        sendJson(res, 200, { ok: true, data });
        return true;
      }
      let body;
      try { body = await readJson(req); } catch { throw routeError("AUTO_LISTING_USER_REQUEST_INVALID"); }
      const serviceInput = kind === "preferences" ? parsePreferences(body)
        : kind === "excel" ? parseExcel(body, limits.maxBytes) : parseRetry(body);
      const service = await getService();
      if (kind === "preferences") {
        const data = await service.savePreferences({ actor, ...serviceInput });
        sendJson(res, 200, { ok: true, data });
      } else if (kind === "excel") {
        const data = await service.createExcelImport({ actor, ...serviceInput });
        sendJson(res, 201, { ok: true, data });
      } else {
        const data = await service.retryImport({ actor, importId, ...serviceInput });
        sendJson(res, 202, { ok: true, data });
      }
    } catch (error) {
      const response = safeError(error);
      sendJson(res, response.status, response.payload);
    }
    return true;
  };
}

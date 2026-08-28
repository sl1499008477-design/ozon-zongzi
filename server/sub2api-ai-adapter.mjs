import { AiGatewayError, createAiGatewayPort } from "./ai-gateway-port.mjs";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import Ajv from "ajv";
import sharp from "sharp";
import { isCompatibleAiModelIdentity } from "./auto-listing-ai-model-identity.mjs";
import {
  createSub2ApiGatewayPolicy,
  normalizeSub2ApiGatewayBaseUrl,
  requireSub2ApiGatewayPolicy,
  verifySub2ApiGatewayDnsBoundary,
} from "./sub2api-gateway-boundary.mjs";

export const SUB2API_TEXT_PROTOCOLS = Object.freeze(["SUB2API_RESPONSES"]);
export const SUB2API_IMAGE_PROTOCOLS = Object.freeze([
  "SUB2API_RESPONSES_IMAGE_TOOL",
  "SUB2API_OPENAI_IMAGES",
]);

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "openai-request-id"];
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_IMAGE_BYTES_TOTAL = 32 * 1024 * 1024;
const MAX_SOURCE_IMAGES = 120;
const MAX_REQUEST_BODY_BYTES = 48 * 1024 * 1024;
const MAX_PROMPT_CHARACTERS = 100_000;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const MAX_MODELS = 2_000;
const MAX_CATALOG_SYNC_TIMEOUT_MS = 60_000;
const MAX_CALL_TIMEOUT_MS = 600_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const CATALOG_SYNC_DATABASE_MARGIN_MS = 15_000;
const ENCRYPTED_SECRET_REFERENCE = "SUB2API_ENCRYPTED_KEY";
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const CATALOG_SYNC_LEASE_KEYS = new Set([
  "accountId", "leaseToken", "leaseVersion", "taskId", "workerId",
]);
const CAPABILITY_EXECUTION_BASE_KEYS = new Set([
  "accountId", "profileId", "configVersion", "attemptId", "correlationId", "fence", "leaseVersion", "leaseToken",
  "purpose", "authorizationHash", "requestKey", "connectionId", "connectionVersion",
  "expectedConnectionStatus", "expectedConnectionStatusVersion",
]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/u;
const OWNED_BY = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,239}$/u;
const SUB2API_MODEL_DISPLAY_NAME = /^[^\u0000-\u001f\u007f]{1,240}$/u;
const SUB2API_MODEL_CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const DANGEROUS_ENV_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CAPABILITY_SOURCE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const FAILURE_EVENTS = new Set([
  "error",
  "response.failed",
  "response.incomplete",
  "response.cancelled",
  "response.canceled",
]);
const RETRYABLE_TERMINAL_TOKENS = new Set([
  "api_error",
  "overloaded_error",
  "rate_limit",
  "rate_limit_error",
  "rate_limit_exceeded",
  "server_error",
  "service_unavailable",
  "temporary",
  "temporary_error",
  "temporarily_unavailable",
  "timed_out",
  "timeout",
  "timeout_error",
  "upstream_error",
]);
const AUTH_TERMINAL_TOKENS = new Set([
  "auth",
  "authentication_error",
  "authorization_error",
  "invalid_api_key",
  "unauthorized",
]);
const MODEL_NOT_FOUND_TERMINAL_TOKENS = new Set([
  "model_not_found",
  "model_not_exists",
  "unknown_model",
]);

const schemaCompiler = new Ajv({
  allErrors: true,
  strict: true,
  validateSchema: true,
  removeAdditional: false,
  coerceTypes: false,
  useDefaults: false,
});
const UNSUPPORTED_STRUCTURED_SCHEMA_KEYWORDS = new Set([
  "uniqueItems", "oneOf", "allOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else",
]);

function clean(value, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function gatewayError(code, options = {}) {
  const messages = {
    AI_GATEWAY_PROFILE_INVALID: "AI 网关配置无效",
    AI_GATEWAY_PROFILE_DISABLED: "AI 网关配置未启用",
    AI_GATEWAY_REQUEST_INVALID: "AI 网关请求无效",
    AI_GATEWAY_SECRET_MISSING: "AI 网关密钥未配置",
    AI_GATEWAY_PROTOCOL_UNSUPPORTED: "AI 网关协议不受支持",
    AI_GATEWAY_MODEL_MISMATCH: "AI 网关模型与配置不一致",
    AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN: "AI 网关能力调用结果待恢复",
    AI_GATEWAY_INPUT_UNSUPPORTED: "AI 网关不支持该输入",
    GATEWAY_REDIRECT_BLOCKED: "AI 网关重定向被安全策略阻止",
    GATEWAY_TIMEOUT: "AI 网关请求超时",
    AI_GATEWAY_IDLE_TIMEOUT: "AI 网关长时间没有有效响应",
    GATEWAY_CANCELLED: "AI 网关请求已取消",
    AI_GATEWAY_NETWORK_FAILED: "AI 网关网络连接失败",
    AI_GATEWAY_UNEXPECTED_EOF: "AI 网关响应意外中断",
    AI_GATEWAY_RATE_LIMITED: "AI 网关额度或频率受限",
    RETRYABLE_GATEWAY: "AI 网关暂时不可用",
    NON_RETRYABLE_AUTH: "AI 网关鉴权失败",
    NON_RETRYABLE_GATEWAY: "AI 网关拒绝请求",
    INVALID_GATEWAY_RESPONSE: "AI 网关返回了无法识别的结果",
  };
  const error = new AiGatewayError(code, { ...options, message: messages[code] || "AI 网关调用失败" });
  const failureField = clean(options.failureField);
  if (/^(?:\$|\/[A-Za-z0-9_.~\/-]{1,239})$/u.test(failureField)) error.failureField = failureField;
  return error;
}

function withDeliveryState(error, deliveryState, retryAfterMs = null) {
  const safe = error instanceof AiGatewayError ? error : gatewayError("RETRYABLE_GATEWAY", { retryable: true });
  if (!Object.hasOwn(safe, "deliveryState")) {
    Object.defineProperties(safe, {
      deliveryState: { value: deliveryState, enumerable: true, writable: false, configurable: false },
      retryAfterMs: { value: retryAfterMs, enumerable: true, writable: false, configurable: false },
    });
  }
  return safe;
}

function safeRetryAfter(response) {
  let raw = "";
  try { raw = response?.headers?.get?.("retry-after"); } catch { return DEFAULT_RETRY_AFTER_MS; }
  if (typeof raw !== "string" || raw !== raw.trim() || !raw || raw.length > 128) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  if (/^\d+$/u.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1_000
      ? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS) : DEFAULT_RETRY_AFTER_MS;
  }
  const date = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/u.exec(raw);
  if (!date) return DEFAULT_RETRY_AFTER_MS;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [, day, month, year, hour, minute, second] = date;
  if (Number(year) < 1601) return DEFAULT_RETRY_AFTER_MS;
  const target = Date.UTC(Number(year), months.indexOf(month), Number(day), Number(hour), Number(minute), Number(second));
  if (!Number.isFinite(target) || new Date(target).toUTCString() !== raw) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.max(0, target - Date.now()), MAX_RETRY_AFTER_MS);
}

function profileField(profile, camel, snake = "") {
  return profile?.[camel] ?? (snake ? profile?.[snake] : undefined);
}

function ownDataFields(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!Object.hasOwn(descriptor, "value") || typeof descriptor.get === "function"
        || typeof descriptor.set === "function") return null;
      fields[key] = descriptor.value;
    }
    return fields;
  } catch { return null; }
}

function normalizeCatalogSyncLease(value) {
  const fields = ownDataFields(value);
  if (!fields || Object.keys(fields).length !== CATALOG_SYNC_LEASE_KEYS.size
    || Object.keys(fields).some((key) => !CATALOG_SYNC_LEASE_KEYS.has(key))
    || typeof fields.accountId !== "string" || fields.accountId !== fields.accountId.trim()
    || !SCOPE_ID.test(fields.accountId)
    || typeof fields.taskId !== "string" || fields.taskId !== fields.taskId.trim()
    || !SCOPE_ID.test(fields.taskId)
    || typeof fields.workerId !== "string" || fields.workerId !== fields.workerId.trim()
    || !SCOPE_ID.test(fields.workerId)
    || typeof fields.leaseToken !== "string" || fields.leaseToken !== fields.leaseToken.trim()
    || !SCOPE_ID.test(fields.leaseToken)
    || !Number.isSafeInteger(fields.leaseVersion) || fields.leaseVersion < 1) {
    throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  }
  return Object.freeze({
    accountId: fields.accountId,
    taskId: fields.taskId,
    workerId: fields.workerId,
    leaseVersion: fields.leaseVersion,
    leaseToken: fields.leaseToken,
  });
}

function normalizeCatalogSyncCredential(value, expectedAccountId) {
  const fields = ownDataFields(value);
  if (!fields || Object.keys(fields).length !== 2
    || !Object.hasOwn(fields, "connection") || !Object.hasOwn(fields, "secret")) {
    throw gatewayError("AI_GATEWAY_SECRET_MISSING");
  }
  const connectionFields = ownDataFields(fields.connection);
  const secret = typeof fields.secret === "string" ? fields.secret.trim() : "";
  if (!connectionFields || connectionFields.accountId !== expectedAccountId || !secret) {
    throw gatewayError("AI_GATEWAY_SECRET_MISSING");
  }
  return { connection: fields.connection, secret };
}

function capabilityExecutionForProbe(value, probe) {
  const fields = ownDataFields(value);
  const keys = fields ? Object.keys(fields) : [];
  if (!fields || keys.length !== CAPABILITY_EXECUTION_BASE_KEYS.size
    || keys.some((key) => !CAPABILITY_EXECUTION_BASE_KEYS.has(key))
    || !["REACHABILITY", "TEXT", "IMAGE"].includes(probe)) {
    throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  }
  return Object.freeze({ ...fields, probe });
}

function capabilityProviderIdentity(execution) {
  const digest = crypto.createHash("sha256").update(JSON.stringify({
    schemaVersion: "AI_GATEWAY_CAPABILITY_SUBCALL_V1",
    accountId: execution.accountId,
    attemptId: execution.attemptId,
    fence: execution.fence,
    requestKey: execution.requestKey,
    stage: execution.probe,
  }), "utf8").digest("hex");
  return Object.freeze({
    providerRequestKey: digest,
    providerCorrelationId: `cap_${digest.slice(0, 40)}`,
  });
}

function normalizeCapabilityCredential(value, profile) {
  const fields = ownDataFields(value);
  const secret = typeof fields?.secret === "string" ? fields.secret.trim() : "";
  const expectedConnectionId = profile.apiKeyEnvName === ENCRYPTED_SECRET_REFERENCE
    ? profile.connectionId : null;
  const expectedConnectionVersion = profile.apiKeyEnvName === ENCRYPTED_SECRET_REFERENCE
    ? profile.connectionVersion : null;
  if (!fields || Object.keys(fields).length !== 8 || !secret
    || fields.accountId !== profile.accountId || fields.profileId !== profile.id
    || fields.configVersion !== profile.configVersion
    || fields.connectionId !== expectedConnectionId
    || fields.connectionVersion !== expectedConnectionVersion
    || !/^[a-f0-9]{64}$/u.test(fields.providerRequestKey)
    || typeof fields.providerCorrelationId !== "string" || !SCOPE_ID.test(fields.providerCorrelationId)) {
    throw gatewayError("AI_GATEWAY_SECRET_MISSING");
  }
  return Object.freeze({ secret,
    providerRequestKey: fields.providerRequestKey,
    providerCorrelationId: fields.providerCorrelationId });
}

function externalCode(error) {
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string"
      ? descriptor.value : "";
  } catch { return ""; }
}

function normalizeProfile(profile, { allowLocalGateway = false } = {}) {
  const rawAccountId = profileField(profile, "accountId", "account_id");
  const rawApiKeyEnvName = profileField(profile, "apiKeyEnvName", "api_key_env_name");
  const rawConnectionId = profileField(profile, "connectionId", "connection_id");
  const rawConnectionVersion = profileField(profile, "connectionVersion", "connection_version");
  const result = {
    id: clean(profileField(profile, "id")),
    accountId: clean(rawAccountId),
    configVersion: Number(profileField(profile, "configVersion", "config_version")),
    baseUrl: clean(profileField(profile, "baseUrl", "base_url"), 2048),
    apiKeyEnvName: clean(rawApiKeyEnvName),
    textProtocol: clean(profileField(profile, "textProtocol", "text_protocol")),
    imageProtocol: clean(profileField(profile, "imageProtocol", "image_protocol")),
    textModel: clean(profileField(profile, "textModel", "text_model")),
    imageModel: clean(profileField(profile, "imageModel", "image_model")),
    enabled: profileField(profile, "enabled") === true,
    connectionId: clean(rawConnectionId),
    connectionVersion: rawConnectionVersion === undefined || rawConnectionVersion === null
      ? null : Number(rawConnectionVersion),
  };
  const encryptedReference = rawApiKeyEnvName === ENCRYPTED_SECRET_REFERENCE;
  const connectionReferencePresent = (rawConnectionId !== undefined && rawConnectionId !== null)
    || (rawConnectionVersion !== undefined && rawConnectionVersion !== null);
  const validConnectionReference = typeof rawAccountId === "string"
    && rawAccountId === result.accountId && SCOPE_ID.test(rawAccountId)
    && typeof rawConnectionId === "string"
    && rawConnectionId === result.connectionId && SCOPE_ID.test(rawConnectionId)
    && Number.isSafeInteger(rawConnectionVersion) && rawConnectionVersion > 0;
  if (!result.id || !result.accountId || !Number.isInteger(result.configVersion) || result.configVersion < 1
    || !result.baseUrl || !result.apiKeyEnvName || !result.textModel || !result.imageModel
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(result.apiKeyEnvName)
    || DANGEROUS_ENV_NAMES.has(result.apiKeyEnvName.toLowerCase())
    || !SUB2API_TEXT_PROTOCOLS.includes(result.textProtocol)
    || !SUB2API_IMAGE_PROTOCOLS.includes(result.imageProtocol)
    || (encryptedReference ? !validConnectionReference : connectionReferencePresent)) {
    throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
  }
  try {
    result.baseUrl = normalizeSub2ApiGatewayBaseUrl(result.baseUrl, { allowLocalGateway });
  } catch {
    throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
  }
  const parsed = new URL(result.baseUrl);
  const pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  parsed.pathname = pathname.replace(/\/+/g, "/");
  result.boundary = Object.freeze({ origin: parsed.origin, path: parsed.pathname });
  result.base = parsed;
  return Object.freeze(result);
}

function normalizeCatalogRequest(input, {
  allowLocalGateway = false, allowedStatuses = new Set(["ACTIVE"]),
} = {}) {
  const source = input?.connection;
  const id = profileField(source, "id");
  const accountId = profileField(source, "accountId", "account_id");
  const version = profileField(source, "version");
  const baseUrl = profileField(source, "baseUrl", "base_url");
  const status = profileField(source, "status");
  if (typeof id !== "string" || id !== id.trim() || !SCOPE_ID.test(id)
    || typeof accountId !== "string" || accountId !== accountId.trim() || !SCOPE_ID.test(accountId)
    || !Number.isSafeInteger(version) || version < 1
    || typeof baseUrl !== "string" || baseUrl !== baseUrl.trim() || !baseUrl
    || !(allowedStatuses instanceof Set) || !allowedStatuses.has(status)) {
    throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
  }
  let normalizedBaseUrl;
  try {
    normalizedBaseUrl = normalizeSub2ApiGatewayBaseUrl(baseUrl, { allowLocalGateway });
  } catch {
    throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
  }
  const base = new URL(normalizedBaseUrl);
  const pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  base.pathname = pathname.replace(/\/+/g, "/");
  const normalizedProfile = Object.freeze({
    id,
    accountId,
    configVersion: version,
    baseUrl: normalizedBaseUrl,
    apiKeyEnvName: ENCRYPTED_SECRET_REFERENCE,
    connectionId: id,
    connectionVersion: version,
    enabled: true,
    boundary: Object.freeze({ origin: base.origin, path: base.pathname }),
    base,
  });
  return {
    normalizedProfile,
    correlationId: validateIdentity(input?.correlationId),
    requestKey: validateIdentity(input?.requestKey),
  };
}

function validateIdentity(value, code = "AI_GATEWAY_REQUEST_INVALID") {
  const result = clean(value);
  if (!result) throw gatewayError(code);
  return result;
}

function validatePrompt(value) {
  if (typeof value !== "string" || !value.trim()
    || value.length > MAX_PROMPT_CHARACTERS
    || Buffer.byteLength(value, "utf8") > MAX_PROMPT_BYTES) {
    throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  }
  return value;
}

function assertStructuredOutputSchemaSubset(schema, seen = new Set()) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || seen.has(schema)) return;
  seen.add(schema);
  if ([...UNSUPPORTED_STRUCTURED_SCHEMA_KEYWORDS].some((keyword) => Object.hasOwn(schema, keyword))) {
    throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  }
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    Object.values(schema.properties).forEach((child) => assertStructuredOutputSchemaSubset(child, seen));
  }
  if (schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)) {
    Object.values(schema.$defs).forEach((child) => assertStructuredOutputSchemaSubset(child, seen));
  }
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    assertStructuredOutputSchemaSubset(schema.items, seen);
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((child) => assertStructuredOutputSchemaSubset(child, seen));
  }
}

function compileJsonSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  }
  try {
    assertStructuredOutputSchemaSubset(schema);
    return schemaCompiler.compile(schema);
  } catch {
    throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  }
}

function endpointUrl(normalizedProfile, relativePath) {
  const segment = clean(relativePath).replace(/^\/+/, "");
  if (!segment || segment.split("/").some((part) => part === ".." || part === ".")) {
    throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
  }
  const target = new URL(normalizedProfile.base.href);
  target.pathname = `${normalizedProfile.boundary.path}${segment}`.replace(/\/+/g, "/");
  if (!insideBoundary(target, normalizedProfile.boundary)) throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
  return target;
}

function insideBoundary(url, boundary) {
  return url.origin === boundary.origin && url.pathname.startsWith(boundary.path);
}

function parseBoundaryUrl(value, boundary) {
  let target;
  try {
    target = new URL(value, `${boundary.origin}${boundary.path}`);
  } catch {
    throw gatewayError("GATEWAY_REDIRECT_BLOCKED");
  }
  if (target.username || target.password || !insideBoundary(target, boundary)) {
    throw gatewayError("GATEWAY_REDIRECT_BLOCKED");
  }
  return target;
}

function safeRequestId(response) {
  for (const name of REQUEST_ID_HEADERS) {
    let value = "";
    try { value = clean(response?.headers?.get?.(name)); } catch { return ""; }
    if (value) return value;
  }
  return "";
}

function safeUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const number = (...keys) => {
    for (const key of keys) {
      if (Number.isFinite(raw[key]) && raw[key] >= 0) return raw[key];
    }
    return null;
  };
  const inputTokens = number("input_tokens", "inputTokens");
  const outputTokens = number("output_tokens", "outputTokens");
  const totalTokens = number("total_tokens", "totalTokens");
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return {
    ...(inputTokens !== null ? { inputTokens } : {}),
    ...(outputTokens !== null ? { outputTokens } : {}),
    ...(totalTokens !== null ? { totalTokens } : {}),
  };
}

function safeTerminalToken(value) {
  const token = typeof value === "string" ? value.trim().toLowerCase() : "";
  return token && token.length <= 80 && /^[a-z0-9_.-]+$/.test(token) ? token : "";
}

function safeTerminalStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function terminalFailure(event, retryAfterMs = null) {
  const response = event?.response && typeof event.response === "object" ? event.response : null;
  const nestedError = response?.error && typeof response.error === "object"
    ? response.error
    : (event?.error && typeof event.error === "object" ? event.error : null);
  const tokens = [
    nestedError?.type,
    nestedError?.code,
    response?.error?.type,
    response?.error?.code,
    event?.error?.type,
    event?.error?.code,
    event?.code,
    response?.incomplete_details?.reason,
  ].map(safeTerminalToken).filter(Boolean);
  const status = [
    nestedError?.status,
    nestedError?.status_code,
    nestedError?.http_status,
    response?.error?.status,
    response?.error?.status_code,
    response?.status_code,
    event?.error?.status,
    event?.error?.status_code,
    event?.status,
    event?.status_code,
  ].map(safeTerminalStatus).find((value) => value !== null) ?? null;

  if (status === 401 || status === 403 || tokens.some((token) => AUTH_TERMINAL_TOKENS.has(token))) {
    return withDeliveryState(gatewayError("NON_RETRYABLE_AUTH", { status }), "NOT_SENT");
  }
  if (status === 429) {
    return withDeliveryState(gatewayError("AI_GATEWAY_RATE_LIMITED", {
      retryable: true, status,
    }), "NOT_SENT", retryAfterMs);
  }
  if (status === 404 || tokens.some((token) => MODEL_NOT_FOUND_TERMINAL_TOKENS.has(token))) {
    return withDeliveryState(gatewayError("NON_RETRYABLE_GATEWAY", { status: 404 }), "NOT_SENT");
  }
  if (status === 408 || (status !== null && status >= 500)
    || tokens.some((token) => RETRYABLE_TERMINAL_TOKENS.has(token))) {
    return withDeliveryState(gatewayError("RETRYABLE_GATEWAY", {
      retryable: true, status,
    }), "POSSIBLY_SENT");
  }
  if (event?.type === "response.incomplete") {
    return withDeliveryState(gatewayError("RETRYABLE_GATEWAY", {
      retryable: true, status,
    }), "POSSIBLY_SENT");
  }
  // Unknown explicit failures are non-retryable to avoid repeating a possibly
  // cost-bearing operation without evidence that a retry is safe.
  return withDeliveryState(gatewayError("NON_RETRYABLE_GATEWAY", { status }),
    status === 404 ? "NOT_SENT" : "POSSIBLY_SENT");
}

function verifiedReportedModel(expectedModel, candidates) {
  const reportedModels = [...new Set(candidates.map((value) => clean(value)).filter(Boolean))];
  if (reportedModels.some((model) => !isCompatibleAiModelIdentity(expectedModel, model))) {
    throw gatewayError("AI_GATEWAY_MODEL_MISMATCH");
  }
  return {
    reportedModel: reportedModels[0] || "",
    evidencePresent: reportedModels.length > 0,
  };
}

function safeLog(logger, level, event, fields) {
  const method = logger?.[level];
  if (typeof method !== "function") return;
  const safe = {
    profileId: clean(fields.profileId),
    profileVersion: Number(fields.profileVersion) || null,
    protocol: clean(fields.protocol),
    operation: clean(fields.operation),
    correlationId: clean(fields.correlationId),
    requestId: clean(fields.requestId),
    status: Number.isInteger(fields.status) ? fields.status : null,
    errorCode: clean(fields.errorCode),
  };
  try {
    const pending = method.call(logger, event, safe);
    if (pending && typeof pending.then === "function") {
      Promise.resolve(pending).catch(() => {});
    }
  } catch {
    // Observability is best-effort and must never change a business outcome.
  }
}

function createAbortContext({ callerSignal, timeoutMs, idleTimeoutMs, timers }) {
  const hasDeadline = timeoutMs !== undefined;
  const hasIdleDeadline = idleTimeoutMs !== undefined;
  if ((hasDeadline && hasIdleDeadline)
    || (hasDeadline && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CALL_TIMEOUT_MS))
    || (hasIdleDeadline && (!Number.isInteger(idleTimeoutMs)
      || idleTimeoutMs < 1 || idleTimeoutMs > MAX_CALL_TIMEOUT_MS))) {
    throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  }
  const clock = timers || { setTimeout, clearTimeout };
  const controller = new AbortController();
  let timedOut = false;
  let idleTimedOut = false;
  let callerCancelled = Boolean(callerSignal?.aborted);
  let timer = null;
  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const scheduleIdle = () => {
    if (!hasIdleDeadline || controller.signal.aborted) return;
    clearTimer();
    timer = clock.setTimeout(() => {
      timer = null;
      idleTimedOut = true;
      controller.abort(new DOMException("idle timeout", "TimeoutError"));
    }, idleTimeoutMs);
    timer?.unref?.();
  };
  const onCallerAbort = () => {
    callerCancelled = true;
    controller.abort(new DOMException("cancelled", "AbortError"));
  };
  if (callerSignal?.addEventListener) callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  if (callerCancelled) onCallerAbort();
  timer = hasDeadline ? clock.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("timeout", "TimeoutError"));
  }, timeoutMs) : null;
  timer?.unref?.();
  scheduleIdle();
  return {
    signal: controller.signal,
    state: () => ({ timedOut, idleTimedOut, callerCancelled }),
    progress: scheduleIdle,
    cleanup() {
      clearTimer();
      callerSignal?.removeEventListener?.("abort", onCallerAbort);
    },
  };
}

function classifyFetchFailure(error, abortState, { fetchStarted = false } = {}) {
  const deliveryState = fetchStarted ? "POSSIBLY_SENT" : "NOT_SENT";
  if (abortState.callerCancelled) {
    return withDeliveryState(gatewayError("GATEWAY_CANCELLED", { retryable: false }), deliveryState);
  }
  if (abortState.idleTimedOut) {
    return withDeliveryState(gatewayError("AI_GATEWAY_IDLE_TIMEOUT", { retryable: true }), deliveryState);
  }
  if (abortState.timedOut) {
    return withDeliveryState(gatewayError("GATEWAY_TIMEOUT", { retryable: true }), deliveryState);
  }
  if (error instanceof AiGatewayError) return withDeliveryState(error, deliveryState);
  if (fetchStarted && error instanceof TypeError) {
    return withDeliveryState(gatewayError("AI_GATEWAY_NETWORK_FAILED", { retryable: true }), deliveryState);
  }
  return withDeliveryState(gatewayError("RETRYABLE_GATEWAY", { retryable: true }), deliveryState);
}

function classifyHttp(response) {
  const requestId = safeRequestId(response);
  if (response.status === 401 || response.status === 403) {
    return withDeliveryState(gatewayError("NON_RETRYABLE_AUTH", {
      status: response.status, requestId,
    }), "NOT_SENT");
  }
  if (response.status === 429) {
    return withDeliveryState(gatewayError("AI_GATEWAY_RATE_LIMITED", {
      retryable: true, status: response.status, requestId,
    }), "NOT_SENT", safeRetryAfter(response));
  }
  if (RETRYABLE_HTTP.has(response.status)) {
    return withDeliveryState(gatewayError("RETRYABLE_GATEWAY", {
      retryable: true, status: response.status, requestId,
    }), "POSSIBLY_SENT");
  }
  return withDeliveryState(gatewayError("NON_RETRYABLE_GATEWAY", {
    status: response.status, requestId,
  }), response.status === 404 ? "NOT_SENT" : "POSSIBLY_SENT");
}

function pinnedLookup(url, addresses) {
  const expectedHostname = String(url.hostname).toLowerCase().replace(/^\[|\]$/gu, "");
  const verified = Array.isArray(addresses) ? addresses.map((entry) => ({
    address: entry?.address,
    family: entry?.family,
  })) : [];
  if (!verified.length || verified.some((entry) => typeof entry.address !== "string"
    || ![4, 6].includes(entry.family))) throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
  return (hostname, options, callback) => {
    try {
      const requestedHostname = String(hostname).toLowerCase().replace(/^\[|\]$/gu, "");
      if (requestedHostname !== expectedHostname || typeof callback !== "function") {
        throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
      }
      const requestedFamily = typeof options === "number" ? options : Number(options?.family || 0);
      const candidates = requestedFamily === 4 || requestedFamily === 6
        ? verified.filter((entry) => entry.family === requestedFamily)
        : verified;
      if (!candidates.length) throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
      if (options && typeof options === "object" && options.all === true) {
        callback(null, candidates.map((entry) => ({ ...entry })));
        return;
      }
      callback(null, candidates[0].address, candidates[0].family);
    } catch (error) {
      callback?.(error instanceof AiGatewayError ? error : gatewayError("AI_GATEWAY_PROFILE_INVALID"));
    }
  };
}

function responseHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders || {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) headers.append(name, String(item));
    }
  }
  return headers;
}

function requestPinnedGateway(urlValue, { method = "GET", headers, body, signal, lookup } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = urlValue instanceof URL ? urlValue : new URL(urlValue);
    } catch {
      reject(gatewayError("AI_GATEWAY_PROFILE_INVALID"));
      return;
    }
    const transport = url.protocol === "https:" ? https : (url.protocol === "http:" ? http : null);
    if (!transport || typeof lookup !== "function") {
      reject(gatewayError("AI_GATEWAY_PROFILE_INVALID"));
      return;
    }
    let request;
    try {
      request = transport.request(url, { method, headers, signal, lookup, agent: false }, (incoming) => {
        try {
          const status = Number(incoming.statusCode);
          const noBody = method === "HEAD" || [101, 204, 205, 304].includes(status);
          const stream = noBody ? null : Readable.toWeb(incoming);
          resolve(new Response(stream, {
            status,
            statusText: incoming.statusMessage || "",
            headers: responseHeaders(incoming.headers),
          }));
        } catch (error) {
          try { incoming.destroy(); } catch {}
          reject(error);
        }
      });
    } catch (error) {
      reject(error);
      return;
    }
    request.once("error", reject);
    try { request.end(body); } catch (error) { reject(error); }
  });
}

function fireAndForget(operation) {
  try {
    const pending = operation?.();
    if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
  } catch {
    // Cleanup is bounded and best-effort; it never changes the safe outcome.
  }
}

function abandonResponse(response, { reader = null, iterator = null } = {}) {
  const body = (() => { try { return response?.body; } catch { return null; } })();
  if (reader) fireAndForget(() => reader.cancel?.());
  if (iterator) fireAndForget(() => iterator.return?.());
  if (!reader) fireAndForget(() => body?.cancel?.());
  if (!iterator) {
    fireAndForget(() => {
      const createIterator = body?.[Symbol.asyncIterator];
      if (typeof createIterator !== "function") return undefined;
      return createIterator.call(body)?.return?.();
    });
  }
  fireAndForget(() => body?.destroy?.());
  fireAndForget(() => response?.destroy?.());
  try { reader?.releaseLock?.(); } catch {}
}

async function abortableResult(promise, signal, abandonLateValue = null) {
  if (signal?.aborted) throw signal.reason || new DOMException("aborted", "AbortError");
  const pending = Promise.resolve(promise);
  let removeAbort = () => {};
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      if (!signal?.addEventListener) return;
      const onAbort = () => reject(signal.reason || new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener?.("abort", onAbort);
    })]);
  } catch (error) {
    if (signal?.aborted && typeof abandonLateValue === "function") {
      pending.then((value) => abandonLateValue(value), () => {});
    }
    throw error;
  } finally {
    removeAbort();
  }
}

async function fetchWithBoundary({
  fetchImpl, url, init, boundary, authorized, signal, verifyTarget, beforeSend, onFetchStart,
  rejectRedirects = false,
}) {
  let target = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response;
    try {
      const verification = await verifyTarget?.(target);
      const lookup = pinnedLookup(target, verification?.addresses);
      if (signal?.aborted) throw signal.reason || new DOMException("aborted", "AbortError");
      await beforeSend?.();
      if (signal?.aborted) throw signal.reason || new DOMException("aborted", "AbortError");
      onFetchStart?.();
      const pending = Promise.resolve().then(() => fetchImpl(target, {
        ...init, redirect: "manual", signal, lookup,
      }));
      response = await abortableResult(pending, signal, abandonResponse);
    } catch (error) {
      throw error;
    }
    let status;
    try { status = Number(response?.status); } catch {
      abandonResponse(response);
      throw gatewayError("INVALID_GATEWAY_RESPONSE");
    }
    if (![301, 302, 303, 307, 308].includes(status)) return response;
    if (rejectRedirects || redirects === MAX_REDIRECTS) {
      abandonResponse(response);
      throw gatewayError("GATEWAY_REDIRECT_BLOCKED");
    }
    let location;
    try { location = response?.headers?.get?.("location"); } catch {
      abandonResponse(response);
      throw gatewayError("GATEWAY_REDIRECT_BLOCKED");
    }
    if (!location) {
      abandonResponse(response);
      throw gatewayError("GATEWAY_REDIRECT_BLOCKED");
    }
    abandonResponse(response);
    target = parseBoundaryUrl(location, boundary);
    if (!authorized && init.headers?.Authorization) throw gatewayError("GATEWAY_REDIRECT_BLOCKED");
  }
  throw gatewayError("GATEWAY_REDIRECT_BLOCKED");
}

function baseHeaders(secret, correlationId, requestKey, accept = "application/json") {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
    Accept: accept,
    "Idempotency-Key": requestKey,
    "X-Correlation-Id": correlationId,
    "X-Request-Id": correlationId,
  };
}

function strictBase64(value, maxBytes = MAX_IMAGE_BYTES) {
  const text = typeof value === "string" ? value.trim() : "";
  const maximumEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (!text || text.length > maximumEncodedLength || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 === 1) {
    throw gatewayError("INVALID_GATEWAY_RESPONSE");
  }
  const bytes = Buffer.from(text, "base64");
  if (!bytes.length || bytes.length > maxBytes) throw gatewayError("INVALID_GATEWAY_RESPONSE");
  return bytes;
}

function imageMetadata(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0) return { contentType: "image/png", width, height, format: "png" };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        const height = bytes.readUInt16BE(offset + 5);
        const width = bytes.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) return { contentType: "image/jpeg", width, height, format: "jpeg" };
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const kind = bytes.toString("ascii", 12, 16);
    const riffEnd = 8 + bytes.readUInt32LE(4);
    const chunkSize = bytes.readUInt32LE(16);
    const chunkEnd = 20 + chunkSize + (chunkSize & 1);
    const chunkIsContained = riffEnd <= bytes.length && chunkEnd <= riffEnd;
    if (kind === "VP8X" && chunkIsContained && chunkSize >= 10) {
      const width = 1 + bytes.readUIntLE(24, 3);
      const height = 1 + bytes.readUIntLE(27, 3);
      if (width > 0 && height > 0) return { contentType: "image/webp", width, height, format: "webp" };
    }
    const vp8FrameTag = bytes.readUIntLE(20, 3);
    const vp8PartitionLength = vp8FrameTag >>> 5;
    if (kind === "VP8 "
      && chunkIsContained
      && chunkSize >= 10
      && (vp8FrameTag & 0x01) === 0
      && ((vp8FrameTag >>> 1) & 0x07) <= 3
      && ((vp8FrameTag >>> 4) & 0x01) === 1
      && vp8PartitionLength <= chunkSize - 10
      && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      const width = bytes.readUInt16LE(26) & 0x3fff;
      const height = bytes.readUInt16LE(28) & 0x3fff;
      if (width > 0 && height > 0) return { contentType: "image/webp", width, height, format: "webp" };
    }
    if (kind === "VP8L"
      && chunkIsContained
      && chunkSize >= 5
      && bytes[20] === 0x2f
      && (bytes[24] >>> 5) === 0) {
      const dimensions = bytes.readUInt32LE(21);
      const width = 1 + (dimensions & 0x3fff);
      const height = 1 + ((dimensions >>> 14) & 0x3fff);
      if (width > 0 && height > 0) return { contentType: "image/webp", width, height, format: "webp" };
    }
  }
  throw gatewayError("INVALID_GATEWAY_RESPONSE");
}

function normalizedImage(bytes, extra = {}) {
  const metadata = imageMetadata(bytes);
  const requestedImageModel = clean(extra.requestedImageModel || extra.model);
  const gatewayReportedImageModel = clean(extra.gatewayReportedImageModel);
  const gatewayReportedImageModelPresent = extra.gatewayReportedImageModelPresent === true;
  const orchestratorModel = clean(extra.orchestratorModel);
  return {
    bytes: new Uint8Array(bytes),
    contentType: metadata.contentType,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    model: requestedImageModel,
    orchestratorModel,
    modelEvidence: {
      requestedImageModel,
      gatewayReportedImageModel,
      gatewayReportedImageModelPresent,
      orchestratorModel,
    },
    requestId: clean(extra.requestId),
    usage: safeUsage(extra.usage),
    diagnostics: {
      protocol: clean(extra.protocol),
      httpStatus: 200,
      responseKind: "IMAGE_BYTES",
    },
  };
}

function binaryByteLength(value) {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return -1;
}

function binaryView(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
}

async function sourceImageContent(
  sourceImages = [],
  maxImageBytes = MAX_IMAGE_BYTES,
  maxSourceImageBytesTotal = MAX_SOURCE_IMAGE_BYTES_TOTAL,
) {
  if (!Array.isArray(sourceImages)) throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  if (sourceImages.length > MAX_SOURCE_IMAGES) throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  const prepared = [];
  let totalBytes = 0;
  for (const source of sourceImages) {
    if (source?.url) throw gatewayError("AI_GATEWAY_INPUT_UNSUPPORTED");
    const length = binaryByteLength(source?.bytes);
    if (length < 1 || length > maxImageBytes || totalBytes > maxSourceImageBytesTotal - length) {
      throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
    }
    totalBytes += length;
    prepared.push(source.bytes);
  }
  const content = [];
  for (let offset = 0; offset < prepared.length; offset += 4) {
    const batch = await Promise.all(prepared.slice(offset, offset + 4).map(async (sourceBytes) => {
      try {
        const bytes = binaryView(sourceBytes);
        const metadata = imageMetadata(bytes);
        await sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 }).stats();
        return { type: "input_image", image_url: `data:${metadata.contentType};base64,${bytes.toString("base64")}` };
      } catch {
        throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
      }
    }));
    content.push(...batch);
  }
  return content;
}

async function responsesInput(
  prompt,
  sourceImages = [],
  maxImageBytes = MAX_IMAGE_BYTES,
  maxSourceImageBytesTotal = MAX_SOURCE_IMAGE_BYTES_TOTAL,
) {
  return [{
    role: "user",
    content: [
      { type: "input_text", text: validatePrompt(prompt) },
      ...await sourceImageContent(sourceImages, maxImageBytes, maxSourceImageBytesTotal),
    ],
  }];
}

function extractOutputText(body) {
  if (typeof body?.output_text === "string" && body.output_text.trim()) return body.output_text;
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim()) return part.text;
    }
  }
  throw gatewayError("INVALID_GATEWAY_RESPONSE");
}

function parseStructuredResponse(body, validate) {
  let text;
  try {
    text = extractOutputText(body);
  } catch {
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { failureField: "$" });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { failureField: "$" });
  }
  if (validate(value)) return value;
  const first = Array.isArray(validate.errors) ? validate.errors[0] : null;
  const base = typeof first?.instancePath === "string" && first.instancePath ? first.instancePath : "";
  const missing = first?.keyword === "required" && typeof first?.params?.missingProperty === "string"
    ? first.params.missingProperty : "";
  const failureField = `${base}${missing ? `/${missing}` : ""}` || "$";
  throw gatewayError("INVALID_GATEWAY_RESPONSE", { failureField });
}

function parseSseFrame(block) {
  const lines = block.split(/\r?\n/);
  const eventLines = lines.filter((line) => line.startsWith("event:"));
  if (eventLines.length > 1) throw gatewayError("INVALID_GATEWAY_RESPONSE");
  const eventName = eventLines.length ? eventLines[0].slice(6).trim() : "";
  if (eventLines.length && !eventName) throw gatewayError("INVALID_GATEWAY_RESPONSE");
  if (eventName && (eventName.length > 120 || !/^[A-Za-z0-9_.-]+$/.test(eventName))) {
    throw gatewayError("INVALID_GATEWAY_RESPONSE");
  }
  const data = lines.filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart()).join("\n");
  if (!data) return null;
  if (data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("event object required");
    const hasDataType = Object.hasOwn(parsed, "type");
    if (hasDataType && (typeof parsed.type !== "string" || !parsed.type
      || parsed.type.length > 120 || !/^[A-Za-z0-9_.-]+$/.test(parsed.type))) {
      throw new Error("invalid data event type");
    }
    if (eventName && hasDataType && parsed.type !== eventName) throw new Error("conflicting event types");
    if (eventName && !hasDataType) parsed.type = eventName;
    if (!eventName && !hasDataType) throw new Error("missing event type");
    return parsed;
  } catch { throw gatewayError("INVALID_GATEWAY_RESPONSE"); }
}

function sseFrameJsonIsIncomplete(block) {
  const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return false;
  try { JSON.parse(data); return false; } catch { return true; }
}

function finalImageFromEvents(events, maxImageBytes, retryAfterMs = null) {
  let finalEncoded = "";
  let partialEncoded = "";
  let lastPartialIndex = -1;
  let usage = null;
  let responseId = "";
  let orchestratorModel = "";
  let completed = false;
  for (const event of events) {
    if (FAILURE_EVENTS.has(event?.type)) throw terminalFailure(event, retryAfterMs);
    if (event?.type === "response.image_generation_call.partial_image") {
      const index = event.partial_image_index;
      const value = typeof event.partial_image_b64 === "string" ? event.partial_image_b64.trim() : "";
      if (!Number.isSafeInteger(index) || index < 0 || index <= lastPartialIndex || !value) {
        throw gatewayError("INVALID_GATEWAY_RESPONSE");
      }
      lastPartialIndex = index;
      partialEncoded = value;
    }
    if (event?.type === "response.output_item.done" && event?.item?.type === "image_generation_call") {
      finalEncoded = typeof event.item.result === "string" ? event.item.result.trim() : "";
    }
    if (event?.type === "response.completed") {
      const response = event.response || {};
      if (response.status && response.status !== "completed") throw gatewayError("NON_RETRYABLE_GATEWAY");
      completed = true;
      responseId = clean(response.id);
      orchestratorModel = clean(response.model);
      usage = response.usage || usage;
      for (const item of Array.isArray(response.output) ? response.output : []) {
        if (item?.type === "image_generation_call" && typeof item.result === "string" && item.result.trim()) {
          finalEncoded = item.result.trim();
        }
      }
    }
  }
  const encoded = finalEncoded || partialEncoded;
  if (!completed || !encoded) throw gatewayError("INVALID_GATEWAY_RESPONSE");
  return { bytes: strictBase64(encoded, maxImageBytes), usage, responseId, orchestratorModel };
}

function positiveByteLimit(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError("body byte limits must be positive bounded integers");
  }
  return resolved;
}

async function readerRead(reader, signal) {
  if (signal.aborted) throw signal.reason || new DOMException("aborted", "AbortError");
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBodyLimited(response, { maxBytes, abort }) {
  let body;
  let declared;
  try {
    body = response?.body;
    declared = Number(response?.headers?.get?.("content-length") || 0);
  } catch {
    abandonResponse(response);
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
  if (Number.isFinite(declared) && declared > maxBytes) {
    abandonResponse(response);
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
  let reader = null;
  let iterator = null;
  try {
    if (typeof body?.getReader === "function") reader = body.getReader();
    else if (typeof body?.[Symbol.asyncIterator] === "function") iterator = body[Symbol.asyncIterator]();
  } catch {
    abandonResponse(response);
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
  if ((!reader || typeof reader.read !== "function") && (!iterator || typeof iterator.next !== "function")) {
    abandonResponse(response, { reader, iterator });
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
  const chunks = [];
  let total = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = reader
        ? await readerRead(reader, abort.signal)
        : await abortableResult(Promise.resolve().then(() => iterator.next()), abort.signal);
      if (done) { finished = true; break; }
      let chunk;
      try { chunk = Buffer.from(value); } catch {
        throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
      }
      total += chunk.length;
      if (total > maxBytes) throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (!finished) abandonResponse(response, { reader, iterator });
    else {
      try { reader?.releaseLock?.(); } catch {}
    }
  }
}

async function readSseEvents(response, { maxBytes, abort, retryAfterMs }) {
  let body;
  let declared;
  try {
    body = response?.body;
    declared = Number(response?.headers?.get?.("content-length") || 0);
  } catch {
    abandonResponse(response);
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
  if (Number.isFinite(declared) && declared > maxBytes) {
    abandonResponse(response);
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
  let reader = null;
  let iterator = null;
  try {
    if (typeof body?.getReader === "function") reader = body.getReader();
    else if (typeof body?.[Symbol.asyncIterator] === "function") iterator = body[Symbol.asyncIterator]();
  } catch {
    abandonResponse(response);
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
  if ((!reader || typeof reader.read !== "function") && (!iterator || typeof iterator.next !== "function")) {
    abandonResponse(response, { reader, iterator });
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  let total = 0;
  let finished = false;
  try {
    while (true) {
      let result;
      try {
        result = reader
          ? await readerRead(reader, abort.signal)
          : await abortableResult(Promise.resolve().then(() => iterator.next()), abort.signal);
      } catch (error) {
        if (abort.signal.aborted) throw error;
        throw gatewayError("AI_GATEWAY_UNEXPECTED_EOF", {
          retryable: true, requestId: safeRequestId(response),
        });
      }
      const { done, value } = result;
      if (done) {
        finished = true;
        buffer += decoder.decode();
        break;
      }
      let chunk;
      try { chunk = Buffer.from(value); } catch {
        throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
      }
      total += chunk.length;
      if (total > maxBytes) throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
      buffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const boundary = /\r?\n\r?\n/u.exec(buffer);
        if (!boundary) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseSseFrame(block);
        if (event) {
          events.push(event);
          abort.progress();
          if (FAILURE_EVENTS.has(event.type)) throw terminalFailure(event, retryAfterMs);
          if (event.type === "response.completed") return events;
        }
      }
    }
    if (/^(?:\s|:[^\r\n]*(?:\r?\n|$))*$/u.test(buffer)) return events;
    if (/^(?:|[\s\S]*\r?\n)?(?:data|event):/u.test(buffer)) {
      try {
        const event = parseSseFrame(buffer);
        if (event) {
          events.push(event);
          abort.progress();
        }
        return events;
      } catch (error) {
        if (!sseFrameJsonIsIncomplete(buffer)) throw error;
        throw gatewayError("AI_GATEWAY_UNEXPECTED_EOF", {
          retryable: true, requestId: safeRequestId(response),
        });
      }
    }
    return events;
  } finally {
    if (!finished) abandonResponse(response, { reader, iterator });
    else {
      try { reader?.releaseLock?.(); } catch {}
    }
  }
}

async function readJson(response, abort, maxBytes) {
  let bytes;
  try {
    bytes = await readBodyLimited(response, { maxBytes, abort });
  } catch (error) {
    abandonResponse(response);
    if (error instanceof AiGatewayError) throw error;
    if (abort.signal.aborted) {
      throw classifyFetchFailure(error, abort.state(), { fetchStarted: true });
    }
    throw gatewayError("AI_GATEWAY_UNEXPECTED_EOF", {
      retryable: true, requestId: safeRequestId(response),
    });
  }
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    abort.progress();
    return parsed;
  } catch {
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
}

async function readImageUrl(fetchImpl, urlValue, normalizedProfile, abort, maxImageBytes, verifyTarget) {
  const url = parseBoundaryUrl(urlValue, normalizedProfile.boundary);
  const response = await fetchWithBoundary({
    fetchImpl,
    url,
    init: { method: "GET", headers: { Accept: "image/png,image/jpeg,image/webp" } },
    boundary: normalizedProfile.boundary,
    authorized: false,
    signal: abort.signal,
    verifyTarget,
  });
  let responseOk;
  try { responseOk = response?.ok === true; } catch {
    abandonResponse(response);
    throw gatewayError("INVALID_GATEWAY_RESPONSE");
  }
  if (!responseOk) {
    const failure = classifyHttp(response);
    abandonResponse(response);
    throw failure;
  }
  const bytes = await readBodyLimited(response, { maxBytes: maxImageBytes, abort });
  if (!bytes.length || bytes.length > maxImageBytes) throw gatewayError("INVALID_GATEWAY_RESPONSE");
  return bytes;
}

function normalizeRequest(input, operation, { allowDisabled = false, allowLocalGateway = false } = {}) {
  const normalizedProfile = normalizeProfile(input?.profile, { allowLocalGateway });
  if (!allowDisabled && !normalizedProfile.enabled) throw gatewayError("AI_GATEWAY_PROFILE_DISABLED");
  const correlationId = validateIdentity(input?.correlationId);
  const requestKey = validateIdentity(input?.requestKey);
  const model = validateIdentity(input?.model);
  const expectedModel = operation === "text" ? normalizedProfile.textModel : normalizedProfile.imageModel;
  if (model !== expectedModel) throw gatewayError("AI_GATEWAY_MODEL_MISMATCH");
  return { normalizedProfile, correlationId, requestKey, model };
}

function safeJsonTree(value) {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (current === null || ["string", "boolean", "number"].includes(typeof current)) continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!current || typeof current !== "object"
      || ![Object.prototype, null].includes(Object.getPrototypeOf(current))) return false;
    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      return false;
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (DANGEROUS_JSON_KEYS.has(key) || typeof descriptor.get === "function" || typeof descriptor.set === "function") {
        return false;
      }
      stack.push(descriptor.value);
    }
  }
  return true;
}

function safeCatalogRequestId(response) {
  const requestId = safeRequestId(response);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(requestId) ? requestId : "";
}

function currentSub2ApiCatalogModel(model) {
  return model.object === undefined
    && model.type === "model"
    && typeof model.display_name === "string"
    && model.display_name === model.display_name.trim()
    && SUB2API_MODEL_DISPLAY_NAME.test(model.display_name)
    && typeof model.created_at === "string"
    && SUB2API_MODEL_CREATED_AT.test(model.created_at)
    && Number.isFinite(Date.parse(model.created_at));
}

function normalizeModelCatalog(payload, response) {
  try {
    if (!safeJsonTree(payload) || !payload || Array.isArray(payload)
      || payload.object !== "list" || !Array.isArray(payload.data)
      || payload.data.length > MAX_MODELS) {
      throw gatewayError("INVALID_GATEWAY_RESPONSE");
    }
    const seen = new Set();
    const models = payload.data.map((model) => {
      if (!model || Array.isArray(model) || typeof model !== "object"
        || (model.object !== "model" && !currentSub2ApiCatalogModel(model))) {
        throw gatewayError("INVALID_GATEWAY_RESPONSE");
      }
      const id = typeof model.id === "string" ? model.id : "";
      const ownedBy = model.owned_by === undefined ? "" : model.owned_by;
      if (!MODEL_ID.test(id) || id.split("/").some((part) => !part || part === "." || part === "..")
        || (ownedBy !== "" && (typeof ownedBy !== "string" || !OWNED_BY.test(ownedBy)))
        || seen.has(id)) {
        throw gatewayError("INVALID_GATEWAY_RESPONSE");
      }
      seen.add(id);
      return { id, ownedBy, metadata: {} };
    });
    models.sort((left, right) => left.id < right.id ? -1 : (left.id > right.id ? 1 : 0));
    return { requestId: safeCatalogRequestId(response), models };
  } catch (error) {
    if (error instanceof AiGatewayError) throw error;
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeCatalogRequestId(response) });
  }
}

export function createSub2ApiAdapter({
  fetchImpl = requestPinnedGateway,
  readSecret = (name) => process.env[name],
  resolveSecret,
  resolveCatalogSyncCredential,
  prepareCapabilitySubcall,
  resolveCapabilityCredential,
  markCapabilitySubcallSending,
  completeCapabilitySubcall,
  logger = null,
  allowLocalGateway = false,
  resolveHostname,
  maxImageBytes = MAX_IMAGE_BYTES,
  maxJsonBytes = MAX_JSON_BYTES,
  maxSseBytes,
  maxSourceImageBytesTotal = MAX_SOURCE_IMAGE_BYTES_TOTAL,
  maxRequestBodyBytes = MAX_REQUEST_BODY_BYTES,
  allowedSecretEnvNames,
  allowedGatewayBaseUrls,
  allowedGatewayOrigins,
  timers,
} = {}) {
  if (typeof fetchImpl !== "function" || typeof readSecret !== "function"
    || (resolveSecret !== undefined && typeof resolveSecret !== "function")
    || (resolveCatalogSyncCredential !== undefined && typeof resolveCatalogSyncCredential !== "function")
    || (prepareCapabilitySubcall !== undefined && typeof prepareCapabilitySubcall !== "function")
    || (resolveCapabilityCredential !== undefined && typeof resolveCapabilityCredential !== "function")
    || (markCapabilitySubcallSending !== undefined && typeof markCapabilitySubcallSending !== "function")
    || (completeCapabilitySubcall !== undefined && typeof completeCapabilitySubcall !== "function")
    || typeof allowLocalGateway !== "boolean"
    || (timers !== undefined && (typeof timers?.setTimeout !== "function"
      || typeof timers?.clearTimeout !== "function"))
    || (resolveHostname !== undefined && typeof resolveHostname !== "function")) {
    throw new TypeError("sub2api adapter requires fetch and secret reader");
  }
  maxImageBytes = positiveByteLimit(maxImageBytes, MAX_IMAGE_BYTES);
  maxJsonBytes = positiveByteLimit(maxJsonBytes, MAX_JSON_BYTES, MAX_JSON_BYTES);
  maxSseBytes = positiveByteLimit(maxSseBytes, Math.ceil(maxImageBytes * 4 / 3) + MAX_JSON_BYTES);
  maxSourceImageBytesTotal = positiveByteLimit(maxSourceImageBytesTotal, MAX_SOURCE_IMAGE_BYTES_TOTAL);
  maxRequestBodyBytes = positiveByteLimit(maxRequestBodyBytes, MAX_REQUEST_BODY_BYTES);
  const enforcePolicy = allowedSecretEnvNames !== undefined
    || allowedGatewayBaseUrls !== undefined || allowedGatewayOrigins !== undefined;
  const gatewayPolicy = enforcePolicy ? createSub2ApiGatewayPolicy({
    allowedSecretEnvNames: allowedSecretEnvNames ?? [],
    allowedGatewayBaseUrls: allowedGatewayBaseUrls ?? [],
    allowedGatewayOrigins: allowedGatewayOrigins ?? [],
    allowLocalGateway,
  }) : null;
  const encryptedGatewayPolicy = createSub2ApiGatewayPolicy({
    allowedSecretEnvNames: [ENCRYPTED_SECRET_REFERENCE],
    allowedGatewayBaseUrls: allowedGatewayBaseUrls ?? [],
    allowedGatewayOrigins: allowedGatewayOrigins ?? [],
    allowLocalGateway,
  });

  async function verifyGatewayBoundary(normalizedProfile, abort) {
    try {
      const policy = normalizedProfile.apiKeyEnvName === ENCRYPTED_SECRET_REFERENCE
        ? encryptedGatewayPolicy : gatewayPolicy;
      if (policy) requireSub2ApiGatewayPolicy(normalizedProfile, policy);
      return await verifySub2ApiGatewayDnsBoundary({
        hostname: normalizedProfile.base.hostname,
        allowLocalGateway,
        signal: abort.signal,
        ...(resolveHostname === undefined ? {} : { resolveHostname }),
      });
    } catch (error) {
      if (abort.signal.aborted) throw error;
      if (error?.code === "SUB2API_GATEWAY_DNS_FAILED") {
        throw gatewayError("RETRYABLE_GATEWAY", { retryable: true });
      }
      throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
    }
  }

  async function executeAuthorized({
    input,
    operation,
    protocol,
    endpoint,
    body,
    accept = "application/json",
    allowDisabled = false,
    normalizeInput,
    rejectRedirects = false,
  }) {
    let capabilityExecution = null;
    let expectedProviderIdentity = null;
    if (input.capabilityExecution !== undefined) {
      capabilityExecution = capabilityExecutionForProbe(input.capabilityExecution, input.capabilityProbe);
      expectedProviderIdentity = capabilityProviderIdentity(capabilityExecution);
    }
    const identityInput = expectedProviderIdentity ? {
      ...input,
      correlationId: expectedProviderIdentity.providerCorrelationId,
      requestKey: expectedProviderIdentity.providerRequestKey,
    } : input;
    const { normalizedProfile, correlationId, requestKey } = normalizeInput
      ? normalizeInput(identityInput, { allowLocalGateway })
      : normalizeRequest(identityInput, operation, { allowDisabled, allowLocalGateway });
    let serializedBody;
    if (body !== undefined) {
      try {
        serializedBody = JSON.stringify(body);
      } catch {
        throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
      }
      if (Buffer.byteLength(serializedBody, "utf8") > maxRequestBodyBytes) {
        throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
      }
    }
    const abort = createAbortContext({
      callerSignal: input.signal,
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
      timers,
    });
    const url = endpointUrl(normalizedProfile, endpoint);
    let fetchStarted = false;
    let capabilityPrepared = false;
    let capabilitySending = false;
    let capabilitySettled = false;
    try {
      let capabilityCredential = null;
      if (capabilityExecution !== null) {
        if (!allowDisabled || typeof prepareCapabilitySubcall !== "function"
          || typeof resolveCapabilityCredential !== "function"
          || typeof markCapabilitySubcallSending !== "function"
          || typeof completeCapabilitySubcall !== "function") {
          throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
        }
        try {
          const prepared = await abortableResult(Promise.resolve()
            .then(() => prepareCapabilitySubcall(capabilityExecution)), abort.signal, () => {
              fireAndForget(() => completeCapabilitySubcall(
                capabilityExecution, "FAILED", "PRE_SEND_ABORTED",
              ));
            });
          capabilityPrepared = true;
          if (prepared?.providerRequestKey !== requestKey
            || prepared?.providerCorrelationId !== correlationId) {
            throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
          }
          const credential = await abortableResult(Promise.resolve()
            .then(() => resolveCapabilityCredential(capabilityExecution)), abort.signal);
          capabilityCredential = normalizeCapabilityCredential(credential, normalizedProfile);
          if (capabilityCredential.providerRequestKey !== requestKey
            || capabilityCredential.providerCorrelationId !== correlationId) {
            throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
          }
        } catch (error) {
          if (abort.signal.aborted) throw classifyFetchFailure(error, abort.state());
          const code = externalCode(error);
          if (["AI_GATEWAY_PROFILE_VERSION_CONFLICT", "AI_GATEWAY_CAPABILITY_IN_PROGRESS"].includes(code)) {
            throw gatewayError(code, { retryable: code === "AI_GATEWAY_CAPABILITY_IN_PROGRESS" });
          }
          if (code === "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN") {
            throw gatewayError(code, { retryable: true, status: 409 });
          }
          if (error instanceof AiGatewayError) throw error;
          throw gatewayError("AI_GATEWAY_SECRET_MISSING");
        }
      }
      await verifyGatewayBoundary(normalizedProfile, abort);
      if (abort.signal.aborted) {
        throw classifyFetchFailure(abort.signal.reason, abort.state());
      }
      let secret;
      try {
        const resolved = capabilityCredential?.secret ?? (normalizedProfile.apiKeyEnvName === ENCRYPTED_SECRET_REFERENCE
          ? await abortableResult(Promise.resolve().then(() => resolveSecret?.({
              accountId: normalizedProfile.accountId,
              connectionId: normalizedProfile.connectionId,
              connectionVersion: normalizedProfile.connectionVersion,
            })), abort.signal)
          : readSecret(normalizedProfile.apiKeyEnvName));
        secret = typeof resolved === "string" ? resolved.trim() : "";
      } catch (error) {
        if (abort.signal.aborted) throw classifyFetchFailure(error, abort.state());
        throw gatewayError("AI_GATEWAY_SECRET_MISSING");
      }
      if (!secret) throw gatewayError("AI_GATEWAY_SECRET_MISSING");
      safeLog(logger, "info", "ai_gateway.request_started", {
        profileId: normalizedProfile.id,
        profileVersion: normalizedProfile.configVersion,
        protocol,
        operation,
        correlationId,
      });
      const response = await fetchWithBoundary({
        fetchImpl,
        url,
        init: {
          method: body === undefined ? "GET" : "POST",
          headers: baseHeaders(secret, correlationId, requestKey, accept),
          ...(serializedBody === undefined ? {} : { body: serializedBody }),
        },
        boundary: normalizedProfile.boundary,
        authorized: true,
        signal: abort.signal,
        verifyTarget: () => verifyGatewayBoundary(normalizedProfile, abort),
        onFetchStart: () => { fetchStarted = true; },
        beforeSend: capabilityExecution === null ? undefined : async () => {
          if (capabilitySending) return;
          const sendingIdentity = await Promise.resolve()
            .then(() => markCapabilitySubcallSending(capabilityExecution));
          if (sendingIdentity?.providerRequestKey !== requestKey
            || sendingIdentity?.providerCorrelationId !== correlationId) {
            throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
          }
          capabilitySending = true;
        },
        rejectRedirects,
      });
      let responseOk;
      try { responseOk = response?.ok === true; } catch {
        abandonResponse(response);
        throw gatewayError("INVALID_GATEWAY_RESPONSE");
      }
      if (!responseOk) {
        const failure = classifyHttp(response);
        abandonResponse(response);
        if (capabilityExecution !== null) {
          await Promise.resolve(completeCapabilitySubcall(
            capabilityExecution, "FAILED", "PROVIDER_REJECTED",
          ));
          capabilitySettled = true;
        }
        throw failure;
      }
      if (capabilityExecution !== null) {
        try {
          await Promise.resolve(completeCapabilitySubcall(
            capabilityExecution, "SUCCEEDED", "PROVIDER_ACCEPTED",
          ));
        } catch {
          abandonResponse(response);
          throw gatewayError("AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", { retryable: true, status: 409 });
        }
        capabilitySettled = true;
      }
      safeLog(logger, "info", "ai_gateway.request_succeeded", {
        profileId: normalizedProfile.id,
        profileVersion: normalizedProfile.configVersion,
        protocol,
        operation,
        correlationId,
        requestId: safeRequestId(response),
        status: response.status,
      });
      return { response, normalizedProfile, abort };
    } catch (error) {
      let failure = error;
      let capabilitySettlementUnknown = false;
      if (capabilityExecution !== null && capabilityPrepared && !capabilitySending && !capabilitySettled) {
        try {
          await Promise.resolve(completeCapabilitySubcall(capabilityExecution, "FAILED",
            abort.state().callerCancelled || abort.state().timedOut ? "PRE_SEND_ABORTED" : "PRE_SEND_FAILED"));
          capabilitySettled = true;
        } catch (settlementError) {
          failure = settlementError;
          capabilitySettlementUnknown = true;
        }
      }
      const safe = capabilityExecution !== null
        && (capabilitySettlementUnknown || (capabilitySending && !capabilitySettled))
        ? gatewayError("AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", { retryable: true, status: 409 })
        : classifyFetchFailure(failure, abort.state(), { fetchStarted });
      safeLog(logger, "warn", "ai_gateway.request_failed", {
        profileId: normalizedProfile.id,
        profileVersion: normalizedProfile.configVersion,
        protocol,
        operation,
        correlationId,
        requestId: safe.requestId,
        status: safe.status,
        errorCode: safe.code,
      });
      abort.cleanup();
      throw safe;
    }
  }

  async function executeCatalogSyncAuthorized(input) {
    const timeoutMs = input?.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CATALOG_SYNC_TIMEOUT_MS
      || typeof resolveCatalogSyncCredential !== "function") {
      throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
    }
    const lease = normalizeCatalogSyncLease(input?.catalogSyncLease);
    const correlationId = validateIdentity(input?.correlationId);
    const requestKey = validateIdentity(input?.requestKey);
    const abort = createAbortContext({ callerSignal: input?.signal, timeoutMs, timers });
    let normalizedProfile = null;
    let fetchStarted = false;
    try {
      let rawCredential;
      try {
        rawCredential = await abortableResult(Promise.resolve().then(() => resolveCatalogSyncCredential({
          ...lease,
          minimumLeaseRemainingMs: timeoutMs + CATALOG_SYNC_DATABASE_MARGIN_MS,
        })), abort.signal);
      } catch (error) {
        if (abort.signal.aborted) throw classifyFetchFailure(error, abort.state());
        const code = externalCode(error);
        if ([
          "AUTO_LISTING_AI_MODEL_SYNC_LEASE_CONFLICT",
          "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE",
          "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED",
        ].includes(code)) {
          throw gatewayError(code, { retryable: code === "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED" });
        }
        throw gatewayError("AI_GATEWAY_SECRET_MISSING");
      }
      const credential = normalizeCatalogSyncCredential(rawCredential, lease.accountId);
      ({ normalizedProfile } = normalizeCatalogRequest({
        connection: credential.connection,
        correlationId,
        requestKey,
      }, { allowLocalGateway, allowedStatuses: new Set(["PENDING", "VALIDATED", "ACTIVE"]) }));
      const url = endpointUrl(normalizedProfile, "models");
      await verifyGatewayBoundary(normalizedProfile, abort);
      if (abort.signal.aborted) throw classifyFetchFailure(abort.signal.reason, abort.state());
      safeLog(logger, "info", "ai_gateway.request_started", {
        profileId: normalizedProfile.id,
        profileVersion: normalizedProfile.configVersion,
        protocol: "SUB2API_MODELS",
        operation: "models",
        correlationId,
      });
      const response = await fetchWithBoundary({
        fetchImpl,
        url,
        init: {
          method: "GET",
          headers: baseHeaders(credential.secret, correlationId, requestKey),
        },
        boundary: normalizedProfile.boundary,
        authorized: true,
        signal: abort.signal,
        verifyTarget: () => verifyGatewayBoundary(normalizedProfile, abort),
        onFetchStart: () => { fetchStarted = true; },
        rejectRedirects: true,
      });
      let responseOk;
      try { responseOk = response?.ok === true; } catch {
        abandonResponse(response);
        throw gatewayError("INVALID_GATEWAY_RESPONSE");
      }
      if (!responseOk) {
        const failure = classifyHttp(response);
        abandonResponse(response);
        throw failure;
      }
      safeLog(logger, "info", "ai_gateway.request_succeeded", {
        profileId: normalizedProfile.id,
        profileVersion: normalizedProfile.configVersion,
        protocol: "SUB2API_MODELS",
        operation: "models",
        correlationId,
        requestId: safeRequestId(response),
        status: response.status,
      });
      return { response, normalizedProfile, abort };
    } catch (error) {
      const safe = classifyFetchFailure(error, abort.state(), { fetchStarted });
      if (normalizedProfile) {
        safeLog(logger, "warn", "ai_gateway.request_failed", {
          profileId: normalizedProfile.id,
          profileVersion: normalizedProfile.configVersion,
          protocol: "SUB2API_MODELS",
          operation: "models",
          correlationId,
          requestId: safe.requestId,
          status: safe.status,
          errorCode: safe.code,
        });
      }
      abort.cleanup();
      throw safe;
    }
  }

  async function createTextResponseInternal(input = {}, { allowDisabled = false } = {}) {
    const { normalizedProfile } = normalizeRequest(input, "text", { allowDisabled, allowLocalGateway });
    if (normalizedProfile.textProtocol !== "SUB2API_RESPONSES") throw gatewayError("AI_GATEWAY_PROTOCOL_UNSUPPORTED");
    const validate = compileJsonSchema(input.jsonSchema);
    const body = {
      model: normalizedProfile.textModel,
      input: await responsesInput(input.prompt, input.sourceImages, maxImageBytes, maxSourceImageBytesTotal),
      text: {
        format: {
          type: "json_schema",
          name: "auto_listing_result",
          strict: true,
          schema: input.jsonSchema,
        },
      },
      stream: false,
      store: false,
    };
    const execution = await executeAuthorized({
      input,
      operation: "text",
      protocol: normalizedProfile.textProtocol,
      endpoint: "responses",
      body,
      allowDisabled,
    });
    let payload = null;
    try {
      payload = await readJson(execution.response, execution.abort, maxJsonBytes);
      const textModelEvidence = verifiedReportedModel(normalizedProfile.textModel, [payload?.model]);
      return {
        value: parseStructuredResponse(payload, validate),
        model: normalizedProfile.textModel,
        modelEvidence: {
          requestedTextModel: normalizedProfile.textModel,
          gatewayReportedTextModel: textModelEvidence.reportedModel,
          gatewayReportedTextModelPresent: textModelEvidence.evidencePresent,
        },
        requestId: safeRequestId(execution.response) || clean(payload.id),
        usage: safeUsage(payload.usage),
        diagnostics: {
          protocol: normalizedProfile.textProtocol,
          httpStatus: execution.response.status,
          responseKind: "STRUCTURED_TEXT",
        },
      };
    } catch (error) {
      if (error instanceof AiGatewayError && !error.requestId) {
        error.requestId = safeRequestId(execution.response) || clean(payload?.id);
      }
      throw withDeliveryState(error, "POSSIBLY_SENT");
    } finally {
      execution.abort.cleanup();
    }
  }

  async function createTextResponse(input = {}) {
    try {
      return await createTextResponseInternal(input, { allowDisabled: false });
    } catch (error) {
      throw withDeliveryState(error, "NOT_SENT");
    }
  }

  async function generateResponsesImage(input, normalizedProfile, { allowDisabled = false } = {}) {
    const body = {
      model: normalizedProfile.textModel,
      input: await responsesInput(input.prompt, input.sourceImages, maxImageBytes, maxSourceImageBytesTotal),
      tools: [{
        type: "image_generation",
        model: normalizedProfile.imageModel,
        action: "generate",
        ...(clean(input.size) ? { size: clean(input.size) } : {}),
        ...(clean(input.quality) ? { quality: clean(input.quality).toLowerCase() } : {}),
        ...(clean(input.outputFormat) ? { output_format: clean(input.outputFormat).toLowerCase() } : {}),
      }],
      tool_choice: "auto",
      stream: true,
      store: false,
    };
    const execution = await executeAuthorized({
      input,
      operation: "image",
      protocol: normalizedProfile.imageProtocol,
      endpoint: "responses",
      body,
      accept: "text/event-stream",
      allowDisabled,
    });
    try {
      const contentType = clean(execution.response.headers.get("content-type")).toLowerCase();
      if (contentType.includes("text/event-stream")) {
        const retryAfterMs = safeRetryAfter(execution.response);
        let events;
        try {
          events = await readSseEvents(execution.response, {
            maxBytes: maxSseBytes,
            abort: execution.abort,
            retryAfterMs,
          });
        } catch (error) {
          throw classifyFetchFailure(error, execution.abort.state(), { fetchStarted: true });
        }
        const final = finalImageFromEvents(events, maxImageBytes, retryAfterMs);
        return normalizedImage(final.bytes, {
          protocol: normalizedProfile.imageProtocol,
          requestedImageModel: normalizedProfile.imageModel,
          gatewayReportedImageModel: "",
          gatewayReportedImageModelPresent: false,
          orchestratorModel: final.orchestratorModel,
          requestId: safeRequestId(execution.response) || final.responseId,
          usage: final.usage,
        });
      }
      const payload = await readJson(execution.response, execution.abort, maxSseBytes);
      let encoded = "";
      for (const item of Array.isArray(payload?.output) ? payload.output : []) {
        if (item?.type === "image_generation_call" && typeof item.result === "string" && item.result.trim()) {
          encoded = item.result.trim();
        }
      }
      if (!encoded) throw gatewayError("INVALID_GATEWAY_RESPONSE");
      return normalizedImage(strictBase64(encoded, maxImageBytes), {
        protocol: normalizedProfile.imageProtocol,
        requestedImageModel: normalizedProfile.imageModel,
        gatewayReportedImageModel: "",
        gatewayReportedImageModelPresent: false,
        orchestratorModel: clean(payload.model),
        requestId: safeRequestId(execution.response) || clean(payload.id),
        usage: payload.usage,
      });
    } catch (error) {
      throw withDeliveryState(error, "POSSIBLY_SENT");
    } finally {
      execution.abort.cleanup();
    }
  }

  async function generateOpenAiImage(input, normalizedProfile, { allowDisabled = false } = {}) {
    const sourceImages = (await sourceImageContent(
      input.sourceImages,
      maxImageBytes,
      maxSourceImageBytesTotal,
    )).map((item) => ({ image_url: item.image_url }));
    const body = {
      model: normalizedProfile.imageModel,
      prompt: validatePrompt(input.prompt),
      n: 1,
      response_format: "b64_json",
      ...(clean(input.size) ? { size: clean(input.size) } : {}),
      ...(clean(input.quality) ? { quality: clean(input.quality).toLowerCase() } : {}),
      ...(clean(input.outputFormat) ? { output_format: clean(input.outputFormat).toLowerCase() } : {}),
      ...(sourceImages.length ? { images: sourceImages } : {}),
    };
    const execution = await executeAuthorized({
      input,
      operation: "image",
      protocol: normalizedProfile.imageProtocol,
      endpoint: sourceImages.length ? "images/edits" : "images/generations",
      body,
      allowDisabled,
    });
    try {
      const payload = await readJson(execution.response, execution.abort, maxSseBytes);
      const item = Array.isArray(payload?.data) ? payload.data[0] : null;
      const imageModelEvidence = verifiedReportedModel(normalizedProfile.imageModel, [payload?.model, item?.model]);
      let bytes;
      if (typeof item?.b64_json === "string" && item.b64_json.trim()) bytes = strictBase64(item.b64_json, maxImageBytes);
      else if (clean(item?.url, 4096)) {
        try {
          await verifyGatewayBoundary(normalizedProfile, execution.abort);
          bytes = await readImageUrl(
            fetchImpl,
            item.url,
            normalizedProfile,
            execution.abort,
            maxImageBytes,
            () => verifyGatewayBoundary(normalizedProfile, execution.abort),
          );
        } catch (error) {
          throw classifyFetchFailure(error, execution.abort.state(), { fetchStarted: true });
        }
      } else throw gatewayError("INVALID_GATEWAY_RESPONSE");
      return normalizedImage(bytes, {
        protocol: normalizedProfile.imageProtocol,
        requestedImageModel: normalizedProfile.imageModel,
        gatewayReportedImageModel: imageModelEvidence.reportedModel,
        gatewayReportedImageModelPresent: imageModelEvidence.evidencePresent,
        requestId: safeRequestId(execution.response) || clean(payload.id),
        usage: payload.usage,
      });
    } catch (error) {
      throw withDeliveryState(error, "POSSIBLY_SENT");
    } finally {
      execution.abort.cleanup();
    }
  }

  async function generateImageInternal(input = {}, { allowDisabled = false } = {}) {
    const { normalizedProfile } = normalizeRequest(input, "image", { allowDisabled, allowLocalGateway });
    if (normalizedProfile.imageProtocol === "SUB2API_RESPONSES_IMAGE_TOOL") {
      return generateResponsesImage(input, normalizedProfile, { allowDisabled });
    }
    if (normalizedProfile.imageProtocol === "SUB2API_OPENAI_IMAGES") {
      return generateOpenAiImage(input, normalizedProfile, { allowDisabled });
    }
    throw gatewayError("AI_GATEWAY_PROTOCOL_UNSUPPORTED");
  }

  async function generateImage(input = {}) {
    try {
      return await generateImageInternal(input, { allowDisabled: false });
    } catch (error) {
      throw withDeliveryState(error, "NOT_SENT");
    }
  }

  async function inspectImage(input = {}) {
    const image = input.image;
    if (!image?.bytes) {
      throw withDeliveryState(gatewayError("AI_GATEWAY_REQUEST_INVALID"), "NOT_SENT");
    }
    return createTextResponse({
      ...input,
      sourceImages: [
        { bytes: image.bytes, contentType: image.contentType },
        ...(Array.isArray(input.sourceImages) ? input.sourceImages : []),
      ],
    });
  }

  async function listModels(input = {}) {
    let execution = null;
    try {
      execution = input?.catalogSyncLease === undefined
        ? await executeAuthorized({
            input,
            operation: "models",
            protocol: "SUB2API_MODELS",
            endpoint: "models",
            body: undefined,
            normalizeInput: normalizeCatalogRequest,
            rejectRedirects: true,
          })
        : await executeCatalogSyncAuthorized(input);
      const payload = await readJson(execution.response, execution.abort, maxJsonBytes);
      return normalizeModelCatalog(payload, execution.response);
    } catch (error) {
      throw withDeliveryState(error, execution ? "POSSIBLY_SENT" : "NOT_SENT");
    } finally {
      execution?.abort.cleanup();
    }
  }

  async function probeReachability(input, { allowDisabled = false } = {}) {
    const identity = input.capabilityExecution === undefined ? null
      : capabilityProviderIdentity(capabilityExecutionForProbe(input.capabilityExecution, input.capabilityProbe));
    const { normalizedProfile } = normalizeRequest(
      { ...input, model: input.profile.textModel || input.profile.text_model,
        ...(identity ? { correlationId: identity.providerCorrelationId,
          requestKey: identity.providerRequestKey } : {}) },
      "text",
      { allowDisabled, allowLocalGateway },
    );
    const execution = await executeAuthorized({
      input: { ...input, model: normalizedProfile.textModel },
      operation: "text",
      protocol: normalizedProfile.textProtocol,
      endpoint: "models",
      body: undefined,
      allowDisabled,
    });
    try {
      return safeRequestId(execution.response);
    } finally {
      abandonResponse(execution.response);
      execution.abort.cleanup();
    }
  }

  async function testCapabilitiesInternal(input = {}) {
    if (input.capabilityExecution === undefined || typeof prepareCapabilitySubcall !== "function"
      || typeof resolveCapabilityCredential !== "function"
      || typeof markCapabilitySubcallSending !== "function" || typeof completeCapabilitySubcall !== "function"
      || input.correlationId !== undefined || input.requestKey !== undefined) {
      throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
    }
    const started = Date.now();
    const normalizedProfile = normalizeProfile(input.profile, { allowLocalGateway });
    const base = {
      profile: input.profile,
      timeoutMs: input.timeoutMs || 120_000,
      signal: input.signal,
    };
    const textExecution = capabilityExecutionForProbe(input.capabilityExecution, "TEXT");
    const textIdentity = capabilityProviderIdentity(textExecution);
    const imageExecution = capabilityExecutionForProbe(input.capabilityExecution, "IMAGE");
    const imageIdentity = capabilityProviderIdentity(imageExecution);
    const reachabilityId = await probeReachability({
      ...base,
      capabilityExecution: input.capabilityExecution,
      capabilityProbe: "REACHABILITY",
      profile: { ...input.profile, textModel: normalizedProfile.textModel },
    }, { allowDisabled: true });
    const text = await createTextResponseInternal({
      ...base,
      capabilityExecution: input.capabilityExecution,
      capabilityProbe: "TEXT",
      correlationId: textIdentity.providerCorrelationId,
      requestKey: textIdentity.providerRequestKey,
      model: normalizedProfile.textModel,
      prompt: "Return exactly the requested capability JSON.",
      jsonSchema: {
        type: "object",
        properties: { ok: { type: "boolean", const: true } },
        required: ["ok"],
        additionalProperties: false,
      },
    }, { allowDisabled: true });
    if (text.value?.ok !== true) throw gatewayError("INVALID_GATEWAY_RESPONSE");
    const image = await generateImageInternal({
      ...base,
      capabilityExecution: input.capabilityExecution,
      capabilityProbe: "IMAGE",
      correlationId: imageIdentity.providerCorrelationId,
      requestKey: imageIdentity.providerRequestKey,
      model: normalizedProfile.imageModel,
      prompt: "A plain blue square on a white background, no text.",
      size: "1024x1024",
      quality: "low",
      outputFormat: "png",
      sourceImages: [{ bytes: CAPABILITY_SOURCE_PNG, contentType: "image/png" }],
    }, { allowDisabled: true });
    try {
      const decoded = sharp(Buffer.from(image.bytes), { failOn: "error", limitInputPixels: 100_000_000 });
      const metadata = await decoded.metadata();
      await sharp(Buffer.from(image.bytes), { failOn: "error", limitInputPixels: 100_000_000 }).stats();
      if (!metadata?.format || metadata.width !== image.width || metadata.height !== image.height) {
        throw new Error("decoded image metadata mismatch");
      }
    } catch {
      throw gatewayError("INVALID_GATEWAY_RESPONSE");
    }
    if (image.modelEvidence?.requestedImageModel !== normalizedProfile.imageModel
      || (image.modelEvidence?.gatewayReportedImageModel
        && !isCompatibleAiModelIdentity(normalizedProfile.imageModel,
          image.modelEvidence.gatewayReportedImageModel))) {
      throw gatewayError("INVALID_GATEWAY_RESPONSE");
    }
    return {
      features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", `IMAGE_DECODE_${image.format.toUpperCase()}`],
      latencyMs: Math.max(0, Date.now() - started),
      models: { text: normalizedProfile.textModel, image: normalizedProfile.imageModel },
      modelEvidence: image.modelEvidence,
      requestIds: { reachability: reachabilityId, text: text.requestId, image: image.requestId },
    };
  }

  async function testCapabilities(input = {}) {
    try {
      return await testCapabilitiesInternal(input);
    } catch (error) {
      throw withDeliveryState(error, "NOT_SENT");
    }
  }

  return createAiGatewayPort({ createTextResponse, generateImage, inspectImage, listModels, testCapabilities });
}

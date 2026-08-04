import { AiGatewayError, createAiGatewayPort } from "./ai-gateway-port.mjs";
import Ajv from "ajv";
import sharp from "sharp";

export const SUB2API_TEXT_PROTOCOLS = Object.freeze(["SUB2API_RESPONSES"]);
export const SUB2API_IMAGE_PROTOCOLS = Object.freeze([
  "SUB2API_RESPONSES_IMAGE_TOOL",
  "SUB2API_OPENAI_IMAGES",
]);

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "openai-request-id"];
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CHARACTERS = 100_000;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const DANGEROUS_ENV_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const CAPABILITY_SOURCE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const FAILURE_EVENTS = new Set([
  "error",
  "response.failed",
  "response.incomplete",
  "response.cancelled",
  "response.canceled",
]);

const schemaCompiler = new Ajv({
  allErrors: true,
  strict: true,
  validateSchema: true,
  removeAdditional: false,
  coerceTypes: false,
  useDefaults: false,
});

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
    AI_GATEWAY_INPUT_UNSUPPORTED: "AI 网关不支持该输入",
    GATEWAY_REDIRECT_BLOCKED: "AI 网关重定向被安全策略阻止",
    GATEWAY_TIMEOUT: "AI 网关请求超时",
    GATEWAY_CANCELLED: "AI 网关请求已取消",
    RETRYABLE_GATEWAY: "AI 网关暂时不可用",
    NON_RETRYABLE_AUTH: "AI 网关鉴权失败",
    NON_RETRYABLE_GATEWAY: "AI 网关拒绝请求",
    INVALID_GATEWAY_RESPONSE: "AI 网关返回了无法识别的结果",
  };
  return new AiGatewayError(code, { ...options, message: messages[code] || "AI 网关调用失败" });
}

function profileField(profile, camel, snake = "") {
  return profile?.[camel] ?? (snake ? profile?.[snake] : undefined);
}

function normalizeProfile(profile) {
  const result = {
    id: clean(profileField(profile, "id")),
    accountId: clean(profileField(profile, "accountId", "account_id")),
    configVersion: Number(profileField(profile, "configVersion", "config_version")),
    baseUrl: clean(profileField(profile, "baseUrl", "base_url"), 2048),
    apiKeyEnvName: clean(profileField(profile, "apiKeyEnvName", "api_key_env_name")),
    textProtocol: clean(profileField(profile, "textProtocol", "text_protocol")),
    imageProtocol: clean(profileField(profile, "imageProtocol", "image_protocol")),
    textModel: clean(profileField(profile, "textModel", "text_model")),
    imageModel: clean(profileField(profile, "imageModel", "image_model")),
    enabled: profileField(profile, "enabled") === true,
  };
  if (!result.id || !result.accountId || !Number.isInteger(result.configVersion) || result.configVersion < 1
    || !result.baseUrl || !result.apiKeyEnvName || !result.textModel || !result.imageModel
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(result.apiKeyEnvName)
    || DANGEROUS_ENV_NAMES.has(result.apiKeyEnvName.toLowerCase())
    || !SUB2API_TEXT_PROTOCOLS.includes(result.textProtocol)
    || !SUB2API_IMAGE_PROTOCOLS.includes(result.imageProtocol)) {
    throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
  }
  let parsed;
  try {
    parsed = new URL(result.baseUrl);
  } catch {
    throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
  }
  const loopbackHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
  if ((parsed.protocol !== "https:" && !loopbackHttp) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw gatewayError("AI_GATEWAY_PROFILE_INVALID");
  }
  const pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  parsed.pathname = pathname.replace(/\/+/g, "/");
  result.boundary = Object.freeze({ origin: parsed.origin, path: parsed.pathname });
  result.base = parsed;
  return Object.freeze(result);
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

function compileJsonSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  }
  try {
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
    const value = clean(response?.headers?.get?.(name));
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
  method.call(logger, event, safe);
}

function abortContext(callerSignal, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  }
  const controller = new AbortController();
  let timedOut = false;
  let callerCancelled = Boolean(callerSignal?.aborted);
  const onCallerAbort = () => {
    callerCancelled = true;
    controller.abort(new DOMException("cancelled", "AbortError"));
  };
  if (callerSignal?.addEventListener) callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  if (callerCancelled) onCallerAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("timeout", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    state: () => ({ timedOut, callerCancelled }),
    cleanup() {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.("abort", onCallerAbort);
    },
  };
}

function classifyFetchFailure(error, abortState) {
  if (abortState.callerCancelled) return gatewayError("GATEWAY_CANCELLED", { retryable: false });
  if (abortState.timedOut) return gatewayError("GATEWAY_TIMEOUT", { retryable: true });
  if (error instanceof AiGatewayError) return error;
  return gatewayError("RETRYABLE_GATEWAY", { retryable: true });
}

function classifyHttp(response) {
  const requestId = safeRequestId(response);
  if (response.status === 401 || response.status === 403) {
    return gatewayError("NON_RETRYABLE_AUTH", { status: response.status, requestId });
  }
  if (RETRYABLE_HTTP.has(response.status)) {
    return gatewayError("RETRYABLE_GATEWAY", { retryable: true, status: response.status, requestId });
  }
  return gatewayError("NON_RETRYABLE_GATEWAY", { status: response.status, requestId });
}

async function fetchWithBoundary({ fetchImpl, url, init, boundary, authorized, signal }) {
  let target = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response;
    try {
      response = await fetchImpl(target, { ...init, redirect: "manual", signal });
    } catch (error) {
      throw error;
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === MAX_REDIRECTS) throw gatewayError("GATEWAY_REDIRECT_BLOCKED");
    const location = response.headers.get("location");
    if (!location) throw gatewayError("GATEWAY_REDIRECT_BLOCKED");
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
    if (kind === "VP8X") {
      const width = 1 + bytes.readUIntLE(24, 3);
      const height = 1 + bytes.readUIntLE(27, 3);
      if (width > 0 && height > 0) return { contentType: "image/webp", width, height, format: "webp" };
    }
  }
  throw gatewayError("INVALID_GATEWAY_RESPONSE");
}

function normalizedImage(bytes, extra = {}) {
  const metadata = imageMetadata(bytes);
  const requestedImageModel = clean(extra.requestedImageModel || extra.model);
  const gatewayReportedImageModel = clean(extra.gatewayReportedImageModel);
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

function sourceImageContent(sourceImages = [], maxImageBytes = MAX_IMAGE_BYTES) {
  if (!Array.isArray(sourceImages)) throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  if (sourceImages.length > 8) throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  return sourceImages.map((source) => {
    if (source?.bytes) {
      try {
        const bytes = Buffer.from(source.bytes);
        if (!bytes.length || bytes.length > maxImageBytes) throw new Error("invalid source image size");
        const metadata = imageMetadata(bytes);
        return { type: "input_image", image_url: `data:${metadata.contentType};base64,${bytes.toString("base64")}` };
      } catch {
        throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
      }
    }
    if (source?.url) throw gatewayError("AI_GATEWAY_INPUT_UNSUPPORTED");
    throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
  });
}

function responsesInput(prompt, sourceImages = [], maxImageBytes = MAX_IMAGE_BYTES) {
  return [{
    role: "user",
    content: [
      { type: "input_text", text: validatePrompt(prompt) },
      ...sourceImageContent(sourceImages, maxImageBytes),
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
  const text = extractOutputText(body);
  try {
    const value = JSON.parse(text);
    if (!validate(value)) throw new Error("schema mismatch");
    return value;
  } catch {
    throw gatewayError("INVALID_GATEWAY_RESPONSE");
  }
}

function parseSse(raw) {
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const eventName = clean(lines.find((line) => line.startsWith("event:"))?.slice(6));
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (eventName && parsed && typeof parsed === "object" && !parsed.type) parsed.type = eventName;
      events.push(parsed);
    } catch { throw gatewayError("INVALID_GATEWAY_RESPONSE"); }
  }
  return events;
}

function finalImageFromEvents(events, maxImageBytes) {
  let encoded = "";
  let usage = null;
  let responseId = "";
  let orchestratorModel = "";
  let gatewayReportedImageModel = "";
  let completed = false;
  for (const event of events) {
    if (FAILURE_EVENTS.has(event?.type)) throw gatewayError("NON_RETRYABLE_GATEWAY");
    if (event?.type === "response.output_item.done" && event?.item?.type === "image_generation_call") {
      encoded = typeof event.item.result === "string" ? event.item.result.trim() : "";
    }
    if (event?.type === "response.completed") {
      const response = event.response || {};
      if (response.status && response.status !== "completed") throw gatewayError("NON_RETRYABLE_GATEWAY");
      completed = true;
      responseId = clean(response.id);
      orchestratorModel = clean(response.model);
      usage = response.usage || usage;
      for (const tool of Array.isArray(response.tools) ? response.tools : []) {
        if (tool?.type === "image_generation" && clean(tool.model)) gatewayReportedImageModel = clean(tool.model);
      }
      for (const item of Array.isArray(response.output) ? response.output : []) {
        if (item?.type === "image_generation_call" && typeof item.result === "string" && item.result.trim()) {
          encoded = item.result.trim();
          if (clean(item.model)) gatewayReportedImageModel = clean(item.model);
        }
      }
    }
  }
  if (!completed || !encoded) throw gatewayError("INVALID_GATEWAY_RESPONSE");
  return { bytes: strictBase64(encoded, maxImageBytes), usage, responseId, orchestratorModel, gatewayReportedImageModel };
}

function positiveByteLimit(value, fallback) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 1) throw new TypeError("body byte limits must be positive integers");
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
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch?.(() => {});
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
  if (!response.body?.getReader) throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await readerRead(reader, abort.signal);
      if (done) { finished = true; break; }
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readJson(response, abort, maxBytes) {
  try {
    const bytes = await readBodyLimited(response, { maxBytes, abort });
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof AiGatewayError) throw error;
    if (abort.signal.aborted) throw classifyFetchFailure(error, abort.state());
    throw gatewayError("INVALID_GATEWAY_RESPONSE", { requestId: safeRequestId(response) });
  }
}

async function readImageUrl(fetchImpl, urlValue, normalizedProfile, abort, maxImageBytes) {
  const url = parseBoundaryUrl(urlValue, normalizedProfile.boundary);
  const response = await fetchWithBoundary({
    fetchImpl,
    url,
    init: { method: "GET", headers: { Accept: "image/png,image/jpeg,image/webp" } },
    boundary: normalizedProfile.boundary,
    authorized: false,
    signal: abort.signal,
  });
  if (!response.ok) throw classifyHttp(response);
  const bytes = await readBodyLimited(response, { maxBytes: maxImageBytes, abort });
  if (!bytes.length || bytes.length > maxImageBytes) throw gatewayError("INVALID_GATEWAY_RESPONSE");
  return bytes;
}

function normalizeRequest(input, operation, { allowDisabled = false } = {}) {
  const normalizedProfile = normalizeProfile(input?.profile);
  if (!allowDisabled && !normalizedProfile.enabled) throw gatewayError("AI_GATEWAY_PROFILE_DISABLED");
  const correlationId = validateIdentity(input?.correlationId);
  const requestKey = validateIdentity(input?.requestKey);
  const model = validateIdentity(input?.model);
  const expectedModel = operation === "text" ? normalizedProfile.textModel : normalizedProfile.imageModel;
  if (model !== expectedModel) throw gatewayError("AI_GATEWAY_MODEL_MISMATCH");
  return { normalizedProfile, correlationId, requestKey, model };
}

export function createSub2ApiAdapter({
  fetchImpl = globalThis.fetch,
  readSecret = (name) => process.env[name],
  logger = null,
  maxImageBytes = MAX_IMAGE_BYTES,
  maxJsonBytes = MAX_JSON_BYTES,
  maxSseBytes,
} = {}) {
  if (typeof fetchImpl !== "function" || typeof readSecret !== "function") {
    throw new TypeError("sub2api adapter requires fetch and secret reader");
  }
  maxImageBytes = positiveByteLimit(maxImageBytes, MAX_IMAGE_BYTES);
  maxJsonBytes = positiveByteLimit(maxJsonBytes, MAX_JSON_BYTES);
  maxSseBytes = positiveByteLimit(maxSseBytes, Math.ceil(maxImageBytes * 4 / 3) + MAX_JSON_BYTES);

  async function executeAuthorized({ input, operation, protocol, endpoint, body, accept = "application/json", allowDisabled = false }) {
    const { normalizedProfile, correlationId, requestKey } = normalizeRequest(input, operation, { allowDisabled });
    let secret;
    try {
      const resolved = readSecret(normalizedProfile.apiKeyEnvName);
      secret = typeof resolved === "string" ? resolved.trim() : "";
    } catch {
      throw gatewayError("AI_GATEWAY_SECRET_MISSING");
    }
    if (!secret) throw gatewayError("AI_GATEWAY_SECRET_MISSING");
    const abort = abortContext(input.signal, input.timeoutMs);
    const url = endpointUrl(normalizedProfile, endpoint);
    safeLog(logger, "info", "ai_gateway.request_started", {
      profileId: normalizedProfile.id,
      profileVersion: normalizedProfile.configVersion,
      protocol,
      operation,
      correlationId,
    });
    try {
      const response = await fetchWithBoundary({
        fetchImpl,
        url,
        init: {
          method: body === undefined ? "GET" : "POST",
          headers: baseHeaders(secret, correlationId, requestKey, accept),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        boundary: normalizedProfile.boundary,
        authorized: true,
        signal: abort.signal,
      });
      if (!response.ok) throw classifyHttp(response);
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
      const safe = classifyFetchFailure(error, abort.state());
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

  async function createTextResponseInternal(input = {}, { allowDisabled = false } = {}) {
    const { normalizedProfile } = normalizeRequest(input, "text", { allowDisabled });
    if (normalizedProfile.textProtocol !== "SUB2API_RESPONSES") throw gatewayError("AI_GATEWAY_PROTOCOL_UNSUPPORTED");
    const validate = compileJsonSchema(input.jsonSchema);
    const body = {
      model: normalizedProfile.textModel,
      input: responsesInput(input.prompt, input.sourceImages, maxImageBytes),
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
    try {
      const payload = await readJson(execution.response, execution.abort, maxJsonBytes);
      return {
        value: parseStructuredResponse(payload, validate),
        model: clean(payload.model) || normalizedProfile.textModel,
        requestId: safeRequestId(execution.response) || clean(payload.id),
        usage: safeUsage(payload.usage),
        diagnostics: {
          protocol: normalizedProfile.textProtocol,
          httpStatus: execution.response.status,
          responseKind: "STRUCTURED_TEXT",
        },
      };
    } finally {
      execution.abort.cleanup();
    }
  }

  async function createTextResponse(input = {}) {
    return createTextResponseInternal(input, { allowDisabled: false });
  }

  async function generateResponsesImage(input, normalizedProfile, { allowDisabled = false } = {}) {
    const body = {
      model: normalizedProfile.textModel,
      input: responsesInput(input.prompt, input.sourceImages, maxImageBytes),
      tools: [{
        type: "image_generation",
        model: normalizedProfile.imageModel,
        action: "generate",
        ...(clean(input.size) ? { size: clean(input.size) } : {}),
        ...(clean(input.quality) ? { quality: clean(input.quality).toLowerCase() } : {}),
        ...(clean(input.outputFormat) ? { output_format: clean(input.outputFormat).toLowerCase() } : {}),
      }],
      tool_choice: { type: "image_generation" },
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
        let raw;
        try {
          raw = (await readBodyLimited(execution.response, { maxBytes: maxSseBytes, abort: execution.abort })).toString("utf8");
        } catch (error) {
          throw classifyFetchFailure(error, execution.abort.state());
        }
        const final = finalImageFromEvents(parseSse(raw), maxImageBytes);
        return normalizedImage(final.bytes, {
          protocol: normalizedProfile.imageProtocol,
          requestedImageModel: normalizedProfile.imageModel,
          gatewayReportedImageModel: final.gatewayReportedImageModel,
          orchestratorModel: final.orchestratorModel,
          requestId: safeRequestId(execution.response) || final.responseId,
          usage: final.usage,
        });
      }
      const payload = await readJson(execution.response, execution.abort, maxSseBytes);
      let encoded = "";
      let gatewayReportedImageModel = "";
      for (const item of Array.isArray(payload?.output) ? payload.output : []) {
        if (item?.type === "image_generation_call" && typeof item.result === "string" && item.result.trim()) {
          encoded = item.result.trim();
          gatewayReportedImageModel = clean(item.model);
        }
      }
      if (!encoded) throw gatewayError("INVALID_GATEWAY_RESPONSE");
      return normalizedImage(strictBase64(encoded, maxImageBytes), {
        protocol: normalizedProfile.imageProtocol,
        requestedImageModel: normalizedProfile.imageModel,
        gatewayReportedImageModel,
        orchestratorModel: clean(payload.model),
        requestId: safeRequestId(execution.response) || clean(payload.id),
        usage: payload.usage,
      });
    } finally {
      execution.abort.cleanup();
    }
  }

  async function generateOpenAiImage(input, normalizedProfile, { allowDisabled = false } = {}) {
    const sourceImages = sourceImageContent(input.sourceImages, maxImageBytes).map((item) => ({ image_url: item.image_url }));
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
      let bytes;
      if (typeof item?.b64_json === "string" && item.b64_json.trim()) bytes = strictBase64(item.b64_json, maxImageBytes);
      else if (clean(item?.url, 4096)) {
        try {
          bytes = await readImageUrl(fetchImpl, item.url, normalizedProfile, execution.abort, maxImageBytes);
        } catch (error) {
          throw classifyFetchFailure(error, execution.abort.state());
        }
      } else throw gatewayError("INVALID_GATEWAY_RESPONSE");
      return normalizedImage(bytes, {
        protocol: normalizedProfile.imageProtocol,
        requestedImageModel: normalizedProfile.imageModel,
        gatewayReportedImageModel: clean(payload.model),
        requestId: safeRequestId(execution.response) || clean(payload.id),
        usage: payload.usage,
      });
    } finally {
      execution.abort.cleanup();
    }
  }

  async function generateImageInternal(input = {}, { allowDisabled = false } = {}) {
    const { normalizedProfile } = normalizeRequest(input, "image", { allowDisabled });
    if (normalizedProfile.imageProtocol === "SUB2API_RESPONSES_IMAGE_TOOL") {
      return generateResponsesImage(input, normalizedProfile, { allowDisabled });
    }
    if (normalizedProfile.imageProtocol === "SUB2API_OPENAI_IMAGES") {
      return generateOpenAiImage(input, normalizedProfile, { allowDisabled });
    }
    throw gatewayError("AI_GATEWAY_PROTOCOL_UNSUPPORTED");
  }

  async function generateImage(input = {}) {
    return generateImageInternal(input, { allowDisabled: false });
  }

  async function inspectImage(input = {}) {
    const image = input.image;
    if (!image?.bytes) throw gatewayError("AI_GATEWAY_REQUEST_INVALID");
    return createTextResponse({
      ...input,
      sourceImages: [{ bytes: image.bytes, contentType: image.contentType }],
    });
  }

  async function probeReachability(input, { allowDisabled = false } = {}) {
    const { normalizedProfile } = normalizeRequest(
      { ...input, model: input.profile.textModel || input.profile.text_model },
      "text",
      { allowDisabled },
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
      execution.abort.cleanup();
    }
  }

  async function testCapabilities(input = {}) {
    const started = Date.now();
    const normalizedProfile = normalizeProfile(input.profile);
    const base = {
      profile: input.profile,
      correlationId: validateIdentity(input.correlationId),
      timeoutMs: input.timeoutMs || 120_000,
      signal: input.signal,
    };
    const reachabilityId = await probeReachability({
      ...base,
      requestKey: `${validateIdentity(input.requestKey)}:reachability`,
      profile: { ...input.profile, textModel: normalizedProfile.textModel },
    }, { allowDisabled: true });
    const text = await createTextResponseInternal({
      ...base,
      model: normalizedProfile.textModel,
      requestKey: `${input.requestKey}:text-schema`,
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
      model: normalizedProfile.imageModel,
      requestKey: `${input.requestKey}:image`,
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
        && image.modelEvidence.gatewayReportedImageModel !== normalizedProfile.imageModel)) {
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

  return createAiGatewayPort({ createTextResponse, generateImage, inspectImage, testCapabilities });
}

import { apiRequest } from "./client-transport.js";

const BASE = "/admin/auto-listing/ai-settings";
const MAX_BYTES = 64 * 1024;
const SECRET_KEYS = new Set([
  "gatewayKey", "apiKey", "api_key", "secret", "encryptedSecret", "ciphertext", "iv", "authTag",
  "authorization", "leaseToken", "lease_token", "apiKeyEnvName", "api_key_env_name",
]);
const CONNECTION_KEYS = ["id", "accountId", "version", "displayName", "baseUrl", "fingerprint", "keyVersion",
  "status", "statusVersion", "validationResult", "validatedAt", "activatedAt", "retiredAt", "createdAt", "duplicate"];
const TASK_KEYS = ["id", "accountId", "connectionId", "connectionVersion", "syncPurpose", "targetConnectionStatusVersion",
  "status", "statusVersion", "attemptCount", "maxAttempts", "leaseVersion", "availableAt", "completedAt",
  "lastErrorCode", "lastErrorSafe", "createdAt", "duplicate"];
const PROFILE_KEYS = ["id", "accountId", "displayName", "configVersion", "baseUrl", "textProtocol", "imageProtocol",
  "textModel", "imageModel", "enabled", "capabilityResult", "capabilityCheckedAt", "connectionId", "connectionVersion",
  "createdAt", "duplicate"];
const CATALOG_KEYS = ["id", "accountId", "connectionId", "connectionVersion", "syncTaskId", "catalog", "catalogHash",
  "capabilityResult", "capabilityHash", "rollbackEvidenceIdentity", "testedAt", "createdAt"];
const CAPABILITY_KEYS = ["profileId", "configVersion", "outcome", "features", "latencyMs", "models", "checkedAt", "errorCode", "enabled"];
const ACTION_KEYS = ["canCreateConnection", "syncableConnectionIds", "testableProfileIds", "publishableProfileIds", "rollbackProfileIds"];
const CONNECTION_STATUS = new Set(["PENDING", "VALIDATED", "ACTIVE", "RETIRED"]);
const TASK_STATUS = new Set(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);
const CAPABILITY_OUTCOME = new Set(["PASSED", "FAILED", "NOT_TESTED", "MISSING", "UNKNOWN", "STALE"]);
const intentOwners = new WeakMap();

function invalid(kind) {
  return Object.assign(new Error(kind), { code: kind });
}

function plainRecord(value) {
  try {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function closed(raw, keys, { optional = [] } = {}) {
  try {
    if (!plainRecord(raw)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
    const ownKeys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const allowed = new Set([...keys, ...optional]);
    if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))
      || keys.some((key) => !Object.hasOwn(descriptors, key))) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
    return Object.fromEntries(ownKeys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code) throw error;
    throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  }
}

function text(value, maximum = 2048) {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > maximum) {
    throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  }
  return value.trim();
}

function id(value) {
  const result = text(value, 300);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,299}$/u.test(result)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return result;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return value;
}

function exactIntent(raw, { idempotency = true } = {}) {
  const result = closed(raw, idempotency ? ["idempotencyKey", "correlationId"] : ["correlationId"], { optional: ["signal"] });
  if (result.signal !== undefined && (!globalThis.AbortSignal || !(result.signal instanceof globalThis.AbortSignal))) {
    throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  }
  return Object.freeze({ ...(idempotency ? { idempotencyKey: id(result.idempotencyKey) } : {}), correlationId: id(result.correlationId), signal: result.signal });
}

function safeJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return value;
  }
  if (!value || typeof value !== "object" || seen.has(value)) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => safeJson(entry, seen));
    if (!plainRecord(value)) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || SECRET_KEYS.has(key) || ["__proto__", "constructor", "prototype"].includes(key)
        || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value")) {
        throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
      }
      result[key] = safeJson(descriptors[key].value, seen);
    }
    return result;
  } catch (error) {
    if (error?.code) throw error;
    throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  } finally {
    seen.delete(value);
  }
}

function responseSize(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID"); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  return value;
}

function exactResponse(raw, keys) {
  const value = safeJson(raw);
  if (!plainRecord(value) || Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  }
  return responseSize(value);
}

function nullableText(value) {
  return value === null || typeof value === "string";
}

function responseValidation(validate) {
  try { return validate(); } catch { throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID"); }
}

function validateConnection(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, CONNECTION_KEYS);
    if (!id(value.id) || !id(value.accountId) || version(value.version) < 1 || !text(value.displayName, 200)
    || !text(value.baseUrl) || !text(value.fingerprint, 512) || !id(value.keyVersion) || !CONNECTION_STATUS.has(value.status)
    || version(value.statusVersion) < 1 || !nullableText(value.validatedAt) || !nullableText(value.activatedAt)
    || !nullableText(value.retiredAt) || !text(value.createdAt) || typeof value.duplicate !== "boolean") {
      throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    }
    return Object.freeze(value);
  });
}

function validateTask(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, TASK_KEYS);
    if (!id(value.id) || !id(value.accountId) || !id(value.connectionId) || version(value.connectionVersion) < 1
    || !["CATALOG_SYNC", "ROLLBACK_CAPABILITY"].includes(value.syncPurpose) || version(value.targetConnectionStatusVersion) < 1
    || !TASK_STATUS.has(value.status) || version(value.statusVersion) < 1 || !Number.isSafeInteger(value.attemptCount)
    || !Number.isSafeInteger(value.maxAttempts) || !Number.isSafeInteger(value.leaseVersion) || !nullableText(value.availableAt)
    || !nullableText(value.completedAt) || !nullableText(value.lastErrorCode) || !nullableText(value.lastErrorSafe)
      || !text(value.createdAt) || typeof value.duplicate !== "boolean") throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze(value);
  });
}

function validateProfile(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, PROFILE_KEYS);
    if (!id(value.id) || !id(value.accountId) || !text(value.displayName, 200) || version(value.configVersion) < 1
    || !text(value.baseUrl) || value.textProtocol !== "SUB2API_RESPONSES"
    || !["SUB2API_RESPONSES_IMAGE_TOOL", "SUB2API_OPENAI_IMAGES"].includes(value.imageProtocol)
    || !id(value.textModel) || !id(value.imageModel) || typeof value.enabled !== "boolean" || !nullableText(value.capabilityCheckedAt)
    || !nullableText(value.connectionId) || (value.connectionVersion !== null && (!Number.isSafeInteger(value.connectionVersion) || value.connectionVersion < 1))
      || !text(value.createdAt) || typeof value.duplicate !== "boolean") throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze(value);
  });
}

function validateCapability(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, CAPABILITY_KEYS);
    if (!id(value.profileId) || version(value.configVersion) < 1 || !CAPABILITY_OUTCOME.has(value.outcome)
    || !Array.isArray(value.features) || !Number.isFinite(value.latencyMs) && value.latencyMs !== null
    || !plainRecord(value.models) || !id(value.models.text) || !id(value.models.image) || !text(value.checkedAt)
      || !nullableText(value.errorCode) || typeof value.enabled !== "boolean") throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze(value);
  });
}

function validateActions(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, ACTION_KEYS);
    if (typeof value.canCreateConnection !== "boolean" || ACTION_KEYS.slice(1).some((key) => !Array.isArray(value[key]) || value[key].some((entry) => {
    try { id(entry); return false; } catch { return true; }
    }))) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze(value);
  });
}

function validateCatalog(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, CATALOG_KEYS);
    if (!id(value.id) || !id(value.accountId) || !id(value.connectionId) || version(value.connectionVersion) < 1
    || !id(value.syncTaskId) || !plainRecord(value.catalog) || !text(value.catalogHash, 128) || !text(value.capabilityHash, 128)
    || !nullableText(value.rollbackEvidenceIdentity) || !nullableText(value.testedAt) || !text(value.createdAt)) {
      throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    }
    return Object.freeze(value);
  });
}

function unwrap(raw, validator) {
  const envelope = exactResponse(raw, ["ok", "data"]);
  if (envelope.ok !== true) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  return validator(envelope.data);
}

function serialize(body) {
  let serialized;
  try { serialized = JSON.stringify(body); } catch { throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID"); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return serialized;
}

async function request(path, body, signal, validator) {
  if (signal?.aborted) throw invalid("REQUEST_ABORTED");
  const raw = await apiRequest(path, { method: "POST", serializedBody: serialize(body), maxSerializedBodyBytes: MAX_BYTES,
    headers: { "X-Client-Ai-Settings": "1" }, signal });
  return unwrap(raw, validator);
}

function connectionInput(raw) {
  const value = closed(raw, ["displayName", "baseUrl", "gatewayKey"], { optional: ["gatewayKeyInput"] });
  if (value.gatewayKeyInput !== undefined && (!plainRecord(value.gatewayKeyInput) || Object.keys(value.gatewayKeyInput).length !== 1
    || !Object.hasOwn(value.gatewayKeyInput, "value") || typeof value.gatewayKeyInput.value !== "string")) {
    throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  }
  return { displayName: text(value.displayName, 200), baseUrl: text(value.baseUrl), gatewayKey: text(value.gatewayKey, 16_384), gatewayKeyInput: value.gatewayKeyInput };
}

function randomId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID().replaceAll("-", "");
  return `intent${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function storageKey(input) {
  return `ozon-ai-settings:connection:${encodeURIComponent(input.displayName)}:${encodeURIComponent(input.baseUrl)}`;
}

export function createAiSettingsIntentStore(storage = globalThis.sessionStorage) {
  if (!storage || ["getItem", "setItem", "removeItem"].some((method) => typeof storage[method] !== "function")) {
    throw new TypeError("AI settings intent storage is required");
  }
  function read(input) {
    const key = storageKey(input);
    let saved = null;
    try { saved = JSON.parse(storage.getItem(key) || "null"); } catch { storage.removeItem(key); }
    if (!plainRecord(saved) || Reflect.ownKeys(saved).length !== 2 || typeof saved.idempotencyKey !== "string" || typeof saved.correlationId !== "string") {
      saved = { idempotencyKey: randomId(), correlationId: randomId() };
      storage.setItem(key, JSON.stringify(saved));
    }
    const intent = Object.freeze({ idempotencyKey: id(saved.idempotencyKey), correlationId: id(saved.correlationId) });
    intentOwners.set(intent, () => storage.removeItem(key));
    return intent;
  }
  return Object.freeze({ connectionIntent(raw) {
    const value = closed(raw, ["displayName", "baseUrl"]);
    return read({ displayName: text(value.displayName, 200), baseUrl: text(value.baseUrl) });
  } });
}

export async function loadAiSettings() {
  const raw = await apiRequest(BASE);
  return unwrap(raw, (data) => {
    const value = exactResponse(data, ["accountId", "activeConnection", "connections", "catalogs", "syncTasks", "profiles", "actions"]);
    if (!id(value.accountId) || (value.activeConnection !== null && !validateConnection(value.activeConnection))
      || !Array.isArray(value.connections) || !Array.isArray(value.catalogs) || !Array.isArray(value.syncTasks)
      || !Array.isArray(value.profiles)) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze({ ...value, connections: value.connections.map(validateConnection), catalogs: value.catalogs.map(validateCatalog),
      syncTasks: value.syncTasks.map(validateTask), profiles: value.profiles.map(validateProfile), actions: validateActions(value.actions) });
  });
}

export async function createGatewayConnection(raw, rawIntent) {
  const input = connectionInput(raw); const intent = exactIntent(rawIntent);
  const result = await request(`${BASE}/connections`, { idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId,
    displayName: input.displayName, baseUrl: input.baseUrl, gatewayKey: input.gatewayKey }, intent.signal, validateConnection);
  if (input.gatewayKeyInput) input.gatewayKeyInput.value = "";
  intentOwners.get(rawIntent)?.();
  return result;
}

export async function requestModelSync(raw, rawIntent) {
  const input = closed(raw, ["connectionId", "connectionVersion"]); const intent = exactIntent(rawIntent);
  return request(`${BASE}/connections/${encodeURIComponent(id(input.connectionId))}/sync`, { connectionVersion: version(input.connectionVersion),
    idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId }, intent.signal, validateTask);
}

export async function createModelProfile(raw, rawIntent) {
  const input = closed(raw, ["connectionId", "connectionVersion", "catalogId", "displayName", "textModel", "imageModel", "textProtocol", "imageProtocol"]); const intent = exactIntent(rawIntent);
  if (input.textProtocol !== "SUB2API_RESPONSES" || !["SUB2API_RESPONSES_IMAGE_TOOL", "SUB2API_OPENAI_IMAGES"].includes(input.imageProtocol)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return request(`${BASE}/profiles`, { connectionId: id(input.connectionId), connectionVersion: version(input.connectionVersion), catalogId: id(input.catalogId),
    displayName: text(input.displayName, 200), textModel: id(input.textModel), imageModel: id(input.imageModel), textProtocol: input.textProtocol,
    imageProtocol: input.imageProtocol, idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId }, intent.signal, validateProfile);
}

export async function testModelProfile(raw, rawIntent) {
  const input = closed(raw, ["profileId", "configVersion", "costConfirmed"]); const intent = exactIntent(rawIntent, { idempotency: false });
  if (input.costConfirmed !== true) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return request(`${BASE}/profiles/${encodeURIComponent(id(input.profileId))}/test`, { configVersion: version(input.configVersion), correlationId: intent.correlationId, costConfirmed: true }, intent.signal, validateCapability);
}

export async function publishModelProfile(raw, rawIntent) {
  const input = closed(raw, ["profileId", "configVersion"]); const intent = exactIntent(rawIntent);
  return request(`${BASE}/profiles/${encodeURIComponent(id(input.profileId))}/publish`, { configVersion: version(input.configVersion), idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId }, intent.signal, validateProfile);
}

export async function rollbackModelProfile(raw, rawIntent) {
  const input = closed(raw, ["profileId", "configVersion", "costConfirmed"]); const intent = exactIntent(rawIntent);
  if (input.costConfirmed !== true) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return request(`${BASE}/profiles/${encodeURIComponent(id(input.profileId))}/rollback`, { configVersion: version(input.configVersion), idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId, costConfirmed: true }, intent.signal, validateProfile);
}

export async function pollAiSettingsUntil(predicate, { signal, timeoutMs } = {}) {
  if (typeof predicate !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || (signal !== undefined && (!globalThis.AbortSignal || !(signal instanceof globalThis.AbortSignal)))) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw invalid("REQUEST_ABORTED");
    const current = await loadAiSettings();
    if (predicate(current) === true) return current;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw invalid("AI_SETTINGS_CLIENT_POLL_TIMEOUT");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(250, remaining));
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(invalid("REQUEST_ABORTED")); }, { once: true });
    });
  }
}

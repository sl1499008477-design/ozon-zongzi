import { apiRequest, localApiAssetUrl } from "./client-transport.js";
import {
  categoryStrategyChineseNameIndex,
  projectCategoryStrategyAnalysis,
  projectCategoryStrategyDetailBundle,
  projectCategoryStrategyList,
  projectCategoryStrategyPublishedVersion,
  projectCategoryStrategySession,
} from "./category-strategy-model.js";

const BASE = "/admin/auto-listing/category-strategies";
const CLIENT_ERROR = "CATEGORY_STRATEGY_CLIENT_REQUEST_INVALID";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const THUMBNAIL_MAX_BYTES = 16 * 1024 * 1024;
const INTENT_STORAGE_PREFIX = "zongzi:category-strategy-command-intents:v1";
const INTENT_TTL_MS = 24 * 60 * 60 * 1_000;

const REQUEST_KEYS = Object.freeze({
  settings: new Set(["expectedVersion", "mode", "idempotencyKey", "correlationId"]),
  create: new Set(["scope", "sourceCollectItemId", "expectedSourceVersion", "idempotencyKey", "correlationId"]),
  session: new Set(["expectedDraftVersion", "idempotencyKey", "correlationId"]),
  remove: new Set(["expectedDraftVersion", "idempotencyKey", "correlationId"]),
  archive: new Set(["expectedDraftVersion", "idempotencyKey", "correlationId"]),
  analysis: new Set(["costConfirmed", "idempotencyKey", "correlationId"]),
  edit: new Set(["expectedDraftVersion", "patch", "idempotencyKey", "correlationId"]),
  publish: new Set(["expectedDraftVersion", "expectedPublishedStrategyVersionId", "idempotencyKey", "correlationId"]),
  rollback: new Set(["targetStrategyVersionId", "expectedPublishedStrategyVersionId", "idempotencyKey", "correlationId"]),
});

function clientError() {
  return Object.assign(new Error(CLIENT_ERROR), { code: CLIENT_ERROR });
}

function closed(raw, keys) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw clientError();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw clientError();
    return Object.freeze(Object.fromEntries(own.map((key) => [key, descriptors[key].value])));
  } catch (error) {
    if (error?.code === CLIENT_ERROR) throw error;
    throw clientError();
  }
}

function identifier(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw clientError();
  return result;
}

function envelope(raw) {
  const value = closed(raw, new Set(["ok", "data"]));
  if (value.ok !== true) throw clientError();
  return value.data;
}

function errorField(error, key) {
  try {
    if (!error || typeof error !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function categoryStrategyErrorMessage(error) {
  const status = Number(errorField(error, "status")) || 0;
  const code = typeof errorField(error, "code") === "string" ? errorField(error, "code") : "";
  if (status === 403 || code === "PERMISSION_FORBIDDEN") return "没有类目策略管理权限，请联系账号管理员。";
  if (code === "AUTO_LISTING_CATEGORY_STRATEGY_SOURCE_NOT_FOUND") {
    return "当前商品暂时没有可用的类目依据，请返回自动上架页刷新后重试。";
  }
  if (code === "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY") {
    return "浏览器扩展尚未连接，请先安装或刷新扩展后重试。";
  }
  if (code === "AUTO_LISTING_CATEGORY_STRATEGY_BROWSER_OPEN_FAILED") {
    return "无法打开 Ozon 选样页，请刷新扩展后重试。";
  }
  if (status === 404) return "类目策略记录不存在或你无权查看。";
  if (status === 429) return "操作过于频繁，请稍后再试。";
  if (status === 409 && new Set([
    "AUTO_LISTING_SOURCE_VERSION_CONFLICT", "AUTO_LISTING_CATEGORY_STRATEGY_SOURCE_VERSION_CONFLICT",
  ]).has(code)) return "来源资料已变化，请返回自动上架页刷新后重试。";
  if (status === 409 && new Set([
    "AUTO_LISTING_CATEGORY_STRATEGY_VERSION_CONFLICT", "AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT",
    "AUTO_LISTING_CATEGORY_STRATEGY_CHANGED", "AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT",
    "AUTO_LISTING_CATEGORY_STRATEGY_PUBLISHED_VERSION_CONFLICT",
  ]).has(code)) return "类目策略已被其他管理员更新，请刷新后再操作。";
  if (code === "AUTO_LISTING_CATEGORY_STRATEGY_AI_RESPONSE_UNKNOWN") {
    return "AI 返回状态暂时无法确认，系统会保留本次分析并使用同一次请求恢复，请勿重新发起以免重复付费。";
  }
  if (code === "AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_NOT_READY"
    || (status === 503 && code.includes("ANALYSIS"))) {
    return "AI 分析服务暂时不可用，未产生新的付费调用。";
  }
  return "类目策略请求暂时无法完成，请稍后重试。";
}

export function categoryStrategyRequestBody(kind, raw) {
  const keys = REQUEST_KEYS[kind];
  if (!keys) throw clientError();
  return closed(raw, keys);
}

export function newCategoryStrategyCommandIdentity(prefix = "category-strategy") {
  const safePrefix = identifier(prefix);
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return Object.freeze({
    idempotencyKey: `${safePrefix}-${random}`,
    correlationId: `category-strategy-${random}`,
  });
}

function canonicalIntentValue(value, depth = 0) {
  if (depth > 16) throw clientError();
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw clientError();
    return value;
  }
  if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
    return value.map((entry) => canonicalIntentValue(entry, depth + 1));
  }
  const projected = closed(value, new Set(Object.keys(value)));
  return Object.fromEntries(Object.keys(projected).sort().map((key) => [key,
    canonicalIntentValue(projected[key], depth + 1)]));
}

async function intentHash(kind, fingerprint) {
  const payload = JSON.stringify([identifier(kind), canonicalIntentValue(fingerprint)]);
  if (new TextEncoder().encode(payload).byteLength > 128 * 1024 || !globalThis.crypto?.subtle) throw clientError();
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validStoredIdentity(raw) {
  try {
    const value = closed(raw, new Set(["idempotencyKey", "correlationId"]));
    return Object.freeze({ idempotencyKey: identifier(value.idempotencyKey), correlationId: identifier(value.correlationId) });
  } catch {
    return null;
  }
}

export function createCategoryStrategyIntentStore({ storage = globalThis.sessionStorage, accountId,
  now = () => Date.now() } = {}) {
  const safeAccountId = identifier(accountId);
  const storageKey = `${INTENT_STORAGE_PREFIX}:${safeAccountId}`;
  const memory = new Map();

  const readEntries = () => {
    try {
      const parsed = JSON.parse(storage?.getItem?.(storageKey) || "null");
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return [];
      const current = Number(now());
      return parsed.entries.slice(0, 32).flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Object.getPrototypeOf(entry) !== Object.prototype
          || !/^[a-f0-9]{64}$/u.test(entry.key) || !Number.isSafeInteger(entry.createdAt)
          || entry.createdAt > current || current - entry.createdAt > INTENT_TTL_MS) return [];
        const identity = validStoredIdentity(entry.identity);
        return identity ? [{ key: entry.key, createdAt: entry.createdAt, identity }] : [];
      });
    } catch {
      return [];
    }
  };
  const writeEntries = (entries) => {
    try { storage?.setItem?.(storageKey, JSON.stringify({ schemaVersion: 1, entries: entries.slice(-32) })); }
    catch { /* current page still retains the in-memory identity */ }
  };

  return Object.freeze({
    async identity(kind, fingerprint) {
      const key = await intentHash(kind, fingerprint);
      if (memory.has(key)) return memory.get(key);
      const entries = readEntries();
      const existing = entries.find((entry) => entry.key === key)?.identity;
      if (existing) { memory.set(key, existing); return existing; }
      const identity = newCategoryStrategyCommandIdentity(kind);
      memory.set(key, identity);
      writeEntries([...entries, { key, createdAt: Number(now()), identity }]);
      return identity;
    },
    async settle(kind, fingerprint) {
      const key = await intentHash(kind, fingerprint);
      memory.delete(key);
      writeEntries(readEntries().filter((entry) => entry.key !== key));
    },
  });
}

function safeThumbnailPath(raw) {
  try {
    if (typeof raw !== "string" || raw.length > 2_048) throw clientError();
    const url = new URL(raw, "http://category-strategy.local");
    if (url.origin !== "http://category-strategy.local" || url.search || url.hash) throw clientError();
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 10 || parts[0] !== "api" || parts[1] !== "admin" || parts[2] !== "auto-listing"
      || parts[3] !== "category-strategies" || parts[5] !== "samples" || parts[7] !== "images"
      || parts[9] !== "thumbnail") throw clientError();
    for (const index of [4, 6, 8]) identifier(decodeURIComponent(parts[index]));
    return url.pathname;
  } catch {
    throw Object.assign(new Error("CATEGORY_STRATEGY_THUMBNAIL_INVALID"), {
      code: "CATEGORY_STRATEGY_THUMBNAIL_INVALID",
    });
  }
}

async function thumbnailBytes(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > THUMBNAIL_MAX_BYTES) throw clientError();
  if (!response.body?.getReader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > THUMBNAIL_MAX_BYTES) throw clientError();
    return [buffer];
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > THUMBNAIL_MAX_BYTES) {
        await reader.cancel();
        throw clientError();
      }
      chunks.push(next.value);
    }
    return chunks;
  } finally {
    reader.releaseLock?.();
  }
}

export async function loadCategoryStrategyThumbnail(rawPath, { token = globalThis.localStorage?.getItem?.("token") || "",
  fetchImpl = globalThis.fetch, signal } = {}) {
  try {
    const path = safeThumbnailPath(rawPath);
    if (typeof fetchImpl !== "function" || typeof token !== "string" || !token || token.length > 8_192) throw clientError();
    const response = await fetchImpl(localApiAssetUrl(path), {
      headers: { Accept: "image/webp", Authorization: `Bearer ${token}` }, signal,
    });
    if (!response?.ok || String(response.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase() !== "image/webp") {
      throw clientError();
    }
    return new Blob(await thumbnailBytes(response), { type: "image/webp" });
  } catch {
    throw Object.assign(new Error("CATEGORY_STRATEGY_THUMBNAIL_INVALID"), {
      code: "CATEGORY_STRATEGY_THUMBNAIL_INVALID",
    });
  }
}

function createdDraft(raw) {
  const value = closed(raw, new Set(["draftId", "scope", "draftVersion", "status", "duplicate"]));
  const [projected] = projectCategoryStrategyList([{
    draftId: value.draftId, scope: value.scope, draftVersion: value.draftVersion,
    status: value.status, sampleCount: 0,
  }]);
  if (typeof value.duplicate !== "boolean") throw clientError();
  return Object.freeze({ draftId: projected.draftId, scope: projected.scope,
    draftVersion: projected.draftVersion, status: projected.status, duplicate: value.duplicate });
}

function archivedDraft(raw, expectedDraftId) {
  const value = closed(raw, new Set([
    "draftId", "removed", "draftVersion", "activeStrategyChanged",
    "strategyVersionId", "strategyVersion", "duplicate",
  ]));
  if (identifier(value.draftId) !== expectedDraftId || value.removed !== true
    || !Number.isSafeInteger(value.draftVersion) || value.draftVersion < 1
    || typeof value.activeStrategyChanged !== "boolean" || typeof value.duplicate !== "boolean"
    || !((value.strategyVersionId === null && value.strategyVersion === null && !value.activeStrategyChanged)
      || (identifier(value.strategyVersionId) && Number.isSafeInteger(value.strategyVersion)
        && value.strategyVersion > 0 && value.activeStrategyChanged))) throw clientError();
  return Object.freeze({ ...value });
}

export function createCategoryStrategyClient({ request = apiRequest } = {}) {
  if (typeof request !== "function") throw clientError();
  return Object.freeze({
    async list() {
      return projectCategoryStrategyList(envelope(await request(BASE)));
    },
    async loadChineseCategoryNames(storeId) {
      const response = await request("/ozon/categories/tree?language=ZH_HANS", {
        headers: { "x-ozon-store-id": identifier(storeId) },
      });
      return categoryStrategyChineseNameIndex(response?.items);
    },
    async getDraft(draftId) {
      return projectCategoryStrategyDetailBundle(envelope(await request(`${BASE}/${encodeURIComponent(identifier(draftId))}`)));
    },
    async createDraft(input) {
      return createdDraft(envelope(await request(`${BASE}/drafts`, {
        method: "POST", body: categoryStrategyRequestBody("create", input),
      })));
    },
    async startSession(draftId, input) {
      return projectCategoryStrategySession(envelope(await request(
        `${BASE}/${encodeURIComponent(identifier(draftId))}/sampling-sessions`,
        { method: "POST", body: categoryStrategyRequestBody("session", input) },
      )));
    },
    async removeSample(draftId, sampleId, input) {
      const safeDraftId = identifier(draftId);
      const safeSampleId = identifier(sampleId);
      const data = envelope(await request(`${BASE}/${encodeURIComponent(safeDraftId)}/samples/${encodeURIComponent(safeSampleId)}`, {
        method: "DELETE", body: categoryStrategyRequestBody("remove", input),
      }));
      const value = closed(data, new Set(["draftId", "sampleId", "expectedDraftVersion", "idempotencyKey",
        "replacementRequired", "samplingIdentity"]));
      if (identifier(value.draftId) !== safeDraftId || identifier(value.sampleId) !== safeSampleId
        || value.replacementRequired !== true || !Number.isSafeInteger(value.expectedDraftVersion)
        || value.expectedDraftVersion < 1) throw clientError();
      const samplingIdentity = closed(value.samplingIdentity, new Set(["idempotencyKey", "correlationId"]));
      return Object.freeze({ ...value, samplingIdentity: Object.freeze({
        idempotencyKey: identifier(samplingIdentity.idempotencyKey),
        correlationId: identifier(samplingIdentity.correlationId),
      }) });
    },
    async archiveDraft(draftId, input) {
      const safeDraftId = identifier(draftId);
      return archivedDraft(envelope(await request(`${BASE}/${encodeURIComponent(safeDraftId)}`, {
        method: "DELETE", body: categoryStrategyRequestBody("archive", input),
      })), safeDraftId);
    },
    async analyze(draftId, input) {
      return projectCategoryStrategyAnalysis(envelope(await request(
        `${BASE}/${encodeURIComponent(identifier(draftId))}/analysis-attempts`,
        { method: "POST", body: categoryStrategyRequestBody("analysis", input) },
      )));
    },
    async edit(draftId, input) {
      return projectCategoryStrategyAnalysis(envelope(await request(
        `${BASE}/${encodeURIComponent(identifier(draftId))}`,
        { method: "PATCH", body: categoryStrategyRequestBody("edit", input) },
      )));
    },
    async publish(draftId, input) {
      return projectCategoryStrategyPublishedVersion(envelope(await request(
        `${BASE}/${encodeURIComponent(identifier(draftId))}/publish`,
        { method: "POST", body: categoryStrategyRequestBody("publish", input) },
      )));
    },
    async rollback(draftId, input) {
      return projectCategoryStrategyPublishedVersion(envelope(await request(
        `${BASE}/${encodeURIComponent(identifier(draftId))}/rollback`,
        { method: "POST", body: categoryStrategyRequestBody("rollback", input) },
      )));
    },
  });
}
